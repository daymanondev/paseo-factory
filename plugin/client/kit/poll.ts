/**
 * The surface's poll clock — PigMonitor's usePoll trimmed: adaptive cadence
 * (5s while anything runs or needs a human, 30s quiet), keeps the last good
 * view on errors, restarts when the reload key changes. No `document`
 * reference survives on Hermes (the typeof guard), `window` event methods are
 * guarded per method (React Native's window lacks them), no node built-ins.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createResponseOrder } from "./response-order.ts";

export const BUSY_MS = 5000;
export const QUIET_MS = 30000;
export const GRACE_MS = 3000;
/** Re-read the snapshot this soon while the provider listing is still loading (the picker shows a loading block until it lands). */
export const PROVIDERS_LOADING_MS = 1500;

export const pollEvery = (busy: boolean) => (busy ? BUSY_MS : QUIET_MS);

/** The `document` visibility page, when a DOM host provides one — undefined on Hermes. */
const page = typeof document === "undefined" ? undefined : (document as { visibilityState?: string; addEventListener?: (n: string, f: () => void) => void; removeEventListener?: (n: string, f: () => void) => void } | undefined);

function hidden(): boolean {
  return page?.visibilityState === "hidden";
}

export type Failed = { code: string; message: string };
export type Loaded<T> = { value: T | null; error: Failed | null; at: number | null };
export type PollState<T> = Loaded<T> & { refresh: () => void };
export type PollOptions = { cadenceKey?: unknown };

export function usePoll<T>(
  load: () => Promise<{ ok: true; value: T } | { ok: false; code: string; error: string }>,
  reloadKey: string,
  every: (value: T | null) => number,
  options?: PollOptions,
): PollState<T> {
  const [state, setState] = useState<Loaded<T>>({ value: null, error: null, at: null });
  const latest = useRef({ load, every });
  latest.current = { load, every };
  const refreshRef = useRef<() => void>(() => {});
  const rescheduleRef = useRef<() => void>(() => {});
  const cadenceInitializedRef = useRef(false);

  useEffect(() => {
    let live = true;
    const order = createResponseOrder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: T | null = null;
    let inFlight = false;
    const again = () => {
      if (!live) return;
      clearTimeout(timer);
      timer = setTimeout(tick, hidden() ? QUIET_MS : latest.current.every(last));
    };
    const tick = async () => {
      if (hidden()) return again();
      const request = order.begin();
      inFlight = true;
      clearTimeout(timer);
      try {
        const r = await latest.current.load();
        if (!live || !order.current(request)) return;
        inFlight = false;
        if (r.ok) last = r.value;
        if (live) setState((s) => (r.ok ? { value: r.value, error: null, at: Date.now() } : { ...s, error: { code: r.code, message: r.error } }));
      } catch (error) {
        if (!order.current(request)) return;
        inFlight = false;
        if (live) setState((s) => ({ ...s, error: { code: "failed", message: String(error) } }));
      }
      again();
    };
    const shown = () => {
      if (hidden() || !live) return;
      clearTimeout(timer);
      void tick();
    };
    // Non-resetting refresh: keeps the last good view and existing DOM listeners intact.
    refreshRef.current = () => {
      if (!live) return;
      clearTimeout(timer);
      void tick();
    };
    rescheduleRef.current = () => {
      if (!live || inFlight) return;
      again();
    };
    setState({ value: null, error: null, at: null });
    void tick();
    page?.addEventListener?.("visibilitychange", shown);
    // React Native's `window` exists but has no event methods (Paseo mobile) — guard the method, not the global.
    if (typeof window?.addEventListener === "function") window.addEventListener("focus", shown);
    return () => {
      live = false;
      order.invalidate();
      clearTimeout(timer);
      refreshRef.current = () => {};
      rescheduleRef.current = () => {};
      page?.removeEventListener?.("visibilitychange", shown);
      if (typeof window?.removeEventListener === "function") window.removeEventListener("focus", shown);
    };
  }, [reloadKey]);

  const cadenceKey = options?.cadenceKey;
  useEffect(() => {
    if (!cadenceInitializedRef.current) {
      cadenceInitializedRef.current = true;
      return;
    }
    rescheduleRef.current();
  }, [cadenceKey]);

  const refresh = useCallback(() => {
    refreshRef.current();
  }, []);

  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}

/** A ticking `now`, for freshness dots and swimlane geometry. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
