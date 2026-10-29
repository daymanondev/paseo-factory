import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";

/** Validate before retiring seats or purging metadata. */
export function checkProjectResetRepository(root: string, pluginDir?: string): void {
  if (!existsSync(root)) return;
  let top: string;
  try { top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim(); }
  catch { return; }
  const realRoot = realpathSync(root);
  const ownCheckout = pluginDir !== undefined && existsSync(pluginDir) ? realpathSync(pluginDir) : undefined;
  const commonDir = (cwd: string): string => realpathSync(resolve(cwd, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim()));
  let sharesPluginRepository = false;
  if (ownCheckout !== undefined) {
    try { sharesPluginRepository = commonDir(root) === commonDir(ownCheckout); } catch { /* plugin installs may have no Git metadata */ }
  }
  if (realRoot !== realpathSync(top) || ownCheckout === realRoot || ownCheckout?.startsWith(`${realRoot}/`) || sharesPluginRepository) {
    throw new Error("Project reset requires a checkout outside the factory plugin repository");
  }
}

/** Reset only an independent Project checkout, never the running plugin's repository. */
export function resetProjectRepository(root: string, pluginDir?: string): void {
  checkProjectResetRepository(root, pluginDir);
  if (!existsSync(join(root, ".git"))) return;
  const git = (args: string[], env = process.env) => execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
  const preserved = new Set([".git", ".gitignore", ".worktreeinclude", ".agents", ".claude"]);
  const index = join(git(["rev-parse", "--absolute-git-dir"]), `factory-reset-${process.pid}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "Factory", GIT_AUTHOR_EMAIL: "factory@localhost", GIT_COMMITTER_NAME: "Factory", GIT_COMMITTER_EMAIL: "factory@localhost" };
  try {
    git(["read-tree", "--empty"], env);
    for (const path of preserved) {
      if (path !== ".git" && existsSync(join(root, path))) git(["add", "-f", "--", path], env);
    }
    const tree = git(["write-tree"], env);
    const commit = git(["commit-tree", tree, "-m", "Initial Project"], env);
    git(["update-ref", "HEAD", commit, git(["rev-parse", "HEAD"])]);
    for (const entry of readdirSync(root)) {
      if (!preserved.has(entry)) rmSync(join(root, entry), { recursive: true, force: true });
    }
    git(["read-tree", "--reset", "-u", "HEAD"]);
  } finally { rmSync(index, { force: true }); }
}
