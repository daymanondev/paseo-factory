/**
 * Single-tab `Factory overview` screen (`paseo-factory-overview`, ADR 0068) —
 * desktop-only machine-wide observability surface combining:
 * 1. Top `Gate queue` section: active running Gate(s), FIFO queued rows,
 *    paused indicator, and inspect-log modal/action.
 * 2. Bottom `Projects` roster: compact list of all registered Projects with
 *    `FACTORY_PALETTE` seat/Peer badges, `Needs you` alert counts, `latestGate`
 *    state, 1-click workspace/panel jump, and `+ Onboard Project` CTA.
 *
 * Uses `useRpc(overview)` + `useClientSubscription(stateUpdates)` + `usePoll`
 * (never `useWorkspaces` / `useProjects`, since `addScreen` surfaces run
 * without `PluginClientStateProvider`).
 *
 * Function components only — zero `class` syntax reaches the Hermes bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  PluginClientOpenPanelOptions,
  PluginOpenScreenInput,
  PluginScreenProps,
} from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Loading, Modal, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { gateQueueCancel, gateQueuePause, gateQueueResume, overview, stateUpdates } from "../../shared/rpc.ts";
import { useGateQueueCancel } from "./gate-queue-cancel.ts";
import type {
  FactoryOverviewView,
  GateQueueEntryView,
  GateQueueView,
  OverviewLatestGate,
  OverviewProjectEntry,
} from "../../shared/view.ts";
import { sidebarOverviewBadgeStore } from "../kit/directory.ts";
import { Btn, Card, Pill, RoleName, ToneBadge, formatRelativeAgo } from "../kit/pill.tsx";
import { BUSY_MS, QUIET_MS, useNow, usePoll } from "../kit/poll.ts";
import { isSubscriptionLive, useClientSubscription } from "../kit/subscription.ts";
import {
  RADIUS,
  SPACING,
  dispositionColour,
  factoryPalette,
  hoveredOf,
  statusBadgeColour,
  text,
  tint,
} from "../kit/theme.ts";

export const OVERVIEW_SCREEN_ID = "paseo-factory-overview";
const FACTORY_PANEL_ID = "paseo-factory";
const FACTORY_ONBOARD_SCREEN_ID = "paseo-factory-onboard";

/** Formats elapsed or queued wait milliseconds cleanly for Gate queue rows. */
export function formatQueueDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

function latestGatePillProps(
  theme: PluginTheme,
  latest: OverviewLatestGate,
  queuePosition: number | null,
  now: number,
): { label: string; colour: string; dot: boolean } {
  const palette = factoryPalette(theme);
  if (latest.state === "running") {
    return {
      label: `Gate running · ${latest.task} #${latest.attempt}`,
      colour: palette.ok,
      dot: true,
    };
  }
  if (latest.state === "queued") {
    return {
      label: queuePosition !== null ? `Gate #${queuePosition} · ${latest.task}` : `Gate queued · ${latest.task}`,
      colour: palette.wait,
      dot: true,
    };
  }
  if (latest.state === "green") {
    return {
      label: `Gate green · ${latest.task} #${latest.attempt} · ${formatRelativeAgo(latest.ts, now)}`,
      colour: palette.ok,
      dot: false,
    };
  }
  return {
    label: `Gate red · ${latest.task} #${latest.attempt} · ${formatRelativeAgo(latest.ts, now)}`,
    colour: palette.bad,
    dot: false,
  };
}

function GateQueueRow({
  theme,
  entry,
  tickDeltaMs,
  onInspectLog,
  onCancel,
  cancelling = false,
}: {
  theme: PluginTheme;
  entry: GateQueueEntryView;
  tickDeltaMs: number;
  onInspectLog?: (entry: GateQueueEntryView) => void;
  onCancel?: (id: string) => void;
  cancelling?: boolean;
}) {
  const palette = factoryPalette(theme);
  const running = entry.status === "running";
  const durationLabel = running
    ? `Elapsed ${formatQueueDuration((entry.elapsedMs ?? 0) + tickDeltaMs)}`
    : `Wait ${formatQueueDuration(entry.waitMs + tickDeltaMs)}`;
  const aheadHead = entry.ahead[0];
  const behindLabel =
    !running && aheadHead !== undefined
      ? `behind ${aheadHead.projectName} · ${aheadHead.task}${entry.aheadCount > 1 ? ` (+${entry.aheadCount - 1})` : ""}`
      : null;

  return (
    <View
      testID={running ? `factory-overview-gate-running-${entry.id}` : `factory-overview-gate-queued-${entry.id}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: SPACING[2],
        paddingHorizontal: SPACING[2.5],
        paddingVertical: SPACING[2],
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: running ? tint(palette.ok, "66") : theme.colors.border,
        backgroundColor: running ? tint(palette.ok, "10") : theme.colors.surface0,
      }}
    >
      <View style={{ flex: 1, minWidth: 220, gap: SPACING[1] }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <ToneBadge
            theme={theme}
            label={running ? "Running" : `#${entry.position}`}
            colour={running ? palette.ok : palette.wait}
            dot={running}
          />
          <Text style={text(theme, "rowTitle")} numberOfLines={1}>
            {entry.projectName}
          </Text>
          <Text style={text(theme, "code")} numberOfLines={1}>
            {entry.task}
          </Text>
          <Pill theme={theme} label={`Attempt ${entry.attempt}`} mono />
          {entry.mechanical === "lead_verify" ? (
            <ToneBadge theme={theme} label="lead_verify" colour={palette.lead} dot={false} pill={false} />
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
          <Text
            style={{
              ...text(theme, "code"),
              color: running ? palette.ok : theme.colors.foregroundMuted,
              fontVariant: ["tabular-nums"],
            }}
          >
            {durationLabel}
          </Text>
          {behindLabel !== null ? (
            <Text style={text(theme, "meta")} numberOfLines={1}>
              {behindLabel}
            </Text>
          ) : null}
          {entry.projectSlug !== entry.projectName ? (
            <Text style={text(theme, "meta")} numberOfLines={1}>
              {entry.projectSlug}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
        {entry.logPath !== null && onInspectLog !== undefined ? (
          <Btn
            theme={theme}
            small
            variant="secondary"
            icon="FileText"
            testID={`factory-overview-gate-log-${entry.id}`}
            label="Open log"
            onPress={() => onInspectLog(entry)}
          />
        ) : null}
        {onCancel !== undefined ? (
          <Btn
            theme={theme}
            small
            variant="danger"
            icon="X"
            testID={`factory-queue-cancel-${entry.id}`}
            label={cancelling ? "Cancelling..." : "Cancel"}
            disabled={cancelling}
            onPress={() => {
              if (!cancelling) onCancel(entry.id);
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

function OverviewProjectRow({
  theme,
  project,
  now,
  onOpenProject,
}: {
  theme: PluginTheme;
  project: OverviewProjectEntry;
  now: number;
  onOpenProject?: (project: OverviewProjectEntry) => void;
}) {
  const palette = factoryPalette(theme);
  const peers = project.peers;
  const latest =
    project.latestGate === null ? null : latestGatePillProps(theme, project.latestGate, project.gateQueuePosition, now);
  const canOpen = project.workspaceId !== null && onOpenProject !== undefined;

  const content = (
    <View style={{ gap: SPACING[1.5] }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flex: 1, minWidth: 180, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Text style={text(theme, "rowTitle")} numberOfLines={1}>
              {project.name}
            </Text>
            {project.slug !== project.name ? (
              <Text style={text(theme, "meta")} numberOfLines={1}>
                {project.slug}
              </Text>
            ) : null}
          </View>
          <Text style={{ ...text(theme, "code"), color: theme.colors.foregroundMuted }} numberOfLines={1}>
            {project.root}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          {project.needsYouCount > 0 ? (
            <ToneBadge
              theme={theme}
              testID={`factory-overview-project-needs-you-${project.slug}`}
              label={`Needs you · ${project.needsYouCount}`}
              colour={palette.wait}
              dot
            />
          ) : null}
          {project.handoffActive ? (
            <ToneBadge theme={theme} label="Handing off" colour={palette.move} dot />
          ) : null}
          {latest !== null ? (
            <ToneBadge theme={theme} label={latest.label} colour={latest.colour} dot={latest.dot} />
          ) : null}
          {canOpen ? <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} /> : null}
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
          <RoleName theme={theme} role="supervisor" label="Supervisor" />
          <ToneBadge
            theme={theme}
            label={project.supervisor.statusLabel}
            colour={statusBadgeColour(theme, project.supervisor.statusLabel)}
          />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
          <RoleName theme={theme} role="lead" label="Lead" />
          <ToneBadge
            theme={theme}
            label={project.lead.statusLabel}
            colour={statusBadgeColour(theme, project.lead.statusLabel)}
          />
        </View>
        {peers.length > 0 ? (
          peers.map((peer) => (
            <View key={peer.agentId} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
              <RoleName theme={theme} role="peer" label={`Peer · ${peer.task}`} />
              <ToneBadge
                theme={theme}
                label={peer.statusLabel}
                colour={statusBadgeColour(theme, peer.statusLabel)}
              />
              <ToneBadge
                theme={theme}
                label={peer.disposition}
                colour={dispositionColour(theme, peer.disposition)}
                dot={false}
                pill={false}
              />
            </View>
          ))
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
            <RoleName theme={theme} role="peer" label="Peer" />
            <ToneBadge theme={theme} label="none" colour={palette.idle} />
          </View>
        )}
      </View>

      {project.ledgerError ? (
        <Text style={{ ...text(theme, "label"), color: palette.bad }}>
          {project.ledgerError}
        </Text>
      ) : null}
    </View>
  );

  const baseStyle = {
    paddingHorizontal: SPACING[2.5],
    paddingVertical: SPACING[2],
    borderRadius: RADIUS.md,
    borderWidth: 1,
  };

  if (canOpen) {
    return (
      <Pressable
        testID={`factory-overview-project-${project.slug}`}
        accessibilityRole="button"
        accessibilityLabel={`Open ${project.name} workspace`}
        onPress={() => onOpenProject(project)}
        style={(state) => ({
          ...baseStyle,
          borderColor: hoveredOf(state) ? theme.colors.accent : theme.colors.border,
          backgroundColor: state.pressed || hoveredOf(state) ? theme.colors.surface2 : theme.colors.surface0,
        })}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View
      testID={`factory-overview-project-${project.slug}`}
      style={{
        ...baseStyle,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      }}
    >
      {content}
    </View>
  );
}

/**
 * Pure single-view presentation of `Factory overview` (no RPC hooks).
 * Renders the top `Gate queue` section and bottom `Projects` roster cleanly.
 */
export function FactoryOverviewView({
  theme,
  view,
  loading = false,
  error = null,
  tickDeltaMs = 0,
  now = Date.now(),
  onRefresh,
  onOnboardProject,
  onOpenProject,
  onInspectLog,
  onOpenAgent,
  onOpenWorkspace,
  onTogglePause,
  pausePending = false,
  onCancelQueueItem,
  cancellingQueueIds = [],
  queueActionError = null,
}: {
  theme: PluginTheme;
  view: FactoryOverviewView | null;
  loading?: boolean;
  error?: string | null;
  tickDeltaMs?: number;
  now?: number;
  onRefresh?: () => void;
  onOnboardProject?: () => void;
  onOpenProject?: (project: OverviewProjectEntry) => void;
  onInspectLog?: (entry: GateQueueEntryView) => void;
  onOpenAgent?: (agentId: string) => void;
  onOpenWorkspace?: (workspaceId: string) => void;
  onTogglePause?: () => void;
  pausePending?: boolean;
  onCancelQueueItem?: (id: string) => void;
  cancellingQueueIds?: readonly string[];
  queueActionError?: string | null;
}) {
  const palette = factoryPalette(theme);
  const toast = useToast();
  const [inspectedLog, setInspectedLog] = useState<GateQueueEntryView | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);

  const handleInspectLog = (entry: GateQueueEntryView): void => {
    if (onInspectLog !== undefined) {
      onInspectLog(entry);
      return;
    }
    setCopiedPath(false);
    setInspectedLog(entry);
  };

  const handleCopyLogPath = async (logPath: string): Promise<void> => {
    try {
      await copyText(logPath);
      setCopiedPath(true);
      toast.show("Log path copied", { variant: "success" });
    } catch {
      const clip = (
        globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } }
      ).navigator?.clipboard;
      if (typeof clip?.writeText === "function") {
        try {
          await clip.writeText(logPath);
          setCopiedPath(true);
          toast.show("Log path copied", { variant: "success" });
          return;
        } catch {
          // fall through to error toast
        }
      }
      toast.error("Could not copy log path");
    }
  };

  const gateQueue = view?.gateQueue;
  const projects = view?.projects ?? [];
  const runningCount = gateQueue?.running.length ?? 0;
  const queuedCount = gateQueue?.queued.length ?? 0;

  return (
    <View
      testID="factory-overview-screen"
      style={{ padding: SPACING[4], gap: SPACING[4], maxWidth: 960, width: "100%", alignSelf: "center" }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flex: 1, minWidth: 200, gap: SPACING[1] }}>
          <Text accessibilityRole="header" style={text(theme, "detailTitle")}>
            Factory overview
          </Text>
          <Text style={text(theme, "meta")}>
            Machine-wide Gate queue and registered Projects.
          </Text>
        </View>
        {onRefresh !== undefined ? (
          <Btn theme={theme} small variant="ghost" icon="RefreshCw" label="Refresh" onPress={onRefresh} />
        ) : null}
      </View>

      {error !== null ? (
        <View
          testID="factory-overview-error"
          style={{
            padding: SPACING[2.5],
            borderRadius: RADIUS.md,
            borderWidth: 1,
            borderColor: tint(palette.bad, "66"),
            backgroundColor: tint(palette.bad, "12"),
          }}
        >
          <Text style={{ ...text(theme, "label"), color: palette.bad }}>{error}</Text>
        </View>
      ) : null}

      {view?.daemonError ? (
        <View
          testID="factory-overview-daemon-error"
          style={{
            padding: SPACING[2.5],
            borderRadius: RADIUS.md,
            borderWidth: 1,
            borderColor: tint(palette.wait, "66"),
            backgroundColor: tint(palette.wait, "12"),
          }}
        >
          <Text style={{ ...text(theme, "label"), color: palette.wait }}>{view.daemonError}</Text>
        </View>
      ) : null}

      {view === null && loading ? (
        <Loading />
      ) : view !== null && gateQueue !== undefined ? (
        <>
          <Card theme={theme}>
            <View testID="factory-overview-gate-queue" style={{ gap: SPACING[2.5] }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                  <Text style={text(theme, "section")}>Gate queue</Text>
                  {gateQueue.paused ? (
                    <ToneBadge
                      theme={theme}
                      testID="factory-overview-gate-queue-paused"
                      label={gateQueue.pausedAt ? `Paused · ${formatRelativeAgo(gateQueue.pausedAt, now)}` : "Paused"}
                      colour={palette.wait}
                      dot
                    />
                  ) : runningCount === 0 && queuedCount === 0 ? (
                    <Pill theme={theme} label="Idle" />
                  ) : null}
                  {runningCount > 0 ? (
                    <ToneBadge theme={theme} label={`${runningCount} running`} colour={palette.ok} dot />
                  ) : null}
                  {queuedCount > 0 ? (
                    <ToneBadge theme={theme} label={`${queuedCount} queued`} colour={palette.wait} dot={false} />
                  ) : null}
                  {gateQueue.concurrency > 1 ? (
                    <Pill theme={theme} label={`Concurrency · ${gateQueue.concurrency}`} mono />
                  ) : null}
                </View>
                {onTogglePause !== undefined ? (
                  <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                    <Btn
                      theme={theme}
                      small
                      variant={gateQueue.paused ? "primary" : "secondary"}
                      icon={gateQueue.paused ? "Play" : "Pause"}
                      testID="factory-queue-pause-toggle"
                      label={
                        pausePending
                          ? gateQueue.paused
                            ? "Resuming..."
                            : "Pausing..."
                          : gateQueue.paused
                            ? "Resume queue"
                            : "Pause queue"
                      }
                      disabled={pausePending}
                      onPress={() => {
                        if (!pausePending) onTogglePause();
                      }}
                    />
                  </View>
                ) : null}
              </View>

              {queueActionError !== null && queueActionError !== undefined ? (
                <View
                  testID="factory-overview-gate-queue-error"
                  style={{
                    padding: SPACING[2],
                    borderRadius: RADIUS.md,
                    borderWidth: 1,
                    borderColor: tint(palette.bad, "66"),
                    backgroundColor: tint(palette.bad, "12"),
                  }}
                >
                  <Text style={{ ...text(theme, "label"), color: palette.bad }}>{queueActionError}</Text>
                </View>
              ) : null}

              {runningCount === 0 && queuedCount === 0 ? (
                <Text style={text(theme, "meta")}>
                  {gateQueue.paused
                    ? "Gate queue is paused — no Gates are running or queued."
                    : "No Gates running or queued."}
                </Text>
              ) : (
                <View style={{ gap: SPACING[1.5] }}>
                  {gateQueue.running.map((entry) => (
                    <GateQueueRow
                      key={entry.id}
                      theme={theme}
                      entry={entry}
                      tickDeltaMs={tickDeltaMs}
                      onInspectLog={handleInspectLog}
                      {...(onCancelQueueItem === undefined ? {} : { onCancel: onCancelQueueItem, cancelling: cancellingQueueIds.includes(entry.id) })}
                    />
                  ))}
                  {gateQueue.queued.map((entry) => (
                    <GateQueueRow
                      key={entry.id}
                      theme={theme}
                      entry={entry}
                      tickDeltaMs={tickDeltaMs}
                      {...(entry.logPath !== null && entry.logExists ? { onInspectLog: handleInspectLog } : {})}
                      {...(onCancelQueueItem === undefined ? {} : { onCancel: onCancelQueueItem, cancelling: cancellingQueueIds.includes(entry.id) })}
                    />
                  ))}
                </View>
              )}
            </View>
          </Card>

          <Card theme={theme}>
            <View testID="factory-overview-projects-list" style={{ gap: SPACING[2.5] }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
                  <Text style={text(theme, "section")}>Projects</Text>
                  <Pill theme={theme} label={String(projects.length)} mono />
                </View>
                <Btn
                  theme={theme}
                  small
                  variant="primary"
                  icon="FolderPlus"
                  testID="factory-overview-onboard-button"
                  label="+ Onboard Project"
                  onPress={() => onOnboardProject?.()}
                />
              </View>

              {projects.length === 0 ? (
                <Text style={text(theme, "meta")}>
                  No Projects registered yet — click + Onboard Project to set up a repository.
                </Text>
              ) : (
                <View style={{ gap: SPACING[1.5] }}>
                  {projects.map((project) => (
                    <OverviewProjectRow
                      key={project.slug}
                      theme={theme}
                      project={project}
                      now={now}
                      {...(onOpenProject === undefined ? {} : { onOpenProject })}
                    />
                  ))}
                </View>
              )}
            </View>
          </Card>
        </>
      ) : null}

      <Modal
        open={inspectedLog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setInspectedLog(null);
            setCopiedPath(false);
          }
        }}
        title={inspectedLog ? `Gate log · ${inspectedLog.projectName} · ${inspectedLog.task}` : "Gate log"}
      >
        <Modal.Content>
          {inspectedLog !== null ? (
            <View testID="factory-overview-log-modal" style={{ gap: SPACING[2.5] }}>
              <Text style={text(theme, "meta")}>
                {`Attempt ${inspectedLog.attempt} · ${inspectedLog.status === "running" ? "Running" : `Queued #${inspectedLog.position}`}`}
              </Text>
              {inspectedLog.logPath !== null ? (
                <View
                  style={{
                    padding: SPACING[2],
                    borderRadius: RADIUS.md,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface0,
                  }}
                >
                  <Text selectable testID="factory-overview-log-path" style={text(theme, "code")}>
                    {inspectedLog.logPath}
                  </Text>
                </View>
              ) : null}
              {!inspectedLog.logExists ? (
                <Text style={text(theme, "meta")}>Log file has not been written yet.</Text>
              ) : null}
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                {inspectedLog.logPath !== null ? (
                  <Btn
                    theme={theme}
                    small
                    variant="primary"
                    icon="Copy"
                    testID="factory-overview-log-copy"
                    label={copiedPath ? "Copied path" : "Copy log path"}
                    onPress={() => {
                      if (inspectedLog.logPath !== null) void handleCopyLogPath(inspectedLog.logPath);
                    }}
                  />
                ) : null}
                {inspectedLog.agentId && onOpenAgent !== undefined ? (
                  <Btn
                    theme={theme}
                    small
                    variant="secondary"
                    testID="factory-overview-log-open-agent"
                    label="Open Peer"
                    onPress={() => onOpenAgent(inspectedLog.agentId!)}
                  />
                ) : null}
                {inspectedLog.workspaceId !== null && onOpenWorkspace !== undefined ? (
                  <Btn
                    theme={theme}
                    small
                    variant="secondary"
                    testID="factory-overview-log-open-workspace"
                    label="Open Project"
                    onPress={() => onOpenWorkspace(inspectedLog.workspaceId!)}
                  />
                ) : null}
              </View>
            </View>
          ) : null}
        </Modal.Content>
      </Modal>
    </View>
  );
}

export type OverviewScreenProps = PluginScreenProps & {
  openPanel?: (id: string, options: PluginClientOpenPanelOptions) => void;
  openScreen?: (input: PluginOpenScreenInput) => void;
};

/** Live desktop-only `Factory overview` screen container. */
export function OverviewScreen({
  theme,
  host,
  layout,
  navigation,
  openPanel,
  openScreen,
}: OverviewScreenProps) {
  const mobile = layout.platform === "ios" || layout.platform === "android";
  const overviewCall = useRpc(overview);
  const pauseQueueCall = useRpc(gateQueuePause);
  const resumeQueueCall = useRpc(gateQueueResume);
  const cancelQueueCall = useRpc(gateQueueCancel);
  const refreshRef = useRef<() => void>(() => {});
  const lastViewRef = useRef<FactoryOverviewView | null>(null);
  const pollValueRef = useRef<FactoryOverviewView | null>(null);
  const pauseInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const [pausePending, setPausePending] = useState(false);
  const [queueActionError, setQueueActionError] = useState<string | null>(null);
  const [gateQueueOverride, setGateQueueOverride] = useState<{
    gateQueue: GateQueueView;
    basePollValue: FactoryOverviewView | null;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const subscriptionInput = useMemo(() => ({}), []);
  const subscription = useClientSubscription(stateUpdates, subscriptionInput, () => {
    refreshRef.current();
  });
  const subscriptionLive = isSubscriptionLive(subscription);

  const poll = usePoll(
    useCallback(async () => {
      if (mobile) {
        return {
          ok: true as const,
          value: {
            generatedAt: new Date().toISOString(),
            daemonError: null,
            gateQueue: { paused: false, pausedAt: null, concurrency: 1, running: [], queued: [] },
            projects: [],
          },
        };
      }
      const reply = await overviewCall({});
      if (!reply.ok) return { ok: false as const, code: reply.code, error: reply.error };
      const { ok: _ok, ...view } = reply;
      return { ok: true as const, value: view };
    }, [mobile, overviewCall]),
    mobile ? "factory-overview-mobile" : "factory-overview",
    (view) =>
      subscriptionLive
        ? QUIET_MS
        : (view?.gateQueue.running.length ?? 0) + (view?.gateQueue.queued.length ?? 0) > 0 ||
            (view?.projects.some((project) => project.needsYouCount > 0) ?? false)
          ? BUSY_MS
          : QUIET_MS,
    { cadenceKey: `${subscriptionLive}:${mobile}` },
  );
  refreshRef.current = poll.refresh;
  pollValueRef.current = poll.value;

  useEffect(() => {
    if (gateQueueOverride !== null && poll.value !== gateQueueOverride.basePollValue) {
      setGateQueueOverride(null);
    }
  }, [gateQueueOverride, poll.value]);

  const prevSubscriptionStatusRef = useRef(subscription.status);
  useEffect(() => {
    const prev = prevSubscriptionStatusRef.current;
    prevSubscriptionStatusRef.current = subscription.status;
    if (prev !== "live" && subscription.status === "live") {
      poll.refresh();
    }
  }, [subscription.status, poll.refresh]);

  if (poll.value !== null) lastViewRef.current = poll.value;
  const baseView = poll.value ?? lastViewRef.current;
  const view =
    baseView !== null && gateQueueOverride !== null && gateQueueOverride.basePollValue === poll.value
      ? { ...baseView, gateQueue: gateQueueOverride.gateQueue }
      : baseView;

  useEffect(() => {
    if (mobile || view === null) return;
    const current = view;
    sidebarOverviewBadgeStore.setSummary(
      current.projects.map((project) => ({
        slug: project.slug,
        root: project.root,
        workspaceId: project.workspaceId,
        needsYouCount: project.needsYouCount,
        handoffActive: project.handoffActive,
        gateQueueStatus: project.gateQueueStatus,
        gateQueuePosition: project.gateQueuePosition,
        gateQueuePaused: current.gateQueue.paused,
      })),
      {
        paused: current.gateQueue.paused,
        concurrency: current.gateQueue.concurrency,
        runningCount: current.gateQueue.running.length,
        queuedCount: current.gateQueue.queued.length,
      },
    );
  }, [mobile, view]);

  const now = useNow(1000);

  if (mobile) return null;

  const tickDeltaMs = poll.at !== null ? Math.max(0, now - poll.at) : 0;
  const focusHostOption = navigation?.supportsFocusHost === true ? { focusHost: true } : {};

  const handleTogglePause = async (): Promise<void> => {
    if (pauseInFlightRef.current || view === null) return;
    const nextPause = !view.gateQueue.paused;
    pauseInFlightRef.current = true;
    setPausePending(true);
    setQueueActionError(null);
    try {
      const reply = nextPause ? await pauseQueueCall({}) : await resumeQueueCall({});
      if (!mountedRef.current) return;
      if (!reply.ok) {
        setQueueActionError(
          reply.error || (nextPause ? "Could not pause Gate queue." : "Could not resume Gate queue."),
        );
        return;
      }
      setGateQueueOverride({ gateQueue: reply.gateQueue, basePollValue: pollValueRef.current });
      poll.refresh();
    } catch (err) {
      if (!mountedRef.current) return;
      setQueueActionError(err instanceof Error ? err.message : String(err));
    } finally {
      pauseInFlightRef.current = false;
      if (mountedRef.current) setPausePending(false);
    }
  };

  const { cancellingIds, cancelItem: handleCancelQueueItem } = useGateQueueCancel({
    call: (input) => cancelQueueCall(input),
    mountedRef,
    onStart: () => setQueueActionError(null),
    onSuccess: (gateQueue) => {
      setGateQueueOverride({ gateQueue, basePollValue: pollValueRef.current });
      poll.refresh();
    },
    onFailure: (_id, message) => setQueueActionError(message),
  });

  const openWorkspacePanel = (workspaceId: string): void => {
    navigation?.openWorkspace({
      workspaceId,
      ...(host.id ? { serverId: host.id } : {}),
      ...focusHostOption,
    });
    openPanel?.(FACTORY_PANEL_ID, { workspaceId, location: "workspace" });
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <FactoryOverviewView
        theme={theme}
        view={view}
        loading={view === null && poll.error === null}
        error={poll.error?.message ?? null}
        tickDeltaMs={tickDeltaMs}
        now={now}
        onRefresh={poll.refresh}
        onTogglePause={() => {
          void handleTogglePause();
        }}
        pausePending={pausePending}
        onCancelQueueItem={(id) => {
          void handleCancelQueueItem(id);
        }}
        cancellingQueueIds={cancellingIds}
        queueActionError={queueActionError}
        onOnboardProject={() => openScreen?.({ screenId: FACTORY_ONBOARD_SCREEN_ID })}
        onOpenProject={(project) => {
          if (project.workspaceId !== null) openWorkspacePanel(project.workspaceId);
        }}
        onOpenAgent={(agentId) => {
          navigation?.openAgent({
            agentId,
            ...(host.id ? { serverId: host.id } : {}),
            ...focusHostOption,
          });
        }}
        onOpenWorkspace={openWorkspacePanel}
      />
    </ScrollView>
  );
}
