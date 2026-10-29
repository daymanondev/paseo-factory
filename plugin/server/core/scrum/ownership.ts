import { FactoryError } from "../errors.ts";
import { commandRun, listRuns, terminalRun } from "./run-journal.ts";
import type { ScrumRun } from "./run-journal.ts";
import { safePath } from "./types.ts";
/** Register explicit paths through the writer, preserving ownership of other active runs. */
export function registerOwnedPaths(state: string, slug: string, run: ScrumRun, paths: string[], requestId: string): ScrumRun {
  if (!Array.isArray(paths) || paths.some(path => !safePath(path) || path.startsWith("/") || /[*?\[\]{}]/.test(path) || (path.startsWith(".scratch/") && !path.startsWith(`.scratch/${run.initiativeId}/`)))) throw new FactoryError("invalid-owned-path", "explicit initiative or implementation paths required");
  const additions = paths.filter(path => !run.ownedPaths.includes(path));
  if (!additions.length) return run;
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
  for (const other of listRuns(state, slug).filter(other => other.runId !== run.runId && !terminalRun(other))) {
    if (additions.some(path => other.ownedPaths.some(owned => overlaps(path, owned)))) throw new FactoryError("artifact-ownership-conflict", "path belongs to another active run");
  }
  return commandRun(state, slug, run.runId, { type: "paths_registered", paths: additions, requestId, expectedRevision: run.revision });
}
