/**
 * The Project panel (v0.6.0 W5, ADR 0056 §5) — the workspace panel's one
 * column, top to bottom: header (name, one summary line), Needs you (only
 * when something does), Seats (Supervisor, Lead with its `Nk / 128k` context
 * bar and handoff state, live Peers), Open Design. A pure render of the
 * server-projected `PanelView` (plugin/server/panel.ts): it derives no state,
 * calls no RPC, and draws colour only for exceptions — red for errors and
 * stuck items, amber for waiting states and items that need the Owner.
 * Read-only by construction: no acceptance, no Lead start, and the seat actions
 * (Open / Rotate / Revoke, the header `⋯`, Start Supervisor) arrive in W6.
 * Test hooks: `factory-panel-needs-you`, `factory-panel-seat-<role>`,
 * `factory-panel-od`. Function components only — no class syntax reaches
 * the Hermes bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { PanelNeedsYouItem, PanelOpenDesign, PanelPeerRow, PanelSeatRow, PanelTone, PanelView } from "../../shared/view.ts";
import { Btn } from "../kit/pill.tsx";
import { RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";

/** The panel's action surface — the Shell owns the RPC and navigation calls. */
export interface ProjectPanelActions {
  /** Jump to an agent's conversation — a Needs-you item's primary action. */
  openAgent(agentId: string): void;
  /** Install the missing required skills & tools (desktop only — a settings write). */
  installPrerequisites(): void;
  busy: boolean;
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
  return (
    <View testID={`factory-panel-needs-you-${item.key}`} style={{ gap: SPACING[1], paddingVertical: SPACING[1] }}>
      <Text style={text(theme, "rowTitle", colour)}>{item.title}</Text>
      {item.detail !== null ? <Text style={text(theme, "meta")}>{item.detail}</Text> : null}
      {action !== null && action.kind === "open-agent" ? (
        <Btn theme={theme} small label={action.label} onPress={() => actions.openAgent(action.agentId)} />
      ) : null}
      {action !== null && action.kind === "install-prerequisites" && !mobile ? (
        <Btn theme={theme} small label={action.label} disabled={actions.busy} onPress={actions.installPrerequisites} />
      ) : null}
      {action !== null && action.kind === "open-design" ? <Text style={text(theme, "meta")}>See Open Design below.</Text> : null}
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

function SeatRow({ theme, name, row }: { theme: PluginTheme; name: string; row: PanelSeatRow }) {
  const colour = toneColour(row.tone);
  const handoffWaiting = row.handoff !== null && row.handoff.state !== "normal";
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
    </View>
  );
}

function PeerRowView({ theme, row }: { theme: PluginTheme; row: PanelPeerRow }) {
  const colour = toneColour(row.tone);
  return (
    <View testID={`factory-panel-seat-peer-${row.task}`} style={{ gap: SPACING[0.5], paddingVertical: SPACING[1] }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        <Text style={text(theme, "rowTitle")}>{row.title}</Text>
        <Text style={text(theme, "label")}>{row.disposition}</Text>
        <Text style={text(theme, "label", colour)}>{row.statusLabel}</Text>
      </View>
      {row.model !== null ? <Text style={text(theme, "code", "foregroundMuted")} numberOfLines={1}>{row.model}</Text> : null}
    </View>
  );
}

function Seats({ theme, seats }: { theme: PluginTheme; seats: NonNullable<PanelView["seats"]> }) {
  return (
    <Block theme={theme} testID="factory-panel-seats">
      <SectionTitle theme={theme} label="Seats" />
      <SeatRow theme={theme} name="Supervisor" row={seats.supervisor} />
      <SeatRow theme={theme} name="Lead" row={seats.lead} />
      {seats.peers.length > 0 ? (
        <View testID="factory-panel-peers" style={{ gap: SPACING[1] }}>
          <Text style={text(theme, "label")}>Peers</Text>
          {seats.peers.map((peer) => (
            <PeerRowView key={peer.agentId} theme={theme} row={peer} />
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

/** A workspace that is not yet a Project: mobile points at Desktop; desktop shows what the folder has. */
function NotAProject({ theme, panel, mobile }: { theme: PluginTheme; panel: PanelView; mobile: boolean }) {
  const onboarding = panel.onboarding;
  return (
    <Block theme={theme} testID="factory-panel-onboarding">
      {mobile ? (
        <Text style={text(theme, "meta")}>Set this Project up on Paseo Desktop.</Text>
      ) : (
        <View style={{ gap: SPACING[1] }}>
          {onboarding?.folder != null ? <Text style={text(theme, "code", "foregroundMuted")} numberOfLines={1}>{onboarding.folder}</Text> : null}
          <Text style={text(theme, "meta")}>Git repository: {onboarding?.gitRepo === true ? "yes" : "no"}</Text>
          {onboarding?.gitRepo === true && !onboarding.hasCommits ? <Text style={text(theme, "meta", "statusWarning")}>No commits yet — worktrees may not branch until there is one.</Text> : null}
          {onboarding?.existingLead === true ? <Text style={text(theme, "meta", "statusWarning")}>A Lead is already running in this folder.</Text> : null}
          <Text style={text(theme, "meta")}>Start “Supervisor (Factory)” from New Chat to begin.</Text>
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
}) {
  return (
    <View testID="factory-panel" style={{ gap: SPACING[3] }}>
      <View style={{ gap: SPACING[1] }}>
        <Text accessibilityRole="header" style={text(theme, "detailTitle")}>
          {panel.name ?? "Factory"}
        </Text>
        <Text style={text(theme, "meta")}>{panel.summary}</Text>
        {daemonError !== null ? <Text style={text(theme, "label", "statusWarning")}>{daemonError}</Text> : null}
      </View>
      {panel.isProject ? (
        <>
          <NeedsYou theme={theme} items={panel.needsYou} mobile={mobile} actions={actions} />
          {panel.seats !== null ? <Seats theme={theme} seats={panel.seats} /> : null}
          {panel.openDesign !== null ? <OpenDesign theme={theme} openDesign={panel.openDesign} now={now} desktopActions={mobile ? null : openDesignActions} /> : null}
        </>
      ) : (
        <NotAProject theme={theme} panel={panel} mobile={mobile} />
      )}
    </View>
  );
}
