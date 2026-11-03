/**
 * One-time legacy root → per-Project Ledger split & compact migration
 * (v0.0.89, ADR 0045 §2). The plugin server calls `migrateLegacyRootState`
 * once at startup, before serving Spool or RPC traffic: a legacy root
 * `<stateDir>/ledger.jsonl` (the pre-isolation single-Ledger layout — ADR
 * 0010 §5's unfinished server-side wiring) is partitioned into
 * `<stateDir>/projects/<slug>/ledger.jsonl` for every passed Project whose
 * per-Project Ledger does not yet exist or is empty, compacted per the lean
 * recording rules, and archived so a second boot is an immediate no-op.
 *
 * The migration is deliberately NOT the v2 upgrade act (history-upgrade.ts):
 * surviving events keep whatever identity metadata they already carry. A v2
 * root's `event_id`/`epoch_id` values are preserved verbatim and each
 * destination receives its own writer fence, so Private vault history
 * admission (ADR 0023) still recognizes the facts as already-known. A v1
 * root (the live 875 KB case) stays v1 — seat `permit_denied` lines with
 * synthetic `task: "supervisor"/"lead"` cannot carry a Contract epoch, and
 * identity assignment for legacy bytes remains the Owner's explicit upgrade.
 *
 * Nothing is dropped silently: every event that cannot be attributed, or
 * whose Project was not passed (or already owns a populated Ledger), remains
 * recoverable in the archived original root bytes under
 * `<stateDir>/archive/legacy-root-<timestamp>/`.
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { FactoryError } from "./errors.ts";
import { parseLedgerJsonl } from "./ledger-validation.ts";
import { readCorrelations } from "./correlations.ts";
import { projectStateDir, readProjectRegistration } from "./project.ts";
import { readProjectUsage } from "./usage-status.ts";
import { readLocalWriterIdentity } from "./writer-identity.ts";
import { historyHash } from "./history-identity.ts";
import { fsyncDirectory, makeDurableDirectory, writeDurableFile } from "./history-stage.ts";
import type { LedgerEvent, LedgerSchema } from "./events.ts";

/** One registered Project the caller wants legacy history partitioned into. */
export interface LegacyRootMigrationProject {
  slug: string;
  /** The Project's canonical git root (`project.json`'s `root`) — how Contract workspaces attribute. */
  gitRoot?: string;
}

export interface LegacyRootMigrationOptions {
  projects: readonly LegacyRootMigrationProject[];
}

export interface LegacyRootMigrationResult {
  migrated: boolean;
  /** Slugs that received a populated per-Project Ledger, slug order. */
  projects: string[];
  /** Where the original root Ledger and unattributed artifacts were archived. */
  archiveDir?: string;
}

/** Optional trailing extras — a fixed clock keeps archive dir names testable. */
export interface LegacyRootMigrationExtras {
  now?: () => Date;
}

const SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SEAT_TASKS = new Set(["supervisor", "lead"]);
const REPORT_FILE = /^report-(.+)-(\d+)\.md$/;
const GATE_FILE = /^gate-(.+)-(\d+)\.log$/;
const RETRO_FILE = /^retro-\d{4}-\d{2}-\d{2}\.md$/;

/** The stub that replaces a superseded contract draft's description (v0.0.89 spec, Implementation Decision 2). */
export function compactedContractStub(task: string): string {
  return `[Compacted superseded contract draft — see latest contract_set for task ${task}]`;
}

interface AgentBinding {
  slug: string;
  seat: "supervisor" | "lead" | "dispatcher" | "agent";
}

/**
 * The one-time migration. Idempotent by construction: the root Ledger moves
 * into the timestamped archive on the run that processes it, so a second
 * boot finds no root Ledger and returns `{ migrated: false }` without
 * touching anything.
 */
export function migrateLegacyRootState(
  stateDir: string,
  options: LegacyRootMigrationOptions,
  extras: LegacyRootMigrationExtras = {},
): LegacyRootMigrationResult {
  const projects: LegacyRootMigrationProject[] = [];
  const seen = new Set<string>();
  for (const project of options.projects) {
    if (typeof project.slug !== "string" || !SLUG_PATTERN.test(project.slug)) {
      throw new FactoryError("unknown-project", `legacy migration requires a canonical Project slug, got ${String(project.slug)}`);
    }
    if (seen.has(project.slug)) continue;
    seen.add(project.slug);
    projects.push({ slug: project.slug, ...(typeof project.gitRoot === "string" && project.gitRoot.trim() !== "" ? { gitRoot: project.gitRoot } : {}) });
  }
  if (projects.length === 0) return { migrated: false, projects: [] };

  const rootLedgerPath = join(stateDir, "ledger.jsonl");
  let raw: string;
  try {
    raw = readFileSync(rootLedgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { migrated: false, projects: [] };
    throw error;
  }
  const parsed = parseLedgerJsonl(raw);
  if (parsed.corrupt !== undefined) {
    // Never archive-and-replace bytes the Ledger cannot even read — the
    // explicit upgrade/recovery machinery owns damaged files.
    throw new FactoryError("corrupted-ledger", `legacy root ledger: ${parsed.corrupt}`);
  }
  const events = parsed.events;
  if (events.length === 0) return { migrated: false, projects: [] };

  const knownSlugs = new Set(projects.map((project) => project.slug));
  const gitRoots = new Map<string, string>();
  for (const project of projects) if (project.gitRoot !== undefined) gitRoots.set(project.slug, project.gitRoot);

  // Only Projects whose per-Project Ledger does not yet exist or is empty
  // receive migrated history; a populated Ledger is never rewritten.
  const targets = new Set(projects.filter((project) => projectLedgerIsEmpty(stateDir, project.slug)).map((project) => project.slug));

  const agentBindings = buildAgentBindings(stateDir, projects);
  const soleProject = projects.length === 1 ? projects[0]!.slug : undefined;

  // The Task → Project map is anchored on contract_set events — the Contract
  // fixes the Workspace, so every later fact naming that Task inherits it.
  const taskOwners = new Map<string, string>();
  for (const event of events) {
    if (event.event !== "contract_set") continue;
    const owner = attributeDirectly(event, knownSlugs, gitRoots);
    if (owner !== undefined) taskOwners.set(event.task, owner);
  }

  const attribute = (event: LedgerEvent): string | undefined => {
    const direct = attributeDirectly(event, knownSlugs, gitRoots);
    if (direct !== undefined) return direct;
    if ("task" in event && typeof event.task === "string" && taskOwners.has(event.task)) return taskOwners.get(event.task);
    if ("agent" in event && typeof event.agent === "string") {
      const binding = agentBindings.get(event.agent);
      if (binding !== undefined && knownSlugs.has(binding.slug)) return binding.slug;
    }
    // The single-registered-Project fallback (ADR 0045 §1.2 priority 5)
    // covers taskless factory-level facts — a root Retro line's owner, a
    // shim block no Contract bound — exactly when only one Project exists.
    if (soleProject !== undefined && !("task" in event && typeof event.task === "string")) return soleProject;
    return undefined;
  };

  // Partition + prune. Surviving events keep root order inside each Project.
  const partitioned = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    if (event.event === "ledger_schema") continue; // the root fence names the root namespace; it archives with the file
    if (isSeatPermitAllowed(event, agentBindings)) continue;
    const slug = attribute(event);
    if (slug === undefined || !targets.has(slug)) continue; // preserved in the archived root bytes
    const bucket = partitioned.get(slug);
    if (bucket === undefined) partitioned.set(slug, [event]);
    else bucket.push(event);
  }
  const written = [...partitioned.entries()].filter(([, survivors]) => survivors.length > 0).map(([slug]) => slug).sort();
  if (written.length === 0) {
    // Nothing attributable to any target — the root Ledger stays put rather
    // than being archived untouched (a root fallback Factory may still own it).
    return { migrated: false, projects: [] };
  }

  // Artifact relocation plan — root report-*/gate-*/retro-* files move to
  // their owning Project only when that Project also receives a Ledger.
  const retroFileOwners = new Map<string, string>();
  for (const event of events) {
    if (event.event !== "retro_written" || typeof event.proposalsPath !== "string" || event.proposalsPath === "") continue;
    const owner = attribute(event);
    if (owner !== undefined) retroFileOwners.set(basename(event.proposalsPath), owner);
  }
  const artifactMoves = new Map<string, string>(); // basename -> destination slug
  const archivedArtifacts: string[] = [];
  for (const name of listRootArtifacts(stateDir)) {
    const owner = artifactOwner(name, taskOwners, retroFileOwners, written, soleProject);
    if (owner !== undefined) artifactMoves.set(name, owner);
    else archivedArtifacts.push(name);
  }

  // Compact + renumber each Project Ledger. Identity fields ride along
  // verbatim; only the positional `seq` (and the compacted payload slots the
  // spec names) change.
  const rootWasVersioned = events.some((event) => event.schema_version === 2);
  const rootNamespace = events.find((event) => event.event === "ledger_schema")?.ledger_id ?? `legacy-${historyHash(raw).slice(0, 16)}`;
  for (const slug of written) {
    const candidates = partitioned.get(slug)!;
    // A `needs_human` whose evidence seqs did not ALL survive into this
    // Project's Ledger cannot carry validly remapped references — the reader
    // resolves every evidence seq (other than the Attempt ordinal) against
    // this Ledger alone, so a stale root-namespace seq would render the whole
    // destination corrupt. Per spec §2 (Identity Preservation), only validly
    // mapped seq integers are retained: the escalation stays in the archived
    // root bytes verbatim instead (never silently dropped — the archive keeps
    // the original line).
    const survivorSeqs = new Set(candidates.map((event) => event.seq));
    const survivors = candidates.filter(
      (event) =>
        event.event !== "needs_human" ||
        Object.entries(event.evidence).every(([field, seq]) => field === "attempt" || survivorSeqs.has(seq)),
    );
    const latestContract = new Map<string, LedgerEvent>();
    for (const event of survivors) if (event.event === "contract_set") latestContract.set(event.task, event);
    const seqMap = new Map<number, number>();
    const out: LedgerEvent[] = [];
    for (const event of survivors) {
      const next = out.length + 1;
      seqMap.set(event.seq, next);
      out.push(remapEvent(event, next, slug, stateDir, artifactMoves, latestContract));
    }
    for (const event of out) applySeqReferenceRemap(event, seqMap);
    let content = out.map((event) => `${JSON.stringify(event)}\n`).join("");
    if (rootWasVersioned) {
      // Each destination is its own Ledger: its fence names its own namespace
      // and writer while every surviving fact keeps its stable identity.
      const ledgerId = `${rootNamespace}:${slug}`;
      const writerId = readLocalWriterIdentity(stateDir, slug) ?? "legacy-root-migration";
      const fence: LedgerSchema = {
        seq: out.length + 1,
        ts: out.at(-1)!.ts,
        event: "ledger_schema",
        schema_version: 2,
        version: 2,
        ledger_id: ledgerId,
        writer_id: writerId,
        event_id: `schema:${historyHash(ledgerId)}`,
        provenance: { writer_id: writerId },
      };
      content += `${JSON.stringify(fence)}\n`;
    }
    const ledgerPath = join(projectStateDir(stateDir, slug), "ledger.jsonl");
    let mode: number | undefined;
    try {
      mode = statSync(ledgerPath).mode & 0o777;
    } catch {
      mode = undefined; // fresh file — writeDurableFile's private default
    }
    writeDurableFile(ledgerPath, content, mode === undefined ? {} : { mode });
  }

  // Move owned artifacts, then archive the processed root Ledger and every
  // unattributed artifact — rename preserves the original bytes verbatim.
  const archiveDir = archiveDirectory(stateDir, extras);
  for (const [name, slug] of artifactMoves) {
    const source = join(stateDir, name);
    if (existsSync(source)) moveDurable(source, join(projectStateDir(stateDir, slug), name));
  }
  moveDurable(rootLedgerPath, join(archiveDir, "ledger.jsonl"));
  const rootGitBlockedLog = join(stateDir, "git-blocked.log");
  if (existsSync(rootGitBlockedLog)) {
    moveDurable(rootGitBlockedLog, join(archiveDir, "git-blocked.log"));
  }
  for (const name of archivedArtifacts) {
    const source = join(stateDir, name);
    if (existsSync(source)) moveDurable(source, join(archiveDir, name));
  }

  return { migrated: true, projects: written, archiveDir };
}

// ---- attribution ---------------------------------------------------------------------------------

/** Attribution paths (a) and (b): an explicit `projectSlug` field, or a
 * Workspace / worktree / cwd path that resolves against the passed Projects. */
function attributeDirectly(
  event: LedgerEvent,
  knownSlugs: Set<string>,
  gitRoots: Map<string, string>,
): string | undefined {
  const explicit = (event as unknown as Record<string, unknown>).projectSlug;
  if (typeof explicit === "string" && knownSlugs.has(explicit)) return explicit;
  const path = firstPathField(event);
  if (path !== undefined) {
    const owner = pathOwner(path, knownSlugs, gitRoots);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

function firstPathField(event: LedgerEvent): string | undefined {
  const record = event as unknown as Record<string, unknown>;
  for (const field of ["workspace", "worktree", "cwd"]) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** Resolves one path against the passed Projects: a managed worktree segment
 * (`/projects/<slug>/worktrees/<task>`) first, then the canonical git roots
 * (the path at, inside, or naming the root). Ambiguous root matches refuse. */
function pathOwner(path: string, knownSlugs: Set<string>, gitRoots: Map<string, string>): string | undefined {
  const worktree = /\/projects\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/worktrees\//.exec(path);
  if (worktree !== null && knownSlugs.has(worktree[1]!)) return worktree[1]!;
  const target = resolve(path);
  let ancestorMatch: string | undefined;
  let ancestorMatches = 0;
  for (const [slug, root] of gitRoots) {
    if (!knownSlugs.has(slug)) continue;
    const base = resolve(root);
    if (target === base || target.startsWith(`${base}/`)) return slug; // at or inside the Project checkout
    if (base.startsWith(`${target}/`)) {
      // the Workspace is an ancestor (a monorepo parent the Project lives in)
      ancestorMatch = slug;
      ancestorMatches += 1;
    }
  }
  if (ancestorMatches === 1) return ancestorMatch;
  return undefined; // no match, or two Projects under one Workspace — refuse rather than guess
}

/** Agent → Project bindings from the usage rollups, the correlation
 * registry, and the Project registrations (spec attribution path (d)).
 * Later sources win: the registry is the durable authority. */
function buildAgentBindings(stateDir: string, projects: readonly LegacyRootMigrationProject[]): Map<string, AgentBinding> {
  const bindings = new Map<string, AgentBinding>();
  for (const project of projects) {
    const usage = readProjectUsage(stateDir, project.slug);
    if (usage === undefined) continue;
    for (const session of Object.values(usage.sessions)) {
      if (session === null || typeof session !== "object") continue;
      if (typeof session.agentId !== "string" || session.agentId === "" || session.projectSlug !== project.slug) continue;
      const seat: AgentBinding["seat"] | undefined =
        session.seat === "supervisor" || session.seat === "lead" ? session.seat : session.seat === "agent" ? "agent" : undefined;
      if (seat !== undefined) bindings.set(session.agentId, { slug: project.slug, seat });
    }
  }
  for (const record of readCorrelations(stateDir)) {
    if (typeof record.agentId !== "string" || record.agentId === "") continue;
    bindings.set(record.agentId, { slug: record.projectSlug, seat: record.role === "supervisor" || record.role === "lead" ? record.role : "agent" });
  }
  for (const project of projects) {
    const registration = readProjectRegistration(stateDir, project.slug);
    if (registration === undefined) continue;
    if (typeof registration.supervisor === "string" && registration.supervisor !== "") bindings.set(registration.supervisor, { slug: project.slug, seat: "supervisor" });
    if (typeof registration.lead === "string" && registration.lead !== "") bindings.set(registration.lead, { slug: project.slug, seat: "lead" });
    for (const dispatcher of registration.dispatchers ?? []) bindings.set(dispatcher, { slug: project.slug, seat: "dispatcher" });
  }
  return bindings;
}

// ---- compaction ----------------------------------------------------------------------------------

/** Seat `permit_allowed` noise: no task, a synthetic seat task, or an agent
 * bound to a Supervisor/Lead/dispatcher seat. Denials, shim blocks, and Peer
 * asks are never touched here. */
function isSeatPermitAllowed(event: LedgerEvent, agentBindings: Map<string, AgentBinding>): boolean {
  if (event.event !== "permit_allowed") return false;
  const task = "task" in event ? event.task : undefined;
  if (typeof task !== "string" || task === "" || SEAT_TASKS.has(task)) return true;
  if ("agent" in event && typeof event.agent === "string") {
    const binding = agentBindings.get(event.agent);
    if (binding !== undefined && binding.seat !== "agent") return true;
  }
  return false;
}

/** One surviving event at its new per-Project address: superseded Contract
 * drafts compact to the stub, Peer `permit_allowed` commands trim, and
 * evidence paths rewrite to the Project directory the artifact moved into. */
function remapEvent(
  event: LedgerEvent,
  newSeq: number,
  slug: string,
  stateDir: string,
  artifactMoves: Map<string, string>,
  latestContract: Map<string, LedgerEvent>,
): LedgerEvent {
  let out: LedgerEvent = { ...event, seq: newSeq };
  if (event.event === "contract_set" && latestContract.get(event.task) !== event) {
    out = { ...event, seq: newSeq, description: compactedContractStub(event.task) };
  }
  if (event.event === "permit_allowed") {
    const { command: _trimmed, ...lean } = out as LedgerEvent & { command?: string };
    out = lean as LedgerEvent;
  }
  const record = out as unknown as Record<string, unknown>;
  const pathField =
    event.event === "report_written" ? "path" : event.event === "gate_finished" ? "outputPath" : event.event === "retro_written" ? "proposalsPath" : undefined;
  if (pathField !== undefined && typeof record[pathField] === "string") {
    const name = basename(record[pathField] as string);
    if (artifactMoves.get(name) === slug) {
      out = { ...record, [pathField]: join(projectStateDir(stateDir, slug), name) } as unknown as LedgerEvent;
    }
  }
  return out;
}

/** Rewrites internal seq references to the Project's new 1..N addresses:
 * `needs_human.evidence` (Attempt ordinals are not seqs and stay; an event
 * whose evidence seqs did not all survive was dropped before renumbering —
 * only validly mapped integers ever remain), and the forward
 * `retro_written.proposals[].evidence` / `attempt_accepted.evidenceSeqs`
 * lists, which retain only validly mapped integers. */
function applySeqReferenceRemap(event: LedgerEvent, seqMap: Map<number, number>): void {
  const record = event as unknown as Record<string, unknown>;
  if (event.event === "needs_human") {
    const evidence = { ...(record.evidence as Record<string, number>) };
    for (const field of Object.keys(evidence)) {
      if (field === "attempt") continue;
      const mapped = seqMap.get(evidence[field]!);
      if (mapped !== undefined) evidence[field] = mapped;
    }
    record.evidence = evidence;
  }
  if (event.event === "retro_written" && Array.isArray(record.proposals)) {
    record.proposals = (record.proposals as unknown[]).map((proposal) => {
      if (typeof proposal !== "object" || proposal === null || !Array.isArray((proposal as Record<string, unknown>).evidence)) return proposal;
      const evidence = (proposal as Record<string, unknown>).evidence as unknown[];
      const mapped = evidence.map((seq) => (typeof seq === "number" ? seqMap.get(seq) : undefined)).filter((seq): seq is number => seq !== undefined);
      return { ...proposal, evidence: mapped };
    });
  }
  if (event.event === "attempt_accepted" && Array.isArray(record.evidenceSeqs)) {
    const seqs = record.evidenceSeqs as unknown[];
    record.evidenceSeqs = seqs.map((seq) => (typeof seq === "number" ? seqMap.get(seq) : undefined)).filter((seq): seq is number => seq !== undefined);
  }
}

// ---- artifacts & archive -------------------------------------------------------------------------

function listRootArtifacts(stateDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => REPORT_FILE.test(name) || GATE_FILE.test(name) || RETRO_FILE.test(name))
    .sort();
}

function artifactOwner(
  name: string,
  taskOwners: Map<string, string>,
  retroFileOwners: Map<string, string>,
  written: readonly string[],
  soleProject: string | undefined,
): string | undefined {
  const acceptable = (slug: string | undefined): string | undefined => (slug !== undefined && written.includes(slug) ? slug : undefined);
  const report = REPORT_FILE.exec(name);
  if (report !== null) return acceptable(taskOwners.get(report[1]!));
  const gate = GATE_FILE.exec(name);
  if (gate !== null) return acceptable(taskOwners.get(gate[1]!));
  if (RETRO_FILE.test(name)) {
    const owner = acceptable(retroFileOwners.get(name));
    if (owner !== undefined) return owner;
    return acceptable(soleProject); // a root Retro file with no owning event: the sole Project's, when there is exactly one
  }
  return undefined;
}

function projectLedgerIsEmpty(stateDir: string, slug: string): boolean {
  const path = join(projectStateDir(stateDir, slug), "ledger.jsonl");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (raw.trim() === "") return true;
  const parsed = parseLedgerJsonl(raw);
  if (parsed.corrupt !== undefined) return false; // damaged — never a migration target; recovery owns it
  return parsed.events.length === 0;
}

function archiveDirectory(stateDir: string, extras: LegacyRootMigrationExtras): string {
  const stamp = (extras.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "");
  let dir = join(stateDir, "archive", `legacy-root-${stamp}`);
  for (let n = 2; existsSync(dir); n += 1) dir = join(stateDir, "archive", `legacy-root-${stamp}-${n}`);
  makeDurableDirectory(dir);
  return dir;
}

function moveDurable(source: string, destination: string): void {
  makeDurableDirectory(dirname(destination));
  renameSync(source, destination);
  fsyncDirectory(dirname(destination));
}
