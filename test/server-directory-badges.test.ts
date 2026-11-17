import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { CORE_FACTORY_SKILLS } from "../plugin/server/core/companion-tools.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { createFactoryRegistry, writeProjectRegistration } from "../plugin/server/projects.ts";
import { createSurfaceHandlers, type SurfaceAgentSnapshot, type SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { workspaceRowBadgePlan } from "../plugin/client/kit/directory.ts";
import { seatsDirectory as seatsDirectoryRpc } from "../plugin/shared/rpc.ts";
import { ProjectDirectoryEntrySchema } from "../plugin/shared/view.ts";
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
  attentionReason?: string | null;
  requiresAttention?: boolean;
  lastError?: string;
  backgroundWork?: unknown;
}

function makeFakeDaemon(
  agents: FakeAgentSeed[],
  options: { failList?: boolean } = {},
): SurfaceDaemonApi {
  return {
    agents: {
      list: async () => {
        if (options.failList) throw new Error("daemon unavailable");
        return {
          entries: agents.map((agent) => ({
            agent: {
              id: agent.id,
              provider: agent.provider ?? "pi/zai/glm-5.3",
              title: agent.title ?? null,
              status: agent.status ?? "idle",
              model: agent.model ?? "zai/glm-5.3",
              labels: agent.labels ?? {},
              archivedAt: null,
              requiresAttention: agent.requiresAttention ?? false,
              attentionReason: agent.attentionReason ?? null,
              updatedAt: "2026-10-15T00:00:00.000Z",
              cwd: agent.cwd,
              ...(agent.lastError === undefined ? {} : { lastError: agent.lastError }),
              ...(agent.workspaceId === undefined ? {} : { workspaceId: agent.workspaceId }),
              ...(agent.backgroundWork === undefined ? {} : { backgroundWork: agent.backgroundWork as SurfaceAgentSnapshot["backgroundWork"] }),
            },
          })),
        };
      },
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

function setupDirectorySurface(
  t: TestContext,
  buildAgents: (project: { slug: string; root: string }) => FakeAgentSeed[],
  options: { failList?: boolean } = {},
) {
  const dir = makeTempDir("dir-badges-");
  disposeDir(t, dir);
  for (const name of CORE_FACTORY_SKILLS) {
    mkdirSync(join(dir, ".agents", "skills", name), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", name, "SKILL.md"), `# ${name}\n`);
  }
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# dir-badges\n");
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
    name: "dir-badges-proj",
    workspaceId: "ws-root",
  });
  const rootFactory = createFactory({ stateDir, eyeCliProbe: () => false });
  const registry = createFactoryRegistry({ stateDir, root: rootFactory });
  t.after(() => registry.stop());
  const projectFactory = registry.factoryForProject(resolved.slug);
  const agents = buildAgents({ slug: resolved.slug, root: resolved.root });
  const daemon = makeFakeDaemon(agents, options);
  const handlers = createSurfaceHandlers({
    factory: rootFactory,
    registry,
    stateDir,
    home,
    userHome: dir,
    daemon,
    usagePaths: { userHome: dir, stateDir },
    listPlugins: async () => ({ ok: true, plugins: [] }),
  });
  return { stateDir, project: { slug: resolved.slug, root: resolved.root }, projectFactory, handlers };
}

test("ProjectDirectoryEntrySchema keeps minimal fixtures valid and validates optional badge summary fields", () => {
  const base = { slug: "proj", root: "/tmp/proj", workspaceId: "ws-1", needsYouCount: 0 };
  assert.doesNotThrow(() => ProjectDirectoryEntrySchema.parse(base));
  assert.doesNotThrow(() =>
    ProjectDirectoryEntrySchema.parse({
      ...base,
      handoffActive: true,
      activeWorkCount: 2,
      backgroundWorkCount: 1,
    }),
  );
  assert.throws(() => ProjectDirectoryEntrySchema.parse({ ...base, handoffActive: "yes" }));
  assert.throws(() => ProjectDirectoryEntrySchema.parse({ ...base, activeWorkCount: -1 }));
  assert.throws(() => ProjectDirectoryEntrySchema.parse({ ...base, activeWorkCount: 1.5 }));
  assert.throws(() => ProjectDirectoryEntrySchema.parse({ ...base, backgroundWorkCount: -1 }));
  assert.throws(() => ProjectDirectoryEntrySchema.parse({ ...base, backgroundWorkCount: 2.5 }));
});

test("seatsDirectory projects idle, running/starting seats & Peers, and excludes closed/stranger agents", async (t) => {
  const { project, projectFactory, handlers } = setupDirectorySurface(t, (p): FakeAgentSeed[] => [
    { id: "sup-1", status: "idle", labels: { seat: "supervisor", project: p.slug }, cwd: p.root, workspaceId: "ws-root" },
    { id: "lead-1", status: "initializing", labels: { seat: "lead", project: p.slug }, cwd: p.root, workspaceId: "ws-root" },
    { id: "peer-run", status: "running", labels: { seat: "agent", project: p.slug, task: "T-01" }, cwd: p.root },
    { id: "peer-closed", status: "running", labels: { seat: "agent", project: p.slug, task: "T-02" }, cwd: p.root },
    { id: "stranger", status: "running", labels: {}, cwd: p.root, workspaceId: "ws-other" },
  ]);

  projectFactory.setContract({ task: "T-01", workspace: project.root, gate: "true" });
  projectFactory.setContract({ task: "T-02", workspace: project.root, gate: "true" });
  projectFactory.ledger.append({ event: "task_closed", task: "T-02", reason: "done", by: "lead" });

  const reply = await handlers.seatsDirectory({});
  assert.ok(reply.ok);
  const parsed = seatsDirectoryRpc.output.parse(reply);
  assert.ok(parsed.ok);

  const entry = parsed.projects.find((p) => p.slug === project.slug)!;
  assert.equal(entry.needsYouCount, 0);
  assert.equal(entry.handoffActive, false);
  assert.equal(entry.activeWorkCount, 2, "starting Lead + running open Peer count; closed Peer and stranger do not");
  assert.equal(entry.backgroundWorkCount, 0);
  assert.deepEqual(workspaceRowBadgePlan("ws-root", parsed.projects), {
    label: "2 active",
    tone: "success",
    icon: "Activity",
    accessibilityLabel: "Factory: 2 active seats",
  });
  assert.equal(workspaceRowBadgePlan("ws-other", parsed.projects), null);
});

test("seatsDirectory projects idle backgroundWorkCount and ignores invalid <0.16 payloads", async (t) => {
  const { project, projectFactory, handlers } = setupDirectorySurface(t, (p): FakeAgentSeed[] => [
    { id: "sup-1", status: "idle", labels: { seat: "supervisor", project: p.slug }, cwd: p.root, backgroundWork: { count: 2 } },
    { id: "lead-1", status: "idle", labels: { seat: "lead", project: p.slug }, cwd: p.root, backgroundWork: { count: -1 } },
    { id: "peer-1", status: "idle", labels: { seat: "agent", project: p.slug, task: "T-01" }, cwd: p.root, backgroundWork: { count: 1 } },
    { id: "peer-legacy", status: "idle", labels: { seat: "agent", project: p.slug, task: "T-02" }, cwd: p.root },
  ]);

  projectFactory.setContract({ task: "T-01", workspace: project.root, gate: "true" });
  projectFactory.setContract({ task: "T-02", workspace: project.root, gate: "true" });

  const reply = await handlers.seatsDirectory({});
  assert.ok(reply.ok);
  const parsed = seatsDirectoryRpc.output.parse(reply);
  assert.ok(parsed.ok);

  const entry = parsed.projects.find((p) => p.slug === project.slug)!;
  assert.equal(entry.needsYouCount, 0);
  assert.equal(entry.handoffActive, false);
  assert.equal(entry.activeWorkCount, 0);
  assert.equal(entry.backgroundWorkCount, 3);
  assert.deepEqual(workspaceRowBadgePlan("ws-root", parsed.projects), {
    label: "3 background",
    tone: "warning",
    icon: "Activity",
    accessibilityLabel: "Factory: 3 background processes running",
  });
});

test("seatsDirectory projects handoffActive for active handoff phases and clears on done/failed/closed", async (t) => {
  const { stateDir, project, projectFactory, handlers } = setupDirectorySurface(t, (p) => [
    { id: "sup-1", status: "idle", labels: { seat: "supervisor", project: p.slug }, cwd: p.root },
    { id: "lead-1", status: "running", labels: { seat: "lead", project: p.slug }, cwd: p.root },
  ]);
  const projectDir = join(stateDir, "projects", project.slug);
  const baseHandoff = {
    seat: "lead",
    reason: "provider-change",
    fromLane: { provider: "pi", model: "old" },
    toLane: { provider: "codex", model: "new" },
    startedAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };

  for (const state of ["scheduled", "handing-over", "creating-successor", "substitute"] as const) {
    writeFileSync(join(projectDir, "handoff-lead.json"), JSON.stringify({ ...baseHandoff, state }));
    const reply = await handlers.seatsDirectory({});
    assert.ok(reply.ok);
    const entry = reply.projects.find((p) => p.slug === project.slug)!;
    assert.equal(entry.handoffActive, true, state);
    assert.equal(entry.activeWorkCount, 1);
    assert.equal(workspaceRowBadgePlan("ws-root", reply.projects)?.label, "Handing off", state);
  }

  writeFileSync(join(projectDir, "handoff-lead.json"), JSON.stringify({ ...baseHandoff, state: "done" }));
  const doneReply = await handlers.seatsDirectory({});
  assert.ok(doneReply.ok);
  const doneEntry = doneReply.projects.find((p) => p.slug === project.slug)!;
  assert.equal(doneEntry.handoffActive, false);
  assert.equal(doneEntry.needsYouCount, 0);
  assert.equal(workspaceRowBadgePlan("ws-root", doneReply.projects)?.label, "1 active");

  writeFileSync(join(projectDir, "handoff-lead.json"), JSON.stringify({ ...baseHandoff, state: "failed", failure: "boom" }));
  const failedReply = await handlers.seatsDirectory({});
  assert.ok(failedReply.ok);
  const failedEntry = failedReply.projects.find((p) => p.slug === project.slug)!;
  assert.equal(failedEntry.handoffActive, false, "failed handoff surfaces through needsYouCount, not handoffActive");
  assert.equal(failedEntry.needsYouCount, 1);
  assert.equal(workspaceRowBadgePlan("ws-root", failedReply.projects)?.label, "Needs you · 1");

  // Closed Peer handoff file no longer flags handoffActive
  writeFileSync(join(projectDir, "handoff-lead.json"), JSON.stringify({ ...baseHandoff, state: "done" }));
  projectFactory.setContract({ task: "T-09", workspace: project.root, gate: "true" });
  writeFileSync(
    join(projectDir, "handoff-peer-T-09.json"),
    JSON.stringify({ ...baseHandoff, seat: "peer:T-09", reason: "owner", state: "handing-over" }),
  );
  const peerHandoff = await handlers.seatsDirectory({});
  assert.ok(peerHandoff.ok);
  assert.equal(peerHandoff.projects[0]!.handoffActive, true);
  projectFactory.ledger.append({ event: "task_closed", task: "T-09", reason: "superseded", by: "lead" });
  const closedPeer = await handlers.seatsDirectory({});
  assert.ok(closedPeer.ok);
  assert.equal(closedPeer.projects[0]!.handoffActive, false);
});

test("seatsDirectory preserves needsYouCount and projects all summary fields simultaneously", async (t) => {
  const { stateDir, project, handlers } = setupDirectorySurface(t, (p) => [
    {
      id: "sup-1",
      status: "error",
      lastError: "rate limited",
      labels: { seat: "supervisor", project: p.slug },
      cwd: p.root,
      backgroundWork: { count: 2 },
    },
    {
      id: "lead-1",
      status: "running",
      labels: { seat: "lead", project: p.slug },
      cwd: p.root,
    },
  ]);

  const projectDir = join(stateDir, "projects", project.slug);
  writeFileSync(
    join(projectDir, "handoff-lead.json"),
    JSON.stringify({
      seat: "lead",
      reason: "context-mark",
      state: "handing-over",
      fromLane: { provider: "pi", model: "old" },
      toLane: { provider: "pi", model: "old" },
      startedAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z",
    }),
  );

  const reply = await handlers.seatsDirectory({});
  assert.ok(reply.ok);
  const entry = reply.projects.find((p) => p.slug === project.slug)!;
  assert.equal(entry.needsYouCount, 1);
  assert.equal(entry.handoffActive, true);
  assert.equal(entry.activeWorkCount, 1);
  assert.equal(entry.backgroundWorkCount, 2);
  assert.deepEqual(workspaceRowBadgePlan("ws-root", reply.projects), {
    label: "Needs you · 1",
    tone: "warning",
    icon: "AlertTriangle",
    accessibilityLabel: "Factory: Needs you · 1",
  });
});

test("seatsDirectory degrades cleanly when daemon listing fails and all seats are idle/absent", async (t) => {
  const { project, handlers } = setupDirectorySurface(t, () => [], { failList: true });

  const reply = await handlers.seatsDirectory({});
  assert.ok(reply.ok);
  assert.match(reply.daemonError ?? "", /daemon unavailable/);
  const entry = reply.projects.find((p) => p.slug === project.slug)!;
  assert.equal(entry.needsYouCount, 0);
  assert.equal(entry.handoffActive, false);
  assert.equal(entry.activeWorkCount, 0);
  assert.equal(entry.backgroundWorkCount, 0);
  assert.equal(workspaceRowBadgePlan("ws-root", reply.projects), null);
});
