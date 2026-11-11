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
