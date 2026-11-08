/**
 * The console's Integrations transports (ADR 0051, T-09b) — the screen's
 * Owner plugin acts through the sidecar's RPC door: the on-demand
 * `factory.plugins.check.updates` probe, a canonical-source companion
 * install (`factory.plugins.install` — the console never carries a
 * source/ref or ledger/config override; the door refuses them), and the
 * narrowed manage acts (`factory.plugins.manage` enable/disable/update —
 * remove and reload stay developer acts). Each reply IS the shared output
 * union (`plugin/shared/rpc.ts`), consumed verbatim per the envelope law: a
 * refusal is data the screen renders, never a throw, and each success arm
 * carries the handler's own `summary` (or the check's `checkedAt` /
 * `updatesAvailable`) verbatim.
 *
 * Authority: the same law as Accept — the sidecar hands the in-process
 * handler the Owner's local call and no credential ever crosses to the
 * browser. Nothing here invents one.
 */
import { invokeRpc, type FetchLike } from "./rpc.ts";

/** The check's input — the shared schema's own empty object. */
export type PluginsCheckUpdatesInput = Record<string, never>;

/** The companion install's input — a target id only, the canonical source by omission. */
export interface PluginsInstallInput {
  target: string;
}

/** The narrowed manage acts' input — enable, disable, or update, never remove/reload. */
export interface PluginsManageInput {
  pluginId: string;
  action: "enable" | "disable" | "update";
}

/** The check's success arm — the stamp's `checkedAt` and the roster's update ids. */
export type PluginsCheckUpdatesReply =
  | ({ ok: true } & { checkedAt: string; updatesAvailable: string[]; summary: string })
  | { ok: false; code: string; error: string };

/** The install's success arm — what landed, in the handler's own sentence. */
export type PluginsInstallReply = ({ ok: true } & { installed: string[]; summary: string }) | { ok: false; code: string; error: string };

/** The manage act's success arm — the handler's own echo and sentence. */
export type PluginsManageReply = ({ ok: true } & { pluginId: string; action: string; summary: string }) | { ok: false; code: string; error: string };

export function pluginsCheckUpdatesViaSidecar(
  input: PluginsCheckUpdatesInput = {},
  fetchImpl: FetchLike = (request, init) => fetch(request, init),
): Promise<PluginsCheckUpdatesReply> {
  return invokeRpc<{ checkedAt: string; updatesAvailable: string[]; summary: string }>("factory.plugins.check.updates", input, fetchImpl);
}

export function pluginsInstallViaSidecar(input: PluginsInstallInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<PluginsInstallReply> {
  return invokeRpc<{ installed: string[]; summary: string }>("factory.plugins.install", input, fetchImpl);
}

export function pluginsManageViaSidecar(input: PluginsManageInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<PluginsManageReply> {
  return invokeRpc<{ pluginId: string; action: string; summary: string }>("factory.plugins.manage", input, fetchImpl);
}
