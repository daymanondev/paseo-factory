#!/usr/bin/env node
/**
 * The Task worktree allocation (v0.0.14, ADR 0010 §4) — the driver-side half
 * of "Supervisor and Lead stand in <project-root>, every spawned Agent works
 * in its own linked git worktree".
 *
 * Laws it lives under:
 *
 * - **Plain .mjs, zero runtime deps** (ADR 0004): node:fs / node:child_process
 *   and the `./project.mjs + ../shared/worktree-shape.mjs` siblings only — no
 *   src/ or plugin-server imports, the same rule every plugin/bin file
 *   follows (a relative local import is still zero-dep).
 * - **Pre-spawn, refusal is local** (ticket 03 §2's law): a worktree that
 *   cannot be allocated is a named refusal with NO ledger line — a dispatched
 *   spawn with no worktree behind it would be a lie the ledger keeps.
 * - **<project-root> stays clean**: the allocation never touches the root's
 *   branch, index, or working tree; it only adds a linked worktree under
 *   `<stateDir>/projects/<slug>/worktrees/<task>` on branch `factory/<task>`
 *   at the Contract's base commit, plus per-worktree excludes for the copied
 *   untracked files so the Claim's clean-tree station stays honest.
 * - **Never lose verified work**: a re-run RESETS the worktree (the previous
 *   attempt's branch state is discarded deliberately — a re-run starts fresh
 *   at base), while landing (the plugin/core side) preserves `factory/<task>`
 *   on every conflict path.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";

import { projectStateDir, resolveProject } from "./project.mjs";
import { taskWorktreePath } from "../shared/worktree-shape.mjs";
import { hydrateTaskWorktree } from "./worktree-policy.mjs";

const GIT_TIMEOUT_MS = 15_000;

/**
 * Where one task's worktree lives and its parse — the ONE
 * `<stateDir>/projects/<slug>/worktrees/<task>` encoding, owned by
 * ../shared/worktree-shape.mjs (the one place both this allocator and the
 * server's role injector may import; see that file for the placement law).
 */
export { taskWorktreePath, parseTaskWorktreePath } from "../shared/worktree-shape.mjs";

/** The branch every task worktree runs on — `factory/<task>`, never a shared name. */
export function taskWorktreeBranch(task) {
  return `factory/${task}`;
}

function gitIn(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
}

function firstLine(text) {
  return typeof text === "string" && text.trim() !== "" ? text.trim().split("\n")[0] : "unknown git failure";
}

/**
 * Allocates or resets one task's linked worktree (ADR 0010 §4): tears down any
 * previous registration at the path, then `git worktree add -B factory/<task>
 * <path> <base>` — `-B` resets an existing branch to base, so a re-run always
 * starts the attempt at the Contract's base commit. `<project-root>` is never
 * touched (no branch switch, no checkout); `.worktreeinclude`-matched untracked
 * files (one pattern per line, `#` comments allowed, e.g. `.env*`) are copied
 * over and per-worktree excluded so `git status` in the worktree stays clean.
 * Returns `{ok:true, path, branch, reset}` or `{ok:false, reason}` — the
 * driver's own exit-2 refusal shape.
 */
export function prepareTaskWorktree({ stateDir, workspace, task, base }) {
  const project = resolveProject(workspace);
  if (!project.ok) {
    return { ok: false, reason: `workspace "${workspace}" does not resolve to a git Project — ${project.reason}` };
  }
  const root = project.root;
  const commit = base !== undefined && base !== null && /^[0-9a-f]{40}$/i.test(base)
    ? base
    : headOf(root);
  if (commit === undefined) {
    return { ok: false, reason: `cannot resolve a base commit for the worktree of ${task} — ${workspace} has no HEAD` };
  }
  const path = taskWorktreePath(stateDir, project.slug, task);
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
  const branch = taskWorktreeBranch(task);
  const added = gitIn(root, ["worktree", "add", "-B", branch, path, commit]);
  if (added.error !== undefined || added.status !== 0) {
    return { ok: false, reason: `could not create the task worktree at ${path} on ${branch}: ${firstLine(added.stderr ?? added.error?.message ?? "")}` };
  }
  hydrateTaskWorktree(root, path);
  return { ok: true, path, branch, reset };
}

/** HEAD of a checkout, or undefined — the fallback base when a Contract predates the field. */
function headOf(root) {
  const out = gitIn(root, ["rev-parse", "HEAD"]);
  if (out.error !== undefined || out.status !== 0) return undefined;
  const sha = out.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
}

/**
 * The dispatcher `runDriver` calls per task (Implementation Decision 5): the
 * managed Task worktree is conditioned on the Contract's workspace BEING the
 * Project root — `cwd` = the worktree, `branch` = `factory/<task>`,
 * `worktree` = its path for the spawn request. A workspace that resolves to
 * the SAME repository but sits BELOW the root (a monorepo package) keeps the
 * legacy single-checkout law instead: `legacy: true`, the agent's cwd stays
 * the subdirectory, the branch is the bare task id, and no worktree is
 * allocated (the driver switches the branch in place, exactly as before
 * worktrees existed — no spawn-line worktree, so no landing on accept).
 * A workspace git cannot resolve, or a worktree git refuses to create, is a
 * local exit-2 refusal with NO ledger line — the allocation never falls back
 * to switching branches inside `<project-root>` (that path would dirty the
 * root the worktree law exists to protect).
 */
export function prepareTaskWorkspace(stateDir, contract, task) {
  const project = resolveProject(contract.workspace);
  if (!project.ok) {
    return { ok: false, reason: `workspace "${contract.workspace}" does not resolve to a git Project — ${project.reason}` };
  }
  if (!samePath(contract.workspace, project.root)) {
    return { ok: true, legacy: true, cwd: contract.workspace, branch: task };
  }
  const prepared = prepareTaskWorktree({ stateDir, workspace: contract.workspace, task, base: contract?.base });
  if (prepared.ok) {
    return { ok: true, cwd: prepared.path, branch: prepared.branch, worktree: prepared.path, reset: prepared.reset };
  }
  return { ok: false, reason: prepared.reason };
}

/** Path equality after canonicalization — git's toplevel is physical, the Contract's workspace may ride a symlink. */
function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}
