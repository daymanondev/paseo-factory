import { join } from "node:path";
import { FactoryError } from "../errors.ts";
import {
  atomicJson,
  readOptionalJson,
  saveScrumConfig,
  scopeDir,
  scrumConfigIsValid,
  scrumMutation,
} from "./config.ts";
import type { ScrumConfig } from "./config.ts";
export interface ScrumProfile {
  id: string;
  name: string;
  config: ScrumConfig;
  updatedAt: string;
}
export interface ScrumProfiles {
  schemaVersion: 1;
  profiles: ScrumProfile[];
  tombstones: { id: string; deletedAt: string }[];
}
const profileId = (id: string): string => {
  if (id.startsWith("slp:"))
    throw new FactoryError("execution-mode-mismatch", id);
  const bare = id.replace(/^scrum:/, "");
  if (!/^[a-zA-Z0-9._-]+$/.test(bare))
    throw new FactoryError("invalid-profile-id", id);
  return `scrum:${bare}`;
};
export function readScrumProfiles(state: string): ScrumProfiles {
  const value = readOptionalJson(join(state, "scrum-profiles.json"));
  if (value === undefined)
    return { schemaVersion: 1, profiles: [], tombstones: [] };
  return parseScrumProfiles(value);
}
export function parseScrumProfiles(value: unknown): ScrumProfiles {
  const v = value as ScrumProfiles;
  if (
    !v ||
    v.schemaVersion !== 1 ||
    !Array.isArray(v.profiles) ||
    !Array.isArray(v.tombstones) ||
    v.profiles.some(
      (p) =>
        typeof p?.id !== "string" ||
        profileId(p.id) !== p.id ||
        !p.name?.trim() ||
        !Number.isFinite(Date.parse(p.updatedAt)) ||
        !scrumConfigIsValid(p.config),
    ) ||
    v.tombstones.some(
      (p) =>
        typeof p?.id !== "string" ||
        profileId(p.id) !== p.id ||
        !Number.isFinite(Date.parse(p.deletedAt)),
    )
  )
    throw new FactoryError(
      "scrum-profiles-invalid",
      "invalid Scrum profile store",
    );
  return v;
}
export function mergeScrumProfiles(
  a: ScrumProfiles,
  b: ScrumProfiles,
): ScrumProfiles {
  const tombstones = new Map<string, { id: string; deletedAt: string }>();
  for (const t of [...a.tombstones, ...b.tombstones])
    if ((tombstones.get(t.id)?.deletedAt ?? "") < t.deletedAt)
      tombstones.set(t.id, t);
  const profiles = new Map<string, ScrumProfile>();
  for (const p of [...a.profiles, ...b.profiles]) {
    if ((tombstones.get(p.id)?.deletedAt ?? "") >= p.updatedAt) continue;
    const old = profiles.get(p.id);
    if (
      old === undefined ||
      old.updatedAt < p.updatedAt ||
      (old.updatedAt === p.updatedAt && JSON.stringify(old) < JSON.stringify(p))
    )
      profiles.set(p.id, p);
  }
  return {
    schemaVersion: 1,
    profiles: [...profiles.values()].sort((a, b) => a.id.localeCompare(b.id)),
    tombstones: [...tombstones.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  };
}
export function saveScrumProfile(
  state: string,
  input: Omit<ScrumProfile, "updatedAt">,
): ScrumProfile {
  return scrumMutation(state, () => {
    if (!input.name?.trim() || !scrumConfigIsValid(input.config))
      throw new FactoryError(
        "invalid-profile",
        "complete Scrum config and name required",
      );
    const store = readScrumProfiles(state);
    const id = profileId(input.id);
    const latest = Math.max(
      0,
      ...store.profiles.map((p) => Date.parse(p.updatedAt)),
      ...store.tombstones.map((p) => Date.parse(p.deletedAt)),
    );
    const profile = {
      ...input,
      id,
      updatedAt: new Date(Math.max(Date.now(), latest + 1)).toISOString(),
    };
    atomicJson(
      join(state, "scrum-profiles.json"),
      mergeScrumProfiles(store, {
        schemaVersion: 1,
        profiles: [profile],
        tombstones: [],
      }),
    );
    return profile;
  });
}
export function deleteScrumProfile(state: string, id: string): void {
  scrumMutation(state, () => {
    const store = readScrumProfiles(state);
    const latest = Math.max(
      Date.now(),
      ...store.profiles.map((p) => Date.parse(p.updatedAt) + 1),
    );
    atomicJson(
      join(state, "scrum-profiles.json"),
      mergeScrumProfiles(store, {
        schemaVersion: 1,
        profiles: [],
        tombstones: [
          { id: profileId(id), deletedAt: new Date(latest).toISOString() },
        ],
      }),
    );
  });
}
export function applyScrumProfile(
  state: string,
  id: string,
  slug?: string,
): ScrumConfig {
  return scrumMutation(state, () => {
    const profile = readScrumProfiles(state).profiles.find(
      (p) => p.id === profileId(id),
    );
    if (profile === undefined) throw new FactoryError("profile-not-found", id);
    const config = saveScrumConfig(state, profile.config, slug);
    atomicJson(join(scopeDir(state, slug), "scrum-active-profile.json"), {
      id: profile.id,
      updatedAt: profile.updatedAt,
    });
    return config;
  });
}
