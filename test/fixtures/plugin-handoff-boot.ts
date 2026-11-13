/** Actual plugin boot over a disposable legacy state; no daemon is started. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import contribute from "../../plugin/index.server.ts";
import { writeProjectRegistration } from "../../plugin/server/core/project.ts";

const home = process.env.PASEO_HOME!;
const stateDir = join(home, "plugin-state/paseo-factory");
const root = join(home, "repo");
mkdirSync(root, { recursive: true });
execFileSync("git", ["init", "-q", root]);
execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: root });
writeProjectRegistration(stateDir, "legacy", { root, lead: "outgoing-lead", rotationState: "rotation_pending" });
const server = { handle() {}, addHook() { return () => {}; }, on() { return () => {}; }, before() { return () => {}; } } as unknown as Parameters<typeof contribute>[0];
const stop = contribute(server);
try {
  const progress = JSON.parse(readFileSync(join(stateDir, "projects/legacy/handoff-lead.json"), "utf8"));
  assert.equal(progress.reason, "context-mark");
  assert.equal(progress.state, "scheduled");
  assert.equal(progress.seat, "lead");
  console.log("LEGACY_HANDOFF_BOOT_OK");
} finally { stop(); }
