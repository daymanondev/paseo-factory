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
import type { FactoryView, TaskStatus, TaskView, UsageBucketsView } from "../../plugin/shared/view.ts";

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
}

export interface TasksScreenViewModel {
  /** The scope's name — the selected Project, or "All projects". */
  scope: string;
  rows: readonly TaskRowViewModel[];
  /** The scoped Project's rollup meter — null on the unscoped view or with no sessions. */
  meter: MeterViewModel | null;
  counts: Readonly<Record<TaskStatus, number>>;
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
    };
  });
  return {
    scope: view.project === null ? "All projects" : (view.project.name ?? view.project.slug),
    rows,
    meter: meterFromBuckets(view.projectUsage?.totals),
    counts,
  };
}
