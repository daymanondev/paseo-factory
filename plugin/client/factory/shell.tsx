/**
 * The shared Factory surface host: the Project tab and machine Settings.
 * It owns snapshot polling, navigation, measured width and RPC actions.
 * The tab renders the server projection; machine panes stay in Settings.
 * Desktop-only controls are gated by the host platform before mounting.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { skillsImport, skillsPackSave, skillsPackDelete, skillsPackReset, skillsTogglePack, lanesSet, lanesReset, lanesSetBatch, handoffStart, handoffReplaceNow, handoffCancel, handoffRetry, handoffHandover, onboardingInspect, onboardingStart, onboardingStatus, openDesignCatalog, openDesignSync, helperMcpsSyncAndProbe, helperMcpsSetEnabled, pluginsInstall, pluginsManage, pluginsCheckUpdates, releaseSettingsRead, releaseSettingsWrite, storeReleaseRead, storeReleaseWrite, githubPublishPreflight, githubPublish, selfUpdateApply, selfUpdateStatus, profilesApply, profilesDelete, profilesSave, projectDelete, projectReset, projectRotate, snapshot, stateUpdates, supervisorAdopt, supervisorStart, vaultConfigure, vaultHydrate, vaultImport, vaultSync, gateQueueCancel } from "../../shared/rpc.ts";
import { GH_LOGIN_CMD } from "./github-release-card.tsx";
import type { GitHubPublishSubmitInput, ReleaseCardFeedback } from "./github-release-card.tsx";
import type { StoreReleaseCardFeedback } from "./store-release-card.tsx";
import type { ManageablePluginId } from "../../shared/companions.ts";
import type { FactoryView, GitHubPublishPreflightView, LaneName, ReleaseSettingsView, StoreReleaseMode, StoreReleaseView } from "../../shared/view.ts";
import { SPACING, text } from "../kit/theme.ts";
import { useNow, usePoll, pollEvery, PROVIDERS_LOADING_MS, QUIET_MS } from "../kit/poll.ts";
import { isSubscriptionLive, useClientSubscription } from "../kit/subscription.ts";
import { OpenDesignControl } from "./open-design.tsx";
import type { SeatEditorRequest } from "./editor-request.ts";
import { ProjectPanel } from "./project-panel.tsx";
import type { GateQueueCancelError } from "./project-panel.tsx";
import { useSelfUpdate } from "./self-update.tsx";
import { ProjectMenu } from "./project-menu.tsx";
import { useOnboardingRunTracker } from "./onboarding-run-tracker.tsx";
import { OnboardingWizard } from "./onboarding-wizard.tsx";
import { VaultPane, isVaultActName } from "./vault.tsx";
import type { VaultNote } from "./vault.tsx";
import { actionFeedback, createResponseOrder } from "./vault-feedback.ts";
import type { VaultStatusView } from "../../shared/view.ts";
import { SeatsPane } from "./seats.tsx";
import { PluginsPane, SkillsToolsPane } from "./plugins.tsx";
import type { PluginsActions } from "./plugins.tsx";
import { DiagnosticsBody, PrerequisiteSetupCard, SettingsReadOnly, SettingsScreen } from "./settings.tsx";
import { settingsWarnings } from "./settings-state.ts";
import { isCoreSelfRestartError, resolveCoreRestartWatch } from "./plugin-feedback.ts";
import type { ActivePluginAct, PluginsNote } from "./plugin-feedback.ts";

/** The navigation slice the shell uses — `openAgent` jumps to a session. */
export interface Navigation {
  supportsFocusHost?: boolean;
  openAgent(input: { agentId: string; serverId?: string; focusHost?: boolean }): void;
}

export function FactoryShell({
  theme,
  layout,
  dir,
  navigation,
  serverId,
  surface = "panel",
  openSettings,
  openReleaseLab,
  editorRequest,
  onEditorRequestHandled,
}: {
  theme: PluginTheme;
  layout?: { compact: boolean; platform?: "ios" | "android" | "web" };
  /** The workspace panel's directory scope; undefined on the settings screen. */
  dir?: string;
  navigation?: Navigation;
  serverId?: string;
  /** Which entry hosts the shell: the workspace panel (the Project panel) or the settings screen. */
  surface?: "panel" | "settings";
  openSettings?: () => void;
  openReleaseLab?: () => void;
  editorRequest?: SeatEditorRequest;
  onEditorRequestHandled?: () => void;
}) {
  const toast = useToast();
  const snapshotCall = useRpc(snapshot);
  const lanesSetCall = useRpc(lanesSet);
  // Per-seat handoff contracts are shared by live rows and independent recovery entries.
  const handoffStartCall = useRpc(handoffStart);
  const handoffReplaceNowCall = useRpc(handoffReplaceNow);
  const handoffCancelCall = useRpc(handoffCancel);
  const handoffRetryCall = useRpc(handoffRetry);
  const handoffHandoverCall = useRpc(handoffHandover);
  const supervisorStartCall = useRpc(supervisorStart);
  const supervisorAdoptCall = useRpc(supervisorAdopt);
  // The onboarding wizard's doors (ADR 0056 / ADR 0065): folder inspection, async run start/status, and Open Design catalog.
  const onboardingInspectCall = useRpc(onboardingInspect);
  const onboardingStartCall = useRpc(onboardingStart);
  const onboardingStatusCall = useRpc(onboardingStatus);
  const openDesignCatalogCall = useRpc(openDesignCatalog);
  const openDesignSyncCall = useRpc(openDesignSync);
  const projectResetCall = useRpc(projectReset);
  const projectRotateCall = useRpc(projectRotate);
  const projectDeleteCall = useRpc(projectDelete);
  // The v0.0.38 lane acts (ADR 0026 §2/§5): one useRpc per contract, every
  // dispatch through act() — the SeatsPane stays a pure render of the view
  // plus action callbacks (the panes' law).
  const lanesSetBatchCall = useRpc(lanesSetBatch);
  const lanesResetCall = useRpc(lanesReset);
  const profilesSaveCall = useRpc(profilesSave);
  const profilesApplyCall = useRpc(profilesApply);
  const profilesDeleteCall = useRpc(profilesDelete);

  const helperMcpsSyncCall = useRpc(helperMcpsSyncAndProbe);
  const helperMcpsEnableCall = useRpc(helperMcpsSetEnabled);
  const pluginsInstallCall = useRpc(pluginsInstall);
  const skillsImportCall = useRpc(skillsImport);
  const skillsTogglePackCall = useRpc(skillsTogglePack);
  const skillsPackResetCall = useRpc(skillsPackReset);
  const skillsPackSaveCall = useRpc(skillsPackSave);
  const skillsPackDeleteCall = useRpc(skillsPackDelete);
  const pluginsManageCall = useRpc(pluginsManage);
  const pluginsCheckUpdatesCall = useRpc(pluginsCheckUpdates);
  // The header's version + self-update (ticket 11): one status on mount, Check forces it, Update applies (the plugin reloads under us).
  const selfUpdateStatusCall = useRpc(selfUpdateStatus);
  const selfUpdateApplyCall = useRpc(selfUpdateApply);
  const releaseReadCall = useRpc(releaseSettingsRead);
  const releaseWriteCall = useRpc(releaseSettingsWrite);
  const storeReleaseReadCall = useRpc(storeReleaseRead);
  const storeReleaseWriteCall = useRpc(storeReleaseWrite);
  const githubPublishPreflightCall = useRpc(githubPublishPreflight);
  const githubPublishCall = useRpc(githubPublish);
  const selfUpdate = useSelfUpdate({ status: selfUpdateStatusCall, apply: selfUpdateApplyCall, enabled: surface === "panel" });
  // The Private vault RPCs (v0.0.21–v0.0.22, ADR 0014 §4): one useRpc per
  // contract, every act through act() — the plugins pair's law.
  const vaultConfigureCall = useRpc(vaultConfigure);
  const vaultHydrateCall = useRpc(vaultHydrate);
  const vaultSyncCall = useRpc(vaultSync);
  const vaultImportCall = useRpc(vaultImport);
  const gateQueueCancelCall = useRpc(gateQueueCancel);

  const [busy, setBusy] = useState(false);
  const [handover, setHandover] = useState<{ seat: string; text: string; source: "extracted" | "substitute" } | null>(null);
  const [busyAct, setBusyAct] = useState<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [autoCheckedPlugins, setAutoCheckedPlugins] = useState(false);
  const [activePluginAct, setActivePluginAct] = useState<ActivePluginAct | null>(null);
  const [pluginsNote, setPluginsNote] = useState<PluginsNote | null>(null);
  const [pluginCardErrors, setPluginCardErrors] = useState<Readonly<Record<string, string>>>({});
  const vaultResponses = useRef(createResponseOrder());
  const [vaultNote, setVaultNote] = useState<VaultNote | null>(null);
  const [laneNote, setLaneNote] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<"team" | "models" | "project">("team");
  const [releaseView, setReleaseView] = useState<ReleaseSettingsView | null>(null);
  const [storeReleaseView, setStoreReleaseView] = useState<StoreReleaseView | null>(null);
  const [storeReleaseBusy, setStoreReleaseBusy] = useState(false);
  const [storeReleaseFeedback, setStoreReleaseFeedback] = useState<StoreReleaseCardFeedback | null>(null);
  const [publishPreflightView, setPublishPreflightView] = useState<GitHubPublishPreflightView | null>(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseFeedback, setReleaseFeedback] = useState<ReleaseCardFeedback | null>(null);
  const [releaseCopiedLogin, setReleaseCopiedLogin] = useState(false);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [cancellingGateQueueIds, setCancellingGateQueueIds] = useState<string[]>([]);
  const cancellingGateQueueIdsRef = useRef<Set<string>>(new Set());
  const [gateQueueCancelError, setGateQueueCancelError] = useState<GateQueueCancelError | null>(null);
  const mountedRef = useRef(true);
  const scopeRootRef = useRef(dir);
  scopeRootRef.current = dir;
  const lastViewRef = useRef<FactoryView | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const onboardingProgressRef = useRef<(projectRoot?: string) => void>(() => {});
  const [onboardingHoldFolder, setOnboardingHoldFolder] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The active Project scope: the workspace panel's directory (auto-bound).
  const scopeRoot = dir;
  const isCompact = layout?.compact === true || (containerWidth > 0 && containerWidth < 640);
  const panelHost = surface === "panel";
  /** Paseo mobile: a monitor with quick actions — no settings writes, no desktop-only panes. */
  const mobile = layout?.platform === "ios" || layout?.platform === "android";

  const subscriptionInput = useMemo(() => ({ projectRoot: scopeRoot }), [scopeRoot]);
  const subscription = useClientSubscription(stateUpdates, subscriptionInput, (event) => {
    refreshRef.current();
    if (event.reasons.includes("onboarding.progress")) {
      onboardingProgressRef.current(event.projectRoot);
    }
  });
  const subscriptionLive = isSubscriptionLive(subscription);

  const poll = usePoll(
    async () => {
      const r = await snapshotCall({ projectRoot: scopeRoot });
      if (!r.ok) return { ok: false as const, code: r.code, error: r.error };
      vaultResponses.current.invalidate();
      return { ok: true as const, value: r.view };
    },
    `factory:${scopeRoot ?? "global"}`,
    (view) =>
      activePluginAct?.kind === "restarting-core"
        ? 1000
        : view?.providersLoading === true
          ? PROVIDERS_LOADING_MS
          : subscriptionLive
            ? QUIET_MS
            : pollEvery(
                (view?.kpis.running ?? 0) + (view?.kpis.needsHuman ?? 0) > 0 ||
                  (view?.panel.handoffs ?? []).some(handoff => handoff.state !== "done") ||
                  (view?.vault.historyImports ?? []).some((item) => item.status === "pending" || item.status === "staged"),
              ),
    { cadenceKey: `${subscriptionLive}:${activePluginAct?.kind === "restarting-core"}` },
  );
  refreshRef.current = poll.refresh;
  const refresh = poll.refresh;
  const prevSubscriptionStatusRef = useRef(subscription.status);
  useEffect(() => {
    const prev = prevSubscriptionStatusRef.current;
    prevSubscriptionStatusRef.current = subscription.status;
    if (prev !== "live" && subscription.status === "live") {
      poll.refresh();
    }
  }, [subscription.status, poll.refresh]);
  if (poll.value !== null) lastViewRef.current = poll.value;
  const serverView = poll.value ?? lastViewRef.current;
  const view = serverView;
  const onboardingFolder = !mobile && panelHost ? (scopeRoot ?? view?.panel.onboarding?.folder ?? null) : null;
  const prevScopeRef = useRef(scopeRoot);
  const scopeChangedThisRender = prevScopeRef.current !== scopeRoot;
  useEffect(() => {
    prevScopeRef.current = scopeRoot;
  }, [scopeRoot]);
  const freshView = scopeChangedThisRender ? null : poll.value;
  const onboardingCanBeActive =
    onboardingFolder !== null &&
    (freshView === null
      ? onboardingHoldFolder === onboardingFolder
      : !freshView.panel.isProject ||
        onboardingHoldFolder === onboardingFolder ||
        freshView.panel.seats?.supervisor.vacant === true);
  const startOnboardingRun = async (input: Parameters<typeof onboardingStartCall>[0]) => {
    try {
      const reply = await onboardingStartCall(input);
      if (reply.ok && reply.run?.status !== "failed") {
        setOnboardingHoldFolder(input.folder);
      } else {
        setOnboardingHoldFolder((prev) => (prev === input.folder ? null : prev));
      }
      return reply;
    } catch (error) {
      setOnboardingHoldFolder((prev) => (prev === input.folder ? null : prev));
      throw error;
    }
  };

  const focusHostOption = navigation?.supportsFocusHost === true ? { focusHost: true } : {};

  const onboardingTracker = useOnboardingRunTracker({
    activeFolder: onboardingCanBeActive ? onboardingFolder : null,
    subscriptionLive,
    start: startOnboardingRun,
    status: (input) => onboardingStatusCall(input),
    onActiveComplete: async (result) => {
      toast.show(result.summary, { variant: "success" });
      setOnboardingHoldFolder(null);
      refresh();
      navigation?.openAgent({ agentId: result.agentId, serverId, ...focusHostOption });
      return { ok: true as const };
    },
    onBackgroundComplete: (result) => {
      toast.show(result.summary, { variant: "success" });
      refresh();
    },
  });
  onboardingProgressRef.current = onboardingTracker.notifyProgress;

  useEffect(() => {
    setOnboardingHoldFolder(null);
    setGateQueueCancelError(null);
  }, [scopeRoot]);

  const probedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (mobile || !panelHost || scopeRoot === undefined || freshView === null) return;
    if (probedScopeRef.current === scopeRoot) return;
    if (!freshView.panel.isProject) {
      probedScopeRef.current = scopeRoot;
      return;
    }
    if (freshView.panel.seats?.supervisor.vacant !== true) return;
    probedScopeRef.current = scopeRoot;
    void onboardingTracker.probeFolder(scopeRoot).then((found) => {
      if (found !== null && found.status === "running") {
        setOnboardingHoldFolder(scopeRoot);
      }
    });
  }, [mobile, panelHost, scopeRoot, freshView, onboardingTracker.probeFolder]);

  const now = useNow(1000);
  const elapsedSeconds = activePluginAct === null ? 0 : Math.max(0, Math.floor((now - activePluginAct.startedAt) / 1000));
  useEffect(() => { if (view !== null) setVaultNote(null); }, [view]);

  const activeReleaseRoot =
    panelHost && panelTab === "project" && view?.panel.isProject && view.project !== null && view.project.missingRoot !== true
      ? view.project.root
      : null;

  const releaseReadRef = useRef(releaseReadCall);
  releaseReadRef.current = releaseReadCall;
  const storeReleaseReadRef = useRef(storeReleaseReadCall);
  storeReleaseReadRef.current = storeReleaseReadCall;
  const publishPreflightRef = useRef(githubPublishPreflightCall);
  publishPreflightRef.current = githubPublishPreflightCall;

  const refreshStoreReleaseView = useCallback(async (projectRoot: string) => {
    try {
      const reply = await storeReleaseReadRef.current({ projectRoot });
      if (reply && reply.ok && reply.settings !== undefined) {
        setStoreReleaseView(reply.settings);
      }
    } catch {
      // Transient store-release read errors leave the last good view in place.
    }
  }, []);

  const refreshReleaseView = useCallback(async (projectRoot: string) => {
    try {
      const reply = await releaseReadRef.current({ projectRoot });
      if (reply && reply.ok && reply.settings !== undefined) {
        setReleaseView(reply.settings);
        if (reply.settings.origin === null && !mobile) {
          try {
            const pre = await publishPreflightRef.current({ projectRoot });
            if (pre && pre.ok) setPublishPreflightView(pre);
          } catch {
            // Preflight failure leaves publish form using release view defaults.
          }
        } else {
          setPublishPreflightView(null);
        }
      }
    } catch {
      // Transient release-settings read errors leave the last good view in place.
    }
  }, [mobile]);

  useEffect(() => {
    if (activeReleaseRoot === null) {
      if (view?.panel.isProject !== true) {
        setReleaseView(null);
        setStoreReleaseView(null);
        setPublishPreflightView(null);
        setReleaseFeedback(null);
        setStoreReleaseFeedback(null);
      }
      return;
    }
    void refreshReleaseView(activeReleaseRoot);
    void refreshStoreReleaseView(activeReleaseRoot);
  }, [activeReleaseRoot, view?.generatedAt, view?.panel.isProject, refreshReleaseView, refreshStoreReleaseView]);

  const runReleaseAct = async (work: (projectRoot: string) => Promise<void>) => {
    if (activeReleaseRoot === null || releaseBusy) return;
    setReleaseBusy(true);
    setReleaseFeedback(null);
    try {
      await work(activeReleaseRoot);
    } catch (error) {
      setReleaseFeedback({
        text: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setReleaseBusy(false);
    }
  };

  const publishProjectRepo = (input: GitHubPublishSubmitInput) =>
    runReleaseAct(async (projectRoot) => {
      const reply = await githubPublishCall({ projectRoot, ...input });
      if (!reply.ok) {
        setReleaseFeedback({ text: reply.error, tone: "error" });
        return;
      }
      setReleaseView(reply.settings);
      setPublishPreflightView(null);
      setReleaseFeedback({ text: `Published ${reply.slug} (${reply.visibility}).`, tone: "info" });
      refresh();
    });

  const updateReleaseSettings = (patch: { mode?: "off" | "on-request" | "auto"; branch?: string | null }) =>
    runReleaseAct(async (projectRoot) => {
      const reply = await releaseWriteCall({ projectRoot, ...patch });
      if (!reply.ok) {
        setReleaseFeedback({ text: reply.error, tone: "error" });
        return;
      }
      setReleaseView(reply.settings);
      if (reply.droppedPendingRequest) {
        setReleaseFeedback({ text: "Pending Release request was dropped.", tone: "info" });
      }
    });

  const updateStoreReleaseMode = async (mode: StoreReleaseMode) => {
    if (activeReleaseRoot === null || storeReleaseBusy || mobile) return;
    setStoreReleaseBusy(true);
    setStoreReleaseFeedback(null);
    try {
      const reply = await storeReleaseWriteCall({ projectRoot: activeReleaseRoot, mode });
      if (!reply.ok) {
        setStoreReleaseFeedback({ text: reply.error, tone: "error" });
        return;
      }
      setStoreReleaseView(reply.settings);
      await refreshStoreReleaseView(activeReleaseRoot);
      setStoreReleaseFeedback({
        text: reply.droppedPendingRequest
          ? `Store release mode set to ${reply.settings.mode}. Pending Store release request was dropped.`
          : `Store release mode set to ${reply.settings.mode}.`,
        tone: "success",
      });
    } catch (error) {
      setStoreReleaseFeedback({
        text: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setStoreReleaseBusy(false);
    }
  };

  const copyReleaseLoginCommand = () => {
    const clip = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } }).navigator?.clipboard;
    if (clip?.writeText !== undefined) void clip.writeText(GH_LOGIN_CMD);
    setReleaseCopiedLogin(true);
  };

  const clearPluginCardError = (target: ManageablePluginId | "all"): void => {
    if (target === "all") {
      setPluginCardErrors({});
      return;
    }
    setPluginCardErrors((prev) => {
      if (!(target in prev)) return prev;
      const next = { ...prev };
      delete next[target];
      return next;
    });
  };

  const recordPluginActFailure = (actName: string, target: ManageablePluginId | "all", errorMessage: string): void => {
    setPluginsNote({ text: `${actName}: ${errorMessage}`, tone: "statusDanger", pluginId: target });
    if (target !== "all") {
      setPluginCardErrors((prev) => ({ ...prev, [target]: errorMessage }));
    }
  };

  // While `paseo-factory` is restarting after a self-update or self-reload, poll
  // `factory.snapshot` every 1s and evaluate `resolveCoreRestartWatch`.
  useEffect(() => {
    if (activePluginAct?.kind !== "restarting-core") return;
    refresh();
  }, [activePluginAct?.kind, now]);

  useEffect(() => {
    if (activePluginAct?.kind !== "restarting-core") return;
    const freshView =
      poll.value !== null && poll.error === null && poll.at !== null && poll.at >= activePluginAct.startedAt
        ? poll.value
        : null;
    const resolution = resolveCoreRestartWatch({
      view: freshView,
      previousRevision: activePluginAct.fromRevision ?? null,
      targetRevision: activePluginAct.targetRevision ?? null,
      action: activePluginAct.action === "reload" ? "reload" : activePluginAct.action === "install" ? "install" : "update",
      elapsedMs: Math.max(0, Date.now() - activePluginAct.startedAt),
    });
    if (resolution.status === "waiting") return;
    setActivePluginAct(null);
    setPluginsNote(resolution.note);
    if (resolution.status === "completed") {
      clearPluginCardError("paseo-factory");
      toast.show(resolution.note.text, { variant: "success" });
    } else {
      setPluginCardErrors((prev) => ({ ...prev, "paseo-factory": resolution.note.text }));
      toast.error(resolution.note.text);
    }
  }, [activePluginAct, poll.value, poll.error, poll.at, now]);

  // Automatically check for plugin updates once when the Owner opens the Settings screen (desktop)
  // if update status has never been checked or is older than 5 minutes (v0.0.25, ADR 0012 §4) —
  // the Plugins section's warning depends on it.
  useEffect(() => {
    if (panelHost || mobile) return;
    if (view === null || checkingUpdates || autoCheckedPlugins) return;
    const stale = view.pluginsCheckedAt === null || Date.now() - Date.parse(view.pluginsCheckedAt) > 300_000;
    if (!stale) return;
    setAutoCheckedPlugins(true);
    setCheckingUpdates(true);
    void pluginsCheckUpdatesCall({}).finally(() => {
      setCheckingUpdates(false);
      refresh();
    });
  }, [panelHost, mobile, view?.pluginsCheckedAt, checkingUpdates, autoCheckedPlugins]);

  const act = async (name: string, run: () => Promise<{ ok: boolean; error?: string | null; summary?: string; historyImports?: VaultStatusView["historyImports"]; vault?: VaultStatusView }>): Promise<boolean> => {
    setBusy(true);
    setBusyAct(name);
    const isVaultAct = isVaultActName(name);
    const request = vaultResponses.current.begin();
    try {
      const reply = await run();
      if (!reply.ok) {
        const message = reply.error ?? "failed";
        toast.error(`${name}: ${message}`);
        if (isVaultAct && vaultResponses.current.current(request)) setVaultNote({ text: `${name}: ${message}`, tone: "statusDanger" });
        return false;
      }
      const summary = (reply as { summary?: string }).summary;
      if (typeof summary === "string" && summary.trim() !== "") {
        const feedback = actionFeedback(reply);
        toast.show(feedback.text, { variant: feedback.tone === "statusSuccess" ? "success" : "warning" });
        if (isVaultAct && vaultResponses.current.current(request)) setVaultNote(feedback);
      }
      return true;
    } catch (error) {
      const message = String(error);
      toast.error(`${name}: ${message}`);
      if (isVaultAct && vaultResponses.current.current(request)) setVaultNote({ text: `${name}: ${message}`, tone: "statusDanger" });
      return false;
    } finally {
      setBusy(false);
      setBusyAct(null);
      refresh();
    }
  };

  if (view === null) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0, padding: SPACING[4], gap: SPACING[2] }}>
        <Text style={text(theme, "section")}>paseo-factory</Text>
        {poll.error !== null ? <Text style={text(theme, "label", "statusWarning")}>{poll.error.message}</Text> : <Text style={text(theme, "meta")}>Loading the factory…</Text>}
      </View>
    );
  }

  // The Project-scoped acts need a resolved Project — the snapshot's own
  // `project` is the truth (a scope that does not resolve leaves them parked).
  const projectRoot = view.project?.root;
  /** Model chips always save into this Project; a running Peer only changes through handoff. */
  const saveSeatModel = async (seat: string, value: string): Promise<boolean> => {
    if (projectRoot === undefined) return false;
    if (seat.startsWith("peer:")) return act("Hand off Peer", () => handoffStartCall({ projectRoot, seat, lane: value }));
    if (seat !== "supervisor" && seat !== "lead" && seat !== "worker") return false;
    return act(seat === "worker" ? "Save Default worker" : "Change model", () => lanesSetCall({ projectRoot, lane: seat, value }));
  };
  const setMachineDefault = async (seat: string, value: string): Promise<boolean> => {
    if (mobile) return false;
    const lane = seat.startsWith("peer:") ? "worker" : seat;
    if (lane !== "supervisor" && lane !== "lead" && lane !== "worker") return false;
    return act("Set as machine default", () => lanesSetCall({ lane, value }));
  };
  const applyProjectProfile = (profileId: string): void => {
    if (projectRoot === undefined || mobile) return;
    void act("Apply Lane profile", () => profilesApplyCall({ projectRoot, profileId }));
  };
  const saveProjectProfile = async (input: { id?: string; name: string; description?: string }): Promise<boolean> => {
    if (projectRoot === undefined || mobile) return false;
    return act(input.id ? "Update Lane profile" : "Save Lane profile", () => profilesSaveCall({ ...input, projectRoot }));
  };
  const resetProjectLanes = (): void => {
    if (projectRoot === undefined || mobile) return;
    void act("Reset Project models", () => lanesResetCall({ projectRoot }));
  };
  const toggleProjectSkillPack = (pack: string, enabled: boolean): void => {
    if (projectRoot === undefined || mobile) return;
    void act("Project Skill Pack", () => skillsTogglePackCall({ projectRoot, pack, enabled }));
  };
  const resetProjectSkillPacks = (): void => {
    if (projectRoot === undefined || mobile) return;
    void act("Reset Project skill packs", () => skillsPackResetCall({ projectRoot }));
  };
  /** A Needs-you item's primary action: a bare navigation jump to the agent's conversation. */
  const openAgent = (agentId: string): void => {
    navigation?.openAgent({ agentId, serverId, ...focusHostOption });
  };
  /** Returns the outcome so the Hand off… modal can stay open when the server refuses; the alert buttons ignore it. */
  const startHandoff = (seat: string): Promise<boolean> | void => {
    if (projectRoot === undefined) return;
    return act("Hand off seat", () => handoffStartCall({ projectRoot, seat }));
  };
  const replaceHandoff = (seat: string): void => {
    if (projectRoot === undefined) return;
    void act("Replace now", () => handoffReplaceNowCall({ projectRoot, seat }));
  };
  const cancelHandoff = (seat: string): void => {
    if (projectRoot === undefined) return;
    void act("Cancel handoff", () => handoffCancelCall({ projectRoot, seat }));
  };
  const retryHandoff = (seat: string): void => {
    if (projectRoot === undefined || mobile) return;
    void act("Try handoff again", () => handoffRetryCall({ projectRoot, seat }));
  };
  const viewHandover = (seat: string): void => {
    if (projectRoot === undefined) return;
    void act("View handover", async () => {
      const reply = await handoffHandoverCall({ projectRoot, seat });
      if (reply.ok) setHandover({ seat, text: reply.text ?? "No handover saved yet.", source: reply.source ?? "extracted" });
      return reply;
    });
  };
  /** Adopt the candidate Supervisor and open its chat; also available on mobile. */
  const adoptSupervisor = (agentId: string): void => {
    if (projectRoot === undefined) return;
    void act("Use this chat as Supervisor", async () => {
      const reply = await supervisorAdoptCall({ projectRoot, agentId });
      if (reply.ok) navigation?.openAgent({ agentId: reply.agentId, serverId, ...focusHostOption });
      return reply;
    });
  };
  /** Start Supervisor on a vacant seat; success opens the conversation it created (desktop only). */
  const startSupervisor = (): void => {
    if (projectRoot === undefined || mobile) return;
    void act("Start Supervisor", async () => {
      const reply = await supervisorStartCall({ projectRoot });
      if (reply.ok) navigation?.openAgent({ agentId: reply.agentId, serverId, ...focusHostOption });
      return reply;
    });
  };
  /** A broken Open Design link's primary action: sync the linked design again from the host (desktop only — the card below also offers a granted-folder Sync). */
  const syncOpenDesign = (): void => {
    if (projectRoot === undefined || mobile) return;
    void act("Sync Open Design", () => openDesignSyncCall({ projectRoot }));
  };
  const resetProject = (): void => {
    if (projectRoot === undefined) return;
    void act("Reset Project", () => projectResetCall({ projectRoot }));
  };
  const rotateSeats = (): void => {
    if (projectRoot === undefined || mobile) return;
    void act("Rotate seats", () => projectRotateCall({ projectRoot }));
  };
  const deleteProject = (): void => {
    const target = view.project;
    if (target === null) return;
    void act("Delete Project", () => projectDeleteCall({ projectRoot: target.root, projectSlug: target.slug, project: target.slug }));
  };
  const cancelGateQueueItem = (id: string): void => {
    if (cancellingGateQueueIdsRef.current.has(id)) return;
    const callScope = scopeRoot;
    cancellingGateQueueIdsRef.current.add(id);
    setCancellingGateQueueIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setGateQueueCancelError(null);
    void (async () => {
      try {
        const reply = await gateQueueCancelCall({ queueId: id });
        if (!mountedRef.current || scopeRootRef.current !== callScope) return;
        if (!reply.ok) {
          const message = reply.error || "Could not cancel Gate queue item.";
          setGateQueueCancelError({ queueId: id, message });
          toast.error(`Cancel Gate: ${message}`);
          return;
        }
        toast.show("Gate cancelled", { variant: "success" });
        refresh();
      } catch (error) {
        if (!mountedRef.current || scopeRootRef.current !== callScope) return;
        const message = error instanceof Error ? error.message : String(error);
        setGateQueueCancelError({ queueId: id, message });
        toast.error(`Cancel Gate: ${message}`);
      } finally {
        cancellingGateQueueIdsRef.current.delete(id);
        if (mountedRef.current) {
          setCancellingGateQueueIds((prev) => prev.filter((item) => item !== id));
        }
      }
    })();
  };
  const incompleteTools = (view.companionTools ?? []).filter((t) => t.status !== "running" || t.error !== null);
  const isInstallingPrereqs = activePluginAct !== null && activePluginAct.kind === "install" && activePluginAct.target === "all";
  /** Installs every required skill & tool — the Needs-you item's action and the Settings banner's button. */
  const installPrerequisitesResult = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    clearPluginCardError("all");
    setActivePluginAct({ kind: "install", target: "all", action: "install", startedAt: Date.now() });
    let failure: string | null = null;
    const ok = await act("Install Required Skills & Tools", async () => {
      try {
        const reply = await pluginsInstallCall({ target: "all", includeTools: true });
        if (reply.ok) {
          setPluginsNote({ text: reply.summary, tone: "statusSuccess", pluginId: "all" });
        } else {
          failure = reply.error;
          recordPluginActFailure("Install Required Skills & Tools", "all", reply.error);
        }
        return reply;
      } finally {
        setActivePluginAct(null);
      }
    });
    return ok ? { ok: true } : { ok: false, error: failure ?? "the install did not finish" };
  };
  const installPrerequisites = (): void => {
    void installPrerequisitesResult();
  };
  const pluginActions: PluginsActions = {
    busy: busy || activePluginAct !== null,
    checkingUpdates,
    savePack: input => act("Save custom skill pack", () => skillsPackSaveCall(input)),
    deletePack: id => act("Delete custom skill pack", () => skillsPackDeleteCall({ id })),
    importSkill: id => { void act('Import Skill', () => skillsImportCall({ id })); },
    togglePack: (pack, enabled) => { if (view.project) void act('Project Skill Pack', () => skillsTogglePackCall({ projectRoot: view.project!.root, pack, enabled })); },
    syncHelpers: () => { void act("Check Connectivity", async () => {
      const reply = await helperMcpsSyncCall({});
      if (reply.ok) setPluginsNote({ text: "Connectivity checks completed for synced Peer MCPs.", tone: "statusSuccess", pluginId: "all" });
      return reply;
    }); },
    setHelperConfig: (name, config) => { void act("Update Peer MCP", () => helperMcpsEnableCall({ name, ...config })); },
    checkUpdates: () => {
      setActivePluginAct({ kind: "check", target: "all", startedAt: Date.now() });
      void act("Check Updates", async () => {
        setCheckingUpdates(true);
        try {
          const reply = await pluginsCheckUpdatesCall({});
          if (reply.ok) {
            setPluginsNote({
              text: reply.summary,
              tone: reply.updatesAvailable.length > 0 ? "statusWarning" : "statusSuccess",
              pluginId: "all",
            });
          } else {
            recordPluginActFailure("Check Updates", "all", reply.error);
          }
          return reply;
        } catch (error) {
          recordPluginActFailure("Check Updates", "all", String(error));
          throw error;
        } finally {
          setCheckingUpdates(false);
          setActivePluginAct(null);
        }
      });
    },
    install: (target, source, ref) => {
      const coreTargeted = target === "paseo-factory";
      clearPluginCardError(target);
      setActivePluginAct({ kind: "install", target, action: "install", startedAt: Date.now() });
      void act("Install", async () => {
        let restartingCore = false;
        const enterCoreRestart = () => {
          restartingCore = true;
          setActivePluginAct({
            kind: "restarting-core",
            target: "paseo-factory",
            action: "install",
            startedAt: Date.now(),
            fromRevision: view.corePlugin.currentRevision,
            targetRevision: null,
          });
          setPluginsNote({
            text: "Reloading Core (paseo-factory)…",
            tone: "statusWarning",
            pluginId: "paseo-factory",
          });
        };
        try {
          const reply = await pluginsInstallCall({
            target,
            source,
            ref,
            ...(target === "all" ? { includeTools: true } : {}),
          });
          if (reply.ok) {
            setPluginsNote({ text: reply.summary, tone: "statusSuccess", pluginId: target });
          } else {
            if (isCoreSelfRestartError({ target, action: "install", errorMessage: reply.error, coreTargeted })) {
              enterCoreRestart();
              return { ok: true, summary: "" };
            }
            recordPluginActFailure("Install", target, reply.error);
          }
          return reply;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (isCoreSelfRestartError({ target, action: "install", errorMessage: msg, coreTargeted })) {
            enterCoreRestart();
            return { ok: true, summary: "" };
          }
          recordPluginActFailure("Install", target, msg);
          throw error;
        } finally {
          if (!restartingCore) {
            setActivePluginAct(null);
          }
        }
      });
    },
    manage: (pluginId, action) => {
      // The toast names the act — "Update: …", "Remove: …" (the act() law).
      const actName = `${action[0]!.toUpperCase()}${action.slice(1)}`;
      const allPlugins = [view.corePlugin, ...view.companions, ...(view.companionTools ?? [])];
      const targetPlugin = pluginId === "all" ? null : (allPlugins.find((p) => p.id === pluginId) ?? null);
      const coreTargeted =
        pluginId === "paseo-factory" ||
        (pluginId === "all" &&
          action === "update" &&
          (view.corePlugin.installKind === "git" || view.corePlugin.installKind === "npm") &&
          view.corePlugin.updateAvailable === true);
      const fromRevision = coreTargeted ? view.corePlugin.currentRevision : (targetPlugin?.currentRevision ?? null);
      const targetRevision =
        action === "update"
          ? coreTargeted
            ? (view.corePlugin.latestRevision ?? view.corePlugin.currentRevision)
            : (targetPlugin?.latestRevision ?? null)
          : action === "reload" && coreTargeted
            ? view.corePlugin.currentRevision
            : null;

      clearPluginCardError(pluginId);

      setActivePluginAct({
        kind: "manage",
        target: pluginId,
        action,
        startedAt: Date.now(),
        fromRevision,
        targetRevision,
      });

      void act(actName, async () => {
        let restartingCore = false;
        const enterCoreRestart = () => {
          restartingCore = true;
          setActivePluginAct({
            kind: "restarting-core",
            target: "paseo-factory",
            action,
            startedAt: Date.now(),
            fromRevision: view.corePlugin.currentRevision,
            targetRevision,
          });
          setPluginsNote({
            text: `Reloading Core (paseo-factory)${targetRevision ? ` → ${targetRevision.slice(0, 7)}` : ""}…`,
            tone: "statusWarning",
            pluginId: "paseo-factory",
          });
        };

        try {
          const reply = await pluginsManageCall({
            pluginId,
            action,
            ...(pluginId === "all" ? { includeTools: true } : {}),
          });
          if (!reply.ok) {
            if (isCoreSelfRestartError({ target: pluginId, action, errorMessage: reply.error, coreTargeted })) {
              enterCoreRestart();
              return { ok: true, summary: "" };
            }
            recordPluginActFailure(actName, pluginId, reply.error);
            return reply;
          }
          setPluginsNote({ text: reply.summary, tone: "statusSuccess", pluginId });
          return reply;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (isCoreSelfRestartError({ target: pluginId, action, errorMessage: msg, coreTargeted })) {
            enterCoreRestart();
            return { ok: true, summary: "" };
          }
          recordPluginActFailure(actName, pluginId, msg);
          throw error;
        } finally {
          if (!restartingCore) {
            setActivePluginAct(null);
          }
        }
      });
    },
  };

  const vaultPane = (
    <VaultPane
      theme={theme}
      vault={view.vault}
      busy={busy}
      busyAct={busyAct}
      vaultNote={vaultNote}
      onVaultSync={(input) => {
        void act("Vault Sync", () => vaultSyncCall(input ?? {}));
      }}
      onVaultImport={(input) => {
        void act("Vault Import", () => vaultImportCall(input));
      }}
      onVaultConfigure={(input) => {
        void act("Vault Save", () => vaultConfigureCall(input));
      }}
      onVaultHydrate={(repo, ref) => {
        void act("Vault Hydrate", () =>
          vaultHydrateCall({ ...(repo === undefined ? {} : { repo }), ...(ref === undefined ? {} : { ref }) }),
        );
      }}
      onRefresh={refresh}
    />
  );

  // The Settings screen (v0.6.0 W8, ADR 0056 §7): the machine-wide panes,
  // unscoped — lane and profile acts write the machine table (no projectRoot).
  // On Paseo mobile every section is the read-only summary: no write is mounted.
  const settingsScreen = panelHost ? null : (
    <SettingsScreen
      theme={theme}
      warnings={settingsWarnings(view)}
      slots={
        mobile
          ? {
              models: <SettingsReadOnly theme={theme} view={view} section="models" />,
              "skills-tools": <SettingsReadOnly theme={theme} view={view} section="skills-tools" />,
              plugins: <SettingsReadOnly theme={theme} view={view} section="plugins" />,
              vault: <SettingsReadOnly theme={theme} view={view} section="vault" />,
              diagnostics: <SettingsReadOnly theme={theme} view={view} section="diagnostics" />,
            }
          : {
              models: (
                <SeatsPane
                  theme={theme}
                  view={view}
                  modelSyncNote={laneNote}
                  actions={{
                    busy,
                    setLane: (lane: LaneName, value) => {
                      void act("Lane", async () => {
                        const reply = await lanesSetCall({ lane, value });
                        if (reply.ok) setLaneNote(`${lane} → ${reply.lanes[lane]} (${reply.modelSync})`);
                        return reply;
                      });
                    },
                    // One atomic batch RPC for a multi-lane card (v0.0.38, ADR 0026 §5).
                    setLanesBatch: (lanes: LaneName[], value) => {
                      void act("Lane Batch", async () => {
                        const update: Partial<Record<LaneName, string>> = {};
                        for (const lane of lanes) update[lane] = value;
                        const reply = await lanesSetBatchCall({ lanes: update });
                        if (reply.ok) setLaneNote(`${lanes.join(" + ")} → ${value} (${reply.modelSync})`);
                        return reply;
                      });
                    },
                    saveProfile: (name, description) => {
                      void act("Save Profile", () => profilesSaveCall({ name, ...(description === undefined ? {} : { description }), lanes: view.lanes }));
                    },
                    updateProfile: (profileId, name) => {
                      void act("Update Profile", () => profilesSaveCall({ id: profileId, name, lanes: view.lanes }));
                    },
                    applyProfile: (profileId) => {
                      void act("Apply Profile", () => profilesApplyCall({ profileId }));
                    },
                    deleteProfile: (profileId) => {
                      void act("Delete Profile", () => profilesDeleteCall({ profileId }));
                    },
                    // The machine table has no override to reset — the control is a Project-panel act.
                    resetLanes: () => {},
                  }}
                />
              ),
              "skills-tools": (
                <>
                  <PrerequisiteSetupCard
                    theme={theme}
                    tools={incompleteTools}
                    installing={isInstallingPrereqs}
                    elapsedSeconds={elapsedSeconds}
                    busy={busy || activePluginAct !== null}
                    onInstall={installPrerequisites}
                  />
                  <SkillsToolsPane
                    theme={theme}
                    view={view}
                    activeAct={activePluginAct}
                    elapsedSeconds={elapsedSeconds}
                    cardErrors={pluginCardErrors}
                    dismissCardError={(id) => clearPluginCardError(id as ManageablePluginId)}
                    actions={pluginActions}
                  />
                </>
              ),
              plugins: (
                <PluginsPane
                  theme={theme}
                  view={view}
                  activeAct={activePluginAct}
                  elapsedSeconds={elapsedSeconds}
                  pluginsNote={pluginsNote}
                  cardErrors={pluginCardErrors}
                  dismissNote={() => setPluginsNote(null)}
                  dismissCardError={(id) => clearPluginCardError(id as ManageablePluginId)}
                  actions={pluginActions}
                />
              ),
              vault: vaultPane,
              diagnostics: <DiagnosticsBody theme={theme} view={view} serverId={serverId} />,
            }
      }
    />
  );

  return (
    <View
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0 && Math.abs(w - containerWidth) >= 4) setContainerWidth(w);
      }}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: isCompact ? SPACING[3] : SPACING[4],
          paddingBottom: SPACING[6],
          gap: isCompact ? SPACING[3] : SPACING[4],
        }}
      >
        {panelHost ? (() => {
          const holdOnboardingWizard =
            !mobile &&
            onboardingFolder !== null &&
            (!view.panel.isProject ||
              onboardingHoldFolder === onboardingFolder ||
              (onboardingTracker.activeRun !== null && onboardingTracker.openWorkspace.status !== "done"));
          return (
          <ProjectPanel
            theme={theme}
            panel={view.panel}
            holdOnboarding={holdOnboardingWizard}
            modelView={view}
            {...(editorRequest === undefined ? {} : { editorRequest })}
            {...(onEditorRequestHandled === undefined ? {} : { onEditorRequestHandled })}
            width={containerWidth}
            selfUpdate={selfUpdate}
            release={releaseView}
            publishPreflight={publishPreflightView}
            releaseBusy={releaseBusy}
            releaseFeedback={releaseFeedback}
            releaseCopiedLogin={releaseCopiedLogin}
            releaseActions={{
              setMode: (mode) => updateReleaseSettings({ mode }),
              setBranch: (branch) => updateReleaseSettings({ branch }),
              publish: publishProjectRepo,
              openUrl: (url) => { void openExternalUrl(url); },
              copyLoginCommand: copyReleaseLoginCommand,
              checkLogin: async () => {
                if (activeReleaseRoot !== null) await refreshReleaseView(activeReleaseRoot);
              },
            }}
            storeRelease={storeReleaseView}
            storeReleaseBusy={storeReleaseBusy}
            storeReleaseFeedback={storeReleaseFeedback}
            {...(mobile ? {} : { storeReleaseActions: { setMode: updateStoreReleaseMode } })}
            cancellingGateQueueIds={cancellingGateQueueIds}
            gateQueueCancelError={gateQueueCancelError}
            {...(mobile || openReleaseLab === undefined ? {} : { onOpenReleaseLab: openReleaseLab })}
            {...(mobile || openSettings === undefined ? {} : { onOpenSettings: openSettings })}
            onTabChange={setPanelTab}
            skillPacks={view.skillHub?.projectPacks ?? []}
            skillPacksExplicit={view.skillHub?.skillPacksExplicit === true}
            hasProjectLaneOverride={view.hasProjectLaneOverride}
            machineLanes={view.machineLanes}
            mobile={mobile}
            now={now}
            daemonError={view.daemonError}
            actions={{ openAgent, installPrerequisites, handoffStart: startHandoff, handoffReplaceNow: replaceHandoff, handoffCancel: cancelHandoff, handoffRetry: retryHandoff, viewHandover, startSupervisor, syncOpenDesign, adoptSupervisor, saveSeatModel, setMachineDefault, applyProfile: applyProjectProfile, toggleSkillPack: toggleProjectSkillPack, resetSkillPacks: resetProjectSkillPacks, saveProfile: saveProjectProfile, resetProjectLanes, cancelGateQueueItem, manageSkillPacks: () => { if (!mobile) openSettings?.(); }, busy: busy || activePluginAct !== null }}
            openDesignActions={
              !mobile && view.project !== null && view.project.missingRoot !== true ? (
                <>
                  <OpenDesignControl key={`${view.project.root}:card`} part="card" theme={theme} root={view.project.root} sourceKey={`${serverId ?? "local"}:${view.project.root}`} onChanged={refresh} />
                  <OpenDesignControl key={`${view.project.root}:link`} part="menu" theme={theme} root={view.project.root} sourceKey={`${serverId ?? "local"}:${view.project.root}`} onChanged={refresh} />
                </>
              ) : null
            }
            onboarding={
              // Desktop only: the wizard cannot finish on mobile, which shows "set this Project up on Paseo Desktop".
              holdOnboardingWizard ? (
                <OnboardingWizard
                  theme={theme}
                  view={view}
                  folder={onboardingFolder}
                  tracker={onboardingTracker}
                  actions={{
                    inspect: (folder) => onboardingInspectCall({ folder }),
                    installPrerequisites: installPrerequisitesResult,
                    listDesigns: async () => {
                      const reply = await openDesignCatalogCall({});
                      return reply.ok
                        ? { ok: true as const, projects: reply.projects.map((p) => ({ projectId: p.projectId, projectName: p.projectName, screenCount: p.screenCount })) }
                        : { ok: false as const, error: reply.error };
                    },
                    start: startOnboardingRun,
                    status: (input) => onboardingStatusCall(input),
                  }}
                />
              ) : null
            }
            menu={
              !holdOnboardingWizard && view.panel.isProject && view.project !== null ? (
                <ProjectMenu
                  theme={theme}
                  mobile={mobile}
                  busy={busy || activePluginAct !== null}
                  missingRoot={view.project.missingRoot === true}
                  openSettings={() => openSettings?.()}
                  resetProject={resetProject}
                  rotateSeats={rotateSeats}
                  deleteProject={deleteProject}
                />
              ) : null
            }
          />
          );
        })() : (
          settingsScreen
        )}
      </ScrollView>
      <Modal open={handover !== null} onOpenChange={open => { if (!open) setHandover(null); }} title={`Handover · ${handover?.seat ?? ""}`}>
        <Modal.Content>
          <View testID="factory-handover-modal" style={{ gap: SPACING[2], padding: SPACING[3] }}>
            <Text style={text(theme, "rowTitle")}>{handover?.source === "substitute" ? "plugin-built handover" : "Extracted handover"}</Text>
            <ScrollView style={{ maxHeight: 480 }}><Text selectable style={text(theme, "meta")}>{handover?.text}</Text></ScrollView>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
