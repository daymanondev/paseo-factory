import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { FactoryView } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { SPACING, text } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";

export function HelperMcpsCard({ theme, servers, actions }: {
  theme: PluginTheme;
  servers: NonNullable<FactoryView["helperMcps"]>;
  actions: { busy: boolean; syncHelpers?(): void; setHelperEnabled?(name: string, enabled: boolean): void };
}) {
  return (
<Card theme={theme}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: SPACING[3] }}>
          <View style={{ flex: 1, minWidth: 180, gap: SPACING[1] }}>
            <Text style={text(theme, "section")}>Helper MCP Servers (Peer)</Text>
            <Text style={text(theme, "meta", "foregroundMuted")}>Shared tools available to working Peers across providers.</Text>
          </View>
          <Btn theme={theme} label={actions.busy ? "Working…" : "Test & Sync MCPs"} icon="RefreshCw" disabled={actions.busy || !actions.syncHelpers} onPress={() => actions.syncHelpers?.()} />
        </View>
        {servers.length === 0 ? (
          <Text style={text(theme, "meta", "foregroundMuted")}>No helper servers found. Configure an MCP in Antigravity, Pi or Claude, then select Test &amp; Sync MCPs.</Text>
        ) : servers.map(server => {
          const health = {
            connected: { label: "Connected", tone: "statusSuccess" },
            auth_expired: { label: "Auth Expired", tone: "statusDanger" },
            missing_env: { label: "Missing Key", tone: "statusWarning" },
            unreachable: { label: "Unreachable", tone: "statusDanger" },
            disabled: { label: "Disabled", tone: "foregroundMuted" },
          }[server.status];
          return <View key={server.name} style={{ borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: SPACING[3], gap: SPACING[2] }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[2] }}>
              <Text style={{ ...text(theme, "label"), flexGrow: 1, flexShrink: 1 }}>{server.name}</Text>
              <Pill theme={theme} label={server.transport.toUpperCase()} />
              <Pill theme={theme} label={health.label} tone={health.tone as Colour} lit={server.status !== "disabled"} />
              <Btn theme={theme} small label={server.enabled ? "Disable" : "Enable"} tone="foregroundMuted" disabled={actions.busy || !actions.setHelperEnabled} onPress={() => actions.setHelperEnabled?.(server.name, !server.enabled)} />
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1] }}>
              {server.sources.map(source => <Pill key={source} theme={theme} label={source} />)}
            </View>
            {server.statusDetail ? <Text style={text(theme, "meta", "foregroundMuted")}>{server.statusDetail}</Text> : null}
          </View>;
        })}
      </Card>
  );
}
