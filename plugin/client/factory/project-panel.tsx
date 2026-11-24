/**
 * The native Factory tab (v0.7.0 W10–11, ADR 0057 §8–9).
 * The server owns seat, lane, profile and progress data; the Shell owns RPCs.
 * Measured width selects the wide columns or the narrow reading order.
 * Inline model/profile/pack controls dispatch through the Shell. Onboarding,
 * adoption and existing handoff/Open Design actions retain their host gates.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { TextStyle } from "react-native";
import type { GitHubPublishPreflightView, PanelGateQueueEntry, PanelNeedsYouItem, PanelOpenDesign, PanelPeerRow, PanelSeatRow, PanelSupervisorCandidateRow, PanelTone, PanelView, Lanes, ReleaseSettingsView, StoreReleaseView } from "../../shared/view.ts";
import { GitHubReleaseCard } from "./github-release-card.tsx";
import type { GitHubReleaseActions, ReleaseCardFeedback } from "./github-release-card.tsx";
import { StoreReleaseCard } from "./store-release-card.tsx";
import type { StoreReleaseActions, StoreReleaseCardFeedback } from "./store-release-card.tsx";
import { AlertRow, Btn, Card, RoleName, SegmentedControl, ToneBadge } from "../kit/pill.tsx";
import { Tabs } from "../kit/tabs.tsx";
import { RADIUS, SPACING, dispositionColour, factoryPalette, hoveredOf, statusBadgeColour, text, thinkingColour, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";
import type { SeatEditorRequest } from "./editor-request.ts";
import { SelfUpdateControls, SelfUpdateNote } from "./self-update.tsx";
import type { SelfUpdateView } from "./self-update.tsx";
import { FactoryTabErrorBoundary } from "./tab-error-boundary.tsx";
import type { MenuSkillPack } from "./project-menu.tsx";
import { LANE_CARDS, LaneModalBody, splitLaneParts } from "./lane-editor.tsx";
import type { LaneMoreAction, LanePickerView } from "./lane-editor.tsx";
import type { ScopedLaneRef } from "../../shared/view.ts";

/** The panel's action surface — the Shell owns the RPC and navigation calls. */
export interface ProjectPanelActions {
  /** Jump to an agent's conversation — a Needs-you item's primary action. */
  openAgent(agentId: string): void;
  /** Install the missing required skills & tools (desktop only — a settings write). */
  installPrerequisites(): void;
  /** Rotate a seat to a fresh session. A host may return the outcome so the modal can stay open on a refusal. */
  handoffStart(seat: string): Promise<boolean> | void;
  handoffReplaceNow(seat: string): void;
  handoffCancel(seat: string): void;
  /** Failed handoff retry is Desktop-only. */
  handoffRetry(seat: string): void;
  viewHandover(seat: string): void;
  /** Start the Supervisor on a vacant seat and open its conversation directly (desktop only). */
  startSupervisor(): void;
  /** Sync the linked Open Design project again from the host — a broken link's primary action (desktop only). */
  syncOpenDesign(): void;
  /** "Use this chat as Supervisor" (v0.6.1, ADR 0057 §5) — adopt a candidate chat; available on mobile (ADR 0057 §10). */
  adoptSupervisor(agentId: string): void;
  /** Every Peer choice requests a handoff; worker choices configure future Peers. */
  saveSeatModel?(seat: string, value: string): Promise<boolean> | void;
  /** Explicit secondary action: writes the machine lane only. */
  setMachineDefault?(seat: string, value: string): Promise<boolean> | void;
  applyProfile?(profileId: string): void;
  toggleSkillPack?(pack: string, enabled: boolean): void;
  saveProfile?(input: { id?: string; name: string; description?: string }): Promise<boolean> | void;
  resetProjectLanes?(): void;
  resetSkillPacks?(): void;
  manageSkillPacks?(): void;
  cancelGateQueueItem?(id: string): void;
  busy: boolean;
}

export type GateQueueCancelError = string | { queueId?: string; message: string };

/**
 * UI-only state a host may seed — what is open and which tab or seat editor is
 * active. Never data. Kept deliberately (review S7): the panel's tests render
 * to static markup, which cannot click a `⋯`, so seeding the initial UI state
 * is the only door to the open-menu render. The live state stays local to the
 * component either way.
 */
export interface ProjectPanelInitialUi {
  menuOpen?: boolean;
  /** Stable targets: supervisor, lead, peer:<task>, worker. */
  editingSeat?: string;
  /** Which tab opens first (default `team`) — static markup cannot click a tab. */
  tab?: ProjectPanelTab;
  /** Pack membership drawers opened initially — useful for static rendering. */
  expandedSkillPacks?: readonly string[];
}

export type ProjectPanelTab = "team" | "models" | "project";
const PANEL_TABS: readonly { id: ProjectPanelTab; label: string }[] = [
  { id: "team", label: "Team" },
  { id: "models", label: "Models" },
  { id: "project", label: "Project" },
];

/** Measured width (px) from which a seat is one grid line and an alert puts its actions beside its title. */
const WIDE = 720;
/** The seat grid's fixed columns; the model chip takes the rest. The status column fits a status pill and Peer disposition badge side by side. */
const COL = { name: 150, status: 164, context: 170 } as const;

/** Items the Owner must resolve themselves are red; items that wait on the Owner's attention are amber. */
const NEEDS_YOU_TONE: Record<PanelNeedsYouItem["kind"], "wait" | "bad"> = {
  "needs-human": "wait",
  "attempt-ceiling": "bad",
  "seat-stuck": "bad",
  "no-supervisor": "bad",
  "supervisor-near-mark": "wait",
  "handoff-failed": "bad",
  "handoff-stuck": "bad",
  prerequisites: "wait",
  "open-design-broken": "bad",
};

/** What mobile says in place of a desktop-only act — a settings write, a seat start or a design sync cannot finish on a phone. */
const DESKTOP_ONLY_HINT: Record<"install-prerequisites" | "start-supervisor" | "sync-open-design", string> = {
  "install-prerequisites": "Install them on Paseo Desktop.",
  "start-supervisor": "Start the Supervisor on Paseo Desktop.",
  "sync-open-design": "Sync the design again on Paseo Desktop.",
};

function toneColour(tone: PanelTone): Colour | undefined {
  return tone === "error" ? "statusDanger" : tone === "waiting" ? "statusWarning" : undefined;
}

/** How long ago an ISO timestamp was, in the panel's own plain words. */
function agoOf(iso: string | null, now: number): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** A Models / Project section's heading: the quiet `badge` caps. */
function SectionTitle({ theme, label }: { theme: PluginTheme; label: string }) {
  return <Text style={{ ...text(theme, "badge"), textTransform: "uppercase" }}>{label}</Text>;
}

/** The one bordered box left: onboarding and the header menu. The tabs use `Section` instead. */
function Block({ theme, testID, children }: { theme: PluginTheme; testID?: string; children: ReactNode }) {
  return (
    <View testID={testID} style={{ gap: SPACING[2], padding: SPACING[3], borderRadius: RADIUS.lg, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: "transparent" }}>
      {children}
    </View>
  );
}

/** A tab section: no card — spacing, and a hairline above every section but the first. */
function Section({ theme, testID, divider = true, children }: { theme: PluginTheme; testID?: string; divider?: boolean; children: ReactNode }) {
  return (
    <View testID={testID} style={{ gap: SPACING[2], ...(divider ? { marginTop: SPACING[4], paddingTop: SPACING[4], borderTopWidth: 1, borderTopColor: theme.colors.border } : {}) }}>
      {children}
    </View>
  );
}

const alertActions = (children: ReactNode) => <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>{children}</View>;

function NeedsYouRow({ theme, item, mobile, wide, actions }: { theme: PluginTheme; item: PanelNeedsYouItem; mobile: boolean; wide: boolean; actions: ProjectPanelActions }) {
  const colour = factoryPalette(theme)[NEEDS_YOU_TONE[item.kind]];
  const action = item.action;
  const buttonId = `factory-panel-needs-you-action-${item.key}`;
  // The item's one action is its primary; mobile swaps a desktop-only act for a hint.
  const primary = (onPress: () => void, gateOnBusy = true) => <Btn theme={theme} small variant="primary" testID={buttonId} label={action.label} disabled={gateOnBusy && actions.busy} onPress={onPress} />;
  const control =
    action.kind === "open-agent" ? primary(() => actions.openAgent(action.agentId), false)
    : action.kind === "handoff-supervisor" ? primary(() => actions.handoffStart("supervisor"))
    : action.kind === "retry-handoff" ? (mobile ? <Text style={text(theme, "meta")}>Try again on Paseo Desktop, or use Replace now below.</Text> : primary(() => actions.handoffRetry(action.seat)))
    : mobile ? <Text testID={`factory-panel-needs-you-hint-${item.key}`} style={text(theme, "meta")}>{DESKTOP_ONLY_HINT[action.kind]}</Text>
    : action.kind === "install-prerequisites" ? primary(actions.installPrerequisites)
    : action.kind === "start-supervisor" ? primary(() => actions.startSupervisor())
    : primary(actions.syncOpenDesign);
  return (
    <AlertRow theme={theme} testID={`factory-panel-needs-you-${item.key}`} colour={colour} title={item.title} wide={wide} actions={alertActions(control)}>
      {item.detail !== null ? <Text style={text(theme, "meta")}>{item.detail}</Text> : null}
    </AlertRow>
  );
}

/** The Handoff block owns a failed handoff it shows; a duplicate Needs-you card would say the same failure twice. A failure with no handoff row (nothing to show it) stays. */
function withoutShownHandoffFailures(items: PanelNeedsYouItem[], handoffs: PanelView["handoffs"]): PanelNeedsYouItem[] {
  return items.filter(({ kind, action }) => !(kind === "handoff-failed" && action.kind === "retry-handoff" && handoffs.some((h) => h.seat === action.seat)));
}

/** No section title: the tone bars say enough; the wrapper keeps its hook. */
function NeedsYou({ theme, items, mobile, wide, actions }: { theme: PluginTheme; items: PanelNeedsYouItem[]; mobile: boolean; wide: boolean; actions: ProjectPanelActions }) {
  if (items.length === 0) return null;
  return (
    <View testID="factory-panel-needs-you" style={{ gap: SPACING[1.5] }}>
      {items.map((item) => (
        <NeedsYouRow key={item.key} theme={theme} item={item} mobile={mobile} wide={wide} actions={actions} />
      ))}
    </View>
  );
}

/** Unknown readings stay explicit; the bar fills against this seat's actual handoff mark. No reading at all (a vacant seat) is a muted dash. */
function ContextBar({ theme, context }: { theme: PluginTheme; context: PanelSeatRow["context"] }) {
  const palette = factoryPalette(theme);
  if (context === null) return <Text style={text(theme, "meta")}>—</Text>;
  if (context.state === "unknown") return <Text style={text(theme, "meta")}>context unknown</Text>;
  const fraction = Math.max(0, Math.min(1, context.usedTokens === null || context.markTokens <= 0 ? 0 : context.usedTokens / context.markTokens));
  const colour = fraction >= 0.9 ? palette.move : fraction >= 0.7 ? palette.wait : palette.ok;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
    <View style={{ width: 80, height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ height: 4, width: `${Math.round(fraction * 100)}%`, backgroundColor: colour }} />
    </View>
    <Text style={text(theme, "meta")} numberOfLines={1}>{context.label}</Text>
  </View>;
}

/** A seat's hairline-separated row: padded, no card. */
const seatRowStyle = (theme: PluginTheme, divider: boolean) => ({ gap: SPACING[1], paddingVertical: SPACING[2.5], borderTopWidth: divider ? 1 : 0, borderTopColor: theme.colors.border });

/**
 * The seat grid. Wide: one line — role, status, model chip, context, actions —
 * on fixed columns so every row aligns. Narrow: role + status + actions, then
 * chip + context beneath.
 */
function SeatLine({ theme, testID, wide, name, status, chip, context, actions }: { theme: PluginTheme; testID: string; wide: boolean; name: ReactNode; status: ReactNode; chip: ReactNode; context: ReactNode; actions: ReactNode }) {
  const actionRow = { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: SPACING[1.5] };
  if (wide) {
    return <View testID={testID} style={{ flexDirection: "row", alignItems: "center", gap: SPACING[3] }}>
      <View style={{ width: COL.name, flexShrink: 0 }}>{name}</View>
      <View style={{ width: COL.status, flexShrink: 0 }}>{status}</View>
      <View style={{ flex: 1, minWidth: 0 }}>{chip}</View>
      <View style={{ width: COL.context, flexShrink: 0 }}>{context}</View>
      <View style={{ ...actionRow, flexShrink: 0, flexWrap: "nowrap" }}>{actions}</View>
    </View>;
  }
  return <View testID={testID} style={{ gap: SPACING[1.5] }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexShrink: 1 }}>{name}{status}</View>
      <View style={actionRow}>{actions}</View>
    </View>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>{chip}{context}</View>
  </View>;
}

/** A seat holds a live session (not vacant, bound to an agent). */
const seatIsLive = (row: PanelSeatRow): boolean => !row.vacant && row.agentId !== null;
/** A standing seat's chip is editable when vacant with no handoff in flight, or when the seat may switch model or hand off. */
const seatChipEditable = (row: PanelSeatRow): boolean => (!seatIsLive(row) && (row.handoff === null || row.handoff.state === "done")) || row.allowedActions.includes("switch-model") || (seatIsLive(row) && row.allowedActions.includes("hand-off-now"));

/** Flags leftover post-turn background processes when an otherwise idle seat or Peer still owns running shells/monitors. */
function IdleBackgroundWork({ theme, seatKey, row }: { theme: PluginTheme; seatKey: string; row: PanelSeatRow | PanelPeerRow }) {
  const count = row.backgroundWorkCount;
  const isIdle = (row.role === "peer" || !row.vacant) && /^idle$/i.test(row.statusLabel.trim());
  if (!isIdle || typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  const processes = Math.trunc(count);
  if (processes <= 0) return null;
  const colour = factoryPalette(theme).wait;
  const label = `${processes} background ${processes === 1 ? "process" : "processes"} running`;
  return (
    <View
      testID={`factory-seat-background-work-${seatKey}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        maxWidth: "100%",
        gap: SPACING[1.5],
        paddingHorizontal: SPACING[2],
        paddingVertical: 2,
        borderRadius: RADIUS.sm,
        borderWidth: 1,
        borderColor: tint(colour, "66"),
        backgroundColor: tint(colour, "18"),
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colour, flexShrink: 0 }} />
      <Text style={{ ...text(theme, "label"), color: colour, flexShrink: 1 }}>{label}</Text>
    </View>
  );
}

function SeatRow({
  theme,
  name,
  row,
  mobile,
  wide,
  divider = true,
  actions,
}: {
  theme: PluginTheme;
  name: string;
  row: PanelSeatRow;
  mobile: boolean;
  wide: boolean;
  divider?: boolean;
  actions: ProjectPanelActions;
}) {
  const colour = toneColour(row.tone);
  const isSupervisor = row.role === "supervisor";
  const live = seatIsLive(row);
  const agentId = row.agentId;
  const handOff = useHandOff(row.role, actions);
  const canHandOff = live && row.allowedActions.includes("hand-off-now");
  return (
    <View testID={`factory-panel-seat-${row.role}`}><View testID={`factory-seat-${row.role}`} style={seatRowStyle(theme, divider)}>
      <SeatLine
        theme={theme}
        testID={`factory-seat-line-${row.role}`}
        wide={wide}
        name={<RoleName theme={theme} role={row.role} label={name} />}
        status={<ToneBadge theme={theme} label={row.statusLabel} colour={statusBadgeColour(theme, row.statusLabel)} testID={`factory-seat-status-${row.role}`} />}
        chip={<SeatModelChip theme={theme} seat={row.role} lane={row.lane} pendingLane={row.pendingLane} live={live} viewHandover={row.allowedActions.includes("view-handover")} editable={seatChipEditable(row)} />}
        context={<ContextBar theme={theme} context={row.context} />}
        actions={<>
          {live && agentId !== null ? <Btn theme={theme} small variant="secondary" testID={`factory-panel-open-${row.role}`} label="Open" onPress={() => actions.openAgent(agentId)} /> : null}
          {canHandOff ? <Btn theme={theme} small variant="secondary" testID={`factory-seat-hand-off-now-${row.role}`} label="Hand off…" disabled={actions.busy} onPress={handOff} /> : null}
          {row.allowedActions.includes("view-handover") ? <Btn theme={theme} small variant="ghost" testID={`factory-seat-view-handover-${row.role}`} label="View handover" disabled={actions.busy} onPress={() => actions.viewHandover(row.role)} /> : null}
        </>}
      />
      <IdleBackgroundWork theme={theme} seatKey={row.role} row={row} />
      {row.hint !== null ? <Text style={text(theme, "meta", colour)}>{row.hint}</Text> : null}
      {row.handoff !== null && row.handoff.state !== "failed" ? <Text style={{ ...text(theme, "meta"), color: row.handoff.state === "done" ? factoryPalette(theme).ok : factoryPalette(theme).move }}>Handoff: {row.handoff.state === "scheduled" ? `Scheduled · waiting for ${row.handoff.waitingPeers ?? 0} Peers` : row.handoff.state}</Text> : null}
      {isSupervisor && row.vacant && !mobile ? (
        <Btn
          theme={theme}
          small
          variant="primary"
          testID="factory-panel-start-supervisor"
          label="Start Supervisor"
          disabled={actions.busy}
          onPress={() => actions.startSupervisor()}
        />
      ) : null}
    </View></View>
  );
}

function teamGateQueueLabel(entry: PanelGateQueueEntry): string {
  if (entry.status === "running") return "Gate · running";
  if (entry.aheadLabel !== null) return `Gate · queued (#${entry.position} behind ${entry.aheadLabel})`;
  if (entry.paused) return `Gate · queued (#${entry.position} · paused)`;
  return `Gate · queued (#${entry.position})`;
}

/** Contextual Gate queue badge on a Team tab Peer row or unmatched Project queue item. */
function TeamGateQueuePill({
  theme,
  entry,
  onCancel,
  cancelling = false,
  error = null,
}: {
  theme: PluginTheme;
  entry: PanelGateQueueEntry;
  onCancel?: (id: string) => void;
  cancelling?: boolean;
  error?: string | null;
}) {
  const palette = factoryPalette(theme);
  const colour = entry.status === "running" ? palette.ok : palette.wait;
  return (
    <View style={{ gap: SPACING[1] }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <ToneBadge
          theme={theme}
          testID="factory-team-gate-queue-pill"
          label={teamGateQueueLabel(entry)}
          colour={colour}
          dot
        />
        {entry.status === "queued" && entry.paused && entry.aheadLabel !== null ? (
          <ToneBadge theme={theme} label="Paused" colour={palette.wait} dot={false} />
        ) : null}
        {entry.mechanical === "lead_verify" ? (
          <ToneBadge theme={theme} label="lead_verify" colour={palette.lead} dot={false} pill={false} />
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
      {error !== null ? (
        <Text testID="factory-team-gate-queue-error" style={{ ...text(theme, "label"), color: palette.bad }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function PeerRowView({
  theme,
  row,
  wide,
  actions,
  cancellingGateQueueIds = [],
  gateQueueCancelError = null,
}: {
  theme: PluginTheme;
  row: PanelPeerRow;
  wide: boolean;
  actions: ProjectPanelActions;
  cancellingGateQueueIds?: readonly string[];
  gateQueueCancelError?: { queueId?: string; message: string } | null;
}) {
  const handOff = useHandOff(`peer:${row.task}`, actions);
  const canHandOff = row.allowedActions.includes("hand-off-now");
  const entry = row.gateQueue ?? null;
  const entryError =
    entry !== null && gateQueueCancelError?.queueId === entry.id ? gateQueueCancelError.message : null;
  return (
    <View testID={`factory-panel-seat-peer-${row.task}`}><View testID={`factory-seat-peer-${row.task}`} style={seatRowStyle(theme, true)}>
      <SeatLine
        theme={theme}
        testID={`factory-seat-line-peer-${row.task}`}
        wide={wide}
        name={<RoleName theme={theme} role="peer" label={row.title} />}
        status={
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
            <ToneBadge theme={theme} label={row.statusLabel} colour={statusBadgeColour(theme, row.statusLabel)} testID={`factory-seat-status-peer-${row.task}`} />
            <ToneBadge theme={theme} label={row.disposition} colour={dispositionColour(theme, row.disposition)} dot={false} pill={false} testID={`factory-peer-disposition-${row.task}`} />
          </View>
        }
        chip={<SeatModelChip theme={theme} seat={`peer-${row.task}`} target={`peer:${row.task}`} lane={row.lane} pendingLane={row.pendingLane} viewHandover={row.allowedActions.includes("view-handover")} editable={row.allowedActions.includes("switch-model") || canHandOff} />}
        context={<ContextBar theme={theme} context={row.context} />}
        actions={<>
          <Btn theme={theme} small variant="secondary" testID={`factory-panel-open-peer-${row.task}`} label="Open" onPress={() => actions.openAgent(row.agentId)} />
          {canHandOff ? <Btn theme={theme} small variant="secondary" testID={`factory-seat-hand-off-now-peer-${row.task}`} label="Hand off…" disabled={actions.busy} onPress={handOff} /> : null}
          {row.allowedActions.includes("view-handover") ? <Btn theme={theme} small variant="ghost" testID={`factory-seat-view-handover-peer-${row.task}`} label="View handover" disabled={actions.busy} onPress={() => actions.viewHandover(`peer:${row.task}`)} /> : null}
        </>}
      />
      {entry !== null ? (
        <TeamGateQueuePill
          theme={theme}
          entry={entry}
          {...(actions.cancelGateQueueItem === undefined ? {} : { onCancel: actions.cancelGateQueueItem })}
          cancelling={cancellingGateQueueIds.includes(entry.id)}
          error={entryError}
        />
      ) : null}
      <IdleBackgroundWork theme={theme} seatKey={`peer-${row.task}`} row={row} />
    </View></View>
  );
}

/**
 * One Supervisor candidate chat (v0.6.1, ADR 0057 §5) — the Owner's way to
 * choose it over the still-live bound Supervisor. Adoption is available on mobile
 * (ADR 0057 §10), so this action never gates on `mobile`.
 */
function SupervisorCandidateRow({ theme, row, actions }: { theme: PluginTheme; row: PanelSupervisorCandidateRow; actions: ProjectPanelActions }) {
  return (
    <View testID="factory-panel-supervisor-candidate" style={{ ...seatRowStyle(theme, true), gap: SPACING[0.5] }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        <Text style={text(theme, "rowTitle")}>{row.title ?? row.agentId}</Text>
        <ToneBadge
          theme={theme}
          colour={statusBadgeColour(theme, row.statusLabel)}
          label={row.statusLabel}
          dot
          testID="factory-seat-status-supervisor-candidate"
        />
      </View>
      {row.model !== null ? <Text style={text(theme, "code", "foregroundMuted")} numberOfLines={1}>{row.model}</Text> : null}
      <Btn
        theme={theme}
        small
        variant="secondary"
        testID="factory-panel-adopt-supervisor"
        label="Use this chat as Supervisor"
        disabled={actions.busy}
        onPress={() => actions.adoptSupervisor(row.agentId)}
      />
    </View>
  );
}

/** A closed Peer is history, not work: hidden behind a toggle so the live ones read at a glance. */
const isClosedPeer = (peer: PanelPeerRow): boolean => /^(closed|archived)$/i.test(peer.statusLabel.trim());

/** Sub-heading above the seat group it names (Supervisor and Lead need none). */
function GroupHeading({ theme, label }: { theme: PluginTheme; label: string }) {
  return <Text style={{ ...text(theme, "badge"), paddingTop: SPACING[3] }}>{label}</Text>;
}

function Seats({
  theme,
  seats,
  gateQueue = [],
  cancellingGateQueueIds = [],
  gateQueueCancelError = null,
  mobile,
  wide,
  actions,
}: {
  theme: PluginTheme;
  seats: NonNullable<PanelView["seats"]>;
  gateQueue?: readonly PanelGateQueueEntry[];
  cancellingGateQueueIds?: readonly string[];
  gateQueueCancelError?: GateQueueCancelError | null;
  mobile: boolean;
  wide: boolean;
  actions: ProjectPanelActions;
}) {
  const palette = factoryPalette(theme);
  const [closedOpen, setClosedOpen] = useState(false);
  const live = seats.peers.filter((peer) => !isClosedPeer(peer));
  const closed = seats.peers.filter(isClosedPeer);
  const shownQueueIds = new Set(
    live.map((peer) => peer.gateQueue?.id).filter((id): id is string => typeof id === "string" && id !== ""),
  );
  const unmatchedQueueEntries = gateQueue.filter((entry) => !shownQueueIds.has(entry.id));
  const normalizedError =
    gateQueueCancelError === null
      ? null
      : typeof gateQueueCancelError === "string"
        ? { message: gateQueueCancelError }
        : gateQueueCancelError;
  const visibleErrorTargetIds = new Set([
    ...shownQueueIds,
    ...unmatchedQueueEntries.map((entry) => entry.id),
    ...(closedOpen
      ? closed.map((peer) => peer.gateQueue?.id).filter((id): id is string => typeof id === "string" && id !== "")
      : []),
  ]);
  const showFallbackError =
    normalizedError !== null &&
    (normalizedError.queueId === undefined || !visibleErrorTargetIds.has(normalizedError.queueId));

  return (
    <View testID="factory-panel-seats">
      <SeatRow theme={theme} name="Supervisor" row={seats.supervisor} mobile={mobile} wide={wide} divider={false} actions={actions} />
      <SeatRow theme={theme} name="Lead" row={seats.lead} mobile={mobile} wide={wide} actions={actions} />
      {showFallbackError ? (
        <Text testID="factory-team-gate-queue-error" style={{ ...text(theme, "label"), color: palette.bad, paddingTop: SPACING[2] }}>
          {normalizedError.message}
        </Text>
      ) : null}
      {unmatchedQueueEntries.length > 0 ? (
        <View testID="factory-panel-gate-queue">
          <GroupHeading theme={theme} label="GATE QUEUE" />
          {unmatchedQueueEntries.map((entry) => (
            <View key={entry.id} style={{ ...seatRowStyle(theme, true), flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
              <Text style={text(theme, "rowTitle")}>{`${entry.task} · Attempt ${entry.attempt}`}</Text>
              <TeamGateQueuePill
                theme={theme}
                entry={entry}
                {...(actions.cancelGateQueueItem === undefined ? {} : { onCancel: actions.cancelGateQueueItem })}
                cancelling={cancellingGateQueueIds.includes(entry.id)}
                error={normalizedError?.queueId === entry.id ? normalizedError.message : null}
              />
            </View>
          ))}
        </View>
      ) : null}
      {seats.peers.length > 0 ? (
        <View testID="factory-panel-peers">
          <GroupHeading theme={theme} label="PEERS" />
          {live.map((peer) => (
            <PeerRowView
              key={peer.agentId}
              theme={theme}
              row={peer}
              wide={wide}
              actions={actions}
              cancellingGateQueueIds={cancellingGateQueueIds}
              gateQueueCancelError={normalizedError}
            />
          ))}
          {closed.length > 0 ? (
            <>
              <View style={{ paddingVertical: SPACING[1.5], borderTopWidth: 1, borderTopColor: theme.colors.border }}>
                <Btn theme={theme} small variant="ghost" testID="factory-panel-peers-closed-toggle" label={`${closedOpen ? "▾" : "▸"} Closed (${closed.length})`} onPress={() => setClosedOpen(!closedOpen)} />
              </View>
              {closedOpen ? (
                <View testID="factory-panel-peers-closed">
                  {closed.map((peer) => (
                    <PeerRowView
                      key={peer.agentId}
                      theme={theme}
                      row={peer}
                      wide={wide}
                      actions={actions}
                      cancellingGateQueueIds={cancellingGateQueueIds}
                      gateQueueCancelError={normalizedError}
                    />
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
      {seats.supervisorCandidates.length > 0 ? (
        <View testID="factory-panel-supervisor-candidates">
          <GroupHeading theme={theme} label="SUPERVISOR CANDIDATES" />
          {seats.supervisorCandidates.map((candidate) => (
            <SupervisorCandidateRow key={candidate.agentId} theme={theme} row={candidate} actions={actions} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The Open Design card: unlinked stays compact; a healthy link names the design
 * and its last sync; a broken link highlights via `AlertRow`. Desktop mounts the
 * Shell's unified actions in `desktopActions`; mobile shows status alone.
 */
function OpenDesign({ theme, openDesign, now, desktopActions }: { theme: PluginTheme; openDesign: PanelOpenDesign; now: number; desktopActions: ReactNode }) {
  const palette = factoryPalette(theme);
  const broken = openDesign.state === "broken";
  const unlinked = openDesign.state === "unlinked";
  const syncLine = openDesign.detail ?? `Synced ${agoOf(openDesign.syncedAt, now)}`;
  return (
    <Card theme={theme} testID="factory-panel-od">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
          <Icon name="Palette" size={14} color={palette.supervisor} />
          <SectionTitle theme={theme} label="Open Design" />
        </View>
        <ToneBadge
          theme={theme}
          label={broken ? "Broken" : unlinked ? "Not linked" : "Linked"}
          colour={broken ? palette.bad : unlinked ? palette.idle : palette.ok}
          dot={!unlinked}
        />
      </View>
      {unlinked ? (
        <Text style={text(theme, "meta")}>Not linked to an Open Design project.</Text>
      ) : broken ? (
        <AlertRow
          theme={theme}
          colour={palette.bad}
          title={`Open Design link is broken${openDesign.projectName === null ? "" : ` · ${openDesign.projectName}`}`}
          wide={false}
        >
          <Text style={text(theme, "meta")}>{syncLine}</Text>
        </AlertRow>
      ) : (
        <View style={{ gap: SPACING[0.5] }}>
          <Text style={text(theme, "rowTitle")}>{openDesign.projectName ?? "Linked design"}</Text>
          <Text style={text(theme, "meta")}>{syncLine}</Text>
        </View>
      )}
      {desktopActions}
    </Card>
  );
}

/**
 * A workspace that is not yet a Project: mobile points at Desktop (the wizard
 * cannot finish there and is never mounted); desktop shows the onboarding
 * wizard the Shell supplies (W7, onboarding-wizard.tsx) under "Set up Factory
 * for this folder".
 */
function NotAProject({ theme, mobile, wizard }: { theme: PluginTheme; mobile: boolean; wizard: ReactNode }) {
  return (
    <Block theme={theme} testID="factory-panel-onboarding">
      {mobile ? (
        <Text style={text(theme, "meta")}>Set this Project up on Paseo Desktop.</Text>
      ) : (
        <View style={{ gap: SPACING[2] }}>
          <Text style={text(theme, "rowTitle")}>Set up Factory for this folder</Text>
          {wizard}
        </View>
      )}
    </Block>
  );
}

interface ChipEditorState {
  modelView?: LanePickerView;
  mobile: boolean;
  actions: ProjectPanelActions;
  editingSeat: string | null;
  edit(seat: string | null): void;
}
const ChipEditorContext = createContext<ChipEditorState | null>(null);

/** What a row's `Hand off…` does: open that seat's modal. A host with no model picker (no `modelView` / `saveSeatModel`) has no modal to open, so it rotates directly. */
function useHandOff(target: string, actions: ProjectPanelActions): () => void {
  const editor = useContext(ChipEditorContext);
  const canOpen = editor?.modelView !== undefined && editor.actions.saveSeatModel !== undefined;
  return () => (canOpen ? editor.edit(target) : void actions.handoffStart(target));
}

/** Display and editing use the same chip, including the vacant standing seats; a row's `Hand off…` opens the same modal. */
export function SeatModelChip({ theme, lane, pendingLane, seat, target = seat, live = seat !== "worker", editable = true, viewHandover = false }: { theme: PluginTheme; lane: ScopedLaneRef; pendingLane: ScopedLaneRef | null; seat: string; target?: string; live?: boolean; editable?: boolean; viewHandover?: boolean }) {
  const editor = useContext(ChipEditorContext);
  const canEdit = editable && editor?.modelView !== undefined && editor.actions.saveSeatModel !== undefined;
  // A quiet pill: no border, a surface fill (surface2 on hover when editable); the model in code type, the thinking word in its ramp colour, the scope muted.
  const body = <>
    <Text style={text(theme, "code")} numberOfLines={1}>{lane.model || lane.provider}{pendingLane === null ? "" : ` → ${pendingLane.model || pendingLane.provider}`}</Text>
    <Text style={{ ...text(theme, "label"), color: thinkingColour(theme, pendingLane?.thinking ?? lane.thinking) }}>{pendingLane?.thinking ?? lane.thinking ?? "off"}</Text>
    <Text style={text(theme, "meta")}>{lane.scope === "project" ? "Project" : "Machine"}</Text>
  </>;
  const style = { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: SPACING[1.5], borderRadius: RADIUS.sm, paddingHorizontal: SPACING[2], paddingVertical: 3, backgroundColor: theme.colors.surface1 };
  const open = canEdit && editor.editingSeat === target;
  // The picker opens in a modal, never inline: an inline picker grew the seat
  // row to hundreds of pixels and pushed the role name out of line. The modal
  // mounts only while open so static-markup hosts need no Modal export.
  return <View style={{ flexShrink: 1, alignSelf: "flex-start" }}>
    {canEdit ? <Pressable testID={`factory-seat-chip-${seat}`} accessibilityRole="button" accessibilityLabel={`Change ${target.startsWith("peer:") ? "Peer" : target} model`} disabled={editor.actions.busy} onPress={() => editor.edit(open ? null : target)} style={(state) => ({ ...style, backgroundColor: hoveredOf(state) || state.pressed ? theme.colors.surface2 : theme.colors.surface1 })}>{body}</Pressable> : <View testID={`factory-seat-chip-${seat}`} style={style}>{body}</View>}
    {open ? (
      <Modal open onOpenChange={(next) => (next ? undefined : editor.edit(null))} title={modalTitleOf(target, live)}>
        {/* scrollable={false}: the picker bounds its own list, so nothing nests a ScrollView inside the host's scroll. */}
        <Modal.Content scrollable={false}>
          <SeatModelEditor theme={theme} lane={lane} target={target} live={live} viewHandover={viewHandover} editor={editor} />
        </Modal.Content>
      </Modal>
    ) : null}
  </View>;
}

/** The seat's name as the modal and its copy say it — `peer:<task>` reads as `Peer · <task>`. */
function seatTitleOf(target: string): string {
  if (target.startsWith("peer:")) return `Peer · ${target.slice(5)}`;
  if (target === "worker") return "Default worker";
  return target.charAt(0).toUpperCase() + target.slice(1);
}

/** One modal for rotate, successor choice and model change: a live seat hands off, a vacant seat or the worker only sets its model. */
function modalTitleOf(target: string, live: boolean): string {
  if (target === "worker") return "Default worker model";
  return live ? `Hand off ${seatTitleOf(target)}` : `${seatTitleOf(target)} model`;
}

/** Uses the same provider/model/thinking picker as Settings and onboarding. */
function SeatModelEditor({ theme, lane, target, live, viewHandover, editor }: { theme: PluginTheme; lane: ScopedLaneRef; target: string; live: boolean; viewHandover: boolean; editor: ChipEditorState }) {
  const role = target.startsWith("peer:") ? "worker" : target;
  const baseCard = LANE_CARDS.find((card) => card.id === role)!;
  const peer = target.startsWith("peer:");
  const standing = live && !peer && target !== "worker";
  const card = peer ? { ...baseCard, title: "Peer", hint: "Choose the model for this Peer's successor." } : baseCard;
  const current = `${lane.provider}/${lane.model}${lane.thinking ? `:${lane.thinking}` : ""}`;
  /** The primary's label tells which act it fires: rotate (value unchanged), in-place switch, or handoff onto another provider/Peer successor. */
  const label = (value: string): string => {
    if (target === "worker") return "Save Default worker";
    if (!live) return `Save ${card.title} model`;
    if (peer) return "Hand off Peer";
    if (value === current) return "Hand off to a fresh session";
    const provider = splitLaneParts(value).provider;
    return provider !== lane.provider ? `Hand off to ${provider || "provider"}` : "Switch model";
  };
  /** Closes on success; a refusal (`false`) keeps the modal open for retry. */
  const closeOnSuccess = (result: Promise<boolean> | void): void => void Promise.resolve(result).then((ok) => { if (ok !== false) editor.edit(null); });
  const save = (value: string, machine: boolean): void => closeOnSuccess(machine ? editor.actions.setMachineDefault?.(target, value) : editor.actions.saveSeatModel?.(target, value));
  // An unchanged live standing seat has nothing to write: confirming rotates it to a fresh session.
  const confirm = (value: string): void => (standing && value === current ? closeOnSuccess(editor.actions.handoffStart(target)) : save(value, false));
  /** One sentence on the act, shown in the picker's `⋯` row. */
  const explain = (value: string): string => {
    const machine = !editor.mobile && editor.actions.setMachineDefault !== undefined ? ` Machine defaults apply to Projects that inherit the ${peer || target === "worker" ? "Default worker" : card.title} model.` : "";
    if (target === "worker") return `Applies to future Peers in this Project. Running Peers keep their model.${machine}`;
    if (!live) return `Sets the ${card.title} model for this Project. The seat starts on this model.${machine}`;
    if (peer) return `The primary action hands this Peer to a successor with the selected model. Keeps its worktree, Contract and Attempts, and leaves the Default worker unchanged.${machine}`;
    if (value === current) return `Starts a fresh ${card.title} session on the same model. The current session writes a handover first.${machine}`;
    return `${splitLaneParts(value).provider === lane.provider ? "Switches this Project's live seat in place and keeps the session." : "Hands this Project's live seat over to a new session with its handover."}${machine}`;
  };
  /** The footer's one-line summary of the act the primary fires. */
  const summary = (value: string): string => {
    if (target === "worker" || !live) return "saves the Project model";
    if (value === current) return "unchanged · fresh session";
    const provider = splitLaneParts(value).provider;
    if (provider === lane.provider) return peer ? "same provider · new session" : "same provider · switch in place";
    return `${lane.provider} → ${provider} · new session`;
  };
  const moreActions: LaneMoreAction[] = [
    ...(!editor.mobile && editor.actions.setMachineDefault !== undefined ? [{ label: "Set as machine default", testID: "factory-chip-editor-machine-default", onPress: (value: string) => save(value, true) }] : []),
    ...(viewHandover ? [{ label: "View last handover", testID: "factory-chip-editor-view-handover", onPress: () => { editor.edit(null); editor.actions.viewHandover(target); } }] : []),
  ];
  return <View testID="factory-chip-editor" style={{ alignSelf: "stretch", flex: 1, minHeight: 0 }}>
    <LaneModalBody fill theme={theme} view={editor.modelView!} card={card} currentValue={current} busy={editor.actions.busy} onSave={confirm} onClose={() => editor.edit(null)} primaryLabel={label} primaryTestID="factory-chip-editor-primary"
      explanation={explain} summary={summary} moreActions={moreActions} />
  </View>;
}

/** Independent progress also includes failed handoffs whose outgoing Peer no longer exists. One alert row per handoff, toned by its own state. */
export function HandoffBlock({ theme, handoffs, mobile, wide = false, actions }: { theme: PluginTheme; handoffs: PanelView["handoffs"]; mobile: boolean; wide?: boolean; actions: ProjectPanelActions }) {
  if (handoffs.length === 0) return null;
  const palette = factoryPalette(theme);
  const stateLabel = { scheduled: "Scheduled", "handing-over": "Handing over", "creating-successor": "Creating successor", done: "Done", substitute: "Substitute handover", failed: "Failed" };
  return <View testID="factory-handoff-block" style={{ gap: SPACING[1.5] }}>
    {handoffs.map((handoff) => {
      const failed = handoff.state === "failed";
      const colour = failed ? palette.bad : handoff.state === "done" ? palette.ok : palette.move;
      const seatName = handoff.seat.startsWith("peer:") ? `Peer · ${handoff.seat.slice(5)}` : handoff.seat === "supervisor" ? "Supervisor" : "Lead";
      // A failed handoff's primary act is Try again (desktop only): primary and first. Other states keep the old order, all secondary.
      const retry = !mobile && handoff.allowedActions.includes("retry") ? <Btn theme={theme} small variant={failed ? "primary" : "secondary"} testID="factory-handoff-retry" label="Try again" disabled={actions.busy} onPress={() => actions.handoffRetry(handoff.seat)} /> : null;
      const controls = <>
        {failed ? retry : null}
        {handoff.allowedActions.includes("cancel") ? <Btn theme={theme} small variant="secondary" testID="factory-handoff-cancel" label="Cancel" disabled={actions.busy} onPress={() => actions.handoffCancel(handoff.seat)} /> : null}
        {handoff.allowedActions.includes("hand-off-now") ? <Btn theme={theme} small variant="secondary" testID="factory-handoff-now" label="Hand off now" disabled={actions.busy} onPress={() => actions.handoffStart(handoff.seat)} /> : null}
        {handoff.allowedActions.includes("replace-now") ? <Btn theme={theme} small variant="secondary" testID="factory-handoff-replace-now" label="Replace now" disabled={actions.busy} onPress={() => actions.handoffReplaceNow(handoff.seat)} /> : null}
        {failed ? null : retry}
        {handoff.allowedActions.includes("view-handover") ? <Btn theme={theme} small variant="secondary" testID="factory-handoff-view" label="View handover" disabled={actions.busy} onPress={() => actions.viewHandover(handoff.seat)} /> : null}
      </>;
      return <AlertRow key={handoff.seat} theme={theme} testID={`factory-handoff-${handoff.seat}`} colour={colour} title={`${seatName} · ${stateLabel[handoff.state]}`} wide={wide} actions={alertActions(controls)}>
        <Text style={text(theme, "meta")}>{`${handoff.reason === "context-mark" ? "Context mark" : handoff.reason === "provider-change" ? "Provider change" : "Owner requested"} · ${handoff.fromLane.provider}/${handoff.fromLane.model} → ${handoff.toLane.provider}/${handoff.toLane.model}${handoff.handover === "substitute" ? " · plugin-built handover" : ""}`}</Text>
        {handoff.state !== "scheduled" ? null : <Text style={text(theme, "meta")}>Scheduled · waiting for {handoff.waitingPeers ?? 0} Peers</Text>}
        {handoff.failure === undefined ? null : <Text testID={`factory-handoff-error-${handoff.seat}`} style={{ ...text(theme, "meta"), color: palette.bad }}>{handoff.failure}</Text>}
        {/* Retry is Desktop-only; the deduped Needs-you card used to carry this hint on mobile. */}
        {mobile && handoff.allowedActions.includes("retry") ? <Text testID={`factory-handoff-retry-hint-${handoff.seat}`} style={text(theme, "meta")}>Try again on Paseo Desktop{handoff.allowedActions.includes("replace-now") ? ", or use Replace now." : "."}</Text> : null}
      </AlertRow>;
    })}
  </View>;
}

/** A tiny on/off switch: a 34×20 track and a knob, accent (or `activeColour`) when on. Mobile never mounts it (the badge stands in). */
function Switch({ theme, testID, label, checked, disabled, onToggle, activeColour }: { theme: PluginTheme; testID: string; label: string; checked: boolean; disabled: boolean; onToggle: () => void; activeColour?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onToggle}
      style={{ width: 34, height: 20, borderRadius: 10, padding: 2, justifyContent: "center", alignItems: checked ? "flex-end" : "flex-start", backgroundColor: checked ? (activeColour ?? theme.colors.accent) : theme.colors.surface2, opacity: disabled ? 0.5 : 1 }}
    >
      <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: theme.colors.surface0 }} />
    </Pressable>
  );
}

const CORE_SKILLS = ["tdd", "diagnosing-bugs", "code-review", "codebase-design", "domain-modeling", "research"] as const;
const PACK_KIND_LABELS: Record<NonNullable<MenuSkillPack["kind"]>, string> = { builtin: "Built-in", source: "Source", custom: "Custom" };

function SkillTags({ theme, skills }: { theme: PluginTheme; skills: readonly string[] }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1] }}>
      {skills.map((skill) => (
        <View
          key={skill}
          style={{
            paddingHorizontal: SPACING[1.5],
            paddingVertical: 2,
            borderRadius: RADIUS.sm,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface0,
          }}
        >
          <Text style={text(theme, "code")}>{skill}</Text>
        </View>
      ))}
    </View>
  );
}

export function SkillPacks({ theme, packs, onToggle, onReset, onManage, explicit = false, busy = false, initiallyExpanded = [], divider: _divider = false }: { theme: PluginTheme; packs: readonly MenuSkillPack[]; onToggle?: (pack: string, enabled: boolean) => void; onReset?: () => void; onManage?: () => void; explicit?: boolean; busy?: boolean; initiallyExpanded?: readonly string[]; divider?: boolean }) {
  const palette = factoryPalette(theme);
  const [expanded, setExpanded] = useState<readonly string[]>(initiallyExpanded);
  const activePacks = packs.filter((pack) => pack.enabled);
  const inactivePacks = packs.filter((pack) => !pack.enabled);
  const [inactiveOpen, setInactiveOpen] = useState<boolean>(() => inactivePacks.some((pack) => initiallyExpanded.includes(pack.id)));
  const enabledCount = activePacks.length;
  const coreExpanded = expanded.includes("core");
  const toggleExpanded = (id: string) => {
    setExpanded((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const renderPackRow = (pack: MenuSkillPack) => {
    const isExpanded = expanded.includes(pack.id);
    return (
      <View key={pack.id} testID={`factory-panel-skill-${pack.id}`} style={{ gap: SPACING[1.5], paddingVertical: SPACING[2], borderTopWidth: 1, borderTopColor: theme.colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
          <Pressable
            testID={`factory-skill-pack-expand-${pack.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${isExpanded ? "Collapse" : "Expand"} ${pack.label} skills`}
            accessibilityState={{ expanded: isExpanded }}
            onPress={() => toggleExpanded(pack.id)}
            style={(state) => ({
              flex: 1,
              minWidth: 0,
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: SPACING[1.5],
              borderRadius: RADIUS.sm,
              paddingVertical: 2,
              backgroundColor: hoveredOf(state) || state.pressed ? theme.colors.surface2 : "transparent",
            })}
          >
            <Text style={text(theme, "label")}>{isExpanded ? "▾" : "▸"}</Text>
            <Text style={text(theme, "rowTitle")}>{pack.label}</Text>
            <Text style={text(theme, "meta")}>
              {`${pack.installedCount ?? "?"} installed`}
              {pack.kind === undefined ? "" : ` · ${PACK_KIND_LABELS[pack.kind]}`}
            </Text>
            {pack.autoDetected ? <ToneBadge theme={theme} label="Auto-detected" colour={palette.peer} dot={false} pill={false} /> : null}
          </Pressable>
          {onToggle === undefined ? (
            <ToneBadge theme={theme} label={pack.enabled ? "On" : "Off"} colour={pack.enabled ? palette.ok : palette.idle} dot={false} />
          ) : (
            <Switch theme={theme} activeColour={palette.ok} testID={`factory-skill-pack-${pack.id}`} label={`${pack.enabled ? "Disable" : "Enable"} ${pack.label}`} checked={pack.enabled} disabled={busy} onToggle={() => onToggle(pack.id, !pack.enabled)} />
          )}
        </View>
        {isExpanded ? (
          <View testID={`factory-skill-pack-skills-${pack.id}`} style={{ gap: SPACING[1.5] }}>
            {pack.description ? <Text style={text(theme, "meta")}>{pack.description}</Text> : null}
            {pack.skills === undefined ? (
              <Text style={text(theme, "meta")}>Skill membership unavailable.</Text>
            ) : pack.skills.length === 0 ? (
              <Text style={text(theme, "meta")}>No skills in this pack.</Text>
            ) : (
              <SkillTags theme={theme} skills={pack.skills} />
            )}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <Card theme={theme} testID="factory-skill-packs" gap={SPACING[2]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
          <SectionTitle theme={theme} label="Skill packs" />
          <ToneBadge theme={theme} label={enabledCount > 0 ? `Core + ${enabledCount} active` : "Core only"} colour={palette.peer} dot={false} />
        </View>
        {(explicit && onReset) || onManage ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
            {explicit && onReset ? <Btn theme={theme} small variant="ghost" testID="factory-skill-packs-reset" label="Reset" disabled={busy} onPress={onReset} /> : null}
            {onManage ? <Btn theme={theme} small variant="ghost" testID="factory-skill-packs-manage" label="Settings ↗" onPress={onManage} /> : null}
          </View>
        ) : null}
      </View>
      <View>
        <View style={{ paddingVertical: SPACING[1.5], gap: SPACING[1.5] }}>
          <Pressable
            testID="factory-skill-pack-expand-core"
            accessibilityRole="button"
            accessibilityLabel={`${coreExpanded ? "Collapse" : "Expand"} Core skills`}
            accessibilityState={{ expanded: coreExpanded }}
            onPress={() => toggleExpanded("core")}
            style={(state) => ({
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: SPACING[1.5],
              borderRadius: RADIUS.sm,
              paddingVertical: 2,
              backgroundColor: hoveredOf(state) || state.pressed ? theme.colors.surface2 : "transparent",
            })}
          >
            <Text style={text(theme, "label")}>{coreExpanded ? "▾" : "▸"}</Text>
            <Text style={text(theme, "rowTitle")}>Core</Text>
            <ToneBadge theme={theme} label="Always on" colour={palette.peer} dot={false} />
          </Pressable>
          {coreExpanded ? (
            <View testID="factory-skill-pack-skills-core" style={{ gap: SPACING[1.5] }}>
              <Text style={text(theme, "meta")}>Every Peer keeps the Core skills.</Text>
              <SkillTags theme={theme} skills={CORE_SKILLS} />
            </View>
          ) : null}
        </View>
        {packs.length === 0 ? (
          <Text style={text(theme, "meta")}>No skill packs available.</Text>
        ) : (
          <>
            {activePacks.map(renderPackRow)}
            {inactivePacks.length > 0 ? (
              <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: SPACING[1.5], gap: SPACING[1.5] }}>
                <Btn
                  theme={theme}
                  small
                  variant="ghost"
                  testID="factory-skill-packs-inactive-toggle"
                  label={`${inactiveOpen ? "▾" : "▸"} Inactive packs (${inactivePacks.length})`}
                  onPress={() => setInactiveOpen(!inactiveOpen)}
                />
                {inactiveOpen ? <View>{inactivePacks.map(renderPackRow)}</View> : null}
              </View>
            ) : null}
          </>
        )}
      </View>
    </Card>
  );
}

/** One Models-tab row: role name, the seat's chip (opens the modal), and where the value comes from. */
function ModelRow({ theme, testID, role, name, scope, divider, children }: { theme: PluginTheme; testID?: string; role: "supervisor" | "lead" | "peer"; name: string; scope: ScopedLaneRef["scope"]; divider: boolean; children: ReactNode }) {
  return (
    <View testID={testID} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[3], paddingVertical: SPACING[2.5], borderTopWidth: divider ? 1 : 0, borderTopColor: theme.colors.border }}>
      <View style={{ width: COL.name, flexShrink: 0 }}>
        <RoleName theme={theme} role={role} label={name} />
      </View>
      {children}
      <Text style={text(theme, "meta")}>{scope === "project" ? "Project override" : "Machine default"}</Text>
    </View>
  );
}

/** Compact lifetime Project token count; the server owns totals and breakdown shares. */
function formatTokenCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

type UsageWindowKey = "all" | "7d" | "24h";
type UsageBreakdownMode = "seat" | "model";
type UsageView = NonNullable<PanelView["usage"]>;
type UsageSeatRow = UsageView["seats"][number];
type UsageModelRow = UsageView["models"][number];
type UsageRowMetrics = {
  newTokens: number;
  cachedTokens: number;
  sessionCount: number;
  sharePercent: number;
  cacheHitPercent?: number | null | undefined;
};

const USAGE_WINDOW_OPTIONS: readonly { value: UsageWindowKey; label: string }[] = [
  { value: "all", label: "All" },
  { value: "7d", label: "7d" },
  { value: "24h", label: "24h" },
];

const USAGE_MODE_OPTIONS: readonly { value: UsageBreakdownMode; label: string }[] = [
  { value: "seat", label: "By Seat" },
  { value: "model", label: "By Model" },
];

const USAGE_COL = { new: 72, cache: 72, hit: 56, ses: 44 } as const;

function cacheHitColour(theme: PluginTheme, hit: number | null | undefined): string {
  const palette = factoryPalette(theme);
  if (hit == null || !Number.isFinite(hit)) return palette.idle;
  if (hit >= 90) return palette.ok;
  if (hit >= 70) return palette.wait;
  return palette.bad;
}

function formatCacheHit(hit: number | null | undefined): string {
  return hit == null || !Number.isFinite(hit) ? "–" : `${Math.round(hit)}%`;
}

function splitUsageModelLabel(model: string): { base: string; thinking: string | null } {
  const match = model.match(/^(.+?)(?:-|:)(low|medium|high|max|xhigh)$/i);
  if (match === null) return { base: model, thinking: null };
  return { base: match[1]!, thinking: match[2]!.toLowerCase() };
}

function seatColourOf(theme: PluginTheme, seat: string): string {
  const palette = factoryPalette(theme);
  if (seat === "supervisor") return palette.supervisor;
  if (seat === "lead") return palette.lead;
  if (seat === "agent") return palette.peer;
  return palette.idle;
}

function UsageShareBar({
  trackColour,
  fillColour,
  sharePercent,
  width = 56,
}: {
  trackColour: string;
  fillColour: string;
  sharePercent: number;
  width?: number;
}) {
  const pct = Math.max(2, Math.min(100, Math.round(Number.isFinite(sharePercent) ? sharePercent : 0)));
  return (
    <View style={{ width, height: 3, borderRadius: 2, backgroundColor: trackColour, overflow: "hidden", flexShrink: 0 }}>
      <View style={{ width: `${pct}%`, height: 3, backgroundColor: fillColour }} />
    </View>
  );
}

function UsageTableHeader({ theme, wide }: { theme: PluginTheme; wide: boolean }) {
  if (!wide) return null;
  const colStyle = (w: number): TextStyle => ({
    ...text(theme, "badge"),
    width: w,
    flexShrink: 0,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  });
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], paddingHorizontal: SPACING[1], paddingBottom: SPACING[1], borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <View style={{ flex: 1, minWidth: 0 }} />
      <Text style={colStyle(USAGE_COL.new)}>New</Text>
      <Text style={colStyle(USAGE_COL.cache)}>Cache</Text>
      <Text style={colStyle(USAGE_COL.hit)}>Hit</Text>
      <Text style={colStyle(USAGE_COL.ses)}>Ses</Text>
    </View>
  );
}

function UsageRowContent({
  theme,
  wide,
  row,
  trackColour,
  fillColour,
  identity,
}: {
  theme: PluginTheme;
  wide: boolean;
  row: UsageRowMetrics;
  trackColour: string;
  fillColour: string;
  identity: ReactNode;
}) {
  const hit = row.cacheHitPercent ?? null;
  const hitText = formatCacheHit(hit);
  const hitColour = cacheHitColour(theme, hit);
  if (wide) {
    const numStyle = (w: number, muted = false): TextStyle => ({
      ...text(theme, "code", muted ? "foregroundMuted" : undefined),
      width: w,
      flexShrink: 0,
      textAlign: "right",
      fontVariant: ["tabular-nums"],
    });
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2] }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
          {identity}
          <UsageShareBar trackColour={trackColour} fillColour={fillColour} sharePercent={row.sharePercent} />
        </View>
        <Text style={numStyle(USAGE_COL.new)} numberOfLines={1}>{formatTokenCount(row.newTokens)}</Text>
        <Text style={numStyle(USAGE_COL.cache, true)} numberOfLines={1}>{formatTokenCount(row.cachedTokens)}</Text>
        <Text style={{ ...numStyle(USAGE_COL.hit), color: hitColour, fontWeight: "600" }} numberOfLines={1}>{hitText}</Text>
        <Text style={numStyle(USAGE_COL.ses, true)} numberOfLines={1}>{String(row.sessionCount)}</Text>
      </View>
    );
  }
  return (
    <View style={{ gap: SPACING[1] }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
        {identity}
        <UsageShareBar trackColour={trackColour} fillColour={fillColour} sharePercent={row.sharePercent} />
      </View>
      <Text style={{ ...text(theme, "code", "foregroundMuted"), fontVariant: ["tabular-nums"] }}>
        {`${formatTokenCount(row.newTokens)} new · ${formatTokenCount(row.cachedTokens)} cache · `}
        <Text style={{ color: hitColour, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{`${hitText} hit`}</Text>
        {` · ${row.sessionCount} ses`}
      </Text>
    </View>
  );
}

function UsageModelIdentity({ theme, provider, model }: { theme: PluginTheme; provider: string; model: string }) {
  const { base, thinking } = splitUsageModelLabel(model);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flex: 1, minWidth: 0 }}>
      <Text style={{ ...text(theme, "code"), flexShrink: 1 }} numberOfLines={1}>
        {provider ? <Text style={text(theme, "code", "foregroundMuted")}>{`${provider}/`}</Text> : null}
        {base}
      </Text>
      {thinking !== null ? (
        <ToneBadge theme={theme} label={thinking} colour={thinkingColour(theme, thinking)} dot={false} />
      ) : null}
    </View>
  );
}

function UsageSeatIdentity({
  theme,
  row,
  hasModels,
  expanded,
}: {
  theme: PluginTheme;
  row: UsageSeatRow;
  hasModels: boolean;
  expanded: boolean;
}) {
  const palette = factoryPalette(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flex: 1, minWidth: 0 }}>
      <View style={{ width: 12, alignItems: "center", flexShrink: 0 }}>
        {hasModels ? <Text style={text(theme, "label")}>{expanded ? "▾" : "▸"}</Text> : null}
      </View>
      {row.seat === "supervisor" || row.seat === "lead" || row.seat === "agent" ? (
        <RoleName theme={theme} role={row.seat === "agent" ? "peer" : row.seat} label={row.label} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexShrink: 1 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: palette.idle, flexShrink: 0 }} />
          <Text style={{ ...text(theme, "rowTitle", "foregroundMuted"), flexShrink: 1 }} numberOfLines={1}>
            {row.label}
          </Text>
        </View>
      )}
    </View>
  );
}

function ProjectUsageSeatsView({
  theme,
  seats,
  wide,
  expandedSeats,
  onToggleSeat,
}: {
  theme: PluginTheme;
  seats: readonly UsageSeatRow[];
  wide: boolean;
  expandedSeats: readonly string[];
  onToggleSeat: (seat: string) => void;
}) {
  if (seats.length === 0) {
    return (
      <View testID="project-usage-seats">
        <Text style={text(theme, "meta")}>No seat usage in this window.</Text>
      </View>
    );
  }
  return (
    <View testID="project-usage-seats" style={{ gap: SPACING[1] }}>
      <UsageTableHeader theme={theme} wide={wide} />
      {seats.map((row, index) => {
        const seatColour = seatColourOf(theme, row.seat);
        const seatModels = row.models ?? [];
        const hasModels = seatModels.length > 0;
        const isSeatExpanded = hasModels && expandedSeats.includes(row.seat);
        const content = (
          <UsageRowContent
            theme={theme}
            wide={wide}
            row={row}
            trackColour={tint(seatColour, "22")}
            fillColour={tint(seatColour, "aa")}
            identity={<UsageSeatIdentity theme={theme} row={row} hasModels={hasModels} expanded={isSeatExpanded} />}
          />
        );
        return (
          <View
            key={row.seat}
            style={{
              borderTopWidth: index > 0 ? 1 : 0,
              borderTopColor: theme.colors.border,
              paddingTop: index > 0 ? SPACING[1] : 0,
              gap: SPACING[1],
            }}
          >
            <View testID="project-usage-seat-row">
              {hasModels ? (
                <Pressable
                  testID={`project-usage-seat-toggle-${row.seat}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${isSeatExpanded ? "Collapse" : "Expand"} ${row.label} models`}
                  accessibilityState={{ expanded: isSeatExpanded }}
                  onPress={() => onToggleSeat(row.seat)}
                  style={(state) => ({
                    borderRadius: RADIUS.sm,
                    paddingVertical: SPACING[1],
                    paddingHorizontal: SPACING[1],
                    backgroundColor: hoveredOf(state) || state.pressed ? theme.colors.surface2 : "transparent",
                  })}
                >
                  {content}
                </Pressable>
              ) : (
                <View style={{ paddingVertical: SPACING[1], paddingHorizontal: SPACING[1] }}>{content}</View>
              )}
            </View>
            {isSeatExpanded ? (
              <View testID={`project-usage-seat-models-${row.seat}`} style={{ paddingLeft: SPACING[4], gap: SPACING[1] }}>
                {seatModels.map((modelRow) => (
                  <View
                    key={`${modelRow.provider}/${modelRow.model}`}
                    testID="project-usage-model-row"
                    style={{ paddingVertical: 2, paddingHorizontal: SPACING[1] }}
                  >
                    <UsageRowContent
                      theme={theme}
                      wide={wide}
                      row={modelRow}
                      trackColour={tint(seatColour, "1a")}
                      fillColour={tint(seatColour, "88")}
                      identity={<UsageModelIdentity theme={theme} provider={modelRow.provider} model={modelRow.model} />}
                    />
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function ProjectUsageModelsView({
  theme,
  models,
  wide,
}: {
  theme: PluginTheme;
  models: readonly UsageModelRow[];
  wide: boolean;
}) {
  const palette = factoryPalette(theme);
  if (models.length === 0) {
    return (
      <View testID="project-usage-models">
        <Text style={text(theme, "meta")}>No model usage in this window.</Text>
      </View>
    );
  }
  return (
    <View testID="project-usage-models" style={{ gap: SPACING[1] }}>
      <UsageTableHeader theme={theme} wide={wide} />
      {models.map((row, index) => (
        <View
          key={`${row.provider}/${row.model}`}
          testID="project-usage-model-row"
          style={{
            borderTopWidth: index > 0 ? 1 : 0,
            borderTopColor: theme.colors.border,
            paddingTop: index > 0 ? SPACING[1.5] : SPACING[0.5],
            paddingBottom: SPACING[0.5],
            paddingHorizontal: SPACING[1],
          }}
        >
          <UsageRowContent
            theme={theme}
            wide={wide}
            row={row}
            trackColour={tint(palette.lead, "22")}
            fillColour={tint(palette.lead, "aa")}
            identity={<UsageModelIdentity theme={theme} provider={row.provider} model={row.model} />}
          />
        </View>
      ))}
    </View>
  );
}

function ProjectUsage({
  theme,
  usage,
  mobile,
  wide,
}: {
  theme: PluginTheme;
  usage: UsageView;
  mobile: boolean;
  wide: boolean;
}) {
  const palette = factoryPalette(theme);
  const [windowKey, setWindowKey] = useState<UsageWindowKey>("all");
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<UsageBreakdownMode>("seat");
  const [expandedSeats, setExpandedSeats] = useState<string[]>(["agent"]);

  if (usage.state === "empty") {
    return (
      <Card theme={theme} testID="project-usage-card">
        <SectionTitle theme={theme} label="Project usage" />
        <Text testID="project-usage-empty" style={text(theme, "meta")}>
          No usage recorded yet
        </Text>
      </Card>
    );
  }

  const active = usage.windows?.[windowKey] ?? usage;
  const toggleSeat = (seat: string) => {
    setExpandedSeats((current) =>
      current.includes(seat) ? current.filter((item) => item !== seat) : [...current, seat],
    );
  };
  const kpiTiles = [
    {
      label: "New tokens",
      value: formatTokenCount(active.newTokens),
      sub: `${formatTokenCount(active.inputUncachedTokens)} in · ${formatTokenCount(active.outputTokens)} out`,
    },
    {
      label: "Cache hit",
      value: formatCacheHit(active.cacheHitPercent),
      valueColour: cacheHitColour(theme, active.cacheHitPercent),
      sub: `${formatTokenCount(active.cachedTokens)} cached`,
    },
    {
      label: "Total",
      value: formatTokenCount(active.totalTokens),
      sub: "tokens",
    },
    {
      label: "Sessions",
      value: String(active.sessionCount),
      sub: active.sessionCount === 1 ? "session" : "sessions",
    },
  ];

  return (
    <Card theme={theme} testID="project-usage-card">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <SectionTitle theme={theme} label="Project usage" />
        {usage.windows !== undefined || (!mobile && active.state !== "empty") ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
            {usage.windows !== undefined ? (
              <SegmentedControl
                theme={theme}
                size="sm"
                accentColour={palette.lead}
                testID="project-usage-window"
                value={windowKey}
                onChange={setWindowKey}
                options={USAGE_WINDOW_OPTIONS}
              />
            ) : null}
            {!mobile && active.state !== "empty" ? (
              <Btn
                theme={theme}
                small
                variant="ghost"
                testID="project-usage-toggle"
                label={`${expanded ? "▾" : "▸"} Breakdown`}
                onPress={() => setExpanded(!expanded)}
              />
            ) : null}
          </View>
        ) : null}
      </View>
      {active.state === "empty" ? (
        <Text testID="project-usage-window-empty" style={text(theme, "meta")}>
          {`No active sessions in the last ${windowKey}`}
        </Text>
      ) : (
        <>
          <View testID="project-usage-summary" style={{ flexDirection: "row", flexWrap: wide ? "nowrap" : "wrap", gap: SPACING[2] }}>
            {kpiTiles.map((tile) => (
              <View
                key={tile.label}
                style={{
                  ...(wide ? { flex: 1, minWidth: 0 } : { flexBasis: "47%" as const, flexGrow: 1, minWidth: 0 }),
                  backgroundColor: theme.colors.surface0,
                  borderRadius: RADIUS.md,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  padding: SPACING[2],
                  gap: SPACING[0.5],
                }}
              >
                <Text style={text(theme, "badge")}>{tile.label}</Text>
                <Text
                  style={{
                    ...text(theme, "stat"),
                    fontVariant: ["tabular-nums"],
                    ...(tile.valueColour === undefined ? {} : { color: tile.valueColour }),
                  }}
                  numberOfLines={1}
                >
                  {tile.value}
                </Text>
                <Text style={{ ...text(theme, "meta"), fontVariant: ["tabular-nums"] }}>{tile.sub}</Text>
              </View>
            ))}
          </View>
          {windowKey !== "all" ? (
            <Text testID="project-usage-window-note" style={text(theme, "meta")}>
              {`Sessions active in last ${windowKey} — multi-day seats show full session totals`}
            </Text>
          ) : null}
          {!mobile && expanded ? (
            <View testID="project-usage-breakdown" style={{ gap: SPACING[2.5] }}>
              <SegmentedControl
                theme={theme}
                size="sm"
                accentColour={palette.lead}
                testID="project-usage-mode"
                value={mode}
                onChange={setMode}
                options={USAGE_MODE_OPTIONS}
              />
              {mode === "seat" ? (
                <ProjectUsageSeatsView
                  theme={theme}
                  seats={active.seats}
                  wide={wide}
                  expandedSeats={expandedSeats}
                  onToggleSeat={toggleSeat}
                />
              ) : (
                <ProjectUsageModelsView theme={theme} models={active.models} wide={wide} />
              )}
            </View>
          ) : null}
        </>
      )}
    </Card>
  );
}

/** Seat models (Supervisor, Lead, Default worker), then the Lane profile. Every chip opens the same modal as the Team tab. */
function ModelsTab({ theme, panel, mobile, actions, modelView, machineLanes, hasProjectLaneOverride }: { theme: PluginTheme; panel: PanelView; mobile: boolean; actions: ProjectPanelActions; modelView?: LanePickerView; machineLanes?: Lanes; hasProjectLaneOverride: boolean }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetChanges = (["supervisor", "lead"] as const).filter(seat => panel.seats !== null && seatIsLive(panel.seats[seat]) && modelView !== undefined && machineLanes !== undefined && modelView.lanes[seat] !== machineLanes[seat]);
  const reset = () => resetChanges.length > 0 ? setConfirmingReset(true) : actions.resetProjectLanes?.();
  const save = async () => {
    const ok = await actions.saveProfile?.({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
    if (ok !== false) setNaming(false);
  };
  const { seats, defaultWorker, profile } = panel;
  const standing = seats === null ? [] : ([["supervisor", "Supervisor", seats.supervisor], ["lead", "Lead", seats.lead]] as const);
  const canApply = !mobile && actions.applyProfile !== undefined;
  return <>
    {standing.length > 0 || defaultWorker !== null ? (
      <Section theme={theme} testID="factory-models-seats" divider={false}>
        <SectionTitle theme={theme} label="Seat models" />
        <View>
          {standing.map(([role, name, row], index) => (
            <ModelRow key={role} theme={theme} testID={`factory-models-row-${role}`} role={role} name={name} scope={row.lane.scope} divider={index > 0}>
              {/* seat `models-<role>` keeps this chip's hook unique beside the Team tab's; the edit target is still the seat. */}
              <SeatModelChip theme={theme} seat={`models-${role}`} target={role} lane={row.lane} pendingLane={row.pendingLane} live={seatIsLive(row)} viewHandover={row.allowedActions.includes("view-handover")} editable={seatChipEditable(row)} />
            </ModelRow>
          ))}
          {defaultWorker === null ? null : (
            <ModelRow theme={theme} testID="factory-default-worker" role="peer" name="Default worker" scope={defaultWorker.lane.scope} divider={standing.length > 0}>
              <SeatModelChip theme={theme} seat="worker" lane={defaultWorker.lane} pendingLane={null} />
            </ModelRow>
          )}
        </View>
        <Text style={text(theme, "meta")}>Default worker applies to new Peers. Running Peers keep their model.</Text>
      </Section>
    ) : null}
    <Section theme={theme} testID="factory-lane-profile" divider={standing.length > 0 || defaultWorker !== null}>
      <SectionTitle theme={theme} label="Lane profile" />
      <Text style={text(theme, "rowTitle", profile.active === null ? "foregroundMuted" : undefined)}>
        {profile.active?.name ?? "No Lane profile"}
        {profile.modified ? <Text style={{ ...text(theme, "label"), color: factoryPalette(theme).wait }}> modified</Text> : null}
      </Text>
      {canApply ? (
        profile.list.length === 0 ? <Text style={text(theme, "meta")}>Save a Lane profile to reuse this Project’s models.</Text> : (
          <View>
            {profile.list.map((item, index) => (
              <View key={item.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[3], paddingVertical: SPACING[2], borderTopWidth: index === 0 ? 0 : 1, borderTopColor: theme.colors.border }}>
                <Text style={text(theme, "label")} numberOfLines={1}>{item.name}</Text>
                {item.id === profile.active?.id ? <Text style={text(theme, "meta")}>Active</Text> : <Btn theme={theme} small variant="secondary" testID={`factory-profile-apply-${item.id}`} label="Apply" disabled={actions.busy} onPress={() => actions.applyProfile?.(item.id)} />}
              </View>
            ))}
          </View>
        )
      ) : null}
      {!mobile ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] }}>
        {actions.saveProfile ? <Btn theme={theme} small testID="factory-profile-save" label="+ Save as Profile…" disabled={actions.busy} onPress={() => { setName(""); setDescription(""); setNaming(true); }} /> : null}
        {actions.saveProfile && profile.active !== null && profile.modified ? <Btn theme={theme} small testID="factory-profile-update" label={`Update "${profile.active.name}"`} disabled={actions.busy} onPress={() => { const active = profile.active!; void actions.saveProfile?.({ id: active.id, name: active.name, ...(active.description == null ? {} : { description: active.description }) }); }} /> : null}
        {hasProjectLaneOverride && actions.resetProjectLanes ? <Btn theme={theme} small testID="factory-lanes-reset-project" label="Reset to Machine Default" disabled={actions.busy || modelView === undefined || machineLanes === undefined} onPress={reset} /> : null}
      </View> : null}
    </Section>
    {!mobile && actions.saveProfile ? <Modal open={naming} onOpenChange={setNaming} title="Save Lane profile">
      <Modal.Content><View testID="factory-profile-save-modal" style={{ gap: SPACING[3] }}>
        <Text style={text(theme, "label")}>Profile name</Text>
        <TextInput testID="factory-profile-name" value={name} onChangeText={setName} placeholder="e.g. Fast & Cheap" style={{ color: theme.colors.foreground }} />
        <Text style={text(theme, "label")}>Description (optional)</Text>
        <TextInput testID="factory-profile-description" value={description} onChangeText={setDescription} placeholder="What this setup is for" style={{ color: theme.colors.foreground }} />
        <Text style={text(theme, "meta")}>Saves this Project’s effective models, including Watch. Running seats keep their models.</Text>
        <View style={{ flexDirection: "row", gap: SPACING[2] }}>
          <Btn theme={theme} label="Cancel" disabled={actions.busy} onPress={() => setNaming(false)} />
          <Btn theme={theme} testID="factory-profile-save-confirm" label="Save Profile" disabled={actions.busy || !name.trim()} onPress={() => { void save(); }} />
        </View>
      </View></Modal.Content>
    </Modal> : null}
    {!mobile ? <Modal open={confirmingReset} onOpenChange={setConfirmingReset} title="Reset to Machine Default">
      <Modal.Content><View testID="factory-lanes-reset-confirmation" style={{ gap: SPACING[3] }}>
        <Text style={text(theme, "label")}>Resetting changes these live seats:</Text>
        {resetChanges.map(seat => <Text key={seat} style={text(theme, "meta")}>{seat === "lead" ? "Lead" : "Supervisor"} · {splitLaneParts(modelView!.lanes[seat]).provider === splitLaneParts(machineLanes![seat]).provider ? "Model switch in place" : "Handoff to a new provider"} · {modelView!.lanes[seat]} → {machineLanes![seat]}</Text>)}
        <View style={{ flexDirection: "row", gap: SPACING[2] }}>
          <Btn theme={theme} testID="factory-lanes-reset-cancel" label="Cancel" disabled={actions.busy} onPress={() => setConfirmingReset(false)} />
          <Btn theme={theme} testID="factory-lanes-reset-confirm" label="Confirm & Apply" disabled={actions.busy} onPress={() => { setConfirmingReset(false); actions.resetProjectLanes?.(); }} />
        </View>
      </View></Modal.Content>
    </Modal> : null}
  </>;
}

export function ProjectPanel({
  theme,
  panel,
  mobile,
  now,
  daemonError,
  actions,
  openDesignActions = null,
  menu = null,
  onboarding = null,
  holdOnboarding = false,
  initialUi,
  editorRequest,
  onEditorRequestHandled,
  width = 0,
  skillPacks = [],
  skillPacksExplicit = false,
  hasProjectLaneOverride = false,
  machineLanes,
  modelView,
  selfUpdate,
  release = null,
  publishPreflight = null,
  releaseBusy = false,
  releaseFeedback = null,
  releaseCopiedLogin = false,
  releaseActions,
  storeRelease = null,
  storeReleaseBusy = false,
  storeReleaseFeedback = null,
  storeReleaseActions,
  cancellingGateQueueIds = [],
  gateQueueCancelError = null,
  onOpenReleaseLab,
  onOpenSettings,
  onTabChange,
}: {
  /** The header's version + update control (ticket 11), mounted by the Shell; omitted, no control. */
  selfUpdate?: SelfUpdateView;
  release?: ReleaseSettingsView | null;
  publishPreflight?: GitHubPublishPreflightView | null;
  releaseBusy?: boolean;
  releaseFeedback?: ReleaseCardFeedback | null;
  releaseCopiedLogin?: boolean;
  releaseActions?: GitHubReleaseActions;
  storeRelease?: StoreReleaseView | null;
  storeReleaseBusy?: boolean;
  storeReleaseFeedback?: StoreReleaseCardFeedback | null;
  storeReleaseActions?: StoreReleaseActions;
  cancellingGateQueueIds?: readonly string[];
  gateQueueCancelError?: GateQueueCancelError | null;
  onOpenReleaseLab?: () => void;
  onOpenSettings?: () => void;
  onTabChange?: (tab: ProjectPanelTab) => void;
  modelView?: LanePickerView;
  editorRequest?: SeatEditorRequest;
  onEditorRequestHandled?: () => void;
  width?: number;
  skillPacks?: readonly MenuSkillPack[];
  skillPacksExplicit?: boolean;
  hasProjectLaneOverride?: boolean;
  machineLanes?: Lanes;
  theme: PluginTheme;
  panel: PanelView;
  /** True on Paseo mobile (iOS/Android) — hides desktop-only affordances. */
  mobile: boolean;
  now: number;
  daemonError: string | null;
  actions: ProjectPanelActions;
  /** Desktop's Open Design actions (Sync / Studio), mounted by the Shell; omitted on mobile. */
  openDesignActions?: ReactNode;
  /** The header `⋯` menu's content (project-menu.tsx), supplied by the Shell for a Project; no menu, no `⋯`. */
  menu?: ReactNode;
  /** The onboarding wizard (onboarding-wizard.tsx) for a workspace that is not a Project — supplied by the Shell on desktop only; mobile never mounts it. */
  onboarding?: ReactNode;
  /** Desktop-only: keeps the onboarding wizard mounted while an async onboarding run finishes after registration flips `panel.isProject`. */
  holdOnboarding?: boolean;
  /** Seeds UI-only state (open menus, active tab) — hosts and tests; never data. */
  initialUi?: ProjectPanelInitialUi;
}) {
  const [menuOpen, setMenuOpen] = useState(initialUi?.menuOpen === true);
  const [editingSeat, edit] = useState<string | null>(initialUi?.editingSeat ?? null);
  const [tab, setTab] = useState<ProjectPanelTab>(initialUi?.tab ?? "team");
  useEffect(() => {
    if (!editorRequest) return;
    // The editor opens from its chip, which only exists on its own tab: the Default worker's on Models, every seat's on Team.
    setTab(editorRequest.target === "worker" ? "models" : "team");
    edit(editorRequest.target);
    onEditorRequestHandled?.();
  }, [editorRequest, onEditorRequestHandled]);
  const showProject = panel.isProject && (mobile || !holdOnboarding);
  const hasMenu = showProject && menu !== null;
  const wide = width >= WIDE;
  const boundary = (section: string, children: ReactNode) => <FactoryTabErrorBoundary theme={theme} section={section}>{children}</FactoryTabErrorBoundary>;
  const needsYouItems = withoutShownHandoffFailures(panel.needsYou, panel.handoffs);
  const needsYou = <NeedsYou theme={theme} items={needsYouItems} mobile={mobile} wide={wide} actions={actions} />;
  const handoff = <HandoffBlock theme={theme} handoffs={panel.handoffs} mobile={mobile} wide={wide} actions={actions} />;
  const seats =
    panel.seats === null ? null : (
      <Seats
        theme={theme}
        seats={panel.seats}
        {...(panel.gateQueue === undefined ? {} : { gateQueue: panel.gateQueue })}
        cancellingGateQueueIds={cancellingGateQueueIds}
        gateQueueCancelError={gateQueueCancelError}
        mobile={mobile}
        wide={wide}
        actions={actions}
      />
    );
  const models = <ModelsTab theme={theme} panel={panel} mobile={mobile} actions={actions} modelView={modelView} machineLanes={machineLanes} hasProjectLaneOverride={hasProjectLaneOverride} />;
  const packs = <SkillPacks theme={theme} packs={skillPacks} explicit={skillPacksExplicit} {...(!mobile ? { onReset: actions.resetSkillPacks, onManage: actions.manageSkillPacks } : {})} initiallyExpanded={initialUi?.expandedSkillPacks ?? []} busy={actions.busy} {...(!mobile && actions.toggleSkillPack !== undefined ? { onToggle: actions.toggleSkillPack } : {})} />;
  const design = panel.openDesign === null ? null : <OpenDesign theme={theme} openDesign={panel.openDesign} now={now} desktopActions={mobile ? null : openDesignActions} />;
  // The header chip names the active profile and jumps to the Models tab, where profiles are applied.
  const profileLabel = `${panel.profile.active?.name ?? "No Lane profile"}${panel.profile.modified ? " (modified)" : ""}`;
  return (
    <ChipEditorContext.Provider value={{ modelView, mobile, actions, editingSeat, edit }}>
    <View testID="factory-panel" style={{ gap: SPACING[3], width: "100%", maxWidth: 1040, alignSelf: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: SPACING[2] }}>
        <View style={{ flex: 1, minWidth: 0, gap: SPACING[1] }}>
          <Text accessibilityRole="header" style={text(theme, "detailTitle")}>
            {panel.name ?? "Factory"}
          </Text>
          <Text style={text(theme, "meta")}>{panel.summary}</Text>
          {daemonError !== null ? <Text style={text(theme, "label", "statusWarning")}>{daemonError}</Text> : null}
        </View>
        <View style={{ flexShrink: 1, alignItems: "flex-end", gap: SPACING[1] }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: SPACING[1.5] }}>
            {selfUpdate === undefined ? null : <SelfUpdateControls theme={theme} view={selfUpdate} mobile={mobile} />}
            {showProject ? (!mobile && actions.applyProfile !== undefined ? <Btn theme={theme} small variant="secondary" testID="factory-profile-chip" label={`${profileLabel} ▾`} onPress={() => setTab("models")} /> : <View testID="factory-profile-chip"><Text style={text(theme, "label")}>{profileLabel}</Text></View>) : null}
            {hasMenu ? <Btn theme={theme} small variant="ghost" testID="factory-panel-menu-toggle" label="⋯" onPress={() => setMenuOpen(!menuOpen)} /> : null}
          </View>
          {selfUpdate === undefined ? null : <SelfUpdateNote theme={theme} view={selfUpdate} />}
        </View>
      </View>
      {hasMenu && menuOpen ? <Block theme={theme} testID="factory-panel-menu">{menu}</Block> : null}
      {showProject ? (
        <>
          {/* One alert stack, full width above the tabs: what needs the Owner, then handoff progress. */}
          {needsYouItems.length > 0 || panel.handoffs.length > 0 ? <View testID="factory-alert-stack" style={{ gap: SPACING[1.5] }}>{boundary("Needs you", needsYou)}{boundary("Handoff", handoff)}</View> : null}
          <Tabs
            theme={theme}
            tabs={PANEL_TABS}
            value={tab}
            onChange={(next) => {
              setTab(next);
              onTabChange?.(next);
            }}
            testID="factory-tab"
          />
          <View testID={`factory-tab-body-${tab}`} style={tab === "project" ? { gap: SPACING[3] } : undefined}>
            {tab === "team" ? (
              boundary("Seats", seats)
            ) : tab === "models" ? (
              boundary("Models", models)
            ) : (
              <>
                {panel.usage == null ? null : boundary("Project usage", <ProjectUsage theme={theme} usage={panel.usage} mobile={mobile} wide={wide} />)}
                {design === null ? (
                  boundary("Skill packs", packs)
                ) : wide && !mobile ? (
                  <View testID="factory-project-tier2" style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACING[3] }}>
                    <View style={{ flex: 3, minWidth: 0 }}>{boundary("Skill packs", packs)}</View>
                    <View style={{ flex: 2, minWidth: 0 }}>{boundary("Open Design", design)}</View>
                  </View>
                ) : (
                  <>
                    {boundary("Skill packs", packs)}
                    {boundary("Open Design", design)}
                  </>
                )}
                {release === null ? null : boundary("GitHub & Release", <GitHubReleaseCard theme={theme} release={release} publishPreflight={publishPreflight} mobile={mobile} wide={wide} now={now} busy={releaseBusy} feedback={releaseFeedback} copiedLogin={releaseCopiedLogin} {...(releaseActions === undefined ? {} : { actions: releaseActions })} />)}
                {storeRelease === null ? null : boundary("Store Release", <StoreReleaseCard theme={theme} storeRelease={storeRelease} mobile={mobile} wide={wide} now={now} busy={storeReleaseBusy} feedback={storeReleaseFeedback} {...(storeReleaseActions === undefined ? {} : { actions: storeReleaseActions })} {...(onOpenReleaseLab === undefined ? {} : { onOpenReleaseLab })} {...(onOpenSettings === undefined ? {} : { onOpenSettings })} />)}
              </>
            )}
          </View>
        </>
      ) : (
        <NotAProject theme={theme} mobile={mobile} wizard={onboarding} />
      )}
    </View>
    </ChipEditorContext.Provider>
  );
}
