import { eventAllowsUnboundEpoch, LEDGER_REFERENCE_KINDS, EVENT_NAMES, NEEDS_HUMAN_REASONS, needsHumanEvidenceIsValid } from "./events.ts";
import type { LedgerEvent } from "./events.ts";

/** Legacy records remain readable. V2 requires identities and a file-level writer fence. */
export function isValidLedgerEvent(value: unknown): value is LedgerEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (event.schema_version === undefined || event.schema_version === 1 || event.schema_version === 2) &&
    (event.schema_version !== 2 || identityMetadataIsValid(event)) &&
    Number.isSafeInteger(event.seq) && (event.seq as number) > 0 &&
    typeof event.ts === "string" &&
    typeof event.event === "string" && (EVENT_NAMES as readonly string[]).includes(event.event) &&
    shapeIsValid(value as LedgerEvent);
}

function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }

function identityMetadataIsValid(event: Record<string, unknown>): boolean {
  if (!nonempty(event.event_id)) return false;
  if (typeof event.provenance !== "object" || event.provenance === null || Array.isArray(event.provenance)) return false;
  const writer = (event.provenance as Record<string, unknown>).writer_id;
  if (writer !== null && !nonempty(writer)) return false;
  if (event.task !== undefined && !nonempty(event.epoch_id) && !(event.epoch_id === undefined && eventAllowsUnboundEpoch(String(event.event)))) return false;
  if (event.task === undefined && event.epoch_id !== undefined) return false;
  if (event.event === "contract_set" && event.epoch_id !== event.event_id) return false;
  if (event.references !== undefined) {
    if (event.event !== "needs_human" || typeof event.references !== "object" || event.references === null || Array.isArray(event.references)) return false;
    for (const [key, target] of Object.entries(event.references)) if (!["denial", "repoke", "gate", "spawn", "respawn"].includes(key) || !nonempty(target)) return false;
  }
  if (event.event === "needs_human") {
    if (event.references === undefined) return false;
    const evidence = event.evidence;
    if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return false;
    const fields = Object.keys(evidence).filter((field) => field !== "attempt").sort();
    if (fields.join(",") !== Object.keys(event.references as object).sort().join(",")) return false;
  }
  return true;
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
  const fences = events.filter((event) => event.event === "ledger_schema");
  const versioned = events.some((event) => event.schema_version === 2);
  if (fences.length > 1 || (versioned && fences.length !== 1) || (fences.length === 1 && events.some((event) => event.schema_version !== 2))) return { corrupt: "v2 history requires exactly one schema fence and identified records" };
  const ids = new Set<string>();
  for (const event of events) {
    if (event.event_id === undefined) continue;
    if (ids.has(event.event_id)) return { corrupt: `duplicate stable event identity at seq ${event.seq}` };
    ids.add(event.event_id);
  }
  if (versioned) {
    const epochs = new Map<string, string>();
    const prior = new Map<number, LedgerEvent>();
    for (const event of events) {
      if (event.event === "contract_set") epochs.set(event.task, event.event_id!);
      if ("task" in event && typeof event.task === "string" && epochs.get(event.task) !== event.epoch_id) return { corrupt: `seq ${event.seq} is outside its current Contract epoch` };
      if (event.event === "needs_human") {
        for (const [field, seq] of Object.entries(event.evidence)) {
          if (field === "attempt") continue;
          const target = prior.get(seq);
          const key = field as keyof typeof LEDGER_REFERENCE_KINDS;
          if (target === undefined || target.event !== LEDGER_REFERENCE_KINDS[key] || !("task" in target) || target.task !== event.task || target.epoch_id !== event.epoch_id || target.event_id !== event.references?.[key]) return { corrupt: `seq ${event.seq} has an unresolved ${field} reference` };
          if (field === "gate" && (target.event !== "gate_finished" || target.verdict !== "red" || target.attempt !== (event.evidence as { attempt?: number }).attempt)) return { corrupt: `seq ${event.seq} has invalid red Attempt evidence` };
        }
      }
      prior.set(event.seq, event);
    }
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
  if (evt.event === "ledger_schema") return asRecord.schema_version === 2 && asRecord.version === 2 && nonempty(asRecord.ledger_id) && nonempty(asRecord.writer_id) && (asRecord.provenance as Record<string, unknown> | undefined)?.writer_id === asRecord.writer_id;
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

