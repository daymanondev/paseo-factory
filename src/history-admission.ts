import { pendingUpgradeFor } from "./upgrade-state.ts";
import { readLocalWriterIdentity } from "./writer-identity.ts";
import { liveWorkspaceConflict, acceptedTasks } from "./workspace-conflict.ts";
/** The live writer's operation/admission boundary. Downloads only stage bytes. */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { inspectArtifact } from "./artifact.ts";
import { FactoryError } from "./errors.ts";
import { historyHash } from "./history-identity.ts";
import { parseLedgerJsonl } from "./ledger-validation.ts";
import { planHistoryImport } from "./history-import.ts";
import type { HistoryImportSource, VerifiedImportBinding } from "./history-import.ts";
import { projectHistoryTarget, historyTargetPath, fsyncDirectory, makeDurableDirectory, importDirectory, importSources, loadImportManifest, observeStagedImports, readLedgerImports, saveImportManifest, stageLedgerImport, writeDurableFile } from "./history-stage.ts";
import type { ImportStatus } from "./history-stage.ts";
import { listProjectRegistrations, readProjectRegistration } from "./project.ts";
import { Ledger } from "./ledger.ts";

const owners = new Map<string, LedgerAdmission>();
const offlineMaintenance = new AsyncLocalStorage<{ state: string; live: boolean }>();
const context = new AsyncLocalStorage<{ owner: LedgerAdmission; live: boolean }>();

export class LedgerAdmission {
  /** Serialize check/open/register across processes. An interrupted acquisition
   * deliberately fails closed instead of stealing an unverifiable new owner. */
  static reserve(path: string): () => void {
    path = historyTargetPath(path);
    makeDurableDirectory(dirname(path));
    const guard = join(dirname(path), "ledger-owner-acquire");
    let fd: number;
    try { fd = openSync(guard, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FactoryError("ledger-owner-acquisition-busy", "Ledger writer acquisition is active or was interrupted; inspect ledger-owner-acquire before recovery");
      throw error;
    }
    try { fsyncSync(fd); } finally { closeSync(fd); }
    fsyncDirectory(dirname(path));
    return () => { rmSync(guard); fsyncDirectory(dirname(path)); };
  }
  static assertAvailable(path: string): void {
    path = historyTargetPath(path);
    const owner = owners.get(historyTargetPath(path));
    if (owner !== undefined && (owner.#active > 0 || owner.#timer !== undefined || owner.#maintenance > 0 || owner.#exclusive || owner.#waiters.size > 0)) throw new FactoryError("ledger-writer-active", "another Factory is using this Ledger");
    const marker = join(dirname(path), "ledger-owner.json");
    if (!existsSync(marker)) return;
    const prior = JSON.parse(readFileSync(marker, "utf8")) as { pid: number };
    if (!Number.isSafeInteger(prior.pid) || prior.pid < 1) throw new FactoryError("ledger-owner-unreadable", "Ledger owner registration is invalid");
    if (prior.pid === process.pid) return;
    try { process.kill(prior.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    throw new FactoryError("ledger-writer-active", `Ledger owner process ${prior.pid} is active`);
  }
  /** Canonical associated-file boundary for Vault and offline maintenance callers.
   * A separate CLI cannot borrow a running process's ownership. */
  static async withStateMaintenance<T>(stateDir: string, fn: () => T | Promise<T>): Promise<T> {
    const assertReady = () => {
      const id = pendingUpgradeFor(stateDir);
      if (id !== undefined) throw new FactoryError("upgrade-recovery-required", `Upgrade ${id} is incomplete; resume or restore before Vault materialization`);
    };
    assertReady();
    const path = join(stateDir, "ledger.jsonl");
    const owner = owners.get(historyTargetPath(path));
    if (owner !== undefined) return owner.withExclusiveMaintenance(() => { assertReady(); return fn(); });
    const release = LedgerAdmission.reserve(path);
    try {
      LedgerAdmission.assertAvailable(path); assertReady();
      const lease = { state: historyTargetPath(stateDir), live: true };
      try { return await offlineMaintenance.run(lease, fn); } finally { lease.live = false; }
    }
    catch (error) {
      if (error instanceof FactoryError && error.code === "ledger-writer-active") throw new FactoryError("vault-owner-required", "Vault materialization requires the running Factory owner; use the Vault RPC or stop the owner before an offline CLI operation. History snapshots can still be staged separately.");
      throw error;
    } finally { release(); }
  }
  static stateMutation<T>(stateDir: string, fn: () => T): T {
    const lease = offlineMaintenance.getStore();
    if (lease?.live && lease.state === historyTargetPath(stateDir)) return fn();
    const id = pendingUpgradeFor(stateDir);
    if (id !== undefined) throw new FactoryError("upgrade-recovery-required", `Upgrade ${id} is incomplete; resume or restore before changing Vault configuration`);
    const path = join(stateDir, "ledger.jsonl");
    const owner = owners.get(historyTargetPath(path));
    if (owner !== undefined) return owner.runSync(fn);
    const release = LedgerAdmission.reserve(path);
    try { LedgerAdmission.assertAvailable(path); return fn(); } finally { release(); }
  }
  readonly ledger: Ledger;
  readonly stateDir: string;
  #active = 0;
  #exclusive = false;
  #maintenance = 0;
  #draining = false;
  #stopped = false;
  #waiters = new Set<() => void>();
  #timer?: ReturnType<typeof setInterval>;
  #unobserve: () => void;
  #token = randomUUID();
  #error?: string;
  #targets = new Map<string, LedgerAdmission>();
  #fault?: (boundary: "prepared" | "renamed" | "activated" | "applied") => void;

  constructor(ledger: Ledger, stateDir: string, options: { deferDrain?: boolean; fault?: (boundary: "prepared" | "renamed" | "activated" | "applied") => void } = {}) {
    this.#fault = options.fault;
    this.ledger = ledger;
    this.stateDir = stateDir;
    this.#unobserve = observeStagedImports(ledger.path, () => this.drain());
    // Opening a replacement in a recovery fixture may supersede an idle owner;
    // an active owner can never be replaced or acquire a competing counter.
    const previous = owners.get(historyTargetPath(ledger.path));
    if (previous !== undefined && (previous.#active > 0 || previous.#maintenance > 0 || previous.#exclusive || previous.#waiters.size > 0)) throw new FactoryError("ledger-writer-active", "another Factory is using this Ledger");
    previous?.stop();
    owners.set(historyTargetPath(ledger.path), this);
    writeDurableFile(join(dirname(ledger.path), "ledger-owner.json"), JSON.stringify({ version: 1, pid: process.pid, token: this.#token, target: historyTargetPath(ledger.path), startedAt: new Date().toISOString() }));
    ledger.setAdmissionGuards(() => {
      this.#assertOwner();
      this.#assertNormalWork();
      if (this.#exclusive && !this.#nested()) throw new FactoryError("history-maintenance-busy", "Ledger maintenance is active");
    }, () => {
      this.#assertOwner();
      if (!this.#draining && !(this.#exclusive && this.#nested())) throw new FactoryError("history-admission-required", "history activation requires exclusive writer admission");
    });
    if (!options.deferDrain) this.drain();
  }

  get activeOperations(): number { return this.#active; }
  get maintenanceActive(): boolean { return this.#exclusive; }
  #nested(): boolean { const current = context.getStore(); return current?.owner === this && current.live; }
  #assertOwner(): void {
    if (this.#stopped || owners.get(historyTargetPath(this.ledger.path)) !== this) throw new FactoryError("ledger-writer-active", "this Factory was superseded by the current Ledger owner");
  }
  #assertNormalWork(): void {
    if (this.#exclusive && this.#nested()) return;
    const id = pendingUpgradeFor(this.stateDir);
    if (id !== undefined) throw new FactoryError("upgrade-recovery-required", `Upgrade ${id} is incomplete; resume or inspect maintenance before ordinary mutations`);
  }
  #pending(): boolean { return [this.ledger.path, ...this.#projectTargets()].some((path) => readLedgerImports(path).some((item) => (item.status === "pending" || item.status === "staged") && (item.materialization === undefined || item.materialization.status === "applied"))); }
  #wake(): void { for (const wake of this.#waiters) wake(); this.#waiters.clear(); }
  async #waitUntil(predicate: () => boolean): Promise<void> {
    while (!predicate()) await new Promise<void>((done) => this.#waiters.add(done));
  }

  async runOperation<T>(fn: () => T | Promise<T>, options: { newWork?: boolean } = {}): Promise<T> {
    this.#assertOwner();
    this.#assertNormalWork();
    if (this.#nested()) return await fn();
    this.drain();
    // New long-running work waits for pending imports. Permits and shim/Spool
    // continuations remain available to Gates already running in another process.
    await this.#waitUntil(() => {
      if (this.#exclusive || (options.newWork && (this.#maintenance > 0 || (this.#pending() && this.#error === undefined)))) return false;
      if (options.newWork && this.#error !== undefined && this.#pending()) throw new FactoryError("history-admission-failed", this.#error);
      this.#active += 1;
      return true;
    });
    const lease = { owner: this, live: true };
    try { return await context.run(lease, fn); }
    finally { lease.live = false; this.#active -= 1; this.drain(); this.#wake(); }
  }

  runSync<T>(fn: () => T): T {
    this.#assertOwner();
    this.#assertNormalWork();
    if (this.#exclusive && !this.#nested()) throw new FactoryError("history-maintenance-busy", "Ledger maintenance is active; retry after it completes");
    if (this.#nested()) return fn();
    this.#active += 1;
    const lease = { owner: this, live: true };
    try { return context.run(lease, fn); }
    finally { lease.live = false; this.#active -= 1; this.drain(); this.#wake(); }
  }

  async withExclusiveMaintenance<T>(fn: (ledger: Ledger) => T | Promise<T>, options: { projectSlug?: string } = {}): Promise<T> {
    this.#assertOwner();
    if (this.#nested()) throw new FactoryError("history-maintenance-reentrant", "maintenance must be requested outside an active operation");
    this.#maintenance += 1;
    const lease = { owner: this, live: true };
    try {
      await this.#waitUntil(() => {
        if (this.#active > 0 || this.#exclusive) return false;
        this.#exclusive = true;
        return true;
      });
      return await context.run(lease, () => {
        const target = options.projectSlug === undefined ? this : this.#projectOwner(options.projectSlug, true);
        return target === this ? fn(this.ledger) : target.withExclusiveMaintenance(fn);
      });
    } finally { lease.live = false; this.#exclusive = false; this.#maintenance -= 1; this.drain(); this.#wake(); }
  }

  stage(sources: readonly HistoryImportSource[]): ImportStatus {
    this.#assertOwner();
    const staged = stageLedgerImport(this.ledger.path, sources);
    return this.status().find((item) => item.id === staged.id)!;
  }
  stageForProject(projectSlug: string, sources: readonly HistoryImportSource[]): ImportStatus {
    this.#assertOwner();
    const target = this.#projectPath(projectSlug);
    const staged = stageLedgerImport(target, sources);
    this.drain();
    return readLedgerImports(target).find((item) => item.id === staged.id)!;
  }
  status(): ImportStatus[] { return readLedgerImports(this.ledger.path).map((item) => this.#error !== undefined && item.status === "pending" ? { ...item, diagnostics: [...item.diagnostics, this.#error] } : item); }
  allStatus(): ImportStatus[] {
    return [...this.status(), ...this.#projectTargets().flatMap((path) => owners.get(historyTargetPath(path))?.status() ?? readLedgerImports(path))];
  }
  get error(): string | undefined { return this.#error; }

  /** Synchronous activation cannot interleave with an ordinary JS mutation. */
  drain(): void {
    if (this.#stopped || owners.get(historyTargetPath(this.ledger.path)) !== this) return;
    const root = owners.get(historyTargetPath(join(this.stateDir, "ledger.jsonl")));
    if (root !== undefined && root !== this && (root.#active > 0 || root.#exclusive || root.#maintenance > 0)) return;
    if (pendingUpgradeFor(this.stateDir) !== undefined) return;
    if (this.#draining || this.#active > 0 || this.#exclusive || this.#maintenance > 0) return;
    this.#draining = true;
    try {
      for (const status of this.status()) {
        if (status.status !== "pending" && status.status !== "staged") continue;
        const manifest = loadImportManifest(this.ledger.path, status.id);
        if (manifest.materialization !== undefined && manifest.materialization.status !== "applied") continue;
        const current = this.#raw();
        if (manifest.afterHash !== undefined && historyHash(current) === manifest.afterHash) {
          // Activation survived a crash before the applied stamp. The opened
          // writer already has these bytes; install also handles an alive retry.
          this.ledger.refreshHistoryFromDisk();
          manifest.status = "applied";
          manifest.diagnostics = ["recovered committed import"];
          saveImportManifest(manifest);
          continue;
        }
        const sources = importSources(manifest);
        const plan = planHistoryImport({ existingLines: current, sources, bindings: this.#bindings(sources) });
        if (plan.status !== "conflicted") {
          // Audit paths stay intact; collision checks compare actual local trees,
          // so an alias cannot manufacture a disjoint execution Workspace.
          const projection = plan.events.map((event) => {
            if (event.event !== "contract_set") return event;
            try { return { ...event, workspace: realpathSync(event.workspace) }; } catch { return event; }
          });
          const latest = new Map(projection.filter((event) => event.event === "contract_set").map((event) => [event.task, event]));
          const accepted = acceptedTasks({ events: projection });
          for (const contract of latest.values()) {
            if (accepted.has(contract.task)) continue;
            const conflict = liveWorkspaceConflict({ events: projection }, contract.workspace, contract.task, contract.scope);
            if (conflict !== undefined) plan.conflicts.push({ reason: `workspace conflict: ${contract.task} overlaps ${conflict.task}` });
          }
          if (plan.conflicts.length > 0) plan.status = "conflicted";
        }
        manifest.conflicts = plan.conflicts;
        manifest.sequenceMaps = plan.sources.map((source) => ({ sourceId: source.id, namespace: source.namespace, sequenceMap: source.sequenceMap }));
        manifest.diagnostics = [...plan.diagnostics, ...plan.sources.flatMap((source) => source.diagnostics)];
        if (plan.status === "conflicted") { manifest.status = "conflicted"; saveImportManifest(manifest); continue; }
        manifest.beforeHash = plan.baseHash;
        manifest.afterHash = historyHash(plan.lines);
        manifest.added = plan.additions.length;
        manifest.duplicates = plan.duplicates.length;
        writeDurableFile(join(importDirectory(this.ledger.path, manifest.id), "prepared.jsonl"), plan.lines);
        saveImportManifest(manifest);
        this.#fault?.("prepared");
        this.ledger.activateHistory(plan.lines, { expectedHash: plan.baseHash, afterRename: () => this.#fault?.("renamed") });
        this.#fault?.("activated");
        manifest.status = "applied";
        manifest.diagnostics.push(plan.status === "duplicate" ? "proven duplicate; no new facts" : "history admitted by the live writer");
        saveImportManifest(manifest);
        this.#fault?.("applied");
      }
      this.#error = undefined;
      for (const path of this.#projectTargets()) {
        if (!readLedgerImports(path).some((item) => (item.status === "pending" || item.status === "staged") && (item.materialization === undefined || item.materialization.status === "applied"))) continue;
        const owner = this.#projectOwner(basename(dirname(path)));
        owner.drain();
        if (owner.error !== undefined) this.#error = owner.error;
      }
    } catch (error) { this.#error = error instanceof Error ? error.message : String(error); }
    finally { this.#draining = false; this.#wake(); }
  }

  #raw(): string {
    try { return readFileSync(this.ledger.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
  }
  #projectTargets(): string[] {
    if (resolve(dirname(this.ledger.path)) !== resolve(this.stateDir)) return [];
    const projects = join(this.stateDir, "projects");
    try {
      return readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory() && readProjectRegistration(this.stateDir, entry.name) !== undefined).map((entry) => join(projects, entry.name, "ledger.jsonl"));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  #projectPath(slug: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug) || readProjectRegistration(this.stateDir, slug) === undefined) throw new FactoryError("unknown-project", "history target must be a registered local Project");
    return projectHistoryTarget(this.stateDir, slug);
  }
  #projectOwner(slug: string, preserveTail = false): LedgerAdmission {
    const path = this.#projectPath(slug);
    if (historyTargetPath(path) === historyTargetPath(this.ledger.path)) return this;
    let owner = owners.get(historyTargetPath(path));
    if (owner === undefined) {
      const release = LedgerAdmission.reserve(path);
      try {
        LedgerAdmission.assertAvailable(path);
        owner = new LedgerAdmission(Ledger.open(path, { writerId: readLocalWriterIdentity(this.stateDir, slug) ?? this.ledger.writerId, recoverTail: !preserveTail }), this.stateDir, { deferDrain: true });
        this.#targets.set(path, owner);
      } finally { release(); }
    }
    return owner;
  }
  #git(workspace: string, args: string[]): string | undefined {
    try { return execFileSync("git", args, { cwd: workspace, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
    catch { return undefined; }
  }
  #bindings(sources: readonly HistoryImportSource[]): VerifiedImportBinding[] {
    const knownRoots = new Set<string>();
    const global = historyTargetPath(this.ledger.path) === historyTargetPath(join(this.stateDir, "ledger.jsonl"));
    const registrations = global ? listProjectRegistrations(this.stateDir) : [readProjectRegistration(this.stateDir, basename(dirname(this.ledger.path)))].filter((project) => project !== undefined);
    for (const project of registrations) {
      try { knownRoots.add(realpathSync(project.root)); } catch { /* unavailable Project */ }
    }
    // Unregistered legacy/global Tasks can still prove their own local root.
    // A Project target's existing payload cannot expand its registry binding.
    if (global) for (const event of this.ledger.events) if (event.event === "contract_set") {
      try { knownRoots.add(realpathSync(event.workspace)); } catch { /* unavailable roots establish no binding */ }
    }
    const bindings = new Map<string, VerifiedImportBinding>();
    for (const source of sources) {
      const parsed = parseLedgerJsonl(source.lines);
      if (parsed.corrupt !== undefined) continue;
      for (const contract of parsed.events) {
        if (contract.event !== "contract_set" || contract.epoch_id === undefined || typeof contract.workspace !== "string") continue;
        let root: string;
        try { root = realpathSync(contract.workspace); if (!statSync(root).isDirectory() || !knownRoots.has(root)) continue; }
        catch { continue; }
        if (this.#git(root, ["rev-parse", "--show-toplevel"]) !== root) continue;
        const binding: VerifiedImportBinding = { epochId: contract.epoch_id, workspace: contract.workspace };
        if (contract.base !== undefined && /^[a-f0-9]{40}$/i.test(contract.base) && this.#git(root, ["rev-parse", "--verify", `${contract.base}^{commit}`]) === contract.base) binding.base = contract.base;
        const events = parsed.events.filter((event) => event.epoch_id === contract.epoch_id);
        const commits = events.filter((event) => event.event === "gate_finished" || event.event === "claim_reported").map((event) => event.event === "gate_finished" || event.event === "claim_reported" ? event.sha : undefined).filter((sha): sha is string => typeof sha === "string" && /^[a-f0-9]{40}$/i.test(sha) && this.#git(root, ["rev-parse", "--verify", `${sha}^{commit}`]) === sha);
        binding.commits = [...new Set(commits)];
        // An incoming path cannot prove a worktree/evidence binding. Only a
        // matching dispatch already held by this writer can establish it.
        const dispatch = this.ledger.events.findLast((event) => event.event === "spawn_dispatched" && event.epoch_id === contract.epoch_id);
        if (dispatch?.event === "spawn_dispatched" && dispatch.worktree !== undefined && existsSync(dispatch.worktree)) binding.worktree = dispatch.worktree;
        const execution = binding.worktree ?? root;
        const gates = events.filter((event) => event.event === "gate_finished");
        binding.artifactPresent = gates.every((event) => event.event !== "gate_finished" || event.verdict !== "green" || (event.sha !== undefined && this.#git(execution, ["rev-parse", "HEAD"]) === event.sha && this.#git(execution, ["status", "--porcelain"]) === "" && inspectArtifact(execution, contract.artifact).present));
        binding.files = events.flatMap((event) => {
          const prior = this.ledger.events.find((local) => local.event_id === event.event_id);
          const path = prior?.event === "gate_finished" ? prior.outputPath : prior?.event === "report_written" ? prior.path : undefined;
          return path !== undefined && existsSync(path) ? [{ eventId: event.event_id!, path }] : [];
        });
        // Imported acceptance remains staged unless local history already
        // records this same attestation as landed; remote claims never suffice.
        binding.landedCommits = this.ledger.events.filter((event) => event.event === "attempt_accepted" && event.epoch_id === contract.epoch_id && event.landing === "landed").flatMap((accepted) => this.ledger.events.filter((event) => event.event === "gate_finished" && event.epoch_id === accepted.epoch_id && "attempt" in accepted && event.attempt === accepted.attempt).flatMap((event) => event.event === "gate_finished" && event.sha !== undefined ? [event.sha] : []));
        bindings.set(binding.epochId, binding);
      }
    }
    return [...bindings.values()];
  }

  start(): void {
    this.#assertOwner();
    if (this.#timer !== undefined) return;
    const marker = join(dirname(this.ledger.path), "ledger-owner.json");
    if (existsSync(marker)) {
      const prior = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; token: string };
      if (prior.pid !== process.pid) {
        try { process.kill(prior.pid, 0); throw new FactoryError("ledger-writer-active", `Ledger owner process ${prior.pid} is active`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    writeDurableFile(marker, JSON.stringify({ version: 1, pid: process.pid, token: this.#token, target: historyTargetPath(this.ledger.path), startedAt: new Date().toISOString() }));
    this.#timer = setInterval(() => this.drain(), 100);
    this.#timer.unref?.();
    this.drain();
  }
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unobserve();
    if (owners.get(historyTargetPath(this.ledger.path)) === this) owners.delete(historyTargetPath(this.ledger.path));
    for (const owner of this.#targets.values()) owner.stop();
    const marker = join(dirname(this.ledger.path), "ledger-owner.json");
    try { const prior = JSON.parse(readFileSync(marker, "utf8")); if (prior.token === this.#token) rmSync(marker); } catch { /* preserve unknown ownership */ }
  }
}
