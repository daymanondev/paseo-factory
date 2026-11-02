/**
 * The per-Project usage rollup runtime (v0.0.87, ADR 0043 §1/§3) — the
 * single writer around each Project's isolated
 * `<stateDir>/projects/<slug>/usage.json`, the Tier-2 half of the Meter's
 * two-tier persistence:
 *
 *   - **Tier 1** stays `ledger.jsonl`: at most one task-scoped
 *     `meter_written` line per Task Attempt / Peer terminal boundary, mapped
 *     strictly onto the existing 4-field `MeterUsage` shape so the Ledger
 *     schema, Reports, and the 100-line Timeline stream stay untouched.
 *   - **Tier 2** is this file: an idempotent `agentId`-keyed map recording
 *     EVERY Project seat (`supervisor`, `lead`, `agent` / Scrum role, plus
 *     headless `watch` / `retro` runs) with the full normalized buckets,
 *     model metadata, timestamps, and `nativeSessionRef` traceability.
 *
 * Cadence (ADR 0043 §3): `agent.turn_ended` extracts incrementally and
 * schedules a debounced (2s) atomic flush; terminal boundaries — a Gate
 * verdict, a Peer retirement, a Lead rotation, a Supervisor revoke — flush
 * the outgoing session immediately and, at Task boundaries, land the Tier-1
 * `meter_written` line when new tokens were recorded. Historical Projects
 * get their full history once through the lazy backfill
 * (`loadOrBackfillProjectUsage`), which scans `<paseoHome>/agents/` and the
 * providers' native stores and never re-scans after `backfilledAt` lands.
 *
 * The rollup is plugin-server-side on purpose: it holds debounce timers, a
 * daemon census door, and the one Factory instance — none of which belong
 * in the vendored pure core.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "./core/factory.ts";
import type { MeterUsage } from "./core/events.ts";
import { readProjectRegistration } from "./core/project.ts";
import { projectTask } from "./core/task-state.ts";
import { atomicJson } from "./core/scrum/config.ts";
import { createUsageExtractor, type NormalizedUsage, type UsageAgentSource } from "./core/usage-extractor.ts";
import { readProjectUsage, usageFilePath, type ProjectUsageFile, type SessionUsageRecord } from "./core/usage-status.ts";

export type { ProjectUsageFile, SessionUsageRecord } from "./core/usage-status.ts";

/** The agent census slice the runtime reads — structural over the daemon's snapshots and persisted records. */
export interface UsageAgentSnapshotLike extends UsageAgentSource {
  labels?: Record<string, string>;
}

/** The daemon door the runtime needs — the census alone. */
export interface UsageDaemonApi {
  agents: {
    list(options?: { filter?: { includeArchived?: boolean; includeBackground?: boolean } }): Promise<{ entries: { agent: UsageAgentSnapshotLike }[] }>;
  };
}

const SCRUM_ROLES: readonly string[] = ["pm", "ux", "architect", "dev", "qa"];

/** The debounce window between `agent.turn_ended` and the atomic flush (ADR 0043 §3). */
export const USAGE_FLUSH_DEBOUNCE_MS = 2_000;

/** Atomic write — the `atomicJson` law the peer-handoff state already rides. */
function writeProjectUsage(stateDir: string, slug: string, file: ProjectUsageFile): void {
  atomicJson(usageFilePath(stateDir, slug), file);
}

/**
 * The Tier-1 projection (spec §1): a `SessionUsageRecord` maps strictly onto
 * the 4-field `MeterUsage` contract — `inputTokens` carries the UNCACHED
 * input, `cachedInputTokens` folds cache reads + writes — so the Ledger
 * schema validation stays byte-identical.
 */
export function meterUsageOf(record: Pick<SessionUsageRecord, "inputUncachedTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens" | "totalCostUsd">): MeterUsage {
  return {
    inputTokens: record.inputUncachedTokens,
    cachedInputTokens: record.cacheReadTokens + record.cacheWriteTokens,
    outputTokens: record.outputTokens,
    ...(record.totalCostUsd !== undefined ? { totalCostUsd: record.totalCostUsd } : {}),
  };
}

/** The lane string a plugin-written meter line carries — `<harness>/<model>`. */
export function meterProviderOf(usage: Pick<NormalizedUsage, "harness" | "model">): string {
  return `${usage.harness}/${usage.model}`;
}

/** The seat a session ran under — the label first, `agent` the working default. */
function seatOf(labels: Record<string, string> | undefined): SessionUsageRecord["seat"] {
  if (labels?.seat === "supervisor" || labels?.seat === "lead" || labels?.seat === "agent") return labels.seat;
  return "agent";
}

// The schema reserves `watch`/`retro` seats, but the headless CLI passes run
// `--no-session` and leave no native store behind — "record its usage entry
// when available" (spec §3) resolves to the honest absence for them, and
// the rollup only ever records what a store actually answered with.

function scrumRoleOf(labels: Record<string, string> | undefined): SessionUsageRecord["scrumRole"] | undefined {
  const role = labels?.specialization;
  return role !== undefined && SCRUM_ROLES.includes(role) ? (role as SessionUsageRecord["scrumRole"]) : undefined;
}

/** Merges one extracted snapshot into a Project's rollup — idempotent per `agentId`, `startedAt` preserved. */
function upsertSession(stateDir: string, slug: string, record: SessionUsageRecord): ProjectUsageFile {
  const prior = readProjectUsage(stateDir, slug);
  const existing = prior?.sessions[record.agentId];
  const file: ProjectUsageFile = {
    version: 1,
    projectSlug: slug,
    ...(prior?.backfilledAt !== undefined ? { backfilledAt: prior.backfilledAt } : {}),
    updatedAt: record.updatedAt,
    sessions: { ...(prior?.sessions ?? {}), [record.agentId]: { ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : { startedAt: record.updatedAt }), ...record } },
  };
  writeProjectUsage(stateDir, slug, file);
  return file;
}

export interface UsageRuntimeDeps {
  factory: Factory;
  stateDir: string;
  /** The Paseo home whose `agents/` tree the lazy backfill scans. */
  paseoHome?: string;
  /** The operator home the extractor's provider stores live under — default the real one. */
  userHome?: string;
  daemon: () => UsageDaemonApi | undefined | null;
  onLog?: (message: string) => void;
}

export interface UsageRuntime {
  /** `agent.turn_ended`: extract the ending seat and schedule the debounced flush. */
  recordTurnEnd: (agentId: string) => Promise<void>;
  /** A terminal seat boundary: extract and flush one session's final usage NOW. */
  flushAgent: (agent: UsageAgentSnapshotLike, meta?: { slug?: string; task?: string; attempt?: number }) => Promise<SessionUsageRecord | undefined>;
  /** A Task/Attempt terminal boundary: flush the Peer and land the Tier-1 `meter_written` line when tokens grew. */
  meterTaskBoundary: (input: { task: string; agentId?: string; attempt?: number }) => Promise<void>;
  /**
   * The same boundary act for a caller that already holds the retiring
   * agent's snapshot (Peer handoff, re-contracting retirement): flush AND
   * land the conditional `meter_written` line (spec §3 — the Tier-1 half
   * rides every Peer terminal boundary, not only Gate verdicts).
   */
  meterAgentBoundary: (input: { task: string; agent: UsageAgentSnapshotLike; slug?: string; attempt?: number }) => Promise<void>;
  /** The snapshot gather's read: the rollup, lazily backfilled once from `<paseoHome>/agents/`. */
  loadOrBackfillProjectUsage: (slug: string) => Promise<ProjectUsageFile | undefined>;
  /** `factory reset --keep-seats`: keep only the surviving standing-seat sessions. */
  pruneForReset: (slug: string, keepAgentIds: readonly string[]) => void;
  /** Drop any in-memory debounce state for a Project (reset/delete hygiene). */
  forget: (slug: string) => void;
  /** Flush everything pending and stop the timers (shutdown). */
  stop: () => void;
}

/** One session's record off a normalized extraction — the labels seat it, the ledger numbers the attempt. */
function buildRecordFor(
  stateDir: string,
  factory: Factory,
  agent: UsageAgentSnapshotLike,
  usage: NormalizedUsage,
  meta?: { slug?: string; task?: string; attempt?: number },
): SessionUsageRecord | undefined {
  const slug = meta?.slug ?? agent.labels?.project ?? projectsWithSeat(stateDir, agent.id)[0];
  if (slug === undefined) return undefined; // not a factory seat — none of the Meter's business
  const task = meta?.task ?? agent.labels?.task;
  const attempt = meta?.attempt ?? (task !== undefined ? projectTask(factory.ledger.events, task).currentAttempt?.attempt : undefined);
  const scrumRole = scrumRoleOf(agent.labels);
  return {
    agentId: agent.id,
    projectSlug: slug,
    seat: seatOf(agent.labels),
    ...(scrumRole !== undefined ? { scrumRole } : {}),
    ...(task !== undefined ? { task } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    harness: usage.harness,
    provider: usage.provider,
    model: usage.model,
    turns: usage.turns,
    inputUncachedTokens: usage.inputUncachedTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    ...(usage.totalCostUsd !== undefined ? { totalCostUsd: usage.totalCostUsd } : {}),
    ...(usage.latestContextWindowTokens !== undefined ? { latestContextWindowTokens: usage.latestContextWindowTokens } : {}),
    ...(usage.nativeSessionRef !== undefined ? { nativeSessionRef: usage.nativeSessionRef } : {}),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Creates the usage rollup runtime — one per plugin process. Every method is
 * best-effort by contract: a metering failure logs and holds (the verdict,
 * the rotation, and the reply are never hostage to accounting), the same
 * law the peer-mail hook carries.
 */
export function createUsageRuntime(deps: UsageRuntimeDeps): UsageRuntime {
  const log = deps.onLog ?? (() => {});
  const extractor = createUsageExtractor({ ...(deps.userHome === undefined ? {} : { userHome: deps.userHome }), stateDir: deps.stateDir });
  const pending = new Map<string, SessionUsageRecord>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const projectSlugOf = (agent: UsageAgentSnapshotLike): string | undefined => {
    const labelled = agent.labels?.project;
    if (labelled !== undefined && labelled !== "") return labelled;
    return projectsWithSeat(deps.stateDir, agent.id)[0];
  };

  const buildRecord = (agent: UsageAgentSnapshotLike, usage: NormalizedUsage, meta?: { slug?: string; task?: string; attempt?: number }): SessionUsageRecord | undefined =>
    buildRecordFor(deps.stateDir, deps.factory, agent, usage, meta);

  const flushPendingFor = (slug: string): void => {
    const timer = timers.get(slug);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(slug);
    }
    const records = [...pending.values()].filter(record => record.projectSlug === slug);
    if (records.length === 0) return;
    for (const record of records) {
      pending.delete(record.agentId);
      try {
        upsertSession(deps.stateDir, slug, record);
      } catch (error) {
        log(`usage: flush of ${record.agentId} deferred — ${String(error)}`);
      }
    }
  };

  const scheduleFlush = (slug: string): void => {
    if (timers.has(slug)) return;
    const timer = setTimeout(() => {
      timers.delete(slug);
      flushPendingFor(slug);
    }, USAGE_FLUSH_DEBOUNCE_MS);
    timer.unref?.();
    timers.set(slug, timer);
  };

  const censusAgent = async (agentId: string): Promise<UsageAgentSnapshotLike | undefined> => {
    const daemon = deps.daemon();
    if (daemon === undefined || daemon === null) return undefined;
    try {
      const page = await daemon.agents.list({ filter: { includeArchived: true, includeBackground: true } });
      return page.entries.find(entry => entry.agent.id === agentId)?.agent;
    } catch {
      return undefined;
    }
  };

  /**
   * The one Tier-1/Tier-2 boundary body: extract, flush the session into the
   * rollup, and land ONE `meter_written` line — only when the recorded total
   * actually grew past the last line this agent landed for the task (the
   * at-most-one-per-boundary law, idempotent against replay).
   */
  const meterBoundary = async (task: string, agent: UsageAgentSnapshotLike, attempt?: number, slug?: string): Promise<void> => {
    const usage = await extractor.extract(agent);
    if (usage === undefined) return; // no store answered — the honest absence, no meter line
    const record = buildRecord(agent, usage, { ...(slug === undefined ? {} : { slug }), task, ...(attempt === undefined ? {} : { attempt }) });
    if (record === undefined) return;
    upsertSession(deps.stateDir, record.projectSlug, record);
    const implied = lastMeterImpliedTotal(deps.factory, task, agent.id);
    if (record.totalTokens > implied) {
      deps.factory.meter({ task, provider: meterProviderOf(usage), usage: meterUsageOf(record), agent: agent.id });
    }
  };

  const runtime: UsageRuntime = {
    async recordTurnEnd(agentId) {
      try {
        const agent = await censusAgent(agentId);
        if (agent === undefined) return;
        const usage = await extractor.extract(agent);
        if (usage === undefined) return;
        const record = buildRecord(agent, usage);
        if (record === undefined) return; // not a factory seat — none of the Meter's business
        pending.set(record.agentId, record);
        scheduleFlush(record.projectSlug);
      } catch (error) {
        log(`usage: turn metering of ${agentId} deferred — ${String(error)}`);
      }
    },

    async flushAgent(agent, meta) {
      try {
        const usage = await extractor.extract(agent);
        if (usage === undefined) return undefined;
        const record = buildRecord(agent, usage, meta);
        if (record === undefined) return undefined;
        upsertSession(deps.stateDir, record.projectSlug, record);
        return record;
      } catch (error) {
        log(`usage: seat flush of ${agent.id} deferred — ${String(error)}`);
        return undefined;
      }
    },

    async meterTaskBoundary(input) {
      try {
        if (deps.factory.contractFor(input.task) === undefined) return;
        const agentId = input.agentId ?? lastTaskAgent(deps.factory, input.task);
        if (agentId === undefined) return;
        const agent = await censusAgent(agentId);
        if (agent === undefined) return;
        await meterBoundary(input.task, agent, input.attempt);
      } catch (error) {
        log(`usage: task meter of ${input.task} deferred — ${String(error)}`);
      }
    },

    async meterAgentBoundary(input) {
      try {
        if (deps.factory.contractFor(input.task) === undefined) return;
        await meterBoundary(input.task, input.agent, input.attempt, input.slug);
      } catch (error) {
        log(`usage: peer meter of ${input.task} deferred — ${String(error)}`);
      }
    },

    async loadOrBackfillProjectUsage(slug) {
      const existing = readProjectUsage(deps.stateDir, slug);
      if (existing !== undefined && existing.backfilledAt !== undefined) return existing;
      if (deps.paseoHome === undefined) return existing;
      try {
        const backfilled = await backfillProject(deps, extractor, slug, existing);
        return backfilled ?? existing;
      } catch (error) {
        log(`usage: backfill of ${slug} deferred — ${String(error)}`);
        return existing;
      }
    },

    pruneForReset(slug, keepAgentIds) {
      flushPendingFor(slug);
      const file = readProjectUsage(deps.stateDir, slug);
      if (file === undefined) return;
      const keep = new Set(keepAgentIds);
      const sessions = Object.fromEntries(
        Object.entries(file.sessions).filter(([, record]) => keep.has(record.agentId) && (record.seat === "supervisor" || record.seat === "lead")),
      );
      writeProjectUsage(deps.stateDir, slug, { ...file, updatedAt: new Date().toISOString(), sessions });
    },

    forget(slug) {
      flushPendingFor(slug);
    },

    stop() {
      for (const slug of [...timers.keys()]) flushPendingFor(slug);
    },
  };
  return runtime;
}

/** Which Projects' registrations bind `agentId` as a standing seat. */
function projectsWithSeat(stateDir: string, agentId: string): string[] {
  const slugs: string[] = [];
  try {
    for (const dir of readdirSync(join(stateDir, "projects"), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const reg = readProjectRegistration(stateDir, dir.name);
      if (reg?.supervisor === agentId || reg?.lead === agentId) slugs.push(dir.name);
    }
  } catch {
    // no projects dir — nothing binds
  }
  return slugs;
}

/** The task's most recent Peer agent id — the claim and meter lines' own `agent` stamps. */
function lastTaskAgent(factory: Factory, task: string): string | undefined {
  let agentId: string | undefined;
  for (const evt of factory.ledger.eventsFor(task)) {
    if (evt.event !== "claim_reported" && evt.event !== "meter_written") continue;
    if (typeof evt.agent === "string" && evt.agent.trim() !== "") agentId = evt.agent;
  }
  return agentId;
}

/** The token total the last `meter_written` line for this task+agent implies — 0 when none landed. */
function lastMeterImpliedTotal(factory: Factory, task: string, agentId: string): number {
  let implied = 0;
  for (const evt of factory.ledger.eventsFor(task)) {
    if (evt.event !== "meter_written" || evt.agent !== agentId) continue;
    implied = (evt.usage.inputTokens ?? 0) + (evt.usage.cachedInputTokens ?? 0) + (evt.usage.outputTokens ?? 0);
  }
  return implied;
}

/** Reads one persisted `<paseoHome>/agents/<dir>/<agentId>.json` — damaged files answer undefined. */
function readPersistedAgent(path: string): (UsageAgentSnapshotLike & { archivedAt?: unknown }) | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id !== "" ? record.id : undefined;
    const provider = typeof record.provider === "string" && record.provider !== "" ? record.provider : undefined;
    if (id === undefined || provider === undefined) return undefined;
    return parsed as UsageAgentSnapshotLike & { archivedAt?: unknown };
  } catch {
    return undefined;
  }
}

/**
 * The one-time lazy backfill (ADR 0043 §3): scan `<paseoHome>/agents/` for
 * sessions belonging to the Project — `labels.project === slug`, a task
 * bound to one of the Project's contracts, or a registration's standing
 * seat — extract each from the provider's native store, and persist the
 * rollup with `backfilledAt`. Never re-scans once the stamp lands.
 */
async function backfillProject(
  deps: UsageRuntimeDeps,
  extractor: ReturnType<typeof createUsageExtractor>,
  slug: string,
  existing: ProjectUsageFile | undefined,
): Promise<ProjectUsageFile | undefined> {
  const registration = readProjectRegistration(deps.stateDir, slug);
  if (registration === undefined) return existing;
  const agentsRoot = join(deps.paseoHome!, "agents");
  if (!existsSync(agentsRoot)) return existing;
  const taskScope = new Set<string>();
  for (const evt of deps.factory.ledger.events) {
    if (evt.event !== "contract_set") continue;
    if (evt.workspace === registration.root || evt.workspace.startsWith(`${registration.root}/`)) taskScope.add(evt.task);
  }
  const file: ProjectUsageFile = existing ?? { version: 1, projectSlug: slug, updatedAt: new Date().toISOString(), sessions: {} };
  let matched = 0;
  for (const dir of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    let files: string[];
    try {
      files = readdirSync(join(agentsRoot, dir.name));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      const agent = readPersistedAgent(join(agentsRoot, dir.name, name));
      if (agent === undefined) continue;
      const labels = agent.labels ?? {};
      const bound = labels.project === slug ||
        (labels.task !== undefined && taskScope.has(labels.task)) ||
        agent.id === registration.supervisor ||
        agent.id === registration.lead;
      if (!bound) continue;
      const usage = await extractor.extract(agent);
      const record = usage === undefined ? undefined : buildRecordFor(deps.stateDir, deps.factory, agent, usage, { slug });
      if (record !== undefined) {
        file.sessions[record.agentId] = record;
        matched += 1;
      }
    }
  }
  const stamped: ProjectUsageFile = { ...file, backfilledAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  writeProjectUsage(deps.stateDir, slug, stamped);
  if (matched > 0) deps.onLog?.(`usage: backfilled ${matched} session(s) of ${slug} from ${agentsRoot}`);
  else deps.onLog?.(`usage: backfill of ${slug} found no metered sessions — stamped, never rescanned`);
  return stamped;
}
