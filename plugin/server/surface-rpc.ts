/**
 * The Factory surface's in-process single-writer handlers (v0.0.13, ADR
 * 0009 §2/§4, the amendment to ADR 0004): every `factory.*` RPC runs inside
 * the plugin server process that owns the one Factory instance, so Owner
 * acts from the UI — Accept, Retro, Lane config, the Supervisor bridge —
 * invoke `factory.accept({...,accepted_by:"owner"})`, `factory.retro()` and
 * `saveLanes` directly, never through the spool. The daemon half rides the
 * PaseoApi each `handle` call receives (`context.paseo`), reduced to the
 * structural slice below — SDK types stay out by the timeline.ts precedent.
 *
 * The two daemon acts the in-process API lacks (a live agent's model sync,
 * cancelling a running agent) ride the CLI bridge in daemon-cli.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FactoryError } from "./core/errors.ts";
import type { Factory } from "./core/factory.ts";
import { loadLanes, saveLanes } from "./core/lanes.ts";
import { foldTasks, foldView, readTailed } from "./view.ts";
import { setAgentModelViaCli, stopAgentViaCli } from "./daemon-cli.ts";
import type { DaemonReply } from "./daemon-cli.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { accept, lanesSet, retro, snapshot, supervisorEnsure, supervisorRevoke, taskDetail } from "../shared/rpc.ts";
import type { AgentView, LaneName, Lanes } from "../shared/view.ts";

// ---- the daemon slice ---------------------------------------------------------------------

/** The agent snapshot fields the surface reads — plain data, no SDK types. */
export interface SurfaceAgentSnapshot {
  id: string;
  provider: string;
  title: string | null;
  status: string;
  model: string | null;
  labels: Record<string, string>;
  archivedAt: string | null;
  requiresAttention: boolean;
  attentionReason: string | null;
  updatedAt: string;
  cwd: string;
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
      config: { provider: string };
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
    listModels(provider: string): Promise<{ models: { id: string; label?: string | null }[] }>;
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
  /** The paseo home — `<home>-supervisor` (its sibling) is the Supervisor seat's dir. */
  home: string;
  /** The resolved plugin directory, when installed from a directory — gives AGENTS.md an exact factory.mjs path. */
  pluginDir?: string;
  /** The daemon to call when the RPC call carries no `context.paseo` (tests). */
  daemon: SurfaceDaemonApi | (() => SurfaceDaemonApi);
  /** Live agent model sync override (tests) — the CLI bridge by default. */
  setAgentModel?: (agentId: string, model: string, home?: string) => Promise<DaemonReply>;
  /** Agent cancel override (tests) — the CLI bridge by default. */
  stopAgent?: (agentId: string, home?: string) => Promise<DaemonReply>;
  onLog?: (message: string) => void;
}

/** How many agents one snapshot resolves a Timeline Oracle seqEnd for (supervisor + bound workers). */
const SEQ_END_CAP = 12;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): string {
  return err instanceof FactoryError ? err.code : "failed";
}

/** The AGENTS.md the Supervisor seat boots with — resolved paths, its law, its lanes. */
function renderSupervisorAgentsMd(input: { home: string; stateDir: string; pluginDir?: string; nodePath: string; path: string; lane: string }): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const runner = /Paseo Helper/i.test(input.nodePath) ? `ELECTRON_RUN_AS_NODE=1 ${quote(input.nodePath)}` : quote(input.nodePath);
  const factoryCmd = input.pluginDir !== undefined ? `${runner} ${quote(join(input.pluginDir, "bin", "factory.mjs"))}` : "factory";
  return [
    "# Supervisor (paseo-factory)",
    "",
    "You are the delegated Owner seat of the paseo-factory verification loop: the one agent the Owner",
    "converses with. You relay what the factory measured — Verdicts, Watch lines, needs-human stalls —",
    "in words, and the Owner's answers ride you back down. You never grade work yourself: the Gate, the",
    "Choke, the Watch and the Ledger are the law, and `factory` (the Owner CLI) performs the Owner's acts.",
    "",
    "- Paseo home (the daemon this seat serves): " + input.home,
    "- Factory state (ledger, reports, lanes.json): " + input.stateDir,
    "- node: " + input.nodePath,
    "- Your model lane (lanes.json → supervisor): " + input.lane,
    "",
    "Day-one Supervisor commands (the Owner CLI, never on a Worker agent's PATH — it is yours):",
    "",
    "  " + factoryCmd + " --home " + input.home + " contract --task <id> --workspace <dir> --gate <cmd> --artifact <path> [--scope <p1,p2>] [--watch] [--fresh-eyes] [--description <text>]",
    "  " + factoryCmd + " --home " + input.home + " run <task> [<task>...]",
    "  " + factoryCmd + " --home " + input.home + " status",
    "  " + factoryCmd + " --home " + input.home + " lanes get",
    "  " + factoryCmd + " --home " + input.home + " accept <task> --attempt <n>",
    "",
    'Your shells may start without node/git on PATH — export PATH="' + input.path + '" first.',
    "",
  ].join("\n");
}

export function createSurfaceHandlers(deps: SurfaceDeps) {
  const resolveDaemon = (context?: SurfaceCallContext): SurfaceDaemonApi => {
    const fromCall = context?.paseo;
    if (fromCall !== undefined) return fromCall as SurfaceDaemonApi;
    return typeof deps.daemon === "function" ? deps.daemon() : deps.daemon;
  };
  const log = deps.onLog ?? (() => {});
  const failure = <C extends string>(code: C, error: string) => ({ ok: false as const, code, error });

  /** The live non-archived seat=supervisor agent, when one exists. */
  const supervisorOf = async (daemon: SurfaceDaemonApi): Promise<SurfaceAgentSnapshot | undefined> => {
    const page = await daemon.agents.list({ filter: { labels: { seat: "supervisor" }, includeArchived: false } });
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
      seat: agent.labels.seat ?? null,
      task,
      seqEnd,
      requiresAttention: agent.requiresAttention,
      cwd: agent.cwd,
    };
  };

  type ProviderEntry = { provider: string; available: boolean; models: { id: string; label: string | null }[] | null };
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
              models: listed.models.map((m) => ({ id: m.id, label: m.label ?? null })),
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

  return {
    async snapshot(_input: {}, context?: SurfaceCallContext) {
      const lanes = loadLanes(deps.stateDir);
      if (!lanes.ok) return failure("lanes-unreadable", lanes.reason);
      const daemon = resolveDaemon(context);
      const events = deps.factory.ledger.events;
      const bound = agentTaskIndex();

      let rawAgents: SurfaceAgentSnapshot[] = [];
      let providers: ProviderEntry[] = [];
      let daemonError: string | null = null;
      let supervisorRaw: SurfaceAgentSnapshot | undefined;
      try {
        const page = await daemon.agents.list({ filter: { includeArchived: false } });
        rawAgents = page.entries.map((entry) => entry.agent).filter((agent) => agent.archivedAt === null);
        supervisorRaw = rawAgents.find((agent) => agent.labels.seat === "supervisor");
        providers = await resolveProviders(daemon);
      } catch (err) {
        daemonError = `daemon unavailable: ${messageOf(err)}`;
      }

      // Every supervisor and every ledger-bound working agent gets a seqEnd;
      // strangers stay strangers (the surface shows seats, not a census).
      const relevant = rawAgents.filter((agent) => agent.labels.seat !== undefined || bound.has(agent.id)).slice(0, SEQ_END_CAP);
      const agents: AgentView[] = [];
      for (const agent of relevant) {
        agents.push(await agentViewOf(daemon, agent, bound.get(agent.id) ?? null));
      }
      const supervisor = supervisorRaw === undefined ? null : (agents.find((agent) => agent.id === supervisorRaw!.id) ?? null);

      const view = foldView({
        stateDir: deps.stateDir,
        generatedAt: new Date().toISOString(),
        lanes: lanes.lanes,
        events,
        daemon: { agents, supervisor, providers, daemonError },
      });
      return { ok: true as const, view };
    },

    async taskDetail(input: { task: string }, _context?: SurfaceCallContext) {
      const contract = deps.factory.contractFor(input.task);
      if (contract === undefined) {
        return failure("unknown-task", `no contract set for task ${input.task}`);
      }
      const lanes = loadLanes(deps.stateDir);
      if (!lanes.ok) return failure("lanes-unreadable", lanes.reason);
      const task = foldTasks(deps.factory.ledger.events).find((entry) => entry.task === input.task);
      if (task === undefined) return failure("unknown-task", `no foldable history for task ${input.task}`);
      return {
        ok: true as const,
        detail: {
          version: 1 as const,
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
        const event = deps.factory.accept({ task: input.task, attempt: input.attempt, accepted_by: "owner" });
        return { ok: true as const, seq: event.seq, summary: `${input.task} accepted at attempt ${input.attempt} by owner` };
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

    async lanesSet(input: { lane: LaneName; value: string }, context?: SurfaceCallContext) {
      const saved = saveLanes(deps.stateDir, { [input.lane]: input.value });
      if (!saved.ok) return failure("invalid-lane", saved.reason);
      let modelSync = "skipped — no live supervisor agent on this daemon";
      if (input.lane === "supervisor") {
        const daemon = resolveDaemon(context);
        try {
          const supervisor = await supervisorOf(daemon);
          if (supervisor !== undefined) {
            const sync = deps.setAgentModel ?? setAgentModelViaCli;
            const slash = saved.lanes.supervisor.indexOf("/");
            const modelId = slash === -1 ? saved.lanes.supervisor : saved.lanes.supervisor.slice(slash + 1);
            const reply = await sync(supervisor.id, modelId, deps.home);
            modelSync = reply.ok
              ? `applied — agent ${supervisor.id.slice(0, 8)} now runs ${saved.lanes.supervisor}`
              : `failed — ${reply.reason} (lanes.json is the config of record; the next ensure/create runs it)`;
          }
        } catch (err) {
          modelSync = `failed — ${messageOf(err)} (lanes.json is the config of record)`;
        }
      }
      log(`lanes: ${input.lane}=${saved.lanes[input.lane]} (${modelSync})`);
      return { ok: true as const, lanes: saved.lanes, modelSync };
    },

    async supervisorEnsure(input: { message?: string }, context?: SurfaceCallContext) {
      const daemon = resolveDaemon(context);
      const lanes = loadLanes(deps.stateDir);
      if (!lanes.ok) return failure("lanes-unreadable", lanes.reason);
      let supervisor: SurfaceAgentSnapshot | undefined;
      try {
        supervisor = await supervisorOf(daemon);
      } catch (err) {
        return failure("daemon-unavailable", `cannot read the daemon's agents: ${messageOf(err)}`);
      }
      let created = false;
      let supervisorDir: string | null = null;
      if (supervisor === undefined) {
        // The bridge's create half: `<home>-supervisor/AGENTS.md` with the
        // resolved paths, then the agent under the configured supervisor
        // lane, seat-labeled so every later ensure finds it.
        supervisorDir = join(dirname(deps.home), `${basename(deps.home)}-supervisor`);
        try {
          mkdirSync(supervisorDir, { recursive: true });
          writeFileSync(
            join(supervisorDir, "AGENTS.md"),
            renderSupervisorAgentsMd({
              home: deps.home,
              stateDir: deps.stateDir,
              pluginDir: deps.pluginDir,
              nodePath: process.execPath,
              path: process.env.PATH ?? "",
              lane: lanes.lanes.supervisor,
            }),
          );
          const handle = await daemon.agents.create({
            config: { provider: lanes.lanes.supervisor },
            cwd: supervisorDir,
            title: "Supervisor (paseo-factory)",
            labels: { seat: "supervisor" },
          });
          supervisor = {
            id: handle.id,
            provider: lanes.lanes.supervisor,
            title: "Supervisor (paseo-factory)",
            status: "initializing",
            model: null,
            labels: { seat: "supervisor" },
            archivedAt: null,
            requiresAttention: false,
            attentionReason: null,
            updatedAt: new Date().toISOString(),
            cwd: supervisorDir,
          };
          created = true;
          log(`supervisor: created agent ${handle.id} under ${lanes.lanes.supervisor} at ${supervisorDir}`);
        } catch (err) {
          return failure("create-failed", `creating the Supervisor agent failed: ${messageOf(err)}`);
        }
      }
      const message = input.message?.trim();
      if (message !== undefined && message !== "") {
        try {
          await daemon.agents.ref(supervisor.id).send(message);
          log(`supervisor: dispatched a message to ${supervisor.id}`);
        } catch (err) {
          return failure("send-failed", `the supervisor exists (${supervisor.id}) but the dispatch failed: ${messageOf(err)}`);
        }
      }
      return { ok: true as const, agentId: supervisor.id, created, supervisorDir };
    },

    async supervisorRevoke(_input: {}, context?: SurfaceCallContext) {
      const daemon = resolveDaemon(context);
      let supervisor: SurfaceAgentSnapshot | undefined;
      try {
        supervisor = await supervisorOf(daemon);
      } catch (err) {
        return failure("daemon-unavailable", `cannot read the daemon's agents: ${messageOf(err)}`);
      }
      if (supervisor === undefined) {
        return failure("no-supervisor", "no live seat=supervisor agent on this daemon — nothing to revoke");
      }
      // Cancel first (best-effort: an idle agent has nothing to cancel), then
      // archive — the retirement the seat graph reads.
      const stop = deps.stopAgent ?? stopAgentViaCli;
      const stopped = await stop(supervisor.id, deps.home);
      if (!stopped.ok) log(`supervisor: cancel before revoke did not land — ${stopped.reason}`);
      try {
        await daemon.agents.ref(supervisor.id).archive();
      } catch (err) {
        return failure("archive-failed", `archiving supervisor ${supervisor.id} failed: ${messageOf(err)}`);
      }
      log(`supervisor: revoked ${supervisor.id} (cancelled + archived)`);
      return { ok: true as const, agentId: supervisor.id };
    },
  };
}

// ---- the server wiring --------------------------------------------------------------------

/**
 * Registers every `factory.*` handler on the plugin server. Each daemon
 * call prefers the PaseoApi the daemon hands the handler (`context.paseo`);
 * the constructor's `daemon` is the fallback (and the tests' fake).
 */
export function registerSurfaceRpc(server: PluginServerContext, deps: SurfaceDeps): void {
  const handlers = createSurfaceHandlers(deps);
  server.handle(snapshot, (input, context) => handlers.snapshot(input, { paseo: context.paseo }));
  server.handle(taskDetail, (input, context) => handlers.taskDetail(input, { paseo: context.paseo }));
  server.handle(accept, (input, context) => handlers.accept(input, { paseo: context.paseo }));
  server.handle(retro, (input, context) => handlers.retro(input, { paseo: context.paseo }));
  server.handle(lanesSet, (input, context) => handlers.lanesSet(input, { paseo: context.paseo }));
  server.handle(supervisorEnsure, (input, context) => handlers.supervisorEnsure(input, { paseo: context.paseo }));
  server.handle(supervisorRevoke, (input, context) => handlers.supervisorRevoke(input, { paseo: context.paseo }));
}
