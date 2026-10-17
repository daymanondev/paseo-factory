/**
 * The surface's small UI kit: the Evidence Pill, the button, the filter
 * chip, the tab bar — function components over raw react-native primitives,
 * theme colours only. PigMonitor's shapes, factory vocabulary.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { ViewStyle } from "react-native";
import { CONTROL_H, CONTROL_SM, PILL_H, RADIUS, SPACING, hoveredOf, text, tint } from "./theme.ts";
import type { Colour } from "./theme.ts";

/** One Evidence Pill — Gate / Choke / Eye / Watch / Cost and the status chips. */
export function Pill({
  theme,
  label,
  tone = "foregroundMuted",
  lit = false,
  icon,
  mono = false,
}: {
  theme: PluginTheme;
  label: string;
  tone?: Colour;
  lit?: boolean;
  icon?: string;
  mono?: boolean;
}) {
  const colour = theme.colors[tone];
  const fg = lit ? colour : tone === "foregroundMuted" ? theme.colors.foregroundMuted : colour;
  return (
    <View
      style={{
        minHeight: PILL_H,
        paddingHorizontal: SPACING[2],
        paddingVertical: 2,
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: lit ? tint(colour, "66") : theme.colors.border,
        backgroundColor: lit ? tint(colour, "18") : theme.colors.surface2,
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: SPACING[1],
      }}
    >
      {icon !== undefined ? <Icon name={icon} size={11} color={fg} /> : null}
      <Text
        style={{
          ...text(theme, mono ? "code" : "badge"),
          fontSize: 11,
          lineHeight: 15,
          color: fg,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

/** The surface's one button — self-sized, aligned height, bordered, hover + press feedback. */
export function Btn({
  theme,
  label,
  onPress,
  tone = "accent",
  disabled = false,
  small = false,
  icon,
  solid = false,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  tone?: Colour;
  disabled?: boolean;
  small?: boolean;
  icon?: string;
  solid?: boolean;
}) {
  const colour = theme.colors[tone];
  const isMuted = tone === "foregroundMuted";
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={(state) => {
        const isHovered = hoveredOf(state);
        const bg = disabled
          ? theme.colors.surface1
          : solid
            ? state.pressed
              ? tint(colour, "cc")
              : colour
            : state.pressed
              ? tint(colour, "2e")
              : isHovered
                ? isMuted
                  ? theme.colors.surface2
                  : tint(colour, "18")
                : isMuted
                  ? theme.colors.surface1
                  : tint(colour, "0d");
        const border = disabled
          ? theme.colors.border
          : isMuted
            ? isHovered
              ? theme.colors.foregroundMuted
              : theme.colors.border
            : tint(colour, state.pressed || isHovered ? "aa" : "66");
        return {
          minHeight: small ? CONTROL_SM : CONTROL_H,
          paddingHorizontal: small ? SPACING[2.5] : SPACING[3],
          paddingVertical: small ? 3 : 5,
          borderRadius: RADIUS.md,
          borderWidth: 1,
          borderColor: border,
          backgroundColor: bg,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          alignSelf: "flex-start",
          gap: SPACING[1.5],
          opacity: disabled ? 0.45 : 1,
        };
      }}
    >
      {icon !== undefined ? (
        <Icon
          name={icon}
          size={small ? 12 : 14}
          color={disabled ? theme.colors.foregroundMuted : solid ? theme.colors.surface0 : isMuted ? theme.colors.foreground : colour}
        />
      ) : null}
      <Text
        style={{
          ...text(theme, small ? "label" : "section"),
          fontSize: small ? 12 : 13,
          lineHeight: small ? 16 : 18,
          fontWeight: "600",
          color: disabled ? theme.colors.foregroundMuted : solid ? theme.colors.surface0 : isMuted ? theme.colors.foreground : colour,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** One filter chip — matched to CONTROL_SM (26px) so chips and small buttons align on the same row. */
export function Chip({
  theme,
  label,
  active,
  count,
  onPress,
  icon,
}: {
  theme: PluginTheme;
  label: string;
  active: boolean;
  count: number;
  onPress: () => void;
  icon?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={(state) => {
        const isHovered = hoveredOf(state);
        return {
          minHeight: CONTROL_SM,
          paddingHorizontal: SPACING[2.5],
          paddingVertical: 3,
          borderRadius: RADIUS.md,
          borderWidth: 1,
          borderColor: active ? tint(theme.colors.accent, "99") : isHovered ? theme.colors.foregroundMuted : theme.colors.border,
          backgroundColor: active
            ? tint(theme.colors.accent, "1f")
            : state.pressed || isHovered
              ? theme.colors.surface2
              : theme.colors.surface1,
          flexDirection: "row",
          alignItems: "center",
          alignSelf: "flex-start",
          gap: SPACING[1.5],
        };
      }}
    >
      {icon !== undefined ? <Icon name={icon} size={12} color={active ? theme.colors.accent : theme.colors.foregroundMuted} /> : null}
      <Text
        style={{
          ...text(theme, "label"),
          fontWeight: active ? "600" : "500",
          color: active ? theme.colors.accent : theme.colors.foreground,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {count > 0 ? (
        <View
          style={{
            paddingHorizontal: 5,
            paddingVertical: 1,
            borderRadius: RADIUS.sm,
            backgroundColor: active ? tint(theme.colors.accent, "33") : theme.colors.surface2,
          }}
        >
          <Text
            style={{
              ...text(theme, "badge"),
              fontSize: 10,
              lineHeight: 13,
              fontVariant: ["tabular-nums"],
              color: active ? theme.colors.accent : theme.colors.foregroundMuted,
            }}
          >
            {count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export type TabId = "tasks" | "seats" | "timeline" | "plugins";

/** The four-tab segmented bar — one Shell, four views of the verification line. */
export function TabBar({
  theme,
  active,
  onPick,
  counts,
}: {
  theme: PluginTheme;
  active: TabId;
  onPick: (tab: TabId) => void;
  counts?: Partial<Record<TabId, number>>;
}) {
  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "tasks", label: "Tasks", icon: "CheckSquare" },
    { id: "seats", label: "Seats & Models", icon: "Cpu" },
    { id: "timeline", label: "Timeline & Retro", icon: "Activity" },
    { id: "plugins", label: "Plugins", icon: "Blocks" },
  ];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        flexWrap: "wrap",
        gap: 4,
        padding: 3,
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {tabs.map((tab) => {
        const on = tab.id === active;
        const count = counts?.[tab.id];
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            onPress={() => onPick(tab.id)}
            style={(state) => ({
              minHeight: CONTROL_H - 4,
              paddingHorizontal: SPACING[3],
              paddingVertical: 4,
              borderRadius: RADIUS.md,
              borderWidth: 1,
              borderColor: on ? tint(theme.colors.accent, "77") : "transparent",
              backgroundColor: on
                ? tint(theme.colors.accent, "1f")
                : state.pressed || hoveredOf(state)
                  ? theme.colors.surface2
                  : "transparent",
              flexDirection: "row",
              alignItems: "center",
              gap: SPACING[1.5],
            })}
          >
            <Icon name={tab.icon} size={13} color={on ? theme.colors.accent : theme.colors.foregroundMuted} />
            <Text
              style={{
                ...text(theme, "section"),
                fontWeight: on ? "600" : "500",
                color: on ? theme.colors.accent : theme.colors.foreground,
              }}
            >
              {tab.label}
            </Text>
            {typeof count === "number" && count > 0 ? (
              <View
                style={{
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderRadius: RADIUS.sm,
                  backgroundColor: on ? tint(theme.colors.accent, "33") : theme.colors.surface2,
                }}
              >
                <Text
                  style={{
                    ...text(theme, "badge"),
                    fontSize: 10,
                    lineHeight: 13,
                    fontVariant: ["tabular-nums"],
                    color: on ? theme.colors.accent : theme.colors.foregroundMuted,
                  }}
                >
                  {count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** A section card — bordered surface with padding, the surface's one container. */
export function Card({
  theme,
  children,
  gap = SPACING[2.5],
  style,
}: {
  theme: PluginTheme;
  children: ReactNode;
  gap?: number;
  style?: ViewStyle;
}) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: RADIUS.lg,
        padding: SPACING[3],
        gap,
        ...style,
      }}
    >
      {children}
    </View>
  );
}
