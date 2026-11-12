import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LANE,
  LANE_NAMES,
  applyLaneProfile,
  defaultLanes,
  deleteLaneProfile,
  getLaneProfile,
  laneCliInvocation,
  laneError,
  laneProfilesPath,
  lanesPath,
  listLaneProfiles,
  loadLanes,
  mergeLaneProfilesFiles,
  migrateLegacyZcodeLane,
  parseLane,
  resetProjectLanes,
  resolvePeerThinkingLane,
  runLaneCli,
  saveLaneProfile,
  saveLanes,
  saveLanesBatch,
} from "../src/lanes.ts";
import type { LaneCliRunner, LaneProfile, LaneProfilesFile, LaneThinkingCatalogEntry } from "../src/lanes.ts";
import { resolveEyeLane } from "../src/fresh-eyes.ts";
import {
  DEFAULT_LANE as DEFAULT_LANE_MJS,
  LANE_NAMES as LANE_NAMES_MJS,
  laneError as laneErrorMjs,
  loadLanes as loadLanesMjs,
  parseLane as parseLaneMjs,
  resolveRunProvider as resolveRunProviderMjs,
} from "../plugin/bin/lanes-config.mjs";
import { copilotAnswerLines, disposeDir, factoryErrorCode, gitCommitAll, gitCommitChanges, makeTempDir, repoRoot, writeLanes } from "./helpers.ts";
import * as core from "../src/index.ts";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { resolveProject } from "../plugin/server/core/project.ts";

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
  writeRawLanes(stateDir, `${JSON.stringify({ watch: "pi" })}\n`);

  const lanes = loadLanes(stateDir);
  assert.ok(!lanes.ok);
  assert.match(lanes.reason, /watch/);
});

test("v0.6.0 W4 (ADR 0056): a stale `retro` lane left in an older lanes.json is ignored on read and dropped on the next save", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  writeRawLanes(stateDir, `${JSON.stringify({ worker: "copilot/gpt-5.4", retro: "copilot/gpt-5.4" })}\n`);

  const lanes = loadLanes(stateDir);
  assert.ok(lanes.ok, lanes.ok ? "" : lanes.reason);
  assert.equal(lanes.lanes.worker, "copilot/gpt-5.4");
  assert.equal("retro" in lanes.lanes, false, "the retro lane is no longer part of the table");

  writeRawLanes(stateDir, `${JSON.stringify({ retro: "not-a-lane" })}\n`);
  assert.ok(loadLanes(stateDir).ok, "even an unusable retro value is just an unknown key now");

  const saved = saveLanes(stateDir, { watch: "copilot/gpt-5.4" });
  assert.ok(saved.ok, saved.ok ? "" : saved.reason);
  assert.deepEqual(JSON.parse(readFileSync(lanesPath(stateDir), "utf8")), { watch: "copilot/gpt-5.4" }, "the next save writes only the lanes the table knows");
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
  const second = saveLanes(stateDir, { watch: "pi/zcode/glm-5.3" });
  assert.ok(second.ok);
  assert.deepEqual(JSON.parse(readFileSync(lanesPath(stateDir), "utf8")), { worker: "claude/opus-4-8", watch: "pi/zcode/glm-5.3" });
  const stillEye = resolveEyeLane(stateDir);
  assert.ok(stillEye.ok && stillEye.lane === "eye.json");
  const explicit = saveLanes(stateDir, { freshEyes: "pi/zcode/glm-5.3" });
  assert.ok(explicit.ok);
  const explicitLane = resolveEyeLane(stateDir);
  assert.ok(explicitLane.ok && explicitLane.lane === "pi/zcode/glm-5.3", "an explicit freshEyes always wins — that behavior stays");
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
  const second = saveLanes(stateDir, { supervisor: "pi/zcode/glm-5.3" }, "acme-api-abc123");
  assert.ok(second.ok);
  assert.deepEqual(
    JSON.parse(readFileSync(join(stateDir, "projects", "acme-api-abc123", "lanes.json"), "utf8")),
    { lead: "claude/opus-4-8", supervisor: "pi/zcode/glm-5.3" },
  );
  const refused = saveLanes(stateDir, { lead: "auto" }, "acme-api-abc123");
  assert.ok(!refused.ok);
  assert.match(refused.reason, /lead/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(stateDir, "projects", "acme-api-abc123", "lanes.json"), "utf8")),
    { lead: "claude/opus-4-8", supervisor: "pi/zcode/glm-5.3" },
    "a refused project save leaves the project file untouched",
  );
});

// ---- the Project-scoped save's daemon-global reconcile (v0.6.1, ADR 0057 §11) ---------------

/**
 * The fake daemon slice the lane-save handlers read — no live agents, an empty
 * provider catalog (the role-providers suite's `emptyDaemon` precedent).
 */
function emptyLaneDaemon(): SurfaceDaemonApi {
  return {
    agents: {
      list: async () => ({ entries: [] }),
      create: async () => ({ id: "agent-x" }),
      ref: () => ({ send: async () => {}, archive: async () => ({ archivedAt: new Date().toISOString() }), timeline: { refetch: async () => ({ entries: [] }) } }),
    },
    providers: {
      listAvailable: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
    },
  };
}

test("v0.6.1 (ADR 0057 §11): a Project-scoped lane save, batch, profile apply, or reset reconciles <paseoHome>/config.json from the MACHINE-scope lanes only — a Project override never rewrites the machine-wide factory-* entries", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const projectRoot = join(dir, "project-a");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "README.md"), "# a\n");
  gitCommitAll(projectRoot, "seed a");
  const resolved = resolveProject(projectRoot);
  assert.ok(resolved.ok);
  const slug = resolved.ok ? resolved.slug : "";
  const factory = createFactory({ stateDir });
  const handlers = createSurfaceHandlers({ factory, stateDir, home, daemon: emptyLaneDaemon(), onLog: () => {} });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), `${JSON.stringify({ agents: { providers: {} }, daemon: { agentProfiles: [] } }, null, 2)}\n`);

  // The machine table is the baseline the daemon-global providers must keep.
  writeLanes(stateDir, { supervisor: "codex/gpt-5.5", worker: "pi/zcode/glm-5.3" });

  const providerModel = (homePath: string): string | undefined => {
    const parsed = JSON.parse(readFileSync(join(homePath, "config.json"), "utf8")) as {
      agents?: { providers?: Record<string, { models?: { id: string }[] }> };
      daemon?: { agentProfiles?: { id: string; model?: string }[] };
    };
    return parsed.agents?.providers?.["factory-supervisor"]?.models?.[0]?.id;
  };
  const pickerModel = (homePath: string): string | undefined => {
    const parsed = JSON.parse(readFileSync(join(homePath, "config.json"), "utf8")) as {
      daemon?: { agentProfiles?: { id: string; model?: string }[] };
    };
    return parsed.daemon?.agentProfiles?.find((row) => row.id === "factory-supervisor")?.model;
  };

  // A single Project-scoped save: the override file changes, config.json does not.
  const saved = await handlers.lanesSet({ lane: "supervisor", value: "claude/claude-opus-4-6:high", projectRoot });
  assert.ok(saved.ok, saved.ok ? "" : saved.error);
  assert.equal(saved.lanes.supervisor, "claude/claude-opus-4-6:high", "the Project's effective table carries the override");
  assert.equal(providerModel(home), "gpt-5.5", "factory-supervisor still maps the MACHINE supervisor lane after a Project save");
  assert.equal(pickerModel(home), "gpt-5.5", "the Supervisor (Factory) picker row keeps the machine model");
  const projectLanes = loadLanes(stateDir, slug);
  assert.ok(projectLanes.ok, projectLanes.ok ? "" : projectLanes.reason);
  assert.equal(
    projectLanes.lanes.supervisor,
    "claude/claude-opus-4-6:high",
    "the Project's own override landed — the before-create rewrite applies it at launch",
  );

  // The batch save obeys the same law.
  const batch = await handlers.lanesSetBatch({ lanes: { supervisor: "opencode/glm-5.1", worker: "claude-code/claude-opus-5" }, projectRoot });
  assert.ok(batch.ok, batch.ok ? "" : batch.error);
  assert.equal(providerModel(home), "gpt-5.5", "a Project batch save never rewrites the machine-wide factory-* entries");

  // A Lane profile applied to the Project obeys it too.
  const profile = await handlers.profilesSave({ name: "A Setup", projectRoot });
  assert.ok(profile.ok, profile.ok ? "" : profile.error);
  const applied = await handlers.profilesApply({ profileId: profile.profile.id, projectRoot });
  assert.ok(applied.ok, applied.ok ? "" : applied.error);
  assert.equal(applied.lanes.supervisor, "opencode/glm-5.1", "the apply wrote the Project's override (the batch table it saved)");
  assert.equal(providerModel(home), "gpt-5.5", "a profile apply on a Project reconciles from the machine table");

  // The Project reset inherits the machine table again — still the machine mapping.
  const reset = await handlers.lanesReset({ projectRoot });
  assert.ok(reset.ok, reset.ok ? "" : reset.error);
  assert.equal(providerModel(home), "gpt-5.5");

  // An UNSCOPED machine save still rewrites the globals — the one act that may.
  const machineSave = await handlers.lanesSet({ lane: "supervisor", value: "omp/qwen3-coder" });
  assert.ok(machineSave.ok, machineSave.ok ? "" : machineSave.error);
  assert.equal(providerModel(home), "qwen3-coder", "an unscoped save reconciles the globals from the machine table it just wrote");
});

// ---- the headless tool-less runner ------------------------------------------------------

test("each provider family maps to its exact tool-less argv — the invariant is the flags, not a promise", () => {
  assert.deepEqual(laneCliInvocation("pi/zai/glm-5.3"), {
    command: "pi",
    args: ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--model", "zai/glm-5.3", "--thinking", "off"],
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
  assert.deepEqual(fake.calls[0]!.args, ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--model", "zai/glm-5.3", "--thinking", "off"]);
  assert.equal(fake.calls[0]!.stdin, "the prompt");
  assert.ok(fake.calls[0]!.timeoutMs > 0);
  assert.ok(fake.calls[0]!.cwd.length > 0, "the scratch cwd is a real dir");
});

test("OpenCode permission configuration stays isolated from other lane providers", async () => {
  for (const lane of ["pi/zai/glm-5.3", "claude/opus-4-8", "copilot/gpt-5.4"]) {
    const fake = fakeLaneRunner(() => ({ code: 0, stdout: "answer" }));
    const result = await core.runLaneCli({ lane, stdin: "p", timeoutMs: 5_000, runner: fake.runner });
    assert.ok(result.ok, lane);
    assert.equal(fake.calls[0]!.env, undefined, `${lane} inherits its environment unchanged`);
  }
  for (const lane of ["codex/gpt-6", "omp/model", "antigravity/model"]) {
    const fake = fakeLaneRunner(() => ({ code: 0, stdout: "answer" }));
    assert.equal(core.laneCliInvocation(lane), undefined, `${lane} still has no tool-less CLI form`);
    const result = await core.runLaneCli({ lane, stdin: "p", timeoutMs: 5_000, runner: fake.runner });
    assert.ok(!result.ok, lane);
    assert.equal(fake.calls.length, 0, `${lane} never launches a child`);
  }
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

// ---- the opencode family (v0.0.18) — barrel-only imports ----------------------------------
//
// The fourth headless tool-less CLI family exercises the top-level core
// barrel alone (spec Testing Decisions): everything this section touches —
// laneCliInvocation, runLaneCli, TOOLLESS_OPENCODE_CONFIG, the three passes —
// is imported through `core`, never from ../src/lanes.ts directly.

test("opencode/<model> stays headless without auto-approving read permission", () => {
  assert.deepEqual(core.laneCliInvocation("opencode/deepseek-v4.1-flash-free"), {
    command: "opencode",
    args: ["run", "--standalone", "-m", "opencode/deepseek-v4.1-flash-free"],
  });
  assert.deepEqual(
    core.laneCliInvocation("opencode/glm-5.3-flash-free:high"),
    { command: "opencode", args: ["run", "--standalone", "-m", "opencode/glm-5.3-flash-free", "--variant", "high"] },
    "the :thinking suffix rides --variant — the last-colon split the other three families use",
  );
  assert.equal(core.laneCliInvocation("opencode/"), undefined, "a malformed lane never reaches the switch");
});

test("runLaneCli keeps the OpenCode read schema for Zen while headless mode rejects reads", async () => {
  assert.equal(typeof core.TOOLLESS_OPENCODE_CONFIG, "string", "the barrel exports the tool-less opencode config");
  const fake = fakeLaneRunner(() => ({ code: 0, stdout: "answer" }));

  const result = await core.runLaneCli({ lane: "opencode/deepseek-v4.1-flash-free", stdin: "the prompt", timeoutMs: 5_000, runner: fake.runner });
  assert.ok(result.ok);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.command, "opencode");
  assert.deepEqual(fake.calls[0]!.args, ["run", "--standalone", "-m", "opencode/deepseek-v4.1-flash-free"]);
  assert.equal(fake.calls[0]!.stdin, "the prompt", "the prompt stays on stdin — the shared discipline since amendment 2");
  assert.equal(fake.calls[0]!.env?.OPENCODE_CONFIG_CONTENT, core.TOOLLESS_OPENCODE_CONFIG, "the tool-less permission set reaches the child verbatim");
  assert.equal(fake.calls[0]!.env?.CI, "1", "CI=1 — no interactive prompt can hang the pass");
  assert.equal(fake.calls[0]!.env?.PI_CODING_AGENT_DIR, undefined, "only pi lanes carry the Pi home — opencode needs no stateDir");

  // Zen requires the read tool schema; asking in non-interactive standalone
  // mode rejects reads while retaining the schema. All other tools stay denied.
  const parsed = JSON.parse(core.TOOLLESS_OPENCODE_CONFIG) as { permission: Record<string, unknown> };
  assert.deepEqual(parsed.permission, {
    "*": "deny",
    external_directory: "deny",
    doom_loop: "deny",
    question: "deny",
    edit: "deny",
    write: "deny",
    bash: "deny",
    read: { "*": "ask" },
  });

  // The no-headless-form refusal names the fourth family among the usable forms.
  const unknown = await core.runLaneCli({ lane: "codex/gpt-6", stdin: "p", timeoutMs: 5_000 });
  assert.ok(!unknown.ok && !unknown.budgetExceeded);
  assert.match(unknown.error, /opencode\/<model>/);
});

test("runLaneCli strips ANSI escape sequences from an opencode lane's stdout — and only that path", async () => {
  const noisy = "\u001b[1;32mCLEAR\u001b[0m\n\u001b[2KAll good.";
  const opencode = fakeLaneRunner(() => ({ code: 0, stdout: noisy }));
  const stripped = await core.runLaneCli({ lane: "opencode/glm-5.3-flash-free", stdin: "p", timeoutMs: 5_000, runner: opencode.runner });
  assert.ok(stripped.ok);
  assert.equal(stripped.stdout, "CLEAR\nAll good.", "the opencode CLI's pretty-printing never reaches a downstream parser");

  // The other families keep their stdout byte-identical — the strip is the opencode path's alone.
  const copilot = fakeLaneRunner(() => ({ code: 0, stdout: noisy }));
  const untouched = await core.runLaneCli({ lane: "copilot/gpt-5.4", stdin: "p", timeoutMs: 5_000, runner: copilot.runner });
  assert.ok(untouched.ok);
  assert.equal(untouched.stdout, noisy);
});

test("an opencode lane completes the Watch, the Retro, and the Fresh-eyes CLI pass through the injected runner", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  const lane = "opencode/deepseek-v4.1-flash-free";
  const expectedArgs = ["run", "--standalone", "-m", "opencode/deepseek-v4.1-flash-free"];

  // A real git workspace at base, then the Agent's committed work — the diff every pass reads.
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  const artifact = "src/format.ts";
  writeFileSync(join(workspace, artifact), "export function pad() {}\n");
  const base = gitCommitAll(workspace);
  writeFileSync(join(workspace, artifact), "export function pad(input: string): string {\n  return input;\n}\n");
  const claimed = gitCommitChanges(workspace, "implement pad");
  const contract: core.ContractSet = {
    seq: 1,
    ts: "2026-10-18T09:00:00.000Z",
    event: "contract_set",
    task: "W23",
    workspace,
    gate: "npm test",
    artifact,
    scope: ["src"],
    base,
    watch: true,
  };

  // The Watch: five `name: number` lines, the strict output contract.
  writeLanes(stateDir, { watch: lane });
  const watchAnswers = {
    "destructive-writes": 0.02,
    "test-weakened": 0.03,
    "stuck-loop": 0.1,
    "scope-creep": 0.2,
    "secret-leak": 0.01,
  };
  const watchFake = fakeLaneRunner(() => ({ code: 0, stdout: copilotAnswerLines(watchAnswers) }));
  const watch = await core.runWatchPass({
    stateDir,
    contract,
    task: "W23",
    attempt: 1,
    sha: claimed,
    gateResult: { exit: 0, verdict: "green", note: "", timedOut: false, output: "ok 3 tests", artifactPresent: true },
    gateOutputPath: undefined,
    scopeViolations: [],
    agent: "agent-w23",
    fetchTimeline: async () => ({
      ok: true,
      entries: [
        { seq: 2, item: { type: "user_message", text: "Do the assigned work." } },
        { seq: 5, item: { type: "assistant_message", text: "Done — tests pass." } },
      ],
    }),
    gitBlocks: [],
    copilotRunner: watchFake.runner,
    budgetMs: 5_000,
  });
  assert.equal(watch.outcome, "written", watch.outcome === "written" ? "" : watch.error ?? "watch failed");
  assert.equal(watch.model, lane, "the lane string is recorded verbatim");
  assert.equal(watchFake.calls.length, 1);
  assert.equal(watchFake.calls[0]!.command, "opencode");
  assert.deepEqual(watchFake.calls[0]!.args, expectedArgs);
  assert.equal(watchFake.calls[0]!.env?.OPENCODE_CONFIG_CONTENT, core.TOOLLESS_OPENCODE_CONFIG, "the pass inherits the tool-less config");
  assert.equal(watchFake.calls[0]!.env?.CI, "1");
  assert.ok(watchFake.calls[0]!.stdin.includes("STATE"), "the prompt rides stdin with the state as its tail");

  // The Fresh-eyes CLI path: first line CONCERN or CLEAR.
  writeLanes(stateDir, { freshEyes: lane });
  const eyeFake = fakeLaneRunner(() => ({ code: 0, stdout: "CLEAR\nNothing to add." }));
  const eye = await core.runFreshEyesPass({ stateDir, contract, claimedSha: claimed, gateOutputPath: undefined, cliRunner: eyeFake.runner, budgetMs: 5_000 });
  assert.equal(eye.outcome, "clear", eye.outcome === "clear" ? "" : eye.finding);
  assert.equal(eye.model, lane);
  assert.equal(eyeFake.calls.length, 1);
  assert.equal(eyeFake.calls[0]!.command, "opencode");
  assert.deepEqual(eyeFake.calls[0]!.args, expectedArgs);
  assert.equal(eyeFake.calls[0]!.env?.OPENCODE_CONFIG_CONTENT, core.TOOLLESS_OPENCODE_CONFIG);
  assert.equal(eyeFake.calls[0]!.env?.CI, "1");
});

// ---- ADR 0055: retire zcode-acp for pi/zcode/* via zcode-api ------------------------------

test("migrateLegacyZcodeLane rewrites retired zcode/* and legacy pi/zai/glm-* lanes onto pi/zcode/<lowercase-model>[:<thinking>]", (t) => {
  assert.equal(migrateLegacyZcodeLane("zcode/GLM-5.3:high"), "pi/zcode/glm-5.3:high");
  assert.equal(migrateLegacyZcodeLane("zcode/GLM-5.3-Flash:medium"), "pi/zcode/glm-5.3-flash:medium");
  assert.equal(migrateLegacyZcodeLane("zcode/GLM-5.3"), "pi/zcode/glm-5.3");
  assert.equal(migrateLegacyZcodeLane("zcode/builtin:zai-coding-plan\\GLM-5.3:high"), "pi/zcode/glm-5.3:high");
  assert.equal(migrateLegacyZcodeLane("pi/zai/glm-5.3"), "pi/zcode/glm-5.3");
  assert.equal(migrateLegacyZcodeLane("pi/zai/glm-5.3:max"), "pi/zcode/glm-5.3:max");
  assert.equal(migrateLegacyZcodeLane("pi/zcode/glm-5.3:high"), "pi/zcode/glm-5.3:high");
  assert.equal(migrateLegacyZcodeLane("claude/opus-4-8:high"), "claude/opus-4-8:high");

  // Retired zcode/<model> has no headless tool-less CLI form anymore — it must migrate to pi/zcode/*.
  assert.equal(laneCliInvocation("zcode/GLM-5.3"), undefined);
  assert.deepEqual(laneCliInvocation("pi/zcode/glm-5.3:high"), {
    command: "pi",
    args: ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--model", "zcode/glm-5.3", "--thinking", "high"],
  });

  // Legacy lanes in lanes.json and profiles.json automatically migrate on load and save.
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");
  writeRawLanes(stateDir, `${JSON.stringify({ worker: "zcode/GLM-5.3:high", watch: "pi/zai/glm-5.3-flash:medium" }, null, 2)}\n`);
  const loaded = loadLanes(stateDir);
  assert.ok(loaded.ok);
  assert.equal(loaded.lanes.worker, "pi/zcode/glm-5.3:high");
  assert.equal(loaded.lanes.watch, "pi/zcode/glm-5.3-flash:medium");

  const saved = saveLanes(stateDir, { lead: "zcode/GLM-5.3:max" });
  assert.ok(saved.ok);
  assert.equal(saved.lanes.lead, "pi/zcode/glm-5.3:max");
  assert.deepEqual(JSON.parse(readFileSync(lanesPath(stateDir), "utf8")), {
    worker: "pi/zcode/glm-5.3:high",
    watch: "pi/zcode/glm-5.3-flash:medium",
    lead: "pi/zcode/glm-5.3:max",
  });
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
  const projSavedSrc = saveLanes(projSrc, { supervisor: "pi/zcode/glm-5.3" }, "acme-api-abc123");
  const projSavedMjs = await saveLanesMjs(projMjs, { supervisor: "pi/zcode/glm-5.3" }, "acme-api-abc123");
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
    assert.match(getDefaults.stdout, new RegExp(`${name}[= ]pi/zcode/glm-5.3`), `get shows ${name} at the default`);
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
  const setProject = await runCli(["lanes", "set", "lead", "pi/zcode/glm-5.3", "--project", repo], { PASEO_HOME: home });
  assert.equal(setProject.status, 0, setProject.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(projectLanes, "utf8")),
    { lead: "pi/zcode/glm-5.3" },
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
  assert.match(getProject.stdout, /lead=pi\/zcode\/glm-5\.3/);
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
  assert.deepEqual(JSON.parse(readFileSync(projectLanes, "utf8")), { lead: "pi/zcode/glm-5.3" });
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

// ---- Owner-authored Lane profiles (v0.0.38, ADR 0026 §2) ------------------------------------

/** A complete 6-lane table with per-call variation. */
function profileLanes(overrides: Partial<Record<(typeof LANE_NAMES)[number], string>> = {}): LaneProfile["lanes"] {
  return { ...defaultLanes(), ...overrides };
}

test("Lane profiles start empty (zero built-ins) and run the save→apply→batch→reset→delete lifecycle", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");

  // The store starts clean: no file, no profiles (the Out of Scope law).
  assert.equal(existsSync(laneProfilesPath(stateDir)), false);
  assert.deepEqual(listLaneProfiles(stateDir), []);

  // Save derives the id slug from the name; the file appears on first save.
  const cheap = saveLaneProfile(stateDir, { name: "Cheap Nightly", lanes: profileLanes({ worker: "pi/zcode/glm-5.3" }) });
  assert.equal(cheap.id, "cheap-nightly");
  const zed = saveLaneProfile(stateDir, { name: "Zed Setup", lanes: profileLanes(), id: "zed" });
  const alpha = saveLaneProfile(stateDir, { name: "Alpha Setup", lanes: profileLanes(), id: "alpha-2" });
  assert.deepEqual(
    listLaneProfiles(stateDir).map((profile) => profile.id),
    ["alpha-2", "cheap-nightly", "zed"],
    "list sorts by name, then id",
  );
  assert.deepEqual(getLaneProfile(stateDir, "zed"), zed);
  assert.equal(getLaneProfile(stateDir, "nope"), undefined);

  // Re-saving an existing id updates it in place with a newer updatedAt.
  const updated = saveLaneProfile(stateDir, { id: "zed", name: "Zed Setup v2", lanes: profileLanes({ lead: "claude/opus-4-8" }), updatedAt: "2026-10-24T12:00:00.000Z" });
  assert.equal(updated.name, "Zed Setup v2");
  assert.equal(updated.updatedAt, "2026-10-24T12:00:00.000Z");
  assert.equal(getLaneProfile(stateDir, "zed")!.lanes.lead, "claude/opus-4-8");

  // Copy-on-apply, per Project: all six lanes land in the Project's own file,
  // self-contained; the machine table is untouched; the scope is recorded.
  const appliedProject = applyLaneProfile(stateDir, "cheap-nightly", "acme-api-abc123");
  assert.equal(appliedProject.path, join(stateDir, "projects", "acme-api-abc123", "lanes.json"));
  assert.deepEqual(
    JSON.parse(readFileSync(appliedProject.path, "utf8")),
    profileLanes({ worker: "pi/zcode/glm-5.3" }),
    "the project file holds exactly the profile's six lanes — no pointer back to profiles.json",
  );
  assert.equal(existsSync(lanesPath(stateDir)), false, "a project apply never touches the machine file");
  let profilesFile = JSON.parse(readFileSync(laneProfilesPath(stateDir), "utf8")) as LaneProfilesFile;
  assert.deepEqual(profilesFile.activeProfileByScope, { "acme-api-abc123": "cheap-nightly" });

  // Copy-on-apply, machine-wide: "All projects" writes the machine file.
  const appliedGlobal = applyLaneProfile(stateDir, "cheap-nightly");
  assert.equal(appliedGlobal.path, lanesPath(stateDir));
  assert.deepEqual(JSON.parse(readFileSync(lanesPath(stateDir), "utf8")), profileLanes({ worker: "pi/zcode/glm-5.3" }));
  profilesFile = JSON.parse(readFileSync(laneProfilesPath(stateDir), "utf8")) as LaneProfilesFile;
  assert.deepEqual(profilesFile.activeProfileByScope, { "acme-api-abc123": "cheap-nightly", global: "cheap-nightly" });

  // saveLanesBatch: ONE atomic multi-lane write — an invalid lane anywhere in
  // the batch refuses the WHOLE batch and writes nothing.
  const projectLanesPath = join(stateDir, "projects", "acme-api-abc123", "lanes.json");
  const beforeBatch = readFileSync(projectLanesPath, "utf8");
  assert.throws(
    () => saveLanesBatch(stateDir, { watch: "claude/claude-opus-4-6:high", worker: "auto" }, "acme-api-abc123"),
    factoryErrorCode("invalid-lane"),
  );
  assert.equal(readFileSync(projectLanesPath, "utf8"), beforeBatch, "a refused batch leaves the target file byte-identical");
  const batch = saveLanesBatch(stateDir, { watch: "claude/claude-opus-4-6:high", worker: "claude/claude-opus-4-6:high" }, "acme-api-abc123");
  assert.deepEqual(
    JSON.parse(readFileSync(batch.path, "utf8")),
    profileLanes({ worker: "claude/claude-opus-4-6:high", watch: "claude/claude-opus-4-6:high" }),
    "the batch lands whole in one write",
  );
  assert.equal(batch.lanes.watch, "claude/claude-opus-4-6:high");

  // resetProjectLanes: the override file is removed, the scope pointer
  // cleared, and the reply carries the effective machine table.
  const reset = resetProjectLanes(stateDir, "acme-api-abc123");
  assert.equal(reset.removed, true);
  assert.equal(existsSync(projectLanesPath), false);
  assert.equal(reset.lanes.watch, "pi/zcode/glm-5.3", "the reply is the machine table the Project inherits again");
  assert.equal(reset.lanes.worker, "pi/zcode/glm-5.3");
  profilesFile = JSON.parse(readFileSync(laneProfilesPath(stateDir), "utf8")) as LaneProfilesFile;
  assert.deepEqual(profilesFile.activeProfileByScope, { global: "cheap-nightly" }, "the project's scope entry is cleared, the machine's stands");
  const resetAgain = resetProjectLanes(stateDir, "acme-api-abc123");
  assert.equal(resetAgain.removed, false, "a second reset names that there was nothing to remove");

  // deleteLaneProfile: tombstone into `deleted`, activeProfileByScope entries
  // naming the profile removed, the live entry gone.
  assert.equal(deleteLaneProfile(stateDir, "cheap-nightly", "2026-10-24T13:00:00.000Z"), true);
  assert.equal(getLaneProfile(stateDir, "cheap-nightly"), undefined);
  profilesFile = JSON.parse(readFileSync(laneProfilesPath(stateDir), "utf8")) as LaneProfilesFile;
  assert.deepEqual(profilesFile.deleted, { "cheap-nightly": { deletedAt: "2026-10-24T13:00:00.000Z" } });
  assert.equal(
    profilesFile.activeProfileByScope,
    undefined,
    "the global scope entry naming the deleted profile is gone — an empty scope map writes no key",
  );
  assert.equal(deleteLaneProfile(stateDir, "cheap-nightly"), false, "an unknown id deletes nothing");
  assert.equal(deleteLaneProfile(stateDir, "never-existed"), false);

  // Re-creating a deleted id clears its tombstone — the profile is live again.
  const revived = saveLaneProfile(stateDir, { id: "cheap-nightly", name: "Cheap Nightly", lanes: profileLanes() });
  assert.equal(revived.id, "cheap-nightly");
  profilesFile = JSON.parse(readFileSync(laneProfilesPath(stateDir), "utf8")) as LaneProfilesFile;
  assert.equal(profilesFile.deleted, undefined, "the tombstone retired with the revival");
});

test("Lane profile saves refuse bad ids, missing lanes, and invalid lanes — never a guessed profile", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "factory");

  assert.throws(() => saveLaneProfile(stateDir, { id: "Bad_Id!", name: "x", lanes: profileLanes() }), factoryErrorCode("invalid-profile-id"));
  assert.throws(() => saveLaneProfile(stateDir, { id: "-nope", name: "x", lanes: profileLanes() }), factoryErrorCode("invalid-profile-id"));
  assert.throws(() => saveLaneProfile(stateDir, { name: "x", lanes: profileLanes({ worker: "auto" }) }), factoryErrorCode("invalid-lane"));
  const missing = profileLanes();
  delete (missing as Partial<Record<(typeof LANE_NAMES)[number], string>>).watch;
  assert.throws(() => saveLaneProfile(stateDir, { name: "x", lanes: missing }), factoryErrorCode("invalid-profile"));
  assert.throws(() => saveLaneProfile(stateDir, { name: "  ", lanes: profileLanes() }), factoryErrorCode("invalid-profile"));
  assert.equal(existsSync(laneProfilesPath(stateDir)), false, "a refused save writes no file");
  assert.throws(() => applyLaneProfile(stateDir, "ghost", "acme-api-abc123"), factoryErrorCode("profile-not-found"));
  // A name with no slug-able character still derives an addressable id.
  assert.equal(saveLaneProfile(stateDir, { name: "!!!", lanes: profileLanes() }).id, "profile");
});

test("mergeLaneProfilesFiles: newer edit wins, deletion tombstones win, disjoint ids union — two machines, one file", () => {
  const lanesOf = (lead: string) => profileLanes({ lead });
  // Machine A: edited "shared" at 10:00, created "a-only", still holds "gone".
  const machineA: LaneProfilesFile = {
    profiles: {
      shared: { name: "Shared", lanes: lanesOf("claude/opus-4-8"), updatedAt: "2026-10-24T10:00:00.000Z" },
      "a-only": { name: "A only", lanes: lanesOf("pi/zai/glm-5.3"), updatedAt: "2026-10-24T09:00:00.000Z" },
      gone: { name: "Gone", lanes: lanesOf("pi/zai/glm-5.3"), updatedAt: "2026-10-24T08:00:00.000Z" },
    },
    activeProfileByScope: { global: "shared" },
  };
  // Machine B: edited "shared" LATER at 11:00, created "b-only", deleted "gone".
  const machineB: LaneProfilesFile = {
    profiles: {
      shared: { name: "Shared (B edit)", lanes: lanesOf("copilot/gpt-5.4"), updatedAt: "2026-10-24T11:00:00.000Z" },
      "b-only": { name: "B only", lanes: lanesOf("claude/claude-sonnet-4-6"), updatedAt: "2026-10-24T09:30:00.000Z" },
    },
    deleted: { gone: { deletedAt: "2026-10-24T09:00:00.000Z" } },
    activeProfileByScope: { "proj-b": "gone" },
  };

  const merged = mergeLaneProfilesFiles(machineA, machineB);
  assert.deepEqual(
    Object.keys(merged.profiles).sort(),
    ["a-only", "b-only", "shared"],
    "both sides' ids union — profiles created on different machines combine",
  );
  assert.equal(merged.profiles.shared!.name, "Shared (B edit)", "the newer updatedAt edit wins deterministically");
  assert.equal(merged.profiles.shared!.lanes.lead, "copilot/gpt-5.4");
  assert.equal(merged.profiles["a-only"]!.name, "A only");
  assert.equal(merged.deleted?.gone?.deletedAt, "2026-10-24T09:00:00.000Z", "the deletion tombstone wins over the older profile edit");
  assert.equal(merged.profiles.gone, undefined);
  assert.deepEqual(merged.activeProfileByScope, { global: "shared" }, "a scope naming a deleted profile is dropped; disjoint scopes union");

  // The reverse argument order is symmetric in outcome: newer still wins.
  const reversed = mergeLaneProfilesFiles(machineB, machineA);
  assert.equal(reversed.profiles.shared!.name, "Shared (B edit)");
  assert.equal(reversed.deleted?.gone?.deletedAt, "2026-10-24T09:00:00.000Z");

  // An exact tie breaks to the local side by default, the remote with preferRemote.
  const tieA: LaneProfilesFile = { profiles: { t: { name: "T (A)", lanes: lanesOf("pi/zai/glm-5.3"), updatedAt: "2026-10-24T10:00:00.000Z" } } };
  const tieB: LaneProfilesFile = { profiles: { t: { name: "T (B)", lanes: lanesOf("pi/zai/glm-5.3"), updatedAt: "2026-10-24T10:00:00.000Z" } } };
  assert.equal(mergeLaneProfilesFiles(tieA, tieB).profiles.t!.name, "T (A)");
  assert.equal(mergeLaneProfilesFiles(tieA, tieB, { preferRemote: true }).profiles.t!.name, "T (B)");

  // A profile re-saved AFTER its deletion is live again — the newer act wins.
  const revivedOnA: LaneProfilesFile = {
    profiles: { gone: { name: "Gone revived", lanes: lanesOf("pi/zai/glm-5.3"), updatedAt: "2026-10-24T10:00:00.000Z" } },
  };
  const revived = mergeLaneProfilesFiles(machineB, revivedOnA);
  assert.equal(revived.profiles.gone!.name, "Gone revived");
  assert.equal(revived.deleted?.gone, undefined, "the stale tombstone retires when the re-save is newer");
});

test("parseLane preserves a colon inside a zcode runtime model prefix when no :thinking suffix is present", () => {
  assert.deepEqual(core.parseLane("zcode/builtin:zai-coding-plan\\GLM-5.3"), {
    provider: "zcode",
    model: "builtin:zai-coding-plan\\GLM-5.3",
  });
  assert.deepEqual(core.parseLane("zcode/builtin:zai-coding-plan\\GLM-5.3:high"), {
    provider: "zcode",
    model: "builtin:zai-coding-plan\\GLM-5.3",
    thinking: "high",
  });
  assert.deepEqual(core.parseLane("zcode/custom:cliproxyapi\\claude-sonnet-4-6"), {
    provider: "zcode",
    model: "custom:cliproxyapi\\claude-sonnet-4-6",
  });
});

// ---- per-dispatch provider-adaptive thinking effort (v0.5.0 ticket 04, ADR 0054 §4) ----

/** One provider's catalog slice, the shape the daemon's `providers.listModels` returns. */
function catalogOf(...entries: LaneThinkingCatalogEntry[]): LaneThinkingCatalogEntry[] {
  return entries;
}

const FULL_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;

test("resolvePeerThinkingLane keeps the configured worker lane untouched when no override is requested", () => {
  const catalog = catalogOf({ provider: "pi", models: [{ id: "zcode/glm-5.3", thinkingOptions: FULL_TIERS.map((id) => ({ id })) }] });
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3:high", undefined, catalog), "pi/zcode/glm-5.3:high");
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3", undefined, catalog), "pi/zcode/glm-5.3");
  assert.equal(resolvePeerThinkingLane("antigravity/gemini-4-argon-high", undefined, []), "antigravity/gemini-4-argon-high");
});

test("a fixed-effort model (thinkingOptions: []) silently ignores the override — no error, no suffix mutation", () => {
  const catalog = catalogOf({ provider: "antigravity", models: [{ id: "gemini-4-argon-high", thinkingOptions: [] }] });
  assert.equal(resolvePeerThinkingLane("antigravity/gemini-4-argon-high", "high", catalog), "antigravity/gemini-4-argon-high");
  assert.equal(resolvePeerThinkingLane("antigravity/gemini-4-argon-high", "max", catalog), "antigravity/gemini-4-argon-high");
  // An unknown model — no catalog entry at all, or no catalog reachable — preserves the lane the same way.
  assert.equal(resolvePeerThinkingLane("custom/nothing-known", "high", catalog), "custom/nothing-known");
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3:high", "max", []), "pi/zcode/glm-5.3:high");
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3:high", "max", undefined), "pi/zcode/glm-5.3:high");
});

test("a full-catalog model applies the requested tier as the :thinking suffix", () => {
  const full = catalogOf(
    { provider: "claude", models: [{ id: "opus-4-8", thinkingOptions: FULL_TIERS.map((id) => ({ id })) }] },
    { provider: "pi", models: [{ id: "zcode/glm-5.3", thinkingOptions: FULL_TIERS.map((id) => ({ id })) }] },
  );
  assert.equal(resolvePeerThinkingLane("claude/opus-4-8", "xhigh", full), "claude/opus-4-8:xhigh");
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3:high", "max", full), "pi/zcode/glm-5.3:max");
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3", "low", full), "pi/zcode/glm-5.3:low");
});

test("a partial catalog maps an unsupported medium to the configured suffix, else high, else the last option — never bare", () => {
  const partial = catalogOf({ provider: "pi", models: [{ id: "zcode/glm-5.3", thinkingOptions: [{ id: "low" }, { id: "high" }, { id: "max" }] }] });
  // The Owner's configured suffix on the worker lane wins when the catalog carries it.
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3:high", "medium", partial), "pi/zcode/glm-5.3:high");
  // A bare configured lane has no suffix to honor — high is medium's default landing tier.
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3", "medium", partial), "pi/zcode/glm-5.3:high");
  // The configured suffix is the FIRST fallback — when the catalog carries it,
  // medium lands there even below the requested rung (the Owner's own word).
  const lowCatalog = catalogOf({ provider: "pi", models: [{ id: "zcode/glm-5.3", thinkingOptions: [{ id: "low" }, { id: "max" }] }] });
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3:low", "medium", lowCatalog), "pi/zcode/glm-5.3:low");
  // No high and no valid configured suffix — the last advertised option stands in, still suffixed.
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3:medium", "medium", lowCatalog), "pi/zcode/glm-5.3:max");
});

test("a partial catalog maps xhigh to max, else high, else the last option — never bare", () => {
  const partial = catalogOf({ provider: "pi", models: [{ id: "zcode/glm-5.3", thinkingOptions: [{ id: "low" }, { id: "high" }, { id: "max" }] }] });
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3", "xhigh", partial), "pi/zcode/glm-5.3:max");
  const noMax = catalogOf({ provider: "pi", models: [{ id: "zcode/glm-5.3", thinkingOptions: [{ id: "low" }, { id: "high" }] }] });
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3", "xhigh", noMax), "pi/zcode/glm-5.3:high");
  const onlyLowMedium = catalogOf({ provider: "pi", models: [{ id: "zcode/glm-5.3", thinkingOptions: [{ id: "low" }, { id: "medium" }] }] });
  assert.equal(resolvePeerThinkingLane("pi/zcode/glm-5.3", "xhigh", onlyLowMedium), "pi/zcode/glm-5.3:medium");
});
