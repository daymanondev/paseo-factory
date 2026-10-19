/**
 * The persistent header (ADR 0009 §2; the Project Selector and Lead bridge
 * arrive in v0.0.14, ADR 0010 §1–§2): plain-language headline, freshness
 * dot, the five tabular-num KPI Stat Tiles (Needs Human, Running, Ready to
 * Accept, Accepted, Total Cost), the Project Selector (the panel auto-binds
 * its workspace's Project; the global screen picks across discovered
 * Projects), and the seat bridges — Start/Open Supervisor and Start/Open Lead,
 * always rendered once a Project is selected (v0.0.20, ADR 0013 §3) so a
 * brand-new Project offers its header action on day one.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { FactoryView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill } from "../kit/pill.tsx";
import { CONTROL_SM, DOT, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
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

const STATS: { key: StatKey; label: string; colour: Colour; icon: string }[] = [
  { key: "needsHuman", label: "Needs Human", colour: "statusWarning", icon: "Bell" },
  { key: "running", label: "Running", colour: "accent", icon: "Play" },
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

function StatTile({
  theme,
  n,
  label,
  colour,
  icon,
  highlight = false,
}: {
  theme: PluginTheme;
  n: number | string;
  label: string;
  colour: string;
  icon: string;
  highlight?: boolean;
}) {
  const lit = highlight || (typeof n === "number" && n > 0);
  return (
    <View
      accessibilityLabel={`${label}: ${n}`}
      style={{
        flex: 1,
        flexBasis: 120,
        minWidth: 120,
        paddingHorizontal: SPACING[3],
        paddingVertical: SPACING[2.5],
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: lit ? tint(colour, "66") : theme.colors.border,
        backgroundColor: lit ? tint(colour, "12") : theme.colors.surface1,
        gap: SPACING[1],
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[1.5] }}>
        <Text style={text(theme, "label")} numberOfLines={1}>
          {label}
        </Text>
        <Icon name={icon} size={13} color={lit ? colour : theme.colors.foregroundMuted} />
      </View>
      <Text
        style={{
          ...text(theme, "stat"),
          fontSize: 22,
          lineHeight: 26,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
          color: lit ? colour : theme.colors.foreground,
        }}
        numberOfLines={1}
      >
        {n}
      </Text>
    </View>
  );
}

/** One selector chip's label — the root's last path segment, falling back to the slug. */
function projectLabel(slug: string, root: string): string {
  const last = root.split("/").filter((segment) => segment !== "");
  return last.length > 0 ? (last[last.length - 1] as string) : slug;
}

export function Header({
  theme,
  view,
  at,
  now,
  actions,
  supervisorLive,
  leadLive,
}: {
  theme: PluginTheme;
  view: FactoryView;
  at: number | null;
  now: number;
  actions: HeaderActions;
  supervisorLive: boolean;
  leadLive: boolean;
}) {
  const [pickingPath, setPickingPath] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const busy = view.kpis.running + view.kpis.needsHuman > 0;
  const fresh = at !== null && now - at <= pollEvery(busy) + GRACE_MS;
  const dollars = view.kpis.totalCostUsd > 0 ? `$${view.kpis.totalCostUsd.toFixed(2)}` : "$0";
  const project = view.project;
  const submitPath = (): void => {
    const trimmed = customPath.trim();
    if (trimmed === "") return;
    actions.pickProject(trimmed);
    setPickingPath(false);
  };
  return (
    <View style={{ gap: SPACING[3] }}>
      {/* Top status bar: Headline + Freshness */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexShrink: 1 }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 99,
              backgroundColor:
                view.kpis.needsHuman > 0
                  ? theme.colors.statusWarning
                  : view.kpis.running > 0
                    ? theme.colors.accent
                    : view.kpis.readyToAccept > 0
                      ? theme.colors.statusSuccess
                      : theme.colors.foregroundMuted,
            }}
          />
          <Text
            accessibilityRole="header"
            style={{
              ...text(theme, "detailTitle"),
              fontSize: 18,
              lineHeight: 24,
              fontWeight: "600",
              flexShrink: 1,
              color: view.kpis.needsHuman > 0 ? theme.colors.statusWarning : theme.colors.foreground,
            }}
          >
            {headlineOf(view)}
          </Text>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: SPACING[1.5],
            paddingHorizontal: SPACING[2.5],
            paddingVertical: 3,
            borderRadius: RADIUS.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          {at !== null ? (
            <View
              accessibilityLabel={fresh ? "up to date" : "overdue"}
              style={{
                width: DOT - 2,
                height: DOT - 2,
                borderRadius: DOT,
                backgroundColor: fresh ? theme.colors.statusSuccess : theme.colors.statusWarning,
              }}
            />
          ) : null}
          <Text style={{ ...text(theme, "badge"), fontVariant: ["tabular-nums"] }} numberOfLines={1}>
            {at !== null ? `updated ${readAgo(Math.max(0, Math.round((now - at) / 1000)))}` : "never updated"}
            {view.daemonError === null ? "" : " · daemon unreadable"}
          </Text>
        </View>
      </View>

      {/* Equal-width KPI Stat Tiles */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] }}>
        {STATS.map((stat) => (
          <StatTile key={stat.key} theme={theme} n={view.kpis[stat.key]} label={stat.label} colour={theme.colors[stat.colour]} icon={stat.icon} />
        ))}
        <StatTile theme={theme} n={dollars} label="Total Cost" colour={theme.colors.foreground} icon="Coins" />
      </View>

      {/* Project Scope Bar */}
      <Card theme={theme} gap={SPACING[2]}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1], paddingRight: SPACING[1] }}>
            <Icon name="FolderGit2" size={13} color={theme.colors.foregroundMuted} />
            <Text style={text(theme, "badge")}>PROJECT</Text>
          </View>
          <Chip theme={theme} label="All projects" active={project === null} count={0} onPress={() => actions.pickProject(null)} />
          {view.projects.map((entry) => (
            <Chip
              key={entry.slug}
              theme={theme}
              label={projectLabel(entry.slug, entry.root)}
              active={project?.slug === entry.slug}
              count={0}
              onPress={() => actions.pickProject(entry.root)}
            />
          ))}
          <Btn
            theme={theme}
            small
            icon={pickingPath ? "X" : "FolderPlus"}
            label={pickingPath ? "Cancel" : "Add repo"}
            tone="foregroundMuted"
            onPress={() => setPickingPath((v) => !v)}
          />
          <View style={{ marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
            {project !== null ? <Pill theme={theme} label={project.slug} mono /> : null}
            {/* The seat bridges (v0.0.20, ADR 0013 §3): ALWAYS rendered once a
                Project is selected — Start when the seat is vacant, Open when
                it lives — so a brand-new Project offers its header action on
                day one. Both ride the shell's ensure-then-open wiring, which
                creates the seat when none exists. */}
            {project !== null ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
                <Btn
                  theme={theme}
                  small
                  icon="Shield"
                  label={supervisorLive ? "Open Supervisor" : "Start Supervisor"}
                  tone="accent"
                  disabled={actions.busy}
                  onPress={() => actions.openSupervisor("")}
                />
                <Btn
                  theme={theme}
                  small
                  icon="Compass"
                  label={leadLive ? "Open Lead" : "Start Lead"}
                  tone="accent"
                  disabled={actions.busy}
                  onPress={() => actions.openLead()}
                />
              </View>
            ) : null}
          </View>
        </View>

        {pickingPath ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
            <View
              style={{
                flexBasis: 240,
                flexGrow: 1,
                minHeight: CONTROL_SM,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: RADIUS.md,
                backgroundColor: theme.colors.surface0,
              }}
            >
              <TextInput
                value={customPath}
                onChangeText={setCustomPath}
                placeholder="/path/to/git-repo"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 4, color: theme.colors.foreground, fontSize: 12 }}
                onSubmitEditing={submitPath}
              />
            </View>
            <Btn theme={theme} small icon="Check" label="Select Project" tone="accent" disabled={customPath.trim() === ""} onPress={submitPath} />
          </View>
        ) : null}
      </Card>

      {view.daemonError !== null ? (
        <Card theme={theme} style={{ borderColor: tint(theme.colors.statusWarning, "66"), backgroundColor: tint(theme.colors.statusWarning, "12") }}>
          <Text style={text(theme, "label", "statusWarning")}>{view.daemonError}</Text>
        </Card>
      ) : null}
    </View>
  );
}
