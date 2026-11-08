/**
 * The console's Settings vault transports (ADR 0051, T-10b) — the screen's
 * three Owner vault acts through the sidecar's RPC door: the stepped setup's
 * `factory.vault.configure` (repo/branch and the passphrase tri-state —
 * absent preserves, an empty string clears, text sets; the dialog's "Leave
 * unchanged" simply omits the field), the two-way sync's hydrating leg
 * `factory.vault.pull` (`mergeLedgers` optional), and its publishing leg
 * `factory.vault.push` (`includeLedgers` optional). Each reply IS the shared
 * output union (`plugin/shared/rpc.ts`), consumed verbatim per the envelope
 * law: a refusal is data the screen renders, never a throw, and each success
 * arm carries the handler's own `summary` verbatim. The passphrase rides the
 * request body once and is never echoed back — the success arm's `vault`
 * carries the passphrase as a boolean only (`hasPassphrase`).
 *
 * The sibling vault methods (`factory.vault.hydrate`, `.sync`, `.import`)
 * have NO transport here — they stay outside the door (T-10c) and refuse
 * `unknown_method` as data.
 */
import { invokeRpc, type FetchLike, type RpcFailure } from "./rpc.ts";
import type { VaultStatusView } from "../../plugin/shared/view.ts";

/** The configure input — the passphrase tri-state: absent preserves, "" clears, text sets. */
export interface VaultConfigureInput {
  repo: string;
  branch: string;
  passphrase?: string;
}

/** The pull input — `mergeLedgers` omitted (the confirm's checkbox default) stays false. */
export interface VaultPullInput {
  mergeLedgers?: boolean;
}

/** The push input — `includeLedgers` omitted (the confirm's checkbox default) stays false. */
export interface VaultPushInput {
  includeLedgers?: boolean;
}

/** Any vault write's success arm — the refreshed `VaultStatusView` (passphrase a boolean) plus the handler's own sentence. */
type VaultWriteSuccess = { vault: VaultStatusView; summary: string };

export type VaultConfigureReply = ({ ok: true } & VaultWriteSuccess) | RpcFailure;
export type VaultPullReply = ({ ok: true } & VaultWriteSuccess & { hydratedFiles: string[] }) | RpcFailure;
export type VaultPushReply = ({ ok: true } & VaultWriteSuccess & { pushedFiles: string[] }) | RpcFailure;

export function vaultConfigureViaSidecar(input: VaultConfigureInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<VaultConfigureReply> {
  return invokeRpc<VaultWriteSuccess>("factory.vault.configure", input, fetchImpl);
}

export function vaultPullViaSidecar(input: VaultPullInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<VaultPullReply> {
  return invokeRpc<VaultWriteSuccess & { hydratedFiles: string[] }>("factory.vault.pull", input, fetchImpl);
}

export function vaultPushViaSidecar(input: VaultPushInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<VaultPushReply> {
  return invokeRpc<VaultWriteSuccess & { pushedFiles: string[] }>("factory.vault.push", input, fetchImpl);
}
