/**
 * paseo-factory plugin server entry — the shell around the pure core.
 *
 * The plugin process owns the whole loop (ADR 0004): it opens the ledger once
 * at boot (recovering interrupted attempts per ADR 0003), keeps the factory
 * instance for its lifetime as the single Ledger writer and Gate runner, and
 * serves the spool that the CLIs submit through. It also puts the Claim CLI
 * and the git shim on every agent's PATH, and — since v0.0.4 — runs the
 * choke: every permit ask from a contracted agent is judged, answered via
 * `respondToPermission()`, and recorded (`plugin/server/choke.ts`). The Owner
 * reaches the same loop through `plugin/bin/factory.mjs` (`contract`,
 * `accept`), which is never on an agent PATH.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createFactory } from "./server/core/factory.ts";
import { PLUGIN_ID, pluginDirFor, resolvePaseoHome, stateDirFor } from "./server/paths.ts";
import { ensureFactorySkillSafe } from "./server/core/skill.ts";
import { effectiveLanesForReconcile, reconcilePaseoRoleProviders } from "./server/core/role-providers.ts";
import { reloadDaemonConfigViaWs } from "./server/daemon-cli.ts";
import { claimCliBinDir, ensureClaimCli, ensureGitShim, injectClaimCliPath } from "./server/shell.ts";
import { createChoke, normalizeAgentCreateRequest, startGitBlockIngestion } from "./server/choke.ts";
import { createTimelineFetcher } from "./server/timeline.ts";
import type { TimelineSourceApi } from "./server/timeline.ts";
import { spoolRootFor, startSpool } from "./server/spool.ts";
import { createSurfaceHandlers, registerSurfaceRpc } from "./server/surface-rpc.ts";
import { createLeadMailRuntime } from "./server/lead-mailbox.ts";
import { injectRoleOnCreate, injectSessionEnv, sanitizeAgentCreateHookResult } from "./server/roles.ts";

const SHELL_VERSION = "0.0.26";

const log = (message: string) => console.log(`[${PLUGIN_ID}] ${message}`);

export default function contribute(server: PluginServerContext) {
  const home = resolvePaseoHome(process.env, homedir());
  const stateDir = stateDirFor(home);
  const pluginDir = pluginDirFor(home);

  // The watch's feed (v0.0.6): every hook receives the process's one
  // long-lived PaseoApi (ticket 02 §a) — capture it from whichever fires
  // first (create, session open, a permit ask, a surface RPC since v0.0.27)
  // and the factory's watch pass can read the claiming agent's timeline at
  // verdict. One variable, written idempotently; undefined until the first
  // hook fires.
  let paseoApi: TimelineSourceApi | undefined;
  const capturePaseo = (context: { paseo?: unknown }): void => {
    if (paseoApi === undefined && context.paseo !== undefined) {
      paseoApi = context.paseo as unknown as TimelineSourceApi;
      log("watch: captured the daemon API — timeline feeds are live");
    }
  };
  const fetchTimeline = createTimelineFetcher(() => paseoApi);

  // Opening validates any existing ledger (fail closed — a corrupt ledger
  // fails the plugin loudly) and closes attempts interrupted by a previous
  // lifetime: red, reported, and logged, never silently dropped (ADR 0003).
  const factory = createFactory({ stateDir, fetchTimeline });
  for (const { task, attempt } of factory.recoveredAttempts) {
    log(`recovered on open: attempt ${attempt} of task ${task} closed red — interrupted by a restart`);
  }

  if (pluginDir === undefined) {
    log(`up v${SHELL_VERSION} — WARNING: plugin directory not recorded in ${home}/config.json; ` +
      `factory-claim and the git shim cannot be put on agent PATHs until the plugin is installed from a directory`);
  } else {
    ensureClaimCli(stateDir, pluginDir, process.execPath);
    ensureGitShim(stateDir, pluginDir, process.execPath);
    log(`up v${SHELL_VERSION} — state ${stateDir}, plugin ${pluginDir}, claim CLI + git shim ${claimCliBinDir(stateDir)}`);
  }

  // The global `/factory` skill (v0.0.20, ADR 0013 §3; v0.0.23, ADR 0015 §5):
  // reconcile both `~/.agents/skills/factory/SKILL.md` (pi / opencode) and
  // `~/.claude/skills/factory/SKILL.md` (claude) at boot so the Owner can type
  // `/factory <directive>` in any session and bootstrap or dispatch into the
  // Project's SLP loop via `factory supervisor dispatch`. The skill carries
  // this install's exact factory CLI invocation (the seats' `factoryCmd`
  // precedent) but never a `--home` — the file is global across daemons, so
  // the body names the default-home law and the override instead. The SAFE
  // door: unlike the stateDir writes above, `~/.agents` and `~/.claude` are
  // operator-global and not preconditions the plugin depends on, so an
  // unwritable skills root warns and the boot continues (choke, spool,
  // mailbox runtime) — a skill never kills a boot.
  const quoted = (value: string) => (/\s/.test(value) ? `"${value}"` : value);
  const runner = /Paseo Helper/i.test(process.execPath) ? `ELECTRON_RUN_AS_NODE=1 ${quoted(process.execPath)}` : quoted(process.execPath);
  const factoryCmd = pluginDir === undefined ? "factory" : `${runner} ${quoted(join(pluginDir, "bin", "factory.mjs"))}`;
  for (const skillsRoot of [join(homedir(), ".agents", "skills"), join(homedir(), ".claude", "skills")]) {
    const skillPath = ensureFactorySkillSafe(skillsRoot, { factoryCmd }, log);
    if (skillPath !== null) log(`skill: /factory reconciled at ${skillPath}`);
  }

  // The native role providers (v0.0.27, ADR 0017 §1): reconcile
  // `factory-supervisor`, `factory-lead`, and `factory-peer` plus the single
  // `Supervisor (Factory)` picker profile into `<home>/config.json at boot —
  // sweeping the orphaned `sw2-*` leftovers — so Paseo's native New Chat
  // picker starts a fenced Supervisor with zero custom bootstrap buttons. The
  // lane table is the machine `lanes.json`, or — when the machine never named
  // its lanes — the cleanest effective table across the registered projects'
  // overrides. A broken config.json or lanes.json is a named warning, never
  // a failed boot (the daemon reload is non-blocking by construction).
  const bootLanes = effectiveLanesForReconcile(stateDir);
  if (bootLanes.ok) {
    const reconciled = reconcilePaseoRoleProviders(home, bootLanes.lanes, { reloadDaemon: reloadDaemonConfigViaWs });
    if (reconciled.ok) {
      log(reconciled.changed ? "role providers: <home>/config.json reconciled — daemon reload requested" : "role providers: <home>/config.json already reconciled");
    } else {
      log(`role providers: <home>/config.json not reconciled — ${reconciled.reason}`);
    }
  } else {
    log(`role providers: lanes unreadable — ${bootLanes.reason}`);
  }

  // The choke (v0.0.4): judge every permit ask from a contracted agent,
  // answer it, and leave one ledger line per judged ask. The permission mode
  // is pinned at create so asks always surface (a blinded choke is the shim
  // alone).
  const choke = createChoke({ factory, homeDir: homedir(), onLog: log });
  const offPermissionAsked = server.on("agent.permission_requested", (event, context) => {
    capturePaseo(context);
    void choke.onPermissionAsked(event, context.paseo);
  });
  const offAgentCreate = server.before("agent.create", ({ request }, context) => {
    capturePaseo(context);
    let next = request;
    const normalized = normalizeAgentCreateRequest(next, { stateDir, providers: surface.cachedProviders() });
    if (normalized !== next) {
      log(`choke: normalized agent.create in ${next.config.cwd} (provider=${normalized.config.provider})`);
      next = normalized;
    }
    const nextLabels =
      (next as { labels?: Record<string, string> }).labels ??
      (next.config as { labels?: Record<string, string> }).labels;
    const pinned = choke.pinCreateMode(next.config, nextLabels);
    if (pinned !== undefined) {
      log(`choke: pinned permission mode to Always Ask for the new agent in ${next.config.cwd}`);
      next = { ...next, config: pinned };
    }
    // The additive role injection (v0.0.14, ADR 0010 §1–§2/§6): seat-titled
    // creates and managed-worktree creates carry their role contract in
    // config.systemPrompt (mapped per provider by the daemon) plus their
    // PASEO_FACTORY_* env — nothing under any project root is written.
    const injected = injectRoleOnCreate(next, stateDir);
    if (injected !== undefined) {
      log(`roles: injected the ${injected.env?.PASEO_FACTORY_SEAT ?? "agent"} contract into the agent created in ${next.config.cwd}`);
    }
    const candidate = injected === undefined ? (next === request ? undefined : next) : injected;
    return candidate === undefined ? undefined : sanitizeAgentCreateHookResult(candidate);
  });

  // The Factory surface's RPC handlers (v0.0.13, ADR 0009 §4): every
  // `factory.*` call runs in-process against this same single Factory
  // instance — the UI's Owner acts never round-trip through the spool. Each
  // handler prefers the PaseoApi the daemon hands it; the captured one is
  // the fallback for calls whose context carries none. The spool's
  // lead_rotate kind (v0.0.14) reuses the same handlers — one daemon actor.
  const surfaceDeps = {
    factory,
    stateDir,
    home,
    ...(pluginDir === undefined ? {} : { pluginDir }),
    daemon: () => paseoApi as never,
    onLog: log,
  };
  // The Lead-mailbox doors the surface defers to (the runtime is created
  // right below — its own seat doors are the surface's leadEnsure and
  // leadRotate, so the two objects are mutually late-bound; these arrows
  // only ever fire once RPCs are registered, after both exist):
  // `onLeadRetired` settles a rotated Lead's mailbox (`mail_requeued`,
  // reason "lead-rotated" — ADR 0013 §4's last arm), `leadDispatch` is the
  // UI quick-dispatch door onto the same enqueueLeadMail + pumpProjectLead
  // pipeline the spool's lead_dispatch rides.
  const surface = createSurfaceHandlers({
    ...surfaceDeps,
    onLeadRetired: (input) => leadMail.settleLeadRotation(input.slug),
    resetProjectMailbox: (slug) => leadMail.resetProjectMailbox(slug),
    leadDispatch: (request) => leadMail.dispatchLead(request),
  });
  // The Lead mailbox runtime (v0.0.20, ADR 0013 §4–§5): the single writer
  // around each Project's mailbox.jsonl. Its seat doors are the surface's
  // leadEnsure (the spec's ensureProjectSeat("lead")) and leadRotate (the
  // handoff's retire sequence); its daemon is the same captured PaseoApi the
  // handlers fall back to. Startup recovery first — any delivery a crashed
  // lifetime left un-acked returns to queued before new mail moves.
  const leadMail = createLeadMailRuntime({
    factory,
    stateDir,
    daemon: () => paseoApi as never,
    ensureLead: (input) => surface.leadEnsure(input),
    ensureSupervisor: (input) => surface.supervisorEnsure(input),
    retireLead: (input) => surface.leadRotate(input),
    onLog: log,
  });
  leadMail.startupRecovery();
  // The turn boundary (v0.0.20, ADR 0013 §5; v0.0.23, ADR 0015 §3): every
  // `agent.turn_ended` hands the Lead-mailbox runtime the event — it settles
  // the in-flight batch (`mail_acked` on completed, `mail_requeued` otherwise)
  // for both registered Lead and registered Supervisor seats and drives the
  // 128k rotation state machine for the Project whose registered Lead ended
  // the turn.
  const offTurnEnded = server.on("agent.turn_ended", (event, context) => {
    capturePaseo(context);
    void leadMail.onLeadTurnEnded({ agentId: event.agent.id, outcome: event.outcome, timeline: event.timeline });
  });
  const spool = startSpool(stateDir, factory, {
    onLog: log,
    ask: choke.spoolAskHandler,
    leadRotate: async (request) => {
      const reply = await surface.leadRotate({ projectRoot: request.projectRoot }, { paseo: paseoApi as never });
      return reply.ok
        ? { id: request.id, ok: true as const, summary: `lead rotated — agent ${reply.agentId} cancelled + archived`, agentId: reply.agentId }
        : { id: request.id, ok: false as const, code: reply.code, message: reply.error };
    },
    leadDispatch: (request) => leadMail.dispatchLead(request),
    supervisorDispatch: (request) => leadMail.dispatchSupervisor(request),
    supervisorReport: (request) => leadMail.reportSupervisor(request),
    projectReset: async (request) => {
      const reply = await surface.projectReset(
        {
          ...(request.workspace !== undefined ? { projectRoot: request.workspace } : {}),
          ...(request.project !== undefined ? { project: request.project } : {}),
          ...(request.keepSeats !== undefined ? { keepSeats: request.keepSeats } : {}),
        },
        { paseo: paseoApi as never },
      );
      return reply.ok
        ? {
            id: request.id,
            ok: true as const,
            summary: reply.summary,
            project: reply.project,
            purgedEvents: reply.purgedEvents,
            tasks: reply.tasks,
            removedFiles: reply.removedFiles,
            archivedSeats: reply.archivedSeats,
            archivedAgents: reply.archivedAgents,
          }
        : {
            id: request.id,
            ok: false as const,
            code: reply.code,
            message: reply.error,
          };
    },
    peerMail: leadMail.notifyPeer,
    daemon: () => paseoApi as never,
    sanitizeLane: (lane) => surface.sanitizeLane(lane),
    // The accept path's worktree-record sweep targets the real daemon home —
    // never the PASEO_HOME-env fallback (v0.0.27, ADR 0017 §4).
    home,
  });

  log(`spool listening on ${spoolRootFor(stateDir)}/{requests,replies,processed}`);
  // The `factory.*` RPC registrations also capture the daemon's PaseoApi
  // (v0.0.27, ADR 0017 §4): the first surface call — which can arrive before
  // any agent hook fires — hands the same long-lived API the hooks capture,
  // so `paseoApi` exists from the Owner's first UI act alone.
  registerSurfaceRpc(server, surface, (context) => {
    if (context.paseo !== undefined) capturePaseo(context);
  });

  const gitBlocks = startGitBlockIngestion(factory, { onLog: log });

  const offSessionOpen = server.before("agent.session_open", ({ request }, context) => {
    capturePaseo(context);
    let next = request;
    if (pluginDir !== undefined) {
      const withCli = injectClaimCliPath(next, claimCliBinDir(stateDir));
      if (withCli !== next) {
        log(`factory-claim on PATH for agent ${request.agentId} (${request.reason})`);
        next = withCli;
      }
    }
    // The role identity re-applies on every provider launch (v0.0.14): a
    // seat's or worker's shell can always ask which seat it is.
    const withEnv = injectSessionEnv(next, stateDir);
    return withEnv === undefined ? (next === request ? undefined : next) : withEnv;
  });

  return () => {
    offPermissionAsked();
    offAgentCreate();
    offSessionOpen();
    offTurnEnded();
    gitBlocks.stop();
    spool.stop();
    log(`down v${SHELL_VERSION}`);
  };
}
