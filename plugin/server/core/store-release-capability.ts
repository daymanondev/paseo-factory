/**
 * Pure per-Project Store Release capability resolver (ADR 0071):
 * combines mobile Project eligibility (`detectMobilePlatforms` or
 * `.store-release/manifest.json`) with Owner-configured `Store release mode`
 * (`readStoreReleaseSettings`, defaulting safely to `"off"`).
 *
 * Placement: lives in `src/` with zero Paseo imports, synced verbatim to
 * `plugin/server/core/store-release-capability.ts` via `npm run sync:plugin-core`,
 * and bundled into self-contained `plugin/bin/bridge.mjs` via
 * `scripts/generate-policies.mjs`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readStoreReleaseSettings } from "./project-settings.ts";
import type { ProjectStoreReleaseMode } from "./project-settings.ts";
import { detectMobilePlatforms } from "./store-release-probe.ts";

export type StoreReleaseSupervisorTier = "hidden" | "off-hint" | "full";

export interface StoreReleaseCapability {
  isMobile: boolean;
  mode: ProjectStoreReleaseMode;
  isActive: boolean;
  leadEnabled: boolean;
  supervisorTier: StoreReleaseSupervisorTier;
}

export interface ResolveStoreReleaseCapabilityInput {
  projectRoot?: string;
  stateDir?: string;
  projectSlug?: string;
}

/**
 * Resolves per-Project Store Release exposure for `Lead` (`leadEnabled`) and
 * `Supervisor` (`supervisorTier`: `"hidden" | "off-hint" | "full"`).
 * Defaults safely to disabled when `projectRoot`, `stateDir`, or `projectSlug`
 * is absent or unreadable.
 */
export function resolveStoreReleaseCapability(
  input: ResolveStoreReleaseCapabilityInput = {},
): StoreReleaseCapability {
  const projectRoot = typeof input.projectRoot === "string" ? input.projectRoot.trim() : "";
  const isMobile =
    projectRoot !== "" &&
    (detectMobilePlatforms(projectRoot).length > 0 ||
      existsSync(join(projectRoot, ".store-release", "manifest.json")));

  const stateDir = typeof input.stateDir === "string" ? input.stateDir.trim() : "";
  const projectSlug = typeof input.projectSlug === "string" ? input.projectSlug.trim() : "";
  let mode: ProjectStoreReleaseMode = "off";
  if (stateDir !== "" && projectSlug !== "") {
    try {
      mode = readStoreReleaseSettings(stateDir, projectSlug).mode;
    } catch {
      mode = "off";
    }
  }

  const isActive = isMobile && mode !== "off";
  const leadEnabled = isActive;
  const supervisorTier: StoreReleaseSupervisorTier = !isMobile
    ? "hidden"
    : isActive
      ? "full"
      : "off-hint";

  return {
    isMobile,
    mode,
    isActive,
    leadEnabled,
    supervisorTier,
  };
}
