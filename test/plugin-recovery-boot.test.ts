import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { disposeDir, makeTempDir } from "./helpers.ts";

/**
 * The session-open sweep history gate (v0.0.91, spec.md:88): the fixture
 * drives `agent.open.before` twice after recovery — once as an interactive
 * supervisor session (binds the seat → the orphaned-workspace sweep fires,
 * observed through the "session-open sweep:" trigger log) and once as a
 * history open (`purpose: "history"` reads an old conversation, never sweeps).
 * Exactly one sweep line may appear, and only between the INTERACTIVE and
 * HISTORY markers.
 */
function assertSweepHistoryGate(output: string): void {
  const sweeps = output.match(/session-open sweep:/g) ?? [];
  assert.equal(sweeps.length, 1, `exactly one session-open sweep across both arms — got ${sweeps.length}`);
  assert.match(
    output,
    /SWEEP_ARM_INTERACTIVE\n[\s\S]*session-open sweep: supervisor sup-open opened at [^\n]*\n[\s\S]*SWEEP_ARM_HISTORY/,
    "the sweep fires for the interactive supervisor open and precedes the history arm",
  );
  assert.doesNotMatch(
    output,
    /SWEEP_ARM_HISTORY[\s\S]*session-open sweep:/,
    "a history open never triggers the orphaned-workspace sweep",
  );
}

for (const action of ["resume", "restore"]) for (const project of [false, true]) {
  test(`actual plugin boot keeps ${project ? "Project" : "root"} ${action} entrances alive and resumes deferred work`, { timeout: 15_000 }, (t) => {
    const dir = makeTempDir(); disposeDir(t, dir);
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/plugin-recovery-boot.ts", import.meta.url))], {
      env: { ...process.env, HOME: dir, PASEO_HOME: join(dir, "trial"), RECOVERY_ACTION: action, RECOVERY_PROJECT: project ? "yes" : "no" }, encoding: "utf8", timeout: 12_000,
    });
    assert.match(output, /RECOVERY_OK/);
    assertSweepHistoryGate(output);
  });
}

 test("actual recovery Spool answers refused controls without pre-existing reply infrastructure and still resumes", { timeout: 15_000 }, (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/plugin-recovery-boot.ts", import.meta.url))], {
    env: { ...process.env, HOME: dir, PASEO_HOME: join(dir, "trial"), RECOVERY_ACTION: "resume", RECOVERY_PROJECT: "no", RECOVERY_NO_SPOOL: "yes" }, encoding: "utf8", timeout: 12_000,
  });
  assert.match(output, /RECOVERY_OK/);
  assertSweepHistoryGate(output);
});

test("actual plugin boot registers through legacy server.on/server.before when the host has no addHook", { timeout: 15_000 }, (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/plugin-recovery-boot.ts", import.meta.url))], {
    env: { ...process.env, HOME: dir, PASEO_HOME: join(dir, "trial"), RECOVERY_ACTION: "resume", RECOVERY_PROJECT: "no", RECOVERY_LEGACY_SERVER: "yes" }, encoding: "utf8", timeout: 12_000,
  });
  assert.match(output, /RECOVERY_OK/);
  assertSweepHistoryGate(output);
});

test("actual plugin boot maps legacy rotation_pending to a scheduled context-mark handoff", { timeout: 15_000 }, t => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/plugin-handoff-boot.ts", import.meta.url))], {
    env: { ...process.env, HOME: dir, PASEO_HOME: join(dir, "fake-paseo") }, encoding: "utf8", timeout: 12_000,
  });
  assert.match(output, /LEGACY_HANDOFF_BOOT_OK/);
});
