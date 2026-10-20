import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { startSpool } from "../plugin/server/spool.ts";
import { copyFixture, disposeDir, eyeAnswer, gitCommitAll, gitCommitChanges, makeTempDir, repoRoot, startFakeEye, writeEyeConfig, writeLanes } from "./helpers.ts";

/**
 * The mechanical DoD of ticket 08 without a daemon: the real CLIs
 * (`factory.mjs` for the Owner, `factory-claim.mjs` for the Agent) talk to the
 * real plugin-side spool loop over the same files the daemon would host. This
 * is also the drift guard between the two halves of the spool protocol, which
 * are implemented once in TypeScript and once in plain .mjs.
 */

const claimCli = join(repoRoot, "plugin", "bin", "factory-claim.mjs");
const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async on purpose: a sync spawn would block this process's event loop, and the spool poll lives here. */
function run(script: string, args: string[], extraEnv: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("the whole loop over the spool: contract → red claim → green claim → accept", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  const brokenSha = gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());

  const ownerEnv = { PASEO_HOME: home };
  const agentEnv = { FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "agent-test-1" };

  // The Owner fixes the Workspace in the Contract — the Agent never picks a cwd.
  const contract = await run(ownerCli, [
    "contract", "--task", "LOOP1", "--workspace", workspace, "--gate", "npm test", "--artifact", "src/format.ts",
  ], ownerEnv);
  assert.equal(contract.status, 0, contract.stderr);
  assert.match(contract.stdout, /contract set for LOOP1/);

  // Attempt 1: the agent claims unfinished work — the factory says red, with the note.
  const red = await run(claimCli, ["--task", "LOOP1", "--sha", brokenSha], agentEnv);
  assert.equal(red.status, 1, `red verdict must exit 1\nstdout: ${red.stdout}\nstderr: ${red.stderr}`);
  assert.match(red.stdout, /LOOP1 attempt 1 — RED/);
  assert.match(red.stdout, /report: .*report-LOOP1-1\.md/);
  assert.match(red.stdout, /note: .+fail 2/, "the agent sees the real gate note");

  // The agent fixes the work for real and claims the new commit.
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const fixedSha = gitCommitChanges(workspace, "fix pad to truncate and pad correctly");
  const green = await run(claimCli, ["--task", "LOOP1", "--sha", fixedSha], agentEnv);
  assert.equal(green.status, 0, `green verdict must exit 0\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);
  assert.match(green.stdout, /LOOP1 attempt 2 — GREEN/);

  // The Owner accepts the green attempt; acceptance is not the agent's act.
  const accept = await run(ownerCli, ["accept", "LOOP1", "--attempt", "2"], ownerEnv);
  assert.equal(accept.status, 0, accept.stderr);
  assert.match(accept.stdout, /LOOP1 accepted at attempt 2/);

  const events = factory.ledger.eventsFor("LOOP1").map((e) => e.event);
  assert.deepEqual(events, [
    "contract_set",
    "claim_reported", "gate_started", "gate_finished", "report_written",
    "claim_reported", "gate_started", "gate_finished", "report_written",
    "attempt_accepted",
  ]);
  assert.ok(existsSync(join(stateDir, "report-LOOP1-1.md")));
  assert.ok(existsSync(join(stateDir, "report-LOOP1-2.md")));
  const contractEvent = factory.ledger.eventsFor("LOOP1")[0];
  assert.equal(contractEvent.event === "contract_set" ? contractEvent.workspace : undefined, workspace);
  // v0.0.9: the human path stamps `owner` on both Owner acts (ADR 0006) —
  // the CLI's env carries no PASEO_AGENT_ID, so that is what rides.
  assert.equal(contractEvent.event === "contract_set" ? contractEvent.by : undefined, "owner");
  const acceptedEvent = factory.ledger.eventsFor("LOOP1").find((e) => e.event === "attempt_accepted");
  assert.equal(acceptedEvent === undefined ? undefined : acceptedEvent.accepted_by, "owner");
});

test("the delegated Owner seat's env stamps its id on both acts (v0.0.9)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace); // init the repo; this broken commit is never claimed
  // Green at HEAD from the first claim — this loop proves the stamp, not the gate.
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const sha = gitCommitChanges(workspace, "already green");
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());

  // The Supervisor's mechanical path: the same Owner CLI, its shell carrying
  // the daemon's PASEO_AGENT_ID — the stamp must be the seat's own id.
  const seatEnv = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-supervisor-1" };
  const contract = await run(ownerCli, [
    "contract", "--task", "SEAT1", "--workspace", workspace, "--gate", "npm test", "--artifact", "src/format.ts",
  ], seatEnv);
  assert.equal(contract.status, 0, contract.stderr);
  assert.match(contract.stdout, /contract set for SEAT1: .* by agent-supervisor-1/);

  const green = await run(claimCli, ["--task", "SEAT1", "--sha", sha], { FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "agent-worker-1" });
  assert.equal(green.status, 0, `expected green\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);

  const accept = await run(ownerCli, ["accept", "SEAT1", "--attempt", "1"], seatEnv);
  assert.equal(accept.status, 0, accept.stderr);
  assert.match(accept.stdout, /SEAT1 accepted at attempt 1 by agent-supervisor-1/);

  const set = factory.ledger.eventsFor("SEAT1")[0];
  assert.equal(set.event === "contract_set" ? set.by : undefined, "agent-supervisor-1");
  const accepted = factory.ledger.eventsFor("SEAT1").find((e) => e.event === "attempt_accepted");
  assert.equal(accepted === undefined ? undefined : accepted.accepted_by, "agent-supervisor-1");

  // A blank PASEO_AGENT_ID counts as absent — the human-path stamp, not an
  // empty one the spool would refuse.
  const blank = await run(ownerCli, [
    "contract", "--task", "SEAT2", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts",
  ], { PASEO_HOME: home, PASEO_AGENT_ID: "  " });
  assert.equal(blank.status, 0, blank.stderr);
  const set2 = factory.ledger.eventsFor("SEAT2")[0];
  assert.equal(set2.event === "contract_set" ? set2.by : undefined, "owner");
});

test("a claim the factory rejects comes back as an error exit with the reason", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());

  const rejected = await run(claimCli, ["--task", "NOPE", "--sha", "a1b2c3d"], { FACTORY_STATE_DIR: stateDir });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /no contract set for task NOPE/);
});

test("the owner CLI refuses bad usage before submitting anything", async () => {
  const noTask = await run(ownerCli, ["contract", "--workspace", "/w", "--gate", "true", "--artifact", "a"], {});
  assert.equal(noTask.status, 2);
  assert.match(noTask.stderr, /--task is required/);

  const badAttempt = await run(ownerCli, ["accept", "T1", "--attempt", "zero"], {});
  assert.equal(badAttempt.status, 2);
  assert.match(badAttempt.stderr, /--attempt must be a positive integer/);

  const unknown = await run(ownerCli, ["teleport"], {});
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command "teleport"/);
});

test("factory lead rotate: usage refusals, then the spool round trip names the retired agent (v0.0.14)", async (t) => {
  // Usage refusals fire before any submission.
  const noSub = await run(ownerCli, ["lead", "rotate"], {});
  assert.equal(noSub.status, 2);
  assert.match(noSub.stderr, /--project <dir> is required/);
  const badSub = await run(ownerCli, ["lead", "teleport", "--project", "/w"], {});
  assert.equal(badSub.status, 2);
  assert.match(badSub.stderr, /unknown subcommand "teleport"/);

  // The round trip: a real git project, a running spool with a rotation
  // handler wired the way index.server.ts wires it (the surface handlers'
  // leadRotate over the daemon).
  const dir = makeTempDir();
  disposeDir(t, dir);
  const projectRoot = join(dir, "repo");
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, "README.md"), "x\n");
  gitCommitAll(projectRoot);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });
  const rotated: string[] = [];
  const spool = startSpool(stateDir, factory, {
    pollMs: 20,
    leadRotate: async (request) => {
      rotated.push(request.projectRoot);
      return { id: request.id, ok: true, summary: "lead rotated — agent agent-lead-7 cancelled + archived", agentId: "agent-lead-7" };
    },
  });
  t.after(() => spool.stop());

  const reply = await run(ownerCli, ["--home", home, "lead", "rotate", "--project", projectRoot, "--wait-secs", "10"], {});
  assert.equal(reply.status, 0, reply.stderr);
  assert.match(reply.stdout, /lead rotated — agent agent-lead-7 cancelled \+ archived/);
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0], projectRoot, "the resolved project root rode the spool request");

  // A handler refusal (say, no live Lead) reaches the terminal as its code.
  spool.stop();
  const refusing = startSpool(stateDir, factory, {
    pollMs: 20,
    leadRotate: async (request) => ({ id: request.id, ok: false, code: "no-lead", message: "no live seat=lead agent on this daemon" }),
  });
  t.after(() => refusing.stop());
  const refused = await run(ownerCli, ["--home", home, "lead", "rotate", "--project", projectRoot, "--wait-secs", "10"], {});
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /no-lead: no live seat=lead agent/);
});

test("factory lead dispatch: usage refusals, then the spool round trip prints the queued mail's facts (v0.0.20)", async (t) => {
  // Usage refusals fire before any submission.
  const noTarget = await run(ownerCli, ["lead", "dispatch", "--message", "x"], {});
  assert.equal(noTarget.status, 2);
  assert.match(noTarget.stderr, /--project <slug> or --workspace <dir> is required/);
  const noMessage = await run(ownerCli, ["lead", "dispatch", "--project", "demo-slug"], {});
  assert.equal(noMessage.status, 2);
  assert.match(noMessage.stderr, /--message/);

  // The round trip: a real home, a spool with a dispatch handler wired the way
  // index.server.ts wires it (the Lead-mailbox runtime's dispatchLead).
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });
  const dispatched: Record<string, unknown>[] = [];
  const spool = startSpool(stateDir, factory, {
    pollMs: 20,
    leadDispatch: async (request) => {
      dispatched.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: "dispatched to the lead of demo-slug — agent=agent-lead-9 mail=mail-1 rotation=normal",
        project: "demo-slug",
        leadAgentId: "agent-lead-9",
        mailId: "mail-1",
        rotationState: "normal",
      };
    },
  });
  t.after(() => spool.stop());

  const reply = await run(ownerCli, ["--home", home, "lead", "dispatch", "--project", "demo-slug", "--message", "Ship the roadmap", "--wait-secs", "10"], {});
  assert.equal(reply.status, 0, reply.stderr);
  assert.match(reply.stdout, /dispatched to the lead of demo-slug/);
  assert.match(reply.stdout, /agent=agent-lead-9/);
  assert.match(reply.stdout, /mail=mail-1/);
  assert.match(reply.stdout, /rotation=normal/);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.kind, "lead_dispatch");
  assert.equal(dispatched[0]?.project, "demo-slug");
  assert.equal(dispatched[0]?.message, "Ship the roadmap");
  assert.equal("workspace" in (dispatched[0] ?? {}), false, "no workspace rode the slug form");
  assert.equal("from" in (dispatched[0] ?? {}), false, "the CLI leaves `from` to the plugin's owner default");

  // The one positional message rides in place of --message (the spec's "or one
  // positional message" form).
  const positional = await run(ownerCli, ["--home", home, "lead", "dispatch", "--project", "demo-slug", "Do the thing", "--wait-secs", "10"], {});
  assert.equal(positional.status, 0, positional.stderr);
  assert.equal(dispatched[1]?.message, "Do the thing");
});

test("factory-claim usage: --help exits 0, a missing --sha exits 2", async () => {
  const help = await run(claimCli, ["--help"], {});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: factory-claim --task <id> --sha <commit-sha>/);

  const bad = await run(claimCli, ["--task", "T1"], {});
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--task and --sha are both required/);
});

test("a claim with no plugin answering times out honestly and exits 2", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");

  const result = await run(claimCli, ["--task", "T1", "--sha", "abc", "--wait-secs", "1"], { FACTORY_STATE_DIR: stateDir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no reply from the factory plugin/);
  assert.match(result.stderr, /do not resubmit/);
  assert.ok(existsSync(join(stateDir, "spool", "requests")), "the request is durably queued, not lost");
});

test("the loop with --fresh-eyes: the eye's line lands through the real CLIs and spool", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  const brokenSha = gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const fake = await startFakeEye(t, () => ({
    status: 200,
    payload: eyeAnswer("CLEAR\nthe fix matches the contract; nothing to add."),
  }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());

  const ownerEnv = { PASEO_HOME: home };
  const agentEnv = { FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "agent-eye-1" };

  // A marked contract without eye.json would fail fast; with it, the flag rides.
  const contract = await run(ownerCli, [
    "contract", "--task", "LOOP2", "--workspace", workspace, "--gate", "npm test", "--artifact", "src/format.ts", "--fresh-eyes",
  ], ownerEnv);
  assert.equal(contract.status, 0, contract.stderr);
  assert.match(contract.stdout, /fresh eyes ON/);

  // The red attempt never asks the eye.
  const red = await run(claimCli, ["--task", "LOOP2", "--sha", brokenSha], agentEnv);
  assert.equal(red.status, 1);
  assert.equal(fake.requests.length, 0, "red verdicts never call the eye");

  // The real fix: green, and the eye reads contract + diff + gate output.
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const fixedSha = gitCommitChanges(workspace, "fix pad to truncate and pad correctly");
  const green = await run(claimCli, ["--task", "LOOP2", "--sha", fixedSha], agentEnv);
  assert.equal(green.status, 0, `expected green\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);

  assert.equal(fake.requests.length, 1, "one green attempt, one eye pass");
  const prompt = (fake.requests[0]!.body as { messages: { content: string }[] }).messages[0]!.content;
  assert.ok(prompt.includes("Task: LOOP2"));
  assert.ok(prompt.includes("src/format.ts"), "the diff is in the bundle");

  const events = factory.ledger.eventsFor("LOOP2").map((e) => e.event);
  assert.deepEqual(events, [
    "contract_set",
    "claim_reported", "gate_started", "gate_finished", "report_written",
    "claim_reported", "gate_started", "gate_finished", "fresh_eyes_written", "report_written",
  ]);
  const claim = factory.ledger.eventsFor("LOOP2").filter((e) => e.event === "claim_reported").at(-1);
  assert.equal((claim as { agent?: string }).agent, "agent-eye-1", "the spool stamps the submitter (ticket 02b)");
  const report = readFileSync(join(stateDir, "report-LOOP2-2.md"), "utf8");
  assert.ok(report.includes("- Claimed by agent `agent-eye-1`"));
  assert.ok(report.includes("- Fresh eyes (`fake-eye-1`) — CLEAR: the fix matches the contract; nothing to add."));
  assert.ok(existsSync(join(stateDir, "gate-LOOP2-2.log")), "the full gate output is persisted (ticket 02a)");
});

test("factory run refuses bad usage before touching the spool or the daemon", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");

  const noTasks = await run(ownerCli, ["run", "--provider", "claude"], { PASEO_HOME: home });
  assert.equal(noTasks.status, 2);
  assert.match(noTasks.stderr, /run: at least one task id is required/);

  // v0.0.13 (ADR 0009 §3): --provider is optional — omitted resolves through
  // lanes.worker, and this home has no daemon to reach, so the refusal is the
  // daemon's, after the lane resolved and before any spool request.
  const noDaemon = await run(ownerCli, ["run", "T1"], { PASEO_HOME: home });
  assert.equal(noDaemon.status, 2);
  assert.match(noDaemon.stdout, /cannot reach the daemon/); // the driver's banner path — stdout, not stderr

  // A broken lanes.json is the one remaining usage refusal on the run path.
  const stateDir = join(home, "plugin-state", "paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "lanes.json"), "{ broken");
  const brokenLanes = await run(ownerCli, ["run", "T1"], { PASEO_HOME: home });
  assert.equal(brokenLanes.status, 2);
  assert.match(brokenLanes.stderr, /lanes\.json is not valid JSON/);

  const dup = await run(ownerCli, ["run", "T1", "T1", "--provider", "claude"], { PASEO_HOME: home });
  assert.equal(dup.status, 2);
  assert.match(dup.stderr, /task T1 appears twice/);

  assert.ok(!existsSync(join(stateDir, "spool", "requests")), "no request was submitted for refused usage");
});

test("the v0.0.6 contract flags round-trip: --watch marks the pass, --description rides the line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const factory = createFactory({ stateDir, watchCopilotProbe: () => true }); // --watch fail-fasts without a usable copilot CLI
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());
  const ownerEnv = { PASEO_HOME: home };

  const contract = await run(
    ownerCli,
    [
      "contract", "--task", "RIDER1", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts",
      "--watch", "--description", "Tighten the pad helper's truncation edge case.",
    ],
    ownerEnv,
  );
  assert.equal(contract.status, 0, contract.stderr);
  assert.match(contract.stdout, /contract set for RIDER1/);
  assert.match(contract.stdout, /watch ON/);

  const set = factory.ledger.eventsFor("RIDER1")[0];
  assert.equal(set.event === "contract_set" ? set.watch : undefined, true, "the mark is Contract data");
  assert.equal(set.event === "contract_set" ? set.description : undefined, "Tighten the pad helper's truncation edge case.");

  // --watch without a usable copilot CLI is refused loudly, before any line.
  const home2 = join(dir, "paseo-home2");
  const stateDir2 = join(home2, "plugin-state", "paseo-factory");
  writeLanes(stateDir2, { watch: "copilot/gpt-5.4" }); // the lane under test — its CLI is what the message names
  const factory2 = createFactory({ stateDir: stateDir2, watchCopilotProbe: () => false });
  const spool2 = startSpool(stateDir2, factory2);
  t.after(() => spool2.stop());
  const refused = await run(
    ownerCli,
    ["contract", "--task", "RIDER2", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts", "--watch"],
    { PASEO_HOME: home2 },
  );
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /copilot CLI/);
  assert.deepEqual([...factory2.ledger.events], [], "no line for the refused contract");

  // An empty --description is a usage error, not a silent blank.
  const blank = await run(
    ownerCli,
    ["contract", "--task", "RIDER3", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts", "--description", "  "],
    { PASEO_HOME: home },
  );
  assert.equal(blank.status, 2);
  assert.match(blank.stderr, /--description must be a non-empty text/);
});

test("the v0.0.14 contract flag round-trip: --skills rides the spool onto the contract_set line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);

  // One home per sub-case: one contract per tree, and the workspace-conflict
  // guard fires on the second contract of the same tree (its own law).
  const spawnHome = () => {
    const home = join(dir, `paseo-home-${Math.random().toString(36).slice(2, 8)}`);
    const stateDir = join(home, "plugin-state", "paseo-factory");
    const factory = createFactory({ stateDir });
    const spool = startSpool(stateDir, factory);
    t.after(() => spool.stop());
    return { home, stateDir, factory };
  };

  const first = spawnHome();
  const contract = await run(
    ownerCli,
    [
      "contract", "--task", "SKILL1", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts",
      "--skills", "tdd, diagnosing-bugs ,",
    ],
    { PASEO_HOME: first.home },
  );
  assert.equal(contract.status, 0, contract.stderr);
  assert.match(contract.stdout, /contract set for SKILL1/);

  const set = first.factory.ledger.eventsFor("SKILL1")[0];
  assert.deepEqual(
    set.event === "contract_set" ? set.skills : undefined,
    ["tdd", "diagnosing-bugs"],
    "comma-split, trimmed, blanks dropped — scope's own parsing law",
  );

  // Omitted flag omits the field, never an empty array.
  const second = spawnHome();
  const plain = await run(
    ownerCli,
    ["contract", "--task", "SKILL2", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts"],
    { PASEO_HOME: second.home },
  );
  assert.equal(plain.status, 0, plain.stderr);
  const set2 = second.factory.ledger.eventsFor("SKILL2")[0];
  assert.equal("skills" in set2, false);

  // A skills value with only blanks parses to no skills at all — the field
  // stays omitted, same as an omitted flag.
  const third = spawnHome();
  const blankOnly = await run(
    ownerCli,
    ["contract", "--task", "SKILL3", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts", "--skills", " ,"],
    { PASEO_HOME: third.home },
  );
  assert.equal(blankOnly.status, 0, blankOnly.stderr);
  const set3 = third.factory.ledger.eventsFor("SKILL3")[0];
  assert.equal("skills" in set3, false);
});

test("factory accept --by <seat>: the flag rides the spool; the Lead's rules answer at the CLI (v0.0.14)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const sha = gitCommitChanges(workspace, "already green");
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const fake = await startFakeEye(t, () => ({
    status: 200,
    payload: eyeAnswer("CONCERN\nthe diff touches nothing the contract gated."),
  }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());
  const ownerEnv = { PASEO_HOME: home };
  const agentEnv = { FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "agent-worker-1" };

  const contract = await run(ownerCli, [
    "contract", "--task", "SEAT2", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts", "--fresh-eyes",
  ], ownerEnv);
  assert.equal(contract.status, 0, contract.stderr);
  const green = await run(claimCli, ["--task", "SEAT2", "--sha", sha], agentEnv);
  assert.equal(green.status, 0, `expected green\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);
  assert.equal(fake.requests.length, 1, "the eye ran on the green attempt");

  // The Lead may not accept its own CONCERN-flagged attempt.
  const leadRefused = await run(ownerCli, ["accept", "SEAT2", "--attempt", "1", "--by", "lead"], ownerEnv);
  assert.equal(leadRefused.status, 2);
  assert.match(leadRefused.stderr, /lead-accept-refused/);
  assert.match(leadRefused.stderr, /CONCERN/);
  assert.equal(factory.ledger.eventsFor("SEAT2").some((e) => e.event === "attempt_accepted"), false, "no line for the refused act");

  // The usage guard: --by takes exactly the three seats.
  const badSeat = await run(ownerCli, ["accept", "SEAT2", "--attempt", "1", "--by", "boss"], ownerEnv);
  assert.equal(badSeat.status, 2);
  assert.match(badSeat.stderr, /--by must be one of owner\|supervisor\|lead/);

  // The Supervisor's word lands over the same evidence, stamped by the flag.
  const supervisor = await run(ownerCli, ["accept", "SEAT2", "--attempt", "1", "--by", "supervisor"], ownerEnv);
  assert.equal(supervisor.status, 0, supervisor.stderr);
  assert.match(supervisor.stdout, /SEAT2 accepted at attempt 1 by supervisor/);
  const accepted = factory.ledger.eventsFor("SEAT2").find((e) => e.event === "attempt_accepted");
  assert.equal(accepted === undefined ? undefined : accepted.accepted_by, "supervisor");

  // And the Lead's clean acceptance on a CONCERN-free attempt.
  const home2 = join(dir, "paseo-home2");
  const stateDir2 = join(home2, "plugin-state", "paseo-factory");
  const factory2 = createFactory({ stateDir: stateDir2 });
  const spool2 = startSpool(stateDir2, factory2);
  t.after(() => spool2.stop());
  const contract2 = await run(ownerCli, [
    "contract", "--task", "SEAT3", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts",
  ], { PASEO_HOME: home2 });
  assert.equal(contract2.status, 0, contract2.stderr);
  const green2 = await run(claimCli, ["--task", "SEAT3", "--sha", sha], { FACTORY_STATE_DIR: stateDir2, PASEO_AGENT_ID: "agent-worker-2" });
  assert.equal(green2.status, 0, green2.stderr);
  const lead = await run(ownerCli, ["accept", "SEAT3", "--attempt", "1", "--by", "lead"], { PASEO_HOME: home2 });
  assert.equal(lead.status, 0, lead.stderr);
  assert.match(lead.stdout, /SEAT3 accepted at attempt 1 by lead/);
  const accepted2 = factory2.ledger.eventsFor("SEAT3").find((e) => e.event === "attempt_accepted");
  assert.equal(accepted2 === undefined ? undefined : accepted2.accepted_by, "lead");
});

test("factory CLI stamps PASEO_FACTORY_SEAT onto spool requests and enforces seat command authority (v0.0.23, ADR 0015 §1)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const sha = gitCommitChanges(workspace, "green implementation");
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const factory = createFactory({ stateDir });
  const dispatched: Record<string, unknown>[] = [];
  const spool = startSpool(stateDir, factory, {
    pollMs: 20,
    leadDispatch: async (request) => {
      dispatched.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: "dispatched to lead",
        project: "workspace",
        leadAgentId: "agent-lead-1",
        mailId: "mail-1",
        rotationState: "normal",
      };
    },
  });
  t.after(() => spool.stop());

  const supEnv = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-sup-1", PASEO_FACTORY_SEAT: "supervisor" };
  const leadEnv = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-lead-1", PASEO_FACTORY_SEAT: "lead" };
  const workerEnv = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-worker-1", PASEO_FACTORY_SEAT: "agent" };

  // Supervisor calling `factory contract` is refused with supervisor-cannot-contract-or-run.
  const supContract = await run(
    ownerCli,
    ["contract", "--task", "T-AUTH", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts"],
    supEnv,
  );
  assert.equal(supContract.status, 2);
  assert.match(supContract.stderr, /supervisor-cannot-contract-or-run/);
  assert.match(supContract.stderr, /factory lead dispatch/);
  assert.equal(factory.ledger.eventsFor("T-AUTH").length, 0, "no contract_set written when Supervisor is refused");

  // Supervisor calling `factory run` is refused with supervisor-cannot-contract-or-run.
  const supRun = await run(ownerCli, ["run", "T-AUTH"], supEnv);
  assert.equal(supRun.status, 2);
  assert.match(supRun.stderr, /supervisor-cannot-contract-or-run/);

  // Supervisor CAN call `factory lead dispatch`, and its seat stamp rides the request.
  const supDispatch = await run(ownerCli, ["lead", "dispatch", "--workspace", workspace, "--message", "Build T-AUTH"], supEnv);
  assert.equal(supDispatch.status, 0, supDispatch.stderr);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.seat, "supervisor");

  // Lead CAN call `factory contract`.
  const leadContract = await run(
    ownerCli,
    ["contract", "--task", "T-AUTH", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts"],
    leadEnv,
  );
  assert.equal(leadContract.status, 0, leadContract.stderr);

  // Working Agent (PASEO_FACTORY_SEAT=agent) is refused on contract, run, accept, lead dispatch, lead rotate.
  const agContract = await run(
    ownerCli,
    ["contract", "--task", "T-AG", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts"],
    workerEnv,
  );
  assert.equal(agContract.status, 2);
  assert.match(agContract.stderr, /agent-cannot-orchestrate/);

  const agRun = await run(ownerCli, ["run", "T-AUTH"], workerEnv);
  assert.equal(agRun.status, 2);
  assert.match(agRun.stderr, /agent-cannot-orchestrate/);

  const agDispatch = await run(ownerCli, ["lead", "dispatch", "--workspace", workspace, "--message", "no"], workerEnv);
  assert.equal(agDispatch.status, 2);
  assert.match(agDispatch.stderr, /agent-cannot-orchestrate/);

  const agRotate = await run(ownerCli, ["lead", "rotate", "--project", workspace], workerEnv);
  assert.equal(agRotate.status, 2);
  assert.match(agRotate.stderr, /agent-cannot-orchestrate/);

  // Working Agent CAN claim via factory-claim.
  const claimed = await run(claimCli, ["--task", "T-AUTH", "--sha", sha], {
    FACTORY_STATE_DIR: stateDir,
    PASEO_AGENT_ID: "agent-worker-1",
    PASEO_FACTORY_SEAT: "agent",
  });
  assert.equal(claimed.status, 0, claimed.stderr);

  // Working Agent still cannot accept its own green attempt.
  const agAccept = await run(ownerCli, ["accept", "T-AUTH", "--attempt", "1"], workerEnv);
  assert.equal(agAccept.status, 2);
  assert.match(agAccept.stderr, /agent-cannot-orchestrate/);

  // Supervisor CAN accept --by supervisor on the Owner's word.
  const supAccept = await run(ownerCli, ["accept", "T-AUTH", "--attempt", "1", "--by", "supervisor"], supEnv);
  assert.equal(supAccept.status, 0, supAccept.stderr);
});

test("factory supervisor dispatch and factory supervisor report: usage refusals, seat routing, and spool round trip (v0.0.23, ADR 0015 §3/§5)", async (t) => {
  // Usage refusals before any submission.
  const noTargetDispatch = await run(ownerCli, ["supervisor", "dispatch", "--message", "x"], {});
  assert.equal(noTargetDispatch.status, 2);
  assert.match(noTargetDispatch.stderr, /--project <slug> or --workspace <dir> is required/);

  const noMsgDispatch = await run(ownerCli, ["supervisor", "dispatch", "--project", "demo-slug"], {});
  assert.equal(noMsgDispatch.status, 2);
  assert.match(noMsgDispatch.stderr, /--message/);

  const noTargetReport = await run(ownerCli, ["supervisor", "report", "--message", "wave green"], {});
  assert.equal(noTargetReport.status, 2);
  assert.match(noTargetReport.stderr, /--project <slug> or --workspace <dir> is required/);

  const noMsgReport = await run(ownerCli, ["supervisor", "report", "--project", "demo-slug"], {});
  assert.equal(noMsgReport.status, 2);
  assert.match(noMsgReport.stderr, /--message/);

  const badSub = await run(ownerCli, ["supervisor", "teleport", "--project", "demo-slug"], {});
  assert.equal(badSub.status, 2);
  assert.match(badSub.stderr, /unknown subcommand "teleport"/);

  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "repo");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "x\n");
  gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });

  const supDispatched: Record<string, unknown>[] = [];
  const leadDispatched: Record<string, unknown>[] = [];
  const supReported: Record<string, unknown>[] = [];

  const spool = startSpool(stateDir, factory, {
    pollMs: 20,
    leadDispatch: async (request) => {
      leadDispatched.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: "dispatched to the lead of repo",
        project: "repo",
        leadAgentId: "agent-lead-1",
        mailId: "mail-lead-1",
        rotationState: "normal",
      };
    },
    supervisorDispatch: async (request) => {
      if (request.seat === "supervisor") {
        leadDispatched.push({ ...request, kind: "lead_dispatch", from: "supervisor" });
        return {
          id: request.id,
          ok: true,
          summary: "directive dispatched to Lead (agent-lead-1) — end your turn now and wait for Lead's report",
          project: "repo",
          leadAgentId: "agent-lead-1",
          mailId: "mail-lead-1",
          rotationState: "normal",
        };
      }
      supDispatched.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: "directive routed to Supervisor (agent-sup-1) — stop this turn immediately without editing files and open the Supervisor session",
        project: "repo",
        supervisorAgentId: "agent-sup-1",
        mailId: "mail-sup-1",
      };
    },
    supervisorReport: async (request) => {
      supReported.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: "report queued for Supervisor (agent-sup-1) — end your turn",
        project: "repo",
        supervisorAgentId: "agent-sup-1",
        mailId: "mail-rep-1",
      };
    },
  });
  t.after(() => spool.stop());

  // 1. Normal chat (PASEO_FACTORY_SEAT unset): routes to Supervisor.
  const chatDispatch = await run(
    ownerCli,
    ["--home", home, "supervisor", "dispatch", "--workspace", workspace, "--message", "Build 2048", "--wait-secs", "10"],
    {},
  );
  assert.equal(chatDispatch.status, 0, chatDispatch.stderr);
  assert.match(chatDispatch.stdout, /directive routed to Supervisor \(agent-sup-1\)/);
  assert.match(chatDispatch.stdout, /stop this turn immediately without editing files/);
  assert.equal(supDispatched.length, 1);
  assert.equal(supDispatched[0]?.kind, "supervisor_dispatch");
  assert.equal(supDispatched[0]?.workspace, workspace);
  assert.equal(supDispatched[0]?.message, "Build 2048");
  assert.equal(supDispatched[0]?.submitter, "owner");

  // 2. Inside Supervisor (PASEO_FACTORY_SEAT=supervisor): routes to Lead.
  const fromSupDispatch = await run(
    ownerCli,
    ["--home", home, "supervisor", "dispatch", "--workspace", workspace, "--message", "Ship wave 1", "--wait-secs", "10"],
    { PASEO_FACTORY_SEAT: "supervisor", PASEO_AGENT_ID: "agent-sup-1" },
  );
  assert.equal(fromSupDispatch.status, 0, fromSupDispatch.stderr);
  assert.match(fromSupDispatch.stdout, /directive dispatched to Lead \(agent-lead-1\)/);
  assert.match(fromSupDispatch.stdout, /end your turn now and wait for Lead's report/);
  assert.equal(leadDispatched.length, 1);
  assert.equal(leadDispatched[0]?.seat, "supervisor");
  assert.equal(leadDispatched[0]?.submitter, "agent-sup-1");

  // 3. Lead calling `factory supervisor report`: queues report for Supervisor.
  const leadReport = await run(
    ownerCli,
    ["--home", home, "supervisor", "report", "--workspace", workspace, "--message", "Wave 1 accepted and landed", "--wait-secs", "10"],
    { PASEO_FACTORY_SEAT: "lead", PASEO_AGENT_ID: "agent-lead-1" },
  );
  assert.equal(leadReport.status, 0, leadReport.stderr);
  assert.match(leadReport.stdout, /report queued for Supervisor \(agent-sup-1\) — end your turn/);
  assert.equal(supReported.length, 1);
  assert.equal(supReported[0]?.kind, "supervisor_report");
  assert.equal(supReported[0]?.seat, "lead");
  assert.equal(supReported[0]?.submitter, "agent-lead-1");
  assert.equal(supReported[0]?.message, "Wave 1 accepted and landed");

  // 4. Working Agent calling `factory supervisor dispatch` or `factory supervisor report` is refused.
  const agSupDispatch = await run(
    ownerCli,
    ["--home", home, "supervisor", "dispatch", "--workspace", workspace, "--message", "nope", "--wait-secs", "10"],
    { PASEO_FACTORY_SEAT: "agent", PASEO_AGENT_ID: "agent-worker-1" },
  );
  assert.equal(agSupDispatch.status, 2);
  assert.match(agSupDispatch.stderr, /agent-cannot-orchestrate/);

  const agSupReport = await run(
    ownerCli,
    ["--home", home, "supervisor", "report", "--workspace", workspace, "--message", "nope", "--wait-secs", "10"],
    { PASEO_FACTORY_SEAT: "agent", PASEO_AGENT_ID: "agent-worker-1" },
  );
  assert.equal(agSupReport.status, 2);
  assert.match(agSupReport.stderr, /agent-cannot-orchestrate/);
});

test("factory reset CLI: refuses supervisor/lead/agent with seat-cannot-reset and executes owner reset via spool (v0.0.24, ADR 0015 §6)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "repo");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "x\n");
  gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });

  const resets: Record<string, unknown>[] = [];
  const spool = startSpool(stateDir, factory, {
    pollMs: 20,
    projectReset: async (request) => {
      resets.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: `project repo reset (2 events across 1 task purged, 2 files removed, 1 seat archived)`,
        project: "repo",
        purgedEvents: 2,
        tasks: ["T1"],
        removedFiles: 2,
        archivedSeats: ["lead:lead-1"],
        archivedAgents: [],
      };

    },
  });
  t.after(() => spool.stop());

  for (const seat of ["supervisor", "lead", "agent"] as const) {
    const refused = await run(
      ownerCli,
      ["--home", home, "reset", "--workspace", workspace, "--wait-secs", "5"],
      { PASEO_FACTORY_SEAT: seat, PASEO_AGENT_ID: `agent-${seat}-1` },
    );
    assert.equal(refused.status, 2, `expected ${seat} to exit 2`);
    assert.match(refused.stderr, /seat-cannot-reset/);
  }
  assert.equal(resets.length, 0);

  const ownerReset = await run(
    ownerCli,
    ["--home", home, "reset", "--workspace", workspace, "--keep-seats", "--wait-secs", "10"],
    {},
  );
  assert.equal(ownerReset.status, 0, ownerReset.stderr);
  assert.match(ownerReset.stdout, /project repo reset/);
  assert.equal(resets.length, 1);
  assert.equal(resets[0]?.kind, "reset");
  assert.equal(resets[0]?.workspace, workspace);
  assert.equal(resets[0]?.keepSeats, true);
  assert.equal(resets[0]?.submitter, "owner");
});


