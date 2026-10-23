import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/factory.ts";
import { disposeDir, factoryErrorCode, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

test("Contract registration refuses escaping Artifact paths before an untrusted Gate can run", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
  gitCommitAll(workspace);
  const outside = join(dir, "outside.txt");
  writeFileSync(outside, "external evidence\n");
  const marker = join(dir, "gate-ran");
  const factory = createFactory({ stateDir: join(dir, "state") });

  for (const artifact of ["../outside.txt", outside, "nested/../../outside.txt"]) {
    assert.throws(
      () => factory.setContract({ task: "ESCAPE", workspace, artifact, gate: `touch '${marker}'` }),
      factoryErrorCode("invalid-contract"),
      `Artifact ${artifact} must be refused at registration`,
    );
  }
  assert.equal(factory.contractFor("ESCAPE"), undefined);
  assert.equal(existsSync(marker), false);
});

test("Claim checks nested Artifacts, missing targets and directory symlinks against the execution Workspace", async (t) => {
  for (const [artifact, verdict] of [
    ["nested/artifact.txt", "green"],
    ["internal-link/artifact.txt", "green"],
    ["external-link/artifact.txt", "red"],
    ["external-link", "red"],
    ["missing.txt", "red"],
    ["dangling-link", "red"],
  ] as const) {
    await t.test(artifact, async (t) => {
      const dir = makeTempDir();
      disposeDir(t, dir);
      const workspace = join(dir, "workspace");
      mkdirSync(join(workspace, "nested"), { recursive: true });
      writeFileSync(join(workspace, "nested/artifact.txt"), "local evidence\n");
      // A similar prefix is still outside: workspace-neighbor is no descendant.
      const outside = join(dir, "workspace-neighbor");
      mkdirSync(outside);
      writeFileSync(join(outside, "artifact.txt"), "external evidence\n");
      symlinkSync("nested", join(workspace, "internal-link"));
      symlinkSync(outside, join(workspace, "external-link"));
      symlinkSync(join(dir, "absent"), join(workspace, "dangling-link"));
      const sha = gitCommitAll(workspace);
      const factory = createFactory({ stateDir: join(dir, "state") });
      factory.setContract({ task: "ARTIFACT", workspace, artifact, gate: "true" });

      assert.equal((await factory.claim({ task: "ARTIFACT", sha })).verdict, verdict);
    });
  }
});

test("Claim inspects the Artifact produced by the Gate at completion", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, ".gitignore"), "evidence/\n");
  const sha = gitCommitAll(workspace);
  const outside = join(dir, "outside.txt");
  writeFileSync(outside, "external evidence\n");
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({
    task: "GENERATED", workspace, artifact: "evidence/artifact.txt",
    gate: `mkdir evidence && ln -s '${outside}' evidence/artifact.txt`,
  });

  assert.equal((await factory.claim({ task: "GENERATED", sha })).verdict, "red");
  const gate = factory.ledger.eventsFor("GENERATED").find((event) => event.event === "gate_finished");
  assert.ok(gate?.event === "gate_finished");
  assert.match(gate.note, /artifact.*outside.*Workspace/i);
});

test("managed Claims contain Artifacts in the Task worktree rather than the Project checkout", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "root-only.txt"), "Project evidence\n");
  const base = gitCommitAll(workspace);
  const worktree = join(dir, "task-worktree");
  execFileSync("git", ["worktree", "add", "-q", "-b", "factory/ARTIFACT", worktree, base], { cwd: workspace });
  execFileSync("git", ["rm", "-q", "root-only.txt"], { cwd: worktree });
  mkdirSync(join(worktree, "nested"));
  writeFileSync(join(worktree, "nested/artifact.txt"), "Task evidence\n");
  symlinkSync(join(workspace, "root-only.txt"), join(worktree, "root-link.txt"));
  const sha = gitCommitChanges(worktree, "Task artifacts");
  const factory = createFactory({ stateDir: join(dir, "state") });
  for (const [artifact, verdict] of [
    ["root-link.txt", "red"],
    ["root-only.txt", "red"],
    ["nested/artifact.txt", "green"],
  ] as const) {
    factory.setContract({ task: "ARTIFACT", workspace, artifact, gate: "true" });
    assert.equal(factory.requestSpawn({ task: "ARTIFACT", provider: "claude", arity: 1, worktree }).outcome, "dispatched");
    assert.equal((await factory.claim({ task: "ARTIFACT", sha })).verdict, verdict, artifact);
  }
});

test("Claim rejects an Artifact whose symlink resolves to an external file", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const outside = join(dir, "outside.txt");
  writeFileSync(outside, "external evidence\n");
  symlinkSync(outside, join(workspace, "artifact.txt"));
  const sha = gitCommitAll(workspace);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "SYMLINK", workspace, artifact: "artifact.txt", gate: "true" });

  const result = await factory.claim({ task: "SYMLINK", sha });

  assert.equal(result.verdict, "red");
  const gate = factory.ledger.eventsFor("SYMLINK").find((event) => event.event === "gate_finished");
  assert.ok(gate?.event === "gate_finished");
  assert.match(gate.note, /artifact.*outside.*Workspace/i);
});
