import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { FactoryError } from "./errors.ts";
import { eventAllowsUnboundEpoch } from "./events.ts";
import { remapLedgerReferences } from "./history-identity.ts";
import { isValidLedgerEvent, parseLedgerJsonl } from "./ledger-validation.ts";
export { isValidLedgerEvent, parseLedgerJsonl, usageIsValid } from "./ledger-validation.ts";
import type { EventIdentityMetadata, LedgerEvent, LedgerSchema, PendingEvent } from "./events.ts";

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
  readonly #schema: LedgerSchema | undefined;

  private constructor(path: string, events: readonly LedgerEvent[]) {
    this.#path = path;
    this.#events.push(...events);
    this.#nextSeq = (events.at(-1)?.seq ?? 0) + 1;
    this.#schema = events.find((event): event is LedgerSchema => event.event === "ledger_schema");
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

    const read = parseLedgerJsonl(raw);
    if (read.corrupt !== undefined) throw new FactoryError("corrupted-ledger", `${read.corrupt} of ${path}`);
    return new Ledger(path, read.events);
  }

  /** Assigns the next seq, stamps `ts`, appends one JSONL line, fsyncs, and returns the event. */
  append<T extends PendingEvent>(evt: T): T & { seq: number; ts: string } & EventIdentityMetadata {
    const identity: EventIdentityMetadata = {};
    if (this.#schema !== undefined) {
      const eventId = `event:${randomUUID()}`;
      const task = "task" in evt ? evt.task : undefined;
      const epoch = evt.event === "contract_set" ? eventId : task === undefined ? undefined : this.#events.findLast((event) => event.event === "contract_set" && event.task === task)?.epoch_id;
      if (task !== undefined && epoch === undefined && !eventAllowsUnboundEpoch(evt.event)) throw new FactoryError("invalid-event-epoch", `Task ${task} has no current Contract epoch`);
      Object.assign(identity, { schema_version: 2, event_id: eventId, provenance: { writer_id: this.#schema.writer_id }, ...(epoch === undefined ? {} : { epoch_id: epoch }) });
    }
    const record = { ...evt, seq: this.#nextSeq, ts: new Date().toISOString(), ...identity } as T & { seq: number; ts: string } & EventIdentityMetadata;
    if (this.#schema !== undefined) {
      const context = [...this.#events, record as LedgerEvent];
      const resolved = remapLedgerReferences(record as LedgerEvent, context, context);
      if (!resolved.ok) throw new FactoryError("invalid-event-reference", resolved.reasons.join("; "));
      Object.assign(record, resolved.event);
      if (!isValidLedgerEvent(record)) throw new FactoryError("invalid-event", "record does not satisfy the active Ledger schema");
    }
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

  /**
   * Removes all events matching `predicate` from the in-memory event array and
   * atomically rewrites the ledger file with the remaining events (Owner-only
   * reset path, v0.0.24). Preserves each remaining event's `seq`, updates
   * `#nextSeq` to `(lastRemaining?.seq ?? 0) + 1`, and returns the number of
   * purged events.
   */
  purgeWhere(predicate: (event: LedgerEvent) => boolean): number {
    const remaining: LedgerEvent[] = [];
    let purged = 0;
    for (const evt of this.#events) {
      if (evt.event !== "ledger_schema" && predicate(evt)) {
        purged += 1;
      } else {
        remaining.push(evt);
      }
    }
    this.#events.splice(0, this.#events.length, ...remaining);
    this.#nextSeq = (this.#events.at(-1)?.seq ?? 0) + 1;
    mkdirSync(dirname(this.#path), { recursive: true });
    const content = remaining.map((evt) => `${JSON.stringify(evt)}\n`).join("");
    const tmpPath = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(tmpPath, "w");
    try {
      if (content !== "") writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, this.#path);
    return purged;
  }
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
