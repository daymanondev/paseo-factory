import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLoopHealth, computeLoopHealthForStreams, formatLoopHealthLines } from "../src/index.ts";
import type { LoopHealth } from "../src/index.ts";
import { computeLoopHealthForStreams as taskStatusComputeLoopHealthForStreams } from "../src/task-status.ts";
import type { LedgerEvent } from "../src/events.ts";

const ts = "2026-11-23T12:00:00.000Z";

function contract(seq: number, task: string): LedgerEvent {
  return {
    seq,
    ts,
    event: "contract_set",
    task,
    workspace: "/tmp/repo",
    gate: "npm test",
    artifact: "",
  };
}

test("computeLoopHealth: empty ledger returns zeroed metrics", () => {
  const health = computeLoopHealth([]);
  assert.deepEqual(health, {
    totalTasks: 0,
    peerAskedCount: 0,
    peerAskRate: 0,
    contextCeilingCount: 0,
    silentContextCeilingCount: 0,
    genuineUnknownGaps: 0,
    redAttempts: 0,
    recontracts: 0,
  });
  const lines = formatLoopHealthLines(health);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /Loop Health:/);
  assert.match(lines[1], /tasks=0 peer_asked=0 \(0%\)/);
});

test("computeLoopHealth: tracks peer_asked, silent context ceilings, red attempts, recontracts, and genuine unknown gaps", () => {
  const events: LedgerEvent[] = [
    // Task 1: re-contracted once, asked twice, 1 red attempt, 1 complete claim with ADR 0068 boilerplate only (no genuine gap)
    contract(1, "T1"),
    { seq: 2, ts, event: "peer_asked", task: "T1", kind: "reopen_premise", layer: "API", summary: "API mismatch", source: "agent_ask" },
    contract(3, "T1"),
    { seq: 4, ts, event: "peer_asked", task: "T1", kind: "clarify", summary: "clarify edge case", source: "agent_ask" },
    {
      seq: 5,
      ts,
      event: "gate_queued",
      task: "T1",
      attempt: 1,
      sha: "a".repeat(40),
      handoff: {
        outcome: "complete",
        scope: "implemented T1",
        verification: "slice tests green",
        unknowns: "Full cumulative Gate deferred to daemon GateQueue",
      },
    },
    {
      seq: 6,
      ts,
      event: "claim_reported",
      task: "T1",
      attempt: 1,
      sha: "a".repeat(40),
      handoff: {
        outcome: "complete",
        scope: "implemented T1",
        verification: "slice tests green",
        unknowns: "Skipped local cumulative gate; deferred to daemon Gate queue",
      },
    },
    { seq: 7, ts, event: "gate_finished", task: "T1", attempt: 1, exit: 1, verdict: "red", note: "failed" },

    // Task 2: closed for context-ceiling with 0 peer_asked -> silent context ceiling
    contract(8, "T2"),
    { seq: 9, ts, event: "task_closed", task: "T2", reason: "superseded after context-ceiling" },

    // Task 3: closed for context-ceiling AFTER peer_asked in same epoch -> NOT silent
    contract(10, "T3"),
    { seq: 11, ts, event: "peer_asked", task: "T3", kind: "dependency", summary: "missing package", source: "agent_ask" },
    { seq: 12, ts, event: "task_closed", task: "T3", reason: "context-ceiling after split" },

    // Task 4: closed for non-ceiling reason; complete claim has boilerplate line PLUS genuine gap (missing RPC / SIGKILL)
    contract(13, "T4"),
    {
      seq: 14,
      ts,
      event: "gate_queued",
      task: "T4",
      attempt: 1,
      sha: "b".repeat(40),
      handoff: {
        outcome: "complete",
        scope: "added bridge handler",
        verification: "slice green",
        unknowns: "Full gate deferred to daemon GateQueue\nMissing RPC handler for resume; worker died with SIGKILL (failed)",
      },
    },
    {
      seq: 15,
      ts,
      event: "claim_reported",
      task: "T4",
      attempt: 1,
      sha: "b".repeat(40),
      handoff: {
        outcome: "complete",
        scope: "added bridge handler",
        verification: "slice green",
        unknowns: "Full gate deferred to daemon GateQueue\nMissing RPC handler for resume; worker died with SIGKILL (failed)",
      },
    },
    { seq: 16, ts, event: "task_closed", task: "T4", reason: "superseded" },

    // Task 5: complete claim with negated phrasing ("none — no checks skipped, nothing failed") -> NOT a genuine gap; partial handback ignored
    contract(17, "T5"),
    {
      seq: 18,
      ts,
      event: "claim_reported",
      task: "T5",
      attempt: 1,
      sha: "c".repeat(40),
      handoff: {
        outcome: "complete",
        scope: "done",
        verification: "all passed",
        unknowns: "none — no checks skipped, nothing failed",
      },
    },
    {
      seq: 19,
      ts,
      event: "claim_reported",
      task: "T5",
      attempt: 2,
      sha: "c".repeat(40),
      handoff: {
        outcome: "partial",
        scope: "partial",
        verification: "slice",
        unknowns: "cannot finish due to missing key",
      },
    },
  ];

  const health = computeLoopHealth(events);
  assert.equal(health.totalTasks, 5);
  assert.equal(health.peerAskedCount, 3);
  assert.equal(health.peerAskRate, 2 / 5);
  assert.equal(health.contextCeilingCount, 2);
  assert.equal(health.silentContextCeilingCount, 1);
  assert.equal(health.genuineUnknownGaps, 1);
  assert.equal(health.redAttempts, 1);
  assert.equal(health.recontracts, 1);

  const lines = formatLoopHealthLines(health);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /tasks=5 peer_asked=3 \(40%\) · recontracts=1 red_attempts=1/);
  assert.match(lines[2], /context_ceiling=2 \(silent=1\) · genuine_unknown_gaps=1/);
});

test("computeLoopHealth: genuineUnknownGaps catches cannot, contradict, out of scope, and blocked", () => {
  const mkClaim = (seq: number, task: string, unknowns: string): LedgerEvent[] => [
    contract(seq, task),
    {
      seq: seq + 1,
      ts,
      event: "claim_reported",
      task,
      attempt: 1,
      sha: "d".repeat(40),
      handoff: { outcome: "complete", scope: "s", verification: "v", unknowns },
    },
  ];
  const events: LedgerEvent[] = [
    ...mkClaim(1, "G1", "cannot reproduce flaky timing locally"),
    ...mkClaim(3, "G2", "spec contradicts existing handler"),
    ...mkClaim(5, "G3", "migration script was out of scope"),
    ...mkClaim(7, "G4", "still blocked on upstream fixture"),
    ...mkClaim(9, "CLEAN", "Only fast slice tests ran; full GateQueue runs asynchronously."),
  ];
  const health = computeLoopHealth(events);
  assert.equal(health.totalTasks, 5);
  assert.equal(health.genuineUnknownGaps, 4);
});

test("computeLoopHealth: filters v0.21.0 topology-blind automated verification boilerplate without suppressing real failure reports", () => {
  const mkClaim = (seq: number, task: string, unknowns: string): LedgerEvent[] => [
    contract(seq, task),
    {
      seq: seq + 1,
      ts,
      event: "claim_reported",
      task,
      attempt: 1,
      sha: "e".repeat(40),
      handoff: { outcome: "complete", scope: "s", verification: "v", unknowns },
    },
  ];
  const events: LedgerEvent[] = [
    ...mkClaim(1, "B1", "Only fast slice tests ran; automated verification runs asynchronously."),
    ...mkClaim(3, "B2", "Skipped local full cumulative gate during TDD; deferred."),
    ...mkClaim(5, "B3", "Full gate not pre-run; automated verification runs asynchronously."),
    ...mkClaim(7, "B4", "Cumulative gate deferred; no checks failed."),
    ...mkClaim(9, "F1", "automated verification failed"),
    ...mkClaim(11, "F2", "gate failed"),
    ...mkClaim(13, "F3", "automated verification failed while running asynchronously"),
    ...mkClaim(15, "F4", "full gate failed; deferred to follow-up"),
  ];
  const health = computeLoopHealth(events);
  assert.equal(health.totalTasks, 8);
  assert.equal(health.genuineUnknownGaps, 4);
});

test("computeLoopHealthForStreams: aggregates per-project streams without colliding identical task IDs or losing precision", () => {
  assert.equal(taskStatusComputeLoopHealthForStreams, computeLoopHealthForStreams);

  const empty: LoopHealth = computeLoopHealthForStreams([]);
  assert.equal(empty.totalTasks, 0);
  assert.equal(empty.peerAskRate, 0);

  const streamA: LedgerEvent[] = [
    contract(1, "T-01"),
    { seq: 2, ts, event: "peer_asked", task: "T-01", kind: "clarify", summary: "clarify API", source: "agent_ask" },
    {
      seq: 3,
      ts,
      event: "claim_reported",
      task: "T-01",
      attempt: 1,
      sha: "a".repeat(40),
      handoff: {
        outcome: "complete",
        scope: "project A T-01",
        verification: "slice green",
        unknowns: "Only fast slice tests ran; automated verification runs asynchronously.",
      },
    },
  ];
  const streamB: LedgerEvent[] = [
    contract(1, "T-01"),
    { seq: 2, ts, event: "gate_finished", task: "T-01", attempt: 1, exit: 1, verdict: "red", note: "failed" },
    {
      seq: 3,
      ts,
      event: "claim_reported",
      task: "T-01",
      attempt: 1,
      sha: "b".repeat(40),
      handoff: {
        outcome: "complete",
        scope: "project B T-01",
        verification: "slice green",
        unknowns: "automated verification failed",
      },
    },
  ];

  const aggregated = computeLoopHealthForStreams([streamA, streamB, []]);
  assert.deepEqual(aggregated, {
    totalTasks: 2,
    peerAskedCount: 1,
    peerAskRate: 0.5,
    contextCeilingCount: 0,
    silentContextCeilingCount: 0,
    genuineUnknownGaps: 1,
    redAttempts: 1,
    recontracts: 0,
  });

  // Verify precision when aggregating unequal task counts (1/3 and 2/4 -> 3/7)
  const streamC: LedgerEvent[] = [
    contract(1, "C1"),
    { seq: 2, ts, event: "peer_asked", task: "C1", kind: "clarify", summary: "q1", source: "agent_ask" },
    contract(3, "C2"),
    contract(4, "C3"),
  ];
  const streamD: LedgerEvent[] = [
    contract(1, "D1"),
    { seq: 2, ts, event: "peer_asked", task: "D1", kind: "blocked", summary: "q2", source: "agent_ask" },
    contract(3, "D2"),
    { seq: 4, ts, event: "peer_asked", task: "D2", kind: "dependency", summary: "q3", source: "agent_ask" },
    contract(5, "D3"),
    contract(6, "D4"),
  ];
  const weighted = computeLoopHealthForStreams([streamC, streamD]);
  assert.equal(weighted.totalTasks, 7);
  assert.equal(weighted.peerAskedCount, 3);
  assert.equal(weighted.peerAskRate, 3 / 7);
});
