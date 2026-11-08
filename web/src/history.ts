/**
 * The console's Settings history-imports read (ADR 0051, T-14a) — the
 * screen's read-only "History imports" section through the sidecar's RPC
 * door: `factory.history.imports`, a PLAIN entry on its existing shared
 * schema (`plugin/shared/rpc.ts`, input `{}`), answering every
 * `ImportStatus` row the live writer holds across the root Factory and its
 * registered Projects. The reply IS the shared output union, consumed
 * verbatim per the envelope law: a refusal is data the section renders,
 * never a throw. This module carries NO write — `factory.history.import`
 * and `factory.history.upgrade` stay outside the door (a later wave,
 * pending Owner review), so there is nothing here but the one read.
 */
import { invokeRpc, type FetchLike, type RpcFailure } from "./rpc.ts";

/**
 * One import status row — the shared `ImportStatusSchema`
 * (`plugin/shared/view.ts`) own shape: the manifest's identity and target
 * ledger, the admission state (`staged`, `pending`, `applied`,
 * `conflicted`), the added/duplicates counts, the conflict reasons, the
 * writer's diagnostics, and the vault materialization hold when one rides.
 */
export interface HistoryImportStatus {
  materialization?: { status: "pending" | "applied" | "refused"; diagnostics: string[] };
  id: string;
  target: string;
  status: "staged" | "pending" | "applied" | "conflicted";
  added?: number;
  duplicates?: number;
  conflicts?: { reason: string; sourceId?: string; eventId?: string }[];
  diagnostics: string[];
}

/** The read's success arm — the handler's own `imports` list, verbatim. */
export type HistoryImportsReply = ({ ok: true; imports: HistoryImportStatus[] } | RpcFailure);

/**
 * The section's one transport — `factory.history.imports` over the sidecar's
 * RPC door. A read, so the section's Refresh button needs no confirm; the
 * vault import's own success reply carries the same list and the section
 * folds that reply's copy rather than re-asking the door.
 */
export function historyImportsViaSidecar(
  input: Record<never, never>,
  fetchImpl: FetchLike = (request, init) => fetch(request, init),
): Promise<HistoryImportsReply> {
  return invokeRpc<{ imports: HistoryImportStatus[] }>("factory.history.imports", input, fetchImpl);
}
