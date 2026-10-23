import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeCoversFile, scopeRecoveryCommands } from "../src/workspace.ts";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

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
    assert.equal(JSON.parse(hook.stdout).decision, expected ? "allow" : "deny", `Antigravity: ${scope.join(",")} covers ${file}`);
  }
});

test("scope recovery commands quote branch bases and file names for both core and installed shim", () => {
  const expected = "git restore --source=abc123 -- README.md; git restore --source=abc123 -- 'a file.txt'";
  assert.equal(scopeRecoveryCommands("abc123", ["README.md", "a file.txt"]), expected);
  assert.equal(shimRecoveryCommands("abc123", ["README.md", "a file.txt"]), expected);
});
