/**
 * The Factory client's tiny theme kit — PigMonitor's scales, trimmed to what
 * the surface uses. All styling is React Native inline styles + these
 * numbers; no DOM, no CSS (Hermes). Function factories only — no class
 * syntax reaches the client bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { TextStyle } from "react-native";

export const SPACING = { 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 } as const;

const FONT_SIZE = { code: 12, sm: 12, section: 13, base: 14, lg: 16 } as const;

export const RADIUS = { md: 6, lg: 8 } as const;

export const DOT = 8;

export type Colour = keyof PluginTheme["colors"];

const ROLES = {
  label: { fontSize: FONT_SIZE.sm, lineHeight: 16, fontWeight: "400", colour: "foregroundMuted" },
  rowTitle: { fontSize: FONT_SIZE.base, lineHeight: 20, fontWeight: "400", colour: "foreground" },
  section: { fontSize: FONT_SIZE.section, lineHeight: 18, fontWeight: "600", colour: "foreground" },
  stat: { fontSize: 20, lineHeight: 24, fontWeight: "500", colour: "foreground" },
  detailTitle: { fontSize: FONT_SIZE.lg, lineHeight: 22, fontWeight: "500", colour: "foreground" },
  meta: { fontSize: FONT_SIZE.base, lineHeight: 20, fontWeight: "400", colour: "foregroundMuted" },
  code: { fontSize: FONT_SIZE.code, lineHeight: 18, fontWeight: "400", colour: "foreground", fontFamily: "monospace" },
} as const satisfies Record<string, TextStyle & { colour: Colour }>;

type Role = keyof typeof ROLES;

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
