import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { disposeDir, makeTempDir } from "./helpers.ts";
import {
  clearReleaseRequest,
  clearStoreReleaseRequest,
  migrateLegacyExecutionState,
  projectSettingsPath,
  readProjectSettings,
  readReleaseRequest,
  readReleaseSettings,
  readStoreReleaseRequest,
  readStoreReleaseSettings,
  resetProjectSkillPacks,
  setProjectReleaseSettings,
  setProjectSkillPacks,
  setProjectStoreReleaseSettings,
  setReleaseRequest,
  setStoreReleaseRequest,
  storeReleaseRequestPath,
} from "../src/project-settings.ts";

/** Per-Project settings (ADR 0056): defaults, skill-pack writes, and the unreadable-legacy-record safety rule. */

test("a Project with no settings record has the defaults; skill packs are validated and de-duplicated", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  assert.deepEqual(readProjectSettings(state, "alpha"), { schemaVersion: 1, revision: 0 });
  setProjectSkillPacks(state, "alpha", ["expo", "expo", "science"]);
  assert.deepEqual(readProjectSettings(state, "alpha").skillPacks, ["expo", "science"]);
  assert.throws(() => setProjectSkillPacks(state, "alpha", ["../escape"]), /Invalid Project skill pack/);
  assert.deepEqual(readProjectSettings(state, "alpha").skillPacks, ["expo", "science"], "a refused write changes nothing");
  setProjectSkillPacks(state, "alpha", [" release-tools ", "release-tools", "source-team-123"]);
  assert.deepEqual(readProjectSettings(state, "alpha").skillPacks, ["release-tools", "source-team-123"]);
  resetProjectSkillPacks(state, "alpha");
  assert.equal(readProjectSettings(state, "alpha").skillPacks, undefined);
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

test("release settings default to off, keep legacy settings valid, persist mode/branch/updatedAt, and drop pending requests when leaving on-request", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);

  // Absent settings read as off
  assert.deepEqual(readReleaseSettings(state, "alpha"), { mode: "off" });

  // Legacy project-settings.json without release stays valid
  mkdirSync(join(state, "projects/legacy"), { recursive: true });
  writeFileSync(projectSettingsPath(state, "legacy"), JSON.stringify({ schemaVersion: 1, revision: 2, skillPacks: ["expo"] }));
  assert.deepEqual(readReleaseSettings(state, "legacy"), { mode: "off" });
  assert.deepEqual(readProjectSettings(state, "legacy").skillPacks, ["expo"]);

  // Damaged release block is refused
  writeFileSync(projectSettingsPath(state, "legacy"), JSON.stringify({ schemaVersion: 1, revision: 3, release: { mode: "bogus", updatedAt: "x" } }));
  assert.throws(() => readProjectSettings(state, "legacy"), /project-settings-invalid/);

  // Write on-request + branch
  setProjectReleaseSettings(state, "alpha", { mode: "on-request", branch: "release" }, () => "2026-11-18T12:00:00.000Z");
  assert.deepEqual(readReleaseSettings(state, "alpha"), {
    mode: "on-request",
    branch: "release",
    updatedAt: "2026-11-18T12:00:00.000Z",
  });

  // Pending Release request is stored separately and survives mode-preserving branch updates
  setReleaseRequest(state, "alpha", { version: "0.14.0", requestedAt: "2026-11-18T12:05:00.000Z", requestedBy: "supervisor" });
  assert.deepEqual(readReleaseRequest(state, "alpha"), {
    version: "0.14.0",
    requestedAt: "2026-11-18T12:05:00.000Z",
    requestedBy: "supervisor",
  });

  setProjectReleaseSettings(state, "alpha", { branch: null }, () => "2026-11-18T12:06:00.000Z");
  assert.deepEqual(readReleaseSettings(state, "alpha"), { mode: "on-request", updatedAt: "2026-11-18T12:06:00.000Z" });
  assert.equal(readReleaseRequest(state, "alpha")?.version, "0.14.0");

  // Switching mode away from on-request drops pending request
  setProjectReleaseSettings(state, "alpha", { mode: "auto" }, () => "2026-11-18T12:07:00.000Z");
  assert.equal(readReleaseRequest(state, "alpha"), undefined);
  assert.equal(readReleaseSettings(state, "alpha").mode, "auto");

  // Explicit clear works cleanly
  setReleaseRequest(state, "alpha", { requestedAt: "2026-11-18T12:08:00.000Z" });
  assert.equal(clearReleaseRequest(state, "alpha"), true);
  assert.equal(readReleaseRequest(state, "alpha"), undefined);
});

test("store release settings default to off, keep legacy settings valid, persist mode/updatedAt, and drop pending requests when leaving on-request", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);

  // Absent settings read as off
  assert.deepEqual(readStoreReleaseSettings(state, "alpha"), { mode: "off" });

  // Legacy project-settings.json without storeRelease stays valid
  mkdirSync(join(state, "projects/legacy"), { recursive: true });
  writeFileSync(
    projectSettingsPath(state, "legacy"),
    JSON.stringify({ schemaVersion: 1, revision: 2, skillPacks: ["expo"] }),
  );
  assert.deepEqual(readStoreReleaseSettings(state, "legacy"), { mode: "off" });

  // Damaged storeRelease block is refused
  writeFileSync(
    projectSettingsPath(state, "legacy"),
    JSON.stringify({ schemaVersion: 1, revision: 3, storeRelease: { mode: "auto-production", updatedAt: "x" } }),
  );
  assert.throws(() => readProjectSettings(state, "legacy"), /project-settings-invalid/);

  // Write on-request
  setProjectStoreReleaseSettings(state, "alpha", { mode: "on-request" }, () => "2026-11-20T10:00:00.000Z");
  assert.deepEqual(readStoreReleaseSettings(state, "alpha"), {
    mode: "on-request",
    updatedAt: "2026-11-20T10:00:00.000Z",
  });

  // Pending Store release request is stored separately in store-release-request.json
  setStoreReleaseRequest(state, "alpha", {
    target: "production",
    platforms: ["android", "ios"],
    resumeRunId: "run-123",
    resolution: { approved: true },
    requestedAt: "2026-11-20T10:05:00.000Z",
    requestedBy: "supervisor",
  });
  assert.equal(existsSync(storeReleaseRequestPath(state, "alpha")), true);
  assert.deepEqual(readStoreReleaseRequest(state, "alpha"), {
    target: "production",
    platforms: ["android", "ios"],
    resumeRunId: "run-123",
    resolution: { approved: true },
    requestedAt: "2026-11-20T10:05:00.000Z",
    requestedBy: "supervisor",
  });

  // Keeping mode at on-request preserves pending request
  setProjectStoreReleaseSettings(state, "alpha", { mode: "on-request" }, () => "2026-11-20T10:06:00.000Z");
  assert.equal(readStoreReleaseRequest(state, "alpha")?.target, "production");

  // Switching mode away from on-request drops pending request
  setProjectStoreReleaseSettings(state, "alpha", { mode: "auto-staging" }, () => "2026-11-20T10:07:00.000Z");
  assert.equal(readStoreReleaseRequest(state, "alpha"), undefined);
  assert.equal(existsSync(storeReleaseRequestPath(state, "alpha")), false);
  assert.equal(readStoreReleaseSettings(state, "alpha").mode, "auto-staging");

  // Explicit clear works cleanly
  setStoreReleaseRequest(state, "alpha", { target: "staging", requestedAt: "2026-11-20T10:08:00.000Z" });
  assert.equal(clearStoreReleaseRequest(state, "alpha"), true);
  assert.equal(clearStoreReleaseRequest(state, "alpha"), false);
  assert.equal(readStoreReleaseRequest(state, "alpha"), undefined);
});
