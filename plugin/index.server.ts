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
import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createFactory } from "./server/core/factory.ts";
import { PLUGIN_ID, pluginDirFor, resolvePaseoHome, stateDirFor } from "./server/paths.ts";
import { claimCliBinDir, ensureClaimCli, ensureGitShim, injectClaimCliPath } from "./server/shell.ts";
import { createChoke, startGitBlockIngestion } from "./server/choke.ts";
import { createTimelineFetcher } from "./server/timeline.ts";
import type { TimelineSourceApi } from "./server/timeline.ts";
import { spoolRootFor, startSpool } from "./server/spool.ts";
import { createSurfaceHandlers, registerSurfaceRpc } from "./server/surface-rpc.ts";
import { injectRoleOnCreate, injectSessionEnv } from "./server/roles.ts";

const SHELL_VERSION = "0.0.14";

const log = (message: string) => console.log(`[${PLUGIN_ID}] ${message}`);

export default function contribute(server: PluginServerContext) {
  const home = resolvePaseoHome(process.env, homedir());
  const stateDir = stateDirFor(home);
  const pluginDir = pluginDirFor(home);

  // The watch's feed (v0.0.6): every hook receives the process's one
  // long-lived PaseoApi (ticket 02 §a) — capture it from whichever fires
  // first (create, session open, a permit ask) and the factory's watch pass
  // can read the claiming agent's timeline at verdict. One variable, written
  // idempotently; undefined until the first hook fires.
  let paseoApi: TimelineSourceApi | undefined;
  const capturePaseo = (context: PluginHookContext): void => {
    if (paseoApi === undefined) {
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
    const pinned = choke.pinCreateMode(next.config);
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
    return injected === undefined ? (next === request ? undefined : next) : injected;
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
  const surface = createSurfaceHandlers(surfaceDeps);
  const spool = startSpool(stateDir, factory, {
    onLog: log,
    ask: choke.spoolAskHandler,
    leadRotate: async (request) => {
      const reply = await surface.leadRotate({ projectRoot: request.projectRoot }, { paseo: paseoApi as never });
      return reply.ok
        ? { id: request.id, ok: true as const, summary: `lead rotated — agent ${reply.agentId} cancelled + archived`, agentId: reply.agentId }
        : { id: request.id, ok: false as const, code: reply.code, message: reply.error };
    },
  });
  log(`spool listening on ${spoolRootFor(stateDir)}/{requests,replies,processed}`);
  registerSurfaceRpc(server, surface);

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
    gitBlocks.stop();
    spool.stop();
    log(`down v${SHELL_VERSION}`);
  };
}
