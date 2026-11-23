import { projectTask } from "./task-state.ts";
import type { LedgerEvent, PeerAsked, PeerHandoffFields } from "./events.ts";

export interface LoopHealth {
  totalTasks: number;
  peerAskedCount: number;
  peerAskRate: number;
  contextCeilingCount: number;
  silentContextCeilingCount: number;
  genuineUnknownGaps: number;
  redAttempts: number;
  recontracts: number;
}

const ADR0068_GATE_QUEUE_BOILERPLATE =
  /(?:gate\s*queue|daemon\s+gate(?:\s*queue)?|automated\s+verification|(?:full\s+(?:cumulative\s+)?|cumulative\s+)gate)/i;
const ADR0068_DEFERRAL_HINT =
  /(?:defer(?:red|ring|ral)?|async(?:hronous(?:ly)?)?|pending|not\s+pre-?run|on\s+claim|during\s+tdd|skipped\s+(?:local(?:ly)?|pre-?claim|(?:full\s+(?:cumulative\s+)?|cumulative\s+)gate)|runs?\s+(?:async(?:hronous(?:ly)?)?|on\s+claim|in\s+daemon|after\s+claim))/i;
const NEGATED_GAP_PHRASE =
  /\b(?:no|none|nothing|not|without|zero)\s+(?:known\s+|remaining\s+|other\s+)?(?:checks?\s+|tests?\s+)?(?:skipped|failed|blocked|missing|contradictions?)\b/gi;
const NON_SKIPPED_GAP_KEYWORD =
  /\b(?:cannot|can't|missing|contradict(?:s|ed|ing|ion)?|out\s+of\s+scope|failed|blocked)\b/i;
const GENUINE_GAP_KEYWORD =
  /\b(?:cannot|can't|missing|skipped|contradict(?:s|ed|ing|ion)?|out\s+of\s+scope|failed|blocked)\b/i;

function hasGenuineUnknownGap(unknowns: string): boolean {
  const remainingLines = unknowns
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) => {
      if (!(ADR0068_GATE_QUEUE_BOILERPLATE.test(line) && ADR0068_DEFERRAL_HINT.test(line))) {
        return true;
      }
      // Never suppress a real failure or blocker even if deferral wording appears on the same line.
      return NON_SKIPPED_GAP_KEYWORD.test(line.replace(NEGATED_GAP_PHRASE, " "));
    });
  if (remainingLines.length === 0) return false;
  const cleaned = remainingLines.join("\n").replace(NEGATED_GAP_PHRASE, " ");
  return GENUINE_GAP_KEYWORD.test(cleaned);
}

/**
 * Pure deterministic Loop Health digest computed from Ledger events (ADR 0069).
 */
export function computeLoopHealth(events: readonly LedgerEvent[]): LoopHealth {
  const contractCounts = new Map<string, number>();
  const tasksWithPeerAsk = new Set<string>();
  const completeClaimsByAttempt = new Map<string, PeerHandoffFields>();
  let peerAskedCount = 0;
  let redAttempts = 0;

  for (const event of events) {
    if (event.event === "contract_set") {
      contractCounts.set(event.task, (contractCounts.get(event.task) ?? 0) + 1);
    } else if (event.event === "peer_asked") {
      peerAskedCount += 1;
      tasksWithPeerAsk.add((event as PeerAsked).task);
    } else if (event.event === "gate_finished" && event.verdict === "red") {
      redAttempts += 1;
    } else if ((event.event === "gate_queued" || event.event === "claim_reported") && event.handoff !== undefined) {
      const epochIndex = contractCounts.get(event.task) ?? 0;
      const key = `${event.task}\0${epochIndex}\0${event.attempt}`;
      if (event.handoff.outcome === "complete") {
        completeClaimsByAttempt.set(key, event.handoff);
      } else {
        completeClaimsByAttempt.delete(key);
      }
    }
  }

  const contractedTasks = [...contractCounts.keys()];
  const totalTasks = contractedTasks.length;
  let contractedTasksWithAsk = 0;
  let contextCeilingCount = 0;
  let silentContextCeilingCount = 0;
  let recontracts = 0;

  for (const task of contractedTasks) {
    recontracts += Math.max(0, (contractCounts.get(task) ?? 0) - 1);
    if (tasksWithPeerAsk.has(task)) contractedTasksWithAsk += 1;
    const state = projectTask(events, task);
    if (state.closed !== undefined && /context[-_ ]?ceiling/i.test(state.closed.reason)) {
      contextCeilingCount += 1;
      if (!state.epoch.some((e) => e.event === "peer_asked")) {
        silentContextCeilingCount += 1;
      }
    }
  }

  let genuineUnknownGaps = 0;
  for (const handoff of completeClaimsByAttempt.values()) {
    if (hasGenuineUnknownGap(handoff.unknowns)) {
      genuineUnknownGaps += 1;
    }
  }

  return {
    totalTasks,
    peerAskedCount,
    peerAskRate: totalTasks === 0 ? 0 : contractedTasksWithAsk / totalTasks,
    contextCeilingCount,
    silentContextCeilingCount,
    genuineUnknownGaps,
    redAttempts,
    recontracts,
  };
}

/**
 * Pure multi-project Loop Health aggregator (ADR 0069): evaluates each Project
 * event stream independently so identical Task IDs (e.g. `T-01`) across
 * different Projects never collide into false recontracts or merged counts.
 */
export function computeLoopHealthForStreams(streams: readonly (readonly LedgerEvent[])[]): LoopHealth {
  let totalTasks = 0;
  let peerAskedCount = 0;
  let contractedTasksWithAsk = 0;
  let contextCeilingCount = 0;
  let silentContextCeilingCount = 0;
  let genuineUnknownGaps = 0;
  let redAttempts = 0;
  let recontracts = 0;

  for (const stream of streams) {
    const health = computeLoopHealth(stream);
    totalTasks += health.totalTasks;
    peerAskedCount += health.peerAskedCount;
    contractedTasksWithAsk += Math.round(health.peerAskRate * health.totalTasks);
    contextCeilingCount += health.contextCeilingCount;
    silentContextCeilingCount += health.silentContextCeilingCount;
    genuineUnknownGaps += health.genuineUnknownGaps;
    redAttempts += health.redAttempts;
    recontracts += health.recontracts;
  }

  return {
    totalTasks,
    peerAskedCount,
    peerAskRate: totalTasks === 0 ? 0 : contractedTasksWithAsk / totalTasks,
    contextCeilingCount,
    silentContextCeilingCount,
    genuineUnknownGaps,
    redAttempts,
    recontracts,
  };
}

/** Compact 3-line Loop Health summary for `supervisor_read_ledger` (ADR 0069). */
export function formatLoopHealthLines(health: LoopHealth): string[] {
  const pct = health.totalTasks === 0 ? "0%" : `${Math.round(health.peerAskRate * 100)}%`;
  return [
    "Loop Health:",
    `- tasks=${health.totalTasks} peer_asked=${health.peerAskedCount} (${pct}) · recontracts=${health.recontracts} red_attempts=${health.redAttempts}`,
    `- context_ceiling=${health.contextCeilingCount} (silent=${health.silentContextCeilingCount}) · genuine_unknown_gaps=${health.genuineUnknownGaps}`,
  ];
}
