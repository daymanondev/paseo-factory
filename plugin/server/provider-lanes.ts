/** The lane and provider configuration shared by create and permission hooks. */
import { loadLanes, migrateLegacyZcodeLane, parseLane } from "./core/lanes.ts";
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
  if (providers === undefined || providers.length === 0) return undefined;
  const entry = providers.find((p) => (p.provider ?? p.id) === provider);
  const models = entry?.models;
  if (models === undefined || models === null) return undefined;
  const strippedModel = model.replace(/^[^/]+\//, "");
  return models.find(
    (m) =>
      m.id === model ||
      `${provider}/${m.id}` === model ||
      m.id === `${provider}/${model}` ||
      m.id === strippedModel ||
      m.id.replace(/^[^/]+\//, "") === strippedModel,
  );
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
  const lane = parseLane(migrateLegacyZcodeLane(raw));
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
