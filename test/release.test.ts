import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./helpers.ts";

/**
 * Release invariants (v0.0.17): the shipped version is carried in lockstep by
 * every version field the repo owns — `package.json`, both `package-lock.json`
 * version spots, and `SHELL_VERSION` in `plugin/index.server.ts` (the startup
 * banner's `[paseo-factory] up v<version>`) — and `CHANGELOG.md` opens a
 * `## [<version>] - <date>` entry for it. The v0.0.12 close proved the drift
 * is real (the lock rode a different PR than the manifest); this pins it.
 */
test("release invariants: package.json, package-lock.json, SHELL_VERSION, and the CHANGELOG heading all carry 0.0.17 (v0.0.17)", () => {
  const version = "0.0.17";

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
  assert.equal(pkg.version, version);

  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  assert.equal(lock.version, version, "package-lock.json top-level version");
  assert.equal(lock.packages[""]?.version, version, 'package-lock.json packages[""] version');

  const server = readFileSync(join(repoRoot, "plugin", "index.server.ts"), "utf8");
  const shellVersion = /^const SHELL_VERSION = "(.+)";$/m.exec(server)?.[1];
  assert.ok(shellVersion, "plugin/index.server.ts declares SHELL_VERSION");
  assert.equal(shellVersion, version);

  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`^## \\[${version}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"));
});
