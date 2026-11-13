/**
 * The Factory client's tiny theme kit — PigMonitor's scales, trimmed to what
 * the surface uses. All styling is React Native inline styles + these
 * numbers; no DOM, no CSS (Hermes). Function factories only — no class
 * syntax reaches the client bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Platform } from "react-native";
import type { PressableStateCallbackType, TextStyle } from "react-native";

export const SPACING = { 0.5: 2, 1: 4, 1.5: 6, 2: 8, 2.5: 10, 3: 12, 4: 16, 5: 20, 6: 24 } as const;

/** iOS ships no `monospace` family (Android's keyword); Menlo is on every iOS device. */
export const MONO_FONT: string = Platform.select({ ios: "Menlo", default: "monospace" });

const FONT_SIZE = { xs: 11, code: 12, sm: 12, section: 13, base: 14, lg: 16 } as const;

export const RADIUS = { sm: 4, md: 6, lg: 8, xl: 10 } as const;

export const DOT = 8;

/** Shared row heights so buttons, chips, and inputs on the same line never misalign. */
export const CONTROL_H = 32;
export const CONTROL_SM = 26;
export const PILL_H = 22;

export type Colour = keyof PluginTheme["colors"];

const ROLES = {
  badge: { fontSize: FONT_SIZE.xs, lineHeight: 14, fontWeight: "600", colour: "foregroundMuted" },
  label: { fontSize: FONT_SIZE.sm, lineHeight: 16, fontWeight: "500", colour: "foregroundMuted" },
  rowTitle: { fontSize: FONT_SIZE.base, lineHeight: 18, fontWeight: "600", colour: "foreground" },
  section: { fontSize: FONT_SIZE.section, lineHeight: 18, fontWeight: "600", colour: "foreground" },
  stat: { fontSize: 20, lineHeight: 24, fontWeight: "600", colour: "foreground" },
  detailTitle: { fontSize: FONT_SIZE.lg, lineHeight: 22, fontWeight: "600", colour: "foreground" },
  meta: { fontSize: FONT_SIZE.sm, lineHeight: 18, fontWeight: "400", colour: "foregroundMuted" },
  code: { fontSize: FONT_SIZE.code, lineHeight: 16, fontWeight: "500", colour: "foreground", fontFamily: MONO_FONT },
} as const satisfies Record<string, TextStyle & { colour: Colour }>;

export type Role = keyof typeof ROLES;

/** One text style from the kit — the only way text is styled here. */
export function text(theme: PluginTheme, role: Role, colour?: Colour): TextStyle {
  const { colour: base, ...style } = ROLES[role];
  return { ...style, color: theme.colors[colour ?? base] };
}

/** Appends an alpha channel to a hex colour — `"22"` by default. */
export function tint(colour: string, alpha = "22"): string {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return colour;
  return `${colour}${alpha}`;
}

/** Reads react-native-web's `hovered` state without widening RN's Pressable type. */
export function hoveredOf(state: PressableStateCallbackType): boolean {
  return "hovered" in state && (state as { hovered?: boolean }).hovered === true;
}

/** Frozen pi palette (ADR 0057 §9). Host foreground/background still own body text. */
export const FACTORY_PALETTE = {
  dark: {
    supervisor: "#a798d7", lead: "#5fa8cc", peer: "#5db3ba",
    ok: "#68b78d", wait: "#cd9a22", move: "#de54c1", bad: "#fe5462", idle: "#6c767b",
    thinking: ["#6c767b", "#5489a4", "#6185cc", "#9776e5", "#de54c1", "#fe5462"],
  },
  light: {
    supervisor: "#7459b4", lead: "#2f7899", peer: "#287a81",
    ok: "#337e58", wait: "#8f6802", move: "#b23a98", bad: "#c8253d", idle: "#677176",
    thinking: ["#677176", "#3d8eb3", "#4f6fc0", "#7459b4", "#b23a98", "#c8253d"],
  },
} as const;

/** Relative luminance accepts the host's hex (short or full) and rgb colours. */
function luminance(colour: string): number {
  let channels: number[];
  const hex = colour.match(/^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i)?.[1];
  if (hex !== undefined) {
    const full = hex.length === 3 ? hex.split("").map((x) => x + x).join("") : hex;
    channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  } else {
    const rgb = colour.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgb === null) return 0;
    channels = rgb.slice(1, 4).map(Number);
  }
  const linear = channels.map((x) => { const s = x / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

export function factoryPalette(theme: PluginTheme) {
  return luminance(theme.colors.surface0) > 0.179 ? FACTORY_PALETTE.light : FACTORY_PALETTE.dark;
}

/** An explicit thinking word always accompanies this chip accent. Unknown values stay idle. */
export function thinkingColour(theme: PluginTheme, thinking?: string): string {
  const level = ["off", "minimal", "low", "medium", "high", "max"].indexOf(thinking ?? "off");
  return factoryPalette(theme).thinking[Math.max(0, level)]!;
}
