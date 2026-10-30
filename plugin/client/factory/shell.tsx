/**
 * The one `<FactoryShell />` every Paseo surface entry renders (ADR 0009 §1):
 * global screen, workspace panel, settings screen — one component, three
 * hosts. It owns the snapshot poll and every RPC action (Accept, Run Retro,
 * lanes.set, the v0.0.38 batch/profile/reset lane acts — lanes.setBatch,
 * lanes.reset, profiles.save/apply/delete (ADR 0026 §2/§5) — Revoke
 * Supervisor, Rotate Lead, Ratify via Supervisor, task detail); the three
 * panes are pure renders of the view plus action callbacks. The Project
 * scope (v0.0.14, ADR 0010 §1) is the workspace panel's directory when
 * hosted there, else the header's Project Selector pick — the snapshot rides
 * it. Seats start only from Paseo's native New Chat picker (v0.0.27, ADR
 * 0017 §3) — the shell's Open actions are pure navigation jumps to a live
 * seat's conversation.
 * Function components only — no class syntax reaches the Hermes bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTab } from "@getpaseo/plugin/client";
import { useRpc, useTabState } from "@getpaseo/plugin/client";
import { Modal, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import { accept, executionSetMode, scrumCommand, lanesReset, lanesSet, lanesSetBatch, leadRotate, pluginsInstall, pluginsManage, pluginsCheckUpdates, profilesApply, profilesDelete, profilesSave, projectAdd, projectDelete, projectPickFolder, projectReset, ratifyProposal, retro, snapshot, supervisorRevoke, taskDetail, vaultConfigure, vaultHydrate, vaultImport, vaultSync } from "../../shared/rpc.ts";
import type { ManageablePluginId } from "../../shared/companions.ts";
import type { FactoryView, LaneName } from "../../shared/view.ts";
import { Btn, Card, TabBar } from "../kit/pill.tsx";
import type { TabId } from "../kit/pill.tsx";
import { SPACING, text } from "../kit/theme.ts";
import { useNow, usePoll, pollEvery } from "../kit/poll.ts";
import { Header } from "./header.tsx";
import { VaultPane, isVaultActName } from "./vault.tsx";
import type { VaultNote } from "./vault.tsx";
import { actionFeedback, createResponseOrder } from "./vault-feedback.ts";
import type { VaultStatusView } from "../../shared/view.ts";
import { TaskDetailModal, TasksPane } from "./tasks.tsx";
import type { TaskDetailModalState } from "./tasks.tsx";
import { SeatsPane } from "./seats.tsx";
import { TimelinePane } from "./timeline.tsx";
import { PluginsPane } from "./plugins.tsx";
import { isCoreSelfRestartError, resolveCoreRestartWatch } from "./plugin-feedback.ts";
import type { ActivePluginAct, PluginsNote } from "./plugin-feedback.ts";

/** The navigation slice the shell uses — `openAgent` jumps to a session. */
export interface Navigation {
  openAgent(input: { agentId: string; serverId?: string }): void;
}

type DetailState = TaskDetailModalState;

const FactoryTabStateSchema = z.object({
  tab: z.enum(["tasks", "seats", "timeline", "vault", "plugins"]),
  pickedRoot: z.string().nullable(),
  hasPickedScope: z.boolean(),
});

export function FactoryShell({
  theme,
  layout,
  dir,
  navigation,
  serverId,
  initialTab = "tasks",
  showDiagnostics = false,
  panelTab,
}: {
  theme: PluginTheme;
  layout?: { compact: boolean; platform?: "ios" | "android" | "web" };
  /** The workspace panel's directory scope; undefined on the global screen. */
  dir?: string;
  navigation?: Navigation;
  serverId?: string;
  initialTab?: TabId;
  showDiagnostics?: boolean;
  /** Paseo 0.13 persisted workspace panel tab handle (`useTabState`). */
  panelTab?: PluginTab;
}) {
  const toast = useToast();
  const executionSetModeCall = useRpc(executionSetMode);
  const scrumCommandCall = useRpc(scrumCommand);
  const snapshotCall = useRpc(snapshot);
  const acceptCall = useRpc(accept);
  const retroCall = useRpc(retro);
  const lanesSetCall = useRpc(lanesSet);
  // The v0.0.38 lane acts (ADR 0026 §2/§5): one useRpc per contract, every
  // dispatch through act() — the SeatsPane stays a pure render of the view
  // plus action callbacks (the panes' law).
  const lanesSetBatchCall = useRpc(lanesSetBatch);
  const lanesResetCall = useRpc(lanesReset);
  const profilesSaveCall = useRpc(profilesSave);
  const profilesApplyCall = useRpc(profilesApply);
  const profilesDeleteCall = useRpc(profilesDelete);
  const revokeCall = useRpc(supervisorRevoke);
  const leadRotateCall = useRpc(leadRotate);
  const projectResetCall = useRpc(projectReset);
  const projectDeleteCall = useRpc(projectDelete);
  const projectPickFolderCall = useRpc(projectPickFolder);
  const projectAddCall = useRpc(projectAdd);
  const ratifyCall = useRpc(ratifyProposal);

  const detailCall = useRpc(taskDetail);
  const pluginsInstallCall = useRpc(pluginsInstall);
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
    { tab: initialTab, pickedRoot: null, hasPickedScope: false },
  );
  const tab = persistedState.tab;
  const pickedRoot = persistedState.pickedRoot;
  const hasPickedScope = persistedState.hasPickedScope;
  const setTab = (nextTab: TabId): void => {
    setPersistedState({ ...persistedState, tab: nextTab });
  };
  const setPickedScope = (nextRoot: string | null, nextHasPicked = true): void => {
    setPersistedState({ ...persistedState, pickedRoot: nextRoot, hasPickedScope: nextHasPicked });
  };

  const [bump, setBump] = useState(0);
  const [optimisticMode, setOptimisticMode] = useState<{ root: string; scope: string | undefined; mode: "slp" | "scrum"; revision: number } | null>(null);
  const [pendingMode, setPendingMode] = useState<"slp" | "scrum" | null>(null);
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
  const [retroNote, setRetroNote] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const lastViewRef = useRef<FactoryView | null>(null);
  const refresh = () => setBump((n) => n + 1);

  const prevDirRef = useRef<string | undefined>(dir);
  useEffect(() => {
    if (prevDirRef.current !== dir) {
      prevDirRef.current = dir;
      setPickedScope(null, false);
    }
  }, [dir]);

  // The active Project scope: the Owner's explicit Project Switcher pick when
  // made (`hasPickedScope`), else the workspace panel's directory (auto-bound).
  const scopeRoot = hasPickedScope ? (pickedRoot ?? undefined) : (dir ?? pickedRoot ?? undefined);
  const isCompact = layout?.compact === true || (containerWidth > 0 && containerWidth < 640);

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
  const optimistic = optimisticMode && optimisticMode.root === serverView?.project?.root && (serverView.execution?.revision ?? 0) <= optimisticMode.revision ? optimisticMode : null;
  const view = serverView && optimistic && serverView.execution ? {
    ...serverView,
    project: serverView.project ? { ...serverView.project, executionMode: optimistic.mode, activeScrumPhase: null } : null,
    projects: serverView.projects.map(project => project.root === optimistic.root ? { ...project, executionMode: optimistic.mode, activeScrumPhase: null } : project),
    execution: { ...serverView.execution, selectedMode: optimistic.mode },
  } : serverView;
  useEffect(() => {
    if (optimisticMode && (scopeRoot !== optimisticMode.scope || (serverView?.execution?.revision ?? 0) > optimisticMode.revision)) setOptimisticMode(null);
  }, [scopeRoot, serverView?.execution?.revision, optimisticMode]);
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

  const openDetail = (task: string): void => {
    setDetail({ task, loading: true, detail: null, error: null });
    void (async () => {
      const reply = await detailCall({ task });
      setDetail({ task, loading: false, detail: reply.ok ? reply.detail : null, error: reply.ok ? null : reply.error });
    })();
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
  const applyMode = (mode: "slp" | "scrum"): void => {
    setPendingMode(null);
    if (!projectRoot) return;
    setOptimisticMode({ root: projectRoot, scope: scopeRoot, mode, revision: serverView?.execution?.revision ?? 0 });
    void act("Execution mode", () => executionSetModeCall({ mode, projectRoot })).then(ok => { if (!ok) setOptimisticMode(null); });
  };
  const requestMode = (mode: "slp" | "scrum"): void => {
    if (!projectRoot) return;
    const currentMode = view.execution?.selectedMode ?? "slp";
    if (mode === currentMode && !view.execution?.pendingMode) return;
    setPendingMode(mode);
  };
  // The seat jumps (v0.0.27, ADR 0017 §3): a seat starts only from Paseo's
  // native New Chat picker ("Supervisor (Factory)"), and the Supervisor
  // spawns the Lead itself — so Open is a bare navigation to the live seat's
  // conversation, with no ensure-or-dispatch RPC behind it.
  const openSupervisor = (): void => {
    const agentId = view.supervisor?.id;
    if (agentId === undefined) return;
    navigation?.openAgent({ agentId, serverId });
  };
  const openLead = (): void => {
    const agentId = view.lead?.id;
    if (agentId === undefined) return;
    navigation?.openAgent({ agentId, serverId });
  };
  const resetProject = (): void => {
    if (projectRoot === undefined) return;
    void act("Reset Project", () => projectResetCall({ projectRoot }));
  };
  const deleteProject = (target?: { root?: string; slug?: string }): void => {
    const targetRoot = target?.root ?? projectRoot;
    const targetSlug = target?.slug ?? view.project?.slug;
    if (targetRoot === undefined && targetSlug === undefined) return;
    void act("Delete Project", async () => {
      const reply = await projectDeleteCall({
        ...(targetRoot === undefined ? {} : { projectRoot: targetRoot }),
        ...(targetSlug === undefined ? {} : { projectSlug: targetSlug, project: targetSlug }),
      });
      if (reply.ok) {
        setPickedScope(null, true);
        setDetail(null);
      }
      return reply;
    });
  };
  const pickProjectFolder = (): void => {
    void act("Add Project", async () => {
      const reply = await projectPickFolderCall({});
      if (reply.ok && !reply.cancelled && typeof reply.path === "string") {
        setPickedScope(reply.path, true);
        setDetail(null);
      }
      return reply;
    });
  };
  const addProject = (path: string): void => {
    const trimmed = path.trim();
    if (trimmed === "") return;
    void act("Add Project", async () => {
      const reply = await projectAddCall({ projectRoot: trimmed, path: trimmed });
      if (reply.ok) {
        setPickedScope(reply.path, true);
        setDetail(null);
      }
      return reply;
    });
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

  return (
    <View
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0 && Math.abs(w - containerWidth) >= 4) setContainerWidth(w);
      }}
    >
      <Modal open={pendingMode !== null && view.project !== null} onOpenChange={open => { if (!open) setPendingMode(null); }} title="Switch Project execution mode?">
        <Modal.Content>
          <View style={{ gap: SPACING[3] }}>
            <Card
              theme={theme}
              gap={SPACING[1.5]}
              style={{
                borderColor: theme.colors.statusDanger,
                backgroundColor: theme.colors.surface1,
              }}
            >
              <Text style={text(theme, "rowTitle", "statusDanger")}>
                {`Project: ${view.project?.name ?? view.project?.slug ?? ""} (${(view.execution?.selectedMode ?? "slp") === "scrum" ? "Agile Scrum" : "SLP"} → ${pendingMode === "scrum" ? "Agile Scrum" : "SLP"})`}
              </Text>
              <Text style={text(theme, "meta")}>
                The live Supervisor and Lead sessions will be archived. The next turn starts with the new mode's instructions.
              </Text>
              <Text style={text(theme, "label", "statusWarning")}>
                Cảnh báo: Chuyển chế độ thực thi của dự án sẽ lưu trữ (archive) phiên chat Supervisor và Lead hiện tại để tạo phiên mới theo chế độ mới.
              </Text>
            </Card>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: SPACING[2] }}>
              <Btn theme={theme} label="Cancel" tone="foregroundMuted" onPress={() => setPendingMode(null)} />
              <Btn
                theme={theme}
                solid
                icon="AlertTriangle"
                tone="statusDanger"
                label="Archive seats & Switch"
                disabled={busy}
                onPress={() => {
                  if (pendingMode) applyMode(pendingMode);
                }}
              />
            </View>
          </View>
        </Modal.Content>
      </Modal>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: isCompact ? SPACING[3] : SPACING[4],
          paddingBottom: SPACING[6],
          gap: isCompact ? SPACING[3] : SPACING[4],
        }}
      >
        <Header
          theme={theme}
          view={view}
          at={poll.at}
          now={now}
          compact={isCompact}
          actions={{
            setMode: requestMode,
            openSupervisor,
            openLead,
            resetProject,
            deleteProject,
            pickProjectFolder,
            addProject,
            pickProject: (root) => {
              setPickedScope(root, true);
            },
            busy,
          }}
        />
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
        <TabBar
          theme={theme}
          active={tab}
          onPick={setTab}
          compact={isCompact}
          counts={{
            tasks: view.tasks.length,
            seats: view.agents.length,
            timeline: view.retro.length,
            vault: view.vault.hydratedApps.length,
            plugins: view.companions.filter((c) => c.status === "running").length,
          }}
        />
        {tab === "vault" ? vaultPane : null}
        {tab === "tasks" ? (
          <TasksPane
            theme={theme}
            view={view}
            dir={hasPickedScope ? undefined : dir}
            compact={isCompact}
            containerWidth={Math.max(0, containerWidth - (isCompact ? SPACING[3] * 2 : SPACING[4] * 2))}
            actions={{
              busy,
              openDetail,
              openAgent: (agentId) => navigation?.openAgent({ agentId, serverId }),
              pickProject: (root) => {
                setPickedScope(root, true);
              },
              scrum: async (operation, payload, runId, expectedRevision) => {
                if (projectRoot === undefined) {
                  return { ok: false, error: "All projects is view-only — select a project first" };
                }
                const reply = await scrumCommandCall({ operation, payload, runId, expectedRevision, projectRoot, requestId: `ui-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                await act(`Scrum ${operation}`, async () => reply);
                return reply;
              },
              accept: (task, attempt) => {
                void act("Accept", () => acceptCall({ task, attempt }));
              },
            }}
          />
        ) : null}
        {tab === "seats" ? (
          <SeatsPane
            theme={theme}
            view={view}
            modelSyncNote={laneNote}
            actions={{
              setMode: projectRoot ? requestMode : undefined,
              scrum: async (operation, payload, runId, expectedRevision) => {
                if (projectRoot === undefined) {
                  return { ok: false, error: "All projects is view-only — select a project first" };
                }
                const reply = await scrumCommandCall({ operation, payload, runId, expectedRevision, projectRoot, requestId: `ui-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                await act(`Scrum ${operation}`, async () => reply);
                return reply;
              },
              busy,
              openAgent: (agentId) => navigation?.openAgent({ agentId, serverId }),
              revokeSupervisor: () => {
                if (projectRoot === undefined) return;
                void act("Revoke Supervisor", () => revokeCall({ projectRoot }));
              },
              rotateLead: () => {
                if (projectRoot === undefined) return;
                void act("Rotate Lead", () => leadRotateCall({ projectRoot }));
              },
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
        {tab === "timeline" ? (
          <TimelinePane
            theme={theme}
            view={view}
            now={now}
            retroNote={retroNote}
            actions={{
              busy,
              runRetro: () => {
                void act("Retro", async () => {
                  const reply = await retroCall({});
                  if (reply.ok) setRetroNote(reply.outcome === "written" ? `retro written — ${reply.proposalCount ?? 0} proposals → ${reply.proposalsPath ?? "?"}` : `retro failed — ${reply.error ?? "no reason"}`);
                  return reply;
                });
              },
              ratify: (day, proposalId) => {
                if (projectRoot === undefined) return;
                void act("Ratify", async () => {
                  const reply = await ratifyCall({ projectRoot, day, proposalId });
                  if (reply.ok) setRetroNote(reply.summary);
                  return reply;
                });
              },
            }}
          />
        ) : null}
        {tab === "plugins" ? (
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
                const allPlugins = [view.corePlugin, ...view.companions];
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

      {/* The Detail Modal: Contract, per-attempt Report.md, Gate Log, Watch & Eye breakdown. */}
      <TaskDetailModal
        theme={theme}
        detail={detail}
        onClose={() => setDetail(null)}
        onOpenAgent={(agentId) => navigation?.openAgent({ agentId, serverId })}
      />
    </View>
  );
}
