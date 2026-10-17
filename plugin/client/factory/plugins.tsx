/**
 * Tab 4 — Plugins, the `Companion plugin` catalog (v0.0.17, ADR 0012 §1/§2):
 * a summary header over the Factory companion ecosystem (how many companions
 * run on this daemon, plus Install All when any is uninstalled), then one
 * card per CompanionPluginView — header row (sidebar icon, title, plugin id
 * badge, status pill, Active in Sidebar when running), tagline, description,
 * capability pills, the installation metadata row (canonical source, or
 * installKind + installedSource + short revision), the daemon error banner,
 * and the state-correct action bar (Install / Custom source… when absent;
 * Enable·Disable, Update, Reload, Remove when installed). The Shell owns the
 * RPC calls — this pane is a pure render of the view plus action callbacks.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { CompanionCatalogEntry } from "../../shared/companions.ts";
import type { CompanionPluginView, CompanionStatus, FactoryView } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { CONTROL_H, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";

/** The two companion ids the catalog carries — the RPC enums minus "all". */
type CompanionId = CompanionCatalogEntry["id"];

/** The Plugins tab's whole action surface — the Shell owns the RPC calls. */
export interface PluginsActions {
  /** Install one companion (canonical source by default, or a custom source/ref) or every uninstalled companion ("all"). */
  install(target: CompanionId | "all", source?: string, ref?: string): void;
  /** One lifecycle act on an installed companion. */
  manage(pluginId: CompanionId, action: "enable" | "disable" | "reload" | "update" | "remove"): void;
  busy: boolean;
}

/** The status pill's four faces — Running green, Failed danger, the rest muted (the tasks.tsx statusTone law). */
const STATUS: Record<CompanionStatus, { label: string; tone: Colour; lit: boolean }> = {
  running: { label: "Running", tone: "statusSuccess", lit: true },
  disabled: { label: "Disabled", tone: "foregroundMuted", lit: false },
  failed: { label: "Failed", tone: "statusDanger", lit: true },
  not_installed: { label: "Not Installed", tone: "foregroundMuted", lit: false },
};

/** One companion's card — the catalog entry joined with its live daemon state. */
function CompanionCard({ theme, companion, actions }: { theme: PluginTheme; companion: CompanionPluginView; actions: PluginsActions }) {
  const [customOpen, setCustomOpen] = useState(false);
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const status = STATUS[companion.status];
  // The fold joins COMPANION_CATALOG against the daemon list, so every view
  // id is a catalog id — narrow the wire's plain string back to the enum.
  const id = companion.id as CompanionId;
  const installed = companion.status !== "not_installed";
  const remote = companion.installKind === "git" || companion.installKind === "npm";
  const shortRevision = companion.currentRevision === null ? null : companion.currentRevision.slice(0, 7);
  const trimmedSource = source.trim();
  const trimmedRef = ref.trim();

  return (
    <Card theme={theme} gap={SPACING[2]}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <Icon name={companion.sidebarIcon} size={15} color={theme.colors.accent} />
        <Text style={text(theme, "rowTitle")}>{companion.title}</Text>
        <Pill theme={theme} label={companion.id} mono />
        <Pill theme={theme} label={status.label} tone={status.tone} lit={status.lit} />
        {companion.status === "running" ? (
          <Pill theme={theme} label={`Active in Sidebar · ${companion.sidebarLabel}`} tone="accent" lit />
        ) : null}
      </View>

      <Text style={text(theme, "label")}>{companion.tagline}</Text>
      <Text style={text(theme, "meta")}>{companion.description}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
        {companion.capabilities.map((capability) => (
          <Pill key={capability} theme={theme} label={capability} mono />
        ))}
      </View>

      {/* The installation metadata row — what the daemon runs, or would install. */}
      <View
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: RADIUS.md,
          backgroundColor: theme.colors.surface0,
          padding: SPACING[2],
          gap: SPACING[1],
        }}
      >
        <Text style={text(theme, "badge")}>INSTALL</Text>
        {!installed ? (
          <Text style={text(theme, "code")} numberOfLines={1}>
            {companion.canonicalSource}
          </Text>
        ) : (
          <Text style={text(theme, "code")} numberOfLines={1}>
            {companion.installKind} · {companion.installedSource ?? "—"}
            {shortRevision !== null ? ` · ${shortRevision}` : ""}
          </Text>
        )}
      </View>

      {companion.error !== null ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: tint(theme.colors.statusDanger, "66"),
            borderRadius: RADIUS.md,
            backgroundColor: tint(theme.colors.statusDanger, "12"),
            padding: SPACING[2],
          }}
        >
          <Text style={text(theme, "label", "statusDanger")}>{companion.error}</Text>
        </View>
      ) : null}

      {!installed ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Btn theme={theme} small label="Install" solid disabled={actions.busy} onPress={() => actions.install(id)} />
          <Btn theme={theme} small label="Custom source…" tone="foregroundMuted" disabled={actions.busy} onPress={() => setCustomOpen(!customOpen)} />
        </View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          {companion.enabled ? (
            <Btn theme={theme} small label="Disable" disabled={actions.busy} onPress={() => actions.manage(id, "disable")} />
          ) : (
            <Btn theme={theme} small label="Enable" disabled={actions.busy} onPress={() => actions.manage(id, "enable")} />
          )}
          {remote ? <Btn theme={theme} small label="Update" disabled={actions.busy} onPress={() => actions.manage(id, "update")} /> : null}
          <Btn theme={theme} small label="Reload" tone="foregroundMuted" disabled={actions.busy} onPress={() => actions.manage(id, "reload")} />
          <Btn theme={theme} small label="Remove" tone="statusDanger" disabled={actions.busy} onPress={() => actions.manage(id, "remove")} />
        </View>
      )}

      {/* The developer escape hatch — a custom Git source/ref or an explicit local directory. */}
      {customOpen && !installed ? (
        <View style={{ gap: SPACING[1.5] }}>
          <View style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>Source</Text>
            <View
              style={{
                minHeight: CONTROL_H,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: RADIUS.md,
                backgroundColor: theme.colors.surface1,
              }}
            >
              <TextInput
                value={source}
                onChangeText={setSource}
                placeholder={`git:daymanondev/${companion.id}:plugin or /path/to/plugin`}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}
              />
            </View>
          </View>
          <View style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>Ref (branch/tag/commit) — optional</Text>
            <View
              style={{
                minHeight: CONTROL_H,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: RADIUS.md,
                backgroundColor: theme.colors.surface1,
              }}
            >
              <TextInput
                value={ref}
                onChangeText={setRef}
                placeholder="e.g. feat/x, v0.2.0, 9f3b2c1"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}
              />
            </View>
          </View>
          <Btn
            theme={theme}
            small
            label="Install Custom"
            disabled={actions.busy || trimmedSource === ""}
            onPress={() => actions.install(id, trimmedSource, trimmedRef === "" ? undefined : trimmedRef)}
          />
        </View>
      ) : null}
    </Card>
  );
}

export function PluginsPane({ theme, view, actions }: { theme: PluginTheme; view: FactoryView; actions: PluginsActions }) {
  const running = view.companions.filter((c) => c.status === "running").length;
  const anyUninstalled = view.companions.some((c) => c.status === "not_installed");
  return (
    <View style={{ gap: SPACING[3] }}>
      <Card theme={theme} gap={SPACING[2]}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
          <View style={{ gap: 2, flexShrink: 1 }}>
            <Text style={text(theme, "section")}>Factory companion ecosystem</Text>
            <Text style={text(theme, "meta")}>
              paseo-factory is the verification core; its companion plugins extend the factory — Burn Lab runs free-model burns under the Supervisor's
              watch, Fleet Connector links peer factories over Tailscale. {running} of {view.companions.length} active on this daemon.
            </Text>
          </View>
          {anyUninstalled ? (
            <Btn theme={theme} small label="Install All" solid disabled={actions.busy} onPress={() => actions.install("all")} />
          ) : null}
        </View>
      </Card>
      {view.companions.map((companion) => (
        <CompanionCard key={companion.id} theme={theme} companion={companion} actions={actions} />
      ))}
    </View>
  );
}
