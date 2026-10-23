/** Pure history identity and source-reference plans. This module never writes
 * live state; explicit migration/import admission owns activation.
 */
import { createHash } from "node:crypto";
import { eventAllowsUnboundEpoch, LEDGER_REFERENCE_KINDS } from "./events.ts";
import { isValidLedgerEvent, parseLedgerJsonl } from "./ledger-validation.ts";
import type { LedgerEvent, LedgerReferenceField, LedgerSchema } from "./events.ts";

export interface IdentityMappingEntry {
  sourceSeq: number;
  eventId: string;
  epochId?: string;
  contentHash: string;
}
export interface LegacyIdentityMapping {
  version: 1;
  namespace: string;
  entries: IdentityMappingEntry[];
}
export interface IdentityPlan {
  ok: boolean;
  source: { snapshotHash: string; namespace: string; holderId?: string; acknowledgedBytes: number; tail?: string };
  events: LedgerEvent[];
  mapping: LegacyIdentityMapping;
  conflicts: string[];
  diagnostics: string[];
}

export function canonicalHistoryJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalHistoryJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalHistoryJson(item)}`).join(",")}}`;
}
export function historyHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function legacyIdentityMappingIsValid(value: unknown): value is LegacyIdentityMapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const mapping = value as LegacyIdentityMapping;
  if (mapping.version !== 1 || typeof mapping.namespace !== "string" || mapping.namespace.trim() === "" || !Array.isArray(mapping.entries)) return false;
  let previousSeq = 0;
  const ids = new Set<string>();
  for (const entry of mapping.entries) {
    if (typeof entry !== "object" || entry === null || !Number.isSafeInteger(entry.sourceSeq) || entry.sourceSeq <= previousSeq || typeof entry.eventId !== "string" || entry.eventId.trim() === "" || ids.has(entry.eventId) || typeof entry.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.contentHash) || (entry.epochId !== undefined && (typeof entry.epochId !== "string" || entry.epochId.trim() === ""))) return false;
    previousSeq = entry.sourceSeq;
    ids.add(entry.eventId);
  }
  return true;
}

function priorContentMatches(event: LedgerEvent, expected: string, current: string): boolean {
  if (current === expected) return true;
  if (event.schema_version !== 2) return false;
  // Prepared metadata is additive. The byte-preserved legacy snapshot remains
  // the authority for whether schema_version was absent or explicitly 1.
  const { schema_version: _version, event_id: _id, epoch_id: _epoch, provenance: _origin, references: _references, ...legacy } = event;
  return [legacy, { ...legacy, schema_version: 1 }].some((candidate) => historyHash(canonicalHistoryJson(candidate)) === expected);
}

export function planLegacyIdentity(raw: string, options: { holderId?: string; writerId: string; previous?: LegacyIdentityMapping }): IdentityPlan {
  const snapshotHash = historyHash(raw);
  let namespace = typeof options.previous?.namespace === "string" ? options.previous.namespace : `legacy-${snapshotHash}`;
  const acknowledged = raw.slice(0, raw.lastIndexOf("\n") + 1);
  const tail = raw.slice(acknowledged.length);
  const plan: IdentityPlan = {
    ok: true,
    source: { snapshotHash, namespace, ...(options.holderId === undefined ? {} : { holderId: options.holderId }), acknowledgedBytes: Buffer.byteLength(acknowledged), ...(tail === "" ? {} : { tail }) },
    events: [], mapping: { version: 1, namespace, entries: [] }, conflicts: [], diagnostics: tail === "" ? [] : ["unacknowledged tail preserved outside evidence"],
  };
  if (options.previous !== undefined && !legacyIdentityMappingIsValid(options.previous)) {
    plan.ok = false; plan.conflicts.push("unsupported or damaged prior identity mapping"); return plan;
  }
  const read = parseLedgerJsonl(raw);
  if (read.corrupt !== undefined) { plan.ok = false; plan.conflicts.push(read.corrupt); return plan; }
  const fence = read.events.find((event) => event.event === "ledger_schema");
  if (fence !== undefined) {
    namespace = fence.ledger_id;
    plan.source.namespace = namespace;
    plan.mapping.namespace = namespace;
    if (options.previous !== undefined && options.previous.namespace !== namespace) { plan.ok = false; plan.conflicts.push("prior mapping namespace differs from the identified Ledger"); }
  }
  if (options.writerId.trim() === "") { plan.ok = false; plan.conflicts.push("a nonempty writer identity is required for prepared activation"); }
  const epochs = new Map<string, string>();
  if (options.previous !== undefined && (options.previous.version !== 1 || options.previous.entries.length > read.events.length)) {
    plan.ok = false; plan.conflicts.push("prior identity mapping does not describe a supported source prefix");
  }
  for (const event of read.events) {
    const contentHash = historyHash(canonicalHistoryJson(event));
    const identified = event.schema_version === 2;
    if (!identified && [event.event_id, event.epoch_id, event.provenance, event.references].some((value) => value !== undefined)) {
      plan.ok = false; plan.conflicts.push(`seq ${event.seq}: unversioned identity/provenance metadata is unresolved`);
    }
    const eventId = identified ? event.event_id! : `legacy:${historyHash(`${namespace}:${event.seq}:${contentHash}`)}`;
    if (event.event === "contract_set") epochs.set(event.task, eventId);
    const epochId = (identified ? event.epoch_id : undefined) ?? ("task" in event && event.task !== undefined ? epochs.get(event.task) : undefined);
    if ("task" in event && event.task !== undefined && epochId === undefined && !eventAllowsUnboundEpoch(event.event)) {
      plan.ok = false; plan.conflicts.push(`seq ${event.seq}: Task has no demonstrable Contract epoch`);
    }
    const previous = options.previous?.entries[plan.mapping.entries.length];
    if (previous !== undefined && (previous.sourceSeq !== event.seq || previous.eventId !== eventId || previous.epochId !== epochId || !priorContentMatches(event, previous.contentHash, contentHash))) {
      plan.ok = false; plan.conflicts.push(`seq ${event.seq}: prior identity mapping does not match the demonstrated source prefix`);
    }
    plan.mapping.entries.push({ sourceSeq: event.seq, eventId, ...(epochId === undefined ? {} : { epochId }), contentHash });
    plan.events.push({ ...event, schema_version: 2, event_id: eventId, ...(epochId === undefined ? {} : { epoch_id: epochId }), provenance: identified ? event.provenance! : { writer_id: null } });
  }
  plan.events = plan.events.map((event) => {
    const resolved = remapLedgerReferences(event, plan.events, plan.events);
    if (resolved.ok) return resolved.event;
    plan.ok = false;
    plan.conflicts.push(...resolved.reasons.map((reason) => `seq ${event.seq}: ${reason}`));
    return event;
  });
  if (!plan.events.some((event) => event.event === "ledger_schema")) {
    const fence: LedgerSchema = { seq: (plan.events.at(-1)?.seq ?? 0) + 1, ts: plan.events.at(-1)?.ts ?? "1970-01-01T00:00:00.000Z", event: "ledger_schema", schema_version: 2, version: 2, ledger_id: namespace, writer_id: options.writerId, event_id: `schema:${historyHash(namespace)}`, provenance: { writer_id: options.writerId } };
    if (Number.isSafeInteger(fence.seq)) plan.events.push(fence);
    else { plan.ok = false; plan.conflicts.push("no safe sequence remains for the v2 writer fence"); }
  }
  if (plan.ok) {
    const prepared = parseLedgerJsonl(plan.events.map((event) => JSON.stringify(event) + "\n").join(""));
    if (prepared.corrupt !== undefined) { plan.ok = false; plan.conflicts.push(`prepared history: ${prepared.corrupt}`); }
  }
  return plan;
}

export type ReferenceResolution = { ok: true; event: LedgerEvent } | { ok: false; reason: string };

/** Resolve one public numeric source citation to the same stable local fact.
 * A positive number or a matching local number alone is never corroboration.
 */
export function resolveLedgerReference(input: {
  sourceSeq: number;
  sourceEvents: readonly LedgerEvent[];
  localEvents: readonly LedgerEvent[];
  expected?: { kind?: LedgerEvent["event"]; task?: string; epochId?: string; beforeSourceSeq?: number; eventId?: string };
}): ReferenceResolution {
  const source = input.sourceEvents.filter((event) => event.seq === input.sourceSeq);
  if (source.length !== 1 || source[0]!.event_id === undefined) return { ok: false, reason: `source seq ${input.sourceSeq} has no unambiguous stable identity` };
  const original = source[0]!;
  const expected = input.expected;
  if (expected?.eventId !== undefined && expected.eventId !== original.event_id) return { ok: false, reason: `source seq ${input.sourceSeq} disagrees with its recorded reference identity` };
  if (expected?.kind !== undefined && original.event !== expected.kind) return { ok: false, reason: `source seq ${input.sourceSeq} is not ${expected.kind}` };
  if (expected?.task !== undefined && (!("task" in original) || original.task !== expected.task)) return { ok: false, reason: `source seq ${input.sourceSeq} belongs to another Task` };
  if (expected?.epochId !== undefined && original.epoch_id !== expected.epochId) return { ok: false, reason: `source seq ${input.sourceSeq} belongs to another Contract epoch` };
  if (expected?.beforeSourceSeq !== undefined && original.seq >= expected.beforeSourceSeq) return { ok: false, reason: `source seq ${input.sourceSeq} is not prior evidence` };
  const targets = input.localEvents.filter((event) => event.event_id === original.event_id);
  if (targets.length !== 1) return { ok: false, reason: `stable target ${original.event_id} is unavailable or ambiguous locally` };
  const target = targets[0]!;
  if (semanticEventContent(original, input.sourceEvents) !== semanticEventContent(target, input.localEvents)) return { ok: false, reason: `stable target ${original.event_id} has contradictory local content` };
  return { ok: true, event: target };
}

/** Remaps only actual Ledger reference fields. Attempt, mailbox and timeline
 * ordinals are separate domains; associated text/files remain byte-preserved.
 */
export function remapLedgerReferences(event: LedgerEvent, sourceEvents: readonly LedgerEvent[], localEvents: readonly LedgerEvent[]): { ok: true; event: LedgerEvent } | { ok: false; reasons: string[] } {
  if (event.event !== "needs_human") return { ok: true, event: { ...event } };
  const evidence = { ...event.evidence } as Record<string, number>;
  const references = { ...event.references };
  const reasons: string[] = [];
  for (const [field, value] of Object.entries(evidence)) {
    if (field === "attempt") continue;
    const kind = LEDGER_REFERENCE_KINDS[field as LedgerReferenceField];
    if (kind === undefined) { reasons.push(`unknown Ledger reference field ${field}`); continue; }
    const resolved = resolveLedgerReference({ sourceSeq: value, sourceEvents, localEvents, expected: { kind, task: event.task, epochId: event.epoch_id, beforeSourceSeq: event.seq, eventId: event.references?.[field as LedgerReferenceField] } });
    if (!resolved.ok) { reasons.push(`${field}: ${resolved.reason}`); continue; }
    if (field === "gate" && (resolved.event.event !== "gate_finished" || resolved.event.verdict !== "red" || resolved.event.attempt !== evidence.attempt)) { reasons.push("gate: evidence does not identify this red ceiling Attempt"); continue; }
    evidence[field] = resolved.event.seq;
    references[field as LedgerReferenceField] = resolved.event.event_id!;
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, event: { ...event, evidence: evidence as unknown as typeof event.evidence, references } };
}

/** Identity comparison normalizes numeric references to their stable targets.
 * Holder/route metadata belongs to source manifests and is never an event fact.
 */
export function semanticEventContent(event: LedgerEvent, context: readonly LedgerEvent[]): string {
  const { seq: _seq, ...payload } = event;
  if (event.event !== "needs_human") return canonicalHistoryJson(payload);
  const evidence: Record<string, number | string> = { ...event.evidence };
  const targets: Record<string, string> = {};
  for (const [field, value] of Object.entries(event.evidence)) {
    if (field === "attempt") continue;
    const observed = context.find((candidate) => candidate.seq === value)?.event_id;
    const recorded = event.references?.[field as LedgerReferenceField];
    targets[field] = recorded !== undefined && observed !== undefined && recorded !== observed ? `CONFLICT:${recorded}:${observed}` : recorded ?? observed ?? `UNRESOLVED:${value}`;
    evidence[field] = targets[field]!;
  }
  return canonicalHistoryJson({ ...payload, evidence, references: targets });
}

/** Identity-only classification, before lifecycle/filesystem admission. Existing
 * sequences are never reassigned; import planning allocates additions later.
 */
export function classifyEventIdentities(existing: readonly LedgerEvent[], incoming: readonly LedgerEvent[]): {
  additions: LedgerEvent[]; duplicates: string[]; conflicts: { eventId?: string; reason: string }[];
} {
  const additions: LedgerEvent[] = [];
  const duplicates: string[] = [];
  const conflicts: { eventId?: string; reason: string }[] = [];
  const seen = new Map<string, { event: LedgerEvent; context: readonly LedgerEvent[] }>();
  for (const event of existing) {
    if (!isValidLedgerEvent(event) || event.schema_version !== 2) { conflicts.push({ reason: `local seq ${event.seq} lacks valid versioned identity metadata` }); continue; }
    if (event.event === "ledger_schema") continue;
    if (event.event_id === undefined) { conflicts.push({ reason: `local seq ${event.seq} has unresolved legacy identity` }); continue; }
    const references = remapLedgerReferences(event, existing, existing);
    if (!references.ok) conflicts.push({ eventId: event.event_id, reason: references.reasons.join("; ") });
    if (seen.has(event.event_id)) conflicts.push({ eventId: event.event_id, reason: "ambiguous local identity occurs more than once" });
    seen.set(event.event_id, { event, context: existing });
  }
  for (const event of incoming) {
    if (!isValidLedgerEvent(event) || event.schema_version !== 2) { conflicts.push({ reason: `incoming seq ${event.seq} lacks valid versioned identity metadata` }); continue; }
    if (event.event === "ledger_schema") continue;
    const eventId = event.event_id;
    if (eventId === undefined) { conflicts.push({ reason: `incoming seq ${event.seq} has unresolved legacy identity` }); continue; }
    const references = remapLedgerReferences(event, incoming, incoming);
    if (!references.ok) { conflicts.push({ eventId, reason: references.reasons.join("; ") }); continue; }
    const known = seen.get(eventId);
    if (known === undefined) {
      additions.push(event);
      seen.set(eventId, { event, context: incoming });
    } else if (semanticEventContent(known.event, known.context) === semanticEventContent(event, incoming)) {
      duplicates.push(eventId);
    } else {
      conflicts.push({ eventId, reason: "same stable identity has contradictory semantic content" });
    }
  }
  return { additions, duplicates, conflicts };
}
