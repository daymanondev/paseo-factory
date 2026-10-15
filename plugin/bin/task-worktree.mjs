#!/usr/bin/env node
/**
 * The Task worktree allocation (v0.0.14, ADR 0010 §4) — the driver-side half
 * of "Supervisor and Lead stand in <project-root>, every spawned Agent works
 * in its own linked git worktree".
 *
 * Laws it lives under:
 *
 * - **Plain .mjs, zero runtime deps** (ADR 0004): node:fs / node:child_process
 *   and the `./project.mjs` sibling only — no src/ or plugin-server imports,
 *   the same rule every plugin/bin file follows.
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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { projectStateDir, resolveProject } from "./project.mjs";

const GIT_TIMEOUT_MS = 15_000;

/** Where one task's worktree lives — the Project's isolated state tree. */
export function taskWorktreePath(stateDir, projectSlug, task) {
  return join(projectStateDir(stateDir, projectSlug), "worktrees", task);
}

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
  copyWorktreeIncludes(root, path);
  return { ok: true, path, branch, reset };
}

/** HEAD of a checkout, or undefined — the fallback base when a Contract predates the field. */
function headOf(root) {
  const out = gitIn(root, ["rev-parse", "HEAD"]);
  if (out.error !== undefined || out.status !== 0) return undefined;
  const sha = out.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
}

/** One `.worktreeinclude` pattern as a match predicate over workspace-relative paths. */
function patternMatches(pattern, file) {
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
 * worktree, then hides the copies from the WORKTREE's own `git status` via a
 * per-worktree `core.excludesFile` (git's `info/exclude` resolves through the
 * COMMON dir, shared with `<project-root>` — writing there would hide the
 * user's own untracked files at the root, so the worktree-private
 * `<gitdir-of-worktree>/factory-excludes` + `git config --worktree` is the
 * mechanism instead; the file dies with the worktree registration). The
 * Claim's clean-tree station reads that status — a copied `.env` must never
 * redden an honest attempt. Missing include file: nothing is copied, no
 * failure — the common case.
 */
function copyWorktreeIncludes(root, worktreePath) {
  let raw;
  try {
    raw = readFileSync(join(root, ".worktreeinclude"), "utf8");
  } catch {
    return; // no include file — the common case
  }
  const patterns = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (patterns.length === 0) return;
  const untracked = new Set();
  for (const extra of [[], ["--ignored"]]) {
    const listed = gitIn(root, ["ls-files", "--others", "--exclude-standard", ...extra]);
    if (listed.error !== undefined || listed.status !== 0) continue;
    for (const line of listed.stdout.split("\n")) {
      const file = line.trim();
      if (file !== "") untracked.add(file);
    }
  }
  const copied = [];
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
  if (copied.length === 0) return;
  try {
    const gitDirOut = gitIn(worktreePath, ["rev-parse", "--git-dir"]);
    if (gitDirOut.error !== undefined || gitDirOut.status !== 0) return;
    const gitDir = resolve(worktreePath, gitDirOut.stdout.trim());
    const excludesFile = join(gitDir, "factory-excludes");
    writeFileSync(excludesFile, `${copied.join("\n")}\n`);
    gitIn(root, ["config", "extensions.worktreeConfig", "true"]); // idempotent, enables `--worktree`
    gitIn(worktreePath, ["config", "--worktree", "core.excludesFile", excludesFile]);
  } catch {
    // Best-effort only — a failed exclude shows as an untracked file the gate
    // would surface, never a lost allocation.
  }
}

/**
 * The dispatcher `runDriver` calls per task: a Contract whose workspace
 * resolves to a Project gets the managed Task worktree (`cwd` = the worktree,
 * `branch` = `factory/<task>`, `worktree` = its path for the spawn request).
 * A workspace git cannot resolve, or a worktree git refuses to create, is a
 * local exit-2 refusal with NO ledger line — the allocation never falls back
 * to switching branches inside `<project-root>` (that path would dirty the
 * root the worktree law exists to protect).
 */
export function prepareTaskWorkspace(stateDir, contract, task) {
  const prepared = prepareTaskWorktree({ stateDir, workspace: contract.workspace, task, base: contract?.base });
  if (prepared.ok) {
    return { ok: true, cwd: prepared.path, branch: prepared.branch, worktree: prepared.path, reset: prepared.reset };
  }
  return { ok: false, reason: prepared.reason };
}
