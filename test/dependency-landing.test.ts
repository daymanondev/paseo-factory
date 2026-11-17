import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory, landTaskWorktree } from "../src/index.ts";
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
  assert.equal((await factory.claim({ task, sha: claimed, handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } })).verdict, "green");
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
  assert.equal((await factory.claim({ task, sha: claimed, handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(readFileSync(join(destination, "sentinel"), "utf8"), "verified dependencies");
  assert.equal(existsSync(worktree), false);
});

test("accept replaces a dangling root dependency symlink", async (t) => {
  const { dir, factory, task, workspace, worktree, claimed } = landingFixture(t);
  symlinkSync(join(dir, "missing-dependencies"), join(workspace, "node_modules"), "dir");
  install(worktree);
  assert.equal((await factory.claim({ task, sha: claimed, handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(readFileSync(join(workspace, "node_modules", "sentinel"), "utf8"), "verified dependencies");
  assert.equal(lstatSync(join(workspace, "node_modules")).isSymbolicLink(), false);
});

test("dependency hydration failure retains the verified worktree and acceptance can retry after merge", async (t) => {
  const { factory, task, workspace, worktree, claimed } = landingFixture(t);
  const destination = join(workspace, "node_modules");
  writeFileSync(destination, "obstructed destination");
  install(worktree);
  assert.equal((await factory.claim({ task, sha: claimed, handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } })).verdict, "green");
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
  assert.equal((await factory.claim({ task, sha: claimed, handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } })).verdict, "green");
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
  assert.equal((await factory.claim({ task, sha: claimed, handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(readFileSync(join(destination, "sentinel"), "utf8"), "fresh root dependencies");
});

test("accept never hydrates an inherited worktree dependency symlink", async (t) => {
  const { factory, task, workspace, worktree, claimed } = landingFixture(t);
  const destination = install(workspace, "shared root dependencies");
  utimesSync(destination, new Date(0), new Date(0));
  symlinkSync(destination, join(worktree, "node_modules"), "dir");
  assert.equal((await factory.claim({ task, sha: claimed, handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(readFileSync(join(destination, "sentinel"), "utf8"), "shared root dependencies");
  assert.equal(lstatSync(destination).mtimeMs, 0);
});

test("accept sweeps stale root and .git dependency staging directories when root node_modules is present", async (t) => {
  const { factory, task, workspace, worktree, claimed } = landingFixture(t);
  install(workspace, "current root dependencies");
  install(worktree, "verified dependencies");
  const rootStale = join(workspace, ".factory-dependencies-stale1");
  mkdirSync(join(rootStale, "previous"), { recursive: true });
  writeFileSync(join(rootStale, "previous", "sentinel"), "stale backup");
  const gitStale = join(workspace, ".git", "factory-dependencies-stale2");
  mkdirSync(join(gitStale, "installation"), { recursive: true });
  writeFileSync(join(gitStale, "installation", "sentinel"), "stale install");

  assert.equal((await factory.claim({ task, sha: claimed, handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(existsSync(rootStale), false);
  assert.equal(existsSync(gitStale), false);
  assert.equal(readdirSync(workspace).some((name) => name.startsWith(".factory-dependencies-")), false);
  assert.equal(readdirSync(join(workspace, ".git")).some((name) => name.startsWith("factory-dependencies-")), false);
  assert.equal(readFileSync(join(workspace, "node_modules", "sentinel"), "utf8"), "verified dependencies");
});

test("cleanup preserves retained previous backup when root node_modules is missing, while untracked staging never blocks landing", async (t) => {
  const { factory, task, workspace, claimed } = landingFixture(t);
  const retained = join(workspace, ".factory-dependencies-keep01");
  mkdirSync(join(retained, "previous"), { recursive: true });
  writeFileSync(join(retained, "previous", "sentinel"), "sole backup");

  assert.equal((await factory.claim({ task, sha: claimed, handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(existsSync(join(retained, "previous", "sentinel")), true);
});

test("landTaskWorktree hydrates dependencies via rev-parse --absolute-git-dir when projectRoot is a linked worktree", async (t) => {
  const dir = makeTempDir("factory-dependencies-linked-");
  disposeDir(t, dir);
  const originRepo = join(dir, "origin-repo");
  mkdirSync(originRepo);
  writeFileSync(join(originRepo, "package.json"), '{"name":"linked-fixture"}\n');
  const base = gitCommitAll(originRepo);
  const linkedCheckout = join(dir, "linked-checkout");
  execFileSync("git", ["worktree", "add", "-b", "main-checkout", linkedCheckout, base], { cwd: originRepo, stdio: "pipe" });
  const task = "LINKEDDEPS";
  const branch = `factory/${task}`;
  const taskWorktree = join(dir, "task-worktree");
  execFileSync("git", ["worktree", "add", "-b", branch, taskWorktree, base], { cwd: linkedCheckout, stdio: "pipe" });
  writeFileSync(join(taskWorktree, "package.json"), '{"name":"linked-fixture","dependencies":{"vite":"1.0.0"}}\n');
  const claimed = gitCommitChanges(taskWorktree, "add linked dependencies");
  install(taskWorktree, "linked verified");

  const landed = await landTaskWorktree({ projectRoot: linkedCheckout, worktree: taskWorktree, claimedCommit: claimed, base, branch });
  assert.equal(landed.landing, "landed");
  assert.equal(readFileSync(join(linkedCheckout, "node_modules", "sentinel"), "utf8"), "linked verified");
  assert.equal(readdirSync(linkedCheckout).some((name) => name.startsWith(".factory-dependencies-")), false);
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: linkedCheckout, encoding: "utf8" }).trim();
  assert.equal(readdirSync(gitDir).some((name) => name.startsWith("factory-dependencies-")), false);
});
