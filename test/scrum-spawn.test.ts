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

test("Scrum create hooks preserve authority and provider-specific fences across all supported families", async t => {
  const { scopeScrumCapabilities } = await import("../plugin/server/core/scrum/harness.ts");
  const { applyProviderExecutionFence } = await import("../plugin/server/roles.ts");
  const state = makeTempDir(); disposeDir(t, state);
  const home = makeTempDir(); disposeDir(t, home);
  const identity = { kind: "task" as const, task: "ux", epoch: 1, binding: { mode: "scrum" as const, runId: "r", role: "ux" as const, policyRevision: "1", configRevision: 1, artifactRefs: [] } };
  for (const provider of ["pi", "claude", "codex", "opencode", "copilot", "omp", "antigravity"]) {
    const config = applyProviderExecutionFence({ cwd: home, provider, mcpServers: { "zai-vision": {}, dangerousCoordinator: {} }, systemPrompt: "UX role" }, { role: "agent", stateDir: state, projectSlug: "p", task: "ux", correlationId: "cor-ux", userHome: home });
    const scoped = scopeScrumCapabilities(config, "agent", identity);
    assert.match(scoped.systemPrompt!, /frontend-design/);
    assert.equal(scoped.mcpServers?.dangerousCoordinator, undefined);
    if (provider !== "antigravity") assert.ok((scoped.mcpServers as Record<string, unknown>)?.paseo_factory);
    const standing = scopeScrumCapabilities(config, "lead", { kind: "seat", selectionRevision: 1, config: { schemaVersion: 1, requireUiApproval: true, lanes: Object.fromEntries(["supervisor", "lead", "pm", "ux", "architect", "dev", "qa", "watch", "retro"].map(k => [k, "pi/model"])) as import("../src/scrum/config.ts").ScrumConfig["lanes"] } });
    assert.equal(standing.mcpServers?.["zai-vision"], undefined);
  }
});
