import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/factory.ts";
import { buildCodeAnswers, buildWatchPrompt, renderTimelineTranscript, runWatchPass, WATCH_QUESTIONS } from "../src/watch.ts";
import { WATCH_TIMELINE_MAX_CHARS } from "../src/constants.ts";
import type { Factory } from "../src/factory.ts";
import type { ContractSet, WatchWritten } from "../src/events.ts";
import type { WatchTimelineEntry } from "../src/watch.ts";
import { copilotAnswerLines, disposeDir, factoryErrorCode, fakeCopilotRunner, gitCommitAll, gitCommitChanges, makeTempDir, writeLanes } from "./helpers.ts";

/**
 * The watch station (v0.0.6, tickets 01–04 + ticket 05 amendment 2) against a
 * fake Copilot CLI runner — hermetic, no network, no binary. Every behavior
 * the design fixed: trigger (BOTH verdicts, marked contracts only), the
 * state's composition and caps, the free-tier code answers, the prompt's
 * shape and strict output contract, the one ledger line, report rendering,
 * failure semantics (no agent, no timeline, malformed answers, the retry
 * rule, the budget), and the description-slot rider's contract field.
 */

/** All five names (the v0.0.8 rider #1 re-arm), one happy answer set — sorted desc: scope-creep first. */
const ALL_FIVE: Record<string, number> = {
  "destructive-writes": 0.03,
  "test-weakened": 0.05,
  "stuck-loop": 0.2,
  "scope-creep": 0.61,
  "secret-leak": 0.07,
};

/** A three-entry projected timeline — the shapes the transcript renderer must speak. */
const TIMELINE: WatchTimelineEntry[] = [
  { seq: 2, item: { type: "user_message", text: "Do the assigned work on branch `w1`." } },
  { seq: 5, item: { type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command: "npm test", exitCode: 0, output: "ok 3 tests" } } },
  { seq: 7, item: { type: "assistant_message", text: "Done — all tests pass." } },
];

const timelineFetcher = (entries: WatchTimelineEntry[]) => {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (agentId: string) => {
      seen.push(agentId);
      return { ok: true as const, entries };
    },
  };
};

/** A git workspace at its base commit, ready for a Contract. */
function makeWorkspaceAtBase(dir: string): { workspace: string; artifact: string; base: string } {
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  const artifact = "src/format.ts";
  writeFileSync(join(workspace, artifact), "export function pad() {}\n");
  const base = gitCommitAll(workspace);
  return { workspace, artifact, base };
}

/** The Agent's "work": a real change, committed — returns the claimable sha. */
function commitFix(workspace: string, artifact: string): string {
  writeFileSync(join(workspace, artifact), "export function pad(input: string): string {\n  return input;\n}\n");
  return gitCommitChanges(workspace, "implement pad");
}

function watchEvent(factory: Factory, task: string): WatchWritten {
  const watch = factory.ledger.eventsFor(task).findLast((e): e is WatchWritten => e.event === "watch_written");
  assert.ok(watch, "watch_written landed");
  return watch;
}

/** The fake CLI's happy stand-in — the factory's options for a hermetic watch. */
function happyCopilot() {
  return fakeCopilotRunner(() => ({ code: 0, stdout: copilotAnswerLines(ALL_FIVE) }));
}

/** Extracts the STATE JSON back out of a captured prompt — it is the prompt's tail. */
function stateOfPrompt(prompt: string): Record<string, unknown> {
  const marker = "STATE (the run's recorded material):\n";
  const at = prompt.indexOf(marker);
  assert.ok(at > -1, "the prompt carries the STATE section");
  return JSON.parse(prompt.slice(at + marker.length)) as Record<string, unknown>;
}

test("fail-fast at contract_set: watch without a usable copilot CLI is refused, loudly, before any work", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  writeLanes(join(dir, "factory"), { watch: "copilot/gpt-5.4" }); // the lane under test — the message names its CLI
  const factory = createFactory({ stateDir: join(dir, "factory"), watchCopilotProbe: () => false });

  assert.throws(
    () => factory.setContract({ task: "W1", workspace, gate: "true", artifact, watch: true }),
    (err: unknown) => err instanceof Error && /copilot CLI/.test(err.message) && factoryErrorCode("watch-unconfigured")(err),
  );
  assert.deepEqual([...factory.ledger.events], [], "a refused contract writes nothing");
});

test("watch: false is refused — the mark is ON or absent, never off-by-accident", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), watchCopilotProbe: () => true });

  assert.throws(
    () => factory.setContract({ task: "W3", workspace, gate: "true", artifact, watch: false as unknown as true }),
    factoryErrorCode("invalid-contract"),
  );
});

test("a green marked claim runs the watch: ledger order, event fields, CLI argv, prompt shape, report line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  writeLanes(stateDir, { watch: "copilot/gpt-5.4" }); // the lane this suite's argv/model assertions pin
  const fake = happyCopilot();
  const feed = timelineFetcher(TIMELINE);

  const factory = createFactory({
    stateDir,
    fetchTimeline: feed.fetch,
    watchCopilotProbe: () => true,
    watchCopilotRunner: fake.runner,
  });
  factory.setContract({ task: "W4", workspace, gate: "echo gate-ran", artifact, watch: true, description: "Implement pad()." });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W4", sha: claimed, agent: "agent-w4" });
  assert.equal(outcome.verdict, "green");

  // Ticket 03's closing-window order: the watch sits between the verdict and
  // the report, where the eye would — on both verdicts, here green.
  assert.deepEqual(factory.ledger.eventsFor("W4").map((e) => e.event), [
    "contract_set",
    "claim_reported",
    "gate_started",
    "gate_finished",
    "watch_written",
    "report_written",
  ]);

  // The timeline read targeted the claiming agent.
  assert.deepEqual(feed.seen, ["agent-w4"]);

  const watch = watchEvent(factory, "W4");
  assert.equal(watch.model, "copilot/gpt-5.4");
  assert.equal(watch.outcome, "written");
  assert.deepEqual(watch.answers, ALL_FIVE);
  assert.equal(watch.usage, undefined, "the CLI reports no usage — nothing is invented");
  assert.ok(typeof watch.durationMs === "number" && watch.durationMs >= 0);
  assert.equal(watch.error, undefined);

  // The one CLI call: silent, model pinned, reasoning effort pinned, prompt on stdin.
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0]!;
  assert.deepEqual(call.args, ["-s", "--model", "gpt-5.4", "--reasoning-effort", "medium"], "the argv never wavers — no auto, no config");
  const prompt = call.stdin;
  assert.ok(prompt.includes("Do not run commands"), "the prompt forbids tool use");
  assert.match(prompt, /EXACTLY five lines/, "the strict output contract is stated");
  for (const question of WATCH_QUESTIONS) {
    assert.ok(prompt.includes(question.name), `${question.name}: named`);
    assert.ok(prompt.includes(question.instructions), `${question.name}: literal instructions`);
    assert.ok(prompt.includes(question.criteria.true), `${question.name}: true criteria`);
    assert.ok(prompt.includes(question.criteria.false), `${question.name}: false criteria`);
  }
  for (const dropped of ["fake-done", "unverified-claims", "self-accept"]) {
    assert.ok(!prompt.includes(dropped), `${dropped}: gone with the rider #1 shrink`);
  }
  assert.ok(!prompt.includes('"prior"') && !/\bprior\b/i.test(prompt), "priors are operator metadata — never sent");

  const state = stateOfPrompt(prompt);
  assert.deepEqual(Object.keys(state), ["note", "contract", "diff", "gate_output", "code_answers", "timeline"]);
  const stateContract = state.contract as Record<string, unknown>;
  assert.equal(stateContract.task, "W4");
  assert.equal(stateContract.description, "Implement pad().");
  assert.equal(stateContract.claimed_sha, claimed);
  assert.equal(stateContract.verdict, undefined, "the factory's own verdict never rides the state — no anchoring");
  assert.ok(String(state.diff).includes("+export function pad(input: string)"), "the diff is in the state");
  assert.equal(state.gate_output, "gate-ran\n");
  assert.ok(String(state.timeline).includes("[2] user_message: Do the assigned work on branch `w1`."));
  assert.ok(String(state.timeline).includes("[5] tool_call/shell: npm test [exit 0] out: ok 3 tests"));
  assert.ok(String(state.timeline).includes("[7] assistant_message: Done — all tests pass."));
  const codeAnswers = state.code_answers as Record<string, unknown>;
  assert.match(String(codeAnswers.artifact_check), /present/);
  assert.match(String(codeAnswers.scope_check), /unrestricted/);
  assert.deepEqual(codeAnswers.git_blocks, []);
  assert.equal(codeAnswers.self_accept, undefined, "the self-accept code answer left with its question (rider #1)");

  // The report carries the watch's line between the Verdict and the closing
  // language, answers sorted desc, with the display-only ≥0.5 callout.
  const report = readFileSync(outcome.reportPath, "utf8");
  const verdictAt = report.indexOf("- Verdict: GREEN");
  const watchAt = report.indexOf("- Watch (gpt-5.4) — 5 answers: scope-creep 0.61, stuck-loop 0.20");
  const closingAt = report.indexOf("- Evidence, not acceptance");
  assert.ok(verdictAt > -1 && watchAt > verdictAt && closingAt > watchAt, "watch line sits between verdict and closing language");
  assert.ok(report.includes("≥0.5: scope-creep"), "the callout names the flagged questions, display-only");
});

test("a red verdict runs the watch too — with honest markers where the stations never reached", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  writeLanes(stateDir, { watch: "copilot/gpt-5.4" });
  const fake = happyCopilot();
  const feed = timelineFetcher(TIMELINE);

  const factory = createFactory({ stateDir, fetchTimeline: feed.fetch, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });
  factory.setContract({ task: "W5", workspace, gate: "exit 1", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W5", sha: claimed, agent: "agent-w5" });
  assert.equal(outcome.verdict, "red");

  assert.equal(watchEvent(factory, "W5").outcome, "written", "red is watched — the battery's red arms depend on it");
  const state = stateOfPrompt(fake.calls[0]!.stdin);
  assert.equal((state.contract as Record<string, unknown>).verdict, undefined, "no verdict anchoring on red either");
  const codeAnswers = state.code_answers as Record<string, unknown>;
  assert.match(String(codeAnswers.artifact_check), /present/, "the gate ran and the artifact existed — the fact, not the verdict");

  // A station-1 red (no resolved sha) never resolved a diff — the state says
  // so instead of leaving a silent gap.
  writeLanes(join(dir, "factory2"), { watch: "copilot/gpt-5.4" });
  const factory2 = createFactory({ stateDir: join(dir, "factory2"), fetchTimeline: feed.fetch, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });
  factory2.setContract({ task: "W5b", workspace, gate: "true", artifact, watch: true });
  await factory2.claim({ task: "W5b", sha: "deadbeef", agent: "agent-w5b" });

  const station1State = stateOfPrompt(fake.calls.at(-1)!.stdin);
  assert.equal(station1State.diff, "[diff unavailable: no resolved sha]");
  const station1Answers = station1State.code_answers as Record<string, unknown>;
  assert.match(String(station1Answers.artifact_check), /not checked/);
  assert.equal(station1State.gate_output, "[gate did not run this attempt]");
  assert.ok(factory2.ledger.eventsFor("W5b").some((e) => e.event === "watch_written"), "the pass still ran and recorded");
});

test("a scope red carries its violations into the free tier", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src/keep.ts"), "export const a = 1;\n");
  gitCommitAll(workspace);
  const stateDir = join(dir, "factory");
  const fake = happyCopilot();
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });

  factory.setContract({ task: "W6", workspace, gate: "true", artifact: "src/keep.ts", scope: ["src/inside"], watch: true });
  mkdirSync(join(workspace, "src/inside"), { recursive: true });
  writeFileSync(join(workspace, "src/inside/x.ts"), "export const x = 1;\n");
  writeFileSync(join(workspace, "src/outside.ts"), "export const oops = 1;\n");
  const claimed = gitCommitChanges(workspace, "scope creep");
  await factory.claim({ task: "W6", sha: claimed, agent: "agent-w6" });

  const codeAnswers = stateOfPrompt(fake.calls[0]!.stdin).code_answers as Record<string, unknown>;
  assert.equal(codeAnswers.scope_check, "violations: src/outside.ts");
});

test("git blocks the ledger holds ride the free tier", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = happyCopilot();
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });

  factory.setContract({ task: "W7", workspace, gate: "true", artifact, watch: true });
  factory.ledger.append({ event: "git_blocked", task: "W7", agent: "agent-w7", command: "git push --force origin main", rule: "git:force-push", reason: "destructive", cwd: workspace, blockId: "b-1" });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W7", sha: claimed, agent: "agent-w7" });

  const codeAnswers = stateOfPrompt(fake.calls[0]!.stdin).code_answers as Record<string, unknown>;
  assert.deepEqual(codeAnswers.git_blocks, ["git:force-push: git push --force origin main"]);
});

test("an unmarked contract behaves exactly like before — no copilot call, no watch line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const fake = happyCopilot();
  const factory = createFactory({ stateDir: join(dir, "factory"), watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });

  factory.setContract({ task: "W8", workspace, gate: "true", artifact });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W8", sha: claimed, agent: "agent-w8" });

  assert.equal(outcome.verdict, "green");
  assert.equal(fake.calls.length, 0, "no watch call where none was asked for");
  assert.ok(!factory.ledger.eventsFor("W8").some((e) => e.event === "watch_written"));
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(!report.includes("Watch"), "no watch line where none was asked for");
});

test("a claim with no agent is an honest failed line — no call, no timeline to read", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  writeLanes(stateDir, { watch: "copilot/gpt-5.4" });
  const fake = happyCopilot();
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });

  factory.setContract({ task: "W9", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W9", sha: claimed });

  assert.equal(outcome.verdict, "green", "a failed watch never touches the verdict");
  assert.equal(fake.calls.length, 0, "no timeline means no ask — the questions are about the run");
  const watch = watchEvent(factory, "W9");
  assert.equal(watch.outcome, "failed");
  assert.match(watch.error!, /no agent bound to the claim/);
  assert.equal(watch.model, "copilot/gpt-5.4", "the pinned model stands in when no answer arrived");
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("- Watch — FAILED: "), "the failure renders where the Owner reads");
  const accepted = factory.accept({ task: "W9", attempt: 1 });
  assert.equal(accepted.event, "attempt_accepted", "accept still requires only a green verdict");
});

test("a timeline the daemon cannot serve is a failed line naming the reason", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = happyCopilot();
  const factory = createFactory({
    stateDir,
    fetchTimeline: async () => ({ ok: false, reason: "the daemon answered: Unknown agent" }),
    watchCopilotProbe: () => true,
    watchCopilotRunner: fake.runner,
  });

  factory.setContract({ task: "W10", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W10", sha: claimed, agent: "agent-restarted-away" });

  const watch = watchEvent(factory, "W10");
  assert.equal(watch.outcome, "failed");
  assert.match(watch.error!, /Unknown agent/);
});

test("a shell with no captured PaseoApi is a failed line — the plugin was never hooked", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = happyCopilot();
  const factory = createFactory({ stateDir, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner }); // no fetchTimeline

  factory.setContract({ task: "W11", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W11", sha: claimed, agent: "agent-w11" });

  const watch = watchEvent(factory, "W11");
  assert.equal(watch.outcome, "failed");
  assert.match(watch.error!, /no PaseoApi/);
});

test("malformed answers: missing names and non-numeric values are nulls, outcome failed naming the missing", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  // One of the five answered well, one non-numeric, one out of range, two absent.
  const fake = fakeCopilotRunner(() => ({
    code: 0,
    stdout: "test-weakened: 0.9\nsecret-leak: high\nstuck-loop: 3\nsome-random-line: hello",
  }));
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });

  factory.setContract({ task: "W12", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W12", sha: claimed, agent: "agent-w12" });

  const watch = watchEvent(factory, "W12");
  assert.equal(watch.outcome, "failed");
  assert.equal(watch.answers!["test-weakened"], 0.9, "the one good answer is kept");
  assert.equal(watch.answers!["secret-leak"], null, "a non-numeric answer is a null, never a guess");
  assert.equal(watch.answers!["stuck-loop"], null, "an out-of-range probability is a null, never clamped");
  assert.match(watch.error!, /missing question answers/);
  assert.ok(watch.error!.includes("scope-creep"), "the absent question is named");
  assert.ok(watch.error!.includes("destructive-writes"), "the re-armed question is named too when absent");
  assert.ok(watch.error!.includes("secret-leak"), "the non-numeric question is named");
  assert.ok(watch.error!.includes("stuck-loop"), "the out-of-range question is named");
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("- Watch — FAILED: missing question answers"), "the report keys on the outcome, not the partial answers");
});

test("a transient CLI failure retries exactly once and succeeds", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = fakeCopilotRunner((_call, index) =>
    index === 0
      ? { code: 1, stdout: "", stderr: "copilot: transient boot failure" }
      : { code: 0, stdout: copilotAnswerLines(ALL_FIVE) },
  );
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });

  factory.setContract({ task: "W13", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W13", sha: claimed, agent: "agent-w13" });

  assert.equal(fake.calls.length, 2, "one transient retry, never more");
  assert.equal(watchEvent(factory, "W13").outcome, "written");
});

test("a CLI that keeps failing is a failed line naming the exit and stderr", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  writeLanes(stateDir, { watch: "copilot/gpt-5.4" });
  const fake = fakeCopilotRunner(() => ({ code: 2, stdout: "", stderr: "copilot: not authenticated" }));
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });

  factory.setContract({ task: "W14", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W14", sha: claimed, agent: "agent-w14" });

  assert.equal(fake.calls.length, 2, "the retry happened, then honesty");
  const watch = watchEvent(factory, "W14");
  assert.equal(watch.outcome, "failed");
  assert.match(watch.error!, /copilot CLI exited 2/);
  assert.match(watch.error!, /not authenticated/);
});

test("the budget covers every try: a CLI that outlasts the clock is cut off and recorded", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = fakeCopilotRunner(() => ({ code: 0, stdout: "", timedOut: true, delayMs: 250 }));
  const factory = createFactory({
    stateDir,
    fetchTimeline: timelineFetcher(TIMELINE).fetch,
    watchCopilotProbe: () => true,
    watchCopilotRunner: fake.runner,
    watchBudgetMs: 200,
  });

  factory.setContract({ task: "W17", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  const started = Date.now();
  const outcome = await factory.claim({ task: "W17", sha: claimed, agent: "agent-w17" });
  const wall = Date.now() - started;

  assert.ok(wall < 10_000, `the pass stayed near its budget (took ${wall}ms)`);
  assert.equal(outcome.verdict, "green");
  const watch = watchEvent(factory, "W17");
  assert.equal(watch.outcome, "failed");
  assert.match(watch.error!, /budget of 200ms exceeded/);
  assert.equal(fake.calls.length, 1, "a spent clock gets no second try");
  assert.ok(watch.durationMs >= 200, `durationMs tells the truth (${watch.durationMs}ms)`);
});

test("the transcript renderer: one line per entry, outputs kept, failures named", () => {
  const entries: WatchTimelineEntry[] = [
    ...TIMELINE,
    { seq: 9, item: { type: "tool_call", name: "Bash", status: "failed", detail: { type: "shell", command: "npm test", exitCode: 1, output: "AssertionError: expected 2\ngot 3" } } },
    { seq: 11, item: { type: "tool_call", name: "Edit", status: "completed", detail: { type: "edit", filePath: "test/x.test.ts", unifiedDiff: "-assert.equal(n, 2)\n+assert.equal(n, 3)" } } },
    { seq: 13, item: { type: "todo", items: [{ text: "write tests", completed: true }, { text: "fix bug", completed: false }] } },
    { seq: 15, item: { type: "error", message: "provider exploded" } },
    { seq: 17, item: { type: "notification", level: "warning", message: "context low" } },
    { seq: 19, item: { type: "compaction", status: "completed", trigger: "auto" } },
    { seq: 21, item: { type: "plugin", pluginId: "other", kind: "note", data: { hello: 1 } } },
    { seq: 23, item: { type: "tool_call", name: "WebFetch", status: "completed", detail: { type: "fetch", url: "https://x.test", code: 200, result: "ok" } } },
    { seq: 25, item: { type: "mystery_item", text: "from the future" } },
  ];
  const transcript = renderTimelineTranscript(entries);
  const lines = transcript.split("\n");
  assert.equal(lines.length, entries.length, "exactly one line per entry");
  assert.equal(lines[0], "[2] user_message: Do the assigned work on branch `w1`.");
  assert.equal(lines[3], "[9] tool_call/shell: npm test [exit 1] out: AssertionError: expected 2\\ngot 3 ! failed: ");
  assert.equal(lines[4], "[11] tool_call/edit: test/x.test.ts diff: -assert.equal(n, 2)\\n+assert.equal(n, 3)");
  assert.match(lines[5]!, /^\[13\] todo: 1\/2 done: \[x\] write tests; \[ \] fix bug$/);
  assert.equal(lines[6], "[15] error: provider exploded");
  assert.equal(lines[7], "[17] notification(warning): context low");
  assert.equal(lines[8], "[19] compaction: completed (auto)");
  assert.match(lines[9]!, /^\[21\] plugin\(other\/note\): /);
  assert.equal(lines[10], "[23] tool_call/fetch: https://x.test [200] ok");
  assert.match(lines[11]!, /^\[25\] mystery_item: /);
});

test("an oversized timeline is tail-capped with its marker; the newest entries survive", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = happyCopilot();

  // One giant shell output past the timeline cap — the marker must show and
  // the tail survive, the head go.
  const overCap: WatchTimelineEntry[] = [
    { seq: 1, item: { type: "user_message", text: "start of the run" } },
    { seq: 3, item: { type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command: "spew", exitCode: 0, output: "x".repeat(200_000) } } },
  ];
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(overCap).fetch, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });
  factory.setContract({ task: "W19", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W19", sha: claimed, agent: "agent-w19" });

  const state = stateOfPrompt(fake.calls[0]!.stdin);
  const timeline = String(state.timeline);
  assert.ok(timeline.startsWith("[truncated]"), "the cut timeline says so");
  assert.ok(timeline.length < WATCH_TIMELINE_MAX_CHARS + 1_000, `capped near ${WATCH_TIMELINE_MAX_CHARS}, got ${timeline.length}`);
  assert.ok(!timeline.includes("start of the run"), "the tail is kept, the head is cut");
  assert.ok(/x{1000}/.test(timeline), "the newest entry's output tail survives");
});

test("buildCodeAnswers: every branch of the free tier", () => {
  const base = { verdict: "green" as const, artifact: "out.txt", gitBlocks: [] as { rule: string; command: string }[] };
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: true, scope: undefined, scopeViolations: undefined }).artifact_check,
    'present (the gate checked "out.txt")',
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: false, scope: undefined, scopeViolations: undefined }).artifact_check,
    'missing (the gate checked "out.txt")',
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: false, artifactPresent: undefined, scope: undefined, scopeViolations: undefined }).artifact_check,
    "not checked (the gate did not run — the verdict landed before the gate station)",
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: undefined, scope: undefined, scopeViolations: undefined }).scope_check,
    "unrestricted (the Contract declared no scope)",
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: true, scope: ["src"], scopeViolations: [] }).scope_check,
    "clean (no changes outside [src])",
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: true, scope: ["src"], scopeViolations: ["a.ts", "b.ts"] }).scope_check,
    "violations: a.ts, b.ts",
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: true, scope: ["src"], scopeViolations: undefined }).scope_check,
    "not checked (the scope station produced no measurement this attempt)",
  );
  assert.deepEqual(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: true, scope: ["src"], scopeViolations: [], gitBlocks: [{ rule: "git:reset-hard", command: "git reset --hard" }] }).git_blocks,
    ["git:reset-hard: git reset --hard"],
  );
});

test("the description-slot rider: the Contract records the assignment, the gate's artifact fact rides GateResult", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = happyCopilot();
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });

  const contract = factory.setContract({
    task: "W21",
    workspace,
    gate: "true",
    artifact,
    watch: true,
    description: "Add the pad() helper with its tests.",
  });
  assert.equal(contract.description, "Add the pad() helper with its tests.", "the assignment is Contract data now");
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W21", sha: claimed, agent: "agent-w21" });

  assert.equal((stateOfPrompt(fake.calls[0]!.stdin).contract as Record<string, unknown>).description, "Add the pad() helper with its tests.", "the watch's state carries the intent");
  assert.ok(existsSync(outcome.reportPath));
});

test("R1 symmetry: a restart during the watch's window writes the missing report — never a second gate_finished, never a re-run", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");

  // The factory "crashes" after a green verdict landed but before the watch
  // or the report finished — the exact window the watch opened.
  const crashed = createFactory({ stateDir, watchCopilotProbe: () => true });
  crashed.setContract({ task: "W22", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  crashed.ledger.append({ event: "claim_reported", task: "W22", attempt: 1, sha: claimed, agent: "agent-w22" });
  crashed.ledger.append({ event: "gate_started", task: "W22", attempt: 1, cmd: "true" });
  crashed.ledger.append({ event: "gate_finished", task: "W22", attempt: 1, exit: 0, verdict: "green", note: "", sha: claimed });

  const reopened = createFactory({ stateDir, watchCopilotProbe: () => true });

  assert.deepEqual(reopened.recoveredAttempts, [{ task: "W22", attempt: 1 }]);
  const finished = reopened.ledger.eventsFor("W22").filter((e) => e.event === "gate_finished");
  assert.equal(finished.length, 1, "the verdict that already landed is never overwritten");
  const reportPath = join(stateDir, "report-W22-1.md");
  assert.ok(existsSync(reportPath), "the missing report is written on recovery");
  const report = readFileSync(reportPath, "utf8");
  assert.ok(report.includes("- Verdict: GREEN"));
  assert.ok(!report.includes("Watch"), "an interrupted pass leaves no watch line — it is never re-run");
});

test("buildWatchPrompt: the strict output contract, question order, and the state as the tail", () => {
  const state = { note: "n", contract: { task: "T" }, diff: "d", gate_output: "g", code_answers: {}, timeline: "t" };
  const prompt = buildWatchPrompt(state);
  const expectedOrder = WATCH_QUESTIONS.map((question) => `${question.name}: <number 0-1>`).join("\n");
  assert.ok(prompt.includes(expectedOrder), "the answer template names all five in order");
  assert.equal(WATCH_QUESTIONS.length, 5, "the v0.0.8 rider #1 re-arm: destructive-writes is back");
  assert.equal(WATCH_QUESTIONS[0]!.name, "destructive-writes", "the v0.0.6 table order restored: destructive-writes first");
  assert.ok(prompt.endsWith(JSON.stringify(state, null, 2)), "the state JSON is the prompt's tail — parseable back out");
  assert.match(prompt, /0 and 1/, "the probability range is stated");
});

test("runWatchPass direct: pinned argv per invocation, the budget shared across tries", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, base } = makeWorkspaceAtBase(dir);
  writeLanes(join(dir, "factory"), { watch: "copilot/gpt-5.4" });
  const fake = fakeCopilotRunner((_call, index) =>
    index === 0 ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: copilotAnswerLines(ALL_FIVE) },
  );
  const contract: ContractSet = {
    seq: 1,
    ts: "2026-10-09T09:00:00.000Z",
    event: "contract_set",
    task: "W23",
    workspace,
    gate: "npm test",
    artifact,
    scope: ["src"],
    base,
    watch: true,
  };

  const outcome = await runWatchPass({
    stateDir: join(dir, "factory"),
    contract,
    task: "W23",
    attempt: 2,
    sha: base,
    gateResult: { exit: 0, verdict: "green", note: "", timedOut: false, output: "", artifactPresent: true },
    gateOutputPath: undefined,
    scopeViolations: [],
    agent: "agent-w23",
    fetchTimeline: timelineFetcher(TIMELINE).fetch,
    gitBlocks: [],
    copilotRunner: fake.runner,
    budgetMs: 5_000,
  });

  assert.equal(outcome.outcome, "written");
  assert.equal(outcome.model, "copilot/gpt-5.4");
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[0]!.args, ["-s", "--model", "gpt-5.4", "--reasoning-effort", "medium"]);
  assert.ok(fake.calls[1]!.timeoutMs <= 5_000, "the retry's timeout is the REMAINING budget, not a fresh one");
});

test("v0.0.13: the watch reads its lane from lanes.json — a pi lane dispatches pi tool-less, model recorded verbatim", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  writeLanes(stateDir, { watch: "pi/zai/glm-5.3" });
  const fake = happyCopilot();
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchCopilotProbe: () => true, watchCopilotRunner: fake.runner });

  factory.setContract({ task: "W24", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W24", sha: claimed, agent: "agent-w24" });
  assert.equal(outcome.verdict, "green");

  const watch = watchEvent(factory, "W24");
  assert.equal(watch.outcome, "written");
  assert.equal(watch.model, "pi/zai/glm-5.3", "the lane string is the ledger's model, verbatim");
  assert.equal(fake.calls[0]!.command, "pi");
  assert.deepEqual(
    fake.calls[0]!.args,
    ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--model", "zai/glm-5.3"],
    "the tool-less flags are the invariant — the pass cannot act by construction",
  );
});
