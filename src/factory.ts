import { statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Ledger, usageIsValid } from "./ledger.ts";
import { MAX_ATTEMPTS, NEEDS_HUMAN_REASONS, needsHumanEvidenceIsValid } from "./events.ts";
import { runGate } from "./gate.ts";
import { renderReport } from "./report.ts";
import { laneCliAvailable } from "./lanes.ts";
import { EYE_JSON_LANE } from "./lanes.ts";
import type { LaneCliRunner } from "./lanes.ts";
import { loadEyeConfig, resolveEyeLane, runFreshEyesPass } from "./fresh-eyes.ts";
import { runWatchPass, watchLaneAvailable } from "./watch.ts";
import type { CopilotRunner, TimelineFetcher } from "./watch.ts";
import { buildRetroDigest, retroDay, retroLaneAvailable, runRetroPass, writtenRetroForDay } from "./retro.ts";
import type { RetroOutcome } from "./retro.ts";
import { changedFiles, checkCleanAt, headCommitSync, landTaskWorktree, resolveClaimedCommit, scopeCoversFile } from "./workspace.ts";
import { MEMORY_FILES } from "./choke.ts";
import { projectStateDir } from "./project.ts";
import { FactoryError } from "./errors.ts";
import type { AttemptAccepted, ContractSet, FreshEyesWritten, GateFinished, GitBlocked, LedgerEvent, MeterWritten, MeterUsage, NeedsHuman, NeedsHumanEvidence, NeedsHumanReason, RepokeDispatched, RepokeRefused, RespawnDispatched, RespawnRefused, SpawnDispatched, SpawnRefused, Verdict } from "./events.ts";
import type { GateResult } from "./gate.ts";

/** Task ids become report filenames, so they stay flat and filename-safe. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface FactoryOptions {
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
  /** Retro total budget override (ms), both tries together (tests). Defaults to RETRO_TOTAL_BUDGET_MS. */
  retroBudgetMs?: number;
  /** Retro lane availability probe override (tests) — the pass refuses before any ask when false. */
  retroCopilotProbe?: (lane: string) => boolean;
  /** Retro lane CLI runner override (tests) — the lane and its tool-less flags stay fixed regardless. */
  retroCopilotRunner?: CopilotRunner;
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
  gate: string;
  artifact: string;
  /**
   * Path prefixes (workspace-relative) the task may touch — the mechanical
   * task boundary (ticket 14). Omitted or empty = unrestricted, v0.0.1
   * behavior. A diff outside the scope is a red Verdict naming the files.
   */
  scope?: string[];
  /**
   * Marks the fresh-eyes pass ON for this task (ADR 0005: off unless marked).
   * The eye's model and key are plugin-level config (`<stateDir>/eye.json`),
   * never Contract fields.
   */
  freshEyes?: true;
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
}

export interface ClaimInput {
  task: string;
  sha: string;
  /** Who claimed, when the caller knows it — recorded on `claim_reported` (ticket 02b). */
  agent?: string;
}

export interface ClaimOutcome {
  /** The Attempt this Claim opened — attempts are numbered per task from 1. */
  attempt: number;
  verdict: Verdict;
  gate: GateFinished;
  reportPath: string;
}

export interface AcceptInput {
  task: string;
  attempt: number;
  /**
   * Who accepted (v0.0.9) — the spool's submitting-shell stamp, recorded
   * verbatim ("the Ledger always records who accepted", ADR 0006). The three
   * seat names carry authority semantics (v0.0.14, ADR 0010 §3): `owner` and
   * `supervisor` are the unconditional override (the Supervisor acts on the
   * Owner's word), `lead` is the intermediate acceptance — permitted only on
   * a green Verdict with no fresh-eyes CONCERN on the attempt and no
   * undisplaced `needs_human`, else `lead-accept-refused`. Any other string
   * (a delegated agent's id, the v0.0.9 spelling) records verbatim with no
   * seat privileges.
   */
  accepted_by?: string;
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
  readonly ledger: Ledger;
  readonly stateDir: string;
  /** Attempts the factory closed red while opening (ADR 0003 recovery) — for the shell to log loudly. */
  readonly recoveredAttempts: readonly { task: string; attempt: number }[];
  /** Registers a task's done-criteria. One contract per task — the ledger is append-only. */
  setContract(input: ContractInput): ContractSet;
  /**
   * Records the Agent's Claim, verifies it against the Workspace, runs the gate
   * on it, writes the report. Per ADR 0002 the Verdict attests the claimed
   * commit: the sha is resolved, and the tree must sit clean with HEAD at that
   * commit both before and after the gate. Anything else is red, never a
   * fallback to whatever is on disk. Each Call opens the task's next Attempt;
   * a Claim while the previous Attempt is still open is rejected (ADR 0003).
   */
  claim(input: ClaimInput): Promise<ClaimOutcome>;
  /**
   * The Owner accepts one green Attempt (ADR 0002). Green is necessary, not
   * sufficient — this is the only acceptance act in the factory, and it is
   * never the Agent's. Since v0.0.9 the delegated Owner seat (the
   * Supervisor, ADR 0006) may submit it on the Owner's word; the
   * `accepted_by` stamp records whose act each line is. Since v0.0.14
   * (ADR 0010 §3–§4) `accepted_by: "lead"` is the intermediate acceptance
   * (green + no fresh-eyes CONCERN on the attempt + not in needs_human,
   * else `lead-accept-refused`), and a task that ran in a managed Task
   * worktree lands its claimedCommit into `<project-root>`'s local branch
   * before the line records — async git is why the call awaits.
   */
  accept(input: AcceptInput): Promise<AttemptAccepted>;
  /**
   * Judges a driver's spawn request (v0.0.5): the task must be known,
   * unaccepted, scoped when the invocation runs parallel (arity ≥ 2), and its
   * workspace clear of every other live Contract's tree. One ledger line
   * either way — `spawn_dispatched` or `spawn_refused` — so the record exists
   * before any agent does. Never throws; the refusal rides the return value
   * (and the spool reply), not an exception.
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
   * the spend, never the trigger.
   */
  repoke(task: string, agent: string): RepokeDecision;
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
   * contract set and no accepted Attempt yet. When several live Contracts
   * cover the same tree, the latest in ledger order wins. Since v0.0.14 a
   * cwd inside the task's recorded Task worktree binds too — the worktree
   * sits outside the workspace (under `<stateDir>/projects/`), so the spawn
   * line's `worktree` field is what ties the tree to its Contract.
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
   * it. Undefined when no spawn recorded one (the legacy shared-checkout
   * path, pre-0.0.14 lines).
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
   * Runs the Retro (v0.0.7): builds the whole-ledger digest, prompts the
   * pinned Copilot model, writes `retro-<date>.md`, appends one
   * factory-level `retro_written` line (ADR 0004 one-writer law — the CLI
   * only asked through the spool). Whole-ledger always; no arguments exist
   * to pass. Refused retros (copilot CLI unusable, a same-day successful
   * Retro already on the ledger) throw and write NO line — nothing changed,
   * so nothing is recorded. Technical failures never throw: the pass's own
   * `failed` outcome lands as a visible ledger line with its error, no file.
   */
  retro(): Promise<RetroOutcome>;
}

export function createFactory(options: FactoryOptions): Factory {
  const { stateDir } = options;
  // The data tree: project-scoped factories keep their ledger, reports, gate
  // logs, and retro files under <stateDir>/projects/<slug>/ (v0.0.14, ADR
  // 0010 §5); machine-level config (lanes.json, eye.json) stays at the root
  // for every factory, and the root data tree remains the no-scope default
  // (the legacy single-ledger layout).
  const dataDir = options.projectSlug === undefined ? stateDir : projectStateDir(stateDir, options.projectSlug);
  const ledger = Ledger.open(join(dataDir, "ledger.jsonl"));
  const recoveredAttempts = recoverInterruptedAttempts(ledger, dataDir);

  return {
    ledger,
    stateDir,
    recoveredAttempts,

    setContract({ task, workspace, gate, artifact, scope, freshEyes, watch, description, skills, by }) {
      assertTaskId(task);
      if (gate.trim() === "") throw new FactoryError("invalid-contract", "gate command must be a non-empty string");
      if (artifact.trim() === "") throw new FactoryError("invalid-contract", "artifact path must be a non-empty string");
      if (freshEyes !== undefined && freshEyes !== true) {
        throw new FactoryError("invalid-contract", "freshEyes marks the pass ON — omit it, or set it to exactly true");
      }
      if (watch !== undefined && watch !== true) {
        throw new FactoryError("invalid-contract", "watch marks the pass ON — omit it, or set it to exactly true");
      }
      if (description !== undefined && (typeof description !== "string" || description.trim() === "")) {
        throw new FactoryError("invalid-contract", "description must be a non-empty string — omit it when the task has no assignment text");
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
      // The base commit is recorded on every Contract since v0.0.2 (ticket 03
      // R2): it is the diff range for the scope check and the fresh-eyes pass.
      const base = headCommitSync(workspace);
      if (base === undefined) {
        throw new FactoryError(
          "invalid-contract",
          "the workspace must be a git workspace with a resolvable HEAD — the Contract's base commit is the diff base for the scope check and the fresh-eyes pass",
        );
      }
      // Fresh-eyes fails fast here: marking a Contract without a usable eye
      // must error before any Agent work starts, not 60s into a green claim
      // (ticket 04 §3). Since v0.0.13 the eye runs a lane: "eye.json" keeps
      // its own config check, a CLI lane probes its command (the watch's law).
      if (freshEyes === true) {
        const lane = resolveEyeLane(stateDir);
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
      }
      if (watch === true) {
        const usable = watchLaneAvailable(stateDir, options.watchCopilotProbe);
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
      const conflict = liveWorkspaceConflict(ledger, workspace, task, scope);
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
        gate,
        artifact,
        ...(scope === undefined || scope.length === 0 ? {} : { scope }),
        base,
        ...(freshEyes === undefined ? {} : { freshEyes }),
        ...(watch === undefined ? {} : { watch }),
        ...(description === undefined ? {} : { description }),
        ...(skills === undefined || skills.length === 0 ? {} : { skills }),
        ...(by === undefined ? {} : { by }),
      });
    },

    async claim({ task, sha, agent }) {
      assertTaskId(task);
      const contract = this.contractFor(task);
      if (!contract) throw new FactoryError("unknown-task", `no contract set for task ${task} — register one first`);
      const fullHistory = ledger.eventsFor(task);
      const history = epochEventsFor(ledger, task);

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

      // ADR 0003: Attempts never overlap. The previous one must have reached
      // its report before a new Claim opens the next Attempt.
      const lastAttempt = maxAttempt(history);
      if (lastAttempt > 0 && attemptIsOpen(history, lastAttempt)) {
        throw new FactoryError(
          "gate-running",
          `attempt ${lastAttempt} of task ${task} is still open — wait for its verdict before claiming again`,
        );
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
      };

      // The execution tree (v0.0.14, ADR 0010 §4): a task spawned with a
      // managed Task worktree claims, gates, and diffs THERE — the Contract's
      // workspace stays <project-root>, the recorded home of the work and the
      // landing target; the worktree is the driver-level execution detail the
      // spawn line carries. Legacy spawns (no worktree on the line) execute
      // at the contract workspace, v0.0.5's law.
      const executionDir = this.worktreeFor(task) ?? contract.workspace;

      ledger.append({
        event: "claim_reported",
        task,
        attempt,
        sha,
        ...(agent === undefined || agent.trim() === "" ? {} : { agent }),
      });
      ledger.append({ event: "gate_started", task, attempt, cmd: contract.gate });

      // Station 1 — the claimed commit must exist as one full object. An empty,
      // unknown or ambiguous sha is a red Verdict (ADR 0002), and the gate
      // command never runs on an unverified tree.
      const resolved = await resolveClaimedCommit(executionDir, sha);
      if (!resolved.ok) {
        return finish(finishCtx, attempt, { exit: null, verdict: "red", note: resolved.reason, timedOut: false }, undefined, watchContext());
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
          artifact: contract.artifact,
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
          const outside = diff.files.filter((file) => !scopeCoversFile(contract.scope!, file));
          if (outside.length > 0) {
            scopeViolations = outside;
            return finish(
              finishCtx,
              attempt,
              {
                exit: result.exit,
                verdict: "red",
                note: `changes outside declared scope: ${outside.join(", ")}`,
                timedOut: false,
              },
              resolved.full,
              watchContext(),
            );
          }
          scopeViolations = [];
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

    async accept({ task, attempt, accepted_by }) {
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
      const events = attemptEvents(history, attempt);
      if (events.length === 0) {
        throw new FactoryError("unknown-attempt", `task ${task} has no attempt ${attempt}`);
      }
      const priorAccept = acceptedAttempt(fullHistory);
      if (priorAccept !== undefined) {
        throw new FactoryError(
          "already-accepted",
          `task ${task} was already accepted at attempt ${priorAccept.attempt}; the ledger is append-only`,
        );
      }
      const gate = events.findLast((e): e is GateFinished => e.event === "gate_finished");
      if (!gate || gate.verdict !== "green") {
        throw new FactoryError(
          "not-green",
          `attempt ${attempt} of task ${task} has no green verdict — the Owner accepts evidence, and there is none`,
        );
      }
      // The Lead's intermediate acceptance (v0.0.14, ADR 0010 §3): green is
      // necessary (checked above) and sufficient for the override seats, but
      // the Lead additionally needs a CONCERN-free attempt and a task that is
      // not escalated — flagged or exhausted work is the Owner's to answer,
      // never the Lead's self-acceptance.
      if (accepted_by === "lead") {
        const concern = events.findLast(
          (e): e is FreshEyesWritten => e.event === "fresh_eyes_written" && e.attempt === attempt && e.outcome === "concern",
        );
        if (concern !== undefined) {
          throw new FactoryError(
            "lead-accept-refused",
            `attempt ${attempt} of task ${task} carries a fresh-eyes CONCERN — a flagged attempt needs the Owner's or Supervisor's override, never the Lead's acceptance`,
          );
        }
        if (taskInNeedsHuman(history)) {
          throw new FactoryError(
            "lead-accept-refused",
            `task ${task} is in needs_human — an escalated task is the Owner's to answer; the Lead may spawn a corrective attempt or escalate, never self-accept`,
          );
        }
      }
      // Local landing (v0.0.14, ADR 0010 §4): a task that ran in a managed
      // Task worktree integrates its claimedCommit into <project-root>'s
      // local branch BEFORE the acceptance line records — the line carries
      // the outcome (`landed`, or `pending-conflict` with the reason and the
      // preserved factory/<task> branch). Legacy shared-checkout tasks skip
      // the step and record exactly as before. Never a git push.
      const worktree = this.worktreeFor(task);
      let landing: "landed" | "pending-conflict" | undefined;
      let landingNote: string | undefined;
      if (worktree !== undefined && gate.sha !== undefined) {
        const result = await landTaskWorktree({
          projectRoot: contract.workspace,
          worktree,
          claimedCommit: gate.sha,
          ...(contract.base === undefined ? {} : { base: contract.base }),
          branch: `factory/${task}`,
        });
        landing = result.landing;
        landingNote = result.note;
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

    requestSpawn({ task, provider, arity, worktree }) {
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
      const history = epochEventsFor(ledger, task);
      if (maxAttempt(history) >= MAX_ATTEMPTS && !history.some((e) => e.event === "gate_finished" && e.verdict === "green")) {
        return refuse(
          "attempt-ceiling",
          "spawn:attempt-ceiling",
          `task ${task} reached the attempt ceiling (${MAX_ATTEMPTS} red attempts) — no further Attempt may open`,
        );
      }
      if (arity >= 2 && (contract.scope === undefined || contract.scope.length === 0)) {
        return refuse(
          "spawn-scope-mandatory",
          "spawn:scope-mandatory",
          `task ${task} has no scope — contracts must be scoped to run in parallel (this invocation carries ${arity} tasks)`,
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
      return { outcome: "dispatched", event: ledger.append({ ...base, event: "spawn_dispatched" }) };
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

    repoke(task, agent) {
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
      const history = epochEventsFor(ledger, task);
      // The structural one-per-task law: the dispatch line IS the spent
      // marker — a second ask names its own refusal, and a driver crash
      // re-reads this slice rather than trusting any socket.
      if (history.some((e) => e.event === "repoke_dispatched")) {
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
      // Only each unaccepted task's latest contract_set (and any spawn_dispatched
      // in that current epoch) is live.
      const latestContracts = new Map<string, ContractSet>();
      for (const evt of ledger.events) {
        if (evt.event === "contract_set" && !accepted.has(evt.task)) {
          latestContracts.set(evt.task, evt);
        }
      }
      const worktrees = new Map<string, string>();
      for (const evt of ledger.events) {
        if (evt.event === "spawn_dispatched" && typeof evt.worktree === "string" && evt.worktree !== "") {
          const contract = latestContracts.get(evt.task);
          if (contract !== undefined && evt.seq >= contract.seq) {
            worktrees.set(evt.task, evt.worktree);
          }
        }
      }
      let match: ContractSet | undefined;
      for (const evt of latestContracts.values()) {
        if (covers(evt, cwd)) match = evt;
        const worktree = worktrees.get(evt.task);
        if (worktree !== undefined && (cwd === worktree || cwd.startsWith(`${worktree}/`))) match = evt;
      }
      return match;
    },

    contractFor(task) {
      return ledger.eventsFor(task).findLast((e): e is ContractSet => e.event === "contract_set");
    },

    worktreeFor(task) {
      for (const evt of epochEventsFor(ledger, task).reverse()) {
        if (evt.event === "spawn_dispatched" && typeof evt.worktree === "string" && evt.worktree !== "") return evt.worktree;
      }
      return undefined;
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

    async retro() {
      // Refusal 1 — the pass probes availability itself (ticket 03 item 5:
      // `contract_set`'s pre-flight is untouched; the Retro refuses per
      // item 3, workspace-conflict style: no ledger line). Since v0.0.13 the
      // probe is lane-shaped (ADR 0009 §3).
      const usable = retroLaneAvailable(stateDir, options.retroCopilotProbe);
      if (!usable.ok) {
        throw new FactoryError(
          "retro-copilot-unusable",
          `the retro needs its lane usable — ${usable.reason}`,
        );
      }
      // Refusal 2 — one successful Retro per UTC day (the ledger's ts day,
      // the file's day, the same day): a refused second run points at
      // today's file and records nothing.
      const today = retroDay(new Date());
      const prior = writtenRetroForDay(ledger.events, today);
      if (prior !== undefined) {
        throw new FactoryError(
          "retro-same-day",
          `a retro already ran today — its ${prior.proposalCount ?? 0} proposals sit in ${prior.proposalsPath}; a failed retro leaves no line, so only a failed one may be re-run today`,
        );
      }
      // The digest reads the gate logs by basename against the DATA dir
      // (v0.0.14: project factories keep them under projects/<slug>/); the
      // pass writes its proposals file there too, while the lane stays
      // machine config (root lanes.json).
      const corpus = buildRetroDigest(ledger.events, dataDir);
      const outcome = await runRetroPass({
        stateDir,
        ...(options.projectSlug === undefined ? {} : { dataDir }),
        corpus,
        ...(options.retroBudgetMs === undefined ? {} : { budgetMs: options.retroBudgetMs }),
        ...(options.retroCopilotRunner === undefined ? {} : { copilotRunner: options.retroCopilotRunner }),
      });
      // The pass wrote the file before returning a `written` outcome; the
      // line lands after it, by construction (ticket 03 item 3).
      ledger.append({
        event: "retro_written",
        model: outcome.model,
        outcome: outcome.outcome,
        durationMs: outcome.durationMs,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.proposalsPath === undefined ? {} : { proposalsPath: outcome.proposalsPath }),
        ...(outcome.proposalCount === undefined ? {} : { proposalCount: outcome.proposalCount }),
      });
      return outcome;
    },
  };
}

/**
 * The seq of the latest `contract_set` event for `task`, or 0 when none exists.
 * Every per-task fold and ceiling check scopes to the current Contract epoch
 * (`seq >= latestContractSeq(ledger, task)`).
 */
export function latestContractSeq(ledger: Ledger, task: string): number {
  const latest = ledger.eventsFor(task).findLast((e): e is ContractSet => e.event === "contract_set");
  return latest?.seq ?? 0;
}

/** All ledger events for `task` in its current Contract epoch (`seq >= latestContractSeq`). */
function epochEventsFor(ledger: Ledger, task: string): LedgerEvent[] {
  const minSeq = latestContractSeq(ledger, task);
  return ledger.eventsFor(task).filter((e) => e.seq >= minSeq);
}

/**
 * Returns the attempt number of an in-flight Attempt in the given epoch history
 * (a `claim_reported` or `gate_started` with no matching `gate_finished`), or
 * `undefined` if no Attempt is currently running.
 */
function inFlightAttempt(history: readonly LedgerEvent[]): number | undefined {
  for (const evt of history) {
    if (evt.event === "claim_reported" || evt.event === "gate_started") {
      const finished = history.some((e) => e.event === "gate_finished" && e.attempt === evt.attempt);
      if (!finished) return evt.attempt;
    }
  }
  return undefined;
}

/** A Contract covers a cwd when the cwd is the workspace or sits inside it. */
function covers(contract: ContractSet, cwd: string): boolean {
  return cwd === contract.workspace || cwd.startsWith(`${contract.workspace}/`);
}

/** The task's acceptance, when the Owner has accepted — the closed-marker every closer reads. */
function acceptedAttempt(history: readonly LedgerEvent[]): AttemptAccepted | undefined {
  return history.findLast((e): e is AttemptAccepted => e.event === "attempt_accepted");
}

/**
 * Whether the task currently stands in `needs_human` (the lead-acceptance
 * rule's escalation check, v0.0.14): the latest `needs_human` line wins while
 * no later `gate_finished` displaces it — the view's own status fold rule. An
 * Owner answer that wakes the task (a new spawn and a fresh Attempt's green
 * gate) displaces the marker, and the Lead may accept THAT attempt.
 */
function taskInNeedsHuman(history: readonly LedgerEvent[]): boolean {
  let needs: NeedsHuman | undefined;
  let lastGateSeq = -1;
  for (const evt of history) {
    if (evt.event === "needs_human") needs = evt;
    else if (evt.event === "gate_finished" && evt.seq > lastGateSeq) lastGateSeq = evt.seq;
  }
  return needs !== undefined && needs.seq > lastGateSeq;
}

/** Every task with an accepted Attempt — acceptance retires a Contract (live = set and unaccepted). */
function acceptedTasks(ledger: Ledger): Set<string> {
  const accepted = new Set<string>();
  for (const evt of ledger.events) {
    if (evt.event === "attempt_accepted") accepted.add(evt.task);
  }
  return accepted;
}

/** How one workspace relates to another — the workspace-conflict key (v0.0.5). */
type WorkspaceRelation = "equal" | "inside" | "contains";

/** One line of English for a relation — the error and the refusal share it. */
function relationText(relation: WorkspaceRelation): string {
  if (relation === "equal") return "is the same tree as";
  if (relation === "inside") return "sits inside";
  return "contains";
}

/**
 * The live-Contract workspace scan (H1/H2 guard): finds the first live
 * Contract — set, not accepted, another task — whose workspace equals, nests
 * inside, or contains `workspace`. Comparison is on the paths as contracted
 * (absolute, `resolve`d by the CLI); trailing slashes are tolerated, symlink
 * aliasing is not — the Owner contracts one spelling of a tree per run.
 * Since v0.0.14 (ADR 0010 §4) the EQUAL relation is exempt when both
 * Contracts declare disjoint scopes (`myScope` is the asking task's scope —
 * the contract's own on the spawn path, the input's on the setContract path
 * where the line has not landed yet): same-Project Tasks each execute in
 * their own managed worktree, so the single-checkout collision cannot
 * happen, and the scopes are the declared boundary. On an overlapping equal
 * pair the returned conflict names the overlapping prefixes.
 */
function liveWorkspaceConflict(
  ledger: Ledger,
  workspace: string,
  task: string,
  myScope?: string[],
): { task: string; workspace: string; relation: WorkspaceRelation; overlapping?: string } | undefined {
  const mine = normalized(workspace);
  const accepted = acceptedTasks(ledger);
  const latestContracts = new Map<string, ContractSet>();
  for (const evt of ledger.events) {
    if (evt.event === "contract_set" && evt.task !== task && !accepted.has(evt.task)) {
      latestContracts.set(evt.task, evt);
    }
  }
  for (const evt of latestContracts.values()) {
    const theirs = normalized(evt.workspace);
    let relation: WorkspaceRelation | undefined;
    if (mine === theirs) relation = "equal";
    else if (mine.startsWith(`${theirs}/`)) relation = "inside";
    else if (theirs.startsWith(`${mine}/`)) relation = "contains";
    if (relation === undefined) continue;
    if (relation === "equal") {
      const overlap = scopesOverlap(myScope, evt.scope);
      if (overlap === undefined) continue; // the worktree exemption — disjoint scopes, one Project
      return { task: evt.task, workspace: evt.workspace, relation, overlapping: overlap };
    }
    return { task: evt.task, workspace: evt.workspace, relation };
  }
  return undefined;
}

/**
 * The first pair of scope prefixes that overlap (either covers the other's
 * territory), or undefined when the scopes are disjoint — the exemption's
 * one question. Unrestricted (empty/undefined) scope means "everywhere", so
 * it overlaps everything and never rides the exemption.
 */
function scopesOverlap(a: readonly string[] | undefined, b: readonly string[] | undefined): string | undefined {
  if (a === undefined || a.length === 0 || b === undefined || b.length === 0) return "one contract is unscoped";
  for (const mine of a) {
    for (const theirs of b) {
      if (scopeCoversFile([mine], theirs) || scopeCoversFile([theirs], mine)) return `${mine} ↔ ${theirs}`;
    }
  }
  return undefined;
}

/** Workspace paths as contracted, with a tolerated trailing slash gone. */
function normalized(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
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
    outputPath = join(dataDir, `gate-${task}-${attempt}.log`);
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
  return { attempt, verdict: result.verdict, gate, reportPath };
}

/** Every Attempt ends the same way: report rendered from the ledger, written, acknowledged. */
function writeAttemptReport(task: string, attempt: number, ledger: Ledger, dataDir: string): string {
  const markdown = renderReport(task, attempt, epochEventsFor(ledger, task));
  const reportPath = join(dataDir, `report-${task}-${attempt}.md`);
  writeFileSync(reportPath, markdown);
  ledger.append({ event: "report_written", task, attempt, path: reportPath });
  return reportPath;
}

/** The highest Attempt number a task's history mentions, or 0 when none opened yet. */
function maxAttempt(history: readonly LedgerEvent[]): number {
  let max = 0;
  for (const evt of history) {
    if ("attempt" in evt && evt.attempt > max) max = evt.attempt;
  }
  return max;
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
  const events = attemptEvents(history, attempt);
  return events.length > 0 && !events.some((e) => e.event === "report_written");
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
