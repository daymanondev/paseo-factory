/**
 * Compact 2-row summary card + collapsible `⋯ Manage` drawer for the unified
 * `Helper MCP catalog` (`ADR 0039`). Matches `CompanionCard`'s visual density:
 * - Collapsed by default: Row 1 shows title, `PEER ONLY` badge, summary health
 *   pills (`X of Y connected`, conditional `N need attention`, `N disabled`),
 *   `Test & Sync MCPs`, and `⋯ Manage (N)` toggle; Row 2 shows a 1-line tagline
 *   plus a compact inline chip strip of enabled servers (and an inline alert
 *   only when a server needs attention).
 * - Expanded (`⋯ Manage`): Filter chips (`All`, `Connected`, `Attention`,
 *   `Disabled`) and a compact 2-column responsive grid of 1-line recessed rows
 *   without repeating healthy boilerplate text under every item.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type { FactoryView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill } from "../kit/pill.tsx";
import { DOT, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";

type HelperServer = NonNullable<FactoryView["helperMcps"]>[number];
type HelperFilter = "all" | "connected" | "attention" | "disabled";

const HEALTH: Record<
  HelperServer["status"],
  { label: string; tone: Colour; lit: boolean; isIssue: boolean }
> = {
  connected: { label: "Connected", tone: "statusSuccess", lit: false, isIssue: false },
  auth_expired: { label: "Auth Expired", tone: "statusDanger", lit: true, isIssue: true },
  missing_env: { label: "Missing Key", tone: "statusWarning", lit: true, isIssue: true },
  unreachable: { label: "Unreachable", tone: "statusDanger", lit: true, isIssue: true },
  disabled: { label: "Disabled", tone: "foregroundMuted", lit: false, isIssue: false },
};

export function HelperMcpsCard({
  theme,
  servers,
  actions,
}: {
  theme: PluginTheme;
  servers: NonNullable<FactoryView["helperMcps"]>;
  actions: {
    busy: boolean;
    syncHelpers?(): void;
    setHelperEnabled?(name: string, enabled: boolean): void;
  };
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filter, setFilter] = useState<HelperFilter>("all");

  const enabledServers = servers.filter((s) => s.enabled);
  const connectedCount = enabledServers.filter((s) => s.status === "connected").length;
  const issueServers = enabledServers.filter((s) => HEALTH[s.status].isIssue);
  const issueCount = issueServers.length;
  const disabledCount = servers.length - enabledServers.length;

  const filteredServers = servers.filter((s) => {
    if (filter === "connected") return s.enabled && s.status === "connected";
    if (filter === "attention") return s.enabled && HEALTH[s.status].isIssue;
    if (filter === "disabled") return !s.enabled || s.status === "disabled";
    return true;
  });

  return (
    <Card theme={theme} gap={SPACING[1.5]}>
      {/* Row 1 (Compact Header): Icon + Title + Summary pills on left, Test & Sync + ⋯ Manage toggle on right */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: SPACING[2],
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexWrap: "wrap",
            gap: SPACING[1.5],
            flexShrink: 1,
          }}
        >
          <Icon name="Cpu" size={15} color={theme.colors.accent} />
          <Text style={text(theme, "rowTitle")}>Helper MCP Servers (Peer)</Text>
          <Pill theme={theme} label="PEER ONLY" tone="accent" lit />
          <Pill
            theme={theme}
            label={`${connectedCount} of ${enabledServers.length} connected`}
            tone={issueCount === 0 && connectedCount > 0 ? "statusSuccess" : "foregroundMuted"}
            lit={issueCount === 0 && connectedCount > 0}
          />
          {issueCount > 0 ? (
            <Pill
              theme={theme}
              label={`${issueCount} need${issueCount === 1 ? "s" : ""} attention`}
              tone="statusDanger"
              lit
            />
          ) : null}
          {disabledCount > 0 ? (
            <Pill theme={theme} label={`${disabledCount} disabled`} tone="foregroundMuted" />
          ) : null}
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Btn
            theme={theme}
            small
            label={actions.busy ? "Syncing…" : "Test & Sync MCPs"}
            icon="RefreshCw"
            tone={issueCount > 0 ? "accent" : "foregroundMuted"}
            solid={issueCount > 0}
            disabled={actions.busy || !actions.syncHelpers}
            onPress={() => actions.syncHelpers?.()}
          />
          {servers.length > 0 ? (
            <Btn
              theme={theme}
              small
              label={drawerOpen ? "Hide" : `⋯ Manage (${servers.length})`}
              tone="foregroundMuted"
              onPress={() => setDrawerOpen(!drawerOpen)}
            />
          ) : null}
        </View>
      </View>

      {/* Row 2 (Concise 1-line Subtitle) */}
      <Text style={text(theme, "meta")} numberOfLines={2}>
        Unified external MCP catalog across Antigravity, Pi, Claude, and Vault — attached lazily to working Peers.
      </Text>

      {/* Collapsed state: compact single-wrap chip strip + actionable inline banner only for broken servers */}
      {!drawerOpen ? (
        servers.length === 0 ? (
          <Text style={text(theme, "meta", "foregroundMuted")}>
            No helper servers found. Configure an MCP in Antigravity, Pi, or Claude, then select Test &amp; Sync MCPs.
          </Text>
        ) : (
          <View style={{ gap: SPACING[1.5] }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1] }}>
              {enabledServers.map((server) => {
                const health = HEALTH[server.status];
                return (
                  <Pill
                    key={server.name}
                    theme={theme}
                    label={health.isIssue ? `${server.name} · ${health.label}` : server.name}
                    tone={health.isIssue ? health.tone : "statusSuccess"}
                    lit={health.isIssue}
                    mono
                  />
                );
              })}
              {disabledCount > 0 ? (
                <Pill theme={theme} label={`+${disabledCount} disabled`} tone="foregroundMuted" />
              ) : null}
            </View>

            {issueServers.length > 0 ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: SPACING[2],
                  borderWidth: 1,
                  borderColor: tint(theme.colors.statusDanger, "66"),
                  borderRadius: RADIUS.md,
                  backgroundColor: tint(theme.colors.statusDanger, "12"),
                  paddingHorizontal: SPACING[2],
                  paddingVertical: SPACING[1.5],
                }}
              >
                <Text style={{ ...text(theme, "label", "statusDanger"), flexShrink: 1 }}>
                  {issueServers
                    .map((s) => `${s.name}: ${s.statusDetail ?? HEALTH[s.status].label}`)
                    .join("  ·  ")}
                </Text>
                <Btn
                  theme={theme}
                  small
                  label="Inspect"
                  tone="foregroundMuted"
                  onPress={() => {
                    setFilter("attention");
                    setDrawerOpen(true);
                  }}
                />
              </View>
            ) : null}
          </View>
        )
      ) : null}

      {/* Collapsible ⋯ Manage Drawer: Filter chips + compact 2-column responsive grid */}
      {drawerOpen && servers.length > 0 ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            paddingTop: SPACING[2],
            gap: SPACING[2],
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Chip
              theme={theme}
              label="All"
              count={servers.length}
              active={filter === "all"}
              onPress={() => setFilter("all")}
            />
            <Chip
              theme={theme}
              label="Connected"
              count={connectedCount}
              active={filter === "connected"}
              onPress={() => setFilter("connected")}
            />
            {issueCount > 0 ? (
              <Chip
                theme={theme}
                label="Attention"
                count={issueCount}
                active={filter === "attention"}
                onPress={() => setFilter("attention")}
              />
            ) : null}
            {disabledCount > 0 ? (
              <Chip
                theme={theme}
                label="Disabled"
                count={disabledCount}
                active={filter === "disabled"}
                onPress={() => setFilter("disabled")}
              />
            ) : null}
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
            {filteredServers.map((server) => {
              const health = HEALTH[server.status];
              return (
                <View
                  key={server.name}
                  style={{
                    flexGrow: 1,
                    flexBasis: 280,
                    borderWidth: 1,
                    borderColor: health.isIssue ? tint(theme.colors[health.tone], "66") : theme.colors.border,
                    borderRadius: RADIUS.md,
                    backgroundColor: theme.colors.surface0,
                    paddingHorizontal: SPACING[2.5],
                    paddingVertical: SPACING[1.5],
                    gap: SPACING[1],
                    opacity: server.enabled ? 1 : 0.72,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: SPACING[1.5],
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: SPACING[1.5],
                        flexShrink: 1,
                      }}
                    >
                      <View
                        style={{
                          width: DOT,
                          height: DOT,
                          borderRadius: DOT / 2,
                          backgroundColor: theme.colors[health.tone],
                        }}
                      />
                      <Text style={text(theme, "code")} numberOfLines={1}>
                        {server.name}
                      </Text>
                      <Pill theme={theme} label={server.transport.toUpperCase()} mono />
                    </View>

                    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
                      <Pill theme={theme} label={health.label} tone={health.tone} lit={health.lit} />
                      <Btn
                        theme={theme}
                        small
                        label={server.enabled ? "Disable" : "Enable"}
                        tone="foregroundMuted"
                        disabled={actions.busy || !actions.setHelperEnabled}
                        onPress={() => actions.setHelperEnabled?.(server.name, !server.enabled)}
                      />
                    </View>
                  </View>

                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: SPACING[1],
                    }}
                  >
                    <Text style={text(theme, "badge", "foregroundMuted")} numberOfLines={1}>
                      {server.sources.join(" · ")}
                    </Text>
                    {health.isIssue && server.statusDetail ? (
                      <Text style={text(theme, "badge", health.tone)} numberOfLines={1}>
                        {server.statusDetail}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      ) : null}
    </Card>
  );
}
