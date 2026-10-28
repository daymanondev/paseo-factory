import type { LedgerEvent } from "../events.ts";
import type { ScrumRun } from "./run-journal.ts";
export interface ScrumTelemetry {
  mode: "scrum";
  policyRevision: string;
  effectiveModels: Record<string, string>;
  taskCount: number;
  elapsedMs: number;
  qaRounds: number;
  confirmedDefects: number;
  ownerRevisions: number;
  tokens?: number;
}
export function scrumTelemetry(
  run: ScrumRun,
  events: readonly LedgerEvent[],
): ScrumTelemetry {
  const tasks = new Set(run.tasks.map((t) => t.task));
  const usage = events.filter(
    (e) => e.event === "meter_written" && tasks.has(e.task),
  );
  const tokens = usage.flatMap((e) =>
    e.event === "meter_written"
      ? [
          e.usage.inputTokens,
          e.usage.cachedInputTokens,
          e.usage.outputTokens,
        ].filter((n): n is number => n !== undefined)
      : [],
  );
  return {
    mode: "scrum",
    policyRevision: run.policyRevision,
    effectiveModels: {
      ...run.config.lanes,
      ...Object.fromEntries(
        run.tasks.flatMap((t) => (t.provider ? [[t.task, t.provider]] : [])),
      ),
    },
    taskCount: run.tasks.length,
    elapsedMs: Math.max(0, Date.now() - Date.parse(run.createdAt)),
    qaRounds: run.fixRounds,
    confirmedDefects: run.qaResult?.confirmedDefects ?? 0,
    ownerRevisions: run.decisions,
    ...(tokens.length ? { tokens: tokens.reduce((a, b) => a + b, 0) } : {}),
  };
}
