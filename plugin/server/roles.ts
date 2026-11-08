import { SLP_ROLE_SKILLS, resolveRoleSkillsForProject } from "./core/scrum/skill-hub.ts";
import { discoverHelperMcps, resolveRoleScopedMcpServers, syncHelperMcps } from "./core/helper-mcp-sync.ts";
import { buildRoleKickoffPrompt } from "./core/roles-contract.ts";
import { readRun as readScrumRun } from "./core/scrum/run-journal.ts";
import { restoreLegacyUiEnvironment } from "./core/scrum/companion-tools.ts";
import { readExecution } from "./core/scrum/config.ts";
import { resolveRoleLane, laneProviderConfig } from "./provider-lanes.ts";
import type { ProviderCatalogEntry } from "./provider-lanes.ts";
import { provisionScrumHarness, resolveScrumIdentity, scrumIdentityLane, scopeScrumCapabilities } from "./core/scrum/harness.ts";
import type { ScrumHarnessIdentity } from "./core/scrum/harness.ts";
import { SCRUM_PROMPT_MARK, SCRUM_ROLE_TITLES, renderScrumPrompt } from "./core/scrum/prompts.ts";
/**
 * The role-contract layer (v0.0.14, ADR 0010 §1–§2/§6; v0.0.26, ADR 0016 §1/§3;
 * v0.0.27, ADR 0017 §2): additive injection of the `Supervisor`, `Lead`, and
 * working-`Agent` role contracts, `Correlation token` issuance/association,
 * `paseo_factory` MCP bridge wiring, Layer-1 provider execution fences across
 * all 8 providers (`opencode`, `claude`, `codex`, `pi`, `copilot`, `omp`,
 * `antigravity`, `zcode`), and deterministic seat recognition by native role provider
 * id (`factory-supervisor`, `factory-lead`, `factory-peer`).
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { provisionAgyPlugin, ensureFactoryBinScripts } from "./core/agy-home.ts";
import { CorrelationRegistry } from "./core/correlations.ts";
import { parseLane } from "./core/lanes.ts";
import { resolveOrBootstrapProject, resolveProject } from "./core/project.ts";
import { provisionPiAgentHome } from "./core/pi-home.ts";
import { denyFactorySkillInWorktree, provisionZcodeHome } from "./core/zcode-home.ts";
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

// ---- the Agent tab titles (v0.0.31, ADR 0017 §2/§5) -----------------------------------------

/** The working Agent's tab title inside its Task worktree Workspace — `Peer · <Task>`. */
export function formatPeerAgentTitle(task: string): string {
  return `Peer · ${task}`;
}

/** The cap on a Peer worktree Workspace title's summary clause (ADR 0017 §5). */
const PEER_TITLE_SUMMARY_CAP = 56;

/** The ellipsis appended when the summary clause is truncated. */
const PEER_TITLE_ELLIPSIS = "…";

/**
 * The first clause of a `contract.description` — the text before the earliest
 * of the clause separators (`—`, `. `, `: `, `; `), trimmed and capped at 56
 * characters (appending `…` when truncated). An absent or whitespace-only
 * description yields no clause at all.
 */
function firstSummaryClause(description: string | undefined): string {
  if (typeof description !== "string") return "";
  const separators = ["—", ". ", ": ", "; "];
  let cut = description.length;
  for (const separator of separators) {
    const index = description.indexOf(separator);
    if (index >= 0 && index < cut) cut = index;
  }
  const clause = description.slice(0, cut).trim();
  if (clause === "") return "";
  return clause.length > PEER_TITLE_SUMMARY_CAP
    ? `${clause.slice(0, PEER_TITLE_SUMMARY_CAP)}${PEER_TITLE_ELLIPSIS}`
    : clause;
}

/**
 * The Task worktree Workspace's sidebar title (ADR 0017 §5): `Peer · <Task> —
 * <short summary>` from the contract description's first clause, or just
 * `Peer · <Task>` when no usable clause exists — never the `<project-slug>` hash.
 */
export function formatPeerWorkspaceTitle(task: string, description?: string): string {
  const summary = firstSummaryClause(description);
  return summary === "" ? formatPeerAgentTitle(task) : `${formatPeerAgentTitle(task)} — ${summary}`;
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
 *
 * Since v0.0.94 (ADR 0046 Decision 4/5.1) this is also the channel a zcode
 * seat's clean-room env rides: when the seat's effective family resolves to
 * `zcode` (same resolution the Layer-1 fence keys on, `provider` carrying the
 * request's provider id), `provisionZcodeHome`'s `ZCODE_*` record —
 * `ZCODE_STORAGE_DIR`, `ZCODE_SESSION_DB_PATH`, the guarded mode, and the
 * supervisor/lead `ZCODE_DISALLOWED_TOOLS` tool lock — merges here. The env
 * rides this top-level env channel, never `config.providerOptions`, because
 * it is what Paseo forwards to the `zcode-acp-server` child process, and
 * because this seam re-applies on every session open — the clean room
 * survives relaunches, not just the create.
 */
export function factoryEnvFor(
  role: RoleName,
  input: { stateDir: string; project: ProjectIdentity; task?: string; correlationId?: string; userHome?: string; execution?: ScrumHarnessIdentity | null; environment?: Record<string, string>; provider?: string },
): Record<string, string> {
  ensureFactoryBinScripts(input.stateDir);
  const environment = restoreLegacyUiEnvironment({ ...process.env, ...input.environment });
  const execution = input.execution === null ? undefined : input.execution ?? resolveScrumIdentity(input.stateDir, input.project.slug, input.task);
  const workspace = input.task !== undefined
    ? join(input.stateDir, "projects", input.project.slug, "worktrees", input.task)
    : input.project.root;
  const roleHome = execution !== undefined ? provisionScrumHarness({ state: input.stateDir, slug: input.project.slug, authority: role, identity: execution, generation: input.correlationId ?? "initial", userHome: input.userHome, environment, workspace }) : provisionPiAgentHome({
    stateDir: input.stateDir,
    role,
    sourceAgentDir: join(input.userHome ?? homedir(), ".pi", "agent"),
    helperMcpSources: { userHome: input.userHome ?? homedir() },
  });
  const env: Record<string, string> = {
    PASEO_FACTORY_SEAT: role,
    PASEO_FACTORY_PROJECT: input.project.slug,
    PASEO_FACTORY_STATE_DIR: input.stateDir,
    PI_CODING_AGENT_DIR: roleHome,
    ...(execution === undefined ? {} : { PATH: [join(roleHome, 'bin'), environment.PATH ?? ''].filter(Boolean).join(delimiter) }),
    ...(execution === undefined ? {} : { PASEO_FACTORY_EXECUTION: JSON.stringify(execution) }),
  };
  if (input.project.root !== "") env.PASEO_FACTORY_PROJECT_ROOT = input.project.root;
  if (input.task !== undefined) env.PASEO_FACTORY_TASK = input.task;
  if (input.correlationId !== undefined && input.correlationId !== "") {
    env.PASEO_FACTORY_CORRELATION = input.correlationId;
  }
  // The zcode clean-room twin (v0.0.94, ADR 0046 Decision 4): the same
  // effective-family resolution the Layer-1 fence keys on decides whether the
  // seat's `ZCODE_*` storage env rides — a factory provider resolves through
  // the role's Lane config, a raw provider through its own family — so the
  // config fence and the child env can never disagree on the harness.
  // Since v0.2.0 (ADR 0049 §1) a Scrum execution reroutes the clean room under
  // `<projectStateDir>/scrum/zcode-home/...` (the twin of the Pi
  // `scrum/harness` hierarchy provisioned above, same `generation`) and pairs
  // it with the rendered Scrum contract plus the Scrum role-scoped skill
  // allowlist — the file channel `zcode.cjs` reloads every turn, since
  // `config.systemPrompt` never rides ACP. SLP calls (no execution) stay
  // byte-identical to the pre-Scrum shape.
  if (resolveEffectiveProviderFamily(input.provider, role, input.stateDir, input.project.slug, input.task) === "zcode") {
    // The project-scope factory-skill deny (v0.2.3, the ADR 0050 Decision 6
    // replacement): a Task worktree workspace — never the project root, which
    // the Owner and the SLP Supervisor share — gains `<worktree>/.zcode/config.json`
    // carrying the `SKILL.md`-path `skill` overrides, the only config seam a
    // zcode session actually reads beside the user config. Idempotent, so the
    // session_open re-apply never duplicates anything.
    if (input.task !== undefined) {
      denyFactorySkillInWorktree(workspace, input.userHome ?? homedir());
    }
    // The Scrum role the clean room renders the contract and scopes skills
    // for — the same narrowing provisionScrumHarness applies
    // (src/scrum/harness.ts): a task execution carries its bound specialist
    // role, while a seat identity only ever attaches to a supervisor/lead
    // seat — the `agent` role reaches this seam only alongside a task
    // worktree, which resolves a task-kind execution (or none), so the cast
    // below is the documented invariant, never a silent trust of `agent`.
    const scrumRole =
      execution?.kind === "task"
        ? execution.binding.role
        : (role as "supervisor" | "lead");
    Object.assign(env, provisionZcodeHome({
      stateDir: input.stateDir,
      role,
      projectSlug: input.project.slug,
      ...(input.task !== undefined ? { task: input.task } : {}),
      ...(input.userHome !== undefined ? { userHome: input.userHome } : {}),
      ...(execution === undefined ? {} : {
        scrum: execution.kind === "seat"
          ? { kind: "seat", selectionRevision: execution.selectionRevision, generation: input.correlationId ?? "initial", authority: role }
          : { kind: "task", runId: execution.binding.runId, task: execution.task, epoch: execution.epoch },
        systemPrompt: renderScrumPrompt(scrumRole, {
          project: input.project.slug,
          workspace,
          ...(execution.kind === "task"
            ? {
                run: readScrumRun(input.stateDir, input.project.slug, execution.binding.runId),
                task: execution.task,
                runId: execution.binding.runId,
                epoch: execution.epoch,
              }
            : {}),
        }),
        // The Scrum supervisor keeps full host skills minus the Owner-only
        // `factory` skill (the provisioner's Scrum-supervisor policy); the
        // Scrum lead and every specialist get exactly their role-scoped set.
        ...(role === "supervisor" ? {} : {
          allowedSkills: resolveRoleSkillsForProject({
            role: scrumRole,
            projectRoot: execution.projectRoot ?? readProjectRegistration(input.stateDir, input.project.slug)?.root,
            configuredPacks: execution.configuredPacks ?? readExecution(input.stateDir, input.project.slug).skillPacks,
            contractSkills: execution.contractSkills,
            userHome: input.userHome,
          }),
        }),
      }),
    }));
  }
  return env;
}

// The before("agent.create") request slice — the SDK's shape restated locally
// so the pure function stays testable without a server.
export interface AgentCreateRequest {
  config: {
    provider?: string;
    thinkingOptionId?: string;
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
    trimmed === "Scrum Lead" ||
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
  taskId?: string,
): string {
  const rawProvider = typeof provider === "string" ? provider.trim() : "";
  if (inferRoleFromProviderId(rawProvider) === undefined) return providerFamilyOf(rawProvider);
  const lane = resolveRoleLane(stateDir, projectSlug, role, taskId);
  const parsed = lane !== undefined ? parseLane(lane) : undefined;
  return parsed === undefined ? providerFamilyOf(rawProvider) : providerFamilyOf(parsed.provider);
}

/**
 * Applies the Layer-1 provider execution fence and `paseo_factory` MCP server
 * config on `agent.create` across all 8 provider families (`opencode`,
 * `claude`, `codex`, `pi`, `copilot`, `omp`, `antigravity`, `zcode`).
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
    const existingMcp = resolveRoleScopedMcpServers({ stateDir, userHome, role, provider: providerFamily });
    const bridgeServer = {
      type: "stdio" as const,
      command: process.execPath,
      args: [
        bridgeBinPath,
        "--correlation",
        correlationId,
        "--role",
        role,
        "--mode",
        readExecution(stateDir, projectSlug).mode,
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
      const skillPerm = { '*': 'deny', ...Object.fromEntries(SLP_ROLE_SKILLS[role].map(skill => [skill, 'allow'])) };
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
      const validClaudeModes = new Set(["plan", "default", "acceptEdits", "auto", "bypassPermissions"]);
      if (typeof nextConfig.modeId === "string" && !validClaudeModes.has(nextConfig.modeId)) {
        delete nextConfig.modeId;
      }
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
  } else if (providerFamily === "zcode") {
    // Layer 1 (v0.0.94, ADR 0046 Decision 5.1): guarded mode + auto_accept
    // off routes every Write/Edit/MultiEdit/NotebookEdit/DeleteFile and Bash
    // ask through `interaction/requestPermission` into the choke (Layer 2).
    // The supervisor/lead write-tool lock itself rides ZCODE_DISALLOWED_TOOLS
    // in the clean-room env (`factoryEnvFor` → `provisionZcodeHome`) — the
    // channel zcode-acp-server forwards into `session/create`'s toolDenylist;
    // the config carries no equivalent field.
    if (role === "supervisor" || role === "lead") {
      nextConfig.featureValues = { ...existingFeatures, auto_accept: false };
      nextConfig.modeId = "guarded";
    } else if (role === "agent") {
      // A contracted Peer keeps its write tools — its asks route into the
      // choke, which auto-allows safe worktree edits and blocks the rest.
      nextConfig.featureValues = { ...existingFeatures, auto_accept: false };
    }
  } else if (providerFamily === "omp") {
    if (role === "supervisor" || role === "lead") {
      nextConfig.modeId = "write";
    }
  } else if (providerFamily === "pi" || providerFamily === "antigravity") {
    delete nextConfig.modeId;
  }

  return nextConfig as T;
}

/**
 * Strips any top-level keys other than `config` and `env` (and strips
 * `config.labels`) so Paseo `0.11.2`'s strict `agent.create` before-hook Zod
 * schema (`{ config, env? }`) never rejects the hook return value. Every other
 * config field rides verbatim — `config.title` included (v0.0.31, ADR 0017
 * §2): the role title stamped by `injectRoleOnCreate` must survive the return
 * trip so Paseo names the Agent tab `Supervisor` / `Lead` / `Peer · <Task>`.
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
  providers?: readonly ProviderCatalogEntry[],
): R | undefined {
  const reqLabels =
    (request as { labels?: Record<string, string> }).labels ??
    (request.config as { labels?: Record<string, string> }).labels;
  const correlations = new CorrelationRegistry(stateDir);
  const oldUiHome = request.env?.PASEO_FACTORY_UI_HOME;
  request = { ...request, env: restoreLegacyUiEnvironment(request.env ?? {}), config: { ...request.config } };
  if (oldUiHome && request.config.providerOptions) {
    const options = request.config.providerOptions, extra = options.extraArgs;
    if (isRecord(extra) && extra['plugin-dir'] === oldUiHome) {
      const clean = { ...extra }; delete clean['plugin-dir'];
      request.config.providerOptions = { ...options, extraArgs: clean };
    }
  }

  // The deterministic identity ladder (v0.0.27, ADR 0017 §2): the native role
  // provider id first, then the `PASEO_FACTORY_SEAT` env stamp, then the
  // legacy title/labels inference (titles starting with `/factory` included).
  const providerSeat = inferRoleFromProviderId(request.config.provider);
  const envSeat = parseRoleName(request.env?.PASEO_FACTORY_SEAT);
  const titleSeat = inferRoleSeatFromTitleOrLabels(request.config.title, reqLabels);
  const role: RoleName | undefined = providerSeat ?? envSeat ?? titleSeat;
  const hasPrompt = (request.config.systemPrompt ?? "").includes(FOOTER_MARK) || (request.config.systemPrompt ?? "").includes(SCRUM_PROMPT_MARK);
  const bound = request.env?.PASEO_FACTORY_CORRELATION ? correlations.resolve(request.env.PASEO_FACTORY_CORRELATION) : undefined;
  const alreadyProvisioned = (projectSlug: string, execution: ScrumHarnessIdentity | undefined, task?: string) =>
    hasPrompt && bound !== undefined && bound.role === role && bound.projectSlug === projectSlug &&
    bound.projectSlug === request.env?.PASEO_FACTORY_PROJECT && bound.task === task &&
    JSON.stringify(bound.execution ?? null) === JSON.stringify(execution ?? null);


  // A managed Task worktree keeps its task-bound path — the correlation and
  // the contract both carry the task id — whatever named the role.
  if (role === undefined || role === "agent") {
    const worktree = parseTaskWorktreePath(stateDir, request.config.cwd);
    if (worktree !== null) {
      const reg = listProjectRegistrations(stateDir).find((r) => r.slug === worktree.slug);
      const projectRoot = reg?.root ?? "";
      const execution = resolveScrumIdentity(stateDir, worktree.slug, worktree.task);
      if (alreadyProvisioned(worktree.slug, execution, worktree.task)) return undefined;
      if (execution) delete request.config.thinkingOptionId;
      const issued = correlations.issue({
        ...(execution === undefined ? {} : { execution }),
        role: "agent",
        projectSlug: worktree.slug,
        projectRoot: projectRoot !== "" ? projectRoot : request.config.cwd,
        task: worktree.task,
      });
      const fencedConfig = applyProviderExecutionFence(
        {
          ...request.config,
          ...(execution === undefined ? {} : scrumProviderConfig(stateDir, worktree.slug, "agent", execution, providers)),
          // The Agent tab inside the Task worktree Workspace reads `Peer · <Task>`
          // (ADR 0017 §2) — never the bare task id or the raw spawn prompt.
          title: execution?.kind === "task" ? `${SCRUM_ROLE_TITLES[execution.binding.role]} · ${worktree.task}` : formatPeerAgentTitle(worktree.task),
          systemPrompt: appendContract(request.config.systemPrompt, execution?.kind === "task" ? renderScrumPrompt(execution.binding.role, { project: worktree.slug, run: readScrumRun(stateDir, worktree.slug, execution.binding.runId), runId: execution.binding.runId, task: worktree.task, epoch: execution.epoch, workspace: request.config.cwd }) : buildRoleKickoffPrompt("agent", { task: worktree.task, project: { root: request.config.cwd, slug: worktree.slug }, helperMcps: discoverHelperMcps({ stateDir, userHome }).servers })),
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
          providerFamily: execution === undefined ? resolveEffectiveProviderFamily(request.config.provider, "agent", stateDir, worktree.slug) : providerFamilyOf(scrumIdentityLane(stateDir, worktree.slug, "agent", execution)),
        },
      );
      const taskEnv = factoryEnvFor("agent", { stateDir, project: { root: projectRoot, slug: worktree.slug }, task: worktree.task, correlationId: issued.correlationId, userHome, provider: request.config.provider, environment: request.env });
      return sanitizeAgentCreateHookResult({
        config: execution === undefined ? fencedConfig : scopeScrumCapabilities(fencedConfig, "agent", execution, taskEnv.PI_CODING_AGENT_DIR, { projectRoot, configuredPacks: readExecution(stateDir, worktree.slug).skillPacks, userHome }),
        env: {
          ...(request.env ?? {}),
          ...taskEnv,
        },
      }) as R;
    }
    if (role === undefined) return undefined;
  }

  // The seat path (v0.0.27, ADR 0017 §2; v0.0.35, ADR 0024): provider/env-recognized
  // seats and title-inferred seats alike bootstrap a greenfield non-Git folder
  // (refusing `$HOME`, `/`, and internal stateDir), register the Project, issue
  // a Correlation token, and fence under the harness resolved from Lane config —
  // so a `factory-supervisor` chat with the user's message as its title still
  // gets its underlying harness's Layer-1 fence.
  const project =
    role === "supervisor" || role === "lead"
      ? resolveOrBootstrapProject(request.config.cwd, { stateDir, userHome })
      : resolveProject(request.config.cwd);
  if (!project.ok) return undefined; // a seat identity on an unresolvable/unsafe cwd is not ours to guess about
  const registered = ensureProjectRegistered(stateDir, project);
  const projectIdentity: ProjectIdentity = registered.ok
    ? { root: registered.root, slug: registered.slug }
    : { root: project.root, slug: project.slug };
  const execution = resolveScrumIdentity(stateDir, projectIdentity.slug);
  if (alreadyProvisioned(projectIdentity.slug, execution)) return undefined;
  if (execution) delete request.config.thinkingOptionId;
  const issued = correlations.issue({
    ...(execution === undefined ? {} : { execution }),
    role,
    projectSlug: projectIdentity.slug,
    projectRoot: projectIdentity.root,
  });
  const fencedConfig = applyProviderExecutionFence(
    {
      ...request.config,
      ...(execution === undefined ? {} : scrumProviderConfig(stateDir, projectIdentity.slug, role, execution, providers)),
      // The Agent tab inside the main Workspace reads the clean seat title
      // (ADR 0017 §2) — `Supervisor` / `Lead`, never the raw first message.
      title: role === "lead" && execution ? "Scrum Lead" : role === "supervisor" || role === "lead" ? SEAT_TITLES[role] : request.config.title,
      systemPrompt: appendContract(
        request.config.systemPrompt,
        execution !== undefined && role !== "agent" ? renderScrumPrompt(role, { project: projectIdentity.slug, workspace: request.config.cwd }) : role === "agent"
          ? buildRoleKickoffPrompt("agent", { factoryCmd: "factory", project: projectIdentity, helperMcps: discoverHelperMcps({ stateDir, userHome }).servers })
          : buildRoleKickoffPrompt(role, { factoryCmd: "factory", project: projectIdentity, helperMcps: discoverHelperMcps({ stateDir, userHome }).servers }),
      ),
    },
    {
      role,
      stateDir,
      correlationId: issued.correlationId,
      projectSlug: projectIdentity.slug,
      userHome,
      providerFamily: execution === undefined ? resolveEffectiveProviderFamily(request.config.provider, role, stateDir, projectIdentity.slug) : providerFamilyOf(scrumIdentityLane(stateDir, projectIdentity.slug, role, execution)),
    },
  );
  return sanitizeAgentCreateHookResult({
    config: execution === undefined ? fencedConfig : scopeScrumCapabilities(fencedConfig, role, execution, undefined, { projectRoot: projectIdentity.root, configuredPacks: readExecution(stateDir, projectIdentity.slug).skillPacks, userHome }),
    env: {
      ...(request.env ?? {}),
      ...factoryEnvFor(role, { stateDir, project: projectIdentity, correlationId: issued.correlationId, userHome, provider: request.config.provider, environment: request.env }),
    },
  }) as R;
}

const ROLE_CONTEXT_MARK = "<!-- paseo-factory injected role contract -->";
function appendContract(existing: string | undefined, contract: string): string {
  let prefix = existing ?? "";
  const markers = [ROLE_CONTEXT_MARK, SCRUM_PROMPT_MARK];
  // Compatibility with prompts injected before the explicit start marker.
  if (prefix.includes(FOOTER_MARK)) markers.push("You are the Supervisor seat of the paseo-factory", "You are the Lead seat of the paseo-factory", "You are a working Agent of the paseo-factory", "You are a Peer of the paseo-factory");
  const starts = markers.map(marker => prefix.indexOf(marker)).filter(index => index >= 0);
  if (starts.length) prefix = prefix.slice(0, Math.min(...starts)).trimEnd();
  return `${prefix ? prefix + "\n\n" : ""}${ROLE_CONTEXT_MARK}\n${contract}`;
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
 * The co-location half of the ADR 0017 §5 seat binding: a `supervisor` (or
 * `lead`) session opening inside a Paseo Workspace persists that Workspace's
 * id as the Project registration's `workspaceId` — the main Workspace
 * `ensureSeat("lead")` reuses so `Supervisor` and `Lead` sit side-by-side as
 * two Agent tabs. The merge law of `writeProjectRegistration` preserves every
 * other registration field; an absent, empty, or non-string `workspaceId`
 * writes nothing (and role `agent` never persists one).
 */
function persistSeatWorkspaceId(
  stateDir: string,
  slug: string,
  root: string,
  workspaceId: string | null | undefined,
): void {
  if (typeof workspaceId !== "string" || workspaceId === "") return;
  writeProjectRegistration(stateDir, slug, { root, workspaceId });
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
    reason?: string | null;
    purpose?: string | null;
    /** The Paseo 0.14.0/0.15.0 `PluginSessionOpenRequest` seat-title field — the fallback identity when the provider was rewritten (v0.0.91, ADR 0026). */
    title?: string | null;
    /** The Paseo 0.14.0/0.15.0 `PluginSessionOpenRequest` seat labels (`{ seat, project }`) — the fallback identity when the provider was rewritten (v0.0.91, ADR 0026). */
    labels?: Readonly<Record<string, string>>;
    config?: { env?: Record<string, string> };
    /** The Paseo Workspace the session opened in (v0.0.31, ADR 0017 §5) — persisted for seat sessions. */
    workspaceId?: string | null;
  },
>(
  request: R,
  stateDir: string,
  userHome?: string,
): R | undefined {
  if (
    typeof request.cwd === "string" &&
    request.cwd.trim() !== "" &&
    parseTaskWorktreePath(stateDir, request.cwd) !== null &&
    (request.reason === "resume" || request.purpose === "history") &&
    !existsSync(request.cwd)
  ) {
    try {
      mkdirSync(request.cwd, { recursive: true });
    } catch {
      // best-effort directory stub so PiRpcAgentClient.resumeSession does not fail with spawn pi ENOENT
    }
  }
  const correlations = new CorrelationRegistry(stateDir);
  const existingCorrId =
    request.env?.PASEO_FACTORY_CORRELATION ?? request.config?.env?.PASEO_FACTORY_CORRELATION;
  // The history-open fence (v0.0.91): Paseo fires `agent.open.before` with
  // `purpose: "history"` to read an old or archived conversation's transcript.
  // Reading history never mutates the Project's active seat routing — every
  // `project.json` write below runs only on a non-history open.
  const isHistoryOpen = request.purpose === "history";

  if (typeof existingCorrId === "string" && existingCorrId.trim() !== "") {
    const associated = correlations.associate(existingCorrId.trim(), request.agentId);
    if (associated !== undefined) {
      if (
        !isHistoryOpen &&
        (associated.role === "supervisor" || associated.role === "lead")
      ) {
        const project = resolveOrBootstrapProject(request.cwd, { stateDir, userHome });
        if (project.ok && project.slug === associated.projectSlug) {
          ensureProjectRegistered(stateDir, project);
          // Only a session that actually holds the seat persists its
          // workspaceId (Implementation Decision 1): bindSeatAgentId returns
          // false when another live session already owns it, and a seat it
          // does not own must not re-point the Project's main Workspace.
          if (bindSeatAgentId(stateDir, project.slug, project.root, associated.role, request.agentId)) {
            persistSeatWorkspaceId(stateDir, project.slug, project.root, request.workspaceId);
          }
        }
      }
      return {
        ...request,
        env: {
          ...restoreLegacyUiEnvironment(request.env ?? {}),
          ...factoryEnvFor(associated.role, {
            stateDir,
            project: { root: associated.projectRoot, slug: associated.projectSlug },
            ...(associated.task !== undefined ? { task: associated.task } : {}),
            execution: associated.execution ?? null,
            correlationId: associated.correlationId,
            userHome,
            provider: request.provider ?? undefined,
            environment: request.env,
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
        ...restoreLegacyUiEnvironment(request.env ?? {}),
        ...factoryEnvFor("agent", {
          stateDir,
          project: { root: "", slug: worktree.slug },
          task: worktree.task,
          correlationId: record?.correlationId,
          userHome,
          provider: request.provider ?? undefined,
          environment: request.env,
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
        ...restoreLegacyUiEnvironment(request.env ?? {}),
        ...factoryEnvFor(seat, {
          stateDir,
          project: registration,
          correlationId: record?.correlationId,
          userHome,
          provider: request.provider ?? undefined,
          environment: request.env,
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
  // The third arm (v0.0.91, ADR 0026): the provider was rewritten onto the
  // base runtime provider at create time and the env arrives empty on a cold
  // reopen — the Paseo 0.14.0/0.15.0 `title`/`labels` request fields carry
  // the deterministic seat identity instead.
  const identitySeat =
    inferRoleFromProviderId(request.provider) ??
    parseRoleName(request.env?.PASEO_FACTORY_SEAT) ??
    inferRoleSeatFromTitleOrLabels(request.title, request.labels ? { ...request.labels } : undefined);
  if (identitySeat === "supervisor" || identitySeat === "lead") {
    const project = resolveOrBootstrapProject(request.cwd, { stateDir, userHome });
    if (project.ok) {
      // The history-open fence (v0.0.91): reading an old conversation with a
      // recognized seat identity re-carries the seat env but never registers
      // the Project, binds the seat, persists a workspaceId, or issues a new
      // Correlation token.
      if (!isHistoryOpen) {
        ensureProjectRegistered(stateDir, project);
        // Same law as the correlation arm above: only a session that actually
        // holds the seat persists its workspaceId (Implementation Decision 1).
        if (bindSeatAgentId(stateDir, project.slug, project.root, identitySeat, request.agentId)) {
          persistSeatWorkspaceId(stateDir, project.slug, project.root, request.workspaceId);
        }
      }
      const record = isHistoryOpen ? undefined : resolveOrAssociate({
        role: identitySeat,
        projectSlug: project.slug,
        projectRoot: project.root,
      });
      return {
        ...request,
        env: {
          ...restoreLegacyUiEnvironment(request.env ?? {}),
          ...factoryEnvFor(identitySeat, {
            stateDir,
            project,
            correlationId: record?.correlationId,
            userHome,
            provider: request.provider ?? undefined,
            environment: request.env,
          }),
        },
      };
    }
  }
  return undefined;
}

function scrumProviderConfig(state: string, slug: string, role: RoleName, identity: ScrumHarnessIdentity, providers?: readonly ProviderCatalogEntry[]) {
  const lane = resolveRoleLane(state, slug, role, identity.kind === "task" ? identity.task : undefined);
  if (!lane) throw new Error("invalid frozen Scrum lane");
  return laneProviderConfig(lane, providers);
}

/** Async pre-create sync keeps filesystem provisioning synchronous and never starts stdio helpers. */
export async function syncPeerHelpersBeforeCreate(request: AgentCreateRequest, stateDir: string, userHome?: string): Promise<void> {
  const labels = (request as { labels?: Record<string, string> }).labels ?? (request.config as { labels?: Record<string, string> }).labels;
  const role = inferRoleFromProviderId(request.config.provider) ?? parseRoleName(request.env?.PASEO_FACTORY_SEAT) ?? inferRoleSeatFromTitleOrLabels(request.config.title, labels);
  if (role === "agent" || (role === undefined && parseTaskWorktreePath(stateDir, request.config.cwd))) {
    await syncHelperMcps({ stateDir, userHome });
  }
}
