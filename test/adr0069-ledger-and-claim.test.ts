import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFactory,
  EVENT_NAMES,
  hasUnansweredPeerAsk,
  isValidLedgerEvent,
  Ledger,
  MAX_ATTEMPTS,
  MAX_REOPEN_CONDITION_CHARS,
  MAX_REOPEN_CONDITIONS,
  parseLedgerJsonl,
  projectStateDir,
  projectTask,
  REPOKE_MESSAGE_MAX_CHARS,
  resolveProject,
} from "../src/index.ts";
import { disposeDir, factoryErrorCode, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

function makeWorkspace(dir: string, name = "ws"): { workspace: string; sha: string } {
  const workspace = join(dir, name);
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "app.ts"), "export const v = 1;\n");
  const sha = gitCommitAll(workspace, "init");
  return { workspace, sha };
}

test("Ticket 01: peer_asked vocabulary, validation, and backward-compatible v2 replay", (t) => {
  assert.ok(EVENT_NAMES.includes("peer_asked"));

  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.jsonl");

  // Historical v2 ledger lacking peer_asked, reopenConditions, and repoke_dispatched.{kind,message}
  const historicalLines = [
    JSON.stringify({
      seq: 1,
      ts: "2026-11-01T00:00:00.000Z",
      event: "ledger_schema",
      schema_version: 2,
      version: 2,
      ledger_id: "leg-1",
      writer_id: "w-1",
      event_id: "evt-schema",
      provenance: { writer_id: "w-1" },
    }),
    JSON.stringify({
      seq: 2,
      ts: "2026-11-01T00:01:00.000Z",
      event: "contract_set",
      task: "HIST-1",
      workspace: "/tmp/ws",
      gate: "true",
      artifact: "",
      schema_version: 2,
      event_id: "evt-c1",
      epoch_id: "evt-c1",
      provenance: { writer_id: "w-1" },
    }),
    JSON.stringify({
      seq: 3,
      ts: "2026-11-01T00:02:00.000Z",
      event: "repoke_dispatched",
      task: "HIST-1",
      agent: "peer-1",
      schema_version: 2,
      event_id: "evt-r1",
      epoch_id: "evt-c1",
      provenance: { writer_id: "w-1" },
    }),
  ].join("\n") + "\n";
  writeFileSync(ledgerPath, historicalLines);

  const parsed = parseLedgerJsonl(historicalLines);
  assert.equal(parsed.corrupt, undefined);
  assert.equal(parsed.events?.length, 3);

  // Valid v2 peer_asked
  const validPeerAsked = {
    seq: 4,
    ts: "2026-11-01T00:03:00.000Z",
    event: "peer_asked",
    task: "HIST-1",
    kind: "reopen_premise",
    layer: "API",
    summary: "Endpoint contract contradicts server schema",
    source: "agent_ask",
    agent: "peer-1",
    reportPath: "/tmp/report-HIST-1-ask-4.md",
    schema_version: 2,
    event_id: "evt-p1",
    epoch_id: "evt-c1",
    provenance: { writer_id: "w-1" },
  };
  assert.equal(isValidLedgerEvent(validPeerAsked), true);

  // Invalid peer_asked cases
  assert.equal(isValidLedgerEvent({ ...validPeerAsked, kind: "bogus" }), false);
  assert.equal(isValidLedgerEvent({ ...validPeerAsked, layer: "unknown_layer" }), false);
  assert.equal(isValidLedgerEvent({ ...validPeerAsked, summary: "   " }), false);
  assert.equal(isValidLedgerEvent({ ...validPeerAsked, source: "manual" }), false);
  assert.equal(isValidLedgerEvent({ ...validPeerAsked, attempt: 1 }), false);
  assert.equal(
    isValidLedgerEvent({
      seq: 5,
      ts: "2026-11-01T00:04:00.000Z",
      event: "repoke_dispatched",
      task: "HIST-1",
      agent: "peer-1",
      kind: "invalid-kind",
      schema_version: 2,
      event_id: "evt-r2",
      epoch_id: "evt-c1",
      provenance: { writer_id: "w-1" },
    }),
    false,
  );
  assert.equal(
    isValidLedgerEvent({
      seq: 5,
      ts: "2026-11-01T00:04:00.000Z",
      event: "repoke_dispatched",
      task: "HIST-1",
      agent: "peer-1",
      kind: "ruling",
      message: "x".repeat(REPOKE_MESSAGE_MAX_CHARS + 1),
      schema_version: 2,
      event_id: "evt-r2",
      epoch_id: "evt-c1",
      provenance: { writer_id: "w-1" },
    }),
    false,
  );

  // Ledger.open replays historical file cleanly
  const ledger = Ledger.open(ledgerPath, { writerId: "w-1" });
  assert.equal(ledger.events.length, 3);
});

test("Ticket 01: reopenConditions validation on setContract", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const { workspace } = makeWorkspace(dir);
  const factory = createFactory({ stateDir });

  // Valid trimmed conditions
  const c1 = factory.setContract({
    task: "RC-OK",
    workspace,
    gate: "true",
    reopenConditions: ["  SDK lacks streaming hook  ", "Existing tests already fail on HEAD"],
  });
  assert.deepEqual(c1.reopenConditions, [
    "SDK lacks streaming hook",
    "Existing tests already fail on HEAD",
  ]);

  // Empty array omits field cleanly
  const c2 = factory.setContract({
    task: "RC-EMPTY",
    workspace,
    gate: "true",
    scope: ["src/other"],
    reopenConditions: [],
  });
  assert.equal(c2.reopenConditions, undefined);

  // Refusals with invalid-contract
  assert.throws(
    () =>
      factory.setContract({
        task: "RC-BAD-TYPE",
        workspace,
        gate: "true",
        reopenConditions: "not-an-array" as unknown as string[],
      }),
    factoryErrorCode("invalid-contract"),
  );
  assert.throws(
    () =>
      factory.setContract({
        task: "RC-BAD-EMPTY-ITEM",
        workspace,
        gate: "true",
        reopenConditions: ["valid", "   "],
      }),
    factoryErrorCode("invalid-contract"),
  );
  assert.throws(
    () =>
      factory.setContract({
        task: "RC-TOO-MANY",
        workspace,
        gate: "true",
        reopenConditions: Array.from({ length: MAX_REOPEN_CONDITIONS + 1 }, (_, i) => `cond-${i}`),
      }),
    factoryErrorCode("invalid-contract"),
  );
  assert.throws(
    () =>
      factory.setContract({
        task: "RC-TOO-LONG",
        workspace,
        gate: "true",
        reopenConditions: ["a".repeat(MAX_REOPEN_CONDITION_CHARS + 1)],
      }),
    factoryErrorCode("invalid-contract"),
  );
});

test("Ticket 01: factory.repoke stamps kind and truncated message; recordPeerAsk & hasUnansweredPeerAsk", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const { workspace, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir });

  // recordPeerAsk refuses unknown task
  assert.throws(
    () =>
      factory.recordPeerAsk({
        task: "MISSING",
        kind: "clarify",
        summary: "Need clarification",
        source: "agent_ask",
      }),
    factoryErrorCode("unknown-task"),
  );

  factory.setContract({ task: "ASK-1", workspace, gate: "true" });
  assert.equal(hasUnansweredPeerAsk(factory.ledger.events, "ASK-1"), false);

  // recordPeerAsk appends peer_asked without opening an Attempt
  const ask1 = factory.recordPeerAsk({
    task: "ASK-1",
    kind: "reopen_premise",
    layer: "API",
    summary: "  Brief assumes REST endpoint exists  ",
    source: "agent_ask",
    agent: "peer-a",
  });
  assert.equal(ask1.event, "peer_asked");
  assert.equal(ask1.summary, "Brief assumes REST endpoint exists");
  assert.equal(ask1.layer, "API");
  assert.equal(projectTask(factory.ledger.events, "ASK-1").maxAttempt, 0);
  assert.equal(hasUnansweredPeerAsk(factory.ledger.events, "ASK-1"), true);

  // Message-bearing repoke stamps kind: "ruling" and truncates cleanly to <= 1,000 chars without splitting surrogate pair
  const emoji = "🚀"; // 2 UTF-16 code units
  const longMessage = `  ${"x".repeat(999)}${emoji}tail  `;
  const ruling = factory.repoke("ASK-1", "peer-a", longMessage);
  assert.equal(ruling.outcome, "dispatched");
  assert.equal(ruling.event.kind, "ruling");
  assert.ok(ruling.event.message !== undefined);
  assert.ok(ruling.event.message.length <= REPOKE_MESSAGE_MAX_CHARS);
  assert.equal(ruling.event.message, "x".repeat(999));
  assert.equal(hasUnansweredPeerAsk(factory.ledger.events, "ASK-1"), false);

  // A newer peer_asked re-opens unanswered state
  factory.recordPeerAsk({
    task: "ASK-1",
    kind: "dependency",
    summary: "New missing dependency",
    source: "agent_ask",
  });
  assert.equal(hasUnansweredPeerAsk(factory.ledger.events, "ASK-1"), true);

  // A new Contract epoch supersedes the previous peer_asked
  factory.setContract({ task: "ASK-1", workspace, gate: "true" });
  assert.equal(hasUnansweredPeerAsk(factory.ledger.events, "ASK-1"), false);

  // Message-less repoke stamps kind: "denial-stall" and enforces one-shot cap
  const stall = factory.repoke("ASK-1", "peer-a");
  assert.equal(stall.outcome, "dispatched");
  assert.equal(stall.event.kind, "denial-stall");
  assert.equal(stall.event.message, undefined);

  const secondStall = factory.repoke("ASK-1", "peer-a", "   ");
  assert.equal(secondStall.outcome, "refused");
  assert.equal(secondStall.code, "already-spent");

  // Accepted task refuses recordPeerAsk
  await factory.claim({
    task: "ASK-1",
    sha,
    handoff: { outcome: "complete", scope: "done", verification: "true", unknowns: "none" },
  });
  await factory.accept({ task: "ASK-1", attempt: 1, accepted_by: "owner" });
  assert.throws(
    () =>
      factory.recordPeerAsk({
        task: "ASK-1",
        kind: "clarify",
        summary: "Late ask",
        source: "agent_ask",
      }),
    factoryErrorCode("already-accepted"),
  );

  // Closed task refuses recordPeerAsk
  factory.setContract({ task: "ASK-CLOSED", workspace, gate: "true" });
  await factory.close({ task: "ASK-CLOSED", reason: "superseded", by: "lead", authority: "lead" });
  assert.throws(
    () =>
      factory.recordPeerAsk({
        task: "ASK-CLOSED",
        kind: "blocked",
        summary: "Late ask on closed task",
        source: "agent_ask",
      }),
    factoryErrorCode("already-closed"),
  );
});

test("Ticket 03 core: admitClaim bypasses GateQueue for reopen, blocked, and partial outcomes", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const { workspace, sha: initSha } = makeWorkspace(dir);
  const proj = resolveProject(workspace);
  assert.ok(proj.ok);
  const factory = createFactory({ stateDir, projectSlug: proj.slug });
  const projDir = projectStateDir(stateDir, proj.slug);

  // Failing gate proves GateQueue/shell gate is never executed for handback claims
  factory.setContract({ task: "HB-ENG", workspace, gate: "exit 1" });

  // Dirty worktree should NOT block reopen/blocked engineer handback, even with omitted SHA
  writeFileSync(join(workspace, "src", "app.ts"), "export const v = 2; // uncommitted\n");

  const reopenRes = await factory.admitClaim({
    task: "HB-ENG",
    sha: "",
    agent: "peer-eng",
    handoff: {
      outcome: "reopen",
      scope: "inspected src/app.ts",
      verification: "reproduced mismatch against brief",
      unknowns: "Brief assumes v2 export already exists on main",
    },
  });
  assert.equal(reopenRes.status, "handback");
  assert.equal(reopenRes.event.event, "peer_asked");
  assert.equal(reopenRes.event.kind, "reopen_premise");
  assert.equal(reopenRes.event.source, "agent_claim");
  assert.equal(reopenRes.event.agent, "peer-eng");
  assert.equal(reopenRes.reportPath, join(projDir, `report-HB-ENG-ask-${reopenRes.event.seq}.md`));
  assert.ok(existsSync(reopenRes.reportPath));
  const reopenMd = readFileSync(reopenRes.reportPath, "utf8");
  assert.match(reopenMd, /- Outcome: reopen/);
  assert.match(reopenMd, /- Snapshot: commit `[0-9a-f]{40}` on branch `factory\/HB-ENG`/);
  assert.match(reopenMd, /- Unknown \/ risk: Brief assumes v2 export already exists on main/);
  assert.equal(hasUnansweredPeerAsk(factory.ledger.events, "HB-ENG"), true);

  // Zero Attempts opened, zero gate events emitted, lead accept refused
  const taskEvents = factory.ledger.eventsFor("HB-ENG");
  assert.equal(projectTask(taskEvents, "HB-ENG").maxAttempt, 0);
  assert.equal(
    taskEvents.some((e) => e.event === "gate_queued" || e.event === "claim_reported" || e.event === "gate_started" || e.event === "gate_finished"),
    false,
  );
  await assert.rejects(
    () => factory.accept({ task: "HB-ENG", attempt: 1, accepted_by: "lead", authority: "lead" }),
    factoryErrorCode("unknown-attempt"),
  );

  // Blocked handback without SHA also succeeds cleanly
  const blockedRes = await factory.admitClaim({
    task: "HB-ENG",
    sha: "",
    handoff: {
      outcome: "blocked",
      scope: "checked credentials",
      verification: "env check failed",
      unknowns: "Missing API token",
    },
  });
  assert.equal(blockedRes.status, "handback");
  assert.equal(blockedRes.event.kind, "blocked");
  assert.equal(projectTask(factory.ledger.eventsFor("HB-ENG"), "HB-ENG").maxAttempt, 0);

  // Partial handback validates supplied SHA when present, and resolves HEAD when omitted
  await assert.rejects(
    () =>
      factory.admitClaim({
        task: "HB-ENG",
        sha: "deadbeefdeadbeef",
        handoff: {
          outcome: "partial",
          scope: "part 1",
          verification: "slice test",
          unknowns: "remaining edge cases",
        },
      }),
    factoryErrorCode("invalid-claim"),
  );

  const commitSha = gitCommitChanges(workspace, "partial work");
  const partialRes = await factory.admitClaim({
    task: "HB-ENG",
    sha: commitSha.slice(0, 7),
    handoff: {
      outcome: "partial",
      scope: "implemented part 1",
      verification: "unit slice passed",
      unknowns: "part 2 needs split",
    },
  });
  assert.equal(partialRes.status, "handback");
  assert.equal(partialRes.event.kind, "partial");
  assert.equal(partialRes.snapshot.sha, commitSha);
  assert.equal(projectTask(factory.ledger.eventsFor("HB-ENG"), "HB-ENG").maxAttempt, 0);

  // Even after 3 RED attempts (attempt ceiling), handback still works without consuming an Attempt
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const redOutcome = await factory.claim({
      task: "HB-ENG",
      sha: commitSha,
      handoff: { outcome: "complete", scope: `try-${i + 1}`, verification: "ran", unknowns: "none" },
    });
    assert.equal(redOutcome.verdict, "red");
  }
  assert.equal(projectTask(factory.ledger.eventsFor("HB-ENG"), "HB-ENG").maxAttempt, MAX_ATTEMPTS);

  // Another complete claim hits attempt-ceiling, whereas reopen handback still succeeds!
  await assert.rejects(
    () =>
      factory.admitClaim({
        task: "HB-ENG",
        sha: commitSha,
        handoff: { outcome: "complete", scope: "try4", verification: "ran", unknowns: "none" },
      }),
    factoryErrorCode("attempt-ceiling"),
  );
  const ceilingHandback = await factory.admitClaim({
    task: "HB-ENG",
    sha: "",
    handoff: { outcome: "reopen", scope: "hit 3 reds", verification: "gate broken", unknowns: "Gate command invalid on HEAD" },
  });
  assert.equal(ceilingHandback.status, "handback");
  assert.equal(projectTask(factory.ledger.eventsFor("HB-ENG"), "HB-ENG").maxAttempt, MAX_ATTEMPTS);

  // Read-only disposition with non-complete outcome also returns handback without opening an Attempt
  const roDir = makeWorkspace(dir, "ws-ro");
  factory.setContract({ task: "HB-RO", workspace: roDir.workspace, disposition: "scout" });
  const roHandback = await factory.admitClaim({
    task: "HB-RO",
    sha: "",
    handoff: { outcome: "partial", scope: "scanned half", verification: "read-only", unknowns: "need deeper trace" },
  });
  assert.equal(roHandback.status, "handback");
  assert.equal(roHandback.snapshot.sha, roDir.sha);
  assert.equal(projectTask(factory.ledger.eventsFor("HB-RO"), "HB-RO").maxAttempt, 0);

  // Complete claim on read-only still executes synchronously and opens Attempt 1 GREEN
  const roComplete = await factory.admitClaim({
    task: "HB-RO",
    sha: "",
    handoff: { outcome: "complete", scope: "full scan", verification: "clean", unknowns: "none" },
  });
  assert.equal(roComplete.status, "executed");
  assert.equal(roComplete.outcome.verdict, "green");
  assert.equal(roComplete.outcome.attempt, 1);

  // Direct factory.claim() refuses handback outcomes cleanly
  await assert.rejects(
    () =>
      factory.claim({
        task: "HB-RO",
        sha: initSha,
        handoff: { outcome: "reopen", scope: "s", verification: "v", unknowns: "u" },
      }),
    factoryErrorCode("handback-requires-admit-claim"),
  );
});
