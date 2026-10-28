import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

test("copied-core check refuses changed, missing and orphan output without modifying the fixture", (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  for (const path of ["scripts", "src", "plugin/server/core"]) mkdirSync(join(dir, path), { recursive: true });
  copyFileSync(join(repoRoot, "scripts/sync-plugin-core.mjs"), join(dir, "scripts/sync-plugin-core.mjs"));
  const source = "export const policy = 1;\n";
  const target = join(dir, "plugin/server/core/policy.ts");
  writeFileSync(join(dir, "src/policy.ts"), source); writeFileSync(target, source);
  const check = () => spawnSync(process.execPath, [join(dir, "scripts/sync-plugin-core.mjs"), "--check"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(check().status, 0);
  writeFileSync(target, "stale copy\n");
  const stale = check(); assert.equal(stale.status, 1); assert.match(stale.stderr, /policy\.ts/);
  assert.equal(readFileSync(target, "utf8"), "stale copy\n");
  rmSync(target);
  assert.equal(check().status, 1); assert.equal(existsSync(target), false);
  writeFileSync(target, source);
  const orphan = join(dir, "plugin/server/core/orphan.ts"); writeFileSync(orphan, "orphan\n");
  const rejected = check(); assert.equal(rejected.status, 1); assert.match(rejected.stderr, /orphan\.ts has no counterpart/);
  assert.equal(readFileSync(orphan, "utf8"), "orphan\n");
  rmSync(orphan); assert.equal(check().status, 0);
});

test("copied-core recursively syncs Scrum modules and diagnoses nested orphans", (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  for (const path of ["scripts", "src/scrum", "plugin/server/core"]) mkdirSync(join(dir, path), { recursive: true });
  copyFileSync(join(repoRoot, "scripts/sync-plugin-core.mjs"), join(dir, "scripts/sync-plugin-core.mjs"));
  writeFileSync(join(dir, "src/scrum/config.ts"), "export const mode = 'scrum';\n");
  const run = (...args: string[]) => spawnSync(process.execPath, [join(dir, "scripts/sync-plugin-core.mjs"), ...args], { encoding: "utf8" });
  assert.equal(run("--check").status, 1);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(dir, "plugin/server/core/scrum/config.ts"), "utf8"), "export const mode = 'scrum';\n");
  writeFileSync(join(dir, "plugin/server/core/scrum/orphan.ts"), "orphan");
  assert.match(run("--check").stderr, /scrum\/orphan.ts has no counterpart/);
});
