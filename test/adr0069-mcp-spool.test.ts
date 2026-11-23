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
import { createFactory } from "../plugin/server/core/factory.ts";
import { readLeadMailbox } from "../plugin/server/core/mailbox.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { writeProjectRegistration } from "../plugin/server/projects.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { createGateQueue } from "../plugin/server/gate-queue.ts";
import { handleSpoolRequest, parseSpoolRequest, settleClaimOutcome, spoolRootFor } from "../plugin/server/spool.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const FACTORY_BIN = resolve(import.meta.dirname, "../plugin/bin/factory.mjs");
const BRIDGE_BIN = resolve(import.meta.dirname, "../plugin/bin/bridge.mjs");

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

  const recordedAsks: Array<Record<string, unknown>> = [];
  const factoryWithAsk = Object.create(factory) as typeof factory & { recordPeerAsk: (input: Record<string, unknown>) => unknown };
  factoryWithAsk.recordPeerAsk = (input: Record<string, unknown>) => {
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

test("bridge.mjs handwritten handlers cover agent_ask, lead_reply_peer, legacy aliases, reopenConditions, handback, and Loop Health hook", async () => {
  const src = readFileSync(BRIDGE_BIN, "utf8");
  assert.match(src, /LEGACY_ROLE_TOOL_ALIASES/);
  assert.match(src, /name === "lead_reply_peer" \|\| name === "lead_repoke_agent"/);
  assert.match(src, /name === "agent_ask"/);
  assert.match(src, /kind: "peer_ask"/);
  assert.match(src, /reply\.status === "handback"/);
  assert.match(src, /formatLoopHealthBlock/);
  assert.match(src, /includeLoopHealth/);
  assert.match(src, /formatReopenIfBlock/);
  assert.match(src, /PEER_PREMISE_CHECK_REMINDER/);
  assert.equal(/\[Blocker on task/.test(src), false);
});
