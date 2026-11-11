import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createSurfaceHandlers, registerSurfaceRpc } from "../plugin/server/surface-rpc.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

/**
 * v0.6.0 W1 (ADR 0056): the Web Console's console-only doors are gone. A
 * method nobody registers answers with the daemon's standard unknown-method
 * failure, so the proof is that the surface registers no such name and the
 * handler set carries no such entry. `factory console` likewise falls into the
 * CLI's ordinary unknown-command refusal.
 */

function registeredMethods(t: import("node:test").TestContext): string[] {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const handlers = createSurfaceHandlers({ factory, stateDir, home, daemon: {} as never });
  const names: string[] = [];
  const server = { handle: (rpc: { name: string }) => { names.push(rpc.name); } };
  registerSurfaceRpc(server as never, handlers);
  return names;
}

test("the surface registers no console-only door (agent.transcript, inbox)", (t) => {
  const names = registeredMethods(t);
  assert.ok(names.includes("factory.snapshot"), "the live surface door is still registered");
  assert.equal(names.includes("factory.agent.transcript"), false);
  assert.equal(names.includes("factory.inbox"), false);
});

test("`factory console` is an unknown command", (t) => {
  const home = makeTempDir();
  disposeDir(t, home);
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "..", "plugin", "bin", "factory.mjs"), "--home", home, "console"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command/i);
  const help = execFileSync(process.execPath, [join(import.meta.dirname, "..", "plugin", "bin", "factory.mjs"), "help"], { encoding: "utf8" });
  assert.doesNotMatch(help, /Web Console|Console sidecar/);
});

test("v0.6.0 W4: the Retro, task-detail, accept and host-folder-picker doors are not registered — the daemon answers them with the unknown-method failure", (t) => {
  const names = registeredMethods(t);
  for (const gone of ["factory.retro", "factory.retro.ratify", "factory.accept", "factory.task.detail", "factory.project.pick.folder"]) {
    assert.equal(names.includes(gone), false, `${gone} must not be registered`);
  }
  for (const kept of ["factory.snapshot", "factory.lead.rotate", "factory.supervisor.revoke", "factory.project.reset", "factory.project.delete", "factory.lanes.set"]) {
    assert.ok(names.includes(kept), `${kept} stays registered`);
  }
});

test("v0.6.0 W6: Start Supervisor is a registered door — and the surface still has no Lead-start or accept door for the Owner's UI", (t) => {
  const names = registeredMethods(t);
  assert.ok(names.includes("factory.supervisor.start"), "the vacant Supervisor row's Start Supervisor door");
  for (const kept of ["factory.lead.rotate", "factory.supervisor.revoke", "factory.project.reset", "factory.project.delete", "factory.lanes.set", "factory.skills.toggle_pack", "factory.open_design.unlink", "factory.open_design.sync"]) {
    assert.ok(names.includes(kept), `${kept} stays registered`);
  }
  assert.equal(names.includes("factory.lead.start"), false);
  assert.equal(names.includes("factory.accept"), false);
});

test("v0.6.0 W4: `factory retro` is an unknown command and the help no longer advertises the Retro", (t) => {
  const home = makeTempDir();
  disposeDir(t, home);
  const bin = join(import.meta.dirname, "..", "plugin", "bin", "factory.mjs");
  const result = spawnSync(process.execPath, [bin, "--home", home, "retro"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command/i);
  const help = execFileSync(process.execPath, [bin, "help"], { encoding: "utf8" });
  assert.doesNotMatch(help, /\bretro\b/i);
});

test("v0.6.0 W4: the handler set carries no Retro / ratify / accept / task-detail / folder-picker entry", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const handlers = createSurfaceHandlers({ factory, stateDir, home, daemon: {} as never }) as unknown as Record<string, unknown>;
  for (const gone of ["retro", "ratifyProposal", "accept", "taskDetail", "projectPickFolder"]) {
    assert.equal(gone in handlers, false, `handlers.${gone} must be gone`);
  }
});
