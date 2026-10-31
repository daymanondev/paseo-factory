import { readExecution } from "./server/core/scrum/selection.ts";
import { listRuns, readRun, terminalRun } from "./server/core/scrum/run-journal.ts";
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
import { pendingUpgradeFor } from "./server/core/upgrade-state.ts";
import { createFactory } from "./server/core/factory.ts";
import { ensureFactoryBinScripts } from "./server/core/agy-home.ts";
import { PLUGIN_ID, pluginDirFor, resolvePaseoHome, stateDirFor } from "./server/paths.ts";
import { ensureFactorySkillSafe } from "./server/core/skill.ts";
import { effectiveLanesForReconcile, healFactoryRoleProvidersInConfig, reconcilePaseoRoleProviders } from "./server/core/role-providers.ts";
import { reloadDaemonConfigViaWs, warmPluginDaemonApiViaWs } from "./server/daemon-cli.ts";
import { claimCliBinDir, ensureClaimCli, ensureGitShim, injectClaimCliPath } from "./server/shell.ts";
import { createChoke, normalizeAgentCreateRequest, startGitBlockIngestion } from "./server/choke.ts";
import { createTimelineFetcher } from "./server/timeline.ts";
import type { TimelineSourceApi } from "./server/timeline.ts";
import { spoolRootFor, startSpool } from "./server/spool.ts";
import { createSurfaceHandlers, registerSurfaceRpc } from "./server/surface-rpc.ts";
import { createLeadMailRuntime } from "./server/lead-mailbox.ts";
import { injectRoleOnCreate, injectSessionEnv, sanitizeAgentCreateHookResult } from "./server/roles.ts";

const SHELL_VERSION = "0.0.72";

const log = (message: string) => console.log(`[${PLUGIN_ID}] ${message}`);

export default function contribute(server: PluginServerContext) {
  const home = resolvePaseoHome(process.env, homedir());
  const stateDir = stateDirFor(home);
  let pluginDir = pluginDirFor(home);

  const reconcileGlobalFactorySkills = (activePluginDir: string | undefined, logReconciled = false): void => {
    const quoted = (value: string) => (/\s/.test(value) ? `"${value}"` : value);
    const runner = /Paseo Helper/i.test(process.execPath) ? `ELECTRON_RUN_AS_NODE=1 ${quoted(process.execPath)}` : quoted(process.execPath);
    const factoryCmd = activePluginDir === undefined ? "factory" : `${runner} ${quoted(join(activePluginDir, "bin", "factory.mjs"))}`;
    for (const skillsRoot of [join(homedir(), ".agents", "skills"), join(homedir(), ".claude", "skills")]) {
      const skillPath = ensureFactorySkillSafe(skillsRoot, { factoryCmd }, log);
      if (logReconciled && skillPath !== null) log(`skill: /factory reconciled at ${skillPath}`);
    }
  };

  const refreshPluginInstallation = (): void => {
    const latest = pluginDirFor(home);
    if (latest !== undefined && latest !== pluginDir) {
      pluginDir = latest;
      ensureClaimCli(stateDir, pluginDir, process.execPath);
      ensureGitShim(stateDir, pluginDir, process.execPath);
      ensureFactoryBinScripts(stateDir, pluginDir);
      reconcileGlobalFactorySkills(pluginDir, false);
      log(`re-synced plugin checkout -> ${pluginDir}`);
    }
  };

  // The watch's feed (v0.0.6): every hook receives the process's one
  // long-lived PaseoApi (ticket 02 §a) — capture it from whichever fires
  // first (create, session open, a permit ask, a surface RPC since v0.0.27)
  // and the factory's watch pass can read the claiming agent's timeline at
  // verdict. One variable, written idempotently; undefined until the first
  // hook fires.
  let paseoApi: TimelineSourceApi | undefined;
  let onPaseoCaptured: (() => void) | undefined;
  const capturePaseo = (context: { paseo?: unknown }): void => {
    if (paseoApi === undefined && context.paseo !== undefined) {
      paseoApi = context.paseo as unknown as TimelineSourceApi;
      log("watch: captured the daemon API — timeline feeds are live");
      onPaseoCaptured?.();
    }
  };
  const fetchTimeline = createTimelineFetcher(() => paseoApi);

  // Opening validates any existing ledger (fail closed — a corrupt ledger
  // fails the plugin loudly) and closes attempts interrupted by a previous
  // lifetime: red, reported, and logged, never silently dropped (ADR 0003).
  const factory = createFactory({ stateDir, fetchTimeline });
  factory.history.start();
  for (const { task, attempt } of factory.recoveredAttempts) {
    log(`recovered on open: attempt ${attempt} of task ${task} closed red — interrupted by a restart`);
  }

  let booted = false;
  const initializeOrdinaryRuntime = (): void => {
    if (booted || pendingUpgradeFor(stateDir) !== undefined) return;
    factory.history.runSync(() => {
      pluginDir = pluginDirFor(home) ?? pluginDir;
      if (pluginDir === undefined) {
        ensureFactoryBinScripts(stateDir);
        log(`up v${SHELL_VERSION} — WARNING: plugin directory not recorded in ${home}/config.json; ` +
          `factory-claim and the git shim cannot be put on agent PATHs until the plugin is installed from a directory`);
      } else {
        ensureClaimCli(stateDir, pluginDir, process.execPath);
        ensureGitShim(stateDir, pluginDir, process.execPath);
        ensureFactoryBinScripts(stateDir, pluginDir);
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
      reconcileGlobalFactorySkills(pluginDir, true);

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
        if (healFactoryRoleProvidersInConfig(home)) {
          log("role providers: healed invalid factory-* extends in <home>/config.json");
          reloadDaemonConfigViaWs(home);
        }
        log(`role providers: lanes unreadable — ${bootLanes.reason}`);
      }
    });
    booted = true;
  };
  initializeOrdinaryRuntime();
  if (!booted) log(`up v${SHELL_VERSION} — incomplete upgrade; recovery/read entrances available, ordinary startup deferred`);

  // The choke (v0.0.4): judge every permit ask from a contracted agent,
  // answer it, and leave one ledger line per judged ask. The permission mode
  // is pinned at create so asks always surface (a blinded choke is the shim
  // alone).
  const choke = createChoke({ factory, homeDir: homedir(), onLog: log });
  const offPermissionAsked = server.on("agent.permission_requested", (event, context) => {
    capturePaseo(context);
    void choke.onPermissionAsked(event, context.paseo).catch((error) => log(`choke: permission recording deferred — ${String(error)}`));
  });
  const offAgentCreate = server.before("agent.create", ({ request }, context) => factory.history.runOperation(() => {
    capturePaseo(context);
    refreshPluginInstallation();
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
    const injected = injectRoleOnCreate(next, stateDir, undefined, surface.cachedProviders());
    if (injected !== undefined) {
      log(`roles: injected the ${injected.env?.PASEO_FACTORY_SEAT ?? "agent"} contract into the agent created in ${next.config.cwd}`);
    }
    const candidate = injected === undefined ? (next === request ? undefined : next) : injected;
    return candidate === undefined ? undefined : sanitizeAgentCreateHookResult(candidate);
  }));

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
    handoffPending: slug => leadMail.hasPendingHandoff(slug),
    onLeadRetired: (input) => leadMail.settleLeadRotation(input.slug),
    onSeatKickoffSent: (input) => leadMail.markKickoffSent(input.agentId),
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
    home,
    daemon: () => paseoApi as never,
    reconcileScrum: async project => {
      if (readExecution(stateDir, project.slug).mode !== "scrum") return;
      for (let run of listRuns(stateDir, project.slug)) {
        if (run.cancellation && !terminalRun(run)) {
          await surface.scrumCommand({ operation: "run.cancel", projectRoot: project.root, runId: run.runId, requestId: run.cancellation.requestId, expectedRevision: run.revision, payload: { reason: run.cancellation.reason } }, undefined, { authority: "owner", actor: run.cancellation.actor });
        } else if (run.completionRequest && !terminalRun(run)) {
          await surface.scrumCommand({ operation: "run.complete", projectRoot: project.root, runId: run.runId, requestId: run.completionRequest.requestId, expectedRevision: run.revision }, undefined, { authority: "lead", actor: run.completionRequest.actor });
        }
        run = readRun(stateDir, project.slug, run.runId);
        if (run.phase === "completed" && run.completionRequest && !run.completionReported) await leadMail.reportSupervisor({ id: `${run.completionRequest.requestId}:report`, kind: "supervisor_report", workspace: project.root, reportType: "completed", scrum: { runId: run.runId }, message: `Scrum run ${run.runId} completed after verification. ${JSON.stringify(run.telemetry)}`, seat: "lead" });
      }
    },
    ensureLead: (input) => surface.leadEnsure(input),
    ensureSupervisor: (input) => surface.supervisorEnsure(input),
    retireLead: (input) => surface.leadRotate(input),
    onLog: log,
  });
  let mailRecovered = false;
  const resumeOrdinaryRuntime = (): void => {
    if (pendingUpgradeFor(stateDir) !== undefined) return;
    initializeOrdinaryRuntime();
    refreshPluginInstallation();
    if (!mailRecovered) {
      leadMail.startupRecovery();
      mailRecovered = true;
    }
    if (paseoApi !== undefined) void leadMail.pumpAll().catch((error) => log(`lead-mailbox: pump deferred — ${String(error)}`));
  };
  resumeOrdinaryRuntime();
  onPaseoCaptured = resumeOrdinaryRuntime;
  const postReadySyncTimer = setTimeout(() => {
    if (booted) refreshPluginInstallation();
  }, 250);
  postReadySyncTimer.unref?.();
  const recoveryTimer = setInterval(() => {
    if (!booted || !mailRecovered) resumeOrdinaryRuntime();
  }, 100);
  recoveryTimer.unref?.();
  // Durable Scrum intents can become actionable after the command or a turn
  // finishes. Retry them during this lifetime as well as at startup. The
  // existing SLP mailbox scheduling remains event-driven.
  let scrumRecoveryInFlight = false;
  const scrumRecoveryTimer = setInterval(() => {
    if (!booted || !mailRecovered || !paseoApi || scrumRecoveryInFlight || pendingUpgradeFor(stateDir) !== undefined) return;
    scrumRecoveryInFlight = true;
    void leadMail.pumpAll({ reconcileScrumOnly: true }).catch(error => log(`scrum recovery deferred: ${String(error)}`)).finally(() => { scrumRecoveryInFlight = false; });
  }, 1000);
  scrumRecoveryTimer.unref?.();
  let peerSweepInFlight = false;
  const peerSweepTimer = setInterval(() => {
    if (!booted || !mailRecovered || !paseoApi || peerSweepInFlight || pendingUpgradeFor(stateDir) !== undefined) return;
    peerSweepInFlight = true;
    void leadMail.sweepPeers().catch(error => log(`Peer context sweep deferred: ${String(error)}`)).finally(() => { peerSweepInFlight = false; });
  }, 5_000);
  peerSweepTimer.unref?.();
  // The turn boundary (v0.0.20, ADR 0013 §5; v0.0.23, ADR 0015 §3): every
  // `agent.turn_ended` hands the Lead-mailbox runtime the event — it settles
  // the in-flight batch (`mail_acked` on completed, `mail_requeued` otherwise)
  // for both registered Lead and registered Supervisor seats and drives the
  // 128k rotation state machine for the Project whose registered Lead ended
  // the turn.
  const offTurnEnded = server.on("agent.turn_ended", (event, context) => {
    capturePaseo(context);
    void leadMail.onLeadTurnEnded({ agentId: event.agent.id, outcome: event.outcome, timeline: event.timeline }).catch((error) => log(`lead-mailbox: turn settle deferred — ${String(error)}`));
  });
  const spool = startSpool(stateDir, factory, {
    ordinaryReady: () => booted && mailRecovered,
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
    projectDelete: async (request) => {
      const reply = await surface.projectDelete(
        {
          ...(request.projectRoot !== undefined
            ? { projectRoot: request.projectRoot }
            : request.workspace !== undefined
              ? { projectRoot: request.workspace }
              : {}),
          ...(request.projectSlug !== undefined ? { projectSlug: request.projectSlug } : {}),
          ...(request.project !== undefined ? { project: request.project } : {}),
          ...(request.seat !== undefined ? { seat: request.seat } : {}),
        },
        { paseo: paseoApi as never },
      );
      return reply.ok
        ? {
            id: request.id,
            ok: true as const,
            summary: reply.summary,
            project: reply.project,
            projectRoot: reply.projectRoot,
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
    executionSetMode: async request => {
      const reply = await surface.executionSetMode(request, { paseo: paseoApi as never });
      return reply.ok ? { id: request.id, ok: true, summary: "execution selection saved", data: reply.data } : { id: request.id, ok: false, code: reply.code, message: reply.error };
    },
    scrumCommand: async (request, caller) => {
      const reply = await surface.scrumCommand(request, { paseo: paseoApi as never }, caller);
      return reply.ok ? { id: request.id, ok: true, summary: `Scrum ${request.operation}`, data: reply.data } : { id: request.id, ok: false, code: reply.code, message: reply.error };
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
  const warmupTimer = setTimeout(() => {
    if (paseoApi === undefined) {
      warmPluginDaemonApiViaWs(home);
    }
  }, 50);
  warmupTimer.unref?.();

  const gitBlocks = startGitBlockIngestion(factory, { onLog: log });

  const offSessionOpen = server.before("agent.session_open", ({ request }, context) => factory.history.runOperation(() => {
    capturePaseo(context);
    refreshPluginInstallation();
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
    // The new-Supervisor session sweep (v0.0.31, ADR 0017 §5): a Supervisor
    // session opening/binding for a Project archives that Project's orphaned
    // `local_checkout` workspaces over the daemon records — the same sweep
    // `ensureSeat("supervisor")` and `projectReset` run. Fire-and-forget:
    // the session never waits on the sweep, and its rules never touch the
    // active Supervisor/Lead workspace or any workspace hosting a live agent.
    if (withEnv !== undefined && withEnv.env?.PASEO_FACTORY_SEAT === "supervisor") {
      const openingWorkspaceId =
        typeof next.workspaceId === "string" && next.workspaceId.trim() !== "" ? next.workspaceId.trim() : undefined;
      void surface.sweepProjectWorkspaces({
        projectRoot: next.cwd,
        ...(openingWorkspaceId !== undefined ? { keepWorkspaceIds: [openingWorkspaceId] } : {}),
      });
    }
    if (
      withEnv !== undefined &&
      request.reason === "resume" &&
      request.purpose === "interactive" &&
      typeof withEnv.env?.PASEO_FACTORY_PROJECT === "string" &&
      withEnv.env.PASEO_FACTORY_PROJECT.trim() !== ""
    ) {
      const resumedSlug = withEnv.env.PASEO_FACTORY_PROJECT.trim();
      const resumedSeat = withEnv.env.PASEO_FACTORY_SEAT;
      if (resumedSeat === "lead" || resumedSeat === "supervisor") {
        const resumePumpTimer = setTimeout(() => {
          void (resumedSeat === "lead"
            ? leadMail.pumpProjectLead(resumedSlug)
            : leadMail.pumpProjectSupervisor(resumedSlug)
          ).catch(() => {});
        }, 150);
        resumePumpTimer.unref?.();
      }
    }
    return withEnv === undefined ? (next === request ? undefined : next) : withEnv;
  }));

  return () => {
    clearTimeout(warmupTimer);
    clearTimeout(postReadySyncTimer);
    clearInterval(recoveryTimer);
    clearInterval(scrumRecoveryTimer);
    clearInterval(peerSweepTimer);
    offPermissionAsked();
    offAgentCreate();
    offSessionOpen();
    offTurnEnded();
    gitBlocks.stop();
    spool.stop();
    leadMail.stop();
    factory.history.stop();
    log(`down v${SHELL_VERSION}`);
  };
}
