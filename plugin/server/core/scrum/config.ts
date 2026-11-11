import {
  executionIsValid,
  readExecution,
  registerExecutionSelection,
} from "./selection.ts";
export { executionIsValid, readExecution } from "./selection.ts";
import type { FactoryExecutionMode, ExecutionSelection } from "./selection.ts";
export type { FactoryExecutionMode, ExecutionSelection } from "./selection.ts";
/** Scrum configuration is opt-in and never a layer in the SLP lane resolver. */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadLanes, migrateLegacyZcodeLane, parseLane } from "../lanes.ts";
import { FactoryError } from "../errors.ts";
import { atomicJson, readOptionalJson as readStateJson, stateMutation } from "../json-store.ts";
import { projectStateDir } from "../project.ts";

export { atomicJson };
export const scrumMutation = stateMutation;
export const SCRUM_ROLES = ["pm", "ux", "architect", "dev", "qa"] as const;
export type ScrumRoleName = (typeof SCRUM_ROLES)[number];
export type AgentSpecialization = "peer" | ScrumRoleName;
export const SCRUM_LANES = [
  "supervisor",
  "lead",
  ...SCRUM_ROLES,
  "watch",
  "retro",
] as const;
export type ScrumLaneName = (typeof SCRUM_LANES)[number];
export interface ScrumConfig {
  configRevision?: number;
  schemaVersion: 1;
  requireUiApproval: boolean;
  lanes: Record<ScrumLaneName, string>;
}
export const scopeDir = (state: string, slug?: string): string =>
  slug === undefined ? state : projectStateDir(state, slug);
export const readOptionalJson = (path: string): unknown =>
  readStateJson(path, "scrum-config-invalid");
export function saveExecutionDefault(
  state: string,
  mode: FactoryExecutionMode,
): ExecutionSelection {
  return scrumMutation(state, () => {
    if (!["slp", "scrum"].includes(mode))
      throw new FactoryError("invalid-execution-mode", String(mode));
    if (mode === "scrum") ensureScrumConfig(state);
    const next = {
      schemaVersion: 1 as const,
      mode,
      revision: readExecution(state).revision + 1,
    };
    atomicJson(join(state, "execution.json"), next);
    return next;
  });
}
/** Called only at first registration, never while reading an existing Project. */
export function registerExecution(
  state: string,
  slug: string,
): ExecutionSelection {
  return scrumMutation(state, () => registerExecutionSelection(state, slug));
}
export function scrumConfigIsValid(value: unknown): value is ScrumConfig {
  const v = value as ScrumConfig | null;
  return (
    v !== null &&
    typeof v === "object" &&
    v.schemaVersion === 1 &&
    typeof v.requireUiApproval === "boolean" &&
    v.lanes !== null &&
    typeof v.lanes === "object" &&
    SCRUM_LANES.every(
      (name) =>
        typeof v.lanes[name] === "string" &&
        parseLane(v.lanes[name]) !== undefined,
    )
  );
}
export function readScrumConfig(
  state: string,
  slug?: string,
): ScrumConfig | undefined {
  const path = join(scopeDir(state, slug), "scrum-lanes.json");
  const value = readOptionalJson(path);
  if (value === undefined) return undefined;
  if (!scrumConfigIsValid(value))
    throw new FactoryError(
      "scrum-config-invalid",
      `scrum-config-invalid: ${path}`,
    );
  const migratedLanes = {} as Record<ScrumLaneName, string>;
  for (const name of SCRUM_LANES) {
    migratedLanes[name] = migrateLegacyZcodeLane(value.lanes[name].trim());
  }
  return { ...value, lanes: migratedLanes };
}
export function saveScrumConfig(
  state: string,
  config: ScrumConfig,
  slug?: string,
): ScrumConfig {
  return scrumMutation(state, () => {
    if (!scrumConfigIsValid(config))
      throw new FactoryError(
        "scrum-config-invalid",
        "complete Scrum roster required",
      );
    const previous = readScrumConfig(state, slug);
    const migratedLanes = {} as Record<ScrumLaneName, string>;
    for (const name of SCRUM_LANES) {
      migratedLanes[name] = migrateLegacyZcodeLane(config.lanes[name].trim());
    }
    const next = {
      ...config,
      lanes: migratedLanes,
      configRevision: (previous?.configRevision ?? 0) + 1,
    };
    atomicJson(join(scopeDir(state, slug), "scrum-lanes.json"), next);
    return structuredClone(next);
  });
}
export function ensureScrumConfig(
  state: string,
  slug?: string,
  reset = false,
): ScrumConfig {
  return scrumMutation(state, () => {
    const current = readScrumConfig(state, slug);
    if (current !== undefined && !reset) return current;
    const next = (() => {
      const machine = slug === undefined ? undefined : readScrumConfig(state);
      if (machine !== undefined) return saveScrumConfig(state, machine, slug);
      // Reset seeds missing machine defaults from MACHINE SLP, never Project SLP.
      if (reset && slug !== undefined)
        return saveScrumConfig(state, ensureScrumConfig(state), slug);
      const slp = loadLanes(state, slug);
      if (!slp.ok) throw new FactoryError("lanes-unreadable", slp.reason);
      const { supervisor, lead, worker, watch, retro } = slp.lanes;
      return saveScrumConfig(
        state,
        {
          schemaVersion: 1,
          requireUiApproval: true,
          lanes: {
            supervisor,
            lead,
            pm: lead,
            ux: worker,
            architect: lead,
            dev: worker,
            qa: worker,
            watch,
            retro,
          },
        },
        slug,
      );
    })();
    if (reset)
      rmSync(join(scopeDir(state, slug), "scrum-active-profile.json"), {
        force: true,
      });
    return next;
  });
}

