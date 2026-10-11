import { statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Ledger, usageIsValid } from "./ledger.ts";
import { runGate } from "./gate.ts";
import { renderReport } from "./report.ts";
import { loadEyeConfig, runFreshEyesPass } from "./fresh-eyes.ts";
import { copilotAvailable, runWatchPass } from "./watch.ts";
import type { CopilotRunner, TimelineFetcher } from "./watch.ts";
import { buildRetroDigest, retroDay, runRetroPass, writtenRetroForDay } from "./retro.ts";
import type { RetroOutcome } from "./retro.ts";
import { changesOutsideScope, checkCleanAt, headCommitSync, resolveClaimedCommit } from "./workspace.ts";
import { FactoryError } from "./errors.ts";
import type { AttemptAccepted, ContractSet, GateFinished, GitBlocked, LedgerEvent, MeterWritten, MeterUsage, SpawnDispatched, SpawnRefused, Verdict } from "./events.ts";
import type { GateResult } from "./gate.ts";

/** Task ids become report filenames, so they stay flat and filename-safe. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface FactoryOptions {
  /** Directory for `ledger.jsonl`, `report-<task>-<n>.md` and `gate-<task>-<n>.log` files. */
  stateDir: string;
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
  /** Copilot CLI availability probe override (tests) — the watch's whole config surface (amendment 2). */
  watchCopilotProbe?: () => boolean;
  /** Copilot CLI runner override (tests) — the model and flags stay pinned regardless. */
  watchCopilotRunner?: CopilotRunner;
  /** Retro total budget override (ms), both tries together (tests). Defaults to RETRO_TOTAL_BUDGET_MS. */
  retroBudgetMs?: number;
  /** Retro's copilot availability probe override (tests) — the pass refuses before any ask when false. */
  retroCopilotProbe?: () => boolean;
  /** Retro's copilot CLI runner override (tests) — the model and flags stay pinned regardless. */
  retroCopilotRunner?: CopilotRunner;
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
   * verbatim ("the Ledger always records who accepted", ADR 0006).
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
   * `accepted_by` stamp records whose act each line is.
   */
  accept(input: AcceptInput): AttemptAccepted;
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
   * The live Contract whose workspace contains `cwd`, if any — the choke's
   * mechanical "contracted agent" test (v0.0.4 map decision 5: asks from
   * agents without a live Contract are not the factory's business). Live =
   * contract set and no accepted Attempt yet. When several live Contracts
   * cover the same tree, the latest in ledger order wins.
   */
  liveContractFor(cwd: string): ContractSet | undefined;
  /**
   * The task's Contract — the one lookup every asker of a task's history
   * needs (a Claim verifying its gate, a synthetic ask binding its cwd).
   * Undefined when no Contract was ever set for the task.
   */
  contractFor(task: string): ContractSet | undefined;
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
  const ledger = Ledger.open(join(stateDir, "ledger.jsonl"));
  const recoveredAttempts = recoverInterruptedAttempts(ledger, stateDir);

  return {
    ledger,
    stateDir,
    recoveredAttempts,

    setContract({ task, workspace, gate, artifact, scope, freshEyes, watch, description, by }) {
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
      // (ticket 04 §3). The watch follows the same law (v0.0.6).
      if (freshEyes === true) {
        const eye = loadEyeConfig(stateDir);
        if (!eye.ok) {
          throw new FactoryError("eye-unconfigured", `fresh-eyes is on, but the eye is not usable: ${eye.reason}`);
        }
      }
      if (watch === true) {
        const usable = options.watchCopilotProbe === undefined ? copilotAvailable() : options.watchCopilotProbe();
        if (!usable) {
          throw new FactoryError(
            "watch-unconfigured",
            "the watch is on, but the copilot CLI is not usable on PATH — install and auth it for the daemon user (the CLI carries the watch's auth; there is no key file)",
          );
        }
      }
      const existing = ledger.eventsFor(task).some((e) => e.event === "contract_set");
      if (existing) {
        throw new FactoryError(
          "contract-exists",
          `contract already set for task ${task}; the ledger is append-only — use a new task id`,
        );
      }
      // The one concurrency guard the audit demanded (H1/H2, v0.0.5 ticket 02):
      // two live Contracts may never share a workspace tree — equals, nests, or
      // contains. Without this, two gates race in one cwd and permit asks
      // misattribute to the latest covering Contract. It is also the Owner-CLI
      // arm of the driver's spawn-time workspace refusal (ticket 03 §7).
      const conflict = liveWorkspaceConflict(ledger, workspace, task);
      if (conflict !== undefined) {
        throw new FactoryError(
          "workspace-conflict",
          `workspace "${workspace}" ${relationText(conflict.relation)} the live contract of task ${conflict.task} (${conflict.workspace}) — accept or retire that task before contracting this tree`,
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
        ...(by === undefined ? {} : { by }),
      });
    },

    async claim({ task, sha, agent }) {
      assertTaskId(task);
      const contract = this.contractFor(task);
      if (!contract) throw new FactoryError("unknown-task", `no contract set for task ${task} — register one first`);
      const history = ledger.eventsFor(task);

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
      const priorAccept = acceptedAttempt(history);
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
      const attempt = lastAttempt + 1;

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
      const resolved = await resolveClaimedCommit(contract.workspace, sha);
      if (!resolved.ok) {
        return finish(task, attempt, ledger, stateDir, contract, { exit: null, verdict: "red", note: resolved.reason, timedOut: false }, undefined, undefined, watchContext());
      }

      // Station 2 — clean tree, HEAD at the claimed commit, before the gate.
      const before = await checkCleanAt(contract.workspace, resolved.full);
      if (!before.ok) {
        return finish(
          task,
          attempt,
          ledger,
          stateDir,
          contract,
          {
            exit: null,
            verdict: "red",
            note: `workspace not clean at the claimed commit before the gate: ${before.reason}`,
            timedOut: false,
          },
          resolved.full,
          undefined,
          watchContext(),
        );
      }

      let result: GateResult;
      try {
        result = await runGate({
          cmd: contract.gate,
          cwd: contract.workspace,
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
      const after = await checkCleanAt(contract.workspace, resolved.full);
      if (!after.ok) {
        return finish(
          task,
          attempt,
          ledger,
          stateDir,
          contract,
          {
            exit: result.exit,
            verdict: "red",
            note: `workspace moved during the gate: ${after.reason}`,
            timedOut: false,
          },
          resolved.full,
          undefined,
          watchContext(),
        );
      }

      // Station 4 — the mechanical task boundary (ticket 14): every file the
      // diff touches must fall inside a declared scope prefix. A task that
      // overreaches is refused here, never prompted back to polite behavior.
      if (contract.scope !== undefined && contract.scope.length > 0) {
        if (contract.base === undefined) {
          return finish(
            task,
            attempt,
            ledger,
            stateDir,
            contract,
            { exit: result.exit, verdict: "red", note: "scoped contract has no recorded base commit", timedOut: false },
            resolved.full,
            undefined,
            watchContext(),
          );
        }
        const scopeCheck = await changesOutsideScope(contract.workspace, contract.base, resolved.full, contract.scope);
        if (!scopeCheck.ok) {
          // A failed diff leaves the station with no measurement — undefined,
          // never an empty list posing as "clean".
          scopeViolations = scopeCheck.reason !== undefined ? undefined : scopeCheck.files;
          return finish(
            task,
            attempt,
            ledger,
            stateDir,
            contract,
            {
              exit: result.exit,
              verdict: "red",
              note:
                scopeCheck.reason !== undefined
                  ? `scope check failed: ${scopeCheck.reason}`
                  : `changes outside declared scope: ${scopeCheck.files.join(", ")}`,
              timedOut: false,
            },
            resolved.full,
            undefined,
            watchContext(),
          );
        }
        scopeViolations = [];
      }

      return finish(task, attempt, ledger, stateDir, contract, result, resolved.full, options.eyeBudgetMs, watchContext());
    },

    accept({ task, attempt, accepted_by }) {
      assertTaskId(task);
      if (!Number.isInteger(attempt) || attempt < 1) {
        throw new FactoryError("invalid-attempt", `attempt must be a positive integer, got ${attempt}`);
      }
      const history = ledger.eventsFor(task);
      if (!history.some((e) => e.event === "contract_set")) {
        throw new FactoryError("unknown-task", `no contract set for task ${task} — register one first`);
      }
      const events = attemptEvents(history, attempt);
      if (events.length === 0) {
        throw new FactoryError("unknown-attempt", `task ${task} has no attempt ${attempt}`);
      }
      const priorAccept = acceptedAttempt(history);
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
      return ledger.append({ event: "attempt_accepted", task, attempt, ...(accepted_by === undefined ? {} : { accepted_by }) });
    },

    requestSpawn({ task, provider, arity }) {
      const base = { task, provider, arity };
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
      const history = ledger.eventsFor(task);
      const priorAccept = acceptedAttempt(history);
      if (priorAccept !== undefined) {
        return refuse(
          "already-accepted",
          "spawn:accepted-task",
          `task ${task} was already accepted at attempt ${priorAccept.attempt} — the task is closed`,
        );
      }
      if (arity >= 2 && (contract.scope === undefined || contract.scope.length === 0)) {
        return refuse(
          "spawn-scope-mandatory",
          "spawn:scope-mandatory",
          `task ${task} has no scope — contracts must be scoped to run in parallel (this invocation carries ${arity} tasks)`,
        );
      }
      const conflict = liveWorkspaceConflict(ledger, contract.workspace, task);
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

    liveContractFor(cwd) {
      const accepted = acceptedTasks(ledger);
      let match: ContractSet | undefined;
      for (const evt of ledger.events) {
        if (evt.event === "contract_set" && !accepted.has(evt.task) && covers(evt, cwd)) match = evt;
      }
      return match;
    },

    contractFor(task) {
      return ledger.eventsFor(task).findLast((e): e is ContractSet => e.event === "contract_set");
    },

    async retro() {
      // Refusal 1 — the pass probes availability itself (ticket 03 item 5:
      // `contract_set`'s pre-flight is untouched; the Retro refuses per
      // item 3, workspace-conflict style: no ledger line).
      const usable = options.retroCopilotProbe === undefined ? copilotAvailable() : options.retroCopilotProbe();
      if (!usable) {
        throw new FactoryError(
          "retro-copilot-unusable",
          "the retro needs the copilot CLI usable on PATH — install and auth it for the daemon user (the CLI carries the pass's auth, there is no key file)",
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
      const corpus = buildRetroDigest(ledger.events, stateDir);
      const outcome = await runRetroPass({
        stateDir,
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

/** A Contract covers a cwd when the cwd is the workspace or sits inside it. */
function covers(contract: ContractSet, cwd: string): boolean {
  return cwd === contract.workspace || cwd.startsWith(`${contract.workspace}/`);
}

/** The task's acceptance, when the Owner has accepted — the closed-marker every closer reads. */
function acceptedAttempt(history: readonly LedgerEvent[]): AttemptAccepted | undefined {
  return history.findLast((e): e is AttemptAccepted => e.event === "attempt_accepted");
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
 */
function liveWorkspaceConflict(
  ledger: Ledger,
  workspace: string,
  task: string,
): { task: string; workspace: string; relation: WorkspaceRelation } | undefined {
  const mine = normalized(workspace);
  const accepted = acceptedTasks(ledger);
  for (const evt of ledger.events) {
    if (evt.event !== "contract_set" || evt.task === task || accepted.has(evt.task)) continue;
    const theirs = normalized(evt.workspace);
    let relation: WorkspaceRelation | undefined;
    if (mine === theirs) relation = "equal";
    else if (mine.startsWith(`${theirs}/`)) relation = "inside";
    else if (theirs.startsWith(`${mine}/`)) relation = "contains";
    if (relation !== undefined) return { task: evt.task, workspace: evt.workspace, relation };
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
  task: string,
  attempt: number,
  ledger: Ledger,
  stateDir: string,
  contract: ContractSet,
  result: GateResult,
  sha: string | undefined,
  eyeBudgetMs: number | undefined,
  watch: {
    agent: string | undefined;
    scopeViolations: string[] | undefined;
    fetchTimeline: TimelineFetcher | undefined;
    budgetMs: number | undefined;
    copilotRunner: CopilotRunner | undefined;
  },
): Promise<ClaimOutcome> {
  let outputPath: string | undefined;
  if (result.output !== undefined) {
    outputPath = join(stateDir, `gate-${task}-${attempt}.log`);
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
    const eye = await runFreshEyesPass({ stateDir, contract, claimedSha: sha, gateOutputPath: outputPath, budgetMs: eyeBudgetMs });
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
    const gitBlocks = ledger
      .eventsFor(task)
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
  const reportPath = writeAttemptReport(task, attempt, ledger, stateDir);
  return { attempt, verdict: result.verdict, gate, reportPath };
}

/** Every Attempt ends the same way: report rendered from the ledger, written, acknowledged. */
function writeAttemptReport(task: string, attempt: number, ledger: Ledger, stateDir: string): string {
  const markdown = renderReport(task, attempt, ledger.eventsFor(task));
  const reportPath = join(stateDir, `report-${task}-${attempt}.md`);
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
function recoverInterruptedAttempts(ledger: Ledger, stateDir: string): { task: string; attempt: number }[] {
  const recovered: { task: string; attempt: number }[] = [];
  // `retro_written` carries no task — only tasked events can need recovery.
  const tasks = [...new Set(ledger.events.flatMap((e) => ("task" in e && typeof e.task === "string" ? [e.task] : [])))];
  for (const task of tasks) {
    const history = ledger.eventsFor(task);
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
      writeAttemptReport(task, attempt, ledger, stateDir);
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
