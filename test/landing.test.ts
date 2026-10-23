import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/index.ts";
import { disposeDir, factoryErrorCode, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

function landingFixture(t: TestContext) {
  const dir = makeTempDir("factory-landing-");
  disposeDir(t, dir);
  const workspace = join(dir, "repo");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "app.txt"), "before\n");
  writeFileSync(join(workspace, "package.json"), '{"name":"landing-fixture"}\n');
  const base = gitCommitAll(workspace);
  const factory = createFactory({ stateDir: join(dir, "state") });
  const task = "LAND";
  const worktree = join(dir, "worktree");
  execFileSync("git", ["worktree", "add", "-b", `factory/${task}`, worktree, base], { cwd: workspace, stdio: "pipe" });
  factory.setContract({ task, workspace, gate: "true", artifact: "app.txt" });
  assert.equal(factory.requestSpawn({ task, provider: "claude", arity: 1, worktree }).outcome, "dispatched");
  writeFileSync(join(worktree, "app.txt"), "after\n");
  const claimed = gitCommitChanges(worktree, "implement application");
  return { dir, factory, task, workspace, worktree, base, claimed };
}

test("untracked test outputs in root and worktree do not block claim or landing", async (t) => {
  const { factory, task, workspace, worktree, claimed } = landingFixture(t);
  for (const cwd of [workspace, worktree]) {
    for (const name of ["playwright-report", "test-results", "coverage", ".nyc_output", "app-snapshots"]) {
      mkdirSync(join(cwd, name));
      writeFileSync(join(cwd, name, "output.txt"), "test output\n");
    }
  }
  assert.equal((await factory.claim({ task, sha: claimed })).verdict, "green");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(readFileSync(join(workspace, "app.txt"), "utf8"), "after\n");
  assert.equal(existsSync(worktree), false);
});

test("accept retries a pending landing after root cleanup and settles it exactly once", async (t) => {
  const { factory, task, workspace, worktree, claimed } = landingFixture(t);
  assert.equal((await factory.claim({ task, sha: claimed })).verdict, "green");
  writeFileSync(join(workspace, "owner.txt"), "owner edit\n");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "pending-conflict");
  assert.equal(existsSync(worktree), true);
  rmSync(join(workspace, "owner.txt"));
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  const acceptances = factory.ledger.eventsFor(task).filter((e) => e.event === "attempt_accepted");
  assert.deepEqual(acceptances.map((e) => e.landing), ["pending-conflict", "landed"]);
  await assert.rejects(factory.accept({ task, attempt: 1 }), factoryErrorCode("already-accepted"));
  assert.equal(existsSync(worktree), false);
});

test("pending landing retries preserve newer task commits even when the old claim already landed", async (t) => {
  const { factory, task, workspace, worktree, claimed } = landingFixture(t);
  assert.equal((await factory.claim({ task, sha: claimed })).verdict, "green");
  writeFileSync(join(workspace, "owner.txt"), "owner edit\n");
  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "pending-conflict");
  writeFileSync(join(worktree, "followup.txt"), "resolved additional work\n");
  const tip = gitCommitChanges(worktree, "finish conflict repair");
  rmSync(join(workspace, "owner.txt"));
  execFileSync("git", ["merge", "--ff-only", claimed], { cwd: workspace, stdio: "pipe" });

  assert.equal((await factory.accept({ task, attempt: 1 })).landing, "landed");
  assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", tip, "HEAD"], { cwd: workspace }).status, 0);
  assert.equal(readFileSync(join(workspace, "followup.txt"), "utf8"), "resolved additional work\n");
  assert.equal(existsSync(worktree), false);
});
