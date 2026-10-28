import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CorrelationRegistry } from "../src/correlations.ts";
import { createFactory } from "../plugin/server/core/factory.ts";
import { ensureProjectRegistered } from "../src/project.ts";
import { readLeadMailbox } from "../src/mailbox.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { startSpool } from "../plugin/server/spool.ts";

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
    assert.deepEqual(supTools, ["factory_status", "supervisor_accept_task", "supervisor_dispatch_lead"]);
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
    assert.deepEqual(leadTools, [
      "factory_status",
      "lead_accept_task",
      "lead_needs_human",
      "lead_repoke_agent",
      "lead_report_to_supervisor",
      "lead_set_contract",
      "lead_spawn_agent",
    ]);

    // 3. Working Agent session
    const agentResponses = await runMcpSession({
      args: ["--correlation", agentCorr.correlationId, "--state-dir", stateDir],
      env: { PATH: process.env.PATH },
      requests: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lead_accept_task", arguments: { task: "t-01", attempt: 1 } } },
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
    daemon: fakeDaemon as never,
    ensureLead: async () => ({ ok: true, agentId: "lead-1", created: false, projectRoot: repoDir, slug: reg.slug }),
    ensureSupervisor: async () => ({ ok: true, agentId: "sup-1", created: false, projectRoot: repoDir, slug: reg.slug }),
    retireLead: async () => ({ ok: true, agentId: "lead-1" }),
  });

  const spool = startSpool(stateDir, factory, {
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

    // 2. Lead sets contract and spawns agent via lead_set_contract and lead_spawn_agent
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
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "lead_spawn_agent",
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

    const worktreePath = factory.worktreeFor("feat-x");
    assert.ok(worktreePath, "lead_spawn_agent must allocate and register the Task worktree");

    // 3. Working Agent commits in Task worktree and calls agent_claim (defaulting task & commit to HEAD)
    writeFileSync(join(worktreePath, "feature.txt"), "done\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: worktreePath });
    execFileSync("git", ["commit", "-m", "feat: add feature.txt"], { cwd: worktreePath });

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
            arguments: {},
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
            name: "lead_accept_task",
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
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "factory_status",
            arguments: {},
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

    const statusRes = leadFinishCall[2].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(statusRes.isError, true, statusRes.content[0].text);
    assert.match(statusRes.content[0].text, /feat-x.*accepted=yes/);
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
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_claim", arguments: {} } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_claim", arguments: {} } },
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
  const lead = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: "demo", projectRoot: repoDir, agentId: "lead-1" });
  const spool = startSpool(stateDir, factory, { pollMs: 10 });
  t.after(() => spool.stop());
  const responses = await runMcpSession({
    args: ["--correlation", lead.correlationId, "--state-dir", stateDir], cwd: repoDir,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "DEFAULT", gate: "true", artifact: "README.md" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "LEGACY", gate: "true", artifact: "README.md", freshEyes: true, fresh_eyes: true } } },
    ],
  });
  const tools = (responses[0]!.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools;
  const contract = tools.find((tool) => tool.name === "lead_set_contract")!;
  assert.equal(contract.inputSchema.properties.freshEyes, undefined);
  assert.equal(contract.inputSchema.properties.fresh_eyes, undefined);
  for (const response of responses.slice(1)) {
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true, result.content[0]!.text);
    assert.doesNotMatch(result.content[0]!.text, /fresh eyes ON/);
  }
  assert.equal(factory.contractFor("DEFAULT")?.freshEyes, undefined);
  assert.equal(factory.contractFor("LEGACY")?.freshEyes, undefined);
});

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
      requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_claim", arguments: {} } }],
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
  const commonExclude = readFileSync(join(repoDir, ".git", "info", "exclude"), "utf8");
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.equal(reg.ok, true);
  factory.setContract({ task: "deps", workspace: repoDir, gate: "true", artifact: "README.md", scope: ["README.md"] });
  const correlation = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: reg.slug, projectRoot: repoDir });
  const spool = startSpool(stateDir, factory, { pollMs: 25 });
  const spawnTask = async () => {
    const responses = await runMcpSession({
      script: copiedBridge,
      args: ["--correlation", correlation.correlationId, "--state-dir", stateDir, "--home", homeDir],
      cwd: repoDir,
      requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_spawn_agent", arguments: { tasks: ["deps"] } } }],
    });
    const result = responses[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true, result.content[0].text);
    const worktree = factory.worktreeFor("deps");
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
  factory.setContract({ task: "mcp-bound", workspace: repoDir, gate: "true", artifact: "README.md" });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  await factory.claim({ task: "mcp-bound", sha });
  factory.ledger.append({ event: "fresh_eyes_written", task: "mcp-bound", attempt: 1, model: "eye", outcome: "concern", finding: "Owner decision needed", durationMs: 1 });
  const denial = factory.ledger.append({ event: "permit_denied", task: "mcp-bound", agent: "peer", name: "Bash", kind: "tool", rule: "scope", reason: "denied" });
  const poke = factory.ledger.append({ event: "repoke_dispatched", task: "mcp-bound", agent: "peer" });
  factory.ledger.append({ event: "needs_human", task: "mcp-bound", reason: "denied-again", evidence: { denial: denial.seq, repoke: poke.seq } });
  const registry = new CorrelationRegistry(stateDir);
  const lead = registry.issue({ role: "lead", projectSlug: reg.slug, projectRoot: repoDir, agentId: "mcp-lead" });
  const supervisor = registry.issue({ role: "supervisor", projectSlug: reg.slug, projectRoot: repoDir, agentId: "mcp-supervisor" });
  const spool = startSpool(stateDir, factory, { pollMs: 10 });
  t.after(() => spool.stop());
  const refused = await runMcpSession({
    args: ["--correlation", lead.correlationId, "--state-dir", stateDir], cwd: repoDir,
    requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_accept_task", arguments: { task: "mcp-bound", attempt: 1, by: "owner", submitter: "owner" } } }],
  });
  const denied = refused[0]!.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(denied.isError, true);
  assert.match(denied.content[0]!.text, /lead-accept-refused/);
  assert.equal(factory.ledger.eventsFor("mcp-bound").some((event) => event.event === "attempt_accepted"), false);
  const allowed = await runMcpSession({
    args: ["--correlation", supervisor.correlationId, "--state-dir", stateDir], cwd: repoDir,
    requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "supervisor_accept_task", arguments: { task: "mcp-bound", attempt: 1 } } }],
  });
  const accepted = allowed[0]!.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.notEqual(accepted.isError, true, accepted.content[0]!.text);
  assert.equal(factory.ledger.eventsFor("mcp-bound").findLast((event) => event.event === "attempt_accepted")?.accepted_by, "supervisor");
});

test("bridge lead_spawn_agent resolves real system git and ignores a broken <stateDir>/bin/git shim on PATH", async (t) => {
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
  factory.setContract({
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
  const spool = startSpool(stateDir, factory, { pollMs: 20 });
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
          name: "lead_spawn_agent",
          arguments: { tasks: ["T-01"], workspace: repoDir },
        },
      },
    ],
  });

  const spawnRes = responses[0]!.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.notEqual(spawnRes.isError, true, `Expected lead_spawn_agent to succeed even with broken <stateDir>/bin/git, got: ${spawnRes.content[0]?.text}`);
  const worktree = factory.worktreeFor("T-01");
  assert.ok(worktree && existsSync(worktree), "Task worktree was allocated using real system git");
});

test("background MCP spawn reports the dispatched specialist lane", async t => {
  const home = mkdtempSync(join(tmpdir(), "factory-bridge-background-"));
  const stateDir = join(home, "plugin-state", "paseo-factory"), repo = makeGitRepo();
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const project = ensureProjectRegistered(stateDir, repo);
  assert.ok(project.ok); if (!project.ok) return;
  factory.setContract({ task: "specialist", workspace: repo, gate: "true" });
  const correlation = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: project.slug, projectRoot: repo, agentId: "lead-fixture" });
  const bin = join(home, "fixture-bin"); mkdirSync(bin);
  copyFileSync(BRIDGE_BIN, join(bin, "bridge.mjs"));
  writeFileSync(join(home, "endpoint.sock"), "fixture presence marker");
  // The external Driver boundary publishes its actual dispatch, which differs from the configured SLP worker.
  writeFileSync(join(bin, "factory.mjs"), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(join(stateDir, "ledger.jsonl"))}, JSON.stringify({ seq: 2, ts: new Date().toISOString(), event: 'spawn_dispatched', task: 'specialist', provider: 'claude/pm-frozen', arity: 1 }) + '\\n');\n`);
  const responses = await runMcpSession({ script: join(bin, "bridge.mjs"), cwd: repo, args: ["--home", home, "--state-dir", stateDir, "--correlation", correlation.correlationId], requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_spawn_agent", arguments: { tasks: ["specialist"] } } }] });
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
  const contract = await handleSpoolRequest(factory, { id: "contract", kind: "contract", task: "plan", workspace: repo, gate: "true", role: "pm", runId: "r", submitter: "owner" });
  assert.ok(contract.ok, JSON.stringify(contract));
  const correlation = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: project.slug, projectRoot: repo, agentId: "scrum-lead" });
  const spool = startSpool(stateDir, factory, { pollMs: 20 }); t.after(() => spool.stop());
  const responses = await runMcpSession({ cwd: repo, args: ["--home", home, "--state-dir", stateDir, "--correlation", correlation.correlationId], requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_spawn_agent", arguments: { tasks: ["plan"] } } }] });
  assert.ok(responses[0].result, JSON.stringify(responses));
  const result = responses[0].result as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.match(result.content[0].text, /claude\/pm-frozen/);
  assert.equal(factory.ledger.events.findLast(e => e.event === "spawn_dispatched")?.provider, "claude/pm-frozen");
});
