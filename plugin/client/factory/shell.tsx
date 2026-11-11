/**
 * The one `<FactoryShell />` the surface entries render (ADR 0009 §1;
 * v0.6.0 W5, ADR 0056): the workspace panel and the settings screen — one
 * component, two hosts. The workspace panel renders the server-projected
 * Project panel (project-panel.tsx — a pure render of `view.panel`); the
 * Vault / Plugins / Models panes stay reachable beneath it (desktop only)
 * until the Settings screen (W8) relocates them. The panel's actions (v0.6.0
 * W6): Rotate Lead, Revoke Supervisor, Start Supervisor (opens the seat it
 * creates) and the header `⋯` Project menu (per-Project models, skill packs,
 * Open Design link, two-step Reset / Delete) — all RPC wiring lives here; on
 * mobile the menu is view-only and Start / Sync / Studio never mount. The shell owns the snapshot poll and every RPC action (lanes.set,
 * the v0.0.38 batch/profile/reset lane acts — lanes.setBatch, lanes.reset,
 * profiles.save/apply/delete (ADR 0026 §2/§5) — plugins, Vault, Skill Hub);
 * the panes are pure renders of the view plus action callbacks. The Project
 * scope is the workspace panel's directory — the snapshot rides it; there is
 * no Project Switcher. Mobile (the host layout platform is iOS/Android) is a
 * monitor: it renders the panel read-only and mounts no settings writes.
 * Function components only — no class syntax reaches the Hermes bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTab } from "@getpaseo/plugin/client";
import { useRpc, useTabState } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import { skillsImport, skillsTogglePack, lanesReset, lanesSet, lanesSetBatch, leadRotate, helperMcpsSyncAndProbe, helperMcpsSetEnabled, pluginsInstall, pluginsManage, pluginsCheckUpdates, profilesApply, profilesDelete, profilesSave, projectDelete, projectReset, snapshot, supervisorRevoke, supervisorStart, vaultConfigure, vaultHydrate, vaultImport, vaultSync } from "../../shared/rpc.ts";
import type { ManageablePluginId } from "../../shared/companions.ts";
import type { FactoryView, LaneName } from "../../shared/view.ts";
import { Btn, Card, Pill, TabBar } from "../kit/pill.tsx";
import type { TabId } from "../kit/pill.tsx";
import { RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import { useNow, usePoll, pollEvery } from "../kit/poll.ts";
import { OpenDesignControl } from "./open-design.tsx";
import { ProjectPanel } from "./project-panel.tsx";
import { ProjectMenu } from "./project-menu.tsx";
import { VaultPane, isVaultActName } from "./vault.tsx";
import type { VaultNote } from "./vault.tsx";
import { actionFeedback, createResponseOrder } from "./vault-feedback.ts";
import type { VaultStatusView } from "../../shared/view.ts";
import { ProjectModelOverrides, SeatsPane } from "./seats.tsx";
import { PluginsPane } from "./plugins.tsx";
import { isCoreSelfRestartError, resolveCoreRestartWatch } from "./plugin-feedback.ts";
import type { ActivePluginAct, PluginsNote } from "./plugin-feedback.ts";

/** The navigation slice the shell uses — `openAgent` jumps to a session. */
export interface Navigation {
  openAgent(input: { agentId: string; serverId?: string }): void;
}

/** `none` keeps the interim panes collapsed beneath the Project panel. */
const FactoryTabStateSchema = z.object({
  tab: z.enum(["none", "seats", "vault", "plugins"]),
});

export function FactoryShell({
  theme,
  layout,
  dir,
  navigation,
  serverId,
  initialTab,
  showDiagnostics = false,
  surface = "panel",
  panelTab,
}: {
  theme: PluginTheme;
  layout?: { compact: boolean; platform?: "ios" | "android" | "web" };
  /** The workspace panel's directory scope; undefined on the settings screen. */
  dir?: string;
  navigation?: Navigation;
  serverId?: string;
  initialTab?: TabId | "none";
  showDiagnostics?: boolean;
  /** Which entry hosts the shell: the workspace panel (the Project panel) or the settings screen. */
  surface?: "panel" | "settings";
  /** Paseo 0.13 persisted workspace panel tab handle (`useTabState`). */
  panelTab?: PluginTab;
}) {
  const toast = useToast();
  const snapshotCall = useRpc(snapshot);
  const lanesSetCall = useRpc(lanesSet);
  // The panel's seat and Project acts (v0.6.0 W6, ADR 0056): Rotate, Revoke,
  // Start Supervisor (the ADR 0017 amendment — the only seat the plugin may
  // create), Reset and Delete. There is no Lead start and no accept RPC here.
  const leadRotateCall = useRpc(leadRotate);
  const supervisorRevokeCall = useRpc(supervisorRevoke);
  const supervisorStartCall = useRpc(supervisorStart);
  const projectResetCall = useRpc(projectReset);
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
  const pluginsManageCall = useRpc(pluginsManage);
  const pluginsCheckUpdatesCall = useRpc(pluginsCheckUpdates);
  // The Private vault RPCs (v0.0.21–v0.0.22, ADR 0014 §4): one useRpc per
  // contract, every act through act() — the plugins pair's law.
  const vaultConfigureCall = useRpc(vaultConfigure);
  const vaultHydrateCall = useRpc(vaultHydrate);
  const vaultSyncCall = useRpc(vaultSync);
  const vaultImportCall = useRpc(vaultImport);

  const [localTabState, setLocalTabState] = useState<unknown>(undefined);
  const fallbackPluginTab: PluginTab = useMemo(
    () => ({
      state: localTabState,
      setState: (next) => setLocalTabState(next),
      setModified: () => {},
    }),
    [localTabState],
  );
  const [persistedState, setPersistedState] = useTabState(
    panelTab ?? fallbackPluginTab,
    FactoryTabStateSchema,
    { tab: initialTab ?? (surface === "settings" ? "seats" : "none") },
  );
  const tab = persistedState.tab;
  /** Picking the open tab again collapses it. */
  const setTab = (nextTab: TabId): void => {
    setPersistedState({ ...persistedState, tab: nextTab === tab ? "none" : nextTab });
  };

  const [bump, setBump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [busyAct, setBusyAct] = useState<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [autoCheckedPlugins, setAutoCheckedPlugins] = useState(false);
  const [activePluginAct, setActivePluginAct] = useState<ActivePluginAct | null>(null);
  const [pluginsNote, setPluginsNote] = useState<PluginsNote | null>(null);
  const [pluginCardErrors, setPluginCardErrors] = useState<Readonly<Record<string, string>>>({});
  const vaultResponses = useRef(createResponseOrder());
  const [vaultNote, setVaultNote] = useState<VaultNote | null>(null);
  const [laneNote, setLaneNote] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const lastViewRef = useRef<FactoryView | null>(null);
  const refresh = () => setBump((n) => n + 1);

  // The active Project scope: the workspace panel's directory (auto-bound).
  const scopeRoot = dir;
  const isCompact = layout?.compact === true || (containerWidth > 0 && containerWidth < 640);
  const panelHost = surface === "panel";
  /** Paseo mobile: a monitor with quick actions — no settings writes, no desktop-only panes. */
  const mobile = layout?.platform === "ios" || layout?.platform === "android";

  const poll = usePoll(
    async () => {
      const r = await snapshotCall({ projectRoot: scopeRoot });
      if (!r.ok) return { ok: false as const, code: r.code, error: r.error };
      vaultResponses.current.invalidate();
      return { ok: true as const, value: r.view };
    },
    `factory:${scopeRoot ?? "global"}:${bump}`,
    (view) =>
      activePluginAct?.kind === "restarting-core"
        ? 1000
        : pollEvery(
            (view?.kpis.running ?? 0) + (view?.kpis.needsHuman ?? 0) > 0 ||
              (view?.vault.historyImports ?? []).some((item) => item.status === "pending" || item.status === "staged"),
          ),
  );
  if (poll.value !== null) lastViewRef.current = poll.value;
  const serverView = poll.value ?? lastViewRef.current;
  const view = serverView;
  const now = useNow(1000);
  const elapsedSeconds = activePluginAct === null ? 0 : Math.max(0, Math.floor((now - activePluginAct.startedAt) / 1000));
  useEffect(() => { if (view !== null) setVaultNote(null); }, [view]);

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

  // Automatically check for plugin updates once when the Owner opens the Plugins tab
  // if update status has never been checked or is older than 5 minutes (v0.0.25, ADR 0012 §4).
  useEffect(() => {
    if (tab !== "plugins") {
      setAutoCheckedPlugins(false);
      return;
    }
    if (view === null || checkingUpdates || autoCheckedPlugins) return;
    const stale = view.pluginsCheckedAt === null || Date.now() - Date.parse(view.pluginsCheckedAt) > 300_000;
    if (!stale) return;
    setAutoCheckedPlugins(true);
    setCheckingUpdates(true);
    void pluginsCheckUpdatesCall({}).finally(() => {
      setCheckingUpdates(false);
      refresh();
    });
  }, [tab, view?.pluginsCheckedAt, checkingUpdates, autoCheckedPlugins]);

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
  /** A Needs-you item's primary action: a bare navigation jump to the agent's conversation. */
  const openAgent = (agentId: string): void => {
    navigation?.openAgent({ agentId, serverId });
  };
  const rotateLead = (): void => {
    if (projectRoot === undefined) return;
    void act("Rotate Lead", () => leadRotateCall({ projectRoot }));
  };
  const revokeSupervisor = (): void => {
    if (projectRoot === undefined) return;
    void act("Revoke Supervisor", () => supervisorRevokeCall({ projectRoot }));
  };
  /** Start Supervisor on a vacant seat; success opens the conversation it created (desktop only). */
  const startSupervisor = (directive: string): void => {
    if (projectRoot === undefined || mobile) return;
    const trimmed = directive.trim();
    void act("Start Supervisor", async () => {
      const reply = await supervisorStartCall({ projectRoot, ...(trimmed === "" ? {} : { directive: trimmed }) });
      if (reply.ok) navigation?.openAgent({ agentId: reply.agentId, serverId });
      return reply;
    });
  };
  const resetProject = (): void => {
    if (projectRoot === undefined) return;
    void act("Reset Project", () => projectResetCall({ projectRoot }));
  };
  const deleteProject = (): void => {
    const target = view.project;
    if (target === null) return;
    void act("Delete Project", () => projectDeleteCall({ projectRoot: target.root, projectSlug: target.slug, project: target.slug }));
  };
  const incompleteTools = (view.companionTools ?? []).filter((t) => t.status !== "running" || t.error !== null);
  const isInstallingPrereqs = activePluginAct !== null && activePluginAct.kind === "install" && activePluginAct.target === "all";
  /** Installs every required skill & tool — the Needs-you item's action and the Settings banner's button. */
  const installPrerequisites = (): void => {
    clearPluginCardError("all");
    setActivePluginAct({ kind: "install", target: "all", action: "install", startedAt: Date.now() });
    void act("Install Required Skills & Tools", async () => {
      try {
        const reply = await pluginsInstallCall({ target: "all", includeTools: true });
        if (reply.ok) {
          setPluginsNote({ text: reply.summary, tone: "statusSuccess", pluginId: "all" });
        } else {
          recordPluginActFailure("Install Required Skills & Tools", "all", reply.error);
        }
        return reply;
      } finally {
        setActivePluginAct(null);
      }
    });
  };
  /** Settings-type panes: always on the Settings screen; beneath the panel on desktop only (mobile mounts no settings writes). */
  const showPanes = !panelHost || !mobile;
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
        {panelHost ? (
          <ProjectPanel
            theme={theme}
            panel={view.panel}
            mobile={mobile}
            now={now}
            daemonError={view.daemonError}
            actions={{ openAgent, installPrerequisites, rotateLead, revokeSupervisor, startSupervisor, busy: busy || activePluginAct !== null }}
            openDesignActions={
              !mobile && view.project !== null && view.project.missingRoot !== true ? (
                <OpenDesignControl key={view.project.root} part="card" theme={theme} root={view.project.root} sourceKey={`${serverId ?? "local"}:${view.project.root}`} onChanged={refresh} />
              ) : null
            }
            menu={
              view.panel.isProject && view.project !== null ? (
                <ProjectMenu
                  theme={theme}
                  mobile={mobile}
                  busy={busy || activePluginAct !== null}
                  missingRoot={view.project.missingRoot === true}
                  modelsSlot={
                    <ProjectModelOverrides
                      theme={theme}
                      view={view}
                      modelSyncNote={laneNote}
                      readOnly={mobile}
                      actions={{
                        busy,
                        setLane: (lane: LaneName, value) => {
                          if (projectRoot === undefined) return;
                          void act("Lane", async () => {
                            const reply = await lanesSetCall({ lane, value, projectRoot });
                            if (reply.ok) setLaneNote(`${lane} → ${reply.lanes[lane]} (${reply.modelSync})`);
                            return reply;
                          });
                        },
                        resetLanes: () => {
                          if (projectRoot === undefined) return;
                          void act("Reset to Machine Default", () => lanesResetCall({ projectRoot }));
                        },
                      }}
                    />
                  }
                  openDesignSlot={
                    mobile ? null : (
                      <OpenDesignControl key={view.project.root} part="menu" theme={theme} root={view.project.root} sourceKey={`${serverId ?? "local"}:${view.project.root}`} onChanged={refresh} />
                    )
                  }
                  skillPacks={view.skillHub?.projectPacks ?? []}
                  togglePack={(id, enabled) => {
                    if (projectRoot === undefined) return;
                    void act("Project Skill Pack", () => skillsTogglePackCall({ projectRoot, pack: id as "expo" | "firebase" | "zcode-3d" | "science", enabled }));
                  }}
                  resetProject={resetProject}
                  deleteProject={deleteProject}
                />
              ) : null
            }
          />
        ) : null}
        {(() => {
          // The panel's Needs-you list carries the prerequisite item; the
          // banner stays on the Settings screen until W8 moves Skills & Tools.
          if (panelHost) return null;
          if (incompleteTools.length === 0) return null;
          return (
            <Card
              theme={theme}
              gap={SPACING[2]}
              style={{
                borderColor: tint(theme.colors.statusWarning, "88"),
                backgroundColor: tint(theme.colors.statusWarning, "10"),
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
                  <Pill theme={theme} label="PREREQUISITE SETUP GATE" tone="statusWarning" lit />
                  <Text style={text(theme, "rowTitle")}>Required Factory Skills & Tools Setup</Text>
                  <Pill
                    theme={theme}
                    label={`${incompleteTools.length} required component${incompleteTools.length === 1 ? "" : "s"} missing or incomplete`}
                    tone="statusWarning"
                  />
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                  <Btn
                    theme={theme}
                    small
                    solid
                    label={
                      isInstallingPrereqs
                        ? `Installing Prerequisites… (${elapsedSeconds}s)`
                        : "Install Required Skills & Tools"
                    }
                    disabled={busy || activePluginAct !== null}
                    onPress={installPrerequisites}
                  />
                  {tab !== "plugins" ? (
                    <Btn
                      theme={theme}
                      small
                      label="Open Plugins & Version Manager"
                      tone="foregroundMuted"
                      onPress={() => setTab("plugins")}
                    />
                  ) : null}
                </View>
              </View>
              <Text style={text(theme, "meta")}>
                Factory requires these open-source skills and verification tools on this host before running SLP workflows. Click &quot;Install Required Skills &amp; Tools&quot; to install them directly from GitHub and npm, or manage versions in the Plugins tab:
              </Text>
              <View style={{ gap: SPACING[1] }}>
                {incompleteTools.map((tool) => (
                  <View
                    key={tool.id}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: SPACING[1.5],
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      borderRadius: RADIUS.md,
                      backgroundColor: theme.colors.surface0,
                      paddingHorizontal: SPACING[2.5],
                      paddingVertical: SPACING[1.5],
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
                      <Text style={text(theme, "label")}>{tool.title}</Text>
                      <Pill theme={theme} label={tool.canonicalSource} mono />
                      {tool.error !== null ? (
                        <Text style={{ ...text(theme, "meta", "statusDanger"), flexShrink: 1 }}>{tool.error}</Text>
                      ) : (
                        <Pill theme={theme} label="Not Installed" tone="statusWarning" />
                      )}
                    </View>
                  </View>
                ))}
              </View>
            </Card>
          );
        })()}
        {showDiagnostics ? (
          <>
            <Card theme={theme} gap={SPACING[1]}>
              <Text style={text(theme, "section")}>Daemon & State Diagnostics</Text>
              <Text style={text(theme, "code")}>stateDir: {view.stateDir}</Text>
              <Text style={text(theme, "code")}>serverId: {serverId ?? "local"}</Text>
              <Text style={text(theme, "code")}>daemon: {view.daemonError ?? "healthy"}</Text>
              <Text style={text(theme, "code")}>project: {view.project === null ? "(unscoped)" : `${view.project.slug} · ${view.project.root}`}</Text>
            </Card>
            {tab !== "vault" ? vaultPane : null}
          </>
        ) : null}
        {showPanes ? (
          <TabBar
            theme={theme}
            active={tab === "none" ? null : tab}
            onPick={setTab}
            compact={isCompact}
            counts={{
              seats: view.agents.length,
              vault: view.vault.hydratedApps.length,
              plugins: view.companions.filter((c) => c.status === "running").length,
            }}
          />
        ) : null}
        {showPanes && tab === "vault" ? vaultPane : null}
        {showPanes && tab === "seats" ? (
          <SeatsPane
            theme={theme}
            view={view}
            modelSyncNote={laneNote}
            actions={{
              busy,
              setLane: (lane: LaneName, value) => {
                if (projectRoot === undefined) return;
                void act("Lane", async () => {
                  const reply = await lanesSetCall({ lane, value, projectRoot });
                  if (reply.ok) setLaneNote(`${lane} → ${reply.lanes[lane]} (${reply.modelSync})`);
                  return reply;
                });
              },
              // One atomic batch RPC for a multi-lane card (v0.0.38, ADR 0026
              // §5) — the SeatsPane gates it behind the live-seat modal.
              setLanesBatch: (lanes: LaneName[], value) => {
                if (projectRoot === undefined) return;
                void act("Lane Batch", async () => {
                  const update: Partial<Record<LaneName, string>> = {};
                  for (const lane of lanes) update[lane] = value;
                  const reply = await lanesSetBatchCall({ lanes: update, ...(projectRoot === undefined ? {} : { projectRoot }) });
                  if (reply.ok) setLaneNote(`${lanes.join(" + ")} → ${value} (${reply.modelSync})`);
                  return reply;
                });
              },
              saveProfile: (name, description) => {
                if (projectRoot === undefined) return;
                void act("Save Profile", () =>
                  profilesSaveCall({
                    name,
                    ...(description === undefined ? {} : { description }),
                    lanes: view.lanes,
                    ...(projectRoot === undefined ? {} : { projectRoot }),
                  }),
                );
              },
              updateProfile: (profileId, name) => {
                if (projectRoot === undefined) return;
                void act("Update Profile", () =>
                  profilesSaveCall({
                    id: profileId,
                    name,
                    lanes: view.lanes,
                    ...(projectRoot === undefined ? {} : { projectRoot }),
                  }),
                );
              },
              applyProfile: (profileId) => {
                if (projectRoot === undefined) return;
                void act("Apply Profile", () => profilesApplyCall({ profileId, ...(projectRoot === undefined ? {} : { projectRoot }) }));
              },
              deleteProfile: (profileId) => {
                if (projectRoot === undefined) return;
                void act("Delete Profile", () => profilesDeleteCall({ profileId }));
              },
              resetLanes: () => {
                if (projectRoot === undefined) return;
                void act("Reset to Machine Default", () => lanesResetCall({ projectRoot }));
              },
            }}
          />
        ) : null}
        {showPanes && tab === "plugins" ? (
          <PluginsPane
            theme={theme}
            view={view}
            activeAct={activePluginAct}
            elapsedSeconds={elapsedSeconds}
            pluginsNote={pluginsNote}
            cardErrors={pluginCardErrors}
            dismissNote={() => setPluginsNote(null)}
            dismissCardError={(id) => clearPluginCardError(id as ManageablePluginId)}
            actions={{
              busy: busy || activePluginAct !== null,
              checkingUpdates,
              importSkill: id => { void act('Import Skill', () => skillsImportCall({ id })); },
              togglePack: (pack, enabled) => { if (view.project) void act('Project Skill Pack', () => skillsTogglePackCall({ projectRoot: view.project!.root, pack: pack as 'expo' | 'firebase' | 'zcode-3d' | 'science', enabled })); },
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
            }}
          />
        ) : null}
      </ScrollView>

    </View>
  );
}
