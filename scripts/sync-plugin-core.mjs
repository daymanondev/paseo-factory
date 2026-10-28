#!/usr/bin/env node
/**
 * Sync the pure core (src/) into plugin/server/core/ — a verbatim copy the
 * daemon compiles inside the plugin boundary. The daemon's plugin compiler
 * rejects imports from outside the plugin directory, so the shell vendors the
 * core; test/shell.test.ts fails if the copy ever drifts from src/.
 *
 * Usage:
 *   node scripts/sync-plugin-core.mjs          copy (add/overwrite)
 *   node scripts/sync-plugin-core.mjs --check  exit 1 if out of sync, copy nothing
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(repoRoot, "src");
const coreDir = join(repoRoot, "plugin", "server", "core");
const check = process.argv.includes("--check");

if (!check) mkdirSync(coreDir, { recursive: true });

function modules(root, prefix = "") {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? modules(join(root, entry.name), name + "/") : entry.isFile() && name.endsWith(".ts") ? [name] : [];
  }).sort();
}
const sources = modules(srcDir);
const copies = modules(coreDir);
const problems = [];

for (const name of sources) {
  const source = readFileSync(join(srcDir, name), "utf8");
  const target = join(coreDir, name);
  if (!existsSync(target) || readFileSync(target, "utf8") !== source) {
    problems.push(name);
    if (!check) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source); }
  }
}

for (const name of copies) {
  if (!sources.includes(name)) problems.push(`plugin/server/core/${name} has no counterpart in src/`);
}

if (problems.length > 0) {
  console.error(`plugin core out of sync with src/: ${problems.join(", ")}`);
  console.error(check ? "run: npm run sync:plugin-core" : "synced now — commit the updated copy");
  process.exit(check ? 1 : 0);
}

console.log(`plugin core in sync (${sources.length} files)`);
