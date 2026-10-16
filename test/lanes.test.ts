import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LANE,
  LANE_NAMES,
  laneCliInvocation,
  laneError,
  lanesPath,
  loadLanes,
  parseLane,
  runLaneCli,
  saveLanes,
} from "../src/lanes.ts";
import type { LaneCliRunner } from "../src/lanes.ts";
import { resolveEyeLane } from "../src/fresh-eyes.ts";
import {
  DEFAULT_LANE as DEFAULT_LANE_MJS,
  LANE_NAMES as LANE_NAMES_MJS,
  laneError as laneErrorMjs,
  loadLanes as loadLanesMjs,
  parseLane as parseLaneMjs,
  resolveRunProvider as resolveRunProviderMjs,
} from "../plugin/bin/lanes-config.mjs";
import { disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

/**
 * The unified Lane config and the headless tool-less runner (v0.0.13, ADR
 * 0009 §3): `<stateDir>/lanes.json` names the provider/model lane every
 * model-bearing role runs under, with safe defaults when absent or partial;
 * every CLI lane dispatches with its tools off by construction. The CLI-side
 * mirror (plugin/bin/lanes-config.mjs — ADR 0004: CLIs import no src/ code)
 * is guarded against drift behaviorally, the EVENT_NAMES precedent.
 */

/** Writes a raw lanes.json (the file as an operator or the UI left it). */
function writeRawLanes(stateDir: string, body: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(lanesPath(stateDir), body);
}

test("absent lanes.json loads the six defaults", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");

  const lanes = loadLanes(stateDir);
  assert.ok(lanes.ok, "an absent file is the safe default, never an error");
  assert.deepEqual(lanes.lanes, {
    supervisor: DEFAULT_LANE,
    lead: DEFAULT_LANE,
    worker: DEFAULT_LANE,
    watch: DEFAULT_LANE,
    retro: DEFAULT_LANE,
    freshEyes: DEFAULT_LANE,
  });
});

test("a partial file fills defaults for the missing lanes only", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  writeRawLanes(stateDir, `${JSON.stringify({ watch: "copilot/gpt-5.4" }, null, 2)}\n`);

  const lanes = loadLanes(stateDir);
  assert.ok(lanes.ok);
  assert.equal(lanes.lanes.watch, "copilot/gpt-5.4");
  assert.equal(lanes.lanes.worker, DEFAULT_LANE);
  assert.equal(lanes.lanes.freshEyes, DEFAULT_LANE);
});

test("unparseable JSON is a named error, never a guessed default", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  writeRawLanes(stateDir, "{ not json");

  const lanes = loadLanes(stateDir);
  assert.ok(!lanes.ok);
  assert.match(lanes.reason, /lanes\.json/);
  assert.match(lanes.reason, /valid JSON/);
});

test("lane strings validate: provider/model[:thinking] with all parts non-empty; eye.json only for freshEyes", () => {
  assert.equal(laneError("worker", "pi/zai/glm-5.3"), undefined, "provider/model is the shape");
  assert.equal(laneError("worker", "pi/zai/glm-5.3:max"), undefined, "provider/model:thinking is valid");
  assert.equal(laneError("worker", "claude/claude-sonnet-4-6:high"), undefined);
  assert.deepEqual(parseLane("pi/zai/glm-5.3:max"), { provider: "pi", model: "zai/glm-5.3", thinking: "max" });
  assert.deepEqual(parseLane("pi/zai/glm-5.3"), { provider: "pi", model: "zai/glm-5.3" });
  assert.equal(laneError("freshEyes", "eye.json"), undefined, "the eye's legacy direct-API lane");
  assert.notEqual(laneError("worker", "eye.json"), undefined, "eye.json is the fresh-eyes lane alone");
  assert.notEqual(laneError("watch", "copilot"), undefined, "a bare provider never picks a model by itself — never auto");
  assert.notEqual(laneError("watch", "copilot/"), undefined);
  assert.notEqual(laneError("watch", "pi/zai/glm-5.3:"), undefined, "empty thinking suffix is refused");
  assert.notEqual(laneError("watch", "pi/:high"), undefined, "empty model before :thinking is refused");
  assert.notEqual(laneError("watch", "/gpt-5.4"), undefined);
  assert.notEqual(laneError("watch", "copilot/gpt 5.4"), undefined, "no whitespace inside a lane");
  assert.notEqual(laneError("watch", ""), undefined);
});

test("an invalid lane value is a named error naming the lane", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  writeRawLanes(stateDir, `${JSON.stringify({ retro: "pi" })}\n`);

  const lanes = loadLanes(stateDir);
  assert.ok(!lanes.ok);
  assert.match(lanes.reason, /retro/);
});

test("saveLanes validates every lane and persists only the lanes it names — defaults are never materialized", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");

  const saved = saveLanes(stateDir, { watch: "copilot/gpt-5.4", freshEyes: "eye.json" });
  assert.ok(saved.ok);
  assert.equal(saved.lanes.watch, "copilot/gpt-5.4");
  assert.equal(saved.lanes.freshEyes, "eye.json");
  assert.equal(saved.lanes.worker, DEFAULT_LANE, "an unspecified lane keeps its default — the returned table is the effective one");
  const onDisk = JSON.parse(readFileSync(lanesPath(stateDir), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(onDisk).sort(), ["freshEyes", "watch"], "the file persists exactly the lanes that were set — the eye.json retention invariant");
  const reread = loadLanes(stateDir);
  assert.ok(reread.ok);
  assert.deepEqual(reread.lanes, saved.lanes);
});

test("a single-lane save never names the other lanes — an existing eye.json keeps answering (resolveEyeLane retention)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "eye.json"), JSON.stringify({ provider: "fake", model: "legacy-eye", apiKey: "k", baseUrl: "http://127.0.0.1:1" }));

  // The upgrade scenario: an eye.json exists, lanes.json never did, and the
  // Owner sets one unrelated lane (CLI `factory lanes set worker ...`, or a UI
  // lane-card save). The write must not materialize freshEyes.
  const saved = saveLanes(stateDir, { worker: "claude/opus-4-8" });
  assert.ok(saved.ok);
  assert.deepEqual(JSON.parse(readFileSync(lanesPath(stateDir), "utf8")), { worker: "claude/opus-4-8" }, "one lane in, one lane on disk");
  const eyeLane = resolveEyeLane(stateDir);
  assert.ok(eyeLane.ok);
  assert.equal(eyeLane.lane, "eye.json", "the legacy eye keeps answering — the single-lane write never retired it");

  // A second single-lane write preserves the first named lane, still without
  // naming the rest; an explicit freshEyes set still wins (the ADR 0009 §3 law).
  const second = saveLanes(stateDir, { watch: "pi/zai/glm-5.3" });
  assert.ok(second.ok);
  assert.deepEqual(JSON.parse(readFileSync(lanesPath(stateDir), "utf8")), { worker: "claude/opus-4-8", watch: "pi/zai/glm-5.3" });
  const stillEye = resolveEyeLane(stateDir);
  assert.ok(stillEye.ok && stillEye.lane === "eye.json");
  const explicit = saveLanes(stateDir, { freshEyes: "pi/zai/glm-5.3" });
  assert.ok(explicit.ok);
  const explicitLane = resolveEyeLane(stateDir);
  assert.ok(explicitLane.ok && explicitLane.lane === "pi/zai/glm-5.3", "an explicit freshEyes always wins — that behavior stays");
});

test("saveLanes refuses an invalid lane and writes nothing", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");

  const saved = saveLanes(stateDir, { supervisor: "auto" });
  assert.ok(!saved.ok);
  assert.match(saved.reason, /supervisor/);
  assert.equal(existsSync(lanesPath(stateDir)), false, "a refused save leaves no file behind");
});

// ---- the per-Project override layer (v0.0.14, ADR 0010 §2/§5) -------------------------------

/** Writes a raw project-level lanes.json override. */
function writeRawProjectLanes(stateDir: string, projectSlug: string, body: string): void {
  const dir = join(stateDir, "projects", projectSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lanes.json"), body);
}

test("loadLanes(stateDir, slug) overlays the Project's lanes.json on the machine table — absent file keeps the machine lanes", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  writeRawLanes(stateDir, `${JSON.stringify({ worker: "claude/opus-4-8", supervisor: "pi/zai/glm-5.3" }, null, 2)}\n`);

  const noFile = loadLanes(stateDir, "acme-api-abc123");
  assert.ok(noFile.ok, "a project with no override file reads the machine table");
  const machineOnly = loadLanes(stateDir);
  assert.ok(machineOnly.ok);
  assert.deepEqual(noFile.lanes, machineOnly.lanes);

  writeRawProjectLanes(stateDir, "acme-api-abc123", `${JSON.stringify({ lead: "claude/opus-4-8" })}\n`);
  const merged = loadLanes(stateDir, "acme-api-abc123");
  assert.ok(merged.ok);
  assert.equal(merged.lanes.lead, "claude/opus-4-8", "the project override wins");
  assert.equal(merged.lanes.worker, "claude/opus-4-8", "unnamed lanes fall through to the machine file");
  assert.equal(merged.lanes.watch, DEFAULT_LANE, "lanes neither file names keep their defaults");

  const machine = loadLanes(stateDir);
  assert.ok(machine.ok && machine.lanes.lead === DEFAULT_LANE, "the machine table alone never sees the project override");
});

test("a broken Project lanes.json is a named error naming the project file, never a guessed default", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  writeRawProjectLanes(stateDir, "acme-api-abc123", "{ broken");

  const lanes = loadLanes(stateDir, "acme-api-abc123");
  assert.ok(!lanes.ok);
  assert.match(lanes.reason, /projects\/acme-api-abc123\/lanes\.json/);
  assert.match(lanes.reason, /valid JSON/);
});

test("saveLanes(stateDir, patch, slug) writes only the Project file — machine lanes and defaults never materialize into it", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  writeRawLanes(stateDir, `${JSON.stringify({ worker: "claude/opus-4-8" })}\n`);

  const saved = saveLanes(stateDir, { lead: "claude/opus-4-8" }, "acme-api-abc123");
  assert.ok(saved.ok);
  assert.equal(saved.lanes.lead, "claude/opus-4-8");
  assert.equal(saved.lanes.worker, "claude/opus-4-8", "the effective table still merges the machine file");
  assert.equal(saved.lanes.watch, DEFAULT_LANE);
  assert.deepEqual(
    JSON.parse(readFileSync(join(stateDir, "projects", "acme-api-abc123", "lanes.json"), "utf8")),
    { lead: "claude/opus-4-8" },
    "the project file persists exactly the lane it names — the eye.json retention invariant, per file",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(lanesPath(stateDir), "utf8")),
    { worker: "claude/opus-4-8" },
    "the machine file is untouched by a project save",
  );

  // A second project save keeps the first named project lane; a refused
  // value writes nothing anywhere.
  const second = saveLanes(stateDir, { supervisor: "pi/zai/glm-5.3" }, "acme-api-abc123");
  assert.ok(second.ok);
  assert.deepEqual(
    JSON.parse(readFileSync(join(stateDir, "projects", "acme-api-abc123", "lanes.json"), "utf8")),
    { lead: "claude/opus-4-8", supervisor: "pi/zai/glm-5.3" },
  );
  const refused = saveLanes(stateDir, { lead: "auto" }, "acme-api-abc123");
  assert.ok(!refused.ok);
  assert.match(refused.reason, /lead/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(stateDir, "projects", "acme-api-abc123", "lanes.json"), "utf8")),
    { lead: "claude/opus-4-8", supervisor: "pi/zai/glm-5.3" },
    "a refused project save leaves the project file untouched",
  );
});

// ---- the headless tool-less runner ------------------------------------------------------

test("each provider family maps to its exact tool-less argv — the invariant is the flags, not a promise", () => {
  assert.deepEqual(laneCliInvocation("pi/zai/glm-5.3"), {
    command: "pi",
    args: ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--model", "zai/glm-5.3"],
  });
  assert.deepEqual(laneCliInvocation("pi/zai/glm-5.3:max"), {
    command: "pi",
    args: ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--model", "zai/glm-5.3", "--thinking", "max"],
  });
  assert.deepEqual(laneCliInvocation("copilot/gpt-5.4"), {
    command: "copilot",
    args: ["-s", "--model", "gpt-5.4", "--reasoning-effort", "medium"],
  });
  assert.deepEqual(laneCliInvocation("copilot/gpt-5.4:high"), {
    command: "copilot",
    args: ["-s", "--model", "gpt-5.4", "--reasoning-effort", "high"],
  });
  assert.deepEqual(laneCliInvocation("claude/opus-4-8"), {
    command: "claude",
    args: ["-p", "--model", "opus-4-8", "--tools", ""],
  });
  assert.deepEqual(laneCliInvocation("claude/opus-4-8:high"), {
    command: "claude",
    args: ["-p", "--model", "opus-4-8", "--tools", "", "--effort", "high"],
  });
  assert.equal(laneCliInvocation("codex/gpt-6"), undefined, "no known tool-less form — refused, never improvised");
  assert.equal(laneCliInvocation("eye.json"), undefined);
});

/** A fake lane runner recording every invocation — the watch/retro test seam, generalized. */
function fakeLaneRunner(script: (call: { command: string; args: string[] }) => { code: number; stdout: string; stderr?: string; timedOut?: boolean }) {
  const calls: { command: string; args: string[]; cwd: string; stdin: string; timeoutMs: number; env?: Record<string, string> }[] = [];
  const runner: LaneCliRunner = async (call) => {
    calls.push(call);
    const answer = script(call);
    return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr ?? "", timedOut: answer.timedOut ?? false };
  };
  return { runner, calls };
}

/** Seeds a minimal fake operator Pi home — the headless runner seam's hermetic source (never the real `~/.pi/agent`). */
function seedFakePiAgent(piAgent: string): string {
  mkdirSync(join(piAgent, "extensions"), { recursive: true });
  writeFileSync(join(piAgent, "extensions", "cmux.ts"), "// tui extension\n");
  writeFileSync(join(piAgent, "APPEND_SYSTEM.md"), "# Auto-Delegation Rules\n");
  writeFileSync(join(piAgent, "auth.json"), '{"keys":{}}');
  mkdirSync(join(piAgent, "sessions"), { recursive: true });
  writeFileSync(
    join(piAgent, "settings.json"),
    JSON.stringify(
      { defaultProvider: "zai", defaultModel: "glm-5.3", defaultThinkingLevel: "medium", packages: ["npm:context-mode", "npm:pi-subagents"] },
      null,
      2,
    ),
  );
  return piAgent;
}

test("runLaneCli records the lane's command and argv, prompt on stdin", async () => {
  const fake = fakeLaneRunner(() => ({ code: 0, stdout: "answer" }));
  const result = await runLaneCli({ lane: "pi/zai/glm-5.3", stdin: "the prompt", timeoutMs: 5_000, runner: fake.runner });
  assert.ok(result.ok);
  assert.equal(result.stdout, "answer");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.command, "pi");
  assert.deepEqual(fake.calls[0]!.args, ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--model", "zai/glm-5.3"]);
  assert.equal(fake.calls[0]!.stdin, "the prompt");
  assert.ok(fake.calls[0]!.timeoutMs > 0);
  assert.ok(fake.calls[0]!.cwd.length > 0, "the scratch cwd is a real dir");
});

test("runLaneCli failures name the command: nonzero exit, deadline, unknown lane", async () => {
  const exited = await runLaneCli({
    lane: "copilot/gpt-5.4",
    stdin: "p",
    timeoutMs: 5_000,
    runner: fakeLaneRunner(() => ({ code: 3, stdout: "", stderr: "quota exhausted" })).runner,
  });
  assert.ok(!exited.ok && !exited.budgetExceeded);
  assert.match(exited.error, /copilot CLI exited 3/);
  assert.match(exited.error, /quota exhausted/);

  const timedOut = await runLaneCli({
    lane: "pi/zai/glm-5.3",
    stdin: "p",
    timeoutMs: 5_000,
    runner: fakeLaneRunner(() => ({ code: 0, stdout: "", timedOut: true })).runner,
  });
  assert.ok(!timedOut.ok && timedOut.budgetExceeded, "a blown deadline spends the budget — no second try");

  const unknown = await runLaneCli({ lane: "codex/gpt-6", stdin: "p", timeoutMs: 5_000 });
  assert.ok(!unknown.ok && !unknown.budgetExceeded);
  assert.match(unknown.error, /codex\/gpt-6/);
});

test("runLaneCli on a pi lane passes a clean headless PI_CODING_AGENT_DIR to the child (v0.0.16, ADR 0011)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const source = seedFakePiAgent(join(dir, "pi-home", ".pi", "agent"));
  const stateDir = join(dir, "factory");
  const fake = fakeLaneRunner(() => ({ code: 0, stdout: "answer" }));

  const result = await runLaneCli({ lane: "pi/zai/glm-5.3", stdin: "p", timeoutMs: 5_000, runner: fake.runner, stateDir, sourceAgentDir: source });
  assert.ok(result.ok);
  const headless = join(stateDir, "pi-agent", "headless");
  assert.equal(fake.calls[0]!.env?.PI_CODING_AGENT_DIR, headless, "the child env carries the headless Pi harness home");
  const settings = JSON.parse(readFileSync(join(headless, "settings.json"), "utf8"));
  assert.deepEqual(settings.skills, ["!*"], "a headless pass denies every skill on top of --no-skills");
  assert.deepEqual(settings.extensions, ["-builtin:llama.cpp", "-builtin:mcp", "-builtin:codemode", "-builtin:tool-search"]);
  assert.deepEqual(settings.packages, [], "the operator's 20+ user packages never load");
  assert.ok(!existsSync(join(headless, "APPEND_SYSTEM.md")), "the operator's APPEND_SYSTEM.md never reaches a headless pass");
  assert.equal(realpathSync(join(headless, "auth.json")), realpathSync(join(source, "auth.json")), "shared auth still symlinks back to the source home");

  // Idempotent reuse: a second pass finds the same home in the same state.
  const again = await runLaneCli({ lane: "pi/zai/glm-5.3", stdin: "p", timeoutMs: 5_000, runner: fake.runner, stateDir, sourceAgentDir: source });
  assert.ok(again.ok);
  assert.equal(fake.calls[1]!.env?.PI_CODING_AGENT_DIR, headless);
  assert.equal(realpathSync(join(headless, "auth.json")), realpathSync(join(source, "auth.json")), "re-provision never breaks a symlink it already made");

  // The userHome override resolves the same fake source through <userHome>/.pi/agent.
  const viaUserHome = await runLaneCli({
    lane: "pi/zai/glm-5.3",
    stdin: "p",
    timeoutMs: 5_000,
    runner: fake.runner,
    stateDir: join(dir, "factory-2"),
    userHome: join(dir, "pi-home"),
  });
  assert.ok(viaUserHome.ok);
  assert.equal(fake.calls[2]!.env?.PI_CODING_AGENT_DIR, join(dir, "factory-2", "pi-agent", "headless"));
  assert.equal(realpathSync(join(dir, "factory-2", "pi-agent", "headless", "auth.json")), realpathSync(join(source, "auth.json")));

  // A non-pi lane never carries PI_CODING_AGENT_DIR — only pi is isolated (spec Out of Scope).
  const other = fakeLaneRunner(() => ({ code: 0, stdout: "a" }));
  const copilot = await runLaneCli({ lane: "copilot/gpt-5.4", stdin: "p", timeoutMs: 5_000, runner: other.runner, stateDir, sourceAgentDir: source });
  assert.ok(copilot.ok);
  assert.equal(other.calls[0]!.env?.PI_CODING_AGENT_DIR, undefined, "copilot lanes inherit the environment unchanged");
});

// ---- the CLI-side mirror (ADR 0004: CLIs import no src/ code) ----------------------------

test("the plugin/bin mirror matches src/lanes.ts: names, default, validation, load tolerance, save persistence", async (t) => {
  assert.deepEqual(LANE_NAMES_MJS, LANE_NAMES);
  assert.equal(DEFAULT_LANE_MJS, DEFAULT_LANE);

  const matrix = [
    "pi/zai/glm-5.3",
    "pi/zai/glm-5.3:max",
    "copilot/gpt-5.4",
    "copilot/gpt-5.4:high",
    "claude/opus-4-8",
    "eye.json",
    "copilot",
    "copilot/",
    "pi/zai/glm-5.3:",
    "/model",
    "pi / glm",
    "",
    "auto",
  ];
  for (const lane of LANE_NAMES) {
    for (const value of matrix) {
      assert.equal(
        laneErrorMjs(lane, value),
        laneError(lane, value),
        `mirror drift at ${lane} = ${JSON.stringify(value)}`,
      );
      assert.deepEqual(
        parseLaneMjs(value),
        parseLane(value),
        `parseLane mirror drift at ${JSON.stringify(value)}`,
      );
    }
  }

  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  writeRawLanes(stateDir, `${JSON.stringify({ worker: "claude/opus-4-8" }, null, 2)}\n`);
  const fromSrc = loadLanes(stateDir);
  const fromMjs = await loadLanesMjs(stateDir);
  assert.ok(fromSrc.ok && fromMjs.ok);
  assert.deepEqual(fromMjs.lanes, fromSrc.lanes, "both loaders read the same file the same way");

  writeRawLanes(stateDir, "{ broken");
  assert.ok(!(await loadLanesMjs(stateDir)).ok, "the mirror refuses unparseable JSON too");

  // The persistence law mirrors too: a save over a partial file keeps the
  // file partial — only the lanes ever named land on disk.
  const { saveLanes: saveLanesMjs } = await import("../plugin/bin/lanes-config.mjs");
  const dirSrc = join(dir, "src-half");
  const dirMjs = join(dir, "mjs-half");
  writeRawLanes(dirSrc, `${JSON.stringify({ worker: "claude/opus-4-8" })}\n`);
  writeRawLanes(dirMjs, `${JSON.stringify({ worker: "claude/opus-4-8" })}\n`);
  const savedSrc = saveLanes(dirSrc, { watch: "copilot/gpt-5.4" });
  const savedMjs = await saveLanesMjs(dirMjs, { watch: "copilot/gpt-5.4" });
  assert.ok(savedSrc.ok && savedMjs.ok);
  assert.deepEqual(savedMjs.lanes, savedSrc.lanes, "both savers return the same effective table");
  assert.deepEqual(
    JSON.parse(readFileSync(lanesPath(dirMjs), "utf8")),
    JSON.parse(readFileSync(lanesPath(dirSrc), "utf8")),
    "both savers persist exactly the named lanes",
  );
  assert.deepEqual(JSON.parse(readFileSync(lanesPath(dirMjs), "utf8")), { worker: "claude/opus-4-8", watch: "copilot/gpt-5.4" });

  // The project-override layer mirrors too: same merge over the same two
  // files, same persistence law, same refused-value behavior.
  const projSrc = join(dir, "proj-src");
  const projMjs = join(dir, "proj-mjs");
  for (const base of [projSrc, projMjs]) {
    writeRawLanes(base, `${JSON.stringify({ worker: "claude/opus-4-8" })}\n`);
    writeRawProjectLanes(base, "acme-api-abc123", `${JSON.stringify({ lead: "claude/opus-4-8" })}\n`);
  }
  const projFromSrc = loadLanes(projSrc, "acme-api-abc123");
  const projFromMjs = await loadLanesMjs(projMjs, "acme-api-abc123");
  assert.ok(projFromSrc.ok && projFromMjs.ok);
  assert.deepEqual(projFromMjs.lanes, projFromSrc.lanes, "both loaders merge the project file the same way");
  const projSavedSrc = saveLanes(projSrc, { supervisor: "pi/zai/glm-5.3" }, "acme-api-abc123");
  const projSavedMjs = await saveLanesMjs(projMjs, { supervisor: "pi/zai/glm-5.3" }, "acme-api-abc123");
  assert.ok(projSavedSrc.ok && projSavedMjs.ok);
  assert.deepEqual(
    JSON.parse(readFileSync(join(projMjs, "projects", "acme-api-abc123", "lanes.json"), "utf8")),
    JSON.parse(readFileSync(join(projSrc, "projects", "acme-api-abc123", "lanes.json"), "utf8")),
    "both project savers persist exactly the named lanes",
  );
});

// ---- the Owner CLI (factory lanes / run fallback) ----------------------------------------

test("factory lanes: get prints the defaults, set writes one lane, invalid set exits 2", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const getDefaults = await runCli(["lanes", "get"], { PASEO_HOME: home });
  assert.equal(getDefaults.status, 0, getDefaults.stderr);
  for (const name of LANE_NAMES) {
    assert.match(getDefaults.stdout, new RegExp(`${name}[= ]pi/zai/glm-5.3`), `get shows ${name} at the default`);
  }

  const set = await runCli(["lanes", "set", "watch", "copilot/gpt-5.4"], { PASEO_HOME: home });
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(JSON.parse(readFileSync(lanesPath(stateDir), "utf8")), { watch: "copilot/gpt-5.4" }, "set persists exactly the lane it names — never the file whole");
  const reread = loadLanes(stateDir);
  assert.ok(reread.ok);
  assert.equal(reread.lanes.watch, "copilot/gpt-5.4");
  assert.equal(reread.lanes.worker, DEFAULT_LANE, "an unnamed lane reads back at its default");

  const bad = await runCli(["lanes", "set", "watch", "auto"], { PASEO_HOME: home });
  assert.equal(bad.status, 2, "an invalid lane is a usage failure");
  assert.match(bad.stderr, /watch/);
  const afterBad = loadLanes(stateDir);
  assert.ok(afterBad.ok && afterBad.lanes.watch === "copilot/gpt-5.4", "a refused set leaves the file untouched");

  const unknownLane = await runCli(["lanes", "set", "captain", "pi/zai/glm-5.3"], { PASEO_HOME: home });
  assert.equal(unknownLane.status, 2);
});

test("factory lanes --project: get reads and set writes the Project's override file; lead is a settable lane everywhere", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const repo = join(dir, "acme-api");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "a.txt"), "a\n");
  gitCommitAll(repo);
  const { resolveProject } = await import("../src/project.ts");
  const project = resolveProject(repo);
  assert.ok(project.ok, project.ok ? "" : project.reason);
  const projectLanes = join(stateDir, "projects", project.slug, "lanes.json");

  // Machine lane first: `lead` is a first-class lane on the machine table too.
  const setMachineLead = await runCli(["lanes", "set", "lead", "claude/opus-4-8"], { PASEO_HOME: home });
  assert.equal(setMachineLead.status, 0, setMachineLead.stderr);
  assert.deepEqual(JSON.parse(readFileSync(lanesPath(stateDir), "utf8")), { lead: "claude/opus-4-8" });

  // A project-scoped set lands in the project's override file only.
  const setProject = await runCli(["lanes", "set", "lead", "pi/zai/glm-5.3", "--project", repo], { PASEO_HOME: home });
  assert.equal(setProject.status, 0, setProject.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(projectLanes, "utf8")),
    { lead: "pi/zai/glm-5.3" },
    "the project file persists exactly the lane it names",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(lanesPath(stateDir), "utf8")),
    { lead: "claude/opus-4-8" },
    "the machine file is untouched by a project save",
  );

  // get --project shows the merged table (project override wins).
  const getProject = await runCli(["lanes", "get", "lead", "--project", repo], { PASEO_HOME: home });
  assert.equal(getProject.status, 0, getProject.stderr);
  assert.match(getProject.stdout, /lead=pi\/zai\/glm-5\.3/);
  const getMachine = await runCli(["lanes", "get", "lead"], { PASEO_HOME: home });
  assert.equal(getMachine.status, 0, getMachine.stderr);
  assert.match(getMachine.stdout, /lead=claude\/opus-4-8/);

  // --project on a directory git cannot answer for is a usage failure.
  const plain = join(dir, "plain");
  mkdirSync(plain, { recursive: true });
  const noRepo = await runCli(["lanes", "get", "--project", plain], { PASEO_HOME: home });
  assert.equal(noRepo.status, 2);
  assert.match(noRepo.stderr, /plain/);

  // An invalid lane value under --project refuses and writes nothing.
  const bad = await runCli(["lanes", "set", "lead", "auto", "--project", repo], { PASEO_HOME: home });
  assert.equal(bad.status, 2);
  assert.deepEqual(JSON.parse(readFileSync(projectLanes, "utf8")), { lead: "pi/zai/glm-5.3" });
});

test("run's provider precedence: explicit --provider overrides lanes.worker; omitted falls back to it; a broken lanes.json names itself", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");

  // No lanes.json, no flag: the default worker lane stands in.
  assert.deepEqual(resolveRunProviderMjs(stateDir, undefined), { ok: true, provider: DEFAULT_LANE });

  // lanes.worker is read when the flag is omitted.
  writeRawLanes(stateDir, `${JSON.stringify({ worker: "claude/opus-4-8" })}\n`);
  assert.deepEqual(resolveRunProviderMjs(stateDir, undefined), { ok: true, provider: "claude/opus-4-8" });

  // An explicit --provider always wins (ADR 0009 §3 precedence).
  assert.deepEqual(resolveRunProviderMjs(stateDir, "copilot/gpt-5.4"), { ok: true, provider: "copilot/gpt-5.4" });

  // A broken lanes.json is a named refusal — never a silent default.
  writeRawLanes(stateDir, "{ broken");
  const broken = resolveRunProviderMjs(stateDir, undefined);
  assert.ok(!broken.ok);
  assert.match(broken.reason, /lanes\.json/);
});

/** Runs the Owner CLI as a child process — the test/cli.test.ts pattern. */
function runCli(args: string[], extraEnv: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ownerCli, ...args], { env: { ...process.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}
