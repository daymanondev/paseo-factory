import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { CorrelationRegistry } from "../plugin/server/core/correlations.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { taskWorktreePath } from "../plugin/server/core/workspace.ts";
import { projectStateDir, readLeadMailbox } from "../src/index.ts";
import { ensureProjectRegistered, readProjectRegistration, writeProjectRegistration } from "../plugin/server/projects.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { handleSpoolRequest, parseSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { createLeadMailRuntime, HANDOFF_EXTRACTION_TIMEOUT_MS, isBlockedByAttention } from "../plugin/server/lead-mailbox.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const POLL_MS = 20;

interface FakeAgent {
  id: string;
  title?: string;
  status?: string;
  provider?: string;
  labels?: Record<string, string>;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  cwd?: string;
  lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null;
}

function fakeDaemon(agents: FakeAgent[]) {
  const created: { config: { provider: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }[] = [];
  const sent: { agentId: string; text: string }[] = [];
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async (options) => {
        const filter = options?.filter;
        const kept = agents.filter((agent) => {
          if (filter?.labels !== undefined) {
            for (const [key, value] of Object.entries(filter.labels)) {
              if (agent.labels?.[key] !== value) return false;
            }
          }
          return true;
        });
        return {
          entries: kept.map((agent) => ({
            agent: {
              id: agent.id,
              provider: agent.provider ?? "pi/zai/glm-5.3",
              title: agent.title ?? null,
              status: agent.status ?? "idle",
              model: null,
              labels: agent.labels ?? {},
              archivedAt: null,
              requiresAttention: agent.requiresAttention ?? false,
              attentionReason: agent.attentionReason ?? null,
              updatedAt: "2026-10-20T00:00:00.000Z",
              cwd: agent.cwd ?? "/tmp",
              lastUsage: agent.lastUsage ?? null,
            },
          })),
        };
      },
      create: async (options) => {
        created.push({ config: options.config, cwd: options.cwd, title: options.title ?? "", labels: options.labels ?? {}, prompt: options.prompt });
        const id = `agent-created-${created.length}`;
        agents.push({ id, title: options.title ?? undefined, provider: options.config.provider, labels: options.labels, cwd: options.cwd });
        return { id };
      },
      ref: (id: string) => ({
        send: async (text: string) => {
          sent.push({ agentId: id, text });
        },
        archive: async () => {
          const at = agents.findIndex((agent) => agent.id === id);
          if (at !== -1) agents.splice(at, 1);
          return { archivedAt: new Date().toISOString() };
        },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "pi", available: true }] }),
      listModels: async () => ({ models: [] }),
    },
  };
  return { daemon, created, sent, agents };
}

function makeSpooledRuntime(t: TestContext, agents: FakeAgent[] = [], options?: { handoffTimeoutMs?: number }) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const projectRoot = join(dir, "repo");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "README.md"), "x\n");
  gitCommitAll(projectRoot);
  const resolved = resolveProject(projectRoot);
  assert.ok(resolved.ok);
  const slug = resolved.ok ? resolved.slug : "";

  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });
  writeProjectRegistration(stateDir, slug, { root: projectRoot });
  const fake = fakeDaemon(agents);
  const logs: string[] = [];
  const warnings: string[] = [];
  const surface = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon: fake.daemon,
    stopAgent: async () => ({ ok: true }),
    onLeadRetired: (input) => leadMail.settleLeadRotation(input.slug),
    onSeatKickoffSent: (input) => leadMail.markKickoffSent(input.agentId),
    leadDispatch: (request) => leadMail.dispatchLead(request),
  });
  const leadMail = createLeadMailRuntime({
    factory,
    stateDir,
    daemon: fake.daemon,
    ensureLead: (input) => surface.leadEnsure(input),
    ensureSupervisor: (input) => surface.supervisorEnsure(input),
    retireLead: (input) => surface.leadRotate(input),
    ...(options?.handoffTimeoutMs === undefined ? {} : { handoffTimeoutMs: options.handoffTimeoutMs }),
    onLog: (msg) => logs.push(msg),
    logger: { warn: (msg) => warnings.push(msg) },
  });
  const spool = startSpool(stateDir, factory, {
    pollMs: POLL_MS,
    leadDispatch: (request) => leadMail.dispatchLead(request),
    supervisorDispatch: (request) => leadMail.dispatchSupervisor(request),
    supervisorReport: (request) => leadMail.reportSupervisor(request),
    peerMail: leadMail.notifyPeer,
  });
  t.after(() => {
    spool.stop();
    leadMail.stop();
  });
  return { dir, home, stateDir, slug, projectRoot, factory, surface, leadMail, spool, fake, logs, warnings };
}

function dropRequest(spoolRoot: string, body: Record<string, unknown> & { id: string }): void {
  const requestsDir = join(spoolRoot, "requests");
  mkdirSync(requestsDir, { recursive: true });
  const path = join(requestsDir, `${body.id}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  renameSync(tmp, path);
}

function readReply(spoolRoot: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(spoolRoot, "replies", `${id}.json`), "utf8")) as Record<string, unknown>;
}

function readMailboxLines(stateDir: string, slug: string): Record<string, unknown>[] {
  const path = join(projectStateDir(stateDir, slug), "mailbox.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function until(assertion: () => void, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

test("parseSpoolRequest and handleSpoolRequest validate supervisor_dispatch and supervisor_report and refuse working Agents", async (t) => {
  assert.deepEqual(
    parseSpoolRequest({ id: "sd-1", kind: "supervisor_dispatch", workspace: "/w/repo", message: "Build feature X", seat: "supervisor" }),
    { id: "sd-1", kind: "supervisor_dispatch", workspace: "/w/repo", message: "Build feature X", seat: "supervisor" },
  );
  assert.deepEqual(
    parseSpoolRequest({ id: "sr-1", kind: "supervisor_report", project: "demo-123456", message: "Wave 1 complete", seat: "lead" }),
    { id: "sr-1", kind: "supervisor_report", project: "demo-123456", message: "Wave 1 complete", seat: "lead" },
  );
  for (const bad of [
    { id: "sd-bad", kind: "supervisor_dispatch" },
    { id: "sd-bad", kind: "supervisor_dispatch", message: "   " },
    { id: "sr-bad", kind: "supervisor_report", message: "" },
    { id: "sr-bad", kind: "supervisor_report", message: "ok", workspace: "  " },
  ]) {
    assert.equal(parseSpoolRequest(bad), undefined);
  }

  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  const agentDispatch = await handleSpoolRequest(factory, {
    id: "ag-sd",
    kind: "supervisor_dispatch",
    workspace: "/w",
    message: "try",
    seat: "agent",
  });
  assert.equal(agentDispatch.ok, false);
  if (!agentDispatch.ok) assert.equal(agentDispatch.code, "agent-cannot-orchestrate");

  const agentReport = await handleSpoolRequest(factory, {
    id: "ag-sr",
    kind: "supervisor_report",
    workspace: "/w",
    message: "try",
    seat: "agent",
  });
  assert.equal(agentReport.ok, false);
  if (!agentReport.ok) assert.equal(agentReport.code, "agent-cannot-orchestrate");
});

test("supervisor_dispatch from normal chat ensures Supervisor, delivers to=supervisor, and tells caller to stop turn immediately", async (t) => {
  const { stateDir, slug, projectRoot, fake } = makeSpooledRuntime(t);
  const spoolRoot = spoolRootFor(stateDir);

  dropRequest(spoolRoot, {
    id: "sup-disp-1",
    kind: "supervisor_dispatch",
    workspace: projectRoot,
    message: "Design and build the 2D platformer",
  });
  await until(() => {
    assert.equal(readReply(spoolRoot, "sup-disp-1").ok, true);
  });
  const reply = readReply(spoolRoot, "sup-disp-1");

  assert.equal(reply.project, slug);
  assert.equal(reply.supervisorAgentId, "agent-created-1");
  assert.match(String(reply.summary), /directive routed to Supervisor \(agent-created-1\)/);
  assert.match(String(reply.summary), /stop this turn immediately without editing files/);

  assert.equal(fake.created.length, 1);
  assert.deepEqual(fake.created[0]?.labels, { seat: "supervisor", project: slug });

  const events = readMailboxLines(stateDir, slug);
  assert.deepEqual(events.map((e) => e.type), ["mail_queued", "mail_delivered"]);
  assert.equal(events[0]?.to, "supervisor");
  assert.equal(events[0]?.from, "owner");
  assert.equal(events[0]?.kind, "directive");
  assert.equal(events[1]?.to, "supervisor");
  assert.equal(events[1]?.toAgentId, "agent-created-1");

  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0]?.agentId, "agent-created-1");
  assert.ok(fake.sent[0]?.text.includes("# Supervisor mailbox — 1 item"));
  assert.ok(fake.sent[0]?.text.includes("Design and build the 2D platformer"));
});

test("supervisor_dispatch from a normal chat agent records submitter in project.json dispatchers (deduplicated) and ignores reserved/seat submitters (v0.0.24, T-03)", async (t) => {
  const { stateDir, slug, projectRoot } = makeSpooledRuntime(t);
  const spoolRoot = spoolRootFor(stateDir);

  // 1. Normal chat session agent dispatches -> recorded in reg.dispatchers
  dropRequest(spoolRoot, {
    id: "sup-disp-chat-1",
    kind: "supervisor_dispatch",
    workspace: projectRoot,
    message: "Build the platformer",
    submitter: "chat-session-7c5ac02",
  });
  await until(() => {
    assert.equal(readReply(spoolRoot, "sup-disp-chat-1").ok, true);
  });
  let reg = readProjectRegistration(stateDir, slug);
  assert.deepEqual(reg?.dispatchers, ["chat-session-7c5ac02"]);

  // 2. Duplicate dispatch from the same chat session + dispatch from "owner" + dispatch from Supervisor agentId -> deduplicated, reserved ignored
  dropRequest(spoolRoot, {
    id: "sup-disp-chat-2",
    kind: "supervisor_dispatch",
    workspace: projectRoot,
    message: "Add sound effects",
    submitter: "chat-session-7c5ac02",
  });
  dropRequest(spoolRoot, {
    id: "sup-disp-owner",
    kind: "supervisor_dispatch",
    workspace: projectRoot,
    message: "Owner CLI dispatch",
    submitter: "owner",
  });
  dropRequest(spoolRoot, {
    id: "sup-disp-sup-id",
    kind: "supervisor_dispatch",
    workspace: projectRoot,
    message: "Supervisor self-id",
    submitter: reg?.supervisor ?? "agent-created-1",
  });
  await until(() => {
    assert.equal(readReply(spoolRoot, "sup-disp-chat-2").ok, true);
    assert.equal(readReply(spoolRoot, "sup-disp-owner").ok, true);
    assert.equal(readReply(spoolRoot, "sup-disp-sup-id").ok, true);
  });

  reg = readProjectRegistration(stateDir, slug);
  assert.deepEqual(reg?.dispatchers, ["chat-session-7c5ac02"], "dispatchers stays deduplicated and excludes owner and seat agentIds");
});

test("supervisor_dispatch from seat=supervisor transparently routes to Lead (to=lead, from=supervisor)", async (t) => {
  const { stateDir, slug, projectRoot, fake } = makeSpooledRuntime(t);
  const spoolRoot = spoolRootFor(stateDir);

  dropRequest(spoolRoot, {
    id: "sup-disp-2",
    kind: "supervisor_dispatch",
    workspace: projectRoot,
    message: "Implement the ratified spec in isolated task worktrees",
    seat: "supervisor",
  });
  await until(() => {
    assert.equal(readReply(spoolRoot, "sup-disp-2").ok, true);
  });
  const reply = readReply(spoolRoot, "sup-disp-2");

  assert.equal(reply.project, slug);
  assert.equal(reply.leadAgentId, "agent-created-1");
  assert.match(String(reply.summary), /directive dispatched to Lead \(agent-created-1\)/);
  assert.match(String(reply.summary), /end your turn now and wait for Lead's report/);

  assert.equal(fake.created.length, 1);
  assert.deepEqual(fake.created[0]?.labels, { seat: "lead", project: slug });

  const events = readMailboxLines(stateDir, slug);
  assert.deepEqual(events.map((e) => e.type), ["mail_queued", "mail_delivered"]);
  assert.equal(events[0]?.from, "supervisor");
  assert.equal(events[0]?.kind, "directive");
  assert.equal(events[1]?.toAgentId, "agent-created-1");
});

test("supervisor_report queues to=supervisor while Supervisor is busy, delivers on idle, and acks or requeues on Supervisor turn end", async (t) => {
  const supervisor: FakeAgent = {
    id: "agent-sup-1",
    title: "Supervisor (paseo-factory)",
    status: "running",
    labels: {},
  };
  const { stateDir, slug, projectRoot, leadMail, fake } = makeSpooledRuntime(t, [supervisor]);
  supervisor.labels = { seat: "supervisor", project: slug };
  const spoolRoot = spoolRootFor(stateDir);
  const mailboxPath = join(projectStateDir(stateDir, slug), "mailbox.jsonl");

  dropRequest(spoolRoot, {
    id: "sup-rep-1",
    kind: "supervisor_report",
    workspace: projectRoot,
    message: "Wave 1 (T-01..T-04) accepted and landed cleanly on main.",
    seat: "lead",
  });
  await until(() => {
    assert.equal(readReply(spoolRoot, "sup-rep-1").ok, true);
  });
  const reply = readReply(spoolRoot, "sup-rep-1");
  assert.equal(reply.project, slug);
  assert.equal(reply.supervisorAgentId, "agent-sup-1");
  assert.match(String(reply.summary), /report queued for Supervisor \(agent-sup-1\) — end your turn/);

  // Supervisor is running -> mail stays in supervisorQueued, not sent yet.
  assert.equal(fake.sent.length, 0);
  let state = readLeadMailbox(mailboxPath);
  assert.equal(state.supervisorQueued.length, 1);
  assert.equal(state.supervisorInFlight, null);

  // Supervisor's running turn completes -> onLeadTurnEnded pumps Supervisor once idle.
  supervisor.status = "idle";
  await leadMail.onLeadTurnEnded({ agentId: "agent-sup-1", outcome: { kind: "completed" }, timeline: [] });

  state = readLeadMailbox(mailboxPath);
  assert.equal(state.supervisorQueued.length, 0);
  assert.equal(state.supervisorInFlight?.toAgentId, "agent-sup-1");
  assert.equal(fake.sent.length, 1);
  assert.ok(fake.sent[0]?.text.includes("report from lead"));
  assert.ok(fake.sent[0]?.text.includes("Wave 1 (T-01..T-04) accepted and landed cleanly on main."));

  // If the delivery turn fails, onLeadTurnEnded requeues and re-delivers on idle.
  await leadMail.onLeadTurnEnded({ agentId: "agent-sup-1", outcome: { kind: "failed", error: { message: "net" } }, timeline: [] });
  assert.equal(fake.sent.length, 2, "failed Supervisor turn requeued and re-delivered");
  state = readLeadMailbox(mailboxPath);
  assert.equal(state.supervisorInFlight?.toAgentId, "agent-sup-1");

  // When Supervisor finishes the turn with outcome=completed, the delivery is acked.
  await leadMail.onLeadTurnEnded({ agentId: "agent-sup-1", outcome: { kind: "completed" }, timeline: [] });
  state = readLeadMailbox(mailboxPath);
  assert.equal(state.supervisorQueued.length, 0);
  assert.equal(state.supervisorInFlight, null);
  assert.equal(state.ackedCount, 1);
});

test("needs_human automatically notifies both Lead (to=lead) and Supervisor (to=supervisor)", async (t) => {
  const { stateDir, slug, projectRoot, factory, surface, fake } = makeSpooledRuntime(t);
  const spoolRoot = spoolRootFor(stateDir);

  const leadEnsured = await surface.leadEnsure({ projectRoot });
  const supEnsured = await surface.supervisorEnsure({ projectRoot });
  assert.ok(leadEnsured.ok && supEnsured.ok);

  factory.setContract({ task: "T-NH", workspace: projectRoot, gate: "true", artifact: "README.md" });
  const denialSeq = factory.ledger.append({
    event: "permit_denied",
    task: "T-NH",
    agent: "ag-worker",
    name: "Bash",
    kind: "tool",
    command: "git reset --hard",
    rule: "policy:S1-git-vocabulary",
    reason: "caught",
  }).seq;
  dropRequest(spoolRoot, { id: "rp-nh", kind: "repoke", task: "T-NH", agent: "ag-worker" });
  await until(() => {
    assert.equal(readReply(spoolRoot, "rp-nh").ok, true);
  });
  const repokeSeq = factory.ledger.events.find((e) => e.event === "repoke_dispatched")?.seq ?? 0;

  dropRequest(spoolRoot, {
    id: "nh-dual",
    kind: "needs_human",
    task: "T-NH",
    reason: "denied-again",
    evidence: { denial: denialSeq, repoke: repokeSeq },
  });
  await until(() => {
    assert.equal(readReply(spoolRoot, "nh-dual").ok, true);
  });

  const events = readMailboxLines(stateDir, slug);
  const queuedEvents = events.filter((e) => e.type === "mail_queued");
  assert.equal(queuedEvents.length, 2, "needs_human enqueues to both Lead and Supervisor");
  assert.equal(queuedEvents[0]?.to, undefined, "Lead slice omits to (default lead)");
  assert.equal(queuedEvents[1]?.to, "supervisor", "Supervisor slice sets to=supervisor");

  // Both idle Lead and idle Supervisor received their deliveries.
  assert.equal(fake.sent.some((s) => s.agentId === leadEnsured.agentId && s.text.includes("T-NH")), true);
  assert.equal(fake.sent.some((s) => s.agentId === supEnsured.agentId && s.text.includes("T-NH")), true);
});

test("needs_human before project.json exists registers project.json via ensureProjectRegistered, ensures Supervisor, and delivers to=supervisor (v0.0.23, T-07)", async (t) => {
  const { stateDir, slug, projectRoot, factory, fake } = makeSpooledRuntime(t);
  const spoolRoot = spoolRootFor(stateDir);
  rmSync(join(projectStateDir(stateDir, slug), "project.json"), { force: true });

  assert.equal(readProjectRegistration(stateDir, slug), undefined, "project.json does not exist yet");

  factory.setContract({ task: "T-NH-FRESH", workspace: projectRoot, gate: "true", artifact: "README.md" });
  const denialSeq = factory.ledger.append({
    event: "permit_denied",
    task: "T-NH-FRESH",
    agent: "ag-worker",
    name: "Bash",
    kind: "tool",
    command: "git reset --hard",
    rule: "policy:S1-git-vocabulary",
    reason: "caught",
  }).seq;
  dropRequest(spoolRoot, { id: "rp-nh-fresh", kind: "repoke", task: "T-NH-FRESH", agent: "ag-worker" });
  await until(() => {
    assert.equal(readReply(spoolRoot, "rp-nh-fresh").ok, true);
  });
  const repokeSeq = factory.ledger.events.find((e) => e.event === "repoke_dispatched")?.seq ?? 0;

  dropRequest(spoolRoot, {
    id: "nh-fresh",
    kind: "needs_human",
    task: "T-NH-FRESH",
    reason: "denied-again",
    evidence: { denial: denialSeq, repoke: repokeSeq },
  });
  await until(() => {
    assert.equal(readReply(spoolRoot, "nh-fresh").ok, true);
  });

  const resolved = resolveProject(projectRoot);
  assert.ok(resolved.ok);
  const reg = readProjectRegistration(stateDir, slug);
  assert.equal(reg?.root, resolved.root, "project.json was registered with root");
  assert.ok(reg?.supervisor !== undefined, "Supervisor was ensured on demand");
  assert.equal(
    fake.sent.some((s) => s.agentId === reg?.supervisor && s.text.includes("T-NH-FRESH")),
    true,
    "Supervisor received the needs_human delivery even when project.json was not previously written",
  );

  // Direct unit check of ensureProjectRegistered idempotence
  const ensuredAgain = ensureProjectRegistered(stateDir, projectRoot);
  assert.equal(ensuredAgain.ok, true);
  assert.equal(readProjectRegistration(stateDir, slug)?.supervisor, reg?.supervisor, "ensureProjectRegistered preserves existing seat fields");
});

test("isBlockedByAttention and mailbox drains only block on attentionReason='permission', never on attentionReason='error' (v0.0.24, T-02)", async (t) => {
  const baseAgent = {
    id: "ag-1",
    provider: "pi/zai/glm-5.3",
    title: "Lead",
    status: "idle",
    model: null,
    labels: {},
    archivedAt: null,
    updatedAt: "2026-10-20T00:00:00.000Z",
    cwd: "/tmp",
  };
  assert.equal(isBlockedByAttention({ ...baseAgent, requiresAttention: false, attentionReason: null }), false);
  assert.equal(isBlockedByAttention({ ...baseAgent, requiresAttention: true, attentionReason: "error" }), false);
  assert.equal(isBlockedByAttention({ ...baseAgent, requiresAttention: true, attentionReason: null }), false);
  assert.equal(isBlockedByAttention({ ...baseAgent, requiresAttention: false, attentionReason: "permission" }), false);
  assert.equal(isBlockedByAttention({ ...baseAgent, requiresAttention: true, attentionReason: "permission" }), true);

  const lead: FakeAgent = {
    id: "agent-lead-attn",
    title: "Lead (paseo-factory)",
    status: "idle",
    requiresAttention: true,
    attentionReason: "permission",
  };
  const supervisor: FakeAgent = {
    id: "agent-sup-attn",
    title: "Supervisor (paseo-factory)",
    status: "idle",
    requiresAttention: true,
    attentionReason: "permission",
  };
  const { stateDir, slug, leadMail, fake } = makeSpooledRuntime(t, [lead, supervisor]);
  lead.labels = { seat: "lead", project: slug };
  supervisor.labels = { seat: "supervisor", project: slug };
  const mailboxPath = join(projectStateDir(stateDir, slug), "mailbox.jsonl");

  await leadMail.enqueueLeadMail(slug, { to: "lead", from: "supervisor", kind: "directive", text: "Lead work" });
  await leadMail.enqueueLeadMail(slug, { to: "supervisor", from: "owner", kind: "directive", text: "Supervisor work" });

  // 1. Both have requiresAttention: true, attentionReason: "permission" -> held queued
  await leadMail.pumpProjectLead(slug);
  await leadMail.pumpProjectSupervisor(slug);
  assert.equal(fake.sent.length, 0, "permission attention blocks delivery to both Lead and Supervisor");
  let state = readLeadMailbox(mailboxPath);
  assert.equal(state.queued.length, 1);
  assert.equal(state.supervisorQueued.length, 1);

  // 2. Both switch to requiresAttention: true, attentionReason: "error" -> delivered!
  lead.attentionReason = "error";
  supervisor.attentionReason = "error";
  await leadMail.pumpProjectLead(slug);
  await leadMail.pumpProjectSupervisor(slug);

  assert.equal(fake.sent.length, 2, "error attention does NOT block mailbox delivery");
  state = readLeadMailbox(mailboxPath);
  assert.equal(state.queued.length, 0);
  assert.equal(state.inFlight?.toAgentId, "agent-lead-attn");
  assert.equal(state.supervisorQueued.length, 0);
  assert.equal(state.supervisorInFlight?.toAgentId, "agent-sup-attn");
});

test("onLeadTurnEnded performs a bounded 1-shot self-healing retry per mailId for both Lead and Supervisor and stops on a second failure (v0.0.24, T-02)", async (t) => {
  const { stateDir, slug, projectRoot, leadMail, fake, warnings } = makeSpooledRuntime(t);
  const mailboxPath = join(projectStateDir(stateDir, slug), "mailbox.jsonl");

  // --- Lead 1-shot self-healing retry ---
  const leadDisp = await leadMail.dispatchLead({
    id: "ld-retry-1",
    kind: "lead_dispatch",
    workspace: projectRoot,
    message: "Execute Wave 1",
  });
  assert.equal(leadDisp.ok, true);
  const leadId1 = leadDisp.ok ? leadDisp.leadAgentId ?? "" : "";
  assert.equal(leadId1, "agent-created-1");
  assert.equal(fake.sent.length, 1);

  // First Lead turn fails and leaves the Lead seat in status="error"
  const leadAgentObj = fake.agents.find((a) => a.id === leadId1);
  assert.ok(leadAgentObj);
  leadAgentObj.status = "error";
  await leadMail.onLeadTurnEnded({
    agentId: leadId1,
    outcome: { kind: "failed", error: { message: "Variant unavailable" } },
    timeline: [],
  });

  // First failure triggered 1-shot retry -> ensureLead self-healed the errored seat and re-delivered once
  let state = readLeadMailbox(mailboxPath);
  assert.equal(state.queued.length, 0);
  assert.ok(state.inFlight !== null, "first failure retried and re-delivered the batch");
  assert.equal(state.inFlight?.toAgentId, "agent-created-2", "ensureLead replaced the errored Lead seat on retry");
  assert.equal(fake.sent.length, 2);

  // Second failure on the SAME mailId -> requeued and held queued WITHOUT re-pumping
  const leadIdAfterFirstRetry = state.inFlight!.toAgentId;
  await leadMail.onLeadTurnEnded({
    agentId: leadIdAfterFirstRetry,
    outcome: { kind: "failed", error: { message: "Persistent crash" } },
    timeline: [],
  });

  state = readLeadMailbox(mailboxPath);
  assert.equal(state.inFlight, null, "second failure did NOT re-deliver");
  assert.equal(state.queued.length, 1, "mail stays queued after exhausting 1-shot retry");
  assert.equal(fake.sent.length, 2, "no third send occurred");
  assert.equal(warnings.length, 1, "logged a warning when retry limit was reached");

  // --- Supervisor 1-shot self-healing retry ---
  const supDisp = await leadMail.dispatchSupervisor({
    id: "sd-retry-1",
    kind: "supervisor_dispatch",
    workspace: projectRoot,
    message: "Plan the architecture",
  });
  assert.equal(supDisp.ok, true);
  const supId1 = supDisp.ok ? supDisp.supervisorAgentId ?? "" : "";
  assert.equal(supId1, "agent-created-3");
  assert.equal(fake.sent.length, 3);

  // First Supervisor turn fails and leaves the Supervisor seat in status="error" -> ensureSupervisor self-heals before drainSupervisorMailbox
  const supAgentObj = fake.agents.find((a) => a.id === supId1);
  assert.ok(supAgentObj);
  supAgentObj.status = "error";
  await leadMail.onLeadTurnEnded({
    agentId: supId1,
    outcome: { kind: "failed", error: { message: "Supervisor crash 1" } },
    timeline: [],
  });
  state = readLeadMailbox(mailboxPath);
  assert.equal(state.supervisorQueued.length, 0);
  assert.ok(state.supervisorInFlight !== null, "first Supervisor failure retried once");
  assert.equal(state.supervisorInFlight?.toAgentId, "agent-created-4", "ensureSupervisor replaced the errored Supervisor seat on retry");
  assert.equal(fake.sent.length, 4);

  // Second Supervisor turn fails on the same mailId -> requeues and holds WITHOUT re-pumping
  const supIdAfterFirstRetry = state.supervisorInFlight!.toAgentId;
  await leadMail.onLeadTurnEnded({
    agentId: supIdAfterFirstRetry,
    outcome: { kind: "failed", error: { message: "Supervisor crash 2" } },
    timeline: [],
  });
  state = readLeadMailbox(mailboxPath);
  assert.equal(state.supervisorInFlight, null, "second Supervisor failure did NOT re-deliver");
  assert.equal(state.supervisorQueued.length, 1, "Supervisor mail stays queued after exhausting 1-shot retry");
  assert.equal(fake.sent.length, 4, "no fifth send occurred");
  assert.equal(warnings.length, 2, "logged a warning when Supervisor retry limit was reached");

  // Direct order check: on a failed Supervisor turn, ensureSupervisor is invoked BEFORE drainSupervisorMailbox lists/sends
  const callOrder: string[] = [];
  const orderRuntime = createLeadMailRuntime({
    factory: createFactory({ stateDir: join(makeTempDir(), "order-state") }),
    stateDir,
    daemon: {
      ...fake.daemon,
      agents: {
        ...fake.daemon.agents,
        list: async (opts) => {
          if (opts?.filter?.labels?.seat === "supervisor") callOrder.push("drainSupervisorMailbox:list");
          return fake.daemon.agents.list(opts);
        },
      },
    },
    ensureLead: async () => ({ ok: true, agentId: "lead-x", created: false, projectRoot, slug }),
    ensureSupervisor: async () => {
      callOrder.push("ensureSupervisor");
      return { ok: true, agentId: supIdAfterFirstRetry, created: false, projectRoot, slug };
    },
    retireLead: async () => ({ ok: true, agentId: "lead-x" }),
  });
  await orderRuntime.enqueueLeadMail(slug, { to: "supervisor", from: "owner", kind: "directive", text: "Order check directive" });
  await orderRuntime.pumpProjectSupervisor(slug);
  callOrder.length = 0;
  await orderRuntime.onLeadTurnEnded({
    agentId: supIdAfterFirstRetry,
    outcome: { kind: "failed", error: { message: "Order check failure" } },
    timeline: [],
  });
  assert.equal(callOrder[0], "ensureSupervisor", "onLeadTurnEnded invokes ensureSupervisor before drainSupervisorMailbox on 1-shot retry");
  assert.ok(callOrder.includes("drainSupervisorMailbox:list"), "drainSupervisorMailbox ran after ensureSupervisor");
});

test("pumpAll pumps a registered Project's queued Lead and Supervisor mail exactly once (v0.0.31, ADR 0017 §5/§6)", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-1", title: "Lead", status: "idle", labels: {} };
  const { stateDir, slug, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };

  // Queued mail with no pump: enqueueLeadMail only appends mail_queued.
  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "pumpAll lead directive" });
  await leadMail.enqueueLeadMail(slug, { to: "supervisor", from: "owner", kind: "directive", text: "pumpAll supervisor directive" });
  assert.equal(fake.sent.length, 0, "enqueueing alone delivers nothing");

  // The boot capture's pump: every registered Project's Lead lane then
  // Supervisor lane, each queued batch delivered exactly once.
  await leadMail.pumpAll();

  assert.equal(fake.sent.length, 2, "one delivery per lane — Lead and Supervisor");
  assert.equal(fake.sent.filter((s) => s.text.includes("pumpAll lead directive")).length, 1, "the Lead's queued mail was pumped once");
  assert.equal(fake.sent.filter((s) => s.text.includes("pumpAll supervisor directive")).length, 1, "the Supervisor's queued mail was pumped once");

  const events = readMailboxLines(stateDir, slug);
  assert.equal(events.filter((e) => e.type === "mail_queued").length, 2);
  assert.equal(events.filter((e) => e.type === "mail_delivered").length, 2);

  // An empty-queue pumpAll is a no-op — never a re-delivery of the un-acked batch.
  await leadMail.pumpAll();
  assert.equal(fake.sent.length, 2, "a second pumpAll with nothing new queued sends nothing");
});

test("drainLeadMailbox auto-ensures Lead when absent/archived and notifyPeer ignores orphaned non-running worktree spawn_dispatched rounds (v0.0.31)", async (t) => {
  const { stateDir, slug, projectRoot, factory, leadMail, fake } = makeSpooledRuntime(t);

  // 1. Seed a stale spawn_dispatched round (T-15) with a worktree path that has NO running agent on the daemon,
  //    plus a live task T-08 that finishes GREEN.
  await factory.ledger.append({
    event: "contract_set",
    task: "T-15",
    workspace: projectRoot,
    gate: "true",
    artifact: "x.ts",
    scope: ["x.ts"],
  });
  await factory.ledger.append({
    event: "spawn_dispatched",
    task: "T-15",
    provider: "claude",
    arity: 1,
    worktree: join(projectRoot, ".worktrees/T-15"),
  });
  await factory.ledger.append({
    event: "contract_set",
    task: "T-08",
    workspace: projectRoot,
    gate: "true",
    artifact: "y.ts",
    scope: ["y.ts"],
  });

  // 2. No Lead agent exists yet (or previous Lead was archived). When T-08 notifies GREEN:
  //    - driverWaveInFlight sees no running agent for T-15's worktree and does NOT hold T-08's verdict.
  //    - drainLeadMailbox sees lead === undefined and auto-ensures Lead via ensureLead, delivering the verdict.
  await leadMail.notifyPeer({
    kind: "verdict",
    task: "T-08",
    text: "Task T-08 attempt 1 ended GREEN — note: all tests passed",
  });

  assert.equal(fake.created.length, 1, "drainLeadMailbox auto-created the missing Lead seat");
  assert.deepEqual(fake.created[0]?.labels, { seat: "lead", project: slug });
  assert.equal(fake.sent.length, 1, "peer verdict was delivered immediately without being held by dead T-15 spawn_dispatched");
  assert.match(fake.sent[0]?.text ?? "", /Task T-08 attempt 1 ended GREEN/);
});

test("resetProjectMailbox clears in-memory retry and handoff state for the target project slug (v0.0.24, T-02)", async (t) => {
  const { stateDir, slug, projectRoot, leadMail, fake } = makeSpooledRuntime(t);
  const mailboxPath = join(projectStateDir(stateDir, slug), "mailbox.jsonl");

  const leadDisp = await leadMail.dispatchLead({
    id: "ld-reset-1",
    kind: "lead_dispatch",
    workspace: projectRoot,
    message: "Initial directive",
  });
  assert.equal(leadDisp.ok, true);
  const leadId = leadDisp.ok ? leadDisp.leadAgentId ?? "" : "";

  // Exhaust 1-shot retry: fail twice so the mailId is recorded in retriedFailedMailIds and held queued
  await leadMail.onLeadTurnEnded({ agentId: leadId, outcome: { kind: "failed" }, timeline: [] });
  await leadMail.onLeadTurnEnded({ agentId: leadId, outcome: { kind: "failed" }, timeline: [] });
  let state = readLeadMailbox(mailboxPath);
  assert.equal(state.inFlight, null);
  assert.equal(state.queued.length, 1);
  assert.equal(fake.sent.length, 2);

  // Also set handing_over on project.json
  writeProjectRegistration(stateDir, slug, { root: projectRoot, rotationState: "handing_over", handoffRequestedAt: "2026-10-20T00:00:00.000Z" });

  // Reset the project mailbox state
  leadMail.resetProjectMailbox(slug);

  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, undefined, "resetProjectMailbox clears rotationState");
  assert.equal(readProjectRegistration(stateDir, slug)?.handoffRequestedAt, undefined, "resetProjectMailbox clears handoffRequestedAt");

  // Re-deliver the queued item and fail once: because resetProjectMailbox cleared retriedFailedMailIds for slug,
  // onLeadTurnEnded grants a fresh 1-shot retry instead of holding immediately!
  await leadMail.pumpProjectLead(slug);
  state = readLeadMailbox(mailboxPath);
  assert.equal(state.inFlight?.toAgentId, leadId);
  assert.equal(fake.sent.length, 3);

  await leadMail.onLeadTurnEnded({ agentId: leadId, outcome: { kind: "failed" }, timeline: [] });
  state = readLeadMailbox(mailboxPath);
  assert.equal(state.inFlight?.toAgentId, leadId, "fresh 1-shot retry was granted after resetProjectMailbox");
  assert.equal(fake.sent.length, 4);
});

test("drainSupervisorMailbox and drainLeadMailbox prepend the Seat kickoff packet on Turn 1 of each seat agentId and omit it on subsequent turns (v0.0.26, ADR 0016)", async (t) => {
  const { slug, projectRoot, leadMail, surface, fake } = makeSpooledRuntime(t);

  // 1. First Supervisor delivery includes the Seat kickoff packet
  await leadMail.dispatchSupervisor({
    id: "sd-kickoff-1",
    kind: "supervisor_dispatch",
    workspace: projectRoot,
    message: "First Supervisor directive",
  });
  assert.equal(fake.sent.length, 1);
  const supId = fake.sent[0]!.agentId;
  assert.match(fake.sent[0]!.text, /\[paseo-factory seat kickoff packet · role=supervisor/);
  assert.match(fake.sent[0]!.text, /First Supervisor directive/);

  // Complete Turn 1 and send Turn 2 to the SAME Supervisor agentId -> kickoff packet is omitted
  await leadMail.onLeadTurnEnded({ agentId: supId, outcome: { kind: "completed" }, timeline: [] });
  await leadMail.dispatchSupervisor({
    id: "sd-kickoff-2",
    kind: "supervisor_dispatch",
    workspace: projectRoot,
    message: "Second Supervisor directive",
  });
  assert.equal(fake.sent.length, 2);
  assert.doesNotMatch(fake.sent[1]!.text, /\[paseo-factory seat kickoff packet/);
  assert.match(fake.sent[1]!.text, /Second Supervisor directive/);

  // 2. First Lead delivery includes the Seat kickoff packet
  await leadMail.dispatchLead({
    id: "ld-kickoff-1",
    kind: "lead_dispatch",
    workspace: projectRoot,
    message: "First Lead directive",
  });
  assert.equal(fake.sent.length, 3);
  const leadId = fake.sent[2]!.agentId;
  assert.match(fake.sent[2]!.text, /\[paseo-factory seat kickoff packet · role=lead/);
  assert.match(fake.sent[2]!.text, /First Lead directive/);

  // Complete Turn 1 and send Turn 2 to the SAME Lead agentId -> kickoff packet is omitted
  await leadMail.onLeadTurnEnded({ agentId: leadId, outcome: { kind: "completed" }, timeline: [] });
  await leadMail.dispatchLead({
    id: "ld-kickoff-2",
    kind: "lead_dispatch",
    workspace: projectRoot,
    message: "Second Lead directive",
  });
  assert.equal(fake.sent.length, 4);
  assert.doesNotMatch(fake.sent[3]!.text, /\[paseo-factory seat kickoff packet/);
  assert.match(fake.sent[3]!.text, /Second Lead directive/);

  // 3. If a seat's cwd drifts away from projectRoot, ensureSeat retires and recreates it, and the new seat gets a fresh kickoff packet
  await leadMail.onLeadTurnEnded({ agentId: leadId, outcome: { kind: "completed" }, timeline: [] });
  const liveLead = fake.agents.find((a) => a.id === leadId);
  assert.ok(liveLead);
  liveLead.cwd = "/wrong/project/root";
  const reEnsured = await surface.leadEnsure({ projectRoot });
  assert.ok(reEnsured.ok);
  assert.equal(reEnsured.created, true, "mismatched cwd seat is retired and recreated");
  assert.notEqual(reEnsured.agentId, leadId);
});

test("completeHandoff resolves Attempt-1 working Agents via live daemon worktree cwd/labels, CorrelationRegistry, and ignores stale records after a contract_set epoch reset (v0.0.28, ADR 0018 §1)", async (t) => {
  const lead: FakeAgent = {
    id: "agent-lead-1",
    title: "Lead (paseo-factory)",
    status: "idle",
    labels: {},
    lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
  };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  const seated = await surface.leadEnsure({ projectRoot });
  assert.ok(seated.ok && seated.agentId === "agent-lead-1");

  const resolvedRoot = resolveProject(projectRoot);
  assert.ok(resolvedRoot.ok);
  const canonicalRoot = resolvedRoot.root;

  // 1. T-WT: Attempt-1 worker standing inside the Task worktree cwd (no claim yet)
  factory.setContract({ task: "T-WT", workspace: canonicalRoot, gate: "true", artifact: "README.md", scope: ["wt/**"] });
  fake.agents.push({
    id: "agent-wt-1",
    status: "running",
    cwd: join(taskWorktreePath(stateDir, slug, "T-WT"), "src"),
  });

  // 2. T-LABEL: Attempt-1 worker bound by labels { project: slug, task: "T-LABEL" } (no claim yet)
  factory.setContract({ task: "T-LABEL", workspace: canonicalRoot, gate: "true", artifact: "README.md", scope: ["label/**"] });
  fake.agents.push({
    id: "agent-label-1",
    status: "running",
    labels: { project: slug, task: "T-LABEL" },
    cwd: "/tmp",
  });

  // 3. T-CORR: Attempt-1 worker recorded in CorrelationRegistry (no claim yet)
  factory.setContract({ task: "T-CORR", workspace: canonicalRoot, gate: "true", artifact: "README.md", scope: ["corr/**"] });
  const registry = new CorrelationRegistry(stateDir);
  registry.issue({
    role: "agent",
    projectSlug: slug,
    projectRoot: canonicalRoot,
    task: "T-CORR",
    agentId: "agent-corr-1",
    issuedAt: new Date(Date.now() + 10).toISOString(),
  });
  fake.agents.push({
    id: "agent-corr-1",
    status: "running",
    cwd: "/tmp",
  });

  // 4. T-RESET-UNBOUND: had an Epoch-1 correlation + claim, then contract was reset with no new worker
  factory.setContract({ task: "T-RESET-UNBOUND", workspace: canonicalRoot, gate: "true", artifact: "README.md", scope: ["reset1/**"] });
  registry.issue({
    role: "agent",
    projectSlug: slug,
    projectRoot: canonicalRoot,
    task: "T-RESET-UNBOUND",
    agentId: "agent-stale-epoch1",
    issuedAt: "2020-01-01T00:00:00.000Z",
  });
  factory.ledger.append({
    event: "repoke_dispatched",
    task: "T-RESET-UNBOUND",
    agent: "agent-stale-epoch1",
    message: "fix",
  });
  // Reset contract (new epoch)
  factory.setContract({ task: "T-RESET-UNBOUND", workspace: canonicalRoot, gate: "true", artifact: "README.md", scope: ["reset1/**"] });

  // 5. T-RESET-REBOUND: had an Epoch-1 correlation, reset contract, then bound a new Epoch-2 worker in CorrelationRegistry
  factory.setContract({ task: "T-RESET-REBOUND", workspace: canonicalRoot, gate: "true", artifact: "README.md", scope: ["reset2/**"] });
  registry.issue({
    role: "agent",
    projectSlug: slug,
    projectRoot: canonicalRoot,
    task: "T-RESET-REBOUND",
    agentId: "agent-old-epoch1",
    issuedAt: "2020-01-01T00:00:00.000Z",
  });
  factory.setContract({ task: "T-RESET-REBOUND", workspace: canonicalRoot, gate: "true", artifact: "README.md", scope: ["reset2/**"] });
  registry.issue({
    role: "agent",
    projectSlug: slug,
    projectRoot: canonicalRoot,
    task: "T-RESET-REBOUND",
    agentId: "agent-new-epoch2",
    issuedAt: new Date(Date.now() + 50).toISOString(),
  });
  fake.agents.push({
    id: "agent-new-epoch2",
    status: "running",
    cwd: "/tmp",
  });

  // Trigger handoff: turn 1 ends at 135k -> locks handing_over -> turn 2 ends -> completes handoff
  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-1", outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");

  await leadMail.onLeadTurnEnded({
    agentId: "agent-lead-1",
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "# Handoff\nAttempt-1 workers active." }],
  });

  const successorId = readProjectRegistration(stateDir, slug)?.lead;
  assert.ok(successorId && successorId !== "agent-lead-1");
  const kickoff = fake.sent.find((s) => s.agentId === successorId && s.text.includes("Machine-Verified Active Peer Roster"));
  assert.ok(kickoff, "successor Lead received Machine-Verified Active Peer Roster");

  assert.match(kickoff.text, /task T-WT: .*agent agent-wt-1 \(live: running\)/);
  assert.match(kickoff.text, /task T-LABEL: .*agent agent-label-1 \(live: running\)/);
  assert.match(kickoff.text, /task T-CORR: .*agent agent-corr-1 \(live: running\)/);
  assert.match(kickoff.text, /task T-RESET-UNBOUND: .*agent \(none bound\)/);
  assert.doesNotMatch(kickoff.text, /agent-stale-epoch1/);
  assert.match(kickoff.text, /task T-RESET-REBOUND: .*agent agent-new-epoch2 \(live: running\)/);
  assert.doesNotMatch(kickoff.text, /agent-old-epoch1/);
});

test("completeHandoff delivers a unified single-turn kickoff (Seat kickoff packet + Lead handoff bundle + queued mail) with silent seat creation when mail is queued during handing_over (v0.0.28, ADR 0018 §2)", async (t) => {
  const lead: FakeAgent = {
    id: "agent-lead-1",
    title: "Lead (paseo-factory)",
    status: "idle",
    labels: {},
    lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
  };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  const seated = await surface.leadEnsure({ projectRoot });
  assert.ok(seated.ok && seated.agentId === "agent-lead-1");

  // Begin handoff on turn end at >= 128k
  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-1", outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");

  // Enqueue two directives while handing_over
  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Queued directive A" });
  await leadMail.enqueueLeadMail(slug, { from: "owner", kind: "directive", text: "Queued directive B" });

  // Complete handoff
  await leadMail.onLeadTurnEnded({
    agentId: "agent-lead-1",
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "# Handoff\nContinue with Wave 2." }],
  });

  // 1. Successor Lead was created silently (prompt === undefined on agents.create)
  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0]!.prompt, undefined, "successor Lead created silently with no bootstrap prompt in agents.create");
  const successorId = fake.created[0] ? `agent-created-1` : "";
  assert.equal(readProjectRegistration(stateDir, slug)?.lead, successorId);

  // 2. Successor Lead received EXACTLY ONE send(...) call combining Seat kickoff packet + Lead handoff bundle + queued mail batch
  const successorSends = fake.sent.filter((s) => s.agentId === successorId);
  assert.equal(successorSends.length, 1, "successor Lead received exactly 1 unified Turn-1 send(...) call");
  const unifiedText = successorSends[0]!.text;
  const kickoffIdx = unifiedText.indexOf("[paseo-factory seat kickoff packet · role=lead");
  const handoffIdx = unifiedText.indexOf("# Lead handoff — project");
  const mailIdx = unifiedText.indexOf("# Lead mailbox — 2 items");
  assert.ok(kickoffIdx !== -1, "Turn-1 prompt contains Seat kickoff packet");
  assert.ok(handoffIdx > kickoffIdx, "Lead handoff bundle follows Seat kickoff packet");
  assert.ok(mailIdx > handoffIdx, "Queued Lead mailbox batch follows Lead handoff bundle");
  assert.match(unifiedText, /# Handoff\nContinue with Wave 2\./);
  assert.match(unifiedText, /Queued directive A/);
  assert.match(unifiedText, /Queued directive B/);

  // 3. Subsequent mailbox delivery after Turn 1 completes does NOT repeat the kickoff packet or handoff bundle
  await leadMail.onLeadTurnEnded({ agentId: successorId, outcome: { kind: "completed" }, timeline: [] });
  await leadMail.dispatchLead({
    id: "ld-after-handoff",
    kind: "lead_dispatch",
    workspace: projectRoot,
    message: "Turn 2 follow-up directive",
  });
  const successorSendsAfterTurn2 = fake.sent.filter((s) => s.agentId === successorId);
  assert.equal(successorSendsAfterTurn2.length, 2);
  assert.doesNotMatch(successorSendsAfterTurn2[1]!.text, /\[paseo-factory seat kickoff packet/);
  assert.doesNotMatch(successorSendsAfterTurn2[1]!.text, /# Lead handoff — project/);
  assert.match(successorSendsAfterTurn2[1]!.text, /Turn 2 follow-up directive/);
});

test("completeHandoff delivers Seat kickoff packet + Lead handoff bundle in a single Turn-1 send when no mail is queued, and subsequent mail omits the kickoff packet (v0.0.28, ADR 0018 §2)", async (t) => {
  const lead: FakeAgent = {
    id: "agent-lead-1",
    title: "Lead (paseo-factory)",
    status: "idle",
    labels: {},
    lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
  };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  // Begin and complete handoff with ZERO queued mail items
  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-1", outcome: { kind: "completed" }, timeline: [] });
  await leadMail.onLeadTurnEnded({
    agentId: "agent-lead-1",
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "# Handoff\nNo mail waiting." }],
  });

  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0]!.prompt, undefined);
  const successorId = "agent-created-1";

  const successorSends = fake.sent.filter((s) => s.agentId === successorId);
  assert.equal(successorSends.length, 1, "successor Lead received exactly 1 Turn-1 send(...) call even with empty mailbox");
  const turn1Text = successorSends[0]!.text;
  assert.match(turn1Text, /\[paseo-factory seat kickoff packet · role=lead/);
  assert.match(turn1Text, /# Lead handoff — project/);
  assert.match(turn1Text, /# Handoff\nNo mail waiting\./);
  assert.doesNotMatch(turn1Text, /# Lead mailbox/);

  // Dispatch mail later -> Turn 2 omits Seat kickoff packet and Lead handoff bundle
  await leadMail.dispatchLead({
    id: "ld-later",
    kind: "lead_dispatch",
    workspace: projectRoot,
    message: "Later directive",
  });
  const allSuccessorSends = fake.sent.filter((s) => s.agentId === successorId);
  assert.equal(allSuccessorSends.length, 2);
  assert.doesNotMatch(allSuccessorSends[1]!.text, /\[paseo-factory seat kickoff packet/);
  assert.doesNotMatch(allSuccessorSends[1]!.text, /# Lead handoff — project/);
  assert.match(allSuccessorSends[1]!.text, /Later directive/);

  // Explicit message on supervisorEnsure marks kickoffSentAgentIds via onSeatKickoffSent
  const supEnsured = await surface.supervisorEnsure({ projectRoot, message: "Explicit ratify message" });
  assert.ok(supEnsured.ok);
  const supId = supEnsured.agentId;
  await leadMail.dispatchSupervisor({
    id: "sd-after-explicit",
    kind: "supervisor_dispatch",
    workspace: projectRoot,
    message: "Supervisor follow-up",
  });
  const supSends = fake.sent.filter((s) => s.agentId === supId);
  assert.equal(supSends.length, 2);
  assert.equal(supSends[0]!.text, "Explicit ratify message");
  assert.doesNotMatch(supSends[1]!.text, /\[paseo-factory seat kickoff packet/, "onSeatKickoffSent marked Supervisor kickoff sent");
  assert.match(supSends[1]!.text, /Supervisor follow-up/);
});

test("Fuse 1: beginHandoff immediately completes handoff when extraction prompt send throws, outgoing Lead is in status='error', or outgoing Lead is absent (v0.0.28, ADR 0018 §3)", async (t) => {
  assert.equal(HANDOFF_EXTRACTION_TIMEOUT_MS, 90_000);

  // Case A: send(extractionPrompt) throws during beginHandoff
  {
    const lead: FakeAgent = {
      id: "agent-lead-throw",
      title: "Lead (paseo-factory)",
      status: "idle",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
    };
    const supervisor: FakeAgent = {
      id: "agent-sup-1",
      title: "Supervisor (paseo-factory)",
      status: "idle",
      labels: {},
    };
    const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead, supervisor]);
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    supervisor.labels = { seat: "supervisor", project: slug };
    supervisor.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });
    await surface.supervisorEnsure({ projectRoot });

    const resolvedRoot = resolveProject(projectRoot);
    assert.ok(resolvedRoot.ok);
    factory.setContract({ task: "T-FUSE1", workspace: resolvedRoot.root, gate: "true", artifact: "README.md" });

    // Queue a directive while Lead is running its turn
    await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Continue after send throw" });

    // Make send throw for the outgoing Lead
    const origRef = fake.daemon.agents.ref.bind(fake.daemon.agents);
    fake.daemon.agents.ref = (id: string) => {
      const base = origRef(id);
      if (id === "agent-lead-throw") {
        return {
          ...base,
          send: async () => {
            throw new Error("daemon send socket closed");
          },
        };
      }
      return base;
    };

    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-throw", outcome: { kind: "completed" }, timeline: [] });

    // Fuse 1 completed handoff in the same turn: rotationState is back to normal, successor Lead spawned and received held mail + fallback note
    const reg = readProjectRegistration(stateDir, slug);
    assert.equal(reg?.rotationState, "normal");
    assert.equal(reg?.handoffRequestedAt, undefined);
    const successorId = reg?.lead;
    assert.ok(successorId && successorId !== "agent-lead-throw");

    const successorSends = fake.sent.filter((s) => s.agentId === successorId);
    assert.equal(successorSends.length, 1);
    assert.match(
      successorSends[0]!.text,
      /\(the outgoing Lead was interrupted during handoff extraction — rely on the Machine-Verified Active Peer Roster and Ledger State Digest above\)/,
    );
    assert.match(successorSends[0]!.text, /task T-FUSE1/);
    assert.match(successorSends[0]!.text, /Continue after send throw/);

    // Supervisor was never paged
    assert.equal(fake.sent.filter((s) => s.agentId === "agent-sup-1").length, 0);
  }

  // Case B: outgoing Lead is in status === "error" at >= 128k turn end
  {
    const lead: FakeAgent = {
      id: "agent-lead-err",
      title: "Lead (paseo-factory)",
      status: "error",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 140_000, contextWindowMaxTokens: 200_000 },
    };
    const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    writeProjectRegistration(stateDir, slug, { root: projectRoot, lead: "agent-lead-err" });

    await leadMail.enqueueLeadMail(slug, { from: "owner", kind: "directive", text: "Directive for errored Lead handoff" });
    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-err", outcome: { kind: "failed" }, timeline: [] });

    const reg = readProjectRegistration(stateDir, slug);
    assert.equal(reg?.rotationState, "normal");
    const successorId = reg?.lead;
    assert.ok(successorId && successorId !== "agent-lead-err");
    assert.equal(fake.sent.filter((s) => s.agentId === "agent-lead-err").length, 0, "errored Lead was never sent the extraction prompt");

    const successorSends = fake.sent.filter((s) => s.agentId === successorId);
    assert.equal(successorSends.length, 1);
    assert.match(
      successorSends[0]!.text,
      /\(the outgoing Lead was interrupted during handoff extraction — rely on the Machine-Verified Active Peer Roster and Ledger State Digest above\)/,
    );
    assert.match(successorSends[0]!.text, /Directive for errored Lead handoff/);
    void surface;
  }

  // Case C: outgoing Lead is already absent (no live Lead -> retireLead returns code === "no-lead")
  {
    const { stateDir, slug, projectRoot, leadMail, fake } = makeSpooledRuntime(t, []);
    writeProjectRegistration(stateDir, slug, {
      root: projectRoot,
      lead: "agent-lead-missing",
      rotationState: "rotation_pending",
    });

    await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Directive when outgoing Lead vanished" });
    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-missing", outcome: { kind: "failed" }, timeline: [] });

    const reg = readProjectRegistration(stateDir, slug);
    assert.equal(reg?.rotationState, "normal");
    const successorId = reg?.lead;
    assert.ok(successorId && successorId !== "agent-lead-missing", "absent outgoing Lead treated as retired and successor spawned");

    const successorSends = fake.sent.filter((s) => s.agentId === successorId);
    assert.equal(successorSends.length, 1);
    assert.match(
      successorSends[0]!.text,
      /\(the outgoing Lead was interrupted during handoff extraction — rely on the Machine-Verified Active Peer Roster and Ledger State Digest above\)/,
    );
    assert.match(successorSends[0]!.text, /Directive when outgoing Lead vanished/);
  }
});

test("Fuse 2: handing_over timeout (via scheduled timer and via pumpProjectLead) retires stuck Lead, spawns successor Lead with interrupted-extraction fallback note, resets rotationState, and drains held mail without paging Supervisor (v0.0.28, ADR 0018 §3)", async (t) => {
  // Case A: Scheduled timer fires after handoffTimeoutMs (40ms) when outgoing Lead hangs during extraction
  {
    const lead: FakeAgent = {
      id: "agent-lead-stuck",
      title: "Lead (paseo-factory)",
      status: "idle",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
    };
    const supervisor: FakeAgent = {
      id: "agent-sup-1",
      title: "Supervisor (paseo-factory)",
      status: "idle",
      labels: {},
    };
    const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead, supervisor], {
      handoffTimeoutMs: 40,
    });
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    supervisor.labels = { seat: "supervisor", project: slug };
    supervisor.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });
    await surface.supervisorEnsure({ projectRoot });

    const resolvedRoot = resolveProject(projectRoot);
    assert.ok(resolvedRoot.ok);
    factory.setContract({ task: "T-FUSE2-TIMER", workspace: resolvedRoot.root, gate: "true", artifact: "README.md" });

    // Seed an older stale lead-handoff.md before beginHandoff so we verify stale handoffs are ignored on timeout
    const handoffPath = join(projectStateDir(stateDir, slug), "lead-handoff.md");
    mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
    writeFileSync(handoffPath, "# Stale Handoff From Yesterday\nDo not use.");
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Turn ends at 135k -> locks handing_over and sends extraction prompt to agent-lead-stuck
    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-stuck", outcome: { kind: "completed" }, timeline: [] });
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
    assert.equal(fake.sent.filter((s) => s.agentId === "agent-lead-stuck").length, 1, "extraction prompt was sent");

    // Enqueue mail while stuck in handing_over (without pumping after timeout — the scheduled timer alone must trip)
    await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Held mail drained by timer fuse" });

    // Wait for the 40ms timer fuse to fire and complete handoff
    await until(() => {
      assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal");
    }, 2000);

    const reg = readProjectRegistration(stateDir, slug);
    const successorId = reg?.lead;
    assert.ok(successorId && successorId !== "agent-lead-stuck");
    assert.equal(fake.agents.some((a) => a.id === "agent-lead-stuck"), false, "stuck outgoing Lead was archived");

    const successorSends = fake.sent.filter((s) => s.agentId === successorId);
    assert.equal(successorSends.length, 1);
    assert.match(
      successorSends[0]!.text,
      /\(the outgoing Lead was interrupted during handoff extraction — rely on the Machine-Verified Active Peer Roster and Ledger State Digest above\)/,
    );
    assert.doesNotMatch(successorSends[0]!.text, /Stale Handoff From Yesterday/);
    assert.match(successorSends[0]!.text, /task T-FUSE2-TIMER/);
    assert.match(successorSends[0]!.text, /Held mail drained by timer fuse/);
    assert.equal(fake.sent.filter((s) => s.agentId === "agent-sup-1").length, 0, "Supervisor was not paged");
  }

  // Case B: pumpProjectLead immediately trips Fuse 2 when handing_over has exceeded handoffTimeoutMs
  {
    const lead: FakeAgent = {
      id: "agent-lead-pump-fuse",
      title: "Lead (paseo-factory)",
      status: "running",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 150_000, contextWindowMaxTokens: 200_000 },
    };
    const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead], {
      handoffTimeoutMs: 5_000,
    });
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });

    // Simulate a project locked in handing_over 10 seconds ago (> 5_000ms handoffTimeoutMs)
    const elapsedIso = new Date(Date.now() - 10_000).toISOString();
    writeProjectRegistration(stateDir, slug, {
      root: projectRoot,
      lead: "agent-lead-pump-fuse",
      rotationState: "handing_over",
      handoffRequestedAt: elapsedIso,
    });
    await leadMail.enqueueLeadMail(slug, { from: "owner", kind: "directive", text: "Held mail drained by pump fuse" });

    // Pumping immediately trips the fuse on projectLane(slug) without waiting for any timer
    await leadMail.pumpProjectLead(slug);

    const reg = readProjectRegistration(stateDir, slug);
    assert.equal(reg?.rotationState, "normal");
    assert.equal(reg?.handoffRequestedAt, undefined);
    const successorId = reg?.lead;
    assert.ok(successorId && successorId !== "agent-lead-pump-fuse");

    const successorSends = fake.sent.filter((s) => s.agentId === successorId);
    assert.equal(successorSends.length, 1);
    assert.match(
      successorSends[0]!.text,
      /\(the outgoing Lead was interrupted during handoff extraction — rely on the Machine-Verified Active Peer Roster and Ledger State Digest above\)/,
    );
    assert.match(successorSends[0]!.text, /Held mail drained by pump fuse/);
  }

  // Case C: Fuse 2 preserves a fresh lead-handoff.md written after handoffRequestedAt if the Lead wrote the file before stalling
  {
    const lead: FakeAgent = {
      id: "agent-lead-partial-write",
      title: "Lead (paseo-factory)",
      status: "running",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 150_000, contextWindowMaxTokens: 200_000 },
    };
    const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead], {
      handoffTimeoutMs: 5_000,
    });
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });

    const elapsedIso = new Date(Date.now() - 10_000).toISOString();
    writeProjectRegistration(stateDir, slug, {
      root: projectRoot,
      lead: "agent-lead-partial-write",
      rotationState: "handing_over",
      handoffRequestedAt: elapsedIso,
    });
    const handoffPath = join(projectStateDir(stateDir, slug), "lead-handoff.md");
    mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
    writeFileSync(handoffPath, "# Fresh Handoff Written Before Timeout\nRoadmap intact.");

    await leadMail.pumpProjectLead(slug);

    const successorId = readProjectRegistration(stateDir, slug)?.lead;
    assert.ok(successorId && successorId !== "agent-lead-partial-write");
    const successorSends = fake.sent.filter((s) => s.agentId === successorId);
    assert.equal(successorSends.length, 1);
    assert.match(successorSends[0]!.text, /# Fresh Handoff Written Before Timeout\nRoadmap intact\./);
  }
});

test("Paseo 0.13.0 compatibility: completeHandoff refetches tail timeline via daemon.agents.ref(id).timeline.refetch when agent.turn_ended timeline is empty, and paseo-plugin.json uses open-ended >=0.13.0 requirement (v0.0.39, ADR 0027)", async (t) => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "plugin", "paseo-plugin.json"), "utf8")) as {
    requirements?: { paseo?: string };
  };
  assert.equal(manifest.requirements?.paseo, ">=0.13.0");

  const lead: FakeAgent = {
    id: "agent-lead-013",
    title: "Lead",
    status: "idle",
    labels: {},
    lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
  };
  const { slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  const refetchCalls: { id: string; opts: unknown }[] = [];
  const origRef = fake.daemon.agents.ref.bind(fake.daemon.agents);
  fake.daemon.agents.ref = (id: string) => {
    const base = origRef(id);
    if (id === "agent-lead-013") {
      return {
        ...base,
        timeline: {
          refetch: async (opts?: { direction?: "tail" | "head"; limit?: number }) => {
            refetchCalls.push({ id, opts });
            return {
              entries: [
                { item: { type: "user_message", text: "Extract handoff" } },
                { item: { type: "assistant_message", text: "# Handoff from Paseo 0.13.0 tail refetch\nWave 2 ready." } },
              ],
            };
          },
        },
      };
    }
    return base;
  };

  // Turn 1 ends at 135k -> enters handing_over
  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-013", outcome: { kind: "completed" }, timeline: [] });
  // Extraction turn ends with Paseo 0.13.0's always-empty timeline: []
  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-013", outcome: { kind: "completed" }, timeline: [] });

  assert.equal(refetchCalls.length, 1);
  assert.deepEqual(refetchCalls[0], { id: "agent-lead-013", opts: { direction: "tail", limit: 20 } });

  const successorId = "agent-created-1";
  const successorSends = fake.sent.filter((s) => s.agentId === successorId);
  assert.equal(successorSends.length, 1);
  assert.match(successorSends[0]!.text, /# Handoff from Paseo 0\.13\.0 tail refetch\nWave 2 ready\./);
});









