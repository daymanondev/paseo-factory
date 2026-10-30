#!/usr/bin/env node
/**
 * Bump the shipped version across every release-pinned file in lockstep
 * (ADR 0001 / test/release.test.ts) and sync plugin core + policy assets:
 *   - package.json ("version")
 *   - package-lock.json ("version" and packages[""].version)
 *   - plugin/index.server.ts (SHELL_VERSION)
 *   - test/release.test.ts (test title and expected version constant)
 *   - README.md ("**Status: v<version>.**")
 *   - CHANGELOG.md (inserts "## [<version>] - <YYYY-MM-DD>" below "## [Unreleased]" if missing)
 *
 * Usage:
 *   node scripts/bump-version.mjs <x.y.z> [--date YYYY-MM-DD]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const rawVersion = args.find((arg) => !arg.startsWith("--"));
const dateIdx = args.indexOf("--date");
const today =
  dateIdx !== -1 && args[dateIdx + 1]
    ? args[dateIdx + 1]
    : new Date().toISOString().slice(0, 10);

if (!rawVersion) {
  console.error("Usage: node scripts/bump-version.mjs <x.y.z> [--date YYYY-MM-DD]");
  process.exit(1);
}

const version = rawVersion.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid semver "${rawVersion}" — expected x.y.z`);
  process.exit(1);
}

// 1. package.json
const pkgPath = join(repoRoot, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const prevVersion = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// 2. package-lock.json
const lockPath = join(repoRoot, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
lock.version = version;
if (lock.packages && lock.packages[""]) {
  lock.packages[""].version = version;
}
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

// 3. plugin/index.server.ts
const serverPath = join(repoRoot, "plugin", "index.server.ts");
const serverSrc = readFileSync(serverPath, "utf8");
const nextServerSrc = serverSrc.replace(
  /^const SHELL_VERSION = "[^"]+";$/m,
  `const SHELL_VERSION = "${version}";`,
);
if (nextServerSrc === serverSrc && !serverSrc.includes(`const SHELL_VERSION = "${version}";`)) {
  console.error("Failed to update SHELL_VERSION in plugin/index.server.ts");
  process.exit(1);
}
writeFileSync(serverPath, nextServerSrc);

// 4. test/release.test.ts
const releaseTestPath = join(repoRoot, "test", "release.test.ts");
const releaseTestSrc = readFileSync(releaseTestPath, "utf8");
const nextReleaseTestSrc = releaseTestSrc
  .replace(
    /carry \d+\.\d+\.\d+ \(v\d+\.\d+\.\d+\)/,
    `carry ${version} (v${version})`,
  )
  .replace(
    /^(\s*const version = )"\d+\.\d+\.\d+";$/m,
    `$1"${version}";`,
  );
writeFileSync(releaseTestPath, nextReleaseTestSrc);

// 5. README.md
const readmePath = join(repoRoot, "README.md");
const readmeSrc = readFileSync(readmePath, "utf8");
const nextReadmeSrc = readmeSrc.replace(
  /\*\*Status: v\d+\.\d+\.\d+\.\*\*/,
  `**Status: v${version}.**`,
);
writeFileSync(readmePath, nextReadmeSrc);

// 6. CHANGELOG.md
const changelogPath = join(repoRoot, "CHANGELOG.md");
const changelogSrc = readFileSync(changelogPath, "utf8");
const headingRegex = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
if (!headingRegex.test(changelogSrc)) {
  const nextChangelogSrc = changelogSrc.replace(
    /^## \[Unreleased\][ \t]*$/m,
    `## [Unreleased]\n\n## [${version}] - ${today}`,
  );
  writeFileSync(changelogPath, nextChangelogSrc);
}

// 7. Sync plugin core & generated policies
execFileSync(process.execPath, [join(repoRoot, "scripts", "sync-plugin-core.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});
execFileSync(process.execPath, [join(repoRoot, "scripts", "generate-policies.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});

console.log(`bumped version ${prevVersion} -> ${version}`);
