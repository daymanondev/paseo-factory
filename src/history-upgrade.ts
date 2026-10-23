/** Explicit upgrade preparation and maintenance. Reading never acquires a writer. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FactoryError } from "./errors.ts";
import { canonicalHistoryJson, historyHash, legacyIdentityMappingIsValid, planLegacyIdentity, remapLedgerReferences } from "./history-identity.ts";
import { needsHumanEvidenceIsValid } from "./events.ts";
import type { NeedsHuman } from "./events.ts";
import type { LegacyIdentityMapping } from "./history-identity.ts";
import { validateHistoryCausality } from "./history-import.ts";
import { isValidLedgerEvent, parseLedgerJsonl } from "./ledger-validation.ts";
import { historyTargetPath, writeDurableFile, makeDurableDirectory, fsyncDirectory, readLedgerImports } from "./history-stage.ts";
import { readProjectRegistration } from "./project.ts";
import { localWriterPath, readLocalWriterIdentity } from "./writer-identity.ts";
import type { Factory } from "./factory.ts";

export type UpgradeAction = "preflight" | "apply" | "resume" | "restore";
export interface UpgradeInput { action: UpgradeAction; transactionId?: string; projectSlug?: string; controlId?: string }
interface Entry { blob?: string; path: string; kind: "file" | "directory" | "symlink"; mode: number; hash: string; link?: string }
export interface UpgradePreflight {
  ok: boolean; target: string; sourceVersion: number | null; sourceVersions: (number | null)[]; targetVersion: 2; inventory: Entry[];
  conflicts: string[]; diagnostics: string[]; baseHash: string; mapping: LegacyIdentityMapping;
  ledgerVersions: { path: string; version: number | null; versions: (number | null)[]; diagnostic?: string }[];
  referenceInventory: { queuedRequests: number; cachedReplies: number; mailboxes: number; reports: number; retros: number };
}
export interface UpgradeResult { id: string; action: UpgradeAction; status: string; target: string; backupDir: string; diagnostics: string[] }
interface Control { id: string; requestHash?: string; replyHash?: string }
interface Journal {
  version: 1; sourceVersion: 1 | 2; targetVersion: 2; id: string; stateDir: string; target: string; projectSlug?: string; phase: string;
  writerId: string; beforeWriter: string | null; before: Entry[]; after: Entry[]; mapping: LegacyIdentityMapping;
  diagnostics: string[]; controls: Control[]; changes: { path: string; beforeHash?: string; afterHash: string; mode: number; done?: boolean }[];
}
export function upgradeDirectory(stateDir: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new FactoryError("upgrade-invalid", "Invalid upgrade transaction identity");
  const root = historyTargetPath(stateDir);
  const directory = join(dirname(root), `${basename(root)}-upgrades`, id);
  if (historyTargetPath(directory) !== directory) throw new FactoryError("upgrade-invalid", "Upgrade transaction directory must not traverse a symlink");
  return directory;
}
function targetFor(stateDir: string, projectSlug?: string): string {
  if (projectSlug !== undefined && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(projectSlug) || readProjectRegistration(stateDir, projectSlug) === undefined)) throw new FactoryError("upgrade-target-invalid", "Upgrade target must be a registered Project slug");
  const target = historyTargetPath(projectSlug === undefined ? join(stateDir, "ledger.jsonl") : join(stateDir, "projects", projectSlug, "ledger.jsonl"));
  if (!target.startsWith(`${historyTargetPath(stateDir)}/`)) throw new FactoryError("upgrade-target-invalid", "Ledger target escapes the managed state directory");
  return target;
}
function rawFile(path: string): Buffer { try { return readFileSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0); throw error; } }
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new FactoryError("upgrade-corrupt-encoding", "Ledger contains invalid UTF-8 bytes; retain original bytes for inspection"); }
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function filePath(root: string, entry: string, projectSlug?: string): string {
  if (entry === "@writer") return localWriterPath(root, projectSlug);
  if (entry === "." || (!entry.startsWith("/") && !entry.split("/").includes(".."))) return join(root, entry);
  throw new FactoryError("upgrade-invalid", "Unsafe path in upgrade journal");
}
function controlAllowed(path: string, bytes: Buffer, controls: Control[]): boolean {
  for (const control of controls) {
    if ((path === `spool/requests/${control.id}.json` || path === `spool/processed/${control.id}.json`) && digest(bytes) === control.requestHash) return true;
    if (path === `spool/replies/${control.id}.json` && digest(bytes) === control.replyHash) return true;
  }
  return false;
}
function inventory(stateDir: string, projectSlug?: string, controls: Control[] = []): Entry[] {
  const out: Entry[] = [];
  function visit(path: string, relative: string): void {
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) { const link = readlinkSync(path); out.push({ path: relative, kind: "symlink", mode, hash: historyHash(link), link }); return; }
    if (stat.isDirectory()) {
      out.push({ path: relative, kind: "directory", mode, hash: "directory" });
      if (["worktrees", "node_modules"].includes(basename(path))) return;
      for (const name of readdirSync(path).sort()) {
        if (name === "ledger-owner.json" || name === "ledger-owner-acquire") continue;
        visit(join(path, name), relative === "." ? name : `${relative}/${name}`);
      }
    } else if (stat.isFile()) { const bytes = readFileSync(path); if (!controlAllowed(relative, bytes, controls)) out.push({ path: relative, kind: "file", mode, hash: digest(bytes) }); }
    else throw new FactoryError("upgrade-file-unsupported", `Unsupported state file type: ${relative}`);
  }
  visit(stateDir, ".");
  const writer = localWriterPath(stateDir, projectSlug);
  if (existsSync(writer)) { const stat = lstatSync(writer); if (!stat.isFile() || stat.isSymbolicLink()) throw new FactoryError("upgrade-file-unsupported", "Local writer identity must be a regular file"); out.push({ path: "@writer", kind: "file", mode: stat.mode & 0o7777, hash: digest(readFileSync(writer)) }); }
  return out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function sourceVersions(raw: string): (number | null)[] {
  const versions = new Set<number | null>();
  for (const line of raw.split("\n").slice(0, -1)) {
    try {
      const value = JSON.parse(line);
      versions.add(value?.schema_version === undefined ? isValidLedgerEvent(value) ? 1 : null : typeof value.schema_version === "number" ? value.schema_version : null);
      if (value?.event === "ledger_schema" && value.version !== value.schema_version) versions.add(typeof value.version === "number" ? value.version : null);
    } catch { versions.add(null); }
  }
  return versions.size === 0 ? [1] : [...versions].sort((a, b) => a === null ? 1 : b === null ? -1 : a - b);
}
function schemaVersion(raw: string): number | null {
  const parsed = parseLedgerJsonl(raw);
  if (parsed.events !== undefined) return parsed.events.some((event) => event.event === "ledger_schema") ? 2 : 1;
  const versions = sourceVersions(raw);
  return versions.length === 1 ? versions[0]! : null;
}
export function preflightUpgrade(stateDir: string, options: { projectSlug?: string } = {}): UpgradePreflight {
  stateDir = historyTargetPath(stateDir);
  const target = targetFor(stateDir, options.projectSlug);
  const raw = decode(rawFile(target));
  const writerId = readLocalWriterIdentity(stateDir, options.projectSlug) ?? "preflight-local-writer";
  const plan = planLegacyIdentity(raw, { writerId });
  const conflicts = [...plan.conflicts];
  if (plan.ok) conflicts.push(...validateHistoryCausality(plan.events));
  if (readLedgerImports(target).some((item) => item.status === "pending" || item.status === "staged")) conflicts.push("Target has pending history admission; settle it before upgrading");
  const diagnostics = [...plan.diagnostics];
  if (schemaVersion(raw) === 1 && plan.events.length > 1) diagnostics.push("Historical original writer remains unknown; attribution is preserved without assigning authority");
  const evidencePaths = new Map<string, string | undefined>();
  for (const event of plan.events) {
    const paths = event.event === "report_written" ? [event.path] : event.event === "gate_finished" ? [event.outputPath] : event.event === "retro_written" ? [event.proposalsPath] : [];
    for (const path of paths) {
      if (path === undefined) continue;
      if (evidencePaths.has(path) && evidencePaths.get(path) !== event.epoch_id) conflicts.push(`Evidence path belongs to different Contract epochs and cannot establish the original bytes: ${path}`);
      evidencePaths.set(path, event.epoch_id);
      if (!path.startsWith(`${stateDir}/`) || !existsSync(path)) diagnostics.push(`Evidence bytes are unavailable or outside local state for seq ${event.seq}: ${path}`);
    }
  }
  const files = inventory(stateDir, options.projectSlug);
  const referenceInventory = { queuedRequests: 0, cachedReplies: 0, mailboxes: 0, reports: 0, retros: 0 };
  const tasks = new Set(plan.events.flatMap((event) => "task" in event && typeof event.task === "string" ? [event.task] : []));
  for (const entry of files) {
    if (entry.kind !== "file" || entry.path === "@writer") continue;
    if (entry.path.endsWith("mailbox.jsonl")) referenceInventory.mailboxes++;
    if (basename(entry.path).startsWith("report-")) referenceInventory.reports++;
    if (basename(entry.path).startsWith("retro-")) referenceInventory.retros++;
    if (!/^spool\/(requests|processed|replies)\/.*\.json$/.test(entry.path)) continue;
    let value: Record<string, unknown>;
    try { value = JSON.parse(decode(readFileSync(filePath(stateDir, entry.path, options.projectSlug)))); }
    catch { conflicts.push(`Unparseable queued/cached state: ${entry.path}`); continue; }
    if (entry.path.startsWith("spool/replies/")) referenceInventory.cachedReplies++;
    else referenceInventory.queuedRequests++;
    if (value.kind === "needs_human" && typeof value.task === "string" && tasks.has(value.task)) {
      if (!needsHumanEvidenceIsValid(value.evidence, value.reason)) { conflicts.push(`Invalid queued evidence: ${entry.path}`); continue; }
      const contract = plan.events.findLast((event) => event.event === "contract_set" && event.task === value.task);
      const synthetic = { seq: (plan.events.at(-1)?.seq ?? 0) + 1, ts: "", event: "needs_human", task: value.task, reason: value.reason, evidence: value.evidence, epoch_id: contract?.epoch_id } as NeedsHuman;
      const resolved = remapLedgerReferences(synthetic, plan.events, plan.events);
      if (!resolved.ok) conflicts.push(...resolved.reasons.map((reason) => `${entry.path}: ${reason}`));
    }
    if (typeof value.event === "object" && value.event !== null) {
      const cached = value.event as Record<string, unknown>;
      if (typeof cached.task === "string" && tasks.has(cached.task)) {
        const original = plan.events.find((event) => event.seq === cached.seq);
        if (original === undefined || Object.entries(cached).some(([key, item]) => canonicalHistoryJson((original as unknown as Record<string, unknown>)[key]) !== canonicalHistoryJson(item))) conflicts.push(`Cached reply evidence contradicts its original address: ${entry.path}`);
      }
    }
  }
  const ledgerVersions = files.filter((entry) => entry.kind === "file" && basename(entry.path) === "ledger.jsonl").map((entry) => {
    try { const parsed = parseLedgerJsonl(decode(readFileSync(filePath(stateDir, entry.path, options.projectSlug)))); return { path: entry.path, version: schemaVersion(decode(readFileSync(filePath(stateDir, entry.path, options.projectSlug)))), versions: sourceVersions(decode(readFileSync(filePath(stateDir, entry.path, options.projectSlug)))), ...(parsed.corrupt === undefined ? {} : { diagnostic: parsed.corrupt }) }; }
    catch (error) { return { path: entry.path, version: null, versions: [null], diagnostic: String(error) }; }
  });
  return { ok: conflicts.length === 0, target, sourceVersion: schemaVersion(raw), sourceVersions: sourceVersions(raw), targetVersion: 2, inventory: files, ledgerVersions, referenceInventory, conflicts, diagnostics, baseHash: historyHash(raw), mapping: plan.mapping };
}
function save(journal: Journal): void { const directory = upgradeDirectory(journal.stateDir, journal.id); makeDurableDirectory(directory); chmodSync(directory, 0o700); writeDurableFile(join(upgradeDirectory(journal.stateDir, journal.id), "manifest.json"), JSON.stringify(journal) + "\n"); }
function load(stateDir: string, id: string): Journal {
  const journal = JSON.parse(readFileSync(join(upgradeDirectory(stateDir, id), "manifest.json"), "utf8")) as Journal;
  if (journal.version !== 1 || journal.id !== id || journal.stateDir !== historyTargetPath(stateDir) || !Array.isArray(journal.before) || !Array.isArray(journal.after) || !Array.isArray(journal.changes) || !Array.isArray(journal.controls) || targetFor(stateDir, journal.projectSlug) !== journal.target) throw new FactoryError("upgrade-invalid", "Unsupported or damaged upgrade manifest");
  if (!Array.isArray(journal.diagnostics) || (journal.beforeWriter !== null && (typeof journal.beforeWriter !== "string" || journal.beforeWriter.trim() === "")) || !["backing-up", "backed-up", "prepared", "activating", "applied", "restoring", "restored"].includes(journal.phase) || !legacyIdentityMappingIsValid(journal.mapping) || ![1, 2].includes(journal.sourceVersion) || journal.targetVersion !== 2 || typeof journal.writerId !== "string" || journal.writerId.trim() === "") throw new FactoryError("upgrade-invalid", "Unsupported upgrade version/progress/mapping");
  for (const entry of [...journal.before, ...journal.after, ...journal.changes]) filePath(stateDir, entry.path, journal.projectSlug);
  return journal;
}
function changed(actual: Entry[], expected: Entry[]): string[] {
  const current = new Map(actual.map((entry) => [entry.path, entry]));
  const wanted = new Map(expected.map((entry) => [entry.path, entry]));
  return [...new Set([...current.keys(), ...wanted.keys()])].filter((path) => {
    const a = current.get(path), b = wanted.get(path);
    return a?.hash !== b?.hash || a?.mode !== b?.mode || a?.kind !== b?.kind;
  });
}
/** Recovery may need its control-only service directories on a previously offline state.
 * Existing directories/modes and every unrelated file remain part of the inventory. */
function controlDirectory(journal: Journal, path: string, current: Entry[], expected: Entry[]): boolean {
  return journal.controls.length > 0 && ["spool", "spool/requests", "spool/replies", "spool/processed"].includes(path) && !expected.some((entry) => entry.path === path) && current.some((entry) => entry.path === path && entry.kind === "directory");
}

function assertInventory(journal: Journal, mixed = false): void {
  const current = inventory(journal.stateDir, journal.projectSlug, journal.controls);
  const expected = mixed ? journal.before : journal.after;
  const differences = changed(current, expected).filter((path) => !controlDirectory(journal, path, current, expected));
  const unexpected = mixed ? differences.filter((path) => {
    if (!journal.changes.some((change) => change.path === path)) return true;
    const actual = current.find((entry) => entry.path === path), after = journal.after.find((entry) => entry.path === path);
    return actual?.hash !== after?.hash || actual?.mode !== after?.mode || actual?.kind !== after?.kind;
  }) : differences;
  if (unexpected.length > 0) throw new FactoryError("upgrade-intervening-writes", `State changed outside this upgrade: ${unexpected.join(", ")}`);
}
function blobPath(journal: Journal, entry: Entry): string {
  if (entry.blob !== historyHash(entry.path)) throw new FactoryError("upgrade-invalid", `Invalid backup reference for ${entry.path}`);
  return join(upgradeDirectory(journal.stateDir, journal.id), "backup", entry.blob);
}
function backupBytes(journal: Journal, entry: Entry): Buffer {
  const path = blobPath(journal, entry);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== entry.mode) throw new FactoryError("upgrade-backup-corrupt", `Backup type/mode mismatch: ${entry.path}`);
  const bytes = readFileSync(path);
  if (digest(bytes) !== entry.hash) throw new FactoryError("upgrade-backup-corrupt", `Backup hash mismatch: ${entry.path}`);
  return bytes;
}
function addControl(journal: Journal, id?: string): void {
  if (id === undefined) return;
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new FactoryError("upgrade-invalid", "Invalid maintenance request identity");
  const path = join(journal.stateDir, "spool", "requests", `${id}.json`);
  if (!existsSync(path)) return;
  const raw = readFileSync(path);
  const request = JSON.parse(raw.toString("utf8"));
  if (request.kind !== "upgrade" || request.id !== id) throw new FactoryError("upgrade-invalid", "Maintenance control does not match its request");
  const hash = digest(raw);
  const prior = journal.controls.find((control) => control.id === id);
  if (prior !== undefined && prior.requestHash !== hash) throw new FactoryError("upgrade-invalid", "Maintenance request changed under its identity");
  if (prior === undefined) journal.controls.push({ id, requestHash: hash });
}
export function upgradeReply(id: string, result: UpgradeResult | UpgradePreflight) {
  return { id, ok: true as const, summary: "id" in result ? `Upgrade ${result.id}: ${result.status}` : `Upgrade preflight: ${result.ok ? "ready" : "conflicted"}`, upgrade: result };
}
/** Record the exact Owner recovery control even when its requested transaction is refused. */
export function recordUpgradeControlReceipt(stateDir: string, transactionId: string, id: string): void {
  const journal = load(stateDir, transactionId);
  addControl(journal, id);
  save(journal);
}

export function recordUpgradeControlReply(stateDir: string, transactionId: string, id: string, reply: unknown): void {
  const journal = load(stateDir, transactionId);
  const control = journal.controls.find((item) => item.id === id);
  if (control === undefined) return;
  control.replyHash = digest(Buffer.from(JSON.stringify(reply) + "\n")); save(journal);
}
function resultFor(journal: Journal, action: UpgradeAction): UpgradeResult {
  return { id: journal.id, action, status: journal.phase, target: journal.target, backupDir: upgradeDirectory(journal.stateDir, journal.id), diagnostics: journal.diagnostics };
}

export async function upgradeFactory(factory: Factory, input: UpgradeInput, options: { fault?: (boundary: string) => void } = {}): Promise<UpgradeResult | UpgradePreflight> {
  if (input.action === "preflight") return preflightUpgrade(factory.stateDir, input);
  if (!["apply", "resume", "restore"].includes(input.action)) throw new FactoryError("upgrade-invalid", "Unknown upgrade action");
  if (input.action === "apply" && (input.transactionId === undefined || !existsSync(join(upgradeDirectory(factory.stateDir, input.transactionId), "manifest.json")))) {
    const checked = preflightUpgrade(factory.stateDir, input);
    if (!checked.ok) throw new FactoryError("upgrade-conflicted", checked.conflicts.join("; "));
  }
  return factory.history.withExclusiveMaintenance((ledger) => {
    const stateDir = historyTargetPath(factory.stateDir);
    const target = historyTargetPath(ledger.path);
    const id = input.transactionId ?? randomUUID();
    const directory = upgradeDirectory(stateDir, id);
    let journal: Journal;
    if (existsSync(join(directory, "manifest.json"))) {
      journal = load(stateDir, id);
      if (journal.target !== target || journal.projectSlug !== input.projectSlug) throw new FactoryError("upgrade-target-invalid", "Transaction belongs to another target");
      addControl(journal, input.controlId); save(journal);
    } else {
      if (input.action !== "apply") throw new FactoryError("upgrade-missing", "No durable transaction to resume/restore");
      const preflight = preflightUpgrade(stateDir, input);
      if (!preflight.ok) throw new FactoryError("upgrade-conflicted", preflight.conflicts.join("; "));
      const writerId = readLocalWriterIdentity(stateDir, input.projectSlug) ?? `writer:${randomUUID()}`;
      const raw = decode(rawFile(target));
      const plan = planLegacyIdentity(raw, { writerId });
      const relative = target.slice(stateDir.length + 1);
      const identity = Buffer.from(JSON.stringify({ version: 1, writerId }) + "\n");
      const prepared = Buffer.from(preflight.sourceVersion === 2 ? raw : plan.events.map((event) => JSON.stringify(event) + "\n").join(""));
      journal = { version: 1, sourceVersion: preflight.sourceVersion === 2 ? 2 : 1, targetVersion: 2, id, stateDir, target: target, ...(input.projectSlug === undefined ? {} : { projectSlug: input.projectSlug }), phase: "backing-up", diagnostics: preflight.diagnostics, writerId, beforeWriter: ledger.writerId ?? null, before: [], after: [], mapping: plan.mapping, controls: [], changes: [] };
      addControl(journal, input.controlId);
      journal.before = inventory(stateDir, input.projectSlug, journal.controls).map((entry) => ({ ...entry, ...(entry.kind === "file" ? { blob: historyHash(entry.path) } : {}) }));
      const ledgerBefore = journal.before.find((entry) => entry.path === relative);
      const writerBefore = journal.before.find((entry) => entry.path === "@writer");
      journal.changes = [
        { path: "@writer", beforeHash: writerBefore?.hash, afterHash: digest(identity), mode: writerBefore?.mode ?? 0o600 },
        { path: relative, beforeHash: ledgerBefore?.hash, afterHash: digest(prepared), mode: ledgerBefore?.mode ?? 0o600 },
      ];
      journal.after = journal.before.filter((entry) => !journal.changes.some((change) => change.path === entry.path));
      for (const change of journal.changes) journal.after.push({ path: change.path, kind: "file", hash: change.afterHash, mode: change.mode });
      save(journal);
      options.fault?.("journaled");
    }
    try {
    if (input.action === "restore") {
      if (journal.phase === "restored") return resultFor(journal, input.action);
      if (journal.phase !== "applied" && journal.phase !== "restoring") throw new FactoryError("upgrade-not-applied", "Finish the recorded upgrade before restore");
      assertInventory(journal, journal.phase === "restoring");
      for (const entry of journal.before) if (entry.kind === "file") backupBytes(journal, entry);
      journal.phase = "restoring"; save(journal);
      for (const change of [...journal.changes].reverse()) {
        const before = journal.before.find((entry) => entry.path === change.path);
        const path = filePath(stateDir, change.path, journal.projectSlug);
        if (before === undefined) { rmSync(path, { force: true }); options.fault?.(`restore-removed:${change.path}`); if (existsSync(dirname(path))) fsyncDirectory(dirname(path)); }
        else writeDurableFile(path, backupBytes(journal, before), { mode: before.mode, afterRename: () => options.fault?.(`restore-renamed:${change.path}`) });
        options.fault?.(`restored:${change.path}`);
      }
      ledger.refreshHistoryFromDisk({ writerId: journal.beforeWriter });
      const restored = inventory(stateDir, journal.projectSlug, journal.controls);
      const differences = changed(restored, journal.before).filter((path) => !controlDirectory(journal, path, restored, journal.before));
      if (differences.length > 0) throw new FactoryError("upgrade-restore-mismatch", differences.join(", "));
      journal.phase = "restored"; save(journal); options.fault?.("restored");
    } else if (journal.phase !== "applied" && journal.phase !== "restored") {
      assertInventory(journal, true);
      for (const entry of journal.before) {
        if (entry.kind !== "file") continue;
        const backup = blobPath(journal, entry);
        if (existsSync(backup)) backupBytes(journal, entry);
        else { const bytes = readFileSync(filePath(stateDir, entry.path, journal.projectSlug)); if (digest(bytes) !== entry.hash) throw new FactoryError("upgrade-base-changed", entry.path); writeDurableFile(backup, bytes, { mode: entry.mode }); }
        options.fault?.(`backup:${entry.path}`);
      }
      journal.phase = "backed-up"; save(journal); options.fault?.("backed-up");
      const targetEntry = journal.before.find((entry) => filePath(stateDir, entry.path, journal.projectSlug) === target);
      const original = targetEntry === undefined ? "" : decode(backupBytes(journal, targetEntry));
      const plan = planLegacyIdentity(original, { writerId: journal.writerId, previous: journal.mapping });
      if (!plan.ok) throw new FactoryError("upgrade-conflicted", plan.conflicts.join("; "));
      const lines = parseLedgerJsonl(original).events?.some((event) => event.event === "ledger_schema") ? original : plan.events.map((event) => JSON.stringify(event) + "\n").join("");
      const parsed = parseLedgerJsonl(lines);
      if (parsed.corrupt !== undefined) throw new FactoryError("upgrade-conflicted", parsed.corrupt);
      const causal = validateHistoryCausality(parsed.events);
      if (causal.length > 0) throw new FactoryError("upgrade-conflicted", causal.join("; "));
      const prepared = new Map<string, Buffer>([["@writer", Buffer.from(JSON.stringify({ version: 1, writerId: journal.writerId }) + "\n")], [target.slice(stateDir.length + 1), Buffer.from(lines)]]);
      for (const change of journal.changes) {
        const bytes = prepared.get(change.path)!;
        if (digest(bytes) !== change.afterHash) throw new FactoryError("upgrade-preparation-changed", change.path);
        writeDurableFile(join(directory, "prepared", historyHash(change.path)), bytes, { mode: change.mode });
        options.fault?.(`prepared:${change.path}`);
      }
      journal.phase = "prepared"; save(journal); options.fault?.("prepared");
      assertInventory(journal, true);
      journal.phase = "activating"; save(journal);
      for (const change of journal.changes) {
        const path = filePath(stateDir, change.path, journal.projectSlug);
        const current = existsSync(path) ? digest(readFileSync(path)) : undefined;
        if (current !== change.beforeHash && current !== change.afterHash) throw new FactoryError("upgrade-base-changed", change.path);
        const bytes = readFileSync(join(directory, "prepared", historyHash(change.path)));
        if (digest(bytes) !== change.afterHash) throw new FactoryError("upgrade-prepared-corrupt", change.path);
        if (current !== change.afterHash) {
          if (path === target) ledger.activateHistory(decode(bytes), { expectedHash: historyHash(decode(rawFile(path))), writerId: journal.writerId, mode: change.mode, afterRename: () => options.fault?.(`renamed:${change.path}`) });
          else writeDurableFile(path, bytes, { mode: change.mode, afterRename: () => options.fault?.(`renamed:${change.path}`) });
        }
        change.done = true; save(journal); options.fault?.(`activated:${change.path}`);
      }
      ledger.refreshHistoryFromDisk({ writerId: journal.writerId }); options.fault?.("refreshed");
      assertInventory(journal);
      journal.phase = "applied"; save(journal); options.fault?.("applied");
    }
    const result = resultFor(journal, input.action);
    const control = journal.controls.find((item) => item.id === input.controlId);
    if (control !== undefined) { control.replyHash = digest(Buffer.from(JSON.stringify(upgradeReply(control.id, result)) + "\n")); save(journal); }
    return result;
    } catch (error) {
      // Disk may have crossed a rename boundary before an interruption. Keep
      // read-side cache honest; the durable incomplete journal blocks writes.
      try { ledger.refreshHistoryFromDisk({ writerId: readLocalWriterIdentity(stateDir, journal.projectSlug) ?? journal.beforeWriter }); } catch { /* the recovery guard keeps damaged/mixed state closed */ }
      throw error;
    }
  }, { projectSlug: input.projectSlug });
}
