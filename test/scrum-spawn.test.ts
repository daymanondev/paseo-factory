import type { AgentCreateRequest } from "../plugin/server/roles.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/factory.ts";
import { makeTempDir, disposeDir, gitCommitAll } from "./helpers.ts";
import type { ScrumTaskBinding } from "../src/scrum/types.ts";

test("Contract ledger preserves validated immutable Scrum identity; legacy Contracts remain unbound", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  const repo = makeTempDir();
  disposeDir(t, repo);
  writeFileSync(join(repo, "README.md"), "fixture");
  gitCommitAll(repo);
  const factory = createFactory({ stateDir: state });
  const execution: ScrumTaskBinding = {
    mode: "scrum",
    runId: "r1",
    role: "qa",
    policyRevision: "1",
    configRevision: 2,
    artifactRefs: [],
  };
  const evt = factory.setContract({
    task: "qa-story",
    workspace: repo,
    gate: "true",
    execution,
  });
  assert.deepEqual(evt.execution, execution);
  assert.throws(
    () =>
      factory.setContract({
        task: "bad",
        workspace: repo,
        gate: "true",
        execution: {
          ...execution,
          role: "lead",
        } as unknown as ScrumTaskBinding,
      }),
    /invalid Scrum execution/,
  );
  const reopened = createFactory({ stateDir: state });
  assert.deepEqual(reopened.contractFor("qa-story")!.execution, execution);
});

test("mixed Projects preserve SLP homes and freeze Scrum role/model through create and session open", async (t) => {
  const { createFactory: createPluginFactory } = await import(
    "../plugin/server/core/factory.ts"
  );
  const { resolveProject, ensureProjectRegistered } = await import(
    "../plugin/server/core/project.ts"
  );
  const { ensureScrumConfig, saveScrumConfig } = await import(
    "../plugin/server/core/scrum/config.ts"
  );
  const { switchExecution } = await import(
    "../plugin/server/core/scrum/execution.ts"
  );
  const { createScrumRun } = await import(
    "../plugin/server/core/scrum/run-journal.ts"
  );
  const { handleSpoolRequest } = await import("../plugin/server/spool.ts");
  const { injectRoleOnCreate, injectSessionEnv } = await import(
    "../plugin/server/roles.ts"
  );
  const { prepareTaskWorktree } = await import(
    "../plugin/server/core/workspace.ts"
  );
  const { readFileSync, existsSync } = await import("node:fs");
  const state = makeTempDir();
  disposeDir(t, state);
  const userHome = makeTempDir();
  disposeDir(t, userHome);
  const repo = makeTempDir();
  disposeDir(t, repo);
  writeFileSync(join(repo, "README.md"), "fixture");
  gitCommitAll(repo);
  const project = resolveProject(repo);
  assert.equal(project.ok, true);
  if (!project.ok) return;
  ensureProjectRegistered(state, project);
  const factory = createPluginFactory({ stateDir: state });
  const legacy = factory.setContract({
    task: "legacy",
    workspace: repo,
    gate: "true",
  });
  const legacyWorktree = prepareTaskWorktree({
    stateDir: state,
    workspace: repo,
    task: "legacy",
    base: legacy.base,
  });
  assert.equal(legacyWorktree.ok, true);
  if (!legacyWorktree.ok) return;
  const slp = injectRoleOnCreate(
    {
      config: {
        cwd: legacyWorktree.path,
        provider: "pi/test",
        title: "legacy",
      },
    } as AgentCreateRequest,
    state,
    userHome,
  )!;
  assert.equal(slp.env!.PI_CODING_AGENT_DIR, join(state, "pi-agent/agent"));
  const before = readFileSync(
    join(state, "pi-agent/agent/APPEND_SYSTEM.md"),
    "utf8",
  );
  await switchExecution({
    state,
    slug: project.slug,
    mode: "scrum",
    blockers: [],
    rotate: async () => {},
  });
  let config = ensureScrumConfig(state, project.slug);
  config = saveScrumConfig(
    state,
    { ...config, lanes: { ...config.lanes, pm: "claude/plan-model" } },
    project.slug,
  );
  createScrumRun({
    state,
    slug: project.slug,
    runId: "run-a",
    initiativeId: "delivery",
    config,
    configRevision: config.configRevision!,
    track: "backend",
    rationale: "API",
    requestId: "create",
    ownedPaths: [
      ".scratch/delivery/prd.md",
      ".scratch/delivery/decisions/plan.jsonl",
    ],
  });
  const contracted = await handleSpoolRequest(factory, {
    id: "c1",
    kind: "contract",
    task: "plan",
    workspace: repo,
    gate: "true",
    role: "pm",
    runId: "run-a",
    submitter: "owner",
  });
  assert.equal(contracted.ok, true, JSON.stringify(contracted));
  const contract = factory.contractFor("plan")!;
  const wt = prepareTaskWorktree({
    stateDir: state,
    workspace: repo,
    task: "plan",
    base: contract.base,
  });
  assert.equal(wt.ok, true);
  if (!wt.ok) return;
  const { normalizeAgentCreateRequest } = await import("../plugin/server/choke.ts");
  const normalizedTask = normalizeAgentCreateRequest({ config: { cwd: wt.path, provider: "factory-peer", thinkingOptionId: "stale" } }, { stateDir: state });
  assert.equal(normalizedTask.config.provider, "claude");
  assert.equal(Object.hasOwn(normalizedTask.config, "thinkingOptionId"), false);
  const { resolveEffectiveProviderFamily } = await import("../plugin/server/roles.ts");
  assert.equal(resolveEffectiveProviderFamily("factory-peer", "agent", state, project.slug, "plan"), "claude");
  writeFileSync(join(repo, "AGENTS.md"), "root-only untracked memory");
  assert.equal(existsSync(join(wt.path, "AGENTS.md")), false);
  const injected = injectRoleOnCreate(
    {
      config: { cwd: wt.path, provider: "pi/wrong-default" },
    } as AgentCreateRequest,
    state,
    userHome,
  )!;
  assert.equal(injected.config.provider, "claude");
  assert.equal(
    (injected.config as Record<string, unknown>).model,
    "plan-model",
  );
  assert.equal(injected.config.title, "PM · plan");
  assert.equal(injected.env!.PASEO_FACTORY_SEAT, "agent");
  assert.equal(
    injected.env!.PI_CODING_AGENT_DIR,
    join(
      state,
      "projects",
      project.slug,
      "scrum/harness/runs/run-a/plan",
      String(contract.seq),
    ),
  );
  const managedPrompt = readFileSync(join(injected.env!.PI_CODING_AGENT_DIR, "APPEND_SYSTEM.md"), "utf8");
  assert.match(managedPrompt, /AGENTS.md.*absent/);
  assert.doesNotMatch(managedPrompt, /read before acting: AGENTS.md/);
  saveScrumConfig(
    state,
    { ...config, lanes: { ...config.lanes, pm: "pi/new-plan" } },
    project.slug,
  );
  const reopened = injectSessionEnv(
    { agentId: "pm-1", cwd: wt.path, env: injected.env! },
    state,
    userHome,
  )!;
  assert.equal(
    reopened.env.PI_CODING_AGENT_DIR,
    injected.env!.PI_CODING_AGENT_DIR,
  );
  assert.equal(
    readFileSync(join(state, "pi-agent/agent/APPEND_SYSTEM.md"), "utf8"),
    before,
  );
  const mismatch = await handleSpoolRequest(factory, {
    id: "mismatch",
    kind: "spawn",
    task: "plan",
    provider: "pi/default",
    arity: 1,
    role: "dev",
    runId: "run-a",
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, "task-execution-mismatch");
  assert.equal(existsSync(join(state, "pi-agent/pm")), false);
});

test("Scrum create hooks preserve authority and provider-specific fences across all supported families", async (t) => {
  const { scopeScrumCapabilities } = await import(
    "../plugin/server/core/scrum/harness.ts"
  );
  const { applyProviderExecutionFence } = await import(
    "../plugin/server/roles.ts"
  );
  const state = makeTempDir();
  disposeDir(t, state);
  const home = makeTempDir();
  disposeDir(t, home);
  const identity = {
    kind: "task" as const,
    task: "ux",
    epoch: 1,
    binding: {
      mode: "scrum" as const,
      runId: "r",
      role: "ux" as const,
      policyRevision: "1",
      configRevision: 1,
      artifactRefs: [],
    },
  };
  for (const provider of [
    "pi",
    "claude",
    "codex",
    "opencode",
    "copilot",
    "omp",
    "antigravity",
  ]) {
    const config = applyProviderExecutionFence(
      {
        cwd: home,
        provider,
        mcpServers: { "zai-vision": {}, dangerousCoordinator: {} },
        systemPrompt: "UX role",
      },
      {
        role: "agent",
        stateDir: state,
        projectSlug: "p",
        task: "ux",
        correlationId: "cor-ux",
        userHome: home,
      },
    );
    const scoped = scopeScrumCapabilities(config, "agent", identity);
    assert.match(scoped.systemPrompt!, /frontend-design/);
    assert.equal(scoped.mcpServers?.dangerousCoordinator, undefined);
    if (provider !== "antigravity")
      assert.ok((scoped.mcpServers as Record<string, unknown>)?.paseo_factory);
    const standing = scopeScrumCapabilities(config, "lead", {
      kind: "seat",
      selectionRevision: 1,
      config: {
        schemaVersion: 1,
        requireUiApproval: true,
        lanes: Object.fromEntries(
          [
            "supervisor",
            "lead",
            "pm",
            "ux",
            "architect",
            "dev",
            "qa",
            "watch",
            "retro",
          ].map((k) => [k, "pi/model"]),
        ) as import("../src/scrum/config.ts").ScrumConfig["lanes"],
      },
    });
    assert.equal(standing.mcpServers?.["zai-vision"], undefined);
  }
});

test("a new Scrum contract request opens an epoch and retires the prior Agent; exact replay keeps that epoch", async (t) => {
  const { createFactory } = await import("../plugin/server/core/factory.ts");
  const { resolveProject } = await import("../plugin/server/core/project.ts");
  const { ensureScrumConfig } = await import(
    "../plugin/server/core/scrum/config.ts"
  );
  const { switchExecution } = await import(
    "../plugin/server/core/scrum/execution.ts"
  );
  const { createScrumRun, readRun } = await import(
    "../plugin/server/core/scrum/run-journal.ts"
  );
  const { handleSpoolRequest } = await import("../plugin/server/spool.ts");
  const state = makeTempDir();
  disposeDir(t, state);
  const repo = makeTempDir();
  disposeDir(t, repo);
  writeFileSync(join(repo, "README.md"), "fixture");
  gitCommitAll(repo);
  const project = resolveProject(repo);
  assert.ok(project.ok);
  if (!project.ok) return;
  const factory = createFactory({ stateDir: state });
  await switchExecution({
    state,
    slug: project.slug,
    mode: "scrum",
    blockers: [],
    rotate: async () => {},
  });
  createScrumRun({
    state,
    slug: project.slug,
    runId: "r",
    initiativeId: "recontract",
    config: ensureScrumConfig(state, project.slug),
    configRevision: 1,
    track: "backend",
    rationale: "planning",
    requestId: "create",
    ownedPaths: [".scratch/recontract/prd.md"],
  });
  const first = {
    id: "first",
    kind: "contract" as const,
    task: "pm",
    workspace: repo,
    gate: "true",
    role: "pm" as const,
    runId: "r",
    submitter: "owner",
  };
  assert.equal((await handleSpoolRequest(factory, first)).ok, true);
  const epoch1 = factory.contractFor("pm")!.seq;
  const stopped: string[] = [],
    archived: string[] = [];
  const daemon = {
    agents: {
      list: async () => ({
        entries: [
          {
            agent: {
              id: "old-peer",
              provider: "pi/test",
              status: "running",
              model: null,
              title: "PM",
              labels: { project: project.slug, task: "pm", seat: "agent" },
              archivedAt: null,
            },
          },
        ],
      }),
      ref: (id: string) => ({
        archive: async () => {
          archived.push(id);
        },
      }),
    },
  } as unknown as import("../plugin/server/surface-rpc.ts").SurfaceDaemonApi;
  const second = {
    ...first,
    id: "second",
    gate: "test -d .",
    description: "revised bounded planning criteria",
  };
  const failed = await handleSpoolRequest(factory, second, {
    daemon,
    stopAgent: async (id) => {
      stopped.push(id);
      return { ok: false, reason: "trial failure" };
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(archived.length, 0);
  const pendingEpoch = factory.contractFor("pm")!.seq;
  const spawn = await handleSpoolRequest(factory, {
    id: "pending-spawn",
    kind: "spawn",
    task: "pm",
    provider: "pi/test",
    arity: 1,
  });
  assert.equal(spawn.ok, false);
  if (!spawn.ok) assert.equal(spawn.code, "scrum-run-blocked");
  const concurrent = await handleSpoolRequest(factory, {
    ...second,
    id: "different",
    gate: "false",
  });
  assert.equal(concurrent.ok, false);
  if (!concurrent.ok) assert.equal(concurrent.code, "contract-intent-pending");
  assert.equal(
    (
      await handleSpoolRequest(factory, second, {
        daemon,
        stopAgent: async (id) => {
          stopped.push(id);
          return { ok: true };
        },
      })
    ).ok,
    true,
  );
  const epoch2 = factory.contractFor("pm")!.seq;
  assert.ok(epoch2 > epoch1);
  assert.match(factory.contractFor("pm")!.gate, /test -d/);
  assert.equal(factory.contractFor("pm")!.description, second.description);
  assert.equal(epoch2, pendingEpoch);
  assert.deepEqual(stopped, ["old-peer", "old-peer"]);
  assert.deepEqual(archived, ["old-peer"]);
  assert.equal((await handleSpoolRequest(factory, second)).ok, true);
  assert.equal(factory.contractFor("pm")!.seq, epoch2);
  assert.equal(readRun(state, project.slug, "r").tasks[0].epoch, epoch2);
  const invalid = { ...second, id: "invalid", gate: "" };
  const rejected = await handleSpoolRequest(factory, invalid);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, "invalid-contract");
  assert.equal(
    (await handleSpoolRequest(factory, { ...second, id: "corrected" })).ok,
    true,
  );
  const epoch3 = factory.contractFor("pm")!.seq;
  assert.ok(epoch3 > epoch2);
  assert.equal(
    (
      await handleSpoolRequest(factory, second, {
        daemon,
        stopAgent: async () => {
          throw Error("old replay must not stop new epoch");
        },
      })
    ).ok,
    true,
  );
  assert.equal(factory.contractFor("pm")!.seq, epoch3);
  const { commandRun } = await import(
    "../plugin/server/core/scrum/run-journal.ts"
  );
  const run = readRun(state, project.slug, "r");
  commandRun(state, project.slug, "r", {
    type: "cancellation_requested",
    requestId: "cancel",
    expectedRevision: run.revision,
    actor: "owner",
    reason: "stop",
  });
  assert.throws(
    () =>
      commandRun(state, project.slug, "r", {
        type: "phase_changed",
        phase: "planning",
        reason: "bypass",
        requestId: "bypass",
        expectedRevision: run.revision + 1,
      }),
    /resume request cancel/,
  );
  const cancelledSpawn = await handleSpoolRequest(factory, {
    id: "cancelled-spawn",
    kind: "spawn",
    task: "pm",
    provider: "pi/test",
    arity: 1,
  });
  assert.equal(cancelledSpawn.ok, false);
  if (!cancelledSpawn.ok)
    assert.equal(cancelledSpawn.code, "scrum-run-blocked");
});

test("parallel UX and Architect land disjoint artifacts from one accepted PRD in managed worktrees", async (t) => {
  const { mkdirSync, readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { createFactory } = await import("../plugin/server/core/factory.ts");
  const { resolveProject } = await import("../plugin/server/core/project.ts");
  const { ensureScrumConfig } = await import(
    "../plugin/server/core/scrum/config.ts"
  );
  const { switchExecution } = await import(
    "../plugin/server/core/scrum/execution.ts"
  );
  const { createScrumRun, readRun } = await import(
    "../plugin/server/core/scrum/run-journal.ts"
  );
  const { handleSpoolRequest } = await import("../plugin/server/spool.ts");
  const { prepareTaskWorktree } = await import(
    "../plugin/server/core/workspace.ts"
  );
  const { artifactAt } = await import(
    "../plugin/server/core/scrum/artifacts.ts"
  );
  const { scrumOperation } = await import(
    "../plugin/server/core/scrum/controller.ts"
  );
  const state = makeTempDir(),
    repo = makeTempDir();
  disposeDir(t, state);
  disposeDir(t, repo);
  writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
  writeFileSync(join(repo, "product.txt"), "baseline\n");
  gitCommitAll(repo);
  mkdirSync(join(repo, ".scratch"), { recursive: true });
  writeFileSync(
    join(repo, ".scratch/local-tracker.md"),
    "must remain untracked",
  );
  const project = resolveProject(repo);
  assert.ok(project.ok);
  if (!project.ok) return;
  const slug = project.slug;
  const factory = createFactory({ stateDir: state });
  await switchExecution({
    state,
    slug: slug,
    mode: "scrum",
    blockers: [],
    rotate: async () => {},
  });
  const prefix = ".scratch/parallel";
  const files = {
    pm: {
      "prd.md":
        "# Outcome\nRead records.\n# Out of Scope\nRemote writes.\n## FR-1: read records\n## NFR-1: offline is read-only\n## UJ-1: inspect record\n",
      "sprint-backlog.md":
        "# R1: read records\nSource: FR-1 NFR-1 UJ-1\n# S-01: tracer\nCovers: R1\nTests: product.txt\n",
      "decisions/pm.jsonl": '{"id":"P1","rationale":"read only"}\n',
    },
    ux: {
      ...(await import("./fixtures/open-design.ts")).openDesignFiles(),
      "ux-spec.md": "# UX spec\nSee DESIGN.md, EXPERIENCE.md and mockups/index.html for the complete accepted design.\n",
      "DESIGN.md":
        "# Direction\nColor: navy.\nTypography: system-ui.\nSpacing: 8px.\nComponent: record card.\n",
      "EXPERIENCE.md":
        "# Information architecture and flow\n## Screen: viewer\nSurface: desktop\nOne screen justified for the bounded record viewer. Offline writes permitted.\n| Screen | empty | loading | populated | error | offline | permission-denied |\n| viewer | no record | wait | record | retry | editable | denied |\n",
      "mockups/index.html":
        "<!doctype html><html><head><title>Record viewer</title></head><body><main>" +
        '<button>Open record</button>' +
        "</main><script>const q=new URLSearchParams(location.search);document.documentElement.dataset.screen=q.get('screen')||'viewer';document.documentElement.dataset.state=q.get('state')||'populated';window.addEventListener('message',e=>{if(e.data.type==='scrum:set-state'){document.documentElement.dataset.screen=e.data.screen;document.documentElement.dataset.state=e.data.state}})</script></body></html>",
      "mockups/design-manifest.json": JSON.stringify({ directionId: 'modern-minimal', tokens: { '--ink': '#183153' }, screens: [{id:'viewer',surface:'desktop'}], journeyGroups: [{id:'system',title:'System & Edge States',screens:['viewer']}], componentPatterns:['record card'] }),
      "mockups/browser.json": JSON.stringify({ network:'disabled',consoleErrors:[],pageErrors:[],screens:[{id:'viewer',surface:'desktop'}],viewports:[{screen:'viewer',width:1280,height:800,scrollWidth:1280,clientWidth:1280,screenshot:{path:'.scratch/parallel/mockups/viewer.png',sha256:(await import('../src/scrum/artifacts.ts')).sha256((await import('./fixtures/scrum-design.ts')).png)}},{screen:'screens-board',width:1280,height:800,scrollWidth:1280,clientWidth:1280,screenshot:{path:'.scratch/parallel/mockups/screens-board.png',sha256:(await import('../src/scrum/artifacts.ts')).sha256((await import('./fixtures/scrum-design.ts')).png)}}],states:(await import('./fixtures/scrum-design.ts')).states.map(state=>({screen:'viewer',state,keyboard:true,passed:true})),detector:{tool:'open-design',passed:true,nonAdvisoryCount:0,viewportsChecked:[{screen:'viewer',width:1280,height:800,nonAdvisoryCount:0}]}}),
      "mockups/viewer.png": (await import('./fixtures/scrum-design.ts')).png,
      "mockups/screens-board.png": (await import('./fixtures/scrum-design.ts')).png,
      "decisions/ux.jsonl":
        '{"id":"U1","rationale":"offline writes permitted pending reconciliation"}\n',
    },
    architect: {
      "architecture.md":
        "# Stack\nNode v24 runtime evidence from node --version; product.txt is the existing repository boundary.\n## AD-1: offline ownership\nBinds: API\nPrevents: disconnected writes\nRule: offline is read-only\n",
      "decisions/architect.jsonl":
        '{"id":"A1","rationale":"offline writes forbidden"}\n',
    },
  };
  const ownedPaths = Object.values(files).flatMap((f) =>
    Object.keys(f).map((p) => `${prefix}/${p}`),
  );
  createScrumRun({
    state,
    slug: slug,
    runId: "parallel",
    initiativeId: "parallel",
    config: ensureScrumConfig(state, slug),
    configRevision: 1,
    track: "ui",
    rationale: "disjoint design wave",
    requestId: "create",
    ownedPaths,
  });
  const context = {
    factory,
    root: repo,
    slug: slug,
    authority: "lead" as const,
    actor: "lead",
    activeAgents: [],
    pendingDirectives: false,
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  async function prepare(role: keyof typeof files) {
    const task = role;
    const reply = await handleSpoolRequest(factory, {
      id: `contract-${task}`,
      kind: "contract",
      submitter: "owner",
      task,
      workspace: repo,
      gate: "test -f product.txt",
      runId: "parallel",
      role,
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const contract = factory.contractFor(task)!;
    if (role !== "pm")
      assert.equal(
        contract.execution!.artifactRefs[0].path,
        `${prefix}/prd.md`,
      );
    const wt = prepareTaskWorktree({
      stateDir: state,
      workspace: repo,
      task,
      base: contract.base,
    });
    assert.ok(wt.ok);
    if (!wt.ok) throw Error("worktree");
    const spawn = await handleSpoolRequest(factory, {
      id: `spawn-${task}`,
      kind: "spawn",
      task,
      provider: "",
      arity: 1,
      worktree: wt.path,
    });
    assert.equal(spawn.ok, true, JSON.stringify(spawn));
    for (const [path, bytes] of Object.entries(files[role])) {
      const full = join(wt.path, prefix, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, bytes);
      git(wt.path, "add", "-f", "--", `${prefix}/${path}`);
    }
    git(wt.path, "commit", "-m", `deliver ${role}`);
    return {
      task,
      sha: git(wt.path, "rev-parse", "HEAD"),
      paths: Object.keys(files[role]).map((p) => `${prefix}/${p}`),
    };
  }
  async function accept(item: Awaited<ReturnType<typeof prepare>>) {
    const claim = await factory.claim({ task: item.task, sha: item.sha });
    assert.equal(claim.verdict, "green", claim.gate.note);
    await factory.accept({
      task: item.task,
      attempt: claim.attempt,
      authority: "owner",
      accepted_by: "owner",
    });
    const run = readRun(state, slug, "parallel");
    scrumOperation(
      {
        operation: "run.command",
        runId: run.runId,
        requestId: `result-${item.task}`,
        expectedRevision: run.revision,
        payload: {
          type: "role_result",
          task: item.task,
          result: {
            status: "complete",
            artifactRefs: item.paths.map((p) => artifactAt(repo, item.sha, p)),
            assumptions: [],
            openQuestions: [],
            conflicts: [],
          },
        },
      },
      context,
    );
  }
  await accept(await prepare("pm"));
  const [ux, architect] = await Promise.all([
    prepare("ux"),
    prepare("architect"),
  ]);
  assert.equal(
    factory.ledger.events.filter((e) => e.event === "spawn_dispatched").length,
    3,
  );
  assert.equal(
    factory.ledger.events.filter((e) => e.event === "attempt_accepted").length,
    1,
    "both design Tasks are open at the same time",
  );
  await accept(ux);
  await accept(architect);
  assert.match(
    readFileSync(join(repo, prefix, "decisions/ux.jsonl"), "utf8"),
    /U1/,
  );
  assert.match(
    readFileSync(join(repo, prefix, "decisions/architect.jsonl"), "utf8"),
    /A1/,
  );
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(git(repo, "ls-files", ".scratch/local-tracker.md"), "");
  const run = readRun(state, slug, "parallel");
  const blocked = scrumOperation(
    {
      operation: "run.command",
      runId: run.runId,
      requestId: "readiness",
      expectedRevision: run.revision,
      payload: {
        type: "readiness_recorded",
        readiness: {
          refs: run.tasks.flatMap((t) => t.result!.artifactRefs),
          contradictions: [
            "UX permits offline writes; architecture forbids them",
          ],
          unsafeAssumptions: [],
          missingCoverage: [],
          rationale: "semantic mismatch despite two GREEN artifact Gates",
        },
      },
    },
    context,
  ) as typeof run;
  assert.equal(blocked.phase, "blocked");
  const dev = await handleSpoolRequest(factory, {
    id: "dev-blocked",
    kind: "contract",
    submitter: "owner",
    task: "dev",
    workspace: repo,
    gate: "true",
    runId: run.runId,
    role: "dev",
  });
  assert.equal(dev.ok, false);
  if (!dev.ok) assert.equal(dev.code, "scrum-run-blocked");
});

test("Scrum seat create and permission families use the Scrum roster and catalog", async t => {
  const { resolveProject, ensureProjectRegistered } = await import("../plugin/server/core/project.ts");
  const { switchExecution } = await import("../plugin/server/core/scrum/execution.ts");
  const { ensureScrumConfig, saveScrumConfig } = await import("../plugin/server/core/scrum/config.ts");
  const { normalizeAgentCreateRequest } = await import("../plugin/server/choke.ts");
  const { injectRoleOnCreate, resolveEffectiveProviderFamily } = await import("../plugin/server/roles.ts");
  const state = makeTempDir(), repo = makeTempDir(), userHome = makeTempDir();
  for (const dir of [state, repo, userHome]) disposeDir(t, dir);
  writeFileSync(join(repo, "README.md"), "fixture"); gitCommitAll(repo);
  const project = resolveProject(repo); assert.ok(project.ok); if (!project.ok) return;
  ensureProjectRegistered(state, project);
  await switchExecution({ state, slug: project.slug, mode: "scrum", blockers: [], rotate: async () => {} });
  const config = ensureScrumConfig(state, project.slug);
  saveScrumConfig(state, { ...config, lanes: { ...config.lanes, supervisor: "claude-code/opus:high", lead: "opencode/fast:high" } }, project.slug);
  const providers = [{ provider: "claude", models: [{ id: "opus", thinkingOptions: [] }] }, { provider: "opencode", models: [{ id: "fast", thinkingOptions: [] }] }];
  const request = { config: { cwd: repo, provider: "factory-supervisor", thinkingOptionId: "stale" } };
  const normalized = normalizeAgentCreateRequest(request, { stateDir: state, providers });
  assert.equal(normalized.config.provider, "claude");
  assert.equal(Object.hasOwn(normalized.config, "thinkingOptionId"), false);
  const injected = injectRoleOnCreate(normalized as AgentCreateRequest, state, userHome, providers)!;
  assert.equal(injected.config.provider, "claude");
  assert.equal(Object.hasOwn(injected.config, "thinkingOptionId"), false);
  assert.equal(resolveEffectiveProviderFamily("factory-lead", "lead", state, project.slug), "opencode");
  saveScrumConfig(state, { ...config, lanes: { ...config.lanes, supervisor: "agy/gemini:high" } }, project.slug);
  const agy = injectRoleOnCreate(request as AgentCreateRequest, state, userHome, [{ provider: "antigravity", models: [{ id: "gemini", thinkingOptions: [] }] }])!;
  assert.equal(agy.config.provider, "antigravity");
  assert.equal(Object.hasOwn(agy.config, "thinkingOptionId"), false);
  assert.equal(agy.config.mcpServers, undefined, "Antigravity must receive its provider-specific fence");
  const supported = injectRoleOnCreate(request as AgentCreateRequest, state, userHome, [{ provider: "antigravity", models: [{ id: "gemini", thinkingOptions: [{ id: "high" }] }] }])!;
  assert.equal(supported.config.thinkingOptionId, "high");
});

test("a pre-rendered Scrum Lead prompt still provisions role correlation and MCP authority", async t => {
  const { injectRoleOnCreate } = await import("../plugin/server/roles.ts");
  const { renderScrumPrompt } = await import("../plugin/server/core/scrum/prompts.ts");
  const { CorrelationRegistry } = await import("../plugin/server/core/correlations.ts");
  const { ensureProjectRegistered } = await import("../plugin/server/core/project.ts");
  const { switchExecution } = await import("../plugin/server/core/scrum/execution.ts");
  const state = makeTempDir(), repo = makeTempDir(), userHome = makeTempDir(); for (const dir of [state, repo, userHome]) disposeDir(t, dir);
  writeFileSync(join(repo, "README.md"), "fixture"); gitCommitAll(repo);
  const project = ensureProjectRegistered(state, repo); assert.ok(project.ok);
  await switchExecution({ state, slug: project.slug, mode: "scrum", blockers: [], rotate: async () => {} });
  const request = { config: { cwd: repo, provider: "factory-lead", title: "Scrum Lead", systemPrompt: renderScrumPrompt("lead", { project: project.slug, workspace: repo }) } } as AgentCreateRequest;
  const injected = injectRoleOnCreate(request, state, userHome);
  assert.ok(injected, "rendered prose alone must not bypass correlation or provider provisioning");
  assert.equal(injected.env?.PASEO_FACTORY_SEAT, "lead");
  const correlation = new CorrelationRegistry(state).resolve(injected.env!.PASEO_FACTORY_CORRELATION!);
  assert.equal(correlation?.role, "lead"); assert.equal(correlation?.projectSlug, project.slug);
  assert.equal(injectRoleOnCreate(injected, state, userHome), undefined, "already provisioned request stays idempotent");
});

test("a Scrum Lead title provisions the Lead role when the daemon omits top-level labels", async t => {
  const { injectRoleOnCreate } = await import("../plugin/server/roles.ts");
  const { ensureProjectRegistered } = await import("../plugin/server/core/project.ts");
  const { switchExecution } = await import("../plugin/server/core/scrum/execution.ts");
  const state = makeTempDir(), repo = makeTempDir(), userHome = makeTempDir(); for (const dir of [state, repo, userHome]) disposeDir(t, dir);
  writeFileSync(join(repo, "README.md"), "fixture"); gitCommitAll(repo);
  const project = ensureProjectRegistered(state, repo); assert.ok(project.ok);
  await switchExecution({ state, slug: project.slug, mode: "scrum", blockers: [], rotate: async () => {} });
  const result = injectRoleOnCreate({ config: { cwd: repo, provider: "antigravity/claude-sonnet-5-5-high", title: "Scrum Lead" } } as AgentCreateRequest, state, userHome);
  assert.ok(result, "Scrum Lead display title must retain Lead authority without top-level labels");
  assert.equal(result.env?.PASEO_FACTORY_SEAT, "lead"); assert.ok(result.env?.PASEO_FACTORY_CORRELATION);
});

test("reusing a provisioned request in another Project resolves that Project's mode afresh", async t => {
  const { injectRoleOnCreate } = await import("../plugin/server/roles.ts");
  const { ensureProjectRegistered } = await import("../plugin/server/core/project.ts");
  const { switchExecution } = await import("../plugin/server/core/scrum/execution.ts");
  const state = makeTempDir(), slp = makeTempDir(), scrum = makeTempDir(), userHome = makeTempDir(); for (const dir of [state, slp, scrum, userHome]) disposeDir(t, dir);
  for (const repo of [slp, scrum]) { writeFileSync(join(repo, "README.md"), "fixture"); gitCommitAll(repo); }
  const project = ensureProjectRegistered(state, scrum); assert.ok(project.ok);
  await switchExecution({ state, slug: project.slug, mode: "scrum", blockers: [], rotate: async () => {} });
  const original = injectRoleOnCreate({ config: { cwd: slp, provider: "factory-lead", title: "Lead" } } as AgentCreateRequest, state, userHome)!;
  const moved = injectRoleOnCreate({ ...original, config: { ...original.config, cwd: scrum, title: "Scrum Lead" } }, state, userHome);
  assert.ok(moved, "stale env must not authenticate the new workspace as the old Project");
  assert.equal(moved.env?.PASEO_FACTORY_PROJECT, project.slug);
  assert.notEqual(moved.env?.PASEO_FACTORY_CORRELATION, original.env?.PASEO_FACTORY_CORRELATION);
  const mcp = moved.config.mcpServers as Record<string, { args: string[] }>;
  assert.equal(mcp.paseo_factory.args[mcp.paseo_factory.args.indexOf("--mode") + 1], "scrum");
  assert.doesNotMatch(moved.config.systemPrompt!, /You are the Lead seat of the paseo-factory verification loop/);
});

test('Scrum UX harness stages standalone Open Design shells and carries no retired scanners', async t => {
  const { mkdirSync, readFileSync, existsSync } = await import('node:fs');
  const { provisionScrumHarness } = await import('../src/scrum/harness.ts');
  const { ensureScrumConfig } = await import('../src/scrum/config.ts');
  const { createScrumRun } = await import('../src/scrum/run-journal.ts');
  const state = makeTempDir(), repo = makeTempDir(), home = makeTempDir();
  for (const dir of [state, repo, home]) disposeDir(t, dir);
  const run = createScrumRun({ state, slug: 'p', runId: 'od', initiativeId: 'od', config: ensureScrumConfig(state), configRevision: 1, track: 'ui', rationale: 'harness', requestId: 'create', ownedPaths: [] });
  const identity = { kind: 'task' as const, task: 'ux', epoch: 1, binding: { mode: 'scrum' as const, role: 'ux' as const, runId: run.runId, configRevision: run.configRevision, policyRevision: run.policyRevision, artifactRefs: [] } };
  const roleHome = provisionScrumHarness({ state, slug: 'p', authority: 'agent', identity, generation: 'g', userHome: home, workspace: repo });
  for (const file of ['iphone.html', 'android.html', 'neutral.html', 'layout.css']) {
    assert.ok(existsSync(join(repo, '.scratch/od/mockups/.od-frames', file)), file);
  }
  for (const file of ['impeccable-hook.mjs', 'impeccable-opencode.mjs', 'hooks.json']) assert.equal(existsSync(join(roleHome, file)), false);
  assert.doesNotMatch(readFileSync(join(roleHome, 'settings.json'), 'utf8'), /impeccable/);
  assert.match(readFileSync(join(roleHome, 'APPEND_SYSTEM.md'), 'utf8'), /Open Design/);
  const layout = join(repo, '.scratch/od/mockups/.od-frames/layout.css');
  writeFileSync(layout, 'owner edit');
  provisionScrumHarness({ state, slug: 'p', authority: 'agent', identity, generation: 'g', userHome: home, workspace: repo });
  assert.equal(readFileSync(layout, 'utf8'), 'owner edit');
});

test('ADR 0036: Factory Core Skill Pack installs from canonical sources, reconciles providers and checks Git updates', async (t) => {
  const { mkdirSync, existsSync, lstatSync, chmodSync, readFileSync } = await import('node:fs');
  const {
    inspectFactorySkillPack,
    installOrUpdateFactorySkillPack,
    checkCompanionToolsUpdates,
    ensureProviderSkillSymlinks,
    CORE_FACTORY_SKILLS,
    CORE_SKILL_SOURCES,
  } = await import('../src/scrum/companion-tools.ts');

  const home = makeTempDir();
  const roleHome = makeTempDir();
  for (const d of [home, roleHome]) disposeDir(t, d);

  // 1. Initially not_installed; CORE_FACTORY_SKILLS has 11 skills (10 GitHub + 1 built-in factory)
  assert.equal(CORE_FACTORY_SKILLS.length, 11);
  assert.equal(CORE_SKILL_SOURCES.length, 10);
  assert.equal(inspectFactorySkillPack(home).status, 'not_installed');

  // 2. Install Factory Core Skill Pack via installOrUpdateFactorySkillPack (cloning the 3 canonical GitHub repos + reconciling /factory)
  const clonedUrls: string[] = [];
  const installedPack = installOrUpdateFactorySkillPack({
    userHome: home,
    action: 'install',
    reconcileFactorySkill: true,
    runner: (cmd, args) => {
      if (cmd === 'git' && args[0] === 'clone') {
        const sourceUrl = args[3]!;
        const tmpDir = args[4]!;
        clonedUrls.push(sourceUrl);
        for (const entry of CORE_SKILL_SOURCES.filter((s) => s.sourceUrl === sourceUrl)) {
          mkdirSync(join(tmpDir, entry.skillPath), { recursive: true });
          writeFileSync(join(tmpDir, entry.skillPath, 'SKILL.md'), `---\nname: ${entry.name}\n---\n# ${entry.name}\n`);
        }
        return { status: 0, stdout: 'd0ef4f344dc60fb53df2fa1bcceb8dc3efdb1fb5', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(installedPack.ok, true);
  assert.deepEqual(clonedUrls.sort(), [
    'https://github.com/anthropics/skills.git',
    'https://github.com/mattpocock/skills.git',
    'https://github.com/vercel-labs/agent-skills.git',
  ]);
  const pack = inspectFactorySkillPack(home);
  assert.equal(pack.status, 'installed');
  assert.equal(pack.totalSkills, CORE_FACTORY_SKILLS.length);
  assert.equal(pack.installedCoreCount, CORE_FACTORY_SKILLS.length);
  assert.equal(pack.revision, 'd0ef4f3');
  const lockRaw = JSON.parse(readFileSync(join(home, '.agents/.skill-lock.json'), 'utf8'));
  assert.equal(lockRaw.version, 3);
  assert.equal(lockRaw.skills.tdd.source, 'mattpocock/skills');
  assert.equal(lockRaw.skills.research.source, 'mattpocock/skills');
  assert.equal(lockRaw.skills['frontend-design'].source, 'anthropics/skills');
  assert.equal(lockRaw.skills['web-design-guidelines'].source, 'vercel-labs/agent-skills');
  ensureProviderSkillSymlinks(home);
  for (const s of CORE_FACTORY_SKILLS) {
    assert.ok(lstatSync(join(home, '.pi/agent/skills', s)).isSymbolicLink());
    assert.ok(lstatSync(join(home, '.claude/skills', s)).isSymbolicLink());
    assert.ok(lstatSync(join(home, '.gemini/config/skills', s)).isSymbolicLink());
  }

  const updates = checkCompanionToolsUpdates({
    userHome: home,
    runner: (cmd, args) => {
      if (cmd === 'npm' && args[0] === 'view') {
        return { status: 0, stdout: '4.9.0\n', stderr: '' };
      }
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return { status: 0, stdout: '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e\tHEAD\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(Object.keys(updates), ['factory-skills-pack']);
  assert.equal(updates['factory-skills-pack'].updateAvailable, true);
  assert.equal(updates['factory-skills-pack'].latestRevision, '9f8e7d6');
});

test('Windows-safe task allocation disables autocrlf before checkout without changing root config', async t => {
  const { prepareTaskWorktree } = await import('../src/workspace.ts');
  const { readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const repo = makeTempDir(), state = makeTempDir(); for (const dir of [repo, state]) disposeDir(t, dir);
  writeFileSync(join(repo, 'source.txt'), 'one\ntwo\n'); gitCommitAll(repo);
  execFileSync('git', ['-C', repo, 'config', 'core.autocrlf', 'true']);
  const allocated = prepareTaskWorktree({ stateDir: state, workspace: repo, task: 'crlf' }); assert.ok(allocated.ok, JSON.stringify(allocated));
  assert.equal(execFileSync('git', ['-C', allocated.path, 'config', 'core.autocrlf'], { encoding: 'utf8' }).trim(), 'false');
  assert.equal(readFileSync(join(allocated.path, 'source.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(execFileSync('git', ['-C', repo, 'config', 'core.autocrlf'], { encoding: 'utf8' }).trim(), 'true');
});

test('isScrumRoleBlockedHelperMcp keeps seats on the bridge and withholds only the anchored denylist from planning roles', async () => {
  const { isScrumRoleBlockedHelperMcp } = await import('../src/scrum/harness.ts');
  for (const seat of ['supervisor', 'lead'] as const) {
    assert.equal(isScrumRoleBlockedHelperMcp(seat, 'sequential-thinking'), true, `${seat} blocks helper servers`);
    assert.equal(isScrumRoleBlockedHelperMcp(seat, 'zai-vision'), true);
    assert.equal(isScrumRoleBlockedHelperMcp(seat, 'paseo_factory'), false, `${seat} keeps the bridge`);
    assert.equal(isScrumRoleBlockedHelperMcp(seat, 'paseo-factory'), false, `${seat} keeps the hyphenated bridge`);
  }
  for (const role of ['pm', 'architect'] as const) {
    for (const name of ['zai-vision', 'zai-mcp-server', 'chrome-devtools-mcp', 'chrome-devtools', 'playwright-mcp', 'playwright', 'open-design', 'open_design', 'ZAI-VISION'])
      assert.equal(isScrumRoleBlockedHelperMcp(role, name), true, `${role} blocks ${name}`);
    for (const name of ['sequential-thinking', 'notion-mcp-server', 'science_biomolecular_structure_viewer_mcp', 'github', 'linear', 'zai-vision-relay', 'chrome-devtools-proxy'])
      assert.equal(isScrumRoleBlockedHelperMcp(role, name), false, `${role} keeps ${name}`);
  }
  for (const role of ['ux', 'dev', 'qa'] as const)
    for (const name of ['zai-vision', 'chrome-devtools-mcp', 'playwright', 'open-design', 'linear'])
      assert.equal(isScrumRoleBlockedHelperMcp(role, name), false, `${role} keeps ${name}`);
});

test('scopeScrumCapabilities passes the Owner catalog through specialists and strands seats on the bridge alone', async (t) => {
  const { scopeScrumCapabilities } = await import('../src/scrum/harness.ts');
  const home = makeTempDir(); disposeDir(t, home);
  const ownerCatalog: Record<string, unknown> = {
    'sequential-thinking': {}, 'notion-mcp-server': {}, 'science_biomolecular_structure_viewer_mcp': {},
    github: {}, linear: {}, 'zai-vision': {}, 'chrome-devtools-mcp': {}, playwright: {}, 'open-design': {},
    paseo_factory: {},
  };
  const passThrough = ['sequential-thinking', 'notion-mcp-server', 'science_biomolecular_structure_viewer_mcp', 'github', 'linear'];
  const visual = ['zai-vision', 'chrome-devtools-mcp', 'playwright', 'open-design'];
  for (const role of ['pm', 'ux', 'architect', 'dev', 'qa'] as const) {
    const identity = { kind: 'task' as const, task: role, epoch: 1, binding: { mode: 'scrum' as const, role, runId: 'r', policyRevision: 'p', configRevision: 1, artifactRefs: [] } };
    for (const provider of ['claude', 'codex', 'opencode']) {
      const scoped = scopeScrumCapabilities({ provider, providerOptions: {}, mcpServers: { ...ownerCatalog } }, 'agent', identity, undefined, { userHome: home });
      const servers = Object.keys(scoped.mcpServers ?? {});
      assert.ok(servers.includes('paseo_factory'), `${role}/${provider} keeps the bridge`);
      for (const name of passThrough)
        assert.equal(servers.includes(name), true, `${role}/${provider} keeps Owner-enabled ${name}`);
      for (const name of visual)
        assert.equal(servers.includes(name), role === 'ux' || role === 'dev' || role === 'qa', `${role}/${provider} denylist parity on ${name}`);
    }
  }
  const seatConfig = {
    schemaVersion: 1 as const, requireUiApproval: true,
    lanes: Object.fromEntries(['supervisor', 'lead', 'pm', 'ux', 'architect', 'dev', 'qa', 'watch', 'retro'].map(k => [k, 'pi/model'])) as import('../src/scrum/config.ts').ScrumConfig['lanes'],
  };
  for (const seat of ['supervisor', 'lead'] as const) {
    const scoped = scopeScrumCapabilities({ provider: 'claude', mcpServers: { ...ownerCatalog } }, seat, { kind: 'seat', selectionRevision: 1, config: seatConfig });
    assert.deepEqual(Object.keys(scoped.mcpServers ?? {}), ['paseo_factory']);
  }
});

test('directory durability tolerates Windows and unsupported filesystem directory sync', async t => {
  const { fsyncDirectory } = await import('../src/history-stage.ts');
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { assert.doesNotThrow(() => fsyncDirectory('not-a-real-directory')); }
  finally { Object.defineProperty(process, 'platform', platform); }
  const open = t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); });
  syncBuiltinESMExports();
  try { assert.doesNotThrow(() => fsyncDirectory('directory')); }
  finally { open.mock.restore(); syncBuiltinESMExports(); }
});

test('Scrum contracts quote runtime paths for sh and Windows cmd', async t => {
  const { prepareScrumContract } = await import('../plugin/server/scrum-contract.ts');
  const { createFactory } = await import('../plugin/server/core/factory.ts');
  const { resolveProject } = await import('../plugin/server/core/project.ts');
  const { switchExecution } = await import('../plugin/server/core/scrum/execution.ts');
  const { createScrumRun } = await import('../plugin/server/core/scrum/run-journal.ts');
  const { ensureScrumConfig } = await import('../plugin/server/core/scrum/config.ts');
  const root = makeTempDir(), state = join(makeTempDir(), 'state with spaces'); disposeDir(t, root); disposeDir(t, state);
  writeFileSync(join(root, 'README.md'), 'product'); gitCommitAll(root);
  const p = resolveProject(root); assert.ok(p.ok);
  const factory = createFactory({ stateDir: state });
  await switchExecution({ state, slug: p.slug, mode: 'scrum', blockers: [], rotate: async () => {} });
  const run = createScrumRun({ state, slug: p.slug, runId: 'r', initiativeId: 'i', config: ensureScrumConfig(state, p.slug), configRevision: 1, track: 'quick', rationale: 'backlog', requestId: 'create', ownedPaths: [] });
  const contract = prepareScrumContract(factory, { id: 'pm-contract', task: 'pm', workspace: root, runId: run.runId, role: 'pm', gate: 'node --version' });
  assert.ok(contract.gate?.includes(`"${process.execPath}"`));
  assert.ok(contract.gate?.includes(`"${join(state, 'runtime-bin/factory.mjs')}"`));
  assert.match(contract.gate!, /--dir "\.scratch\/i"/);
});

test('UX provisioning emits od.cmd and executable cross-platform Antigravity hook launchers', async t => {
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { provisionScrumHarness } = await import('../src/scrum/harness.ts');
  const { provisionAgyPlugin } = await import('../src/agy-home.ts');
  const { ensureScrumConfig } = await import('../src/scrum/config.ts');
  const { createScrumRun } = await import('../src/scrum/run-journal.ts');
  const { execFileSync } = await import('node:child_process');
  const dir = makeTempDir(); disposeDir(t, dir); const state = join(dir, 'state'), home = join(dir, 'user');
  const resources = join(dir, 'Open Design/Resources'); mkdirSync(join(resources, 'app/prebundled/daemon'), { recursive: true }); mkdirSync(join(resources, 'open-design'));
  writeFileSync(join(resources, 'app/prebundled/daemon/daemon-cli.mjs'), 'console.log(process.env.ELECTRON_RUN_AS_NODE)');
  const run = createScrumRun({ state, slug: 'p', runId: 'r', initiativeId: 'i', config: ensureScrumConfig(state), configRevision: 1, track: 'standard', rationale: 'wrappers', requestId: 'create', ownedPaths: [] });
  const roleHome = provisionScrumHarness({ state, slug: 'p', authority: 'agent', generation: 'g', userHome: home, workspace: join(dir, 'workspace'), environment: { OPEN_DESIGN_RESOURCE_ROOT: join(resources, 'open-design') }, identity: { kind: 'task', task: 'ux', epoch: 1, binding: { mode: 'scrum', role: 'ux', runId: run.runId, configRevision: 1, policyRevision: run.policyRevision, artifactRefs: [] } } });
  assert.match(readFileSync(join(roleHome, 'bin/od.cmd'), 'utf8'), /@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1/);
  assert.match(readFileSync(join(roleHome, 'bin/od.cmd'), 'utf8'), /daemon-cli.mjs" %\*/);
  assert.equal(execFileSync(join(roleHome, 'bin/od'), [], { encoding: 'utf8' }).trim(), '1');
  const pluginDir = provisionAgyPlugin({ stateDir: state, userHome: home, agyPluginsDir: join(dir, 'plugins with spaces'), nodePath: process.execPath });
  const hook = JSON.parse(readFileSync(join(pluginDir, 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  assert.match(hook, /^node ".*hook-launcher.cjs"$/); assert.doesNotMatch(hook, /ELECTRON_RUN_AS_NODE=/);
  // A real spawned hook receives stdin; no POSIX env assignment is needed.
  execFileSync(hook, { shell: true, input: '{}', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
});

test('skill healer replaces stale copies across five harnesses and removes retired skills', async (t) => {
  const { mkdirSync, readFileSync, realpathSync, existsSync } = await import('node:fs');
  const { ensureProviderSkillSymlinks } = await import('../src/scrum/companion-tools.ts');
  const home = makeTempDir(); disposeDir(t, home);
  for (const path of ['.agents/skills/tdd', '.agents/skills/critique', '.codex', '.zcode/skills/tdd']) mkdirSync(join(home, path), { recursive: true });
  writeFileSync(join(home, '.agents/skills/tdd/SKILL.md'), 'canonical');
  writeFileSync(join(home, '.zcode/skills/tdd/SKILL.md'), 'stale');
  ensureProviderSkillSymlinks(home);
  for (const path of ['.pi/agent', '.claude', '.gemini/config', '.codex', '.zcode']) {
    assert.equal(realpathSync(join(home, path, 'skills/tdd')), realpathSync(join(home, '.agents/skills/tdd')));
    assert.equal(readFileSync(join(home, path, 'skills/tdd/SKILL.md'), 'utf8'), 'canonical');
  }
  assert.equal(existsSync(join(home, '.agents/skills/critique')), false);
});

test('Expo pack installs upstream skills with commit provenance and flags legacy locks', async (t) => {
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { EXPO_SKILL_SOURCES, installOrUpdateExpoSkillPack, checkCompanionToolsUpdates, readSkillLockFile, writeSkillLockFile } = await import('../src/scrum/companion-tools.ts');
  const home = makeTempDir(); disposeDir(t, home);
  const sha = 'a'.repeat(40);
  const runner = (_command: string, args: string[]) => {
    if (args[0] === 'clone') for (const entry of EXPO_SKILL_SOURCES) {
      const dir = join(args.at(-1)!, entry.skillPath); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), `# ${entry.name}`);
    }
    return { status: 0, stdout: sha, stderr: '' };
  };
  assert.equal(installOrUpdateExpoSkillPack({ userHome: home, runner }).ok, true);
  assert.equal(EXPO_SKILL_SOURCES.length, 24);
  const lock = readSkillLockFile(home);
  assert.equal(Object.keys(lock.skills).length, 24);
  assert.equal(lock.skills['expo-migrate-module']?.repoCommitSha, sha);
  assert.equal(lock.skills['expo-overview']?.skillFolderHash.length, 64);
  delete lock.skills['expo-overview']!.repoCommitSha; writeSkillLockFile(home, lock);
  assert.equal(checkCompanionToolsUpdates({ userHome: home, runner })['factory-skills-pack'].updateAvailable, true);
  assert.equal(JSON.parse(readFileSync(join(home, '.agents/.skill-updates-cache.json'), 'utf8')).remoteCommits['https://github.com/expo/skills.git'], sha);
});

test('Project packs and Contract skills unlock the same Scrum provider capability set', async (t) => {
  const { mkdirSync } = await import('node:fs');
  const { scopeScrumCapabilities } = await import('../src/scrum/harness.ts');
  const { detectProjectSkillPacks } = await import('../src/scrum/companion-tools.ts');
  const home = makeTempDir(); disposeDir(t, home);
  writeFileSync(join(home, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  for (const name of ['expo-overview', 'expo-native-ui', 'eas-workflows']) { const dir = join(home, '.agents/skills', name); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), '# skill'); }
  assert.deepEqual(detectProjectSkillPacks(home), ['expo']);
  const identity = { kind: 'task' as const, task: 'design', epoch: 1, binding: { mode: 'scrum' as const, runId: 'r1', role: 'ux' as const, policyRevision: '1', configRevision: 1, artifactRefs: [] }, contractSkills: ['custom-skill'] };
  const config = scopeScrumCapabilities({ provider: 'opencode', providerOptions: {}, mcpServers: { 'expo-mcp': {} } }, 'agent', identity, undefined, { projectRoot: home, userHome: home });
  const permission = (config.providerOptions as any).permission.skill;
  assert.equal(permission['expo-native-ui'], 'allow');
  assert.equal(permission['custom-skill'], 'allow');
  assert.ok(config.mcpServers['expo-mcp']);
  const lean = scopeScrumCapabilities({ provider: 'opencode', providerOptions: {} }, 'agent', identity, undefined, { configuredPacks: [], userHome: home });
  assert.equal((lean.providerOptions as any).permission.skill['expo-native-ui'], undefined);
});

test('Scrum Pi homes provision Project packs and explicit Contract skills through the public harness', async (t) => {
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { provisionScrumHarness, scopeScrumCapabilities } = await import('../src/scrum/harness.ts');
  const { ensureScrumConfig } = await import('../src/scrum/config.ts');
  const { createScrumRun } = await import('../src/scrum/run-journal.ts');
  const state = makeTempDir(), repo = makeTempDir(), userHome = makeTempDir();
  for (const dir of [state, repo, userHome]) disposeDir(t, dir);
  writeFileSync(join(repo, 'app.json'), '{"expo":{}}');
  for (const name of ['expo-overview', 'expo-debugging', 'eas-workflows', 'contract-skill']) { mkdirSync(join(userHome, '.agents/skills', name), { recursive: true }); writeFileSync(join(userHome, '.agents/skills', name, 'SKILL.md'), '# Skill'); }
  const run = createScrumRun({ state, slug: 'p', runId: 'packs', initiativeId: 'packs', config: ensureScrumConfig(state), configRevision: 1, track: 'ui', rationale: 'packs', requestId: 'create', ownedPaths: [] });
  const identity = { kind: 'task' as const, task: 'qa', epoch: 1, projectRoot: repo, contractSkills: ['contract-skill'], binding: { mode: 'scrum' as const, role: 'qa' as const, runId: run.runId, configRevision: run.configRevision, policyRevision: run.policyRevision, artifactRefs: [] } };
  const roleHome = provisionScrumHarness({ state, slug: 'p', authority: 'agent', identity, generation: 'g', userHome, workspace: repo });
  const settings = JSON.parse(readFileSync(join(roleHome, 'settings.json'), 'utf8'));
  assert.ok(settings.skills.includes(`+${join(userHome, '.agents/skills/expo-debugging')}`));
  assert.ok(settings.skills.includes(`+${join(userHome, '.agents/skills/contract-skill')}`));
  for (const role of ['ux', 'architect', 'dev', 'qa'] as const) {
    const scoped = scopeScrumCapabilities({ provider: 'opencode', providerOptions: {} }, 'agent', { ...identity, binding: { ...identity.binding, role } }, undefined, { userHome });
    assert.equal((scoped.providerOptions as any).permission.skill['expo-overview'], 'allow');
    assert.equal((scoped.providerOptions as any).permission.skill['contract-skill'], 'allow');
  }
});

test('Scrum Pi homes sync the Owner Helper catalog and sweep the unified denylist per role', async (t) => {
  const { readFileSync } = await import('node:fs');
  const { provisionScrumHarness } = await import('../src/scrum/harness.ts');
  const { ensureScrumConfig } = await import('../src/scrum/config.ts');
  const { createScrumRun, commandRun, readRun } = await import('../src/scrum/run-journal.ts');
  const { resolveProject, ensureProjectRegistered } = await import('../src/project.ts');
  const state = makeTempDir(), repo = makeTempDir(), userHome = makeTempDir();
  for (const dir of [state, repo, userHome]) disposeDir(t, dir);
  writeFileSync(join(repo, 'README.md'), 'fixture'); gitCommitAll(repo);
  const project = resolveProject(repo); assert.ok(project.ok);
  if (!project.ok) return;
  ensureProjectRegistered(state, project);
  const ownerNames = ['sequential-thinking', 'notion-mcp-server', 'science_biomolecular_structure_viewer_mcp', 'github', 'zai-vision', 'chrome-devtools-mcp', 'playwright', 'open-design'];
  // The Owner flow `setHelperMcpEnabled` records: host-source server definitions
  // plus enable overrides in the persisted catalog at <stateDir>/helper-mcps.json.
  writeFileSync(join(userHome, '.claude.json'), JSON.stringify({ mcpServers: Object.fromEntries(ownerNames.map(name => [name, { command: process.execPath }])) }));
  writeFileSync(join(state, 'helper-mcps.json'), JSON.stringify({ overrides: Object.fromEntries(ownerNames.map(name => [name, true])) }));
  const run = createScrumRun({ state, slug: project.slug, runId: 'catalog', initiativeId: 'catalog', config: ensureScrumConfig(state, project.slug), configRevision: 1, track: 'backend', rationale: 'catalog', requestId: 'create', ownedPaths: [] });
  commandRun(state, project.slug, run.runId, { type: 'readiness_recorded', requestId: 'ready', expectedRevision: readRun(state, project.slug, run.runId).revision, readiness: { refs: [], contradictions: [], unsafeAssumptions: [], missingCoverage: [], rationale: 'backend track readiness' } });
  const keep = ['sequential-thinking', 'notion-mcp-server', 'science_biomolecular_structure_viewer_mcp', 'github'];
  const visual = ['zai-vision', 'chrome-devtools-mcp', 'playwright', 'open-design'];
  const mcpServersOf = (roleHome: string) => Object.keys(JSON.parse(readFileSync(join(roleHome, 'mcp.json'), 'utf8')).mcpServers);
  for (const role of ['pm', 'ux', 'architect', 'dev', 'qa'] as const) {
    const identity = { kind: 'task' as const, task: role, epoch: 1, binding: { mode: 'scrum' as const, role, runId: run.runId, configRevision: run.configRevision, policyRevision: run.policyRevision, artifactRefs: [] } };
    const servers = mcpServersOf(provisionScrumHarness({ state, slug: project.slug, authority: 'agent', identity, generation: 'g', userHome, workspace: repo }));
    assert.ok(servers.includes('paseo_factory'), `${role} keeps the bridge`);
    for (const name of keep) assert.equal(servers.includes(name), true, `${role} syncs Owner-enabled ${name}`);
    for (const name of visual) assert.equal(servers.includes(name), role === 'ux' || role === 'dev' || role === 'qa', `${role} mcp.json denylist parity on ${name}`);
  }
  const seatConfig = ensureScrumConfig(state, project.slug);
  for (const seat of ['supervisor', 'lead'] as const) {
    const roleHome = provisionScrumHarness({ state, slug: project.slug, authority: seat, identity: { kind: 'seat', selectionRevision: 1, config: seatConfig }, generation: 'g', userHome });
    assert.deepEqual(mcpServersOf(roleHome), ['paseo_factory']);
  }
});

test('host catalogs expose portable packs read-only and imported skills gain five healthy links', async (t) => {
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { discoverHostEcosystems, importHostSkillOrPack, inspectSkillHub, detectProjectSkillPacks } = await import('../src/scrum/companion-tools.ts');
  const home = makeTempDir(); disposeDir(t, home);
  for (const path of ['.zcode/skills/asc-iap', '.gemini/config/plugins/firebase/skills/firebase-basics', '.gemini/config/plugins/science/skills/protein', '.codex']) {
    mkdirSync(join(home, path), { recursive: true }); if (path !== '.codex') writeFileSync(join(home, path, 'SKILL.md'), '# Portable');
  }
  writeFileSync(join(home, 'firebase.json'), '{}');
  assert.deepEqual(detectProjectSkillPacks(home), ['firebase']);
  const catalog = discoverHostEcosystems(home);
  for (const id of ['expo:official-pack', 'zcode:asc-iap', 'antigravity:firebase', 'antigravity:science']) assert.ok(catalog.some(e => e.id === id), id);
  assert.ok(importHostSkillOrPack({ id: 'zcode:asc-iap', userHome: home }).ok);
  assert.equal(readFileSync(join(home, '.zcode/skills/asc-iap/SKILL.md'), 'utf8'), '# Portable');
  const hub = inspectSkillHub({ userHome: home });
  assert.equal(hub.totalInstalled, 1); assert.equal(hub.localCustomCount, 1);
  assert.equal(hub.installedSkills[0]?.harnesses.filter(h => h.healthy).length, 5);
  assert.equal(hub.hostCatalog.find(e => e.id === 'zcode:asc-iap')?.status, 'linked');
});

test('failed update checks preserve known outdated skill freshness', async (t) => {
  const { mkdirSync } = await import('node:fs');
  const { checkCompanionToolsUpdates, inspectSkillHub, writeSkillLockFile } = await import('../src/scrum/companion-tools.ts');
  const home = makeTempDir(); disposeDir(t, home);
  mkdirSync(join(home, '.agents/skills/tdd'), { recursive: true }); writeFileSync(join(home, '.agents/skills/tdd/SKILL.md'), '# TDD');
  writeSkillLockFile(home, { version: 3, skills: { tdd: { source: 'mattpocock/skills', sourceType: 'github', sourceUrl: 'https://github.com/mattpocock/skills.git', repoCommitSha: 'a'.repeat(40), skillFolderHash: '', installedAt: '', updatedAt: '' } } });
  checkCompanionToolsUpdates({ userHome: home, runner: () => ({ status: 0, stdout: 'b'.repeat(40), stderr: '' }) });
  assert.equal(inspectSkillHub({ userHome: home }).installedSkills[0]?.freshness, 'update_available');
  checkCompanionToolsUpdates({ userHome: home, runner: () => ({ status: 1, stdout: '', stderr: 'offline' }) });
  assert.equal(inspectSkillHub({ userHome: home }).installedSkills[0]?.freshness, 'update_available');
});

test('host imports refuse support-file symlinks outside the selected skill', async (t) => {
  const { mkdirSync, symlinkSync, existsSync } = await import('node:fs');
  const { importHostSkillOrPack } = await import('../src/scrum/companion-tools.ts');
  const home = makeTempDir(); disposeDir(t, home);
  mkdirSync(join(home, '.zcode/skills/local'), { recursive: true }); writeFileSync(join(home, '.zcode/skills/local/SKILL.md'), '# Local');
  mkdirSync(join(home, 'private')); writeFileSync(join(home, 'private/tokens.json'), 'private');
  symlinkSync(join(home, 'private'), join(home, '.zcode/skills/local/assets'), 'dir');
  const result = importHostSkillOrPack({ id: 'zcode:local', userHome: home });
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(home, '.agents/skills/local')), false);
});

test('host imports exclude metadata symlinks from validation and copying consistently', async (t) => {
  const { mkdirSync, symlinkSync, existsSync } = await import('node:fs');
  const { importHostSkillOrPack } = await import('../src/scrum/companion-tools.ts');
  const home = makeTempDir(); disposeDir(t, home);
  mkdirSync(join(home, '.zcode/skills/local'), { recursive: true }); writeFileSync(join(home, '.zcode/skills/local/SKILL.md'), '# Local');
  mkdirSync(join(home, 'private')); writeFileSync(join(home, 'private/tokens.json'), 'private');
  symlinkSync(join(home, 'private'), join(home, '.zcode/skills/local/.DS_Store'), 'dir');
  assert.equal(importHostSkillOrPack({ id: 'zcode:local', userHome: home }).ok, true);
  assert.equal(existsSync(join(home, '.agents/skills/local/.DS_Store')), false);
});
