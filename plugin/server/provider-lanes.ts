/** The lane and provider configuration shared by create and permission hooks. */
import {
  findCatalogModel,
  findCatalogProviderEntry,
  loadLanes,
  migrateLegacyZcodeLane,
  normalizeLaneWithProviders,
  parseLane,
} from "./core/lanes.ts";
import type { RoleName } from "./core/roles-contract.ts";
export interface ProviderCatalogModel {
  id: string;
  thinkingOptions?: readonly { id: string; label?: string | null }[] | null;
}

export interface ProviderCatalogEntry {
  id?: string;
  provider?: string;
  models?: readonly ProviderCatalogModel[] | null;
}

export function findCatalogModelMeta(
  provider: string,
  model: string,
  providers?: readonly ProviderCatalogEntry[],
): ProviderCatalogModel | undefined {
  const found = findCatalogProviderEntry(provider, providers);
  return found === undefined ? undefined : findCatalogModel(found.catalogProvider, model, found.entry.models);
}

export function resolveRoleLane(
  state: string,
  slug: string,
  role: RoleName,
): string | undefined {
  const loaded = loadLanes(state, slug || undefined);
  return loaded.ok
    ? loaded.lanes[role === "agent" ? "worker" : role]
    : undefined;
}

export function laneProviderConfig(
  raw: string,
  providers?: readonly ProviderCatalogEntry[],
): { provider: string; model: string; thinkingOptionId?: string } {
  const lane = parseLane(normalizeLaneWithProviders(migrateLegacyZcodeLane(raw), providers));
  if (!lane) throw new Error(`Invalid lane: ${raw}`);
  const provider =
    lane.provider === "claude-code"
      ? "claude"
      : lane.provider === "agy" &&
          !providers?.some((p) => (p.provider ?? p.id) === "agy")
        ? "antigravity"
        : lane.provider;
  const model = lane.model;
  const options = (
    findCatalogModelMeta(provider, model, providers) ??
    findCatalogModelMeta(lane.provider, lane.model, providers)
  )?.thinkingOptions;
  const supportsThinking =
    lane.thinking !== undefined &&
    (options == null || options.some((o) => o.id === lane.thinking));
  return {
    provider,
    model,
    ...(supportsThinking ? { thinkingOptionId: lane.thinking } : {}),
  };
}
