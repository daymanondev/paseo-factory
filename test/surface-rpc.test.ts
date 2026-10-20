import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { existsSync, chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { sealVaultBuffer } from "../src/index.ts";
import type { VaultRunner, VaultRunnerCall } from "../src/index.ts";
import { createFactory } from "../plugin/server/core/factory.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { createSurfaceHandlers, sanitizeLaneWithProviders } from "../plugin/server/surface-rpc.ts";
import type { ProviderEntry, SurfaceDaemonApi, SurfaceDeps } from "../plugin/server/surface-rpc.ts";
import { handleSpoolRequest } from "../plugin/server/spool.ts";
import {
  BRIDGE_TIMEOUT_MS,
  checkDaemonPluginUpdates,
  cliUtils,
  getCachedPluginUpdateStatus,
  installDaemonPlugin,
  listDaemonPlugins,
  manageDaemonPlugin,
  PLUGIN_IO_TIMEOUT_MS,
  PLUGIN_LIST_TTL_MS,
  readPluginVersionFromDisk,
} from "../plugin/server/daemon-cli.ts";
import type { DaemonPluginItem } from "../plugin/server/daemon-cli.ts";
import { foldCompanions, foldCorePlugin, foldTasks } from "../plugin/server/view.ts";
import { factoryEnvFor, injectRoleOnCreate, injectSessionEnv, renderAgentContract, renderSeatBootstrap, renderSeatContract } from "../plugin/server/roles.ts";
import type { AgentCreateRequest } from "../plugin/server/roles.ts";
import { discoverProjects, readProjectRegistration, writeProjectRegistration } from "../plugin/server/projects.ts";
import { lanesPath, loadLanes, saveLanes } from "../src/lanes.ts";
import { prepareTaskWorktree } from "../src/workspace.ts";
import { deliverLeadMail, enqueueLeadMail } from "../src/mailbox.ts";
import { disposeDir, fakeCopilotRunner, gitCommitAll, makeTempDir, writeLanes } from "./helpers.ts";

/**
 * The Factory surface's in-process single-writer RPC handlers (v0.0.13,
 * ADR 0009 §2/§4) against a real factory on a temp state dir and a fake
 * daemon shaped exactly like the PaseoApi slice the handlers call. The
 * Owner acts (accept, retro, lanes.set, supervisor ensure/revoke) must land
 * in-process — the ledger's single writer is the plugin's own factory, never
 * a spool round trip.
 */

// ---- the fake daemon — the structural slice surface-rpc.ts names ------------------------

interface FakeAgent {
  id: string;
  title?: string;
  status?: string;
  provider?: string;
  model?: string | null;
  thinkingOptionId?: string | null;
  lastError?: string | null;
  labels?: Record<string, string>;
  requiresAttention?: boolean;
  seqEnd?: number;
  cwd?: string;
  /** The live usage slice the 128k Lead sensor reads (ticket 07's SurfaceAgentSnapshot extension). */
  lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null;
}

function fakeDaemon(agents: FakeAgent[]) {
  const created: { config: { provider: string; thinkingOptionId?: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }[] = [];
  const sent: { agentId: string; text: string }[] = [];
  const archived: string[] = [];
  const timelineReads: string[] = [];
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async (options) => {
        const filter = options?.filter;
        const kept = agents.filter((agent) => {
          if (filter?.labels !== undefined) {
            for (const [key, value] of Object.entries(filter.labels)) {
              if (agent.labels?.[key] !== value) return false;
            }
          }
          return true;
        });
        return {
          entries: kept.map((agent) => ({
            agent: {
              id: agent.id,
              provider: agent.provider ?? "pi/zai/glm-5.3",
              title: agent.title ?? null,
              status: agent.status ?? "idle",
              model: agent.model ?? null,
              ...(agent.thinkingOptionId === undefined ? {} : { thinkingOptionId: agent.thinkingOptionId }),
              ...(agent.lastError === undefined ? {} : { lastError: agent.lastError }),
              labels: agent.labels ?? {},
              archivedAt: null,
              requiresAttention: agent.requiresAttention ?? false,
              attentionReason: null,
              updatedAt: "2026-10-15T00:00:00.000Z",
              cwd: agent.cwd ?? "/tmp",
              ...(agent.lastUsage === undefined ? {} : { lastUsage: agent.lastUsage }),
            },
          })),
          pageInfo: {},
        };
      },
      create: async (options) => {
        created.push({ config: options.config, cwd: options.cwd, title: options.title ?? "", labels: options.labels ?? {}, prompt: options.prompt });
        const id = `agent-created-${created.length}`;
        agents.push({
          id,
          title: options.title ?? undefined,
          provider: options.config.provider,
          ...(options.config.thinkingOptionId === undefined ? {} : { thinkingOptionId: options.config.thinkingOptionId }),
          labels: options.labels,
        });
        return { id };
      },
      ref: (id: string) => ({
        send: async (text: string) => {
          sent.push({ agentId: id, text });
        },
        archive: async () => {
          archived.push(id);
          const at = agents.findIndex((agent) => agent.id === id);
          if (at !== -1) agents.splice(at, 1); // archived agents leave the includeArchived:false listing
          return { archivedAt: new Date().toISOString() };
        },
        timeline: {
          refetch: async () => {
            timelineReads.push(id);
            const agent = agents.find((a) => a.id === id);
            return { entries: [{ seqEnd: agent?.seqEnd ?? 0 }] };
          },
        },
      }),
    },
    providers: {
      listAvailable: async () => ({
        providers: [
          { provider: "pi", available: true },
          { provider: "copilot", available: true },
          { provider: "claude", available: false, error: "not authenticated" },
        ],
      }),
      listModels: async () => ({ models: [] }),
    },
  };
  return { daemon, created, sent, archived };
}

/** A factory plus handlers over a temp state dir and home. */
function makeSurface(t: TestContext, agents: FakeAgent[] = [], plugins: DaemonPluginItem[] = [], vaultRunner?: VaultRunner) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const retroRunner = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: retroRunner.runner });
  const fake = fakeDaemon(agents);
  const modelSyncs: { agentId: string; model: string }[] = [];
  const thinkingSyncs: { agentId: string; thinkingOptionId: string }[] = [];
  const stopped: string[] = [];
  // The plugin lifecycle overrides (v0.0.17): the daemon's plugin list is
  // mutable so a test can seed installed companions, and every capture array
  // records the `home` the handler targeted — the ADR 0012 §4 isolation proof.
  const listedPlugins: DaemonPluginItem[] = [...plugins];
  const pluginListHomes: string[] = [];
  const pluginInstalls: { home: string; input: { id: string; source: string; ref?: string } }[] = [];
  const pluginManages: { home: string; pluginId: string; action: string }[] = [];
  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon: fake.daemon,
    setAgentModel: async (agentId, model) => {
      modelSyncs.push({ agentId, model });
      return { ok: true };
    },
    setAgentThinking: async (agentId, thinkingOptionId) => {
      thinkingSyncs.push({ agentId, thinkingOptionId });
      return { ok: true };
    },
    stopAgent: async (agentId) => {
      stopped.push(agentId);
      return { ok: true };
    },
    listPlugins: async (listHome) => {
      pluginListHomes.push(listHome);
      return { ok: true, plugins: listedPlugins };
    },
    installPlugin: async (installHome, input) => {
      pluginInstalls.push({ home: installHome, input });
      // A faithful daemon: the installed plugin joins the list the next read sees.
      listedPlugins.push({ id: input.id, path: `/plugins/${input.id}`, enabled: true, status: "running" });
      return { ok: true, plugin: { id: input.id, path: `/plugins/${input.id}`, enabled: true, status: "running" } };
    },
    managePlugin: async (manageHome, pluginId, action) => {
      pluginManages.push({ home: manageHome, pluginId, action });
      return { ok: true };
    },
    // The vault transport seam (v0.0.21, ADR 0014 §2): tests inject a fake
    // `VaultRunner` so the four factory.vault.* handlers run end-to-end with
    // zero network — the same law listPlugins/installPlugin carry.
    ...(vaultRunner === undefined ? {} : { vaultRunner }),
  });
  return { dir, home, stateDir, factory, handlers, fake, modelSyncs, thinkingSyncs, stopped, listedPlugins, pluginListHomes, pluginInstalls, pluginManages };
}

/** Appends a green task's whole ledger slice + files, the fold's richest input. */
function seedGreenTask(factory: ReturnType<typeof createFactory>, stateDir: string, task: string, workspace: string): void {
  factory.ledger.append({ event: "contract_set", task, workspace, gate: "npm test", artifact: "src/format.ts", base: "base0001", scope: ["src"], description: "Do the thing." });
  factory.ledger.append({ event: "spawn_dispatched", task, provider: "pi/zai/glm-5.3", arity: 1 });
  factory.ledger.append({ event: "claim_reported", task, attempt: 1, sha: "full0001", agent: "agent-worker-1" });
  factory.ledger.append({ event: "gate_started", task, attempt: 1, cmd: "npm test" });
  const gateLog = join(stateDir, `gate-${task}-1.log`);
  writeFileSync(gateLog, "ok 5 tests\n");
  factory.ledger.append({ event: "gate_finished", task, attempt: 1, exit: 0, verdict: "green", note: "5/5", sha: "full0001", outputPath: gateLog });
  factory.ledger.append({ event: "fresh_eyes_written", task, attempt: 1, model: "pi/zai/glm-5.3", outcome: "clear", finding: "Nothing to add.", durationMs: 900 });
  factory.ledger.append({ event: "watch_written", task, attempt: 1, model: "pi/zai/glm-5.3", outcome: "written", answers: { "scope-creep": 0.12 }, durationMs: 800 });
  const report = join(stateDir, `report-${task}-1.md`);
  writeFileSync(report, `# Report ${task} 1\n\nGREEN\n`);
  factory.ledger.append({ event: "report_written", task, attempt: 1, path: report });
  factory.ledger.append({ event: "meter_written", task, provider: "pi/zai/glm-5.3", usage: { totalCostUsd: 0.04 }, agent: "agent-worker-1" });
}

// ---- the snapshot ------------------------------------------------------------------------

test("snapshot: versioned view folding ledger + lanes + daemon agents + providers", async (t) => {
  const { stateDir, factory, handlers } = makeSurface(t, [
    { id: "agent-sup-1", title: "Supervisor (paseo-factory)", provider: "pi/zai/glm-5.3", labels: { seat: "supervisor" }, seqEnd: 41 },
    { id: "agent-worker-1", title: "T1", provider: "pi/zai/glm-5.3", status: "running", seqEnd: 17 },
    { id: "agent-stranger", title: "Unrelated", provider: "claude/opus-4-8" },
  ]);
  const workspace = join(stateDir, "..", "..", "ws");
  seedGreenTask(factory, stateDir, "T1", workspace);

  const snap = await handlers.snapshot({});
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  const view = snap.view;
  assert.equal(view.version, 3);
  assert.equal(view.lanes.worker, "pi/zai/glm-5.3", "the lanes table rides the snapshot");
  assert.equal(view.kpis.readyToAccept, 1, "one green unaccepted task");
  assert.equal(view.kpis.accepted, 0);
  assert.equal(view.kpis.totalCostUsd, 0.04, "the metered dollars sum");

  const task = view.tasks.find((entry) => entry.task === "T1")!;
  assert.equal(task.status, "ready-to-accept");
  assert.equal(task.lane, "pi/zai/glm-5.3", "the latest meter's provider is the lane");
  assert.equal(task.costState, "metered");
  assert.equal(task.costUsd, 0.04);
  assert.equal(task.attempts.length, 1);
  const attempt = task.attempts[0]!;
  assert.equal(attempt.verdict, "green");
  assert.equal(attempt.open, false);
  assert.equal(attempt.respawned, false);
  assert.equal(attempt.gateLog, `gate-T1-1.log`);
  assert.equal(attempt.report, `report-T1-1.md`);
  assert.equal(attempt.eye?.outcome, "clear");
  assert.equal(attempt.watch?.maxProbability, 0.12);
  assert.equal(task.choke.allowed, 0);

  // Agents: the supervisor (seat-labeled) plus the ledger-bound worker; the
  // stranger stays out — the surface shows the factory's seats, not the daemon's census.
  assert.ok(view.supervisor !== null && view.supervisor.id === "agent-sup-1", "the seat=supervisor agent is the supervisor");
  assert.equal(view.supervisor.seat, "supervisor");
  assert.equal(view.supervisor.seqEnd, 41, "the Timeline Oracle seqEnd rides the agent view");
  const worker = view.agents.find((agent) => agent.id === "agent-worker-1")!;
  assert.equal(worker.task, "T1", "a ledger-named agent is bound to its task");
  assert.equal(view.agents.some((agent) => agent.id === "agent-stranger"), false);

  assert.deepEqual(
    view.providers.map((entry) => [entry.provider, entry.available]).sort(),
    [["claude", false], ["copilot", true], ["pi", true]],
    "the lane picker's provider list rides the snapshot",
  );
  assert.ok(view.ledger.length > 0, "the ledger stream rides the snapshot");
  assert.equal(view.daemonError, null);
});

test("snapshot: the companion catalog rides the view — three cards, not_installed when the daemon lists only paseo-factory", async (t) => {
  const { handlers } = makeSurface(t, [], [{ id: "paseo-factory", path: "/plugins/paseo-factory", enabled: true, status: "running" }]);
  const snap = await handlers.snapshot({});
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  const view = snap.view;
  // Exactly the three official companions, catalog order — the spec's own literals;
  // the daemon's own paseo-factory entry is a stranger to the catalog, never a card.
  assert.deepEqual(view.companions.map((companion) => companion.id), ["factory-burn-lab", "factory-connector", "factory-release-lab"]);

  const burn = view.companions[0]!;
  assert.equal(burn.title, "Burn Lab");
  assert.equal(burn.canonicalSource, "git:daymanondev/factory-burn-lab:plugin");
  assert.equal(burn.sidebarLabel, "Burn Lab");
  assert.equal(burn.sidebarIcon, "Flame");
  assert.deepEqual(burn.capabilities, ["Scout Pool", "OSS Lab", "Proto Arena", "Night Shift", "Self-Evolve"]);
  assert.ok(burn.tagline.length > 0, "the card's tagline is prose, not a blank");
  assert.ok(burn.description.length > 0, "the card's description is prose, not a blank");

  const fleet = view.companions[1]!;
  assert.equal(fleet.title, "Fleet Connector");
  assert.equal(fleet.canonicalSource, "git:daymanondev/factory-connector:plugin");
  assert.equal(fleet.sidebarLabel, "Fleet Connector");
  assert.equal(fleet.sidebarIcon, "Network");
  assert.deepEqual(fleet.capabilities, ["Tailscale Fleet Surface", "1-Click Handoff", "Cooperative Burst", "Git Mirror & Ref Sync"]);
  assert.ok(fleet.tagline.length > 0);
  assert.ok(fleet.description.length > 0);

  const lab = view.companions[2]!;
  assert.equal(lab.title, "Release Lab");
  assert.equal(lab.canonicalSource, "git:daymanondev/factory-release-lab:plugin");
  assert.equal(lab.sidebarLabel, "Release Lab");
  assert.equal(lab.sidebarIcon, "Rocket");
  assert.deepEqual(lab.capabilities, ["7-Phase Release Pipeline", "ASC & Google Play IAP Sync", "Signing & Firebase SHA Bridge", "Screenshot Studio"]);
  assert.ok(lab.tagline.length > 0);
  assert.ok(lab.description.length > 0);

  // The degraded arm: no daemon plugin list → every card is not_installed with
  // null install identity (spec §Implementation Decisions 2's unavailable default).
  for (const companion of view.companions) {
    assert.equal(companion.status, "not_installed");
    assert.equal(companion.enabled, false);
    assert.equal(companion.installKind, null);
    assert.equal(companion.installedSource, null);
    assert.equal(companion.currentRevision, null);
    assert.equal(companion.error, null);
  }
});

// ---- the companion fold (v0.0.17, ADR 0012 §2) ----------------------------------------------

// The fold is pure over the daemon's plugin.list entries (the DaemonAgentsInput
// precedent — surface-rpc.ts gathers, view.ts never calls the daemon), so its
// listed-state mapping is exercised directly; the snapshot seam carries the
// same join once the live lister lands (ticket 03).

test("companion fold: listed daemon plugins map onto the cards with install identity; strangers gain no card and absent entries degrade", () => {
  const folded = foldCompanions([
    // A non-companion plugin on the same daemon — never a card.
    { id: "paseo-factory", enabled: true, status: "running" },
    {
      id: "factory-burn-lab",
      enabled: true,
      status: "running",
      installation: { identity: { kind: "git", remote: "https://github.com/daymanondev/factory-burn-lab", pluginPath: "plugin" }, currentRevision: "abc1234def5678" },
    },
    {
      id: "factory-connector",
      enabled: false,
      status: "disabled",
      installation: { identity: { kind: "directory", path: "/Users/dev/code/factory-connector" } },
    },
    {
      id: "factory-release-lab",
      enabled: true,
      status: "running",
      installation: { identity: { kind: "git", remote: "https://github.com/daymanondev/factory-release-lab", pluginPath: "plugin" }, currentRevision: "rocket42" },
    },
  ]);
  assert.equal(folded.length, 3, "the catalog fixes the card count");

  const burn = folded[0]!;
  assert.equal(burn.title, "Burn Lab");
  assert.equal(burn.status, "running");
  assert.equal(burn.enabled, true);
  assert.equal(burn.installKind, "git");
  assert.equal(burn.installedSource, "https://github.com/daymanondev/factory-burn-lab");
  assert.equal(burn.currentRevision, "abc1234def5678");
  assert.equal(burn.error, null);

  const fleet = folded[1]!;
  assert.equal(fleet.status, "disabled");
  assert.equal(fleet.enabled, false);
  assert.equal(fleet.installKind, "directory");
  assert.equal(fleet.installedSource, "/Users/dev/code/factory-connector");
  assert.equal(fleet.currentRevision, null, "no revision anywhere on the entry → null, never a fabricated sha");
  assert.equal(fleet.error, null);

  const lab = folded[2]!;
  assert.equal(lab.title, "Release Lab");
  assert.equal(lab.status, "running");
  assert.equal(lab.enabled, true);
  assert.equal(lab.installKind, "git");
  assert.equal(lab.installedSource, "https://github.com/daymanondev/factory-release-lab");
  assert.equal(lab.currentRevision, "rocket42");
  assert.equal(lab.error, null);
});

test("companion fold: failed carries the daemon error, npm names its package, revision falls back to the legacy commit", () => {
  const folded = foldCompanions([
    {
      id: "factory-burn-lab",
      enabled: true,
      status: "failed",
      error: "entry point factory.mjs missing",
      commit: "deadbee",
      installation: { identity: { kind: "npm", packageName: "@daymanondev/factory-burn-lab", pluginPath: "." } },
    },
  ]);
  const burn = folded[0]!;
  assert.equal(burn.status, "failed");
  assert.equal(burn.installKind, "npm", "the install identity's kind is the truth — the legacy source enum has no npm arm");
  assert.equal(burn.installedSource, "@daymanondev/factory-burn-lab");
  assert.equal(burn.currentRevision, "deadbee", "installation.currentRevision wins; the legacy commit fills when absent");
  assert.equal(burn.error, "entry point factory.mjs missing");

  // An absent catalog entry degrades to not_installed even when the list itself answered.
  const fleet = folded[1]!;
  assert.equal(fleet.status, "not_installed");
  assert.equal(fleet.enabled, false);
  assert.equal(fleet.installKind, null);
  assert.equal(fleet.installedSource, null);
  assert.equal(fleet.currentRevision, null);
  assert.equal(fleet.error, null);
});

test("snapshot: the companions fold joins the live daemon plugin list — running and disabled carry their install identity", async (t) => {
  const { handlers, home, pluginListHomes } = makeSurface(
    t,
    [],
    [
      // A non-companion plugin on the same daemon — never a card.
      { id: "paseo-factory", path: "/plugins/paseo-factory", enabled: true, status: "running" },
      {
        id: "factory-burn-lab",
        path: "/plugins/factory-burn-lab",
        enabled: true,
        status: "running",
        installation: { identity: { kind: "git", remote: "https://github.com/daymanondev/factory-burn-lab", pluginPath: "plugin" }, currentRevision: "abc1234def5678" },
      },
      {
        id: "factory-connector",
        path: "/plugins/factory-connector",
        enabled: false,
        status: "disabled",
        installation: { identity: { kind: "directory", path: "/Users/dev/code/factory-connector" } },
      },
      {
        id: "factory-release-lab",
        path: "/plugins/factory-release-lab",
        enabled: true,
        status: "running",
        installation: { identity: { kind: "git", remote: "https://github.com/daymanondev/factory-release-lab", pluginPath: "plugin" }, currentRevision: "rocket42" },
      },
    ],
  );
  const snap = await handlers.snapshot({});
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  assert.deepEqual(pluginListHomes, [home], "the list call targets strictly the surface's home — trial and production never cross-contaminate");

  const burn = snap.view.companions.find((companion) => companion.id === "factory-burn-lab")!;
  assert.equal(burn.status, "running");
  assert.equal(burn.enabled, true);
  assert.equal(burn.installKind, "git");
  assert.equal(burn.installedSource, "https://github.com/daymanondev/factory-burn-lab");
  assert.equal(burn.currentRevision, "abc1234def5678");
  assert.equal(burn.error, null);

  const fleet = snap.view.companions.find((companion) => companion.id === "factory-connector")!;
  assert.equal(fleet.status, "disabled");
  assert.equal(fleet.enabled, false);
  assert.equal(fleet.installKind, "directory");
  assert.equal(fleet.installedSource, "/Users/dev/code/factory-connector");
  assert.equal(fleet.currentRevision, null);
  assert.equal(fleet.error, null);

  const lab = snap.view.companions.find((companion) => companion.id === "factory-release-lab")!;
  assert.equal(lab.status, "running");
  assert.equal(lab.enabled, true);
  assert.equal(lab.installKind, "git");
  assert.equal(lab.installedSource, "https://github.com/daymanondev/factory-release-lab");
  assert.equal(lab.currentRevision, "rocket42");
  assert.equal(lab.error, null);
});

test("snapshot: a failed companion carries the daemon's error and npm identity; an unlisted companion degrades to not_installed", async (t) => {
  const { handlers } = makeSurface(t, [], [
    {
      id: "factory-connector",
      path: "/plugins/factory-connector",
      enabled: true,
      status: "failed",
      error: "missing requirement: tailscale binary",
      commit: "legacy0001",
      installation: { identity: { kind: "npm", packageName: "@daymanondev/factory-connector", pluginPath: "." } },
    },
  ]);
  const snap = await handlers.snapshot({});
  assert.ok(snap.ok, snap.ok ? "" : snap.error);

  const fleet = snap.view.companions.find((companion) => companion.id === "factory-connector")!;
  assert.equal(fleet.status, "failed");
  assert.equal(fleet.error, "missing requirement: tailscale binary", "the daemon's error string rides the card (spec §User Story 10)");
  assert.equal(fleet.installKind, "npm", "the install identity's kind is the truth — the legacy source enum has no npm arm");
  assert.equal(fleet.installedSource, "@daymanondev/factory-connector");
  assert.equal(fleet.currentRevision, "legacy0001", "installation.currentRevision wins; the legacy commit fills when absent");

  const burn = snap.view.companions.find((companion) => companion.id === "factory-burn-lab")!;
  assert.equal(burn.status, "not_installed");
  assert.equal(burn.enabled, false);
  assert.equal(burn.installKind, null);
  assert.equal(burn.installedSource, null);
  assert.equal(burn.currentRevision, null);
  assert.equal(burn.error, null);
});

test("snapshot: an unavailable daemon plugin list degrades to the all-not_installed default — never a refusal", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const retroRunner = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: retroRunner.runner });
  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon: fakeDaemon([]).daemon,
    listPlugins: async () => ({ ok: false, reason: "no daemon is running at this home" }),
  });
  const snap = await handlers.snapshot({});
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  assert.deepEqual(
    snap.view.companions.map((companion) => [companion.id, companion.status]),
    [
      ["factory-burn-lab", "not_installed"],
      ["factory-connector", "not_installed"],
      ["factory-release-lab", "not_installed"],
    ],
    "the degrade law — an unavailable list folds every catalog entry to not_installed (spec §Implementation Decisions 2)",
  );
});

test("snapshot: the status fold — running, needs-human, accepted, red", async (t) => {
  const { stateDir, factory, handlers } = makeSurface(t);
  // T-run: an open attempt (claim without report).
  factory.ledger.append({ event: "contract_set", task: "T-RUN", workspace: "/w", gate: "true", artifact: "a" });
  factory.ledger.append({ event: "claim_reported", task: "T-RUN", attempt: 1, sha: "s" });
  // T-stuck: a needs_human as the latest state marker.
  factory.ledger.append({ event: "contract_set", task: "T-STUCK", workspace: "/w2", gate: "true", artifact: "a" });
  factory.ledger.append({ event: "repoke_dispatched", task: "T-STUCK", agent: "ag" });
  factory.ledger.append({ event: "needs_human", task: "T-STUCK", reason: "silent-after-repoke", evidence: { denial: 2, repoke: 1 } });
  // T-done: accepted.
  factory.ledger.append({ event: "contract_set", task: "T-DONE", workspace: "/w3", gate: "true", artifact: "a" });
  factory.ledger.append({ event: "claim_reported", task: "T-DONE", attempt: 1, sha: "s" });
  factory.ledger.append({ event: "gate_finished", task: "T-DONE", attempt: 1, exit: 0, verdict: "green", note: "" });
  factory.ledger.append({ event: "report_written", task: "T-DONE", attempt: 1, path: "/r" });
  factory.ledger.append({ event: "attempt_accepted", task: "T-DONE", attempt: 1, accepted_by: "owner" });
  // T-red: latest verdict red.
  factory.ledger.append({ event: "contract_set", task: "T-RED", workspace: "/w4", gate: "true", artifact: "a" });
  factory.ledger.append({ event: "claim_reported", task: "T-RED", attempt: 1, sha: "s" });
  factory.ledger.append({ event: "gate_finished", task: "T-RED", attempt: 1, exit: 1, verdict: "red", note: "fail" });
  factory.ledger.append({ event: "report_written", task: "T-RED", attempt: 1, path: "/r" });
  // T-respawn: attempt 1 red, then respawn_dispatched landed with no verdict since → running.
  factory.ledger.append({ event: "contract_set", task: "T-RESPAWN", workspace: "/w5", gate: "true", artifact: "a" });
  factory.ledger.append({ event: "claim_reported", task: "T-RESPAWN", attempt: 1, sha: "s" });
  factory.ledger.append({ event: "gate_finished", task: "T-RESPAWN", attempt: 1, exit: 1, verdict: "red", note: "fail" });
  factory.ledger.append({ event: "report_written", task: "T-RESPAWN", attempt: 1, path: "/r" });
  factory.ledger.append({ event: "respawn_dispatched", task: "T-RESPAWN", provider: "pi/zai/glm-5.3", died_agent: "ag1" });

  const snap = await handlers.snapshot({});
  assert.ok(snap.ok);
  const statusOf = (task: string) => snap.view.tasks.find((entry) => entry.task === task)!.status;
  assert.equal(statusOf("T-RUN"), "running");
  assert.equal(statusOf("T-RESPAWN"), "running");
  assert.equal(statusOf("T-STUCK"), "needs-human");
  assert.equal(statusOf("T-DONE"), "accepted");
  assert.equal(statusOf("T-RED"), "red");
  assert.deepEqual(
    { needsHuman: snap.view.kpis.needsHuman, running: snap.view.kpis.running, accepted: snap.view.kpis.accepted, readyToAccept: snap.view.kpis.readyToAccept },
    { needsHuman: 1, running: 2, accepted: 1, readyToAccept: 0 },
  );
  const stuck = snap.view.tasks.find((entry) => entry.task === "T-STUCK")!;
  assert.equal(stuck.needsHumanReason, "silent-after-repoke");
});

// ---- the Owner acts (in-process single writer) --------------------------------------------

test("accept: factory.accept with accepted_by 'owner' — the UI's act is the Owner's act", async (t) => {
  const { stateDir, factory, handlers } = makeSurface(t);
  seedGreenTask(factory, stateDir, "ACC1", "/w");
  const reply = await handlers.accept({ task: "ACC1", attempt: 1 });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  const accepted = factory.ledger.eventsFor("ACC1").findLast((e) => e.event === "attempt_accepted")!;
  assert.equal(accepted.accepted_by, "owner", "the RPC stamps the owner, in-process");
  assert.equal(reply.seq, accepted.seq);

  const notGreen = await handlers.accept({ task: "ACC1", attempt: 2 });
  assert.ok(!notGreen.ok);
  assert.equal(notGreen.code, "unknown-attempt");
});

test("retro: the plugin's own factory.retro(), refusals as Failure codes", async (t) => {
  const { stateDir, factory, handlers } = makeSurface(t);
  factory.ledger.append({ event: "contract_set", task: "R1", workspace: "/w", gate: "true", artifact: "a" });
  const first = await handlers.retro({});
  assert.ok(first.ok, first.ok ? "" : first.error);
  assert.equal(first.outcome, "written");
  assert.equal(first.proposalCount, 0);
  const second = await handlers.retro({});
  assert.ok(!second.ok);
  assert.equal(second.code, "retro-same-day", "the same-day refusal is data, not an exception");
  void stateDir;
});

test("lanes.set: writes lanes.json, syncs a live supervisor's model and thinking level, refuses invalid values", async (t) => {
  const { stateDir, handlers, modelSyncs, thinkingSyncs } = makeSurface(t, [
    { id: "agent-sup-1", labels: { seat: "supervisor" }, provider: "pi/zai/glm-5.3" },
  ]);
  const reply = await handlers.lanesSet({ lane: "supervisor", value: "claude/opus-4-8" });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.equal(reply.lanes.supervisor, "claude/opus-4-8");
  const reread = loadLanes(stateDir);
  assert.ok(reread.ok && reread.lanes.supervisor === "claude/opus-4-8", "lanes.json is the config of record");
  assert.deepEqual(JSON.parse(readFileSync(lanesPath(stateDir), "utf8")), { supervisor: "claude/opus-4-8" }, "a lane-card save persists only the lane it names — defaults never materialize");
  assert.deepEqual(modelSyncs, [{ agentId: "agent-sup-1", model: "opus-4-8" }], "the live supervisor's modelId (stripped of provider prefix) was synced");
  assert.deepEqual(thinkingSyncs, [], "no thinking suffix means no thinking sync call");

  const withThinking = await handlers.lanesSet({ lane: "supervisor", value: "pi/zai/glm-5.3:max" });
  assert.ok(withThinking.ok, withThinking.ok ? "" : withThinking.error);
  assert.equal(withThinking.lanes.supervisor, "pi/zai/glm-5.3:max");
  assert.deepEqual(modelSyncs[1], { agentId: "agent-sup-1", model: "zai/glm-5.3" });
  assert.deepEqual(thinkingSyncs, [{ agentId: "agent-sup-1", thinkingOptionId: "max" }], "a :thinking suffix live-syncs the thinking option too");

  // No live supervisor → the sync is skipped, named, never a failure.
  const skipped = await handlers.lanesSet({ lane: "worker", value: "copilot/gpt-5.4" });
  assert.ok(skipped.ok);
  assert.match(skipped.modelSync, /skipped/);
  assert.equal(modelSyncs.length, 2);
  assert.deepEqual(
    JSON.parse(readFileSync(lanesPath(stateDir), "utf8")),
    { supervisor: "pi/zai/glm-5.3:max", worker: "copilot/gpt-5.4" },
    "the second single-lane save keeps the first named lane and adds nothing else",
  );

  const bad = await handlers.lanesSet({ lane: "watch", value: "auto" });
  assert.ok(!bad.ok);
  assert.equal(bad.code, "invalid-lane");
  const unchanged = loadLanes(stateDir);
  assert.ok(unchanged.ok && unchanged.lanes.watch === "pi/zai/glm-5.3", "a refused set leaves the file untouched");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(lanesPath(stateDir), "utf8"))).sort(), ["supervisor", "worker"]);
});

// ---- the per-Project seat bridges (v0.0.14, ADR 0010 §1–§2) ---------------------------------

test("supervisor.ensure: seats the agent AT the project root — no AGENTS.md write, labels, lane, bootstrap — and dispatches", async (t) => {
  const { home, handlers, fake, stateDir } = makeSurface(t, []);
  const project = makeProject(t, "ensure-sup");
  writeLanes(stateDir, { supervisor: "copilot/gpt-5.4" });

  const reply = await handlers.supervisorEnsure({ projectRoot: project.root, message: "Check the T1 verdict." });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.equal(reply.created, true);
  assert.match(reply.agentId, /agent-created-/);
  assert.equal(reply.projectRoot, project.root);
  assert.equal(reply.slug, project.slug);

  // The ADR 0010 §1 law: nothing under <project-root> is ever written — the
  // role rides the create's system prompt + bootstrap, and the repo's own
  // AGENTS.md / CLAUDE.md load natively.
  assert.equal(existsSync(join(project.root, "AGENTS.md")), false, "<project-root>/AGENTS.md is never written");
  assert.equal(existsSync(join(project.root, "CLAUDE.md")), false, "<project-root>/CLAUDE.md is never written");
  assert.equal(existsSync(join(dirname(home), `${basename(home)}-supervisor`)), false, "the retired <home>-supervisor folder stays retired");

  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0]!.config.provider, "copilot/gpt-5.4", "spawned under the configured supervisor lane");
  assert.deepEqual(fake.created[0]!.labels, { seat: "supervisor", project: project.slug }, "the seat + project labels are how every later ensure finds it");
  assert.equal(fake.created[0]!.title, "Supervisor (paseo-factory)");
  assert.equal(fake.created[0]!.cwd, project.root, "the seat stands at cwd = <project-root>");
  const bootstrap = fake.created[0]!.prompt ?? "";
  assert.match(bootstrap, /Project root \(your cwd\)/, "the bootstrap prompt carries the orientation");
  assert.match(bootstrap, /lead dispatch --workspace/, "the bootstrap lists day-one lead dispatch power");
  assert.match(bootstrap, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the bootstrap names the resolved home");
  assert.match(bootstrap, /paseo-factory role skills: grilling, domain-modeling/, "the bootstrap carries the skill trigger index footer");
  assert.deepEqual(fake.sent, [{ agentId: reply.agentId, text: "Check the T1 verdict." }], "the quick dispatch rode the create");

  // The durable registration records the slug→root + seat id.
  const registration = readProjectRegistration(stateDir, project.slug);
  assert.equal(registration?.root, project.root);
  assert.equal(registration?.supervisor, reply.agentId);
});

test("supervisor.ensure: an existing live seat for the Project is reused, not duplicated; other Projects' seats are not", async (t) => {
  const project = makeProject(t, "reuse-sup");
  const other = makeProject(t, "other-sup");
  const { handlers, fake } = makeSurface(t, [
    { id: "agent-sup-9", labels: { seat: "supervisor", project: project.slug }, title: "Supervisor (paseo-factory)" },
  ]);
  const reply = await handlers.supervisorEnsure({ projectRoot: project.root, message: "Status?" });
  assert.ok(reply.ok);
  assert.equal(reply.created, false);
  assert.equal(reply.agentId, "agent-sup-9");
  assert.equal(fake.created.length, 0, "no second supervisor while one lives");
  assert.deepEqual(fake.sent, [{ agentId: "agent-sup-9", text: "Status?" }]);

  // A different Project's supervisor is a different seat: ensure creates its own.
  const otherReply = await handlers.supervisorEnsure({ projectRoot: other.root });
  assert.ok(otherReply.ok, otherReply.ok ? "" : otherReply.error);
  assert.equal(otherReply.created, true, "each Project seats its own supervisor");
  assert.notEqual(otherReply.agentId, "agent-sup-9");
});

test("supervisor.ensure: a projectRoot git cannot answer for is a named refusal", async (t) => {
  const { handlers } = makeSurface(t);
  const outside = makeTempDir();
  disposeDir(t, outside);
  const reply = await handlers.supervisorEnsure({ projectRoot: outside });
  assert.ok(!reply.ok);
  assert.equal(reply.code, "unknown-project");
});

test("supervisor.revoke: stops and archives the Project's supervisor; none is a named refusal", async (t) => {
  const project = makeProject(t, "revoke-sup");
  const { handlers, stopped, fake } = makeSurface(t, [{ id: "agent-sup-9", labels: { seat: "supervisor", project: project.slug } }]);
  const reply = await handlers.supervisorRevoke({ projectRoot: project.root });
  assert.ok(reply.ok);
  assert.equal(reply.agentId, "agent-sup-9");
  assert.deepEqual(stopped, ["agent-sup-9"], "cancel first");
  assert.deepEqual(fake.archived, ["agent-sup-9"], "then archive");

  const none = await handlers.supervisorRevoke({ projectRoot: project.root });
  assert.ok(!none.ok);
  assert.equal(none.code, "no-supervisor");
});

test("supervisor.revoke without a projectRoot: one live supervisor is the legacy global act; two or more is a named refusal", async (t) => {
  const project = makeProject(t, "global-sup-a");
  const other = makeProject(t, "global-sup-b");
  const { handlers, stopped, fake } = makeSurface(t, [
    { id: "agent-sup-a", labels: { seat: "supervisor", project: project.slug } },
    { id: "agent-sup-b", labels: { seat: "supervisor", project: other.slug } },
  ]);

  const ambiguous = await handlers.supervisorRevoke({});
  assert.ok(!ambiguous.ok);
  assert.equal(ambiguous.code, "ambiguous-supervisor", "the global act refuses to pick between Projects' seats");
  assert.match(ambiguous.error, /pass projectRoot/);
  assert.match(ambiguous.error, new RegExp(project.slug));
  assert.match(ambiguous.error, new RegExp(other.slug));
  assert.deepEqual(stopped, [], "neither seat was touched");
  assert.deepEqual(fake.archived, [], "nothing was archived");

  // The single-supervisor case keeps the legacy global act working.
  const single = makeSurface(t, [{ id: "agent-sup-solo", labels: { seat: "supervisor", project: project.slug } }]);
  const legacy = await single.handlers.supervisorRevoke({});
  assert.ok(legacy.ok, legacy.ok ? "" : legacy.error);
  assert.equal(legacy.agentId, "agent-sup-solo");
  assert.deepEqual(single.stopped, ["agent-sup-solo"]);
  assert.deepEqual(single.fake.archived, ["agent-sup-solo"]);
});

test("lead.ensure: seats the Lead at the project root under lanes.lead with the Lead skill footer", async (t) => {
  const { stateDir, handlers, fake } = makeSurface(t, []);
  const project = makeProject(t, "ensure-lead");
  writeLanes(stateDir, { lead: "claude/opus-4-8" });

  const reply = await handlers.leadEnsure({ projectRoot: project.root, message: "Split the directive." });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.equal(reply.created, true);
  assert.equal(reply.slug, project.slug);
  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0]!.config.provider, "claude/opus-4-8", "spawned under the configured lead lane");
  assert.equal(fake.created[0]!.cwd, project.root);
  assert.deepEqual(fake.created[0]!.labels, { seat: "lead", project: project.slug });
  assert.equal(fake.created[0]!.title, "Lead (paseo-factory)");
  assert.match(fake.created[0]!.prompt ?? "", /paseo-factory role skills: codebase-design, domain-modeling, tdd/, "the Lead footer names its skills");
  assert.deepEqual(fake.sent, [{ agentId: reply.agentId, text: "Split the directive." }]);

  // An existing Lead is reused (find-or-create).
  const reuse = await handlers.leadEnsure({ projectRoot: project.root });
  assert.ok(reuse.ok);
  assert.equal(reuse.created, false);
  assert.equal(fake.created.length, 1);
});

test("lead.rotate: cancels + archives the active Lead and clears its registration; none is a named refusal", async (t) => {
  const project = makeProject(t, "rotate-lead");
  const { stateDir, handlers, stopped, fake } = makeSurface(t, [{ id: "agent-lead-4", labels: { seat: "lead", project: project.slug } }]);
  writeProjectRegistration(stateDir, project.slug, { root: project.root, lead: "agent-lead-4" });

  const reply = await handlers.leadRotate({ projectRoot: project.root });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.equal(reply.agentId, "agent-lead-4");
  assert.deepEqual(stopped, ["agent-lead-4"], "cancel first");
  assert.deepEqual(fake.archived, ["agent-lead-4"], "then archive — the next dispatch starts a fresh Lead");
  assert.equal(readProjectRegistration(stateDir, project.slug)?.lead, undefined, "the registration forgets the retired Lead");

  const none = await handlers.leadRotate({ projectRoot: project.root });
  assert.ok(!none.ok);
  assert.equal(none.code, "no-lead");
});

test("lanes.set: a lead save live-syncs the Project's Lead agent and writes the Project override file", async (t) => {
  const project = makeProject(t, "lanes-lead");
  const { stateDir, handlers, modelSyncs } = makeSurface(t, [
    { id: "agent-lead-2", labels: { seat: "lead", project: project.slug }, provider: "pi/zai/glm-5.3" },
  ]);
  const reply = await handlers.lanesSet({ lane: "lead", value: "claude/opus-4-8", projectRoot: project.root });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.equal(reply.lanes.lead, "claude/opus-4-8");
  assert.match(reply.modelSync, /applied — agent agent-le now runs claude\/opus-4-8/);
  assert.deepEqual(modelSyncs, [{ agentId: "agent-lead-2", model: "opus-4-8" }], "the live Lead's modelId (provider prefix stripped) was synced");
  // The save landed in the Project's override file alone — the machine table
  // was never seeded, so a project-scoped save must not materialize it.
  assert.equal(existsSync(lanesPath(stateDir)), false, "a project-scoped save never materializes machine lanes");
  const override = JSON.parse(readFileSync(join(stateDir, "projects", project.slug, "lanes.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(override, { lead: "claude/opus-4-8" });

  // No live Lead → skipped, named.
  const other = makeProject(t, "lanes-lead-other");
  const skipped = await handlers.lanesSet({ lane: "lead", value: "copilot/gpt-5.4", projectRoot: other.root });
  assert.ok(skipped.ok);
  assert.match(skipped.modelSync, /skipped — no live lead agent for project/);
  assert.equal(modelSyncs.length, 1);
});

test("snapshot: a projectRoot scopes lanes, seats, and tasks to the Project and lists discovered projects", async (t) => {
  const project = makeProject(t, "snap-a");
  const other = makeProject(t, "snap-b");
  const { stateDir, factory, handlers } = makeSurface(t, [
    { id: "agent-sup-1", labels: { seat: "supervisor", project: project.slug }, seqEnd: 41, cwd: project.root },
    { id: "agent-lead-1", labels: { seat: "lead", project: project.slug }, cwd: project.root },
    { id: "agent-other-sup", labels: { seat: "supervisor", project: other.slug }, cwd: other.root },
  ]);
  // A project override lane so the scoped snapshot proves the merge.
  writeLanes(stateDir, { worker: "copilot/gpt-5.4" });
  saveLanes(stateDir, { supervisor: "claude/opus-4-8" }, project.slug);
  // Two tasks: one contracted inside the project, one outside.
  seedGreenTask(factory, stateDir, "IN1", join(project.root, "pkg"));
  seedGreenTask(factory, stateDir, "OUT1", join(other.root, "pkg"));

  const snap = await handlers.snapshot({ projectRoot: project.root });
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  const view = snap.view;
  assert.equal(view.version, 3);
  assert.deepEqual(view.project, { slug: project.slug, root: project.root });
  assert.ok(view.projects.some((entry) => entry.slug === project.slug && entry.root === project.root), "the registry feeds the Project Selector");
  assert.equal(view.lanes.supervisor, "claude/opus-4-8", "the Project override lane wins");
  assert.equal(view.lanes.worker, "copilot/gpt-5.4", "the machine table fills the rest");
  assert.ok(view.supervisor !== null && view.supervisor.id === "agent-sup-1", "the Project's supervisor is the snapshot's supervisor");
  assert.ok(view.lead !== null && view.lead.id === "agent-lead-1", "the Project's Lead rides the snapshot");
  assert.equal(view.agents.some((agent) => agent.id === "agent-other-sup"), false, "other Projects' seats stay out");
  assert.deepEqual(view.tasks.map((task) => task.task), ["IN1"], "only in-Project tasks show");
  assert.equal(view.kpis.readyToAccept, 1);

  // Unscoped: the global view, every task and every seat.
  const global = await handlers.snapshot({});
  assert.ok(global.ok);
  assert.equal(global.view.project, null);
  assert.ok(global.view.supervisor !== null, "the global view still finds a supervisor");
  assert.deepEqual(global.view.tasks.map((task) => task.task).sort(), ["IN1", "OUT1"]);

  // An unresolvable scope degrades to the global view, never a failure.
  const outside = makeTempDir();
  disposeDir(t, outside);
  const degraded = await handlers.snapshot({ projectRoot: outside });
  assert.ok(degraded.ok);
  assert.equal(degraded.view.project, null, "a non-repo scope renders the global view");
});

// ---- the Lead telemetry join (v0.0.20, ADR 0013 §6, ticket 08) ------------------------------

test("snapshot: the Lead view carries the 128k telemetry — lastUsage tokens, project.json rotationState, and the mailbox fold's queued count; other seats leave all four unset", async (t) => {
  const project = makeProject(t, "lead-telemetry");
  const { stateDir, handlers } = makeSurface(t, [
    { id: "agent-sup-t", labels: { seat: "supervisor", project: project.slug }, cwd: project.root },
    {
      id: "agent-lead-t",
      labels: { seat: "lead", project: project.slug },
      cwd: project.root,
      lastUsage: { contextWindowUsedTokens: 94_400, contextWindowMaxTokens: 200_000 },
    },
  ]);
  writeProjectRegistration(stateDir, project.slug, { root: project.root, lead: "agent-lead-t", rotationState: "rotation_pending" });
  // The mailbox seed: three queued, one of them delivered — the count folds
  // the present (2 queued), never the history (3 events).
  const mailbox = join(stateDir, "projects", project.slug, "mailbox.jsonl");
  const first = enqueueLeadMail(mailbox, { from: "supervisor", kind: "directive", text: "Ship the roadmap." });
  enqueueLeadMail(mailbox, { from: "peer", kind: "verdict", task: "T1", text: "T1 is green." });
  enqueueLeadMail(mailbox, { from: "owner", kind: "directive", text: "One more." });
  deliverLeadMail(mailbox, { mailIds: [first.mailId], toAgentId: "agent-lead-t" });

  const snap = await handlers.snapshot({ projectRoot: project.root });
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  assert.ok(snap.view.lead !== null && snap.view.lead.id === "agent-lead-t", "the Project's Lead rides the snapshot");
  const lead = snap.view.lead!;
  assert.equal(lead.contextUsedTokens, 94_400, "the live lastUsage used-tokens ride the Lead view");
  assert.equal(lead.contextMaxTokens, 200_000, "the live lastUsage max-tokens ride the Lead view");
  assert.equal(lead.rotationState, "rotation_pending", "project.json's rotationState rides the Lead view");
  assert.equal(lead.queuedMailCount, 2, "the mailbox fold's queued count rides the Lead view — a delivered item no longer counts");

  // Non-Lead agents leave all four unset — the telemetry is the Lead's alone.
  assert.ok(snap.view.supervisor !== null && snap.view.supervisor.id === "agent-sup-t");
  const supervisor = snap.view.supervisor!;
  assert.equal(supervisor.contextUsedTokens, undefined, "a non-Lead seat leaves the token pair unset");
  assert.equal(supervisor.contextMaxTokens, undefined);
  assert.equal(supervisor.rotationState, undefined);
  assert.equal(supervisor.queuedMailCount, undefined);
  for (const agent of snap.view.agents) {
    if (agent.id === "agent-lead-t") continue;
    assert.equal(agent.contextUsedTokens, undefined, `agent ${agent.id} carries no Lead telemetry`);
    assert.equal(agent.contextMaxTokens, undefined);
    assert.equal(agent.rotationState, undefined);
    assert.equal(agent.queuedMailCount, undefined);
  }
});

test("snapshot: a Lead with no usage, no rotation on record, and no mailbox degrades honestly — null tokens, no rotationState, zero queued", async (t) => {
  const project = makeProject(t, "lead-telemetry-bare");
  const { handlers } = makeSurface(t, [
    // No lastUsage from the daemon, no project.json, no mailbox.jsonl on disk.
    { id: "agent-lead-bare", labels: { seat: "lead", project: project.slug }, cwd: project.root },
  ]);
  const snap = await handlers.snapshot({ projectRoot: project.root });
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  const lead = snap.view.lead!;
  assert.equal(lead.contextUsedTokens, null, "no lastUsage → null, never a fabricated number");
  assert.equal(lead.contextMaxTokens, null);
  assert.equal(lead.rotationState, undefined, "no rotationState on record → the key stays unset (absent reads as normal)");
  assert.equal(lead.queuedMailCount, 0, "no mailbox yet → zero queued, still a number the card can trust");
});

// ---- Ratify via Supervisor (v0.0.14, ADR 0010 §6) -------------------------------------------

test("ratify: dispatches the Retro proposal to the Project's Supervisor; unknown day/proposal are named refusals", async (t) => {
  const project = makeProject(t, "ratify");
  const { stateDir, factory, handlers, fake } = makeSurface(t, []);
  mkdirSync(stateDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const proposalsPath = join(stateDir, `retro-${day}.md`);
  writeFileSync(
    proposalsPath,
    [`# Retro ${day} — 1 proposal`, "", "## R1 — gate-check", "- Evidence (ledger seq): 1", "- Pattern: repeated X", "- Proposal: add a gate check for X.", ""].join("\n"),
  );
  factory.ledger.append({ event: "retro_written", model: "pi/zai/glm-5.3", outcome: "written", durationMs: 10, proposalsPath, proposalCount: 1 });

  const reply = await handlers.ratifyProposal({ projectRoot: project.root, day, proposalId: 1 });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.match(reply.summary, /R1 \(gate-check\) dispatched to the Supervisor of/);
  assert.equal(fake.created.length, 1, "the ratify ensured the Supervisor seat");
  assert.deepEqual(fake.created[0]!.labels, { seat: "supervisor", project: project.slug });
  assert.equal(fake.sent.length, 1);
  const sent = fake.sent[0]!;
  assert.match(sent.text, new RegExp(`ratified retro proposal R1 \\(gate-check\\) from ${day}`));
  assert.match(sent.text, /add a gate check for X\./, "the proposal text rides the dispatch verbatim");
  assert.match(sent.text, /AGENTS\.md or CONTEXT\.md/, "the dispatch names the two-tier memory targets");

  const noDay = await handlers.ratifyProposal({ projectRoot: project.root, day: "1999-01-01", proposalId: 1 });
  assert.ok(!noDay.ok);
  assert.equal(noDay.code, "unknown-retro");
  const noProposal = await handlers.ratifyProposal({ projectRoot: project.root, day, proposalId: 9 });
  assert.ok(!noProposal.ok);
  assert.equal(noProposal.code, "unknown-proposal");
});

// ---- the detail modal -----------------------------------------------------------------------

test("taskDetail: contract + per-attempt report and gate log contents, tailed", async (t) => {
  const { stateDir, factory, handlers } = makeSurface(t);
  const workspace = "/w/detail";
  seedGreenTask(factory, stateDir, "DET1", workspace);
  const reply = await handlers.taskDetail({ task: "DET1" });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.equal(reply.detail.contract.gate, "npm test");
  assert.deepEqual(reply.detail.contract.scope, ["src"]);
  assert.equal(reply.detail.contract.skills, null, "a contract without mandated skills renders null, never an empty list");
  assert.equal(reply.detail.contract.watch, false);
  assert.equal(reply.detail.contract.freshEyes, false);
  assert.equal(reply.detail.attempts.length, 1);
  assert.match(reply.detail.attempts[0]!.report!, /GREEN/);
  assert.match(reply.detail.attempts[0]!.gateLog!, /ok 5 tests/);

  const unknown = await handlers.taskDetail({ task: "NOPE" });
  assert.ok(!unknown.ok);
  assert.equal(unknown.code, "unknown-task");
});

test("taskDetail: the contract's mandated skills ride the detail (v0.0.14)", async (t) => {
  const { stateDir, factory, handlers } = makeSurface(t);
  factory.ledger.append({
    event: "contract_set", task: "DET2", workspace: "/w/skills", gate: "npm test", artifact: "src/x.ts",
    base: "base0001", skills: ["tdd", "diagnosing-bugs"],
  });
  const reply = await handlers.taskDetail({ task: "DET2" });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.deepEqual(reply.detail.contract.skills, ["tdd", "diagnosing-bugs"]);
});

test("retro proposals parse into R1..Rn for the Timeline tab", async (t) => {
  const { stateDir, factory, handlers } = makeSurface(t);
  mkdirSync(stateDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const proposalsPath = join(stateDir, `retro-${day}.md`);
  writeFileSync(
    proposalsPath,
    [
      `# Retro ${day} — 2 proposals`,
      "",
      "- Model: pi/zai/glm-5.3",
      "",
      "## R1 — gate-check",
      "- Evidence (ledger seq): 1",
      "- Pattern: repeated X",
      "- Proposal: add a gate check for X.",
      "",
      "## R2 — observation",
      "- Evidence (ledger seq): 2",
      "- Pattern: repeated Y",
      "- Proposal: watch Y.",
      "",
    ].join("\n"),
  );
  factory.ledger.append({ event: "retro_written", model: "pi/zai/glm-5.3", outcome: "written", durationMs: 10, proposalsPath, proposalCount: 2 });
  const snap = await handlers.snapshot({});
  assert.ok(snap.ok);
  const retro = snap.view.retro[0]!;
  assert.equal(retro.day, day);
  assert.deepEqual(
    retro.proposals.map((p) => [p.id, p.cls]),
    [[1, "gate-check"], [2, "observation"]],
    "the R-ids and classes parse for rendering",
  );
});

// ---- the role-contract layer (v0.0.14, ADR 0010 §1–§2/§6) ----------------------------------

/**
 * A fake operator home for the Pi harness-home seam (v0.0.16, ADR 0011): the
 * `<home>/.pi/agent` under it carries the operator's real-world contamination
 * — 21 interactive packages, a TUI extension, the `APPEND_SYSTEM.md`
 * auto-delegation rules, and an `mcp.json` with legacy `"auth": "oauth"`
 * strings — but seeded with defaults no real home could coincidentally match
 * (`fake-op`/`fake-model-9`/`fake-high`), so every assertion provably reads
 * this fake, never the real `~/.pi/agent`. `sessions/` is deliberately NOT
 * seeded: the provisioner's ensure must land inside this fake source.
 */
function makeFakeUserHome(t: TestContext): string {
  const home = makeTempDir("paseo-factory-fake-home-");
  disposeDir(t, home);
  const piAgent = join(home, ".pi", "agent");
  mkdirSync(join(piAgent, "extensions"), { recursive: true });
  writeFileSync(join(piAgent, "extensions", "cmux.ts"), "// tui extension\n");
  writeFileSync(join(piAgent, "APPEND_SYSTEM.md"), "# Auto-Delegation Rules\n");
  writeFileSync(join(piAgent, "SYSTEM.md"), "# global operator system\n");
  writeFileSync(join(piAgent, "auth.json"), '{"keys":{"zai":"sk-fake"}}');
  writeFileSync(join(piAgent, "models.json"), "{}");
  writeFileSync(
    join(piAgent, "settings.json"),
    JSON.stringify(
      {
        defaultProvider: "fake-op",
        defaultModel: "fake-model-9",
        defaultThinkingLevel: "fake-high",
        packages: [
          "npm:context-mode",
          "npm:pi-subagents",
          "npm:pi-powerline-footer",
          "npm:pi-mcp-adapter",
          "npm:pi-trees",
          "npm:pi-spell",
          "npm:pi-git-tools",
          ...Array.from({ length: 14 }, (_, i) => `npm:rpiv-${String(i + 1).padStart(2, "0")}`),
        ],
        quietStartup: false,
        defaultProjectTrust: "never",
        subagents: { oracle: { model: "fake-op/fake-model-8" } },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(piAgent, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          "legacy-http": { url: "https://x", auth: "oauth" },
          "stdio-ok": { command: "npx", args: ["-y", "mcp"] },
          "modern-oauth": { url: "https://y", auth: { provider: "anthropic" } },
        },
      },
      null,
      2,
    ),
  );
  return home;
}

/** The clean-room settings every session-bearing role home enforces (spec §Implementation Decisions 2). */
function cleanRoomSettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    defaultProvider: "fake-op",
    defaultModel: "fake-model-9",
    defaultThinkingLevel: "fake-high",
    packages: [],
    extensions: ["-builtin:llama.cpp"],
    quietStartup: true,
    defaultProjectTrust: "always",
    ...extra,
  };
}


/** A real git repo to seat projects in — resolveProject needs a worktree git answers for. */
function makeProject(t: TestContext, name: string): { root: string; slug: string } {
  const root = makeTempDir();
  disposeDir(t, root);
  writeFileSync(join(root, "README.md"), `# ${name}\n`);
  gitCommitAll(root, `seed ${name}`);
  const project = resolveProject(root);
  assert.ok(project.ok, project.ok ? "" : project.reason);
  return { root: project.root, slug: project.slug };
}

test("roles: the seat contracts carry the role law and the 1-line skill trigger index footer", () => {
  const supervisor = renderSeatContract("supervisor", { root: "/w/repo", slug: "repo-abc123" });
  assert.match(supervisor, /Supervisor seat of the paseo-factory/);
  assert.match(supervisor, /AGENTS\.md or CONTEXT\.md/);
  assert.match(supervisor, /paseo-factory role skills: grilling, domain-modeling$/);

  const lead = renderSeatContract("lead", { root: "/w/repo", slug: "repo-abc123" });
  assert.match(lead, /Lead seat of the paseo-factory/);
  assert.match(lead, /accept --by lead/);
  assert.match(lead, /paseo-factory role skills: codebase-design, domain-modeling, tdd$/);

  const agent = renderAgentContract("T1", "repo-abc123");
  assert.match(agent, /task T1, project repo-abc123/);
  assert.match(agent, /never modify AGENTS\.md, CLAUDE\.md, or CONTEXT\.md/);
  // The withholding boundary, stated honestly (US17 partial): the mechanical
  // guarantee that exists today is PATH + brief — the daemon exposes
  // paseoTools to every agent, so the contract must both name the mechanism
  // and forbid the visible surface.
  assert.match(agent, /withheld from you by PATH and by this brief/);
  assert.match(agent, /factory-claim and the git shim/);
  assert.match(agent, /paseoTools.*every agent/);
  assert.match(agent, /never call it/);
  assert.match(agent, /paseo-factory role skills: tdd, diagnosing-bugs, codebase-design$/);
});

test("roles: the seat bootstrap orients with resolved paths, day-one commands, and the footer", () => {
  const bootstrap = renderSeatBootstrap({
    seat: "supervisor",
    home: "/h/paseo-home",
    stateDir: "/h/plugin-state/paseo-factory",
    pluginDir: "/h/plugins/paseo-factory",
    nodePath: "/usr/local/bin/node",
    path: "/usr/local/bin",
    lane: "copilot/gpt-5.4",
    project: { root: "/w/repo", slug: "repo-abc123" },
  });
  assert.match(bootstrap, /Project root \(your cwd\): \/w\/repo/);
  assert.match(bootstrap, /\/h\/plugins\/paseo-factory\/bin\/factory\.mjs/);
  assert.match(bootstrap, /lead dispatch --workspace "<project-root>" --message "<directive>"/);
  assert.match(bootstrap, /lanes\.json → supervisor\): copilot\/gpt-5\.4/);
  assert.match(bootstrap, /never overwrite them/);
  assert.match(bootstrap, /paseo-factory role skills: grilling, domain-modeling$/);
});

test("roles: agent.create injection appends system prompts additively, idempotently, and leaves strangers alone", (t) => {
  const { stateDir } = makeSurface(t);
  const userHome = makeFakeUserHome(t);
  const project = makeProject(t, "seats");

  // A seat create: the role contract lands in systemPrompt, the env names the seat.
  const seatCreate: AgentCreateRequest = { config: { provider: "pi/zai/glm-5.3", cwd: project.root, title: "Supervisor (paseo-factory)" } };
  const seatRequest = injectRoleOnCreate(seatCreate, stateDir, userHome);
  assert.ok(seatRequest !== undefined, "a seat-titled create is injected");
  assert.match(seatRequest.config.systemPrompt!, /paseo-factory role skills: grilling, domain-modeling/);
  assert.match(seatRequest.config.systemPrompt!, /additive/);
  assert.equal(seatRequest.env?.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(seatRequest.env?.PASEO_FACTORY_PROJECT, project.slug);
  assert.equal(seatRequest.env?.PASEO_FACTORY_PROJECT_ROOT, project.root);
  assert.equal(seatRequest.env?.PASEO_FACTORY_STATE_DIR, stateDir);

  // An existing system prompt is APPENDED to, never replaced.
  const ownCreate: AgentCreateRequest = { config: { provider: "pi/zai/glm-5.3", cwd: project.root, title: "Lead (paseo-factory)", systemPrompt: "repo harness rules" } };
  const withOwn = injectRoleOnCreate(ownCreate, stateDir, userHome);
  assert.ok(withOwn !== undefined);
  assert.match(withOwn.config.systemPrompt!, /^repo harness rules/);
  assert.match(withOwn.config.systemPrompt!, /paseo-factory role skills: codebase-design, domain-modeling, tdd/);

  // Idempotent: a second pass over an injected request changes nothing.
  assert.equal(injectRoleOnCreate(seatRequest, stateDir, userHome), undefined);

  // A working agent in its managed task worktree gets the Agent contract.
  const worktree = join(stateDir, "projects", project.slug, "worktrees", "T1");
  const agentCreate: AgentCreateRequest = { config: { provider: "pi/zai/glm-5.3", cwd: worktree, title: "T1" } };
  const agentRequest = injectRoleOnCreate(agentCreate, stateDir, userHome);
  assert.ok(agentRequest !== undefined, "a managed-worktree create is injected");
  assert.match(agentRequest.config.systemPrompt!, /paseo-factory role skills: tdd, diagnosing-bugs, codebase-design/);
  assert.equal(agentRequest.env?.PASEO_FACTORY_TASK, "T1");
  assert.equal(agentRequest.env?.PASEO_FACTORY_SEAT, "agent");

  // A stranger in an unrelated directory passes through untouched.
  const strangerCreate: AgentCreateRequest = { config: { provider: "pi/zai/glm-5.3", cwd: "/tmp", title: "Notes" } };
  assert.equal(injectRoleOnCreate(strangerCreate, stateDir, userHome), undefined);
});

test("roles: session_open env re-carries the seat identity from the project registry on every launch", (t) => {
  const { stateDir } = makeSurface(t);
  const userHome = makeFakeUserHome(t);
  const project = makeProject(t, "env");
  writeProjectRegistration(stateDir, project.slug, { root: project.root, supervisor: "agent-sup-7", lead: "agent-lead-7" });

  const supervisorSession = injectSessionEnv({ agentId: "agent-sup-7", cwd: project.root, env: { PATH: "/bin" } } as { agentId: string; cwd: string; env: Record<string, string> }, stateDir, userHome);
  assert.ok(supervisorSession !== undefined);
  assert.equal(supervisorSession.env.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(supervisorSession.env.PASEO_FACTORY_PROJECT, project.slug);
  assert.equal(supervisorSession.env.PATH, "/bin", "the overlay is additive over the daemon's env");

  const worktree = join(stateDir, "projects", project.slug, "worktrees", "T2");
  const agentSession = injectSessionEnv({ agentId: "agent-worker-9", cwd: worktree, env: {} } as { agentId: string; cwd: string; env: Record<string, string> }, stateDir, userHome);
  assert.ok(agentSession !== undefined);
  assert.equal(agentSession.env.PASEO_FACTORY_TASK, "T2");
  assert.equal(agentSession.env.PASEO_FACTORY_SEAT, "agent");

  // An unregistered agent at the project root (a stranger) gets nothing.
  const strangerSession: { agentId: string; cwd: string; env: Record<string, string> } = { agentId: "agent-stranger", cwd: project.root, env: {} };
  assert.equal(injectSessionEnv(strangerSession, stateDir, userHome), undefined);
});

test("roles: factoryEnvFor provisions the role's Pi harness home on demand and carries PI_CODING_AGENT_DIR (v0.0.16, ADR 0011)", (t) => {
  const { stateDir } = makeSurface(t);
  const userHome = makeFakeUserHome(t);
  const project = makeProject(t, "pi-env");

  const env = factoryEnvFor("supervisor", { stateDir, project, userHome });
  assert.equal(env.PI_CODING_AGENT_DIR, join(stateDir, "pi-agent", "supervisor"));
  assert.equal(env.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(env.PASEO_FACTORY_PROJECT, project.slug);
  assert.equal(env.PASEO_FACTORY_STATE_DIR, stateDir);
  assert.equal(env.PASEO_FACTORY_PROJECT_ROOT, project.root);
  assert.ok(!("PASEO_FACTORY_TASK" in env), "no task, no PASEO_FACTORY_TASK");
  assert.ok(existsSync(join(stateDir, "pi-agent", "supervisor", "settings.json")), "the harness home is materialized on demand");
  assert.deepEqual(
    JSON.parse(readFileSync(join(stateDir, "pi-agent", "supervisor", "settings.json"), "utf8")),
    cleanRoomSettings(),
    "the generated settings come from the fake operator home — never the real one",
  );

  // The working agent's synthetic identity: no project root, its task rides along.
  const agentEnv = factoryEnvFor("agent", { stateDir, project: { root: "", slug: project.slug }, task: "T9", userHome });
  assert.equal(agentEnv.PI_CODING_AGENT_DIR, join(stateDir, "pi-agent", "agent"));
  assert.equal(agentEnv.PASEO_FACTORY_TASK, "T9");
  assert.ok(!("PASEO_FACTORY_PROJECT_ROOT" in agentEnv), "no known root, no PASEO_FACTORY_PROJECT_ROOT");
});

test("roles: agent.create injection launches every seat and working agent in its isolated Pi harness home (v0.0.16, ADR 0011)", (t) => {
  const { stateDir } = makeSurface(t);
  const userHome = makeFakeUserHome(t);
  const project = makeProject(t, "pi-seats");
  const source = join(userHome, ".pi", "agent");
  // The seed pins the operator-contamination scenario the spec names: 21 packages.
  assert.equal(JSON.parse(readFileSync(join(source, "settings.json"), "utf8")).packages.length, 21);

  // Every seat-titled create and every managed-worktree create carries its
  // role's isolated home as PI_CODING_AGENT_DIR.
  const supervisorCreate: AgentCreateRequest = { config: { provider: "pi/zai/glm-5.3", cwd: project.root, title: "Supervisor (paseo-factory)" } };
  const supervisorRequest = injectRoleOnCreate(supervisorCreate, stateDir, userHome);
  assert.ok(supervisorRequest !== undefined);
  assert.equal(supervisorRequest.env?.PI_CODING_AGENT_DIR, join(stateDir, "pi-agent", "supervisor"));

  const leadCreate: AgentCreateRequest = { config: { provider: "pi/zai/glm-5.3", cwd: project.root, title: "Lead (paseo-factory)" } };
  const leadRequest = injectRoleOnCreate(leadCreate, stateDir, userHome);
  assert.ok(leadRequest !== undefined);
  assert.equal(leadRequest.env?.PI_CODING_AGENT_DIR, join(stateDir, "pi-agent", "lead"));

  const worktree = join(stateDir, "projects", project.slug, "worktrees", "T5");
  const agentCreate: AgentCreateRequest = { config: { provider: "pi/zai/glm-5.3", cwd: worktree, title: "T5" } };
  const agentRequest = injectRoleOnCreate(agentCreate, stateDir, userHome);
  assert.ok(agentRequest !== undefined);
  assert.equal(agentRequest.env?.PI_CODING_AGENT_DIR, join(stateDir, "pi-agent", "agent"));

  // The materialized homes are clean rooms built from the FAKE operator home:
  // zero packages, the llama.cpp-only extension denylist, quiet startup,
  // always-trusted projects, and only the operator's model/thinking defaults.
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, "pi-agent", "supervisor", "settings.json"), "utf8")), cleanRoomSettings());
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, "pi-agent", "lead", "settings.json"), "utf8")), cleanRoomSettings());
  // Skills policy per role: supervisor and lead stay unfiltered (all of
  // ~/.agents/skills auto-discovers); only the working agent is filtered down
  // to its three core skills in Pi's `~` form.
  assert.ok(!("skills" in JSON.parse(readFileSync(join(stateDir, "pi-agent", "supervisor", "settings.json"), "utf8"))), "supervisor skills unfiltered");
  assert.ok(!("skills" in JSON.parse(readFileSync(join(stateDir, "pi-agent", "lead", "settings.json"), "utf8"))), "lead skills unfiltered");
  assert.deepEqual(
    JSON.parse(readFileSync(join(stateDir, "pi-agent", "agent", "settings.json"), "utf8")),
    cleanRoomSettings({ skills: ["!*", "+~/.agents/skills/tdd", "+~/.agents/skills/diagnosing-bugs", "+~/.agents/skills/codebase-design"] }),
  );
});

test("roles: session_open re-carries PI_CODING_AGENT_DIR and keeps the harness home a hermetic clean room (v0.0.16, ADR 0011)", (t) => {
  const { stateDir } = makeSurface(t);
  const userHome = makeFakeUserHome(t);
  const source = join(userHome, ".pi", "agent");
  const project = makeProject(t, "pi-sessions");
  writeProjectRegistration(stateDir, project.slug, { root: project.root, supervisor: "agent-sup-11", lead: "agent-lead-11" });

  // Every launch of a seat or working-agent shell re-carries its isolated home.
  const supervisorSession = injectSessionEnv({ agentId: "agent-sup-11", cwd: project.root, env: {} } as { agentId: string; cwd: string; env: Record<string, string> }, stateDir, userHome);
  assert.ok(supervisorSession !== undefined);
  assert.equal(supervisorSession.env.PI_CODING_AGENT_DIR, join(stateDir, "pi-agent", "supervisor"));

  const leadSession = injectSessionEnv({ agentId: "agent-lead-11", cwd: project.root, env: {} } as { agentId: string; cwd: string; env: Record<string, string> }, stateDir, userHome);
  assert.ok(leadSession !== undefined);
  assert.equal(leadSession.env.PI_CODING_AGENT_DIR, join(stateDir, "pi-agent", "lead"));

  const worktree = join(stateDir, "projects", project.slug, "worktrees", "T3");
  const agentSession = injectSessionEnv({ agentId: "agent-worker-3", cwd: worktree, env: {} } as { agentId: string; cwd: string; env: Record<string, string> }, stateDir, userHome);
  assert.ok(agentSession !== undefined);
  assert.equal(agentSession.env.PI_CODING_AGENT_DIR, join(stateDir, "pi-agent", "agent"));

  // The operator's prompt contamination never lands in a harness home; the
  // supervisor home's APPEND_SYSTEM.md is the MANAGED role contract
  // (v0.0.20, ADR 0013), never the operator's — and this fake home seeds no
  // prompts/ or skills/, so supervisor keeps both stripped here.
  const roleHome = join(stateDir, "pi-agent", "supervisor");
  for (const forbidden of ["SYSTEM.md", "extensions", "prompts", "skills"]) {
    assert.ok(!existsSync(join(roleHome, forbidden)), `${forbidden} never lands in the harness home`);
  }
  assert.ok(
    !readFileSync(join(roleHome, "APPEND_SYSTEM.md"), "utf8").includes("Auto-Delegation"),
    "the operator's APPEND_SYSTEM.md content never lands in the harness home",
  );
  // Shared state — auth, custom models, sessions — symlinks back to the FAKE
  // source home; the provisioner's sessions ensure landed inside that fake
  // only, never the real ~/.pi/agent (the seed deliberately omits sessions/).
  assert.ok(existsSync(join(source, "sessions")), "the sessions ensure landed inside the fake source home");
  for (const name of ["auth.json", "models.json", "sessions"]) {
    const link = join(roleHome, name);
    assert.ok(lstatSync(link).isSymbolicLink(), `${name} is a symlink`);
    assert.equal(realpathSync(link), realpathSync(join(source, name)), `${name} points at the fake source home`);
  }
  // The synchronized mcp.json strips legacy "auth": "oauth" strings while
  // preserving server definitions and valid object auth.
  const mcp = JSON.parse(readFileSync(join(roleHome, "mcp.json"), "utf8"));
  assert.deepEqual(mcp, {
    mcpServers: {
      "legacy-http": { url: "https://x" },
      "stdio-ok": { command: "npx", args: ["-y", "mcp"] },
      "modern-oauth": { url: "https://y", auth: { provider: "anthropic" } },
    },
  });
  // The source home itself keeps its legacy string — sanitization copies, never rewrites the operator.
  assert.equal(JSON.parse(readFileSync(join(source, "mcp.json"), "utf8")).mcpServers["legacy-http"].auth, "oauth");
});

test("projects: the registration records the slug→root binding and both seat ids, merged field-wise", (t) => {
  const { stateDir } = makeSurface(t);
  const project = makeProject(t, "registry");
  writeProjectRegistration(stateDir, project.slug, { root: project.root, supervisor: "agent-sup-1" });
  writeProjectRegistration(stateDir, project.slug, { root: project.root, lead: "agent-lead-1" });

  const registration = readProjectRegistration(stateDir, project.slug);
  assert.deepEqual(registration, { slug: project.slug, root: project.root, supervisor: "agent-sup-1", lead: "agent-lead-1" });

  // A rotate clears the lead id without clobbering the supervisor's.
  writeProjectRegistration(stateDir, project.slug, { root: project.root, lead: null });
  const afterRotate = readProjectRegistration(stateDir, project.slug);
  assert.equal(afterRotate?.lead, undefined);
  assert.equal(afterRotate?.supervisor, "agent-sup-1");

  // Discovery lists the registered project plus live seat agents it has never seated,
  // plus non-archived git projects from Paseo's <home>/projects/projects.json.
  const paseoProject = makeProject(t, "paseo-ui");
  const homeDir = makeTempDir();
  disposeDir(t, homeDir);
  mkdirSync(join(homeDir, "projects"), { recursive: true });
  writeFileSync(
    join(homeDir, "projects", "projects.json"),
    JSON.stringify([
      { projectId: "p1", rootPath: paseoProject.root, kind: "git", archivedAt: null },
      { projectId: "p2", rootPath: "/nonexistent/archived", kind: "git", archivedAt: "2026-01-01T00:00:00Z" },
    ]),
  );
  const discovered = discoverProjects(stateDir, [{ labels: { seat: "lead", project: "other-xyz789" }, cwd: "/w/other" }], homeDir);
  assert.deepEqual(
    discovered,
    [
      { slug: "other-xyz789", root: "/w/other" },
      { slug: paseoProject.slug, root: paseoProject.root },
      { slug: project.slug, root: project.root },
    ].sort((a, b) => a.slug.localeCompare(b.slug)),
    "registry files, live seat agents, and Paseo's projects.json all feed the Project Selector, slug order",
  );
});

// ---- the daemon plugin bridge (v0.0.17, ADR 0012 §2–§4) -----------------------------------

test("cliUtils: splits the search path on node:path's delimiter — a ';' Windows PATH resolves the CLI, ':' splitting does not", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  // The layout cliUtils expects: <entry>/paseo beside <entry>/../dist/utils/{client.js,daemon-target.js}.
  mkdirSync(join(dir, "win-entry"), { recursive: true });
  writeFileSync(join(dir, "win-entry", "paseo"), "#!/bin/sh\nexit 0\n");
  const utils = join(dir, "dist", "utils");
  mkdirSync(utils, { recursive: true });
  writeFileSync(join(utils, "client.js"), "");
  writeFileSync(join(utils, "daemon-target.js"), "");

  const windowsPath = [join(dir, "miss"), join(dir, "win-entry")].join(";");
  const found = cliUtils(windowsPath, ";");
  assert.ok(found !== null, "a ';'-separated PATH resolves the paseo CLI when split on ';'");
  assert.ok(existsSync(join(found, "client.js")), "the resolved utils carry the CLI's client.js");
  assert.equal(cliUtils(windowsPath, ":"), null, "splitting a ';' PATH on ':' sees one garbage entry — the pre-fix Windows bug");

  const posixPath = [join(dir, "miss"), join(dir, "win-entry")].join(delimiter);
  assert.ok(cliUtils(posixPath) !== null, "the platform delimiter stays the default");
});

// ---- the mock daemon — a hand-rolled RFC6455 server over the bridge's session protocol -------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Decodes complete client frames from a buffer — text payloads plus the unconsumed rest. */
function decodeWsFrames(buffer: Buffer): { texts: string[]; closed: boolean; rest: Buffer } {
  const texts: string[] = [];
  let closed = false;
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset]! & 0x0f;
    const masked = (buffer[offset + 1]! & 0x80) !== 0;
    let length = buffer[offset + 1]! & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskLength = masked ? 4 : 0;
    if (cursor + maskLength + length > buffer.length) break;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += maskLength;
    const payload = buffer.subarray(cursor, cursor + length);
    if (mask !== null) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]!;
    if (opcode === 0x1) texts.push(payload.toString("utf8"));
    if (opcode === 0x8) closed = true;
    offset = cursor + length;
  }
  return { texts, closed, rest: buffer.subarray(offset) };
}

/** Encodes one unmasked server text frame. */
function encodeWsText(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const frame = payload.length < 126 ? Buffer.allocUnsafe(2 + payload.length) : Buffer.allocUnsafe(4 + payload.length);
  frame[0] = 0x81;
  if (payload.length < 126) {
    frame[1] = payload.length;
    payload.copy(frame, 2);
  } else {
    frame[1] = 126;
    frame.writeUInt16BE(payload.length, 2);
    payload.copy(frame, 4);
  }
  return frame;
}

/** One session message the fake daemon received. */
interface FakeDaemonFrame {
  type: string;
  message: Record<string, unknown>;
}

/**
 * A fake Paseo daemon speaking the bridge's exact session protocol (hello →
 * server_info → session envelopes) over a hermetic temp home seeded with
 * `<home>/paseo.pid` + `<home>/local-credential`. No `ws` dependency is
 * installed, so this is a hand-rolled upgrade server — loopback only, never
 * the network. `reply` scripts each session message's answer; null stays
 * silent. Every received session message is recorded for wire assertions.
 */
async function startFakeDaemon(t: TestContext, reply: (message: Record<string, unknown>) => Record<string, unknown> | null) {
  const frames: FakeDaemonFrame[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      const decoded = decodeWsFrames(Buffer.concat([pending, chunk]));
      pending = decoded.rest;
      for (const text of decoded.texts) {
        const envelope = JSON.parse(text) as Record<string, unknown>;
        if (envelope.type === "hello") {
          socket.write(
            encodeWsText(
              JSON.stringify({
                type: "session",
                message: { type: "status", payload: { status: "server_info", features: { pluginSourceInstallation: true, pluginSourceUpdates: true } } },
              }),
            ),
          );
          continue;
        }
        if (envelope.type !== "session" || typeof envelope.message !== "object" || envelope.message === null) continue;
        const message = envelope.message as Record<string, unknown>;
        frames.push({ type: String(message.type), message });
        const answer = reply(message);
        if (answer !== null) socket.write(encodeWsText(JSON.stringify({ type: "session", message: answer })));
      }
      if (decoded.closed) {
        socket.write(Buffer.from([0x88, 0x00]));
        socket.end();
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake daemon did not get a port");
  const home = makeTempDir("paseo-factory-fake-daemon-");
  disposeDir(t, home);
  writeFileSync(join(home, "paseo.pid"), `${JSON.stringify({ listen: `127.0.0.1:${address.port}` })}\n`);
  writeFileSync(join(home, "local-credential"), "test-local-credential\n");
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { home, frames };
}

test("daemon plugin bridge: listDaemonPlugins speaks plugin.list.request over the session WebSocket and returns the payload", async (t) => {
  const daemon = await startFakeDaemon(t, (message) => {
    if (message.type === "plugin.list.request") {
      return {
        type: "plugin.list.response",
        payload: {
          requestId: message.requestId,
          plugins: [
            { id: "paseo-factory", path: "/plugins/paseo-factory", enabled: true, status: "running" },
            {
              id: "factory-burn-lab",
              path: "/plugins/factory-burn-lab",
              enabled: true,
              status: "running",
              installation: { identity: { kind: "git", remote: "https://github.com/daymanondev/factory-burn-lab", pluginPath: "plugin" }, currentRevision: "abc1234def5678" },
            },
          ],
        },
      };
    }
    return null;
  });

  const reply = await listDaemonPlugins(daemon.home);
  assert.ok(reply.ok, reply.ok ? "" : reply.reason);
  assert.deepEqual(
    reply.plugins.map((plugin) => [plugin.id, plugin.status]),
    [["paseo-factory", "running"], ["factory-burn-lab", "running"]],
    "the response payload's plugins array rides the reply — the payload-returning bridge",
  );
  assert.equal(reply.plugins[1]!.installation?.currentRevision, "abc1234def5678");
  assert.equal(daemon.frames.length, 1, "one session message — the bridge's own hello/status frames stay out");
  assert.equal(daemon.frames[0]!.type, "plugin.list.request");
  assert.equal(daemon.frames[0]!.message.requestId !== undefined, true, "the bridge stamps a requestId on the request");
  assert.deepEqual(Object.keys(daemon.frames[0]!.message).sort(), ["requestId", "type"], "the list request carries only type + requestId");
});

test("daemon plugin bridge: the payload timeouts stay pinned — 30s default, 300s for plugin install/update", () => {
  assert.equal(BRIDGE_TIMEOUT_MS, 30_000, "every non-install request keeps the 30s bridge default");
  assert.equal(PLUGIN_IO_TIMEOUT_MS, 300_000, "a remote Git clone/fetch never times out prematurely (spec §Implementation Decisions 4)");
});

// ---- the list cache (v0.0.20, ADR 0013 §1) — single-flight + 15s TTL over the fake daemon ----

/** The one-item list the cache proofs' fake daemon answers every `plugin.list.request` with. */
function fakeListReply(message: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "plugin.list.response",
    payload: {
      requestId: message.requestId,
      plugins: [{ id: "paseo-factory", path: "/plugins/paseo-factory", enabled: true, status: "running" }],
    },
  };
}

test("daemon plugin bridge: listDaemonPlugins single-flights concurrent calls and serves the 15s TTL from the cache", async (t) => {
  assert.equal(PLUGIN_LIST_TTL_MS, 15_000, "the list TTL stays pinned at 15s (spec §Implementation Decisions 1, paseo-factory bullet 1)");
  const daemon = await startFakeDaemon(t, (message) => (message.type === "plugin.list.request" ? fakeListReply(message) : null));

  const concurrent = await Promise.all([listDaemonPlugins(daemon.home), listDaemonPlugins(daemon.home), listDaemonPlugins(daemon.home)]);
  for (const reply of concurrent) {
    assert.ok(reply.ok, reply.ok ? "" : reply.reason);
    assert.deepEqual(reply.plugins.map((plugin) => plugin.id), ["paseo-factory"], "every concurrent caller rides the same payload");
  }
  const requests = (): number => daemon.frames.filter((frame) => frame.type === "plugin.list.request").length;
  assert.equal(requests(), 1, "concurrent callers share one WebSocket plugin.list.request — the inFlight map");

  const again = await listDaemonPlugins(daemon.home);
  assert.ok(again.ok, again.ok ? "" : again.reason);
  assert.deepEqual(again.plugins.map((plugin) => plugin.id), ["paseo-factory"]);
  assert.equal(requests(), 1, "a second call well inside the 15s TTL flies no new request");
});

test("daemon plugin bridge: only ok replies are cached — a failed list retries on the next call", async (t) => {
  const daemon = await startFakeDaemon(t, (message) => ({
    type: "rpc_error",
    payload: { requestId: message.requestId, error: "the daemon plugin list is busy" },
  }));

  for (let i = 0; i < 2; i++) {
    const reply = await listDaemonPlugins(daemon.home);
    assert.ok(!reply.ok, "the rpc_error answers ok:false both times");
    assert.equal(reply.reason, "the daemon plugin list is busy");
  }
  assert.equal(
    daemon.frames.filter((frame) => frame.type === "plugin.list.request").length,
    2,
    "a { ok: false } answer is never cached — the degrade law keeps retrying on the next snapshot",
  );
});

test("daemon plugin bridge: installDaemonPlugin and manageDaemonPlugin invalidate the home's list cache at entry", async (t) => {
  const daemon = await startFakeDaemon(t, (message) => {
    const type = String(message.type);
    if (type === "plugin.list.request") return fakeListReply(message);
    if (type === "plugin.directory.install.request") {
      return {
        type: "plugin.directory.install.response",
        payload: { requestId: message.requestId, plugin: { id: "factory-connector", path: "/plugins/factory-connector", enabled: true, status: "running" } },
      };
    }
    if (type === "plugin.disable.request") {
      return {
        type: "plugin.disable.response",
        payload: { requestId: message.requestId, plugin: { id: "paseo-factory", path: "/plugins/paseo-factory", enabled: false, status: "disabled" } },
      };
    }
    return null;
  });

  const first = await listDaemonPlugins(daemon.home);
  assert.ok(first.ok, first.ok ? "" : first.reason);
  const second = await listDaemonPlugins(daemon.home);
  assert.ok(second.ok, second.ok ? "" : second.reason);
  assert.equal(daemon.frames.filter((frame) => frame.type === "plugin.list.request").length, 1, "the second read rides the 15s TTL entry");

  const install = await installDaemonPlugin(daemon.home, { id: "factory-connector", source: "/tmp/custom-plugin" });
  assert.ok(install.ok, install.ok ? "" : install.reason);
  const afterInstall = await listDaemonPlugins(daemon.home);
  assert.ok(afterInstall.ok, afterInstall.ok ? "" : afterInstall.reason);
  assert.equal(
    daemon.frames.filter((frame) => frame.type === "plugin.list.request").length,
    2,
    "installDaemonPlugin drops the home's cache entry — the next list flies a fresh plugin.list.request",
  );

  const disable = await manageDaemonPlugin(daemon.home, "paseo-factory", "disable");
  assert.ok(disable.ok, disable.ok ? "" : disable.reason);
  const afterManage = await listDaemonPlugins(daemon.home);
  assert.ok(afterManage.ok, afterManage.ok ? "" : afterManage.reason);
  assert.equal(
    daemon.frames.filter((frame) => frame.type === "plugin.list.request").length,
    3,
    "manageDaemonPlugin drops the home's cache entry too — no reader ever sees a pre-mutation list",
  );
});

test("daemon plugin bridge: the list cache keys per home — a second daemon's home keeps its own entry", async (t) => {
  const daemonA = await startFakeDaemon(t, (message) => (message.type === "plugin.list.request" ? fakeListReply(message) : null));
  const daemonB = await startFakeDaemon(t, (message) => (message.type === "plugin.list.request" ? fakeListReply(message) : null));

  for (const daemon of [daemonA, daemonB]) {
    const first = await listDaemonPlugins(daemon.home);
    assert.ok(first.ok, first.ok ? "" : first.reason);
    const second = await listDaemonPlugins(daemon.home);
    assert.ok(second.ok, second.ok ? "" : second.reason);
  }
  assert.equal(
    daemonA.frames.filter((frame) => frame.type === "plugin.list.request").length,
    1,
    "home A's cache entry answers its second read without a new request",
  );
  assert.equal(
    daemonB.frames.filter((frame) => frame.type === "plugin.list.request").length,
    1,
    "home B never rides home A's entry — trial and production plugin state never cross-contaminate",
  );
});

/** A fake `paseo` CLI first on PATH — records every argv, answers fixed stdout (the CLI fallback seam). */
function fakePaseoCli(t: TestContext, stdout: string, opts: { code?: number; stderr?: string } = {}) {
  const binDir = makeTempDir("paseo-factory-fake-cli-");
  disposeDir(t, binDir);
  const argvLog = join(binDir, "argv.log");
  const script = [
    "#!/usr/bin/env node",
    `require("node:fs").appendFileSync(process.env.FAKE_PASEO_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `process.stdout.write(${JSON.stringify(stdout)});`,
    opts.stderr === undefined ? "" : `process.stderr.write(${JSON.stringify(opts.stderr)});`,
    `process.exitCode = ${opts.code ?? 0};`,
  ]
    .filter((line) => line !== "")
    .join("\n");
  writeFileSync(join(binDir, "paseo"), `${script}\n`);
  chmodSync(join(binDir, "paseo"), 0o755);
  const savedPath = process.env.PATH;
  const savedLog = process.env.FAKE_PASEO_LOG;
  process.env.PATH = `${binDir}${delimiter}${savedPath ?? ""}`;
  process.env.FAKE_PASEO_LOG = argvLog;
  t.after(() => {
    process.env.PATH = savedPath;
    if (savedLog === undefined) delete process.env.FAKE_PASEO_LOG;
    else process.env.FAKE_PASEO_LOG = savedLog;
  });
  const argvs = (): string[][] =>
    existsSync(argvLog)
      ? readFileSync(argvLog, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as string[])
      : [];
  return { argvs };
}

test("daemon plugin bridge: installDaemonPlugin routes a git source to plugin.source.install.request and returns the plugin", async (t) => {
  const daemon = await startFakeDaemon(t, (message) => {
    if (message.type === "plugin.source.install.request") {
      return {
        type: "plugin.source.install.response",
        payload: {
          requestId: message.requestId,
          plugin: {
            id: message.id,
            path: "/plugins/factory-burn-lab",
            enabled: true,
            status: "running",
            installation: { identity: { kind: "git", remote: "https://github.com/daymanondev/factory-burn-lab", pluginPath: "plugin" }, currentRevision: "abc1234def5678" },
          },
        },
      };
    }
    return null;
  });

  const reply = await installDaemonPlugin(daemon.home, { id: "factory-burn-lab", source: "git:daymanondev/factory-burn-lab:plugin" });
  assert.ok(reply.ok, reply.ok ? "" : reply.reason);
  assert.equal(reply.plugin.id, "factory-burn-lab");
  assert.equal(reply.plugin.status, "running");
  assert.equal(reply.plugin.installation?.identity.kind, "git");
  assert.equal(daemon.frames.length, 1);
  const frame = daemon.frames[0]!;
  assert.equal(frame.type, "plugin.source.install.request");
  assert.deepEqual(
    Object.keys(frame.message).sort(),
    ["id", "requestId", "source", "type"],
    "the canonical source ride as { source, id } — ref only when given, never a probed local sibling",
  );
  assert.equal(frame.message.source, "git:daymanondev/factory-burn-lab:plugin");
  assert.equal(frame.message.id, "factory-burn-lab");
});

test("daemon plugin bridge: installDaemonPlugin forwards a custom ref and classifies local paths as directory installs", async (t) => {
  const daemon = await startFakeDaemon(t, (message) => {
    if (String(message.type).endsWith(".request")) {
      const type = String(message.type).replace(".request", ".response");
      return {
        type,
        payload: {
          requestId: message.requestId,
          plugin: { id: message.id ?? message.pluginId, path: "/plugins/x", enabled: true, status: "running" },
        },
      };
    }
    return null;
  });

  const fork = await installDaemonPlugin(daemon.home, { id: "factory-connector", source: "git:myfork/factory-connector:plugin", ref: "feat/x" });
  assert.ok(fork.ok, fork.ok ? "" : fork.reason);
  assert.equal(daemon.frames[0]!.type, "plugin.source.install.request");
  assert.equal(daemon.frames[0]!.message.ref, "feat/x", "a custom branch/tag/commit ref forwards verbatim");

  // The spec's exact local-path arms: "/", ".", "~", and a Windows drive path.
  const localSources = ["/tmp/custom-plugin", "./checkouts/factory-connector", "~/plugins/factory-connector", "C:\\dev\\factory-connector"];
  for (const source of localSources) {
    const reply = await installDaemonPlugin(daemon.home, { id: "factory-connector", source });
    assert.ok(reply.ok, reply.ok ? "" : reply.reason);
  }
  const directoryFrames = daemon.frames.slice(1);
  assert.deepEqual(
    directoryFrames.map((frame) => frame.type),
    localSources.map(() => "plugin.directory.install.request"),
    "every explicit local path routes to the directory install request",
  );
  for (let i = 0; i < localSources.length; i++) {
    assert.deepEqual(
      Object.keys(directoryFrames[i]!.message).sort(),
      ["id", "path", "requestId", "type"],
      "the directory install carries { path, id } — the path stays literal (the daemon resolves ~)",
    );
    assert.equal(directoryFrames[i]!.message.path, localSources[i]);
    assert.equal(directoryFrames[i]!.message.id, "factory-connector");
  }
});

test("daemon plugin bridge: a daemon rpc_error surfaces as the named reason", async (t) => {
  const daemon = await startFakeDaemon(t, (message) => ({
    type: "rpc_error",
    payload: { requestId: message.requestId, error: "plugin source installs need a newer host" },
  }));

  const reply = await installDaemonPlugin(daemon.home, { id: "factory-burn-lab", source: "git:daymanondev/factory-burn-lab:plugin" });
  assert.ok(!reply.ok);
  assert.equal(reply.reason, "plugin source installs need a newer host");
});

test("daemon plugin bridge: with no paseo.pid the install falls back to the paseo CLI", async (t) => {
  const home = makeTempDir("paseo-factory-no-daemon-"); // no paseo.pid — the WebSocket bridge declines
  disposeDir(t, home);
  const cli = fakePaseoCli(t, `${JSON.stringify({ id: "factory-burn-lab", path: "/plugins/factory-burn-lab", enabled: true, status: "running" })}\n`);

  const reply = await installDaemonPlugin(home, { id: "factory-burn-lab", source: "git:daymanondev/factory-burn-lab:plugin", ref: "feat/x" });
  assert.ok(reply.ok, reply.ok ? "" : reply.reason);
  assert.equal(reply.plugin.id, "factory-burn-lab");
  assert.deepEqual(
    cli.argvs(),
    [["--home", home, "plugin", "install", "git:daymanondev/factory-burn-lab:plugin", "--id", "factory-burn-lab", "--ref", "feat/x", "--json"]],
    "the fallback spells 'paseo --home <home> plugin install <source> --id <id> [--ref <ref>] --json'",
  );

  const bare = await installDaemonPlugin(home, { id: "factory-connector", source: "git:daymanondev/factory-connector:plugin" });
  assert.ok(bare.ok, bare.ok ? "" : bare.reason);
  assert.deepEqual(
    cli.argvs()[1],
    ["--home", home, "plugin", "install", "git:daymanondev/factory-connector:plugin", "--id", "factory-connector", "--json"],
    "no --ref flag when no ref was given",
  );
});

test("daemon plugin bridge: a failing CLI fallback reports the CLI's first error line", async (t) => {
  const home = makeTempDir("paseo-factory-no-daemon-");
  disposeDir(t, home);
  const cli = fakePaseoCli(t, "", { code: 1, stderr: "Error: no such source: git:nope/x:plugin\nsecond line\n" });

  const reply = await installDaemonPlugin(home, { id: "factory-burn-lab", source: "git:nope/x:plugin" });
  assert.ok(!reply.ok);
  assert.equal(reply.reason, "Error: no such source: git:nope/x:plugin");
  assert.equal(cli.argvs().length, 1);
});

test("daemon plugin bridge: manageDaemonPlugin dispatches enable, disable, reload, remove, and update", async (t) => {
  const daemon = await startFakeDaemon(t, (message) => {
    const type = String(message.type);
    if (type === "plugin.source.update.request") {
      return {
        type: "plugin.source.update.response",
        payload: {
          requestId: message.requestId,
          plugins: [
            { id: "factory-burn-lab", previousCommit: "abc1234", currentCommit: "def5678", commits: 3, updated: true },
            { id: "some-other-plugin", updated: false },
          ],
        },
      };
    }
    if (type.endsWith(".request")) {
      const responseType = type.replace(".request", ".response");
      return {
        type: responseType,
        // remove responses carry requestId only (no plugin payload); the rest carry the plugin item
        payload: {
          requestId: message.requestId,
          ...(responseType === "plugin.remove.response"
            ? {}
            : { plugin: { id: message.pluginId, path: "/plugins/x", enabled: responseType === "plugin.enable.response", status: "running" } }),
        },
      };
    }
    return null;
  });

  const enable = await manageDaemonPlugin(daemon.home, "factory-burn-lab", "enable");
  assert.ok(enable.ok, enable.ok ? "" : enable.reason);
  assert.equal(enable.plugin?.id, "factory-burn-lab");
  assert.equal(enable.plugin?.enabled, true);
  const disable = await manageDaemonPlugin(daemon.home, "factory-burn-lab", "disable");
  assert.ok(disable.ok, disable.ok ? "" : disable.reason);
  const reload = await manageDaemonPlugin(daemon.home, "factory-burn-lab", "reload");
  assert.ok(reload.ok, reload.ok ? "" : reload.reason);
  const remove = await manageDaemonPlugin(daemon.home, "factory-burn-lab", "remove");
  // A remove's success is the frame arriving — the response carries no plugin payload.
  assert.ok(remove.ok, remove.ok ? "" : remove.reason);
  const update = await manageDaemonPlugin(daemon.home, "factory-burn-lab", "update");
  assert.ok(update.ok, update.ok ? "" : update.reason);
  assert.equal(update.update?.currentCommit, "def5678", "the update answer is the row matching the pluginId — the payload is an array");
  assert.equal(update.update?.updated, true);

  assert.deepEqual(
    daemon.frames.map((frame) => frame.type),
    ["plugin.enable.request", "plugin.disable.request", "plugin.reload.request", "plugin.remove.request", "plugin.source.update.request"],
  );
  for (const frame of daemon.frames) {
    assert.deepEqual(Object.keys(frame.message).sort(), ["pluginId", "requestId", "type"]);
    assert.equal(frame.message.pluginId, "factory-burn-lab", "every manage request names its plugin — an update without pluginId would update every plugin");
  }
});

test("daemon plugin bridge: with no paseo.pid the list falls back to the paseo CLI", async (t) => {
  const home = makeTempDir("paseo-factory-no-daemon-");
  disposeDir(t, home);
  const cli = fakePaseoCli(t, `${JSON.stringify([{ id: "paseo-factory", path: "/plugins/paseo-factory", enabled: true, status: "running" }])}\n`);

  const reply = await listDaemonPlugins(home);
  assert.ok(reply.ok, reply.ok ? "" : reply.reason);
  assert.deepEqual(
    reply.plugins.map((plugin) => [plugin.id, plugin.status]),
    [["paseo-factory", "running"]],
  );
  assert.deepEqual(cli.argvs(), [["--home", home, "plugin", "ls", "--json"]], "the fallback spells 'paseo --home <home> plugin ls --json'");
});

test("daemon plugin bridge: with no paseo.pid the manage actions fall back to the paseo CLI", async (t) => {
  const home = makeTempDir("paseo-factory-no-daemon-");
  disposeDir(t, home);
  const cli = fakePaseoCli(t, `${JSON.stringify({ plugins: [] })}\n`);

  const enable = await manageDaemonPlugin(home, "factory-burn-lab", "enable");
  assert.ok(enable.ok, enable.ok ? "" : enable.reason);
  const update = await manageDaemonPlugin(home, "factory-burn-lab", "update");
  assert.ok(update.ok, update.ok ? "" : update.reason);
  assert.deepEqual(cli.argvs(), [
    ["--home", home, "plugin", "enable", "factory-burn-lab", "--json"],
    ["--home", home, "plugin", "update", "factory-burn-lab", "--yes", "--json"],
  ]);
});

// ---- the companion lifecycle handlers (v0.0.17, ADR 0012 §3) --------------------------------

test("pluginsInstall: a named target installs from the catalog's canonical source — never a probed sibling path", async (t) => {
  const { handlers, home, pluginInstalls } = makeSurface(t);
  const reply = await handlers.pluginsInstall({ target: "factory-burn-lab" });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.deepEqual(reply.installed, ["factory-burn-lab"]);
  assert.equal(reply.summary, "installed factory-burn-lab from git:daymanondev/factory-burn-lab:plugin");
  assert.deepEqual(
    pluginInstalls,
    [{ home, input: { id: "factory-burn-lab", source: "git:daymanondev/factory-burn-lab:plugin" } }],
    "the install rides the canonical GitHub source (spec §User Story 4) — no ../factory-burn-lab probing, no ref when none was given",
  );
});

test("pluginsInstall: target all installs only the uninstalled companions, skipping installed ones", async (t) => {
  const { handlers, pluginInstalls } = makeSurface(t, [], [
    { id: "paseo-factory", path: "/plugins/paseo-factory", enabled: true, status: "running" },
    {
      id: "factory-burn-lab",
      path: "/plugins/factory-burn-lab",
      enabled: true,
      status: "running",
      installation: { identity: { kind: "git", remote: "https://github.com/daymanondev/factory-burn-lab", pluginPath: "plugin" } },
    },
  ]);
  const reply = await handlers.pluginsInstall({ target: "all" });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.deepEqual(reply.installed, ["factory-connector", "factory-release-lab"], "only the uninstalled companions install (spec §User Story 5)");
  assert.deepEqual(
    pluginInstalls.map((call) => call.input),
    [
      { id: "factory-connector", source: "git:daymanondev/factory-connector:plugin" },
      { id: "factory-release-lab", source: "git:daymanondev/factory-release-lab:plugin" },
    ],
    "the already-installed burn lab is skipped, the rest install from canonical sources",
  );

  // Nothing left to install → ok with an empty installed list.
  const again = await handlers.pluginsInstall({ target: "all" });
  assert.ok(again.ok, again.ok ? "" : again.error);
  assert.deepEqual(again.installed, []);
  assert.equal(again.summary, "every companion is already installed — nothing to do");
  assert.deepEqual(
    pluginInstalls.map((call) => call.input),
    [
      { id: "factory-connector", source: "git:daymanondev/factory-connector:plugin" },
      { id: "factory-release-lab", source: "git:daymanondev/factory-release-lab:plugin" },
    ],
    "the second batch dispatches nothing",
  );
});

test("pluginsInstall: target all with nothing installed installs every companion in catalog order", async (t) => {
  const { handlers, pluginInstalls } = makeSurface(t);
  const reply = await handlers.pluginsInstall({ target: "all" });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.deepEqual(reply.installed, ["factory-burn-lab", "factory-connector", "factory-release-lab"]);
  assert.deepEqual(
    pluginInstalls.map((call) => [call.input.id, call.input.source]),
    [
      ["factory-burn-lab", "git:daymanondev/factory-burn-lab:plugin"],
      ["factory-connector", "git:daymanondev/factory-connector:plugin"],
      ["factory-release-lab", "git:daymanondev/factory-release-lab:plugin"],
    ],
    "catalog order, canonical sources",
  );
});

test("pluginsInstall: a custom source and ref forward verbatim to the bridge", async (t) => {
  const { handlers, pluginInstalls } = makeSurface(t);
  const reply = await handlers.pluginsInstall({ target: "factory-connector", source: "git:myfork/factory-connector:plugin", ref: "feat/x" });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.deepEqual(reply.installed, ["factory-connector"]);
  assert.equal(reply.summary, "installed factory-connector from git:myfork/factory-connector:plugin at ref feat/x");
  assert.deepEqual(
    pluginInstalls.map((call) => call.input),
    [{ id: "factory-connector", source: "git:myfork/factory-connector:plugin", ref: "feat/x" }],
    "the custom Git URL/branch forwards untouched (spec §User Story 7) — the bridge's local-path routing does the rest",
  );
});

test("pluginsInstall: a custom source with target all refuses — one custom source cannot name every companion", async (t) => {
  const { handlers, pluginInstalls } = makeSurface(t);
  const reply = await handlers.pluginsInstall({ target: "all", source: "git:myfork/factory-connector:plugin" });
  assert.ok(!reply.ok);
  assert.equal(reply.code, "invalid-target");
  assert.deepEqual(pluginInstalls, [], "nothing dispatches");
});

test("pluginsInstall: a daemon failure refuses as data — { ok: false, code: 'daemon_failed', error }", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const retroRunner = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: retroRunner.runner });
  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon: fakeDaemon([]).daemon,
    installPlugin: async () => ({ ok: false, reason: "clone failed: repository not found" }),
  });
  const reply = await handlers.pluginsInstall({ target: "factory-burn-lab" });
  assert.ok(!reply.ok);
  assert.equal(reply.code, "daemon_failed");
  assert.equal(reply.error, "clone failed: repository not found");
});

test("pluginsManage: dispatches enable, disable, reload, update, and remove over the bridge", async (t) => {
  const { handlers, home, pluginManages } = makeSurface(t);
  const actions = ["enable", "disable", "reload", "update", "remove"] as const;
  const expected: { home: string; pluginId: string; action: string }[] = [];
  // Every catalog companion rides the same five acts — burn lab and the
  // release lab (v0.0.21, ADR 0014 §1) alike.
  for (const pluginId of ["factory-burn-lab", "factory-release-lab"] as const) {
    for (const action of actions) {
      const reply = await handlers.pluginsManage({ pluginId, action });
      assert.ok(reply.ok, `${pluginId} ${action}: ${reply.ok ? "" : reply.error}`);
      assert.equal(reply.pluginId, pluginId);
      assert.equal(reply.action, action);
      assert.ok(reply.summary.length > 0, "each action answers a one-sentence summary");
      expected.push({ home, pluginId, action });
    }
  }
  assert.deepEqual(
    pluginManages,
    expected,
    "the five lifecycle acts ride the bridge against strictly the surface's home",
  );
});

test("pluginsManage: a daemon error refuses as data — { ok: false, code: 'daemon_failed', error }", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const retroRunner = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: retroRunner.runner });
  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon: fakeDaemon([]).daemon,
    managePlugin: async () => ({ ok: false, reason: "plugin factory-burn-lab is not installed" }),
  });
  const reply = await handlers.pluginsManage({ pluginId: "factory-burn-lab", action: "enable" });
  assert.ok(!reply.ok);
  assert.equal(reply.code, "daemon_failed");
  assert.equal(reply.error, "plugin factory-burn-lab is not installed");
});

test("companion lifecycle over the wire: the handlers bind the daemon bridge by default — list, directory install, and enable speak the exact frames", async (t) => {
  const daemon = await startFakeDaemon(t, (message) => {
    if (message.type === "plugin.list.request") {
      return {
        type: "plugin.list.response",
        payload: {
          requestId: message.requestId,
          plugins: [
            {
              id: "factory-burn-lab",
              path: "/plugins/factory-burn-lab",
              enabled: true,
              status: "running",
              installation: { identity: { kind: "git", remote: "https://github.com/daymanondev/factory-burn-lab", pluginPath: "plugin" }, currentRevision: "abc1234def5678" },
            },
          ],
        },
      };
    }
    if (String(message.type).endsWith(".request")) {
      const type = String(message.type).replace(".request", ".response");
      return {
        type,
        payload: {
          requestId: message.requestId,
          ...(type === "plugin.remove.response"
            ? {}
            : type === "plugin.directory.install.response"
              ? { plugin: { id: message.id, path: "/plugins/factory-connector", enabled: true, status: "running" } }
              : { plugin: { id: message.pluginId, path: "/plugins/factory-burn-lab", enabled: true, status: "running" } }),
        },
      };
    }
    return null;
  });
  // Handlers over the fake daemon's home with NO plugin overrides — the real
  // bridge (paseo.pid + local-credential in the temp home) is the default.
  const stateDir = join(daemon.home, "plugin-state", "paseo-factory");
  const retroRunner = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: retroRunner.runner });
  const handlers = createSurfaceHandlers({ factory, stateDir, home: daemon.home, daemon: fakeDaemon([]).daemon });

  const snap = await handlers.snapshot({});
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  assert.equal(snap.view.companions.find((companion) => companion.id === "factory-burn-lab")!.status, "running", "the live fold rides the wire answer");
  assert.equal(snap.view.companions.find((companion) => companion.id === "factory-connector")!.status, "not_installed");

  const install = await handlers.pluginsInstall({ target: "factory-connector", source: "/tmp/custom-plugin" });
  assert.ok(install.ok, install.ok ? "" : install.error);
  assert.deepEqual(install.installed, ["factory-connector"]);

  const enable = await handlers.pluginsManage({ pluginId: "factory-burn-lab", action: "enable" });
  assert.ok(enable.ok, enable.ok ? "" : enable.error);

  assert.deepEqual(
    daemon.frames.map((frame) => frame.type),
    ["plugin.list.request", "plugin.directory.install.request", "plugin.enable.request"],
    "the exact wire order: the snapshot's list, the local-path directory install, the manage act",
  );
  const directory = daemon.frames[1]!;
  assert.equal(directory.message.path, "/tmp/custom-plugin", "an explicit local path routes to plugin.directory.install.request (ticket-02's classification)");
  assert.equal(directory.message.id, "factory-connector");
});

test("surface deps: the plugin bridge overrides ride createSurfaceHandlers like the seat bridges", async (t) => {
  const pluginCalls: string[] = [];
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const retroRunner = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: retroRunner.runner });
  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon: fakeDaemon([]).daemon,
    listPlugins: async () => {
      pluginCalls.push("list");
      return { ok: true, plugins: [] };
    },
    installPlugin: async () => {
      pluginCalls.push("install");
      return { ok: true, plugin: { id: "factory-burn-lab", path: "/plugins/factory-burn-lab", enabled: true, status: "running" } };
    },
    managePlugin: async () => {
      pluginCalls.push("manage");
      return { ok: true };
    },
  });

  const snap = await handlers.snapshot({});
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  assert.deepEqual(pluginCalls, ["list"], "the snapshot's live companions fold fires the list override");

  // The real bridge functions satisfy the override slots — the defaults the handlers ticket will bind.
  const defaults: Partial<SurfaceDeps> = { listPlugins: listDaemonPlugins, installPlugin: installDaemonPlugin, managePlugin: manageDaemonPlugin };
  assert.equal(typeof defaults.listPlugins, "function");
  assert.equal(typeof defaults.installPlugin, "function");
  assert.equal(typeof defaults.managePlugin, "function");
});

// ---- the Private vault surface (v0.0.21, ADR 0014 §4) ----------------------------------------
//
// The four factory.vault.* handlers run end-to-end through createSurfaceHandlers
// against the real vendored core (plugin/server/core/vault.ts) on the seam's own
// temp home, with an injected fake `VaultRunner` answering every external CLI
// call from in-memory fixtures — zero network, zero prompts, `~/.paseo` never
// touched (spec §Testing Decisions 2).

/** Runs `run` with FACTORY_VAULT_PASSPHRASE pinned (deleted when undefined), restoring after — the hasPassphrase chain's third leg must not leak from the dev shell. */
function withVaultPassphrase<T>(value: string | undefined, run: () => T): T {
  const prior = process.env.FACTORY_VAULT_PASSPHRASE;
  if (value === undefined) delete process.env.FACTORY_VAULT_PASSPHRASE;
  else process.env.FACTORY_VAULT_PASSPHRASE = value;
  try {
    return run();
  } finally {
    if (prior === undefined) delete process.env.FACTORY_VAULT_PASSPHRASE;
    else process.env.FACTORY_VAULT_PASSPHRASE = prior;
  }
}

/** One ustar header with a real checksum — the minimal archive the core's in-memory tar parser walks. */
function vaultTarHeader(name: string, size: number, typeflag: "0" | "5"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "latin1");
  header.write(typeflag, 156, 1, "latin1");
  header.write("ustar", 257, 5, "latin1");
  header.write("00", 263, 2, "latin1");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

/** A GitHub-shaped gzipped tarball: one top-level `<owner>-<repo>-<sha>/` prefix over the vault files. */
function buildVaultTarball(entries: Array<{ path: string; data: Buffer | string }>, topDir = "acme-factory-vault-abc1234"): Buffer {
  const file = (name: string, data: Buffer): Buffer => {
    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    return Buffer.concat([vaultTarHeader(name, data.length, "0"), data, padding]);
  };
  const parts: Buffer[] = [vaultTarHeader(`${topDir}/`, 0, "5")];
  for (const entry of entries) {
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const dir = dirname(entry.path);
    if (dir !== "." && dir !== topDir) parts.push(vaultTarHeader(`${dir}/`, 0, "5"));
    parts.push(file(entry.path, data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** An in-memory `VaultRunner` answering every call through `answer` — zero network, calls recorded. */
function fakeVaultRunner(answer: (call: VaultRunnerCall) => Buffer): { runner: VaultRunner; calls: VaultRunnerCall[] } {
  const calls: VaultRunnerCall[] = [];
  return {
    calls,
    runner: async (call) => {
      calls.push(call);
      return answer(call);
    },
  };
}

test("vault snapshot: view.vault rides the factory view — a fresh home's honest defaults, alongside all 3 companions", async (t) => {
  const { handlers } = makeSurface(t);
  const snap = await withVaultPassphrase(undefined, () => handlers.snapshot({}));
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  // The snapshot carries the vault half beside the companion half — one view, both surfaces (spec §Testing Decisions 2).
  assert.deepEqual(
    snap.view.companions.map((companion) => companion.id),
    ["factory-burn-lab", "factory-connector", "factory-release-lab"],
  );
  const vault = snap.view.vault;
  assert.equal(vault.configured, false, "no vault-config.json yet — the card says so, never guesses");
  assert.equal(vault.repo, null);
  assert.equal(vault.branch, "main", "the default branch renders before any save");
  assert.ok(typeof vault.nodeId === "string" && vault.nodeId.length > 0, "the hostname-derived nodeId renders");
  assert.ok(/^[a-z0-9-]+$/.test(vault.nodeId), "the nodeId is a legal [a-z0-9-] segment");
  assert.equal(vault.hasPassphrase, false);
  assert.equal(vault.cloneExists, false, "no <home>/vault/.git on a fresh home");
  assert.equal(vault.lastHydratedAt, null);
  assert.equal(vault.lastHydrateMode, null);
  assert.equal(vault.lastPushedAt, null);
  assert.deepEqual(vault.sharedSecrets, { ascKey: false, ascCredentials: false, gplayServiceAccount: false, eyeConfig: false });
  assert.deepEqual(vault.hydratedApps, []);
  assert.equal(vault.error, null);
});

test("vault.configure: persists repo/branch/passphrase to vault-config.json 0o600 and returns the updated view", async (t) => {
  const { handlers, stateDir } = makeSurface(t);
  const reply = await withVaultPassphrase(undefined, () => handlers.vaultConfigure({ repo: "acme/factory-vault", branch: "release", passphrase: "correct-horse" }));
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.equal(reply.vault.configured, true);
  assert.equal(reply.vault.repo, "acme/factory-vault");
  assert.equal(reply.vault.branch, "release");
  assert.equal(reply.vault.hasPassphrase, true, "the persisted passphrase satisfies the status read's chain");
  assert.match(reply.summary, /acme\/factory-vault/, "vaultConfigure returns a human-readable summary");

  // The spec's exact persistence law (§Implementation Decisions 4): repo/branch/passphrase
  // land in <stateDir>/vault-config.json with 0o600 permissions.
  const configPath = join(stateDir, "vault-config.json");
  const saved = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(saved.repo, "acme/factory-vault");
  assert.equal(saved.branch, "release");
  assert.equal(saved.passphrase, "correct-horse");
  assert.equal(lstatSync(configPath).mode & 0o777, 0o600, "the persisted config is owner-only");

  // The next snapshot gathers the same configured vault — one view, both halves.
  const snap = await handlers.snapshot({});
  assert.ok(snap.ok);
  assert.equal(snap.view.vault.configured, true);
  assert.equal(snap.view.vault.repo, "acme/factory-vault");

  // The passphrase tri-state: absent preserves the prior value, empty clears it.
  const preserved = await handlers.vaultConfigure({ repo: "acme/factory-vault", branch: "main" });
  assert.ok(preserved.ok, preserved.ok ? "" : preserved.error);
  assert.equal(preserved.vault.hasPassphrase, true, "a save with no passphrase field keeps the persisted one");
  assert.equal(preserved.vault.branch, "main");
  const cleared = await handlers.vaultConfigure({ repo: "acme/factory-vault", branch: "main", passphrase: "" });
  assert.ok(cleared.ok, cleared.ok ? "" : cleared.error);
  assert.equal(cleared.vault.hasPassphrase, false, "an explicit empty passphrase clears the persisted one");

  // A blank repo refuses as data, never an exception.
  const blank = await handlers.vaultConfigure({ repo: "   ", branch: "main" });
  assert.ok(!blank.ok);
  assert.equal(blank.code, "vault-invalid-repo");
});

test("vault.configure: a damaged vault-config.json refuses as data with the core's own code", async (t) => {
  const { handlers, stateDir } = makeSurface(t);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "vault-config.json"), "{not json");
  const reply = await handlers.vaultConfigure({ repo: "acme/factory-vault", branch: "main" });
  assert.ok(!reply.ok);
  assert.equal(reply.code, "corrupted-vault-config", "the core's refusal rides the Failure union, never a throw");
});

test("vault.hydrate: zero-clone Direct hydrate end-to-end through the handlers — unsealed runtime, direct stamp, no vault/.git", async (t) => {
  const p8 = "-----BEGIN PRIVATE KEY-----\nfixture asc api key\n-----END PRIVATE KEY-----\n";
  const gplayPlain = '{"client_email":"svc@fixture.iam.gserviceaccount.com"}';
  const eyePlain = '{\n  "provider": "eye"\n}\n';
  const tarball = buildVaultTarball([
    { path: "acme-factory-vault-abc1234/secrets/shared/asc-api-key.p8", data: p8 },
    { path: "acme-factory-vault-abc1234/secrets/shared/gplay-service-account.json", data: JSON.stringify(sealVaultBuffer(Buffer.from(gplayPlain, "utf8"))) },
    { path: "acme-factory-vault-abc1234/secrets/shared/eye.json", data: JSON.stringify(sealVaultBuffer(Buffer.from(eyePlain, "utf8"), "correct-horse")) },
  ]);
  const { runner, calls } = fakeVaultRunner(() => tarball);
  const { handlers, home } = makeSurface(t, [], [], runner);

  // User Story 1's path: configure once, then one click — the persisted repo and passphrase drive the stream.
  const configured = await handlers.vaultConfigure({ repo: "acme/factory-vault", branch: "main", passphrase: "correct-horse" });
  assert.ok(configured.ok, configured.ok ? "" : configured.error);
  const reply = await withVaultPassphrase(undefined, () => handlers.vaultHydrate({}));
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.match(reply.summary, /3/, "vaultHydrate returns a human-readable summary naming the hydrated count");
  assert.deepEqual(reply.hydratedFiles, [
    "secrets/shared/asc-api-key.p8",
    "secrets/shared/eye.json",
    "secrets/shared/gplay-service-account.json",
  ]);
  assert.equal(calls.length, 1, "exactly one gh api call — the zero-clone stream");
  assert.equal(calls[0]!.command, "gh");
  assert.deepEqual(calls[0]!.args, ["api", "repos/acme/factory-vault/tarball/main"]);

  // The runtime tree is unsealed on disk: plaintext verbatim, the obfuscated
  // envelope zero-passphrase, the locked envelope with the persisted passphrase.
  const runtime = join(home, "vault-runtime");
  assert.equal(readFileSync(join(runtime, "secrets/shared/asc-api-key.p8"), "utf8"), p8);
  assert.equal(readFileSync(join(runtime, "secrets/shared/gplay-service-account.json"), "utf8"), gplayPlain);
  assert.equal(readFileSync(join(runtime, "secrets/shared/eye.json"), "utf8"), eyePlain);
  assert.equal(lstatSync(join(runtime, "secrets/shared/asc-api-key.p8")).mode & 0o777, 0o600, "hydrated secrets are owner-only");

  // The refreshed view reports the hydrated half: pills lit, direct mode stamped.
  assert.equal(reply.vault.configured, true);
  assert.equal(reply.vault.lastHydrateMode, "direct");
  assert.ok(reply.vault.lastHydratedAt !== null);
  assert.deepEqual(reply.vault.sharedSecrets, { ascKey: true, ascCredentials: false, gplayServiceAccount: true, eyeConfig: true });
  assert.equal(reply.vault.cloneExists, false, "Direct hydrate leaves no cached checkout — no <home>/vault/.git");
  assert.equal(existsSync(join(home, "vault")), false);
});

test("vault.hydrate: refusals are data — unconfigured, a non-GitHub repo, and a failing runner never throw", async (t) => {
  const unconfigured = makeSurface(t);
  const none = await unconfigured.handlers.vaultHydrate({});
  assert.ok(!none.ok);
  assert.equal(none.code, "vault-not-configured");

  const notGithub = makeSurface(t, [], [], fakeVaultRunner(() => Buffer.alloc(0)).runner);
  const bad = await notGithub.handlers.vaultHydrate({ repo: "not a slug" });
  assert.ok(!bad.ok);
  assert.equal(bad.code, "vault-repo-not-github");

  const failing = makeSurface(t, [], [], async () => {
    throw new Error("gh: rate limit exceeded");
  });
  const settled = await failing.handlers.vaultHydrate({ repo: "acme/factory-vault" });
  assert.ok(!settled.ok);
  assert.match(settled.error, /gh: rate limit exceeded/);
});

test("vault.pull: Vault sync through the handlers — cached checkout hydrated, sync stamp, node ledgers reconciled", async (t) => {
  // A prior pull's cached checkout at <home>/vault: an obfuscated envelope, a
  // config file, and another machine's node-scoped ledger snapshot.
  const { runner, calls } = fakeVaultRunner(() => Buffer.alloc(0));
  const { handlers, home, stateDir, factory } = makeSurface(t, [], [], runner);
  mkdirSync(join(home, "vault", ".git"), { recursive: true });
  mkdirSync(join(home, "vault", "secrets", "shared"), { recursive: true });
  writeFileSync(join(home, "vault", "secrets", "shared", "eye.json"), JSON.stringify(sealVaultBuffer(Buffer.from('{"provider":"eye"}', "utf8"))));
  mkdirSync(join(home, "vault", "config"), { recursive: true });
  writeFileSync(join(home, "vault", "config", "lanes.json"), '{"lanes":{"default":"pi"}}');
  mkdirSync(join(home, "vault", "state", "nodes", "other-mac"), { recursive: true });
  const remoteLedger = `${JSON.stringify({ seq: 1, ts: "2026-10-20T09:00:00.000Z", event: "contract_set", task: "T-REMOTE", workspace: "/w", gate: "true", artifact: "a" })}\n`;
  writeFileSync(join(home, "vault", "state", "nodes", "other-mac", "global-ledger.jsonl"), remoteLedger);

  const configured = await handlers.vaultConfigure({ repo: "acme/factory-vault", branch: "main" });
  assert.ok(configured.ok, configured.ok ? "" : configured.error);
  // This machine's own ledger has one event the remote does not.
  factory.ledger.append({ event: "contract_set", task: "T-LOCAL", workspace: "/w", gate: "true", artifact: "a" });

  const reply = await handlers.vaultPull({ mergeLedgers: true });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.match(reply.summary, /3/, "vaultPull returns a human-readable summary");
  assert.deepEqual(reply.hydratedFiles, ["config/lanes.json", "secrets/shared/eye.json", "state/nodes/other-mac/global-ledger.jsonl"]);
  // The cached-checkout leg: git pull --rebase --autostash inside <home>/vault, never a fresh clone.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, ["pull", "--rebase", "--autostash"], "an existing checkout pulls, it does not re-clone");
  assert.equal(calls[0]!.cwd, join(home, "vault"));

  assert.equal(readFileSync(join(home, "vault-runtime", "secrets", "shared", "eye.json"), "utf8"), '{"provider":"eye"}', "the envelope unsealed into the runtime tree");
  assert.equal(reply.vault.lastHydrateMode, "sync");
  assert.equal(reply.vault.cloneExists, true, "the cached checkout is exactly what cloneExists reports");

  // The mergeLedgers leg: both machines' events land in the global ledger, re-indexed monotonic.
  const merged = readFileSync(join(stateDir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { seq: number; task: string });
  assert.deepEqual(
    merged.map((entry) => entry.task).sort(),
    ["T-LOCAL", "T-REMOTE"],
    "the node snapshot folded into this machine's global ledger",
  );
  assert.deepEqual(merged.map((entry) => entry.seq), merged.map((_, index) => index + 1), "seq re-indexed strictly monotonic 1..N");
});

test("vault.push: packages the runtime tree plus this node's ledger snapshot, commits and pushes through the handlers", async (t) => {
  const { runner, calls } = fakeVaultRunner((call) => (call.args[0] === "status" ? Buffer.from(" M secrets/shared/asc-api-key.p8\n") : Buffer.alloc(0)));
  const { handlers, home, factory } = makeSurface(t, [], [], runner);
  const configured = await handlers.vaultConfigure({ repo: "acme/factory-vault", branch: "main" });
  assert.ok(configured.ok, configured.ok ? "" : configured.error);

  const p8 = "-----BEGIN PRIVATE KEY-----\npush me back\n-----END PRIVATE KEY-----\n";
  mkdirSync(join(home, "vault-runtime", "secrets", "shared"), { recursive: true });
  writeFileSync(join(home, "vault-runtime", "secrets", "shared", "asc-api-key.p8"), p8);
  factory.ledger.append({ event: "contract_set", task: "T-PUSH", workspace: "/w", gate: "true", artifact: "a" });

  const reply = await handlers.vaultPush({ includeLedgers: true });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.match(reply.summary, /2/, "vaultPush returns a human-readable summary");
  assert.deepEqual(reply.pushedFiles, ["secrets/shared/asc-api-key.p8", `state/nodes/${reply.vault.nodeId}/global-ledger.jsonl`]);
  assert.equal(readFileSync(join(home, "vault", "secrets", "shared", "asc-api-key.p8"), "utf8"), p8, "the runtime tree landed in the checkout");
  assert.ok(existsSync(join(home, "vault", "state", "nodes", reply.vault.nodeId, "global-ledger.jsonl")), "this node's ledger snapshot rode the push");
  assert.ok(reply.vault.lastPushedAt !== null, "the push stamps lastPushedAt");

  // The full git choreography through the seam: clone (no cached checkout
  // yet), status sees the staged tree, add + commit + push origin main.
  const nodeId = reply.vault.nodeId;
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ["git", "clone", "--branch", "main", "https://github.com/acme/factory-vault.git", join(home, "vault")],
      ["git", "status", "--porcelain"],
      ["git", "add", "-A"],
      ["git", "-c", "user.name=paseo-factory", "-c", "user.email=vault@paseo-factory.invalid", "commit", "-m", `vault push from ${nodeId}`],
      ["git", "push", "origin", "main"],
    ],
  );
});

test("vault.pull / vault.push: unconfigured and failing-runner refusals are data, never exceptions", async (t) => {
  const unconfigured = makeSurface(t);
  const noPull = await unconfigured.handlers.vaultPull({});
  assert.ok(!noPull.ok);
  assert.equal(noPull.code, "vault-not-configured");
  assert.match(noPull.error, /Enable & Sync Vault/, "unconfigured error guides the Owner to the UI action");
  assert.doesNotMatch(noPull.error, /saveVaultConfig/, "internal function names never leak in user-facing error copy");
  const noPush = await unconfigured.handlers.vaultPush({});
  assert.ok(!noPush.ok);
  assert.equal(noPush.code, "vault-not-configured");
  assert.match(noPush.error, /Enable & Sync Vault/);
  assert.doesNotMatch(noPush.error, /saveVaultConfig/);

  const failing = makeSurface(t, [], [], async () => {
    throw new Error("fatal: could not read from remote repository");
  });
  const configured = await failing.handlers.vaultConfigure({ repo: "acme/factory-vault", branch: "main" });
  assert.ok(configured.ok, configured.ok ? "" : configured.error);
  const pullFail = await failing.handlers.vaultPull({});
  assert.ok(!pullFail.ok);
  assert.match(pullFail.error, /could not read from remote repository/);
  const pushFail = await failing.handlers.vaultPush({});
  assert.ok(!pushFail.ok);
  assert.match(pushFail.error, /could not read from remote repository/);
});

test("vault snapshot & vault.sync / vault.import: unconfigured snapshot probes gh auth, vaultSync auto-provisions & syncs, vaultImport seals keys and returns summary", async (t) => {
  const { runner, calls } = fakeVaultRunner((call) => {
    if (call.command === "gh" && call.args[0] === "auth" && call.args[1] === "status") {
      return Buffer.from(
        JSON.stringify({
          hosts: {
            "github.com": [{ login: "daymanondev", active: true, state: "success" }],
          },
        }),
      );
    }
    if (call.command === "gh" && call.args[0] === "repo" && call.args[1] === "view") {
      throw new Error("GraphQL: Could not resolve to a Repository");
    }
    if (call.command === "git" && call.args[0] === "clone") {
      const targetDir = call.args[call.args.length - 1]!;
      mkdirSync(join(targetDir, ".git"), { recursive: true });
      return Buffer.alloc(0);
    }
    if (call.command === "git" && call.args[0] === "status") {
      return Buffer.from(" M config/lanes.json\n");
    }
    return Buffer.alloc(0);
  });

  const { handlers, home, stateDir } = makeSurface(t, [], [], runner);
  writeLanes(stateDir, { supervisor: "claude/opus-4-8" });

  // 1. Unconfigured snapshot probes gh auth via the injected vaultRunner and populates suggestedRepo.
  const snap = await handlers.snapshot({});
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  assert.equal(snap.view.vault.configured, false);
  assert.equal(snap.view.vault.ghInstalled, true);
  assert.equal(snap.view.vault.ghAuthenticated, true);
  assert.equal(snap.view.vault.ghUser, "daymanondev");
  assert.equal(snap.view.vault.suggestedRepo, "daymanondev/factory-vault");

  // 2. vaultSync auto-configures daymanondev/factory-vault, creates the missing private repo, and syncs.
  const syncReply = await handlers.vaultSync({});
  assert.ok(syncReply.ok, syncReply.ok ? "" : syncReply.error);
  assert.equal(syncReply.createdRepo, true);
  assert.equal(syncReply.vault.configured, true);
  assert.equal(syncReply.vault.repo, "daymanondev/factory-vault");
  assert.equal(syncReply.pushed, true);
  assert.ok(syncReply.pushedFiles.includes("config/lanes.json"), "local lanes.json was collected and pushed");
  assert.match(syncReply.summary, /Vault synced with daymanondev\/factory-vault/);
  assert.ok(
    calls.some((c) => c.command === "gh" && c.args[0] === "repo" && c.args[1] === "create" && c.args[2] === "daymanondev/factory-vault"),
    "gh repo create was invoked for the missing default vault repo",
  );

  // 3. vaultImport imports .p8 and GPlay JSON from disk into vault-runtime/secrets/shared/ and syncs.
  const keysDir = makeTempDir();
  disposeDir(t, keysDir);
  const p8Path = join(keysDir, "AuthKey_ABC123.p8");
  const gplayPath = join(keysDir, "service-account.json");
  writeFileSync(p8Path, "-----BEGIN PRIVATE KEY-----\nimported-p8\n-----END PRIVATE KEY-----\n");
  writeFileSync(gplayPath, '{"type":"service_account","project_id":"demo"}');

  const importReply = await handlers.vaultImport({
    ascKeyPath: p8Path,
    ascKeyId: "ABC123",
    ascIssuer: "ISSUER-999",
    gplayKeyPath: gplayPath,
    syncAfterImport: true,
  });
  assert.ok(importReply.ok, importReply.ok ? "" : importReply.error);
  assert.deepEqual(importReply.importedFiles, [
    "secrets/shared/asc-api-key.p8",
    "secrets/shared/asc-credentials.json",
    "secrets/shared/gplay-service-account.json",
  ]);
  assert.equal(importReply.vault.sharedSecrets.ascKey, true);
  assert.equal(importReply.vault.sharedSecrets.ascCredentials, true);
  assert.equal(importReply.vault.sharedSecrets.gplayServiceAccount, true);
  assert.equal(importReply.pushed, true);
  assert.match(importReply.summary, /Imported 3 secret file\(s\)/);
  assert.ok(existsSync(join(home, "vault-runtime", "env.json")), "env.json written after import");

  // Missing import file refuses as data.
  const badImport = await handlers.vaultImport({ ascKeyPath: join(keysDir, "missing.p8"), syncAfterImport: false });
  assert.ok(!badImport.ok);
  assert.equal(badImport.code, "vault-import-file-not-found");
});

test("v0.0.23 (ADR 0015 §6): ensureSeat opens/reuses the Project's Paseo workspaceId, persists workspaceId + paseoProjectId, and sets parent: supervisorId on Lead", async (t) => {
  const { handlers, fake, stateDir } = makeSurface(t, []);
  const project = makeProject(t, "ws-bound-seats");
  writeLanes(stateDir, { supervisor: "claude/opus-4-8", lead: "opencode/glm-5.1" });

  const openedWorkspaces: string[] = [];
  const wsCreatedAgents: {
    workspaceId: string;
    config: { provider: string; thinkingOptionId?: string };
    parent?: string;
    title: string;
    labels: Record<string, string>;
    prompt?: string;
  }[] = [];

  fake.daemon.workspaces = {
    open: async ({ cwd }) => {
      openedWorkspaces.push(cwd);
      return { id: "ws-project-main", projectId: "prj-project-main" };
    },
    create: async () => ({ id: "ws-unused", projectId: "prj-project-main" }),
    archive: async () => ({ archivedAt: new Date().toISOString(), error: null }),
    ref: (workspaceId: string) => ({
      agents: {
        create: async (options) => {
          wsCreatedAgents.push({
            workspaceId,
            config: options.config,
            ...(options.parent === undefined ? {} : { parent: options.parent }),
            title: options.title,
            labels: options.labels,
            prompt: options.prompt,
          });
          return fake.daemon.agents.create({
            ...options,
            cwd: project.root,
          });
        },
      },
    }),
  };

  const supReply = await handlers.supervisorEnsure({ projectRoot: project.root });
  assert.ok(supReply.ok, supReply.ok ? "" : supReply.error);
  assert.equal(supReply.created, true);
  assert.deepEqual(openedWorkspaces, [project.root], "ensureSeat opened the Project's Paseo workspace at <project-root>");
  assert.equal(wsCreatedAgents.length, 1, "Supervisor was created through workspaces.ref(workspaceId).agents.create");
  assert.equal(wsCreatedAgents[0]!.workspaceId, "ws-project-main");
  assert.equal(wsCreatedAgents[0]!.parent, undefined, "Supervisor has no parent agent");

  const leadReply = await handlers.leadEnsure({ projectRoot: project.root });
  assert.ok(leadReply.ok, leadReply.ok ? "" : leadReply.error);
  assert.equal(leadReply.created, true);
  assert.equal(wsCreatedAgents.length, 2, "Lead was also created through workspaces.ref(workspaceId).agents.create");
  assert.equal(wsCreatedAgents[1]!.workspaceId, "ws-project-main");
  assert.equal(wsCreatedAgents[1]!.parent, supReply.agentId, "Lead carries parent: supervisor.id when a live Supervisor exists");

  const reg = readProjectRegistration(stateDir, project.slug);
  assert.equal(reg?.workspaceId, "ws-project-main", "workspaceId persisted in project.json");
  assert.equal(reg?.paseoProjectId, "prj-project-main", "paseoProjectId persisted in project.json");
  assert.equal(reg?.supervisor, supReply.agentId);
  assert.equal(reg?.lead, leadReply.agentId);
});

test("v0.0.23 (ADR 0015 §6): spool spawn/respawn registers Task worktree workspace under paseoProjectId, returns leadAgentId + workspaceId + projectSlug, and meter/respawn/accept auto-archive", async (t) => {
  const { handlers, factory, fake, stateDir } = makeSurface(t, []);
  const project = makeProject(t, "ws-task-archive");
  writeLanes(stateDir, { supervisor: "claude/opus-4-8", lead: "opencode/glm-5.1", agent: "opencode/glm-5.1" });

  const createdWorkspaces: { title: string; source: { kind: "directory"; path: string; projectId?: string } }[] = [];
  const archivedWorkspaces: string[] = [];

  fake.daemon.workspaces = {
    open: async () => ({ id: "ws-proj-root", projectId: "prj-proj-root" }),
    create: async ({ title, source }) => {
      createdWorkspaces.push({ title, source });
      return { id: `ws-wt-${createdWorkspaces.length}`, projectId: source.projectId ?? null };
    },
    archive: async (wsId: string) => {
      archivedWorkspaces.push(wsId);
      return { archivedAt: new Date().toISOString(), error: null };
    },
    ref: () => ({
      agents: {
        create: async (options) => fake.daemon.agents.create({ ...options, cwd: project.root }),
      },
    }),
  };

  // Ensure Supervisor and Lead seats first so project.json has workspaceId + paseoProjectId + lead.
  const supEnsure = await handlers.supervisorEnsure({ projectRoot: project.root });
  assert.ok(supEnsure.ok);
  const leadEnsure = await handlers.leadEnsure({ projectRoot: project.root });
  assert.ok(leadEnsure.ok);

  // Set contract for T-WS-1 inside project.root.
  factory.setContract({
    task: "T-WS-1",
    workspace: project.root,
    gate: "test -f out.txt",
    artifact: "out.txt",
    by: "lead",
  });

  const wtPrep = prepareTaskWorktree({ stateDir, workspace: project.root, task: "T-WS-1" });
  assert.ok(wtPrep.ok, wtPrep.ok ? "" : wtPrep.reason);
  const wtPath = wtPrep.path;
  writeFileSync(join(wtPath, "out.txt"), "ok\n");
  const headSha = gitCommitAll(wtPath, "out");
  const spawnReply = await handleSpoolRequest(
    factory,
    { id: "sp-ws-1", kind: "spawn", task: "T-WS-1", provider: "opencode/glm-5.1", arity: 1, worktree: wtPath },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake.daemon,
  );
  assert.equal(spawnReply.ok, true);
  if (spawnReply.ok) {
    assert.equal(spawnReply.leadAgentId, leadEnsure.agentId);
    assert.equal(spawnReply.workspaceId, "ws-wt-1");
    assert.equal(spawnReply.projectSlug, project.slug);
  }
  assert.deepEqual(createdWorkspaces, [
    {
      title: `${project.slug} T-WS-1`,
      source: { kind: "directory", path: wtPath, projectId: "prj-proj-root" },
    },
  ]);
  assert.equal(readProjectRegistration(stateDir, project.slug)?.taskWorkspaces?.["T-WS-1"], "ws-wt-1");

  // Seed a dead worker agent and test respawn: archives died_agent and reuses taskWorkspaces["T-WS-1"].
  const deadWorker = await fake.daemon.agents.create({
    config: { provider: "opencode/glm-5.1" },
    cwd: wtPath,
    title: "factory T-WS-1 (dead)",
    labels: { seat: "agent", project: project.slug, task: "T-WS-1" },
  });
  const respawnReply = await handleSpoolRequest(
    factory,
    { id: "rsp-ws-1", kind: "respawn", task: "T-WS-1", provider: "opencode/glm-5.1", died_agent: deadWorker.id },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake.daemon,
  );
  assert.equal(respawnReply.ok, true);
  if (respawnReply.ok) {
    assert.equal(respawnReply.leadAgentId, leadEnsure.agentId);
    assert.equal(respawnReply.workspaceId, "ws-wt-1");
    assert.equal(respawnReply.projectSlug, project.slug);
  }
  assert.ok(fake.archived.includes(deadWorker.id), "respawn archived superseded died_agent");
  assert.equal(createdWorkspaces.length, 1, "respawn reused the existing taskWorkspaces[T-WS-1] entry");

  // Seed replacement live worker, run claim + meter, verify meter archives finished worker.
  const liveWorker = await fake.daemon.agents.create({
    config: { provider: "opencode/glm-5.1" },
    cwd: wtPath,
    title: "factory T-WS-1 (live)",
    labels: { seat: "agent", project: project.slug, task: "T-WS-1" },
  });
  const claim1 = await factory.claim({ task: "T-WS-1", sha: headSha, agent: liveWorker.id });
  assert.equal(claim1.verdict, "green");

  const meterReply = await handleSpoolRequest(
    factory,
    { id: "m-ws-1", kind: "meter", task: "T-WS-1", provider: "opencode/glm-5.1", agent: liveWorker.id, usage: { inputTokens: 100, outputTokens: 50 } },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake.daemon,
  );
  assert.equal(meterReply.ok, true);
  assert.ok(fake.archived.includes(liveWorker.id), "meter archived finished working Agent");

  // Accept T-WS-1: archives taskWorkspaces[T-WS-1] and removes it from project.json.
  const accept1 = await handlers.accept({ task: "T-WS-1", attempt: 1 });
  assert.ok(accept1.ok, accept1.ok ? "" : accept1.error);
  assert.ok(archivedWorkspaces.includes("ws-wt-1"), "accept archived the Task worktree Paseo workspace");
  assert.equal(
    readProjectRegistration(stateDir, project.slug)?.taskWorkspaces?.["T-WS-1"],
    undefined,
    "accept removed taskWorkspaces[T-WS-1] from project.json",
  );
});

test("foldTasks scopes attempts, status, needsHumanReason, lane, cost, and choke to the task's current Contract epoch (v0.0.24)", (t) => {
  const { factory } = makeSurface(t);
  // Epoch 1: contract T-01, 3 red attempts, choke events, meter, and needs_human.
  factory.ledger.append({
    event: "contract_set",
    task: "T-01",
    workspace: "/tmp/ws-old",
    gate: "false",
    artifact: "src/old.ts",
    description: "Old epoch",
  });
  factory.ledger.append({ event: "spawn_dispatched", task: "T-01", provider: "opencode/old-model", arity: 1 });
  for (const attempt of [1, 2, 3]) {
    factory.ledger.append({ event: "claim_reported", task: "T-01", attempt, sha: "deadbeef" });
    factory.ledger.append({ event: "gate_started", task: "T-01", attempt, cmd: "false" });
    factory.ledger.append({ event: "gate_finished", task: "T-01", attempt, exit: 1, verdict: "red", note: "failed" });
    factory.ledger.append({ event: "report_written", task: "T-01", attempt, path: `report-T-01-${attempt}.md` });
  }
  const lastGate = factory.ledger.eventsFor("T-01").findLast((e) => e.event === "gate_finished")!;
  factory.ledger.append({ event: "permit_denied", task: "T-01", agent: "ag-1", name: "Write", kind: "tool", rule: "scope:outside", reason: "outside" });
  factory.ledger.append({ event: "meter_written", task: "T-01", provider: "opencode/old-model", usage: { totalCostUsd: 0.42 } });
  factory.ledger.append({ event: "needs_human", task: "T-01", reason: "attempt-ceiling", evidence: { attempt: 3, gate: lastGate.seq } });

  const beforeRecontract = foldTasks(factory.ledger.events);
  assert.equal(beforeRecontract.length, 1);
  assert.equal(beforeRecontract[0]?.status, "needs-human");
  assert.equal(beforeRecontract[0]?.attempts.length, 3);
  assert.equal(beforeRecontract[0]?.needsHumanReason, "attempt-ceiling");

  // Epoch 2: re-contract T-01 with updated contract metadata.
  const c2 = factory.ledger.append({
    event: "contract_set",
    task: "T-01",
    workspace: "/tmp/ws-new",
    gate: "npm test",
    artifact: "src/new.ts",
    description: "New epoch",
  });

  const afterRecontract = foldTasks(factory.ledger.events);
  assert.equal(afterRecontract.length, 1);
  assert.equal(afterRecontract[0]?.task, "T-01");
  assert.equal(afterRecontract[0]?.status, "waiting");
  assert.deepEqual(afterRecontract[0]?.attempts, []);
  assert.equal(afterRecontract[0]?.needsHumanReason, null);
  assert.equal(afterRecontract[0]?.description, "New epoch");
  assert.equal(afterRecontract[0]?.workspace, "/tmp/ws-new");
  assert.equal(afterRecontract[0]?.lane, null);
  assert.equal(afterRecontract[0]?.costState, "none");
  assert.equal(afterRecontract[0]?.costUsd, null);
  assert.deepEqual(afterRecontract[0]?.choke, { allowed: 0, denied: 0, blocked: 0 });
  assert.equal(afterRecontract[0]?.lastSeq, c2.seq);

  // Subsequent attempt in epoch 2 folds as attempt #1 and ready-to-accept.
  factory.ledger.append({ event: "spawn_dispatched", task: "T-01", provider: "opencode/new-model", arity: 1 });
  factory.ledger.append({ event: "claim_reported", task: "T-01", attempt: 1, sha: "cafebabe" });
  factory.ledger.append({ event: "gate_started", task: "T-01", attempt: 1, cmd: "npm test" });
  factory.ledger.append({ event: "gate_finished", task: "T-01", attempt: 1, exit: 0, verdict: "green", note: "ok", sha: "cafebabe" });
  const r2 = factory.ledger.append({ event: "report_written", task: "T-01", attempt: 1, path: "report-T-01-1.md" });

  const afterEpoch2Attempt = foldTasks(factory.ledger.events);
  assert.equal(afterEpoch2Attempt[0]?.status, "ready-to-accept");
  assert.equal(afterEpoch2Attempt[0]?.attempts.length, 1);
  assert.equal(afterEpoch2Attempt[0]?.attempts[0]?.n, 1);
  assert.equal(afterEpoch2Attempt[0]?.attempts[0]?.verdict, "green");
  assert.equal(afterEpoch2Attempt[0]?.needsHumanReason, null);
  assert.equal(afterEpoch2Attempt[0]?.lane, "opencode/new-model");
  assert.equal(afterEpoch2Attempt[0]?.lastSeq, r2.seq);
});

// ---- v0.0.24 (ADR 0015): Thinking Variant Sanitization & Seat Self-Healing -------------------

test("v0.0.24 (ADR 0015 §1): sanitizeLaneWithProviders strips unsupported :thinking variants when model advertises thinkingOptions: [] or omits the requested variant", () => {
  const providers: ProviderEntry[] = [
    {
      provider: "opencode",
      available: true,
      models: [
        { id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra Free", thinkingOptions: [] },
        {
          id: "opencode/nemotron-3.5-super-vl-free",
          label: "Nemotron 3.5 Super VL Free",
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
        { id: "opencode/glm-5.1", label: "GLM 5.1", thinkingOptions: null },
      ],
    },
  ];

  // 1. Model with thinkingOptions: [] strips :max (whether model has inner opencode/ prefix or not)
  assert.equal(
    sanitizeLaneWithProviders("opencode/opencode/nemotron-3-ultra-free:max", providers),
    "opencode/opencode/nemotron-3-ultra-free",
  );
  assert.equal(
    sanitizeLaneWithProviders("opencode/nemotron-3-ultra-free:max", providers),
    "opencode/nemotron-3-ultra-free",
  );
  assert.equal(
    sanitizeLaneWithProviders("opencode/opencode/nemotron-3-ultra-free", providers),
    "opencode/opencode/nemotron-3-ultra-free",
  );

  // 2. Model with non-empty thinkingOptions strips unsupported :max, keeps supported :high
  assert.equal(
    sanitizeLaneWithProviders("opencode/opencode/nemotron-3.5-super-vl-free:max", providers),
    "opencode/opencode/nemotron-3.5-super-vl-free",
  );
  assert.equal(
    sanitizeLaneWithProviders("opencode/opencode/nemotron-3.5-super-vl-free:high", providers),
    "opencode/opencode/nemotron-3.5-super-vl-free:high",
  );

  // 3. Model with thinkingOptions: null or unknown provider/model preserves :max
  assert.equal(sanitizeLaneWithProviders("opencode/opencode/glm-5.1:max", providers), "opencode/opencode/glm-5.1:max");
  assert.equal(sanitizeLaneWithProviders("pi/zai/glm-5.3:max", providers), "pi/zai/glm-5.3:max");
  assert.equal(sanitizeLaneWithProviders("eye.json", providers), "eye.json");
});

test("v0.0.24 (ADR 0015 §1): lanesSet sanitizes unsupported :thinking before saving lanes.json and calls setAgentThinking(id, '') to clear stale thinkingOptionId on live seats", async (t) => {
  const project = makeProject(t, "lanes-sanitize");
  const { stateDir, handlers, fake, modelSyncs, thinkingSyncs } = makeSurface(t, [
    {
      id: "agent-sup-san",
      labels: { seat: "supervisor", project: project.slug },
      provider: "opencode/opencode/nemotron-3.5-super-vl-free",
      model: "opencode/nemotron-3.5-super-vl-free",
      thinkingOptionId: "max",
    },
    {
      id: "agent-lead-san",
      labels: { seat: "lead", project: project.slug },
      provider: "opencode/opencode/nemotron-3.5-super-vl-free",
      model: "opencode/nemotron-3.5-super-vl-free",
      thinkingOptionId: "max",
    },
  ]);

  fake.daemon.providers = {
    listAvailable: async () => ({
      providers: [{ provider: "opencode", available: true }],
    }),
    listModels: async () => ({
      models: [
        { id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra Free", thinkingOptions: [] },
        {
          id: "opencode/nemotron-3.5-super-vl-free",
          label: "Nemotron 3.5 Super VL Free",
          thinkingOptions: [{ id: "max", label: "Max" }],
        },
      ],
    }),
  };

  // 1. Setting supervisor to opencode/opencode/nemotron-3-ultra-free:max strips :max before saving and clears thinkingOptionId ("") on live seat.
  const supReply = await handlers.lanesSet({
    lane: "supervisor",
    value: "opencode/opencode/nemotron-3-ultra-free:max",
    projectRoot: project.root,
  });
  assert.ok(supReply.ok, supReply.ok ? "" : supReply.error);
  assert.equal(supReply.lanes.supervisor, "opencode/opencode/nemotron-3-ultra-free", ":max was stripped before persisting");
  assert.deepEqual(modelSyncs, [{ agentId: "agent-sup-san", model: "opencode/nemotron-3-ultra-free" }]);
  assert.deepEqual(
    thinkingSyncs,
    [{ agentId: "agent-sup-san", thinkingOptionId: "" }],
    "setAgentThinking(id, '') was called to clear the stale :max on the live Supervisor",
  );

  // 2. Setting lead to opencode/opencode/nemotron-3-ultra-free (no :thinking in input, but live Lead has thinkingOptionId: "max") also clears thinkingOptionId ("").
  const leadReply = await handlers.lanesSet({
    lane: "lead",
    value: "opencode/opencode/nemotron-3-ultra-free",
    projectRoot: project.root,
  });
  assert.ok(leadReply.ok, leadReply.ok ? "" : leadReply.error);
  assert.equal(leadReply.lanes.lead, "opencode/opencode/nemotron-3-ultra-free");
  assert.deepEqual(modelSyncs[1], { agentId: "agent-lead-san", model: "opencode/nemotron-3-ultra-free" });
  assert.deepEqual(
    thinkingSyncs[1],
    { agentId: "agent-lead-san", thinkingOptionId: "" },
    "setAgentThinking(id, '') was called to clear thinkingOptionId when switching from :max to a model with no thinking suffix",
  );

  // 3. Setting worker to opencode/opencode/nemotron-3-ultra-free:max also sanitizes before saving to lanes.json.
  const workerReply = await handlers.lanesSet({
    lane: "worker",
    value: "opencode/opencode/nemotron-3-ultra-free:max",
    projectRoot: project.root,
  });
  assert.ok(workerReply.ok, workerReply.ok ? "" : workerReply.error);
  assert.equal(workerReply.lanes.worker, "opencode/opencode/nemotron-3-ultra-free");

  const persisted = JSON.parse(readFileSync(join(stateDir, "projects", project.slug, "lanes.json"), "utf8")) as Record<string, string>;
  assert.deepEqual(persisted, {
    supervisor: "opencode/opencode/nemotron-3-ultra-free",
    lead: "opencode/opencode/nemotron-3-ultra-free",
    worker: "opencode/opencode/nemotron-3-ultra-free",
  });

  // 4. cachedProviders() returns the cached provider catalog and sanitizeLane() strips unsupported :thinking suffixes.
  assert.equal(handlers.cachedProviders().length, 1);
  assert.equal(handlers.cachedProviders()[0]?.provider, "opencode");
  assert.equal(await handlers.sanitizeLane("opencode/opencode/nemotron-3-ultra-free:max"), "opencode/opencode/nemotron-3-ultra-free");
});

test("v0.0.24 (ADR 0015 §1–§2): ensureSeat sanitizes :thinking on create, retires and recreates errored or provider-mismatched seats, and syncs drifted model/thinking in-place", async (t) => {
  const project = makeProject(t, "ensure-self-heal");
  const agents: FakeAgent[] = [
    {
      id: "agent-lead-errored",
      labels: { seat: "lead", project: project.slug },
      status: "error",
      lastError: 'Agent not found: "default"',
      provider: "opencode/opencode/nemotron-3-ultra-free",
      model: "opencode/nemotron-3-ultra-free",
    },
    {
      id: "agent-sup-drifted",
      labels: { seat: "supervisor", project: project.slug },
      status: "idle",
      provider: "opencode",
      model: "opencode/nemotron-3.5-super-vl-free",
      thinkingOptionId: "max",
    },
  ];
  const { stateDir, handlers, fake, modelSyncs, thinkingSyncs, stopped } = makeSurface(t, agents);

  fake.daemon.providers = {
    listAvailable: async () => ({
      providers: [
        { provider: "opencode", available: true },
        { provider: "claude", available: true },
      ],
    }),
    listModels: async (provider: string) => ({
      models:
        provider === "opencode"
          ? [{ id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra Free", thinkingOptions: [] }]
          : [{ id: "opus-4-8", label: "Opus 4.8", thinkingOptions: [{ id: "max", label: "Max" }] }],
    }),
  };

  // Write lanes with an unsupported :max suffix on nemotron-3-ultra-free (thinkingOptions: []).
  writeLanes(stateDir, {
    supervisor: "opencode/opencode/nemotron-3-ultra-free:max",
    lead: "opencode/opencode/nemotron-3-ultra-free:max",
  });

  // 1. Lead is in status === "error": ensureSeat retires it (stop + archive) and creates a clean replacement with :max stripped.
  const leadHeal = await handlers.leadEnsure({ projectRoot: project.root });
  assert.ok(leadHeal.ok, leadHeal.ok ? "" : leadHeal.error);
  assert.equal(leadHeal.created, true, "errored Lead seat was retired and recreated");
  assert.notEqual(leadHeal.agentId, "agent-lead-errored");
  assert.ok(stopped.includes("agent-lead-errored"), "errored Lead was stopped before archive");
  assert.ok(fake.archived.includes("agent-lead-errored"), "errored Lead was archived");
  assert.equal(fake.created.length, 1);
  assert.deepEqual(
    fake.created[0]!.config,
    { provider: "opencode/opencode/nemotron-3-ultra-free" },
    "replacement Lead seat omitted unsupported :max thinkingOptionId",
  );

  // 2. Supervisor is healthy (idle) on same provider ("opencode") but drifted on model & thinkingOptionId: synced in-place!
  const supHeal = await handlers.supervisorEnsure({ projectRoot: project.root });
  assert.ok(supHeal.ok, supHeal.ok ? "" : supHeal.error);
  assert.equal(supHeal.created, false, "healthy Supervisor on same provider was reused");
  assert.equal(supHeal.agentId, "agent-sup-drifted");
  assert.deepEqual(
    modelSyncs,
    [{ agentId: "agent-sup-drifted", model: "opencode/nemotron-3-ultra-free" }],
    "drifted model was synced in-place",
  );
  assert.deepEqual(
    thinkingSyncs,
    [{ agentId: "agent-sup-drifted", thinkingOptionId: "" }],
    "stale thinkingOptionId ('max') was cleared in-place",
  );

  // 3. Switch supervisor lane to a different provider family (claude/opus-4-8:max): ensureSeat retires opencode seat and creates claude seat.
  writeLanes(stateDir, {
    supervisor: "claude/opus-4-8:max",
    lead: "opencode/opencode/nemotron-3-ultra-free",
  });
  const supSwitch = await handlers.supervisorEnsure({ projectRoot: project.root });
  assert.ok(supSwitch.ok, supSwitch.ok ? "" : supSwitch.error);
  assert.equal(supSwitch.created, true, "provider-mismatched Supervisor was retired and recreated on claude");
  assert.notEqual(supSwitch.agentId, "agent-sup-drifted");
  assert.ok(fake.archived.includes("agent-sup-drifted"), "old opencode Supervisor was archived");
  assert.deepEqual(fake.created[1]!.config, { provider: "claude/opus-4-8", thinkingOptionId: "max" });
});

test("v0.0.24 (ADR 0015 §5): projectReset wipes a project's ledger events, tasks, reports, worktrees, branches, mailbox, bound workers, and seats (unless keepSeats: true) while preserving lanes.json and other projects", async (t) => {
  const projectA = makeProject(t, "reset-target");
  const projectB = makeProject(t, "reset-bystander");
  const agents: FakeAgent[] = [];
  const { stateDir, home, factory, fake, stopped } = makeSurface(t, agents);

  const archivedWorkspaces: string[] = [];
  fake.daemon.workspaces = {
    open: async () => ({ id: "ws-main", projectId: "paseo-proj-a" }),
    create: async () => ({ id: "ws-wt-1", projectId: "paseo-proj-a" }),
    archive: async (wsId: string) => {
      archivedWorkspaces.push(wsId);
    },
    ref: () => ({
      agents: {
        create: async (opts) => fake.daemon.agents.create({ ...opts, cwd: projectA.root }),
      },
    }),
  };

  const mailboxResets: string[] = [];
  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon: fake.daemon,
    stopAgent: async (agentId) => {
      stopped.push(agentId);
      return { ok: true };
    },
    resetProjectMailbox: (slug) => {
      mailboxResets.push(slug);
    },
  });

  // Save project-scoped lanes.json for projectA.
  saveLanes(stateDir, { supervisor: "pi/zai/glm-5.3", lead: "pi/zai/glm-5.3", worker: "pi/zai/glm-5.3" }, projectA.slug);
  const projectALanesFile = join(stateDir, "projects", projectA.slug, "lanes.json");
  assert.equal(existsSync(projectALanesFile), true);

  // Ensure Supervisor and Lead seats for projectA.
  const supA = await handlers.supervisorEnsure({ projectRoot: projectA.root });
  const leadA = await handlers.leadEnsure({ projectRoot: projectA.root });
  assert.ok(supA.ok && leadA.ok);

  // Contract T-RESET-1 in projectA with a real git worktree & branch factory/T-RESET-1, plus a claim.
  const contractA = factory.setContract({ task: "T-RESET-1", workspace: projectA.root, gate: "true", artifact: "README.md" });
  const wt = prepareTaskWorktree({ stateDir, workspace: projectA.root, task: "T-RESET-1" });
  assert.ok(wt.ok, wt.ok ? "" : wt.reason);
  assert.equal(existsSync(wt.path), true);
  factory.requestSpawn({ task: "T-RESET-1", provider: "pi/zai/glm-5.3", arity: 1, worktree: wt.path });
  const claimOut = await factory.claim({ task: "T-RESET-1", sha: contractA.base!, agent: "agent-worker-reset-1" });
  assert.equal(existsSync(claimOut.reportPath), true);

  // Seed a live working agent bound to T-RESET-1 in the daemon.
  agents.push({
    id: "agent-worker-reset-1",
    labels: { seat: "agent", project: projectA.slug, task: "T-RESET-1" },
    cwd: wt.path,
    status: "running",
  });

  // Seed mailbox.jsonl, lead-handoff.md, and extra fields in project.json for projectA.
  const projectADir = join(stateDir, "projects", projectA.slug);
  enqueueLeadMail(join(projectADir, "mailbox.jsonl"), { from: "owner", kind: "directive", text: "build it" });
  writeFileSync(join(projectADir, "lead-handoff.md"), "# handoff\n");
  writeProjectRegistration(stateDir, projectA.slug, {
    root: projectA.root,
    rotationState: "handing_over",
    handoffRequestedAt: "2026-10-20T00:00:00.000Z",
    taskWorkspaces: { "T-RESET-1": "ws-wt-1" },
    dispatchers: ["chat-dispatcher-1"],
  });

  // Contract T-KEEP-1 in projectB to verify other projects are undisturbed.
  factory.setContract({ task: "T-KEEP-1", workspace: projectB.root, gate: "true", artifact: "README.md" });

  // Execute full projectReset on projectA.
  const resetRes = await handlers.projectReset({ projectRoot: projectA.root });
  assert.ok(resetRes.ok, resetRes.ok ? "" : resetRes.error);
  assert.equal(resetRes.project, projectA.slug);
  assert.equal(resetRes.projectRoot, projectA.root);
  assert.deepEqual(resetRes.tasks, ["T-RESET-1"]);
  assert.ok(resetRes.purgedEvents >= 5);
  assert.ok(resetRes.removedFiles >= 1);
  assert.deepEqual(resetRes.archivedAgents, ["agent-worker-reset-1"]);
  assert.deepEqual(resetRes.archivedSeats.sort(), [supA.agentId, leadA.agentId].sort());
  assert.deepEqual(archivedWorkspaces, ["ws-wt-1"]);
  assert.deepEqual(mailboxResets, [projectA.slug]);

  // Worktree directory, factory/T-RESET-1 branch, report file, mailbox.jsonl, and lead-handoff.md are gone.
  assert.equal(existsSync(wt.path), false, "task worktree directory was removed");
  assert.equal(existsSync(join(projectADir, "worktrees")), false, "worktrees directory was removed");
  assert.equal(existsSync(claimOut.reportPath), false, "report file was removed");
  assert.equal(existsSync(join(projectADir, "mailbox.jsonl")), false, "mailbox.jsonl was removed");
  assert.equal(existsSync(join(projectADir, "lead-handoff.md")), false, "lead-handoff.md was removed");

  // lanes.json is preserved!
  assert.equal(existsSync(projectALanesFile), true, "project lanes.json must be preserved across reset");
  const preservedLanes = loadLanes(stateDir, projectA.slug);
  assert.ok(preservedLanes.ok);
  assert.equal(preservedLanes.lanes.supervisor, "pi/zai/glm-5.3");

  // When keepSeats !== true, project.json is deleted on disk while lanes.json remains intact.
  assert.equal(existsSync(join(projectADir, "project.json")), false, "project.json is deleted when keepSeats !== true");
  assert.equal(readProjectRegistration(stateDir, projectA.slug), undefined);
  assert.match(resetRes.summary, /1 agent\(s\)/, "summary uses agent(s) vocabulary");
  assert.doesNotMatch(resetRes.summary, /worker\(s\)/);

  // Returned view has 0 tasks for projectA, while projectB's task remains intact.
  assert.deepEqual(resetRes.view?.tasks, []);
  assert.equal(factory.contractFor("T-RESET-1"), undefined);
  assert.equal(factory.contractFor("T-KEEP-1")?.workspace, projectB.root);

  // Test keepSeats: true by project slug.
  const supA2 = await handlers.supervisorEnsure({ projectRoot: projectA.root });
  const leadA2 = await handlers.leadEnsure({ projectRoot: projectA.root });
  assert.ok(supA2.ok && leadA2.ok);
  factory.setContract({ task: "T-RESET-2", workspace: projectA.root, gate: "true", artifact: "README.md" });

  const keepRes = await handlers.projectReset({ project: projectA.slug, keepSeats: true });
  assert.ok(keepRes.ok, keepRes.ok ? "" : keepRes.error);
  assert.deepEqual(keepRes.tasks, ["T-RESET-2"]);
  assert.deepEqual(keepRes.archivedSeats, [], "keepSeats: true preserves live Supervisor and Lead seats");
  assert.equal(existsSync(join(projectADir, "project.json")), true, "keepSeats: true retains project.json");
  const keptReg = readProjectRegistration(stateDir, projectA.slug);
  assert.equal(keptReg?.root, projectA.root);
  assert.equal(keptReg?.supervisor, supA2.agentId);
  assert.equal(keptReg?.lead, leadA2.agentId);
  assert.equal(keptReg?.rotationState, undefined);
  assert.equal(keptReg?.taskWorkspaces, undefined);
  assert.equal(keptReg?.dispatchers, undefined);
  assert.equal(factory.contractFor("T-RESET-2"), undefined);
});

// ---- v0.0.25 (ADR 0012 §2–§4): Core + Companion Version Visibility & On-Demand Update Check ----

test("v0.0.25 (ADR 0012 §2–§3): readPluginVersionFromDisk, foldCorePlugin, and foldCompanions resolve package.json version and join on-demand update status", (t) => {
  const dir = makeTempDir("plugin-version-fold-");
  disposeDir(t, dir);

  const burnCheckout = join(dir, "factory-burn-lab", "checkout");
  const burnPluginDir = join(burnCheckout, "plugin");
  mkdirSync(burnPluginDir, { recursive: true });
  writeFileSync(join(burnCheckout, "package.json"), JSON.stringify({ name: "factory-burn-lab", version: "0.0.5" }));

  const coreCheckout = join(dir, "paseo-factory");
  const corePluginDir = join(coreCheckout, "plugin");
  mkdirSync(corePluginDir, { recursive: true });
  writeFileSync(join(coreCheckout, "package.json"), JSON.stringify({ name: "paseo-factory", version: "0.0.25" }));

  assert.equal(readPluginVersionFromDisk(burnPluginDir), "0.0.5", "resolves version from <pluginPath>/../package.json");
  assert.equal(readPluginVersionFromDisk(corePluginDir), "0.0.25");
  assert.equal(readPluginVersionFromDisk(join(dir, "nonexistent")), undefined);

  const updates = new Map([
    [
      "paseo-factory",
      { id: "paseo-factory", currentRevision: null, latestRevision: null, commitsBehind: null, updateAvailable: null },
    ],
    [
      "factory-burn-lab",
      {
        id: "factory-burn-lab",
        currentRevision: "7f8a5cc000",
        latestRevision: "a91c3f2999",
        commitsBehind: 2,
        updateAvailable: true,
      },
    ],
    [
      "factory-connector",
      {
        id: "factory-connector",
        currentRevision: "1122334455",
        latestRevision: "1122334455",
        commitsBehind: 0,
        updateAvailable: false,
      },
    ],
  ]);

  const plugins = [
    {
      id: "paseo-factory",
      path: corePluginDir,
      enabled: true,
      status: "running" as const,
      installation: { identity: { kind: "directory" as const, path: corePluginDir } },
    },
    {
      id: "factory-burn-lab",
      path: burnPluginDir,
      enabled: true,
      status: "running" as const,
      installation: {
        identity: { kind: "git" as const, remote: "https://github.com/daymanondev/factory-burn-lab", pluginPath: "plugin" },
        currentRevision: "7f8a5cc000",
      },
    },
    {
      id: "factory-connector",
      enabled: true,
      status: "running" as const,
      version: "0.0.3",
      installation: {
        identity: { kind: "git" as const, remote: "https://github.com/daymanondev/factory-connector", pluginPath: "plugin" },
        currentRevision: "1122334455",
      },
    },
  ];

  const core = foldCorePlugin(plugins, updates);
  assert.equal(core.id, "paseo-factory");
  assert.equal(core.title, "Factory Core");
  assert.equal(core.version, "0.0.25");
  assert.equal(core.installKind, "directory");
  assert.equal(core.updateAvailable, null, "directory installs never report remote updateAvailable");

  const folded = foldCompanions(plugins, updates);
  const burn = folded.find((c) => c.id === "factory-burn-lab")!;
  assert.equal(burn.version, "0.0.5");
  assert.equal(burn.currentRevision, "7f8a5cc000");
  assert.equal(burn.latestRevision, "a91c3f2999");
  assert.equal(burn.commitsBehind, 2);
  assert.equal(burn.updateAvailable, true);

  const fleet = folded.find((c) => c.id === "factory-connector")!;
  assert.equal(fleet.version, "0.0.3");
  assert.equal(fleet.updateAvailable, false);
  assert.equal(fleet.commitsBehind, 0);

  const lab = folded.find((c) => c.id === "factory-release-lab")!;
  assert.equal(lab.status, "not_installed");
  assert.equal(lab.version, null);
  assert.equal(lab.updateAvailable, null);
});

test("v0.0.25 (ADR 0012 §4): checkDaemonPluginUpdates speaks plugin.source.status.request over WebSocket, caches per home, falls back to CLI, and invalidates on install/manage", async (t) => {
  const daemon = await startFakeDaemon(t, (message) => {
    if (message.type === "plugin.source.status.request") {
      return {
        type: "plugin.source.status.response",
        payload: {
          requestId: message.requestId,
          plugins: [
            { id: "paseo-factory", source: "directory", path: "/w/plugin", updateAvailable: false },
            {
              id: "factory-burn-lab",
              source: "git",
              path: "/p/burn",
              currentCommit: "7f8a5cc",
              latestCommit: "a91c3f2",
              commitsBehind: 3,
              updateAvailable: true,
            },
            {
              id: "factory-connector",
              source: "git",
              path: "/p/fleet",
              currentCommit: "1122334",
              latestCommit: "1122334",
              commitsBehind: 0,
              updateAvailable: false,
            },
          ],
        },
      };
    }
    if (message.type === "plugin.reload.request") {
      return {
        type: "plugin.reload.response",
        payload: {
          requestId: message.requestId,
          plugin: { id: message.pluginId, path: "/w/plugin", enabled: true, status: "running" },
        },
      };
    }
    return null;
  });

  assert.equal(getCachedPluginUpdateStatus(daemon.home), null);
  const res = await checkDaemonPluginUpdates(daemon.home);
  assert.ok(res.ok, res.ok ? "" : res.reason);
  assert.equal(res.statuses.length, 3);
  const cached = getCachedPluginUpdateStatus(daemon.home);
  assert.ok(cached !== null);
  assert.equal(cached.statuses.get("paseo-factory")?.updateAvailable, null, "directory source maps to updateAvailable: null");
  assert.equal(cached.statuses.get("factory-burn-lab")?.updateAvailable, true);
  assert.equal(cached.statuses.get("factory-burn-lab")?.latestRevision, "a91c3f2");
  assert.equal(cached.statuses.get("factory-connector")?.updateAvailable, false);

  // Managing a plugin invalidates the cached update status for that home.
  const reload = await manageDaemonPlugin(daemon.home, "paseo-factory", "reload");
  assert.ok(reload.ok);
  assert.equal(getCachedPluginUpdateStatus(daemon.home), null, "manageDaemonPlugin invalidates cached update status");

  // CLI fallback when no paseo.pid exists on home:
  const noDaemonHome = makeTempDir("paseo-factory-no-daemon-update-");
  disposeDir(t, noDaemonHome);
  const cli = fakePaseoCli(
    t,
    `${JSON.stringify({
      plugins: [{ id: "factory-burn-lab", outcome: "update", target: { kind: "git", commit: "9988776" } }],
    })}\n`,
  );
  const cliRes = await checkDaemonPluginUpdates(noDaemonHome);
  assert.ok(cliRes.ok, cliRes.ok ? "" : cliRes.reason);
  assert.equal(cliRes.statuses[0]?.id, "factory-burn-lab");
  assert.equal(cliRes.statuses[0]?.updateAvailable, true);
  assert.equal(cliRes.statuses[0]?.latestRevision, "9988776");
  assert.deepEqual(cli.argvs(), [["--home", noDaemonHome, "plugin", "update", "--all", "--check", "--json"]]);
});

test("v0.0.25 (ADR 0012 §2/§4): pluginsCheckUpdates populates snapshot update flags, pluginsManage protects paseo-factory from disable/remove, reports honest update summaries, and supports batch update ('all')", async (t) => {
  const dir = makeTempDir("surface-plugins-v25-");
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const retroRunner = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: retroRunner.runner });

  const manageCalls: { pluginId: string; action: string }[] = [];
  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon: fakeDaemon([]).daemon,
    listPlugins: async () => ({
      ok: true,
      plugins: [
        {
          id: "paseo-factory",
          path: "/plugins/paseo-factory",
          enabled: true,
          status: "running",
          version: "0.0.25",
          installation: { identity: { kind: "directory", path: "/plugins/paseo-factory" } },
        },
        {
          id: "factory-burn-lab",
          path: "/plugins/factory-burn-lab",
          enabled: true,
          status: "running",
          version: "0.0.5",
          installation: {
            identity: { kind: "git", remote: "https://github.com/daymanondev/factory-burn-lab", pluginPath: "plugin" },
            currentRevision: "7f8a5cc111",
          },
        },
        {
          id: "factory-connector",
          path: "/plugins/factory-connector",
          enabled: true,
          status: "running",
          version: "0.0.3",
          installation: {
            identity: { kind: "git", remote: "https://github.com/daymanondev/factory-connector", pluginPath: "plugin" },
            currentRevision: "1122334455",
          },
        },
      ],
    }),
    checkPluginUpdates: async () => ({
      ok: true,
      checkedAt: "2026-10-20T15:30:00.000Z",
      statuses: [
        {
          id: "factory-burn-lab",
          currentRevision: "7f8a5cc111",
          latestRevision: "a91c3f2222",
          commitsBehind: 2,
          updateAvailable: true,
        },
        {
          id: "factory-connector",
          currentRevision: "1122334455",
          latestRevision: "1122334455",
          commitsBehind: 0,
          updateAvailable: false,
        },
      ],
    }),
    managePlugin: async (_home, pluginId, action) => {
      manageCalls.push({ pluginId, action });
      if (action === "update" && pluginId === "factory-burn-lab") {
        return {
          ok: true,
          update: { id: "factory-burn-lab", previousCommit: "7f8a5cc111", currentCommit: "a91c3f2222", commits: 2, updated: true },
        };
      }
      if (action === "update" && pluginId === "factory-connector") {
        return {
          ok: true,
          update: { id: "factory-connector", previousCommit: "1122334455", currentCommit: "1122334455", commits: 0, updated: false },
        };
      }
      return { ok: true };
    },
  });

  // 1. Before pluginsCheckUpdates runs, pluginsCheckedAt is null and updateAvailable is null.
  const snapBefore = await handlers.snapshot({});
  assert.ok(snapBefore.ok);
  assert.equal(snapBefore.view.pluginsCheckedAt, null);
  assert.equal(snapBefore.view.corePlugin.id, "paseo-factory");
  assert.equal(snapBefore.view.corePlugin.version, "0.0.25");
  assert.equal(snapBefore.view.companions.find((c) => c.id === "factory-burn-lab")?.updateAvailable, null);

  // 2. Run pluginsCheckUpdates -> populates checkedAt, updatesAvailable, and feeds the next snapshot.
  const checkRes = await handlers.pluginsCheckUpdates({});
  assert.ok(checkRes.ok, checkRes.ok ? "" : checkRes.error);
  assert.equal(checkRes.checkedAt, "2026-10-20T15:30:00.000Z");
  assert.deepEqual(checkRes.updatesAvailable, ["factory-burn-lab"]);
  assert.equal(checkRes.summary, "1 plugin update(s) available: factory-burn-lab");

  const snapAfter = await handlers.snapshot({});
  assert.ok(snapAfter.ok);
  assert.equal(snapAfter.view.pluginsCheckedAt, "2026-10-20T15:30:00.000Z");
  const burnAfter = snapAfter.view.companions.find((c) => c.id === "factory-burn-lab")!;
  assert.equal(burnAfter.updateAvailable, true);
  assert.equal(burnAfter.latestRevision, "a91c3f2222");
  const fleetAfter = snapAfter.view.companions.find((c) => c.id === "factory-connector")!;
  assert.equal(fleetAfter.updateAvailable, false);

  // 3. Core plugin protection: disable and remove on paseo-factory refuse with core-plugin-protected, while reload succeeds.
  const disableCore = await handlers.pluginsManage({ pluginId: "paseo-factory", action: "disable" });
  assert.ok(!disableCore.ok);
  assert.equal(disableCore.code, "core-plugin-protected");

  const removeCore = await handlers.pluginsManage({ pluginId: "paseo-factory", action: "remove" });
  assert.ok(!removeCore.ok);
  assert.equal(removeCore.code, "core-plugin-protected");

  const reloadCore = await handlers.pluginsManage({ pluginId: "paseo-factory", action: "reload" });
  assert.ok(reloadCore.ok);
  assert.equal(reloadCore.summary, "reloaded paseo-factory on the daemon");

  // 4. Honest update summaries: updated: true vs updated: false.
  const updateBurn = await handlers.pluginsManage({ pluginId: "factory-burn-lab", action: "update" });
  assert.ok(updateBurn.ok);
  assert.equal(updateBurn.summary, "updated factory-burn-lab (7f8a5cc → a91c3f2)");

  const updateFleet = await handlers.pluginsManage({ pluginId: "factory-connector", action: "update" });
  assert.ok(updateFleet.ok);
  assert.equal(updateFleet.summary, "factory-connector is already up to date (1122334)");

  // 5. Batch update ("all"): refuses non-update actions with invalid-target, and after re-checking updates, updates only the plugin with updateAvailable === true.
  const invalidBatch = await handlers.pluginsManage({ pluginId: "all", action: "disable" });
  assert.ok(!invalidBatch.ok);
  assert.equal(invalidBatch.code, "invalid-target");

  await handlers.pluginsCheckUpdates({});
  manageCalls.length = 0;
  const updateAll = await handlers.pluginsManage({ pluginId: "all", action: "update" });
  assert.ok(updateAll.ok);
  assert.deepEqual(manageCalls, [{ pluginId: "factory-burn-lab", action: "update" }]);
  assert.equal(updateAll.summary, "updated factory-burn-lab (7f8a5cc → a91c3f2)");
});





