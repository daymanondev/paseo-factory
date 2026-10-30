import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { renderRoleAppendSystem, renderRoleContract, renderSeatBootstrapPrompt } from "../src/roles-contract.ts";
import { buildSeatKickoffPacket } from "../src/preflight.ts";
import { ROLE_PROMPTS } from "../src/pi-home.ts";
import { CorrelationRegistry } from "../src/correlations.ts";
import { ensureGitRepository, readProjectRegistration, resolveOrBootstrapProject, resolveProject } from "../plugin/server/core/project.ts";
import { writeProjectRegistration } from "../plugin/server/projects.ts";
import {
  applyProviderExecutionFence,
  formatPeerAgentTitle,
  formatPeerWorkspaceTitle,
  injectRoleOnCreate,
  injectSessionEnv,
  renderAgentContract,
  renderSeatBootstrap,
  renderSeatContract,
  resolveEffectiveProviderFamily,
  sanitizeAgentCreateHookResult,
  inferRoleFromProviderId,
  SEAT_TITLES,
} from "../plugin/server/roles.ts";
import type { AgentCreateRequest } from "../plugin/server/roles.ts";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

/** A committed git repository — the Project resolution every seat path needs. */
function makeGitRepo(dir: string): string {
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

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
    assert.match(surface, /contract --task <id> --workspace <dir> --gate <cmd> \[--artifact <path>\]/);
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

test("Supervisor contract diagnoses run failures read-only and dispatches repairs to Lead", () => {
  const contract = renderRoleContract("supervisor");
  assert.match(contract, /Diagnostics & Run-Verification Law:/);
  assert.match(contract, /Owner reports.*cannot run.*command fails/);
  assert.match(contract, /read-only.*`ls -la`.*`cat package.json`.*`node_modules\/\.bin`/);
  assert.match(contract, /Never run package-mutating.*`npm install`.*git-mutating commands/);
  assert.match(contract, /immediately dispatch.*`supervisor_dispatch_lead`/);
});

test("Lead contracts follow the Outcome & Regression-Gate Law without pre-solving file scopes (ADR 0028)", () => {
  const contract = renderRoleContract("lead");
  assert.match(contract, /Outcome & Regression-Gate Law:/);
  assert.match(contract, /desired behavioral outcome and regression invariants/);
  assert.match(contract, /never pre-solve or handcuff which code files the working Agent may touch/);
  assert.match(contract, /entrypoint integration.*`index\.html`.*`src\/main\.ts`.*AND the repository's existing test\/typecheck\/build suite/);
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
    "omp/claude-3.7-sonnet",
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
      const disallowed = (res.config.providerOptions as { disallowedTools: string[] }).disallowedTools;
      assert.ok(disallowed.includes("Write") && disallowed.includes("Edit") && disallowed.includes("Task"));
      assert.ok(disallowed.includes("mcp__paseo__create_agent"));
    } else if (family === "codex") {
      assert.equal(res.config.modeId, "auto");
      assert.equal((res.config.providerOptions as { features: { multi_agent_v2: boolean } }).features.multi_agent_v2, false);
    } else if (family === "opencode") {
      assert.equal(res.config.modeId, "build");
      assert.equal(res.config.featureValues?.auto_accept, true);
      assert.deepEqual(res.config.toolPolicy, { preapproved: [] });
      assert.deepEqual((res.config.providerOptions as { permission: Record<string, unknown> }).permission, {
        edit: "deny",
        task: "deny",
        bash: "ask",
        skill: { "*": "deny", grilling: "allow" },
      });
      const hyphenMcp = (res.config.mcpServers as Record<string, { command: string; args: string[] }>)?.["paseo-factory"];
      assert.ok(hyphenMcp !== undefined, "opencode also receives config.mcpServers['paseo-factory'] to survive bridge-plugin.mjs");
    } else if (family === "copilot") {
      assert.equal(res.config.modeId, "https://agentclientprotocol.com/protocol/session-modes#plan");
      assert.equal(res.config.featureValues?.auto_accept, false);
    } else if (family === "omp") {
      assert.equal(res.config.modeId, "write");
    }
  }

  // Lead modeId checks for opencode ("build") and copilot ("...#agent")
  const leadOpencode = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "opencode/glm-5.1", cwd: repoDir, title: "Lead — repo" } },
    stateDir,
    userHome,
  );
  assert.equal(leadOpencode?.config.modeId, "build");
  const leadCopilot = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "copilot/gpt-4.1", cwd: repoDir, title: "Lead — repo" } },
    stateDir,
    userHome,
  );
  assert.equal(leadCopilot?.config.modeId, "https://agentclientprotocol.com/protocol/session-modes#agent");

  const correlations = new CorrelationRegistry(stateDir).list();
  assert.equal(correlations.length, 9, "all seat creations recorded correlation tokens");
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

  const ALLOWED_AGY_PROTO_KEYS = new Set(["decision", "reason", "permissionOverrides", "overwrite"]);
  const assertValidAgyProtoOutput = (out: Record<string, unknown>, context: string) => {
    const unknown = Object.keys(out).filter((k) => !ALLOWED_AGY_PROTO_KEYS.has(k));
    assert.deepEqual(unknown, [], `${context}: PreToolUse output must not include unknown protojson fields (e.g. hookSpecificOutput)`);
  };

  // 2. Supervisor seat: denies write_file on product source code, allows CONTEXT.md, allows read_file & call_mcp_tool (supervisor_dispatch_lead), denies invoke_subagent & pkill plugin-process.js
  const supEnv = {
    PATH: process.env.PATH,
    PASEO_FACTORY_SEAT: "supervisor",
    PASEO_FACTORY_STATE_DIR: stateDir,
    PASEO_FACTORY_PROJECT_ROOT: repoDir,
  };
  const allowRead = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({
        toolCall: { name: "read_file", args: { Path: join(repoDir, "package.json") } },
        workspacePaths: [repoDir],
      }),
      env: supEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(allowRead.decision, "allow", "Supervisor allowed to call read_file");
  assertValidAgyProtoOutput(allowRead, "allowRead");

  const allowDispatchMcp = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({
        toolCall: {
          name: "call_mcp_tool",
          args: {
            ServerName: "paseo-factory_paseo_factory",
            ToolName: "supervisor_dispatch_lead",
            Arguments: { workspace: repoDir, message: "Ship feature" },
          },
        },
        workspacePaths: [repoDir],
      }),
      env: supEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(allowDispatchMcp.decision, "allow", "Supervisor allowed to call supervisor_dispatch_lead via call_mcp_tool");
  assertValidAgyProtoOutput(allowDispatchMcp, "allowDispatchMcp");

  const denyWriteNative = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({
        toolCall: { name: "write_file", args: { Path: "src/index.ts" } },
        workspacePaths: [repoDir],
      }),
      env: {
        PATH: process.env.PATH,
        PASEO_FACTORY_SEAT: "supervisor",
        PASEO_FACTORY_STATE_DIR: stateDir,
      },
      encoding: "utf8",
    }),
  );
  assert.equal(denyWriteNative.decision, "deny", "Native Antigravity toolCall payload with workspacePaths enforces seat-write-fence");
  assert.match(String(denyWriteNative.reason), /Seat write fence/);
  assertValidAgyProtoOutput(denyWriteNative, "denyWriteNative");

  const denyWrite = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({ tool_name: "write_file", tool_input: { Path: join(repoDir, "src/index.ts") }, cwd: repoDir }),
      env: supEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(denyWrite.decision, "deny");
  assert.match(String(denyWrite.reason), /Seat write fence/);
  assertValidAgyProtoOutput(denyWrite, "denyWrite");

  const allowContext = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({ tool_name: "write_file", tool_input: { Path: join(repoDir, "CONTEXT.md") }, cwd: repoDir }),
      env: supEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(allowContext.decision, "allow", "Supervisor allowed to edit CONTEXT.md");
  assertValidAgyProtoOutput(allowContext, "allowContext");

  const denySubagent = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({ toolCall: { name: "invoke_subagent", args: {} }, workspacePaths: [repoDir] }),
      env: supEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(denySubagent.decision, "deny");
  assertValidAgyProtoOutput(denySubagent, "denySubagent");

  const denyPkill = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({
        toolCall: { name: "run_command", args: { CommandLine: "pkill -f plugin-process.js" } },
        workspacePaths: [repoDir],
      }),
      env: supEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(denyPkill.decision, "deny");
  assertValidAgyProtoOutput(denyPkill, "denyPkill");
});

test("inferRoleFromProviderId maps the native role providers deterministically and applyProviderExecutionFence always carries ELECTRON_RUN_AS_NODE (v0.0.27, ADR 0017 §2)", (t) => {
  const dir = makeTempDir("roles-electron-env-");
  disposeDir(t, dir);
  assert.equal(inferRoleFromProviderId("factory-supervisor"), "supervisor");
  assert.equal(inferRoleFromProviderId("factory-lead"), "lead");
  assert.equal(inferRoleFromProviderId("factory-peer"), "agent");
  assert.equal(inferRoleFromProviderId("factory-agent"), "agent");
  assert.equal(inferRoleFromProviderId("factory-supervisor/glm-5.1"), "supervisor", "the provider/model form resolves too");
  assert.equal(inferRoleFromProviderId("opencode/opencode/glm-5.1"), undefined);
  assert.equal(inferRoleFromProviderId(undefined), undefined);

  // The Layer-1 fence always carries Node mode for the bridge — even on a
  // plain node execPath (harmless there, load-bearing under Paseo Desktop).
  const fenced = applyProviderExecutionFence<AgentCreateRequest["config"]>(
    { provider: "opencode/opencode/glm-5.1", cwd: "/w/repo" },
    { role: "supervisor", stateDir: join(dir, "state"), correlationId: "cor_x", projectSlug: "repo-abc123" },
  );
  const mcp = (fenced.mcpServers as Record<string, { env: Record<string, string> }>).paseo_factory;
  assert.equal(mcp.env.ELECTRON_RUN_AS_NODE, "1");
});

test("injectRoleOnCreate recognizes factory-supervisor by provider id alone — natural-language title, opencode Layer-1 fence via Lane config, ELECTRON_RUN_AS_NODE, and the seat env (v0.0.27, ADR 0017 §2)", (t) => {
  const dir = makeTempDir("roles-provider-seat-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  const repoDir = makeGitRepo(dir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok, "the fixture repo resolves");
  const slug = resolved.ok ? resolved.slug : "";
  // Lane config pins the supervisor harness to opencode — the fence must resolve through it.
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "lanes.json"),
    `${JSON.stringify({ supervisor: "opencode/opencode/glm-5.1", lead: "opencode/opencode/glm-5.1", worker: "opencode/opencode/glm-5.1" }, null, 2)}\n`,
  );
  assert.equal(resolveEffectiveProviderFamily("factory-supervisor", "supervisor", stateDir, slug), "opencode");
  assert.equal(resolveEffectiveProviderFamily("claude-code/opus-4-8", "supervisor", stateDir, slug), "claude");

  const res = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "factory-supervisor", cwd: repoDir, title: "Hãy xây dựng một tựa game 3D" }, env: {} },
    stateDir,
    userHome,
  );
  assert.ok(res !== undefined, "the provider id alone injects the role — the title is just the user's message");
  assert.deepEqual(Object.keys(res).sort(), ["config", "env"]);
  // The opencode Layer-1 supervisor fence, resolved through lanes.supervisor.
  assert.equal(res.config.provider, "factory-supervisor", "the provider id rides verbatim for the daemon");
  assert.equal(res.config.modeId, "build");
  assert.equal(res.config.featureValues?.auto_accept, true);
  assert.deepEqual(res.config.toolPolicy, { preapproved: [] });
  assert.deepEqual((res.config.providerOptions as { permission: Record<string, unknown> }).permission, {
    edit: "deny",
    task: "deny",
    bash: "ask",
    skill: { "*": "deny", grilling: "allow" },
  });
  // paseo_factory MCP (plus paseo-factory alias for OpenCode v2 bridge-plugin.mjs) with Node mode and the correlation token.
  const mcp = (res.config.mcpServers as Record<string, { env: Record<string, string>; args: string[] }>).paseo_factory;
  const hyphenMcp = (res.config.mcpServers as Record<string, { env: Record<string, string>; args: string[] }>)["paseo-factory"];
  assert.ok(mcp !== undefined, "factory-supervisor receives config.mcpServers.paseo_factory");
  assert.ok(hyphenMcp !== undefined, "factory-supervisor on opencode receives config.mcpServers['paseo-factory']");
  assert.equal(mcp.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(mcp.env.PASEO_FACTORY_SEAT, "supervisor");
  assert.ok(mcp.args.includes(res.env!.PASEO_FACTORY_CORRELATION!));
  // The seat env and the role contract. (`resolved.root` is git's physical
  // toplevel — on macOS it may carry the `/private` prefix the tmpdir lacks.)
  assert.equal(res.env?.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(res.env?.PASEO_FACTORY_PROJECT, slug);
  assert.equal(res.env?.PASEO_FACTORY_PROJECT_ROOT, resolved.ok ? resolved.root : undefined);
  assert.ok(res.env?.PASEO_FACTORY_CORRELATION?.startsWith("cor_"));
  assert.match(res.config.systemPrompt ?? "", /paseo-factory role skills:/);
  // The Project was registered.
  assert.equal(readProjectRegistration(stateDir, slug)?.root, resolved.ok ? resolved.root : "");

  // factory-lead fences as the opencode Lead ("build"), still by provider alone.
  const lead = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "factory-lead", cwd: repoDir, title: "any first message" } },
    stateDir,
    userHome,
  );
  assert.equal(lead?.config.modeId, "build");
  assert.equal(lead?.env?.PASEO_FACTORY_SEAT, "lead");

  // factory-peer outside a worktree runs the agent fence — never a seat modeId.
  const peer = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "factory-peer", cwd: repoDir, title: "any first message" } },
    stateDir,
    userHome,
  );
  assert.equal(peer?.env?.PASEO_FACTORY_SEAT, "agent");
  assert.equal(peer?.config.modeId, undefined);
  assert.equal((peer?.config.providerOptions as { permission: Record<string, string> } | undefined)?.permission?.task, "deny");

  // The identity ladder: the provider id outranks the title guess, the env
  // stamp backs up a plain harness provider, and `/factory` titles still
  // fence as the Owner's dispatcher seat.
  const peerDespiteTitle = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "factory-peer", cwd: repoDir, title: "Supervisor — repo" } },
    stateDir,
    userHome,
  );
  assert.equal(peerDespiteTitle?.env?.PASEO_FACTORY_SEAT, "agent", "the provider id outranks the title guess");

  const envStamped = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "opencode/opencode/glm-5.1", cwd: repoDir, title: "any first message" }, env: { PASEO_FACTORY_SEAT: "supervisor" } },
    stateDir,
    userHome,
  );
  assert.equal(envStamped?.config.modeId, "build", "the PASEO_FACTORY_SEAT env stamp backs up a plain provider");
  assert.equal(envStamped?.env?.PASEO_FACTORY_SEAT, "supervisor");

  const factoryTitle = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "opencode/opencode/glm-5.1", cwd: repoDir, title: "/factory lead dispatch --workspace ." } },
    stateDir,
    userHome,
  );
  assert.equal(factoryTitle?.config.modeId, "build", "a `/factory` title still fences as the dispatcher seat");
});

test("injectRoleOnCreate fences a factory-peer Task-worktree spawn under the worker lane's harness — the Layer-1 agent fence resolves through Lane config (v0.0.27, ADR 0017 §2)", (t) => {
  const dir = makeTempDir("roles-peer-worktree-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  // The worker lane names opencode — a `factory-peer` spawn must fence as
  // opencode, never as the unknown family "factory-peer" (which matches no
  // branch and silently drops the agent fence).
  writeFileSync(
    join(stateDir, "lanes.json"),
    `${JSON.stringify({ supervisor: "opencode/opencode/glm-5.1", lead: "opencode/opencode/glm-5.1", worker: "opencode/opencode/glm-5.1" }, null, 2)}\n`,
  );
  const worktreeDir = join(stateDir, "projects", "repo-abc123", "worktrees", "T1");
  mkdirSync(worktreeDir, { recursive: true });

  const res = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "factory-peer", cwd: worktreeDir, title: "T1" } },
    stateDir,
  );
  assert.ok(res !== undefined, "the managed-worktree branch fires for a factory-peer spawn");
  assert.equal(res.env?.PASEO_FACTORY_SEAT, "agent");
  assert.equal(res.config.modeId, undefined, "the agent fence never sets a seat modeId");
  assert.deepEqual(
    (res.config.providerOptions as { permission: Record<string, string> }).permission,
    { task: "deny" },
    "the opencode worker-lane Layer-1 agent fence applies by provider family resolution",
  );
  const mcp = (res.config.mcpServers as Record<string, { env: Record<string, string> }>).paseo_factory;
  assert.ok(mcp !== undefined, "paseo_factory MCP is wired");
  assert.equal(mcp.env.ELECTRON_RUN_AS_NODE, "1");

  // An antigravity worker lane rides the antigravity branch instead: no MCP
  // server config and the agy plugin provisions (roles.ts's delete-mcpServers law).
  const agyDir = makeTempDir("roles-peer-worktree-agy-");
  disposeDir(t, agyDir);
  const agyStateDir = join(agyDir, "state");
  mkdirSync(agyStateDir, { recursive: true });
  writeFileSync(
    join(agyStateDir, "lanes.json"),
    `${JSON.stringify({ worker: "agy/agent" }, null, 2)}\n`,
  );
  const agyWorktree = join(agyStateDir, "projects", "repo-abc123", "worktrees", "T1");
  mkdirSync(agyWorktree, { recursive: true });
  const agyRes = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "factory-peer", cwd: agyWorktree, title: "T1" } },
    agyStateDir,
  );
  assert.ok(agyRes !== undefined);
  assert.equal(agyRes.config.mcpServers, undefined, "the antigravity branch deletes mcpServers for an agy worker lane");
});

test("injectSessionEnv binds provider-recognized supervisor and lead sessions into project.json without displacing another bound session (v0.0.27, ADR 0017 §2)", (t) => {
  const dir = makeTempDir("roles-session-bind-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  const repoDir = makeGitRepo(dir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok);
  const slug = resolved.ok ? resolved.slug : "";

  // A native `Supervisor (Factory)` chat opens at the repository.
  const openedEnv: Record<string, string> = {};
  const opened = injectSessionEnv(
    { agentId: "native-sup-1", cwd: repoDir, provider: "factory-supervisor", env: openedEnv },
    stateDir,
    userHome,
  );
  assert.ok(opened !== undefined, "a provider-recognized session receives its factory env");
  assert.equal(opened.env.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(opened.env.PASEO_FACTORY_PROJECT, slug);
  assert.equal(opened.env.PASEO_FACTORY_PROJECT_ROOT, resolved.ok ? resolved.root : undefined);
  assert.equal(readProjectRegistration(stateDir, slug)?.supervisor, "native-sup-1", "session_open binds the supervisor into project.json");

  // A second supervisor session never displaces the bound one.
  const second = injectSessionEnv(
    { agentId: "native-sup-2", cwd: repoDir, provider: "factory-supervisor", env: {} },
    stateDir,
    userHome,
  );
  assert.ok(second !== undefined, "the second session still carries its env");
  assert.equal(readProjectRegistration(stateDir, slug)?.supervisor, "native-sup-1", "an occupied seat is never displaced");

  // The `PASEO_FACTORY_SEAT` env stamp binds a lead without a factory provider id.
  const leadOpened = injectSessionEnv(
    { agentId: "native-lead-1", cwd: repoDir, env: { PASEO_FACTORY_SEAT: "lead" } },
    stateDir,
    userHome,
  );
  assert.equal(leadOpened?.env.PASEO_FACTORY_SEAT, "lead");
  assert.equal(readProjectRegistration(stateDir, slug)?.lead, "native-lead-1");

  // An unrelated session at the same repository is untouched.
  const stranger = injectSessionEnv({ agentId: "stranger-chat", cwd: repoDir, env: {} }, stateDir, userHome);
  assert.equal(stranger, undefined, "an unrecognized session passes through untouched");
});

test("injectRoleOnCreate stamps clean role titles — Supervisor / Lead on the seat path, Peer · <Task> on the Task worktree path (v0.0.31, ADR 0017 §2)", (t) => {
  const dir = makeTempDir("roles-seat-titles-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  const repoDir = makeGitRepo(dir);

  // SEAT_TITLES drops the legacy "(paseo-factory)" suffix — the Agent tab reads the bare role.
  assert.deepEqual(SEAT_TITLES, { supervisor: "Supervisor", lead: "Lead" });

  const sup = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "factory-supervisor", cwd: repoDir, title: "Hãy xây dựng một tựa game 3D" }, env: {} },
    stateDir,
    userHome,
  );
  assert.ok(sup !== undefined, "the supervisor create injects");
  assert.equal(sup.config.title, "Supervisor", "the Supervisor Agent tab title replaces the raw first message");

  const lead = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "factory-lead", cwd: repoDir, title: "any first message" } },
    stateDir,
    userHome,
  );
  assert.equal(lead?.config.title, "Lead", "the Lead Agent tab title replaces the raw first message");

  // A factory-peer spawn inside a managed Task worktree gets the Peer tab title.
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "lanes.json"),
    `${JSON.stringify({ supervisor: "opencode/opencode/glm-5.1", lead: "opencode/opencode/glm-5.1", worker: "opencode/opencode/glm-5.1" }, null, 2)}\n`,
  );
  const worktreeDir = join(stateDir, "projects", "repo-abc123", "worktrees", "T-08");
  mkdirSync(worktreeDir, { recursive: true });
  const peer = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "factory-peer", cwd: worktreeDir, title: "T-08" } },
    stateDir,
  );
  assert.ok(peer !== undefined, "the managed-worktree branch fires for the peer create");
  assert.equal(peer.config.title, "Peer · T-08", "the Task worktree Agent tab reads Peer · <Task>");

  // sanitizeAgentCreateHookResult keeps config.title on the returned config —
  // the stamped role title must survive the strict agent.create return schema.
  const sanitized = sanitizeAgentCreateHookResult({
    config: { cwd: repoDir, title: "Supervisor", labels: { seat: "supervisor" } } as never,
    env: { A: "1" },
  });
  assert.equal((sanitized.config as { title?: string }).title, "Supervisor", "config.title survives sanitizeAgentCreateHookResult");
});

test("formatPeerWorkspaceTitle derives the first summary clause — separators, the 56-char cap, and the no-description fallback (v0.0.31, ADR 0017 §5)", () => {
  assert.equal(formatPeerAgentTitle("T-08"), "Peer · T-08");
  assert.equal(formatPeerWorkspaceTitle("T-08"), "Peer · T-08", "no description yields the bare Peer title");
  assert.equal(formatPeerWorkspaceTitle("T-08", "   "), "Peer · T-08", "whitespace-only description yields no clause");
  assert.equal(formatPeerWorkspaceTitle("T-08", "— only a second clause"), "Peer · T-08", "an empty first clause yields no summary");
  assert.equal(formatPeerWorkspaceTitle("T-08", "Add login screen. Second sentence dropped."), "Peer · T-08 — Add login screen");
  assert.equal(formatPeerWorkspaceTitle("T-08", "Fix crash: the tail drops"), "Peer · T-08 — Fix crash");
  assert.equal(formatPeerWorkspaceTitle("T-08", "First clause; second clause"), "Peer · T-08 — First clause");
  assert.equal(formatPeerWorkspaceTitle("T-08", "First clause — second clause"), "Peer · T-08 — First clause");
  assert.equal(formatPeerWorkspaceTitle("T-08", "One. Two — three"), "Peer · T-08 — One", "the earliest separator wins");
  assert.equal(
    formatPeerWorkspaceTitle("T-08", "Colon:no-space is not a separator"),
    "Peer · T-08 — Colon:no-space is not a separator",
    "the separators need their trailing space",
  );
  assert.equal(formatPeerWorkspaceTitle("T-08", "a".repeat(56)), `Peer · T-08 — ${"a".repeat(56)}`, "exactly 56 chars is not truncated");
  assert.equal(formatPeerWorkspaceTitle("T-08", "a".repeat(57)), `Peer · T-08 — ${"a".repeat(56)}…`, "the clause caps at 56 chars with an ellipsis");
});

test("injectSessionEnv persists the Supervisor's workspaceId into the project registration JSON — never for an agent-role session (v0.0.31, ADR 0017 §5)", (t) => {
  const dir = makeTempDir("roles-session-workspace-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  const repoDir = makeGitRepo(dir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok);
  const slug = resolved.ok ? resolved.slug : "";

  // The identity arm: a native Supervisor session opens carrying its workspaceId.
  const opened = injectSessionEnv(
    { agentId: "sup-wks-1", cwd: repoDir, provider: "factory-supervisor", env: {}, workspaceId: "wks_sup_main" },
    stateDir,
    userHome,
  );
  assert.ok(opened !== undefined, "the supervisor session receives its factory env");
  const registrationPath = join(stateDir, "projects", slug, "project.json");
  const onDisk = JSON.parse(readFileSync(registrationPath, "utf8")) as Record<string, unknown>;
  assert.equal(onDisk.workspaceId, "wks_sup_main", "workspaceId lands in the registration JSON under the state dir");
  const bound = readProjectRegistration(stateDir, slug);
  assert.equal(bound?.workspaceId, "wks_sup_main");
  assert.equal(bound?.supervisor, "sup-wks-1");

  // An agent-role session inside a Task worktree never persists a workspaceId.
  const worktreeDir = join(stateDir, "projects", slug, "worktrees", "T-08");
  mkdirSync(worktreeDir, { recursive: true });
  const peerEnv: Record<string, string> = {};
  const peer = injectSessionEnv(
    { agentId: "peer-wks-1", cwd: worktreeDir, provider: "factory-peer", env: peerEnv, workspaceId: "wks_peer" },
    stateDir,
    userHome,
  );
  assert.ok(peer !== undefined, "the peer session receives its factory env");
  assert.equal(peer.env.PASEO_FACTORY_SEAT, "agent");
  assert.equal(
    readProjectRegistration(stateDir, slug)?.workspaceId,
    "wks_sup_main",
    "an agent-role session never overwrites the persisted workspaceId",
  );

  // The associated-correlation arm: the token issued at create time carries the bind.
  const created = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "factory-lead", cwd: repoDir, title: "Lead" } },
    stateDir,
    userHome,
  );
  const correlationId = created?.env?.PASEO_FACTORY_CORRELATION;
  assert.ok(correlationId !== undefined, "the lead create issued a correlation token");
  const leadOpened = injectSessionEnv(
    { agentId: "lead-wks-1", cwd: repoDir, env: { PASEO_FACTORY_CORRELATION: correlationId }, workspaceId: "wks_sup_main" },
    stateDir,
    userHome,
  );
  assert.ok(leadOpened !== undefined, "the associated lead session receives its factory env");
  const afterLead = readProjectRegistration(stateDir, slug);
  assert.equal(afterLead?.lead, "lead-wks-1", "the associated-correlation arm binds the lead seat");
  assert.equal(afterLead?.workspaceId, "wks_sup_main", "persisting workspaceId again keeps the same main workspace");
  assert.equal(afterLead?.supervisor, "sup-wks-1", "the workspaceId write never clobbers the supervisor binding");
});

test("injectSessionEnv never persists workspaceId from a session that did not bind the seat — an occupied supervisor keeps its Workspace (v0.0.31, ADR 0017 §5)", (t) => {
  const dir = makeTempDir("roles-seat-workspace-occupied-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  const repoDir = makeGitRepo(dir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok);
  const slug = resolved.ok ? resolved.slug : "";

  // The first Supervisor session binds the seat and persists its Workspace.
  const firstEnv: Record<string, string> = {};
  const first = injectSessionEnv(
    { agentId: "sup-a", cwd: repoDir, provider: "factory-supervisor", env: firstEnv, workspaceId: "wks_sup_main" },
    stateDir,
    userHome,
  );
  assert.ok(first !== undefined, "the first supervisor session receives its factory env");
  assert.equal(readProjectRegistration(stateDir, slug)?.workspaceId, "wks_sup_main");

  // A second supervisor session in a DIFFERENT Workspace never re-points the
  // registration's workspaceId: it did not bind the seat, so per
  // Implementation Decision 1 it must not persist its Workspace either.
  const secondEnv: Record<string, string> = {};
  const second = injectSessionEnv(
    { agentId: "sup-b", cwd: repoDir, provider: "factory-supervisor", env: secondEnv, workspaceId: "wks_other" },
    stateDir,
    userHome,
  );
  assert.ok(second !== undefined, "the second session still carries its env");
  const reg = readProjectRegistration(stateDir, slug);
  assert.equal(reg?.supervisor, "sup-a", "an occupied seat is never displaced");
  assert.equal(reg?.workspaceId, "wks_sup_main", "a session that did not bind the seat never persists its workspaceId");
});

test("CJS bundle regression: ensureFactoryBinScripts, injectRoleOnCreate, and injectSessionEnv materialize <stateDir>/bin/bridge.mjs even when esbuild strips import.meta.url in CJS mode", async (t) => {
  const { build } = await import("esbuild");
  const { createRequire } = await import("node:module");
  const dir = makeTempDir("roles-cjs-bridge-");
  disposeDir(t, dir);

  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo(dir);
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(
    join(paseoHome, "config.json"),
    JSON.stringify({
      plugins: {
        "paseo-factory": {
          source: "directory",
          path: join(repoRoot, "plugin"),
          enabled: true,
        },
      },
    }),
  );

  // Compile roles.ts (which bundles agy-home.ts) as CommonJS (just like Paseo's plugin loader does, where import.meta is {})
  const bundled = await build({
    entryPoints: [join(repoRoot, "plugin", "server", "roles.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
  });
  const cjsMod = { exports: {} as Record<string, unknown> };
  const req = createRequire(import.meta.url);
  const runCjs = new Function("exports", "require", "module", bundled.outputFiles[0]!.text);
  runCjs(cjsMod.exports, req, cjsMod);

  const injectRoleOnCreateCjs = cjsMod.exports.injectRoleOnCreate as typeof injectRoleOnCreate;
  const injected = injectRoleOnCreateCjs(
    {
      config: {
        provider: "factory-supervisor",
        cwd: repoDir,
        title: "New Chat",
      },
    },
    stateDir,
    join(dir, "user-home"),
  );
  assert.ok(injected);
  assert.equal(existsSync(join(stateDir, "bin", "bridge.mjs")), true, "injectRoleOnCreate in CJS mode materializes bridge.mjs on disk");
  assert.equal(existsSync(join(stateDir, "bin", "agy-pre-tool-hook.mjs")), true, "injectRoleOnCreate in CJS mode materializes agy-pre-tool-hook.mjs on disk");

  // Also verify injectSessionEnv in CJS mode materializes bridge.mjs when opening a session on a fresh stateDir
  const dir2 = makeTempDir("roles-cjs-bridge2-");
  disposeDir(t, dir2);
  const paseoHome2 = join(dir2, "paseo-home");
  const stateDir2 = join(paseoHome2, "plugin-state", "paseo-factory");
  mkdirSync(paseoHome2, { recursive: true });
  writeFileSync(
    join(paseoHome2, "config.json"),
    JSON.stringify({
      plugins: {
        "paseo-factory": {
          source: "directory",
          path: join(repoRoot, "plugin"),
          enabled: true,
        },
      },
    }),
  );
  const injectSessionEnvCjs = cjsMod.exports.injectSessionEnv as typeof injectSessionEnv;
  const opened = injectSessionEnvCjs(
    { agentId: "sup-cjs-1", cwd: repoDir, provider: "factory-supervisor", env: {} },
    stateDir2,
    join(dir2, "user-home"),
  );
  assert.ok(opened);
  assert.equal(existsSync(join(stateDir2, "bin", "bridge.mjs")), true, "injectSessionEnv in CJS mode materializes bridge.mjs on disk");
});

test("resolveOrBootstrapProject / ensureGitRepository: initializes Git and creates an initial empty commit on non-Git or unborn directories while refusing unsafe or missing paths (v0.0.35, ADR 0024)", (t) => {
  const dir = makeTempDir("bootstrap-git-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "user-home");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(userHome, { recursive: true });

  // 1. Plain existing directory without .git -> initializes git + initial empty commit
  const plainDir = join(dir, "greenfield-app");
  mkdirSync(plainDir, { recursive: true });
  assert.equal(resolveProject(plainDir).ok, false, "plain directory is not yet a git repository");

  const bootstrapped = resolveOrBootstrapProject(plainDir, { stateDir, userHome });
  assert.equal(bootstrapped.ok, true, "greenfield directory is bootstrapped into a Git repository");
  if (bootstrapped.ok) {
    assert.equal(bootstrapped.bootstrapped, true);
    assert.match(bootstrapped.slug, /^greenfield-app-[0-9a-f]{6}$/);
    const headSha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: plainDir, encoding: "utf8" }).trim();
    assert.match(headSha, /^[0-9a-f]{40}$/, "HEAD resolves to an initial commit so per-Task worktrees work immediately");
    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: plainDir, encoding: "utf8" }).trim();
    assert.equal(subject, "chore: initialize repository");
  }

  // Subsequent call on already-initialized repo returns bootstrapped: false without adding commits
  const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: plainDir, encoding: "utf8" }).trim();
  const second = ensureGitRepository(plainDir, { stateDir, userHome });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.bootstrapped, false);
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: plainDir, encoding: "utf8" }).trim();
    assert.equal(headAfter, headBefore, "existing HEAD commit is preserved untouched");
  }

  // 2. Unborn git repository (git init ran, but 0 commits so HEAD does not exist) -> creates initial empty commit
  const unbornDir = join(dir, "unborn-app");
  mkdirSync(unbornDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: unbornDir });
  const unbornRes = resolveOrBootstrapProject(unbornDir, { stateDir, userHome });
  assert.equal(unbornRes.ok, true);
  if (unbornRes.ok) {
    assert.equal(unbornRes.bootstrapped, true);
    const headSha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: unbornDir, encoding: "utf8" }).trim();
    assert.match(headSha, /^[0-9a-f]{40}$/);
  }

  // 3. Safety guards: refuses non-existent directory, '/', os.homedir(), userHome, and paths inside stateDir
  const missingRes = resolveOrBootstrapProject(join(dir, "does-not-exist"), { stateDir, userHome });
  assert.equal(missingRes.ok, false);
  if (!missingRes.ok) assert.equal(missingRes.code, "missing-directory");

  const rootRes = resolveOrBootstrapProject("/", { stateDir, userHome });
  assert.equal(rootRes.ok, false);
  if (!rootRes.ok) assert.equal(rootRes.code, "unsafe-directory");

  const osHomeRes = resolveOrBootstrapProject(homedir(), { stateDir, userHome });
  assert.equal(osHomeRes.ok, false);
  if (!osHomeRes.ok) assert.equal(osHomeRes.code, "unsafe-directory");

  const userHomeRes = resolveOrBootstrapProject(userHome, { stateDir, userHome });
  assert.equal(userHomeRes.ok, false);
  if (!userHomeRes.ok) assert.equal(userHomeRes.code, "unsafe-directory");

  const stateSubdir = join(stateDir, "projects", "foo");
  mkdirSync(stateSubdir, { recursive: true });
  const stateRes = resolveOrBootstrapProject(stateSubdir, { stateDir, userHome });
  assert.equal(stateRes.ok, false);
  if (!stateRes.ok) assert.equal(stateRes.code, "unsafe-directory");

  const paseoHome = join(userHome, ".paseo-factory");
  const paseoSubdir = join(paseoHome, "projects");
  mkdirSync(paseoSubdir, { recursive: true });
  const paseoHomeRes = resolveOrBootstrapProject(paseoHome, { stateDir, paseoHome });
  assert.equal(paseoHomeRes.ok, false, "refuses paseoHome directory itself");
  if (!paseoHomeRes.ok) assert.equal(paseoHomeRes.code, "unsafe-directory");
  const paseoSubRes = resolveOrBootstrapProject(paseoSubdir, { stateDir, paseoHome });
  assert.equal(paseoSubRes.ok, false, "refuses subdirectories inside paseoHome");
  if (!paseoSubRes.ok) assert.equal(paseoSubRes.code, "unsafe-directory");
});

test("injectRoleOnCreate and injectSessionEnv: starting Supervisor (Factory) or Lead (Factory) in a greenfield non-Git folder bootstraps Git, injects role contract & MCP, and registers the Project (v0.0.35, ADR 0024)", (t) => {
  const dir = makeTempDir("roles-greenfield-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "user-home");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(userHome, { recursive: true });

  // 1. Create a brand-new folder without .git and invoke injectRoleOnCreate for factory-supervisor
  const greenfieldSupDir = join(dir, "new-workspace-sup");
  mkdirSync(greenfieldSupDir, { recursive: true });
  assert.equal(existsSync(join(greenfieldSupDir, ".git")), false);

  const supInjected = injectRoleOnCreate<AgentCreateRequest>(
    {
      config: {
        provider: "factory-supervisor",
        cwd: greenfieldSupDir,
        title: "Build a todo app",
      },
    },
    stateDir,
    userHome,
  );
  assert.ok(supInjected !== undefined, "injectRoleOnCreate succeeds on a greenfield non-Git folder for factory-supervisor");
  assert.equal(existsSync(join(greenfieldSupDir, ".git")), true, ".git was automatically initialized");
  const headSha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: greenfieldSupDir, encoding: "utf8" }).trim();
  assert.match(headSha, /^[0-9a-f]{40}$/, "initial empty commit was created so HEAD resolves");
  assert.equal(supInjected.config.title, SEAT_TITLES.supervisor);
  assert.match(supInjected.config.systemPrompt ?? "", /Supervisor seat of the paseo-factory/);
  assert.ok((supInjected.config.mcpServers as Record<string, unknown>)?.paseo_factory !== undefined, "paseo_factory MCP server injected");
  const slug = supInjected.env?.PASEO_FACTORY_PROJECT ?? "";
  assert.match(slug, /^new-workspace-sup-[0-9a-f]{6}$/);
  const reg = readProjectRegistration(stateDir, slug);
  assert.ok(reg !== undefined, "project registration written to <stateDir>/projects/<slug>/project.json");
  const resolvedSup = resolveProject(greenfieldSupDir);
  assert.equal(reg.root, resolvedSup.ok ? resolvedSup.root : "");
  assert.equal(reg.name, "new-workspace-sup", "ensureProjectRegistered persists name in project.json");
  assert.equal(reg.commonDir, resolvedSup.ok ? resolvedSup.gitCommonDir : "", "ensureProjectRegistered persists commonDir in project.json");

  // 2. Also verify factory-lead on a greenfield non-Git folder via injectSessionEnv directly
  const greenfieldLeadDir = join(dir, "new-workspace-lead");
  mkdirSync(greenfieldLeadDir, { recursive: true });
  const leadEnv: Record<string, string> = {};
  const leadOpened = injectSessionEnv(
    {
      agentId: "lead-green-1",
      cwd: greenfieldLeadDir,
      provider: "factory-lead",
      env: leadEnv,
      workspaceId: "wks_lead_green",
    },
    stateDir,
    userHome,
  );
  assert.ok(leadOpened !== undefined, "injectSessionEnv succeeds on a greenfield non-Git folder for factory-lead");
  const leadSlug = leadOpened.env.PASEO_FACTORY_PROJECT ?? "";
  assert.match(leadSlug, /^new-workspace-lead-[0-9a-f]{6}$/);
  assert.equal(readProjectRegistration(stateDir, leadSlug)?.lead, "lead-green-1");
  assert.equal(readProjectRegistration(stateDir, leadSlug)?.workspaceId, "wks_lead_green");

  // 3. Refuses to bootstrap userHome or '/' when starting a seat there
  const refusedHome = injectRoleOnCreate(
    {
      config: {
        provider: "factory-supervisor",
        cwd: userHome,
        title: "Accidental home launch",
      },
    },
    stateDir,
    userHome,
  );
  assert.equal(refusedHome, undefined, "refuses to initialize Git in userHome");
  assert.equal(existsSync(join(userHome, ".git")), false);
});




test("role surfaces teach bounded serial waves, closure, and structured challenges (ADR 0029)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const root = makeGitRepo(dir);
  const bootstrap = (seat: "supervisor" | "lead") => renderSeatBootstrapPrompt({
    seat, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project: { root, slug: "repo" },
  });
  for (const surface of [renderRoleContract("supervisor"), renderRoleAppendSystem("supervisor"), bootstrap("supervisor")]) {
    assert.match(surface, /Outcome & Architecture Boundary/);
    assert.match(surface, /Owner.*explicitly requested/);
    assert.match(surface, /single-file.*index.html/);
  }
  for (const surface of [renderRoleContract("lead"), renderRoleAppendSystem("lead"), bootstrap("lead"),
    buildSeatKickoffPacket({ role: "lead", projectSlug: "repo", projectRoot: root, ledgerEvents: [] })]) {
    assert.doesNotMatch(surface, /Fresh-eyes|wait for CLEAR|CONCERN-free/);
    for (const law of [/Serial Waves by Default/, /~120K/, /single-task.*focused bugfix/i,
      /Never pass.*multi-subsystem.*single monolithic Task/, /single.file.*index.html/,
      /current wave only/, /up to 3.*genuinely disjoint/, /shared foundation/,
      /Bounded Outcome/, /Contract Boundary & Regression Invariants/,
      /Excluded \/ Deferred to Later Waves/, /Verification.*exact.*Gate/,
      /git show --stat/, /git diff/, /lead_merge/, /final wave.*before.*lead_report_to_supervisor/,
      /next wave.*same turn/, /Never accept.*Needs-human/, /two-party separation of judgment/i, /re-contract.*lead_set_contract/,
      /REOPEN_REQUEST/, /foundation.*dependency.*lifecycle.*API.*ownership.*verification/,
      /DEPENDENCY_REQUEST/, /BLOCKED/]) assert.match(surface, law);
  }
  for (const surface of [renderRoleContract("agent"), renderRoleAppendSystem("agent")]) {
    for (const law of [/Excluded \/ Deferred to Later Waves/, /third fix attempt.*same symptom/,
      /stop local patching.*underlying mechanism/, /commit any independent completed work/,
      /REOPEN_REQUEST/, /foundation.*dependency.*lifecycle.*API.*ownership.*verification/,
      /DEPENDENCY_REQUEST/, /BLOCKED/, /agent_escalate_blocker/, /current commit SHA/]) assert.match(surface, law);
  }
});

test("injectSessionEnv materializes an empty directory stub when resuming an archived Peer whose Task worktree was removed after Accept so PiRpcAgentClient does not fail with spawn pi ENOENT (ADR 0031)", (t) => {
  const dir = makeTempDir("roles-archived-worktree-resume-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "user-home");
  const repoDir = makeGitRepo(dir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok);
  const slug = resolved.ok ? resolved.slug : "";

  const deletedWorktree = join(stateDir, "projects", slug, "worktrees", "T-01");
  assert.equal(existsSync(deletedWorktree), false);

  const resumed = injectSessionEnv(
    {
      agentId: "archived-peer-t01",
      cwd: deletedWorktree,
      provider: "pi",
      reason: "resume",
      purpose: "history",
      env: {} as Record<string, string>,
    },
    stateDir,
    userHome,
  );
  assert.ok(resumed !== undefined);
  assert.equal(resumed.env.PASEO_FACTORY_SEAT, "agent");
  assert.equal(
    existsSync(deletedWorktree),
    true,
    "injectSessionEnv creates an empty directory stub at the removed Task worktree path on resume/history so spawn('pi', ..., { cwd }) succeeds",
  );
});
