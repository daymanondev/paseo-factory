/**
 * The seat-directory starter's pure halves (v0.6.1 W4 spike, ADR 0057 §8/§11):
 * the plan builders that turn one `factory.seats.directory` answer into the
 * header-button and composer-pill registrations the client owes Paseo, and
 * the registration reconcile — paseo-room's role-pill pattern: a map of
 * registrations, `update` on change, `remove` on disappearance. Zero React
 * Native runtime imports so Node unit tests exercise the law directly (the
 * live-seats.ts precedent); the starter and popover live in
 * factory/directory.tsx.
 */
import type { WorkspaceRowBadgeTone } from "@getpaseo/plugin/client/ui";
import type { ProjectDirectoryEntry, SeatDirectoryEntry } from "../../shared/view.ts";

/** Zero-RN descriptor for Paseo's `WorkspaceRowBadge` in the sidebar workspace list. */
export interface WorkspaceRowBadgePlan {
  readonly label: string;
  readonly tone: WorkspaceRowBadgeTone;
  readonly icon: string;
  readonly accessibilityLabel: string;
}

/** Machine-wide Gate queue summary emitted by `factory.seats.directory`. */
export interface DirectoryGateQueueSummary {
  readonly paused: boolean;
  readonly concurrency: number;
  readonly runningCount: number;
  readonly queuedCount: number;
}

/** Zero-RN descriptor for the global `Factory` sidebar header row's trailing badge. */
export interface SidebarOverviewBadgePlan {
  readonly needsYouCount: number;
  readonly runningCount: number;
  readonly queuedCount: number;
  readonly paused: boolean;
  readonly label: string;
  readonly tone: "wait" | "ok";
}

/**
 * Computes the compact trailing badge descriptor for the desktop `Factory`
 * sidebar header entry, or `null` when no Project needs attention and no Gate
 * is running or queued.
 */
export function sidebarOverviewBadgePlan(
  projects: readonly ProjectDirectoryEntry[],
  gateQueue?: DirectoryGateQueueSummary | null,
): SidebarOverviewBadgePlan | null {
  const needsYouCount = projects.reduce((sum, project) => sum + (project.needsYouCount > 0 ? project.needsYouCount : 0), 0);
  const runningCount = gateQueue?.runningCount ?? projects.filter((project) => project.gateQueueStatus === "running").length;
  const queuedCount = gateQueue?.queuedCount ?? projects.filter((project) => project.gateQueueStatus === "queued").length;
  const paused = gateQueue?.paused ?? projects.some((project) => project.gateQueuePaused === true);

  if (needsYouCount === 0 && runningCount === 0 && queuedCount === 0) return null;

  const gateText =
    runningCount > 0
      ? queuedCount > 0
        ? `Gate running · +${queuedCount}`
        : "Gate running"
      : queuedCount > 0
        ? paused
          ? `Paused · ${queuedCount}`
          : `${queuedCount} queued`
        : "";

  const label =
    needsYouCount > 0 && gateText !== ""
      ? `Needs you · ${needsYouCount} · ${gateText}`
      : needsYouCount > 0
        ? `Needs you · ${needsYouCount}`
        : gateText;

  return {
    needsYouCount,
    runningCount,
    queuedCount,
    paused,
    label,
    tone: needsYouCount > 0 || runningCount === 0 ? "wait" : "ok",
  };
}

function createSidebarOverviewBadgeStore() {
  let badge: SidebarOverviewBadgePlan | null = null;
  let fingerprint = "null";
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): SidebarOverviewBadgePlan | null {
      return badge;
    },
    setSummary(projects: readonly ProjectDirectoryEntry[], gateQueue?: DirectoryGateQueueSummary | null): void {
      const next = sidebarOverviewBadgePlan(projects, gateQueue);
      const nextFingerprint = JSON.stringify(next);
      if (nextFingerprint === fingerprint) return;
      badge = next;
      fingerprint = nextFingerprint;
      notify();
    },
    clear(): void {
      if (badge === null) return;
      badge = null;
      fingerprint = "null";
      notify();
    },
  };
}

/** Shared sidebar overview badge store fed by `startSeatDirectory` and `OverviewScreen`. */
export const sidebarOverviewBadgeStore = createSidebarOverviewBadgeStore();

/**
 * Pure workspace-row badge planner: maps `(workspaceId, projects)` to the
 * highest-priority badge descriptor (`Needs you · N` > `Handing off` >
 * `Gate running` / `Gate #N` > active work / leftover background work), or
 * `null` when idle or not a Factory Project.
 */
export function workspaceRowBadgePlan(
  workspaceId: string,
  projects: readonly ProjectDirectoryEntry[],
): WorkspaceRowBadgePlan | null {
  if (workspaceId === "") return null;
  const project = projects.find(
    (entry) => typeof entry.workspaceId === "string" && entry.workspaceId !== "" && entry.workspaceId === workspaceId,
  );
  if (project === undefined) return null;

  if (project.needsYouCount > 0) {
    const label = `Needs you · ${project.needsYouCount}`;
    return {
      label,
      tone: "warning",
      icon: "AlertTriangle",
      accessibilityLabel: `Factory: ${label}`,
    };
  }
  if (project.handoffActive === true) {
    return {
      label: "Handing off",
      tone: "info",
      icon: "RefreshCw",
      accessibilityLabel: "Factory: Handing off",
    };
  }
  if (project.gateQueueStatus === "running") {
    return {
      label: "Gate running",
      tone: "success",
      icon: "Activity",
      accessibilityLabel: "Factory: Gate running",
    };
  }
  if (project.gateQueueStatus === "queued") {
    const pos =
      typeof project.gateQueuePosition === "number" &&
      Number.isFinite(project.gateQueuePosition) &&
      project.gateQueuePosition >= 1
        ? Math.trunc(project.gateQueuePosition)
        : null;
    const label = pos !== null ? `Gate #${pos}` : "Gate queued";
    return {
      label,
      tone: "warning",
      icon: "Clock",
      accessibilityLabel: project.gateQueuePaused ? `Factory: ${label} (paused)` : `Factory: ${label}`,
    };
  }
  const activeWorkCount = project.activeWorkCount ?? 0;
  if (activeWorkCount > 0) {
    const label = `${activeWorkCount} active`;
    return {
      label,
      tone: "success",
      icon: "Activity",
      accessibilityLabel: `Factory: ${activeWorkCount} active ${activeWorkCount === 1 ? "seat" : "seats"}`,
    };
  }
  const backgroundWorkCount = project.backgroundWorkCount ?? 0;
  if (backgroundWorkCount > 0) {
    const label = `${backgroundWorkCount} background`;
    return {
      label,
      tone: "warning",
      icon: "Activity",
      accessibilityLabel: `Factory: ${backgroundWorkCount} background ${backgroundWorkCount === 1 ? "process" : "processes"} running`,
    };
  }
  return null;
}

/** The header button's contribution id — `factory-header-<workspaceId>` (the spike's E2E hook). */
export const headerButtonId = (workspaceId: string): string => `factory-header-${workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

/** The composer pill's contribution id — `factory-pill-<agentId>` (the spike's E2E hook). */
export const pillId = (agentId: string): string => `factory-pill-${agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

/** The header label — "Factory" alone when nothing needs the Owner, "Factory · N" when N things do. */
export function headerLabel(needsYouCount: number): string {
  return needsYouCount > 0 ? `Factory · ${needsYouCount}` : "Factory";
}

/** What one registration-reconcile step needs: the button's id, its label, and what changed. */
export interface DirectoryPlan {
  readonly id: string;
  readonly label: string;
  /** Everything about the plan that must refresh the registration when it changes (the label alone rarely does). */
  readonly fingerprint: string;
}

/** One header-button plan — a Project root workspace with its Needs-you count. */
export interface HeaderButtonPlan extends DirectoryPlan {
  readonly workspaceId: string;
}

/** One composer-pill plan — a live seat agent with its whole directory row (the popover's data). */
export interface PillPlan extends DirectoryPlan {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly seat: SeatDirectoryEntry;
}

/** The header-button plans one directory answer implies — one per Project root workspace that reports one. */
export function headerPlans(projects: readonly ProjectDirectoryEntry[]): HeaderButtonPlan[] {
  const plans: HeaderButtonPlan[] = [];
  for (const project of projects) {
    if (typeof project.workspaceId !== "string" || project.workspaceId === "") continue; // nothing to anchor the button to
    const label = headerLabel(project.needsYouCount);
    plans.push({ id: headerButtonId(project.workspaceId), workspaceId: project.workspaceId, label, fingerprint: label });
  }
  return plans;
}

/** The composer-pill plans one directory answer implies — one per live seat agent that reports a workspace. */
export function pillPlans(seats: readonly SeatDirectoryEntry[]): PillPlan[] {
  const plans: PillPlan[] = [];
  for (const seat of seats) {
    if (typeof seat.workspaceId !== "string" || seat.workspaceId === "") continue; // a pill needs a workspace to sit in
    plans.push({
      id: pillId(seat.agentId),
      workspaceId: seat.workspaceId,
      agentId: seat.agentId,
      label: ["scheduled", "handing-over", "substitute", "creating-successor"].includes(seat.handoffState ?? "") ? `${seat.role} · handing off` : seat.role,
      seat,
      fingerprint: JSON.stringify(seat),
    });
  }
  return plans;
}

/** The registration handle the reconcile drives — Paseo's PluginButtonRegistration shape, generic over the update patch. */
export interface RegistrationLike<Patch = { label?: string }> {
  update(patch: Patch): void;
  remove(): void;
}

/**
 * Keeps one registration map in step with a directory answer: what appeared
 * registers, what changed updates in place, what disappeared is removed.
 * `fingerprint` decides "changed" — the label for header buttons, the whole
 * seat row for pills (a model or context change refreshes the popover).
 */
export function reconcileDirectory<T extends DirectoryPlan, Patch>(
  current: Map<string, { fingerprint: string; registration: RegistrationLike<Patch> }>,
  next: readonly T[],
  register: (plan: T) => RegistrationLike<Patch>,
  refresh: (registration: RegistrationLike<Patch>, plan: T) => void,
): void {
  const seen = new Set<string>();
  for (const plan of next) {
    seen.add(plan.id);
    const prior = current.get(plan.id);
    if (prior === undefined) {
      current.set(plan.id, { fingerprint: plan.fingerprint, registration: register(plan) });
    } else if (prior.fingerprint !== plan.fingerprint) {
      refresh(prior.registration, plan);
      prior.fingerprint = plan.fingerprint;
    }
  }
  for (const [id, entry] of current) {
    if (seen.has(id)) continue;
    entry.registration.remove();
    current.delete(id);
  }
}
