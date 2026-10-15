import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { injectRoleOnCreate, injectSessionEnv, renderAgentContract, renderSeatBootstrap, renderSeatContract } from "../plugin/server/roles.ts";
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
function makeSurface(t: TestContext, agents: FakeAgent[] = []) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const retroRunner = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: retroRunner.runner });
  const fake = fakeDaemon(agents);
  const modelSyncs: { agentId: string; model: string }[] = [];
  const stopped: string[] = [];
  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon: fake.daemon,
    setAgentModel: async (agentId, model) => {
      modelSyncs.push({ agentId, model });
      return { ok: true };
    },
    stopAgent: async (agentId) => {
      stopped.push(agentId);
      return { ok: true };
    },
  });
  return { dir, home, stateDir, factory, handlers, fake, modelSyncs, stopped };
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
  assert.equal(view.version, 2);
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

test("lanes.set: writes lanes.json, syncs a live supervisor's model, refuses invalid values", async (t) => {
  const { stateDir, handlers, modelSyncs } = makeSurface(t, [
    { id: "agent-sup-1", labels: { seat: "supervisor" }, provider: "pi/zai/glm-5.3" },
  ]);
  const reply = await handlers.lanesSet({ lane: "supervisor", value: "claude/opus-4-8" });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.equal(reply.lanes.supervisor, "claude/opus-4-8");
  const reread = loadLanes(stateDir);
  assert.ok(reread.ok && reread.lanes.supervisor === "claude/opus-4-8", "lanes.json is the config of record");
  assert.deepEqual(JSON.parse(readFileSync(lanesPath(stateDir), "utf8")), { supervisor: "claude/opus-4-8" }, "a lane-card save persists only the lane it names — defaults never materialize");
  assert.deepEqual(modelSyncs, [{ agentId: "agent-sup-1", model: "opus-4-8" }], "the live supervisor's modelId (stripped of provider prefix) was synced");

  // No live supervisor → the sync is skipped, named, never a failure.
  const skipped = await handlers.lanesSet({ lane: "worker", value: "copilot/gpt-5.4" });
  assert.ok(skipped.ok);
  assert.match(skipped.modelSync, /skipped/);
  assert.equal(modelSyncs.length, 1);
  assert.deepEqual(
    JSON.parse(readFileSync(lanesPath(stateDir), "utf8")),
    { supervisor: "claude/opus-4-8", worker: "copilot/gpt-5.4" },
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
  assert.equal(view.version, 2);
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
  const proposalsPath = join(stateDir, "retro-2026-10-15.md");
  writeFileSync(
    proposalsPath,
    ["# Retro 2026-10-15 — 1 proposal", "", "## R1 — gate-check", "- Evidence (ledger seq): 1", "- Pattern: repeated X", "- Proposal: add a gate check for X.", ""].join("\n"),
  );
  factory.ledger.append({ event: "retro_written", model: "pi/zai/glm-5.3", outcome: "written", durationMs: 10, proposalsPath, proposalCount: 1 });

  const reply = await handlers.ratifyProposal({ projectRoot: project.root, day: "2026-10-15", proposalId: 1 });
  assert.ok(reply.ok, reply.ok ? "" : reply.error);
  assert.match(reply.summary, /R1 \(gate-check\) dispatched to the Supervisor of/);
  assert.equal(fake.created.length, 1, "the ratify ensured the Supervisor seat");
  assert.deepEqual(fake.created[0]!.labels, { seat: "supervisor", project: project.slug });
  assert.equal(fake.sent.length, 1);
  const sent = fake.sent[0]!;
  assert.match(sent.text, /ratified retro proposal R1 \(gate-check\) from 2026-10-15/);
  assert.match(sent.text, /add a gate check for X\./, "the proposal text rides the dispatch verbatim");
  assert.match(sent.text, /AGENTS\.md or CONTEXT\.md/, "the dispatch names the two-tier memory targets");

  const noDay = await handlers.ratifyProposal({ projectRoot: project.root, day: "1999-01-01", proposalId: 1 });
  assert.ok(!noDay.ok);
  assert.equal(noDay.code, "unknown-retro");
  const noProposal = await handlers.ratifyProposal({ projectRoot: project.root, day: "2026-10-15", proposalId: 9 });
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
  const proposalsPath = join(stateDir, "retro-2026-10-15.md");
  writeFileSync(
    proposalsPath,
    [
      "# Retro 2026-10-15 — 2 proposals",
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
  assert.equal(retro.day, "2026-10-15");
  assert.deepEqual(
    retro.proposals.map((p) => [p.id, p.cls]),
    [[1, "gate-check"], [2, "observation"]],
    "the R-ids and classes parse for rendering",
  );
});

// ---- the role-contract layer (v0.0.14, ADR 0010 §1–§2/§6) ----------------------------------

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
  assert.match(agent, /withheld/);
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
  const project = makeProject(t, "seats");

  // A seat create: the role contract lands in systemPrompt, the env names the seat.
  const seatCreate: AgentCreateRequest = { config: { provider: "pi/zai/glm-5.3", cwd: project.root, title: "Supervisor (paseo-factory)" } };
  const seatRequest = injectRoleOnCreate(seatCreate, stateDir);
  assert.ok(seatRequest !== undefined, "a seat-titled create is injected");
  assert.match(seatRequest.config.systemPrompt!, /paseo-factory role skills: grilling, domain-modeling/);
  assert.match(seatRequest.config.systemPrompt!, /additive/);
  assert.equal(seatRequest.env?.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(seatRequest.env?.PASEO_FACTORY_PROJECT, project.slug);
  assert.equal(seatRequest.env?.PASEO_FACTORY_PROJECT_ROOT, project.root);
  assert.equal(seatRequest.env?.PASEO_FACTORY_STATE_DIR, stateDir);

  // An existing system prompt is APPENDED to, never replaced.
  const ownCreate: AgentCreateRequest = { config: { provider: "pi/zai/glm-5.3", cwd: project.root, title: "Lead (paseo-factory)", systemPrompt: "repo harness rules" } };
  const withOwn = injectRoleOnCreate(ownCreate, stateDir);
  assert.ok(withOwn !== undefined);
  assert.match(withOwn.config.systemPrompt!, /^repo harness rules/);
  assert.match(withOwn.config.systemPrompt!, /paseo-factory role skills: codebase-design, domain-modeling, tdd/);

  // Idempotent: a second pass over an injected request changes nothing.
  assert.equal(injectRoleOnCreate(seatRequest, stateDir), undefined);

  // A working agent in its managed task worktree gets the Agent contract.
  const worktree = join(stateDir, "projects", project.slug, "worktrees", "T1");
  const agentCreate: AgentCreateRequest = { config: { provider: "pi/zai/glm-5.3", cwd: worktree, title: "T1" } };
  const agentRequest = injectRoleOnCreate(agentCreate, stateDir);
  assert.ok(agentRequest !== undefined, "a managed-worktree create is injected");
  assert.match(agentRequest.config.systemPrompt!, /paseo-factory role skills: tdd, diagnosing-bugs, codebase-design/);
  assert.equal(agentRequest.env?.PASEO_FACTORY_TASK, "T1");
  assert.equal(agentRequest.env?.PASEO_FACTORY_SEAT, "agent");

  // A stranger in an unrelated directory passes through untouched.
  const strangerCreate: AgentCreateRequest = { config: { provider: "pi/zai/glm-5.3", cwd: "/tmp", title: "Notes" } };
  assert.equal(injectRoleOnCreate(strangerCreate, stateDir), undefined);
});

test("roles: session_open env re-carries the seat identity from the project registry on every launch", (t) => {
  const { stateDir } = makeSurface(t);
  const project = makeProject(t, "env");
  writeProjectRegistration(stateDir, project.slug, { root: project.root, supervisor: "agent-sup-7", lead: "agent-lead-7" });

  const supervisorSession = injectSessionEnv({ agentId: "agent-sup-7", cwd: project.root, env: { PATH: "/bin" } } as { agentId: string; cwd: string; env: Record<string, string> }, stateDir);
  assert.ok(supervisorSession !== undefined);
  assert.equal(supervisorSession.env.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(supervisorSession.env.PASEO_FACTORY_PROJECT, project.slug);
  assert.equal(supervisorSession.env.PATH, "/bin", "the overlay is additive over the daemon's env");

  const worktree = join(stateDir, "projects", project.slug, "worktrees", "T2");
  const agentSession = injectSessionEnv({ agentId: "agent-worker-9", cwd: worktree, env: {} } as { agentId: string; cwd: string; env: Record<string, string> }, stateDir);
  assert.ok(agentSession !== undefined);
  assert.equal(agentSession.env.PASEO_FACTORY_TASK, "T2");
  assert.equal(agentSession.env.PASEO_FACTORY_SEAT, "agent");

  // An unregistered agent at the project root (a stranger) gets nothing.
  const strangerSession: { agentId: string; cwd: string; env: Record<string, string> } = { agentId: "agent-stranger", cwd: project.root, env: {} };
  assert.equal(injectSessionEnv(strangerSession, stateDir), undefined);
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

  // Discovery lists the registered project plus live seat agents it has never seated.
  const discovered = discoverProjects(stateDir, [{ labels: { seat: "lead", project: "other-xyz789" }, cwd: "/w/other" }]);
  assert.deepEqual(
    discovered,
    [
      { slug: "other-xyz789", root: "/w/other" },
      { slug: project.slug, root: project.root },
    ],
    "registry files and live seat agents both feed the Project Selector, slug order",
  );
});
