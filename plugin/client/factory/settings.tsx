/**
 * The Settings screen's render half (v0.6.0 W8, ADR 0056 §7): one scrolling
 * screen of collapsible machine-wide sections — Default models & Lane
 * profiles · Skills & Tools · Plugins · Vault · Diagnostics. A section whose
 * warning is non-null opens by default; the rest start collapsed. The
 * sections' bodies are slots the shell fills with the panes it owns the RPC
 * wiring for; on Paseo mobile the shell fills them with `SettingsReadOnly`
 * instead, so no settings write is ever mounted there. Pure render — no useRpc.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { CompanionPluginView, FactoryView } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import { SETTINGS_SECTION_ORDER } from "./settings-state.ts";
import type { SettingsSectionId, SettingsWarnings } from "./settings-state.ts";

const TITLES: Record<SettingsSectionId, string> = {
  models: "Default models & Lane profiles",
  "skills-tools": "Skills & Tools",
  plugins: "Plugins",
  vault: "Vault",
  diagnostics: "Diagnostics",
};

/** One collapsible section — its warning (if any) decides whether it starts open. */
function SettingsSection({ theme, id, warning, children }: { theme: PluginTheme; id: SettingsSectionId; warning: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(warning !== null);
  return (
    <Card theme={theme} gap={SPACING[2.5]}>
      <View testID={`settings-section-${id}`} style={{ gap: SPACING[2.5] }}>
        <Pressable
          testID={`settings-section-${id}-toggle`}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexWrap: "wrap" }}
        >
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
          <Text style={text(theme, "section")}>{TITLES[id]}</Text>
          {warning !== null ? <Pill theme={theme} label={warning} tone="statusWarning" lit /> : null}
        </Pressable>
        {open ? <View testID={`settings-section-${id}-body`} style={{ gap: SPACING[2.5] }}>{children}</View> : null}
      </View>
    </Card>
  );
}

export function SettingsScreen({ theme, warnings, slots }: { theme: PluginTheme; warnings: SettingsWarnings; slots: Record<SettingsSectionId, ReactNode> }) {
  return (
    <View style={{ gap: SPACING[3] }}>
      {SETTINGS_SECTION_ORDER.map((id) => (
        <SettingsSection key={id} theme={theme} id={id} warning={warnings[id]}>
          {slots[id]}
        </SettingsSection>
      ))}
    </View>
  );
}

function Row({ theme, label, value }: { theme: PluginTheme; label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
      <Text style={text(theme, "label")}>{label}</Text>
      <Text style={{ ...text(theme, "code"), flexShrink: 1 }}>{value}</Text>
    </View>
  );
}

const pluginLine = (p: CompanionPluginView): string =>
  `${p.version === null ? "" : `v${p.version} · `}${p.status.replace("_", " ")}${p.updateAvailable === true ? " · update available" : ""}`;

/** The mobile body of every section: values only, no write control (settings are view-only on Paseo mobile). */
export function SettingsReadOnly({ theme, view, section }: { theme: PluginTheme; view: FactoryView; section: SettingsSectionId }) {
  let rows: ReactNode;
  switch (section) {
    case "models":
      rows = Object.entries(view.lanes).map(([lane, value]) => <Row key={lane} theme={theme} label={lane} value={value} />);
      break;
    case "skills-tools":
      rows = [
        ...(view.companionTools ?? []).map((t) => <Row key={t.id} theme={theme} label={t.title} value={t.error ?? t.status.replace("_", " ")} />),
        ...(view.helperMcps ?? []).map((s) => <Row key={`mcp-${s.name}`} theme={theme} label={`${s.name} (Helper MCP)`} value={s.enabled ? s.status.replace("_", " ") : "local on host"} />),
        ...(view.skillHub === undefined ? [] : [<Row key="skills" theme={theme} label="Skills installed" value={String(view.skillHub.totalInstalled)} />]),
      ];
      break;
    case "plugins":
      rows = [view.corePlugin, ...view.companions].map((p) => <Row key={p.id} theme={theme} label={p.title} value={pluginLine(p)} />);
      break;
    case "vault":
      rows = [
        <Row key="repo" theme={theme} label="Repository" value={view.vault.configured ? (view.vault.repo ?? "configured") : "not configured"} />,
        ...(view.vault.lastPushedAt === null ? [] : [<Row key="pushed" theme={theme} label="Last synced" value={view.vault.lastPushedAt} />]),
      ];
      break;
    case "diagnostics":
      rows = [
        <Row key="daemon" theme={theme} label="Daemon" value={view.daemonError ?? "healthy"} />,
        <Row key="state" theme={theme} label="State directory" value={view.stateDir} />,
      ];
      break;
  }
  return (
    <View style={{ gap: SPACING[1.5] }}>
      {rows}
      <Text style={text(theme, "meta")}>View-only on mobile — change settings from Paseo Desktop.</Text>
    </View>
  );
}

/** The Diagnostics body — machine state the Owner reads when something is off. */
export function DiagnosticsBody({ theme, view, serverId }: { theme: PluginTheme; view: FactoryView; serverId?: string }) {
  return (
    <View style={{ gap: SPACING[1] }}>
      <Text style={text(theme, "code")}>stateDir: {view.stateDir}</Text>
      <Text style={text(theme, "code")}>serverId: {serverId ?? "local"}</Text>
      <Text style={text(theme, "code")}>daemon: {view.daemonError ?? "healthy"}</Text>
    </View>
  );
}

/** The prerequisite setup card (ADR 0036): missing Factory skills & tools with one Install action — the Skills & Tools section's banner. */
export function PrerequisiteSetupCard({
  theme,
  tools,
  installing,
  elapsedSeconds,
  busy,
  onInstall,
}: {
  theme: PluginTheme;
  tools: CompanionPluginView[];
  installing: boolean;
  elapsedSeconds: number;
  busy: boolean;
  onInstall: () => void;
}) {
  if (tools.length === 0) return null;
  return (
    <Card theme={theme} gap={SPACING[2]} style={{ borderColor: tint(theme.colors.statusWarning, "88"), backgroundColor: tint(theme.colors.statusWarning, "10") }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
          <Pill theme={theme} label="PREREQUISITE SETUP GATE" tone="statusWarning" lit />
          <Text style={text(theme, "rowTitle")}>Required Factory Skills & Tools Setup</Text>
          <Pill theme={theme} label={`${tools.length} required component${tools.length === 1 ? "" : "s"} missing or incomplete`} tone="statusWarning" />
        </View>
        <Btn theme={theme} small solid label={installing ? `Installing Prerequisites… (${elapsedSeconds}s)` : "Install Required Skills & Tools"} disabled={busy} onPress={onInstall} />
      </View>
      <Text style={text(theme, "meta")}>
        Factory requires these open-source skills and verification tools on this host before running SLP workflows. Click &quot;Install Required Skills &amp; Tools&quot; to install them directly from GitHub and npm.
      </Text>
      <View style={{ gap: SPACING[1] }}>
        {tools.map((tool) => (
          <View
            key={tool.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: SPACING[1.5],
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: RADIUS.md,
              backgroundColor: theme.colors.surface0,
              paddingHorizontal: SPACING[2.5],
              paddingVertical: SPACING[1.5],
            }}
          >
            <Text style={text(theme, "label")}>{tool.title}</Text>
            <Pill theme={theme} label={tool.canonicalSource} mono />
            {tool.error !== null ? <Text style={{ ...text(theme, "meta", "statusDanger"), flexShrink: 1 }}>{tool.error}</Text> : <Pill theme={theme} label="Not Installed" tone="statusWarning" />}
          </View>
        ))}
      </View>
    </Card>
  );
}
