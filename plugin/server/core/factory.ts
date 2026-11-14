import { pendingUpgradeFor } from "./upgrade-state.ts";
import { readLocalWriterIdentity } from "./writer-identity.ts";
import { liveWorkspaceConflict, normalized, acceptedTasks } from "./workspace-conflict.ts";
import { createHash } from "node:crypto";
import { projectTask } from "./task-state.ts";
import type { AcceptanceRole } from "./task-state.ts";
import { existsSync, readFileSync, renameSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Ledger, usageIsValid } from "./ledger.ts";
import { MAX_ATTEMPTS, NEEDS_HUMAN_REASONS, isReadOnlyPeerDisposition, needsHumanEvidenceIsValid, PEER_DISPOSITIONS, PEER_HANDOFF_OUTCOMES } from "./events.ts";
import { runGate } from "./gate.ts";
import { artifactPathProblem } from "./artifact.ts";
import { renderReport } from "./report.ts";
import { laneCliAvailable } from "./lanes.ts";
import { EYE_JSON_LANE, PEER_THINKING_LEVELS } from "./lanes.ts";
import type { LaneCliRunner, PeerThinkingLevel } from "./lanes.ts";
import { loadEyeConfig, projectSlugOfWorkspace, resolveEyeLane, runFreshEyesPass } from "./fresh-eyes.ts";
import { runWatchPass, watchLaneAvailable } from "./watch.ts";
import type { CopilotRunner, TimelineFetcher } from "./watch.ts";
import { changedFiles, checkCleanAt, deleteTaskWorktreeBranch, headCommitSync, landTaskWorktree, removeTaskWorktree, resolveClaimedCommit, scopeCoversFile } from "./workspace.ts";
import { MEMORY_FILES } from "./choke.ts";
import { projectStateDir } from "./project.ts";
import { FactoryError } from "./errors.ts";
import type { AttemptAccepted, ClaimReported, ContractSet, GateFinished, GitBlocked, LedgerEvent, MeterWritten, MeterUsage, NeedsHuman, NeedsHumanEvidence, NeedsHumanReason, PeerDisposition, PeerHandoffFields, RepokeDispatched, RepokeRefused, RespawnDispatched, RespawnRefused, SpawnDispatched, SpawnRefused, TaskClosed, Verdict } from "./events.ts";
import type { GateResult } from "./gate.ts";
import { LedgerAdmission } from "./history-admission.ts";

/** Task ids become report filenames, so they stay flat and filename-safe. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The six-field handoff's admission law (ADR 0053 §4): the four Peer-authored
 * fields must be present and non-empty after trimming, `outcome` exactly one
 * of the four SLP values, `ownership` optional but never present-and-empty.
 * Returns the admitted handoff with `ownership` defaulted to
 * `"lease returned"` — the one normalized form stored on `claim_reported`.
 */
function admitHandoff(handoff: PeerHandoffFields | undefined): PeerHandoffFields {
  if (handoff === undefined || handoff === null || typeof handoff !== "object") {
    throw new FactoryError("invalid-claim", "the six-field handoff is mandatory on every claim (ADR 0053 §4) — pass `outcome`, `scope`, `verification`, and `unknowns`");
  }
  if (!(PEER_HANDOFF_OUTCOMES as readonly string[]).includes(handoff.outcome)) {
    throw new FactoryError(
      "invalid-claim",
      `handoff \`outcome\` must be one of ${PEER_HANDOFF_OUTCOMES.join(" | ")} — got ${JSON.stringify(handoff.outcome)}`,
    );
  }
  for (const field of ["scope", "verification", "unknowns"] as const) {
    const value = handoff[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new FactoryError("invalid-claim", `handoff \`${field}\` is mandatory on every claim — missing or empty (ADR 0053 §4)`);
    }
  }
  const ownership = handoff.ownership;
  if (ownership !== undefined && (typeof ownership !== "string" || ownership.trim() === "")) {
    throw new FactoryError("invalid-claim", "handoff `ownership` is optional but must be non-empty when present — omit it for the `lease returned` default (ADR 0053 §4)");
  }
  return {
    outcome: handoff.outcome,
    scope: handoff.scope,
    verification: handoff.verification,
    unknowns: handoff.unknowns,
    ...(ownership === undefined ? { ownership: "lease returned" } : { ownership }),
  };
}

/** Admission's ownership default is the only text normalization for replay. */
function sameHandoff(left: PeerHandoffFields | undefined, right: PeerHandoffFields | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.outcome === right.outcome && left.scope === right.scope &&
    left.verification === right.verification && left.unknowns === right.unknowns &&
    (left.ownership ?? "lease returned") === (right.ownership ?? "lease returned");
}

// ---- the mechanical 4-Part Brief gate (v0.5.0, ADR 0054 §1) --------------------------------

/** The canonical section headings every SLP Lead Brief carries (LEAD_WAVE_LAWS, ADR 0054 §1). */
export const BRIEF_SECTION_HEADINGS = [
  "1. Bounded Outcome",
  "2. Contract Boundary & Regression Invariants",
  "3. Excluded / Deferred",
  "4. Verification",
] as const;

/** The read-only disposition's default Verification section (spec v0.5.0 Implementation Decision 1). */
export function readOnlyBriefVerification(disposition: PeerDisposition): string {
  return `Read-only disposition (${disposition}) — 6-Field Handoff with file:line evidence; worktree must remain clean at HEAD.`;
}

/** The Brief fields a Contract may carry as structured inputs — trimmed, empties dropped. */
export interface StructuredBriefFields {
  outcome?: string;
  invariants?: string;
  exclusions?: string;
  verification?: string;
}

function trimmedBriefField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * Synthesizes the canonical 4-section Brief from the structured fields. A
 * read-only disposition with an empty gate and no explicit `verification`
 * gets the exact read-only Verification default; every other unstated
 * section keeps its heading with no body — the heading is the contract.
 */
export function synthesizeBriefDescription(fields: StructuredBriefFields, disposition: PeerDisposition | undefined, gate: string): string {
  const verification =
    trimmedBriefField(fields.verification) ??
    (isReadOnlyPeerDisposition(disposition) && gate.trim() === "" ? readOnlyBriefVerification(disposition as PeerDisposition) : undefined);
  const sections: Array<[heading: string, body: string | undefined]> = [
    [BRIEF_SECTION_HEADINGS[0], trimmedBriefField(fields.outcome)],
    [BRIEF_SECTION_HEADINGS[1], trimmedBriefField(fields.invariants)],
    [BRIEF_SECTION_HEADINGS[2], trimmedBriefField(fields.exclusions)],
    [BRIEF_SECTION_HEADINGS[3], verification],
  ];
  return sections.map(([heading, body]) => (body === undefined ? heading : `${heading}\n${body}`)).join("\n\n");
}

/** The section headings a description is missing — section 2/3 accept either of their marker aliases. */
export function missingBriefSections(description: string): string[] {
  const missing: string[] = [];
  if (!description.includes("Bounded Outcome")) missing.push(BRIEF_SECTION_HEADINGS[0]);
  if (!description.includes("Contract Boundary") && !description.includes("Regression Invariants")) missing.push(BRIEF_SECTION_HEADINGS[1]);
  if (!description.includes("Excluded") && !description.includes("Deferred")) missing.push(BRIEF_SECTION_HEADINGS[2]);
  if (!description.includes("Verification")) missing.push(BRIEF_SECTION_HEADINGS[3]);
  return missing;
}

/** The LEAD_WAVE_LAWS Brief cap, mechanical since v0.5.0 (ADR 0054 §1). */
export const BRIEF_MAX_CHARS = 2500;

export interface FactoryOptions {
  historyFault?: (boundary: "prepared" | "renamed" | "activated" | "applied") => void;
  /** Demonstrable local writer identity, provisioned independently of imported history. */
  writerId?: string;
  /** Directory for `ledger.jsonl`, `report-<task>-<n>.md` and `gate-<task>-<n>.log` files. */
  stateDir: string;
  /**
   * The Project scope (v0.0.14, ADR 0010 §5): when set, the ledger, reports
   * and gate logs live under `<stateDir>/projects/<projectSlug>/` instead of
   * the root — one isolated tree per Git repository (`resolveProject` names
   * the slug). Omitted, everything sits at the root exactly as before (the
   * legacy single-ledger layout every pre-0.0.14 caller uses). Machine-level
   * config (`lanes.json`, `eye.json`) stays at the root either way.
   */
  projectSlug?: string;
  /** Gate timeout override (ms). Defaults to DEFAULT_GATE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Fresh-eyes total budget override (ms), both tries together. Defaults to EYE_TOTAL_BUDGET_MS. */
  eyeBudgetMs?: number;
  /**
   * The watch's timeline feed (v0.0.6): the shell captures the process's one
   * long-lived PaseoApi from a lifecycle hook and threads it here — the pure
   * core never names the SDK. Undefined in tests and Owner-CLI contexts; a
   * watch-marked claim with no fetcher records an honest `failed` line.
   */
  fetchTimeline?: TimelineFetcher;
  /** Watch total budget override (ms), all tries together (tests). Defaults to WATCH_TOTAL_BUDGET_MS. */
  watchBudgetMs?: number;
  /**
   * Watch lane availability probe override (tests) — the watch's whole config
   * surface (amendment 2, generalized to lanes in v0.0.13). Receives the
   * lane it vouches for.
   */
  watchCopilotProbe?: (lane: string) => boolean;
  /** Watch lane CLI runner override (tests) — the lane and its tool-less flags stay fixed regardless. */
  watchCopilotRunner?: CopilotRunner;
  /** Fresh-eyes CLI lane availability probe override (tests) — the eye.json path keeps its own config check. */
  eyeCliProbe?: (lane: string) => boolean;
  /** Fresh-eyes CLI lane runner override (tests) — the lane's tool-less flags stay fixed regardless. */
  eyeCliRunner?: LaneCliRunner;
}

export interface ContractInput {
  task: string;
  /**
   * The Workspace this Task's work lives in — absolute path, chosen by the
   * Owner and fixed from here on (ADR 0002 / ticket 08): the Gate's cwd and
   * the base for the artifact and scope. The Agent never gets to pick a cwd.
   */
  workspace: string;
  /**
   * The Gate command. Mandatory and non-empty for the `engineer` disposition
   * (the default); optional (defaulting to `""`) for the read-only three
   * (`scout | architect | reviewer`, ADR 0054 §2) — a read-only turn with no
   * gate verifies the worktree sits clean at HEAD instead of spawning a shell.
   */
  gate?: string;
  artifact?: string | undefined;
  /**
   * Optional explicit base commit ref/SHA (defaults to the workspace's `HEAD`).
   */
  base?: string;
  /**
   * Path prefixes (workspace-relative) the task may touch — the mechanical
   * task boundary (ticket 14). Omitted or empty = unrestricted, v0.0.1
   * behavior. A diff outside the scope is a red Verdict naming the files.
   */
  scope?: string[];
  /**
   * Legacy opt-in for the advisory fresh-eyes pass (ADR 0030):
   * - `true`: explicitly turns fresh-eyes ON (fails fast with `eye-unconfigured` when unusable).
   * - `false`: explicitly opts out.
   * - `undefined`: OFF for every caller; Lead owns semantic diff review (ADR 0030).
   */
  freshEyes?: boolean;
  /**
   * Marks the watch pass ON for this task (v0.0.6; ADR 0005 symmetry — off
   * unless marked). Runs post-verdict on BOTH verdicts, record-only. The
   * model is pinned in code and prompted through the daemon's `copilot`
   * CLI — the CLI carries the watch's auth, there is no key file.
   */
  watch?: true;
  /**
   * The task's assignment in the Owner's words (v0.0.6 description-slot
   * rider) — the driver's brief carries it, so the agent no longer has to
   * discover its assignment from the workspace.
   */
  description?: string;
  /**
   * The structured 4-Part Brief fields (v0.5.0, ADR 0054 §1): when
   * `description` is omitted/empty and any of these is supplied,
   * `setContract` synthesizes the canonical 4-section `Contract.description`
   * (`1. Bounded Outcome`, `2. Contract Boundary & Regression Invariants`,
   * `3. Excluded / Deferred`, `4. Verification`). Empty/whitespace values
   * read as omitted — the synthesis keeps only stated content.
   */
  outcome?: string;
  invariants?: string;
  exclusions?: string;
  verification?: string;
  /**
   * The SKILL.md workflows the working Agent must open first (v0.0.14, ADR
   * 0010 §6) — skill names, recorded verbatim on the Contract line; the
   * driver's brief renders them at the top. Omitted or empty = no mandate.
   */
  skills?: string[];
  /**
   * Who set the Contract (v0.0.9, ADR 0006): the spool stamps the submitting
   * shell (`PASEO_AGENT_ID` or `owner`) and the factory records it verbatim
   * on the line — the factory never infers identity.
   */
  by?: string;
  /**
   * The Peer's SLP disposition (ADR 0053 §3): exactly one of
   * `engineer | architect | reviewer | scout`. Omitted = the `engineer`
   * default; the read-only three are fenced from writing (ticket 02) and
   * claim/accept without a branch merge (tickets 04/05).
   */
  disposition?: PeerDisposition;
  /**
   * Optional caller seat for attribution; never enables Fresh-eyes (ADR 0030).
   */
  seat?: "supervisor" | "lead" | "agent";
}

export interface ClaimInput {
  task: string;
  /**
   * The claimed commit — the Peer's exact word, resolved later by the gate
   * station. Empty means "no commit supplied": refused for `engineer`
   * dispositions (the Claim attests an exact commit, ADR 0053 §4), resolved
   * to the execution tree's `HEAD` for the read-only three.
   */
  sha: string;
  /**
   * The Peer-authored six-field handoff (ADR 0053 §4): required at admission
   * — `outcome`, `scope`, `verification`, and `unknowns` non-empty,
   * `ownership` optional (defaulted to `"lease returned"` on the ledger
   * line). Exactly one of `handoff` or `mechanical` rides a claim.
   */
  handoff?: PeerHandoffFields;
  /**
   * The Lead's `lead_verify` mechanical re-run (ADR 0053 §4 scopes the
   * handoff law to Peer claims): the one non-Peer claim, carried INSTEAD of
   * a handoff — never both — so the Lead's re-verification forges no Peer
   * outcome on the ledger line.
   */
  mechanical?: "lead_verify";
  /** Who claimed, when the caller knows it — recorded on `claim_reported` (ticket 02b). */
  agent?: string;
}

export interface ClaimOutcome {
  /** The Attempt this Claim opened — attempts are numbered per task from 1. */
  attempt: number;
  verdict: Verdict;
  gate: GateFinished;
  reportPath: string;
  /**
   * The handoff exactly as admitted (ownership defaulted) — the notification
   * pipeline's one source for the six-field block it delivers to the Lead.
   * Absent on replayed legacy outcomes whose claims predate the field.
   */
  handoff?: PeerHandoffFields;
  /** Replayed alongside the handoff when the recorded claim was a `lead_verify` mechanical re-run. */
  mechanical?: "lead_verify";
}

export interface AcceptInput {
  task: string;
  attempt: number;
  /** Readable attribution retained verbatim. Trusted authority is independent.
   * Direct legacy callers may still use `lead` to request Lead policy; other
   * legacy stamps remain delegated Owner calls when no authority is supplied.
   */
  accepted_by?: string;
  /** Trusted execution authority, separate from readable attribution. */
  authority?: AcceptanceRole;
}

/**
 * One clean Task retirement (v0.5.0, ADR 0054 §5, ticket 05): the terminal
 * act for a superseded or split Task that will never be accepted. The same
 * attribution law as the acceptance — `by` is the readable seat stamp,
 * `authority` the transport-resolved role a working Agent cannot forge.
 */
export interface CloseInput {
  task: string;
  /** Why the Task is retired — the one sentence the ledger keeps. */
  reason: string;
  /** The closing seat's stamp (`lead` | `supervisor` | `owner`), the `accepted_by` law. */
  by?: string;
  /** Trusted execution authority, separate from readable attribution. */
  authority?: AcceptanceRole;
}

export interface SpawnInput {
  task: string;
  /** The `provider[/model]` string the driver runs the agent under — recorded, never interpreted. */
  provider: string;
  /**
   * How many tasks the driver's invocation carries — arity is the run's
   * parallel width, and scope is mandatory from two up (map decision 3).
   */
  arity: number;
  /**
   * The managed Task worktree this run executes in (v0.0.14, ADR 0010 §4) —
   * the driver allocates it before submitting the spawn request and names it
   * here; the line records it, and `claim` / `liveContractFor` / accept's
   * landing read it back. Omitted on the legacy shared-checkout path.
   */
  worktree?: string;
  /**
   * The per-dispatch reasoning-effort tier the Lead requested (v0.5.0, ADR
   * 0054 §4) — one of `low | medium | high | xhigh | max`, resolved
   * provider-adaptively at the spawn call site. Requires a non-empty
   * `thinkingReason` (the refusal is `invalid-spawn`).
   */
  thinking?: PeerThinkingLevel;
  /** One sentence explaining why the Task warrants `thinking` — mandatory when `thinking` is supplied. */
  thinkingReason?: string;
}

/**
 * One meter submission (v0.0.8, ticket 03 item 1): the daemon usage snapshot
 * the driver captured at the task's terminal moment. `usage` keeps the
 * daemon's camelCase verbatim — each field present only when the lane
 * provided it; an empty object is the honest "capture ran, nothing
 * reported", never a zero posing as a measurement.
 */
export interface MeterInput {
  task: string;
  /** The `provider[/model]` string the driver ran the task under — recorded, never interpreted. */
  provider: string;
  /** The daemon's usage snapshot — see `MeterUsage` in events.ts. */
  usage: MeterUsage;
  /** The metered agent's id, when the driver knows it (the report precedent). */
  agent?: string;
}

/**
 * One spawn request, judged: dispatched means the driver may create the
 * agent; refused names the rule that fired. Either way exactly one ledger
 * line exists after this call — a refused spawn is a recorded fact, not a
 * CLI complaint (v0.0.5, ADR 0004 amendment).
 */
export type SpawnDecision =
  | { outcome: "dispatched"; event: SpawnDispatched }
  | { outcome: "refused"; event: SpawnRefused; code: string };

/**
 * One re-poke request, judged: dispatched means the Lead's one spend went
 * through; refused names the rule that fired. Either way exactly one ledger
 * line exists after this call — the spawn pair's own law, so a refused
 * re-poke is a recorded fact (v0.0.10, ADR 0006 §3). The one-per-task
 * authority lives HERE, plugin-side: the dispatch line is the spent marker,
 * and the driver cannot cheat its own authority by re-asking.
 */
export type RepokeDecision =
  | { outcome: "dispatched"; event: RepokeDispatched }
  | { outcome: "refused"; event: RepokeRefused; code: string };

export interface RespawnInput {
  task: string;
  /** The `provider[/model]` string the replacement agent runs under. */
  provider: string;
  /** The dead agent whose substrate death triggered this respawn. */
  died_agent: string;
}

/**
 * One respawn request, judged (v0.0.12, ADR 0008 §3): dispatched means the
 * driver may create the replacement agent on the task's branch; refused names
 * the rule that fired (`respawn:already-spent`, `respawn:attempt-ceiling`,
 * `respawn:not-spawned`, etc.). Either way exactly one ledger line exists.
 */
export type RespawnDecision =
  | { outcome: "dispatched"; event: RespawnDispatched }
  | { outcome: "refused"; event: RespawnRefused; code: string };

/** One needs-human submission (v0.0.10): the stall's named end, evidence seqs attached. */
export interface NeedsHumanInput {
  task: string;
  reason: NeedsHumanReason;
  /** The seqs the reason keys on: the denial and the spent `repoke_dispatched`. */
  evidence: NeedsHumanEvidence;
}

export interface Factory {
  readonly history: LedgerAdmission;
  readonly ledger: Ledger;
  readonly stateDir: string;
  /** Attempts the factory closed red while opening (ADR 0003 recovery) — for the shell to log loudly. */
  readonly recoveredAttempts: readonly { task: string; attempt: number }[];
  /**
   * Registers a task's done-criteria. One contract per task — the ledger is
   * append-only, and a retired task is terminal: re-contracting a closed ID
   * refuses `already-closed` (v0.5.0, ADR 0054 §5).
   */
  setContract(input: ContractInput): ContractSet;
  /**
   * Records the Agent's Claim, verifies it against the Workspace, runs the gate
   * on it, writes the report. Per ADR 0002 the Verdict attests the claimed
   * commit: the sha is resolved, and the tree must sit clean with HEAD at that
   * commit both before and after the gate. Anything else is red, never a
   * fallback to whatever is on disk. Each Call opens the task's next Attempt;
   * a Claim while the previous Attempt is still open is rejected (ADR 0003),
   * and a Claim on a retired task refuses `already-closed` — a straggler
   * Peer opens no Attempt and replays no closed evidence (v0.5.0, ADR 0054 §5).
   */
  claim(input: ClaimInput): Promise<ClaimOutcome>;
  /**
   * The Owner accepts one green Attempt (ADR 0002). Green is necessary, not
   * sufficient — this is the only acceptance act in the factory, and it is
   * never the Agent's. Since v0.0.9 the delegated Owner seat (the
   * Supervisor, ADR 0006) may submit it on the Owner's word; the
   * `accepted_by` stamp records whose act each line is. Since v0.0.14
   * (ADR 0010 §3–§4) `accepted_by: "lead"` is the intermediate acceptance
   * (green + not in needs_human,
   * else `lead-accept-refused`), and a task that ran in a managed Task
   * worktree lands its claimedCommit into `<project-root>`'s local branch
   * before the line records — async git is why the call awaits. A retired
   * task refuses `already-closed`: acceptance and retirement are the two
   * terminals, and neither happens after the other (v0.5.0, ADR 0054 §5).
   */
  accept(input: AcceptInput): Promise<AttemptAccepted>;
  /**
   * Closes a Task cleanly (v0.5.0, ADR 0054 §5, ticket 05) — the terminal
   * retirement for work that will never be accepted (superseded, split after
   * a context-ceiling). Refuses unknown (`unknown-task`), settled
   * (`already-accepted`), retired (`already-closed`), and mid-gate
   * (`gate-running`) Tasks, and a working Agent caller
   * (`agent-cannot-close`). On success — and BEFORE the line records, the
   * acceptance's own async-git law — the managed Task worktree is removed and
   * the `factory/<task>` branch deleted, then exactly one `task_closed` line
   * appends. The Plugin shell's close act (Spool `kind: "close"` /
   * `lead_close_task`) adds the live Peer cancel/archive and the temporary
   * Paseo workspace archive around this call.
   */
  close(input: CloseInput): Promise<TaskClosed>;
  /**
   * Judges a driver's spawn request (v0.0.5): the task must be known,
   * unaccepted, unretired (`spawn:closed-task`, v0.5.0 ADR 0054 §5), scoped
   * when the invocation runs parallel (arity ≥ 2), and its workspace clear of
   * every other live Contract's tree. One ledger line either way —
   * `spawn_dispatched` or `spawn_refused` — so the record exists before any
   * agent does. Never throws; the refusal rides the return value (and the
   * spool reply), not an exception.
   */
  requestSpawn(input: SpawnInput): SpawnDecision;
  /**
   * Records one Meter line (v0.0.8): the post-verdict capture of what the
   * task's run cost its lane, submitted by the driver through the spool
   * (ADR 0004's one-writer law, third amendment). Validates the shape and
   * that the task is known, then appends exactly one task-scoped
   * `meter_written` line — usage verbatim in the daemon's camelCase, fields
   * present only when the lane provided them. A refused meter (unknown
   * task, malformed usage) throws and writes NO line — nothing changed,
   * nothing recorded. One line per task per driver run by construction; a
   * re-run task lands a second line and the Cost read takes the latest.
   * A recorder, never a judge: no budgets, no alerts, verdicts unchanged.
   */
  meter(input: MeterInput): MeterWritten;
  /**
   * Judges the Lead's one spend (v0.0.10, ADR 0006 §3): the task must be
   * known, unaccepted, and carry no earlier `repoke_dispatched` in its slice
   * — the one-re-poke-per-task law lives here, not in the driver. One ledger
   * line either way (`repoke_dispatched` or `repoke_refused`, the spawn
   * pair's law); never throws, the refusal rides the return value. The
   * stall predicate itself stays driver-side — this is the authority over
   * the spend, never the trigger. Since ADR 0053 Decision 3 a repoke
   * carrying a non-empty `message` (the Lead replying inside a live
   * reconciliation loop) lifts the one-per-task cap — every ruling turn
   * dispatches — while a message-less repoke keeps the Denial-stall's
   * one-shot law verbatim. The message body is delivery-only: it is judged
   * here, never persisted on the line.
   */
  repoke(task: string, agent: string, message?: string): RepokeDecision;
  /**
   * Judges the driver's automatic Respawn request after `Substrate death`
   * (v0.0.12, ADR 0008 §3): validates `task`, `provider`, and `died_agent`,
   * refuses unknown, accepted, or attempt-ceiling tasks, and enforces the
   * one-respawn-per-progress-marker law (`spawn_dispatched` or
   * `gate_finished`). Appends `respawn_dispatched` or `respawn_refused`;
   * never throws.
   */
  respawn(input: RespawnInput): RespawnDecision;
  /**
   * Records one `needs_human` line (v0.0.10, ADR 0006 §4): the re-poke is
   * spent and the stall persisted. The meter's own law — a refused
   * submission (unknown task, malformed shape, evidence that names no spent
   * re-poke) throws and writes NO line: nothing changed, nothing recorded.
   * The event is terminal for the watch but not for the task — only
   * Acceptance closes a task, and an Owner answer wakes it through the
   * ordinary spawn path.
   */
  needsHuman(input: NeedsHumanInput): NeedsHuman;
  /**
   * The live Contract whose workspace contains `cwd`, if any — the choke's
   * mechanical "contracted agent" test (v0.0.4 map decision 5: asks from
   * agents without a live Contract are not the factory's business). Live =
   * contract set and no settled acceptance yet (pending landings stay live). When several live Contracts
   * cover the same tree, the latest in ledger order wins. Since v0.0.14 a
   * cwd inside the task's recorded Task worktree binds too — the worktree
   * sits outside the workspace (under `<stateDir>/projects/`), so the spawn
   * line's `worktree` field is what ties the tree to its Contract, including
   * across a re-contract while the historical worktree still exists.
   */
  liveContractFor(cwd: string): ContractSet | undefined;
  /**
   * The task's Contract — the one lookup every asker of a task's history
   * needs (a Claim verifying its gate, a synthetic ask binding its cwd).
   * Undefined when no Contract was ever set for the task.
   */
  contractFor(task: string): ContractSet | undefined;
  /**
   * The managed Task worktree the task's latest dispatch runs in (v0.0.14,
   * ADR 0010 §4) — the one lookup that binds a task to its execution tree:
   * the claim's gate cwd and the choke's worktree agent both resolve through
   * it. Re-contracting inherits the latest dispatch while its directory
   * survives. Undefined for settled tasks or when no spawn recorded one
   * (the legacy shared-checkout path, pre-0.0.14 lines).
   */
  worktreeFor(task: string): string | undefined;
  /** Completed gate verdicts for `task` in its current Contract epoch (v0.0.24). */
  attemptsOf(task: string): GateFinished[];
  /** Latest spawn or respawn dispatch for `task` in its current Contract epoch (v0.0.24). */
  activeSpawnOf(task: string): SpawnDispatched | RespawnDispatched | undefined;
  /** Latest progress-marker seq (`spawn_dispatched` or `gate_finished`) for `task` in its current Contract epoch, or `-1` if none (v0.0.24). */
  lastProgressSeq(task: string): number;
  /** Whether `task` currently stands in `needs_human` in its current Contract epoch (v0.0.24). */
  isNeedsHuman(task: string): boolean;
  /**
   * Owner-only Project reset (v0.0.24): purges all ledger events, contracts,
   * reports, and gate logs belonging to `projectRoot` (and `projectSlug` when
   * given) in-memory and on disk without disturbing other projects' events.
   */
  resetProject(projectRoot: string, projectSlug?: string): { purgedEvents: number; tasks: string[]; removedFiles: number };
}

export function createFactory(options: FactoryOptions): Factory {
  const { stateDir } = options;
  // The data tree: project-scoped factories keep their ledger, reports, gate
  // logs, and retro files under <stateDir>/projects/<slug>/ (v0.0.14, ADR
  // 0010 §5); machine-level config (lanes.json, eye.json) stays at the root
  // for every factory, and the root data tree remains the no-scope default
  // (the legacy single-ledger layout).
  const dataDir = options.projectSlug === undefined ? stateDir : projectStateDir(stateDir, options.projectSlug);
  const release = LedgerAdmission.reserve(join(dataDir, "ledger.jsonl"));
  let ledger: Ledger;
  let recoveredAttempts: ReturnType<typeof recoverInterruptedAttempts>;
  let history: LedgerAdmission;
  try {
    LedgerAdmission.assertAvailable(join(dataDir, "ledger.jsonl"));
    const pendingUpgrade = pendingUpgradeFor(stateDir);
    ledger = Ledger.open(join(dataDir, "ledger.jsonl"), { writerId: options.writerId ?? readLocalWriterIdentity(stateDir, options.projectSlug), recoverTail: pendingUpgrade === undefined });
    recoveredAttempts = pendingUpgrade === undefined ? recoverInterruptedAttempts(ledger, dataDir) : [];
    history = new LedgerAdmission(ledger, stateDir, { fault: options.historyFault });
  } finally { release(); }


  const factory: Factory = {
    history,
    ledger,
    stateDir,
    recoveredAttempts,

    setContract({ task, workspace, gate, artifact, base: inputBase, scope, freshEyes, watch, description, skills, by, disposition, seat, outcome, invariants, exclusions, verification }) {
      assertTaskId(task);
      // ADR 0054 §2: the shell Gate is the engineer disposition's law; the
      // read-only three (scout|architect|reviewer) may omit it — an empty gate
      // on a read-only Contract verifies the worktree sits clean at HEAD
      // instead of spawning a shell (the claim station's law).
      const resolvedDisposition = disposition ?? "engineer";
      const readOnly = isReadOnlyPeerDisposition(disposition);
      const gateCommand = gate ?? "";
      if (!readOnly && gateCommand.trim() === "") {
        throw new FactoryError(
          "invalid-contract",
          `gate command must be a non-empty string for the ${resolvedDisposition} disposition — the read-only three (scout|architect|reviewer) may omit it (ADR 0054 §2)`,
        );
      }
      const resolvedArtifact = artifact === undefined ? "" : artifact;
      if (artifact !== undefined) {
        const artifactProblem = artifactPathProblem(artifact);
        if (artifactProblem !== undefined) throw new FactoryError("invalid-contract", artifactProblem);
      }
      // ADR 0054 §1: a read-only disposition never requires an output
      // artifact — its deliverable is the 6-Field Handoff, not a file.
      if (readOnly && resolvedArtifact !== "") {
        throw new FactoryError("invalid-contract", `read-only disposition (${resolvedDisposition}) cannot require an output artifact — the read-only deliverable is the 6-Field Handoff`);
      }
      if (freshEyes !== undefined && typeof freshEyes !== "boolean") {
        throw new FactoryError("invalid-contract", "freshEyes must be a boolean (true or false) — omit it to use the caller default");
      }
      if (watch !== undefined && watch !== true) {
        throw new FactoryError("invalid-contract", "watch marks the pass ON — omit it, or set it to exactly true");
      }
      if (disposition !== undefined && !(PEER_DISPOSITIONS as readonly string[]).includes(disposition)) {
        throw new FactoryError("invalid-contract", "disposition must be exactly one of engineer|architect|reviewer|scout — omit it for the engineer default");
      }
      if (description !== undefined && typeof description !== "string") {
        throw new FactoryError("invalid-contract", "description must be a string — omit it when the task has no assignment text");
      }
      // The pre-v0.5.0 non-empty law stands everywhere EXCEPT the 4-Part
      // Brief gate's own scope (ADR 0054 §1: `seat === "lead"`), where an empty description must read as omitted so the
      // structured Brief synthesizes — or the section-naming refusal fires.
      // Outside that scope a supplied description is a non-empty string;
      // omission remains the only way to say "no assignment text".
      if (description !== undefined && description.trim() === "" && seat !== "lead") {
        throw new FactoryError("invalid-contract", "description must be a non-empty string — omit it when the task has no assignment text");
      }
      // The structured 4-Part Brief fields (ADR 0054 §1): strings when
      // present, empties read as omitted; with no `description` they
      // synthesize the canonical 4-section Brief below.
      for (const [field, value] of Object.entries({ outcome, invariants, exclusions, verification }) as Array<[string, string | undefined]>) {
        if (value !== undefined && typeof value !== "string") {
          throw new FactoryError("invalid-contract", `${field} must be a string — omit it when the Brief section has no content`);
        }
      }
      const briefFields: StructuredBriefFields = { outcome, invariants, exclusions, verification };
      const hasStructuredBrief = [outcome, invariants, exclusions, verification].some((value) => trimmedBriefField(value) !== undefined);
      const suppliedDescription = description !== undefined && description.trim() !== "" ? description : undefined;
      const resolvedDescription =
        suppliedDescription !== undefined
          ? suppliedDescription
          : hasStructuredBrief
            ? synthesizeBriefDescription(briefFields, disposition, gateCommand)
            : undefined;
      // The mechanical 4-Part Brief gate (ADR 0054 §1): scoped to the Lead
      // seat — Owner/Supervisor/Agent paths keep their own laws.
      if (seat === "lead") {
        if (resolvedDescription === undefined) {
          throw new FactoryError(
            "invalid-contract",
            `the 4-Part Brief is mandatory on Lead Contracts (slp mode): supply \`description\` or the structured Brief fields (outcome, invariants, exclusions, verification) — the Brief must carry all four sections (${BRIEF_SECTION_HEADINGS.join(", ")})`,
          );
        }
        if (resolvedDescription.length > BRIEF_MAX_CHARS) {
          throw new FactoryError(
            "invalid-contract",
            `the 4-Part Brief exceeds the ${BRIEF_MAX_CHARS.toLocaleString("en-US")}-char cap (LEAD_WAVE_LAWS) — got ${resolvedDescription.length} chars; keep every Contract.description concise`,
          );
        }
        const missing = missingBriefSections(resolvedDescription);
        if (missing.length > 0) {
          throw new FactoryError(
            "invalid-contract",
            `the 4-Part Brief is missing section(s): ${missing.join("; ")} — a Lead Contract's description must carry all four canonical sections (${BRIEF_SECTION_HEADINGS.join(", ")})`,
          );
        }
      }
      if (skills !== undefined && skills.length > 0) {
        const unusable =
          !Array.isArray(skills) ||
          skills.some((name) => typeof name !== "string" || name.trim() === "");
        if (unusable) {
          throw new FactoryError("invalid-contract", "skills must be an array of non-empty skill names — omit it when the task mandates none");
        }
      }
      if (!isAbsolute(workspace)) {
        throw new FactoryError("invalid-contract", `workspace "${workspace}" must be an absolute path`);
      }
      let isDirectory = false;
      try {
        isDirectory = statSync(workspace).isDirectory();
      } catch {
        // stays false — the message below is the answer either way
      }
      if (!isDirectory) {
        throw new FactoryError("invalid-contract", `workspace "${workspace}" must be an existing directory`);
      }
      if (scope !== undefined && scope.length > 0) {
        const unusable =
          !Array.isArray(scope) ||
          scope.some(
            (prefix) =>
              typeof prefix !== "string" ||
              prefix.trim() === "" ||
              prefix.startsWith("/") ||
              prefix.split("/").includes(".."),
          );
        if (unusable) {
          throw new FactoryError("invalid-contract", "scope must be an array of workspace-relative path prefixes");
        }
      }
      // ADR 0054 §1: a read-only Contract declares no writable boundary — any
      // supplied scope is normalized to [] (recorded omitted) on the line.
      const effectiveScope = readOnly ? [] : scope;
      // The base commit is recorded on every Contract since v0.0.2 (ticket 03
      // R2): it is the diff range for the scope check and the fresh-eyes pass.
      const priorContract = this.contractFor(task);
      const liveWorktree = this.worktreeFor(task);
      const priorBase = priorContract?.workspace === workspace && liveWorktree !== undefined && directoryExists(liveWorktree)
        ? priorContract.base
        : undefined;
      const base = headCommitSync(workspace, (inputBase === "" ? undefined : inputBase) ?? priorBase ?? "HEAD");
      if (base === undefined) {
        throw new FactoryError(
          "invalid-contract",
          "the workspace must be a git workspace with a resolvable HEAD — the Contract's base commit is the diff base for the scope check and the fresh-eyes pass",
        );
      }
      // Retain explicit legacy opt-in, but never enable a headless review by caller role.
      // Lead owns semantic diff inspection (ADR 0030). Lanes resolve per Project.
      const contractProjectSlug = projectSlugOfWorkspace(workspace);
      let effectiveFreshEyes: true | undefined;
      if (freshEyes === true) {
        const lane = resolveEyeLane(stateDir, contractProjectSlug);
        if (!lane.ok) {
          throw new FactoryError("eye-unconfigured", `fresh-eyes is on, but its lane is not usable: ${lane.reason}`);
        }
        if (lane.lane === EYE_JSON_LANE) {
          const eye = loadEyeConfig(stateDir);
          if (!eye.ok) {
            throw new FactoryError("eye-unconfigured", `fresh-eyes is on, but the eye is not usable: ${eye.reason}`);
           }
        } else {
          const usable = options.eyeCliProbe === undefined ? laneCliAvailable(lane.lane) : options.eyeCliProbe(lane.lane);
          if (!usable) {
            throw new FactoryError(
              "eye-unconfigured",
              `fresh-eyes is on, but the ${lane.lane} CLI is not usable on PATH — install and auth it for the daemon user (the CLI carries the pass's auth; there is no key file)`,
            );
          }
        }
        effectiveFreshEyes = true;
      }
      if (watch === true) {
        const usable = watchLaneAvailable(stateDir, options.watchCopilotProbe, contractProjectSlug);
        if (!usable.ok) {
          throw new FactoryError("watch-unconfigured", `the watch is on, but its lane is not usable: ${usable.reason}`);
        }
      }
      const fullHistory = ledger.eventsFor(task);
      const priorAccept = acceptedAttempt(fullHistory);
      if (priorAccept !== undefined) {
        throw new FactoryError(
          "already-accepted",
          `task ${task} was already accepted at attempt ${priorAccept.attempt}; the ledger is append-only`,
        );
      }
      // The retirement's mirror (v0.5.0, ADR 0054 §5): a closed Task is
      // terminal beside an accepted one — the same ID never re-contracts
      // into a new epoch, so a straggler cannot resurrect the retired Task.
      const closure = closureEvent(fullHistory);
      if (closure !== undefined) {
        throw new FactoryError(
          "already-closed",
          `task ${task} was closed (reason: ${closure.reason}) — the retirement is terminal; the ledger is append-only`,
        );
      }
      const epochHistory = epochEventsFor(ledger, task);
      const inFlight = inFlightAttempt(epochHistory);
      if (inFlight !== undefined) {
        throw new FactoryError(
          "gate-running",
          `attempt ${inFlight} of task ${task} is still open — wait for its verdict before re-contracting`,
        );
      }
      // The one concurrency guard the audit demanded (H1/H2, v0.0.5 ticket 02):
      // two live Contracts may never share a workspace tree — equals, nests, or
      // contains. Without this, two gates race in one cwd and permit asks
      // misattribute to the latest covering Contract. It is also the Owner-CLI
      // arm of the driver's spawn-time workspace refusal (ticket 03 §7).
      // Since v0.0.14 (ADR 0010 §4) the SAME tree is exempt when both Contracts
      // declare disjoint scopes: each Task executes in its own managed worktree,
      // so the single-checkout collision cannot happen — the scope globs are
      // the declared boundary (Implementation Decision 5, bullet 3).
      const conflict = liveWorkspaceConflict(ledger, workspace, task, effectiveScope);
      if (conflict !== undefined) {
        throw new FactoryError(
          "workspace-conflict",
          conflict.relation === "equal" && conflict.overlapping !== undefined
            ? `workspace "${workspace}" is the same tree as the live contract of task ${conflict.task}, and their scopes overlap (${conflict.overlapping}) — two Tasks share one Project only behind disjoint scopes`
            : `workspace "${workspace}" ${relationText(conflict.relation)} the live contract of task ${conflict.task} (${conflict.workspace}) — accept or retire that task before contracting this tree`,
        );
      }
      return ledger.append({
        event: "contract_set",
        task,
        workspace,
        gate: gateCommand,
        artifact: resolvedArtifact,
        ...(effectiveScope === undefined || effectiveScope.length === 0 ? {} : { scope: effectiveScope }),
        base,
        ...(effectiveFreshEyes === true ? { freshEyes: true } : {}),
        ...(watch === undefined ? {} : { watch }),
        ...(resolvedDescription === undefined ? {} : { description: resolvedDescription }),
        ...(skills === undefined || skills.length === 0 ? {} : { skills }),
        ...(by === undefined ? {} : { by }),
        ...(disposition === undefined ? {} : { disposition }),
      });
    },

    async claim({ task, sha, agent, handoff, mechanical }) {
      assertTaskId(task);
      const contract = this.contractFor(task);
      if (!contract) throw new FactoryError("unknown-task", `no contract set for task ${task} — register one first`);
      const fullHistory = ledger.eventsFor(task);
      const history = epochEventsFor(ledger, task);

      // Admission (ADR 0053 §4) — the six-field handoff law and the
      // disposition's commit rule, both judged BEFORE any event is appended
      // and before Station 1 runs: a malformed claim opens no Attempt. The
      // law's one scoped exception is the Lead's `lead_verify` mechanical
      // re-run — a non-Peer claim that carries the marker instead of a
      // handoff, never both, so no Peer outcome is forged on it.
      if (mechanical !== undefined && mechanical !== "lead_verify") {
        throw new FactoryError("invalid-claim", `\`mechanical\` must be exactly "lead_verify" when present — got ${JSON.stringify(mechanical)}`);
      }
      if (mechanical === "lead_verify" && handoff !== undefined) {
        throw new FactoryError("invalid-claim", "a `lead_verify` mechanical re-run carries no six-field handoff — pass the mechanical marker or the Peer handoff, never both (ADR 0053 §4)");
      }
      const admittedHandoff = mechanical === "lead_verify" ? undefined : admitHandoff(handoff);
      const disposition = contract.disposition ?? "engineer";
      const executionDir = this.worktreeFor(task) ?? contract.workspace;
      let claimedSha = sha.trim();
      if (claimedSha === "") {
        if (disposition === "engineer") {
          throw new FactoryError(
            "invalid-claim",
            `the six-field handoff is complete but the claim attests no commit: \`commit\` is mandatory for the ${disposition} disposition — the Claim attests an exact commit (ADR 0053 §4)`,
          );
        }
        const head = headCommitSync(executionDir);
        if (head === undefined) {
          throw new FactoryError("invalid-claim", `could not resolve HEAD in ${executionDir} to default the omitted commit for the ${disposition} disposition`);
        }
        claimedSha = head;
      }

      // The watch's read of the scope station: undefined until it runs, then
      // the outside-scope files it found (empty = clean). Set where station 4
      // decides, read by the watch pass inside finish().
      let scopeViolations: string[] | undefined;
      const watchContext = () => ({
        agent,
        scopeViolations,
        fetchTimeline: options.fetchTimeline,
        budgetMs: options.watchBudgetMs,
        copilotRunner: options.watchCopilotRunner,
      });

      // H6 rider (v0.0.5 ticket 02): an accepted task is closed — a Claim on it
      // used to fall through to a fresh Attempt; it refuses like accept does.
      const priorAccept = acceptedAttempt(fullHistory);
      if (priorAccept !== undefined) {
        throw new FactoryError(
          "already-accepted",
          `task ${task} was already accepted at attempt ${priorAccept.attempt}; the ledger is append-only`,
        );
      }

      // The H6 rider's close-side mirror (v0.5.0, ADR 0054 §5): a retired Task
      // is terminal the same way — a straggler Peer's Claim opens no fresh
      // Attempt and replays no closed green evidence.
      const closure = closureEvent(fullHistory);
      if (closure !== undefined) {
        throw new FactoryError(
          "already-closed",
          `task ${task} was closed (reason: ${closure.reason}) — the retirement is terminal; the ledger is append-only`,
        );
      }

      // ADR 0003: Attempts never overlap. The previous one must have reached
      // its report before a new Claim opens the next Attempt.
      const lastAttempt = maxAttempt(history);
      if (lastAttempt > 0 && attemptIsOpen(history, lastAttempt)) {
        throw new FactoryError(
          "gate-running",
          `attempt ${lastAttempt} of task ${task} is still open — wait for its verdict before claiming again`,
        );
      }
      const completed = projectTask(fullHistory, task).attempts.findLast(
        (entry) => !entry.open && entry.gate?.verdict === "green" &&
          (entry.gate.sha === claimedSha || entry.events.some(event => event.event === "claim_reported" && event.sha === claimedSha)),
      );
      if (completed?.gate !== undefined) {
        const report = completed.events.findLast((event) => event.event === "report_written");
        const replayedClaim = completed.events.findLast((event): event is ClaimReported => event.event === "claim_reported");
        // A poke after the claim began requests another reconciliation turn;
        // a poke answered by that claim does not invalidate its retries.
        const repoked = replayedClaim !== undefined && history.some(
          (event) => event.event === "repoke_dispatched" && event.seq > replayedClaim.seq,
        );
        if (report?.event === "report_written" && replayedClaim !== undefined && !repoked &&
          replayedClaim.mechanical === mechanical && sameHandoff(replayedClaim.handoff, admittedHandoff)) {
          // The replayed outcome is the attempt's own evidence — the admitted
          // handoff rides it exactly as the first delivery did (ADR 0053 §4).
          return {
            attempt: completed.attempt,
            verdict: "green",
            gate: completed.gate,
            reportPath: report.path,
            ...(replayedClaim?.handoff === undefined ? {} : { handoff: replayedClaim.handoff }),
            ...(replayedClaim?.mechanical === undefined ? {} : { mechanical: replayedClaim.mechanical }),
          };
        }
      }
      if (lastAttempt >= MAX_ATTEMPTS) {
        throw new FactoryError(
          "attempt-ceiling",
          `task ${task} reached the attempt ceiling (${MAX_ATTEMPTS} attempts) — no further Claim may open an Attempt`,
        );
      }
      const attempt = lastAttempt + 1;

      // Everything the Attempt's closing window fixes up front (F10): the
      // per-call facts — verdict, sha, the watch context — stay arguments;
      // the rest rides one context object.
      const finishCtx = {
        task,
        ledger,
        stateDir,
        dataDir,
        contract,
        eyeBudgetMs: options.eyeBudgetMs,
        eyeRunner: options.eyeCliRunner,
        handoff: admittedHandoff,
      };

      ledger.append({
        event: "claim_reported",
        task,
        attempt,
        sha: claimedSha,
        handoff: admittedHandoff,
        ...(mechanical === undefined ? {} : { mechanical }),
        ...(agent === undefined || agent.trim() === "" ? {} : { agent }),
      });
      ledger.append({ event: "gate_started", task, attempt, cmd: contract.gate });

      // The execution tree (v0.0.14, ADR 0010 §4): a task spawned with a
      // managed Task worktree claims, gates, and diffs THERE — the Contract's
      // workspace stays <project-root>, the recorded home of the work and the
      // landing target; the worktree is the driver-level execution detail the
      // spawn line carries. Legacy spawns (no worktree on the line) execute
      // at the contract workspace, v0.0.5's law. `executionDir` was fixed at
      // admission — the omitted-commit default needs it before any append.

      // Station 1 — the claimed commit must exist as one full object. An empty,
      // unknown or ambiguous sha is a red Verdict (ADR 0002), and the gate
      // command never runs on an unverified tree.
      const resolved = await resolveClaimedCommit(executionDir, claimedSha);
      if (!resolved.ok) {
        return finish(finishCtx, attempt, { exit: null, verdict: "red", note: resolved.reason, timedOut: false }, undefined, watchContext());
      }

      // The read-only synthetic Gate (ADR 0054 §2): a read-only Contract with
      // an empty gate owns no shell command — an empty string through runGate
      // cannot even start, so the Factory verifies the execution tree itself
      // and records the verdict. The branch sits before Station 2 because its
      // dirty outcome is this gate's own refusal (dirty-worktree-before-gate),
      // not the shell path's generic pre-gate note.
      if (isReadOnlyPeerDisposition(contract.disposition) && contract.gate.trim() === "") {
        const clean = await checkCleanAt(executionDir, resolved.full);
        if (!clean.ok) {
          return finish(
            finishCtx,
            attempt,
            {
              exit: null,
              verdict: "red",
              note: `dirty-worktree-before-gate: ${clean.reason}`,
              timedOut: false,
            },
            resolved.full,
            watchContext(),
          );
        }
        // The memory write fence's read-only arm (spec Implementation Decision
        // 2: "no unauthorized root memory edits"): a read-only Contract's scope
        // is always [], so any fenced root memory file inside the Contract's
        // diff range reds — project memory is never a read-only Peer's to move.
        if (contract.base !== undefined) {
          const diff = await changedFiles(executionDir, contract.base, resolved.full);
          if (!diff.ok) {
            return finish(
              finishCtx,
              attempt,
              { exit: null, verdict: "red", note: `memory fence check failed: ${diff.reason}`, timedOut: false },
              resolved.full,
              watchContext(),
            );
          }
          const fenced = diff.files.filter((file) => (MEMORY_FILES as readonly string[]).includes(file));
          if (fenced.length > 0) {
            return finish(
              finishCtx,
              attempt,
              {
                exit: null,
                verdict: "red",
                note:
                  `changes to fenced memory files: ${fenced.join(", ")} — project memory (AGENTS.md/CLAUDE.md/CONTEXT.md) ` +
                  "is the Supervisor's and Lead's act, never a read-only Peer's",
                timedOut: false,
              },
              resolved.full,
              watchContext(),
            );
          }
        }
        return finish(
          finishCtx,
          attempt,
          {
            exit: 0,
            verdict: "green",
            note: `read-only disposition (${disposition}) — 6-field handoff recorded, no shell gate required`,
            timedOut: false,
            output: `read-only disposition (${disposition}) — 6-field handoff recorded, worktree clean at ${resolved.full}`,
          },
          resolved.full,
          watchContext(),
        );
      }

      // Station 2 — clean tree, HEAD at the claimed commit, before the gate.
      const before = await checkCleanAt(executionDir, resolved.full);
      if (!before.ok) {
        return finish(
          finishCtx,
          attempt,
          {
            exit: null,
            verdict: "red",
            note: `workspace not clean at the claimed commit before the gate: ${before.reason}`,
            timedOut: false,
          },
          resolved.full,
          watchContext(),
        );
      }

      let result: GateResult;
      try {
        result = await runGate({
          cmd: contract.gate,
          cwd: executionDir,
          ...(contract.artifact.trim() === "" ? {} : { artifact: contract.artifact }),
          timeoutMs: options.timeoutMs,
        });
      } catch (err) {
        // A gate that cannot even start is a red fact, not an aborted sequence —
        // the ledger must still reach gate_finished.
        result = {
          exit: null,
          verdict: "red",
          note: `gate failed to start: ${err instanceof Error ? err.message : String(err)}`,
          timedOut: false,
        };
      }

      // Station 3 — same check after the gate: a green exit on a tree that moved
      // during the run attests nothing.
      const after = await checkCleanAt(executionDir, resolved.full);
      if (!after.ok) {
        return finish(
          finishCtx,
          attempt,
          {
            exit: result.exit,
            verdict: "red",
            note: `workspace moved during the gate: ${after.reason}`,
            timedOut: false,
          },
          resolved.full,
          watchContext(),
        );
      }

      // Station 4 — the mechanical task boundary (ticket 14, fenced in
      // v0.0.14): every file the diff touches must fall inside a declared
      // scope prefix, and the three memory files at the workspace root
      // (AGENTS.md, CLAUDE.md, CONTEXT.md) red EVERY contract that does not
      // explicitly scope them — unrestricted ones included (ADR 0010 §6:
      // project memory is the Supervisor's and Lead's act, never a worker's
      // side effect) — WHEN the Contract carries a base commit, which the
      // diff below needs (every Contract since v0.0.2 records one; only
      // pre-0.0.2 ledger lines are base-less). A base-less Contract skips
      // this claim-time fence; the ask-time Choke fence (MEMORY_FILES in
      // choke.ts) still covers its writes live. A task that overreaches is
      // refused here, never prompted back to polite behavior.
      const scopeDeclared = contract.scope !== undefined && contract.scope.length > 0;
      if (scopeDeclared && contract.base === undefined) {
        return finish(
          finishCtx,
          attempt,
          { exit: result.exit, verdict: "red", note: "scoped contract has no recorded base commit", timedOut: false },
          resolved.full,
          watchContext(),
        );
      }
      if (contract.base !== undefined) {
        const diff = await changedFiles(executionDir, contract.base, resolved.full);
        if (!diff.ok) {
          // A failed diff leaves the station with no measurement — undefined,
          // never an empty list posing as "clean".
          scopeViolations = undefined;
          return finish(
            finishCtx,
            attempt,
            {
              exit: result.exit,
              verdict: "red",
              note: `${scopeDeclared ? "scope check" : "memory fence check"} failed: ${diff.reason}`,
              timedOut: false,
            },
            resolved.full,
            watchContext(),
          );
        }
        if (scopeDeclared) {
          scopeViolations = diff.files.filter((file) => !scopeCoversFile(contract.scope!, file));
        }
        const fenced = diff.files.filter((file) => (MEMORY_FILES as readonly string[]).includes(file) && !scopeCoversFile(contract.scope ?? [], file));
        if (fenced.length > 0) {
          scopeViolations = fenced;
          return finish(
            finishCtx,
            attempt,
            {
              exit: result.exit,
              verdict: "red",
              note:
                `changes to fenced memory files: ${fenced.join(", ")} — project memory (AGENTS.md/CLAUDE.md/CONTEXT.md) ` +
                "is the Supervisor's and Lead's act; scope the file explicitly to contract the edit",
              timedOut: false,
            },
            resolved.full,
            watchContext(),
          );
        }
      }

      return finish(finishCtx, attempt, result, resolved.full, watchContext());
    },

    async accept({ task, attempt, accepted_by, authority }) {
      assertTaskId(task);
      if (!Number.isInteger(attempt) || attempt < 1) {
        throw new FactoryError("invalid-attempt", `attempt must be a positive integer, got ${attempt}`);
      }
      const fullHistory = ledger.eventsFor(task);
      const history = epochEventsFor(ledger, task);
      const contract = this.contractFor(task);
      if (contract === undefined) {
        throw new FactoryError("unknown-task", `no contract set for task ${task} — register one first`);
      }
      if (inFlightAttempt(history) !== undefined) {
        throw new FactoryError("gate-running", `task ${task} has an in-flight Attempt — wait for its report before accepting`);
      }
      const events = attemptEvents(history, attempt);
      if (events.length === 0) {
        throw new FactoryError("unknown-attempt", `task ${task} has no attempt ${attempt}`);
      }
      const priorAccept = acceptedAttempt(fullHistory);
      if (priorAccept !== undefined && priorAccept.landing !== "pending-conflict") {
        throw new FactoryError(
          "already-accepted",
          `task ${task} was already accepted at attempt ${priorAccept.attempt}; the ledger is append-only`,
        );
      }
      // Acceptance's closure gate (v0.5.0, ADR 0054 §5): retirement is the
      // other terminal — green evidence a close already retired is never
      // accept-worthy after the fact.
      const closure = closureEvent(fullHistory);
      if (closure !== undefined) {
        throw new FactoryError(
          "already-closed",
          `task ${task} was closed (reason: ${closure.reason}) — the retirement is terminal; the ledger is append-only`,
        );
      }
      const gate = events.findLast((e): e is GateFinished => e.event === "gate_finished");
      if (!gate || gate.verdict !== "green") {
        throw new FactoryError(
          "not-green",
          `attempt ${attempt} of task ${task} has no green verdict — the Owner accepts evidence, and there is none`,
        );
      }
      const state = projectTask(fullHistory, task);
      const attemptState = state.attempts.find((entry) => entry.attempt === attempt)!;
      // Direct Owner callers retain compatibility. Transport callers always supply
      // server-resolved authority, so attribution cannot select a weaker policy.
      const role = authority ?? (accepted_by === "lead" ? "lead" : "owner");
      if (role === "agent") throw new FactoryError("agent-cannot-orchestrate", "Working Agents cannot accept Tasks");
      if (role === "lead" && !attemptState.leadEligible) {
        throw new FactoryError("lead-accept-refused", `${attemptState.leadRefusal ?? "attempt is ineligible"} — the Owner or delegated Supervisor must override`);
      }
      // Local landing (v0.0.14, ADR 0010 §4): a task that ran in a managed
      // Task worktree integrates its claimedCommit into <project-root>'s
      // local branch BEFORE the acceptance line records — the line carries
      // the outcome (`landed`, or `pending-conflict` with the reason and the
      // preserved factory/<task> branch). Legacy shared-checkout tasks skip
      // the step and record exactly as before. Never a git push.
      //
      // The read-only exception (ADR 0053 §3, ticket 05): a scout /
      // architect / reviewer Task never merges — its findings travel in the
      // 6-Field Handoff, not in commits — so acceptance records NO landing
      // fields and still removes the Task worktree (the landing's cleanup
      // half alone). A pending-conflict retry keeps the ordinary landing
      // machinery: that conflict is repair work from an engineer-era accept.
      const historicalWorktree = priorAccept?.landing === "pending-conflict"
        ? fullHistory.findLast((event): event is SpawnDispatched => event.event === "spawn_dispatched" && typeof event.worktree === "string" && event.worktree !== "")?.worktree
        : undefined;
      const worktree = this.worktreeFor(task) ?? historicalWorktree;
      let landing: "landed" | "pending-conflict" | undefined;
      let landingNote: string | undefined;
      if (worktree !== undefined && priorAccept?.landing !== "pending-conflict" && isReadOnlyPeerDisposition(contract.disposition)) {
        await removeTaskWorktree(contract.workspace, worktree);
      } else if (worktree !== undefined && gate.sha !== undefined) {
        const contractSlug = projectSlugOfWorkspace(contract.workspace);
        const result = await landTaskWorktree({
          projectRoot: contract.workspace,
          worktree,
          claimedCommit: gate.sha,
          ...(priorAccept?.landing === "pending-conflict" ? { retry: true } : {}),
          ...(contract.base === undefined ? {} : { base: contract.base }),
          branch: `factory/${task}`,
          // v0.5.0 (ADR 0052 Decision 1): a legacy untracked
          // `.scratch/notebook.md` promotes into <projectStateDir>/ before
          // the landing's clean-tree check — never a pending-conflict.
          stateDir,
          ...(contractSlug === undefined ? {} : { projectSlug: contractSlug }),
        });
        landing = result.landing;
        landingNote = result.note;
      } else if (priorAccept?.landing === "pending-conflict") {
        landing = "pending-conflict";
        landingNote = "cannot resolve the pending task's worktree or verified commit; repair its task branch before retrying";
      }
      return ledger.append({
        event: "attempt_accepted",
        task,
        attempt,
        ...(accepted_by === undefined ? {} : { accepted_by }),
        ...(landing === undefined ? {} : { landing }),
        ...(landingNote === undefined ? {} : { landingNote }),
      });
    },

    async close({ task, reason, by, authority }) {
      assertTaskId(task);
      if (reason.trim() === "") {
        throw new FactoryError("invalid-close", "reason must be a non-empty string — the ledger keeps the one sentence that says why the Task retired");
      }
      const fullHistory = ledger.eventsFor(task);
      const history = epochEventsFor(ledger, task);
      const contract = this.contractFor(task);
      if (contract === undefined) {
        throw new FactoryError("unknown-task", `no contract set for task ${task} — register one first`);
      }
      const priorAccept = acceptedAttempt(fullHistory);
      if (priorAccept !== undefined) {
        throw new FactoryError(
          "already-accepted",
          `task ${task} was already accepted at attempt ${priorAccept.attempt}; the ledger is append-only`,
        );
      }
      if (fullHistory.some((event) => event.event === "task_closed")) {
        throw new FactoryError("already-closed", `task ${task} was already closed; the ledger is append-only`);
      }
      if (inFlightAttempt(history) !== undefined) {
        throw new FactoryError("gate-running", `task ${task} has an in-flight Attempt — wait for its report before closing`);
      }
      // The acceptance's own seat law (v0.0.14, ADR 0010 §3), mirrored: the
      // transport's resolved authority decides, a bare `by` only claims.
      const role = authority ?? (by === "lead" ? "lead" : "owner");
      if (role === "agent") throw new FactoryError("agent-cannot-close", "Working Agents cannot close Tasks");
      // The cleanup precedes the line (the acceptance's async-git law): when
      // the line records, the Task's execution tree is already gone — the
      // managed worktree AND its factory/<task> branch, which a retirement
      // owes the repo back (the landing path keeps it; this path deletes it).
      const worktree = this.worktreeFor(task);
      if (worktree !== undefined) await removeTaskWorktree(contract.workspace, worktree);
      await deleteTaskWorktreeBranch(contract.workspace, task);
      return ledger.append({
        event: "task_closed",
        task,
        reason,
        ...(by === undefined ? {} : { closed_by: by }),
      });
    },

    requestSpawn({ task, provider, arity, worktree, thinking, thinkingReason }) {
      const base = { task, provider, arity, ...(worktree === undefined || worktree.trim() === "" ? {} : { worktree }) };
      // Two spellings of one refusal on purpose: `code` is dash-style for the
      // spool reply (the FactoryError convention), `rule` is colon-style for
      // the ledger line (the choke's `policy:S1-…` / `git:…` convention).
      const refuse = (code: string, rule: string, reason: string): SpawnDecision => ({
        outcome: "refused",
        code,
        event: ledger.append({ ...base, event: "spawn_refused", rule, reason }),
      });
      // Validation order follows ticket 03 §3's list; every refusal is one
      // ledger line, never a thrown error — the driver hears a reply, the
      // ledger hears the fact.
      if (!Number.isInteger(arity) || arity < 1 || provider.trim() === "") {
        return refuse(
          "invalid-spawn",
          "spawn:invalid-request",
          `spawn request for task ${JSON.stringify(task)} is malformed — arity must be a positive integer and provider a non-empty string`,
        );
      }
      // The per-dispatch effort law (v0.5.0, ADR 0054 §4): a supplied tier is
      // one of the five levels AND carries its one-sentence reason — an
      // unexplained or mistyped tier is a malformed request, refused like any
      // other, never silently dropped. (The spool admits only the five tiers
      // or absence; this guards every other caller, including untyped ones.)
      if (thinking !== undefined) {
        if (!(PEER_THINKING_LEVELS as readonly string[]).includes(thinking)) {
          return refuse(
            "invalid-spawn",
            "spawn:invalid-request",
            `spawn request for task ${JSON.stringify(task)} carries thinking "${thinking}" — use one of low | medium | high | xhigh | max`,
          );
        }
        if ((thinkingReason ?? "").trim() === "") {
          return refuse(
            "invalid-spawn",
            "spawn:invalid-request",
            "thinkingReason is required when thinking is specified",
          );
        }
      }
      if (!TASK_ID_PATTERN.test(task)) {
        return refuse(
          "invalid-task",
          "spawn:invalid-task",
          `task id "${task}" is invalid — use letters, digits, ".", "_", "-"`,
        );
      }
      const contract = this.contractFor(task);
      if (!contract) {
        return refuse("unknown-task", "spawn:unknown-task", `no contract set for task ${task} — register one first`);
      }
      const fullHistory = ledger.eventsFor(task);
      const priorAccept = acceptedAttempt(fullHistory);
      if (priorAccept !== undefined) {
        return refuse(
          "already-accepted",
          "spawn:accepted-task",
          `task ${task} was already accepted at attempt ${priorAccept.attempt} — the task is closed`,
        );
      }
      // The retirement's spawn-side arm (v0.5.0, ADR 0054 §5): a closed Task
      // is terminal — a straggler driver's spawn allocates no worktree and
      // rebuilds no factory/<task> branch on the retired ID.
      const closure = closureEvent(fullHistory);
      if (closure !== undefined) {
        return refuse(
          "already-closed",
          "spawn:closed-task",
          `task ${task} was already closed (reason: ${closure.reason}) — the retirement is terminal`,
        );
      }
      const history = epochEventsFor(ledger, task);
      if (maxAttempt(history) >= MAX_ATTEMPTS && !history.some((e) => e.event === "gate_finished" && e.verdict === "green")) {
        return refuse(
          "attempt-ceiling",
          "spawn:attempt-ceiling",
          `task ${task} reached the attempt ceiling (${MAX_ATTEMPTS} red attempts) — no further Attempt may open`,
        );
      }
      const conflict = liveWorkspaceConflict(ledger, contract.workspace, task, contract.scope);
      if (conflict !== undefined) {
        return refuse(
          "workspace-conflict",
          "spawn:workspace-conflict",
          `workspace "${contract.workspace}" of task ${task} ${relationText(conflict.relation)} the live contract of task ${conflict.task} (${conflict.workspace})`,
        );
      }
      return {
        outcome: "dispatched",
        event: ledger.append({
          ...base,
          event: "spawn_dispatched",
          ...(thinking === undefined ? {} : { thinking }),
          ...(thinking !== undefined && (thinkingReason ?? "").trim() !== "" ? { thinkingReason: thinkingReason!.trim() } : {}),
        }),
      };
    },

    meter({ task, provider, usage, agent }) {
      assertTaskId(task);
      if (provider.trim() === "") {
        throw new FactoryError("invalid-meter", "meter provider must be a non-empty string — the provider[/model] the driver ran the task under");
      }
      if (!usageIsValid(usage)) {
        throw new FactoryError(
          "invalid-meter",
          "meter usage must be an object of the daemon's four fields (inputTokens, cachedInputTokens, outputTokens, totalCostUsd), each a finite number when present — an empty object is the honest empty capture",
        );
      }
      if (agent !== undefined && (typeof agent !== "string" || agent.trim() === "")) {
        throw new FactoryError("invalid-meter", "meter agent must be a non-empty string — omit it when the driver knows no agent id");
      }
      // Task known = a Contract exists (ticket 03 item 1's validation). The
      // meter deliberately does not care about attempts or acceptance: it
      // lands at the task's terminal moment, wherever the judging stands.
      if (this.contractFor(task) === undefined) {
        throw new FactoryError("unknown-task", `no contract set for task ${task} — the meter records a run, and no run was ever contracted`);
      }
      return ledger.append({
        event: "meter_written",
        task,
        provider,
        usage,
        ...(agent === undefined ? {} : { agent }),
      });
    },

    repoke(task, agent, message) {
      // Two spellings of one refusal on purpose (the requestSpawn precedent):
      // `code` dash-style for the spool reply, `rule` colon-style for the line.
      const refuse = (code: string, rule: string, reason: string): RepokeDecision => ({
        outcome: "refused",
        code,
        event: ledger.append({ event: "repoke_refused", task, agent, rule, reason }),
      });
      if (typeof agent !== "string" || agent.trim() === "") {
        return refuse(
          "invalid-repoke",
          "repoke:invalid-request",
          `re-poke for task ${JSON.stringify(task)} is malformed — agent must name the stalled agent the message goes to`,
        );
      }
      if (!TASK_ID_PATTERN.test(task)) {
        return refuse("invalid-task", "repoke:invalid-task", `task id "${task}" is invalid — use letters, digits, ".", "_", "-"`);
      }
      const contract = this.contractFor(task);
      if (!contract) {
        return refuse("unknown-task", "repoke:unknown-task", `no contract set for task ${task} — the Lead presides over contracted work only`);
      }
      const fullHistory = ledger.eventsFor(task);
      const priorAccept = acceptedAttempt(fullHistory);
      if (priorAccept !== undefined) {
        return refuse(
          "already-accepted",
          "repoke:accepted-task",
          `task ${task} was already accepted at attempt ${priorAccept.attempt} — the task is closed`,
        );
      }
      // ADR 0053 Decision 3: a repoke bearing the Lead's message is a live
      // reconciliation turn, never the Denial-stall's one spend — the cap
      // below lifts for it. The message body is delivery-only (it never
      // rides the dispatch line), and anything but a non-empty string reads
      // as message-less, so the factory stays the judge of its own law.
      const messageBearing = typeof message === "string" && message.trim() !== "";
      const history = epochEventsFor(ledger, task);
      // The structural one-per-task law: the dispatch line IS the spent
      // marker — a second ask names its own refusal, and a driver crash
      // re-reads this slice rather than trusting any socket.
      if (!messageBearing && history.some((e) => e.event === "repoke_dispatched")) {
        return refuse(
          "already-spent",
          "repoke:already-spent",
          `task ${task} already spent its one re-poke (its repoke_dispatched line) — the stall's named end is needs_human, not a second poke`,
        );
      }
      return { outcome: "dispatched", event: ledger.append({ event: "repoke_dispatched", task, agent }) };
    },

    respawn({ task, provider, died_agent }) {
      const base = { task, provider, died_agent };
      const refuse = (code: string, rule: string, reason: string): RespawnDecision => ({
        outcome: "refused",
        code,
        event: ledger.append({ ...base, event: "respawn_refused", rule, reason }),
      });
      if (typeof provider !== "string" || provider.trim() === "" || typeof died_agent !== "string" || died_agent.trim() === "") {
        return refuse(
          "invalid-respawn",
          "respawn:invalid-request",
          `respawn request for task ${JSON.stringify(task)} is malformed — provider and died_agent must be non-empty strings`,
        );
      }
      if (!TASK_ID_PATTERN.test(task)) {
        return refuse("invalid-task", "respawn:invalid-task", `task id "${task}" is invalid — use letters, digits, ".", "_", "-"`);
      }
      const contract = this.contractFor(task);
      if (!contract) {
        return refuse("unknown-task", "respawn:unknown-task", `no contract set for task ${task} — register one first`);
      }
      const fullHistory = ledger.eventsFor(task);
      const priorAccept = acceptedAttempt(fullHistory);
      if (priorAccept !== undefined) {
        return refuse(
          "already-accepted",
          "respawn:accepted-task",
          `task ${task} was already accepted at attempt ${priorAccept.attempt} — the task is closed`,
        );
      }
      const history = epochEventsFor(ledger, task);
      if (maxAttempt(history) >= MAX_ATTEMPTS) {
        return refuse(
          "attempt-ceiling",
          "respawn:attempt-ceiling",
          `task ${task} reached the attempt ceiling (${MAX_ATTEMPTS} attempts) — no replacement agent may be spawned`,
        );
      }
      let spawnSeq = -1;
      let progressSeq = -1;
      for (const evt of history) {
        if (evt.event === "spawn_dispatched") {
          spawnSeq = evt.seq;
          if (evt.seq > progressSeq) progressSeq = evt.seq;
        } else if (evt.event === "gate_finished") {
          if (evt.seq > progressSeq) progressSeq = evt.seq;
        }
      }
      if (spawnSeq === -1) {
        return refuse(
          "not-spawned",
          "respawn:not-spawned",
          `task ${task} has no spawn_dispatched line — respawn replaces a dead spawned agent, never an unspawned task`,
        );
      }
      if (history.some((e) => e.event === "respawn_dispatched" && e.seq > progressSeq)) {
        return refuse(
          "respawn-ceiling",
          "respawn:already-spent",
          `task ${task} already spent its one automatic respawn since progress marker seq ${progressSeq} — a second death ends in needs_human`,
        );
      }
      return { outcome: "dispatched", event: ledger.append({ ...base, event: "respawn_dispatched" }) };
    },

    needsHuman({ task, reason, evidence }) {
      assertTaskId(task);
      if (!(NEEDS_HUMAN_REASONS as readonly string[]).includes(reason)) {
        throw new FactoryError("invalid-needs-human", `reason must be one of the fixed vocabulary (${NEEDS_HUMAN_REASONS.join(", ")}), got ${JSON.stringify(reason)}`);
      }
      if (!needsHumanEvidenceIsValid(evidence, reason)) {
        throw new FactoryError(
          "invalid-needs-human",
          `evidence for reason "${reason}" must carry its matching positive-integer evidence fields`,
        );
      }
      if (this.contractFor(task) === undefined) {
        throw new FactoryError("unknown-task", `no contract set for task ${task} — needs_human records a stalled run, and no run was ever contracted`);
      }
      const history = epochEventsFor(ledger, task);
      if (reason === "denied-again" || reason === "silent-after-repoke") {
        const ev = evidence as { denial: number; repoke: number };
        const spent = history.findLast((e): e is RepokeDispatched => e.event === "repoke_dispatched");
        if (spent === undefined || spent.seq !== ev.repoke) {
          throw new FactoryError(
            "invalid-needs-human",
            `task ${task} has no spent re-poke at seq ${ev.repoke} — needs_human records a stall that survived its poke, and the ledger does not show one`,
          );
        }
        if (!history.some((e) => e.event === "permit_denied" && e.seq === ev.denial)) {
          throw new FactoryError(
            "invalid-needs-human",
            `task ${task} has no permit_denied at seq ${ev.denial} — the evidence names the denial the stall answered`,
          );
        }
      } else if (reason === "attempt-ceiling") {
        const ev = evidence as { attempt: number; gate: number };
        if (ev.attempt !== MAX_ATTEMPTS) {
          throw new FactoryError(
            "invalid-needs-human",
            `attempt-ceiling evidence must name attempt ${MAX_ATTEMPTS}, got ${ev.attempt}`,
          );
        }
        const gate = history.find((e): e is GateFinished => e.event === "gate_finished" && e.seq === ev.gate);
        if (gate === undefined || gate.attempt !== MAX_ATTEMPTS || gate.verdict !== "red") {
          throw new FactoryError(
            "invalid-needs-human",
            `task ${task} has no red gate_finished for attempt ${MAX_ATTEMPTS} at seq ${ev.gate}`,
          );
        }
      } else {
        const ev = evidence as { spawn: number; respawn: number };
        if (ev.respawn <= ev.spawn) {
          throw new FactoryError(
            "invalid-needs-human",
            `died-after-respawn evidence requires respawn seq (${ev.respawn}) > spawn seq (${ev.spawn})`,
          );
        }
        if (!history.some((e) => e.event === "spawn_dispatched" && e.seq === ev.spawn)) {
          throw new FactoryError(
            "invalid-needs-human",
            `task ${task} has no spawn_dispatched at seq ${ev.spawn}`,
          );
        }
        const latestRespawn = history.findLast((e): e is RespawnDispatched => e.event === "respawn_dispatched");
        if (latestRespawn === undefined || latestRespawn.seq !== ev.respawn) {
          throw new FactoryError(
            "invalid-needs-human",
            `task ${task} has no latest respawn_dispatched at seq ${ev.respawn}`,
          );
        }
        if (history.some((e) => e.event === "gate_finished" && e.seq > ev.respawn)) {
          throw new FactoryError(
            "invalid-needs-human",
            `task ${task} has a gate_finished after respawn seq ${ev.respawn} — the respawn progressed to an Attempt`,
          );
        }
      }
      return ledger.append({ event: "needs_human", task, reason, evidence });
    },

    liveContractFor(cwd) {
      const accepted = acceptedTasks(ledger);
      // Re-contracting changes the criteria, not the task's still-live worktree.
      const latestContracts = new Map<string, ContractSet>();
      for (const evt of ledger.events) {
        if (evt.event === "contract_set" && !accepted.has(evt.task)) {
          latestContracts.set(evt.task, evt);
        }
      }
      let match: ContractSet | undefined;
      for (const evt of latestContracts.values()) {
        if (covers(evt, cwd)) match = evt;
        const worktree = this.worktreeFor(evt.task);
        if (worktree !== undefined && (cwd === worktree || cwd.startsWith(`${worktree}/`))) match = evt;
      }
      return match;
    },

    contractFor(task) {
      return projectTask(ledger.eventsFor(task), task).contract;
    },

    worktreeFor(task) {
      const history = ledger.eventsFor(task);
      const acceptance = acceptedAttempt(history);
      if (acceptance !== undefined && acceptance.landing !== "pending-conflict") return undefined;
      // A clean retirement retires the binding too (v0.5.0, ADR 0054 §5): the
      // choke and the close's own cleanup never resurrect a closed Task's tree.
      if (history.some((event) => event.event === "task_closed")) return undefined;
      const epoch = epochEventsFor(ledger, task);
      for (const evt of epoch.toReversed()) {
        if (evt.event === "spawn_dispatched" && typeof evt.worktree === "string" && evt.worktree !== "") return evt.worktree;
      }
      // A new spawn supersedes the previous binding, including legacy spawns
      // without a worktree. Only an epoch with no spawn inherits its predecessor.
      if (epoch.some((evt) => evt.event === "spawn_dispatched")) return undefined;
      const spawn = history.findLast((evt): evt is SpawnDispatched => evt.event === "spawn_dispatched");
      return spawn?.worktree !== undefined && spawn.worktree !== "" && directoryExists(spawn.worktree)
        ? spawn.worktree
        : undefined;
    },

    attemptsOf(task) {
      assertTaskId(task);
      return epochEventsFor(ledger, task).filter((e): e is GateFinished => e.event === "gate_finished");
    },

    activeSpawnOf(task) {
      assertTaskId(task);
      return epochEventsFor(ledger, task).findLast((e): e is SpawnDispatched => e.event === "spawn_dispatched");
    },

    lastProgressSeq(task) {
      assertTaskId(task);
      let progressSeq = 0;
      for (const evt of epochEventsFor(ledger, task)) {
        if (evt.event === "spawn_dispatched" || evt.event === "gate_finished") {
          if (evt.seq > progressSeq) progressSeq = evt.seq;
        }
      }
      return progressSeq;
    },

    isNeedsHuman(task) {
      assertTaskId(task);
      return taskInNeedsHuman(epochEventsFor(ledger, task));
    },

    resetProject(projectRoot, projectSlug) {
      const rawRoot = normalized(projectRoot);
      const realRoot = realpathSafe(projectRoot);
      const matchesProjectRoot = (candidate: string): boolean => {
        const norm = normalized(candidate);
        const real = realpathSafe(candidate);
        return (
          norm === rawRoot ||
          norm.startsWith(`${rawRoot}/`) ||
          real === realRoot ||
          real.startsWith(`${realRoot}/`)
        );
      };
      const slug = projectSlug !== undefined && projectSlug.trim() !== "" ? projectSlug.trim() : options.projectSlug;
      const projectDir = slug !== undefined ? projectStateDir(stateDir, slug) : undefined;
      const rawProjectDir = projectDir !== undefined ? normalized(projectDir) : undefined;
      const realProjectDir = projectDir !== undefined ? realpathSafe(projectDir) : undefined;
      const matchesProjectState = (candidate: string): boolean => {
        if (rawProjectDir === undefined || realProjectDir === undefined) return false;
        const norm = normalized(candidate);
        const real = realpathSafe(candidate);
        return (
          norm === rawProjectDir ||
          norm.startsWith(`${rawProjectDir}/`) ||
          real === realProjectDir ||
          real.startsWith(`${realProjectDir}/`)
        );
      };

      const projectTaskSet = new Set<string>();
      const otherProjectTasks = new Set<string>();
      for (const evt of ledger.events) {
        if (evt.event === "contract_set") {
          if (matchesProjectRoot(evt.workspace) || matchesProjectState(evt.workspace)) {
            projectTaskSet.add(evt.task);
          } else {
            otherProjectTasks.add(evt.task);
          }
        } else if (evt.event === "spawn_dispatched" && typeof evt.worktree === "string" && evt.worktree !== "") {
          if (matchesProjectRoot(evt.worktree) || matchesProjectState(evt.worktree)) {
            projectTaskSet.add(evt.task);
          }
        }
      }
      for (const task of projectTaskSet) {
        otherProjectTasks.delete(task);
      }

      const purgedBlockIds = new Set<string>();
      const shouldPurge = (evt: LedgerEvent): boolean => {
        if ("task" in evt && typeof evt.task === "string" && projectTaskSet.has(evt.task)) {
          return true;
        }
        if ("cwd" in evt && typeof (evt as { cwd?: unknown }).cwd === "string") {
          const cwd = (evt as { cwd: string }).cwd;
          if (matchesProjectRoot(cwd) || matchesProjectState(cwd)) return true;
        }
        if (evt.event === "retro_written" && otherProjectTasks.size === 0) {
          return true;
        }
        return false;
      };
      for (const evt of ledger.events) {
        if (evt.event === "git_blocked" && shouldPurge(evt)) purgedBlockIds.add(evt.blockId);
      }
      // Scrub the ingestion source before purging its deduplication evidence.
      const refusalLog = join(stateDir, "git-blocked.log");
      if (existsSync(refusalLog)) {
        const kept = readFileSync(refusalLog, "utf8").split("\n").filter(line => {
          try {
            const record = JSON.parse(line);
            return !(purgedBlockIds.has(record.id) || typeof record.cwd === "string" && (matchesProjectRoot(record.cwd) || matchesProjectState(record.cwd)));
          } catch { return true; }
        });
        const tmp = `${refusalLog}.${process.pid}.tmp`;
        try {
          writeFileSync(tmp, kept.join("\n"));
          renameSync(tmp, refusalLog);
        } finally { rmSync(tmp, { force: true }); }
      }
      const purgedEvents = ledger.purgeWhere(shouldPurge);

      const tasks = [...projectTaskSet];
      const dirsToClean = [...new Set([stateDir, dataDir, ...(projectDir !== undefined ? [projectDir] : [])])];
      let removedFiles = 0;
      for (const dir of dirsToClean) {
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          const matchesTaskFile = tasks.some(
            (task) =>
              (entry.startsWith(`report-${task}-`) && entry.endsWith(".md")) ||
              (entry.startsWith(`gate-${task}-`) && entry.endsWith(".log")),
          );
          const matchesRetroFile =
            (otherProjectTasks.size === 0 || dir === projectDir || (slug !== "" && entry.startsWith(`retro-${slug}`))) &&
            entry.startsWith("retro-") &&
            (entry.endsWith(".md") || entry.endsWith(".json"));
          if (matchesTaskFile || matchesRetroFile) {
            try {
              rmSync(join(dir, entry), { force: true });
              removedFiles += 1;
            } catch {
              // ignore best-effort file removal failure
            }
          }
        }
      }

      return { purgedEvents, tasks, removedFiles };
    },

  };
  const asyncOperations = new Set(["claim", "accept"]);
  const syncOperations = new Set(["setContract", "requestSpawn", "meter", "repoke", "respawn", "needsHuman", "resetProject"]);
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(factory, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key !== "string" || typeof value !== "function" || (!asyncOperations.has(key) && !syncOperations.has(key))) return value;
      if (!wrappers.has(key)) wrappers.set(key, (...args: unknown[]) => {
        if (key === "resetProject" && history.activeOperations > 0 && !history.maintenanceActive) throw new FactoryError("history-maintenance-busy", "reset requires settled operations; use the asynchronous Owner reset entrance");
        return asyncOperations.has(key)
          ? history.runOperation(() => value.apply(receiver, args), { newWork: true })
          : history.runSync(() => value.apply(receiver, args));
      });
      return wrappers.get(key);
    },
  });
}

/**
 * The seq of the latest `contract_set` event for `task`, or 0 when none exists.
 * Every per-task fold and ceiling check scopes to the current Contract epoch
 * (`seq >= latestContractSeq(ledger, task)`).
 */
export function latestContractSeq(ledger: Ledger, task: string): number {
  return projectTask(ledger.eventsFor(task), task).epochSeq;
}

/** All ledger events for `task` in its current Contract epoch (`seq >= latestContractSeq`). */
function epochEventsFor(ledger: Ledger, task: string): LedgerEvent[] {
  return projectTask(ledger.eventsFor(task), task).epoch;
}

/**
 * Returns the attempt number of an in-flight Attempt in the given epoch history
 * (a `claim_reported` or `gate_started` with no matching `report_written`), or
 * `undefined` if no Attempt is currently running.
 */
function inFlightAttempt(history: readonly LedgerEvent[]): number | undefined {
  return historyState(history)?.inFlightAttempt;
}

/** A historical worktree binding is live only while its directory survives. */
function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A Contract covers a cwd when the cwd is the workspace or sits inside it. */
function covers(contract: ContractSet, cwd: string): boolean {
  return cwd === contract.workspace || cwd.startsWith(`${contract.workspace}/`);
}

function historyState(history: readonly LedgerEvent[]) {
  const event = history.find((entry) => "task" in entry && typeof entry.task === "string");
  return event !== undefined && "task" in event && typeof event.task === "string" ? projectTask(history, event.task) : undefined;
}

/** The task's acceptance, when the Owner has accepted — the closed-marker every closer reads. */
function acceptedAttempt(history: readonly LedgerEvent[]): AttemptAccepted | undefined {
  return historyState(history)?.acceptance;
}

/**
 * The task's clean retirement, when the Lead/Owner closed it (v0.5.0, ADR
 * 0054 §5) — the terminal marker every write seam reads beside acceptance.
 */
function closureEvent(history: readonly LedgerEvent[]): TaskClosed | undefined {
  return history.findLast((event): event is TaskClosed => event.event === "task_closed");
}

/**
 * Whether the task currently stands in `needs_human` (the lead-acceptance
 * rule's escalation check, v0.0.14): the latest `needs_human` line wins while
 * no later `gate_finished` displaces it — the view's own status fold rule. An
 * Owner answer that wakes the task (a new spawn and a fresh Attempt's green
 * gate) displaces the marker, and the Lead may accept THAT attempt.
 */
function taskInNeedsHuman(history: readonly LedgerEvent[]): boolean {
  return historyState(history)?.needsHuman ?? false;
}

/** How one workspace relates to another — the workspace-conflict key (v0.0.5). */
type WorkspaceRelation = "equal" | "inside" | "contains";

/** One line of English for a relation — the error and the refusal share it. */
function relationText(relation: WorkspaceRelation): string {
  if (relation === "equal") return "is the same tree as";
  if (relation === "inside") return "sits inside";
  return "contains";
}

function realpathSafe(path: string): string {
  try {
    return normalized(realpathSync(path));
  } catch {
    return normalized(path);
  }
}

/**
 * Every Attempt's closing window: the full gate output lands beside the report
 * (ticket 02a), the Verdict is appended with a pointer to it, and — when the
 * Contract marks fresh-eyes and the Verdict is green — the eye's one advisory
 * pass runs before the report, so the report is written once, already
 * containing the eye's line (ticket 03 §2). The watch (v0.0.6) follows the eye
 * on BOTH verdicts — the stuck-loop battery arm is red by construction — and
 * is record-only: its line lands, nothing downstream reads
 * it, the Verdict and the accept flow are untouched.
 */
async function finish(
  ctx: {
    task: string;
    ledger: Ledger;
    /** The root state dir — the eye's and watch's machine-level config (lanes.json, eye.json). */
    stateDir: string;
    /** Where the data files land: the project dir when project-scoped, the root otherwise. */
    dataDir: string;
  contract: ContractSet;
  eyeBudgetMs: number | undefined;
  eyeRunner: LaneCliRunner | undefined;
  /** The admitted handoff (ADR 0053 §4) — rides the outcome for the notification pipeline; absent on a `lead_verify` mechanical re-run. */
  handoff: PeerHandoffFields | undefined;
  },
  attempt: number,
  result: GateResult,
  sha: string | undefined,
  watch: {
    agent: string | undefined;
    scopeViolations: string[] | undefined;
    fetchTimeline: TimelineFetcher | undefined;
    budgetMs: number | undefined;
    copilotRunner: CopilotRunner | undefined;
  },
): Promise<ClaimOutcome> {
  const { task, ledger, stateDir, dataDir, contract, eyeBudgetMs, eyeRunner } = ctx;
  let outputPath: string | undefined;
  if (result.output !== undefined) {
    outputPath = join(dataDir, `gate-${attemptEvidenceName(task, attempt, contract)}.log`);
    writeFileSync(outputPath, result.output);
  }
  const gate = ledger.append({
    event: "gate_finished",
    task,
    attempt,
    exit: result.exit,
    verdict: result.verdict,
    note: result.note,
    ...(sha === undefined ? {} : { sha }),
    ...(outputPath === undefined ? {} : { outputPath }),
  });
  if (contract.freshEyes === true && result.verdict === "green" && sha !== undefined) {
    const eye = await runFreshEyesPass({
      stateDir,
      contract,
      claimedSha: sha,
      gateOutputPath: outputPath,
      budgetMs: eyeBudgetMs,
      cliRunner: eyeRunner,
    });
    ledger.append({
      event: "fresh_eyes_written",
      task,
      attempt,
      model: eye.model,
      outcome: eye.outcome,
      finding: eye.finding,
      durationMs: eye.durationMs,
    });
  }
  if (contract.watch === true) {
    const gitBlocks = epochEventsFor(ledger, task)
      .filter((e): e is GitBlocked => e.event === "git_blocked")
      .map((e) => ({ rule: e.rule, command: e.command }));
    const watched = await runWatchPass({
      stateDir,
      contract,
      task,
      attempt,
      sha,
      gateResult: result,
      gateOutputPath: outputPath,
      scopeViolations: watch.scopeViolations,
      agent: watch.agent,
      fetchTimeline: watch.fetchTimeline,
      gitBlocks,
      ...(watch.budgetMs === undefined ? {} : { budgetMs: watch.budgetMs }),
      ...(watch.copilotRunner === undefined ? {} : { copilotRunner: watch.copilotRunner }),
    });
    ledger.append({
      event: "watch_written",
      task,
      attempt,
      model: watched.model,
      outcome: watched.outcome,
      ...(watched.answers === undefined ? {} : { answers: watched.answers }),
      ...(watched.usage === undefined ? {} : { usage: watched.usage }),
      durationMs: watched.durationMs,
      ...(watched.error === undefined ? {} : { error: watched.error }),
    });
  }
  const reportPath = writeAttemptReport(task, attempt, ledger, dataDir);
  return { attempt, verdict: result.verdict, gate, reportPath, handoff: ctx.handoff };
}

/** V2 evidence belongs to a stable Contract epoch; legacy paths remain usable. */
function attemptEvidenceName(task: string, attempt: number, contract: ContractSet | undefined): string {
  const epoch = contract?.epoch_id;
  return epoch === undefined ? `${task}-${attempt}` : `${task}-${createHash("sha256").update(epoch).digest("hex")}-${attempt}`;
}

/** Every Attempt ends the same way: report rendered from the ledger, written, acknowledged. */
function writeAttemptReport(task: string, attempt: number, ledger: Ledger, dataDir: string): string {
  const markdown = renderReport(task, attempt, epochEventsFor(ledger, task));
  const contract = projectTask(ledger.eventsFor(task), task).contract;
  const reportPath = join(dataDir, `report-${attemptEvidenceName(task, attempt, contract)}.md`);
  writeFileSync(reportPath, markdown);
  ledger.append({ event: "report_written", task, attempt, path: reportPath });
  return reportPath;
}

/** The highest Attempt number a task's history mentions, or 0 when none opened yet. */
function maxAttempt(history: readonly LedgerEvent[]): number {
  return historyState(history)?.maxAttempt ?? 0;
}

/** One Attempt's own events — Contracts and choke events belong to the Task, not to any Attempt. */
function attemptEvents(history: readonly LedgerEvent[], attempt: number): LedgerEvent[] {
  return history.filter((e) => "attempt" in e && e.attempt === attempt);
}

/**
 * An Attempt is open while its report is not written. Between gate_started and
 * report_written there are two awaits — the gate and, depending on the
 * Contract's marks, the eye's and/or the watch's pass — so an open Attempt
 * usually means one of them is running.
 */
function attemptIsOpen(history: readonly LedgerEvent[], attempt: number): boolean {
  return historyState(history)?.attempts.find((entry) => entry.attempt === attempt)?.open ?? false;
}

/**
 * ADR 0003 recovery, run once when the factory opens its ledger: any Attempt
 * that never reached its report gets one now. An Attempt with no gate_finished
 * was interrupted before any green was established — red is the fact, not a
 * guess. An Attempt that already has its gate_finished (a restart during the
 * fresh-eyes or watch pass is the one window where that happens) gets only its
 * missing report — never a second gate_finished over a verdict that already
 * landed (ticket 03 R1). The interrupted pass itself is never re-run: its line
 * simply never exists, recovery's report says so by omission.
 */
function recoverInterruptedAttempts(ledger: Ledger, dataDir: string): { task: string; attempt: number }[] {
  const recovered: { task: string; attempt: number }[] = [];
  // `retro_written` carries no task — only tasked events can need recovery.
  const tasks = [...new Set(ledger.events.flatMap((e) => ("task" in e && typeof e.task === "string" ? [e.task] : [])))];
  for (const task of tasks) {
    const history = epochEventsFor(ledger, task);
    for (let attempt = 1; attempt <= maxAttempt(history); attempt++) {
      if (!attemptIsOpen(history, attempt)) continue;
      const events = attemptEvents(history, attempt);
      const gateStarted = events.some((e) => e.event === "gate_started");
      const alreadyFinished = events.some((e) => e.event === "gate_finished");
      if (!alreadyFinished) {
        ledger.append({
          event: "gate_finished",
          task,
          attempt,
          exit: null,
          verdict: "red",
          note: gateStarted
            ? "interrupted — the factory restarted before the Gate finished"
            : "interrupted — the factory restarted before the Gate started",
        });
      }
      writeAttemptReport(task, attempt, ledger, dataDir);
      recovered.push({ task, attempt });
    }
  }
  return recovered;
}

function assertTaskId(task: string): void {
  if (!TASK_ID_PATTERN.test(task)) {
    throw new FactoryError(
      "invalid-task",
      `task id "${task}" is invalid — use letters, digits, ".", "_", "-" (it becomes a report filename)`,
    );
  }
}
