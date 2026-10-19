import { appendFileSync, closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { FactoryError } from "./errors.ts";

/**
 * The Lead mailbox — one append-only `mailbox.jsonl` per Project, the sole
 * mail channel into the standing `Lead` seat (ADR 0013 Decision 4).
 *
 * Never a mutable JSON array, never SQLite (ADR 0004's law): every state
 * transition is one immutable JSONL line — `mail_queued`, `mail_delivered`,
 * `mail_acked`, `mail_requeued` — appended by the single-writer plugin with
 * `fs.appendFileSync`, so the file is the audit trail and any reader can
 * rebuild the present from it alone.
 *
 * The split this module keeps deliberately sharp: the fold
 * (`foldLeadMailboxEvents` / `readLeadMailbox`) is pure and deterministic and
 * *tolerates* sequences that cannot happen (a second delivery while one is
 * live, a settle naming a foreign deliveryId — ignored, never crashed on,
 * never double-counted), while the write helpers *prevent* those same
 * sequences by re-reading the file before every append. The one recovery we
 * own is startup: an in-flight batch with no settle yet came back, so
 * `recoverLeadMailbox` appends exactly one `mail_requeued` (`"daemon-restart"`
 * on plugin boot, `"lead-rotated"` on rotation) and is a no-op on the second
 * run — zero mail is ever lost across a restart.
 */

export type LeadMailFrom = "supervisor" | "owner" | "peer" | "system";
export type LeadMailKind = "directive" | "verdict" | "needs_human";

export type LeadMailboxEvent =
  | {
      seq: number;
      ts: string;
      type: "mail_queued";
      mailId: string;
      from: LeadMailFrom;
      kind: LeadMailKind;
      task?: string;
      text: string;
    }
  | {
      seq: number;
      ts: string;
      type: "mail_delivered";
      deliveryId: string;
      mailIds: string[];
      toAgentId: string;
    }
  | {
      seq: number;
      ts: string;
      type: "mail_acked";
      deliveryId: string;
      mailIds: string[];
      byAgentId: string;
    }
  | {
      seq: number;
      ts: string;
      type: "mail_requeued";
      deliveryId: string;
      mailIds: string[];
      reason: string;
    };

export interface LeadMailItem {
  mailId: string;
  seq: number;
  ts: string;
  from: LeadMailFrom;
  kind: LeadMailKind;
  task?: string;
  text: string;
  status: "queued" | "delivered" | "acked";
  deliveryId?: string;
  toAgentId?: string;
}

export interface LeadMailboxState {
  queued: LeadMailItem[];
  inFlight: { deliveryId: string; toAgentId: string; items: LeadMailItem[] } | null;
  ackedCount: number;
}

type QueuedEvent = Extract<LeadMailboxEvent, { type: "mail_queued" }>;
type DeliveredEvent = Extract<LeadMailboxEvent, { type: "mail_delivered" }>;
type AckedEvent = Extract<LeadMailboxEvent, { type: "mail_acked" }>;
type RequeuedEvent = Extract<LeadMailboxEvent, { type: "mail_requeued" }>;

/** An event minus the two stamps `appendMailboxEvent` owns. */
type PendingMailboxEvent = DistributiveOmit<LeadMailboxEvent, "seq" | "ts">;

// `Omit` does not distribute over unions; this one does.
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

const FROMS: readonly string[] = ["supervisor", "owner", "peer", "system"];
const KINDS: readonly string[] = ["directive", "verdict", "needs_human"];
const EVENT_TYPES: readonly string[] = ["mail_queued", "mail_delivered", "mail_acked", "mail_requeued"];

/**
 * Folds mailbox events into the present `LeadMailboxState` — pure, no I/O,
 * deterministic: the same events always fold to the same state.
 *
 * `mail_queued` pushes a queued item (enqueue-while-`inFlight` is legal —
 * §User Story 12 — the item simply waits). `mail_delivered` moves the
 * currently-queued items it names into `inFlight` — at most one live
 * delivery, so a second deliver is ignored (the writer prevents it).
 * `mail_acked` closes the live delivery into `ackedCount`. `mail_requeued`
 * returns the batch to `queued` and clears `inFlight`. Settles naming a
 * delivery that is not the live one are ignored. `queued` comes back in
 * enqueue order (`seq` ascending) even after a requeue interleaved with new
 * arrivals.
 */
export function foldLeadMailboxEvents(events: readonly LeadMailboxEvent[]): LeadMailboxState {
  const queued: LeadMailItem[] = [];
  let inFlight: LeadMailboxState["inFlight"] = null;
  let ackedCount = 0;

  for (const evt of events) {
    switch (evt.type) {
      case "mail_queued": {
        queued.push({
          mailId: evt.mailId,
          seq: evt.seq,
          ts: evt.ts,
          from: evt.from,
          kind: evt.kind,
          ...(evt.task === undefined ? {} : { task: evt.task }),
          text: evt.text,
          status: "queued",
        });
        break;
      }
      case "mail_delivered": {
        if (inFlight !== null) break; // impossible from this writer; tolerated here
        const named = new Set(evt.mailIds);
        const items = queued.filter((item) => named.has(item.mailId));
        if (items.length === 0) break;
        for (let i = queued.length - 1; i >= 0; i--) {
          if (named.has(queued[i]!.mailId)) queued.splice(i, 1);
        }
        inFlight = {
          deliveryId: evt.deliveryId,
          toAgentId: evt.toAgentId,
          items: items.map((item) => ({ ...item, status: "delivered" as const, deliveryId: evt.deliveryId, toAgentId: evt.toAgentId })),
        };
        break;
      }
      case "mail_acked": {
        if (inFlight === null || inFlight.deliveryId !== evt.deliveryId) break;
        ackedCount += inFlight.items.length;
        inFlight = null;
        break;
      }
      case "mail_requeued": {
        if (inFlight === null || inFlight.deliveryId !== evt.deliveryId) break;
        for (const item of inFlight.items) {
          queued.push({
            mailId: item.mailId,
            seq: item.seq,
            ts: item.ts,
            from: item.from,
            kind: item.kind,
            ...(item.task === undefined ? {} : { task: item.task }),
            text: item.text,
            status: "queued",
          });
        }
        inFlight = null;
        break;
      }
    }
  }

  return { queued: [...queued].sort((a, b) => a.seq - b.seq), inFlight, ackedCount };
}

/** Reads `<projectStateDir>/mailbox.jsonl` (missing = empty) and folds it into the present state. */
export function readLeadMailbox(path: string): LeadMailboxState {
  return foldLeadMailboxEvents(readMailboxEvents(path));
}

/** Appends `mail_queued` — the one ingress verb; `mailId` generated, `seq` prior-max+1, `ts` ISO now. */
export function enqueueLeadMail(
  path: string,
  mail: { from: LeadMailFrom; kind: LeadMailKind; task?: string; text: string },
): QueuedEvent {
  return appendMailboxEvent(path, { type: "mail_queued", mailId: randomUUID(), ...mail });
}

/**
 * Appends `mail_delivered` for a batch of currently-queued mailIds with a
 * generated `deliveryId`. Refuses a second live delivery, an empty batch, and
 * any mailId not currently queued — the impossibilities the fold only tolerates.
 */
export function deliverLeadMail(path: string, delivery: { mailIds: string[]; toAgentId: string }): DeliveredEvent {
  const state = readLeadMailbox(path);
  if (state.inFlight !== null) {
    throw new FactoryError("mailbox-in-flight", `delivery ${state.inFlight.deliveryId} is still live in ${path} — settle it before delivering again`);
  }
  if (delivery.mailIds.length === 0) {
    throw new FactoryError("mailbox-empty-delivery", `a delivery into ${path} must carry at least one mail item`);
  }
  const queuedIds = new Set(state.queued.map((item) => item.mailId));
  const unknown = delivery.mailIds.filter((id) => !queuedIds.has(id));
  if (unknown.length > 0) {
    throw new FactoryError("mailbox-unknown-mail", `cannot deliver mail that is not queued in ${path}: ${unknown.join(", ")}`);
  }
  return appendMailboxEvent(path, { type: "mail_delivered", deliveryId: randomUUID(), mailIds: [...delivery.mailIds], toAgentId: delivery.toAgentId });
}

/**
 * Appends `mail_acked` — only the plugin calls this, when the `Lead` turn that
 * received the live delivery finishes with `outcome === "completed"`
 * (ADR 0013 Decision 4's 3-state turn-end rule). Refuses anything but the
 * live delivery and its exact batch.
 */
export function ackLeadMail(path: string, ack: { deliveryId: string; mailIds: string[]; byAgentId: string }): AckedEvent {
  requireLiveDelivery(path, ack.deliveryId, ack.mailIds, "ack");
  return appendMailboxEvent(path, { type: "mail_acked", ...ack });
}

/**
 * Appends `mail_requeued` — a failed or cancelled `Lead` turn returning its
 * batch to `queued`. Same live-delivery law as the ack.
 */
export function requeueLeadMail(path: string, requeue: { deliveryId: string; mailIds: string[]; reason: string }): RequeuedEvent {
  requireLiveDelivery(path, requeue.deliveryId, requeue.mailIds, "requeue");
  return appendMailboxEvent(path, { type: "mail_requeued", ...requeue });
}

/**
 * Startup recovery: fold the file and, when a delivered batch never got its
 * settle, append exactly one `mail_requeued` carrying the caller's reason
 * (`"daemon-restart"` on plugin boot, `"lead-rotated"` on rotation) so the
 * batch returns to `queued`. Nothing in flight — nothing appended, so a
 * second run never duplicates the line.
 */
export function recoverLeadMailbox(path: string, reason: string): RequeuedEvent[] {
  const state = readLeadMailbox(path);
  if (state.inFlight === null) return [];
  const settled = appendMailboxEvent(path, {
    type: "mail_requeued",
    deliveryId: state.inFlight.deliveryId,
    mailIds: state.inFlight.items.map((item) => item.mailId),
    reason,
  });
  return [settled];
}

/** The shared writer-side law of ack and requeue: they settle THE live delivery, naming exactly its batch. */
function requireLiveDelivery(path: string, deliveryId: string, mailIds: string[], act: string): void {
  const state = readLeadMailbox(path);
  if (state.inFlight === null) {
    throw new FactoryError("mailbox-idle", `no delivery is live in ${path} — nothing to ${act}`);
  }
  if (state.inFlight.deliveryId !== deliveryId) {
    throw new FactoryError("mailbox-idle", `delivery ${deliveryId} is not the live delivery (${state.inFlight.deliveryId}) in ${path}`);
  }
  const live = new Set(state.inFlight.items.map((item) => item.mailId));
  if (mailIds.length !== live.size || mailIds.some((id) => !live.has(id))) {
    throw new FactoryError("mailbox-unknown-mail", `the ${act} of ${deliveryId} must name exactly the live batch in ${path}`);
  }
}

/**
 * Assigns `seq` = prior-max+1, stamps `ts` (ISO 8601 UTC), appends one JSONL
 * line, and returns the event. Re-reads (and re-validates) the whole file
 * first: the single writer's serialized lane makes read-then-append atomic in
 * practice, and a corrupted file refuses to grow rather than appending onto
 * damage.
 */
function appendMailboxEvent<T extends PendingMailboxEvent>(path: string, pending: T): T & { seq: number; ts: string } {
  mkdirSync(dirname(path), { recursive: true });
  const events = readMailboxEvents(path);
  const record = { seq: (events.at(-1)?.seq ?? 0) + 1, ts: new Date().toISOString(), ...pending } as T & { seq: number; ts: string };
  appendFileSync(path, `${JSON.stringify(record)}\n`);
  return record;
}

/** Loads and validates every line, quarantining an unterminated tail (a torn append was never an event). */
function readMailboxEvents(path: string): LeadMailboxEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  if (raw !== "" && !raw.endsWith("\n")) {
    raw = quarantineUnterminatedTail(path, raw);
  }
  if (raw === "") return [];

  const events: LeadMailboxEvent[] = [];
  const lines = raw.split("\n");
  let prevSeq = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") {
      if (i === lines.length - 1) break; // trailing newline after the last event is fine
      throw new FactoryError("corrupted-mailbox", `blank line at line ${i + 1} of ${path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new FactoryError("corrupted-mailbox", `line ${i + 1} of ${path} is not valid JSON: ${line.slice(0, 80)}`);
    }
    const evt = parsed as LeadMailboxEvent;
    if (!shapeIsValid(evt, prevSeq)) {
      throw new FactoryError("corrupted-mailbox", `line ${i + 1} of ${path} is not a valid mailbox event`);
    }
    prevSeq = evt.seq;
    events.push(evt);
  }
  return events;
}

/** Per-event required shape, mirroring the ledger's law: damage is refused, never guessed at. */
function shapeIsValid(evt: LeadMailboxEvent, prevSeq: number): boolean {
  if (typeof evt !== "object" || evt === null) return false;
  const asRecord = evt as unknown as Record<string, unknown>;
  if (typeof asRecord.seq !== "number" || !Number.isInteger(asRecord.seq) || asRecord.seq <= prevSeq) return false;
  if (typeof asRecord.ts !== "string") return false;
  if (!EVENT_TYPES.includes(asRecord.type as string)) return false;
  const mailIdsOk = (value: unknown): boolean => Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string");
  switch (evt.type) {
    case "mail_queued":
      return (
        typeof asRecord.mailId === "string" &&
        FROMS.includes(asRecord.from as string) &&
        KINDS.includes(asRecord.kind as string) &&
        (asRecord.task === undefined || typeof asRecord.task === "string") &&
        typeof asRecord.text === "string"
      );
    case "mail_delivered":
      return typeof asRecord.deliveryId === "string" && mailIdsOk(asRecord.mailIds) && typeof asRecord.toAgentId === "string";
    case "mail_acked":
      return typeof asRecord.deliveryId === "string" && mailIdsOk(asRecord.mailIds) && typeof asRecord.byAgentId === "string";
    case "mail_requeued":
      return typeof asRecord.deliveryId === "string" && mailIdsOk(asRecord.mailIds) && typeof asRecord.reason === "string";
  }
}

/**
 * Moves the unterminated tail of the mailbox file to `<path>.quarantine` and
 * truncates the mailbox to its last complete line — the ledger's own recovery
 * (ADR 0003), reused: nothing half-written is trusted, and nothing is
 * silently lost.
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
