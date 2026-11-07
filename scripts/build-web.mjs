#!/usr/bin/env node
/**
 * The Web Console's build law (ADR 0051 §2): the production bundle is a
 * committed, generated artifact inside `plugin/web/` — exactly like
 * `generate:policies`. Development/release generation only; plugin
 * installation never runs a build.
 *
 *   node scripts/build-web.mjs          regenerate `plugin/web/`
 *   node scripts/build-web.mjs --check  fail (exit 1) when the committed bundle is stale
 *
 * The check builds to a temp directory and compares file-by-file, so a
 * hand-edited or drifted bundle fails `npm run check` by name.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
const webRoot = join(repoRoot, "web");
const outDir = join(repoRoot, "plugin", "web");
const config = join(webRoot, "vite.config.ts");

// The type gate rides the build: a bundle is only "fresh" when its sources
// typecheck under the web tsconfig (the root `tsc --noEmit` intentionally
// covers src/, plugin/, and test/ only — the RN client's maintenance-mode
// law — so this is the console's own typecheck).
const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tsc, "-p", join(webRoot, "tsconfig.json")], { stdio: "inherit" });

const { build } = await import("vite");
const target = check ? realpathSync(mkdtempSync(join(tmpdir(), "factory-web-check-"))) : outDir;
await build({ configFile: config, root: webRoot, build: { outDir: target } });

function filesUnder(dir, prefix = "") {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesUnder(join(dir, entry.name), relative));
    else found.push(relative);
  }
  return found.sort();
}

if (check) {
  const committed = filesUnder(outDir);
  const generated = filesUnder(target);
  const stale = [];
  for (const file of new Set([...committed, ...generated])) {
    const inCommitted = committed.includes(file);
    const inGenerated = generated.includes(file);
    if (inCommitted && !inGenerated) stale.push(`${file}: committed but no longer generated`);
    else if (!inCommitted && inGenerated) stale.push(`${file}: generated but not committed`);
    else if (readFileSync(join(outDir, file)).toString("utf8") !== readFileSync(join(target, file)).toString("utf8")) stale.push(`${file}: content differs`);
  }
  rmSync(target, { recursive: true, force: true });
  if (stale.length > 0) {
    console.error(`stale Web Console bundle (run \`npm run build:web\` and commit):\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  console.log("committed Web Console bundle in sync");
} else {
  console.log(`Web Console bundle generated in ${join("plugin", "web")}`);
}
