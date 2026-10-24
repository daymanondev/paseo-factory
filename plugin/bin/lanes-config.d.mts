/**
 * The lanes mirror's declaration — see lanes-config.mjs for why it exists
 * (plain .mjs, no build step, no src/ imports per ADR 0004).
 * test/lanes.test.ts and test/cli.test.ts run it and guard the mirror
 * against src/lanes.ts / src/lane-profiles.ts drift.
 */

export declare const LANE_NAMES: string[];
export declare const DEFAULT_LANE: string;
export declare const EYE_JSON_LANE: string;

/** One saved Lane profile (v0.0.38, ADR 0026 §2) — mirrors src/lane-profiles.ts's LaneProfile. */
export declare interface LaneProfile {
  id: string;
  name: string;
  description?: string;
  lanes: Record<string, string>;
  updatedAt: string;
}

export declare function lanesPath(stateDir: string): string;
export declare function projectLanesPath(stateDir: string, projectSlug: string): string;
export declare function defaultLanes(): Record<string, string>;
export declare function parseLane(value: string): { provider: string; model: string; thinking?: string } | null;
export declare function laneError(name: string, value: string): string | undefined;
export declare function loadLanes(
  stateDir: string,
  projectSlug?: string,
): { ok: true; lanes: Record<string, string> } | { ok: false; reason: string };
export declare function saveLanes(
  stateDir: string,
  update: Record<string, string>,
  projectSlug?: string,
): { ok: true; lanes: Record<string, string> } | { ok: false; reason: string };
export declare function resolveRunProvider(
  stateDir: string,
  providerFlag: string | undefined,
  projectSlug?: string,
): { ok: true; provider: string } | { ok: false; reason: string };
export declare function saveLanesBatch(
  stateDir: string,
  update: Record<string, string>,
  projectSlug?: string,
): { ok: true; lanes: Record<string, string> } | { ok: false; reason: string };

// ---- the CLIs' Lane profile mirror (v0.0.38, ADR 0026 §2) -----------------------------------

export declare function laneProfilesPath(stateDir: string): string;
export declare function laneProfileIdFromName(name: string): string;
export declare function listLaneProfiles(
  stateDir: string,
): { ok: true; profiles: LaneProfile[] } | { ok: false; reason: string };
export declare function getLaneProfile(
  stateDir: string,
  id: string,
): { ok: true; profile: LaneProfile | undefined } | { ok: false; reason: string };
export declare function findLaneProfile(
  stateDir: string,
  idOrName: string,
): { ok: true; profile: LaneProfile | undefined } | { ok: false; reason: string };
export declare function saveLaneProfile(
  stateDir: string,
  input: { id?: string; name: string; description?: string; lanes: Record<string, string>; updatedAt?: string },
): { ok: true; profile: LaneProfile; created: boolean } | { ok: false; reason: string };
export declare function applyLaneProfile(
  stateDir: string,
  id: string,
  projectSlug?: string,
): { ok: true; profile: LaneProfile; lanes: Record<string, string>; path: string } | { ok: false; reason: string };
export declare function deleteLaneProfile(
  stateDir: string,
  id: string,
  deletedAt?: string,
): { ok: true; deleted: boolean; profile?: LaneProfile } | { ok: false; reason: string };
export declare function resetProjectLanes(
  stateDir: string,
  projectSlug: string,
): { ok: true; lanes: Record<string, string>; removed: boolean } | { ok: false; reason: string };
