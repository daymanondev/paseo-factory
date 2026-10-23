/** Shared acceptance execution. Entrances supply trusted caller authority
 * separately from the attribution carried by their transport codec.
 */
import type { AcceptInput, Factory } from "./core/factory.ts";
import type { AcceptanceRole } from "./core/task-state.ts";
import type { SurfaceDaemonApi } from "./surface-rpc.ts";
import { cleanupDaemonWorkspacesAndProjectsViaWs } from "./daemon-cli.ts";
import { projectStateDir, readProjectRegistration, resolveProject, writeProjectRegistration } from "./core/project.ts";
import type { LandingResult } from "./core/workspace.ts";
import { join } from "node:path";

export async function executeAcceptance(
  factory: Factory,
  input: Omit<AcceptInput, "authority">,
  deps: {
    authority: AcceptanceRole;
    daemon?: SurfaceDaemonApi;
    home?: string;
    cleanup?: typeof cleanupDaemonWorkspacesAndProjectsViaWs;
  },
) {
  const event = await factory.accept({ ...input, authority: deps.authority });
  await archiveAcceptedTaskWorkspace(factory, deps.daemon, input.task, deps.home, deps.cleanup);
  return event;
}

/**
 * The one acceptance sentence both reply surfaces print — the spool's accept
 * reply (the CLI's `factory accept`) and the surface's `factory.accept` RPC
 * (the UI's Accept). One wording, both doors; `landing` absent is the legacy
 * shared-checkout path (no landing ran).
 */
export function acceptanceSummary(input: { task: string; attempt: number; by: string; landing?: LandingResult["landing"]; landingNote?: string }): string {
  return (
    `task ${input.task} accepted at attempt ${input.attempt} by ${input.by}` +
    (input.landing === "landed"
      ? " · landed into <project-root>"
      : input.landing === "pending-conflict"
        ? ` · landing pending-conflict: ${input.landingNote ?? "(no reason recorded)"} — branch factory/${input.task} is preserved`
        : "")
  );
}

/**
 * Automatic archive of an Accepted Task's Paseo workspace (v0.0.23, ADR 0015 §6):
 * looks up `taskWorkspaces[task]` in `<projectStateDir>/project.json`, calls
 * `daemon.workspaces?.archive(workspaceId)` best-effort, and removes the entry
 * from `taskWorkspaces`. Since v0.0.27 (ADR 0017 §4) it also sweeps the
 * daemon's own records over the WebSocket (`archive_workspace_request` /
 * `project.remove.request` via `cleanupDaemonWorkspacesAndProjectsViaWs`) for
 * workspaces and projects rooted under `<projectStateDir>/worktrees/` or
 * missing on disk, so the accepted Task's worktree leaves no broken project
 * entry in Paseo Desktop. The daemon `home` targets the sweep (the caller's
 * `deps.home`; the spool's legacy 3-arg call falls back to `PASEO_HOME`).
 */
export async function archiveAcceptedTaskWorkspace(
  factory: Factory,
  daemon: SurfaceDaemonApi | undefined,
  task: string,
  home?: string,
  cleanup: typeof cleanupDaemonWorkspacesAndProjectsViaWs = cleanupDaemonWorkspacesAndProjectsViaWs,
): Promise<void> {
  const contract = factory.contractFor(task);
  if (contract === undefined) return;
  const project = resolveProject(contract.workspace);
  if (!project.ok) return;
  const reg = readProjectRegistration(factory.stateDir, project.slug);
  const workspaceId = reg?.taskWorkspaces?.[task];
  if (workspaceId === undefined) return;
  if (daemon?.workspaces?.archive !== undefined) {
    try {
      await daemon.workspaces.archive(workspaceId);
    } catch {
      // best-effort archive
    }
  }
  writeProjectRegistration(factory.stateDir, project.slug, {
    root: project.root,
    taskWorkspaces: { [task]: null },
  });
  // The daemon-record sweep (v0.0.27; v0.0.31's safe rules, ADR 0017 §4):
  // best-effort, never blocks the accept. The accepted task's worktree is the
  // ONE explicitly retired target — sibling worktree workspaces whose
  // directories still exist on disk (parallel Tasks with live Peers) are
  // never archived.
  try {
    const worktreesDir = join(projectStateDir(factory.stateDir, project.slug), "worktrees");
    await cleanup(home ?? process.env.PASEO_HOME, { worktreesDir, targetWorktreePath: join(worktreesDir, task) });
  } catch {
    // best-effort sweep
  }
}

