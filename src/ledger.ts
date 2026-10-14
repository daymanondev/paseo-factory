import { appendFileSync, closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { FactoryError } from "./errors.ts";
import { EVENT_NAMES, NEEDS_HUMAN_REASONS, needsHumanEvidenceIsValid } from "./events.ts";
import type { LedgerEvent, PendingEvent } from "./events.ts";

/**
 * Append-only JSONL ledger. Lines are never mutated or rewritten — the file is
 * the audit trail; `events` is just the read-back view of it.
 *
 * One instance per file per process: two `open` calls on the same path keep
 * independent seq counters and would collide. The v0.0.1 shell holds exactly
 * one factory (and therefore one ledger) per daemon.
 *
 * `append` stamps every event with `ts` (ISO 8601 UTC, ADR 0003) and returns
 * only after the line *and* its `\n` are fsynced. That promise is what makes
 * the one recovery we allow honest: a last line with no trailing newline was
 * never acknowledged to anyone, so on open it is moved to
 * `<path>.quarantine` and dropped (ADR 0003). Any other damage still refuses
 * to open.
 */
export class Ledger {
  readonly #path: string;
  readonly #events: LedgerEvent[] = [];
  #nextSeq: number;

  private constructor(path: string, events: readonly LedgerEvent[]) {
    this.#path = path;
    this.#events.push(...events);
    this.#nextSeq = (events.at(-1)?.seq ?? 0) + 1;
  }

  /** Loads and validates an existing ledger, or starts a fresh one at seq 1. */
  static open(path: string): Ledger {
    mkdirSync(dirname(path), { recursive: true });
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = "";
      else throw err;
    }

    if (raw !== "" && !raw.endsWith("\n")) {
      raw = quarantineUnterminatedTail(path, raw);
    }

    const events: LedgerEvent[] = [];
    if (raw !== "") {
      const lines = raw.split("\n");
      let prevSeq = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line === "") {
          if (i === lines.length - 1) break; // trailing newline after the last event is fine
          throw new FactoryError("corrupted-ledger", `blank line at line ${i + 1} of ${path}`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new FactoryError("corrupted-ledger", `line ${i + 1} of ${path} is not valid JSON: ${line.slice(0, 80)}`);
        }
        const evt = parsed as LedgerEvent;
        const valid =
          typeof evt === "object" &&
          evt !== null &&
          typeof (evt as { seq?: unknown }).seq === "number" &&
          Number.isInteger((evt as { seq: number }).seq) &&
          (evt as { seq: number }).seq > prevSeq &&
          typeof (evt as { event?: unknown }).event === "string" &&
          (EVENT_NAMES as readonly string[]).includes((evt as { event: string }).event) &&
          typeof (evt as { ts?: unknown }).ts === "string" &&
          shapeIsValid(evt);
        if (!valid) {
          throw new FactoryError("corrupted-ledger", `line ${i + 1} of ${path} is not a valid ledger event`);
        }
        prevSeq = (evt as { seq: number }).seq;
        events.push(evt);
      }
    }
    return new Ledger(path, events);
  }

  /** Assigns the next seq, stamps `ts`, appends one JSONL line, fsyncs, and returns the event. */
  append<T extends PendingEvent>(evt: T): T & { seq: number; ts: string } {
    const record = { seq: this.#nextSeq, ts: new Date().toISOString(), ...evt } as T & { seq: number; ts: string };
    const line = `${JSON.stringify(record)}\n`;
    // O_APPEND + a single write makes the line land atomically at EOF; fsync
    // puts it on disk before append returns. Sync I/O also keeps seq assignment
    // and the write atomic within one JS turn.
    const fd = openSync(this.#path, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#events.push(record as LedgerEvent);
    this.#nextSeq += 1;
    return record;
  }

  get path(): string {
    return this.#path;
  }

  get events(): readonly LedgerEvent[] {
    return this.#events;
  }

  eventsFor(task: string): LedgerEvent[] {
    return this.#events.filter((e): boolean => "task" in e && e.task === task);
  }
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

/**
 * Moves the unterminated tail of the ledger file to `<path>.quarantine` and
 * truncates the ledger to its last complete line. Returns the surviving
 * content. The quarantined bytes are kept verbatim for inspection — nothing is
 * silently lost, and nothing half-written is trusted.
 */
function quarantineUnterminatedTail(path: string, raw: string): string {
  const lastNewline = raw.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
  const tail = raw.slice(lastNewline + 1);
  appendFileSync(`${path}.quarantine`, `${tail}\n`);
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, complete);
    ftruncateSync(fd, Buffer.byteLength(complete));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return complete;
}
