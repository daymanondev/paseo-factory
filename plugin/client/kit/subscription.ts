/**
 * Reusable client subscription primitives for `>= 0.16.0` Paseo hosts
 * (`useSubscription` in React surfaces, `client.subscribe` in imperative
 * starters like `directory.tsx`), degrading cleanly to `"unsupported"` on
 * `< 0.16.0` hosts without violating Rules of Hooks or thrashing reconnects.
 */
import type { PluginSubscriptionContract } from "@getpaseo/plugin";
import * as pluginClient from "@getpaseo/plugin/client";
import type { PluginClientContext, PluginSubscriptionHandle, PluginSubscriptionState } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import { supportsSubscriptionContract } from "../../shared/rpc.ts";

/** Matches `@getpaseo/plugin`'s wire input helper without relying on an unexported internal type. */
export type SubscriptionWireInput<Value> = Value extends Uint8Array ? Uint8Array : Value;

export type ClientSubscriptionStatus = "unsupported" | "connecting" | "live" | "closed" | "error";

export type ClientSubscriptionState =
  | { readonly status: "unsupported"; readonly error: null }
  | { readonly status: "connecting"; readonly error: null }
  | { readonly status: "live"; readonly error: null }
  | { readonly status: "closed"; readonly error: null }
  | { readonly status: "error"; readonly error: Error };

const UNSUPPORTED_STATE: ClientSubscriptionState = { status: "unsupported", error: null };
const CONNECTING_STATE: ClientSubscriptionState = { status: "connecting", error: null };
const LIVE_STATE: ClientSubscriptionState = { status: "live", error: null };
const CLOSED_STATE: ClientSubscriptionState = { status: "closed", error: null };

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const hostUseSubscription =
  supportsSubscriptionContract &&
  typeof (pluginClient as { useSubscription?: unknown }).useSubscription === "function"
    ? (pluginClient as { useSubscription: typeof pluginClient.useSubscription }).useSubscription
    : undefined;

/** True when both the contract runtime and `@getpaseo/plugin/client`'s `useSubscription` hook exist. */
export const supportsClientSubscriptionHook: boolean = hostUseSubscription !== undefined;

/** True when both the contract runtime and `client.subscribe` exist on an imperative client context. */
export function canClientSubscribe(
  client: { subscribe?: unknown } | null | undefined,
): client is { subscribe: PluginClientContext["subscribe"] } {
  return supportsSubscriptionContract && client !== null && client !== undefined && typeof client.subscribe === "function";
}

export function isSubscriptionLive(state: ClientSubscriptionState): boolean {
  return state.status === "live";
}

/**
 * React hook wrapper around `@getpaseo/plugin/client`'s `useSubscription`.
 * Because `hostUseSubscription` is resolved once at module load, the hook call
 * sequence is invariant across renders and safe on `< 0.16.0` hosts.
 */
export function useClientSubscription<InputSchema extends ZodType, EventSchema extends ZodType>(
  contract: PluginSubscriptionContract<InputSchema, EventSchema>,
  input: SubscriptionWireInput<ZodInput<InputSchema>>,
  onEvent: (event: ZodOutput<EventSchema>) => void,
): ClientSubscriptionState {
  if (hostUseSubscription === undefined) return UNSUPPORTED_STATE;
  const sdkState: PluginSubscriptionState | undefined = hostUseSubscription(contract, input, onEvent);
  const status = sdkState?.status;
  const error = status === "error" ? sdkState.error : undefined;
  return useMemo<ClientSubscriptionState>(() => {
    if (status === "live") return LIVE_STATE;
    if (status === "connecting") return CONNECTING_STATE;
    if (status === "closed") return CLOSED_STATE;
    if (status === "error") return { status: "error", error: toError(error) };
    return UNSUPPORTED_STATE;
  }, [status, error]);
}

export interface ClientSubscriptionOptions<InputSchema extends ZodType, EventSchema extends ZodType> {
  client: { subscribe?: PluginClientContext["subscribe"] } | null | undefined;
  contract: PluginSubscriptionContract<InputSchema, EventSchema>;
  input: SubscriptionWireInput<ZodInput<InputSchema>>;
  onEvent: (event: ZodOutput<EventSchema>) => void;
  onReady?: () => void;
  onStateChange?: (state: ClientSubscriptionState) => void;
}

export type ClientSubscriptionStop = (() => void) & {
  state(): ClientSubscriptionState;
};

/**
 * Imperative subscription helper for non-hook client contributions (such as
 * `startSeatDirectory`). Guards missing `supportsSubscriptionContract` and
 * `client.subscribe`, reports state changes without auto-retrying on error, and
 * returns a callable disposer whose `.state()` reads the latest state.
 */
export function subscribeClientUpdates<InputSchema extends ZodType, EventSchema extends ZodType>(
  options: ClientSubscriptionOptions<InputSchema, EventSchema>,
): ClientSubscriptionStop {
  if (!canClientSubscribe(options.client)) {
    options.onStateChange?.(UNSUPPORTED_STATE);
    return Object.assign(() => {}, { state: () => UNSUPPORTED_STATE });
  }

  let active = true;
  let current: ClientSubscriptionState = CONNECTING_STATE;
  let handle: PluginSubscriptionHandle | undefined;

  const setState = (next: ClientSubscriptionState): void => {
    if (!active) return;
    if (current.status === next.status && current.error === next.error) return;
    current = next;
    options.onStateChange?.(next);
  };

  options.onStateChange?.(CONNECTING_STATE);

  try {
    handle = options.client.subscribe(
      options.contract,
      options.input,
      (event) => {
        if (!active) return;
        options.onEvent(event);
      },
      {
        onClosed: ({ error }) => {
          if (!active) return;
          setState(error ? { status: "error", error: toError(error) } : CLOSED_STATE);
        },
      },
    );
  } catch (error) {
    setState({ status: "error", error: toError(error) });
    return Object.assign(
      () => {
        active = false;
      },
      { state: () => current },
    );
  }

  const readyPromise =
    handle !== undefined &&
    handle !== null &&
    typeof (handle as { ready?: unknown }).ready === "object" &&
    (handle as { ready?: Promise<void> | null }).ready !== null &&
    typeof (handle as { ready?: Promise<void> }).ready?.then === "function"
      ? (handle as { ready: Promise<void> }).ready
      : Promise.resolve();

  void readyPromise.then(
    () => {
      if (!active || current.status !== "connecting") return;
      setState(LIVE_STATE);
      options.onReady?.();
    },
    (error) => {
      if (!active) return;
      setState({ status: "error", error: toError(error) });
    },
  );

  const stop = (): void => {
    if (!active) return;
    active = false;
    try {
      if (typeof handle === "function") {
        handle();
      } else if (handle !== undefined && handle !== null && typeof (handle as { release?: unknown }).release === "function") {
        void Promise.resolve((handle as { release: () => unknown }).release()).catch(() => {});
      }
    } catch {
      // best-effort subscription teardown
    }
  };

  return Object.assign(stop, { state: () => current });
}
