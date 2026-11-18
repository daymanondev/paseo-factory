/**
 * The Factory tab header's version + "Check for updates" / "Update to vX"
 * control (ticket 11). `useSelfUpdate` owns the small state machine around the
 * two RPCs (the Shell mounts it); `SelfUpdateControls` and `SelfUpdateNote`
 * are pure renders of that state, so tests can mount them to static markup.
 * Applying the update reloads this very plugin, so no reply after pressing is
 * the expected outcome, not an error. While `phase === "reloading"`, the hook
 * polls `status({ force: true })` until the restarted plugin answers with the
 * updated version (tolerating transient disconnect errors) or times out.
 * Mobile keeps its write limits: it shows the version and can check, but never
 * presses Update.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { Btn } from "../kit/pill.tsx";
import { text } from "../kit/theme.ts";
import { isCoreSelfRestartError } from "./plugin-feedback.ts";

/** How long "Up to date" stays up after a check that found nothing. */
export const UP_TO_DATE_MS = 4_000;
/** Without a reply this long after pressing Update, assume the plugin is reloading. */
export const NO_REPLY_RELOADING_MS = 20_000;
/** How often to probe `status` while waiting for the restarted plugin to return. */
export const RELOAD_POLL_MS = 2_000;
/** Maximum wait across slow git clone + plugin restart before returning to idle with an error. */
export const RELOAD_TIMEOUT_MS = 300_000;

export type SelfUpdatePhase = "checking" | "idle" | "updating" | "reloading";

export interface SelfUpdateState {
  phase: SelfUpdatePhase;
  /** The installed version (no `v`), once a status answered. */
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  /** True briefly after a Check that found nothing newer. */
  upToDate: boolean;
  /** A server note (e.g. the downgrade guard's) or a short check failure. */
  note: string | null;
  /** A real apply/check failure — warning colour. */
  error: string | null;
}

export interface SelfUpdateActions {
  /** A forced status. */
  check(): void;
  apply(): void;
}

export interface SelfUpdateView {
  state: SelfUpdateState;
  actions: SelfUpdateActions;
}

export const INITIAL_SELF_UPDATE: SelfUpdateState = {
  phase: "checking",
  current: null,
  latest: null,
  updateAvailable: false,
  upToDate: false,
  note: null,
  error: null,
};

type StatusReply =
  | { ok: true; current: string; latest: string | null; updateAvailable: boolean; checkedAt: string; note?: string }
  | { ok: false; code: string; error: string };
type ApplyReply = { ok: true; from: string; to: string } | { ok: false; code: string; error: string };

const RELOADING_COPY = "Paseo is reloading the Factory plugin…";

export function useSelfUpdate(input: {
  status: (input: { force?: boolean }) => Promise<StatusReply>;
  apply: (input: Record<string, never>) => Promise<ApplyReply>;
  /** False hides the whole control (the Settings screen never mounts the Factory header). */
  enabled: boolean;
  /** Override reload polling interval in tests; defaults to `RELOAD_POLL_MS`. */
  reloadPollMs?: number;
  /** Override reload timeout in tests; defaults to `RELOAD_TIMEOUT_MS`. */
  reloadTimeoutMs?: number;
}): SelfUpdateView {
  const [state, setState] = useState<SelfUpdateState>(INITIAL_SELF_UPDATE);
  const calls = useRef(input);
  calls.current = input;
  const stateRef = useRef(state);
  stateRef.current = state;
  const mounted = useRef(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const noReplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadOriginRef = useRef<{ from: string | null; startedAt: number } | null>(null);
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    timers.current.push(t);
    return t;
  };
  const clearNoReplyTimer = () => {
    if (noReplyTimerRef.current !== null) {
      clearTimeout(noReplyTimerRef.current);
      noReplyTimerRef.current = null;
    }
  };
  const patch = (next: Partial<SelfUpdateState>) => {
    if (mounted.current) setState((prev) => ({ ...prev, ...next }));
  };

  const check = (force: boolean) => {
    patch({ phase: "checking", error: null, upToDate: false });
    calls.current
      .status(force ? { force: true } : {})
      .then((reply) => {
        if (!reply.ok || typeof reply.current !== "string") {
          patch({ phase: "idle", error: reply.ok ? "Unexpected reply while checking for updates." : reply.error, note: null });
          return;
        }
        const upToDate = force && !reply.updateAvailable && reply.note === undefined && reply.latest !== null;
        patch({ phase: "idle", current: reply.current, latest: reply.latest, updateAvailable: reply.updateAvailable, note: reply.note ?? null, error: null, upToDate });
        if (upToDate) later(() => patch({ upToDate: false }), UP_TO_DATE_MS);
      })
      .catch((error: unknown) => {
        patch({ phase: "idle", error: error instanceof Error ? error.message : String(error), note: null });
      });
  };

  const apply = () => {
    clearNoReplyTimer();
    reloadOriginRef.current = { from: stateRef.current.current, startedAt: Date.now() };
    patch({ phase: "updating", error: null, note: null });
    noReplyTimerRef.current = later(() => {
      noReplyTimerRef.current = null;
      if (mounted.current) setState((prev) => (prev.phase === "updating" ? { ...prev, phase: "reloading" } : prev));
    }, NO_REPLY_RELOADING_MS);
    const reloading = (message: string) => isCoreSelfRestartError({ target: "paseo-factory", action: "update", errorMessage: message });
    calls.current
      .apply({})
      .then((reply) => {
        clearNoReplyTimer();
        if (reply.ok || reloading(reply.error)) {
          patch({ phase: "reloading", error: null });
        } else {
          reloadOriginRef.current = null;
          patch({ phase: "idle", error: reply.error });
        }
      })
      // A dropped connection is the plugin reloading underneath us.
      .catch(() => {
        clearNoReplyTimer();
        patch({ phase: "reloading", error: null });
      });
  };

  useEffect(() => {
    mounted.current = true;
    if (input.enabled) check(false);
    return () => {
      mounted.current = false;
      for (const timer of timers.current) clearTimeout(timer);
      timers.current = [];
    };
  }, [input.enabled]);

  const reloadPollMs = input.reloadPollMs ?? RELOAD_POLL_MS;
  const reloadTimeoutMs = input.reloadTimeoutMs ?? RELOAD_TIMEOUT_MS;

  useEffect(() => {
    if (!input.enabled || state.phase !== "reloading") return;
    let cancelled = false;
    let probing = false;
    const startedAt = reloadOriginRef.current?.startedAt ?? Date.now();
    const fromVersion = reloadOriginRef.current?.from ?? null;

    const probe = () => {
      if (cancelled || !mounted.current) return;
      if (Date.now() - startedAt >= reloadTimeoutMs) {
        reloadOriginRef.current = null;
        patch({ phase: "idle", error: "Reload timed out — reopen Factory or reload window to check the active version." });
        return;
      }
      if (probing) return;
      probing = true;
      calls.current
        .status({ force: true })
        .then((reply) => {
          if (cancelled || !mounted.current || stateRef.current.phase !== "reloading") return;
          if (!reply.ok || typeof reply.current !== "string") return;
          const versionChanged = fromVersion !== null && reply.current !== fromVersion;
          if (!versionChanged && reply.updateAvailable) return;
          reloadOriginRef.current = null;
          patch({
            phase: "idle",
            current: reply.current,
            latest: reply.latest,
            updateAvailable: reply.updateAvailable,
            upToDate: false,
            error: null,
            note: versionChanged ? `Updated to v${reply.current} — reopen tab or reload window to refresh UI.` : (reply.note ?? null),
          });
        })
        .catch(() => {
          // Transient socket/plugin errors during restart keep waiting in `reloading`.
        })
        .finally(() => {
          probing = false;
        });
    };

    const timer = setInterval(probe, reloadPollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [input.enabled, state.phase, reloadPollMs, reloadTimeoutMs]);

  return { state, actions: { check: () => check(true), apply } };
}

/** The header's inline items: version, status text, and the one button. A fragment — the header owns the row and its wrapping. */
export function SelfUpdateControls({ theme, view, mobile }: { theme: PluginTheme; view: SelfUpdateView; mobile: boolean }) {
  const { state, actions } = view;
  const muted = text(theme, "label");
  const latest = state.latest ?? "";
  const busy = state.phase === "updating" || state.phase === "reloading";
  return (
    <>
      {state.current !== null ? <Text testID="factory-version" style={muted}>{`v${state.current}`}</Text> : null}
      {state.phase === "checking" ? <Text testID="factory-update-checking" style={muted}>Checking…</Text> : null}
      {state.phase !== "checking" && state.updateAvailable && !mobile ? (
        <Btn theme={theme} small variant="primary" testID="factory-update-apply" label={busy ? `Updating to v${latest}…` : `Update to v${latest}`} disabled={busy} onPress={actions.apply} />
      ) : null}
      {state.phase !== "checking" && state.updateAvailable && mobile ? <Text testID="factory-update-desktop-hint" style={muted}>Update from Paseo Desktop</Text> : null}
      {state.phase === "idle" && state.upToDate ? <Text testID="factory-update-uptodate" style={muted}>Up to date</Text> : null}
      {state.phase !== "checking" && !state.updateAvailable && !busy ? (
        <Btn theme={theme} small variant="ghost" testID="factory-update-check" label="Check for updates" onPress={actions.check} />
      ) : null}
    </>
  );
}

/** The line under the row: the reload notice, a real error (warning colour), or a server note (muted). */
export function SelfUpdateNote({ theme, view }: { theme: PluginTheme; view: SelfUpdateView }) {
  const { state } = view;
  if (state.phase === "reloading") return <Text testID="factory-update-note" style={text(theme, "label")}>{RELOADING_COPY}</Text>;
  if (state.error !== null) return <Text testID="factory-update-error" style={text(theme, "label", "statusWarning")}>{state.error}</Text>;
  if (state.note !== null) return <Text testID="factory-update-note" style={text(theme, "label")}>{state.note}</Text>;
  return null;
}
