import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
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
