import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderRoleAppendSystem, renderRoleContract, renderSeatBootstrapPrompt } from "../src/roles-contract.ts";
import { ROLE_PROMPTS } from "../src/pi-home.ts";
import { CorrelationRegistry } from "../src/correlations.ts";
import { writeProjectRegistration } from "../plugin/server/projects.ts";
import {
  injectRoleOnCreate,
  injectSessionEnv,
  renderAgentContract,
  renderSeatBootstrap,
  renderSeatContract,
  sanitizeAgentCreateHookResult,
} from "../plugin/server/roles.ts";
import type { AgentCreateRequest } from "../plugin/server/roles.ts";
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

test("injectRoleOnCreate wires Layer-1 provider fence, paseo_factory MCP, and correlation tokens across all 7 providers and never leaks labels (v0.0.26, ADR 0016)", (t) => {
  const dir = makeTempDir("roles-7providers-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

  for (const provider of [
    "claude-code/claude-sonnet-4-6",
    "codex/gpt-5.4",
    "opencode/glm-5.1",
    "copilot/gpt-4.1",
    "cursor/claude-3.7-sonnet",
    "pi/zai/glm-5.3",
    "antigravity/gemini-2.5-pro",
  ]) {
    const req: AgentCreateRequest & { labels?: Record<string, string> } = {
      config: {
        provider,
        cwd: repoDir,
        title: "Supervisor — repo",
        labels: { seat: "supervisor" },
      } as AgentCreateRequest["config"] & { labels?: Record<string, string> },
      labels: { seat: "supervisor" },
    };
    const res = injectRoleOnCreate(req, stateDir, userHome);
    assert.ok(res !== undefined, `injectRoleOnCreate returned result for ${provider}`);
    // Strict Paseo 0.11.2 agent.create return schema: only { config, env }, no labels anywhere
    assert.deepEqual(Object.keys(res).sort(), ["config", "env"]);
    assert.equal("labels" in res.config, false, `config.labels stripped for ${provider}`);
    assert.ok(res.env?.PASEO_FACTORY_CORRELATION?.startsWith("cor_"), `correlationId issued for ${provider}`);

    const family = provider.split("/")[0];
    if (family === "antigravity") {
      assert.equal("mcpServers" in res.config, false, "antigravity never receives config.mcpServers");
      assert.ok(
        existsSync(join(userHome, ".gemini", "config", "plugins", "paseo-factory", "plugin.json")),
        "antigravity plugin bundle provisioned under userHome/.gemini/config/plugins/paseo-factory",
      );
    } else {
      const mcp = (res.config.mcpServers as Record<string, { command: string; args: string[] }>)?.paseo_factory;
      assert.ok(mcp !== undefined, `${provider} receives config.mcpServers.paseo_factory`);
      assert.ok(mcp.args.includes(res.env!.PASEO_FACTORY_CORRELATION!));
    }

    if (family === "claude-code") {
      assert.equal(res.config.modeId, "default");
      assert.equal(res.config.featureValues?.auto_accept, false);
      const disallowed = (res.config.providerOptions as { disallowedTools: string[] }).disallowedTools;
      assert.ok(disallowed.includes("Write") && disallowed.includes("Edit") && disallowed.includes("Task"));
      assert.ok(disallowed.includes("mcp__paseo__create_agent"));
    } else if (family === "codex") {
      assert.equal(res.config.modeId, "default");
      assert.equal(res.config.featureValues?.auto_accept, false);
      assert.equal((res.config.providerOptions as { features: { multi_agent_v2: boolean } }).features.multi_agent_v2, false);
    } else if (family === "opencode") {
      assert.equal(res.config.modeId, "default");
      assert.equal(res.config.featureValues?.auto_accept, false);
      assert.deepEqual((res.config.providerOptions as { permission: Record<string, string> }).permission, {
        edit: "deny",
        task: "deny",
      });
    } else if (family === "copilot" || family === "cursor") {
      assert.equal(res.config.modeId, "default");
      assert.equal(res.config.featureValues?.auto_accept, false);
    }
  }

  const correlations = new CorrelationRegistry(stateDir).list();
  assert.equal(correlations.length, 7, "all 7 seat creations recorded correlation tokens");
  assert.deepEqual(
    Object.keys(sanitizeAgentCreateHookResult({ config: { cwd: repoDir, labels: { seat: "lead" } } as never, env: { A: "1" } })).sort(),
    ["config", "env"],
  );
});

test("agy-pre-tool-hook.mjs fast-allows unbound sessions and enforces seat-write-fence, seat-paseo-tool-fence, and Contract scope on factory seats (v0.0.26, ADR 0016)", (t) => {
  const dir = makeTempDir("agy-hook-test-");
  disposeDir(t, dir);
  const hookBin = resolve(import.meta.dirname, "../plugin/bin/agy-pre-tool-hook.mjs");
  const stateDir = join(dir, "state");
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });

  // 1. Unbound session fast-path allow (exit 0)
  const unboundOut = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({ tool_name: "write_file", tool_input: { Path: join(repoDir, "src/index.ts") }, cwd: repoDir }),
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    }),
  );
  assert.equal(unboundOut.decision, "allow", "unbound session exits immediately with decision=allow");

  // 2. Supervisor seat: denies write_file on product source code, allows CONTEXT.md, denies invoke_subagent & pkill plugin-process.js
  const supEnv = {
    PATH: process.env.PATH,
    PASEO_FACTORY_SEAT: "supervisor",
    PASEO_FACTORY_STATE_DIR: stateDir,
    PASEO_FACTORY_PROJECT_ROOT: repoDir,
  };
  const denyWrite = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({ tool_name: "write_file", tool_input: { Path: join(repoDir, "src/index.ts") }, cwd: repoDir }),
      env: supEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(denyWrite.decision, "deny");
  assert.equal(denyWrite.hookSpecificOutput.permissionDecision, "deny");

  const allowContext = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({ tool_name: "write_file", tool_input: { Path: join(repoDir, "CONTEXT.md") }, cwd: repoDir }),
      env: supEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(allowContext.decision, "allow", "Supervisor allowed to edit CONTEXT.md");

  const denySubagent = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({ tool_name: "invoke_subagent", tool_input: {}, cwd: repoDir }),
      env: supEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(denySubagent.hookSpecificOutput.permissionDecision, "deny");

  const denyPkill = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({
        tool_name: "run_command",
        tool_input: { CommandLine: "pkill -f plugin-process.js" },
        cwd: repoDir,
      }),
      env: supEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(denyPkill.hookSpecificOutput.permissionDecision, "deny");
});
