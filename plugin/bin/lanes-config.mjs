/**
 * The CLIs' lane-table mirror (v0.0.13, ADR 0009 §3 / ADR 0004): plain .mjs,
 * importing no src/ or plugin-server code, kept behaviorally identical to
 * src/lanes.ts by test/lanes.test.ts (the EVENT_NAMES drift-guard precedent).
 * `factory lanes` reads and writes the table; `factory run` resolves its
 * provider through it when --provider is omitted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LANE_NAMES = ["supervisor", "worker", "watch", "retro", "freshEyes"];
export const DEFAULT_LANE = "pi/zai/glm-5.3";
export const EYE_JSON_LANE = "eye.json";

export function lanesPath(stateDir) {
  return join(stateDir, "lanes.json");
}

export function defaultLanes() {
  return { supervisor: DEFAULT_LANE, worker: DEFAULT_LANE, watch: DEFAULT_LANE, retro: DEFAULT_LANE, freshEyes: DEFAULT_LANE };
}

/** Mirrors laneError in src/lanes.ts — the drift test walks the same matrix. */
export function laneError(name, value) {
  if (name === "freshEyes" && value === EYE_JSON_LANE) return undefined;
  const slash = value.indexOf("/");
  if (slash === -1) {
    return `lane ${name}="${value}" is not provider/model — name the model explicitly (never auto), or "eye.json" for freshEyes`;
  }
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (provider.trim() === "" || model.trim() === "" || /\s/.test(value)) {
    return `lane ${name}="${value}" must be provider/model with both halves non-empty and no whitespace`;
  }
  return undefined;
}

/** Mirrors loadLanes: absent → defaults, partial → filled, broken → a named refusal. */
export function loadLanes(stateDir) {
  const path = lanesPath(stateDir);
  if (!existsSync(path)) return { ok: true, lanes: defaultLanes() };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${path} must be a JSON object of the five lanes` };
  }
  const lanes = defaultLanes();
  for (const name of LANE_NAMES) {
    const value = parsed[name];
    if (value === undefined) continue;
    if (typeof value !== "string") return { ok: false, reason: `${path}: lane ${name} must be a string` };
    const error = laneError(name, value.trim());
    if (error !== undefined) return { ok: false, reason: `${path}: ${error}` };
    lanes[name] = value.trim();
  }
  return { ok: true, lanes };
}

/** Mirrors saveLanes: merge one lane over the current table, validate, write whole. */
export function saveLanes(stateDir, update) {
  const current = loadLanes(stateDir);
  if (!current.ok) return current;
  const next = { ...current.lanes };
  for (const name of LANE_NAMES) {
    const value = update?.[name];
    if (value === undefined) continue;
    const error = laneError(name, value.trim());
    if (error !== undefined) return { ok: false, reason: error };
    next[name] = value.trim();
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(lanesPath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, lanes: next };
}

/**
 * `factory run`'s provider precedence (ADR 0009 §3): an explicit --provider
 * always wins; omitted reads lanes.worker (defaulting when no file exists); a
 * broken lanes.json is a named refusal, never a silent default.
 */
export function resolveRunProvider(stateDir, providerFlag) {
  if (typeof providerFlag === "string" && providerFlag.trim() !== "") return { ok: true, provider: providerFlag.trim() };
  const lanes = loadLanes(stateDir);
  if (!lanes.ok) return lanes;
  return { ok: true, provider: lanes.lanes.worker };
}
