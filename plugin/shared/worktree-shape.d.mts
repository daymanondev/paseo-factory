/**
 * The worktree path shape's declaration — see worktree-shape.mjs for why the
 * build/parse pair lives in shared/ (server's roles.ts and the bin's
 * task-worktree.mjs both import it).
 */

/** Where one task's worktree lives — `<stateDir>/projects/<slug>/worktrees/<task>`. */
export declare function taskWorktreePath(stateDir: string, projectSlug: string, task: string): string;
/** Recognizes a managed Task worktree cwd (or a directory inside one); null when the shape is not ours. */
export declare function parseTaskWorktreePath(stateDir: string, cwd: string): { slug: string; task: string } | null;
