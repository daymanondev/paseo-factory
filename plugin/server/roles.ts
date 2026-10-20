/**
 * The role-contract layer (v0.0.14, ADR 0010 §1–§2/§6; v0.0.26, ADR 0016 §1/§3):
 * additive injection of the `Supervisor`, `Lead`, and working-`Agent` role
 * contracts, `Correlation token` issuance/association, `paseo_factory` MCP
 * bridge wiring, and Layer-1 provider execution fences across all 7 providers
 * (`opencode`, `claude`, `codex`, `pi`, `copilot`, `omp`, `antigravity`).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { provisionAgyPlugin, ensureFactoryBinScripts } from "./core/agy-home.ts";
import { CorrelationRegistry } from "./core/correlations.ts";
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
import { listProjectRegistrations } from "./projects.ts";
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
  };
  env?: Record<string, string>;
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
  return undefined;
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
  },
): T {
  const { role, stateDir, correlationId, projectSlug, task, userHome, agyPluginsDir } = input;
  const rawProvider = typeof config.provider === "string" ? config.provider.trim() : "";
  const rawFamily = rawProvider.split("/")[0]?.trim().toLowerCase() ?? "";
  const providerFamily = rawFamily === "claude-code" ? "claude" : rawFamily === "agy" ? "antigravity" : rawFamily;

  const { bridgeBinPath } = ensureFactoryBinScripts(stateDir);
  const nextConfig: Record<string, unknown> = { ...config };
  // Never pass `labels` inside `config` to Paseo's strict `agent.create` validator
  delete nextConfig.labels;

  if (providerFamily === "antigravity") {
    delete nextConfig.mcpServers;
    provisionAgyPlugin({ stateDir, userHome, agyPluginsDir });
  } else {
    const existingMcp = isRecord(config.mcpServers) ? config.mcpServers : {};
    nextConfig.mcpServers = {
      ...existingMcp,
      paseo_factory: {
        type: "stdio",
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
          PASEO_FACTORY_CORRELATION: correlationId,
          PASEO_FACTORY_SEAT: role,
          PASEO_FACTORY_STATE_DIR: stateDir,
          PASEO_FACTORY_PROJECT: projectSlug,
        },
      },
    };
  }

  const existingFeatures = isRecord(config.featureValues) ? config.featureValues : {};
  const existingProviderOpts = isRecord(config.providerOptions) ? config.providerOptions : {};

  if (providerFamily === "opencode") {
    const existingPerm = isRecord(existingProviderOpts.permission) ? existingProviderOpts.permission : {};
    nextConfig.modeId = "default";
    nextConfig.featureValues = { ...existingFeatures, auto_accept: false };
    if (role === "supervisor" || role === "lead") {
      nextConfig.providerOptions = {
        ...existingProviderOpts,
        permission: {
          ...existingPerm,
          edit: "deny",
          task: "deny",
        },
      };
    } else if (role === "agent") {
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
    nextConfig.modeId = "default";
    nextConfig.featureValues = { ...existingFeatures, auto_accept: false };
    if (role === "supervisor" || role === "lead") {
      const merged = Array.from(new Set([...existingDisallowed, ...CLAUDE_SEAT_WRITE_TOOLS, ...FORBIDDEN_PASEO_TOOLS]));
      nextConfig.providerOptions = {
        ...existingProviderOpts,
        disallowedTools: merged,
      };
    } else if (role === "agent") {
      const merged = Array.from(new Set([...existingDisallowed, ...FORBIDDEN_PASEO_TOOLS]));
      nextConfig.providerOptions = {
        ...existingProviderOpts,
        disallowedTools: merged,
      };
    }
  } else if (providerFamily === "codex") {
    const existingCodexFeatures = isRecord(existingProviderOpts.features) ? existingProviderOpts.features : {};
    nextConfig.modeId = "default";
    nextConfig.featureValues = { ...existingFeatures, auto_accept: false };
    nextConfig.providerOptions = {
      ...existingProviderOpts,
      features: {
        ...existingCodexFeatures,
        multi_agent_v2: false,
      },
    };
  } else if (providerFamily === "copilot" || providerFamily === "cursor") {
    nextConfig.modeId = "default";
    nextConfig.featureValues = { ...existingFeatures, auto_accept: false };
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
  const seat = inferRoleSeatFromTitleOrLabels(request.config.title, reqLabels);
  const correlations = new CorrelationRegistry(stateDir);

  if (seat !== undefined) {
    const project = resolveProject(request.config.cwd);
    if (!project.ok) return undefined; // a seat title on a non-repo cwd is not ours to guess about
    const issued = correlations.issue({
      role: seat,
      projectSlug: project.slug,
      projectRoot: project.root,
    });
    const fencedConfig = applyProviderExecutionFence(
      {
        ...request.config,
        systemPrompt: appendContract(request.config.systemPrompt, renderSeatContract(seat, project)),
      },
      {
        role: seat,
        stateDir,
        correlationId: issued.correlationId,
        projectSlug: project.slug,
        userHome,
      },
    );
    return sanitizeAgentCreateHookResult({
      config: fencedConfig,
      env: {
        ...(request.env ?? {}),
        ...factoryEnvFor(seat, { stateDir, project, correlationId: issued.correlationId, userHome }),
      },
    }) as R;
  }

  const worktree = parseTaskWorktreePath(stateDir, request.config.cwd);
  if (worktree === null) return undefined;
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

function appendContract(existing: string | undefined, contract: string): string {
  return existing === undefined || existing === "" ? contract : `${existing}\n\n${contract}`;
}

/**
 * The `agent.session_open` injection (channel 3): every launch of a seat or
 * working-agent shell re-carries its `PASEO_FACTORY_*` identity and associates
 * the live `agentId` with its `Correlation token` in `<stateDir>/correlations.json`.
 */
export function injectSessionEnv<
  R extends { agentId: string; cwd: string; env: Record<string, string>; config?: { env?: Record<string, string> } },
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

  const worktree = parseTaskWorktreePath(stateDir, request.cwd);
  if (worktree !== null) {
    let record = correlations.resolve(request.agentId);
    if (record === undefined) {
      const unassociated = correlations
        .list()
        .reverse()
        .find((r) => r.role === "agent" && r.projectSlug === worktree.slug && r.task === worktree.task && r.agentId === undefined);
      if (unassociated !== undefined) {
        record = correlations.associate(unassociated.correlationId, request.agentId);
      } else {
        record = correlations.issue({
          role: "agent",
          projectSlug: worktree.slug,
          projectRoot: request.cwd,
          task: worktree.task,
          agentId: request.agentId,
        });
      }
    }
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
    let record = correlations.resolve(request.agentId);
    if (record === undefined) {
      const unassociated = correlations
        .list()
        .reverse()
        .find((r) => r.role === seat && r.projectSlug === registration.slug && r.agentId === undefined);
      if (unassociated !== undefined) {
        record = correlations.associate(unassociated.correlationId, request.agentId);
      } else {
        record = correlations.issue({
          role: seat,
          projectSlug: registration.slug,
          projectRoot: registration.root,
          agentId: request.agentId,
        });
      }
    }
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
  return undefined;
}
