/**
 * The console's Activity retro transport (ADR 0051, T-11b) — the screen's one
 * Owner act through the sidecar's NARROWED RPC door: `factory.retro` with
 * exactly the scoped Project's root (the door refuses an unscoped call before
 * any handler runs). The reply IS the shared output union
 * (`plugin/shared/rpc.ts`), consumed verbatim per the envelope law: a
 * refusal is data the screen renders, never a throw — and the success arm
 * itself stays honest about the pass (`outcome` may read `failed` with a
 * non-null `error`; `proposalCount` may read null when the pass died before
 * counting), the same facts the RN client's retro note renders.
 *
 * Authority: the same law as Accept — the sidecar hands the in-process
 * handler the Owner's local call and no credential ever crosses to the
 * browser. The sibling `factory.retro.ratify` has NO transport here: its
 * handler ensures a Supervisor seat (ADR 0017) and the console renders no
 * Ratify control.
 */
import { invokeRpc, type FetchLike } from "./rpc.ts";

/** The run's input — the scoped Project's root, always. */
export interface RetroRunInput {
  projectRoot: string;
}

/** The run's success arm — the handler's own outcome, counts, and honest error. */
export type RetroRunReply =
  | ({ ok: true } & { outcome: string; proposalCount: number | null; proposalsPath: string | null; error: string | null })
  | { ok: false; code: string; error: string };

export function retroViaSidecar(input: RetroRunInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<RetroRunReply> {
  return invokeRpc<{ outcome: string; proposalCount: number | null; proposalsPath: string | null; error: string | null }>("factory.retro", input, fetchImpl);
}
