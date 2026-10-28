import { boundTaskPeers } from "./task-peers.ts";
import { scrumTelemetry } from "./core/scrum/telemetry.ts";
import { scrumOperation } from "./core/scrum/controller.ts";
import type { ScrumOperation } from "./core/scrum/controller.ts";
import { readExecution, readScrumConfig, saveExecutionDefault, ensureScrumConfig, scopeDir } from "./core/scrum/config.ts";
import { listRuns, readRun, terminalRun, commandRun } from "./core/scrum/run-journal.ts";
import { readScrumProfiles } from "./core/scrum/profiles.ts";
import { readSwitchIntent, switchExecution, withExecutionLane } from "./core/scrum/execution.ts";
import { projectTask } from "./core/task-state.ts";
import { upgradeFactory } from "./core/history-upgrade.ts";
import type { UpgradeInput } from "./core/history-upgrade.ts";
import { acceptanceSummary, executeAcceptance } from "./commands.ts";
export { acceptanceSummary, archiveAcceptedTaskWorkspace } from "./commands.ts";
/**
 * The Factory surface's in-process single-writer handlers (v0.0.13, ADR
 * 0009 §2/§4, the amendment to ADR 0004): every `factory.*` RPC runs inside
 * the plugin server process that owns the one Factory instance, so Owner
 * acts from the UI — Accept, Retro, Lane config, the seat bridges — invoke
 * `factory.accept({...})`, `factory.retro()` and `saveLanes` directly, never
 * through the spool. The daemon half rides the PaseoApi each `handle` call
 * receives (`context.paseo`), reduced to the structural slice below — SDK
 * types stay out by the timeline.ts precedent.
 *
 * v0.0.14 (ADR 0010 §1–§3/§6): the Supervisor and Lead seats are
 * per-Project agents standing at `cwd = <project-root>` with labels
 * `{seat, project: <slug>}` — `supervisorEnsure`/`leadEnsure` find or create
 * them under their lane (additive role injection lives in roles.ts; nothing
 * under the project root is ever written), `leadRotate` retires a Lead so
 * the next dispatch starts fresh, and `ratifyProposal` dispatches a Retro
 * proposal to the Project's Supervisor (the two-tier memory loop). The two
 * daemon acts the in-process API lacks (a live agent's model sync,
 * cancelling a running agent) ride the CLI bridge in daemon-cli.ts.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { CorrelationRegistry } from "./core/correlations.ts";
import { FactoryError } from "./core/errors.ts";
import type { Factory } from "./core/factory.ts";
import { readLeadMailbox } from "./core/mailbox.ts";
import { LANE_NAMES, loadLanes, parseLane, saveLanes, projectLanesPath, listLaneProfiles, getLaneProfile, readLaneProfilesFile, saveLaneProfile, deleteLaneProfile, applyLaneProfile, saveLanesBatch, resetProjectLanes } from "./core/lanes.ts";
import type { LaneProfile } from "./core/lanes.ts";
import { listProjectRegistrations, projectStateDir, readProjectRegistration, resolveOrBootstrapProject, resolveProject } from "./core/project.ts";
import type { ProjectResolution } from "./core/project.ts";
import { hydrateVaultDirect, importVaultSecrets, isLocalCompanionGitSource, loadVaultConfig, probeCompanionGitAccess, probeGhAuth, pullVault, pushVault, readVaultStatus, saveVaultConfig, syncVault } from "./core/vault.ts";
import type { ImportVaultSecretsInput, SyncVaultOptions, VaultConfig, VaultRunner } from "./core/vault.ts";
import { basename, join, resolve } from "node:path";
import { FACTORY_VIEW_VERSION } from "../shared/view.ts";
import { foldRetro, foldTasks, foldView, readTailed } from "./view.ts";
import { setAgentModelViaCli, setAgentThinkingViaCli, stopAgentViaCli } from "./daemon-cli.ts";
import { checkDaemonPluginUpdates, cleanupDaemonWorkspacesAndProjectsViaWs, getCachedPluginUpdateStatus, installDaemonPlugin, isPaseoWorkspaceArchivedOnDisk, listDaemonPlugins, manageDaemonPlugin, prunePaseoProjectRegistry, reloadDaemonConfigViaWs, restoreDaemonWorkspaceViaWs } from "./daemon-cli.ts";
import type { DaemonPluginAction, DaemonPluginItem, DaemonPluginSourceStatus, DaemonPluginUpdateRow, DaemonReply } from "./daemon-cli.ts";
import { effectiveLanesForReconcile, reconcilePaseoRoleProviders } from "./core/role-providers.ts";
import { SEAT_TITLES, inferRoleFromProviderId, resolveEffectiveProviderFamily } from "./roles.ts";
import type { SeatName } from "./roles.ts";
import { ensureProjectRegistered, discoverProjects, writeProjectRegistration } from "./projects.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { COMPANION_CATALOG, CORE_PLUGIN_ENTRY, MANAGEABLE_PLUGIN_IDS } from "../shared/companions.ts";
import type { CompanionCatalogEntry, ManageablePluginId } from "../shared/companions.ts";
import type { SpoolLeadDispatchRequest, SpoolReply } from "./spool.ts";
import {
  accept,
  executionSetMode,
  scrumCommand,
  lanesSet,
  lanesReset,
  lanesSetBatch,
  leadDispatch,
  leadEnsure,
  leadRotate,
  pluginsCheckUpdates,
  pluginsInstall,
  pluginsManage,
  profilesApply,
  profilesDelete,
  profilesSave,
  projectAdd,
  projectDelete,
  projectPickFolder,
  projectReset,
  ratifyProposal,
  retro,
  snapshot,
  supervisorEnsure,
  supervisorRevoke,
  taskDetail,
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
import type { ExecutionView, AgentView, LaneName, LaneProfileView, Lanes, ProjectView, TaskView, VaultStatusView } from "../shared/view.ts";

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
   */
  lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null;
  /**
   * The persistence slice naming the provider-native session handle — the Pi
   * `.jsonl` fallback's path across daemon restarts (v0.0.20, ADR 0013 §5).
   */
  persistence?: { nativeHandle?: string } | null;
  /**
   * The Paseo Workspace the agent's session lives in (v0.0.31, ADR 0017 §5)
   * — carried on the daemon's own agent row, so `ensureSeat` can co-locate
   * Lead inside the Supervisor's main Workspace. Null/absent when the daemon
   * reports none.
   */
  workspaceId?: string | null;
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
  stateDir: string;
  /** The paseo home — the daemon the seat bridges and CLI fallbacks target. */
  home: string;
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
  handoffPending?: (slug: string) => boolean;
  onLeadRetired?: (input: { slug: string; agentId: string }) => void;
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
  leadDispatch?: (request: SpoolLeadDispatchRequest) => Promise<SpoolReply>;
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
  /** Native OS folder picker override (v0.0.35, ADR 0024; tests) — `osascript` on macOS by default. */
  pickFolder?: (prompt?: string) => Promise<string | null> | string | null;
  /** Alias for pickFolder. */
  folderPicker?: (prompt?: string) => Promise<string | null> | string | null;
  onLog?: (message: string) => void;
}

/** How many agents one snapshot resolves a Timeline Oracle seqEnd for (seats + bound workers). */
const SEQ_END_CAP = 12;

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

function defaultPickFolderOnMac(prompt = "Select a project folder for Factory:"): string | null {
  if (process.platform !== "darwin") {
    throw new FactoryError(
      "folder-picker-unsupported",
      `Native folder picker is only supported on macOS (current platform: ${process.platform}); paste a path instead.`,
    );
  }
  const escapedPrompt = prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const res = spawnSync("osascript", ["-e", `POSIX path of (choose folder with prompt "${escapedPrompt}")`], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (res.status === 0 && typeof res.stdout === "string") {
    const trimmed = res.stdout.trim();
    return trimmed === "" ? null : trimmed.replace(/\/+$/, "") || "/";
  }
  const stderr = typeof res.stderr === "string" ? res.stderr : "";
  if (res.status === 1 || /user canceled|-128/i.test(stderr)) {
    return null;
  }
  throw new FactoryError(
    "folder-picker-failed",
    `Failed to open native folder picker: ${stderr.trim() || res.error?.message || `exit ${res.status ?? "unknown"}`}`,
  );
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
  let localUpdateSnapshot: { statuses: ReadonlyMap<string, DaemonPluginSourceStatus>; checkedAt: string } | null = null;

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
    const registration = readProjectRegistration(deps.stateDir, slug);
    const bound = seat === "supervisor" ? registration?.supervisor : registration?.lead;
    return agents.find(
      (agent) =>
        (bound !== undefined && agent.id === bound) ||
        (inferRoleFromProviderId(agent.provider) === seat &&
          (agent.labels?.project === slug || (registration?.root !== undefined && agent.cwd === registration.root))),
    );
  };

  /** The live non-archived seat agent — `seat` plus, when scoped, the Project's slug label. */
  const seatOf = async (daemon: SurfaceDaemonApi, seat: "supervisor" | "lead", projectSlug?: string): Promise<SurfaceAgentSnapshot | undefined> => {
    const labels: Record<string, string> = projectSlug === undefined ? { seat } : { seat, project: projectSlug };
    const page = await daemon.agents.list({ filter: { labels, includeArchived: false, includeBackground: true } });
    for (const entry of page.entries) {
      if (entry.agent.archivedAt === null) return entry.agent;
    }
    // The native-picker seat (ADR 0017 §2): unlabeled, but bound in
    // `project.json` or running under its `factory-*` role provider.
    let all: { entries: { agent: SurfaceAgentSnapshot }[] };
    try {
      all = await daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
    } catch {
      return undefined;
    }
    const liveAgents = all.entries.map((entry) => entry.agent).filter((agent) => agent.archivedAt === null);
    if (projectSlug === undefined) {
      const byRoleProvider = liveAgents.find((agent) => inferRoleFromProviderId(agent.provider) === seat);
      if (byRoleProvider !== undefined) return byRoleProvider;
      for (const reg of listProjectRegistrations(deps.stateDir)) {
        const matched = seatAgentByIdentity(liveAgents, reg.slug, seat);
        if (matched !== undefined) return matched;
      }
      return undefined;
    }
    return seatAgentByIdentity(
      liveAgents,
      projectSlug,
      seat,
    );
  };

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
  const agentTaskIndex = (): Map<string, string> => {
    const index = new Map<string, string>();
    for (const evt of deps.factory.ledger.events) {
      const agent = evt.event === "claim_reported" || evt.event === "meter_written" ? evt.agent : evt.event === "repoke_dispatched" ? evt.agent : undefined;
      if ("task" in evt && typeof evt.task === "string" && typeof agent === "string" && agent !== "") index.set(agent, evt.task);
    }
    return index;
  };

  /**
   * Enriches folded `TaskView` rows with Peer `agentId` bindings from
   * `<stateDir>/correlations.json` (and live daemon agents when present) so a
   * spawned Peer conversation is reachable even before its first Claim or when
   * a claim arrived without an agent stamp.
   */
  const enrichTaskPeerAgents = (tasks: readonly TaskView[], liveAgents: readonly SurfaceAgentSnapshot[] = []): TaskView[] => {
    const correlations = new CorrelationRegistry(deps.stateDir).list();
    return tasks.map((taskView) => {
      const contract = deps.factory.contractFor(taskView.task);
      const livePeer = liveAgents.find(
        (a) => a.labels.seat === "agent" && a.labels.task === taskView.task && typeof a.id === "string" && a.id !== "",
      );
      const corrPeer = correlations.findLast(
        (r) =>
          r.role === "agent" &&
          r.task === taskView.task &&
          typeof r.agentId === "string" &&
          r.agentId !== "" &&
          (contract === undefined || r.issuedAt >= contract.ts),
      );
      const fallbackAgentId = livePeer?.id ?? corrPeer?.agentId ?? null;
      const resolvedTaskAgentId = taskView.agentId ?? fallbackAgentId;
      const attempts = taskView.attempts.map((attempt, idx) =>
        (attempt.agentId === null || attempt.agentId === undefined) && idx === taskView.attempts.length - 1 && resolvedTaskAgentId !== null
          ? { ...attempt, agentId: resolvedTaskAgentId }
          : attempt,
      );
      return {
        ...taskView,
        agentId: resolvedTaskAgentId,
        attempts,
      };
    });
  };

  /** One task's contract workspace sits inside the Project root (equal or nested). */
  const taskInProject = (task: string, root: string, slug?: string): boolean => {
    const contract = deps.factory.contractFor(task);
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

  /**
   * The Lead telemetry join (v0.0.20, ADR 0013 §6): the Lead's own labels
   * name its Project, so its card's facts fold in here — the live
   * context-window pair from the daemon's `lastUsage` (null when it reports
   * none), the durable `rotationState` from `project.json` (unset when
   * unrecorded — absent reads as "normal"), and the queued count from the
   * Project's `mailbox.jsonl` fold (0 when no mailbox exists yet; a damaged
   * one renders no count, never a failed snapshot). Non-Lead agents — and a
   * Lead the daemon lists without its project label — leave all four unset.
   */
  const leadTelemetryOf = (
    agent: SurfaceAgentSnapshot,
  ): Pick<AgentView, "contextUsedTokens" | "contextMaxTokens" | "rotationState" | "queuedMailCount"> => {
    if (agent.labels.seat !== "lead" || agent.labels.project === undefined) return {};
    const tokens = {
      contextUsedTokens: agent.lastUsage?.contextWindowUsedTokens ?? null,
      contextMaxTokens: agent.lastUsage?.contextWindowMaxTokens ?? null,
    };
    let queued: number;
    try {
      queued = readLeadMailbox(join(projectStateDir(deps.stateDir, agent.labels.project), "mailbox.jsonl")).queued.length;
    } catch {
      return tokens; // an unreadable mailbox is not a snapshot failure — the count stays unset
    }
    const rotationState = readProjectRegistration(deps.stateDir, agent.labels.project)?.rotationState;
    return { ...tokens, queuedMailCount: queued, ...(rotationState === undefined ? {} : { rotationState }) };
  };

  /** One agent → AgentView, with the Timeline Oracle seqEnd when the daemon answers. */
  const agentViewOf = async (
    daemon: SurfaceDaemonApi,
    agent: SurfaceAgentSnapshot,
    task: string | null,
    seatOverride?: "supervisor" | "lead",
  ): Promise<AgentView> => {
    let seqEnd: number | null = null;
    try {
      const page = await daemon.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 1 });
      const entry = page.entries?.[0];
      if (typeof entry?.seqEnd === "number") seqEnd = entry.seqEnd;
    } catch {
      // the oracle's answer is optional — the card renders without it
    }
    return {
      id: agent.id,
      title: agent.title,
      status: agent.status,
      provider: agent.provider,
      model: agent.model,
      ...(agent.thinkingOptionId === undefined ? {} : { thinking: agent.thinkingOptionId }),
      // A native-picker seat carries no labels — its recognized seat rides anyway (ADR 0017 §2).
      seat: agent.labels.seat ?? seatOverride ?? null,
      task,
      seqEnd,
      ...leadTelemetryOf(agent),
      requiresAttention: agent.requiresAttention,
      cwd: agent.cwd,
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
  const ensureSeat = async (
    seat: SeatName,
    input: { projectRoot: string; message?: string },
    context?: SurfaceCallContext,
  ): Promise<{ ok: true; agentId: string; created: boolean; projectRoot: string; slug: string } | { ok: false; code: string; error: string }> => {
    const project = projectOrRefusal(input.projectRoot);
    if (!project.ok) return project;
    const daemon = resolveDaemon(context);
    const lanes = loadLanes(deps.stateDir, project.slug);
    if (!lanes.ok) return failure("lanes-unreadable", lanes.reason);
    let providers: ProviderEntry[] = [];
    try {
      providers = await resolveProviders(daemon);
    } catch {
      // best-effort provider catalog lookup
    }
    const selected = readExecution(deps.stateDir, project.slug);
    const scrumRoster = selected.mode === "scrum" ? (listRuns(deps.stateDir, project.slug).find(r => !terminalRun(r))?.config ?? readScrumConfig(deps.stateDir, project.slug)) : undefined;
    if (selected.mode === "scrum" && !scrumRoster) return failure("scrum-config-missing", project.slug);
    const lane = sanitizeLaneWithProviders(scrumRoster?.lanes[seat] ?? lanes.lanes[seat], providers);
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
      if (agent.status === "error" || !sameProviderFamily || !sameCwd || selected.mode === "scrum" && agent.labels.scrumConfigRevision !== String(scrumRoster?.configRevision ?? 1)) {
        const retired = await retireSeat(seat, project.slug, project.root, context);
        if (!retired.ok) {
          log(`${seat}: retiring unhealthy seat ${agent.id} before recreate did not cleanly settle — ${retired.error}`);
        }
        agent = undefined;
      } else if (parsed !== undefined) {
        const sync = deps.setAgentModel ?? setAgentModelViaCli;
        const syncThinking = deps.setAgentThinking ?? setAgentThinkingViaCli;
        const currentModel =
          agent.model ?? (agent.provider.startsWith(`${parsed.provider}/`) ? agent.provider.slice(parsed.provider.length + 1) : null);
        if (currentModel !== null && currentModel !== parsed.model && currentModel !== `${parsed.provider}/${parsed.model}`) {
          await sync(agent.id, parsed.model, deps.home);
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
      const title = selected.mode === "scrum" && seat === "lead" ? "Scrum Lead" : SEAT_TITLES[seat];
      const config =
        parsed?.thinking !== undefined
          ? { provider: `${parsed.provider}/${parsed.model}`, thinkingOptionId: parsed.thinking }
          : { provider: lane };
      const parent = seat === "lead" ? supervisorSnapshot?.id : undefined;
      const createInWorkspace = async (targetWorkspaceId: string): Promise<{ id: string }> =>
        daemon.workspaces!.ref(targetWorkspaceId).agents.create({
          config,
          title,
          labels: { seat, project: project.slug, ...(selected.mode === "scrum" ? { execution: "scrum", scrumConfigRevision: String(scrumRoster?.configRevision ?? 1) } : {}) },
          ...(parent !== undefined ? { parent } : {}),
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
              const parentHasFailedWorkspace =
                parent !== undefined &&
                typeof supervisorSnapshot?.workspaceId === "string" &&
                supervisorSnapshot.workspaceId === workspaceId;
              handle = await daemon.agents.create({
                config,
                cwd: project.root,
                title,
                labels: { seat, project: project.slug, ...(selected.mode === "scrum" ? { execution: "scrum", scrumConfigRevision: String(scrumRoster?.configRevision ?? 1) } : {}) },
                ...(parent !== undefined && !parentHasFailedWorkspace ? { parent } : {}),
              });
              workspaceId = undefined;
            }
          }
        } else {
          handle = await daemon.agents.create({
            config,
            cwd: project.root,
            title,
            labels: { seat, project: project.slug, ...(selected.mode === "scrum" ? { execution: "scrum", scrumConfigRevision: String(scrumRoster?.configRevision ?? 1) } : {}) },
            ...(parent !== undefined ? { parent } : {}),
          });
        }
        agent = {
          id: handle.id,
          provider: config.provider,
          title,
          status: "initializing",
          model: parsed?.model ?? null,
          ...(parsed?.thinking !== undefined ? { thinkingOptionId: parsed.thinking } : {}),
          labels: { seat, project: project.slug, ...(selected.mode === "scrum" ? { execution: "scrum", scrumConfigRevision: String(scrumRoster?.configRevision ?? 1) } : {}) },
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
    const message = input.message?.trim();
    if (message !== undefined && message !== "") {
      try {
        await daemon.agents.ref(agent.id).send(message);
        deps.onSeatKickoffSent?.({ slug: project.slug, seat, agentId: agent.id });
        log(`${seat}: dispatched a message to ${agent.id}`);
      } catch (err) {
        return failure("send-failed", `the ${seat} agent exists (${agent.id}) but the dispatch failed: ${messageOf(err)}`);
      }
    }
    return { ok: true as const, agentId: agent.id, created, projectRoot: project.root, slug: project.slug };
  };

  /** Cancel + archive one Project's live seat agent — the rotate/revoke retirement. */
  const retireSeat = async (
    seat: "supervisor" | "lead",
    projectSlug: string | undefined,
    projectRoot: string | undefined,
    context?: SurfaceCallContext,
  ): Promise<{ ok: true; agentId: string } | { ok: false; code: string; error: string }> => {
    const daemon = resolveDaemon(context);
    let agent: SurfaceAgentSnapshot | undefined;
    try {
      agent = await seatOf(daemon, seat, projectSlug);
    } catch (err) {
      return failure("daemon-unavailable", `cannot read the daemon's agents: ${messageOf(err)}`);
    }
    if (agent === undefined) {
      return failure(seat === "lead" ? "no-lead" : "no-supervisor", `no live seat=${seat}${projectSlug === undefined ? "" : `, project=${projectSlug}`} agent on this daemon — nothing to retire`);
    }
    // Cancel first (best-effort: an idle agent has nothing to cancel), then
    // archive — the retirement the seat graph reads.
    const stop = deps.stopAgent ?? stopAgentViaCli;
    const stopped = await stop(agent.id, deps.home);
    if (!stopped.ok) log(`${seat}: cancel before retire did not land — ${stopped.reason}`);
    try {
      await daemon.agents.ref(agent.id).archive();
    } catch (err) {
      return failure("archive-failed", `archiving ${seat} ${agent.id} failed: ${messageOf(err)}`);
    }
    if (projectSlug !== undefined && projectRoot !== undefined) {
      writeProjectRegistration(deps.stateDir, projectSlug, { root: projectRoot, ...(seat === "lead" ? { lead: null } : { supervisor: null }) });
    }
    // The Lead's mailbox settle (v0.0.20, ADR 0013 §4's last arm): a retired
    // Lead can never ack its live delivery, so the un-acked batch returns to
    // `queued` (`mail_requeued`, reason "lead-rotated") the moment the seat
    // archives — a manual rotate racing a live delivery delays the mail to
    // the next Lead, never strands it. The automatic handoff arm rides this
    // same door as a no-op (its turn boundary settles first).
    if (seat === "lead" && projectSlug !== undefined) {
      try {
        deps.onLeadRetired?.({ slug: projectSlug, agentId: agent.id });
      } catch (err) {
        log(`lead: the rotation's mailbox settle of ${projectSlug} failed — startup recovery remains the net (${messageOf(err)})`);
      }
    }
    log(`${seat}: retired ${agent.id} (cancelled + archived)`);
    return { ok: true as const, agentId: agent.id };
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
    const projectTaskSet = new Set<string>();
    for (const evt of deps.factory.ledger.events) {
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
    const bound = agentTaskIndex();
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
      if (!options.includeSeats && (seatLabel === "supervisor" || seatLabel === "lead")) continue;
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
          (typeof boundTask === "string" && (projectTaskSet.has(boundTask) || taskInProject(boundTask, project.root)))
        : (seatLabel === "agent" && agent.labels.project === project.slug) ||
          (typeof boundTask === "string" && (projectTaskSet.has(boundTask) || taskInProject(boundTask, project.root))) ||
          inWorktree;
      if (!matchesProject) continue;

      if (options.includeSeats && isLeadRole) {
        try {
          deps.onLeadRetired?.({ slug: project.slug, agentId: agent.id });
        } catch {
          // best-effort
        }
      }
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
   * the active scope's effective `Lanes` (ADR 0017 §1, ADR 0026 §1) so Paseo's
   * New Chat picker immediately reflects the model and thinking level the Owner
   * just saved or applied, while `server.before("agent.create")` enforces each
   * Project's own `<projectStateDir>/lanes.json` at agent launch time.
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
  const projectUsesSlp = (slug: string): boolean => { try { return readExecution(deps.stateDir, slug).mode === "slp"; } catch { return false; } };
  const syncLiveSeatsAfterLaneUpdate = async (input: {
    projectSlug: string;
    projectRoot: string;
    /** The Project's effective lanes BEFORE the write. */
    before: Pick<Lanes, "supervisor" | "lead">;
    /** The Project's effective lanes AFTER the write. */
    after: Pick<Lanes, "supervisor" | "lead">;
    executionMode?: "slp" | "scrum";
    /** Only these seats are considered (the lanes the act actually touches). */
    seats?: readonly ("supervisor" | "lead")[];
    context?: SurfaceCallContext;
  }): Promise<string> => {
    if (input.executionMode === "scrum" ? readExecution(deps.stateDir, input.projectSlug).mode !== "scrum" : !projectUsesSlp(input.projectSlug)) return "skipped — config saved for a future execution selection";
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
      // Cross-provider family: retire/rotate through the same door the Owner's
      // rotate/revoke acts ride — cancel + archive, clear the registration
      // binding, and (Lead) settle the mailbox so queued mail requeues.
      const retired = await retireSeat(seat, input.projectSlug, input.projectRoot, input.context);
      if (retired.ok) {
        parts.push(
          seat === "lead"
            ? `retired — agent ${agent.id.slice(0, 8)} rotated onto ${toLane}'s provider family (queued Lead mail requeues for the next Lead)`
            : `retired — agent ${agent.id.slice(0, 8)} rotated onto ${toLane}'s provider family (the next turn/dispatch spawns a fresh Supervisor)`,
        );
      } else {
        parts.push(`retire failed — ${retired.error}`);
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

  const executionView = (slug?: string): ExecutionView => {
    try {
      const selection = readExecution(deps.stateDir, slug);
      const pending = slug ? readSwitchIntent(deps.stateDir, slug) : undefined;
      const base = {
        selectedMode: selection.mode,
        revision: selection.revision,
        pendingSwitch:
          pending?.status === "pending"
            ? { from: pending.previous.mode, to: pending.target.mode }
            : null,
        ...(pending?.status === "pending"
          ? { pendingMode: pending.target.mode }
          : {}),
      };
      try {
        const runs = slug ? listRuns(deps.stateDir, slug) : [];
        const config = readScrumConfig(deps.stateDir, slug);
        const profiles = readScrumProfiles(deps.stateDir).profiles;
        const activePath = join(
          scopeDir(deps.stateDir, slug),
          "scrum-active-profile.json",
        );
        const recorded = existsSync(activePath)
          ? (JSON.parse(readFileSync(activePath, "utf8")) as { id: string })
          : undefined;
        const activeProfileId =
          profiles.find((p) => p.id === recorded?.id)?.id ?? null;
        const run = runs.find((r) => !terminalRun(r)) ?? runs.at(-1);
        const skippedPhases =
          run?.track === "small" &&
          !run.tasks.some((t) => ["ux", "architect"].includes(t.role))
            ? [{ phase: "design", reason: `Small track: ${run.rationale}` }]
            : [];
        return {
          ...base,
          scope: slug ? "project" : "global",
          project: slug ?? null,
          newProjectDefaultMode: readExecution(deps.stateDir).mode,
          machineConfig: readScrumConfig(deps.stateDir),
          config,
          profiles,
          activeProfileId,
          activeProfileModified: !!config && profiles.some(profile => profile.id === activeProfileId && (JSON.stringify(profile.config.lanes) !== JSON.stringify(config.lanes) || profile.config.requireUiApproval !== config.requireUiApproval)),
          run: run ? { ...run, skippedPhases } : undefined,
          activeRun: run ? { ...run, skippedPhases } : undefined,
        };
      } catch (error) {
        return { ...base, error: messageOf(error) };
      }
    } catch (error) {
      return {
        selectedMode: "slp" as const,
        revision: 0,
        error: messageOf(error),
      };
    }
  };
  const executionWork = async (project: { slug: string; root: string }, context?: SurfaceCallContext, cachedAgents?: readonly SurfaceAgentSnapshot[]) => {
    const blockers: string[] = [];
    for (const event of deps.factory.ledger.events) if (event.event === "contract_set" && taskInProject(event.task, project.root, project.slug)) {
      const task = projectTask(deps.factory.ledger.events, event.task);
      if (!task.settled || task.pendingLanding || task.inFlightAttempt !== undefined) blockers.push(`Task ${event.task}: ${task.status}${task.pendingLanding ? " pending-conflict" : ""}`);
    }
    const mailbox = readLeadMailbox(join(scopeDir(deps.stateDir, project.slug), "mailbox.jsonl"));
    const pendingDirectives = mailbox.queued.some(m => m.kind === "directive") || mailbox.supervisorQueued.some(m => m.kind === "directive") || mailbox.inFlight !== null || mailbox.supervisorInFlight !== null;
    if (mailbox.queued.length || mailbox.supervisorQueued.length || mailbox.inFlight !== null || mailbox.supervisorInFlight !== null) blockers.push("pending/in-flight mailbox delivery");
    const reg = readProjectRegistration(deps.stateDir, project.slug);
    if (reg?.rotationState && reg.rotationState !== "normal") blockers.push(`Lead handoff: ${reg.rotationState}`);
    if (deps.handoffPending?.(project.slug)) blockers.push("unfinished Lead handoff kickoff");
    const live = cachedAgents ?? (await resolveDaemon(context).agents.list({ filter: { includeArchived: false, includeBackground: true } })).entries.map(e => e.agent);
    const agents = live.filter(a => a.archivedAt === null && (a.labels.project === project.slug || a.cwd === project.root) && ["running", "initializing"].includes(a.status));
    blockers.push(...agents.map(a => `Agent ${a.id}: ${a.status}`));
    if (readExecution(deps.stateDir, project.slug).mode === "scrum") for (const run of listRuns(deps.stateDir, project.slug)) { if (!terminalRun(run)) blockers.push(`Scrum ${run.runId}: ${run.phase}`); else if (run.phase === "completed" && run.completionRequest && !run.completionReported) blockers.push(`Scrum ${run.runId}: completion report pending`); }
    return { blockers: [...new Set(blockers)], activeAgents: agents.filter(a => a.labels.seat === "agent").map(a => a.id), pendingDirectives };
  };
  const handlers = {
    async executionSetMode(input: { mode: "slp" | "scrum"; projectRoot?: string }, context?: SurfaceCallContext) {
      try {
        if (!input.projectRoot) { if (input.mode === "scrum") ensureScrumConfig(deps.stateDir); return { ok: true as const, data: saveExecutionDefault(deps.stateDir, input.mode) }; }
        const project = projectOrRefusal(input.projectRoot);
        if (!project.ok) return project;
        const data = await withExecutionLane(deps.stateDir, project.slug, async () => {
          const work = await executionWork(project, context);
          return switchExecution({ state: deps.stateDir, slug: project.slug, mode: input.mode, blockers: work.blockers, rotate: async () => {
            for (const seat of ["lead", "supervisor"] as const) {
              const retired = await retireSeat(seat, project.slug, project.root, context);
              if (!retired.ok && !["no-lead", "no-supervisor"].includes(retired.code)) throw new FactoryError(retired.code, retired.error);
            }
          } });
        });
        return { ok: true as const, data };
      } catch (error) { return failure(codeOf(error), messageOf(error)); }
    },
    async scrumCommand(input: ScrumOperation & { projectRoot?: string }, context?: SurfaceCallContext, caller?: { authority: "owner" | "supervisor" | "lead" | "agent"; actor: string }) {
      try {
        const project = input.projectRoot ? projectOrRefusal(input.projectRoot) : undefined;
        if (project && !project.ok) return project;
        const work = project?.ok ? await executionWork(project, context) : { activeAgents: [], pendingDirectives: false };
        const authority = caller?.authority ?? "owner";
        if (input.operation === "run.cancel") {
          if (authority !== "owner" && authority !== "supervisor") throw new FactoryError("scrum-cancel-unauthorized", "Owner/Supervisor required");
          if (!project?.ok || !input.runId) throw new FactoryError("project-required", "Project and run required");
          return await withExecutionLane(deps.stateDir, project.slug, async () => {
            const requested = commandRun(deps.stateDir, project.slug, input.runId!, { type: "cancellation_requested", requestId: input.requestId, expectedRevision: input.expectedRevision!, reason: String(input.payload?.reason ?? "Owner cancellation; unresolved Tasks retained"), actor: caller?.actor ?? "owner" });
            if (requested.phase === "cancelled") return { ok: true as const, data: requested };
            const page = await resolveDaemon(context).agents.list({ filter: { includeArchived: false, includeBackground: true } });
            const peers = new Map(requested.tasks.flatMap(task => boundTaskPeers({ stateDir: deps.stateDir, slug: project.slug, task: task.task, events: deps.factory.ledger.events, live: page.entries.map(e => e.agent) })).map(agent => [agent.id, agent]));
            for (const { agent } of page.entries) if (agent.archivedAt === null && agent.labels.project === project.slug && agent.labels.run === input.runId && agent.labels.seat === "agent") peers.set(agent.id, agent);
            for (const agent of peers.values()) {
              const stopped = await (deps.stopAgent ?? stopAgentViaCli)(agent.id, deps.home);
              if (!stopped.ok) throw new FactoryError("agent-stop-failed", stopped.reason);
              await resolveDaemon(context).agents.ref(agent.id).archive();
            }
            const current = readRun(deps.stateDir, project.slug, input.runId!);
            return { ok: true as const, data: commandRun(deps.stateDir, project.slug, input.runId!, { requestId: `${input.requestId}:cancelled`, expectedRevision: current.revision, type: "phase_changed", phase: "cancelled", reason: requested.cancellation!.reason, telemetry: scrumTelemetry(current, deps.factory.ledger.events) }) };
          });
        }
        const execute = async () => {
          const currentWork = project?.ok ? await executionWork(project, context) : work;
          const updatesRoster = ["config.set", "config.reset", "profile.apply"].includes(input.operation);
          const before = project?.ok && updatesRoster ? readScrumConfig(deps.stateDir, project.slug) : undefined;
          const data = scrumOperation(input, { factory: deps.factory, ...(project?.ok ? { slug: project.slug, root: project.root } : {}), authority, actor: caller?.actor ?? "owner", activeAgents: currentWork.activeAgents, pendingDirectives: currentWork.pendingDirectives });
          if (project?.ok && before && updatesRoster && readExecution(deps.stateDir, project.slug).mode === "scrum" && !listRuns(deps.stateDir, project.slug).some(run => !terminalRun(run))) {
            const after = readScrumConfig(deps.stateDir, project.slug);
            if (after) await syncLiveSeatsAfterLaneUpdate({ projectSlug: project.slug, projectRoot: project.root, before: before.lanes, after: after.lanes, executionMode: "scrum", context });
          }
          return { ok: true as const, data };
        };
        return project?.ok ? await withExecutionLane(deps.stateDir, project.slug, execute) : await execute();
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
          } else if (existsSync(rawRoot)) {
            const bootstrapped = resolveOrBootstrapProject(rawRoot, {
              stateDir: deps.stateDir,
              paseoHome: deps.home,
            });
            if (bootstrapped.ok) {
              ensureProjectRegistered(deps.stateDir, bootstrapped);
              project = {
                slug: bootstrapped.slug,
                root: bootstrapped.root,
                name: bootstrapped.name,
                commonDir: bootstrapped.gitCommonDir,
              };
            }
          }
        }
      }
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
      const bound = agentTaskIndex();
      const allEvents = [...deps.factory.ledger.events];

      let rawAgents: SurfaceAgentSnapshot[] = [];
      let providers: ProviderEntry[] = [];
      let daemonError: string | null = null;
      let supervisorRaw: SurfaceAgentSnapshot | undefined;
      let leadRaw: SurfaceAgentSnapshot | undefined;
      try {
        const page = await daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
        rawAgents = page.entries.map((entry) => entry.agent).filter((agent) => agent.archivedAt === null);
        const seatOfProject = (seat: "supervisor" | "lead"): SurfaceAgentSnapshot | undefined => {
          const byLabels = rawAgents.find(
            (agent) => agent.labels.seat === seat && (project === null || agent.labels.project === project.slug),
          );
          if (byLabels !== undefined) return byLabels;
          if (project === null) {
            const byRoleProvider = rawAgents.find((agent) => inferRoleFromProviderId(agent.provider) === seat);
            if (byRoleProvider !== undefined) return byRoleProvider;
            for (const reg of listProjectRegistrations(deps.stateDir)) {
              const matched = seatAgentByIdentity(rawAgents, reg.slug, seat);
              if (matched !== undefined) return matched;
            }
            return undefined;
          }
          // The native-picker seat (ADR 0017 §2): unlabeled, but bound in
          // `project.json` or running under its `factory-*` role provider.
          return seatAgentByIdentity(rawAgents, project.slug, seat);
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
      const relevant = rawAgents.filter(inScope).slice(0, SEQ_END_CAP);
      const agents: AgentView[] = [];
      for (const agent of relevant) {
        const seatOverride = agent.id === supervisorRaw?.id ? ("supervisor" as const) : agent.id === leadRaw?.id ? ("lead" as const) : undefined;
        agents.push(await agentViewOf(daemon, agent, bound.get(agent.id) ?? null, seatOverride));
      }
      const supervisor = supervisorRaw === undefined ? null : (agents.find((agent) => agent.id === supervisorRaw!.id) ?? null);
      const lead = leadRaw === undefined ? null : (agents.find((agent) => agent.id === leadRaw!.id) ?? null);

      const allTasks = foldTasks(allEvents);
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
          rawAgents.find((a) => a.labels.seat === "supervisor" && a.labels.project === entry.slug) ??
          seatAgentByIdentity(rawAgents, entry.slug, "supervisor");
        const liveLead =
          rawAgents.find((a) => a.labels.seat === "lead" && a.labels.project === entry.slug) ??
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
        const execution = executionView(entry.slug);
        return {
          slug: entry.slug,
          root: entry.root,
          name: entry.name ?? reg?.name ?? (basename(entry.root) || entry.slug),
          ...(resolvedCommonDir !== undefined ? { commonDir: resolvedCommonDir } : {}),
          ...(entry.missingRoot ? { missingRoot: true } : {}),
          supervisorId: liveSup?.id ?? reg?.supervisor ?? entry.supervisorId ?? null,
          leadId: liveLead?.id ?? reg?.lead ?? entry.leadId ?? null,
          executionMode: execution.selectedMode,
          activeScrumPhase: (() => { const run = execution.run; return run && !["completed", "cancelled"].includes(run.phase) ? run.phase : null; })(),
          activeTaskCount: allTasks.filter((t) => taskInProject(t.task, entry.root, entry.slug)).length,
        };
      };
      const projects = discoverProjects(
        deps.stateDir,
        rawAgents.filter(
          (agent) =>
            agent.labels.seat !== undefined ||
            agent.labels.project !== undefined ||
            inferRoleFromProviderId(agent.provider) !== undefined,
        ),
        deps.home,
      )
        .filter((entry): entry is typeof entry & { root: string } => entry.root !== null)
        .map(enrichProjectView);
      const enrichedProject = scopedProject === null ? null : enrichProjectView(scopedProject);

      const updateSnap = localUpdateSnapshot ?? getCachedPluginUpdateStatus(deps.home);
      const view = foldView({
        stateDir: deps.stateDir,
        generatedAt: new Date().toISOString(),
        lanes: lanes.lanes,
        events,
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
        projects,
      });
      // v0.0.38 (ADR 0026 §5): the Lane profile half — the gatherer-owned
      // filesystem probe layered over the fold (the vault-status precedent),
      // so the view carries the Owner's profile library and the scope's
      // active-profile / override state without the fold learning files.
      const execution = executionView(enrichedProject?.slug);
      if (enrichedProject) {
        try { execution.busyReason = (await executionWork(enrichedProject, context, rawAgents)).blockers.join("; ") || null; }
        catch (error) { execution.error ??= messageOf(error); execution.busyReason = "Execution state needs recovery: " + messageOf(error); }
      }
      return {
        ok: true as const,
        view: {
          ...view,
          execution,
          tasks: enrichTaskPeerAgents(view.tasks, rawAgents),
          machineLanes: machineLanes.lanes,
          ...laneProfilesGather(enrichedProject?.slug, view.lanes),
        },
      };
    },

    async taskDetail(input: { task: string }, _context?: SurfaceCallContext) {
      const contract = deps.factory.contractFor(input.task);
      if (contract === undefined) {
        return failure("unknown-task", `no contract set for task ${input.task}`);
      }
      if (!loadLanes(deps.stateDir).ok) return failure("lanes-unreadable", `the lane table under ${deps.stateDir} is unreadable`);
      const folded = foldTasks(deps.factory.ledger.events).find((entry) => entry.task === input.task);
      if (folded === undefined) return failure("unknown-task", `no foldable history for task ${input.task}`);
      const task = enrichTaskPeerAgents([folded])[0]!;
      return {
        ok: true as const,
        detail: {
          version: FACTORY_VIEW_VERSION,
          task,
          contract: {
            task: contract.task,
            workspace: contract.workspace,
            gate: contract.gate,
            artifact: contract.artifact,
            scope: contract.scope === undefined || contract.scope.length === 0 ? null : contract.scope,
            skills: contract.skills === undefined || contract.skills.length === 0 ? null : contract.skills,
            base: contract.base ?? null,
            description: contract.description ?? null,
            watch: contract.watch === true,
            freshEyes: contract.freshEyes === true,
            by: contract.by ?? null,
          },
          attempts: task.attempts.map((attempt) => ({
            n: attempt.n,
            verdict: attempt.verdict,
            agentId: attempt.agentId ?? null,
            report: attempt.report === null ? null : readTailed(deps.stateDir, attempt.report),
            gateLog: attempt.gateLog === null ? null : readTailed(deps.stateDir, attempt.gateLog),
          })),
        },
      };
    },

    async accept(input: { task: string; attempt: number }, context?: SurfaceCallContext) {
      try {
        // Awaited since v0.0.14: a worktree task's local landing runs before
        // the line records, and the summary carries the outcome.
        const event = await executeAcceptance(deps.factory, { task: input.task, attempt: input.attempt, accepted_by: "owner" }, { authority: "owner", daemon: resolveDaemon(context), home: deps.home, cleanup: deps.cleanupDaemonWorkspaces });
        return {
          ok: true as const,
          seq: event.seq,
          summary: acceptanceSummary({ task: input.task, attempt: input.attempt, by: "owner", landing: event.landing, landingNote: event.landingNote }),
        };
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
    },

    async retro(input: { projectRoot?: string }, _context?: SurfaceCallContext) {
      try {
        // v0.0.38 (ADR 0026 §1): the pass honors the active Project's own
        // `retro` lane — a root or slug forwards into the core, which resolves
        // the scope and falls back to the machine lane when omitted.
        const outcome = await deps.factory.retro(input?.projectRoot);
        return {
          ok: true as const,
          outcome: outcome.outcome,
          proposalCount: outcome.proposalCount ?? null,
          proposalsPath: outcome.proposalsPath ?? null,
          error: outcome.error ?? null,
        };
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
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
              if (agent !== undefined && (agent.labels.project === undefined || projectUsesSlp(agent.labels.project))) {
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
      // Reconcile `<home>/config.json` from the active scope's effective lanes
      // (ADR 0026 §1) so Paseo's New Chat picker immediately shows the model
      // and thinking level just saved, while `server.before("agent.create")`
      // enforces each Project's own `<projectStateDir>/lanes.json` at launch.
      reconcileRoleProvidersFromScope(saved.lanes);
      return { ok: true as const, lanes: saved.lanes, modelSync };
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
      reconcileRoleProvidersFromScope(saved.lanes);
      return { ok: true as const, lanes: saved.lanes, modelSync };
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
      reconcileRoleProvidersFromScope(reset.lanes);
      return { ok: true as const, lanes: reset.lanes, removed: reset.removed, modelSync };
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
      // Reconcile `<home>/config.json` from the applied scope's effective lanes
      // so Paseo's New Chat picker immediately shows the applied Supervisor model.
      reconcileRoleProvidersFromScope(applied.lanes);
      return { ok: true as const, lanes: applied.lanes, modelSync };
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
          const page = await daemon.agents.list({ filter: { labels: { seat: "supervisor" }, includeArchived: false, includeBackground: true } });
          live = page.entries.map((entry) => entry.agent).filter((agent) => agent.archivedAt === null);
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
     * Add or select a Project directory from the Factory surface (v0.0.35, ADR 0024):
     * automatically bootstraps Git (`git init` + initial empty commit) when given an
     * existing non-Git folder (or an unborn Git repo without `HEAD`), registers
     * `<stateDir>/projects/<slug>/project.json`, synchronizes Paseo's workspace
     * registry when `daemon.workspaces.open` is available, and returns the scoped snapshot.
     */
    async projectAdd(
      input: { projectRoot?: string; path?: string },
      context?: SurfaceCallContext,
    ) {
      const rawPath = (input.projectRoot ?? input.path ?? "").trim();
      if (rawPath === "") {
        return failure("missing-directory", "project directory path cannot be empty");
      }
      const resolved = resolveOrBootstrapProject(rawPath, {
        stateDir: deps.stateDir,
        paseoHome: deps.home,
      });
      if (!resolved.ok) {
        return failure(resolved.code, resolved.reason);
      }
      ensureProjectRegistered(deps.stateDir, resolved);
      const daemon = resolveDaemon(context);
      const existingReg = readProjectRegistration(deps.stateDir, resolved.slug);
      let workspaceId = existingReg?.workspaceId;
      let paseoProjectId = existingReg?.paseoProjectId;
      if (daemon.workspaces?.open !== undefined && (workspaceId === undefined || paseoProjectId === undefined)) {
        try {
          const opened = await daemon.workspaces.open({ cwd: resolved.root });
          if (workspaceId === undefined && typeof opened?.id === "string" && opened.id !== "") {
            workspaceId = opened.id;
          }
          if (paseoProjectId === undefined && typeof opened?.projectId === "string" && opened.projectId !== "") {
            paseoProjectId = opened.projectId;
          }
          if (workspaceId !== undefined || paseoProjectId !== undefined) {
            writeProjectRegistration(deps.stateDir, resolved.slug, {
              root: resolved.root,
              ...(workspaceId !== undefined ? { workspaceId } : {}),
              ...(paseoProjectId !== undefined ? { paseoProjectId } : {}),
            });
          }
        } catch (err) {
          log(`project.add: workspaces.open(${resolved.root}) did not resolve (${messageOf(err)})`);
        }
      }
      const snap = await this.snapshot({ projectRoot: resolved.root }, context);
      const project: ProjectView =
        snap.ok && snap.view.project !== null
          ? { ...snap.view.project, missingRoot: false }
          : {
              slug: resolved.slug,
              root: resolved.root,
              name: resolved.name,
              commonDir: resolved.gitCommonDir,
              missingRoot: false,
              supervisorId: null,
              leadId: null,
              activeTaskCount: 0,
            };
      const summary = resolved.bootstrapped
        ? `Initialized Git repository and added project ${resolved.name} (${resolved.slug}).`
        : `Added project ${resolved.name} (${resolved.slug}).`;
      log(`project.add: ${summary}`);
      return {
        ok: true as const,
        path: resolved.root,
        projectRoot: resolved.root,
        slug: resolved.slug,
        project,
        bootstrapped: resolved.bootstrapped,
        summary,
        ...(snap.ok ? { view: snap.view } : {}),
      };
    },

    /**
     * Native OS folder picker (v0.0.35, ADR 0024): opens the native folder dialog
     * (or invokes `deps.pickFolder` in tests), then delegates to `projectAdd` so
     * bootstrap, safety refusal, registration, and Paseo workspace sync share one seam.
     */
    async projectPickFolder(
      input: { prompt?: string } = {},
      context?: SurfaceCallContext,
    ) {
      const picker = deps.pickFolder ?? deps.folderPicker ?? defaultPickFolderOnMac;
      let chosen: string | null;
      try {
        chosen = await picker(input?.prompt);
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
      if (chosen === null || typeof chosen !== "string" || chosen.trim() === "") {
        return { ok: true as const, cancelled: true as const, path: null };
      }
      const added = await this.projectAdd({ projectRoot: chosen.trim() }, context);
      if (!added.ok) return added;
      return {
        ...added,
        cancelled: false as const,
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
      const { purgedEvents, tasks: purgedTasks, removedFiles } = deps.factory.resetProject(project.root, project.slug);
      rmSync(join(projectDir, "scrum"), { recursive: true, force: true });
      const tasks = [...new Set([...purgedTasks, ...projectTaskSet])];
      try {
        new CorrelationRegistry(deps.stateDir).purgeProject(project.slug, project.root, tasks);
      } catch {
        // best-effort correlation purge
      }
      try {
        rmSync(projectDir, { recursive: true, force: true });
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
          if (retired.ok) archivedSeats.push(retired.agentId);
        }
      }

      // 6. Reset in-memory mailbox state and delete mailbox.jsonl, lead-handoff.md, and stale registration fields while preserving lanes.json.
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
      writeProjectRegistration(deps.stateDir, project.slug, {
        root: project.root,
        ...(input.keepSeats === true ? {} : { supervisor: null, lead: null }),
        rotationState: null,
        handoffRequestedAt: null,
        taskWorkspaces: null,
        dispatchers: null,
      });

      // 7. Purge ledger events, contracts, reports, and gate logs in-memory and on disk.
      const { purgedEvents, tasks: purgedTasks, removedFiles } = deps.factory.resetProject(project.root, project.slug);
      rmSync(join(projectDir, "scrum"), { recursive: true, force: true });
      const tasks = [...new Set([...purgedTasks, ...projectTaskSet])];
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

    async ratifyProposal(input: { projectRoot: string; day: string; proposalId: number }, context?: SurfaceCallContext) {
      const project = projectOrRefusal(input.projectRoot);
      if (!project.ok) return project;
      const retro = foldRetro(deps.factory.ledger.events).findLast((entry) => entry.day === input.day);
      if (retro === undefined) {
        return failure("unknown-retro", `no retro was written on ${input.day} — nothing to ratify`);
      }
      const proposal = retro.proposals.find((entry) => entry.id === input.proposalId);
      if (proposal === undefined) {
        return failure("unknown-proposal", `retro ${input.day} has no proposal R${input.proposalId} — its proposals are ${retro.proposals.map((entry) => `R${entry.id}`).join(", ") || "none"}`);
      }
      // The dispatch (the supervisorEnsure({message}) precedent): the
      // Project's Supervisor applies the ratified proposal to project memory
      // — <project-root>/AGENTS.md, CONTEXT.md, or Gate config — and reports.
      const message = [
        `The Owner ratified retro proposal R${proposal.id} (${proposal.cls}) from ${input.day} — apply it now.`,
        "",
        `Proposal: ${proposal.text}`,
        "",
        `Apply it to this repository's project memory: <project-root>/AGENTS.md or CONTEXT.md for rules and context, or propose the Gate/command change in your reply if it belongs there. Then confirm what changed and where.`,
      ].join("\n");
      const ensured = await ensureSeat("supervisor", { projectRoot: input.projectRoot, message }, context);
      if (!ensured.ok) return ensured;
      log(`retro: R${proposal.id} of ${input.day} ratified via the supervisor of ${project.slug} (${ensured.agentId})`);
      return { ok: true as const, agentId: ensured.agentId, summary: `R${proposal.id} (${proposal.cls}) dispatched to the Supervisor of ${project.slug}` };
    },

    // ---- the companion plugin lifecycle (v0.0.17, ADR 0012 §3) -----------------------------

    async pluginsInstall(
      input: { target: ManageablePluginId | "all"; source?: string; ref?: string },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; installed: string[]; summary: string } | { ok: false; code: string; error: string }> {
      // A custom source or ref names ONE plugin — it cannot ride a batch.
      if (input.target === "all" && (input.source !== undefined || input.ref !== undefined)) {
        return failure("invalid-target", 'a custom source or ref targets one companion — pass a named target, not "all"');
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
        const reply = await installer(deps.home, { id: entry.id, source, ...(input.ref !== undefined ? { ref: input.ref } : {}) });
        if (!reply.ok) return failure("daemon_failed", reply.reason);
        installed.push(entry.id);
        log(`plugins: installed ${entry.id} from ${source}${input.ref === undefined ? "" : ` at ref ${input.ref}`}`);
      }
      return {
        ok: true as const,
        installed,
        summary: pluginsInstallSummary({ ids: installed, source: input.source ?? targets[0]?.canonicalSource ?? "", ref: input.ref, batch: input.target === "all" }),
      };
    },

    async pluginsManage(
      input: { pluginId: ManageablePluginId | "all"; action: DaemonPluginAction },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; pluginId: string; action: string; summary: string } | { ok: false; code: string; error: string }> {
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
        if (targets.length === 0) {
          return { ok: true as const, pluginId: "all", action: "update", summary: "All installed Factory plugins are already up to date." };
        }
        const summaries: string[] = [];
        for (const target of targets) {
          const reply = await manager(deps.home, target.id, "update");
          if (!reply.ok) return failure("daemon_failed", reply.reason);
          summaries.push(pluginsManageSummary(target.id, "update", reply.update));
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
      const reply = await manager(deps.home, input.pluginId, input.action);
      if (!reply.ok) return failure("daemon_failed", reply.reason);
      const summary = pluginsManageSummary(input.pluginId, input.action, reply.update);
      log(`plugins: ${summary}`);
      return { ok: true as const, pluginId: input.pluginId, action: input.action, summary };
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
  const reads = new Set(["cachedProviders", "sanitizeLane", "snapshot", "taskDetail", "pluginsCheckUpdates", "projectPickFolder", "historyImport", "historyImports", "historyUpgrade", "vaultHydrate", "vaultPull", "vaultPush", "vaultSync", "vaultImport"]);
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(handlers, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key !== "string" || typeof value !== "function" || reads.has(key)) return value;
      if (!wrappers.has(key)) wrappers.set(key, (...args: unknown[]) => (key === "projectReset" || key === "projectDelete") && !deps.factory.history.maintenanceActive ? deps.factory.history.withExclusiveMaintenance(() => value.apply(receiver, args)) : deps.factory.history.runOperation(() => value.apply(receiver, args), { newWork: true }));
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
  server.handle(executionSetMode, (input, context) => handlers.executionSetMode(input, pass(context)));
  server.handle(scrumCommand, (input, context) => handlers.scrumCommand(input, pass(context)));
  server.handle(snapshot, (input, context) => handlers.snapshot(input, pass(context)));
  server.handle(taskDetail, (input, context) => handlers.taskDetail(input, pass(context)));
  server.handle(accept, (input, context) => handlers.accept(input, pass(context)));
  server.handle(retro, (input, context) => handlers.retro(input, pass(context)));
  server.handle(lanesSet, (input, context) => handlers.lanesSet(input, pass(context)));
  server.handle(lanesSetBatch, (input, context) => handlers.lanesSetBatch(input, pass(context)));
  server.handle(lanesReset, (input, context) => handlers.lanesReset(input, pass(context)));
  server.handle(profilesSave, (input, context) => handlers.profilesSave(input, pass(context)));
  server.handle(profilesApply, (input, context) => handlers.profilesApply(input, pass(context)));
  server.handle(profilesDelete, (input, context) => handlers.profilesDelete(input, pass(context)));
  server.handle(supervisorEnsure, (input, context) => handlers.supervisorEnsure(input, pass(context)));
  server.handle(supervisorRevoke, (input, context) => handlers.supervisorRevoke(input, pass(context)));
  server.handle(leadEnsure, (input, context) => handlers.leadEnsure(input, pass(context)));
  server.handle(leadRotate, (input, context) => handlers.leadRotate(input, pass(context)));
  server.handle(projectAdd, (input, context) => handlers.projectAdd(input, pass(context)));
  server.handle(projectPickFolder, (input, context) => handlers.projectPickFolder(input ?? {}, pass(context)));
  server.handle(projectDelete, (input, context) => handlers.projectDelete(input, pass(context)));
  server.handle(projectReset, (input, context) => handlers.projectReset(input, pass(context)));
  server.handle(leadDispatch, (input, context) => handlers.leadDispatch(input, pass(context)));
  server.handle(ratifyProposal, (input, context) => handlers.ratifyProposal(input, pass(context)));
  server.handle(pluginsInstall, (input, context) => handlers.pluginsInstall(input, pass(context)));
  server.handle(pluginsManage, (input, context) => handlers.pluginsManage(input, pass(context)));
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
