import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import type { PeerDisposition, PeerHandoffFields } from "../src/events.ts";
import { handleSpoolRequest, type ClaimRequest, type PeerMailHook } from "../plugin/server/spool.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const handoff: PeerHandoffFields = {
  outcome: "complete",
  scope: "Read src/factory.ts",
  verification: "Claim behavior checked",
  unknowns: "none",
};

function fixture(t: TestContext, disposition: PeerDisposition = "engineer") {
  const dir = makeTempDir("claim-replay-");
  disposeDir(t, dir);
  const workspace = join(dir, "repo");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "README.md"), "# isolated claim fixture\n");
  const sha = gitCommitAll(workspace);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir, timeoutMs: 2_000 });
  factory.setContract({ task: "REPLAY", workspace, disposition, gate: disposition === "engineer" ? "true" : "" });
  const mail: Parameters<PeerMailHook>[0][] = [];
  let request = 0;
  const claim = async (input: Pick<ClaimRequest, "handoff" | "mechanical"> = { handoff }) => {
    const reply = await handleSpoolRequest(factory, {
      id: `claim-${++request}`, kind: "claim", task: "REPLAY",
      // Exercise the read-only omitted-commit admission path too.
      ...(disposition === "engineer" ? { sha } : {}),
      ...input,
    }, { peerMail: async (item) => { mail.push(item); } });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply;
  };
  return { factory, stateDir, workspace, sha, mail, claim };
}

test("identical normalized same-SHA handoff replays without another Attempt, report, or Lead mail", { timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  const first = await f.claim();
  assert.equal(first.verdict, "green");
  const priorSeq = f.factory.ledger.events.at(-1)!.seq;
  const reports = readdirSync(f.stateDir).filter((file) => file.startsWith("report-"));
  // Admission defaults omitted ownership; object key order is immaterial.
  const duplicate = await f.claim({ handoff: {
    ownership: "lease returned", unknowns: "none", verification: "Claim behavior checked",
    scope: "Read src/factory.ts", outcome: "complete",
  } });
  assert.equal(duplicate.attempt, first.attempt);
  assert.equal(duplicate.reportPath, first.reportPath);
  assert.equal(f.factory.ledger.events.at(-1)!.seq, priorSeq);
  assert.deepEqual(readdirSync(f.stateDir).filter((file) => file.startsWith("report-")), reports);
  assert.equal(f.mail.length, 1);
});

for (const disposition of ["scout", "architect", "reviewer", "engineer"] as const) {
  test(`${disposition}: same-SHA updated handoff opens a new Attempt, persists its report, and wakes Lead`, { timeout: 10_000 }, async (t) => {
    const f = fixture(t, disposition);
    const first = await f.claim();
    assert.equal(first.verdict, "green");
    const priorSeq = f.factory.ledger.events.at(-1)!.seq;
    const updated = await f.claim({ handoff: { ...handoff, verification: "Updated verification: regression reproduced and fixed" } });
    assert.equal(updated.attempt, 2);
    assert.equal(updated.verdict, "green");
    const claim = f.factory.ledger.eventsFor("REPLAY").findLast((event) => event.event === "claim_reported");
    assert.ok(claim && claim.seq > priorSeq);
    assert.equal(basename(updated.reportPath!), "report-REPLAY-2.md");
    assert.match(readFileSync(updated.reportPath!, "utf8"), /Updated verification: regression reproduced and fixed/);
    assert.equal(f.mail.length, 2);
    assert.match(f.mail[1]!.text, /Updated verification: regression reproduced and fixed/);
    const lastSeq = f.factory.ledger.events.at(-1)!.seq;
    assert.equal((await f.claim({ handoff: { ...handoff, verification: "Updated verification: regression reproduced and fixed" } })).attempt, 2);
    assert.equal(f.factory.ledger.events.at(-1)!.seq, lastSeq);
    assert.equal(f.mail.length, 2, "retrying the update itself remains idempotent");
  });

  test(`${disposition}: a repoke after GREEN opens a new Attempt even with an identical handoff`, { timeout: 10_000 }, async (t) => {
    const f = fixture(t, disposition);
    // An earlier poke is already answered by the first Attempt.
    f.factory.repoke("REPLAY", "peer", "Initial reconciliation");
    const first = await f.claim();
    assert.equal(first.verdict, "green");
    assert.equal((await f.claim()).attempt, 1);
    const poke = f.factory.repoke("REPLAY", "peer", "Reconcile the prior GREEN");
    assert.equal(poke.outcome, "dispatched");
    const priorSeq = f.factory.ledger.events.at(-1)!.seq;
    const next = await f.claim();
    assert.equal(next.attempt, 2);
    assert.equal(next.verdict, "green");
    const claim = f.factory.ledger.eventsFor("REPLAY").findLast((event) => event.event === "claim_reported");
    assert.ok(claim && claim.seq > priorSeq);
    assert.equal(basename(next.reportPath!), "report-REPLAY-2.md");
    assert.match(readFileSync(next.reportPath!, "utf8"), /Claim behavior checked/);
    assert.equal(f.mail.length, 2);
    assert.match(f.mail[1]!.text, /attempt 2 ended GREEN/);
    assert.match(f.mail[1]!.text, /Claim behavior checked/);
    const lastSeq = f.factory.ledger.events.at(-1)!.seq;
    assert.equal((await f.claim()).attempt, 2);
    assert.equal(f.factory.ledger.events.at(-1)!.seq, lastSeq);
    assert.equal(f.mail.length, 2, "the answered poke does not invalidate later retries");
  });
}

for (const [field, value] of [
  ["outcome", "partial"], ["scope", "Read src/factory.ts and src/report.ts"],
  ["unknowns", "Live daemon unverified"], ["ownership", "Lead owns review"],
  ["verification", " Claim behavior checked "],
] as const) {
  test(`changing ${field} is a genuine update (handoff text stays exact)`, { timeout: 10_000 }, async (t) => {
    const f = fixture(t, "scout");
    await f.claim();
    const updated = { ...handoff, [field]: value };
    const next = await f.claim({ handoff: updated });
    assert.equal(next.attempt, 2);
    const recorded = f.factory.ledger.eventsFor("REPLAY").findLast((event) => event.event === "claim_reported");
    assert.equal(recorded?.handoff?.[field], value);
    assert.ok(readFileSync(next.reportPath!, "utf8").includes(value));
    assert.ok(f.mail[1]!.text.includes(value));
  });
}

test("mechanical marker changes open normal Attempts; identical mechanical retries replay", { timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  await f.claim();
  const mechanical = await f.claim({ mechanical: "lead_verify" });
  assert.equal(mechanical.attempt, 2);
  assert.equal(mechanical.verdict, "green");
  assert.equal(f.mail.length, 2);
  const priorSeq = f.factory.ledger.events.at(-1)!.seq;
  assert.equal((await f.claim({ mechanical: "lead_verify" })).attempt, 2);
  assert.equal(f.factory.ledger.events.at(-1)!.seq, priorSeq);
  assert.equal(f.mail.length, 2);
  assert.equal((await f.claim()).attempt, 3, "returning from mechanical to Peer handoff is another update");
  assert.equal(f.mail.length, 3);
});

test("genuine updates obey MAX_ATTEMPTS while true duplicates still replay at the ceiling", { timeout: 10_000 }, async (t) => {
  const f = fixture(t, "reviewer");
  await f.claim();
  await f.claim({ handoff: { ...handoff, verification: "Second verification" } });
  const thirdHandoff = { ...handoff, verification: "Third verification" };
  assert.equal((await f.claim({ handoff: thirdHandoff })).attempt, 3);
  const priorSeq = f.factory.ledger.events.at(-1)!.seq;
  assert.equal((await f.claim({ handoff: thirdHandoff })).attempt, 3);
  const refused = await handleSpoolRequest(f.factory, {
    id: "ceiling-update", kind: "claim", task: "REPLAY", handoff: { ...handoff, verification: "Fourth verification" },
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "attempt-ceiling");
  assert.equal(f.factory.ledger.events.at(-1)!.seq, priorSeq);
  f.factory.repoke("REPLAY", "peer", "Reconcile at the ceiling");
  const pokeSeq = f.factory.ledger.events.at(-1)!.seq;
  const repoked = await handleSpoolRequest(f.factory, {
    id: "ceiling-poke", kind: "claim", task: "REPLAY", handoff: thirdHandoff,
  });
  assert.equal(repoked.ok, false);
  if (!repoked.ok) assert.equal(repoked.code, "attempt-ceiling");
  assert.equal(f.factory.ledger.events.at(-1)!.seq, pokeSeq);
  assert.equal(f.mail.length, 3);
});

for (const trigger of ["handoff", "repoke"] as const) {
  test(`read-only ${trigger} update runs clean-tree reconciliation instead of replaying GREEN`, { timeout: 10_000 }, async (t) => {
    const f = fixture(t, "architect");
    await f.claim();
    writeFileSync(join(f.workspace, "README.md"), "dirty after the prior GREEN\n");
    if (trigger === "repoke") f.factory.repoke("REPLAY", "peer", "Reconcile the dirty tree");
    const next = await f.claim({ handoff: trigger === "handoff" ? { ...handoff, unknowns: "Tree changed" } : handoff });
    assert.equal(next.attempt, 2);
    assert.equal(next.verdict, "red");
    assert.match(next.note!, /dirty-worktree-before-gate/);
    assert.match(readFileSync(next.reportPath!, "utf8"), /dirty-worktree-before-gate/);
    assert.equal(f.mail.length, 2);
    assert.match(f.mail[1]!.text, /attempt 2 ended RED/);
  });
}
