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
import { FactoryError } from "./core/errors.ts";
import type { Factory } from "./core/factory.ts";
import { loadLanes, parseLane, saveLanes } from "./core/lanes.ts";
import { resolveProject } from "./core/project.ts";
import type { ProjectResolution } from "./core/project.ts";
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
import {
  accept,
  lanesSet,
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
} from "../shared/rpc.ts";
import type { AgentView, LaneName, Lanes, ProjectView } from "../shared/view.ts";

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
    }): Promise<{ id: string }>;
    ref(id: string): {
      send(text: string): Promise<void>;
      archive(): Promise<{ archivedAt: string }>;
      timeline: { refetch(options?: { direction?: "tail"; limit?: number }): Promise<{ entries?: { seqEnd?: number }[]; error?: string | null }> };
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
      try {
        const handle = await daemon.agents.create({
          config,
          cwd: project.root,
          title,
          labels: { seat, project: project.slug },
          prompt: renderSeatBootstrap({
            seat,
            home: deps.home,
            stateDir: deps.stateDir,
            ...(deps.pluginDir === undefined ? {} : { pluginDir: deps.pluginDir }),
            nodePath: process.execPath,
            path: process.env.PATH ?? "",
            lane,
            project,
          }),
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

    async accept(input: { task: string; attempt: number }, _context?: SurfaceCallContext) {
      try {
        // Awaited since v0.0.14: a worktree task's local landing runs before
        // the line records, and the summary carries the outcome.
        const event = await deps.factory.accept({ task: input.task, attempt: input.attempt, accepted_by: "owner" });
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
  server.handle(ratifyProposal, (input, context) => handlers.ratifyProposal(input, { paseo: context.paseo }));
  server.handle(pluginsInstall, (input, context) => handlers.pluginsInstall(input, { paseo: context.paseo }));
  server.handle(pluginsManage, (input, context) => handlers.pluginsManage(input, { paseo: context.paseo }));
}
