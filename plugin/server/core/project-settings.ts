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
import { parseOpenDesignLink } from "./open-design/open-design-link-state.ts";
import type { OpenDesignProjectLink } from "./open-design/open-design-link-state.ts";
import { safeId } from "./safe-id.ts";

export const PROJECT_SKILL_PACKS = ["expo", "firebase", "zcode-3d", "science"] as const;

export const PROJECT_RELEASE_MODES = ["off", "on-request", "auto"] as const;
export type ProjectReleaseMode = (typeof PROJECT_RELEASE_MODES)[number];

export interface ProjectReleaseSettings {
  mode: ProjectReleaseMode;
  branch?: string;
  updatedAt: string;
}

export interface ReleaseRequest {
  version?: string;
  requestedAt: string;
  requestedBy?: string;
  directive?: string;
}

export const PROJECT_STORE_RELEASE_MODES = ["off", "on-request", "auto-staging"] as const;
export type ProjectStoreReleaseMode = (typeof PROJECT_STORE_RELEASE_MODES)[number];

export interface ProjectStoreReleaseSettings {
  mode: ProjectStoreReleaseMode;
  updatedAt: string;
}

export const STORE_RELEASE_REQUEST_TARGETS = ["staging", "production"] as const;
export type StoreReleaseRequestTarget = (typeof STORE_RELEASE_REQUEST_TARGETS)[number];
export type StoreReleaseRequestPlatform = "android" | "ios";

export interface StoreReleaseRequest {
  target: StoreReleaseRequestTarget;
  platforms?: StoreReleaseRequestPlatform[];
  resumeRunId?: string;
  resolution?: unknown;
  requestedAt: string;
  requestedBy?: string;
  directive?: string;
}

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
  release?: ProjectReleaseSettings;
  storeRelease?: ProjectStoreReleaseSettings;
}

export function projectSettingsPath(state: string, slug: string): string {
  if (!safeId(slug)) throw new FactoryError("invalid-project-slug", slug);
  return join(state, "projects", slug, "project-settings.json");
}

export function releaseRequestPath(state: string, slug: string): string {
  if (!safeId(slug)) throw new FactoryError("invalid-project-slug", slug);
  return join(state, "projects", slug, "release-request.json");
}

export function storeReleaseRequestPath(state: string, slug: string): string {
  if (!safeId(slug)) throw new FactoryError("invalid-project-slug", slug);
  return join(state, "projects", slug, "store-release-request.json");
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function releaseSettingsAreValid(value: unknown): value is ProjectReleaseSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const rel = value as Record<string, unknown>;
  if (typeof rel.mode !== "string" || !(PROJECT_RELEASE_MODES as readonly string[]).includes(rel.mode)) return false;
  if (rel.branch !== undefined && (typeof rel.branch !== "string" || rel.branch.trim() === "")) return false;
  if (typeof rel.updatedAt !== "string" || rel.updatedAt.trim() === "") return false;
  return true;
}

export function storeReleaseSettingsAreValid(value: unknown): value is ProjectStoreReleaseSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const sr = value as Record<string, unknown>;
  if (typeof sr.mode !== "string" || !(PROJECT_STORE_RELEASE_MODES as readonly string[]).includes(sr.mode)) return false;
  if (typeof sr.updatedAt !== "string" || sr.updatedAt.trim() === "") return false;
  return true;
}

export function projectSettingsAreValid(value: unknown): value is ProjectSettings {
  const v = value as ProjectSettings | null;
  return (
    v !== null &&
    typeof v === "object" &&
    v.schemaVersion === 1 &&
    Number.isSafeInteger(v.revision) &&
    v.revision >= 0 &&
    (v.skillPacks === undefined || isStringArray(v.skillPacks)) &&
    (v.openDesignCheckpointPaths === undefined || isStringArray(v.openDesignCheckpointPaths)) &&
    (v.release === undefined || releaseSettingsAreValid(v.release)) &&
    (v.storeRelease === undefined || storeReleaseSettingsAreValid(v.storeRelease))
  );
}

/** A Project with no settings record yet has the defaults: no link, no packs. */
export function readProjectSettings(state: string, slug: string): ProjectSettings {
  const path = projectSettingsPath(state, slug);
  // readOptionalJson already refuses by name (`project-settings-invalid`) with the file path and the parse failure.
  const value = readOptionalJson(path, "project-settings-invalid");
  if (value === undefined) return { schemaVersion: 1, revision: 0 };
  if (!projectSettingsAreValid(value)) throw new FactoryError("project-settings-invalid", `project-settings-invalid: ${path}`);
  return value;
}

/**
 * Durable replace of the whole record, serialised behind the state-directory
 * mutation gate (re-entrant, so a caller already inside `stateMutation` is
 * unaffected). The caller still owns any read-modify-write ordering across
 * its own read and this write — `setProjectSkillPacks` holds one mutation
 * across both, and the Open Design sync runs under the Project ingress lock.
 */
export function writeProjectSettings(state: string, slug: string, settings: ProjectSettings): ProjectSettings {
  return stateMutation(state, () => {
    atomicJson(projectSettingsPath(state, slug), settings);
    return settings;
  });
}

export function setProjectSkillPacks(state: string, slug: string, skillPacks: string[]): ProjectSettings {
  return stateMutation(state, () => {
    const current = readProjectSettings(state, slug);
    skillPacks = skillPacks.map(pack => pack.trim());
    if (skillPacks.some((pack) => !safeId(pack)))
      throw new FactoryError("invalid-skill-pack", "Invalid Project skill pack id");
    return writeProjectSettings(state, slug, { ...current, revision: current.revision + 1, skillPacks: [...new Set(skillPacks)] });
  });
}

export function resetProjectSkillPacks(state: string, slug: string): ProjectSettings {
  return stateMutation(state, () => {
    const { skillPacks: _removed, ...current } = readProjectSettings(state, slug);
    return writeProjectSettings(state, slug, { ...current, revision: current.revision + 1 });
  });
}

/** Absent release settings default to `mode: "off"`. */
export function readReleaseSettings(state: string, slug: string): { mode: ProjectReleaseMode; branch?: string; updatedAt?: string } {
  const rel = readProjectSettings(state, slug).release;
  return rel === undefined ? { mode: "off" } : { ...rel };
}

/**
 * Updates Owner-authored Release settings (`mode`, `branch`) in `project-settings.json`.
 * Switching away from `on-request` automatically drops any pending Release request.
 */
export function setProjectReleaseSettings(
  state: string,
  slug: string,
  input: { mode?: ProjectReleaseMode; branch?: string | null },
  now: () => string = () => new Date().toISOString(),
): ProjectSettings {
  return stateMutation(state, () => {
    const current = readProjectSettings(state, slug);
    const prev = current.release;
    let nextMode: ProjectReleaseMode = prev?.mode ?? "off";
    if (input.mode !== undefined) {
      if (!(PROJECT_RELEASE_MODES as readonly string[]).includes(input.mode)) {
        throw new FactoryError("invalid-release-mode", `Invalid release mode: ${String(input.mode)}`);
      }
      nextMode = input.mode;
    }
    let nextBranch: string | undefined = prev?.branch;
    if (input.branch === null) {
      nextBranch = undefined;
    } else if (input.branch !== undefined) {
      const trimmed = input.branch.trim();
      if (trimmed === "" || /\s/.test(trimmed) || trimmed.includes("..") || trimmed.startsWith("-")) {
        throw new FactoryError("invalid-release-branch", `Invalid release branch: ${input.branch}`);
      }
      nextBranch = trimmed;
    }
    const updated: ProjectReleaseSettings = {
      mode: nextMode,
      ...(nextBranch !== undefined ? { branch: nextBranch } : {}),
      updatedAt: now(),
    };
    const saved = writeProjectSettings(state, slug, { ...current, revision: current.revision + 1, release: updated });
    if (nextMode !== "on-request") {
      clearReleaseRequest(state, slug);
    }
    return saved;
  });
}

function releaseRequestIsValid(value: unknown): value is ReleaseRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const req = value as Record<string, unknown>;
  if (typeof req.requestedAt !== "string" || req.requestedAt.trim() === "") return false;
  if (req.version !== undefined && (typeof req.version !== "string" || req.version.trim() === "")) return false;
  if (req.requestedBy !== undefined && typeof req.requestedBy !== "string") return false;
  if (req.directive !== undefined && typeof req.directive !== "string") return false;
  return true;
}

/** Reads the Project's single pending Release request (`release-request.json`), or undefined when absent. */
export function readReleaseRequest(state: string, slug: string): ReleaseRequest | undefined {
  const path = releaseRequestPath(state, slug);
  const value = readOptionalJson(path, "release-request-invalid");
  if (value === undefined) return undefined;
  if (!releaseRequestIsValid(value)) throw new FactoryError("release-request-invalid", `release-request-invalid: ${path}`);
  return value;
}

/** Records (replacing any prior one) the Project's single pending Release request. */
export function setReleaseRequest(
  state: string,
  slug: string,
  request: { version?: string; requestedAt?: string; requestedBy?: string; directive?: string },
): ReleaseRequest {
  return stateMutation(state, () => {
    const version = request.version !== undefined ? request.version.trim() : undefined;
    if (version !== undefined && version === "") {
      throw new FactoryError("invalid-release-version", "Release request version cannot be empty");
    }
    const record: ReleaseRequest = {
      ...(version !== undefined ? { version } : {}),
      requestedAt: request.requestedAt?.trim() || new Date().toISOString(),
      ...(request.requestedBy !== undefined ? { requestedBy: request.requestedBy } : {}),
      ...(request.directive !== undefined ? { directive: request.directive } : {}),
    };
    atomicJson(releaseRequestPath(state, slug), record);
    return record;
  });
}

/** Drops a single state file if present under the state mutation gate. */
function clearStateFile(state: string, path: string): boolean {
  return stateMutation(state, () => {
    const existed = existsSync(path);
    rmSync(path, { force: true });
    return existed;
  });
}

/** Drops the Project's pending Release request if present. Returns true if one existed. */
export function clearReleaseRequest(state: string, slug: string): boolean {
  return clearStateFile(state, releaseRequestPath(state, slug));
}

/** Absent Store release settings default to `mode: "off"`. */
export function readStoreReleaseSettings(state: string, slug: string): { mode: ProjectStoreReleaseMode; updatedAt?: string } {
  const sr = readProjectSettings(state, slug).storeRelease;
  return sr === undefined ? { mode: "off" } : { ...sr };
}

/**
 * Updates Owner-authored Store release settings (`mode`) in `project-settings.json`.
 * Switching away from `on-request` automatically drops any pending Store release request.
 */
export function setProjectStoreReleaseSettings(
  state: string,
  slug: string,
  input: { mode: ProjectStoreReleaseMode },
  now: () => string = () => new Date().toISOString(),
): ProjectSettings {
  return stateMutation(state, () => {
    if (!(PROJECT_STORE_RELEASE_MODES as readonly string[]).includes(input.mode)) {
      throw new FactoryError("invalid-store-release-mode", `Invalid store release mode: ${String(input.mode)}`);
    }
    const current = readProjectSettings(state, slug);
    const updated: ProjectStoreReleaseSettings = {
      mode: input.mode,
      updatedAt: now(),
    };
    const saved = writeProjectSettings(state, slug, { ...current, revision: current.revision + 1, storeRelease: updated });
    if (input.mode !== "on-request") {
      clearStoreReleaseRequest(state, slug);
    }
    return saved;
  });
}

function storeReleaseRequestIsValid(value: unknown): value is StoreReleaseRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const req = value as Record<string, unknown>;
  if (typeof req.target !== "string" || !(STORE_RELEASE_REQUEST_TARGETS as readonly string[]).includes(req.target)) return false;
  if (typeof req.requestedAt !== "string" || req.requestedAt.trim() === "") return false;
  if (
    req.platforms !== undefined &&
    (!Array.isArray(req.platforms) ||
      req.platforms.length === 0 ||
      !req.platforms.every((platform) => platform === "android" || platform === "ios"))
  ) {
    return false;
  }
  if (req.resumeRunId !== undefined && (typeof req.resumeRunId !== "string" || req.resumeRunId.trim() === "")) return false;
  if (req.requestedBy !== undefined && typeof req.requestedBy !== "string") return false;
  if (req.directive !== undefined && typeof req.directive !== "string") return false;
  return true;
}

/** Reads the Project's single pending Store release request (`store-release-request.json`), or undefined when absent. */
export function readStoreReleaseRequest(state: string, slug: string): StoreReleaseRequest | undefined {
  const path = storeReleaseRequestPath(state, slug);
  const value = readOptionalJson(path, "store-release-request-invalid");
  if (value === undefined) return undefined;
  if (!storeReleaseRequestIsValid(value)) {
    throw new FactoryError("store-release-request-invalid", `store-release-request-invalid: ${path}`);
  }
  return value;
}

/** Records (replacing any prior one) the Project's single pending Store release request. */
export function setStoreReleaseRequest(
  state: string,
  slug: string,
  request: {
    target?: StoreReleaseRequestTarget;
    platforms?: StoreReleaseRequestPlatform[];
    resumeRunId?: string;
    resolution?: unknown;
    requestedAt?: string;
    requestedBy?: string;
    directive?: string;
  },
): StoreReleaseRequest {
  return stateMutation(state, () => {
    const target = request.target ?? "staging";
    if (!(STORE_RELEASE_REQUEST_TARGETS as readonly string[]).includes(target)) {
      throw new FactoryError("invalid-store-release-target", `Invalid store release target: ${String(target)}`);
    }
    let platforms: StoreReleaseRequestPlatform[] | undefined;
    if (request.platforms !== undefined) {
      if (
        !Array.isArray(request.platforms) ||
        request.platforms.length === 0 ||
        !request.platforms.every((platform) => platform === "android" || platform === "ios")
      ) {
        throw new FactoryError("invalid-store-release-platforms", "Store release platforms must be a non-empty list of android/ios");
      }
      platforms = [...new Set(request.platforms)];
    }
    const resumeRunId = request.resumeRunId !== undefined ? request.resumeRunId.trim() : undefined;
    if (resumeRunId !== undefined && resumeRunId === "") {
      throw new FactoryError("invalid-store-release-run-id", "Store release resumeRunId cannot be empty");
    }
    const record: StoreReleaseRequest = {
      target,
      ...(platforms !== undefined ? { platforms } : {}),
      ...(resumeRunId !== undefined ? { resumeRunId } : {}),
      ...(request.resolution !== undefined ? { resolution: request.resolution } : {}),
      requestedAt: request.requestedAt?.trim() || new Date().toISOString(),
      ...(request.requestedBy !== undefined ? { requestedBy: request.requestedBy } : {}),
      ...(request.directive !== undefined ? { directive: request.directive } : {}),
    };
    atomicJson(storeReleaseRequestPath(state, slug), record);
    return record;
  });
}

/** Drops the Project's pending Store release request if present. Returns true if one existed. */
export function clearStoreReleaseRequest(state: string, slug: string): boolean {
  return clearStateFile(state, storeReleaseRequestPath(state, slug));
}

/** Files the pre-0.6.0 Scrum workflow left beside a Project's own state. */
const SCRUM_STATE_FILES = ["execution-switch.json", "scrum-lanes.json", "scrum-profiles.json", "scrum-active-profile.json"];

/** A source record with a known kind and string-or-absent request ids; anything else is not carried across. */
function openDesignSourceOf(value: unknown): OpenDesignSource | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (source.kind !== "host" && source.kind !== "client") return undefined;
  for (const key of ["requestId", "acknowledgedRequestId"]) if (source[key] !== undefined && typeof source[key] !== "string") return undefined;
  return source as unknown as OpenDesignSource;
}

function legacySettings(value: unknown): ProjectSettings | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const legacy = value as Record<string, unknown>;
  const settings: ProjectSettings = { schemaVersion: 1, revision: 1 };
  if (isStringArray(legacy.skillPacks)) settings.skillPacks = legacy.skillPacks;
  if (isStringArray(legacy.openDesignCheckpointPaths)) settings.openDesignCheckpointPaths = legacy.openDesignCheckpointPaths;
  const source = openDesignSourceOf(legacy.openDesignSource);
  if (source !== undefined) settings.openDesignSource = source;
  const link = parseOpenDesignLink(legacy.openDesignLink);
  if (link !== undefined) settings.openDesignLink = link;
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
