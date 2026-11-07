import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptViaSidecar } from "../web/src/accept.ts";
import { taskDetailViaSidecar } from "../web/src/detail.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { tasksScreenModel, taskDetailModel } from "../web/src/view-model.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-03): at least one test drives the console's
 * REAL detail read — `web/src/detail.ts` `taskDetailViaSidecar`, the exact
 * function the browser bundle calls — against a REAL started sidecar over a
 * REAL Factory fixture whose stateDir carries real report and gate-log
 * files, proving the Owner's bounded outcome end to end: the board fold
 * names the Task's column, the detail carries the Contract and the green
 * Attempt's tailed evidence verbatim, and the Accept that closes the
 * journey lands through the same allowlisted door.
 */

test("RG-1: the console's real transport reads a Task's detail — Contract, Watch answers, Fresh-eyes finding, tailed report and gate log — then Accepts it", async (t) => {
  const homeRoot = makeTempDir();
  const fixture = makeConsoleFixture(homeRoot);

  // The Task's real git workspace — the Contract's base commit resolves from it.
  const workspace = join(homeRoot, "T-01-ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);

  // The evidence files the detail's read door tails — REAL files in the
  // Factory's stateDir, exactly where the gate and report stations write.
  const reportText = "# Report — T-01 attempt 1\n\n- gate `npm test` exited 0\n- the artifact formats cleanly\n";
  const gateLogText = "$ npm test\n\nok 2 tests\nexit 0\n";
  writeFileSync(join(fixture.stateDir, "report-T-01-1.md"), reportText);
  writeFileSync(join(fixture.stateDir, "gate-T-01-1.log"), gateLogText);

  const factory = fixture.factory;
  factory.setContract({
    task: "T-01",
    workspace,
    gate: "npm test",
    artifact: "src/format.ts",
    scope: ["src"],
    skills: ["tdd"],
    watch: true,
    freshEyes: true,
    by: "lead",
    description: "Deliver the formatter and its verification report.",
  });
  factory.ledger.append({ event: "claim_reported", task: "T-01", attempt: 1, sha, agent: "agent-peer-7" });
  factory.ledger.append({ event: "gate_finished", task: "T-01", attempt: 1, exit: 0, verdict: "green", note: "passed", sha, outputPath: join(fixture.stateDir, "gate-T-01-1.log") });
  factory.ledger.append({
    event: "fresh_eyes_written",
    task: "T-01",
    attempt: 1,
    model: "pi/zai/glm-5.3",
    outcome: "clear",
    finding: "The report matches the diff.",
    durationMs: 4_000,
  });
  factory.ledger.append({
    event: "watch_written",
    task: "T-01",
    attempt: 1,
    model: "typesafe/jev-1.13-20260917",
    outcome: "written",
    answers: { "lied about tests": 0.12, "scope creep": 0.31 },
    durationMs: 9_000,
  });
  factory.ledger.append({ event: "report_written", task: "T-01", attempt: 1, path: join(fixture.stateDir, "report-T-01-1.md") });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });
  const atSidecar = fixture.atSidecar(started.sidecar);

  // 1. The board fold over the REAL snapshot names the Task's column — the
  //    journey starts from the board, so the board must be right first.
  const snapshot = await loadSnapshotViaSidecar({}, atSidecar);
  assert.ok(snapshot.ok, snapshot.ok ? "" : `${snapshot.code}: ${snapshot.error}`);
  const board = tasksScreenModel(snapshot.view);
  const row = board.rows.find((entry) => entry.task === "T-01");
  assert.ok(row, "the fixture task rides the snapshot the board folds");
  assert.equal(row.status, "ready-to-accept");
  assert.equal(row.column, "ready_to_accept");
  assert.equal(row.acceptAttempt, 1);
  assert.equal(board.columnCounts.ready_to_accept, 1);

  // 2. The browser's own detail transport — the same `invokeRpc` POST /rpc
  //    the Task Detail dialog rides — carries the Contract verbatim.
  const reply = await taskDetailViaSidecar({ task: "T-01" }, atSidecar);
  assert.ok(reply.ok, reply.ok ? "" : `${reply.code}: ${reply.error}`);
  const { detail } = reply;
  assert.equal(detail.contract.task, "T-01");
  assert.equal(detail.contract.gate, "npm test");
  assert.equal(detail.contract.artifact, "src/format.ts");
  assert.deepEqual(detail.contract.scope, ["src"]);
  assert.deepEqual(detail.contract.skills, ["tdd"]);
  assert.equal(detail.contract.watch, true);
  assert.equal(detail.contract.freshEyes, true);
  assert.equal(detail.contract.by, "lead");
  assert.equal(detail.contract.description, "Deliver the formatter and its verification report.");
  assert.ok(detail.contract.base !== null, "the Contract's base commit resolved from the real git workspace");
  assert.equal(detail.task.status, "ready-to-accept");

  // 3. The green Attempt's tailed evidence rides the detail verbatim — the
  //    exact bytes the stateDir carries, not a summary of them.
  const evidence = detail.attempts.find((attempt) => attempt.n === 1);
  assert.ok(evidence);
  assert.equal(evidence.verdict, "green");
  assert.equal(evidence.agentId, "agent-peer-7");
  assert.equal(evidence.report, reportText);
  assert.equal(evidence.gateLog, gateLogText);

  // 4. The Watch answers and the Fresh-eyes finding — the fold's advisory
  //    passes, record-only, exactly as the ledger wrote them.
  const attempt = detail.task.attempts.find((entry) => entry.n === 1);
  assert.ok(attempt);
  assert.equal(attempt.watch?.outcome, "written");
  assert.equal(attempt.watch?.model, "typesafe/jev-1.13-20260917");
  assert.equal(attempt.watch?.maxProbability, 0.31);
  assert.deepEqual(attempt.watch?.answers, { "lied about tests": 0.12, "scope creep": 0.31 });
  assert.equal(attempt.eye?.outcome, "clear");
  assert.equal(attempt.eye?.finding, "The report matches the diff.");

  // 5. The console's detail fold joins the two halves into the ladder the
  //    dialog renders — rung #1 green with the evidence inline.
  const model = taskDetailModel(detail);
  assert.equal(model.rungs.length, 1);
  const rung = model.rungs[0]!;
  assert.equal(rung.verdictLabel, "Gate green");
  assert.equal(rung.exit, 0);
  assert.equal(rung.sha, sha);
  assert.equal(rung.report, reportText);
  assert.equal(rung.gateLog, gateLogText);
  assert.equal(rung.agentId, "agent-peer-7");
  assert.equal(rung.watch?.answers?.["scope creep"], 0.31);
  assert.equal(rung.eye?.finding, "The report matches the diff.");
  assert.equal(model.acceptAttempt, 1);

  // 6. The journey's close: the Accept the dialog offers lands through the
  //    same allowlisted door, and the ledger records it.
  const acceptance = await acceptViaSidecar({ task: "T-01", attempt: 1 }, atSidecar);
  assert.ok(acceptance.ok, acceptance.ok ? "" : `${acceptance.code}: ${acceptance.error}`);
  const accepted = factory.ledger.eventsFor("T-01").find((event) => event.event === "attempt_accepted");
  assert.ok(accepted, "the acceptance landed in the ledger via the sidecar's in-process dispatch");

  // 7. A refusal stays data over the real transport — the door's own
  //    vocabulary for a task it holds no contract for.
  const unknown = await taskDetailViaSidecar({ task: "T-404" }, atSidecar);
  assert.ok(unknown.ok === false);
  assert.equal(unknown.ok === false && unknown.code, "unknown-task");
});
