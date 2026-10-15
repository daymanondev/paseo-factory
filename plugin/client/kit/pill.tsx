/**
 * The surface's small UI kit: the Evidence Pill, the button, the filter
 * chip, the tab bar — function components over raw react-native primitives,
 * theme colours only. PigMonitor's shapes, factory vocabulary.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { RADIUS, SPACING, text, tint } from "./theme.ts";
import type { Colour } from "./theme.ts";

/** One Evidence Pill — Gate / Choke / Eye / Watch / Cost and the status chips. */
export function Pill({ theme, label, tone = "foregroundMuted", lit = false }: { theme: PluginTheme; label: string; tone?: Colour; lit?: boolean }) {
  const colour = theme.colors[tone];
  return (
    <View style={{ paddingHorizontal: SPACING[1.5], paddingVertical: 2, borderRadius: RADIUS.md, borderWidth: 1, borderColor: lit ? tint(colour, "88") : theme.colors.border, backgroundColor: lit ? tint(colour, "1a") : theme.colors.surface1 }}>
      <Text style={{ ...text(theme, "label"), color: lit ? colour : theme.colors.foregroundMuted }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** The surface's one button — bordered, tinted on press. */
export function Btn({
  theme,
  label,
  onPress,
  tone = "accent",
  disabled = false,
  small = false,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  tone?: Colour;
  disabled?: boolean;
  small?: boolean;
}) {
  const colour = theme.colors[tone];
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: small ? SPACING[2] : SPACING[3],
        paddingVertical: small ? SPACING[1] : SPACING[1.5],
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: disabled ? theme.colors.border : colour,
        backgroundColor: pressed && !disabled ? tint(colour, "33") : "transparent",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Text style={{ ...text(theme, small ? "label" : "rowTitle"), fontWeight: "600", color: disabled ? theme.colors.foregroundMuted : colour }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** One filter chip — the Tasks tab's status filters. */
export function Chip({ theme, label, active, count, onPress }: { theme: PluginTheme; label: string; active: boolean; count: number; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: SPACING[2],
        paddingVertical: SPACING[1],
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        backgroundColor: active ? tint(theme.colors.accent, "22") : pressed ? theme.colors.surface2 : "transparent",
        flexDirection: "row",
        gap: SPACING[1],
      })}
    >
      <Text style={text(theme, "label", active ? "accent" : undefined)}>{label}</Text>
      {count > 0 ? <Text style={{ ...text(theme, "label"), fontVariant: ["tabular-nums"] }}>{count}</Text> : null}
    </Pressable>
  );
}

export type TabId = "tasks" | "seats" | "timeline";

/** The three-tab bar — one Shell, three views of the verification line. */
export function TabBar({ theme, active, onPick }: { theme: PluginTheme; active: TabId; onPick: (tab: TabId) => void }) {
  const tabs: { id: TabId; label: string }[] = [
    { id: "tasks", label: "Tasks" },
    { id: "seats", label: "Seats & Models" },
    { id: "timeline", label: "Timeline & Retro" },
  ];
  return (
    <View style={{ flexDirection: "row", gap: SPACING[1.5], flexWrap: "wrap" }}>
      {tabs.map((tab) => {
        const on = tab.id === active;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            onPress={() => onPick(tab.id)}
            style={({ pressed }) => ({
              paddingHorizontal: SPACING[3],
              paddingVertical: SPACING[1.5],
              borderRadius: RADIUS.lg,
              borderWidth: 1,
              borderColor: on ? theme.colors.accent : theme.colors.border,
              backgroundColor: on ? tint(theme.colors.accent, "22") : pressed ? theme.colors.surface2 : "transparent",
            })}
          >
            <Text style={{ ...text(theme, "rowTitle"), fontWeight: "600", color: on ? theme.colors.accent : theme.colors.foreground }}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A section card — bordered surface with padding, the surface's one container. */
export function Card({ theme, children, gap = SPACING[2] }: { theme: PluginTheme; children: ReactNode; gap?: number }) {
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, borderRadius: RADIUS.lg, padding: SPACING[3], gap }}>
      {children}
    </View>
  );
}
