/** Optional Scrum materialization. Never imports or rewrites the SLP profile/lane schema. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicJson,
  executionIsValid,
  readOptionalJson,
  readScrumConfig,
  scopeDir,
  scrumConfigIsValid,
} from "./config.ts";
import {
  mergeScrumProfiles,
  parseScrumProfiles,
  readScrumProfiles,
} from "./profiles.ts";
import { FactoryError } from "../errors.ts";
export function collectScrumVault(state: string, runtimeConfig: string): void {
  for (const name of ["execution.json", "scrum-lanes.json"]) {
    const path = join(state, name);
    if (existsSync(path))
      atomicJson(join(runtimeConfig, name), readOptionalJson(path));
  }
  if (existsSync(join(state, "scrum-profiles.json"))) {
    const remote = readOptionalJson(join(runtimeConfig, "scrum-profiles.json"));
    atomicJson(
      join(runtimeConfig, "scrum-profiles.json"),
      mergeScrumProfiles(
        remote === undefined
          ? { schemaVersion: 1, profiles: [], tombstones: [] }
          : parseScrumProfiles(remote),
        readScrumProfiles(state),
      ),
    );
  }
}
export function materializeScrumVault(
  state: string,
  runtimeConfig: string,
  overwrite: boolean,
): void {
  for (const name of ["execution.json", "scrum-lanes.json"]) {
    const remote = readOptionalJson(join(runtimeConfig, name));
    if (remote === undefined || (!overwrite && existsSync(join(state, name))))
      continue;
    if (
      !(name === "execution.json"
        ? executionIsValid(remote)
        : scrumConfigIsValid(remote))
    )
      throw new FactoryError("scrum-vault-invalid", name);
    atomicJson(join(state, name), remote);
  }
  const remote = readOptionalJson(join(runtimeConfig, "scrum-profiles.json"));
  if (remote !== undefined)
    atomicJson(
      join(state, "scrum-profiles.json"),
      mergeScrumProfiles(readScrumProfiles(state), parseScrumProfiles(remote)),
    );
}
export function collectProjectScrumVault(
  state: string,
  slug: string,
  runtimeApp: string,
): void {
  const config = readScrumConfig(state, slug);
  if (config) atomicJson(join(runtimeApp, "scrum-lanes.json"), config);
}
export function materializeProjectScrumVault(
  state: string,
  slug: string,
  runtimeApp: string,
  overwrite: boolean,
): void {
  const config = readOptionalJson(join(runtimeApp, "scrum-lanes.json"));
  if (
    config === undefined ||
    (!overwrite && existsSync(join(scopeDir(state, slug), "scrum-lanes.json")))
  )
    return;
  if (!scrumConfigIsValid(config))
    throw new FactoryError("scrum-vault-invalid", slug);
  atomicJson(join(scopeDir(state, slug), "scrum-lanes.json"), config);
  // Project execution selection is local; imported machine defaults never select it.
}
