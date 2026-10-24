/**
 * Pure 5-column Kanban definitions and Task grouping helpers for the `Tasks`
 * verification board (v0.0.35, ADR 0025). Zero React Native runtime imports so
 * Node unit tests can exercise column mapping and grouping directly.
 */
import type { ProjectView, TaskStatus, TaskView } from "../../shared/view.ts";
import type { Colour } from "../kit/theme.ts";

export type KanbanColumnId =
  | "queued"
  | "in_progress"
  | "needs_attention"
  | "ready_to_accept"
  | "accepted";

export type KanbanTaskStatus = TaskStatus | "contracted";

export type KanbanLayoutMode = "wide" | "medium" | "compact";

export interface AttemptTrailItem {
  n: number;
  verdict: "red" | "green" | null;
  open: boolean;
  respawned: boolean;
}

export interface KanbanColumnDef {
  id: KanbanColumnId;
  title: string;
  tone: Colour;
  icon: string;
  emptyCopy: string;
}

export const KANBAN_COLUMNS: readonly KanbanColumnDef[] = [
  {
    id: "queued",
    title: "Queued",
    tone: "foregroundMuted",
    icon: "Clock",
    emptyCopy: "No queued contracts",
  },
  {
    id: "in_progress",
    title: "In Progress",
    tone: "accent",
    icon: "Play",
    emptyCopy: "No active runs",
  },
  {
    id: "needs_attention",
    title: "Needs Attention",
    tone: "statusWarning",
    icon: "AlertTriangle",
    emptyCopy: "No blockers or red gates",
  },
  {
    id: "ready_to_accept",
    title: "Ready to Accept",
    tone: "statusSuccess",
    icon: "CheckCircle2",
    emptyCopy: "Nothing awaiting acceptance",
  },
  {
    id: "accepted",
    title: "Accepted",
    tone: "statusSuccess",
    icon: "CheckCheck",
    emptyCopy: "No accepted tasks yet",
  },
] as const;

/** Maps a Task's verification status (`TaskStatus` or `"contracted"`) to its canonical Kanban column. */
export function kanbanColumnForStatus(status: KanbanTaskStatus): KanbanColumnId {
  switch (status) {
    case "contracted":
    case "waiting":
      return "queued";
    case "running":
      return "in_progress";
    case "needs-human":
    case "red":
      return "needs_attention";
    case "ready-to-accept":
      return "ready_to_accept";
    case "accepted":
      return "accepted";
  }
}

/** Groups tasks into the 5 canonical Kanban columns in first-appearance order. */
export function groupTasksForKanban<T extends { status: KanbanTaskStatus } = TaskView>(
  tasks: readonly T[],
): Record<KanbanColumnId, T[]> {
  const grouped: Record<KanbanColumnId, T[]> = {
    queued: [],
    in_progress: [],
    needs_attention: [],
    ready_to_accept: [],
    accepted: [],
  };
  for (const task of tasks) {
    grouped[kanbanColumnForStatus(task.status)].push(task);
  }
  return grouped;
}

function lastPathSegment(path: string): string {
  const segments = path.split("/").filter((s) => s !== "");
  return segments.length > 0 ? (segments[segments.length - 1] as string) : path;
}

/** Resolves a human-readable Project label for a Task when viewing `All projects` (`view.project === null`). */
export function projectNameForTask(
  task: Pick<TaskView, "workspace">,
  projects: readonly ProjectView[],
): string {
  const ws = task.workspace.replace(/\/+$/, "");
  const matched = projects.find((entry) => {
    const root = entry.root.replace(/\/+$/, "");
    return (
      ws === root ||
      ws.startsWith(`${root}/`) ||
      ws.includes(`/projects/${entry.slug}/worktrees/`)
    );
  });
  if (matched !== undefined) {
    if (typeof matched.name === "string" && matched.name.trim() !== "") {
      return matched.name.trim();
    }
    return lastPathSegment(matched.root) || matched.slug;
  }
  return lastPathSegment(ws) || "workspace";
}

/**
 * Resolves the responsive Kanban layout tier from the measured container width
 * and Paseo's `layout.compact` flag:
 * - `"compact"`: `< 640px` or `compact === true` (Workspace Panel / mobile)
 * - `"medium"`: `640px – 959px` (split window / tablet)
 * - `"wide"`: `>= 960px` (desktop global screen)
 */
export function resolveKanbanLayoutMode(input: {
  containerWidth?: number;
  compact?: boolean;
}): KanbanLayoutMode {
  if (input.compact === true) return "compact";
  const w = input.containerWidth ?? 0;
  if (w > 0 && w < 640) return "compact";
  if (w > 0 && w < 960) return "medium";
  return "wide";
}

/**
 * Computes how many card columns a populated Kanban column should use internally
 * so a single heavy column (e.g. 15 `Accepted` tasks when the other 4 columns
 * are empty) flows as a balanced 2–3 column grid instead of a tall single tower.
 */
export function computeCardGridColumns(input: {
  layoutMode: KanbanLayoutMode;
  containerWidth?: number;
  activeColumnCount: number;
  cardCount: number;
}): number {
  if (input.layoutMode === "compact" || input.cardCount < 4) return 1;
  const w = input.containerWidth ?? 1200;
  if (input.activeColumnCount <= 1) {
    if (input.layoutMode === "wide" && w >= 1260 && input.cardCount >= 6) return 3;
    return 2;
  }
  if (input.activeColumnCount === 2 && input.layoutMode === "wide" && w >= 1280 && input.cardCount >= 6) {
    return 2;
  }
  return 1;
}

/**
 * Condenses a Task's attempt history into a bounded status-dot trail so cards
 * with multi-epoch retry histories (`#1..#9`) stay scannable on a single line.
 */
export function summarizeAttemptTrail<T extends AttemptTrailItem>(
  attempts: readonly T[],
  maxDots = 5,
): {
  visible: readonly T[];
  hiddenCount: number;
  respawnCount: number;
} {
  const cap = Math.max(1, maxDots);
  const hiddenCount = Math.max(0, attempts.length - cap);
  const visible = hiddenCount > 0 ? attempts.slice(attempts.length - cap) : attempts;
  const respawnCount = attempts.filter((a) => a.respawned).length;
  return { visible, hiddenCount, respawnCount };
}
