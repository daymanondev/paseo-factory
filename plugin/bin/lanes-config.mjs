/**
 * The CLIs' lane-table mirror (v0.0.13, ADR 0009 §3 / ADR 0004; the `lead`
 * lane and per-Project overrides arrive in v0.0.14, ADR 0010 §2/§5): plain
 * .mjs, importing no src/ or plugin-server code, kept behaviorally identical
 * to src/lanes.ts by test/lanes.test.ts (the EVENT_NAMES drift-guard
 * precedent). `factory lanes` reads and writes the table; `factory run`
 * resolves its provider through it when --provider is omitted.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectStateDir } from "./project.mjs";

export const LANE_NAMES = ["supervisor", "lead", "worker", "watch", "retro", "freshEyes"];
export const DEFAULT_LANE = "pi/zai/glm-5.3";
export const EYE_JSON_LANE = "eye.json";

export function lanesPath(stateDir) {
  return join(stateDir, "lanes.json");
}

/** Mirrors projectLanesPath in src/lanes.ts — the Project's override file. */
export function projectLanesPath(stateDir, projectSlug) {
  return join(projectStateDir(stateDir, projectSlug), "lanes.json");
}

export function defaultLanes() {
  return { supervisor: DEFAULT_LANE, lead: DEFAULT_LANE, worker: DEFAULT_LANE, watch: DEFAULT_LANE, retro: DEFAULT_LANE, freshEyes: DEFAULT_LANE };
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

/** Mirrors lanesEntries in src/lanes.ts: one file's validated entries, absent → none. */
function lanesEntries(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: true, entries: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${path} must be a JSON object of the six lanes` };
  }
  const entries = {};
  for (const name of LANE_NAMES) {
    const value = parsed[name];
    if (value === undefined) continue;
    if (typeof value !== "string") return { ok: false, reason: `${path}: lane ${name} must be a string` };
    const error = laneError(name, value.trim());
    if (error !== undefined) return { ok: false, reason: `${path}: ${error}` };
    entries[name] = value.trim();
  }
  return { ok: true, entries };
}

/**
 * Mirrors loadLanes: machine file over the six defaults, then the Project's
 * override file layered on top when a slug is given; absent → defaults,
 * partial → filled, broken → a named refusal naming the file.
 */
export function loadLanes(stateDir, projectSlug) {
  const machine = lanesEntries(lanesPath(stateDir));
  if (!machine.ok) return machine;
  let lanes = { ...defaultLanes(), ...machine.entries };
  if (projectSlug === undefined) return { ok: true, lanes };
  const project = lanesEntries(projectLanesPath(stateDir, projectSlug));
  if (!project.ok) return project;
  lanes = { ...lanes, ...project.entries };
  return { ok: true, lanes };
}

/**
 * Mirrors explicitLanes in src/lanes.ts: the lanes one file itself names —
 * the seed persistence keeps, so a save never materializes the defaults.
 */
function explicitLanes(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const explicit = {};
  for (const name of LANE_NAMES) {
    const value = parsed[name];
    if (typeof value === "string") explicit[name] = value.trim();
  }
  return explicit;
}

/**
 * Mirrors saveLanes: merge one lane over the effective table, validate,
 * persist only the named lanes into the TARGET file — the machine file, or
 * with a slug the Project's override file (a project save never materializes
 * machine lanes into it). loadLanes fills defaults at read time — the
 * eye.json retention invariant holds per layer.
 */
export function saveLanes(stateDir, update, projectSlug) {
  const current = loadLanes(stateDir, projectSlug);
  if (!current.ok) return current;
  const next = { ...current.lanes };
  const trimmed = {};
  for (const name of LANE_NAMES) {
    const value = update?.[name];
    if (value === undefined) continue;
    const error = laneError(name, value.trim());
    if (error !== undefined) return { ok: false, reason: error };
    trimmed[name] = value.trim();
  }
  const target = projectSlug === undefined ? lanesPath(stateDir) : projectLanesPath(stateDir, projectSlug);
  const persisted = explicitLanes(target);
  for (const name of LANE_NAMES) {
    const value = trimmed[name];
    if (value === undefined) continue;
    next[name] = value;
    persisted[name] = value;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(persisted, null, 2)}\n`);
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
