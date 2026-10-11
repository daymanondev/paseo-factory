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

const SHELL_VERSION = "0.0.9";

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
    const next = choke.pinCreateMode(request.config);
    if (next !== undefined) {
      log(`choke: pinned permission mode to Always Ask for the new agent in ${request.config.cwd}`);
    }
    return next === undefined ? undefined : { ...request, config: next };
  });

  const spool = startSpool(stateDir, factory, { onLog: log, ask: choke.spoolAskHandler });
  log(`spool listening on ${spoolRootFor(stateDir)}/{requests,replies,processed}`);

  const gitBlocks = startGitBlockIngestion(factory, { onLog: log });

  const offSessionOpen = server.before("agent.session_open", ({ request }, context) => {
    capturePaseo(context);
    if (pluginDir === undefined) return undefined;
    const next = injectClaimCliPath(request, claimCliBinDir(stateDir));
    if (next !== request) {
      log(`factory-claim on PATH for agent ${request.agentId} (${request.reason})`);
    }
    return next;
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
