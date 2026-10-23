import { EVENT_NAMES, NEEDS_HUMAN_REASONS, needsHumanEvidenceIsValid } from "./events.ts";
import type { LedgerEvent } from "./events.ts";

/** Legacy records have no schema_version; explicit version 1 uses the same shape. */
export function isValidLedgerEvent(value: unknown): value is LedgerEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (event.schema_version === undefined || event.schema_version === 1) &&
    Number.isSafeInteger(event.seq) && (event.seq as number) > 0 &&
    typeof event.ts === "string" &&
    typeof event.event === "string" && (EVENT_NAMES as readonly string[]).includes(event.event) &&
    shapeIsValid(value as LedgerEvent);
}

export interface LedgerValidationOptions {
  /** Optional additional caller restriction; canonical integrity checks always apply. */
  validateEvent?: (event: Record<string, unknown>) => boolean;
}

/** Pure read of acknowledged JSONL records; the unterminated tail is never evidence. */
export function parseLedgerJsonl(raw: string, options: LedgerValidationOptions = {}): { events: LedgerEvent[]; corrupt?: never } | { corrupt: string; events?: never } {
  const lines = raw.split("\n");
  lines.pop();
  const events: LedgerEvent[] = [];
  let previousSeq = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = i + 1;
    if (line === "") return { corrupt: `blank line at line ${at}` };
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { return { corrupt: `line ${at} is not valid JSON` }; }
    if (!isValidLedgerEvent(value) || value.seq <= previousSeq ||
        (options.validateEvent !== undefined && !options.validateEvent(value as unknown as Record<string, unknown>))) {
      return { corrupt: `line ${at} is not a valid ledger event` };
    }
    previousSeq = value.seq;
    events.push(value);
  }
  return { events };
}

/**
 * Per-event required shape. The attempt-scoped loop (ADR 0003) carries a
 * positive-integer Attempt on every post-Contract event; the v0.0.4 choke
 * events carry none — permit events need their task and agent, `git_blocked`
 * needs its command/rule/cwd/blockId and may lack a task entirely (the shim
 * refuses no matter who runs it, bindable or not). The v0.0.5 spawn events
 * carry none either — they precede any attempt — and need their task,
 * provider, arity, and (for a refusal) rule and reason. The v0.0.7
 * `retro_written` carries neither task nor attempt — the factory-level
 * event — and needs its model, outcome and duration. The v0.0.8
 * `meter_written` carries no attempt (usage spans the run) and needs its
 * task, provider, and a usage object of the four daemon fields. The v0.0.10
 * Lead lines carry no attempt either (the stall precedes any Claim): the
 * repoke pair needs task and agent (a refusal adds rule and reason, the
 * spawn pair's own law), and `needs_human` needs task, a fixed-vocabulary
 * reason, and its two evidence seqs (the vocabulary's own shape predicate,
 * events.ts).
 */
function shapeIsValid(evt: LedgerEvent): boolean {
  const asRecord = evt as unknown as Record<string, unknown>;
  const taskIsString = typeof asRecord.task === "string";
  if (evt.event === "contract_set") return taskIsString;
  if (evt.event === "retro_written") {
    return (
      typeof asRecord.model === "string" &&
      (asRecord.outcome === "written" || asRecord.outcome === "failed") &&
      typeof asRecord.durationMs === "number" &&
      Number.isFinite(asRecord.durationMs) &&
      asRecord.durationMs >= 0
    );
  }
  if (evt.event === "permit_allowed" || evt.event === "permit_denied") {
    return taskIsString && typeof asRecord.agent === "string" && (evt.event === "permit_allowed" || typeof asRecord.rule === "string");
  }
  if (evt.event === "git_blocked") {
    return (
      (asRecord.task === undefined || taskIsString) &&
      (asRecord.agent === undefined || typeof asRecord.agent === "string") &&
      typeof asRecord.command === "string" &&
      typeof asRecord.rule === "string" &&
      typeof asRecord.cwd === "string" &&
      typeof asRecord.blockId === "string"
    );
  }
  if (evt.event === "spawn_dispatched" || evt.event === "spawn_refused") {
    return (
      taskIsString &&
      typeof asRecord.provider === "string" &&
      typeof asRecord.arity === "number" &&
      Number.isInteger(asRecord.arity) &&
      asRecord.arity >= 1 &&
      (evt.event === "spawn_dispatched" || (typeof asRecord.rule === "string" && typeof asRecord.reason === "string"))
    );
  }
  if (evt.event === "meter_written") {
    return (
      taskIsString &&
      typeof asRecord.provider === "string" &&
      (asRecord.agent === undefined || typeof asRecord.agent === "string") &&
      usageIsValid(asRecord.usage)
    );
  }
  if (evt.event === "repoke_dispatched" || evt.event === "repoke_refused") {
    return (
      taskIsString &&
      typeof asRecord.agent === "string" &&
      (evt.event === "repoke_dispatched" || (typeof asRecord.rule === "string" && typeof asRecord.reason === "string"))
    );
  }
  if (evt.event === "respawn_dispatched" || evt.event === "respawn_refused") {
    return (
      taskIsString &&
      typeof asRecord.provider === "string" &&
      typeof asRecord.died_agent === "string" &&
      (evt.event === "respawn_dispatched" || (typeof asRecord.rule === "string" && typeof asRecord.reason === "string"))
    );
  }
  if (evt.event === "needs_human") {
    return (
      taskIsString &&
      typeof asRecord.reason === "string" &&
      (NEEDS_HUMAN_REASONS as readonly string[]).includes(asRecord.reason) &&
      needsHumanEvidenceIsValid(asRecord.evidence, asRecord.reason)
    );
  }
  const attempt = asRecord.attempt;
  return taskIsString && typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1;
}

/**
 * The Meter's usage slot (v0.0.8): an object (possibly empty — the honest
 * "the lane reported nothing") whose keys are exactly the daemon's four
 * metered fields, each a finite number when present. Anything else is a
 * corrupted line, never a guessed-at reading.
 */
export function usageIsValid(usage: unknown): boolean {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return false;
  for (const [key, value] of Object.entries(usage)) {
    if (!["inputTokens", "cachedInputTokens", "outputTokens", "totalCostUsd"].includes(key)) return false;
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
  }
  return true;
}

