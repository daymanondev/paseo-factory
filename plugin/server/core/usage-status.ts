/**
 * The pure usage-rollup reader and renderer (v0.0.87, ADR 0043 §4–§5) —
 * the `<projectStateDir>/usage.json` schema, the aggregation fold every
 * breakdown (`byModel`, `bySeat`, `byTask`) reads, and the `factory status`
 * Token Usage table. Pure Node, zero Paseo imports, so the same file serves
 * both placement-law sides: the plugin server's rollup runtime
 * (`plugin/server/usage-rollup.ts`) types and reads against the vendored
 * copy, and `scripts/generate-policies.mjs` compiles this source into the
 * CLI mirror `plugin/bin/usage-status.mjs` that `factory status` imports —
 * the CLIs import no src/ code (ADR 0004).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectStateDir } from "./project.ts";

/** One session's record in `<projectStateDir>/usage.json` (ADR 0043 §1, verbatim). */
export interface SessionUsageRecord {
  agentId: string;
  projectSlug: string;
  seat: "supervisor" | "lead" | "agent" | "watch";
  task?: string;
  attempt?: number;
  harness: "pi" | "codex" | "opencode" | "antigravity" | "claude" | "copilot" | (string & {});
  provider: string;
  model: string;
  turns: number;
  inputUncachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number; // inputUncachedTokens + cacheReadTokens + cacheWriteTokens + outputTokens
  totalCostUsd?: number;
  latestContextWindowTokens?: number;
  nativeSessionRef?: string;
  startedAt?: string;
  updatedAt: string;
}

/** The whole `<projectStateDir>/usage.json` — versioned for forward migration. */
export interface ProjectUsageFile {
  version: 1;
  projectSlug: string;
  backfilledAt?: string;
  updatedAt: string;
  sessions: Record<string, SessionUsageRecord>;
}

/** The four disjoint buckets every aggregate carries — the additive invariant's wire shape. */
export interface UsageBuckets {
  turns: number;
  sessionCount: number;
  inputUncachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  totalCostUsd: number | null;
}

export interface ModelUsageRow extends UsageBuckets {
  provider: string;
  harness: string;
  model: string;
}

export interface SeatUsageRow extends UsageBuckets {
  seat: SessionUsageRecord["seat"];
  label: string;
  models: ModelUsageRow[];
}

export interface TaskUsageRow extends UsageBuckets {
  task: string;
  /** The task's most recently updated session's model — the card badge. */
  model: string | null;
}

/** The aggregated view every consumer (surface fold, CLI table) renders. */
export interface ProjectUsageSummary {
  totals: UsageBuckets;
  byModel: ModelUsageRow[];
  bySeat: SeatUsageRow[];
  byTask: TaskUsageRow[];
}

/** Where one Project's usage rollup lives. */
export function usageFilePath(stateDir: string, slug: string): string {
  return join(projectStateDir(stateDir, slug), "usage.json");
}

/** Reads one Project's rollup — undefined when absent or damaged (never trusted). */
export function readProjectUsage(stateDir: string, slug: string): ProjectUsageFile | undefined {
  const path = usageFilePath(stateDir, slug);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const file = parsed as Partial<ProjectUsageFile>;
    if (file.version !== 1 || typeof file.projectSlug !== "string" || typeof file.sessions !== "object" || file.sessions === null) return undefined;
    return {
      version: 1,
      projectSlug: file.projectSlug,
      ...(typeof file.backfilledAt === "string" ? { backfilledAt: file.backfilledAt } : {}),
      updatedAt: typeof file.updatedAt === "string" ? file.updatedAt : "",
      sessions: file.sessions,
    };
  } catch {
    return undefined;
  }
}

const SEAT_LABELS: Readonly<Record<SessionUsageRecord["seat"], string>> = {
  supervisor: "Supervisor",
  lead: "Lead",
  agent: "Peer",
  watch: "Watch",
};

/** The row label a seat renders. */
export function seatLabelOf(record: Pick<SessionUsageRecord, "seat">): string {
  return SEAT_LABELS[record.seat] ?? record.seat;
}

function emptyBuckets(): UsageBuckets & { costSum: number; costSeen: boolean } {
  return { turns: 0, sessionCount: 0, inputUncachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, totalCostUsd: null, costSum: 0, costSeen: false };
}

function addTo(bucket: UsageBuckets & { costSum: number; costSeen: boolean }, record: SessionUsageRecord): void {
  bucket.turns += finiteOr(record.turns, 0);
  bucket.sessionCount += 1;
  bucket.inputUncachedTokens += finiteOr(record.inputUncachedTokens, 0);
  bucket.cacheReadTokens += finiteOr(record.cacheReadTokens, 0);
  bucket.cacheWriteTokens += finiteOr(record.cacheWriteTokens, 0);
  bucket.outputTokens += finiteOr(record.outputTokens, 0);
  bucket.reasoningTokens += finiteOr(record.reasoningTokens, 0);
  bucket.totalTokens += finiteOr(record.totalTokens, 0);
  if (typeof record.totalCostUsd === "number" && Number.isFinite(record.totalCostUsd)) {
    bucket.costSum += record.totalCostUsd;
    bucket.costSeen = true;
  }
}

function sealBucket(bucket: UsageBuckets & { costSum: number; costSeen: boolean }): UsageBuckets {
  const { costSum, costSeen, ...buckets } = bucket;
  return { ...buckets, totalCostUsd: costSeen ? round2(costSum) : null };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** `cacheRead / (input + cacheRead + cacheWrite)` as a whole-percent string — `–` when nothing was read. */
export function cacheHitPercentOf(buckets: Pick<UsageBuckets, "inputUncachedTokens" | "cacheReadTokens" | "cacheWriteTokens">): string {
  const input = buckets.inputUncachedTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
  if (input <= 0) return "–";
  return `${Math.round((buckets.cacheReadTokens / input) * 100)}%`;
}

const HISTORICAL_ANTIGRAVITY_MODELS: ReadonlyMap<number, string> = new Map([
  [1417, "gemini-4-argon-high"],
  [1525, "gemini-4-hydrogen-high"],
  [1526, "gemini-4-hydrogen-medium"],
  [1527, "gemini-4-hydrogen-low"],
  [1528, "gemini-4-neon-high"],
]);

/**
 * Normalizes provider aliases, historical Antigravity enum fallbacks, and
 * casing while keeping distinct routes (`zcode` vs `zai`) and effort
 * suffixes (`-high`, `-medium`, `-low`, `-xhigh`) separate.
 */
export function normalizeUsageModel(provider: string, model: string): { provider: string; model: string } {
  const rawProvider = provider.trim().toLowerCase();
  const normProvider = rawProvider === "copilot" ? "github-copilot" : rawProvider;
  const rawModel = model.trim().toLowerCase();
  const enumMatch = /^model-(\d+)$/.exec(rawModel);
  const mappedOrRaw = enumMatch !== null ? (HISTORICAL_ANTIGRAVITY_MODELS.get(Number(enumMatch[1])) ?? rawModel) : rawModel;
  return { provider: normProvider, model: mappedOrRaw.trim().toLowerCase() };
}

function byRecency(a: SessionUsageRecord, b: SessionUsageRecord): number {
  const ta = Date.parse(a.updatedAt);
  const tb = Date.parse(b.updatedAt);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  if (Number.isFinite(ta)) return 1;
  if (Number.isFinite(tb)) return -1;
  return 0;
}

type MutableBucket = UsageBuckets & { costSum: number; costSeen: boolean };
type MutableModelRow = MutableBucket & ModelUsageRow;
type MutableSeatRow = MutableBucket & Omit<SeatUsageRow, "models"> & { modelsMap: Map<string, MutableModelRow> };
type MutableTaskRow = MutableBucket & TaskUsageRow;

function newTokensOf(row: Pick<UsageBuckets, "inputUncachedTokens" | "outputTokens">): number {
  return row.inputUncachedTokens + row.outputTokens;
}

function compareUsageRank(a: UsageBuckets, b: UsageBuckets): number {
  return (newTokensOf(b) - newTokensOf(a)) || (b.totalTokens - a.totalTokens);
}

/** Folds one Project's rollup into the totals + per-model + per-seat + per-task breakdown. */
export function foldProjectUsageSummary(file: ProjectUsageFile | undefined, options?: { sinceMs?: number }): ProjectUsageSummary | null {
  if (file === undefined) return null;
  const sinceMs = options?.sinceMs;
  const records = Object.values(file.sessions).filter(record => {
    if (typeof record?.agentId !== "string") return false;
    if (sinceMs !== undefined) {
      const ts = Date.parse(record.updatedAt);
      if (!Number.isFinite(ts) || ts < sinceMs) return false;
    }
    return true;
  });
  if (records.length === 0) return null;
  const totals = emptyBuckets();
  const models = new Map<string, MutableModelRow>();
  const seats = new Map<string, MutableSeatRow>();
  const tasks = new Map<string, MutableTaskRow>();
  for (const record of records.sort(byRecency)) {
    addTo(totals, record);
    const norm = normalizeUsageModel(typeof record.provider === "string" ? record.provider : "", typeof record.model === "string" ? record.model : "");
    const modelKey = `${norm.provider}/${norm.model}`;
    const modelRow = models.get(modelKey) ?? { provider: norm.provider, harness: String(record.harness), model: norm.model, ...emptyBuckets() };
    addTo(modelRow, record);
    models.set(modelKey, modelRow);
    const seatKey = record.seat;
    const seatRow = seats.get(seatKey) ?? { seat: record.seat, label: seatLabelOf(record), modelsMap: new Map(), ...emptyBuckets() };
    addTo(seatRow, record);
    const seatModelRow = seatRow.modelsMap.get(modelKey) ?? { provider: norm.provider, harness: String(record.harness), model: norm.model, ...emptyBuckets() };
    addTo(seatModelRow, record);
    seatRow.modelsMap.set(modelKey, seatModelRow);
    seats.set(seatKey, seatRow);
    if (record.task !== undefined && record.task !== "") {
      const taskRow = tasks.get(record.task) ?? { task: record.task, model: null, ...emptyBuckets() };
      addTo(taskRow, record);
      taskRow.model = norm.model; // recency order — the latest session names the badge
      tasks.set(record.task, taskRow);
    }
  }
  const rankModel = (a: ModelUsageRow, b: ModelUsageRow) =>
    compareUsageRank(a, b) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
  const rankSeat = (a: SeatUsageRow, b: SeatUsageRow) =>
    compareUsageRank(a, b) || a.label.localeCompare(b.label);
  const rankTask = (a: TaskUsageRow, b: TaskUsageRow) =>
    compareUsageRank(a, b) || a.task.localeCompare(b.task);
  const sealModel = (row: MutableModelRow): ModelUsageRow => ({
    ...sealBucket(row),
    provider: row.provider,
    harness: row.harness,
    model: row.model,
  });
  return {
    totals: sealBucket(totals),
    byModel: [...models.values()].map(sealModel).filter(row => row.totalTokens > 0).sort(rankModel),
    bySeat: [...seats.values()]
      .filter(row => row.totalTokens > 0)
      .map(row => ({
        ...sealBucket(row),
        seat: row.seat,
        label: row.label,
        models: [...row.modelsMap.values()].map(sealModel).filter(m => m.totalTokens > 0).sort(rankModel),
      }))
      .sort(rankSeat),
    byTask: [...tasks.values()].map(row => ({ ...sealBucket(row), task: row.task, model: row.model })).sort(rankTask),
  };
}

/** `1,234,567` — the one number format the usage tables print. */
export function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * `factory status`'s Token Usage section (spec §4): one block per Project
 * with recorded sessions — the totals line, then By Seat, then By
 * Provider/Model — read straight off `<stateDir>/projects/<slug>/usage.json`.
 */
export function statusUsageLines(stateDir: string): string[] {
  const lines: string[] = [];
  let slugs: string[] = [];
  try {
    slugs = readdirSync(join(stateDir, "projects"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch {
    return lines;
  }
  for (const slug of slugs) {
    const summary = foldProjectUsageSummary(readProjectUsage(stateDir, slug));
    if (summary === null) continue;
    lines.push(`usage ${slug}: ${formatTokens(summary.totals.totalTokens)} tokens · ${summary.totals.sessionCount} session(s) · ${summary.totals.turns} turn(s) · cache-hit ${cacheHitPercentOf(summary.totals)}${summary.totals.totalCostUsd === null ? "" : ` · $${summary.totals.totalCostUsd.toFixed(2)}`}`);
    for (const row of summary.bySeat) {
      lines.push(`  seat ${row.label}: ${formatTokens(row.totalTokens)} tokens · ${row.sessionCount} session(s) · cache-hit ${cacheHitPercentOf(row)}${row.totalCostUsd === null ? "" : ` · $${row.totalCostUsd.toFixed(2)}`}`);
    }
    for (const row of summary.byModel) {
      lines.push(`  model ${row.provider}/${row.model} (${row.harness}): ${formatTokens(row.totalTokens)} tokens · in ${formatTokens(row.inputUncachedTokens)} · cache-read ${formatTokens(row.cacheReadTokens)} · out ${formatTokens(row.outputTokens)} · ${row.turns} turn(s) · cache-hit ${cacheHitPercentOf(row)}`);
    }
  }
  return lines;
}
