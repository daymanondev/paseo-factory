import { resolveRoleSkillsForProject, SLP_ROLE_SKILLS } from "./core/skill-hub.ts";
import { discoverHelperMcps, resolveRoleScopedMcpServers, syncHelperMcps } from "./core/helper-mcp-sync.ts";
import { buildRoleKickoffPrompt, renderPeerSkillScope } from "./core/roles-contract.ts";
import { restoreLegacyUiEnvironment } from "./core/companion-tools.ts";
import { resolveRoleLane } from "./provider-lanes.ts";
/**
 * The role-contract layer (v0.0.14, ADR 0010 §1–§2/§6; v0.0.26, ADR 0016 §1/§3;
 * v0.0.27, ADR 0017 §2): additive injection of the `Supervisor`, `Lead`, and
 * working-`Agent` role contracts, `Correlation token` issuance/association,
 * `paseo_factory` MCP bridge wiring, Layer-1 provider execution fences across
 * all 7 providers (`opencode`, `claude`, `codex`, `pi`, `copilot`, `omp`,
 * `antigravity`), and deterministic seat recognition by native role provider
 * id (`factory-supervisor`, `factory-lead`, `factory-peer`).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { provisionAgyPlugin, ensureFactoryBinScripts } from "./core/agy-home.ts";
import { CorrelationRegistry } from "./core/correlations.ts";
import { normalizeLaneWithProviders, parseLane } from "./core/lanes.ts";
import type { LaneThinkingCatalogEntry } from "./core/lanes.ts";
import { resolveOrBootstrapProject, resolveProject } from "./core/project.ts";
import { parseLedgerJsonl } from "./core/ledger-validation.ts";
import { projectTask } from "./core/task-state.ts";
import { readProjectSettings } from "./core/project-settings.ts";
import { resolveStoreReleaseCapability } from "./core/store-release-capability.ts";
import type { StoreReleaseCapability } from "./core/store-release-capability.ts";
import { provisionPiAgentHome } from "./core/pi-home.ts";
import {
  FOOTER_MARK,
  ROLE_SKILL_INDEX,
  SEAT_TITLES,
  renderRoleContract,
  renderSeatBootstrapPrompt,
} from "./core/roles-contract.ts";
import type { ProjectIdentity, RoleName, SeatBootstrapInput, SeatName } from "./core/roles-contract.ts";
import type { PeerDisposition } from "./core/events.ts";
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
export function renderSeatContract(
  seat: SeatName,
  project: ProjectIdentity,
  options?: { stateDir?: string; storeRelease?: StoreReleaseCapability },
): string {
  const storeRelease =
    options?.storeRelease ??
    resolveStoreReleaseCapability({
      projectRoot: project.root,
      stateDir: options?.stateDir,
      projectSlug: project.slug,
    });
  return renderRoleContract(seat, { factoryCmd: "factory", project, storeRelease });
}

/** The working Agent's law — appended to its task-worktree agent's system prompt. */
export function renderAgentContract(task: string, slug: string, disposition?: PeerDisposition): string {
  return renderRoleContract("agent", {
    factoryCmd: "factory",
    project: { root: "", slug },
    task,
    ...(disposition !== undefined ? { disposition } : {}),
  });
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

/** Read acknowledged Contracts without opening a second writable ledger. */
function peerSkillContext(stateDir: string, projectSlug: string, task?: string, userHome?: string, projectRoot?: string) {
  const root = readProjectRegistration(stateDir, projectSlug)?.root ?? projectRoot;
  const path = join(stateDir, "projects", projectSlug, "ledger.jsonl");
  const read = existsSync(path) ? parseLedgerJsonl(readFileSync(path, "utf8")) : undefined;
  if (read?.corrupt !== undefined) throw new Error(`cannot resolve Peer skills: ${read.corrupt}`);
  const contract = task && read?.events ? projectTask(read.events, task).contract : undefined;
  const configuredPacks = readProjectSettings(stateDir, projectSlug).skillPacks;
  const context = { stateDir, projectRoot: root, userHome, configuredPacks, contractSkills: contract?.skills };
  return { ...context, contract, skills: resolveRoleSkillsForProject({ ...context, role: "peer" }) };
}

// ---- the PASEO_FACTORY_* env channel -------------------------------------------------------

/**
 * The env vars one role's shells carry (the session_open channel — re-applied
 * on every launch). Since v0.0.16 (ADR 0011) this is also the provisioning
 * seam for the role's isolated Pi harness home: the call materializes
 * shared role home (or Task Peer home beneath its Project) on demand (idempotently — the provisioner's
 * law) and returns it as `PI_CODING_AGENT_DIR`, so every pi-lane seat and
 * working agent runs inside the clean room instead of the operator's global
 * `~/.pi/agent`. `userHome` overrides the operator home the shared-state
 * symlinks point back at (default `<homedir()>`; hermetic tests pass a fake).
 */
export function factoryEnvFor(
  role: RoleName,
  input: { stateDir: string; project: ProjectIdentity; task?: string; correlationId?: string; userHome?: string; environment?: Record<string, string>; provider?: string },
): Record<string, string> {
  ensureFactoryBinScripts(input.stateDir);
  const environment = restoreLegacyUiEnvironment({ ...process.env, ...input.environment });
  const peerContext = role === "agent" ? peerSkillContext(input.stateDir, input.project.slug, input.task, input.userHome, input.project.root) : undefined;
  const roleHome = provisionPiAgentHome({
    stateDir: input.stateDir,
    role,
    ...(peerContext ? {
      project: { root: peerContext.projectRoot ?? input.project.root, slug: input.project.slug },
      task: input.task, configuredPacks: peerContext.configuredPacks, contractSkills: peerContext.contractSkills,
    } : {}),
    sourceAgentDir: join(input.userHome ?? homedir(), ".pi", "agent"),
    helperMcpSources: { userHome: input.userHome ?? homedir() },
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

// ---- Supervisor candidates (v0.6.1, ADR 0057 §5) ---------------------------------------------

/** The agent slice the Supervisor-candidate predicate reads — plain data, no SDK types. */
export interface SupervisorCandidateAgent {
  provider?: string | null;
  labels?: Record<string, string> | null;
  model?: string | null;
}

/**
 * Whether a live agent in the Project's workspace is a Supervisor candidate
 * (v0.6.1, ADR 0057 §5) — any ONE of three arms suffices:
 *
 *   1. it was started on the `factory-supervisor` role provider (the
 *      `Supervisor (Factory)` picker row);
 *   2. it carries `seat: supervisor` labels;
 *   3. it was opened from Paseo's own picker on the Supervisor lane's
 *      provider/model — family match, and model match when both are known.
 *
 * A Lead or Peer identity (by provider, seat label, or task label) is never a
 * candidate, whatever its provider family. The workspace fence itself is the
 * caller's law — this predicate answers identity only.
 */
export function isSupervisorCandidate(
  agent: SupervisorCandidateAgent,
  input: { stateDir: string; slug: string; providers?: readonly LaneThinkingCatalogEntry[] },
): boolean {
  const provider = typeof agent.provider === "string" ? agent.provider.trim() : "";
  const inferred = inferRoleFromProviderId(provider);
  if (inferred === "supervisor") return true; // arm 1
  if (inferred === "lead" || inferred === "agent") return false; // another seat's identity
  const labels = agent.labels ?? {};
  if (labels.seat === "supervisor") return true; // arm 2
  if (labels.seat === "lead" || labels.task !== undefined) return false; // a Lead or task-bound Peer
  // Arm 3 — the picker on the Supervisor lane's provider/model.
  const lane = resolveRoleLane(input.stateDir, input.slug, "supervisor");
  const normalizedLane = lane !== undefined ? normalizeLaneWithProviders(lane, input.providers) : undefined;
  const parsed = normalizedLane !== undefined ? parseLane(normalizedLane) : undefined;
  if (parsed === undefined || provider === "") return false;
  const familyOf = (value: string): string => value.split("/")[0]?.trim().toLowerCase() ?? "";
  if (familyOf(provider) !== familyOf(parsed.provider)) return false;
  // The model must match when it is knowable: from the daemon's model field, or
  // embedded in the provider id itself (`<family>/<model>` picker providers).
  const bare = (value: string): string => value.replace(/^[^/]+\//, "");
  const agentModel =
    typeof agent.model === "string" && agent.model.trim() !== ""
      ? agent.model
      : provider.includes("/")
        ? provider.slice(provider.indexOf("/") + 1)
        : undefined;
  if (agentModel !== undefined && bare(agentModel) !== bare(parsed.model)) return false;
  return true;
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
): string {
  const rawProvider = typeof provider === "string" ? provider.trim() : "";
  if (inferRoleFromProviderId(rawProvider) === undefined) return providerFamilyOf(rawProvider);
  const lane = resolveRoleLane(stateDir, projectSlug, role);
  const parsed = lane !== undefined ? parseLane(lane) : undefined;
  return parsed === undefined ? providerFamilyOf(rawProvider) : providerFamilyOf(parsed.provider);
}

/**
 * Returns true when a seat runs on Pi (`APPEND_SYSTEM.md` in shared `Pi harness home`),
 * so dynamic Project-gated Store Release laws/hints ride its `Seat kickoff packet`
 * without duplicating base laws on non-Pi seats (ADR 0071).
 */
export function isPiSeat(
  provider: string | null | undefined,
  role: SeatName,
  stateDir: string,
  projectSlug: string,
): boolean {
  const effectiveProvider =
    typeof provider === "string" && provider.trim() !== "" ? provider : FACTORY_SEAT_PROVIDER_IDS[role];
  return resolveEffectiveProviderFamily(effectiveProvider, role, stateDir, projectSlug) === "pi";
}

function buildPaseoFactoryBridgeServer(input: {
  bridgeBinPath: string;
  correlationId?: string;
  role: RoleName;
  stateDir: string;
  projectSlug: string;
  workspace: string;
  task?: string;
}) {
  const correlationId = typeof input.correlationId === "string" && input.correlationId.trim() !== "" ? input.correlationId.trim() : undefined;
  return {
    type: "stdio" as const,
    command: process.execPath,
    args: [
      input.bridgeBinPath,
      ...(correlationId !== undefined ? ["--correlation", correlationId] : []),
      "--role",
      input.role,
      "--state-dir",
      input.stateDir,
      "--project",
      input.projectSlug,
      "--workspace",
      input.workspace,
      ...(input.task !== undefined ? ["--task", input.task] : []),
    ],
    env: {
      // Paseo Desktop's process.execPath is an Electron helper binary —
      // without Node mode it aborts at startup and the MCP connection
      // fails on agent.create / agent.open (v0.0.27, ADR 0017 §2, problem 3).
      ELECTRON_RUN_AS_NODE: "1",
      ...(correlationId !== undefined ? { PASEO_FACTORY_CORRELATION: correlationId } : {}),
      PASEO_FACTORY_SEAT: input.role,
      PASEO_FACTORY_STATE_DIR: input.stateDir,
      PASEO_FACTORY_PROJECT: input.projectSlug,
    },
  };
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
    /**
     * Enables Paseo `>=0.17.1` per-session Antigravity MCP delivery (`config.mcpServers`)
     * and cleans stale global `mcp_config.json`; defaults to `false` (`<0.17.1` mode).
     */
    perSessionAgyMcp?: boolean;
    /**
     * Enables Paseo `>=0.17.1` live role-contract delivery via `agent.open.before`
     * `appendSystemPrompt` for non-Pi providers, omitting baked contracts and
     * `renderPeerSkillScope` from persisted `config.systemPrompt`.
     */
    liveRoleContract?: boolean;
  },
): T {
  const { role, stateDir, correlationId, projectSlug, task, userHome, agyPluginsDir } = input;
  const rawProvider = typeof config.provider === "string" ? config.provider.trim() : "";
  const providerFamily = input.providerFamily ?? providerFamilyOf(rawProvider);
  const isLiveContract = input.liveRoleContract === true && providerFamily !== "pi";

  const { bridgeBinPath } = ensureFactoryBinScripts(stateDir);
  const nextConfig: Record<string, unknown> = { ...config };
  const peerSkills = role === "agent" ? peerSkillContext(stateDir, projectSlug, task, userHome, config.cwd).skills : undefined;
  if (peerSkills && !isLiveContract) nextConfig.systemPrompt = `${config.systemPrompt ?? ""}\n\n${renderPeerSkillScope(peerSkills)}`.trim();
  // Never pass `labels` inside `config` to Paseo's strict `agent.create` validator
  delete nextConfig.labels;

  if (providerFamily === "antigravity" && input.perSessionAgyMcp !== true) {
    delete nextConfig.mcpServers;
    provisionAgyPlugin({ stateDir, userHome, agyPluginsDir });
  } else {
    if (providerFamily === "antigravity") {
      provisionAgyPlugin({ stateDir, userHome, agyPluginsDir, perSessionMcp: true });
    }
    const existingMcp = resolveRoleScopedMcpServers({ stateDir, userHome, role, provider: providerFamily });
    const bridgeServer = buildPaseoFactoryBridgeServer({
      bridgeBinPath,
      correlationId,
      role,
      stateDir,
      projectSlug,
      workspace: config.cwd,
      ...(task !== undefined ? { task } : {}),
    });
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

  const existingProviderOpts = isRecord(config.providerOptions) ? config.providerOptions : {};
  const existingFeatures = isRecord(config.featureValues) ? config.featureValues : {};
  const requestedAutoAccept = existingProviderOpts.auto_accept ?? existingFeatures.auto_accept;

  if (providerFamily === "opencode") {
    const existingPerm = isRecord(existingProviderOpts.permission) ? existingProviderOpts.permission : {};
    if (role === "supervisor" || role === "lead") {
      // Preserve the user's `Auto-accept` UI toggle (defaulting to true) while
      // setting `toolPolicy: { preapproved: [] }` so OpenCodeV2Session routes
      // every permission request through `choke.onPermissionAsked` instead of
      // bypassing the choke when `auto_accept` is true.
      nextConfig.featureValues = {
        ...existingFeatures,
        auto_accept: typeof requestedAutoAccept === "boolean" ? requestedAutoAccept : true,
      };
      nextConfig.toolPolicy = { preapproved: [] };
      nextConfig.modeId = "build";
      const skillPerm = role === 'supervisor' ? { '*': 'allow' } : { '*': 'deny', ...Object.fromEntries(SLP_ROLE_SKILLS.lead.map(skill => [skill, 'allow'])) };
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
        auto_accept: typeof requestedAutoAccept === "boolean" ? requestedAutoAccept : true,
      };
      nextConfig.toolPolicy = { preapproved: [] };
      nextConfig.providerOptions = {
        ...existingProviderOpts,
        permission: {
          ...existingPerm,
          task: "deny",
          skill: { "*": "deny", ...Object.fromEntries((peerSkills ?? []).map(skill => [skill, "allow"])) },
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
  } else if (providerFamily === "omp") {
    if (role === "supervisor" || role === "lead") {
      nextConfig.modeId = "write";
    }
  } else if (providerFamily === "pi" || providerFamily === "antigravity") {
    delete nextConfig.modeId;
  }

  // 0.15+ folds legacy features into options, with options winning conflicts.
  // Keep the legacy field for 0.13–0.14 hosts, and explicitly publish seat
  // overrides in both fields so modern launches never depend on that fold.
  const features = isRecord(nextConfig.featureValues) ? nextConfig.featureValues : {};
  const options = isRecord(nextConfig.providerOptions) ? nextConfig.providerOptions : {};
  const seatAutoAccept =
    (providerFamily === "opencode" && (role === "supervisor" || role === "lead" || role === "agent")) ||
    (providerFamily === "copilot" && (role === "supervisor" || role === "lead"));
  if (seatAutoAccept) {
    nextConfig.providerOptions = {
      ...options,
      auto_accept: features.auto_accept,
    };
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

export interface InjectRoleOnCreateOptions {
  /**
   * Enables Paseo `>=0.17.1` per-session Antigravity MCP delivery (`config.mcpServers`)
   * and cleans stale global `mcp_config.json`; defaults to `false` (`<0.17.1` mode).
   */
  perSessionAgyMcp?: boolean;
  /**
   * Enables Paseo `>=0.17.1` live role-contract delivery via `agent.open.before`
   * `appendSystemPrompt` for non-Pi providers; defaults to `false` (`<0.17.1` mode).
   */
  liveRoleContract?: boolean;
  agyPluginsDir?: string;
}

function buildCreateEnv(
  baseEnv: Record<string, string> | undefined,
  factoryEnv: Record<string, string>,
  isLiveContract: boolean,
): Record<string, string> {
  const nextEnv: Record<string, string> = {
    ...(baseEnv ?? {}),
    ...factoryEnv,
  };
  if (isLiveContract) {
    nextEnv.PASEO_FACTORY_CONTRACT_MODE = "live";
  } else {
    delete nextEnv.PASEO_FACTORY_CONTRACT_MODE;
  }
  return nextEnv;
}

/**
 * The additive `agent.create` injection (channel 1 + the first-launch env +
 * Layer-1 provider fence + `Correlation token` issuance):
 * a seat-titled create or a managed-worktree create gets its role contract
 * APPENDED to `config.systemPrompt` (idempotent — the footer is the sentinel),
 * a `cor_<uuid>` token issued in `CorrelationRegistry`, `paseo_factory` MCP
 * wired (except on `<0.17.1` `antigravity`), provider-specific execution fences applied,
 * and its `PASEO_FACTORY_*` env seeded.
 */
export function injectRoleOnCreate<R extends AgentCreateRequest>(
  request: R,
  stateDir: string,
  userHome?: string,
  options?: InjectRoleOnCreateOptions,
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
  const hasPrompt = (request.config.systemPrompt ?? "").includes(FOOTER_MARK);
  const hasLiveContract = options?.liveRoleContract === true && request.env?.PASEO_FACTORY_CONTRACT_MODE === "live";
  const bound = request.env?.PASEO_FACTORY_CORRELATION ? correlations.resolve(request.env.PASEO_FACTORY_CORRELATION) : undefined;
  const alreadyProvisioned = (projectSlug: string, task?: string) =>
    (hasPrompt || hasLiveContract) && bound !== undefined && bound.role === role && bound.projectSlug === projectSlug &&
    bound.projectSlug === request.env?.PASEO_FACTORY_PROJECT && bound.task === task;


  const finalizeRoleCreate = (target: {
    role: RoleName;
    envProject: ProjectIdentity;
    promptProject: ProjectIdentity;
    title: string | null | undefined;
    task?: string;
    factoryCmd?: string;
  }): R => {
    const issued = correlations.issue({
      role: target.role,
      projectSlug: target.promptProject.slug,
      projectRoot: target.envProject.root !== "" ? target.envProject.root : request.config.cwd,
      ...(target.task !== undefined ? { task: target.task } : {}),
    });
    // Resolve `factory-*` role providers through Lane config so Layer-1 fences
    // target the underlying harness rather than no-oping on `factory-*`.
    const effectiveFamily = resolveEffectiveProviderFamily(
      request.config.provider,
      target.role,
      stateDir,
      target.promptProject.slug,
    );
    const isLiveContract = options?.liveRoleContract === true && effectiveFamily !== "pi";
    const storeRelease =
      target.role === "supervisor" || target.role === "lead"
        ? resolveStoreReleaseCapability({
            projectRoot: target.promptProject.root,
            stateDir,
            projectSlug: target.promptProject.slug,
          })
        : undefined;
    const agentDisposition =
      !isLiveContract && target.role === "agent"
        ? (peerSkillContext(
            stateDir,
            target.promptProject.slug,
            target.task,
            userHome,
            target.promptProject.root,
          ).contract?.disposition ?? "engineer")
        : undefined;
    const fencedConfig = applyProviderExecutionFence(
      {
        ...request.config,
        title: target.title,
        ...(isLiveContract
          ? {}
          : {
              systemPrompt: appendContract(
                request.config.systemPrompt,
                buildRoleKickoffPrompt(target.role, {
                  ...(target.factoryCmd !== undefined ? { factoryCmd: target.factoryCmd } : {}),
                  ...(target.task !== undefined ? { task: target.task } : {}),
                  project: target.promptProject,
                  helperMcps: discoverHelperMcps({ stateDir, userHome }).servers,
                  ...(storeRelease !== undefined ? { storeRelease } : {}),
                  ...(agentDisposition !== undefined ? { disposition: agentDisposition } : {}),
                }),
              ),
            }),
      },
      {
        role: target.role,
        stateDir,
        correlationId: issued.correlationId,
        projectSlug: target.promptProject.slug,
        ...(target.task !== undefined ? { task: target.task } : {}),
        userHome,
        ...(options?.agyPluginsDir !== undefined ? { agyPluginsDir: options.agyPluginsDir } : {}),
        ...(options?.perSessionAgyMcp !== undefined ? { perSessionAgyMcp: options.perSessionAgyMcp } : {}),
        ...(isLiveContract ? { liveRoleContract: true } : {}),
        providerFamily: effectiveFamily,
      },
    );
    const nextFactoryEnv = factoryEnvFor(target.role, {
      stateDir,
      project: target.envProject,
      ...(target.task !== undefined ? { task: target.task } : {}),
      correlationId: issued.correlationId,
      userHome,
      provider: request.config.provider,
      environment: request.env,
    });
    return sanitizeAgentCreateHookResult({
      config: fencedConfig,
      env: buildCreateEnv(request.env, nextFactoryEnv, isLiveContract),
    }) as R;
  };

  // A managed Task worktree keeps its task-bound path — the correlation and
  // the contract both carry the task id — whatever named the role.
  if (role === undefined || role === "agent") {
    const worktree = parseTaskWorktreePath(stateDir, request.config.cwd);
    if (worktree !== null) {
      const reg = listProjectRegistrations(stateDir).find((r) => r.slug === worktree.slug);
      const projectRoot = reg?.root ?? "";
      if (alreadyProvisioned(worktree.slug, worktree.task)) return undefined;
      return finalizeRoleCreate({
        role: "agent",
        envProject: { root: projectRoot, slug: worktree.slug },
        promptProject: { root: request.config.cwd, slug: worktree.slug },
        // The Agent tab inside the Task worktree Workspace reads `Peer · <Task>`
        // (ADR 0017 §2) — never the bare task id or the raw spawn prompt.
        title: formatPeerAgentTitle(worktree.task),
        task: worktree.task,
      });
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
  if (alreadyProvisioned(projectIdentity.slug)) return undefined;
  return finalizeRoleCreate({
    role,
    envProject: projectIdentity,
    promptProject: projectIdentity,
    // The Agent tab inside the main Workspace reads the clean seat title
    // (ADR 0017 §2) — `Supervisor` / `Lead`, never the raw first message.
    title: role === "supervisor" || role === "lead" ? SEAT_TITLES[role] : request.config.title,
    factoryCmd: "factory",
  });
}

const ROLE_CONTEXT_MARK = "<!-- paseo-factory injected role contract -->";
function appendContract(existing: string | undefined, contract: string): string {
  let prefix = existing ?? "";
  const markers = [ROLE_CONTEXT_MARK];
  // Compatibility with prompts injected before the explicit start marker.
  if (prefix.includes(FOOTER_MARK)) markers.push(
    "## 1. Role & Core Goal\n",
    "You are the Supervisor seat of the paseo-factory",
    "You are the Lead seat of the paseo-factory",
    "You are a working Agent of the paseo-factory",
    "You are a Peer of the paseo-factory",
    "You are an independent Peer",
    "You are an independent engineer",
    "You are an independent scout",
    "You are an independent architect",
    "You are an independent reviewer",
  );
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

export interface InjectSessionEnvOptions {
  /**
   * Enables Paseo `>=0.17.1` per-session Antigravity MCP delivery and legacy
   * resume backfill (`paseo_factory` + Peer Helper MCPs) on interactive opens;
   * defaults to `false` (`<0.17.1` fail-closed mode).
   */
  perSessionAgyMcp?: boolean;
  /**
   * Enables Paseo `>=0.17.1` ephemeral `appendSystemPrompt` live role-contract
   * delivery on interactive opens when `PASEO_FACTORY_CONTRACT_MODE === "live"`;
   * defaults to `false` (`<0.17.1` fail-closed mode).
   */
  liveRoleContract?: boolean;
}

function resolveSessionMcpServers(input: {
  requestMcpServers: unknown;
  role: RoleName;
  effectiveFamily: string;
  effectiveContractMode: string | undefined;
  purpose: string | null | undefined;
  perSessionAgyMcp: boolean;
  stateDir: string;
  userHome?: string;
  projectSlug: string;
  workspace: string;
  task?: string;
  correlationId?: string;
}): Record<string, unknown> | undefined {
  const hasRequestMcp = isRecord(input.requestMcpServers);
  const nextMcp: Record<string, unknown> = isRecord(input.requestMcpServers) ? { ...input.requestMcpServers } : {};
  let changed = false;

  // Defensive guard if a host exposes Paseo's built-in `paseo` server on
  // `agent.open.before`; Factory seats forbid raw Paseo agent tools and
  // Antigravity's eager MCP tool budget cannot absorb Paseo's 65-tool server.
  if (hasRequestMcp && "paseo" in nextMcp) {
    delete nextMcp.paseo;
    changed = true;
  }

  // Legacy pre-0.17.1 Antigravity seats (`effectiveContractMode !== "live"`)
  // had `config.mcpServers` stripped at create time; backfill per-session
  // `paseo_factory` (and Helper MCPs for Peer) on interactive opens once global
  // `mcp_config.json` is retired. Seats created on 0.17.1+ (`live`) already
  // persist `paseo_factory` in saved `config.mcpServers` — returning the same
  // server name from `agent.open.before` makes Paseo 0.17.1 fail open/reload
  // with "collides with agent saved configuration".
  if (
    input.perSessionAgyMcp &&
    input.purpose === "interactive" &&
    input.effectiveFamily === "antigravity" &&
    input.effectiveContractMode !== "live"
  ) {
    if (!isRecord(nextMcp.paseo_factory)) {
      const { bridgeBinPath } = ensureFactoryBinScripts(input.stateDir);
      nextMcp.paseo_factory = buildPaseoFactoryBridgeServer({
        bridgeBinPath,
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        role: input.role,
        stateDir: input.stateDir,
        projectSlug: input.projectSlug,
        workspace: input.workspace,
        ...(input.task !== undefined ? { task: input.task } : {}),
      });
      changed = true;
    }
    if (input.role === "agent") {
      const helperMcps = resolveRoleScopedMcpServers({
        stateDir: input.stateDir,
        userHome: input.userHome,
        role: "agent",
        provider: "antigravity",
      });
      for (const [name, serverConfig] of Object.entries(helperMcps)) {
        if (name !== "paseo" && nextMcp[name] === undefined) {
          nextMcp[name] = serverConfig;
          changed = true;
        }
      }
    }
  }

  return changed ? nextMcp : undefined;
}

function renderLiveRoleContract(
  role: RoleName,
  input: { stateDir: string; project: ProjectIdentity; task?: string; userHome?: string },
): string {
  const helperMcps = discoverHelperMcps({ stateDir: input.stateDir, userHome: input.userHome }).servers;
  const storeRelease =
    role === "supervisor" || role === "lead"
      ? resolveStoreReleaseCapability({
          projectRoot: input.project.root,
          stateDir: input.stateDir,
          projectSlug: input.project.slug,
        })
      : undefined;
  const peerContext =
    role === "agent"
      ? peerSkillContext(input.stateDir, input.project.slug, input.task, input.userHome, input.project.root)
      : undefined;
  const disposition = peerContext !== undefined ? (peerContext.contract?.disposition ?? "engineer") : undefined;
  const basePrompt = buildRoleKickoffPrompt(role, {
    factoryCmd: "factory",
    project: input.project,
    ...(input.task !== undefined ? { task: input.task } : {}),
    helperMcps,
    ...(storeRelease !== undefined ? { storeRelease } : {}),
    ...(disposition !== undefined ? { disposition } : {}),
  });
  if (peerContext === undefined) return basePrompt;
  return `${basePrompt}\n\n${renderPeerSkillScope(peerContext.skills)}`;
}

/**
 * The `agent.session_open` injection (channel 3): every launch of a seat or
 * working-agent shell re-carries its `PASEO_FACTORY_*` identity, associates
 * the live `agentId` with its `Correlation token` in `<stateDir>/correlations.json`,
 * binds a provider- or env-recognized `supervisor` / `lead` session to its Project's
 * `project.json` (ADR 0017 §2), and — on Paseo `>=0.17.1` live-contract sessions —
 * delivers fresh non-Pi role contracts via ephemeral `appendSystemPrompt` (ADR 0067).
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
    /** Ephemeral instructions appended on Paseo `>=0.17.1` opens; omitted on `<0.17.1`. */
    appendSystemPrompt?: string[];
    /** Per-session MCP servers passed by Paseo before session/new or session/load. */
    mcpServers?: Record<string, unknown>;
  },
>(
  request: R,
  stateDir: string,
  userHome?: string,
  options?: InjectSessionEnvOptions,
): (R & { appendSystemPrompt?: string[] }) | undefined {
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

  const finalizeSessionOpen = (resolved: {
    role: RoleName;
    envProject: ProjectIdentity;
    promptProject: ProjectIdentity;
    task?: string;
    correlationId?: string;
  }): R & { appendSystemPrompt?: string[] } => {
    const nextEnv: Record<string, string> = {
      ...restoreLegacyUiEnvironment(request.env ?? {}),
      ...factoryEnvFor(resolved.role, {
        stateDir,
        project: resolved.envProject,
        ...(resolved.task !== undefined ? { task: resolved.task } : {}),
        ...(resolved.correlationId !== undefined ? { correlationId: resolved.correlationId } : {}),
        userHome,
        provider: request.provider ?? undefined,
        environment: request.env,
      }),
    };
    const effectiveContractMode =
      nextEnv.PASEO_FACTORY_CONTRACT_MODE ?? request.config?.env?.PASEO_FACTORY_CONTRACT_MODE;
    const effectiveFamily = resolveEffectiveProviderFamily(
      request.provider ?? undefined,
      resolved.role,
      stateDir,
      resolved.promptProject.slug,
    );
    const workspaceForMcp =
      typeof request.cwd === "string" && request.cwd.trim() !== ""
        ? request.cwd
        : resolved.promptProject.root || resolved.envProject.root;
    const nextMcpServers = resolveSessionMcpServers({
      requestMcpServers: request.mcpServers,
      role: resolved.role,
      effectiveFamily,
      effectiveContractMode,
      purpose: request.purpose,
      perSessionAgyMcp: options?.perSessionAgyMcp === true,
      stateDir,
      userHome,
      projectSlug: resolved.promptProject.slug,
      workspace: workspaceForMcp,
      ...(resolved.task !== undefined ? { task: resolved.task } : {}),
      ...(nextEnv.PASEO_FACTORY_CORRELATION !== undefined
        ? { correlationId: nextEnv.PASEO_FACTORY_CORRELATION }
        : resolved.correlationId !== undefined
          ? { correlationId: resolved.correlationId }
          : {}),
    });
    if (
      options?.liveRoleContract !== true ||
      request.purpose !== "interactive" ||
      effectiveContractMode !== "live" ||
      effectiveFamily === "pi"
    ) {
      if (options?.liveRoleContract !== true || request.purpose === "history") {
        const { appendSystemPrompt: _ignored, ...rest } = request;
        return {
          ...rest,
          env: nextEnv,
          ...(nextMcpServers !== undefined ? { mcpServers: nextMcpServers } : {}),
        } as R & { appendSystemPrompt?: string[] };
      }
      return {
        ...request,
        env: nextEnv,
        ...(nextMcpServers !== undefined ? { mcpServers: nextMcpServers } : {}),
      } as R & { appendSystemPrompt?: string[] };
    }
    const liveContract = renderLiveRoleContract(resolved.role, {
      stateDir,
      project: resolved.promptProject,
      ...(resolved.task !== undefined ? { task: resolved.task } : {}),
      userHome,
    });
    const existingAppend = Array.isArray(request.appendSystemPrompt) ? request.appendSystemPrompt : [];
    const appendSystemPrompt = existingAppend.includes(liveContract)
      ? existingAppend
      : [...existingAppend, liveContract];
    return {
      ...request,
      env: nextEnv,
      ...(nextMcpServers !== undefined ? { mcpServers: nextMcpServers } : {}),
      appendSystemPrompt,
    } as R & { appendSystemPrompt?: string[] };
  };

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
      const promptRoot =
        associated.projectRoot || readProjectRegistration(stateDir, associated.projectSlug)?.root || request.cwd;
      return finalizeSessionOpen({
        role: associated.role,
        envProject: { root: associated.projectRoot, slug: associated.projectSlug },
        promptProject: { root: promptRoot, slug: associated.projectSlug },
        ...(associated.task !== undefined ? { task: associated.task } : {}),
        correlationId: associated.correlationId,
      });
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
    const promptRoot = readProjectRegistration(stateDir, worktree.slug)?.root ?? request.cwd;
    return finalizeSessionOpen({
      role: "agent",
      envProject: { root: "", slug: worktree.slug },
      promptProject: { root: promptRoot, slug: worktree.slug },
      task: worktree.task,
      ...(record?.correlationId !== undefined ? { correlationId: record.correlationId } : {}),
    });
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
    return finalizeSessionOpen({
      role: seat,
      envProject: registration,
      promptProject: registration,
      ...(record?.correlationId !== undefined ? { correlationId: record.correlationId } : {}),
    });
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
      return finalizeSessionOpen({
        role: identitySeat,
        envProject: project,
        promptProject: project,
        ...(record?.correlationId !== undefined ? { correlationId: record.correlationId } : {}),
      });
    }
  }
  return undefined;
}

/** Async pre-create sync keeps filesystem provisioning synchronous and never starts stdio helpers. */
export async function syncPeerHelpersBeforeCreate(request: AgentCreateRequest, stateDir: string, userHome?: string): Promise<void> {
  const labels = (request as { labels?: Record<string, string> }).labels ?? (request.config as { labels?: Record<string, string> }).labels;
  const role = inferRoleFromProviderId(request.config.provider) ?? parseRoleName(request.env?.PASEO_FACTORY_SEAT) ?? inferRoleSeatFromTitleOrLabels(request.config.title, labels);
  if (role === "agent" || (role === undefined && parseTaskWorktreePath(stateDir, request.config.cwd))) {
    await syncHelperMcps({ stateDir, userHome });
  }
}
