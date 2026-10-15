import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/index.ts";
import { copyFixture, disposeDir, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

/** Parses a ledger line and drops the clock-dependent `ts` so asserts stay exact. */
function lineWithoutTs(line: string): Record<string, unknown> {
  const { ts, ...rest } = JSON.parse(line) as { ts?: unknown };
  assert.match(String(ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  return rest;
}

/**
 * The scripted integration scenario from ticket 07 / roadmap §2, in its ADR
 * shape: contract set → claim reported → gate runs red (`npm test`, 2 failing
 * tests) → report shows the red evidence. §2's literal event name
 * `done_reported` is superseded by ADR 0003 (`claim_reported`), §2's fake sha
 * by ADR 0002 (the claim must resolve to a real commit), and since ticket 08
 * every event carries `ts` and its Attempt number while the Contract fixes the
 * Workspace (ADR 0003 / ADR 0002).
 */
test("roadmap §2 scenario: red npm test produces the five-event ledger and a red-evidence report", async (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const workspace = join(tmp, "workspace");
  copyFixture("sample-workspace", workspace);
  const sha = gitCommitAll(workspace);
  const stateDir = join(tmp, "factory");

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "T1", workspace, gate: "npm test", artifact: "src/format.ts" });
  const outcome = await factory.claim({ task: "T1", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 1);
  assert.equal(outcome.attempt, 1);

  const lines = readFileSync(join(stateDir, "ledger.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 5, "exactly the five roadmap events");
  // The doc's literal first three lines — same events, fields, and order, with
  // the ADR 0002/0003 amendments applied.
  assert.deepEqual(lineWithoutTs(lines[0]!), {
    seq: 1,
    event: "contract_set",
    task: "T1",
    workspace,
    gate: "npm test",
    artifact: "src/format.ts",
    base: sha,
  });
  assert.deepEqual(lineWithoutTs(lines[1]!), { seq: 2, event: "claim_reported", task: "T1", attempt: 1, sha });
  assert.deepEqual(lineWithoutTs(lines[2]!), { seq: 3, event: "gate_started", task: "T1", attempt: 1, cmd: "npm test" });

  const gate = JSON.parse(lines[3]!) as { seq: number; event: string; task: string; attempt: number; exit: number; verdict: string; note: string; sha?: string };
  assert.deepEqual(
    { seq: gate.seq, event: gate.event, task: gate.task, attempt: gate.attempt, exit: gate.exit, verdict: gate.verdict, sha: gate.sha },
    { seq: 4, event: "gate_finished", task: "T1", attempt: 1, exit: 1, verdict: "red", sha },
  );
  assert.match(gate.note, /fail 2/, "the note carries the real test failure summary");

  const reportWritten = lineWithoutTs(lines[4]!) as { seq: number; event: string; task: string; attempt: number; path: string };
  assert.deepEqual(reportWritten, {
    seq: 5,
    event: "report_written",
    task: "T1",
    attempt: 1,
    path: join(stateDir, "report-T1-1.md"),
  });

  const report = readFileSync(join(stateDir, "report-T1-1.md"), "utf8");
  assert.match(report, /^# T1 — \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/m);
  assert.ok(report.includes("- Contract: `npm test` green · file `src/format.ts` exists"));
  assert.ok(report.includes(`- Claimed @ `));
  assert.ok(report.includes(`- Attested commit: \`${sha}\``));
  assert.ok(report.includes("- Verdict: RED — "));
  assert.ok(!report.includes("Conclusion"), "no acceptance language — ADR 0002");
});

test("the full loop: red attempt → real fix → green attempt 2 → the Owner accepts it", async (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const workspace = join(tmp, "workspace");
  copyFixture("sample-workspace", workspace);
  const brokenSha = gitCommitAll(workspace);
  const stateDir = join(tmp, "factory");

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "T2", workspace, gate: "npm test", artifact: "src/format.ts" });

  // Attempt 1: the agent claims unfinished work; the gate says red.
  const red = await factory.claim({ task: "T2", sha: brokenSha });
  assert.equal(red.verdict, "red");
  assert.equal(red.attempt, 1);

  // The agent fixes the work for real, commits it, then claims the new commit.
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

  const green = await factory.claim({ task: "T2", sha: fixedSha });
  assert.equal(green.verdict, "green");
  assert.equal(green.attempt, 2, "the fix is a new Attempt, not an overwrite (ADR 0003)");
  const report1 = readFileSync(join(stateDir, "report-T2-1.md"), "utf8");
  const report2 = readFileSync(green.reportPath, "utf8");
  assert.ok(report1.includes("- Verdict: RED —"));
  assert.ok(report2.includes("- Attempt: 2 of 2"));
  assert.ok(report2.includes("- Verdict: GREEN —"));
  assert.ok(report2.includes("- Evidence, not acceptance"));

  // Acceptance is the Owner's act, on a specific green Attempt (ADR 0002).
  const accepted = await factory.accept({ task: "T2", attempt: 2 });
  assert.equal(accepted.event, "attempt_accepted");
  assert.deepEqual(factory.ledger.eventsFor("T2").map((e) => e.event), [
    "contract_set",
    "claim_reported",
    "gate_started",
    "gate_finished",
    "report_written",
    "claim_reported",
    "gate_started",
    "gate_finished",
    "report_written",
    "attempt_accepted",
  ]);
});
