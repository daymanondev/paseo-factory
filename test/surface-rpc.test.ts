import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { existsSync, chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi, SurfaceDeps } from "../plugin/server/surface-rpc.ts";
import {
  BRIDGE_TIMEOUT_MS,
  cliUtils,
  installDaemonPlugin,
  listDaemonPlugins,
  manageDaemonPlugin,
  PLUGIN_IO_TIMEOUT_MS,
} from "../plugin/server/daemon-cli.ts";
import type { DaemonPluginItem } from "../plugin/server/daemon-cli.ts";
import { foldCompanions } from "../plugin/server/view.ts";
import { factoryEnvFor, injectRoleOnCreate, injectSessionEnv, renderAgentContract, renderSeatBootstrap, renderSeatContract } from "../plugin/server/roles.ts";
import type { AgentCreateRequest } from "../plugin/server/roles.ts";
import { discoverProjects, readProjectRegistration, writeProjectRegistration } from "../plugin/server/projects.ts";
import { lanesPath, loadLanes, saveLanes } from "../src/lanes.ts";
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
  labels?: Record<string, string>;
  requiresAttention?: boolean;
  seqEnd?: number;
  cwd?: string;
}

function fakeDaemon(agents: FakeAgent[]) {
  const created: { config: { provider: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }[] = [];
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
              labels: agent.labels ?? {},
              archivedAt: null,
              requiresAttention: agent.requiresAttention ?? false,
              attentionReason: null,
              updatedAt: "2026-10-15T00:00:00.000Z",
              cwd: agent.cwd ?? "/tmp",
            },
          })),
          pageInfo: {},
        };
      },
      create: async (options) => {
        created.push({ config: options.config, cwd: options.cwd, title: options.title ?? "", labels: options.labels ?? {}, prompt: options.prompt });
        const id = `agent-created-${created.length}`;
        agents.push({ id, title: options.title ?? undefined, provider: options.config.provider, labels: options.labels });
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
function makeSurface(t: TestContext, agents: FakeAgent[] = [], plugins: DaemonPluginItem[] = []) {
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
      return { ok: true, plugin: { id: input.id, path: `/plugins/${input.id}`, enabled: true, status: "running" } };
    },
    managePlugin: async (manageHome, pluginId, action) => {
      pluginManages.push({ home: manageHome, pluginId, action });
      return { ok: true };
    },
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

test("snapshot: the companion catalog rides the view — two cards, not_installed while the daemon lists no companions", async (t) => {
  const { handlers } = makeSurface(t);
  const snap = await handlers.snapshot({});
  assert.ok(snap.ok, snap.ok ? "" : snap.error);
  const view = snap.view;
  // Exactly the two official companions, catalog order — the spec's own literals.
  assert.deepEqual(view.companions.map((companion) => companion.id), ["factory-burn-lab", "factory-connector"]);

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
  ]);
  assert.equal(folded.length, 2, "the catalog fixes the card count");

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
  assert.match(bootstrap, /contract --task/, "the bootstrap lists day-one contract power");
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
  assert.match(bootstrap, /contract --task <id>/);
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

  // The operator's prompt contamination never lands in a harness home.
  const roleHome = join(stateDir, "pi-agent", "supervisor");
  for (const forbidden of ["APPEND_SYSTEM.md", "SYSTEM.md", "extensions", "prompts", "skills"]) {
    assert.ok(!existsSync(join(roleHome, forbidden)), `${forbidden} never lands in the harness home`);
  }
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
