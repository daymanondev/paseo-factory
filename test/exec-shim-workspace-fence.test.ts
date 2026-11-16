import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

function fixture(t: TestContext) {
  const dir = makeTempDir("workspace-fence-");
  disposeDir(t, dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "paseo"), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(7);\n`, { mode: 0o755 });
  return (args: string[], seat = "peer", correlation = "") => spawnSync(process.execPath,
    [join(repoRoot, "plugin/bin/exec-shim.mjs"), "paseo", ...args], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, PATH: bin, HOME: dir, FACTORY_STATE_DIR: join(dir, "state"),
        PASEO_FACTORY_STATE_DIR: join(dir, "state"), PASEO_FACTORY_SEAT: seat, PASEO_FACTORY_CORRELATION: correlation },
    });
}

test("workspace mutations and unknown verbs are refused before spawning Paseo", (t) => {
  const run = fixture(t);
  for (const verb of ["create", "setup", "archive", "delete", "remove", "rename", "future-verb", ""]) {
    for (const [seat, correlation] of [["peer", ""], ["lead", ""], ["supervisor", ""], ["", "task-19"]]) {
      const result = run(["workspace", ...(verb ? [verb] : [])], seat, correlation);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 126, verb);
      assert.match(result.stderr, /seat-paseo-workspace-fence/);
      assert.equal(result.stdout, "", "real binary must never start");
    }
  }
});

test("workspace reads pass through with exact arguments and child outcome", (t) => {
  const run = fixture(t);
  for (const verb of ["ls", "list", "inspect", "show", "status"]) {
    const args = ["--home", "/fake/home", "workspace", verb, "--json", "id with spaces"];
    const result = run(args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 7);
    assert.deepEqual(JSON.parse(result.stdout), args);
    assert.equal(result.stderr, "");
  }
});

test("global flags cannot hide workspace mutations and existing fences remain", (t) => {
  const run = fixture(t);
  for (const args of [["--home", "/fake", "workspace", "create"], ["--profile=demo", "workspace", "rename"], ["workspace", "--json", "archive"]]) {
    const result = run(args);
    assert.equal(result.status, 126);
    assert.match(result.stderr, /seat-paseo-workspace-fence/);
    assert.equal(result.stdout, "");
  }
  for (const sub of ["agent", "agents", "plugin", "plugins"]) {
    const result = run([sub, "list"]);
    assert.equal(result.status, 126);
    assert.match(result.stderr, /seat-paseo-tool-fence/);
  }
});

test("non-workspace commands and invocations outside Factory seats remain unchanged", (t) => {
  const run = fixture(t);
  for (const [args, seat] of [[["status"], "peer"], [["workspace", "create"], ""]] as const) {
    const result = run([...args], seat);
    assert.equal(result.status, 7);
    assert.deepEqual(JSON.parse(result.stdout), args);
    assert.equal(result.stderr, "");
  }
});
