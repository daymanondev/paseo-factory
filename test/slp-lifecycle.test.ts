import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { contractFromLedger, readDriverLedger } from "../plugin/bin/driver.mjs";
import { prepareTaskWorkspace } from "../plugin/bin/task-worktree.mjs";
import { CorrelationRegistry } from "../src/correlations.ts";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createChoke } from "../plugin/server/choke.ts";
import type { PaseoResponderApi } from "../plugin/server/choke.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { injectRoleOnCreate, injectSessionEnv } from "../plugin/server/roles.ts";
import { claimCliBinDir, ensureClaimCli, ensureGitShim } from "../plugin/server/shell.ts";
import { startSpool } from "../plugin/server/spool.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

const BRIDGE_BIN = resolve(repoRoot, "plugin/bin/bridge.mjs");

async function callMcpTool(input: {
  args: string[];
  env?: NodeJS.ProcessEnv;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): Promise<{ isError?: boolean; text: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [BRIDGE_BIN, ...input.args], {
      env: { ...process.env, ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses: Array<Record<string, unknown>> = [];
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line !== "") {
          responses.push(JSON.parse(line) as Record<string, unknown>);
          if (responses.length >= 2) child.stdin.end();
        }
        nl = buf.indexOf("\n");
      }
    });
    child.on("error", rejectPromise);
    child.on("close", () => {
      const callResp = responses[1]?.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
      resolvePromise({
        isError: callResp?.isError,
        text: callResp?.content?.[0]?.text ?? JSON.stringify(responses[1]),
      });
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "slp-test", version: "1.0.0" } },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: input.toolName, arguments: input.toolArgs },
      })}\n`,
    );
  });
}

test("Full SLP lifecycle: Owner -> Supervisor -> Lead -> Agent -> Lead -> Supervisor via paseo_factory MCP + 3-layer execution fence (v0.0.26, ADR 0016)", async (t) => {
  const dir = makeTempDir("slp-lifecycle-");
  disposeDir(t, dir);
  const projectRoot = join(dir, "repo");
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node -e 'process.exit(0)'" } }, null, 2));
  writeFileSync(join(projectRoot, "src", "index.ts"), "export const base = 1;\n");
  gitCommitAll(projectRoot, "initial commit");

  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const correlations = new CorrelationRegistry(stateDir);

  interface LiveAgent {
    id: string;
    provider: string;
    title: string | null;
    status: string;
    cwd: string;
    labels: Record<string, string>;
    env: Record<string, string>;
    config: Record<string, unknown>;
  }
  const agents: LiveAgent[] = [];
  const sentPrompts: Array<{ agentId: string; text: string }> = [];

  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async (options) => {
        const filterLabels = options?.filter?.labels;
        const matched = agents.filter((a) => {
          if (filterLabels !== undefined) {
            for (const [k, v] of Object.entries(filterLabels)) {
              if (a.labels[k] !== v) return false;
            }
          }
          return true;
        });
        return {
          entries: matched.map((a) => ({
            agent: {
              id: a.id,
              provider: a.provider,
              title: a.title,
              status: a.status,
              model: null,
              labels: a.labels,
              archivedAt: null,
              requiresAttention: false,
              attentionReason: null,
              updatedAt: new Date().toISOString(),
              cwd: a.cwd,
            },
          })),
        };
      },
      create: async (options) => {
        // Simulate server.before("agent.create") + server.before("agent.session_open")
        const createHookOut = injectRoleOnCreate(
          {
            config: {
              provider: options.config.provider,
              cwd: options.cwd,
              title: options.title,
            },
            env: {},
          },
          stateDir,
          home,
        );
        const effectiveConfig = (createHookOut?.config ?? options.config) as Record<string, unknown>;
        const effectiveEnv = { ...(createHookOut?.env ?? {}) };
        const id = `agent-${agents.length + 1}`;
        const sessionOpenOut = injectSessionEnv(
          { agentId: id, cwd: options.cwd, env: effectiveEnv },
          stateDir,
          home,
        );
        const finalEnv = sessionOpenOut?.env ?? effectiveEnv;
        agents.push({
          id,
          provider: options.config.provider,
          title: options.title ?? null,
          status: "idle",
          cwd: options.cwd,
          labels: options.labels ?? {},
          env: finalEnv,
          config: effectiveConfig,
        });
        if (options.prompt !== undefined && options.prompt !== "") {
          sentPrompts.push({ agentId: id, text: options.prompt });
        }
        return { id };
      },
      ref: (id: string) => ({
        send: async (text: string) => {
          sentPrompts.push({ agentId: id, text });
        },
        archive: async () => ({ archivedAt: new Date().toISOString() }),
        timeline: { refetch: async () => ({ entries: [] }) },
        waitForTurnResult: async () => ({ status: "idle" }),
        cancel: async () => {},
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "claude-code", available: true }] }),
      listModels: async () => ({ models: [] }),
    },
  };

  let leadMail!: ReturnType<typeof createLeadMailRuntime>;
  const surface = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon,
    stopAgent: async () => ({ ok: true }),
    onLeadRetired: (input) => leadMail.settleLeadRotation(input.slug),
    leadDispatch: (req) => leadMail.dispatchLead(req),
  });
  leadMail = createLeadMailRuntime({
    factory,
    stateDir,
    daemon,
    ensureLead: (input) => surface.leadEnsure(input),
    ensureSupervisor: (input) => surface.supervisorEnsure(input),
    retireLead: (input) => surface.leadRotate(input),
  });
  const spool = startSpool(stateDir, factory, {
    pollMs: 20,
    leadDispatch: (req) => leadMail.dispatchLead(req),
    supervisorDispatch: (req) => leadMail.dispatchSupervisor(req),
    supervisorReport: (req) => leadMail.reportSupervisor(req),
    peerMail: leadMail.notifyPeer,
    daemon: daemon as never,
  });
  t.after(() => spool.stop());

  // 1. Owner -> Supervisor via factory_dispatch_supervisor
  const ownerDispatch = await callMcpTool({
    args: ["--state-dir", stateDir, "--workspace", projectRoot],
    toolName: "factory_dispatch_supervisor",
    toolArgs: { workspace: projectRoot, message: "Ship greet.ts, then a greeting consumer" },
  });
  assert.notEqual(ownerDispatch.isError, true, ownerDispatch.text);
  const supAgent = agents.find((a) => a.labels.seat === "supervisor");
  assert.ok(supAgent !== undefined, "Supervisor seat created");
  assert.ok(supAgent.env.PASEO_FACTORY_CORRELATION?.startsWith("cor_"), "Supervisor issued correlationId");
  assert.equal(correlations.findByAgentId(supAgent.id)?.role, "supervisor", "Correlation bound to Supervisor agentId");

  const supTurn1 = sentPrompts.find((p) => p.agentId === supAgent.id && p.text.includes("Ship greet.ts, then a greeting consumer"));
  assert.ok(supTurn1 !== undefined, "Supervisor received directive");
  assert.match(supTurn1.text, /\[paseo-factory seat kickoff packet · role=supervisor/, "Supervisor Turn 1 includes kickoff packet");

  // 2. Supervisor -> Lead via supervisor_dispatch_lead
  const supDispatch = await callMcpTool({
    args: ["--correlation", supAgent.env.PASEO_FACTORY_CORRELATION!, "--state-dir", stateDir],
    toolName: "supervisor_dispatch_lead",
    toolArgs: { message: "Decompose and contract T-01 for src/greet.ts" },
  });
  assert.notEqual(supDispatch.isError, true, supDispatch.text);
  const leadAgent = agents.find((a) => a.labels.seat === "lead");
  assert.ok(leadAgent !== undefined, "Lead seat created");
  assert.ok(leadAgent.env.PASEO_FACTORY_CORRELATION?.startsWith("cor_"), "Lead issued correlationId");
  assert.equal(correlations.findByAgentId(leadAgent.id)?.role, "lead", "Correlation bound to Lead agentId");

  const leadTurn1 = sentPrompts.find(
    (p) => p.agentId === leadAgent.id && p.text.includes("Decompose and contract T-01"),
  );
  assert.ok(leadTurn1 !== undefined, "Lead received directive from Supervisor");
  assert.match(leadTurn1.text, /\[paseo-factory seat kickoff packet · role=lead/, "Lead Turn 1 includes kickoff packet");

  // Complete Lead Turn 1 so Lead is idle when the Agent verdict arrives
  await leadMail.onLeadTurnEnded({ agentId: leadAgent.id, outcome: { kind: "completed" }, timeline: [] });

  // 3. Lead -> Agent via lead_set_contract + lead_dispatch_agent
  const setContractRes = await callMcpTool({
    args: ["--correlation", leadAgent.env.PASEO_FACTORY_CORRELATION!, "--state-dir", stateDir],
    toolName: "lead_set_contract",
    toolArgs: {
      task: "T-01",
      gate: "sleep 30 & test -f src/greet.ts",
      artifact: "src/greet.ts",
      scope: ["src/greet.ts"],
    },
  });
  assert.notEqual(setContractRes.isError, true, setContractRes.text);

  const spawnAgentRes = await callMcpTool({
    args: ["--correlation", leadAgent.env.PASEO_FACTORY_CORRELATION!, "--state-dir", stateDir],
    toolName: "lead_dispatch_agent",
    toolArgs: {
      task: "T-01",
      prompt: "Create src/greet.ts",
    },
  });
  assert.notEqual(spawnAgentRes.isError, true, spawnAgentRes.text);

  const taskAgent = agents.find((a) => a.id !== supAgent.id && a.id !== leadAgent.id);
  assert.ok(taskAgent !== undefined, "Task Agent spawned in isolated worktree");
  assert.ok(taskAgent.env.PASEO_FACTORY_CORRELATION?.startsWith("cor_"), "Task Agent issued correlationId");
  assert.equal(correlations.findByAgentId(taskAgent.id)?.role, "agent");

  // 4. Agent writes contracted artifact in worktree, commits, and calls agent_claim
  const worktreeDir = taskAgent.cwd;
  mkdirSync(join(worktreeDir, "src"), { recursive: true });
  writeFileSync(join(worktreeDir, "src", "greet.ts"), "export const greet = () => 'hello';\n");
  execFileSync("git", ["add", "src/greet.ts"], { cwd: worktreeDir });
  execFileSync("git", ["commit", "-m", "feat: add greet"], { cwd: worktreeDir });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreeDir, encoding: "utf8" }).trim();

  const claimStart = Date.now();
  const claimRes = await callMcpTool({
    args: ["--correlation", taskAgent.env.PASEO_FACTORY_CORRELATION!, "--state-dir", stateDir],
    toolName: "agent_claim",
    toolArgs: { commit: sha },
  });
  const claimElapsed = Date.now() - claimStart;
  assert.notEqual(claimRes.isError, true, claimRes.text);
  assert.match(claimRes.text, /GREEN/i);
  assert.ok(claimElapsed < 4_000, `Gate reaped background 'sleep 30 &' promptly (${claimElapsed}ms)`);

  // Pre-contract the dependent wave before acceptance to exercise CLI base advancement.
  const waveTwoContract = await callMcpTool({
    args: ["--correlation", leadAgent.env.PASEO_FACTORY_CORRELATION!, "--state-dir", stateDir],
    toolName: "lead_set_contract",
    toolArgs: { task: "T-02", artifact: "src/consumer.ts", gate: "test -f src/greet.ts && test -f src/consumer.ts", freshEyes: false },
  });
  assert.notEqual(waveTwoContract.isError, true, waveTwoContract.text);
  const staleContract = contractFromLedger(readDriverLedger(stateDir), "T-02");
  assert.ok(staleContract);
  assert.ok(typeof staleContract.workspace === "string");
  assert.ok(typeof staleContract.base === "string");
  assert.ok(typeof staleContract.seq === "number");

  // 5. Accept the foundation checkpoint, then build and accept the dependent wave.
  const leadAccept = await callMcpTool({
    args: ["--correlation", leadAgent.env.PASEO_FACTORY_CORRELATION!, "--state-dir", stateDir],
    toolName: "lead_merge",
    toolArgs: { task: "T-01", attempt: 1 },
  });
  assert.notEqual(leadAccept.isError, true, leadAccept.text);
  assert.ok(existsSync(join(projectRoot, "src", "greet.ts")), "Landing on Accept merged src/greet.ts into <project-root>");

  const checkpoint = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  const prepared = prepareTaskWorkspace(stateDir, {
    workspace: staleContract.workspace, base: staleContract.base, seq: staleContract.seq,
  }, "T-02", readDriverLedger(stateDir));
  assert.ok(prepared.ok, prepared.ok ? "" : prepared.reason);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: prepared.cwd, encoding: "utf8" }).trim(), checkpoint);
  assert.ok(existsSync(join(prepared.cwd, "src/greet.ts")), "CLI allocation contains the landed foundation");
  const secondSpawn = await callMcpTool({
    args: ["--correlation", leadAgent.env.PASEO_FACTORY_CORRELATION!, "--state-dir", stateDir],
    toolName: "lead_dispatch_agent", toolArgs: { task: "T-02", prompt: "Consume the landed greeting" },
  });
  assert.notEqual(secondSpawn.isError, true, secondSpawn.text);
  const secondAgent = agents.at(-1)!;
  assert.notEqual(secondAgent.id, taskAgent.id);
  assert.equal(readFileSync(join(secondAgent.cwd, "src/greet.ts"), "utf8"), "export const greet = () => 'hello';\n");
  writeFileSync(join(secondAgent.cwd, "src/consumer.ts"), "import { greet } from './greet.ts';\nexport const message = greet();\n");
  execFileSync("git", ["add", "src/consumer.ts"], { cwd: secondAgent.cwd });
  execFileSync("git", ["commit", "-m", "feat: consume greeting"], { cwd: secondAgent.cwd });
  const finalSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: secondAgent.cwd, encoding: "utf8" }).trim();
  const secondClaim = await callMcpTool({
    args: ["--correlation", secondAgent.env.PASEO_FACTORY_CORRELATION!, "--state-dir", stateDir],
    toolName: "agent_claim", toolArgs: { commit: finalSha },
  });
  assert.notEqual(secondClaim.isError, true, secondClaim.text);
  assert.match(secondClaim.text, /GREEN/);
  const finalAccept = await callMcpTool({
    args: ["--correlation", leadAgent.env.PASEO_FACTORY_CORRELATION!, "--state-dir", stateDir],
    toolName: "lead_merge", toolArgs: { task: "T-02", attempt: 1 },
  });
  assert.notEqual(finalAccept.isError, true, finalAccept.text);
  assert.ok(existsSync(join(projectRoot, "src/consumer.ts")), "final wave is landed before reporting");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(), finalSha);

  // Complete Supervisor Turn 1 so Supervisor is idle for Lead's report
  await leadMail.onLeadTurnEnded({ agentId: supAgent.id, outcome: { kind: "completed" }, timeline: [] });

  const leadReport = await callMcpTool({
    args: ["--correlation", leadAgent.env.PASEO_FACTORY_CORRELATION!, "--state-dir", stateDir],
    toolName: "lead_report_to_supervisor",
    toolArgs: { message: "T-01 and T-02 landed cleanly and passed gates." },
  });
  assert.notEqual(leadReport.isError, true, leadReport.text);

  const supTurn2 = sentPrompts.find(
    (p) => p.agentId === supAgent.id && p.text.includes("T-01 and T-02 landed cleanly and passed gates."),
  );
  assert.ok(supTurn2 !== undefined, "Supervisor received Lead's completion report");
  assert.doesNotMatch(supTurn2.text, /\[paseo-factory seat kickoff packet/, "Turn 2 omits kickoff packet");

  // 6. Negative assertions across all 3 execution-fence layers
  // Layer 1: agent.create config has no labels
  assert.equal("labels" in supAgent.config, false);
  assert.equal("labels" in leadAgent.config, false);

  // Layer 2: Choke policy blocks raw Paseo tools, product writes by Lead, and pkill plugin-process.js
  const choke = createChoke({ factory, homeDir: home });
  const chokeReplies: AgentPermissionResponse[] = [];
  const responder: PaseoResponderApi = {
    agents: {
      ref: () => ({
        respondToPermission: async ({ response }) => {
          chokeReplies.push(response);
        },
      }),
    },
  };
  await choke.onPermissionAsked(
    {
      agent: { id: leadAgent.id, cwd: projectRoot, title: leadAgent.title },
      request: { id: "r1", provider: "claude", name: "create_agent", kind: "tool" },
    },
    responder,
  );
  assert.equal(chokeReplies.at(-1)?.behavior, "deny");

  await choke.onPermissionAsked(
    {
      agent: { id: leadAgent.id, cwd: projectRoot, title: leadAgent.title },
      request: {
        id: "r2",
        provider: "claude",
        name: "Write",
        kind: "tool",
        detail: { type: "write", filePath: "src/index.ts", content: "hack" },
      },
    },
    responder,
  );
  assert.equal(chokeReplies.at(-1)?.behavior, "deny");

  // Layer 3: OS PATH shims block forbidden git/pkill/paseo/gh commands
  ensureClaimCli(stateDir, join(repoRoot, "plugin"), process.execPath);
  ensureGitShim(stateDir, join(repoRoot, "plugin"), process.execPath);
  const binDir = claimCliBinDir(stateDir);
  const shimEnv = {
    ...process.env,
    FACTORY_STATE_DIR: stateDir,
    PASEO_FACTORY_SEAT: "supervisor",
    PATH: `${binDir}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
  assert.equal(spawnSync(join(binDir, "git"), ["commit", "-m", "nope"], { cwd: projectRoot, env: shimEnv }).status, 126);
  assert.equal(spawnSync(join(binDir, "pkill"), ["-9", "-f", "plugin-process.js"], { cwd: projectRoot, env: shimEnv }).status, 126);
  assert.equal(spawnSync(join(binDir, "paseo"), ["agent", "create"], { cwd: projectRoot, env: shimEnv }).status, 126);
  assert.equal(spawnSync(join(binDir, "gh"), ["pr", "merge"], { cwd: projectRoot, env: shimEnv }).status, 126);
});
