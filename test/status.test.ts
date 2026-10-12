import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { startSpool } from "../plugin/server/spool.ts";
import { EVENT_NAMES } from "../src/events.ts";
import { copyFixture, disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

/**
 * `factory status` — the Owner's read-only glance at the ledger. Unlike
 * contract/accept it never goes through the spool: it reads
 * `<home>/plugin-state/paseo-factory/ledger.jsonl` directly, so these tests
 * exercise it against a real ledger the spool loop wrote, and against
 * hand-written ledgers for the shapes the loop does not produce on demand.
 */

const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");
const claimCli = join(repoRoot, "plugin", "bin", "factory-claim.mjs");

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

const ts = "2026-10-07T09:00:00.000Z";

function contractEvent(seq: number, task: string): Record<string, unknown> {
  return { seq, ts, event: "contract_set", task, workspace: "/tmp/ws", gate: "true", artifact: "src/format.ts" };
}

function writeLedger(stateDir: string, events: Record<string, unknown>[]): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

test("the status reader's event vocabulary is in sync with src/events.ts", () => {
  const cli = readFileSync(join(repoRoot, "plugin", "bin", "factory.mjs"), "utf8");
  const match = cli.match(/^const EVENT_NAMES = \[(.*)\];$/m);
  assert.ok(match, "factory.mjs keeps EVENT_NAMES on one line for this drift guard");
  assert.deepEqual(JSON.parse(`[${match![1]}]`), [...EVENT_NAMES]);
});

test("status tracks a whole loop: contract → red claim → green claim → accept", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  const baseSha = gitCommitAll(workspace); // the fixture's own commit — the tree is clean at it
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());

  const ownerEnv = { PASEO_HOME: home };
  const agentEnv = { FACTORY_STATE_DIR: stateDir };

  // Before anything has happened there are no task lines — and no error.
  const fresh = await run(ownerCli, ["status"], ownerEnv);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /no tasks yet/);

  const contract = await run(ownerCli, [
    "contract", "--task", "LOOP9", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts",
  ], ownerEnv);
  assert.equal(contract.status, 0, contract.stderr);

  // A contract with no attempts yet: counts start at zero, nothing to show.
  const idle = await run(ownerCli, ["status"], ownerEnv);
  assert.equal(idle.status, 0, idle.stderr);
  assert.equal(idle.stdout, "LOOP9 attempts=0 verdict=- sha=- accepted=no eye=- choke=0/0/0\n");

  // Attempt 1: a claim whose sha resolves to nothing is red before the gate
  // even runs — so this attempt has no attested sha to show.
  const red = await run(claimCli, ["--task", "LOOP9", "--sha", "deadbeef", "--wait-secs", "60"], agentEnv);
  assert.equal(red.status, 1, `expected red\nstdout: ${red.stdout}\nstderr: ${red.stderr}`);
  const afterRed = await run(ownerCli, ["status"], ownerEnv);
  assert.equal(afterRed.status, 0, afterRed.stderr);
  assert.equal(afterRed.stdout, "LOOP9 attempts=1 verdict=red sha=- accepted=no eye=- choke=0/0/0\n");

  // Attempt 2: the real commit — green, and the verdict attests it (short sha).
  const green = await run(claimCli, ["--task", "LOOP9", "--sha", baseSha, "--wait-secs", "60"], agentEnv);
  assert.equal(green.status, 0, `expected green\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);
  const afterGreen = await run(ownerCli, ["status"], ownerEnv);
  assert.equal(afterGreen.status, 0, afterGreen.stderr);
  assert.equal(afterGreen.stdout, `LOOP9 attempts=2 verdict=green sha=${baseSha.slice(0, 7)} accepted=no eye=- choke=0/0/0\n`);

  // Acceptance is the Owner's act; status shows its effect on the task.
  const accept = await run(ownerCli, ["accept", "LOOP9", "--attempt", "2"], ownerEnv);
  assert.equal(accept.status, 0, accept.stderr);
  const afterAccept = await run(ownerCli, ["status"], ownerEnv);
  assert.equal(afterAccept.status, 0, afterAccept.stderr);
  assert.equal(afterAccept.stdout, `LOOP9 attempts=2 verdict=green sha=${baseSha.slice(0, 7)} accepted=yes eye=- choke=0/0/0\n`);
});

test("status prints one line per task in first-appearance order, including mid-gate tasks", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  const full = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  writeLedger(stateDir, [
    contractEvent(1, "T-BETA"),
    { seq: 2, ts, event: "contract_set", task: "T-ALPHA", workspace: "/tmp/ws", gate: "true", artifact: "a" },
    contractEvent(3, "T-GAMMA"),
    { seq: 4, ts, event: "claim_reported", task: "T-BETA", attempt: 1, sha: full, agent: "agent-1" },
    { seq: 5, ts, event: "gate_started", task: "T-BETA", attempt: 1, cmd: "true" },
    { seq: 6, ts, event: "gate_finished", task: "T-BETA", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    // v0.0.2's advisory line: status reads through it and shows its outcome as
    // the task's eye field (clear here — the last eye on record).
    { seq: 7, ts, event: "fresh_eyes_written", task: "T-BETA", attempt: 1, model: "gemini-3.8-flash-high", outcome: "clear", finding: "nothing to add.", durationMs: 900 },
    { seq: 8, ts, event: "report_written", task: "T-BETA", attempt: 1, path: "/s/report-T-BETA-1.md" },
    { seq: 9, ts, event: "attempt_accepted", task: "T-BETA", attempt: 1 },
    { seq: 10, ts, event: "claim_reported", task: "T-ALPHA", attempt: 1, sha: full },
    { seq: 11, ts, event: "gate_started", task: "T-ALPHA", attempt: 1, cmd: "true" },
    // ...and no gate_finished for T-ALPHA: its attempt is still open.
  ]);

  const status = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(
    status.stdout,
    [
      "T-BETA attempts=1 verdict=green sha=a1b2c3d accepted=yes eye=clear choke=0/0/0",
      "T-ALPHA attempts=1 verdict=- sha=- accepted=no eye=- choke=0/0/0",
      "T-GAMMA attempts=0 verdict=- sha=- accepted=no eye=- choke=0/0/0",
    ].join("\n") + "\n",
  );
});

test("status shows the last fresh-eyes outcome per task, or - when the task has none", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  const full = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

  function eyeEvent(seq: number, task: string, attempt: number, outcome: string): Record<string, unknown> {
    return { seq, ts, event: "fresh_eyes_written", task, attempt, model: "gemini-3.8-flash-high", outcome, finding: "nothing to add.", durationMs: 900 };
  }

  writeLedger(stateDir, [
    contractEvent(1, "E-CONCERN"),
    { seq: 2, ts, event: "claim_reported", task: "E-CONCERN", attempt: 1, sha: full, agent: "agent-1" },
    { seq: 3, ts, event: "gate_finished", task: "E-CONCERN", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    eyeEvent(4, "E-CONCERN", 1, "concern"),
    contractEvent(5, "E-CLEAR"),
    { seq: 6, ts, event: "claim_reported", task: "E-CLEAR", attempt: 1, sha: full, agent: "agent-1" },
    { seq: 7, ts, event: "gate_finished", task: "E-CLEAR", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    eyeEvent(8, "E-CLEAR", 1, "concern"),
    { seq: 9, ts, event: "claim_reported", task: "E-CLEAR", attempt: 2, sha: full, agent: "agent-1" },
    { seq: 10, ts, event: "gate_finished", task: "E-CLEAR", attempt: 2, exit: 0, verdict: "green", note: "", sha: full },
    eyeEvent(11, "E-CLEAR", 2, "clear"), // the last eye on record wins, not the first
    contractEvent(12, "E-FAILED"),
    { seq: 13, ts, event: "claim_reported", task: "E-FAILED", attempt: 1, sha: full, agent: "agent-1" },
    { seq: 14, ts, event: "gate_finished", task: "E-FAILED", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    eyeEvent(15, "E-FAILED", 1, "failed"),
    contractEvent(16, "E-NONE"),
    { seq: 17, ts, event: "claim_reported", task: "E-NONE", attempt: 1, sha: full, agent: "agent-1" },
    { seq: 18, ts, event: "gate_finished", task: "E-NONE", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    // ...and no fresh_eyes_written for E-NONE: the pass never ran on this task.
  ]);

  const status = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(
    status.stdout,
    [
      "E-CONCERN attempts=1 verdict=green sha=a1b2c3d accepted=no eye=concern choke=0/0/0",
      "E-CLEAR attempts=2 verdict=green sha=a1b2c3d accepted=no eye=clear choke=0/0/0",
      "E-FAILED attempts=1 verdict=green sha=a1b2c3d accepted=no eye=failed choke=0/0/0",
      "E-NONE attempts=1 verdict=green sha=a1b2c3d accepted=no eye=- choke=0/0/0",
    ].join("\n") + "\n",
  );
});

test("status prints one trailing retro line when a retro ever ran — the last one on record", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  const full = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

  const written: Record<string, unknown> = {
    seq: 6, ts: "2026-10-09T18:00:00.000Z", event: "retro_written",
    model: "copilot/gpt-5.4", outcome: "written", durationMs: 40_000,
    proposalsPath: "/s/retro-2026-10-09.md", proposalCount: 7,
  };
  writeLedger(stateDir, [
    contractEvent(1, "T-ONE"),
    { seq: 2, ts, event: "claim_reported", task: "T-ONE", attempt: 1, sha: full },
    { seq: 3, ts, event: "gate_finished", task: "T-ONE", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    { seq: 4, ts, event: "report_written", task: "T-ONE", attempt: 1, path: "/s/report-T-ONE-1.md" },
    written,
    // A later failed retro is the last on record — the line shows it, no count.
    { seq: 7, ts: "2026-10-10T09:00:00.000Z", event: "retro_written", model: "copilot/gpt-5.4", outcome: "failed", durationMs: 1_200, error: "copilot CLI exited 2" },
  ]);

  const status = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(
    status.stdout,
    ["T-ONE attempts=1 verdict=green sha=a1b2c3d accepted=no eye=- choke=0/0/0", "retro last=2026-10-10 outcome=failed"].join("\n") + "\n",
  );

  // Without the failed line, the written one shows with its count.
  writeLedger(stateDir, [
    contractEvent(1, "T-ONE"),
    { seq: 2, ts, event: "claim_reported", task: "T-ONE", attempt: 1, sha: full },
    { seq: 3, ts, event: "gate_finished", task: "T-ONE", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    { seq: 4, ts, event: "report_written", task: "T-ONE", attempt: 1, path: "/s/report-T-ONE-1.md" },
    written,
  ]);
  const afterWritten = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(afterWritten.status, 0, afterWritten.stderr);
  assert.ok(afterWritten.stdout.endsWith("retro last=2026-10-09 outcome=written proposals=7\n"), afterWritten.stdout);
});

test("status treats a missing or empty ledger as no tasks, not as an error", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");

  const missing = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /no tasks yet/);
  assert.match(missing.stdout, /ledger\.jsonl/);

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.jsonl"), "");
  const empty = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /no tasks yet/);
});

test("status refuses a ledger it cannot read, naming the line", async (t) => {
  const good = JSON.stringify(contractEvent(1, "T1"));
  const cases: [string, string, RegExp][] = [
    ["a line that is not JSON", `${good}\nnot json\n`, /line 2 is not valid JSON/],
    ["a blank line inside the file", "\n", /blank line at line 1/],
    ["an unknown event name", `${JSON.stringify({ seq: 1, ts, event: "teleported", task: "T1" })}\n`, /line 1 is not a valid ledger event/],
    ["a line that is not an event object", "[1, 2, 3]\n", /line 1 is not a valid ledger event/],
    ["a claim with no attempt number", `${JSON.stringify({ seq: 1, ts, event: "claim_reported", task: "T1", sha: "a1b2c3d" })}\n`, /line 1 is not a valid ledger event/],
  ];
  for (const [name, content, expected] of cases) {
    const dir = makeTempDir();
    disposeDir(t, dir);
    const stateDir = join(dir, "plugin-state", "paseo-factory");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ledger.jsonl"), content);
    const result = await run(ownerCli, ["status"], { PASEO_HOME: dir });
    assert.equal(result.status, 2, `${name}: expected exit 2\nstdout: ${result.stdout}`);
    assert.equal(result.stdout, "", `${name}: nothing is printed when the ledger is unreadable`);
    assert.match(result.stderr, expected, name);
    assert.match(result.stderr, /not a readable ledger/, name);
  }
});

test("status refuses bad usage before reading anything", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const extra = await run(ownerCli, ["status", "LOOP9"], { PASEO_HOME: dir });
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /status: unexpected positional "LOOP9"/);
});

test("an unterminated last ledger line is ignored, not printed (it was never acknowledged)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  const good = JSON.stringify(contractEvent(1, "T1"));
  writeFileSync(join(stateDir, "ledger.jsonl"), `${good}\n{"seq":2,"ts":"${ts}",ev`); // crash mid-write

  const result = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "T1 attempts=0 verdict=- sha=- accepted=no eye=- choke=0/0/0\n");
});

test("a read error that is not a missing file is reported, not swallowed", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  // A home that is a plain file: the ledger path under it cannot exist as a
  // directory entry, so the read fails with something other than ENOENT.
  const notAHome = join(dir, "just-a-file");
  writeFileSync(notAHome, "not a home\n");

  const result = await run(ownerCli, ["status", "--home", notAHome], {});
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot read/);
  assert.doesNotMatch(result.stderr, /no tasks yet/);
});

test("status counts a ledger's choke events onto the task line; untasked git blocks stay invisible", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const ts = "2026-10-09T09:00:00.000Z";
  const events = [
    { seq: 1, ts, event: "contract_set", task: "T1", workspace, gate: "true", artifact: "src/format.ts" },
    { seq: 2, ts, event: "claim_reported", task: "T1", attempt: 1, sha: "abc" },
    { seq: 3, ts, event: "gate_started", task: "T1", attempt: 1, cmd: "true" },
    { seq: 4, ts, event: "gate_finished", task: "T1", attempt: 1, exit: 0, verdict: "green", note: "ok", sha: "abc1234567890abcdef4567890abcdef4567890" },
    { seq: 5, ts, event: "report_written", task: "T1", attempt: 1, path: "factory/report-T1-1.md" },
    { seq: 6, ts, event: "permit_allowed", task: "T1", agent: "ag1", name: "Bash", kind: "tool", command: "npm test" },
    { seq: 7, ts, event: "permit_denied", task: "T1", agent: "ag1", name: "Bash", kind: "tool", command: "git push --force", rule: "policy:S1-git-vocabulary", reason: "r" },
    { seq: 8, ts, event: "git_blocked", command: "git clean -fd", rule: "git:clean-force", reason: "r", cwd: "/elsewhere", blockId: "b1" },
  ];
  writeLedger(stateDir, events);

  const result = await run(ownerCli, ["--home", home, "status"], { PASEO_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trimEnd(), "T1 attempts=1 verdict=green sha=abc1234 accepted=no eye=- choke=1/1/0");
  assert.ok(!result.stdout.includes("undefined"), "the untasked git_blocked never invents a task line");
});

test("status accumulates choke counts per task — counted tasks sum their events, quiet tasks read 0/0/0", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  const full = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

  function ask(seq: number, event: "permit_allowed" | "permit_denied", task: string, command: string): Record<string, unknown> {
    return { seq, ts, event, task, agent: "ag1", name: "Bash", kind: "tool", command };
  }

  writeLedger(stateDir, [
    contractEvent(1, "T-CHOKY"),
    ask(2, "permit_allowed", "T-CHOKY", "npm test"),
    ask(3, "permit_denied", "T-CHOKY", "git push --force"),
    ask(4, "permit_allowed", "T-CHOKY", "npm run lint"),
    ask(5, "permit_denied", "T-CHOKY", "rm -rf /"),
    ask(6, "permit_allowed", "T-CHOKY", "make"),
    // A git block whose cwd sat inside the task's workspace: counted, though attemptless.
    { seq: 7, ts, event: "git_blocked", task: "T-CHOKY", command: "git reset --hard", rule: "git:reset-hard", reason: "r", cwd: "/ws", blockId: "b1" },
    // A task with a full loop but no choke events at all — zero is data, not a dash.
    contractEvent(8, "T-QUIET"),
    { seq: 9, ts, event: "claim_reported", task: "T-QUIET", attempt: 1, sha: full },
    { seq: 10, ts, event: "gate_finished", task: "T-QUIET", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    // ...and an untasked git block, which counts toward no line.
    { seq: 11, ts, event: "git_blocked", command: "git clean -fd", rule: "git:clean-force", reason: "r", cwd: "/elsewhere", blockId: "b2" },
  ]);

  const status = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(
    status.stdout,
    [
      "T-CHOKY attempts=0 verdict=- sha=- accepted=no eye=- choke=3/2/1",
      "T-QUIET attempts=1 verdict=green sha=a1b2c3d accepted=no eye=- choke=0/0/0",
    ].join("\n") + "\n",
  );
});

test("status reads a ledger with spawn events through — no new fields, no invented lines", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  const full = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  writeLedger(stateDir, [
    contractEvent(1, "SP-A"),
    { seq: 2, ts, event: "spawn_dispatched", task: "SP-A", provider: "claude/opus-4-8", arity: 2 },
    { seq: 3, ts, event: "claim_reported", task: "SP-A", attempt: 1, sha: full, agent: "ag-1" },
    { seq: 4, ts, event: "gate_finished", task: "SP-A", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    { seq: 5, ts, event: "report_written", task: "SP-A", attempt: 1, path: "/s/report-SP-A-1.md" },
    contractEvent(6, "SP-B"),
    { seq: 7, ts, event: "spawn_refused", task: "SP-B", provider: "claude/opus-4-8", arity: 2, rule: "spawn:scope-mandatory", reason: "task SP-B has no scope" },
    // A refusal for a task that never contracted: it must not invent a line.
    { seq: 8, ts, event: "spawn_refused", task: "SP-GHOST", provider: "claude", arity: 1, rule: "spawn:unknown-task", reason: "no contract set for task SP-GHOST" },
  ]);

  const status = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(
    status.stdout,
    [
      "SP-A attempts=1 verdict=green sha=a1b2c3d accepted=no eye=- choke=0/0/0",
      "SP-B attempts=0 verdict=- sha=- accepted=no eye=- choke=0/0/0",
    ].join("\n") + "\n",
    "one line per contracted task, the spawn events read through — the ghost refusal invents nothing",
  );
});

test("status is lenient about spawn-event field depth the way it is for choke events — the writer's open-time validation is the shape guard", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  writeLedger(stateDir, [
    contractEvent(1, "T1"),
    { seq: 2, ts, event: "spawn_refused", task: "T1", provider: "claude", arity: 2, rule: "spawn:scope-mandatory" }, // no reason — still readable
  ]);
  const result = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "T1 attempts=0 verdict=- sha=- accepted=no eye=- choke=0/0/0\n");
});

test("status reads a ledger with meter lines through — the Cost read's event, not the glance's", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  writeLedger(stateDir, [
    contractEvent(1, "M1"),
    { seq: 2, ts, event: "spawn_dispatched", task: "M1", provider: "claude/claude-sonnet-5", arity: 1 },
    { seq: 3, ts, event: "meter_written", task: "M1", provider: "claude/claude-sonnet-5", usage: { totalCostUsd: 2.65 }, agent: "ag-1" },
  ]);
  const result = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "M1 attempts=0 verdict=- sha=- accepted=no eye=- choke=0/0/0\n", "the meter line counts toward no status field — `factory cost` is its reader");
});

test("status reads the Lead's lines through — repokes count nothing, needs-human is the glance's own marker (v0.0.10)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  writeLedger(stateDir, [
    contractEvent(1, "LEAD-ST"),
    { seq: 2, ts, event: "spawn_dispatched", task: "LEAD-ST", provider: "claude", arity: 1 },
    { seq: 3, ts, event: "permit_denied", task: "LEAD-ST", agent: "ag-1", name: "Bash", kind: "tool", command: "git reset --hard", rule: "policy:S1", reason: "r" },
    { seq: 4, ts, event: "repoke_dispatched", task: "LEAD-ST", agent: "ag-1" },
    { seq: 5, ts, event: "needs_human", task: "LEAD-ST", reason: "denied-again", evidence: { denial: 3, repoke: 4 } },
    contractEvent(6, "LEAD-QUIET"),
    { seq: 7, ts, event: "spawn_dispatched", task: "LEAD-QUIET", provider: "claude", arity: 1 },
    { seq: 8, ts, event: "permit_denied", task: "LEAD-QUIET", agent: "ag-2", name: "Bash", kind: "tool", command: "git push --force", rule: "policy:S1", reason: "r" },
  ]);
  const result = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "LEAD-ST attempts=0 verdict=- sha=- accepted=no eye=- choke=0/1/0 needs-human=denied-again",
      "LEAD-QUIET attempts=0 verdict=- sha=- accepted=no eye=- choke=0/1/0",
    ].join("\n") + "\n",
    "the repoke lines read through; the named end prints once as the task's stuck marker",
  );
});
