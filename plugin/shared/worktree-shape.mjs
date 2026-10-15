/**
 * The ONE encoding of the managed Task worktree path shape (v0.0.14, ADR
 * 0010 §4): `<stateDir>/projects/<slug>/worktrees/<task>`. Two worlds build
 * and parse it — plugin/bin/task-worktree.mjs (the allocator) and
 * plugin/server/roles.ts (the role injector) — so it lives in shared/, the
 * one place the plugin compiler's placement law lets server code import and
 * a plain-node bin sibling can import too (a relative local import keeps the
 * bin zero-dep, ADR 0004). Build and parse live together here so the two
 * halves cannot drift.
 *
 * Zero deps by construction — template strings only, not even node:path —
 * because shared/ also feeds the Hermes client bundle, where node:* is
 * forbidden. Path inputs are the absolute, normalized dirs the factory
 * derives (stateDirFor / resolveProject); template building and join agree
 * on those.
 */

/** Where one task's worktree lives — the Project's isolated state tree. */
export function taskWorktreePath(stateDir, projectSlug, task) {
  return `${stateDir}/projects/${projectSlug}/worktrees/${task}`;
}

/**
 * Recognizes a managed Task worktree cwd — or a directory inside one — and
 * names its project and task from the shape alone (the driver allocates the
 * worktree pre-spawn). Anything else is null: not ours to inject.
 */
export function parseTaskWorktreePath(stateDir, cwd) {
  const prefix = `${stateDir}/projects/`;
  if (typeof cwd !== "string" || !cwd.startsWith(prefix)) return null;
  const segments = cwd.slice(prefix.length).split("/");
  if (segments.length < 3) return null;
  const [slug, worktrees, task] = segments;
  if (slug === undefined || worktrees !== "worktrees" || task === undefined) return null;
  if (slug === "" || task === "") return null;
  return { slug, task };
}
