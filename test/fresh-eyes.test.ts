import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/factory.ts";
import { parseEyeAnswer } from "../src/fresh-eyes.ts";
import { EYE_DIFF_MAX_CHARS, EYE_GATE_OUTPUT_MAX_CHARS } from "../src/constants.ts";
import type { Factory } from "../src/factory.ts";
import type { GateFinished, FreshEyesWritten } from "../src/events.ts";
import {
  disposeDir,
  eyeAnswer,
  factoryErrorCode,
  gitCommitAll,
  gitCommitChanges,
  fakeCopilotRunner,
  makeTempDir,
  startFakeEye,
  writeEyeConfig,
  writeLanes,
} from "./helpers.ts";

/**
 * The fresh-eyes station (tickets 02–04) against a fake API server on
 * loopback — hermetic, no network. Every behavior the three tickets fixed:
 * trigger (green only, marked contracts only), input bundle + caps, the one
 * ledger line, report rendering, failure semantics (budget, retry rules,
 * fail-fast at contract_set), and the two structural riders R1/R2.
 *
 * The workspace order mirrors reality: the Owner sets the Contract while the
 * workspace sits at the base commit; the Agent's change lands afterwards.
 */

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
function commitFix(workspace: string, artifact: string): string {
  writeFileSync(join(workspace, artifact), "export function pad(input: string): string {\n  return input;\n}\n");
  return gitCommitChanges(workspace, "implement pad");
}

function eyeEvent(factory: Factory, task: string): FreshEyesWritten {
  const eye = factory.ledger.eventsFor(task).findLast((e): e is FreshEyesWritten => e.event === "fresh_eyes_written");
  assert.ok(eye, "fresh_eyes_written landed");
  return eye;
}

function promptOf(fake: { requests: { body: unknown }[] }): string {
  const body = fake.requests[0]?.body as { messages?: { content?: unknown }[] } | undefined;
  const content = body?.messages?.[0]?.content;
  assert.equal(typeof content, "string", "the fake eye received a user prompt");
  return content as string;
}

test("fail-fast at contract_set: freshEyes whose lane's CLI is unusable is refused, loudly, before any work", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  // No lanes.json, no eye.json: the default CLI lane (pi/zai/glm-5.3) — its
  // CLI probe is refused here, the v0.0.2 eye.json law carried to lanes.
  const factory = createFactory({ stateDir: join(dir, "factory"), eyeCliProbe: () => false });

  assert.throws(
    () => factory.setContract({ task: "FE1", workspace, gate: "true", artifact, freshEyes: true }),
    (err: unknown) => err instanceof Error && /pi\/zai\/glm-5\.3 CLI is not usable/.test(err.message) && factoryErrorCode("eye-unconfigured")(err),
  );
  assert.deepEqual([...factory.ledger.events], [], "a refused contract writes nothing");
});

test("fail-fast at contract_set: eye.json with a missing field is refused", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "eye.json"), JSON.stringify({ provider: "fake", model: "m", baseUrl: "http://127.0.0.1:1" })); // no apiKey

  const factory = createFactory({ stateDir });
  assert.throws(
    () => factory.setContract({ task: "FE2", workspace, gate: "true", artifact, freshEyes: true }),
    factoryErrorCode("eye-unconfigured"),
  );
});

test("freshEyes: false is refused — the mark is ON or absent, never off-by-accident", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  assert.throws(
    () => factory.setContract({ task: "FE3", workspace, gate: "true", artifact, freshEyes: false as unknown as true }),
    factoryErrorCode("invalid-contract"),
  );
});

test("a green marked claim runs the eye: ledger order, event fields, gate log, report line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: eyeAnswer("CONCERN\npad ignores width — src/format.ts:2 truncates nothing.") }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  const contract = factory.setContract({ task: "FE4", workspace, gate: "echo gate-ran", artifact, freshEyes: true });
  assert.ok(contract.base, "the eye's diff range is recorded at contract time (R2)");
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "FE4", sha: claimed, agent: "agent-fe4" });
  assert.equal(outcome.verdict, "green");

  // Ticket 03 §2's exact closing-window order.
  assert.deepEqual(factory.ledger.eventsFor("FE4").map((e) => e.event), [
    "contract_set",
    "claim_reported",
    "gate_started",
    "gate_finished",
    "fresh_eyes_written",
    "report_written",
  ]);

  const claim = factory.ledger.eventsFor("FE4").find((e) => e.event === "claim_reported");
  assert.equal((claim as { agent?: string }).agent, "agent-fe4", "attribution rides the claim (ticket 02b)");

  const gate = factory.ledger.eventsFor("FE4").findLast((e): e is GateFinished => e.event === "gate_finished");
  assert.ok(gate, "gate_finished landed");
  assert.ok(gate.outputPath, "gate_finished points at the persisted output (ticket 02a)");
  assert.equal(gate.outputPath, join(stateDir, "gate-FE4-1.log"));
  assert.equal(readFileSync(gate.outputPath as string, "utf8"), "gate-ran\n", "the log is raw output, not the squashed note");

  const eye = eyeEvent(factory, "FE4");
  assert.equal(eye.model, "fake-eye-1");
  assert.equal(eye.outcome, "concern");
  assert.equal(eye.finding, "pad ignores width — src/format.ts:2 truncates nothing.");
  assert.ok(typeof eye.durationMs === "number" && eye.durationMs >= 0);

  // The eye got one POST: contract + diff + gate output, with auth.
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0]!;
  assert.equal(request.path, "/v1/messages");
  assert.equal(request.headers["x-api-key"], "test-key");
  const body = request.body as { model?: string; max_tokens?: number };
  assert.equal(body.model, "fake-eye-1");
  assert.equal(typeof body.max_tokens, "number");
  const prompt = promptOf(fake);
  assert.ok(prompt.includes("Task: FE4"));
  assert.ok(prompt.includes("Gate command: `echo gate-ran`"));
  assert.ok(prompt.includes("Required artifact: src/format.ts"));
  assert.ok(prompt.includes("-export function pad() {}"), "the base..claimed diff is in the bundle");
  assert.ok(prompt.includes("+export function pad(input: string): string {"));
  assert.ok(prompt.includes("gate-ran"), "the full gate output is in the bundle");
  assert.ok(prompt.includes("CONCERN") && prompt.includes("CLEAR"), "the prompt states the output contract");
  assert.ok(!prompt.includes("test-key"), "the key never leaks into the prompt");

  // The report carries the eye's line between the Verdict and the closing language.
  const report = readFileSync(outcome.reportPath, "utf8");
  const verdictAt = report.indexOf("- Verdict: GREEN");
  const eyeAt = report.indexOf("- Fresh eyes (`fake-eye-1`) — CONCERN: pad ignores width");
  const closingAt = report.indexOf("- Evidence, not acceptance");
  const agentAt = report.indexOf("- Claimed by agent `agent-fe4`");
  assert.ok(verdictAt > -1 && eyeAt > verdictAt && closingAt > eyeAt, "eye line sits between verdict and closing language");
  assert.ok(agentAt > -1, "the report names who claimed (ticket 02b)");
});

test("a CLEAR answer lands as clear — the countable noise flag", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: eyeAnswer("CLEAR\nnothing to add.") }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "FE5", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "FE5", sha: claimed });

  assert.equal(eyeEvent(factory, "FE5").outcome, "clear");
  assert.equal(eyeEvent(factory, "FE5").finding, "nothing to add.");
});

test("a red verdict never calls the eye — green only, by construction", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: eyeAnswer("CLEAR") }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "FE6", workspace, gate: "exit 1", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "FE6", sha: claimed });

  assert.equal(outcome.verdict, "red");
  assert.equal(fake.requests.length, 0, "the eye is never asked about a red attempt");
  assert.deepEqual(factory.ledger.eventsFor("FE6").map((e) => e.event), [
    "contract_set",
    "claim_reported",
    "gate_started",
    "gate_finished",
    "report_written",
  ]);
});

test("an unmarked contract behaves exactly like 0.0.1 — no eye.json needed, no eye call", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") }); // no eye.json anywhere

  factory.setContract({ task: "FE7", workspace, gate: "true", artifact });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "FE7", sha: claimed });

  assert.equal(outcome.verdict, "green");
  assert.ok(!factory.ledger.eventsFor("FE7").some((e) => e.event === "fresh_eyes_written"));
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(!report.includes("Fresh eyes"));
});

test("eye.json is re-read per pass: rotating the model needs no restart", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: eyeAnswer("CLEAR") }));
  writeEyeConfig(stateDir, fake.url, "eye-before-rotation");

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "FE8", workspace, gate: "true", artifact, freshEyes: true });
  writeEyeConfig(stateDir, fake.url, "eye-after-rotation"); // rotated between contract and claim
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "FE8", sha: claimed });

  assert.equal(eyeEvent(factory, "FE8").model, "eye-after-rotation");
  assert.equal((fake.requests[0]?.body as { model?: string }).model, "eye-after-rotation");
});

test("a 429 then a 200: exactly one retry, and it succeeds", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  let calls = 0;
  const fake = await startFakeEye(t, () => {
    calls += 1;
    return calls === 1 ? { status: 429, payload: { error: "rate limited" } } : { status: 200, payload: eyeAnswer("CLEAR") };
  });
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "FE9", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "FE9", sha: claimed });

  assert.equal(fake.requests.length, 2, "one transient retry");
  assert.equal(eyeEvent(factory, "FE9").outcome, "clear");
  assert.equal(outcome.verdict, "green");
});

test("a 401 is never retried: one call, a visible failed line, verdict and accept untouched", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 401, payload: { error: "bad key" } }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "FE10", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "FE10", sha: claimed });

  assert.equal(outcome.verdict, "green", "a dead eye never touches the verdict");
  assert.equal(fake.requests.length, 1, "auth failures get no retry storm");
  const eye = eyeEvent(factory, "FE10");
  assert.equal(eye.outcome, "failed");
  assert.match(eye.finding, /401/);
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("- Fresh eyes (`fake-eye-1`) — FAILED: "), "the failure renders where the Owner reads");
  assert.ok(report.includes("- Evidence, not acceptance"), "ADR 0002's closing language stays the last word");

  const accepted = await factory.accept({ task: "FE10", attempt: 1 });
  assert.equal(accepted.event, "attempt_accepted", "accept still requires only a green verdict");
});

test("a 5xx twice is a failed line, not a hang", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 503, payload: { error: "down" } }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "FE11", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "FE11", sha: claimed });

  assert.equal(fake.requests.length, 2, "5xx is transient: one retry, then the record");
  const eye = eyeEvent(factory, "FE11");
  assert.equal(eye.outcome, "failed");
  assert.match(eye.finding, /503 twice/);
});

test("an unreachable eye fails visibly after its single retry", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: eyeAnswer("CLEAR") }));
  writeEyeConfig(stateDir, fake.url);
  await fake.stop(); // the daemon died: the port now refuses connections

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "FE12", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "FE12", sha: claimed });

  assert.equal(outcome.verdict, "green");
  const eye = eyeEvent(factory, "FE12");
  assert.equal(eye.outcome, "failed");
  assert.match(eye.finding, /unreachable/);
});

test("the budget covers both tries: a hanging eye is cut off and recorded", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ hang: true }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir, eyeBudgetMs: 300 });
  factory.setContract({ task: "FE13", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  const started = Date.now();
  const outcome = await factory.claim({ task: "FE13", sha: claimed });
  const wall = Date.now() - started;

  assert.ok(wall < 10_000, `the closing window stayed near the budget (took ${wall}ms)`);
  const eye = eyeEvent(factory, "FE13");
  assert.equal(eye.outcome, "failed");
  assert.match(eye.finding, /budget of 300ms exceeded/);
  assert.ok(eye.durationMs >= 250, `durationMs tells the truth (${eye.durationMs}ms)`);
});

test("an answer that ignores the output contract is a failed pass, never a guessed verdict", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: eyeAnswer("I think this looks fine overall.") }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "FE14", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "FE14", sha: claimed });

  const eye = eyeEvent(factory, "FE14");
  assert.equal(eye.outcome, "failed");
  assert.match(eye.finding, /not CONCERN or CLEAR/);
});

test("oversized diff and gate output are tail-capped with [truncated] markers", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "src-format.ts"), `export const first = "DIFF-START";\n${"const filler = 1;\n".repeat(9000)}\nexport const last = "DIFF-END";\n`);
  gitCommitAll(workspace);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: eyeAnswer("CLEAR") }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "FE15", workspace, gate: "seq 1 30000", artifact: "src-format.ts", freshEyes: true });
  writeFileSync(
    join(workspace, "src-format.ts"),
    `export const first = "DIFF-START";\n${"const filler = 2;\n".repeat(9000)}\nexport const last = "DIFF-END";\n`,
  );
  const claimed = gitCommitChanges(workspace, "big change");
  await factory.claim({ task: "FE15", sha: claimed });

  const prompt = promptOf(fake);
  const diffSection = prompt.slice(prompt.indexOf("## The diff"), prompt.indexOf("## The gate"));
  const gateSection = prompt.slice(prompt.indexOf("## The gate"));
  assert.ok(diffSection.includes("[truncated]"), "the cut diff says so");
  assert.ok(gateSection.includes("[truncated]"), "the cut gate output says so");
  assert.ok(diffSection.length < EYE_DIFF_MAX_CHARS + 200, `diff section capped (~${EYE_DIFF_MAX_CHARS}), got ${diffSection.length}`);
  assert.ok(gateSection.length < EYE_GATE_OUTPUT_MAX_CHARS + 1000, `gate section capped (~${EYE_GATE_OUTPUT_MAX_CHARS}), got ${gateSection.length}`);
  assert.ok(prompt.includes("30000"), "the tail of the gate output survives");
  assert.ok(prompt.includes("never guess"), "the prompt warns about the cuts");
});

test("R1: a restart during the eye's window writes the missing report — never a second gate_finished", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  writeEyeConfig(stateDir, "http://127.0.0.1:1"); // never called in this test

  // The factory "crashes" after a green verdict landed but before the eye or
  // the report finished — the exact window the eye opened (ticket 03 R1).
  const crashed = createFactory({ stateDir });
  crashed.setContract({ task: "FE16", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  crashed.ledger.append({ event: "claim_reported", task: "FE16", attempt: 1, sha: claimed });
  crashed.ledger.append({ event: "gate_started", task: "FE16", attempt: 1, cmd: "true" });
  crashed.ledger.append({ event: "gate_finished", task: "FE16", attempt: 1, exit: 0, verdict: "green", note: "", sha: claimed });

  const reopened = createFactory({ stateDir });

  assert.deepEqual(reopened.recoveredAttempts, [{ task: "FE16", attempt: 1 }]);
  const finished = reopened.ledger.eventsFor("FE16").filter((e) => e.event === "gate_finished");
  assert.equal(finished.length, 1, "the verdict that already landed is never overwritten");
  assert.equal(finished[0]!.verdict, "green");
  const reportPath = join(stateDir, "report-FE16-1.md");
  assert.ok(existsSync(reportPath), "the missing report is written on recovery");
  const report = readFileSync(reportPath, "utf8");
  assert.ok(report.includes("- Verdict: GREEN"));
  assert.ok(!report.includes("Fresh eyes"), "an interrupted pass leaves no eye line");
});

test("parseEyeAnswer: lenient markers, strict absence", () => {
  assert.deepEqual(parseEyeAnswer("CONCERN\nline one."), { outcome: "concern", finding: "line one." });
  assert.deepEqual(parseEyeAnswer("**CLEAR**\nnothing to add."), { outcome: "clear", finding: "nothing to add." });
  assert.deepEqual(parseEyeAnswer("CLEAR.\n"), { outcome: "clear", finding: "" });
  const failed = parseEyeAnswer("verdict: probably fine");
  assert.equal(failed.outcome, "failed");
  assert.match(failed.finding, /not CONCERN or CLEAR/);
});

test("parseEyeAnswer: findings over 120 words are capped with a marker", () => {
  const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const parsed = parseEyeAnswer(`CONCERN\n${long}`);
  assert.equal(parsed.outcome, "concern");
  assert.ok(parsed.finding.endsWith(" …"), "the cut is marked");
  assert.equal(parsed.finding.split(" ").filter((w) => w !== "…").length, 120);
});

// ---- the v0.0.13 lane law (ADR 0009 §3) ----------------------------------------------

test("v0.0.13: a CLI lane runs the eye headless and tool-less — no eye.json, no key, the same output contract", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  writeLanes(stateDir, { freshEyes: "claude/opus-4-8" });
  const fake = fakeCopilotRunner(() => ({ code: 0, stdout: "CLEAR\nNothing to add." }));
  const factory = createFactory({ stateDir, eyeCliProbe: () => true, eyeCliRunner: fake.runner });

  factory.setContract({ task: "FE13", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "FE13", sha: claimed, agent: "agent-fe13" });
  assert.equal(outcome.verdict, "green");

  const eye = eyeEvent(factory, "FE13");
  assert.equal(eye.outcome, "clear");
  assert.equal(eye.model, "claude/opus-4-8", "the lane string is the ledger's model, verbatim");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.command, "claude");
  assert.deepEqual(fake.calls[0]!.args, ["-p", "--model", "opus-4-8", "--tools", ""], "tools off by construction");
  assert.match(fake.calls[0]!.stdin, /fresh-eyes reviewer/, "the CLI lane reads the same prompt bundle");
  assert.equal(existsSync(join(stateDir, "eye.json")), false, "no eye.json exists — the lane needs none");
});

test("v0.0.13: an existing eye.json keeps answering when lanes.json never named a freshEyes lane (the upgrade never retires a configured eye)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fakeEyeServer = await startFakeEye(t, () => ({ status: 200, payload: eyeAnswer("CLEAR") }));
  writeEyeConfig(stateDir, fakeEyeServer.url, "legacy-eye-1"); // no lanes.json at all
  const factory = createFactory({ stateDir });

  factory.setContract({ task: "FE14", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "FE14", sha: claimed, agent: "agent-fe14" });

  assert.equal(fakeEyeServer.requests.length, 1, "the legacy direct-API path ran, untouched");
  assert.equal(eyeEvent(factory, "FE14").model, "legacy-eye-1");
});

test("v0.0.13: an explicit lanes.freshEyes overrides an existing eye.json, and 'eye.json' pins the legacy path on purpose", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fakeEyeServer = await startFakeEye(t, () => ({ status: 200, payload: eyeAnswer("CLEAR") }));
  writeEyeConfig(stateDir, fakeEyeServer.url, "legacy-eye-1");

  // Explicit CLI lane wins over the eye.json that exists.
  writeLanes(stateDir, { freshEyes: "pi/zai/glm-5.3" });
  const cli = fakeCopilotRunner(() => ({ code: 0, stdout: "CLEAR" }));
  const factoryCli = createFactory({ stateDir, eyeCliProbe: () => true, eyeCliRunner: cli.runner });
  factoryCli.setContract({ task: "FE15", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  await factoryCli.claim({ task: "FE15", sha: claimed, agent: "agent-fe15" });
  assert.equal(fakeEyeServer.requests.length, 0, "the explicit lane bypassed the HTTP eye");
  assert.equal(cli.calls[0]!.command, "pi");
  assert.equal(eyeEvent(factoryCli, "FE15").model, "pi/zai/glm-5.3");

  // Explicit "eye.json" pins the legacy path — the deliberate opt-in. (A
  // second factory on its own stateDir: FE15's contract still owns the tree.)
  const stateDir2 = join(dir, "factory-eye");
  writeEyeConfig(stateDir2, fakeEyeServer.url, "legacy-eye-1");
  writeLanes(stateDir2, { freshEyes: "eye.json" });
  const factoryEye = createFactory({ stateDir: stateDir2 });
  factoryEye.setContract({ task: "FE16", workspace, gate: "true", artifact, freshEyes: true });
  writeFileSync(join(workspace, artifact), "export function pad(input: string): string {\n  return input.trim();\n}\n");
  const claimed2 = gitCommitChanges(workspace, "implement pad differently — a second real change");
  await factoryEye.claim({ task: "FE16", sha: claimed2, agent: "agent-fe16" });
  assert.equal(fakeEyeServer.requests.length, 1, "the named eye.json lane ran the direct-API path");
  assert.equal(eyeEvent(factoryEye, "FE16").model, "legacy-eye-1");
});

test("v0.0.13: a CLI-lane eye that breaks the output contract is an honest failed line naming the first line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  writeLanes(stateDir, { freshEyes: "pi/zai/glm-5.3" });
  const fake = fakeCopilotRunner(() => ({ code: 0, stdout: "Seems fine to me." }));
  const factory = createFactory({ stateDir, eyeCliProbe: () => true, eyeCliRunner: fake.runner });

  factory.setContract({ task: "FE17", workspace, gate: "true", artifact, freshEyes: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "FE17", sha: claimed, agent: "agent-fe17" });

  assert.equal(outcome.verdict, "green", "a failed eye never touches the verdict");
  const eye = eyeEvent(factory, "FE17");
  assert.equal(eye.outcome, "failed");
  assert.match(eye.finding, /output contract/);
  assert.equal(eye.model, "pi/zai/glm-5.3");
});
