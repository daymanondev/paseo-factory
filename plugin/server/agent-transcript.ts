/**
 * The console transcript read's pure half (ADR 0051 §5, T-04) — two
 * reductions over data the caller gathers, so the RPC handler stays thin and
 * the laws stay testable:
 *
 * 1. `reduceTimelineEntry` — one projected daemon timeline entry to plain
 *    data. The summary line IS the Watch pass's own compact transcript
 *    (`renderTimelineTranscript`, `src/watch.ts`) — one renderer, one
 *    vocabulary — with the role/kind/text/tool extraction the Task Detail
 *    disclosure renders natively.
 * 2. `factoryKnownAgents` — the scope check: the agent ids the Factory's own
 *    records attribute to a Task's Attempt or to a Project seat. The ledger
 *    stamps (`claim_reported.agent`, `meter_written.agent`, the permit and
 *    git-block lines, `respawn_dispatched.died_agent`), the seat bindings in
 *    each Project's `project.json`, and the correlation registry's
 *    session→agent associations (the same source `enrichTaskPeerAgents`
 *    reads, so a running Attempt's Peer — no ledger stamp yet — answers too).
 * A stranger id is not here, and the handler refuses it as data.
 */
import { renderTimelineTranscript } from "./core/watch.ts";
import type { AgentTranscriptEntry } from "../shared/rpc.ts";

/** Newlines become literal `\n` — the summary stays one line, always (the watch's own law). */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Reduces one raw projected entry (`{ seqEnd, item }`) to the wire shape. An
 * entry without an `item` object is not transcript data — null, and the
 * caller drops it.
 */
export function reduceTimelineEntry(raw: unknown): AgentTranscriptEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as { seqEnd?: unknown; item?: unknown };
  if (typeof entry.item !== "object" || entry.item === null) return null;
  const item = entry.item as Record<string, unknown>;
  const seq = typeof entry.seqEnd === "number" && Number.isFinite(entry.seqEnd) ? Math.trunc(entry.seqEnd) : 0;
  const kind = str(item.type) ?? "unknown";
  // The compact line the Watch pass reads — `[seq] type: payload`; the prefix
  // is dropped because `seq` and `kind` already ride the entry as fields.
  const line = renderTimelineTranscript([{ seq, item }]).slice(`[${seq}] `.length);
  switch (kind) {
    case "user_message":
      return { seq, role: "user", kind, text: textOf(item.text), tool: null, summary: null };
    case "assistant_message":
      return { seq, role: "assistant", kind, text: textOf(item.text), tool: null, summary: null };
    case "tool_call": {
      const detail = typeof item.detail === "object" && item.detail !== null ? (item.detail as Record<string, unknown>) : {};
      const tool = str(detail.type) ?? str(item.name) ?? "tool";
      return { seq, role: "tool", kind, text: null, tool, summary: line };
    }
    default:
      return { seq, role: "system", kind, text: str(item.text) ?? str(item.message) ?? null, tool: null, summary: line };
  }
}

/**
 * The Factory-known agent ids — the transcript door's whole scope. Every
 * input is plain data the handler gathers (ledger events, seat bindings,
 * correlation records), so the law is one pure fold: a string `agent` or
 * `died_agent` field on any ledger event, a seat id in `seats`, or an
 * `agentId` on a correlation record counts; nothing else does.
 */
export function factoryKnownAgents(input: {
  events: readonly unknown[];
  seats: readonly (string | undefined)[];
  correlations: readonly { agentId?: string }[];
}): Set<string> {
  const known = new Set<string>();
  const admit = (id: unknown): void => {
    if (typeof id === "string" && id.trim() !== "") known.add(id);
  };
  for (const evt of input.events) {
    if (typeof evt !== "object" || evt === null) continue;
    admit((evt as { agent?: unknown }).agent);
    admit((evt as { died_agent?: unknown }).died_agent);
  }
  for (const seat of input.seats) admit(seat);
  for (const correlation of input.correlations) admit(correlation.agentId);
  return known;
}
