/**
 * The one `<FactoryShell />` every Paseo surface entry renders (ADR 0009 §1):
 * global screen, workspace panel, settings screen — one component, three
 * hosts. It owns the snapshot poll and every RPC action (Accept, Run Retro,
 * lanes.set, Revoke Supervisor, Rotate Lead, Ratify via Supervisor, task
 * detail); the three panes are pure renders of the view plus action
 * callbacks. The Project scope (v0.0.14, ADR 0010 §1) is the workspace
 * panel's directory when hosted there, else the header's Project Selector
 * pick — the snapshot rides it. Seats start only from Paseo's native New
 * Chat picker (v0.0.27, ADR 0017 §3) — the shell's Open actions are pure
 * navigation jumps to a live seat's conversation.
 * Function components only — no class syntax reaches the Hermes bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { accept, lanesSet, leadRotate, pluginsInstall, pluginsManage, pluginsCheckUpdates, projectReset, ratifyProposal, retro, snapshot, supervisorRevoke, taskDetail, vaultConfigure, vaultHydrate, vaultImport, vaultSync } from "../../shared/rpc.ts";

import type { FactoryView, LaneName, TaskDetailView } from "../../shared/view.ts";
import { Btn, Card, TabBar } from "../kit/pill.tsx";
import type { TabId } from "../kit/pill.tsx";
import { SPACING, text } from "../kit/theme.ts";
import { useNow, usePoll, pollEvery } from "../kit/poll.ts";
import { Header, isVaultActName } from "./header.tsx";
import type { VaultNote } from "./header.tsx";
import { actionFeedback, createResponseOrder } from "./vault-feedback.ts";
import type { VaultStatusView } from "../../shared/view.ts";
import { TasksPane } from "./tasks.tsx";
import { SeatsPane } from "./seats.tsx";
import { TimelinePane } from "./timeline.tsx";
import { PluginsPane } from "./plugins.tsx";
import { isCoreSelfRestartError, resolveCoreRestartWatch } from "./plugin-feedback.ts";
import type { ActivePluginAct, PluginsNote } from "./plugin-feedback.ts";

/** The navigation slice the shell uses — `openAgent` jumps to a session. */
export interface Navigation {
  openAgent(input: { agentId: string; serverId?: string }): void;
}

type DetailState = { task: string; loading: boolean; detail: TaskDetailView | null; error: string | null };

export function FactoryShell({
  theme,
  dir,
  navigation,
  serverId,
  initialTab = "tasks",
  showDiagnostics = false,
}: {
  theme: PluginTheme;
  /** The workspace panel's directory scope; undefined on the global screen. */
  dir?: string;
  navigation?: Navigation;
  serverId?: string;
  initialTab?: TabId;
  showDiagnostics?: boolean;
}) {
  const toast = useToast();
  const snapshotCall = useRpc(snapshot);
  const acceptCall = useRpc(accept);
  const retroCall = useRpc(retro);
  const lanesSetCall = useRpc(lanesSet);
  const revokeCall = useRpc(supervisorRevoke);
  const leadRotateCall = useRpc(leadRotate);
  const projectResetCall = useRpc(projectReset);
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

  const [tab, setTab] = useState<TabId>(initialTab);
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
  const [retroNote, setRetroNote] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  /** The global screen's Project Selector pick — the panel's dir wins when hosted. */
  const [pickedRoot, setPickedRoot] = useState<string | null>(null);
  const lastViewRef = useRef<FactoryView | null>(null);
  const refresh = () => setBump((n) => n + 1);

  // The active Project scope: the workspace panel's directory (auto-bound),
  // else the selector's pick on the global screen.
  const scopeRoot = dir ?? pickedRoot ?? undefined;

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
  const view = poll.value ?? lastViewRef.current;
  const now = useNow(1000);
  const elapsedSeconds = activePluginAct === null ? 0 : Math.max(0, Math.floor((now - activePluginAct.startedAt) / 1000));
  useEffect(() => { if (view !== null) setVaultNote(null); }, [view]);

  // While `paseo-factory` is restarting after a self-update or self-reload, poll
  // `factory.snapshot` every 1s and evaluate `resolveCoreRestartWatch`.
  useEffect(() => {
    if (activePluginAct?.kind !== "restarting-core") return;
    refresh();
  }, [activePluginAct?.kind, now]);

  useEffect(() => {
    if (activePluginAct?.kind !== "restarting-core" || view === null) return;
    const resolution = resolveCoreRestartWatch({
      view,
      previousRevision: activePluginAct.fromRevision ?? null,
      targetRevision: activePluginAct.targetRevision ?? null,
      action: activePluginAct.action === "reload" ? "reload" : "update",
      elapsedMs: Math.max(0, Date.now() - activePluginAct.startedAt),
    });
    if (resolution.status === "waiting") return;
    setActivePluginAct(null);
    setPluginsNote(resolution.note);
    if (resolution.status === "completed") {
      setPluginCardErrors((prev) => {
        if (!("paseo-factory" in prev)) return prev;
        const next = { ...prev };
        delete next["paseo-factory"];
        return next;
      });
      toast.show(resolution.note.text, { variant: "success" });
    } else {
      setPluginCardErrors((prev) => ({ ...prev, "paseo-factory": resolution.note.text }));
      toast.error(resolution.note.text);
    }
  }, [activePluginAct, view, now]);

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

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: SPACING[4], paddingBottom: SPACING[6], gap: SPACING[4] }}>
        <Header
          theme={theme}
          view={view}
          at={poll.at}
          now={now}
          actions={{ openSupervisor, openLead, resetProject, pickProject: (root) => setPickedRoot(root), busy }}

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
        {showDiagnostics ? (
          <Card theme={theme} gap={SPACING[1]}>
            <Text style={text(theme, "section")}>Daemon & State Diagnostics</Text>
            <Text style={text(theme, "code")}>stateDir: {view.stateDir}</Text>
            <Text style={text(theme, "code")}>serverId: {serverId ?? "local"}</Text>
            <Text style={text(theme, "code")}>daemon: {view.daemonError ?? "healthy"}</Text>
            <Text style={text(theme, "code")}>project: {view.project === null ? "(unscoped)" : `${view.project.slug} · ${view.project.root}`}</Text>
          </Card>
        ) : null}
        <TabBar
          theme={theme}
          active={tab}
          onPick={setTab}
          counts={{
            tasks: view.tasks.length,
            seats: view.agents.length,
            timeline: view.retro.length,
            plugins: view.companions.filter((c) => c.status === "running").length,
          }}
        />
        {tab === "tasks" ? (
          <TasksPane
            theme={theme}
            view={view}
            dir={dir}
            actions={{
              busy,
              openDetail,
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
              busy,
              openAgent: (agentId) => navigation?.openAgent({ agentId, serverId }),
              revokeSupervisor: () => {
                void act("Revoke Supervisor", () => revokeCall({ projectRoot }));
              },
              rotateLead: () => {
                if (projectRoot === undefined) return;
                void act("Rotate Lead", () => leadRotateCall({ projectRoot }));
              },
              setLane: (lane: LaneName, value) => {
                void act("Lane", async () => {
                  const reply = await lanesSetCall({ lane, value, projectRoot });
                  if (reply.ok) setLaneNote(`${lane} → ${reply.lanes[lane]} (${reply.modelSync})`);
                  return reply;
                });
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
            dismissCardError={(id) =>
              setPluginCardErrors((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
              })
            }
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
                      setPluginsNote({ text: `Check Updates: ${reply.error}`, tone: "statusDanger", pluginId: "all" });
                    }
                    return reply;
                  } catch (error) {
                    setPluginsNote({ text: `Check Updates: ${String(error)}`, tone: "statusDanger", pluginId: "all" });
                    throw error;
                  } finally {
                    setCheckingUpdates(false);
                    setActivePluginAct(null);
                  }
                });
              },
              install: (target, source, ref) => {
                if (target === "all") {
                  setPluginCardErrors({});
                } else {
                  setPluginCardErrors((prev) => {
                    const next = { ...prev };
                    delete next[target];
                    return next;
                  });
                }
                setActivePluginAct({ kind: "install", target, startedAt: Date.now() });
                void act("Install", async () => {
                  try {
                    const reply = await pluginsInstallCall({ target, source, ref });
                    if (reply.ok) {
                      setPluginsNote({ text: reply.summary, tone: "statusSuccess", pluginId: target });
                    } else {
                      setPluginsNote({ text: `Install: ${reply.error}`, tone: "statusDanger", pluginId: target });
                      if (target !== "all") {
                        setPluginCardErrors((prev) => ({ ...prev, [target]: reply.error }));
                      }
                    }
                    return reply;
                  } catch (error) {
                    const msg = String(error);
                    setPluginsNote({ text: `Install: ${msg}`, tone: "statusDanger", pluginId: target });
                    if (target !== "all") {
                      setPluginCardErrors((prev) => ({ ...prev, [target]: msg }));
                    }
                    throw error;
                  } finally {
                    setActivePluginAct(null);
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
                      ? view.corePlugin.latestRevision
                      : (targetPlugin?.latestRevision ?? null)
                    : action === "reload" && coreTargeted
                      ? view.corePlugin.currentRevision
                      : null;

                if (pluginId === "all") {
                  setPluginCardErrors({});
                } else {
                  setPluginCardErrors((prev) => {
                    const next = { ...prev };
                    delete next[pluginId];
                    return next;
                  });
                }

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
                    const reply = await pluginsManageCall({ pluginId, action });
                    if (!reply.ok) {
                      if (isCoreSelfRestartError({ target: pluginId, action, errorMessage: reply.error, coreTargeted })) {
                        enterCoreRestart();
                        return { ok: true, summary: "" };
                      }
                      setPluginsNote({ text: `${actName}: ${reply.error}`, tone: "statusDanger", pluginId });
                      if (pluginId !== "all") {
                        setPluginCardErrors((prev) => ({ ...prev, [pluginId]: reply.error }));
                      }
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
                    setPluginsNote({ text: `${actName}: ${msg}`, tone: "statusDanger", pluginId });
                    if (pluginId !== "all") {
                      setPluginCardErrors((prev) => ({ ...prev, [pluginId]: msg }));
                    }
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
      <Modal open={detail !== null} onOpenChange={(open) => (open ? undefined : setDetail(null))} title={detail === null ? "" : `${detail.task} — detail`} icon={undefined}>
        <Modal.Content>
          {detail === null || detail.loading ? (
            <Text style={text(theme, "meta")}>Loading…</Text>
          ) : detail.error !== null ? (
            <Text style={text(theme, "label", "statusWarning")}>{detail.error}</Text>
          ) : detail.detail === null ? null : (
            <DetailBody theme={theme} detail={detail.detail} />
          )}
          <View style={{ paddingTop: SPACING[2] }}>
            <Btn theme={theme} small label="Close" tone="foregroundMuted" onPress={() => setDetail(null)} />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function DetailBody({ theme, detail }: { theme: PluginTheme; detail: TaskDetailView }) {
  const contract = detail.contract;
  return (
    <View style={{ gap: SPACING[3] }}>
      <View style={{ gap: 2 }}>
        <Text style={text(theme, "section")}>Contract</Text>
        <Text style={text(theme, "code")}>gate: {contract.gate}</Text>
        <Text style={text(theme, "code")}>artifact: {contract.artifact}</Text>
        <Text style={text(theme, "code")}>scope: {contract.scope === null ? "unrestricted" : contract.scope.join(", ")}</Text>
        <Text style={text(theme, "code")}>skills: {contract.skills === null ? "none mandated" : contract.skills.join(", ")}</Text>
        <Text style={text(theme, "code")}>workspace: {contract.workspace}</Text>
        {contract.description !== null ? <Text style={text(theme, "meta")}>{contract.description}</Text> : null}
        <Text style={text(theme, "label")}>
          watch {contract.watch ? "on" : "off"} · fresh-eyes {contract.freshEyes ? "on" : "off"} · by {contract.by ?? "—"}
        </Text>
      </View>
      {detail.attempts.map((attempt, index) => {
        const view = detail.task.attempts[index]!;
        return (
          <View key={attempt.n} style={{ gap: 2, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: SPACING[2] }}>
            <Text style={text(theme, "rowTitle")}>
              #{attempt.n} {attempt.verdict ?? "—"} {view.respawned ? "↻" : ""}
            </Text>
            {view.note !== null ? <Text style={text(theme, "meta")}>note: {view.note}</Text> : null}
            {view.eye !== null ? <Text style={text(theme, "meta")}>fresh-eyes ({view.eye.model}): {view.eye.outcome} — {view.eye.finding}</Text> : null}
            {view.watch !== null ? (
              <View style={{ gap: 1 }}>
                <Text style={text(theme, "meta")}>watch ({view.watch.model}): {view.watch.outcome}{view.watch.error !== null ? ` — ${view.watch.error}` : ""}</Text>
                {view.watch.answers !== null
                  ? Object.entries(view.watch.answers).map(([name, probability]) => (
                      <Text key={name} style={text(theme, "code")}>
                        {name}: {probability === null ? "—" : probability.toFixed(2)}
                      </Text>
                    ))
                  : null}
              </View>
            ) : null}
            {attempt.report !== null ? (
              <View style={{ gap: 1 }}>
                <Text style={text(theme, "label")}>Report.md</Text>
                <Text style={text(theme, "code")}>{attempt.report}</Text>
              </View>
            ) : null}
            {attempt.gateLog !== null ? (
              <View style={{ gap: 1 }}>
                <Text style={text(theme, "label")}>Gate log</Text>
                <Text style={text(theme, "code")}>{attempt.gateLog}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
