/**
 * The console's snapshot clock — the RN client's adaptive poll
 * (`plugin/client/kit/poll.ts`) ported to the web: 5 s while anything runs
 * or needs the Owner, 30 s quiet, visibility-aware (a hidden tab holds at
 * the quiet cadence and refreshes on return), and the last good view stays
 * on errors (ADR 0051 §6).
 */
import { useEffect, useRef, useState } from "react";
import type { FactoryView } from "../../plugin/shared/view.ts";
import { invokeRpc } from "./rpc.ts";

export const BUSY_MS = 5000;
export const QUIET_MS = 30000;

export const pollEvery = (busy: boolean) => (busy ? BUSY_MS : QUIET_MS);

/** The adaptive half: anything running, or anything waiting on the Owner, keeps the clock busy. */
export function snapshotIsBusy(view: FactoryView): boolean {
  if (view.kpis.running > 0 || view.kpis.needsHuman > 0) return true;
  return view.agents.some((agent) => agent.status === "running" || agent.requiresAttention === true);
}

export type SnapshotReply = { ok: true; view: FactoryView } | { ok: false; code: string; error: string };

/** The default transport: `factory.snapshot` over the sidecar's RPC door. */
export function loadSnapshotViaSidecar(input: { projectRoot?: string }): Promise<SnapshotReply> {
  return invokeRpc<FactoryView>("factory.snapshot", input).then((reply) =>
    reply.ok ? { ok: true as const, view: reply.result } : { ok: false as const, code: reply.code, error: reply.error },
  );
}

export type LoadedSnapshot = { value: FactoryView | null; error: { code: string; message: string } | null; at: number | null };

export function useSnapshot(load: () => Promise<SnapshotReply>, reloadKey: string): LoadedSnapshot {
  const [state, setState] = useState<LoadedSnapshot>({ value: null, error: null, at: null });
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: FactoryView | null = null;
    const again = () => {
      if (live) timer = setTimeout(tick, document.visibilityState === "hidden" ? QUIET_MS : pollEvery(last !== null && snapshotIsBusy(last)));
    };
    const tick = async () => {
      if (document.visibilityState === "hidden") return again();
      clearTimeout(timer);
      try {
        const reply = await latest.current();
        if (!live) return;
        if (reply.ok) last = reply.view;
        setState((previous) =>
          reply.ok
            ? { value: reply.view, error: null, at: Date.now() }
            : { ...previous, error: { code: reply.code, message: reply.error } },
        );
      } catch (error) {
        if (live) setState((previous) => ({ ...previous, error: { code: "failed", message: String(error) } }));
      }
      again();
    };
    const shown = () => {
      if (!live || document.visibilityState === "hidden") return;
      clearTimeout(timer);
      void tick();
    };
    setState({ value: null, error: null, at: null });
    void tick();
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("focus", shown);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("focus", shown);
    };
  }, [reloadKey]);
  return state;
}
