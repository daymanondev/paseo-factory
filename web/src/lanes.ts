/**
 * The console's Agents & Models transports (ADR 0051, T-08b + T-08c) — the
 * screen's Owner acts through the sidecar's RPC door: the three lane writes
 * of T-08b (`factory.lanes.set` — one lane's `provider/model[:thinking]`,
 * the per-Project `factory.lanes.reset`, `factory.profiles.apply` —
 * Copy-on-Apply) and the four lifecycle acts of T-08c
 * (`factory.profiles.save`/`delete` — the profile CRUD, and
 * `factory.lead.rotate`/`factory.supervisor.revoke` — the two seat-retire
 * acts). Each reply IS the shared output union (`plugin/shared/rpc.ts`),
 * consumed verbatim per the envelope law: a refusal is data the screen
 * renders, never a throw, and each success arm carries the handler's own
 * sentence (`modelSync`, `summary`) or retired `agentId` verbatim.
 *
 * Authority: the same law as Accept — the sidecar hands the in-process
 * handler the Owner's local call and no credential ever crosses to the
 * browser. Nothing here invents one.
 */
import { invokeRpc, type FetchLike } from "./rpc.ts";
import type { Lanes, LaneProfileView } from "../../plugin/shared/view.ts";

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

// ---- the lifecycle writes (T-08c) -------------------------------------------------------------------

/** The profile save's input — `lanes` omitted: the handler snapshots the scope's CURRENT effective table. */
export interface ProfilesSaveInput {
  name: string;
  description?: string;
  /** The scope whose current lane table becomes the profile. */
  projectRoot: string;
}

/** The profile delete's input — the tombstoned id. */
export interface ProfilesDeleteInput {
  profileId: string;
}

/** The seat-retire acts' shared input — rotate and revoke are always scoped to the selected Project. */
export interface SeatRetireInput {
  projectRoot: string;
}

/** The profile save's success arm — the saved row and the handler's own summary sentence. */
export type ProfilesSaveReply = ({ ok: true } & { profile: LaneProfileView; summary: string }) | { ok: false; code: string; error: string };

/** The profile delete's success arm — `deleted` is false when no such profile existed (nothing deleted). */
export type ProfilesDeleteReply = ({ ok: true } & { deleted: boolean; summary: string }) | { ok: false; code: string; error: string };

/** The seat-retire acts' success arm — the archived live seat's agent id. */
export type SeatRetireReply = ({ ok: true } & { agentId: string }) | { ok: false; code: string; error: string };

export function profilesSaveViaSidecar(input: ProfilesSaveInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<ProfilesSaveReply> {
  return invokeRpc<{ profile: LaneProfileView; summary: string }>("factory.profiles.save", input, fetchImpl);
}

export function profilesDeleteViaSidecar(input: ProfilesDeleteInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<ProfilesDeleteReply> {
  return invokeRpc<{ deleted: boolean; summary: string }>("factory.profiles.delete", input, fetchImpl);
}

export function leadRotateViaSidecar(input: SeatRetireInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<SeatRetireReply> {
  return invokeRpc<{ agentId: string }>("factory.lead.rotate", input, fetchImpl);
}

export function supervisorRevokeViaSidecar(input: SeatRetireInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<SeatRetireReply> {
  return invokeRpc<{ agentId: string }>("factory.supervisor.revoke", input, fetchImpl);
}
