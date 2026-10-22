import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  requests: Array<Record<string, unknown>>;
}): Promise<Array<Record<string, unknown>>> {
  const child = spawn(process.execPath, [BRIDGE_BIN, ...(options.args ?? [])], {
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
  // times out in 1s instead of the 60s default.
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

test("v0.0.28 (ADR 0018 §4): lead_set_contract smart-defaults freshEyes to true when usable, omits when unavailable, respects freshEyes: false, and fails fast on freshEyes: true when unconfigured", async () => {
  const repoDir = makeGitRepo();

  // 1. Usable freshEyes lane (eyeCliProbe: () => true)
  const homeUsable = mkdtempSync(join(tmpdir(), "factory-bridge-fe-on-"));
  const stateUsable = join(homeUsable, "plugin-state", "paseo-factory");
  const factoryUsable = createFactory({ stateDir: stateUsable, eyeCliProbe: () => true });
  const spoolUsable = startSpool(stateUsable, factoryUsable, { pollMs: 25 });

  // 2. Unusable freshEyes lane (eyeCliProbe: () => false)
  const homeUnusable = mkdtempSync(join(tmpdir(), "factory-bridge-fe-off-"));
  const stateUnusable = join(homeUnusable, "plugin-state", "paseo-factory");
  const factoryUnusable = createFactory({ stateDir: stateUnusable, eyeCliProbe: () => false });
  const spoolUnusable = startSpool(stateUnusable, factoryUnusable, { pollMs: 25 });

  try {
    const corrUsable = new CorrelationRegistry(stateUsable).issue({
      role: "lead",
      projectSlug: "demo-usable",
      projectRoot: repoDir,
      agentId: "lead-usable-1",
    });

    const usableResponses = await runMcpSession({
      args: ["--correlation", corrUsable.correlationId, "--state-dir", stateUsable],
      cwd: repoDir,
      requests: [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "lead_set_contract",
            arguments: {
              task: "t-default-on",
              gate: "/usr/bin/true",
              artifact: "README.md",
              scope: "src/a",
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "lead_set_contract",
            arguments: {
              task: "t-explicit-off",
              gate: "/usr/bin/true",
              artifact: "README.md",
              scope: "src/b",
              freshEyes: false,
            },
          },
        },
      ],
    });

    const resDefaultOn = usableResponses[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(resDefaultOn.isError, true, resDefaultOn.content[0].text);
    assert.match(resDefaultOn.content[0].text, /fresh eyes ON/);
    assert.equal(factoryUsable.contractFor("t-default-on")?.freshEyes, true);

    const resExplicitOff = usableResponses[1].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(resExplicitOff.isError, true, resExplicitOff.content[0].text);
    assert.doesNotMatch(resExplicitOff.content[0].text, /fresh eyes ON/);
    assert.equal(factoryUsable.contractFor("t-explicit-off")?.freshEyes, undefined);

    const corrUnusable = new CorrelationRegistry(stateUnusable).issue({
      role: "lead",
      projectSlug: "demo-unusable",
      projectRoot: repoDir,
      agentId: "lead-unusable-1",
    });

    const unusableResponses = await runMcpSession({
      args: ["--correlation", corrUnusable.correlationId, "--state-dir", stateUnusable],
      cwd: repoDir,
      requests: [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "lead_set_contract",
            arguments: {
              task: "t-degraded-off",
              gate: "/usr/bin/true",
              artifact: "README.md",
              scope: "src/c",
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "lead_set_contract",
            arguments: {
              task: "t-explicit-on-fail",
              gate: "/usr/bin/true",
              artifact: "README.md",
              scope: "src/d",
              freshEyes: true,
            },
          },
        },
      ],
    });

    const resDegraded = unusableResponses[0].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(resDegraded.isError, true, resDegraded.content[0].text);
    assert.doesNotMatch(resDegraded.content[0].text, /fresh eyes ON/);
    assert.equal(factoryUnusable.contractFor("t-degraded-off")?.freshEyes, undefined);

    const resFailFast = unusableResponses[1].result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(resFailFast.isError, true);
    assert.match(resFailFast.content[0].text, /eye-unconfigured/);
    assert.equal(factoryUnusable.contractFor("t-explicit-on-fail"), undefined);
  } finally {
    spoolUsable.stop();
    spoolUnusable.stop();
    rmSync(homeUsable, { recursive: true, force: true });
    rmSync(homeUnusable, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

