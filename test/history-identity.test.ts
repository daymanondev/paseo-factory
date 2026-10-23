import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLedgerEvents as standaloneRead } from "../plugin/bin/ledger-read.mjs";
import { Ledger, parseLedgerJsonl } from "../src/ledger.ts";
import { classifyEventIdentities, planLegacyIdentity, remapLedgerReferences } from "../src/history-identity.ts";
import { createFactory } from "../src/factory.ts";
import { buildRetroDigest, parseRetroProposals } from "../src/retro.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const contract = { event: "contract_set", task: "T", workspace: "/workspace", gate: "true", artifact: "out" } as const;

test("legacy identity preparation preserves local addresses and unknown historical origin", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  const legacy = Ledger.open(path);
  legacy.append({ ...contract, by: "lead-agent-previously-delegated" });
  legacy.append({ event: "claim_reported", task: "T", attempt: 1, sha: "abc" });
  const raw = readFileSync(path, "utf8");
  const plan = planLegacyIdentity(raw, { holderId: "copied-snapshot-holder", writerId: "local-writer" });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.events.filter((event) => event.event !== "ledger_schema").map((event) => event.seq), [1, 2]);
  assert.equal(plan.events[0]!.provenance?.writer_id, null);
  assert.equal(plan.events[0]!.event === "contract_set" && plan.events[0]!.by, "lead-agent-previously-delegated");
  assert.equal(plan.source.holderId, "copied-snapshot-holder");
  assert.equal(readFileSync(path, "utf8"), raw, "preparation never activates an upgrade");
  assert.deepEqual(planLegacyIdentity(raw, { holderId: "copied-snapshot-holder", writerId: "local-writer" }), plan);
});

test("prepared v2 history reopens with stable identities and new Attempts bind to their Contract epoch", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  const legacy = Ledger.open(path);
  legacy.append(contract);
  legacy.append({ event: "claim_reported", task: "T", attempt: 1, sha: "first" });
  const plan = planLegacyIdentity(readFileSync(path, "utf8"), { writerId: "this-writer" });
  writeFileSync(path, plan.events.map((event) => JSON.stringify(event) + "\n").join(""));
  const upgraded = Ledger.open(path, { writerId: "this-writer" });
  const secondContract = upgraded.append(contract);
  const secondClaim = upgraded.append({ event: "claim_reported", task: "T", attempt: 1, sha: "second" });
  assert.equal(secondContract.epoch_id, secondContract.event_id);
  assert.equal(secondClaim.epoch_id, secondContract.event_id);
  assert.notEqual(secondClaim.epoch_id, plan.events[1]!.epoch_id);
  assert.equal(secondClaim.provenance?.writer_id, "this-writer");
  const reopened = Ledger.open(path);
  assert.deepEqual(reopened.events.map((event) => event.event_id), upgraded.events.map((event) => event.event_id));
  assert.deepEqual(reopened.events.map((event) => event.seq), [1, 2, 3, 4, 5]);
  const standalone = standaloneRead(path);
  assert.ok("events" in standalone);
  if ("events" in standalone) assert.deepEqual(standalone.events, reopened.events);
});

test("persisted legacy mapping survives source growth and refuses damaged earlier assignments", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  const legacy = Ledger.open(path);
  legacy.append(contract);
  const original = planLegacyIdentity(readFileSync(path, "utf8"), { writerId: "writer" });
  legacy.append({ event: "claim_reported", task: "T", attempt: 1, sha: "next" });
  const grownRaw = readFileSync(path, "utf8");
  const grown = planLegacyIdentity(grownRaw, { writerId: "writer", holderId: "second-copy", previous: JSON.parse(JSON.stringify(original.mapping)) });
  assert.equal(grown.ok, true);
  assert.equal(grown.events[0]!.event_id, original.events[0]!.event_id);
  assert.equal(grown.events[1]!.epoch_id, original.events[0]!.event_id);
  assert.deepEqual(planLegacyIdentity(grownRaw, { writerId: "writer", holderId: "second-copy", previous: original.mapping }), grown);
  const damaged = structuredClone(original.mapping);
  damaged.entries[0]!.eventId = "invented-previous-target";
  const refused = planLegacyIdentity(grownRaw, { writerId: "writer", previous: damaged });
  assert.equal(refused.ok, false, "a broken prior assignment must not silently get repaired");
  assert.match(refused.conflicts.join("\n"), /mapping/);
  const changed = grownRaw.replace('"gate":"true"', '"gate":"false"');
  assert.equal(planLegacyIdentity(changed, { writerId: "writer", previous: original.mapping }).ok, false, "common prefix must be demonstrated");
});


test("numeric Needs-human references resolve by stable identity while Attempt ordinals remain unchanged", () => {
  const ts = "2026-10-23T00:00:00.000Z";
  const rows = [
    { seq: 10, ts, ...contract },
    { seq: 20, ts, event: "permit_denied", task: "T", agent: "peer", name: "Write", kind: "tool", rule: "scope", reason: "denied" },
    { seq: 30, ts, event: "repoke_dispatched", task: "T", agent: "peer" },
    { seq: 40, ts, event: "needs_human", task: "T", reason: "denied-again", evidence: { denial: 20, repoke: 30 } },
    { seq: 50, ts, event: "gate_finished", task: "T", attempt: 3, verdict: "red", exit: 1, note: "failed" },
    { seq: 60, ts, event: "needs_human", task: "T", reason: "attempt-ceiling", evidence: { attempt: 3, gate: 50 } },
    { seq: 70, ts, event: "spawn_dispatched", task: "T", provider: "claude", arity: 1 },
    { seq: 80, ts, event: "respawn_dispatched", task: "T", provider: "claude", died_agent: "peer" },
    { seq: 90, ts, event: "needs_human", task: "T", reason: "died-after-respawn", evidence: { spawn: 70, respawn: 80 } },
  ];
  const prepared = planLegacyIdentity(rows.map((row) => JSON.stringify(row) + "\n").join(""), { writerId: "receiver" });
  assert.equal(prepared.ok, true);
  const local = prepared.events.map((event) => ({ ...event, seq: event.seq + 1000 }));
  const expectations = [{ denial: 1020, repoke: 1030 }, { attempt: 3, gate: 1050 }, { spawn: 1070, respawn: 1080 }];
  for (const [index, event] of prepared.events.filter((event) => event.event === "needs_human").entries()) {
    const mapped = remapLedgerReferences(event, prepared.events, local);
    assert.equal(mapped.ok, true);
    if (mapped.ok) {
      assert.equal(mapped.event.event, "needs_human");
      if (mapped.event.event === "needs_human") assert.deepEqual(mapped.event.evidence, expectations[index]);
    }
  }
  assert.deepEqual(prepared.events.filter((event) => event.event !== "ledger_schema").map((event) => event.seq), [10, 20, 30, 40, 50, 60, 70, 80, 90]);
});


test("same stable identity deduplicates semantic facts across local numbering and reports contradictions", () => {
  const ts = "2026-10-23T00:00:00.000Z";
  const rows = [
    { seq: 1, ts, ...contract },
    { seq: 2, ts, event: "permit_denied", task: "T", agent: "peer", name: "Write", kind: "tool", rule: "scope", reason: "denied" },
    { seq: 3, ts, event: "repoke_dispatched", task: "T", agent: "peer" },
    { seq: 4, ts, event: "needs_human", task: "T", reason: "denied-again", evidence: { denial: 2, repoke: 3 } },
  ];
  const source = planLegacyIdentity(rows.map((row) => JSON.stringify(row) + "\n").join(""), { writerId: "writer" }).events;
  const allocated = source.map((event) => ({ ...event, seq: event.seq + 100 }));
  const local = allocated.map((event, index) => {
    const result = remapLedgerReferences(source[index]!, source, allocated);
    assert.ok(result.ok);
    return { ...result.event, seq: event.seq };
  });
  const duplicate = classifyEventIdentities(local, source);
  assert.equal(duplicate.additions.length, 0);
  assert.equal(duplicate.conflicts.length, 0);
  assert.equal(duplicate.duplicates.length, 4);
  const contradicted = structuredClone(source);
  const denied = contradicted.find((event) => event.event === "permit_denied")!;
  if (denied.event === "permit_denied") denied.rule = "forged-scope";
  const conflict = classifyEventIdentities(local, contradicted);
  assert.match(conflict.conflicts.map((item) => item.reason).join("\n"), /contradictory/);
  const independent = { ...source[2]!, event_id: "independent-repeat-action" };
  assert.equal(classifyEventIdentities(local, [independent]).additions.length, 1, "identical actions with distinct identities remain distinct facts");
});


test("explicit v2 preparation fences shipped older writers without renumbering local history", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "upgraded.jsonl");
  const withoutFence = join(dir, "metadata-only.jsonl");
  const raw = JSON.stringify({ seq: 12, ts: "2026-10-23T00:00:00.000Z", ...contract }) + "\n";
  const plan = planLegacyIdentity(raw, { writerId: "current-writer" });
  writeFileSync(path, plan.events.map((event) => JSON.stringify(event) + "\n").join(""));
  writeFileSync(withoutFence, plan.events.filter((event) => event.event !== "ledger_schema").map((event) => JSON.stringify(event) + "\n").join(""));
  const fixture = new URL("./fixtures/schema-v1-ledger-writer.mjs", import.meta.url).href;
  const observed = execFileSync(process.execPath, ["--input-type=module", "-e", `import {Ledger} from ${JSON.stringify(fixture)}; const metadata=Ledger.open(process.argv[1]); let refused; try {Ledger.open(process.argv[2]);} catch(error) {refused=error.code;} console.log(JSON.stringify({metadataAccepted:metadata.events.length,refused}));`, withoutFence, path], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(observed), { metadataAccepted: 1, refused: "corrupted-ledger" });
  assert.deepEqual(Ledger.open(path).events.map((event) => event.seq), [12, 13]);
  const empty = planLegacyIdentity("", { writerId: "new-writer" });
  assert.equal(empty.ok, true);
  assert.equal(empty.events.length, 1);
  assert.equal(empty.events[0]!.event, "ledger_schema");
});

test("versioned reader refuses missing fences, invalid identity metadata and unknown versions", () => {
  const prepared = planLegacyIdentity(JSON.stringify({ seq: 1, ts: "2026-10-23T00:00:00.000Z", ...contract }) + "\n", { writerId: "writer" }).events;
  for (const mutate of [
    (events: unknown[]) => { events.pop(); },
    (events: unknown[]) => { delete (events[0] as Record<string, unknown>).event_id; },
    (events: unknown[]) => { (events[0] as Record<string, unknown>).schema_version = 99; },
    (events: unknown[]) => { (events[0] as Record<string, unknown>).provenance = { writer_id: 3 }; },
    (events: unknown[]) => { (events[0] as Record<string, unknown>).epoch_id = "unrelated-epoch"; },
    (events: unknown[]) => { events.push({ ...events[0]!, seq: 3 }); },
  ]) {
    const events = structuredClone(prepared);
    mutate(events);
    const result = parseLedgerJsonl(events.map((event) => JSON.stringify(event) + "\n").join(""));
    assert.ok(result.corrupt, "unsafe versioned state must be refused");
  }
});

test("ambiguous or broken source references stay unresolved rather than selecting plausible local evidence", () => {
  const ts = "2026-10-23T00:00:00.000Z";
  const rows = [
    { seq: 1, ts, ...contract },
    { seq: 2, ts, event: "repoke_dispatched", task: "T", agent: "peer" },
    { seq: 3, ts, event: "needs_human", task: "T", reason: "denied-again", evidence: { denial: 2, repoke: 2 } },
  ];
  const raw = rows.map((row) => JSON.stringify(row) + "\n").join("");
  const wrongKind = planLegacyIdentity(raw, { writerId: "writer" });
  assert.equal(wrongKind.ok, false);
  assert.match(wrongKind.conflicts.join("\n"), /not permit_denied/);
  const missing = planLegacyIdentity(raw.replace('"denial":2', '"denial":88'), { writerId: "writer" });
  assert.equal(missing.ok, false);
  assert.match(missing.conflicts.join("\n"), /unambiguous stable identity/);
});


test("v2 re-contract preserves both epochs' Report and Gate evidence at Attempt 1", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "repo");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "out"), "artifact\n");
  const sha = gitCommitAll(workspace);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir);
  const plan = planLegacyIdentity("", { writerId: "writer" });
  writeFileSync(join(stateDir, "ledger.jsonl"), plan.events.map((event) => JSON.stringify(event) + "\n").join(""));
  const factory = createFactory({ stateDir, writerId: "writer" });
  factory.setContract({ ...contract, workspace, gate: "printf first" });
  const first = await factory.claim({ task: "T", sha });
  const firstReport = readFileSync(first.reportPath, "utf8");
  const firstLog = readFileSync(first.gate.outputPath!, "utf8");
  factory.setContract({ ...contract, workspace, gate: "printf second" });
  const second = await factory.claim({ task: "T", sha });
  assert.notEqual(first.reportPath, second.reportPath, "a new epoch must not overwrite earlier Report bytes");
  assert.notEqual(first.gate.outputPath, second.gate.outputPath);
  assert.equal(readFileSync(first.reportPath, "utf8"), firstReport);
  assert.equal(readFileSync(first.gate.outputPath!, "utf8"), firstLog);
  assert.equal(firstLog, "first");
  assert.equal(readFileSync(second.gate.outputPath!, "utf8"), "second");
  const corpus = buildRetroDigest(factory.ledger.events, stateDir);
  const cited = parseRetroProposals(JSON.stringify({ proposals: [{ class: "observation", evidence: [first.gate.seq], pattern: "first epoch", text: "preserved evidence" }] }), corpus.knownSeqs);
  assert.equal(cited.ok, true, "existing numeric citations still resolve after a new epoch");
});

test("identified snapshots keep IDs through export, copy, retry and continuation mapping", () => {
  const ts = "2026-10-23T00:00:00.000Z";
  const raw = [
    { seq: 1, ts, ...contract },
    { seq: 2, ts, event: "repoke_dispatched", task: "T", agent: "peer" },
    { seq: 3, ts, event: "repoke_dispatched", task: "T", agent: "peer" },
  ].map((event) => JSON.stringify(event) + "\n").join("");
  const initial = planLegacyIdentity(raw, { writerId: "writer", holderId: "first-holder" });
  assert.notEqual(initial.events[1]!.event_id, initial.events[2]!.event_id, "separate identical historical actions retain separate observation identities");
  const exported = initial.events.map((event) => JSON.stringify(event) + "\n").join("");
  const copied = planLegacyIdentity(exported, { writerId: "another-writer", holderId: "another-holder", previous: initial.mapping });
  assert.equal(copied.ok, true);
  assert.equal(copied.source.namespace, initial.source.namespace);
  assert.deepEqual(copied.events.map((event) => event.event_id), initial.events.map((event) => event.event_id));
  assert.equal(copied.events[1]!.provenance?.writer_id, null);
});

test("upgraded Factory still records an unknown Task spawn refusal without inventing an epoch", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  const plan = planLegacyIdentity("", { writerId: "writer" });
  writeFileSync(path, plan.events.map((event) => JSON.stringify(event) + "\n").join(""));
  const factory = createFactory({ stateDir: dir, writerId: "writer" });
  const refusal = factory.requestSpawn({ task: "UNKNOWN", provider: "claude", arity: 1 });
  assert.equal(refusal.outcome, "refused");
  assert.equal(refusal.event.epoch_id, undefined);
  assert.ok(refusal.event.event_id);
  assert.equal(Ledger.open(path).events.at(-1)!.event_id, refusal.event.event_id);
});

test("v2 live Needs-human records retain numeric fields and persist stable evidence targets", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  const plan = planLegacyIdentity("", { writerId: "writer" });
  writeFileSync(path, plan.events.map((event) => JSON.stringify(event) + "\n").join(""));
  const ledger = Ledger.open(path, { writerId: "writer" });
  ledger.append(contract);
  const denied = ledger.append({ event: "permit_denied", task: "T", agent: "peer", name: "Bash", kind: "tool", command: "blocked", rule: "scope", reason: "out of scope" });
  const poked = ledger.append({ event: "repoke_dispatched", task: "T", agent: "peer" });
  const needs = ledger.append({ event: "needs_human", task: "T", reason: "denied-again", evidence: { denial: denied.seq, repoke: poked.seq } });
  assert.deepEqual(needs.evidence, { denial: 3, repoke: 4 });
  assert.deepEqual(needs.references, { denial: denied.event_id, repoke: poked.event_id });
  assert.deepEqual(Ledger.open(path).events.at(-1), needs);
  const before = readFileSync(path, "utf8");
  assert.throws(() => ledger.append({ event: "needs_human", task: "T", reason: "denied-again", evidence: { denial: poked.seq, repoke: denied.seq } }), /not permit_denied/);
  assert.equal(readFileSync(path, "utf8"), before, "invalid reference append cannot mutate acknowledged history");
  ledger.purgeWhere(() => true);
  assert.equal(Ledger.open(path).events[0]!.event, "ledger_schema", "Owner reset retains the format fence");
});


test("legacy copied metadata cannot manufacture historical writer provenance", () => {
  const raw = JSON.stringify({ seq: 1, ts: "2026-10-23T00:00:00.000Z", ...contract, by: "owner", event_id: "old-unversioned-mapping", provenance: { writer_id: "snapshot-holder" } }) + "\n";
  const plan = planLegacyIdentity(raw, { holderId: "snapshot-holder", writerId: "new-writer" });
  assert.equal(plan.ok, false);
  assert.match(plan.conflicts.join("\n"), /unversioned/);
  assert.equal(plan.events[0]!.provenance?.writer_id, null);
  assert.equal(plan.events[0]!.event === "contract_set" && plan.events[0]!.by, "owner");
});

test("a copied v2 fence never supplies the authority to claim a remote writer for new local events", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "copied.jsonl");
  const source = planLegacyIdentity("", { writerId: "original-remote-writer" });
  writeFileSync(path, source.events.map((event) => JSON.stringify(event) + "\n").join(""));
  const local = Ledger.open(path, { writerId: "demonstrable-local-writer" });
  const event = local.append(contract);
  assert.equal(event.provenance?.writer_id, "demonstrable-local-writer");
  assert.equal(local.events[0]!.provenance?.writer_id, "original-remote-writer");
  const unconfigured = Ledger.open(path);
  assert.throws(() => unconfigured.append(contract), /local writer identity/);
});
