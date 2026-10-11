import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { startSpool } from "../plugin/server/spool.ts";
import { copyFixture, disposeDir, eyeAnswer, gitCommitAll, gitCommitChanges, makeTempDir, repoRoot, startFakeEye, writeEyeConfig } from "./helpers.ts";

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

  const noProvider = await run(ownerCli, ["run", "T1"], { PASEO_HOME: home });
  assert.equal(noProvider.status, 2);
  assert.match(noProvider.stderr, /--provider <provider\[\/model\]> is required/);

  const dup = await run(ownerCli, ["run", "T1", "T1", "--provider", "claude"], { PASEO_HOME: home });
  assert.equal(dup.status, 2);
  assert.match(dup.stderr, /task T1 appears twice/);

  const stateDir = join(home, "plugin-state", "paseo-factory");
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
