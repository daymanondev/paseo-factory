import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, disposeDir } from "./helpers.ts";
import { saveLanes } from "../src/lanes.ts";
import {
  readExecution,
  registerExecution,
  saveExecutionDefault,
  readScrumConfig,
  ensureScrumConfig,
  saveScrumConfig,
} from "../src/scrum/config.ts";

test("existing Projects stay SLP; registration copies execution default once without rewriting SLP files", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  saveLanes(state, { worker: "pi/test-worker", lead: "claude/test-lead" });
  const before = readFileSync(join(state, "lanes.json"), "utf8");
  saveExecutionDefault(state, "scrum");
  assert.equal(readExecution(state, "old").mode, "slp");
  assert.equal(existsSync(join(state, "projects/old/execution.json")), false);
  assert.equal(registerExecution(state, "new").mode, "scrum");
  saveExecutionDefault(state, "slp");
  assert.equal(registerExecution(state, "new").mode, "scrum");
  assert.equal(readScrumConfig(state, "old"), undefined);
  const config = ensureScrumConfig(state, "new");
  assert.equal(config.lanes.pm, "claude/test-lead");
  assert.equal(config.lanes.qa, "pi/test-worker");
  saveScrumConfig(state, {
    ...config,
    lanes: { ...config.lanes, dev: "pi/frozen" },
  });
  assert.equal(readScrumConfig(state, "new")!.lanes.dev, "pi/test-worker");
  assert.equal(readFileSync(join(state, "lanes.json"), "utf8"), before);
  writeFileSync(join(state, "projects/new/scrum-lanes.json"), "broken");
  assert.equal(readExecution(state, "old").mode, "slp");
  assert.throws(() => readScrumConfig(state, "new"), /scrum-config-invalid/);
});

test("Scrum profile apply is isolated, atomic, and tombstones survive merge", async (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  const {
    saveScrumProfile,
    applyScrumProfile,
    deleteScrumProfile,
    readScrumProfiles,
    mergeScrumProfiles,
  } = await import("../src/scrum/profiles.ts");
  const config = ensureScrumConfig(state);
  const profile = saveScrumProfile(state, {
    id: "daily",
    name: "Daily",
    config,
  });
  assert.equal(profile.id, "scrum:daily");
  applyScrumProfile(state, profile.id, "project-a");
  assert.deepEqual(readScrumConfig(state, "project-a"), config);
  assert.equal(readExecution(state, "project-a").mode, "slp");
  assert.equal(existsSync(join(state, "profiles.json")), false);
  const before = readScrumProfiles(state);
  deleteScrumProfile(state, profile.id);
  assert.equal(
    mergeScrumProfiles(before, readScrumProfiles(state)).profiles.length,
    0,
  );
});

test("busy mode switches have no effects and interrupted seat transitions recover before dispatch", async (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  const { switchExecution, assertExecutionReady } = await import(
    "../src/scrum/execution.ts"
  );
  const rotate = async () => {
    throw new Error("daemon disconnected");
  };
  await assert.rejects(
    switchExecution({
      state,
      slug: "p",
      mode: "scrum",
      blockers: ["task:open"],
      rotate,
    }),
    /task:open/,
  );
  assert.equal(readExecution(state, "p").mode, "slp");
  await assert.rejects(
    switchExecution({ state, slug: "p", mode: "scrum", blockers: [], rotate }),
    /daemon disconnected/,
  );
  assert.throws(
    () => assertExecutionReady(state, "p"),
    /execution-transition-pending/,
  );
  let transitions = 0;
  await switchExecution({
    state,
    slug: "p",
    mode: "scrum",
    blockers: [],
    rotate: async (target) => {
      assert.equal(target.mode, "scrum");
      transitions++;
    },
  });
  assert.equal(transitions, 1);
  assert.equal(readExecution(state, "p").mode, "scrum");
  assert.doesNotThrow(() => assertExecutionReady(state, "p"));
});
