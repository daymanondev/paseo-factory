import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { buildRetroDigest, buildRetroPrompt, parseRetroProposals, retroDay, retroFilePath } from "../src/retro.ts";
import { handleSpoolRequest, parseSpoolRequest, startSpool } from "../plugin/server/spool.ts";
import type { Factory } from "../plugin/server/core/factory.ts";
import type { RetroWritten } from "../src/events.ts";
import { disposeDir, fakeCopilotRunner, gitCommitAll, gitCommitChanges, makeTempDir, repoRoot, writeLanes } from "./helpers.ts";

/**
 * The Retro station (v0.0.7, ticket 04 building ticket 03's Answer) against a
 * fake Copilot CLI runner — hermetic, no network, no binary. Every behavior
 * the design fixed: the digest's composition (per-task blocks, the parade
 * roll-up, denials verbatim with the PATH boilerplate stripped, red gate logs
 * attached, reports whole, prior Retros as factory-level one-liners), the
 * prompt's EXISTING-LAW section and strict JSON output contract, whole-parse
 * strictness (one bad proposal fails the output, a nonexistent seq fails the
 * parse), the pass's budget/retry policy (parse failures retry once too),
 * the one `retro_written` line (file first, then the line), the refusals
 * that write no line (copilot unusable, same-day duplicate), the spool's
 * `retro` kind, and the Owner CLI's `factory retro` against the real halves.
 */

const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");

/** Pins the retro lane to the copilot family — this suite's argv/model assertions key on it. */
function pinRetroLane(stateDir: string): void {
  writeLanes(stateDir, { retro: "copilot/gpt-5.4" });
}

/** A git workspace at its base commit, ready for a Contract. */
function makeWorkspaceAtBase(dir: string): { workspace: string; artifact: string } {
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  const artifact = "src/format.ts";
  writeFileSync(join(workspace, artifact), "export function pad() {}\n");
  gitCommitAll(workspace);
  return { workspace, artifact };
}

/** The Agent's "work": a real change, committed — returns the claimable sha. */
function commitWork(workspace: string, artifact: string): string {
  writeFileSync(join(workspace, artifact), "export function pad(input: string): string {\n  return input;\n}\n");
  return gitCommitChanges(workspace, "the work");
}

/** The fake CLI's happy answer: two proposals in scrambled class order — the file must regroup them. Evidence cites seq 1 (every ledger here has at least the contract). */
const HAPPY_JSON = JSON.stringify({
  proposals: [
    { class: "observation", evidence: [1], pattern: "reports bury the gate note", text: "Surface the note above the choke section." },
    { class: "gate-check", evidence: [1, 2], pattern: "the same missing export reaches the gate three times", text: "Add a smoke import of the artifact to the gate command." },
    { class: "contract-draft", evidence: [1], pattern: "agents guess their assignment from the tree", text: "Contracts should carry a description slot by default." },
  ],
});

function happyRunner() {
  return fakeCopilotRunner(() => ({ code: 0, stdout: HAPPY_JSON }));
}

/** The one retro_written line on the ledger, when one landed. */
function retroEvent(factory: Factory): RetroWritten {
  const retro = factory.ledger.events.findLast((e): e is RetroWritten => e.event === "retro_written");
  assert.ok(retro, "retro_written landed");
  return retro;
}

// ---- the digest --------------------------------------------------------------------

test("the digest: per-task blocks, parade roll-up, denials verbatim, red gate log attached, reports whole", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir });

  factory.setContract({
    task: "DIG",
    workspace,
    gate: "node --test src/format.test.ts",
    artifact,
    scope: ["src"],
    description: "Implement the pad helper with its tests.",
  });
  // The spawn record and its refusal vocabulary.
  factory.requestSpawn({ task: "DIG", provider: "copilot/gpt-5.4", arity: 1 });
  // The permit parade (rolled) and the denials (verbatim).
  for (const [name, command] of [
    ["Bash", "node --test src/format.test.ts"],
    ["Bash", "node --test src/format.test.ts"],
    ["Edit", "src/format.ts"],
  ] as const) {
    factory.ledger.append({ event: "permit_allowed", task: "DIG", agent: "agent-dig", name, kind: "tool", command });
  }
  factory.ledger.append({
    event: "permit_denied",
    task: "DIG",
    agent: "agent-dig",
    name: "Bash",
    kind: "tool",
    rule: "git:force-push",
    reason: "destructive git vocabulary",
    command: "export PATH=/state/bin:$PATH && git push --force origin main",
  });
  factory.ledger.append({
    event: "git_blocked",
    task: "DIG",
    agent: "agent-dig",
    rule: "git:reset-hard",
    reason: "working-tree discard",
    command: "export PATH=/state/bin:$PATH && git reset --hard",
    cwd: workspace,
    blockId: "b-1",
  });
  // An untasked git block — factory-level evidence, no task block to hold it.
  factory.ledger.append({
    event: "git_blocked",
    rule: "git:branch-D",
    reason: "branch delete",
    command: "git branch -D wip",
    cwd: "/tmp/elsewhere",
    blockId: "b-2",
  });

  // Attempt 1: red with real gate output — its log attaches to the red attempt.
  writeFileSync(join(workspace, artifact), "export function pad(input: string): string {\n  return input;\n}\n");
  const red = gitCommitChanges(workspace, "pad without tests");
  const redOutcome = await factory.claim({ task: "DIG", sha: red, agent: "agent-dig" });
  assert.equal(redOutcome.verdict, "red");
  // A watch line the marked contract would have produced — answers verbatim, including a failed one elsewhere.
  factory.ledger.append({
    event: "watch_written",
    task: "DIG",
    attempt: 1,
    model: "copilot/gpt-5.4",
    outcome: "written",
    answers: { "test-weakened": 0.05, "stuck-loop": 0.2, "scope-creep": 0.61, "secret-leak": 0.07 },
    durationMs: 4321,
  });
  factory.ledger.append({
    event: "fresh_eyes_written",
    task: "DIG",
    attempt: 1,
    model: "fake-eye-1",
    outcome: "concern",
    finding: "pad ignores the width parameter.",
    durationMs: 2100,
  });

  // Attempt 2: green — the real implementation plus its test, and a passing gate
  // (its log must NOT attach), then accepted.
  writeFileSync(
    join(workspace, artifact),
    'export function pad(input: string, width: number): string {\n  if (input.length >= width) return input;\n  return input + " ".repeat(width - input.length);\n}\n',
  );
  writeFileSync(
    join(workspace, "src", "format.test.ts"),
    'import { pad } from "./format.ts";\nimport assert from "node:assert/strict";\nimport test from "node:test";\n\ntest("pad", () => {\n  assert.equal(pad("ab", 4), "ab  ");\n});\n',
  );
  const green = gitCommitChanges(workspace, "pad, implemented and tested");
  const greenOutcome = await factory.claim({ task: "DIG", sha: green, agent: "agent-dig" });
  assert.equal(greenOutcome.verdict, "green");
  const accepted = await factory.accept({ task: "DIG", attempt: 2 });

  // A prior Retro (a written one and a failed one) — the NEXT digest renders them as one-liners.
  factory.ledger.append({
    event: "retro_written",
    model: "copilot/gpt-5.4",
    outcome: "written",
    durationMs: 40_000,
    proposalsPath: join(stateDir, "retro-2026-10-09.md"),
    proposalCount: 7,
  });
  factory.ledger.append({ event: "retro_written", model: "copilot/gpt-5.4", outcome: "failed", durationMs: 1_000, error: "copilot CLI exited 2: not authenticated" });

  const corpus = buildRetroDigest(factory.ledger.events, stateDir);
  assert.equal(corpus.eventsRead, factory.ledger.events.length, "every ledger event is read");
  assert.equal(corpus.taskBlocks, 1, "one task block");
  assert.equal(corpus.reports, 2, "one report per attempt rides whole");
  assert.equal(corpus.redGateLogs, 1, "only the red attempt's gate log attaches");
  assert.ok(corpus.knownSeqs.has(1) && corpus.knownSeqs.has(corpus.eventsRead), "knownSeqs carries the range");

  const digest = corpus.digest;
  const lines = digest.split("\n");

  // The header's corpus facts, the task header, and the contract complete with description verbatim.
  assert.ok(lines[0]!.startsWith(`# retro corpus — ${corpus.eventsRead} ledger events, 1 task blocks, 2 reports, 1 red gate logs`), lines[0]);
  assert.ok(digest.includes("## DIG"));
  const contractAt = lines.findIndex((l) => l.includes("] `contract` gate=`node --test src/format.test.ts`"));
  assert.ok(contractAt > -1, "the contract line carries the gate");
  assert.match(lines[contractAt]!, /artifact=src\/format\.ts/);
  assert.match(lines[contractAt]!, /scope=\[src\]/);
  assert.match(lines[contractAt]!, /base=[0-9a-f]{40}/, "the base commit rides the contract line");
  assert.ok(!lines[contractAt]!.includes("watch=on"), "absent marks stay absent — the ledger's omission is the data");
  assert.equal(lines[contractAt! + 1], "     description: Implement the pad helper with its tests.");

  // gate_started is dropped — byte-identical to the contract's gate.
  assert.ok(!lines.some((l) => l.includes("gate_started")), "gate_started never renders");

  // The parade: one count-line, counts descending, only at the block's end.
  const parade = lines.find((l) => l.startsWith("permit parade:"));
  assert.equal(parade, "permit parade: 3 allowed (Bashx2 Editx1)");

  // Denials verbatim: the PATH boilerplate stripped, the git verbs themselves stay.
  const denied = lines.find((l) => l.includes("permit_denied"));
  assert.ok(denied!.includes("rule=git:force-push — destructive git vocabulary — git push --force origin main"));
  assert.ok(!denied!.includes("export PATH="), "only the boilerplate prefix is stripped");
  const blocked = lines.find((l) => l.includes("git_blocked rule=git:reset-hard"));
  assert.ok(blocked!.includes("git reset --hard"), "the git verb stays — it IS the evidence");

  // The red attempt's gate outcome carries its complete note, its log basename, and the log itself attached.
  const gateRed = lines.find((l) => l.includes("verdict=red"));
  assert.ok(gateRed!.includes(`gate-log=gate-DIG-1.log`), "the red gate names its log basename");
  const gateRedAt = lines.indexOf(gateRed!);
  assert.match(lines[gateRedAt + 1]!, /^\s+\| /, "the red gate log's content is attached, line-prefixed");
  assert.ok(lines.slice(gateRedAt + 1, gateRedAt + 4).join("\n").trim().length > 0, "the attached log is not empty");
  // The green attempt names its log file but does not attach the passing bulk.
  const gateGreen = lines.find((l) => l.includes("verdict=green"));
  assert.ok(gateGreen!.includes("gate-log=gate-DIG-2.log"));
  const afterGreen = lines.slice(lines.indexOf(gateGreen!) + 1, lines.indexOf(gateGreen!) + 3).join("\n");
  assert.ok(!afterGreen.includes("| "), "the green gate log's content is not attached");

  // Watch and eye answers verbatim; ACCEPTED names its attempt.
  const watchLine = lines.find((l) => l.includes("] watch attempt=1"));
  assert.ok(watchLine!.includes('"scope-creep":0.61'), "answers render as recorded JSON");
  const eyeLine = lines.find((l) => l.includes("fresh_eyes attempt=1"));
  assert.ok(eyeLine!.includes("finding: pad ignores the width parameter."));
  assert.ok(lines.includes(`[${accepted.seq}] ACCEPTED attempt=2`), "ACCEPTED carries its seq");

  // Factory level: the prior Retros as one-liners, the untasked git block.
  const factoryAt = digest.indexOf("## factory level");
  assert.ok(factoryAt > -1);
  assert.ok(digest.includes("retro_written written 7 proposals → retro-2026-10-09.md (copilot/gpt-5.4, 40000ms)"));
  assert.ok(digest.includes("retro_written failed: copilot CLI exited 2: not authenticated"));
  assert.ok(digest.includes("git_blocked rule=git:branch-D — branch delete — git branch -D wip cwd=/tmp/elsewhere"));

  // Reports whole, one per attempt, after the task blocks.
  const reportsAt = digest.indexOf("## reports");
  assert.ok(reportsAt > factoryAt, "reports ride after the factory level — bulk last");
  assert.ok(digest.includes("### report-DIG-1.md"));
  const firstReport = readFileSync(join(stateDir, "report-DIG-1.md"), "utf8");
  assert.ok(digest.includes(firstReport.trimEnd()), "the report's content rides whole");
});

// ---- the prompt --------------------------------------------------------------------

test("buildRetroPrompt: the EXISTING-LAW section, the strict JSON contract, the corpus as the tail", () => {
  const prompt = buildRetroPrompt("# retro corpus — 3 ledger events");
  for (const law of [
    "permit auto-allow is law",
    "watch is record-only",
    "Scope-mandatory spawn refusals",
    "Artifact existence is already gate law",
    "fresh-eyes pass fires on green verdicts only",
  ]) {
    assert.ok(prompt.includes(law), `EXISTING LAW carries: ${law}`);
  }
  assert.ok(prompt.includes("EXACTLY one JSON object"), "the output contract is stated");
  assert.ok(prompt.includes('"class":"gate-check|contract-draft|observation"'), "the schema is spelled");
  assert.ok(prompt.includes("A seq that does not exist in the corpus fails your whole output"));
  assert.ok(prompt.endsWith("# retro corpus — 3 ledger events"), "the corpus is the prompt's tail");
});

// ---- the strict parse ----------------------------------------------------------------

const SEQS = new Set([1, 2, 3, 5]);

test("parseRetroProposals: happy path, both orders of magnitude of strictness", () => {
  const happy = parseRetroProposals(
    '{"proposals":[{"class":"gate-check","evidence":[3,1],"pattern":"p","text":"t"}]}',
    SEQS,
  );
  assert.equal(happy.ok, true);
  if (happy.ok) {
    assert.equal(happy.proposals.length, 1);
    assert.deepEqual(happy.proposals[0]!.evidence, [3, 1], "evidence keeps the model's order");
  }
  const empty = parseRetroProposals('{"proposals":[]}', SEQS);
  assert.equal(empty.ok, true, "an empty proposals list is an honest nothing-proposed");
});

test("parseRetroProposals: whole-parse — one bad proposal fails the output, never a partial read", () => {
  const cases: [string, string, RegExp][] = [
    ["not JSON", "just some prose", /not valid JSON/],
    ["array root", "[]", /not a JSON object/],
    ["extra root key", '{"proposals":[],"why":"because"}', /exactly "proposals"/],
    ["missing root key", "{}", /exactly "proposals"/],
    ["proposals not array", '{"proposals":{}}', /"proposals" is not an array/],
    ["item not object", '{"proposals":["x"]}', /proposal 1 is not an object/],
    ["extra field", '{"proposals":[{"class":"observation","evidence":[1],"pattern":"p","text":"t","id":7}]}', /exactly class\/evidence\/pattern\/text/],
    ["missing field", '{"proposals":[{"class":"observation","evidence":[1],"pattern":"p"}]}', /exactly class\/evidence\/pattern\/text/],
    ["bad class", '{"proposals":[{"class":"hot-take","evidence":[1],"pattern":"p","text":"t"}]}', /class must be one of/],
    ["empty evidence", '{"proposals":[{"class":"observation","evidence":[],"pattern":"p","text":"t"}]}', /non-empty array/],
    ["non-integer seq", '{"proposals":[{"class":"observation","evidence":[1.5],"pattern":"p","text":"t"}]}', /non-integer seq/],
    ["nonexistent seq", '{"proposals":[{"class":"observation","evidence":[4],"pattern":"p","text":"t"}]}', /seq 4, which does not exist/],
    ["blank pattern", '{"proposals":[{"class":"observation","evidence":[1],"pattern":"  ","text":"t"}]}', /pattern must be a non-empty/],
    ["blank text", '{"proposals":[{"class":"observation","evidence":[1],"pattern":"p","text":""}]}', /text must be a non-empty/],
  ];
  for (const [name, output, pattern] of cases) {
    const parsed = parseRetroProposals(output, SEQS);
    assert.equal(parsed.ok, false, `${name}: fails`);
    if (!parsed.ok) assert.match(parsed.error, pattern, `${name}: the error names it`);
  }
});

// ---- the pass through the factory ----------------------------------------------------

test("a happy retro: file first, one written line, R-ids assigned in ratification order", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  pinRetroLane(stateDir);
  const fake = happyRunner();
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: fake.runner });

  factory.setContract({ task: "R1", workspace, gate: "true", artifact, description: "Do the work." });
  const claimed = commitWork(workspace, artifact);
  await factory.claim({ task: "R1", sha: claimed, agent: "agent-r1" });

  const outcome = await factory.retro();
  assert.equal(outcome.outcome, "written");
  assert.equal(outcome.model, "copilot/gpt-5.4");
  assert.equal(outcome.proposalCount, 3);

  // The one CLI call: silent, model pinned, reasoning pinned, no --context flag.
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0]!.args, ["-s", "--model", "gpt-5.4", "--reasoning-effort", "medium"]);
  assert.ok(!fake.calls[0]!.args.includes("--context"), "the default tier fits — no --context");

  // The file: named for today (UTC), in the stateDir, beside the reports.
  const expectedPath = retroFilePath(stateDir, retroDay(new Date()));
  assert.equal(outcome.proposalsPath, expectedPath);
  assert.ok(existsSync(expectedPath), "the proposals file landed");
  const file = readFileSync(expectedPath, "utf8");
  assert.match(file, /^# Retro \d{4}-\d{2}-\d{2} — 3 proposals$/m);
  assert.ok(file.includes("- Model: copilot/gpt-5.4"));
  assert.match(file, /- Corpus: \d+ ledger events · 1 task blocks · 1 reports · 0 red gate logs/);
  assert.ok(file.includes("- Duration: "), "the header carries the duration");
  assert.ok(file.includes("Nothing here is law until ratified"), "the header states the ratification boundary");
  // Ratification reading order: gate-check → contract-draft → observation, R-ids follow it.
  const r1 = file.indexOf("## R1 — gate-check");
  const r2 = file.indexOf("## R2 — contract-draft");
  const r3 = file.indexOf("## R3 — observation");
  assert.ok(r1 > -1 && r2 > r1 && r3 > r2, "ids follow the ratification reading order, not the model's order");
  assert.ok(file.includes("- Evidence (ledger seq): 1, 2"), "evidence renders as the cited seqs");
  assert.ok(file.includes("- Pattern: the same missing export reaches the gate three times"));
  assert.ok(file.includes("- Proposal: Add a smoke import of the artifact to the gate command."));

  // The ledger line: factory-level (no task, no attempt), attesting the file.
  const retro = retroEvent(factory);
  assert.equal(retro.model, "copilot/gpt-5.4");
  assert.equal(retro.outcome, "written");
  assert.equal(retro.proposalCount, 3);
  assert.equal(retro.proposalsPath, expectedPath);
  assert.ok(!("task" in retro) && !("attempt" in retro), "the first factory-level event carries neither");
  assert.ok(typeof retro.durationMs === "number" && retro.durationMs >= 0);

  // The digest fed the prompt — the whole corpus is the prompt's tail.
  assert.ok(fake.calls[0]!.stdin.includes("## R1"), "the task block rode the prompt");
});

/** Matches a FactoryError-style code without instanceof — the plugin core's class is a vendored twin of src/errors.ts. */
function codeIs(code: string): (err: unknown) => boolean {
  return (err: unknown): boolean => err instanceof Error && (err as { code?: unknown }).code === code;
}

test("a parse failure retries once inside the same clock and succeeds (divergence 2)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = fakeCopilotRunner((_call, index) =>
    index === 0 ? { code: 0, stdout: "```json\n{\"proposals\":[]}\n```" } : { code: 0, stdout: HAPPY_JSON },
  );
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: fake.runner });
  factory.setContract({ task: "R2", workspace, gate: "true", artifact });
  const claimed = commitWork(workspace, artifact);
  await factory.claim({ task: "R2", sha: claimed, agent: "agent-r2" });

  const outcome = await factory.retro();
  assert.equal(outcome.outcome, "written", "a fenced answer failed the parse, the retry landed clean");
  assert.equal(fake.calls.length, 2, "exactly one retry");
});

test("a parse failure twice is a failed line naming it — no file, and a same-day retry stays legal", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const failing = fakeCopilotRunner(() => ({ code: 0, stdout: "{\"proposals\": I tried}" }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: failing.runner });
  factory.setContract({ task: "R3", workspace, gate: "true", artifact });

  const failed = await factory.retro();
  assert.equal(failed.outcome, "failed");
  assert.match(failed.error!, /parse failed: /);
  assert.equal(failed.proposalsPath, undefined);
  assert.ok(!existsSync(retroFilePath(stateDir, retroDay(new Date()))), "a failed retro writes no file");
  const line = retroEvent(factory);
  assert.equal(line.outcome, "failed");
  assert.match(line.error!, /parse failed/);
  assert.equal(line.proposalsPath, undefined);

  // The failed pass left no file and no written line — a same-day retry runs.
  const happy = happyRunner();
  const retried = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: happy.runner });
  const second = await retried.retro();
  assert.equal(second.outcome, "written", "same-day retry after failure is legal");
  assert.equal(retried.ledger.events.filter((e) => e.event === "retro_written").length, 2, "both lines are on the ledger — failures are visible");
});

test("a CLI that keeps failing is a failed line naming the exit and stderr", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  pinRetroLane(join(dir, "factory"));
  const fake = fakeCopilotRunner(() => ({ code: 2, stdout: "", stderr: "copilot: not authenticated" }));
  const factory = createFactory({ stateDir: join(dir, "factory"), retroCopilotProbe: () => true, retroCopilotRunner: fake.runner });
  factory.setContract({ task: "R4", workspace, gate: "true", artifact });

  const outcome = await factory.retro();
  assert.equal(fake.calls.length, 2, "the retry happened, then honesty");
  assert.equal(outcome.outcome, "failed");
  assert.match(outcome.error!, /copilot CLI exited 2/);
  assert.match(outcome.error!, /not authenticated/);
});

test("the budget covers every try: a CLI that outlasts the clock is cut off, no second try", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const fake = fakeCopilotRunner(() => ({ code: 0, stdout: HAPPY_JSON, timedOut: true, delayMs: 250 }));
  const factory = createFactory({
    stateDir: join(dir, "factory"),
    retroCopilotProbe: () => true,
    retroCopilotRunner: fake.runner,
    retroBudgetMs: 200,
  });
  factory.setContract({ task: "R5", workspace, gate: "true", artifact });

  const outcome = await factory.retro();
  assert.equal(outcome.outcome, "failed");
  assert.match(outcome.error!, /retro budget of 200ms exceeded/);
  assert.equal(fake.calls.length, 1, "a spent clock gets no second try");
});

test("refusals write no line: copilot unusable, and a same-day successful retro", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");

  const bare = createFactory({ stateDir, retroCopilotProbe: () => false });
  await assert.rejects(bare.retro(), codeIs("retro-copilot-unusable"));
  assert.deepEqual([...bare.ledger.events.filter((e) => e.event === "retro_written")], [], "no line for the unusable CLI");

  const fake = happyRunner();
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: fake.runner });
  factory.setContract({ task: "R6", workspace, gate: "true", artifact });
  const claimed = commitWork(workspace, artifact);
  await factory.claim({ task: "R6", sha: claimed, agent: "agent-r6" });
  const first = await factory.retro();
  assert.equal(first.outcome, "written");

  await assert.rejects(
    factory.retro(),
    (err: unknown): boolean => err instanceof Error && codeIs("retro-same-day")(err) && err.message.includes("proposals sit in"),
    "the same-day refusal points at today's file",
  );
  assert.equal(factory.ledger.events.filter((e) => e.event === "retro_written").length, 1, "the refusal recorded nothing");
  assert.equal(fake.calls.length, 1, "the refused run never asked the model");
});

test("a retro over an empty ledger is an honest written zero", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  const fake = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: fake.runner });

  const outcome = await factory.retro();
  assert.equal(outcome.outcome, "written");
  assert.equal(outcome.proposalCount, 0);
  const file = readFileSync(outcome.proposalsPath!, "utf8");
  assert.ok(file.includes("— 0 proposals"));
  assert.ok(file.includes("(the model proposed nothing"), "the file says the honest empty read");
});

// ---- the spool kind -------------------------------------------------------------------

test("parseSpoolRequest: retro accepts exactly {id, kind} and nothing else", () => {
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "retro" }), { id: "r1", kind: "retro" });
  for (const bad of [{ id: "r1" }, { kind: "retro" }, { id: "r1", kind: "retro", task: "T1" }, { id: "r1", kind: "retro", since: 5 }]) {
    assert.equal(parseSpoolRequest(bad), undefined, `${JSON.stringify(bad)} must be rejected — the retro carries nothing`);
  }
});

test("handleSpoolRequest: retro replies with the count and path, or refuses on the failed pass", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  pinRetroLane(stateDir);
  const fake = happyRunner();
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: fake.runner });
  factory.setContract({ task: "S1", workspace, gate: "true", artifact });
  const claimed = commitWork(workspace, artifact);
  await factory.claim({ task: "S1", sha: claimed, agent: "agent-s1" });

  const written = await handleSpoolRequest(factory, { id: "q1", kind: "retro" });
  assert.ok(written.ok, "the retro round-trips");
  if (written.ok) {
    assert.match(written.summary, /^retro written: 3 proposals → .+retro-\d{4}-\d{2}-\d{2}\.md$/);
    assert.ok(written.proposalsPath!.endsWith(".md"));
    assert.equal(written.proposalCount, 3);
  }

  // A same-day second request: the refusal rides the reply, no ledger line.
  const refused = await handleSpoolRequest(factory, { id: "q2", kind: "retro" });
  assert.ok(!refused.ok && refused.code === "retro-same-day");

  // A failed pass is a red-flagged reply — its failed line already landed.
  const dir2 = makeTempDir();
  disposeDir(t, dir2);
  const stateDir2 = join(dir2, "factory");
  const failing = fakeCopilotRunner(() => ({ code: 1, stdout: "", stderr: "copilot: nope" }));
  pinRetroLane(stateDir2);
  const factory2 = createFactory({ stateDir: stateDir2, retroCopilotProbe: () => true, retroCopilotRunner: failing.runner });
  const failed = await handleSpoolRequest(factory2, { id: "q3", kind: "retro" });
  assert.ok(!failed.ok && failed.code === "retro-failed" && /copilot CLI exited 1/.test(failed.message));
  assert.ok(factory2.ledger.events.some((e) => e.event === "retro_written"), "the failure is visible in the ledger");
});

// ---- the Owner CLI against the real halves ---------------------------------------------

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

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

test("factory retro through the real CLI and spool: exit 0, count + path on stdout, same-day exit 2", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  pinRetroLane(stateDir);
  const fake = happyRunner();
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: fake.runner });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());
  factory.setContract({ task: "CLI1", workspace, gate: "true", artifact });
  const claimed = commitWork(workspace, artifact);
  await factory.claim({ task: "CLI1", sha: claimed, agent: "agent-cli1" });
  const ownerEnv = { PASEO_HOME: home };

  const first = await run(ownerCli, ["retro"], ownerEnv);
  assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  assert.match(first.stdout, /retro written: 3 proposals → .+retro-\d{4}-\d{2}-\d{2}\.md/);

  const second = await run(ownerCli, ["retro"], ownerEnv);
  assert.equal(second.status, 2, "a same-day second run is refused, exit 2");
  assert.match(second.stderr, /a retro already ran today/);

  // The retro takes no arguments — whole-ledger always.
  const positional = await run(ownerCli, ["retro", "since-tuesday"], ownerEnv);
  assert.equal(positional.status, 2);
  assert.match(positional.stderr, /unexpected positional/);

  // The help names the command and its 660s default.
  const help = await run(ownerCli, ["--help"], {});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /retro\s+Run the Retro over the whole ledger/);
  assert.match(help.stdout, /default 660/);
});

test("v0.0.13: the retro reads its lane from lanes.json — a claude lane dispatches claude tool-less, model recorded verbatim", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  writeLanes(stateDir, { retro: "claude/opus-4-8" });
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: happyRunner().runner });
  factory.setContract({ task: "R9", workspace, gate: "true", artifact });
  const claimed = commitWork(workspace, artifact);
  await factory.claim({ task: "R9", sha: claimed, agent: "agent-r9" });

  const outcome = await factory.retro();
  assert.equal(outcome.outcome, "written");
  assert.equal(outcome.model, "claude/opus-4-8", "the lane string is the ledger's model, verbatim");
  const file = readFileSync(outcome.proposalsPath!, "utf8");
  assert.ok(file.includes("- Model: claude/opus-4-8"), "the proposals file names the lane");
  const lane = factory.ledger.events.findLast((e) => e.event === "retro_written")!;
  assert.equal(lane.model, "claude/opus-4-8");
});

test("v0.0.13: the retro runner seam records the lane's command — claude -p, tools off", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  writeLanes(stateDir, { retro: "claude/opus-4-8" });
  const fake = fakeCopilotRunner((_call, index) =>
    index === 0
      ? { code: 0, stdout: '{"proposals":[]}' }
      : { code: 0, stdout: "unused" },
  );
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: fake.runner });
  factory.setContract({ task: "R10", workspace, gate: "true", artifact });
  const claimed = commitWork(workspace, artifact);
  await factory.claim({ task: "R10", sha: claimed, agent: "agent-r10" });

  await factory.retro();
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.command, "claude");
  assert.deepEqual(fake.calls[0]!.args, ["-p", "--model", "opus-4-8", "--tools", ""], "tools off by construction");
  assert.match(fake.calls[0]!.stdin, /retro corpus/);
});
