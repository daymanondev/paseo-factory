/**
 * The Settings screen's warning rule (v0.6.0 W8, ADR 0056 §7) — a pure
 * function of the snapshot view: one line of warning text per machine-wide
 * section, or null when the section is quiet. A section with a warning opens
 * by default; the rest start collapsed.
 */
import type { FactoryView } from "../../shared/view.ts";

export type SettingsSectionId = "models" | "skills-tools" | "plugins" | "vault" | "diagnostics";

/** Display order — the spec's: models, skills & tools, plugins, vault, diagnostics. */
export const SETTINGS_SECTION_ORDER: readonly SettingsSectionId[] = ["models", "skills-tools", "plugins", "vault", "diagnostics"];

export type SettingsWarnings = Record<SettingsSectionId, string | null>;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A lane value is `provider/model[:thinking]`; the eye config and bare names carry no provider. */
function laneProvider(raw: string): string | null {
  const first = raw.split(" · ")[0] ?? raw;
  const slash = first.indexOf("/");
  return slash <= 0 ? null : first.slice(0, slash);
}

const join = (parts: string[]): string | null => (parts.length === 0 ? null : parts.join(" · "));

export function settingsWarnings(view: FactoryView): SettingsWarnings {
  const lanes = Object.values(view.lanes);
  const unavailable = view.providers
    .filter((p) => !p.available && lanes.some((lane) => laneProvider(lane) === p.provider))
    .map((p) => p.provider);

  const tools = view.companionTools ?? [];
  const incomplete = tools.filter((t) => t.status !== "running" || t.error !== null);
  const helperTrouble = (view.helperMcps ?? []).filter((s) => s.enabled && (s.status === "auth_expired" || s.status === "missing_env" || s.status === "unreachable"));
  const skillsTools: string[] = [];
  if (incomplete.length > 0) skillsTools.push(`${plural(incomplete.length, "required component")} missing or incomplete`);
  if (helperTrouble.length > 0) skillsTools.push(`${plural(helperTrouble.length, "Helper MCP")} need${helperTrouble.length === 1 ? "s" : ""} attention`);

  const plugins: string[] = [];
  const broken = [view.corePlugin, ...view.companions].filter((p) => p.status === "failed" || p.error !== null);
  if (broken.length > 0) plugins.push(`${broken.map((p) => p.title).join(", ")} failed`);
  const updatable = [view.corePlugin, ...view.companions, ...tools].filter(
    (p) => p.status !== "not_installed" && (p.installKind === "git" || p.installKind === "npm") && p.updateAvailable === true,
  );
  if (updatable.length > 0) plugins.push(`${plural(updatable.length, "update")} available`);

  return {
    models: unavailable.length === 0 ? null : `Provider ${unavailable.join(", ")} unavailable — a lane uses it`,
    "skills-tools": join(skillsTools),
    plugins: join(plugins),
    vault: view.vault.error,
    diagnostics: view.daemonError,
  };
}
