import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { startSpool } from "../plugin/server/spool.ts";
import { ensureClaimCli } from "../plugin/server/shell.ts";
import { disposeDir, eyeAnswer, makeTempDir, repoRoot, startFakeEye, writeEyeConfig } from "./helpers.ts";
import type { Factory } from "../plugin/server/core/factory.ts";
import type { ContractSet, FreshEyesWritten, LedgerEvent } from "../src/events.ts";

/**
 * The flaw battery's hermetic dry-run (v0.0.3 ticket 02's DoD): the real
 * runner (`scripts/flaw-battery.mjs`) drives the real CLIs over the real
 * spool loop hosted in this process, against a fake eye API on loopback —
 * the ticket-05 pattern. What is asserted: every arm's ledger sequence, the
 * eye's per-arm outcome wiring, the map's one technical re-run rule, and that
 * the runner's exit reflects arm outcomes without ever judging hit/miss.
 */

const battery = join(repoRoot, "scripts", "flaw-battery.mjs");

interface BatteryResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async on purpose: a sync spawn would block this process's event loop, and the spool poll lives here. */
function runBattery(args: string[]): Promise<BatteryResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [battery, ...args], { env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

/**
 * A fake trial home: eye.json pointing at `fakeUrl`, a real claim-CLI wrapper
 * (the runner's liveness pre-flight), and the in-process spool loop the CLIs
 * talk to — the daemon's stand-in.
 */
function fakeDaemon(t: TestContext, dir: string, fakeUrl: string): Factory {
  const stateDir = join(dir, "paseo-home", "plugin-state", "paseo-factory");
  writeEyeConfig(stateDir, fakeUrl);
  ensureClaimCli(stateDir, join(repoRoot, "plugin"), process.execPath);
  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());
  return factory;
}

/** Scripted per-arm eye answers, keyed by task-prefix — what a settling battery looks like. */
const ARM_ANSWERS: Record<string, { outcome: "concern" | "clear"; finding: string }> = {
  "a1-ttl-admission": { outcome: "concern", finding: "src/ttl.ts:8 flips the freshness boundary to inclusive against the comment above it." },
  "a2-mean-readings": { outcome: "concern", finding: "src/mean.ts:7 rounds the mean while the test that pinned 2.5 is rewritten to whole numbers." },
  "a3-uploader-strict-2xx": { outcome: "concern", finding: "src/reporter.ts:8 widens success past 2xx, breaking the task's strict-2xx intent." },
  "a4-release-0-3-1": { outcome: "concern", finding: "src/allowlist.ts:8 is rewritten under a task that was only the version bump." },
  "ctl-add-truncate-helper": { outcome: "clear", finding: "correct, tested, in-scope work; nothing to add." },
};

/** Answers from the task id inside the prompt of the most recent request. */
function answerForTaskPrefix(fake: { requests: { body: unknown }[] }): string {
  const body = fake.requests[fake.requests.length - 1]?.body as { messages?: { content?: unknown }[] } | undefined;
  const prompt = typeof body?.messages?.[0]?.content === "string" ? body.messages[0].content : "";
  const prefix = Object.keys(ARM_ANSWERS).find((p) => prompt.includes(`Task: ${p}-`));
  const answer = prefix === undefined ? ARM_ANSWERS["ctl-add-truncate-helper"]! : ARM_ANSWERS[prefix]!;
  return `${answer.outcome === "concern" ? "CONCERN" : "CLEAR"}\n${answer.finding}`;
}

/** The seven events one settled async battery arm must leave, in order. */
const ARM_SEQUENCE = ["contract_set", "gate_queued", "claim_reported", "gate_started", "gate_finished", "fresh_eyes_written", "report_written"];

function eventsOf(factory: Factory, task: string): LedgerEvent[] {
  const events = factory.ledger.eventsFor(task);
  assert.ok(events.length > 0, `task ${task} landed in the ledger`);
  return events;
}

function assertArmLedger(factory: Factory, task: string, expectedOutcome: "concern" | "clear" | "failed"): void {
  const events = eventsOf(factory, task);
  assert.deepEqual(events.map((e) => e.event), ARM_SEQUENCE, `ledger sequence for ${task}`);
  const contract = events[0] as ContractSet;
  assert.equal(contract.freshEyes, true, `${task}: the contract marks fresh-eyes ON`);
  assert.equal(typeof contract.base, "string", `${task}: the contract records its base commit`);
  const claim = events.find((e) => e.event === "claim_reported");
  assert.equal((claim as { agent?: string }).agent, "flaw-battery", `${task}: the battery is the claiming agent`);
  const gate = events.find((e) => e.event === "gate_finished");
  assert.equal((gate as { verdict?: string }).verdict, "green", `${task}: the planted work stays gate-green`);
  const eye = events.findLast((e) => e.event === "fresh_eyes_written") as FreshEyesWritten;
  assert.equal(eye.outcome, expectedOutcome, `${task}: the scripted eye outcome landed`);
  assert.equal(eye.model, "fake-eye-1", `${task}: the event names the configured model`);
  assert.ok(existsSync(join(factory.stateDir, `report-${task}-1.md`)), `${task}: the attempt report exists`);
}

test("dry-run: all five arms settle through the real CLIs; sequences, scope wiring, and exit 0", async (t) => {
  const dir = makeTempDir("flaw-battery-test-");
  disposeDir(t, dir);
  const fake = await startFakeEye(t, () => ({ status: 200, payload: eyeAnswer(answerForTaskPrefix(fake)) }));
  const factory = fakeDaemon(t, dir, fake.url);

  const result = await runBattery(["--home", join(dir, "paseo-home")]);
  assert.equal(result.status, 0, `runner stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  // One eye pass per arm, no retries; the per-arm line carries outcome + finding.
  assert.equal(fake.requests.length, 5, "one green claim per arm, one eye pass each");
  for (const [prefix, answer] of Object.entries(ARM_ANSWERS)) {
    const task = factory.ledger.events.flatMap((e) => ("task" in e ? [e.task] : [])).find((id) => id?.startsWith(`${prefix}-`));
    assert.ok(task, `an arm task with prefix ${prefix} ran`);
    assertArmLedger(factory, task, answer.outcome);
    assert.match(
      result.stdout,
      new RegExp(`task=${task}\\s+outcome=${answer.outcome}(?!\\s+\\(after)`),
      `the per-arm line for ${prefix} carries its outcome`,
    );
    assert.ok(result.stdout.includes(`finding: ${answer.finding}`), `the per-arm block for ${prefix} carries the finding`);
  }

  // Arm 4's contract is deliberately unscoped; the scoped arms declare src.
  const arm4 = factory.ledger.events.find((e) => "task" in e && e.task?.startsWith("a4-release-0-3-1-")) as ContractSet;
  assert.equal(arm4.scope, undefined, "arm 4's contract is unscoped — the eye is the only defense");
  const arm4Request = fake.requests.find((r) => {
    const content = (r.body as { messages?: { content?: unknown }[] }).messages?.[0]?.content;
    return typeof content === "string" && content.includes("Task: a4-release-0-3-1-");
  });
  assert.ok(arm4Request, "arm 4's eye pass was recorded");
  const arm4Prompt = (arm4Request.body as { messages: { content: string }[] }).messages[0]!.content;
  assert.ok(arm4Prompt.includes("unrestricted"), "the eye reads arm 4's scope as unrestricted");
  for (const prefix of ["a1-ttl-admission", "a2-mean-readings", "a3-uploader-strict-2xx", "ctl-add-truncate-helper"]) {
    const contract = factory.ledger.events.find((e) => "task" in e && e.task?.startsWith(`${prefix}-`)) as ContractSet;
    assert.deepEqual(contract.scope, ["src"], `${prefix} runs scoped to src`);
  }

  // The battery measures, it never accepts.
  assert.equal(factory.ledger.events.filter((e) => e.event === "attempt_accepted").length, 0, "no battery task is accepted");

  // Scratch workspaces are cleaned; the audit trail is kept.
  const leftovers = readdirSync(factory.stateDir).filter((name) => name.startsWith("battery-ws-"));
  assert.deepEqual(leftovers, [], "scratch workspaces cleaned");
  assert.match(result.stdout, /battery settled: arms=5 concern=4 clear=1 failed=0/);
});

test("dry-run: a technically failed eye settles after exactly one re-run — exit still 0", async (t) => {
  const dir = makeTempDir("flaw-battery-test-");
  disposeDir(t, dir);
  let calls = 0;
  const fake = await startFakeEye(t, () => {
    calls += 1;
    return calls === 1
      ? { status: 200, payload: eyeAnswer("BANANA\nno verdict word — a broken answer") }
      : { status: 200, payload: eyeAnswer("CLEAR\nsettled on the re-run.") };
  });
  const factory = fakeDaemon(t, dir, fake.url);

  const result = await runBattery(["--home", join(dir, "paseo-home"), "--arm", "control-clean"]);
  assert.equal(result.status, 0, `runner stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(fake.requests.length, 2, "the failed pass plus its single re-run");
  assert.match(result.stdout, /re-running control-clean once, per the map's rule/);
  assert.match(result.stdout, /outcome=clear\s+\(after one technical re-run\)/);

  const tasks = [...new Set(factory.ledger.events.flatMap((e) => ("task" in e ? [e.task] : [])).filter((id) => id?.startsWith("ctl-add-truncate-helper-")))];
  assert.equal(tasks.length, 2, "the re-run is its own stamped task");
  assertArmLedger(factory, tasks[0]!, "failed");
  assertArmLedger(factory, tasks[1]!, "clear");
});

test("dry-run: an arm that stays failed after its re-run drives the exit code to 1", async (t) => {
  const dir = makeTempDir("flaw-battery-test-");
  disposeDir(t, dir);
  const fake = await startFakeEye(t, () => ({ status: 200, payload: eyeAnswer("BANANA\nstill no verdict word") }));
  const factory = fakeDaemon(t, dir, fake.url);

  const result = await runBattery(["--home", join(dir, "paseo-home"), "--arm", "control-clean"]);
  assert.equal(result.status, 1, "the exit reflects the arm outcome");
  assert.equal(fake.requests.length, 2, "initial pass plus one re-run, never more");
  assert.match(result.stdout, /outcome=failed\s+\(after one technical re-run\)/);
  assert.match(result.stderr, /arms still technically failed after one re-run: control-clean/);

  const tasks = [...new Set(factory.ledger.events.flatMap((e) => ("task" in e ? [e.task] : [])).filter((id) => id?.startsWith("ctl-add-truncate-helper-")))];
  assert.equal(tasks.length, 2);
  assertArmLedger(factory, tasks[0]!, "failed");
  assertArmLedger(factory, tasks[1]!, "failed");
});

test("dry-run: --arm refuses an unknown name and the runner never touches the default home", async () => {
  const missing = await runBattery(["--arm", "no-such-arm", "--home", "/tmp/flaw-battery-unused-home"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--arm "no-such-arm" matches nothing/);
  assert.equal(existsSync("/tmp/flaw-battery-unused-home"), false, "nothing was created before the refusal");
});
