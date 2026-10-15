/**
 * The persistent header (ADR 0009 §2; the Project Selector and Lead bridge
 * arrive in v0.0.14, ADR 0010 §1–§2): plain-language headline, freshness
 * dot, the five tabular-num KPI Stat Tiles (Needs Human, Running, Ready to
 * Accept, Accepted, Total Cost), the Project Selector (the panel auto-binds
 * its workspace's Project; the global screen picks across discovered
 * Projects), and the seat bridges — Open Supervisor + Quick Dispatch, and
 * Open Lead — scoped to the selected Project.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { FactoryView } from "../../shared/view.ts";
import { Btn, Chip } from "../kit/pill.tsx";
import { DOT, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";
import { GRACE_MS, pollEvery } from "../kit/poll.ts";

/** The header's whole action surface — the Shell owns the RPC calls. */
export interface HeaderActions {
  openSupervisor(message: string): void;
  /** Ensure-or-open the Project's Lead; the optional message dispatches. */
  openLead(message?: string): void;
  /** The Project Selector's pick — null returns to the unscoped global view. */
  pickProject(root: string | null): void;
  busy: boolean;
}

type StatKey = "needsHuman" | "running" | "readyToAccept" | "accepted";

const STATS: { key: StatKey; label: string; colour: Colour; icon?: string }[] = [
  { key: "needsHuman", label: "Needs Human", colour: "statusWarning", icon: "Bell" },
  { key: "running", label: "Running", colour: "accent" },
  { key: "readyToAccept", label: "Ready to Accept", colour: "statusSuccess", icon: "CheckCircle2" },
  { key: "accepted", label: "Accepted", colour: "foregroundMuted", icon: "Archive" },
];

function headlineOf(view: FactoryView): string {
  if (view.kpis.needsHuman > 0) return `${view.kpis.needsHuman} task${view.kpis.needsHuman === 1 ? "" : "s"} need${view.kpis.needsHuman === 1 ? "s" : ""} you`;
  if (view.kpis.running > 0) return `${view.kpis.running} under the gate`;
  if (view.kpis.readyToAccept > 0) return `${view.kpis.readyToAccept} green attempt${view.kpis.readyToAccept === 1 ? "" : "s"} await acceptance`;
  if (view.kpis.accepted > 0) return "Everything accepted";
  return "No tasks yet";
}

function readAgo(seconds: number): string {
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function StatTile({ theme, n, label, colour, icon }: { theme: PluginTheme; n: number | string; label: string; colour: string; icon?: string }) {
  const lit = typeof n === "number" && n > 0;
  return (
    <View
      accessibilityLabel={`${label}: ${n}`}
      style={{ paddingHorizontal: SPACING[3], paddingVertical: SPACING[2], borderRadius: RADIUS.lg, borderWidth: 1, borderColor: lit ? tint(colour, "55") : theme.colors.border, backgroundColor: lit ? tint(colour, "14") : theme.colors.surface1, gap: 2, flexGrow: 1, minWidth: 96 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
        {icon ? <Icon name={icon} size={13} color={lit ? colour : theme.colors.foregroundMuted} /> : <View style={{ width: DOT, height: DOT, borderRadius: DOT, backgroundColor: lit ? colour : tint(theme.colors.foregroundMuted, "88") }} />}
        <Text style={{ ...text(theme, "stat"), fontSize: 20, lineHeight: 24, fontWeight: "600", fontVariant: ["tabular-nums"], color: lit ? colour : theme.colors.foreground }}>{n}</Text>
      </View>
      <Text style={text(theme, "label")} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** One selector chip's label — the root's last path segment, falling back to the slug. */
function projectLabel(slug: string, root: string): string {
  const last = root.split("/").filter((segment) => segment !== "");
  return last.length > 0 ? (last[last.length - 1] as string) : slug;
}

export function Header({ theme, view, at, now, actions, supervisorLive, leadLive }: { theme: PluginTheme; view: FactoryView; at: number | null; now: number; actions: HeaderActions; supervisorLive: boolean; leadLive: boolean }) {
  const [dispatch, setDispatch] = useState("");
  const busy = (view.kpis.running + view.kpis.needsHuman) > 0;
  const fresh = at !== null && now - at <= pollEvery(busy) + GRACE_MS;
  const dollars = view.kpis.totalCostUsd > 0 ? `$${view.kpis.totalCostUsd.toFixed(2)}` : "$0";
  const project = view.project;
  return (
    <View style={{ gap: SPACING[3] }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[3] }}>
        <Text accessibilityRole="header" style={{ ...text(theme, "detailTitle"), fontSize: 20, lineHeight: 26, fontWeight: "600", flexShrink: 1, color: view.kpis.needsHuman > 0 ? theme.colors.statusWarning : theme.colors.foreground }}>
          {headlineOf(view)}
        </Text>
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
          {at !== null ? <View accessibilityLabel={fresh ? "up to date" : "overdue"} style={{ width: DOT, height: DOT, borderRadius: DOT, backgroundColor: fresh ? theme.colors.statusSuccess : theme.colors.statusWarning }} /> : null}
          <Text style={text(theme, "label")} numberOfLines={1}>
            {at !== null ? `updated ${readAgo(Math.max(0, Math.round((now - at) / 1000)))}` : "never updated"}
            {view.daemonError === null ? "" : " · daemon unreadable"}
          </Text>
        </View>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] }}>
        {STATS.map((stat) => (
          <StatTile key={stat.key} theme={theme} n={view.kpis[stat.key]} label={stat.label} colour={theme.colors[stat.colour]} icon={stat.icon} />
        ))}
        <StatTile theme={theme} n={dollars} label="Total Cost" colour={theme.colors.foreground} icon="Coins" />
      </View>

      {/* The Project Selector (v0.0.14, ADR 0010 §1): the active Project's chip is lit; "All projects" is the unscoped global view. */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <Chip theme={theme} label="All projects" active={project === null} count={0} onPress={() => actions.pickProject(null)} />
        {view.projects.map((entry) => (
          <Chip key={entry.slug} theme={theme} label={projectLabel(entry.slug, entry.root)} active={project?.slug === entry.slug} count={0} onPress={() => actions.pickProject(entry.root)} />
        ))}
        {project !== null ? <Text style={text(theme, "code")} numberOfLines={1}>{project.slug} · {project.root}</Text> : null}
      </View>

      {/* The seat bridges (ADR 0009 §2 + v0.0.14): ensure-or-open the Project's seats, dispatch optional. */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        <Btn theme={theme} label={supervisorLive ? "Open Supervisor" : "Ensure Supervisor"} disabled={actions.busy || project === null} onPress={() => actions.openSupervisor(dispatch)} tone="accent" />
        <Btn theme={theme} label={leadLive ? "Open Lead" : "Ensure Lead"} disabled={actions.busy || project === null} onPress={() => actions.openLead()} tone="accent" />
        <View style={{ flexBasis: 260, flexGrow: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.lg, backgroundColor: theme.colors.surface1 }}>
          <TextInput
            value={dispatch}
            onChangeText={setDispatch}
            placeholder={project === null ? "Pick a project to dispatch to its Supervisor" : "Quick dispatch to the Supervisor (optional)"}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{ paddingHorizontal: SPACING[3], paddingVertical: SPACING[2], color: theme.colors.foreground, fontSize: 13 }}
            onSubmitEditing={() => actions.openSupervisor(dispatch)}
          />
        </View>
        {dispatch.trim() !== "" && project !== null ? (
          <Btn theme={theme} label="Dispatch" small disabled={actions.busy} onPress={() => actions.openSupervisor(dispatch)} />
        ) : null}
      </View>
      {project === null ? <Text style={text(theme, "label")}>No project selected — the seat bridges and Ratify act on the selected Project.</Text> : null}
      {view.daemonError !== null ? <Text style={text(theme, "label", "statusWarning")}>{view.daemonError}</Text> : null}
    </View>
  );
}
