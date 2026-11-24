/**
 * The surface's small UI kit: the Evidence Pill, the button, the filter
 * chip — function components over raw react-native primitives,
 * theme colours only. PigMonitor's shapes, factory vocabulary.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { ViewStyle } from "react-native";
import { CONTROL_H, CONTROL_SM, PILL_H, RADIUS, SPACING, factoryPalette, hoveredOf, text, tint } from "./theme.ts";
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

export type BtnVariant = "primary" | "secondary" | "ghost" | "danger";

/**
 * The surface's one button — self-sized, aligned height, hover + press feedback.
 * `variant` carries the hierarchy (one primary per area; the rest secondary/ghost).
 * Without one, back-compat resolves: `solid` = primary, an explicit `tone` keeps the
 * old tone-outline look, and a bare Btn is secondary (no more green outline by default).
 */
export function Btn({
  theme,
  label,
  onPress,
  tone,
  disabled = false,
  small = false,
  icon,
  solid = false,
  variant,
  testID,
  accentColour,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  tone?: Colour;
  disabled?: boolean;
  small?: boolean;
  icon?: string;
  solid?: boolean;
  variant?: BtnVariant;
  /** The E2E / structural-test hook (the panel names its actions up front). */
  testID?: string;
  accentColour?: string;
}) {
  const mode: BtnVariant | "tone" = variant ?? (solid ? "primary" : tone !== undefined ? "tone" : "secondary");
  // A `solid` button keeps filling with its own tone (e.g. statusWarning); only the default is accent.
  const colour = accentColour ?? theme.colors[tone ?? "accent"];
  const isMuted = tone === "foregroundMuted" && accentColour === undefined;
  const fg = disabled
    ? theme.colors.foregroundMuted
    : mode === "primary"
      ? theme.colors.surface0
      : mode === "danger"
        ? theme.colors.statusDanger
        : mode === "ghost"
          ? (accentColour ?? theme.colors.foregroundMuted)
          : mode === "tone" && !isMuted
            ? colour
            : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      {...(testID === undefined ? {} : { testID })}
      disabled={disabled}
      onPress={onPress}
      style={(state) => {
        const isHovered = hoveredOf(state);
        let bg: string;
        let border: string;
        if (mode === "primary") {
          bg = state.pressed ? tint(colour, "cc") : colour;
          border = tint(colour, state.pressed || isHovered ? "aa" : "66");
        } else if (mode === "ghost") {
          bg = isHovered || state.pressed ? theme.colors.surface2 : "transparent";
          border = "transparent";
        } else if (mode === "tone" && !isMuted) {
          bg = state.pressed ? tint(colour, "2e") : isHovered ? tint(colour, "18") : tint(colour, "0d");
          border = tint(colour, state.pressed || isHovered ? "aa" : "66");
        } else {
          // secondary, danger and the muted tone share one neutral outline.
          bg = state.pressed || isHovered ? theme.colors.surface2 : theme.colors.surface1;
          border = isHovered ? theme.colors.foregroundMuted : theme.colors.border;
        }
        if (disabled) {
          bg = mode === "ghost" ? "transparent" : theme.colors.surface1;
          border = mode === "ghost" ? "transparent" : theme.colors.border;
        }
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
      {icon !== undefined ? <Icon name={icon} size={small ? 12 : 14} color={fg} /> : null}
      <Text
        style={{
          ...text(theme, small ? "label" : "section"),
          fontSize: small ? 12 : 13,
          lineHeight: small ? 16 : 18,
          fontWeight: "600",
          color: fg,
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

/** A section card — bordered surface with padding, the surface's one container. */
export function Card({
  theme,
  children,
  gap = SPACING[2.5],
  style,
  testID,
}: {
  theme: PluginTheme;
  children: ReactNode;
  gap?: number;
  style?: ViewStyle;
  testID?: string;
}) {
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
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

/**
 * One alert-stack item: a 3px tone bar, a faint tint, the title in the tone
 * colour and — wide — the actions on that same line; detail lines under it.
 * Narrow, the actions drop to their own line below the detail.
 */
export function AlertRow({
  theme,
  testID,
  colour,
  title,
  wide,
  actions,
  children,
}: {
  theme: PluginTheme;
  testID?: string;
  colour: string;
  title: string;
  wide: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={{ flexDirection: "row", borderRadius: RADIUS.md, overflow: "hidden", backgroundColor: tint(colour, "10") }}
    >
      <View style={{ width: 3, backgroundColor: colour }} />
      <View style={{ flex: 1, minWidth: 0, gap: SPACING[1], paddingVertical: SPACING[2.5], paddingHorizontal: SPACING[3] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
          <Text style={{ ...text(theme, "rowTitle"), color: colour, flexShrink: 1 }}>{title}</Text>
          {wide ? (actions ?? null) : null}
        </View>
        {children}
        {wide ? null : (actions ?? null)}
      </View>
    </View>
  );
}

/** A single-choice recessed track; selection retains full contrast even when locked. */
export function SegmentedControl<T extends string>({
  theme,
  options,
  value,
  onChange,
  disabled = false,
  size = "md",
  testID,
  optionTestIDPrefix,
  accentColour,
}: {
  theme: PluginTheme;
  options: readonly {
    value: T;
    label: string;
    icon?: string;
    badge?: string;
    accentColour?: string;
  }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  testID?: string;
  optionTestIDPrefix?: string;
  accentColour?: string;
}) {
  const optPrefix = optionTestIDPrefix ?? testID;
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      accessibilityRole="radiogroup"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        padding: 2,
        gap: 2,
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        alignSelf: "flex-start",
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        const resolvedAccent = option.accentColour ?? accentColour ?? theme.colors.accent;
        const color = active
          ? resolvedAccent
          : theme.colors.foregroundMuted;
        return (
          <Pressable
            key={option.value}
            {...(optPrefix === undefined ? {} : { testID: `${optPrefix}-${option.value}` })}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, disabled }}
            accessibilityLabel={option.label}
            disabled={disabled}
            onPress={() => {
              if (!active) onChange(option.value);
            }}
            style={{
              opacity: 1,
              minHeight: size === "sm" ? CONTROL_SM : CONTROL_H,
              paddingHorizontal: SPACING[2.5],
              paddingVertical: 4,
              flexDirection: "row",
              gap: SPACING[1],
              alignItems: "center",
              borderRadius: RADIUS.md,
              borderWidth: 1.5,
              borderColor: active ? resolvedAccent : "transparent",
              backgroundColor: active
                ? tint(resolvedAccent, "20")
                : "transparent",
            }}
          >
            {option.icon ? (
              <Icon name={option.icon} color={color} size={13} />
            ) : null}
            <Text
              style={{
                ...text(theme, "label"),
                color,
                fontWeight: active ? "700" : "400",
              }}
            >
              {option.label}
              {option.badge ? ` (${option.badge})` : ""}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Fixed-colour seat identity (dot + name) backed by `FACTORY_PALETTE`. */
export function RoleName({
  theme,
  role,
  label,
  testID,
}: {
  theme: PluginTheme;
  role: "supervisor" | "lead" | "peer";
  label: string;
  testID?: string;
}) {
  const colour = factoryPalette(theme)[role];
  return (
    <View testID={testID} style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colour }} />
      <Text style={{ ...text(theme, "rowTitle"), color: colour, flexShrink: 1 }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Compact tinted badge backed by a `FACTORY_PALETTE` colour (optional leading dot). */
export function ToneBadge({
  theme,
  label,
  colour,
  dot = true,
  pill = true,
  testID,
}: {
  theme: PluginTheme;
  label: string;
  colour: string;
  dot?: boolean;
  pill?: boolean;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        maxWidth: "100%",
        gap: SPACING[1],
        paddingHorizontal: SPACING[2],
        paddingVertical: 2,
        borderRadius: pill ? 999 : RADIUS.sm,
        borderWidth: 1,
        borderColor: tint(colour, "66"),
        backgroundColor: tint(colour, "18"),
      }}
    >
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colour, flexShrink: 0 }} /> : null}
      <Text style={{ ...text(theme, "badge"), color: colour, flexShrink: 1 }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Single-select choice chip used by Release and Store Release mode/option selectors. */
export function ChoiceChip({
  theme,
  testID,
  label,
  selected,
  disabled,
  onPress,
  accentColour,
}: {
  theme: PluginTheme;
  testID: string;
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
  accentColour?: string;
}) {
  const accent = accentColour ?? theme.colors.accent;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => ({
        minHeight: CONTROL_SM,
        paddingHorizontal: SPACING[2.5],
        paddingVertical: 4,
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: selected ? accent : hoveredOf(state) ? theme.colors.foregroundMuted : theme.colors.border,
        backgroundColor: selected ? tint(accent, "1f") : theme.colors.surface1,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Text
        style={{
          ...text(theme, "label"),
          color: selected ? accent : theme.colors.foreground,
          fontWeight: selected ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Formats an ISO timestamp relative to `now` (ms) as "never", "unknown", "just now", or "<n>m/h/d ago". */
export function formatRelativeAgo(iso: string | null, now: number): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
