/**
 * The console's view-model seam (ADR 0051 §6, T-02) — the ONE data module
 * that turns `FactoryView` into screen view-models. Screens never fold the
 * raw view themselves, so normalization lives in exactly one place.
 *
 * The Meter law, enforced here and nowhere else: `total = inputUncached +
 * cacheRead + cacheWrite + output` — always computed from the four disjoint
 * buckets, never trusted from a wire total. `reasoningTokens` is reported as
 * a subset of `outputTokens`, never added. The prototype's
 * `inputTokens`/`cachedInputTokens` shape is never adopted — a meter that
 * cannot name its four buckets refuses to invent them.
 */
import type { AttemptView, FactoryView, OwnerRequestView, ProjectView, TaskDetailView, TaskStatus, TaskView, UsageBucketsView } from "../../plugin/shared/view.ts";

// ---- the Meter law --------------------------------------------------------------------------

export interface MeterViewModel {
  inputUncachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** A subset of `outputTokens`, shown as such — never part of the sum. */
  reasoningTokens: number;
  /** inputUncachedTokens + cacheReadTokens + cacheWriteTokens + outputTokens, computed here. */
  totalTokens: number;
  /** Summed session cost — null when no session reported dollars (never a fabricated zero). */
  totalCostUsd: number | null;
}

/**
 * Normalizes one usage row into the Meter view-model. The wire's own
 * `totalTokens` is ignored on purpose: the seam computes the lawful sum, so
 * an inconsistent wire row renders the truth of its buckets, and a row
 * without buckets answers `null` — never a half-shape.
 */
export function meterFromBuckets(buckets: UsageBucketsView | null | undefined): MeterViewModel | null {
  if (buckets === null || buckets === undefined) return null;
  const inputUncachedTokens = buckets.inputUncachedTokens;
  const cacheReadTokens = buckets.cacheReadTokens;
  const cacheWriteTokens = buckets.cacheWriteTokens;
  const outputTokens = buckets.outputTokens;
  return {
    inputUncachedTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens: buckets.reasoningTokens,
    totalTokens: inputUncachedTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    totalCostUsd: buckets.totalCostUsd,
  };
}

/** `12.4k` / `1.2M` — compact, tabular-safe token counts (one decimal under 100 of the unit). */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count / 1_000_000 < 100 ? 1 : 0)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count / 1_000 < 100 ? 1 : 0)}k`;
  return String(count);
}

/** The meter's one honest sentence — reasoning shown as a subset of output, never added. */
export function meterLabel(meter: MeterViewModel): string {
  const total = formatTokens(meter.totalTokens);
  const reasoning =
    meter.reasoningTokens > 0 ? ` (incl. ${formatTokens(meter.reasoningTokens)} reasoning in output)` : "";
  return `${total} tokens — in ${formatTokens(meter.inputUncachedTokens)} · cache read ${formatTokens(
    meter.cacheReadTokens,
  )} · cache write ${formatTokens(meter.cacheWriteTokens)} · out ${formatTokens(meter.outputTokens)}${reasoning}`;
}

// ---- the Tasks screen ------------------------------------------------------------------------

/** The CONTEXT.md status vocabulary, verbatim — the fold's own state machine. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  "accepted",
  "needs-human",
  "running",
  "ready-to-accept",
  "red",
  "waiting",
];

// ---- the board columns (T-03) -----------------------------------------------------------------

/** The board's five columns — the CONTEXT.md statuses grouped the way both Factory surfaces group them. */
export type BoardColumnId = "queued" | "in_progress" | "needs_attention" | "ready_to_accept" | "accepted";

export const TASK_COLUMNS: readonly { id: BoardColumnId; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "in_progress", label: "In Progress" },
  { id: "needs_attention", label: "Needs Attention" },
  { id: "ready_to_accept", label: "Ready to Accept" },
  { id: "accepted", label: "Accepted" },
] as const;

/**
 * The column law — mirrors `plugin/client/factory/kanban.ts`
 * (`kanbanColumnForStatus`), kept in step by `view-model.test.ts`: a `red`
 * Task stands in Needs Attention beside `needs-human` (an unaccepted red
 * verdict awaits a Respawn or the Owner either way), `waiting` is Queued.
 */
export function boardColumnForStatus(status: TaskStatus): BoardColumnId {
  switch (status) {
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

export interface TaskRowViewModel {
  task: string;
  workspace: string;
  status: TaskStatus;
  /** The display spelling (`ready to accept`, `needs human · <reason>`). */
  statusLabel: string;
  /** The prototype's badge tone for the status. */
  tone: "green" | "amber" | "red" | "cyan";
  description: string | null;
  attemptCount: number;
  /** The green `Attempt` the Accept act submits — null unless ready-to-accept names one. */
  acceptAttempt: number | null;
  /** The usage rollup's model for this task, when the rollup knows one. */
  model: string | null;
  /** The task's aggregated meter — null when no usage row covers it. */
  meter: MeterViewModel | null;
  /** The board column this Task stands in — the fold's own grouping, never the screen's. */
  column: BoardColumnId;
  /** The Task's Project label — set only in the `All projects` scope (each card names its Project). */
  project: string | null;
  /** `Scrum · <role>` / `SLP · Peer` — the mode badge, from the Contract's execution binding. */
  modeLabel: string;
  /** The needs-human reason line — the blocker copy the card shows under the title. */
  needsHumanReason: string | null;
}

export interface TasksScreenViewModel {
  /** The scope's name — the selected Project, or "All projects". */
  scope: string;
  rows: readonly TaskRowViewModel[];
  /** The scoped Project's rollup meter — null on the unscoped view or with no sessions. */
  meter: MeterViewModel | null;
  counts: Readonly<Record<TaskStatus, number>>;
  /** The filter chips' counts — computed from THIS scope's tasks only (the prototype counted across all Projects; the scoped snapshot makes the fix structural). */
  columnCounts: Readonly<Record<BoardColumnId, number>>;
  /** The board's five columns in display order, each with its own cards. */
  board: readonly { id: BoardColumnId; label: string; rows: readonly TaskRowViewModel[] }[];
}

const STATUS_TONES: Record<TaskStatus, TaskRowViewModel["tone"]> = {
  accepted: "green",
  "needs-human": "amber",
  running: "cyan",
  "ready-to-accept": "green",
  red: "red",
  waiting: "cyan",
};

/**
 * The green `Attempt` an Accept submits — the RN client's own law
 * (`plugin/client/factory/tasks.tsx`): the LAST closed green attempt. A
 * ready-to-accept task with no green attempt shows no button rather than a
 * guess.
 */
export function acceptAttemptFor(task: TaskView): number | null {
  const green = task.attempts.findLast((attempt) => attempt.verdict === "green" && !attempt.open);
  return green === undefined ? null : green.n;
}

function statusLabel(task: TaskView): string {
  if (task.status === "needs-human") {
    return task.needsHumanReason === null || task.needsHumanReason === undefined ? "needs human" : `needs human · ${task.needsHumanReason}`;
  }
  if (task.status === "ready-to-accept") return "ready to accept";
  return task.status;
}

/** Turns the snapshot into the Tasks screen's rows — statuses stay the CONTEXT.md vocabulary. */
export function tasksScreenModel(view: FactoryView): TasksScreenViewModel {
  const usageByTask = new Map((view.projectUsage?.byTask ?? []).map((row) => [row.task, row]));
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
  const scoped = view.project !== null;
  const rows = view.tasks.map((task) => {
    counts[task.status] += 1;
    return {
      task: task.task,
      workspace: task.workspace,
      status: task.status,
      statusLabel: statusLabel(task),
      tone: STATUS_TONES[task.status],
      description: task.description,
      attemptCount: task.attempts.length,
      acceptAttempt: task.status === "ready-to-accept" ? acceptAttemptFor(task) : null,
      model: task.usageModel ?? usageByTask.get(task.task)?.model ?? null,
      meter: meterFromBuckets(usageByTask.get(task.task)),
      column: boardColumnForStatus(task.status),
      project: scoped ? null : projectNameForTask(task, view.projects),
      modeLabel: task.execution === undefined ? "SLP · Peer" : `Scrum · ${task.execution.role}`,
      needsHumanReason: task.needsHumanReason ?? null,
    };
  });
  const columnCounts = Object.fromEntries(TASK_COLUMNS.map((column) => [column.id, 0])) as Record<BoardColumnId, number>;
  for (const row of rows) columnCounts[row.column] += 1;
  return {
    scope: view.project === null ? "All projects" : (view.project.name ?? view.project.slug),
    rows,
    meter: meterFromBuckets(view.projectUsage?.totals),
    counts,
    columnCounts,
    board: TASK_COLUMNS.map((column) => ({ id: column.id, label: column.label, rows: rows.filter((row) => row.column === column.id) })),
  };
}

/** The filter chips' vocabulary — `all` plus the board's five columns. */
export type TaskFilter = "all" | BoardColumnId;

export const TASK_FILTERS: readonly { id: TaskFilter; label: string }[] = [
  { id: "all", label: "All" },
  ...TASK_COLUMNS,
];

/** The chip's own law: `all` keeps every row; a column chip keeps that column's rows. */
export function filterTaskRows(rows: readonly TaskRowViewModel[], filter: TaskFilter): readonly TaskRowViewModel[] {
  return filter === "all" ? rows : rows.filter((row) => row.column === filter);
}

// ---- the Inbox screen (T-05) --------------------------------------------------------------------

/** A Task row as the aggregate snapshot carries it — the additive `projectSlug` an older schema never declared. */
type ScopedTaskView = TaskView & { projectSlug?: string };

/** The `factory.inbox` gather's ok arm — the Scrum half the snapshot cannot carry. */
export interface InboxGather {
  /** One row per Project whose active run holds at least one Owner request. */
  projects: readonly { projectSlug: string; runId: string; phase: string; requests: readonly OwnerRequestView[] }[];
  /** Per-Project read refusals — a damaged run journal renders as data. */
  refusals: readonly { projectSlug: string; error: string }[];
  /** The transport's own refusal (`Failure` arm) — rendered as data, never thrown. */
  error: string | null;
}

/** The urgency ladder — the Owner's blocked work first, the bookkeeping last (an Owner wait has no expiry; rank, not age, orders). */
export type InboxItemKind = "needs-human" | "red" | "owner-request" | "ready-to-accept";

const INBOX_RANK: Record<InboxItemKind, number> = {
  "needs-human": 0,
  red: 1,
  "owner-request": 2,
  "ready-to-accept": 3,
};

export interface InboxItemViewModel {
  kind: InboxItemKind;
  /** The urgency rank — the list sorts by it, stably within a kind. */
  rank: number;
  /** The badge word — BLOCKER / RED GATE / QUESTION / UI APPROVAL / READY TO ACCEPT. */
  badge: string;
  tone: "green" | "amber" | "red" | "cyan";
  /** The item's title — the Task's description, or the question itself. */
  title: string;
  /** The one-line reason this waits on the Owner. */
  detail: string;
  /** The owning Project's display name — every item names its Project. */
  projectName: string;
  /** The owning Project's root — the deep link's scope (`null` when the snapshot names no Project for it). */
  projectRoot: string | null;
  /** The Task the item names — null on a Scrum request (its `affected` carries the held ids). */
  task: string | null;
  /** The green `Attempt` an inline Accept submits — ready-to-accept items only. */
  acceptAttempt: number | null;
  /** The Scrum run an Owner request waits on — owner-request items only. */
  runId: string | null;
  /** `${actor} · ${role}` — who asked. */
  origin: string | null;
}

export interface InboxViewModel {
  items: readonly InboxItemViewModel[];
  /** The gather's per-Project refusals plus its transport refusal — data, never a failed screen. */
  refusals: readonly { projectSlug: string; error: string }[];
  /** The transport-level gather refusal, rendered above the list. */
  gatherError: string | null;
  /** The nav badge's count — always `items.length`. */
  count: number;
}

/** The Project display name for a slug — the snapshot's own `projects` rows, the slug itself the honest fallback. */
function projectNameForSlug(slug: string, projects: readonly ProjectView[]): { name: string; root: string | null } {
  const matched = projects.find((project) => project.slug === slug);
  if (matched === undefined) return { name: slug, root: null };
  if (typeof matched.name === "string" && matched.name.trim() !== "") return { name: matched.name.trim(), root: matched.root };
  return { name: lastPathSegment(matched.root) || matched.slug, root: matched.root };
}

/** `Holds task T-03, stage implementation` — the request's own affected list, verbatim. */
function holdsLabel(request: OwnerRequestView): string {
  const held = request.affected.map((dependency) => `${dependency.kind} ${dependency.id}`);
  return held.length > 0 ? `Holds ${held.join(", ")}` : "Holds the run";
}

/**
 * The Inbox fold — a PURE fold of the two halves the console already holds:
 * the snapshot's Task rows (needs-human, red, ready-to-accept — statuses stay
 * the CONTEXT.md vocabulary) joined with the `factory.inbox` gather's pending
 * Owner requests (the console filters `pending`; the read answers every
 * status verbatim). One item per thing needing the Owner, sorted by urgency,
 * every item naming its Project. The snapshot carries `projectSlug`
 * additively on each row; without it (a scoped view) the workspace→Project
 * law (`projectNameForTask`) attributes the row instead.
 */
export function inboxModel(view: FactoryView, gather: InboxGather | null): InboxViewModel {
  const items: InboxItemViewModel[] = [];
  for (const task of view.tasks as readonly ScopedTaskView[]) {
    const attributed =
      task.projectSlug !== undefined
        ? projectNameForSlug(task.projectSlug, view.projects)
        : { name: projectNameForTask(task, view.projects), root: null };
    const byWorkspace = attributed.root === null ? projectRootForTask(task, view.projects) : attributed.root;
    if (task.status === "needs-human") {
      items.push({
        kind: "needs-human",
        rank: INBOX_RANK["needs-human"],
        badge: "BLOCKER",
        tone: "amber",
        title: task.description ?? task.task,
        detail: task.needsHumanReason ?? "The Task stopped and waits on you",
        projectName: attributed.name,
        projectRoot: byWorkspace,
        task: task.task,
        acceptAttempt: null,
        runId: null,
        origin: null,
      });
    } else if (task.status === "red") {
      items.push({
        kind: "red",
        rank: INBOX_RANK.red,
        badge: "RED GATE",
        tone: "red",
        title: task.description ?? task.task,
        detail: "The latest attempt is red — awaiting a Respawn or you",
        projectName: attributed.name,
        projectRoot: byWorkspace,
        task: task.task,
        acceptAttempt: null,
        runId: null,
        origin: null,
      });
    } else if (task.status === "ready-to-accept") {
      const acceptAttempt = acceptAttemptFor(task);
      if (acceptAttempt === null) continue; // no green attempt to submit — no button rather than a guess
      items.push({
        kind: "ready-to-accept",
        rank: INBOX_RANK["ready-to-accept"],
        badge: "READY TO ACCEPT",
        tone: "green",
        title: task.description ?? task.task,
        detail: "The latest attempt is green and ready for Owner acceptance.",
        projectName: attributed.name,
        projectRoot: byWorkspace,
        task: task.task,
        acceptAttempt,
        runId: null,
        origin: null,
      });
    }
  }
  if (gather !== null) {
    for (const project of gather.projects) {
      for (const request of project.requests) {
        if (request.status !== "pending") continue; // the fold filters pending; the read answers every status
        const attributed = projectNameForSlug(project.projectSlug, view.projects);
        items.push({
          kind: "owner-request",
          rank: INBOX_RANK["owner-request"],
          badge: request.kind === "design" ? "UI APPROVAL" : "QUESTION",
          tone: request.kind === "design" ? "amber" : "cyan",
          title: request.question,
          detail: `${holdsLabel(request)} — independent authorized work may continue.`,
          projectName: attributed.name,
          projectRoot: attributed.root,
          task: request.affected.find((dependency) => dependency.kind === "task")?.id ?? null,
          acceptAttempt: null,
          runId: project.runId,
          origin: `${request.origin.actor} · ${request.origin.role}`,
        });
      }
    }
  }
  items.sort((a, b) => a.rank - b.rank);
  return {
    items,
    refusals: gather?.refusals ?? [],
    gatherError: gather?.error ?? null,
    count: items.length,
  };
}

/** The owning Project's root by workspace attribution — the `projectNameForTask` law, root arm. */
function projectRootForTask(task: Pick<TaskView, "workspace">, projects: readonly ProjectView[]): string | null {
  const workspace = task.workspace.replace(/\/+$/, "");
  const matched = projects.find((project) => {
    const root = project.root.replace(/\/+$/, "");
    return workspace === root || workspace.startsWith(`${root}/`) || workspace.includes(`/projects/${project.slug}/worktrees/`);
  });
  return matched?.root ?? null;
}

function lastPathSegment(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.length > 0 ? (segments[segments.length - 1] as string) : path;
}

/**
 * The card's Project label in the `All projects` scope — the RN client's own
 * fold (`projectNameForTask`): a Task's workspace names its Project's root,
 * a path under it, or the Project's worktree carve-out.
 */
export function projectNameForTask(task: Pick<TaskView, "workspace">, projects: readonly ProjectView[]): string {
  const workspace = task.workspace.replace(/\/+$/, "");
  const matched = projects.find((project) => {
    const root = project.root.replace(/\/+$/, "");
    return workspace === root || workspace.startsWith(`${root}/`) || workspace.includes(`/projects/${project.slug}/worktrees/`);
  });
  if (matched !== undefined) {
    if (typeof matched.name === "string" && matched.name.trim() !== "") return matched.name.trim();
    return lastPathSegment(matched.root) || matched.slug;
  }
  return lastPathSegment(workspace) || "workspace";
}

// ---- the Task Detail (T-03) --------------------------------------------------------------------

/** The Watch pass as the ladder rung reads it — a passenger's answers, never a judge. */
export interface WatchRungViewModel {
  outcome: string;
  model: string;
  error: string | null;
  maxProbability: number | null;
  answers: Readonly<Record<string, number | null>> | null;
}

/** The Fresh-eyes pass as the ladder rung reads it (`eye`) — advisory, green only. */
export interface EyeRungViewModel {
  outcome: string;
  model: string;
  finding: string;
}

export interface AttemptRungViewModel {
  n: number;
  /** The attempt's latest gate verdict — null while the attempt is open or never gated. */
  verdict: "green" | "red" | null;
  /** `Gate green` / `Gate red` / `Running` / `Pending` — the prototype's ladder summary spelling. */
  verdictLabel: string;
  verdictTone: "green" | "red" | "cyan" | "muted";
  exit: number | null;
  note: string | null;
  sha: string | null;
  /** A Respawn landed before this attempt's Claim — the ↻ badge. */
  respawned: boolean;
  agentId: string | null;
  /** The Fresh-eyes review state over this attempt (`off`/`pending`/…/`concern`). */
  reviewState: AttemptView["reviewState"];
  watch: WatchRungViewModel | null;
  eye: EyeRungViewModel | null;
  /** The tailed Report content — null when the handler found no file. */
  report: string | null;
  /** The tailed gate-log content — null when the handler found no file. */
  gateLog: string | null;
}

export interface TaskDetailViewModel {
  task: string;
  description: string | null;
  status: TaskStatus;
  statusLabel: string;
  tone: TaskRowViewModel["tone"];
  attemptCount: number;
  acceptAttempt: number | null;
  contract: {
    gate: string;
    artifact: string;
    scope: readonly string[] | null;
    skills: readonly string[] | null;
    base: string | null;
    description: string | null;
    watch: boolean;
    freshEyes: boolean;
    by: string | null;
    workspace: string;
  };
  /** The Attempt ladder, #1 → #N — each rung joins the fold's view with the handler's tailed content. */
  rungs: readonly AttemptRungViewModel[];
}

function rungVerdict(attempt: Pick<AttemptView, "verdict" | "open">): { label: string; tone: AttemptRungViewModel["verdictTone"] } {
  if (attempt.verdict === "green") return { label: "Gate green", tone: "green" };
  if (attempt.verdict === "red") return { label: "Gate red", tone: "red" };
  return attempt.open ? { label: "Running", tone: "cyan" } : { label: "Pending", tone: "muted" };
}

/**
 * Joins the detail's two halves into the ladder the screen renders: the
 * fold's AttemptViews (verdict, exit, note, SHA, ↻, watch, eye) with the
 * handler's per-attempt tailed Report and gate-log content.
 */
export function taskDetailModel(detail: TaskDetailView): TaskDetailViewModel {
  const task = detail.task;
  const contents = new Map(detail.attempts.map((attempt) => [attempt.n, attempt]));
  const rungs: AttemptRungViewModel[] = task.attempts.map((attempt) => {
    const content = contents.get(attempt.n);
    const verdict = rungVerdict(attempt);
    return {
      n: attempt.n,
      verdict: attempt.verdict,
      verdictLabel: verdict.label,
      verdictTone: verdict.tone,
      exit: attempt.exit,
      note: attempt.note,
      sha: attempt.sha,
      respawned: attempt.respawned,
      agentId: attempt.agentId ?? content?.agentId ?? null,
      reviewState: attempt.reviewState,
      watch: attempt.watch === null
        ? null
        : {
            outcome: attempt.watch.outcome,
            model: attempt.watch.model,
            error: attempt.watch.error,
            maxProbability: attempt.watch.maxProbability,
            answers: attempt.watch.answers,
          },
      eye: attempt.eye === null ? null : { outcome: attempt.eye.outcome, model: attempt.eye.model, finding: attempt.eye.finding },
      report: content?.report ?? null,
      gateLog: content?.gateLog ?? null,
    };
  });
  return {
    task: task.task,
    description: task.description,
    status: task.status,
    statusLabel: statusLabel(task),
    tone: STATUS_TONES[task.status],
    attemptCount: task.attempts.length,
    acceptAttempt: task.status === "ready-to-accept" ? acceptAttemptFor(task) : null,
    contract: {
      gate: detail.contract.gate,
      artifact: detail.contract.artifact,
      scope: detail.contract.scope,
      skills: detail.contract.skills,
      base: detail.contract.base,
      description: detail.contract.description,
      watch: detail.contract.watch,
      freshEyes: detail.contract.freshEyes,
      by: detail.contract.by,
      workspace: detail.contract.workspace,
    },
    rungs,
  };
}
