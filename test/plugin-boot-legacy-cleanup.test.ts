import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { disposeDir, makeTempDir } from "./helpers.ts";

/**
 * v0.6.0 boot cleanup (ADR 0056, Seam 3). Booting the real plugin entry over a
 * pre-0.6.0 state directory carries each Project's Open Design link and skill
 * packs into project-settings.json (no execution mode), removes every Scrum
 * artefact, and is safe to run again — including after a crash that wrote the
 * settings record but never removed the legacy record.
 */
function boot(t: Parameters<typeof disposeDir>[0], arm: "fresh" | "crashed") {
  const dir = makeTempDir(); disposeDir(t, dir);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/plugin-boot-legacy-cleanup.ts", import.meta.url))], {
    env: { ...process.env, HOME: dir, PASEO_HOME: join(dir, "trial"), CLEANUP_ARM: arm }, encoding: "utf8", timeout: 12_000,
  });
  const read = (label: string) => JSON.parse(output.match(new RegExp(`^${label}:(.*)$`, "m"))![1]) as {
    machineGone: boolean; projectGone: boolean; betaLegacyGone: boolean; alpha: string | null; beta: string | null;
  };
  return { first: read("BOOT1"), second: read("BOOT2") };
}

test("boot carries Open Design link and skill packs into project-settings.json and removes every Scrum artefact", { timeout: 15_000 }, (t) => {
  const { first } = boot(t, "fresh");
  assert.equal(first.machineGone, true, "machine execution/Scrum lanes/profiles/active profile/switch records are gone");
  assert.equal(first.projectGone, true, "the Project's execution record, Scrum files and scrum/ run directory are gone");
  assert.equal(first.betaLegacyGone, true, "a plain SLP Project's legacy record is retired too");
  const settings = JSON.parse(first.alpha!);
  assert.deepEqual(settings.skillPacks, ["expo", "science"]);
  assert.equal(settings.openDesignLink.projectName, "Checkout Redesign");
  assert.deepEqual(settings.openDesignSource, { kind: "client", requestId: "req-1", acknowledgedRequestId: "req-1" });
  assert.deepEqual(settings.openDesignCheckpointPaths, ["index.html", "open-design-link.json"]);
  assert.equal("mode" in settings, false, "project settings carry no execution mode");
});

test("a second boot changes nothing", { timeout: 15_000 }, (t) => {
  const { first, second } = boot(t, "fresh");
  assert.deepEqual(second, first);
});

test("a crash after the settings write converges on the next boot without rewriting the settings", { timeout: 15_000 }, (t) => {
  const { first, second } = boot(t, "crashed");
  assert.equal(first.projectGone, true);
  assert.equal(first.machineGone, true);
  assert.equal(JSON.parse(first.alpha!).revision, 1, "the already-written settings record stays authoritative");
  assert.deepEqual(second, first);
});
