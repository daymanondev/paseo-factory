import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { AgentView } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { SPACING, text } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";
export function SeatNode({
  theme,
  title,
  icon,
  subtitle,
  pills,
}: {
  theme: PluginTheme;
  title: string;
  icon: string;
  subtitle: string;
  pills: { label: string; tone?: Colour; lit?: boolean; mono?: boolean }[];
}) {
  return (
    <Card theme={theme} gap={SPACING[1.5]}>
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
            gap: SPACING[1.5],
          }}
        >
          <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />
          <Text style={text(theme, "rowTitle")}>{title}</Text>
        </View>
        {pills.length > 0 ? (
          <View
            style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1] }}
          >
            {pills.map((pill) => (
              <Pill
                key={pill.label}
                theme={theme}
                label={pill.label}
                tone={pill.tone ?? "foregroundMuted"}
                lit={pill.lit}
                mono={pill.mono}
              />
            ))}
          </View>
        ) : null}
      </View>
      <Text style={text(theme, "meta")} numberOfLines={1}>
        {subtitle}
      </Text>
    </Card>
  );
}

/** The orthogonal rail between graph levels — a clean vertical connector. */
export function Rail({
  theme,
  height = SPACING[2.5],
}: {
  theme: PluginTheme;
  height?: number;
}) {
  return (
    <View
      style={{
        width: 2,
        height,
        backgroundColor: theme.colors.border,
        marginLeft: SPACING[4],
      }}
    />
  );
}

export function AgentCard({
  theme,
  agent,
  actions,
  retireLabel,
  onRetire,
}: {
  theme: PluginTheme;
  agent: AgentView;
  actions: { busy: boolean; openAgent(id: string): void };
  retireLabel?: string;
  onRetire?: () => void;
}) {
  const icon =
    agent.seat === "supervisor"
      ? "Shield"
      : agent.seat === "lead"
        ? "Compass"
        : "Cpu";
  return (
    <Card theme={theme} gap={SPACING[2]}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: SPACING[2],
          flexWrap: "wrap",
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
          <Icon name={icon} size={14} color={theme.colors.accent} />
          <Text style={text(theme, "rowTitle")} numberOfLines={1}>
            {agent.title ?? agent.id.slice(0, 12)}
          </Text>
          <Pill
            theme={theme}
            label={agent.status}
            tone={
              agent.status === "error"
                ? "statusDanger"
                : agent.status === "running"
                  ? "accent"
                  : "statusSuccess"
            }
            lit={agent.status === "running" || agent.status === "error"}
          />
          {agent.requiresAttention === true ? (
            <Pill theme={theme} label="attention" tone="statusWarning" lit />
          ) : null}
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: SPACING[1.5],
          }}
        >
          {retireLabel !== undefined && onRetire !== undefined ? (
            <Btn
              theme={theme}
              small
              icon="RotateCcw"
              label={retireLabel}
              tone="statusDanger"
              disabled={actions.busy}
              onPress={onRetire}
            />
          ) : null}
          <Btn
            theme={theme}
            small
            icon="ExternalLink"
            label="Open"
            onPress={() => actions.openAgent(agent.id)}
          />
        </View>
      </View>
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}
      >
        <Pill theme={theme} label={agent.provider} mono />
        {agent.model !== null && agent.model !== agent.provider ? (
          <Pill theme={theme} label={agent.model} mono />
        ) : null}
        {agent.thinking !== undefined && agent.thinking !== null ? (
          <Pill
            theme={theme}
            label={`thinking: ${agent.thinking}`}
            tone="accent"
            lit
          />
        ) : null}
        {agent.task !== null ? (
          <Pill theme={theme} label={`task ${agent.task}`} tone="accent" lit />
        ) : null}
        {agent.seqEnd !== null ? (
          <Pill theme={theme} label={`seqEnd ${agent.seqEnd}`} mono />
        ) : null}
        {/* The Lead telemetry trio (v0.0.20, ADR 0013 §6): live context usage
            against the fixed 128k handoff mark, the rotation state, and the
            queued mailbox count — present only on the Lead's view, so every
            other seat's card simply skips them. */}
        {agent.contextUsedTokens !== undefined &&
        agent.contextUsedTokens !== null ? (
          <Pill
            theme={theme}
            label={`${Math.round(agent.contextUsedTokens / 1000)}k / 128k handoff`}
            mono
          />
        ) : null}
        {agent.rotationState !== undefined ? (
          <Pill
            theme={theme}
            label={agent.rotationState}
            tone={
              agent.rotationState === "handing_over"
                ? "accent"
                : agent.rotationState === "rotation_pending"
                  ? "statusWarning"
                  : "foregroundMuted"
            }
            lit={agent.rotationState !== "normal"}
          />
        ) : null}
        {agent.queuedMailCount !== undefined && agent.queuedMailCount > 0 ? (
          <Pill
            theme={theme}
            label={`${agent.queuedMailCount} queued`}
            tone="accent"
            lit
          />
        ) : null}
      </View>
    </Card>
  );
}
