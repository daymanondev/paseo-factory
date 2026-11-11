/**
 * The Project panel (v0.6.0 W5, ADR 0056 §5) — the workspace panel's one
 * column, top to bottom: header (name, one summary line), Needs you (only
 * when something does), Seats (Supervisor, Lead with its `Nk / 128k` context
 * bar and handoff state, live Peers), Open Design. A pure render of the
 * server-projected `PanelView` (plugin/server/panel.ts): it derives no state,
 * calls no RPC, and draws colour only for exceptions — red for errors and
 * stuck items, amber for waiting states and items that need the Owner.
 * Actions (W6): every live seat row has Open; the Lead row has Rotate; the
 * Supervisor row's `⋯` holds Revoke; a vacant Supervisor row offers Start
 * Supervisor with a directive box (desktop only — it creates the seat through
 * the ADR 0017 amendment path); the header `⋯` toggles the Project menu the
 * shell supplies (project-menu.tsx). There is NO Accept and NO Lead start —
 * a vacant Lead only says to ask the Supervisor. Mobile keeps Open, Rotate and
 * Revoke; Start Supervisor, Sync/Studio and the menu's writes are desktop only.
 * A workspace that is not yet a Project shows the onboarding wizard the Shell
 * supplies (W7, onboarding-wizard.tsx) on desktop, and only "set this Project
 * up on Paseo Desktop" on mobile.
 * Test hooks: `factory-panel-needs-you`, `factory-panel-seat-<role>`,
 * `factory-panel-od`, `factory-panel-open-<role|peer-T>`,
 * `factory-panel-rotate-lead`, `factory-panel-supervisor-menu`,
 * `factory-panel-revoke-supervisor`, `factory-panel-start-supervisor`,
 * `factory-panel-directive`, `factory-panel-menu-toggle`, `factory-panel-menu`.
 * UI-only state (open menus, the directive draft) is local; `initialUi` seeds
 * it. Function components only — no class syntax reaches the Hermes bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { PanelNeedsYouItem, PanelOpenDesign, PanelPeerRow, PanelSeatRow, PanelTone, PanelView } from "../../shared/view.ts";
import { Btn } from "../kit/pill.tsx";
import { CONTROL_H, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";

/** The panel's action surface — the Shell owns the RPC and navigation calls. */
export interface ProjectPanelActions {
  /** Jump to an agent's conversation — a Needs-you item's primary action. */
  openAgent(agentId: string): void;
  /** Install the missing required skills & tools (desktop only — a settings write). */
  installPrerequisites(): void;
  /** Retire the live Lead so the next dispatch starts a fresh one (also on mobile). */
  rotateLead(): void;
  /** Retire the live Supervisor — the seat row's `⋯` act (also on mobile). */
  revokeSupervisor(): void;
  /** Start the Supervisor on a vacant seat with the Owner's optional first directive (desktop only). */
  startSupervisor(directive: string): void;
  /** Sync the linked Open Design project again from the host — a broken link's primary action (desktop only). */
  syncOpenDesign(): void;
  busy: boolean;
}

/** UI-only state a host may seed — what is open and the directive draft. Never data. */
export interface ProjectPanelInitialUi {
  menuOpen?: boolean;
  supervisorMenuOpen?: boolean;
  directive?: string;
}

/** Items the Owner must resolve themselves are red; items that wait on the Owner's attention are amber. */
const NEEDS_YOU_TONE: Record<PanelNeedsYouItem["kind"], Colour> = {
  "needs-human": "statusWarning",
  "attempt-ceiling": "statusDanger",
  "seat-stuck": "statusDanger",
  "handoff-stuck": "statusDanger",
  prerequisites: "statusWarning",
  "open-design-broken": "statusDanger",
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

/** One bordered block of rows — flat, one line per thing. */
function Block({ theme, testID, border, children }: { theme: PluginTheme; testID?: string; border?: Colour; children: ReactNode }) {
  return (
    <View
      testID={testID}
      style={{
        gap: SPACING[2],
        padding: SPACING[3],
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: border === undefined ? theme.colors.border : tint(theme.colors[border], "66"),
        backgroundColor: border === undefined ? theme.colors.surface1 : tint(theme.colors[border], "10"),
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
      <Text style={text(theme, "rowTitle", colour)}>{item.title}</Text>
      {item.detail !== null ? <Text style={text(theme, "meta")}>{item.detail}</Text> : null}
      {action.kind === "open-agent" ? (
        <Btn theme={theme} small testID={buttonId} label={action.label} onPress={() => actions.openAgent(action.agentId)} />
      ) : mobile ? (
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

/** The Lead's context-window bar — a neutral track and fill; the label says `Nk / 128k`. */
function ContextBar({ theme, context }: { theme: PluginTheme; context: NonNullable<PanelSeatRow["context"]> }) {
  return (
    <View style={{ gap: SPACING[0.5] }}>
      <Text style={text(theme, "meta")}>Context {context.label}</Text>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        <View style={{ height: 4, width: `${Math.round((context.fraction ?? 0) * 100)}%`, backgroundColor: theme.colors.foregroundMuted }} />
      </View>
    </View>
  );
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
  const handoffWaiting = row.handoff !== null && row.handoff.state !== "normal";
  const [menuOpen, setMenuOpen] = useState(initialUi?.supervisorMenuOpen === true);
  const [directive, setDirective] = useState(initialUi?.directive ?? "");
  const isSupervisor = row.role === "supervisor";
  const live = !row.vacant && row.agentId !== null;
  const agentId = row.agentId;
  return (
    <View testID={`factory-panel-seat-${row.role}`} style={{ gap: SPACING[1], paddingVertical: SPACING[1] }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        <Text style={text(theme, "rowTitle")}>{name}</Text>
        <Text style={text(theme, "label", colour)}>{row.statusLabel}</Text>
        {row.model !== null ? <Text style={text(theme, "code", "foregroundMuted")} numberOfLines={1}>{row.model}</Text> : null}
      </View>
      {row.hint !== null ? <Text style={text(theme, "meta", colour)}>{row.hint}</Text> : null}
      {row.context !== null ? <ContextBar theme={theme} context={row.context} /> : null}
      {row.handoff !== null ? <Text style={text(theme, "meta", handoffWaiting ? "statusWarning" : undefined)}>Handoff: {row.handoff.label}</Text> : null}
      {live && agentId !== null ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Btn theme={theme} small testID={`factory-panel-open-${row.role}`} label="Open" onPress={() => actions.openAgent(agentId)} />
          {row.role === "lead" ? (
            <Btn theme={theme} small testID="factory-panel-rotate-lead" label="Rotate" tone="foregroundMuted" disabled={actions.busy} onPress={actions.rotateLead} />
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
            label="Revoke Supervisor"
            tone="statusDanger"
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
    </View>
  );
}

function PeerRowView({ theme, row, actions }: { theme: PluginTheme; row: PanelPeerRow; actions: ProjectPanelActions }) {
  const colour = toneColour(row.tone);
  return (
    <View testID={`factory-panel-seat-peer-${row.task}`} style={{ gap: SPACING[0.5], paddingVertical: SPACING[1] }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        <Text style={text(theme, "rowTitle")}>{row.title}</Text>
        <Text style={text(theme, "label")}>{row.disposition}</Text>
        <Text style={text(theme, "label", colour)}>{row.statusLabel}</Text>
      </View>
      {row.model !== null ? <Text style={text(theme, "code", "foregroundMuted")} numberOfLines={1}>{row.model}</Text> : null}
      <Btn theme={theme} small testID={`factory-panel-open-peer-${row.task}`} label="Open" onPress={() => actions.openAgent(row.agentId)} />
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
}: {
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
  return (
    <View testID="factory-panel" style={{ gap: SPACING[3] }}>
      <View style={{ gap: SPACING[1] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
          <Text accessibilityRole="header" style={{ ...text(theme, "detailTitle"), flexShrink: 1 }}>
            {panel.name ?? "Factory"}
          </Text>
          {hasMenu ? <Btn theme={theme} small testID="factory-panel-menu-toggle" label="⋯" tone="foregroundMuted" onPress={() => setMenuOpen(!menuOpen)} /> : null}
        </View>
        <Text style={text(theme, "meta")}>{panel.summary}</Text>
        {daemonError !== null ? <Text style={text(theme, "label", "statusWarning")}>{daemonError}</Text> : null}
      </View>
      {hasMenu && menuOpen ? <Block theme={theme} testID="factory-panel-menu">{menu}</Block> : null}
      {panel.isProject ? (
        <>
          <NeedsYou theme={theme} items={panel.needsYou} mobile={mobile} actions={actions} />
          {panel.seats !== null ? <Seats theme={theme} seats={panel.seats} mobile={mobile} actions={actions} {...(initialUi === undefined ? {} : { initialUi })} /> : null}
          {panel.openDesign !== null ? <OpenDesign theme={theme} openDesign={panel.openDesign} now={now} desktopActions={mobile ? null : openDesignActions} /> : null}
        </>
      ) : (
        <NotAProject theme={theme} mobile={mobile} wizard={onboarding} />
      )}
    </View>
  );
}
