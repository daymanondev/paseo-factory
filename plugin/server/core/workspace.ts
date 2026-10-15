import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";

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
          const changes = status.split("\n").filter((line) => line.trim() !== "");
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
export function headCommitSync(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
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
 * True when a declared scope prefix owns `file` — the boundary law ticket 14
 * fixed: a prefix owns itself and everything under it as a directory. One
 * shared spelling for the scope check, the memory write fence, and any later
 * boundary judge (v0.0.14).
 */
export function scopeCoversFile(scope: readonly string[], file: string): boolean {
  return scope.some((prefix) => file === prefix || file.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
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
