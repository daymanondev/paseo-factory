import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectTask } from "../src/task-state.ts";
import { Ledger } from "../src/ledger.ts";
import { planLegacyIdentity } from "../src/history-identity.ts";
import { reconcileVaultLedgers } from "../src/vault.ts";
import { planHistoryImport } from "../src/history-import.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

function snapshot(t: TestContext) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  const prepared = planLegacyIdentity("", { writerId: "fixture-writer" });
  writeFileSync(path, prepared.events.map((event) => JSON.stringify(event) + "\n").join(""));
  const ledger = Ledger.open(path, { writerId: "fixture-writer" });
  return { ledger, path, raw: () => readFileSync(path, "utf8") };
}

const contract = { event: "contract_set", task: "T", workspace: "/local/workspace", gate: "true", artifact: "artifact.txt" } as const;

test("history import plans a new Task without rewriting existing local sequence addresses", (t) => {
  const local = snapshot(t);
  local.ledger.append({ ...contract, task: "LOCAL" });
  const incoming = snapshot(t);
  const added = incoming.ledger.append(contract);
  const before = local.raw();
  const plan = planHistoryImport({ existingLines: before, sources: [{ nodeId: "snapshot-holder", lines: incoming.raw() }], bindings: [{ epochId: added.epoch_id!, workspace: contract.workspace }] });
  assert.equal(plan.status, "ready");
  assert.ok(plan.lines.startsWith(before));
  assert.deepEqual(plan.additions.map((event) => [event.event_id, event.seq]), [[added.event_id, 3]]);
  assert.equal(plan.sources[0]!.lines, incoming.raw());
  assert.equal(local.raw(), before, "planning never activates an import");
});

function fork(t: TestContext, raw: string) {
  const source = snapshot(t);
  writeFileSync(source.path, raw);
  return { ...source, ledger: Ledger.open(source.path, { writerId: "fixture-writer" }) };
}

test("an older imported Contract cannot replace current criteria through append order", (t) => {
  const local = snapshot(t);
  local.ledger.append(contract);
  const incoming = fork(t, local.raw());
  const current = local.ledger.append({ ...contract, gate: "new-criteria" });
  incoming.ledger.append({ event: "claim_reported", task: "T", attempt: 1, sha: "abc" });
  const before = local.raw();
  const plan = planHistoryImport({ existingLines: before, sources: [{ nodeId: "old-copy", lines: incoming.raw() }], bindings: [{ epochId: current.epoch_id!, workspace: contract.workspace }] });
  assert.equal(plan.status, "conflicted");
  assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /divergent|continuation/);
  assert.equal(plan.lines, before);
  assert.deepEqual(plan.additions, []);
  assert.equal(plan.sources[0]!.lines, incoming.raw());
});

test("shape-valid Gate evidence without a Claim is retained as a causal conflict", (t) => {
  const local = snapshot(t);
  const epoch = local.ledger.append(contract);
  const incoming = fork(t, local.raw());
  incoming.ledger.append({ event: "gate_finished", task: "T", attempt: 1, verdict: "green", exit: 0, note: "unsubstantiated", sha: "abc" });
  const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "source", lines: incoming.raw() }], bindings: [{ epochId: epoch.epoch_id!, workspace: contract.workspace, commits: ["abc"], artifactPresent: true }] });
  assert.equal(plan.status, "conflicted");
  assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /Claim/);
  assert.equal(plan.sources[0]!.lines, incoming.raw());
});

test("historical acceptance without green evidence is refused regardless of attribution", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append(contract);
  incoming.ledger.append({ event: "claim_reported", task: "T", attempt: 1, sha: "abc" });
  incoming.ledger.append({ event: "gate_finished", task: "T", attempt: 1, verdict: "red", exit: 1, note: "failed", sha: "abc" });
  incoming.ledger.append({ event: "attempt_accepted", task: "T", attempt: 1, accepted_by: "owner" });
  const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "source", lines: incoming.raw() }], bindings: [{ epochId: epoch.epoch_id!, workspace: contract.workspace, commits: ["abc"], landedCommits: ["abc"] }] });
  assert.equal(plan.status, "conflicted");
  assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /green/);
});

test("remote green evidence requires verified local commit, Artifact and associated files", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append(contract);
  incoming.ledger.append({ event: "claim_reported", task: "T", attempt: 1, sha: "abc" });
  incoming.ledger.append({ event: "gate_finished", task: "T", attempt: 1, verdict: "green", exit: 0, note: "passed", sha: "abc", outputPath: "/remote/gate.log" });
  const report = incoming.ledger.append({ event: "report_written", task: "T", attempt: 1, path: "/remote/report.md" });
  const original = Buffer.from("Evidence (ledger seq): 2, 3\nuntouched source prose\n");
  const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "source", lines: incoming.raw(), artifacts: [{ path: report.path, bytes: original }] }], bindings: [{ epochId: epoch.epoch_id!, workspace: contract.workspace }] });
  assert.equal(plan.status, "conflicted");
  assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /commit|Artifact|file/);
  assert.deepEqual(Buffer.from(plan.sources[0]!.artifacts[0]!.bytes), original);
  assert.equal(plan.sources[0]!.artifacts[0]!.path, "/remote/report.md");
  assert.equal(plan.lines, local.raw());
});

test("imported acceptance never establishes local landing without independent local integration facts", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append(contract);
  incoming.ledger.append({ event: "claim_reported", task: "T", attempt: 1, sha: "abc" });
  incoming.ledger.append({ event: "gate_finished", task: "T", attempt: 1, verdict: "green", exit: 0, note: "passed", sha: "abc" });
  const accepted = incoming.ledger.append({ event: "attempt_accepted", task: "T", attempt: 1, accepted_by: "historical-attribution", landing: "landed" });
  const binding = { epochId: epoch.epoch_id!, workspace: contract.workspace, commits: ["abc"], artifactPresent: true };
  const input = { existingLines: local.raw(), sources: [{ nodeId: "source", lines: incoming.raw() }], bindings: [binding] };
  const staged = planHistoryImport(input);
  assert.equal(staged.status, "conflicted");
  assert.match(staged.conflicts.map((item) => item.reason).join("\n"), /local landing/);
  assert.equal(staged.events.some((event) => event.event === "attempt_accepted"), false);
  const verified = planHistoryImport({ ...input, bindings: [{ ...binding, landedCommits: ["abc"] }] });
  assert.equal(verified.status, "ready");
  const landed = verified.events.find((event) => event.event === "attempt_accepted");
  assert.deepEqual({ ...landed, seq: accepted.seq }, accepted, "immutable historical payload is preserved");
});

test("two outcomes for the same Attempt cannot be selected by later timestamps", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append(contract);
  incoming.ledger.append({ event: "claim_reported", task: "T", attempt: 1, sha: "abc" });
  incoming.ledger.append({ event: "gate_finished", task: "T", attempt: 1, verdict: "green", exit: 0, note: "first outcome", sha: "abc" });
  incoming.ledger.append({ event: "gate_finished", task: "T", attempt: 1, verdict: "red", exit: 1, note: "later contradictory outcome", sha: "def" });
  const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "source", lines: incoming.raw() }], bindings: [{ epochId: epoch.epoch_id!, workspace: contract.workspace, commits: ["abc", "def"], artifactPresent: true }] });
  assert.equal(plan.status, "conflicted");
  assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /Gate.*already|contradictory|multiple/);
});

test("a new Claim must follow the previous Report and advance its epoch's Attempt counter", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append(contract);
  incoming.ledger.append({ event: "claim_reported", task: "T", attempt: 1, sha: "abc" });
  incoming.ledger.append({ event: "claim_reported", task: "T", attempt: 1, sha: "def" });
  const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "source", lines: incoming.raw() }], bindings: [{ epochId: epoch.epoch_id!, workspace: contract.workspace }] });
  assert.equal(plan.status, "conflicted");
  assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /Claim.*Attempt|Claim.*Report/);
});

test("opposite required-review outcomes for one Attempt stay conflicted", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append({ ...contract, freshEyes: true });
  incoming.ledger.append({ event: "claim_reported", task: "T", attempt: 1, sha: "abc" });
  incoming.ledger.append({ event: "gate_finished", task: "T", attempt: 1, verdict: "green", exit: 0, note: "passed", sha: "abc" });
  incoming.ledger.append({ event: "fresh_eyes_written", task: "T", attempt: 1, outcome: "clear", model: "fixture", finding: "clear", durationMs: 1 });
  incoming.ledger.append({ event: "fresh_eyes_written", task: "T", attempt: 1, outcome: "concern", model: "fixture", finding: "contradicts", durationMs: 1 });
  const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "source", lines: incoming.raw() }], bindings: [{ epochId: epoch.epoch_id!, workspace: contract.workspace, commits: ["abc"], artifactPresent: true }] });
  assert.equal(plan.status, "conflicted");
  assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /review/);
});

for (const scenario of [
  { name: "Gate starts before Claim", events: [{ event: "gate_started", task: "T", attempt: 1, cmd: "true" }], reason: /Gate start/ },
  { name: "Report precedes Gate", events: [{ event: "claim_reported", task: "T", attempt: 1, sha: "abc" }, { event: "report_written", task: "T", attempt: 1, path: "/local/report" }], reason: /Report/ },
  { name: "Watch precedes Gate", events: [{ event: "claim_reported", task: "T", attempt: 1, sha: "abc" }, { event: "watch_written", task: "T", attempt: 1, model: "fixture", outcome: "failed", error: "interrupted", durationMs: 1 }], reason: /Watch/ },
  { name: "Gate attests another SHA", events: [{ event: "claim_reported", task: "T", attempt: 1, sha: "abc" }, { event: "gate_finished", task: "T", attempt: 1, verdict: "green", exit: 0, note: "passed", sha: "def" }], reason: /SHA/ },
  { name: "green Gate has a nonzero exit", events: [{ event: "claim_reported", task: "T", attempt: 1, sha: "abc" }, { event: "gate_finished", task: "T", attempt: 1, verdict: "green", exit: 2, note: "passed", sha: "abc" }], reason: /green/ },
  { name: "Contract replaces an open pipeline", events: [{ event: "claim_reported", task: "T", attempt: 1, sha: "abc" }, { ...contract, gate: "new" }], reason: /Contract.*pipeline/ },
] satisfies { name: string; events: import("../src/events.ts").PendingEvent[]; reason: RegExp }[]) {
  test(`causal import refuses ${scenario.name}`, (t) => {
    const local = snapshot(t);
    const incoming = snapshot(t);
    const epoch = incoming.ledger.append(contract);
    for (const event of scenario.events) incoming.ledger.append(event);
    const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "source", lines: incoming.raw() }], bindings: [{ epochId: epoch.epoch_id!, workspace: contract.workspace, commits: ["abc", "def"], artifactPresent: true }] });
    assert.equal(plan.status, "conflicted");
    assert.match(plan.conflicts.map((item) => item.reason).join("\n"), scenario.reason);
    assert.equal(plan.lines, local.raw());
  });
}

test("an unacknowledged local tail blocks import activation without losing its bytes", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append(contract);
  const raw = local.raw() + '{"unacknowledged":';
  const plan = planHistoryImport({ existingLines: raw, sources: [{ nodeId: "source", lines: incoming.raw() }], bindings: [{ epochId: epoch.epoch_id!, workspace: contract.workspace }] });
  assert.equal(plan.status, "conflicted");
  assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /unacknowledged.*tail/);
  assert.equal(plan.lines, raw);
  assert.deepEqual(plan.additions, []);
});

test("common-prefix continuation maps numeric citations and is a no-op on retry", (t) => {
  const local = snapshot(t);
  const epoch = local.ledger.append(contract);
  local.ledger.append({ event: "permit_denied", task: "T", agent: "peer", name: "Bash", kind: "tool", rule: "scope", reason: "first" });
  const poke = local.ledger.append({ event: "repoke_dispatched", task: "T", agent: "peer" });
  const incoming = fork(t, local.raw());
  local.ledger.append({ ...contract, task: "OTHER" });
  const denied = incoming.ledger.append({ event: "permit_denied", task: "T", agent: "peer", name: "Bash", kind: "tool", rule: "scope", reason: "again" });
  const needs = incoming.ledger.append({ event: "needs_human", task: "T", reason: "denied-again", evidence: { denial: denied.seq, repoke: poke.seq } });
  const raw = incoming.raw() + '{"event":"unacknowledged"';
  const source = { nodeId: "copy-holder", lines: raw, artifacts: [{ path: "source-retro.md", bytes: Buffer.from("Evidence (ledger seq): 3, 5\n") }] };
  const before = local.raw();
  const plan = planHistoryImport({ existingLines: before, sources: [source], bindings: [{ epochId: epoch.epoch_id!, workspace: contract.workspace }] });
  assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  assert.ok(plan.lines.startsWith(before));
  const mapped = plan.events.find((event) => event.event_id === needs.event_id);
  assert.ok(mapped?.event === "needs_human");
  assert.deepEqual(mapped.evidence, { denial: 6, repoke: 4 });
  assert.equal(plan.sources[0]!.sequenceMap.find((entry) => entry.eventId === denied.event_id)?.localSeq, 6);
  assert.equal(plan.sources[0]!.lines, raw);
  assert.match(plan.sources[0]!.diagnostics.join("\n"), /tail/);
  assert.equal(Buffer.from(plan.sources[0]!.artifacts[0]!.bytes).toString(), "Evidence (ledger seq): 3, 5\n", "foreign citation prose stays byte-exact in its source namespace");
  const retry = planHistoryImport({ existingLines: plan.lines, sources: [source] });
  assert.equal(retry.status, "duplicate", JSON.stringify(retry.conflicts));
  assert.equal(retry.lines, plan.lines);
  assert.equal(retry.id, plan.id);
  assert.deepEqual(retry.additions, []);
  assert.equal(local.raw(), before);
});

test("staged snapshots retain invalid source bytes without decoding them into different evidence", (t) => {
  const local = snapshot(t);
  const bytes = Buffer.from([0xff, 0x0a]);
  const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "damaged", lines: bytes.toString("utf8"), bytes }] });
  assert.equal(plan.status, "conflicted");
  assert.deepEqual(Buffer.from(plan.sources[0]!.bytes), bytes);
});

test("damaged persisted source mappings cannot be silently replaced with plausible identities", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append(contract);
  const mapping = planLegacyIdentity(incoming.raw(), { writerId: "unused-planner" }).mapping;
  mapping.entries.find((entry) => entry.eventId === epoch.event_id)!.eventId = "invented-prior-identity";
  const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "holder", lines: incoming.raw(), identityMapping: mapping }], bindings: [{ epochId: epoch.epoch_id!, workspace: contract.workspace }] });
  assert.equal(plan.status, "conflicted");
  assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /mapping/);
  assert.deepEqual(plan.sources[0]!.identityMapping, mapping);
});

test("factory-level Retro files require local evidence binding while retaining source citations", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const retro = incoming.ledger.append({ event: "retro_written", model: "fixture", outcome: "written", durationMs: 1, proposalsPath: "/source/retro.md", proposalCount: 1 });
  const input = { existingLines: local.raw(), sources: [{ nodeId: "source", lines: incoming.raw() }] };
  assert.equal(planHistoryImport(input).status, "conflicted");
  const verified = planHistoryImport({ ...input, files: [{ eventId: retro.event_id!, path: "/source/retro.md" }] });
  assert.equal(verified.status, "ready");
});


test("the public Vault reconciler refuses damaged history with its original snapshot and reasons", (t) => {
  const local = snapshot(t);
  const damaged = '{"seq":2,"event":"damaged"}\n';
  assert.throws(() => reconcileVaultLedgers(local.raw(), [{ nodeId: "damaged-holder", lines: damaged }]), (error: unknown) => {
    const refused = error as { code: string; plan: { sources: { lines: string }[]; conflicts: { reason: string }[] } };
    assert.equal(refused.code, "history-import-conflict");
    assert.equal(refused.plan.sources[0]!.lines, damaged);
    assert.ok(refused.plan.conflicts.length > 0);
    return true;
  });
});

test("contradictory local binding facts are refused independently of their input order", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append(contract);
  const bindings = [{ epochId: epoch.epoch_id!, workspace: contract.workspace }, { epochId: epoch.epoch_id!, workspace: "/another/host" }];
  const source = { nodeId: "holder", lines: incoming.raw() };
  for (const facts of [bindings, [...bindings].reverse()]) {
    const plan = planHistoryImport({ existingLines: local.raw(), sources: [source], bindings: facts });
    assert.equal(plan.status, "conflicted");
    assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /binding/);
  }
});


test("independent histories plan deterministically and divergent histories stay staged in either source order", (t) => {
  const local = snapshot(t);
  const a = snapshot(t);
  const b = snapshot(t);
  const epochA = a.ledger.append({ ...contract, task: "A", workspace: "/local/A" });
  const epochB = b.ledger.append({ ...contract, task: "B", workspace: "/local/B" });
  const sources = [{ nodeId: "A-holder", lines: a.raw() }, { nodeId: "B-holder", lines: b.raw() }];
  const bindings = [{ epochId: epochA.epoch_id!, workspace: "/local/A" }, { epochId: epochB.epoch_id!, workspace: "/local/B" }];
  const first = planHistoryImport({ existingLines: local.raw(), sources, bindings });
  const reordered = planHistoryImport({ existingLines: local.raw(), sources: [...sources].reverse(), bindings });
  assert.equal(first.status, "ready");
  assert.equal(reordered.lines, first.lines);
  assert.equal(reordered.id, first.id);
  const changed = a.raw().replace('"gate":"true"', '"gate":"false"');
  const contradictory = [{ nodeId: "A", lines: a.raw() }, { nodeId: "another-copy", lines: changed }];
  for (const order of [contradictory, [...contradictory].reverse()]) {
    const conflict = planHistoryImport({ existingLines: local.raw(), sources: order, bindings });
    assert.equal(conflict.status, "conflicted");
    assert.match(conflict.conflicts.map((entry) => entry.reason).join("\n"), /contradictory/);
    assert.equal(conflict.sources.length, 2);
    assert.equal(conflict.lines, local.raw());
  }
});

test("two Contract epochs can each contain Attempt 1 without merging their evidence", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const firstEpoch = incoming.ledger.append(contract);
  incoming.ledger.append({ event: "claim_reported", task: "T", attempt: 1, sha: "abc" });
  incoming.ledger.append({ event: "gate_finished", task: "T", attempt: 1, verdict: "red", exit: 1, note: "first", sha: "abc" });
  const report = incoming.ledger.append({ event: "report_written", task: "T", attempt: 1, path: "/local/first-report.md" });
  const secondEpoch = incoming.ledger.append({ ...contract, freshEyes: true });
  incoming.ledger.append({ event: "claim_reported", task: "T", attempt: 1, sha: "def" });
  incoming.ledger.append({ event: "gate_finished", task: "T", attempt: 1, verdict: "green", exit: 0, note: "second", sha: "def" });
  const secondReport = incoming.ledger.append({ event: "report_written", task: "T", attempt: 1, path: "/local/second-report.md" });
  const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "source", lines: incoming.raw() }], bindings: [
    { epochId: firstEpoch.epoch_id!, workspace: contract.workspace, commits: ["abc"], files: [{ eventId: report.event_id!, path: report.path }] },
    { epochId: secondEpoch.epoch_id!, workspace: contract.workspace, commits: ["def"], artifactPresent: true, files: [{ eventId: secondReport.event_id!, path: secondReport.path }] },
  ] });
  assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  const projected = projectTask(plan.events, "T");
  assert.equal(projected.epochId, secondEpoch.epoch_id);
  assert.equal(projected.attempts[0]!.attempt, 1);
  assert.equal(projected.attempts[0]!.reviewState, "incomplete", "missing restarted review cannot become CLEAR");
  assert.equal(projected.attempts[0]!.leadEligible, false);
  assert.equal(plan.events.filter((event) => event.event === "gate_finished" && event.attempt === 1).length, 2);
});

for (const mutation of ["wrong-kind", "missing", "wrong-epoch"] as const) {
  test(`import retains ${mutation} source references instead of guessing matching local numbers`, (t) => {
    const local = snapshot(t);
    const incoming = snapshot(t);
    incoming.ledger.append(contract);
    const denied = incoming.ledger.append({ event: "permit_denied", task: "T", agent: "peer", name: "Bash", kind: "tool", rule: "scope", reason: "denied" });
    const poked = incoming.ledger.append({ event: "repoke_dispatched", task: "T", agent: "peer" });
    incoming.ledger.append({ event: "needs_human", task: "T", reason: "silent-after-repoke", evidence: { denial: denied.seq, repoke: poked.seq } });
    const rows = incoming.raw().trimEnd().split("\n").map((line) => JSON.parse(line));
    if (mutation === "wrong-kind") rows.at(-1).evidence.denial = poked.seq;
    if (mutation === "missing") rows.at(-1).evidence.denial = 999;
    if (mutation === "wrong-epoch") rows.at(-1).epoch_id = "another-epoch";
    const raw = rows.map((row) => JSON.stringify(row) + "\n").join("");
    const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "source", lines: raw }] });
    assert.equal(plan.status, "conflicted");
    assert.equal(plan.sources[0]!.lines, raw);
    assert.equal(plan.lines, local.raw());
    assert.ok(plan.conflicts.length > 0);
  });
}

test("unsafe remote worktrees and relocated source Workspaces remain explicit binding conflicts", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append(contract);
  incoming.ledger.append({ event: "spawn_dispatched", task: "T", provider: "fixture", arity: 1, worktree: "/other-host/worktree" });
  for (const workspace of [contract.workspace, "/this-host/relocated-project"]) {
    const plan = planHistoryImport({ existingLines: local.raw(), sources: [{ nodeId: "other-host", lines: incoming.raw() }], bindings: [{ epochId: epoch.epoch_id!, workspace }] });
    assert.equal(plan.status, "conflicted");
    assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /worktree|Workspace/);
    assert.equal(plan.sources[0]!.lines, incoming.raw());
  }
});

test("sequence exhaustion cannot produce an invalid active Ledger", (t) => {
  const local = snapshot(t);
  const rows = local.raw().trimEnd().split("\n").map((line) => ({ ...JSON.parse(line), seq: Number.MAX_SAFE_INTEGER }));
  const existingLines = rows.map((row) => JSON.stringify(row) + "\n").join("");
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append(contract);
  const plan = planHistoryImport({ existingLines, sources: [{ nodeId: "holder", lines: incoming.raw() }], bindings: [{ epochId: epoch.epoch_id!, workspace: contract.workspace }] });
  assert.equal(plan.status, "conflicted");
  assert.equal(plan.lines, existingLines);
  assert.match(plan.conflicts.map((item) => item.reason).join("\n"), /sequence|valid ledger/);
});

test("a symbolic Claim needs explicit commit resolution rather than a guessed current HEAD", (t) => {
  const local = snapshot(t);
  const incoming = snapshot(t);
  const epoch = incoming.ledger.append(contract);
  const claim = incoming.ledger.append({ event: "claim_reported", task: "T", attempt: 1, sha: "HEAD" });
  incoming.ledger.append({ event: "gate_finished", task: "T", attempt: 1, verdict: "green", exit: 0, note: "passed", sha: "abc" });
  const binding = { epochId: epoch.epoch_id!, workspace: contract.workspace, commits: ["abc"], artifactPresent: true };
  const input = { existingLines: local.raw(), sources: [{ nodeId: "holder", lines: incoming.raw() }], bindings: [binding] };
  assert.equal(planHistoryImport(input).status, "conflicted");
  assert.equal(planHistoryImport({ ...input, bindings: [{ ...binding, claims: [{ eventId: claim.event_id!, sha: "abc" }] }] }).status, "ready");
});
