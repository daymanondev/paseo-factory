/**
 * The console's Scrum Owner transport (ADR 0051, T-06) — `factory.scrum.command`
 * through the sidecar's RPC door, narrowed by the sidecar itself to exactly the
 * five Owner acts the Inbox resolves: `wait.answer`, `wait.cancel`,
 * `design.decide`, `allowance.tasks`, `allowance.qa`. The reply IS the shared
 * output union (`plugin/shared/rpc.ts` — `{ ok: true, data } | Failure`),
 * consumed verbatim per the envelope law: a refusal (revision conflict,
 * owner-action-required, a forbidden operation the sidecar rejected before any
 * handler ran) is data the screen renders, never a throw.
 *
 * Authority: the console carries Owner authority the same way Accept does —
 * the sidecar hands the in-process handler the Owner's local call and no
 * credential ever crosses to the browser. Nothing here invents one.
 */
import { invokeRpc, type FetchLike } from "./rpc.ts";

/** The five operations the sidecar's narrowed entry serves — the type refuses to spell a sixth. */
export type ConsoleScrumOperation = "wait.answer" | "wait.cancel" | "design.decide" | "allowance.tasks" | "allowance.qa";

export interface ScrumCommandInput {
  /** The run's Project scope — the same root the item's fold attributed. */
  projectRoot: string;
  operation: ConsoleScrumOperation;
  /** The run the command resolves — its durable identity, carried from the inbox row. */
  runId: string;
  /** A fresh request identity per act — the journal's replay key (a repeated request cannot apply twice). */
  requestId: string;
  /** The run's journal revision as the inbox read carried it — a stale revision refuses as data. */
  expectedRevision: number;
  payload?: Record<string, unknown>;
}

export type ScrumCommandReply = { ok: true; data: unknown } | { ok: false; code: string; error: string };

/**
 * The RN client's own mint (`plugin/client/factory/owner-work.tsx`
 * `useOwnerCommand`): `owner-<clock>-<random>` — unique per act, filename-safe,
 * and honest about who asked. One mint per submit; the button disables while
 * pending, so a second click is always a NEW act against re-read data.
 */
export function freshOwnerRequestId(): string {
  return `owner-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function scrumCommandViaSidecar(
  input: ScrumCommandInput,
  fetchImpl: FetchLike = (request, init) => fetch(request, init),
): Promise<ScrumCommandReply> {
  return invokeRpc<{ data: unknown }>("factory.scrum.command", input, fetchImpl);
}
