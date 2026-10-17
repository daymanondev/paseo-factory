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
  readProjectRegistration,
  writeProjectRegistration,
  listProjectRegistrations,
  discoverProjects,
} from "./core/project.ts";
export type { ProjectRegistration } from "./core/project.ts";
