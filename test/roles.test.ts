import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { renderRoleAppendSystem, renderRoleContract, renderSeatBootstrapPrompt } from "../src/roles-contract.ts";
import { ROLE_PROMPTS } from "../src/pi-home.ts";
import { writeProjectRegistration } from "../plugin/server/projects.ts";
import { injectSessionEnv, renderAgentContract, renderSeatBootstrap, renderSeatContract } from "../plugin/server/roles.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

test("src/roles-contract.ts is the single source of truth for Supervisor, Lead, and Agent contracts and bootstraps (v0.0.23, ADR 0015)", () => {
  const supervisorContract = renderRoleContract("supervisor", { factoryCmd: "factory", home: "/h/paseo" });
  const supervisorSeat = renderSeatContract("supervisor", { root: "/w/repo", slug: "repo-abc123" });
  const supervisorBootstrap = renderSeatBootstrap({
    seat: "supervisor",
    home: "/h/paseo",
    stateDir: "/h/paseo/plugin-state/paseo-factory",
    pluginDir: "/h/plugins/paseo-factory",
    nodePath: "/usr/local/bin/node",
    path: "/usr/local/bin",
    lane: "opencode/glm-5.1",
    project: { root: "/w/repo", slug: "repo-abc123" },
  });
  const directBootstrap = renderSeatBootstrapPrompt({
    seat: "supervisor",
    home: "/h/paseo",
    stateDir: "/h/paseo/plugin-state/paseo-factory",
    pluginDir: "/h/plugins/paseo-factory",
    nodePath: "/usr/local/bin/node",
    path: "/usr/local/bin",
    lane: "opencode/glm-5.1",
    project: { root: "/w/repo", slug: "repo-abc123" },
  });
  assert.equal(supervisorBootstrap, directBootstrap, "roles.ts renderSeatBootstrap delegates directly to renderSeatBootstrapPrompt");
  assert.equal(ROLE_PROMPTS.supervisor, renderRoleAppendSystem("supervisor"), "pi-home ROLE_PROMPTS.supervisor delegates to roles-contract");

  // Supervisor contract & bootstrap include lead dispatch, status, accept --by supervisor, and the Fire-and-End-Turn law.
  for (const surface of [supervisorContract, supervisorSeat, supervisorBootstrap, ROLE_PROMPTS.supervisor]) {
    assert.match(surface, /lead dispatch --workspace "<project-root>" --message "<directive>"/);
    assert.match(surface, /status/);
    assert.match(surface, /accept <task> --attempt <n> --by supervisor/);
    assert.match(
      surface,
      /Immediately after running `lead dispatch`, end your turn and wait for Lead to wake you via `factory supervisor report` or `needs_human`\. Never run `sleep`, never poll files, never decompose tasks \(`T-01\.\.`\), and never edit product source code or commit on `<project-root>`\./,
    );
    assert.match(surface, /paseo-factory role skills: grilling, domain-modeling/);
    // Supervisor never lists factory contract or factory run.
    assert.doesNotMatch(surface, /contract --task/);
    assert.doesNotMatch(surface, /factory contract/);
    assert.doesNotMatch(surface, /factory run/);
    assert.doesNotMatch(surface, /\brun <task>/);
  }

  // Lead contract & bootstrap own decomposition, contract, run, intermediate accept --by lead, supervisor report, and Seat write fence.
  const leadContract = renderRoleContract("lead", { factoryCmd: "factory", home: "/h/paseo" });
  const leadSeat = renderSeatContract("lead", { root: "/w/repo", slug: "repo-abc123" });
  const leadBootstrap = renderSeatBootstrap({
    seat: "lead",
    home: "/h/paseo",
    stateDir: "/h/paseo/plugin-state/paseo-factory",
    pluginDir: "/h/plugins/paseo-factory",
    nodePath: "/usr/local/bin/node",
    path: "/usr/local/bin",
    lane: "opencode/glm-5.1",
    project: { root: "/w/repo", slug: "repo-abc123" },
  });
  assert.equal(ROLE_PROMPTS.lead, renderRoleAppendSystem("lead"), "pi-home ROLE_PROMPTS.lead delegates to roles-contract");

  for (const surface of [leadContract, leadSeat, leadBootstrap, ROLE_PROMPTS.lead]) {
    assert.match(surface, /contract --task <id> --workspace <dir> --gate <cmd> --artifact <path>/);
    assert.match(surface, /run <task>/);
    assert.match(surface, /accept <task> --attempt <n> --by lead/);
    assert.match(surface, /supervisor report --workspace "<project-root>" --message "<summary>"/);
    assert.match(surface, /Seat write fence/);
    assert.match(surface, /never.*product source code.*<project-root>/i);
    assert.match(surface, /paseo-factory role skills: codebase-design, domain-modeling, tdd/);
  }

  // Agent contract: works strictly inside assigned Task worktree on branch factory/<task>, runs Gate check, commits, calls factory-claim, ends turn.
  const agentContract = renderRoleContract("agent", { factoryCmd: "factory" });
  const agentSeat = renderAgentContract("T-01", "repo-abc123");
  assert.equal(ROLE_PROMPTS.agent, renderRoleAppendSystem("agent"), "pi-home ROLE_PROMPTS.agent delegates to roles-contract");

  for (const surface of [agentContract, agentSeat, ROLE_PROMPTS.agent]) {
    assert.match(surface, /Task worktree/);
    assert.match(surface, /factory\/(T-01|<task>)/);
    assert.match(surface, /factory-claim --task (T-01|<task>) --sha <sha>/);
    assert.match(surface, /end your turn/i);
    assert.match(surface, /paseo-factory role skills: tdd, diagnosing-bugs, codebase-design/);
  }
});

test("injectSessionEnv injects PASEO_FACTORY_SEAT=supervisor for normal-chat agentIds recorded in reg.dispatchers at <project-root> (v0.0.24, T-03)", (t) => {
  const dir = makeTempDir("roles-dispatcher-env-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  const projectRoot = "/w/ai-test";

  writeProjectRegistration(stateDir, "ai-test-043c7e", {
    root: projectRoot,
    supervisor: "sup-1",
    lead: "lead-1",
    dispatchers: ["chat-session-7c5ac02"],
  });

  // Dispatcher at <project-root> gets PASEO_FACTORY_SEAT=supervisor so git-shim enforces supervisor-git-fence
  const env: Record<string, string> = {};
  const injected = injectSessionEnv({ agentId: "chat-session-7c5ac02", cwd: projectRoot, env }, stateDir, userHome);
  assert.ok(injected !== undefined, "dispatcher agentId receives factory session env");
  assert.equal(injected.env.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(injected.env.PASEO_FACTORY_PROJECT, "ai-test-043c7e");
  assert.equal(injected.env.PASEO_FACTORY_PROJECT_ROOT, projectRoot);

  // Unrelated normal chat session is untouched
  const stranger = injectSessionEnv({ agentId: "stranger-chat", cwd: projectRoot, env }, stateDir, userHome);
  assert.equal(stranger, undefined, "unregistered normal chat session passes through untouched");
});
