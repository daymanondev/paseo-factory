import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkProjectResetRepository, resetProjectRepository } from "../plugin/server/project-reset.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The Project reset blast-radius guard (ADR 0045 §1.3, hardened v0.2.3 after
 * the 2026-11-07 incident): the directory-relationship checks compare the
 * target only against the RUNNING plugin's install directory, so the plugin's
 * own source repository — a separate checkout sharing nothing on disk with the
 * install — passed and was wiped. The git-identity check closes that hole:
 * any checkout whose `origin` remote normalizes to the same identity as the
 * running plugin checkout's own `origin` is refused, wherever it lives. Tests
 * build real git repositories in temp directories (remotes are config, never
 * network) and drive the two exported choke points directly.
 */

function gitAt(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** One temp git repository with one commit and (optionally) an `origin` remote. */
function makeRepo(t: TestContext, name: string, origin?: string): string {
  const root = makeTempDir(`project-reset-${name}-`);
  disposeDir(t, root);
  writeFileSync(join(root, "README.md"), `# ${name}\n`);
  gitCommitAll(root, `seed ${name}`);
  if (origin !== undefined) gitAt(root, ["remote", "add", "origin", origin]);
  return root;
}

const PLUGIN_ORIGIN = "git@github.com:daymanondev/paseo-factory.git";

test("the guard refuses the plugin's own source repository cloned at an unrelated path (the 2026-11-07 incident shape)", (t) => {
  const pluginInstall = makeRepo(t, "install", PLUGIN_ORIGIN);
  const ownSource = makeRepo(t, "own-source", PLUGIN_ORIGIN); // a different checkout on disk
  assert.throws(
    () => checkProjectResetRepository(ownSource, pluginInstall),
    /Project reset requires a checkout outside the factory plugin repository — this root is the plugin's own source repository/,
  );
  // The reset path inherits the guard through the same choke point.
  assert.throws(() => resetProjectRepository(ownSource, pluginInstall), /this root is the plugin's own source repository/);
});

test("identity normalization: https vs scp-style ssh, .git suffix, and host case all match the plugin's origin", (t) => {
  const pluginInstall = makeRepo(t, "install-norm", PLUGIN_ORIGIN);
  for (const [label, origin] of [
    ["https with .git and mixed-case host", "https://GitHub.com/daymanondev/paseo-factory.git"],
    ["ssh URL form without .git", "ssh://git@github.com/daymanondev/paseo-factory"],
    ["https with a port and token userinfo", "https://x-token-auth:secret@github.com:443/daymanondev/paseo-factory.git"],
  ] as const) {
    const clone = makeRepo(t, "clone-norm", origin);
    assert.throws(
      () => checkProjectResetRepository(clone, pluginInstall),
      { message: "Project reset requires a checkout outside the factory plugin repository — this root is the plugin's own source repository" },
      `${label} is refused as the plugin's own source`,
    );
  }
});

test("a different remote at the same path stays resettable; a metadata-less install still refuses the canonical source remote", (t) => {
  const pluginInstall = makeRepo(t, "install-ok", PLUGIN_ORIGIN);

  // The same clone, re-pointed at an unrelated remote: the identity guard
  // keys on the remote, not the path, so it becomes an ordinary project.
  const clone = makeRepo(t, "clone-repoint", PLUGIN_ORIGIN);
  assert.throws(() => checkProjectResetRepository(clone, pluginInstall), /this root is the plugin's own source repository/);
  gitAt(clone, ["remote", "set-url", "origin", "https://github.com/someone/else-project.git"]);
  assert.doesNotThrow(() => checkProjectResetRepository(clone, pluginInstall));

  // An unrelated project and a local-path origin (no remote identity) stay
  // resettable under a normal install.
  const otherProject = makeRepo(t, "other", "https://github.com/someone/else-project.git");
  assert.doesNotThrow(() => checkProjectResetRepository(otherProject, pluginInstall));
  const localClone = makeRepo(t, "local-clone", "/tmp/someone/paseo-factory.bundle");
  assert.doesNotThrow(() => checkProjectResetRepository(localClone, pluginInstall));

  // A release/tarball install carries no Git metadata — its identity falls
  // back to the canonical source remote compiled into the plugin, so a clone
  // of the plugin source is STILL refused (the incident hole stays closed
  // for metadata-less installs) while the unrelated project stays allowed.
  const bareInstall = makeTempDir("project-reset-install-bare-");
  disposeDir(t, bareInstall);
  mkdirSync(bareInstall, { recursive: true });
  const ownSource = makeRepo(t, "own-source-bare", "https://github.com/daymanondev/paseo-factory.git");
  assert.throws(() => checkProjectResetRepository(ownSource, bareInstall), /this root is the plugin's own source repository/);
  assert.doesNotThrow(() => checkProjectResetRepository(otherProject, bareInstall));
});

test("the directory-relationship checks still hold: the install itself, a path inside it, and a shared worktree are refused", (t) => {
  const pluginInstall = makeRepo(t, "install-dir", PLUGIN_ORIGIN);

  // The running install itself.
  assert.throws(() => checkProjectResetRepository(pluginInstall, pluginInstall), /outside the factory plugin repository/);

  // A subdirectory of the install resolves to its toplevel.
  const nested = join(pluginInstall, "plugin", "server");
  mkdirSync(nested, { recursive: true });
  assert.throws(() => checkProjectResetRepository(nested, pluginInstall), /outside the factory plugin repository/);

  // A linked worktree shares the common git dir with the install.
  const worktreePath = makeTempDir("project-reset-worktree-");
  disposeDir(t, worktreePath);
  gitAt(pluginInstall, ["worktree", "add", "-q", worktreePath, "-b", "wt-probe"]);
  assert.throws(() => checkProjectResetRepository(worktreePath, pluginInstall), /outside the factory plugin repository/);
});
