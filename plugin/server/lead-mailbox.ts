import { prepareOpenDesignDispatch } from "./core/open-design/open-design-link.ts";
import { discoverHelperMcps } from "./core/helper-mcp-sync.ts";
import { resolveVaultUserHome } from "./core/vault-materialization.ts";
import { liveSeatCandidates } from "./seats.ts";
import { withProjectIngressLock } from "./core/project-ingress-lock.ts";
import { atomicJson, readOptionalJson } from "./core/json-store.ts";
import { commitSeatMemoryOnRoot } from "./core/workspace.ts";
/**
 * The Lead mailbox runtime (v0.0.20, ADR 0013 Decisions 3–5): the plugin-side
 * single writer around one `<projectStateDir>/mailbox.jsonl` per Project. The
 * pure fold and the append helpers live in `./core/mailbox.ts` (ticket 05's
 * core); this module owns everything around them:
 *
 *   - the serialized per-Project async lane `projectLane(slug)` — one promise
 *     chain per slug, so every read-then-append against a Project's mailbox
 *     and every seat act on that Project run in submission order (the
 *     single-writer law ADR 0004 names);
 *   - `enqueueLeadMail` — append `mail_queued` through the core, on the lane;
 *   - `drainLeadMailbox` — when the Project's Lead is idle (no pending
 *     permissions), `rotationState === "normal"`, nothing is in flight, and mail
 *     is queued: batch ALL queued items into one formatted prompt,
 *     `agents.ref(leadAgentId).send(...)`, then append `mail_delivered`;
 *   - `readLeadContextTokens` — the deterministic 128k context sensor (0 LLM
 *     tokens, no 4th agent role): the live snapshot's `lastUsage` first, the
 *     Pi session `.jsonl` at `persistence.nativeHandle` as the fallback across
 *     daemon restarts;
 *   - `pumpProjectLead` — run the lane; while the Lead is `running` over
 *     `LEAD_ROTATE_TOKENS` the pump persists `rotation_pending` and never
 *     interrupts the turn; once no Task Peer remains in flight it
 *     transitions a held `rotation_pending` into `beginHandoff` (ADR 0031
 *     Quiet-Point Succession), and while `handing_over` it resolves the
 *     pause-aware fuse (v0.2.2, ADR 0050: trip over a dead or hung Lead,
 *     re-send an alive paused one within the episode send cap);
 *   - `onLeadTurnEnded` — the turn-boundary state machine (ticket 07): settle
 *     the in-flight batch (`mail_acked` on completed, `mail_requeued` on
 *     failed/canceled), then either complete a handoff (archive the outgoing
 *     Lead, spawn the successor with the roster + digest + handoff kickoff,
 *     reset `normal`, drain the held mail), begin one (lock `handing_over`,
 *     steer the bounded extraction prompt) at a quiet point only — while any
 *     Task Peer runs the rotation holds in `rotation_pending` with the
 *     outgoing Lead live and all mail `mail_queued` — or drain per ticket 06;
 *     since v0.2.2 (ADR 0050 Decision 2) only a `completed` extraction turn
 *     completes the handoff — a `failed`/`canceled` one holds `handing_over`
 *     for a bounded re-send instead of fabricating a finished handoff;
 *   - `dispatchLead` — the spool's `lead_dispatch` handler: resolve the target
 *     Project (`workspace` via resolveProject, `project` slug via the
 *     registry), auto-ensure the Lead seat (the `leadEnsure` path — the
 *     spec's `ensureProjectSeat("lead")`), append `mail_queued`
 *     (`from` = the request's `from ?? "owner"`), pump, and reply with the
 *     dispatch facts;
 *   - `notifyPeer` — the spool's peer hook: a Task's terminal Verdict or
 *     needs-human recording lands as `from: "peer"` mail on the owning
 *     Project's lane, held while a synchronous CLI Driver wave is in flight
 *     (derived from the ledger alone) and flushed as one consolidated
 *     delivery when the wave's last outcome closes it;
 *   - `startupRecovery` — run the core's recovery helper with
 *     `reason: "daemon-restart"` for every registered Project, so an un-acked
 *     delivery from a crashed lifetime returns to `queued` (zero mail lost);
 *   - `settleLeadRotation` — the same recovery with `reason: "lead-rotated"`
 *     for one Project, fired by the surface's `retireSeat` through its
 *     `onLeadRetired` door the moment a Lead is archived, so a manual rotate
 *     racing a live delivery returns the batch to `queued` instead of
 *     stranding it `inFlight` until the next plugin restart;
 *   - `onAgentArchived` / `markPluginArchive` — the lost-Lead door (v0.6.1,
 *     ADR 0057 §4): the shell's `agent.archive.after` registration hands
 *     every daemon archive here; an outside archive of a bound Lead (one the
 *     surface did not mark first) clears the binding, requeues un-acked mail
 *     (`reason: "lead_lost"`), marks the on-disk handover stale-unknown, and
 *     pumps — the normal succession path raises the successor with the
 *     handover plus a staleness line.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "./core/factory.ts";
import { readCorrelations } from "./core/correlations.ts";
import { MAX_ATTEMPTS } from "./core/events.ts";
import type { LedgerEvent } from "./core/events.ts";
import { ensureProjectRegistered, listProjectRegistrations, projectStateDir, projectNotebookPath, readProjectRegistration, resolveProject, writeProjectRegistration } from "./core/project.ts";
import type { LeadRotationState, ProjectRegistration } from "./core/project.ts";
import { loadLanes, saveLanes } from "./core/lanes.ts";
import { buildSeatKickoffPacket } from "./core/preflight.ts";
import { taskWorktreeBranch, taskWorktreePath } from "./core/workspace.ts";
import { inferRoleFromProviderId } from "./roles.ts";
import {
  ackLeadMail as appendMailAcked,
  deliverLeadMail as appendMailDelivered,
  enqueueLeadMail as appendMailQueued,
  readLeadMailbox,
  recoverLeadMailbox,
  requeueLeadMail as appendMailRequeued,
} from "./core/mailbox.ts";
import type { LeadMailFrom, LeadMailItem, LeadMailKind, MailRecipient } from "./core/mailbox.ts";
import { boundTaskPeers, peerIsRunning } from "./task-peers.ts";
import { foldTasks, renderLedgerLine } from "./view.ts";
import type { TaskView } from "../shared/view.ts";
import type {
  SpoolLeadDispatchRequest,
  SpoolReply,
  SpoolSupervisorDispatchRequest,
  SpoolSupervisorReportRequest,
} from "./spool.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "./surface-rpc.ts";
import { capHandoffText, parseHandoffFile, renderHandoffFile, validHandoffText } from "./handoff-text.ts";
import type { HandoffFileMetadata } from "./handoff-text.ts";
import { readHandoffProgress, writeHandoffProgress, laneRef, laneValue } from "./handoff-progress.ts";
import { buildSubstituteHandover, readNotebook, readHandoverGit } from "./substitute-handover.ts";
import type { HandoffProgress, HandoffRequest, HandoffReply } from "../shared/handoff.ts";
import { createSupervisorHandoffRuntime } from "./supervisor-handoff.ts";
import { stopAgentViaCli } from "./daemon-cli.ts";
import { createPeerHandoffRuntime } from "./peer-handoff.ts";
import type { DaemonReply } from "./daemon-cli.ts";
import { readNativeContextWindowTokens, type UsagePaths } from "./core/usage-extractor.ts";
import type { UsageRuntime } from "./usage-rollup.ts";
import { factoryRegistryFor } from "./projects.ts";
import type { FactoryRegistry } from "./projects.ts";
export { PEER_HANDOFF_TOKENS } from "./peer-handoff.ts";
import { HANDOFF_EXTRACTION_MAX_SENDS, HANDOFF_EXTRACTION_TIMEOUT_MS, LEAD_ROTATE_TOKENS } from "./handoff-limits.ts";
export { HANDOFF_EXTRACTION_MAX_SENDS, HANDOFF_EXTRACTION_TIMEOUT_MS, LEAD_ROTATE_TOKENS };
/**
 * The `lead-handoff.md` byte ceiling (v0.0.97, ADR 0047 §3.3, amending ADR 0044):
 * 8,192 bytes (8 KB). The handoff is a lean ~2k-token tactical baton — the
 * machine-verified roster and ledger digest carry the authoritative state, so
 * an outgoing Lead's prose never re-bloats the successor's Turn 0.
 */
export const LEAD_HANDOFF_MAX_BYTES = 8 * 1024;


const INTERRUPTED_HANDOFF_EXTRACTION_NOTE =
  "(the outgoing Lead was interrupted during handoff extraction — rely on the Machine-Verified Active Peer Roster and Ledger State Digest above)";

/**
 * The human gloss of each degraded-completion reason (v0.2.2, ADR 0050
 * Decision 4), quoted in the one `needs_human` mail the runtime appends to
 * the Supervisor slice whenever a handoff completes without a `completed`
 * extraction turn behind it.
 */
const DEGRADED_HANDOFF_COMPLETION_REASONS: Record<"extraction-send-failed" | "extraction-timeout" | "extraction-send-cap", string> = {
  "extraction-send-failed": "the extraction prompt could not be delivered to the outgoing Lead (absent, errored, or the send threw)",
  "extraction-timeout": "the extraction window elapsed with the outgoing Lead still running",
  "extraction-send-cap": "the episode's extraction re-send cap was exhausted",
};

/**
 * Whether an agent's attention state blocks mailbox delivery (v0.0.24, ADR 0015 §2):
 * only a mid-turn permission prompt (`attentionReason === "permission"`) holds
 * mail; a stale `attentionReason === "error"` from an earlier failed turn never
 * freezes the mailbox.
 */
export function isBlockedByAttention(agent: SurfaceAgentSnapshot): boolean {
  return agent.requiresAttention === true && agent.attentionReason === "permission";
}

/**
 * Whether a non-archived seat (`Lead` or `Supervisor`) is ready to receive a
 * mailbox batch (ADR 0031): both `"idle"` and Paseo's idle-runtime-collected
 * `"closed"` state (`archivedAt === null`) are ready when not blocked by a
 * mid-turn permission prompt (`isBlockedByAttention`). Calling `.send(prompt)`
 * on a `"closed"` seat automatically resumes its runtime from persistence.
 */
export function isSeatReadyForMail(agent: SurfaceAgentSnapshot): boolean {
  return (agent.status === "idle" || agent.status === "closed") && !isBlockedByAttention(agent);
}

// ---- the deterministic context sensor (ADR 0013 §5, "Reading Lead Context Tokens") ----------

/** What the sensor read, and where it read it from — nulls mean "unknown", never a guess. */
export interface LeadContextTokens {
  usedTokens: number | null;
  maxTokens: number | null;
  source: "daemon" | "session-file" | "native-store";
}

/**
 * Reads one Lead's context-window usage deterministically — 0 LLM tokens, no
 * 4th agent role. Primary: the live daemon snapshot's `lastUsage`
 * (`contextWindowUsedTokens` / `contextWindowMaxTokens`, the SDK's
 * `AgentUsage` fields). Fallback (after a daemon restart, when `lastUsage` is
 * gone): the Pi session `.jsonl` at `persistence.nativeHandle` — the LAST
 * assistant message carrying `usage` answers, computed as
 * `totalTokens || (input + output + cacheRead + cacheWrite)`.
 */
export function readLeadContextTokens(lead: SurfaceAgentSnapshot, usagePaths?: UsagePaths): LeadContextTokens {
  const used = finiteNumber(lead.lastUsage?.contextWindowUsedTokens);
  if (used !== null && used > 0) {
    return { usedTokens: used, maxTokens: finiteNumber(lead.lastUsage?.contextWindowMaxTokens), source: "daemon" };
  }
  const native = lead.persistence?.nativeHandle;
  if (typeof native === "string" && native !== "") {
    const fromFile = readLastAssistantUsageTokens(native);
    if (fromFile !== null) return { usedTokens: fromFile, maxTokens: null, source: "session-file" };
  }
  // The multi-provider fallback (v0.0.87, ADR 0043 §3): every harness's own
  // native store answers when the daemon gauge is gone — codex's rollout
  // tail, antigravity's steps table, and so on, not just Pi's `.jsonl`.
  const fromStore = readNativeContextWindowTokens(lead, usagePaths);
  if (fromStore !== null) return { usedTokens: fromStore, maxTokens: null, source: "native-store" };
  return { usedTokens: null, maxTokens: null, source: "daemon" };
}

/**
 * The `.jsonl` fallback's one read: walk the session file's lines backwards,
 * find the last assistant message carrying a `usage` record (skipping later
 * lines without one), and fold it — `totalTokens` wins when present, else the
 * component sum. Tolerant of the wrapper shapes Pi writes (`message` nested
 * or flat) and of camelCase / snake_case usage keys; anything unreadable is
 * a null, never a guess.
 */
function readLastAssistantUsageTokens(sessionPath: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a damaged line is skipped, never trusted
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as { message?: { role?: unknown; usage?: unknown }; role?: unknown; usage?: unknown };
    const message = record.message !== undefined && typeof record.message === "object" ? record.message : record;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const usage = (message as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null) continue;
    const total = finiteNumber(numberAt(usage, ["totalTokens", "total_tokens"]));
    if (total !== null) return total;
    const components = [
      numberAt(usage, ["input", "inputTokens", "input_tokens"]),
      numberAt(usage, ["output", "outputTokens", "output_tokens"]),
      numberAt(usage, ["cacheRead", "cacheReadTokens", "cache_read_input_tokens"]),
      numberAt(usage, ["cacheWrite", "cacheWriteTokens", "cache_creation_input_tokens"]),
    ];
    if (components.every((value) => value === null)) continue;
    return components.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  }
  return null;
}

/** The first numeric value among the record's named keys — null when none is a finite number. */
function numberAt(record: object, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = finiteNumber((record as Record<string, unknown>)[key]);
    if (value !== null) return value;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The ensure result the surface handlers' `leadEnsure` / `supervisorEnsure` answers — the runtime's seat door. */
export type EnsureLeadResult =
  | { ok: true; agentId: string; created: boolean; projectRoot: string; slug: string }
  | { ok: false; code: string; error: string };

export type LeadSeatEnsureResult = EnsureLeadResult;

export interface LeadMailRuntimeDeps {
  factory: Factory;
  stateDir: string;
  home?: string;
  /**
   * An already-constructed Per-Project Factory registry (v0.0.92): when
   * present, the runtime uses THIS instance instead of resolving the
   * process-wide one — so a test's runtime, Spool, and assertions share one
   * registry per stateDir. Production omits it (the shell's
   * `factoryRegistryFor` returns the one registry the whole process uses).
   */
  registry?: FactoryRegistry;
  stopAgent?: (agentId: string, home?: string) => Promise<DaemonReply>;
  /** The daemon to deliver through — the live PaseoApi or the tests' fake. */
  daemon: SurfaceDaemonApi | (() => SurfaceDaemonApi);
  /**
   * Auto-ensure a Project's Lead seat (ADR 0013 Decision 4's
   * `ensureProjectSeat("lead")`): the surface handlers' `leadEnsure` is the
   * implementation — find-or-create the standing `seat=lead` agent at the
   * Project's root under its lane.
   */
  ensureLead: (input: { projectRoot: string; message?: string }) => Promise<EnsureLeadResult>;
  /**
   * Retire a Project's Lead (v0.0.20, ADR 0013 §5): the surface handlers'
   * `leadRotate` is the implementation — the `retireSeat` sequence of
   * best-effort cancel, `archive()`, and registration `lead: null`. The
   * handoff's archive step rides it.
   */
  retireLead: (input: { projectRoot: string }) => Promise<{ ok: true; agentId: string } | { ok: false; code: string; error: string }>;
  /**
   * The per-Project usage rollup runtime (v0.0.87, ADR 0043 §3): the outgoing
   * Lead's final session usage is flushed into `<projectStateDir>/usage.json`
   * the moment the 128k handoff archives it — rotated sessions are never
   * lost from the Project's totals.
   */
  usage?: UsageRuntime;
  /**
   * Store-root overrides for the multi-provider context sensor (tests pass
   * temp homes; the default resolves the operator's real provider stores).
   */
  usagePaths?: UsagePaths;
  /**
   * Optional override for the `handing_over` extraction fuse timeout in ms
   * (v0.0.28, ADR 0018 §3; defaults to `HANDOFF_EXTRACTION_TIMEOUT_MS = 180_000`).
   */
  handoffTimeoutMs?: number;
  ownerHandoffTimeoutMs?: number;
  /**
   * The released-Supervisor settle door (v0.6.1 review fix, ADR 0057 §4): the
   * surface's `settleReleasedSupervisor` is the implementation. The lost-Lead
   * path fires it when a parented Lead is archived from OUTSIDE the plugin —
   * every released Supervisor waiting on that Lead archives (the cascade risk
   * died with the Lead) and its record clears, so a release always has a
   * settlement path even when the Lead never hands off through the plugin.
   */
  settleReleasedSupervisor?: (input: { slug: string; leadAgentId: string }) => Promise<void>;
  onLog?: (message: string) => void;
  logger?: { warn?: (message: string) => void; info?: (message: string) => void; error?: (message: string) => void };
}

/** One runtime's public face — see the module doc for each member's law. */
export interface LeadMailRuntime {
  handoff(input: HandoffRequest): Promise<HandoffReply>;
  hasPendingHandoff(slug: string): boolean;
  /** Gates, spawned/running Task Peers, and delivered standing-seat turns. */
  hasActiveWork(): Promise<boolean>;
  dispatchLead(request: SpoolLeadDispatchRequest, options?: { existingDesignSnapshot: true }): Promise<SpoolReply>;
  dispatchSupervisor(request: SpoolSupervisorDispatchRequest): Promise<SpoolReply>;
  reportSupervisor(request: SpoolSupervisorReportRequest): Promise<SpoolReply>;
  notifyPeer(input: { task: string; kind: "verdict" | "needs_human"; text: string }): Promise<void>;
  enqueueLeadMail(
    slug: string,
    mail: { to?: MailRecipient; from: LeadMailFrom; kind: LeadMailKind; task?: string; text: string },
  ): Promise<{ mailId: string }>;
  pumpProjectLead(slug: string): Promise<void>;
  pumpProjectSupervisor(slug: string): Promise<void>;
  /**
   * The turn-boundary state machine (ticket 07 / v0.0.23): `agent.turn_ended`
   * for a registered Lead or Supervisor, with the event's outcome kind and
   * timeline (structural — no SDK types here). Never rejects; every failure
   * logs and holds.
   */
  onLeadTurnEnded(input: LeadTurnEndedInput): Promise<void>;
  startupRecovery(): void;
  /**
   * Pump every registered Project's Lead lane then Supervisor lane (v0.0.31,
   * ADR 0017 §5/§6) — invoked the moment the daemon API is captured at boot
   * (`onPaseoCaptured`), so mail requeued by `startupRecovery()` or queued by
   * an early spool drain (before `paseoApi` arrived) delivers immediately
   * instead of waiting for the next dispatch.
   */
  pumpAll(): Promise<void>;
  /** Periodic Peer context observation without retrying unrelated seat mail. */
  sweepPeers(): Promise<void>;
  /**
   * The rotation settle (ADR 0013 Decision 3's last arm): requeue any
   * un-acked in-flight delivery of one Project's mailbox as `mail_requeued`
   * (`reason: "lead-rotated"`) — the surface's `retireSeat` fires it through
   * its `onLeadRetired` door after a Lead is archived, so a manual rotate
   * racing a live delivery never strands the batch `inFlight`. Idempotent.
   */
  settleLeadRotation(slug: string): void;
  /**
   * The lost-Lead door (v0.6.1, ADR 0057 §4): the shell's
   * `agent.archive.after` registration hands every daemon archive event here.
   * An archive of a registered Lead that the plugin did NOT perform itself
   * (`markPluginArchive` was never fired for the id) clears the binding,
   * requeues delivered-but-unacked Lead mail (`mail_requeued`, reason
   * `lead_lost`), marks the on-disk handover stale-unknown, settles every
   * released Supervisor waiting on that Lead (the `settleReleasedSupervisor`
   * door — the cascade risk died with the Lead), and pumps — the
   * normal succession path creates the successor with the handover plus a
   * staleness line. Never rejects; every failure logs and holds.
   */
  onAgentArchived(input: { agentId: string }): Promise<void>;
  /**
   * Records that the plugin itself is about to archive `agentId` (v0.6.1,
   * ADR 0057 §4) — the surface fires this BEFORE its own archive calls, so
   * the daemon's `agent.archive.after` for that id is recognised as a plugin
   * archive and `onAgentArchived` never runs lost-Lead recovery for it. The
   * marker persists across plugin restarts (the daemon may deliver its event
   * late); it is consumed by the event and cleared by `clearPluginArchive`
   * when the archive call fails.
   */
  markPluginArchive(agentId: string): void;
  /**
   * Clears a marker set by `markPluginArchive` (v0.6.1 review fix): the
   * surface fires it when its own archive call FAILED — the plugin did not
   * archive the id after all, so a later genuine outside archive of the same
   * id must not be swallowed by a stale marker.
   */
  clearPluginArchive(agentId: string): void;
  /**
   * Clears in-memory retry and handoff state for one Project (`slug`), used
   * by `Project reset` (`v0.0.24`, ADR 0015 §5).
   */
  resetProjectMailbox(slug: string): void;
  /**
   * Marks one seat `agentId` as having already received its initial kickoff
   * turn (v0.0.28, ADR 0018 §2).
   */
  markKickoffSent(agentId: string): void;
  /**
   * Clears all active handoff extraction timers on shutdown (v0.0.28, ADR 0018 §3).
   */
  stop(): void;
}

/** What the `agent.turn_ended` wiring hands the machine — the SDK event reduced to plain data. */
export interface LeadTurnEndedInput {
  agentId: string;
  /**
   * The discriminated turn outcome (`PluginTurnOutcome`'s shape, structural —
   * no SDK types here): only `kind` is interpreted; the failure payloads ride
   * through unexamined for the caller's benefit.
   */
  outcome: { kind: "completed" | "failed" | "canceled"; error?: { message: string; code?: string }; reason?: string };
  timeline: readonly { type: string; text?: string }[];
}

export function createLeadMailRuntime(deps: LeadMailRuntimeDeps): LeadMailRuntime {
  // One promise chain per slug: every lane job starts only after the prior
  // job for the SAME Project settles (either way — a failed job never poisons
  // the chain), so read-then-append against one mailbox is atomic in practice.
  const lanes = new Map<string, Promise<unknown>>();
  const handingOverBySlug = new Set<string>();
  const handoffTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Slugs with an extraction send whose turn has not ended yet (v0.2.2, ADR
   * 0050 Decision 2) — suppresses a pre-timeout re-send in the window between
   * the send and the daemon flipping the Lead to `running`. Cleared when the
   * extraction turn ends (any outcome) or the episode completes; after a
   * restart the durable `rotationState` plus the same pause-aware fuse rule
   * carry the decision without it.
   */
  const extractionOutstandingBySlug = new Set<string>();
  const countWaitingPeers = (slug: string, events: readonly LedgerEvent[], live: Map<string, SurfaceAgentSnapshot>) =>
    foldTasks(events).filter(task => !task.accepted && boundTaskPeers({
      stateDir: deps.stateDir, slug, task: task.task, events, live: [...live.values()],
    }).some(peer => peer.status !== "error")).length;
  const progressOf = (slug: string) => readHandoffProgress(deps.stateDir, slug, "lead");
  const updateProgress = (slug: string, patch: Partial<HandoffProgress>): void => {
    const previous = progressOf(slug);
    const current = previous?.state === "done" && patch.state === "scheduled" ? null : previous;
    const loaded = loadLanes(deps.stateDir, slug);
    const lane = loaded.ok ? loaded.lanes.lead : "pi/zcode/glm-5.3";
    const now = new Date().toISOString();
    writeHandoffProgress(deps.stateDir, slug, { seat: "lead", reason: "context-mark", state: "scheduled", fromLane: laneRef(lane), toLane: laneRef(lane), startedAt: now, ...current, ...patch, updatedAt: now });
  };
  const extractionTimeout = (slug: string) => progressOf(slug)?.reason === "context-mark" || progressOf(slug) === null ? handoffTimeoutMs : deps.ownerHandoffTimeoutMs ?? 90_000;
  const handoffTimeoutMs = deps.handoffTimeoutMs ?? HANDOFF_EXTRACTION_TIMEOUT_MS;
  const lastLeadTurnAt = new Map<string, string>();
  const retriedFailedMailIds = new Set<string>();
  const kickoffSentAgentIds = new Set<string>();
  const inFlightKickoffAgentIds = new Set<string>();
  const failedFirstTurnAgentIds = new Set<string>();
  const pendingHandoffByAgentId = new Map<string, string>();
  const inFlightHandoffByAgentId = new Map<string, string>();
  // v0.2.1 hold marker, v0.2.2 (ADR 0050 §1): accelerator only — the durable
  // in-flight arm of `projectPeerInFlight` carries quiet-point correctness
  // across daemon restarts and plugin updates; this Set dissolves with them.
  const interruptedPeerIds = new Set<string>();
  const clearHandoffTimer = (slug: string): void => {
    const timer = handoffTimers.get(slug);
    if (timer !== undefined) {
      clearTimeout(timer);
      handoffTimers.delete(slug);
    }
  };
  const stop = (): void => {
    peerHandoff.stop();
    supervisorHandoff.stop();
    for (const timer of handoffTimers.values()) clearTimeout(timer);
    handoffTimers.clear();
  };
  const log = deps.onLog ?? (() => {});
  const warn = (message: string): void => {
    log(message);
    deps.logger?.warn?.(message);
  };
  // The Per-Project Factory registry (v0.0.89, ADR 0045 §1): every Ledger read
  // below scopes to the OWNING Project's Factory — the post-split root Ledger
  // the runtime was wired with carries no Contracts, so kickoff rosters,
  // in-flight Peer detection, and contract workspace lookups would all read an
  // empty stream. A slug the registry cannot open falls back to the wired
  // Factory, and a task the Project's Factory does not own but the wired
  // Factory still does reads from the wired one (the legacy root bridge, the
  // spool router's own law) — never a wrong-Project stream. Production wires
  // nothing here (the process-wide `factoryRegistryFor` resolves the shell's
  // one registry); tests pass their own `registry` so the runtime, the Spool,
  // and the assertions share ONE instance per stateDir.
  const registry = deps.registry ?? factoryRegistryFor(deps.stateDir, { root: deps.factory });
  const projectFactory = (slug: string): Factory => {
    try {
      return registry.factoryForProject(slug);
    } catch {
      return deps.factory;
    }
  };
  /** The Factory owning `task` for this Project — the Project's own first, the wired root-bridge second. */
  const taskFactoryOf = (slug: string, task: string | undefined): Factory => {
    const project = projectFactory(slug);
    if (project === deps.factory || task === undefined || task === "") return project;
    if (project.contractFor(task) !== undefined) return project;
    return deps.factory.contractFor(task) !== undefined ? deps.factory : project;
  };
  /** The Project's Ledger stream: its OWN Factory's events plus any task the wired Factory still owns (the legacy root bridge). */
  const projectStreamOf = (slug: string): readonly LedgerEvent[] => {
    const project = projectFactory(slug);
    if (project === deps.factory) return deps.factory.ledger.events;
    const wiredOnly = deps.factory.ledger.events.filter((evt) => {
      if (!("task" in evt) || typeof evt.task !== "string") return true; // machine-level facts stay visible
      return project.contractFor(evt.task) === undefined;
    });
    return [...project.ledger.events, ...wiredOnly];
  };
  /** Every available Ledger stream — the root fallback's plus each ALREADY-OPEN
   * Project's (a pure peek: the polling paths must never open, validate, or
   * recover a Ledger mid-maintenance, and a read never mints state). */
  const eventStreamsOf = (): readonly (readonly LedgerEvent[])[] => {
    const streams: (readonly LedgerEvent[])[] = [deps.factory.ledger.events];
    for (const slug of registry.slugs()) {
      const factory = registry.cachedFactoryFor(slug);
      if (factory !== undefined && factory !== deps.factory) streams.push(factory.ledger.events);
    }
    return streams;
  };
  const resolveDaemon = (): SurfaceDaemonApi => (typeof deps.daemon === "function" ? deps.daemon() : deps.daemon);
  const mailboxPath = (slug: string): string => join(projectStateDir(deps.stateDir, slug), "mailbox.jsonl");
  const peerBlockersQueued = new Set<string>();
  const peerHandoff = createPeerHandoffRuntime({
    factory: deps.factory, factoryFor: (slug, task) => taskFactoryOf(slug, task), eventsFor: projectStreamOf, stateDir: deps.stateDir, home: deps.home, stopAgent: deps.stopAgent,
    daemon: resolveDaemon, timeoutMs: handoffTimeoutMs, ownerTimeoutMs: deps.ownerHandoffTimeoutMs, readTokens: (agent) => readLeadContextTokens(agent, deps.usagePaths), log,
    ...(deps.usage === undefined ? {} : { recordUsage: async (input: { slug: string; task: string; agent: SurfaceAgentSnapshot }) => { await deps.usage!.meterAgentBoundary({ task: input.task, agent: input.agent, slug: input.slug }); } }),
    queueNotice: (slug, task, key, text) => {
      appendMailQueued(mailboxPath(slug), { requestId: `peer-owner-handoff:${task}:${key}:lead`, to: "lead", from: "peer", kind: "report", task, text });
      peerBlockersQueued.add(slug);
    },
    queueBlocked: (slug, task, epoch, text) => {
      // ADR 0053 Decision 2 / spec Decision 6: a context-ceiling blocker is a
      // genuine needs-human-grade Peer stall, but it routes exclusively to the
      // Lead mailbox — Supervisor mail comes only from Owner directives and
      // `lead_report_to_supervisor`, never from a Peer stall.
      appendMailQueued(mailboxPath(slug), { requestId: `peer-context-ceiling:${task}:${epoch}:lead`, to: "lead", from: "peer", kind: "needs_human", task, text });
      peerBlockersQueued.add(slug);
    },
    wake: async slug => {
      const project = readProjectRegistration(deps.stateDir, slug);
      if (project) await observePeers(project);
    },
  });

  const projectLane = <T>(slug: string, run: () => Promise<T>): Promise<T> => {
    const prior = lanes.get(slug) ?? Promise.resolve();
    const admitted = () => withProjectIngressLock(deps.stateDir, slug, () => deps.factory.history.runOperation(run));
    const job = prior.then(admitted, admitted);
    lanes.set(
      slug,
      job.then(
        () => undefined,
        () => undefined,
      ),
    );
    return job;
  };

  const supervisorHandoff = createSupervisorHandoffRuntime({
    stateDir: deps.stateDir, daemon: resolveDaemon, timeoutMs: deps.ownerHandoffTimeoutMs ?? 90_000,
    onLane: projectLane, renderMail: renderSupervisorMailBatch, log,
    markKickoffSent: id => { kickoffSentAgentIds.add(id); inFlightKickoffAgentIds.add(id); },
    evidence: slug => {
      const events = projectStreamOf(slug);
      return { events, digest: renderLedgerDigest(events), tasks: foldTasks(events).filter(task => !task.accepted).map(task => `${task.task}: ${task.status}; Attempts: ${task.attempts.length}`).join("\n") };
    },
    retire: async (slug, agent) => {
      const reg = readProjectRegistration(deps.stateDir, slug);
      if (!reg) return;
      const entries = (await resolveDaemon().agents.list({ filter: { includeArchived: false, includeBackground: true } })).entries;
      const child = entries.map(e => e.agent).find(a => !a.archivedAt && a.parentAgentId === agent.id && (a.id === reg.lead || (a.labels.seat === "lead" && a.labels.project === slug)));
      if (child) {
        writeProjectRegistration(deps.stateDir, slug, { root: reg.root, releasedSupervisors: [...(reg.releasedSupervisors ?? []).filter(r => r.agentId !== agent.id), { agentId: agent.id, waitingOnLead: child.id, releasedAt: new Date().toISOString() }] });
        return;
      }
      if (deps.usage) await deps.usage.flushAgent(agent, { slug });
      await (deps.stopAgent ?? stopAgentViaCli)(agent.id, deps.home);
      markPluginArchive(agent.id);
      try { await resolveDaemon().agents.ref(agent.id).archive(); }
      catch (error) { clearPluginArchive(agent.id); throw error; }
    },
  });

  /** `rotationState` as it sits in `project.json` — the typed field, absent folding to "normal". */
  const readRotationState = (slug: string): LeadRotationState => readProjectRegistration(deps.stateDir, slug)?.rotationState ?? "normal";

  /** Persists a rotation transition under the registry's merge-by-field law (the seats' precedent). */
  const writeRotationState = (slug: string, root: string, patch: { rotationState: LeadRotationState | null; handoffRequestedAt?: string | null }): void => {
    writeProjectRegistration(deps.stateDir, slug, {
      root,
      rotationState: patch.rotationState,
      ...(patch.handoffRequestedAt === undefined ? {} : { handoffRequestedAt: patch.handoffRequestedAt }),
    });
  };

  const enqueueLeadMail = (
    slug: string,
    mail: { to?: MailRecipient; from: LeadMailFrom; kind: LeadMailKind; task?: string; text: string },
  ): Promise<{ mailId: string }> =>
    projectLane(slug, async () => {
      const queued = appendMailQueued(mailboxPath(slug), mail);
      return { mailId: queued.mailId };
    });

  /**
   * The ADR 0017 §2 identity fallback: a seat spawned under its native role
   * provider (`factory-lead` / `factory-supervisor`) or bound in
   * `project.json` without labels — the native New Chat path — still answers
   * when the labels filter finds nothing. Only the registration's bound agent
   * id or a role-provider agent pinned to this Project by label or cwd is
   * accepted, so a neighbor Project's seat is never grabbed.
   */
  const liveLeadAgent = async (daemon: SurfaceDaemonApi, slug: string): Promise<SurfaceAgentSnapshot | undefined> =>
    (await liveSeatCandidates(daemon, deps.stateDir, "lead", slug))[0];
  const liveSupervisorAgent = async (daemon: SurfaceDaemonApi, slug: string): Promise<SurfaceAgentSnapshot | undefined> =>
    (await liveSeatCandidates(daemon, deps.stateDir, "supervisor", slug))[0];

  /**
   * The drain (ADR 0013 Decision 3's delivery rule): deliver the queued batch
   * only when the Lead is idle with no pending permissions, the mailbox is
   * unlocked (`rotationState === "normal"`), nothing is in flight, and mail
   * is actually waiting — otherwise the mail simply stays `queued` in the
   * file; holding is the safe state, losing is the bug. Sends first, appends
   * `mail_delivered` after: a failed send leaves the batch queued, never a
   * phantom delivery.
   */
  const hasSeatReceivedFirstTurn = (agent: { id: string; lastUserMessageAt?: string | null }): boolean => {
    if (failedFirstTurnAgentIds.has(agent.id)) return false;
    if (kickoffSentAgentIds.has(agent.id)) return true;
    if (typeof agent.lastUserMessageAt === "string" && agent.lastUserMessageAt.trim() !== "") {
      kickoffSentAgentIds.add(agent.id);
      return true;
    }
    return false;
  };

  const extractionPath = (slug: string) => join(projectStateDir(deps.stateDir, slug), "lead-handoff-extraction.json");
  const readExtraction = (slug: string) =>
    readOptionalJson(extractionPath(slug)) as { requestedAt?: string; prior?: string; stale?: boolean; sends?: number; kickoff?: string; leadLostAt?: string } | undefined;
  /**
   * The parsed on-disk handover (v0.6.1, ADR 0057 §11 hygiene): the body the
   * kickoff feeds, plus the file's own metadata header — the outgoing Lead id
   * and written-at timestamp — when the file carries one. A file without the
   * header parses with `meta: undefined`; an invalid body is `undefined`.
   */
  const readDiskHandoffFile = (slug: string): { meta: HandoffFileMetadata | undefined; body: string } | undefined => {
    try {
      const handoffPath = join(projectStateDir(deps.stateDir, slug), "lead-handoff.md");
      if (!existsSync(handoffPath)) return undefined;
      const parsed = parseHandoffFile(readFileSync(handoffPath, "utf8"));
      return validHandoffText(parsed.body) || parsed.body === INTERRUPTED_HANDOFF_EXTRACTION_NOTE ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const readDiskHandoffText = (slug: string): string | undefined => readDiskHandoffFile(slug)?.body;

  const drainLeadMailbox = async (slug: string): Promise<void> => {
    const path = mailboxPath(slug);
    const state = readLeadMailbox(path);
    if (state.inFlight !== null) return; // a live delivery awaits its turn-end settle
    const registeredLead = readProjectRegistration(deps.stateDir, slug)?.lead;
    const diskHandoffText = readDiskHandoffText(slug);
    const hasPotentialHandoff =
      registeredLead !== undefined &&
      (pendingHandoffByAgentId.has(registeredLead) || (!kickoffSentAgentIds.has(registeredLead) && diskHandoffText !== undefined));
    if (state.queued.length === 0 && !hasPotentialHandoff) return;
    if ((readRotationState(slug) ?? "normal") !== "normal") return; // rotation_pending / handing_over hold the mailbox (ticket 07's machine)
    const daemon = resolveDaemon();
    let lead: SurfaceAgentSnapshot | undefined;
    try {
      lead = await liveLeadAgent(daemon, slug);
    } catch (err) {
      log(`lead-mailbox: cannot read the daemon's agents for ${slug} — holding ${state.queued.length} item(s) queued (${messageOf(err)})`);
      return;
    }
    if (lead === undefined || lead.status === "error") {
      const registration = readProjectRegistration(deps.stateDir, slug);
      if (deps.ensureLead !== undefined && registration?.root !== undefined) {
        const carriedHandoff =
          lead !== undefined ? (pendingHandoffByAgentId.get(lead.id) ?? inFlightHandoffByAgentId.get(lead.id)) : undefined;
        const ensured = await deps.ensureLead({ projectRoot: registration.root });
        if (!ensured.ok) {
          log(`lead-mailbox: cannot ensure lead for ${slug} (${ensured.code}: ${ensured.error}) — holding ${state.queued.length} item(s)`);
          return;
        }
        if (carriedHandoff !== undefined) {
          pendingHandoffByAgentId.set(ensured.agentId, carriedHandoff);
        }
        try {
          lead = await liveLeadAgent(daemon, slug);
        } catch (err) {
          log(`lead-mailbox: cannot read the daemon's agents for ${slug} — holding ${state.queued.length} item(s) queued (${messageOf(err)})`);
          return;
        }
      }
    }
    if (lead === undefined) return; // no live Lead — the next dispatch ensures one and pumps again
    if (!isSeatReadyForMail(lead)) return; // a running or permission-waiting Lead is never interrupted (§User Story 12)
    let pendingHandoff = pendingHandoffByAgentId.get(lead.id);
    if (pendingHandoff === undefined && !hasSeatReceivedFirstTurn(lead) && diskHandoffText !== undefined) {
      const root = readProjectRegistration(deps.stateDir, slug)?.root ?? lead.cwd ?? "";
      const events = root !== "" ? projectEventsOf(slug, root) : [];
      const tasks = foldTasks(events);
      const live = await liveAgentsById();
      const roster = renderPeerRoster({
        stateDir: deps.stateDir,
        slug,
        tasks,
        agents: agentOfTask(events, { stateDir: deps.stateDir, slug, tasks, live }),
        live,
        events,
      });
      const digest = renderLedgerDigest(events);
      // v0.6.1 (ADR 0057 §11 hygiene, spec story 8): the successor dates the
      // on-disk handover by the file's own metadata. The staleness law:
      // - a file WITHOUT metadata is stale-unknown — never fresh (spec test
      //   plan: "a handover file without the new metadata is treated as
      //   stale-unknown, not fresh");
      // - a dated file is stale when it was written before the outgoing
      //   Lead's last activity — anchored to `leadLostAt`, the last moment
      //   the plugin observed the lost Lead (a plugin-written file always
      //   precedes the Lead's loss, so a loss after the write means the Lead
      //   worked on past it);
      // - with no loss marker (the restarted unstarted-successor path), a
      //   dated file is the plugin's own latest write — trusted fresh;
      // - an extraction record that already carries `stale: true` (the
      //   last-known-good rotation prior) keeps its verdict either way.
      const extractionSnapshot = readExtraction(slug);
      const lostLeadAt = typeof extractionSnapshot?.leadLostAt === "string" ? extractionSnapshot.leadLostAt : undefined;
      const diskFile = readDiskHandoffFile(slug);
      const pluginBuilt = diskHandoffText.startsWith("# Plugin-built handover");
      const undated = diskFile !== undefined && diskFile.meta === undefined;
      const writtenMs = diskFile?.meta !== undefined ? Date.parse(diskFile.meta.writtenAt) : Number.NaN;
      const lostMs = lostLeadAt !== undefined ? Date.parse(lostLeadAt) : Number.NaN;
      const datedOld = Number.isFinite(writtenMs) && Number.isFinite(lostMs) && writtenMs < lostMs;
      const extractionStale = extractionSnapshot?.stale === true;
      pendingHandoff = renderSuccessorKickoff({
        slug,
        roster,
        digest,
        handoffText: diskHandoffText,
        stale: !pluginBuilt && (undated || datedOld || extractionStale),
        ...(datedOld
          ? { staleSource: "dated" as const }
          : undated || lostLeadAt !== undefined
            ? { staleSource: "lost-lead" as const }
            : extractionStale
              ? { staleSource: "extraction" as const }
              : {}),
      });
    }
    // v0.0.93 (ADR 0031 Quiet-Point Succession): a Successor Lead's Turn-1
    // kickoff delivers immediately — never held on `projectPeerInFlight`, the
    // v0.0.92 hold. The handoff only completes at a quiet point now (the Peer's
    // verdict is in the queued batch or already acked), so waking the successor
    // here can no longer race a running Peer into a double spawn.
    if (state.queued.length === 0 && pendingHandoff === undefined) return;
    const mailPrompt = state.queued.length === 0 ? "" : renderMailPrompt(state.queued);
    const body = pendingHandoff !== undefined ? (mailPrompt === "" ? pendingHandoff : `${pendingHandoff}\n\n${mailPrompt}`) : mailPrompt;
    const isFirstTurn = !hasSeatReceivedFirstTurn(lead);
    const prompt = prependKickoffPacketIfFirstTurn("lead", slug, lead, body);
    await daemon.agents.ref(lead.id).send(prompt);
    if (isFirstTurn) {
      failedFirstTurnAgentIds.delete(lead.id);
      kickoffSentAgentIds.add(lead.id);
      inFlightKickoffAgentIds.add(lead.id);
    }
    if (pendingHandoff !== undefined) {
      inFlightHandoffByAgentId.set(lead.id, pendingHandoff);
      pendingHandoffByAgentId.delete(lead.id);
    }
    if (state.queued.length > 0) appendMailDelivered(path, { mailIds: state.queued.map((item) => item.mailId), toAgentId: lead.id });
    log(`lead-mailbox: delivered ${state.queued.length} item(s) to the lead of ${slug} (${lead.id})`);
  };

  const prependKickoffPacketIfFirstTurn = (
    role: "supervisor" | "lead",
    slug: string,
    agent: { id: string; cwd?: string | null; lastUserMessageAt?: string | null },
    prompt: string,
  ): string => {
    if (hasSeatReceivedFirstTurn(agent)) return prompt;
    const reg = readProjectRegistration(deps.stateDir, slug);
    const loadedLanes = loadLanes(deps.stateDir, slug);
    const kickoff = buildSeatKickoffPacket({
      role,
      projectSlug: slug,
      projectRoot: reg?.root ?? agent.cwd ?? "",
      ledgerEvents: projectStreamOf(slug),
      helperMcps: discoverHelperMcps({ stateDir: deps.stateDir, ...(deps.home ? { userHome: resolveVaultUserHome(deps.home) } : {}) }).servers,
      ...(loadedLanes.ok ? { lanes: loadedLanes.lanes } : {}),
      // v0.1.0 (ADR 0048 §3): every newly created or rotated Supervisor/Lead
      // Turn-1 packet carries the Project notebook's slug-dependent path and
      // bounded content so the seat never guesses <projectStateDir>/notebook.md.
      stateDir: deps.stateDir,
      // v0.0.97 (ADR 0047 §1.2): the seat's config.systemPrompt already carries
      // buildRoleKickoffPrompt(role) — the Turn-1 user message keeps only the
      // dynamic repository preflight facts, never a second copy of the linked
      // design specification, helper MCP roster, or wave laws.
      omitSystemPromptDuplicates: true,
    });
    return `${kickoff}\n${prompt}`;
  };

  /**
   * The Supervisor drain (v0.0.23, ADR 0015 §3; v0.6.1, ADR 0057 §5): when
   * `supervisorQueued` has waiting items and `supervisorInFlight === null`,
   * re-resolves the Project's live Supervisor at THIS send (the recipient is
   * never carried over from an earlier queue), waits if `Supervisor` is
   * `running` or `initializing` (or requires attention), and otherwise formats
   * the batch (`renderSupervisorMailBatch`), sends it to `Supervisor`, and
   * appends `mail_delivered` (`to: "supervisor"`).
   *
   * v0.6.1 (ADR 0057 §5): no Supervisor is ever created here. With no live
   * Supervisor the mail simply stays queued — holding is the safe state — and
   * the panel's Needs you says "No Supervisor · N reports waiting". The next
   * Supervisor chat the Owner opens (or adopts) receives the held batch after
   * its Seat kickoff packet.
   */
  const drainSupervisorMailbox = async (slug: string): Promise<void> => {
    if (supervisorHandoff.active(slug)) return;
    const path = mailboxPath(slug);
    const state = readLeadMailbox(path);
    if (state.supervisorInFlight !== null || state.supervisorQueued.length === 0) return;
    const daemon = resolveDaemon();
    let supervisor: SurfaceAgentSnapshot | undefined;
    try {
      supervisor = await liveSupervisorAgent(daemon, slug);
    } catch (err) {
      log(`lead-mailbox: cannot read the daemon's supervisor for ${slug} — holding ${state.supervisorQueued.length} item(s) queued (${messageOf(err)})`);
      return;
    }
    if (supervisor === undefined) {
      log(`lead-mailbox: no live Supervisor for ${slug} — holding ${state.supervisorQueued.length} item(s) queued for the next Supervisor (never creating one)`);
      return;
    }
    if (!isSeatReadyForMail(supervisor)) return;
    const isFirstTurn = !hasSeatReceivedFirstTurn(supervisor);
    const prompt = prependKickoffPacketIfFirstTurn("supervisor", slug, supervisor, renderSupervisorMailBatch(state.supervisorQueued));
    await daemon.agents.ref(supervisor.id).send(prompt);
    if (isFirstTurn) {
      failedFirstTurnAgentIds.delete(supervisor.id);
      kickoffSentAgentIds.add(supervisor.id);
      inFlightKickoffAgentIds.add(supervisor.id);
    }
    appendMailDelivered(path, {
      to: "supervisor",
      mailIds: state.supervisorQueued.map((item) => item.mailId),
      toAgentId: supervisor.id,
    });
    log(`lead-mailbox: delivered ${state.supervisorQueued.length} item(s) to the supervisor of ${slug} (${supervisor.id})`);
  };

  /**
   * The mid-turn rotation observation (ADR 0013 §5): while the Project's Lead
   * is `running`, a context reading at or over `LEAD_ROTATE_TOKENS` persists
   * `rotation_pending` — the deferred boundary. The running turn is NEVER
   * interrupted; the state machine waits for `agent.turn_ended`. A sensor
   * miss (no live Lead, no readable usage, an unreadable daemon) observes
   * nothing — holding `normal` is safe, guessing is the bug.
   */
  const observeRotation = async (slug: string): Promise<void> => {
    if (readRotationState(slug) !== "normal") return; // already pending or locked — nothing to observe
    const registration = readProjectRegistration(deps.stateDir, slug);
    if (registration === undefined) return; // no root binding — nothing to persist against
    const daemon = resolveDaemon();
    const lead = await liveLeadAgent(daemon, slug);
    if (lead === undefined || lead.status !== "running") return;
    const tokens = readLeadContextTokens(lead, deps.usagePaths);
    if (tokens.usedTokens === null || tokens.usedTokens < LEAD_ROTATE_TOKENS) return;
    writeRotationState(slug, registration.root, { rotationState: "rotation_pending" });
    updateProgress(slug, { state: "scheduled" });
    log(`lead-mailbox: ${slug}'s lead crossed ${LEAD_ROTATE_TOKENS} tokens (${tokens.usedTokens}, ${tokens.source}) — rotation pending, the turn runs on`);
  };

  /**
   * v0.0.93 / v0.0.99 (ADR 0031 Quiet-Point Succession): transition a held
   * `rotation_pending` into `beginHandoff` the moment no Task Peer remains in
   * flight (`projectPeerInFlight(slug) === false`) and the outgoing Lead seat
   * is ready for mail (or absent/errored). Shared by `pumpProjectLead` (the
   * `notifyPeer`, `dispatchLead`, and `pumpAll` doors) and `observePeers` (the
   * non-Lead/non-Supervisor `agent.turn_ended` and `sweepPeers` doors).
   */
  const tryBeginPendingHandoff = async (slug: string): Promise<boolean> => {
    if (readRotationState(slug) !== "rotation_pending") return false;
    if (await projectPeerInFlight(slug)) {
      const events = projectStreamOf(slug); const live = await liveAgentsById();
      updateProgress(slug, { state: "scheduled", waitingPeers: countWaitingPeers(slug, events, live) });
      return false;
    }
    const reg = readProjectRegistration(deps.stateDir, slug);
    if (reg?.root === undefined) return false;
    const lead = await liveLeadAgent(resolveDaemon(), slug).catch(() => undefined);
    if (lead !== undefined && lead.status !== "error" && !isSeatReadyForMail(lead)) return false;
    try {
      await beginHandoff(slug, reg.root);
      return true;
    } catch (err) {
      log(`lead-mailbox: pending rotation of ${slug} could not begin its handoff — the state stands (${messageOf(err)})`);
      return false;
    }
  };

  /** Runs the lane — the one door delivery and rotation observation go through. */
  const pumpProjectLead = async (slug: string): Promise<void> => {
    await projectLane(slug, async () => {
      const project = readProjectRegistration(deps.stateDir, slug);
      if (project) {
        try { await peerHandoff.observeProject(slug, project.root); }
        catch (error) { log(`Peer handoff observation deferred: ${messageOf(error)}`); }
      }
      try {
        await observeRotation(slug);
      } catch (err) {
        log(`lead-mailbox: rotation observation of ${slug} failed — the state stands (${messageOf(err)})`);
      }
      if (await tryBeginPendingHandoff(slug)) return;
      if (readRotationState(slug) === "handing_over") {
        const reg = readProjectRegistration(deps.stateDir, slug);
        if (reg?.root !== undefined) {
          try {
            await resolveHandingOverEpisode(slug, reg.root);
          } catch (err) {
            log(`lead-mailbox: handoff fuse of ${slug} failed — the state stands (${messageOf(err)})`);
          }
        }
      }
      try {
        await drainLeadMailbox(slug);
      } catch (err) {
        // A pump failure is a delivery failure, never a mail failure — the
        // batch stays queued and the next pump retries it.
        log(`lead-mailbox: pump of ${slug} failed — the mail stays queued (${messageOf(err)})`);
      }
    });
  };

  /** Runs the lane for the Project's Supervisor mailbox (`to: "supervisor"`). */
  const pumpProjectSupervisor = async (slug: string): Promise<void> => {
    await projectLane(slug, async () => {
      try {
        await supervisorHandoff.pump(slug);
        await drainSupervisorMailbox(slug);
      } catch (err) {
        log(`lead-mailbox: supervisor pump of ${slug} failed — the mail stays queued (${messageOf(err)})`);
      }
    });
  };

  const clearRetriedFailedBatch = (slug: string, seat: MailRecipient, mailIds: readonly string[]): void => {
    for (const id of mailIds) retriedFailedMailIds.delete(`${slug}:${seat}:${id}`);
  };

  const claimFailedBatchRetry = (
    slug: string,
    seat: MailRecipient,
    mailIds: readonly string[],
    outcomeKind: string,
  ): boolean => {
    log(`lead-mailbox: ${slug}'s ${seat} turn ${outcomeKind} — ${mailIds.length} item(s) requeued`);
    const shouldRetry = mailIds.some((id) => !retriedFailedMailIds.has(`${slug}:${seat}:${id}`));
    if (!shouldRetry) {
      warn(
        `lead-mailbox: ${slug}'s ${seat} turn ${outcomeKind} after retry — holding ${mailIds.length} item(s) queued without re-pumping`,
      );
      return false;
    }
    for (const id of mailIds) retriedFailedMailIds.add(`${slug}:${seat}:${id}`);
    return true;
  };

  /**
   * The turn-boundary state machine (ticket 07, ADR 0013 §5; v0.0.23, ADR 0015
   * §3) — serialized on the Project's lane like every other mailbox act.
   * Handles both registered `Lead` and registered `Supervisor` turn-end events.
   * Never rejects: a failed step logs and holds (holding is the safe state,
   * losing is the bug).
   */
  const observePeers = async (project: { slug: string; root: string }, input?: LeadTurnEndedInput): Promise<void> => {
    await projectLane(project.slug, async () => {
      try {
        if (input !== undefined) {
          if (input.outcome.kind === "completed") interruptedPeerIds.delete(input.agentId);
          else interruptedPeerIds.add(input.agentId);
        }
        await peerHandoff.observeProject(project.slug, project.root, input);
        if (await tryBeginPendingHandoff(project.slug)) {
          if (peerBlockersQueued.delete(project.slug)) {
            await drainSupervisorMailbox(project.slug);
          }
          return;
        }
        if (peerBlockersQueued.delete(project.slug)) {
          // A context-ceiling blocker lives on the Lead slice alone (ADR 0053
          // Decision 2) — there is no Supervisor batch to drain anymore.
          await drainLeadMailbox(project.slug);
        }
      } catch (error) { log(`Peer handoff observation deferred: ${messageOf(error)}`); }
    });
  };
  const sweepPeers = async (): Promise<void> => {
    for (const project of listProjectRegistrations(deps.stateDir)) await observePeers(project);
  };
  const onLeadTurnEnded = async (input: LeadTurnEndedInput): Promise<void> => {
    for (const project of listProjectRegistrations(deps.stateDir)) {
      if (project.lead !== input.agentId && project.supervisor !== input.agentId) await observePeers(project, input);
    }
    // Which Project's Lead or Supervisor ended a turn: the registry's durable binding names it.
    let ownedLead: { slug: string; root: string } | undefined;
    let ownedSupervisor: { slug: string; root: string } | undefined;
    for (const registration of listProjectRegistrations(deps.stateDir)) {
      if (registration.lead === input.agentId) {
        ownedLead = { slug: registration.slug, root: registration.root };
      } else {
        try {
          const state = readLeadMailbox(mailboxPath(registration.slug));
          if (state.inFlight?.toAgentId === input.agentId) {
            ownedLead = { slug: registration.slug, root: registration.root };
          }
        } catch {
          // ignore unreadable mailbox during lookup
        }
      }
      if (registration.supervisor === input.agentId) {
        ownedSupervisor = { slug: registration.slug, root: registration.root };
      } else {
        try {
          const state = readLeadMailbox(mailboxPath(registration.slug));
          if (state.supervisorInFlight?.toAgentId === input.agentId) {
            ownedSupervisor = { slug: registration.slug, root: registration.root };
          }
        } catch {
          // ignore unreadable mailbox during lookup
        }
      }
    }
    if (ownedSupervisor !== undefined) {
      const { slug } = ownedSupervisor;
      await projectLane(slug, async () => {
        try {
          if (await supervisorHandoff.turnEnded(slug, input.agentId, lastAssistantText(input.timeline), input.outcome.kind === "completed")) return;
          const path = mailboxPath(slug);
          const state = readLeadMailbox(path);
          let retryingFailedSupervisorBatch = false;
          if (input.outcome.kind === "completed") {
            inFlightKickoffAgentIds.delete(input.agentId);
            failedFirstTurnAgentIds.delete(input.agentId);
          } else if (inFlightKickoffAgentIds.delete(input.agentId)) {
            kickoffSentAgentIds.delete(input.agentId);
            failedFirstTurnAgentIds.add(input.agentId);
          }
          if (state.supervisorInFlight !== null && state.supervisorInFlight.toAgentId === input.agentId) {
            const mailIds = state.supervisorInFlight.items.map((item) => item.mailId);
            if (input.outcome.kind === "completed") {
              appendMailAcked(path, {
                to: "supervisor",
                deliveryId: state.supervisorInFlight.deliveryId,
                mailIds,
                byAgentId: input.agentId,
              });
              clearRetriedFailedBatch(slug, "supervisor", mailIds);
            } else {
              appendMailRequeued(path, {
                to: "supervisor",
                deliveryId: state.supervisorInFlight.deliveryId,
                mailIds,
                reason: input.outcome.kind,
              });
              if (!claimFailedBatchRetry(slug, "supervisor", mailIds, input.outcome.kind)) {
                return;
              }
              retryingFailedSupervisorBatch = true;
            }
          }
          if (input.outcome.kind !== "completed" && !retryingFailedSupervisorBatch) {
            return;
          }
          // v0.6.1 (ADR 0057 §5): a failed Supervisor turn requeues and retries
          // the batch against the re-resolved live Supervisor — it never
          // creates a replacement seat; with none live the mail holds queued.
          await drainSupervisorMailbox(slug);
        } catch (err) {
          log(`lead-mailbox: turn boundary of ${slug}'s supervisor failed — the state stands, mail is held (${messageOf(err)})`);
        }
      });
    }
    if (ownedLead === undefined) return; // not a registered Lead's turn — none of this machine's business
    const { slug, root } = ownedLead;
    await projectLane(slug, async () => {
      try {
        await settleTurnAndRotate(slug, root, input);
      } catch (err) {
        log(`lead-mailbox: turn boundary of ${slug}'s lead failed — the state stands, mail is held (${messageOf(err)})`);
      }
    });
  };

  /** The machine's own body — runs inside the lane. */
  const settleTurnAndRotate = async (slug: string, root: string, input: LeadTurnEndedInput): Promise<void> => {
    const path = mailboxPath(slug);
    // (1) Settle the in-flight batch first: `mail_acked` on completed,
    // `mail_requeued` (reason = the outcome kind) otherwise — zero mail lost.
    const state = readLeadMailbox(path);
    let retryingFailedLeadBatch = false;
    if (state.inFlight !== null && state.inFlight.toAgentId === input.agentId) {
      const mailIds = state.inFlight.items.map((item) => item.mailId);
      if (input.outcome.kind === "completed") {
        appendMailAcked(path, { deliveryId: state.inFlight.deliveryId, mailIds, byAgentId: input.agentId });
        clearRetriedFailedBatch(slug, "lead", mailIds);
      } else {
        appendMailRequeued(path, { deliveryId: state.inFlight.deliveryId, mailIds, reason: input.outcome.kind });
        if (!claimFailedBatchRetry(slug, "lead", mailIds, input.outcome.kind)) {
          const failedHandoff = inFlightHandoffByAgentId.get(input.agentId);
          if (failedHandoff !== undefined) {
            inFlightHandoffByAgentId.delete(input.agentId);
            pendingHandoffByAgentId.set(input.agentId, failedHandoff);
          }
          if (inFlightKickoffAgentIds.delete(input.agentId)) {
            kickoffSentAgentIds.delete(input.agentId);
            failedFirstTurnAgentIds.add(input.agentId);
          }
          return;
        }
        retryingFailedLeadBatch = true;
      }
    }
    lastLeadTurnAt.set(input.agentId, new Date().toISOString());
    const rotation = readRotationState(slug);
    if (rotation === "handing_over") {
      // (2) The outgoing Lead just finished its Handoff Extraction turn. Only
      // a `completed` turn completes the handoff (v0.2.2, ADR 0050 Decision 2):
      // a `failed`/`canceled` extraction (user stop, provider drop) keeps the
      // lock, keeps every mail item queued, and clears the outstanding-send
      // marker so the next pump re-sends the fixed extraction prompt to the
      // seat-ready Lead within the episode's send cap.
      if (input.outcome.kind === "failed" && progressOf(slug)?.reason !== "context-mark" && progressOf(slug) !== null) {
        await completeHandoff(slug, root, { ...input, fuseReason: "extraction-send-failed" }); return;
      }
      if (input.outcome.kind !== "completed") {
        extractionOutstandingBySlug.delete(slug);
        log(`lead-mailbox: ${slug}'s handoff extraction turn ${input.outcome.kind} — handing_over holds and the extraction prompt re-sends on the next pump`);
        return;
      }
      await completeHandoff(slug, root, input);
      return;
    }
    if (input.outcome.kind === "completed") {
      inFlightHandoffByAgentId.delete(input.agentId);
      inFlightKickoffAgentIds.delete(input.agentId);
      failedFirstTurnAgentIds.delete(input.agentId);
    } else {
      const failedHandoff = inFlightHandoffByAgentId.get(input.agentId);
      if (failedHandoff !== undefined) {
        inFlightHandoffByAgentId.delete(input.agentId);
        pendingHandoffByAgentId.set(input.agentId, failedHandoff);
      }
      if (inFlightKickoffAgentIds.delete(input.agentId)) {
        kickoffSentAgentIds.delete(input.agentId);
        failedFirstTurnAgentIds.add(input.agentId);
      }
    }
    // The boundary sensor reading — best effort; the pending state alone also arms.
    let usedTokens: number | null = null;
    try {
      const lead = await liveLeadAgent(resolveDaemon(), slug);
      if (lead !== undefined) usedTokens = readLeadContextTokens(lead, deps.usagePaths).usedTokens;
    } catch {
      // a sensor miss never blocks the machine
    }
    if ((usedTokens ?? 0) >= LEAD_ROTATE_TOKENS || rotation === "rotation_pending") {
      // (3) Over threshold at the boundary (v0.0.93, ADR 0031 Quiet-Point
      // Succession): durably mark `rotation_pending` first, then begin the
      // handoff only at a quiet point. While any unaccepted Task's Peer is
      // running (`projectPeerInFlight`), the outgoing Lead stays the live,
      // visible seat and every incoming mail item stays `mail_queued` — the
      // Peer's own terminal `notifyPeer` pump starts the handoff the moment
      // the wave settles.
      writeRotationState(slug, root, { rotationState: "rotation_pending" });
      updateProgress(slug, { state: "scheduled" });
      if (await projectPeerInFlight(slug)) {
        log(`lead-mailbox: ${slug}'s lead rotation held in rotation_pending — a Task Peer is still running, the outgoing Lead stays live`);
        return;
      }
      await beginHandoff(slug, root);
      return;
    }
    if (input.outcome.kind !== "completed" && !retryingFailedLeadBatch) {
      return;
    }
    // (4) Normal and under threshold: self-heal on 1-shot retry, then drain.
    if (retryingFailedLeadBatch && root) {
      const carriedHandoff = pendingHandoffByAgentId.get(input.agentId);
      const ensured = await deps.ensureLead({ projectRoot: root });
      if (ensured.ok && carriedHandoff !== undefined && ensured.agentId !== input.agentId) {
        pendingHandoffByAgentId.delete(input.agentId);
        pendingHandoffByAgentId.set(ensured.agentId, carriedHandoff);
      }
    }
    await drainLeadMailbox(slug);
  };

  /** Arm 3 — lock the mailbox (holding all mail), then steer the one bounded Handoff Extraction prompt (with Fuse 1 immediate bypass). */
  const beginHandoff = async (slug: string, root: string): Promise<void> => {
    updateProgress(slug, { state: "handing-over", waitingPeers: undefined });
    const handoffRequestedAt = new Date().toISOString();
    // Persist the snapshot before the outgoing seat can overwrite its previous handoff.
    const prior = readDiskHandoffText(slug);
    atomicJson(extractionPath(slug), { requestedAt: handoffRequestedAt, prior: validHandoffText(prior) ? prior : undefined, stale: false, sends: 1 });
    handingOverBySlug.add(slug);
    writeRotationState(slug, root, { rotationState: "handing_over", handoffRequestedAt });
    let lead: SurfaceAgentSnapshot | undefined;
    try {
      lead = await liveLeadAgent(resolveDaemon(), slug);
    } catch {
      lead = undefined;
    }
    if (lead === undefined || lead.status === "error") {
      log(
        `lead-mailbox: ${slug} handoff extraction bypassed (${lead === undefined ? "no live lead" : "lead in error state"}) — completing handoff immediately`,
      );
      await completeHandoff(slug, root, {
        agentId: lead?.id ?? "",
        outcome: { kind: "failed" },
        timeline: [],
        fuseReason: "extraction-send-failed",
        handoffRequestedAt,
      });
      return;
    }
    try {
      await resolveDaemon().agents.ref(lead.id).send(renderHandoffExtractionPrompt(slug, progressOf(slug)?.reason));
    } catch (err) {
      log(`lead-mailbox: ${slug} handoff extraction send failed (${messageOf(err)}) — completing handoff immediately`);
      await completeHandoff(slug, root, {
        agentId: lead.id,
        outcome: { kind: "failed" },
        timeline: [],
        fuseReason: "extraction-send-failed",
        handoffRequestedAt,
      });
      return;
    }
    log(`lead-mailbox: ${slug} locked for handoff — extraction prompt sent to ${lead.id}`);
    extractionOutstandingBySlug.add(slug);
    armHandoffTimer(slug, root);
  };

  /**
   * Arm 2 — the outgoing Lead finished its extraction turn (or a Dual-Fuse
   * safeguard tripped): read (or write, from the turn's assistant text)
   * `lead-handoff.md`, build the machine-verified roster + digest, archive the
   * outgoing Lead, spawn the successor with the three-layer kickoff, reset
   * `normal`, and drain every held mail into it. Any failure holds the lock —
   * mail waits, never drops. A completion that did not come from a `completed`
   * extraction turn (v0.2.2, ADR 0050 Decision 4) additionally appends one
   * `needs_human` mail to the Supervisor slice after the rotation finished —
   * loud about the degradation, yet blocking nothing.
   */
  const completeHandoff = async (
    slug: string,
    root: string,
    input: LeadTurnEndedInput & { fuseReason?: "extraction-send-failed" | "extraction-timeout" | "extraction-send-cap"; handoffRequestedAt?: string },
  ): Promise<void> => {
    clearHandoffTimer(slug);
    extractionOutstandingBySlug.delete(slug);
    const statePath = projectStateDir(deps.stateDir, slug);
    const handoffPath = join(statePath, "lead-handoff.md");
    const requestedAt = input.handoffRequestedAt ?? readProjectRegistration(deps.stateDir, slug)?.handoffRequestedAt;
    const requestedMs = requestedAt !== undefined ? Date.parse(requestedAt) : Number.NaN;
    const snapshot = readExtraction(slug);
    let handoffText: string | null = null;
    if (input.outcome.kind === "completed" && input.fuseReason === undefined) {
      handoffText = lastAssistantText(input.timeline);
      if (handoffText === null && input.agentId !== "") {
        try {
          const page = await resolveDaemon().agents.ref(input.agentId).timeline.refetch({ direction: "tail", limit: 20 });
          const timeline = (page.entries ?? []).flatMap(entry => {
            const item = entry.item ?? entry as { type?: string; text?: string };
            return typeof item.type === "string" ? [{ type: item.type, text: item.text }] : [];
          });
          handoffText = lastAssistantText(timeline);
        } catch { /* Native timelines are best effort. */ }
      }
    }
    if (!validHandoffText(handoffText) && input.fuseReason !== "extraction-send-failed") {
      try {
        const stat = statSync(handoffPath);
        // v0.6.1: the disk fallback reads the BODY — the file's metadata
        // header is storage, never handover prose.
        const disk = parseHandoffFile(readFileSync(handoffPath, "utf8")).body;
        if ((!Number.isFinite(requestedMs) || stat.mtimeMs + 1 >= requestedMs) &&
            !(snapshot !== undefined && snapshot.requestedAt === requestedAt && disk === snapshot.prior)) handoffText = disk;
      } catch { /* A fresh file remains a secondary fallback. */ }
    }
    let prior = snapshot !== undefined && snapshot.requestedAt === requestedAt && validHandoffText(snapshot.prior) ? snapshot.prior : undefined;
    if (prior === undefined) {
      try {
        if (Number.isFinite(requestedMs) && statSync(handoffPath).mtimeMs < requestedMs) {
          const disk = readDiskHandoffText(slug);
          if (validHandoffText(disk)) prior = disk;
        }
      } catch { /* No earlier disk handoff. */ }
    }
    const substitute = !validHandoffText(handoffText);
    const stale = false;
    if (substitute) {
      updateProgress(slug, { state: "substitute", handover: "substitute" });
      let timeline = input.timeline.map(item => item.text ?? "").filter(Boolean).slice(-6).join("\n\n");
      if (!timeline && input.agentId) try {
        const page = await resolveDaemon().agents.ref(input.agentId).timeline.refetch({ direction: "tail", limit: 6 });
        timeline = (page.entries ?? []).map(entry => { const item = entry.item ?? entry as { text?: string }; return item.text ?? ""; }).join("\n\n");
      } catch { /* timeline is best effort */ }
      const events = projectEventsOf(slug, root);
      handoffText = buildSubstituteHandover({ digest: renderLedgerDigest(events), notebook: readNotebook(projectNotebookPath(deps.stateDir, slug)), git: readHandoverGit(root), tasks: foldTasks(events).filter(task => !task.accepted).map(task => `${task.task}: ${task.status}; Attempts: ${task.attempts.length}`).join("\n"), timeline, maxBytes: LEAD_HANDOFF_MAX_BYTES });
    } else handoffText = capHandoffText(handoffText!, LEAD_HANDOFF_MAX_BYTES);
    updateProgress(slug, { handover: substitute ? "substitute" : "extracted" });
    atomicJson(extractionPath(slug), { requestedAt, prior, stale, ...(snapshot?.sends === undefined ? {} : { sends: snapshot.sends }) });
    try {
      mkdirSync(statePath, { recursive: true });
      // v0.6.1 (ADR 0057 §11 hygiene, spec story 8): the handover file records
      // the outgoing Lead id and the written-at timestamp in a metadata header,
      // so a later successor kickoff can date it against the Lead's last
      // activity. The header is storage — every reader parses it back out and
      // only the body ever reaches a seat.
      const outgoingLeadId = readProjectRegistration(deps.stateDir, slug)?.lead ?? input.agentId;
      writeFileSync(handoffPath, renderHandoffFile(handoffText, { leadId: outgoingLeadId, writtenAt: new Date().toISOString() }));
    } catch { /* Best-effort persistence of resolved handoff text. */ }
    const events = projectEventsOf(slug, root);
    const tasks = foldTasks(events);
    const live = await liveAgentsById();
    const roster = renderPeerRoster({
      stateDir: deps.stateDir,
      slug,
      tasks,
      agents: agentOfTask(events, { stateDir: deps.stateDir, slug, tasks, live }),
      live,
      events,
    });
    const digest = renderLedgerDigest(events);
    const handoffBundle = renderSuccessorKickoff({ slug, roster, digest, handoffText, stale, reason: progressOf(slug)?.reason });
    atomicJson(extractionPath(slug), { ...readExtraction(slug), kickoff: handoffBundle });
    // The outgoing Lead's final cumulative usage is flushed BEFORE the seat
    // archives (ADR 0043 §3) — the rotated session's tokens land in the
    // Project's rollup, never lost to the archive boundary.
    if (deps.usage !== undefined) {
      const outgoingId = readProjectRegistration(deps.stateDir, slug)?.lead ?? input.agentId;
      const outgoingLead = live.get(outgoingId) ?? (await liveLeadAgent(resolveDaemon(), slug).catch(() => undefined));
      if (outgoingLead !== undefined) await deps.usage.flushAgent(outgoingLead, { slug });
    }
    const retired = await deps.retireLead({ projectRoot: root });
    if (!retired.ok && retired.code !== "no-lead") {
      log(`lead-mailbox: handoff of ${slug} could not archive the outgoing lead (${retired.code}: ${retired.error}) — the mailbox stays locked, mail holds queued`);
      return;
    }
    if (!retired.ok && retired.code === "no-lead") {
      settleLeadRotation(slug);
    }
    updateProgress(slug, { state: "creating-successor", failure: undefined });
    let ensured: EnsureLeadResult;
    try { ensured = await deps.ensureLead({ projectRoot: root }); } catch (error) { ensured = { ok: false, code: "successor-create-failed", error: messageOf(error) }; }
    if (!ensured.ok) {
      updateProgress(slug, { state: "failed", failure: ensured.error });
      log(`lead-mailbox: handoff of ${slug} could not spawn the successor (${ensured.code}: ${ensured.error}) — the mailbox stays locked, mail holds queued`);
      return;
    }
    pendingHandoffByAgentId.set(ensured.agentId, handoffBundle);
    handingOverBySlug.delete(slug);
    writeRotationState(slug, root, { rotationState: "normal", handoffRequestedAt: null });
    updateProgress(slug, { state: "done", waitingPeers: undefined, failure: undefined });
    await drainLeadMailbox(slug);
    const retiredLabel = retired.ok ? retired.agentId : (input.agentId || "absent-lead");
    // Loud degraded completion (v0.2.2, ADR 0050 Decision 4, amending ADR 0018
    // §3's "without paging Supervisor"): a completion that did not come from a
    // `completed` extraction turn appends exactly one `needs_human` item to the
    // Supervisor slice AFTER the rotation finished — the mail blocks nothing
    // (the successor is already kicked off and the mailbox already drained),
    // and its `requestId` keeps re-pumps from ever minting a second one.
    if (input.fuseReason !== undefined) {
      try {
        appendMailQueued(mailboxPath(slug), {
          requestId: `lead-handoff-degraded:${slug}:${ensured.agentId}`,
          to: "supervisor",
          from: "system",
          kind: "needs_human",
          text: [
            `Degraded Lead handoff of ${slug} completed — reason: ${input.fuseReason} (${DEGRADED_HANDOFF_COMPLETION_REASONS[input.fuseReason]}).`,
            substitute ? "The successor received a Plugin-built handover assembled from current Project evidence." : "The successor received the handover recovered from this extraction window.",
            `The rotation itself completed autonomously: ${retiredLabel} archived, successor ${ensured.agentId} spawned, held mail drained.`,
          ].join(" "),
        });
        await drainSupervisorMailbox(slug);
      } catch (err) {
        log(`lead-mailbox: degraded-completion notice of ${slug}'s handoff could not be queued (${messageOf(err)}) — the completed rotation stands`);
      }
    }
    log(`lead-mailbox: handoff of ${slug} complete — ${retiredLabel} archived, successor ${ensured.agentId} kickoff ${pendingHandoffByAgentId.has(ensured.agentId) ? "held for the next pump" : "delivered"}, rotation reset to normal`);
  };

  /**
   * Arms (or re-arms) the one `handing_over` fuse timer for `slug` (ADR 0018
   * §3, pause-aware since v0.2.2 / ADR 0050 Decision 3): when the window
   * elapses, the resolver — not a blind completion — decides between tripping
   * (a dead or still-`running` Lead) and re-sending (an alive `idle`/`closed`
   * Lead) within the episode's send cap.
   */
  const armHandoffTimer = (slug: string, root: string): void => {
    clearHandoffTimer(slug);
    const timer = setTimeout(() => {
      handoffTimers.delete(slug);
      void projectLane(slug, async () => {
        try {
          if (readRotationState(slug) !== "handing_over") return;
          const effectiveRoot = readProjectRegistration(deps.stateDir, slug)?.root ?? root;
          log(`lead-mailbox: ${slug} handoff extraction window elapsed after ${handoffTimeoutMs}ms — resolving the fuse`);
          await resolveHandingOverEpisode(slug, effectiveRoot);
        } catch (err) {
          log(`lead-mailbox: handoff timeout fuse of ${slug} failed — the state stands (${messageOf(err)})`);
        }
      });
    }, extractionTimeout(slug));
    timer.unref?.();
    handoffTimers.set(slug, timer);
  };

  /**
   * The pause-aware `handing_over` resolver (v0.2.2, ADR 0050 Decisions 2–3) —
   * the shared logic behind the pump's fuse arm and the scheduled timer. A
   * dead Lead (absent or `error`) or a throwing extraction send trips the
   * fuse immediately; an elapsed window that finds the Lead still `running`
   * (a genuinely hung stream) trips too — but an alive `idle`/`closed` Lead
   * (the paused-mid-extraction shape) is re-sent the fixed extraction prompt
   * within the episode's `HANDOFF_EXTRACTION_MAX_SENDS` cap, the fuse timer
   * resetting so each attempt gets its full window. At the ceiling the
   * episode completes via the degraded path — never an unbounded re-send
   * loop. A daemon read that throws holds the state (never guess a trip).
   */
  const resolveHandingOverEpisode = async (slug: string, root: string): Promise<void> => {
    const reg = readProjectRegistration(deps.stateDir, slug);
    if (reg === undefined || readRotationState(slug) !== "handing_over") return;
    const requestedAt = reg.handoffRequestedAt;
    const requestedMs = requestedAt !== undefined ? Date.parse(requestedAt) : Number.NaN;
    const elapsed = Number.isFinite(requestedMs) ? Date.now() - requestedMs : Number.POSITIVE_INFINITY;
    let lead: SurfaceAgentSnapshot | undefined;
    try {
      lead = await liveLeadAgent(resolveDaemon(), slug);
    } catch (err) {
      log(`lead-mailbox: cannot read the daemon's agents for ${slug}'s handoff fuse — the state stands (${messageOf(err)})`);
      return;
    }
    const complete = (fuseReason: "extraction-send-failed" | "extraction-timeout" | "extraction-send-cap"): Promise<void> =>
      completeHandoff(slug, reg.root ?? root, {
        agentId: reg.lead ?? lead?.id ?? "",
        outcome: { kind: "failed" },
        timeline: [],
        fuseReason,
        ...(requestedAt === undefined ? {} : { handoffRequestedAt: requestedAt }),
      });
    if (progressOf(slug)?.state === "failed") return;
    if (progressOf(slug)?.reason !== "context-mark" && progressOf(slug) !== null && elapsed >= extractionTimeout(slug)) { await complete("extraction-timeout"); return; }
    if (lead === undefined || lead.status === "error") {
      log(`lead-mailbox: ${slug} handoff extraction fuse tripped (${lead === undefined ? "no live lead" : "lead in error state"}) — completing the handoff`);
      await complete("extraction-send-failed");
      return;
    }
    if (isSeatReadyForMail(lead)) {
      // An outstanding send still inside its window is left alone — the Lead
      // may simply not have flipped to `running` on the daemon yet.
      if (extractionOutstandingBySlug.has(slug) && elapsed < extractionTimeout(slug)) return;
      const snapshot = readExtraction(slug);
      const sends = snapshot?.sends ?? 1; // a pre-v0.2.2 snapshot implies the original send
      if (sends >= HANDOFF_EXTRACTION_MAX_SENDS) {
        log(`lead-mailbox: ${slug} handoff extraction re-send cap reached (${sends} sends) — completing via the degraded path`);
        await complete("extraction-send-cap");
        return;
      }
      try {
        await resolveDaemon().agents.ref(lead.id).send(renderHandoffExtractionPrompt(slug, progressOf(slug)?.reason));
      } catch (err) {
        log(`lead-mailbox: ${slug} handoff extraction re-send failed (${messageOf(err)}) — completing handoff immediately`);
        await complete("extraction-send-failed");
        return;
      }
      const sentAt = new Date().toISOString();
      atomicJson(extractionPath(slug), { ...(snapshot ?? {}), requestedAt: sentAt, stale: false, sends: sends + 1 });
      writeRotationState(slug, reg.root ?? root, { rotationState: "handing_over", handoffRequestedAt: sentAt });
      extractionOutstandingBySlug.add(slug);
      armHandoffTimer(slug, reg.root ?? root);
      log(`lead-mailbox: ${slug} handoff extraction re-sent to ${lead.id} (send ${sends + 1} of ${HANDOFF_EXTRACTION_MAX_SENDS}) — fuse timer reset`);
      return;
    }
    if (elapsed >= extractionTimeout(slug)) {
      log(`lead-mailbox: ${slug} handoff extraction timed out (${elapsed}ms >= ${handoffTimeoutMs}ms) with the Lead still ${lead.status} — tripping fuse`);
      await complete("extraction-timeout");
    }
  };

  /** The Project's ledger slice — every event whose task's contract workspace sits inside the root (the snapshot's own scoping law; v0.0.89 per-Project isolation over the bridged stream). */
  const projectEventsOf = (slug: string, root: string): readonly LedgerEvent[] =>
    projectStreamOf(slug).filter((evt) => {
      if (!("task" in evt) || typeof evt.task !== "string") return false;
      const contract = taskFactoryOf(slug, evt.task).contractFor(evt.task);
      return contract !== undefined && (contract.workspace === root || contract.workspace.startsWith(`${root}/`));
    });

  /** Live daemon agents by id — best effort; a daemon miss renders "(not live)" statuses, never blocks the handoff. */
  const liveAgentsById = async (): Promise<Map<string, SurfaceAgentSnapshot>> => {
    const live = new Map<string, SurfaceAgentSnapshot>();
    try {
      const page = await resolveDaemon().agents.list({ filter: { includeArchived: false, includeBackground: true } });
      for (const entry of page.entries) live.set(entry.agent.id, entry.agent);
    } catch {
      // the roster renders without live statuses — the ledger half still carries it
    }
    return live;
  };

  const projectHasPeerWork = (slug: string, events: readonly LedgerEvent[], live: readonly SurfaceAgentSnapshot[]): boolean =>
    driverWaveInFlight(events, live, slug) || foldTasks(events).some(task => !task.accepted &&
      boundTaskPeers({ stateDir: deps.stateDir, slug, task: task.task, events, live }).some(peerIsRunning));

  /**
   * Ledger-first quiet-point check for `rotation_pending` (v0.0.99, ADR 0031
   * §3): once a Task's folded Ledger status in the current Contract epoch has
   * reached a Peer-terminal state (`ready-to-accept` / GREEN, `needs-human`,
   * `red` at `MAX_ATTEMPTS`, or a queued `from: "peer"` blocker in
   * `mailbox.jsonl` — a `kind: "peer_challenge"` challenge awaiting the Lead's
   * ruling or a `kind: "needs_human"` ceiling stall), the Task is in Lead's
   * court and no longer counts as having Peer work in flight — even while the
   * Peer's `agent_claim` or `agent_escalate_blocker` tool call is still
   * returning inside an active turn (`peer.status === "running"`).
   */
  const taskHasSettledPeerOutcome = (task: TaskView, queuedPeerBlockerTasks?: ReadonlySet<string>): boolean =>
    task.accepted ||
    task.status === "accepted" ||
    task.status === "closed" ||
    task.status === "ready-to-accept" ||
    task.status === "needs-human" ||
    (task.status === "red" && task.attempts.length >= MAX_ATTEMPTS) ||
    (queuedPeerBlockerTasks?.has(task.task) ?? false);

  /**
   * The quiet-point predicate for `rotation_pending` (v0.0.99/v0.0.93, ADR
   * 0031 §3). v0.2.2 (ADR 0050 §1) adds the durable in-flight arm: a Task
   * whose spawn round is still open and whose bound Peer is live on the
   * daemon and not `error` (`running`, `initializing`, `idle`, `closed`
   * alike) holds the rotation — the judgment reads only the ledger,
   * `mailbox.jsonl`, and the live daemon snapshot, so daemon restarts,
   * plugin updates, and reboots cannot dissolve the hold. Tasks whose
   * folded status is Peer-terminal or that carry queued `from: "peer"` mail
   * (verdict or blocker — the work is back in the Lead's court) never hold.
   * The `interruptedPeerIds` turn-event marker remains an accelerator only.
   */
  const projectPeerInFlight = async (slug: string): Promise<boolean> => {
    const reg = readProjectRegistration(deps.stateDir, slug);
    if (reg?.root === undefined) return false;
    const events = projectEventsOf(slug, reg.root);
    const tasks = foldTasks(events);
    let queuedPeerBlockerTasks: Set<string> | undefined;
    let queuedPeerMailTasks: Set<string> | undefined;
    try {
      const mailbox = readLeadMailbox(mailboxPath(slug));
      const queuedPeerMail = mailbox.queued.filter((item) => item.from === "peer" && typeof item.task === "string");
      queuedPeerBlockerTasks = new Set(queuedPeerMail.filter((item) => item.kind === "needs_human" || item.kind === "peer_challenge").map((item) => item.task!));
      queuedPeerMailTasks = new Set(queuedPeerMail.map((item) => item.task!));
    } catch {
      queuedPeerBlockerTasks = undefined;
      queuedPeerMailTasks = undefined;
    }
    const settledTasks = new Set(
      tasks.filter((task) => taskHasSettledPeerOutcome(task, queuedPeerBlockerTasks)).map((task) => task.task),
    );
    const live = [...(await liveAgentsById()).values()];
    const activeWaveEvents = settledTasks.size > 0 || (queuedPeerMailTasks?.size ?? 0) > 0
      ? events.filter(
          (evt) =>
            !("task" in evt) ||
            typeof evt.task !== "string" ||
            (!settledTasks.has(evt.task) && !(queuedPeerMailTasks?.has(evt.task) ?? false)),
        )
      : events;
    if (driverWaveInFlight(activeWaveEvents, live, slug, "live")) return true;
    return tasks.some(
      (task) =>
        !settledTasks.has(task.task) &&
        boundTaskPeers({ stateDir: deps.stateDir, slug, task: task.task, events, live }).some(
          (peer) => peerIsRunning(peer) || (peer.status === "idle" && interruptedPeerIds.has(peer.id)),
        ),
    );
  };

  /** Resolves `--workspace` or `--project` to `{ root, slug }` or a structured `unknown-project` refusal. */
  const resolveTargetProject = (
    request: { id: string; workspace?: string; project?: string },
    verb: string,
  ): { ok: true; root: string; slug: string } | Extract<SpoolReply, { ok: false }> => {
    if (request.workspace !== undefined) {
      const resolved = resolveProject(request.workspace);
      if (!resolved.ok) {
        return {
          id: request.id,
          ok: false,
          code: "unknown-project",
          message: `workspace ${request.workspace} does not resolve to a git repository — ${resolved.reason}`,
        };
      }
      return { ok: true, root: resolved.root, slug: resolved.slug };
    }
    if (request.project !== undefined) {
      const registration: ProjectRegistration | undefined = readProjectRegistration(deps.stateDir, request.project);
      if (registration === undefined) {
        return {
          id: request.id,
          ok: false,
          code: "unknown-project",
          message: `no project registered under slug ${request.project} — pass --workspace <dir>, or seat the project first`,
        };
      }
      return { ok: true, root: registration.root, slug: registration.slug };
    }
    return {
      id: request.id,
      ok: false,
      code: "unknown-project",
      message: `${verb} needs a target — pass --project <slug> or --workspace <dir>`,
    };
  };

  /** The spool's `lead_dispatch` handler (ADR 0013 Decision 4, bullet 3). */
  const dispatchLead = async (request: SpoolLeadDispatchRequest, options?: { existingDesignSnapshot: true }): Promise<SpoolReply> => {
    const target = resolveTargetProject(request, "lead dispatch");
    if (!target.ok) return target;
    const { root, slug } = target;
    if (request.from !== "peer" && !options?.existingDesignSnapshot) await prepareOpenDesignDispatch({ state: deps.stateDir, slug, root, requestId: request.id, userHome: deps.home ? resolveVaultUserHome(deps.home) : undefined });
    // The auto-ensure and the queue land as ONE lane job — the single-writer
    // law this module's header claims: two concurrent dispatches serialize,
    // so the second sees the first's Lead and never double-creates the seat,
    // and a dispatch racing a handoff completion queues behind it (the
    // machine's own ensure calls already run inside their lane).
    const laneOutcome = await projectLane(
      slug,
      async (): Promise<{ ok: true; agentId: string; mailId: string } | { ok: false; code: string; error: string }> => {
        if (request.from === "supervisor") {
          commitSeatMemoryOnRoot(root);
        }
        // The blocker's task is the caller's own (correlation first, the
        // field second).
        const blockerTask =
          request.task ??
          readCorrelations(deps.stateDir).find((r) => r.correlationId === request.submitter || r.agentId === request.submitter)?.task;
        const ensured = await deps.ensureLead({ projectRoot: root });
        if (!ensured.ok) return ensured;
        const from = request.from ?? "owner";
        // ADR 0053 Decision 2 / spec Decision 6: a Peer challenge
        // (`REOPEN_REQUEST` / `DEPENDENCY_REQUEST` / `BLOCKED` via
        // `agent_escalate_blocker`) is a technical reconciliation turn between
        // Peer and Lead — queued `to: "lead"` as `peer_challenge`, never
        // mislabeled `needs_human` (that Ledger fact is the Lead's alone to
        // record through `lead_needs_human`).
        const kind = from === "peer" ? "peer_challenge" : "directive";
        const queued = appendMailQueued(mailboxPath(slug), { ...(from === "peer" ? { to: "lead" as const } : {}), from, kind, ...(from === "peer" && blockerTask !== undefined ? { task: blockerTask } : {}), text: request.message });
        return { ok: true, agentId: ensured.agentId, mailId: queued.mailId };
      },
    );
    if (!laneOutcome.ok) return { id: request.id, ok: false, code: laneOutcome.code, message: laneOutcome.error };
    const { agentId, mailId } = laneOutcome;
    // The directive is queued — the lane pumps it.
    await pumpProjectLead(slug);
    const rotationState = readRotationState(slug);
    const finalAgentId = readProjectRegistration(deps.stateDir, slug)?.lead ?? agentId;
    return {
      id: request.id,
      ok: true,
      summary: `dispatched to the lead of ${slug} — agent=${finalAgentId} mail=${mailId} rotation=${rotationState}`,
      project: slug,
      leadAgentId: finalAgentId,
      mailId,
      rotationState,
    };
  };

  /**
   * The spool's `supervisor_dispatch` handler (v0.0.23, ADR 0015 §5; v0.6.1,
   * ADR 0057 §5):
   * - If `request.seat === "supervisor"`, routes transparently to `dispatchLead`
   *   (`to: "lead"`, `from: "supervisor"`) and tells `Supervisor` to end its
   *   turn immediately and wait for `Lead`'s report.
   * - Otherwise enqueues `to: "supervisor"` (`from: "owner"`, `kind:
   *   "directive"`), pumps `Supervisor`, and tells the normal chat caller to
   *   stop its turn immediately without editing files. The plugin never
   *   creates a Supervisor here (v0.6.1, ADR 0057 §5): with no live Supervisor
   *   the directive is held for the next one, and the reply says so.
   */
  const dispatchSupervisor = async (request: SpoolSupervisorDispatchRequest): Promise<SpoolReply> => {
    if (request.seat === "supervisor") {
      const leadReply = await dispatchLead({
        id: request.id,
        kind: "lead_dispatch",
        ...(request.project === undefined ? {} : { project: request.project }),
        ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
        from: "supervisor",
        message: request.message,
        seat: "supervisor",
      });
      if (!leadReply.ok) return leadReply;
      return {
        ...leadReply,
        summary: `directive dispatched to Lead (${leadReply.leadAgentId ?? "lead"}) — end your turn now and wait for Lead's report`,
      };
    }
    const target = resolveTargetProject(request, "supervisor dispatch");
    if (!target.ok) return target;
    const { root, slug } = target;
    await prepareOpenDesignDispatch({ state: deps.stateDir, slug, root, requestId: request.id, userHome: deps.home ? resolveVaultUserHome(deps.home) : undefined });
    const laneOutcome = await projectLane(slug, async (): Promise<{ ok: true; mailId: string } | { ok: false; code: string; error: string }> => {
      // v0.6.1 (ADR 0057 §5): resolve-only. An absent Supervisor holds the mail;
      // the queue-time resolution below is informational — every send re-resolves.
      let live: SurfaceAgentSnapshot | undefined;
      try {
        live = await liveSupervisorAgent(resolveDaemon(), slug);
      } catch {
        live = undefined;
      }
      const submitter = typeof request.submitter === "string" ? request.submitter.trim() : "";
      if (
        submitter !== "" &&
        submitter !== "owner" &&
        submitter !== "supervisor" &&
        submitter !== "lead" &&
        submitter !== "agent" &&
        submitter !== "ui"
      ) {
        const reg = readProjectRegistration(deps.stateDir, slug);
        if (submitter !== live?.id && submitter !== reg?.supervisor && submitter !== reg?.lead) {
          writeProjectRegistration(deps.stateDir, slug, {
            root: reg?.root ?? root,
            dispatchers: [submitter],
          });
        }
      }
      const queued = appendMailQueued(mailboxPath(slug), {
        to: "supervisor",
        from: "owner",
        kind: "directive",
        text: request.message,
      });
      return { ok: true, mailId: queued.mailId };
    });
    if (!laneOutcome.ok) return { id: request.id, ok: false, code: laneOutcome.code, message: laneOutcome.error };
    const { mailId } = laneOutcome;
    await pumpProjectSupervisor(slug);
    // The recipient is re-resolved after the pump — the id that holds the
    // batch now, never a stale binding (ADR 0057 §5, "re-resolved at every send").
    const routed = await liveSupervisorAgent(resolveDaemon(), slug).catch(() => undefined);
    return routed === undefined
      ? {
          id: request.id,
          ok: true,
          summary: `directive held for Supervisor — none is live for ${slug}; it delivers to the next Supervisor (the Factory panel's Needs you says so) — stop this turn immediately without editing files`,
          project: slug,
          mailId,
        }
      : {
          id: request.id,
          ok: true,
          summary: `directive routed to Supervisor (${routed.id}) — stop this turn immediately without editing files and open the Supervisor session`,
          project: slug,
          supervisorAgentId: routed.id,
          mailId,
        };
  };

  /**
   * The spool's `supervisor_report` handler (v0.0.23, ADR 0015 §3; v0.6.1,
   * ADR 0057 §5): enqueues `to: "supervisor"` (`from: "lead"`, `kind:
   * "report"`), pumps `Supervisor`, and returns `supervisorAgentId` + `mailId`.
   * The plugin never creates a Supervisor from a Lead report (v0.6.1, ADR
   * 0057 §5): with no live Supervisor the report is held for the next one and
   * the reply says so — the Lead's report never vanishes and never spawns a
   * hidden seat.
   */
  const reportSupervisor = async (request: SpoolSupervisorReportRequest): Promise<SpoolReply> => {
    const target = resolveTargetProject(request, "supervisor report");
    if (!target.ok) return target;
    const { slug } = target;
    const laneOutcome = await projectLane(slug, async (): Promise<{ ok: true; mailId: string } | { ok: false; code: string; error: string }> => {
      const queued = appendMailQueued(mailboxPath(slug), {
        to: "supervisor",
        from: "lead",
        kind: "report",
        text: request.message,
      });
      return { ok: true, mailId: queued.mailId };
    });
    if (!laneOutcome.ok) return { id: request.id, ok: false, code: laneOutcome.code, message: laneOutcome.error };
    const { mailId } = laneOutcome;
    await pumpProjectSupervisor(slug);
    // Re-resolved after the pump — the seat that holds the report now.
    const routed = await liveSupervisorAgent(resolveDaemon(), slug).catch(() => undefined);
    return routed === undefined
      ? {
          id: request.id,
          ok: true,
          summary: `report held for Supervisor — none is live for ${slug}; it delivers to the next Supervisor after its kickoff — end your turn`,
          project: slug,
          mailId,
        }
      : {
          id: request.id,
          ok: true,
          summary: `report queued for Supervisor (${routed.id}) — end your turn`,
          project: slug,
          supervisorAgentId: routed.id,
          mailId,
        };
  };

  /**
   * The spool's peer hook: a Task's terminal outcome lands as `from: "peer"`
   * mail on the owning Project's lane — appended durably BEFORE any delivery
   * decision, so no regime (driver-held or not) can lose it. ADR 0053
   * Decision 2 / spec Decision 6: verdicts and `needs_human` stalls route
   * exclusively to the Lead mailbox — no `to: "supervisor"` duplicate is ever
   * enqueued and `Supervisor` is never pumped by Peer-originated mail (it
   * hears through `lead_report_to_supervisor` alone). The Lead pump is
   * suppressed while a synchronous CLI Driver wave is in flight; the wave's
   * last terminal outcome clears the predicate and its own hook pumps the
   * whole held batch as one consolidated delivery. Never rejects.
   */
  const notifyPeer = async (input: { task: string; kind: "verdict" | "needs_human"; text: string }): Promise<void> => {
    try {
      // The task-owning stream (v0.0.89): the Contract lives in the OWNING
      // Project's Factory — the wired Factory first (it may still own the task
      // itself, the legacy root bridge), then the registry's Projects. The
      // first owner wins (a colliding Task id notifies one Project, never both).
      let owning = deps.factory.contractFor(input.task) !== undefined ? deps.factory.ledger.events : undefined;
      if (owning === undefined) {
        for (const slug of registry.slugs()) {
          try {
            const factory = registry.factoryForProject(slug);
            if (factory.contractFor(input.task) !== undefined) {
              owning = factory.ledger.events;
              break;
            }
          } catch {
            // an unopenable Project Ledger is skipped — the search continues
          }
        }
      }
      const workspace = contractWorkspaceOf(owning ?? deps.factory.ledger.events, input.task);
      if (workspace === undefined) return; // no contract on record — no owning Project to notify
      const resolved = ensureProjectRegistered(deps.stateDir, workspace);
      if (!resolved.ok) return;
      await enqueueLeadMail(resolved.slug, { from: "peer", kind: input.kind, task: input.task, text: input.text });
      let liveAgents: SurfaceAgentSnapshot[] | undefined;
      try {
        const listed = await resolveDaemon().agents.list({ filter: { includeArchived: false, includeBackground: true } });
        liveAgents = listed.entries.map((entry) => entry.agent).filter((agent) => agent.archivedAt === null);
      } catch {
        // best-effort live agent inspection for dead/orphaned worktree spawn rounds
      }
      if (driverWaveInFlight(projectEventsOf(resolved.slug, resolved.root), liveAgents, resolved.slug)) return; // held in mailbox.jsonl — the wave's last outcome pumps it
      await pumpProjectLead(resolved.slug);
    } catch (err) {
      log(`lead-mailbox: peer notification for ${input.task} failed — the outcome stays in the ledger (${messageOf(err)})`);
    }
  };

  /**
   * Startup recovery (ADR 0013 Decision 3's restart rule): every registered
   * Project's mailbox gets its un-acked delivery requeued with reason
   * `"daemon-restart"`. Idempotent by the core's own law — a settled mailbox
   * appends nothing.
   */
  const startupRecovery = (): void => {
    for (const registration of listProjectRegistrations(deps.stateDir)) {
      try {
        if (registration.rotationState && registration.rotationState !== "normal" && progressOf(registration.slug) === null) updateProgress(registration.slug, { reason: "context-mark", state: registration.rotationState === "rotation_pending" ? "scheduled" : "handing-over" });
        const settled = recoverLeadMailbox(mailboxPath(registration.slug), "daemon-restart");
        for (const event of settled) {
          log(`lead-mailbox: recovered ${event.mailIds.length} item(s) of ${registration.slug} — requeued (daemon-restart)`);
        }
      } catch (err) {
        log(`lead-mailbox: recovery of ${registration.slug} failed — ${messageOf(err)}`);
      }
    }
  };

  /**
   * Pump all registered Projects' Lead and Supervisor lanes once the daemon
   * API is captured at boot, so mail requeued by `startupRecovery()` or queued
   * by an early spool drain (before `paseoApi` arrived) delivers immediately.
   */
  const pumpAll = async (): Promise<void> => {
    for (const registration of listProjectRegistrations(deps.stateDir)) {
      try { await pumpProjectLead(registration.slug); } catch (error) { log(`lead mailbox of ${registration.slug} deferred: ${messageOf(error)}`); }
      try { await pumpProjectSupervisor(registration.slug); } catch (error) { log(`supervisor mailbox of ${registration.slug} deferred: ${messageOf(error)}`); }
    }
  };

  /**
   * The rotation settle (ADR 0013 Decision 3's last arm, wired through the
   * surface's `onLeadRetired` door): a Lead retired while a delivery is live
   * can never receive its turn-end ack, so any un-acked `inFlight` batch
   * returns to `queued` as one `mail_requeued` (`reason: "lead-rotated"`).
   * Synchronous by the core's own read-then-append law — every append is one
   * atomic read-then-write on the single JS thread, so the settle is safe
   * from any caller (the surface's off-lane rotate doors and the handoff's
   * in-lane retireLead alike; the handoff arm is a no-op by construction —
   * `settleTurnAndRotate` settles before `completeHandoff` retires).
   * Idempotent: a settled mailbox appends nothing.
   */
  const settleLeadRotation = (slug: string): void => {
    const reg = readProjectRegistration(deps.stateDir, slug);
    if (reg?.lead !== undefined) {
      kickoffSentAgentIds.delete(reg.lead);
      inFlightKickoffAgentIds.delete(reg.lead);
      failedFirstTurnAgentIds.delete(reg.lead);
      pendingHandoffByAgentId.delete(reg.lead);
      inFlightHandoffByAgentId.delete(reg.lead);
    }
    const settled = recoverLeadMailbox(mailboxPath(slug), "lead-rotated", "lead");
    for (const event of settled) {
      log(`lead-mailbox: rotation of ${slug} requeued ${event.mailIds.length} item(s) — the un-acked delivery returns to queued (lead-rotated)`);
    }
  };

  /**
   * The plugin's own archive markers (v0.6.1, ADR 0057 §4) — see
   * `markPluginArchive`. v0.6.1 review fix: the set PERSISTS at
   * `<stateDir>/plugin-archive-markers.json`, because the daemon can deliver
   * its `agent.archive.after` after a plugin restart — an in-memory set would
   * misread the plugin's own archive as a lost Lead. A marker whose archive
   * call FAILS is cleared (`clearPluginArchive`), so it can never swallow a
   * later genuine outside archive of the same id.
   */
  const pluginArchivedAgentIdsPath = join(deps.stateDir, "plugin-archive-markers.json");
  const readPluginArchivedAgentIds = (): Set<string> => {
    try {
      const parsed = readOptionalJson(pluginArchivedAgentIdsPath);
      return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "") : []);
    } catch {
      return new Set(); // an unreadable marker file reads as empty — recovery, never a crash
    }
  };
  const persistPluginArchivedAgentIds = (ids: Set<string>): void => {
    try {
      atomicJson(pluginArchivedAgentIdsPath, [...ids]);
    } catch (err) {
      log(`lead-mailbox: persisting archive markers failed (${messageOf(err)}) — the in-memory set stands for this lifetime`);
    }
  };
  const pluginArchivedAgentIds = readPluginArchivedAgentIds();
  const markPluginArchive = (agentId: string): void => {
    if (typeof agentId === "string" && agentId.trim() !== "") {
      pluginArchivedAgentIds.add(agentId.trim());
      persistPluginArchivedAgentIds(pluginArchivedAgentIds);
    }
  };
  const clearPluginArchive = (agentId: string): void => {
    const trimmed = typeof agentId === "string" ? agentId.trim() : "";
    if (trimmed !== "" && pluginArchivedAgentIds.delete(trimmed)) {
      persistPluginArchivedAgentIds(pluginArchivedAgentIds);
    }
  };

  /**
   * The lost-Lead door (v0.6.1, ADR 0057 §4) — the body behind the shell's
   * `agent.archive.after` registration. An outside archive of a registered
   * Lead: (1) clears the binding so nothing routes to a dead seat, (2)
   * requeues the delivered-but-unacked batch (`mail_requeued`,
   * `reason: "lead_lost"`), (3) marks the on-disk handover stale-unknown so
   * the successor's kickoff carries the staleness line, (3b) settles every
   * released Supervisor waiting on this Lead (the cascade risk died with it),
   * and (4) pumps — the
   * normal succession path (`drainLeadMailbox`'s ensure arm) creates the
   * successor. A plugin archive (marked beforehand) is consumed and skipped.
   */
  const onAgentArchived = async (input: { agentId: string }): Promise<void> => {
    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    if (agentId === "") return;
    if (pluginArchivedAgentIds.has(agentId)) {
      clearPluginArchive(agentId);
      return; // the plugin's own archive — never a lost Lead
    }
    for (const registration of listProjectRegistrations(deps.stateDir)) {
      if (registration.lead !== agentId) continue;
      await projectLane(registration.slug, async () => {
        try {
          // (1) The binding clears — the mailbox never routes to a dead Lead.
          writeProjectRegistration(deps.stateDir, registration.slug, { root: registration.root, lead: null });
          kickoffSentAgentIds.delete(agentId);
          inFlightKickoffAgentIds.delete(agentId);
          failedFirstTurnAgentIds.delete(agentId);
          pendingHandoffByAgentId.delete(agentId);
          inFlightHandoffByAgentId.delete(agentId);
          // (2) Delivered-but-unacked mail returns to queued.
          const settled = recoverLeadMailbox(mailboxPath(registration.slug), "lead_lost", "lead");
          for (const event of settled) {
            log(
              `lead-mailbox: ${registration.slug}'s lead ${agentId} was archived outside the plugin — requeued ${event.mailIds.length} item(s) (lead_lost), the next pump raises a successor`,
            );
          }
          // (3) v0.6.1 (ADR 0057 §11 hygiene, spec story 8): the loss stamps
          // `leadLostAt` — the anchor the successor kickoff dates the on-disk
          // handover's metadata against (older-than-loss ⇒ the dated staleness
          // line; no metadata ⇒ stale-unknown). No blanket `stale: true`
          // anymore: the file's own written-at decides.
          const disk = readDiskHandoffFile(registration.slug);
          const lastTurnAt = lastLeadTurnAt.get(agentId);
          const fresh = disk?.meta !== undefined && lastTurnAt !== undefined && Date.parse(disk.meta.writtenAt) >= Date.parse(lastTurnAt);
          if (!fresh) {
            const events = projectEventsOf(registration.slug, registration.root);
            const body = buildSubstituteHandover({ digest: renderLedgerDigest(events), notebook: readNotebook(projectNotebookPath(deps.stateDir, registration.slug)), git: readHandoverGit(registration.root), tasks: foldTasks(events).filter(task => !task.accepted).map(task => `${task.task}: ${task.status}; Attempts: ${task.attempts.length}`).join("\n"), timeline: "(outgoing Lead was archived)", maxBytes: LEAD_HANDOFF_MAX_BYTES });
            mkdirSync(projectStateDir(deps.stateDir, registration.slug), { recursive: true });
            writeFileSync(join(projectStateDir(deps.stateDir, registration.slug), "lead-handoff.md"), renderHandoffFile(body, { leadId: agentId, writtenAt: new Date().toISOString() }));
          }
          const priorExtraction = readExtraction(registration.slug);
          atomicJson(extractionPath(registration.slug), {
            ...(priorExtraction ?? {}),
            leadLostAt: lastTurnAt ?? new Date().toISOString(),
          });
          // (3b) v0.6.1 review fix (ADR 0057 §4): the same outside archive
          // settles every released Supervisor waiting on this Lead — the
          // cascade risk died with the Lead, so without this a released
          // record whose Lead never hands off through the plugin would have
          // no settlement path short of a Project reset.
          try {
            await deps.settleReleasedSupervisor?.({ slug: registration.slug, leadAgentId: agentId });
          } catch (err) {
            log(`lead-mailbox: released-supervisor settle of ${registration.slug} deferred (${messageOf(err)}) — the record stands`);
          }
          // (4) The succession pump — the ensure arm creates the successor.
          await drainLeadMailbox(registration.slug);
        } catch (err) {
          log(`lead-mailbox: lost-lead recovery of ${registration.slug} failed — mail holds queued (${messageOf(err)})`);
        }
      });
    }
  };

  const resetProjectMailbox = (slug: string): void => {
    supervisorHandoff.reset(slug);
    writeHandoffProgress(deps.stateDir, slug, null);
    peerHandoff.reset(slug);
    clearHandoffTimer(slug);
    handingOverBySlug.delete(slug);
    extractionOutstandingBySlug.delete(slug);
    const prefix = `${slug}:`;
    for (const key of [...retriedFailedMailIds]) {
      if (key.startsWith(prefix)) retriedFailedMailIds.delete(key);
    }
    const reg = readProjectRegistration(deps.stateDir, slug);
    if (reg?.lead !== undefined) {
      kickoffSentAgentIds.delete(reg.lead);
      inFlightKickoffAgentIds.delete(reg.lead);
      failedFirstTurnAgentIds.delete(reg.lead);
      pendingHandoffByAgentId.delete(reg.lead);
      inFlightHandoffByAgentId.delete(reg.lead);
    }
    if (reg?.supervisor !== undefined) {
      kickoffSentAgentIds.delete(reg.supervisor);
      inFlightKickoffAgentIds.delete(reg.supervisor);
      failedFirstTurnAgentIds.delete(reg.supervisor);
    }
    if (reg !== undefined && (reg.rotationState !== undefined || reg.handoffRequestedAt !== undefined)) {
      writeRotationState(slug, reg.root, { rotationState: null, handoffRequestedAt: null });
    }
  };

  const markKickoffSent = (agentId: string): void => {
    if (typeof agentId === "string" && agentId.trim() !== "") {
      kickoffSentAgentIds.add(agentId.trim());
    }
  };

  const hasActiveWork = async (): Promise<boolean> => {
    // Gate work remains active even after its Peer has finished its turn —
    // across EVERY Project's Ledger (v0.0.89), never the root stream alone.
    const gates = new Set<string>();
    for (const events of eventStreamsOf()) {
      for (const event of events) {
        if (event.event === "gate_started") gates.add(`${event.task}:${event.attempt}`);
        else if (event.event === "gate_finished") gates.delete(`${event.task}:${event.attempt}`);
      }
    }
    if (gates.size > 0 || handingOverBySlug.size > 0) return true;
    const projects = listProjectRegistrations(deps.stateDir);
    if (projects.some(project => supervisorHandoff.active(project.slug))) return true;
    if (projects.some(project => { const mailbox = readLeadMailbox(mailboxPath(project.slug)); return mailbox.inFlight !== null || mailbox.supervisorInFlight !== null; })) return true;
    const live = [...(await liveAgentsById()).values()];
    return projects.some(project => {
      const events = projectEventsOf(project.slug, project.root);
      return projectHasPeerWork(project.slug, events, live);
    });
  };

  const handoff = async (input: HandoffRequest): Promise<HandoffReply> => {
    if (input.seat === "supervisor") return projectLane(input.slug, () => supervisorHandoff.request(input));
    if (input.seat?.startsWith("peer:")) return projectLane(input.slug, async () => { const reg = readProjectRegistration(deps.stateDir, input.slug); if (!reg) return { ok: false, code: "unknown-project", error: "Project not registered" }; const reply = await peerHandoff.handoff(input); if (peerBlockersQueued.delete(input.slug)) await drainLeadMailbox(input.slug); return reply; });
    if ((input.seat ?? "lead") !== "lead") return { ok: false, code: "handoff-seat-unavailable", error: "This seat handoff is not available yet" };
    if (input.action === "handover") {
      const current = progressOf(input.slug); const text = readDiskHandoffText(input.slug) ?? "";
      return { ok: true, progress: current, text, source: current?.handover ?? (text.startsWith("# Plugin-built handover") ? "substitute" : "extracted") };
    }
    return projectLane(input.slug, async () => {
      const reg = readProjectRegistration(deps.stateDir, input.slug);
      if (!reg) return { ok: false, code: "unknown-project", error: "Project not registered" };
      const current = progressOf(input.slug);
      if (input.action === "cancel") {
        if (readRotationState(input.slug) !== "rotation_pending") return { ok: false, code: "handoff-not-scheduled", error: "Only a scheduled handoff can be canceled" };
        if (current?.reason === "provider-change") saveLanes(deps.stateDir, { lead: laneValue(current.fromLane) }, input.slug);
        writeRotationState(input.slug, reg.root, { rotationState: "normal", handoffRequestedAt: null });
        writeHandoffProgress(deps.stateDir, input.slug, null);
        await drainLeadMailbox(input.slug);
        return { ok: true, progress: null };
      }
      if (input.action === "retry") {
        if (current?.state !== "failed") return { ok: false, code: "handoff-not-failed", error: "Only a failed handoff can be retried" };
        updateProgress(input.slug, { state: "creating-successor", failure: undefined });
        const ensured = await deps.ensureLead({ projectRoot: reg.root }).catch(error => ({ ok: false as const, code: "successor-create-failed", error: messageOf(error) }));
        if (!ensured.ok) updateProgress(input.slug, { state: "failed", failure: ensured.error });
        else {
          const events = projectEventsOf(input.slug, reg.root);
          pendingHandoffByAgentId.set(ensured.agentId, readExtraction(input.slug)?.kickoff ?? renderSuccessorKickoff({ slug: input.slug, roster: "(no live roster available)", digest: renderLedgerDigest(events), handoffText: readDiskHandoffText(input.slug) ?? "", stale: false, reason: current.reason }));
          handingOverBySlug.delete(input.slug); writeRotationState(input.slug, reg.root, { rotationState: "normal", handoffRequestedAt: null });
          await drainLeadMailbox(input.slug); updateProgress(input.slug, { state: "done" });
        }
        return { ok: true, progress: progressOf(input.slug) };
      }
      if (input.reason === "provider-change" && current && current.state !== "done") return { ok: false, code: "handoff-in-progress", error: "A handoff is already active; cancel it before choosing a different provider" };
      if (current && !["done", "scheduled"].includes(current.state) && !(input.action === "replaceNow" && current.state === "handing-over")) return { ok: false, code: "handoff-in-progress", error: "A handoff is already active" };
      if (!current || current.state === "done") {
        const loaded = loadLanes(deps.stateDir, input.slug); const lane = loaded.ok ? loaded.lanes.lead : "pi/zcode/glm-5.3";
        writeHandoffProgress(deps.stateDir, input.slug, null);
        updateProgress(input.slug, { reason: input.reason ?? "owner", state: "scheduled", fromLane: laneRef(input.fromLane ?? lane), toLane: laneRef(input.toLane ?? lane) });
      }
      writeRotationState(input.slug, reg.root, { rotationState: "rotation_pending" });
      if (input.action === "replaceNow") await completeHandoff(input.slug, reg.root, { agentId: reg.lead ?? "", outcome: { kind: "failed" }, timeline: [], fuseReason: "extraction-send-failed" });
      else if (input.reason === "provider-change" && await projectPeerInFlight(input.slug)) {
        const live = await liveAgentsById(); updateProgress(input.slug, { waitingPeers: countWaitingPeers(input.slug, projectStreamOf(input.slug), live) });
      } else await beginHandoff(input.slug, reg.root);
      return { ok: true, progress: progressOf(input.slug) };
    });
  };

  const runtime: LeadMailRuntime = {
    handoff,
    hasActiveWork,
    hasPendingHandoff: slug => { const id = readProjectRegistration(deps.stateDir, slug)?.lead; return id !== undefined && pendingHandoffByAgentId.has(id); },
    dispatchLead,
    dispatchSupervisor,
    reportSupervisor,
    notifyPeer,
    enqueueLeadMail,
    pumpProjectLead,
    pumpProjectSupervisor,
    onLeadTurnEnded,
    startupRecovery,
    pumpAll,
    sweepPeers,
    settleLeadRotation,
    onAgentArchived,
    markPluginArchive,
    clearPluginArchive,
    resetProjectMailbox,
    markKickoffSent,
    stop,
  };
  // v0.6.1 review fix: the archive markers run SYNCHRONOUSLY — the surface
  // sets a marker right before its archive call flies and clears it inside a
  // failure path nobody awaits, so both effects must land before control
  // returns (the markKickoffSent precedent).
  const sync = new Set(["startupRecovery", "settleLeadRotation", "resetProjectMailbox", "markKickoffSent", "markPluginArchive", "clearPluginArchive", "hasPendingHandoff"]);
  return new Proxy(runtime, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value !== "function" || key === "stop") return value;
    return (...args: unknown[]) => sync.has(String(key)) ? deps.factory.history.runSync(() => value.apply(receiver, args)) : deps.factory.history.runOperation(() => value.apply(receiver, args));
  } });
}

// ---- the handoff renderers (ADR 0013 §5 — fixed prose, machine-verified payload) ------------

/**
 * The one bounded Handoff Extraction prompt — fixed sections, fixed ceiling, no
 * new work.
 */
function renderHandoffExtractionPrompt(slug: string, reason: HandoffProgress["reason"] = "context-mark"): string {
  return [
    `# Lead handoff extraction — project ${slug}`,
    "",
    reason === "context-mark" ? "Your context window has crossed the 128,000-token rotation threshold, so this standing Lead seat is rotating: you are being retired, and a fresh successor Lead continues the project from your handoff." : `This standing Lead seat is handing off (${reason}). A fresh successor Lead continues the project from your handoff.`,
    "",
    "Put the entire Markdown handoff directly in your final assistant message, in one piece, without running shell commands or writing files to disk. The plugin server reads your reply and persists it automatically, capping it at 8 KB. Keep it a lean tactical baton, not an archive: never copy-paste active Contract.description blocks verbatim (they are already recorded in ledger.jsonl), and never write detailed post-mortems or test inventories of already-accepted waves. Use exactly these five sections:",
    "",
    "1. Goal & Remaining Roadmap",
    "2. Uncontracted Next Tasks",
    "3. Key Technical Findings",
    "4. Open Questions",
    "5. Read-First Files",
    "",
    "Start no new tasks, spawn no agents, set no contracts, and accept nothing — the handoff reply is this turn's only deliverable. End your turn after the complete Markdown document.",
  ].join("\n");
}

/**
 * The successor's three-layer kickoff — roster, digest, and the outgoing
 * Lead's handoff text. `stale` rides one of three notices: the
 * last-known-good notice of an interrupted extraction (ADR 0050); the
 * stale-unknown notice an undated on-disk handover — or a lost Lead's file —
 * carries while its age cannot be read (v0.6.1, ADR 0057 §4); or, since the
 * v0.6.1 hygiene fixes (ADR 0057 §11, spec story 8), the dated notice for a
 * handover the file's own metadata places before the outgoing Lead's last
 * activity.
 */
function renderSuccessorKickoff(input: {
  slug: string;
  roster: string;
  digest: string;
  handoffText: string | null;
  stale?: boolean;
  staleSource?: "extraction" | "lost-lead" | "dated";
  reason?: HandoffProgress["reason"];
}): string {
  return [
    `# Lead handoff — project ${input.slug}`,
    ...(input.stale
      ? [
          input.staleSource === "dated"
            ? "Staleness notice: this handover was written before the outgoing Lead's last activity. Re-read the Ledger and the repository before relying on it; the roster and digest above are the machine-verified truth."
            : input.staleSource === "lost-lead"
              ? "Staleness notice: this handover may predate the lost Lead's last activity — its age is unknown. Re-read the Ledger and the repository before relying on it; the roster and digest above are the machine-verified truth."
              : "Staleness notice: the latest extraction did not complete; the last-known-good handoff is shown below the authoritative live Machine-Verified Active Peer Roster and Ledger State Digest.",
        ]
      : []),
    "",
    `You are the fresh successor Lead of this project, spawned at 0% context after the outgoing Lead handed off (${input.reason ?? "context-mark"}). Three layers of continuity follow — the first two are machine-verified, built by the plugin from the live daemon and the ledger, never from prose:`,
    "",
    "## Machine-Verified Active Peer Roster",
    "",
    input.roster,
    "",
    "## Ledger State Digest",
    "",
    input.digest,
    "",
    "## Outgoing Lead handoff (lead-handoff.md)",
    "",
    input.handoffText !== null && input.handoffText.trim() !== ""
      ? input.handoffText
      : "(the outgoing Lead left no handoff text — rely on the roster and digest above, then read the ledger and reports)",
  ].join("\n");
}

/**
 * The Machine-Verified Active Peer Roster (v0.0.97, ADR 0047 §1.3): active-only
 * detail for the successor's ground truth. Already-accepted Tasks are closed
 * history — one compact count + latest-tail summary line (at most the 5 most
 * recent accepted task IDs), never O(N) per-task rows. Full per-task lines
 * (fold status, bound agent + live daemon status, the Task worktree path and
 * branch, and the latest Attempt / Verdict / Report — the `taskWorktree*` and
 * `agentTaskIndex` precedents) are rendered strictly for unaccepted Tasks.
 * Since ADR 0053 §3 each active row also carries the epoch's effective Peer
 * disposition — read from the latest `contract_set`, `engineer` when the
 * field predates the Contract or was omitted.
 */
function renderPeerRoster(input: {
  stateDir: string;
  slug: string;
  tasks: readonly TaskView[];
  agents: ReadonlyMap<string, string>;
  live: ReadonlyMap<string, SurfaceAgentSnapshot>;
  events?: readonly LedgerEvent[];
}): string {
  if (input.tasks.length === 0) return "(no tasks in the project's ledger — a clean slate)";
  const acceptedTasks = input.tasks.filter((task) => task.accepted || task.status === "accepted");
  // v0.5.0 (ADR 0054 §5, ticket 05): a clean retirement is closed history too —
  // one collapsed line, never an active row.
  const closedTasks = input.tasks.filter((task) => task.status === "closed");
  const activeTasks = input.tasks.filter((task) => !(task.accepted || task.status === "accepted" || task.status === "closed"));
  const lines: string[] = [];
  if (acceptedTasks.length > 0) {
    lines.push(
      `- accepted tasks (${acceptedTasks.length}): ${acceptedTasks.slice(-5).map((t) => t.task).join(", ")}${acceptedTasks.length > 5 ? ` (latest 5 of ${acceptedTasks.length})` : ""}`,
    );
  }
  if (closedTasks.length > 0) {
    lines.push(
      `- closed tasks (${closedTasks.length}): ${closedTasks.slice(-5).map((t) => t.task).join(", ")}${closedTasks.length > 5 ? ` (latest 5 of ${closedTasks.length})` : ""}`,
    );
  }
  if (activeTasks.length === 0) {
    lines.push("- active unaccepted tasks: none");
    return lines.join("\n");
  }
  for (const task of activeTasks) {
    const agentId = input.agents.get(task.task);
    const liveStatus = agentId === undefined ? null : (input.live.get(agentId)?.status ?? "(not live on the daemon)");
    const latest = task.attempts.at(-1);
    const epochContract = input.events?.findLast(
      (evt): evt is Extract<LedgerEvent, { event: "contract_set" }> => evt.event === "contract_set" && evt.task === task.task,
    );
    const disposition = epochContract?.disposition ?? "engineer";
    lines.push(
      [
        `- task ${task.task}: status ${task.status}`,
        `disposition ${disposition}`,
        agentId === undefined ? "agent (none bound)" : `agent ${agentId} (live: ${liveStatus})`,
        `worktree ${taskWorktreePath(input.stateDir, input.slug, task.task)} (branch ${taskWorktreeBranch(task.task)})`,
        latest === undefined ? "no attempt yet" : `latest attempt #${latest.n} (verdict: ${latest.verdict ?? "none yet"})`,
        `report: ${latest?.report ?? "none"}`,
      ].join(" · "),
    );
  }
  return lines.join("\n");
}

/** How many ledger lines ride the digest — orientation, not a mirror (the ledger stays on disk). */
const LEDGER_DIGEST_LINES = 20;

/** The Ledger State Digest: the Project's event census plus the most recent rendered lines. */
function renderLedgerDigest(events: readonly LedgerEvent[]): string {
  if (events.length === 0) return "(the project's ledger is empty)";
  const counts = new Map<string, number>();
  for (const evt of events) counts.set(evt.event, (counts.get(evt.event) ?? 0) + 1);
  const census = [...counts.entries()].sort().map(([name, count]) => `${name}×${count}`).join(", ");
  const tail = events.slice(-LEDGER_DIGEST_LINES).map((evt) => `seq ${evt.seq} — ${renderLedgerLine(evt)}`);
  return [`${events.length} ledger line(s) under <projectStateDir>/ledger.jsonl: ${census}`, ...tail].join("\n");
}

/**
 * The task → agent binding for the Machine-Verified Active Peer Roster
 * (v0.0.28, ADR 0018 §1): for each unaccepted Task in the Project's current
 * Contract epoch, resolves the bound working Agent in priority order:
 *   1. Live Daemon Worktree / Label Match: any live non-archived daemon agent
 *      (excluding supervisor / lead seats) whose cwd sits at or inside
 *      taskWorktreePath(stateDir, slug, task.task) or whose labels bind
 *      { task: task.task } (and labels.project === undefined || labels.project === slug).
 *   2. Correlation token Registry Match: the latest correlation record in
 *      readCorrelations(stateDir) for { role: "agent", projectSlug: slug, task: task.task }
 *      carrying a non-empty agentId within the current Contract epoch.
 *   3. Ledger Event Match: the latest claim_reported, meter_written, or
 *      repoke_dispatched event in the Task's current Contract epoch carrying a
 *      non-empty agent identifier.
 */
function agentOfTask(
  events: readonly LedgerEvent[],
  context?: {
    stateDir: string;
    slug: string;
    tasks: readonly TaskView[];
    live: ReadonlyMap<string, SurfaceAgentSnapshot>;
  },
): Map<string, string> {
  const ledgerAgents = new Map<string, string>();
  const latestContractSetByTask = new Map<string, Extract<LedgerEvent, { event: "contract_set" }>>();
  const contractSetCountByTask = new Map<string, number>();
  for (const evt of events) {
    if (evt.event === "contract_set") {
      ledgerAgents.delete(evt.task);
      latestContractSetByTask.set(evt.task, evt);
      contractSetCountByTask.set(evt.task, (contractSetCountByTask.get(evt.task) ?? 0) + 1);
      continue;
    }
    if (evt.event !== "claim_reported" && evt.event !== "meter_written" && evt.event !== "repoke_dispatched") continue;
    if (typeof evt.agent === "string" && evt.agent !== "") ledgerAgents.set(evt.task, evt.agent);
  }
  if (context === undefined) return ledgerAgents;

  const { stateDir, slug, tasks, live } = context;
  const correlations = readCorrelations(stateDir);
  const livePeers = [...live.values()].filter((agent) => {
    if (agent.archivedAt !== null) return false;
    const seatLabel = agent.labels?.seat;
    if (seatLabel === "supervisor" || seatLabel === "lead") return false;
    const inferredRole = inferRoleFromProviderId(agent.provider);
    if (inferredRole === "supervisor" || inferredRole === "lead") return false;
    return true;
  });

  const index = new Map<string, string>(ledgerAgents);
  for (const task of tasks) {
    if (task.accepted || task.status === "accepted") continue;
    const matchedLive = boundTaskPeers({ stateDir, slug, task: task.task, events, live: livePeers })[0]?.id;
    if (matchedLive !== undefined) {
      index.set(task.task, matchedLive);
      continue;
    }

    const latestContractSet = latestContractSetByTask.get(task.task);
    const contractSetCount = contractSetCountByTask.get(task.task) ?? 0;
    const contractEpochMs = latestContractSet !== undefined ? Date.parse(latestContractSet.ts) : Number.NaN;
    let matchedCorr: string | undefined;
    for (const rec of correlations) {
      if (rec.role !== "agent" || rec.projectSlug !== slug || rec.task !== task.task) continue;
      if (typeof rec.agentId !== "string" || rec.agentId.trim() === "") continue;
      if (latestContractSet !== undefined) {
        const recMs = Date.parse(rec.issuedAt);
        if ((contractSetCount > 1 || rec.issuedAt < latestContractSet.ts) && Number.isFinite(contractEpochMs) && Number.isFinite(recMs)) {
          if (recMs < contractEpochMs) continue;
        }
      }
      matchedCorr = rec.agentId.trim();
    }
    if (matchedCorr !== undefined) {
      index.set(task.task, matchedCorr);
      continue;
    }
  }
  return index;
}

/** The timeline's last assistant text — the handoff-file fallback's source. */
function lastAssistantText(timeline: readonly { type: string; text?: string }[]): string | null {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i]!;
    if (item.type === "assistant_message") return validHandoffText(item.text) ? item.text : null;
  }
  return null;
}

/** The last workspace a task's contract named — the owning-Project resolution, straight from the ledger. */
function contractWorkspaceOf(events: readonly LedgerEvent[], task: string): string | undefined {
  let workspace: string | undefined;
  for (const evt of events) {
    if (evt.event === "contract_set" && evt.task === task) workspace = evt.workspace;
  }
  return workspace;
}

/**
 * The driver-held signal, derived from the ledger alone (spec §Implementation
 * Decisions 4, last bullet): a synchronous CLI Driver wave is in flight while
 * any task's latest spawn round is still open — `spawn_dispatched` with
 * neither a terminal verdict (`gate_finished`) nor a `needs_human` close
 * after it. The wave's last terminal outcome clears the predicate, and that
 * outcome's own peer hook pumps the held batch.
 *
 * v0.0.92 (spec §Implementation Decision 4): the live-agents liveness check
 * runs for EVERY open round — a legacy `spawn_dispatched` with no `worktree`
 * field is checked by `labels.task` and the spawned agent id, never skipped.
 * A `Peer` that has terminated, errored, or been archived (the cascade kill
 * during `Lead handoff`) removes its round immediately, so a dead `Peer` can
 * never deadlock `drainLeadMailbox` from delivering the successor Lead's
 * Turn-1 kickoff. The `labels.task` arm stays Project-scoped: two Projects
 * may share a Task id, and a neighbor's live `Peer` is not this Project's
 * wave. `agent` is absent on today's `spawn_dispatched` lines (recorded
 * before any agent exists) — the id arm is the defensive read for any future
 * writer that stamps it, with the CLI Driver's own `"driver"` marker treated
 * as absent.
 *
 * v0.2.2 (ADR 0050 §1, the durable in-flight arm): `liveness: "live"` keeps
 * an open round while its bound `Peer` is merely live and not `error` —
 * `idle`/`closed` included, because `idle`-because-paused and
 * `idle`-between-turns are indistinguishable at the only layer that survives
 * restarts (the ledger plus the live daemon snapshot). Only the quiet-point
 * check (`projectPeerInFlight`) passes `"live"`; the default `"running"`
 * arm (running/initializing only) keeps governing `notifyPeer`'s pump gate
 * and `projectHasPeerWork`; a `Peer` that has already queued its verdict
 * must never hold the Lead's mail delivery.
 */
function driverWaveInFlight(
  events: readonly LedgerEvent[],
  liveAgents?: readonly SurfaceAgentSnapshot[],
  projectSlug?: string,
  liveness?: "running" | "live",
): boolean {
  const openRounds = new Map<string, Extract<LedgerEvent, { event: "spawn_dispatched" }>>();
  for (const evt of events) {
    if (!("task" in evt) || typeof evt.task !== "string") continue;
    if (evt.event === "spawn_dispatched") openRounds.set(evt.task, evt);
    else if (evt.event === "contract_set" || evt.event === "gate_finished" || evt.event === "needs_human") {
      openRounds.delete(evt.task);
    }
  }
  if (openRounds.size > 0 && liveAgents !== undefined) {
    for (const [task, spawnEvt] of [...openRounds.entries()]) {
      const wt = typeof spawnEvt.worktree === "string" && spawnEvt.worktree !== "" ? spawnEvt.worktree : undefined;
      const stampedAgent = (spawnEvt as { agent?: unknown }).agent;
      const spawnedAgentId =
        typeof stampedAgent === "string" && stampedAgent !== "" && stampedAgent !== "driver" ? stampedAgent : undefined;
      const peerIsLively = (agent: SurfaceAgentSnapshot): boolean =>
        liveness === "live" ? agent.status !== "error" : agent.status === "running" || agent.status === "initializing";
      const hasLivePeer = liveAgents.some(
        (agent) =>
          agent.archivedAt === null &&
          peerIsLively(agent) &&
          ((wt !== undefined && typeof agent.cwd === "string" && (agent.cwd === wt || agent.cwd.startsWith(`${wt}/`))) ||
            (agent.labels?.task === task &&
              (projectSlug === undefined || agent.labels?.project === undefined || agent.labels?.project === projectSlug)) ||
            (spawnedAgentId !== undefined && agent.id === spawnedAgentId)),
      );
      if (!hasLivePeer) openRounds.delete(task);
    }
  }
  return openRounds.size > 0;
}

/** One queued batch as the single prompt the Lead receives — every waiting item, in enqueue order. */
function renderMailPrompt(items: readonly LeadMailItem[]): string {
  const lines: string[] = [`# Lead mailbox — ${items.length} item${items.length === 1 ? "" : "s"}`, ""];
  for (const [index, item] of items.entries()) {
    lines.push(`${index + 1}. ${item.kind} from ${item.from}${item.task === undefined ? "" : ` (task ${item.task})`}`);
    lines.push(item.text);
  }
  return lines.join("\n");
}

/** One queued batch as the single prompt the Supervisor receives — every waiting item, in enqueue order. */
export function renderSupervisorMailBatch(items: readonly LeadMailItem[]): string {
  const lines: string[] = [`# Supervisor mailbox — ${items.length} item${items.length === 1 ? "" : "s"}`, ""];
  for (const [index, item] of items.entries()) {
    lines.push(`${index + 1}. ${item.kind} from ${item.from}${item.task === undefined ? "" : ` (task ${item.task})`}`);
    lines.push(item.text);
  }
  return lines.join("\n");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
