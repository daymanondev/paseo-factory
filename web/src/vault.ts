/**
 * The console's Settings vault transports (ADR 0051, T-10b + T-10c + T-10d) —
 * the screen's six Owner vault acts through the sidecar's RPC door: the
 * stepped setup's `factory.vault.configure` (repo/branch and the passphrase
 * tri-state — absent preserves, an empty string clears, text sets; the
 * dialog's "Leave unchanged" simply omits the field), the two-way sync's
 * hydrating leg `factory.vault.pull` (`mergeLedgers` optional), its
 * publishing leg `factory.vault.push` (`includeLedgers` optional), the two
 * round-trip writes of T-10c: `factory.vault.sync` (the unified
 * bidirectional sync — the console carries ONLY its three checkboxes, never
 * repo/branch/passphrase, which configure owns) and `factory.vault.hydrate`
 * (the zero-clone direct hydrate — the console carries ONLY its two
 * checkboxes, never the repo/ref overrides), and T-10d's key import
 * `factory.vault.import` (the dialog's filled fields only — every empty
 * field is absent from the wire — with the paths as host file paths the
 * daemon reads itself; the browser never reads or uploads file contents).
 * Each reply IS the shared output union (`plugin/shared/rpc.ts`), consumed
 * verbatim per the envelope law: a refusal is data the screen renders,
 * never a throw, and each success arm carries the handler's own `summary`
 * verbatim (sync's also folding `createdRepo`/`pushed`, import's
 * `importedFiles`). The passphrase and the keystore password ride the
 * request body once and are never echoed back — the success arm's `vault`
 * carries the passphrase as a boolean only (`hasPassphrase`).
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

/**
 * The sync input — exactly the confirm's three checkboxes; `repo`, `branch`,
 * and `passphrase` never exist here (the door refuses them — configure owns
 * all three). The confirm spells EVERY checkbox explicitly (true or false):
 * the core's own sync defaults turn an omitted mergeLedgers/includeLedger
 * ON, so the checkbox's promise is the wire's truth.
 */
export interface VaultSyncInput {
  mergeLedgers?: boolean;
  includeLedger?: boolean;
  overwriteConfigs?: boolean;
}

/**
 * The hydrate input — exactly the confirm's two checkboxes, spelled
 * explicitly; the `repo` and `ref` overrides never exist here (the door
 * refuses them — the direct hydrate reads the configured repo and branch).
 */
export interface VaultHydrateInput {
  mergeLedgers?: boolean;
  overwriteConfigs?: boolean;
}

/**
 * The key-import input (T-10d) — the shared schema's own all-optional
 * fields: every field the dialog leaves empty is OMITTED (absent from the
 * wire, never an empty string), and the paths are host file paths the daemon
 * reads itself. `syncAfterImport` rides EXPLICITLY (true or false): the
 * core's own default turns an omitted flag ON, so the confirm checkbox's
 * promise is the wire's truth — off by default, exactly the dialog's law.
 */
export interface VaultImportInput {
  ascKeyPath?: string;
  ascKeyId?: string;
  ascIssuer?: string;
  gplayKeyPath?: string;
  eyeConfigPath?: string;
  appKey?: string;
  keystorePath?: string;
  storePass?: string;
  keyAlias?: string;
  firebaseProjectId?: string;
  googleServicesJsonPath?: string;
  googleServiceInfoPlistPath?: string;
  syncAfterImport?: boolean;
}

/** Any vault write's success arm — the refreshed `VaultStatusView` (passphrase a boolean) plus the handler's own sentence. */
type VaultWriteSuccess = { vault: VaultStatusView; summary: string };

export type VaultConfigureReply = ({ ok: true } & VaultWriteSuccess) | RpcFailure;
export type VaultPullReply = ({ ok: true } & VaultWriteSuccess & { hydratedFiles: string[] }) | RpcFailure;
export type VaultPushReply = ({ ok: true } & VaultWriteSuccess & { pushedFiles: string[] }) | RpcFailure;
export type VaultSyncReply = ({ ok: true } & VaultWriteSuccess & { createdRepo: boolean; hydratedFiles: string[]; pushedFiles: string[]; pushed: boolean }) | RpcFailure;
export type VaultHydrateReply = ({ ok: true } & VaultWriteSuccess & { hydratedFiles: string[] }) | RpcFailure;
export type VaultImportReply = ({ ok: true } & VaultWriteSuccess & { importedFiles: string[]; pushed: boolean }) | RpcFailure;

export function vaultConfigureViaSidecar(input: VaultConfigureInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<VaultConfigureReply> {
  return invokeRpc<VaultWriteSuccess>("factory.vault.configure", input, fetchImpl);
}

export function vaultPullViaSidecar(input: VaultPullInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<VaultPullReply> {
  return invokeRpc<VaultWriteSuccess & { hydratedFiles: string[] }>("factory.vault.pull", input, fetchImpl);
}

export function vaultPushViaSidecar(input: VaultPushInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<VaultPushReply> {
  return invokeRpc<VaultWriteSuccess & { pushedFiles: string[] }>("factory.vault.push", input, fetchImpl);
}

export function vaultSyncViaSidecar(input: VaultSyncInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<VaultSyncReply> {
  return invokeRpc<VaultWriteSuccess & { createdRepo: boolean; hydratedFiles: string[]; pushedFiles: string[]; pushed: boolean }>("factory.vault.sync", input, fetchImpl);
}

export function vaultHydrateViaSidecar(input: VaultHydrateInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<VaultHydrateReply> {
  return invokeRpc<VaultWriteSuccess & { hydratedFiles: string[] }>("factory.vault.hydrate", input, fetchImpl);
}

export function vaultImportViaSidecar(input: VaultImportInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<VaultImportReply> {
  return invokeRpc<VaultWriteSuccess & { importedFiles: string[]; pushed: boolean }>("factory.vault.import", input, fetchImpl);
}
