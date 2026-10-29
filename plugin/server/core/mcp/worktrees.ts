/** Shared git identity and Task worktree preparation for role bridges. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as worktreePolicy from "../worktree-policy.ts";
import type { ContractSet, LedgerEvent } from "../events.ts";
const GIT_TIMEOUT_MS = 15_000;
let lastProjectError = "";
export function resolveProjectFromDir(cwd: string, stateDirHint?: string) {
  const gitBin = worktreePolicy.resolveRealGitBinary(stateDirHint);
  try {
    const stdout = execFileSync(gitBin, ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = stdout.trim().split("\n");
    const root = (lines[0] ?? "").trim();
    const commonDirRaw = (lines[1] ?? "").trim();
    if (root === "" || commonDirRaw === "") return null;
    const commonDirAbs = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(cwd, commonDirRaw);
    const gitCommonDir = realpathSync(commonDirAbs);
    const hash = createHash("sha1").update(gitCommonDir).digest("hex").slice(0, 6);
    lastProjectError = "";
    return { root, gitCommonDir, slug: `${basename(root)}-${hash}` };
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const stderr = typeof err?.stderr === "string" && err.stderr.trim() !== "" ? err.stderr.trim().split("\n")[0] : "";
    lastProjectError = stderr || (err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function allocateTaskWorktree(stateDir: string, contract: ContractSet, task: string, events: readonly LedgerEvent[] = []) {
  const gitBin = worktreePolicy.resolveRealGitBinary(stateDir);
  const resolved = resolveProjectFromDir(contract.workspace, stateDir);
  if (!resolved) {
    const detail = lastProjectError ? ` (${lastProjectError})` : "";
    return { ok: false, reason: `workspace "${contract.workspace}" does not resolve to a git repository${detail}` };
  }
  let isRoot = false;
  try {
    isRoot = realpathSync(contract.workspace) === realpathSync(resolved.root);
  } catch {
    isRoot = contract.workspace === resolved.root;
  }
  if (!isRoot) {
    return { ok: true, legacy: true, cwd: contract.workspace, branch: task };
  }
  let baseCommit = contract.base;
  const contractSeq = typeof contract.seq === "number" ? contract.seq : -1;
  const upstreamLandedAfterContract =
    contractSeq >= 0 &&
    events.some((e) => typeof e.seq === "number" && e.seq > contractSeq && e.event === "attempt_accepted") &&
    !events.some((e) => typeof e.seq === "number" && e.seq > contractSeq && e.event === "claim_reported" && e.task === task);
  if (upstreamLandedAfterContract || typeof baseCommit !== "string" || !/^[0-9a-f]{40}$/i.test(baseCommit)) {
    const headOut = spawnSync(gitBin, ["rev-parse", "HEAD"], { cwd: resolved.root, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
    if (headOut.status !== 0) {
      return { ok: false, reason: `cannot resolve HEAD in ${resolved.root}` };
    }
    baseCommit = headOut.stdout.trim();
  }
  const worktreePath = join(stateDir, "projects", resolved.slug, "worktrees", task);
  const branch = `factory/${task}`;
  if (existsSync(worktreePath)) {
    const branchOut = spawnSync(gitBin, ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    const ancestorOut = spawnSync(gitBin, ["-C", worktreePath, "merge-base", "--is-ancestor", baseCommit, "HEAD"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    if (branchOut.status === 0 && branchOut.stdout.trim() === branch && ancestorOut.status === 0) {
      worktreePolicy.hydrateTaskWorktree(resolved.root, worktreePath, { copyIncludes: false });
      return { ok: true, cwd: worktreePath, branch, worktree: worktreePath, reused: true };
    }
    const rmOut = spawnSync(gitBin, ["worktree", "remove", "--force", worktreePath], {
      cwd: resolved.root,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    if (rmOut.status !== 0) {
      rmSync(worktreePath, { recursive: true, force: true });
      spawnSync(gitBin, ["worktree", "prune"], { cwd: resolved.root, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
    }
  } else {
    spawnSync(gitBin, ["worktree", "prune"], { cwd: resolved.root, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  }
  const addOut = spawnSync(gitBin, ["worktree", "add", "-B", branch, worktreePath, baseCommit], {
    cwd: resolved.root,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  if (addOut.status !== 0) {
    return { ok: false, reason: `could not create worktree at ${worktreePath}: ${(addOut.stderr || "").trim()}` };
  }
  worktreePolicy.hydrateTaskWorktree(resolved.root, worktreePath);
  return { ok: true, cwd: worktreePath, branch, worktree: worktreePath };
}


/** Teardown refuses unsettled Tasks and delegates dirty-tree refusal to git. */
export function removeTaskWorktree(stateDir: string, contract: ContractSet, task: string, events: readonly LedgerEvent[]) {
  const project = resolveProjectFromDir(contract.workspace, stateDir);
  if (!project) return { ok: false, reason: "project workspace unavailable" };
  const accepted = events.findLast(event => event.event === "attempt_accepted" && event.task === task);
  if (accepted?.event !== "attempt_accepted" || accepted.landing === "pending-conflict") return { ok: false, reason: "task-not-settled: accept and land before removing the worktree" };
  const worktree = join(stateDir, "projects", project.slug, "worktrees", task);
  const result = spawnSync(worktreePolicy.resolveRealGitBinary(stateDir), ["worktree", "remove", worktree], { cwd: project.root, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  return result.status === 0 ? { ok: true, worktree } : { ok: false, reason: result.stderr };
}
