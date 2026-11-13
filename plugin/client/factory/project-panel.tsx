/**
 * The native Factory tab's read surface (v0.7.0 W10, ADR 0057 §8–9).
 * The server owns seat, lane, profile and progress data; the Shell owns RPCs.
 * Measured width selects the wide columns or the narrow reading order.
 * Model/profile/pack chips are display-only in this wave. Onboarding,
 * adoption and existing handoff/Open Design actions retain their host gates.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { PanelNeedsYouItem, PanelOpenDesign, PanelPeerRow, PanelSeatRow, PanelSupervisorCandidateRow, PanelTone, PanelView } from "../../shared/view.ts";
import { Btn } from "../kit/pill.tsx";
import { CONTROL_H, RADIUS, SPACING, factoryPalette, text, thinkingColour, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";
import { FactoryTabErrorBoundary } from "./tab-error-boundary.tsx";
import type { MenuSkillPack } from "./project-menu.tsx";
import type { ScopedLaneRef } from "../../shared/view.ts";

/** The panel's action surface — the Shell owns the RPC and navigation calls. */
export interface ProjectPanelActions {
  /** Jump to an agent's conversation — a Needs-you item's primary action. */
  openAgent(agentId: string): void;
  /** Install the missing required skills & tools (desktop only — a settings write). */
  installPrerequisites(): void;
  /** Request a continuity handoff for the live Lead (also on mobile). */
  handoffLead(): void;
  /** Existing Supervisor handoff callback; W12 brings actions onto each seat row. */
  revokeSupervisor(): void;
  /** Start the Supervisor on a vacant seat with the Owner's optional first directive (desktop only). */
  startSupervisor(directive: string): void;
  /** Sync the linked Open Design project again from the host — a broken link's primary action (desktop only). */
  syncOpenDesign(): void;
  /** "Use this chat as Supervisor" (v0.6.1, ADR 0057 §5) — adopt a candidate chat; the one seat write mobile may perform (ADR 0057 §10). */
  adoptSupervisor(agentId: string): void;
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
  supervisorMenuOpen?: boolean;
  directive?: string;
}

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

function SectionTitle({ theme, label }: { theme: PluginTheme; label: string }) {
  return <Text style={text(theme, "section")}>{label}</Text>;
}

/** Quiet section structure; only Needs you and Handoff receive background tint. */
function Block({ theme, testID, border, children }: { theme: PluginTheme; testID?: string; border?: Colour; children: ReactNode }) {
  const borderColour = border === "statusDanger" ? factoryPalette(theme).bad : border === "statusWarning" ? factoryPalette(theme).wait : border === undefined ? theme.colors.border : theme.colors[border];
  return (
    <View
      testID={testID}
      style={{
        gap: SPACING[2],
        padding: SPACING[3],
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: border === undefined ? theme.colors.border : tint(borderColour, "66"),
        backgroundColor: testID === "factory-panel-needs-you" ? tint(factoryPalette(theme).wait, "1a") : "transparent",
      }}
    >
      {children}
    </View>
  );
}

function NeedsYouRow({ theme, item, mobile, actions }: { theme: PluginTheme; item: PanelNeedsYouItem; mobile: boolean; actions: ProjectPanelActions }) {
  const colour = NEEDS_YOU_TONE[item.kind];
  const action = item.action;
  const buttonId = `factory-panel-needs-you-action-${item.key}`;
  return (
    <View testID={`factory-panel-needs-you-${item.key}`} style={{ gap: SPACING[1], paddingVertical: SPACING[1] }}>
      <Text style={{ ...text(theme, "rowTitle"), color: factoryPalette(theme)[colour] }}>{item.title}</Text>
      {item.detail !== null ? <Text style={text(theme, "meta")}>{item.detail}</Text> : null}
      {action.kind === "open-agent" ? (
        <Btn theme={theme} small testID={buttonId} label={action.label} onPress={() => actions.openAgent(action.agentId)} />
      ) : action.kind === "handoff-supervisor" ? (
        <Btn theme={theme} small testID={buttonId} label={action.label} disabled={actions.busy} onPress={actions.revokeSupervisor} />
      ) : action.kind === "retry-handoff" ? null : mobile ? (
        <Text testID={`factory-panel-needs-you-hint-${item.key}`} style={text(theme, "meta")}>{DESKTOP_ONLY_HINT[action.kind]}</Text>
      ) : action.kind === "install-prerequisites" ? (
        <Btn theme={theme} small testID={buttonId} label={action.label} disabled={actions.busy} onPress={actions.installPrerequisites} />
      ) : action.kind === "start-supervisor" ? (
        <Btn theme={theme} small testID={buttonId} label={action.label} disabled={actions.busy} onPress={() => actions.startSupervisor("")} />
      ) : (
        <Btn theme={theme} small testID={buttonId} label={action.label} disabled={actions.busy} onPress={actions.syncOpenDesign} />
      )}
    </View>
  );
}

function NeedsYou({ theme, items, mobile, actions }: { theme: PluginTheme; items: PanelNeedsYouItem[]; mobile: boolean; actions: ProjectPanelActions }) {
  if (items.length === 0) return null;
  return (
    <Block theme={theme} testID="factory-panel-needs-you" border="statusWarning">
      <SectionTitle theme={theme} label="Needs you" />
      {items.map((item) => (
        <NeedsYouRow key={item.key} theme={theme} item={item} mobile={mobile} actions={actions} />
      ))}
    </Block>
  );
}

/** Unknown readings stay explicit; used tokens fill against this seat's actual handoff mark. */
function ContextBar({ theme, context }: { theme: PluginTheme; context: NonNullable<PanelSeatRow["context"]> }) {
  const palette = factoryPalette(theme);
  if (context.state === "unknown") return <Text style={text(theme, "meta")}>context unknown</Text>;
  const fraction = Math.max(0, Math.min(1, context.usedTokens === null || context.markTokens <= 0 ? 0 : context.usedTokens / context.markTokens));
  const colour = fraction >= 0.9 ? palette.move : fraction >= 0.7 ? palette.wait : palette.ok;
  return <View style={{ gap: SPACING[0.5] }}>
    <Text style={text(theme, "meta")}>Context {context.label}</Text>
    <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ height: 4, width: `${Math.round(fraction * 100)}%`, backgroundColor: colour }} />
    </View>
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
    <Text style={{ ...text(theme, "rowTitle"), color: colour }}>{label}</Text>
  </View>;
}

function SeatRow({
  theme,
  name,
  row,
  mobile,
  actions,
  initialUi,
}: {
  theme: PluginTheme;
  name: string;
  row: PanelSeatRow;
  mobile: boolean;
  actions: ProjectPanelActions;
  initialUi?: ProjectPanelInitialUi;
}) {
  const colour = toneColour(row.tone);
  const [menuOpen, setMenuOpen] = useState(initialUi?.supervisorMenuOpen === true);
  const [directive, setDirective] = useState(initialUi?.directive ?? "");
  const isSupervisor = row.role === "supervisor";
  const live = !row.vacant && row.agentId !== null;
  const agentId = row.agentId;
  return (
    <View testID={`factory-panel-seat-${row.role}`}><View testID={`factory-seat-${row.role}`} style={{ gap: SPACING[1], paddingVertical: SPACING[1] }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        <RoleName theme={theme} role={row.role} label={name} />
        <Text style={{ ...text(theme, "label"), color: seatStateColour(theme, row) }}>{row.statusLabel}</Text>
        <SeatModelChip theme={theme} seat={row.role} lane={row.lane} pendingLane={row.pendingLane} />
      </View>
      {row.hint !== null ? <Text style={text(theme, "meta", colour)}>{row.hint}</Text> : null}
      {row.context !== null ? <ContextBar theme={theme} context={row.context} /> : null}
      {row.handoff !== null ? <Text style={{ ...text(theme, "meta"), color: row.handoff.state === "failed" ? factoryPalette(theme).bad : row.handoff.state === "done" ? factoryPalette(theme).ok : factoryPalette(theme).move }}>Handoff: {row.handoff.state === "scheduled" ? `Scheduled · waiting for ${row.handoff.waitingPeers ?? 0} Peers` : row.handoff.state}</Text> : null}
      {live && agentId !== null ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Btn theme={theme} small testID={`factory-panel-open-${row.role}`} label="Open" onPress={() => actions.openAgent(agentId)} />
          {row.role === "lead" ? (
            <Btn theme={theme} small testID="factory-panel-handoff-lead" label="Hand off now" tone="foregroundMuted" disabled={actions.busy} onPress={actions.handoffLead} />
          ) : null}
          {isSupervisor ? (
            <Btn theme={theme} small testID="factory-panel-supervisor-menu" label="⋯" tone="foregroundMuted" onPress={() => setMenuOpen(!menuOpen)} />
          ) : null}
        </View>
      ) : null}
      {isSupervisor && live && menuOpen ? (
        <View testID="factory-panel-supervisor-menu-open" style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Btn
            theme={theme}
            small
            testID="factory-panel-revoke-supervisor"
            label="Hand off now"
            tone="statusWarning"
            disabled={actions.busy}
            onPress={() => {
              setMenuOpen(false);
              actions.revokeSupervisor();
            }}
          />
        </View>
      ) : null}
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
            solid
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

function PeerRowView({ theme, row, actions }: { theme: PluginTheme; row: PanelPeerRow; actions: ProjectPanelActions }) {
  return (
    <View testID={`factory-panel-seat-peer-${row.task}`}><View testID={`factory-seat-peer-${row.task}`} style={{ gap: SPACING[0.5], paddingVertical: SPACING[1] }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        <RoleName theme={theme} role="peer" label={row.title} />
        <Text style={text(theme, "label")}>{row.disposition}</Text>
        <Text style={{ ...text(theme, "label"), color: seatStateColour(theme, row) }}>{row.statusLabel}</Text>
      </View>
      <SeatModelChip theme={theme} seat={`peer-${row.task}`} lane={row.lane} pendingLane={row.pendingLane} />
      <ContextBar theme={theme} context={row.context} />
      <Btn theme={theme} small testID={`factory-panel-open-peer-${row.task}`} label="Open" onPress={() => actions.openAgent(row.agentId)} />
    </View></View>
  );
}

/**
 * One Supervisor candidate chat (v0.6.1, ADR 0057 §5) — the Owner's way to
 * choose it over the still-live bound Supervisor. The adopt button is the one
 * seat write mobile may perform (ADR 0057 §10), so it never gates on `mobile`.
 */
function SupervisorCandidateRow({ theme, row, actions }: { theme: PluginTheme; row: PanelSupervisorCandidateRow; actions: ProjectPanelActions }) {
  const colour = toneColour(row.tone);
  return (
    <View testID="factory-panel-supervisor-candidate" style={{ gap: SPACING[0.5], paddingVertical: SPACING[1] }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        <Text style={text(theme, "rowTitle")}>{row.title ?? row.agentId}</Text>
        <Text style={text(theme, "label", colour)}>{row.statusLabel}</Text>
      </View>
      {row.model !== null ? <Text style={text(theme, "code", "foregroundMuted")} numberOfLines={1}>{row.model}</Text> : null}
      <Btn
        theme={theme}
        small
        testID="factory-panel-adopt-supervisor"
        label="Use this chat as Supervisor"
        disabled={actions.busy}
        onPress={() => actions.adoptSupervisor(row.agentId)}
      />
    </View>
  );
}

function Seats({
  theme,
  seats,
  mobile,
  actions,
  initialUi,
}: {
  theme: PluginTheme;
  seats: NonNullable<PanelView["seats"]>;
  mobile: boolean;
  actions: ProjectPanelActions;
  initialUi?: ProjectPanelInitialUi;
}) {
  return (
    <Block theme={theme} testID="factory-panel-seats">
      <SectionTitle theme={theme} label="Seats" />
      <SeatRow theme={theme} name="Supervisor" row={seats.supervisor} mobile={mobile} actions={actions} {...(initialUi === undefined ? {} : { initialUi })} />
      <SeatRow theme={theme} name="Lead" row={seats.lead} mobile={mobile} actions={actions} />
      {seats.peers.length > 0 ? (
        <View testID="factory-panel-peers" style={{ gap: SPACING[1] }}>
          <Text style={text(theme, "label")}>Peers</Text>
          {seats.peers.map((peer) => (
            <PeerRowView key={peer.agentId} theme={theme} row={peer} actions={actions} />
          ))}
        </View>
      ) : null}
      {seats.supervisorCandidates.length > 0 ? (
        <View testID="factory-panel-supervisor-candidates" style={{ gap: SPACING[1] }}>
          <Text style={text(theme, "label")}>Supervisor candidates</Text>
          {seats.supervisorCandidates.map((candidate) => (
            <SupervisorCandidateRow key={candidate.agentId} theme={theme} row={candidate} actions={actions} />
          ))}
        </View>
      ) : null}
    </Block>
  );
}

/**
 * The Open Design card: a not-linked Project costs one line; a linked one
 * names the design and its last sync. Desktop mounts the Shell's actions
 * (Sync / Studio) in `desktopActions`; mobile shows the status alone.
 */
function OpenDesign({ theme, openDesign, now, desktopActions }: { theme: PluginTheme; openDesign: PanelOpenDesign; now: number; desktopActions: ReactNode }) {
  const broken = openDesign.state === "broken";
  return (
    <Block theme={theme} testID="factory-panel-od" {...(broken ? { border: "statusDanger" as const } : {})}>
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
    </Block>
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

/** Shared display body for seat and worker chips; W11 adds their editor actions. */
export function SeatModelChip({ theme, lane, pendingLane, seat }: { theme: PluginTheme; lane: ScopedLaneRef; pendingLane: ScopedLaneRef | null; seat: string }) {
  return <View testID={`factory-seat-chip-${seat}`} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1], borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.sm, paddingHorizontal: SPACING[1.5], paddingVertical: SPACING[0.5] }}>
    <Text style={text(theme, "label")}>{lane.model || lane.provider}{pendingLane === null ? "" : ` → ${pendingLane.model || pendingLane.provider}`}</Text>
    <Text style={{ ...text(theme, "label"), color: thinkingColour(theme, pendingLane?.thinking ?? lane.thinking) }}>{pendingLane?.thinking ?? lane.thinking ?? "off"}</Text>
    <Text style={text(theme, "meta")}>{lane.scope === "project" ? "Project" : "Machine"}</Text>
  </View>;
}

/** Independent progress also includes failed handoffs whose outgoing Peer no longer exists. */
export function HandoffBlock({ theme, handoffs }: { theme: PluginTheme; handoffs: PanelView["handoffs"] }) {
  if (handoffs.length === 0) return null;
  const palette = factoryPalette(theme);
  const colour = handoffs.some((h) => h.state === "failed") ? palette.bad : handoffs.every((h) => h.state === "done") ? palette.ok : palette.move;
  const stateLabel = { scheduled: "Scheduled", "handing-over": "Handing over", "creating-successor": "Creating successor", done: "Done", substitute: "Substitute handover", failed: "Failed" };
  return <View testID="factory-handoff-block" style={{ gap: SPACING[2], padding: SPACING[3], borderRadius: RADIUS.lg, borderWidth: 1, borderColor: colour, backgroundColor: tint(colour, "1a") }}>
    <SectionTitle theme={theme} label="Handoff" />
    {handoffs.map((handoff) => <View key={handoff.seat} testID={`factory-handoff-${handoff.seat}`} style={{ gap: SPACING[1] }}>
      <Text style={{ ...text(theme, "rowTitle"), color: handoff.state === "failed" ? palette.bad : handoff.state === "done" ? palette.ok : palette.move }}>{handoff.seat} · {stateLabel[handoff.state]}</Text>
      <Text style={text(theme, "meta")}>{handoff.reason === "context-mark" ? "Context mark" : handoff.reason === "provider-change" ? "Provider change" : "Owner requested"} · {handoff.fromLane.model} → {handoff.toLane.model}</Text>
      {handoff.waitingPeers === undefined ? null : <Text style={text(theme, "meta")}>Waiting for {handoff.waitingPeers} Peers</Text>}
      {handoff.handover === "substitute" ? <Text style={text(theme, "meta")}>Substitute handover</Text> : null}
      {handoff.failure === undefined ? null : <Text style={{ ...text(theme, "meta"), color: palette.bad }}>{handoff.failure}</Text>}
    </View>)}
  </View>;
}

export function SkillPacks({ theme, packs }: { theme: PluginTheme; packs: readonly MenuSkillPack[] }) {
  return <Block theme={theme} testID="factory-skill-packs">
    <SectionTitle theme={theme} label="Skill packs" />
    {packs.length === 0 ? <Text style={text(theme, "meta")}>No skill packs available.</Text> : packs.map((pack) => <Text key={pack.id} testID={`factory-panel-skill-${pack.id}`} style={text(theme, "meta")}>{pack.label} · {pack.enabled ? "on" : "off"}{pack.autoDetected ? " (auto-detected)" : ""}</Text>)}
  </Block>;
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
  width = 0,
  skillPacks = [],
}: {
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
  const hasMenu = panel.isProject && menu !== null;
  const boundary = (section: string, children: ReactNode) => <FactoryTabErrorBoundary theme={theme} section={section}>{children}</FactoryTabErrorBoundary>;
  const needsYou = <NeedsYou theme={theme} items={panel.needsYou} mobile={mobile} actions={actions} />;
  const handoff = <HandoffBlock theme={theme} handoffs={panel.handoffs} />;
  const seats = panel.seats === null ? null : <Seats theme={theme} seats={panel.seats} mobile={mobile} actions={actions} {...(initialUi === undefined ? {} : { initialUi })} />;
  const worker = panel.defaultWorker === null ? null : <Block theme={theme} testID="factory-default-worker"><SectionTitle theme={theme} label="Default worker" /><SeatModelChip theme={theme} seat="worker" lane={panel.defaultWorker.lane} pendingLane={null} /></Block>;
  const packs = <SkillPacks theme={theme} packs={skillPacks} />;
  const design = panel.openDesign === null ? null : <OpenDesign theme={theme} openDesign={panel.openDesign} now={now} desktopActions={mobile ? null : openDesignActions} />;
  return (
    <View testID="factory-panel" style={{ gap: SPACING[3] }}>
      <View style={{ gap: SPACING[1] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
          <Text accessibilityRole="header" style={{ ...text(theme, "detailTitle"), flexShrink: 1 }}>
            {panel.name ?? "Factory"}
          </Text>
          {panel.isProject ? <View testID="factory-profile-chip" style={{ flexShrink: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.sm, padding: SPACING[1.5] }}><Text style={text(theme, "label")}>{panel.profile.active?.name ?? "No Lane profile"}{panel.profile.modified ? " (modified)" : ""}</Text></View> : null}
          {hasMenu ? <Btn theme={theme} small testID="factory-panel-menu-toggle" label="⋯" tone="foregroundMuted" onPress={() => setMenuOpen(!menuOpen)} /> : null}
        </View>
        <Text style={text(theme, "meta")}>{panel.summary}</Text>
        {daemonError !== null ? <Text style={text(theme, "label", "statusWarning")}>{daemonError}</Text> : null}
      </View>
      {hasMenu && menuOpen ? <Block theme={theme} testID="factory-panel-menu">{menu}</Block> : null}
      {panel.isProject ? (
        <>
          {width >= 900 ? <View style={{ flexDirection: "row", gap: SPACING[4], alignItems: "flex-start" }}>
            <View testID="factory-tab-col-left" style={{ flex: 1, minWidth: 0, gap: SPACING[3] }}>{boundary("Needs you", needsYou)}{boundary("Seats", seats)}{boundary("Default worker", worker)}</View>
            <View testID="factory-tab-col-right" style={{ flex: 1, minWidth: 0, gap: SPACING[3] }}>{boundary("Handoff", handoff)}{boundary("Skill packs", packs)}{boundary("Open Design", design)}</View>
          </View> : <>{boundary("Needs you", needsYou)}{boundary("Handoff", handoff)}{boundary("Seats", seats)}{boundary("Default worker", worker)}{boundary("Skill packs", packs)}{boundary("Open Design", design)}</>}
        </>
      ) : (
        <NotAProject theme={theme} mobile={mobile} wizard={onboarding} />
      )}
    </View>
  );
}
