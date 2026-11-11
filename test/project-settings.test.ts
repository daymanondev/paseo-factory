import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { disposeDir, makeTempDir } from "./helpers.ts";
import { migrateLegacyExecutionState, projectSettingsPath, readProjectSettings, setProjectSkillPacks } from "../src/project-settings.ts";

/** Per-Project settings (ADR 0056): defaults, skill-pack writes, and the unreadable-legacy-record safety rule. */

test("a Project with no settings record has the defaults; skill packs are validated and de-duplicated", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  assert.deepEqual(readProjectSettings(state, "alpha"), { schemaVersion: 1, revision: 0 });
  setProjectSkillPacks(state, "alpha", ["expo", "expo", "science"]);
  assert.deepEqual(readProjectSettings(state, "alpha").skillPacks, ["expo", "science"]);
  assert.throws(() => setProjectSkillPacks(state, "alpha", ["nonsense"]), /Unknown Project skill pack/);
  assert.deepEqual(readProjectSettings(state, "alpha").skillPacks, ["expo", "science"], "a refused write changes nothing");
});

test("a damaged settings record is refused by name, never read as defaults", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  mkdirSync(join(state, "projects/alpha"), { recursive: true });
  writeFileSync(projectSettingsPath(state, "alpha"), "{broken");
  assert.throws(() => readProjectSettings(state, "alpha"), /project-settings-invalid/);
});

test("boot cleanup leaves a legacy execution record it cannot read in place, and still removes Scrum artefacts", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  mkdirSync(join(state, "projects/alpha/scrum/runs/r1"), { recursive: true });
  writeFileSync(join(state, "projects/alpha/execution.json"), "{broken");
  const result = migrateLegacyExecutionState(state);
  assert.deepEqual(result.unreadable, ["alpha"]);
  assert.equal(readFileSync(join(state, "projects/alpha/execution.json"), "utf8"), "{broken", "unreadable data is never deleted");
  assert.equal(existsSync(projectSettingsPath(state, "alpha")), false);
  assert.equal(existsSync(join(state, "projects/alpha/scrum")), false);
});
