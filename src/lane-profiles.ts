/**
 * Owner-authored Lane profiles (v0.0.38, ADR 0026 §2): a named, reusable
 * 6-lane table persisted in `<stateDir>/profiles.json` — starting EMPTY with
 * zero built-in profiles (every profile is the Owner's act; the file is
 * absent until the first save). Applying a profile is Copy-on-Apply: all six
 * lane values are written into the target `lanes.json` (the machine file, or
 * a Project's own override file) in one atomic batch, and
 * `activeProfileByScope` records which profile a scope last applied —
 * metadata only, never a live pointer. Each Project's `lanes.json` stays
 * self-contained (ADR 0026 Out of Scope forbids references into
 * profiles.json), so a later profile edit or delete never rewrites a Project
 * that already applied it.
 *
 * Deletion writes a tombstone (`deleted[profileId].deletedAt`) so
 * `Private vault` merges propagate a deletion to machines that still hold
 * the profile, and clears any `activeProfileByScope` entry naming it — the
 * same hygiene `resetProjectLanes` applies per Project.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FactoryError } from "./errors.ts";
import { LANE_NAMES, laneError, lanesPath, loadLanes, projectLanesPath, saveLanes } from "./lanes.ts";
import type { LaneName, Lanes } from "./lanes.ts";

/** One saved profile — the six lanes whole, an Owner-given name, and the last edit's ISO timestamp. */
export interface LaneProfile {
  id: string;
  name: string;
  description?: string;
  lanes: Lanes;
  updatedAt: string;
}

/** A deleted profile's durable marker — `Private vault` merges key on `deletedAt`. */
export interface LaneProfileTombstone {
  deletedAt: string;
}

/**
 * The `profiles.json` shape: live profiles keyed by id (the id lives in the
 * key alone, exactly the shape the spec block fixes), optional tombstones
 * for deleted ids, and the last-applied profile per scope (`"global"` or a
 * `<projectSlug>`).
 */
export interface LaneProfilesFile {
  profiles: Record<string, Omit<LaneProfile, "id">>;
  deleted?: Record<string, LaneProfileTombstone>;
  activeProfileByScope?: Record<string, string>;
}

/** Where the Owner's Lane profiles live — `<stateDir>/profiles.json`, beside `lanes.json`. */
export function laneProfilesPath(stateDir: string): string {
  return join(stateDir, "profiles.json");
}

/** The profile id law — a normalized slug the Owner may also give explicitly. */
const LANE_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/**
 * Derives a profile id from `name`: lowercase, every non-`[a-z0-9]` run one
 * `-`, no leading/trailing `-`, capped at 64 chars. A name with no
 * slug-able character falls back to `"profile"` — the id is addressable,
 * the name stays the Owner's label.
 */
export function laneProfileIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug === "" ? "profile" : slug;
}

/** Reads `profiles.json`; an absent file is an empty one (zero built-ins, by law). */
export function readLaneProfilesFile(stateDir: string): LaneProfilesFile {
  const path = laneProfilesPath(stateDir);
  if (!existsSync(path)) return { profiles: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new FactoryError("profiles-unreadable", `${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FactoryError("profiles-unreadable", `${path} must be a JSON object of Lane profiles`);
  }
  const record = parsed as Partial<LaneProfilesFile>;
  if (record.profiles === undefined || record.profiles === null || typeof record.profiles !== "object" || Array.isArray(record.profiles)) {
    throw new FactoryError("profiles-unreadable", `${path} must carry a "profiles" object keyed by profile id`);
  }
  const file: LaneProfilesFile = { profiles: record.profiles as Record<string, Omit<LaneProfile, "id">> };
  if (record.deleted !== undefined && record.deleted !== null && typeof record.deleted === "object" && !Array.isArray(record.deleted)) {
    file.deleted = record.deleted;
  }
  if (
    record.activeProfileByScope !== undefined &&
    record.activeProfileByScope !== null &&
    typeof record.activeProfileByScope === "object" &&
    !Array.isArray(record.activeProfileByScope)
  ) {
    file.activeProfileByScope = record.activeProfileByScope;
  }
  return file;
}

function writeLaneProfilesFile(stateDir: string, file: LaneProfilesFile): void {
  const path = laneProfilesPath(stateDir);
  const record: LaneProfilesFile = { profiles: file.profiles };
  if (file.deleted !== undefined && Object.keys(file.deleted).length > 0) record.deleted = file.deleted;
  if (file.activeProfileByScope !== undefined && Object.keys(file.activeProfileByScope).length > 0) {
    record.activeProfileByScope = file.activeProfileByScope;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** Every live profile with its id re-attached, sorted by name then id — the list view's order. */
export function listLaneProfiles(stateDir: string): LaneProfile[] {
  const file = readLaneProfilesFile(stateDir);
  const profiles: LaneProfile[] = [];
  for (const [id, entry] of Object.entries(file.profiles)) {
    profiles.push({ id, ...entry });
  }
  return profiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One profile by id, or undefined when no live profile carries it. */
export function getLaneProfile(stateDir: string, id: string): LaneProfile | undefined {
  const entry = readLaneProfilesFile(stateDir).profiles[id];
  return entry === undefined ? undefined : { id, ...entry };
}

/**
 * Validates a whole 6-lane table through the existing `laneError` — every
 * lane must be present and usable; a missing lane is an error, never a
 * silent default (a profile is a complete preset or it is refused).
 */
function validatedProfileLanes(lanes: Lanes): Lanes {
  for (const name of LANE_NAMES) {
    const value = lanes[name];
    if (typeof value !== "string") {
      throw new FactoryError("invalid-profile", `profile lane ${name} is missing — a profile carries all six lanes whole`);
    }
    const error = laneError(name, value.trim());
    if (error !== undefined) throw new FactoryError("invalid-lane", error);
  }
  const trimmed = {} as Lanes;
  for (const name of LANE_NAMES) trimmed[name] = lanes[name].trim();
  return trimmed;
}

/**
 * Creates or updates one profile. `id` is the normalized slug derived from
 * `name` when omitted (`[a-z0-9][a-z0-9-_]{0,63}`); saving an existing id
 * updates it in place with a fresh `updatedAt` and clears any deletion
 * tombstone (a re-created profile is live again). Every lane is validated
 * through `laneError` before anything is written.
 */
export function saveLaneProfile(
  stateDir: string,
  input: { id?: string; name: string; description?: string; lanes: Lanes; updatedAt?: string },
): LaneProfile {
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new FactoryError("invalid-profile", "profile name must be a non-empty string");
  }
  const id = input.id ?? laneProfileIdFromName(input.name);
  if (!LANE_PROFILE_ID_PATTERN.test(id)) {
    throw new FactoryError(
      "invalid-profile-id",
      `profile id "${id}" must match [a-z0-9][a-z0-9-_]{0,63} — omit it to derive one from the name`,
    );
  }
  const lanes = validatedProfileLanes(input.lanes);
  const description = input.description?.trim() === "" ? undefined : input.description?.trim();
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const file = readLaneProfilesFile(stateDir);
  file.profiles[id] = {
    name: input.name.trim(),
    ...(description === undefined ? {} : { description }),
    lanes,
    updatedAt,
  };
  if (file.deleted !== undefined) delete file.deleted[id];
  writeLaneProfilesFile(stateDir, file);
  return { id, ...file.profiles[id]! };
}

/**
 * Deletes one profile: the entry moves out of `profiles` into a `deleted`
 * tombstone (`deletedAt`, default now) so vault merges propagate the
 * deletion, and every `activeProfileByScope` entry naming it is removed.
 * Returns whether a live profile was deleted; an unknown id changes nothing.
 */
export function deleteLaneProfile(stateDir: string, id: string, deletedAt?: string): boolean {
  const file = readLaneProfilesFile(stateDir);
  if (file.profiles[id] === undefined) return false;
  delete file.profiles[id];
  const tombstone = { deletedAt: deletedAt ?? new Date().toISOString() };
  file.deleted = { ...(file.deleted ?? {}), [id]: tombstone };
  if (file.activeProfileByScope !== undefined) {
    for (const [scope, profileId] of Object.entries(file.activeProfileByScope)) {
      if (profileId === id) delete file.activeProfileByScope[scope];
    }
  }
  writeLaneProfilesFile(stateDir, file);
  return true;
}

/** The scope key a profile apply records — `"global"`, or the Project's own slug. */
function profileScope(projectSlug: string | undefined): string {
  return projectSlug === undefined || projectSlug.trim() === "" ? "global" : projectSlug.trim();
}

/**
 * Applies one profile Copy-on-Apply (ADR 0026 §2): all six lanes are
 * validated again, then written in ONE atomic batch into the machine
 * `<stateDir>/lanes.json` (no `projectSlug`) or the Project's own
 * `<projectStateDir>/lanes.json` — the target file ends self-contained, no
 * live pointer back to `profiles.json`. `activeProfileByScope[scope]`
 * records which profile the scope last applied. Throws `profile-not-found`
 * for an unknown id and `invalid-lane` for a lane that stopped validating.
 */
export function applyLaneProfile(
  stateDir: string,
  id: string,
  projectSlug?: string,
): { profile: LaneProfile; lanes: Lanes; path: string } {
  const profile = getLaneProfile(stateDir, id);
  if (profile === undefined) {
    throw new FactoryError("profile-not-found", `no Lane profile "${id}" under ${stateDir} — save one first`);
  }
  const lanes = validatedProfileLanes(profile.lanes);
  const slug = projectSlug !== undefined && projectSlug.trim() !== "" ? projectSlug.trim() : undefined;
  // The profile's lanes validated above, so a refusal here is a broken lanes
  // file at the target layer — named, never a guessed default.
  const saved = saveLanes(stateDir, lanes, slug);
  if (!saved.ok) throw new FactoryError("lanes-unreadable", saved.reason);
  const file = readLaneProfilesFile(stateDir);
  file.activeProfileByScope = { ...(file.activeProfileByScope ?? {}), [profileScope(slug)]: id };
  writeLaneProfilesFile(stateDir, file);
  return { profile, lanes: saved.lanes, path: slug === undefined ? lanesPath(stateDir) : projectLanesPath(stateDir, slug) };
}

/**
 * ONE atomic multi-lane write (the Watch & Retro race fix, ADR 0026 §1):
 * every lane in `update` is validated first — any refusal writes nothing,
 * anywhere — then the whole batch lands in a single `saveLanes` write into
 * the machine `lanes.json` or the Project's override file. Returns the
 * effective merged table and the file it persisted into.
 */
export function saveLanesBatch(
  stateDir: string,
  update: Partial<Record<LaneName, string>>,
  projectSlug?: string,
): { lanes: Lanes; path: string } {
  for (const name of LANE_NAMES) {
    const value = update[name];
    if (value === undefined) continue;
    const error = laneError(name, value.trim());
    if (error !== undefined) throw new FactoryError("invalid-lane", error);
  }
  const slug = projectSlug !== undefined && projectSlug.trim() !== "" ? projectSlug.trim() : undefined;
  // Lanes are validated above, so a refusal here can only be a broken lanes
  // file — the lanes.ts named error, never a guessed default.
  const saved = saveLanes(stateDir, update, slug);
  if (!saved.ok) throw new FactoryError("lanes-unreadable", saved.reason);
  return { lanes: saved.lanes, path: slug === undefined ? lanesPath(stateDir) : projectLanesPath(stateDir, slug) };
}

/**
 * Resets one Project to the machine Lane config (ADR 0026 §2): the Project's
 * override file is removed so `loadLanes` inherits `<stateDir>/lanes.json`
 * again, and `activeProfileByScope[projectSlug]` is cleared. `removed`
 * names whether an override file existed; `lanes` is the effective machine
 * table the Project now runs under. Both files are read and validated BEFORE
 * the removal, so a damaged `profiles.json` or machine `lanes.json` refuses
 * with the override file untouched — the reset never half-applies.
 */
export function resetProjectLanes(stateDir: string, projectSlug: string): { lanes: Lanes; removed: boolean } {
  const slug = projectSlug.trim();
  if (slug === "") {
    throw new FactoryError("invalid-project", "resetProjectLanes needs the Project's slug — pass the one the surface resolved from its root");
  }
  // Validate every input the act touches BEFORE mutating anything: a damaged
  // profiles.json or a broken machine lanes.json refuses with the Project's
  // override file untouched — never a half-applied reset reported as failure.
  const file = readLaneProfilesFile(stateDir);
  const machine = loadLanes(stateDir);
  if (!machine.ok) throw new FactoryError("lanes-unreadable", machine.reason);
  const path = projectLanesPath(stateDir, slug);
  const removed = existsSync(path);
  if (removed) rmSync(path);
  if (file.activeProfileByScope !== undefined && file.activeProfileByScope[slug] !== undefined) {
    delete file.activeProfileByScope[slug];
    writeLaneProfilesFile(stateDir, file);
  }
  return { lanes: machine.lanes, removed };
}

/**
 * Key-level merge of two `profiles.json` sides (ADR 0026 §4 — the `Private
 * vault` sync law): per profile id the NEWER ISO `updatedAt` wins, per
 * tombstone the NEWER ISO `deletedAt` wins, and both sides' ids union so
 * profiles created on different machines combine rather than overwrite. A
 * tombstone newer than (or equal to) the merged profile's `updatedAt` keeps
 * the profile deleted; a profile re-saved after the deletion (`updatedAt`
 * newer) is live again. `preferRemote` breaks exact-timestamp ties.
 * `activeProfileByScope` unions per scope (ties to the preferred side), and
 * a scope entry whose profile the merge deleted is dropped.
 */
export function mergeLaneProfilesFiles(
  local: LaneProfilesFile,
  remote: LaneProfilesFile,
  options?: { preferRemote?: boolean },
): LaneProfilesFile {
  const preferRemote = options?.preferRemote === true;
  const stamp = (value: string | undefined): string => value ?? ""; // absent = oldest — never wins a comparison
  const merged: LaneProfilesFile = { profiles: {} };
  const deleted: Record<string, LaneProfileTombstone> = {};

  for (const id of new Set([...Object.keys(local.profiles ?? {}), ...Object.keys(remote.profiles ?? {}), ...Object.keys(local.deleted ?? {}), ...Object.keys(remote.deleted ?? {})])) {
    const localProfile = local.profiles?.[id];
    const remoteProfile = remote.profiles?.[id];
    const localTombstone = local.deleted?.[id];
    const remoteTombstone = remote.deleted?.[id];

    const tombstone =
      stamp(remoteTombstone?.deletedAt) > stamp(localTombstone?.deletedAt)
        ? remoteTombstone
        : stamp(localTombstone?.deletedAt) > stamp(remoteTombstone?.deletedAt)
          ? localTombstone
          : localTombstone ?? remoteTombstone ?? (preferRemote ? remoteTombstone : localTombstone);
    const profile =
      stamp(remoteProfile?.updatedAt) > stamp(localProfile?.updatedAt)
        ? remoteProfile
        : stamp(localProfile?.updatedAt) > stamp(remoteProfile?.updatedAt)
          ? localProfile
          : preferRemote
            ? remoteProfile ?? localProfile
            : localProfile ?? remoteProfile;

    if (tombstone !== undefined && profile === undefined) {
      deleted[id] = tombstone;
      continue;
    }
    if (tombstone !== undefined && profile !== undefined) {
      // Newer act wins: a re-save after the deletion revives the profile;
      // a deletion at or after the last edit keeps it deleted.
      if (stamp(tombstone.deletedAt) >= stamp(profile.updatedAt)) {
        deleted[id] = tombstone;
        continue;
      }
    }
    if (profile !== undefined) merged.profiles[id] = profile;
  }

  const activeProfileByScope: Record<string, string> = {};
  for (const [scope, profileId] of Object.entries(local.activeProfileByScope ?? {})) activeProfileByScope[scope] = profileId;
  for (const [scope, profileId] of Object.entries(remote.activeProfileByScope ?? {})) {
    if (preferRemote || activeProfileByScope[scope] === undefined) activeProfileByScope[scope] = profileId;
  }
  // A scope may not point at a profile the merge deleted — delete's own hygiene.
  for (const scope of Object.keys(activeProfileByScope)) {
    if (merged.profiles[activeProfileByScope[scope]!] === undefined) delete activeProfileByScope[scope];
  }

  if (Object.keys(deleted).length > 0) merged.deleted = deleted;
  if (Object.keys(activeProfileByScope).length > 0) merged.activeProfileByScope = activeProfileByScope;
  return merged;
}
