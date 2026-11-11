/**
 * Per-Project settings (v0.6.0, ADR 0056): the Project's Open Design link,
 * source, checkpoint paths and skill packs, in `projects/<slug>/project-settings.json`.
 * It carries no execution mode — SLP is the only way the Factory runs — and
 * replaces the Open Design / skill-pack fields of the legacy `execution.json`.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FactoryError } from "./errors.ts";
import { atomicJson, readOptionalJson, stateMutation } from "./json-store.ts";
import type { OpenDesignProjectLink } from "./open-design/open-design-link-state.ts";
import { safeId } from "./safe-id.ts";

export const PROJECT_SKILL_PACKS = ["expo", "firebase", "zcode-3d", "science"] as const;

export interface OpenDesignSource {
  kind: "host" | "client";
  requestId?: string;
  acknowledgedRequestId?: string;
}

export interface ProjectSettings {
  schemaVersion: 1;
  /** Counts writes through this module; carries no meaning beyond ordering. */
  revision: number;
  skillPacks?: string[];
  openDesignCheckpointPaths?: string[];
  openDesignSource?: OpenDesignSource;
  openDesignLink?: OpenDesignProjectLink;
}

export function projectSettingsPath(state: string, slug: string): string {
  if (!safeId(slug)) throw new FactoryError("invalid-project-slug", slug);
  return join(state, "projects", slug, "project-settings.json");
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function projectSettingsAreValid(value: unknown): value is ProjectSettings {
  const v = value as ProjectSettings | null;
  return (
    v !== null &&
    typeof v === "object" &&
    v.schemaVersion === 1 &&
    Number.isSafeInteger(v.revision) &&
    v.revision >= 0 &&
    (v.skillPacks === undefined || isStringArray(v.skillPacks)) &&
    (v.openDesignCheckpointPaths === undefined || isStringArray(v.openDesignCheckpointPaths))
  );
}

/** A Project with no settings record yet has the defaults: no link, no packs. */
export function readProjectSettings(state: string, slug: string): ProjectSettings {
  const path = projectSettingsPath(state, slug);
  let value: unknown;
  try {
    value = readOptionalJson(path, "project-settings-invalid");
  } catch {
    throw new FactoryError("project-settings-invalid", `project-settings-invalid: ${path}`);
  }
  if (value === undefined) return { schemaVersion: 1, revision: 0 };
  if (!projectSettingsAreValid(value)) throw new FactoryError("project-settings-invalid", `project-settings-invalid: ${path}`);
  return value;
}

/** Durable replace of the whole record. The caller owns any read-modify-write ordering. */
export function writeProjectSettings(state: string, slug: string, settings: ProjectSettings): ProjectSettings {
  atomicJson(projectSettingsPath(state, slug), settings);
  return settings;
}

export function setProjectSkillPacks(state: string, slug: string, skillPacks: string[]): ProjectSettings {
  return stateMutation(state, () => {
    const current = readProjectSettings(state, slug);
    if (skillPacks.some((pack) => !(PROJECT_SKILL_PACKS as readonly string[]).includes(pack)))
      throw new FactoryError("invalid-skill-pack", "Unknown Project skill pack");
    return writeProjectSettings(state, slug, { ...current, revision: current.revision + 1, skillPacks: [...new Set(skillPacks)] });
  });
}

/** Files the pre-0.6.0 Scrum workflow left beside a Project's own state. */
const SCRUM_STATE_FILES = ["execution-switch.json", "scrum-lanes.json", "scrum-profiles.json", "scrum-active-profile.json"];

function legacySettings(value: unknown): ProjectSettings | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const legacy = value as Record<string, unknown>;
  const settings: ProjectSettings = { schemaVersion: 1, revision: 1 };
  if (isStringArray(legacy.skillPacks)) settings.skillPacks = legacy.skillPacks;
  if (isStringArray(legacy.openDesignCheckpointPaths)) settings.openDesignCheckpointPaths = legacy.openDesignCheckpointPaths;
  const source = legacy.openDesignSource as OpenDesignSource | null | undefined;
  if (source && typeof source === "object" && (source.kind === "host" || source.kind === "client")) settings.openDesignSource = source;
  const link = legacy.openDesignLink as OpenDesignProjectLink | null | undefined;
  if (link && typeof link === "object") settings.openDesignLink = link;
  return settings;
}

/**
 * The one-time, idempotent v0.6.0 boot cleanup (ADR 0056). Each Project's
 * legacy `execution.json` becomes `project-settings.json` (dropping `mode`)
 * and is then removed; every Scrum artefact — machine lanes, profiles, active
 * profile, pending mode-switch records, and each Project's `scrum/` run
 * directory — is deleted. The settings record is written before the legacy
 * record is removed, so a crash between the two converges on the next boot.
 * A legacy record that cannot be read is left in place rather than lost.
 */
export function migrateLegacyExecutionState(state: string): { migrated: string[]; unreadable: string[] } {
  const migrated: string[] = [];
  const unreadable: string[] = [];
  const projectsDir = join(state, "projects");
  const slugs = existsSync(projectsDir)
    ? readdirSync(projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && safeId(entry.name)).map((entry) => entry.name)
    : [];
  for (const slug of slugs) {
    const dir = join(projectsDir, slug);
    const legacyPath = join(dir, "execution.json");
    let retire = existsSync(legacyPath);
    if (retire && !existsSync(projectSettingsPath(state, slug))) {
      let settings: ProjectSettings | undefined;
      try { settings = legacySettings(readOptionalJson(legacyPath)); } catch { settings = undefined; }
      if (settings === undefined) { unreadable.push(slug); retire = false; }
      else { writeProjectSettings(state, slug, settings); migrated.push(slug); }
    }
    if (retire) rmSync(legacyPath, { force: true });
    for (const name of SCRUM_STATE_FILES) rmSync(join(dir, name), { force: true });
    rmSync(join(dir, "scrum"), { recursive: true, force: true });
  }
  for (const name of ["execution.json", ...SCRUM_STATE_FILES]) rmSync(join(state, name), { force: true });
  return { migrated, unreadable };
}
