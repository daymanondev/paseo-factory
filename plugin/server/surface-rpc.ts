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
import { randomUUID } from "node:crypto";
import { FactoryError } from "./core/errors.ts";
import type { Factory } from "./core/factory.ts";
import { readLeadMailbox } from "./core/mailbox.ts";
import { loadLanes, parseLane, saveLanes } from "./core/lanes.ts";
import { projectStateDir, readProjectRegistration, resolveProject } from "./core/project.ts";
import type { ProjectResolution } from "./core/project.ts";
import { hydrateVaultDirect, importVaultSecrets, loadVaultConfig, probeGhAuth, pullVault, pushVault, readVaultStatus, saveVaultConfig, syncVault } from "./core/vault.ts";
import type { ImportVaultSecretsInput, SyncVaultOptions, VaultConfig, VaultRunner } from "./core/vault.ts";
import { join } from "node:path";
import type { LandingResult } from "./core/workspace.ts";
import { FACTORY_VIEW_VERSION } from "../shared/view.ts";
import { foldRetro, foldTasks, foldView, readTailed } from "./view.ts";
import { setAgentModelViaCli, setAgentThinkingViaCli, stopAgentViaCli } from "./daemon-cli.ts";
import { installDaemonPlugin, listDaemonPlugins, manageDaemonPlugin } from "./daemon-cli.ts";
import type { DaemonPluginAction, DaemonPluginItem, DaemonReply } from "./daemon-cli.ts";
import { SEAT_TITLES, renderSeatBootstrap } from "./roles.ts";
import type { SeatName } from "./roles.ts";
import { discoverProjects, writeProjectRegistration } from "./projects.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { COMPANION_CATALOG } from "../shared/companions.ts";
import type { CompanionCatalogEntry } from "../shared/companions.ts";
import type { SpoolLeadDispatchRequest, SpoolReply } from "./spool.ts";
import {
  accept,
  lanesSet,
  leadDispatch,
  leadEnsure,
  leadRotate,
  pluginsInstall,
  pluginsManage,
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
  vaultPush,
  vaultSync,
} from "../shared/rpc.ts";
import type { AgentView, LaneName, Lanes, ProjectView, VaultStatusView } from "../shared/view.ts";

// ---- the daemon slice ---------------------------------------------------------------------

/** The agent snapshot fields the surface reads — plain data, no SDK types. */
export interface SurfaceAgentSnapshot {
  id: string;
  provider: string;
  title: string | null;
  status: string;
  model: string | null;
  thinkingOptionId?: string | null;
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
}

/**
 * The structural slice of PaseoApi the handlers call. The real object from
 * `context.paseo` satisfies it (methods return more; extra fields are
 * harmless), tests pass a fake shaped exactly like it — the choke's
 * `PaseoResponderApi` precedent.
 */
export interface SurfaceDaemonApi {
  agents: {
    list(options?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean } }): Promise<{ entries: { agent: SurfaceAgentSnapshot }[] }>;
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
      timeline: { refetch(options?: { direction?: "tail"; limit?: number }): Promise<{ entries?: { seqEnd?: number }[]; error?: string | null }> };
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
  /**
   * The Lead-mailbox rotation settle (v0.0.20, ADR 0013 §4's last arm):
   * `retireSeat` fires it right after a Project's Lead is archived, so any
   * un-acked in-flight delivery of that Project's `mailbox.jsonl` returns to
   * `queued` as `mail_requeued` (`reason: "lead-rotated"`) — the
   * Lead-mailbox runtime's `settleLeadRotation` is the implementation. A
   * thrown settle is logged, never a failed rotation (startup recovery
   * remains the net).
   */
  onLeadRetired?: (input: { slug: string; agentId: string }) => void;
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
  onLog?: (message: string) => void;
}

/** How many agents one snapshot resolves a Timeline Oracle seqEnd for (seats + bound workers). */
const SEQ_END_CAP = 12;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): string {
  return err instanceof FactoryError ? err.code : "failed";
}

/**
 * The one acceptance sentence both reply surfaces print — the spool's accept
 * reply (the CLI's `factory accept`) and the surface's `factory.accept` RPC
 * (the UI's Accept). One wording, both doors; `landing` absent is the legacy
 * shared-checkout path (no landing ran).
 */
export function acceptanceSummary(input: { task: string; attempt: number; by: string; landing?: LandingResult["landing"]; landingNote?: string }): string {
  return (
    `task ${input.task} accepted at attempt ${input.attempt} by ${input.by}` +
    (input.landing === "landed"
      ? " · landed into <project-root>"
      : input.landing === "pending-conflict"
        ? ` · landing pending-conflict: ${input.landingNote ?? "(no reason recorded)"} — branch factory/${input.task} is preserved`
        : "")
  );
}

/**
 * Automatic archive of an Accepted Task's Paseo workspace (v0.0.23, ADR 0015 §6):
 * looks up `taskWorkspaces[task]` in `<projectStateDir>/project.json`, calls
 * `daemon.workspaces?.archive(workspaceId)` best-effort, and removes the entry
 * from `taskWorkspaces`.
 */
export async function archiveAcceptedTaskWorkspace(factory: Factory, daemon: SurfaceDaemonApi | undefined, task: string): Promise<void> {
  const contract = factory.contractFor(task);
  if (contract === undefined) return;
  const project = resolveProject(contract.workspace);
  if (!project.ok) return;
  const reg = readProjectRegistration(factory.stateDir, project.slug);
  const workspaceId = reg?.taskWorkspaces?.[task];
  if (workspaceId === undefined) return;
  if (daemon?.workspaces?.archive !== undefined) {
    try {
      await daemon.workspaces.archive(workspaceId);
    } catch {
      // best-effort archive
    }
  }
  writeProjectRegistration(factory.stateDir, project.slug, {
    root: project.root,
    taskWorkspaces: { [task]: null },
  });
}

/** One companion install's sentence — the source actually used, the ref when one was given. */
function pluginsInstallSummary(input: { ids: readonly string[]; source: string; ref?: string; batch: boolean }): string {
  if (input.ids.length === 0) return "every companion is already installed — nothing to do";
  const ids = input.ids.join(", ");
  const from = input.batch ? "their canonical sources" : input.source;
  return `installed ${ids} from ${from}${input.ref === undefined ? "" : ` at ref ${input.ref}`}`;
}

/** One companion manage act's sentence — the per-action verb, house style. */
function pluginsManageSummary(pluginId: string, action: DaemonPluginAction): string {
  switch (action) {
    case "enable":
      return `enabled ${pluginId} on the daemon`;
    case "disable":
      return `disabled ${pluginId} on the daemon`;
    case "reload":
      return `reloaded ${pluginId} on the daemon`;
    case "update":
      return `updated ${pluginId} to the latest revision`;
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

  /** The live non-archived seat agent — `seat` plus, when scoped, the Project's slug label. */
  const seatOf = async (daemon: SurfaceDaemonApi, seat: "supervisor" | "lead", projectSlug?: string): Promise<SurfaceAgentSnapshot | undefined> => {
    const labels: Record<string, string> = projectSlug === undefined ? { seat } : { seat, project: projectSlug };
    const page = await daemon.agents.list({ filter: { labels, includeArchived: false } });
    for (const entry of page.entries) {
      if (entry.agent.archivedAt === null) return entry.agent;
    }
    return undefined;
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

  /** One task's contract workspace sits inside the Project root (equal or nested). */
  const taskInProject = (task: string, root: string): boolean => {
    const contract = deps.factory.contractFor(task);
    if (contract === undefined) return false;
    return contract.workspace === root || contract.workspace.startsWith(`${root}/`);
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
  const agentViewOf = async (daemon: SurfaceDaemonApi, agent: SurfaceAgentSnapshot, task: string | null): Promise<AgentView> => {
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
      seat: agent.labels.seat ?? null,
      task,
      seqEnd,
      ...leadTelemetryOf(agent),
      requiresAttention: agent.requiresAttention,
      cwd: agent.cwd,
    };
  };

  type ProviderEntry = {
    provider: string;
    available: boolean;
    models: {
      id: string;
      label: string | null;
      thinkingOptions?: { id: string; label: string | null }[] | null;
      defaultThinkingOptionId?: string | null;
    }[] | null;
  };
  const PROVIDERS_TTL_MS = 5 * 60_000;
  const PROVIDERS_WAIT_MS = 2_000;
  let cachedProviders: ProviderEntry[] | null = null;
  let cachedProvidersAt = 0;
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
      cachedProviders = entries;
      cachedProvidersAt = Date.now();
      return entries;
    })().finally(() => {
      if (inFlightProviders === job) inFlightProviders = null;
    });
    inFlightProviders = job;
    return job;
  };

  const resolveProviders = async (daemon: SurfaceDaemonApi): Promise<ProviderEntry[]> => {
    const now = Date.now();
    if (cachedProviders !== null && now - cachedProvidersAt < PROVIDERS_TTL_MS) {
      return cachedProviders;
    }
    const job = refreshProviders(daemon);
    if (cachedProviders !== null) {
      job.catch(() => {});
      return cachedProviders;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        job,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PROVIDERS_WAIT_MS);
        }),
      ]);
      return raced ?? cachedProviders ?? [];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
    const lane = lanes.lanes[seat];
    let agent: SurfaceAgentSnapshot | undefined;
    try {
      agent = await seatOf(daemon, seat, project.slug);
    } catch (err) {
      return failure("daemon-unavailable", `cannot read the daemon's agents: ${messageOf(err)}`);
    }
    let workspaceId: string | undefined;
    let paseoProjectId: string | undefined;
    if (daemon.workspaces !== undefined) {
      try {
        const opened = await daemon.workspaces.open({ cwd: project.root });
        if (typeof opened?.id === "string" && opened.id !== "") workspaceId = opened.id;
        if (typeof opened?.projectId === "string" && opened.projectId !== "") paseoProjectId = opened.projectId;
      } catch (err) {
        log(`${seat}: workspaces.open(${project.root}) did not resolve (${messageOf(err)}) — falling back to daemon.agents.create`);
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
      const parsed = parseLane(lane);
      const config =
        parsed?.thinking !== undefined
          ? { provider: `${parsed.provider}/${parsed.model}`, thinkingOptionId: parsed.thinking }
          : { provider: lane };
      let parent: string | undefined;
      if (seat === "lead") {
        try {
          const sup = await seatOf(daemon, "supervisor", project.slug);
          if (sup !== undefined) parent = sup.id;
        } catch {
          // best-effort parent lookup
        }
      }
      const prompt = renderSeatBootstrap({
        seat,
        home: deps.home,
        stateDir: deps.stateDir,
        ...(deps.pluginDir === undefined ? {} : { pluginDir: deps.pluginDir }),
        nodePath: process.execPath,
        path: process.env.PATH ?? "",
        lane,
        project,
      });
      try {
        const handle =
          workspaceId !== undefined && daemon.workspaces !== undefined
            ? await daemon.workspaces.ref(workspaceId).agents.create({
                config,
                title,
                labels: { seat, project: project.slug },
                prompt,
                ...(parent !== undefined ? { parent } : {}),
              })
            : await daemon.agents.create({
                config,
                cwd: project.root,
                title,
                labels: { seat, project: project.slug },
                prompt,
                ...(parent !== undefined ? { parent } : {}),
              });
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
    const message = input.message?.trim();
    if (message !== undefined && message !== "") {
      try {
        await daemon.agents.ref(agent.id).send(message);
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

  return {
    async snapshot(input: { projectRoot?: string }, context?: SurfaceCallContext) {
      // An unresolvable scope degrades to the global view — the panel must
      // render outside git repos; the seats-only acts refuse instead.
      const resolved = input.projectRoot === undefined ? undefined : resolveProject(input.projectRoot);
      const project: ProjectView | null = resolved !== undefined && resolved.ok ? { slug: resolved.slug, root: resolved.root } : null;
      const lanes = loadLanes(deps.stateDir, project?.slug);
      if (!lanes.ok) return failure("lanes-unreadable", lanes.reason);
      const daemon = resolveDaemon(context);
      const bound = agentTaskIndex();
      const allEvents = deps.factory.ledger.events;

      let rawAgents: SurfaceAgentSnapshot[] = [];
      let providers: ProviderEntry[] = [];
      let daemonError: string | null = null;
      let supervisorRaw: SurfaceAgentSnapshot | undefined;
      let leadRaw: SurfaceAgentSnapshot | undefined;
      try {
        const page = await daemon.agents.list({ filter: { includeArchived: false } });
        rawAgents = page.entries.map((entry) => entry.agent).filter((agent) => agent.archivedAt === null);
        const seatOfProject = (seat: string): SurfaceAgentSnapshot | undefined =>
          rawAgents.find((agent) => agent.labels.seat === seat && (project === null || agent.labels.project === project.slug));
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
        if (project === null) return agent.labels.seat !== undefined || bound.has(agent.id);
        if (agent.labels.seat !== undefined) return agent.labels.project === project.slug;
        const task = bound.get(agent.id);
        return task !== undefined && taskInProject(task, project.root);
      };
      const relevant = rawAgents.filter(inScope).slice(0, SEQ_END_CAP);
      const agents: AgentView[] = [];
      for (const agent of relevant) {
        agents.push(await agentViewOf(daemon, agent, bound.get(agent.id) ?? null));
      }
      const supervisor = supervisorRaw === undefined ? null : (agents.find((agent) => agent.id === supervisorRaw!.id) ?? null);
      const lead = leadRaw === undefined ? null : (agents.find((agent) => agent.id === leadRaw!.id) ?? null);

      const events =
        project === null
          ? allEvents
          : allEvents.filter((evt) => !("task" in evt) || (typeof evt.task === "string" && taskInProject(evt.task, project.root)));
      const projects = discoverProjects(
        deps.stateDir,
        rawAgents.filter((agent) => agent.labels.seat !== undefined),
        deps.home,
      ).filter((entry): entry is { slug: string; root: string } => entry.root !== null);

      const view = foldView({
        stateDir: deps.stateDir,
        generatedAt: new Date().toISOString(),
        lanes: lanes.lanes,
        events,
        daemon: { agents, supervisor, lead, providers, daemonError },
        // v0.0.17 (ADR 0012 §2): the daemon plugin list joined against the
        // companion catalog — null when the list call was unavailable (the
        // degrade law: every entry folds to not_installed, never a refusal).
        companions: { plugins: daemonPlugins },
        // v0.0.21 (ADR 0014 §4): the Private vault status half, gathered per
        // snapshot the way the companion list is — a probe that cannot answer
        // degrades inside the view's own `error` field, never a refusal.
        vault: await vaultStatusOf(),
        project,
        projects,
      });
      return { ok: true as const, view };
    },

    async taskDetail(input: { task: string }, _context?: SurfaceCallContext) {
      const contract = deps.factory.contractFor(input.task);
      if (contract === undefined) {
        return failure("unknown-task", `no contract set for task ${input.task}`);
      }
      if (!loadLanes(deps.stateDir).ok) return failure("lanes-unreadable", `the lane table under ${deps.stateDir} is unreadable`);
      const task = foldTasks(deps.factory.ledger.events).find((entry) => entry.task === input.task);
      if (task === undefined) return failure("unknown-task", `no foldable history for task ${input.task}`);
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
        const event = await deps.factory.accept({ task: input.task, attempt: input.attempt, accepted_by: "owner" });
        await archiveAcceptedTaskWorkspace(deps.factory, resolveDaemon(context), input.task);
        return {
          ok: true as const,
          seq: event.seq,
          summary: acceptanceSummary({ task: input.task, attempt: input.attempt, by: "owner", landing: event.landing, landingNote: event.landingNote }),
        };
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
    },

    async retro(_input: {}, _context?: SurfaceCallContext) {
      try {
        const outcome = await deps.factory.retro();
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
      if (input.projectRoot !== undefined) {
        const project = projectOrRefusal(input.projectRoot);
        if (!project.ok) return project;
        projectSlug = project.slug;
      }
      const saved = saveLanes(deps.stateDir, { [input.lane]: input.value }, projectSlug);
      if (!saved.ok) return failure("invalid-lane", saved.reason);
      // The live seat sync (v0.0.14): a supervisor or lead save pushes the
      // model to that seat's live agent — project-scoped when the save was,
      // else the first live seat of the lane. The message names what happened.
      let modelSync = "skipped — not a seat lane (applies to the next create)";
      if (input.lane === "supervisor" || input.lane === "lead") {
        const seat = input.lane;
        const daemon = resolveDaemon(context);
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
            if (reply.ok && parsed?.thinking !== undefined) {
              const thinkingReply = await syncThinking(agent.id, parsed.thinking, deps.home);
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
      log(`lanes: ${input.lane}=${saved.lanes[input.lane]}${projectSlug === undefined ? "" : ` (project ${projectSlug})`} (${modelSync})`);
      return { ok: true as const, lanes: saved.lanes, modelSync };
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
          const page = await daemon.agents.list({ filter: { labels: { seat: "supervisor" }, includeArchived: false } });
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
      input: { target: CompanionCatalogEntry["id"] | "all"; source?: string; ref?: string },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; installed: string[]; summary: string } | { ok: false; code: string; error: string }> {
      // A custom source or ref names ONE companion — it cannot ride a batch.
      if (input.target === "all" && (input.source !== undefined || input.ref !== undefined)) {
        return failure("invalid-target", 'a custom source or ref targets one companion — pass a named target, not "all"');
      }
      let targets: readonly CompanionCatalogEntry[];
      if (input.target === "all") {
        // Batch installs only the currently uninstalled companions — the list
        // decides, and an unavailable list refuses rather than reinstall blind.
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
        targets = COMPANION_CATALOG.filter((entry) => !listedIds!.has(entry.id));
      } else {
        const entry = COMPANION_CATALOG.find((candidate) => candidate.id === input.target);
        if (entry === undefined) return failure("unknown-companion", `${input.target} is not a Factory companion — the surface manages only the catalog's own family`);
        targets = [entry];
      }
      const installer = deps.installPlugin ?? installDaemonPlugin;
      const installed: string[] = [];
      for (const entry of targets) {
        // The catalog's canonicalSource is the default — no code path probes
        // or prefers `../` sibling directories on the host disk.
        const source = input.source ?? entry.canonicalSource;
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
      input: { pluginId: CompanionCatalogEntry["id"]; action: DaemonPluginAction },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; pluginId: string; action: string; summary: string } | { ok: false; code: string; error: string }> {
      if (!COMPANION_CATALOG.some((entry) => entry.id === input.pluginId)) {
        return failure("unknown-companion", `${input.pluginId} is not a Factory companion — the surface manages only the catalog's own family`);
      }
      const manager = deps.managePlugin ?? manageDaemonPlugin;
      const reply = await manager(deps.home, input.pluginId, input.action);
      if (!reply.ok) return failure("daemon_failed", reply.reason);
      const summary = pluginsManageSummary(input.pluginId, input.action);
      log(`plugins: ${summary}`);
      return { ok: true as const, pluginId: input.pluginId, action: input.action, summary };
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
      input: { repo?: string; ref?: string },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; vault: VaultStatusView; hydratedFiles: string[]; summary: string } | { ok: false; code: string; error: string }> {
      try {
        const result = await hydrateVaultDirect(deps.home, {
          ...(input.repo === undefined ? {} : { repo: input.repo }),
          ...(input.ref === undefined ? {} : { ref: input.ref }),
          ...vaultRunnerOptions(),
        });
        const vault = await vaultStatusOf();
        const summary = `Direct hydrate unpacked ${result.hydratedFiles.length} file(s) from ${vault.repo ?? input.repo ?? "vault"}.`;
        log(`vault: direct hydrate wrote ${result.hydratedFiles.length} files from the gh api tarball stream (no clone left behind)`);
        return { ok: true as const, vault, hydratedFiles: result.hydratedFiles, summary };
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
    },

    async vaultPull(
      input: { mergeLedgers?: boolean },
      _context?: SurfaceCallContext,
    ): Promise<{ ok: true; vault: VaultStatusView; hydratedFiles: string[]; summary: string } | { ok: false; code: string; error: string }> {
      try {
        const result = await pullVault(deps.home, {
          ...(input.mergeLedgers === undefined ? {} : { mergeLedgers: input.mergeLedgers }),
          ...vaultRunnerOptions(),
        });
        const vault = await vaultStatusOf();
        const summary = `Pulled and hydrated ${result.hydratedFiles.length} file(s) from ${vault.repo ?? "vault"}${input.mergeLedgers === true ? " (ledgers reconciled)" : ""}.`;
        log(`vault: sync pull hydrated ${result.hydratedFiles.length} files from the cached checkout${input.mergeLedgers === true ? " and reconciled node ledgers" : ""}`);
        return { ok: true as const, vault, hydratedFiles: result.hydratedFiles, summary };
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
      | { ok: true; vault: VaultStatusView; createdRepo: boolean; hydratedFiles: string[]; pushedFiles: string[]; pushed: boolean; summary: string }
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
      | { ok: true; vault: VaultStatusView; importedFiles: string[]; pushed: boolean; summary: string }
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
          importedFiles: result.importedFiles,
          pushed: result.synced?.pushed ?? false,
          summary: result.summary,
        };
      } catch (err) {
        return failure(codeOf(err), messageOf(err));
      }
    },
  };
}

// ---- the server wiring --------------------------------------------------------------------

/** The handlers' shared type — the shell builds them once and hands them to both the RPC registrations and the spool. */
export type SurfaceHandlers = ReturnType<typeof createSurfaceHandlers>;

/**
 * Registers every `factory.*` handler on the plugin server. Each daemon
 * call prefers the PaseoApi the daemon hands the handler (`context.paseo`);
 * the constructor's `daemon` is the fallback (and the tests' fake).
 */
export function registerSurfaceRpc(server: PluginServerContext, handlers: SurfaceHandlers): void {
  server.handle(snapshot, (input, context) => handlers.snapshot(input, { paseo: context.paseo }));
  server.handle(taskDetail, (input, context) => handlers.taskDetail(input, { paseo: context.paseo }));
  server.handle(accept, (input, context) => handlers.accept(input, { paseo: context.paseo }));
  server.handle(retro, (input, context) => handlers.retro(input, { paseo: context.paseo }));
  server.handle(lanesSet, (input, context) => handlers.lanesSet(input, { paseo: context.paseo }));
  server.handle(supervisorEnsure, (input, context) => handlers.supervisorEnsure(input, { paseo: context.paseo }));
  server.handle(supervisorRevoke, (input, context) => handlers.supervisorRevoke(input, { paseo: context.paseo }));
  server.handle(leadEnsure, (input, context) => handlers.leadEnsure(input, { paseo: context.paseo }));
  server.handle(leadRotate, (input, context) => handlers.leadRotate(input, { paseo: context.paseo }));
  server.handle(leadDispatch, (input, context) => handlers.leadDispatch(input, { paseo: context.paseo }));
  server.handle(ratifyProposal, (input, context) => handlers.ratifyProposal(input, { paseo: context.paseo }));
  server.handle(pluginsInstall, (input, context) => handlers.pluginsInstall(input, { paseo: context.paseo }));
  server.handle(pluginsManage, (input, context) => handlers.pluginsManage(input, { paseo: context.paseo }));
  server.handle(vaultConfigure, (input, context) => handlers.vaultConfigure(input, { paseo: context.paseo }));
  server.handle(vaultHydrate, (input, context) => handlers.vaultHydrate(input, { paseo: context.paseo }));
  server.handle(vaultPull, (input, context) => handlers.vaultPull(input, { paseo: context.paseo }));
  server.handle(vaultPush, (input, context) => handlers.vaultPush(input, { paseo: context.paseo }));
  server.handle(vaultSync, (input, context) => handlers.vaultSync(input, { paseo: context.paseo }));
  server.handle(vaultImport, (input, context) => handlers.vaultImport(input, { paseo: context.paseo }));
}
