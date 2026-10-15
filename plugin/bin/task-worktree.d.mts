/**
 * The Task worktree allocation's declaration — see task-worktree.mjs for why
 * it exists (plain .mjs, no build step, no src/ imports per ADR 0004).
 * test/driver.test.ts runs the allocation pieces; the driver's per-task
 * wiring is thin on top of them.
 */

export declare function taskWorktreePath(stateDir: string, projectSlug: string, task: string): string;
export declare function taskWorktreeBranch(task: string): string;
/**
 * The parse of the shape `taskWorktreePath` builds (this file owns the one
 * `<stateDir>/projects/<slug>/worktrees/<task>` encoding): a managed worktree
 * cwd — or a directory inside one — names its project and task; anything
 * else is null. The server's role layer imports this instead of re-encoding
 * the shape.
 */
export declare function parseTaskWorktreePath(stateDir: string, cwd: string): { slug: string; task: string } | null;

export interface PreparedTaskWorktree {
  ok: true;
  /** The worktree's absolute path — `<stateDir>/projects/<slug>/worktrees/<task>`. */
  path: string;
  /** `factory/<task>` — the branch the worktree runs on. */
  branch: string;
  /** True when a previous registration at the path was torn down first (the re-run case). */
  reset: boolean;
}
export declare function prepareTaskWorktree(input: {
  stateDir: string;
  workspace: string;
  task: string;
  base?: string;
}): PreparedTaskWorktree | { ok: false; reason: string };

export interface PreparedTaskWorkspace {
  ok: true;
  /** The execution cwd the spawned agent runs in — the task worktree. */
  cwd: string;
  /** The branch the agent is already on — `factory/<task>`. */
  branch: string;
  /** The worktree path, carried on the spawn request so the plugin can record it. */
  worktree: string;
  reset: boolean;
  /** Never set on the worktree routing — the discriminator of the legacy branch. */
  legacy?: undefined;
}
/** The legacy routing (Implementation Decision 5): the workspace is a repo subdirectory — single checkout, no worktree. */
export interface PreparedLegacyWorkspace {
  ok: true;
  legacy: true;
  /** The execution cwd the spawned agent runs in — the contracted subdirectory. */
  cwd: string;
  /** The bare task id — the branch the driver switches to in place, as before worktrees existed. */
  branch: string;
  /** Never set on the legacy routing — no worktree is allocated or carried. */
  worktree?: undefined;
  reset?: undefined;
}
export declare function prepareTaskWorkspace(
  stateDir: string,
  contract: { workspace: string; base?: string },
  task: string,
): PreparedTaskWorkspace | PreparedLegacyWorkspace | { ok: false; reason: string };
