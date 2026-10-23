import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveProject } from "./project.ts";

const execFileAsync = promisify(execFile);

/** Git plumbing calls are facts about the workspace, so they get their own short leash. */
const GIT_TIMEOUT_MS = 10_000;
/** Failure reasons become gate notes; keep them one glance long. */
const REASON_MAX_CHARS = 200;

export type CommitResolution =
  | { ok: true; full: string }
  | { ok: false; reason: string };

export type TreeCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Resolves the Agent's claimed sha to one full commit object — ADR 0002: the
 * Verdict is about the claimed commit, never about whatever is on disk. An
 * empty, unknown, or ambiguous sha resolves to nothing; the caller turns that
 * into a red Verdict, never a fallback to HEAD.
 */
export function resolveClaimedCommit(cwd: string, sha: string): Promise<CommitResolution> {
  const claimed = sha.trim();
  if (claimed === "") {
    return Promise.resolve({ ok: false, reason: "claimed sha is empty" });
  }
  return git(cwd, ["rev-parse", "--verify", `${claimed}^{commit}`]).then(
    ({ stdout }) => {
      const full = stdout.trim();
      // A ref like a branch name also resolves; only a 40-hex object id attests a commit.
      if (!/^[0-9a-f]{40}$/i.test(full)) {
        return { ok: false as const, reason: cap(`"${claimed}" does not resolve to a commit object`) };
      }
      return { ok: true as const, full };
    },
    (err: unknown) => ({ ok: false as const, reason: cap(`"${claimed}" cannot be resolved: ${gitDetail(err)}`) }),
  );
}

const PACKAGE_LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

function isUntrackedInstallArtifact(porcelainLine: string): boolean {
  if (!porcelainLine.startsWith("?? ")) return false;
  const rel = porcelainLine
    .slice(3)
    .trim()
    .replace(/^"(.*)"$/, "$1");
  if (
    rel === "node_modules" ||
    rel === "node_modules/" ||
    rel.endsWith("/node_modules") ||
    rel.endsWith("/node_modules/")
  ) {
    return true;
  }
  const slashIdx = rel.lastIndexOf("/");
  const baseName = slashIdx === -1 ? rel : rel.slice(slashIdx + 1);
  return PACKAGE_LOCKFILES.has(baseName);
}

/**
 * The Workspace must sit clean with HEAD at the claimed commit — checked before
 * the Gate starts and again after it ends (ADR 0002). Anything else means the
 * Verdict would attest a moving target.
 */
export function checkCleanAt(cwd: string, expectedFull: string): Promise<TreeCheck> {
  return git(cwd, ["rev-parse", "HEAD"]).then(
    ({ stdout }) => {
      const head = stdout.trim();
      if (head !== expectedFull) {
        return { ok: false as const, reason: cap(`HEAD is ${shortSha(head)}, not the claimed ${shortSha(expectedFull)}`) };
      }
      return git(cwd, ["status", "--porcelain"]).then(
        ({ stdout: status }) => {
          const changes = status
            .split("\n")
            .filter((line) => line.trim() !== "" && !isUntrackedInstallArtifact(line));
          if (changes.length > 0) {
            return { ok: false as const, reason: cap(`tree not clean (${changes.length} change${changes.length === 1 ? "" : "s"}): ${changes[0]}`) };
          }
          return { ok: true as const };
        },
        (err: unknown) => ({ ok: false as const, reason: cap(`could not read tree status: ${gitDetail(err)}`) }),
      );
    },
    (err: unknown) => ({ ok: false as const, reason: cap(`could not read HEAD: ${gitDetail(err)}`) }),
  );
}

/**
 * HEAD of the workspace, synchronously — recorded as a scoped Contract's diff
 * base at the moment the Contract is set. Returns undefined when git cannot
 * answer; setContract turns that into a refusal, never a silent null base.
 */
export function headCommitSync(cwd: string, ref = "HEAD"): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--verify", `${ref.trim() || "HEAD"}^{commit}`], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
}

/** A scope entry owns literal file/directory prefixes or paths matched by its glob. */
export function scopeCoversFile(scope: readonly string[], file: string): boolean {
  const directMatch = (target: string): boolean =>
    scope.some((entry) => {
      const prefix = normalizeScopePath(entry);
      const path = normalizeScopePath(target);
      if (!/[*?]/.test(prefix)) return path === prefix || path.startsWith(`${prefix}/`);
      return scopeGlob(prefix).test(path);
    });
  if (directMatch(file)) return true;
  const slashIdx = file.lastIndexOf("/");
  const baseName = slashIdx === -1 ? file : file.slice(slashIdx + 1);
  if (PACKAGE_LOCKFILES.has(baseName)) {
    const companionPkgJson = slashIdx === -1 ? "package.json" : `${file.slice(0, slashIdx)}/package.json`;
    if (directMatch(companionPkgJson)) return true;
  }
  return false;
}

/** Restore the whole branch diff from the Contract base, including previously committed files. */
export function scopeRecoveryCommands(base: string, files: readonly string[]): string {
  const quote = (value: string): string => /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
  return files.map((file) => `git restore --source=${quote(base)} -- ${quote(file)}`).join("; ");
}

/** Contract paths are relative Git paths; tolerate the conventional ./ and trailing slash. */
export function normalizeScopePath(path: string): string {
  return path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

function scopeGlob(pattern: string): RegExp {
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        expression += "(?:[^/]+/)*";
        i++;
      } else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

/**
 * The files the Attempt changed between two commits — the raw list the scope
 * check filters (ticket 14) and the memory write fence scans (v0.0.14, ADR
 * 0010 §6). Facts only; policies live with their callers.
 */
export function changedFiles(
  cwd: string,
  base: string,
  claimed: string,
): Promise<{ ok: true; files: string[] } | { ok: false; reason: string }> {
  return git(cwd, ["diff", "--name-only", base, claimed]).then(
    ({ stdout }) => ({
      ok: true as const,
      files: stdout.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
    }),
    (err: unknown) => ({ ok: false as const, reason: gitDetail(err) }),
  );
}

/**
 * Files the Attempt changed between the Contract's base commit and the claimed
 * commit that fall outside every declared scope prefix (ticket 14): the task
 * boundary is mechanical, not polite — an overreaching diff is never stamped
 * green. A prefix owns itself and everything under it as a directory.
 */
export function changesOutsideScope(
  cwd: string,
  base: string,
  claimed: string,
  scope: readonly string[],
): Promise<{ ok: true } | { ok: false; files: string[]; reason?: string }> {
  return changedFiles(cwd, base, claimed).then((diff) => {
    if (!diff.ok) return { ok: false as const, files: [], reason: diff.reason };
    const outside = diff.files.filter((file) => !scopeCoversFile(scope, file));
    return outside.length === 0 ? { ok: true as const } : { ok: false as const, files: outside };
  });
}

/**
 * The full patch between the Contract's base commit and the claimed commit —
 * the fresh-eyes input bundle's diff section (ticket 03 §4). Facts only: size
 * caps belong to the bundle builder, not to git.
 */
export function diffBetween(
  cwd: string,
  base: string,
  claimed: string,
): Promise<{ ok: true; diff: string } | { ok: false; reason: string }> {
  return git(cwd, ["diff", base, claimed]).then(
    ({ stdout }) => ({ ok: true as const, diff: stdout }),
    (err: unknown) => ({ ok: false as const, reason: cap(gitDetail(err)) }),
  );
}

/**
 * The landing outcome on Accept (v0.0.14, ADR 0010 §4): `landed` means the
 * verified commit is in `<project-root>`'s local branch history and the
 * temporary worktree is gone (a cleanup failure rides `note` — the work IS
 * in); `pending-conflict` means the acceptance recorded while the root was
 * dirty or the integration conflicted — branch `factory/<task>` and the
 * worktree both survive, and `note` names the reason for the Lead or
 * Supervisor to resolve. `git push` never happens — remote landing stays a
 * human act (ADR 0002 / ADR 0010).
 */
export type LandingResult =
  | { landing: "landed"; note?: string }
  | { landing: "pending-conflict"; note: string };

/**
 * A git call that resolves with the exit status instead of throwing on it —
 * the landing's door reads `merge-base --is-ancestor`, whose exit 1 is an
 * answer ("not an ancestor"), not an error.
 */
function gitExit(
  cwd: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS }).then(
    ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
    (err: unknown) => {
      const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
      return {
        status: typeof e.code === "number" ? e.code : null,
        stdout: typeof e.stdout === "string" ? e.stdout : "",
        stderr: typeof e.stderr === "string" ? e.stderr : "",
      };
    },
  );
}

export async function landTaskWorktree(options: {
  projectRoot: string;
  worktree: string;
  claimedCommit: string;
  /** The Contract's base — the fast-forward test HEAD compares against. */
  base?: string;
  branch: string;
}): Promise<LandingResult> {
  const { projectRoot, worktree, claimedCommit, base, branch } = options;
  // Idempotency door: exit 0 means the claimed commit is ALREADY in the
  // root's history (a crash between merge and attempt_accepted, or a manual
  // land) — finish the cleanup and land as done. Exit 1 (not an ancestor) is
  // the ordinary clean path; any other failure falls through to landCleanly,
  // whose own first git call reports the honest reason.
  const already = await gitExit(projectRoot, ["merge-base", "--is-ancestor", claimedCommit, "HEAD"]);
  if (already.status === 0) return finishLanding(projectRoot, worktree);
  return landCleanly(projectRoot, worktree, claimedCommit, base, branch);
}

/**
 * The landing's clean path, split from the reachability door: the root must
 * sit clean — uncommitted edits make any integration untrustworthy, and
 * touching them is never the factory's act — then fast-forward at the base
 * or `merge --no-ff` of the attempt's whole range above it. A failed merge
 * is aborted so the root never lives inside a conflict.
 */
async function landCleanly(
  projectRoot: string,
  worktree: string,
  claimedCommit: string,
  base: string | undefined,
  branch: string,
): Promise<LandingResult> {
  const conflict = (note: string): LandingResult => ({ landing: "pending-conflict", note: cap(note) });
  const status = await gitExit(projectRoot, ["status", "--porcelain"]);
  if (status.status !== 0) return conflict(`could not read the project root's status: ${gitDetail(status)}`);
  const changes = status.stdout.split("\n").filter((line) => line.trim() !== "");
  if (changes.length > 0) {
    return conflict(
      `project root not clean (${changes.length} change${changes.length === 1 ? "" : "s"}): ${changes[0]!.trim()} — commit or stash before landing branch ${branch}`,
    );
  }
  const head = await gitExit(projectRoot, ["rev-parse", "HEAD"]);
  if (head.status !== 0) return conflict(`could not read the project root's HEAD: ${gitDetail(head)}`);
  const headSha = head.stdout.trim();
  const mergeArgs =
    base !== undefined && headSha === base
      ? ["merge", "--ff-only", claimedCommit]
      : ["merge", "--no-ff", claimedCommit, "-m", `factory: land ${branch} (${shortSha(claimedCommit)})`];
  const merged = await gitExit(projectRoot, mergeArgs);
  if (merged.status !== 0) {
    await gitExit(projectRoot, ["merge", "--abort"]); // best-effort: the root returns to its own commit, never mid-conflict
    return conflict(
      `merge of ${branch} into <project-root> conflicted: ${firstStderrLine(merged) ?? "no reason given"} — resolve manually from branch ${branch}`,
    );
  }
  return finishLanding(projectRoot, worktree);
}

/** Removes the landed task's worktree; a cleanup failure rides the note, never the outcome. */
async function finishLanding(projectRoot: string, worktree: string): Promise<LandingResult> {
  const removed = await gitExit(projectRoot, ["worktree", "remove", "--force", worktree]);
  if (removed.status === 0) return { landing: "landed" };
  // A stale or unregistered directory: best-effort remove, then prune.
  try {
    rmSync(worktree, { recursive: true, force: true });
  } catch {
    // nothing more to try — the landed commit is already in history
  }
  await gitExit(projectRoot, ["worktree", "prune"]);
  return { landing: "landed" };
}

// ---- the Task worktree allocation (v0.0.14 ADR 0010 §4, promoted from plugin/bin/task-worktree.mjs in v0.0.18) ----

/**
 * Where one task's worktree lives — the ONE
 * `<stateDir>/projects/<slug>/worktrees/<task>` encoding, ported verbatim from
 * `plugin/shared/worktree-shape.mjs` (template strings, not `join`, so build
 * and parse stay the same pure-string pair and cannot drift; the plugin's
 * shared/ copy remains the client-bundle's own encoding).
 */
export function taskWorktreePath(stateDir: string, projectSlug: string, task: string): string {
  return `${stateDir}/projects/${projectSlug}/worktrees/${task}`;
}

/**
 * Recognizes a managed Task worktree cwd — or a directory inside one — and
 * names its project and task from the shape alone. Anything else is null:
 * not ours to inject.
 */
export function parseTaskWorktreePath(stateDir: string, cwd: string): { slug: string; task: string } | null {
  const prefix = `${stateDir}/projects/`;
  if (!cwd.startsWith(prefix)) return null;
  const segments = cwd.slice(prefix.length).split("/");
  if (segments.length < 3) return null;
  const [slug, worktrees, task] = segments;
  if (slug === "" || worktrees !== "worktrees" || task === "") return null;
  return { slug, task };
}

/** The branch every task worktree runs on — `factory/<task>`, never a shared name. */
export function taskWorktreeBranch(task: string): string {
  return `factory/${task}`;
}

/** The allocation's inputs — the driver's shape plus the companion-facing v0.0.18 options. */
export interface PrepareTaskWorktreeOptions {
  stateDir: string;
  workspace: string;
  task: string;
  /** The Contract's base commit — 40-hex, or anything else falls back to the root's HEAD. */
  base?: string | null;
  /** Optional explicit worktree directory override (used by companion Best-of-N arenas). Defaults to taskWorktreePath(stateDir, project.slug, task). */
  worktreePath?: string;
  /** Optional explicit branch name override. Defaults to taskWorktreeBranch(task) (`factory/<task>`). */
  branchName?: string;
  /**
   * When true and `<projectRoot>/node_modules` exists, creates a directory
   * symlink (`junction` on win32, `dir` on POSIX) in the worktree and excludes
   * `node_modules` in the per-worktree `factory-excludes` file so
   * `checkCleanAt` stays clean.
   */
  symlinkNodeModules?: boolean;
}

/** The allocation's outcome: the worktree that exists, or a named refusal — the driver's own exit-2 shape. */
export type PrepareTaskWorktreeResult =
  | { ok: true; path: string; branch: string; reset: boolean }
  | { ok: false; reason: string };

/**
 * Allocates or resets one task's linked worktree (ADR 0010 §4), the core
 * promotion of the driver's proven `plugin/bin/task-worktree.mjs` allocator:
 * resolves the workspace to a Project, tears down any previous registration
 * at the path, then `git worktree add -B <branch> <path> <base>` — `-B`
 * resets an existing branch to base, so a re-run always starts the attempt
 * at the Contract's base commit (a deliberate reset, never a way to lose
 * verified work: landing preserves `factory/<task>` on every path).
 * `<project-root>` is never touched (no branch switch, no checkout);
 * `.worktreeinclude`-matched untracked files are copied over and per-worktree
 * excluded so `git status` in the worktree stays clean. Beyond the port,
 * companions may override `worktreePath` / `branchName` (Best-of-N arenas)
 * and ask for a `node_modules` directory symlink instead of a fresh install.
 */
export function prepareTaskWorktree(options: PrepareTaskWorktreeOptions): PrepareTaskWorktreeResult {
  const { stateDir, workspace, task, base, worktreePath, branchName, symlinkNodeModules } = options;
  const project = resolveProject(workspace);
  if (!project.ok) {
    return { ok: false, reason: cap(`workspace "${workspace}" does not resolve to a git Project — ${project.reason}`) };
  }
  const root = project.root;
  const commit = base !== undefined && base !== null && /^[0-9a-f]{40}$/i.test(base) ? base : headCommitSync(root);
  if (commit === undefined) {
    return { ok: false, reason: cap(`cannot resolve a base commit for the worktree of ${task} — ${workspace} has no HEAD`) };
  }
  const path = worktreePath ?? taskWorktreePath(stateDir, project.slug, task);
  const reset = existsSync(path);
  if (reset) {
    const removed = gitIn(root, ["worktree", "remove", "--force", path]);
    if (removed.error !== undefined || removed.status !== 0) {
      // A stale directory git does not own (a wiped registration) still has to
      // go before `worktree add` will take the path.
      rmSync(path, { recursive: true, force: true });
      gitIn(root, ["worktree", "prune"]);
    }
  } else {
    gitIn(root, ["worktree", "prune"]);
  }
  const branch = branchName ?? taskWorktreeBranch(task);
  const added = gitIn(root, ["worktree", "add", "-B", branch, path, commit]);
  if (added.error !== undefined || added.status !== 0) {
    return { ok: false, reason: cap(`could not create the task worktree at ${path} on ${branch}: ${firstLine(added.stderr ?? added.error?.message ?? "")}`) };
  }
  const linked = symlinkNodeModules === true && linkNodeModules(root, path);
  copyWorktreeIncludes(root, path, linked ? ["node_modules"] : []);
  return { ok: true, path, branch, reset };
}

/** One git fact as a sync child — the allocation is a pre-spawn act, so it runs before any await exists. */
function gitIn(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
}

function firstLine(text: string): string {
  return text.trim() !== "" ? text.trim().split("\n")[0]! : "unknown git failure";
}

/**
 * Links `<worktreePath>/node_modules` at the root's own directory — `junction`
 * on win32, `dir` symlink on POSIX, idempotent on the exact same target.
 * Returns whether the link exists after the call, so the caller only excludes
 * what it linked.
 */
function linkNodeModules(root: string, worktreePath: string): boolean {
  const target = join(root, "node_modules");
  try {
    if (!statSync(target).isDirectory()) return false;
  } catch {
    return false; // no node_modules at the root — nothing to link, no failure
  }
  const linkPath = join(worktreePath, "node_modules");
  try {
    if (lstatSync(linkPath).isSymbolicLink() && realpathSync(linkPath) === realpathSync(target)) return true;
  } catch {
    // absent or unreadable — created below
  }
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch {
    return false; // best-effort: a missing link never dirties the tree
  }
  return true;
}

/** One `.worktreeinclude` pattern as a match predicate over workspace-relative paths. */
function patternMatches(pattern: string, file: string): boolean {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(file);
}

/**
 * Copies the untracked files `<project-root>/.worktreeinclude` names (env
 * files, local secrets — one pattern per line, `#` comments) into the fresh
 * worktree, then hides the copies — plus any `extraExcludes` (the
 * `node_modules` link) — from the WORKTREE's own `git status` via a
 * per-worktree `core.excludesFile` (git's `info/exclude` resolves through the
 * COMMON dir, shared with `<project-root>` — writing there would hide the
 * user's own untracked files at the root, so the worktree-private
 * `<gitdir-of-worktree>/factory-excludes` + `git config --worktree` is the
 * mechanism instead; the file dies with the worktree registration). The
 * Claim's clean-tree station reads that status — a copied `.env` must never
 * redden an honest attempt. Missing include file: nothing is copied, no
 * failure — the common case; `extraExcludes` still lands when a link was made.
 */
function copyWorktreeIncludes(root: string, worktreePath: string, extraExcludes: readonly string[] = []): void {
  let raw = "";
  try {
    raw = readFileSync(join(root, ".worktreeinclude"), "utf8");
  } catch {
    // no include file — the common case; extras may still need excluding
  }
  const patterns = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const untracked = new Set<string>();
  if (patterns.length > 0) {
    for (const extra of [[], ["--ignored"]]) {
      const listed = gitIn(root, ["ls-files", "--others", "--exclude-standard", ...extra]);
      if (listed.error !== undefined || listed.status !== 0) continue;
      for (const line of listed.stdout.split("\n")) {
        const file = line.trim();
        if (file !== "") untracked.add(file);
      }
    }
  }
  const copied: string[] = [];
  for (const file of untracked) {
    if (!patterns.some((pattern) => patternMatches(pattern, file))) continue;
    const from = join(root, file);
    const to = join(worktreePath, file);
    try {
      if (!statSync(from).isFile()) continue;
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
      copied.push(file);
    } catch {
      // One uncopiable file never fails the allocation — the agent will see it
      // missing and the include list stays the operator's hint, not a promise.
    }
  }
  const excludeLines = [...copied, ...extraExcludes];
  if (excludeLines.length === 0) return;
  try {
    const gitDirOut = gitIn(worktreePath, ["rev-parse", "--git-dir"]);
    if (gitDirOut.error !== undefined || gitDirOut.status !== 0) return;
    const gitDir = resolve(worktreePath, gitDirOut.stdout.trim());
    const excludesFile = join(gitDir, "factory-excludes");
    writeFileSync(excludesFile, `${excludeLines.join("\n")}\n`);
    gitIn(root, ["config", "extensions.worktreeConfig", "true"]); // idempotent, enables `--worktree`
    gitIn(worktreePath, ["config", "--worktree", "core.excludesFile", excludesFile]);
  } catch {
    // Best-effort only — a failed exclude shows as an untracked file the gate
    // would surface, never a lost allocation.
  }
}

function firstStderrLine(result: { stderr?: unknown }): string | undefined {
  const text = result.stderr;
  if (typeof text !== "string" || text.trim() === "") return undefined;
  return text.trim().split("\n")[0];
}

function gitDetail(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  const first = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().split("\n")[0] : "";
  if (first !== "") return first;
  return err instanceof Error ? err.message : String(err);
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function cap(reason: string): string {
  return reason.slice(0, REASON_MAX_CHARS);
}
