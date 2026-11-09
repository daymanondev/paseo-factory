import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CorrelationRegistry } from "../src/correlations.ts";
import { createFactory } from "../plugin/server/core/factory.ts";
import { ensureProjectRegistered, readProjectRegistration, writeProjectRegistration } from "../src/project.ts";
import { readLeadMailbox } from "../src/mailbox.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { startSpool } from "../plugin/server/spool.ts";
import { createFactoryRegistry } from "../plugin/server/projects.ts";

const BRIDGE_BIN = resolve(import.meta.dirname, "../plugin/bin/bridge.mjs");

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-bridge-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "factory@example.com"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

/** Wraps a one-line summary into the mandatory 4-Part Brief shape (ADR 0054 §1). */
function brief4(summary: string, verification = "the gate command runs green"): string {
  return [
    "1. Bounded Outcome",
    summary,
    "",
    "2. Contract Boundary & Regression Invariants",
    "Existing HEAD interfaces stay untouched.",
    "",
    "3. Excluded / Deferred",
    "None.",
    "",
    "4. Verification",
    verification,
  ].join("\n");
}

async function runMcpSession(options: {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  framing?: "newline" | "content-length";
  script?: string;
  requests: Array<Record<string, unknown>>;
}): Promise<Array<Record<string, unknown>>> {
  const child = spawn(process.execPath, [options.script ?? BRIDGE_BIN, ...(options.args ?? [])], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const expectedResponses = options.requests.filter((r) => r.id !== undefined).length;
  const responses: Array<Record<string, unknown>> = [];
  let stdoutBuf = Buffer.alloc(0);
  let stderrStr = "";

  child.stderr.on("data", (chunk: Buffer) => {
    stderrStr += chunk.toString("utf8");
  });

  return await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`MCP session timed out. Got ${responses.length}/${expectedResponses} responses. stderr=${stderrStr}`));
    }, 15_000);

    const tryParseMessages = () => {
      while (stdoutBuf.length > 0) {
        const str = stdoutBuf.toString("utf8");
        if (str.startsWith("Content-Length:")) {
          const headerEnd = stdoutBuf.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const header = stdoutBuf.subarray(0, headerEnd).toString("utf8");
          const match = /Content-Length:\s*(\d+)/i.exec(header);
          if (!match) {
            stdoutBuf = stdoutBuf.subarray(headerEnd + 4);
            continue;
          }
          const len = Number(match[1]);
          const totalLen = headerEnd + 4 + len;
          if (stdoutBuf.length < totalLen) return;
          const body = stdoutBuf.subarray(headerEnd + 4, totalLen).toString("utf8");
          stdoutBuf = stdoutBuf.subarray(totalLen);
          responses.push(JSON.parse(body));
        } else {
          const nlIndex = stdoutBuf.indexOf("\n");
          if (nlIndex === -1) return;
          const line = stdoutBuf.subarray(0, nlIndex).toString("utf8").trim();
          stdoutBuf = stdoutBuf.subarray(nlIndex + 1);
          if (line === "") continue;
          responses.push(JSON.parse(line));
        }
      }
      if (responses.length >= expectedResponses) {
        clearTimeout(timeout);
        child.stdin.end();
        resolvePromise(responses);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      tryParseMessages();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      rejectPromise(err);
    });

    child.on("close", () => {
      clearTimeout(timeout);
      if (responses.length >= expectedResponses) {
        resolvePromise(responses);
      } else {
        rejectPromise(new Error(`Bridge exited early with ${responses.length}/${expectedResponses} responses. stderr=${stderrStr}`));
      }
    });

    for (const req of options.requests) {
      const json = JSON.stringify(req);
      if (options.framing === "content-length") {
        const bytes = Buffer.from(json, "utf8");
        child.stdin.write(`Content-Length: ${bytes.length}\r\n\r\n`);
        child.stdin.write(bytes);
      } else {
        child.stdin.write(`${json}\n`);
      }
    }
  });
}

test("CorrelationRegistry issues, associates agentId, persists to disk, and resolves by correlationId or agentId", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "factory-corr-"));
  try {
    const reg1 = new CorrelationRegistry(stateDir);
    const issued = reg1.issue({
      role: "lead",
      projectSlug: "demo-1234",
      projectRoot: "/tmp/demo",
    });
    assert.match(issued.correlationId, /^cor_[0-9a-f-]{36}$/);
    assert.equal(issued.role, "lead");
    assert.equal(issued.projectSlug, "demo-1234");
    assert.equal(issued.agentId, undefined);

    const associated = reg1.associate(issued.correlationId, "agent-lead-1");
    assert.ok(associated);
    assert.equal(associated.agentId, "agent-lead-1");

    // Second instance reading from disk
    const reg2 = new CorrelationRegistry(stateDir);
    const byCorr = reg2.resolve(issued.correlationId);
    assert.ok(byCorr);
    assert.equal(byCorr.role, "lead");
    assert.equal(byCorr.agentId, "agent-lead-1");

    const byAgent = reg2.resolve("agent-lead-1");
    assert.ok(byAgent);
    assert.equal(byAgent.correlationId, issued.correlationId);
    assert.equal(byAgent.projectSlug, "demo-1234");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bridge.mjs exposes strictly role-scoped tools in tools/list and enforces role boundaries on tools/call across newline and Content-Length framing", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "factory-bridge-roles-"));
  try {
    const registry = new CorrelationRegistry(stateDir);
    const supCorr = registry.issue({
      role: "supervisor",
      projectSlug: "proj-1",
      projectRoot: "/tmp/proj",
    });
    const leadCorr = registry.issue({
      role: "lead",
      projectSlug: "proj-1",
      projectRoot: "/tmp/proj",
    });
    const agentCorr = registry.issue({
      role: "agent",
      projectSlug: "proj-1",
      projectRoot: "/tmp/proj",
      task: "t-01",
    });

    // 1. Supervisor session (also simulate Codex env stripping: empty env, CLI flags only)
    const supResponses = await runMcpSession({
      args: ["--correlation", supCorr.correlationId, "--state-dir", stateDir],
      env: { PATH: process.env.PATH },
      framing: "newline",
      requests: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "t-01", gate: "true", artifact: "README.md" } } },
      ],
    });
    const supTools = ((supResponses[1].result as { tools: Array<{ name: string }> }).tools).map((t) => t.name).sort();
    assert.deepEqual(supTools, ["supervisor_accept_task", "supervisor_dispatch_lead", "supervisor_end_cycle", "supervisor_read_ledger"]);
    const supIllegalCall = supResponses[2].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(supIllegalCall.isError, true);
    assert.match(supIllegalCall.content[0].text, /not permitted|unauthorized|role/i);

    // 2. Lead session over Content-Length framing
    const leadResponses = await runMcpSession({
      args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir],
      env: { PATH: process.env.PATH },
      framing: "content-length",
      requests: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
    });
    const leadTools = ((leadResponses[1].result as { tools: Array<{ name: string }> }).tools).map((t) => t.name).sort();
    assert.deepEqual(leadTools, ["lead_create_worktree", "lead_dispatch_agent", "lead_merge", "lead_needs_human", "lead_remove_worktree", "lead_repoke_agent", "lead_report_to_supervisor", "lead_set_contract", "lead_verify"]);

    // 3. Working Agent session
    const agentResponses = await runMcpSession({
      args: ["--correlation", agentCorr.correlationId, "--state-dir", stateDir],
      env: { PATH: process.env.PATH },
      requests: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lead_merge", arguments: { task: "t-01", attempt: 1 } } },
      ],
    });
    const agentTools = ((agentResponses[1].result as { tools: Array<{ name: string }> }).tools).map((t) => t.name).sort();
    assert.deepEqual(agentTools, ["agent_claim", "agent_escalate_blocker"]);
    const agentIllegalCall = agentResponses[2].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(agentIllegalCall.isError, true);

    // 4. Unbound session (no role, no correlation)
    const unboundResponses = await runMcpSession({
      args: ["--state-dir", stateDir],
      env: { PATH: process.env.PATH },
      requests: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
    });
    const unboundTools = ((unboundResponses[1].result as { tools: Array<{ name: string }> }).tools).map((t) => t.name).sort();
    assert.deepEqual(unboundTools, ["factory_dispatch_supervisor", "factory_status"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bridge.mjs executes Supervisor, Lead, and Agent tools end-to-end over the Spool", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-e2e-home-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.equal(reg.ok, true);
  // v0.0.92 (ADR 0045 §1): production-parity wiring — the Per-Project Factory
  // Registry rides BOTH the Spool and the Lead mailbox runtime (one instance
  // per stateDir), so contracts and spawns land in
  // <stateDir>/projects/<slug>/ledger.jsonl with NO root <stateDir>/ledger.jsonl
  // anywhere — exactly the machine the live plugin server runs on.
  const registry = createFactoryRegistry({ stateDir, root: factory });

  const sentPrompts: Array<{ id: string; text: string }> = [];
  const fakeAgents = new Map<string, { id: string; status: string; archivedAt: string | null; cwd: string; labels: Record<string, string> }>([
    ["sup-1", { id: "sup-1", status: "idle", archivedAt: null, cwd: repoDir, labels: { seat: "supervisor", project: reg.slug } }],
    ["lead-1", { id: "lead-1", status: "idle", archivedAt: null, cwd: repoDir, labels: { seat: "lead", project: reg.slug } }],
  ]);

  const fakeDaemon = {
    agents: {
      list: async (opts?: { filter?: { labels?: Record<string, string> } }) => {
        const wanted = opts?.filter?.labels ?? {};
        const entries = [...fakeAgents.values()]
          .filter((a) => Object.entries(wanted).every(([k, v]) => a.labels[k] === v))
          .map((agent) => ({ agent }));
        return { entries };
      },
      ref: (id: string) => ({
        send: async (text: string) => {
          sentPrompts.push({ id, text });
          return { messageId: `msg-${sentPrompts.length}` };
        },
        cancel: async () => {},
        archive: async () => {},
      }),
    },
  };

  const mailRuntime = createLeadMailRuntime({
    stateDir,
    factory,
    registry,
    daemon: fakeDaemon as never,
    ensureLead: async () => ({ ok: true, agentId: "lead-1", created: false, projectRoot: repoDir, slug: reg.slug }),
    ensureSupervisor: async () => ({ ok: true, agentId: "sup-1", created: false, projectRoot: repoDir, slug: reg.slug }),
    retireLead: async () => ({ ok: true, agentId: "lead-1" }),
  });

  const spool = startSpool(stateDir, factory, {
    registry,
    pollMs: 25,
    leadDispatch: mailRuntime.dispatchLead,
    supervisorDispatch: mailRuntime.dispatchSupervisor,
    supervisorReport: mailRuntime.reportSupervisor,
    peerMail: mailRuntime.notifyPeer,
    daemon: fakeDaemon as never,
  });

  try {
    const correlations = new CorrelationRegistry(stateDir);
    const supCorr = correlations.issue({ role: "supervisor", projectSlug: reg.slug, projectRoot: repoDir });
    correlations.associate(supCorr.correlationId, "sup-1");
    const leadCorr = correlations.issue({ role: "lead", projectSlug: reg.slug, projectRoot: repoDir });
    correlations.associate(leadCorr.correlationId, "lead-1");

    // 1. Supervisor dispatches to Lead via supervisor_dispatch_lead
    const supCall = await runMcpSession({
      args: ["--correlation", supCorr.correlationId, "--state-dir", stateDir],
      cwd: repoDir,
      requests: [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "supervisor_dispatch_lead",
            arguments: { message: "Implement feature-x with gate true" },
          },
        },
      ],
    });
    const supText = (supCall[0].result as { content: Array<{ text: string }> }).content[0].text;
    assert.match(supText, /end your turn/i);
    assert.ok(sentPrompts.some((p) => p.id === "lead-1" && p.text.includes("Implement feature-x")));

    // 2. Lead sets contract and spawns agent via lead_set_contract and lead_dispatch_agent
    const leadCall = await runMcpSession({
      args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir],
      cwd: repoDir,
      requests: [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "lead_set_contract",
            arguments: {
              task: "feat-x",
              gate: "/usr/bin/true",
              artifact: "feature.txt",
              scope: "feature.txt",
              description: brief4("Implement feature-x"),
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "lead_dispatch_agent",
            arguments: {
              tasks: ["feat-x"],
            },
          },
        },
      ],
    });
    const contractRes = (leadCall[0].result as { isError?: boolean; content: Array<{ text: string }> });
    assert.notEqual(contractRes.isError, true, contractRes.content[0].text);
    const spawnRes = (leadCall[1].result as { isError?: boolean; content: Array<{ text: string }> });
    assert.notEqual(spawnRes.isError, true, spawnRes.content[0].text);

    // v0.0.92 (ADR 0045 §1): the Contract and the spawn round live in the
    // Project's ISOLATED ledger — no root ledger ever exists on this machine.
    const projectLedgerPath = join(stateDir, "projects", reg.slug, "ledger.jsonl");
    assert.ok(existsSync(projectLedgerPath), `the Project's ledger exists at ${projectLedgerPath}`);
    assert.equal(existsSync(join(stateDir, "ledger.jsonl")), false, "no legacy root ledger exists");
    const projectLedgerText = readFileSync(projectLedgerPath, "utf8");
    assert.match(projectLedgerText, /"contract_set"/);
    const spawnLine = projectLedgerText.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((e) => e.event === "spawn_dispatched");
    assert.ok(spawnLine, "the spawn round is recorded");
    assert.equal(typeof spawnLine.worktree, "string", "spawn_dispatched carries the resolved Task worktree");

    const projectFactory = registry.factoryForProject(reg.slug);
    const worktreePath = projectFactory.worktreeFor("feat-x");
    assert.ok(worktreePath, "lead_dispatch_agent must allocate and register the Task worktree");
    assert.equal(worktreePath, join(stateDir, "projects", reg.slug, "worktrees", "feat-x"));

    // 3. Working Agent commits in Task worktree and calls agent_claim, attesting
    //    the commit explicitly — the engineer disposition's mandatory word
    //    (ADR 0053 §4); the bridge no longer forges it from HEAD.
    writeFileSync(join(worktreePath, "feature.txt"), "done\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: worktreePath });
    execFileSync("git", ["commit", "-m", "feat: add feature.txt"], { cwd: worktreePath });
    const featSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();

    const agentCorr = correlations.issue({
      role: "agent",
      projectSlug: reg.slug,
      projectRoot: repoDir,
      task: "feat-x",
    });
    correlations.associate(agentCorr.correlationId, "agent-feat-x");

    const agentCall = await runMcpSession({
      args: ["--correlation", agentCorr.correlationId, "--state-dir", stateDir],
      cwd: worktreePath,
      requests: [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "agent_claim",
            arguments: { commit: featSha, outcome: "complete", scope: "feature.txt written", verification: "gate ran green", unknowns: "none" },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "agent_escalate_blocker",
            arguments: { message: "Note for Lead: check edge case Y" },
          },
        },
      ],
    });
    const claimText = (agentCall[0].result as { isError?: boolean; content: Array<{ text: string }> });
    assert.notEqual(claimText.isError, true, claimText.content[0].text);
    assert.match(claimText.content[0].text, /GREEN/i);

    const blockerRes = (agentCall[1].result as { isError?: boolean; content: Array<{ text: string }> });
    assert.notEqual(blockerRes.isError, true, blockerRes.content[0].text);
    const mailboxState = readLeadMailbox(join(stateDir, "projects", reg.slug, "mailbox.jsonl"));
    const allLeadMail = [...mailboxState.queued, ...(mailboxState.inFlight ? [mailboxState.inFlight] : [])];
    assert.ok(
      sentPrompts.some((p) => p.id === "lead-1" && p.text.includes("check edge case Y")) ||
        allLeadMail.some((m) => "text" in m && typeof m.text === "string" && m.text.includes("check edge case Y")),
      "agent_escalate_blocker must deliver or queue blocker mail to Lead",
    );

    // 4. Lead accepts task and reports to Supervisor, then queries factory_status
    const leadFinishCall = await runMcpSession({
      args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir],
      cwd: repoDir,
      requests: [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "lead_merge",
            arguments: { task: "feat-x", attempt: 1 },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "lead_report_to_supervisor",
            arguments: { message: "Wave complete: feat-x accepted on attempt 1." },
          },
        },
      ],
    });
    const acceptRes = leadFinishCall[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(acceptRes.isError, true, acceptRes.content[0].text);
    assert.match(acceptRes.content[0].text, /accepted/i);

    const reportRes = leadFinishCall[1].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(reportRes.isError, true, reportRes.content[0].text);
    assert.match(reportRes.content[0].text, /end your turn/i);
    assert.ok(sentPrompts.some((p) => p.id === "sup-1" && p.text.includes("Wave complete: feat-x accepted")));

    const statusCall = await runMcpSession({ args: ["--correlation", supCorr.correlationId, "--state-dir", stateDir], cwd: repoDir, requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "supervisor_read_ledger", arguments: {} } }] });
    const statusRes = statusCall[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(statusRes.isError, true, statusRes.content[0].text);
    assert.match(statusRes.content[0].text, /feat-x.*accepted=yes/);
  } finally {
    spool.stop();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("agent_escalate_blocker keeps the Peer alive and routes the challenge Lead-only (peer_challenge, no needs_human, no Supervisor wake); lead_needs_human and lead_report_to_supervisor still work (ADR 0053 Decision 2)", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-challenge-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.equal(reg.ok, true);
  const registry = createFactoryRegistry({ stateDir, root: factory });

  interface ChallengeAgentShape {
    id: string;
    status: string;
    archivedAt: string | null;
    cwd: string;
    labels: Record<string, string>;
  }
  const agents = new Map<string, ChallengeAgentShape>();
  const sent: Array<{ agentId: string; text: string }> = [];
  const archived: string[] = [];
  const cancelled: string[] = [];
  const workspaceDirs = new Map<string, string>();
  let createdSeq = 0;
  const registerAgent = (agent: ChallengeAgentShape) => agents.set(agent.id, agent) && agent;
  const lead: ChallengeAgentShape = { id: "lead-ch-1", status: "idle", archivedAt: null, cwd: repoDir, labels: { seat: "lead", project: reg.slug } };
  const supervisor: ChallengeAgentShape = { id: "sup-ch-1", status: "idle", archivedAt: null, cwd: repoDir, labels: { seat: "supervisor", project: reg.slug } };
  registerAgent(lead);
  registerAgent(supervisor);
  const createAgentIn = (workspaceId: string | undefined, input: { labels?: Record<string, string>; cwd?: string }): string => {
    createdSeq += 1;
    const id = `agent-created-${createdSeq}`;
    const wsCwd = workspaceId !== undefined ? workspaceDirs.get(workspaceId) : undefined;
    registerAgent({ id, status: "idle", archivedAt: null, cwd: wsCwd ?? input.cwd ?? repoDir, labels: { ...(input.labels ?? {}) } });
    return id;
  };
  const fakeDaemon = {
    agents: {
      list: async (opts?: { filter?: { labels?: Record<string, string> } }) => {
        const wanted = opts?.filter?.labels ?? {};
        const entries = [...agents.values()]
          .filter((a) => Object.entries(wanted).every(([k, v]) => a.labels[k] === v))
          .map((agent) => ({ agent }));
        return { entries };
      },
      ref: (id: string) => ({
        send: async (text: string) => {
          sent.push({ agentId: id, text });
          return { messageId: `msg-${sent.length}` };
        },
        cancel: async () => {
          cancelled.push(id);
        },
        archive: async () => {
          archived.push(id);
          const agent = agents.get(id);
          if (agent !== undefined) agent.archivedAt = new Date().toISOString();
        },
      }),
    },
    workspaces: {
      open: async () => ({ id: "project-workspace-main", projectId: "paseo-project-1" }),
      create: async (input: { source: { path: string } }) => {
        const id = `task-workspace-${workspaceDirs.size + 1}`;
        workspaceDirs.set(id, input.source.path);
        return { id };
      },
      ref: (id: string) => ({ agents: { create: async (input: { labels?: Record<string, string>; cwd?: string }) => ({ id: createAgentIn(id, input) }) } }),
    },
  };

  const mailRuntime = createLeadMailRuntime({
    stateDir,
    factory,
    registry,
    daemon: fakeDaemon as never,
    ensureLead: async () => ({ ok: true, agentId: lead.id, created: false, projectRoot: repoDir, slug: reg.slug }),
    ensureSupervisor: async () => ({ ok: true, agentId: supervisor.id, created: false, projectRoot: repoDir, slug: reg.slug }),
    retireLead: async () => ({ ok: true, agentId: lead.id }),
  });
  const spool = startSpool(stateDir, factory, {
    registry,
    pollMs: 25,
    leadDispatch: mailRuntime.dispatchLead,
    supervisorDispatch: mailRuntime.dispatchSupervisor,
    supervisorReport: mailRuntime.reportSupervisor,
    peerMail: mailRuntime.notifyPeer,
    daemon: fakeDaemon as never,
  });

  try {
    const canonicalRoot = reg.ok ? reg.root : repoDir;
    const correlations = new CorrelationRegistry(stateDir);
    const leadCorr = correlations.issue({ role: "lead", projectSlug: reg.slug, projectRoot: canonicalRoot });
    correlations.associate(leadCorr.correlationId, lead.id);

    // 1. Lead contracts and dispatches the Peer through the bridge.
    const leadCall = await runMcpSession({
      args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
      cwd: repoDir,
      requests: [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "T-CH", gate: "/usr/bin/true", artifact: "README.md", scope: ["README.md"], description: brief4("Land the challenge slice") } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["T-CH"] } } },
      ],
    });
    const contractRes = leadCall[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(contractRes.isError, true, contractRes.content[0].text);
    const spawnRes = leadCall[1].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(spawnRes.isError, true, spawnRes.content[0].text);

    const worktree = join(stateDir, "projects", reg.slug, "worktrees", "T-CH");
    assert.ok(existsSync(worktree), "the Task worktree exists");
    const peer = [...agents.values()].find((a) => a.labels.task === "T-CH");
    assert.ok(peer, "the Peer session exists on the daemon");
    peer.status = "idle";

    // 2. The Peer challenges a Brief premise mid-flight (Contract Before Test).
    const peerCorr = correlations.issue({ role: "agent", projectSlug: reg.slug, projectRoot: canonicalRoot, task: "T-CH", agentId: peer.id });
    const challenge = "REOPEN_REQUEST (foundation): the Brief assumes src/legacy-adapter.ts exports buildFacade(); no such module exists on HEAD. Alternative: scout the adapter boundary first, then re-brief.";
    const peerCall = await runMcpSession({
      args: ["--correlation", peerCorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
      cwd: worktree,
      requests: [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_escalate_blocker", arguments: { message: challenge } } },
      ],
    });
    const escalateRes = peerCall[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(escalateRes.isError, true, escalateRes.content[0].text);
    assert.match(escalateRes.content[0].text, /escalated to Lead/i);

    // The Peer session stays alive and paused: still listed, non-archived, never stopped.
    assert.equal(peer.archivedAt, null, "the challenging Peer was never archived");
    assert.equal(archived.includes(peer.id), false, "no archive call ever touched the challenging Peer");
    assert.equal(cancelled.includes(peer.id), false, "no cancel call ever touched the challenging Peer");

    // Exactly one challenge mail item — on the Lead mailbox, kind peer_challenge.
    const mailboxPath = join(stateDir, "projects", reg.slug, "mailbox.jsonl");
    const mailboxState = readLeadMailbox(mailboxPath);
    const leadItems = [...mailboxState.queued, ...(mailboxState.inFlight ? mailboxState.inFlight.items : [])];
    const challengeMail = leadItems.filter((m) => m.from === "peer");
    assert.equal(challengeMail.length, 1, "exactly one peer mail item — the challenge");
    assert.equal(challengeMail[0]?.kind, "peer_challenge");
    assert.equal(challengeMail[0]?.to, "lead");
    assert.equal(challengeMail[0]?.task, "T-CH");
    assert.ok(challengeMail[0]?.text.includes("REOPEN_REQUEST (foundation)"), "the mail carries the challenge text");

    // No Supervisor item and no Supervisor wake.
    const supervisorItems = [...mailboxState.supervisorQueued, ...(mailboxState.supervisorInFlight ? mailboxState.supervisorInFlight.items : [])];
    assert.equal(supervisorItems.length, 0, "no to:supervisor item is enqueued by a Peer challenge");
    assert.equal(sent.filter((p) => p.agentId === supervisor.id).length, 0, "the Supervisor was never pumped or woken by a Peer challenge");

    // No needs_human Ledger event: a challenge is a Lead-reconciliation turn, never a Needs-human fact.
    const ledgerEvents = readFileSync(join(stateDir, "projects", reg.slug, "ledger.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(ledgerEvents.some((e) => e.event === "needs_human"), false, "the epoch's Ledger slice records no needs_human event for the challenge");

    // 3. lead_needs_human still records its needs_human Ledger line — through the
    //    bridge seam — and records it Lead-quietly (no peer mail, no Supervisor wake).
    const projectFactory = registry.factoryForProject(reg.slug);
    projectFactory.ledger.append({
      event: "permit_denied",
      task: "T-CH",
      agent: peer.id,
      name: "Bash",
      kind: "tool",
      command: "git reset --hard",
      rule: "policy:S1-git-vocabulary",
      reason: "caught",
    });
    const spoolRoot = join(stateDir, "spool");
    const repokePath = join(spoolRoot, "requests", "rp-ch.json");
    mkdirSync(join(spoolRoot, "requests"), { recursive: true });
    writeFileSync(repokePath, `${JSON.stringify({ id: "rp-ch", kind: "repoke", task: "T-CH", agent: peer.id })}\n`);
    await new Promise<void>((resolveWait, rejectWait) => {
      const deadline = Date.now() + 5000;
      const tick = () => {
        if (existsSync(join(spoolRoot, "replies", "rp-ch.json"))) resolveWait();
        else if (Date.now() >= deadline) rejectWait(new Error("the repoke evidence request was not answered by the spool"));
        else setTimeout(tick, 25);
      };
      tick();
    });

    const needsHumanCall = await runMcpSession({
      args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
      cwd: repoDir,
      requests: [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_needs_human", arguments: { task: "T-CH", reason: "denied-again" } } },
      ],
    });
    const needsHumanRes = needsHumanCall[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(needsHumanRes.isError, true, needsHumanRes.content[0].text);
    assert.match(needsHumanRes.content[0].text, /denied-again/);
    const ledgerAfter = readFileSync(join(stateDir, "projects", reg.slug, "ledger.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(ledgerAfter.some((e) => e.event === "needs_human"), true, "lead_needs_human still records its needs_human Ledger line");
    const mailboxAfterNeedsHuman = readLeadMailbox(mailboxPath);
    const supervisorItemsAfterNeedsHuman = [...mailboxAfterNeedsHuman.supervisorQueued, ...(mailboxAfterNeedsHuman.supervisorInFlight ? mailboxAfterNeedsHuman.supervisorInFlight.items : [])];
    assert.equal(supervisorItemsAfterNeedsHuman.length, 0, "a Lead-originated needs_human recording wakes no Supervisor mail either");

    // 4. lead_report_to_supervisor still wakes the Supervisor with the structured
    //    question — the one sanctioned writer of to:supervisor mail (User Story 8).
    const reportCall = await runMcpSession({
      args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
      cwd: repoDir,
      requests: [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_report_to_supervisor", arguments: { message: "T-CH is blocked on a foundation premise; ruling needed on the adapter boundary." } } },
      ],
    });
    const reportRes = reportCall[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(reportRes.isError, true, reportRes.content[0].text);
    assert.match(reportRes.content[0].text, /end your turn/i);
    assert.ok(
      sent.some((p) => p.agentId === supervisor.id && p.text.includes("ruling needed on the adapter boundary")),
      "lead_report_to_supervisor still wakes the Supervisor",
    );
    const mailboxAfterReport = readLeadMailbox(mailboxPath);
    const reportItems = [...mailboxAfterReport.supervisorQueued, ...(mailboxAfterReport.supervisorInFlight ? mailboxAfterReport.supervisorInFlight.items : [])].filter((m) => m.from === "lead");
    assert.equal(reportItems.length, 1, "the report lands as the single Lead-written Supervisor item");
    assert.equal(reportItems[0]?.kind, "report");
  } finally {
    spool.stop();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("v0.0.31 (ADR 0017 §6): an offline agent_claim deduplicates through the bridge and spool-timeout instructs stop-and-end-turn, leaving the single request queued", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-offline-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  const spoolRoot = join(stateDir, "spool");
  const correlations = new CorrelationRegistry(stateDir);
  const agentCorr = correlations.issue({
    role: "agent",
    projectSlug: "proj",
    projectRoot: repoDir,
    task: "t-off-1",
    agentId: "agent-off-1",
  });

  // No spool watcher on this home — the plugin process is "stopped". The
  // bridge's wait is tightened through its test seam env so the round trip
  // times out in 1s instead of the 600s default.
  try {
    const responses = await runMcpSession({
      args: ["--correlation", agentCorr.correlationId, "--state-dir", stateDir],
      cwd: repoDir,
      env: { PATH: process.env.PATH, PASEO_FACTORY_SPOOL_WAIT_MS: "1000" },
      requests: [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_claim", arguments: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_claim", arguments: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } } },
      ],
    });

    const requestIdOf = (index: number): string => {
      const result = responses[index].result as { isError?: boolean; content: Array<{ text: string }> };
      assert.equal(result.isError, true, "the timed-out agent_claim is an error result");
      const text = result.content[0].text;
      assert.match(text, /spool-timeout/);
      assert.match(text, /No reply from the factory plugin after 1s/);
      assert.match(text, /remains queued in spool\/requests\//);
      assert.match(text, /DO NOT retry or call this tool again/);
      assert.match(text, /end your turn immediately/);
      const id = /request (\S+) remains queued/.exec(text)?.[1];
      assert.ok(id, "the message names the queued request's id");
      return id;
    };
    const firstId = requestIdOf(0);
    const secondId = requestIdOf(1);
    assert.equal(secondId, firstId, "the retried claim deduplicated onto the one pending request");

    // The single deduplicated request file stays durably queued in spool/requests/.
    const queued = readdirSync(join(spoolRoot, "requests")).filter((name) => name.endsWith(".json"));
    assert.deepEqual(queued, [`${firstId}.json`], "exactly ONE request file remains queued");
    const repliesDir = join(spoolRoot, "replies");
    assert.equal(existsSync(repliesDir) ? readdirSync(repliesDir).length : 0, 0, "no reply was written — the plugin is stopped");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("Lead MCP contracts expose no Fresh-eyes option and never forward legacy opt-ins", async (t) => {
  const repoDir = makeGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "factory-bridge-retired-eye-"));
  t.after(() => { rmSync(repoDir, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); });
  const factory = createFactory({ stateDir, eyeCliProbe: () => true });
  const registration = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(registration.ok);
  // v0.0.92 production parity: the registry routes the contracts onto the
  // Project's isolated ledger; assertions read the Project's Factory.
  const registry = createFactoryRegistry({ stateDir, root: factory });
  const lead = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: registration.ok ? registration.slug : "demo", projectRoot: repoDir, agentId: "lead-1" });
  const spool = startSpool(stateDir, factory, { registry, pollMs: 10 });
  t.after(() => spool.stop());
  const responses = await runMcpSession({
    args: ["--correlation", lead.correlationId, "--state-dir", stateDir], cwd: repoDir,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "DEFAULT", gate: "true", artifact: "README.md", description: brief4("Default no-fresh-eyes contract") } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "LEGACY", gate: "true", artifact: "README.md", freshEyes: true, fresh_eyes: true, description: brief4("Legacy opt-in contract") } } },
    ],
  });
  const tools = (responses[0]!.result as { tools: Array<{ name: string, inputSchema: { properties: Record<string, unknown> } }> }).tools;
  const contract = tools.find((tool) => tool.name === "lead_set_contract")!;
  assert.equal(contract.inputSchema.properties.freshEyes, undefined);
  assert.equal(contract.inputSchema.properties.fresh_eyes, undefined);
  for (const response of responses.slice(1)) {
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true, result.content[0]!.text);
    assert.doesNotMatch(result.content[0]!.text, /fresh eyes ON/);
  }
  const projectFactory = registry.factoryForProject(registration.ok ? registration.slug : "demo");
  assert.equal(projectFactory.contractFor("DEFAULT")?.freshEyes, undefined);
  assert.equal(projectFactory.contractFor("LEGACY")?.freshEyes, undefined);
  assert.equal(existsSync(join(stateDir, "ledger.jsonl")), false, "no root ledger exists");
});

test("lead_set_contract carries disposition and resetPeer end-to-end (ADR 0053): the Lead schema advertises both, disposition rides the Contract and kickoff prompt, and the default re-contract preserves the live Peer while resetPeer archives it", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-disposition-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const registration = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(registration.ok);
  const slug = registration.ok ? registration.slug : "demo";
  const registry = createFactoryRegistry({ stateDir, root: factory });

  // A daemon whose Peer roster starts empty: the dispatched spawn (step 3)
  // creates the live bound Peer the later re-contracts reconcile against —
  // the mid-flight Peer a Lead updates a Brief on (ADR 0053 §1).
  const archived: string[] = [];
  const createdPrompts: string[] = [];
  const liveAgents = new Map<string, { id: string; status: string; archivedAt: string | null; cwd: string; labels: Record<string, string> }>();
  const fakeDaemon = {
    agents: {
      list: async (opts?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean; includeBackground?: boolean } }) => {
        const wanted = opts?.filter?.labels ?? {};
        const includeArchived = opts?.filter?.includeArchived === true;
        const entries = [...liveAgents.values()]
          .filter((a) => (!includeArchived && a.archivedAt !== null ? false : true))
          .filter((a) => Object.entries(wanted).every(([k, v]) => a.labels[k] === v))
          .map((agent) => ({ agent }));
        return { entries };
      },
      create: async (options: { config: { provider: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }) => {
        createdPrompts.push(options.prompt ?? "");
        const id = `peer-created-${createdPrompts.length}`;
        liveAgents.set(id, { id, status: "idle", archivedAt: null, cwd: options.cwd, labels: options.labels });
        return { id };
      },
      ref: (id: string) => ({
        send: async () => ({ messageId: `msg-${id}` }),
        cancel: async () => {},
        archive: async () => {
          archived.push(id);
          const agent = liveAgents.get(id);
          if (agent) liveAgents.set(id, { ...agent, archivedAt: new Date().toISOString() });
          return { archivedAt: new Date().toISOString() };
        },
      }),
    },
  };

  const stopped: string[] = [];
  const spool = startSpool(stateDir, factory, {
    registry,
    pollMs: 10,
    daemon: fakeDaemon as never,
    home: homeDir,
    stopAgent: async (agentId: string) => {
      stopped.push(agentId);
      return { ok: true };
    },
  });
  t.after(() => spool.stop());

  const lead = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: slug, projectRoot: repoDir, agentId: "lead-1" });
  const mcpArgs = ["--correlation", lead.correlationId, "--state-dir", stateDir];
  // Session one: schema, the scout Contract, the spawn, and the default
  // (resetPeer-omitted) reconciliation.
  const responses = await runMcpSession({
    args: mcpArgs,
    cwd: repoDir,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "SCOUT-1", gate: "true", disposition: "scout", description: brief4("Reconnoiter the workspace layout") } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["SCOUT-1"] } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "SCOUT-1", gate: "true", artifact: "README.md", description: brief4("Reconciled brief after the Scout's challenge") } } },
    ],
  });

  // 1. The Lead schema advertises both fields with the exact ADR 0053 vocabulary.
  const byId = new Map(responses.map((r) => [r.id, r]));
  const tools = (byId.get(1)!.result as { tools: Array<{ name: string, inputSchema: { properties: Record<string, unknown> } }> }).tools;
  const contractTool = tools.find((tool) => tool.name === "lead_set_contract")!;
  assert.deepEqual(
    (contractTool.inputSchema.properties.disposition as { enum?: string[] })?.enum,
    ["engineer", "architect", "reviewer", "scout"],
    "the disposition property carries the four-value enum",
  );
  assert.equal((contractTool.inputSchema.properties.resetPeer as { type?: string })?.type, "boolean", "the resetPeer property is a boolean");

  const okText = (id: number): string => {
    const result = byId.get(id)!.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true, result.content[0].text);
    return result.content[0].text;
  };

  // 2. The scout disposition rides the Project's contract_set line (the
  //    ledger is append-only; epochs are asserted per line).
  okText(2);
  const projectFactory = registry.factoryForProject(slug);
  const contractSets = () =>
    readFileSync(join(stateDir, "projects", slug, "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((e) => e.event === "contract_set" && e.task === "SCOUT-1");

  // 3. The dispatched Peer's kickoff prompt names the disposition (the direct-Spool spawn path's promptParts).
  okText(3);
  assert.ok(
    createdPrompts.some((prompt) => /Disposition:\s*scout/i.test(prompt)),
    "the Peer kickoff prompt names the active disposition",
  );

  // 4. Re-contract with resetPeer omitted: the Brief updates in place and the
  //    spawned bound Peer survives — no stop, no archive.
  assert.match(okText(4), /live Peer preserved/i, "the reply names the preserved Peer");
  const spawnedPeerId = "peer-created-1";
  assert.ok(liveAgents.has(spawnedPeerId), "the spawned Peer exists");
  assert.equal(stopped.length, 0, "no Peer was stopped on the default re-contract");
  assert.equal(archived.length, 0, "no Peer was archived on the default re-contract");
  assert.equal(liveAgents.get(spawnedPeerId)?.archivedAt, null, "the bound Peer is still live and non-archived");
  assert.equal(projectFactory.contractFor("SCOUT-1")?.description, brief4("Reconciled brief after the Scout's challenge"));
  assert.equal(projectFactory.contractFor("SCOUT-1")?.disposition, undefined, "the reconciled epoch omits the disposition — it reads as engineer");

  // 5. resetPeer: true (a fresh session) cancels and archives the bound Peer.
  const resetResponses = await runMcpSession({
    args: mcpArgs,
    cwd: repoDir,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "SCOUT-1", gate: "true", artifact: "README.md", description: brief4("Fresh eyes required"), resetPeer: true } } },
    ],
  });
  const resetRes = (resetResponses[0].result as { isError?: boolean; content: Array<{ text: string }> });
  assert.notEqual(resetRes.isError, true, resetRes.content[0].text);
  assert.doesNotMatch(resetRes.content[0].text, /live Peer preserved/i, "the reset reply names no preservation");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  assert.deepEqual(stopped, [spawnedPeerId], "the bound Peer was stopped on resetPeer: true");
  assert.ok(archived.includes(spawnedPeerId), "the bound Peer was archived on resetPeer: true");
  assert.equal(projectFactory.contractFor("SCOUT-1")?.description, brief4("Fresh eyes required"), "the fresh epoch landed");
  assert.equal(contractSets().length, 3, "three Contract epochs landed (scout, reconcile, reset)");
  assert.deepEqual(
    contractSets().map((e) => e.disposition ?? "(omitted)"),
    ["scout", "(omitted)", "(omitted)"],
    "the disposition rides the epochs verbatim",
  );
});

test("lead_repoke_agent with message delivers the Lead's ruling into the live Peer session across reconciliation turns (ticket 02, ADR 0053 Decision 3): the schema advertises message, the delivery carries the task/disposition prefix and the updated Brief, and the message-less cap stays verbatim", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-repoke-message-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const registration = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(registration.ok);
  const slug = registration.ok ? registration.slug : "demo";
  const registry = createFactoryRegistry({ stateDir, root: factory });

  // The live bound Peer the ruling goes to: the dispatched spawn creates it.
  const sentPrompts: Array<{ id: string; text: string }> = [];
  const liveAgents = new Map<string, { id: string; status: string; archivedAt: string | null; cwd: string; labels: Record<string, string> }>();
  const fakeDaemon = {
    agents: {
      list: async (opts?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean; includeBackground?: boolean } }) => {
        const wanted = opts?.filter?.labels ?? {};
        const includeArchived = opts?.filter?.includeArchived === true;
        const entries = [...liveAgents.values()]
          .filter((a) => (!includeArchived && a.archivedAt !== null ? false : true))
          .filter((a) => Object.entries(wanted).every(([k, v]) => a.labels[k] === v))
          .map((agent) => ({ agent }));
        return { entries };
      },
      create: async (options: { config: { provider: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }) => {
        const id = `peer-created-${liveAgents.size + 1}`;
        liveAgents.set(id, { id, status: "idle", archivedAt: null, cwd: options.cwd, labels: options.labels });
        return { id };
      },
      ref: (id: string) => ({
        send: async (text: string) => {
          sentPrompts.push({ id, text });
          return { messageId: `msg-${sentPrompts.length}` };
        },
        cancel: async () => {},
        archive: async () => ({ archivedAt: new Date().toISOString() }),
      }),
    },
  };
  const spool = startSpool(stateDir, factory, {
    registry,
    pollMs: 10,
    daemon: fakeDaemon as never,
    home: homeDir,
  });
  t.after(() => spool.stop());

  const lead = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: slug, projectRoot: repoDir, agentId: "lead-1" });
  const mcpArgs = ["--correlation", lead.correlationId, "--state-dir", stateDir];
  // Session one: the Brief, the live Peer, the in-place reconciliation, and
  // the two message-bearing ruling turns into that same Peer.
  const responses = await runMcpSession({
    args: mcpArgs,
    cwd: repoDir,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "RULING-1", gate: "true", disposition: "architect", description: brief4("Brief v1: design the adapter boundary.") } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["RULING-1"] } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "RULING-1", gate: "true", artifact: "README.md", description: brief4("Brief v2 (reconciled): the facade owns the retry policy.") } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "lead_repoke_agent", arguments: { task: "RULING-1", agent: "peer-created-1", message: "Ruling (REOPEN_REQUEST foundation): the facade owns the retry policy — drop the caller-side backoff." } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "lead_repoke_agent", arguments: { task: "RULING-1", agent: "peer-created-1", message: "Second turn: green the gate on the reconciled Brief." } } },
    ],
  });
  const byId = new Map(responses.map((r) => [r.id, r]));
  const okText = (id: number): string => {
    const result = byId.get(id)!.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true, result.content[0].text);
    return result.content[0].text;
  };

  // 1. The Lead schema advertises the optional message parameter (AC 6).
  const tools = (byId.get(1)!.result as { tools: Array<{ name: string, inputSchema: { properties: Record<string, unknown> } }> }).tools;
  const repokeTool = tools.find((tool) => tool.name === "lead_repoke_agent")!;
  assert.equal((repokeTool.inputSchema.properties.message as { type?: string })?.type, "string", "the message property is a string");

  okText(2); // the Brief
  okText(3); // the live Peer
  okText(4); // the in-place reconciliation
  assert.match(okText(5), /Lead ruling delivered into the live Peer session/, "a daemon-sent ruling claims its delivery");
  assert.match(okText(6), /Lead ruling delivered into the live Peer session/, "ruling turn two — no already-spent");

  // 2. Both ruling turns were delivered into the live Peer session with the
  //    task/disposition prefix and the updated Brief (AC 1, 2, 4).
  const deliveries = sentPrompts.filter((p) => p.id === "peer-created-1");
  assert.equal(deliveries.length, 2, "both reconciliation turns were daemon-sent to the live Peer");
  const first = deliveries[0]?.text ?? "";
  assert.ok(first.includes("Ruling (REOPEN_REQUEST foundation): the facade owns the retry policy — drop the caller-side backoff."), "the delivered text carries the Lead's ruling verbatim");
  assert.ok(first.includes("RULING-1"), "the task context prefixes the ruling");
  assert.ok(first.includes("engineer"), "the reconciled epoch's disposition (engineer default) rides the prefix");
  assert.ok(first.includes("Brief v2 (reconciled): the facade owns the retry policy."), "the updated Brief is named after the lead_set_contract reconciliation");
  assert.ok((deliveries[1]?.text ?? "").includes("Second turn: green the gate on the reconciled Brief."), "the second turn's ruling rode its own delivery");

  // 3. Each turn landed its own dispatch line; the message body never
  //    persisted (the agent stamp remains the line's target).
  const repokeLines = readFileSync(join(stateDir, "projects", slug, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((e) => e.event === "repoke_dispatched" && e.task === "RULING-1");
  assert.equal(repokeLines.length, 2, "each reconciliation turn landed a repoke_dispatched line");
  assert.ok(repokeLines.every((e) => !("message" in e)), "the message body is delivery-only — never persisted on the line");

  // 4. The message-less cap stays verbatim (AC 3): with the spend marker
  //    present, a bare repoke is refused already-spent.
  const bareResponses = await runMcpSession({
    args: mcpArgs,
    cwd: repoDir,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_repoke_agent", arguments: { task: "RULING-1", agent: "peer-created-1" } } },
    ],
  });
  const bare = (bareResponses[0].result as { isError?: boolean; content: Array<{ text: string }> });
  assert.equal(bare.isError, true);
  assert.match(bare.content[0].text, /already-spent/);
  assert.equal(sentPrompts.filter((p) => p.id === "peer-created-1").length, 2, "a refused repoke sends nothing");
});

test("agent_claim carries the mandatory six-field handoff end-to-end (ADR 0053 §4): the schema requires it, a missing field is refused with no Attempt, and a scout claim with no commit walks HEAD to GREEN with the handoff in the report and the Lead's Verdict mail", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-handoff-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.equal(reg.ok, true);
  const registry = createFactoryRegistry({ stateDir, root: factory });

  const liveAgents = new Map<string, { id: string; status: string; archivedAt: string | null; cwd: string; labels: Record<string, string> }>();
  const fakeDaemon = {
    agents: {
      list: async (opts?: { filter?: { labels?: Record<string, string> } }) => {
        const wanted = opts?.filter?.labels ?? {};
        const entries = [...liveAgents.values()]
          .filter((a) => Object.entries(wanted).every(([k, v]) => a.labels[k] === v))
          .map((agent) => ({ agent }));
        return { entries };
      },
      create: async (options: { config: { provider: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }) => {
        const id = `peer-created-${liveAgents.size + 1}`;
        liveAgents.set(id, { id, status: "idle", archivedAt: null, cwd: options.cwd, labels: options.labels });
        return { id };
      },
      ref: (id: string) => ({
        send: async () => ({ messageId: `msg-${id}` }),
        cancel: async () => {},
        archive: async () => {},
      }),
    },
  };

  const mailRuntime = createLeadMailRuntime({
    stateDir,
    factory,
    registry,
    daemon: fakeDaemon as never,
    ensureLead: async () => ({ ok: true, agentId: "lead-1", created: false, projectRoot: repoDir, slug: reg.slug }),
    ensureSupervisor: async () => ({ ok: true, agentId: "sup-1", created: false, projectRoot: repoDir, slug: reg.slug }),
    retireLead: async () => ({ ok: true, agentId: "lead-1" }),
  });
  const spool = startSpool(stateDir, factory, {
    registry,
    pollMs: 25,
    leadDispatch: mailRuntime.dispatchLead,
    supervisorDispatch: mailRuntime.dispatchSupervisor,
    supervisorReport: mailRuntime.reportSupervisor,
    peerMail: mailRuntime.notifyPeer,
    daemon: fakeDaemon as never,
  });
  t.after(() => spool.stop());

  const correlations = new CorrelationRegistry(stateDir);
  const leadCorr = correlations.issue({ role: "lead", projectSlug: reg.slug, projectRoot: repoDir });
  correlations.associate(leadCorr.correlationId, "lead-1");

  // 1. The Lead contracts a read-only scout Task and dispatches its Peer.
  const leadCall = await runMcpSession({
    args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir],
    cwd: repoDir,
    requests: [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "lead_set_contract",
          arguments: { task: "RECON-6F", gate: "/usr/bin/true", disposition: "scout", description: brief4("Map the workspace layout") },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["RECON-6F"] } } },
    ],
  });
  for (const res of leadCall) {
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true, result.content[0].text);
  }
  const worktreePath = registry.factoryForProject(reg.slug).worktreeFor("RECON-6F");
  assert.ok(worktreePath, "the dispatch allocated the Task worktree");

  // 2. The Peer's session: the schema demands the four required handoff fields;
  //    a claim missing `outcome` is refused without opening an Attempt; the
  //    complete handoff with `commit` omitted walks HEAD to GREEN.
  const agentCorr = correlations.issue({ role: "agent", projectSlug: reg.slug, projectRoot: repoDir, task: "RECON-6F" });
  const handoffArgs = { scope: "read README.md, traced src/entries", verification: "gate ran green; no checks skipped", unknowns: "none — layout confirmed against README" };
  const agentCall = await runMcpSession({
    args: ["--correlation", agentCorr.correlationId, "--state-dir", stateDir],
    cwd: worktreePath,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_claim", arguments: handoffArgs } },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "agent_claim", arguments: { ...handoffArgs, outcome: "partial", ownership: "lease returned; findings doc pending" } },
      },
    ],
  });
  const claimTool = (((agentCall[0].result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }> }).tools)
    .find((tool) => tool.name === "agent_claim"))!;
  assert.deepEqual(
    (claimTool.inputSchema.properties.outcome as { enum?: string[] })?.enum,
    ["complete", "partial", "blocked", "reopen"],
    "the outcome property carries the four-value enum",
  );
  assert.equal((claimTool.inputSchema.properties.ownership as { type?: string })?.type, "string", "ownership is the optional fifth property");
  assert.deepEqual(claimTool.inputSchema.required, ["outcome", "scope", "verification", "unknowns"], "the four Peer-authored fields are required");

  const missing = (agentCall[1].result as { isError?: boolean; content: Array<{ text: string }> });
  assert.equal(missing.isError, true, "the handoff-less claim is an error result");
  assert.match(missing.content[0].text, /outcome/, "the refusal names the missing field");

  const claimed = (agentCall[2].result as { isError?: boolean; content: Array<{ text: string }> });
  assert.notEqual(claimed.isError, true, claimed.content[0].text);
  assert.match(claimed.content[0].text, /GREEN/i, "the scout claim with no commit ends GREEN");

  // 3. Exactly one Attempt opened — the refused call appended nothing.
  const ledgerLines = readFileSync(join(stateDir, "projects", reg.slug, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const reconEvents = ledgerLines.filter((e) => e.task === "RECON-6F");
  assert.equal(reconEvents.filter((e) => e.event === "claim_reported").length, 1, "the refused call opened no Attempt");
  assert.equal(reconEvents.filter((e) => e.event === "gate_started").length, 1, "the refused call started no Gate");
  const claimLine = reconEvents.find((e) => e.event === "claim_reported");
  assert.equal(claimLine.handoff.outcome, "partial");
  assert.equal(claimLine.handoff.ownership, "lease returned; findings doc pending", "the explicit ownership rides verbatim");
  assert.equal(claimLine.handoff.unknowns, "none — layout confirmed against README");

  // 4. The report renders the six fields with the Snapshot synthesized from the
  //    attempt's own facts — the attested commit, branch, and Task worktree.
  const reportMatch = /Report: (.+)/.exec(claimed.content[0].text);
  assert.ok(reportMatch, "the reply names the report path");
  const report = readFileSync(reportMatch[1].trim(), "utf8");
  const canonical = [
    "- Outcome: partial",
    "- Snapshot:",
    "- Scope: read README.md, traced src/entries",
    "- Verification: gate ran green; no checks skipped",
    "- Unknown / risk: none — layout confirmed against README",
    "- Ownership: lease returned; findings doc pending",
  ];
  const positions = canonical.map((needle) => report.indexOf(needle));
  assert.ok(positions.every((at) => at !== -1), `all six fields render in the report:\n${report}`);
  assert.ok(positions.every((at, i) => i === 0 || at > positions[i - 1]!), "the six fields render in the canonical order");
  assert.ok(report.includes(worktreePath), "the Snapshot names the Task worktree");

  // 5. The Verdict mail queued to the Lead mailbox carries the handoff verbatim.
  const mailboxState = readLeadMailbox(join(stateDir, "projects", reg.slug, "mailbox.jsonl"));
  const verdict = [...mailboxState.queued, ...(mailboxState.inFlight?.items ?? [])].find((m) => m.kind === "verdict");
  assert.ok(verdict, "the verdict mail is queued");
  const mailText = String(verdict.text ?? "");
  assert.ok(mailText.includes("GREEN"), "the mail names the Gate outcome");
  for (const field of canonical) {
    assert.ok(mailText.includes(field), `the verdict mail carries ${field.split(":")[0]} verbatim`);
  }
});

test("agent_claim on an engineer Task over MCP never forges the mandatory commit (ADR 0053 §4): omitted is refused by the factory's admission with no Attempt, the explicit commit claims GREEN", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-engineer-commit-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.equal(reg.ok, true);
  const registry = createFactoryRegistry({ stateDir, root: factory });

  const liveAgents = new Map<string, { id: string; status: string; archivedAt: string | null; cwd: string; labels: Record<string, string> }>();
  const fakeDaemon = {
    agents: {
      list: async (opts?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean; includeBackground?: boolean } }) => {
        const wanted = opts?.filter?.labels ?? {};
        const entries = [...liveAgents.values()]
          .filter((a) => Object.entries(wanted).every(([k, v]) => a.labels[k] === v))
          .map((agent) => ({ agent }));
        return { entries };
      },
      create: async (options: { config: { provider: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }) => {
        const id = `peer-created-${liveAgents.size + 1}`;
        liveAgents.set(id, { id, status: "idle", archivedAt: null, cwd: options.cwd, labels: options.labels });
        return { id };
      },
      ref: (id: string) => ({
        send: async () => ({ messageId: `msg-${id}` }),
        cancel: async () => {},
        archive: async () => {},
      }),
    },
  };
  const spool = startSpool(stateDir, factory, { registry, pollMs: 25, daemon: fakeDaemon as never });
  t.after(() => spool.stop());

  const correlations = new CorrelationRegistry(stateDir);
  const leadCorr = correlations.issue({ role: "lead", projectSlug: reg.slug, projectRoot: repoDir });
  correlations.associate(leadCorr.correlationId, "lead-1");
  // An engineer Task (the disposition default, stated explicitly here).
  const leadCall = await runMcpSession({
    args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir],
    cwd: repoDir,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "ENG-1", gate: "/usr/bin/true", artifact: "README.md", disposition: "engineer", description: brief4("Land the engineer slice") } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["ENG-1"] } } },
    ],
  });
  for (const res of leadCall) {
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true, result.content[0].text);
  }
  const worktreePath = registry.factoryForProject(reg.slug).worktreeFor("ENG-1");
  assert.ok(worktreePath, "the dispatch allocated the Task worktree");

  const agentCorr = correlations.issue({ role: "agent", projectSlug: reg.slug, projectRoot: repoDir, task: "ENG-1" });
  const handoff = { outcome: "complete", scope: "s", verification: "v", unknowns: "none" };
  // 1. `commit` omitted: the bridge forwards the omission — the factory's
  //    admission refuses the engineer claim; no Attempt opens.
  const refused = await runMcpSession({
    args: ["--correlation", agentCorr.correlationId, "--state-dir", stateDir],
    cwd: worktreePath,
    requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_claim", arguments: handoff } }],
  });
  const refusal = refused[0].result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(refusal.isError, true, "the commit-less engineer claim is an error result");
  assert.match(refusal.content[0].text, /invalid-claim/, "the refusal carries the factory's admission code");
  assert.match(refusal.content[0].text, /mandatory for the engineer disposition/, "the refusal names the engineer commit law");

  // 2. The explicit commit claims GREEN on the same Task.
  const engSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
  const claimed = await runMcpSession({
    args: ["--correlation", agentCorr.correlationId, "--state-dir", stateDir],
    cwd: worktreePath,
    requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_claim", arguments: { ...handoff, commit: engSha } } }],
  });
  const claimRes = claimed[0].result as { isError?: boolean; content: Array<{ text: string }> };
  assert.notEqual(claimRes.isError, true, claimRes.content[0].text);
  assert.match(claimRes.content[0].text, /Verdict: GREEN/);

  // 3. The refused call opened exactly no Attempt; the attested claim opened one.
  const ledgerLines = readFileSync(join(stateDir, "projects", reg.slug, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const engEvents = ledgerLines.filter((e) => e.task === "ENG-1");
  assert.equal(engEvents.filter((e) => e.event === "claim_reported").length, 1, "only the commit-attesting claim opened an Attempt");
  assert.equal(engEvents.filter((e) => e.event === "gate_started").length, 1, "the refused claim started no Gate");
  assert.equal(engEvents.find((e) => e.event === "claim_reported").sha, engSha, "the claim attests the explicit commit");
});

test("lead_verify claims through the bridge with the mechanical marker and no forged handoff (ADR 0053 §4 scope): the report names the Lead's re-run and renders no Peer Outcome", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-lead-verify-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.equal(reg.ok, true);
  const registry = createFactoryRegistry({ stateDir, root: factory });

  const liveAgents = new Map<string, { id: string; status: string; archivedAt: string | null; cwd: string; labels: Record<string, string> }>();
  const fakeDaemon = {
    agents: {
      list: async (opts?: { filter?: { labels?: Record<string, string> } }) => {
        const wanted = opts?.filter?.labels ?? {};
        const entries = [...liveAgents.values()]
          .filter((a) => Object.entries(wanted).every(([k, v]) => a.labels[k] === v))
          .map((agent) => ({ agent }));
        return { entries };
      },
      create: async (options: { config: { provider: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }) => {
        const id = `peer-created-${liveAgents.size + 1}`;
        liveAgents.set(id, { id, status: "idle", archivedAt: null, cwd: options.cwd, labels: options.labels });
        return { id };
      },
      ref: (id: string) => ({
        send: async () => ({ messageId: `msg-${id}` }),
        cancel: async () => {},
        archive: async () => {},
      }),
    },
  };
  const spool = startSpool(stateDir, factory, { registry, pollMs: 25, daemon: fakeDaemon as never });
  t.after(() => spool.stop());

  const correlations = new CorrelationRegistry(stateDir);
  const leadCorr = correlations.issue({ role: "lead", projectSlug: reg.slug, projectRoot: repoDir });
  correlations.associate(leadCorr.correlationId, "lead-1");
  const leadCall = await runMcpSession({
    args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir],
    cwd: repoDir,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "ENG-LV", gate: "/usr/bin/true", artifact: "README.md", description: brief4("Land the lead_verify slice") } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["ENG-LV"] } } },
    ],
  });
  for (const res of leadCall) {
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true, result.content[0].text);
  }
  const worktreePath = registry.factoryForProject(reg.slug).worktreeFor("ENG-LV");
  assert.ok(worktreePath, "the dispatch allocated the Task worktree");

  // The Lead's mechanical re-verification at the worktree HEAD — no commit
  // argument, no handoff: the bridge sends the `lead_verify` marker alone.
  const verifyCall = await runMcpSession({
    args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir],
    cwd: repoDir,
    requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_verify", arguments: { task: "ENG-LV" } } }],
  });
  const verifyRes = verifyCall[0].result as { isError?: boolean; content: Array<{ text: string }> };
  assert.notEqual(verifyRes.isError, true, verifyRes.content[0].text);
  const reply = JSON.parse(verifyRes.content[0].text) as { ok: boolean; verdict?: string; reportPath?: string };
  assert.equal(reply.ok, true);
  assert.equal(reply.verdict, "green");

  const ledgerLines = readFileSync(join(stateDir, "projects", reg.slug, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const claimLine = ledgerLines.find((e) => e.event === "claim_reported" && e.task === "ENG-LV");
  assert.ok(claimLine, "the mechanical claim opened its Attempt");
  assert.equal(claimLine.mechanical, "lead_verify", "the claim line carries the mechanical marker");
  assert.equal(claimLine.handoff, undefined, "no synthetic handoff is forged onto the Lead's re-run");

  const report = readFileSync(String(reply.reportPath), "utf8");
  assert.match(report, /- Lead verification \(`lead_verify`\): mechanical re-run of the Contract Gate by the Lead — no Peer handoff on this claim/);
  assert.doesNotMatch(report, /- Outcome:/, "the report renders no Peer outcome for the mechanical re-run");
  assert.match(report, /- Verdict: GREEN/);
});

test("lead_accept_task on a GREEN read-only Task closes merge-free (ADR 0053 §3): attempt_accepted with no landing, the Peer archived, the Task worktree removed, and <project-root>'s HEAD untouched", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-readonly-accept-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const registration = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(registration.ok);
  const slug = registration.ok ? registration.slug : "demo";
  const registry = createFactoryRegistry({ stateDir, root: factory });

  const archived: string[] = [];
  const liveAgents = new Map<string, { id: string; status: string; archivedAt: string | null; cwd: string; labels: Record<string, string> }>();
  const fakeDaemon = {
    agents: {
      list: async (opts?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean; includeBackground?: boolean } }) => {
        const wanted = opts?.filter?.labels ?? {};
        const entries = [...liveAgents.values()]
          .filter((a) => (opts?.filter?.includeArchived === true ? true : a.archivedAt === null))
          .filter((a) => Object.entries(wanted).every(([k, v]) => a.labels[k] === v))
          .map((agent) => ({ agent }));
        return { entries };
      },
      create: async (options: { config: { provider: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }) => {
        const id = `peer-created-${liveAgents.size + 1}`;
        liveAgents.set(id, { id, status: "idle", archivedAt: null, cwd: options.cwd, labels: options.labels });
        return { id };
      },
      ref: (id: string) => ({
        send: async () => ({ messageId: `msg-${id}` }),
        cancel: async () => {},
        archive: async () => {
          archived.push(id);
          const agent = liveAgents.get(id);
          if (agent) liveAgents.set(id, { ...agent, archivedAt: new Date().toISOString() });
          return { archivedAt: new Date().toISOString() };
        },
      }),
    },
  };
  const spool = startSpool(stateDir, factory, { registry, pollMs: 10, daemon: fakeDaemon as never, home: homeDir });
  t.after(() => spool.stop());

  const correlations = new CorrelationRegistry(stateDir);
  const lead = correlations.issue({ role: "lead", projectSlug: slug, projectRoot: repoDir, agentId: "lead-ro" });
  const headAt = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

  // 1. The Lead contracts the Task read-only (scout) and dispatches its Peer.
  const headBefore = headAt();
  const leadCall = await runMcpSession({
    args: ["--correlation", lead.correlationId, "--state-dir", stateDir],
    cwd: repoDir,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "RO-ACC", gate: "/usr/bin/true", disposition: "scout", description: brief4("Reconnoiter the module boundaries") } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["RO-ACC"] } } },
    ],
  });
  const okText = (response: Record<string, unknown>, context: string): string => {
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true, `${context}: ${result.content[0].text}`);
    return result.content[0].text;
  };
  okText(leadCall[0], "the scout contract");
  okText(leadCall[1], "the scout dispatch");
  const projectFactory = registry.factoryForProject(slug);
  const worktree = projectFactory.worktreeFor("RO-ACC");
  assert.ok(typeof worktree === "string", "the scout dispatch allocated the Task worktree");
  assert.ok(existsSync(worktree), "the Task worktree exists before acceptance");

  // 2. The read-only Peer claims at the worktree HEAD — no new commit, but
  //    with the mandatory 6-Field Handoff (ADR 0053 §4, ticket 04): `commit`
  //    omitted is the read-only Peer's word, the four handoff fields are not.
  const agentCorr = correlations.issue({ role: "agent", projectSlug: slug, projectRoot: repoDir, task: "RO-ACC", agentId: "peer-ro" });
  const agentCall = await runMcpSession({
    args: ["--correlation", agentCorr.correlationId, "--state-dir", stateDir],
    cwd: worktree!,
    requests: [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "agent_claim",
          arguments: {
            outcome: "complete",
            scope: "read README.md and traced the module boundaries from the worktree HEAD",
            verification: "gate ran green at the worktree HEAD; no new commit — read-only disposition",
            unknowns: "none",
          },
        },
      },
    ],
  });
  assert.match(okText(agentCall[0], "the read-only claim"), /GREEN/i, "the read-only claim ends GREEN at the worktree HEAD");

  // 3. Lead acceptance: merge-free. No landing fields, HEAD untouched, the
  //    Peer archived, the Task worktree removed.
  const acceptCall = await runMcpSession({
    args: ["--correlation", lead.correlationId, "--state-dir", stateDir],
    cwd: repoDir,
    requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_merge", arguments: { task: "RO-ACC", attempt: 1 } } }],
  });
  const acceptText = okText(acceptCall[0], "the read-only acceptance");
  assert.match(acceptText, /accepted/i);
  assert.doesNotMatch(acceptText, /landed into <project-root>/, "the reply names no landing");
  const accepted = readFileSync(join(stateDir, "projects", slug, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .findLast((e) => e.event === "attempt_accepted" && e.task === "RO-ACC") as Record<string, unknown> | undefined;
  assert.ok(accepted, "attempt_accepted recorded");
  assert.equal("landing" in (accepted ?? {}), false, "the read-only acceptance carries no landing field");
  assert.equal("landingNote" in (accepted ?? {}), false, "the read-only acceptance carries no landingNote field");
  assert.equal(headAt(), headBefore, "<project-root>'s HEAD is unchanged — no branch merge ran");
  const merges = execFileSync("git", ["log", "--oneline", "--merges", "-3"], { cwd: repoDir, encoding: "utf8" });
  assert.doesNotMatch(merges, /factory\/RO-ACC/, "no factory/RO-ACC merge commit exists");
  await untilBridge(() => assert.equal(existsSync(worktree), false, "the read-only Task worktree is removed"));
  await untilBridge(() => assert.ok(archived.length > 0, "the read-only Task's Peer is archived on acceptance"));
});

/** Bounded retry for the bridge's asynchronous spool effects (file removal, archive). */
async function untilBridge(assertion: () => void, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
}

test("bridge default Spool wait is 600 seconds, including an invalid override", async (t) => {
  const repoDir = makeGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "factory-bridge-wait-"));
  t.after(() => { rmSync(repoDir, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); });
  const clock = join(stateDir, "clock.mjs");
  // Advance wall time at the process boundary; exercise the real timeout response without a ten-minute wait.
  writeFileSync(clock, "let now = Date.now(); Date.now = () => (now += 601_000);\n");
  const agent = new CorrelationRegistry(stateDir).issue({ role: "agent", projectSlug: "demo", projectRoot: repoDir, task: "WAIT", agentId: "agent-1" });
  for (const override of ["", "invalid"]) {
    const responses = await runMcpSession({
      args: ["--correlation", agent.correlationId, "--state-dir", stateDir], cwd: repoDir,
      env: { ...process.env, NODE_OPTIONS: `--import=${clock}`, PASEO_FACTORY_SPOOL_WAIT_MS: override },
      requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_claim", arguments: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } } }],
    });
    const result = responses[0]!.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /No reply from the factory plugin after 600s/);
  }
});

test("bridge Task allocation inherits root dependencies and keeps them clean", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-deps-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  writeFileSync(join(repoDir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repoDir, ".worktreeinclude"), "runtime/**/*.json\n.env.local\n");
  execFileSync("git", ["add", ".gitignore", ".worktreeinclude"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "ignore installed dependencies"], { cwd: repoDir });
  const rootDependencies = join(repoDir, "node_modules");
  mkdirSync(rootDependencies);
  writeFileSync(join(rootDependencies, "root-package"), "root install\n");
  mkdirSync(join(repoDir, "runtime/deep"), { recursive: true });
  writeFileSync(join(repoDir, "runtime/config.json"), "selected at root\n");
  writeFileSync(join(repoDir, "runtime/deep/config.json"), "selected nested\n");
  writeFileSync(join(repoDir, ".env.local"), "selected env\n");
  writeFileSync(join(repoDir, "private.txt"), "unselected private content\n");
  writeFileSync(join(repoDir, "runtime/private.txt"), "unselected nested private content\n");
  const copiedBridge = join(homeDir, "bridge.mjs");
  copyFileSync(BRIDGE_BIN, copiedBridge);
  copyFileSync(resolve(import.meta.dirname, "../plugin/bin/ledger-project.mjs"), join(homeDir, "ledger-project.mjs"));
  const commonExclude = readFileSync(join(repoDir, ".git", "info", "exclude"), "utf8");
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.equal(reg.ok, true);
  // v0.0.92 production parity: the Contract lives in the Project's isolated
  // ledger (ADR 0045 §1), and the Spool routes through the registry.
  const registry = createFactoryRegistry({ stateDir, root: factory });
  registry.factoryForProject(reg.slug).setContract({ task: "deps", workspace: repoDir, gate: "true", artifact: "README.md", scope: ["README.md"] });
  const correlation = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: reg.slug, projectRoot: repoDir });
  const spool = startSpool(stateDir, factory, { registry, pollMs: 25 });
  const spawnTask = async () => {
    const responses = await runMcpSession({
      script: copiedBridge,
      args: ["--correlation", correlation.correlationId, "--state-dir", stateDir, "--home", homeDir],
      cwd: repoDir,
      requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["deps"] } } }],
    });
    const result = responses[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true, result.content[0].text);
    const worktree = registry.factoryForProject(reg.slug).worktreeFor("deps");
    assert.ok(worktree);
    return worktree;
  };
  try {
    const worktree = await spawnTask();
    assert.equal(existsSync(join(worktree, "private.txt")), false);
    assert.equal(existsSync(join(worktree, "runtime/private.txt")), false);
    assert.equal(readFileSync(join(worktree, "runtime/config.json"), "utf8"), "selected at root\n");
    assert.equal(readFileSync(join(worktree, "runtime/deep/config.json"), "utf8"), "selected nested\n");
    assert.equal(readFileSync(join(worktree, ".env.local"), "utf8"), "selected env\n");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" }).trim(), "");
    const inherited = join(worktree, "node_modules");
    assert.equal(lstatSync(inherited).isSymbolicLink(), true);
    assert.equal(realpathSync(inherited), realpathSync(rootDependencies));
    assert.equal(readFileSync(join(inherited, "root-package"), "utf8"), "root install\n");
    // A resumed task keeps its commits and gains dependencies if the previous
    // allocation predated the root install (or its inherited link was removed).
    writeFileSync(join(worktree, "README.md"), "# task progress\n");
    execFileSync("git", ["add", "README.md"], { cwd: worktree });
    execFileSync("git", ["commit", "-m", "task progress"], { cwd: worktree });
    const taskHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
    unlinkSync(inherited);
    assert.equal(await spawnTask(), worktree);
    assert.equal(lstatSync(inherited).isSymbolicLink(), true, "reuse also inherits missing dependencies");
    assert.equal(realpathSync(inherited), realpathSync(rootDependencies));
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(), taskHead);
    unlinkSync(inherited);
    mkdirSync(inherited);
    writeFileSync(join(inherited, "task-package"), "task installation\n");
    await spawnTask();
    assert.equal(lstatSync(inherited).isDirectory(), true, "reuse preserves a real task installation");
    assert.equal(readFileSync(join(inherited, "task-package"), "utf8"), "task installation\n");
    assert.equal(existsSync(join(inherited, "root-package")), false, "root packages do not overwrite task dependencies");

    rmSync(inherited, { recursive: true });
    const alternate = join(homeDir, "alternate-dependencies");
    mkdirSync(alternate);
    symlinkSync(alternate, inherited, "dir");
    await spawnTask();
    assert.equal(realpathSync(inherited), realpathSync(alternate), "reuse preserves an existing dependency link");
    rmSync(alternate, { recursive: true });
    await spawnTask();
    assert.equal(readlinkSync(inherited), alternate, "a dangling existing link is not replaced either");
    assert.equal(readFileSync(join(rootDependencies, "root-package"), "utf8"), "root install\n");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" }).trim(), "");
    assert.equal(readFileSync(join(repoDir, ".git", "info", "exclude"), "utf8"), commonExclude);
    assert.equal(readFileSync(join(repoDir, ".gitignore"), "utf8"), "node_modules/\n");
  } finally {
    spool.stop();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("MCP Lead acceptance binds its authenticated role despite forged attribution arguments", async (t) => {
  const repoDir = makeGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "factory-mcp-auth-"));
  t.after(() => { rmSync(repoDir, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(reg.ok);
  const factory = createFactory({ stateDir });
  // v0.0.92 production parity: the seeded history and the acceptance land in
  // the Project's isolated ledger through the registry-routed Spool.
  const factoryRegistry = createFactoryRegistry({ stateDir, root: factory });
  const projectFactory = factoryRegistry.factoryForProject(reg.slug);
  projectFactory.setContract({ task: "mcp-bound", workspace: repoDir, gate: "true", artifact: "README.md" });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  await projectFactory.claim({ task: "mcp-bound", sha, handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } });
  projectFactory.ledger.append({ event: "fresh_eyes_written", task: "mcp-bound", attempt: 1, model: "eye", outcome: "concern", finding: "Owner decision needed", durationMs: 1 });
  const denial = projectFactory.ledger.append({ event: "permit_denied", task: "mcp-bound", agent: "peer", name: "Bash", kind: "tool", rule: "scope", reason: "denied" });
  const poke = projectFactory.ledger.append({ event: "repoke_dispatched", task: "mcp-bound", agent: "peer" });
  projectFactory.ledger.append({ event: "needs_human", task: "mcp-bound", reason: "denied-again", evidence: { denial: denial.seq, repoke: poke.seq } });
  const registry = new CorrelationRegistry(stateDir);
  const lead = registry.issue({ role: "lead", projectSlug: reg.slug, projectRoot: repoDir, agentId: "mcp-lead" });
  const supervisor = registry.issue({ role: "supervisor", projectSlug: reg.slug, projectRoot: repoDir, agentId: "mcp-supervisor" });
  const spool = startSpool(stateDir, factory, { registry: factoryRegistry, pollMs: 10 });
  t.after(() => spool.stop());
  const refused = await runMcpSession({
    args: ["--correlation", lead.correlationId, "--state-dir", stateDir], cwd: repoDir,
    requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_merge", arguments: { task: "mcp-bound", attempt: 1, by: "owner", submitter: "owner" } } }],
  });
  const denied = refused[0]!.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(denied.isError, true);
  assert.match(denied.content[0]!.text, /lead-accept-refused/);
  assert.equal(projectFactory.ledger.eventsFor("mcp-bound").some((event) => event.event === "attempt_accepted"), false);
  const allowed = await runMcpSession({
    args: ["--correlation", supervisor.correlationId, "--state-dir", stateDir], cwd: repoDir,
    requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "supervisor_accept_task", arguments: { task: "mcp-bound", attempt: 1 } } }],
  });
  const accepted = allowed[0]!.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.notEqual(accepted.isError, true);
  const acceptance = projectFactory.ledger.eventsFor("mcp-bound").find(event => event.event === "attempt_accepted");
  assert.equal(acceptance?.accepted_by, "supervisor");
  assert.equal(existsSync(join(stateDir, "ledger.jsonl")), false, "no root ledger exists");
});

test("bridge lead_dispatch_agent resolves real system git and ignores a broken <stateDir>/bin/git shim on PATH", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-realgit-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  // Put a broken <stateDir>/bin/git first on PATH (simulating a stale/broken git shim)
  const brokenBinDir = join(stateDir, "bin");
  mkdirSync(brokenBinDir, { recursive: true });
  writeFileSync(
    join(brokenBinDir, "git"),
    "#!/bin/sh\necho \"Error: Cannot find module '/deleted/git-shim.mjs'\" >&2\nexit 1\n",
    { mode: 0o755 },
  );

  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.equal(reg.ok, true);
  // v0.0.92 production parity: the Contract lives in the Project's isolated
  // ledger, the Spool routes through the registry, and the worktree registers
  // on the Project's Factory (ADR 0045 §1).
  const registry = createFactoryRegistry({ stateDir, root: factory });
  registry.factoryForProject(reg.slug).setContract({
    task: "T-01",
    workspace: repoDir,
    gate: "/usr/bin/true",
    artifact: "README.md",
  });
  const leadCorr = new CorrelationRegistry(stateDir).issue({
    role: "lead",
    projectSlug: reg.slug,
    projectRoot: repoDir,
    agentId: "lead-realgit-1",
  });
  const spool = startSpool(stateDir, factory, { registry, pollMs: 20 });
  t.after(() => spool.stop());

  const responses = await runMcpSession({
    args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
    cwd: repoDir,
    env: {
      PATH: `${brokenBinDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      PASEO_FACTORY_STATE_DIR: stateDir,
      PASEO_FACTORY_SEAT: "lead",
    },
    requests: [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "lead_dispatch_agent",
          arguments: { tasks: ["T-01"], workspace: repoDir },
        },
      },
    ],
  });

  const spawnRes = responses[0]!.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.notEqual(spawnRes.isError, true, `Expected lead_dispatch_agent to succeed even with broken <stateDir>/bin/git, got: ${spawnRes.content[0]?.text}`);
  const worktree = registry.factoryForProject(reg.slug).worktreeFor("T-01");
  assert.ok(worktree && existsSync(worktree), "Task worktree was allocated using real system git");
});

test("background MCP spawn reports the dispatched specialist lane", async t => {
  const home = mkdtempSync(join(tmpdir(), "factory-bridge-background-"));
  const stateDir = join(home, "plugin-state", "paseo-factory"), repo = makeGitRepo();
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const project = ensureProjectRegistered(stateDir, repo);
  assert.ok(project.ok); if (!project.ok) return;
  // v0.0.92 production parity: the Contract lives in the Project's isolated
  // ledger and the fake external Driver publishes its dispatch THERE (ADR 0045 §1).
  const registry = createFactoryRegistry({ stateDir, root: factory });
  registry.factoryForProject(project.slug).setContract({ task: "specialist", workspace: repo, gate: "true" });
  const correlation = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: project.slug, projectRoot: repo, agentId: "lead-fixture" });
  const bin = join(home, "fixture-bin"); mkdirSync(bin);
  copyFileSync(BRIDGE_BIN, join(bin, "bridge.mjs"));
  copyFileSync(resolve(import.meta.dirname, "../plugin/bin/ledger-project.mjs"), join(bin, "ledger-project.mjs"));
  writeFileSync(join(home, "endpoint.sock"), "fixture presence marker");
  // The external Driver boundary publishes its actual dispatch, which differs from the configured SLP worker.
  const projectLedger = join(stateDir, "projects", project.slug, "ledger.jsonl");
  writeFileSync(join(bin, "factory.mjs"), `import { appendFileSync, mkdirSync } from 'node:fs';\nmkdirSync(${JSON.stringify(join(stateDir, "projects", project.slug))}, { recursive: true });\nappendFileSync(${JSON.stringify(projectLedger)}, JSON.stringify({ seq: 2, ts: new Date().toISOString(), event: 'spawn_dispatched', task: 'specialist', provider: 'claude/pm-frozen', arity: 1 }) + '\\n');\n`);
  const responses = await runMcpSession({ script: join(bin, "bridge.mjs"), cwd: repo, args: ["--home", home, "--state-dir", stateDir, "--correlation", correlation.correlationId], requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["specialist"] } } }] });
  assert.ok(responses[0].result, JSON.stringify(responses));
  const result = responses[0].result as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.match(result.content[0].text, /under claude\/pm-frozen/);
});

test("Scrum MCP spawn defaults to the task's frozen specialist roster", async t => {
  const home = mkdtempSync(join(tmpdir(), "factory-bridge-scrum-"));
  const stateDir = join(home, "plugin-state", "paseo-factory"), repo = makeGitRepo();
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });
  const { switchExecution } = await import("../plugin/server/core/scrum/execution.ts");
  const { ensureScrumConfig, saveScrumConfig } = await import("../plugin/server/core/scrum/config.ts");
  const { createScrumRun } = await import("../plugin/server/core/scrum/run-journal.ts");
  const { handleSpoolRequest } = await import("../plugin/server/spool.ts");
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const project = ensureProjectRegistered(stateDir, repo); assert.ok(project.ok); if (!project.ok) return;
  await switchExecution({ state: stateDir, slug: project.slug, mode: "scrum", blockers: [], rotate: async () => {} });
  const seed = ensureScrumConfig(stateDir, project.slug);
  const config = saveScrumConfig(stateDir, { ...seed, lanes: { ...seed.lanes, pm: "claude/pm-frozen" } }, project.slug);
  createScrumRun({ state: stateDir, slug: project.slug, runId: "r", initiativeId: "mcp", config, configRevision: config.configRevision!, track: "backend", rationale: "API", requestId: "create", ownedPaths: [".scratch/mcp/prd.md", ".scratch/mcp/decisions/plan.jsonl"] });
  // v0.0.92 production parity: the registry routes the contract and the spawn
  // onto the Project's isolated ledger; the assertion reads the Project's Factory.
  const factoryRegistry = createFactoryRegistry({ stateDir, root: factory });
  const contract = await handleSpoolRequest(factory, { id: "contract", kind: "contract", task: "plan", workspace: repo, gate: "true", role: "pm", runId: "r", submitter: "owner" }, {}, factoryRegistry);
  assert.ok(contract.ok, JSON.stringify(contract));
  const correlation = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: project.slug, projectRoot: repo, agentId: "scrum-lead" });
  const spool = startSpool(stateDir, factory, { registry: factoryRegistry, pollMs: 20 }); t.after(() => spool.stop());
  const responses = await runMcpSession({ cwd: repo, args: ["--home", home, "--state-dir", stateDir, "--correlation", correlation.correlationId], requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["plan"] } } }] });
  assert.ok(responses[0].result, JSON.stringify(responses));
  const result = responses[0].result as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.match(result.content[0].text, /claude\/pm-frozen/);
  assert.equal(factoryRegistry.factoryForProject(project.slug).ledger.events.findLast(e => e.event === "spawn_dispatched")?.provider, "claude/pm-frozen");
  assert.equal(existsSync(join(stateDir, "ledger.jsonl")), false, "no root ledger exists");
});

test("mode-scoped MCP catalogs isolate schemas and reject cross-mode calls", async () => {
  const state = mkdtempSync(join(tmpdir(), "bridge-modes-"));
  try {
    for (const role of ["supervisor", "lead"]) {
      for (const mode of ["slp", "scrum"]) {
        const onlyScrum = role === "lead" ? "lead_scrum_operation" : "supervisor_scrum_decision";
        const responses = await runMcpSession({ args: ["--state-dir", state, "--role", role, "--mode", mode], requests: [
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          ...(mode === "slp" ? [{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: onlyScrum, arguments: {} } }] : []),
        ] });
        const tools = (responses[0].result as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools;
        assert.equal(tools.some(t => t.name === onlyScrum), mode === "scrum");
        const properties = tools.find(t => t.name === (role === "lead" ? "lead_set_contract" : "supervisor_dispatch_lead"))!.inputSchema.properties;
        assert.equal("runId" in properties, mode === "scrum");
        if (role === "lead") {
          assert.ok("scope" in properties);
          assert.equal("role" in properties, mode === "scrum");
          assert.equal("artifactRefs" in properties, mode === "scrum");
          assert.equal("mutationMode" in properties, mode === "slp");
        }
        if (mode === "slp") {
          assert.equal((responses[1].result as { isError: boolean }).isError, true);
          assert.match(JSON.stringify(responses[1]), /in mode/);
        }
      }
    }
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("Scrum MCP decisions default the active design identity and keep Lead unable to approve", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "scrum-mcp-decision-")), repo = makeGitRepo();
  t.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });
  const { switchExecution } = await import("../plugin/server/core/scrum/execution.ts");
  const { ensureScrumConfig } = await import("../plugin/server/core/scrum/config.ts");
  const { createScrumRun, commandRun, readRun } = await import("../plugin/server/core/scrum/run-journal.ts");
  const { artifactAt, designDigest } = await import("../plugin/server/core/scrum/artifacts.ts");
  const { scrumOperation } = await import("../plugin/server/core/scrum/controller.ts");
  const project = ensureProjectRegistered(stateDir, repo); assert.ok(project.ok);
  await switchExecution({ state: stateDir, slug: project.slug, mode: "scrum", blockers: [], rotate: async () => {} });
  const { openDesignBundle } = await import('./fixtures/open-design.ts');
  const bundle = openDesignBundle('.scratch/review/');
  bundle['mockups/index.html'] = String(bundle['mockups/index.html']).replace('Shop', 'Farm');
  const paths = Object.keys(bundle).map(path => '.scratch/review/' + path);
  for (const [path, bytes] of Object.entries(bundle)) {
    mkdirSync(join(repo, '.scratch/review', path, '..'), {recursive:true});
    writeFileSync(join(repo, '.scratch/review', path), bytes);
  }
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["commit", "-m", "design fixture"], { cwd: repo });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const refs = paths.filter(path=>!path.endsWith("browser.json")).map(path => artifactAt(repo, sha, path));
  let run = createScrumRun({ state: stateDir, slug: project.slug, runId: "review", initiativeId: "review", config: ensureScrumConfig(stateDir, project.slug), configRevision: 1, track: "ui", rationale: "fixture", ownedPaths: paths, requestId: "create" });
  run = commandRun(stateDir, project.slug, run.runId, { type: "design_review_requested", requestId: "design", expectedRevision: run.revision, design: { revision: 1, digest: designDigest(refs), refs, browserEvidence: [artifactAt(repo, sha, ".scratch/review/mockups/browser.json")] } });
  const factory = createFactory({ stateDir });
  // v0.0.92 production parity: the registry routes every Scrum command onto the
  // Project's isolated ledger — the scrumCommand handler receives the Project's Factory.
  const factoryRegistry = createFactoryRegistry({ stateDir, root: factory });
  const registry = new CorrelationRegistry(stateDir);
  const supervisor = registry.issue({ role: "supervisor", projectSlug: project.slug, projectRoot: repo });
  const lead = registry.issue({ role: "lead", projectSlug: project.slug, projectRoot: repo });
  const spool = startSpool(stateDir, factory, { registry: factoryRegistry, pollMs: 10, scrumCommand: async (request, caller) => ({ id: request.id, ok: true, summary: "Scrum", data: await scrumOperation(request, { factory: factoryRegistry.factoryForProject(project.slug), root: repo, slug: project.slug, ...caller, activeAgents: [], pendingDirectives: false }) }) });
  t.after(() => spool.stop());
  const call = async (correlation: string, name: string, args: Record<string, unknown>) => (await runMcpSession({ args: ["--state-dir", stateDir, "--correlation", correlation], cwd: repo, requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }] }))[0].result as { isError?: boolean; content: { text: string }[] };
  assert.equal((await call(lead.correlationId, "supervisor_scrum_decision", { decision: "approved", rationale: "spoof" })).isError, true);
  const approved = await call(supervisor.correlationId, "supervisor_scrum_decision", { decision: "approved", rationale: "Owner approved this preview" });
  assert.notEqual(approved.isError, true, JSON.stringify(approved));
  assert.equal(readRun(stateDir, project.slug, run.runId).design?.decision, "approved");
  assert.equal(readRun(stateDir, project.slug, run.runId).design?.decidedBy, "owner");
  const snapshot = await call(lead.correlationId, "lead_scrum_operation", { action: "get" }); assert.notEqual(snapshot.isError, true);
  const preview = await call(lead.correlationId, "lead_scrum_operation", { action: "preview", subpath: "mockups/index.html", port: 0 }); assert.notEqual(preview.isError, true, JSON.stringify(preview));
  const previewUrl = JSON.parse(preview.content[0].text).data.url;
  assert.match(previewUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]{64}$/);
  const mockupUrl = new URL(previewUrl); mockupUrl.pathname='/mockup';
  assert.match(await (await fetch(mockupUrl)).text(), /Farm/);
  const reserve = await call(lead.correlationId, "lead_scrum_operation", { action: "fix.reserve", task: "farm-fix" }); assert.notEqual(reserve.isError, true, JSON.stringify(reserve));
  assert.equal(readRun(stateDir, project.slug, run.runId).fixRounds, 1);
});

test("v0.0.93 quiet-point regression: Lead dispatches a Peer then crosses 128k — the rotation holds in rotation_pending (outgoing Lead live, Peer untouched, no successor) until the Peer's verdict pump begins the handoff and the Successor Lead receives Turn 1 immediately", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-handoff-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.equal(reg.ok, true);
  const registry = createFactoryRegistry({ stateDir, root: factory });

  interface FakeAgentShape {
    id: string;
    status: string;
    archivedAt: string | null;
    cwd: string;
    labels: Record<string, string>;
    lastUsage?: { contextWindowUsedTokens: number };
    lastUserMessageAt?: string | null;
  }
  const agents = new Map<string, FakeAgentShape>();
  const sent: Array<{ agentId: string; text: string }> = [];
  const workspaceDirs = new Map<string, string>();
  let createdSeq = 0;
  const registerAgent = (agent: FakeAgentShape) => agents.set(agent.id, agent) && agent;

  const lead: FakeAgentShape = {
    id: "lead-kick-1",
    status: "idle",
    archivedAt: null,
    cwd: repoDir,
    labels: { seat: "lead", project: reg.slug },
    lastUsage: { contextWindowUsedTokens: 128_500 },
  };
  registerAgent(lead);
  const supervisor: FakeAgentShape = { id: "sup-kick-1", status: "idle", archivedAt: null, cwd: repoDir, labels: { seat: "supervisor", project: reg.slug } };
  registerAgent(supervisor);

  const createAgentIn = (workspaceId: string | undefined, input: { labels?: Record<string, string>; cwd?: string; parent?: string }): string => {
    createdSeq += 1;
    const id = `agent-created-${createdSeq}`;
    const wsCwd = workspaceId !== undefined ? workspaceDirs.get(workspaceId) : undefined;
    registerAgent({
      id,
      status: "idle",
      archivedAt: null,
      cwd: wsCwd ?? input.cwd ?? repoDir,
      labels: { ...(input.labels ?? {}) },
      ...(input.parent !== undefined && agents.has(input.parent) ? {} : {}),
      lastUserMessageAt: null,
    });
    return id;
  };

  const fakeDaemon = {
    agents: {
      list: async (opts?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean; includeBackground?: boolean } }) => {
        const wanted = opts?.filter?.labels ?? {};
        const entries = [...agents.values()]
          .filter((a) => Object.entries(wanted).every(([k, v]) => a.labels[k] === v))
          .map((agent) => ({ agent }));
        return { entries };
      },
      ref: (id: string) => ({
        send: async (text: string) => {
          sent.push({ agentId: id, text });
          return { messageId: `msg-${sent.length}` };
        },
        cancel: async () => {},
        archive: async () => {
          const agent = agents.get(id);
          if (agent !== undefined) agent.archivedAt = new Date().toISOString();
        },
      }),
    },
    workspaces: {
      open: async () => ({ id: "project-workspace-main", projectId: "paseo-project-1" }),
      create: async (input: { source: { path: string } }) => {
        const id = `task-workspace-${workspaceDirs.size + 1}`;
        workspaceDirs.set(id, input.source.path);
        return { id };
      },
      ref: (id: string) => ({ agents: { create: async (input: { labels?: Record<string, string>; parent?: string }) => ({ id: createAgentIn(id, input) }) } }),
    },
  };

  let leadRetired = false;
  const mailRuntime = createLeadMailRuntime({
    stateDir,
    factory,
    registry,
    daemon: fakeDaemon as never,
    ensureLead: async () =>
      leadRetired
        ? { ok: true, agentId: createAgentIn(undefined, { cwd: repoDir, labels: { seat: "lead", project: reg.slug } }), created: true, projectRoot: repoDir, slug: reg.slug }
        : { ok: true, agentId: lead.id, created: false, projectRoot: repoDir, slug: reg.slug },
    ensureSupervisor: async () => ({ ok: true, agentId: supervisor.id, created: false, projectRoot: repoDir, slug: reg.slug }),
    retireLead: async () => {
      leadRetired = true;
      lead.archivedAt = new Date().toISOString();
      return { ok: true, agentId: lead.id };
    },
  });

  const spool = startSpool(stateDir, factory, {
    registry,
    pollMs: 25,
    leadDispatch: mailRuntime.dispatchLead,
    supervisorDispatch: mailRuntime.dispatchSupervisor,
    supervisorReport: mailRuntime.reportSupervisor,
    peerMail: mailRuntime.notifyPeer,
    daemon: fakeDaemon as never,
  });

  try {
    // The rotation state machine keys on the REGISTERED Lead seat — the
    // seating act surface.leadEnsure performs in production. The root must be
    // the CANONICAL git root (`resolveProject`'s realpath), the same value the
    // registration and every workspace comparison key on.
    const canonicalRoot = reg.ok ? reg.root : repoDir;
    writeProjectRegistration(stateDir, reg.slug, { root: canonicalRoot, lead: lead.id, supervisor: supervisor.id });
    const correlations = new CorrelationRegistry(stateDir);
    const leadCorr = correlations.issue({ role: "lead", projectSlug: reg.slug, projectRoot: canonicalRoot });
    correlations.associate(leadCorr.correlationId, lead.id);

    // 1. Lead contracts and dispatches the Peer through the bridge — the
    //    direct Spool path (no daemon socket), production registry wiring.
    const leadCall = await runMcpSession({
      args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
      cwd: repoDir,
      requests: [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "T-KICK", gate: "/usr/bin/true", artifact: "README.md", scope: ["README.md"], description: brief4("Land the kickoff slice") } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["T-KICK"] } } },
      ],
    });
    const contractRes = leadCall[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(contractRes.isError, true, contractRes.content[0].text);
    const spawnRes = leadCall[1].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(spawnRes.isError, true, spawnRes.content[0].text);
    assert.match(spawnRes.content[0].text, /worktree: /);

    const worktree = join(stateDir, "projects", reg.slug, "worktrees", "T-KICK");
    assert.ok(existsSync(worktree), "the Task worktree exists");
    assert.equal(existsSync(join(stateDir, "ledger.jsonl")), false, "no root ledger exists anywhere");
    const projectFactory = registry.factoryForProject(reg.slug);
    const peerAgentId = projectFactory.ledger.eventsFor("T-KICK").findLast((e) => e.event === "spawn_dispatched");
    assert.ok(peerAgentId, "the spawn round is recorded");
    const peer = [...agents.values()].find((a) => a.labels.task === "T-KICK");
    assert.ok(peer, "the Peer agent was created in the Task workspace");
    assert.equal(peer.cwd, worktree, "the Peer's cwd is the isolated Task worktree, never <project-root>");
    peer.status = "running";

    // 2. The Lead finishes its dispatch turn already past LEAD_ROTATE_TOKENS
    //    while the Peer runs: the rotation is held in rotation_pending — the
    //    outgoing Lead stays the live seat, no extraction prompt is sent, and
    //    no successor exists (the blank 0-message window never happens).
    await mailRuntime.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
    assert.equal(readProjectRegistration(stateDir, reg.slug)?.rotationState, "rotation_pending");
    assert.equal(lead.archivedAt, null, "the outgoing Lead was NOT archived while the Peer runs");
    assert.equal(peer.archivedAt, null, "the running Peer was NOT cascade-archived");
    assert.equal(peer.status, "running", "the Peer keeps running in its Task worktree");
    assert.equal(readProjectRegistration(stateDir, reg.slug)?.lead, lead.id, "the outgoing Lead remains the registered seat");
    assert.equal([...agents.values()].some((a) => a.labels.seat === "lead" && a.id !== lead.id), false, "no Successor Lead exists yet");
    assert.equal(sent.length, 0, "no prompt of any kind was sent while the Peer runs");

    // 3. v0.0.99 (ADR 0031 §1-§3): while the Peer is STILL RUNNING inside its
    //    active turn (`peer.status === "running"`), it calls `agent_claim` over
    //    MCP. Verify that:
    //    (a) `tools/list` advertises `_meta: { timeoutMs: 600000 }` on `agent_claim`
    //        so ZCode does not abort long Gates at 30s;
    //    (b) `notifyPeer` sees `task.status === "ready-to-accept"` in the Ledger
    //        and transitions `rotation_pending -> handing_over` IMMEDIATELY while
    //        `peer.status === "running"` (without waiting for `peer.status = "idle"`);
    //    (c) an idempotent second `agent_claim` on the same SHA returns GREEN
    //        without queuing a duplicate verdict mail item in `mailbox.jsonl`.
    const peerCorr = correlations.issue({ role: "agent", projectSlug: reg.slug, projectRoot: canonicalRoot, task: "T-KICK", agentId: peer.id });
    // The engineer disposition's mandatory attestation (ADR 0053 §4): the Peer
    // names its exact commit; the bridge never defaults it on this path.
    const kickSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
    const peerMcpCall = await runMcpSession({
      args: ["--correlation", peerCorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
      cwd: worktree,
      requests: [
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_claim", arguments: { task: "T-KICK", commit: kickSha, outcome: "complete", scope: "s", verification: "v", unknowns: "n" } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_claim", arguments: { task: "T-KICK", commit: kickSha, outcome: "complete", scope: "s", verification: "v", unknowns: "n" } } },
      ],
    });
    const peerTools = (peerMcpCall[0].result as { tools: Array<{ name: string; _meta?: { timeoutMs?: number } }> }).tools;
    const claimTool = peerTools.find((t) => t.name === "agent_claim");
    assert.deepEqual(claimTool?._meta, { timeoutMs: 600_000 }, "agent_claim must advertise _meta.timeoutMs = 600000 for ZCode");
    const firstClaim = peerMcpCall[1].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(firstClaim.isError, true, firstClaim.content[0].text);
    assert.match(firstClaim.content[0].text, /Verdict: GREEN/);
    const replayClaim = peerMcpCall[2].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(replayClaim.isError, true, replayClaim.content[0].text);
    assert.match(replayClaim.content[0].text, /Verdict: GREEN/);

    const queuedBeforeHandoffComplete = readLeadMailbox(join(stateDir, "projects", reg.slug, "mailbox.jsonl")).queued;
    assert.equal(queuedBeforeHandoffComplete.filter((m) => m.kind === "verdict" && m.task === "T-KICK").length, 1, "idempotent claim replay must not enqueue duplicate verdict mail");
    assert.equal(peer.status, "running", "the Peer turn is still active when rotation_pending transitions to handing_over");
    assert.equal(readProjectRegistration(stateDir, reg.slug)?.rotationState, "handing_over");
    const extractionSends = sent.filter((s) => s.agentId === lead.id);
    assert.equal(extractionSends.length, 1, "the extraction prompt reached the outgoing Lead as soon as the Ledger recorded GREEN, even while Peer is running");
    assert.match(extractionSends[0].text, /Lead handoff extraction/);
    assert.equal(lead.archivedAt, null, "the outgoing Lead is archived only at completion, not at extraction");

    // 4. The extraction turn completes: retirement, successor creation, and
    //    the immediate unified Turn-1 kickoff with the Peer's verdict.
    peer.status = "idle";
    await mailRuntime.onLeadTurnEnded({
      agentId: lead.id,
      outcome: { kind: "completed" },
      timeline: [{ type: "assistant_message", text: "# Handoff during T-KICK\nWatch T-KICK to its verdict." }],
    });
    assert.equal(readProjectRegistration(stateDir, reg.slug)?.rotationState, "normal");
    assert.equal(lead.archivedAt !== null, true, "the outgoing Lead was retired");
    assert.equal(peer.archivedAt, null, "the finished Peer was not archived by the handoff");
    const successor = [...agents.values()].find((a) => a.labels.seat === "lead" && a.id !== lead.id);
    assert.ok(successor, "a fresh Successor Lead was created");
    const successorSends = sent.filter((s) => s.agentId === successor.id);
    assert.equal(successorSends.length, 1, "the Successor Lead receives its Turn-1 kickoff immediately upon creation");
    assert.match(successorSends[0].text, /Task T-KICK attempt 1 ended GREEN/);
    assert.match(successorSends[0].text, /# Handoff during T-KICK/);
    assert.match(successorSends[0].text, /# Lead handoff — project/);

    // 5. v0.2.2 (ADR 0050 §1): a Peer that ends its turn (`onLeadTurnEnded`)
    //    WITHOUT reaching a verdict no longer wakes the rotation by itself —
    //    `idle`-because-paused and `idle`-between-turns are indistinguishable
    //    at the only layer that survives restarts, so a live-not-error Peer on
    //    an open spawn round holds `rotation_pending` durably (the v0.0.99
    //    `interruptedPeerIds` wake is an accelerator only). The hold releases
    //    through the Task's own outcome, queued `from: "peer"` mail, or the
    //    Peer's death — so `rotation_pending` still never deadlocks.
    successor.lastUsage = { contextWindowUsedTokens: 130_000 };
    const sucessorCorr = correlations.issue({ role: "lead", projectSlug: reg.slug, projectRoot: canonicalRoot, agentId: successor.id });
    const wave2Call = await runMcpSession({
      args: ["--correlation", sucessorCorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
      cwd: repoDir,
      requests: [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "T-IDLE", gate: "/usr/bin/false", description: brief4("Probe the idle path") } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["T-IDLE"] } } },
      ],
    });
    assert.notEqual((wave2Call[1].result as { isError?: boolean }).isError, true);
    const peer2 = [...agents.values()].find((a) => a.labels.task === "T-IDLE");
    assert.ok(peer2, "second wave Peer created");
    peer2.status = "running";
    writeProjectRegistration(stateDir, reg.slug, { root: canonicalRoot, lead: successor.id, supervisor: supervisor.id });
    await mailRuntime.onLeadTurnEnded({ agentId: successor.id, outcome: { kind: "completed" }, timeline: [] });
    assert.equal(readProjectRegistration(stateDir, reg.slug)?.rotationState, "rotation_pending");

    peer2.status = "idle";
    await mailRuntime.onLeadTurnEnded({ agentId: peer2.id, outcome: { kind: "completed" }, timeline: [] });
    assert.equal(readProjectRegistration(stateDir, reg.slug)?.rotationState, "rotation_pending", "a live-idle Peer on an open round holds rotation_pending even after a verdict-less turn end (v0.2.2, ADR 0050 §1)");
    assert.equal(sent.filter((s) => s.agentId === successor.id).length, 1, "no extraction prompt reached the outgoing Lead while the hold stands");

    // The Owner kills the paused-looking Peer: the open round's liveness arm
    // drops it and `sweepPeers` (the periodic door) begins the handoff —
    // `rotation_pending` never deadlocks on a Peer that will never return.
    peer2.archivedAt = new Date().toISOString();
    await mailRuntime.sweepPeers();
    assert.equal(readProjectRegistration(stateDir, reg.slug)?.rotationState, "handing_over", "a dead Peer releases the hold and the sweep begins the handoff");
  } finally {
    spool.stop();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---- per-dispatch thinking effort through the bridge (v0.5.0 ticket 04, ADR 0054 §4; spec Seam 2) ----

test("lead_dispatch_agent accepts thinking/thinkingReason end-to-end: a tier without a reason refuses invalid-spawn, a reasoned tier records on spawn_dispatched", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-thinking-home-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeGitRepo();
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.equal(reg.ok, true);
  const registry = createFactoryRegistry({ stateDir, root: factory });
  const created: { config: { provider: string; thinkingOptionId?: string } }[] = [];
  const fakeDaemon = {
    agents: {
      list: async () => ({ entries: [] as never[] }),
      create: async (input: { config: { provider: string; thinkingOptionId?: string } }) => {
        created.push({ config: input.config });
        return { id: `agent-created-${created.length}` };
      },
      ref: (id: string) => ({ send: async () => {}, cancel: async () => {}, archive: async () => {} }),
    },
  };
  const spool = startSpool(stateDir, factory, { registry, pollMs: 25, daemon: fakeDaemon as never });
  try {
    const correlations = new CorrelationRegistry(stateDir);
    const leadCorr = correlations.issue({ role: "lead", projectSlug: reg.slug, projectRoot: repoDir });
    correlations.associate(leadCorr.correlationId, "lead-thinking-1");

    const refusal = await runMcpSession({
      args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir],
      cwd: repoDir,
      requests: [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "TH-BR", gate: "/usr/bin/true", artifact: "README.md", scope: ["README.md"] } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["TH-BR"], thinking: "high" } } },
      ],
    });
    assert.notEqual((refusal[0].result as { isError?: boolean }).isError, true, "the contract lands");
    const refused = refusal[1].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(refused.isError, true, "a tier without its reason never dispatches");
    assert.match(refused.content[0].text, /invalid-spawn: thinkingReason is required when thinking is specified/);

    const dispatch = await runMcpSession({
      args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir],
      cwd: repoDir,
      requests: [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_dispatch_agent", arguments: { tasks: ["TH-BR"], thinking: "high", thinkingReason: "The fix spans the spool router and the ledger fold — high verification burden." } } },
      ],
    });
    const spawned = dispatch[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(spawned.isError, true, spawned.content[0].text);

    const ledgerPath = join(stateDir, "projects", reg.slug, "ledger.jsonl");
    const spawnLine = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((e) => e.event === "spawn_dispatched");
    assert.ok(spawnLine, "the reasoned dispatch is recorded");
    assert.equal(spawnLine.thinking, "high");
    assert.equal(spawnLine.thinkingReason, "The fix spans the spool router and the ledger fold — high verification burden.");
    assert.equal(created.length, 1, "the refusal created no Peer; the reasoned dispatch created exactly one");
  } finally {
    spool.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
