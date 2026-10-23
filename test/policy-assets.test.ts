import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareTaskWorktree as corePrepare } from "../src/workspace.ts";
import { prepareTaskWorktree as installedPrepare } from "../plugin/bin/task-worktree.mjs";
import { disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

test("core and installed driver allocate the same selected runtime files without dirtying Git", (t) => {
  for (const [name, prepare] of [["core", corePrepare], ["installed", installedPrepare]] as const) {
    const dir = makeTempDir();
    disposeDir(t, dir);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "tracked.txt"), "base\n");
    writeFileSync(join(workspace, ".gitignore"), "ignored/\n");
    writeFileSync(join(workspace, ".worktreeinclude"), "# selected runtime files\nruntime/**/*.json\nignored/\n.env?\n");
    const base = gitCommitAll(workspace);
    for (const [file, contents] of [
      ["runtime/config.json", "root match"], ["runtime/deep/config.json", "nested match"],
      ["ignored/token", "ignored directory match"], [".env1", "question match"],
      ["private.txt", "private root"], ["runtime/private.txt", "private nested"], [".env12", "private env"],
    ]) {
      mkdirSync(join(workspace, file, ".."), { recursive: true });
      writeFileSync(join(workspace, file), contents!);
    }
    mkdirSync(join(workspace, "node_modules"));
    writeFileSync(join(workspace, "node_modules/dependency"), "inherited dependency");
    const commonExcludes = readFileSync(join(workspace, ".git/info/exclude"), "utf8");
    const prepared = prepare({ stateDir: join(dir, "state"), workspace, task: "POLICY", base });
    assert.ok(prepared.ok, name);
    if (!prepared.ok) continue;
    for (const file of ["runtime/config.json", "runtime/deep/config.json", "ignored/token", ".env1", "node_modules/dependency"]) {
      assert.equal(existsSync(join(prepared.path, file)), true, `${name} includes ${file}`);
    }
    for (const file of ["private.txt", "runtime/private.txt", ".env12"]) {
      assert.equal(existsSync(join(prepared.path, file)), false, `${name} omits ${file}`);
    }
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: prepared.path, encoding: "utf8" }), "");
    assert.equal(readFileSync(join(workspace, ".git/info/exclude"), "utf8"), commonExcludes);
  }
});

test("policy generation is byte-stable, checks stale output without rewriting, and repairs it", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  cpSync(join(repoRoot, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(repoRoot, "plugin/bin"), join(dir, "plugin/bin"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  cpSync(join(repoRoot, "scripts/generate-policies.mjs"), join(dir, "scripts/generate-policies.mjs"));
  // Only the development generator sees esbuild; installed outputs run without it.
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
  const run = (check = false) => spawnSync(process.execPath, [join(dir, "scripts/generate-policies.mjs"), ...(check ? ["--check"] : [])], { encoding: "utf8", timeout: 30_000 });
  const initialCheck = run(true);
  assert.equal(initialCheck.status, 0, initialCheck.stderr);
  const files = ["scope.mjs", "ledger-read.mjs", "worktree-policy.mjs", "process-policy.mjs", "bridge.mjs", "agy-pre-tool-hook.mjs"];
  const before = files.map((file) => readFileSync(join(dir, "plugin/bin", file), "utf8"));
  assert.equal(run().status, 0);
  assert.deepEqual(files.map((file) => readFileSync(join(dir, "plugin/bin", file), "utf8")), before);
  const stale = join(dir, "plugin/bin/scope.mjs");
  writeFileSync(stale, `${before[0]}\n// simulated stale output\n`);
  const damaged = readFileSync(stale, "utf8");
  const checked = run(true);
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /stale generated policy assets.*scope\.mjs/);
  assert.equal(readFileSync(stale, "utf8"), damaged);
  assert.equal(run().status, 0);
  assert.equal(run(true).status, 0);
  assert.deepEqual(files.map((file) => readFileSync(join(dir, "plugin/bin", file), "utf8")), before);
  rmSync(join(dir, "node_modules"));
  rmSync(join(dir, "src"), { recursive: true });
  const urls: string[] = [];
  for (const file of ["scope.mjs", "ledger-read.mjs", "worktree-policy.mjs", "process-policy.mjs"]) {
    const single = join(dir, "single-assets", file);
    mkdirSync(single, { recursive: true });
    cpSync(join(dir, "plugin/bin", file), join(single, "asset.mjs"));
    urls.push(pathToFileURL(join(single, "asset.mjs")).href);
  }
  const script = `
    const [scope, ledger, worktree, outcome] = await Promise.all(${JSON.stringify(urls)}.map(url => import(url)));
    if (!scope.scopeCoversFile(["src/**/*.ts"], "src/foo.ts")) process.exit(1);
    if (!ledger.readLedgerEvents(${JSON.stringify(join(dir, "absent-ledger"))}).missing) process.exit(1);
    if (!worktree.worktreeIncludeMatches("runtime/**/*.json", "runtime/nested/config.json")) process.exit(1);
    const {spawn} = await import("node:child_process");
    outcome.inheritChildOutcome(spawn(process.execPath, ["-e", "process.exit(7)"]), error => console.error(error));
  `;
  const installed = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(installed.status, 7, installed.stderr);
});
