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
 *
 * v0.0.89 (ADR 0045 §1): this module also owns the Per-Project Factory
 * Registry (`createFactoryRegistry` / `factoryRegistryFor`) and the
 * context-first target-Project resolver (`resolveTargetProject`) every
 * Spool request, surface RPC call, CLI invocation, and permit ask routes
 * through — one Factory instance, one serialized writer lane, and one
 * isolated state directory per registered Project.
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

import { resolveProject as resolveCoreProject, ensureProjectRegistered as ensureCoreProjectRegistered, readProjectRegistration as existingRegistration, listProjectRegistrations } from "./core/project.ts";
import { createFactory } from "./core/factory.ts";
import type { Factory } from "./core/factory.ts";
import type { TimelineFetcher } from "./core/watch.ts";
import { FactoryError } from "./core/errors.ts";
import { readCorrelations } from "./core/correlations.ts";
import { parseTaskWorktreePath } from "./core/workspace.ts";
import { resolve as resolvePath } from "node:path";
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

// ---- the Per-Project Factory Registry (v0.0.89, ADR 0045 §1) --------------------------------
//
// The plugin server no longer runs one unscoped root Factory for every
// Project: each registered Project owns its own Factory instance — its own
// serialized writer lane (the per-ledger LedgerAdmission), its own
// ledger.jsonl, report-*/gate-*/retro-* files under
// `<stateDir>/projects/<slug>/`. Independent Projects never block one
// another's Ledger writes or Gate runs; the single-writer invariant holds
// WITHIN each Project. The root Factory remains as the lightweight fallback
// strictly for unbound machine-level operations (upgrade, machine lanes).

export interface FactoryRegistryOptions {
  stateDir: string;
  /** The timeline feed every per-Project Factory's watch pass shares (the shell's one captured PaseoApi). */
  fetchTimeline?: TimelineFetcher;
  onLog?: (message: string) => void;
  /**
   * An already-constructed root Factory (tests construct their own) — the
   * registry adopts it as its root instead of opening a second one on the
   * same root ledger.
   */
  root?: Factory;
  /**
   * The retro lane seams forwarded to every per-Project Factory (T-11b) — the
   * same `createFactory` test seams the root Factory already carries. The
   * live server pins neither (the real lane CLI answers the pass); tests fake
   * the lane so `factory.retro` never spawns a real model.
   */
  retroCopilotProbe?: (lane: string) => boolean;
  /** The retro pass's lane runner seam — forwarded per Project the same way (T-11b). */
  retroCopilotRunner?: import("./core/watch.ts").CopilotRunner;
}

/** The lazy per-Project Factory registry — `factoryForProject(slug)` is the one door. */
export interface FactoryRegistry {
  readonly stateDir: string;
  /** The lightweight root fallback Factory — unbound, machine-level operations only. */
  readonly root: Factory;
  /** The (cached) Factory instance owning `<stateDir>/projects/<slug>/` — created lazily on first use. */
  factoryForProject(slug: string): Factory;
  /**
   * The already-open Factory for `slug`, when one exists — a pure peek that
   * never opens, validates, or recovers anything (a read must not mint state
   * or perturb a ledger mid-maintenance; the polling paths use this).
   */
  cachedFactoryFor(slug: string): Factory | undefined;
  /** Every registered Project's slug, registry (slug) order — the live disk registry, never a boot snapshot. */
  slugs(): string[];
  /** Every registered Project's Factory, materializing each lazily (and starting its writer) exactly once. */
  factories(): { slug: string; factory: Factory }[];
  /** Which registered Projects hold a Contract for `task` — the unique-Task-lookup half of the routing order. */
  projectsOwningTask(task: string): string[];
  /**
   * Drops the cached Factory for `slug` (stopping its writer lane) so the
   * next `factoryForProject(slug)` opens fresh state — the reset/delete
   * eviction act. Returns the evicted Factory, or undefined when none was cached.
   */
  evict(slug: string): Factory | undefined;
  /** Stops every Factory this registry created (the plugin's shutdown act). */
  stop(): void;
}

const registryByStateDir = new Map<string, FactoryRegistry>();

export function createFactoryRegistry(options: FactoryRegistryOptions): FactoryRegistry {
  const { stateDir } = options;
  const log = options.onLog ?? (() => {});
  const bySlug = new Map<string, Factory>();
  const root = options.root ?? createFactory({
    stateDir,
    ...(options.fetchTimeline === undefined ? {} : { fetchTimeline: options.fetchTimeline }),
  });
  const registry: FactoryRegistry = {
    stateDir,
    root,
    factoryForProject(slug: string): Factory {
      const key = slug.trim();
      if (key === "") throw new FactoryError("unknown-project", "a Project slug is required");
      const cached = bySlug.get(key);
      if (cached !== undefined) return cached;
      // Opening validates the Project's ledger (fail closed) and closes
      // attempts a previous lifetime left interrupted (ADR 0003) — the same
      // boot law the single root Factory always followed, now per Project.
      const factory = createFactory({
        stateDir,
        projectSlug: key,
        ...(options.fetchTimeline === undefined ? {} : { fetchTimeline: options.fetchTimeline }),
        ...(options.retroCopilotProbe === undefined ? {} : { retroCopilotProbe: options.retroCopilotProbe }),
        ...(options.retroCopilotRunner === undefined ? {} : { retroCopilotRunner: options.retroCopilotRunner }),
      });
      factory.history.start();
      for (const { task, attempt } of factory.recoveredAttempts) {
        log(`project ${key}: recovered on open: attempt ${attempt} of task ${task} closed red — interrupted by a restart`);
      }
      bySlug.set(key, factory);
      return factory;
    },
    cachedFactoryFor(slug: string): Factory | undefined {
      return bySlug.get(slug.trim());
    },
    slugs(): string[] {
      return listProjectRegistrations(stateDir).map((registration) => registration.slug);
    },
    factories(): { slug: string; factory: Factory }[] {
      return registry.slugs().map((slug) => ({ slug, factory: registry.factoryForProject(slug) }));
    },
    projectsOwningTask(task: string): string[] {
      const owners: string[] = [];
      for (const { slug, factory } of registry.factories()) {
        if (factory.contractFor(task) !== undefined) owners.push(slug);
      }
      return owners;
    },
    evict(slug: string): Factory | undefined {
      const key = slug.trim();
      const factory = bySlug.get(key);
      if (factory === undefined) return undefined;
      bySlug.delete(key);
      try {
        factory.history.stop();
      } catch {
        // an already-stopped writer lane evicts silently
      }
      return factory;
    },
    stop(): void {
      if (registryByStateDir.get(resolvePath(stateDir)) === registry) registryByStateDir.delete(resolvePath(stateDir));
      for (const factory of bySlug.values()) {
        try {
          factory.history.stop();
        } catch {
          // best-effort stop
        }
      }
      bySlug.clear();
      try {
        root.history.stop();
      } catch {
        // best-effort stop
      }
    },
  };
  return registry;
}

/**
 * The process-wide registry for one `stateDir` — every consumer of the
 * Per-Project registry (the plugin shell's wiring, the spool router, the
 * choke's permit routing) resolves the SAME instance, so per-Project
 * Factories are created, cached, and evicted exactly once per Project per
 * process. The first caller wires the timeline feed; later callers with no
 * options reuse it untouched.
 */
export function factoryRegistryFor(stateDir: string, options?: Omit<FactoryRegistryOptions, "stateDir">): FactoryRegistry {
  const key = resolvePath(stateDir);
  const existing = registryByStateDir.get(key);
  if (existing !== undefined) return existing;
  const registry = createFactoryRegistry({ stateDir: key, ...(options ?? {}) });
  registryByStateDir.set(key, registry);
  return registry;
}

// ---- context-first target-Project resolution (v0.0.89, ADR 0045 §1.2) -----------------------

/** The context one incoming request, CLI invocation, permit ask, or shim block carries. */
export interface TargetProjectContext {
  /** Explicit Project slug — a request's `project`/`projectSlug` field or the `--project <slug>` CLI flag. */
  project?: string;
  /** The same explicit slug under its other field name. */
  projectSlug?: string;
  /** A workspace or Project-root path — canonical git-root resolution (Task worktree paths included). */
  workspace?: string;
  /** A cwd path — the same resolution as `workspace`. */
  cwd?: string;
  /** The submitting shell's stamp — a Correlation token or agent id, resolved through the registry binding. */
  submitter?: string;
  /** An explicit Correlation token — the authenticated binding arm. */
  correlationId?: string;
  /** An agent id — resolved through the Correlation registry's agentId binding. */
  agentId?: string;
  /** A bare Task id — the unique-Task-lookup arm. */
  task?: string;
}

export type TargetProjectResolution =
  | { ok: true; slug: string; via: "explicit" | "correlation" | "workspace" | "task" | "single" }
  | { ok: false; code: "unknown-project" | "ambiguous-task-project" | "project-required"; message: string };

/**
 * Resolves ONE target Project in the strict priority order (spec v0.0.89
 * Implementation Decision 1):
 *
 *  1. explicit `project`/`projectSlug` (a slug, or a path resolved to its canonical slug),
 *  2. authenticated Correlation token binding (`record.projectSlug`),
 *  3. canonical git-root slug resolution from the workspace/cwd — including
 *     Task worktree paths under `<stateDir>/projects/<slug>/worktrees/<task>`,
 *  4. unique Task id lookup across the registered Factories — refusing with
 *     `ambiguous-task-project` when the Task id exists in more than one Project,
 *  5. single-registered-Project fallback, only when exactly one Project is registered.
 *
 * A resolution that names a Project that is not registered refuses with
 * `unknown-project`; a context-less request on a zero- or multi-Project
 * machine refuses with `project-required`. Never a guess.
 */
export function resolveTargetProject(
  registry: FactoryRegistry | string,
  context: TargetProjectContext = {},
): TargetProjectResolution {
  const resolvedRegistry = typeof registry === "string" ? factoryRegistryFor(registry) : registry;
  const stateDir = resolvedRegistry.stateDir;

  // 1. explicit slug (or path) — the --project flag / request field, top priority.
  const explicit = (context.project ?? context.projectSlug ?? "").trim();
  if (explicit !== "") {
    const slug = explicit.includes("/") ? (slugFromWorkspace(stateDir, explicit) ?? explicit) : explicit;
    if (existingRegistration(stateDir, slug) !== undefined) return { ok: true, slug, via: "explicit" };
    return {
      ok: false,
      code: "unknown-project",
      message: `project "${explicit}" is not registered — pass a registered --project <slug>, or a workspace inside the target Project`,
    };
  }

  // 2. authenticated Correlation token binding (correlationId or agentId).
  const token = [context.correlationId, context.agentId, context.submitter].map((value) => (value ?? "").trim()).find((value) => value !== "");
  if (token !== undefined) {
    const correlations = readCorrelations(stateDir);
    for (let i = correlations.length - 1; i >= 0; i -= 1) {
      const record = correlations[i];
      if (record !== undefined && (record.correlationId === token || record.agentId === token)) {
        return { ok: true, slug: record.projectSlug, via: "correlation" };
      }
    }
  }

  // 3. workspace / cwd — canonical git-root slug, or the managed Task worktree path.
  const workspace = (context.workspace ?? context.cwd ?? "").trim();
  if (workspace !== "") {
    const slug = slugFromWorkspace(stateDir, workspace);
    if (slug !== undefined) return { ok: true, slug, via: "workspace" };
  }

  // 4. unique Task lookup across the registered per-Project Factories.
  const task = (context.task ?? "").trim();
  if (task !== "") {
    const owners = resolvedRegistry.projectsOwningTask(task);
    if (owners.length === 1) return { ok: true, slug: owners[0]!, via: "task" };
    if (owners.length > 1) {
      return {
        ok: false,
        code: "ambiguous-task-project",
        message: `task ${task} exists in ${owners.length} Projects (${owners.join(", ")}) — pass --project <slug> or a workspace inside the target Project`,
      };
    }
  }

  // 5. the single-registered-Project fallback.
  const registrations = listProjectRegistrations(stateDir);
  if (registrations.length === 1) return { ok: true, slug: registrations[0]!.slug, via: "single" };
  return {
    ok: false,
    code: "project-required",
    message:
      registrations.length === 0
        ? "no Project is registered — contract a Task in a git repository first, or pass --project <slug>"
        : `${registrations.length} Projects are registered (${registrations.map((registration) => registration.slug).join(", ")}) — pass --project <slug> or a workspace inside the target Project`,
  };
}

/**
 * The canonical slug for a workspace/cwd path, when it binds to a REGISTERED
 * Project: a managed Task worktree under `<stateDir>/projects/<slug>/worktrees/<task>`
 * names its Project directly (the worktree directory may even be gone), any
 * other path resolves through `resolveProject` (a linked git worktree follows
 * the common dir back to the main repository). An unregistered or unresolvable
 * path binds nothing — undefined, never a guess.
 */
function slugFromWorkspace(stateDir: string, workspace: string): string | undefined {
  const worktree = parseTaskWorktreePath(stateDir, resolvePath(workspace));
  if (worktree !== null && existingRegistration(stateDir, worktree.slug) !== undefined) return worktree.slug;
  const resolved = resolveCoreProject(workspace);
  if (resolved.ok && existingRegistration(stateDir, resolved.slug) !== undefined) return resolved.slug;
  return undefined;
}
