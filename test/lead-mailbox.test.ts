import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { projectStateDir, readLeadMailbox } from "../src/index.ts";
import { ensureProjectRegistered, readProjectRegistration, writeProjectRegistration } from "../plugin/server/projects.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { handleSpoolRequest, parseSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { createLeadMailRuntime, isBlockedByAttention } from "../plugin/server/lead-mailbox.ts";
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

function makeSpooledRuntime(t: TestContext, agents: FakeAgent[] = []) {
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
    leadDispatch: (request) => leadMail.dispatchLead(request),
  });
  const leadMail = createLeadMailRuntime({
    factory,
    stateDir,
    daemon: fake.daemon,
    ensureLead: (input) => surface.leadEnsure(input),
    ensureSupervisor: (input) => surface.supervisorEnsure(input),
    retireLead: (input) => surface.leadRotate(input),
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
  t.after(() => spool.stop());
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
  assert.equal(fake.sent.length, 3);

  // First Supervisor turn fails -> requeues and retries once
  await leadMail.onLeadTurnEnded({
    agentId: supId1,
    outcome: { kind: "failed", error: { message: "Supervisor crash 1" } },
    timeline: [],
  });
  state = readLeadMailbox(mailboxPath);
  assert.equal(state.supervisorQueued.length, 0);
  assert.ok(state.supervisorInFlight !== null, "first Supervisor failure retried once");
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




