import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";

/**
 * The one directory a Project reset/delete may touch (v0.0.89, ADR 0045 §1.3):
 * `<stateDir>/projects/<slug>/` — that Project's isolated ledger, reports,
 * gate logs, retro files, mailbox, worktrees, and registration. A sibling
 * Project's directory — and the root state directory — are never named, so
 * the blast radius of a reset or delete is exactly one Project, including a
 * Project marked `missingRoot` (its registration still points here).
 */
export function removeProjectStateDirectory(stateDir: string, slug: string): boolean {
  // A slug names one directory — never a path separator, a dot segment, or a
  // traversal. Project basenames may carry spaces and unicode; those stay.
  if (typeof slug !== "string" || slug === "" || slug === "." || slug === ".." || slug.includes("/")) return false;
  const projectDir = join(stateDir, "projects", slug);
  if (!existsSync(projectDir)) return false;
  rmSync(projectDir, { recursive: true, force: true });
  return true;
}

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
  // The 2026-11-07 incident guard (v0.2.3): the directory checks above compare
  // the target only against the RUNNING plugin's install directory, so the
  // plugin's own source repository — a different checkout on disk — passed and
  // was wiped. Identity closes that hole: any clone of the same remote as the
  // running plugin checkout is the plugin's own source, wherever it lives. An
  // install with no Git metadata (a release/tarball directory install) falls
  // back to the canonical source identity compiled in below.
  if (ownCheckout !== undefined) {
    const ownIdentity = remoteIdentityAt(ownCheckout) ?? PLUGIN_SOURCE_IDENTITY;
    if (ownIdentity === remoteIdentityAt(realRoot)) {
      throw new Error("Project reset requires a checkout outside the factory plugin repository — this root is the plugin's own source repository");
    }
  }
}

/**
 * The plugin's own canonical source repository — the identity fallback for a
 * running install that carries no Git metadata (a release/tarball directory
 * install has no `origin` to read). The source repo is a fact of the
 * codebase, so its identity is compiled in rather than derived from the
 * install layout.
 */
const PLUGIN_SOURCE_IDENTITY = "github.com/daymanondev/paseo-factory";

/**
 * Normalizes one git remote URL for identity comparison: scheme, userinfo,
 * port, and a trailing `.git` suffix are stripped and the host is lowercased,
 * so `https://GitHub.com/o/repo.git`, `git@github.com:o/repo`, and
 * `ssh://git@github.com/o/repo` all normalize to `github.com/o/repo`. A URL
 * with no host (a local path or `file://` remote) normalizes to undefined —
 * never a match: same-path relationships are the directory checks' job, and a
 * local-file "identity" would refuse unrelated projects that cloned from the
 * same local bundle.
 */
function normalizeRemoteIdentity(url: string): string | undefined {
  let rest = url.trim();
  if (rest === "") return undefined;
  const schemed = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(rest);
  if (schemed !== null) {
    if (schemed[1]!.toLowerCase() === "file") return undefined;
    rest = schemed[2]!;
  } else {
    const scp = /^([^/@:\s]+)@([^/:@\s]+):(.+)$/.exec(rest);
    if (scp === null) return undefined; // a bare local path — no remote identity
    rest = `${scp[2]}/${scp[3]}`;
  }
  const at = rest.indexOf("@");
  if (at !== -1) rest = rest.slice(at + 1); // identity is host+path, not credentials
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).replace(/:\d+$/, "").toLowerCase();
  if (host === "") return undefined;
  const path = slash === -1 ? "" : rest.slice(slash + 1).replace(/\/+$/, "");
  const cleanPath = path.endsWith(".git") ? path.slice(0, -4) : path;
  return cleanPath === "" ? host : `${host}/${cleanPath}`;
}

/** The first remote identity of the checkout at `cwd` — `origin`'s push URL, then its fetch URL. */
function remoteIdentityAt(cwd: string): string | undefined {
  for (const args of [["remote", "get-url", "--push", "origin"], ["remote", "get-url", "origin"]]) {
    try {
      const url = execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      const identity = normalizeRemoteIdentity(url);
      if (identity !== undefined) return identity;
    } catch { /* no such remote — try the next probe */ }
  }
  return undefined;
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
