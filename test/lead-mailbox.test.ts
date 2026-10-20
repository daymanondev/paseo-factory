import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { projectStateDir, readLeadMailbox } from "../src/index.ts";
import { writeProjectRegistration } from "../plugin/server/projects.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { handleSpoolRequest, parseSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const POLL_MS = 20;

interface FakeAgent {
  id: string;
  title?: string;
  status?: string;
  provider?: string;
  labels?: Record<string, string>;
  requiresAttention?: boolean;
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
              attentionReason: null,
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
  return { daemon, created, sent };
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
  });
  const spool = startSpool(stateDir, factory, {
    pollMs: POLL_MS,
    leadDispatch: (request) => leadMail.dispatchLead(request),
    supervisorDispatch: (request) => leadMail.dispatchSupervisor(request),
    supervisorReport: (request) => leadMail.reportSupervisor(request),
    peerMail: leadMail.notifyPeer,
  });
  t.after(() => spool.stop());
  return { dir, home, stateDir, slug, projectRoot, factory, surface, leadMail, spool, fake };
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
