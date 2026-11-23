import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { catalog } from "../src/mcp/catalog.ts";
import {
  healAgyMcpSchemaFile,
  healAgyMcpSchemaForCall,
  healAgyMcpSchemasForDirectory,
} from "../src/agy-mcp-schema-heal.ts";
import { createFactory, type PeerAskInput } from "../plugin/server/core/factory.ts";
import type { PeerAsked } from "../plugin/server/core/events.ts";
import { readLeadMailbox } from "../plugin/server/core/mailbox.ts";
import { CorrelationRegistry } from "../plugin/server/core/correlations.ts";
import { ensureProjectRegistered, resolveProject } from "../plugin/server/core/project.ts";
import { createFactoryRegistry, writeProjectRegistration } from "../plugin/server/projects.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { createGateQueue } from "../plugin/server/gate-queue.ts";
import { handleSpoolRequest, parseSpoolRequest, settleClaimOutcome, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const FACTORY_BIN = resolve(import.meta.dirname, "../plugin/bin/factory.mjs");
const CLAIM_BIN = resolve(import.meta.dirname, "../plugin/bin/factory-claim.mjs");
const BRIDGE_BIN = resolve(import.meta.dirname, "../plugin/bin/bridge.mjs");

function brief4(summary: string): string {
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
    "the gate command runs green",
  ].join("\n");
}

function runClaimCli(args: string[], extraEnv: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [CLAIM_BIN, ...args], {
      env: { PATH: process.env.PATH, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`factory-claim.mjs timed out. stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    child.on("error", (err) => {
      clearTimeout(killer);
      rejectRun(err);
    });
    child.on("close", (status) => {
      clearTimeout(killer);
      resolveRun({ status, stdout, stderr });
    });
  });
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
    env: options.env ?? { PATH: process.env.PATH },
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

test("ADR 0069 MCP catalog advertises agent_ask + lead_reply_peer, hides legacy aliases from primary roles, and removes immutable Contract wording", () => {
  assert.deepEqual(catalog.roles.agent, ["agent_claim", "agent_ask"]);
  assert.equal(catalog.roles.agent.includes("agent_escalate_blocker"), false);
  assert.equal(catalog.roles.lead.includes("lead_reply_peer"), true);
  assert.equal(catalog.roles.lead.includes("lead_repoke_agent"), false);

  // Legacy tool schemas remain in catalog.tools for backward compatibility.
  assert.ok(catalog.tools.agent_escalate_blocker);
  assert.ok(catalog.tools.lead_repoke_agent);

  // agent_ask schema: strict PACE + CONTRA shape with zero topology fields.
  const askTool = catalog.tools.agent_ask;
  assert.ok(askTool);
  assert.deepEqual(Object.keys(askTool.inputSchema.properties).sort(), ["evidence", "kind", "layer", "proposal", "summary"]);
  for (const forbidden of ["task", "project", "workspace", "recipient"]) {
    assert.equal(forbidden in askTool.inputSchema.properties, false, `agent_ask must not expose ${forbidden}`);
  }
  assert.deepEqual(askTool.inputSchema.required, ["kind", "summary", "evidence"]);
  assert.deepEqual((askTool.inputSchema.properties.kind as { enum: string[] }).enum, [
    "reopen_premise",
    "gate_mismatch",
    "dependency",
    "clarify",
    "blocked",
  ]);
  assert.deepEqual((askTool.inputSchema.properties.layer as { enum: string[] }).enum, [
    "foundation",
    "dependency",
    "lifecycle",
    "API",
    "ownership",
    "verification",
  ]);
  assert.match(askTool.description, /CONTRA|contradict|prerequisite|ambiguity/i);
  assert.match(askTool.description, /routine/i);

  // lead_set_contract: no "immutable Contract", optional reopenConditions array of strings.
  const contractTool = catalog.tools.lead_set_contract;
  assert.equal(/immutable Contract/i.test(contractTool.description), false);
  assert.deepEqual(contractTool.inputSchema.properties.reopenConditions, {
    type: "array",
    items: { type: "string" },
    description: (contractTool.inputSchema.properties.reopenConditions as { description: string }).description,
  });

  // lead_reply_peer: requires task and message.
  const replyTool = catalog.tools.lead_reply_peer;
  assert.ok(replyTool);
  assert.deepEqual(replyTool.inputSchema.required, ["task", "message"]);
});

test("ADR 0069 schema-heal writes primary tools for directory scans and still heals legacy aliases on direct file/call access", (t) => {
  const dir = makeTempDir("adr0069-schema-heal-");
  disposeDir(t, dir);
  const home = join(dir, "home");
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  const agentServerDir = join(home, ".gemini", "antigravity-cli", "mcp", "paseo_factory");
  const healedCount = healAgyMcpSchemasForDirectory({ seat: "agent", targetPath: agentServerDir });
  assert.equal(healedCount, 2);
  assert.equal(existsSync(join(agentServerDir, "agent_ask.json")), true);
  assert.equal(existsSync(join(agentServerDir, "agent_claim.json")), true);
  assert.equal(existsSync(join(agentServerDir, "agent_escalate_blocker.json")), false);

  // Legacy session explicitly requesting agent_escalate_blocker or lead_repoke_agent still heals.
  assert.equal(
    healAgyMcpSchemaFile({ seat: "agent", targetPath: join(agentServerDir, "agent_escalate_blocker.json") }),
    true,
  );
  assert.equal(existsSync(join(agentServerDir, "agent_escalate_blocker.json")), true);

  const leadServerDir = join(home, ".gemini", "antigravity", "mcp", "paseo-factory_paseo_factory");
  mkdirSync(leadServerDir, { recursive: true });
  assert.equal(
    healAgyMcpSchemaForCall({ seat: "lead", serverName: "paseo-factory_paseo_factory", toolName: "lead_repoke_agent" }),
    true,
  );
  assert.equal(existsSync(join(leadServerDir, "lead_repoke_agent.json")), true);

  // Cross-role remains blocked.
  assert.equal(
    healAgyMcpSchemaFile({ seat: "agent", targetPath: join(agentServerDir, "lead_reply_peer.json") }),
    false,
  );
  assert.equal(
    healAgyMcpSchemaFile({ seat: "lead", targetPath: join(leadServerDir, "agent_ask.json") }),
    false,
  );
});

test("factory contract --reopen-if repeatable flag attaches reopenConditions on the spool request and refuses blank values", async (t) => {
  const dir = makeTempDir("adr0069-factory-cli-");
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const spoolRoot = spoolRootFor(stateDir);
  mkdirSync(join(spoolRoot, "requests"), { recursive: true });
  mkdirSync(join(spoolRoot, "replies"), { recursive: true });
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "ok\n");
  gitCommitAll(repo);

  // 1. Valid repeatable --reopen-if
  const child = spawn(
    process.execPath,
    [
      FACTORY_BIN,
      "--home",
      home,
      "contract",
      "--task",
      "T-REOPEN",
      "--workspace",
      repo,
      "--gate",
      "true",
      "--reopen-if",
      "src/adapter.ts does not exist",
      "--reopen-if",
      "existing gate script fails on clean HEAD",
    ],
    { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
  );

  let captured: Record<string, unknown> | undefined;
  const responder = setInterval(() => {
    const files = readdirSync(join(spoolRoot, "requests")).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const req = JSON.parse(readFileSync(join(spoolRoot, "requests", file), "utf8")) as Record<string, unknown>;
      captured = req;
      writeFileSync(
        join(spoolRoot, "replies", `${String(req.id)}.json`),
        JSON.stringify({ id: req.id, ok: true, summary: "contract set" }),
      );
    }
  }, 20);
  t.after(() => clearInterval(responder));

  const exitCode = await new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
  clearInterval(responder);
  assert.equal(exitCode, 0);
  assert.ok(captured);
  assert.equal(captured.kind, "contract");
  assert.deepEqual(captured.reopenConditions, [
    "src/adapter.ts does not exist",
    "existing gate script fails on clean HEAD",
  ]);

  // 2. Blank --reopen-if fails usage check immediately
  const badChild = spawn(
    process.execPath,
    [FACTORY_BIN, "--home", home, "contract", "--task", "T-BAD", "--workspace", repo, "--gate", "true", "--reopen-if", "   "],
    { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let badStderr = "";
  badChild.stderr.on("data", (d) => {
    badStderr += String(d);
  });
  const badCode = await new Promise<number | null>((resolveExit) => badChild.on("close", resolveExit));
  assert.equal(badCode, 2);
  assert.match(badStderr, /--reopen-if/);
});

test("spool peer_ask + parseSpoolRequest validate shape, call factory.recordPeerAsk, and queue neutral [Peer <KIND>] mail without waking Supervisor", async (t) => {
  const dir = makeTempDir("adr0069-spool-peer-ask-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  gitCommitAll(repoDir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok);
  writeProjectRegistration(stateDir, resolved.slug, { root: resolved.root });

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "T-ASK", workspace: resolved.root, gate: "true" });

  // parseSpoolRequest validation
  assert.equal(
    parseSpoolRequest({ id: "p1", kind: "peer_ask", peerAskKind: "reopen_premise", summary: "missing layer", source: "agent_ask" }),
    undefined,
  );
  assert.ok(
    parseSpoolRequest({
      id: "p2",
      kind: "peer_ask",
      task: "T-ASK",
      peerAskKind: "reopen_premise",
      layer: "API",
      summary: "missing export",
      evidence: "src/index.ts:10",
      proposal: "use helper",
      source: "agent_ask",
    }),
  );
  assert.ok(
    parseSpoolRequest({
      id: "p3",
      kind: "contract",
      task: "T-ASK",
      workspace: resolved.root,
      gate: "true",
      submitter: "lead",
      reopenConditions: ["cond 1"],
    }),
  );
  assert.equal(
    parseSpoolRequest({
      id: "p4",
      kind: "contract",
      task: "T-ASK",
      workspace: resolved.root,
      gate: "true",
      submitter: "lead",
      reopenConditions: [123],
    }),
    undefined,
  );

  const recordedAsks: PeerAskInput[] = [];
  const factoryWithAsk = Object.create(factory) as typeof factory;
  factoryWithAsk.recordPeerAsk = (input: PeerAskInput): PeerAsked => {
    recordedAsks.push(input);
    return { seq: 42, ts: new Date().toISOString(), event: "peer_asked", ...input };
  };

  const sent: Array<{ id: string; text: string }> = [];
  const fakeDaemon = {
    agents: {
      list: async () => ({ entries: [{ agent: { id: "lead-1", status: "idle", archivedAt: null, cwd: resolved.root, labels: { seat: "lead", project: resolved.slug } } }] }),
      ref: (id: string) => ({ send: async (text: string) => { sent.push({ id, text }); } }),
    },
  } as unknown as SurfaceDaemonApi;

  const leadMail = createLeadMailRuntime({
    stateDir,
    factory,
    daemon: fakeDaemon,
    ensureLead: async () => ({ ok: true, agentId: "lead-1", created: false, projectRoot: resolved.root, slug: resolved.slug }),
    retireLead: async () => ({ ok: true, agentId: "lead-1" }),
  });

  const reply = await handleSpoolRequest(
    factoryWithAsk,
    {
      id: "ask-1",
      kind: "peer_ask",
      task: "T-ASK",
      workspace: resolved.root,
      peerAskKind: "reopen_premise",
      layer: "API",
      summary: "Contract assumes export foo() which does not exist",
      evidence: "src/foo.ts:12 has only bar()",
      proposal: "Target bar() or reopen wave",
      source: "agent_ask",
      agent: "peer-1",
      seat: "agent",
    },
    { leadDispatch: leadMail.dispatchLead, daemon: fakeDaemon },
  );
  assert.equal(reply.ok, true);
  assert.equal(recordedAsks.length, 1);
  assert.deepEqual(recordedAsks[0], {
    task: "T-ASK",
    kind: "reopen_premise",
    layer: "API",
    summary: "Contract assumes export foo() which does not exist",
    source: "agent_ask",
    agent: "peer-1",
  });

  const mailbox = readLeadMailbox(join(stateDir, "projects", resolved.slug, "mailbox.jsonl"));
  const queuedOrInFlight = [...mailbox.queued, ...(mailbox.inFlight?.items ?? [])];
  assert.equal(queuedOrInFlight.length, 1);
  assert.equal(queuedOrInFlight[0]?.kind, "peer_challenge");
  assert.equal(queuedOrInFlight[0]?.from, "peer");
  assert.equal(queuedOrInFlight[0]?.to, "lead");
  assert.match(queuedOrInFlight[0]?.text ?? "", /^\[Peer REOPEN_PREMISE \(API\) on T-ASK\]/);
  assert.equal(/\[Blocker on task/.test(queuedOrInFlight[0]?.text ?? ""), false);
  assert.equal(mailbox.supervisorQueued.length, 0);
});

test("spool claim handback bypasses GateQueue, flushes usageMeter without attempt, and delivers verbatim 6-Field Handoff to Lead mailbox", async (t) => {
  const dir = makeTempDir("adr0069-spool-handback-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  const sha = gitCommitAll(repoDir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok);
  writeProjectRegistration(stateDir, resolved.slug, { root: resolved.root });

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "T-HB", workspace: resolved.root, gate: "exit 1" });

  const handoff = {
    outcome: "reopen" as const,
    scope: "inspected src/index.ts",
    verification: "targeted check failed due to missing fixture",
    unknowns: "upstream contract missing test fixture",
  };
  const handbackEvent = {
    seq: 9,
    ts: new Date().toISOString(),
    event: "peer_asked" as const,
    task: "T-HB",
    kind: "reopen_premise" as const,
    summary: "upstream contract missing test fixture",
    source: "agent_claim" as const,
    agent: "peer-hb",
    reportPath: join(stateDir, "report-T-HB-ask-9.md"),
  };
  const proxyFactory = Object.create(factory) as typeof factory;
  proxyFactory.admitClaim = (async () => ({
    status: "handback",
    event: handbackEvent,
    reportPath: handbackEvent.reportPath,
    handoff,
    snapshot: { sha, branch: "factory/T-HB", dir: resolved.root },
  })) as never;

  const meterCalls: Array<Record<string, unknown>> = [];
  const gateQueue = createGateQueue({ stateDir, factory });
  t.after(() => gateQueue.stop());

  const fakeDaemon = {
    agents: {
      list: async () => ({ entries: [{ agent: { id: "lead-hb", status: "idle", archivedAt: null, cwd: resolved.root, labels: { seat: "lead", project: resolved.slug } } }] }),
      ref: () => ({ send: async () => {} }),
    },
  } as unknown as SurfaceDaemonApi;
  const leadMail = createLeadMailRuntime({
    stateDir,
    factory,
    daemon: fakeDaemon,
    ensureLead: async () => ({ ok: true, agentId: "lead-hb", created: false, projectRoot: resolved.root, slug: resolved.slug }),
    retireLead: async () => ({ ok: true, agentId: "lead-hb" }),
  });

  const reply = await handleSpoolRequest(
    proxyFactory,
    {
      id: "hb-1",
      kind: "claim",
      task: "T-HB",
      handoff,
      agent: "peer-hb",
    },
    {
      gateQueue,
      usageMeter: async (m) => {
        meterCalls.push(m);
      },
      leadDispatch: leadMail.dispatchLead,
      daemon: fakeDaemon,
    },
  );

  assert.equal(reply.ok, true);
  if (reply.ok) {
    assert.equal(reply.status, "handback");
    assert.equal(reply.reportPath, handbackEvent.reportPath);
  }
  assert.equal(gateQueue.snapshot().queued.length, 0);
  assert.equal(gateQueue.snapshot().running.length, 0);
  assert.deepEqual(meterCalls, [{ task: "T-HB", agentId: "peer-hb", slug: resolved.slug }]);

  const mailbox = readLeadMailbox(join(stateDir, "projects", resolved.slug, "mailbox.jsonl"));
  const items = [...mailbox.queued, ...(mailbox.inFlight?.items ?? [])];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "peer_challenge");
  assert.match(items[0]?.text ?? "", /6-Field Handoff:/);
  assert.match(items[0]?.text ?? "", /- Outcome: reopen/);
  assert.match(items[0]?.text ?? "", /- Unknown \/ risk: upstream contract missing test fixture/);
});

test("formatPeerRedWakeupText on RED Attempts 1..2 removes gag clause, stays topology-blind, and gives two explicit branches", async (t) => {
  const dir = makeTempDir("adr0069-red-wakeup-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  const sha = gitCommitAll(repoDir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok);

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "T-RED", workspace: resolved.root, gate: "true" });

  const sent: Array<{ agentId: string; text: string }> = [];
  const fakeDaemon = {
    agents: {
      list: async () => ({
        entries: [
          {
            agent: {
              id: "peer-red-1",
              status: "idle",
              archivedAt: null,
              cwd: resolved.root,
              labels: { seat: "agent", project: resolved.slug, task: "T-RED" },
            },
          },
        ],
      }),
      ref: (agentId: string) => ({
        send: async (text: string) => {
          sent.push({ agentId, text });
        },
      }),
    },
  } as unknown as SurfaceDaemonApi;

  await settleClaimOutcome({
    factory,
    task: "T-RED",
    agent: "peer-red-1",
    sha,
    workspace: resolved.root,
    projectSlug: resolved.slug,
    daemon: fakeDaemon,
    outcome: {
      attempt: 1,
      verdict: "red",
      gate: {
        seq: 10,
        ts: new Date().toISOString(),
        event: "gate_finished",
        task: "T-RED",
        attempt: 1,
        verdict: "red",
        exit: 1,
        note: "exit 1",
        sha,
        outputPath: join(stateDir, "gate-T-RED-1.log"),
      },
      reportPath: join(stateDir, "report-T-RED-1.md"),
    },
  });

  assert.equal(sent.length, 1);
  const msg = sent[0]!.text;
  assert.equal(/never notify Lead directly/i.test(msg), false);
  assert.equal(/GateQueue|Factory/i.test(msg), false);
  assert.match(msg, /agent_claim/);
  assert.match(msg, /agent_ask/);
  assert.match(msg, /gate_mismatch/);
  assert.match(msg, /reopen_premise/);
  assert.match(msg, /NEVER skip, delete, or weaken tests/i);
});

test("factory-claim.mjs subprocess handles --outcome reopen (no --sha), --outcome partial, and --outcome blocked as HANDBACK exit 0 without TypeError", async (t) => {
  const dir = makeTempDir("adr0069-claim-cli-handback-");
  disposeDir(t, dir);
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  const headSha = gitCommitAll(repoDir);
  const stateDir = join(dir, "state");

  const help = await runClaimCli(["--help"], {});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /reopen\/blocked handbacks/);
  assert.match(help.stdout, /without running the contract's gate/i);

  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.equal(reg.ok, true);
  if (!reg.ok) return;
  const registry = createFactoryRegistry({ stateDir, root: factory });
  const projectFactory = registry.factoryForProject(reg.slug);
  projectFactory.setContract({ task: "T-HB-REOPEN", workspace: reg.root, gate: "exit 1" });
  projectFactory.setContract({ task: "T-HB-PARTIAL", workspace: reg.root, gate: "exit 1" });
  projectFactory.setContract({ task: "T-HB-PARTIAL-NOSHA", workspace: reg.root, gate: "exit 1" });
  projectFactory.setContract({ task: "T-HB-BLOCKED", workspace: reg.root, gate: "exit 1" });

  const peerMailCalls: Array<{ task: string; kind: string; text: string }> = [];
  const spool = startSpool(stateDir, factory, {
    registry,
    pollMs: 15,
    peerMail: async (mail) => {
      peerMailCalls.push(mail);
    },
  });
  t.after(() => spool.stop());

  const env = { FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "peer-cli-hb" };

  // 1. --outcome reopen with NO --sha
  const reopenRes = await runClaimCli(
    [
      "--task",
      "T-HB-REOPEN",
      "--outcome",
      "reopen",
      "--scope",
      "checked src/adapter.ts",
      "--verification",
      "grep confirmed export missing",
      "--unknowns",
      "contract assumes foo() export which does not exist",
      "--wait-secs",
      "10",
    ],
    env,
  );
  assert.equal(reopenRes.status, 0, `reopen stderr=${reopenRes.stderr}`);
  assert.equal(/TypeError/.test(reopenRes.stderr), false);
  assert.match(reopenRes.stdout, /HANDBACK/);
  assert.match(reopenRes.stdout, /report: .*report-T-HB-REOPEN-ask-/);
  assert.match(reopenRes.stdout, /end your turn now and wait for Lead's ruling/i);
  const reopenEvents = projectFactory.ledger.eventsFor("T-HB-REOPEN");
  assert.equal(reopenEvents.some((e) => e.event === "gate_queued" || e.event === "gate_started"), false);
  assert.equal(reopenEvents.findLast((e) => e.event === "peer_asked")?.kind, "reopen_premise");

  // 2. --outcome partial (with explicit --sha and without --sha)
  const partialRes = await runClaimCli(
    [
      "--task",
      "T-HB-PARTIAL",
      "--sha",
      headSha,
      "--outcome",
      "partial",
      "--scope",
      "landed first slice",
      "--verification",
      "unit check passed",
      "--unknowns",
      "remaining integration check deferred",
      "--wait-secs",
      "10",
    ],
    env,
  );
  assert.equal(partialRes.status, 0, `partial stderr=${partialRes.stderr}`);
  assert.equal(/TypeError/.test(partialRes.stderr), false);
  assert.match(partialRes.stdout, /HANDBACK/);
  assert.match(partialRes.stdout, /report: .*report-T-HB-PARTIAL-ask-/);
  assert.equal(projectFactory.ledger.eventsFor("T-HB-PARTIAL").findLast((e) => e.event === "peer_asked")?.kind, "partial");

  const partialNoShaRes = await runClaimCli(
    [
      "--task",
      "T-HB-PARTIAL-NOSHA",
      "--outcome",
      "partial",
      "--scope",
      "landed first slice",
      "--verification",
      "unit check passed",
      "--unknowns",
      "remaining integration check deferred",
      "--wait-secs",
      "10",
    ],
    env,
  );
  assert.equal(partialNoShaRes.status, 0, `partial no-sha stderr=${partialNoShaRes.stderr}`);
  assert.equal(/TypeError/.test(partialNoShaRes.stderr), false);
  assert.match(partialNoShaRes.stdout, /HANDBACK/);
  assert.equal(projectFactory.ledger.eventsFor("T-HB-PARTIAL-NOSHA").findLast((e) => e.event === "peer_asked")?.kind, "partial");

  // 3. --outcome blocked with NO --sha
  const blockedRes = await runClaimCli(
    [
      "--task",
      "T-HB-BLOCKED",
      "--outcome",
      "blocked",
      "--scope",
      "checked environment",
      "--verification",
      "probe exited 1",
      "--unknowns",
      "external daemon unavailable",
      "--wait-secs",
      "10",
    ],
    env,
  );
  assert.equal(blockedRes.status, 0, `blocked stderr=${blockedRes.stderr}`);
  assert.equal(/TypeError/.test(blockedRes.stderr), false);
  assert.match(blockedRes.stdout, /HANDBACK/);
  assert.equal(projectFactory.ledger.eventsFor("T-HB-BLOCKED").findLast((e) => e.event === "peer_asked")?.kind, "blocked");
  assert.equal(peerMailCalls.length, 4);
});

test("bridge.mjs JSON-RPC subprocess covers agent_ask, handback agent_claim, lead_reply_peer ruling, legacy REOPEN_REQUEST normalization, multi-project Loop Health, and Reopen-if prompt placement", async (t) => {
  const dir = makeTempDir("adr0069-bridge-mcp-");
  disposeDir(t, dir);
  const homeDir = join(dir, "home");
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoA = join(dir, "repo-a");
  const repoB = join(dir, "repo-b");
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  writeFileSync(join(repoA, "README.md"), "repo A\n");
  writeFileSync(join(repoB, "README.md"), "repo B\n");
  gitCommitAll(repoA);
  gitCommitAll(repoB);

  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const regA = ensureProjectRegistered(stateDir, repoA);
  const regB = ensureProjectRegistered(stateDir, repoB);
  assert.equal(regA.ok, true);
  assert.equal(regB.ok, true);
  if (!regA.ok || !regB.ok) return;
  const registry = createFactoryRegistry({ stateDir, root: factory });

  const createdPrompts: string[] = [];
  const sentPrompts: Array<{ id: string; text: string }> = [];
  const liveAgents = new Map<string, { id: string; status: string; archivedAt: string | null; cwd: string; labels: Record<string, string> }>([
    ["lead-a", { id: "lead-a", status: "idle", archivedAt: null, cwd: regA.root, labels: { seat: "lead", project: regA.slug } }],
    ["sup-a", { id: "sup-a", status: "idle", archivedAt: null, cwd: regA.root, labels: { seat: "supervisor", project: regA.slug } }],
  ]);
  const workspaceDirs = new Map<string, string>();
  const fakeDaemon = {
    agents: {
      list: async (opts?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean } }) => {
        const wanted = opts?.filter?.labels ?? {};
        const includeArchived = opts?.filter?.includeArchived === true;
        const entries = [...liveAgents.values()]
          .filter((a) => includeArchived || a.archivedAt === null)
          .filter((a) => Object.entries(wanted).every(([k, v]) => a.labels[k] === v))
          .map((agent) => ({ agent }));
        return { entries };
      },
      create: async (opts: { cwd: string; labels: Record<string, string>; prompt?: string }) => {
        createdPrompts.push(opts.prompt ?? "");
        const id = `peer-${createdPrompts.length}`;
        liveAgents.set(id, { id, status: "idle", archivedAt: null, cwd: opts.cwd, labels: opts.labels });
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
    workspaces: {
      open: async () => ({ id: "ws-main", projectId: "paseo-proj-a" }),
      create: async (input: { source: { path: string } }) => {
        const id = `ws-task-${workspaceDirs.size + 1}`;
        workspaceDirs.set(id, input.source.path);
        return { id };
      },
      ref: (id: string) => ({
        agents: {
          create: async (opts: { cwd?: string; labels?: Record<string, string>; prompt?: string }) => {
            createdPrompts.push(opts.prompt ?? "");
            const agentId = `peer-${createdPrompts.length}`;
            liveAgents.set(agentId, {
              id: agentId,
              status: "idle",
              archivedAt: null,
              cwd: workspaceDirs.get(id) ?? opts.cwd ?? regA.root,
              labels: opts.labels ?? {},
            });
            return { id: agentId };
          },
        },
      }),
    },
  };

  const mailRuntime = createLeadMailRuntime({
    stateDir,
    factory,
    registry,
    daemon: fakeDaemon as never,
    ensureLead: async () => ({ ok: true, agentId: "lead-a", created: false, projectRoot: regA.root, slug: regA.slug }),
    retireLead: async () => ({ ok: true, agentId: "lead-a" }),
  });
  const spool = startSpool(stateDir, factory, {
    registry,
    pollMs: 10,
    leadDispatch: mailRuntime.dispatchLead,
    supervisorDispatch: mailRuntime.dispatchSupervisor,
    supervisorReport: mailRuntime.reportSupervisor,
    peerMail: mailRuntime.notifyPeer,
    daemon: fakeDaemon as never,
    home: homeDir,
  });
  t.after(() => spool.stop());

  const correlations = new CorrelationRegistry(stateDir);
  const leadCorr = correlations.issue({ role: "lead", projectSlug: regA.slug, projectRoot: regA.root, agentId: "lead-a" });
  const supACorr = correlations.issue({ role: "supervisor", projectSlug: regA.slug, projectRoot: regA.root, agentId: "sup-a" });

  // (f) lead_dispatch_agent places `Reopen if:` + `agent_ask` guidance at the END of Peer's initial user turn
  const leadDispatchRes = await runMcpSession({
    args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
    cwd: regA.root,
    requests: [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "lead_set_contract",
          arguments: {
            task: "T-01",
            gate: "true",
            artifact: "README.md",
            scope: ["README.md"],
            reopenConditions: ["src/api.ts lacks getUser()", "existing gate fails on clean HEAD"],
            description: brief4("Implement T-01"),
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "lead_dispatch_agent", arguments: { tasks: ["T-01"] } },
      },
    ],
  });
  for (const res of leadDispatchRes) {
    const toolRes = res.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(toolRes.isError, true, toolRes.content[0].text);
  }
  assert.equal(createdPrompts.length, 1);
  const initialPrompt = createdPrompts[0]!;
  const taskIdx = initialPrompt.indexOf("Task (T-01):");
  const scopeIdx = initialPrompt.indexOf("Allowed scope:");
  const execIdx = initialPrompt.indexOf("Execute task T-01:");
  const reopenIdx = initialPrompt.indexOf("Reopen if:\n- src/api.ts lacks getUser()\n- existing gate fails on clean HEAD");
  const askIdx = initialPrompt.indexOf("call `agent_ask` immediately rather than guessing.");
  const skillScopeIdx = initialPrompt.indexOf("Project Peer skills allowed:");
  assert.ok(taskIdx >= 0 && scopeIdx > taskIdx && execIdx > scopeIdx, "task, scope, and execute sections precede Reopen if");
  assert.ok(reopenIdx > execIdx, `Reopen if must sit after Execute task (at the end of prompt), got:\n${initialPrompt}`);
  assert.ok(askIdx > reopenIdx, "agent_ask premise-check reminder must follow Reopen if at the very end");
  assert.ok(skillScopeIdx > askIdx, "only createTaskPeer's skill-scope footer follows bridge's prompt");
  assert.ok(initialPrompt.slice(0, skillScopeIdx).trimEnd().endsWith("call `agent_ask` immediately rather than guessing."));

  const peerId = "peer-1";
  const agentCorr = correlations.issue({ role: "agent", projectSlug: regA.slug, projectRoot: regA.root, task: "T-01", agentId: peerId });

  // (a) agent_ask: valid call, rejection of forbidden topology fields, rejection of reopen_premise without layer
  // (b) agent_claim with outcome: "reopen" returning Status: HANDBACK
  // (d) legacy agent_escalate_blocker with REOPEN_REQUEST (API) mapping to reopen_premise + layer: "API"
  const peerRes = await runMcpSession({
    args: ["--correlation", agentCorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
    cwd: regA.root,
    requests: [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "agent_ask",
          arguments: {
            kind: "clarify",
            summary: "Need clarification on error formatting",
            evidence: "README.md:1 has no format spec",
            proposal: "Use JSON lines",
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "agent_ask", arguments: { kind: "clarify", summary: "x", evidence: "y", task: "T-01" } },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "agent_ask", arguments: { kind: "clarify", summary: "x", evidence: "y", project: regA.slug } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "agent_ask", arguments: { kind: "clarify", summary: "x", evidence: "y", workspace: regA.root } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "agent_ask", arguments: { kind: "clarify", summary: "x", evidence: "y", recipient: "lead" } },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "agent_ask", arguments: { kind: "reopen_premise", summary: "x", evidence: "y" } },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "agent_claim",
          arguments: {
            outcome: "reopen",
            scope: "inspected README.md",
            verification: "checked exports",
            unknowns: "missing upstream endpoint",
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "agent_escalate_blocker",
          arguments: { message: "REOPEN_REQUEST (api): contract expects GET /v2 but only GET /v1 exists" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "agent_escalate_blocker",
          arguments: { message: "REOPEN_REQUEST: gate command references missing script" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "agent_escalate_blocker",
          arguments: { message: "DEPENDENCY_REQUEST: waiting on T-00 auth helper" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "agent_escalate_blocker",
          arguments: { message: "External registry unreachable" },
        },
      },
    ],
  });
  const peerById = new Map(peerRes.map((r) => [r.id, r.result as { isError?: boolean; content: Array<{ text: string }> }]));
  assert.notEqual(peerById.get(1)!.isError, true, peerById.get(1)!.content[0].text);
  assert.match(peerById.get(1)!.content[0].text, /Ask \(clarify\) sent to Lead/);
  for (const id of [2, 3, 4, 5]) {
    assert.equal(peerById.get(id)!.isError, true, `forbidden topology field test id=${id} must reject`);
    assert.match(peerById.get(id)!.content[0].text, /zero topology fields/);
  }
  assert.equal(peerById.get(6)!.isError, true);
  assert.match(peerById.get(6)!.content[0].text, /requires `layer`/);
  assert.notEqual(peerById.get(7)!.isError, true, peerById.get(7)!.content[0].text);
  assert.match(peerById.get(7)!.content[0].text, /Status: HANDBACK/);
  assert.match(peerById.get(7)!.content[0].text, /Report: .*report-T-01-ask-/);
  for (const id of [8, 9, 10, 11]) {
    assert.notEqual(peerById.get(id)!.isError, true, peerById.get(id)!.content[0].text);
  }

  const projectAFactory = registry.factoryForProject(regA.slug);
  const asksA = projectAFactory.ledger.eventsFor("T-01").filter((e) => e.event === "peer_asked");
  assert.equal(asksA.length, 6);
  assert.equal(asksA[0]?.kind, "clarify");
  assert.equal(asksA[1]?.kind, "reopen_premise");
  assert.equal(asksA[1]?.source, "agent_claim");
  assert.equal(asksA[2]?.kind, "reopen_premise");
  assert.equal(asksA[2]?.layer, "API");
  assert.equal(asksA[2]?.source, "legacy_blocker");
  assert.equal(asksA[3]?.kind, "reopen_premise");
  assert.equal(asksA[3]?.layer, "verification");
  assert.equal(asksA[3]?.source, "legacy_blocker");
  assert.equal(asksA[4]?.kind, "dependency");
  assert.equal(asksA[4]?.source, "legacy_blocker");
  assert.equal(asksA[5]?.kind, "blocked");
  assert.equal(asksA[5]?.source, "legacy_blocker");

  // (c) lead_reply_peer requires message and persists kind: "ruling" + message in Ledger
  const leadReplyRes = await runMcpSession({
    args: ["--correlation", leadCorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
    cwd: regA.root,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lead_reply_peer", arguments: { task: "T-01", message: "   " } } },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "lead_reply_peer", arguments: { task: "T-01", agent: peerId, message: "Ruling: target GET /v1 instead." } },
      },
    ],
  });
  const replyBad = leadReplyRes[0].result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(replyBad.isError, true);
  assert.match(replyBad.content[0].text, /requires non-empty `message`/);
  const replyGood = leadReplyRes[1].result as { isError?: boolean; content: Array<{ text: string }> };
  assert.notEqual(replyGood.isError, true, replyGood.content[0].text);
  const repokes = projectAFactory.ledger.eventsFor("T-01").filter((e) => e.event === "repoke_dispatched");
  assert.equal(repokes.length, 1);
  assert.equal(repokes[0]?.kind, "ruling");
  assert.equal(repokes[0]?.message, "Ruling: target GET /v1 instead.");

  // (e) supervisor_read_ledger prints Loop Health both single-project AND multi-project without colliding T-01 across Projects
  const singleSupRes = await runMcpSession({
    args: ["--correlation", supACorr.correlationId, "--state-dir", stateDir, "--home", homeDir],
    cwd: regA.root,
    requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "supervisor_read_ledger", arguments: {} } }],
  });
  const singleText = (singleSupRes[0].result as { isError?: boolean; content: Array<{ text: string }> }).content[0].text;
  assert.match(singleText, /Loop Health:/);
  assert.match(singleText, /- tasks=1 peer_asked=6 \(100%\) · recontracts=0 red_attempts=0/);

  // Register a second project (repoB) that ALSO has task T-01
  const projectBFactory = registry.factoryForProject(regB.slug);
  projectBFactory.setContract({ task: "T-01", workspace: regB.root, gate: "true", description: brief4("Project B T-01") });

  const multiSupRes = await runMcpSession({
    args: ["--state-dir", stateDir, "--role", "supervisor", "--home", homeDir],
    cwd: dir, // unbound cwd outside both repoA and repoB
    requests: [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "supervisor_read_ledger", arguments: {} } }],
  });
  const multiSupToolRes = multiSupRes[0].result as { isError?: boolean; content: Array<{ text: string }> };
  assert.notEqual(multiSupToolRes.isError, true, multiSupToolRes.content[0].text);
  const multiText = multiSupToolRes.content[0].text;
  assert.match(multiText, new RegExp(`\\[${regA.slug}\\]`));
  assert.match(multiText, new RegExp(`\\[${regB.slug}\\]`));
  assert.match(multiText, /Loop Health:/);
  assert.match(multiText, /- tasks=2 peer_asked=6 \(50%\) · recontracts=0 red_attempts=0/);
});
