import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ackLeadMail,
  deliverLeadMail,
  enqueueLeadMail,
  foldLeadMailboxEvents,
  readLeadMailbox,
  recoverLeadMailbox,
  requeueLeadMail,
} from "../src/index.ts";
import type { LeadMailboxEvent, LeadMailboxState } from "../src/index.ts";
import { disposeDir, factoryErrorCode, makeTempDir } from "./helpers.ts";

/** Parses one mailbox line and drops the clock-dependent `ts` so asserts stay exact. */
function lineWithoutTs(line: string): Record<string, unknown> {
  const { ts, ...rest } = JSON.parse(line) as { ts?: unknown };
  assert.match(String(ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "ts is an ISO 8601 timestamp");
  return rest;
}

/** Reads a mailbox.jsonl from disk into events — the "fresh process" view of the file. */
function parseLines(path: string): LeadMailboxEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LeadMailboxEvent);
}

/** A raw hand-written line, for sequences the writer itself refuses to produce. */
function rawLine(seq: number, event: Record<string, unknown>): string {
  return JSON.stringify({ seq, ts: `2026-10-19T10:00:${String(seq - 1).padStart(2, "0")}.000Z`, ...event });
}

test("three enqueues batch into one delivery; one ack closes the batch", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "mailbox.jsonl");

  const a = enqueueLeadMail(path, { from: "supervisor", kind: "directive", text: "ship the fold" });
  const b = enqueueLeadMail(path, { from: "owner", kind: "directive", task: "T1", text: "second directive" });
  const c = enqueueLeadMail(path, { from: "peer", kind: "verdict", task: "T2", text: "green" });

  assert.equal(a.type, "mail_queued");
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3], "seq is prior-max+1 per append");
  assert.ok(a.mailId !== b.mailId && b.mailId !== c.mailId, "mailId is generated per item");

  let state = readLeadMailbox(path);
  assert.deepEqual(state.queued.map((m) => m.mailId), [a.mailId, b.mailId, c.mailId]);
  assert.deepEqual(state.queued.map((m) => m.status), ["queued", "queued", "queued"]);
  assert.equal(state.queued[1]?.task, "T1", "task rides along when present");
  assert.ok(!("task" in (state.queued[0] ?? {})), "task is absent, not undefined, when never given");
  assert.deepEqual(
    state.queued[0],
    { mailId: a.mailId, seq: 1, ts: a.ts, from: "supervisor", kind: "directive", text: "ship the fold", status: "queued" },
  );
  assert.equal(state.inFlight, null);
  assert.equal(state.ackedCount, 0);

  const delivery = deliverLeadMail(path, { mailIds: state.queued.map((m) => m.mailId), toAgentId: "lead-7" });
  assert.equal(delivery.type, "mail_delivered");
  assert.ok(delivery.deliveryId.length > 0, "deliveryId is generated");

  state = readLeadMailbox(path);
  assert.deepEqual(state, {
    queued: [],
    inFlight: {
      deliveryId: delivery.deliveryId,
      toAgentId: "lead-7",
      items: state.inFlight?.items ?? [],
    },
    ackedCount: 0,
  } satisfies LeadMailboxState);
  assert.deepEqual(state.inFlight?.items.map((m) => m.mailId), [a.mailId, b.mailId, c.mailId], "the batch carries all three");
  assert.ok(state.inFlight?.items.every((m) => m.status === "delivered" && m.deliveryId === delivery.deliveryId && m.toAgentId === "lead-7"));

  const ack = ackLeadMail(path, { deliveryId: delivery.deliveryId, mailIds: delivery.mailIds, byAgentId: "lead-7" });
  assert.equal(ack.type, "mail_acked");
  assert.deepEqual(readLeadMailbox(path), { queued: [], inFlight: null, ackedCount: 3 });

  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 5, "one line per event");
  assert.deepEqual(lineWithoutTs(lines[0]!), { seq: 1, type: "mail_queued", mailId: a.mailId, from: "supervisor", kind: "directive", text: "ship the fold" });
  assert.deepEqual(lineWithoutTs(lines[3]!), { seq: 4, type: "mail_delivered", deliveryId: delivery.deliveryId, mailIds: [a.mailId, b.mailId, c.mailId], toAgentId: "lead-7" });
  assert.deepEqual(lineWithoutTs(lines[4]!), { seq: 5, type: "mail_acked", deliveryId: delivery.deliveryId, mailIds: [a.mailId, b.mailId, c.mailId], byAgentId: "lead-7" });
});

test("requeue on failure returns the batch to queued; a later delivery re-batches them", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "mailbox.jsonl");

  const a = enqueueLeadMail(path, { from: "supervisor", kind: "directive", text: "first" });
  const b = enqueueLeadMail(path, { from: "supervisor", kind: "directive", text: "second" });
  const delivery = deliverLeadMail(path, { mailIds: [a.mailId, b.mailId], toAgentId: "lead-7" });

  // A peer verdict lands while Lead is mid-turn (§User Story 12): it waits in queued.
  const c = enqueueLeadMail(path, { from: "peer", kind: "needs_human", task: "T3", text: "stuck" });
  let state = readLeadMailbox(path);
  assert.deepEqual(state.queued.map((m) => m.mailId), [c.mailId], "enqueue while in flight is legal — it waits");

  // The turn fails: the whole batch comes back.
  const requeued = requeueLeadMail(path, { deliveryId: delivery.deliveryId, mailIds: delivery.mailIds, reason: "failed" });
  assert.equal(requeued.type, "mail_requeued");
  assert.equal(requeued.reason, "failed");

  state = readLeadMailbox(path);
  assert.equal(state.inFlight, null);
  assert.equal(state.ackedCount, 0);
  assert.deepEqual(state.queued.map((m) => m.mailId), [a.mailId, b.mailId, c.mailId], "FIFO by enqueue seq, none lost");
  assert.ok(state.queued.every((m) => m.status === "queued" && m.deliveryId === undefined));

  // A later delivery re-batches all three and the ack closes them.
  const redelivery = deliverLeadMail(path, { mailIds: state.queued.map((m) => m.mailId), toAgentId: "lead-7" });
  ackLeadMail(path, { deliveryId: redelivery.deliveryId, mailIds: redelivery.mailIds, byAgentId: "lead-7" });
  assert.deepEqual(readLeadMailbox(path), { queued: [], inFlight: null, ackedCount: 3 });
});

test("requeue on rotation: recoverLeadMailbox returns an un-acked in-flight batch with the caller's reason", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "mailbox.jsonl");

  const a = enqueueLeadMail(path, { from: "supervisor", kind: "directive", text: "first" });
  const b = enqueueLeadMail(path, { from: "peer", kind: "verdict", task: "T2", text: "green" });
  const delivery = deliverLeadMail(path, { mailIds: [a.mailId, b.mailId], toAgentId: "lead-old" });

  const appended = recoverLeadMailbox(path, "lead-rotated");
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.type, "mail_requeued");
  assert.equal(appended[0]!.reason, "lead-rotated");
  assert.equal(appended[0]!.deliveryId, delivery.deliveryId);
  assert.deepEqual(appended[0]!.mailIds, [a.mailId, b.mailId]);

  const state = readLeadMailbox(path);
  assert.equal(state.inFlight, null);
  assert.deepEqual(state.queued.map((m) => m.mailId), [a.mailId, b.mailId], "the successor Lead finds the batch back in queued");
});

test("restart-safety: a fresh fold reproduces the state; recovery appends exactly one requeue, never two", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "mailbox.jsonl");

  const a = enqueueLeadMail(path, { from: "supervisor", kind: "directive", text: "first" });
  const b = enqueueLeadMail(path, { from: "supervisor", kind: "directive", text: "second" });
  deliverLeadMail(path, { mailIds: [a.mailId, b.mailId], toAgentId: "lead-7" });
  const c = enqueueLeadMail(path, { from: "peer", kind: "verdict", task: "T9", text: "green" });

  // Simulated process death mid-delivery: everything after this is a cold read of the same file.
  const events = parseLines(path);
  const folded = foldLeadMailboxEvents(events);
  assert.deepEqual(folded, readLeadMailbox(path), "the pure fold over the file's events is the file's state");
  assert.deepEqual(readLeadMailbox(path), readLeadMailbox(path), "a fresh fold is deterministic");

  const first = recoverLeadMailbox(path, "daemon-restart");
  assert.equal(first.length, 1, "exactly one mail_requeued on boot");
  assert.equal(first[0]!.reason, "daemon-restart");
  assert.equal(first[0]!.deliveryId, folded.inFlight?.deliveryId);

  const recovered = readLeadMailbox(path);
  assert.equal(recovered.inFlight, null);
  assert.deepEqual(recovered.queued.map((m) => m.mailId), [a.mailId, b.mailId, c.mailId], "no message lost across the restart");

  // A second boot finds nothing in flight and must not duplicate the requeue.
  assert.deepEqual(recoverLeadMailbox(path, "daemon-restart"), []);
  assert.equal(readFileSync(path, "utf8").trimEnd().split("\n").length, 5, "still five events: 3 queued + delivered + requeued");
});

test("the fold tolerates what the writer prevents: a second delivery, and settles naming the wrong batch", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "mailbox.jsonl");
  writeFileSync(
    path,
    [
      rawLine(1, { type: "mail_queued", mailId: "m1", from: "supervisor", kind: "directive", text: "one" }),
      rawLine(2, { type: "mail_queued", mailId: "m2", from: "peer", kind: "verdict", task: "T2", text: "green" }),
      rawLine(3, { type: "mail_delivered", deliveryId: "d1", mailIds: ["m1", "m2"], toAgentId: "lead-1" }),
      rawLine(4, { type: "mail_delivered", deliveryId: "d2", mailIds: ["m1", "m2"], toAgentId: "lead-2" }),
      rawLine(5, { type: "mail_acked", deliveryId: "d9", mailIds: ["m1"], byAgentId: "lead-9" }),
      rawLine(6, { type: "mail_requeued", deliveryId: "d8", mailIds: ["m1"], reason: "stray" }),
      rawLine(7, { type: "mail_acked", deliveryId: "d1", mailIds: ["m1", "m2"], byAgentId: "lead-1" }),
    ].join("\n") + "\n",
  );

  const state = readLeadMailbox(path);
  assert.equal(state.inFlight, null, "the first delivery was settled by its own ack");
  assert.equal(state.ackedCount, 2, "the impossible lines changed nothing");
  assert.deepEqual(state.queued, []);
});

test("the writer prevents impossibilities the fold merely tolerates", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "mailbox.jsonl");

  const a = enqueueLeadMail(path, { from: "supervisor", kind: "directive", text: "only" });

  // On an idle mailbox, malformed deliveries are refused outright.
  assert.throws(() => deliverLeadMail(path, { mailIds: [], toAgentId: "lead-8" }), factoryErrorCode("mailbox-empty-delivery"), "no empty delivery");
  assert.throws(() => deliverLeadMail(path, { mailIds: ["ghost"], toAgentId: "lead-8" }), factoryErrorCode("mailbox-unknown-mail"), "no delivering mail that is not queued");
  assert.throws(() => ackLeadMail(path, { deliveryId: "dX", mailIds: [a.mailId], byAgentId: "lead-7" }), factoryErrorCode("mailbox-idle"), "no acking with nothing live");

  const delivery = deliverLeadMail(path, { mailIds: [a.mailId], toAgentId: "lead-7" });
  const before = readFileSync(path, "utf8");

  assert.throws(() => deliverLeadMail(path, { mailIds: [a.mailId], toAgentId: "lead-8" }), factoryErrorCode("mailbox-in-flight"), "no second live delivery");
  assert.throws(() => ackLeadMail(path, { deliveryId: "dX", mailIds: [a.mailId], byAgentId: "lead-7" }), factoryErrorCode("mailbox-idle"), "no acking a delivery that is not live");
  assert.throws(() => requeueLeadMail(path, { deliveryId: delivery.deliveryId, mailIds: ["ghost"], reason: "failed" }), factoryErrorCode("mailbox-unknown-mail"), "settle must name exactly the live batch");

  ackLeadMail(path, { deliveryId: delivery.deliveryId, mailIds: delivery.mailIds, byAgentId: "lead-7" });
  assert.throws(() => requeueLeadMail(path, { deliveryId: delivery.deliveryId, mailIds: delivery.mailIds, reason: "late" }), factoryErrorCode("mailbox-idle"), "nothing live after the ack");
  assert.equal(readFileSync(path, "utf8").trimEnd().split("\n").length, 3, "every refusal appended nothing");
  assert.ok(readFileSync(path, "utf8").startsWith(before), "earlier lines never change");
});

test("a corrupted mailbox is refused, not guessed at", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const good = rawLine(1, { type: "mail_queued", mailId: "m1", from: "supervisor", kind: "directive", text: "one" });

  const cases: [string, string][] = [
    ["garbage JSON", '{"seq":1,"ts":"2026-10-19T10:00:00.000Z","type":"mail_queued"\n'],
    ["a repeated seq", `${good}\n${rawLine(1, { type: "mail_queued", mailId: "m2", from: "owner", kind: "directive", text: "two" })}\n`],
    ["an unknown sender", `${good}\n${rawLine(2, { type: "mail_queued", mailId: "m2", from: "intern", kind: "directive", text: "two" })}\n`],
    ["an unknown kind", `${good}\n${rawLine(2, { type: "mail_queued", mailId: "m2", from: "owner", kind: "memo", text: "two" })}\n`],
    ["an unknown event type", `${good}\n${rawLine(2, { type: "mail_lost", mailId: "m2" })}\n`],
    ["a blank line mid-file", `${good}\n\n${rawLine(2, { type: "mail_queued", mailId: "m2", from: "owner", kind: "directive", text: "two" })}\n`],
    ["queued mail without text", `${rawLine(1, { type: "mail_queued", mailId: "m1", from: "supervisor", kind: "directive" })}\n`],
    ["delivered with an empty batch", `${good}\n${rawLine(2, { type: "mail_delivered", deliveryId: "d1", mailIds: [], toAgentId: "lead-1" })}\n`],
    ["an event without ts", `${JSON.stringify({ seq: 1, type: "mail_queued", mailId: "m1", from: "supervisor", kind: "directive", text: "one" })}\n`],
  ];
  for (const [name, contents] of cases) {
    const each = makeTempDir();
    disposeDir(t, each);
    const path = join(each, "mailbox.jsonl");
    writeFileSync(path, contents);
    assert.throws(() => readLeadMailbox(path), factoryErrorCode("corrupted-mailbox"), name);
    assert.throws(() => enqueueLeadMail(path, { from: "owner", kind: "directive", text: "x" }), factoryErrorCode("corrupted-mailbox"), `${name} — the writer re-reads before appending`);
  }
});

test("an unterminated tail is quarantined and dropped, never trusted or lost", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "mailbox.jsonl");
  const complete = `${rawLine(1, { type: "mail_queued", mailId: "m1", from: "supervisor", kind: "directive", text: "one" })}\n`;
  writeFileSync(path, `${complete}{"seq":2,"ts":"2026-10-19T10:00:01.000Z","type":"mail_delivered","deli`);

  const state = readLeadMailbox(path);
  assert.deepEqual(state.queued.map((m) => m.mailId), ["m1"], "the torn line is not an event");
  assert.equal(readFileSync(path, "utf8"), complete, "the mailbox keeps only complete lines");
  assert.equal(
    readFileSync(`${path}.quarantine`, "utf8"),
    '{"seq":2,"ts":"2026-10-19T10:00:01.000Z","type":"mail_delivered","deli\n',
    "the tail is kept verbatim for inspection",
  );
  const next = enqueueLeadMail(path, { from: "owner", kind: "directive", text: "two" });
  assert.equal(next.seq, 2, "the dropped line's seq is free again — it was never acknowledged");
});

test("a missing mailbox is an empty state; a nested path is created on first append", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const nested = join(dir, "deep", "project-state");
  const path = join(nested, "mailbox.jsonl");

  assert.deepEqual(readLeadMailbox(path), { queued: [], inFlight: null, ackedCount: 0 });
  assert.deepEqual(recoverLeadMailbox(path, "daemon-restart"), [], "nothing to recover on a fresh Project");

  const evt = enqueueLeadMail(path, { from: "system", kind: "directive", text: "kickoff" });
  assert.equal(evt.seq, 1);
  assert.equal(readFileSync(path, "utf8").trimEnd().split("\n").length, 1);
});
