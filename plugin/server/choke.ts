/**
 * The choke (v0.0.4) — factory-side policy over every permit ask from a
 * contracted agent, plus the git shim's ledger ingestion.
 *
 * Mediation is listen + respond (mechanism facts, scout 2026-10-08, grade A):
 * there is no synchronous permission before-hook, so the plugin subscribes to
 * `agent.permission_requested` — which carries the FULL request including
 * `detail.command`, the exact shell line, which `permit ls --json` strips —
 * and answers through `PaseoAgentHandle.respondToPermission()`. A pending ask
 * parks the agent, so async answering is sound.
 *
 * "Contracted" is mechanical (map decision 5): the asking agent's cwd sits
 * inside a live Contract's workspace. Asks from anywhere else are not the
 * factory's business and get no answer from us — the daemon's own operator
 * flow handles them. Paseo persists permission decisions nowhere, so every
 * judged ask becomes one ledger line here first, then the response.
 *
 * The same judge serves the bypass battery through the spool's synthetic `ask`
 * request (the smoke-harness channel: the choke does not care who attempts the
 * escape) — that path answers in the spool reply instead of
 * `respondToPermission`, because there is no daemon ask to answer.
 */
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginBeforeRequests, PluginLifecycleEvents } from "@getpaseo/plugin/server";

type AgentPermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"];
type AgentPermissionResponse = PluginLifecycleEvents["agent.permission_resolved"]["resolution"];
type AgentSessionConfig = PluginBeforeRequests["agent.create"]["config"];
import type { Factory } from "./core/factory.ts";
import type { ContractSet } from "./core/events.ts";
import { FactoryError } from "./core/errors.ts";
import {
  SEAT_MEMORY_WHITELIST,
  SEAT_WRITE_FENCE_MESSAGE,
  extractWriteTargets,
  isForbiddenPaseoToolName,
  isPaseoFactoryToolName,
  isProcessKillAgainstFactory,
  isProtectedFactoryStatePath,
  isStrictlyLayer3ShimmedCommand,
  isSeatMemoryPathAllowed,
  isSeatMemoryRelativePathAllowed,
  judgeFilePath,
  judgeSeatFilePath,
  judgeSeatShellCommand,
  judgeShellCommand,
  shellTokens,
  writableRootsFor,
} from "./core/choke.ts";
import type { ChokeDecision, MemoryFence } from "./core/choke.ts";
import { listProjectRegistrations } from "./projects.ts";
import { readCorrelations } from "./correlations.ts";
import { loadLanes, parseLane } from "./core/lanes.ts";
import { resolveOrBootstrapProject } from "./core/project.ts";
import { SEAT_TITLES, inferRoleFromProviderId, resolveEffectiveProviderFamily } from "./roles.ts";
import type { SeatName } from "./roles.ts";
import { parseTaskWorktreePath } from "../shared/worktree-shape.mjs";
import type { AskRequest, SpoolReply } from "./spool.ts";

export {
  SEAT_MEMORY_WHITELIST,
  SEAT_WRITE_FENCE_MESSAGE,
  extractWriteTargets,
  isForbiddenPaseoToolName,
  isPaseoFactoryToolName,
  isProcessKillAgainstFactory,
  isProtectedFactoryStatePath,
  isSeatMemoryPathAllowed,
  isSeatMemoryRelativePathAllowed,
  judgeSeatFilePath,
  judgeSeatShellCommand,
};

/**
 * The choke-side name for the deterministic seat recognition (v0.0.27, ADR
 * 0017 §2) — a thin re-export of `roles.ts`'s `inferRoleFromProviderId`, the
 * single plugin-side mapping (`factory-supervisor` → `supervisor`,
 * `factory-lead` → `lead`, `factory-peer` / `factory-agent` → `agent`).
 */
export { inferRoleFromProviderId as inferSeatFromProviderId } from "./roles.ts";

/**
 * The structural slice of PaseoApi the choke needs — tests pass a fake shaped
 * exactly like the real call path (`agents.ref(id).respondToPermission`).
 */
export interface PaseoResponderApi {
  agents: {
    ref(id: string): {
      respondToPermission(options: { requestId: string; response: AgentPermissionResponse }): Promise<void>;
    };
  };
}

/** The lifecycle event payload, structural so hermetic tests can build one. */
export interface PermissionAskedEvent {
  agent: {
    id: string;
    cwd: string;
    /** The session's provider id — `factory-supervisor` / `factory-lead` name a seat outright (v0.0.27, ADR 0017 §2). */
    provider?: string | null;
    title?: string | null;
    labels?: Record<string, string>;
  };
  request: AgentPermissionRequest;
}

/** The claude catalog's "default" mode, labeled "Always Ask" (scout §2, grade A). */
export const PINNED_MODE_ID = "default";

const WORKTREE_PATH_PATTERN = /\/projects\/[^/]+\/worktrees\/[^/]+(?:\/|$)/;

/**
 * Whether `cwd` belongs to a contracted task Agent (as opposed to `<project-root>`
 * when a task executes inside a managed Task worktree or when a Seat is seated there).
 */
export function isContractedAgentCwd(factory: Factory, cwd: string | undefined): boolean {
  if (typeof cwd !== "string" || cwd === "") return false;
  let contract: ContractSet | undefined;
  try {
    contract = factory.liveContractFor(cwd);
  } catch {
    return false;
  }
  if (contract === undefined) return false;
  const worktree = factory.worktreeFor(contract.task);
  if (worktree !== undefined && (cwd === worktree || cwd.startsWith(`${worktree}/`))) {
    return true;
  }
  if (parseTaskWorktreePath(factory.stateDir, cwd) !== null || WORKTREE_PATH_PATTERN.test(cwd)) {
    return true;
  }
  if (worktree !== undefined) {
    // The contract executes inside its Task worktree, not at <project-root>.
    return false;
  }
  for (const reg of listProjectRegistrations(factory.stateDir)) {
    if ((reg.supervisor !== undefined || reg.lead !== undefined || (reg.dispatchers?.length ?? 0) > 0) && cwd === reg.root) {
      return false;
    }
  }
  return true;
}

export const isContractedWorkerCwd = isContractedAgentCwd;

const KNOWN_PROVIDER_IDS = new Set([
  "claude",
  "claude-code",
  "codex",
  "copilot",
  "opencode",
  "pi",
  "omp",
  "mock",
  "mock-slow",
  "gemini",
  "cursor",
  "acp",
]);

export interface ProviderCatalogModel {
  id: string;
  thinkingOptions?: readonly { id: string; label?: string | null }[] | null;
}

export interface ProviderCatalogEntry {
  id?: string;
  provider?: string;
  models?: readonly ProviderCatalogModel[] | null;
}

export interface NormalizeCreateOptions {
  stateDir?: string;
  providers?: readonly ProviderCatalogEntry[];
}

function findCatalogModelMeta(
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

function inferReservedSeatFromTitle(title: string | null | undefined): SeatName | undefined {
  if (typeof title !== "string") return undefined;
  const trimmed = title.trim();
  if (
    trimmed === "Supervisor" ||
    trimmed === SEAT_TITLES.supervisor ||
    trimmed.startsWith("Supervisor — ") ||
    trimmed.startsWith("Supervisor - ") ||
    trimmed.startsWith("Supervisor (")
  ) {
    return "supervisor";
  }
  if (
    trimmed === "Lead" ||
    trimmed === SEAT_TITLES.lead ||
    trimmed.startsWith("Lead — ") ||
    trimmed.startsWith("Lead - ") ||
    trimmed.startsWith("Lead (")
  ) {
    return "lead";
  }
  return undefined;
}

/**
 * Resolves the Project a factory seat provider create stands in (v0.0.38,
 * ADR 0026 §1): the registered root binding first (a registered Project may
 * not be a Git checkout yet), then `resolveOrBootstrapProject` — a Git
 * repository resolves as-is; a greenfield folder bootstraps exactly the way
 * `injectRoleOnCreate`'s own seat path would a moment later. `undefined`
 * means the cwd names no Project — never a guess.
 */
function resolveFactorySeatProject(
  stateDir: string,
  cwd: string,
): { slug: string; root: string } | undefined {
  const registered = listProjectRegistrations(stateDir).find((reg) => reg.root === cwd);
  if (registered !== undefined) return { slug: registered.slug, root: registered.root };
  const resolved = resolveOrBootstrapProject(cwd, { stateDir });
  return resolved.ok ? { slug: resolved.slug, root: resolved.root } : undefined;
}

function normalizeBareProviderModel(rawProvider: string, providers?: readonly ProviderCatalogEntry[]): string {
  const trimmed = rawProvider.trim();
  if (trimmed === "" || trimmed.includes("/")) return rawProvider;
  const colon = trimmed.lastIndexOf(":");
  const baseModel = colon > 0 ? trimmed.slice(0, colon) : trimmed;
  const suffix = colon > 0 ? trimmed.slice(colon) : "";
  const lower = baseModel.toLowerCase();
  if (KNOWN_PROVIDER_IDS.has(lower)) return rawProvider;

  if (providers !== undefined && providers.length > 0) {
    const matches: { providerId: string; modelId: string }[] = [];
    for (const entry of providers) {
      const providerId = entry.provider ?? entry.id ?? "";
      if (providerId === "") continue;
      for (const m of entry.models ?? []) {
        if (m.id === baseModel || m.id.endsWith(`/${baseModel}`)) {
          matches.push({ providerId, modelId: m.id });
          break;
        }
      }
    }
    if (matches.length === 1) {
      const { providerId, modelId } = matches[0]!;
      if (providerId === "opencode" && !modelId.includes("/")) {
        return `opencode/opencode/${modelId}${suffix}`;
      }
      return `${providerId}/${modelId}${suffix}`;
    }
    if (matches.length > 1) {
      return rawProvider;
    }
  }

  if (lower.startsWith("claude-") || lower === "sonnet" || lower === "opus" || lower === "haiku") {
    return `claude-code/${baseModel}${suffix}`;
  }
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) {
    return `codex/${baseModel}${suffix}`;
  }
  if (
    lower.startsWith("nemotron-") ||
    lower.startsWith("qwen") ||
    lower.startsWith("deepseek") ||
    lower.startsWith("glm") ||
    lower.startsWith("minimax") ||
    lower.startsWith("kimi") ||
    lower.startsWith("llama")
  ) {
    return `opencode/opencode/${baseModel}${suffix}`;
  }
  return rawProvider;
}

/**
 * Normalizes `agent.create` requests before the daemon sees them (v0.0.24, ADR 0015 §4/§5):
 * 1. If `config.provider` is a bare model ID with no `"/"` (e.g. `"nemotron-3.5-super-vl-free"`),
 *    prefixes the canonical `<provider>/` so MCP `create_agent` calls do not crash.
 * 2. Strips unsupported `:thinking` suffixes and `thinkingOptionId` when `providers`
 *    advertises `thinkingOptions: []` or options excluding the requested variant.
 * 3. If `labels.seat` is absent and `config.provider` is a factory role
 *    provider (`factory-supervisor` / `factory-lead`, v0.0.27 ADR 0017 §2) or
 *    `config.title` uses a reserved seat title (`"Supervisor — ..."`,
 *    `"Lead — ..."`, `"Supervisor"`, `"Lead"`) at a registered
 *    `<project-root>`, attaches `{ seat: "supervisor" | "lead", project: reg.slug }`.
 *    Factory role provider ids are canonical — never prefixed as bare models.
 * 4. The per-Project seat provider rewrite (v0.0.38, ADR 0026 §1): when
 *    `config.provider` is `factory-supervisor` / `factory-lead` and
 *    `config.cwd` resolves to a Project (registered or bootstrappable), the
 *    request is rewritten onto THAT Project's lane — `config.provider`
 *    becomes the Project's `<provider>/<model>`, `thinkingOptionId` is set
 *    from the lane's thinking level when the advertised catalog supports it
 *    (stripped otherwise), and `{ seat, project: slug }` labels attach — so
 *    the daemon-global role providers never steer another Project's seat.
 */
export function normalizeAgentCreateRequest<
  T extends {
    config: { provider?: string; thinkingOptionId?: string; cwd?: string; title?: string | null; labels?: Record<string, string> };
    labels?: Record<string, string>;
  },
>(
  request: T,
  stateDirOrOptions?: string | NormalizeCreateOptions,
  providers?: readonly ProviderCatalogEntry[],
): T & { labels?: Record<string, string>; config: T["config"] & { labels?: Record<string, string>; thinkingOptionId?: string } };
export function normalizeAgentCreateRequest<
  T extends { provider?: string; thinkingOptionId?: string; cwd?: string; title?: string | null; labels?: Record<string, string> },
>(
  config: T,
  stateDirOrOptions?: string | NormalizeCreateOptions,
  providers?: readonly ProviderCatalogEntry[],
): T & { labels?: Record<string, string> };
export function normalizeAgentCreateRequest(
  requestOrConfig: Record<string, unknown>,
  stateDirOrOptions?: string | NormalizeCreateOptions,
  providersArg?: readonly ProviderCatalogEntry[],
): Record<string, unknown> {
  const stateDir = typeof stateDirOrOptions === "string" ? stateDirOrOptions : stateDirOrOptions?.stateDir;
  const providers =
    providersArg ?? (typeof stateDirOrOptions === "object" && stateDirOrOptions !== null ? stateDirOrOptions.providers : undefined);

  const hasNestedConfig =
    "config" in requestOrConfig && typeof requestOrConfig.config === "object" && requestOrConfig.config !== null;
  const config = (hasNestedConfig ? requestOrConfig.config : requestOrConfig) as {
    provider?: string;
    thinkingOptionId?: string;
    cwd?: string;
    title?: string | null;
    labels?: Record<string, string>;
  };
  const topLabels = hasNestedConfig
    ? (requestOrConfig.labels as Record<string, string> | undefined)
    : undefined;

  const rawProvider = typeof config.provider === "string" ? config.provider : "";
  // A native factory role provider id (v0.0.27, ADR 0017 §2) is canonical —
  // never a bare model to prefix — and is itself deterministic seat identity.
  const factoryProviderSeat = inferRoleFromProviderId(rawProvider);
  let normalizedProvider = factoryProviderSeat !== undefined ? rawProvider : normalizeBareProviderModel(rawProvider, providers);

  let stripThinkingOptionId = false;
  const parsedLane = parseLane(normalizedProvider);
  if (parsedLane !== undefined) {
    const meta = findCatalogModelMeta(parsedLane.provider, parsedLane.model, providers);
    const thinkingOptions = meta?.thinkingOptions;
    if (thinkingOptions !== undefined && thinkingOptions !== null) {
      if (
        parsedLane.thinking !== undefined &&
        (thinkingOptions.length === 0 || !thinkingOptions.some((o) => o.id === parsedLane.thinking))
      ) {
        normalizedProvider = `${parsedLane.provider}/${parsedLane.model}`;
      }
      const rawThinkingOptionId =
        typeof config.thinkingOptionId === "string" && config.thinkingOptionId !== "" ? config.thinkingOptionId : undefined;
      if (
        rawThinkingOptionId !== undefined &&
        (thinkingOptions.length === 0 || !thinkingOptions.some((o) => o.id === rawThinkingOptionId))
      ) {
        stripThinkingOptionId = true;
      }
    }
  }
  const providerChanged = normalizedProvider !== rawProvider;

  const existingSeat = config.labels?.seat ?? topLabels?.seat;
  // The provider id outranks the title guess (ADR 0017 §2): a
  // `factory-supervisor` / `factory-lead` create is a seat no matter what the
  // chat title says; `factory-peer` keeps the worker labels law untouched.
  const providerInferredSeat =
    factoryProviderSeat === "supervisor" || factoryProviderSeat === "lead" ? factoryProviderSeat : undefined;
  const inferredSeat = providerInferredSeat ?? inferReservedSeatFromTitle(config.title);
  let nextLabels: Record<string, string> | undefined;
  if (
    existingSeat === undefined &&
    inferredSeat !== undefined &&
    typeof config.cwd === "string" &&
    config.cwd !== "" &&
    typeof stateDir === "string" &&
    stateDir !== ""
  ) {
    const matchedReg = listProjectRegistrations(stateDir).find((reg) => reg.root === config.cwd);
    if (matchedReg !== undefined) {
      nextLabels = {
        ...(topLabels ?? {}),
        ...(config.labels ?? {}),
        seat: inferredSeat,
        project: matchedReg.slug,
      };
    }
  }

  // The per-Project provider + model rewrite (v0.0.38, ADR 0026 §1): a
  // `factory-supervisor` / `factory-lead` create inside a Project resolves
  // THAT Project's Lane config and rewrites the session onto the Project's
  // own runtime `provider` ID and `model` — so starting `Supervisor (Factory)`
  // in Project B always runs Project B's supervisor lane, never whatever
  // Project A last saved into the daemon-global role providers. Because
  // `@getpaseo/server`'s `AgentManager.createAgentInternal` passes `{ provider,
  // model }` already split into `before("agent.create")` and immediately calls
  // `this.requireEnabledProvider(storedConfig.provider)`, `provider` must be
  // the runtime Paseo provider ID alone (`claude-code` → `claude`, `agy` →
  // `antigravity` unless a custom `agy` provider is advertised) and `model`
  // must be `parsed.model`. The thinking level is set from the lane when the
  // advertised catalog supports it (or no catalog answered — the daemon
  // validates) and stripped otherwise; a stale `thinkingOptionId` that named
  // the role provider's model never survives the rewrite. An unresolvable cwd,
  // an unreadable Lane config, or an unparseable lane keeps the canonical role
  // provider id — never a guess.
  let seatRewrite:
    | { provider: string; model?: string; thinkingOptionId?: string; labels: Record<string, string>; slug: string }
    | undefined;
  if (
    providerInferredSeat !== undefined &&
    typeof config.cwd === "string" &&
    config.cwd !== "" &&
    typeof stateDir === "string" &&
    stateDir !== ""
  ) {
    const project = resolveFactorySeatProject(stateDir, config.cwd);
    if (project !== undefined) {
      const projectLanes = loadLanes(stateDir, project.slug);
      const lane = projectLanes.ok ? projectLanes.lanes[providerInferredSeat] : undefined;
      const parsed = lane !== undefined ? parseLane(lane) : undefined;
      const mergedLabels = { ...(topLabels ?? {}), ...(config.labels ?? {}), seat: providerInferredSeat, project: project.slug };
      if (parsed !== undefined) {
        const runtimeProvider =
          parsed.provider === "claude-code"
            ? "claude"
            : parsed.provider === "agy"
              ? providers?.some((entry) => entry.provider === "agy")
                ? "agy"
                : "antigravity"
              : parsed.provider;
        const thinkingOptions =
          findCatalogModelMeta(parsed.provider, parsed.model, providers)?.thinkingOptions ??
          findCatalogModelMeta(runtimeProvider, parsed.model, providers)?.thinkingOptions;
        const thinkingSupported =
          parsed.thinking !== undefined &&
          (thinkingOptions === undefined ||
            thinkingOptions === null ||
            (thinkingOptions.length > 0 && thinkingOptions.some((o) => o.id === parsed.thinking)));
        seatRewrite = {
          provider: runtimeProvider,
          model: parsed.model,
          ...(thinkingSupported ? { thinkingOptionId: parsed.thinking } : {}),
          labels: mergedLabels,
          slug: project.slug,
        };
      } else {
        // Recognition alone still lands: the seat + project labels ride even
        // when the lane cannot name a provider to rewrite onto.
        seatRewrite = { provider: rawProvider, labels: mergedLabels, slug: project.slug };
      }
    }
  }

  if (seatRewrite === undefined && !providerChanged && !stripThinkingOptionId && nextLabels === undefined) {
    return requestOrConfig;
  }

  const updatedConfig: Record<string, unknown> = {
    ...config,
    provider: seatRewrite?.provider ?? (providerChanged ? normalizedProvider : config.provider),
    ...(seatRewrite?.model !== undefined ? { model: seatRewrite.model } : {}),
    ...(seatRewrite?.thinkingOptionId !== undefined ? { thinkingOptionId: seatRewrite.thinkingOptionId } : {}),
    ...(seatRewrite !== undefined ? { labels: seatRewrite.labels } : nextLabels !== undefined ? { labels: nextLabels } : {}),
  };
  // A seat rewrite owns the thinking field: the request's old
  // `thinkingOptionId` named the role provider's model, not the Project lane's.
  if (seatRewrite !== undefined && seatRewrite.thinkingOptionId === undefined) {
    delete updatedConfig.thinkingOptionId;
  } else if (stripThinkingOptionId) {
    delete updatedConfig.thinkingOptionId;
  }

  if (!hasNestedConfig) {
    return updatedConfig;
  }

  const effectiveLabels = seatRewrite?.labels ?? nextLabels;
  return {
    ...requestOrConfig,
    config: updatedConfig,
    ...(effectiveLabels !== undefined ? { labels: effectiveLabels } : {}),
  };
}

export const normalizeCreateAgentConfig = normalizeAgentCreateRequest;

/**
 * Resolves whether `agent` is a `Supervisor`, `Lead`, or normal-chat
 * `/factory` dispatcher (`reg.dispatchers`) standing at `<project-root>` so
 * `choke.onPermissionAsked` enforces the `Seat write fence` (`seat-write-fence`).
 */
export function resolveSeatAtProjectRoot(
  stateDir: string,
  agent: PermissionAskedEvent["agent"],
): { seat: SeatName; projectRoot: string } | undefined {
  const labelSeat = agent.labels?.seat;
  if (labelSeat === "supervisor" || labelSeat === "lead") {
    return { seat: labelSeat, projectRoot: agent.cwd };
  }
  // The deterministic channel (v0.0.27, ADR 0017 §2): a `factory-supervisor` /
  // `factory-lead` session is a seat regardless of its title or labels — the
  // user's natural first message is the title on a native picker chat.
  const providerSeat = inferRoleFromProviderId(agent.provider);
  if (providerSeat === "supervisor" || providerSeat === "lead") {
    return { seat: providerSeat, projectRoot: agent.cwd };
  }
  const titleSeat = inferReservedSeatFromTitle(agent.title);
  if (titleSeat !== undefined) {
    return { seat: titleSeat, projectRoot: agent.cwd };
  }
  for (const reg of listProjectRegistrations(stateDir)) {
    if (reg.supervisor === agent.id) {
      return { seat: "supervisor", projectRoot: reg.root !== "" ? reg.root : agent.cwd };
    }
    if (reg.lead === agent.id) {
      return { seat: "lead", projectRoot: reg.root !== "" ? reg.root : agent.cwd };
    }
    if (
      Array.isArray(reg.dispatchers) &&
      reg.dispatchers.includes(agent.id) &&
      (reg.root === "" || agent.cwd === reg.root || agent.cwd.startsWith(`${reg.root}/`))
    ) {
      return { seat: "supervisor", projectRoot: reg.root !== "" ? reg.root : agent.cwd };
    }
  }
  const correlations = readCorrelations(stateDir);
  for (const rec of correlations) {
    if (rec.agentId === agent.id && (rec.role === "supervisor" || rec.role === "lead")) {
      return { seat: rec.role, projectRoot: rec.projectRoot !== "" ? rec.projectRoot : agent.cwd };
    }
  }
  return undefined;
}

export interface ChokeOptions {
  factory: Factory;
  /** For `~` expansion inside the writable set — injected, tests never touch the real home. */
  homeDir: string;
  /** One line per judged ask / failure — the shell prefixes and prints it. */
  onLog?: (message: string) => void;
}

export interface Choke {
  /** The `agent.permission_requested` listener. Never throws. */
  onPermissionAsked(event: PermissionAskedEvent, paseo: PaseoResponderApi): Promise<void>;
  /** The spool's synthetic-ask handler — the battery's vehicle into the same judge and ledger. */
  spoolAskHandler(request: AskRequest): SpoolReply;
  /**
   * The `agent.create` before-hook body (map decision 7, provider-aware in
   * v0.0.23 ADR 0015 §4): pins `modeId: "default"` ("Always Ask") ONLY for
   * `claude` contracted task workers, never for `Supervisor`/`Lead` seats or
   * non-Claude providers (`opencode`, `codex`, `pi`).
   */
  pinCreateMode<T extends { provider: string; cwd?: string; modeId?: string; title?: string | null }>(
    config: T,
    labels?: Record<string, string>,
  ): T | undefined;
}

function extractShellCommand(request: AgentPermissionRequest): string | undefined {
  const detail = request.detail;
  if (detail !== undefined && detail.type === "shell" && typeof detail.command === "string") {
    return detail.command;
  }
  const lower = request.name.toLowerCase();
  if ((lower === "shell" || lower === "bash") && typeof request.description === "string" && request.description.trim() !== "") {
    return request.description;
  }
  return undefined;
}

function extractWriteFilePath(request: AgentPermissionRequest): string | undefined {
  const detail = request.detail;
  if (detail !== undefined && (detail.type === "write" || detail.type === "edit") && typeof detail.filePath === "string") {
    return detail.filePath;
  }
  const lower = request.name.toLowerCase();
  if ((lower === "write" || lower === "edit") && typeof request.description === "string" && request.description.trim() !== "") {
    return request.description.split("\n")[0]!.trim();
  }
  return undefined;
}

/** Explicit git paths bypass the exec-time shim, so OpenCode seats fence writes here. */
function hasExplicitGitWrite(command: string): boolean {
  const tokens = shellTokens(command);
  const valueFlags = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  const writes = new Set([
    "add", "commit", "merge", "cherry-pick", "rebase", "am", "apply", "stash", "reset", "clean",
    "rm", "mv", "revert", "restore", "checkout", "switch", "pull", "push", "fetch", "init", "clone",
    "update-index", "update-ref", "read-tree", "write-tree", "commit-tree",
  ]);
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]!.endsWith("/git")) continue;
    let subAt = i + 1;
    while (tokens[subAt]?.startsWith("-")) subAt += valueFlags.has(tokens[subAt]!) ? 2 : 1;
    if (writes.has(tokens[subAt]!)) return true;
  }
  return false;
}

export function createChoke(options: ChokeOptions): Choke {
  const { factory, homeDir } = options;
  const log = options.onLog ?? (() => {});

  // The memory write fence's context (v0.0.14, ADR 0010 §6): every judged ask
  // comes from a contracted agent, so the live Contract's workspace and scope
  // ride into the core judges — write/edit asks and shell destinations both —
  // plus the task's worktree root when its spawn recorded one (a worktree
  // agent's absolute writes name the worktree's copy of the memory file).
  const fenceOf = (contract: ContractSet): MemoryFence => {
    const worktree = factory.worktreeFor(contract.task);
    return { workspace: contract.workspace, scope: contract.scope, ...(worktree === undefined ? {} : { worktree }) };
  };
  /**
   * The writable root for an ask: the task's worktree when its spawn recorded
   * one (the execution tree, v0.0.14 — the worktree sits under the state dir,
   * so the root set already admits it, and the PROJECT ROOT drops out of the
   * agent's writable set, which is the isolation working), the Contract's
   * workspace otherwise.
   */
  const executionRootOf = (task: string, workspace: string): string => factory.worktreeFor(task) ?? workspace;

  const decide = (request: AgentPermissionRequest, workspace: string, memory?: MemoryFence): { decision: ChokeDecision; command?: string } => {
    if (isForbiddenPaseoToolName(request.name)) {
      return {
        decision: {
          behavior: "deny",
          rule: "seat-paseo-tool-fence",
          reason: "raw Paseo agent/messaging tool is forbidden inside a factory seat — use paseo_factory MCP tools instead",
        },
        command: request.name,
      };
    }
    if (isPaseoFactoryToolName(request.name)) {
      return { decision: { behavior: "allow" }, command: request.name };
    }
    const roots = writableRootsFor(workspace, factory.stateDir, homeDir);
    const shellCmd = extractShellCommand(request);
    if (shellCmd !== undefined) {
      return { decision: judgeShellCommand(shellCmd, roots, memory), command: shellCmd };
    }
    const filePath = extractWriteFilePath(request);
    if (filePath !== undefined) {
      // The write/edit rider (ticket 01's non-shell twin of S2), fenced over
      // the workspace-root memory files. The file path rides on the line so
      // the ledger names what was aimed at.
      return { decision: judgeFilePath(filePath, roots, memory), command: filePath };
    }
    // No shell line and no file target (plan/question/mode asks, reads): the
    // deny-list has nothing to match — default-allow.
    return { decision: { behavior: "allow" } };
  };

  const resolveSeatAskContext = (agent: PermissionAskedEvent["agent"]): { seat: SeatName; projectRoot: string } | undefined =>
    resolveSeatAtProjectRoot(factory.stateDir, agent);

  const decideSeat = (request: AgentPermissionRequest, projectRoot: string): { decision: ChokeDecision; command?: string } => {
    if (isForbiddenPaseoToolName(request.name)) {
      return {
        decision: {
          behavior: "deny",
          rule: "seat-paseo-tool-fence",
          reason: "raw Paseo agent/messaging tool is forbidden inside a factory seat — use paseo_factory MCP tools instead",
        },
        command: request.name,
      };
    }
    if (isPaseoFactoryToolName(request.name)) {
      return { decision: { behavior: "allow" }, command: request.name };
    }
    const shellCmd = extractShellCommand(request);
    if (shellCmd !== undefined) {
      return {
        decision: judgeSeatShellCommand(shellCmd, projectRoot, factory.stateDir),
        command: shellCmd,
      };
    }
    const filePath = extractWriteFilePath(request);
    if (filePath !== undefined) {
      return {
        decision: judgeSeatFilePath(filePath, projectRoot, factory.stateDir),
        command: filePath,
      };
    }
    return { decision: { behavior: "allow" } };
  };

  const delegateToShim = (
    agent: PermissionAskedEvent["agent"], request: AgentPermissionRequest, decision: ChokeDecision, seat: SeatName | "agent",
  ): ChokeDecision => {
    const command = extractShellCommand(request);
    if (command === undefined) return decision;
    const projectSlug = agent.labels?.project
      ?? readCorrelations(factory.stateDir).find((record) => record.agentId === agent.id)?.projectSlug
      ?? listProjectRegistrations(factory.stateDir).find((registration) => registration.root === agent.cwd)?.slug
      ?? "";
    const family = resolveEffectiveProviderFamily(agent.provider ?? request.provider, seat, factory.stateDir, projectSlug);
    if (family !== "opencode") return decision;
    if (seat !== "agent" && decision.behavior === "allow" && hasExplicitGitWrite(command)) {
      const guidance = seat === "supervisor"
        ? "Supervisor must dispatch repairs via supervisor_dispatch_lead"
        : "Lead must contract and spawn a Task Agent via lead_set_contract + lead_spawn_agent";
      return { behavior: "deny", rule: "seat-write-fence", reason: `${SEAT_WRITE_FENCE_MESSAGE}; explicit-path git writes bypass the shim. ${guidance}` };
    }
    if (decision.behavior !== "deny" || !["seat-write-fence", "git-commit"].includes(decision.rule)) return decision;
    const installed = ["git", "gh", "npm", "npx", "pnpm", "yarn", "bun"].filter((tool) => {
      try {
        accessSync(join(factory.stateDir, "bin", tool), fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    return isStrictlyLayer3ShimmedCommand(command, installed) ? { behavior: "allow" } : decision;
  };

  const choke: Choke = {
    async onPermissionAsked({ agent, request }, paseo) {
      const seatCtx = resolveSeatAskContext(agent);
      if (seatCtx !== undefined) {
        // Never auto-answer an interactive question form on the Supervisor seat:
        // OpenCode question forms require user-supplied `answers` from the Owner UI.
        if (seatCtx.seat === "supervisor" && request.kind === "question") {
          return;
        }
        const judged = decideSeat(request, seatCtx.projectRoot);
        const command = judged.command;
        const decision = delegateToShim(agent, request, judged.decision, seatCtx.seat);
        const exactMessage =
          decision.behavior === "deny" && decision.rule === "seat-write-fence" ? decision.reason : undefined;
        const response = recordAsk(
          factory,
          log,
          {
            task: seatCtx.seat,
            agent: agent.id,
            name: request.name,
            kind: request.kind,
            ...(command === undefined ? {} : { command }),
          },
          decision,
          exactMessage,
        );
        if (response === undefined) return;
        try {
          await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response });
        } catch (err) {
          log(
            `choke: recorded the seat ask from agent ${agent.id} but could not answer it ` +
              `(${err instanceof Error ? err.message : String(err)}) — the ask stays pending`,
          );
        }
        return;
      }

      if (!isContractedAgentCwd(factory, agent.cwd)) return;
      let contract;
      try {
        contract = factory.liveContractFor(agent.cwd);
      } catch (err) {
        log(`choke: contract lookup failed for agent ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (contract === undefined) return; // not a contracted agent — not our ask to answer
      const judged = decide(request, executionRootOf(contract.task, contract.workspace), fenceOf(contract));
      const command = judged.command;
      const decision = delegateToShim(agent, request, judged.decision, "agent");
      const response = recordAsk(factory, log, {
        task: contract.task,
        agent: agent.id,
        name: request.name,
        kind: request.kind,
        ...(command === undefined ? {} : { command }),
      }, decision);
      if (response === undefined) return; // the line never landed — do not answer what is not recorded
      try {
        await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response });
      } catch (err) {
        // The line is already in the ledger; a failed response leaves the ask
        // pending for the daemon's own operator flow — loud, never fatal.
        log(
          `choke: recorded the ask from agent ${agent.id} but could not answer it ` +
            `(${err instanceof Error ? err.message : String(err)}) — the ask stays pending`,
        );
      }
    },

    spoolAskHandler(request) {
      const contract = factory.contractFor(request.task);
      if (contract === undefined) {
        throw new FactoryError("unknown-task", `no contract set for task ${request.task} — register one first`);
      }
      // The default cwd is the task's execution tree (the worktree on the
      // v0.0.14 path) — where the asking agent actually sits.
      const cwd = request.cwd ?? factory.worktreeFor(request.task) ?? contract.workspace;
      const live = factory.liveContractFor(cwd);
      if (live === undefined || live.task !== request.task) {
        throw new FactoryError(
          "not-contracted",
          `task ${request.task} has no live contract covering ${cwd} — the choke judges contracted work only`,
        );
      }
      const decision = judgeShellCommand(
        request.command,
        writableRootsFor(executionRootOf(live.task, live.workspace), factory.stateDir, homeDir),
        fenceOf(live),
      );
      const base = {
        task: request.task,
        agent: request.agent ?? "spool-ask",
        name: request.name ?? "shell",
        kind: "tool",
        command: request.command,
      };
      if (decision.behavior === "deny") {
        factory.ledger.append({ ...base, event: "permit_denied", rule: decision.rule, reason: decision.reason });
        log(`choke: DENIED ${request.task} via spool ask (${decision.rule}): ${request.command}`);
        return {
          id: request.id,
          ok: true,
          summary: `ask denied (${decision.rule}): ${decision.reason}`,
          decision: "denied" as const,
          rule: decision.rule,
          reason: decision.reason,
        };
      }
      factory.ledger.append({ ...base, event: "permit_allowed" });
      log(`choke: allowed ${request.task} via spool ask: ${request.command}`);
      return {
        id: request.id,
        ok: true,
        summary: "ask allowed",
        decision: "allowed" as const,
      };
    },

    pinCreateMode(config, labels) {
      if (labels?.seat === "supervisor" || labels?.seat === "lead") return undefined;
      if (inferReservedSeatFromTitle(config.title) !== undefined) return undefined;
      const providerId = config.provider.split("/")[0]?.trim().toLowerCase() ?? "";
      if (providerId !== "claude" && providerId !== "claude-code") return undefined;
      if (!isContractedAgentCwd(factory, config.cwd) || config.modeId === PINNED_MODE_ID) return undefined;
      return { ...config, modeId: PINNED_MODE_ID };
    },
  };
  return {
    onPermissionAsked: (event, paseo) => factory.history.runOperation(() => choke.onPermissionAsked(event, paseo)),
    spoolAskHandler: (request) => factory.history.runSync(() => choke.spoolAskHandler(request)),
    pinCreateMode: (config, labels) => factory.history.runSync(() => choke.pinCreateMode(config, labels)),
  };
}

/**
 * One judged ask becomes one ledger line first, then the answer to hand back.
 * Returns undefined when the line could not be recorded — the caller must not
 * answer what the ledger does not carry.
 */
function recordAsk(
  factory: Factory,
  log: (message: string) => void,
  base: { task: string; agent: string; name: string; kind: string; command?: string },
  decision: ChokeDecision,
  exactMessage?: string,
): AgentPermissionResponse | undefined {
  try {
    if (decision.behavior === "deny") {
      factory.ledger.append({ ...base, event: "permit_denied", rule: decision.rule, reason: decision.reason });
      log(`choke: DENIED ${base.task} agent ${base.agent} (${decision.rule}): ${base.command ?? base.name}`);
    } else {
      factory.ledger.append({ ...base, event: "permit_allowed" });
      log(`choke: allowed ${base.task} agent ${base.agent}: ${base.command ?? base.name}`);
    }
  } catch (err) {
    log(`choke: could not record the ask from agent ${base.agent}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  return decision.behavior === "deny"
    ? { behavior: "deny", message: exactMessage ?? `paseo-factory choke: ${decision.reason} (${decision.rule})`, interrupt: false }
    : { behavior: "allow" };
}

// ---- the git shim's ledger ingestion -----------------------------------------------------------

/** Where the shim appends its refusal lines (one JSON object per line). */
export function gitBlockLogPath(stateDir: string): string {
  return `${stateDir}/git-blocked.log`;
}

export interface GitBlockIngestion {
  stop(): void;
}

export interface GitBlockOptions {
  onLog?: (message: string) => void;
  /** Poll cadence. Default 250ms, the spool's cadence. */
  pollMs?: number;
}

interface ShimLine {
  id: string;
  command: string;
  rule: string;
  reason: string;
  cwd: string;
  agent?: string;
}

/**
 * Feeds the shim's refusal log into the ledger: each complete line becomes one
 * `git_blocked` event, bound to the live Contract covering its cwd when one
 * exists (the shim itself refuses no matter who runs it — binding is the
 * plugin's afterthought). Exactly-once by the line's id: the seen-set is
 * seeded from the ledger at boot, so a plugin restart never double-records a
 * refusal. Malformed lines are logged loudly and skipped — never appended,
 * never crashed on.
 */
export function startGitBlockIngestion(factory: Factory, options: GitBlockOptions = {}): GitBlockIngestion {
  const stateDir = factory.stateDir;
  const log = options.onLog ?? (() => {});
  const seen = new Set<string>(
    factory.ledger.events.filter((e) => e.event === "git_blocked").map((e) => e.blockId),
  );

  const ingestAdmitted = (): void => {
    let raw: string;
    try {
      raw = readFileSync(gitBlockLogPath(stateDir), "utf8");
    } catch {
      return; // no refusals yet — the common case
    }
    const lines = raw.split("\n");
    if (lines.at(-1) === "") lines.pop(); // the complete lines only; a tail mid-write waits for its newline
    for (const line of lines) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        log(`git-blocked ingestion: skipping a malformed line: ${line.slice(0, 120)}`);
        continue;
      }
      const record = parsed as Partial<ShimLine>;
      if (
        typeof record.id !== "string" ||
        record.id === "" ||
        typeof record.command !== "string" ||
        typeof record.rule !== "string" ||
        typeof record.reason !== "string" ||
        typeof record.cwd !== "string"
      ) {
        log(`git-blocked ingestion: skipping a line with missing fields: ${line.slice(0, 120)}`);
        continue;
      }
      if (seen.has(record.id)) continue;
      const contract = factory.liveContractFor(record.cwd);
      factory.ledger.append({
        event: "git_blocked",
        ...(contract === undefined ? {} : { task: contract.task }),
        ...(record.agent === undefined || record.agent === "" ? {} : { agent: record.agent }),
        command: record.command,
        rule: record.rule,
        reason: record.reason,
        cwd: record.cwd,
        blockId: record.id,
      });
      seen.add(record.id);
      log(`git blocked: ${record.command} (${record.rule})${contract === undefined ? "" : ` — task ${contract.task}`}`);
    }
  };

  const ingest = (): void => {
    try { factory.history.runSync(ingestAdmitted); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || !["history-maintenance-busy", "upgrade-recovery-required"].includes(String(error.code))) throw error; }
  };
  const timer = setInterval(ingest, options.pollMs ?? 250);
  ingest();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
