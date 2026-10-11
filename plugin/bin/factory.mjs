#!/usr/bin/env node
/**
 * factory — the Owner's CLI (ADR 0002 / ADR 0004). Never placed on an agent's
 * PATH: setting the Contract and accepting an Attempt are the Owner's acts.
 * Since v0.0.9 the delegated Owner seat (the Supervisor, ADR 0006) runs this
 * same CLI from an explicit path — still never symlinked onto agent PATHs —
 * and every contract/accept stamps who submitted from the shell's env
 * ($PASEO_AGENT_ID, else `owner`), so the ledger names whose act each line is.
 *
 *   factory [--home <paseoHome>] contract --task <id> --workspace <dir> \
 *       --gate <command> --artifact <path> [--scope <p1,p2,...>] [--wait-secs <n>]
 *   factory [--home <paseoHome>] accept <task> --attempt <n> [--wait-secs <n>]
 *   factory [--home <paseoHome>] run <task> [<task>…] --provider <provider[/model>]
 *   factory [--home <paseoHome>] status
 *   factory [--home <paseoHome>] cost
 *
 * contract and accept submit through the spool and wait for the plugin's
 * reply — the CLI never writes the ledger. run (v0.0.5) is the driver: per
 * task it submits a `spawn` request through the same spool (the plugin
 * ledgered `spawn_dispatched`/`spawn_refused` either way), creates the agent
 * over the daemon's own WebSocket RPC, and watches to verdict — the heavy
 * half lives in plugin/bin/driver.mjs. status is a local, read-only view
 * of the ledger: one line per task, no plugin needed (it reads the same file
 * the single writer maintains, never touching it). cost (v0.0.8) is the
 * same local read shaped for the Cost row: per-task rows plus per-lane and
 * corpus totals, duration-only where no meter ever ran.
 *
 * The home defaults to `PASEO_HOME` or `~/.paseo`; against the trial daemon
 * pass `--home ~/.paseo-factory`.
 *
 * Exit codes: 0 the command succeeded · 2 it did not (bad usage, rejected by
 * the factory, no reply from the plugin, or an unreadable ledger).
 */
import { parseArgs } from "node:util";
import { join, resolve as resolvePath } from "node:path";
import { readLedgerEvents } from "./ledger-read.mjs";
import { awaitReply, randomId, resolveHome, spoolRootFor, stateDirFor, submit } from "./spool-client.mjs";

// The contract stanza's authoring-law block mirrors docs/runbooks/live-run.md
// step 3 (the ratified R2–R6 batch, ticket 02 / v0.0.8) — help text and
// runbook move together.
const usage = `usage: factory [--home <paseoHome>] <command> [options]

commands:
  contract   Set a task's done-criteria (the Owner's act — fixed before the
             agent starts; one contract per task id, the ledger is append-only)
             Contract authoring law (v0.0.8 — the ratified Retro proposals
             R2–R6, each clause paid for by ledger evidence): the gate
             command pins its executables absolutely, never PATH-resolved —
             the gate runs under the daemon's env, which has no nvm (R6); the
             description never requires an edit outside --scope — widen the
             scope or forbid the edit (R4); the description says so when the
             intended work loosens test assertions — without that opt-in,
             exact-to-loose rewrites read as suspect weakening (R2); a task
             that forbids running tests never asks for "all tests pass" —
             prescribe "implementation complete; tests not run locally" (R3);
             a config-reading bootstrap step may confirm completion but must
             not echo, commit, or summarize secret values (R5).

             --task <id> --workspace <dir> --gate <command> --artifact <path>
             [--scope <p1,p2,...>]   workspace-relative prefixes the task may touch
             [--fresh-eyes]          mark the fresh-eyes pass ON for this task
                                     (needs <stateDir>/eye.json; the pass is
                                     advisory and runs only on green verdicts)
             [--watch]               mark the watch pass ON for this task
                                     (needs the copilot CLI usable on the
                                     daemon's PATH — the CLI carries the
                                     watch's auth, there is no key file;
                                     record-only, one watch_written line
                                     after EVERY verdict)
             [--description <text>]  the task's assignment in the Owner's words —
                                     the driver's brief carries it (v0.0.6)

  accept     Accept one green attempt of a task (the Owner's act)
             accept <task> --attempt <n>

  run        Run contracted tasks' agents to verdict (the driver, v0.0.5):
             one agent per task on the daemon, watched to its verdict.
             run <task> [<task>…] --provider <provider[/model]>
             The task count is the parallelism ceiling (no --parallel knob);
             arity ≥ 2 requires scoped contracts. The driver creates the
             branch named after the task, submits one spawn request per task
             through the spool, and exits 0 only when every task ended green
             with zero refusals. Each agent's brief carries its contract's
             --description, when one was set.

  retro      Run the Retro over the whole ledger, on demand (v0.0.7): the
             plugin builds the corpus digest, prompts the pinned copilot
             model, writes retro-<date>.md in the state dir, and appends one
             retro_written line. Whole-ledger always — no --since, no task
             filter (v1). One successful retro per UTC day; a same-day second
             run is refused (exit 2, no ledger line). Proposals are advice:
             nothing becomes law until the Owner ratifies it.
             retro [--wait-secs <n>]   (default 660 — the pass is minutes-long)

  status     Print one line per task from the ledger — attempts, last verdict,
             attested sha (short), accepted, last fresh-eyes outcome, and the
             task's choke counts (permit asks allowed / denied, git refusals
             bound to the task) — plus one trailing retro line when a retro
             ever ran. A local read; the plugin need not be running.

  cost       Print the Cost read over the whole ledger (v0.0.8): one row per
             task — lane, attempts, wall (first spawn → last verdict,
             ts-derived), gate time (summed over attempts), and a cost cell
             with three honest states: the metered USD figure · "$0 marginal
             (subscription lane)" for the copilot lane, stated as a lane fact
             · "—" when capture ran but the lane reported nothing. Below the
             rows: per-lane totals (task count, median + total wall, metered
             dollars, unmetered rows) and the corpus count. Tasks no meter
             ever covered (pre-0.0.8) render duration-only — never a
             fabricated zero. Whole ledger always, no filters in v1. A local
             read; the plugin need not be running.

options:
  --home <paseoHome>   daemon home (default: $PASEO_HOME or ~/.paseo)
  --wait-secs <n>      how long to wait for the plugin's reply (default: 60;
                       retro waits 660 — the pass is minutes-long)

attribution (v0.0.9): contract and accept stamp who submitted — the
  shell's $PASEO_AGENT_ID when the daemon env carries one (the delegated
  Owner seat), else "owner" (the human path). The stamp rides the spool
  request onto the ledger line (by: on contract_set, accepted_by: on
  attempt_accepted) — there is no flag to set or override it.`;

const DEFAULT_WAIT_SECS = 60;
/** The retro's own default — one pass runs minutes, and the budget alone is 600s. */
const RETRO_WAIT_SECS = 660;

/**
 * The v0.0.9 attribution stamp (ADR 0006): the submitting shell's identity —
 * the daemon injects PASEO_AGENT_ID into agent shells, so the delegated Owner
 * seat names itself; every other shell is the human path, `owner`. A blank
 * env value counts as absent (the spool refuses an empty stamp). Both paths
 * stamp; there is no flag to override it.
 */
const stampedAgent = typeof process.env.PASEO_AGENT_ID === "string" ? process.env.PASEO_AGENT_ID.trim() : "";
const submitter = stampedAgent === "" ? "owner" : stampedAgent;

// The event vocabulary the status reader understands — mirrored from
// src/events.ts because the CLIs import no src/ code (ADR 0004). Kept on one
// line so test/status.test.ts can guard this copy against drift. Kept in sync
// with the writer by the same suite, the way test/cli.test.ts guards the spool.
const EVENT_NAMES = ["contract_set", "claim_reported", "gate_started", "gate_finished", "fresh_eyes_written", "watch_written", "report_written", "attempt_accepted", "permit_allowed", "permit_denied", "git_blocked", "spawn_dispatched", "spawn_refused", "meter_written", "retro_written"];
// Events without an Attempt number: contract_set owns the Task, the choke
// events (v0.0.4) belong to the Task's whole life, git_blocked may carry no
// task at all (the shim refuses no matter who runs it), the spawn events
// (v0.0.5) precede any attempt — the plugin records them before an agent
// exists — meter_written (v0.0.8) spans the task's whole run, and
// retro_written (v0.0.7) is factory-level: no task either.
const NO_ATTEMPT_EVENTS = new Set(["contract_set", "permit_allowed", "permit_denied", "git_blocked", "spawn_dispatched", "spawn_refused", "meter_written", "retro_written"]);

/**
 * The status reader's shape rule — every event is in the vocabulary above and
 * carries task/attempt per the NO_ATTEMPT rule. Handed to the shared reader
 * (ledger-read.mjs) as its strictness: a line failing it is corruption, named
 * with its line number.
 */
function isValidLedgerEvent(evt) {
  const taskOk = NO_ATTEMPT_EVENTS.has(evt.event) || typeof evt.task === "string";
  const attemptOk = NO_ATTEMPT_EVENTS.has(evt.event) || (Number.isInteger(evt.attempt) && evt.attempt >= 1);
  return EVENT_NAMES.includes(evt.event) && taskOk && attemptOk;
}

function fail(message) {
  console.error(`factory: ${message}\n\n${usage}`);
  process.exit(2);
}

// Split the global --home (and its value) out of argv, leaving the subcommand
// and its own options behind.
const argv = process.argv.slice(2);
let homeFlag;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--home") {
    if (i + 1 >= argv.length) fail("--home needs a value");
    homeFlag = argv[++i];
  } else if (typeof arg === "string" && arg.startsWith("--home=")) {
    homeFlag = arg.slice("--home=".length);
  } else {
    rest.push(arg);
  }
}

const command = rest.shift();
if (command === "--help" || command === "help" || command === undefined) {
  console.log(usage);
  process.exit(command === undefined ? 2 : 0);
}

const home = resolveHome(homeFlag);
const stateDir = stateDirFor(home);
const spoolRoot = spoolRootFor(stateDir);

function parseCommandOptions(spec) {
  try {
    return parseArgs({ strict: true, args: rest, options: spec, allowPositionals: true });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function waitSeconds(parsed, defaultSecs = DEFAULT_WAIT_SECS) {
  const raw = parsed.values["wait-secs"];
  if (raw === undefined) return defaultSecs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail("--wait-secs must be a positive number");
  return n;
}

async function roundTrip(request, waitSecs) {
  submit(spoolRoot, request);
  const reply = await awaitReply(spoolRoot, request.id, waitSecs * 1000);
  if (reply === null) {
    console.error(
      `factory: no reply from the factory plugin after ${waitSecs}s — is the plugin running on this home? ` +
        `The request (${request.id}) stays in the spool and may still be processed.`,
    );
    process.exit(2);
  }
  if (!reply.ok) {
    console.error(`factory: ${reply.message}`);
    process.exit(2);
  }
  return reply;
}

if (command === "contract") {
  const parsed = parseCommandOptions({
    task: { type: "string" },
    workspace: { type: "string" },
    gate: { type: "string" },
    artifact: { type: "string" },
    scope: { type: "string" },
    "fresh-eyes": { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
    description: { type: "string" },
    "wait-secs": { type: "string" },
  });
  const v = parsed.values;
  if (typeof v.task !== "string") fail("contract: --task is required");
  if (typeof v.workspace !== "string") fail("contract: --workspace is required");
  if (typeof v.gate !== "string") fail("contract: --gate is required");
  if (typeof v.artifact !== "string") fail("contract: --artifact is required");
  if (typeof v.description === "string" && v.description.trim() === "") {
    fail("contract: --description must be a non-empty text — omit it when the task has no assignment text");
  }
  if (parsed.positionals.length > 0) fail(`contract: unexpected positional "${parsed.positionals[0]}"`);

  const request = {
    id: randomId(),
    kind: "contract",
    task: v.task,
    workspace: resolvePath(v.workspace), // fixed, absolute — the agent never picks a cwd
    gate: v.gate,
    artifact: v.artifact,
    ...(v.scope === undefined
      ? {}
      : { scope: v.scope.split(",").map((s) => s.trim()).filter((s) => s !== "") }),
    ...(v["fresh-eyes"] ? { freshEyes: true } : {}),
    ...(v.watch ? { watch: true } : {}),
    ...(v.description === undefined ? {} : { description: v.description }),
    submitter,
  };
  const reply = await roundTrip(request, waitSeconds(parsed));
  console.log(`factory: ${reply.summary}`);
  process.exit(0);
}

if (command === "accept") {
  const parsed = parseCommandOptions({
    attempt: { type: "string" },
    "wait-secs": { type: "string" },
  });
  const task = parsed.positionals[0];
  if (task === undefined) fail("accept: a task id is required (factory accept <task> --attempt <n>)");
  if (parsed.positionals.length > 1) fail(`accept: unexpected positional "${parsed.positionals[1]}"`);
  const attempt = Number(parsed.values.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) fail("accept: --attempt must be a positive integer");

  const reply = await roundTrip({ id: randomId(), kind: "accept", task, attempt, submitter }, waitSeconds(parsed));
  console.log(`factory: ${reply.summary}`);
  process.exit(0);
}

if (command === "run") {
  const parsed = parseCommandOptions({
    provider: { type: "string" },
    "wait-secs": { type: "string" },
  });
  const tasks = parsed.positionals;
  if (tasks.length === 0) fail("run: at least one task id is required (factory run <task> [<task>…] --provider <provider[/model]>)");
  const provider = parsed.values.provider;
  if (typeof provider !== "string" || provider.trim() === "") fail("run: --provider <provider[/model]> is required — one provider for every task in the invocation");
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task)) fail(`run: task ${task} appears twice — one spawn per task per invocation`);
    seen.add(task);
  }

  const { runDriver } = await import("./driver.mjs");
  const code = await runDriver({
    home,
    stateDir,
    spoolRoot,
    tasks,
    provider: provider.trim(),
    waitSecs: waitSeconds(parsed),
  });
  process.exit(code);
}

if (command === "retro") {
  const parsed = parseCommandOptions({ "wait-secs": { type: "string" } });
  if (parsed.positionals.length > 0) fail(`retro: unexpected positional "${parsed.positionals[0]}" — the retro reads the whole ledger, there is nothing to name`);

  // No arguments ride the request: whole-ledger always (v1; no --since, no
  // task filter). The plugin builds the digest, runs the pass, writes the
  // proposals file and the one retro_written line; the reply's summary is
  // the proposal count and the file path (ticket 03 item 2).
  const reply = await roundTrip({ id: randomId(), kind: "retro" }, waitSeconds(parsed, RETRO_WAIT_SECS));
  console.log(`factory: ${reply.summary}`);
  process.exit(0);
}

if (command === "status") {
  const parsed = parseCommandOptions({});
  if (parsed.positionals.length > 0) fail(`status: unexpected positional "${parsed.positionals[0]}"`);

  // The Owner's own data, read back directly — no spool round trip, no plugin
  // needed (ADR 0004 makes the plugin the only writer, not the only reader).
  // The read is the shared one (ledger-read.mjs) under status's strict
  // policy; anything unreadable is reported (exit 2), never guessed around.
  const ledgerPath = join(stateDir, "ledger.jsonl");
  const read = readLedgerEvents(ledgerPath, { validateEvent: isValidLedgerEvent });
  if (read.failed !== undefined) {
    die(`cannot read ${ledgerPath}: ${read.failed instanceof Error ? read.failed.message : String(read.failed)}`);
  }
  if (read.corrupt !== undefined) corruptLedger(ledgerPath, read.corrupt);
  const events = read.missing ? null : read.events;
  if (events === null || events.length === 0) {
    console.log(`factory: no tasks yet (ledger: ${ledgerPath})`);
    process.exit(0);
  }
  for (const line of statusLines(events)) console.log(line);
  process.exit(0);
}

if (command === "cost") {
  const parsed = parseCommandOptions({});
  if (parsed.positionals.length > 0) fail(`cost: unexpected positional "${parsed.positionals[0]}" — the cost read is whole-ledger always, no filters in v1`);

  // The Cost read (v0.0.8, ticket 03 item 4): the same local read as status,
  // shaped for the ladder's cost row. Every duration is ts-derived; every
  // dollar is metered or absent — zero price constants live here (the law).
  const ledgerPath = join(stateDir, "ledger.jsonl");
  const read = readLedgerEvents(ledgerPath, { validateEvent: isValidLedgerEvent });
  if (read.failed !== undefined) {
    die(`cannot read ${ledgerPath}: ${read.failed instanceof Error ? read.failed.message : String(read.failed)}`);
  }
  if (read.corrupt !== undefined) corruptLedger(ledgerPath, read.corrupt);
  const events = read.missing ? null : read.events;
  if (events === null || events.length === 0) {
    console.log(`factory: no tasks yet (ledger: ${ledgerPath})`);
    process.exit(0);
  }
  for (const line of costLines(events)) console.log(line);
  process.exit(0);
}

fail(`unknown command "${command}"`);

/** One line per task, in first-appearance (ledger) order — the Owner's glance at the factory. */
function statusLines(events) {
  const order = [];
  const byTask = new Map();
  let retro;
  for (const evt of events) {
    if (evt.event === "retro_written") {
      // The one factory-level event (v0.0.7): it belongs to no task line —
      // the last retro on record prints once, after every task.
      retro = evt;
      continue;
    }
    if (evt.event !== "contract_set" && NO_ATTEMPT_EVENTS.has(evt.event)) {
      // The choke events (v0.0.4) carry no Attempt: they count toward their
      // task's line — a live Contract always precedes them in the ledger — and
      // an untasked git block counts toward no line at all. The spawn events
      // (v0.0.5) ride the ledger as the spawn record itself: validated and read
      // through, counted toward no field — the driver's output and the ledger
      // name refusals, the glance does not repeat them.
      const counted = byTask.get(evt.task);
      if (counted !== undefined) {
        if (evt.event === "permit_allowed") counted.allowed += 1;
        else if (evt.event === "permit_denied") counted.denied += 1;
        else if (evt.event === "git_blocked") counted.blocked += 1;
      }
      continue;
    }
    let state = byTask.get(evt.task);
    if (state === undefined) {
      state = { attempts: 0, verdict: undefined, sha: undefined, eye: undefined, accepted: false, allowed: 0, denied: 0, blocked: 0 };
      byTask.set(evt.task, state);
      order.push(evt.task);
    }
    if (evt.event === "contract_set") continue; // the Contract registers its Task's line, but never counts as an Attempt
    if (evt.attempt > state.attempts) state.attempts = evt.attempt;
    if (evt.event === "gate_finished") {
      state.verdict = evt.verdict; // the last verdict on record, even while a newer attempt runs
      state.sha = typeof evt.sha === "string" ? evt.sha.slice(0, 7) : undefined; // git's short length
    }
    if (evt.event === "fresh_eyes_written") {
      state.eye = typeof evt.outcome === "string" ? evt.outcome : undefined; // the last eye on record
    }
    if (evt.event === "attempt_accepted") state.accepted = true;
  }
  const lines = order.map((task) => {
    const s = byTask.get(task);
    return `${task} attempts=${s.attempts} verdict=${s.verdict ?? "-"} sha=${s.sha ?? "-"} accepted=${s.accepted ? "yes" : "no"} eye=${s.eye ?? "-"} choke=${s.allowed}/${s.denied}/${s.blocked}`;
  });
  if (retro !== undefined) {
    const day = typeof retro.ts === "string" ? retro.ts.slice(0, 10) : "-";
    const count = retro.outcome === "written" && Number.isInteger(retro.proposalCount) ? ` proposals=${retro.proposalCount}` : "";
    lines.push(`retro last=${day} outcome=${retro.outcome ?? "-"}${count}`);
  }
  return lines;
}

function die(message) {
  console.error(`factory: ${message}`);
  process.exit(2);
}

// ---- the Cost read (v0.0.8, ticket 03 items 4–5) ------------------------------------------------

/** The lane half of a provider string: `claude/claude-sonnet-5` → `claude`. */
function laneOf(provider) {
  const at = provider.indexOf("/");
  return at === -1 ? provider : provider.slice(0, at);
}

/** One duration, human-shaped: one decimal under 10s, whole seconds under a minute, then m/s, then h/m. */
function fmtDur(ms) {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    return `${minutes}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
  }
  const hours = Math.floor(ms / 3_600_000);
  return `${hours}h${String(Math.round((ms % 3_600_000) / 60_000)).padStart(2, "0")}m`;
}

/** The median of a list of numbers; undefined when the list is empty (nothing derivable, never a zero). */
function medianOf(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * One task's Cost-read row, folded from the task's whole ledger slice
 * (grouped once by the caller): attempts, lane (the latest meter's
 * provider, else the latest spawn's — a task the driver never ran has no
 * lane), wall (first spawn → last verdict, both ts-derived; "-" when either
 * end never landed), gate time (the sum over paired
 * gate_started→gate_finished), and the cost cell's three honest states —
 * plus the fourth, no meter line at all, which renders no cost key: a
 * duration-only row (pre-0.0.8 tasks), never a fabricated zero.
 */
function costRow(task, events) {
  let attempts = 0;
  let lane;
  let meter;
  let firstSpawn;
  let lastVerdict;
  let gateMs = 0;
  let gatePairs = 0;
  const gateStartByAttempt = new Map();
  for (const evt of events) {
    if (Number.isInteger(evt.attempt) && evt.attempt > attempts) attempts = evt.attempt;
    if (evt.event === "spawn_dispatched") {
      if (firstSpawn === undefined) firstSpawn = Date.parse(evt.ts);
      lane = evt.provider;
    } else if (evt.event === "meter_written") {
      meter = evt; // the latest meter line wins — a re-run task re-meters
      lane = evt.provider;
    } else if (evt.event === "gate_started") {
      gateStartByAttempt.set(evt.attempt, Date.parse(evt.ts));
    } else if (evt.event === "gate_finished") {
      lastVerdict = Date.parse(evt.ts);
      const started = gateStartByAttempt.get(evt.attempt);
      if (started !== undefined) {
        gateMs += lastVerdict - started;
        gatePairs += 1;
      }
    }
  }
  const wall = firstSpawn !== undefined && lastVerdict !== undefined ? lastVerdict - firstSpawn : undefined;
  const dollars = typeof meter?.usage?.totalCostUsd === "number" && Number.isFinite(meter.usage.totalCostUsd) ? meter.usage.totalCostUsd : undefined;
  let costState = "none"; // no meter line ever — the duration-only row
  if (meter !== undefined) {
    if (dollars !== undefined) costState = "metered";
    else if (laneOf(meter.provider) === "copilot") costState = "subscription"; // $0 marginal is the lane's fact, not a measurement
    else costState = "absent"; // capture ran, the lane reported no dollars
  }
  return {
    task,
    lane,
    attempts,
    wall,
    gate: gatePairs > 0 ? gateMs : undefined,
    dollars,
    costState,
  };
}

/**
 * The Cost read's whole output: one row per contracted task in
 * first-appearance order, then per-lane totals (task count, median + total
 * wall over derivable walls, metered-dollars total with "-" when the lane
 * metered nothing), then the corpus counts. Every duration is a ts pair;
 * every dollar is metered or absent — the price-sheet law holds with zero
 * constants on this side of the ledger.
 */
function costLines(events) {
  // Group once by task (a tasked event can only belong to one row), then
  // fold each row from its own slice — no task ever rescans the whole file.
  const taskOrder = [];
  const byTask = new Map();
  for (const evt of events) {
    if (typeof evt.task !== "string") continue; // retro lines and unbound git blocks belong to no row
    if (!byTask.has(evt.task)) {
      if (evt.event !== "contract_set") continue; // rows register on the Contract — a ghost's refusal invents nothing
      byTask.set(evt.task, []);
      taskOrder.push(evt.task);
    }
    byTask.get(evt.task).push(evt);
  }
  const rows = taskOrder.map((task) => costRow(task, byTask.get(task)));

  const lines = rows.map((row) => {
    const cost =
      row.costState === "none"
        ? ""
        : row.costState === "metered"
          ? ` cost=$${row.dollars.toFixed(2)}`
          : row.costState === "subscription"
            ? " cost=$0 marginal (subscription lane)"
            : " cost=—";
    return (
      `${row.task} lane=${row.lane ?? "-"} attempts=${row.attempts}` +
      ` wall=${row.wall === undefined ? "-" : fmtDur(row.wall)}` +
      ` gate=${row.gate === undefined ? "-" : fmtDur(row.gate)}` +
      cost
    );
  });

  const laneOrder = [];
  const byLane = new Map();
  for (const row of rows) {
    if (row.lane === undefined) continue; // never driver-run: no lane, still counted in the corpus line
    const family = laneOf(row.lane);
    if (!byLane.has(family)) {
      byLane.set(family, []);
      laneOrder.push(family);
    }
    byLane.get(family).push(row);
  }
  if (lines.length > 0) lines.push("");
  for (const family of laneOrder) {
    const laneRows = byLane.get(family);
    const walls = laneRows.map((row) => row.wall).filter((wall) => wall !== undefined);
    const meteredRows = laneRows.filter((row) => row.costState === "metered");
    const meteredTotal = meteredRows.reduce((sum, row) => sum + row.dollars, 0);
    lines.push(
      `lane=${family} tasks=${laneRows.length}` +
        ` wall-median=${walls.length === 0 ? "-" : fmtDur(medianOf(walls))}` +
        ` wall-total=${walls.length === 0 ? "-" : fmtDur(walls.reduce((sum, wall) => sum + wall, 0))}` +
        ` metered=${meteredRows.length === 0 ? "-" : `$${meteredTotal.toFixed(2)}`}` +
        ` unmetered-rows=${laneRows.length - meteredRows.length}`,
    );
  }
  const meteredCount = rows.filter((row) => row.costState === "metered").length;
  lines.push(`corpus rows=${rows.length} metered-rows=${meteredCount} unmetered-rows=${rows.length - meteredCount}`);
  return lines;
}

function corruptLedger(path, reason) {
  die(`${path} is not a readable ledger: ${reason}`);
}
