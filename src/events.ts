/**
 * Ledger event shapes — the v0.0.1 contract with the roadmap doc
 * (`research/03-hands-on/05-lo-trinh-paseo-factory.md` §2), as amended by the
 * ADRs. The five §2 events keep their order; the changes on top: every event
 * carries `ts` (ADR 0003), every event after the Contract carries the Attempt
 * number it belongs to (ADR 0003), the Contract fixes the Workspace (ticket 08
 * / ADR 0002 — the Owner chooses where the Gate runs, never the Agent), and
 * `claim_reported` replaces §2's `done_reported` (ADR 0003: the Agent makes a
 * Claim, never "done"). `attempt_accepted` is ADR 0002: only the Owner accepts,
 * and acceptance names one green Attempt. `fresh_eyes_written` is v0.0.2
 * (ticket 03): one advisory line between a green `gate_finished` and its
 * `report_written` — evidence for the Owner, never a second Verdict.
 * The choke events (`permit_allowed` / `permit_denied` / `git_blocked`,
 * v0.0.4) are task-scoped but NOT attempt-scoped: a permit ask belongs to
 * the work before any Claim, and a git block to any moment — so they carry
 * no `attempt`, and `git_blocked` may carry no `task` at all (the shim
 * refuses no matter who runs it; the ledger records what it can bind).
 * The spawn events (`spawn_dispatched` / `spawn_refused`, v0.0.5) are the
 * driver's arrival in the ledger: the plugin records one line per spawn
 * request — allowed or refused — before any agent exists, so they too carry
 * no `attempt` (ADR 0004's amendment: the driver never writes, the plugin
 * validates and records). `watch_written` is v0.0.6 (ticket 03): the
 * record-only Jev pass's one line — it lands beside `fresh_eyes_written`
 * on BOTH verdicts (the stuck-loop battery arm is red by construction),
 * and nothing downstream branches on it (record-only law).
 * `retro_written` is v0.0.7 (ticket 03): the first factory-level event — no
 * task, no attempt, like every Retro line — one per on-demand Retro pass,
 * written only when the pass produced its proposals file (file first, then
 * the line; a refused Retro writes no line at all).
 * `meter_written` is v0.0.8 (ticket 03): the Meter's one line per task per
 * driver run — task-scoped like the spawn lines, because usage spans the
 * whole run. The dollars it carries are live-only truth: the daemon keeps
 * usage in memory per agent and persists it nowhere, so the driver must
 * capture `lastUsage` at the task's terminal moment and submit it through
 * the spool (ADR 0004's third amendment) before the agent dies or the
 * daemon restarts — after that, the fact is gone for good.
 * v0.0.9 (ADR 0006) adds no event kinds: the two Owner acts gain field
 * stamps instead — `by` on `contract_set`, `accepted_by` on
 * `attempt_accepted` — each the submitting shell's identity ("the Ledger
 * always records who accepted"), so a delegated Owner seat's acts are
 * attributable line by line.
 * v0.0.10 opens the Lead seat (ADR 0006 §3–§4) with three kinds, all
 * task-scoped and attempt-less (the stall precedes any Claim — the choke and
 * spawn lines' own precedent) and all driver-sourced through the spool (the
 * meter precedent — the one-writer law holds): `repoke_dispatched` /
 * `repoke_refused` mirror the spawn pair (the plugin judges the Lead's one
 * spend, one line either way, the dispatch line IS the spent marker), and
 * `needs_human` is the named end for a stall that survived its re-poke
 * (ADR 0006 §4's first escalation kind). No `by:` stamp on any of the three:
 * the v0.0.9 stamps name delegated Owner acts, and the Lead's v1 loop is the
 * only writer of its kinds — the kind itself is the attribution.
 */

export type Verdict = "red" | "green";

/** The Attempt ceiling (v0.0.12, ADR 0008 §1): a Task may open at most three Attempts — fixed in code, never configuration. */
export const MAX_ATTEMPTS = 3;

/**
 * The whole event vocabulary — single source for types and validation. The
 * first eight are the attempt-scoped loop in ledger order; the choke
 * vocabulary (v0.0.4) and the spawn vocabulary (v0.0.5) follow, appended
 * after their host loops; the driver's meter line (v0.0.8) and the Lead's
 * three lines (v0.0.10) ride beside the spawn events; `retro_written`
 * (v0.0.7) closes as the one factory-level event.
 */
export const EVENT_NAMES = [
  "contract_set",
  "claim_reported",
  "gate_started",
  "gate_finished",
  "fresh_eyes_written",
  "watch_written",
  "report_written",
  "attempt_accepted",
  "permit_allowed",
  "permit_denied",
  "git_blocked",
  "spawn_dispatched",
  "spawn_refused",
  "meter_written",
  "repoke_dispatched",
  "repoke_refused",
  "respawn_dispatched",
  "respawn_refused",
  "needs_human",
  "retro_written",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** Assigned by the ledger at append time — ISO 8601 UTC (ADR 0003). */
export type Timestamp = string;

export interface ContractSet {
  seq: number;
  ts: Timestamp;
  event: "contract_set";
  task: string;
  /** The Workspace fixed by the Owner — the Gate's cwd and the artifact base. Absolute path. */
  workspace: string;
  gate: string;
  artifact: string;
  /** Path prefixes (workspace-relative) the task may touch. Omitted = unrestricted. */
  scope?: string[];
  /**
   * The commit the Workspace sat at when the Contract was set — the diff base
   * for the scope check and the fresh-eyes pass. Recorded on every Contract
   * since v0.0.2 (ticket 03 R2); pre-0.0.2 Contracts predate it.
   */
  base?: string;
  /** Marks the fresh-eyes pass ON for this task (ADR 0005 default: off). */
  freshEyes?: true;
  /**
   * Marks the watch pass ON for this task (v0.0.6; ADR 0005 symmetry — off
   * unless marked). The pass runs post-verdict on BOTH verdicts and is
   * record-only: no notification, no escalation, verdicts unchanged.
   */
  watch?: true;
  /**
   * The task's assignment in the Owner's own words (v0.0.6 description-slot
   * rider), fixed with the rest of the done-criteria before the Agent starts.
   * The driver's brief carries it — retiring the v0.0.5 TASK.md seed
   * workaround, where agents had to discover the assignment from the
   * workspace.
   */
  description?: string;
  /**
   * Who set the Contract (v0.0.9, ADR 0006): the submitting shell's stamp,
   * carried from the spool request — the delegated Owner agent's
   * `PASEO_AGENT_ID` where the daemon's env carried one, `owner` on the human
   * CLI path. Pre-0.0.9 Contracts predate the stamp.
   */
  by?: string;
}

export interface ClaimReported {
  seq: number;
  ts: Timestamp;
  event: "claim_reported";
  task: string;
  /** The Attempt this Claim opened — assigned by the factory, numbered from 1 per task. */
  attempt: number;
  /** The Agent's raw claimed sha — its exact word, resolved later by the gate station. */
  sha: string;
  /**
   * Who claimed, when the plugin knows the submitter (spool claims stamped
   * with the agent id; direct CLI claims carry no spool, so no agent).
   */
  agent?: string;
}

export interface GateStarted {
  seq: number;
  ts: Timestamp;
  event: "gate_started";
  task: string;
  attempt: number;
  cmd: string;
}

export interface GateFinished {
  seq: number;
  ts: Timestamp;
  event: "gate_finished";
  task: string;
  attempt: number;
  /** Process exit code, or null when the gate was killed (timeout / signal) or never ran. */
  exit: number | null;
  verdict: Verdict;
  note: string;
  /** The full commit the Verdict attests — present whenever the claimed sha resolved (ADR 0002). */
  sha?: string;
  /**
   * The persisted full gate output (`gate-<task>-<attempt>.log` in stateDir),
   * present whenever the gate ran — the ledger alone can find the evidence
   * (ticket 02a). The `note` stays a one-line summary.
   */
  outputPath?: string;
}

/**
 * The fresh-eyes line (ticket 03): one read-only pass by a different model
 * after a green Verdict. `outcome` is the countable noise instrument; on
 * `failed`, `finding` carries the error — deaths are visible, never swallowed.
 */
export interface FreshEyesWritten {
  seq: number;
  ts: Timestamp;
  event: "fresh_eyes_written";
  task: string;
  attempt: number;
  /** The model id actually used, from the plugin's eye config (ticket 04). */
  model: string;
  outcome: "concern" | "clear" | "failed";
  /** The eye's words, ≤ ~120 words — "what did the eye see". */
  finding: string;
  /** Pass latency, for the 0.0.2 live run's cost/noise questions. */
  durationMs: number;
}

/**
 * The watch line (v0.0.6, ticket 03; questions shrunk to four in v0.0.7
 * ticket 04 rider #1, back to five in v0.0.8 ticket 03 rider #1): one
 * record-only pass that asked the Watch questions of one Attempt — red and
 * green both. `answers` maps every question name to its yes-probability, or
 * null when the response did not answer it (a partially-answered response is
 * `outcome: "failed"` with `error` naming the missing — never a silent gap).
 * Priors are NOT here: the API has no prior field, and joining the §6 priors
 * is the operator's act at close-out. On `failed`, `error` carries the
 * reason — deaths are visible.
 */
export interface WatchWritten {
  seq: number;
  ts: Timestamp;
  event: "watch_written";
  task: string;
  attempt: number;
  /**
   * The dated snapshot the response named (e.g. `typesafe/jev-1.13-20260917`),
   * recorded verbatim — drift is visible in the ledger. When the call never
   * got a response, the pinned request model stands in.
   */
  model: string;
  outcome: "written" | "failed";
  /** Present whenever a response arrived: every question name → noul double, or null. */
  answers?: Record<string, number | null>;
  /** Present whenever a response arrived: cost is the response's own, or the ÷MTok fallback. */
  usage?: { input_tokens: number; cost: number };
  /** Pass latency. */
  durationMs: number;
  /** On failed: the reason, named (timeline unavailable, missing answers, transport, budget). */
  error?: string;
}

export interface ReportWritten {
  seq: number;
  ts: Timestamp;
  event: "report_written";
  task: string;
  attempt: number;
  path: string;
}

export interface AttemptAccepted {
  seq: number;
  ts: Timestamp;
  event: "attempt_accepted";
  task: string;
  attempt: number;
  /**
   * Who accepted (v0.0.9, ADR 0006: "the Ledger always records who accepted")
   * — the submitting shell's stamp, the same law as the Contract's `by`:
   * the delegated Owner agent's id or `owner`. Pre-0.0.9 lines predate it.
   */
  accepted_by?: string;
}

/**
 * The choke allowed a contracted agent's permit ask (v0.0.4). One line per
 * judged ask — allowed asks are the permit parade made countable; paseo
 * persists permission decisions nowhere, so this line is the only record.
 */
export interface PermitAllowed {
  seq: number;
  ts: Timestamp;
  event: "permit_allowed";
  /** The task whose live Contract bound the asking agent to the choke. */
  task: string;
  /** The asking agent's id — a daemon agent, or the spool asker's name. */
  agent: string;
  /** The tool name from the ask (e.g. `Bash`, `Write`). */
  name: string;
  /** The ask kind: "tool" | "plan" | "question" | "mode" | "other". */
  kind: string;
  /** What the ask aimed at: the exact shell line (`detail.command`), or the write/edit ask's target file path. */
  command?: string;
}

/** The choke denied a contracted agent's permit ask — one line, rule and reason named. */
export interface PermitDenied extends Omit<PermitAllowed, "event"> {
  event: "permit_denied";
  /** Which deny-list entry fired (e.g. `policy:S1-git-vocabulary`). */
  rule: string;
  /** One line saying what the rule caught. */
  reason: string;
}

/**
 * The git shim refused a dangerous argv at exec time (v0.0.4). Written by the
 * plugin from the shim's log line, deduplicated by `blockId` across plugin
 * lifetimes. `task` is present exactly when the refusal's cwd sat inside a
 * live Contract's workspace — the shim refuses regardless.
 */
export interface GitBlocked {
  seq: number;
  ts: Timestamp;
  event: "git_blocked";
  task?: string;
  /** The agent whose shell ran the refused git, when the daemon stamped one. */
  agent?: string;
  /** The refused argv, joined back into one line. */
  command: string;
  /** Which refusal-list class fired (e.g. `git:force-push`). */
  rule: string;
  reason: string;
  /** The shell's cwd at the refusal — what bound it to a task, or did not. */
  cwd: string;
  /** The shim log line's id — ingestion's exactly-once key. */
  blockId: string;
}

/**
 * The plugin let a driver's spawn request through (v0.0.5, ADR 0004
 * amendment): the task's Contract checked out against the spawn rules —
 * known, unaccepted, scoped when the invocation runs parallel, workspace
 * clear of other live Contracts — and the driver may now create the agent.
 * The agent id is deliberately absent: the plugin writes this line before
 * the agent exists (the driver's RPC create comes after the ok).
 */
export interface SpawnDispatched {
  seq: number;
  ts: Timestamp;
  event: "spawn_dispatched";
  task: string;
  /** The `provider[/model]` string the driver asked to run the task under. */
  provider: string;
  /** How many tasks the spawning invocation carried — the run's parallel width. */
  arity: number;
}

/**
 * The plugin refused a driver's spawn request — one line naming the rule
 * that fired, so a refused spawn is a recorded fact, not a CLI complaint.
 * No agent exists for this line; the driver reports it and moves on.
 */
export interface SpawnRefused {
  seq: number;
  ts: Timestamp;
  event: "spawn_refused";
  task: string;
  provider: string;
  arity: number;
  /** Which spawn validation fired (e.g. `spawn:scope-mandatory`). */
  rule: string;
  /** One line saying what the rule caught. */
  reason: string;
}

/**
 * The daemon's usage snapshot as the Meter records it — the single source
 * for the shape (events.ts is the vocabulary's home): camelCase verbatim,
 * each field present only when the lane provided it. Claude meters tokens
 * plus a cumulative USD estimate (`totalCostUsd`); copilot counts tokens at
 * most — ACP has no cost field — and its dollars are a subscription fact,
 * never a measurement. An empty object is the honest "capture ran, the lane
 * reported nothing" (the all-null `watch_written.usage` trap this verbatim
 * rule avoids: absent means absent, nothing poses as zero).
 */
export interface MeterUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

/**
 * The Meter's one line (v0.0.8, ticket 03) — the post-verdict capture of
 * what one task's run cost its lane. The driver reads the daemon's
 * `lastUsage` off its terminal poll and submits it through the spool; the
 * plugin validates and appends (ADR 0004's one-writer law, third
 * amendment). One line per task per driver run — a re-run task lands a
 * second line, and the Cost read takes the latest. A recorder, never a
 * judge: no budgets, no alerts, verdicts unchanged.
 */
export interface MeterWritten {
  seq: number;
  ts: Timestamp;
  event: "meter_written";
  task: string;
  /** The `provider[/model]` string the driver ran the task under — recorded verbatim, like `spawn_dispatched`. */
  provider: string;
  /** The daemon's own usage snapshot — see `MeterUsage`. */
  usage: MeterUsage;
  /** The metered agent's id, when the driver knows it (the report precedent). */
  agent?: string;
}

/**
 * The Lead's one act, spent (v0.0.10, ADR 0006 §3): the plugin let the
 * driver's re-poke request through — the task's Contract exists, is not
 * accepted, and no earlier `repoke_dispatched` sits in its slice. Exactly
 * one per task by this validation, structural and not hoped-for: the line
 * itself is the spent marker, and a driver crash re-reads it, never the
 * socket. Delivery truth is the timeline's message-id only; no delivery
 * event exists in v1 — the claim-or-restall outcome is the observable.
 */
export interface RepokeDispatched {
  seq: number;
  ts: Timestamp;
  event: "repoke_dispatched";
  task: string;
  /** The stalled agent the fixed re-poke text went to — the act names its target. */
  agent: string;
}

/**
 * The plugin refused a driver's re-poke request — one line naming the rule
 * that fired, mirroring `spawn_refused`: a refused re-poke is a recorded
 * fact, not a log complaint. The one the design pins is
 * `repoke:already-spent` (the one-per-task law lives plugin-side — the
 * driver cannot cheat its own authority), with `repoke:unknown-task`,
 * `repoke:accepted-task` and `repoke:invalid-request` beside it in the spawn
 * rules' own order.
 */
export interface RepokeRefused {
  seq: number;
  ts: Timestamp;
  event: "repoke_refused";
  task: string;
  /** The agent the request named as its target. */
  agent: string;
  /** Which re-poke validation fired (e.g. `repoke:already-spent`). */
  rule: string;
  /** One line saying what the rule caught. */
  reason: string;
}

/**
 * Automatic recovery after `Substrate death` (v0.0.12, ADR 0008 §3): the
 * plugin let the driver's `respawn` request through — the task was spawned,
 * is not accepted, has not reached the Attempt ceiling, and has not already
 * spent a respawn since the latest progress marker (`spawn_dispatched` or
 * `gate_finished`). Recorded before the replacement agent is created.
 */
export interface RespawnDispatched {
  seq: number;
  ts: Timestamp;
  event: "respawn_dispatched";
  task: string;
  provider: string;
  /** The dead agent whose substrate death triggered this replacement. */
  died_agent: string;
}

/**
 * The plugin refused a driver's `respawn` request — one line naming the rule
 * that fired (`respawn:already-spent`, `respawn:attempt-ceiling`,
 * `respawn:not-spawned`, `respawn:accepted-task`, `respawn:unknown-task`,
 * `respawn:invalid-task`, `respawn:invalid-request`), mirroring `spawn_refused`
 * and `repoke_refused`.
 */
export interface RespawnRefused {
  seq: number;
  ts: Timestamp;
  event: "respawn_refused";
  task: string;
  provider: string;
  died_agent: string;
  rule: string;
  reason: string;
}

/** The four ways bounded automation ends — the fixed vocabulary (v0.0.10 §3, expanded in v0.0.12 ADR 0008 §4). */
export type NeedsHumanReason = "denied-again" | "silent-after-repoke" | "attempt-ceiling" | "died-after-respawn";

/** The vocabulary as a runtime list — the single spelling every validator reads. */
export const NEEDS_HUMAN_REASONS = ["denied-again", "silent-after-repoke", "attempt-ceiling", "died-after-respawn"] as const;

/** The evidence fields a `needs_human` line keys its reason on, discriminated by reason (ADR 0008 §4). */
export type NeedsHumanEvidence =
  | { denial: number; repoke: number }
  | { attempt: number; gate: number }
  | { spawn: number; respawn: number };

function posInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * The evidence's shape rule: two positive integers matching the reason's own
 * two keys (or any of the three valid pairs when `reason` is omitted).
 */
export function needsHumanEvidenceIsValid(evidence: unknown, reason?: unknown): evidence is NeedsHumanEvidence {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return false;
  const rec = evidence as Record<string, unknown>;
  if (Object.keys(rec).length !== 2) return false;
  const isDenialRepoke = posInt(rec.denial) && posInt(rec.repoke);
  const isAttemptGate = posInt(rec.attempt) && posInt(rec.gate);
  const isSpawnRespawn = posInt(rec.spawn) && posInt(rec.respawn);
  if (reason === "denied-again" || reason === "silent-after-repoke") return isDenialRepoke;
  if (reason === "attempt-ceiling") return isAttemptGate;
  if (reason === "died-after-respawn") return isSpawnRespawn;
  if (reason !== undefined) return false;
  return isDenialRepoke || isAttemptGate || isSpawnRespawn;
}

/**
 * The Lead's named end (v0.0.10, ADR 0006 §4 — the first escalation kind):
 * the task's one re-poke is spent and the stall persisted, either by a new
 * denial after the poke (`denied-again`) or by silence since it
 * (`silent-after-repoke`). Terminal for the watch (the task ends `verdict=-`,
 * exit law unchanged); the Supervisor relays it to the Owner in words at its
 * next turn, batched at leisure — no push exists in v1. An Owner answer
 * wakes the task through the ordinary spawn path; only Acceptance closes it.
 */
export interface NeedsHuman {
  seq: number;
  ts: Timestamp;
  event: "needs_human";
  task: string;
  reason: NeedsHumanReason;
  /** The seqs the reason keys on: the denial and the spent `repoke_dispatched`. */
  evidence: NeedsHumanEvidence;
}

/**
 * The Retro's one line (v0.0.7, ticket 03) — the first factory-level event:
 * no task, no attempt, because the Retro reads the whole ledger, not any
 * task's slice of it. Mirrors `watch_written`'s shape: `model` is the pinned
 * Copilot seat (`copilot/gpt-5.4`), `outcome` is `written` (the proposals
 * file landed first, then this line — a death between leaves an orphan file
 * that never happened, a line without a file cannot occur) or `failed` (a
 * technical death — CLI error, timeout, parse failure — named in `error`,
 * no file written). `proposalsPath`/`proposalCount` ride only `written`.
 * A refused Retro (copilot unusable, same-day duplicate) writes no line at
 * all — nothing changed, so nothing is recorded.
 */
export interface RetroWritten {
  seq: number;
  ts: Timestamp;
  event: "retro_written";
  /** `copilot/<model>` — the pinned seat, like the watch's `model` field. */
  model: string;
  outcome: "written" | "failed";
  durationMs: number;
  /** On failed: the reason, named (CLI error, budget, parse failure). */
  error?: string;
  /** On written: the proposals file this line attests. */
  proposalsPath?: string;
  /** On written: how many proposals the file carries. */
  proposalCount?: number;
}

export type LedgerEvent =
  | ContractSet
  | ClaimReported
  | GateStarted
  | GateFinished
  | FreshEyesWritten
  | WatchWritten
  | ReportWritten
  | AttemptAccepted
  | PermitAllowed
  | PermitDenied
  | GitBlocked
  | SpawnDispatched
  | SpawnRefused
  | MeterWritten
  | RepokeDispatched
  | RepokeRefused
  | RespawnDispatched
  | RespawnRefused
  | NeedsHuman
  | RetroWritten;

/** What callers hand to Ledger.append — same shape, `seq` and `ts` not yet assigned. */
export type PendingEvent =
  | Omit<ContractSet, "seq" | "ts">
  | Omit<ClaimReported, "seq" | "ts">
  | Omit<GateStarted, "seq" | "ts">
  | Omit<GateFinished, "seq" | "ts">
  | Omit<FreshEyesWritten, "seq" | "ts">
  | Omit<WatchWritten, "seq" | "ts">
  | Omit<ReportWritten, "seq" | "ts">
  | Omit<AttemptAccepted, "seq" | "ts">
  | Omit<PermitAllowed, "seq" | "ts">
  | Omit<PermitDenied, "seq" | "ts">
  | Omit<GitBlocked, "seq" | "ts">
  | Omit<SpawnDispatched, "seq" | "ts">
  | Omit<SpawnRefused, "seq" | "ts">
  | Omit<MeterWritten, "seq" | "ts">
  | Omit<RepokeDispatched, "seq" | "ts">
  | Omit<RepokeRefused, "seq" | "ts">
  | Omit<RespawnDispatched, "seq" | "ts">
  | Omit<RespawnRefused, "seq" | "ts">
  | Omit<NeedsHuman, "seq" | "ts">
  | Omit<RetroWritten, "seq" | "ts">;
