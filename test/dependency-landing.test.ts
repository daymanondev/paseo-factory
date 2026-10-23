import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/index.ts";
import { disposeDir, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

function landingFixture(t: TestContext) {
  const dir = makeTempDir("factory-dependencies-");
  disposeDir(t, dir);
  const workspace = join(dir, "repo");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "package.json"), '{"name":"dependency-fixture"}\n');
  const base = gitCommitAll(workspace);
  const factory = createFactory({ stateDir: join(dir, "state") });
  const task = "DEPS";
  const worktree = join(dir, "worktree");
  execFileSync("git", ["worktree", "add", "-b", `factory/${task}`, worktree, base], { cwd: workspace, stdio: "pipe" });
  factory.setContract({ task, workspace, gate: "true", artifact: "package.json" });
  assert.equal(factory.requestSpawn({ task, provider: "claude", arity: 1, worktree }).outcome, "dispatched");
  writeFileSync(join(worktree, "package.json"), '{"name":"dependency-fixture","dependencies":{"vite":"1.0.0"}}\n');
  const claimed = gitCommitChanges(worktree, "add dependencies");
  return { dir, factory, task, workspace, worktree, claimed };
}

function install(cwd: string, value = "verified dependencies") {
  const deps = join(cwd, "node_modules");
  mkdirSync(deps);
  writeFileSync(join(deps, "sentinel"), value);
  return deps;
}

test("accept hydrates missing root dependencies from the verified real installation before cleanup", async (t) => {
  const { factory, task, workspace, worktree, claimed } = landingFixture(t);
  install(worktree);
  assert.equal((await factory.claim({ task, sha: claimed })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(readFileSync(join(workspace, "node_modules", "sentinel"), "utf8"), "verified dependencies");
  assert.equal(lstatSync(join(workspace, "node_modules")).isSymbolicLink(), false);
  assert.equal(existsSync(worktree), false);
});

test("accept replaces a stale root installation with the verified dependencies", async (t) => {
  const { factory, task, workspace, worktree, claimed } = landingFixture(t);
  const destination = install(workspace, "old dependencies");
  install(worktree);
  utimesSync(destination, new Date(0), new Date(0));
  assert.equal((await factory.claim({ task, sha: claimed })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(readFileSync(join(destination, "sentinel"), "utf8"), "verified dependencies");
  assert.equal(existsSync(worktree), false);
});

test("accept replaces a dangling root dependency symlink", async (t) => {
  const { dir, factory, task, workspace, worktree, claimed } = landingFixture(t);
  symlinkSync(join(dir, "missing-dependencies"), join(workspace, "node_modules"), "dir");
  install(worktree);
  assert.equal((await factory.claim({ task, sha: claimed })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(readFileSync(join(workspace, "node_modules", "sentinel"), "utf8"), "verified dependencies");
  assert.equal(lstatSync(join(workspace, "node_modules")).isSymbolicLink(), false);
});

test("dependency hydration failure retains the verified worktree and acceptance can retry after merge", async (t) => {
  const { factory, task, workspace, worktree, claimed } = landingFixture(t);
  const destination = join(workspace, "node_modules");
  writeFileSync(destination, "obstructed destination");
  install(worktree);
  assert.equal((await factory.claim({ task, sha: claimed })).verdict, "green");
  const pending = await factory.accept({ task, attempt: 1 });
  assert.equal(pending.landing, "pending-conflict");
  assert.match(factory.ledger.eventsFor(task).findLast((event) => event.event === "attempt_accepted")?.landingNote ?? "", /dependency hydration failed.*worktree retained/);
  assert.equal(readFileSync(join(worktree, "node_modules", "sentinel"), "utf8"), "verified dependencies");
  assert.equal(readFileSync(destination, "utf8"), "obstructed destination");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(), claimed);
  rmSync(destination);
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(readFileSync(join(destination, "sentinel"), "utf8"), "verified dependencies");
  assert.equal(existsSync(worktree), false);
});

test("accept replaces only a stale root symlink and preserves its external target", async (t) => {
  const { dir, factory, task, workspace, worktree, claimed } = landingFixture(t);
  const external = join(dir, "external");
  mkdirSync(external);
  const oldDeps = install(external, "external dependencies");
  utimesSync(oldDeps, new Date(0), new Date(0));
  symlinkSync(oldDeps, join(workspace, "node_modules"), "dir");
  install(worktree);
  assert.equal((await factory.claim({ task, sha: claimed })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(lstatSync(join(workspace, "node_modules")).isSymbolicLink(), false);
  assert.equal(readFileSync(join(workspace, "node_modules", "sentinel"), "utf8"), "verified dependencies");
  assert.equal(readFileSync(join(oldDeps, "sentinel"), "utf8"), "external dependencies");
});

test("accept preserves a fresh root installation", async (t) => {
  const { factory, task, workspace, worktree, claimed } = landingFixture(t);
  const destination = install(workspace, "fresh root dependencies");
  install(worktree);
  utimesSync(destination, new Date("2100-01-01"), new Date("2100-01-01"));
  assert.equal((await factory.claim({ task, sha: claimed })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(readFileSync(join(destination, "sentinel"), "utf8"), "fresh root dependencies");
});

test("accept never hydrates an inherited worktree dependency symlink", async (t) => {
  const { factory, task, workspace, worktree, claimed } = landingFixture(t);
  const destination = install(workspace, "shared root dependencies");
  utimesSync(destination, new Date(0), new Date(0));
  symlinkSync(destination, join(worktree, "node_modules"), "dir");
  assert.equal((await factory.claim({ task, sha: claimed })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(readFileSync(join(destination, "sentinel"), "utf8"), "shared root dependencies");
  assert.equal(lstatSync(destination).mtimeMs, 0);
});
