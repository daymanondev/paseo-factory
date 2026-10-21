/**
 * The role-contract layer (v0.0.14, ADR 0010 §1–§2/§6; v0.0.26, ADR 0016 §1/§3;
 * v0.0.27, ADR 0017 §2): additive injection of the `Supervisor`, `Lead`, and
 * working-`Agent` role contracts, `Correlation token` issuance/association,
 * `paseo_factory` MCP bridge wiring, Layer-1 provider execution fences across
 * all 7 providers (`opencode`, `claude`, `codex`, `pi`, `copilot`, `omp`,
 * `antigravity`), and deterministic seat recognition by native role provider
 * id (`factory-supervisor`, `factory-lead`, `factory-peer`).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { provisionAgyPlugin, ensureFactoryBinScripts } from "./core/agy-home.ts";
import { CorrelationRegistry } from "./core/correlations.ts";
import { loadLanes, parseLane } from "./core/lanes.ts";
import { resolveProject } from "./core/project.ts";
import { provisionPiAgentHome } from "./core/pi-home.ts";
import {
  FOOTER_MARK,
  ROLE_SKILL_INDEX,
  SEAT_TITLES,
  renderRoleContract,
  renderSeatBootstrapPrompt,
} from "./core/roles-contract.ts";
import type { ProjectIdentity, RoleName, SeatBootstrapInput, SeatName } from "./core/roles-contract.ts";
import { ensureProjectRegistered, listProjectRegistrations, readProjectRegistration, writeProjectRegistration } from "./projects.ts";
import { parseTaskWorktreePath } from "../shared/worktree-shape.mjs";

export { ROLE_SKILL_INDEX, SEAT_TITLES } from "./core/roles-contract.ts";
export type { ProjectIdentity, RoleName, SeatBootstrapInput, SeatName } from "./core/roles-contract.ts";

export const FORBIDDEN_PASEO_TOOLS = [
  "Task",
  "mcp__paseo__create_agent",
  "mcp__paseo__kill_agent",
  "mcp__paseo__archive_agent",
  "mcp__paseo__send_agent_prompt",
  "mcp__paseo__update_agent",
] as const;

export const CLAUDE_SEAT_WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- the role contracts (the system-prompt channel) ----------------------------------------

/** The role law each seat runs under — appended to `config.systemPrompt`, never written to disk. */
export function renderSeatContract(seat: SeatName, project: ProjectIdentity): string {
  return renderRoleContract(seat, { factoryCmd: "factory", project });
}

/** The working Agent's law — appended to its task-worktree agent's system prompt. */
export function renderAgentContract(task: string, slug: string): string {
  return renderRoleContract("agent", { factoryCmd: "factory", project: { root: "", slug }, task });
}

// ---- the bootstrap orientation (the initial-prompt channel) --------------------------------

/** The seat's bootstrap message — resolved paths, day-one commands, the skill footer. */
export function renderSeatBootstrap(input: SeatBootstrapInput): string {
  return renderSeatBootstrapPrompt(input);
}

// ---- the PASEO_FACTORY_* env channel -------------------------------------------------------

/**
 * The env vars one role's shells carry (the session_open channel — re-applied
 * on every launch). Since v0.0.16 (ADR 0011) this is also the provisioning
 * seam for the role's isolated Pi harness home: the call materializes
 * `<stateDir>/pi-agent/<role>` on demand (idempotently — the provisioner's
 * law) and returns it as `PI_CODING_AGENT_DIR`, so every pi-lane seat and
 * working agent runs inside the clean room instead of the operator's global
 * `~/.pi/agent`. `userHome` overrides the operator home the shared-state
 * symlinks point back at (default `<homedir()>`; hermetic tests pass a fake).
 */
export function factoryEnvFor(
  role: RoleName,
  input: { stateDir: string; project: ProjectIdentity; task?: string; correlationId?: string; userHome?: string },
): Record<string, string> {
  ensureFactoryBinScripts(input.stateDir);
  const roleHome = provisionPiAgentHome({
    stateDir: input.stateDir,
    role,
    sourceAgentDir: join(input.userHome ?? homedir(), ".pi", "agent"),
  });
  const env: Record<string, string> = {
    PASEO_FACTORY_SEAT: role,
    PASEO_FACTORY_PROJECT: input.project.slug,
    PASEO_FACTORY_STATE_DIR: input.stateDir,
    PI_CODING_AGENT_DIR: roleHome,
  };
  if (input.project.root !== "") env.PASEO_FACTORY_PROJECT_ROOT = input.project.root;
  if (input.task !== undefined) env.PASEO_FACTORY_TASK = input.task;
  if (input.correlationId !== undefined && input.correlationId !== "") {
    env.PASEO_FACTORY_CORRELATION = input.correlationId;
  }
  return env;
}

// The before("agent.create") request slice — the SDK's shape restated locally
// so the pure function stays testable without a server.
export interface AgentCreateRequest {
  config: {
    provider?: string;
    cwd: string;
    title?: string | null;
    systemPrompt?: string;
    modeId?: string;
    featureValues?: Record<string, unknown>;
    providerOptions?: Record<string, unknown>;
    mcpServers?: Record<string, unknown>;
    toolPolicy?: { preapproved?: { server: string; tool: string }[] };
  };
  env?: Record<string, string>;
}

// ---- deterministic seat identity by provider id (v0.0.27, ADR 0017 §2) ----------------------

/**
 * The canonical native Paseo role provider ids (ADR 0017 §2): one provider per
 * factory role, reconciled into `<paseoHome>/config.json` by the role-provider
 * reconciler (`src/role-providers.ts`). This table is the plugin-side
 * recognition map only — the provider definitions live with the reconciler.
 */
export const FACTORY_SEAT_PROVIDER_IDS: Readonly<Record<RoleName, string>> = {
  supervisor: "factory-supervisor",
  lead: "factory-lead",
  agent: "factory-peer",
};

const FACTORY_ROLE_BY_PROVIDER_ID: Readonly<Partial<Record<string, RoleName>>> = {
  "factory-supervisor": "supervisor",
  "factory-lead": "lead",
  "factory-peer": "agent",
  "factory-agent": "agent",
};

/**
 * The deterministic seat recognition (ADR 0017 §2): `factory-supervisor` →
 * `supervisor`, `factory-lead` → `lead`, `factory-peer` / `factory-agent` →
 * `agent` — straight from the provider id, regardless of title or labels.
 * Accepts the bare provider id or a `provider/model` form; anything else is
 * undefined, never a guess.
 */
export function inferRoleFromProviderId(provider: unknown): RoleName | undefined {
  if (typeof provider !== "string") return undefined;
  return FACTORY_ROLE_BY_PROVIDER_ID[provider.trim().split("/")[0] ?? ""];
}

/** The three factory role names as they appear in `PASEO_FACTORY_SEAT`. */
function parseRoleName(value: unknown): RoleName | undefined {
  return value === "supervisor" || value === "lead" || value === "agent" ? value : undefined;
}

function inferRoleSeatFromTitleOrLabels(
  title: string | null | undefined,
  labels?: Record<string, string>,
): SeatName | undefined {
  if (labels?.seat === "supervisor" || labels?.seat === "lead") {
    return labels.seat;
  }
  const trimmed = (title ?? "").trim();
  if (
    trimmed === SEAT_TITLES.supervisor ||
    trimmed === "Supervisor" ||
    trimmed.startsWith("Supervisor — ") ||
    trimmed.startsWith("Supervisor - ") ||
    trimmed.startsWith("Supervisor (")
  ) {
    return "supervisor";
  }
  if (
    trimmed === SEAT_TITLES.lead ||
    trimmed === "Lead" ||
    trimmed.startsWith("Lead — ") ||
    trimmed.startsWith("Lead - ") ||
    trimmed.startsWith("Lead (")
  ) {
    return "lead";
  }
  // The normal-chat `/factory <directive>` entrypoint (ADR 0015 §5) — the
  // Owner's dispatcher session fences as a Supervisor seat (ADR 0017 §2).
  if (trimmed.startsWith("/factory")) {
    return "supervisor";
  }
  return undefined;
}

/**
 * The provider family a fence keys on: the id before the first `/`, with the
 * two Paseo aliases normalized (`claude-code` → `claude`, `agy` → `antigravity`).
 */
function providerFamilyOf(rawProvider: string): string {
  const rawFamily = rawProvider.split("/")[0]?.trim().toLowerCase() ?? "";
  return rawFamily === "claude-code" ? "claude" : rawFamily === "agy" ? "antigravity" : rawFamily;
}

/** The Lane config key naming the harness behind one factory role. */
function laneNameForRole(role: RoleName): "supervisor" | "lead" | "worker" {
  return role === "supervisor" ? "supervisor" : role === "lead" ? "lead" : "worker";
}

/**
 * Resolves the harness family a `factory-*` role provider actually runs on
 * (v0.0.27, ADR 0017 §2): the role's Lane config names the underlying harness,
 * so `factory-supervisor` under an `opencode/...` supervisor lane fences
 * exactly like a raw `opencode` session. Non-factory providers resolve to
 * their own family; an unreadable Lane config degrades to the raw provider's
 * family — never a guess.
 */
export function resolveEffectiveProviderFamily(
  provider: string | undefined,
  role: RoleName,
  stateDir: string,
  projectSlug: string,
): string {
  const rawProvider = typeof provider === "string" ? provider.trim() : "";
  if (inferRoleFromProviderId(rawProvider) === undefined) return providerFamilyOf(rawProvider);
  const loaded = loadLanes(stateDir, projectSlug);
  const lane = loaded.ok ? loaded.lanes[laneNameForRole(role)] : undefined;
  const parsed = lane !== undefined ? parseLane(lane) : undefined;
  return parsed === undefined ? providerFamilyOf(rawProvider) : providerFamilyOf(parsed.provider);
}

/**
 * Applies the Layer-1 provider execution fence and `paseo_factory` MCP server
 * config on `agent.create` across all 7 provider families (`opencode`,
 * `claude`, `codex`, `pi`, `copilot`, `omp`, `antigravity`).
 */
export function applyProviderExecutionFence<T extends AgentCreateRequest["config"]>(
  config: T,
  input: {
    role: RoleName;
    stateDir: string;
    correlationId: string;
    projectSlug: string;
    task?: string;
    userHome?: string;
    agyPluginsDir?: string;
    /**
     * The harness family the fence keys on (v0.0.27, ADR 0017 §2) — pass
     * `resolveEffectiveProviderFamily(...)` so a `factory-*` role provider
     * fences like its underlying harness. Defaults to the config's own family.
     */
    providerFamily?: string;
  },
): T {
  const { role, stateDir, correlationId, projectSlug, task, userHome, agyPluginsDir } = input;
  const rawProvider = typeof config.provider === "string" ? config.provider.trim() : "";
  const providerFamily = input.providerFamily ?? providerFamilyOf(rawProvider);

  const { bridgeBinPath } = ensureFactoryBinScripts(stateDir);
  const nextConfig: Record<string, unknown> = { ...config };
  // Never pass `labels` inside `config` to Paseo's strict `agent.create` validator
  delete nextConfig.labels;

  if (providerFamily === "antigravity") {
    delete nextConfig.mcpServers;
    provisionAgyPlugin({ stateDir, userHome, agyPluginsDir });
  } else {
    const existingMcp = isRecord(config.mcpServers) ? config.mcpServers : {};
    const bridgeServer = {
      type: "stdio" as const,
      command: process.execPath,
      args: [
        bridgeBinPath,
        "--correlation",
        correlationId,
        "--role",
        role,
        "--state-dir",
        stateDir,
        "--project",
        projectSlug,
        "--workspace",
        config.cwd,
        ...(task !== undefined ? ["--task", task] : []),
      ],
      env: {
        // Paseo Desktop's process.execPath is an Electron helper binary —
        // without Node mode it aborts at startup and the MCP connection
        // fails on agent.create (v0.0.27, ADR 0017 §2, problem 3).
        ELECTRON_RUN_AS_NODE: "1",
        PASEO_FACTORY_CORRELATION: correlationId,
        PASEO_FACTORY_SEAT: role,
        PASEO_FACTORY_STATE_DIR: stateDir,
        PASEO_FACTORY_PROJECT: projectSlug,
      },
    };
    nextConfig.mcpServers = {
      ...existingMcp,
      paseo_factory: bridgeServer,
      // Paseo's OpenCode v2 bridge-plugin.mjs deletes any tool in input.tools
      // whose ID starts with "paseo_" when paseoTools.enabled is false.
      // Registering under "paseo-factory" (with a hyphen) produces tool IDs
      // starting with "paseo-factory_", which survive that filter.
      ...(providerFamily === "opencode" ? { "paseo-factory": bridgeServer } : {}),
    };
  }

  const existingFeatures = isRecord(config.featureValues) ? config.featureValues : {};
  const existingProviderOpts = isRecord(config.providerOptions) ? config.providerOptions : {};

  if (providerFamily === "opencode") {
    const existingPerm = isRecord(existingProviderOpts.permission) ? existingProviderOpts.permission : {};
    if (role === "supervisor" || role === "lead") {
      // Preserve the user's `Auto-accept` UI toggle (defaulting to true) while
      // setting `toolPolicy: { preapproved: [] }` so OpenCodeV2Session routes
      // every permission request through `choke.onPermissionAsked` instead of
      // bypassing the choke when `auto_accept` is true.
      nextConfig.featureValues = {
        ...existingFeatures,
        auto_accept: typeof existingFeatures.auto_accept === "boolean" ? existingFeatures.auto_accept : true,
      };
      nextConfig.toolPolicy = { preapproved: [] };
      nextConfig.modeId = "build";
      const skillPerm =
        role === "supervisor"
          ? { "*": "deny", grilling: "allow" }
          : { "*": "deny", "codebase-design": "allow", "domain-modeling": "allow", tdd: "allow" };
      nextConfig.providerOptions = {
        ...existingProviderOpts,
        permission: {
          ...existingPerm,
          edit: "deny",
          task: "deny",
          bash: "ask",
          skill: skillPerm,
        },
      };
    } else if (role === "agent") {
      nextConfig.featureValues = {
        ...existingFeatures,
        auto_accept: typeof existingFeatures.auto_accept === "boolean" ? existingFeatures.auto_accept : true,
      };
      nextConfig.toolPolicy = { preapproved: [] };
      nextConfig.providerOptions = {
        ...existingProviderOpts,
        permission: {
          ...existingPerm,
          task: "deny",
        },
      };
    }
  } else if (providerFamily === "claude") {
    const existingDisallowed = Array.isArray(existingProviderOpts.disallowedTools)
      ? existingProviderOpts.disallowedTools.filter((x): x is string => typeof x === "string")
      : [];
    if (role === "supervisor" || role === "lead") {
      const merged = Array.from(new Set([...existingDisallowed, ...CLAUDE_SEAT_WRITE_TOOLS, ...FORBIDDEN_PASEO_TOOLS]));
      nextConfig.providerOptions = {
        ...existingProviderOpts,
        disallowedTools: merged,
      };
    } else if (role === "agent") {
      nextConfig.modeId = "default";
      const merged = Array.from(new Set([...existingDisallowed, ...FORBIDDEN_PASEO_TOOLS]));
      nextConfig.providerOptions = {
        ...existingProviderOpts,
        disallowedTools: merged,
      };
    }
  } else if (providerFamily === "codex") {
    const existingCodexFeatures = isRecord(existingProviderOpts.features) ? existingProviderOpts.features : {};
    if (role === "supervisor" || role === "lead") {
      nextConfig.modeId = "auto";
    }
    nextConfig.providerOptions = {
      ...existingProviderOpts,
      features: {
        ...existingCodexFeatures,
        multi_agent_v2: false,
      },
    };
  } else if (providerFamily === "copilot") {
    if (role === "supervisor" || role === "lead") {
      nextConfig.featureValues = { ...existingFeatures, auto_accept: false };
      nextConfig.modeId =
        role === "supervisor"
          ? "https://agentclientprotocol.com/protocol/session-modes#plan"
          : "https://agentclientprotocol.com/protocol/session-modes#agent";
    }
  } else if (providerFamily === "omp") {
    if (role === "supervisor" || role === "lead") {
      nextConfig.modeId = "write";
    }
  }

  return nextConfig as T;
}

/**
 * Strips any top-level keys other than `config` and `env` (and strips
 * `config.labels`) so Paseo `0.11.2`'s strict `agent.create` before-hook Zod
 * schema (`{ config, env? }`) never rejects the hook return value.
 */
export function sanitizeAgentCreateHookResult<R extends { config: unknown; env?: Record<string, string> }>(result: R): {
  config: R["config"];
  env?: Record<string, string>;
} {
  const cleanConfig = { ...(result.config as Record<string, unknown>) };
  delete cleanConfig.labels;
  return {
    config: cleanConfig as R["config"],
    ...(result.env !== undefined ? { env: result.env } : {}),
  };
}

/**
 * The additive `agent.create` injection (channel 1 + the first-launch env +
 * Layer-1 provider fence + `Correlation token` issuance):
 * a seat-titled create or a managed-worktree create gets its role contract
 * APPENDED to `config.systemPrompt` (idempotent — the footer is the sentinel),
 * a `cor_<uuid>` token issued in `CorrelationRegistry`, `paseo_factory` MCP
 * wired (except on `antigravity`), provider-specific execution fences applied,
 * and its `PASEO_FACTORY_*` env seeded.
 */
export function injectRoleOnCreate<R extends AgentCreateRequest>(
  request: R,
  stateDir: string,
  userHome?: string,
): R | undefined {
  if ((request.config.systemPrompt ?? "").includes(FOOTER_MARK)) return undefined; // already injected — idempotent
  const reqLabels =
    (request as { labels?: Record<string, string> }).labels ??
    (request.config as { labels?: Record<string, string> }).labels;
  const correlations = new CorrelationRegistry(stateDir);

  // The deterministic identity ladder (v0.0.27, ADR 0017 §2): the native role
  // provider id first, then the `PASEO_FACTORY_SEAT` env stamp, then the
  // legacy title/labels inference (titles starting with `/factory` included).
  const providerSeat = inferRoleFromProviderId(request.config.provider);
  const envSeat = parseRoleName(request.env?.PASEO_FACTORY_SEAT);
  const titleSeat = inferRoleSeatFromTitleOrLabels(request.config.title, reqLabels);
  const role: RoleName | undefined = providerSeat ?? envSeat ?? titleSeat;

  // A managed Task worktree keeps its task-bound path — the correlation and
  // the contract both carry the task id — whatever named the role.
  if (role === undefined || role === "agent") {
    const worktree = parseTaskWorktreePath(stateDir, request.config.cwd);
    if (worktree !== null) {
      const reg = listProjectRegistrations(stateDir).find((r) => r.slug === worktree.slug);
      const projectRoot = reg?.root ?? "";
      const issued = correlations.issue({
        role: "agent",
        projectSlug: worktree.slug,
        projectRoot: projectRoot !== "" ? projectRoot : request.config.cwd,
        task: worktree.task,
      });
      const fencedConfig = applyProviderExecutionFence(
        {
          ...request.config,
          systemPrompt: appendContract(request.config.systemPrompt, renderAgentContract(worktree.task, worktree.slug)),
        },
        {
          role: "agent",
          stateDir,
          correlationId: issued.correlationId,
          projectSlug: worktree.slug,
          task: worktree.task,
          userHome,
          // A `factory-peer` spawn (ADR 0017 §2) fences under the worker
          // lane's harness — without this, `providerFamilyOf("factory-peer")`
          // matches no family and the Layer-1 agent fence silently no-ops.
          providerFamily: resolveEffectiveProviderFamily(request.config.provider, "agent", stateDir, worktree.slug),
        },
      );
      return sanitizeAgentCreateHookResult({
        config: fencedConfig,
        env: {
          ...(request.env ?? {}),
          ...factoryEnvFor("agent", {
            stateDir,
            project: { root: projectRoot, slug: worktree.slug },
            task: worktree.task,
            correlationId: issued.correlationId,
            userHome,
          }),
        },
      }) as R;
    }
    if (role === undefined) return undefined;
  }

  // The seat path (v0.0.27, ADR 0017 §2): provider/env-recognized seats and
  // title-inferred seats alike register the Project, issue a Correlation
  // token, and fence under the harness resolved from Lane config — so a
  // `factory-supervisor` chat with the user's message as its title still gets
  // its underlying harness's Layer-1 fence.
  const project = resolveProject(request.config.cwd);
  if (!project.ok) return undefined; // a seat identity on a non-repo cwd is not ours to guess about
  const registered = ensureProjectRegistered(stateDir, project.root);
  const projectIdentity: ProjectIdentity = registered.ok
    ? { root: registered.root, slug: registered.slug }
    : { root: project.root, slug: project.slug };
  const issued = correlations.issue({
    role,
    projectSlug: projectIdentity.slug,
    projectRoot: projectIdentity.root,
  });
  const fencedConfig = applyProviderExecutionFence(
    {
      ...request.config,
      systemPrompt: appendContract(
        request.config.systemPrompt,
        role === "agent"
          ? renderRoleContract("agent", { factoryCmd: "factory", project: projectIdentity })
          : renderSeatContract(role, projectIdentity),
      ),
    },
    {
      role,
      stateDir,
      correlationId: issued.correlationId,
      projectSlug: projectIdentity.slug,
      userHome,
      providerFamily: resolveEffectiveProviderFamily(request.config.provider, role, stateDir, projectIdentity.slug),
    },
  );
  return sanitizeAgentCreateHookResult({
    config: fencedConfig,
    env: {
      ...(request.env ?? {}),
      ...factoryEnvFor(role, { stateDir, project: projectIdentity, correlationId: issued.correlationId, userHome }),
    },
  }) as R;
}

function appendContract(existing: string | undefined, contract: string): string {
  return existing === undefined || existing === "" ? contract : `${existing}\n\n${contract}`;
}

/**
 * The ADR 0017 §2 seat binding: a session recognized as `supervisor` or
 * `lead` records `<seat>: agentId` in `<stateDir>/projects/<slug>/project.json`
 * — the binding Lead completion reports (`to: "supervisor"`) route back into —
 * but never displaces another session already bound to the seat: the
 * rotate/revoke paths clear a dead binding first, so an occupied seat means a
 * live session holds it. Returns whether `agentId` owns the seat afterwards.
 */
function bindSeatAgentId(
  stateDir: string,
  slug: string,
  root: string,
  seat: "supervisor" | "lead",
  agentId: string,
): boolean {
  const registration = readProjectRegistration(stateDir, slug);
  const bound = seat === "supervisor" ? registration?.supervisor : registration?.lead;
  if (bound === agentId) return true;
  if (bound !== undefined) return false; // another live session holds the seat
  writeProjectRegistration(stateDir, slug, { root, ...(seat === "supervisor" ? { supervisor: agentId } : { lead: agentId }) });
  return true;
}

/**
 * The `agent.session_open` injection (channel 3): every launch of a seat or
 * working-agent shell re-carries its `PASEO_FACTORY_*` identity, associates
 * the live `agentId` with its `Correlation token` in `<stateDir>/correlations.json`,
 * and — since v0.0.27 (ADR 0017 §2) — binds a provider- or env-recognized
 * `supervisor` / `lead` session to its Project's `project.json`.
 */
export function injectSessionEnv<
  R extends {
    agentId: string;
    cwd: string;
    env: Record<string, string>;
    provider?: string | null;
    config?: { env?: Record<string, string> };
  },
>(
  request: R,
  stateDir: string,
  userHome?: string,
): R | undefined {
  const correlations = new CorrelationRegistry(stateDir);
  const existingCorrId =
    request.env?.PASEO_FACTORY_CORRELATION ?? request.config?.env?.PASEO_FACTORY_CORRELATION;

  if (typeof existingCorrId === "string" && existingCorrId.trim() !== "") {
    const associated = correlations.associate(existingCorrId.trim(), request.agentId);
    if (associated !== undefined) {
      if (associated.role === "supervisor" || associated.role === "lead") {
        const project = resolveProject(request.cwd);
        if (project.ok && project.slug === associated.projectSlug) {
          bindSeatAgentId(stateDir, project.slug, project.root, associated.role, request.agentId);
        }
      }
      return {
        ...request,
        env: {
          ...request.env,
          ...factoryEnvFor(associated.role, {
            stateDir,
            project: { root: associated.projectRoot, slug: associated.projectSlug },
            ...(associated.task !== undefined ? { task: associated.task } : {}),
            correlationId: associated.correlationId,
            userHome,
          }),
        },
      };
    }
  }

  const resolveOrAssociate = (input: { role: RoleName; projectSlug: string; projectRoot: string; task?: string }) => {
    const existing = correlations.resolve(request.agentId);
    if (existing !== undefined) return existing;
    const unassociated = correlations
      .list()
      .reverse()
      .find(
        (r) =>
          r.role === input.role &&
          r.projectSlug === input.projectSlug &&
          (input.task === undefined || r.task === input.task) &&
          r.agentId === undefined,
      );
    if (unassociated !== undefined) {
      return correlations.associate(unassociated.correlationId, request.agentId);
    }
    return correlations.issue({
      role: input.role,
      projectSlug: input.projectSlug,
      projectRoot: input.projectRoot,
      ...(input.task !== undefined ? { task: input.task } : {}),
      agentId: request.agentId,
    });
  };

  const worktree = parseTaskWorktreePath(stateDir, request.cwd);
  if (worktree !== null) {
    const record = resolveOrAssociate({
      role: "agent",
      projectSlug: worktree.slug,
      projectRoot: request.cwd,
      task: worktree.task,
    });
    return {
      ...request,
      env: {
        ...request.env,
        ...factoryEnvFor("agent", {
          stateDir,
          project: { root: "", slug: worktree.slug },
          task: worktree.task,
          correlationId: record?.correlationId,
          userHome,
        }),
      },
    };
  }

  for (const registration of listProjectRegistrations(stateDir)) {
    const isDispatcher =
      Array.isArray(registration.dispatchers) &&
      registration.dispatchers.includes(request.agentId) &&
      (request.cwd === "" || request.cwd === registration.root || request.cwd.startsWith(`${registration.root}/`));
    const seat =
      request.agentId === registration.supervisor || isDispatcher
        ? "supervisor"
        : request.agentId === registration.lead
          ? "lead"
          : undefined;
    if (seat === undefined) continue;
    const record = resolveOrAssociate({
      role: seat,
      projectSlug: registration.slug,
      projectRoot: registration.root,
    });
    return {
      ...request,
      env: {
        ...request.env,
        ...factoryEnvFor(seat, {
          stateDir,
          project: registration,
          correlationId: record?.correlationId,
          userHome,
        }),
      },
    };
  }

  // The native role-provider channel (v0.0.27, ADR 0017 §2): a
  // `factory-supervisor` / `factory-lead` session (or one stamped
  // `PASEO_FACTORY_SEAT`) opening at a Git repository binds its `agentId` to
  // the Project's seat in `project.json` — never displacing another bound
  // session — and re-carries its factory env, so a native `Supervisor
  // (Factory)` chat needs no custom bootstrap to own the Project's mailbox.
  const identitySeat = inferRoleFromProviderId(request.provider) ?? parseRoleName(request.env?.PASEO_FACTORY_SEAT);
  if (identitySeat === "supervisor" || identitySeat === "lead") {
    const project = resolveProject(request.cwd);
    if (project.ok) {
      bindSeatAgentId(stateDir, project.slug, project.root, identitySeat, request.agentId);
      const record = resolveOrAssociate({
        role: identitySeat,
        projectSlug: project.slug,
        projectRoot: project.root,
      });
      return {
        ...request,
        env: {
          ...request.env,
          ...factoryEnvFor(identitySeat, {
            stateDir,
            project,
            correlationId: record?.correlationId,
            userHome,
          }),
        },
      };
    }
  }
  return undefined;
}
