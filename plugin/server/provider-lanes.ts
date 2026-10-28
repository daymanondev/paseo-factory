/** The mode-aware lane and provider configuration shared by create and permission hooks. */
import { loadLanes, parseLane } from "./core/lanes.ts";
import {
  resolveScrumIdentity,
  scrumIdentityLane,
} from "./core/scrum/harness.ts";
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
  task?: string,
): string | undefined {
  const identity = slug ? resolveScrumIdentity(state, slug, task) : undefined;
  if (identity) {
    if (role === "agent" && identity.kind === "seat")
      return identity.config.lanes.dev;
    return scrumIdentityLane(state, slug, role, identity);
  }
  const loaded = loadLanes(state, slug || undefined);
  return loaded.ok
    ? loaded.lanes[role === "agent" ? "worker" : role]
    : undefined;
}

export function laneProviderConfig(
  raw: string,
  providers?: readonly ProviderCatalogEntry[],
): { provider: string; model: string; thinkingOptionId?: string } {
  const lane = parseLane(raw);
  if (!lane) throw new Error(`Invalid lane: ${raw}`);
  const provider =
    lane.provider === "claude-code"
      ? "claude"
      : lane.provider === "agy" &&
          !providers?.some((p) => (p.provider ?? p.id) === "agy")
        ? "antigravity"
        : lane.provider;
  const options = (
    findCatalogModelMeta(provider, lane.model, providers) ??
    findCatalogModelMeta(lane.provider, lane.model, providers)
  )?.thinkingOptions;
  const supportsThinking =
    lane.thinking !== undefined &&
    (options == null || options.some((o) => o.id === lane.thinking));
  return {
    provider,
    model: lane.model,
    ...(supportsThinking ? { thinkingOptionId: lane.thinking } : {}),
  };
}
