import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffBetween, scopeCoversFile, scopeRecoveryCommands } from "../src/workspace.ts";
import { disposeDir, gitCommitAll, gitCommitChanges, makeTempDir, repoRoot } from "./helpers.ts";

import { scopeCoversFile as shimScopeCoversFile, scopeRecoveryCommands as shimRecoveryCommands } from "../plugin/bin/scope.mjs";

test("scope patterns agree across core, installed shims and Antigravity", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const hookPath = join(dir, "agy-pre-tool-hook.mjs");
  copyFileSync(join(repoRoot, "plugin/bin/agy-pre-tool-hook.mjs"), hookPath);
  const cases: [string[], string, boolean][] = [
    [["tests/e2e/**", "src/*.ts"], "tests/e2e/board.spec.ts", true],
    [["tests/e2e/**"], "tests/e2e/nested/smoke.spec.ts", true],
    [["src/**/*.ts"], "src/main.ts", true],
    [["src/**/*.ts"], "src/deep/nested/main.ts", true],
    [["src/*.ts"], "src/deep/main.ts", false],
    [["src/?.ts"], "src/a.ts", true],
    [["src/?.ts"], "src/ab.ts", false],
    [["src/*.ts"], "src/mainXts", false],
    [["./src/**/*.ts"], "./src/main.ts", true],
    [["src"], "src/main.ts", true],
    [["src/"], "src/main.ts", true],
    [["src"], "src-other/main.ts", false],
    [["package.json"], "package-lock.json", true],
  ];
  for (const [scope, file, expected] of cases) {
    assert.equal(scopeCoversFile(scope, file), expected, `${scope.join(",")} covers ${file}`);
    assert.equal(shimScopeCoversFile(scope, file), expected, `plain-JS shim: ${scope.join(",")} covers ${file}`);
    writeFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ seq: 1, ts: "2026-10-23T00:00:00Z", event: "contract_set", task: "SCOPE", workspace: dir, scope })}\n`);
    const hook = spawnSync(process.execPath, [hookPath], {
      encoding: "utf8", input: JSON.stringify({ tool_name: "write_file", tool_input: { path: file } }),
      env: { ...process.env, PASEO_FACTORY_SEAT: "agent", PASEO_FACTORY_STATE_DIR: dir, PASEO_FACTORY_TASK: "SCOPE", PASEO_FACTORY_PROJECT_ROOT: dir },
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(JSON.parse(hook.stdout).decision, "allow", `Antigravity allows code files inside worktree without scope handcuffs: ${file}`);
  }
  // Memory files remain fenced in Antigravity hook unless explicitly listed in Contract.scope
  writeFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ seq: 1, ts: "2026-10-23T00:00:00Z", event: "contract_set", task: "SCOPE", workspace: dir, scope: ["src"] })}\n`);
  const deniedMemory = spawnSync(process.execPath, [hookPath], {
    encoding: "utf8", input: JSON.stringify({ tool_name: "write_file", tool_input: { path: "AGENTS.md" } }),
    env: { ...process.env, PASEO_FACTORY_SEAT: "agent", PASEO_FACTORY_STATE_DIR: dir, PASEO_FACTORY_TASK: "SCOPE", PASEO_FACTORY_PROJECT_ROOT: dir },
  });
  assert.equal(JSON.parse(deniedMemory.stdout).decision, "deny");
  writeFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ seq: 1, ts: "2026-10-23T00:00:00Z", event: "contract_set", task: "SCOPE", workspace: dir, scope: ["AGENTS.md"] })}\n`);
  const allowedMemory = spawnSync(process.execPath, [hookPath], {
    encoding: "utf8", input: JSON.stringify({ tool_name: "write_file", tool_input: { path: "AGENTS.md" } }),
    env: { ...process.env, PASEO_FACTORY_SEAT: "agent", PASEO_FACTORY_STATE_DIR: dir, PASEO_FACTORY_TASK: "SCOPE", PASEO_FACTORY_PROJECT_ROOT: dir },
  });
  assert.equal(JSON.parse(allowedMemory.stdout).decision, "allow");
});

test("scope recovery commands quote branch bases and file names for both core and installed shim", () => {
  const expected = "git restore --source=abc123 -- README.md; git restore --source=abc123 -- 'a file.txt'";
  assert.equal(scopeRecoveryCommands("abc123", ["README.md", "a file.txt"]), expected);
  assert.equal(shimRecoveryCommands("abc123", ["README.md", "a file.txt"]), expected);
});

test("workspace diffs summarize all files while excluding root and nested package lockfile patches", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "source.ts"), "export const value = 1;\n");
  const base = gitCommitAll(dir);
  for (const lockfile of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "npm-shrinkwrap.json"]) {
    for (const prefix of ["", "nested/"]) writeFileSync(join(dir, prefix + lockfile), "LOCKFILE-PATCH-SENTINEL\n");
  }
  const locks = gitCommitChanges(dir, "lockfiles only");
  writeFileSync(join(dir, "source.ts"), "export const value = 2;\n");
  const claimed = gitCommitChanges(dir, "source change");
  const read = await diffBetween(dir, base, claimed);
  assert.ok(read.ok);
  assert.match(read.diff, /13 files changed/);
  assert.ok(read.diff.indexOf("files changed") < read.diff.indexOf("diff --git"), "summary precedes the patch");
  assert.match(read.diff, /\+export const value = 2/);
  assert.match(read.diff, /nested\/package-lock.json/);
  assert.doesNotMatch(read.diff, /LOCKFILE-PATCH-SENTINEL|diff --git.*(?:lock|shrinkwrap)/);
  const onlyLocks = await diffBetween(dir, base, locks);
  assert.ok(onlyLocks.ok);
  assert.match(onlyLocks.diff, /12 files changed/);
  assert.doesNotMatch(onlyLocks.diff, /diff --git|LOCKFILE-PATCH-SENTINEL/);
  assert.deepEqual(await diffBetween(dir, base, base), { ok: true, diff: "" });
  assert.equal((await diffBetween(dir, base, "missing-ref")).ok, false);
});
