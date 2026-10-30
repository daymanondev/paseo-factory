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
      "ux-spec.md": "# UX spec\nSee DESIGN.md, EXPERIENCE.md and mockups/index.html for the complete accepted design.\n",
      "DESIGN.md":
        "# Direction\nColor: navy.\nTypography: system-ui.\nSpacing: 8px.\nComponent: record card.\n",
      "EXPERIENCE.md":
        "# Information architecture and flow\n## Screen: viewer\nOne screen justified for the bounded record viewer. Offline writes permitted.\n| Screen | empty | loading | populated | error | offline | permission-denied |\n| viewer | no record | wait | record | retry | editable | denied |\n",
      "mockups/index.html":
        "<!doctype html><html><head><title>Record viewer</title></head><body><main>" +
        [
          "empty",
          "loading",
          "populated",
          "error",
          "offline",
          "permission-denied",
        ]
          .map((s) => `<button data-state="${s}">${s}</button>`)
          .join("") +
        "</main><script>const q=new URLSearchParams(location.search);document.documentElement.dataset.screen=q.get('screen')||'viewer';document.documentElement.dataset.state=q.get('state')||'populated';window.addEventListener('message',e=>{if(e.data.type==='scrum:set-state'){document.documentElement.dataset.screen=e.data.screen;document.documentElement.dataset.state=e.data.state}})</script></body></html>",
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

test('Scrum harness links the full upstream UI skill pack and edit scanner only into UI roles', async t => {
  const { mkdirSync, readFileSync, existsSync, chmodSync } = await import('node:fs');
  const { provisionScrumHarness, scopeScrumCapabilities } = await import('../src/scrum/harness.ts');
  const { ensureScrumConfig } = await import('../src/scrum/config.ts');
  const { createScrumRun } = await import('../src/scrum/run-journal.ts');
  const { ensureProjectRegistered } = await import('../src/project.ts');
  const state = makeTempDir(), repo = makeTempDir(), home = makeTempDir();
  for (const dir of [state, repo, home]) disposeDir(t, dir);
  writeFileSync(join(repo, 'README.md'), 'fixture'); gitCommitAll(repo);
  const project = ensureProjectRegistered(state, repo);
  assert.ok(project.ok); if (!project.ok) return;
  for (const skill of ['impeccable', 'impeccable-polish']) {
    mkdirSync(join(home, '.claude/skills', skill, 'reference'), { recursive: true });
    writeFileSync(join(home, '.claude/skills', skill, 'SKILL.md'), '# Full upstream pack');
    writeFileSync(join(home, '.claude/skills', skill, 'reference/audit.md'), 'Audit instructions');
  }
  const { switchExecution } = await import('../src/scrum/execution.ts');
  await switchExecution({state,slug:project.slug,mode:'scrum',blockers:[],rotate:async()=>{}});
  const customCodex = join(home,'custom-codex'); mkdirSync(customCodex,{recursive:true});
  writeFileSync(join(customCodex,'auth.json'),'custom-auth');
  writeFileSync(join(customCodex,'config.toml'),'model_provider = "custom"');
  const launcher = join(home, '.claude/skills/impeccable/scripts/impeccable');
  mkdirSync(join(launcher, '..'), { recursive: true });
  writeFileSync(launcher, '#!/bin/sh\nprintf \"scanner-finding\"\n'); chmodSync(launcher, 0o755);
  const run = createScrumRun({ state, slug: project.slug, runId: 'hooks', initiativeId: 'hooks', config: ensureScrumConfig(state), configRevision: 1, track: 'small', rationale: 'harness', requestId: 'create', ownedPaths: [] });
  const { commandRun } = await import('../src/scrum/run-journal.ts');
  commandRun(state, project.slug, run.runId, { type: 'readiness_recorded', requestId: 'ready', expectedRevision: run.revision, readiness: { refs: [], contradictions: [], unsafeAssumptions: [], missingCoverage: [], rationale: 'small non-UI harness test' } });
  for (const role of ['ux', 'dev', 'qa', 'pm', 'architect'] as const) {
    const identity = { kind: 'task' as const, task: role, epoch: 1, binding: { mode: 'scrum' as const, role, runId: run.runId, configRevision: run.configRevision, policyRevision: run.policyRevision, artifactRefs: [] } };
    const roleHome = provisionScrumHarness({ state, slug: project.slug, authority: 'agent', identity, generation: 'g', userHome: home, workspace: repo });
    const settings = JSON.parse(readFileSync(join(roleHome, 'settings.json'), 'utf8'));
    const ui = ['ux', 'dev', 'qa'].includes(role);
    assert.equal(existsSync(join(roleHome, 'skills/impeccable/reference/audit.md')), ui);
    assert.equal(existsSync(join(roleHome, 'skills/impeccable-polish/SKILL.md')), ui);
    assert.equal(settings.extensions.some((s: string) => s.includes('impeccable')), ui);
    if (ui) {
      const { pathToFileURL } = await import('node:url');
      const { default: plugin } = await import(pathToFileURL(join(roleHome, 'impeccable-opencode.mjs')).href);
      const hooks = await plugin({directory: repo});
      const output = {output:'written'};
      await hooks['tool.execute.after']({tool:'write',args:{filePath:'app.tsx'}}, output);
      assert.match(output.output, /scanner-finding/);
      const untouched = {output:'written'};
      await hooks['tool.execute.after']({tool:'write',args:{filePath:'domain.ts'}}, untouched);
      assert.equal(untouched.output,'written');
      const native = scopeScrumCapabilities({provider:'claude',providerOptions:{}}, 'agent', identity, roleHome);
      assert.equal((native.providerOptions as {extraArgs:Record<string,string>}).extraArgs['plugin-dir'], roleHome);
      const restrictive = scopeScrumCapabilities({provider:'opencode',providerOptions:{permission:{bash:'deny'}}}, 'agent', identity);
      assert.equal((restrictive.providerOptions.permission.bash as unknown as Record<string,string>)['*'], 'deny');
      const { factoryEnvFor } = await import('../plugin/server/roles.ts');
      const env = factoryEnvFor('agent', {stateDir:state,project:{root:repo,slug:project.slug},execution:identity,userHome:home,environment:{CODEX_HOME:customCodex,OPENCODE_CONFIG_CONTENT:JSON.stringify({plugin:['operator-plugin'],permission:{bash:'deny'}})}});
      assert.equal(env.CODEX_HOME, env.PASEO_FACTORY_UI_HOME);
      assert.equal(readFileSync(join(env.CODEX_HOME,'auth.json'),'utf8'),'custom-auth');
      assert.equal(readFileSync(join(env.CODEX_HOME,'config.toml'),'utf8'),'model_provider = "custom"');
      const oc = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      assert.equal(oc.plugin[0],'operator-plugin'); assert.equal(oc.permission.bash,'deny');
      assert.ok(oc.plugin.some((p:string)=>p.endsWith('impeccable-opencode.mjs')));
      const piPlugin = (await import(pathToFileURL(join(roleHome,'impeccable-hook.mjs')).href)).default;
      let handler: ((event: unknown, ctx: unknown) => Promise<{content:Array<{text:string}>} | undefined>) | undefined;
      piPlugin({on: (_name:string, fn:typeof handler)=>{handler=fn}});
      const scan = await handler!({toolName:'write',input:{path:'page.html'},content:[]},{cwd:repo});
      assert.match(scan!.content[0].text,/scanner-finding/);
      if(role==='ux') {
        const { CorrelationRegistry } = await import('../src/correlations.ts');
        const registry = new CorrelationRegistry(state);
        const correlation = registry.issue({role:'agent',projectSlug:project.slug,projectRoot:repo,task:role,execution:identity});
        registry.associate(correlation.correlationId,'native-ux');
        const { injectSessionEnv, injectRoleOnCreate } = await import('../plugin/server/roles.ts');
        const correlationEnv: Record<string,string> = {...env,PASEO_FACTORY_CORRELATION:correlation.correlationId};
        const resumed = injectSessionEnv({agentId:'native-ux',cwd:repo,provider:'opencode',env:correlationEnv},state,home)!;
        const resumedConfig = JSON.parse(resumed.env.OPENCODE_CONFIG_CONTENT);
        assert.equal(resumedConfig.plugin[0],'operator-plugin'); assert.equal(resumedConfig.permission.bash,'deny');
        const lead = injectRoleOnCreate({config:{cwd:repo,provider:'factory-lead',title:'Scrum Lead',providerOptions:native.providerOptions},env:correlationEnv},state,home)!;
        assert.equal(lead.env?.PASEO_FACTORY_UI_HOME,undefined);
        assert.equal(lead.env?.CODEX_HOME,customCodex);
        assert.deepEqual(JSON.parse(lead.env!.OPENCODE_CONFIG_CONTENT),{plugin:['operator-plugin'],permission:{bash:'deny'}});
        assert.equal((lead.config.providerOptions as {extraArgs?:Record<string,string>}).extraArgs?.['plugin-dir'],undefined);
        const { ensureGitShim } = await import('../plugin/server/shell.ts');
        const { repoRoot } = await import('./helpers.ts');
        const { spawnSync } = await import('node:child_process');
        ensureGitShim(state,join(repoRoot,'plugin'),process.execPath);
        const bin=join(home,'native-bin');mkdirSync(bin,{recursive:true});
        for(const tool of ['agy','copilot']) {
          writeFileSync(join(bin,tool),'#!/bin/sh\nprintf \"%s\\n\" \"$@\"\n');chmodSync(join(bin,tool),0o755);
          const result=spawnSync(join(state,'bin',tool),['--help'],{encoding:'utf8',env:{...process.env,...env,PATH:bin+':'+process.env.PATH}});
          assert.equal(result.status,0,result.stderr);
          assert.match(result.stdout,tool==='agy'?/--settings/:/--plugin-dir/);
          assert.ok(result.stdout.includes(env.PASEO_FACTORY_UI_HOME));
        }
      }

    }

    const scoped = scopeScrumCapabilities({ provider: 'opencode', providerOptions: {} }, 'agent', identity);
    const permission = (scoped.providerOptions as { permission: { bash: Record<string, string> } }).permission;
    assert.equal(permission.bash?.['impeccable *'], ui ? 'allow' : 'deny');
  }
  const { judgeShellCommand } = await import('../src/choke.ts');
  const roots = { workspace: repo, stateDir: state, homeDir: home, tmp: ['/tmp'] };
  for (const role of ['ux', 'dev', 'qa', 'pm', 'architect'] as const) {
    const decision = judgeShellCommand('impeccable detect --json --no-advisory', roots, { workspace: repo, scrumRole: role });
    assert.equal(decision.behavior, ['ux', 'dev', 'qa'].includes(role) ? 'allow' : 'deny');
  }
  mkdirSync(join(home,'.pi/agent/skills/impeccable'), {recursive:true});
  writeFileSync(join(home,'.pi/agent/skills/impeccable/SKILL.md'),'Operator UI skill must not leak into standing seats');
  const identity = { kind: 'seat' as const, selectionRevision: 1, config: run.config };
  for (const authority of ['supervisor', 'lead'] as const) {
    const roleHome = provisionScrumHarness({ state, slug: project.slug, authority, identity, generation: 'g', userHome: home, workspace: repo });
    assert.doesNotMatch(readFileSync(join(roleHome, 'settings.json'), 'utf8'), /impeccable/);
    assert.equal(existsSync(join(roleHome,'skills/impeccable')), false);
  }
});

test('ADR 0036: inspectImpeccableTool, ensureProviderSkillSymlinks, and pre-spawn self-healing in provisionImpeccable', async (t) => {
  const { mkdirSync, existsSync, lstatSync, chmodSync } = await import('node:fs');
  const {
    inspectImpeccableTool,
    inspectFactorySkillPack,
    ensureProviderSkillSymlinks,
    provisionImpeccable,
    CORE_FACTORY_SKILLS,
  } = await import('../src/scrum/impeccable.ts');

  const home = makeTempDir();
  const roleHome = makeTempDir();
  for (const d of [home, roleHome]) disposeDir(t, d);

  // 1. Initially not_installed
  assert.equal(inspectImpeccableTool(home).status, 'not_installed');
  assert.equal(inspectFactorySkillPack(home).status, 'not_installed');

  // 2. Seed core skills in ~/.agents/skills and verify ensureProviderSkillSymlinks links them to .pi/agent/skills, .claude/skills, .gemini/config/skills
  for (const s of CORE_FACTORY_SKILLS) {
    mkdirSync(join(home, '.agents/skills', s), { recursive: true });
    writeFileSync(join(home, '.agents/skills', s, 'SKILL.md'), `# ${s}\n`);
  }
  const pack = inspectFactorySkillPack(home);
  assert.equal(pack.status, 'installed');
  assert.equal(pack.totalSkills, CORE_FACTORY_SKILLS.length);
  const linked = ensureProviderSkillSymlinks(home);
  assert.ok(linked.linked.length >= CORE_FACTORY_SKILLS.length * 3);
  for (const s of CORE_FACTORY_SKILLS) {
    assert.ok(lstatSync(join(home, '.pi/agent/skills', s)).isSymbolicLink());
    assert.ok(lstatSync(join(home, '.claude/skills', s)).isSymbolicLink());
    assert.ok(lstatSync(join(home, '.gemini/config/skills', s)).isSymbolicLink());
  }

  // 3. When autoInstall is true and runner fails, provisionImpeccable throws tool-missing
  assert.throws(
    () =>
      provisionImpeccable(roleHome, home, join(home, '.codex'), {
        autoInstall: true,
        requireInstalled: true,
        runner: () => ({ status: 1, stdout: '', stderr: 'registry offline' }),
      }),
    /Impeccable UI detector.*registry offline/,
  );

  // 4. When autoInstall is true and runner installs impeccable v4.8.0 (SKILL.md version: 4.8.0, scripts/VERSION: 0.1.18 engine) into ~/.agents/skills/impeccable, provisionImpeccable self-heals and links skills
  const provisioned = provisionImpeccable(roleHome, home, join(home, '.codex'), {
    autoInstall: true,
    requireInstalled: true,
    runner: () => {
      const impDir = join(home, '.agents/skills/impeccable');
      mkdirSync(join(impDir, 'scripts'), { recursive: true });
      writeFileSync(
        join(impDir, 'SKILL.md'),
        '---\nname: impeccable\nmetadata:\n  version: 4.8.0\n---\n# Impeccable\n',
      );
      writeFileSync(join(impDir, 'scripts/VERSION'), '0.1.18\n');
      writeFileSync(join(impDir, 'scripts/impeccable'), '#!/bin/sh\necho ok\n');
      chmodSync(join(impDir, 'scripts/impeccable'), 0o755);
      return { status: 0, stdout: 'installed 4.8.0', stderr: '' };
    },
  });
  assert.ok(provisioned.includes('impeccable'));
  assert.equal(inspectImpeccableTool(home).status, 'installed');
  assert.equal(inspectImpeccableTool(home).version, '4.8.0');
  assert.equal(inspectImpeccableTool(home).engineVersion, '0.1.18');
  assert.equal(existsSync(join(roleHome, 'skills/impeccable/SKILL.md')), true);
  assert.ok(lstatSync(join(home, '.pi/agent/skills/impeccable')).isSymbolicLink());
});
