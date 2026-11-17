import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { foldPanel, type PanelInput } from "../plugin/server/panel.ts";
import { createFactoryRegistry, writeProjectRegistration } from "../plugin/server/projects.ts";
import { createSurfaceHandlers, type SurfaceAgentSnapshot, type SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { seatsDirectory as seatsDirectoryRpc } from "../plugin/shared/rpc.ts";
import {
  AgentViewSchema,
  FactoryViewSchema,
  PanelPeerRowSchema,
  PanelSeatRowSchema,
  SeatDirectoryEntrySchema,
  type AgentView,
} from "../plugin/shared/view.ts";
import { disposeDir, gitCommitAll, makeTempDir, writeLanes } from "./helpers.ts";

interface FakeAgentSeed {
  id: string;
  provider?: string;
  title?: string | null;
  status?: string;
  model?: string | null;
  labels?: Record<string, string>;
  cwd: string;
  workspaceId?: string | null;
  backgroundWork?: unknown;
}

function makeFakeDaemon(agents: FakeAgentSeed[]): SurfaceDaemonApi {
  return {
    agents: {
      list: async () => ({
        entries: agents.map((agent) => ({
          agent: {
            id: agent.id,
            provider: agent.provider ?? "pi/zai/glm-5.3",
            title: agent.title ?? null,
            status: agent.status ?? "idle",
            model: agent.model ?? "zai/glm-5.3",
            labels: agent.labels ?? {},
            archivedAt: null,
            requiresAttention: false,
            attentionReason: null,
            updatedAt: "2026-10-15T00:00:00.000Z",
            cwd: agent.cwd,
            ...(agent.workspaceId === undefined ? {} : { workspaceId: agent.workspaceId }),
            ...(agent.backgroundWork === undefined ? {} : { backgroundWork: agent.backgroundWork as SurfaceAgentSnapshot["backgroundWork"] }),
          },
        })),
      }),
      create: async () => ({ id: "unused" }),
      ref: () => ({
        send: async () => {},
        archive: async () => ({ archivedAt: new Date().toISOString() }),
        timeline: { refetch: async () => ({ entries: [] }) } as never,
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "pi", available: true }] }),
      listModels: async () => ({ models: [{ id: "zai/glm-5.3", label: "GLM 5.3" }] }),
    },
  };
}

function makeProjectSurface(t: TestContext, buildAgents: (project: { slug: string; root: string }) => FakeAgentSeed[]) {
  const dir = makeTempDir("bg-work-");
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# bg-work\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.ok(resolved.ok);
  writeLanes(stateDir, {
    supervisor: "pi/zai/glm-5.3",
    lead: "pi/zai/glm-5.3",
    worker: "pi/zai/glm-5.3",
    watch: "pi/zai/glm-5.3",
    freshEyes: "pi/zai/glm-5.3",
  });
  writeProjectRegistration(stateDir, resolved.slug, {
    root: resolved.root,
    commonDir: resolved.gitCommonDir,
    name: "bg-work-proj",
    workspaceId: "ws-root",
  });
  const rootFactory = createFactory({ stateDir, eyeCliProbe: () => false });
  const registry = createFactoryRegistry({ stateDir, root: rootFactory });
  t.after(() => registry.stop());
  const projectFactory = registry.factoryForProject(resolved.slug);
  const agents = buildAgents({ slug: resolved.slug, root: resolved.root });
  const daemon = makeFakeDaemon(agents);
  const handlers = createSurfaceHandlers({
    factory: rootFactory,
    registry,
    stateDir,
    home,
    daemon,
    usagePaths: { userHome: dir, stateDir },
    listPlugins: async () => ({ ok: true, plugins: [] }),
  });
  return { project: { slug: resolved.slug, root: resolved.root }, projectFactory, handlers };
}

test("shared view schemas accept omitted and non-negative int backgroundWorkCount and reject invalid counts", () => {
  const agentBase = {
    id: "a1",
    title: "Lead",
    status: "idle",
    provider: "pi",
    model: "zai/glm-5.3",
    seat: "lead",
    task: null,
    requiresAttention: false,
    cwd: "/tmp/repo",
  };
  const lane = { provider: "pi", model: "zai/glm-5.3", scope: "machine" as const };
  const context = { state: "unknown" as const, usedTokens: null, markTokens: 100_000, label: "context unknown", fraction: null };
  const seatRowBase = {
    lane,
    pendingLane: null,
    markTokens: 100_000,
    handoff: null,
    allowedActions: ["switch-model" as const],
    role: "lead" as const,
    vacant: false,
    agentId: "a1",
    statusLabel: "idle",
    tone: "normal" as const,
    model: "zai/glm-5.3",
    hint: null,
    context,
  };
  const peerRowBase = {
    lane,
    pendingLane: null,
    markTokens: 100_000,
    handoff: null,
    allowedActions: ["switch-model" as const],
    role: "peer" as const,
    context,
    agentId: "p1",
    task: "T-01",
    title: "Peer · T-01",
    disposition: "engineer" as const,
    statusLabel: "idle",
    tone: "normal" as const,
    model: "zai/glm-5.3",
  };
  const dirBase = {
    lane,
    pendingLane: null,
    markTokens: 100_000,
    handoff: null,
    allowedActions: ["switch-model" as const],
    context,
    task: null,
    quickSwitchModels: [],
    slug: "proj",
    workspaceId: "ws-1",
    agentId: "a1",
    role: "lead" as const,
    provider: "pi",
    model: "zai/glm-5.3",
    thinking: null,
    contextUsedTokens: null,
    handoffState: null,
  };

  for (const [schema, base] of [
    [AgentViewSchema, agentBase],
    [PanelSeatRowSchema, seatRowBase],
    [PanelPeerRowSchema, peerRowBase],
    [SeatDirectoryEntrySchema, dirBase],
  ] as const) {
    assert.doesNotThrow(() => schema.parse(base));
    assert.doesNotThrow(() => schema.parse({ ...base, backgroundWorkCount: 0 }));
    assert.doesNotThrow(() => schema.parse({ ...base, backgroundWorkCount: 3 }));
    assert.throws(() => schema.parse({ ...base, backgroundWorkCount: -1 }));
    assert.throws(() => schema.parse({ ...base, backgroundWorkCount: 1.5 }));
    assert.throws(() => schema.parse({ ...base, backgroundWorkCount: "2" }));
  }
});

test("snapshot and seatsDirectory project backgroundWork.count (> 0 and === 0) across AgentView, panel rows, and directory seats without altering status", async (t) => {
  const { project, projectFactory, handlers } = makeProjectSurface(t, (p): FakeAgentSeed[] => [
    {
      id: "sup-1",
      status: "idle",
      labels: { seat: "supervisor", project: p.slug },
      cwd: p.root,
      workspaceId: "ws-sup",
      backgroundWork: { count: 2 },
    },
    {
      id: "lead-1",
      status: "idle",
      labels: { seat: "lead", project: p.slug },
      cwd: p.root,
      workspaceId: "ws-lead",
      backgroundWork: { count: 0 },
    },
    {
      id: "peer-1",
      status: "idle",
      labels: { seat: "agent", project: p.slug, task: "T-01" },
      cwd: p.root,
      workspaceId: "ws-peer-1",
      backgroundWork: { count: 4 },
    },
    {
      id: "peer-2",
      status: "running",
      labels: { seat: "agent", project: p.slug, task: "T-02" },
      cwd: p.root,
      workspaceId: "ws-peer-2",
      backgroundWork: { count: 0 },
    },
  ]);

  projectFactory.setContract({ task: "T-01", workspace: project.root, gate: "true" });
  projectFactory.setContract({ task: "T-02", workspace: project.root, gate: "true" });

  const snap = await handlers.snapshot({ projectRoot: project.root });
  assert.ok(snap.ok);
  const parsedSnap = FactoryViewSchema.parse(snap.view);

  assert.equal(parsedSnap.supervisor?.backgroundWorkCount, 2);
  assert.equal(parsedSnap.lead?.backgroundWorkCount, 0);
  assert.equal(parsedSnap.agents.find((a) => a.id === "peer-1")?.backgroundWorkCount, 4);
  assert.equal(parsedSnap.agents.find((a) => a.id === "peer-2")?.backgroundWorkCount, 0);

  const seats = parsedSnap.panel.seats!;
  assert.equal(seats.supervisor.backgroundWorkCount, 2);
  assert.equal(seats.supervisor.statusLabel, "idle");
  assert.equal(seats.supervisor.tone, "normal");

  assert.equal(seats.lead.backgroundWorkCount, 0);
  assert.equal(seats.lead.statusLabel, "idle");
  assert.equal(seats.lead.tone, "normal");

  const peer1Row = seats.peers.find((p) => p.agentId === "peer-1")!;
  const peer2Row = seats.peers.find((p) => p.agentId === "peer-2")!;
  assert.equal(peer1Row.backgroundWorkCount, 4);
  assert.equal(peer1Row.statusLabel, "idle");
  assert.equal(peer1Row.tone, "normal");
  assert.equal(peer2Row.backgroundWorkCount, 0);
  assert.equal(peer2Row.statusLabel, "working");
  assert.equal(peer2Row.tone, "normal");

  const dir = await handlers.seatsDirectory({});
  assert.ok(dir.ok);
  const parsedDir = seatsDirectoryRpc.output.parse(dir);
  assert.ok(parsedDir.ok);
  assert.equal(parsedDir.seats.find((s) => s.agentId === "sup-1")?.backgroundWorkCount, 2);
  assert.equal(parsedDir.seats.find((s) => s.agentId === "lead-1")?.backgroundWorkCount, 0);
  assert.equal(parsedDir.seats.find((s) => s.agentId === "peer-1")?.backgroundWorkCount, 4);
  assert.equal(parsedDir.seats.find((s) => s.agentId === "peer-2")?.backgroundWorkCount, 0);
});

test("absent or invalid daemon backgroundWork omits backgroundWorkCount cleanly (<0.16.0 compatibility)", async (t) => {
  const { project, projectFactory, handlers } = makeProjectSurface(t, (p): FakeAgentSeed[] => [
    // <0.16.0 daemon: backgroundWork omitted entirely
    {
      id: "sup-legacy",
      status: "idle",
      labels: { seat: "supervisor", project: p.slug },
      cwd: p.root,
      workspaceId: "ws-sup",
    },
    // invalid shapes: negative, float, null, non-number, NaN
    {
      id: "lead-invalid",
      status: "idle",
      labels: { seat: "lead", project: p.slug },
      cwd: p.root,
      workspaceId: "ws-lead",
      backgroundWork: { count: -2 },
    },
    {
      id: "peer-null",
      status: "idle",
      labels: { seat: "agent", project: p.slug, task: "T-01" },
      cwd: p.root,
      backgroundWork: null,
    },
    {
      id: "peer-float",
      status: "idle",
      labels: { seat: "agent", project: p.slug, task: "T-02" },
      cwd: p.root,
      backgroundWork: { count: 1.5 },
    },
    {
      id: "peer-nan",
      status: "idle",
      labels: { seat: "agent", project: p.slug, task: "T-03" },
      cwd: p.root,
      backgroundWork: { count: Number.NaN },
    },
    {
      id: "peer-str",
      status: "idle",
      labels: { seat: "agent", project: p.slug, task: "T-04" },
      cwd: p.root,
      backgroundWork: { count: "3" },
    },
  ]);

  for (const task of ["T-01", "T-02", "T-03", "T-04"]) {
    projectFactory.setContract({ task, workspace: project.root, gate: "true" });
  }

  const snap = await handlers.snapshot({ projectRoot: project.root });
  assert.ok(snap.ok);
  assert.equal(snap.view.daemonError, null);
  const parsedSnap = FactoryViewSchema.parse(snap.view);

  assert.equal("backgroundWorkCount" in parsedSnap.supervisor!, false);
  assert.equal("backgroundWorkCount" in parsedSnap.lead!, false);
  assert.equal("backgroundWorkCount" in parsedSnap.panel.seats!.supervisor, false);
  assert.equal("backgroundWorkCount" in parsedSnap.panel.seats!.lead, false);
  for (const peerRow of parsedSnap.panel.seats!.peers) {
    assert.equal("backgroundWorkCount" in peerRow, false, `${peerRow.agentId} should omit invalid/absent backgroundWorkCount`);
  }

  const dir = await handlers.seatsDirectory({});
  assert.ok(dir.ok);
  assert.equal(dir.daemonError, null);
  const parsedDir = seatsDirectoryRpc.output.parse(dir);
  assert.ok(parsedDir.ok);
  for (const seat of parsedDir.seats) {
    assert.equal("backgroundWorkCount" in seat, false, `${seat.agentId} directory entry should omit invalid/absent backgroundWorkCount`);
  }
});

test("foldPanel propagates optional backgroundWorkCount on seatRow and peerRows and omits it on vacant seats", () => {
  const makeAgent = (id: string, seat: string | null, task: string | null, backgroundWorkCount?: number): AgentView => ({
    id,
    title: id,
    status: "idle",
    provider: "pi",
    model: "zai/glm-5.3",
    seat,
    task,
    requiresAttention: false,
    cwd: "/tmp/repo",
    ...(backgroundWorkCount === undefined ? {} : { backgroundWorkCount }),
  });

  const lead = makeAgent("lead-1", "lead", null, 3);
  const peerWithZero = makeAgent("peer-0", null, "T-01", 0);
  const peerLegacy = makeAgent("peer-legacy", null, "T-02");

  const input: PanelInput = {
    project: { slug: "proj", root: "/tmp/repo" },
    registered: true,
    folder: "/tmp/repo",
    git: { gitRepo: true, hasCommits: true },
    tasks: [
      {
        task: "T-01",
        workspace: "/tmp/repo",
        description: null,
        status: "waiting",
        accepted: false,
        acceptedBy: null,
        lane: null,
        costState: "none",
        costUsd: null,
        needsHumanReason: null,
        choke: { allowed: 0, denied: 0, blocked: 0 },
        attempts: [],
        lastSeq: 1,
      },
      {
        task: "T-02",
        workspace: "/tmp/repo",
        description: null,
        status: "waiting",
        accepted: false,
        acceptedBy: null,
        lane: null,
        costState: "none",
        costUsd: null,
        needsHumanReason: null,
        choke: { allowed: 0, denied: 0, blocked: 0 },
        attempts: [],
        lastSeq: 2,
      },
    ],
    agents: [lead, peerWithZero, peerLegacy],
    supervisor: null,
    lead,
    missingPrerequisites: [],
    openDesign: null,
    rotationState: null,
    handoffRequestedAt: null,
    heldSupervisorMailCount: 0,
    supervisorCandidates: [],
    now: Date.now(),
  };

  const panel = foldPanel(input);
  assert.equal(panel.seats!.supervisor.vacant, true);
  assert.equal("backgroundWorkCount" in panel.seats!.supervisor, false);
  assert.equal(panel.seats!.lead.backgroundWorkCount, 3);
  assert.equal(panel.seats!.peers.find((p) => p.agentId === "peer-0")?.backgroundWorkCount, 0);
  assert.equal("backgroundWorkCount" in panel.seats!.peers.find((p) => p.agentId === "peer-legacy")!, false);
});
