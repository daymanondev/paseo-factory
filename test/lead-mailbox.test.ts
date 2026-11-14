import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createFactoryRegistry } from "../plugin/server/projects.ts";
import { CorrelationRegistry } from "../plugin/server/core/correlations.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { taskWorktreePath } from "../plugin/server/core/workspace.ts";
import { projectStateDir, readLeadMailbox } from "../src/index.ts";
import { ensureProjectRegistered, readProjectRegistration, writeProjectRegistration } from "../plugin/server/projects.ts";
import type { FactoryRegistry } from "../plugin/server/projects.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { handleSpoolRequest, parseSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { createLeadMailRuntime, HANDOFF_EXTRACTION_MAX_SENDS, HANDOFF_EXTRACTION_TIMEOUT_MS, isBlockedByAttention, LEAD_HANDOFF_MAX_BYTES, LEAD_ROTATE_TOKENS } from "../plugin/server/lead-mailbox.ts";
import { loadLanes, saveLanes } from "../plugin/server/core/lanes.ts";
import { readHandoffProgress } from "../plugin/server/handoff-progress.ts";
import { parseHandoffFile } from "../plugin/server/handoff-text.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const POLL_MS = 20;

/** The handover file's BODY — the v0.6.1 metadata header is storage, never prose. */
const handoffBodyOnDisk = (path: string): string => parseHandoffFile(readFileSync(path, "utf8")).body;

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
  lastUserMessageAt?: string | null;
  /** The Paseo parent link (v0.6.1, ADR 0057 §4) — a pre-v0.6.1 Lead still parented to its Supervisor. */
  parentAgentId?: string | null;
}

function fakeDaemon(agents: FakeAgent[]) {
  /** Test gates: hold one daemon call open so a concurrent act can land mid-flight. */
  const hooks: { timeline?: () => Promise<void>; create?: () => Promise<void> } = {};
  const created: { config: { provider: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }[] = [];
  const sent: { agentId: string; text: string }[] = [];
  // The fake daemon's agent.archive.after listeners (v0.6.1, ADR 0057 §4) —
  // the runtime registers through the harness the way the shell's server hook
  // does; emitArchive drives an OUTSIDE archive, ref().archive() a plugin one.
  const archiveListeners: ((agentId: string) => Promise<void>)[] = [];
  const notifyArchived = async (agentId: string): Promise<void> => {
    for (const listener of [...archiveListeners]) await listener(agentId);
  };
  const emitArchive = async (agentId: string): Promise<void> => {
    const at = agents.findIndex((agent) => agent.id === agentId);
    if (at !== -1) agents.splice(at, 1);
    await notifyArchived(agentId);
  };
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
              ...(agent.lastUserMessageAt === undefined ? {} : { lastUserMessageAt: agent.lastUserMessageAt }),
              ...(agent.parentAgentId === undefined ? {} : { parentAgentId: agent.parentAgentId }),
            },
          })),
        };
      },
      create: async (options) => {
        await hooks.create?.();
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
          await notifyArchived(id); // a faithful daemon fires agent.archive.after on its own archive too
          return { archivedAt: new Date().toISOString() };
        },
        timeline: { refetch: async () => { await hooks.timeline?.(); return { entries: [] }; } },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "pi", available: true }] }),
      listModels: async () => ({ models: [] }),
    },
  };
  return { daemon, created, sent, agents, emitArchive, archiveListeners, hooks };
}

function makeSpooledRuntime(t: TestContext, agents: FakeAgent[] = [], options?: { handoffTimeoutMs?: number; ownerHandoffTimeoutMs?: number; registry?: boolean }) {
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
  // `registry: true` is the production shape: one Factory per Project, so a
  // Project's exclusive maintenance (Rotate) does NOT stop the root Factory's mailbox lane.
  const registry = options?.registry === true ? createFactoryRegistry({ stateDir }) : undefined;
  if (registry !== undefined) t.after(() => registry.stop());
  const factory = registry?.root ?? createFactory({ stateDir });
  writeProjectRegistration(stateDir, slug, { root: projectRoot });
  const fake = fakeDaemon(agents);
  const logs: string[] = [];
  const warnings: string[] = [];
  const surface = createSurfaceHandlers({
    factory,
    ...(registry === undefined ? {} : { registry }),
    stateDir,
    home,
    daemon: fake.daemon,
    stopAgent: async () => ({ ok: true }),
    handoff: (input) => leadMail.handoff(input),
    onLeadRetired: (input) => leadMail.settleLeadRotation(input.slug),
    onSeatKickoffSent: (input) => leadMail.markKickoffSent(input.agentId),
    markPluginArchive: (input) => leadMail.markPluginArchive(input.agentId),
    clearPluginArchive: (input) => leadMail.clearPluginArchive(input.agentId),
    leadDispatch: (request) => leadMail.dispatchLead(request),
    resetProjectMailbox: (slug) => leadMail.resetProjectMailbox(slug),
    rotateProjectMailbox: (slug) => leadMail.rotateProjectMailbox(slug),
  });
  const leadMail = createLeadMailRuntime({
    factory,
    ...(registry === undefined ? {} : { registry }),
    stateDir,
    daemon: fake.daemon,
    ensureLead: (input) => surface.leadEnsure(input),
    retireLead: (input) => surface.leadRotate(input),
    settleReleasedSupervisor: (input) => surface.settleReleasedSupervisor(input),
    ...(options?.handoffTimeoutMs === undefined ? {} : { handoffTimeoutMs: options.handoffTimeoutMs }),
    ...(options?.ownerHandoffTimeoutMs === undefined ? {} : { ownerHandoffTimeoutMs: options.ownerHandoffTimeoutMs }),
    onLog: (msg) => logs.push(msg),
    logger: { warn: (msg) => warnings.push(msg) },
  });
  // The shell's agent.archive.after registration, wired the same way
  // index.server.ts does it: every daemon archive event reaches the runtime's
  // lost-Lead door (v0.6.1, ADR 0057 §4).
  fake.archiveListeners.push((agentId) => leadMail.onAgentArchived({ agentId }));
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

test("supervisor_dispatch from normal chat never creates a Supervisor — with a live seat it routes, with none it holds and says so (v0.6.1 W2, ADR 0057 §5)", async (t) => {
  const held = makeSpooledRuntime(t);
  const heldSpool = spoolRootFor(held.stateDir);

  // No live Supervisor: the directive is admitted and HELD — never a hidden seat.
  dropRequest(heldSpool, {
    id: "sup-disp-held",
    kind: "supervisor_dispatch",
    workspace: held.projectRoot,
    message: "Design and build the 2D platformer",
  });
  await until(() => {
    assert.equal(readReply(heldSpool, "sup-disp-held").ok, true);
  });
  const heldReply = readReply(heldSpool, "sup-disp-held");
  assert.equal(heldReply.supervisorAgentId, undefined);
  assert.match(String(heldReply.summary), /directive held for Supervisor — none is live/);
  // CLI Project onboarding (ticket 03): the held reply carries the exact seat-opening step.
  assert.match(String(heldReply.summary), /open a New Chat in Paseo Desktop and select the `Supervisor \(Factory\)` profile at the Project root/);
  assert.ok(String(heldReply.summary).includes(held.projectRoot), "the step names the Project root to open the chat in");
  assert.match(String(heldReply.summary), /stop this turn immediately without editing files/);
  assert.equal(held.fake.created.length, 0, "the dispatch creates no Supervisor");
  assert.equal(held.fake.sent.length, 0);
  assert.deepEqual(
    readMailboxLines(held.stateDir, held.slug).map((e) => e.type),
    ["mail_queued"],
  );
  assert.equal(readMailboxLines(held.stateDir, held.slug)[0]?.to, "supervisor");

  // With a live Supervisor (started explicitly, the Owner's act): the same
  // dispatch routes to the seat and tells the caller to stop its turn.
  const { stateDir, slug, projectRoot, surface, fake } = makeSpooledRuntime(t);
  const spoolRoot = spoolRootFor(stateDir);
  const started = await surface.supervisorStart({ projectRoot });
  assert.ok(started.ok, started.ok ? "" : started.error);

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
  assert.equal(reply.supervisorAgentId, started.ok ? started.agentId : "");
  assert.match(String(reply.summary), new RegExp(`directive routed to Supervisor \\(${started.ok ? started.agentId : ""}\\)`));
  assert.match(String(reply.summary), /stop this turn immediately without editing files/);
  assert.doesNotMatch(String(reply.summary), /New Chat/, "a routed directive needs no seat-opening step");

  assert.equal(fake.created.length, 1);
  assert.deepEqual(fake.created[0]?.labels, { seat: "supervisor", project: slug });

  const events = readMailboxLines(stateDir, slug);
  assert.deepEqual(events.map((e) => e.type), ["mail_queued", "mail_delivered"]);
  assert.equal(events[0]?.to, "supervisor");
  assert.equal(events[0]?.from, "owner");
  assert.equal(events[0]?.kind, "directive");
  assert.equal(events[1]?.to, "supervisor");
  assert.equal(events[1]?.toAgentId, started.ok ? started.agentId : "");

  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0]?.agentId, started.ok ? started.agentId : "");
  assert.ok(fake.sent[0]?.text.includes("# Supervisor mailbox — 1 item"));
  assert.ok(fake.sent[0]?.text.includes("Design and build the 2D platformer"));
});

test("supervisor_dispatch from a normal chat agent records submitter in project.json dispatchers (deduplicated) and ignores reserved/seat submitters (v0.0.24, T-03)", async (t) => {
  const { stateDir, slug, projectRoot, surface } = makeSpooledRuntime(t);
  const spoolRoot = spoolRootFor(stateDir);
  // v0.6.1 (ADR 0057 §5): a live Supervisor the dispatches route to and the
  // seat-submitter arm can name — started explicitly, never dispatched into being.
  const started = await surface.supervisorStart({ projectRoot });
  assert.ok(started.ok, started.ok ? "" : started.error);

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
    submitter: started.ok ? started.agentId : "supervisor",
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
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [supervisor]);
  supervisor.labels = { seat: "supervisor", project: slug };
  // v0.6.1 (ADR 0057 §5): the seat is started/bound explicitly — the report below never creates one.
  await surface.supervisorEnsure({ projectRoot });
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

test("a peer needs_human recording notifies the Lead mailbox only — never the Supervisor (ADR 0053 Decision 2)", async (t) => {
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
  assert.equal(queuedEvents.length, 1, "the needs_human recording enqueues exactly ONE peer mail item");
  assert.equal(queuedEvents[0]?.to, undefined, "Lead slice omits to (default lead)");
  assert.equal(queuedEvents.filter((e) => e.to === "supervisor").length, 0, "no to=supervisor duplicate is ever enqueued (spec Decision 6)");

  // The idle Lead received its delivery; the Supervisor never heard the stall.
  assert.equal(fake.sent.some((s) => s.agentId === leadEnsured.agentId && s.text.includes("T-NH")), true);
  assert.equal(fake.sent.some((s) => s.agentId === supEnsured.agentId && s.text.includes("T-NH")), false);
});

test("needs_human before project.json exists registers project.json via ensureProjectRegistered, ensures the Lead, and delivers to=lead (v0.0.23, T-07; ADR 0053 Decision 2)", async (t) => {
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
  assert.ok(reg?.lead !== undefined, "the Lead was ensured on demand");
  assert.equal(
    fake.sent.some((s) => s.agentId === reg?.lead && s.text.includes("T-NH-FRESH")),
    true,
    "the Lead received the needs_human delivery even when project.json was not previously written",
  );
  assert.equal(
    fake.sent.some((s) => s.text.includes("T-NH-FRESH") && s.agentId !== reg?.lead),
    false,
    "the needs_human stall reached exactly one seat — the Lead (ADR 0053 Decision 2)",
  );

  // Direct unit check of ensureProjectRegistered idempotence
  const ensuredAgain = ensureProjectRegistered(stateDir, projectRoot);
  assert.equal(ensuredAgain.ok, true);
  assert.equal(readProjectRegistration(stateDir, slug)?.lead, reg?.lead, "ensureProjectRegistered preserves existing seat fields");
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

test("onLeadTurnEnded performs a bounded 1-shot retry per mailId for both Lead and Supervisor and stops on a second failure (v0.0.24, T-02)", async (t) => {
  const { stateDir, slug, projectRoot, surface, leadMail, fake, warnings } = makeSpooledRuntime(t);
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

  // A failed turn on a still-idle Lead is retried in the same chat.
  const leadAgentObj = fake.agents.find((a) => a.id === leadId1);
  assert.ok(leadAgentObj);
  leadAgentObj.status = "idle";
  await leadMail.onLeadTurnEnded({
    agentId: leadId1,
    outcome: { kind: "failed", error: { message: "Variant unavailable" } },
    timeline: [],
  });

  // A transient failure re-delivers once without replacing the standing Lead.
  let state = readLeadMailbox(mailboxPath);
  assert.equal(state.queued.length, 0);
  assert.ok(state.inFlight !== null, "first failure retried and re-delivered the batch");
  assert.equal(state.inFlight?.toAgentId, leadId1, "the Lead keeps its history on retry");
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

  // --- Supervisor retry: v0.6.1 (ADR 0057 §5) — a failed Supervisor turn never creates a replacement ---
  const startedSup = await surface.supervisorStart({ projectRoot });
  assert.ok(startedSup.ok, startedSup.ok ? "" : startedSup.error);
  const supId1 = startedSup.ok ? startedSup.agentId : "";
  assert.equal(fake.created.length, 2, "the Supervisor was started explicitly — the dispatch below creates nothing");

  const supDisp = await leadMail.dispatchSupervisor({
    id: "sd-retry-1",
    kind: "supervisor_dispatch",
    workspace: projectRoot,
    message: "Plan the architecture",
  });
  assert.equal(supDisp.ok, true);
  assert.equal(supDisp.ok ? supDisp.supervisorAgentId : "", supId1);
  assert.equal(fake.sent.length, 3, "the directive delivered to the started Supervisor");

  // First Supervisor turn fails and leaves the seat in status="error": the
  // batch requeues and the 1-shot retry drain HOLDS — no replacement seat.
  const supAgentObj = fake.agents.find((a) => a.id === supId1);
  assert.ok(supAgentObj);
  supAgentObj.status = "error";
  await leadMail.onLeadTurnEnded({
    agentId: supId1,
    outcome: { kind: "failed", error: { message: "Supervisor crash 1" } },
    timeline: [],
  });
  state = readLeadMailbox(mailboxPath);
  assert.equal(state.supervisorInFlight, null, "the failed batch requeued, nothing in flight");
  assert.equal(state.supervisorQueued.length, 1, "the directive waits on the Supervisor slice");
  assert.equal(fake.created.length, 2, "no Supervisor was created to heal the errored seat");
  assert.equal(fake.sent.length, 3, "nothing re-sent — an errored Supervisor is never delivered into");

  // The seat recovers (the Owner reopens it): the next pump delivers the held batch.
  supAgentObj.status = "idle";
  await leadMail.pumpProjectSupervisor(slug);
  state = readLeadMailbox(mailboxPath);
  assert.ok(state.supervisorInFlight !== null, "the recovered Supervisor receives the held batch");
  assert.equal(state.supervisorInFlight?.toAgentId, supId1);
  assert.equal(fake.sent.length, 4);
});

test("pumpAll pumps a registered Project's queued Lead and Supervisor mail exactly once (v0.0.31, ADR 0017 §5/§6)", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-1", title: "Lead", status: "idle", labels: {} };
  const { stateDir, slug, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  // v0.6.1 (ADR 0057 §5): the Supervisor lane pumps against a started seat — the pump never creates one.
  await surface.supervisorStart({ projectRoot: readProjectRegistration(stateDir, slug)!.root! });

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
  const { stateDir, slug, projectRoot, leadMail, surface, fake } = makeSpooledRuntime(t);

  // v0.1.0 (ADR 0048 §3): seed the Per-Project Lead notebook so every Turn-1
  // packet built from the runtime (not just standalone buildSeatKickoffPacket
  // callers) carries the slug-dependent path and bounded content.
  mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
  writeFileSync(join(projectStateDir(stateDir, slug), "notebook.md"), "## 1. Verification & Run Recipe\n- Gate: npm test\n");

  // 1. First Supervisor delivery includes the Seat kickoff packet
  // (v0.6.1, ADR 0057 §5: the seat is started explicitly — the dispatch never creates one.)
  await surface.supervisorStart({ projectRoot });
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
  assert.match(fake.sent[0]!.text, new RegExp(`- Project notebook path: .*${slug}/notebook\\.md`));
  assert.match(fake.sent[0]!.text, /## 1\. Verification & Run Recipe/);

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
  assert.match(fake.sent[2]!.text, new RegExp(`- Project notebook path: .*${slug}/notebook\\.md`));
  assert.match(fake.sent[2]!.text, /- Gate: npm test/);

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

  // A drifted seat requires an explicit handoff instead of dropping its history.
  await leadMail.onLeadTurnEnded({ agentId: leadId, outcome: { kind: "completed" }, timeline: [] });
  const liveLead = fake.agents.find((a) => a.id === leadId);
  assert.ok(liveLead);
  liveLead.cwd = "/wrong/project/root";
  const reEnsured = await surface.leadEnsure({ projectRoot });
  assert.equal(reEnsured.ok, false);
  if (!reEnsured.ok) assert.equal(reEnsured.code, "handoff-required");
  assert.equal(readProjectRegistration(stateDir, slug)?.lead, leadId);
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
    status: "idle",
    cwd: join(taskWorktreePath(stateDir, slug, "T-WT"), "src"),
  });

  // 2. T-LABEL: Attempt-1 worker bound by labels { project: slug, task: "T-LABEL" } (no claim yet)
  factory.setContract({ task: "T-LABEL", workspace: canonicalRoot, gate: "true", artifact: "README.md", scope: ["label/**"] });
  fake.agents.push({
    id: "agent-label-1",
    status: "idle",
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
    status: "idle",
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
    status: "idle",
    cwd: "/tmp",
  });

  await leadMail.enqueueLeadMail(slug, { from: "owner", kind: "directive", text: "Review the current Peer roster" });

  // Trigger handoff at a quiet point (v0.0.93): the seeded workers are stopped,
  // so no Peer is in flight — turn 1 ends at 135k -> locks handing_over -> turn 2 ends -> completes handoff
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

  assert.match(kickoff.text, /task T-WT: .*agent agent-wt-1 \(live: idle\)/);
  assert.match(kickoff.text, /task T-LABEL: .*agent agent-label-1 \(live: idle\)/);
  assert.match(kickoff.text, /task T-CORR: .*agent agent-corr-1 \(live: idle\)/);
  assert.match(kickoff.text, /task T-RESET-UNBOUND: .*agent \(none bound\)/);
  assert.doesNotMatch(kickoff.text, /agent-stale-epoch1/);
  assert.match(kickoff.text, /task T-RESET-REBOUND: .*agent agent-new-epoch2 \(live: idle\)/);
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

  // Begin handoff on turn end at >= the Lead mark (LEAD_ROTATE_TOKENS)
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
  // v0.6.1 (ADR 0057 §5): an explicit first message to a fresh Supervisor seat
  // carries the Seat kickoff packet with it — same law as Start Supervisor.
  assert.match(supSends[0]!.text, /\[paseo-factory seat kickoff packet · role=supervisor/);
  assert.ok(supSends[0]!.text.endsWith("Explicit ratify message"));
  assert.doesNotMatch(supSends[1]!.text, /\[paseo-factory seat kickoff packet/, "onSeatKickoffSent marked Supervisor kickoff sent");
  assert.match(supSends[1]!.text, /Supervisor follow-up/);
});

test("Fuse 1: beginHandoff immediately completes handoff when extraction prompt send throws, outgoing Lead is in status='error', or outgoing Lead is absent (v0.0.28, ADR 0018 §3)", async (t) => {
  assert.equal(HANDOFF_EXTRACTION_TIMEOUT_MS, 180_000);

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
      /Plugin-built handover/,
    );
    assert.match(successorSends[0]!.text, /task T-FUSE1/);
    assert.match(successorSends[0]!.text, /Continue after send throw/);

    // v0.2.2 (ADR 0050 Decision 4): the degraded completion is loud — exactly one
    // Supervisor send, carrying the extraction-send-failed reason.
    const supSends = fake.sent.filter((s) => s.agentId === "agent-sup-1");
    assert.equal(supSends.length, 1, "the Supervisor was paged exactly once");
    assert.match(supSends[0]!.text, /extraction-send-failed/);
  }

  // Case B: outgoing Lead is in status === "error" at >= the Lead mark (LEAD_ROTATE_TOKENS) turn end
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
      /Plugin-built handover/,
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
      /Plugin-built handover/,
    );
    assert.match(successorSends[0]!.text, /Directive when outgoing Lead vanished/);
  }
});

test("Fuse 2: handing_over timeout (via scheduled timer and via pumpProjectLead) retires stuck Lead, spawns successor Lead with interrupted-extraction fallback note, resets rotationState, drains held mail, and pages Supervisor with exactly one degraded-completion notice (v0.0.28 ADR 0018 §3; v0.2.2 ADR 0050 Decision 4)", async (t) => {
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

    // A prior valid handoff is preserved on timeout, with a staleness notice.
    const handoffPath = join(projectStateDir(stateDir, slug), "lead-handoff.md");
    mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
    writeFileSync(handoffPath, "# Stale Handoff From Yesterday\nDo not use.");
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Turn ends at 135k -> locks handing_over and sends extraction prompt to agent-lead-stuck
    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-stuck", outcome: { kind: "completed" }, timeline: [] });
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
    assert.equal(fake.sent.filter((s) => s.agentId === "agent-lead-stuck").length, 1, "extraction prompt was sent");
    // v0.2.2 (ADR 0050 Decision 3): the elapsed fuse trips only over a Lead
    // still `running` (a genuinely hung extraction stream) — the stuck shape.
    lead.status = "running";

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
    assert.match(successorSends[0]!.text, /Plugin-built handover/);
    assert.doesNotMatch(successorSends[0]!.text, /Stale Handoff From Yesterday/);
    assert.match(handoffBodyOnDisk(handoffPath), /Plugin-built handover/);
    assert.match(successorSends[0]!.text, /task T-FUSE2-TIMER/);
    assert.match(successorSends[0]!.text, /Held mail drained by timer fuse/);
    // v0.2.2 (ADR 0050 Decision 4): the degraded completion is loud — exactly one
    // Supervisor send, carrying the extraction-timeout reason.
    const supSends = fake.sent.filter((s) => s.agentId === "agent-sup-1");
    assert.equal(supSends.length, 1, "the Supervisor was paged exactly once");
    assert.match(supSends[0]!.text, /extraction-timeout/);
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
      /Plugin-built handover/,
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

test("a canceled extraction turn keeps handing_over — no archive, no successor, mail stays queued — and the next pump re-sends the fixed extraction prompt (v0.2.2, ADR 0050 Decision 2)", async (t) => {
  const lead: FakeAgent = {
    id: "agent-lead-stopped",
    title: "Lead (paseo-factory)",
    status: "idle",
    labels: {},
    lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
  };
  const supervisor: FakeAgent = { id: "agent-sup-stopped", title: "Supervisor (paseo-factory)", status: "idle", labels: {} };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead, supervisor]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  supervisor.labels = { seat: "supervisor", project: slug };
  supervisor.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });
  await surface.supervisorEnsure({ projectRoot });

  const extractionSends = () => fake.sent.filter((s) => s.agentId === "agent-lead-stopped");

  // Quiet point at 135k -> beginHandoff sends extraction prompt #1 and locks handing_over.
  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-stopped", outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
  assert.equal(extractionSends().length, 1, "the original extraction prompt was sent");
  const requestedAt1 = readProjectRegistration(stateDir, slug)?.handoffRequestedAt;
  assert.ok(requestedAt1);

  // Mail queued while held stays queued through the whole episode.
  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Held while the extraction is stopped" });

  // The Owner stops the extraction turn (Pause (user) mid-extraction): a canceled
  // turn must NOT complete the handoff — no archive, no successor, mail held.
  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-stopped", outcome: { kind: "canceled" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over", "handing_over holds across a canceled extraction turn");
  assert.equal(fake.created.length, 0, "no successor Lead was spawned");
  assert.ok(fake.agents.some((a) => a.id === "agent-lead-stopped"), "the outgoing Lead was not archived");
  assert.equal(extractionSends().length, 1, "the turn-boundary settle itself re-sends nothing");
  assert.equal(readMailboxLines(stateDir, slug).filter((line) => line.event === "mail_delivered").length, 0, "held mail stays queued");

  // The next pump with the outgoing Lead seat-ready re-sends the FIXED extraction prompt.
  await leadMail.pumpProjectLead(slug);
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over", "still handing_over after the re-send");
  assert.equal(extractionSends().length, 2, "the pump re-sent the extraction prompt");
  assert.equal(extractionSends()[1]!.text, extractionSends()[0]!.text, "the re-send is the same fixed extraction prompt");
  assert.equal(fake.created.length, 0, "still no successor after one re-send");
  const requestedAt2 = readProjectRegistration(stateDir, slug)?.handoffRequestedAt;
  assert.ok(requestedAt2 && requestedAt2 !== requestedAt1, "the fuse timer anchor reset with the re-send");

  // A second stop holds again — the episode only leaves handing_over via a completed
  // extraction turn, and every queued item is still waiting.
  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-stopped", outcome: { kind: "canceled" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
  assert.equal(fake.created.length, 0);
  await leadMail.pumpProjectLead(slug);
  assert.equal(extractionSends().length, 3, "second re-send delivered (send 3 of the episode cap)");
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");

  // The completed extraction turn still completes the handoff cleanly and drains the held mail.
  await leadMail.onLeadTurnEnded({
    agentId: "agent-lead-stopped",
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "# Handoff after the pause\nThe roadmap survived the stop." }],
  });
  const reg = readProjectRegistration(stateDir, slug);
  assert.equal(reg?.rotationState, "normal");
  const successorId = reg?.lead;
  assert.ok(successorId && successorId !== "agent-lead-stopped");
  const successorSends = fake.sent.filter((s) => s.agentId === successorId);
  assert.equal(successorSends.length, 1);
  assert.match(successorSends[0]!.text, /# Handoff after the pause\nThe roadmap survived the stop\./);
  assert.match(successorSends[0]!.text, /Held while the extraction is stopped/);
});

test("a handing_over episode sends at most 3 extraction prompts — at the ceiling the runtime completes via the degraded path with the preserved prior and the staleness notice (v0.2.2, ADR 0050 Decision 2)", async (t) => {
  assert.equal(HANDOFF_EXTRACTION_MAX_SENDS, 3);
  const lead: FakeAgent = {
    id: "agent-lead-thrice-stopped",
    title: "Lead (paseo-factory)",
    status: "idle",
    labels: {},
    lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
  };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  // A last-known-good prior exists before the episode starts.
  const handoffPath = join(projectStateDir(stateDir, slug), "lead-handoff.md");
  mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
  writeFileSync(handoffPath, "# Prior Handoff\nThe last-known-good baton.");
  await new Promise((resolve) => setTimeout(resolve, 15));

  const extractionSends = () => fake.sent.filter((s) => s.agentId === "agent-lead-thrice-stopped");

  // Original send, then three failed extraction turns — each holds and re-sends
  // until the ceiling, where the episode completes via the degraded path.
  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-thrice-stopped", outcome: { kind: "completed" }, timeline: [] });
  assert.equal(extractionSends().length, 1);
  for (let stop = 1; stop <= 3; stop += 1) {
    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-thrice-stopped", outcome: { kind: "failed" }, timeline: [] });
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over", `stop ${stop}: handing_over holds`);
    await leadMail.pumpProjectLead(slug);
    if (stop < 3) {
      assert.equal(extractionSends().length, stop + 1, `stop ${stop}: re-send ${stop} of 2 delivered`);
      assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
    } else {
      assert.equal(extractionSends().length, 3, "stop 3: no fourth send — the ceiling completes the episode");
      assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal", "stop 3: the ceiling completes via the degraded path");
    }
  }

  // The degraded completion preserved the prior with the staleness notice and drained nothing early.
  const reg = readProjectRegistration(stateDir, slug);
  const successorId = reg?.lead;
  assert.ok(successorId && successorId !== "agent-lead-thrice-stopped");
  const successorSends = fake.sent.filter((s) => s.agentId === successorId);
  assert.equal(successorSends.length, 1);
  assert.match(successorSends[0]!.text, /Plugin-built handover/);
  assert.doesNotMatch(successorSends[0]!.text, /# Prior Handoff/);
  const snapshot = JSON.parse(readFileSync(join(projectStateDir(stateDir, slug), "lead-handoff-extraction.json"), "utf8")) as { sends?: number };
  assert.equal(snapshot.sends, 3, "the durable episode record counted exactly 3 sends");
});

test("loud degraded completion: every degraded handoff completion appends exactly one Supervisor needs_human mail (reason-distinguished, staleness-stated) while the rotation still completes autonomously — healthy rotations append nothing (v0.2.2, ADR 0050 Decision 4)", async (t) => {
  const supervisorNeedsHuman = (stateDir: string, slug: string) =>
    readMailboxLines(stateDir, slug).filter((line) => line.type === "mail_queued" && line.to === "supervisor" && line.kind === "needs_human");

  // Case A: extraction-send-failed — the extraction send throws during beginHandoff (Fuse 1 bypass). No prior exists,
  // so the successor's handoff layer is the interrupted-extraction fallback note.
  {
    const lead: FakeAgent = {
      id: "agent-lead-loud-sendfail",
      title: "Lead (paseo-factory)",
      status: "idle",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
    };
    const supervisor: FakeAgent = { id: "agent-sup-loud-sendfail", title: "Supervisor (paseo-factory)", status: "idle", labels: {} };
    const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead, supervisor]);
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    supervisor.labels = { seat: "supervisor", project: slug };
    supervisor.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });
    await surface.supervisorEnsure({ projectRoot });

    const origRef = fake.daemon.agents.ref.bind(fake.daemon.agents);
    fake.daemon.agents.ref = (id: string) => {
      const base = origRef(id);
      if (id === lead.id) {
        return { ...base, send: async () => { throw new Error("daemon send socket closed"); } };
      }
      return base;
    };

    await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });

    const reg = readProjectRegistration(stateDir, slug);
    assert.equal(reg?.rotationState, "normal", "the rotation completed despite the degraded extraction");
    assert.ok(reg?.lead && reg.lead !== lead.id, "the successor was still spawned — the mail blocks nothing");
    const mails = supervisorNeedsHuman(stateDir, slug);
    assert.equal(mails.length, 1, "exactly one Supervisor needs_human mail per degraded completion");
    assert.equal(mails[0]!.from, "system");
    assert.match(mails[0]!.text as string, /extraction-send-failed/);
    assert.match(mails[0]!.text as string, /Plugin-built handover/i, "the mail labels the substitute handover");

    // The Supervisor seat received the notice through the existing needs-human delivery path…
    const supSends = fake.sent.filter((s) => s.agentId === supervisor.id);
    assert.equal(supSends.length, 1);
    assert.match(supSends[0]!.text, /extraction-send-failed/);
    // …and re-pumping never mints a second mail (never one per pump).
    await leadMail.pumpProjectLead(slug);
    await leadMail.pumpProjectSupervisor(slug);
    assert.equal(supervisorNeedsHuman(stateDir, slug).length, 1, "never one mail per pump");
  }

  // Case B: extraction-timeout — the elapsed window finds the Lead still `running` (Fuse 2). A prior exists,
  // so the mail states the preserved-prior-with-staleness-notice shape.
  {
    const lead: FakeAgent = {
      id: "agent-lead-loud-timeout",
      title: "Lead (paseo-factory)",
      status: "idle",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
    };
    const supervisor: FakeAgent = { id: "agent-sup-loud-timeout", title: "Supervisor (paseo-factory)", status: "idle", labels: {} };
    const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead, supervisor], { handoffTimeoutMs: 40 });
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    supervisor.labels = { seat: "supervisor", project: slug };
    supervisor.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });
    await surface.supervisorEnsure({ projectRoot });

    const handoffPath = join(projectStateDir(stateDir, slug), "lead-handoff.md");
    mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
    writeFileSync(handoffPath, "# Loud Timeout Prior\nThe baton from yesterday.");
    await new Promise((resolve) => setTimeout(resolve, 15));

    await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
    lead.status = "running"; // a genuinely hung extraction stream trips the elapsed fuse
    await until(() => {
      assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal");
    }, 2000);

    const reg = readProjectRegistration(stateDir, slug);
    assert.ok(reg?.lead && reg.lead !== lead.id, "the rotation still completed");
    const mails = supervisorNeedsHuman(stateDir, slug);
    assert.equal(mails.length, 1, "exactly one Supervisor needs_human mail");
    assert.match(mails[0]!.text as string, /extraction-timeout/);
    assert.match(mails[0]!.text as string, /Plugin-built handover/);
    assert.ok(fake.sent.some((s) => s.agentId === supervisor.id && s.text.includes("extraction-timeout")), "the Supervisor seat received the notice");
  }

  // Case C: extraction-send-cap — the 3-send ceiling ends the episode via the degraded path. The episode survived
  // four pumps (the original turn boundary plus three re-send pumps) and still appends exactly one mail.
  {
    const lead: FakeAgent = {
      id: "agent-lead-loud-cap",
      title: "Lead (paseo-factory)",
      status: "idle",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
    };
    const supervisor: FakeAgent = { id: "agent-sup-loud-cap", title: "Supervisor (paseo-factory)", status: "idle", labels: {} };
    const { stateDir, slug, projectRoot, surface, leadMail } = makeSpooledRuntime(t, [lead, supervisor]);
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    supervisor.labels = { seat: "supervisor", project: slug };
    supervisor.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });
    await surface.supervisorEnsure({ projectRoot });

    mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
    writeFileSync(join(projectStateDir(stateDir, slug), "lead-handoff.md"), "# Loud Cap Prior\nThe last-known-good baton.");
    await new Promise((resolve) => setTimeout(resolve, 15));

    await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
    for (let stop = 1; stop <= 3; stop += 1) {
      await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "failed" }, timeline: [] });
      await leadMail.pumpProjectLead(slug);
    }
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal", "the ceiling completed via the degraded path");

    const reg = readProjectRegistration(stateDir, slug);
    assert.ok(reg?.lead && reg.lead !== lead.id, "the rotation still completed");
    const mails = supervisorNeedsHuman(stateDir, slug);
    assert.equal(mails.length, 1, "exactly one mail across the whole pumped episode — never one per pump");
    assert.match(mails[0]!.text as string, /extraction-send-cap/);
    assert.match(mails[0]!.text as string, /Plugin-built handover/);
  }

  // Case D: a healthy rotation (completed extraction turn with valid text) appends nothing — and so does a
  // completed-but-invalid extraction turn, which still "came from a completed extraction turn".
  {
    const lead: FakeAgent = {
      id: "agent-lead-loud-healthy",
      title: "Lead (paseo-factory)",
      status: "idle",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
    };
    const { stateDir, slug, projectRoot, surface, leadMail } = makeSpooledRuntime(t, [lead]);
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });

    await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
    await leadMail.onLeadTurnEnded({
      agentId: lead.id,
      outcome: { kind: "completed" },
      timeline: [{ type: "assistant_message", text: "# Clean Handoff\nThe roadmap continues untouched." }],
    });
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal");
    assert.equal(supervisorNeedsHuman(stateDir, slug).length, 0, "a healthy rotation appends no Supervisor mail");
  }
});

test("pause-aware fuse (timer path): the elapsed window over an alive idle or closed Lead re-sends and resets the timer; only a still-running Lead trips (v0.2.2, ADR 0050 Decision 3)", async (t) => {
  // Block 1: paused-mid-extraction — the Lead sits idle through every window.
  {
    const lead: FakeAgent = {
      id: "agent-lead-paused-fuse",
      title: "Lead (paseo-factory)",
      status: "idle",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
    };
    const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead], { handoffTimeoutMs: 40 });
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });

    const handoffPath = join(projectStateDir(stateDir, slug), "lead-handoff.md");
    mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
    writeFileSync(handoffPath, "# Prior Paused Fuse\nContinuity through the pause.");
    await new Promise((resolve) => setTimeout(resolve, 15));

    const extractionSends = () => fake.sent.filter((s) => s.agentId === "agent-lead-paused-fuse");
    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-paused-fuse", outcome: { kind: "completed" }, timeline: [] });
    assert.equal(extractionSends().length, 1);
    const anchor1 = readProjectRegistration(stateDir, slug)?.handoffRequestedAt;

    // Window 1 elapses over the alive idle Lead: re-send, do not trip.
    await until(() => assert.equal(extractionSends().length, 2), 2000);
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over", "an idle Lead never trips the elapsed fuse");
    const anchor2 = readProjectRegistration(stateDir, slug)?.handoffRequestedAt;
    assert.ok(anchor2 && anchor2 !== anchor1, "the fuse timer reset with the re-send");

    // Window 2 (the re-armed timer fires again): second and final re-send.
    await until(() => assert.equal(extractionSends().length, 3), 2000);
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");

    // Window 3: the ceiling — the episode completes via the degraded path, never a 4th send.
    await until(() => assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal"), 2000);
    assert.equal(extractionSends().length, 3, "no fourth extraction send past the cap");
    const successorId = readProjectRegistration(stateDir, slug)?.lead;
    assert.ok(successorId && successorId !== "agent-lead-paused-fuse");
    const successorSends = fake.sent.filter((s) => s.agentId === successorId);
    assert.equal(successorSends.length, 1);
    assert.match(successorSends[0]!.text, /Plugin-built handover/);
    assert.match(successorSends[0]!.text, /Plugin-built handover/);
  }

  // Block 2: Paseo's idle-runtime-collected "closed" is the same alive-paused shape.
  {
    const lead: FakeAgent = {
      id: "agent-lead-closed-fuse",
      title: "Lead (paseo-factory)",
      status: "idle",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
    };
    const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead], { handoffTimeoutMs: 40 });
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });
    const extractionSends = () => fake.sent.filter((s) => s.agentId === "agent-lead-closed-fuse");
    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-closed-fuse", outcome: { kind: "completed" }, timeline: [] });
    assert.equal(extractionSends().length, 1);
    lead.status = "closed";
    await until(() => assert.equal(extractionSends().length, 2), 2000);
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over", "a closed Lead is re-sent, not fused over");
  }
});

test("pause-aware fuse (pump path): an absent or error Lead trips immediately even before the window elapses, and a throwing re-send trips with the send-failed reason (v0.2.2, ADR 0050 Decision 3)", async (t) => {
  // Block A: the outgoing Lead vanished mid-episode — the pump trips without waiting out the window.
  {
    const lead: FakeAgent = {
      id: "agent-lead-vanished",
      title: "Lead (paseo-factory)",
      status: "idle",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
    };
    const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });
    const handoffPath = join(projectStateDir(stateDir, slug), "lead-handoff.md");
    mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
    writeFileSync(handoffPath, "# Prior Vanished\nThe absent Lead keeps continuity.");
    await new Promise((resolve) => setTimeout(resolve, 15));
    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-vanished", outcome: { kind: "completed" }, timeline: [] });
    const sendsBefore = fake.sent.filter((s) => s.agentId === "agent-lead-vanished").length;
    assert.equal(sendsBefore, 1);

    fake.agents.splice(fake.agents.findIndex((a) => a.id === "agent-lead-vanished"), 1);
    await leadMail.pumpProjectLead(slug); // elapsed is milliseconds — far under the 180s window

    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal", "an absent Lead trips the fuse immediately");
    assert.equal(fake.sent.filter((s) => s.agentId === "agent-lead-vanished").length, 1, "no re-send was attempted");
    const successorId = readProjectRegistration(stateDir, slug)?.lead;
    assert.ok(successorId && successorId !== "agent-lead-vanished");
    const successorSends = fake.sent.filter((s) => s.agentId === successorId);
    assert.equal(successorSends.length, 1);
    assert.match(successorSends[0]!.text, /Plugin-built handover/);
    assert.match(successorSends[0]!.text, /Plugin-built handover/);
  }

  // Block B: the outgoing Lead fell into error mid-episode.
  {
    const lead: FakeAgent = {
      id: "agent-lead-errored-mid",
      title: "Lead (paseo-factory)",
      status: "idle",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
    };
    const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });
    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-errored-mid", outcome: { kind: "completed" }, timeline: [] });
    lead.status = "error";
    await leadMail.pumpProjectLead(slug);
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal", "an error Lead trips the fuse immediately");
    assert.equal(fake.sent.filter((s) => s.agentId === "agent-lead-errored-mid").length, 1, "no re-send to an error Lead");
  }

  // Block C: the re-send itself throws — the fuse trips with the send-failed reason.
  {
    const lead: FakeAgent = {
      id: "agent-lead-resend-throw",
      title: "Lead (paseo-factory)",
      status: "idle",
      labels: {},
      lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
    };
    const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });
    const handoffPath = join(projectStateDir(stateDir, slug), "lead-handoff.md");
    mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
    writeFileSync(handoffPath, "# Prior Resend Throw\nContinuity despite the dead socket.");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const extractionSends = () => fake.sent.filter((s) => s.agentId === "agent-lead-resend-throw");
    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-resend-throw", outcome: { kind: "completed" }, timeline: [] });
    assert.equal(extractionSends().length, 1);
    await leadMail.onLeadTurnEnded({ agentId: "agent-lead-resend-throw", outcome: { kind: "canceled" }, timeline: [] });
    const origRef = fake.daemon.agents.ref.bind(fake.daemon.agents);
    fake.daemon.agents.ref = (id: string) => {
      const base = origRef(id);
      if (id === "agent-lead-resend-throw") {
        return { ...base, send: async () => { throw new Error("daemon send socket closed"); } };
      }
      return base;
    };
    await leadMail.pumpProjectLead(slug);
    fake.daemon.agents.ref = origRef;
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal", "a throwing re-send trips the fuse immediately");
    assert.equal(extractionSends().length, 1, "the failed re-send delivered nothing");
    const successorId = readProjectRegistration(stateDir, slug)?.lead;
    assert.ok(successorId && successorId !== "agent-lead-resend-throw");
    const successorSends = fake.sent.filter((s) => s.agentId === successorId);
    assert.equal(successorSends.length, 1);
    assert.match(successorSends[0]!.text, /Plugin-built handover/);
    assert.match(successorSends[0]!.text, /Plugin-built handover/);
  }
});

test("boot after a restart re-sends the extraction to the alive Lead instead of completing from a stale prior (v0.2.2, ADR 0050 Decision 3)", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-boot-alive", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS } };
  const f = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: f.slug };
  lead.cwd = f.projectRoot;
  await f.surface.leadEnsure({ projectRoot: f.projectRoot });
  const path = join(projectStateDir(f.stateDir, f.slug), "lead-handoff.md");
  writeFileSync(path, "# Durable prior handoff\nOnly the dead Lead restores this.");
  const bootSends = () => f.fake.sent.filter((s) => s.agentId === "agent-lead-boot-alive");
  await f.leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(bootSends().length, 1);
  f.leadMail.stop();
  writeFileSync(path, "Permission denied: outside workspace.");

  // A second runtime over the same stateDir — empty in-process marker sets, the
  // simulated-restart boot seam: the alive idle Lead gets a fresh extraction.
  const restarted = createLeadMailRuntime({ factory: f.factory, stateDir: f.stateDir, daemon: f.fake.daemon, ensureLead: input => f.surface.leadEnsure(input), retireLead: input => f.surface.leadRotate(input) });
  t.after(() => restarted.stop());
  await restarted.pumpProjectLead(f.slug);
  assert.equal(bootSends().length, 2, "the boot re-sent the extraction prompt");
  assert.equal(readProjectRegistration(f.stateDir, f.slug)?.rotationState, "handing_over", "no stale-prior completion at boot");
  assert.equal(f.fake.created.length, 0, "no successor was spawned at boot");
  assert.equal(readFileSync(path, "utf8"), "Permission denied: outside workspace.", "nothing restored or completed behind the re-send");

  // Recovery produces a fresh handoff whenever possible: the re-sent extraction
  // completing with valid text yields the successor a fresh (non-stale) kickoff.
  await restarted.onLeadTurnEnded({
    agentId: lead.id,
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "# Fresh Handoff After Boot\nWritten by the re-sent extraction." }],
  });
  assert.equal(readProjectRegistration(f.stateDir, f.slug)?.rotationState, "normal");
  const successorId = readProjectRegistration(f.stateDir, f.slug)?.lead;
  assert.ok(successorId && successorId !== lead.id);
  const successorSends = f.fake.sent.filter((s) => s.agentId === successorId);
  assert.equal(successorSends.length, 1);
  assert.ok(successorSends[0]!.text.includes("# Fresh Handoff After Boot\nWritten by the re-sent extraction."));
  assert.doesNotMatch(successorSends[0]!.text, /latest extraction did not complete/, "the fresh extraction is not flagged stale");
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










test("quiet-point handoff binds the roster to the current Peer and combines its verdict with the successor kickoff (v0.0.93)", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-1", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });
  factory.setContract({ task: "wave", workspace: readProjectRegistration(stateDir, slug)!.root!, gate: "true" });
  const cwd = taskWorktreePath(stateDir, slug, "wave");
  factory.requestSpawn({ task: "wave", provider: "pi/model", arity: 1, worktree: cwd });
  const current: FakeAgent = { id: "current", status: "running", cwd, labels: { seat: "agent", project: slug, task: "wave" } };
  const stale: FakeAgent = { id: "stale", status: "idle", cwd, labels: { seat: "agent", project: slug, task: "wave" } };
  fake.agents.unshift(current, stale); // daemon order is newest first
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending", "the rotation holds while the Peer runs");
  await leadMail.pumpProjectLead(slug);
  assert.equal(fake.sent.length, 0, "a pump wakes nobody while the rotation is pending");
  current.status = "idle";
  factory.ledger.append({ event: "gate_finished", task: "wave", attempt: 1, verdict: "green", exit: 0, note: "" });
  await leadMail.notifyPeer({ task: "wave", kind: "verdict", text: "wave GREEN" });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
  assert.equal(fake.sent.filter(s => s.agentId === lead.id).length, 1, "the extraction prompt reached the outgoing Lead");
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "# Handoff\nWait for wave." }] });
  const successorId = "agent-created-1";
  const sent = fake.sent.filter(s => s.agentId === successorId);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /agent current \(live: idle\)/, "the roster binds the newest current-epoch Peer, rendered at the completed quiet point");
  assert.doesNotMatch(sent[0]!.text, /agent stale/);
  assert.match(sent[0]!.text, /# Lead handoff/);
  assert.match(sent[0]!.text, /wave GREEN/);
});

test("a pending rotation pumps into a handoff after its Peer stops even without verdict mail, and never double-delivers the kickoff", async (t) => {
  const lead: FakeAgent = { id: "lead", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });
  factory.setContract({ task: "wave", workspace: readProjectRegistration(stateDir, slug)!.root!, gate: "true" });
  const peer: FakeAgent = { id: "peer", status: "initializing", cwd: taskWorktreePath(stateDir, slug, "wave"), labels: { seat: "agent", project: slug, task: "wave" } };
  fake.agents.push(peer);
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending", "both turn boundaries hold while the Peer initializes");
  assert.equal(fake.sent.length, 0);
  peer.status = "error";
  await leadMail.pumpProjectLead(slug);
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over", "the pump began the handoff with no verdict mail at all");
  assert.equal(fake.sent.filter(s => s.agentId === lead.id).length, 1);
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "# Handoff\nPeer died before any verdict." }] });
  assert.equal(fake.sent.filter(s => s.agentId === "agent-created-1").length, 1, "the successor's Turn-1 kickoff delivered once");
  await leadMail.pumpProjectLead(slug);
  assert.equal(fake.sent.filter(s => s.agentId === "agent-created-1").length, 1, "a second pump re-delivers nothing");
});

test("a paused-then-idle Peer on an open spawn round holds rotation_pending across a bare pump — a live-not-error Peer is not a quiet point (v0.2.2, ADR 0050 §1)", async (t) => {
  const lead: FakeAgent = { id: "lead-paused-peer", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  const root = readProjectRegistration(stateDir, slug)!.root!;
  factory.setContract({ task: "T-PAUSE", workspace: root, gate: "true" });
  const worktree = taskWorktreePath(stateDir, slug, "T-PAUSE");
  factory.requestSpawn({ task: "T-PAUSE", provider: "pi/model", arity: 1, worktree });
  const peer: FakeAgent = { id: "peer-paused", status: "running", cwd: worktree, labels: { seat: "agent", project: slug, task: "T-PAUSE" } };
  fake.agents.unshift(peer);

  // 1. The Lead crosses the threshold while the Peer runs: rotation_pending holds.
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending");
  assert.equal(fake.sent.length, 0, "no extraction prompt while the Peer runs");

  // 2. The Owner pauses the Peer mid-Task: the daemon collects the seat to
  //    idle with no Task outcome on record (no turn event reaches this
  //    runtime — the in-process marker is empty). The Task's round is still
  //    open and its bound Peer is live and not `error`, so pausing must
  //    freeze the succession: a bare pump — the startup `pumpAll` path —
  //    never begins the handoff.
  peer.status = "idle";
  await leadMail.pumpProjectLead(slug);
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending", "a paused-but-alive idle Peer is not a quiet point");
  assert.equal(fake.sent.filter((s) => s.agentId === lead.id).length, 0, "no extraction prompt reached the outgoing Lead");
  assert.equal(fake.created.length, 0, "no successor Lead was spawned");
});

test("the paused-Peer hold survives a runtime restart — a fresh runtime over the same stateDir with empty in-process markers still holds (v0.2.2, ADR 0050 §1)", async (t) => {
  const lead: FakeAgent = { id: "lead-paused-restart", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  const root = readProjectRegistration(stateDir, slug)!.root!;
  factory.setContract({ task: "T-PAUSE-RESTART", workspace: root, gate: "true" });
  const worktree = taskWorktreePath(stateDir, slug, "T-PAUSE-RESTART");
  factory.requestSpawn({ task: "T-PAUSE-RESTART", provider: "pi/model", arity: 1, worktree });
  const peer: FakeAgent = { id: "peer-paused-restart", status: "running", cwd: worktree, labels: { seat: "agent", project: slug, task: "T-PAUSE-RESTART" } };
  fake.agents.unshift(peer);

  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending");
  peer.status = "idle";
  await leadMail.pumpProjectLead(slug);
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending", "the hold is armed before the restart");

  // A daemon restart / plugin update dissolves every in-process marker. The
  // fresh runtime's judgment must read only the ledger, `mailbox.jsonl`, and
  // the live daemon snapshot — the hold stands.
  leadMail.stop();
  const restarted = createLeadMailRuntime({
    factory,
    stateDir,
    daemon: fake.daemon,
    ensureLead: (input) => surface.leadEnsure(input),
    retireLead: (input) => surface.leadRotate(input),
  });
  t.after(() => restarted.stop());
  await restarted.pumpProjectLead(slug);
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending", "the fresh runtime still holds — the hold is durable");
  assert.equal(fake.sent.filter((s) => s.agentId === lead.id).length, 0, "no extraction prompt after the restart");
  assert.equal(fake.created.length, 0, "no successor Lead was spawned after the restart");
});

test("v0.8.5: the Owner's Esc on a Peer while the Lead waits for its handoff — the Lead holds, the Peer is neither nudged nor archived, and a red Attempt does not release the hold", async (t) => {
  const lead: FakeAgent = { id: "lead-esc", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  const root = readProjectRegistration(stateDir, slug)!.root!;
  factory.setContract({ task: "T-ESC", workspace: root, gate: "true" });
  const worktree = taskWorktreePath(stateDir, slug, "T-ESC");
  factory.requestSpawn({ task: "T-ESC", provider: "pi/model", arity: 1, worktree });
  const peer: FakeAgent = { id: "peer-esc", status: "running", cwd: worktree, labels: { seat: "agent", project: slug, task: "T-ESC" } };
  fake.agents.unshift(peer);

  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending");

  // The Owner presses Esc on the Peer: its turn ends `canceled`, it goes idle.
  peer.status = "idle";
  await leadMail.onLeadTurnEnded({ agentId: peer.id, outcome: { kind: "canceled" }, timeline: [] });
  await leadMail.pumpProjectLead(slug);
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending", "a paused Peer holds the Lead's handoff");
  assert.equal(fake.sent.filter((s) => s.agentId === lead.id).length, 0, "no extraction prompt reached the Lead");
  assert.equal(fake.sent.filter((s) => s.agentId === peer.id).length, 0, "a canceled turn is the Owner's pause — never nudged");

  // A red Attempt closes the spawn round in the ledger, but the Task is not
  // settled below the ceiling: the idle Peer still owns it — durably, with
  // no in-process marker (a fresh runtime over the same state holds too).
  factory.ledger.append({ event: "claim_reported", task: "T-ESC", attempt: 1, sha: "a1b2c3d", agent: peer.id });
  factory.ledger.append({ event: "gate_finished", task: "T-ESC", attempt: 1, exit: 1, verdict: "red", note: "", sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" });
  leadMail.stop();
  const restarted = createLeadMailRuntime({
    factory,
    stateDir,
    daemon: fake.daemon,
    ensureLead: (input) => surface.leadEnsure(input),
    retireLead: (input) => surface.leadRotate(input),
  });
  t.after(() => restarted.stop());
  await restarted.pumpProjectLead(slug);
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending", "red below the ceiling with a live Peer still holds");
  assert.equal(fake.created.length, 0, "no successor Lead was spawned");
});

test("v0.8.5: a Peer turn that completes without a Claim is nudged once; a second unclaimed turn is reported to the Lead", async (t) => {
  const lead: FakeAgent = { id: "lead-nudge", status: "idle", lastUsage: { contextWindowUsedTokens: 10_000 } };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  const root = readProjectRegistration(stateDir, slug)!.root!;
  factory.setContract({ task: "T-NUDGE", workspace: root, gate: "true" });
  const worktree = taskWorktreePath(stateDir, slug, "T-NUDGE");
  factory.requestSpawn({ task: "T-NUDGE", provider: "pi/model", arity: 1, worktree });
  const peer: FakeAgent = { id: "peer-nudge", status: "idle", cwd: worktree, labels: { seat: "agent", project: slug, task: "T-NUDGE" } };
  fake.agents.unshift(peer);
  const leadSendsBefore = fake.sent.filter((s) => s.agentId === lead.id).length;

  await leadMail.onLeadTurnEnded({ agentId: peer.id, outcome: { kind: "completed" }, timeline: [] });
  const nudges = fake.sent.filter((s) => s.agentId === peer.id);
  assert.equal(nudges.length, 1, "one nudge back into the Peer");
  assert.match(nudges[0]!.text, /T-NUDGE ended without a Claim/);
  assert.match(nudges[0]!.text, /agent_claim/);
  assert.equal(fake.sent.filter((s) => s.agentId === lead.id).length, leadSendsBefore, "the Lead hears nothing yet");

  await leadMail.onLeadTurnEnded({ agentId: peer.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(fake.sent.filter((s) => s.agentId === peer.id).length, 1, "never a second nudge for the same ledger state");
  const leadMailTexts = fake.sent.filter((s) => s.agentId === lead.id).slice(leadSendsBefore).map((s) => s.text).join("\n");
  assert.match(leadMailTexts, /peer-nudge ended its turn on task T-NUDGE again without a Claim/, "the Lead gets one report");

  // A gate that lands is new ledger state: a later unclaimed turn earns a fresh nudge (red Attempt wording).
  factory.ledger.append({ event: "claim_reported", task: "T-NUDGE", attempt: 1, sha: "a1b2c3d", agent: peer.id });
  factory.ledger.append({ event: "gate_finished", task: "T-NUDGE", attempt: 1, exit: 1, verdict: "red", note: "", sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" });
  await leadMail.onLeadTurnEnded({ agentId: peer.id, outcome: { kind: "completed" }, timeline: [] });
  const after = fake.sent.filter((s) => s.agentId === peer.id);
  assert.equal(after.length, 2);
  assert.match(after[1]!.text, /last gate was red/);
});

test("a queued from-peer verdict mail releases the paused-Peer hold — the wave is back in the Lead's court (v0.2.2, ADR 0050 §1)", async (t) => {
  const lead: FakeAgent = { id: "lead-verdict-release", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  const root = readProjectRegistration(stateDir, slug)!.root!;
  factory.setContract({ task: "T-VERDICT", workspace: root, gate: "true" });
  const worktree = taskWorktreePath(stateDir, slug, "T-VERDICT");
  factory.requestSpawn({ task: "T-VERDICT", provider: "pi/model", arity: 1, worktree });
  const peer: FakeAgent = { id: "peer-verdict", status: "running", cwd: worktree, labels: { seat: "agent", project: slug, task: "T-VERDICT" } };
  fake.agents.unshift(peer);

  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending");

  // The paused-looking idle Peer would hold under the durable arm — but the
  // Peer has queued its verdict, so the Task is back in the Lead's court and
  // notifyPeer's pump must begin the handoff (the round itself may still be
  // open in the ledger until the gate lands).
  peer.status = "idle";
  await leadMail.notifyPeer({ task: "T-VERDICT", kind: "verdict", text: "T-VERDICT attempt 1 ended GREEN" });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over", "queued peer mail releases the hold");
  assert.equal(fake.sent.filter((s) => s.agentId === lead.id).length, 1, "the extraction prompt reached the outgoing Lead");
});

for (const death of ["error", "absent", "archived"] as const) {
  test(`an ${death} Peer on an open round never holds rotation_pending — the anti-deadlock law stands (v0.2.2, ADR 0050 §1)`, async (t) => {
    const lead: FakeAgent = { id: `lead-dead-${death}`, status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
    const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    await surface.leadEnsure({ projectRoot });

    const root = readProjectRegistration(stateDir, slug)!.root!;
    factory.setContract({ task: "T-DEAD", workspace: root, gate: "true" });
    const worktree = taskWorktreePath(stateDir, slug, "T-DEAD");
    factory.requestSpawn({ task: "T-DEAD", provider: "pi/model", arity: 1, worktree });
    const peer: FakeAgent = { id: "peer-dead", status: "running", cwd: worktree, labels: { seat: "agent", project: slug, task: "T-DEAD" } };
    fake.agents.unshift(peer);

    await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending");

    // The paused shape (idle, no turn event seen) holds under the durable
    // arm; a Peer that is in `error`, archived, or absent from the daemon
    // never does — the Lead owns re-dispatch, and a dead Peer can never
    // deadlock the mailbox.
    peer.status = "idle";
    if (death === "error") peer.status = "error";
    else if (death === "absent") fake.agents.splice(fake.agents.indexOf(peer), 1);
    else {
      const list = fake.daemon.agents.list;
      fake.daemon.agents.list = async (options) => {
        const page = await list(options);
        for (const entry of page.entries) {
          if (entry.agent.id === peer.id) entry.agent.archivedAt = "2026-11-06T00:00:00.000Z";
        }
        return page;
      };
    }
    await leadMail.pumpProjectLead(slug);
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over", `a ${death} Peer releases the hold`);
    assert.equal(fake.sent.filter((s) => s.agentId === lead.id).length, 1, "the pump began the extraction turn");
  });
}

test("pumping an empty project without a held handoff does not create a Lead", async (t) => {
  const { slug, leadMail, fake } = makeSpooledRuntime(t);
  await leadMail.pumpProjectLead(slug);
  assert.equal(fake.created.length, 0);
  assert.equal(fake.sent.length, 0);
});

test("quiet-point Lead rotation (ADR 0031, v0.0.93): rotation_pending holds the outgoing Lead live while a Peer runs, notifyPeer's pump begins the handoff once the wave settles, a closed Supervisor wakes on report, and pendingHandoff recovers durably from lead-handoff.md across restarts", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-1", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
  const supervisor: FakeAgent = { id: "agent-sup-1", status: "idle" };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead, supervisor]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  supervisor.labels = { seat: "supervisor", project: slug };
  supervisor.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });
  await surface.supervisorEnsure({ projectRoot });

  // 1. Contract T-03 in this project and start a running Peer
  const root = readProjectRegistration(stateDir, slug)!.root!;
  factory.setContract({ task: "T-03", workspace: root, gate: "true" });
  const t03Worktree = taskWorktreePath(stateDir, slug, "T-03");
  factory.requestSpawn({ task: "T-03", provider: "pi/model", arity: 1, worktree: t03Worktree });
  const t03Peer: FakeAgent = { id: "peer-t03", status: "running", cwd: t03Worktree, labels: { seat: "agent", project: slug, task: "T-03" } };
  fake.agents.unshift(t03Peer);

  // Also register a second Project with an active running Peer in an open spawn_dispatched round
  const neighborRoot = makeTempDir();
  disposeDir(t, neighborRoot);
  writeFileSync(join(neighborRoot, "README.md"), "neighbor\n");
  gitCommitAll(neighborRoot);
  const neighborResolved = ensureProjectRegistered(stateDir, neighborRoot);
  assert.ok(neighborResolved.ok);
  const neighborWorktree = taskWorktreePath(stateDir, neighborResolved.slug, "T-NEIGHBOR");
  factory.setContract({ task: "T-NEIGHBOR", workspace: neighborResolved.root, gate: "true" });
  factory.requestSpawn({ task: "T-NEIGHBOR", provider: "pi/model", arity: 1, worktree: neighborWorktree });
  const neighborPeer: FakeAgent = {
    id: "peer-neighbor",
    status: "running",
    cwd: neighborWorktree,
    labels: { seat: "agent", project: neighborResolved.slug, task: "T-NEIGHBOR" },
  };
  fake.agents.unshift(neighborPeer);

  // 2. The Lead ends a turn at 135k while T-03's Peer runs (v0.0.93 quiet
  //    point): the rotation is durably held in rotation_pending — the
  //    outgoing Lead stays the live, visible seat, no extraction prompt is
  //    sent, and no successor is created while the Peer works.
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending");
  assert.ok(fake.agents.some((a) => a.id === lead.id), "the outgoing Lead stays live and visible in rotation_pending");
  assert.equal(fake.sent.filter((s) => s.agentId === lead.id).length, 0, "no handoff extraction prompt while the Peer runs");
  assert.equal(fake.created.length, 0, "no Successor Lead is created while the Peer runs");

  // 3. Mail enqueued during rotation_pending stays mail_queued — a pump never
  //    wakes the over-threshold outgoing Lead for normal work.
  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Directive held through rotation_pending" });
  await leadMail.pumpProjectLead(slug);
  const events = readMailboxLines(stateDir, slug);
  assert.equal(events.filter((e) => e.type === "mail_queued").length, 1);
  assert.equal(events.filter((e) => e.type === "mail_delivered").length, 0);
  assert.equal(fake.sent.length, 0, "held mail is never delivered in rotation_pending");

  // 4. T-03 finishes GREEN while neighborPeer is STILL running in the
  //    neighbor Project. notifyPeer scopes the quiet-point check to `slug`
  //    (ignoring the neighbor Project's Peer), so this Project's rotation
  //    begins — the extraction prompt reaches the still-live outgoing Lead.
  t03Peer.status = "closed";
  factory.ledger.append({ event: "gate_finished", task: "T-03", attempt: 1, verdict: "green", exit: 0, note: "" });
  await leadMail.notifyPeer({ task: "T-03", kind: "verdict", text: "T-03 attempt 1 ended GREEN" });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
  const extractionSends = fake.sent.filter((s) => s.agentId === lead.id);
  assert.equal(extractionSends.length, 1, "the handoff extraction prompt reached the outgoing Lead the moment the Peer settled");
  assert.match(extractionSends[0]!.text, /Lead handoff extraction/);

  // 5. The extraction turn completes: the outgoing Lead archives, the
  //    successor spawns at 0%, rotation resets to normal, and Turn 1
  //    delivers the kickoff packet + handoff + the Peer's verdict + the
  //    held directive together in one immediate atomic turn.
  await leadMail.onLeadTurnEnded({
    agentId: lead.id,
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "# Handoff for T-03\nReview T-03 when Peer finishes." }],
  });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal");
  assert.equal(fake.agents.some((a) => a.id === lead.id), false, "the outgoing Lead was archived at completion");
  // v0.6.1 (ADR 0057 §11 hygiene, spec story 8): the handover file records the
  // outgoing Lead id and a written-at timestamp, so a later successor kickoff
  // can date it against the outgoing Lead's last activity.
  const handoffOnDisk = readFileSync(join(projectStateDir(stateDir, slug), "lead-handoff.md"), "utf8");
  assert.match(handoffOnDisk, new RegExp(`^<!-- paseo-factory handoff: lead=${lead.id} written-at=\\S+ -->`), "the handover file records the outgoing Lead id and a written-at timestamp");
  assert.match(handoffOnDisk, /# Handoff for T-03/, "the handover body follows the metadata header");
  const successorId = "agent-created-1";
  const successor = fake.agents.find((a) => a.id === successorId);
  assert.ok(successor);
  const successorSends = fake.sent.filter((s) => s.agentId === successorId);
  assert.equal(successorSends.length, 1, "the Successor Lead receives its Turn-1 kickoff immediately upon creation, despite the neighbor Project's Peer still running");
  assert.match(successorSends[0]!.text, /\[paseo-factory seat kickoff packet · role=lead/);
  assert.match(successorSends[0]!.text, /# Lead handoff — project/);
  assert.match(successorSends[0]!.text, /# Handoff for T-03\nReview T-03 when Peer finishes\./);
  assert.doesNotMatch(successorSends[0]!.text, /paseo-factory handoff:/, "the file's metadata header never leaks into the successor's kickoff");
  assert.match(successorSends[0]!.text, /T-03 attempt 1 ended GREEN/);
  assert.match(successorSends[0]!.text, /Directive held through rotation_pending/);
  assert.ok(fake.agents.some((a) => a.id === neighborPeer.id), "the neighbor Project's Peer was untouched");

  // 6. Reporting to a 'closed' Supervisor also wakes Supervisor and delivers the report batch
  supervisor.status = "closed";
  const supReport = await leadMail.reportSupervisor({
    id: "rep-closed-sup",
    kind: "supervisor_report",
    project: slug,
    message: "All waves verified.",
  });
  assert.equal(supReport.ok, true);
  const supSends = fake.sent.filter((s) => s.agentId === supervisor.id);
  assert.equal(supSends.length, 1, "closed Supervisor woke and received the report batch");
  assert.match(supSends[0]!.text, /All waves verified\./);

  // 6. Simulate a daemon/plugin restart by creating a fresh LeadMailRuntime against the same stateDir:
  //    - Case A: If a seat already has a non-empty `lastUserMessageAt`, subsequent turns do NOT re-inject the Turn-1 kickoff packet.
  await leadMail.onLeadTurnEnded({ agentId: successorId, outcome: { kind: "completed" }, timeline: [] });
  (successor as FakeAgent & { lastUserMessageAt?: string | null }).lastUserMessageAt = "2026-10-29T22:05:00.000Z";
  successor.status = "idle";

  const restartedRuntime = createLeadMailRuntime({
    factory,
    stateDir,
    daemon: fake.daemon,
    ensureLead: (input) => surface.leadEnsure(input),
    retireLead: (input) => surface.leadRotate(input),
  });
  t.after(() => restartedRuntime.stop());

  await restartedRuntime.dispatchLead({
    id: "ld-after-restart",
    kind: "lead_dispatch",
    project: slug,
    message: "Follow-up after daemon restart",
  });
  const successorSendsAfterRestart = fake.sent.filter((s) => s.agentId === successorId);
  assert.equal(successorSendsAfterRestart.length, 2);
  assert.doesNotMatch(
    successorSendsAfterRestart[1]!.text,
    /\[paseo-factory seat kickoff packet/,
    "seat with non-empty lastUserMessageAt does not receive duplicate Turn-1 kickoff after daemon restart",
  );
  assert.doesNotMatch(
    successorSendsAfterRestart[1]!.text,
    /# Lead handoff — project/,
    "seat with non-empty lastUserMessageAt does not receive duplicate handoff after daemon restart",
  );
  assert.match(successorSendsAfterRestart[1]!.text, /Follow-up after daemon restart/);

  //    - Case B: If a rotated successor Lead has `lastUserMessageAt: null` (never received Turn 1 before daemon restart)
  //      and `<projectStateDir>/lead-handoff.md` exists on disk, the restarted runtime reconstructs the handoff bundle from disk!
  await restartedRuntime.onLeadTurnEnded({ agentId: successorId, outcome: { kind: "completed" }, timeline: [] });
  const unstartedLead: FakeAgent & { lastUserMessageAt?: string | null } = {
    id: "agent-lead-unstarted-after-restart",
    status: "closed",
    cwd: projectRoot,
    labels: { seat: "lead", project: slug },
    lastUserMessageAt: null,
  };
  const idx = fake.agents.findIndex((a) => a.id === successorId);
  if (idx !== -1) fake.agents.splice(idx, 1, unstartedLead);
  writeProjectRegistration(stateDir, slug, { root: projectRoot, lead: unstartedLead.id, rotationState: "normal" });

  await restartedRuntime.enqueueLeadMail(slug, { from: "peer", kind: "verdict", task: "T-03", text: "Recovered verdict after restart" });
  await restartedRuntime.pumpProjectLead(slug);

  const unstartedSends = fake.sent.filter((s) => s.agentId === unstartedLead.id);
  assert.equal(unstartedSends.length, 1, "unstarted closed successor Lead received reconstructed handoff + mail after restart");
  assert.match(unstartedSends[0]!.text, /\[paseo-factory seat kickoff packet · role=lead/);
  assert.match(unstartedSends[0]!.text, /# Lead handoff — project/);
  assert.match(unstartedSends[0]!.text, /# Handoff for T-03\nReview T-03 when Peer finishes\./);
  assert.match(unstartedSends[0]!.text, /Recovered verdict after restart/);
});

// ---- lost-Lead recovery (v0.6.1, ADR 0057 §4) ----------------------------------------------

/**
 * Seeds one Project whose registered Lead has NOT received its first turn,
 * writes `lead-handoff.md` as given, and pumps one queued directive — the
 * successor-kickoff-from-disk arm (the restart/unstarted-successor path).
 * Returns the Turn-1 kickoff text the unstarted Lead received.
 */
async function unstartedSuccessorKickoff(t: TestContext, handoffFile: string): Promise<string> {
  const unstarted: FakeAgent = {
    id: "agent-lead-unstarted-disk",
    status: "idle",
    cwd: "",
    labels: { seat: "lead", project: "" },
  };
  const runtime = makeSpooledRuntime(t, [unstarted]);
  unstarted.cwd = runtime.projectRoot;
  unstarted.labels = { seat: "lead", project: runtime.slug };
  writeProjectRegistration(runtime.stateDir, runtime.slug, { root: runtime.projectRoot, lead: unstarted.id, rotationState: "normal" });
  writeFileSync(join(projectStateDir(runtime.stateDir, runtime.slug), "lead-handoff.md"), handoffFile);
  await runtime.leadMail.enqueueLeadMail(runtime.slug, { from: "supervisor", kind: "directive", text: "Directive for the disk-fed successor" });
  await runtime.leadMail.pumpProjectLead(runtime.slug);
  const sends = runtime.fake.sent.filter((entry) => entry.agentId === unstarted.id);
  assert.equal(sends.length, 1, "the unstarted successor received its Turn-1 kickoff");
  return sends[0]!.text;
}

test("v0.6.1 (ADR 0057 §11 hygiene): a disk-fed successor kickoff dates the handover — a fresh file carries no staleness line and no metadata leak", async (t) => {
  const kickoff = await unstartedSuccessorKickoff(
    t,
    `<!-- paseo-factory handoff: lead=agent-lead-old written-at=${new Date().toISOString()} -->\n\n# Fresh handoff\nWave N complete, T-09 green.`,
  );
  assert.match(kickoff, /# Lead handoff — project/);
  assert.match(kickoff, /# Fresh handoff\nWave N complete, T-09 green\./, "the handover body rides the kickoff");
  assert.doesNotMatch(kickoff, /Staleness notice/, "a dated, current handover is trusted — no staleness line");
  assert.doesNotMatch(kickoff, /paseo-factory handoff:/, "the file's metadata header never leaks into the kickoff");
  assert.match(kickoff, /Successor Turn-1 Discipline:.*do NOT `grep` or `cat` raw `<projectStateDir>\/ledger\.jsonl`/, "successor kickoff guards against raw ledger.jsonl archaeology");
  assert.match(kickoff, /Directive for the disk-fed successor/, "the queued mail still rides the same turn");
});

test("v0.6.1 (ADR 0057 §11 hygiene): a disk-fed successor kickoff marks a handover WITHOUT metadata stale-unknown — even with no lost Lead", async (t) => {
  const kickoff = await unstartedSuccessorKickoff(t, "# Legacy handoff\nWave 2 was mid-flight.\n");
  assert.match(kickoff, /# Legacy handoff\nWave 2 was mid-flight\./, "the legacy handover still rides the kickoff");
  assert.match(kickoff, /Staleness notice: this handover may predate the lost Lead's last activity — its age is unknown/, "a file without the v0.6.1 metadata is stale-unknown, never fresh");
  assert.match(kickoff, /Re-read the Ledger and the repository/, "the notice tells the successor to re-read the Ledger and repository");
});

test("v0.6.1 (ADR 0057 §11 hygiene): a lost Lead's successor kickoff marks a DATED old handover stale with the dated line", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-lost-dated", status: "idle", lastUserMessageAt: "2026-11-12T08:00:00.000Z" };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });
  // The plugin's own rotation wrote this file hours before the Lead was lost —
  // the Lead kept working after it, so it is older than the last activity.
  mkdirSync(join(projectStateDir(stateDir, slug)), { recursive: true });
  const writtenAt = new Date(Date.now() - 8 * 3_600_000).toISOString();
  writeFileSync(
    join(projectStateDir(stateDir, slug), "lead-handoff.md"),
    `<!-- paseo-factory handoff: lead=${lead.id} written-at=${writtenAt} -->\n\n# Dated handoff\nMorning state snapshot.`,
  );

  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Directive the dated successor receives" });
  await leadMail.pumpProjectLead(slug);
  assert.ok(readLeadMailbox(join(projectStateDir(stateDir, slug), "mailbox.jsonl")).inFlight, "the delivery is live and unacked");

  await fake.emitArchive(lead.id);
  const successorIndex = fake.created.findIndex((agent) => agent.labels?.seat === "lead");
  assert.ok(successorIndex !== -1, "a successor Lead was ensured");
  const successorId = `agent-created-${successorIndex + 1}`;
  const successorSends = fake.sent.filter((entry) => entry.agentId === successorId);
  assert.equal(successorSends.length, 1);
  assert.doesNotMatch(successorSends[0]!.text, /# Dated handoff\nMorning state snapshot\./, "a stale disk handover is replaced");
  assert.match(successorSends[0]!.text, /Plugin-built handover/, "a lost Lead gets a substitute for a dated-old handover");
  assert.match(successorSends[0]!.text, /Plugin-built handover/);
  assert.doesNotMatch(successorSends[0]!.text, /paseo-factory handoff:/, "the metadata header never leaks");
});

test("v0.6.1 (ADR 0057 §4): an outside archive of the bound Lead (agent.archive.after) requeues unacked mail (lead_lost) and the next pump spawns a successor whose kickoff carries the handover with the staleness line", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-lost", status: "idle", lastUserMessageAt: "2026-11-12T08:00:00.000Z" };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });
  // A handover from an earlier rotation, hours older than the Lead's last turn.
  mkdirSync(join(projectStateDir(stateDir, slug)), { recursive: true });
  writeFileSync(join(projectStateDir(stateDir, slug), "lead-handoff.md"), "# Old handoff\nWave 2 was mid-flight.\n");

  // Mail delivered but never acked — the Lead died mid-delivery.
  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Directive the lost Lead never acked" });
  await leadMail.pumpProjectLead(slug);
  assert.ok(readLeadMailbox(join(projectStateDir(stateDir, slug), "mailbox.jsonl")).inFlight, "the delivery is live and unacked");

  // The Owner archives the Lead from Paseo's own UI — a daemon archive the plugin did not perform.
  await fake.emitArchive(lead.id);

  assert.equal(fake.agents.some((agent) => agent.id === lead.id), false, "the daemon no longer lists the lost Lead");
  const events = readMailboxLines(stateDir, slug);
  const requeued = events.filter((event) => event.type === "mail_requeued");
  assert.equal(requeued.length, 1, "exactly one requeue settles the unacked delivery");
  assert.equal(requeued[0]?.reason, "lead_lost");
  assert.equal(requeued[0]?.to, "lead");

  // The next pump (the recovery's own) created the successor through the normal succession path.
  const successorIndex = fake.created.findIndex((agent) => agent.labels?.seat === "lead");
  assert.ok(successorIndex !== -1, "a successor Lead was ensured");
  const successorId = `agent-created-${successorIndex + 1}`;
  assert.notEqual(successorId, lead.id);
  assert.equal(readProjectRegistration(stateDir, slug)?.lead, successorId, "the dead Lead's binding cleared and the successor bound in its place");
  const successorSends = fake.sent.filter((entry) => entry.agentId === successorId);
  assert.equal(successorSends.length, 1, "the successor received its Turn-1 kickoff");
  assert.match(successorSends[0]!.text, /\[paseo-factory seat kickoff packet · role=lead/);
  assert.match(successorSends[0]!.text, /# Lead handoff — project/);
  assert.doesNotMatch(successorSends[0]!.text, /# Old handoff\nWave 2 was mid-flight\./);
  assert.match(successorSends[0]!.text, /Plugin-built handover/);
  assert.match(successorSends[0]!.text, /Plugin-built handover/);
  assert.match(successorSends[0]!.text, /Directive the lost Lead never acked/, "the requeued mail is delivered to the successor");
});

test("v0.6.1 (ADR 0057 §4): a lost Lead with NO on-disk handover spawns a successor without a staleness line or handoff layer", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-lost-bare", status: "idle", lastUserMessageAt: "2026-11-12T08:00:00.000Z" };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Directive for the bare successor" });
  await leadMail.pumpProjectLead(slug);
  await fake.emitArchive(lead.id);

  const successorIndex = fake.created.findIndex((agent) => agent.labels?.seat === "lead");
  assert.ok(successorIndex !== -1, "a successor Lead was still ensured");
  const successorId = `agent-created-${successorIndex + 1}`;
  const successorSends = fake.sent.filter((entry) => entry.agentId === successorId);
  assert.equal(successorSends.length, 1);
  assert.doesNotMatch(successorSends[0]!.text, /Staleness notice/, "no handover on disk — no staleness line to carry");
  assert.match(successorSends[0]!.text, /Plugin-built handover/, "missing disk handover gets a substitute");
  assert.match(successorSends[0]!.text, /Directive for the bare successor/, "the requeued mail still reaches the successor");
});

test("v0.6.1 (ADR 0057 §4): archives the plugin performs itself (manual rotate, handoff retire) never trigger lost-Lead recovery", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-own", status: "idle", lastUserMessageAt: "2026-11-12T08:00:00.000Z" };
  const { stateDir, slug, projectRoot, surface, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });
  await surface.leadDispatch({ projectRoot, message: "Directive delivered to the live Lead" });
  assert.ok(readLeadMailbox(join(projectStateDir(stateDir, slug), "mailbox.jsonl")).inFlight, "a delivery is live when the rotate fires");

  // The plugin's own archive door — the fake daemon fires agent.archive.after
  // for it too, exactly like a real one.
  const rotated = await surface.leadRotate({ projectRoot });
  assert.ok(rotated.ok, rotated.ok ? "" : rotated.error);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const events = readMailboxLines(stateDir, slug);
  assert.equal(events.some((event) => event.type === "mail_requeued" && event.reason === "lead_lost"), false, "a plugin archive never records lead_lost");
  assert.equal(events.some((event) => event.type === "mail_requeued" && event.reason === "lead-rotated"), true, "the normal rotate settle requeues instead");
  assert.equal(fake.created.length, 0, "the archive event alone never spawns a successor — no dispatch, no ensure");
});

test("v0.6.1 (ADR 0057 §4): a Project reset's and delete's own archives never trigger lost-Lead recovery — no successor rises from the cleanup", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-reset", status: "idle", lastUserMessageAt: "2026-11-12T08:00:00.000Z" };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });
  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Directive in flight when the reset lands" });
  await leadMail.pumpProjectLead(slug);

  const reset = await surface.projectReset({ projectRoot });
  assert.ok(reset.ok, reset.ok ? "" : reset.error);
  assert.ok(reset.archivedSeats.includes(lead.id), "the reset archived the bound Lead itself");
  assert.equal(fake.created.length, 0, "the reset's archive events never raise a successor through lost-Lead recovery");
  assert.equal(readProjectRegistration(stateDir, slug)?.lead, undefined, "the reset cleared the binding its own way");

  // projectDelete has no retireSeat loop — cleanupProjectArtifacts' own mark
  // is its only guard, exercised here with a second bound Lead.
  const doomedRoot = makeTempDir();
  disposeDir(t, doomedRoot);
  writeFileSync(join(doomedRoot, "README.md"), "doomed\n");
  gitCommitAll(doomedRoot);
  const doomed = ensureProjectRegistered(stateDir, doomedRoot);
  assert.ok(doomed.ok);
  const doomedLead: FakeAgent = { id: "agent-lead-doomed", status: "idle", labels: { seat: "lead", project: doomed.slug }, cwd: doomedRoot };
  fake.agents.push(doomedLead);
  writeProjectRegistration(stateDir, doomed.slug, { root: doomedRoot, lead: doomedLead.id });
  // Queued mail for the doomed Project: without the mark, the cleanup's
  // archive would run lost-Lead recovery and raise a successor to eat it.
  await leadMail.enqueueLeadMail(doomed.slug, { from: "supervisor", kind: "directive", text: "Directive queued for the doomed Lead" });

  const deleted = await surface.projectDelete({ projectSlug: doomed.slug });
  assert.ok(deleted.ok, deleted.ok ? "" : deleted.error);
  assert.ok(deleted.archivedSeats.includes(doomedLead.id), "the delete archived the bound Lead through the cleanup seam");
  assert.equal(fake.agents.some((agent) => agent.id === doomedLead.id), false);
  assert.equal(fake.created.length, 0, "the delete's archive events never raise a successor either");
});

test("ADR 0060: Rotate seats archives both seats with no lost-Lead recovery, no Substitute handover and no recreated Lead — the next Supervisor dispatch raises a Lead whose kickoff carries no handover", async (t) => {
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t);
  const supervisor = await surface.supervisorEnsure({ projectRoot });
  const lead = await surface.leadEnsure({ projectRoot });
  assert.ok(supervisor.ok && lead.ok);
  // Mail mid-delivery and queued behind it, plus the on-disk handover records of the old Lead.
  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Directive in flight when the rotation lands" });
  await leadMail.pumpProjectLead(slug);
  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Directive still queued" });
  const projectDir = projectStateDir(stateDir, slug);
  writeFileSync(join(projectDir, "lead-handoff.md"), "# the old Lead's handover — STALE-CONTEXT\n");
  writeFileSync(join(projectDir, "lead-handoff-extraction.json"), `${JSON.stringify({ leadLostAt: "2026-11-12T08:00:00.000Z" })}\n`);
  writeFileSync(join(projectDir, "notebook.md"), "## 1. Verification & Run Recipe\nrun it\n");
  const createdBefore = fake.created.length;

  const rotated = await surface.projectRotate({ projectRoot });
  assert.ok(rotated.ok, rotated.ok ? "" : rotated.error);
  assert.deepEqual(rotated.archivedSeats, [lead.agentId, supervisor.agentId]);

  // Pumps and turn boundaries after the act find nothing: no Lead rises.
  await leadMail.pumpProjectLead(slug);
  await leadMail.pumpAll();
  await leadMail.onLeadTurnEnded({ agentId: lead.agentId, outcome: { kind: "canceled" }, timeline: [] });
  assert.equal(fake.created.length, createdBefore, "no Lead (or any seat) is recreated");
  const reg = readProjectRegistration(stateDir, slug);
  assert.equal(reg?.lead, undefined);
  assert.equal(reg?.supervisor, undefined);
  assert.equal(existsSync(join(projectDir, "lead-handoff.md")), false, "no Substitute handover is written, the old one is dropped");
  assert.equal(existsSync(join(projectDir, "lead-handoff-extraction.json")), false);
  assert.equal(readMailboxLines(stateDir, slug).some((event) => event.reason === "lead_lost"), false, "no lead_lost recovery fired");
  assert.equal(existsSync(join(projectDir, "notebook.md")), true, "the notebook survives");

  // The Owner opens a fresh Supervisor; its first dispatch creates a fresh Lead with the standard kickoff and no handover.
  const started = await surface.supervisorStart({ projectRoot });
  assert.ok(started.ok, started.ok ? "" : started.error);
  const dispatched = await leadMail.dispatchLead({ id: "ld-after-rotate", kind: "lead_dispatch", workspace: projectRoot, message: "Start the next wave", seat: "supervisor" });
  assert.equal(dispatched.ok, true, dispatched.ok ? "" : JSON.stringify(dispatched));
  const freshLead = readProjectRegistration(stateDir, slug)?.lead;
  assert.ok(freshLead !== undefined && freshLead !== lead.agentId, "a fresh Lead is bound");
  const firstTexts = [
    ...fake.created.filter((entry) => entry.labels.seat === "lead").map((entry) => entry.prompt ?? ""),
    ...fake.sent.filter((entry) => entry.agentId === freshLead).map((entry) => entry.text),
  ].join("\n");
  assert.match(firstTexts, /Start the next wave/, "the Lead's first prompt carries the dispatched directive");
  assert.match(firstTexts, /Verification & Run Recipe/, "and the standard kickoff's notebook");
  assert.doesNotMatch(firstTexts, /# Lead handoff|Outgoing Lead handoff|Plugin-built handover|Staleness notice|STALE-CONTEXT|Directive still queued|Directive in flight/, "no handover, no stale notice, no old mail");
});

/** A gate one test opens by hand: `wait()` parks the daemon call, `release()` lets it through. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  let reached = false;
  return { wait: async () => { reached = true; await opened; }, release: open, get reached() { return reached; } };
}

const liveSeats = (fake: { agents: FakeAgent[] }, seat: string): FakeAgent[] => fake.agents.filter((agent) => agent.labels?.seat === seat);

test("ADR 0060 (S1): a Lead handoff paused mid-flight when Rotate lands writes no lead-handoff.md, no Substitute and raises no Lead afterwards", async (t) => {
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [], { registry: true });
  const lead = await surface.leadEnsure({ projectRoot });
  assert.ok(lead.ok);
  const projectDir = projectStateDir(stateDir, slug);
  const paused = gate();
  fake.hooks.timeline = paused.wait; // the handoff's Substitute evidence read parks here
  const createdBefore = fake.created.length;
  const handoff = leadMail.handoff({ slug, seat: "lead", action: "replaceNow" });
  await until(() => assert.equal(paused.reached, true));

  const rotated = await surface.projectRotate({ projectRoot });
  assert.ok(rotated.ok, rotated.ok ? "" : rotated.error);
  paused.release();
  await handoff;
  await leadMail.pumpProjectLead(slug);
  await leadMail.pumpAll();

  assert.deepEqual(liveSeats(fake, "lead"), [], "no live Lead after the rotation");
  assert.equal(fake.created.length, createdBefore, "no successor was created");
  assert.equal(existsSync(join(projectDir, "lead-handoff.md")), false, "no Substitute handover was written");
  assert.equal(existsSync(join(projectDir, "lead-handoff-extraction.json")), false);
  assert.equal(readProjectRegistration(stateDir, slug)?.lead, undefined);
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, undefined);
});

test("ADR 0060 (S1): a Lead handoff whose successor creation is pending when Rotate lands leaves no live Lead", async (t) => {
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [], { registry: true });
  const lead = await surface.leadEnsure({ projectRoot });
  assert.ok(lead.ok);
  const projectDir = projectStateDir(stateDir, slug);
  const paused = gate();
  const handoff = leadMail.handoff({ slug, seat: "lead", action: "replaceNow" });
  fake.hooks.create = paused.wait; // the successor's daemon create parks here
  await until(() => assert.equal(paused.reached, true));

  const rotating = surface.projectRotate({ projectRoot });
  await new Promise((resolve) => setTimeout(resolve, 50));
  paused.release();
  const rotated = await rotating;
  await handoff;
  await leadMail.pumpProjectLead(slug);

  assert.ok(rotated.ok, rotated.ok ? "" : rotated.error);
  assert.deepEqual(liveSeats(fake, "lead"), [], "the half-created successor is archived too");
  assert.equal(readProjectRegistration(stateDir, slug)?.lead, undefined);
  assert.equal(existsSync(join(projectDir, "lead-handoff.md")), false, "no handover survives");
  assert.equal(existsSync(join(projectDir, "mailbox.jsonl")), false);
});

test("ADR 0060 (S1): a handoff extraction pending when Rotate lands never completes into a successor when the old Lead's turn ends", async (t) => {
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [], { registry: true });
  const lead = await surface.leadEnsure({ projectRoot });
  assert.ok(lead.ok);
  // The Owner's handoff: the extraction prompt is out and the Project sits in handing_over.
  const started = await leadMail.handoff({ slug, seat: "lead", action: "start", reason: "owner" });
  assert.ok(started.ok);
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
  const second = lead;
  const createdBefore = fake.created.length;

  const rotated = await surface.projectRotate({ projectRoot });
  assert.ok(rotated.ok, rotated.ok ? "" : rotated.error);
  await leadMail.onLeadTurnEnded({ agentId: second.agentId, outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "A perfectly good handover that must never reach a successor." }] });

  assert.equal(fake.created.length, createdBefore);
  assert.deepEqual(liveSeats(fake, "lead"), []);
  assert.equal(existsSync(join(projectStateDir(stateDir, slug), "lead-handoff.md")), false);
});

test("v0.6.1 (ADR 0057 §4): the released Supervisor archives when the Lead handoff retires the parented Lead — end to end through the rotation machine", async (t) => {
  const supervisor: FakeAgent = { id: "agent-sup-rel", status: "idle" };
  const lead: FakeAgent = { id: "agent-lead-rel", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 }, parentAgentId: "agent-sup-rel" };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [supervisor, lead]);
  supervisor.labels = { seat: "supervisor", project: slug };
  supervisor.cwd = projectRoot;
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.supervisorEnsure({ projectRoot });
  await surface.leadEnsure({ projectRoot });
  assert.equal(readProjectRegistration(stateDir, slug)?.supervisor, "agent-sup-rel", "the pre-v0.6.1 parented pair is bound");

  // The Supervisor is replaced directly: the parented live Lead holds the archive — a release is recorded.
  const revoked = await surface.supervisorRevoke({ projectRoot });
  assert.ok(revoked.ok, revoked.ok ? "" : revoked.error);
  const reg = readProjectRegistration(stateDir, slug);
  assert.equal(reg?.releasedSupervisors?.[0]?.agentId, "agent-sup-rel");
  assert.equal(reg?.releasedSupervisors?.[0]?.waitingOnLead, "agent-lead-rel");
  assert.ok(fake.agents.some((agent) => agent.id === supervisor.id), "the released Supervisor stays live");

  // The Lead crosses its mark and rotates: extraction, completion, retire, successor.
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
  await leadMail.onLeadTurnEnded({
    agentId: lead.id,
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "# Handoff after release\nWave 3 continues." }],
  });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal");
  assert.equal(fake.agents.some((agent) => agent.id === lead.id), false, "the parented Lead archived through its own handoff");
  assert.equal(fake.agents.some((agent) => agent.id === supervisor.id), false, "the released Supervisor archived once its Lead did");
  assert.equal(readProjectRegistration(stateDir, slug)?.releasedSupervisors, undefined, "the release record settled and cleared");
  assert.ok(fake.created.some((agent) => agent.labels?.seat === "lead"), "the rotation's successor Lead exists");
});

test("v0.6.1 review fix (ADR 0057 §4): a parented Lead archived from OUTSIDE settles the released Supervisor — the record never outlives its Lead", async (t) => {
  const supervisor: FakeAgent = { id: "agent-sup-outside", status: "idle" };
  const lead: FakeAgent = { id: "agent-lead-outside", status: "idle", parentAgentId: "agent-sup-outside" };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [supervisor, lead]);
  supervisor.labels = { seat: "supervisor", project: slug };
  supervisor.cwd = projectRoot;
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.supervisorEnsure({ projectRoot });
  await surface.leadEnsure({ projectRoot });
  // Mail in flight when the Lead vanishes — the lost-Lead recovery's mark.
  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Directive in flight when the Lead vanishes" });
  await leadMail.pumpProjectLead(slug);

  // The Supervisor is replaced while its Lead is still parented: a release
  // record waits on the parented Lead.
  const revoked = await surface.supervisorRevoke({ projectRoot });
  assert.ok(revoked.ok, revoked.ok ? "" : revoked.error);
  assert.equal(readProjectRegistration(stateDir, slug)?.releasedSupervisors?.[0]?.agentId, "agent-sup-outside");

  // The OUTSIDE archive: the daemon fires agent.archive.after for the
  // parented Lead with no plugin door involved (the fake's emitArchive).
  await fake.emitArchive(lead.id);

  assert.ok(fake.agents.some((agent) => agent.id === supervisor.id) === false, "the released Supervisor archived once its Lead was archived from outside");
  assert.equal(readProjectRegistration(stateDir, slug)?.releasedSupervisors, undefined, "the release record settled and cleared through the lost-Lead door");
  assert.equal(readMailboxLines(stateDir, slug).some((event) => event.type === "mail_requeued" && event.reason === "lead_lost"), true, "the lost-Lead recovery still requeues the in-flight mail");
  assert.ok(fake.created.some((agent) => agent.labels?.seat === "lead"), "the lost-Lead pump still raises a successor Lead");
});

/** The persisted plugin-archive markers (v0.6.1 review fix) — `<stateDir>/plugin-archive-markers.json`. */
const readMarkerIds = (stateDir: string): string[] => {
  const path = join(stateDir, "plugin-archive-markers.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
};

test("v0.6.1 review fix: the plugin's own archive marker survives a plugin restart — the daemon's late agent.archive.after is never misread as a lost Lead", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-marked", status: "idle", lastUserMessageAt: "2026-11-13T08:00:00.000Z" };
  const first = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: first.slug };
  lead.cwd = first.projectRoot;
  await first.surface.leadEnsure({ projectRoot: first.projectRoot });
  await first.leadMail.enqueueLeadMail(first.slug, { from: "supervisor", kind: "directive", text: "Directive in flight when the plugin restarts" });
  await first.leadMail.pumpProjectLead(first.slug);
  assert.ok(readLeadMailbox(join(projectStateDir(first.stateDir, first.slug), "mailbox.jsonl")).inFlight, "a delivery is live when the mark is set");

  // The plugin marks its own upcoming archive (every plugin archive door
  // does) — then RESTARTS before the daemon delivers agent.archive.after.
  first.leadMail.markPluginArchive(lead.id);
  assert.deepEqual(readMarkerIds(first.stateDir), [lead.id], "the marker persisted the moment it was set");

  const second = createLeadMailRuntime({
    factory: first.factory,
    stateDir: first.stateDir,
    daemon: first.fake.daemon,
    ensureLead: (input) => first.surface.leadEnsure(input),
    retireLead: (input) => first.surface.leadRotate(input),
    settleReleasedSupervisor: (input) => first.surface.settleReleasedSupervisor(input),
    onLog: () => {},
  });
  t.after(() => second.stop());

  await second.onAgentArchived({ agentId: lead.id });
  assert.equal(readProjectRegistration(first.stateDir, first.slug)?.lead, lead.id, "the late event for a marked archive never clears the binding");
  assert.equal(readMailboxLines(first.stateDir, first.slug).some((event) => event.type === "mail_requeued" && event.reason === "lead_lost"), false, "and never requeues as lead_lost");
  assert.deepEqual(readMarkerIds(first.stateDir), [], "the consumed event cleared the marker again");
});

test("v0.6.1 review fix: a failed plugin archive clears its marker — a later genuine outside archive of the same id still runs lost-Lead recovery", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-fail", status: "idle", lastUserMessageAt: "2026-11-13T08:00:00.000Z" };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });
  await leadMail.enqueueLeadMail(slug, { from: "supervisor", kind: "directive", text: "Directive in flight when the archive refuses" });
  await leadMail.pumpProjectLead(slug);

  // The daemon refuses THIS agent's archive once: the plugin's own rotate
  // marks the id, the archive call throws, the rotate fails.
  const originalRef = fake.daemon.agents.ref.bind(fake.daemon.agents);
  let refuseArchive = true;
  fake.daemon.agents.ref = (id: string): ReturnType<typeof originalRef> => {
    const ref = originalRef(id);
    return {
      ...ref,
      archive: async () => {
        if (refuseArchive) throw new Error("archive refused");
        return ref.archive();
      },
    };
  };

  const rotated = await surface.leadRotate({ projectRoot });
  assert.ok(!rotated.ok, "the rotate fails when the daemon refuses the archive");
  assert.deepEqual(readMarkerIds(stateDir), [], "the failed archive left no stale marker behind");

  // The SAME id is then archived from OUTSIDE: lost-Lead recovery must run —
  // a stale marker must not swallow it.
  refuseArchive = false;
  await fake.emitArchive(lead.id);
  assert.notEqual(readProjectRegistration(stateDir, slug)?.lead, lead.id, "the genuine outside archive clears the dead Lead's binding (the pump rebinds the successor)");
  assert.equal(fake.agents.some((agent) => agent.id === lead.id), false, "the archived Lead is gone");
  assert.equal(readMailboxLines(stateDir, slug).some((event) => event.type === "mail_requeued" && event.reason === "lead_lost"), true, "and requeues the in-flight mail as lead_lost");
});

test("settleTurnAndRotate begins the handoff immediately at the turn boundary when no Peer is running (v0.0.93, ADR 0031)", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-quiet", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 1 } };
  const { stateDir, slug, projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over", "a Project already at a quiet point rotates without delay");
  const extractionSends = fake.sent.filter((s) => s.agentId === lead.id);
  assert.equal(extractionSends.length, 1, "the extraction prompt was steered on the same turn boundary");
  assert.match(extractionSends[0]!.text, /Lead handoff extraction/);
  assert.equal(fake.created.length, 0, "no successor exists until the extraction turn completes");
});

test("pumpProjectLead recovers a rotation_pending Project once its Peer stops — even a dead (error) Peer — completing the rotation cleanly (v0.0.93, ADR 0031)", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-pump-rec", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  const root = readProjectRegistration(stateDir, slug)!.root!;
  factory.setContract({ task: "T-REC", workspace: root, gate: "true" });
  const worktree = taskWorktreePath(stateDir, slug, "T-REC");
  factory.requestSpawn({ task: "T-REC", provider: "pi/model", arity: 1, worktree });
  const peer: FakeAgent = { id: "peer-rec", status: "running", cwd: worktree, labels: { seat: "agent", project: slug, task: "T-REC" } };
  fake.agents.unshift(peer);

  // Over threshold with the Peer running: the rotation holds in rotation_pending.
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending");
  assert.equal(fake.sent.length, 0, "no extraction prompt while the Peer runs");

  // The Peer dies mid-run (status 'error'): a bare pump — the startup
  // `pumpAll` path — begins the handoff without waiting for a notifyPeer
  // that may never come.
  peer.status = "error";
  await leadMail.pumpProjectLead(slug);
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over", "the pump transitioned rotation_pending to handing_over");
  assert.equal(fake.sent.filter((s) => s.agentId === lead.id).length, 1, "the pump began the extraction turn");

  // The extraction turn completes: rotation resets to normal and the successor is kicked off immediately.
  await leadMail.onLeadTurnEnded({
    agentId: lead.id,
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "# Pumped rotation handoff\nT-REC died mid-run." }],
  });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal");
  const successorId = readProjectRegistration(stateDir, slug)?.lead;
  assert.ok(successorId && successorId !== lead.id, "the successor Lead was spawned");
  const successorSends = fake.sent.filter((s) => s.agentId === successorId);
  assert.equal(successorSends.length, 1, "the successor received its Turn-1 kickoff immediately");
  assert.match(successorSends[0]!.text, /# Pumped rotation handoff/);
});

test('remote linked designs do not require the client source for reports or Peer blockers', { timeout: 3000 }, async t => {
  const f = makeSpooledRuntime(t);
  const path = join(projectStateDir(f.stateDir, f.slug), 'project-settings.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, revision: 1, openDesignSource: { kind: 'client' }, openDesignLink: { projectId: 'owner', projectName: 'Owner', sourceUpdatedAt: 1, syncedAt: new Date().toISOString(), digest: 'a'.repeat(64), screenCount: 1, files: ['index.html'] } }));
  await f.surface.supervisorStart({ projectRoot: f.projectRoot }); // v0.6.1 (ADR 0057 §5): reports never create the seat
  const report = await f.leadMail.reportSupervisor({ id: 'offline-report', kind: 'supervisor_report', project: f.slug, message: 'Work verified while the design computer is disconnected.' });
  assert.ok(report.ok, JSON.stringify(report));
  const blocker = await f.leadMail.dispatchLead({ id: 'offline-blocker', kind: 'lead_dispatch', project: f.slug, from: 'peer', message: 'Peer needs help with a build failure.' });
  assert.ok(blocker.ok, JSON.stringify(blocker));
  assert.ok(f.fake.sent.some(s => s.text.includes('Work verified')));
  const followup = f.leadMail.dispatchLead({ id: 'new-owner-followup', kind: 'lead_dispatch', project: f.slug, from: 'owner', message: 'New Owner directive' });
  await new Promise(resolve => setTimeout(resolve, 20));
  const status = await f.surface.openDesignStatus({ projectRoot: f.projectRoot }); assert.ok(status.ok); assert.equal(status.syncRequestId, 'new-owner-followup', 'an explicit runId must still request source freshness');
  assert.ok((await f.surface.openDesignUnlink({ projectRoot: f.projectRoot })).ok);
  assert.ok((await followup).ok, "the directive proceeds once the link is gone");
});

test('active work tracks both standing-seat deliveries', async t => {
  const { leadMail, surface, projectRoot, stateDir, slug } = makeSpooledRuntime(t);
  assert.equal(await leadMail.hasActiveWork(), false);
  // v0.6.1 (ADR 0057 §5): the Supervisor seat is started explicitly — a dispatch never creates one.
  await surface.supervisorStart({ projectRoot });
  for (const seat of ['supervisor', 'lead'] as const) {
    const reply = seat === 'supervisor'
      ? await leadMail.dispatchSupervisor({ id: `sleep-${seat}`, kind: 'supervisor_dispatch', workspace: projectRoot, message: 'Inspect the project' })
      : await leadMail.dispatchLead({ id: `sleep-${seat}`, kind: 'lead_dispatch', workspace: projectRoot, message: 'Inspect the project' });

    assert.ok(reply.ok);
    assert.equal(await leadMail.hasActiveWork(), true);
    const agentId = readProjectRegistration(stateDir, slug)?.[seat];
    assert.ok(agentId);
    await leadMail.onLeadTurnEnded({ agentId, outcome: { kind: 'completed' }, timeline: [] });
    assert.equal(await leadMail.hasActiveWork(), false);
  }
});

test('active work holds sleep inhibition for Gates and dispatched Task waves', async t => {
  const { leadMail, projectRoot, factory, fake } = makeSpooledRuntime(t);
  factory.setContract({ task: 'SLEEP-T01', workspace: projectRoot, gate: 'true', artifact: 'README.md' });
  factory.ledger.append({ event: 'gate_started', task: 'SLEEP-T01', attempt: 1, cmd: 'true' });
  assert.equal(await leadMail.hasActiveWork(), true);
  factory.ledger.append({ event: 'gate_finished', task: 'SLEEP-T01', attempt: 1, verdict: 'green', exit: 0, note: 'done' });
  assert.equal(await leadMail.hasActiveWork(), false);
  // v0.0.92 (spec §Implementation Decision 4): an open spawn round — even one
  // recorded without a worktree field — holds only while its Peer is LIVE
  // (matched by labels.task, the stamped agent id, or the worktree cwd); a
  // dead or absent Peer releases the hold instead of deadlocking it forever.
  const peer: FakeAgent = { id: 'sleep-wave-peer', status: 'running', cwd: projectRoot, labels: { task: 'SLEEP-T01' } };
  fake.agents.push(peer);
  factory.ledger.append({ event: 'spawn_dispatched', task: 'SLEEP-T01', provider: 'pi/test', arity: 1 });
  assert.equal(await leadMail.hasActiveWork(), true);
  peer.status = 'idle';
  assert.equal(await leadMail.hasActiveWork(), false, 'a stopped Peer releases the wave hold even on a worktree-less spawn round');
  peer.status = 'running';
  factory.ledger.append({ event: 'needs_human', task: 'SLEEP-T01', reason: 'silent-after-repoke', evidence: { denial: 1, repoke: 2 } });
  assert.equal(await leadMail.hasActiveWork(), false);
});

test('a stopped worktree Peer no longer holds the active-work sleep assertion', async t => {
  const { leadMail, projectRoot, factory, fake } = makeSpooledRuntime(t);
  const worktree = join(projectRoot, 'task-worktree');
  factory.setContract({ task: 'SLEEP-T02', workspace: projectRoot, gate: 'true', artifact: 'README.md' });
  factory.ledger.append({ event: 'spawn_dispatched', task: 'SLEEP-T02', provider: 'pi/test', arity: 1, worktree });
  const peer: FakeAgent = { id: 'sleep-peer', status: 'running', cwd: worktree, labels: { task: 'SLEEP-T02' } };
  fake.agents.push(peer);
  assert.equal(await leadMail.hasActiveWork(), true);
  peer.status = 'idle';
  assert.equal(await leadMail.hasActiveWork(), false);
});


test("Lead handoff persists the final Markdown reply, caps UTF-8 at 8 KB (LEAD_HANDOFF_MAX_BYTES), and prefers it over a disk fallback", async t => {
  assert.equal(LEAD_HANDOFF_MAX_BYTES, 8 * 1024, "v0.0.97 (ADR 0047 §3.3) lowers the lead-handoff.md cap from 24 KB to 8 KB");
  const lead: FakeAgent = { id: "reply-lead", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS } };
  const f = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: f.slug };
  lead.cwd = f.projectRoot;
  await f.surface.leadEnsure({ projectRoot: f.projectRoot });
  await f.leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  const prompt = f.fake.sent.find(item => item.agentId === lead.id)!.text;
  assert.match(prompt, /entire Markdown handoff directly in your final assistant message, in one piece/);
  assert.match(prompt, /without running shell commands or writing files to disk/);
  // v0.0.97 (ADR 0047 §3.3): the extraction prompt states the 8 KB cap and both
  // prohibitions — no verbatim Contract.description copy-pasting, no detailed
  // post-mortems or test inventories of already-accepted waves.
  assert.match(prompt, /capping it at 8 KB/);
  assert.match(prompt, /never copy-paste active Contract\.description blocks verbatim/i);
  assert.match(prompt, /ledger\.jsonl/);
  assert.match(prompt, /never write detailed post-mortems or test inventories of already-accepted waves/i);
  const path = join(projectStateDir(f.stateDir, f.slug), "lead-handoff.md");
  writeFileSync(path, "# Disk fallback\nOlder than the reply.");
  const reply = "# Reply handoff\n" + "Roadmap 🧭\n".repeat(4000);
  await f.leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: reply }] });
  const persisted = handoffBodyOnDisk(path);
  assert.match(persisted, /^# Reply handoff/);
  assert.ok(Buffer.byteLength(persisted) <= LEAD_HANDOFF_MAX_BYTES);
  assert.match(persisted, /\n\.\.\.\[truncated\]$/);
  assert.doesNotMatch(persisted, /�/);
  const successor = f.fake.sent.find(item => item.agentId !== lead.id)!.text;
  assert.ok(successor.includes(persisted));
});

test("Machine-Verified Active Peer Roster summarizes accepted Tasks into one count line and renders full rows strictly for unaccepted Tasks, each active row carrying the epoch disposition (v0.0.97, ADR 0047 §1.3; ADR 0053 §3)", async t => {
  const lead: FakeAgent = { id: "agent-lead-1", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });
  const canonicalRoot = readProjectRegistration(stateDir, slug)!.root!;

  // 6 already-accepted Tasks — closed history that must collapse into one summary line
  for (let i = 1; i <= 6; i += 1) {
    factory.setContract({ task: `T-ACC-${i}`, workspace: canonicalRoot, gate: "true", artifact: "README.md" });
    factory.ledger.append({ event: "attempt_accepted", task: `T-ACC-${i}`, attempt: 1, accepted_by: "owner" });
  }
  // 2 active unaccepted Tasks — these alone get full per-task rows
  factory.setContract({ task: "T-ACTIVE-BOUND", workspace: canonicalRoot, gate: "true", artifact: "README.md" });
  fake.agents.push({ id: "agent-active-bound", status: "idle", cwd: join(taskWorktreePath(stateDir, slug, "T-ACTIVE-BOUND"), "src") });
  factory.setContract({ task: "T-ACTIVE-FRESH", workspace: canonicalRoot, gate: "true", artifact: "README.md" });

  // Quiet-point rotation (the seeded agents are idle): turn 1 ends at 135k -> handing_over -> turn 2 completes
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "# Handoff\nWave 2 mid-flight." }] });

  const successorId = readProjectRegistration(stateDir, slug)?.lead;
  assert.ok(successorId && successorId !== lead.id);
  const kickoff = fake.sent.find(s => s.agentId === successorId && s.text.includes("Machine-Verified Active Peer Roster"));
  assert.ok(kickoff, "successor Lead received the Machine-Verified Active Peer Roster");

  // One compact accepted summary line: total count + the latest 5 accepted task IDs
  assert.match(kickoff.text, /- accepted tasks \(6\): T-ACC-2, T-ACC-3, T-ACC-4, T-ACC-5, T-ACC-6 \(latest 5 of 6\)/);
  // Full status/disposition/agent/worktree/attempt/report rows strictly for the active
  // unaccepted Tasks — since ADR 0053 §3 each active row carries the epoch's effective
  // Peer disposition, `engineer` when the Contract predates or omits the field.
  assert.match(kickoff.text, /- task T-ACTIVE-BOUND: status waiting · disposition engineer · agent agent-active-bound \(live: idle\)/);
  assert.match(kickoff.text, /- task T-ACTIVE-FRESH: status waiting · disposition engineer · agent \(none bound\)/);
  assert.match(kickoff.text, /- task T-ACTIVE-FRESH: .*no attempt yet/);
  // No O(N) closed-history rows for accepted Tasks
  for (let i = 1; i <= 6; i += 1) {
    assert.doesNotMatch(kickoff.text, new RegExp(`- task T-ACC-${i}: `), `accepted task T-ACC-${i} must not render a full roster row`);
  }
});

test("Machine-Verified Active Peer Roster reports '- active unaccepted tasks: none' once every Task is accepted (v0.0.97, ADR 0047 §1.3)", async t => {
  const lead: FakeAgent = { id: "agent-lead-1", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });
  const canonicalRoot = readProjectRegistration(stateDir, slug)!.root!;
  for (const task of ["T-DONE-1", "T-DONE-2"]) {
    factory.setContract({ task, workspace: canonicalRoot, gate: "true", artifact: "README.md" });
    factory.ledger.append({ event: "attempt_accepted", task, attempt: 1, accepted_by: "owner" });
  }

  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "# Handoff\nAll waves accepted." }] });

  const successorId = readProjectRegistration(stateDir, slug)?.lead;
  assert.ok(successorId && successorId !== lead.id);
  const kickoff = fake.sent.find(s => s.agentId === successorId && s.text.includes("Machine-Verified Active Peer Roster"));
  assert.ok(kickoff, "successor Lead received the Machine-Verified Active Peer Roster");
  assert.match(kickoff.text, /- accepted tasks \(2\): T-DONE-1, T-DONE-2/);
  assert.match(kickoff.text, /- active unaccepted tasks: none/);
  assert.doesNotMatch(kickoff.text, /- task T-DONE-1: /);
  assert.doesNotMatch(kickoff.text, /- task T-DONE-2: /);
});

test("Turn-1 kickoff delivery deduplicates the packet against config.systemPrompt: no linked design spec, helper-MCP roster, or wave-law repetition (v0.0.97, ADR 0047 §1.2)", async t => {
  const { projectRoot, surface, leadMail, fake } = makeSpooledRuntime(t);

  // Supervisor Turn 1 — prependKickoffPacketIfFirstTurn serves both seat call sites
  // (v0.6.1, ADR 0057 §5: the seat is started explicitly — the dispatch never creates one.)
  await surface.supervisorStart({ projectRoot });
  await leadMail.dispatchSupervisor({ id: "sd-dedup-1", kind: "supervisor_dispatch", workspace: projectRoot, message: "First Supervisor directive" });
  const supTurn1 = fake.sent[0]!.text;
  assert.match(supTurn1, /\[paseo-factory seat kickoff packet · role=supervisor/);
  assert.match(supTurn1, /- Workspace: /, "dynamic repository preflight facts stay in the Turn-1 packet");
  assert.match(supTurn1, /- Ledger tasks: /);
  assert.match(supTurn1, /- Role MCP tools \(paseo_factory\): /);
  assert.match(supTurn1, /- Law: Fire-and-End-Turn:/, "the Fire-and-End-Turn law stays in the Turn-1 packet");
  assert.doesNotMatch(supTurn1, /Open Design Linked Specification/, "the linked design specification stays in config.systemPrompt only");
  assert.doesNotMatch(supTurn1, /- Law: Outcome & Architecture Boundary:/, "SUPERVISOR_OUTCOME_BOUNDARY stays in config.systemPrompt only");

  // Lead Turn 1 — same shared helper, lead-scoped blocks
  await leadMail.dispatchLead({ id: "ld-dedup-1", kind: "lead_dispatch", workspace: projectRoot, message: "First Lead directive" });
  const leadTurn1 = fake.sent[1]!.text;
  assert.match(leadTurn1, /\[paseo-factory seat kickoff packet · role=lead/);
  assert.match(leadTurn1, /- Workspace: /);
  assert.match(leadTurn1, /- Ledger tasks: /);
  assert.match(leadTurn1, /- Role MCP tools \(paseo_factory\): /);
  assert.match(leadTurn1, /- Law: Fire-and-End-Turn:/);
  assert.doesNotMatch(leadTurn1, /Available Peer Helper MCPs:/, "the helper MCP roster stays in config.systemPrompt only");
  assert.doesNotMatch(leadTurn1, /Open Design Linked Specification/);
  assert.doesNotMatch(leadTurn1, /- Law: One Bounded Outcome per Task:/, "LEAD_WAVE_LAWS stay in config.systemPrompt only");
  assert.doesNotMatch(leadTurn1, /- Law: 4-Part Brief:/);
});


// v0.2.2 (ADR 0050 Decision 2): a `failed`/`canceled` extraction turn no longer
// completes the handoff — it holds `handing_over` and re-sends within the
// 3-send cap (pinned by the hold and ceiling tests above), so the failed-turn
// shape left this family; `refusal` keeps the completed-but-invalid-text arm.
for (const failure of ["refusal", "send", "timeout"] as const) {
  test(`Lead builds a substitute handover after ${failure}`, async t => {
    const lead: FakeAgent = { id: "prior-lead", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS } };
    const f = makeSpooledRuntime(t, [lead], { handoffTimeoutMs: failure === "timeout" ? 40 : 180_000 });
    lead.labels = { seat: "lead", project: f.slug };
    lead.cwd = f.projectRoot;
    await f.surface.leadEnsure({ projectRoot: f.projectRoot });
    const path = join(projectStateDir(f.stateDir, f.slug), "lead-handoff.md");
    const prior = "# Prior handoff\nPreserve the architecture and next journey.";
    writeFileSync(path, prior);
    if (failure === "send") {
      const ref = f.fake.daemon.agents.ref;
      f.fake.daemon.agents.ref = id => ({ ...ref(id), send: async text => {
        if (id === lead.id) throw new Error("send failed");
        await ref(id).send(text);
      } });
    }
    await f.leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
    if (failure === "refusal") {
      // Even an agent that overwrites the file with a permission error must not destroy continuity.
      writeFileSync(path, "Permission denied: cannot write outside the workspace.");
      await f.leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "The handoff was not written: permission denied." }] });
    }
    if (failure === "timeout") {
      // v0.2.2 (ADR 0050 Decision 3): the elapsed fuse trips only over a Lead
      // still `running` (a genuinely hung stream) — an idle Lead is re-sent.
      lead.status = "running";
    }
    await until(() => assert.equal(readProjectRegistration(f.stateDir, f.slug)?.rotationState, "normal"));
    assert.match(handoffBodyOnDisk(path), /Plugin-built handover/);
    const kickoff = f.fake.sent.find(item => item.agentId !== lead.id)!.text;
    assert.match(kickoff, /Plugin-built handover/i);
    assert.ok(kickoff.includes("Plugin-built handover"));
    assert.ok(kickoff.indexOf("Machine-Verified Active Peer Roster") < kickoff.indexOf("Plugin-built handover"));
    assert.ok(kickoff.indexOf("Ledger State Digest") < kickoff.indexOf("Plugin-built handover"));
  });
}


test("Lead extraction waits the full 180-second fuse before retiring a stuck seat", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const lead: FakeAgent = { id: "slow-lead", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS } };
  const f = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: f.slug };
  lead.cwd = f.projectRoot;
  await f.surface.leadEnsure({ projectRoot: f.projectRoot });
  // v0.6.1 (ADR 0057 §5): the Supervisor that receives the degraded-completion
  // notice is started explicitly — the notice itself never creates one.
  await f.surface.supervisorStart({ projectRoot: f.projectRoot });
  await f.leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  // The hung-stream shape (v0.2.2, ADR 0050 Decision 3): only a Lead still
  // `running` at the elapsed window trips — an alive idle Lead would re-send.
  lead.status = "running";
  t.mock.timers.tick(179_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readProjectRegistration(f.stateDir, f.slug)?.rotationState, "handing_over");
  assert.equal(f.fake.created.length, 1, "only the started Supervisor exists — the fuse creates no successor yet");
  t.mock.timers.tick(1);
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(readProjectRegistration(f.stateDir, f.slug)?.rotationState, "normal");
  // v0.2.2 (ADR 0050 Decision 4): the degraded completion is loud — the fixture's
  // two created seats are the successor Lead and the ensured Supervisor that
  // received the one needs_human notice with the extraction-timeout reason.
  assert.equal(f.fake.created.length, 2);
  assert.ok(f.fake.sent.some(s => s.text.includes("extraction-timeout")), "the Supervisor was paged with the timeout reason");
});


test("Lead builds a substitute after a plugin restart during failed extraction", async t => {
  const lead: FakeAgent = { id: "restarting-lead", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS } };
  const f = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: f.slug };
  lead.cwd = f.projectRoot;
  await f.surface.leadEnsure({ projectRoot: f.projectRoot });
  const path = join(projectStateDir(f.stateDir, f.slug), "lead-handoff.md");
  writeFileSync(path, "# Durable prior handoff\nArchitecture survives restart.");
  await f.leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  f.leadMail.stop();
  writeFileSync(path, "Permission denied: outside workspace.");
  const restarted = createLeadMailRuntime({ factory: f.factory, stateDir: f.stateDir, daemon: f.fake.daemon, ensureLead: input => f.surface.leadEnsure(input), retireLead: input => f.surface.leadRotate(input) });
  t.after(() => restarted.stop());
  // v0.2.2 (ADR 0050 Decision 3): the boot fuse applies the pause-aware rule —
  // an alive Lead is re-sent (see the boot test below), while a Lead that died
  // over the shutdown trips immediately and restores the snapshot prior.
  lead.status = "error";
  await restarted.pumpProjectLead(f.slug);
  assert.match(handoffBodyOnDisk(path), /Plugin-built handover/);
  assert.match(f.fake.sent.find(item => item.agentId !== lead.id)!.text, /Plugin-built handover/);
});

test("rotation_pending holds on an unsettled Task and an errored successor retains held mail until an Owner handoff", async (t) => {
  const lead: FakeAgent = { id: "lead-outage", status: "idle", lastUsage: { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 } };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake } = makeSpooledRuntime(t, [lead]);
  lead.labels = { seat: "lead", project: slug };
  lead.cwd = projectRoot;
  await surface.leadEnsure({ projectRoot });

  const root = readProjectRegistration(stateDir, slug)!.root!;
  factory.setContract({ task: "T-OUTAGE", workspace: root, gate: "true" });
  const worktree = taskWorktreePath(stateDir, slug, "T-OUTAGE");
  factory.requestSpawn({ task: "T-OUTAGE", provider: "zcode/glm-5.1", arity: 1, worktree });
  const peer: FakeAgent = { id: "peer-outage", status: "running", cwd: worktree, labels: { seat: "agent", project: slug, task: "T-OUTAGE" } };
  fake.agents.unshift(peer);

  // 1. Lead reaches 132k while Peer runs -> rotation_pending
  await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending");

  // 2. Peer turn fails mid-outage (e.g. ZCode EPIPE) and drops to status="idle" without claiming:
  //    rotation_pending must NOT prematurely trigger beginHandoff.
  peer.status = "idle";
  await leadMail.onLeadTurnEnded({ agentId: peer.id, outcome: { kind: "failed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending", "rotation_pending stays held while interrupted Peer is idle on unsettled Task");
  assert.equal(fake.sent.filter((s) => s.agentId === lead.id).length, 0);

  // 3. Peer later resumes and completes its turn WITH its outcome (the gate
  //    lands GREEN) -> the Task settles and rotation_pending transitions to
  //    handing_over. (v0.2.2, ADR 0050 §1: a live-but-idle Peer on an open
  //    round holds by itself — only the Task's own outcome releases.)
  factory.ledger.append({ event: "gate_finished", task: "T-OUTAGE", attempt: 1, verdict: "green", exit: 0, note: "" });
  await leadMail.onLeadTurnEnded({ agentId: peer.id, outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
  assert.equal(fake.sent.filter((s) => s.agentId === lead.id).length, 1);

  // 4. Outgoing Lead completes extraction -> successor Lead 1 receives Turn-1 kickoff.
  await leadMail.onLeadTurnEnded({
    agentId: lead.id,
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "# Handoff after outage\nWait for T-OUTAGE verdict." }],
  });
  const successor1Id = readProjectRegistration(stateDir, slug)?.lead!;
  assert.ok(successor1Id && successor1Id !== lead.id);
  const successor1 = fake.agents.find((a) => a.id === successor1Id)!;
  assert.equal(fake.sent.filter((s) => s.agentId === successor1Id).length, 1);

  // 5. Successor Lead 1's Turn-1 kickoff fails into status="error" (e.g. workspace routing discovery timed out):
  //    With no queued mail batch to retry, it preserves pendingHandoff and rests quietly without looping into the outage.
  successor1.status = "error";
  await leadMail.onLeadTurnEnded({ agentId: successor1Id, outcome: { kind: "failed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.lead, successor1Id, "does not immediately replace and re-pump into an active outage");
  assert.equal(fake.sent.filter((s) => s.agentId === successor1Id).length, 1);

  // New mail holds for the errored successor until the Owner explicitly hands it off.
  await leadMail.notifyPeer({ task: "T-OUTAGE", kind: "verdict", text: "T-OUTAGE attempt 1 ended GREEN" });
  assert.equal(readProjectRegistration(stateDir, slug)?.lead, successor1Id);
  const held = readLeadMailbox(join(projectStateDir(stateDir, slug), "mailbox.jsonl"));
  assert.equal(held.queued.length, 1);
  const replaced = await leadMail.handoff({ slug, seat: "lead", action: "replaceNow" });
  assert.ok(replaced.ok);
  const successor2Id = readProjectRegistration(stateDir, slug)?.lead!;
  assert.notEqual(successor2Id, successor1Id);
  const successor2Sends = fake.sent.filter((s) => s.agentId === successor2Id);
  assert.equal(successor2Sends.length, 1);
  assert.match(successor2Sends[0]!.text, /\[paseo-factory seat kickoff packet · role=lead/);
  assert.match(successor2Sends[0]!.text, /Plugin-built handover/);
  assert.match(successor2Sends[0]!.text, /T-OUTAGE attempt 1 ended GREEN/);
});

test("Owner Replace now creates a plugin-built handover and delivers held mail to the successor", async (t) => {
  const f = makeSpooledRuntime(t);
  f.fake.agents.push({ id: "lead-owner", provider: "pi/zai/glm-5.3", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-owner" });
  await f.leadMail.enqueueLeadMail(f.slug, { from: "supervisor", kind: "directive", text: "Keep the Owner's requested outcome" });
  const reply = await f.leadMail.handoff({ slug: f.slug, action: "replaceNow" });
  assert.equal(reply.ok, true);
  assert.ok(reply.ok);
  assert.equal(reply.progress?.reason, "owner");
  assert.equal(reply.progress?.state, "done");
  assert.equal(reply.progress?.handover, "substitute");
  const successor = f.fake.sent.find(send => send.agentId !== "lead-owner");
  assert.ok(successor);
  for (const section of ["Plugin-built handover", "Ledger digest", "Project notebook", "Git state", "Open Tasks", "Recent timeline", "Keep the Owner's requested outcome"]) assert.ok(successor.text.includes(section), section);
  assert.equal(f.fake.agents.some(agent => agent.id === "lead-owner"), false);
});

test("Owner Lead handoff starts extraction through the surface RPC door", async (t) => {
  const f = makeSpooledRuntime(t);
  f.fake.agents.push({ id: "lead-start", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-start" });
  const reply = await f.surface.handoff({ projectRoot: f.projectRoot, seat: "lead" }, "start");
  assert.equal(reply.ok, true);
  if (reply.ok) assert.equal(reply.progress?.state, "handing-over");
  assert.match(f.fake.sent[0]!.text, /handoff/i);
});

test("Owner no-reply window falls back once to a substitute even while the outgoing Lead is running", async (t) => {
  const f = makeSpooledRuntime(t, [], { handoffTimeoutMs: 1000, ownerHandoffTimeoutMs: 25 });
  f.fake.agents.push({ id: "lead-timeout", status: "running", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-timeout" });
  await f.leadMail.handoff({ slug: f.slug, action: "start" });
  await until(() => assert.equal(readHandoffProgress(f.stateDir, f.slug, "lead")?.state, "done"));
  assert.equal(readHandoffProgress(f.stateDir, f.slug, "lead")?.handover, "substitute");
  assert.equal(f.fake.sent.filter(send => send.agentId === "lead-timeout").length, 1);
});

test("A provider-change Lead handoff waits for running Peers, reports them, and cancel restores the exact previous lane", async (t) => {
  const f = makeSpooledRuntime(t);
  f.factory.setContract({ task: "T-handoff-owner", workspace: f.projectRoot, gate: "true" });
  f.factory.requestSpawn({ task: "T-handoff-owner", provider: "pi/model", arity: 1, worktree: taskWorktreePath(f.stateDir, f.slug, "T-handoff-owner") });
  f.fake.agents.push({ id: "lead-lane", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot }, { id: "peer-lane", status: "running", labels: { task: "T-handoff-owner", project: f.slug }, cwd: taskWorktreePath(f.stateDir, f.slug, "T-handoff-owner") });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-lane" });
  saveLanes(f.stateDir, { lead: "claude/claude-sonnet-4-6" }, f.slug);
  const scheduled = await f.leadMail.handoff({ slug: f.slug, action: "start", reason: "provider-change", fromLane: "pi/zcode/glm-5.3:high", toLane: "claude/claude-sonnet-4-6" });
  assert.ok(scheduled.ok);
  assert.equal(scheduled.progress?.state, "scheduled");
  assert.equal(scheduled.progress?.waitingPeers, 1);
  assert.equal(f.fake.sent.length, 0);
  const canceled = await f.leadMail.handoff({ slug: f.slug, action: "cancel" });
  assert.deepEqual(canceled, { ok: true, progress: null });
  const lanes = loadLanes(f.stateDir, f.slug); assert.ok(lanes.ok);
  assert.equal(lanes.lanes.lead, "pi/zcode/glm-5.3:high");
});

test("Cancel backs out of a failed Lead handoff: provider-change lane restored, rotation normal, a new handoff starts at once", async (t) => {
  const f = makeSpooledRuntime(t);
  f.fake.agents.push({ id: "lead-cancel", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-cancel" });
  saveLanes(f.stateDir, { lead: "claude/claude-sonnet-4-6" }, f.slug);
  const create = f.fake.daemon.agents.create;
  f.fake.daemon.agents.create = async () => { throw new Error("Provider 'antigravity' is not available"); };
  const failed = await f.leadMail.handoff({ slug: f.slug, action: "replaceNow", reason: "provider-change", fromLane: "pi/zcode/glm-5.3:high", toLane: "claude/claude-sonnet-4-6" });
  assert.ok(failed.ok); assert.equal(failed.progress?.state, "failed");
  assert.notEqual(readProjectRegistration(f.stateDir, f.slug)?.rotationState ?? "normal", "normal");
  const canceled = await f.leadMail.handoff({ slug: f.slug, action: "cancel" });
  assert.deepEqual(canceled, { ok: true, progress: null });
  assert.equal(readHandoffProgress(f.stateDir, f.slug, "lead"), null);
  const reg = readProjectRegistration(f.stateDir, f.slug);
  assert.ok(reg?.rotationState === undefined || reg.rotationState === "normal");
  assert.equal(reg?.handoffRequestedAt, undefined);
  const lanes = loadLanes(f.stateDir, f.slug); assert.ok(lanes.ok);
  assert.equal(lanes.lanes.lead, "pi/zcode/glm-5.3:high");
  f.fake.daemon.agents.create = create;
  const again = await f.leadMail.handoff({ slug: f.slug, action: "start", reason: "provider-change", fromLane: "pi/zcode/glm-5.3:high", toLane: "claude/claude-sonnet-4-6" });
  assert.ok(again.ok, "a new model choice is accepted after cancel");
});

test("Cancel is still refused for a Lead handoff that is neither scheduled nor failed", async (t) => {
  const f = makeSpooledRuntime(t);
  const refused = await f.leadMail.handoff({ slug: f.slug, action: "cancel" });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, "handoff-not-scheduled");
});

test("A failed successor creation retries the stored handover without another extraction", async (t) => {
  const f = makeSpooledRuntime(t);
  f.fake.agents.push({ id: "lead-retry", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-retry" });
  f.factory.setContract({ task: "T-retry-peer", workspace: f.projectRoot, gate: "true" });
  const peerCwd = taskWorktreePath(f.stateDir, f.slug, "T-retry-peer");
  f.factory.requestSpawn({ task: "T-retry-peer", provider: "pi/model", arity: 1, worktree: peerCwd });
  f.fake.agents.push({ id: "retry-peer", status: "running", cwd: peerCwd, labels: { task: "T-retry-peer", project: f.slug } });
  const create = f.fake.daemon.agents.create;
  f.fake.daemon.agents.create = async () => { throw new Error("provider unavailable"); };
  const failed = await f.leadMail.handoff({ slug: f.slug, action: "replaceNow" });
  assert.ok(failed.ok); assert.equal(failed.progress?.state, "failed");
  const handover = await f.leadMail.handoff({ slug: f.slug, action: "handover" });
  assert.ok(handover.ok); assert.match(handover.text!, /Plugin-built handover/);
  f.fake.daemon.agents.create = create;
  const retried = await f.leadMail.handoff({ slug: f.slug, action: "retry" });
  assert.ok(retried.ok); assert.equal(retried.progress?.state, "done");
  const text = f.fake.sent.find(send => send.agentId !== "lead-retry")?.text ?? "";
  assert.ok(text.includes(handover.text!));
  assert.match(text, /agent retry-peer \(live: running\)/);
  assert.equal(f.fake.sent.filter(send => send.agentId === "lead-retry").length, 0);
});

test("Hand off now skips a scheduled Lead quiet point and holds a running Peer's report for the extracted successor", async (t) => {
  const f = makeSpooledRuntime(t);
  f.factory.setContract({ task: "T-skip", workspace: f.projectRoot, gate: "true" });
  const cwd = taskWorktreePath(f.stateDir, f.slug, "T-skip");
  f.factory.requestSpawn({ task: "T-skip", provider: "pi/model", arity: 1, worktree: cwd });
  f.fake.agents.push({ id: "lead-skip", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot }, { id: "peer-skip", status: "running", labels: { task: "T-skip", project: f.slug }, cwd });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-skip" });
  await f.leadMail.handoff({ slug: f.slug, action: "start", reason: "provider-change", fromLane: "pi/zcode/glm-5.3", toLane: "pi/zcode/glm-5.4" });
  const started = await f.leadMail.handoff({ slug: f.slug, action: "start" });
  assert.ok(started.ok); assert.equal(started.progress?.state, "handing-over");
  await f.leadMail.notifyPeer({ task: "T-skip", kind: "verdict", text: "Peer report during extraction" });
  assert.equal(f.fake.sent.filter(send => send.text.includes("Peer report during extraction")).length, 0);
  await f.leadMail.onLeadTurnEnded({ agentId: "lead-skip", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "# Lead continuity\nKeep the running Peer." }] });
  const progress = await f.leadMail.handoff({ slug: f.slug, action: "handover" });
  assert.ok(progress.ok); assert.equal(progress.progress?.state, "done"); assert.equal(progress.source, "extracted");
  assert.ok(f.fake.sent.some(send => send.agentId !== "lead-skip" && send.text.includes("Peer report during extraction") && send.text.includes("Keep the running Peer")));
  assert.equal(f.fake.agents.find(agent => agent.id === "peer-skip")?.status, "running");
});

test("Replace now interrupts an active extraction and keeps its reason while producing a substitute", async t => {
  const f = makeSpooledRuntime(t);
  f.fake.agents.push({ id: "lead-interrupt", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-interrupt" });
  await f.leadMail.handoff({ slug: f.slug, action: "start" });
  const replaced = await f.leadMail.handoff({ slug: f.slug, action: "replaceNow" });
  assert.ok(replaced.ok);
  assert.equal(replaced.progress?.state, "done");
  assert.equal(replaced.progress?.reason, "owner");
  assert.equal(replaced.progress?.handover, "substitute");
});

for (const reason of ["context-mark", "provider-change", "owner"] as const) {
  test(`${reason} exposes creating-successor, failed and done while retry preserves extracted continuity`, async t => {
    const f = makeSpooledRuntime(t);
    f.fake.agents.push({ id: `lead-${reason}`, labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot, lastUsage: { contextWindowUsedTokens: reason === "context-mark" ? LEAD_ROTATE_TOKENS + 5_000 : 1000 } });
    writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: `lead-${reason}` });
    if (reason === "context-mark") await f.leadMail.onLeadTurnEnded({ agentId: `lead-${reason}`, outcome: { kind: "completed" }, timeline: [] });
    else if (reason === "provider-change") await f.surface.lanesSet({ lane: "lead", value: "claude/claude-sonnet-4-6", projectRoot: f.projectRoot });
    else await f.surface.handoff({ projectRoot: f.projectRoot, seat: "lead" }, "start");
    const extracting = await f.leadMail.handoff({ slug: f.slug, action: "handover" });
    assert.ok(extracting.ok); assert.equal(extracting.progress?.state, "handing-over"); assert.equal(extracting.progress?.reason, reason);
    const create = f.fake.daemon.agents.create;
    const observed: string[] = [];
    f.fake.daemon.agents.create = async () => {
      const handover = await f.leadMail.handoff({ slug: f.slug, action: "handover" });
      assert.ok(handover.ok); observed.push(handover.progress!.state);
      throw new Error("successor unavailable");
    };
    await f.leadMail.onLeadTurnEnded({ agentId: `lead-${reason}`, outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "# Extracted continuity\nThe bounded next wave remains open." }] });
    assert.deepEqual(observed, ["creating-successor"]);
    const failed = await f.leadMail.handoff({ slug: f.slug, action: "handover" });
    assert.ok(failed.ok); assert.equal(failed.progress?.state, "failed"); assert.equal(failed.progress?.reason, reason); assert.equal(failed.source, "extracted");
    f.fake.daemon.agents.create = create;
    const retry = await f.leadMail.handoff({ slug: f.slug, action: "retry" });
    assert.ok(retry.ok); assert.equal(retry.progress?.state, "done"); assert.equal(retry.progress?.reason, reason);
    assert.ok(f.fake.sent.some(send => send.agentId !== `lead-${reason}` && send.text.includes("The bounded next wave remains open.")));
  });
}

test("A second provider change cannot overwrite the lane of a scheduled handoff", async t => {
  const f = makeSpooledRuntime(t);
  f.factory.setContract({ task: "T-lane-held", workspace: f.projectRoot, gate: "true" });
  const cwd = taskWorktreePath(f.stateDir, f.slug, "T-lane-held");
  f.factory.requestSpawn({ task: "T-lane-held", provider: "pi/model", arity: 1, worktree: cwd });
  f.fake.agents.push({ id: "lead-lane-held", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot }, { id: "peer-lane-held", status: "running", labels: { task: "T-lane-held", project: f.slug }, cwd });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-lane-held" });
  await f.surface.lanesSet({ lane: "lead", value: "claude/claude-sonnet-4-6", projectRoot: f.projectRoot });
  const second = await f.surface.lanesSet({ lane: "lead", value: "codex/gpt-5.4", projectRoot: f.projectRoot });
  assert.ok(second.ok); assert.match(second.modelSync, /handoff refused/);
  assert.equal(second.lanes.lead, "claude/claude-sonnet-4-6");
});

test("Lead handoff crosses the smaller model mark while running and at a turn boundary", async (t) => {
  for (const status of ["running", "idle"]) {
    const lead: FakeAgent = { id: `small-lead-${status}`, status, lastUsage: { contextWindowUsedTokens: 83_199, contextWindowMaxTokens: 128_000 } };
    const { leadMail, surface, slug, projectRoot, fake, stateDir } = makeSpooledRuntime(t, [lead]);
    lead.labels = { seat: "lead", project: slug };
    lead.cwd = projectRoot;
    assert.ok((await surface.leadEnsure({ projectRoot })).ok);
    if (status === "running") await leadMail.pumpProjectLead(slug);
    else await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
    assert.equal(readProjectRegistration(stateDir, slug)?.rotationState ?? "normal", "normal");
    lead.lastUsage!.contextWindowUsedTokens = 83_200;
    if (status === "running") {
      await leadMail.pumpProjectLead(slug);
      assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending");
    } else {
      await leadMail.onLeadTurnEnded({ agentId: lead.id, outcome: { kind: "completed" }, timeline: [] });
      assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "handing_over");
      assert.match(fake.sent.at(-1)!.text, /handoff/i);
    }
  }
});

test("View handover remains readable through the surface after done progress expires", async t => {
  const f = makeSpooledRuntime(t);
  f.fake.agents.push({ id: "lead-handover-read", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-handover-read" });
  const replaced = await f.surface.handoff({ projectRoot: f.projectRoot, seat: "lead" }, "replaceNow");
  assert.ok(replaced.ok); assert.equal(replaced.progress?.state, "done");
  const path = join(projectStateDir(f.stateDir, f.slug), "handoff-lead.json");
  const completed = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...completed, updatedAt: "2000-01-01T00:00:00.000Z" }));
  const snapshot = await f.surface.snapshot({ projectRoot: f.projectRoot });
  assert.ok(snapshot.ok);
  assert.equal(snapshot.view.panel.seats!.lead.handoff, null);
  assert.ok(snapshot.view.panel.seats!.lead.allowedActions.includes("view-handover"));
  const handover = await f.surface.handoff({ projectRoot: f.projectRoot, seat: "lead" }, "handover");
  assert.ok(handover.ok); assert.equal(handover.progress, null); assert.equal(handover.source, "substitute");
  assert.match(handover.text!, /Plugin-built handover/);
});


test("Replace now retries a failed Lead successor through the mobile handoff RPC with the stored extraction", async t => {
  const f = makeSpooledRuntime(t);
  f.fake.agents.push({ id: "lead-mobile-recovery", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-mobile-recovery" });
  await f.surface.handoff({ projectRoot: f.projectRoot, seat: "lead" }, "start");
  const create = f.fake.daemon.agents.create;
  f.fake.daemon.agents.create = async () => { throw new Error("provider unavailable"); };
  await f.leadMail.onLeadTurnEnded({ agentId: "lead-mobile-recovery", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "# Lead continuity\nRetain the extracted release decision." }] });
  const failed = await f.surface.handoff({ projectRoot: f.projectRoot, seat: "lead" }, "handover");
  assert.ok(failed.ok); assert.equal(failed.progress?.state, "failed"); assert.equal(failed.source, "extracted");
  await f.leadMail.enqueueLeadMail(f.slug, { from: "supervisor", kind: "directive", text: "Held during failed succession" });
  f.fake.daemon.agents.create = create;
  const { registerSurfaceRpc } = await import("../plugin/server/surface-rpc.ts");
  const routes = new Map<string, (input: any, context: any) => Promise<any>>();
  registerSurfaceRpc({ handle: (rpc: { name: string }, handler: any) => routes.set(rpc.name, handler) } as never, f.surface);
  const replaced = await routes.get("factory.handoff.replace.now")!({ projectRoot: f.projectRoot, seat: "lead" }, {});
  assert.ok(replaced.ok); assert.equal(replaced.progress?.state, "done"); assert.equal(replaced.progress?.handover, "extracted");
  const successor = f.fake.sent.find(send => send.agentId !== "lead-mobile-recovery");
  assert.ok(successor?.text.includes(failed.text!));
  assert.match(successor!.text, /Held during failed succession/);
  assert.equal(f.fake.sent.filter(send => send.agentId === "lead-mobile-recovery").length, 1, "recovery never requests a second extraction");
});


for (const prior of ["stale", "missing"]) {
  test(`lost Lead with ${prior} handover carries its available archived timeline into the successor kickoff`, async t => {
    const f = makeSpooledRuntime(t);
    f.fake.agents.push({ id: "lead-archived-tail", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot });
    writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-archived-tail" });
    if (prior === "stale") writeFileSync(join(projectStateDir(f.stateDir, f.slug), "lead-handoff.md"), "# Old handover\nOutdated wave.");
    const ref = f.fake.daemon.agents.ref;
    f.fake.daemon.agents.ref = id => ({ ...ref(id), timeline: { refetch: async () => ({ entries: [{ item: { type: "assistant_message", text: "Latest decision: preserve the active deployment window." } }] }) } });
    await f.leadMail.enqueueLeadMail(f.slug, { from: "supervisor", kind: "directive", text: "Continue the unfinished work" });
    await f.leadMail.pumpProjectLead(f.slug);
    await f.fake.emitArchive("lead-archived-tail");
    const successor = f.fake.sent.find(send => send.agentId !== "lead-archived-tail");
    assert.match(successor?.text ?? "", /Plugin-built handover/);
    assert.match(successor?.text ?? "", /Recent timeline[\s\S]*Latest decision: preserve the active deployment window/);
  });
}


test("lost Lead still recovers when its optional archived timeline never answers", async t => {
  const f = makeSpooledRuntime(t);
  f.fake.agents.push({ id: "lead-hung-tail", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-hung-tail" });
  await f.leadMail.enqueueLeadMail(f.slug, { from: "supervisor", kind: "directive", text: "Recover despite missing evidence" });
  await f.leadMail.pumpProjectLead(f.slug);
  const ref = f.fake.daemon.agents.ref;
  f.fake.daemon.agents.ref = id => ({ ...ref(id), timeline: { refetch: () => new Promise(() => {}) } });
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      f.fake.emitArchive("lead-hung-tail"),
      new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error("optional timeline stalled recovery")), 2500); }),
    ]);
  } finally { clearTimeout(guard); }
  assert.match(f.fake.sent.find(send => send.agentId !== "lead-hung-tail")?.text ?? "", /Plugin-built handover[\s\S]*Recover despite missing evidence/);
});

test("Substitute Open Tasks evidence lists live work and omits accepted and closed Tasks", async t => {
  const f = makeSpooledRuntime(t);
  for (const task of ["T-open", "T-accepted", "T-closed"]) f.factory.setContract({ task, workspace: f.projectRoot, gate: "true" });
  writeFileSync(join(f.projectRoot, "work.txt"), "Completed work");
  await f.factory.claim({ task: "T-accepted", sha: gitCommitAll(f.projectRoot), handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } });
  await f.factory.accept({ task: "T-accepted", attempt: 1 });
  await f.factory.close({ task: "T-closed", reason: "Superseded" });
  f.fake.agents.push({ id: "lead-open-tasks", labels: { seat: "lead", project: f.slug }, cwd: f.projectRoot });
  writeProjectRegistration(f.stateDir, f.slug, { root: f.projectRoot, lead: "lead-open-tasks" });
  await f.surface.handoff({ projectRoot: f.projectRoot, seat: "lead" }, "replaceNow");
  const handover = await f.surface.handoff({ projectRoot: f.projectRoot, seat: "lead" }, "handover");
  assert.ok(handover.ok);
  const section = handover.text!.split("## Open Tasks\n")[1]!.split("\n\n## Recent timeline")[0]!;
  assert.equal(section, "T-open: waiting; Attempts: 0");
});
