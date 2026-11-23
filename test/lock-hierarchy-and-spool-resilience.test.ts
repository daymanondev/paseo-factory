import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { withProjectIngressLock } from "../plugin/server/core/project-ingress-lock.ts";
import { ensureProjectRegistered, projectStateDir, readProjectRegistration, writeProjectRegistration } from "../plugin/server/core/project.ts";
import { readLeadMailbox } from "../plugin/server/core/mailbox.ts";
import { createGateQueue } from "../plugin/server/gate-queue.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { createFactoryRegistry, resolveProject } from "../plugin/server/projects.ts";
import { createGateQueueSettler, DEFAULT_SPOOL_REPLAY_TTL_MS, handleSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { createSurfaceHandlers, type SurfaceAgentSnapshot, type SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const POLL_MS = 15;

const HANDOFF = {
  outcome: "complete" as const,
  scope: "src/index.ts",
  verification: "slice tests pass",
  unknowns: "none",
};

interface Latch {
  entered: Promise<void>;
  release: () => void;
  isEntered: () => boolean;
}

function makeLatch(): Latch {
  let enterResolve!: () => void;
  let releaseResolve!: () => void;
  let didEnter = false;
  const entered = new Promise<void>((resolve) => {
    enterResolve = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  return {
    entered,
    release: () => releaseResolve(),
    isEntered: () => didEnter,
    ...({
      wait: () => {
        didEnter = true;
        enterResolve();
        return gate;
      },
    }),
  } as Latch & { wait: () => Promise<void> };
}

function dropRequest(spoolRoot: string, body: Record<string, unknown> & { id: string }): string {
  const requestsDir = join(spoolRoot, "requests");
  mkdirSync(requestsDir, { recursive: true });
  const path = join(requestsDir, `${body.id}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  renameSync(tmp, path);
  return path;
}

function readReply(spoolRoot: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(spoolRoot, "replies", `${id}.json`), "utf8")) as Record<string, unknown>;
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

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function makeControllableDaemon(initialAgents: Array<{
  id: string;
  provider?: string;
  status?: string;
  labels?: Record<string, string>;
  cwd?: string;
  workspaceId?: string | null;
  lastUserMessageAt?: string | null;
}> = []) {
  const buildAgent = (a: (typeof initialAgents)[number]): SurfaceAgentSnapshot => ({
    id: a.id,
    provider: a.provider ?? "factory-supervisor",
    title: a.id,
    status: a.status ?? "idle",
    model: null,
    labels: a.labels ?? {},
    archivedAt: null,
    requiresAttention: false,
    attentionReason: null,
    updatedAt: "2026-11-23T00:00:00.000Z",
    cwd: a.cwd ?? "/tmp",
    ...(a.workspaceId !== undefined ? { workspaceId: a.workspaceId } : {}),
    ...(a.lastUserMessageAt !== undefined ? { lastUserMessageAt: a.lastUserMessageAt } : {}),
  });

  const agents = initialAgents.map(buildAgent);
  const sent: Array<{ agentId: string; text: string }> = [];
  const archived: string[] = [];
  const listHooks: Array<() => Promise<void>> = [];
  const sendHooks = new Map<string, () => Promise<void>>();
  const archiveHooks = new Map<string, () => Promise<void>>();

  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async (opts) => {
        const hook = listHooks.shift();
        if (hook !== undefined) await hook();
        const filter = opts?.filter;
        const kept = agents
          .filter((a) => filter?.includeArchived || a.archivedAt === null)
          .filter((a) => {
            if (!filter?.labels) return true;
            return Object.entries(filter.labels).every(([k, v]) => a.labels[k] === v);
          });
        return { entries: kept.map((agent) => ({ agent })) };
      },
      create: async (opts) => {
        const id = `agent-created-${agents.length + 1}`;
        agents.push(buildAgent({ id, provider: opts.config.provider, labels: opts.labels ?? {}, cwd: opts.cwd }));
        return { id };
      },
      ref: (id) => ({
        send: async (text) => {
          const hook = sendHooks.get(id);
          if (hook !== undefined) {
            sendHooks.delete(id);
            await hook();
          }
          sent.push({ agentId: id, text });
        },
        archive: async () => {
          const hook = archiveHooks.get(id);
          if (hook !== undefined) {
            archiveHooks.delete(id);
            await hook();
          }
          archived.push(id);
          const found = agents.find((a) => a.id === id);
          if (found) found.archivedAt = new Date().toISOString();
          return { archivedAt: new Date().toISOString() };
        },
        update: async (patch) => {
          const found = agents.find((a) => a.id === id);
          if (found && patch.labels) found.labels = { ...found.labels, ...patch.labels };
          return {};
        },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "pi", available: true }] }),
      listModels: async () => ({ models: [] }),
    },
  };

  return { daemon, agents, sent, archived, listHooks, sendHooks, archiveHooks, buildAgent };
}

function setupRuntime(t: TestContext, options: {
  withGateQueue?: boolean;
  agents?: Parameters<typeof makeControllableDaemon>[0];
  usageMeter?: (input: { task: string; agentId?: string; attempt?: number; slug?: string }) => Promise<void>;
} = {}) {
  const dir = makeTempDir("lock-hardening-");
  disposeDir(t, dir);
  const home = join(dir, "home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const projectRootRaw = join(dir, "repo");
  mkdirSync(projectRootRaw, { recursive: true });
  writeFileSync(join(projectRootRaw, "README.md"), "# repo\n");
  const sha = gitCommitAll(projectRootRaw, "init");

  const resolved = ensureProjectRegistered(stateDir, projectRootRaw);
  assert.ok(resolved.ok);
  const { slug, root } = resolved;

  const registry = createFactoryRegistry({ stateDir });
  const fake = makeControllableDaemon([
    { id: "lead-1", provider: "factory-lead", status: "idle", labels: { seat: "lead", project: slug }, cwd: root },
    ...(options.agents ?? []),
  ]);
  writeProjectRegistration(stateDir, slug, { root, lead: "lead-1" });

  let leadMail!: ReturnType<typeof createLeadMailRuntime>;
  let gateQueue: ReturnType<typeof createGateQueue> | undefined;
  const logs: string[] = [];

  const surface = createSurfaceHandlers({
    factory: registry.root,
    registry,
    stateDir,
    home,
    daemon: fake.daemon,
    stopAgent: async () => ({ ok: true }),
    cleanupDaemonWorkspaces: async () => ({ ok: true, removedWorkspaceIds: [], removedProjectIds: [] }),
    onLeadRetired: (input) => leadMail.settleLeadRotation(input.slug),
    onSeatKickoffSent: (input) => leadMail.markKickoffSent(input.agentId),
    markPluginArchive: (input) => leadMail.markPluginArchive(input.agentId),
    clearPluginArchive: (input) => leadMail.clearPluginArchive(input.agentId),
    resetProjectMailbox: (s) => leadMail.resetProjectMailbox(s),
    rotateProjectMailbox: (s) => leadMail.rotateProjectMailbox(s),
    pumpSupervisorMailbox: (s) => leadMail.pumpProjectSupervisor(s),
    leadDispatch: (req) => leadMail.dispatchLead(req),
    ...(options.withGateQueue ? { gateQueue: () => gateQueue } : {}),
  });

  leadMail = createLeadMailRuntime({
    factory: registry.root,
    registry,
    stateDir,
    home,
    daemon: fake.daemon,
    ensureLead: (i) => surface.leadEnsure(i),
    retireLead: (i) => surface.leadRotate(i),
    settleReleasedSupervisor: (i) => surface.settleReleasedSupervisor(i),
    onLog: (m) => logs.push(m),
  });

  if (options.withGateQueue) {
    gateQueue = createGateQueue({
      stateDir,
      factory: registry.root,
      registry,
      log: (m) => logs.push(m),
      onSettled: createGateQueueSettler({
        rootFactory: registry.root,
        registry,
        ...(options.usageMeter ? { usageMeter: options.usageMeter } : {}),
        peerMail: leadMail.notifyPeer,
        daemon: fake.daemon,
        onLog: (m) => logs.push(m),
      }),
    });
  }

  const spool = startSpool(stateDir, registry.root, {
    pollMs: POLL_MS,
    registry,
    daemon: fake.daemon,
    leadDispatch: (req) => leadMail.dispatchLead(req),
    supervisorDispatch: (req) => leadMail.dispatchSupervisor(req),
    supervisorReport: (req) => leadMail.reportSupervisor(req),
    projectReset: async (req) => {
      const reply = await surface.projectReset(
        {
          ...(req.workspace !== undefined ? { projectRoot: req.workspace } : {}),
          ...(req.project !== undefined ? { project: req.project } : {}),
          ...(req.keepSeats !== undefined ? { keepSeats: req.keepSeats } : {}),
        },
        { paseo: fake.daemon },
      );
      return reply.ok
        ? { id: req.id, ok: true, summary: reply.summary, project: reply.project, purgedEvents: reply.purgedEvents, tasks: reply.tasks, removedFiles: reply.removedFiles, archivedSeats: reply.archivedSeats, archivedAgents: reply.archivedAgents }
        : { id: req.id, ok: false, code: reply.code, message: reply.error };
    },
    projectRotate: async (req) => {
      const reply = await surface.projectRotate(
        {
          ...(req.workspace !== undefined ? { projectRoot: req.workspace } : {}),
          ...(req.project !== undefined ? { project: req.project } : {}),
        },
        { paseo: fake.daemon, ...(req.seat !== undefined ? { seat: req.seat } : {}) },
      );
      return reply.ok
        ? { id: req.id, ok: true, summary: reply.summary, project: reply.project, projectRoot: reply.projectRoot, archivedSeats: reply.archivedSeats }
        : { id: req.id, ok: false, code: reply.code, message: reply.error };
    },
    projectDelete: async (req) => {
      const reply = await surface.projectDelete(
        {
          ...(req.projectRoot !== undefined ? { projectRoot: req.projectRoot } : req.workspace !== undefined ? { projectRoot: req.workspace } : {}),
          ...(req.projectSlug !== undefined ? { projectSlug: req.projectSlug } : {}),
          ...(req.project !== undefined ? { project: req.project } : {}),
          ...(req.seat !== undefined ? { seat: req.seat } : {}),
        },
        { paseo: fake.daemon },
      );
      return reply.ok
        ? { id: req.id, ok: true, summary: reply.summary, project: reply.project, projectRoot: reply.projectRoot, purgedEvents: reply.purgedEvents, tasks: reply.tasks, removedFiles: reply.removedFiles, archivedSeats: reply.archivedSeats, archivedAgents: reply.archivedAgents }
        : { id: req.id, ok: false, code: reply.code, message: reply.error };
    },
    projectRegister: async (req) => {
      const reply = await surface.projectRegister(
        { workspace: req.workspace },
        { paseo: fake.daemon, ...(req.seat !== undefined ? { seat: req.seat } : {}) },
      );
      return reply.ok
        ? { id: req.id, ok: true, summary: reply.summary, project: reply.slug, projectRoot: reply.root, bootstrapped: reply.bootstrapped, alreadyRegistered: reply.alreadyRegistered }
        : { id: req.id, ok: false, code: reply.code, message: reply.error };
    },
    peerMail: leadMail.notifyPeer,
    ...(options.usageMeter ? { usageMeter: options.usageMeter } : {}),
    ...(gateQueue ? { gateQueue } : {}),
    onLog: (m) => logs.push(m),
  });

  t.after(() => {
    spool.stop();
    gateQueue?.stop();
    leadMail.stop();
    registry.stop();
  });

  return { dir, home, stateDir, root, slug, sha, registry, fake, surface, leadMail, gateQueue, spool, logs, projectFactory: registry.factoryForProject(slug) };
}

test("Deadlock #1: read-only scout claim with empty gate never deadlocks against concurrent leadMail pump/sweep and releases ingress lock before settleClaimOutcome", async (t) => {
  const meterLatch = makeLatch() as Latch & { wait: () => Promise<void> };
  const h = setupRuntime(t, {
    withGateQueue: true,
    usageMeter: async (input) => {
      if (input.task === "SCOUT-1") await meterLatch.wait();
    },
  });

  h.projectFactory.setContract({
    task: "SCOUT-1",
    workspace: h.root,
    gate: "",
    disposition: "scout",
    scope: ["zone-scout"],
  });
  h.projectFactory.setContract({
    task: "ENG-1",
    workspace: h.root,
    gate: "true",
    artifact: "README.md",
    scope: ["zone-eng"],
  });

  // Start scout claim + concurrent sweepPeers/pumpProjectLead/onLeadTurnEnded on the same Project.
  const spoolRoot = spoolRootFor(h.stateDir);
  dropRequest(spoolRoot, {
    id: "scout-claim-1",
    kind: "claim",
    task: "SCOUT-1",
    handoff: HANDOFF,
    agent: "peer-scout",
    projectSlug: h.slug,
  });

  // Wait until scout claim is inside settleClaimOutcome (usageMeter latch), AFTER releasing ingress lock.
  await withTimeout(meterLatch.entered, "scout claim enters settleClaimOutcome");

  // While scout claim is paused in settleClaimOutcome, a subsequent writable engineer claim
  // AND concurrent leadMail pump/sweep/turn-end all acquire withProjectIngressLock cleanly!
  const engPromise = withTimeout(
    handleSpoolRequest(
      h.registry.root,
      {
        id: "eng-claim-1",
        kind: "claim",
        task: "ENG-1",
        sha: h.sha,
        handoff: HANDOFF,
        agent: "peer-eng",
        projectSlug: h.slug,
      },
      { gateQueue: h.gateQueue, peerMail: h.leadMail.notifyPeer, daemon: h.fake.daemon },
      h.registry,
    ),
    "engineer claim enqueues while scout settles",
  );
  const pumpPromise = withTimeout(h.leadMail.pumpProjectLead(h.slug), "concurrent pumpProjectLead");
  const sweepPromise = withTimeout(h.leadMail.sweepPeers(), "concurrent sweepPeers");
  const turnEndPromise = withTimeout(
    h.leadMail.onLeadTurnEnded({ agentId: "lead-1", outcome: { kind: "completed" }, timeline: [] }),
    "concurrent onLeadTurnEnded",
  );

  const [engReply] = await Promise.all([engPromise, pumpPromise, sweepPromise, turnEndPromise]);
  assert.equal(engReply.ok, true, engReply.ok ? "" : engReply.message);
  if (engReply.ok) assert.equal(engReply.status, "queued", "engineer claim enqueued cleanly into GateQueue");

  // Release scout settlement and confirm scout reply + Lead mail delivery finish without deadlock.
  meterLatch.release();
  await until(() => {
    const scoutReply = readReply(spoolRoot, "scout-claim-1");
    assert.equal(scoutReply.ok, true);
    assert.equal(scoutReply.verdict, "green");
    const mbox = readLeadMailbox(join(projectStateDir(h.stateDir, h.slug), "mailbox.jsonl"));
    assert.ok(mbox.inFlight !== null || mbox.ackedCount > 0 || mbox.queued.length > 0);
  });
  await until(() => {
    assert.ok(h.projectFactory.ledger.eventsFor("ENG-1").some((e) => e.event === "report_written"));
  });
});

test("Deadlock #2: legacy non-gateQueue claim releases Project ingress lock before awaiting Gate completion and settleClaimOutcome", async (t) => {
  const h = setupRuntime(t, { withGateQueue: false });
  const gateScript = join(h.dir, "legacy-gate.mjs");
  const startedFile = join(h.dir, "started-legacy-gate.txt");
  const releaseFile = join(h.dir, "release-legacy-gate.txt");
  writeFileSync(
    gateScript,
    `
    import { existsSync, writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(startedFile)}, "started");
    const iv = setInterval(() => {
      if (existsSync(${JSON.stringify(releaseFile)})) {
        clearInterval(iv);
        process.exit(0);
      }
    }, 15);
    `,
  );
  t.after(() => {
    if (existsSync(h.dir) && !existsSync(releaseFile)) writeFileSync(releaseFile, "cleanup\n");
  });

  h.projectFactory.setContract({
    task: "LEG-1",
    workspace: h.root,
    gate: `${JSON.stringify(process.execPath)} ${JSON.stringify(gateScript)}`,
    artifact: "README.md",
    scope: ["zone-1"],
  });

  // Drive handleSpoolRequest directly without gateQueue to exercise the legacy non-gateQueue fallback path.
  const claimPromise = withTimeout(
    handleSpoolRequest(
      h.registry.root,
      {
        id: "leg-claim-1",
        kind: "claim",
        task: "LEG-1",
        sha: h.sha,
        handoff: HANDOFF,
        agent: "peer-leg",
        projectSlug: h.slug,
      },
      { peerMail: h.leadMail.notifyPeer, daemon: h.fake.daemon },
      h.registry,
    ),
    "legacy claim completes after gate release",
  );

  await until(() => {
    assert.ok(h.projectFactory.ledger.eventsFor("LEG-1").some((e) => e.event === "gate_started"), "legacy gate started");
    assert.ok(existsSync(startedFile), "legacy gate child script running");
  });

  // While the legacy Gate is blocked waiting on releaseFile, both leadMail pump/enqueue
  // and another Project-ingress-locked request (contract on a disjoint task) complete immediately.
  const mailPromise = withTimeout(
    (async () => {
      await h.leadMail.enqueueLeadMail(h.slug, { from: "owner", kind: "directive", text: "Ping while gate runs" });
      await h.leadMail.pumpProjectLead(h.slug);
    })(),
    "leadMail enqueue + pump during running legacy Gate",
  );
  const contractPromise = withTimeout(
    handleSpoolRequest(
      h.registry.root,
      {
        id: "leg-c2",
        kind: "contract",
        task: "LEG-2",
        workspace: h.root,
        gate: "true",
        artifact: "README.md",
        scope: ["zone-2"],
        submitter: "owner",
        projectSlug: h.slug,
      },
      { daemon: h.fake.daemon },
      h.registry,
    ),
    "concurrent contract during running legacy Gate",
  );

  const [, contractReply] = await Promise.all([mailPromise, contractPromise]);
  assert.equal(contractReply.ok, true);
  assert.ok(h.fake.sent.some((s) => s.agentId === "lead-1" && s.text.includes("Ping while gate runs")));

  // Complete Lead's turn so mailbox clears, then release the legacy Gate and settle with concurrent pump.
  await h.leadMail.onLeadTurnEnded({ agentId: "lead-1", outcome: { kind: "completed" }, timeline: [] });
  writeFileSync(releaseFile, "go\n");

  const concurrentPump = withTimeout(h.leadMail.pumpProjectLead(h.slug), "concurrent pump on legacy verdict");
  const [claimReply] = await Promise.all([claimPromise, concurrentPump]);
  assert.equal(claimReply.ok, true, claimReply.ok ? "" : claimReply.message);
  if (claimReply.ok) assert.equal(claimReply.verdict, "green");
  await until(() => {
    assert.ok(h.fake.sent.some((s) => s.agentId === "lead-1" && s.text.includes("Task LEG-1 attempt 1 ended GREEN")));
  });
});

test("Deadlock #3: non-lead needs_human releases Project ingress lock after Ledger write, before archive and peerMailHook", async (t) => {
  const archiveLatch = makeLatch() as Latch & { wait: () => Promise<void> };
  const h = setupRuntime(t, {
    withGateQueue: true,
    agents: [
      { id: "peer-nh-1", provider: "factory-peer", status: "idle", labels: { seat: "agent", project: "", task: "NH-1" } },
    ],
  });
  // Ensure agent labels carry the real slug and bind it to NH-1.
  h.fake.agents.find((a) => a.id === "peer-nh-1")!.labels = { seat: "agent", project: h.slug, task: "NH-1" };
  h.fake.archiveHooks.set("peer-nh-1", () => archiveLatch.wait());

  h.projectFactory.setContract({ task: "NH-1", workspace: h.root, gate: "true", artifact: "README.md" });
  const denial = h.projectFactory.ledger.append({
    event: "permit_denied",
    task: "NH-1",
    agent: "peer-nh-1",
    name: "Bash",
    kind: "tool",
    command: "git reset --hard",
    rule: "policy:S1-git-vocabulary",
    reason: "caught",
  });
  const repoke = h.projectFactory.repoke("NH-1", "peer-nh-1");
  assert.equal(repoke.outcome, "dispatched");

  const spoolRoot = spoolRootFor(h.stateDir);
  dropRequest(spoolRoot, {
    id: "nh-req-1",
    kind: "needs_human",
    task: "NH-1",
    reason: "denied-again",
    evidence: { denial: denial.seq, repoke: repoke.event.seq },
    submitter: "driver-1",
    projectSlug: h.slug,
  });

  // Wait until needs_human was appended to the Ledger and daemon archive() is paused on the latch.
  await withTimeout(archiveLatch.entered, "needs_human enters archiveTaskAgentBestEffort");
  assert.ok(h.projectFactory.ledger.eventsFor("NH-1").some((e) => e.event === "needs_human"));

  // While archiveTaskAgentBestEffort is paused, leadMail.enqueueLeadMail + pumpProjectLead must NOT block on ingress lock.
  await withTimeout(
    (async () => {
      await h.leadMail.enqueueLeadMail(h.slug, { from: "owner", kind: "directive", text: "Unblocked during needs_human archive" });
      await h.leadMail.pumpProjectLead(h.slug);
    })(),
    "leadMail pump during needs_human archive",
  );
  assert.ok(h.fake.sent.some((s) => s.agentId === "lead-1" && s.text.includes("Unblocked during needs_human archive")));
  await h.leadMail.onLeadTurnEnded({ agentId: "lead-1", outcome: { kind: "completed" }, timeline: [] });

  // Release archive latch and verify needs_human finishes + delivers Lead notification without deadlock.
  archiveLatch.release();
  await until(() => {
    const reply = readReply(spoolRoot, "nh-req-1");
    assert.equal(reply.ok, true);
    assert.ok(h.fake.sent.some((s) => s.agentId === "lead-1" && s.text.includes("Task NH-1 needs a human: denied-again")));
  });
});

test("Deadlock #4a: spool project_rotate bypasses Project ingress lock and never ABBA-deadlocks against serializeSeat(':supervisor') during supervisorSessionOpened", async (t) => {
  const h = setupRuntime(t, {
    withGateQueue: true,
    agents: [
      { id: "sup-cand-open", provider: "factory-supervisor", status: "idle", labels: {} },
    ],
  });
  h.fake.agents.find((a) => a.id === "sup-cand-open")!.cwd = h.root;

  // Queue a supervisor report so bindSupervisorCandidate -> kickoffSupervisorSeat -> pumpSupervisorMailbox -> withProjectIngressLock!
  await h.leadMail.enqueueLeadMail(h.slug, { to: "supervisor", from: "lead", kind: "report", text: "Waiting report" });

  // Pause supervisorSessionOpened inside serializeSeat("${slug}:supervisor") BEFORE it hits kickoffSupervisorSeat -> withProjectIngressLock.
  const openListLatch = makeLatch() as Latch & { wait: () => Promise<void> };
  h.fake.listHooks.push(() => openListLatch.wait());
  const openPromise = withTimeout(
    h.surface.supervisorSessionOpened({ agentId: "sup-cand-open", cwd: h.root }),
    "supervisorSessionOpened settles cleanly",
  );
  await withTimeout(openListLatch.entered, "supervisorSessionOpened acquired :supervisor seat lock");

  // Drop project_rotate into the Spool so handleRequestFile enters withExclusiveMaintenance, then calls handleSpoolRequest.
  // Previously, handleSpoolRequest fell through into withProjectIngressLock before waiting on serializeSeat(':supervisor'),
  // causing an ABBA deadlock when openPromise resumed and called pumpSupervisorMailbox -> withProjectIngressLock!
  const spoolRoot = spoolRootFor(h.stateDir);
  dropRequest(spoolRoot, {
    id: "rot-abba-1",
    kind: "project_rotate",
    project: h.slug,
    submitter: "owner",
  });

  // Give the Spool loop time to pick up project_rotate and block at retireSeat('supervisor') -> serializeSeat(':supervisor').
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6));
  assert.equal(existsSync(join(spoolRoot, "replies", "rot-abba-1.json")), false, "project_rotate is waiting for :supervisor seat lock");

  // Now let supervisorSessionOpened proceed into kickoffSupervisorSeat -> pumpSupervisorMailbox -> withProjectIngressLock.
  openListLatch.release();
  await openPromise;

  // project_rotate now acquires :supervisor seat lock, retires seats cleanly, and writes an ok reply!
  await until(() => {
    const reply = readReply(spoolRoot, "rot-abba-1");
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });
  const reg = readProjectRegistration(h.stateDir, h.slug);
  assert.equal(reg?.lead ?? null, null);
  assert.equal(reg?.supervisor ?? null, null);
});

test("Deadlock #4b: spool reset bypasses Project ingress lock and never ABBA-deadlocks against serializeSeat(':supervisor') during supervisorAdopt", async (t) => {
  const h = setupRuntime(t, {
    withGateQueue: true,
    agents: [
      { id: "sup-cand-adopt", provider: "factory-supervisor", status: "idle", labels: {} },
    ],
  });
  h.fake.agents.find((a) => a.id === "sup-cand-adopt")!.cwd = h.root;
  await h.leadMail.enqueueLeadMail(h.slug, { to: "supervisor", from: "lead", kind: "report", text: "Adopt report" });

  // Pause supervisorAdopt inside serializeSeat("${slug}:supervisor") before bindSupervisorCandidate -> withProjectIngressLock.
  const adoptListLatch = makeLatch() as Latch & { wait: () => Promise<void> };
  h.fake.listHooks.push(() => adoptListLatch.wait());
  const adoptPromise = withTimeout(
    h.surface.supervisorAdopt({ projectRoot: h.root, agentId: "sup-cand-adopt" }),
    "supervisorAdopt settles cleanly",
  );
  await withTimeout(adoptListLatch.entered, "supervisorAdopt acquired :supervisor seat lock");

  const spoolRoot = spoolRootFor(h.stateDir);
  dropRequest(spoolRoot, {
    id: "rst-abba-1",
    kind: "reset",
    workspace: h.root,
    submitter: "owner",
  });

  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6));
  assert.equal(existsSync(join(spoolRoot, "replies", "rst-abba-1.json")), false, "reset is waiting for :supervisor seat lock");

  adoptListLatch.release();
  const adoptResult = await adoptPromise;
  assert.equal(adoptResult.ok, true);

  await until(() => {
    const reply = readReply(spoolRoot, "rst-abba-1");
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });
});

test("Deadlock #5: close cancels running GateQueue before taking Project ingress lock and executeQueuedClaim uses newWork:false to break 3-way maintenance cycle", async (t) => {
  const h = setupRuntime(t, { withGateQueue: true });
  const startedMarker = join(h.dir, "gate-running.marker");

  // 1) Prove executeQueuedClaim uses newWork: false against concurrent active operation + withExclusiveMaintenance!
  const gateScript = join(h.dir, "gate-cancelable.mjs");
  writeFileSync(
    gateScript,
    `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(startedMarker)}, "running");
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
    `,
  );

  h.projectFactory.setContract({
    task: "T-3WAY",
    workspace: h.root,
    gate: `${JSON.stringify(process.execPath)} ${JSON.stringify(gateScript)}`,
    artifact: "README.md",
    scope: ["zone-3way"],
  });

  const admitted = await h.projectFactory.admitClaim({
    task: "T-3WAY",
    sha: h.sha,
    handoff: HANDOFF,
    queueId: "gq-3way",
  });
  assert.equal(admitted.status, "queued");

  // Simulate the 3-way cycle as sibling top-level callers (outside each other's AsyncLocalStorage context):
  // - Operation 1 holds history.runOperation (activeOperations = 1) until executeQueuedClaim finishes.
  // - withExclusiveMaintenance increments #maintenance = 1 waiting for activeOperations === 0.
  // - executeQueuedClaim is invoked while #maintenance > 0; with newWork: false it enters runOperation immediately.
  const activeLatch = makeLatch() as Latch & { wait: () => Promise<void> };
  let releaseExecWindow!: () => void;
  const execWindowDone = new Promise<void>((resolve) => {
    releaseExecWindow = resolve;
  });
  const activeOpPromise = h.projectFactory.history.runOperation(async () => {
    await activeLatch.wait();
    await execWindowDone;
    return "active-op-ok";
  });
  await withTimeout(activeLatch.entered, "active operation holds runOperation");

  const maintenancePromise = withTimeout(
    h.projectFactory.history.withExclusiveMaintenance(() => "maintenance-ok"),
    "3-way maintenance completes once active operation drains",
  );
  // Let maintenance increment #maintenance and park waiting on activeOperations === 0.
  await new Promise((resolve) => setTimeout(resolve, 15));

  // Now invoke executeQueuedClaim while activeOperations === 1 and #maintenance === 1.
  const controller = new AbortController();
  const execPromise = withTimeout(
    h.projectFactory.executeQueuedClaim({
      task: "T-3WAY",
      attempt: admitted.attempt,
      sha: h.sha,
      handoff: HANDOFF,
      signal: controller.signal,
      cancelNote: "cancelled-by-task-close",
    }),
    "executeQueuedClaim enters runOperation under pending maintenance",
  );
  await until(() => assert.ok(existsSync(startedMarker), "queued gate actually started execution"));
  controller.abort("cancelled-by-task-close");
  const outcome = await execPromise;
  assert.equal(outcome?.verdict, "red");
  releaseExecWindow();
  activeLatch.release();

  const [activeResult, maintenanceResult] = await Promise.all([activeOpPromise, maintenancePromise]);
  assert.equal(activeResult, "active-op-ok");
  assert.equal(maintenanceResult, "maintenance-ok");

  // 2) Now test Spool close cancelling a running GateQueue item concurrently with withExclusiveMaintenance
  //    AND verify withProjectIngressLock is NOT held while gateQueue.cancelMatching waits!
  const slowAbortFile = join(h.dir, "slow-abort.marker");
  const slowAbortScript = join(h.dir, "gate-slow-abort.mjs");
  writeFileSync(
    slowAbortScript,
    `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(slowAbortFile)}, "started");
    process.on("SIGTERM", () => {
      setTimeout(() => process.exit(0), 250);
    });
    setInterval(() => {}, 1000);
    `,
  );

  h.projectFactory.setContract({
    task: "T-CLOSE-LOCK",
    workspace: h.root,
    gate: `${JSON.stringify(process.execPath)} ${JSON.stringify(slowAbortScript)}`,
    artifact: "README.md",
    scope: ["zone-close"],
  });
  const enqueuedReply = await handleSpoolRequest(
    h.registry.root,
    { id: "c-close-lock", kind: "claim", task: "T-CLOSE-LOCK", sha: h.sha, handoff: HANDOFF, agent: "peer-close", projectSlug: h.slug },
    { gateQueue: h.gateQueue, daemon: h.fake.daemon },
    h.registry,
  );
  assert.equal(enqueuedReply.ok && enqueuedReply.status, "queued");
  await until(() => {
    assert.equal(h.gateQueue!.snapshot().running[0]?.task, "T-CLOSE-LOCK");
    assert.ok(existsSync(slowAbortFile));
  });

  const closeStart = Date.now();
  const closePromise = withTimeout(
    handleSpoolRequest(
      h.registry.root,
      { id: "close-req", kind: "close", task: "T-CLOSE-LOCK", reason: "superseded", by: "lead", submitter: "lead-1", projectSlug: h.slug },
      { gateQueue: h.gateQueue, daemon: h.fake.daemon, stopAgent: async () => ({ ok: true }) },
      h.registry,
    ),
    "close cancelling running gate",
  );

  // Immediately enqueue mail on the Project ingress lock + trigger exclusive maintenance concurrently.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const mailPromise = withTimeout(
    h.leadMail.enqueueLeadMail(h.slug, { from: "owner", kind: "directive", text: "Ingress lock free during close cancel" }),
    "enqueueLeadMail completes while close awaits gateQueue.cancelMatching",
  );
  await mailPromise;
  const mailElapsedMs = Date.now() - closeStart;
  assert.ok(mailElapsedMs < 200, `expected ingress lock to finish before 250ms gate abort (took ${mailElapsedMs}ms)`);

  const maintenanceDuringClose = withTimeout(
    h.projectFactory.history.withExclusiveMaintenance(() => "after-close"),
    "withExclusiveMaintenance settles after close",
  );
  const [closeReply, maintRes] = await Promise.all([closePromise, maintenanceDuringClose]);
  assert.equal(closeReply.ok, true, closeReply.ok ? "" : closeReply.message);
  assert.equal(maintRes, "after-close");
  assert.equal(h.projectFactory.ledger.eventsFor("T-CLOSE-LOCK").some((e) => e.event === "task_closed"), true);
});

test("Ticket 02: unexpected handleRequestFile failure logs once, writes atomic spool-internal-error reply, moves request to processed/, and stops retrying", async (t) => {
  const dir = makeTempDir("spool-err-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  t.after(() => factory.history.stop());
  const logs: string[] = [];

  // Force handleRequestFile's admission wrapper to reject unexpectedly (outside handleAdmittedSpoolRequest's try/catch).
  let runCalls = 0;
  const faultyFactory = new Proxy(factory, {
    get(target, key, receiver) {
      if (key === "history") {
        return new Proxy(target.history, {
          get(histTarget, histKey) {
            if (histKey === "runOperation") {
              return async (fn: () => Promise<unknown>, opts?: { newWork?: boolean }) => {
                if (opts !== undefined) {
                  runCalls += 1;
                  throw new Error("boom in history admission");
                }
                return histTarget.runOperation(fn, opts);
              };
            }
            const value = Reflect.get(histTarget, histKey, histTarget);
            return typeof value === "function" ? value.bind(histTarget) : value;
          },
        });
      }
      return Reflect.get(target, key, receiver);
    },
  });

  const spool = startSpool(stateDir, faultyFactory, {
    pollMs: POLL_MS,
    onLog: (m) => logs.push(m),
  });
  t.after(() => spool.stop());

  const spoolRoot = spoolRootFor(stateDir);
  // Drop a primary + duplicate request (sorted id order ensures err-1-primary runs first).
  dropRequest(spoolRoot, {
    id: "err-1-primary",
    kind: "contract",
    task: "T-ERR",
    workspace: dir,
    gate: "true",
    submitter: "owner",
  });
  dropRequest(spoolRoot, {
    id: "err-2-dup",
    kind: "contract",
    task: "T-ERR",
    workspace: dir,
    gate: "true",
    submitter: "owner",
  });

  await until(() => {
    assert.ok(existsSync(join(spoolRoot, "replies", "err-1-primary.json")), "primary error reply written");
    assert.ok(existsSync(join(spoolRoot, "processed", "err-1-primary.json")), "primary request moved to processed/");
  });

  const primaryReply = readReply(spoolRoot, "err-1-primary");
  assert.equal(primaryReply.id, "err-1-primary");
  assert.equal(primaryReply.ok, false);
  assert.equal(primaryReply.code, "spool-internal-error");
  assert.match(String(primaryReply.message), /boom in history admission/);
  assert.equal(existsSync(join(spoolRoot, "requests", "err-1-primary.json")), false);

  await until(() => {
    assert.ok(existsSync(join(spoolRoot, "replies", "err-2-dup.json")), "duplicate also received fail-closed reply");
    assert.ok(existsSync(join(spoolRoot, "processed", "err-2-dup.json")));
  });
  const dupReply = readReply(spoolRoot, "err-2-dup");
  assert.equal(dupReply.id, "err-2-dup");
  assert.equal(dupReply.code, "spool-internal-error");

  // Wait several poll intervals to prove it never loops in a 250ms retry storm.
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 8));
  assert.equal(runCalls, 1, "failed request must never be retried after fail-closed settlement");
  assert.equal(
    logs.filter((line) => line.includes("err-1-primary: FAILED unexpectedly")).length,
    1,
    "diagnostic log emitted exactly once",
  );
});

test("Ticket 02: 600s boot-replay TTL expires stale non-upgrade requests without side effects, replays fresh requests (<= 600s), and exempts upgrade", async (t) => {
  assert.equal(DEFAULT_SPOOL_REPLAY_TTL_MS, 600_000);

  const dir = makeTempDir("spool-ttl-");
  disposeDir(t, dir);
  const home = join(dir, "home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# ttl\n");
  const sha = gitCommitAll(repo, "init");

  const reg = ensureProjectRegistered(stateDir, repo);
  assert.ok(reg.ok);
  const rootFactory = createFactory({ stateDir });
  const registry = createFactoryRegistry({ stateDir, root: rootFactory });
  const projectFactory = registry.factoryForProject(reg.slug);
  projectFactory.setContract({
    task: "T-TTL",
    workspace: repo,
    gate: "true",
    artifact: "README.md",
    scope: ["src"],
  });

  const spoolRoot = spoolRootFor(stateDir);
  const fixedNow = 1_760_000_000_000;
  const setMtimeMs = (filePath: string, mtimeMs: number) => {
    const sec = mtimeMs / 1000;
    utimesSync(filePath, sec, sec);
  };

  // 1) Stale claim (600_001ms old -> expires, must NOT open an Attempt or touch Ledger/mailbox/GateQueue).
  const staleClaimPath = dropRequest(spoolRoot, {
    id: "stale-claim",
    kind: "claim",
    task: "T-TTL",
    sha,
    handoff: HANDOFF,
    agent: "peer-stale",
    projectSlug: reg.slug,
  });
  setMtimeMs(staleClaimPath, fixedNow - 600_001);

  // 2) Stale lead_dispatch (10_000_000ms old -> expires, must NOT dispatch Lead or touch mailbox).
  const staleDispatchPath = dropRequest(spoolRoot, {
    id: "stale-dispatch",
    kind: "lead_dispatch",
    project: reg.slug,
    message: "Should never deliver after restart",
  });
  setMtimeMs(staleDispatchPath, fixedNow - 10_000_000);

  // 3) Stale upgrade request (2 hours old -> MUST be exempted and processed normally!).
  const staleUpgradePath = dropRequest(spoolRoot, {
    id: "stale-upgrade",
    kind: "upgrade",
    action: "preflight",
  });
  setMtimeMs(staleUpgradePath, fixedNow - 7_200_000);

  // 4) Boundary-fresh claim (exactly 600_000ms old -> <= 600_000ms replays normally!).
  const freshBoundaryClaimPath = dropRequest(spoolRoot, {
    id: "fresh-boundary-claim",
    kind: "claim",
    task: "T-TTL",
    sha,
    handoff: HANDOFF,
    agent: "peer-fresh",
    projectSlug: reg.slug,
  });
  setMtimeMs(freshBoundaryClaimPath, fixedNow - 600_000);

  // 5) Already-answered stale request keeps its original reply untouched and moves to processed/.
  mkdirSync(join(spoolRoot, "replies"), { recursive: true });
  writeFileSync(join(spoolRoot, "replies", "already-replied.json"), JSON.stringify({ id: "already-replied", ok: true, summary: "kept" }) + "\n");
  const alreadyRepliedPath = dropRequest(spoolRoot, {
    id: "already-replied",
    kind: "lead_dispatch",
    project: reg.slug,
    message: "Ignored because reply exists",
  });
  setMtimeMs(alreadyRepliedPath, fixedNow - 900_000);

  let ready = false;
  let dispatchCalls = 0;
  const logs: string[] = [];
  const gateQueue = createGateQueue({ stateDir, factory: rootFactory, registry });
  const spool = startSpool(stateDir, rootFactory, {
    pollMs: POLL_MS,
    registry,
    gateQueue,
    ordinaryReady: () => ready,
    now: () => fixedNow,
    leadDispatch: async (req) => {
      dispatchCalls += 1;
      return { id: req.id, ok: true, summary: "dispatched" };
    },
    onLog: (m) => logs.push(m),
  });
  t.after(() => {
    spool.stop();
    gateQueue.stop();
    registry.stop();
  });

  // While ordinaryReady === false: stale upgrade MUST still run (exempt from recovery hold and TTL!),
  // while non-upgrade requests remain untouched in requests/ until ordinary admission resumes.
  await until(() => {
    assert.ok(existsSync(join(spoolRoot, "replies", "stale-upgrade.json")), "upgrade ran even while recovering");
    assert.ok(existsSync(join(spoolRoot, "processed", "stale-upgrade.json")));
  });
  const upgradeReply = readReply(spoolRoot, "stale-upgrade");
  assert.equal(upgradeReply.ok, true);
  assert.equal(existsSync(staleClaimPath), true, "non-upgrade stays queued while recovering");
  assert.equal(existsSync(staleDispatchPath), true, "non-upgrade stays queued while recovering");

  // Flip ordinaryReady -> true (simulated restart completion).
  ready = true;
  await until(() => {
    assert.ok(existsSync(join(spoolRoot, "replies", "stale-claim.json")));
    assert.ok(existsSync(join(spoolRoot, "replies", "stale-dispatch.json")));
    assert.ok(existsSync(join(spoolRoot, "replies", "fresh-boundary-claim.json")));
    assert.ok(existsSync(join(spoolRoot, "processed", "already-replied.json")));
  });

  const staleClaimReply = readReply(spoolRoot, "stale-claim");
  assert.equal(staleClaimReply.ok, false);
  assert.equal(staleClaimReply.code, "request-expired-after-restart");
  assert.match(String(staleClaimReply.message), /boot-replay TTL/);
  assert.equal(existsSync(join(spoolRoot, "requests", "stale-claim.json")), false);
  assert.equal(existsSync(join(spoolRoot, "processed", "stale-claim.json")), true);

  const staleDispatchReply = readReply(spoolRoot, "stale-dispatch");
  assert.equal(staleDispatchReply.ok, false);
  assert.equal(staleDispatchReply.code, "request-expired-after-restart");
  assert.equal(existsSync(join(spoolRoot, "processed", "stale-dispatch.json")), true);
  assert.equal(dispatchCalls, 0, "stale lead_dispatch was never replayed");
  assert.equal(existsSync(join(projectStateDir(stateDir, reg.slug), "mailbox.jsonl")), false, "no mailbox mutation from expired dispatch");

  // Already-replied request kept its original reply.
  assert.deepEqual(readReply(spoolRoot, "already-replied"), { id: "already-replied", ok: true, summary: "kept" });

  // Fresh boundary claim (exact 600_000ms) replayed and queued/executed normally!
  const freshReply = readReply(spoolRoot, "fresh-boundary-claim");
  assert.equal(freshReply.ok, true, JSON.stringify(freshReply));
  assert.equal(freshReply.status, "queued");
  await until(() => {
    assert.ok(projectFactory.ledger.eventsFor("T-TTL").some((e) => e.event === "report_written"));
  });
  const queuedEvents = projectFactory.ledger.eventsFor("T-TTL").filter((e) => e.event === "gate_queued");
  assert.equal(queuedEvents.length, 1, "only fresh claim mutated the Ledger (stale claim did not)");
  assert.ok(logs.some((line) => line.includes("stale-claim") && line.includes("EXPIRED after restart")));
  assert.ok(logs.some((line) => line.includes("stale-dispatch") && line.includes("EXPIRED after restart")));

  // Also prove an upgrade request stays exempt even AFTER ordinaryReady === true (when !recovering).
  const lateStaleUpgradePath = dropRequest(spoolRoot, {
    id: "late-stale-upgrade",
    kind: "upgrade",
    action: "preflight",
  });
  setMtimeMs(lateStaleUpgradePath, fixedNow - 7_200_000);
  await until(() => {
    assert.ok(existsSync(join(spoolRoot, "replies", "late-stale-upgrade.json")));
  });
  assert.equal(readReply(spoolRoot, "late-stale-upgrade").ok, true);
});

test("Deadlock #4c: spool delete and project_register bypass Project ingress lock via takesExclusiveMaintenance even when ingress lock is held", async (t) => {
  const h = setupRuntime(t, { withGateQueue: true });
  const ingressLatch = makeLatch() as Latch & { wait: () => Promise<void> };
  const heldIngress = withProjectIngressLock(h.stateDir, h.slug, () => ingressLatch.wait());
  t.after(() => ingressLatch.release());
  await withTimeout(ingressLatch.entered, "test holds Project ingress lock");

  const spoolRoot = spoolRootFor(h.stateDir);
  dropRequest(spoolRoot, {
    id: "reg-bypass",
    kind: "project_register",
    workspace: h.root,
    submitter: "owner",
  });
  await until(() => {
    assert.equal(readReply(spoolRoot, "reg-bypass").ok, true);
  });

  dropRequest(spoolRoot, {
    id: "del-bypass",
    kind: "delete",
    workspace: h.root,
    submitter: "owner",
  });
  await until(() => {
    assert.equal(readReply(spoolRoot, "del-bypass").ok, true);
  });

  ingressLatch.release();
  await heldIngress;
});

test("Ticket 02: default Date.now() and 600s replayTtlMs expire stale requests and replay fresh requests without clock overrides", async (t) => {
  const dir = makeTempDir("spool-ttl-default-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# default ttl\n");
  gitCommitAll(repo, "init");

  const reg = ensureProjectRegistered(stateDir, repo);
  assert.ok(reg.ok);
  const rootFactory = createFactory({ stateDir });
  const registry = createFactoryRegistry({ stateDir, root: rootFactory });

  const spoolRoot = spoolRootFor(stateDir);
  const stalePath = dropRequest(spoolRoot, {
    id: "default-stale",
    kind: "contract",
    task: "T-DEF-STALE",
    workspace: repo,
    gate: "true",
    artifact: "README.md",
    submitter: "owner",
  });
  const staleSec = (Date.now() - 610_000) / 1000;
  utimesSync(stalePath, staleSec, staleSec);

  dropRequest(spoolRoot, {
    id: "default-fresh",
    kind: "contract",
    task: "T-DEF-FRESH",
    workspace: repo,
    gate: "true",
    artifact: "README.md",
    submitter: "owner",
  });

  const spool = startSpool(stateDir, rootFactory, { pollMs: POLL_MS, registry });
  t.after(() => {
    spool.stop();
    registry.stop();
  });

  await until(() => {
    assert.ok(existsSync(join(spoolRoot, "replies", "default-stale.json")));
    assert.ok(existsSync(join(spoolRoot, "replies", "default-fresh.json")));
  });

  const staleReply = readReply(spoolRoot, "default-stale");
  assert.equal(staleReply.ok, false);
  assert.equal(staleReply.code, "request-expired-after-restart");

  const freshReply = readReply(spoolRoot, "default-fresh");
  assert.equal(freshReply.ok, true);
  assert.equal(registry.factoryForProject(reg.slug).contractFor("T-DEF-STALE"), undefined);
  assert.ok(registry.factoryForProject(reg.slug).contractFor("T-DEF-FRESH") !== undefined);
});

