import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeCoversFile, scopeRecoveryCommands } from "../src/workspace.ts";

import { scopeCoversFile as shimScopeCoversFile, scopeRecoveryCommands as shimRecoveryCommands } from "../plugin/bin/scope.mjs";

test("scope patterns cover globbed paths while keeping literal prefixes and segment boundaries", () => {
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
  }
});

test("scope recovery commands quote branch bases and file names for both core and installed shim", () => {
  const expected = "git restore --source=abc123 -- README.md; git restore --source=abc123 -- 'a file.txt'";
  assert.equal(scopeRecoveryCommands("abc123", ["README.md", "a file.txt"]), expected);
  assert.equal(shimRecoveryCommands("abc123", ["README.md", "a file.txt"]), expected);
});
