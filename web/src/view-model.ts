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
import type { AgentView, AttemptView, FactoryView, OwnerRequestView, ProjectView, ScrumRunView, TaskDetailView, TaskStatus, TaskView, UsageBucketsView } from "../../plugin/shared/view.ts";
import type { AgentTranscriptEntry } from "../../plugin/shared/rpc.ts";
import type { AgentTranscriptReply } from "./transcript.ts";

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
  "closed",
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
    // A clean retirement (v0.5.0, ADR 0054 §5) is terminal history like an
    // acceptance — it stands in the accepted column, never the open tiles.
    case "closed":
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
  closed: "green",
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
  /** One row per Project whose active run holds an Owner request or a grant-remediable budget blocker. */
  projects: readonly {
    projectSlug: string;
    runId: string;
    phase: string;
    requests: readonly OwnerRequestView[];
    /** T-06 (additive): the run journal's revision — the command's `expectedRevision`. */
    revision?: number;
    /** T-06 (additive): the run's count-based allowance state — the Grant item's used/allowed data. */
    allowance?: { tasksUsed: number; tasksAllowed: number; qaFixRoundsUsed: number; qaFixRoundsAllowed: number };
    /** T-06 (additive): the run's blocker details verbatim — the fold filters the grant-remediable causes. */
    blockers?: readonly { id: string; reason: string; causes: readonly string[] }[];
  }[];
  /** Per-Project read refusals — a damaged run journal renders as data. */
  refusals: readonly { projectSlug: string; error: string }[];
  /** The transport's own refusal (`Failure` arm) — rendered as data, never thrown. */
  error: string | null;
}

/** The urgency ladder — the Owner's blocked work first, the bookkeeping last (an Owner wait has no expiry; rank, not age, orders). */
export type InboxItemKind = "needs-human" | "red" | "owner-request" | "budget-blocked" | "ready-to-accept";

const INBOX_RANK: Record<InboxItemKind, number> = {
  "needs-human": 0,
  red: 1,
  "owner-request": 2,
  "budget-blocked": 3,
  "ready-to-accept": 4,
};

export interface InboxItemViewModel {
  kind: InboxItemKind;
  /** The urgency rank — the list sorts by it, stably within a kind. */
  rank: number;
  /** The badge word — BLOCKER / RED GATE / QUESTION / UI APPROVAL / ALLOWANCE / READY TO ACCEPT. */
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
  /** The Scrum run an Owner request waits on — owner-request and budget-blocked items. */
  runId: string | null;
  /** `${actor} · ${role}` — who asked. */
  origin: string | null;
  /** The pending request's own id — `wait.answer` / `wait.cancel`'s `pendingId` (owner-request items). */
  pendingId: string | null;
  /** Which of the two Owner-request shapes the item is — the form's own law (owner-request items). */
  requestKind: "question" | "design" | null;
  /** The design under review, revision and digest — `design.decide`'s payload binds to it exactly (design items). */
  design: { revision: number; digest: string } | null;
  /** The run journal's revision as the gather carried it — every command's `expectedRevision`. */
  expectedRevision: number | null;
  /** The blocker causes a grant can remedy — the Grant form offers exactly these (budget-blocked items). */
  grantCauses: readonly ("tasks" | "qaFixRounds")[];
  /** The run's used/allowance counts, verbatim (budget-blocked items). */
  allowance: { tasksUsed: number; tasksAllowed: number; qaFixRoundsUsed: number; qaFixRoundsAllowed: number } | null;
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
        pendingId: null,
        requestKind: null,
        design: null,
        expectedRevision: null,
        grantCauses: [],
        allowance: null,
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
        pendingId: null,
        requestKind: null,
        design: null,
        expectedRevision: null,
        grantCauses: [],
        allowance: null,
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
        pendingId: null,
        requestKind: null,
        design: null,
        expectedRevision: null,
        grantCauses: [],
        allowance: null,
      });
    }
  }
  if (gather !== null) {
    for (const project of gather.projects) {
      const attributed = projectNameForSlug(project.projectSlug, view.projects);
      for (const request of project.requests) {
        if (request.status !== "pending") continue; // the fold filters pending; the read answers every status
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
          pendingId: request.id,
          requestKind: request.kind,
          design: request.design ?? null,
          expectedRevision: project.revision ?? null,
          grantCauses: [],
          allowance: null,
        });
      }
      // The Grant item (T-06, ADR 0038): a run whose blockers name a count
      // dimension an Owner grant remedies — one item per run, offering a
      // grant for exactly the held causes. The row's own data (blockers
      // verbatim, the allowance counts) is the item's facts; without the
      // additive fields an older gather cannot offer the act, so no item.
      const grantCauses = (project.blockers ?? []).flatMap((blocker) =>
        blocker.causes.filter((cause): cause is "tasks" | "qaFixRounds" => cause === "tasks" || cause === "qaFixRounds"),
      );
      if (grantCauses.length > 0 && project.allowance !== undefined && project.revision !== undefined) {
        const uniqueCauses = ["tasks", "qaFixRounds"].filter((cause) => grantCauses.includes(cause as "tasks" | "qaFixRounds")) as ("tasks" | "qaFixRounds")[];
        const allowance = project.allowance;
        items.push({
          kind: "budget-blocked",
          rank: INBOX_RANK["budget-blocked"],
          badge: "ALLOWANCE",
          tone: "amber",
          title: `Run ${project.runId} is blocked on budget`,
          detail: `Tasks ${allowance.tasksUsed}/${allowance.tasksAllowed} used · automatic QA fix rounds ${allowance.qaFixRoundsUsed}/${allowance.qaFixRoundsAllowed} used — a grant adds capacity without resetting the count.`,
          projectName: attributed.name,
          projectRoot: attributed.root,
          task: null,
          acceptAttempt: null,
          runId: project.runId,
          origin: null,
          pendingId: null,
          requestKind: null,
          design: null,
          expectedRevision: project.revision,
          grantCauses: uniqueCauses,
          allowance,
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

// ---- the Workspace screen (T-07a) -------------------------------------------------------------

/** The screen's two shapes — the scoped Project's execution mode. */
export type FlowMode = "slp" | "scrum";

/** One node's live state — the bounded outcome's own presence vocabulary. */
export interface FlowSeatState {
  /** The status word the node shows — "Not started" is the vacant seat's own vocabulary. */
  label: string;
  tone: "green" | "amber" | "red" | "cyan" | "muted";
  /** The prototype's `.flow-node`/`.slp-node` state class — "" is the plain resting node. */
  nodeClass: "running" | "attention" | "completed" | "queued" | "error" | "";
  /** True when no agent holds the seat — the dashed vacant node, never a fabricated agent. */
  vacant: boolean;
}

const FLOW_NOT_STARTED: FlowSeatState = { label: "Not started", tone: "muted", nodeClass: "queued", vacant: true };
const FLOW_LIVE: FlowSeatState = { label: "Live", tone: "cyan", nodeClass: "running", vacant: false };
const FLOW_IDLE: FlowSeatState = { label: "Idle", tone: "muted", nodeClass: "", vacant: false };
const FLOW_ERROR: FlowSeatState = { label: "Error", tone: "red", nodeClass: "error", vacant: false };
const FLOW_DORMANT: FlowSeatState = { label: "Dormant", tone: "muted", nodeClass: "", vacant: false };
const FLOW_NEEDS_YOU: FlowSeatState = { label: "Needs you", tone: "amber", nodeClass: "attention", vacant: false };
const FLOW_HANDOFF: FlowSeatState = { label: "Handoff", tone: "cyan", nodeClass: "running", vacant: false };
const FLOW_ROTATION_PENDING: FlowSeatState = { label: "Rotation pending", tone: "amber", nodeClass: "attention", vacant: false };

/**
 * The presence fold — the daemon's own fields, never a guess: a null agent is
 * the vacant "Not started" seat; the Lead's rotation state outranks the raw
 * status (a handing-over Lead is Live-with-handoff, not idle); a
 * `requiresAttention` flag outranks both; an unrecognized daemon status
 * renders verbatim, muted.
 */
export function flowSeatState(agent: AgentView | null, seat: "supervisor" | "lead" | "peer"): FlowSeatState {
  if (agent === null) return FLOW_NOT_STARTED;
  if (seat === "lead" && agent.rotationState === "handing_over") return FLOW_HANDOFF;
  if (seat === "lead" && agent.rotationState === "rotation_pending") return FLOW_ROTATION_PENDING;
  if (agent.requiresAttention === true) return FLOW_NEEDS_YOU;
  switch (agent.status) {
    case "running":
      return FLOW_LIVE;
    case "idle":
      return FLOW_IDLE;
    case "error":
      return FLOW_ERROR;
    case "closed":
      return FLOW_DORMANT;
    default:
      return { label: agent.status, tone: "muted", nodeClass: "", vacant: false };
  }
}

/** One rung of the Agent Drawer's Attempt ladder (T-07c) — the Task Detail's own verdict spelling over the ledger's attempts. */
export interface FlowAttemptRung {
  n: number;
  /** The attempt's latest gate verdict — null while open or never gated. */
  verdict: "green" | "red" | null;
  /** `Gate green` / `Gate red` / `Running` / `Pending` — the ladder's own summary spelling. */
  verdictLabel: string;
  verdictTone: "green" | "red" | "cyan" | "muted";
  /** The sha the claim stamped — null when the ledger records none. */
  sha: string | null;
  /** The Peer agent id that produced the attempt, when the ledger names one. */
  agentId: string | null;
}

/** One Task the seat owns — a chip with its verification-line status. */
export interface FlowTaskChip {
  task: string;
  status: TaskStatus;
  statusLabel: string;
  tone: TaskRowViewModel["tone"];
  /** The ledger's own Attempt count — the Agent Drawer's Work tab reads it (T-07b). */
  attemptCount: number;
  /** The Task's Attempt ladder — the Agent Drawer's Attempts tab reads it (T-07c). */
  attempts: readonly FlowAttemptRung[];
}

/**
 * The Agent Drawer's Session model (T-07c) — the daemon's own fields with
 * honest absences: the snapshot carries no per-agent attention reason and no
 * per-agent timestamp, so the fold carries the snapshot's own `generatedAt`
 * as the read's time and the oracle's `seqEnd` as the timeline's last seq.
 */
export interface FlowSessionModel {
  provider: string;
  model: string | null;
  /** The thinking option the agent runs — null when the daemon reports none. */
  thinking: string | null;
  /** The configured lane for supervisor/lead; the owned Task's run-named lane for a Peer — null when neither names one. */
  lane: string | null;
  /** The daemon's raw status word, verbatim. */
  status: string;
  requiresAttention: boolean | null;
  cwd: string | null;
  /** The Timeline Oracle's last seqEnd — null when the daemon never answered. */
  seqEnd: number | null;
  /** The snapshot's own generation time — the honest "last read" stamp. */
  snapshotAt: string;
  contextUsedTokens: number | null;
  contextMaxTokens: number | null;
}

/**
 * The Agent Drawer's Handoff model (T-07c) — the Lead rotation state machine
 * as `project.json` records it (ADR 0013 §5), Lead nodes only. `null`
 * rotationState is the honest "unrecorded" (absent reads as normal).
 */
export interface FlowHandoffModel {
  rotationState: "normal" | "rotation_pending" | "handing_over" | null;
  /** `Handing over` / `Rotation pending` / `Normal` / `Not recorded`. */
  rotationLabel: string;
  rotationTone: "green" | "amber" | "cyan" | "muted";
  queuedMailCount: number | null;
  /** The Lead mailbox locks while the rotation hands over. */
  mailboxLocked: boolean;
  contextUsedTokens: number | null;
  /** The context ceiling the rotation watches. */
  contextMaxTokens: number | null;
}

/** One Resources row (T-07c) — a usage rollup row the snapshot attributes to this agent, meter lawful by construction. */
export interface FlowUsageRowModel {
  /** The honest attribution — `Supervisor seat` / `Lead seat` / `Task T-07`. */
  label: string;
  meter: MeterViewModel;
  turns: number;
  sessionCount: number;
}

/** One seat/agent node of the authority graph — Owner renders as its own static card. */
export interface FlowSeatNode {
  /** The selection key a click sets — the agent id when live, the seat name when vacant. */
  key: string;
  seat: "supervisor" | "lead" | "peer";
  title: string;
  agentId: string | null;
  state: FlowSeatState;
  /** The avatar chip's letter. */
  initial: string;
  /** Vacant → the configured lane; live → `provider · model`. */
  laneLabel: string;
  /** The Tasks this seat owns, ledger-bound. */
  tasks: readonly FlowTaskChip[];
  /** The Lead's context telemetry — "40k / 128k" (+ " · handoff" mid-handoff); null off the Lead. */
  contextLabel: string | null;
  /** The Lead's queued mail count — null when unreported. */
  queuedMailCount: number | null;
  /** The Session tab's facts — null on a vacant seat (it never opens the drawer). */
  session: FlowSessionModel | null;
  /** The Handoff tab's facts — the Lead only; every other seat answers null and shows no tab. */
  handoff: FlowHandoffModel | null;
  /** The Resources tab's rows — empty renders the honest "No usage recorded" notice. */
  usage: readonly FlowUsageRowModel[];
}

/** The Agent Drawer's tab vocabulary (T-07c) — Work and Transcript (T-07b) plus the four role-aware read-only tabs. */
export type DrawerTabId = "work" | "transcript" | "session" | "attempts" | "handoff" | "resources";

export const DRAWER_TAB_LABELS: Readonly<Record<DrawerTabId, string>> = {
  work: "Work",
  transcript: "Transcript",
  session: "Session",
  attempts: "Attempts",
  handoff: "Handoff",
  resources: "Resources",
};

/**
 * The tabs one node's drawer offers — role-aware by the fold's own facts:
 * Work, Transcript, and Session for every live seat; Attempts only where the
 * ledger binds Tasks to it; Handoff only on the Lead; Resources for every
 * seat (its honest absence is the "No usage recorded" notice, not a missing tab).
 */
export function drawerTabsFor(node: FlowSeatNode): readonly DrawerTabId[] {
  const tabs: DrawerTabId[] = ["work", "transcript", "session"];
  if (node.tasks.length > 0) tabs.push("attempts");
  if (node.handoff !== null) tabs.push("handoff");
  tabs.push("resources");
  return tabs;
}

/** One mailbox point between authority tiers — queued counts when the fold knows one. */
export interface FlowMailNode {
  seat: "supervisor" | "lead";
  queued: number | null;
  /** The Lead mailbox locks during handoff — the amber locked pill. */
  locked: boolean;
}

/** The Agent Drawer's transcript model (T-07b) — the reply's three envelope arms, verbatim. */
export type DrawerTranscriptModel =
  | { phase: "entries"; entries: AgentTranscriptEntry[] }
  | { phase: "unavailable"; reason: string }
  | { phase: "failure"; code: string; error: string };

/**
 * The envelope law as one pure fold (T-07b): the ok arm carries either the
 * reduced tail or the honest unavailable reason, a refusal carries its code
 * and sentence — every arm is data the drawer's Transcript tab renders,
 * never a throw.
 */
export function drawerTranscriptModel(reply: AgentTranscriptReply): DrawerTranscriptModel {
  if (!reply.ok) return { phase: "failure", code: reply.code, error: reply.error };
  if ("entries" in reply) return { phase: "entries", entries: reply.entries };
  return { phase: "unavailable", reason: reply.reason };
}

/**
 * One conversation turn of the Supervisor Live Chat panel (T-13a, ADR 0051
 * §3/§5) — a transcript entry folded to the chat's own sender vocabulary.
 */
export interface SupervisorChatMessage {
  /** The entry's timeline seq — the transcript carries no wall clock, so the seq is the honest turn position, never an invented time. */
  seq: number;
  /** `owner` for the user's turns, `supervisor` for the agent's. */
  sender: "owner" | "supervisor";
  /** The panel's sender label — the prototype's own "You (Owner)" / "Supervisor". */
  label: string;
  text: string;
}

/** The Supervisor Live Chat panel's model (T-13a) — the transcript reply's arms folded to conversation turns. */
export type SupervisorChatModel =
  | { phase: "chat"; messages: SupervisorChatMessage[] }
  | { phase: "unavailable"; reason: string }
  | { phase: "failure"; code: string; error: string };

/**
 * The chat fold (T-13a, ADR 0051 §3/§5): the Supervisor's own
 * `factory.agent.transcript` reply folded to a conversation — user turns read
 * as the Owner ("You (Owner)"), assistant turns as the "Supervisor", each
 * keyed on the timeline seq (the transcript carries no wall clock — the seq
 * is the honest turn position, never an invented time). Tool calls and
 * system chrome are not conversation turns and fold away — the Transcript
 * tab keeps the full tail. The other two envelope arms ride verbatim, as
 * data, never a throw.
 */
export function supervisorChatModel(reply: AgentTranscriptReply): SupervisorChatModel {
  if (!reply.ok) return { phase: "failure", code: reply.code, error: reply.error };
  if ("unavailable" in reply) return { phase: "unavailable", reason: reply.reason };
  const messages = reply.entries
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .map((entry) => ({
      seq: entry.seq,
      sender: entry.role === "user" ? ("owner" as const) : ("supervisor" as const),
      label: entry.role === "user" ? "You (Owner)" : "Supervisor",
      text: entry.text ?? entry.summary ?? "",
    }));
  return { phase: "chat", messages };
}

/** The specialist role vocabulary — the prototype's own `scrumRoleLabels`. */
export const SCRUM_ROLE_LABELS: Readonly<Record<string, string>> = { pm: "PM", ux: "UX", architect: "ARCH", dev: "DEV", qa: "QA" };

/** One run Task card — the run's own role binding joined with the fold's status. */
export interface ScrumStageTask {
  task: string;
  role: string;
  roleLabel: string;
  /** The card's status word — the prototype's spelling (`Done`, `GREEN`, `Running`, `Blocked`, `Red`, `Waiting`). */
  statusLabel: string;
  tone: "green" | "amber" | "red" | "cyan" | "muted";
  /** `provider · model` when a live agent or the usage rollup names one — null, never a guess. */
  modelLabel: string | null;
}

/** The readiness & UI gate cell — the readiness stage's own two-half answer. */
export interface ScrumGateModel {
  /** The readiness half — "Pass" only once the run moved past the gate. */
  readiness: { label: "Pass" | "Pending"; tone: "green" | "muted" };
  /** The UI-approval half — the Owner's design decision or its honest absence. */
  ui: { label: string; tone: "green" | "amber" };
  /** The design revision under review — null when no design was recorded. */
  revision: number | null;
}

/** One pipeline stage — the strip's five fixed stages, real phases mapped onto them. */
export interface ScrumStageModel {
  id: "planning" | "design" | "readiness" | "implementation" | "qa";
  number: number;
  title: string;
  /** The stage's state word — Completed / Running / Designing / Auditing / Fixing / Blocked / Red gate / Review ready / Changes requested / Needs you / Skipped / Waiting. */
  state: string;
  stateTone: "green" | "amber" | "red" | "cyan" | "muted";
  /** True when the run's current phase maps onto this stage — the strip's highlight. */
  current: boolean;
  skipped: boolean;
  /** The stage's role columns — design holds ux ∥ architect side by side; others one. */
  columns: readonly { role: string; roleLabel: string; tasks: readonly ScrumStageTask[] }[];
  /** The readiness & UI gate cell — the readiness stage only. */
  gate: ScrumGateModel | null;
}

/** The Scrum pipeline strip — the run summary, five stages, blockers, fix loop. */
export interface ScrumPipelineModel {
  runId: string;
  phase: string;
  track: string | null;
  /** `Roster r<n>` — the frozen roster's config revision, null when unrecorded. */
  configRevision: number | null;
  stages: readonly ScrumStageModel[];
  /** The run's blockers verbatim — `blockerDetails` reasons first, ids only as the fallback. */
  blockers: readonly string[];
  /** The cancellation sentence — the banner's first line when the run was cancelled. */
  cancellation: string | null;
  /** `Fix n/max · d defects` — the QA loop's own counts; null without a budget. */
  fixSummary: string | null;
}

/** The Workspace screen's whole world — null without a selected Project. */
export interface FlowScreenModel {
  mode: FlowMode;
  /** The selected Project's display name. */
  scope: string;
  supervisor: FlowSeatNode;
  lead: FlowSeatNode;
  peers: readonly FlowSeatNode[];
  mail: { supervisor: FlowMailNode; lead: FlowMailNode };
  /** The Scrum pipeline strip — scrum mode only, null until a run exists. */
  scrum: ScrumPipelineModel | null;
}

/** The prototype's five stages (`scrumStageDefs`) — the strip's fixed vocabulary. */
const FLOW_STAGES: readonly { id: ScrumStageModel["id"]; number: number; title: string; roles: readonly string[] }[] = [
  { id: "planning", number: 1, title: "PM / Analyst", roles: ["pm"] },
  { id: "design", number: 2, title: "UX ∥ Architect", roles: ["ux", "architect"] },
  { id: "readiness", number: 3, title: "Readiness & UI", roles: [] },
  { id: "implementation", number: 4, title: "Senior Dev", roles: ["dev"] },
  { id: "qa", number: 5, title: "QA & Fix", roles: ["qa"] },
];

/** The real phase vocabulary → the stage that carries its highlight (the run-journal's own PHASES). */
const STAGE_PHASES: Readonly<Record<ScrumStageModel["id"], readonly string[]>> = {
  planning: ["planning"],
  design: ["design"],
  readiness: ["readiness", "awaiting-ui-approval"],
  implementation: ["implementation"],
  qa: ["qa", "fixing"],
};

/** The card's status spelling — the prototype's `scrumTaskCard` law over the fold's statuses. */
function scrumTaskLabel(status: TaskStatus): { label: string; tone: ScrumStageTask["tone"] } {
  switch (status) {
    case "accepted":
      return { label: "Done", tone: "green" };
    // A clean retirement (v0.5.0, ADR 0054 §5) is terminal history — the
    // prototype's Done spelling, never an open-stage card.
    case "closed":
      return { label: "Closed", tone: "muted" };
    case "ready-to-accept":
      return { label: "GREEN", tone: "green" };
    case "running":
      return { label: "Running", tone: "cyan" };
    case "needs-human":
      return { label: "Blocked", tone: "amber" };
    case "red":
      return { label: "Red", tone: "red" };
    case "waiting":
      return { label: "Waiting", tone: "muted" };
  }
}

/** The Lead's context telemetry formatting — "40k / 128k", the trailing `.0` dropped. */
export function flowContextTokens(count: number): string {
  return formatTokens(count).replace(/\.0([kM])$/, "$1");
}

/** The UI-approval half's answer — the prototype's `scrumDecisionLabel` over the run's own fields. */
function scrumUiDecision(run: ScrumRunView): { label: string; tone: "green" | "amber" } {
  if (run.config.requireUiApproval === false) return { label: "Not required", tone: "green" };
  const decision = run.design?.decision;
  if (decision === "approved") return { label: "Approved", tone: "green" };
  if (decision === "waived") return { label: "Waived", tone: "green" };
  if (decision === "changes_requested") return { label: "Changes requested", tone: "amber" };
  return { label: "Awaiting Owner", tone: "amber" };
}

/** One stage's state word — statuses joined per the bounded outcome's own ladder. */
function scrumStageState(
  stage: (typeof FLOW_STAGES)[number],
  phase: string,
  stageTasks: readonly TaskView[],
  run: ScrumRunView,
): { label: string; tone: ScrumStageModel["stateTone"] } {
  const skipped = (run.skippedPhases ?? []).some((entry) => entry.phase === stage.id);
  if (skipped) return { label: "Skipped", tone: "muted" };
  if (stage.id === "readiness") {
    // Phase-derived, never task-derived — the gate owns this stage, not a role.
    if (run.config.requireUiApproval === false) return { label: "Completed", tone: "green" };
    const decision = run.design?.decision;
    if (decision === "approved" || decision === "waived") return { label: "Completed", tone: "green" };
    if (decision === "changes_requested") return { label: "Changes requested", tone: "amber" };
    if (phase === "awaiting-ui-approval") return { label: "Needs you", tone: "amber" };
    return { label: "Waiting", tone: "muted" };
  }
  if (stageTasks.length > 0 && stageTasks.every((task) => task.status === "accepted")) return { label: "Completed", tone: "green" };
  if (stageTasks.some((task) => task.status === "running")) {
    if (stage.id === "design") return { label: "Designing", tone: "cyan" };
    if (stage.id === "qa") return phase === "fixing" ? { label: "Fixing", tone: "cyan" } : { label: "Auditing", tone: "cyan" };
    return { label: "Running", tone: "cyan" };
  }
  if (stageTasks.some((task) => task.status === "needs-human")) return { label: "Blocked", tone: "amber" };
  if (stageTasks.some((task) => task.status === "red")) return { label: "Red gate", tone: "red" };
  if (stageTasks.some((task) => task.status === "ready-to-accept")) return { label: "Review ready", tone: "green" };
  return { label: "Waiting", tone: "muted" };
}

/** The stage's readiness half — "Pass" only once the run moved past the gate (a phase fact, never a guess). */
function scrumReadinessGate(phase: string, run: ScrumRunView): ScrumGateModel["readiness"] {
  return ["awaiting-ui-approval", "implementation", "qa", "fixing", "completed"].includes(phase)
    ? { label: "Pass", tone: "green" }
    : { label: "Pending", tone: "muted" };
}

/**
 * The Workspace fold (T-07a) — the scoped snapshot's SLP authority graph
 * (Owner → Supervisor → Lead → working Peers, each node's live state, lane,
 * and owned Tasks) or, for a scrum-mode Project, the authority tier plus the
 * run's five-stage pipeline strip. Everything folds here from the snapshot
 * alone — no new door, no mock telemetry; a null Project answers null (the
 * screen's own empty state, never a fabricated graph).
 */
export function flowScreenModel(view: FactoryView): FlowScreenModel | null {
  if (view.project === null) return null;
  const mode: FlowMode = view.project.executionMode ?? view.execution?.selectedMode ?? "slp";
  const tasksById = new Map(view.tasks.map((task) => [task.task, task]));
  const usageBySeat = new Map((view.projectUsage?.bySeat ?? []).map((row) => [row.seat, row]));
  const usageByTask = new Map((view.projectUsage?.byTask ?? []).map((row) => [row.task, row]));

  /** The Tasks one agent owns — the ledger's own binding (`agent.task` / `task.agentId`), never a guess. */
  const tasksForAgent = (agent: AgentView | null): FlowTaskChip[] => {
    if (agent === null) return [];
    const owned = new Set<string>();
    if (agent.task !== null) owned.add(agent.task);
    for (const task of view.tasks) if (task.agentId === agent.id) owned.add(task.task);
    const chips: FlowTaskChip[] = [];
    for (const id of owned) {
      const task = tasksById.get(id);
      if (task === undefined) continue; // a binding the fold cannot status renders no invented chip
      chips.push({
        task: id,
        status: task.status,
        statusLabel: statusLabel(task),
        tone: STATUS_TONES[task.status],
        attemptCount: task.attempts.length,
        attempts: task.attempts.map((attempt) => {
          const verdict = rungVerdict(attempt);
          return {
            n: attempt.n,
            verdict: attempt.verdict,
            verdictLabel: verdict.label,
            verdictTone: verdict.tone,
            sha: attempt.sha,
            agentId: attempt.agentId ?? null,
          };
        }),
      });
    }
    return chips;
  };

  /**
   * The Session tab's facts from the daemon's own row — the lane is the
   * configured one for the standing seats, the owned Task's run-named lane
   * for a Peer, and the snapshot's own stamp is the honest time.
   */
  const sessionOf = (agent: AgentView, seat: "supervisor" | "lead" | "peer", chips: readonly FlowTaskChip[]): FlowSessionModel => ({
    provider: agent.provider,
    model: agent.model,
    thinking: agent.thinking ?? null,
    lane:
      seat === "supervisor"
        ? view.lanes.supervisor
        : seat === "lead"
          ? view.lanes.lead
          : (chips.map((chip) => tasksById.get(chip.task)?.lane ?? null).find((lane) => lane !== null && lane !== "") ?? null),
    status: agent.status,
    requiresAttention: agent.requiresAttention,
    cwd: agent.cwd,
    seqEnd: agent.seqEnd,
    snapshotAt: view.generatedAt,
    contextUsedTokens: agent.contextUsedTokens ?? null,
    contextMaxTokens: agent.contextMaxTokens ?? null,
  });

  /** The Handoff tab's facts — the Lead's rotation state machine as the snapshot records it. */
  const handoffOf = (agent: AgentView): FlowHandoffModel => {
    const rotationState = agent.rotationState ?? null;
    const spelling =
      rotationState === "handing_over"
        ? { label: "Handing over", tone: "cyan" as const }
        : rotationState === "rotation_pending"
          ? { label: "Rotation pending", tone: "amber" as const }
          : rotationState === "normal"
            ? { label: "Normal", tone: "green" as const }
            : { label: "Not recorded", tone: "muted" as const };
    return {
      rotationState,
      rotationLabel: spelling.label,
      rotationTone: spelling.tone,
      queuedMailCount: agent.queuedMailCount ?? null,
      mailboxLocked: agent.rotationState === "handing_over",
      contextUsedTokens: agent.contextUsedTokens ?? null,
      contextMaxTokens: agent.contextMaxTokens ?? null,
    };
  };

  /**
   * The Resources tab's rows — the usage rollup's own attribution, never a
   * guess: the standing seats read their `bySeat` row (the seat IS one
   * agent); a Peer reads the `byTask` rows of the Tasks the ledger binds to
   * it (the rollup never breaks a session down by agent id). No row answers
   * no row — the screen's honest "No usage recorded", never a zero.
   */
  const usageRowsFor = (seat: "supervisor" | "lead" | "peer", chips: readonly FlowTaskChip[]): FlowUsageRowModel[] => {
    if (seat === "peer") {
      const rows: FlowUsageRowModel[] = [];
      for (const chip of chips) {
        const row = usageByTask.get(chip.task);
        if (row === undefined) continue;
        const meter = meterFromBuckets(row);
        if (meter !== null) rows.push({ label: `Task ${chip.task}`, meter, turns: row.turns, sessionCount: row.sessionCount });
      }
      return rows;
    }
    const row = usageBySeat.get(seat);
    if (row === undefined) return [];
    const meter = meterFromBuckets(row);
    if (meter === null) return [];
    return [{ label: seat === "supervisor" ? "Supervisor seat" : "Lead seat", meter, turns: row.turns, sessionCount: row.sessionCount }];
  };

  const seatNode = (seat: "supervisor" | "lead", agent: AgentView | null): FlowSeatNode => {
    const state = flowSeatState(agent, seat);
    const configuredLane = seat === "supervisor" ? view.lanes.supervisor : view.lanes.lead;
    const title = seat === "supervisor" ? "Supervisor" : "Lead";
    const tasks = tasksForAgent(agent);
    return {
      key: agent?.id ?? `seat:${seat}`,
      seat,
      title,
      agentId: agent?.id ?? null,
      state,
      initial: seat === "supervisor" ? "S" : "L",
      laneLabel: agent === null ? configuredLane : agent.model === null ? agent.provider : `${agent.provider} · ${agent.model}`,
      tasks,
      contextLabel:
        seat === "lead" && agent !== null && agent.contextUsedTokens !== null && agent.contextUsedTokens !== undefined
          ? `${flowContextTokens(agent.contextUsedTokens)} / ${
              agent.contextMaxTokens !== null && agent.contextMaxTokens !== undefined ? flowContextTokens(agent.contextMaxTokens) : "—"
            }${agent.rotationState === "handing_over" ? " · handoff" : ""}`
          : null,
      queuedMailCount: seat === "lead" && agent !== null ? (agent.queuedMailCount ?? null) : null,
      session: agent === null ? null : sessionOf(agent, seat, tasks),
      handoff: seat === "lead" && agent !== null ? handoffOf(agent) : null,
      usage: agent === null ? [] : usageRowsFor(seat, tasks),
    };
  };

  const peers: FlowSeatNode[] = view.agents
    .filter((agent) => agent.seat !== "supervisor" && agent.seat !== "lead")
    .map((agent) => {
      const state = flowSeatState(agent, "peer");
      const tasks = tasksForAgent(agent);
      return {
        key: agent.id,
        seat: "peer" as const,
        title: agent.title ?? "Peer",
        agentId: agent.id,
        state,
        initial: (agent.title ?? "P").slice(0, 1).toUpperCase(),
        laneLabel: agent.model === null ? agent.provider : `${agent.provider} · ${agent.model}`,
        tasks,
        contextLabel: null,
        queuedMailCount: null,
        session: sessionOf(agent, "peer", tasks),
        handoff: null,
        usage: usageRowsFor("peer", tasks),
      };
    });

  const leadAgent = view.lead;
  const mail = {
    supervisor: { seat: "supervisor" as const, queued: null, locked: false },
    lead: {
      seat: "lead" as const,
      queued: leadAgent?.queuedMailCount ?? null,
      locked: leadAgent?.rotationState === "handing_over",
    },
  };

  let scrum: ScrumPipelineModel | null = null;
  const run = view.execution?.activeRun ?? view.execution?.run ?? null;
  if (mode === "scrum" && run !== null && run !== undefined) {
    const runTasks = run.tasks ?? [];
    const stageTask = (entry: { task: string; role: string }): ScrumStageTask | null => {
      const task = tasksById.get(entry.task);
      if (task === undefined) return null; // a reserved Task with no foldable history yet renders no invented card
      const card = scrumTaskLabel(task.status);
      const live = view.agents.find((agent) => agent.task === entry.task || task.agentId === agent.id);
      return {
        task: entry.task,
        role: entry.role,
        roleLabel: SCRUM_ROLE_LABELS[entry.role] ?? entry.role,
        statusLabel: card.label,
        tone: card.tone,
        modelLabel: live !== undefined ? (live.model === null ? live.provider : `${live.provider} · ${live.model}`) : (task.usageModel ?? null),
      };
    };
    const stages: ScrumStageModel[] = FLOW_STAGES.map((stage) => {
      const entries = runTasks.filter((entry) => stage.roles.includes(entry.role));
      const stageTasks = entries.map((entry) => tasksById.get(entry.task)).filter((task): task is TaskView => task !== undefined);
      const state = scrumStageState(stage, run.phase, stageTasks, run);
      return {
        id: stage.id,
        number: stage.number,
        title: stage.title,
        state: state.label,
        stateTone: state.tone,
        current: STAGE_PHASES[stage.id].includes(run.phase),
        skipped: (run.skippedPhases ?? []).some((entry) => entry.phase === stage.id),
        columns: stage.roles.map((role) => ({
          role,
          roleLabel: SCRUM_ROLE_LABELS[role] ?? role,
          tasks: entries.filter((entry) => entry.role === role).map(stageTask).filter((task): task is ScrumStageTask => task !== null),
        })),
        gate: stage.id === "readiness" ? { readiness: scrumReadinessGate(run.phase, run), ui: scrumUiDecision(run), revision: run.design?.revision ?? null } : null,
      };
    });
    const blockers: string[] = [];
    if (run.cancellation !== undefined) blockers.push(`Cancelled — ${run.cancellation.reason}`);
    for (const detail of run.blockerDetails ?? []) blockers.push(detail.reason);
    for (const blocker of run.blockers ?? []) if (!blockers.includes(blocker)) blockers.push(blocker);
    const maxFix = run.budgets?.maxQaFixRounds;
    const defects = run.qaResult?.confirmedDefects;
    scrum = {
      runId: run.runId,
      phase: run.phase,
      track: run.track ?? null,
      configRevision: run.configRevision,
      stages,
      blockers,
      cancellation: run.cancellation?.reason ?? null,
      fixSummary:
        maxFix === undefined ? null : `Fix ${run.fixRounds}/${maxFix}${defects === undefined ? "" : ` · ${defects} defects`}`,
    };
  }

  return {
    mode,
    scope: view.project.name ?? view.project.slug,
    supervisor: seatNode("supervisor", view.supervisor),
    lead: seatNode("lead", view.lead),
    peers,
    mail,
    scrum,
  };
}
