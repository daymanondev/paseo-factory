import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveProject } from "./project.ts";
import { hydrateTaskWorktree } from "./worktree-policy.ts";
import { PACKAGE_LOCKFILES, scopeCoversFile } from "./scope-policy.ts";
export { scopeCoversFile, scopeRecoveryCommands, normalizeScopePath } from "./scope-policy.ts";

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
  const directories = rel.split("/").slice(0, -1);
  if (directories.some((name) => ["playwright-report", "test-results", "coverage", ".nyc_output"].includes(name) || name.endsWith("-snapshots"))) {
    return true;
  }
  const slashIdx = rel.lastIndexOf("/");
  const baseName = slashIdx === -1 ? rel : rel.slice(slashIdx + 1);
  return PACKAGE_LOCKFILES.has(baseName);
}

/**
 * Expand untracked paths so collapsed parent directories cannot hide transient
 * outputs. Exclude install and test-output trees from expansion to keep them
 * out of the child-process buffer; tracked-only status still catches edits to
 * any tracked dependency files.
 */
async function workspaceStatus(cwd: string): Promise<{ stdout: string }> {
  const tracked = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  const expanded = await git(cwd, [
    "status", "--porcelain", "--untracked-files=all", "--", ":(top,glob)**",
    ...["node_modules", "playwright-report", "test-results", "coverage", ".nyc_output", "*-snapshots"]
      .map((directory) => `:(top,exclude,glob)**/${directory}/**`),
  ]);
  const untracked = expanded.stdout.split("\n").filter((line) => line.startsWith("?? "));
  return { stdout: [tracked.stdout.trimEnd(), ...untracked].filter(Boolean).join("\n") };
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
      return workspaceStatus(cwd).then(
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

/** Full change summary followed by the source patch, without package lockfile churn. */
export async function diffBetween(
  cwd: string,
  base: string,
  claimed: string,
): Promise<{ ok: true; diff: string } | { ok: false; reason: string }> {
  try {
    const { stdout: stat } = await git(cwd, ["diff", "--stat", base, claimed]);
    const { stdout: patch } = await git(cwd, ["diff", base, claimed, "--", ".", ...[...PACKAGE_LOCKFILES].map((file) => `:(exclude,glob)**/${file}`)]);
    return { ok: true, diff: stat && patch ? `${stat}\n\n${patch}` : stat || patch };
  } catch (err) {
    return { ok: false, reason: cap(gitDetail(err)) };
  }
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
  /** A pending acceptance may have accumulated conflict-resolution commits. */
  retry?: boolean;
}): Promise<LandingResult> {
  const { projectRoot, worktree, base, branch } = options;
  let claimedCommit = options.claimedCommit;
  if (options.retry === true) {
    const tips = [headCommitSync(worktree), headCommitSync(projectRoot, branch)].filter((tip): tip is string => tip !== undefined);
    if (tips.length === 0) return { landing: "pending-conflict", note: `cannot resolve the pending task tip for ${branch}; preserve the worktree and repair its branch` };
    for (const tip of tips) {
      if (tip === claimedCommit) continue;
      const advanced = await gitExit(projectRoot, ["merge-base", "--is-ancestor", claimedCommit, tip]);
      if (advanced.status === 0) claimedCommit = tip;
      else {
        const behind = await gitExit(projectRoot, ["merge-base", "--is-ancestor", tip, claimedCommit]);
        if (behind.status !== 0) return { landing: "pending-conflict", note: `pending task tip for ${branch} diverged from its verified claim; preserve both histories and resolve manually` };
      }
    }
  }
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
  let status: { stdout: string };
  try {
    status = await workspaceStatus(projectRoot);
  } catch (err) {
    return conflict(`could not read the project root's status: ${gitDetail(err)}`);
  }
  const changes = status.stdout.split("\n").filter((line) => line.trim() !== "" && !isUntrackedInstallArtifact(line));
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

/** Keep the verified installation alive until it is safely available in the root. */
function hydrateDependencies(projectRoot: string, worktree: string): void {
  const source = join(worktree, "node_modules");
  const destination = join(projectRoot, "node_modules");
  if (!existsSync(join(projectRoot, "package.json")) || !existsSync(source) || !lstatSync(source).isDirectory()) return;
  const destinationExists = existsSync(destination) || lstatSync(destination, { throwIfNoEntry: false }) !== undefined;
  if (existsSync(destination)) {
    const installed = statSync(destination);
    if (!installed.isDirectory()) throw new Error("root node_modules is obstructed by a non-directory");
    if (installed.mtimeMs >= statSync(join(projectRoot, "package.json")).mtimeMs) return;
  }
  const staging = mkdtempSync(join(projectRoot, ".factory-dependencies-"));
  let retainBackup = false;
  try {
    // Copy into the destination filesystem; source and root may be on different volumes.
    cpSync(source, join(staging, "installation"), { recursive: true, verbatimSymlinks: true });
    const backup = join(staging, "previous");
    if (destinationExists) renameSync(destination, backup);
    try {
      renameSync(join(staging, "installation"), destination);
    } catch (err) {
      if (destinationExists) {
        try {
          renameSync(backup, destination);
        } catch (restoreError) {
          retainBackup = true;
          throw new Error(`could not restore prior dependencies; backup retained at ${backup}`, { cause: restoreError });
        }
      }
      throw err;
    }
  } finally {
    if (!retainBackup) rmSync(staging, { recursive: true, force: true });
  }
}

/** Hydrates dependencies before either worktree cleanup path can delete them. */
async function finishLanding(projectRoot: string, worktree: string): Promise<LandingResult> {
  try {
    hydrateDependencies(projectRoot, worktree);
  } catch (err) {
    return { landing: "pending-conflict", note: cap(`dependency hydration failed; worktree retained: ${err instanceof Error ? err.message : String(err)}`) };
  }
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
   * Unless explicitly false, when `<projectRoot>/node_modules` exists, creates a directory
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
  hydrateTaskWorktree(root, path, { inheritNodeModules: symlinkNodeModules !== false });
  return { ok: true, path, branch, reset };
}

/** One git fact as a sync child — the allocation is a pre-spawn act, so it runs before any await exists. */
function gitIn(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
}

function firstLine(text: string): string {
  return text.trim() !== "" ? text.trim().split("\n")[0]! : "unknown git failure";
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
