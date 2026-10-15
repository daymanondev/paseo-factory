/**
 * The lanes mirror's declaration — see lanes-config.mjs for why it exists
 * (plain .mjs, no build step, no src/ imports per ADR 0004).
 * test/lanes.test.ts runs it and guards the mirror against src/lanes.ts drift.
 */

export declare const LANE_NAMES: string[];
export declare const DEFAULT_LANE: string;
export declare const EYE_JSON_LANE: string;

export declare function lanesPath(stateDir: string): string;
export declare function defaultLanes(): Record<string, string>;
export declare function laneError(name: string, value: string): string | undefined;
export declare function loadLanes(stateDir: string): { ok: true; lanes: Record<string, string> } | { ok: false; reason: string };
export declare function saveLanes(
  stateDir: string,
  update: Record<string, string>,
): { ok: true; lanes: Record<string, string> } | { ok: false; reason: string };
export declare function resolveRunProvider(
  stateDir: string,
  providerFlag: string | undefined,
): { ok: true; provider: string } | { ok: false; reason: string };
