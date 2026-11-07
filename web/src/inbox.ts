/**
 * The console's cross-Project inbox gather — `factory.inbox` through the
 * sidecar's RPC door (ADR 0051, T-05). The reply IS the shared output union
 * (`plugin/shared/rpc.ts` — `{ ok: true, projects, refusals } | Failure`),
 * consumed verbatim per the envelope law: a per-Project refusal is data the
 * fold renders, never a throw. This door fills only the Scrum half the
 * snapshot cannot (its `execution` is the global scope's); every Project's
 * Tasks — needs-human, red, ready-to-accept — already ride the snapshot.
 *
 * T-06: each row additively carries the run's journal `revision` (the
 * `expectedRevision` an Owner command submits), its count-based `allowance`
 * state, and its `blockers` verbatim — a run blocked on budget (causes
 * `tasks` / `qaFixRounds`, ADR 0038) lists even with no Owner request.
 */
import type { OwnerRequestView } from "../../plugin/shared/view.ts";
import { invokeRpc, type FetchLike } from "./rpc.ts";

/** One Project's Owner requests as the shared contract spells the row. */
export interface InboxProjectRequests {
  projectSlug: string;
  runId: string;
  phase: string;
  requests: OwnerRequestView[];
  /** T-06 (additive): the run journal's revision — the command's `expectedRevision`. */
  revision?: number;
  /** T-06 (additive): the run's count-based allowance state — the Grant item's used/allowed data. */
  allowance?: { tasksUsed: number; tasksAllowed: number; qaFixRoundsUsed: number; qaFixRoundsAllowed: number };
  /** T-06 (additive): the run's blocker details verbatim — the fold filters the grant-remediable causes. */
  blockers?: readonly { id: string; reason: string; causes: readonly string[] }[];
}

export type InboxReply =
  | { ok: true; projects: InboxProjectRequests[]; refusals: { projectSlug: string; error: string }[] }
  | { ok: false; code: string; error: string };

/** The gather the shell keys to the snapshot — an Accept's or an Owner act's refresh re-reads it. */
export function inboxViaSidecar(fetchImpl: FetchLike = (input, init) => fetch(input, init)): Promise<InboxReply> {
  return invokeRpc<{ projects: InboxProjectRequests[]; refusals: { projectSlug: string; error: string }[] }>("factory.inbox", {}, fetchImpl);
}

