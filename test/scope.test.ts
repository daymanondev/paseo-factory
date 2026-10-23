import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeCoversFile } from "../src/workspace.ts";

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
  }
});
