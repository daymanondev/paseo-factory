/**
 * The Activity screen's fold (T-11a, ADR 0051) — a PURE fold of the EXISTING
 * snapshot's two activity halves: the ledger stream (`view.ledger`, the
 * newest-first capped stream the server fold already orders) and the scoped
 * Project's usage rollup (`view.projectUsage`, the same `ProjectUsageView`
 * the RN client's ProjectUsageCard reads). The fold stays pure over the
 * snapshot: the kind taxonomy below is the only invention, every row's
 * detail is the ledger's own rendered `line` verbatim, and the token/cost
 * vocabulary reuses the RN usage surfaces' own words (`formatTokenCount`,
 * the cache-hit percent — `plugin/client/factory/seats.tsx`) so the console
 * and the client can never disagree. The kind filter chips are the screen's
 * own client-side state, never a transport; the retro pass
 * (`factory.retro`) and its ratification stay outside this screen (T-11b).
 */
import type { FactoryView, LedgerLineView, ModelUsageRowView, SeatUsageRowView, UsageBucketsView } from "../../plugin/shared/view.ts";
import { utcStamp } from "./integrations-view.ts";

/**
 * The stream's kind taxonomy — the seven chips the filter bar offers. The
 * ledger's own event vocabulary maps onto six named kinds; everything else
 * (schema lines, needs-human, permits, git refusals, retro writes) folds to
 * `other`, never a fabricated eighth chip.
 */
export type ActivityEventKind = "contract" | "spawn" | "claim" | "gate" | "accepted" | "meter" | "other";

/** The filter bar's own id — the seven kinds plus the "All events" reset. */
export type ActivityKindFilter = ActivityEventKind | "all";

/** One ledger event's kind, decided by its own `event` word alone. */
export function eventKind(event: string): ActivityEventKind {
  switch (event) {
    case "contract_set":
      return "contract";
    case "spawn_dispatched":
    case "spawn_refused":
    case "respawn_dispatched":
    case "respawn_refused":
    case "repoke_dispatched":
    case "repoke_refused":
      return "spawn";
    case "claim_reported":
      return "claim";
    case "gate_started":
    case "gate_finished":
    case "report_written":
    case "watch_written":
    case "fresh_eyes_written":
      // The verification line and its evidence writes — one kind, one chip.
      return "gate";
    case "attempt_accepted":
      return "accepted";
    case "meter_written":
      return "meter";
    default:
      return "other";
  }
}

/** The chip's own label — the taxonomy's words, spelled once. */
export const KIND_LABELS: Readonly<Record<ActivityEventKind, string>> = {
  contract: "contract",
  spawn: "spawn",
  claim: "claim",
  gate: "gate",
  accepted: "accepted",
  meter: "meter",
  other: "other",
};

/** The chip order — the task's own list, `other` last. */
export const KIND_ORDER: readonly ActivityEventKind[] = ["contract", "spawn", "claim", "gate", "accepted", "meter", "other"];

/** One ledger stream row — the snapshot's own line, pre-formatted for render. */
export interface ActivityLedgerRow {
  seq: number;
  ts: string;
  /** `2026-11-08 09:05 UTC` — the deterministic UTC stamp, never `toLocaleString`. */
  timeLabel: string;
  /** The ledger's own event word (`contract_set`) — the raw kind id. */
  event: string;
  kind: ActivityEventKind;
  kindLabel: string;
  /** The owning task's id, or null on workspace-scoped lines. */
  task: string | null;
  /** The ledger's own rendered one-liner, verbatim — the row's whole detail. */
  detail: string;
  /**
   * The line's owning Project slug on the unscoped aggregate stream (the
   * additive `projectSlug` field, v0.0.89) — null when the line carries none.
   */
  projectSlug: string | null;
}

/** One filter chip — its kind, its label, and the stream's own count. */
export interface ActivityKindChip {
  id: ActivityKindFilter;
  label: string;
  count: number;
}

/**
 * `166,621,161` → `166.6M` — the one token format the usage surfaces print
 * (the RN client's own law, `plugin/client/factory/seats.tsx`
 * `formatTokenCount`, kept in lockstep so the two surfaces never disagree).
 */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/** `cacheRead / gross-input` as a whole-percent string — `–` when nothing was read (the RN card's own law). */
export function cacheHitPercent(buckets: Pick<UsageBucketsView, "inputUncachedTokens" | "cacheReadTokens" | "cacheWriteTokens">): string {
  const gross = buckets.inputUncachedTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
  if (gross <= 0) return "–";
  return `${Math.round((buckets.cacheReadTokens / gross) * 100)}%`;
}

/** `$0.50` — or null when no session reported dollars (never a fabricated zero). */
function costLabel(costUsd: number | null): string | null {
  return costUsd === null ? null : `$${costUsd.toFixed(2)}`;
}

/** One usage bar row — a `(provider, model)` row or a seat/lane row, the design's own row shape. */
export interface ActivityUsageRow {
  id: string;
  /** The row's title — the model name, or the seat row's own label. */
  label: string;
  /** The identity's second line — `pi · $0.50` / `2 session(s) · $0.50`. */
  sub: string;
  totalTokens: number;
  totalLabel: string;
  costLabel: string | null;
  turns: number;
  sessionCount: number;
  /** The bar's scale — this row's tokens as a whole percent of the section's max (0..100). */
  share: number;
  /** The bar's two segments — recorded input then output, the design legend's own halves. */
  inputShare: number;
  outputShare: number;
}

/** The usage panel — the rollup's totals plus the two bar sections, or the honest null. */
export interface ActivityUsagePanel {
  updatedAt: string;
  updatedAtLabel: string;
  backfilled: boolean;
  totals: {
    totalLabel: string;
    inputLabel: string;
    outputLabel: string;
    costLabel: string | null;
    turns: number;
    sessionCount: number;
    cacheHitLabel: string;
  };
  byModel: readonly ActivityUsageRow[];
  bySeat: readonly ActivityUsageRow[];
}

/** The Activity screen's whole world — folds from any snapshot, scoped or not. */
export interface ActivityScreenModel {
  /** The selected Project's display name, or "All projects" — the screen renders either way. */
  scope: string;
  /** The snapshot's own newest-first stream order, kept verbatim (never re-sorted). */
  ledger: readonly ActivityLedgerRow[];
  /** Every kind's count — the chips' own numbers, `all` first. */
  kindCounts: Readonly<Record<ActivityKindFilter, number>>;
  /** The scoped Project's Ledger could not be opened (v0.0.89) — the stream's degraded notice. */
  ledgerError: string | null;
  /** The scoped Project's usage rollup — null on the unscoped view or when no session was recorded. */
  usage: ActivityUsagePanel | null;
  daemonError: string | null;
}

/** Reads the aggregate stream's additive `projectSlug` without trusting its presence. */
function projectSlugOf(line: LedgerLineView): string | null {
  const slug = (line as LedgerLineView & { projectSlug?: unknown }).projectSlug;
  return typeof slug === "string" ? slug : null;
}

/** One usage row's bar shares against its section's max — whole percents, the largest row always 100. */
function sharesOf(totalTokens: number, buckets: UsageBucketsView, max: number): { share: number; inputShare: number; outputShare: number } {
  const gross = buckets.inputUncachedTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
  const scale = (value: number) => (max <= 0 ? 0 : Math.round((value / max) * 100));
  return {
    share: scale(totalTokens),
    inputShare: scale(gross),
    outputShare: scale(buckets.outputTokens),
  };
}

/** One `(provider, model)` rollup row → one bar row, the provider beside the honest cost. */
function modelUsageRow(row: ModelUsageRowView, max: number): ActivityUsageRow {
  const cost = costLabel(row.totalCostUsd);
  return {
    id: `${row.provider}/${row.model}`,
    label: row.model,
    sub: [row.provider, cost].filter((part) => part !== null).join(" · "),
    totalTokens: row.totalTokens,
    totalLabel: formatTokenCount(row.totalTokens),
    costLabel: cost,
    turns: row.turns,
    sessionCount: row.sessionCount,
    ...sharesOf(row.totalTokens, row, max),
  };
}

/** One seat/lane rollup row → one bar row, the sessions beside the honest cost. */
function seatUsageRow(row: SeatUsageRowView, max: number): ActivityUsageRow {
  const cost = costLabel(row.totalCostUsd);
  return {
    id: row.label,
    label: row.label,
    sub: [`${row.sessionCount} session${row.sessionCount === 1 ? "" : "s"}`, cost].filter((part) => part !== null).join(" · "),
    totalTokens: row.totalTokens,
    totalLabel: formatTokenCount(row.totalTokens),
    costLabel: cost,
    turns: row.turns,
    sessionCount: row.sessionCount,
    ...sharesOf(row.totalTokens, row, max),
  };
}

/**
 * The Activity fold (T-11a): the ledger stream row by row — the deterministic
 * UTC stamp, the kind the event's own word decides, the task id, and the
 * ledger's own detail line verbatim, in the snapshot's own newest-first order
 * — plus the kind counts the chips carry, the scoped Project's `ledgerError`
 * as the stream's degraded notice, and the usage rollup as the design's
 * summary/two bar sections (the honest null when `projectUsage` is absent —
 * the unscoped view or a Project that recorded no session). No write, no
 * transport, no fabricated row: absent halves fold to their own empty words.
 */
export function activityScreenModel(view: FactoryView): ActivityScreenModel {
  const ledger: ActivityLedgerRow[] = view.ledger.map((line) => {
    const kind = eventKind(line.event);
    return {
      seq: line.seq,
      ts: line.ts,
      timeLabel: utcStamp(line.ts),
      event: line.event,
      kind,
      kindLabel: KIND_LABELS[kind],
      task: line.task,
      detail: line.line,
      projectSlug: projectSlugOf(line),
    };
  });
  const kindCounts: Record<ActivityKindFilter, number> = {
    all: ledger.length,
    contract: 0,
    spawn: 0,
    claim: 0,
    gate: 0,
    accepted: 0,
    meter: 0,
    other: 0,
  };
  for (const row of ledger) kindCounts[row.kind] += 1;
  const usage = view.projectUsage ?? null;
  const usagePanel: ActivityUsagePanel | null =
    usage === null
      ? null
      : {
          updatedAt: usage.updatedAt,
          updatedAtLabel: usage.updatedAt === "" ? "Never" : utcStamp(usage.updatedAt),
          backfilled: usage.backfilledAt !== undefined,
          totals: {
            totalLabel: formatTokenCount(usage.totals.totalTokens),
            inputLabel: formatTokenCount(usage.totals.inputUncachedTokens + usage.totals.cacheReadTokens + usage.totals.cacheWriteTokens),
            outputLabel: formatTokenCount(usage.totals.outputTokens),
            costLabel: costLabel(usage.totals.totalCostUsd),
            turns: usage.totals.turns,
            sessionCount: usage.totals.sessionCount,
            cacheHitLabel: cacheHitPercent(usage.totals),
          },
          byModel: (() => {
            const max = Math.max(0, ...usage.byModel.map((row) => row.totalTokens));
            return usage.byModel.map((row) => modelUsageRow(row, max));
          })(),
          bySeat: (() => {
            const max = Math.max(0, ...usage.bySeat.map((row) => row.totalTokens));
            return usage.bySeat.map((row) => seatUsageRow(row, max));
          })(),
        };
  return {
    scope: view.project === null ? "All projects" : (view.project.name ?? view.project.slug),
    ledger,
    kindCounts,
    ledgerError: view.project?.ledgerError ?? null,
    usage: usagePanel,
    daemonError: view.daemonError,
  };
}

/** The chips the filter bar renders — "All events" first, then the seven kinds in the taxonomy's order. */
export function activityKindChips(model: ActivityScreenModel): readonly ActivityKindChip[] {
  return [
    { id: "all", label: "All events", count: model.kindCounts.all },
    ...KIND_ORDER.map((kind) => ({ id: kind, label: KIND_LABELS[kind], count: model.kindCounts[kind] })),
  ];
}

/** The stream filtered to one chip — the screen's client-side view switch, never an RPC write. */
export function filterLedgerRows(rows: readonly ActivityLedgerRow[], filter: ActivityKindFilter): readonly ActivityLedgerRow[] {
  return filter === "all" ? rows : rows.filter((row) => row.kind === filter);
}
