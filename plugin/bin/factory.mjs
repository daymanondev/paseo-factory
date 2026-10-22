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
 *   factory [--home <paseoHome>] accept <task> --attempt <n> [--by owner|supervisor|lead] [--wait-secs <n>]
 *   factory [--home <paseoHome>] run <task> [<task>…] [--provider <provider[/model]>]
 *   factory [--home <paseoHome>] lanes [get [<lane>] | set <lane> <value>]
 *   factory [--home <paseoHome>] status
 *   factory [--home <paseoHome>] cost
 *   factory [--home <paseoHome>] vault status | hydrate | pull | push | seal | sync | import
 *
 * contract and accept submit through the spool and wait for the plugin's
 * reply — the CLI never writes the ledger directly for loop acts (the sole
 * offline exception is ADR 0014 §3.4's `vault pull --merge-ledgers` / `vault sync`
 * multi-node ledger snapshot reconciliation). run (v0.0.5) is the driver: per
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
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { readLedgerEvents } from "./ledger-read.mjs";
import { awaitReply, randomId, resolveHome, spoolRootFor, stateDirFor, submit } from "./spool-client.mjs";
import { LANE_NAMES, loadLanes, resolveRunProvider, saveLanes } from "./lanes-config.mjs";
import { resolveProject } from "./project.mjs";

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
                                     (dispatches through lanes.freshEyes in
                                     <stateDir>/lanes.json, default pi/zai/glm-5.3,
                                     or <stateDir>/eye.json when set to "eye.json";
                                     advisory, runs only on green verdicts;
                                     defaults to ON when Lead sets a contract
                                     and the freshEyes lane is usable)
             [--no-fresh-eyes]       explicitly opt out of the fresh-eyes pass
                                     (leaves fresh-eyes OFF even when called by Lead)
             [--watch]               mark the watch pass ON for this task
                                     (dispatches through lanes.watch in
                                     <stateDir>/lanes.json, default pi/zai/glm-5.3;
                                     record-only, one watch_written line
                                     after EVERY verdict)
             [--description <text>]  the task's assignment in the Owner's words —
                                     the driver's brief carries it (v0.0.6)
             [--skills <s1,s2,...>]  SKILL.md workflows the working agent must
                                     open first (v0.0.14) — the Lead mandates
                                     a method, not just an outcome; the
                                     driver's brief renders them at the top

  accept     Accept one green attempt of a task (the Owner's act)
             accept <task> --attempt <n> [--by owner|supervisor|lead]
             --by names the accepting seat (v0.0.14): owner/supervisor are
             the unconditional override, lead accepts green + CONCERN-free

  run        Run contracted tasks' agents to verdict (the driver, v0.0.5):
             one agent per task on the daemon, watched to its verdict.
             run <task> [<task>…] [--provider <provider[/model]>]
             --provider is optional since v0.0.13: omitted reads the worker
             lane from <stateDir>/lanes.json (default pi/zai/glm-5.3); an
             explicit --provider overrides the lane (ADR 0009 §3).
             The task count is the parallelism ceiling (no --parallel knob);
             arity ≥ 2 requires scoped contracts. The driver creates the
             branch named after the task, submits one spawn request per task
             through the spool, and exits 0 only when every task ended green
             with zero refusals. Each agent's brief carries its contract's
             --description, when one was set.

  lanes      Inspect or set the Lane config (v0.0.13, ADR 0009 §3; the lead
             lane and --project arrive in v0.0.14, ADR 0010) — the one place
             every model-bearing role's provider/model is named: supervisor,
             lead, worker, watch, retro, freshEyes (all defaulting to
             pi/zai/glm-5.3). A lane is provider/model with both halves
             non-empty, or "eye.json" for freshEyes alone (the legacy direct
             HTTP config in <stateDir>/eye.json). A local read/write of
             <stateDir>/lanes.json — the plugin need not be running.
             lanes [get [<lane>]] [--project <dir>]
                                     print one lane, or all six when omitted;
                                     --project overlays the Project's
                                     <stateDir>/projects/<slug>/lanes.json
             lanes set <lane> <value> [--project <dir>]
                                      validate and write one lane into the
                                      machine file, or the Project's override
                                      file under --project (only the lanes
                                      ever named persist — a refused value
                                      writes nothing, exit 2)

  lead       Rotate a Project's Lead seat or dispatch into its Lead mailbox.
             lead rotate --project <dir>   (v0.0.14, ADR 0010 §2) cancel and
                                          archive the active seat=lead,
                                          project=<slug> agent so the next
                                          dispatch starts a fresh Lead
                                          session. Submits through the spool —
                                          the plugin is the one daemon actor;
                                          no ledger line lands (a rotation is
                                          a daemon fact, not a factory fact).
                                          --project is any directory inside
                                          the Project's repository.
             lead dispatch [--project <slug>] [--workspace <dir>] --message "<text>"
                                          (v0.0.20, ADR 0013 §4) queue one
                                          directive in the Project's Lead
                                          mailbox (<projectStateDir>/
                                          mailbox.jsonl): the plugin
                                          auto-ensures the Project's Lead
                                          seat, appends mail_queued, and
                                          delivers the batch when the Lead is
                                          idle — the mail holds (never lost)
                                          while the Lead runs. Exactly one
                                          target: the registry slug or a
                                          directory inside the Project's
                                          repository; the message may ride as
                                          one positional instead of --message.

  supervisor Seat-aware directive dispatch or Lead -> Supervisor reporting
             (v0.0.23, ADR 0015 §3/§5).
             supervisor dispatch [--project <slug>] [--workspace <dir>] --message "<text>"
                                           route a directive into the Project's
                                           Supervisor mailbox (to="supervisor")
                                           when called from a normal chat, or
                                           transparently into Lead (to="lead")
                                           when called from Supervisor.
             supervisor report [--project <slug>] [--workspace <dir>] --message "<text>"
                                           queue a Lead wave-completion or
                                           escalation report in the Project's
                                           Supervisor mailbox (to="supervisor",
                                           from="lead", kind="report").

  reset      Owner-only clean-slate Project reset (v0.0.24, ADR 0015 §6):
             purges the Project's ledger events, task reports/worktrees, and
             per-Project state directory (<stateDir>/projects/<slug>/), and
             archives live worker/seat sessions unless --keep-seats is set.
             reset [--workspace <dir>] [--project <slug>] [--keep-seats]


  retro      Run the Retro over the whole ledger, on demand (v0.0.7): the
             plugin builds the corpus digest, prompts the configured retro
             lane from <stateDir>/lanes.json (default pi/zai/glm-5.3),
             writes retro-<date>.md in the state dir, and appends one
             retro_written line. Whole-ledger always — no --since, no task
             filter (v1). One successful retro per UTC day; a same-day second
             run is refused (exit 2, no ledger line). Proposals are advice:
             nothing becomes law until the Owner ratifies it.
             retro [--wait-secs <n>]   (default 660 — the pass is minutes-long)

  status     Print one line per task from the ledger — attempts, last verdict,
             attested sha (short), accepted, last fresh-eyes outcome, and the
             task's choke counts (permit asks allowed / denied, git refusals
             bound to the task) — plus a needs-human key when the Lead ever
             wrote one (v0.0.10: the glance's needs-human marker), and one
             trailing retro line when a retro ever ran. A local read; the
             plugin need not be running.

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

  vault      The Private vault's seven verbs (v0.0.21–v0.0.22, ADR 0014):
             status | hydrate | pull | push | seal | sync | import against the
             Owner's private GitHub repository. Every verb prints one JSON
             object on stdout — vault operations script and verify mechanically
             (spec §User Story 11; exit 0 on success, 2 on any failure). The
             work rides the CLI's own engine mirror (plugin/bin/vault.mjs —
             the CLIs import no src/ code, ADR 0004), pinned to the core
             engine by test/vault-cli.test.ts.

             vault status        the VaultStatusView as JSON: configured,
                                 repo, branch, nodeId, hasPassphrase,
                                 cloneExists, hydration/push stamps, the four
                                 shared-secret pills, hydratedApps, gh CLI
                                 readiness, error. A pure local read of
                                 <stateDir>/vault-config.json and the
                                 <paseoHome>/vault-runtime probes — the plugin
                                 need not be running
             vault sync [--repo <owner/repo>] [--branch <branch>] [--passphrase <pass>] [--overwrite-configs]
                                 one-command unified sync: pull remote into
                                 <paseoHome>/vault (provisioning via gh repo
                                 create --private when missing, or
                                 bootstrapping an empty remote), hydrate
                                 <paseoHome>/vault-runtime, materialize per-
                                 Project secrets and machine configs, reconcile
                                 multi-node ledgers, then collect local state
                                 and push any changes + ledger snapshots back
             vault import [--asc-key <path>] [--asc-key-id <id>] [--asc-issuer <id>] [--gplay-key <path>] [--eye-config <path>] [--app <key>] [--keystore <path>] [--store-pass <pass>] [--key-alias <alias>] [--no-sync]
                                 stage shared credentials (ASC .p8 + Key ID /
                                 Issuer ID, Google Play service account JSON,
                                 eye.json) and/or per-app signing (Android
                                 release.keystore + signing.json) into
                                 <paseoHome>/vault-runtime, rebuild env.json,
                                 materialize into registered Projects, and run
                                 a full vault sync unless --no-sync is set
             vault hydrate [--repo <owner/repo>] [--ref <ref>] [--merge-ledgers] [--overwrite-configs]
                                 Direct hydrate (zero-clone): stream the repo
                                 tarball through the machine's gh api
                                 session, unseal envelopes in memory, write
                                 <paseoHome>/vault-runtime/ (0o600 under
                                 secrets/) plus the env.json pointer index,
                                 and materialize per-Project secrets and
                                 machine configs (--overwrite-configs replaces
                                 existing lanes/fleet/free-pool files;
                                 --merge-ledgers reconciles multi-node ledgers)
                                 — no .git checkout is left behind. --repo
                                 defaults to the saved config's repo (and on
                                 a home with no saved config it is persisted
                                 as the config of record), --ref to the
                                 configured branch (main); a locked
                                 (aes-256-gcm) envelope unseals through
                                 FACTORY_VAULT_PASSPHRASE or the saved config
             vault pull [--merge-ledgers] [--overwrite-configs]
                                 Vault pull: clone (or git pull --rebase
                                 --autostash, or empty-remote bootstrap)
                                 <paseoHome>/vault from the configured repo,
                                 hydrate the runtime tree from the checkout,
                                 materialize per-app secrets into registered
                                 Projects and machine configs into <stateDir>
                                 (--overwrite-configs replaces existing files),
                                 and reconcile multi-node ledgers when
                                 --merge-ledgers is passed
             vault push [--include-ledger]
                                 collect local machine configs (lanes.json,
                                 fleet.json, free-pool.json), registered
                                 Project .store-release/manifest.json files,
                                 and sealed eye.json, package
                                 <paseoHome>/vault-runtime back into the vault
                                 checkout under the re-seal law (a checkout
                                 path holding an envelope never receives raw
                                 plaintext back — unchanged content keeps the
                                 sealed bytes, changed content re-seals;
                                 env.json, the machine-local pointer, never
                                 rides), commit and push — a commit only when
                                 something changed, never an empty one.
                                 --include-ledger also snapshots the global
                                 ledger and every registered Project ledger
                                 under state/nodes/<nodeId>/
             vault seal <file> --to <vaultPath> [--passphrase <pass>]
                                 seal one local file into the runtime tree at
                                 <paseoHome>/vault-runtime/<vaultPath> —
                                 "vault push" publishes it from there.
                                 Without --passphrase: the zero-passphrase
                                 "obfuscated" envelope (the GitHub
                                 secret-scanning shield — hydrate unseals it
                                 with no prompt). With one: aes-256-gcm,
                                 which hydrate opens via
                                 FACTORY_VAULT_PASSPHRASE or the saved config

options:
  --home <paseoHome>   daemon home (default: $PASEO_HOME or ~/.paseo)
  --wait-secs <n>      how long to wait for the plugin's reply (default: 60;
                       retro waits 660 — the pass is minutes-long)

attribution (v0.0.9): contract and accept stamp who submitted — the
  shell's $PASEO_AGENT_ID when the daemon env carries one (the delegated
  Owner seat), else "owner" (the human path). The stamp rides the spool
  request onto the ledger line (by: on contract_set, accepted_by: on
  attempt_accepted). Since v0.0.14 "accept --by owner|supervisor|lead" is
  the one flag that overrides the stamp — the acceptance authority seats
  (ADR 0010 §3); "lead" is judged at the factory, not trusted from here.`;

const DEFAULT_WAIT_SECS = 60;
/** The retro's own default — one pass runs minutes, and the budget alone is 600s. */
const RETRO_WAIT_SECS = 660;

/**
 * The acceptance authority seats (v0.0.14, ADR 0010 §3): `owner` and
 * `supervisor` are the unconditional override, `lead` the intermediate
 * acceptance the factory judges (green + CONCERN-free + not escalated).
 */
const ACCEPT_SEATS = ["owner", "supervisor", "lead"];

/**
 * The v0.0.9 attribution stamp (ADR 0006): the submitting shell's identity —
 * the daemon injects PASEO_AGENT_ID into agent shells, so the delegated Owner
 * seat names itself; every other shell is the human path, `owner`. A blank
 * env value counts as absent (the spool refuses an empty stamp). Both paths
 * stamp; there is no flag to override it.
 */
const stampedAgent = typeof process.env.PASEO_AGENT_ID === "string" ? process.env.PASEO_AGENT_ID.trim() : "";
const stampedCorrelation =
  typeof process.env.PASEO_FACTORY_CORRELATION === "string" ? process.env.PASEO_FACTORY_CORRELATION.trim() : "";
const submitter = stampedAgent !== "" ? stampedAgent : stampedCorrelation !== "" ? stampedCorrelation : "owner";
const rawSeat = typeof process.env.PASEO_FACTORY_SEAT === "string" ? process.env.PASEO_FACTORY_SEAT.trim() : "";
const stampedSeat = rawSeat === "supervisor" || rawSeat === "lead" || rawSeat === "agent" ? rawSeat : undefined;

// The event vocabulary the status reader understands — mirrored from
// src/events.ts because the CLIs import no src/ code (ADR 0004). Kept on one
// line so test/status.test.ts can guard this copy against drift. Kept in sync
// with the writer by the same suite, the way test/cli.test.ts guards the spool.
const EVENT_NAMES = ["contract_set", "claim_reported", "gate_started", "gate_finished", "fresh_eyes_written", "watch_written", "report_written", "attempt_accepted", "permit_allowed", "permit_denied", "git_blocked", "spawn_dispatched", "spawn_refused", "meter_written", "repoke_dispatched", "repoke_refused", "respawn_dispatched", "respawn_refused", "needs_human", "retro_written"];
// Events without an Attempt number: contract_set owns the Task, the choke
// events (v0.0.4) belong to the Task's whole life, git_blocked may carry no
// task at all (the shim refuses no matter who runs it), the spawn events
// (v0.0.5) precede any attempt — the plugin records them before an agent
// exists — meter_written (v0.0.8) spans the task's whole run, the Lead's
// three lines (v0.0.10) and the respawn pair (v0.0.12) are task-scoped, and
// retro_written (v0.0.7) is factory-level: no task either.
const NO_ATTEMPT_EVENTS = new Set(["contract_set", "permit_allowed", "permit_denied", "git_blocked", "spawn_dispatched", "spawn_refused", "meter_written", "repoke_dispatched", "repoke_refused", "respawn_dispatched", "respawn_refused", "needs_human", "retro_written"]);

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
  const payload = {
    ...request,
    ...(request.submitter === undefined ? { submitter } : {}),
    ...(stampedSeat === undefined || request.seat !== undefined ? {} : { seat: stampedSeat }),
  };
  submit(spoolRoot, payload);
  const reply = await awaitReply(spoolRoot, payload.id, waitSecs * 1000);
  if (reply === null) {
    // The stop-on-timeout instruction (v0.0.31, ADR 0017 §6): the single
    // deduplicated request stays durably queued in spool/requests/ — reloading
    // the plugin resumes the pipeline — so the caller must stop retrying and
    // end its turn immediately.
    console.error(
      `factory: No reply from the factory plugin after ${waitSecs}s (request ${payload.id} remains queued in spool/requests/). ` +
        `The paseo-factory plugin may be stopped — DO NOT retry or call this tool again; end your turn immediately so the plugin can process the queued request when reloaded.`,
    );
    process.exit(2);
  }
  if (!reply.ok) {
    // The refusal's code rides the line (the driver's own refusal-log law):
    // a `lead-accept-refused` reads as itself at the terminal, not as prose.
    console.error(`factory: ${reply.code}: ${reply.message}`);
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
    skills: { type: "string" },
    "fresh-eyes": { type: "boolean", default: false },
    "no-fresh-eyes": { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
    description: { type: "string" },
    "wait-secs": { type: "string" },
  });
  const v = parsed.values;
  if (typeof v.task !== "string") fail("contract: --task is required");
  if (typeof v.workspace !== "string") fail("contract: --workspace is required");
  if (typeof v.gate !== "string") fail("contract: --gate is required");
  if (typeof v.artifact !== "string") fail("contract: --artifact is required");
  if (v["fresh-eyes"] && v["no-fresh-eyes"]) fail("contract: pass either --fresh-eyes or --no-fresh-eyes, not both");
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
    ...(v.skills === undefined
      ? {}
      : { skills: v.skills.split(",").map((s) => s.trim()).filter((s) => s !== "") }),
    ...(v["fresh-eyes"] ? { freshEyes: true } : v["no-fresh-eyes"] ? { freshEyes: false } : {}),
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
    by: { type: "string" },
    "wait-secs": { type: "string" },
  });
  const task = parsed.positionals[0];
  if (task === undefined) fail("accept: a task id is required (factory accept <task> --attempt <n> [--by owner|supervisor|lead])");
  if (parsed.positionals.length > 1) fail(`accept: unexpected positional "${parsed.positionals[1]}"`);
  const attempt = Number(parsed.values.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) fail("accept: --attempt must be a positive integer");
  // The acceptance authority seats (v0.0.14, ADR 0010 §3): the flag claims
  // one explicitly; without it the shell's own stamp rides (the v0.0.9 law —
  // the delegated agent's id or "owner").
  let by;
  if (parsed.values.by !== undefined) {
    if (!ACCEPT_SEATS.includes(parsed.values.by)) {
      fail(`accept: --by must be one of owner|supervisor|lead — got "${parsed.values.by}"`);
    }
    by = parsed.values.by;
  }

  const reply = await roundTrip(
    { id: randomId(), kind: "accept", task, attempt, submitter, ...(by === undefined ? {} : { by }) },
    waitSeconds(parsed),
  );
  console.log(`factory: ${reply.summary}`);
  process.exit(0);
}

if (command === "lanes") {
  const parsed = parseCommandOptions({ project: { type: "string" } });
  const sub = parsed.positionals[0] ?? "get";

  // v0.0.14 (ADR 0010 §5): --project <dir> resolves the directory's canonical
  // Project and targets its override file — get merges it over the machine
  // table, set writes into it alone.
  let projectSlug;
  if (typeof parsed.values.project === "string") {
    const projectDir = resolvePath(parsed.values.project);
    const project = resolveProject(projectDir);
    if (!project.ok) {
      fail(`lanes: --project ${parsed.values.project} does not resolve to a git repository — ${project.reason}`);
    }
    projectSlug = project.slug;
  }

  if (sub === "get") {
    if (parsed.positionals.length > 2) fail(`lanes get: unexpected positional "${parsed.positionals[2]}"`);
    const lanes = loadLanes(stateDir, projectSlug);
    if (!lanes.ok) fail(`lanes: ${lanes.reason}`);
    const wanted = parsed.positionals[1];
    if (wanted !== undefined && !LANE_NAMES.includes(wanted)) {
      fail(`lanes: unknown lane "${wanted}" — the lanes are ${LANE_NAMES.join(", ")}`);
    }
    for (const name of wanted === undefined ? LANE_NAMES : [wanted]) {
      console.log(`${name}=${lanes.lanes[name]}`);
    }
    process.exit(0);
  }

  if (sub === "set") {
    const lane = parsed.positionals[1];
    const value = parsed.positionals[2];
    if (parsed.positionals.length !== 3) fail("lanes set: exactly two arguments — factory lanes set <lane> <value> [--project <dir>]");
    if (!LANE_NAMES.includes(lane)) fail(`lanes set: unknown lane "${lane}" — the lanes are ${LANE_NAMES.join(", ")}`);
    const saved = saveLanes(stateDir, { [lane]: value }, projectSlug);
    if (!saved.ok) fail(`lanes set: ${saved.reason}`);
    console.log(`factory: ${lane}=${saved.lanes[lane]} (lanes.json updated)`);
    process.exit(0);
  }

  fail(`lanes: unknown subcommand "${sub}" — use "lanes [get [<lane>] | set <lane> <value>] [--project <dir>]"`);
}

if (command === "lead") {
  const parsed = parseCommandOptions({ project: { type: "string" }, workspace: { type: "string" }, message: { type: "string" }, "wait-secs": { type: "string" } });
  const sub = parsed.positionals[0];

  if (sub === "rotate") {
    if (parsed.positionals.length > 1) fail(`lead rotate: unexpected positional "${parsed.positionals[1]}"`);
    if (typeof parsed.values.project !== "string" || parsed.values.project.trim() === "") {
      fail("lead rotate: --project <dir> is required — any directory inside the Project's repository");
    }
    // v0.0.14 (ADR 0010 §2): the rotation is a spool round trip — the CLI only
    // submits; the plugin cancels + archives the Project's seat=lead agent and
    // names it in the reply.
    const reply = await roundTrip(
      { id: randomId(), kind: "lead_rotate", projectRoot: resolvePath(parsed.values.project) },
      waitSeconds(parsed),
    );
    console.log(`factory: ${reply.summary}`);
    process.exit(0);
  }

  if (sub === "dispatch") {
    // v0.0.20 (ADR 0013 §4): the directive rides the same spool — the plugin
    // resolves the Project, auto-ensures its Lead seat, appends one
    // mail_queued to <projectStateDir>/mailbox.jsonl, and pumps the lane. The
    // reply names the project, the Lead agent, the mail id, and the rotation
    // state, so no raw Paseo agentId is ever needed here. The CLI leaves
    // `from` unset — the plugin's default records the owner side.
    const message = typeof parsed.values.message === "string" ? parsed.values.message : parsed.positionals[1];
    if (message === undefined || message.trim() === "") {
      fail('lead dispatch: --message "<text>" is required (or one positional message)');
    }
    if (parsed.positionals.length > 2) fail(`lead dispatch: unexpected positional "${parsed.positionals[2]}"`);
    if (parsed.values.message !== undefined && parsed.positionals.length > 1) {
      fail("lead dispatch: pass the message either as --message or as one positional, not both");
    }
    const hasProject = typeof parsed.values.project === "string" && parsed.values.project.trim() !== "";
    const hasWorkspace = typeof parsed.values.workspace === "string" && parsed.values.workspace.trim() !== "";
    if (!hasProject && !hasWorkspace) {
      fail("lead dispatch: --project <slug> or --workspace <dir> is required — the Project whose Lead receives the directive");
    }
    if (hasProject && hasWorkspace) {
      fail("lead dispatch: name exactly one target — --project <slug> or --workspace <dir>");
    }
    const reply = await roundTrip(
      {
        id: randomId(),
        kind: "lead_dispatch",
        ...(hasProject ? { project: parsed.values.project.trim() } : {}),
        ...(hasWorkspace ? { workspace: resolvePath(parsed.values.workspace) } : {}),
        message,
      },
      waitSeconds(parsed),
    );
    console.log(`factory: ${reply.summary}`);
    process.exit(0);
  }

  fail(`lead: unknown subcommand "${sub ?? "(none)"}" — use "lead rotate --project <dir>" or "lead dispatch --project <slug> --message \\"<text>\\""`);
}

if (command === "supervisor") {
  const parsed = parseCommandOptions({
    project: { type: "string" },
    workspace: { type: "string" },
    message: { type: "string" },
    "wait-secs": { type: "string" },
  });
  const sub = parsed.positionals[0];

  if (sub === "dispatch" || sub === "report") {
    const message = typeof parsed.values.message === "string" ? parsed.values.message : parsed.positionals[1];
    if (message === undefined || message.trim() === "") {
      fail(`supervisor ${sub}: --message "<text>" is required (or one positional message)`);
    }
    if (parsed.positionals.length > 2) fail(`supervisor ${sub}: unexpected positional "${parsed.positionals[2]}"`);
    if (parsed.values.message !== undefined && parsed.positionals.length > 1) {
      fail(`supervisor ${sub}: pass the message either as --message or as one positional, not both`);
    }
    const hasProject = typeof parsed.values.project === "string" && parsed.values.project.trim() !== "";
    const hasWorkspace = typeof parsed.values.workspace === "string" && parsed.values.workspace.trim() !== "";
    if (!hasProject && !hasWorkspace) {
      fail(`supervisor ${sub}: --project <slug> or --workspace <dir> is required — the target Project`);
    }
    if (hasProject && hasWorkspace) {
      fail(`supervisor ${sub}: name exactly one target — --project <slug> or --workspace <dir>`);
    }
    const reply = await roundTrip(
      {
        id: randomId(),
        kind: sub === "dispatch" ? "supervisor_dispatch" : "supervisor_report",
        ...(hasProject ? { project: parsed.values.project.trim() } : {}),
        ...(hasWorkspace ? { workspace: resolvePath(parsed.values.workspace) } : {}),
        message,
      },
      waitSeconds(parsed),
    );
    console.log(`factory: ${reply.summary}`);
    process.exit(0);
  }

  fail(`supervisor: unknown subcommand "${sub ?? "(none)"}" — use "supervisor dispatch --workspace <dir> --message \\"<text>\\"" or "supervisor report --workspace <dir> --message \\"<text>\\""`);
}

if (command === "reset") {
  const parsed = parseCommandOptions({
    workspace: { type: "string" },
    project: { type: "string" },
    "keep-seats": { type: "boolean", default: false },
    "wait-secs": { type: "string" },
  });
  if (parsed.positionals.length > 0) {
    fail(`reset: unexpected positional "${parsed.positionals[0]}"`);
  }
  if (stampedSeat === "supervisor" || stampedSeat === "lead" || stampedSeat === "agent") {
    console.error(
      `factory: seat-cannot-reset: Seat ${stampedSeat} cannot call factory reset; project reset is an Owner-only action.`,
    );
    process.exit(2);
  }
  const hasWorkspace = typeof parsed.values.workspace === "string" && parsed.values.workspace.trim() !== "";
  const hasProject = typeof parsed.values.project === "string" && parsed.values.project.trim() !== "";
  const reply = await roundTrip(
    {
      id: randomId(),
      kind: "reset",
      ...(hasWorkspace ? { workspace: resolvePath(parsed.values.workspace) } : {}),
      ...(hasProject ? { project: parsed.values.project.trim() } : {}),
      ...(parsed.values["keep-seats"] === true ? { keepSeats: true } : {}),
    },
    waitSeconds(parsed),
  );
  console.log(`factory: ${reply.summary}`);
  process.exit(0);
}


if (command === "run") {
  const parsed = parseCommandOptions({
    provider: { type: "string" },
    "wait-secs": { type: "string" },
  });
  const tasks = parsed.positionals;
  if (tasks.length === 0) fail("run: at least one task id is required (factory run <task> [<task>…] [--provider <provider[/model]>])");
  if (stampedSeat === "supervisor") {
    console.error(
      "factory: supervisor-cannot-contract-or-run: Supervisor cannot call factory run; dispatch the directive to Lead via 'factory lead dispatch --workspace <dir> --message <directive>' and end your turn.",
    );
    process.exit(2);
  }
  if (stampedSeat === "agent") {
    console.error(
      "factory: agent-cannot-orchestrate: Working Agent cannot call factory run; working Agents may only submit claims via 'factory-claim --task <task> --sha <sha>'.",
    );
    process.exit(2);
  }
  // v0.0.13 precedence (ADR 0009 §3): explicit --provider wins; omitted
  // resolves through lanes.worker (default pi/zai/glm-5.3) — the resolver's
  // own refusal names a broken lanes.json, never a silent default.
  const provider = typeof parsed.values.provider === "string" && parsed.values.provider.trim() !== "" ? parsed.values.provider.trim() : undefined;
  const resolved = resolveRunProvider(stateDir, provider);
  if (!resolved.ok) fail(`run: ${resolved.reason}`);
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
    provider: resolved.provider,
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

if (command === "vault") {
  // v0.0.21–v0.0.22 (ADR 0014): the Private vault's seven verbs, one JSON
  // object on stdout each (spec §User Story 11). The engine is the CLI's
  // behavioral mirror (plugin/bin/vault.mjs) — the CLIs import no src/ code
  // (ADR 0004); test/vault-cli.test.ts pins the mirror to the core engine.
  // Usage failures go through fail() (usage + exit 2); engine refusals carry
  // the stable vault-* codes on stderr, exit 2, never a partial JSON on stdout.
  const parsed = parseCommandOptions({
    repo: { type: "string" },
    ref: { type: "string" },
    branch: { type: "string" },
    to: { type: "string" },
    passphrase: { type: "string" },
    "include-ledger": { type: "boolean" },
    "merge-ledgers": { type: "boolean" },
    "overwrite-configs": { type: "boolean" },
    "asc-key": { type: "string" },
    "asc-key-id": { type: "string" },
    "asc-issuer": { type: "string" },
    "gplay-key": { type: "string" },
    "eye-config": { type: "string" },
    app: { type: "string" },
    keystore: { type: "string" },
    "store-pass": { type: "string" },
    "key-alias": { type: "string" },
    "firebase-project-id": { type: "string" },
    "google-services-json": { type: "string" },
    "google-service-info-plist": { type: "string" },
    "no-sync": { type: "boolean" },
  });
  const sub = parsed.positionals[0];
  const values = parsed.values;
  const refuseOptions = (verb, allowed) => {
    for (const key of Object.keys(values)) {
      if (!allowed.includes(key)) fail(`vault ${verb}: --${key} is not a ${verb} option`);
    }
  };

  if (sub === undefined) fail("vault: a subcommand is required — status | hydrate | pull | push | seal | sync | import");
  const vault = await import("./vault.mjs");

  try {
    if (sub === "status") {
      if (parsed.positionals.length > 1) fail(`vault status: unexpected positional "${parsed.positionals[1]}"`);
      refuseOptions("status", []);
      // The pure local read (the status/cost lineage): the config file and the
      // runtime probes, no spool round trip, no plugin needed.
      console.log(JSON.stringify(vault.readVaultStatus(home), null, 2));
      process.exit(0);
    }

    if (sub === "hydrate") {
      if (parsed.positionals.length > 1) fail(`vault hydrate: unexpected positional "${parsed.positionals[1]}"`);
      refuseOptions("hydrate", ["repo", "ref", "merge-ledgers", "overwrite-configs"]);
      const result = await vault.hydrateVaultDirect(home, {
        ...(typeof values.repo === "string" && values.repo.trim() !== "" ? { repo: values.repo.trim() } : {}),
        ...(typeof values.ref === "string" && values.ref.trim() !== "" ? { ref: values.ref.trim() } : {}),
        ...(values["merge-ledgers"] ? { mergeLedgers: true } : {}),
        ...(values["overwrite-configs"] ? { overwriteConfigs: true } : {}),
      });
      console.log(JSON.stringify({ ok: true, mode: "direct", repo: result.repo, ref: result.ref, hydratedFiles: result.hydratedFiles, vault: vault.readVaultStatus(home) }, null, 2));
      process.exit(0);
    }

    if (sub === "pull") {
      if (parsed.positionals.length > 1) fail(`vault pull: unexpected positional "${parsed.positionals[1]}"`);
      refuseOptions("pull", ["merge-ledgers", "overwrite-configs"]);
      const result = await vault.pullVault(home, {
        ...(values["merge-ledgers"] ? { mergeLedgers: true } : {}),
        ...(values["overwrite-configs"] ? { overwriteConfigs: true } : {}),
      });
      console.log(JSON.stringify({ ok: true, mode: "sync", hydratedFiles: result.hydratedFiles, vault: vault.readVaultStatus(home) }, null, 2));
      process.exit(0);
    }

    if (sub === "push") {
      if (parsed.positionals.length > 1) fail(`vault push: unexpected positional "${parsed.positionals[1]}"`);
      refuseOptions("push", ["include-ledger"]);
      const result = await vault.pushVault(home, ...(values["include-ledger"] ? [{ includeLedger: true }] : []));
      console.log(JSON.stringify({ ok: true, pushed: result.pushed, pushedFiles: result.pushedFiles, vault: vault.readVaultStatus(home) }, null, 2));
      process.exit(0);
    }

    if (sub === "sync") {
      if (parsed.positionals.length > 1) fail(`vault sync: unexpected positional "${parsed.positionals[1]}"`);
      refuseOptions("sync", ["repo", "branch", "passphrase", "overwrite-configs"]);
      const result = await vault.syncVault(home, {
        ...(typeof values.repo === "string" && values.repo.trim() !== "" ? { repo: values.repo.trim() } : {}),
        ...(typeof values.branch === "string" && values.branch.trim() !== "" ? { branch: values.branch.trim() } : {}),
        ...(typeof values.passphrase === "string" && values.passphrase !== "" ? { passphrase: values.passphrase } : {}),
        ...(values["overwrite-configs"] ? { overwriteConfigs: true } : {}),
      });
      console.log(JSON.stringify({ ok: true, ...result, vault: vault.readVaultStatus(home) }, null, 2));
      process.exit(0);
    }

    if (sub === "import") {
      if (parsed.positionals.length > 1) fail(`vault import: unexpected positional "${parsed.positionals[1]}"`);
      refuseOptions("import", [
        "asc-key",
        "asc-key-id",
        "asc-issuer",
        "gplay-key",
        "eye-config",
        "app",
        "keystore",
        "store-pass",
        "key-alias",
        "firebase-project-id",
        "google-services-json",
        "google-service-info-plist",
        "no-sync",
      ]);
      const result = await vault.importVaultSecrets(home, {
        ...(typeof values["asc-key"] === "string" && values["asc-key"].trim() !== "" ? { ascKeyPath: resolvePath(values["asc-key"].trim()) } : {}),
        ...(typeof values["asc-key-id"] === "string" && values["asc-key-id"].trim() !== "" ? { ascKeyId: values["asc-key-id"].trim() } : {}),
        ...(typeof values["asc-issuer"] === "string" && values["asc-issuer"].trim() !== "" ? { ascIssuer: values["asc-issuer"].trim() } : {}),
        ...(typeof values["gplay-key"] === "string" && values["gplay-key"].trim() !== "" ? { gplayKeyPath: resolvePath(values["gplay-key"].trim()) } : {}),
        ...(typeof values["eye-config"] === "string" && values["eye-config"].trim() !== "" ? { eyeConfigPath: resolvePath(values["eye-config"].trim()) } : {}),
        ...(typeof values.app === "string" && values.app.trim() !== "" ? { appKey: values.app.trim() } : {}),
        ...(typeof values.keystore === "string" && values.keystore.trim() !== "" ? { keystorePath: resolvePath(values.keystore.trim()) } : {}),
        ...(typeof values["store-pass"] === "string" && values["store-pass"] !== "" ? { storePass: values["store-pass"] } : {}),
        ...(typeof values["key-alias"] === "string" && values["key-alias"].trim() !== "" ? { keyAlias: values["key-alias"].trim() } : {}),
        ...(typeof values["firebase-project-id"] === "string" && values["firebase-project-id"].trim() !== ""
          ? { firebaseProjectId: values["firebase-project-id"].trim() }
          : {}),
        ...(typeof values["google-services-json"] === "string" && values["google-services-json"].trim() !== ""
          ? { googleServicesJsonPath: resolvePath(values["google-services-json"].trim()) }
          : {}),
        ...(typeof values["google-service-info-plist"] === "string" && values["google-service-info-plist"].trim() !== ""
          ? { googleServiceInfoPlistPath: resolvePath(values["google-service-info-plist"].trim()) }
          : {}),
        ...(values["no-sync"] ? { syncAfterImport: false } : {}),
      });
      console.log(JSON.stringify({ ok: true, ...result, pushed: result.synced?.pushed ?? false, vault: vault.readVaultStatus(home) }, null, 2));
      process.exit(0);
    }

    if (sub === "seal") {
      refuseOptions("seal", ["to", "passphrase"]);
      const source = parsed.positionals[1];
      if (source === undefined) fail("vault seal: a file is required (factory vault seal <file> --to <vaultPath> [--passphrase <pass>])");
      if (parsed.positionals.length > 2) fail(`vault seal: unexpected positional "${parsed.positionals[2]}"`);
      const vaultPath = typeof values.to === "string" ? values.to.trim() : "";
      if (vaultPath === "") fail("vault seal: --to <vaultPath> is required — the vault-relative path the envelope stages under");
      const segments = vaultPath.split("/");
      if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        fail(`vault seal: refusing unsafe vault path "${vaultPath}"`);
      }
      const sourceAbs = resolvePath(source);
      if (!existsSync(sourceAbs)) fail(`vault seal: ${source} does not exist`);
      const result = vault.sealVaultFile(
        home,
        sourceAbs,
        vaultPath,
        ...(typeof values.passphrase === "string" && values.passphrase !== "" ? [values.passphrase] : []),
      );
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      process.exit(0);
    }

    fail(`vault: unknown subcommand "${sub}" — use "vault status | hydrate | pull | push | seal | sync | import"`);
  } catch (err) {
    const code = err !== null && typeof err === "object" && typeof err.code === "string" ? err.code : "vault-cli-failed";
    die(`vault: ${code}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
        else if (evt.event === "needs_human") counted.needsHuman = evt.reason; // the last one on record — the glance's needs-human marker (v0.0.10)
      }
      continue;
    }
    let state = byTask.get(evt.task);
    if (state === undefined) {
      state = { attempts: 0, verdict: undefined, sha: undefined, eye: undefined, accepted: false, allowed: 0, denied: 0, blocked: 0, needsHuman: undefined };
      byTask.set(evt.task, state);
      order.push(evt.task);
    }
    if (evt.event === "contract_set") {
      if (!state.accepted) {
        state.attempts = 0;
        state.verdict = undefined;
        state.sha = undefined;
        state.eye = undefined;
        state.needsHuman = undefined;
        state.allowed = 0;
        state.denied = 0;
        state.blocked = 0;
      }
      continue;
    }
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
    return (
      `${task} attempts=${s.attempts} verdict=${s.verdict ?? "-"} sha=${s.sha ?? "-"} accepted=${s.accepted ? "yes" : "no"} eye=${s.eye ?? "-"} choke=${s.allowed}/${s.denied}/${s.blocked}` +
      `${s.needsHuman === undefined ? "" : ` needs-human=${s.needsHuman}`}`
    );
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
