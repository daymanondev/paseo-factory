import { realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

/** Registration checks the path spelling; the target may be produced by the Gate. */
export function artifactPathProblem(artifact: string): string | undefined {
  if (artifact.trim() === "" || artifact.includes("\0")) return "artifact path must be a non-empty path without NUL bytes";
  const normalized = normalize(artifact);
  if (isAbsolute(artifact) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    return `artifact "${artifact}" must be a workspace-relative path contained inside the execution Workspace`;
  }
  return undefined;
}

/** The existing target, including every symlink, must remain inside the actual execution tree. */
export function inspectArtifact(workspace: string, artifact: string): { present: true } | { present: false; note: string } {
  const pathProblem = artifactPathProblem(artifact);
  if (pathProblem !== undefined) return { present: false, note: pathProblem };
  try {
    const root = realpathSync(workspace);
    const target = realpathSync(resolve(workspace, artifact));
    const fromRoot = relative(root, target);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      return { present: false, note: `artifact "${artifact}" resolves outside the execution Workspace` };
    }
    return { present: true };
  } catch {
    return { present: false, note: `artifact "${artifact}" not found` };
  }
}
