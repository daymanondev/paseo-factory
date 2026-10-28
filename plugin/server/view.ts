import { projectTask } from "./core/task-state.ts";
import type { AttemptState } from "./core/task-state.ts";
/**
 * The Factory surface's server-side fold (v0.0.13, ADR 0009 §2): ledger
 * events + lanes + daemon agents → the one versioned FactoryView the client
 * renders. Pure over its inputs — no daemon calls happen here — so the whole
 * verification line (tasks, attempt ladders, evidence, KPIs, retro, ledger
 * stream) is derivable and testable from the ledger alone; surface-rpc.ts
 * adds the daemon half (live agents, providers, seqEnd) around it.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FACTORY_VIEW_VERSION } from "../shared/view.ts";
import type { AgentView, AttemptView, CompanionPluginView, CompanionStatus, FactoryView, LedgerLineView, Lanes, ProjectView, RetroView, TaskView, VaultStatusView } from "../shared/view.ts";
import { COMPANION_CATALOG, CORE_PLUGIN_DEFAULT_VERSION, CORE_PLUGIN_ENTRY } from "../shared/companions.ts";
import type { CompanionCatalogEntry, CorePluginCatalogEntry } from "../shared/companions.ts";
import { readPluginVersionFromDisk } from "./daemon-cli.ts";
import type { DaemonPluginSourceStatus } from "./daemon-cli.ts";
import type { LedgerEvent } from "./core/events.ts";

/** How many ledger lines ride one snapshot — a stream, not a mirror. */
export const LEDGER_STREAM_CAP = 100;

/** Every per-attempt file the detail modal reads is tailed to this size. */
export const DETAIL_TAIL_CHARS = 20_000;

type AnyEvent = LedgerEvent;

// ---- the task fold ------------------------------------------------------------------------

/** Groups a whole ledger into per-task slices, first-appearance order. */
function slicesByTask(events: readonly AnyEvent[]): Map<string, AnyEvent[]> {
  const order: string[] = [];
  const byTask = new Map<string, AnyEvent[]>();
  for (const evt of events) {
    if (!("task" in evt) || typeof evt.task !== "string") continue;
    let slice = byTask.get(evt.task);
    if (slice === undefined) {
      slice = [];
      byTask.set(evt.task, slice);
      order.push(evt.task);
    }
    slice.push(evt);
  }
  return byTask;
}

/** The slice's last event of one kind, or undefined. */
function lastOf<K extends AnyEvent["event"]>(slice: readonly AnyEvent[], kind: K): Extract<AnyEvent, { event: K }> | undefined {
  let found: Extract<AnyEvent, { event: K }> | undefined;
  for (const evt of slice) if (evt.event === kind) found = evt as Extract<AnyEvent, { event: K }>;
  return found;
}

/** The lane half of a provider string — `pi/zai/glm-5.3` → `pi`. */
function laneFamily(provider: string): string {
  const at = provider.indexOf("/");
  return at === -1 ? provider : provider.slice(0, at);
}

/** Extracts a non-empty Peer agent id from a task-scoped ledger event when present. */
function eventPeerAgentId(evt: AnyEvent): string | null {
  if (
    evt.event === "claim_reported" ||
    evt.event === "meter_written" ||
    evt.event === "repoke_dispatched" ||
    evt.event === "permit_allowed" ||
    evt.event === "permit_denied" ||
    evt.event === "git_blocked"
  ) {
    return typeof evt.agent === "string" && evt.agent.trim() !== "" ? evt.agent.trim() : null;
  }
  if (evt.event === "respawn_dispatched") {
    return typeof evt.died_agent === "string" && evt.died_agent.trim() !== "" ? evt.died_agent.trim() : null;
  }
  return null;
}

/** One rung of the Attempt Ladder, folded from the attempt's own events. */
function attemptView(slice: readonly AnyEvent[], attempt: AttemptState, previousEndSeq: number, nextAttemptStartSeq?: number): AttemptView {
  const n = attempt.attempt;
  const events = attempt.events;
  const gate = attempt.gate;
  const report = lastOf(events, "report_written");
  const watch = lastOf(events, "watch_written");
  const eye = attempt.review;
  const firstClaim = events.find((e) => e.event === "claim_reported");
  const respawned =
    firstClaim !== undefined && slice.some((e) => e.event === "respawn_dispatched" && e.seq > previousEndSeq && e.seq <= firstClaim.seq);
  let agentId: string | null =
    firstClaim !== undefined && typeof firstClaim.agent === "string" && firstClaim.agent.trim() !== ""
      ? firstClaim.agent.trim()
      : null;
  if (agentId === null) {
    for (const evt of slice) {
      if (evt.seq <= previousEndSeq) continue;
      if (nextAttemptStartSeq !== undefined && evt.seq >= nextAttemptStartSeq) break;
      const candidate = eventPeerAgentId(evt);
      if (candidate !== null) agentId = candidate;
    }
  }
  const answers =
    watch?.outcome === "written" && watch.answers !== undefined
      ? Object.fromEntries(Object.entries(watch.answers).map(([name, value]) => [name, value ?? null]))
      : null;
  const maxProbability =
    answers !== null
      ? Object.values(answers).reduce<number | null>(
          (max, value) => (typeof value === "number" && (max === null || value > max) ? value : max),
          null,
        )
      : null;
  return {
    n,
    verdict: gate?.verdict ?? null,
    open: attempt.open,
    reviewState: attempt.reviewState,
    ownerEligible: attempt.ownerEligible,
    leadEligible: attempt.leadEligible,
    exit: gate?.exit ?? null,
    note: gate?.note ?? null,
    sha: gate?.sha ?? null,
    respawned,
    agentId,
    gateLog: gate?.outputPath === undefined ? null : basename(gate.outputPath),
    report: report === undefined ? null : basename(report.path),
    claimedAt: firstClaim?.ts ?? null,
    verdictAt: gate?.ts ?? null,
    watch:
      watch === undefined
        ? null
        : {
            outcome: watch.outcome,
            model: watch.model,
            error: watch.error ?? null,
            maxProbability,
            answers,
          },
    eye: eye === undefined ? null : { outcome: eye.outcome, model: eye.model, finding: eye.finding },
  };
}

/** Folds the whole ledger into task views, first-appearance order. */
export function foldTasks(events: readonly AnyEvent[]): TaskView[] {
  const byTask = slicesByTask(events);
  const views: TaskView[] = [];
  for (const [task, slice] of byTask) {
    const state = projectTask(slice, task);
    const contract = state.contract;
    const epochSlice = state.epoch;
    const numbers = state.attempts.map((attempt) => attempt.attempt);
    if (contract === undefined && numbers.length === 0 && (task === "supervisor" || task === "lead")) {
      continue;
    }
    const accepted = state.acceptance;
    const meter = lastOf(epochSlice, "meter_written");
    const spawn = lastOf(epochSlice, "spawn_dispatched");
    const lane = meter?.provider ?? spawn?.provider ?? null;
    const dollars = meter !== undefined && typeof meter.usage.totalCostUsd === "number" && Number.isFinite(meter.usage.totalCostUsd) ? meter.usage.totalCostUsd : undefined;
    const totalTokens =
      meter !== undefined
        ? (typeof meter.usage.inputTokens === "number" && Number.isFinite(meter.usage.inputTokens) ? meter.usage.inputTokens : 0) +
          (typeof meter.usage.cachedInputTokens === "number" && Number.isFinite(meter.usage.cachedInputTokens) ? meter.usage.cachedInputTokens : 0) +
          (typeof meter.usage.outputTokens === "number" && Number.isFinite(meter.usage.outputTokens) ? meter.usage.outputTokens : 0)
        : 0;
    const costState = meter === undefined ? "none" : dollars !== undefined ? "metered" : lane !== null && laneFamily(lane) === "copilot" ? "subscription" : "absent";
    const attempts: AttemptView[] = [];
    let previousEndSeq = contract?.seq ?? 0;
    for (let idx = 0; idx < numbers.length; idx += 1) {
      const n = numbers[idx]!;
      const attempt = state.attempts.find((entry) => entry.attempt === n)!;
      const nextN = numbers[idx + 1];
      const nextAttemptEvents = nextN !== undefined ? epochSlice.filter((e) => "attempt" in e && e.attempt === nextN) : [];
      const nextAttemptStartSeq = nextAttemptEvents.length > 0 ? Math.min(...nextAttemptEvents.map((e) => e.seq)) : undefined;
      attempts.push(attemptView(epochSlice, attempt, previousEndSeq, nextAttemptStartSeq));
      const attemptEvents = epochSlice.filter((e) => "attempt" in e && e.attempt === n);
      previousEndSeq = Math.max(previousEndSeq, ...attemptEvents.map((e) => e.seq));
    }
    let taskAgentId: string | null = null;
    for (const evt of epochSlice) {
      const candidate = eventPeerAgentId(evt);
      if (candidate !== null) taskAgentId = candidate;
    }
    if (taskAgentId === null) {
      taskAgentId = attempts.findLast((a) => typeof a.agentId === "string" && a.agentId !== "")?.agentId ?? null;
    }
    let allowed = 0;
    let denied = 0;
    let blocked = 0;
    for (const evt of epochSlice) {
      if (evt.event === "permit_allowed") allowed += 1;
      else if (evt.event === "permit_denied") denied += 1;
      else if (evt.event === "git_blocked") blocked += 1;
    }
    views.push({
      task,
      ...(contract?.execution === undefined ? {} : { execution: contract.execution }),
      workspace: contract?.workspace ?? "",
      description: contract?.description ?? null,
      status: state.status,
      ownerEligible: state.attempts.some((attempt) => attempt.ownerEligible),
      leadEligible: state.attempts.some((attempt) => attempt.leadEligible),
      pendingLanding: state.pendingLanding,
      accepted: accepted !== undefined,
      acceptedBy: accepted?.accepted_by ?? null,
      currentAttempt: state.currentAttempt?.attempt,
      verdict: state.verdict,
      lane,
      agentId: taskAgentId,
      costState,
      costUsd: dollars ?? null,
      totalTokens,
      needsHumanReason: state.needs?.reason ?? null,
      choke: { allowed, denied, blocked },
      attempts,
      lastSeq: slice.reduce((max, evt) => Math.max(max, evt.seq), 0),
    });
  }
  return views;
}

/** The header's five tiles, derived from the same fold the cards read. */
export function foldKpis(tasks: readonly TaskView[]): { needsHuman: number; running: number; readyToAccept: number; accepted: number; totalCostUsd: number; totalTokens: number } {
  let needsHuman = 0;
  let running = 0;
  let readyToAccept = 0;
  let accepted = 0;
  let totalCostUsd = 0;
  let totalTokens = 0;
  for (const task of tasks) {
    if (task.status === "needs-human") needsHuman += 1;
    else if (task.status === "running") running += 1;
    else if (task.status === "ready-to-accept") readyToAccept += 1;
    else if (task.status === "accepted") accepted += 1;
    if (task.costState === "metered" && task.costUsd !== null) totalCostUsd += task.costUsd;
    if (typeof task.totalTokens === "number") totalTokens += task.totalTokens;
  }
  return { needsHuman, running, readyToAccept, accepted, totalCostUsd, totalTokens };
}

// ---- the retro fold -----------------------------------------------------------------------

/** Parses `## R<n> — <class>` sections out of a proposals file — the rendered R1..Rn. */
function parseProposals(path: string): { id: number; cls: string; text: string }[] {
  let file: string;
  try {
    file = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const proposals: { id: number; cls: string; text: string }[] = [];
  const lines = file.split("\n");
  let current: { id: number; cls: string } | null = null;
  for (const line of lines) {
    const header = /^## R(\d+) — (.+)$/.exec(line.trim());
    if (header !== null) {
      current = { id: Number(header[1]), cls: header[2]! };
      continue;
    }
    if (current !== null) {
      const proposal = /^- Proposal: (.+)$/.exec(line);
      if (proposal !== null) {
        proposals.push({ id: current.id, cls: current.cls, text: proposal[1]! });
        current = null;
      }
    }
  }
  return proposals;
}

/** Folds every retro_written into a rendered retro (newest last, ledger order). */
export function foldRetro(events: readonly AnyEvent[]): RetroView[] {
  const views: RetroView[] = [];
  for (const evt of events) {
    if (evt.event !== "retro_written") continue;
    views.push({
      seq: evt.seq,
      day: evt.ts.slice(0, 10),
      outcome: evt.outcome,
      model: evt.model,
      proposalCount: evt.proposalCount ?? null,
      proposalsPath: evt.proposalsPath ?? null,
      proposals: evt.proposalsPath === undefined ? [] : parseProposals(evt.proposalsPath),
    });
  }
  return views;
}

// ---- the ledger stream --------------------------------------------------------------------

/** One ledger line, rendered — the stream's whole payload. */
export function renderLedgerLine(evt: AnyEvent): string {
  switch (evt.event) {
    case "ledger_schema":
      return `ledger schema v${evt.version}`;
    case "contract_set":
      return `contract gate="${evt.gate}" artifact=${evt.artifact}${evt.scope === undefined ? "" : ` scope=[${evt.scope.join(",")}]`}${evt.skills === undefined ? "" : ` skills=[${evt.skills.join(",")}]`}`;
    case "claim_reported":
      return `claim #${evt.attempt} ${evt.sha.slice(0, 7)}`;
    case "gate_started":
      return `gate #${evt.attempt} started`;
    case "gate_finished":
      return `gate #${evt.attempt} ${evt.verdict} — ${evt.note}`;
    case "fresh_eyes_written":
      return `fresh-eyes #${evt.attempt} ${evt.outcome}`;
    case "watch_written":
      return `watch #${evt.attempt} ${evt.outcome}`;
    case "report_written":
      return `report #${evt.attempt} ${basename(evt.path)}`;
    case "attempt_accepted":
      return `ACCEPTED #${evt.attempt}${evt.accepted_by === undefined ? "" : ` by ${evt.accepted_by}`}`;
    case "permit_allowed":
      return `choke allowed ${evt.name}`;
    case "permit_denied":
      return `choke denied ${evt.name} (${evt.rule})`;
    case "git_blocked":
      return `git refused ${evt.rule}`;
    case "spawn_dispatched":
      return `spawn ${evt.provider}`;
    case "spawn_refused":
      return `spawn refused ${evt.rule}`;
    case "meter_written":
      return `meter ${evt.provider}${typeof evt.usage.totalCostUsd === "number" ? ` $${evt.usage.totalCostUsd.toFixed(2)}` : ""}`;
    case "repoke_dispatched":
      return `re-poke dispatched`;
    case "repoke_refused":
      return `re-poke refused ${evt.rule}`;
    case "respawn_dispatched":
      return `respawn ${evt.provider}`;
    case "respawn_refused":
      return `respawn refused ${evt.rule}`;
    case "needs_human":
      return `needs human — ${evt.reason}`;
    case "retro_written":
      return `retro ${evt.outcome}${evt.proposalCount === undefined ? "" : ` (${evt.proposalCount} proposals)`}`;
  }
}

function ledgerLines(events: readonly AnyEvent[]): LedgerLineView[] {
  const lines: LedgerLineView[] = [];
  for (let i = events.length - 1; i >= 0 && lines.length < LEDGER_STREAM_CAP; i -= 1) {
    const evt = events[i]!;
    lines.push({ seq: evt.seq, ts: evt.ts, event: evt.event, task: "task" in evt && typeof evt.task === "string" ? evt.task : null, line: renderLedgerLine(evt) });
  }
  return lines;
}

// ---- the whole view -----------------------------------------------------------------------

/** The daemon half's raw input — surface-rpc.ts gathers it, this module never calls the daemon. */
export interface DaemonAgentsInput {
  agents: readonly AgentView[];
  supervisor: AgentView | null;
  lead: AgentView | null;
  providers: readonly {
    provider: string;
    available: boolean;
    models?: {
      id: string;
      label: string | null;
      thinkingOptions?: { id: string; label?: string | null }[] | null;
      defaultThinkingOptionId?: string | null;
    }[] | null;
  }[];
  daemonError: string | null;
}

// ---- the companion fold (v0.0.17, ADR 0012 §2) ----------------------------------------------

/**
 * The daemon's install identity — which source a plugin was installed from,
 * discriminated on `kind` (@getpaseo/protocol's `PluginSourceIdentity` subset).
 * `pluginPath` is optional so the daemon bridge's own `DaemonPluginItem`
 * (whose identity may omit it, plus a registry pointer) assigns directly —
 * the fold only reads `kind` and the kind's source string.
 */
export type DaemonPluginIdentity =
  | { kind: "git"; remote: string; pluginPath?: string }
  | { kind: "directory"; path: string }
  | { kind: "npm"; packageName: string; pluginPath?: string };

/**
 * One daemon plugin-list entry, structural — the subset of `@getpaseo/protocol`'s
 * `PluginListItem` the fold reads. surface-rpc.ts gathers it, this module never
 * calls the daemon. The install identity (not the legacy `source` field, whose
 * enum has no npm arm) is the installKind truth.
 */
export interface DaemonPluginEntry {
  id: string;
  path?: string;
  enabled: boolean;
  status: "running" | "failed" | "disabled";
  error?: string;
  /** Legacy revision pointer — fills when `installation.currentRevision` is absent. */
  commit?: string;
  /** Resolved semantic version from npm metadata or package.json (v0.0.25, ADR 0012 §3). */
  version?: string;
  npm?: { version?: string };
  installation?: {
    identity?: DaemonPluginIdentity;
    currentRevision?: string;
  };
}

/** The daemon plugin half's raw input — null plugins means the list call was unavailable. */
export interface DaemonPluginsInput {
  plugins: readonly DaemonPluginEntry[] | null;
  /** Optional cached on-demand update status rows keyed by plugin id (v0.0.25, ADR 0012 §4). */
  updates?: ReadonlyMap<string, DaemonPluginSourceStatus> | null;
  /** ISO timestamp when update statuses were last checked for this home (v0.0.25). */
  checkedAt?: string | null;
}

/** The install identity's source string per kind — git remote, directory path, or npm package. */
function installedSourceOf(identity: DaemonPluginIdentity): string | null {
  if (identity.kind === "git") return identity.remote;
  if (identity.kind === "directory") return identity.path;
  return identity.packageName;
}

function resolvePluginVersion(entry: DaemonPluginEntry, fallbackVersion: string | null = null): string | null {
  const direct =
    entry.version ??
    entry.npm?.version ??
    (entry.path !== undefined ? readPluginVersionFromDisk(entry.path) : undefined);
  return direct ?? fallbackVersion;
}

/** Shared pure join of a catalog entry (Core or Companion) against its listed daemon row and cached update status. The catalog entry spreads first, so the declarative card fields — including the v0.0.30 `access` tier — always ride the view verbatim; only live daemon state is layered on top. */
function foldPluginCard(
  entry: CompanionCatalogEntry | CorePluginCatalogEntry,
  listed: DaemonPluginEntry | undefined,
  update: DaemonPluginSourceStatus | null,
  fallbackStatus: CompanionStatus,
  fallbackEnabled: boolean,
  fallbackVersion: string | null,
): CompanionPluginView {
  if (listed === undefined) {
    return {
      ...entry,
      capabilities: [...entry.capabilities],
      status: fallbackStatus,
      enabled: fallbackEnabled,
      installKind: null,
      installedSource: null,
      currentRevision: null,
      version: fallbackVersion,
      latestRevision: null,
      commitsBehind: null,
      updateAvailable: null,
      error: null,
    };
  }
  const identity = listed.installation?.identity;
  const installKind = identity?.kind ?? null;
  const currentRevision = listed.installation?.currentRevision ?? listed.commit ?? update?.currentRevision ?? null;
  const isRemote = installKind === "git" || installKind === "npm";
  return {
    ...entry,
    capabilities: [...entry.capabilities],
    status: listed.status,
    enabled: listed.enabled,
    installKind,
    installedSource: identity === undefined ? null : installedSourceOf(identity),
    currentRevision,
    version: resolvePluginVersion(listed, fallbackVersion),
    latestRevision: isRemote ? (update?.latestRevision ?? null) : null,
    commitsBehind: isRemote ? (update?.commitsBehind ?? null) : null,
    updateAvailable: isRemote ? (update?.updateAvailable ?? null) : null,
    error: listed.error ?? null,
  };
}

/**
 * Folds the Core plugin (`paseo-factory`) entry against the daemon's plugin
 * list and cached update check snapshot (v0.0.25, ADR 0012 §2–§4). When the
 * daemon plugin list does not include `paseo-factory` (e.g. unit test fixtures
 * that pass only companion entries), defaults to `running` at
 * `CORE_PLUGIN_DEFAULT_VERSION` since the core plugin is actively serving the
 * snapshot itself.
 */
export function foldCorePlugin(
  plugins: readonly DaemonPluginEntry[] | null,
  updates?: ReadonlyMap<string, DaemonPluginSourceStatus> | null,
): CompanionPluginView {
  const listed = plugins === null ? undefined : plugins.find((plugin) => plugin.id === CORE_PLUGIN_ENTRY.id);
  const update = updates?.get(CORE_PLUGIN_ENTRY.id) ?? null;
  return foldPluginCard(CORE_PLUGIN_ENTRY, listed, update, "running", true, CORE_PLUGIN_DEFAULT_VERSION);
}

/**
 * Joins the companion catalog against the daemon's plugin list: every catalog
 * entry becomes exactly one card — listed companions carry their live daemon
 * state, semantic version, and on-demand update status; unlisted entries (or
 * an unavailable list, the degrade law) fold to the `not_installed` default.
 * Strangers on the daemon never gain a card, and no host-disk path is ever
 * probed for uninstalled companions.
 */
export function foldCompanions(
  plugins: readonly DaemonPluginEntry[] | null,
  updates?: ReadonlyMap<string, DaemonPluginSourceStatus> | null,
): CompanionPluginView[] {
  return COMPANION_CATALOG.map((entry): CompanionPluginView => {
    const listed = plugins === null ? undefined : plugins.find((plugin) => plugin.id === entry.id);
    const update = updates?.get(entry.id) ?? null;
    return foldPluginCard(entry, listed, update, "not_installed", false, null);
  });
}

/**
 * The fold's half of the v3 view (v0.0.38, ADR 0026 §5): the `Lane profile`
 * fields (`profiles`, `activeProfileId`, `activeProfileModified`,
 * `hasProjectLaneOverride`) and the machine-only `machineLanes` table are
 * gatherer-owned filesystem probes the snapshot handler (surface-rpc.ts)
 * layers over this fold — the vault-status precedent, the fold stays pure
 * over its inputs.
 */
export type FactoryViewFold = Omit<
  FactoryView,
  "profiles" | "activeProfileId" | "activeProfileModified" | "hasProjectLaneOverride" | "machineLanes"
>;

/** Builds the one snapshot from its halves: ledger fold + lanes + daemon reads. */
export function foldView(input: {
  stateDir: string;
  generatedAt: string;
  lanes: Lanes;
  events: readonly AnyEvent[];
  daemon: DaemonAgentsInput;
  /** The daemon plugin half (v0.0.17, ADR 0012 §2) — null plugins folds every catalog entry to not_installed. */
  companions: DaemonPluginsInput;
  /** The active Project scope (v0.0.14) — null on the unscoped global view. */
  project: ProjectView | null;
  /** Every discovered Project for the header's Project Selector. */
  projects: readonly ProjectView[];
  /**
   * The `Private vault` status half (v0.0.21, ADR 0014 §4) — the gathered
   * `VaultStatusView` passes through the way `foldCompanions` folds the plugin
   * list: the filesystem probe belongs to the gatherer (surface-rpc.ts), the
   * fold stays pure over its inputs.
   */
  vault: VaultStatusView;
}): FactoryViewFold {
  const tasks = foldTasks(input.events);
  return {
    version: FACTORY_VIEW_VERSION,
    stateDir: input.stateDir,
    generatedAt: input.generatedAt,
    lanes: input.lanes,
    kpis: foldKpis(tasks),
    tasks,
    agents: [...input.daemon.agents],
    providers: input.daemon.providers.map((provider) => ({
      provider: provider.provider,
      available: provider.available,
      models: provider.models ?? null,
    })),
    supervisor: input.daemon.supervisor,
    lead: input.daemon.lead,
    retro: foldRetro(input.events),
    ledger: ledgerLines(input.events),
    daemonError: input.daemon.daemonError,
    project: input.project,
    projects: [...input.projects],
    corePlugin: foldCorePlugin(input.companions.plugins, input.companions.updates),
    companions: foldCompanions(input.companions.plugins, input.companions.updates),
    pluginsCheckedAt: input.companions.checkedAt ?? null,
    vault: input.vault,
  };
}

/** Reads a per-attempt file from the stateDir, tailed — the detail modal's payload. */
export function readTailed(stateDir: string, name: string): string | null {
  let file: string;
  try {
    file = readFileSync(join(stateDir, name), "utf8");
  } catch {
    return null;
  }
  if (file.length <= DETAIL_TAIL_CHARS) return file;
  return `[truncated]\n${file.slice(-DETAIL_TAIL_CHARS)}`;
}
