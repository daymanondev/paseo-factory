import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LANE,
  LANE_NAMES,
  laneCliInvocation,
  laneError,
  lanesPath,
  loadLanes,
  runLaneCli,
  saveLanes,
} from "../src/lanes.ts";
import type { LaneCliRunner } from "../src/lanes.ts";
import {
  DEFAULT_LANE as DEFAULT_LANE_MJS,
  LANE_NAMES as LANE_NAMES_MJS,
  laneError as laneErrorMjs,
  loadLanes as loadLanesMjs,
  resolveRunProvider as resolveRunProviderMjs,
} from "../plugin/bin/lanes-config.mjs";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

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

test("absent lanes.json loads the five defaults", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");

  const lanes = loadLanes(stateDir);
  assert.ok(lanes.ok, "an absent file is the safe default, never an error");
  assert.deepEqual(lanes.lanes, {
    supervisor: DEFAULT_LANE,
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

test("lane strings validate: provider/model with both halves non-empty; eye.json only for freshEyes", () => {
  assert.equal(laneError("worker", "pi/zai/glm-5.3"), undefined, "provider/model is the shape");
  assert.equal(laneError("worker", "claude/claude-sonnet-4-6"), undefined);
  assert.equal(laneError("freshEyes", "eye.json"), undefined, "the eye's legacy direct-API lane");
  assert.notEqual(laneError("worker", "eye.json"), undefined, "eye.json is the fresh-eyes lane alone");
  assert.notEqual(laneError("watch", "copilot"), undefined, "a bare provider never picks a model by itself — never auto");
  assert.notEqual(laneError("watch", "copilot/"), undefined);
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

test("saveLanes validates every lane, writes the five whole, and reloads", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");

  const saved = saveLanes(stateDir, { watch: "copilot/gpt-5.4", freshEyes: "eye.json" });
  assert.ok(saved.ok);
  assert.equal(saved.lanes.watch, "copilot/gpt-5.4");
  assert.equal(saved.lanes.freshEyes, "eye.json");
  assert.equal(saved.lanes.worker, DEFAULT_LANE, "an unspecified lane keeps its default");
  const onDisk = JSON.parse(readFileSync(lanesPath(stateDir), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(onDisk).sort(), [...LANE_NAMES].sort(), "the file is machine-shaped: exactly the five lanes");
  const reread = loadLanes(stateDir);
  assert.ok(reread.ok);
  assert.deepEqual(reread.lanes, saved.lanes);
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

// ---- the headless tool-less runner ------------------------------------------------------

test("each provider family maps to its exact tool-less argv — the invariant is the flags, not a promise", () => {
  assert.deepEqual(laneCliInvocation("pi/zai/glm-5.3"), {
    command: "pi",
    args: ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--model", "zai/glm-5.3"],
  });
  assert.deepEqual(laneCliInvocation("copilot/gpt-5.4"), {
    command: "copilot",
    args: ["-s", "--model", "gpt-5.4", "--reasoning-effort", "medium"],
  });
  assert.deepEqual(laneCliInvocation("claude/opus-4-8"), {
    command: "claude",
    args: ["-p", "--model", "opus-4-8", "--tools", ""],
  });
  assert.equal(laneCliInvocation("codex/gpt-6"), undefined, "no known tool-less form — refused, never improvised");
  assert.equal(laneCliInvocation("eye.json"), undefined);
});

/** A fake lane runner recording every invocation — the watch/retro test seam, generalized. */
function fakeLaneRunner(script: (call: { command: string; args: string[] }) => { code: number; stdout: string; stderr?: string; timedOut?: boolean }) {
  const calls: { command: string; args: string[]; cwd: string; stdin: string; timeoutMs: number }[] = [];
  const runner: LaneCliRunner = async (call) => {
    calls.push(call);
    const answer = script(call);
    return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr ?? "", timedOut: answer.timedOut ?? false };
  };
  return { runner, calls };
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

// ---- the CLI-side mirror (ADR 0004: CLIs import no src/ code) ----------------------------

test("the plugin/bin mirror matches src/lanes.ts: names, default, validation, load tolerance", async (t) => {
  assert.deepEqual(LANE_NAMES_MJS, LANE_NAMES);
  assert.equal(DEFAULT_LANE_MJS, DEFAULT_LANE);

  const matrix = [
    "pi/zai/glm-5.3",
    "copilot/gpt-5.4",
    "claude/opus-4-8",
    "eye.json",
    "copilot",
    "copilot/",
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
  const reread = loadLanes(stateDir);
  assert.ok(reread.ok);
  assert.equal(reread.lanes.watch, "copilot/gpt-5.4");
  assert.equal(reread.lanes.worker, DEFAULT_LANE, "set touches one lane, never the file whole");

  const bad = await runCli(["lanes", "set", "watch", "auto"], { PASEO_HOME: home });
  assert.equal(bad.status, 2, "an invalid lane is a usage failure");
  assert.match(bad.stderr, /watch/);
  const afterBad = loadLanes(stateDir);
  assert.ok(afterBad.ok && afterBad.lanes.watch === "copilot/gpt-5.4", "a refused set leaves the file untouched");

  const unknownLane = await runCli(["lanes", "set", "captain", "pi/zai/glm-5.3"], { PASEO_HOME: home });
  assert.equal(unknownLane.status, 2);
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
