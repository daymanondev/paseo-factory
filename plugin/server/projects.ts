/**
 * The project registry (v0.0.14, ADR 0010 §1/§5): every project the factory
 * has seated records its identity in `<stateDir>/projects/<slug>/project.json`
 * — the durable `<project-slug>` → `<project-root>` binding the surface's
 * Project Selector lists and the session-open env injection matches seat
 * agent ids against. The registry is a cache of identities the ledger and
 * the daemon already hold; a missing or corrupt file degrades to discovery
 * from live seat agents, never to a wrong guess.
 *
 * v0.0.18: the registry lives in the pure-Node core (`src/project.ts`,
 * vendored here as `./core/project.ts`) so paseo-factory and its Companion
 * plugins share one source of truth (ADR 0012, spec §Implementation
 * Decisions 1). This module is the backward-compatible re-export layer.
 */
export {
  resolveProject,
  resolveOrBootstrapProject,
  ensureGitRepository,
  readProjectRegistration,
  writeProjectRegistration,
  listProjectRegistrations,
  discoverProjects,
} from "./core/project.ts";
export type {
  ProjectResolution,
  BootstrapProjectOptions,
  BootstrapProjectResolution,
  DiscoveredProject,
  ProjectRegistration,
} from "./core/project.ts";

import { resolveProject as resolveCoreProject, ensureProjectRegistered as ensureCoreProjectRegistered, readProjectRegistration as existingRegistration } from "./core/project.ts";
import { readExecution } from "./core/scrum/selection.ts";
import { ensureScrumConfig } from "./core/scrum/config.ts";
export function ensureProjectRegistered(...args: Parameters<typeof ensureCoreProjectRegistered>): ReturnType<typeof ensureCoreProjectRegistered> {
  const [state, input] = args;
  const resolved = typeof input === "string" ? resolveCoreProject(input) : { ok: true as const, slug: input.slug };
  const isNew = resolved.ok && existingRegistration(state, resolved.slug) === undefined;
  const result = ensureCoreProjectRegistered(...args);
  if (isNew && result.ok && readExecution(state, result.slug).mode === "scrum") {
    // This is an explicit registration/seat creation act, never snapshot/read migration.
    ensureScrumConfig(state, result.slug);
  }
  return result;
}
