import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { disposeDir, makeTempDir } from "./helpers.ts";
import { migrateLegacyExecutionState, projectSettingsPath, readProjectSettings } from "../src/project-settings.ts";

/** The v0.6.0 boot cleanup validates what it carries across, and a damaged record's refusal keeps its cause (ADR 0056, review S8). */

test("boot cleanup carries a well-formed legacy Open Design link and source across, and drops malformed ones instead of trusting a cast", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  const link = { projectId: "od-1", projectName: "Mobile", sourceUpdatedAt: 1, syncedAt: "2026-10-01T00:00:00.000Z", digest: "d", screenCount: 2, files: ["index.html"] };
  mkdirSync(join(state, "projects/good"), { recursive: true });
  writeFileSync(join(state, "projects/good/execution.json"), JSON.stringify({ mode: "scrum", openDesignLink: link, openDesignSource: { kind: "client", requestId: "r1" } }));
  mkdirSync(join(state, "projects/bad"), { recursive: true });
  writeFileSync(join(state, "projects/bad/execution.json"), JSON.stringify({ mode: "scrum", openDesignLink: { projectId: 7 }, openDesignSource: { kind: "client", requestId: 5 } }));
  migrateLegacyExecutionState(state);
  const good = readProjectSettings(state, "good");
  assert.deepEqual(good.openDesignLink, link);
  assert.deepEqual(good.openDesignSource, { kind: "client", requestId: "r1" });
  const bad = readProjectSettings(state, "bad");
  assert.equal(bad.openDesignLink, undefined, "a link with the wrong shape is not carried across");
  assert.equal(bad.openDesignSource, undefined, "a source with a non-string request id is not carried across");
});

test("a damaged settings record's refusal names the file and keeps the parse failure", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  mkdirSync(join(state, "projects/alpha"), { recursive: true });
  writeFileSync(projectSettingsPath(state, "alpha"), "{broken");
  assert.throws(
    () => readProjectSettings(state, "alpha"),
    (error: Error) => error.message.includes(projectSettingsPath(state, "alpha")) && /at position \d+/.test(error.message),
  );
});
