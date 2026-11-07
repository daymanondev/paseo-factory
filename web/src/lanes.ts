/**
 * The console's lane-write transports (ADR 0051, T-08b) — the Agents &
 * Models screen's three Owner acts through the sidecar's RPC door:
 * `factory.lanes.set` (one lane's `provider/model[:thinking]`), the
 * per-Project `factory.lanes.reset`, and `factory.profiles.apply`
 * (Copy-on-Apply). Each reply IS the shared output union
 * (`plugin/shared/rpc.ts`), consumed verbatim per the envelope law: a
 * refusal is data the screen renders, never a throw, and the success arm
 * carries the live-seat sync's own sentence (`modelSync`) verbatim.
 *
 * Authority: the same law as Accept — the sidecar hands the in-process
 * handler the Owner's local call and no credential ever crosses to the
 * browser. Nothing here invents one.
 */
import { invokeRpc, type FetchLike } from "./rpc.ts";
import type { Lanes } from "../../plugin/shared/view.ts";

/** The one-lane save's input — the shared schema's own shape. */
export interface LanesSetInput {
  lane: string;
  value: string;
  projectRoot: string;
}

/** The per-Project override reset's input. */
export interface LanesResetInput {
  projectRoot: string;
}

/** The Copy-on-Apply act's input. */
export interface ProfilesApplyInput {
  profileId: string;
  projectRoot: string;
}

/** The success arm every one of the three writes shares — the table plus the live-seat sync's own sentence. */
export interface LanesWriteOk {
  lanes: Lanes;
  modelSync: string;
}

export type LanesSetReply = ({ ok: true } & LanesWriteOk) | { ok: false; code: string; error: string };
export type LanesResetReply = ({ ok: true } & LanesWriteOk & { removed: boolean }) | { ok: false; code: string; error: string };
export type ProfilesApplyReply = LanesSetReply;

export function lanesSetViaSidecar(input: LanesSetInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<LanesSetReply> {
  return invokeRpc<LanesWriteOk>("factory.lanes.set", input, fetchImpl);
}

export function lanesResetViaSidecar(input: LanesResetInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<LanesResetReply> {
  return invokeRpc<LanesWriteOk & { removed: boolean }>("factory.lanes.reset", input, fetchImpl);
}

export function profilesApplyViaSidecar(input: ProfilesApplyInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<ProfilesApplyReply> {
  return invokeRpc<LanesWriteOk>("factory.profiles.apply", input, fetchImpl);
}
