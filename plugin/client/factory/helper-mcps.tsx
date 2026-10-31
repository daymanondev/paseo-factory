/** Peer helper summary with separate synced and local-host management tabs (ADR 0039). */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { FactoryView, HelperMcpConfigUpdate } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill } from "../kit/pill.tsx";
import { DOT, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";

type HelperServer = NonNullable<FactoryView["helperMcps"]>[number];
type HelperFilter = "synced" | "local" | "attention";
const TARGETS = [
  { provider: "pi", label: "Pi" }, { provider: "claude", label: "Claude" },
  { provider: "codex", label: "Codex" }, { provider: "opencode", label: "OpenCode" },
] as const;
const HEALTH: Record<HelperServer["status"], { label: string; tone: Colour; lit: boolean; isIssue: boolean }> = {
  connected: { label: "Connected", tone: "statusSuccess", lit: false, isIssue: false },
  auth_expired: { label: "Auth Expired", tone: "statusDanger", lit: true, isIssue: true },
  missing_env: { label: "Missing Key", tone: "statusWarning", lit: true, isIssue: true },
  unreachable: { label: "Unreachable", tone: "statusDanger", lit: true, isIssue: true },
  disabled: { label: "Local on Host", tone: "foregroundMuted", lit: false, isIssue: false },
};

/** A target stays keyboard accessible and announces its selected state. */
function TargetPill({ theme, label, selected, disabled, onPress, tone = "accent" }: {
  theme: PluginTheme; label: string; selected: boolean; disabled: boolean; onPress(): void; tone?: Colour;
}) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.5 : pressed ? 0.72 : 1, paddingVertical: SPACING[1] })}>
      <Pill theme={theme} label={label} tone={selected ? tone : "foregroundMuted"} lit={selected} />
    </Pressable>
  );
}

export function HelperMcpsCard({ theme, servers, actions }: {
  theme: PluginTheme;
  servers: NonNullable<FactoryView["helperMcps"]>;
  actions: { busy: boolean; syncHelpers?(): void; setHelperConfig?(name: string, config: HelperMcpConfigUpdate): void };
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filter, setFilter] = useState<HelperFilter | null>(null);
  const syncedServers = servers.filter(s => s.enabled);
  const localServers = servers.filter(s => !s.enabled);
  const connectedCount = syncedServers.filter(s => s.status === "connected").length;
  const issueServers = syncedServers.filter(s => HEALTH[s.status].isIssue);
  const issueCount = issueServers.length;
  const activeFilter = filter ?? (syncedServers.length > 0 ? "synced" : "local");
  const filteredServers = activeFilter === "local" ? localServers : activeFilter === "attention" ? issueServers : syncedServers;
  const configDisabled = actions.busy || !actions.setHelperConfig;

  return (
    <Card theme={theme} gap={SPACING[1.5]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
          <Icon name="Cpu" size={15} color={theme.colors.accent} />
          <Text style={text(theme, "rowTitle")}>Helper MCP Servers (Peer)</Text>
          <Pill theme={theme} label="PEER ONLY" tone="accent" lit />
          <Pill theme={theme} label={`${syncedServers.length} synced (${connectedCount} connected)`}
            tone={connectedCount > 0 && issueCount === 0 ? "statusSuccess" : "foregroundMuted"} />
          <Pill theme={theme} label={`${localServers.length} local on host`} />
          {issueCount > 0 ? <Pill theme={theme} label={`${issueCount} need attention`} tone="statusDanger" lit /> : null}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Btn theme={theme} small label="Check Connectivity" icon="RefreshCw"
            disabled={actions.busy || !actions.syncHelpers} onPress={() => actions.syncHelpers?.()} />
          <Btn theme={theme} small label={`⋯ Manage (${servers.length})`} tone="foregroundMuted"
            onPress={() => setDrawerOpen(!drawerOpen)} />
        </View>
      </View>

      {!drawerOpen ? (
        syncedServers.length === 0 ? (
          <Text style={text(theme, "meta", "foregroundMuted")}>
            No MCPs synced to Peer yet — open ⋯ Manage to sync servers from Antigravity, Pi, or Claude.
          </Text>
        ) : (
          <View style={{ gap: SPACING[1.5] }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1] }}>
              {syncedServers.map(server => (
                <Pill key={server.name} theme={theme} label={server.name} mono
                  tone={HEALTH[server.status].isIssue ? HEALTH[server.status].tone : "statusSuccess"} />
              ))}
              {localServers.length > 0 ? <Pill theme={theme} label={`${localServers.length} available on host`} /> : null}
            </View>
            {issueCount > 0 ? (
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
                <Text style={{ ...text(theme, "meta", "statusDanger"), flexShrink: 1 }}>
                  {issueServers.map(s => `${s.name}: ${s.statusDetail ?? HEALTH[s.status].label}`).join(" · ")}
                </Text>
                <Btn theme={theme} small label="Inspect" tone="foregroundMuted"
                  onPress={() => { setFilter("attention"); setDrawerOpen(true); }} />
              </View>
            ) : null}
          </View>
        )
      ) : (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: SPACING[2], gap: SPACING[2] }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Chip theme={theme} label="Synced to Peer" count={syncedServers.length} active={activeFilter === "synced"} onPress={() => setFilter("synced")} />
            <Chip theme={theme} label="Available on Host" count={localServers.length} active={activeFilter === "local"} onPress={() => setFilter("local")} />
            {issueCount > 0 ? <Chip theme={theme} label="Attention" count={issueCount} active={activeFilter === "attention"} onPress={() => setFilter("attention")} /> : null}
          </View>
          {filteredServers.length === 0 ? (
            <Text style={text(theme, "meta", "foregroundMuted")}>
              {activeFilter === "local" ? "No local-only MCPs found on this host." : activeFilter === "attention" ? "No synced MCPs need attention." : "No MCPs synced to Peer yet — select Available on Host to add one."}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
            {filteredServers.map(server => {
              const health = HEALTH[server.status];
              return (
                <View key={server.name} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 280, minWidth: 0,
                  borderWidth: 1, borderColor: server.enabled && health.isIssue ? tint(theme.colors[health.tone], "66") : theme.colors.border,
                  borderRadius: RADIUS.md, backgroundColor: theme.colors.surface0,
                  paddingHorizontal: SPACING[2.5], paddingVertical: SPACING[1.5], gap: SPACING[1] }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
                    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1, minWidth: 0 }}>
                      <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: theme.colors[health.tone] }} />
                      <Text style={{ ...text(theme, "code"), flexShrink: 1 }} numberOfLines={1}>{server.name}</Text>
                      <Pill theme={theme} label={server.transport.toUpperCase()} mono />
                      {server.enabled ? <Pill theme={theme} label={health.label} tone={health.tone} lit={health.lit} /> : null}
                    </View>
                    <Btn theme={theme} small label={server.enabled ? "Unsync" : "+ Sync to Peer"} tone={server.enabled ? "foregroundMuted" : "accent"}
                      disabled={configDisabled} onPress={() => actions.setHelperConfig?.(server.name, { enabled: !server.enabled })} />
                  </View>
                  {server.enabled ? (
                    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
                      {TARGETS.map(({ provider, label }) => (
                        <TargetPill key={provider} theme={theme} label={label} selected={server.targetProviders.includes(provider)} disabled={configDisabled}
                          onPress={() => actions.setHelperConfig?.(server.name, { targetProviders: server.targetProviders.includes(provider)
                            ? server.targetProviders.filter(p => p !== provider) : [...server.targetProviders, provider] })} />
                      ))}
                      <TargetPill theme={theme} label={server.vaultSync ? "Vault: On" : "Vault: Off"} selected={server.vaultSync} tone="statusSuccess" disabled={configDisabled}
                        onPress={() => actions.setHelperConfig?.(server.name, { vaultSync: !server.vaultSync })} />
                    </View>
                  ) : (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1] }}>
                      {server.sources.map(source => <Pill key={source} theme={theme} label={source} />)}
                    </View>
                  )}
                  {server.enabled && health.isIssue && server.statusDetail ? <Text style={text(theme, "meta", health.tone)}>{server.statusDetail}</Text> : null}
                </View>
              );
            })}
          </View>
        </View>
      )}
    </Card>
  );
}
