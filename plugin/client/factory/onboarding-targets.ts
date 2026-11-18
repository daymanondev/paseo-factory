/**
 * Pure project/workspace resolution helpers for the Global Onboarding screen
 * (`paseo-factory-onboard`, ADR 0063). No React or DOM imports; function-style
 * only so nothing class-shaped enters the Hermes bundle.
 */
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type { PluginPaseoApi } from "@getpaseo/plugin/client";
import type { ProjectDirectoryEntry } from "../../shared/view.ts";

export type PaseoWorkspaceKind = PluginWorkspaceSnapshot["kind"];

/** Minimal Paseo project fields from `paseo.projects.list()`. */
export interface PaseoProjectTarget {
  projectId: string;
  projectDisplayName: string;
  projectCustomName?: string | null | undefined;
  projectRootPath: string;
  projectKind: "directory" | "git" | "non_git";
}

/**
 * Minimal workspace fields from `paseo.workspaces.list()` (`PaseoWorkspace`)
 * or `PluginWorkspaceSnapshot`.
 */
export type WorkspaceCandidate =
  | {
      id: string;
      directory: string;
      kind: PaseoWorkspaceKind;
      archivingAt?: string | null;
      internal?: boolean;
      background?: boolean;
    }
  | {
      id: string;
      workspaceDirectory?: string;
      workspaceKind: PaseoWorkspaceKind;
      archivingAt?: string | null;
      internal?: boolean;
      background?: boolean;
    };

const REUSABLE_KINDS: ReadonlySet<PaseoWorkspaceKind> = new Set([
  "directory",
  "local_checkout",
  "checkout",
]);

/** Trims trailing slashes (preserving `"/"`) so host project roots match Factory roots reliably. */
export function normalizeFolderPath(folder: string): string {
  const trimmed = folder.trim();
  if (trimmed === "" || trimmed === "/") return trimmed;
  return trimmed.replace(/\/+$/, "");
}

function candidateKind(workspace: WorkspaceCandidate): PaseoWorkspaceKind {
  return "kind" in workspace ? workspace.kind : workspace.workspaceKind;
}

function candidateDirectory(workspace: WorkspaceCandidate): string {
  return "directory" in workspace ? workspace.directory : (workspace.workspaceDirectory ?? "");
}

/** True when `workspace` is an active non-worktree local Paseo workspace rooted at `projectRoot`. */
export function isReusableLocalWorkspace(workspace: WorkspaceCandidate, projectRoot: string): boolean {
  if (workspace.archivingAt !== undefined && workspace.archivingAt !== null && workspace.archivingAt !== "") {
    return false;
  }
  if (workspace.internal === true || workspace.background === true) {
    return false;
  }
  if (!REUSABLE_KINDS.has(candidateKind(workspace))) {
    return false;
  }
  const dir = candidateDirectory(workspace);
  if (dir.trim() === "") return false;
  const normalizedTarget = normalizeFolderPath(projectRoot);
  if (normalizedTarget === "") return false;
  return normalizeFolderPath(dir) === normalizedTarget;
}

/** Prefers an active `local_checkout` workspace over other reusable local kinds. */
export function selectReusableWorkspace(
  entries: readonly WorkspaceCandidate[],
  projectRoot: string,
): WorkspaceCandidate | undefined {
  const matches = entries.filter((entry) => isReusableLocalWorkspace(entry, projectRoot));
  return matches.find((entry) => candidateKind(entry) === "local_checkout") ?? matches[0];
}

/** True when `rootPath` matches any Project root already registered in Factory. */
export function isFactoryRegisteredRoot(
  rootPath: string,
  registeredProjects: readonly Pick<ProjectDirectoryEntry, "root">[],
): boolean {
  const normalized = normalizeFolderPath(rootPath);
  if (normalized === "") return false;
  return registeredProjects.some((project) => normalizeFolderPath(project.root) === normalized);
}

function projectRootOf(project: { rootPath: string } | { projectRootPath: string }): string {
  return "projectRootPath" in project ? project.projectRootPath : project.rootPath;
}

/** Display label for a Paseo project (`projectCustomName` overrides `projectDisplayName`). */
export function projectDisplayLabel(project: Pick<PaseoProjectTarget, "projectDisplayName" | "projectCustomName">): string {
  const custom = project.projectCustomName?.trim();
  return custom ? custom : project.projectDisplayName;
}

/** Pure filter helper for unregistered Paseo projects. */
export function filterUnregisteredProjects<T extends { rootPath: string } | { projectRootPath: string }>(
  projects: readonly T[],
  registeredProjects: readonly Pick<ProjectDirectoryEntry, "root">[],
): T[] {
  return projects.filter((project) => !isFactoryRegisteredRoot(projectRootOf(project), registeredProjects));
}

async function listProjectsSafely(paseo: PluginPaseoApi | undefined): Promise<readonly PaseoProjectTarget[]> {
  if (typeof paseo?.projects?.list !== "function") return [];
  try {
    const res = await paseo.projects.list();
    return Array.isArray(res?.projects) ? res.projects : [];
  } catch {
    return [];
  }
}

/** Reuses an existing active local workspace for `projectRoot`, or creates a clean one without a dummy agent. */
export async function resolveOrCreateProjectWorkspace({
  paseo,
  projectRoot,
  paseoProjects = [],
}: {
  paseo: PluginPaseoApi | undefined;
  projectRoot: string;
  paseoProjects?: readonly PaseoProjectTarget[];
}): Promise<{ workspaceId: string | null; error: string | null }> {
  if (typeof paseo?.workspaces?.list === "function") {
    try {
      const listed = await paseo.workspaces.list();
      const reusable = selectReusableWorkspace(listed.entries, projectRoot);
      if (reusable !== undefined) {
        return { workspaceId: reusable.id, error: null };
      }
    } catch {
      // Fall through to workspace creation.
    }
  }

  const normalizedRoot = normalizeFolderPath(projectRoot);
  let matchingProject = paseoProjects.find((p) => normalizeFolderPath(p.projectRootPath) === normalizedRoot);
  if (matchingProject === undefined) {
    const freshProjects = await listProjectsSafely(paseo);
    matchingProject = freshProjects.find((p) => normalizeFolderPath(p.projectRootPath) === normalizedRoot);
  }

  try {
    if (typeof paseo?.workspaces?.create === "function") {
      const created = await paseo.workspaces.create({
        source: {
          kind: "directory",
          path: projectRoot,
          ...(matchingProject !== undefined ? { projectId: matchingProject.projectId } : {}),
        },
      });
      return { workspaceId: created.id, error: null };
    }
    return { workspaceId: null, error: "Paseo workspace API is unavailable." };
  } catch (error) {
    return { workspaceId: null, error: error instanceof Error ? error.message : String(error) };
  }
}
