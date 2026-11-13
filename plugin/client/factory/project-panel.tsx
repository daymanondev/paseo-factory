/**
 * The native Factory tab (v0.7.0 W10–11, ADR 0057 §8–9).
 * The server owns seat, lane, profile and progress data; the Shell owns RPCs.
 * Measured width selects the wide columns or the narrow reading order.
 * Inline model/profile/pack controls dispatch through the Shell. Onboarding,
 * adoption and existing handoff/Open Design actions retain their host gates.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PanelNeedsYouItem, PanelOpenDesign, PanelPeerRow, PanelSeatRow, PanelSupervisorCandidateRow, PanelTone, PanelView } from "../../shared/view.ts";
import { Btn } from "../kit/pill.tsx";
import { Tabs } from "../kit/tabs.tsx";
import { CONTROL_H, RADIUS, SPACING, factoryPalette, hoveredOf, text, thinkingColour, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";
import type { SeatEditorRequest } from "./editor-request.ts";
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
  /** Start the Supervisor on a vacant seat with the Owner's optional first directive (desktop only). */
  startSupervisor(directive: string): void;
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
  busy: boolean;
}

/**
 * UI-only state a host may seed — what is open and the directive draft. Never
 * data. Kept deliberately (review S7): the panel's tests render to static
 * markup, which cannot click a `⋯` or type a draft, so seeding the initial UI
 * state is the only door to the open-menu and typed-directive renders. The
 * live state stays local to the component either way.
 */
export interface ProjectPanelInitialUi {
  menuOpen?: boolean;
  directive?: string;
  /** Stable targets: supervisor, lead, peer:<task>, worker. */
  editingSeat?: string;
  /** Which tab opens first (default `team`) — static markup cannot click a tab. */
  tab?: ProjectPanelTab;
}

export type ProjectPanelTab = "team" | "models" | "project";
const PANEL_TABS: readonly { id: ProjectPanelTab; label: string }[] = [
  { id: "team", label: "Team" },
  { id: "models", label: "Models" },
  { id: "project", label: "Project" },
];

/** Measured width (px) from which a seat is one grid line and an alert puts its actions beside its title. */
const WIDE = 720;
/** The seat grid's fixed columns; the model chip takes the rest. The status column is wider than a bare word so a Peer's `closed · implementation` fits. */
const COL = { name: 150, status: 128, context: 170 } as const;

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

/**
 * One alert-stack item: a 3px tone bar, a faint tint, the title in the tone
 * colour and — wide — the actions on that same line; detail lines under it.
 * Narrow, the actions drop to their own line below the detail.
 */
function AlertRow({ theme, testID, colour, title, wide, actions, children }: { theme: PluginTheme; testID: string; colour: string; title: string; wide: boolean; actions: ReactNode; children?: ReactNode }) {
  return (
    <View testID={testID} style={{ flexDirection: "row", borderRadius: RADIUS.md, overflow: "hidden", backgroundColor: tint(colour, "10") }}>
      <View style={{ width: 3, backgroundColor: colour }} />
      <View style={{ flex: 1, minWidth: 0, gap: SPACING[1], paddingVertical: SPACING[2.5], paddingHorizontal: SPACING[3] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
          <Text style={{ ...text(theme, "rowTitle"), color: colour, flexShrink: 1 }}>{title}</Text>
          {wide ? actions : null}
        </View>
        {children}
        {wide ? null : actions}
      </View>
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
    : action.kind === "start-supervisor" ? primary(() => actions.startSupervisor(""))
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

function seatStateColour(theme: PluginTheme, row: PanelSeatRow | PanelPeerRow): string {
  const p = factoryPalette(theme);
  if (row.tone === "error" || row.handoff?.state === "failed") return p.bad;
  if (row.pendingLane !== null || (row.handoff !== null && row.handoff.state !== "done")) return p.move;
  if (row.tone === "waiting") return p.wait;
  return /idle|vacant|offline/i.test(row.statusLabel) ? p.idle : p.ok;
}

function RoleName({ theme, role, label }: { theme: PluginTheme; role: "supervisor" | "lead" | "peer"; label: string }) {
  const colour = factoryPalette(theme)[role];
  return <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colour }} />
    <Text style={{ ...text(theme, "rowTitle"), color: colour, flexShrink: 1 }} numberOfLines={1}>{label}</Text>
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

function SeatRow({
  theme,
  name,
  row,
  mobile,
  wide,
  divider = true,
  actions,
  initialUi,
}: {
  theme: PluginTheme;
  name: string;
  row: PanelSeatRow;
  mobile: boolean;
  wide: boolean;
  divider?: boolean;
  actions: ProjectPanelActions;
  initialUi?: ProjectPanelInitialUi;
}) {
  const colour = toneColour(row.tone);
  const [directive, setDirective] = useState(initialUi?.directive ?? "");
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
        status={<Text style={{ ...text(theme, "label"), color: seatStateColour(theme, row) }} numberOfLines={1}>{row.statusLabel}</Text>}
        chip={<SeatModelChip theme={theme} seat={row.role} lane={row.lane} pendingLane={row.pendingLane} live={live} viewHandover={row.allowedActions.includes("view-handover")} editable={seatChipEditable(row)} />}
        context={<ContextBar theme={theme} context={row.context} />}
        actions={<>
          {live && agentId !== null ? <Btn theme={theme} small variant="secondary" testID={`factory-panel-open-${row.role}`} label="Open" onPress={() => actions.openAgent(agentId)} /> : null}
          {canHandOff ? <Btn theme={theme} small variant="secondary" testID={`factory-seat-hand-off-now-${row.role}`} label="Hand off…" disabled={actions.busy} onPress={handOff} /> : null}
          {row.allowedActions.includes("view-handover") ? <Btn theme={theme} small variant="ghost" testID={`factory-seat-view-handover-${row.role}`} label="View handover" disabled={actions.busy} onPress={() => actions.viewHandover(row.role)} /> : null}
        </>}
      />
      {row.hint !== null ? <Text style={text(theme, "meta", colour)}>{row.hint}</Text> : null}
      {row.handoff !== null && row.handoff.state !== "failed" ? <Text style={{ ...text(theme, "meta"), color: row.handoff.state === "done" ? factoryPalette(theme).ok : factoryPalette(theme).move }}>Handoff: {row.handoff.state === "scheduled" ? `Scheduled · waiting for ${row.handoff.waitingPeers ?? 0} Peers` : row.handoff.state}</Text> : null}
      {isSupervisor && row.vacant && !mobile ? (
        <View style={{ gap: SPACING[1.5] }}>
          <TextInput
            testID="factory-panel-directive"
            value={directive}
            onChangeText={setDirective}
            placeholder="First directive for the Supervisor (optional)"
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
            style={{
              minHeight: CONTROL_H * 2,
              paddingHorizontal: SPACING[2.5],
              paddingVertical: SPACING[1.5],
              color: theme.colors.foreground,
              fontSize: 12,
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: RADIUS.md,
              backgroundColor: theme.colors.surface1,
            }}
          />
          <Btn
            theme={theme}
            small
            variant="primary"
            testID="factory-panel-start-supervisor"
            label="Start Supervisor"
            disabled={actions.busy}
            onPress={() => actions.startSupervisor(directive)}
          />
        </View>
      ) : null}
    </View></View>
  );
}

function PeerRowView({ theme, row, wide, actions }: { theme: PluginTheme; row: PanelPeerRow; wide: boolean; actions: ProjectPanelActions }) {
  const handOff = useHandOff(`peer:${row.task}`, actions);
  const canHandOff = row.allowedActions.includes("hand-off-now");
  return (
    <View testID={`factory-panel-seat-peer-${row.task}`}><View testID={`factory-seat-peer-${row.task}`} style={seatRowStyle(theme, true)}>
      <SeatLine
        theme={theme}
        testID={`factory-seat-line-peer-${row.task}`}
        wide={wide}
        name={<RoleName theme={theme} role="peer" label={row.title} />}
        status={<Text style={{ ...text(theme, "label"), color: seatStateColour(theme, row) }} numberOfLines={1}>{row.statusLabel}<Text style={text(theme, "meta")}>{` · ${row.disposition}`}</Text></Text>}
        chip={<SeatModelChip theme={theme} seat={`peer-${row.task}`} target={`peer:${row.task}`} lane={row.lane} pendingLane={row.pendingLane} viewHandover={row.allowedActions.includes("view-handover")} editable={row.allowedActions.includes("switch-model") || canHandOff} />}
        context={<ContextBar theme={theme} context={row.context} />}
        actions={<>
          <Btn theme={theme} small variant="secondary" testID={`factory-panel-open-peer-${row.task}`} label="Open" onPress={() => actions.openAgent(row.agentId)} />
          {canHandOff ? <Btn theme={theme} small variant="secondary" testID={`factory-seat-hand-off-now-peer-${row.task}`} label="Hand off…" disabled={actions.busy} onPress={handOff} /> : null}
          {row.allowedActions.includes("view-handover") ? <Btn theme={theme} small variant="ghost" testID={`factory-seat-view-handover-peer-${row.task}`} label="View handover" disabled={actions.busy} onPress={() => actions.viewHandover(`peer:${row.task}`)} /> : null}
        </>}
      />
    </View></View>
  );
}

/**
 * One Supervisor candidate chat (v0.6.1, ADR 0057 §5) — the Owner's way to
 * choose it over the still-live bound Supervisor. Adoption is available on mobile
 * (ADR 0057 §10), so this action never gates on `mobile`.
 */
function SupervisorCandidateRow({ theme, row, actions }: { theme: PluginTheme; row: PanelSupervisorCandidateRow; actions: ProjectPanelActions }) {
  const colour = toneColour(row.tone);
  return (
    <View testID="factory-panel-supervisor-candidate" style={{ ...seatRowStyle(theme, true), gap: SPACING[0.5] }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        <Text style={text(theme, "rowTitle")}>{row.title ?? row.agentId}</Text>
        <Text style={text(theme, "label", colour)}>{row.statusLabel}</Text>
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
  mobile,
  wide,
  actions,
  initialUi,
}: {
  theme: PluginTheme;
  seats: NonNullable<PanelView["seats"]>;
  mobile: boolean;
  wide: boolean;
  actions: ProjectPanelActions;
  initialUi?: ProjectPanelInitialUi;
}) {
  const [closedOpen, setClosedOpen] = useState(false);
  const live = seats.peers.filter((peer) => !isClosedPeer(peer));
  const closed = seats.peers.filter(isClosedPeer);
  return (
    <View testID="factory-panel-seats">
      <SeatRow theme={theme} name="Supervisor" row={seats.supervisor} mobile={mobile} wide={wide} divider={false} actions={actions} {...(initialUi === undefined ? {} : { initialUi })} />
      <SeatRow theme={theme} name="Lead" row={seats.lead} mobile={mobile} wide={wide} actions={actions} />
      {seats.peers.length > 0 ? (
        <View testID="factory-panel-peers">
          <GroupHeading theme={theme} label="PEERS" />
          {live.map((peer) => (
            <PeerRowView key={peer.agentId} theme={theme} row={peer} wide={wide} actions={actions} />
          ))}
          {closed.length > 0 ? (
            <>
              <View style={{ paddingVertical: SPACING[1.5], borderTopWidth: 1, borderTopColor: theme.colors.border }}>
                <Btn theme={theme} small variant="ghost" testID="factory-panel-peers-closed-toggle" label={`${closedOpen ? "▾" : "▸"} Closed (${closed.length})`} onPress={() => setClosedOpen(!closedOpen)} />
              </View>
              {closedOpen ? (
                <View testID="factory-panel-peers-closed">
                  {closed.map((peer) => (
                    <PeerRowView key={peer.agentId} theme={theme} row={peer} wide={wide} actions={actions} />
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
 * The Open Design section: a not-linked Project costs one line; a linked one
 * names the design and its last sync. Desktop mounts the Shell's actions
 * (Sync / Studio) in `desktopActions`; mobile shows the status alone.
 */
function OpenDesign({ theme, openDesign, now, desktopActions }: { theme: PluginTheme; openDesign: PanelOpenDesign; now: number; desktopActions: ReactNode }) {
  const broken = openDesign.state === "broken";
  return (
    <Section theme={theme} testID="factory-panel-od">
      {openDesign.state === "unlinked" ? (
        <Text style={text(theme, "label")}>Open Design · not linked</Text>
      ) : (
        <View style={{ gap: SPACING[1] }}>
          <Text style={text(theme, "rowTitle", broken ? "statusDanger" : undefined)}>
            {broken ? "Open Design link is broken" : "Open Design"}
            {openDesign.projectName === null ? "" : ` · ${openDesign.projectName}`}
          </Text>
          <Text style={text(theme, "meta")}>
            {openDesign.detail ?? `Synced ${agoOf(openDesign.syncedAt, now)}`}
          </Text>
        </View>
      )}
      {desktopActions}
    </Section>
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

/** A tiny on/off switch: a 34×20 track and a knob, accent when on. Mobile never mounts it (the word stands in). */
function Switch({ theme, testID, label, checked, disabled, onToggle }: { theme: PluginTheme; testID: string; label: string; checked: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onToggle}
      style={{ width: 34, height: 20, borderRadius: 10, padding: 2, justifyContent: "center", alignItems: checked ? "flex-end" : "flex-start", backgroundColor: checked ? theme.colors.accent : theme.colors.surface2, opacity: disabled ? 0.5 : 1 }}
    >
      <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: theme.colors.surface0 }} />
    </Pressable>
  );
}

export function SkillPacks({ theme, packs, onToggle, busy = false }: { theme: PluginTheme; packs: readonly MenuSkillPack[]; onToggle?: (pack: string, enabled: boolean) => void; busy?: boolean }) {
  return <Section theme={theme} testID="factory-skill-packs" divider={false}>
    <SectionTitle theme={theme} label="Skill packs" />
    {packs.length === 0 ? <Text style={text(theme, "meta")}>No skill packs available.</Text> : packs.map((pack, index) => (
      <View key={pack.id} testID={`factory-panel-skill-${pack.id}`} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[3], paddingVertical: SPACING[2], borderTopWidth: index === 0 ? 0 : 1, borderTopColor: theme.colors.border }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={text(theme, "rowTitle")}>{pack.label}</Text>
          {pack.autoDetected ? <Text style={text(theme, "meta")}>Auto-detected</Text> : null}
        </View>
        {onToggle === undefined ? <Text style={text(theme, "label", pack.enabled ? undefined : "foregroundMuted")}>{pack.enabled ? "On" : "Off"}</Text> : <Switch theme={theme} testID={`factory-skill-pack-${pack.id}`} label={`${pack.enabled ? "Disable" : "Enable"} ${pack.label}`} checked={pack.enabled} disabled={busy} onToggle={() => onToggle(pack.id, !pack.enabled)} />}
      </View>
    ))}
  </Section>;
}

/** One Models-tab row: role name, the seat's chip (opens the modal), and where the value comes from. */
function ModelRow({ theme, testID, name, scope, divider, children }: { theme: PluginTheme; testID?: string; name: string; scope: ScopedLaneRef["scope"]; divider: boolean; children: ReactNode }) {
  return (
    <View testID={testID} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[3], paddingVertical: SPACING[2.5], borderTopWidth: divider ? 1 : 0, borderTopColor: theme.colors.border }}>
      <Text style={{ ...text(theme, "rowTitle"), width: COL.name, flexShrink: 0 }} numberOfLines={1}>{name}</Text>
      {children}
      <Text style={text(theme, "meta")}>{scope === "project" ? "Project override" : "Machine default"}</Text>
    </View>
  );
}

/** Seat models (Supervisor, Lead, Default worker), then the Lane profile. Every chip opens the same modal as the Team tab. */
function ModelsTab({ theme, panel, mobile, actions }: { theme: PluginTheme; panel: PanelView; mobile: boolean; actions: ProjectPanelActions }) {
  const { seats, defaultWorker, profile } = panel;
  const standing = seats === null ? [] : ([["supervisor", "Supervisor", seats.supervisor], ["lead", "Lead", seats.lead]] as const);
  const canApply = !mobile && actions.applyProfile !== undefined;
  return <>
    {standing.length > 0 || defaultWorker !== null ? (
      <Section theme={theme} testID="factory-models-seats" divider={false}>
        <SectionTitle theme={theme} label="Seat models" />
        <View>
          {standing.map(([role, name, row], index) => (
            <ModelRow key={role} theme={theme} testID={`factory-models-row-${role}`} name={name} scope={row.lane.scope} divider={index > 0}>
              {/* seat `models-<role>` keeps this chip's hook unique beside the Team tab's; the edit target is still the seat. */}
              <SeatModelChip theme={theme} seat={`models-${role}`} target={role} lane={row.lane} pendingLane={row.pendingLane} live={seatIsLive(row)} viewHandover={row.allowedActions.includes("view-handover")} editable={seatChipEditable(row)} />
            </ModelRow>
          ))}
          {defaultWorker === null ? null : (
            <ModelRow theme={theme} testID="factory-default-worker" name="Default worker" scope={defaultWorker.lane.scope} divider={standing.length > 0}>
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
        profile.list.length === 0 ? <Text style={text(theme, "meta")}>Save a Lane profile in Settings to use it here.</Text> : (
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
    </Section>
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
  initialUi,
  editorRequest,
  onEditorRequestHandled,
  width = 0,
  skillPacks = [],
  modelView,
}: {
  modelView?: LanePickerView;
  editorRequest?: SeatEditorRequest;
  onEditorRequestHandled?: () => void;
  width?: number;
  skillPacks?: readonly MenuSkillPack[];
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
  /** Seeds UI-only state (open menus, directive draft) — hosts and tests; never data. */
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
  const hasMenu = panel.isProject && menu !== null;
  const wide = width >= WIDE;
  const boundary = (section: string, children: ReactNode) => <FactoryTabErrorBoundary theme={theme} section={section}>{children}</FactoryTabErrorBoundary>;
  const needsYouItems = withoutShownHandoffFailures(panel.needsYou, panel.handoffs);
  const needsYou = <NeedsYou theme={theme} items={needsYouItems} mobile={mobile} wide={wide} actions={actions} />;
  const handoff = <HandoffBlock theme={theme} handoffs={panel.handoffs} mobile={mobile} wide={wide} actions={actions} />;
  const seats = panel.seats === null ? null : <Seats theme={theme} seats={panel.seats} mobile={mobile} wide={wide} actions={actions} {...(initialUi === undefined ? {} : { initialUi })} />;
  const models = <ModelsTab theme={theme} panel={panel} mobile={mobile} actions={actions} />;
  const packs = <SkillPacks theme={theme} packs={skillPacks} busy={actions.busy} {...(!mobile && actions.toggleSkillPack !== undefined ? { onToggle: actions.toggleSkillPack } : {})} />;
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
          {panel.isProject ? (!mobile && actions.applyProfile !== undefined ? <Btn theme={theme} small variant="secondary" testID="factory-profile-chip" label={`${profileLabel} ▾`} onPress={() => setTab("models")} /> : <View testID="factory-profile-chip"><Text style={text(theme, "label")}>{profileLabel}</Text></View>) : null}
          {hasMenu ? <Btn theme={theme} small variant="ghost" testID="factory-panel-menu-toggle" label="⋯" onPress={() => setMenuOpen(!menuOpen)} /> : null}
        </View>
      </View>
      {hasMenu && menuOpen ? <Block theme={theme} testID="factory-panel-menu">{menu}</Block> : null}
      {panel.isProject ? (
        <>
          {/* One alert stack, full width above the tabs: what needs the Owner, then handoff progress. */}
          {needsYouItems.length > 0 || panel.handoffs.length > 0 ? <View testID="factory-alert-stack" style={{ gap: SPACING[1.5] }}>{boundary("Needs you", needsYou)}{boundary("Handoff", handoff)}</View> : null}
          <Tabs theme={theme} tabs={PANEL_TABS} value={tab} onChange={setTab} testID="factory-tab" />
          <View testID={`factory-tab-body-${tab}`}>
            {tab === "team" ? boundary("Seats", seats) : tab === "models" ? boundary("Models", models) : <>{boundary("Skill packs", packs)}{boundary("Open Design", design)}</>}
          </View>
        </>
      ) : (
        <NotAProject theme={theme} mobile={mobile} wizard={onboarding} />
      )}
    </View>
    </ChipEditorContext.Provider>
  );
}
