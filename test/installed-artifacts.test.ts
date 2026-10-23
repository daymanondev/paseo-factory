import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

function installedFixture(t: TestContext) {
  const dir = realpathSync(makeTempDir());
  disposeDir(t, dir);
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "plugin/server"), { recursive: true });
  copyFileSync(join(repoRoot, "scripts/check-bundle.mjs"), join(dir, "scripts/check-bundle.mjs"));
  // Compiler tools belong to the checker. Its separately copied plugin has
  // no node_modules or repository dependency ancestors.
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "plugin/index.server.ts"), "export const server = 1;\n");
  writeFileSync(join(dir, "plugin/index.client.tsx"), "export const client = 1;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "scripts", "plugin");
  const write = (file: string, body: string) => writeFileSync(join(dir, file), body);
  const check = () => spawnSync(process.execPath, [join(dir, "scripts/check-bundle.mjs")], { encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_PATH: "" } });
  return { dir, git, write, check };
}

test("installed bundles require tracked modules and accept staged additions", (t) => {
  const fixture = installedFixture(t);
  const baseline = fixture.check();
  assert.equal(baseline.status, 0, baseline.stderr);
  fixture.write("plugin/server/helper.ts", "export const value = 7;\n");
  fixture.write("plugin/index.server.ts", 'export {value} from "./server/helper.ts";\n');
  const untracked = fixture.check();
  assert.equal(untracked.status, 1, "a clean checkout cannot ship an untracked required module");
  assert.match(untracked.stderr, /Could not resolve.*helper\.ts/);
  fixture.git("add", "plugin/server/helper.ts");
  const staged = fixture.check();
  assert.equal(staged.status, 0, staged.stderr);
});

test("installed modules cannot import existing files outside the plugin", (t) => {
  const fixture = installedFixture(t);
  fixture.write("outside.ts", "export const value = 17;\n");
  for (const specifier of [`../${basename(fixture.dir)}/outside.ts`, join(fixture.dir, "outside.ts")]) {
    fixture.write("plugin/index.server.ts", `export {value} from ${JSON.stringify(specifier)};\n`);
    const escaped = fixture.check();
    assert.equal(escaped.status, 1, `outside import ${specifier} must fail independently of whether its target exists`);
    assert.match(escaped.stderr, /outside.*plugin|escapes.*plugin/i);
  }
});

test("tracked symlinks cannot disguise external code as shipped plugin contents", (t) => {
  const fixture = installedFixture(t);
  fixture.write("outside.ts", "export const value = 23;\n");
  symlinkSync(join(fixture.dir, "outside.ts"), join(fixture.dir, "plugin/server/linked.ts"));
  fixture.git("add", "plugin/server/linked.ts");
  fixture.write("plugin/index.server.ts", 'export {value} from "./server/linked.ts";\n');
  const escaped = fixture.check();
  assert.equal(escaped.status, 1, "copying a symlink must not turn its external target into an installed file");
  assert.match(escaped.stderr, /outside.*plugin|escapes.*plugin/i);
  rmSync(join(fixture.dir, "plugin/server/linked.ts"));
  fixture.write("plugin/server/local.ts", "export const value = 23;\n");
  symlinkSync("local.ts", join(fixture.dir, "plugin/server/linked.ts"));
  fixture.git("add", "plugin/server");
  const contained = fixture.check();
  assert.equal(contained.status, 0, contained.stderr);
});

for (const dependency of [
  { name: "runtime", body: 'import {version} from "typescript"; export const server = version;\n', error: /Could not resolve "typescript"/ },
  { name: "type-only", body: 'import type {CompilerOptions} from "typescript"; export const server: CompilerOptions = {};\n', error: /Could not resolve type dependency "typescript"/ },
]) {
  test(`isolated ${dependency.name} dependencies cannot resolve from development node_modules`, (t) => {
    const fixture = installedFixture(t);
    fixture.write("plugin/index.server.ts", dependency.body);
    const rejected = fixture.check();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, dependency.error);
  });
}

for (const boundary of [
  { name: "client Node builtin", file: "plugin/index.client.tsx", body: 'export {readFileSync as client} from "node:fs";\n', error: /Node module cannot be imported into the plugin client/ },
  { name: "server client-only SDK", file: "plugin/index.server.ts", body: 'export {useRpc as server} from "@getpaseo/plugin/client";\n', error: /client-only module cannot be imported into the plugin server/ },
  { name: "client server-only module", file: "plugin/index.client.tsx", body: 'export {server as client} from "./server/only.ts";\n', error: /server-only module cannot be imported into the plugin client/ },
  { name: "Hermes class", file: "plugin/index.client.tsx", body: 'export class Client { value = 1; }\n', error: /class Client reaches the client bundle/ },
]) {
  test(`installed compiler rejects ${boundary.name}`, (t) => {
    const fixture = installedFixture(t);
    fixture.write("plugin/server/only.ts", "export const server = 1;\n");
    fixture.git("add", "plugin/server/only.ts");
    fixture.write(boundary.file, boundary.body);
    const rejected = fixture.check();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, boundary.error);
  });
}

test("typecheck checks canonical policy bodies even when declarations describe the intended API", (t) => {
  const fixture = installedFixture(t);
  copyFileSync(join(repoRoot, "tsconfig.json"), join(fixture.dir, "tsconfig.json"));
  mkdirSync(join(fixture.dir, "src"));
  fixture.write("src/policy.d.ts", "export declare function policy(): boolean;\n");
  fixture.write("src/policy.ts", 'export function policy(): boolean { return "unchecked implementation"; }\n');
  const checked = spawnSync(process.execPath, [join(repoRoot, "node_modules/typescript/bin/tsc"), "--noEmit", "--project", fixture.dir], { encoding: "utf8", timeout: 30_000 });
  assert.equal(checked.status, 2);
  assert.match(checked.stdout, /src\/policy\.ts.*TS2322/);
});
