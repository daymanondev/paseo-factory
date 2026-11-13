import { recentSeatModels } from "./seat-model-history.ts";
import { readPeerHandover } from "./peer-handoff.ts";
import { parseHandoffFile } from "./handoff-text.ts";
import { readHandoffProgress, laneRef } from "./handoff-progress.ts";
import type { PanelView, ScopedLaneRef, TaskView } from "../shared/view.ts";
import type { HandoffProgress, HandoffAction, HandoffRequest, HandoffReply } from "../shared/handoff.ts";
import { readProjectSettings, setProjectSkillPacks } from "./core/project-settings.ts";
import { linkedPreviewBundle } from "./core/open-design/preview-bundle.ts";
import { serveLinkedPreview } from "./core/open-design/preview-server.ts";
import { discoverOpenDesignProjects, exportOpenDesignProject, syncOpenDesignLink, readOpenDesignLink, unlinkOpenDesign, prepareOpenDesignDispatch } from "./core/open-design/open-design-link.ts";
import type { HelperMcpConfigUpdate } from "./core/helper-mcp-sync.ts";
import { discoverHelperMcps, helperMcpRoster, setHelperMcpEnabled, syncHelperMcps } from "./core/helper-mcp-sync.ts";
import { provisionPiAgentHome } from "./core/pi-home.ts";
import { pluginDirFor } from "./paths.ts";
import { liveSeatCandidates, seatCandidates } from "./seats.ts";
import { checkProjectResetRepository, removeProjectStateDirectory, resetProjectRepository } from "./project-reset.ts";
import { boundTaskPeers } from "./task-peers.ts";
import { withProjectIngressLock } from "./core/project-ingress-lock.ts";
import { projectTask } from "./core/task-state.ts";
import { upgradeFactory } from "./core/history-upgrade.ts";
import type { UpgradeInput } from "./core/history-upgrade.ts";
export { acceptanceSummary, archiveAcceptedTaskWorkspace } from "./commands.ts";
/**
 * The Factory surface's in-process single-writer handlers (v0.0.13, ADR
 * 0009 §2/§4, the amendment to ADR 0004): every `factory.*` RPC runs inside
 * the plugin server process that owns the one Factory instance, so Owner
 * acts from the UI — Lane config, the seat bridges — invoke `saveLanes` and
 * the seat helpers directly, never through the spool. The daemon half rides the PaseoApi each `handle` call
 * receives (`context.paseo`), reduced to the structural slice below — SDK
 * types stay out by the timeline.ts precedent.
 *
 * v0.0.14 (ADR 0010 §1–§3/§6): the Supervisor and Lead seats are
 * per-Project agents standing at `cwd = <project-root>` with labels
 * `{seat, project: <slug>}` — `supervisorEnsure`/`leadEnsure` find or create
 * them under their lane (additive role injection lives in roles.ts; nothing
 * under the project root is ever written), `leadRotate` retires a Lead so
 * the next dispatch starts fresh. The two
 * daemon acts the in-process API lacks (a live agent's model sync,
 * cancelling a running agent) ride the CLI bridge in daemon-cli.ts.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { CorrelationRegistry } from "./core/correlations.ts";
import { FactoryError } from "./core/errors.ts";
import type { Factory } from "./core/factory.ts";
import { readLeadMailbox } from "./core/mailbox.ts";
import { buildSeatKickoffPacket } from "./core/preflight.ts";
import { LANE_NAMES, laneError, loadLanes, migrateLegacyZcodeLane, parseLane, saveLanes, projectLanesPath, listLaneProfiles, getLaneProfile, readLaneProfilesFile, saveLaneProfile, deleteLaneProfile, applyLaneProfile, saveLanesBatch, resetProjectLanes } from "./core/lanes.ts";
import type { LaneProfile } from "./core/lanes.ts";
import { listProjectRegistrations, projectNotebookPath, projectStateDir, readProjectRegistration, resolveOrBootstrapProject, resolveProject } from "./core/project.ts";
import type { ProjectResolution } from "./core/project.ts";
import { hydrateVaultDirect, importVaultSecrets, isLocalCompanionGitSource, loadVaultConfig, probeCompanionGitAccess, probeGhAuth, pullVault, pushVault, readVaultStatus, saveVaultConfig, syncVault } from "./core/vault.ts";
import type { ImportVaultSecretsInput, SyncVaultOptions, VaultConfig, VaultRunner } from "./core/vault.ts";
import { materializeVaultSkillsFromRuntime, resolveVaultUserHome } from "./core/vault-materialization.ts";
import {
  checkCompanionToolsUpdates,
  CORE_FACTORY_SKILLS,
  ensureProviderSkillSymlinks,
  inspectFactorySkillPack,
  installOrUpdateFactorySkillPack,
  installOrUpdateExpoSkillPack, inspectSkillHub, importHostSkillOrPack, detectProjectSkillPacks,
} from "./core/companion-tools.ts";
import type { CompanionToolRunner, CompanionToolUpdateStatus } from "./core/companion-tools.ts";
import { basename, join, resolve } from "node:path";
import { foldView, foldTasks } from "./view.ts";
import { foldPanel, inspectGitReadiness, probeOpenDesign } from "./panel.ts";
import { handoffMarkTokens } from "./handoff-limits.ts";
import { readLeadContextTokens } from "./context-tokens.ts";
import type { UsagePaths } from "./core/usage-extractor.ts";
import type { ProjectEventStream } from "./view.ts";
import type { LedgerEvent } from "./core/events.ts";
import { setAgentModelViaCli, setAgentThinkingViaCli, stopAgentViaCli } from "./daemon-cli.ts";
import { checkDaemonPluginUpdates, cleanupDaemonWorkspacesAndProjectsViaWs, getCachedPluginUpdateStatus, installDaemonPlugin, isPaseoWorkspaceArchivedOnDisk, listDaemonPlugins, manageDaemonPlugin, prunePaseoProjectRegistry, reloadDaemonConfigViaWs, restoreDaemonWorkspaceViaWs } from "./daemon-cli.ts";
import type { DaemonPluginAction, DaemonPluginItem, DaemonPluginSourceStatus, DaemonPluginUpdateRow, DaemonReply } from "./daemon-cli.ts";
import { effectiveLanesForReconcile, reconcilePaseoRoleProviders } from "./core/role-providers.ts";
import { FACTORY_SEAT_PROVIDER_IDS, SEAT_TITLES, inferRoleFromProviderId, isSupervisorCandidate, resolveEffectiveProviderFamily } from "./roles.ts";
import type { SeatName } from "./roles.ts";
import { ensureProjectRegistered, writeProjectRegistration, resolveTargetProject } from "./projects.ts";
import type { FactoryRegistry } from "./projects.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { COMPANION_CATALOG, COMPANION_TOOLS_CATALOG, CORE_PLUGIN_ENTRY, MANAGEABLE_PLUGIN_IDS, MANAGEABLE_TOOL_IDS } from "../shared/companions.ts";
import type { CompanionCatalogEntry, CompanionToolCatalogEntry, ManageablePluginId } from "../shared/companions.ts";
import type { SpoolLeadDispatchRequest, SpoolSupervisorReportRequest, SpoolReply } from "./spool.ts";
import {
  openDesignCatalog, openDesignExport, openDesignStatus, openDesignSync, openDesignUnlink, openDesignPreview,
  lanesSet,
  lanesReset,
  lanesSetBatch,
  leadDispatch,
  leadEnsure,
  handoffStart, handoffReplaceNow, handoffCancel, handoffRetry, handoffHandover,
  helperMcpsSyncAndProbe,
  helperMcpsSetEnabled,
  pluginsCheckUpdates,
  skillsImport, skillsTogglePack,
  pluginsInstall,
  pluginsManage,
  profilesApply,
  profilesDelete,
  profilesSave,
  onboardingCommit,
  onboardingInspect,
  projectDelete,
  projectReset,
  seatsDirectory,
  snapshot,
  supervisorAdopt,
  supervisorEnsure,
  supervisorRevoke,
  supervisorStart,
  vaultConfigure,
  vaultHydrate,
  vaultImport,
  vaultPull,
  historyUpgrade,
  historyImport,
  historyImports,
  vaultPush,
  vaultSync,
} from "../shared/rpc.ts";
import type { CompanionPluginView, AgentView, LaneName, LaneProfileView, Lanes, ProjectDirectoryEntry, ProjectView, SeatDirectoryEntry, VaultStatusView } from "../shared/view.ts";
import type { UsageRuntime } from "./usage-rollup.ts";

// ---- the daemon slice ---------------------------------------------------------------------

/** The agent snapshot fields the surface reads — plain data, no SDK types. */
export interface SurfaceAgentSnapshot {
  id: string;
  provider: string;
  title: string | null;
  status: string;
  model: string | null;
  thinkingOptionId?: string | null;
  lastError?: string | null;
  labels: Record<string, string>;
  archivedAt: string | null;
  requiresAttention: boolean;
  attentionReason: string | null;
  updatedAt: string;
  cwd: string;
  /**
   * The live usage slice the 128k Lead sensor reads (v0.0.20, ADR 0013 §5) —
   * the SDK's `AgentUsage` subset, present when the daemon reports usage.
   * The token/cost fields are the usage extractor's last-resort fallback
   * (v0.0.87, ADR 0043 §2) when no native session store exists on disk yet.
   */
  lastUsage?: {
    contextWindowUsedTokens?: number;
    contextWindowMaxTokens?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalCostUsd?: number;
  } | null;
  /**
   * The persistence slice naming the provider-native session handle — the Pi
   * `.jsonl` fallback's path across daemon restarts (v0.0.20, ADR 0013 §5),
   * and since v0.0.87 (ADR 0043 §2) the multi-provider extractor's session
   * ids (`sessionId`, `metadata`) for every harness's own store.
   */
  persistence?: { nativeHandle?: string; sessionId?: string; provider?: string; metadata?: unknown } | null;
  /** The runtime session pointer (v0.0.87, ADR 0043 §2) — the extractor's last session-id source. */
  runtimeInfo?: { provider?: unknown; sessionId?: unknown; model?: unknown } | null;
  /** The agent's create-time config slice — the model fallback when no store names one. */
  config?: { model?: unknown } | null;
  /**
   * The Paseo Workspace the agent's session lives in (v0.0.31, ADR 0017 §5)
   * — carried on the daemon's own agent row, so `ensureSeat` can co-locate
   * Lead inside the Supervisor's main Workspace. Null/absent when the daemon
   * reports none.
   */
  workspaceId?: string | null;
  /**
   * The agent's Paseo parent link (v0.6.1, ADR 0057 §4). New Leads are created
   * without one; a pre-v0.6.1 Lead still parented to its Supervisor is read
   * here, so replacing that Supervisor releases it instead of archiving (a
   * Paseo archive would cascade onto the child). Null/absent when unparented.
   */
  parentAgentId?: string | null;
  /**
   * Timestamp of the last user message delivered to this session (`null` when
   * no turn has ever been sent to this seat yet, ADR 0031).
   */
  lastUserMessageAt?: string | null;
}

/** One provider entry resolved from the daemon's provider & model catalog. */
export interface ProviderEntry {
  provider: string;
  id?: string;
  available: boolean;
  models: {
    id: string;
    label: string | null;
    thinkingOptions?: { id: string; label: string | null }[] | null;
    defaultThinkingOptionId?: string | null;
  }[] | null;
}

/**
 * Strips any unsupported `:thinking` variant from a `<provider>/<model>[:<thinking>]`
 * lane string when the provider catalog explicitly advertises `thinkingOptions: []`
 * or does not include the requested thinking option (v0.0.24, ADR 0015 §1).
 */
export function sanitizeLaneWithProviders(laneValue: string, providers: readonly ProviderEntry[]): string {
  const parsed = parseLane(laneValue);
  if (parsed === undefined) return laneValue;
  const { provider, model, thinking } = parsed;
  const entry = providers.find((p) => (p.provider ?? p.id) === provider);
  if (entry === undefined || !Array.isArray(entry.models)) return laneValue;
  const strippedModel = model.replace(/^[^/]+\//, "");
  const meta = entry.models.find(
    (m) =>
      m.id === model ||
      `${provider}/${m.id}` === model ||
      m.id === `${provider}/${model}` ||
      m.id === strippedModel ||
      m.id.replace(/^[^/]+\//, "") === strippedModel,
  );
  if (meta !== undefined && Array.isArray(meta.thinkingOptions)) {
    if (
      meta.thinkingOptions.length === 0 ||
      (thinking !== undefined && !meta.thinkingOptions.some((o) => o.id === thinking))
    ) {
      return `${provider}/${model}`;
    }
  }
  return laneValue;
}

/**
 * The structural slice of PaseoApi the handlers call. The real object from
 * `context.paseo` satisfies it (methods return more; extra fields are
 * harmless), tests pass a fake shaped exactly like it — the choke's
 * `PaseoResponderApi` precedent.
 */
export interface SurfaceDaemonApi {
  agents: {
    list(options?: {
      includeBackground?: boolean;
      filter?: { labels?: Record<string, string>; includeArchived?: boolean; includeBackground?: boolean };
    }): Promise<{ entries: { agent: SurfaceAgentSnapshot }[] }>;
    create(options: {
      config: { provider: string; thinkingOptionId?: string };
      cwd: string;
      title: string;
      labels: Record<string, string>;
      prompt?: string;
      parent?: string;
    }): Promise<{ id: string }>;
    ref(id: string): {
      send(text: string): Promise<void>;
      archive(): Promise<{ archivedAt: string }>;
      /**
       * Best-effort agent update (v0.6.1, ADR 0057 §5 adopt/auto-bind step
       * "label the agent") — optional: a daemon without an agent-update API
       * skips the label write, and the registration binding alone carries the
       * seat. Failures are logged, never a failed adopt.
       */
      update?(input: { labels?: Record<string, string>; title?: string }): Promise<unknown>;
      timeline: {
        refetch(options?: {
          direction?: "tail";
          limit?: number;
        }): Promise<{ entries?: { seqEnd?: number; item?: { type?: string; text?: string } }[]; error?: string | null }>;
      };
    };
  };
  workspaces?: {
    open(options: { cwd: string }): Promise<{ id: string; projectId?: string | null }>;
    create(options: {
      title: string;
      source: { kind: "directory"; path: string; projectId?: string };
    }): Promise<{ id: string; projectId?: string | null }>;
    archive(workspaceId: string): Promise<unknown>;
    ref(workspaceId: string): {
      agents: {
        create(options: {
          config: { provider: string; thinkingOptionId?: string };
          title: string;
          labels: Record<string, string>;
          prompt?: string;
          parent?: string;
        }): Promise<{ id: string }>;
      };
    };
  };
  providers: {
    listAvailable(): Promise<{ providers: { provider: string; available: boolean }[] }>;
    listModels(provider: string): Promise<{
      models: {
        id: string;
        label?: string | null;
        thinkingOptions?: { id: string; label?: string | null }[] | null;
        defaultThinkingOptionId?: string | null;
      }[];
    }>;
  };
}

/** What each `server.handle` call passes besides the parsed input. */
export interface SurfaceCallContext {
  paseo?: unknown;
}

// ---- the handlers -------------------------------------------------------------------------

export interface SurfaceDeps {
  factory: Factory;
  /**
   * The Per-Project Factory registry (v0.0.89, ADR 0045 §1): when wired,
   * every Project-scoped RPC — snapshot, taskDetail, accept, project
   * reset/delete — resolves its target Project through the context-first
   * order and runs on that Project's own Factory (its isolated ledger,
   * reports and gate logs under `<stateDir>/projects/<slug>/`).
   * The `factory` above remains the root fallback for unbound machine-level
   * acts (upgrade, machine lanes); unwired, it handles everything as before.
   */
  registry?: FactoryRegistry;
  stateDir: string;
  /** The paseo home — the daemon the seat bridges and CLI fallbacks target. */
  home: string;
  /** Provider-native store locations, shared with the runtime sensor. */
  usagePaths?: UsagePaths;
  /** The resolved plugin directory, when installed from a directory — gives the seat bootstrap an exact factory.mjs path. */
  pluginDir?: string;
  /** The daemon to call when the RPC call carries no `context.paseo` (tests). */
  daemon: SurfaceDaemonApi | (() => SurfaceDaemonApi);
  /** Live agent model sync override (tests) — the CLI bridge by default. */
  setAgentModel?: (agentId: string, model: string, home?: string) => Promise<DaemonReply>;
  /** Live agent thinking sync override (tests) — the CLI bridge by default. */
  setAgentThinking?: (agentId: string, thinkingOptionId: string, home?: string) => Promise<DaemonReply>;
  /** Agent cancel override (tests) — the CLI bridge by default. */
  stopAgent?: (agentId: string, home?: string) => Promise<DaemonReply>;
  /**
   * Daemon plugin lifecycle overrides (v0.0.17, ADR 0012 §4; tests) — the
   * daemon WebSocket bridge by default. Every call targets `home` first, so
   * trial and production plugin state never cross-contaminate.
   */
  listPlugins?: typeof listDaemonPlugins;
  installPlugin?: typeof installDaemonPlugin;
  managePlugin?: typeof manageDaemonPlugin;
  checkPluginUpdates?: typeof checkDaemonPluginUpdates;
  /** Optional host home override and runner override for companion tools (`factory-skills-pack`; ADR 0040). */
  userHome?: string;
  companionToolRunner?: CompanionToolRunner;
  /**
   * The daemon worktree-record sweep override (v0.0.27, ADR 0017 §4; tests) —
   * the WebSocket bridge by default, the same law the plugin lifecycle
   * overrides carry: tests drive the delete requests from in-memory
   * fixtures, zero daemon.
   */
  cleanupDaemonWorkspaces?: typeof cleanupDaemonWorkspacesAndProjectsViaWs;
  /**
   * The Lead-mailbox rotation settle (v0.0.20, ADR 0013 §4's last arm):
   * `retireSeat` fires it right after a Project's Lead is archived, so any
   * un-acked in-flight delivery of that Project's `mailbox.jsonl` returns to
   * `queued` as `mail_requeued` (`reason: "lead-rotated"`) — the
   * Lead-mailbox runtime's `settleLeadRotation` is the implementation. A
   * thrown settle is logged, never a failed rotation (startup recovery
   * remains the net).
   */
  handoff?: (input: HandoffRequest) => Promise<HandoffReply>;
  handoffPending?: (slug: string) => boolean;
  onLeadRetired?: (input: { slug: string; agentId: string }) => void;
  /**
   * The lost-Lead guard (v0.6.1, ADR 0057 §4): the surface marks every agent
   * id it is ABOUT to archive through its own doors (seat retire, project
   * reset/delete) BEFORE the archive call flies, so the daemon's
   * `agent.archive.after` for that id is recognised as a plugin archive and
   * never triggers lost-Lead recovery. The Lead-mailbox runtime's
   * `markPluginArchive` is the implementation.
   */
  markPluginArchive?: (input: { agentId: string }) => void;
  /**
   * The failed-archive unmark (v0.6.1 review fix, ADR 0057 §4): when one of
   * the surface's own archive calls FAILS, the marker `markPluginArchive` set
   * for that id must go — the plugin did not archive it after all, and a
   * stale marker would swallow a later genuine outside archive of the same
   * id. The Lead-mailbox runtime's `clearPluginArchive` is the implementation.
   */
  clearPluginArchive?: (input: { agentId: string }) => void;
  /** Notify LeadMailRuntime when ensureSeat dispatches an explicit initial message to a seat (v0.0.28, ADR 0018 §2). */
  onSeatKickoffSent?: (input: { slug: string; seat: "supervisor" | "lead"; agentId: string }) => void;
  /** Reset in-memory mailbox state for a project on Owner-only Project reset (v0.0.24). */
  resetProjectMailbox?: (slug: string) => void;
  /**
   * The UI's quick-dispatch door (v0.0.20, ADR 0013 §4): the `leadDispatch`
   * handler routes through the Lead-mailbox runtime's `dispatchLead` — the
   * same `enqueueLeadMail` + `pumpProjectLead` pipeline the spool's
   * `lead_dispatch` rides. Without it the RPC refuses by name (the spool's
   * `lead-dispatch-unavailable` precedent).
   */
  leadDispatch?: (request: SpoolLeadDispatchRequest, options?: { existingDesignSnapshot: true }) => Promise<SpoolReply>;
  supervisorReport?: (request: SpoolSupervisorReportRequest) => Promise<SpoolReply>;
  /**
   * The Supervisor-mailbox pump door (v0.6.1, ADR 0057 §5): the Lead-mailbox
   * runtime's `pumpProjectSupervisor` is the implementation — the bind paths
   * (auto-bind on session open, `factory.supervisor.adopt`) call it so a newly
   * bound Supervisor receives its Seat kickoff packet plus every held report in
   * one first turn, through the same drain the mailbox owns.
   */
  pumpSupervisorMailbox?: (slug: string) => Promise<void>;
  /**
   * The vault transport seam (v0.0.21, ADR 0014 §2; tests): every external
   * CLI call the four `factory.vault.*` handlers make — `gh api`,
   * `git clone/pull/add/commit/push` — rides this injectable `VaultRunner`
   * instead of the vendored core's default (real children with
   * `GIT_TERMINAL_PROMPT: "0"`), the same law `listPlugins`/`installPlugin`/
   * `managePlugin` carry: tests drive both transports from in-memory
   * fixtures, zero network.
   */
  vaultRunner?: VaultRunner;
  /**
   * The per-Project usage rollup runtime (v0.0.87, ADR 0043 §4–§5): the
   * snapshot's `projectUsage` gather, the retiring seat flushes, and the
   * reset/delete hygiene all ride it. Optional so unwired tests degrade to a
   * null usage half, never a failed snapshot.
   */
  usage?: UsageRuntime;
  onLog?: (message: string) => void;
}

/** How many agents one snapshot carries (seats + bound workers). */
const SNAPSHOT_AGENT_CAP = 12;

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): string {
  return err instanceof FactoryError ? err.code : "failed";
}

/** One companion install's sentence — the source actually used, the ref when one was given. */
function pluginsInstallSummary(input: { ids: readonly string[]; source: string; ref?: string; batch: boolean }): string {
  if (input.ids.length === 0) return "every companion is already installed — nothing to do";
  const ids = input.ids.join(", ");
  const from = input.batch ? "their canonical sources" : input.source;
  return `installed ${ids} from ${from}${input.ref === undefined ? "" : ` at ref ${input.ref}`}`;
}

/** One companion manage act's sentence — the per-action verb, house style (with honest update outcome in v0.0.25, ADR 0012 §4). */
function pluginsManageSummary(pluginId: string, action: DaemonPluginAction, update?: DaemonPluginUpdateRow): string {
  switch (action) {
    case "enable":
      return `enabled ${pluginId} on the daemon`;
    case "disable":
      return `disabled ${pluginId} on the daemon`;
    case "reload":
      return `reloaded ${pluginId} on the daemon`;
    case "update": {
      if (update?.updated === false) {
        const curr = update.currentCommit ? ` (${update.currentCommit.slice(0, 7)})` : "";
        return `${pluginId} is already up to date${curr}`;
      }
      if (update?.updated === true) {
        if (update.previousCommit && update.currentCommit) {
          return `updated ${pluginId} (${update.previousCommit.slice(0, 7)} → ${update.currentCommit.slice(0, 7)})`;
        }
        if (update.currentCommit) {
          return `updated ${pluginId} to ${update.currentCommit.slice(0, 7)}`;
        }
      }
      return `updated ${pluginId} to the latest revision`;
    }
    case "remove":
      return `removed ${pluginId} from the daemon`;
  }
}

export function createSurfaceHandlers(deps: SurfaceDeps) {
  const resolveDaemon = (context?: SurfaceCallContext): SurfaceDaemonApi => {
    const fromCall = context?.paseo;
    if (fromCall !== undefined) return fromCall as SurfaceDaemonApi;
    return typeof deps.daemon === "function" ? deps.daemon() : deps.daemon;
  };
  const log = deps.onLog ?? (() => {});
  const failure = <C extends string>(code: C, error: string) => ({ ok: false as const, code, error });

  // ---- the Per-Project routing half (v0.0.89, ADR 0045 §1) -------------------------------
  //
  // With a registry wired, Project-scoped acts resolve their target Project
  // through the context-first order and run on that Project's own Factory —
  // its isolated ledger, reports and gate logs under
  // `<stateDir>/projects/<slug>/`. Unwired, the single root Factory stands
  // exactly as before.

  /** The Factory owning a Project slug — the registry's cached instance, else the root Factory. */
  const factoryForSlug = (slug: string): Factory => (deps.registry === undefined ? deps.factory : deps.registry.factoryForProject(slug));

  /**
   * The Contract for `task` as THIS Project's own stream sees it (v0.0.89):
   * the stream's Factory first, the legacy root bridge second. Unlike the
   * task-only `resolveTaskFactory` lookup, this never refuses on a Task id two
   * Projects share — the stream already names the Project, so each side of the
   * collision resolves its own Contract.
   */
  const contractInProject = (task: string, slug: string) => {
    let factory: Factory;
    try {
      factory = factoryForSlug(slug);
    } catch {
      return undefined; // an unopenable Project Ledger answers "no contract", never a failed snapshot
    }
    const contract = factory.contractFor(task);
    if (contract !== undefined) return contract;
    return factory === deps.factory ? undefined : deps.factory.contractFor(task);
  };

  /**
   * Resolves the Factory holding a task's Contract by task id (the unique-
   * Task-lookup arm). `ambiguous` names the by-name refusal a task id shared
   * by several Projects carries; `root` keeps the legacy single-Factory path
   * (and the root Factory's own `unknown-task` refusal names the miss).
   */
  const resolveTaskFactory = (task: string): { ok: true; factory: Factory; slug?: string } | { ok: false; code: string; error: string } => {
    if (deps.registry === undefined) return { ok: true, factory: deps.factory };
    const target = resolveTargetProject(deps.registry, { task });
    if (target.ok) {
      const factory = deps.registry.factoryForProject(target.slug);
      // The legacy root bridge (the spool router's precedent): a task the
      // Project's Factory does not own but the root Factory still does — a
      // root-ledger upgrade flow, or un-migrated bytes — reads and mutates on
      // the root, never a wrong-Project unknown-task.
      if (factory.contractFor(task) === undefined && deps.factory.contractFor(task) !== undefined) {
        return { ok: true, factory: deps.factory };
      }
      return { ok: true, factory, slug: target.slug };
    }
    if (target.code === "ambiguous-task-project") return { ok: false, code: target.code, error: target.message };
    return { ok: true, factory: deps.factory };
  };

  /** The maintenance lane a project reset/delete runs on — the target Project's own Factory. */
  const factoryForResetTarget = (
    input: { projectRoot?: string; project?: string; projectSlug?: string; workspace?: string } | undefined,
  ): Factory => {
    if (deps.registry === undefined || input === undefined) return deps.factory;
    const target = resolveTargetProject(deps.registry, {
      project: input.project !== undefined && input.project.trim() !== "" ? input.project : input.projectSlug,
      workspace: input.projectRoot !== undefined && input.projectRoot.trim() !== "" ? input.projectRoot : input.workspace,
    });
    return target.ok ? deps.registry.factoryForProject(target.slug) : deps.factory;
  };
  let localUpdateSnapshot: { statuses: ReadonlyMap<string, DaemonPluginSourceStatus>; checkedAt: string } | null = null;
  let localToolUpdateSnapshot: Record<"factory-skills-pack", CompanionToolUpdateStatus> | null = null;

  /**
   * The vault half's gather (v0.0.21, ADR 0014 §4; v0.0.22 guided `gh` probe):
   * the vendored core's filesystem probe over `deps.home` — config fields, the
   * `<home>/vault/.git` clone probe, and the shared-secret readiness pills,
   * plus a cached `probeGhAuth` check when unconfigured so the Header Vault
   * Bar can greet `@<ghUser>` with `<ghUser>/factory-vault`. The core folds a
   * damaged config into `error`; a probe that still throws degrades the same
   * way (the daemon-half law: never a failed snapshot).
   */
  const vaultStatusOf = async (): Promise<VaultStatusView> => {
    try {
      const base = readVaultStatus(deps.home);
      if (!base.configured) {
        const ghAuth = await probeGhAuth(deps.vaultRunner);
        return readVaultStatus(deps.home, undefined, ghAuth);
      }
      return base;
    } catch (err) {
      return {
        configured: false,
        historyImports: deps.factory.history.allStatus(),
        repo: null,
        branch: "main",
        nodeId: "node",
        hasPassphrase: false,
        cloneExists: false,
        lastHydratedAt: null,
        lastHydrateMode: null,
        lastPushedAt: null,
        sharedSecrets: { ascKey: false, ascCredentials: false, gplayServiceAccount: false, eyeConfig: false },
        hydratedApps: [],
        ghInstalled: false,
        ghAuthenticated: false,
        ghUser: null,
        suggestedRepo: null,
        error: messageOf(err),
      };
    }
  };

  /** The transport handlers' shared runner leg — the injected seam, else the core's default children. */
  const vaultRunnerOptions = (): { runner?: VaultRunner } => (deps.vaultRunner === undefined ? {} : { runner: deps.vaultRunner });

  /**
   * Resolves a projectRoot RPC input — the one door every seats-only act
   * enters through (F8's five-fold stanza folded). The failure arm IS the
   * handlers' refusal reply (code + sentence, tests key on the reason), so
   * call sites return it verbatim; snapshot stays on raw `resolveProject`
   * because it degrades to the global view instead of refusing.
   */
  const projectOrRefusal = (
    projectRoot: string,
  ): Extract<ProjectResolution, { ok: true }> | { ok: false; code: "unknown-project"; error: string } => {
    const project = resolveProject(projectRoot);
    return project.ok
      ? project
      : { ok: false, code: "unknown-project" as const, error: `project root ${projectRoot} does not resolve to a git repository — ${project.reason}` };
  };

  /**
   * The ADR 0017 §2 identity fallback (the lead-mailbox `liveSeatAgentByIdentity`
   * precedent): a seat started from Paseo's native New Chat picker carries no
   * `labels.seat` — the Project's `project.json` binding and the role-provider
   * id name it instead. Only the registration's bound agent id or a
   * role-provider agent pinned to this Project by label or cwd is accepted, so
   * a neighbor Project's seat is never grabbed.
   */
  const seatAgentByIdentity = (
    agents: SurfaceAgentSnapshot[],
    slug: string,
    seat: "supervisor" | "lead",
  ): SurfaceAgentSnapshot | undefined => {
    return seatCandidates(agents, deps.stateDir, seat, slug)[0];
  };

  const seatOf = async (daemon: SurfaceDaemonApi, seat: "supervisor" | "lead", projectSlug?: string): Promise<SurfaceAgentSnapshot | undefined> =>
    (await liveSeatCandidates(daemon, deps.stateDir, seat, projectSlug))[0];

  /**
   * The keep/active workspace-id sets the orphaned `local_checkout` sweep
   * keys on (v0.0.31, ADR 0017 §5): `keepWorkspaceIds` collects the Project's
   * live Supervisor/Lead workspace ids (the labeled seat agents first, the
   * `project.json` binding and registration fallback), `activeWorkspaceIds`
   * every workspace id a live non-archived agent resides in. Null when the
   * daemon cannot answer or reports no workspace ids at all — the sweep never
   * runs blind over a census it could not read.
   */
  const resolveSweepWorkspaceSets = async (
    daemon: SurfaceDaemonApi,
    project: { slug: string; root: string },
    extraKeepWorkspaceIds?: readonly string[],
  ): Promise<{ keepWorkspaceIds: string[]; activeWorkspaceIds: string[] } | null> => {
    let liveAgents: SurfaceAgentSnapshot[] = [];
    try {
      const page = await daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
      liveAgents = page.entries.map((entry) => entry.agent).filter((agent) => agent.archivedAt === null);
    } catch {
      return null; // no daemon answer — never sweep blind
    }
    const registration = readProjectRegistration(deps.stateDir, project.slug);
    const keep = new Set<string>();
    if (extraKeepWorkspaceIds !== undefined) {
      for (const id of extraKeepWorkspaceIds) {
        if (typeof id === "string" && id.trim() !== "") keep.add(id.trim());
      }
    }
    for (const seat of ["supervisor", "lead"] as const) {
      const seatAgent =
        liveAgents.find((agent) => agent.labels.seat === seat && agent.labels.project === project.slug) ??
        seatAgentByIdentity(liveAgents, project.slug, seat);
      if (typeof seatAgent?.workspaceId === "string" && seatAgent.workspaceId !== "") keep.add(seatAgent.workspaceId);
    }
    const normProjectRoot = realpathSafe(project.root);
    for (const agent of liveAgents) {
      if (typeof agent.workspaceId !== "string" || agent.workspaceId === "") continue;
      if (agent.labels.project === project.slug || realpathSafe(agent.cwd) === normProjectRoot) {
        keep.add(agent.workspaceId);
      }
    }
    if (typeof registration?.workspaceId === "string" && registration.workspaceId !== "") keep.add(registration.workspaceId);
    const active = new Set(
      liveAgents
        .map((agent) => agent.workspaceId)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    );
    if (keep.size === 0 && active.size === 0) return null; // the daemon reports no workspace ids — never sweep blind
    return { keepWorkspaceIds: [...keep], activeWorkspaceIds: [...active] };
  };

  /**
   * The orphaned `local_checkout` sweep (v0.0.31, ADR 0017 §4–§5): archives
   * the Project's daemon workspace records whose root sits at the project
   * root and host zero live agents — never the active Supervisor/Lead
   * workspace, never a workspace with a live agent, and among worktree
   * records only directories already gone from disk. Best-effort by design:
   * a sweep that cannot land logs and returns, never a failed caller.
   */
  const sweepOrphanedLocalCheckoutWorkspaces = async (
    daemon: SurfaceDaemonApi,
    project: { slug: string; root: string },
    extraKeepWorkspaceIds?: readonly string[],
  ): Promise<void> => {
    const sets = await resolveSweepWorkspaceSets(daemon, project, extraKeepWorkspaceIds);
    if (sets === null) return;
    try {
      const swept = await (deps.cleanupDaemonWorkspaces ?? cleanupDaemonWorkspacesAndProjectsViaWs)(deps.home, {
        worktreesDir: join(projectStateDir(deps.stateDir, project.slug), "worktrees"),
        projectRoot: project.root,
        keepWorkspaceIds: sets.keepWorkspaceIds,
        activeWorkspaceIds: sets.activeWorkspaceIds,
      });
      if (swept.ok && swept.removedWorkspaceIds.length > 0) {
        log(`${project.slug}: swept ${swept.removedWorkspaceIds.length} orphaned daemon workspace(s) at ${project.root}`);
      }
    } catch (err) {
      log(`${project.slug}: the orphaned local_checkout sweep did not land — ${messageOf(err)}`);
    }
  };

  /** The agent → task binding: which live agent works which task, from the ledger's own names. */
  const agentTaskIndex = (events: readonly LedgerEvent[] = deps.factory.ledger.events): Map<string, string> => {
    const index = new Map<string, string>();
    for (const evt of events) {
      const agent = evt.event === "claim_reported" || evt.event === "meter_written" ? evt.agent : evt.event === "repoke_dispatched" ? evt.agent : undefined;
      if ("task" in evt && typeof evt.task === "string" && typeof agent === "string" && agent !== "") index.set(agent, evt.task);
    }
    return index;
  };

  /**
   * One task's contract workspace sits inside the Project root (equal or
   * nested). The Contract resolves through the Project's OWN stream when the
   * caller names its slug (v0.0.89 — a Task id two Projects share answers per
   * side, never the task-only lookup's ambiguity refusal); the task-only
   * lookup stands in for slug-less callers.
   */
  const taskInProject = (task: string, root: string, slug?: string): boolean => {
    const contract =
      slug !== undefined
        ? contractInProject(task, slug)
        : (() => {
            const routed = resolveTaskFactory(task);
            return routed.ok ? routed.factory.contractFor(task) : undefined;
          })();
    if (contract === undefined) return false;
    const normRoot = realpathSafe(resolve(root));
    const normWs = realpathSafe(resolve(contract.workspace));
    if (
      contract.workspace === root ||
      contract.workspace.startsWith(`${root}/`) ||
      normWs === normRoot ||
      normWs.startsWith(`${normRoot}/`)
    ) {
      return true;
    }
    if (slug !== undefined) {
      const worktreesDir = join(projectStateDir(deps.stateDir, slug), "worktrees");
      if (contract.workspace === worktreesDir || contract.workspace.startsWith(`${worktreesDir}/`)) {
        return true;
      }
    }
    return false;
  };

  /** Scope is resolved for each role, so a Lead override never labels Worker as Project-owned. */
  const laneScope = (slug: string | undefined, role: "supervisor" | "lead" | "worker"): "project" | "machine" => {
    if (slug) try {
      const overrides = JSON.parse(readFileSync(projectLanesPath(deps.stateDir, slug), "utf8"));
      if (typeof overrides?.[role] === "string") return "project";
    } catch { /* Absent Project override inherits the machine. */ }
    return "machine";
  };
  const seatLanesOf = (slug: string | undefined, lanes: Lanes): Record<"supervisor" | "lead" | "worker", ScopedLaneRef> => ({
    supervisor: { ...laneRef(lanes.supervisor), scope: laneScope(slug, "supervisor") },
    lead: { ...laneRef(lanes.lead), scope: laneScope(slug, "lead") },
    worker: { ...laneRef(lanes.worker), scope: laneScope(slug, "worker") },
  });

  const handoffPanelFacts = (slug: string | undefined, tasks: readonly TaskView[], lanes: Lanes) => {
    const handoffs: Record<string, HandoffProgress> = {};
    const handovers: string[] = [];
    if (!slug) return { handoffs, handovers };
    const seats = ["supervisor", "lead", ...tasks.filter(t => !["accepted", "closed"].includes(t.status)).map(t => `peer:${t.task}`)];
    for (const seat of seats) {
      const progress = readHandoffProgress(deps.stateDir, slug, seat);
      if (progress) handoffs[seat] = progress;
      if (seat.startsWith("peer:")) {
        if (readPeerHandover(deps.stateDir, slug, seat.slice(5)).text) handovers.push(seat);
      } else try {
        if (parseHandoffFile(readFileSync(join(projectStateDir(deps.stateDir, slug), `${seat}-handoff.md`), "utf8")).body.trim()) handovers.push(seat);
      } catch { /* No handover yet. */ }
    }
    const reg = readProjectRegistration(deps.stateDir, slug);
    if (!handoffs.lead && reg?.rotationState && reg.rotationState !== "normal") {
      const at = reg.handoffRequestedAt ?? new Date().toISOString();
      handoffs.lead = { seat: "lead", reason: "context-mark", state: reg.rotationState === "rotation_pending" ? "scheduled" : "handing-over", fromLane: laneRef(lanes.lead), toLane: laneRef(lanes.lead), startedAt: at, updatedAt: at, ...(reg.rotationState === "rotation_pending" ? { waitingPeers: tasks.filter(t => t.status === "running").length } : {}) };
    }
    return { handoffs, handovers };
  };

  /** One agent → AgentView. */
  const agentViewOf = (
    agent: SurfaceAgentSnapshot,
    task: string | null,
    seatOverride?: "supervisor" | "lead",
    projectSlug = agent.labels.project,
  ): AgentView => {
    const reading = readLeadContextTokens(agent, deps.usagePaths);
    const role = (agent.labels.seat ?? seatOverride) === "supervisor" ? "supervisor" : (agent.labels.seat ?? seatOverride) === "lead" ? "lead" : "peer";
    const taskId = task ?? agent.labels.task ?? null;
    const seat = role === "peer" ? taskId === null ? null : `peer:${taskId}` : role;
    const configured = projectSlug ? loadLanes(deps.stateDir, projectSlug) : loadLanes(deps.stateDir);
    const laneName = role === "peer" ? "worker" : role;
    const configuredLane = configured.ok ? laneRef(configured.lanes[laneName]) : { provider: "", model: "" };
    let value = agent.provider;
    if ((Object.values(FACTORY_SEAT_PROVIDER_IDS) as string[]).includes(value)) value = `${configuredLane.provider}/${configuredLane.model}`;
    else if (!value.includes("/") && agent.model) value = `${value}/${agent.model}`;
    else if (agent.model) {
      const parsed = parseLane(value);
      if (parsed) value = `${parsed.provider}/${agent.model.includes("/") ? agent.model : parsed.model.slice(0, parsed.model.lastIndexOf("/") + 1) + agent.model}`;
    }
    const liveLane = { ...laneRef(value), ...(agent.thinkingOptionId ? { thinking: agent.thinkingOptionId } : {}) };
    const lane = { ...liveLane, scope: laneScope(projectSlug, laneName) };
    const handoffProgress = projectSlug && seat ? readHandoffProgress(deps.stateDir, projectSlug, seat) : null;
    let handoverAvailable = false;
    if (projectSlug && seat) {
      if (role === "peer") handoverAvailable = !!readPeerHandover(deps.stateDir, projectSlug, taskId!).text;
      else try { handoverAvailable = !!parseHandoffFile(readFileSync(join(projectStateDir(deps.stateDir, projectSlug), `${role}-handoff.md`), "utf8")).body.trim(); } catch { /* No handover yet. */ }
      if (!(Object.values(FACTORY_SEAT_PROVIDER_IDS) as string[]).includes(agent.provider)) recentSeatModels(deps.stateDir, role, { lane: liveLane, usedAt: agent.updatedAt });
    }
    const registration = projectSlug ? readProjectRegistration(deps.stateDir, projectSlug) : undefined;
    let queuedMailCount = 0;
    if (projectSlug && role === "lead") try { queuedMailCount = readLeadMailbox(join(projectStateDir(deps.stateDir, projectSlug), "mailbox.jsonl")).queued.length; } catch { /* Unknown mailbox count. */ }
    return {
      lane,
      pendingLane: handoffProgress?.reason === "provider-change" && handoffProgress.state === "scheduled" ? { ...handoffProgress.toLane, scope: lane.scope } : null,
      handoffProgress,
      handoverAvailable,
      ...(role === "lead" ? { rotationState: registration?.rotationState, queuedMailCount } : {}),
      contextUsedTokens: reading.usedTokens,
      contextMaxTokens: reading.maxTokens,
      markTokens: handoffMarkTokens(role, reading.maxTokens),
      id: agent.id,
      title: agent.title,
      status: agent.status,
      provider: agent.provider,
      model: agent.model,
      ...(agent.thinkingOptionId === undefined ? {} : { thinking: agent.thinkingOptionId }),
      // A native-picker seat carries no labels — its recognized seat rides anyway (ADR 0017 §2).
      seat: agent.labels.seat ?? seatOverride ?? null,
      task: task ?? agent.labels.task ?? null,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
      ...(agent.lastError === undefined ? {} : { lastError: agent.lastError }),
      cwd: agent.cwd,
    };
  };

  /** Directory pills carry the same projected facts/actions as panel rows. */
  const directorySeatOf = (
    registration: { slug: string; workspaceId?: string },
    agent: SurfaceAgentSnapshot,
    row: NonNullable<PanelView["seats"]>["lead"] | NonNullable<PanelView["seats"]>["peers"][number],
    profiles: ReturnType<typeof laneProfilesGather>,
  ): SeatDirectoryEntry => {
    const role = row.role;
    const profile = profiles.profiles.find(p => p.id === profiles.activeProfileId);
    const candidates = [...(profile ? Object.values(profile.lanes).map(laneRef) : []), ...recentSeatModels(deps.stateDir, role)];
    const seen = new Set<string>();
    const quickSwitchModels = candidates.filter(lane => {
      const key = `${lane.provider}/${lane.model}`;
      if (!lane.model || seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 6);
    return {
      slug: registration.slug, workspaceId: agent.workspaceId ?? registration.workspaceId ?? null,
      agentId: agent.id, role, task: "task" in row ? row.task : null,
      provider: agent.provider, model: agent.model ?? null, thinking: agent.thinkingOptionId ?? null,
      lane: row.lane, pendingLane: row.pendingLane, context: row.context!, contextUsedTokens: row.context!.usedTokens,
      markTokens: row.markTokens, handoff: row.handoff, handoffState: row.handoff?.state ?? null,
      allowedActions: row.allowedActions, quickSwitchModels,
    };
  };

  const PROVIDERS_TTL_MS = 5 * 60_000;
  const PROVIDERS_WAIT_MS = 2_000;
  let cachedProviderList: ProviderEntry[] | null = null;
  let cachedProvidersAt = 0;
  let cachedProvidersRefs: { listAvailable: unknown; listModels: unknown } | null = null;
  let inFlightProviders: Promise<ProviderEntry[]> | null = null;

  const refreshProviders = (daemon: SurfaceDaemonApi): Promise<ProviderEntry[]> => {
    if (inFlightProviders !== null) return inFlightProviders;
    const job = (async () => {
      const available = (await daemon.providers.listAvailable()).providers;
      const entries = await Promise.all(
        available.map(async (entry) => {
          if (!entry.available) return { provider: entry.provider, available: false, models: null };
          try {
            const listed = await daemon.providers.listModels(entry.provider);
            return {
              provider: entry.provider,
              available: true,
              models: listed.models.map((m) => ({
                id: m.id,
                label: m.label ?? null,
                ...(m.thinkingOptions !== undefined && m.thinkingOptions !== null
                  ? { thinkingOptions: m.thinkingOptions.map((o) => ({ id: o.id, label: o.label ?? null })) }
                  : {}),
                ...(m.defaultThinkingOptionId !== undefined ? { defaultThinkingOptionId: m.defaultThinkingOptionId } : {}),
              })),
            };
          } catch {
            return { provider: entry.provider, available: true, models: null };
          }
        }),
      );
      cachedProviderList = entries;
      cachedProvidersAt = Date.now();
      cachedProvidersRefs = { listAvailable: daemon.providers.listAvailable, listModels: daemon.providers.listModels };
      return entries;
    })().finally(() => {
      if (inFlightProviders === job) inFlightProviders = null;
    });
    inFlightProviders = job;
    return job;
  };

  const resolveProviders = async (daemon: SurfaceDaemonApi): Promise<ProviderEntry[]> => {
    if (
      cachedProvidersRefs !== null &&
      (cachedProvidersRefs.listAvailable !== daemon.providers.listAvailable || cachedProvidersRefs.listModels !== daemon.providers.listModels)
    ) {
      cachedProviderList = null;
      cachedProvidersAt = 0;
    }
    const now = Date.now();
    if (cachedProviderList !== null && now - cachedProvidersAt < PROVIDERS_TTL_MS) {
      return cachedProviderList;
    }
    const job = refreshProviders(daemon);
    if (cachedProviderList !== null) {
      job.catch(() => {});
      return cachedProviderList;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        job,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PROVIDERS_WAIT_MS);
        }),
      ]);
      return raced ?? cachedProviderList ?? [];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const sanitizeLane = async (laneValue: string, context?: SurfaceCallContext): Promise<string> => {
    const daemon = resolveDaemon(context);
    let providers: ProviderEntry[] = [];
    try {
      providers = await resolveProviders(daemon);
    } catch {
      // best-effort provider catalog lookup
    }
    return sanitizeLaneWithProviders(laneValue, providers);
  };

  // ---- the seat bridges (v0.0.14, ADR 0010 §1–§2) ----------------------------------------

  /** Find-or-create one Project's standing seat agent at `cwd = <project-root>` under its lane. */
  const archiveSeatAgent = async (daemon: SurfaceDaemonApi, seat: SeatName, agent: SurfaceAgentSnapshot, slug?: string): Promise<void> => {
    // v0.6.1 (ADR 0057 §4): marked BEFORE the archive flies — the daemon's
    // `agent.archive.after` for this id is a plugin archive, never a lost Lead.
    deps.markPluginArchive?.({ agentId: agent.id });
    try {
      const stopped = await (deps.stopAgent ?? stopAgentViaCli)(agent.id, deps.home);
      if (!stopped.ok) log(`${seat}: cancel before retire failed — ${stopped.reason}`);
    } catch (err) { log(`${seat}: cancel before retire failed — ${messageOf(err)}`); }
    try {
      await daemon.agents.ref(agent.id).archive();
    } catch (err) {
      // v0.6.1 review fix: the archive never flew — the marker must not
      // outlive it, or a later genuine outside archive of this id is swallowed.
      deps.clearPluginArchive?.({ agentId: agent.id });
      throw err;
    }
    if (seat === "lead" && slug !== undefined) {
      try { deps.onLeadRetired?.({ slug, agentId: agent.id }); }
      catch (err) { log(`lead: mailbox settle failed — ${messageOf(err)}`); }
      await archiveReleasedSupervisorWaitingOnLead(daemon, slug, agent.id);
    }
  };

  /**
   * The release's settling act (v0.6.1, ADR 0057 §4): a Lead that just
   * archived settles every released-Supervisor record waiting on it — the
   * cascade risk died with the Lead, so the old Supervisor(s) archive now and
   * their records clear. Fires on the Lead handoff's retire step and the
   * manual rotate alike (the plugin's own Lead archives), and — through the
   * `settleReleasedSupervisor` door the Lead-mailbox runtime fires — when the
   * parented Lead is archived from OUTSIDE, so a released record always has a
   * settlement path. Idempotent (a settled record is removed by the first
   * settle).
   */
  const archiveReleasedSupervisorWaitingOnLead = async (daemon: SurfaceDaemonApi, slug: string, leadAgentId: string): Promise<void> => {
    const reg = readProjectRegistration(deps.stateDir, slug);
    const waiting = reg?.releasedSupervisors?.filter((record) => record.waitingOnLead === leadAgentId) ?? [];
    if (reg === undefined || waiting.length === 0) return;
    const settled: string[] = [];
    for (const released of waiting) {
      try {
        const stopped = await (deps.stopAgent ?? stopAgentViaCli)(released.agentId, deps.home);
        if (!stopped.ok) log(`supervisor: cancel before release-archive failed — ${stopped.reason}`);
      } catch (err) { log(`supervisor: cancel before release-archive failed — ${messageOf(err)}`); }
      deps.markPluginArchive?.({ agentId: released.agentId });
      try {
        await daemon.agents.ref(released.agentId).archive();
        settled.push(released.agentId);
        log(`${slug}: released supervisor ${released.agentId} archived — its parented Lead ${leadAgentId} was archived first`);
      } catch (err) {
        // v0.6.1 review fix: this archive never flew — drop its marker so a
        // later genuine outside archive of the same id is not swallowed.
        deps.clearPluginArchive?.({ agentId: released.agentId });
        log(`${slug}: released supervisor ${released.agentId} could not be archived yet (${messageOf(err)}) — the record stands for the next attempt`);
      }
    }
    if (settled.length > 0) {
      const settledIds = new Set(settled);
      writeProjectRegistration(deps.stateDir, slug, {
        root: reg.root,
        releasedSupervisors: (reg.releasedSupervisors ?? []).filter((record) => !settledIds.has(record.agentId)),
      });
    }
  };

  const seatOperations = new Map<string, Promise<unknown>>();
  const serializeSeat = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = seatOperations.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    seatOperations.set(key, pending);
    try { return await pending; }
    finally { if (seatOperations.get(key) === pending) seatOperations.delete(key); }
  };
  const ensureSeat = (seat: SeatName, input: { projectRoot: string; message?: string }, context?: SurfaceCallContext) => {
    const project = projectOrRefusal(input.projectRoot);
    if (!project.ok) return Promise.resolve(project);
    return serializeSeat(`${project.slug}:${seat}`, () => ensureSeatUnlocked(seat, input, context));
  };
  /**
   * The Supervisor seat start (v0.6.0 W6, ADR 0056 amending ADR 0017 §4) —
   * shared by the vacant Supervisor row's Start Supervisor and the onboarding
   * commit. It is `ensureSeatUnlocked` with two differences: it REFUSES while a
   * Supervisor is live (a start never adopts or retires an existing seat), and
   * it creates the agent through the `factory-supervisor` role provider — the
   * id Paseo's native picker launches — so `server.before("agent.create")`
   * recognises, fences and Lane-rewrites it exactly like a native Supervisor.
   * The directive, when non-blank, is the seat's first user message. Never a Lead.
   */
  const startSupervisor = (input: { projectRoot: string; directive?: string }, context?: SurfaceCallContext) => {
    const project = projectOrRefusal(input.projectRoot);
    if (!project.ok) return Promise.resolve(project);
    return serializeSeat(`${project.slug}:supervisor`, async () => {
      let live: SurfaceAgentSnapshot | undefined;
      try {
        live = await seatOf(resolveDaemon(context), "supervisor", project.slug);
      } catch (err) {
        return failure("daemon-unavailable", `cannot read the daemon's agents: ${messageOf(err)}`);
      }
      if (live !== undefined) {
        return failure("supervisor-live", `a Supervisor is already live for this Project (${live.id}) — open it, or revoke it before starting another`);
      }
      const directive = input.directive?.trim();
      return ensureSeatUnlocked(
        "supervisor",
        { projectRoot: input.projectRoot, ...(directive !== undefined && directive !== "" ? { message: directive } : {}) },
        context,
        { roleProvider: true },
      );
    });
  };
  const retireSeat = (seat: SeatName, slug: string | undefined, root: string | undefined, context?: SurfaceCallContext) =>
    serializeSeat(`${slug}:${seat}`, () => retireSeatUnlocked(seat, slug, root, context));

  /** The Project's own ledger stream for a seat kickoff packet — its Factory's events, never a wrong-Project's. */
  const projectLedgerEventsOf = (slug: string): readonly LedgerEvent[] => {
    try {
      return factoryForSlug(slug).ledger.events;
    } catch {
      return deps.factory.ledger.events;
    }
  };

  // ---- Supervisor binding: the shared adopt body (v0.6.1, ADR 0057 §5) --------------------

  /**
   * The newly bound Supervisor's first turn (v0.6.1, ADR 0057 §5): when
   * Supervisor-addressed mail waits, the Lead-mailbox pump delivers the Seat
   * kickoff packet plus the whole held batch in ONE send (the drain's own
   * first-turn prepend). With nothing held, a chat that has not yet seen its
   * first turn gets the kickoff packet alone. A chat the Owner already typed
   * into keeps its history — its packet rides the next mail turn instead.
   */
  const kickoffSupervisorSeat = async (
    daemon: SurfaceDaemonApi,
    project: { slug: string; root: string },
    agent: SurfaceAgentSnapshot,
  ): Promise<void> => {
    let held = 0;
    try {
      held = readLeadMailbox(join(projectStateDir(deps.stateDir, project.slug), "mailbox.jsonl")).supervisorQueued.length;
    } catch {
      held = 0;
    }
    if (held > 0) {
      if (deps.pumpSupervisorMailbox !== undefined) await deps.pumpSupervisorMailbox(project.slug);
      return; // no pump wired — the mail stays held, never dropped
    }
    if (typeof agent.lastUserMessageAt === "string" && agent.lastUserMessageAt.trim() !== "") return;
    const loadedLanes = loadLanes(deps.stateDir, project.slug);
    const kickoff = buildSeatKickoffPacket({
      role: "supervisor",
      projectSlug: project.slug,
      projectRoot: project.root,
      ledgerEvents: projectLedgerEventsOf(project.slug),
      helperMcps: discoverHelperMcps({ stateDir: deps.stateDir, userHome: resolveSurfaceUserHome() }).servers,
      ...(loadedLanes.ok ? { lanes: loadedLanes.lanes } : {}),
      stateDir: deps.stateDir,
      omitSystemPromptDuplicates: true,
    });
    try {
      await daemon.agents.ref(agent.id).send(kickoff);
      deps.onSeatKickoffSent?.({ slug: project.slug, seat: "supervisor", agentId: agent.id });
    } catch (err) {
      log(`supervisor: the kickoff packet to ${agent.id} did not land (${messageOf(err)}) — the seat is bound either way`);
    }
  };

  /**
   * The Supervisor-binding body the session-open auto-bind and
   * `factory.supervisor.adopt` share (v0.6.1, ADR 0057 §5): label the agent
   * (best-effort daemon update — the binding is the durable act), write the
   * binding through the plugin's registration writer, then serve the first
   * turn through `kickoffSupervisorSeat`. The caller owns the trigger's laws:
   * auto-bind only when no live Supervisor exists; adopt releases the previous
   * one first.
   */
  const bindSupervisorCandidate = async (
    daemon: SurfaceDaemonApi,
    project: { slug: string; root: string },
    agent: SurfaceAgentSnapshot,
  ): Promise<void> => {
    try {
      await daemon.agents.ref(agent.id).update?.({ labels: { ...agent.labels, seat: "supervisor", project: project.slug } });
    } catch (err) {
      log(`supervisor: labelling ${agent.id} as the seat did not land — the binding carries the seat (${messageOf(err)})`);
    }
    writeProjectRegistration(deps.stateDir, project.slug, {
      root: project.root,
      supervisor: agent.id,
      ...(typeof agent.workspaceId === "string" && agent.workspaceId !== "" ? { workspaceId: agent.workspaceId } : {}),
    });
    log(`supervisor: ${agent.id} bound as ${project.slug}'s Supervisor (candidate binding, ADR 0057 §5)`);
    await kickoffSupervisorSeat(daemon, project, agent);
  };

  /** The live daemon row for one agent id — undefined when it is absent or archived. */
  const liveAgentById = async (daemon: SurfaceDaemonApi, agentId: string): Promise<SurfaceAgentSnapshot | undefined> => {
    try {
      const page = await daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
      return page.entries.map((entry) => entry.agent).find((agent) => agent.id === agentId && agent.archivedAt === null);
    } catch {
      return undefined;
    }
  };

  /** Whether a live agent sits in the Project's workspace — cwd at/inside the root, or the Project's own workspace id. */
  const agentInProjectWorkspace = (
    agent: SurfaceAgentSnapshot,
    project: { slug: string; root: string },
    extraWorkspaceId?: string | null,
  ): boolean => {
    const normRoot = realpathSafe(project.root);
    const cwd = realpathSafe(typeof agent.cwd === "string" ? agent.cwd : "");
    if (cwd === normRoot || cwd.startsWith(`${normRoot}/`)) return true;
    const registration = readProjectRegistration(deps.stateDir, project.slug);
    const workspaceIds = [agent.workspaceId, typeof extraWorkspaceId === "string" ? extraWorkspaceId : undefined];
    return workspaceIds.some((id) => typeof id === "string" && id !== "" && id === registration?.workspaceId);
  };

  /**
   * The session-open auto-bind door (v0.6.1, ADR 0057 §5): the shell's
   * `agent.session_open` hook calls this for every non-history open. When the
   * Project's bound Supervisor is archived or missing, the first candidate to
   * open a session binds automatically — REPLACING the old "bind only if
   * empty" rule, so a stale binding no longer blocks recovery. A live
   * Supervisor is never displaced (the panel's Use-this-chat-as-Supervisor —
   * `factory.supervisor.adopt` — is the Owner's choice there), and a
   * non-candidate chat is ignored. Void by design: never the caller's failure.
   */
  const supervisorSessionOpenedUnlocked = async (
    input: { agentId: string; cwd: string; workspaceId?: string | null },
    context?: SurfaceCallContext,
  ): Promise<void> => {
    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (agentId === "" || cwd === "") return;
    const resolved = resolveProject(cwd);
    if (!resolved.ok) return; // not inside a Project's repository — nothing to bind
    const handoff = readHandoffProgress(deps.stateDir, resolved.slug, "supervisor");
    if (handoff && handoff.state !== "done") return;
    const daemon = resolveDaemon(context);
    const agent = await liveAgentById(daemon, agentId);
    if (agent === undefined) return;
    if (!agentInProjectWorkspace(agent, resolved, input.workspaceId)) return;
    const registration = readProjectRegistration(deps.stateDir, resolved.slug);
    let current: SurfaceAgentSnapshot | undefined;
    try {
      current = await seatOf(daemon, "supervisor", resolved.slug);
    } catch {
      return; // no daemon answer — never bind blind
    }
    if (current !== undefined && current.id !== agentId) return; // a live Supervisor holds the seat
    if (current?.id === agentId && registration?.supervisor === agentId) {
      // The bound live Supervisor reopening: held mail delivers, nothing rebinds.
      if (deps.pumpSupervisorMailbox !== undefined) await deps.pumpSupervisorMailbox(resolved.slug);
      return;
    }
    if (agentId === registration?.lead) return; // the Lead never becomes its own Supervisor
    if (!isSupervisorCandidate(agent, { stateDir: deps.stateDir, slug: resolved.slug })) return;
    await bindSupervisorCandidate(daemon, resolved, agent);
  };

  const ensureSeatUnlocked = async (
    seat: SeatName,
    input: { projectRoot: string; message?: string },
    context?: SurfaceCallContext,
    options?: { roleProvider?: boolean },
  ): Promise<{ ok: true; agentId: string; created: boolean; projectRoot: string; slug: string } | { ok: false; code: string; error: string }> => {
    const project = projectOrRefusal(input.projectRoot);
    if (!project.ok) return project;
    const daemon = resolveDaemon(context);
    const supervisorProgress = seat === "supervisor" ? readHandoffProgress(deps.stateDir, project.slug, "supervisor") : null;
    if (supervisorProgress && supervisorProgress.state !== "done") return failure("handoff-in-progress", "The Supervisor is handing off; wait for its successor");
    const lanes = loadLanes(deps.stateDir, project.slug);
    if (!lanes.ok) return failure("lanes-unreadable", lanes.reason);
    let providers: ProviderEntry[] = [];
    try {
      providers = await resolveProviders(daemon);
    } catch {
      // best-effort provider catalog lookup
    }
    const lane = sanitizeLaneWithProviders(lanes.lanes[seat], providers);
    const parsed = parseLane(lane);
    let agent: SurfaceAgentSnapshot | undefined;
    try {
      agent = await seatOf(daemon, seat, project.slug);
    } catch (err) {
      return failure("daemon-unavailable", `cannot read the daemon's agents: ${messageOf(err)}`);
    }
    if (agent !== undefined) {
      const targetProvider = parsed !== undefined ? `${parsed.provider}/${parsed.model}` : lane;
      // A `factory-*` role provider (ADR 0017 §2) fences under its lane's
      // harness family — `resolveEffectiveProviderFamily` resolves it through
      // Lane config, so a native `Supervisor (Factory)` chat is the same family
      // as the lane it runs on, never an unhealthy seat to retire.
      const effectiveFamily =
        parsed === undefined ? undefined : resolveEffectiveProviderFamily(agent.provider, seat, deps.stateDir, project.slug);
      const sameProviderFamily =
        parsed === undefined ||
        agent.provider === parsed.provider ||
        agent.provider === targetProvider ||
        agent.provider.startsWith(`${parsed.provider}/`) ||
        effectiveFamily === parsed.provider;
      const sameCwd =
        typeof agent.cwd !== "string" ||
        agent.cwd === "" ||
        agent.cwd === "/tmp" ||
        realpathSafe(agent.cwd) === realpathSafe(project.root);
      if (agent.status === "error" || !sameProviderFamily || !sameCwd) {
        return failure("handoff-required", `This ${seat === "supervisor" ? "Supervisor" : "Lead"} needs a successor; use factory.handoff.start or Replace now to preserve its history`);
      } else if (parsed !== undefined) {
        const sync = deps.setAgentModel ?? setAgentModelViaCli;
        const syncThinking = deps.setAgentThinking ?? setAgentThinkingViaCli;
        const currentModel =
          agent.model ?? (agent.provider.startsWith(`${parsed.provider}/`) ? agent.provider.slice(parsed.provider.length + 1) : null);
        const targetModelId = parsed.model;
        if (
          currentModel !== null &&
          currentModel !== targetModelId &&
          currentModel !== parsed.model &&
          currentModel !== `${parsed.provider}/${parsed.model}`
        ) {
          await sync(agent.id, targetModelId, deps.home);
        }
        const currentThinking = agent.thinkingOptionId ?? "";
        const targetThinking = parsed.thinking ?? "";
        if (currentThinking !== targetThinking) {
          await syncThinking(agent.id, targetThinking, deps.home);
        }
      }
    }
    // The co-located main Workspace (v0.0.31, ADR 0017 §5): before opening
    // anything, resolve the Project's EXISTING main workspace — the live
    // Supervisor agent's own workspaceId first, then `project.json` — so a
    // Lead ensure creates its agent inside the Supervisor's Workspace as a
    // second Agent tab, never a second `local_checkout` Workspace.
    const registration = readProjectRegistration(deps.stateDir, project.slug);
    let supervisorSnapshot: SurfaceAgentSnapshot | undefined;
    if (seat === "supervisor") {
      supervisorSnapshot = agent;
    } else {
      try {
        supervisorSnapshot = await seatOf(daemon, "supervisor", project.slug);
      } catch {
        // best-effort — the registration's workspaceId is the fallback below
      }
    }
    if (
      typeof supervisorSnapshot?.workspaceId === "string" &&
      supervisorSnapshot.workspaceId !== "" &&
      isPaseoWorkspaceArchivedOnDisk(deps.home, supervisorSnapshot.workspaceId)
    ) {
      await restoreDaemonWorkspaceViaWs(deps.home, supervisorSnapshot.workspaceId);
    }
    const candidateWorkspaceIds = [supervisorSnapshot?.workspaceId, registration?.workspaceId].filter(
      (id): id is string => typeof id === "string" && id !== "",
    );
    const resolvedWorkspaceId =
      candidateWorkspaceIds.find((id) => !isPaseoWorkspaceArchivedOnDisk(deps.home, id)) ??
      (agent === undefined ? candidateWorkspaceIds[0] : undefined);
    let workspaceId: string | undefined;
    let paseoProjectId: string | undefined;
    if (daemon.workspaces !== undefined) {
      if (resolvedWorkspaceId !== undefined) workspaceId = resolvedWorkspaceId;
      if (typeof registration?.paseoProjectId === "string" && registration.paseoProjectId !== "") paseoProjectId = registration.paseoProjectId;
      // `workspaces.open` only when nothing is known yet, or to backfill
      // `paseoProjectId` — an already-resolved workspaceId is never
      // overwritten by a fresh open (v0.0.31, ADR 0017 §5).
      if (workspaceId === undefined || paseoProjectId === undefined) {
        try {
          const opened = await daemon.workspaces.open({ cwd: project.root });
          if (workspaceId === undefined && typeof opened?.id === "string" && opened.id !== "") workspaceId = opened.id;
          if (typeof opened?.projectId === "string" && opened.projectId !== "") paseoProjectId = opened.projectId;
        } catch (err) {
          log(
            `${seat}: workspaces.open(${project.root}) did not resolve (${messageOf(err)})` +
              (workspaceId === undefined ? " — falling back to daemon.agents.create" : " — keeping the resolved workspace"),
          );
        }
      }
    }
    let created = false;
    if (agent === undefined) {
      // The bridge's create half (v0.0.14): the agent stands INSIDE the
      // project root — cwd carries the repository, the labels carry the
      // seat, the bootstrap prompt carries the orientation, and NOTHING
      // under <project-root> is written (the <home>-supervisor folder and
      // its AGENTS.md overwrite are retired; roles.ts owns the injection).
      const title = SEAT_TITLES[seat];
      // A role-provider start (ADR 0056) names only the `factory-<seat>` id:
      // the before-create hook rewrites it onto this Project's own lane.
      const config = options?.roleProvider === true
        ? { provider: FACTORY_SEAT_PROVIDER_IDS[seat === "supervisor" ? "supervisor" : "lead"] }
        : parsed?.thinking !== undefined
          ? { provider: `${parsed.provider}/${parsed.model}`, thinkingOptionId: parsed.thinking }
          : { provider: lane };
      // v0.6.1 (ADR 0057 §4): the Lead is created WITHOUT a Paseo parent —
      // archiving any Supervisor can never cascade to it. Co-location in the
      // Supervisor's workspace (the resolution above) is the only link kept.
      const createInWorkspace = async (targetWorkspaceId: string): Promise<{ id: string }> =>
        daemon.workspaces!.ref(targetWorkspaceId).agents.create({
          config,
          title,
          labels: { seat, project: project.slug },
        });
      try {
        let handle: { id: string } | undefined;
        if (workspaceId !== undefined && daemon.workspaces !== undefined) {
          try {
            handle = await createInWorkspace(workspaceId);
          } catch (wsErr) {
            log(`${seat}: workspaces.ref(${workspaceId}).agents.create failed (${messageOf(wsErr)}) — attempting workspace recovery`);
            const restored = await restoreDaemonWorkspaceViaWs(deps.home, workspaceId);
            if (restored.ok) {
              try {
                handle = await createInWorkspace(workspaceId);
              } catch {
                // fall through to alternate workspace recovery
              }
            }
            if (
              handle === undefined &&
              typeof registration?.workspaceId === "string" &&
              registration.workspaceId !== "" &&
              registration.workspaceId !== workspaceId &&
              !isPaseoWorkspaceArchivedOnDisk(deps.home, registration.workspaceId)
            ) {
              try {
                handle = await createInWorkspace(registration.workspaceId);
                workspaceId = registration.workspaceId;
              } catch {
                // fall through to workspaces.open
              }
            }
            if (handle === undefined && typeof daemon.workspaces.open === "function") {
              try {
                const reopened = await daemon.workspaces.open({ cwd: project.root });
                if (typeof reopened?.projectId === "string" && reopened.projectId !== "") {
                  paseoProjectId = reopened.projectId;
                }
                if (typeof reopened?.id === "string" && reopened.id !== "") {
                  handle = await createInWorkspace(reopened.id);
                  workspaceId = reopened.id;
                }
              } catch {
                // fall through to daemon.agents.create
              }
            }
            if (handle === undefined) {
              handle = await daemon.agents.create({
                config,
                cwd: project.root,
                title,
                labels: { seat, project: project.slug },
              });
              workspaceId = undefined;
            }
          }
        } else {
          handle = await daemon.agents.create({
            config,
            cwd: project.root,
            title,
            labels: { seat, project: project.slug },
          });
        }
        agent = {
          id: handle.id,
          provider: config.provider,
          title,
          status: "initializing",
          model: parsed?.model ?? null,
          ...(parsed?.thinking !== undefined ? { thinkingOptionId: parsed.thinking } : {}),
          labels: { seat, project: project.slug },
          archivedAt: null,
          requiresAttention: false,
          attentionReason: null,
          updatedAt: new Date().toISOString(),
          cwd: project.root,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
        };
        created = true;
        log(`${seat}: created agent ${handle.id} under ${lane} at ${project.root} (project ${project.slug})`);
      } catch (err) {
        const priorBound = registration?.[seat];
        if (readProjectRegistration(deps.stateDir, project.slug)?.[seat] !== priorBound) {
          writeProjectRegistration(deps.stateDir, project.slug, { root: project.root, [seat]: priorBound ?? null });
        }
        return failure("create-failed", `creating the ${seat} agent failed: ${messageOf(err)}`);
      }
    }
    // The durable slug→root + seat-id binding: the Project Selector's
    // discovery and the session-open env injection both read it.
    writeProjectRegistration(deps.stateDir, project.slug, {
      root: project.root,
      ...(seat === "supervisor" ? { supervisor: agent.id } : { lead: agent.id }),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(paseoProjectId !== undefined ? { paseoProjectId } : {}),
    });
    // The new-Supervisor sweep (v0.0.31, ADR 0017 §5): a Supervisor seat
    // landing on a Project archives that Project's orphaned `local_checkout`
    // workspaces — the ones at the project root with zero live agents —
    // never the active Supervisor/Lead workspace nor any workspace hosting a
    // live agent.
    if (seat === "supervisor") {
      const keepIds = [workspaceId, agent.workspaceId].filter((id): id is string => typeof id === "string" && id !== "");
      await sweepOrphanedLocalCheckoutWorkspaces(daemon, project, keepIds);
    }
    for (const duplicate of await liveSeatCandidates(daemon, deps.stateDir, seat, project.slug)) {
      if (duplicate.id !== agent.id) await archiveSeatAgent(daemon, seat, duplicate, project.slug);
    }
    const message = input.message?.trim();
    if (message !== undefined && message !== "") {
      // v0.6.1 (ADR 0057 §5, story 16): Start Supervisor with a directive still
      // sends the full Seat kickoff packet — the packet leads and the directive
      // rides the SAME first turn, exactly like the mailbox drain's first-turn
      // prepend, so a directive-started Supervisor knows the Project as well as
      // one started without.
      const firstTurn =
        seat === "supervisor" && created
          ? `${buildSeatKickoffPacket({
              role: "supervisor",
              projectSlug: project.slug,
              projectRoot: project.root,
              ledgerEvents: projectLedgerEventsOf(project.slug),
              helperMcps: discoverHelperMcps({ stateDir: deps.stateDir, userHome: resolveSurfaceUserHome() }).servers,
              lanes: lanes.lanes,
              stateDir: deps.stateDir,
              omitSystemPromptDuplicates: true,
            })}\n${message}`
          : message;
      try {
        await daemon.agents.ref(agent.id).send(firstTurn);
        deps.onSeatKickoffSent?.({ slug: project.slug, seat, agentId: agent.id });
        log(`${seat}: dispatched a message to ${agent.id}`);
      } catch (err) {
        return failure("send-failed", `the ${seat} agent exists (${agent.id}) but the dispatch failed: ${messageOf(err)}`);
      }
    }
    return { ok: true as const, agentId: agent.id, created, projectRoot: project.root, slug: project.slug };
  };

  /**
   * Cancel + archive one Project's live seat agent — the rotate/revoke
   * retirement. One exception (v0.6.1, ADR 0057 §4): a Supervisor whose live
   * Lead is still PARENTED to it (pre-v0.6.1 parentage, read from the daemon
   * row's `parentAgentId`) is RELEASED instead — the binding clears and a
   * `releasedSupervisors` record names the Lead the archive waits on, because
   * a Paseo archive would cascade onto the child. The records accumulate (the
   * duplicate-supervisor anomaly can release more than one), and each settles
   * (the old Supervisor archives) when its own Lead is archived — by the
   * plugin's handoff or from outside (the lost-Lead door's settle).
   */
  const retireSeatUnlocked = async (
    seat: "supervisor" | "lead",
    projectSlug: string | undefined,
    projectRoot: string | undefined,
    context?: SurfaceCallContext,
  ): Promise<{ ok: true; agentId: string; agentIds: string[]; releasedAgentIds: string[] } | { ok: false; code: string; error: string }> => {
    const daemon = resolveDaemon(context);
    let agents: SurfaceAgentSnapshot[];
    try {
      agents = await liveSeatCandidates(daemon, deps.stateDir, seat, projectSlug);
    } catch (err) {
      return failure("daemon-unavailable", messageOf(err));
    }
    if (agents.length === 0) return failure(seat === "lead" ? "no-lead" : "no-supervisor", `no live ${seat} seat`);
    const agentIds: string[] = [];
    const releasedAgentIds: string[] = [];
    const errors: string[] = [];
    for (const agent of agents) {
      // The v0.6.1 release arm: a live Lead parented to this Supervisor holds
      // the archive — the old Supervisor is released, never archived, until
      // that Lead's own handoff archives it (archiveSeatAgent's settle).
      if (seat === "supervisor" && projectSlug !== undefined && projectRoot !== undefined) {
        let parentedLeadId: string | undefined;
        try {
          parentedLeadId = (await liveSeatCandidates(daemon, deps.stateDir, "lead", projectSlug)).find(
            (lead) => lead.parentAgentId === agent.id,
          )?.id;
        } catch {
          parentedLeadId = undefined; // a daemon miss archives as before — the pre-v0.6.1 behaviour
        }
        if (parentedLeadId !== undefined) {
          // v0.6.1 review fix: the release APPENDS to the registration's
          // released-Supervisor list instead of overwriting one record — the
          // duplicate-supervisor anomaly (the state the ensure sweep normally
          // prevents) can release more than one old Supervisor in this loop,
          // and each waits on its own parented Lead.
          const priorReleases = readProjectRegistration(deps.stateDir, projectSlug)?.releasedSupervisors ?? [];
          writeProjectRegistration(deps.stateDir, projectSlug, {
            root: projectRoot,
            supervisor: null,
            releasedSupervisors: [
              ...priorReleases.filter((record) => record.agentId !== agent.id),
              { agentId: agent.id, waitingOnLead: parentedLeadId, releasedAt: new Date().toISOString() },
            ],
          });
          agentIds.push(agent.id);
          releasedAgentIds.push(agent.id);
          log(`supervisor: ${agent.id} released (not archived) — its live Lead ${parentedLeadId} is still parented to it; the release settles when that Lead hands off`);
          continue;
        }
      }
      // The retiring seat's final usage is flushed BEFORE the archive
      // (v0.0.87, ADR 0043 §3) — rotate/revoke never loses the session's
      // tokens. Best-effort by contract: accounting never blocks the act.
      if (deps.usage !== undefined) await deps.usage.flushAgent(agent, projectSlug === undefined ? undefined : { slug: projectSlug });
      try {
        await archiveSeatAgent(daemon, seat, agent, projectSlug);
        agentIds.push(agent.id);
      } catch (err) { errors.push(`${agent.id}: ${messageOf(err)}`); }
    }
    if (errors.length > 0) return failure("archive-failed", errors.join("; "));
    if (projectSlug !== undefined && projectRoot !== undefined && releasedAgentIds.length === 0) {
      writeProjectRegistration(deps.stateDir, projectSlug, { root: projectRoot, [seat]: null });
    }
    return { ok: true as const, agentId: agentIds[0]!, agentIds, releasedAgentIds };
  };

  /**
   * Shared cleanup seam for `projectDelete` and `projectReset`:
   * 1. Collects all tasks belonging to the Project (from Ledger contracts/spawns, `taskWorkspaces`, and `worktrees/*`).
   * 2. Stops and archives bound agents (working agents always; standing/native seats when `includeSeats: true`).
   * 3. Archives temporary Paseo worktree workspaces (and the main Project workspace when `archiveMainWorkspace: true`).
   * 4. Removes `<projectStateDir>/worktrees/<task>` directories and deletes local `factory/*` git branches (when the root exists on disk).
   */
  const cleanupProjectArtifacts = async (
    daemon: SurfaceDaemonApi,
    project: { slug: string; root: string },
    options: { includeSeats: boolean; archiveMainWorkspace: boolean },
  ) => {
    const stop = deps.stopAgent ?? stopAgentViaCli;
    const projectDir = projectStateDir(deps.stateDir, project.slug);
    const worktreesDir = join(projectDir, "worktrees");
    const reg = readProjectRegistration(deps.stateDir, project.slug);

    // 1. Collect all tasks belonging to this Project (from ledger contracts/spawns, taskWorkspaces, and worktrees/*).
    // v0.0.89: the Project's OWN Factory holds its Contracts — never another
    // Project's events, never the root ledger.
    const projectEvents = deps.registry === undefined ? deps.factory.ledger.events : deps.registry.factoryForProject(project.slug).ledger.events;
    const projectTaskSet = new Set<string>();
    for (const evt of projectEvents) {
      if (
        evt.event === "contract_set" &&
        (evt.workspace === project.root ||
          evt.workspace.startsWith(`${project.root}/`) ||
          evt.workspace === worktreesDir ||
          evt.workspace.startsWith(`${worktreesDir}/`))
      ) {
        projectTaskSet.add(evt.task);
      } else if (
        evt.event === "spawn_dispatched" &&
        typeof evt.worktree === "string" &&
        (evt.worktree === worktreesDir || evt.worktree.startsWith(`${worktreesDir}/`))
      ) {
        projectTaskSet.add(evt.task);
      }
    }
    for (const task of Object.keys(reg?.taskWorkspaces ?? {})) {
      if (task !== "") projectTaskSet.add(task);
    }
    try {
      for (const entry of readdirSync(worktreesDir)) {
        if (entry !== "") projectTaskSet.add(entry);
      }
    } catch {
      // worktrees dir may not exist
    }

    // 2. Find and stop + archive all non-archived agents bound to this Project.
    const archivedSeats: string[] = [];
    const archivedAgents: string[] = [];
    const bound = agentTaskIndex(projectEvents);
    let rawAgents: SurfaceAgentSnapshot[] = [];
    try {
      const page = await daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
      rawAgents = page.entries.map((entry) => entry.agent).filter((agent) => agent.archivedAt === null);
    } catch {
      // best-effort agent listing
    }
    const normRoot = realpathSafe(project.root);
    for (const agent of rawAgents) {
      const seatLabel = agent.labels.seat;
      const inferredRole = inferRoleFromProviderId(agent.provider);
      const isSeatRole =
        seatLabel === "supervisor" ||
        seatLabel === "lead" ||
        inferredRole === "supervisor" ||
        inferredRole === "lead" ||
        agent.id === reg?.supervisor ||
        agent.id === reg?.lead;
      if (!options.includeSeats && isSeatRole) continue;
      const isLeadRole = seatLabel === "lead" || inferredRole === "lead" || agent.id === reg?.lead;
      const boundTask = bound.get(agent.id) ?? agent.labels.task;
      const inWorktree = agent.cwd === worktreesDir || agent.cwd.startsWith(`${worktreesDir}/`);
      const normCwd = realpathSafe(agent.cwd);
      const inProjectRoot =
        agent.cwd === project.root ||
        agent.cwd.startsWith(`${project.root}/`) ||
        normCwd === normRoot ||
        normCwd.startsWith(`${normRoot}/`);
      const matchesProject = options.includeSeats
        ? agent.labels.project === project.slug ||
          agent.id === reg?.supervisor ||
          agent.id === reg?.lead ||
          inProjectRoot ||
          inWorktree ||
          (typeof boundTask === "string" && (projectTaskSet.has(boundTask) || taskInProject(boundTask, project.root, project.slug)))
        : (seatLabel === "agent" && agent.labels.project === project.slug) ||
          (typeof boundTask === "string" && (projectTaskSet.has(boundTask) || taskInProject(boundTask, project.root, project.slug))) ||
          inWorktree;
      if (!matchesProject) continue;

      if (options.includeSeats && isLeadRole) {
        try {
          deps.onLeadRetired?.({ slug: project.slug, agentId: agent.id });
        } catch {
          // best-effort
        }
      }
      // v0.6.1 (ADR 0057 §4): marked BEFORE the archive flies — reset/delete
      // archives are the plugin's own, never a lost Lead (projectDelete has
      // no retireSeat loop: this mark is its only guard).
      deps.markPluginArchive?.({ agentId: agent.id });
      try {
        await stop(agent.id, deps.home);
      } catch {
        // best-effort cancel
      }
      try {
        await daemon.agents.ref(agent.id).archive();
        if (options.includeSeats && isSeatRole) archivedSeats.push(agent.id);
        else archivedAgents.push(agent.id);
      } catch {
        // v0.6.1 review fix: the reset/delete archive never flew — drop its
        // marker so a later genuine outside archive of this id is not swallowed.
        deps.clearPluginArchive?.({ agentId: agent.id });
        // best-effort archive
      }
    }

    // 3. Archive temporary Paseo worktree workspaces (and the main Project workspace when requested).
    if (daemon.workspaces?.archive !== undefined) {
      const wsIds = new Set<string>();
      for (const wsId of Object.values(reg?.taskWorkspaces ?? {})) {
        if (typeof wsId === "string" && wsId !== "") wsIds.add(wsId);
      }
      if (options.archiveMainWorkspace && typeof reg?.workspaceId === "string" && reg.workspaceId !== "") {
        wsIds.add(reg.workspaceId);
      }
      for (const wsId of wsIds) {
        try {
          await daemon.workspaces.archive(wsId);
        } catch {
          // best-effort workspace archive
        }
      }
    }

    // 4. Remove <projectStateDir>/worktrees/<task> directories and delete local factory/* git branches when the root exists on disk.
    const rootExists = existsSync(project.root);
    for (const task of projectTaskSet) {
      const wtPath = join(worktreesDir, task);
      if (rootExists) {
        try {
          spawnSync("git", ["worktree", "remove", "--force", wtPath], {
            cwd: project.root,
            encoding: "utf8",
            timeout: 10_000,
          });
        } catch {
          // best-effort git worktree remove
        }
      }
      try {
        rmSync(wtPath, { recursive: true, force: true });
      } catch {
        // best-effort rm
      }
    }
    try {
      rmSync(worktreesDir, { recursive: true, force: true });
    } catch {
      // best-effort rm worktrees root
    }
    if (rootExists) {
      try {
        spawnSync("git", ["worktree", "prune"], { cwd: project.root, encoding: "utf8", timeout: 10_000 });
      } catch {
        // best-effort prune
      }
      const branchesToDelete = new Set<string>([...projectTaskSet].map((task) => `factory/${task}`));
      try {
        const refs = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/factory/"], {
          cwd: project.root,
          encoding: "utf8",
          timeout: 10_000,
        });
        if (refs.status === 0 && typeof refs.stdout === "string") {
          for (const line of refs.stdout.split("\n")) {
            const branch = line.trim();
            if (branch.startsWith("factory/")) branchesToDelete.add(branch);
          }
        }
      } catch {
        // best-effort branch discovery
      }
      for (const branch of branchesToDelete) {
        try {
          spawnSync("git", ["branch", "-D", branch], { cwd: project.root, encoding: "utf8", timeout: 10_000 });
        } catch {
          // best-effort branch delete
        }
      }
    }

    return { projectDir, worktreesDir, reg, projectTaskSet, archivedSeats, archivedAgents };
  };

  // ---- the Lane profile gather + the machine-anchored reconcile (v0.0.38, ADR 0026 §1–§2) -------

  /** One core `LaneProfile` → the wire `LaneProfileView` (description normalized to null). */
  const laneProfileViewOf = (profile: LaneProfile): LaneProfileView => ({
    id: profile.id,
    name: profile.name,
    description: profile.description ?? null,
    lanes: profile.lanes,
    updatedAt: profile.updatedAt,
  });

  /**
   * The snapshot's `Lane profile` half (v0.0.38, ADR 0026 §5): the Owner's
   * whole profile library plus the scope's active-profile state. The gather
   * is a filesystem probe the snapshot handler owns (the vault-status
   * precedent — the fold stays pure over its inputs), so a damaged
   * `profiles.json` degrades to an empty library, never a failed snapshot.
   */
  const laneProfilesGather = (
    scopeSlug: string | undefined,
    lanes: Lanes,
  ): { profiles: LaneProfileView[]; activeProfileId: string | null; activeProfileModified: boolean; hasProjectLaneOverride: boolean } => {
    let library: LaneProfile[] = [];
    let recordedId: string | null = null;
    try {
      library = listLaneProfiles(deps.stateDir);
      const scope = scopeSlug ?? "global";
      recordedId = readLaneProfilesFile(deps.stateDir).activeProfileByScope?.[scope] ?? null;
    } catch {
      // an unreadable profiles.json is not a snapshot failure — the bar renders empty
    }
    const profiles = library.map(laneProfileViewOf);
    const lanesMatch = (candidate: Lanes): boolean => LANE_NAMES.every((name) => candidate[name] === lanes[name]);
    // The recorded entry stands only while the profile it names still lives;
    // otherwise a profile whose 6 lanes match the effective table is the
    // active one — neither names one, the bar says none.
    let recordedProfile: LaneProfile | undefined;
    if (recordedId !== null) {
      try {
        recordedProfile = getLaneProfile(deps.stateDir, recordedId);
      } catch {
        // a torn profiles.json read degrades to the match fallback
      }
    }
    const active =
      recordedProfile !== undefined
        ? laneProfileViewOf(recordedProfile)
        : (profiles.find((profile) => lanesMatch(profile.lanes)) ?? null);
    let hasProjectLaneOverride = false;
    if (scopeSlug !== undefined) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(projectLanesPath(deps.stateDir, scopeSlug), "utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          hasProjectLaneOverride = LANE_NAMES.some((name) => typeof (parsed as Record<string, unknown>)[name] === "string");
        }
      } catch {
        // an absent override file is the common case — false
      }
    }
    return {
      profiles,
      activeProfileId: active?.id ?? null,
      // Only a RECORDED active profile can be "modified from" — a match-found
      // profile agrees with the table by construction.
      activeProfileModified: recordedProfile !== undefined && !lanesMatch(recordedProfile.lanes),
      hasProjectLaneOverride,
    };
  };

  /**
   * The daemon-global role providers reconcile, anchored STRICTLY to the
   * machine-level table (v0.0.38, ADR 0026 §1): `effectiveLanesForReconcile`
   * reads `<stateDir>/lanes.json` (the majority fallback across Project
   * overrides when the machine never named its lanes) — never a single
   * Project's saved lanes, so Project A's override save can never rewrite the
   * daemon-wide `factory-supervisor` / `factory-lead` / `factory-peer`
   * entries or the `Supervisor (Factory)` picker row Project B launches from.
   */
  /**
   * Reconciles `<home>/config.json` (`factory-supervisor`, `factory-lead`,
   * `factory-peer`, plus the `Supervisor (Factory)` New Chat picker row) from
   * the machine-scope `Lanes` (ADR 0017 §1, ADR 0026 §1; v0.6.1's ADR 0057 §11
   * narrows the scope to the machine table) so Paseo's New Chat picker tracks
   * the machine lanes the Owner just saved, while `server.before("agent.create")`
   * enforces each Project's own `<projectStateDir>/lanes.json` at agent launch
   * time. An `lanesOverride` is given only by the UNSCOPED machine save (the
   * table it just wrote); a Project-scoped save passes none, so the reconcile
   * reads the machine scope and a Project override never rewrites the
   * daemon-wide providers.
   */
  const reconcileRoleProvidersFromScope = (lanesOverride?: Lanes): void => {
    try {
      let lanesToReconcile: Lanes;
      if (lanesOverride !== undefined) {
        lanesToReconcile = lanesOverride;
      } else {
        const effective = effectiveLanesForReconcile(deps.stateDir);
        if (!effective.ok) {
          log(`role providers: lanes unreadable — <home>/config.json not reconciled — ${effective.reason}`);
          return;
        }
        lanesToReconcile = effective.lanes;
      }
      const reconciled = reconcilePaseoRoleProviders(deps.home, lanesToReconcile, { reloadDaemon: reloadDaemonConfigViaWs });
      if (reconciled.ok) {
        if (reconciled.changed) log("role providers: <home>/config.json reconciled — daemon reload requested");
      } else {
        log(`role providers: <home>/config.json not reconciled — ${reconciled.reason}`);
      }
    } catch (err) {
      log(`role providers: <home>/config.json reconcile failed — ${messageOf(err)}`);
    }
  };

  /**
   * The Live-Seat Transition Law's server-side execution (v0.0.38, ADR 0026
   * §3/§4), shared by every lane mutation (`lanesSet`, `lanesSetBatch`,
   * `profilesApply`, `lanesReset`): for each live supervisor/lead seat whose
   * lane value changed —
   * - same provider family (the LIVE AGENT's family vs the new lane's
   *   provider): the model and thinking level update in place, preserving the
   *   session and its conversation;
   * - different family: the seat retires — the Lead through the `leadRotate`
   *   flow (cancel + archive, clear `reg.lead`, `onLeadRetired` requeues the
   *   queued Lead mailbox items for the next Lead), the Supervisor by cancel +
   *   archive + clearing `reg.supervisor` — so the next turn/dispatch spawns a
   *   fresh seat on the new provider harness with the matching Layer-1 fence.
   * A live session can never switch its provider adapter in place; the reply
   * names what happened per seat.
   */
  const syncLiveSeatsAfterLaneUpdate = async (input: {
    projectSlug: string;
    projectRoot: string;
    /** The Project's effective lanes BEFORE the write. */
    before: Pick<Lanes, "supervisor" | "lead">;
    /** The Project's effective lanes AFTER the write. */
    after: Pick<Lanes, "supervisor" | "lead">;
    /** Only these seats are considered (the lanes the act actually touches). */
    seats?: readonly ("supervisor" | "lead")[];
    context?: SurfaceCallContext;
  }): Promise<string> => {
    const daemon = resolveDaemon(input.context);
    const parts: string[] = [];
    for (const seat of input.seats ?? (["supervisor", "lead"] as const)) {
      const fromLane = input.before[seat];
      const toLane = input.after[seat];
      if (fromLane === toLane) continue; // the seat's lane is untouched — the seat is unaffected
      const fromParsed = parseLane(fromLane);
      const parsed = parseLane(toLane);
      let agent: SurfaceAgentSnapshot | undefined;
      try {
        agent = await seatOf(daemon, seat, input.projectSlug);
      } catch (err) {
        parts.push(`failed — reading the daemon's agents threw (${messageOf(err)}) (lanes.json is the config of record)`);
        continue;
      }
      if (agent === undefined) {
        parts.push(`skipped — no live ${seat} agent for project ${input.projectSlug}`);
        continue;
      }
      // The live agent's family BEFORE the lane write: if `agent.provider` is a
      // `factory-*` role provider, `saveLanes` has already written `after` to
      // disk, so `fromParsed` (the lane before the write) names the family the
      // live session was running on.
      const effectiveFamily =
        inferRoleFromProviderId(agent.provider) !== undefined && fromParsed !== undefined
          ? resolveEffectiveProviderFamily(fromParsed.provider, seat, deps.stateDir, input.projectSlug)
          : resolveEffectiveProviderFamily(agent.provider, seat, deps.stateDir, input.projectSlug);
      const targetFamily =
        parsed !== undefined ? resolveEffectiveProviderFamily(parsed.provider, seat, deps.stateDir, input.projectSlug) : "";
      const sameProviderFamily =
        parsed !== undefined &&
        (agent.provider === parsed.provider ||
          agent.provider === `${parsed.provider}/${parsed.model}` ||
          agent.provider.startsWith(`${parsed.provider}/`) ||
          (effectiveFamily !== "" && effectiveFamily === targetFamily));
      if (sameProviderFamily) {
        const sync = deps.setAgentModel ?? setAgentModelViaCli;
        const syncThinking = deps.setAgentThinking ?? setAgentThinkingViaCli;
        const slash = toLane.indexOf("/");
        const modelId = parsed?.model ?? (slash === -1 ? toLane : toLane.slice(slash + 1));
        try {
          const reply = await sync(agent.id, modelId, deps.home);
          if (!reply.ok) {
            parts.push(`failed — ${reply.reason} (lanes.json is the config of record; the next ensure/create runs it)`);
            continue;
          }
          const targetThinking = parsed?.thinking ?? "";
          if ((agent.thinkingOptionId ?? "") !== targetThinking || targetThinking !== "") {
            const thinkingReply = await syncThinking(agent.id, targetThinking, deps.home);
            parts.push(
              thinkingReply.ok
                ? `applied — agent ${agent.id.slice(0, 8)} now runs ${toLane} in place`
                : `applied model (${modelId}); thinking sync failed — ${thinkingReply.reason}`,
            );
          } else {
            parts.push(`applied — agent ${agent.id.slice(0, 8)} now runs ${toLane} in place`);
          }
        } catch (err) {
          parts.push(`failed — ${messageOf(err)} (lanes.json is the config of record)`);
        }
        continue;
      }
      if (deps.handoff !== undefined) {
        const reply = await deps.handoff({ slug: input.projectSlug, seat, action: "start", reason: "provider-change", fromLane, toLane });
        if (!reply.ok) saveLanes(deps.stateDir, { [seat]: fromLane }, input.projectSlug);
        parts.push(reply.ok ? `handoff scheduled — ${agent.id.slice(0, 8)} to ${toLane}` : `handoff refused — ${reply.error}`);
      } else {
        saveLanes(deps.stateDir, { [seat]: fromLane }, input.projectSlug);
        parts.push(`refused — ${seat === "supervisor" ? "Supervisor" : "Lead"} handoff unavailable; the previous lane is restored`);
      }
    }
    if (parts.length === 0) {
      return `skipped — no live supervisor or lead lane changed for project ${input.projectSlug} (applies to the next create)`;
    }
    return parts.join("; ");
  };

  const captureProjectLanesBeforeMachineWrite = (): Map<string, { root: string; lanes: Lanes }> => {
    const map = new Map<string, { root: string; lanes: Lanes }>();
    for (const reg of listProjectRegistrations(deps.stateDir)) {
      if (reg.root === "") continue;
      const loaded = loadLanes(deps.stateDir, reg.slug);
      if (loaded.ok) map.set(reg.slug, { root: reg.root, lanes: loaded.lanes });
    }
    return map;
  };

  const syncInheritedProjectSeatsAfterMachineWrite = async (
    beforeByProject: Map<string, { root: string; lanes: Lanes }>,
    seats: readonly ("supervisor" | "lead")[],
    context?: SurfaceCallContext,
  ): Promise<string | undefined> => {
    if (seats.length === 0 || beforeByProject.size === 0) return undefined;
    const daemon = resolveDaemon(context);
    const summaries: string[] = [];
    for (const [slug, beforeProj] of beforeByProject.entries()) {
      const afterProj = loadLanes(deps.stateDir, slug);
      if (!afterProj.ok) continue;
      const changedSeats = seats.filter((s) => beforeProj.lanes[s] !== afterProj.lanes[s]);
      if (changedSeats.length === 0) continue;
      let hasLiveSeat = false;
      for (const seat of changedSeats) {
        try {
          if ((await seatOf(daemon, seat, slug)) !== undefined) {
            hasLiveSeat = true;
            break;
          }
        } catch {
          // ignore probe error
        }
      }
      if (!hasLiveSeat) continue;
      summaries.push(
        await syncLiveSeatsAfterLaneUpdate({
          projectSlug: slug,
          projectRoot: beforeProj.root,
          before: beforeProj.lanes,
          after: afterProj.lanes,
          seats: changedSeats,
          context,
        }),
      );
    }
    return summaries.length > 0 ? summaries.join("; ") : undefined;
  };

  const resolveSurfaceUserHome = (): string => resolveVaultUserHome(deps.home, deps.userHome);

  const buildCompanionToolsView = (): CompanionPluginView[] => {
    const userHome = resolveSurfaceUserHome();
    return COMPANION_TOOLS_CATALOG.map((entry: CompanionToolCatalogEntry): CompanionPluginView => {
      const pack = inspectFactorySkillPack(userHome);
      const installed = pack.totalSkills > 0;
      const toolSnap = localToolUpdateSnapshot?.["factory-skills-pack"];
      const updateAvailable = !installed
        ? null
        : pack.status === "partial"
          ? true
          : (toolSnap?.updateAvailable ?? false);
      return {
        ...entry,
        capabilities: [...entry.capabilities],
        status: installed ? "running" : "not_installed",
        enabled: installed,
        installKind: installed ? "git" : null,
        installedSource: installed ? pack.path : null,
        currentRevision: installed ? (pack.revision ?? `${pack.installedCoreCount}/${CORE_FACTORY_SKILLS.length} skills`) : null,
        version: installed ? `${pack.totalSkills}.0.0` : null,
        latestRevision: toolSnap?.latestRevision ?? null,
        commitsBehind: null,
        updateAvailable,
        error:
          pack.status === "partial" && pack.missingCoreSkills.length > 0
            ? `Missing core skills: ${pack.missingCoreSkills.join(", ")}`
            : null,
      };
    });
  };

  const executeCompanionToolAction = (
    toolId: "factory-skills-pack",
    action: "install" | "update" | "reload" | "enable" | "disable" | "remove",
  ): { ok: true; summary: string } | { ok: false; reason: string } => {
    const userHome = resolveSurfaceUserHome();
    // factory-skills-pack
    if (action === "reload") {
      const linked = ensureProviderSkillSymlinks(userHome);
      const pack = inspectFactorySkillPack(userHome);
      return {
        ok: true,
        summary: `Re-linked Factory Core Skill Pack (${pack.totalSkills} skill(s) in ~/.agents/skills, ${linked.linked.length} new symlink(s)).`,
      };
    }
    if (action === "disable" || action === "remove") {
      return {
        ok: false,
        reason: "factory-skills-pack is a required Factory companion tool and cannot be disabled or removed",
      };
    }
    localToolUpdateSnapshot = null;
    materializeVaultSkillsFromRuntime(deps.home, action === "update", deps.userHome);
    const res = installOrUpdateFactorySkillPack({
      userHome,
      action: action === "update" ? "update" : "install",
      runner: deps.companionToolRunner,
    });
    if (!res.ok) return { ok: false, reason: res.reason };
    return { ok: true, summary: res.summary };
  };

  const updateInstalledExpo = (): { ok: true } | { ok: false; reason: string } => {
    const userHome = resolveSurfaceUserHome();
    if (!existsSync(join(userHome, '.agents/skills/expo-overview/SKILL.md'))) return { ok: true };
    return installOrUpdateExpoSkillPack({ userHome, action: 'update', runner: deps.companionToolRunner });
  };

  /**
   * Registers the Project a folder names (the onboarding commit's first write):
   * `resolveOrBootstrapProject` initialises Git when the folder is not a
   * repository (the caller has already refused that unless the Owner asked for
   * it) and gives an unborn repository its first commit; `project.json` is
   * written; and, when the daemon exposes it, Paseo's workspace registry is
   * synchronised so the Supervisor seat lands in the folder's own workspace.
   */
  const registerProjectFolder = async (
    folder: string,
    context?: SurfaceCallContext,
  ): Promise<
    | { ok: true; slug: string; root: string; name: string; bootstrapped: boolean }
    | { ok: false; code: string; error: string }
  > => {
    const resolved = resolveOrBootstrapProject(folder, { stateDir: deps.stateDir, paseoHome: deps.home });
    if (!resolved.ok) {
      return failure(resolved.code, `${resolved.reason} — open the Factory panel from a different workspace folder`);
    }
    ensureProjectRegistered(deps.stateDir, resolved);
    const daemon = resolveDaemon(context);
    const existingReg = readProjectRegistration(deps.stateDir, resolved.slug);
    let workspaceId = existingReg?.workspaceId;
    let paseoProjectId = existingReg?.paseoProjectId;
    if (daemon.workspaces?.open !== undefined && (workspaceId === undefined || paseoProjectId === undefined)) {
      try {
        const opened = await daemon.workspaces.open({ cwd: resolved.root });
        if (workspaceId === undefined && typeof opened?.id === "string" && opened.id !== "") workspaceId = opened.id;
        if (paseoProjectId === undefined && typeof opened?.projectId === "string" && opened.projectId !== "") paseoProjectId = opened.projectId;
        if (workspaceId !== undefined || paseoProjectId !== undefined) {
          writeProjectRegistration(deps.stateDir, resolved.slug, {
            root: resolved.root,
            ...(workspaceId !== undefined ? { workspaceId } : {}),
            ...(paseoProjectId !== undefined ? { paseoProjectId } : {}),
          });
        }
      } catch (err) {
        log(`onboarding: workspaces.open(${resolved.root}) did not resolve (${messageOf(err)})`);
      }
    }
    return { ok: true, slug: resolved.slug, root: resolved.root, name: resolved.name, bootstrapped: resolved.bootstrapped };
  };

  const handlers = {
    async openDesignCatalog(_input: {}) {
      try { return { ok: true as const, projects: discoverOpenDesignProjects(resolveSurfaceUserHome()) }; }
      catch (error) { return failure(codeOf(error), messageOf(error)); }
    },
    async openDesignExport(input: { projectId: string }) {
      try { return { ok: true as const, bundle: exportOpenDesignProject(input.projectId, resolveSurfaceUserHome()) }; }
      catch (error) { return failure(codeOf(error), messageOf(error)); }
    },
    async openDesignStatus(input: { projectRoot: string }) {
      try {
        const project = projectOrRefusal(input.projectRoot); if (!project.ok) return project;
        const link = readOpenDesignLink(project.root) ?? readProjectSettings(deps.stateDir, project.slug).openDesignLink;
        const source = link && discoverOpenDesignProjects(resolveSurfaceUserHome()).find(p => p.projectId === link.projectId);
        return { ok: true as const, link: link ?? null, updateAvailable: !!(source && link && (source.digest !== link.digest || source.sourceUpdatedAt > link.sourceUpdatedAt)), sourceAvailable: !!source, syncRequestId: (() => { const source = readProjectSettings(deps.stateDir, project.slug).openDesignSource; return source?.requestId !== source?.acknowledgedRequestId ? source?.requestId : undefined; })() };
      } catch (error) { return failure(codeOf(error), messageOf(error)); }
    },
    async openDesignSync(input: { projectRoot: string; projectId?: string; bundle?: import('./core/open-design/open-design-link.ts').OpenDesignBundle; syncRequestId?: string; expectedDigest?: string }) {
      try {
        const project = projectOrRefusal(input.projectRoot); if (!project.ok) return project;
        return await withProjectIngressLock(deps.stateDir, project.slug, async () => {
          ensureProjectRegistered(deps.stateDir, { root: project.root, slug: project.slug });
          const link = syncOpenDesignLink({ ...input, root: project.root, slug: project.slug, state: deps.stateDir, userHome: resolveSurfaceUserHome() });
          return { ok: true as const, link };
        });
      } catch (error) { return failure(codeOf(error), messageOf(error)); }
    },
    async openDesignPreview(input: { projectRoot: string; operation?: 'preview.url' | 'preview.bundle' }) {
      try {
        const project = projectOrRefusal(input.projectRoot); if (!project.ok) return project;
        if (input.operation === 'preview.url') return { ok: true as const, ...await serveLinkedPreview(project.root) };
        return { ok: true as const, bundle: linkedPreviewBundle(project.root) };
      } catch (error) { return failure(codeOf(error), messageOf(error)); }
    },
    async openDesignUnlink(input: { projectRoot: string }) {
      try {
        const project = projectOrRefusal(input.projectRoot); if (!project.ok) return project;
        await withProjectIngressLock(deps.stateDir, project.slug, async () => unlinkOpenDesign(deps.stateDir, project.slug, project.root));
        return { ok: true as const };
      } catch (error) { return failure(codeOf(error), messageOf(error)); }
    },
    async historyUpgrade(input: UpgradeInput) {
      try { return { ok: true as const, result: await upgradeFactory(deps.factory, input) }; }
      catch (error) { return failure(codeOf(error), messageOf(error)); }
    },
    async historyImport(input: { project?: string; sources?: import("./core/history-import.ts").HistoryImportSource[] }) {
      if (input.sources !== undefined) { if (input.project !== undefined) deps.factory.history.stageForProject(input.project, input.sources); else deps.factory.history.stage(input.sources); }
      else deps.factory.history.drain();
      return { ok: true as const, imports: deps.factory.history.allStatus() };
    },
    async historyImports() { return { ok: true as const, imports: deps.factory.history.allStatus() }; },
    cachedProviders(): readonly ProviderEntry[] {
      return cachedProviderList ?? [];
    },

    sanitizeLane(laneValue: string, context?: SurfaceCallContext): Promise<string> {
      return sanitizeLane(laneValue, context);
    },

    async snapshot(input: { projectRoot?: string }, context?: SurfaceCallContext) {
      // An unresolvable scope degrades to the global view — the panel must
      // render outside git repos; the seats-only acts refuse instead. When a
      // registered Project's directory was deleted on disk (v0.0.35, ADR 0024),
      // reconstruct its identity from `<stateDir>/projects/<slug>/project.json`
      // with `missingRoot: true` rather than snapping back to `All projects`.
      let project: ProjectView | null = null;
      if (input.projectRoot !== undefined && input.projectRoot.trim() !== "") {
        const rawRoot = input.projectRoot.trim();
        const resolved = resolveProject(rawRoot);
        if (resolved.ok) {
          project = {
            slug: resolved.slug,
            root: resolved.root,
            name: basename(resolved.root) || resolved.slug,
            commonDir: resolved.gitCommonDir,
          };
        } else {
          const normInput = realpathSafe(resolve(rawRoot));
          const matched = listProjectRegistrations(deps.stateDir).find(
            (reg) =>
              reg.root === rawRoot ||
              resolve(reg.root) === resolve(rawRoot) ||
              realpathSafe(resolve(reg.root)) === normInput ||
              reg.slug === rawRoot,
          );
          if (matched !== undefined) {
            const missing = !existsSync(matched.root);
            project = {
              slug: matched.slug,
              root: matched.root,
              name: matched.name ?? (basename(matched.root) || matched.slug),
              ...(matched.commonDir !== undefined ? { commonDir: matched.commonDir } : {}),
              ...(missing ? { missingRoot: true } : {}),
            };
          }
          // Since v0.6.0 (ADR 0056) a read never bootstraps: a folder Git cannot
          // answer for and no registration names is simply not a Project yet —
          // onboarding (W7) offers `git init`, the snapshot never does.
        }
      }
      const panelFolder = input.projectRoot !== undefined && input.projectRoot.trim() !== "" ? input.projectRoot.trim() : null;
      const lanes = loadLanes(deps.stateDir, project?.slug);
      if (!lanes.ok) return failure("lanes-unreadable", lanes.reason);
      // The machine-only table (v0.0.38, ADR 0026 §3): what a Reset to
      // Machine Default re-inherits — the client's reset gate plans
      // live-seat transitions against it (Implementation Decision 4). The
      // machine half of the merged load above already parsed, so a refusal
      // here is unreachable in practice but answered by the same law.
      const machineLanes = loadLanes(deps.stateDir);
      if (!machineLanes.ok) return failure("lanes-unreadable", machineLanes.reason);
      const daemon = resolveDaemon(context);
      // v0.0.89 (ADR 0045 §1.3): a selected Project reads its events strictly
      // from `factoryForProject(slug)`. Since v0.6.0 (ADR 0056) there is no
      // all-projects fold: an unscoped snapshot carries no events at all when
      // the registry is wired, and the root Factory's ledger when it is not
      // (the legacy single-Factory entrances).
      // A selected Project that is REGISTERED reads its own Factory's ledger; a
      // repo no Project Factory owns yet falls back to the root Factory's
      // events — a read never mints a Project state directory. One damaged
      // per-Project Ledger degrades to ITS OWN empty stream (v0.0.89, the
      // daemon-half law: never a failed snapshot) — the error rides the
      // Project row.
      const streamErrors = new Map<string, string>();
      const streamForSlug = (slug: string): ProjectEventStream => {
        try {
          return { slug, events: factoryForSlug(slug).ledger.events };
        } catch (error) {
          const message = messageOf(error);
          streamErrors.set(slug, message);
          log(`snapshot: project ${slug} ledger unreadable — ${message}`);
          return { slug, events: [] };
        }
      };
      const scopedStream = (slug: string): ProjectEventStream =>
        readProjectRegistration(deps.stateDir, slug) !== undefined ? streamForSlug(slug) : { slug, events: deps.factory.ledger.events };
      const allEvents: readonly LedgerEvent[] =
        deps.registry === undefined ? deps.factory.ledger.events : project !== null ? scopedStream(project.slug).events : [];
      const bound = agentTaskIndex(allEvents);

      let rawAgents: SurfaceAgentSnapshot[] = [];
      let providers: ProviderEntry[] = [];
      let daemonError: string | null = null;
      let supervisorRaw: SurfaceAgentSnapshot | undefined;
      let leadRaw: SurfaceAgentSnapshot | undefined;
      try {
        const page = await daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
        rawAgents = page.entries.map((entry) => entry.agent).filter((agent) => agent.archivedAt === null);
        const seatOfProject = (seat: "supervisor" | "lead"): SurfaceAgentSnapshot | undefined => {
          return seatCandidates(rawAgents, deps.stateDir, seat, project?.slug)[0];
        };
        supervisorRaw = seatOfProject("supervisor");
        leadRaw = seatOfProject("lead");
        providers = await resolveProviders(daemon);
      } catch (err) {
        daemonError = `daemon unavailable: ${messageOf(err)}`;
      }

      // The live companion half (v0.0.17, ADR 0012 §2–§3): every snapshot reads
      // the daemon's plugin list through the bridge's 15s TTL + single-flight
      // per-`home` cache (v0.0.20, ADR 0013 §1 — the 5s poll cadence shares one
      // `plugin.list.request`, and install/manage invalidate the entry) strictly
      // against `deps.home`, and an unavailable list degrades to the
      // all-`not_installed` default rather than refusing.
      const listPlugins = deps.listPlugins ?? listDaemonPlugins;
      let daemonPlugins: DaemonPluginItem[] | null = null;
      try {
        const listed = await listPlugins(deps.home);
        if (listed.ok) daemonPlugins = listed.plugins;
      } catch {
        // the degrade law — the cards render as not_installed
      }

      // The scoped snapshot narrows to this Project's world: its seat agents
      // and the ledger-bound workers whose task's contract workspace sits
      // inside the project root. Unscoped, every seat and bound worker shows
      // (the global surface shows seats, not a census — strangers stay out).
      const inScope = (agent: SurfaceAgentSnapshot): boolean => {
        if (project === null) {
          return (
            agent.labels.seat !== undefined ||
            supervisorRaw?.id === agent.id ||
            leadRaw?.id === agent.id ||
            inferRoleFromProviderId(agent.provider) === "supervisor" ||
            inferRoleFromProviderId(agent.provider) === "lead" ||
            bound.has(agent.id)
          );
        }
        if (agent.labels.seat !== undefined) return agent.labels.project === project.slug;
        if (supervisorRaw?.id === agent.id || leadRaw?.id === agent.id) return true; // the native-picker seat renders its live state (ADR 0017 §2)
        const task = bound.get(agent.id);
        return task !== undefined && taskInProject(task, project.root, project.slug);
      };
      const relevant = rawAgents.filter(inScope).slice(0, SNAPSHOT_AGENT_CAP);
      const agents: AgentView[] = [];
      for (const agent of relevant) {
        const seatOverride = agent.id === supervisorRaw?.id ? ("supervisor" as const) : agent.id === leadRaw?.id ? ("lead" as const) : undefined;
        agents.push(agentViewOf(agent, bound.get(agent.id) ?? null, seatOverride, project?.slug));
      }
      const supervisor = supervisorRaw === undefined ? null : (agents.find((agent) => agent.id === supervisorRaw!.id) ?? null);
      const lead = leadRaw === undefined ? null : (agents.find((agent) => agent.id === leadRaw!.id) ?? null);

      // v0.6.1 (ADR 0057 §5): the Project's live Supervisor candidate chats —
      // the raw agent census (a picker chat carries no task binding, so the
      // scoped `relevant` list never sees it), narrowed to the Project's
      // workspace and `isSupervisorCandidate`. Gathered only while a live
      // Supervisor holds the seat: the panel's "Use this chat as Supervisor"
      // rows are the Owner's choice between two live chats, and with the seat
      // vacant the auto-bind door owns recovery.
      let supervisorCandidates: AgentView[] = [];
      if (project !== null && supervisorRaw !== undefined) {
        for (const agent of rawAgents) {
          if (supervisorCandidates.length >= 5) break;
          if (agent.id === supervisorRaw.id || agent.id === leadRaw?.id) continue;
          if (!agentInProjectWorkspace(agent, project)) continue;
          if (!isSupervisorCandidate(agent, { stateDir: deps.stateDir, slug: project.slug })) continue;
          supervisorCandidates.push(agentViewOf(agent, null, undefined, project?.slug));
        }
      }

      const scopedProject = project;
      const events =
        scopedProject === null
          ? allEvents
          : allEvents.filter(
              (evt) => !("task" in evt) || (typeof evt.task === "string" && taskInProject(evt.task, scopedProject.root, scopedProject.slug)),
            );
      const enrichProjectView = (entry: {
        slug: string;
        root: string;
        name?: string;
        commonDir?: string;
        missingRoot?: boolean;
        supervisorId?: string | null;
        leadId?: string | null;
      }): ProjectView => {
        const reg = readProjectRegistration(deps.stateDir, entry.slug);
        const liveSup =
          seatAgentByIdentity(rawAgents, entry.slug, "supervisor");
        const liveLead =
          seatAgentByIdentity(rawAgents, entry.slug, "lead");
        const resolvedCommonDir =
          entry.commonDir ??
          reg?.commonDir ??
          (!entry.missingRoot && existsSync(entry.root)
            ? (() => {
                const r = resolveProject(entry.root);
                return r.ok ? r.gitCommonDir : join(entry.root, ".git");
              })()
            : join(entry.root, ".git"));
        const ledgerError = streamErrors.get(entry.slug);
        return {
          slug: entry.slug,
          root: entry.root,
          name: entry.name ?? reg?.name ?? (basename(entry.root) || entry.slug),
          ...(resolvedCommonDir !== undefined ? { commonDir: resolvedCommonDir } : {}),
          ...(entry.missingRoot ? { missingRoot: true } : {}),
          ...(ledgerError !== undefined ? { ledgerError } : {}),
          supervisorId: liveSup?.id ?? reg?.supervisor ?? entry.supervisorId ?? null,
          leadId: liveLead?.id ?? reg?.lead ?? entry.leadId ?? null,
        };
      };
      const enrichedProject = scopedProject === null ? null : enrichProjectView(scopedProject);

      const updateSnap = localUpdateSnapshot ?? getCachedPluginUpdateStatus(deps.home);
      // The Project Usage half (v0.0.87, ADR 0043 §4): the gatherer-owned
      // rollup read — lazily backfilled ONCE from `<paseoHome>/agents/` —
      // layered into the pure fold (the vault-status precedent). Unscoped or
      // unwired, it degrades to null, never a failed snapshot.
      let usageFile: Awaited<ReturnType<UsageRuntime["loadOrBackfillProjectUsage"]>> = undefined;
      if (enrichedProject !== null && deps.usage !== undefined) {
        try {
          usageFile = await deps.usage.loadOrBackfillProjectUsage(enrichedProject.slug);
        } catch (error) {
          log(`usage: rollup read of ${enrichedProject.slug} deferred — ${messageOf(error)}`);
        }
      }
      // The Project panel view-model (v0.6.0, ADR 0056 §5), projected here from
      // the same gathered halves the fold read — the client only renders it.
      const panelRegistration = enrichedProject === null ? undefined : readProjectRegistration(deps.stateDir, enrichedProject.slug);
      // v0.6.1 (ADR 0057 §5): the held Supervisor-mail count — reports waiting
      // with no live Supervisor to receive them. An unreadable mailbox is not a
      // snapshot failure; the count reads 0.
      let heldSupervisorMailCount = 0;
      if (enrichedProject !== null) {
        try {
          heldSupervisorMailCount = readLeadMailbox(join(projectStateDir(deps.stateDir, enrichedProject.slug), "mailbox.jsonl")).supervisorQueued.length;
        } catch {
          heldSupervisorMailCount = 0;
        }
      }
      const panelMissingPrerequisites = buildCompanionToolsView()
        .filter((tool) => tool.status !== "running" || tool.error !== null)
        .map((tool) => tool.title);
      const profileInfo = laneProfilesGather(enrichedProject?.slug, lanes.lanes);
      const view = foldView({
        stateDir: deps.stateDir,
        generatedAt: new Date().toISOString(),
        lanes: lanes.lanes,
        events,
        usage: usageFile,
        daemon: { agents, supervisor, lead, providers, daemonError },
        // v0.0.17 (ADR 0012 §2) & v0.0.25 (ADR 0012 §3–§4): the daemon plugin
        // list joined against Core + companion catalog and cached update check.
        companions: {
          plugins: daemonPlugins,
          updates: updateSnap?.statuses ?? null,
          checkedAt: updateSnap?.checkedAt ?? null,
        },
        // v0.0.21 (ADR 0014 §4): the Private vault status half, gathered per
        // snapshot the way the companion list is — a probe that cannot answer
        // degrades inside the view's own `error` field, never a refusal.
        vault: await vaultStatusOf(),
        project: enrichedProject,
        panel: {
          ...handoffPanelFacts(enrichedProject?.slug, foldTasks(events), lanes.lanes),
          seatLanes: seatLanesOf(enrichedProject?.slug, lanes.lanes),
          profile: { active: profileInfo.profiles.find(p => p.id === profileInfo.activeProfileId) ?? null, list: profileInfo.profiles, modified: profileInfo.activeProfileModified },
          project: enrichedProject,
          registered: panelRegistration !== undefined,
          folder: panelFolder,
          git: inspectGitReadiness(panelFolder),
          missingPrerequisites: panelMissingPrerequisites,
          openDesign: enrichedProject === null || enrichedProject.missingRoot === true ? null : probeOpenDesign(deps.stateDir, enrichedProject.slug, enrichedProject.root),
          rotationState: panelRegistration?.rotationState ?? null,
          handoffRequestedAt: panelRegistration?.handoffRequestedAt ?? null,
          heldSupervisorMailCount,
          supervisorCandidates,
          now: Date.now(),
        },
      });
      // v0.0.38 (ADR 0026 §5): the Lane profile half — the gatherer-owned
      // filesystem probe layered over the fold (the vault-status precedent),
      // so the view carries the Owner's profile library and the scope's
      // active-profile / override state without the fold learning files.
      let configuredPacks: string[] | undefined;
      try { configuredPacks = enrichedProject ? readProjectSettings(deps.stateDir, enrichedProject.slug).skillPacks : undefined; }
      catch { configuredPacks = []; } // a damaged settings record does not widen skills.
      return {
        ok: true as const,
        view: {
          ...view,
          machineLanes: machineLanes.lanes,
          skillHub: inspectSkillHub({ slpLanes: lanes.lanes, userHome: resolveSurfaceUserHome(), projectRoot: enrichedProject?.root, configuredPacks }),
          companionTools: buildCompanionToolsView(),
          helperMcps: helperMcpRoster(discoverHelperMcps({ stateDir: deps.stateDir, userHome: resolveSurfaceUserHome() }).servers),
          ...profileInfo,
        },
      };
    },

    /**
     * The all-Projects seat directory (v0.6.1 W4 spike, ADR 0057 §8/§11): one
     * read the client's header-button/composer-pill starter polls. Per
     * registered Project — the standing seats through the same
     * `seatCandidates` resolution the snapshot uses, Peers through BOTH
     * identification paths (the spool's spawn labels and the ledger's own
     * agent→task binding), the root workspace id, and the Needs-you count
     * folded by the same `foldPanel` the workspace panel renders. The
     * daemon-half law holds: an unreachable daemon degrades to an empty seat
     * list with `daemonError` named, never a failed read.
     */
    async seatsDirectory(_input: {}, context?: SurfaceCallContext) {
      const daemon = resolveDaemon(context);
      let rawAgents: SurfaceAgentSnapshot[] = [];
      let daemonError: string | null = null;
      try {
        const page = await daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
        rawAgents = page.entries.map((entry) => entry.agent).filter((agent) => agent.archivedAt === null);
      } catch (err) {
        daemonError = `daemon unavailable: ${messageOf(err)}`;
      }
      const missingPrerequisites = buildCompanionToolsView()
        .filter((tool) => tool.status !== "running" || tool.error !== null)
        .map((tool) => tool.title);
      const directoryRows: Parameters<typeof directorySeatOf>[] = [];
      const projects: ProjectDirectoryEntry[] = [];
      for (const registration of listProjectRegistrations(deps.stateDir)) {
        const supervisorRaw = seatCandidates(rawAgents, deps.stateDir, "supervisor", registration.slug)[0];
        const leadRaw = seatCandidates(rawAgents, deps.stateDir, "lead", registration.slug)[0];
        // Peers: the spool's labeled spawn shape first, then the ledger-bound
        // path on still-open tasks (the panel's peerRows law).
        let events: readonly LedgerEvent[] = [];
        try {
          events = factoryForSlug(registration.slug).ledger.events;
        } catch (err) {
          log(`seatsDirectory: project ${registration.slug} ledger unreadable — ${messageOf(err)}`);
        }
        const tasks = foldTasks(events);
        const bound = agentTaskIndex(events);
        const peers: SurfaceAgentSnapshot[] = [];
        for (const agent of rawAgents) {
          if (agent.id === supervisorRaw?.id || agent.id === leadRaw?.id) continue;
          if (agent.labels.seat === "agent" && agent.labels.project === registration.slug) {
            peers.push(agent);
            continue;
          }
          if (agent.labels.seat !== undefined) continue;
          const task = bound.get(agent.id);
          if (task === undefined || !taskInProject(task, registration.root, registration.slug)) continue;
          const view = tasks.find((entry) => entry.task === task);
          if (view !== undefined && (view.status === "accepted" || view.status === "closed")) continue;
          peers.push(agent);
        }
        // The Needs-you count: the same panel projection the workspace panel
        // renders for this Project (the snapshot's own gather, reused).
        const supervisor = supervisorRaw === undefined ? null : agentViewOf(supervisorRaw, null, "supervisor", registration.slug);
        const lead = leadRaw === undefined ? null : agentViewOf(leadRaw, null, "lead", registration.slug);
        const agents = [
          ...(supervisor === null ? [] : [supervisor]),
          ...(lead === null ? [] : [lead]),
          ...peers.map((agent) => agentViewOf(agent, bound.get(agent.id) ?? agent.labels.task ?? null, undefined, registration.slug)),
        ];
        let heldSupervisorMailCount = 0;
        try {
          heldSupervisorMailCount = readLeadMailbox(join(projectStateDir(deps.stateDir, registration.slug), "mailbox.jsonl")).supervisorQueued.length;
        } catch {
          heldSupervisorMailCount = 0; // an unreadable mailbox is not a failed directory read
        }
        const effective = loadLanes(deps.stateDir, registration.slug);
        const profiles = effective.ok ? laneProfilesGather(registration.slug, effective.lanes) : { profiles: [], activeProfileId: null, activeProfileModified: false, hasProjectLaneOverride: false };
        const panel = foldPanel({
          ...(effective.ok ? handoffPanelFacts(registration.slug, tasks, effective.lanes) : {}),
          ...(effective.ok ? { seatLanes: seatLanesOf(registration.slug, effective.lanes) } : {}),
          profile: { active: profiles.profiles.find(p => p.id === profiles.activeProfileId) ?? null, list: profiles.profiles, modified: profiles.activeProfileModified },
          project: { slug: registration.slug, root: registration.root, ...(registration.name !== undefined ? { name: registration.name } : {}) },
          registered: true,
          folder: null,
          git: { gitRepo: true, hasCommits: true },
          tasks,
          agents,
          supervisor,
          lead,
          missingPrerequisites,
          openDesign: existsSync(registration.root) ? probeOpenDesign(deps.stateDir, registration.slug, registration.root) : null,
          rotationState: registration.rotationState ?? null,
          handoffRequestedAt: registration.handoffRequestedAt ?? null,
          heldSupervisorMailCount,
          supervisorCandidates: [], // the adopt rows are a live-Supervisor panel concern, never a Needs-you item
          now: Date.now(),
        });
        const workspaceId = registration.workspaceId ?? supervisorRaw?.workspaceId ?? leadRaw?.workspaceId ?? null;
        projects.push({ slug: registration.slug, root: registration.root, workspaceId, needsYouCount: panel.needsYou.length });
        if (supervisorRaw !== undefined) directoryRows.push([registration, supervisorRaw, panel.seats!.supervisor, profiles]);
        if (leadRaw !== undefined) directoryRows.push([registration, leadRaw, panel.seats!.lead, profiles]);
        for (const row of panel.seats!.peers) { const peer = peers.find(p => p.id === row.agentId); if (peer) directoryRows.push([registration, peer, row, profiles]); }
      }
      return { ok: true as const, seats: directoryRows.map(args => directorySeatOf(...args)), projects, daemonError };
    },

    async lanesSet(input: { lane: LaneName; value: string; projectRoot?: string }, context?: SurfaceCallContext) {
      let projectSlug: string | undefined;
      let projectRoot: string | undefined;
      if (input.projectRoot !== undefined) {
        const project = projectOrRefusal(input.projectRoot);
        if (!project.ok) return project;
        projectSlug = project.slug;
        projectRoot = project.root;
      }
      const daemon = resolveDaemon(context);
      let providers: ProviderEntry[] = [];
      try {
        providers = await resolveProviders(daemon);
      } catch {
        // best-effort provider catalog lookup
      }
      const sanitizedValue = sanitizeLaneWithProviders(input.value.trim(), providers);
      const before = projectSlug !== undefined ? loadLanes(deps.stateDir, projectSlug) : undefined;
      if (projectSlug !== undefined && before !== undefined && !before.ok) return failure("lanes-unreadable", before.reason);
      const beforeByProject = projectSlug === undefined ? captureProjectLanesBeforeMachineWrite() : undefined;
      const saved = saveLanes(deps.stateDir, { [input.lane]: sanitizedValue }, projectSlug);
      if (!saved.ok) return failure("invalid-lane", saved.reason);
      let modelSync: string;
      if (projectSlug !== undefined && projectRoot !== undefined && before?.ok) {
        // The project-scoped Live-Seat Transition Law (v0.0.38, ADR 0026 §3/§4):
        // same provider family updates the live seat in place; a family change
        // retires/rotates it — never a blind model push across adapters.
        if (input.lane === "supervisor" || input.lane === "lead") {
          modelSync = await syncLiveSeatsAfterLaneUpdate({
            projectSlug,
            projectRoot,
            before: before.lanes,
            after: saved.lanes,
            seats: [input.lane],
            context,
          });
        } else {
          modelSync = "skipped — not a seat lane (applies to the next create)";
        }
      } else {
        // The unscoped machine-table save: first apply the Live-Seat Transition
        // Law across any registered Project inheriting the machine lane; if no
        // registered Project has a live seat, fall back to the legacy unscoped
        // seat lookup.
        modelSync = "skipped — not a seat lane (applies to the next create)";
        if (input.lane === "supervisor" || input.lane === "lead") {
          const seat = input.lane;
          const inheritedSync =
            beforeByProject !== undefined
              ? await syncInheritedProjectSeatsAfterMachineWrite(beforeByProject, [seat], context)
              : undefined;
          if (inheritedSync !== undefined) {
            modelSync = inheritedSync;
          } else {
            try {
              const agent = await seatOf(daemon, seat, projectSlug);
              if (agent !== undefined) {
                const sync = deps.setAgentModel ?? setAgentModelViaCli;
                const syncThinking = deps.setAgentThinking ?? setAgentThinkingViaCli;
                const laneValue = saved.lanes[seat];
                const parsed = parseLane(laneValue);
                const slash = laneValue.indexOf("/");
                const modelId = parsed?.model ?? (slash === -1 ? laneValue : laneValue.slice(slash + 1));
                const reply = await sync(agent.id, modelId, deps.home);
                const hadThinkingInInput = parseLane(input.value.trim())?.thinking !== undefined;
                const shouldClearThinking = parsed?.thinking === undefined && ((agent.thinkingOptionId ?? "") !== "" || hadThinkingInInput);
                if (reply.ok && (parsed?.thinking !== undefined || shouldClearThinking)) {
                  const thinkingReply = await syncThinking(agent.id, parsed?.thinking ?? "", deps.home);
                  modelSync = thinkingReply.ok
                    ? `applied — agent ${agent.id.slice(0, 8)} now runs ${laneValue}`
                    : `applied model (${modelId}); thinking sync failed — ${thinkingReply.reason}`;
                } else {
                  modelSync = reply.ok
                    ? `applied — agent ${agent.id.slice(0, 8)} now runs ${laneValue}`
                    : `failed — ${reply.reason} (lanes.json is the config of record; the next ensure/create runs it)`;
                }
              } else {
                modelSync = `skipped — no live ${seat} agent${projectSlug === undefined ? "" : ` for project ${projectSlug}`} on this daemon`;
              }
            } catch (err) {
              modelSync = `failed — ${messageOf(err)} (lanes.json is the config of record)`;
            }
          }
        }
      }
      log(`lanes: ${input.lane}=${saved.lanes[input.lane]}${projectSlug === undefined ? "" : ` (project ${projectSlug})`} (${modelSync})`);
      // Reconcile `<home>/config.json` (v0.6.1, ADR 0057 §11): the unscoped
      // machine save reconciles from the table it just wrote; a Project-scoped
      // save reconciles from the MACHINE scope only, so a Project override
      // never rewrites the daemon-wide `factory-*` entries — the before-create
      // rewrite applies it at launch.
      reconcileRoleProvidersFromScope(projectSlug === undefined ? saved.lanes : undefined);
      const effective = loadLanes(deps.stateDir, projectSlug);
      return { ok: true as const, lanes: effective.ok ? effective.lanes : saved.lanes, modelSync };
    },

    /**
     * The atomic batch lane save (v0.0.38, ADR 0026 §1/§5): every lane lands
     * in ONE write (the Watch & Retro card's dual-save race fix), the live
     * seats follow the same transition law a single save does, and the daemon
     * config reconciles from the saved scope's effective lanes.
     */
    async lanesSetBatch(input: { lanes: Partial<Record<LaneName, string>>; projectRoot?: string }, context?: SurfaceCallContext) {
      let projectSlug: string | undefined;
      let projectRoot: string | undefined;
      if (input.projectRoot !== undefined) {
        const project = projectOrRefusal(input.projectRoot);
        if (!project.ok) return project;
        projectSlug = project.slug;
        projectRoot = project.root;
      }
      const daemon = resolveDaemon(context);
      let providers: ProviderEntry[] = [];
      try {
        providers = await resolveProviders(daemon);
      } catch {
        // best-effort provider catalog lookup
      }
      const sanitized: Partial<Record<LaneName, string>> = {};
      for (const [lane, value] of Object.entries(input.lanes)) {
        if (value === undefined) continue;
        sanitized[lane as LaneName] = sanitizeLaneWithProviders(value.trim(), providers);
      }
      const before = projectSlug !== undefined ? loadLanes(deps.stateDir, projectSlug) : undefined;
      if (projectSlug !== undefined && before !== undefined && !before.ok) return failure("lanes-unreadable", before.reason);
      const beforeByProject = projectSlug === undefined ? captureProjectLanesBeforeMachineWrite() : undefined;
      let saved: { lanes: Lanes; path: string };
      try {
        saved = saveLanesBatch(deps.stateDir, sanitized, projectSlug);
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
      let modelSync = "skipped — not a seat lane (applies to the next create)";
      const seats = (["supervisor", "lead"] as const).filter((seat) => sanitized[seat] !== undefined);
      if (projectSlug !== undefined && projectRoot !== undefined && before?.ok) {
        if (seats.length > 0) {
          modelSync = await syncLiveSeatsAfterLaneUpdate({
            projectSlug,
            projectRoot,
            before: before.lanes,
            after: saved.lanes,
            seats,
            context,
          });
        }
      } else if (beforeByProject !== undefined && seats.length > 0) {
        const inheritedSync = await syncInheritedProjectSeatsAfterMachineWrite(beforeByProject, seats, context);
        if (inheritedSync !== undefined) modelSync = inheritedSync;
      }
      log(`lanes: batch ${Object.keys(sanitized).join("+")}${projectSlug === undefined ? "" : ` (project ${projectSlug})`} → ${saved.path} (${modelSync})`);
      // v0.6.1 (ADR 0057 §11): only the unscoped machine batch reconciles the
      // daemon globals from the table it wrote; a Project batch stays
      // machine-anchored (the before-create rewrite applies the override).
      reconcileRoleProvidersFromScope(projectSlug === undefined ? saved.lanes : undefined);
      const effective = loadLanes(deps.stateDir, projectSlug);
      return { ok: true as const, lanes: effective.ok ? effective.lanes : saved.lanes, modelSync };
    },

    /**
     * The per-Project override reset (v0.0.38, ADR 0026 §2): removes the
     * Project's `lanes.json` so it inherits the machine table again, clearing
     * its recorded active profile — live seats follow the transition law
     * against the machine lanes they now run under.
     */
    async lanesReset(input: { projectRoot: string }, context?: SurfaceCallContext) {
      const project = projectOrRefusal(input.projectRoot);
      if (!project.ok) return project;
      const before = loadLanes(deps.stateDir, project.slug);
      if (!before.ok) return failure("lanes-unreadable", before.reason);
      let reset: { lanes: Lanes; removed: boolean };
      try {
        reset = resetProjectLanes(deps.stateDir, project.slug);
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
      const modelSync = await syncLiveSeatsAfterLaneUpdate({
        projectSlug: project.slug,
        projectRoot: project.root,
        before: before.lanes,
        after: reset.lanes,
        context,
      });
      log(`lanes: reset project ${project.slug} to the machine table (removed=${reset.removed}) (${modelSync})`);
      // v0.6.1 (ADR 0057 §11): the reset is Project-scoped, so the daemon
      // globals reconcile from the machine scope — never the reset Project's
      // inherited table (which equals the machine table anyway).
      reconcileRoleProvidersFromScope();
      const effective = loadLanes(deps.stateDir, project.slug);
      return { ok: true as const, lanes: effective.ok ? effective.lanes : reset.lanes, removed: reset.removed, modelSync };
    },

    /**
     * `Lane profile` save (v0.0.38, ADR 0026 §2/§5): creates or updates one
     * Owner-authored 6-lane preset — the current scope's effective table when
     * `lanes` is omitted (the `+ Save as Profile…` act), validated whole
     * before anything is written.
     */
    async profilesSave(input: { id?: string; name: string; description?: string; lanes?: Lanes; projectRoot?: string }, _context?: SurfaceCallContext) {
      let lanes = input.lanes;
      if (lanes === undefined) {
        let projectSlug: string | undefined;
        if (input.projectRoot !== undefined) {
          const project = projectOrRefusal(input.projectRoot);
          if (!project.ok) return project;
          projectSlug = project.slug;
        }
        const current = loadLanes(deps.stateDir, projectSlug);
        if (!current.ok) return failure("lanes-unreadable", current.reason);
        lanes = current.lanes;
      }
      try {
        const profile = saveLaneProfile(deps.stateDir, {
          ...(input.id === undefined ? {} : { id: input.id }),
          name: input.name,
          ...(input.description === undefined ? {} : { description: input.description }),
          lanes,
        });
        const summary = `Saved Lane profile "${profile.name}" (${profile.id}).`;
        log(`profiles: ${summary}`);
        return { ok: true as const, profile: laneProfileViewOf(profile), summary };
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
    },

    /**
     * `Lane profile` apply (v0.0.38, ADR 0026 §2/§5): Copy-on-Apply — all six
     * lanes land in ONE atomic write into the Project's override file (or the
     * machine table when no `projectRoot` is given), `activeProfileByScope`
     * records the act, and live seats follow the transition law.
     */
    async profilesApply(input: { profileId: string; projectRoot?: string }, context?: SurfaceCallContext) {
      let projectSlug: string | undefined;
      let projectRoot: string | undefined;
      if (input.projectRoot !== undefined) {
        const project = projectOrRefusal(input.projectRoot);
        if (!project.ok) return project;
        projectSlug = project.slug;
        projectRoot = project.root;
      }
      const before = projectSlug !== undefined ? loadLanes(deps.stateDir, projectSlug) : loadLanes(deps.stateDir);
      if (!before.ok) return failure("lanes-unreadable", before.reason);
      const beforeByProject = projectSlug === undefined ? captureProjectLanesBeforeMachineWrite() : undefined;
      let applied: { profile: LaneProfile; lanes: Lanes; path: string };
      try {
        applied = applyLaneProfile(deps.stateDir, input.profileId, projectSlug);
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
      let modelSync = "skipped — applied to the machine table (no Project seats to sync)";
      if (projectSlug !== undefined && projectRoot !== undefined) {
        modelSync = await syncLiveSeatsAfterLaneUpdate({
          projectSlug,
          projectRoot,
          before: before.lanes,
          after: applied.lanes,
          context,
        });
      } else if (beforeByProject !== undefined) {
        const inheritedSync = await syncInheritedProjectSeatsAfterMachineWrite(
          beforeByProject,
          ["supervisor", "lead"],
          context,
        );
        if (inheritedSync !== undefined) modelSync = inheritedSync;
      }
      log(`profiles: applied "${applied.profile.name}" (${applied.profile.id})${projectSlug === undefined ? " to the machine table" : ` to project ${projectSlug}`} → ${applied.path} (${modelSync})`);
      // v0.6.1 (ADR 0057 §11): a profile applied to the MACHINE table
      // reconciles the globals from it; a profile applied to a Project stays
      // machine-anchored (the Project's override applies at agent create).
      reconcileRoleProvidersFromScope(projectSlug === undefined ? applied.lanes : undefined);
      const effective = loadLanes(deps.stateDir, projectSlug);
      return { ok: true as const, lanes: effective.ok ? effective.lanes : applied.lanes, modelSync };
    },

    /**
     * `Lane profile` delete (v0.0.38, ADR 0026 §2/§5): tombstones the id and
     * clears every `activeProfileByScope` entry naming it — Copy-on-Apply
     * means no Project's `lanes.json` changes.
     */
    async profilesDelete(input: { profileId: string }, _context?: SurfaceCallContext) {
      let deleted: boolean;
      try {
        deleted = deleteLaneProfile(deps.stateDir, input.profileId);
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
      const summary = deleted
        ? `Deleted Lane profile ${input.profileId}.`
        : `No Lane profile ${input.profileId} exists — nothing deleted.`;
      log(`profiles: ${summary}`);
      return { ok: true as const, deleted, summary };
    },

    async supervisorEnsure(input: { projectRoot: string; message?: string }, context?: SurfaceCallContext) {
      return ensureSeat("supervisor", input, context);
    },

    /**
     * "Use this chat as Supervisor" (v0.6.1, ADR 0057 §5): adopt a live
     * candidate chat as the Project's Supervisor. Refuses an agent outside the
     * Project's workspace, one that is not a candidate, and one already bound
     * as the Lead or a Peer. On success the previous Supervisor is released
     * (archived, or marked released per the W1 parented-Lead rule) BEFORE the
     * new binding, the agent is labelled, the binding is written through the
     * state writer, and the first turn carries the Seat kickoff packet plus
     * every held report.
     */
    async supervisorAdopt(input: { projectRoot: string; agentId: string }, context?: SurfaceCallContext) {
      const project = projectOrRefusal(input.projectRoot);
      if (!project.ok) return project;
      const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
      if (agentId === "") {
        return failure("invalid-agent", "adopt needs the agent id of the chat to adopt — pass the candidate chat's agentId");
      }
      return serializeSeat(`${project.slug}:supervisor`, async () => {
        const daemon = resolveDaemon(context);
        const handoff = readHandoffProgress(deps.stateDir, project.slug, "supervisor");
        if (handoff && handoff.state !== "done") return failure("handoff-in-progress", "The Supervisor is handing off; wait for its successor");
        const registration = readProjectRegistration(deps.stateDir, project.slug);
        const agent = await liveAgentById(daemon, agentId);
        if (agent === undefined) {
          return failure("agent-not-live", `agent ${agentId} is not a live chat — open it in Paseo first, then adopt it as the Supervisor`);
        }
        if (!agentInProjectWorkspace(agent, project)) {
          return failure("agent-outside-project", `agent ${agentId} does not sit in ${project.root}'s workspace — open the chat inside the Project before adopting it as the Supervisor`);
        }
        if (agent.id === registration?.lead || agent.labels.seat === "lead" || inferRoleFromProviderId(agent.provider) === "lead") {
          return failure("agent-bound-elsewhere", `agent ${agentId} is this Project's Lead — the Lead never becomes its own Supervisor`);
        }
        if ((typeof agent.labels.task === "string" && agent.labels.task !== "") || inferRoleFromProviderId(agent.provider) === "agent") {
          return failure("agent-bound-elsewhere", `agent ${agentId} is a task Peer — a Peer never becomes the Supervisor`);
        }
        if (!isSupervisorCandidate(agent, { stateDir: deps.stateDir, slug: project.slug })) {
          const loaded = loadLanes(deps.stateDir, project.slug);
          return failure(
            "agent-not-candidate",
            `agent ${agentId} is not a Supervisor candidate — start it on the factory-supervisor provider, or open it on the Supervisor lane (${loaded.ok ? loaded.lanes.supervisor : "the configured lane"}) inside this Project`,
          );
        }
        // The release precedes the binding so the retire sweep can only name
        // the old seat (the candidate is still unbound at that point).
        if (registration?.supervisor !== agentId) {
          const retired = await retireSeatUnlocked("supervisor", project.slug, project.root, context);
          if (!retired.ok && retired.code !== "no-supervisor") return retired;
        }
        await bindSupervisorCandidate(daemon, project, agent);
        return {
          ok: true as const,
          agentId: agent.id,
          slug: project.slug,
          summary: `adopted ${agent.id} as ${project.slug}'s Supervisor — kickoff sent, held reports delivered, the previous seat released`,
        };
      });
    },

    /**
     * The session-open auto-bind door (v0.6.1, ADR 0057 §5) — see
     * `supervisorSessionOpenedUnlocked`. Serialized on the Project's supervisor
     * seat lane like every seat act; void by design.
     */
    async supervisorSessionOpened(input: { agentId: string; cwd: string; workspaceId?: string | null }, context?: SurfaceCallContext): Promise<void> {
      const cwd = typeof input?.cwd === "string" ? input.cwd.trim() : "";
      if (cwd === "") return;
      const resolved = resolveProject(cwd);
      if (!resolved.ok) return;
      await serializeSeat(`${resolved.slug}:supervisor`, () => supervisorSessionOpenedUnlocked(input, context));
    },

    /**
     * The released-Supervisor settle door (v0.6.1, ADR 0057 §4): the
     * Lead-mailbox runtime's lost-Lead recovery fires it when a parented Lead
     * is archived from OUTSIDE the plugin — every released Supervisor waiting
     * on that Lead archives (the cascade risk died with the Lead) and its
     * record clears. The plugin's own Lead archives settle the same way
     * through `archiveSeatAgent`. Void by design: a failed archive logs and
     * the record stands for the next attempt.
     */
    async settleReleasedSupervisor(input: { slug: string; leadAgentId: string }, context?: SurfaceCallContext): Promise<void> {
      await archiveReleasedSupervisorWaitingOnLead(resolveDaemon(context), input.slug, input.leadAgentId);
    },

    async supervisorStart(input: { projectRoot: string; directive?: string }, context?: SurfaceCallContext) {
      return startSupervisor(input, context);
    },

    async leadEnsure(input: { projectRoot: string; message?: string }, context?: SurfaceCallContext) {
      return ensureSeat("lead", input, context);
    },

    async supervisorRevoke(input: { projectRoot?: string }, context?: SurfaceCallContext) {
      if (input.projectRoot === undefined) {
        // The legacy global act (pre-0.0.14): with per-Project seats it must
        // not retire an arbitrary Project's supervisor — the first live seat
        // the daemon returns is a choice the caller never made. One live
        // supervisor stays the legacy act; two or more refuse by name.
        const daemon = resolveDaemon(context);
        let live: SurfaceAgentSnapshot[] = [];
        try {
          live = await liveSeatCandidates(daemon, deps.stateDir, "supervisor");
        } catch (err) {
          return failure("daemon-unavailable", `cannot read the daemon's agents: ${messageOf(err)}`);
        }
        if (live.length > 1) {
          const projects = [...new Set(live.map((agent) => agent.labels.project ?? "(unlabeled)"))].join(", ");
          return failure(
            "ambiguous-supervisor",
            `more than one live supervisor exists (${projects}) — an unscoped revoke must not pick between Projects' seats; pass projectRoot to name the one to retire`,
          );
        }
        return retireSeat("supervisor", undefined, undefined, context);
      }
      const project = projectOrRefusal(input.projectRoot);
      if (!project.ok) return project;
      return retireSeat("supervisor", project.slug, project.root, context);
    },

    async handoff(input: { projectRoot: string; seat: string; lane?: string }, action: HandoffAction, _context?: SurfaceCallContext): Promise<HandoffReply> {
      const project = projectOrRefusal(input.projectRoot);
      if (!project.ok) return project;
      if (!deps.handoff) return failure("handoff-unavailable", "Handoff runtime is unavailable");
      return deps.handoff({ slug: project.slug, seat: input.seat, action, ...(input.lane ? { lane: input.lane } : {}) });
    },

    async leadRotate(input: { projectRoot: string }, context?: SurfaceCallContext) {
      const project = projectOrRefusal(input.projectRoot);
      if (!project.ok) return project;
      return retireSeat("lead", project.slug, project.root, context);
    },

    /**
     * The session-open sweep door (v0.0.31, ADR 0017 §5): the shell's
     * `agent.session_open` hook calls this when a Supervisor session opens or
     * binds for a Project — the same orphaned `local_checkout` sweep
     * `ensureSeat("supervisor")` and `projectReset` run. Void by design: the
     * sweep is best-effort and never its caller's failure.
     */
    async sweepProjectWorkspaces(
      input: { projectRoot: string; keepWorkspaceIds?: readonly string[] },
      context?: SurfaceCallContext,
    ): Promise<void> {
      const project = projectOrRefusal(input.projectRoot);
      if (!project.ok) return;
      await sweepOrphanedLocalCheckoutWorkspaces(resolveDaemon(context), project, input.keepWorkspaceIds);
    },

    /**
     * The onboarding wizard's read-only look at the workspace's folder (v0.6.0
     * W7, ADR 0056): Git repository yes/no, whether it holds a commit, whether a
     * Project is already registered for it, a Lead or Supervisor already live
     * there, and the prerequisite status the Install-all step reads. It uses the
     * folder the panel is bound to — no Finder dialog, no pasted path — and it
     * never writes: no `git init`, no registration, no state directory.
     */
    async onboardingInspect(input: { folder: string }, context?: SurfaceCallContext) {
      const raw = (input.folder ?? "").trim();
      if (raw === "") {
        return failure("missing-directory", "there is no folder to inspect — open the Factory panel from a workspace folder");
      }
      const abs = resolve(raw);
      let isDirectory = false;
      try {
        isDirectory = statSync(abs).isDirectory();
      } catch {
        return failure("missing-directory", `${abs} does not exist on disk — open the Factory panel from an existing workspace folder`);
      }
      if (!isDirectory) {
        return failure("missing-directory", `${abs} is not a folder — open the Factory panel from a workspace folder`);
      }
      const folder = realpathSafe(abs);
      const git = inspectGitReadiness(folder);
      let registered = false;
      let existingLead = false;
      let existingSupervisor = false;
      const project = git.gitRepo ? resolveProject(folder) : undefined;
      if (project !== undefined && project.ok) {
        registered = readProjectRegistration(deps.stateDir, project.slug) !== undefined;
        try {
          const daemon = resolveDaemon(context);
          existingLead = (await seatOf(daemon, "lead", project.slug)) !== undefined;
          existingSupervisor = (await seatOf(daemon, "supervisor", project.slug)) !== undefined;
        } catch (err) {
          return failure("daemon-unavailable", `cannot read the daemon's agents to look for a running Lead — ${messageOf(err)}; check that Paseo is running, then try again`);
        }
      }
      const prerequisites = buildCompanionToolsView().map((tool) => {
        const ready = tool.status === "running" && tool.error === null;
        return { id: tool.id, title: tool.title, ready, detail: ready ? null : (tool.error ?? "not installed") };
      });
      return {
        ok: true as const,
        folder,
        gitRepo: git.gitRepo,
        hasCommits: git.hasCommits,
        registered,
        existingLead,
        existingSupervisor,
        prerequisites,
        missingPrerequisites: prerequisites.filter((item) => !item.ready).map((item) => item.title),
      };
    },

    /**
     * The onboarding Start (v0.6.0 W7, ADR 0056 + the ADR 0017 amendment). Every
     * refusal that can be decided up front is decided BEFORE anything is written
     * — a live Lead or Supervisor, a non-Git folder without `initGit`, an
     * unusable lane — so a refused commit changes nothing. Then, in an order a
     * retry survives: register the Project (initialising Git only when asked, the
     * same bootstrap law `resolveOrBootstrapProject` always applied), persist the
     * model choices that differ from the machine defaults, link the Open Design
     * project, and last start the Supervisor through the shared seat-start path
     * with the directive as its first message. It never creates a Lead.
     */
    async onboardingCommit(
      input: { folder: string; initGit?: boolean; models?: { supervisor?: string; lead?: string; worker?: string }; openDesignProjectId?: string; directive?: string },
      context?: SurfaceCallContext,
    ) {
      const inspected = await this.onboardingInspect({ folder: input.folder }, context);
      if (!inspected.ok) return inspected;
      if (inspected.existingLead) {
        return failure("lead-live", `A Lead is already running in ${inspected.folder} — onboarding never creates a second chain over a live one; ask that Project's Supervisor to retire it, or open a different folder`);
      }
      // Beyond the spec's Lead-only block (story 49): the seat model is one Supervisor per Project (ADR 0017), the same rule `supervisorStart` enforces — see ADR 0056's review notes.
      if (inspected.existingSupervisor) {
        return failure("supervisor-live", `A Supervisor is already live in ${inspected.folder} — open it from Paseo, or revoke it first, then set the Project up again`);
      }
      if (!inspected.gitRepo && input.initGit !== true) {
        return failure("not-a-git-repo", `${inspected.folder} is not a Git repository — choose "Initialise Git" in step 1 (worktrees and the Gate need one), then Start again`);
      }
      let providers: ProviderEntry[] = [];
      try {
        providers = await resolveProviders(resolveDaemon(context));
      } catch {
        // best-effort provider catalog lookup
      }
      const chosen: Partial<Record<LaneName, string>> = {};
      for (const lane of ["supervisor", "lead", "worker"] as const) {
        const value = input.models?.[lane]?.trim();
        if (value === undefined || value === "") continue;
        const sanitized = migrateLegacyZcodeLane(sanitizeLaneWithProviders(value, providers));
        const problem = laneError(lane, sanitized);
        if (problem !== undefined) {
          return failure("invalid-lane", `${problem} — go back to step 3 and pick a provider and model for the ${lane}`);
        }
        chosen[lane] = sanitized;
      }

      const registered = await registerProjectFolder(inspected.folder, context);
      if (!registered.ok) return registered;

      const effective = loadLanes(deps.stateDir, registered.slug);
      if (!effective.ok) return failure("lanes-unreadable", `${effective.reason} — repair lanes.json, then Start again`);
      const changed: Partial<Record<LaneName, string>> = {};
      for (const lane of Object.keys(chosen) as LaneName[]) {
        if (chosen[lane] !== effective.lanes[lane]) changed[lane] = chosen[lane];
      }
      if (Object.keys(changed).length > 0) {
        try {
          saveLanesBatch(deps.stateDir, changed, registered.slug);
        } catch (err) {
          return failure(codeOf(err), `${messageOf(err)} — the Project is registered; fix the model in step 3 and Start again`);
        }
      }

      if (input.openDesignProjectId !== undefined && input.openDesignProjectId.trim() !== "") {
        const linked = await this.openDesignSync({ projectRoot: registered.root, projectId: input.openDesignProjectId.trim() });
        if (!linked.ok) {
          return failure("open-design-failed", `Open Design link failed: ${linked.error} — check the design project still exists in Open Design, then Start again (or clear the Open Design choice to start without one)`);
        }
      }

      const directive = input.directive?.trim();
      const started = await startSupervisor(
        { projectRoot: registered.root, ...(directive !== undefined && directive !== "" ? { directive } : {}) },
        context,
      );
      if (!started.ok) {
        return failure(started.code, `${started.error} — the Project is registered, so the panel now offers Start Supervisor; or Start again here`);
      }
      const summary = registered.bootstrapped
        ? `Initialised Git and set up ${registered.name} (${registered.slug}); the Supervisor is running.`
        : `Set up ${registered.name} (${registered.slug}); the Supervisor is running.`;
      log(`onboarding: ${summary}`);
      return {
        ok: true as const,
        agentId: started.agentId,
        projectRoot: registered.root,
        slug: registered.slug,
        bootstrapped: registered.bootstrapped,
        summary,
      };
    },

    /**
     * Owner-only full Project delete (v0.0.35, ADR 0024): refuses seats with
     * `seat-cannot-delete`, cancels and archives all bound daemon agents and
     * workspaces, deletes temporary task worktrees and `factory/*` branches
     * (when the root still exists on disk), purges all Ledger events, reports,
     * gate logs, retro files, and correlation records for the Project, removes
     * the entire `<stateDir>/projects/<slug>/` directory (including `project.json`
     * and `lanes.json`), sweeps Paseo's daemon workspaces/projects and
     * `<home>/projects/projects.json`, and returns a refreshed `FactoryView`.
     */
    async projectDelete(
      input: { projectRoot?: string; projectSlug?: string; project?: string; seat?: string } = {},
      context?: SurfaceCallContext & { seat?: string },
    ) {
      const callerSeat =
        typeof input?.seat === "string" && input.seat.trim() !== ""
          ? input.seat.trim()
          : typeof context?.seat === "string" && context.seat.trim() !== ""
            ? context.seat.trim()
            : "";
      if (callerSeat === "supervisor" || callerSeat === "lead" || callerSeat === "agent") {
        return failure(
          "seat-cannot-delete",
          `${callerSeat} seat cannot run factory project delete — Project deletion is an Owner-only act`,
        );
      }

      const rawRoot = (input.projectRoot ?? "").trim();
      const rawSlug = (input.projectSlug ?? input.project ?? "").trim();
      let project: { slug: string; root: string; name: string } | undefined;

      if (rawRoot !== "") {
        const resolved = resolveProject(rawRoot);
        if (resolved.ok) {
          project = { slug: resolved.slug, root: resolved.root, name: basename(resolved.root) || resolved.slug };
        } else {
          const registrations = listProjectRegistrations(deps.stateDir);
          const byMatch = registrations.find(
            (reg) => reg.root === rawRoot || realpathSafe(reg.root) === realpathSafe(rawRoot) || reg.slug === rawRoot,
          );
          if (byMatch !== undefined) {
            project = { slug: byMatch.slug, root: byMatch.root, name: basename(byMatch.root) || byMatch.slug };
          } else if (rawSlug !== "") {
            const bySlug = readProjectRegistration(deps.stateDir, rawSlug);
            if (bySlug !== undefined) {
              project = { slug: bySlug.slug, root: bySlug.root, name: basename(bySlug.root) || bySlug.slug };
            } else {
              project = { slug: rawSlug, root: rawRoot, name: basename(rawRoot) || rawSlug };
            }
          }
          if (project === undefined) {
            return failure("unknown-project", `project root ${rawRoot} does not resolve to a registered project or git repository — ${resolved.reason}`);
          }
        }
      } else if (rawSlug !== "") {
        const reg = readProjectRegistration(deps.stateDir, rawSlug);
        if (reg !== undefined) {
          project = { slug: reg.slug, root: reg.root, name: basename(reg.root) || reg.slug };
        } else {
          return failure("unknown-project", `project "${rawSlug}" is not registered — pass projectRoot or a known projectSlug`);
        }
      } else {
        const registrations = listProjectRegistrations(deps.stateDir);
        if (registrations.length === 1) {
          const only = registrations[0]!;
          project = { slug: only.slug, root: only.root, name: basename(only.root) || only.slug };
        } else if (registrations.length === 0) {
          return failure("unknown-project", "no project specified and no project is registered");
        } else {
          return failure(
            "ambiguous-project",
            `more than one project is registered (${registrations.map((r) => r.slug).join(", ")}) — pass projectRoot or projectSlug to name the one to delete`,
          );
        }
      }

      const daemon = resolveDaemon(context);
      const { projectDir, worktreesDir, projectTaskSet, archivedSeats, archivedAgents } =
        await cleanupProjectArtifacts(daemon, project, {
          includeSeats: true,
          archiveMainWorkspace: true,
        });

      // 5. Sweep Paseo's daemon workspaces and project records (including the main project record) and prune <home>/projects/projects.json.
      try {
        prunePaseoProjectRegistry(deps.home, { projectRoot: project.root, worktreesDir });
      } catch {
        // best-effort registry prune
      }
      try {
        const swept = await (deps.cleanupDaemonWorkspaces ?? cleanupDaemonWorkspacesAndProjectsViaWs)(deps.home, {
          worktreesDir,
          projectRoot: project.root,
          removeMainProjectRecord: true,
          removeProjectRoot: true,
        });
        if (swept.ok && (swept.removedWorkspaceIds.length > 0 || swept.removedProjectIds.length > 0)) {
          log(
            `delete: swept ${swept.removedWorkspaceIds.length} daemon workspace(s) and ${swept.removedProjectIds.length} project record(s) for ${project.slug}`,
          );
        }
      } catch (err) {
        log(`delete: the daemon workspace/project sweep did not land — ${messageOf(err)}`);
      }

      // 6. Reset in-memory mailbox, purge Ledger events/reports/gate logs/retro files, purge CorrelationRegistry, and delete <stateDir>/projects/<slug>/ completely.
      try {
        deps.resetProjectMailbox?.(project.slug);
      } catch {
        // best-effort mailbox reset
      }
      // v0.0.87 (ADR 0043 §3): the delete drops `<projectStateDir>/usage.json`
      // with the whole project dir below — the in-memory half forgets too.
      deps.usage?.forget(project.slug);
      // v0.0.89 (ADR 0045 §1.3): the purge runs on the target Project's OWN
      // Factory — a per-Project ledger holds only that Project's events, so
      // reset/delete has zero cross-Project blast radius — and the cached
      // Factory instance is evicted with the directory it owned. A root no
      // registered Project owns falls back to the root Factory's purge (the
      // pre-registry shape), never a minted Project directory.
      const deleteFactory =
        deps.registry !== undefined && readProjectRegistration(deps.stateDir, project.slug) !== undefined
          ? deps.registry.factoryForProject(project.slug)
          : deps.factory;
      const { purgedEvents, tasks: purgedTasks, removedFiles } = deleteFactory.resetProject(project.root, project.slug);
      const tasks = [...new Set([...purgedTasks, ...projectTaskSet])];
      try {
        new CorrelationRegistry(deps.stateDir).purgeProject(project.slug, project.root, tasks);
      } catch {
        // best-effort correlation purge
      }
      deps.registry?.evict(project.slug);
      try {
        // The scoped sweep (v0.0.89, ADR 0045 §1.3): exactly this Project's
        // `<stateDir>/projects/<slug>/` directory — never a sibling Project's
        // state, never the root.
        removeProjectStateDirectory(deps.stateDir, project.slug);
      } catch {
        // best-effort project state directory deletion
      }

      const snap = await this.snapshot({}, context);
      const summary = `Deleted project ${project.name} and purged all Factory state (${purgedEvents} event${purgedEvents === 1 ? "" : "s"}, ${tasks.length} task${tasks.length === 1 ? "" : "s"}).`;
      log(`delete: ${summary}`);
      return {
        ok: true as const,
        project: project.slug,
        projectRoot: project.root,
        purgedEvents,
        tasks,
        removedFiles,
        archivedSeats,
        archivedAgents,
        summary,
        ...(snap.ok ? { view: snap.view } : {}),
      };
    },

    /**
     * Owner-only Project reset (v0.0.24, ADR 0015 §5): stops and archives bound
     * working Agents, archives temporary Paseo worktree workspaces, deletes
     * task worktrees and `factory/<task>` branches, retires Supervisor/Lead
     * seats (unless `keepSeats: true`), clears mailbox and handoff state while
     * preserving `lanes.json`, and purges the Project's Ledger events, tasks,
     * reports, and gate logs.
     */
    async projectReset(
      input: { projectRoot?: string; project?: string; keepSeats?: boolean } = {},
      context?: SurfaceCallContext,
    ) {
      let project: { slug: string; root: string } | undefined;
      if (input.projectRoot !== undefined && input.projectRoot.trim() !== "") {
        const rawRoot = input.projectRoot.trim();
        const resolved = resolveProject(rawRoot);
        if (resolved.ok) {
          project = { slug: resolved.slug, root: resolved.root };
        } else {
          const byRoot = listProjectRegistrations(deps.stateDir).find((reg) => reg.root === rawRoot);
          if (byRoot !== undefined) {
            project = { slug: byRoot.slug, root: byRoot.root };
          } else {
            return failure("unknown-project", `project root ${rawRoot} does not resolve to a git repository — ${resolved.reason}`);
          }
        }
      } else if (input.project !== undefined && input.project.trim() !== "") {
        const slug = input.project.trim();
        const reg = readProjectRegistration(deps.stateDir, slug);
        if (reg !== undefined) {
          project = { slug: reg.slug, root: reg.root };
        } else {
          return failure("unknown-project", `project "${slug}" is not registered — pass projectRoot or a known project slug`);
        }
      } else {
        const registrations = listProjectRegistrations(deps.stateDir);
        if (registrations.length === 1) {
          project = { slug: registrations[0]!.slug, root: registrations[0]!.root };
        } else if (registrations.length === 0) {
          return failure("unknown-project", "no project specified and no project is registered");
        } else {
          return failure(
            "ambiguous-project",
            `more than one project is registered (${registrations.map((r) => r.slug).join(", ")}) — pass projectRoot or project to name the one to reset`,
          );
        }
      }

      const protectedPluginDir = deps.pluginDir ?? pluginDirFor(deps.home);
      if (input.keepSeats !== true) {
        try { checkProjectResetRepository(project.root, protectedPluginDir); }
        catch (err) { return failure("repository-reset-refused", messageOf(err)); }
      }
      const daemon = resolveDaemon(context);
      const { projectDir, worktreesDir, projectTaskSet, archivedAgents } =
        await cleanupProjectArtifacts(daemon, project, {
          includeSeats: false,
          archiveMainWorkspace: false,
        });

      // 4.5. Sweep the daemon's own worktree records (v0.0.27, ADR 0017 §4)
      // and — since v0.0.31 (ADR 0017 §5) — the Project's orphaned
      // `local_checkout` workspaces: workspaces and projects rooted under the
      // (now removed) worktrees dir or missing on disk are deleted over the
      // daemon WebSocket, and a workspace at the project root archives only
      // when neither the keep set (the still-live Supervisor/Lead workspace —
      // seats retire at step 5, after this sweep) nor a live agent holds it.
      try {
      const sets = await resolveSweepWorkspaceSets(daemon, project);
        const swept = await (deps.cleanupDaemonWorkspaces ?? cleanupDaemonWorkspacesAndProjectsViaWs)(deps.home, {
          worktreesDir,
          ...(sets === null ? {} : { projectRoot: project.root, keepWorkspaceIds: sets.keepWorkspaceIds, activeWorkspaceIds: sets.activeWorkspaceIds }),
        });
        if (swept.ok && (swept.removedWorkspaceIds.length > 0 || swept.removedProjectIds.length > 0)) {
          log(
            `reset: swept ${swept.removedWorkspaceIds.length} daemon workspace(s) and ${swept.removedProjectIds.length} project record(s) under ${worktreesDir}`,
          );
        }
      } catch (err) {
        log(`reset: the daemon worktree-record sweep did not land — ${messageOf(err)}`);
      }

      // 5. Unless keepSeats === true, retire Supervisor and Lead seats for this Project.
      const archivedSeats: string[] = [];
      if (input.keepSeats !== true) {
        for (const seat of ["supervisor", "lead"] as const) {
          const retired = await retireSeat(seat, project.slug, project.root, context);
          if (retired.ok) archivedSeats.push(...retired.agentIds);
          else if (retired.code !== "no-lead" && retired.code !== "no-supervisor") return retired;
        }
      }

      // 6. Reset in-memory mailbox state and delete mailbox.jsonl, lead-handoff.md, notebook.md, and stale registration fields while preserving lanes.json.
      try {
        deps.resetProjectMailbox?.(project.slug);
      } catch {
        // best-effort mailbox reset
      }
      try {
        rmSync(join(projectDir, "mailbox.jsonl"), { force: true });
      } catch {
        // best-effort
      }
      try {
        rmSync(join(projectDir, "lead-handoff.md"), { force: true });
      } catch {
        // best-effort
      }
      // v0.1.0 (ADR 0048 §3): a full reset wipes the Per-Project Lead notebook
      // alongside lead-handoff.md so the next wave starts from a clean slate.
      try {
        rmSync(projectNotebookPath(deps.stateDir, project.slug), { force: true });
      } catch {
        // best-effort
      }
      writeProjectRegistration(deps.stateDir, project.slug, {
        root: project.root,
        ...(input.keepSeats === true ? {} : { supervisor: null, lead: null, releasedSupervisors: null }),
        rotationState: null,
        handoffRequestedAt: null,
        taskWorkspaces: null,
        dispatchers: null,
      });
      // The usage rollup's reset law (v0.0.87, ADR 0043 §3): a full reset
      // drops `<projectStateDir>/usage.json` with the rest of the Project's
      // history; `--keep-seats` keeps ONLY the surviving Supervisor and Lead
      // session counters, pruning every task/peer and retired-seat entry.
      if (deps.usage !== undefined) {
        if (input.keepSeats === true) {
          const surviving = readProjectRegistration(deps.stateDir, project.slug);
          deps.usage.pruneForReset(project.slug, [surviving?.supervisor, surviving?.lead].filter((id): id is string => typeof id === "string" && id !== ""));
        } else {
          deps.usage.forget(project.slug);
        }
      }
      if (input.keepSeats !== true) {
        try {
          rmSync(join(projectDir, "usage.json"), { force: true });
        } catch {
          // best-effort — the project dir sweep below is the backstop
        }
      }

      // 7. Purge ledger events, contracts, reports, and gate logs in-memory and on disk.
      // v0.0.89 (ADR 0045 §1.3): the purge runs on the target Project's OWN
      // Factory — the per-Project ledger holds only this Project's events and
      // artifacts, so the reset's blast radius is exactly one Project. The
      // cached Factory stays (its purged, now-empty ledger is valid) — a
      // delete evicts its Factory with the directory instead. An unregistered
      // root keeps the root Factory's purge (the pre-registry shape).
      const resetFactory =
        deps.registry !== undefined && readProjectRegistration(deps.stateDir, project.slug) !== undefined
          ? deps.registry.factoryForProject(project.slug)
          : deps.factory;
      const { purgedEvents, tasks: purgedTasks, removedFiles } = resetFactory.resetProject(project.root, project.slug);
      const tasks = [...new Set([...purgedTasks, ...projectTaskSet])];
      new CorrelationRegistry(deps.stateDir).purgeProject(project.slug, project.root, tasks, input.keepSeats === true);
      if (input.keepSeats !== true) resetProjectRepository(project.root, protectedPluginDir);

      const snap = await this.snapshot({ projectRoot: project.root }, context);
      if (input.keepSeats !== true) {
        try {
          rmSync(join(projectDir, "project.json"), { force: true });
        } catch {
          // best-effort
        }
      }
      const summary = `Reset project ${project.slug}: purged ${purgedEvents} ledger event(s), ${tasks.length} task(s), archived ${archivedSeats.length} seat(s) & ${archivedAgents.length} agent(s).`;
      log(`reset: ${summary}`);
      return {
        ok: true as const,
        project: project.slug,
        projectRoot: project.root,
        purgedEvents,
        tasks,
        removedFiles,
        archivedSeats,
        archivedAgents,
        summary,
        ...(snap.ok ? { view: snap.view } : {}),
      };
    },

    /**
     * The UI's quick dispatch (v0.0.20, ADR 0013 §4): routes through the
     * Lead-mailbox runtime's `dispatchLead` — auto-ensure the Lead seat,
     * `enqueueLeadMail`, `pumpProjectLead` — the same pipeline the spool's
     * `lead_dispatch` rides, never a bare `agents.ref().send`.
     */
    async leadDispatch(
      input: { projectRoot?: string; project?: string; from?: "supervisor" | "owner"; message: string },
      _context?: SurfaceCallContext,
    ): Promise<
      | { ok: true; project: string; leadAgentId: string; mailId: string; rotationState: string; summary: string }
      | { ok: false; code: string; error: string }
    > {
      if (deps.leadDispatch === undefined) {
        return failure("lead-dispatch-unavailable", "the Lead-mailbox runtime is not wired into this surface — dispatch through `factory lead dispatch` instead");
      }
      // The request mirrors the spool's shape: a root resolves as `workspace`
      // (resolveProject), a slug rides `project` (the registry).
      const request: SpoolLeadDispatchRequest = {
        id: `surface-${randomUUID()}`,
        kind: "lead_dispatch",
        ...(input.projectRoot === undefined ? {} : { workspace: input.projectRoot }),
        ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.from === undefined ? {} : { from: input.from }),
        message: input.message,
      };
      try {
        const project = projectOrRefusal(input.projectRoot ?? (input.project ? readProjectRegistration(deps.stateDir, input.project)?.root : undefined) ?? "");
        if (project.ok) await prepareOpenDesignDispatch({ state: deps.stateDir, slug: project.slug, root: project.root, requestId: request.id, userHome: resolveSurfaceUserHome() });
      } catch (error) { return failure(codeOf(error), messageOf(error)); }
      const reply = await deps.leadDispatch(request);
      if (!reply.ok) return { ok: false as const, code: reply.code ?? "lead-dispatch-failed", error: reply.message ?? "the dispatch failed" };
      return {
        ok: true as const,
        project: reply.project ?? "",
        leadAgentId: reply.leadAgentId ?? "",
        mailId: reply.mailId ?? "",
        rotationState: reply.rotationState ?? "normal",
        summary: reply.summary,
      };
    },

    // ---- the companion plugin lifecycle (v0.0.17, ADR 0012 §3) -----------------------------

    async skillsImport(input: { id: string }) {
      try {
        const reply = importHostSkillOrPack({ ...input, userHome: resolveSurfaceUserHome(), runner: deps.companionToolRunner });
        return reply.ok ? { ok: true as const, summary: reply.summary } : failure('skill-import-failed', reply.reason);
      } catch (error) { return failure(codeOf(error), messageOf(error)); }
    },
    async skillsTogglePack(input: { projectRoot: string; pack: string; enabled: boolean }) {
      try {
        const project = projectOrRefusal(input.projectRoot); if (!project.ok) return project;
        const current = readProjectSettings(deps.stateDir, project.slug).skillPacks ?? detectProjectSkillPacks(project.root);
        setProjectSkillPacks(deps.stateDir, project.slug, input.enabled ? [...new Set([...current, input.pack])] : current.filter(p => p !== input.pack));
        return { ok: true as const, summary: `${input.pack} ${input.enabled ? 'enabled' : 'disabled'} for Project; applies to new seats` };
      } catch (error) { return failure(codeOf(error), messageOf(error)); }
    },
    async pluginsInstall(
      input: { target: ManageablePluginId | "all"; source?: string; ref?: string; includeTools?: boolean },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; installed: string[]; summary: string } | { ok: false; code: string; error: string }> {
      // A custom source or ref names ONE plugin — it cannot ride a batch.
      if (input.target === "all" && (input.source !== undefined || input.ref !== undefined)) {
        return failure("invalid-target", 'a custom source or ref targets one companion — pass a named target, not "all"');
      }
      if (MANAGEABLE_TOOL_IDS.has(input.target)) {
        const res = executeCompanionToolAction(input.target as "factory-skills-pack", "install");
        if (!res.ok) return failure("daemon_failed", res.reason);
        log(`plugins: ${res.summary}`);
        return { ok: true as const, installed: [input.target], summary: res.summary };
      }
      let targets: readonly (CompanionCatalogEntry | typeof CORE_PLUGIN_ENTRY)[];
      if (input.target === "all") {
        // Batch installs only the uninstalled PUBLIC companions (v0.0.30, ADR
        // 0012 §2) — a private invite-only repository never rides Install All,
        // so a machine without pull access never hits a clone failure mid-batch
        // and the button retires once every public companion is installed. The
        // list decides, and an unavailable list refuses rather than reinstall blind.
        const lister = deps.listPlugins ?? listDaemonPlugins;
        let listedIds: Set<string> | undefined;
        let listReason = "";
        try {
          const listed = await lister(deps.home);
          if (listed.ok) listedIds = new Set(listed.plugins.map((plugin) => plugin.id));
          else listReason = listed.reason;
        } catch (err) {
          listReason = messageOf(err);
        }
        if (listedIds === undefined) {
          return failure("daemon_failed", `cannot tell which companions are already installed — the daemon plugin list is unavailable: ${listReason}`);
        }
        targets = COMPANION_CATALOG.filter((entry) => entry.access === "public" && !listedIds!.has(entry.id));
      } else if (input.target === CORE_PLUGIN_ENTRY.id) {
        targets = [CORE_PLUGIN_ENTRY];
      } else {
        const entry = COMPANION_CATALOG.find((candidate) => candidate.id === input.target);
        if (entry === undefined) return failure("unknown-companion", `${input.target} is not a Factory companion — the surface manages only the catalog's own family`);
        targets = [entry];
      }
      const installer = deps.installPlugin ?? installDaemonPlugin;
      localUpdateSnapshot = null;
      const installed: string[] = [];
      for (const entry of targets) {
        // The catalog's canonicalSource is the default — no code path probes
        // or prefers `../` sibling directories on the host disk.
        const source = input.source ?? entry.canonicalSource;
        // The private-companion pre-flight (v0.0.30, ADR 0012 §2): an explicit
        // install of a `private` companion verifies pull access before the
        // daemon clones — `gh auth setup-git` when logged in, then
        // `git ls-remote`. Production always enforces (no installPlugin
        // override); tests enforce whenever the vaultRunner seam is injected,
        // so legacy unit tests faking only installPlugin never touch the
        // network. A local directory source skips GitHub entirely.
        if (entry.access === "private" && !isLocalCompanionGitSource(source) && (deps.installPlugin === undefined || deps.vaultRunner !== undefined)) {
          const probe = await probeCompanionGitAccess(source, vaultRunnerOptions());
          if (!probe.ok) return failure("private-companion-access-denied", probe.reason);
        }
        if (entry.id === CORE_PLUGIN_ENTRY.id) {
          const expo = updateInstalledExpo(); if (!expo.ok) return failure('skill-update-failed', expo.reason);
        }
        const reply = await installer(deps.home, { id: entry.id, source, ...(input.ref !== undefined ? { ref: input.ref } : {}) });
        if (!reply.ok) return failure("daemon_failed", reply.reason);
        installed.push(entry.id);
        log(`plugins: installed ${entry.id} from ${source}${input.ref === undefined ? "" : ` at ref ${input.ref}`}`);
      }
      if (input.target === "all" && input.includeTools === true) {
        for (const tool of buildCompanionToolsView()) {
          if (tool.access === "public" && (tool.status === "not_installed" || tool.status === "failed" || tool.error !== null)) {
            const res = executeCompanionToolAction(tool.id as "factory-skills-pack", "install");
            if (!res.ok) return failure("daemon_failed", res.reason);
            installed.push(tool.id);
            log(`plugins: ${res.summary}`);
          }
        }
      }
      return {
        ok: true as const,
        installed,
        summary: pluginsInstallSummary({ ids: installed, source: input.source ?? targets[0]?.canonicalSource ?? "", ref: input.ref, batch: input.target === "all" }),
      };
    },

    async pluginsManage(
      input: { pluginId: ManageablePluginId | "all"; action: DaemonPluginAction; includeTools?: boolean },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; pluginId: string; action: string; summary: string } | { ok: false; code: string; error: string }> {
      if (MANAGEABLE_TOOL_IDS.has(input.pluginId)) {
        if (input.action === "disable" || input.action === "remove") {
          return failure(
            "companion-tool-protected",
            `${input.pluginId} is a required Factory companion tool and cannot be disabled or removed from the Factory surface`,
          );
        }
        const res = executeCompanionToolAction(input.pluginId as "factory-skills-pack", input.action);
        if (!res.ok) return failure("daemon_failed", res.reason);
        log(`plugins: ${res.summary}`);
        return { ok: true as const, pluginId: input.pluginId, action: input.action, summary: res.summary };
      }
      const manager = deps.managePlugin ?? manageDaemonPlugin;
      if (input.pluginId === "all") {
        if (input.action !== "update") {
          return failure("invalid-target", 'target "all" is only supported for action "update"');
        }
        const lister = deps.listPlugins ?? listDaemonPlugins;
        const listed = await lister(deps.home);
        if (!listed.ok) return failure("daemon_failed", listed.reason);
        const remoteInstalled = listed.plugins.filter((p) => {
          if (!MANAGEABLE_PLUGIN_IDS.has(p.id)) return false;
          const kind = p.installation?.identity?.kind ?? p.source;
          return kind === "git" || kind === "npm";
        });
        const updateSnap = localUpdateSnapshot ?? getCachedPluginUpdateStatus(deps.home);
        const targets = (
          updateSnap === null
            ? [...remoteInstalled]
            : remoteInstalled.filter((p) => updateSnap.statuses.get(p.id)?.updateAvailable === true)
        ).sort((a, b) => (a.id === CORE_PLUGIN_ENTRY.id ? 1 : b.id === CORE_PLUGIN_ENTRY.id ? -1 : 0));
        localUpdateSnapshot = null;
        const summaries: string[] = [];
        for (const target of targets) {
          if (target.id === CORE_PLUGIN_ENTRY.id) {
            const expo = updateInstalledExpo(); if (!expo.ok) return failure('skill-update-failed', expo.reason);
          }
          const reply = await manager(deps.home, target.id, "update");
          if (!reply.ok) return failure("daemon_failed", reply.reason);
          summaries.push(pluginsManageSummary(target.id, "update", reply.update));
        }
        if (input.includeTools === true) {
          for (const tool of buildCompanionToolsView()) {
            if (tool.updateAvailable === true) {
              const res = executeCompanionToolAction(tool.id as "factory-skills-pack", "update");
              if (!res.ok) return failure("daemon_failed", res.reason);
              summaries.push(res.summary);
            }
          }
        }
        if (summaries.length === 0) {
          return { ok: true as const, pluginId: "all", action: "update", summary: "All installed Factory plugins are already up to date." };
        }
        const summary = summaries.join(" · ");
        log(`plugins: ${summary}`);
        return { ok: true as const, pluginId: "all", action: "update", summary };
      }

      const isCore = input.pluginId === CORE_PLUGIN_ENTRY.id;
      const isCompanion = COMPANION_CATALOG.some((entry) => entry.id === input.pluginId);
      if (!isCore && !isCompanion) {
        return failure("unknown-companion", `${input.pluginId} is not a Factory plugin — the surface manages only the catalog's own family`);
      }
      if (isCore && (input.action === "disable" || input.action === "remove")) {
        return failure(
          "core-plugin-protected",
          "paseo-factory is the active Factory core plugin and cannot be disabled or removed from the Factory surface",
        );
      }
      localUpdateSnapshot = null;
      if (isCore && input.action === 'update') {
        const expo = updateInstalledExpo(); if (!expo.ok) return failure('skill-update-failed', expo.reason);
      }
      const reply = await manager(deps.home, input.pluginId, input.action);
      if (!reply.ok) return failure("daemon_failed", reply.reason);
      const summary = pluginsManageSummary(input.pluginId, input.action, reply.update);
      log(`plugins: ${summary}`);
      return { ok: true as const, pluginId: input.pluginId, action: input.action, summary };
    },

    async helperMcpsSyncAndProbe(_input: Record<string, never>) {
      return serializeSeat("helper-mcps", async () => {
        try {
          const options = { stateDir: deps.stateDir, userHome: resolveSurfaceUserHome() };
          const result = await syncHelperMcps({ ...options, probe: true });
          provisionPiAgentHome({ stateDir: deps.stateDir, role: "agent", sourceAgentDir: join(options.userHome, ".pi/agent"), helperMcpSources: options });
          return { ok: true as const, helperMcps: helperMcpRoster(result.servers) };
        } catch { return failure("helper-mcp-sync-failed", "Helper MCP sync could not complete; check host configuration permissions"); }
      });
    },
    async helperMcpsSetEnabled(input: { name: string } & HelperMcpConfigUpdate) {
      return serializeSeat("helper-mcps", async () => {
        try {
          const options = { stateDir: deps.stateDir, userHome: resolveSurfaceUserHome() };
          const result = setHelperMcpEnabled(options, input.name, input);
          provisionPiAgentHome({ stateDir: deps.stateDir, role: "agent", sourceAgentDir: join(options.userHome, ".pi/agent"), helperMcpSources: options });
          return { ok: true as const, helperMcps: helperMcpRoster(result.servers) };
        } catch { return failure("helper-mcp-toggle-failed", "Helper MCP toggle failed; server may no longer exist or configuration is not writable"); }
      });
    },

    async pluginsCheckUpdates(
      _input: Record<string, never>,
      _context?: SurfaceCallContext,
    ): Promise<
      | { ok: true; checkedAt: string; updatesAvailable: string[]; summary: string }
      | { ok: false; code: string; error: string }
    > {
      const checker = deps.checkPluginUpdates ?? checkDaemonPluginUpdates;
      const reply = await checker(deps.home);
      if (!reply.ok) return failure("daemon_failed", reply.reason);
      const map = new Map<string, DaemonPluginSourceStatus>();
      for (const row of reply.statuses) map.set(row.id, row);
      localUpdateSnapshot = { statuses: map, checkedAt: reply.checkedAt };
      const updatesAvailable = reply.statuses
        .filter((row) => MANAGEABLE_PLUGIN_IDS.has(row.id) && row.updateAvailable === true)
        .map((row) => row.id);
      if (deps.checkPluginUpdates === undefined || deps.companionToolRunner !== undefined) {
        localToolUpdateSnapshot = checkCompanionToolsUpdates({
          userHome: resolveSurfaceUserHome(),
          runner: deps.companionToolRunner,
        });
        for (const toolId of ["factory-skills-pack"] as const) {
          if (localToolUpdateSnapshot[toolId]?.updateAvailable === true && !updatesAvailable.includes(toolId)) {
            updatesAvailable.push(toolId);
          }
        }
      }
      const summary =
        updatesAvailable.length > 0
          ? `${updatesAvailable.length} plugin update(s) available: ${updatesAvailable.join(", ")}`
          : "All installed Factory plugins are up to date.";
      log(`plugins: checked updates — ${summary}`);
      return {
        ok: true as const,
        checkedAt: reply.checkedAt,
        updatesAvailable,
        summary,
      };
    },

    // ---- the Private vault surface (v0.0.21–v0.0.22, ADR 0014 §2/§4) ------------------------

    async vaultConfigure(
      input: { repo: string; branch: string; passphrase?: string },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; vault: VaultStatusView; summary: string } | { ok: false; code: string; error: string }> {
      const repo = input.repo.trim();
      if (repo === "") {
        return failure("vault-invalid-repo", "the vault repo cannot be blank — pass the GitHub owner/repo slug (or a local git path for tests)");
      }
      let prior: VaultConfig | null;
      try {
        prior = loadVaultConfig(deps.home);
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
      // The passphrase tri-state: absent preserves the persisted value, an
      // empty string clears it, text sets it (ADR 0014 Decision 3's optional leg).
      const passphrase = input.passphrase === undefined ? prior?.passphrase : input.passphrase === "" ? undefined : input.passphrase;
      const branch = input.branch.trim();
      saveVaultConfig(deps.home, {
        repo,
        branch,
        // The prior config's durable stamps survive a re-configure untouched.
        ...(prior?.nodeId === undefined ? {} : { nodeId: prior.nodeId }),
        ...(passphrase === undefined ? {} : { passphrase }),
        ...(prior?.lastHydratedAt === undefined ? {} : { lastHydratedAt: prior.lastHydratedAt }),
        ...(prior?.lastHydrateMode === undefined ? {} : { lastHydrateMode: prior.lastHydrateMode }),
        ...(prior?.lastPushedAt === undefined ? {} : { lastPushedAt: prior.lastPushedAt }),
      });
      const vault = await vaultStatusOf();
      const summary = `Saved vault config for ${repo} (branch ${vault.branch}).`;
      log(`vault: configured ${repo} (branch ${vault.branch})`);
      return { ok: true as const, vault, summary };
    },

    async vaultHydrate(
      input: { repo?: string; ref?: string; mergeLedgers?: boolean; overwriteConfigs?: boolean },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; vault: VaultStatusView; hydratedFiles: string[]; summary: string; materialization?: import("./core/history-stage.ts").ImportMaterialization; historyImports?: import("./core/history-stage.ts").ImportStatus[] } | { ok: false; code: string; error: string }> {
      try {
        const result = await hydrateVaultDirect(deps.home, {
          ...(input.repo === undefined ? {} : { repo: input.repo }),
          ...(input.ref === undefined ? {} : { ref: input.ref }),
          ...(input.mergeLedgers === undefined ? {} : { mergeLedgers: input.mergeLedgers }),
          ...(input.overwriteConfigs === undefined ? {} : { overwriteConfigs: input.overwriteConfigs }),
          ...vaultRunnerOptions(),
        });
        const vault = await vaultStatusOf();
        const summary = `Direct hydrate unpacked ${result.hydratedFiles.length} file(s) from ${vault.repo ?? input.repo ?? "vault"}${result.historyImports?.length ? `; history ${result.historyImports.map((item) => item.status).join(", ")}` : ""}; materialization ${result.materialization?.status ?? "applied"}.`;
        log(`vault: direct hydrate wrote ${result.hydratedFiles.length} files from the gh api tarball stream (no clone left behind)`);
        return { ok: true as const, vault, hydratedFiles: result.hydratedFiles, summary, materialization: result.materialization, historyImports: result.historyImports };
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
    },

    async vaultPull(
      input: { mergeLedgers?: boolean },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; vault: VaultStatusView; hydratedFiles: string[]; summary: string; materialization?: import("./core/history-stage.ts").ImportMaterialization; historyImports?: import("./core/history-stage.ts").ImportStatus[] } | { ok: false; code: string; error: string }> {
      try {
        const result = await pullVault(deps.home, {
          ...(input.mergeLedgers === undefined ? {} : { mergeLedgers: input.mergeLedgers }),
          ...vaultRunnerOptions(),
        });
        const vault = await vaultStatusOf();
        const summary = `Pulled and hydrated ${result.hydratedFiles.length} file(s) from ${vault.repo ?? "vault"}${result.historyImports?.length ? `; history ${result.historyImports.map((item) => item.status).join(", ")}` : ""}; materialization ${result.materialization?.status ?? "applied"}.`;
        log(`vault: sync pull hydrated ${result.hydratedFiles.length} files from the cached checkout${input.mergeLedgers === true ? " and staged node history" : ""}`);
        return { ok: true as const, vault, hydratedFiles: result.hydratedFiles, summary, materialization: result.materialization, historyImports: result.historyImports };
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
    },

    async vaultPush(
      input: { includeLedgers?: boolean },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; vault: VaultStatusView; pushedFiles: string[]; summary: string } | { ok: false; code: string; error: string }> {
      try {
        const result = await pushVault(deps.home, {
          ...(input.includeLedgers === undefined ? {} : { includeLedger: input.includeLedgers }),
          ...vaultRunnerOptions(),
        });
        const vault = await vaultStatusOf();
        const summary = result.pushed
          ? `Pushed ${result.pushedFiles.length} file(s) to ${vault.repo ?? "vault"}.`
          : `Vault ${vault.repo ?? "checkout"} is already up to date (${result.pushedFiles.length} file(s) tracked).`;
        log(`vault: push packaged ${result.pushedFiles.length} files${result.pushed ? " and pushed a commit to the remote" : " — the checkout was already clean"}`);
        return { ok: true as const, vault, pushedFiles: result.pushedFiles, summary };
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
    },

    async vaultSync(
      input: Omit<SyncVaultOptions, "runner">,
      _context?: SurfaceCallContext,
    ): Promise<
      | { ok: true; vault: VaultStatusView; createdRepo: boolean; hydratedFiles: string[]; pushedFiles: string[]; pushed: boolean; summary: string; materialization?: import("./core/history-stage.ts").ImportMaterialization; historyImports?: import("./core/history-stage.ts").ImportStatus[] }
      | { ok: false; code: string; error: string }
    > {
      try {
        const result = await syncVault(deps.home, {
          ...input,
          ...vaultRunnerOptions(),
        });
        const vault = await vaultStatusOf();
        log(`vault: ${result.summary}`);
        return {
          ok: true as const,
          vault,
          materialization: result.materialization,
          historyImports: result.historyImports,
          createdRepo: result.createdRepo,
          hydratedFiles: result.hydratedFiles,
          pushedFiles: result.pushedFiles,
          pushed: result.pushed,
          summary: result.summary,
        };
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
    },

    async vaultImport(
      input: Omit<ImportVaultSecretsInput, "runner">,
      _context?: SurfaceCallContext,
    ): Promise<
      | { ok: true; vault: VaultStatusView; importedFiles: string[]; pushed: boolean; summary: string; materialization?: import("./core/history-stage.ts").ImportMaterialization; historyImports?: import("./core/history-stage.ts").ImportStatus[] }
      | { ok: false; code: string; error: string }
    > {
      try {
        const result = await importVaultSecrets(deps.home, {
          ...input,
          ...vaultRunnerOptions(),
        });
        const vault = await vaultStatusOf();
        log(`vault: ${result.summary}`);
        return {
          ok: true as const,
          vault,
          materialization: result.synced?.materialization,
          historyImports: result.synced?.historyImports,
          importedFiles: result.importedFiles,
          pushed: result.synced?.pushed ?? false,
          summary: result.summary,
        };
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
    },
  };
  const reads = new Set(["cachedProviders", "sanitizeLane", "snapshot", "seatsDirectory", "pluginsCheckUpdates", "historyImport", "historyImports", "historyUpgrade", "vaultHydrate", "vaultPull", "vaultPush", "vaultSync", "vaultImport"]);
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(handlers, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key !== "string" || typeof value !== "function" || reads.has(key)) return value;
      // v0.0.89 (ADR 0045 §1.3): a project reset/delete takes its target
      // Project's OWN maintenance lane — independent Projects keep admitting
      // ordinary work while one Project's history is exclusively held.
      if (!wrappers.has(key)) wrappers.set(key, (...args: unknown[]) => {
        const lane = key === "projectReset" || key === "projectDelete" ? factoryForResetTarget(args[0] as { projectRoot?: string; project?: string; projectSlug?: string; workspace?: string } | undefined) : deps.factory;
        return !lane.history.maintenanceActive && (key === "projectReset" || key === "projectDelete")
          ? lane.history.withExclusiveMaintenance(() => value.apply(receiver, args))
          : lane.history.runOperation(() => value.apply(receiver, args), { newWork: true });
      });
      return wrappers.get(key);
    },
  });
}

// ---- the server wiring --------------------------------------------------------------------

/** The handlers' shared type — the shell builds them once and hands them to both the RPC registrations and the spool. */
export type SurfaceHandlers = ReturnType<typeof createSurfaceHandlers>;

/**
 * Registers every `factory.*` handler on the plugin server. Each daemon
 * call prefers the PaseoApi the daemon hands the handler (`context.paseo`);
 * the constructor's `daemon` is the fallback (and the tests' fake). Since
 * v0.0.27 (ADR 0017 §4) an optional `onContext` fires on EVERY call before
 * the handler runs — the shell passes its `capturePaseo` so the one
 * long-lived PaseoApi is captured from the first `factory.*` RPC alone,
 * before any agent hook (create, session open, a permit ask) ever fires.
 */
export function registerSurfaceRpc(
  server: PluginServerContext,
  handlers: SurfaceHandlers,
  onContext?: (context: { paseo?: unknown }) => void,
): void {
  const pass = (context: { paseo?: unknown }): SurfaceCallContext => {
    if (onContext !== undefined) onContext(context);
    return { paseo: context.paseo };
  };
  server.handle(historyUpgrade, (input, context) => { pass(context); return handlers.historyUpgrade(input); });
      server.handle(snapshot, (input, context) => handlers.snapshot(input, pass(context)));
  server.handle(seatsDirectory, (input, context) => handlers.seatsDirectory(input, pass(context)));
  server.handle(openDesignCatalog, input => handlers.openDesignCatalog(input));
  server.handle(openDesignExport, input => handlers.openDesignExport(input));
  server.handle(openDesignStatus, input => handlers.openDesignStatus(input));
  server.handle(openDesignSync, input => handlers.openDesignSync(input));
  server.handle(openDesignUnlink, input => handlers.openDesignUnlink(input));
  server.handle(openDesignPreview, input => handlers.openDesignPreview(input));
  server.handle(lanesSet, (input, context) => handlers.lanesSet(input, pass(context)));
  server.handle(lanesSetBatch, (input, context) => handlers.lanesSetBatch(input, pass(context)));
  server.handle(lanesReset, (input, context) => handlers.lanesReset(input, pass(context)));
  server.handle(profilesSave, (input, context) => handlers.profilesSave(input, pass(context)));
  server.handle(profilesApply, (input, context) => handlers.profilesApply(input, pass(context)));
  server.handle(profilesDelete, (input, context) => handlers.profilesDelete(input, pass(context)));
  server.handle(supervisorEnsure, (input, context) => handlers.supervisorEnsure(input, pass(context)));
  server.handle(supervisorAdopt, (input, context) => handlers.supervisorAdopt(input, pass(context)));
  server.handle(supervisorStart, (input, context) => handlers.supervisorStart(input, pass(context)));
  // Deprecated public alias preserves history through the same Owner handoff door.
  server.handle(supervisorRevoke, (input, context) => input.projectRoot === undefined
    ? Promise.resolve({ ok: false as const, code: "project-required", error: "Supervisor handoff requires a Project; pass projectRoot" })
    : handlers.handoff({ projectRoot: input.projectRoot, seat: "supervisor" }, "start", pass(context)));
  server.handle(leadEnsure, (input, context) => handlers.leadEnsure(input, pass(context)));
  server.handle(handoffStart, (input, context) => handlers.handoff(input, "start", pass(context)));
  server.handle(handoffReplaceNow, (input, context) => handlers.handoff(input, "replaceNow", pass(context)));
  server.handle(handoffCancel, (input, context) => handlers.handoff(input, "cancel", pass(context)));
  server.handle(handoffRetry, (input, context) => handlers.handoff(input, "retry", pass(context)));
  server.handle(handoffHandover, (input, context) => handlers.handoff(input, "handover", pass(context)));
  server.handle(onboardingInspect, (input, context) => handlers.onboardingInspect(input, pass(context)));
  server.handle(onboardingCommit, (input, context) => handlers.onboardingCommit(input, pass(context)));
  server.handle(projectDelete, (input, context) => handlers.projectDelete(input, pass(context)));
  server.handle(projectReset, (input, context) => handlers.projectReset(input, pass(context)));
  server.handle(leadDispatch, (input, context) => handlers.leadDispatch(input, pass(context)));
  server.handle(skillsImport, input => handlers.skillsImport(input));
  server.handle(skillsTogglePack, input => handlers.skillsTogglePack(input));
  server.handle(pluginsInstall, (input, context) => handlers.pluginsInstall(input, pass(context)));
  server.handle(pluginsManage, (input, context) => handlers.pluginsManage(input, pass(context)));
  server.handle(helperMcpsSyncAndProbe, (input, context) => { pass(context); return handlers.helperMcpsSyncAndProbe(input); });
  server.handle(helperMcpsSetEnabled, (input, context) => { pass(context); return handlers.helperMcpsSetEnabled(input); });
  server.handle(pluginsCheckUpdates, (input, context) => handlers.pluginsCheckUpdates(input, pass(context)));
  server.handle(vaultConfigure, (input, context) => handlers.vaultConfigure(input, pass(context)));
  server.handle(vaultHydrate, (input, context) => handlers.vaultHydrate(input, pass(context)));
  server.handle(historyImport, (input) => handlers.historyImport(input));
  server.handle(historyImports, () => handlers.historyImports());
  server.handle(vaultPull, (input, context) => handlers.vaultPull(input, pass(context)));
  server.handle(vaultPush, (input, context) => handlers.vaultPush(input, pass(context)));
  server.handle(vaultSync, (input, context) => handlers.vaultSync(input, pass(context)));
  server.handle(vaultImport, (input, context) => handlers.vaultImport(input, pass(context)));
}
