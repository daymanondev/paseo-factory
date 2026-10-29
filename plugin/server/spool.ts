import { spoolRequestSemanticKey } from "./core/mcp/transport.ts";
export { spoolRequestSemanticKey } from "./core/mcp/transport.ts";
import { prepareProjectContract } from "./execution-adapters.ts";
import { commandRun as commandScrumRun, readRun as readScrumRun } from "./core/scrum/run-journal.ts";
import { withExecutionLane } from "./core/scrum/execution.ts";
import type { ScrumDirective } from "./scrum.ts";
import type { ScrumOperation } from "./core/scrum/controller.ts";
import { bindScrumEpoch, scrumSpawnLane } from "./scrum.ts";
import { SCRUM_ROLE_TITLES } from "./core/scrum/prompts.ts";
import { SPECIALIST_ROLES, safeId, artifactRefIsValid } from "./core/scrum/types.ts";
import type { ScrumRoleName, ArtifactRef } from "./core/scrum/types.ts";
import { recordUpgradeControlReceipt } from "./core/history-upgrade.ts";
import { pendingUpgradeFor } from "./core/upgrade-state.ts";
import { upgradeFactory, upgradeReply, recordUpgradeControlReply } from "./core/history-upgrade.ts";
import type { UpgradeInput, UpgradeResult, UpgradePreflight } from "./core/history-upgrade.ts";
/**
 * The spool (ADR 0004): the plugin process is the only Ledger writer and the
 * only Gate runner; the CLIs (`factory-claim`, `factory contract`,
 * `factory accept`) only submit. A CLI drops a request file and waits for the
 * reply file — no RPC, no shared process, so the protocol survives daemon
 * restarts and never hands the Ledger to an agent's process.
 *
 * Protocol — the plugin side lives here, the CLI side in
 * `plugin/bin/spool-client.mjs`, and `test/cli.test.ts` runs both halves
 * against each other so they cannot drift:
 *
 *   request:  spool/requests/<id>.json   {id, kind, ...}   written atomically
 *   reply:    spool/replies/<id>.json    {id, ok, ...}     written atomically
 *   handled:  spool/processed/<id>.json  the request file, moved after reply
 *
 * Each request carries an id: a request whose reply already exists is moved
 * along untouched, so a retried or replayed request never starts a second
 * Gate. What a plugin crash mid-gate looks like is ADR 0003's business — the
 * interrupted Attempt is closed red on the next open, and the still-unreplied
 * request is processed again on boot, opening the next Attempt honestly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FactoryError } from "./core/errors.ts";
import { usageIsValid } from "./core/ledger.ts";
import { needsHumanEvidenceIsValid, NEEDS_HUMAN_REASONS } from "./core/events.ts";
import type { Factory } from "./core/factory.ts";
import type { LedgerEvent, MeterUsage, NeedsHumanEvidence, NeedsHumanReason, Verdict } from "./core/events.ts";
import { CorrelationRegistry, readCorrelations } from "./core/correlations.ts";
import { loadLanes, parseLane } from "./core/lanes.ts";
import { listProjectRegistrations, readProjectRegistration, resolveProject, writeProjectRegistration } from "./core/project.ts";
import { FACTORY_SEAT_PROVIDER_IDS, formatPeerAgentTitle, formatPeerWorkspaceTitle } from "./roles.ts";
import { acceptanceSummary, executeAcceptance } from "./commands.ts";
import { boundTaskPeers, peerIsRunning } from "./task-peers.ts";
import { stopAgentViaCli } from "./daemon-cli.ts";
import type { DaemonReply } from "./daemon-cli.ts";
import { isPaseoWorkspaceArchivedOnDisk, restoreDaemonWorkspaceViaWs } from "./daemon-cli.ts";
import type { SurfaceDaemonApi } from "./surface-rpc.ts";
import type { HistoryImportSource } from "./core/history-import.ts";
import type { ImportStatus } from "./core/history-stage.ts";

/** Seat identity stamped from `PASEO_FACTORY_SEAT` (v0.0.23, ADR 0015 §1). */
export type SpoolSeat = "supervisor" | "lead" | "agent";

export interface ContractRequest {
  runId?: string;
  role?: ScrumRoleName;
  artifactRefs?: ArtifactRef[];
  id: string;
  kind: "contract";
  task: string;
  workspace: string;
  gate: string;
  artifact?: string;
  base?: string;
  scope?: string[];
  /** Marks the fresh-eyes pass ON or OFF (`true` | `false`, or omitted for caller default; anything else is rejected). */
  freshEyes?: boolean;
  /** Marks the watch pass ON (v0.0.6, record-only, both verdicts). Exactly `true` passes; anything else is rejected. */
  watch?: true;
  /** The task's assignment text (v0.0.6 description-slot rider) — the driver's brief carries it. */
  description?: string;
  /**
   * The SKILL.md workflows the working Agent must open first (v0.0.14, ADR
   * 0010 §6) — skill names; the driver's brief renders them at the top.
   */
  skills?: string[];
  /**
   * Who submitted (v0.0.9, ADR 0006) — required, stamped by the CLI from the
   * submitting shell's env: the delegated Owner agent's `PASEO_AGENT_ID`
   * where the daemon carried one, `owner` on the human path. An unstamped
   * contract is malformed — attribution is part of the request's shape, so
   * the spool never guesses or defaults it.
   */
  submitter: string;
  /** Caller seat stamped from `PASEO_FACTORY_SEAT` when present (v0.0.23, ADR 0015 §1). */
  seat?: SpoolSeat;
}

export interface ClaimRequest {
  id: string;
  kind: "claim";
  task: string;
  sha: string;
  /** Who submitted, when the daemon stamps it on the agent's env — for the spool log, not the ledger. */
  agent?: string;
  seat?: SpoolSeat;
}

export interface AcceptRequest {
  id: string;
  kind: "accept";
  task: string;
  attempt: number;
  /**
   * The accepting seat, claimed explicitly (v0.0.14, ADR 0010 §3): the CLI's
   * `--by owner|supervisor|lead` flag. When present it overrides the
   * submitter stamp as the acceptance's `accepted_by` — the Lead's
   * conditional authority is judged at the factory, never trusted from the
   * request's spelling alone.
   */
  by?: "owner" | "supervisor" | "lead";
  /**
   * Who submitted (v0.0.9) — required, the submitting shell's stamp, the
   * same law as the contract's: `PASEO_AGENT_ID` or `owner`. "The Ledger
   * always records who accepted" (ADR 0006) starts at the request.
   */
  submitter: string;
  /** Caller seat stamped from `PASEO_FACTORY_SEAT` when present (v0.0.23, ADR 0015 §1). */
  seat?: SpoolSeat;
}

/**
 * A driver's spawn request (v0.0.5, ADR 0004 amendment): `factory run` asks
 * the plugin — the one writer — whether it may create this task's agent.
 * The plugin judges (task state, scope-mandatory at arity ≥ 2, workspace
 * overlap) and appends one ledger line either way; only on ok does the
 * driver perform its own daemon RPC create. `provider` is recorded on the
 * line, never interpreted; `arity` is the invocation's task count — the
 * parallel width the scope rule keys on.
 */
export interface SpawnRequest {
  runId?: string;
  role?: ScrumRoleName;
  providerExplicit?: boolean;
  id: string;
  kind: "spawn";
  task: string;
  provider: string;
  arity: number;
  /**
   * The managed Task worktree this run executes in (v0.0.14, ADR 0010 §4) —
   * the driver allocates it pre-spawn and names it here; the plugin records
   * it on `spawn_dispatched`, and claim / gate / choke binding resolve
   * through it. Optional: the legacy shared-checkout path sends none.
   */
  worktree?: string;
  /** Optional prompt when `lead_spawn_agent` MCP tool requests the plugin to create the daemon agent directly (v0.0.26). */
  prompt?: string;
  submitter?: string;
  /** Caller seat stamped from `PASEO_FACTORY_SEAT` when present (v0.0.23, ADR 0015 §1). */
  seat?: SpoolSeat;
}

/**
 * The Lead rotation (v0.0.14, ADR 0010 §2): `factory lead rotate --project
 * <dir>` asks the plugin — the one daemon actor — to cancel + archive the
 * Project's active `seat=lead` agent, so the next dispatch starts a fresh
 * Lead session grounded in the Project's Ledger and AGENTS.md / CONTEXT.md.
 * No ledger line lands: a rotation is a daemon fact, not a factory fact —
 * the reply names the retired agent.
 */
export interface LeadRotateRequest {
  id: string;
  kind: "lead_rotate";
  /** Any directory inside the Project's repository (resolveProject names the slug). */
  projectRoot: string;
  submitter?: string;
  /** Caller seat stamped from `PASEO_FACTORY_SEAT` when present (v0.0.23, ADR 0015 §1). */
  seat?: SpoolSeat;
}

/**
 * The Lead dispatch (v0.0.20, ADR 0013 §4): `factory lead dispatch` drops one
 * of these and the plugin — the single writer of `<projectStateDir>/
 * mailbox.jsonl` — resolves the target Project (`workspace` through
 * resolveProject, `project` slug through the registry), auto-ensures the
 * Project's Lead seat, appends one `mail_queued`, and pumps the serialized
 * per-Project lane. The ok reply carries the dispatch facts (`project`,
 * `leadAgentId`, `mailId`, `rotationState`) so the caller never needs a raw
 * Paseo agentId.
 */
export interface SpoolLeadDispatchRequest extends ScrumDirective {
  task?: string;
  id: string;
  kind: "lead_dispatch";
  project?: string;
  workspace?: string;
  from?: "supervisor" | "owner" | "peer";
  message: string;
  submitter?: string;
  /** Caller seat stamped from `PASEO_FACTORY_SEAT` when present (v0.0.23, ADR 0015 §1). */
  seat?: SpoolSeat;
}

/**
 * Seat-aware `/factory` entrypoint (v0.0.23, ADR 0015 §5): `factory supervisor
 * dispatch` routes normal-chat / CLI directives into the Project's `Supervisor`
 * mailbox (`to: "supervisor"`), and when called from inside `Supervisor`
 * (`seat === "supervisor"`) transparently routes to `lead_dispatch` (`to: "lead"`).
 */
export interface SpoolSupervisorDispatchRequest extends ScrumDirective {
  id: string;
  kind: "supervisor_dispatch";
  project?: string;
  workspace?: string;
  message: string;
  submitter?: string;
  seat?: SpoolSeat;
}

/**
 * Lead -> Supervisor reporting channel (v0.0.23, ADR 0015 §3): `factory
 * supervisor report` queues a report (`to: "supervisor"`, `from: "lead"`,
 * `kind: "report"`) in `<projectStateDir>/mailbox.jsonl` and pumps the
 * Supervisor lane.
 */
export interface SpoolSupervisorReportRequest {
  reportType?: "ui-review" | "completed";
  scrum?: Record<string, unknown>;
  id: string;
  kind: "supervisor_report";
  project?: string;
  workspace?: string;
  message: string;
  submitter?: string;
  seat?: SpoolSeat;
}

/**
 * Owner-only Project Reset (v0.0.24, ADR 0015 §6): `factory reset` purges all
 * Project state (ledger events, reports/worktrees, `<projectStateDir>/`, and
 * optionally seat/worker sessions unless `keepSeats` is set). Refused with
 * `code: "seat-cannot-reset"` when called from any non-Owner seat.
 */
export interface SpoolResetRequest {
  id: string;
  kind: "reset";
  workspace?: string;
  project?: string;
  keepSeats?: boolean;
  submitter?: string;
  seat?: SpoolSeat;
}

/**
 * Owner-only Project Delete (v0.0.35, ADR 0024): `factory project delete` /
 * `factory delete` purges all Factory state, worktrees, branches, correlations,
 * `<stateDir>/projects/<slug>/` (including `project.json` and `lanes.json`),
 * and Paseo workspace/project records. Refused with `code: "seat-cannot-delete"`
 * when called from any non-Owner seat (`supervisor`, `lead`, `agent`).
 */
export interface SpoolDeleteRequest {
  id: string;
  kind: "delete";
  workspace?: string;
  projectRoot?: string;
  projectSlug?: string;
  project?: string;
  submitter?: string;
  seat?: SpoolSeat;
}


/**
 * The Lead's one automatic Respawn per progress marker (v0.0.12, ADR 0008):
 * when an Agent dies (`Substrate death`), the driver asks the plugin — the
 * one writer — whether it may replace the dead Agent, and only creates the
 * replacement after an ok. The reply carries `event` (whose `seq` keys the
 * replacement `agent.create.request` idempotency key).
 */
export interface RespawnRequest {
  runId?: string;
  role?: ScrumRoleName;
  id: string;
  kind: "respawn";
  task: string;
  provider: string;
  died_agent: string;
  submitter?: string;
  /** Caller seat stamped from `PASEO_FACTORY_SEAT` when present (v0.0.23, ADR 0015 §1). */
  seat?: SpoolSeat;
}

/**
 * The Owner's Retro request (v0.0.7, ticket 03 item 2): `factory retro`
 * drops this and the plugin does everything — digest, copilot pass,
 * proposals file, the one factory-level `retro_written` line (the one-writer
 * law). Deliberately a NEW kind, not a contract reuse: different validation,
 * different act. The whole-ledger scope is always whole — no `--since`, no
 * task filter (v1) — but since v0.0.38 (ADR 0026 §1) the optional Project
 * scope (`projectSlug`, or `projectRoot` resolved to its slug) names whose
 * `retro` lane override the pass runs under.
 */
export interface RetroRequest {
  id: string;
  kind: "retro";
  /** The Project's registered slug — the registry door. */
  projectSlug?: string;
  /** Any directory inside the Project's repository — resolved to its canonical slug. */
  projectRoot?: string;
  submitter?: string;
  /** Caller seat stamped from `PASEO_FACTORY_SEAT` when present (v0.0.23, ADR 0015 §1). */
  seat?: SpoolSeat;
}

/**
 * The driver's meter request (v0.0.8, ticket 03 item 1 — ADR 0004's third
 * amendment): the usage snapshot the driver captured off its terminal
 * `fetch_agent` poll, submitted for the plugin to validate and ledger as
 * one `meter_written` line. The driver never writes the ledger; a refused
 * meter (unknown task, malformed shape) errors back with no line — nothing
 * changed, nothing recorded. `usage` rides the daemon's camelCase verbatim,
 * each field present only when the lane provided it.
 */
export interface MeterRequest {
  id: string;
  kind: "meter";
  task: string;
  /** The `provider[/model]` string the driver's invocation ran under, verbatim. */
  provider: string;
  /** The daemon's usage snapshot — see `MeterUsage` in core/events.ts. */
  usage: MeterUsage;
  /** The metered agent's id, when the driver knows it. */
  agent?: string;
  submitter?: string;
  seat?: SpoolSeat;
}

/**
 * The Lead's one spend (v0.0.10, ticket 03 item 3 — the spawn precedent's
 * strict shape): the driver asks the plugin — the one writer — whether it
 * may spend the task's one re-poke, and only sends the fixed message after
 * an ok. The plugin holds the structural laws (task known, not accepted,
 * not already spent); the stall predicate that triggered the ask stays
 * driver-side. Deliberately minimal — the trigger is the driver's fact, the
 * spend is the plugin's authority, and neither interprets the other.
 */
export interface RepokeRequest {
  id: string;
  kind: "repoke";
  task: string;
  /** The stalled agent the fixed re-poke text goes to. */
  agent: string;
  submitter?: string;
  seat?: SpoolSeat;
}

/**
 * The Lead's named end (v0.0.10 / v0.0.12, ADR 0008): the task reached one
 * of the four `NeedsHuman` conditions (`denied-again`, `silent-after-repoke`,
 * `attempt-ceiling`, `died-after-respawn`), so the driver submits the fact
 * for the plugin to corroborate and ledger as one task-scoped `needs_human`
 * line with its matching evidence pair.
 */
export interface NeedsHumanRequest {
  id: string;
  kind: "needs_human";
  task: string;
  reason: NeedsHumanReason;
  evidence: NeedsHumanEvidence;
  submitter?: string;
  seat?: SpoolSeat;
}

/**
 * A synthetic permit ask (v0.0.4) — the bypass battery's vehicle into the real
 * choke: the same policy, the same ledger lines, answered in the reply instead
 * of `respondToPermission()` because no daemon ask exists to answer. The task
 * must carry a live Contract covering `cwd` (default: the Contract's own
 * workspace) — the choke judges contracted work only.
 */
export interface AskRequest {
  id: string;
  kind: "ask";
  task: string;
  command: string;
  cwd?: string;
  agent?: string;
  name?: string;
  submitter?: string;
  seat?: SpoolSeat;
}

export type ScrumSpoolRequest = ScrumOperation & { id: string; kind: "scrum_command"; projectRoot?: string; submitter: string; seat?: SpoolSeat };
export type ExecutionSpoolRequest = { id: string; kind: "execution_mode"; mode: "slp" | "scrum"; projectRoot?: string; submitter: string; seat?: SpoolSeat };
export type SpoolRequest =
  | ScrumSpoolRequest
  | ExecutionSpoolRequest
  | ({ id: string; kind: "upgrade"; submitter?: string; seat?: SpoolSeat } & Omit<UpgradeInput, "controlId">)
  | { id: string; kind: "history_import" | "history_import_status"; sources?: HistoryImportSource[]; project?: string; submitter?: string; seat?: SpoolSeat }
  | ContractRequest
  | ClaimRequest
  | AcceptRequest
  | AskRequest
  | LeadRotateRequest
  | SpoolLeadDispatchRequest
  | SpoolSupervisorDispatchRequest
  | SpoolSupervisorReportRequest
  | SpoolResetRequest
  | SpoolDeleteRequest
  | SpawnRequest
  | RespawnRequest
  | MeterRequest
  | RepokeRequest
  | NeedsHumanRequest
  | RetroRequest;

/** Handles a synthetic ask — `createChoke(...).spoolAskHandler` is the implementation. */
export type AskHandler = (request: AskRequest) => SpoolReply;

/** Rotates a Project's Lead — the surface handlers' `leadRotate` is the implementation. */
export type LeadRotateHandler = (request: LeadRotateRequest) => Promise<SpoolReply>;

/** Dispatches a directive into a Project's Lead mailbox — the Lead-mailbox runtime's `dispatchLead` is the implementation (v0.0.20). */
export type LeadDispatchHandler = (request: SpoolLeadDispatchRequest) => Promise<SpoolReply>;

/** Dispatches a directive into a Project's Supervisor mailbox (or Lead when called by Supervisor) (v0.0.23, ADR 0015 §5). */
export type SupervisorDispatchHandler = (request: SpoolSupervisorDispatchRequest) => Promise<SpoolReply>;

/** Queues a Lead report into a Project's Supervisor mailbox (v0.0.23, ADR 0015 §3). */
export type SupervisorReportHandler = (request: SpoolSupervisorReportRequest) => Promise<SpoolReply>;

/** Resets a Project — the surface handlers' `projectReset` is the implementation (v0.0.24, ADR 0015 §6). */
export type ProjectResetHandler = (request: SpoolResetRequest) => Promise<SpoolReply>;

/** Deletes a Project completely — the surface handlers' `projectDelete` is the implementation (v0.0.35, ADR 0024). */
export type ProjectDeleteHandler = (request: SpoolDeleteRequest) => Promise<SpoolReply>;

/** Sanitizes a `<provider>/<model>[:<thinking>]` lane string against the daemon's provider catalog (v0.0.24, ADR 0015 §1). */
export type SanitizeLaneHandler = (laneValue: string) => Promise<string> | string;


/**
 * Notifies a Project's Lead mailbox that a Peer's task reached a terminal
 * outcome (v0.0.20, ADR 0013 §4, last bullet) — the Lead-mailbox runtime's
 * `notifyPeer` is the implementation. Appends `mail_queued`
 * (`from: "peer"`) on the owning Project's lane, held while a Driver wave is
 * in flight and flushed when the wave finishes; never rejects (a notification
 * failure must not break the verdict's own reply).
 */
export type PeerMailHook = (input: { task: string; kind: "verdict" | "needs_human"; text: string }) => Promise<void>;

export type SpoolReply =
  | {
      id: string;
      ok: true;
      summary: string;
      upgrade?: UpgradeResult | UpgradePreflight;
      /** Claim replies: which Attempt the Claim opened and how it ended. */
      attempt?: number;
      verdict?: Verdict;
      reportPath?: string;
      /** The gate note — the agent's actionable feedback on a red verdict. */
      note?: string;
      /** Ask replies: the choke's answer. A denial is a processed ask, not an error. */
      decision?: "allowed" | "denied";
      rule?: string;
      reason?: string;
      /** Retro replies: the proposals file and its count (the success stdout's two facts). */
      proposalsPath?: string;
      proposalCount?: number;
      /** Spawn / respawn replies: the ledger event appended for the request (carries seq). */
      event?: LedgerEvent;
      /** Lead-rotate replies: the agent the rotation cancelled + archived. */
      agentId?: string;
      /**
       * Lead-dispatch replies (v0.0.20): the Project the mail landed in, the
       * ensured Lead's agent id, the queued mail's id, and the Project's
       * rotation state at dispatch time (absent on disk reads as "normal").
       */
      project?: string;
      leadAgentId?: string;
      supervisorAgentId?: string;
      mailId?: string;
      rotationState?: string;
      /** Spawn / respawn replies (v0.0.23, ADR 0015 §6): the Task worktree's Paseo workspace id and owning Project slug. */
      workspaceId?: string;
      projectSlug?: string;
      /** Project-reset / project-delete replies (v0.0.24, ADR 0015 §6; v0.0.35, ADR 0024). */
      projectRoot?: string;
      purgedEvents?: number;
      tasks?: string[];
      removedFiles?: number;
      archivedSeats?: string[];
      archivedAgents?: string[];
      data?: unknown;
      historyImports?: ImportStatus[];
    }
  | { id: string; ok: false; code: string; message: string; event?: LedgerEvent };



/** Where all three spool directories live. */
export function spoolRootFor(stateDir: string): string {
  return join(stateDir, "spool");
}

/**
 * Stable JSON serialization of any value — object keys sorted, recursively
 * (arrays keep their order). Pure: the same body always serializes to the
 * same string.
 */


function parseOptionalSeat(value: unknown): { ok: true; seat?: SpoolSeat } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (value === "supervisor" || value === "lead" || value === "agent") return { ok: true, seat: value };
  return { ok: false };
}

function parseOptionalSubmitter(value: unknown): { ok: true; submitter?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value === "string" && value.trim() !== "") return { ok: true, submitter: value };
  return { ok: false };
}

/**
 * Validates one decoded request body. Anything that does not match a kind's
 * exact shape is rejected — the spool never guesses what a CLI meant.
 */
export function parseSpoolRequest(body: unknown): SpoolRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const req = body as Record<string, unknown>;
  if (typeof req.id !== "string" || req.id === "") return undefined;
  const seatParsed = parseOptionalSeat(req.seat);
  if (!seatParsed.ok) return undefined;
  const seatField = seatParsed.seat === undefined ? {} : { seat: seatParsed.seat };
  const submitterParsed = parseOptionalSubmitter(req.submitter);
  if (!submitterParsed.ok) return undefined;
  const submitterField = submitterParsed.submitter === undefined ? {} : { submitter: submitterParsed.submitter };
  if (req.runId !== undefined && !safeId(req.runId)) return undefined;
  if (req.role !== undefined && !SPECIALIST_ROLES.includes(req.role as ScrumRoleName)) return undefined;
  if (req.artifactRefs !== undefined && (!Array.isArray(req.artifactRefs) || !req.artifactRefs.every(artifactRefIsValid))) return undefined;
  if (req.reportType !== undefined && !["ui-review", "completed"].includes(String(req.reportType))) return undefined;
  if (req.expectedRevision !== undefined && (!Number.isSafeInteger(req.expectedRevision) || (req.expectedRevision as number) < 1)) return undefined;
  if (req.kind === "upgrade") {
    if (!["preflight", "apply", "resume", "restore"].includes(String(req.action)) || (req.transactionId !== undefined && typeof req.transactionId !== "string") || (req.projectSlug !== undefined && typeof req.projectSlug !== "string")) return undefined;
    return { id: req.id, kind: "upgrade", action: req.action as UpgradeInput["action"], ...(req.transactionId === undefined ? {} : { transactionId: req.transactionId as string }), ...(req.projectSlug === undefined ? {} : { projectSlug: req.projectSlug as string }), ...seatField, ...submitterField };
  }
  if (req.kind === "history_import" || req.kind === "history_import_status") {
    if (req.project !== undefined && typeof req.project !== "string") return undefined;
    if (req.sources !== undefined && (!Array.isArray(req.sources) || req.sources.some((source: unknown) => typeof source !== "object" || source === null || typeof (source as Record<string, unknown>).nodeId !== "string" || typeof (source as Record<string, unknown>).lines !== "string"))) return undefined;
    return { id: req.id, kind: req.kind, ...(req.project === undefined ? {} : { project: req.project }), ...(req.sources === undefined ? {} : { sources: req.sources as HistoryImportSource[] }), ...seatField, ...submitterField };
  }
  if (req.kind === "execution_mode") {
    if (!["slp", "scrum"].includes(String(req.mode)) || typeof req.submitter !== "string" || req.projectRoot !== undefined && typeof req.projectRoot !== "string") return undefined;
    return { id: req.id, kind: "execution_mode", mode: req.mode as "slp" | "scrum", ...(req.projectRoot === undefined ? {} : { projectRoot: req.projectRoot as string }), submitter: req.submitter, ...seatField };
  }
  if (req.kind === "scrum_command") {
    if (typeof req.operation !== "string" || typeof req.submitter !== "string" || req.projectRoot !== undefined && typeof req.projectRoot !== "string" || req.runId !== undefined && typeof req.runId !== "string" || req.payload !== undefined && (typeof req.payload !== "object" || req.payload === null || Array.isArray(req.payload))) return undefined;
    return { id: req.id, kind: "scrum_command", requestId: typeof req.requestId === "string" ? req.requestId : req.id, operation: req.operation, ...(req.projectRoot === undefined ? {} : { projectRoot: req.projectRoot as string }), ...(req.runId === undefined ? {} : { runId: req.runId as string }), ...(req.expectedRevision === undefined ? {} : { expectedRevision: req.expectedRevision as number }), ...(req.payload === undefined ? {} : { payload: req.payload as Record<string, unknown> }), submitter: req.submitter, ...seatField };
  }
  if (req.kind === "contract") {
    if (
      typeof req.task !== "string" ||
      typeof req.workspace !== "string" ||
      typeof req.gate !== "string" ||
      (req.artifact !== undefined && typeof req.artifact !== "string")
    ) {
      return undefined;
    }
    // The v0.0.9 stamp: a contract without a submitter is malformed — the
    // spool never defaults an unstamped Owner act to anyone.
    if (typeof req.submitter !== "string" || req.submitter.trim() === "") return undefined;
    const scope = req.scope;
    if (scope !== undefined && (!Array.isArray(scope) || scope.some((s) => typeof s !== "string"))) return undefined;
    const skills = req.skills;
    if (skills !== undefined && (!Array.isArray(skills) || skills.some((s) => typeof s !== "string"))) return undefined;
    if (req.freshEyes !== undefined && typeof req.freshEyes !== "boolean") return undefined;
    if (req.watch !== undefined && req.watch !== true) return undefined;
    if (req.base !== undefined && (typeof req.base !== "string" || req.base.trim() === "")) return undefined;
    if (req.description !== undefined && (typeof req.description !== "string" || req.description.trim() === "")) return undefined;
    return {
      id: req.id,
      kind: "contract",
      ...(req.runId === undefined ? {} : { runId: req.runId as string }),
      ...(req.role === undefined ? {} : { role: req.role as ScrumRoleName }),
      ...(req.artifactRefs === undefined ? {} : { artifactRefs: req.artifactRefs as ArtifactRef[] }),
      task: req.task,
      workspace: req.workspace,
      gate: req.gate,
      ...(req.artifact === undefined ? {} : { artifact: req.artifact }),
      ...(req.base === undefined ? {} : { base: req.base }),
      ...(scope === undefined ? {} : { scope: scope as string[] }),
      ...(skills === undefined ? {} : { skills: skills as string[] }),
      ...(req.freshEyes === undefined ? {} : { freshEyes: req.freshEyes }),
      ...(req.watch === undefined ? {} : { watch: true }),
      ...(req.description === undefined ? {} : { description: req.description }),
      submitter: req.submitter,
      ...seatField,
    };
  }
  if (req.kind === "claim") {
    if (typeof req.task !== "string" || typeof req.sha !== "string") return undefined;
    if (req.agent !== undefined && typeof req.agent !== "string") return undefined;
    return { id: req.id, kind: "claim", task: req.task, sha: req.sha, ...(req.agent === undefined ? {} : { agent: req.agent }) };
  }
  if (req.kind === "accept") {
    if (typeof req.task !== "string" || typeof req.attempt !== "number" || !Number.isInteger(req.attempt)) return undefined;
    // Same law as the contract: no submitter, no acceptance — the accepter's
    // identity is part of the act (ADR 0006).
    if (typeof req.submitter !== "string" || req.submitter.trim() === "") return undefined;
    if (req.by !== undefined && req.by !== "owner" && req.by !== "supervisor" && req.by !== "lead") return undefined;
    return {
      id: req.id,
      kind: "accept",
      task: req.task,
      attempt: req.attempt,
      ...(req.by === undefined ? {} : { by: req.by }),
      submitter: req.submitter,
      ...seatField,
    };
  }
  if (req.kind === "spawn") {
    if (typeof req.task !== "string" || typeof req.provider !== "string" || typeof req.arity !== "number" || !Number.isInteger(req.arity) || req.arity < 1) {
      return undefined;
    }
    if (req.worktree !== undefined && (typeof req.worktree !== "string" || req.worktree.trim() === "")) return undefined;
    if (req.prompt !== undefined && typeof req.prompt !== "string") return undefined;
    return {
      id: req.id,
      kind: "spawn",
      ...(req.runId === undefined ? {} : { runId: req.runId as string }),
      ...(req.role === undefined ? {} : { role: req.role as ScrumRoleName }),
      ...(req.providerExplicit === undefined ? {} : { providerExplicit: req.providerExplicit === true }),
      task: req.task,
      provider: req.provider,
      arity: req.arity,
      ...(req.worktree === undefined ? {} : { worktree: req.worktree }),
      ...(req.prompt === undefined ? {} : { prompt: req.prompt }),
      ...submitterField,
      ...seatField,
    };
  }
  if (req.kind === "respawn") {
    if (
      typeof req.task !== "string" ||
      typeof req.provider !== "string" ||
      req.provider.trim() === "" ||
      typeof req.died_agent !== "string" ||
      req.died_agent.trim() === ""
    ) {
      return undefined;
    }
    return { id: req.id, kind: "respawn", task: req.task, provider: req.provider, died_agent: req.died_agent, ...submitterField, ...seatField };
  }
  if (req.kind === "lead_rotate") {
    if (typeof req.projectRoot !== "string" || req.projectRoot.trim() === "") return undefined;
    return { id: req.id, kind: "lead_rotate", projectRoot: req.projectRoot, ...submitterField, ...seatField };
  }
  if (req.kind === "lead_dispatch") {
    // The v0.0.20 dispatch: the message is the payload (never blank); the
    // target Project rides either form — a registry slug or a workspace
    // directory — and only the Owner-side seats may name themselves `from`
    // (peer mail rides the spool's own hook, never this field).
    if (typeof req.message !== "string" || req.message.trim() === "") return undefined;
    if (req.project !== undefined && (typeof req.project !== "string" || req.project.trim() === "")) return undefined;
    if (req.workspace !== undefined && (typeof req.workspace !== "string" || req.workspace.trim() === "")) return undefined;
    if (req.from !== undefined && req.from !== "supervisor" && req.from !== "owner" && !(req.from === "peer" && req.seat === "agent")) return undefined;
    return {
      id: req.id,
      kind: "lead_dispatch",
      ...(typeof req.task === "string" ? { task: req.task } : {}),
      ...(req.runId === undefined ? {} : { runId: req.runId as string }),
      ...(req.scrum === undefined ? {} : { scrum: req.scrum as ScrumDirective["scrum"] }),
      ...(req.project === undefined ? {} : { project: req.project }),
      ...(req.workspace === undefined ? {} : { workspace: req.workspace }),
      ...(req.from === undefined ? {} : { from: req.from }),
      message: req.message,
      ...submitterField,
      ...seatField,
    };
  }
  if (req.kind === "supervisor_dispatch" || req.kind === "supervisor_report") {
    if (typeof req.message !== "string" || req.message.trim() === "") return undefined;
    if (req.project !== undefined && (typeof req.project !== "string" || req.project.trim() === "")) return undefined;
    if (req.workspace !== undefined && (typeof req.workspace !== "string" || req.workspace.trim() === "")) return undefined;
    return {
      id: req.id,
      kind: req.kind,
      ...(req.reportType === undefined ? {} : { reportType: req.reportType as "ui-review" | "completed" }),
      ...(req.runId === undefined ? {} : { runId: req.runId as string }),
      ...(req.scrum === undefined ? {} : { scrum: req.scrum as ScrumDirective["scrum"] }),
      ...(req.project === undefined ? {} : { project: req.project }),
      ...(req.workspace === undefined ? {} : { workspace: req.workspace }),
      message: req.message,
      ...submitterField,
      ...seatField,
    };
  }
  if (req.kind === "reset") {
    if (req.project !== undefined && (typeof req.project !== "string" || req.project.trim() === "")) return undefined;
    if (req.workspace !== undefined && (typeof req.workspace !== "string" || req.workspace.trim() === "")) return undefined;
    if (req.keepSeats !== undefined && typeof req.keepSeats !== "boolean") return undefined;
    return {
      id: req.id,
      kind: "reset",
      ...(req.project === undefined ? {} : { project: req.project }),
      ...(req.workspace === undefined ? {} : { workspace: req.workspace }),
      ...(req.keepSeats === undefined ? {} : { keepSeats: req.keepSeats }),
      ...submitterField,
      ...seatField,
    };
  }
  if (req.kind === "delete" || req.kind === "project_delete") {
    if (req.project !== undefined && (typeof req.project !== "string" || req.project.trim() === "")) return undefined;
    if (req.projectSlug !== undefined && (typeof req.projectSlug !== "string" || req.projectSlug.trim() === "")) return undefined;
    if (req.projectRoot !== undefined && (typeof req.projectRoot !== "string" || req.projectRoot.trim() === "")) return undefined;
    if (req.workspace !== undefined && (typeof req.workspace !== "string" || req.workspace.trim() === "")) return undefined;
    return {
      id: req.id,
      kind: "delete",
      ...(req.project === undefined ? {} : { project: req.project }),
      ...(req.projectSlug === undefined ? {} : { projectSlug: req.projectSlug }),
      ...(req.projectRoot === undefined ? {} : { projectRoot: req.projectRoot }),
      ...(req.workspace === undefined ? {} : { workspace: req.workspace }),
      ...submitterField,
      ...seatField,
    };
  }

  if (req.kind === "retro") {
    // The Retro carries its kind plus the optional Project scope (v0.0.38,
    // ADR 0026 §1) and the submitter/seat stamps — whole-ledger always. Any
    // extra field makes it not-a-retro.
    if (req.projectSlug !== undefined && (typeof req.projectSlug !== "string" || req.projectSlug.trim() === "")) return undefined;
    if (req.projectRoot !== undefined && (typeof req.projectRoot !== "string" || req.projectRoot.trim() === "")) return undefined;
    const keys = Object.keys(req).filter(
      (key) => key !== "id" && key !== "kind" && key !== "seat" && key !== "submitter" && key !== "projectSlug" && key !== "projectRoot",
    );
    if (keys.length > 0) return undefined;
    return {
      id: req.id,
      kind: "retro",
      ...(req.projectSlug === undefined ? {} : { projectSlug: req.projectSlug }),
      ...(req.projectRoot === undefined ? {} : { projectRoot: req.projectRoot }),
      ...submitterField,
      ...seatField,
    };
  }
  if (req.kind === "meter") {
    if (typeof req.task !== "string" || typeof req.provider !== "string" || req.provider.trim() === "") return undefined;
    if (req.agent !== undefined && typeof req.agent !== "string") return undefined;
    // Usage keeps the daemon's camelCase verbatim, but only the four metered
    // fields may ride — the spool never guesses what a lane meant.
    if (!usageIsValid(req.usage)) return undefined;
    const usage = { ...(req.usage as Record<string, number>) } as MeterRequest["usage"];
    return {
      id: req.id,
      kind: "meter",
      task: req.task,
      provider: req.provider,
      usage,
      ...(req.agent === undefined ? {} : { agent: req.agent }),
      ...submitterField,
      ...seatField,
    };
  }
  if (req.kind === "repoke") {
    if (typeof req.task !== "string" || typeof req.agent !== "string" || req.agent.trim() === "") return undefined;
    return { id: req.id, kind: "repoke", task: req.task, agent: req.agent, ...submitterField, ...seatField };
  }
  if (req.kind === "needs_human") {
    if (typeof req.task !== "string") return undefined;
    if (typeof req.reason !== "string" || !(NEEDS_HUMAN_REASONS as readonly string[]).includes(req.reason)) return undefined;
    const reason = req.reason as NeedsHumanReason;
    if (!needsHumanEvidenceIsValid(req.evidence, reason)) return undefined;
    return { id: req.id, kind: "needs_human", task: req.task, reason, evidence: req.evidence, ...submitterField, ...seatField };
  }
  if (req.kind === "ask") {
    if (typeof req.task !== "string" || typeof req.command !== "string" || req.command.trim() === "") return undefined;
    for (const field of ["cwd", "agent", "name"] as const) {
      if (req[field] !== undefined && typeof req[field] !== "string") return undefined;
    }
    return {
      id: req.id,
      kind: "ask",
      task: req.task,
      command: req.command,
      ...(req.cwd === undefined ? {} : { cwd: req.cwd as string }),
      ...(req.agent === undefined ? {} : { agent: req.agent as string }),
      ...(req.name === undefined ? {} : { name: req.name as string }),
      ...submitterField,
      ...seatField,
    };
  }
  return undefined;
}

function resolveDaemonArg(daemon?: SurfaceDaemonApi | (() => SurfaceDaemonApi | undefined)): SurfaceDaemonApi | undefined {
  return typeof daemon === "function" ? daemon() : daemon;
}

async function resolveEffectiveSeat(
  factory: Factory,
  daemon: SurfaceDaemonApi | undefined,
  request: SpoolRequest,
): Promise<SpoolSeat | undefined> {
  const submitter =
    "submitter" in request && typeof request.submitter === "string"
      ? request.submitter.trim()
      : request.kind === "claim" && typeof request.agent === "string"
        ? request.agent.trim()
        : "";
  if (submitter !== "" && submitter !== "owner") {
    const correlations = readCorrelations(factory.stateDir);
    for (let i = correlations.length - 1; i >= 0; i -= 1) {
      const rec = correlations[i];
      if (rec !== undefined && (rec.correlationId === submitter || rec.agentId === submitter)) {
        return rec.role;
      }
    }
    if (daemon?.agents?.list !== undefined) {
      try {
        const page = await daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
        const matched = page.entries.find((e) => e.agent.id === submitter && e.agent.archivedAt === null)?.agent;
        const liveSeat = matched?.labels?.seat;
        if (liveSeat === "supervisor" || liveSeat === "lead" || liveSeat === "agent") {
          return liveSeat;
        }
      } catch {
        // best-effort live daemon seat corroboration
      }
    }
    for (const reg of listProjectRegistrations(factory.stateDir)) {
      if (reg.supervisor === submitter) return "supervisor";
      if (reg.lead === submitter) return "lead";
    }
  }
  return request.seat;
}

function lastTaskAgentForTask(factory: Factory, task: string): string | undefined {
  let agentId: string | undefined;
  for (const evt of factory.ledger.events) {
    if ("task" in evt && evt.task === task) {
      if (evt.event === "contract_set") agentId = undefined;
      else if (evt.event === "claim_reported" && typeof evt.agent === "string" && evt.agent !== "") agentId = evt.agent;
      else if (evt.event === "repoke_dispatched" && typeof evt.agent === "string" && evt.agent !== "") agentId = evt.agent;
      else if (evt.event === "meter_written" && typeof evt.agent === "string" && evt.agent !== "") agentId = evt.agent;
    }
  }
  return agentId;
}

async function archiveTaskAgentBestEffort(daemon: SurfaceDaemonApi | undefined, agentId: string | undefined): Promise<void> {
  if (daemon === undefined || typeof agentId !== "string" || agentId === "") return;
  try {
    await daemon.agents.ref(agentId).archive();
  } catch {
    // best-effort archive
  }
}

async function resolveSpawnWorkspaceAndParent(
  factory: Factory,
  daemon: SurfaceDaemonApi | undefined,
  task: string,
  explicitWorktree?: string,
  home?: string,
): Promise<{ leadAgentId?: string; workspaceId?: string; projectSlug?: string }> {
  const contract = factory.contractFor(task);
  if (contract === undefined) return {};
  const project = resolveProject(contract.workspace);
  if (!project.ok) return {};
  const reg = readProjectRegistration(factory.stateDir, project.slug);
  let projectWorkspaceId = reg?.workspaceId;
  let paseoProjectId = reg?.paseoProjectId;
  if (paseoProjectId === undefined && daemon?.workspaces?.open !== undefined) {
    try {
      const opened = await daemon.workspaces.open({ cwd: project.root });
      // `workspaces.open` only seeds an UNKNOWN workspaceId or backfills
      // `paseoProjectId` — an already-persisted workspaceId (the Supervisor's
      // main Workspace, v0.0.31 ADR 0017 §5) is never overwritten by a fresh
      // open, mirroring ensureSeat's law (surface-rpc.ts).
      if (projectWorkspaceId === undefined && typeof opened?.id === "string" && opened.id !== "") projectWorkspaceId = opened.id;
      if (typeof opened?.projectId === "string" && opened.projectId !== "") paseoProjectId = opened.projectId;
    } catch {
      // best-effort workspace open
    }
  }
  let leadAgentId: string | undefined;
  if (daemon !== undefined) {
    try {
      const page = await daemon.agents.list({ filter: { labels: { seat: "lead", project: project.slug }, includeArchived: false, includeBackground: true } });
      const liveLead = page.entries.find((e) => e.agent.archivedAt === null)?.agent;
      if (liveLead !== undefined) leadAgentId = liveLead.id;
    } catch {
      // best-effort lead lookup
    }
  }
  if (leadAgentId === undefined) leadAgentId = reg?.lead;

  const worktree = explicitWorktree ?? factory.worktreeFor(task);
  let workspaceId = reg?.taskWorkspaces?.[task];
  if (workspaceId !== undefined && isPaseoWorkspaceArchivedOnDisk(home, workspaceId)) {
    const restored = await restoreDaemonWorkspaceViaWs(home, workspaceId);
    if (!restored.ok) workspaceId = undefined;
  }
  if (workspaceId === undefined && worktree !== undefined && daemon?.workspaces?.create !== undefined) {
    try {
      const created = await daemon.workspaces.create({
        // The Task worktree Workspace's sidebar title (v0.0.31, ADR 0017 §2/§5):
        // `Peer · <Task> — <short summary>` from the contract description's
        // first clause — never the internal `<project-slug>` hash.
        title: contract.execution ? `${SCRUM_ROLE_TITLES[contract.execution.role]} · ${task}` : formatPeerWorkspaceTitle(task, contract.description),
        source: { kind: "directory", path: worktree, ...(paseoProjectId !== undefined ? { projectId: paseoProjectId } : {}) },
      });
      if (typeof created?.id === "string" && created.id !== "") workspaceId = created.id;
    } catch {
      // best-effort workspace registration
    }
  }
  if (
    projectWorkspaceId !== reg?.workspaceId ||
    paseoProjectId !== reg?.paseoProjectId ||
    (workspaceId !== undefined && workspaceId !== reg?.taskWorkspaces?.[task])
  ) {
    writeProjectRegistration(factory.stateDir, project.slug, {
      root: project.root,
      ...(projectWorkspaceId !== undefined ? { workspaceId: projectWorkspaceId } : {}),
      ...(paseoProjectId !== undefined ? { paseoProjectId } : {}),
      ...(workspaceId !== undefined ? { taskWorkspaces: { [task]: workspaceId } } : {}),
    });
  }
  return {
    projectSlug: project.slug,
    ...(leadAgentId !== undefined ? { leadAgentId } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
  };
}

/**
 * The peer spawn's effective provider (v0.0.27, ADR 0017 §2; v0.0.38, ADR
 * 0026 §1): when the spawn rides the Project's configured `worker` lane —
 * no explicit provider, the `worker` alias, a `factory-peer` id, or the
 * worker lane restated — it resolves THAT Project's (or the machine table's)
 * worker lane and returns its `<provider>/<model>[:<thinking>]` DIRECTLY.
 * The prefix is never rewritten to the daemon-global `factory-peer/<model>`:
 * `factory-peer` extends whatever the machine table last reconciled, so a
 * Project on another provider family would land on the wrong adapter and
 * die at spawn. An explicit provider/model override naming a different lane
 * keeps the requested value verbatim (full backward compatibility).
 */
async function resolvePeerSpawnProvider(
  factory: Factory,
  requestedProvider: string,
  projectSlug: string | undefined,
): Promise<string> {
  const loaded = projectSlug !== undefined ? loadLanes(factory.stateDir, projectSlug) : loadLanes(factory.stateDir);
  const parsedWorker = loaded.ok ? parseLane(loaded.lanes.worker) : undefined;
  const parsedRequested = requestedProvider !== "" ? parseLane(requestedProvider) : undefined;
  const ridesWorkerLane =
    requestedProvider === "" ||
    requestedProvider === "worker" ||
    requestedProvider.split("/")[0] === FACTORY_SEAT_PROVIDER_IDS.agent;
  if (!ridesWorkerLane) {
    if (projectSlug === undefined || !loaded.ok) return requestedProvider;
    const isDefaultWorkerLane =
      parsedRequested !== undefined &&
      parsedWorker !== undefined &&
      (parsedRequested.provider === parsedWorker.provider || parsedRequested.provider === FACTORY_SEAT_PROVIDER_IDS.agent) &&
      (parsedRequested.model === parsedWorker.model || parsedWorker.model.endsWith(`/${parsedRequested.model}`));
    if (!isDefaultWorkerLane) return requestedProvider; // an explicit override keeps its own model
  }
  if (parsedWorker === undefined) return requestedProvider; // no usable worker lane — never a guess
  const thinking = parsedRequested?.thinking ?? parsedWorker.thinking;
  return thinking !== undefined
    ? `${parsedWorker.provider}/${parsedWorker.model}:${thinking}`
    : `${parsedWorker.provider}/${parsedWorker.model}`;
}

/**
 * Runs one request through the factory — the single place a spool request
 * becomes Ledger events or a Gate run. Never throws: every failure becomes a
 * red-flagged reply, so the waiting CLI always hears something. `ask` requests
 * need the choke's handler (the shell passes `createChoke(...).spoolAskHandler`);
 * without one they are refused loudly, never silently allowed.
 */
const peerLifecycleByFactory = new WeakMap<Factory, Map<string, Promise<unknown>>>();

export async function handleSpoolRequest(
  factory: Factory,
  request: SpoolRequest,
  deps: SpoolDeps = {},
): Promise<SpoolReply> {
  if (request.kind === "upgrade" || request.kind === "history_import" || request.kind === "history_import_status") return handleAdmittedSpoolRequest(factory, request, deps);
  if ((request.kind === "reset" || request.kind === "delete") && !factory.history.maintenanceActive) return factory.history.withExclusiveMaintenance(() => handleAdmittedSpoolRequest(factory, request, deps));
  const admitted = () => factory.history.runOperation(() => handleAdmittedSpoolRequest(factory, request, deps), { newWork: !["ask", "meter", "repoke", "respawn", "needs_human"].includes(request.kind) });
  const run = () => {
    const workspace = request.kind === "contract" ? request.workspace : (request.kind === "spawn" || request.kind === "respawn") ? factory.contractFor(request.task)?.workspace : undefined;
    const project = workspace === undefined ? undefined : resolveProject(workspace);
    return project?.ok ? withExecutionLane(factory.stateDir, project.slug, admitted) : admitted();
  };
  if (request.kind !== "spawn" && request.kind !== "contract") return run();
  // Spool requests run concurrently. Serialize only Peer lifecycle operations
  // for this Task, so two different spawn prompts cannot pass the same census.
  let lanes = peerLifecycleByFactory.get(factory);
  if (lanes === undefined) { lanes = new Map(); peerLifecycleByFactory.set(factory, lanes); }
  const previous = lanes.get(request.task) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(run);
  lanes.set(request.task, pending);
  try { return await pending; }
  finally { if (lanes.get(request.task) === pending) lanes.delete(request.task); }
}

async function handleAdmittedSpoolRequest(factory: Factory, request: SpoolRequest, deps: SpoolDeps): Promise<SpoolReply> {
  const { ask: askHandler, leadRotate: leadRotateHandler, leadDispatch: leadDispatchHandler, peerMail: peerMailHook, supervisorDispatch: supervisorDispatchHandler, supervisorReport: supervisorReportHandler, daemon, projectReset: projectResetHandler, projectDelete: projectDeleteHandler, sanitizeLane, home } = deps;
  const resolvedDaemon = resolveDaemonArg(daemon);
  try {
    const effectiveSeat = await resolveEffectiveSeat(factory, resolvedDaemon, request);
    if (request.kind === "scrum_command" || request.kind === "execution_mode") {
      const correlation = readCorrelations(factory.stateDir).find(r => r.correlationId === request.submitter || r.agentId === request.submitter);
      if (request.submitter !== "owner" && !correlation) throw new FactoryError("scrum-caller-unauthorized", "authenticated correlation required");
      if (correlation && request.projectRoot !== undefined) {
        const target = resolveProject(request.projectRoot);
        if (!target.ok || target.slug !== correlation.projectSlug) throw new FactoryError("cross-project-refused", "caller belongs to another Project");
      }
      const authority = correlation?.role ?? (effectiveSeat ?? "owner");
      if (request.kind === "execution_mode") {
        if (authority !== "owner") throw new FactoryError("owner-config-required", "execution selection requires Owner");
        if (!deps.executionSetMode) throw new FactoryError("execution-unavailable", "no mode adapter installed");
        return await deps.executionSetMode(request);
      }
      if (!deps.scrumCommand) throw new FactoryError("scrum-unavailable", "no Scrum adapter installed");
      return await deps.scrumCommand(request, { authority, actor: request.submitter });
    }
    if (request.kind === "upgrade") {
      if (effectiveSeat !== undefined) return { id: request.id, ok: false, code: "seat-cannot-upgrade", message: "Persistent history upgrade/restore requires Owner authority" };
      return upgradeReply(request.id, await upgradeFactory(factory, { ...request, controlId: request.id }));
    }
    if (request.kind === "history_import" || request.kind === "history_import_status") {
      if (effectiveSeat === "agent" || effectiveSeat === "lead") return { id: request.id, ok: false, code: "seat-cannot-import", message: "History admission requires Owner authority" };
      if (request.kind === "history_import" && request.sources !== undefined) {
        if (request.project === undefined) factory.history.stage(request.sources);
        else factory.history.stageForProject(request.project, request.sources);
      }
      else factory.history.drain();
      return { id: request.id, ok: true, summary: "Ledger import admission status", historyImports: factory.history.allStatus() };
    }
    // Hard Spool Command Authority by Seat (v0.0.23, ADR 0015 §1; v0.0.24, ADR 0015 §6; v0.0.35, ADR 0024).
    if (
      request.kind === "reset" &&
      (effectiveSeat === "supervisor" || effectiveSeat === "lead" || effectiveSeat === "agent")
    ) {
      return {
        id: request.id,
        ok: false,
        code: "seat-cannot-reset",
        message: `Seat ${effectiveSeat} cannot call factory reset; project reset is an Owner-only action.`,
      };
    }
    if (
      request.kind === "delete" &&
      (effectiveSeat === "supervisor" || effectiveSeat === "lead" || effectiveSeat === "agent")
    ) {
      return {
        id: request.id,
        ok: false,
        code: "seat-cannot-delete",
        message: `Seat ${effectiveSeat} cannot call factory project delete; project deletion is an Owner-only action.`,
      };
    }
    if (
      (request.kind === "contract" || request.kind === "spawn" || request.kind === "respawn") &&
      effectiveSeat === "supervisor"
    ) {
      return {
        id: request.id,
        ok: false,
        code: "supervisor-cannot-contract-or-run",
        message: `Supervisor cannot call factory ${request.kind}; dispatch the directive to Lead via 'factory lead dispatch --workspace <dir> --message <directive>' and end your turn.`,
      };
    }

    if (
      (request.kind === "contract" ||
        request.kind === "spawn" ||
        request.kind === "respawn" ||
        request.kind === "repoke" ||
        request.kind === "needs_human" ||
        request.kind === "meter" ||
        request.kind === "accept" ||
        (request.kind === "lead_dispatch" && request.from !== "peer") ||
        request.kind === "supervisor_dispatch" ||
        request.kind === "supervisor_report" ||
        request.kind === "lead_rotate" ||
        request.kind === "retro") &&
      effectiveSeat === "agent"
    ) {
      return {
        id: request.id,
        ok: false,
        code: "agent-cannot-orchestrate",
        message: `Working Agent cannot call factory ${request.kind}; working Agents may only submit claims via 'factory-claim --task <task> --sha <sha>'.`,
      };
    }
    const taskPeers = async (task: string) => {
      const contract = factory.contractFor(task);
      const project = contract === undefined ? undefined : resolveProject(contract.workspace);
      if (resolvedDaemon === undefined || !project?.ok) return [];
      const page = await resolvedDaemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
      return boundTaskPeers({ stateDir: factory.stateDir, slug: project.slug, task, events: factory.ledger.events, live: page.entries.map(entry => entry.agent) });
    };
    const retirePeers = async (peers: Awaited<ReturnType<typeof taskPeers>>) => {
      for (const peer of peers) {
        const stopped = await (deps.stopAgent ?? stopAgentViaCli)(peer.id, home);
        if (!stopped.ok) throw new FactoryError("peer-stop-failed", `cannot stop Peer ${peer.id}: ${stopped.reason}`);
        await resolvedDaemon!.agents.ref(peer.id).archive();
      }
    };
    if (request.kind === "contract") {
      const previousPeers = await taskPeers(request.task);
      const scrum = prepareProjectContract(factory, { ...request, retirePeerIds: previousPeers.map(p => p.id) });
      const disposition = (type: "contract_retired" | "contract_rejected", error?: FactoryError) => {
        if (!scrum.execution || !scrum.operationId) return;
        const project = resolveProject(request.workspace);
        if (!project.ok) return;
        const run = readScrumRun(factory.stateDir, project.slug, scrum.execution.runId);
        commandScrumRun(factory.stateDir, project.slug, run.runId, { type, task: request.task, operationId: scrum.operationId, requestId: `${scrum.operationId}:${type}`, expectedRevision: run.revision, ...(error ? { code: error.code, message: error.message } : {}) } as Parameters<typeof commandScrumRun>[3]);
      };
      const finishRetirement = async () => {
        if (scrum.execution) {
          const ids = scrum.retirePeerIds ?? [];
          if (ids.length && !resolvedDaemon) throw new FactoryError("peer-retirement-unavailable", "daemon required to reconcile retirement");
          await retirePeers(previousPeers.filter(p => ids.includes(p.id)));
          disposition("contract_retired");
        } else await retirePeers(previousPeers);
      };
      if (scrum.existing) {
        await finishRetirement();
        return { id: request.id, ok: true, summary: `reconciled Scrum Contract ${request.task}` };
      }
      let contractEvt: ReturnType<typeof factory.setContract>;
      const previousEpoch = factory.contractFor(request.task)?.seq;
      try { contractEvt = factory.setContract({
        task: request.task,
        workspace: request.workspace,
        gate: scrum.gate ?? request.gate,
        ...(request.artifact === undefined ? {} : { artifact: request.artifact }),
        ...(request.base === undefined ? {} : { base: request.base }),
        ...(request.scope === undefined ? {} : { scope: request.scope }),
        ...(request.skills === undefined || request.skills.length === 0 ? {} : { skills: request.skills }),
        ...(request.freshEyes === undefined ? {} : { freshEyes: request.freshEyes }),
        ...(request.watch === undefined ? {} : { watch: true }),
        ...(request.description === undefined ? {} : { description: request.description }),
        ...(scrum.execution === undefined ? {} : { execution: scrum.execution, scope: scrum.scope, artifact: scrum.artifact }),
        by: request.submitter,
        ...(effectiveSeat === undefined ? {} : { seat: effectiveSeat }),
      });
      } catch (error) {
        if (error instanceof FactoryError && ["invalid-contract", "invalid-task", "eye-unconfigured", "watch-unconfigured", "already-accepted", "gate-running", "workspace-conflict"].includes(error.code) && factory.contractFor(request.task)?.seq === previousEpoch) disposition("contract_rejected", error);
        throw error;
      }
      if (contractEvt.execution) bindScrumEpoch(factory, request.task, contractEvt.seq, contractEvt.execution, `${scrum.operationId}:bound`, scrum.operationId);
      await finishRetirement();
      return {
        id: request.id,
        ok: true,
        summary:
          `contract set for ${request.task}: \`${request.gate}\` in ${request.workspace}` +
          `${contractEvt.freshEyes === true ? " · fresh eyes ON" : ""}${request.watch === true ? " · watch ON" : ""} · by ${request.submitter}`,
      };
    }
    if (request.kind === "claim") {
      const outcome = await factory.claim({
        task: request.task,
        sha: request.sha,
        ...(request.agent === undefined ? {} : { agent: request.agent }),
      });
      // The peer hook (v0.0.20, ADR 0013 §4): a verdict is a terminal Task
      // outcome the Project's Lead must hear — the hook appends `mail_queued`
      // (`from: "peer"`) on the owning Project's lane, held while a Driver
      // wave is in flight. It never rejects; a notification failure must not
      // break the verdict's own reply.
      await peerMailHook?.({
        task: request.task,
        kind: "verdict",
        text: `Task ${request.task} attempt ${outcome.attempt} ended ${outcome.verdict.toUpperCase()}${outcome.gate.note === "" ? "" : ` — note: ${outcome.gate.note}`}`,
      });
      return {
        id: request.id,
        ok: true,
        summary: `task ${request.task} attempt ${outcome.attempt}: ${outcome.verdict.toUpperCase()}`,
        attempt: outcome.attempt,
        verdict: outcome.verdict,
        reportPath: outcome.reportPath,
        note: outcome.gate.note,
      };
    }
    if (request.kind === "ask") {
      if (askHandler === undefined) {
        return {
          id: request.id,
          ok: false,
          code: "ask-unavailable",
          message: "this daemon's factory plugin does not judge synthetic asks — update the plugin to v0.0.4+",
        };
      }
      return askHandler(request);
    }
    if (request.kind === "lead_rotate") {
      // The Lead rotation (v0.0.14): a daemon act, delegated the same way the
      // choke's ask is — the shell passes the surface handlers' leadRotate,
      // which finds, cancels, and archives the Project's seat=lead agent.
      if (leadRotateHandler === undefined) {
        return {
          id: request.id,
          ok: false,
          code: "lead-rotate-unavailable",
          message: "this daemon's factory plugin does not rotate Leads — update the plugin to v0.0.14+",
        };
      }
      return await leadRotateHandler(request);
    }
    if (request.kind === "lead_dispatch") {
      // The Lead dispatch (v0.0.20): delegated to the Lead-mailbox runtime —
      // the single writer of mailbox.jsonl — the same way the rotation is
      // delegated to the surface handlers. Without the runtime the request is
      // refused loudly, never silently queued nowhere.
      if (leadDispatchHandler === undefined) {
        return {
          id: request.id,
          ok: false,
          code: "lead-dispatch-unavailable",
          message: "this daemon's factory plugin does not dispatch Lead mail — update the plugin to v0.0.20+",
        };
      }
      return await leadDispatchHandler(request);
    }
    if (request.kind === "supervisor_dispatch") {
      const normalizedRequest = effectiveSeat === undefined ? request : { ...request, seat: effectiveSeat };
      if (supervisorDispatchHandler !== undefined) {
        return await supervisorDispatchHandler(normalizedRequest);
      }
      if (effectiveSeat === "supervisor" && leadDispatchHandler !== undefined) {
        const leadReply = await leadDispatchHandler({
          id: request.id,
          kind: "lead_dispatch",
          ...(request.project === undefined ? {} : { project: request.project }),
          ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
          from: "supervisor",
          message: request.message,
          ...(request.submitter === undefined ? {} : { submitter: request.submitter }),
          seat: "supervisor",
        });
        if (!leadReply.ok) return leadReply;
        return {
          ...leadReply,
          summary: `directive dispatched to Lead (${leadReply.leadAgentId ?? "lead"}) — end your turn now and wait for Lead's report`,
        };
      }
      return {
        id: request.id,
        ok: false,
        code: "supervisor-dispatch-unavailable",
        message: "this daemon's factory plugin does not dispatch Supervisor mail — update the plugin to v0.0.23+",
      };
    }
    if (request.kind === "supervisor_report") {
      if (supervisorReportHandler === undefined) {
        return {
          id: request.id,
          ok: false,
          code: "supervisor-report-unavailable",
          message: "this daemon's factory plugin does not handle Supervisor reports — update the plugin to v0.0.23+",
        };
      }
      return await supervisorReportHandler(effectiveSeat === undefined ? request : { ...request, seat: effectiveSeat });
    }
    if (request.kind === "reset") {
      if (projectResetHandler === undefined) {
        return {
          id: request.id,
          ok: false,
          code: "project-reset-unavailable",
          message: "this daemon's factory plugin does not handle Project resets — update the plugin to v0.0.24+",
        };
      }
      return await projectResetHandler(request);
    }
    if (request.kind === "delete") {
      if (projectDeleteHandler === undefined) {
        return {
          id: request.id,
          ok: false,
          code: "project-delete-unavailable",
          message: "this daemon's factory plugin does not handle Project deletion — update the plugin to v0.0.35+",
        };
      }
      return await projectDeleteHandler(request);
    }

    if (request.kind === "spawn") {
      const frozenLane = await scrumSpawnLane(factory, request.task, request, request.providerExplicit ? request.provider : undefined, request.id, sanitizeLane);
      const peers = await taskPeers(request.task);
      const running = peers.find(peerIsRunning);
      if (running !== undefined) {
        const message = `Peer ${running.id} is already running in the Task worktree for ${request.task}; wait for its completion mail or call lead_set_contract first to open a new epoch`;
        const event = factory.ledger.append({ event: "spawn_refused", task: request.task, provider: request.provider, arity: request.arity, rule: "spawn:peer-already-running", reason: "peer-already-running" });
        return { id: request.id, ok: false, code: "peer-already-running", message, event };
      }
      await retirePeers(peers);
      // The driver's arrival (v0.0.5): one ledger line either way, then the
      // reply the driver keys its next move on — create the agent, or report
      // the refusal and carry on with the invocation's other tasks. The
      // worktree (v0.0.14) rides the line so claim/gate/choke bind to it.
      const preSpawnContract = factory.contractFor(request.task);
      if (preSpawnContract !== undefined) {
        const allEvents = factory.ledger.events;
        const epochTaskEvents = allEvents.filter(
          (e) => e.seq > preSpawnContract.seq && "task" in e && e.task === request.task,
        );
        const hasPriorClaims = epochTaskEvents.some((e) => e.event === "claim_reported");
        const hasAccepted = allEvents.some((e) => "task" in e && e.task === request.task && e.event === "attempt_accepted");
        const upstreamLandedAfterContract = allEvents.some(
          (e) => e.seq > preSpawnContract.seq && e.event === "attempt_accepted",
        );
        if (preSpawnContract.execution === undefined && !hasPriorClaims && !hasAccepted && upstreamLandedAfterContract && existsSync(preSpawnContract.workspace)) {
          const headOut = spawnSync("git", ["-C", preSpawnContract.workspace, "rev-parse", "HEAD"], {
            encoding: "utf8",
            timeout: 5_000,
          });
          const currentHead = headOut.status === 0 ? headOut.stdout.trim() : "";
          if (/^[0-9a-f]{40}$/i.test(currentHead) && currentHead !== preSpawnContract.base) {
            factory.setContract({
              task: preSpawnContract.task,
              workspace: preSpawnContract.workspace,
              gate: preSpawnContract.gate,
              artifact: preSpawnContract.artifact,
              base: currentHead,
              ...(preSpawnContract.scope !== undefined ? { scope: [...preSpawnContract.scope] } : {}),
              ...(preSpawnContract.skills !== undefined ? { skills: [...preSpawnContract.skills] } : {}),
              ...(preSpawnContract.freshEyes !== undefined ? { freshEyes: preSpawnContract.freshEyes } : {}),
              ...(preSpawnContract.watch === true ? { watch: true } : {}),
              ...(preSpawnContract.description !== undefined ? { description: preSpawnContract.description } : {}),
              ...(preSpawnContract.execution === undefined ? {} : { execution: preSpawnContract.execution }),
            });
            if (request.worktree !== undefined && existsSync(request.worktree)) {
              const ancOut = spawnSync(
                "git",
                ["-C", request.worktree, "merge-base", "--is-ancestor", currentHead, "HEAD"],
                { encoding: "utf8", timeout: 5_000 },
              );
              if (ancOut.status !== 0) {
                spawnSync("git", ["-C", request.worktree, "checkout", "-B", `factory/${request.task}`, currentHead], {
                  encoding: "utf8",
                  timeout: 5_000,
                });
              }
            }
          }
        }
      }
      const sanitizedProvider =
        frozenLane ?? (sanitizeLane !== undefined && request.provider !== ""
          ? await sanitizeLane(request.provider)
          : request.provider);
      const decision = factory.requestSpawn({
        task: request.task,
        provider: sanitizedProvider,
        arity: request.arity,
        ...(request.worktree === undefined ? {} : { worktree: request.worktree }),
      });
      if (decision.outcome === "refused") {
        return { id: request.id, ok: false, code: decision.code, message: decision.event.reason, event: decision.event };
      }
      const spawnMeta = await resolveSpawnWorkspaceAndParent(factory, resolvedDaemon, request.task, request.worktree, home);
      let spawnedAgentId: string | undefined;
      if (request.prompt !== undefined && request.prompt !== "" && resolvedDaemon !== undefined) {
        // The Peer spawns under the `factory-peer` role provider when it can
        // (v0.0.27, ADR 0017 §2) — `paseoTools` off, seat env on — falling back
        // to the requested lane verbatim.
        const peerProvider = frozenLane === undefined ? await resolvePeerSpawnProvider(factory, sanitizedProvider, spawnMeta.projectSlug) : sanitizedProvider;
        const parsedPeer = parseLane(peerProvider);
        const peerConfig =
          parsedPeer?.thinking !== undefined
            ? { provider: `${parsedPeer.provider}/${parsedPeer.model}`, thinkingOptionId: parsedPeer.thinking }
            : { provider: peerProvider };
        const contract = factory.contractFor(request.task);
        let effectivePrompt = request.prompt;
        if (contract !== undefined && effectivePrompt.startsWith(`Execute task ${request.task}:`)) {
          const enriched: string[] = [];
          if (contract.skills !== undefined && contract.skills.length > 0) {
            enriched.push(
              `Required skills to open first: ${contract.skills.join(", ")} (read ~/.agents/skills/<skill>/SKILL.md or .agents/skills/<skill>/SKILL.md before starting)`,
            );
          }
          if (contract.description !== undefined && contract.description.trim() !== "") {
            enriched.push(`Task (${request.task}): ${contract.description.trim()}`);
          }
          if (contract.scope !== undefined && contract.scope.length > 0) {
            enriched.push(`Allowed scope: ${contract.scope.join(", ")}`);
          }
          enriched.push(effectivePrompt);
          effectivePrompt = enriched.join("\n\n");
        }
        const targetCwd = request.worktree ?? contract?.workspace ?? "";
        const proj = contract !== undefined ? resolveProject(contract.workspace) : undefined;
        const peerTitle = contract?.execution ? `${SCRUM_ROLE_TITLES[contract.execution.role]} · ${request.task}` : formatPeerAgentTitle(request.task);
        const labels: Record<string, string> = {
          ...(contract?.execution ? { execution: "scrum", run: contract.execution.runId, specialization: contract.execution.role, epoch: String(contract.seq) } : {}),
          seat: "agent",
          task: request.task,
          ...(proj?.ok ? { project: proj.slug } : {}),
        };
        const createPeerInWorkspace = async (targetWorkspaceId: string): Promise<{ id: string }> =>
          resolvedDaemon.workspaces!.ref(targetWorkspaceId).agents.create({
            config: peerConfig,
            // The Agent tab inside the Task worktree Workspace reads
            // `Peer · <Task>` (v0.0.31, ADR 0017 §2) — never the bare task id.
            title: peerTitle,
            labels,
            prompt: effectivePrompt,
            ...(spawnMeta.leadAgentId !== undefined ? { parent: spawnMeta.leadAgentId } : {}),
          });
        if (spawnMeta.workspaceId !== undefined && resolvedDaemon.workspaces !== undefined) {
          try {
            const created = await createPeerInWorkspace(spawnMeta.workspaceId);
            spawnedAgentId = created.id;
          } catch {
            const restored = await restoreDaemonWorkspaceViaWs(home, spawnMeta.workspaceId);
            if (restored.ok) {
              try {
                const created = await createPeerInWorkspace(spawnMeta.workspaceId);
                spawnedAgentId = created.id;
              } catch {
                // fall through to workspace recreate / daemon.agents.create
              }
            }
            if (
              spawnedAgentId === undefined &&
              targetCwd !== "" &&
              typeof resolvedDaemon.workspaces.create === "function"
            ) {
              try {
                const reg = proj?.ok ? readProjectRegistration(factory.stateDir, proj.slug) : undefined;
                const recreated = await resolvedDaemon.workspaces.create({
                  title: formatPeerWorkspaceTitle(request.task, contract?.description),
                  source: {
                    kind: "directory",
                    path: targetCwd,
                    ...(reg?.paseoProjectId !== undefined ? { projectId: reg.paseoProjectId } : {}),
                  },
                });
                if (typeof recreated?.id === "string" && recreated.id !== "") {
                  spawnMeta.workspaceId = recreated.id;
                  if (proj?.ok) {
                    writeProjectRegistration(factory.stateDir, proj.slug, {
                      root: proj.root,
                      taskWorkspaces: { [request.task]: recreated.id },
                    });
                  }
                  const created = await createPeerInWorkspace(recreated.id);
                  spawnedAgentId = created.id;
                }
              } catch {
                // fall through to daemon.agents.create
              }
            }
            if (spawnedAgentId === undefined && typeof resolvedDaemon.agents?.create === "function") {
              const created = await resolvedDaemon.agents.create({
                config: peerConfig,
                cwd: targetCwd,
                title: peerTitle,
                labels,
                prompt: effectivePrompt,
              });
              spawnedAgentId = created.id;
            }
          }
        } else if (typeof resolvedDaemon.agents?.create === "function") {
          const created = await resolvedDaemon.agents.create({
            config: peerConfig,
            cwd: targetCwd,
            // The Agent tab reads `Peer · <Task>` on the legacy shared-checkout
            // path too (v0.0.31, ADR 0017 §2).
            title: peerTitle,
            labels,
            prompt: effectivePrompt,
            ...(spawnMeta.leadAgentId !== undefined ? { parent: spawnMeta.leadAgentId } : {}),
          });
          spawnedAgentId = created.id;
        }
        if (spawnedAgentId !== undefined && proj?.ok) {
          const correlations = new CorrelationRegistry(factory.stateDir);
          if (correlations.findByAgentId(spawnedAgentId) === undefined) {
            const unassociated = correlations
              .list()
              .findLast((r) => r.role === "agent" && r.projectSlug === proj.slug && r.task === request.task && r.agentId === undefined);
            if (unassociated !== undefined) {
              correlations.associate(unassociated.correlationId, spawnedAgentId);
            } else {
              correlations.issue({
                role: "agent",
                projectSlug: proj.slug,
                projectRoot: proj.root,
                task: request.task,
                agentId: spawnedAgentId,
              });
            }
          }
        }
      }
      return {
        id: request.id,
        ok: true,
        summary: `spawn dispatched for ${request.task} under ${sanitizedProvider} (n=${request.arity})${spawnedAgentId ? ` → agent ${spawnedAgentId}` : ""}`,
        event: decision.event,
        ...spawnMeta,
        ...(spawnedAgentId !== undefined ? { agentId: spawnedAgentId } : {}),
      };
    }
    if (request.kind === "respawn") {
      const frozenLane = await scrumSpawnLane(factory, request.task, request, undefined, request.id, sanitizeLane);
      // The Lead's one automatic Respawn per progress marker (v0.0.12, ADR 0008):
      // one ledger line either way, with `event` attached so the driver can key
      // the replacement `agent.create.request` by `${task}-respawn-${event.seq}`.
      const sanitizedProvider =
        frozenLane ?? (sanitizeLane !== undefined && request.provider !== ""
          ? await sanitizeLane(request.provider)
          : request.provider);
      const decision = factory.respawn({
        task: request.task,
        provider: sanitizedProvider,
        died_agent: request.died_agent,
      });
      if (decision.outcome === "refused") {
        return { id: request.id, ok: false, code: decision.code, message: decision.event.reason, event: decision.event };
      }
      await archiveTaskAgentBestEffort(resolvedDaemon, request.died_agent);
      const spawnMeta = await resolveSpawnWorkspaceAndParent(factory, resolvedDaemon, request.task, undefined, home);
      return {
        id: request.id,
        ok: true,
        summary: `respawn dispatched for ${request.task} under ${sanitizedProvider} (replacing ${request.died_agent.slice(0, 12)})`,
        event: decision.event,
        ...spawnMeta,
      };
    }
    if (request.kind === "meter") {
      // The driver's post-verdict capture (v0.0.8): one line, validated and
      // appended. The reply's summary carries the dollars the lane reported
      // (or their named absence) — the driver's log line is where the run's
      // cost first becomes visible to the operator.
      const event = factory.meter({
        task: request.task,
        provider: request.provider,
        usage: request.usage,
        ...(request.agent === undefined ? {} : { agent: request.agent }),
      });
      await archiveTaskAgentBestEffort(resolvedDaemon, request.agent ?? lastTaskAgentForTask(factory, request.task));
      const dollars = event.usage.totalCostUsd;
      const cost = dollars === undefined ? "no dollars reported (recorded as absent)" : `$${dollars.toFixed(2)}`;
      return { id: request.id, ok: true, summary: `meter for ${request.task} under ${request.provider}: ${cost}` };
    }
    if (request.kind === "repoke") {
      // The Lead's one spend (v0.0.10): one ledger line either way — the
      // dispatch line is the spent marker, and every refusal is a recorded
      // fact. Only on ok does the driver send its fixed message.
      const decision = factory.repoke(request.task, request.agent);
      if (decision.outcome === "refused") {
        return { id: request.id, ok: false, code: decision.code, message: decision.event.reason };
      }
      if (effectiveSeat === "lead" && resolvedDaemon?.agents?.ref !== undefined) {
        try {
          const contract = factory.contractFor(request.task);
          const nudge = `Re-poke from Lead on task ${request.task}: continue inside your Task worktree on branch factory/${request.task}, run the gate \`${contract?.gate ?? ""}\`, commit your changes, and call \`paseo-factory_agent_claim\` (or \`agent_claim\`).`;
          await resolvedDaemon.agents.ref(request.agent).send(nudge);
        } catch {
          // best-effort nudge delivery when invoked directly by Lead MCP tool
        }
      }
      return {
        id: request.id,
        ok: true,
        summary: `re-poke dispatched for ${request.task} → agent ${request.agent.slice(0, 12)} — the task's one spend`,
      };
    }
    if (request.kind === "needs_human") {
      // The stall's or ceiling's named end (v0.0.10 / v0.0.12): one line,
      // evidence pair attached. The meter's law — a refused submission throws,
      // no line, and the reply carries the code so the driver can report it.
      let effectiveEvidence = request.evidence;
      if (effectiveSeat === "lead") {
        const contract = factory.contractFor(request.task);
        if (contract !== undefined) {
          const epochHistory = factory.ledger.eventsFor(request.task).filter((e) => e.seq >= contract.seq);
          if (request.reason === "attempt-ceiling") {
            const gate3 = epochHistory.findLast(
              (e) => e.event === "gate_finished" && e.attempt === 3 && e.verdict === "red",
            );
            if (gate3 !== undefined) {
              effectiveEvidence = { attempt: 3, gate: gate3.seq };
            }
          } else if (request.reason === "denied-again" || request.reason === "silent-after-repoke") {
            const denial = epochHistory.findLast((e) => e.event === "permit_denied");
            const repoke = epochHistory.findLast((e) => e.event === "repoke_dispatched");
            if (denial !== undefined && repoke !== undefined) {
              effectiveEvidence = { denial: denial.seq, repoke: repoke.seq };
            }
          } else if (request.reason === "died-after-respawn") {
            const spawnEvt = epochHistory.findLast((e) => e.event === "spawn_dispatched");
            const respawnEvt = epochHistory.findLast((e) => e.event === "respawn_dispatched");
            if (spawnEvt !== undefined && respawnEvt !== undefined && respawnEvt.seq > spawnEvt.seq) {
              effectiveEvidence = { spawn: spawnEvt.seq, respawn: respawnEvt.seq };
            }
          }
        }
      }
      const event = factory.needsHuman({ task: request.task, reason: request.reason, evidence: effectiveEvidence });
      await archiveTaskAgentBestEffort(resolvedDaemon, lastTaskAgentForTask(factory, request.task));
      const detail =
        "denial" in event.evidence
          ? `denial seq ${event.evidence.denial}, repoke seq ${event.evidence.repoke}`
          : "attempt" in event.evidence
            ? `attempt ${event.evidence.attempt}, gate seq ${event.evidence.gate}`
            : `spawn seq ${event.evidence.spawn}, respawn seq ${event.evidence.respawn}`;
      // The peer hook (v0.0.20): a needs-human recording is a terminal Task
      // state the Project's Lead must hear — same lane, same hold law as the
      // verdict hook above. Skip when Lead itself invoked `lead_needs_human`.
      if (effectiveSeat !== "lead") {
        await peerMailHook?.({
          task: request.task,
          kind: "needs_human",
          text: `Task ${request.task} needs a human: ${event.reason} (${detail})`,
        });
      }
      return {
        id: request.id,
        ok: true,
        summary: `needs-human for ${request.task}: ${event.reason} (${detail})`,
      };
    }
    if (request.kind === "retro") {
      // The Owner's on-demand pass (v0.0.7): the plugin runs it whole. A
      // `failed` outcome already ledgered its visible line — the reply still
      // refuses (exit 2), so the Owner sees the error at the terminal too.
      // The optional Project scope (v0.0.38, ADR 0026 §1) forwards as-is: the
      // core normalizes a slug or resolves a root, and the pass honors that
      // Project's own `retro` lane before the machine table.
      const outcome = await factory.retro(request.projectSlug ?? request.projectRoot);
      if (outcome.outcome === "failed") {
        return { id: request.id, ok: false, code: "retro-failed", message: outcome.error ?? "(no reason recorded)" };
      }
      return {
        id: request.id,
        ok: true,
        summary: `retro written: ${outcome.proposalCount} proposals → ${outcome.proposalsPath}`,
        proposalsPath: outcome.proposalsPath,
        proposalCount: outcome.proposalCount,
      };
    }
    // The acceptance (v0.0.14): awaited — a worktree task's local landing
    // runs before the line records, and the reply carries the outcome. The
    // `--by` seat, when the request claims one, overrides the submitter
    // stamp; the Lead's conditional authority is judged below in the factory.
    if (request.kind !== "accept") return { id: request.id, ok: false, code: "bad-request", message: "unsupported Factory command" };
    const acceptedBy = request.by ?? request.submitter;
    const accepted = await executeAcceptance(factory, { task: request.task, attempt: request.attempt, accepted_by: acceptedBy }, { authority: effectiveSeat ?? (request.by === "lead" ? "lead" : "owner"), daemon: resolvedDaemon, home });
    return {
      id: request.id,
      ok: true,
      summary: acceptanceSummary({ task: request.task, attempt: request.attempt, by: acceptedBy, landing: accepted.landing, landingNote: accepted.landingNote }),
    };
  } catch (err) {
    if (err instanceof FactoryError) {
      return { id: request.id, ok: false, code: err.code, message: err.message };
    }
    return {
      id: request.id,
      ok: false,
      code: "plugin-error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SpoolOptions {
  /** Called once per handled request — the shell prefixes and prints it. */
  onLog?: (message: string) => void;
  /** Reply poll cadence for the drain loop. Default 250ms. */
  pollMs?: number;
  /** Recovery/read controls remain live until ordinary startup has completed. */
  ordinaryReady?: () => boolean;
  /** The choke's synthetic-ask handler (v0.0.4); without it `ask` requests are refused. */
  ask?: AskHandler;
  /** The Lead-rotation handler (v0.0.14); without it `lead_rotate` requests are refused. */
  leadRotate?: LeadRotateHandler;
  /** The Lead-dispatch handler (v0.0.20); without it `lead_dispatch` requests are refused. */
  leadDispatch?: LeadDispatchHandler;
  /** The Supervisor-dispatch handler (v0.0.23); without it `supervisor_dispatch` requests are refused. */
  supervisorDispatch?: SupervisorDispatchHandler;
  /** The Supervisor-report handler (v0.0.23); without it `supervisor_report` requests are refused. */
  supervisorReport?: SupervisorReportHandler;
  scrumCommand?: (request: ScrumSpoolRequest, caller: { authority: "owner" | SpoolSeat; actor: string }) => Promise<SpoolReply>;
  executionSetMode?: (request: ExecutionSpoolRequest) => Promise<SpoolReply>;
  /** The Project-reset handler (v0.0.24); without it `reset` requests are refused. */
  projectReset?: ProjectResetHandler;
  /** The Project-delete handler (v0.0.35); without it `delete` requests are refused. */
  projectDelete?: ProjectDeleteHandler;
  /** The peer-outcome notifier (v0.0.20) — verdicts and needs_human recordings land as Lead mail. */
  peerMail?: PeerMailHook;
  /** The daemon API for workspace registration and worker/workspace archiving (v0.0.23, ADR 0015 §6). */
  daemon?: SurfaceDaemonApi | (() => SurfaceDaemonApi | undefined);
  /** Sanitizes `<provider>/<model>[:<thinking>]` lane strings before spawn/respawn (v0.0.24, ADR 0015 §1). */
  sanitizeLane?: SanitizeLaneHandler;
  /**
   * The daemon `home` the accept path's worktree-record sweep targets
   * (v0.0.27, ADR 0017 §4) — the resolved `<paseoHome>`, never the
   * `PASEO_HOME`-env fallback the daemon may not set in this process.
   */
  home?: string;
  /** Lifecycle cancellation override; defaults to the daemon bridge. */
  stopAgent?: (agentId: string, home?: string) => Promise<DaemonReply>;
}

export type SpoolDeps = Omit<SpoolOptions, "onLog" | "pollMs">;

export interface Spool {
  stop(): void;
}

/**
 * The submit side of the loop: poll `requests/`, handle each new id, write the
 * reply, move the request to `processed/`. Requests are handled concurrently —
 * a long Gate must not delay the Owner's contract or accept — which is safe
 * because the factory itself refuses overlapping Attempts on one task.
 *
 * v0.0.31 (ADR 0017 §6) adds drain-time semantic deduplication: pending files
 * whose `spoolRequestSemanticKey` repeats one already handled in the same
 * drain/in-flight pass never run a second Gate attempt or second Ledger
 * mutation — once the primary's reply lands, the duplicate's reply is mirrored
 * from it and the duplicate file moves to `processed/`, so a retried `claim`
 * stacked during an offline window executes exactly once.
 */
export function startSpool(stateDir: string, factory: Factory, options: SpoolOptions = {}): Spool {
  const root = spoolRootFor(stateDir);
  const requestsDir = join(root, "requests");
  const repliesDir = join(root, "replies");
  const processedDir = join(root, "processed");
  const ensureDirectories = () => {
    mkdirSync(requestsDir, { recursive: true });
    mkdirSync(repliesDir, { recursive: true });
    mkdirSync(processedDir, { recursive: true });
  };
  if (pendingUpgradeFor(stateDir) === undefined) ensureDirectories();

  const log = options.onLog ?? (() => {});
  const inFlight = new Set<string>();
  /** semanticKey → primaryId — the drain's live dedup window (v0.0.31, ADR 0017 §6). */
  const inFlightSemanticKeys = new Map<string, string>();
  /** primaryId → the duplicates mirroring it while it is in flight. */
  const duplicatesByPrimaryId = new Map<string, DuplicateMirror[]>();

  interface DuplicateMirror {
    dupId: string;
    dupRequestPath: string;
    dupReplyPath: string;
    dupProcessedPath: string;
  }

  /**
   * Settles one primary's duplicates when its own handling finishes: with a
   * reply on disk, every duplicate gets the same outcome mirrored under its
   * own id and its request file moves to `processed/`; without one (the
   * primary's own handling failed), the duplicates are released back to the
   * queue for a fresh drain — never lost, never run blind.
   */
  const settleDuplicateMirrors = (primaryId: string, primaryReplyPath: string): void => {
    const duplicates = duplicatesByPrimaryId.get(primaryId);
    if (duplicates === undefined) return;
    duplicatesByPrimaryId.delete(primaryId);
    if (!existsSync(primaryReplyPath)) {
      for (const mirror of duplicates) inFlight.delete(mirror.dupId);
      return;
    }
    let reply: Record<string, unknown>;
    try {
      reply = JSON.parse(readFileSync(primaryReplyPath, "utf8")) as Record<string, unknown>;
    } catch {
      for (const mirror of duplicates) inFlight.delete(mirror.dupId);
      return;
    }
    for (const mirror of duplicates) {
      try {
        writeJsonAtomic(mirror.dupReplyPath, { ...reply, id: mirror.dupId });
        renameSync(mirror.dupRequestPath, mirror.dupProcessedPath);
        log(`request ${mirror.dupId}: duplicate of ${primaryId} — reply mirrored (no second gate)`);
      } catch (err) {
        log(`request ${mirror.dupId}: mirroring ${primaryId}'s reply failed — requeued (${err instanceof Error ? err.message : String(err)})`);
      } finally {
        inFlight.delete(mirror.dupId);
      }
    }
  };

  const drain = (): void => {
    if (factory.history.maintenanceActive) return;
    const recovering = pendingUpgradeFor(stateDir) !== undefined || options.ordinaryReady?.() === false;
    if (!recovering) ensureDirectories();
    if (!existsSync(requestsDir)) return;
    for (const name of readdirSync(requestsDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (inFlight.has(id)) continue;
      const requestPath = join(requestsDir, name);
      // Recovery controls remain reachable; unrelated queued work keeps its
      // exact request/reply/processed state until ordinary admission resumes.
      if (recovering) {
        try { if (JSON.parse(readFileSync(requestPath, "utf8")).kind !== "upgrade") continue; }
        catch { continue; }
      }
      const replyPath = join(repliesDir, name);
      if (existsSync(replyPath)) {
        // Already answered (retried or replayed request): pass it along, run nothing.
        renameSync(requestPath, join(processedDir, name));
        log(`request ${id}: reply already existed — skipped (no second gate)`);
        continue;
      }
      let semanticKey: string | undefined;
      try {
        semanticKey = spoolRequestSemanticKey(JSON.parse(readFileSync(requestPath, "utf8")));
      } catch {
        semanticKey = undefined; // unreadable body — no dedup, handled as its own request
      }
      if (semanticKey !== undefined) {
        const primaryId = inFlightSemanticKeys.get(semanticKey);
        if (primaryId !== undefined && primaryId !== id) {
          // A pending duplicate from an offline window: mirror the primary's
          // outcome, run nothing here.
          inFlight.add(id);
          const mirror: DuplicateMirror = {
            dupId: id,
            dupRequestPath: requestPath,
            dupReplyPath: replyPath,
            dupProcessedPath: join(processedDir, name),
          };
          const queue = duplicatesByPrimaryId.get(primaryId);
          if (queue === undefined) duplicatesByPrimaryId.set(primaryId, [mirror]);
          else queue.push(mirror);
          log(`request ${id}: duplicate of in-flight ${primaryId} — mirroring (no second gate)`);
          continue;
        }
        inFlightSemanticKeys.set(semanticKey, id);
      }
      inFlight.add(id);
      void handleRequestFile(
        id,
        requestPath,
        replyPath,
        join(processedDir, name),
        factory,
        log,
        options,
      )
        .catch(() => {})
        .finally(async () => {
          inFlight.delete(id);
          if (semanticKey !== undefined && inFlightSemanticKeys.get(semanticKey) === id) {
            inFlightSemanticKeys.delete(semanticKey);
          }
          try { await factory.history.runOperation(() => settleDuplicateMirrors(id, replyPath)); } catch { /* interrupted maintenance retains mirrors for a later drain */ }
        });
    }
  };

  const timer = setInterval(drain, options.pollMs ?? 250);
  drain();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export const startSpoolWatcher = startSpool;

async function handleAdmittedRequestFile(
  id: string,
  requestPath: string,
  replyPath: string,
  processedPath: string,
  factory: Factory,
  log: (message: string) => void,
  deps: SpoolDeps,
): Promise<void> {
  let reply: SpoolReply;
  let request: SpoolRequest | undefined;
  const recovering = pendingUpgradeFor(factory.stateDir);
  let recoveryControl = false;
  if (recovering !== undefined) {
    try {
      if (JSON.parse(readFileSync(requestPath, "utf8")).kind === "upgrade") {
        recordUpgradeControlReceipt(factory.stateDir, recovering, id);
        recoveryControl = true;
      }
    } catch { /* unverified controls remain ordinary inventory; never forgive their bytes */ }
  }
  try {
    request = parseSpoolRequest(JSON.parse(readFileSync(requestPath, "utf8")));
  } catch {
    request = undefined;
  }
  if (request === undefined) {
    reply = { id, ok: false, code: "bad-request", message: `request file ${requestPath} is not a valid spool request` };
    log(`request ${id}: REJECTED — malformed`);
  } else {
    reply = await handleSpoolRequest(factory, request, deps);

    // The v0.0.9 stamps make the two Owner acts attributable in the log too —
    // the same visibility the claim line always had.
    const stamp = request.kind === "contract" || request.kind === "accept" ? ` by ${request.submitter}` : "";
    log(
      request.kind === "claim" && reply.ok
        ? `request ${id}: claim ${request.task} by ${request.agent ?? "unknown agent"} → attempt ${reply.attempt} ${reply.verdict}`
        : `request ${id}: ${request.kind}${"task" in request ? ` ${request.task}` : ""}${stamp} → ${reply.ok ? (reply.decision ?? "ok") : `rejected (${reply.code})`}`,
    );
  }
  if (request?.kind === "upgrade" || recoveryControl) {
    const transaction = recoveryControl ? recovering : reply.ok && reply.upgrade !== undefined && "id" in reply.upgrade ? reply.upgrade.id : request?.kind === "upgrade" ? request.transactionId : undefined;
    if (transaction !== undefined) { try { recordUpgradeControlReply(factory.stateDir, transaction, id, reply); } catch { /* preserve the primary reply and fail closed on unknown journal transitions */ } }
  }
  if (recoveryControl) {
    mkdirSync(dirname(replyPath), { recursive: true });
    mkdirSync(dirname(processedPath), { recursive: true });
  }
  writeJsonAtomic(replyPath, reply);
  renameSync(requestPath, processedPath);
}

/** Write-then-rename, so a reader never sees a half-written JSON file. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

async function handleRequestFile(id: string, requestPath: string, replyPath: string, processedPath: string, factory: Factory, log: (message: string) => void, deps: SpoolDeps): Promise<void> {
  let kind = "";
  try { kind = String(JSON.parse(readFileSync(requestPath, "utf8")).kind); } catch { /* malformed requests still receive a reply */ }
  const work = () => handleAdmittedRequestFile(id, requestPath, replyPath, processedPath, factory, log, deps);
  if (kind === "upgrade") await work();
  else if (kind === "reset" || kind === "delete" || kind === "project_delete") await factory.history.withExclusiveMaintenance(work);
  else await factory.history.runOperation(work, { newWork: !["ask", "meter", "repoke", "respawn", "needs_human", "history_import", "history_import_status", ""].includes(kind) });
}
