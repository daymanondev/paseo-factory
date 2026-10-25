/**
 * The CLIs' lane-table mirror (v0.0.13, ADR 0009 §3 / ADR 0004; the `lead`
 * lane and per-Project overrides arrive in v0.0.14, ADR 0010 §2/§5; the
 * Lane profile store and Project-scoped run resolution arrive in v0.0.38,
 * ADR 0026 §2/§3): plain .mjs, importing no src/ or plugin-server code, kept
 * behaviorally identical to src/lanes.ts by test/lanes.test.ts and
 * test/cli.test.ts (the EVENT_NAMES drift-guard precedent). `factory lanes`
 * reads and writes the table; `factory profile` manages the Owner's Lane
 * profiles; `factory run` resolves its provider through it when --provider
 * is omitted.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Mirrors parseLane in src/lanes.ts — splits provider/model[:thinking]. */
export function parseLane(value) {
  if (value === EYE_JSON_LANE || /\s/.test(value)) return undefined;
  const slash = value.indexOf("/");
  if (slash === -1) return undefined;
  const provider = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  if (provider.trim() === "" || rest.trim() === "") return undefined;
  const colon = rest.lastIndexOf(":");
  if (colon === -1) return { provider, model: rest };
  const model = rest.slice(0, colon);
  const thinking = rest.slice(colon + 1);
  if (model.trim() === "" || thinking.trim() === "") return undefined;
  return { provider, model, thinking };
}

/** Mirrors laneError in src/lanes.ts — the drift test walks the same matrix. */
export function laneError(name, value) {
  if (name === "freshEyes" && value === EYE_JSON_LANE) return undefined;
  const slash = value.indexOf("/");
  if (slash === -1) {
    return `lane ${name}="${value}" is not provider/model — name the model explicitly (never auto), or "eye.json" for freshEyes`;
  }
  if (parseLane(value) === undefined) {
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
 * broken lanes.json is a named refusal, never a silent default. Since v0.0.38
 * (ADR 0026 §3) the omitted path threads `projectSlug`: the Project's
 * `<projectStateDir>/lanes.json` worker override is honored before the
 * machine table.
 */
export function resolveRunProvider(stateDir, providerFlag, projectSlug) {
  if (typeof providerFlag === "string" && providerFlag.trim() !== "") return { ok: true, provider: providerFlag.trim() };
  const lanes = loadLanes(stateDir, projectSlug);
  if (!lanes.ok) return lanes;
  return { ok: true, provider: lanes.lanes.worker };
}

/**
 * The atomic batch lane save (v0.0.38, ADR 0026 §5): several lanes in ONE
 * file write, never concurrent single-lane writes racing (the Watch & Retro
 * defect). The bin mirror of `saveLanesBatch` in src/lanes.ts — `saveLanes`
 * here already persists a whole partial update in a single write, so the
 * parity name rides it directly.
 */
export function saveLanesBatch(stateDir, update, projectSlug) {
  return saveLanes(stateDir, update, projectSlug);
}

// ---- the CLIs' Lane profile mirror (v0.0.38, ADR 0026 §2) -----------------------------------
//
// Mirrors the core's profiles.json operations in src/lane-profiles.ts
// (re-exported by src/lanes.ts) against the SAME LaneProfilesFile schema
// (Implementation Decision 1): plain .mjs, importing no src/ code, pinned to
// the core by test/cli.test.ts's drift test (the spool semantic-key
// precedent). `<stateDir>/profiles.json` starts with zero built-in profiles —
// every profile is the Owner's own act. Where the core throws FactoryError,
// this side answers the bin's own `{ ok: false, reason }` refusal (the
// loadLanes law) — the drift test compares behavior, never error style.

/** The profile id law: `[a-z0-9][a-z0-9-_]{0,63}`. */
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/** Where the Owner's Lane profiles live — `<stateDir>/profiles.json`, beside lanes.json. */
export function laneProfilesPath(stateDir) {
  return join(stateDir, "profiles.json");
}

/**
 * Reads profiles.json: an absent file is the empty store ({ profiles: {} });
 * unparseable JSON, a non-object, or a missing `profiles` object is a named
 * refusal — never a guessed empty (the eye.json discipline).
 */
function readProfilesFile(stateDir) {
  const path = laneProfilesPath(stateDir);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: true, file: { profiles: {} } };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${path} must be a JSON object of { profiles, deleted?, activeProfileByScope? }` };
  }
  if (typeof parsed.profiles !== "object" || parsed.profiles === null || Array.isArray(parsed.profiles)) {
    return { ok: false, reason: `${path} must carry a "profiles" object keyed by profile id` };
  }
  return { ok: true, file: parsed };
}

/**
 * Persists the whole file — one atomic write per profile act. `deleted` and
 * `activeProfileByScope` ride only when non-empty (the core's own write law),
 * so an untouched store never materializes empty maps.
 */
function writeProfilesFile(stateDir, { profiles, deleted, activeProfileByScope }) {
  const record = { profiles };
  if (deleted !== undefined && Object.keys(deleted).length > 0) record.deleted = deleted;
  if (activeProfileByScope !== undefined && Object.keys(activeProfileByScope).length > 0) record.activeProfileByScope = activeProfileByScope;
  writeFileSync(laneProfilesPath(stateDir), `${JSON.stringify(record, null, 2)}\n`);
}

/** The file's profile records as id-carrying LaneProfile objects. */
function fileProfiles(file) {
  return Object.entries(file.profiles).map(([id, rest]) => ({ id, ...rest }));
}

/** The scope key a profile apply records — the Project's slug, or "global". */
function scopeKey(projectSlug) {
  const trimmed = typeof projectSlug === "string" ? projectSlug.trim() : "";
  return trimmed === "" ? "global" : trimmed;
}

/**
 * Mirrors laneProfileIdFromName: lowercase, every non-[a-z0-9] run one "-",
 * no edge dashes, capped at 64 — a name with nothing slug-able falls back to
 * "profile" (the id stays addressable, the name stays the Owner's label).
 */
export function laneProfileIdFromName(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug === "" ? "profile" : slug;
}

/** Mirrors listLaneProfiles: every saved profile, sorted by `name` then `id`. */
export function listLaneProfiles(stateDir) {
  const read = readProfilesFile(stateDir);
  if (!read.ok) return read;
  const profiles = fileProfiles(read.file).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return { ok: true, profiles };
}

/** Mirrors getLaneProfile: one profile by id, undefined when not saved. */
export function getLaneProfile(stateDir, id) {
  const read = readProfilesFile(stateDir);
  if (!read.ok) return read;
  return { ok: true, profile: fileProfiles(read.file).find((entry) => entry.id === id) };
}

/**
 * Resolves a CLI `<id-or-name>` positional: an exact id first, then an exact
 * name. undefined when neither matches — the caller names its refusal.
 */
export function findLaneProfile(stateDir, idOrName) {
  const read = readProfilesFile(stateDir);
  if (!read.ok) return read;
  const profiles = fileProfiles(read.file);
  return { ok: true, profile: profiles.find((entry) => entry.id === idOrName) ?? profiles.find((entry) => entry.name === idOrName) };
}

/** Validates a full 6-lane table through laneError — a profile is whole or refused. */
function profileLanesError(lanes) {
  const validated = {};
  for (const name of LANE_NAMES) {
    const value = typeof lanes === "object" && lanes !== null ? lanes[name] : undefined;
    if (typeof value !== "string") return { ok: false, reason: `profile lane ${name} is missing — a profile carries all six lanes whole` };
    const error = laneError(name, value.trim());
    if (error !== undefined) return { ok: false, reason: error };
    validated[name] = value.trim();
  }
  return { ok: true, lanes: validated };
}

/**
 * Mirrors saveLaneProfile: create-or-update one profile. `id` derives from
 * `name` when omitted; every lane is validated through laneError before
 * anything is written; a refused value writes nothing. Re-saving a
 * tombstoned id clears its tombstone (a re-created profile is live again).
 */
export function saveLaneProfile(stateDir, input) {
  const read = readProfilesFile(stateDir);
  if (!read.ok) return read;
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (name === "") return { ok: false, reason: "profile name must be a non-empty string" };
  let id = typeof input?.id === "string" && input.id !== "" ? input.id : undefined;
  if (id === undefined) id = laneProfileIdFromName(input.name);
  if (!PROFILE_ID_PATTERN.test(id)) {
    return { ok: false, reason: `profile id "${id}" must match [a-z0-9][a-z0-9-_]{0,63} — omit it to derive one from the name` };
  }
  const checked = profileLanesError(input?.lanes);
  if (!checked.ok) return checked;
  const description = typeof input?.description === "string" && input.description.trim() !== "" ? input.description.trim() : undefined;
  const updatedAt = typeof input?.updatedAt === "string" ? input.updatedAt : new Date().toISOString();
  const record = { name, ...(description === undefined ? {} : { description }), lanes: checked.lanes, updatedAt };
  const profiles = { ...read.file.profiles, [id]: record };
  const deleted = { ...(read.file.deleted ?? {}) };
  delete deleted[id];
  writeProfilesFile(stateDir, { profiles, deleted, activeProfileByScope: read.file.activeProfileByScope });
  return { ok: true, profile: { id, ...record }, created: !Object.prototype.hasOwnProperty.call(read.file.profiles, id) };
}

/**
 * Mirrors applyLaneProfile — Copy-on-Apply (ADR 0026 §2): all six lanes are
 * validated again, then written into the target file (the Project's override
 * under a slug, the machine table without) in one atomic save, and the
 * scope's activeProfileByScope pointer records the applied profile id. No
 * live pointer is ever left — the Project's lanes.json stays self-contained.
 */
export function applyLaneProfile(stateDir, id, projectSlug) {
  const got = getLaneProfile(stateDir, id);
  if (!got.ok) return got;
  if (got.profile === undefined) return { ok: false, reason: `no Lane profile "${id}" under ${stateDir} — save one first` };
  const checked = profileLanesError(got.profile.lanes);
  if (!checked.ok) return { ok: false, reason: `${laneProfilesPath(stateDir)}: profile ${id}: ${checked.reason}` };
  const slug = scopeKey(projectSlug) === "global" ? undefined : projectSlug.trim();
  const saved = saveLanes(stateDir, checked.lanes, slug);
  if (!saved.ok) return saved;
  const read = readProfilesFile(stateDir);
  if (!read.ok) return read;
  const activeProfileByScope = { ...(read.file.activeProfileByScope ?? {}), [scopeKey(projectSlug)]: id };
  writeProfilesFile(stateDir, { profiles: read.file.profiles, deleted: read.file.deleted, activeProfileByScope });
  return { ok: true, profile: got.profile, lanes: saved.lanes, path: slug === undefined ? lanesPath(stateDir) : projectLanesPath(stateDir, slug) };
}

/**
 * Mirrors deleteLaneProfile: remove the profile, keep a tombstone (the vault
 * merge's deletion record), and drop every activeProfileByScope pointer that
 * named it. `deleted: false` when the id was never saved — never an error.
 */
export function deleteLaneProfile(stateDir, id, deletedAt) {
  const read = readProfilesFile(stateDir);
  if (!read.ok) return read;
  const profiles = { ...read.file.profiles };
  if (!Object.prototype.hasOwnProperty.call(profiles, id)) return { ok: true, deleted: false };
  const profile = { id, ...profiles[id] };
  delete profiles[id];
  const deleted = { ...(read.file.deleted ?? {}), [id]: { deletedAt: typeof deletedAt === "string" ? deletedAt : new Date().toISOString() } };
  const scopes = {};
  for (const [scope, pointer] of Object.entries(read.file.activeProfileByScope ?? {})) {
    if (pointer !== id) scopes[scope] = pointer;
  }
  writeProfilesFile(stateDir, { profiles, deleted, activeProfileByScope: scopes });
  return { ok: true, deleted: true, profile };
}

/**
 * Mirrors resetProjectLanes (the `Reset to Machine Default` act): remove the
 * Project's override file so it inherits the machine-wide Lane config again,
 * and clear the scope's active-profile pointer. `removed` reports whether an
 * override file actually went away; the machine lanes return as they now
 * stand. Both files are read and validated BEFORE the removal (the core's
 * law): a damaged profiles.json or machine lanes.json refuses with the
 * override file untouched — the reset never half-applies.
 */
export function resetProjectLanes(stateDir, projectSlug) {
  if (typeof projectSlug !== "string" || projectSlug.trim() === "") {
    return { ok: false, reason: "lanes reset needs the Project's slug" };
  }
  const slug = projectSlug.trim();
  const read = readProfilesFile(stateDir);
  if (!read.ok) return read;
  const lanes = loadLanes(stateDir);
  if (!lanes.ok) return lanes;
  const target = projectLanesPath(stateDir, slug);
  let removed = false;
  try {
    rmSync(target);
    removed = true;
  } catch {
    removed = false; // no override file — the Project already inherits
  }
  if (read.file.activeProfileByScope !== undefined && Object.prototype.hasOwnProperty.call(read.file.activeProfileByScope, slug)) {
    const activeProfileByScope = { ...read.file.activeProfileByScope };
    delete activeProfileByScope[slug];
    writeProfilesFile(stateDir, { profiles: read.file.profiles, deleted: read.file.deleted, activeProfileByScope });
  }
  return { ok: true, lanes: lanes.lanes, removed };
}
