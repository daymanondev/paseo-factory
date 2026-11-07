/**
 * The console's native Agent transcript read (T-04) — `factory.agent.transcript`
 * through the sidecar's RPC door. The reply IS the shared output union
 * (`plugin/shared/rpc.ts`), consumed verbatim per the envelope law: the ok
 * arm carries either the reduced tail or the honest unavailable reason, a
 * refusal carries its code and sentence, and every arm is data the Task
 * Detail disclosure renders — never a throw. Read-only; the browser holds
 * no credential and no write exists.
 */
import type { AgentTranscriptEntry } from "../../plugin/shared/rpc.ts";
import { invokeRpc, type FetchLike } from "./rpc.ts";

export type AgentTranscriptReply =
  | { ok: true; agent: string; entries: AgentTranscriptEntry[] }
  | { ok: true; agent: string; unavailable: true; reason: string }
  | { ok: false; code: string; error: string };

export function agentTranscriptViaSidecar(
  input: { agent: string },
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<AgentTranscriptReply> {
  return invokeRpc<{ agent: string; entries: AgentTranscriptEntry[] } | { agent: string; unavailable: true; reason: string }>(
    "factory.agent.transcript",
    input,
    fetchImpl,
  );
}
