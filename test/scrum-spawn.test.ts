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
      "DESIGN.md":
        "# Direction\nColor: navy.\nTypography: system-ui.\nSpacing: 8px.\nComponent: record card.\n",
      "EXPERIENCE.md":
        "# Information architecture and flow\nOne screen justified for the bounded record viewer. Offline writes permitted.\n| Screen | empty | loading | populated | error | offline | permission-denied |\n| viewer | no record | wait | record | retry | editable | denied |\n",
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
        "</main></body></html>",
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
