import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildRoleKickoffPrompt, LEAD_WAVE_LAWS, renderRoleAppendSystem, renderRoleContract, renderSeatBootstrapPrompt, SUPERVISOR_OUTCOME_BOUNDARY } from "../src/roles-contract.ts";
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
    assert.match(surface, /factory-claim --task (T-01|<task>) --outcome <complete\|partial\|blocked\|reopen> --scope <text> --verification <text> --unknowns <text>/);
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
        skill: { "*": "deny", grilling: "allow", "domain-modeling": "allow", "grill-with-docs": "allow", research: "allow", factory: "allow" },
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

  // v0.0.84: the mirrored process-kill gate fires only in command position,
  // with its own reason naming the Layer-3 backstop — never the write-fence message.
  for (const killCmd of ["pkill -f /Users/owner/.paseo/plugin-state/paseo-factory/projects/demo/worktrees/T-04/bridge.mjs", "bash -c 'pkill -f /Users/owner/.paseo/plugin-state/paseo-factory/projects/demo/worktrees/T-04; pkill paseo'", "/usr/bin/pkill -f paseo", "bash -c 'pkill -f paseo'", "timeout 5 killall Paseo Helper"]) {
    const denyKill = JSON.parse(
      execFileSync(process.execPath, [hookBin], {
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: killCmd } },
          workspacePaths: [repoDir],
        }),
        env: supEnv,
        encoding: "utf8",
      }),
    );
    assert.equal(denyKill.decision, "deny", `${killCmd} must be denied`);
    assert.match(String(denyKill.reason), /process-kill/);
    assert.doesNotMatch(String(denyKill.reason), /Seat write fence/);
  }
  for (const proseCmd of [
    "pkill -f /Users/owner/.paseo/plugin-state/paseo-factory/projects/demo/worktrees/T-04",
    "killall /Users/owner/.paseo/plugin-state/paseo-factory/projects/demo/worktrees/T-04/test-server",
    "echo 'Do not use killall/pkill' && ls /Users/andrewpham/.paseo/plugins/paseo-factory",
    "echo 'bash -c pkill' && ls /Users/andrewpham/.paseo/plugins/paseo-factory",
  ]) {
    const allowProseKill = JSON.parse(
      execFileSync(process.execPath, [hookBin], {
        input: JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: proseCmd } },
          workspacePaths: [repoDir],
        }),
        env: supEnv,
        encoding: "utf8",
      }),
    );
    assert.equal(allowProseKill.decision, "allow", `kill words in prose must not fire the process-kill gate: ${proseCmd}`);
  }

  // 3. Lead vs Supervisor git fence in agy-pre-tool-hook.mjs: Supervisor cannot commit/merge, Lead can commit whitelisted docs/memory and merge, but cannot commit product source
  const supDenyCommit = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({
        toolCall: { name: "run_command", args: { CommandLine: 'git add GLOSSARY.md && git commit -m "docs"' } },
        workspacePaths: [repoDir],
      }),
      env: supEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(supDenyCommit.decision, "deny", "Supervisor denied git commit in agy-pre-tool-hook.mjs");

  const leadEnv = {
    PATH: process.env.PATH,
    PASEO_FACTORY_SEAT: "lead",
    PASEO_FACTORY_STATE_DIR: stateDir,
    PASEO_FACTORY_PROJECT_ROOT: repoDir,
  };
  const leadAllowDocsCommitAndMerge = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({
        toolCall: {
          name: "run_command",
          args: {
            CommandLine: 'git add GLOSSARY.md docs/ && git commit -m "docs: commit glossary and ADRs" && git merge --ff-only factory/pm-prd',
          },
        },
        workspacePaths: [repoDir],
      }),
      env: leadEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(leadAllowDocsCommitAndMerge.decision, "allow", "Lead allowed to commit whitelisted docs/memory and merge task branch");

  const leadDenyProductCommit = JSON.parse(
    execFileSync(process.execPath, [hookBin], {
      input: JSON.stringify({
        toolCall: {
          name: "run_command",
          args: { CommandLine: 'git add src/index.ts && git commit -m "feat: rogue lead edit"' },
        },
        workspacePaths: [repoDir],
      }),
      env: leadEnv,
      encoding: "utf8",
    }),
  );
  assert.equal(leadDenyProductCommit.decision, "deny", "Lead denied staging/committing product source in agy-pre-tool-hook.mjs");
  assert.match(String(leadDenyProductCommit.reason), /lead-git-fence/);
});

test("agy-pre-tool-hook.mjs fences read-only dispositions at Layer 1 (ADR 0053 §3, ticket 05): a scout Peer's write tools and shell file-writes deny; engineer and omitted stay allowed; reads always pass", (t) => {
  const dir = makeTempDir("agy-hook-readonly-");
  disposeDir(t, dir);
  const hookBin = resolve(import.meta.dirname, "../plugin/bin/agy-pre-tool-hook.mjs");
  const stateDir = join(dir, "state");
  const repoDir = join(dir, "repo");
  const worktree = join(stateDir, "projects", "repo-slug", "worktrees", "RO-1");
  mkdirSync(worktree, { recursive: true });

  // The Project's ledger carrying the Task's live Contract (disposition and
  // spawn-bound worktree) — the shape loadContractForTask resolves.
  const ledgerLine = (disposition: string | undefined) =>
    [
      { event: "contract_set", task: "RO-1", workspace: repoDir, gate: "true", artifact: "README.md", ...(disposition === undefined ? {} : { disposition }) },
      { event: "spawn_dispatched", task: "RO-1", provider: "pi", arity: 1, worktree },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
  const projectLedger = join(stateDir, "projects", "repo-slug", "ledger.jsonl");
  const runAgentHook = (payload: object, disposition: string | undefined) => {
    writeFileSync(projectLedger, `${ledgerLine(disposition)}\n`);
    return JSON.parse(
      execFileSync(process.execPath, [hookBin], {
        input: JSON.stringify(payload),
        env: {
          PATH: process.env.PATH,
          PASEO_FACTORY_SEAT: "agent",
          PASEO_FACTORY_STATE_DIR: stateDir,
          PASEO_FACTORY_PROJECT: "repo-slug",
          PASEO_FACTORY_TASK: "RO-1",
        },
        encoding: "utf8",
      }),
    );
  };

  // A read-only Peer: write tools deny under the Task worktree — relative and
  // absolute — and shell file-writes deny too, all naming the law.
  for (const disposition of ["scout", "architect", "reviewer"] as const) {
    const writeTool = runAgentHook({ tool_name: "write_file", tool_input: { Path: join(worktree, "src", "index.ts") }, cwd: worktree }, disposition);
    assert.equal(writeTool.decision, "deny", `${disposition} — write_file into the Task worktree denies at Layer 1`);
    assert.match(String(writeTool.reason), /read-only-disposition-fence/);
    assert.match(String(writeTool.reason), new RegExp(disposition));

    const shellWrite = runAgentHook({ toolCall: { name: "run_command", args: { CommandLine: "echo findings > src/notes.txt" } }, workspacePaths: [worktree] }, disposition);
    assert.equal(shellWrite.decision, "deny", `${disposition} — a shell file-write into the Task worktree denies at Layer 1`);
    assert.match(String(shellWrite.reason), /read-only-disposition-fence/);

    const read = runAgentHook({ tool_name: "read_file", tool_input: { Path: join(worktree, "src", "index.ts") }, cwd: worktree }, disposition);
    assert.equal(read.decision, "allow", `${disposition} — read_file passes`);
    const shellRead = runAgentHook({ toolCall: { name: "run_command", args: { CommandLine: "git diff" } }, workspacePaths: [worktree] }, disposition);
    assert.equal(shellRead.decision, "allow", `${disposition} — a read-only shell command passes`);
  }

  // The writers: engineer (and an omitted disposition) keep their Layer-1
  // allowances — source writes pass; only the standing memory fence remains.
  for (const disposition of ["engineer" as const, undefined]) {
    const sourceWrite = runAgentHook({ tool_name: "write_file", tool_input: { Path: join(worktree, "src", "index.ts") }, cwd: worktree }, disposition);
    assert.equal(sourceWrite.decision, "allow", `${disposition ?? "omitted"} — an engineer's source write passes at Layer 1`);
    const memoryWrite = runAgentHook({ tool_name: "write_file", tool_input: { Path: join(worktree, "AGENTS.md") }, cwd: worktree }, disposition);
    assert.equal(memoryWrite.decision, "deny", `${disposition ?? "omitted"} — the standing memory fence still denies`);
    assert.match(String(memoryWrite.reason), /memory-write-fenced/);
  }
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
    skill: { "*": "deny", grilling: "allow", "domain-modeling": "allow", "grill-with-docs": "allow", research: "allow", factory: "allow" },
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

test("legacy zcode/* lanes in lanes.json migrate to pi/zcode/* so seats and Peers fence onto the isolated Pi harness (ADR 0055)", (t) => {
  const dir = makeTempDir("roles-zcode-migrate-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  mkdirSync(userHome, { recursive: true });
  const repoDir = makeGitRepo(dir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok, "the fixture repo resolves");
  const slug = resolved.ok ? resolved.slug : "";
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "lanes.json"),
    `${JSON.stringify({ supervisor: "zcode/GLM-5.3:high", lead: "zcode/GLM-5.3:high", worker: "zcode/GLM-5.3:high" }, null, 2)}\n`,
  );

  // The family resolution: a factory provider under a migrated zcode lane fences as pi.
  assert.equal(resolveEffectiveProviderFamily("factory-supervisor", "supervisor", stateDir, slug), "pi");
  assert.equal(resolveEffectiveProviderFamily("factory-lead", "lead", stateDir, slug), "pi");
  assert.equal(resolveEffectiveProviderFamily("factory-peer", "agent", stateDir, slug), "pi");

  for (const role of ["supervisor", "lead"] as const) {
    const res = injectRoleOnCreate<AgentCreateRequest>(
      { config: { provider: `factory-${role}`, cwd: repoDir, title: "Ship the game" }, env: {} },
      stateDir,
      userHome,
    );
    assert.ok(res !== undefined, `the ${role} create injects the role`);
    assert.ok((res.config.mcpServers as Record<string, unknown>).paseo_factory !== undefined, `${role} keeps the paseo_factory MCP`);
    assert.equal(res.env?.PI_CODING_AGENT_DIR, join(stateDir, "pi-agent", role), `${role} env names its isolated Pi harness home`);
    assert.equal("ZCODE_STORAGE_DIR" in (res.env ?? {}), false, `${role} env no longer carries retired ZCODE_STORAGE_DIR`);
  }

  const worktreeDir = join(stateDir, "projects", slug, "worktrees", "T-08");
  mkdirSync(worktreeDir, { recursive: true });
  const peer = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "factory-peer", cwd: worktreeDir, title: "T-08" }, env: {} },
    stateDir,
    userHome,
  );
  assert.ok(peer !== undefined, "the managed-worktree branch fires for the peer create");
  assert.equal(peer.env?.PI_CODING_AGENT_DIR, join(stateDir, "pi-agent", "agent"));
  assert.equal(existsSync(join(worktreeDir, ".zcode", "config.json")), false, "no .zcode/config.json is written in the Task worktree");
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

test("injectSessionEnv recognizes a rewritten supervisor/lead session on interactive reopen via request.labels or request.title (v0.0.91, ADR 0026)", (t) => {
  const dir = makeTempDir("roles-session-title-labels-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  const repoDir = makeGitRepo(dir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok);
  const slug = resolved.ok ? resolved.slug : "";

  // ADR 0026 rewrote the seat's config.provider onto the base runtime provider
  // at create time; on a cold interactive reopen the env arrives empty. The
  // Paseo 0.15.0 `labels` field is the deterministic seat identity.
  const labeled = injectSessionEnv(
    {
      agentId: "rewritten-sup-1",
      cwd: repoDir,
      provider: "claude",
      reason: "resume",
      purpose: "interactive",
      title: "Supervisor",
      labels: { seat: "supervisor", project: slug },
      env: {} as Record<string, string>,
      workspaceId: "ws-sup-1",
    },
    stateDir,
    userHome,
  );
  assert.ok(labeled !== undefined, "a labels-recognized supervisor session receives its factory env");
  assert.equal(labeled.env.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(labeled.env.PASEO_FACTORY_PROJECT, slug);
  assert.equal(labeled.env.PASEO_FACTORY_PROJECT_ROOT, resolved.ok ? resolved.root : undefined);
  const labeledRegistration = readProjectRegistration(stateDir, slug);
  assert.equal(labeledRegistration?.supervisor, "rewritten-sup-1", "the interactive reopen binds the supervisor agentId into project.json");
  assert.equal(labeledRegistration?.workspaceId, "ws-sup-1", "the interactive reopen persists the supervisor workspaceId");

  // A Lead recognized only by its stamped seat title on a rewritten provider.
  const titledLead = injectSessionEnv(
    {
      agentId: "rewritten-lead-1",
      cwd: repoDir,
      provider: "opencode",
      reason: "resume",
      purpose: "interactive",
      title: "Lead",
      env: {} as Record<string, string>,
      workspaceId: "ws-lead-1",
    },
    stateDir,
    userHome,
  );
  assert.ok(titledLead !== undefined, "a title-recognized lead session receives its factory env");
  assert.equal(titledLead.env.PASEO_FACTORY_SEAT, "lead");
  assert.equal(titledLead.env.PASEO_FACTORY_PROJECT, slug);
  const leadRegistration = readProjectRegistration(stateDir, slug);
  assert.equal(leadRegistration?.lead, "rewritten-lead-1", "the title-recognized reopen binds the lead agentId into project.json");
  assert.equal(leadRegistration?.workspaceId, "ws-lead-1", "the lead reopen persists the workspaceId");

  // A second supervisor recognized by title never displaces the bound seat.
  const secondSupervisor = injectSessionEnv(
    {
      agentId: "rewritten-sup-2",
      cwd: repoDir,
      provider: "opencode",
      reason: "refresh",
      purpose: "interactive",
      title: "Supervisor",
      env: {} as Record<string, string>,
    },
    stateDir,
    userHome,
  );
  assert.ok(secondSupervisor !== undefined, "the second supervisor still carries its env");
  assert.equal(secondSupervisor.env.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(readProjectRegistration(stateDir, slug)?.supervisor, "rewritten-sup-1", "an occupied supervisor seat is never displaced by a title-recognized reopen");
});

test("injectSessionEnv never writes supervisor, lead, or workspaceId into project.json on a purpose:history open (v0.0.91)", (t) => {
  const dir = makeTempDir("roles-session-history-fence-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  const repoDir = makeGitRepo(dir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok);
  const slug = resolved.ok ? resolved.slug : "";

  // Reading an archived supervisor conversation — even one that still carries
  // its seat labels and title — re-carries the seat env but never creates or
  // hijacks the Project's project.json registration.
  const labeledHistory = injectSessionEnv(
    {
      agentId: "archived-sup-1",
      cwd: repoDir,
      provider: "claude",
      reason: "import",
      purpose: "history",
      title: "Supervisor",
      labels: { seat: "supervisor", project: slug },
      env: {} as Record<string, string>,
      workspaceId: "ws-archived-1",
    },
    stateDir,
    userHome,
  );
  assert.ok(labeledHistory !== undefined, "a history open still re-carries the seat's factory env");
  assert.equal(labeledHistory.env.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(readProjectRegistration(stateDir, slug), undefined, "a history open with seat labels never creates project.json");

  // Same fence for a title-only history open.
  const titledHistory = injectSessionEnv(
    {
      agentId: "archived-lead-1",
      cwd: repoDir,
      provider: "opencode",
      reason: "import",
      purpose: "history",
      title: "Lead",
      env: {} as Record<string, string>,
      workspaceId: "ws-archived-2",
    },
    stateDir,
    userHome,
  );
  assert.ok(titledHistory !== undefined, "a title-recognized history open still re-carries the seat env");
  assert.equal(titledHistory.env.PASEO_FACTORY_SEAT, "lead");
  assert.equal(readProjectRegistration(stateDir, slug), undefined, "a history open with a seat title never creates project.json");

  // A history open carrying a valid Correlation token still associates the
  // token with the reading agentId (the env must carry it), but never binds
  // the seat into an unoccupied project registration.
  const issued = new CorrelationRegistry(stateDir).issue({ role: "supervisor", projectSlug: slug, projectRoot: repoDir });
  writeProjectRegistration(stateDir, slug, { root: repoDir });
  const correlatedHistory = injectSessionEnv(
    {
      agentId: "archived-sup-2",
      cwd: repoDir,
      provider: "claude",
      reason: "refresh",
      purpose: "history",
      env: { PASEO_FACTORY_CORRELATION: issued.correlationId } as Record<string, string>,
      workspaceId: "ws-archived-3",
    },
    stateDir,
    userHome,
  );
  assert.ok(correlatedHistory !== undefined, "a correlated history open still re-carries the seat env");
  assert.equal(correlatedHistory.env.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(correlatedHistory.env.PASEO_FACTORY_CORRELATION, issued.correlationId);
  assert.equal(new CorrelationRegistry(stateDir).resolve("archived-sup-2")?.correlationId, issued.correlationId, "the history open still associates the Correlation token with the reading agentId");
  const fenced = readProjectRegistration(stateDir, slug);
  assert.equal(fenced?.supervisor, undefined, "a history open never binds supervisor into project.json");
  assert.equal(fenced?.lead, undefined, "a history open never binds lead into project.json");
  assert.equal(fenced?.workspaceId, undefined, "a history open never persists a workspaceId into project.json");
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




test("role surfaces enforce rolling waves, modular isolated tests, bounded checks, and context-ceiling recovery", t => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const root = makeGitRepo(dir);
  for (const seat of ["lead", "supervisor"] as const) {
    const surfaces = [renderRoleContract(seat), renderSeatContract(seat, { root, slug: "repo" }), ROLE_PROMPTS[seat],
      renderSeatBootstrapPrompt({ seat, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath, path: "/usr/bin", lane: "pi/model", project: { root, slug: "repo" } }),
      renderSeatBootstrap({ seat, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath, path: "/usr/bin", lane: "pi/model", project: { root, slug: "repo" } }),
      buildSeatKickoffPacket({ role: seat, projectSlug: "repo", projectRoot: root, ledgerEvents: [] })];
    for (const surface of surfaces) {
      assert.match(surface, /monolithic test file/);
      assert.match(surface, /per.slice test files/);
      assert.doesNotMatch(surface, /Godot|Unity|Phaser|playable Hero|Rain of Fire/);
      if (seat === "lead") {
        assert.match(surface, /rolling-wave outline/);
        assert.match(surface, /Stable Checkpoint.*repository growth.*split/);
        assert.match(surface, /T-04a.*T-04b/);
        assert.match(surface, /isolated fixture/);
        assert.match(surface, /timeout/);
        assert.match(surface, /BLOCKED \(context-ceiling\)/);
        assert.match(surface, /peer-handoff-<task>.md/);
      }
    }
  }
  for (const surface of [renderRoleContract("agent"), renderAgentContract("T-04", "repo"), ROLE_PROMPTS.agent]) {
    assert.match(surface, /per.slice test files/);
    assert.match(surface, /isolated fixture/);
    assert.match(surface, /explicit timeout/);
    assert.match(surface, /full cumulative Gate.*before.*factory-claim/);
    assert.doesNotMatch(surface, /Godot|Unity|Phaser/);
  }
});

test("Lead role surfaces require vertical user journeys after at most two setup waves (ADR 0044)", () => {
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.match(surface, /at most 1–2 foundational setup waves/);
    assert.match(surface, /T-01.*app shell.*harness.*design tokens.*T-02.*core schema.*repository seam/);
    assert.match(surface, /T-03\+.*vertical user-facing journey slice.*interactive screen\/UI.*state\/data wiring.*journey test/);
    assert.match(surface, /Never.*horizontal chains of backend-only micro-waves.*screens.*placeholders/);
    assert.match(surface, /split.*distinct user journeys or screens.*rather than horizontal data-plumbing layers/);
  }
});

test("Lead briefs preserve implementation freedom with focused journey verification (ADR 0044)", () => {
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", { root: "/workspace/repo", slug: "repo" }),
    ROLE_PROMPTS.lead, buildSeatKickoffPacket({ role: "lead", projectSlug: "repo", projectRoot: "/workspace/repo", ledgerEvents: [] })]) {
    assert.match(surface, /4-Part Brief.*concise/);
    assert.match(surface, /Bounded Outcome.*Contract Boundary & Regression Invariants.*Excluded \/ Deferred to Later Waves.*Verification.*exact Gate command/);
    assert.match(surface, /Do not pre-solve internal helper function signatures/);
    assert.match(surface, /do not mandate 4–6 separate unit-test files per task/);
    assert.match(surface, /1–2 focused slice\/journey test files suffice unless the repository's existing layout requires otherwise/);
  }
});

test("buildRoleKickoffPrompt embeds the Open Design Linked Specification exactly once per role (v0.0.97, ADR 0047 Decision 1)", (t) => {
  const dir = makeTempDir("roles-kickoff-dedup-");
  disposeDir(t, dir);
  const root = join(dir, "repo");
  mkdirSync(join(root, "design"), { recursive: true });
  writeFileSync(join(root, "design/open-design-link.json"), JSON.stringify({ projectId: "owner", projectName: "Checkout flow", sourceUpdatedAt: 1, syncedAt: "2026-11-02", screenCount: 4, files: [], digest: "abc" }));
  const project = { root, slug: "repo" };
  const occurrences = (surface: string) => surface.split("Open Design Linked Specification").length - 1;

  // The regression: renderRoleContract("lead") already embeds the spec, so the
  // Lead kickoff must not prepend a second copy into config.systemPrompt.
  const leadKickoff = buildRoleKickoffPrompt("lead", { project });
  assert.equal(occurrences(leadKickoff), 1, "the Lead kickoff embeds the Open Design Linked Specification exactly once");
  assert.match(leadKickoff, /Checkout flow/, "the single copy is the project's linked design catalog");

  // Every other role keeps today's behavior: the outer prepend is their only copy.
  for (const role of ["supervisor", "agent"] as const) {
    assert.equal(occurrences(buildRoleKickoffPrompt(role, { project })), 1, `the ${role} kickoff still embeds the spec exactly once`);
  }
});

test("Lead wave laws cap 4-Part Briefs at 2,500 chars and make domain skills Peer-owned (v0.0.97, ADR 0047 Decisions 3–4)", () => {
  const briefLaw = LEAD_WAVE_LAWS.find((law) => law.startsWith("4-Part Brief"))!;
  assert.ok(briefLaw !== undefined, "the 4-Part Brief law exists");
  assert.match(briefLaw, /Keep every Contract\.description concise — capped at <= 2,500 chars —/);
  assert.match(briefLaw, /Do not read deep implementation files before contracting to pre-solve internal helper function or prop names/);
  assert.match(briefLaw, /Peer-Owned Domain Skills: never read \(`cat`\) implementation or framework SKILL\.md files \(expo-\*, eas-\*, firebase-\*, etc\.\) into your own context window/);
  assert.match(briefLaw, /domain and implementation skills belong to the working Agent \(Peer\), which discovers them natively via <available_skills>/);

  // The contract states the Peer-Owned rule as its own law line, and every Lead
  // surface carries the cap and the SKILL.md prohibition.
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.match(surface, /Peer-Owned Domain Skills: [Nn]ever read \(`cat`\) implementation or framework SKILL\.md files/);
    assert.match(surface, /capped at <= 2,500 chars/);
    assert.match(surface, /discovers them natively via <available_skills>/);
  }
});

test("Lead closure review reads bounded per-file diffs without REPL middle-truncation batches (v0.0.97, ADR 0047 Decision 4)", () => {
  const closureLaw = LEAD_WAVE_LAWS.find((law) => law.startsWith("Closure & Integration Loop"))!;
  assert.ok(closureLaw !== undefined, "the Closure & Integration Loop law exists");
  // Report and stat come first, then targeted per-file diffs in bounded chunks.
  assert.match(closureLaw, /read `<projectStateDir>\/report-<task>-<n>\.md` and `git show --stat "<sha>"` first/);
  assert.match(closureLaw, /`git diff "<sha>\^" "<sha>" -- <file>`/);
  assert.match(closureLaw, /bounded chunks \(<= 6,000 tokens per call\)/);
  assert.match(closureLaw, /never wrapping multi-file `git diff` or `cat` outputs inside `JSON\.stringify` \(`text\(\{i,\.\.\.r\}\)`\) in a single REPL `exec` call/);

  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.match(surface, /<= 6,000 tokens per call/);
    assert.match(surface, /JSON\.stringify/);
    assert.match(surface, /report-<task>-<n>\.md/);
  }
});

test("the primary lead_set_contract example drops skills curation while the skills field stays optional (v0.0.97, ADR 0047 Decision 3)", () => {
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input)]) {
    const example = surface.match(/paseo-factory_lead_set_contract\(\{[^\n]+/)![0];
    assert.ok(!example.includes("skills"), `the primary example carries no skills parameter: ${example}`);
    assert.doesNotMatch(surface, /skills: \["tdd"\]/, "no surface teaches Lead to curate Contract.skills via the example");
    // Backward compatibility is binding: the optional --skills CLI flag remains.
    assert.match(surface, /\[--skills <s1,s2>\]/);
  }
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead]) {
    assert.match(surface, /set each Contract \(gate, description, optional artifact, skills\)/, "the Contract schema still names skills as an optional field");
  }
});

test("Lead review accepts genuine contracted GREEN proof without inventing post-Gate probes (ADR 0044)", () => {
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.match(surface, /Gate.*GREEN.*exit 0.*Watch.*no concern.*< 0\.5/);
    assert.match(surface, /git show --stat "<sha>".*git diff "<sha>\^" "<sha>".*strictly against the 4-Part Brief/);
    assert.match(surface, /If the claimed behavior disappeared, would the Peer's test fail\?/);
    assert.match(surface, /contracted outcome.*no out-of-scope regressions or fake tests.*proof is genuine.*must accept and land immediately/);
    assert.match(surface, /Never write or execute ad-hoc out-of-band shell\/node\/python scripts.*uncontracted edge cases after a GREEN Gate/);
    for (const example of ["node -e", "node <<'JS'", "npx tsx -e", "python3 -c"]) assert.ok(surface.includes(example));
    assert.match(surface, /polish.*newly discovered edge case outside.*Contract.*downstream.*after landing.*Stable Checkpoint/);
  }
});

test("Lead wave laws require a bounded Project notebook at <projectStateDir>/notebook.md outside <project-root> (v0.1.0, ADR 0048 Decision 1)", () => {
  const notebookLaw = LEAD_WAVE_LAWS.find((law) => law.includes("<projectStateDir>/notebook.md"))!;
  assert.ok(notebookLaw !== undefined, "the Project notebook law exists");

  // The law itself carries the cap, both fixed section headers with their
  // subsections and table columns, and the audience-separation prohibition.
  assert.match(notebookLaw, /<= 80 lines \/ <= 4 KB/);
  assert.match(notebookLaw, /outside `<project-root>`/);
  assert.match(notebookLaw, /## 1\. Verification & Run Recipe/);
  assert.match(notebookLaw, /Worktree & Env Setup.*Fast Slice Check.*Full Cumulative Gate.*Process & Port Cleanup/);
  assert.match(notebookLaw, /## 2\. Recurrence Guard/);
  assert.match(notebookLaw, /\| ID \| Cause → Effect Mechanism \| Evidence \(Task \/ seq\) \| State \| Enforcement \|/);
  assert.match(notebookLaw, /never write.*Lead-only operational or orchestration recipes into `<project-root>\/AGENTS\.md` or `<project-root>\/CONTEXT\.md`/);

  // Every Lead surface (contract, seat contract, ROLE_PROMPTS, bootstraps,
  // Turn-1 kickoff packet) carries the notebook upkeep obligations.
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.match(surface, /<projectStateDir>\/notebook\.md/);
    assert.match(surface, /<= 80 lines \/ <= 4 KB/);
    assert.match(surface, /## 1\. Verification & Run Recipe/);
    assert.match(surface, /## 2\. Recurrence Guard/);
    assert.match(surface, /never write.*Lead-only operational or orchestration recipes into `<project-root>\/AGENTS\.md` or `<project-root>\/CONTEXT\.md`/);
  }
});

test("Lead wave laws condense the Project notebook / Recurrence Guard ceremonies into one compact operational principle — no state-machine prose, no tier hierarchy (ADR 0053 §5, amended by ADR 0052 Decision 2)", () => {
  const guardLaw = LEAD_WAVE_LAWS.find((law) => law.startsWith("Project Notebook & Recurrence Guard"))!;
  assert.ok(guardLaw !== undefined, "the condensed Project Notebook & Recurrence Guard law exists");

  // The compact principle keeps the load-bearing levers: evidence citations, the
  // recurrence threshold, the one-change cap, mechanical-first preference, and
  // the Owner Ratification path for prose edits.
  assert.match(guardLaw, /Task \(seq N\)/);
  assert.match(guardLaw, /no permanent rule for a one-off/);
  assert.match(guardLaw, />= 2 distinct seqs/);
  assert.match(guardLaw, /at most 1 highest-leverage hardening per Stable Checkpoint/);
  assert.match(guardLaw, /preferring mechanical structure first/);
  assert.match(guardLaw, /4-Line Ratification Card/);

  // The bureaucratic state machine and the 3-Tier hierarchy are gone — from the
  // law itself and from every Lead surface (contract, seat contract, ROLE_PROMPTS,
  // bootstraps, Turn-1 kickoff packet). The graduation state names ADR 0052
  // Decision 2 reintroduced (`State: verified`, `State: observed (1x)`) are the
  // exception — the dedicated notebook-graduation test below pins those.
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.doesNotMatch(surface, /observed → recurred → hardened → verified/);
    assert.doesNotMatch(surface, /State: hardened/);
    assert.doesNotMatch(surface, /Tier 1 \(Mechanical Structure\)/);
    assert.doesNotMatch(surface, /Tier 2 \(1-Line Repo Convention\)/);
    assert.doesNotMatch(surface, /Tier 3 \(No-Op Rule Deprecation\)/);
    assert.match(surface, /Task \(seq N\)/);
    assert.match(surface, /at most 1 highest-leverage hardening per Stable Checkpoint/);
  }
});

test("Lead wave laws rewrite the Project notebook for the plugin single writer — lead_update_notebook / factory notebook, never .scratch/notebook.md — with the seatworks 3-rule graduation and the Tier-2 quote cap (ADR 0052 Decisions 1–2, ticket 06)", () => {
  const guardLaw = LEAD_WAVE_LAWS.find((law) => law.startsWith("Project Notebook & Recurrence Guard"))!;
  assert.ok(guardLaw !== undefined, "the Project Notebook & Recurrence Guard law exists");

  // The single-writer law: the notebook is maintained through the plugin's
  // lead_update_notebook / factory notebook, never by writing a notebook file
  // inside <project-root> (the OS-sandboxed codex Lead failure mode).
  assert.match(guardLaw, /lead_update_notebook/);
  assert.match(guardLaw, /factory notebook/);
  assert.match(guardLaw, /never write `<project-root>\/\.scratch\/notebook\.md`/);

  // The row cap and the seatworks 3-rule graduation discipline.
  assert.match(guardLaw, /<= 12 active Recurrence Guard rows/);
  assert.match(guardLaw, /Fold rows that share one underlying `Cause → Effect` mechanism/);
  assert.match(guardLaw, /retire `State: verified` rows once their Tier-1 check or helper has held across 3 subsequent waves/);
  assert.match(guardLaw, /expire `State: observed \(1x\)` rows that have not recurred within 5 waves/);

  // The Tier-2 quote cap: prose conventions are a 2–3 wave bridge, then Tier-1.
  assert.match(guardLaw, /at most 2–3 waves/);
  assert.match(guardLaw, /encode it as Tier-1 mechanical structure/);

  // Every Lead surface carries the single writer, the row cap, and the graduation.
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.match(surface, /lead_update_notebook/);
    assert.match(surface, /\.scratch\/notebook\.md/);
    assert.match(surface, /<= 12 active Recurrence Guard rows/);
    assert.match(surface, /State: observed \(1x\)/);
    assert.match(surface, /State: verified/);
  }
});

test("Lead wave laws cap post-split verification tails at 1 combined journey wave and forbid standalone test-only negative-matrix sub-wave chains (ADR 0052 Decision 3, User Story 24)", () => {
  const boundedLaw = LEAD_WAVE_LAWS.find((law) => law.startsWith("Bounded Verification & Context-Ceiling Recovery"))!;
  assert.ok(boundedLaw !== undefined, "the Bounded Verification & Context-Ceiling Recovery law exists");

  // The verification tail after a context-ceiling split is ONE combined journey
  // wave — happy path and failure/retry recovery together, not a chain.
  assert.match(boundedLaw, /at most 1 combined journey wave/);
  assert.match(boundedLaw, /happy path.*failure\/retry recovery.*one concise suite/);
  // Standalone test-only negative-matrix sub-wave chains are explicitly forbidden.
  assert.match(boundedLaw, /standalone test-only negative-matrix sub-wave chains/);
  assert.match(boundedLaw, /individual error\/refusal branches with `src\/` frozen/);
  assert.match(boundedLaw, /refusal behavior of temporary stubs slated for replacement/);
  assert.match(boundedLaw, /are forbidden/);

  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.match(surface, /at most 1 combined journey wave/);
    assert.match(surface, /test-only negative-matrix sub-wave chains/);
  }
});

test("Lead wave laws make recurred context-ceiling on a >1,500-line central file a structural module/fixture extraction wave (ADR 0052 Decision 4)", () => {
  const boundedLaw = LEAD_WAVE_LAWS.find((law) => law.startsWith("Bounded Verification & Context-Ceiling Recovery"))!;
  assert.ok(boundedLaw !== undefined, "the Bounded Verification & Context-Ceiling Recovery law exists");

  // Two context-ceiling BLOCKEDs on Tasks touching the same central
  // orchestration / provider / test-fixture file over 1,500 lines mandate the
  // structural decomposition, not more micro-splitting around the monolith.
  assert.match(boundedLaw, /recurs \(>= 2 times\)/);
  assert.match(boundedLaw, /same central orchestration, provider, or test-fixture file/);
  assert.match(boundedLaw, /over 1,500 lines/);
  assert.match(boundedLaw, /mandatory Wave Hardening action is a bounded module\/fixture extraction wave/);
  assert.match(boundedLaw, /~200–400 line files/);
  assert.match(boundedLaw, /rather than further micro-splitting/);

  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.match(surface, /over 1,500 lines/);
    assert.match(surface, /module\/fixture extraction wave/);
    assert.match(surface, /~200–400 line files/);
  }
});

test("Lead closure reuses the shared cumulative Gate runner parameterized by the slice's test file and never re-contracts a GREEN wave for test polish (ADR 0052 Decision 5)", () => {
  const closureLaw = LEAD_WAVE_LAWS.find((law) => law.startsWith("Closure & Integration Loop"))!;
  assert.ok(closureLaw !== undefined, "the Closure & Integration Loop law exists");

  // Shared Gate runner parameterized by the current slice's test file — no
  // per-task scripts/verify-<task>.mjs minting.
  assert.match(closureLaw, /reuse the repository's shared cumulative Gate runner parameterized by the current slice's test file/);
  assert.match(closureLaw, /scripts\/verify-<task>\.mjs/);
  // Once GREEN + outcome + falsification hold, landing is immediate — test
  // polish alone never re-opens a GREEN wave; structural cleanup defers to
  // Wave Hardening.
  assert.match(closureLaw, /re-contracting that GREEN wave solely for test-file DRYness, helper deduplication, or redundant zero-call assertions is forbidden/);
  assert.match(closureLaw, /defer structural test cleanup to Wave Hardening on the next wave/);

  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.match(surface, /shared cumulative Gate runner parameterized by the current slice's test file/);
    assert.match(surface, /scripts\/verify-<task>\.mjs/);
    assert.match(surface, /test-file DRYness, helper deduplication, or redundant zero-call assertions is forbidden/);
  }
});

test("Lead wave laws reference the ADR 0054 surfaces — single worker lane with per-dispatch thinking by uncertainty, disposition-specific handoff evidence, and lead_close_task retirement (ADR 0054 Decisions 2/4/5, tickets 03/04/05)", () => {
  const briefLaw = LEAD_WAVE_LAWS.find((law) => law.startsWith("4-Part Brief"))!;
  assert.ok(briefLaw !== undefined, "the 4-Part Brief law exists");

  // Per-dispatch effort: the single Owner-configured worker lane carries all
  // four dispositions; thinking is selected by uncertainty and verification
  // burden with a mandatory reason — never by disposition label.
  assert.match(briefLaw, /single `worker` lane/);
  assert.match(briefLaw, /`thinking`.*`thinkingReason`/);
  assert.match(briefLaw, /by task uncertainty and verification burden, never by disposition label/);

  // Disposition-specific 6-Field Handoff evidence expectations (ticket 03).
  assert.match(briefLaw, /alternatives considered.*strongest counterargument.*reversal conditions/);
  assert.match(briefLaw, /`reviewer`.*concrete `claim` \+ `file:line` evidence per finding/);
  assert.match(briefLaw, /`scout`.*`file:line` evidence paths, remaining unknowns, and confidence \(`low \| medium \| high`\)/);

  // lead_close_task is the clean retirement for superseded or split unaccepted
  // Tasks (ticket 05) — it lives where the context-ceiling split is ruled.
  const boundedLaw = LEAD_WAVE_LAWS.find((law) => law.startsWith("Bounded Verification & Context-Ceiling Recovery"))!;
  assert.ok(boundedLaw !== undefined, "the Bounded Verification & Context-Ceiling Recovery law exists");
  assert.match(boundedLaw, /lead_close_task/);
  assert.match(boundedLaw, /superseded or split/);

  // Every Lead surface carries the per-dispatch effort law and the retirement.
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.match(surface, /never by disposition label/);
    assert.match(surface, /lead_close_task/);
  }
});

test("the Lead command block names lead_update_notebook, lead_close_task, and the per-dispatch --thinking effort (v0.5.0, ADR 0052 §1 / ADR 0054 §4–§5)", () => {
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input)]) {
    // MCP vocabulary: notebook single writer, clean task retirement, and the
    // thinking/thinkingReason pair on dispatch.
    assert.match(surface, /paseo-factory_lead_update_notebook\(\{ content:/);
    assert.match(surface, /paseo-factory_lead_close_task\(\{ task: "<id>", reason:/);
    assert.match(surface, /paseo-factory_lead_dispatch_agent\(\{ tasks: \["<id>"\], thinking: "/);
    assert.match(surface, /thinkingReason: "/);
    // CLI vocabulary: the same three surfaces as factory notebook / close / run --thinking.
    assert.match(surface, /run <task> \[<task>\.\.\.\] \[--thinking <low\|medium\|high\|xhigh\|max>\]/);
    assert.match(surface, /close --task <id> --reason "<text>"/);
    assert.match(surface, /notebook \(--content <text> \| --file <path>\)/);
  }
  // The Supervisor block never gains the Lead-only vocabulary.
  for (const supervisorSurface of [renderRoleContract("supervisor"), renderSeatContract("supervisor", project), ROLE_PROMPTS.supervisor]) {
    assert.doesNotMatch(supervisorSurface, /lead_update_notebook/);
    assert.doesNotMatch(supervisorSurface, /notebook --content/);
  }
});

test("Supervisor outcome boundary presents Tier-2/Tier-3 proposals as the 4-Line Owner Ratification Card and edits AGENTS.md/CONTEXT.md only after explicit Owner Ratification (v0.1.0, ADR 0048 Decisions 2, 4)", () => {
  // The boundary constant itself codifies the card and the ratification gate.
  assert.match(SUPERVISOR_OUTCOME_BOUNDARY, /hardening Proposal that would change repo prose.*>= 2 `Task \(seq N\)` citations from the Recurrence Guard/);
  assert.match(SUPERVISOR_OUTCOME_BOUNDARY, /1\. Chuyện gì đã lặp lại/);
  assert.match(SUPERVISOR_OUTCOME_BOUNDARY, /2\. Nguyên nhân gốc/);
  assert.match(SUPERVISOR_OUTCOME_BOUNDARY, /3\. Nếu duyệt sẽ sửa gì \(Preview diff\)/);
  assert.match(SUPERVISOR_OUTCOME_BOUNDARY, /4\. Tác dụng/);
  assert.match(SUPERVISOR_OUTCOME_BOUNDARY, /edit `<project-root>\/AGENTS\.md` or `<project-root>\/CONTEXT\.md` only after explicit Owner Ratification/);
  assert.match(SUPERVISOR_OUTCOME_BOUNDARY, /never edit them on an unratified proposal/);

  // Every Supervisor surface (contract, seat contract, ROLE_PROMPTS,
  // bootstraps, Turn-1 kickoff packet law line) carries the card and the gate.
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "supervisor" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("supervisor"), renderSeatContract("supervisor", project), ROLE_PROMPTS.supervisor,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "supervisor", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    assert.match(surface, /4-Line Owner Ratification Card/);
    assert.match(surface, /1\. Chuyện gì đã lặp lại/);
    assert.match(surface, /2\. Nguyên nhân gốc/);
    assert.match(surface, /3\. Nếu duyệt sẽ sửa gì \(Preview diff\)/);
    assert.match(surface, /4\. Tác dụng/);
    assert.match(surface, /`<project-root>\/AGENTS\.md` or `<project-root>\/CONTEXT\.md` only after explicit Owner Ratification/);
  }
});

test("Peer contract carries the independent-colleague stance, Contract Before Test, and the 6-Field Handoff — escalation is never gated behind a third failed fix (ADR 0053 §2/§4–§5, User Stories 5 and 16)", () => {
  for (const surface of [renderRoleContract("agent"), renderRoleAppendSystem("agent"), ROLE_PROMPTS.agent, renderAgentContract("T-06", "repo")]) {
    // Independent colleague with its own judgment — the obedience framing is gone.
    assert.match(surface, /independent technical colleague/i);
    assert.match(surface, /provisional map for this one turn/);
    assert.match(surface, /data to reconcile, not disobedience/);
    assert.doesNotMatch(surface, /Strict Wave Boundary/);
    // Contract Before Test: the premise challenge fires immediately, before any
    // test or code, through the real escalation surfaces — never after 3 failures.
    assert.match(surface, /Contract Before Test/);
    assert.match(surface, /challenge immediately, BEFORE writing tests or code/);
    assert.match(surface, /REOPEN_REQUEST \(<layer>: one of foundation \| dependency \| lifecycle \| API \| ownership \| verification/);
    assert.match(surface, /DEPENDENCY_REQUEST/);
    assert.match(surface, /at least one alternative direction/);
    assert.match(surface, /current commit SHA/);
    assert.match(surface, /session stays alive and paused for the Lead's ruling/);
    assert.doesNotMatch(surface, /Before escalating/);
    assert.doesNotMatch(surface, /third.*fail.*before.*escalat/i);
    // The false-RED law: a RED test explores implementation, never invents a contract.
    assert.match(surface, /RED test may explore implementation, but must never invent an undecided contract/);
    assert.match(surface, /loosening an assertion to force GREEN/);
    // The 6-Field Handoff obligation and the read-only disposition handoff law.
    assert.match(surface, /Six-Field Handoff/);
    assert.match(surface, /`outcome` \(complete \| partial \| blocked \| reopen\)/);
    assert.match(surface, /`scope` \(files changed or read, with concrete paths\)/);
    assert.match(surface, /`verification` \(commands run \+ real output, and what was deliberately skipped\)/);
    assert.match(surface, /`unknowns` \(assumptions stood on, open risks, or "none"\)/);
    assert.match(surface, /Read-only dispositions \(`scout`, `architect`, `reviewer`\) write no files and make no commit/);
    assert.match(surface, /`engineer` disposition commits its own work/);
    assert.match(surface, /claiming done before done is worse than BLOCKED/);
    // Unknown is a legitimate result (the Scout law).
    assert.match(surface, /'Unknown' is a legitimate result/);
  }
});

test("Lead contract carries the canonical LEAD.md laws — neutral Briefs, Spec-vs-Code ruling, four dispositions, live in-place reconciliation, handoff-bearing acceptance, and the five Reviewer triggers (ADR 0053 §5, User Story 18)", () => {
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "lead" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("lead"), renderSeatContract("lead", project), ROLE_PROMPTS.lead,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "lead", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    // Neutral Brief / no pre-solve: the provisional-map premise, stated to the Peer.
    assert.match(surface, /neutral and never pre-solve implementation/);
    assert.match(surface, /provisional map for ONE Peer turn/);
    assert.match(surface, /Peer merely types your ideas back/);
    // Spec-vs-Code conflict is the Lead's architectural ruling, or an architect rebuilds the boundary.
    assert.match(surface, /Spec-vs-Code Ruling/);
    assert.match(surface, /picking the reading is an architectural ruling that belongs to you/);
    assert.match(surface, /read-only `architect` disposition to rebuild the boundary before anyone writes tests/);
    // The four dispositions dispatched through lead_set_contract's disposition parameter.
    assert.match(surface, /`lead_set_contract`'s `disposition` parameter/);
    for (const disposition of ["scout", "architect", "engineer", "reviewer"]) {
      assert.ok(surface.includes(`\`${disposition}\``), `the Lead vocabulary names the ${disposition} disposition`);
    }
    // Live, in-place challenge reconciliation (ticket 02 surfaces).
    assert.match(surface, /data to reconcile, not disobedience/);
    assert.match(surface, /`lead_repoke_agent`'s `message` parameter/);
    assert.match(surface, /preserved by default \(`resetPeer: false`\)/);
    assert.match(surface, /`resetPeer: true`\) only when its context is truly misaligned/);
    // Acceptance reads the 6-Field Handoff plus the attested diff before accepting.
    assert.match(surface, /report-<task>-<n>\.md` and `git show --stat "<sha>"` first — the report carries the Peer's 6-Field Handoff \(Outcome, Snapshot, Scope, Verification, Unknown \/ risk, Ownership\)/);
    assert.match(surface, /git diff "<sha>\^" "<sha>"/);
    assert.match(surface, /`lead_accept_task`/);
    assert.match(surface, /missing or hand-waved handoff field is a question back to the Peer/);
    assert.match(surface, /Unknown stays Unknown/);
    // The independent Reviewer layer: default NO, five mandatory triggers.
    assert.match(surface, /Independent Reviewer — default is NO/);
    assert.match(surface, /five triggers/);
    assert.match(surface, /pre-solved the solution, not just the outcome/);
    assert.match(surface, /hard to reverse/);
    assert.match(surface, /proof is suspect/);
    assert.match(surface, /withdrew it without new evidence/);
  }
});

test("Supervisor contract carries neutral intent framing downward, the downward privacy firewall, and active SLP Loop Auditing coaching triggers (ADR 0053 §5, User Story 19)", () => {
  const project = { root: "/workspace/repo", slug: "repo" };
  const input = { seat: "supervisor" as const, home: "/trial", stateDir: "/trial/state", nodePath: process.execPath,
    path: "/usr/bin", lane: "codex", project };
  for (const surface of [renderRoleContract("supervisor"), renderSeatContract("supervisor", project), ROLE_PROMPTS.supervisor,
    renderSeatBootstrapPrompt(input), renderSeatBootstrap(input),
    buildSeatKickoffPacket({ role: "supervisor", projectSlug: project.slug, projectRoot: project.root, ledgerEvents: [] })]) {
    // Framing is the Lead's — the Supervisor transmits intent, never decomposition.
    assert.match(surface, /framing is the Lead's/);
    assert.match(surface, /not a second project Lead/);
    // The downward privacy firewall.
    assert.match(surface, /Downward Privacy Firewall/);
    assert.match(surface, /no verbatim Owner quotes or transcripts/);
    assert.match(surface, /Express authorized decisions directly as project instructions/);
    // Active SLP Loop Auditing with the named coaching triggers.
    assert.match(surface, /Active SLP Loop Auditing/);
    assert.match(surface, /original Lead Brief → actual Peer response → explicit Lead disposition/);
    assert.match(surface, /Lead's summary alone is not proof that the loop closed/);
    assert.match(surface, /pre-solving Briefs/);
    assert.match(surface, /micro-splitting waves/);
    assert.match(surface, /instead of dispatching a read-only Scout/);
    assert.match(surface, /bouncing technical decisions/);
    assert.match(surface, /never a parallel command chain to workers/);
  }
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

test("Peer create refreshes selected OAuth before provider fencing; coordination seats keep only Factory", async (t) => {
  const { syncPeerHelpersBeforeCreate } = await import("../plugin/server/roles.ts");
  const { catalog } = await import("../src/mcp/catalog.ts");
  const dir = makeTempDir(); disposeDir(t, dir);
  const userHome = join(dir, "user"), stateDir = join(dir, "state");
  mkdirSync(join(userHome, ".gemini/config"), { recursive: true });
  mkdirSync(join(userHome, ".gemini/antigravity"), { recursive: true });
  const url = "https://mcp.supabase.com/mcp";
  writeFileSync(join(userHome, ".gemini/config/mcp_config.json"), JSON.stringify({ mcpServers: { supabase: { serverUrl: url } } }));
  writeFileSync(join(userHome, ".gemini/antigravity/mcp_oauth_tokens.json"), JSON.stringify({ [url]: { token: { access_token: "valid-test-token", expiry: new Date(Date.now() + 3600000).toISOString() } } }));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "helper-mcps.json"), JSON.stringify({ overrides: { supabase: true }, targets: { supabase: ["pi", "claude"] } }));
  await syncPeerHelpersBeforeCreate({ config: { provider: "factory-peer", cwd: dir } }, stateDir, userHome);
  for (const provider of ["claude", "codex", "opencode", "pi"]) for (const role of ["agent", "lead", "supervisor"] as const) {
    const result = applyProviderExecutionFence({ provider, cwd: dir, mcpServers: { stray: { command: "unused" } } }, { stateDir, userHome, role, projectSlug: "repo", correlationId: "test" });
    const servers = result.mcpServers as any;
    assert.equal(servers.stray, undefined);
    if (role === "agent" && ["pi", "claude"].includes(provider)) assert.equal(servers.supabase.headers.Authorization, "Bearer valid-test-token");
    else assert.equal(servers.supabase, undefined);
    if (role === "supervisor" && provider === "opencode") assert.equal((result as any).providerOptions.permission.skill["domain-modeling"], "allow");
  }
  assert.ok(catalog.roles.supervisor.includes("supervisor_accept_task"));
  assert.ok(catalog.roles.lead.includes("lead_repoke_agent"));
  assert.ok(catalog.roles.lead.includes("lead_needs_human"));
});
