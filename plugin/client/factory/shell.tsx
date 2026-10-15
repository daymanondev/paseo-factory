/**
 * The one `<FactoryShell />` every Paseo surface entry renders (ADR 0009 §1):
 * global screen, workspace panel, settings screen — one component, three
 * hosts. It owns the snapshot poll and every RPC action (Accept, Run Retro,
 * lanes.set, the Supervisor bridge, task detail); the three panes are pure
 * renders of the view plus action callbacks. Function components only — no
 * class syntax reaches the Hermes bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { accept, lanesSet, retro, snapshot, supervisorEnsure, supervisorRevoke, taskDetail } from "../../shared/rpc.ts";
import type { FactoryView, LaneName, TaskDetailView } from "../../shared/view.ts";
import { Btn, Card, TabBar } from "../kit/pill.tsx";
import type { TabId } from "../kit/pill.tsx";
import { SPACING, text } from "../kit/theme.ts";
import { useNow, usePoll, pollEvery } from "../kit/poll.ts";
import { Header } from "./header.tsx";
import { TasksPane } from "./tasks.tsx";
import { SeatsPane } from "./seats.tsx";
import { TimelinePane } from "./timeline.tsx";

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
  const ensureCall = useRpc(supervisorEnsure);
  const revokeCall = useRpc(supervisorRevoke);
  const detailCall = useRpc(taskDetail);

  const [tab, setTab] = useState<TabId>(initialTab);
  const [bump, setBump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [laneNote, setLaneNote] = useState<string | null>(null);
  const [retroNote, setRetroNote] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const refresh = () => setBump((n) => n + 1);

  const poll = usePoll(
    async () => {
      const r = await snapshotCall({});
      if (!r.ok) return { ok: false as const, code: r.code, error: r.error };
      return { ok: true as const, value: r.view };
    },
    `factory:${dir ?? "global"}:${bump}`,
    (view) => pollEvery((view?.kpis.running ?? 0) + (view?.kpis.needsHuman ?? 0) > 0),
  );
  const view = poll.value;
  const now = useNow(1000);

  const act = async (name: string, run: () => Promise<{ ok: boolean; error?: string | null }>): Promise<boolean> => {
    setBusy(true);
    try {
      const reply = await run();
      if (!reply.ok) {
        toast.error(`${name}: ${reply.error ?? "failed"}`);
        return false;
      }
      return true;
    } catch (error) {
      toast.error(`${name}: ${String(error)}`);
      return false;
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const openSupervisor = (message: string): void => {
    void act("Supervisor", async () => {
      const reply = await ensureCall({ message: message.trim() === "" ? undefined : message.trim() });
      if (!reply.ok) return reply;
      navigation?.openAgent({ agentId: reply.agentId, serverId });
      return reply;
    });
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

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: SPACING[4], paddingBottom: SPACING[6], gap: SPACING[4] }}>
        <Header theme={theme} view={view} at={poll.at} now={now} actions={{ openSupervisor, busy }} supervisorLive={view.supervisor !== null} />
        {showDiagnostics ? (
          <Card theme={theme} gap={SPACING[1]}>
            <Text style={text(theme, "section")}>Daemon & State Diagnostics</Text>
            <Text style={text(theme, "code")}>stateDir: {view.stateDir}</Text>
            <Text style={text(theme, "code")}>serverId: {serverId ?? "local"}</Text>
            <Text style={text(theme, "code")}>daemon: {view.daemonError ?? "healthy"}</Text>
          </Card>
        ) : null}
        <TabBar theme={theme} active={tab} onPick={setTab} />
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
                void act("Revoke Supervisor", () => revokeCall({}));
              },
              setLane: (lane: LaneName, value) => {
                void act("Lane", async () => {
                  const reply = await lanesSetCall({ lane, value });
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
