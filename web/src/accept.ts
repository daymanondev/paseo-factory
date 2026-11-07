/**
 * The console's first write journey — `factory.accept` through the sidecar's
 * RPC door (ADR 0051 §1, T-02). The reply IS the shared output union
 * (`plugin/shared/rpc.ts` — `{ ok: true, seq, summary } | Failure`),
 * consumed verbatim per the envelope law: a refusal is data the screen
 * shows, never a throw.
 */
import { invokeRpc, type FetchLike } from "./rpc.ts";

export type AcceptReply = { ok: true; seq: number; summary: string } | { ok: false; code: string; error: string };

export function acceptViaSidecar(
  input: { task: string; attempt: number },
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<AcceptReply> {
  return invokeRpc<{ seq: number; summary: string }>("factory.accept", input, fetchImpl);
}
