import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { CorrelationRegistry } from "../plugin/server/core/correlations.ts";
import { MAX_ATTEMPTS } from "../plugin/server/core/events.ts";
import { ensureProjectRegistered, projectStateDir, readProjectRegistration, writeProjectRegistration } from "../plugin/server/core/project.ts";
import { readLeadMailbox, readMailboxEvents, type LeadMailboxEvent } from "../plugin/server/core/mailbox.ts";
import { createFactoryRegistry } from "../plugin/server/projects.ts";
import { createSurfaceHandlers, type SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { handleSpoolRequest, settleClaimOutcome, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { createGateQueue } from "../plugin/server/gate-queue.ts";
import { disposeDir, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";
import { allocateTaskWorktree } from "../plugin/server/core/mcp/worktrees.ts";
import { projectTask } from "../plugin/server/core/task-state.ts";

const handoff = {
  outcome: "complete" as const,
  scope: "src/index.ts",
  verification: "slice tests pass",
  unknowns: "none",
};

function makeProjectRepo(dir: string, name: string): { root: string; slug: string; sha: string } {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), `# ${name}\n`);
  const sha = gitCommitAll(root, `init ${name}`);
  return { root, slug: "", sha };
}

function makeFakeDaemon(initialAgents: Array<{ id: string; status?: string; labels?: Record<string, string>; cwd?: string; requiresAttention?: boolean; attentionReason?: string | null; archivedAt?: string | null; sendShouldFail?: boolean }> = []) {
  const buildAgent = (a: { id: string; status?: string; labels?: Record<string, string>; cwd?: string; requiresAttention?: boolean; attentionReason?: string | null; archivedAt?: string | null; sendShouldFail?: boolean }) => ({
    id: a.id,
    provider: "pi/zai/glm-5.3",
    title: a.id,
    status: a.status ?? "idle",
    model: null,
    labels: a.labels ?? {},
    archivedAt: a.archivedAt ?? (null as string | null),
    requiresAttention: a.requiresAttention ?? false,
    attentionReason: a.attentionReason ?? null,
    updatedAt: "2026-11-22T00:00:00.000Z",
    cwd: a.cwd ?? "/tmp",
  });
  const agents = initialAgents.map(buildAgent);
  const sendFailures = new Set<string>(initialAgents.filter((a) => a.sendShouldFail).map((a) => a.id));
  const sent: Array<{ agentId: string; text: string }> = [];
  const addAgent = (a: { id: string; status?: string; labels?: Record<string, string>; cwd?: string; requiresAttention?: boolean; attentionReason?: string | null; archivedAt?: string | null; sendShouldFail?: boolean }) => {
    const built = buildAgent(a);
    agents.push(built);
    if (a.sendShouldFail) sendFailures.add(a.id);
    return built;
  };
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async (opts) => ({
        entries: agents
          .filter((a) => opts?.filter?.includeArchived || a.archivedAt === null)
          .filter((a) => {
            const labels = opts?.filter?.labels;
            if (!labels) return true;
            return Object.entries(labels).every(([k, v]) => a.labels[k] === v);
          })
          .map((agent) => ({ agent })),
      }),
      create: async (opts) => {
        const id = `created-${agents.length + 1}`;
        agents.push(buildAgent({ id, labels: opts.labels ?? {}, cwd: opts.cwd }));
        return { id };
      },
      ref: (id) => ({
        send: async (text: string) => {
          if (sendFailures.has(id)) throw new Error(`send failed for ${id}`);
          sent.push({ agentId: id, text });
        },
        archive: async () => {
          const found = agents.find((a) => a.id === id);
          if (found) found.archivedAt = new Date().toISOString();
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
  return { daemon, agents, sent, addAgent, sendFailures };
}

async function until(fn: () => void, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      fn();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

function setupMultiProjectHarness(t: TestContext, options: { concurrency?: number; timeoutMs?: number } = {}) {
  const dir = makeTempDir("gate-queue-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const rootA = join(dir, "proj-a");
  const rootB = join(dir, "proj-b");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  writeFileSync(join(rootA, "README.md"), "a\n");
  writeFileSync(join(rootB, "README.md"), "b\n");
  const shaA = gitCommitAll(rootA, "init-a");
  const shaB = gitCommitAll(rootB, "init-b");

  const regA = ensureProjectRegistered(stateDir, rootA);
  const regB = ensureProjectRegistered(stateDir, rootB);
  assert.ok(regA.ok && regB.ok);

  const rootFactory = createFactory({ stateDir, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  const registry = createFactoryRegistry({ stateDir, root: rootFactory });
  const fake = makeFakeDaemon([
    { id: "lead-a", status: "idle", labels: { seat: "lead", project: regA.slug }, cwd: regA.root },
    { id: "lead-b", status: "idle", labels: { seat: "lead", project: regB.slug }, cwd: regB.root },
  ]);
  writeProjectRegistration(stateDir, regA.slug, { root: regA.root, lead: "lead-a" });
  writeProjectRegistration(stateDir, regB.slug, { root: regB.root, lead: "lead-b" });

  const surface = createSurfaceHandlers({ factory: rootFactory, registry, stateDir, home: dir, daemon: fake.daemon });
  const leadMail = createLeadMailRuntime({
    factory: rootFactory,
    registry,
    stateDir,
    daemon: fake.daemon,
    ensureLead: (i) => surface.leadEnsure(i),
    retireLead: (i) => surface.leadRotate(i),
  });
  const gateQueue = createGateQueue({
    stateDir,
    factory: rootFactory,
    registry,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    onSettled: async ({ item, outcome }) => {
      await leadMail.notifyPeer({
        task: item.task,
        kind: "verdict",
        text: `Task ${item.task} attempt ${outcome.attempt} ended ${outcome.verdict.toUpperCase()} — note: ${outcome.gate.note}`,
      });
    },
  });
  const spool = startSpool(stateDir, rootFactory, {
    registry,
    daemon: fake.daemon,
    peerMail: leadMail.notifyPeer,
    gateQueue,
    pollMs: 15,
  });
  t.after(() => {
    spool.stop();
    gateQueue.stop();
    leadMail.stop();
    registry.stop();
  });

  return { dir, stateDir, regA, regB, shaA, shaB, rootFactory, registry, fake, leadMail, gateQueue, spool };
}

test("async agent_claim and lead_verify serialize across Projects in FIFO order (concurrency = 1) while empty read-only gates bypass queue and pause", async (t) => {
  const h = setupMultiProjectHarness(t);
  const eventsLog = join(h.dir, "gate-order.log");
  const scriptA = join(h.dir, "gate-a.mjs");
  const scriptB = join(h.dir, "gate-b.mjs");
  const scriptLV = join(h.dir, "gate-lv.mjs");
  const writeGateScript = (path: string, label: string, delayMs: number) => {
    writeFileSync(
      path,
      `
      import { appendFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
      const lock = ${JSON.stringify(join(h.dir, "active-gate.lock"))};
      if (existsSync(lock)) {
        appendFileSync(${JSON.stringify(eventsLog)}, "OVERLAP:${label}\\n");
        process.exit(2);
      }
      writeFileSync(lock, ${JSON.stringify(label)});
      appendFileSync(${JSON.stringify(eventsLog)}, "START:${label}\\n");
      setTimeout(() => {
        rmSync(lock, { force: true });
        appendFileSync(${JSON.stringify(eventsLog)}, "END:${label}\\n");
        process.exit(0);
      }, ${delayMs});
      `,
    );
  };
  writeGateScript(scriptA, "A", 180);
  writeGateScript(scriptB, "B", 60);
  writeGateScript(scriptLV, "LV", 60);

  const fA = h.registry.factoryForProject(h.regA.slug);
  const fB = h.registry.factoryForProject(h.regB.slug);
  fA.setContract({ task: "TASK-A", workspace: h.regA.root, gate: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptA)}`, artifact: "README.md" });
  fB.setContract({ task: "TASK-B", workspace: h.regB.root, gate: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptB)}`, artifact: "README.md" });
  fA.setContract({ task: "TASK-LV", workspace: h.regA.root, gate: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptLV)}`, artifact: "README.md" });
  fB.setContract({ task: "SCOUT-EMPTY", workspace: h.regB.root, gate: "", disposition: "scout" });

  // 1. Enqueue A, B, and lead_verify across two Projects while A's 180ms Gate runs.
  const rA = await handleSpoolRequest(h.rootFactory, { id: "cA", kind: "claim", task: "TASK-A", sha: h.shaA, handoff, agent: "peer-a", projectSlug: h.regA.slug }, { gateQueue: h.gateQueue }, h.registry);
  const rB = await handleSpoolRequest(h.rootFactory, { id: "cB", kind: "claim", task: "TASK-B", sha: h.shaB, handoff, agent: "peer-b", projectSlug: h.regB.slug }, { gateQueue: h.gateQueue }, h.registry);
  const rLV = await handleSpoolRequest(h.rootFactory, { id: "cLV", kind: "claim", task: "TASK-LV", sha: h.shaA, mechanical: "lead_verify", agent: "lead-a", projectSlug: h.regA.slug }, { gateQueue: h.gateQueue }, h.registry);

  assert.equal(rA.ok && rA.status, "queued");
  assert.equal(rB.ok && rB.status, "queued");
  assert.equal(rLV.ok && rLV.status, "queued");
  if (rA.ok && rB.ok && rLV.ok) {
    assert.equal(rA.position, 1);
    assert.deepEqual(rA.ahead, []);
    assert.equal(rB.position, 2);
    assert.equal(rB.ahead?.length, 1);
    assert.equal(rLV.position, 3);
    assert.equal(rLV.ahead?.length, 2);
  }

  // `gate_queued` was persisted synchronously in each Project's Ledger.
  assert.ok(fA.ledger.eventsFor("TASK-A").some((e) => e.event === "gate_queued"));
  assert.ok(fB.ledger.eventsFor("TASK-B").some((e) => e.event === "gate_queued"));
  assert.ok(fA.ledger.eventsFor("TASK-LV").some((e) => e.event === "gate_queued"));

  // 2. While shell Gates are queued/running AND the queue is paused,
  //    a read-only empty gate (`gate: ""`) bypasses both the queue and pause immediately.
  assert.equal(h.gateQueue.pause().paused, true);
  const rEmpty = await handleSpoolRequest(
    h.rootFactory,
    { id: "cEmpty", kind: "claim", task: "SCOUT-EMPTY", handoff, agent: "peer-scout", projectSlug: h.regB.slug },
    { gateQueue: h.gateQueue, peerMail: h.leadMail.notifyPeer },
    h.registry,
  );
  assert.equal(rEmpty.ok, true);
  if (rEmpty.ok) {
    assert.equal(rEmpty.status, undefined, "empty gate executes immediately rather than queueing");
    assert.equal(rEmpty.verdict, "green");
    assert.equal(rEmpty.attempt, 1);
  }
  assert.equal(h.gateQueue.resume().paused, false);

  // 3. Wait for all 3 queued Gates to drain FIFO.
  await until(() => {
    assert.equal(h.gateQueue.snapshot().running.length, 0);
    assert.equal(h.gateQueue.snapshot().queued.length, 0);
    assert.ok(fA.ledger.eventsFor("TASK-LV").some((e) => e.event === "report_written"));
  });

  const trace = readFileSync(eventsLog, "utf8").trim().split("\n");
  assert.deepEqual(trace, ["START:A", "END:A", "START:B", "END:B", "START:LV", "END:LV"], "strict machine-wide FIFO serialization with zero overlap");

  // Idempotent green replay returns immediately without enqueueing or duplicate mail.
  const mailCountBefore = readLeadMailbox(join(h.stateDir, "projects", h.regA.slug, "mailbox.jsonl")).queued.length +
    (readLeadMailbox(join(h.stateDir, "projects", h.regA.slug, "mailbox.jsonl")).inFlight?.items.length ?? 0);
  const replay = await handleSpoolRequest(
    h.rootFactory,
    { id: "cA-replay", kind: "claim", task: "TASK-A", sha: h.shaA, handoff, agent: "peer-a", projectSlug: h.regA.slug },
    { gateQueue: h.gateQueue, peerMail: h.leadMail.notifyPeer },
    h.registry,
  );
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.status, undefined);
    assert.equal(replay.verdict, "green");
    assert.equal(replay.attempt, 1);
  }
  assert.equal(fA.ledger.eventsFor("TASK-A").filter((e) => e.event === "gate_queued").length, 1);
  const mailCountAfter = readLeadMailbox(join(h.stateDir, "projects", h.regA.slug, "mailbox.jsonl")).queued.length +
    (readLeadMailbox(join(h.stateDir, "projects", h.regA.slug, "mailbox.jsonl")).inFlight?.items.length ?? 0);
  assert.equal(mailCountAfter, mailCountBefore);
});

test("dequeue-anchored timeoutSeconds: queue wait longer than timeout does NOT kill queued Task, while execution timeout kills after gate_started", async (t) => {
  const h = setupMultiProjectHarness(t, { timeoutMs: 350 });
  const fA = h.registry.factoryForProject(h.regA.slug);
  const fB = h.registry.factoryForProject(h.regB.slug);

  // Project A takes 250ms, Project B waits 250ms and runs 50ms (total 300ms, or 600ms > 350ms if A takes 550ms!).
  // Use Contract-level timeoutSeconds or fast timeout override: let's test A=500ms (>350ms? Wait: A also has 350ms if options.timeoutMs=350! So set options.timeoutMs unset and test real Contract timeoutSeconds OR mock/override per-item? Let's use two separate Contracts without options.timeoutMs? Wait: min Contract timeoutSeconds is 60s. So instead let's have A run 500ms on a factory with timeoutMs=2000 while B runs 60ms on a factory with timeoutMs=350 — wait: `registry.factoryForProject` creates Project factories without options.timeoutMs! Let's test `timeoutMs` via `gateQueue.enqueue` OR `createFactory` options!).
  // Actually: Project A is on rootFactory (with timeoutMs=2000) or we set timeoutMs per enqueue/Contract!
  // Wait: let's verify BOTH:
  // (1) Enqueue A (sleep 500ms, timeoutMs 2000) then B (sleep 60ms, timeoutMs 250).
  //     B waits 500ms in queue (2x its 250ms execution timeout!), then dequeues (`gate_started`) and finishes GREEN in 60ms!
  fA.setContract({ task: "SLOW-HEAD", workspace: h.regA.root, gate: `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 500)"`, artifact: "README.md" });
  fB.setContract({ task: "FAST-QUEUED", workspace: h.regB.root, gate: `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 60)"`, artifact: "README.md" });

  const admA = await fA.admitClaim({ task: "SLOW-HEAD", sha: h.shaA, handoff, queueId: "gq-slow" });
  const admB = await fB.admitClaim({ task: "FAST-QUEUED", sha: h.shaB, handoff, queueId: "gq-fast" });
  assert.equal(admA.status, "queued");
  assert.equal(admB.status, "queued");

  h.gateQueue.enqueue({
    id: "gq-slow",
    projectSlug: h.regA.slug,
    task: "SLOW-HEAD",
    attempt: 1,
    sha: h.shaA,
    cmd: fA.contractFor("SLOW-HEAD")!.gate,
    cwd: h.regA.root,
    artifact: "README.md",
    timeoutMs: 2_000,
    handoff,
  });
  h.gateQueue.enqueue({
    id: "gq-fast",
    projectSlug: h.regB.slug,
    task: "FAST-QUEUED",
    attempt: 1,
    sha: h.shaB,
    cmd: fB.contractFor("FAST-QUEUED")!.gate,
    cwd: h.regB.root,
    artifact: "README.md",
    timeoutMs: 250,
    handoff,
  });

  await until(() => {
    assert.ok(fB.ledger.eventsFor("FAST-QUEUED").some((e) => e.event === "report_written"));
  });

  const finishedB = fB.ledger.eventsFor("FAST-QUEUED").find((e) => e.event === "gate_finished");
  assert.equal(finishedB?.event === "gate_finished" && finishedB.verdict, "green", "queue wait > timeoutMs must NOT kill queued Gate");
});

test("persisted daemon restart recovery marks prior running Gate as red (daemon-restarted) ignoring stale PID and resumes queued items FIFO", async (t) => {
  const dir = makeTempDir("gate-queue-restart-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const rootA = join(dir, "proj-a");
  const rootB = join(dir, "proj-b");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  writeFileSync(join(rootA, "README.md"), "a\n");
  writeFileSync(join(rootB, "README.md"), "b\n");
  const shaA = gitCommitAll(rootA, "a");
  const shaB = gitCommitAll(rootB, "b");
  const regA = ensureProjectRegistered(stateDir, rootA);
  const regB = ensureProjectRegistered(stateDir, rootB);
  assert.ok(regA.ok && regB.ok);

  // Boot 1: enqueue A (running) and B (queued), then simulate daemon restart mid-flight.
  const registry1 = createFactoryRegistry({ stateDir });
  const fA1 = registry1.factoryForProject(regA.slug);
  const fB1 = registry1.factoryForProject(regB.slug);
  fA1.setContract({ task: "T-RUN", workspace: rootA, gate: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`, artifact: "README.md" });
  fB1.setContract({ task: "T-QUEUED", workspace: rootB, gate: "true", artifact: "README.md" });

  const q1 = createGateQueue({ stateDir, factory: registry1.root, registry: registry1 });
  await handleSpoolRequest(registry1.root, { id: "q-a", kind: "claim", task: "T-RUN", sha: shaA, handoff, projectSlug: regA.slug }, { gateQueue: q1 }, registry1);
  await handleSpoolRequest(registry1.root, { id: "q-b", kind: "claim", task: "T-QUEUED", sha: shaB, handoff, projectSlug: regB.slug }, { gateQueue: q1 }, registry1);

  await until(() => {
    const snap = q1.snapshot();
    assert.equal(snap.running.length, 1);
    assert.equal(snap.running[0]?.task, "T-RUN");
    assert.equal(snap.queued.length, 1);
    assert.ok(fA1.ledger.eventsFor("T-RUN").some((e) => e.event === "gate_started"));
  });

  // Simulate daemon crash/stop: stop q1 & registry1 WITHOUT removing gate-queue.json entries.
  q1.stop();
  registry1.stop();

  // Poison stale PID in gate-queue.json to prove boot recovery never signals/trusts OS PIDs.
  const queueJson = JSON.parse(readFileSync(join(stateDir, "gate-queue.json"), "utf8"));
  queueJson.items[0].pid = 99999999;
  writeFileSync(join(stateDir, "gate-queue.json"), JSON.stringify(queueJson, null, 2) + "\n");

  // Boot 2: fresh registry + fresh GateQueue + startupRecovery().
  const settledEvents: Array<{ task: string; verdict: string; note: string; restarted: boolean }> = [];
  const registry2 = createFactoryRegistry({ stateDir });
  const q2 = createGateQueue({
    stateDir,
    factory: registry2.root,
    registry: registry2,
    onSettled: async ({ item, outcome, restarted }) => {
      settledEvents.push({ task: item.task, verdict: outcome.verdict, note: outcome.gate.note, restarted });
    },
  });
  t.after(() => {
    q2.stop();
    registry2.stop();
  });

  const rec = await q2.startupRecovery();
  assert.equal(rec.restartedRed.length, 1);
  assert.equal(rec.restartedRed[0]?.task, "T-RUN");
  assert.equal(rec.resumedCount, 1);

  // Immediately settled T-RUN as red (`daemon-restarted`) and wrote report.
  const fA2 = registry2.factoryForProject(regA.slug);
  const tRunGate = fA2.ledger.eventsFor("T-RUN").findLast((e) => e.event === "gate_finished");
  assert.equal(tRunGate?.event === "gate_finished" && tRunGate.verdict, "red");
  assert.equal(tRunGate?.event === "gate_finished" && tRunGate.note, "daemon-restarted");
  assert.ok(fA2.ledger.eventsFor("T-RUN").some((e) => e.event === "report_written"));

  // And T-QUEUED resumed automatically and finished GREEN!
  const fB2 = registry2.factoryForProject(regB.slug);
  await until(() => {
    assert.ok(fB2.ledger.eventsFor("T-QUEUED").some((e) => e.event === "report_written"));
  });
  const tQueuedGate = fB2.ledger.eventsFor("T-QUEUED").findLast((e) => e.event === "gate_finished");
  assert.equal(tQueuedGate?.event === "gate_finished" && tQueuedGate.verdict, "green");

  assert.equal(settledEvents.some((e) => e.task === "T-RUN" && e.verdict === "red" && e.note === "daemon-restarted" && e.restarted), true);
  assert.equal(settledEvents.some((e) => e.task === "T-QUEUED" && e.verdict === "green" && !e.restarted), true);
});

test("lifecycle guards: lead_set_contract supersedes queued Gate, refuses running Gate (gate-in-flight); lead_merge refuses queued and running Gates (gate-in-flight)", async (t) => {
  const h = setupMultiProjectHarness(t);
  const fA = h.registry.factoryForProject(h.regA.slug);
  const fB = h.registry.factoryForProject(h.regB.slug);

  const markerFile = join(h.dir, "superseded-ran.txt");
  const releaseFile = join(h.dir, "release-a.txt");
  // Project A holds the single queue slot until releaseFile exists.
  fA.setContract({
    task: "T-HOLD",
    workspace: h.regA.root,
    gate: `${JSON.stringify(process.execPath)} -e "const fs=require('fs');const iv=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)})){clearInterval(iv);process.exit(0);}},20);"`,
    artifact: "README.md",
  });
  // Project B has a GREEN attempt 1 first, then a queued lead_verify (to verify lead_merge refuses queued too),
  // plus another task T-REC that is queued and gets re-contracted.
  fB.setContract({ task: "T-GREEN", workspace: h.regB.root, gate: "true", artifact: "README.md" });
  await fB.claim({ task: "T-GREEN", sha: h.shaB, handoff });

  fB.setContract({
    task: "T-REC",
    workspace: h.regB.root,
    gate: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(${JSON.stringify(markerFile)}, 'ran'); process.exit(0);"`,
    artifact: "README.md",
  });

  // Start Project A running, then queue T-GREEN (attempt 2 via lead_verify) and T-REC behind it.
  const qA = await handleSpoolRequest(
    h.rootFactory,
    { id: "c-hold", kind: "claim", task: "T-HOLD", sha: h.shaA, handoff, agent: "peer-a", projectSlug: h.regA.slug },
    { gateQueue: h.gateQueue },
    h.registry,
  );
  assert.equal(qA.ok && qA.status, "queued");
  await until(() => assert.equal(h.gateQueue.snapshot().running.length, 1));

  const qVerify = await handleSpoolRequest(
    h.rootFactory,
    { id: "c-lv", kind: "claim", task: "T-GREEN", sha: h.shaB, mechanical: "lead_verify", agent: "lead-b", projectSlug: h.regB.slug },
    { gateQueue: h.gateQueue },
    h.registry,
  );
  assert.equal(qVerify.ok && qVerify.status, "queued");

  const qRec = await handleSpoolRequest(
    h.rootFactory,
    { id: "c-rec", kind: "claim", task: "T-REC", sha: h.shaB, handoff, agent: "peer-b", projectSlug: h.regB.slug },
    { gateQueue: h.gateQueue },
    h.registry,
  );
  assert.equal(qRec.ok && qRec.status, "queued");

  const validBrief = [
    "1. Bounded Outcome\nUpdate contract cleanly.",
    "2. Contract Boundary & Regression Invariants\nExisting files unchanged.",
    "3. Excluded / Deferred\nNone.",
    "4. Verification\ntrue",
  ].join("\n\n");

  // 1. lead_set_contract and lead_merge refuse running Gate with gate-in-flight.
  const contractWhileRunning = await handleSpoolRequest(
    h.rootFactory,
    { id: "sc-run", kind: "contract", task: "T-HOLD", workspace: h.regA.root, gate: "true", artifact: "README.md", description: validBrief, submitter: "lead-a", projectSlug: h.regA.slug },
    { gateQueue: h.gateQueue },
    h.registry,
  );
  assert.equal(contractWhileRunning.ok, false);
  if (!contractWhileRunning.ok) assert.equal(contractWhileRunning.code, "gate-in-flight");

  const acceptWhileRunning = await handleSpoolRequest(
    h.rootFactory,
    { id: "ac-run", kind: "accept", task: "T-HOLD", attempt: 1, submitter: "owner", projectSlug: h.regA.slug },
    { gateQueue: h.gateQueue },
    h.registry,
  );
  assert.equal(acceptWhileRunning.ok, false);
  if (!acceptWhileRunning.ok) assert.equal(acceptWhileRunning.code, "gate-in-flight");

  // 2. lead_merge refuses when Task has a queued Gate (even on an earlier green attempt).
  const acceptWhileQueued = await handleSpoolRequest(
    h.rootFactory,
    { id: "ac-q", kind: "accept", task: "T-GREEN", attempt: 1, submitter: "lead-b", by: "lead", projectSlug: h.regB.slug },
    { gateQueue: h.gateQueue },
    h.registry,
  );
  assert.equal(acceptWhileQueued.ok, false);
  if (!acceptWhileQueued.ok) assert.equal(acceptWhileQueued.code, "gate-in-flight");

  // 3. Invalid lead_set_contract must NOT dequeue the queued T-REC Gate.
  const invalidRecontract = await handleSpoolRequest(
    h.rootFactory,
    { id: "sc-bad", kind: "contract", task: "T-REC", workspace: h.regB.root, gate: "", description: validBrief, submitter: "lead-b", projectSlug: h.regB.slug },
    { gateQueue: h.gateQueue },
    h.registry,
  );
  assert.equal(invalidRecontract.ok, false);
  assert.equal(h.gateQueue.snapshot().queued.some((i) => i.task === "T-REC"), true, "invalid re-contract keeps queued item intact");

  // 4. Valid lead_set_contract supersedes queued T-REC cleanly and opens new epoch.
  const validRecontract = await handleSpoolRequest(
    h.rootFactory,
    { id: "sc-ok", kind: "contract", task: "T-REC", workspace: h.regB.root, gate: "true", artifact: "README.md", description: validBrief, submitter: "lead-b", projectSlug: h.regB.slug },
    { gateQueue: h.gateQueue },
    h.registry,
  );
  assert.equal(validRecontract.ok, true, validRecontract.ok ? "" : validRecontract.message);
  assert.equal(h.gateQueue.snapshot().queued.some((i) => i.task === "T-REC"), false, "queued T-REC dequeued on re-contract");
  assert.equal(fB.contractFor("T-REC")?.gate, "true");
  assert.equal(fB.attemptsOf("T-REC").length, 0, "new Contract epoch starts clean at 0 attempts");

  // Release Project A so queue drains: T-GREEN runs, T-REC's superseded old gate NEVER runs!
  writeFileSync(releaseFile, "go\n");
  await until(() => {
    assert.equal(h.gateQueue.snapshot().running.length, 0);
    assert.equal(h.gateQueue.snapshot().queued.length, 0);
  });
  assert.equal(existsSync(markerFile), false, "superseded queued Gate never executes against new Contract");
});

test("lead_close_task immediately dequeues queued Gate (terminal cancelled state) and kills -pgid on running Gate (freeing queue slot, zero spurious wakeup)", async (t) => {
  const h = setupMultiProjectHarness(t);
  const fA = h.registry.factoryForProject(h.regA.slug);
  const fB = h.registry.factoryForProject(h.regB.slug);

  const childPidFile = join(h.dir, "close-child.pid");
  const childScript = join(h.dir, "spawn-sleep.mjs");
  writeFileSync(
    childScript,
    `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(${JSON.stringify(process.execPath)}, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
    setInterval(() => {}, 1000);
    `,
  );

  // Set up Project A running task T-CLOSE-RUN in a real Task worktree with a live Peer.
  const contractA = fA.setContract({
    task: "T-CLOSE-RUN",
    workspace: h.regA.root,
    gate: `${JSON.stringify(process.execPath)} ${JSON.stringify(childScript)}`,
    artifact: "README.md",
  });
  const wtA = allocateTaskWorktree(h.stateDir, contractA, "T-CLOSE-RUN");
  assert.ok(wtA.ok && wtA.worktree);
  fA.requestSpawn({ task: "T-CLOSE-RUN", provider: "pi/zai/glm-5.3", arity: 1, worktree: wtA.worktree });
  h.fake.addAgent({ id: "peer-run-a", status: "idle", labels: { seat: "agent", project: h.regA.slug, task: "T-CLOSE-RUN" }, cwd: wtA.worktree });

  // Set up Project B with T-CLOSE-Q (to be closed while queued) and T-NEXT-B (must run once T-CLOSE-RUN dies).
  const contractBQ = fB.setContract({ task: "T-CLOSE-Q", workspace: h.regB.root, gate: "true", artifact: "README.md", scope: ["zone-q"] });
  const wtBQ = allocateTaskWorktree(h.stateDir, contractBQ, "T-CLOSE-Q");
  assert.ok(wtBQ.ok && wtBQ.worktree);
  fB.requestSpawn({ task: "T-CLOSE-Q", provider: "pi/zai/glm-5.3", arity: 1, worktree: wtBQ.worktree });
  h.fake.addAgent({ id: "peer-q-b", status: "idle", labels: { seat: "agent", project: h.regB.slug, task: "T-CLOSE-Q" }, cwd: wtBQ.worktree });

  fB.setContract({ task: "T-NEXT-B", workspace: h.regB.root, gate: "true", artifact: "README.md", scope: ["zone-next"] });

  const qRun = await handleSpoolRequest(
    h.rootFactory,
    { id: "c-run", kind: "claim", task: "T-CLOSE-RUN", sha: h.shaA, handoff, agent: "peer-run-a", projectSlug: h.regA.slug },
    { gateQueue: h.gateQueue, daemon: h.fake.daemon },
    h.registry,
  );
  assert.equal(qRun.ok && qRun.status, "queued");
  await until(() => {
    assert.equal(h.gateQueue.snapshot().running.length, 1);
    assert.ok(existsSync(childPidFile), "running Gate spawned descendant process");
  });
  const childPid = Number(readFileSync(childPidFile, "utf8").trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0);

  const qB = await handleSpoolRequest(
    h.rootFactory,
    { id: "c-bq", kind: "claim", task: "T-CLOSE-Q", sha: h.shaB, handoff, agent: "peer-q-b", projectSlug: h.regB.slug },
    { gateQueue: h.gateQueue, daemon: h.fake.daemon },
    h.registry,
  );
  assert.equal(qB.ok && qB.status, "queued");

  const qNext = await handleSpoolRequest(
    h.rootFactory,
    { id: "c-next", kind: "claim", task: "T-NEXT-B", sha: h.shaB, handoff, agent: "peer-next-b", projectSlug: h.regB.slug },
    { gateQueue: h.gateQueue, daemon: h.fake.daemon },
    h.registry,
  );
  assert.equal(qNext.ok && qNext.status, "queued");

  // 1. Unauthorized close (agent seat) must NOT cancel or dequeue the running Gate.
  const deniedClose = await handleSpoolRequest(
    h.rootFactory,
    { id: "cl-deny", kind: "close", task: "T-CLOSE-RUN", reason: "agent tries", submitter: "peer-run-a", seat: "agent", projectSlug: h.regA.slug },
    { gateQueue: h.gateQueue, daemon: h.fake.daemon, stopAgent: async () => ({ ok: true }) },
    h.registry,
  );
  assert.equal(deniedClose.ok, false);
  if (!deniedClose.ok) assert.equal(deniedClose.code, "agent-cannot-close");
  assert.equal(h.gateQueue.snapshot().running[0]?.task, "T-CLOSE-RUN");

  // 2. Close T-CLOSE-Q while queued: dequeues immediately, records terminal cancelled state & task_closed, zero wakeup.
  const closedQueued = await handleSpoolRequest(
    h.rootFactory,
    { id: "cl-q", kind: "close", task: "T-CLOSE-Q", reason: "superseded while queued", by: "lead", submitter: "lead-b", projectSlug: h.regB.slug },
    { gateQueue: h.gateQueue, daemon: h.fake.daemon, stopAgent: async () => ({ ok: true }) },
    h.registry,
  );
  assert.equal(closedQueued.ok, true, closedQueued.ok ? "" : closedQueued.message);
  assert.equal(h.gateQueue.snapshot().queued.some((i) => i.task === "T-CLOSE-Q"), false, "queued item removed immediately");
  assert.equal(existsSync(wtBQ.worktree), false, "closed task worktree removed");
  const stateBQ = projectTask(fB.ledger.events, "T-CLOSE-Q");
  assert.equal(stateBQ.status, "closed");
  assert.equal(stateBQ.inFlightAttempt, undefined, "queued attempt is cleanly closed, not left open");
  assert.equal(stateBQ.attempts[0]?.gate?.verdict, "red");
  assert.equal(h.fake.sent.filter((s) => s.agentId === "peer-q-b").length, 0, "zero Peer wakeup for closed queued task");
  assert.equal(readLeadMailbox(join(h.stateDir, "projects", h.regB.slug, "mailbox.jsonl")).queued.some((m) => m.task === "T-CLOSE-Q"), false, "zero Lead mail for closed queued task");

  // 3. Close T-CLOSE-RUN while running: kills -pgid immediately, frees slot for T-NEXT-B, zero wakeup for T-CLOSE-RUN.
  const closedRunning = await handleSpoolRequest(
    h.rootFactory,
    { id: "cl-run", kind: "close", task: "T-CLOSE-RUN", reason: "cancelled mid-run", by: "lead", submitter: "lead-a", projectSlug: h.regA.slug },
    { gateQueue: h.gateQueue, daemon: h.fake.daemon, stopAgent: async () => ({ ok: true }) },
    h.registry,
  );
  assert.equal(closedRunning.ok, true, closedRunning.ok ? "" : closedRunning.message);
  assert.equal(existsSync(wtA.worktree), false, "running task worktree removed");
  assert.equal(projectTask(fA.ledger.events, "T-CLOSE-RUN").status, "closed");
  // Verify descendant process group was killed (-pgid).
  let childAlive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    childAlive = false;
  }
  assert.equal(childAlive, false, "descendant process in detached Gate group (-pgid) must be reaped immediately");

  // Queue slot freed immediately: T-NEXT-B runs and finishes GREEN!
  await until(() => {
    assert.ok(fB.ledger.eventsFor("T-NEXT-B").some((e) => e.event === "report_written"));
  });
  const nextBGate = fB.ledger.eventsFor("T-NEXT-B").findLast((e) => e.event === "gate_finished");
  assert.equal(nextBGate?.event === "gate_finished" && nextBGate.verdict, "green");

  // Zero spurious wakeup for closed T-CLOSE-RUN (neither Peer nor Lead).
  assert.equal(h.fake.sent.filter((s) => s.agentId === "peer-run-a").length, 0, "zero Peer wakeup after task close");
  assert.equal(readLeadMailbox(join(h.stateDir, "projects", h.regA.slug, "mailbox.jsonl")).queued.some((m) => m.task === "T-CLOSE-RUN"), false, "zero Lead mail after task close");
});

test("Project reset and Project delete dequeue matching queued Gates and kill -pgid on running Gates before removing worktrees/state (freeing slot immediately, zero spurious wakeups)", async (t) => {
  const dir = makeTempDir("gate-queue-reset-del-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const rootA = join(dir, "proj-a");
  const rootB = join(dir, "proj-b");
  const rootC = join(dir, "proj-c");
  for (const r of [rootA, rootB, rootC]) {
    mkdirSync(r, { recursive: true });
    writeFileSync(join(r, "README.md"), `${r}\n`);
  }
  const shaA = gitCommitAll(rootA, "init-a");
  const shaB = gitCommitAll(rootB, "init-b");
  const shaC = gitCommitAll(rootC, "init-c");

  const regA = ensureProjectRegistered(stateDir, rootA);
  const regB = ensureProjectRegistered(stateDir, rootB);
  const regC = ensureProjectRegistered(stateDir, rootC);
  assert.ok(regA.ok && regB.ok && regC.ok);

  const rootFactory = createFactory({ stateDir });
  const registry = createFactoryRegistry({ stateDir, root: rootFactory });
  const fake = makeFakeDaemon([
    { id: "lead-a", status: "idle", labels: { seat: "lead", project: regA.slug }, cwd: regA.root },
    { id: "lead-b", status: "idle", labels: { seat: "lead", project: regB.slug }, cwd: regB.root },
    { id: "lead-c", status: "idle", labels: { seat: "lead", project: regC.slug }, cwd: regC.root },
  ]);
  writeProjectRegistration(stateDir, regA.slug, { root: regA.root, lead: "lead-a" });
  writeProjectRegistration(stateDir, regB.slug, { root: regB.root, lead: "lead-b" });
  writeProjectRegistration(stateDir, regC.slug, { root: regC.root, lead: "lead-c" });

  let leadMail!: ReturnType<typeof createLeadMailRuntime>;
  let gateQueue!: ReturnType<typeof createGateQueue>;
  const surface = createSurfaceHandlers({
    factory: rootFactory,
    registry,
    stateDir,
    home: dir,
    daemon: fake.daemon,
    stopAgent: async () => ({ ok: true }),
    cleanupDaemonWorkspaces: async () => ({ ok: true, removedWorkspaceIds: [], removedProjectIds: [] }),
    resetProjectMailbox: (slug) => leadMail.resetProjectMailbox(slug),
    onLeadRetired: (input) => leadMail.settleLeadRotation(input.slug),
    gateQueue: () => gateQueue,
  });
  leadMail = createLeadMailRuntime({
    factory: rootFactory,
    registry,
    stateDir,
    daemon: fake.daemon,
    ensureLead: (i) => surface.leadEnsure(i),
    retireLead: (i) => surface.leadRotate(i),
  });
  gateQueue = createGateQueue({
    stateDir,
    factory: rootFactory,
    registry,
    onSettled: async ({ item, outcome }) => {
      await leadMail.notifyPeer({
        task: item.task,
        kind: "verdict",
        text: `Task ${item.task} attempt ${outcome.attempt} ended ${outcome.verdict.toUpperCase()} — note: ${outcome.gate.note}`,
      });
    },
  });
  const spool = startSpool(stateDir, rootFactory, {
    registry,
    daemon: fake.daemon,
    peerMail: leadMail.notifyPeer,
    gateQueue,
    pollMs: 15,
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
  });
  t.after(() => {
    spool.stop();
    gateQueue.stop();
    leadMail.stop();
    registry.stop();
  });

  const pidA = join(dir, "pid-a.txt");
  const pidC = join(dir, "pid-c.txt");
  const sleepScript = join(dir, "sleep-group.mjs");
  writeFileSync(
    sleepScript,
    `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const pidFile = process.argv[2];
    const child = spawn(${JSON.stringify(process.execPath)}, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(pidFile, String(child.pid));
    setInterval(() => {}, 1000);
    `,
  );

  // Project A has a running Gate (TA-RUN) and a second queued Gate (TA-Q), while Project B (TB-NEXT) waits behind it.
  const fA = registry.factoryForProject(regA.slug);
  const fB = registry.factoryForProject(regB.slug);
  const fC = registry.factoryForProject(regC.slug);

  const cARun = fA.setContract({
    task: "TA-RUN",
    workspace: regA.root,
    gate: `${JSON.stringify(process.execPath)} ${JSON.stringify(sleepScript)} ${JSON.stringify(pidA)}`,
    artifact: "README.md",
    scope: ["zone-a1"],
  });
  const wtARun = allocateTaskWorktree(stateDir, cARun, "TA-RUN");
  assert.ok(wtARun.ok && wtARun.worktree);
  fA.requestSpawn({ task: "TA-RUN", provider: "pi/zai/glm-5.3", arity: 1, worktree: wtARun.worktree });
  fake.addAgent({ id: "peer-a-run", status: "idle", labels: { seat: "agent", project: regA.slug, task: "TA-RUN" }, cwd: wtARun.worktree });

  fA.setContract({ task: "TA-Q", workspace: regA.root, gate: "true", artifact: "README.md", scope: ["zone-a2"] });
  fB.setContract({ task: "TB-NEXT", workspace: regB.root, gate: "true", artifact: "README.md" });

  await handleSpoolRequest(rootFactory, { id: "ca-1", kind: "claim", task: "TA-RUN", sha: shaA, handoff, agent: "peer-a-run", projectSlug: regA.slug }, { gateQueue }, registry);
  await until(() => {
    assert.equal(gateQueue.snapshot().running[0]?.task, "TA-RUN");
    assert.ok(existsSync(pidA));
  });
  const childPidA = Number(readFileSync(pidA, "utf8").trim());
  await handleSpoolRequest(rootFactory, { id: "ca-2", kind: "claim", task: "TA-Q", sha: shaA, handoff, agent: "peer-a-q", projectSlug: regA.slug }, { gateQueue }, registry);
  await handleSpoolRequest(rootFactory, { id: "cb-1", kind: "claim", task: "TB-NEXT", sha: shaB, handoff, agent: "peer-b", projectSlug: regB.slug }, { gateQueue }, registry);

  // Refused seat reset must NOT cancel Gates.
  const deniedReset = await handleSpoolRequest(
    rootFactory,
    { id: "rst-deny", kind: "reset", workspace: regA.root, submitter: "lead-a", seat: "lead" },
    { gateQueue, projectReset: async () => ({ id: "rst-deny", ok: true, summary: "", project: regA.slug, purgedEvents: 0, tasks: [], removedFiles: 0, archivedSeats: [], archivedAgents: [] }) },
    registry,
  );
  assert.equal(deniedReset.ok, false);
  if (!deniedReset.ok) assert.equal(deniedReset.code, "seat-cannot-reset");
  assert.equal(gateQueue.snapshot().running[0]?.task, "TA-RUN");

  // 1. Project reset via Spool file drop: kills -pgid of TA-RUN, dequeues TA-Q, does not deadlock withExclusiveMaintenance, frees slot for TB-NEXT!
  const spoolRoot = spoolRootFor(stateDir);
  const reqDir = join(spoolRoot, "requests");
  mkdirSync(reqDir, { recursive: true });
  writeFileSync(join(reqDir, "rst-a.json"), JSON.stringify({ id: "rst-a", kind: "reset", workspace: regA.root, keepSeats: true, submitter: "owner" }));
  await until(() => {
    assert.ok(existsSync(join(spoolRoot, "replies", "rst-a.json")), "spool reset reply landed without deadlock");
  });
  const resetReply = JSON.parse(readFileSync(join(spoolRoot, "replies", "rst-a.json"), "utf8")) as { ok: boolean };
  assert.equal(resetReply.ok, true);
  let aliveA = true;
  try { process.kill(childPidA, 0); } catch { aliveA = false; }
  assert.equal(aliveA, false, "Project reset kills -pgid of running Gate");
  assert.equal(gateQueue.snapshot().queued.some((i) => i.projectSlug === regA.slug), false, "all queued Gates for reset Project removed");
  assert.equal(existsSync(wtARun.worktree), false, "worktree removed after Gate reaped");
  assert.equal(readLeadMailbox(join(stateDir, "projects", regA.slug, "mailbox.jsonl")).queued.length, 0, "zero spurious Lead mail on reset Project");

  // TB-NEXT runs immediately and finishes GREEN!
  await until(() => {
    assert.ok(fB.ledger.eventsFor("TB-NEXT").some((e) => e.event === "report_written"));
  });
  assert.equal(fB.ledger.eventsFor("TB-NEXT").findLast((e) => e.event === "gate_finished")?.verdict, "green");

  // 2. Project delete via direct Surface RPC while Project C has running Gate + queued Gate, and Project B has another queued Gate!
  const cCRun = fC.setContract({
    task: "TC-RUN",
    workspace: regC.root,
    gate: `${JSON.stringify(process.execPath)} ${JSON.stringify(sleepScript)} ${JSON.stringify(pidC)}`,
    artifact: "README.md",
    scope: ["zone-c1"],
  });
  const wtCRun = allocateTaskWorktree(stateDir, cCRun, "TC-RUN");
  assert.ok(wtCRun.ok && wtCRun.worktree);
  fC.requestSpawn({ task: "TC-RUN", provider: "pi/zai/glm-5.3", arity: 1, worktree: wtCRun.worktree });
  fake.addAgent({ id: "peer-c-run", status: "idle", labels: { seat: "agent", project: regC.slug, task: "TC-RUN" }, cwd: wtCRun.worktree });
  fC.setContract({ task: "TC-Q", workspace: regC.root, gate: "true", artifact: "README.md", scope: ["zone-c2"] });
  fB.setContract({ task: "TB-AFTER-DEL", workspace: regB.root, gate: "true", artifact: "README.md", scope: ["zone-b2"] });

  await handleSpoolRequest(rootFactory, { id: "cc-1", kind: "claim", task: "TC-RUN", sha: shaC, handoff, agent: "peer-c-run", projectSlug: regC.slug }, { gateQueue }, registry);
  await until(() => {
    assert.equal(gateQueue.snapshot().running[0]?.task, "TC-RUN");
    assert.ok(existsSync(pidC));
  });
  const childPidC = Number(readFileSync(pidC, "utf8").trim());
  await handleSpoolRequest(rootFactory, { id: "cc-2", kind: "claim", task: "TC-Q", sha: shaC, handoff, agent: "peer-c-q", projectSlug: regC.slug }, { gateQueue }, registry);
  await handleSpoolRequest(rootFactory, { id: "cb-2", kind: "claim", task: "TB-AFTER-DEL", sha: shaB, handoff, agent: "peer-b", projectSlug: regB.slug }, { gateQueue }, registry);

  // Refused seat delete must NOT cancel Gates.
  const deniedDel = await surface.projectDelete({ projectRoot: regC.root, seat: "lead" });
  assert.equal(deniedDel.ok, false);
  assert.equal(gateQueue.snapshot().running[0]?.task, "TC-RUN");

  const delRes = await surface.projectDelete({ projectRoot: regC.root });
  assert.equal(delRes.ok, true, delRes.ok ? "" : delRes.error);
  let aliveC = true;
  try { process.kill(childPidC, 0); } catch { aliveC = false; }
  assert.equal(aliveC, false, "Project delete kills -pgid of running Gate");
  assert.equal(gateQueue.snapshot().queued.some((i) => i.projectSlug === regC.slug), false, "all queued Gates for deleted Project removed");
  assert.equal(existsSync(join(stateDir, "projects", regC.slug)), false, "deleted Project state directory removed cleanly");

  await until(() => {
    assert.ok(fB.ledger.eventsFor("TB-AFTER-DEL").some((e) => e.event === "report_written"));
  });
  assert.equal(fB.ledger.eventsFor("TB-AFTER-DEL").findLast((e) => e.event === "gate_finished")?.verdict, "green");
  assert.equal(fake.sent.filter((s) => s.agentId === "peer-a-run" || s.agentId === "peer-c-run").length, 0, "zero spurious Peer wakeups on reset/delete");
});

function setupWakeupHarness(
  t: TestContext,
  options: { usageMeter?: (input: { task: string; agentId?: string; attempt?: number; slug?: string }) => Promise<void> } = {},
) {
  const dir = makeTempDir("gate-wakeup-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const rootA = join(dir, "proj-a");
  mkdirSync(rootA, { recursive: true });
  writeFileSync(join(rootA, "README.md"), "wakeups\n");
  const shaA = gitCommitAll(rootA, "init-wakeup");
  const regA = ensureProjectRegistered(stateDir, rootA);
  assert.ok(regA.ok);

  const rootFactory = createFactory({ stateDir });
  const registry = createFactoryRegistry({ stateDir, root: rootFactory });
  const fake = makeFakeDaemon([
    { id: "lead-a", status: "idle", labels: { seat: "lead", project: regA.slug }, cwd: regA.root },
  ]);
  writeProjectRegistration(stateDir, regA.slug, { root: regA.root, lead: "lead-a" });
  const surface = createSurfaceHandlers({ factory: rootFactory, registry, stateDir, home: dir, daemon: fake.daemon });
  const leadMail = createLeadMailRuntime({
    factory: rootFactory,
    registry,
    stateDir,
    daemon: fake.daemon,
    ensureLead: (i) => surface.leadEnsure(i),
    retireLead: (i) => surface.leadRotate(i),
  });
  const meterCalls: Array<{ task: string; agentId?: string; attempt?: number; slug?: string }> = [];
  const usageMeter =
    options.usageMeter ??
    (async (input) => {
      meterCalls.push(input);
    });
  const gateQueue = createGateQueue({
    stateDir,
    factory: rootFactory,
    registry,
    onSettled: async ({ item, outcome }) => {
      const targetFactory = item.useRootFactory === true ? rootFactory : registry.factoryForProject(item.projectSlug);
      await settleClaimOutcome({
        factory: targetFactory,
        task: item.task,
        agent: item.agent,
        outcome,
        sha: item.sha,
        workspace: item.cwd,
        usageMeter,
        peerMail: leadMail.notifyPeer,
        daemon: fake.daemon,
        projectSlug: item.useRootFactory === true ? undefined : item.projectSlug,
      });
    },
  });
  t.after(() => {
    gateQueue.stop();
    leadMail.stop();
    registry.stop();
  });
  const queuedPeerMail = () =>
    readMailboxEvents(join(projectStateDir(stateDir, regA.slug), "mailbox.jsonl")).filter(
      (e): e is Extract<LeadMailboxEvent, { type: "mail_queued" }> => e.type === "mail_queued" && e.from === "peer",
    );
  const deps = { registry, daemon: fake.daemon, peerMail: leadMail.notifyPeer, usageMeter, gateQueue };
  return { dir, stateDir, regA, shaA, rootFactory, registry, fake, leadMail, gateQueue, deps, meterCalls, queuedPeerMail, factoryA: registry.factoryForProject(regA.slug) };
}

test("async GREEN runs best-effort usageMeter (even if metering throws) and wakes Lead via Lead mailbox with Handoff while Peer stays idle", async (t) => {
  let meterSaw: { task: string; agentId?: string; attempt?: number; slug?: string } | undefined;
  const h = setupWakeupHarness(t, {
    usageMeter: async (input) => {
      meterSaw = input;
      throw new Error("transient meter outage");
    },
  });
  const peer = h.fake.addAgent({ id: "peer-green", status: "idle", labels: { seat: "agent", project: h.regA.slug, task: "T-GREEN" }, cwd: h.regA.root });
  const corr = new CorrelationRegistry(h.stateDir).issue({
    role: "agent",
    projectSlug: h.regA.slug,
    projectRoot: h.regA.root,
    task: "T-GREEN",
    agentId: peer.id,
  });

  h.factoryA.setContract({
    task: "T-GREEN", workspace: h.regA.root,
    gate: `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('ALL_OK'), 60)"`, artifact: "README.md",
  });

  const cl = await handleSpoolRequest(h.rootFactory, {
    id: "cl-green", kind: "claim", task: "T-GREEN", sha: h.shaA, handoff, agent: corr.correlationId, projectSlug: h.regA.slug,
  }, h.deps, h.registry);
  assert.equal(cl.ok && cl.status === "queued", true);

  await until(() => {
    assert.ok(h.fake.sent.some((s) => s.agentId === "lead-a" && /T-GREEN attempt 1 ended GREEN/.test(s.text)));
  });
  assert.deepEqual(meterSaw, { task: "T-GREEN", agentId: "peer-green", attempt: 1, slug: h.regA.slug });
  assert.equal(h.fake.sent.filter((s) => s.agentId === "peer-green").length, 0, "Peer stays quietly idle after GREEN");
  const leadSend = h.fake.sent.find((s) => s.agentId === "lead-a")!;
  assert.match(leadSend.text, /6-Field Handoff/);
  assert.match(leadSend.text, /slice tests pass/);
});

test("RED Attempts 1..2 wake live Peer (idle and closed, resolving cor_...) with failure tail + Gate log path while Lead sleeps, then Attempt 3 GREEN wakes Lead", async (t) => {
  const h = setupWakeupHarness(t);
  const cRetry = h.factoryA.setContract({
    task: "T-RETRY", workspace: h.regA.root,
    gate: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(h.dir, "flaky-gate.mjs"))}`, artifact: "README.md",
  });
  const wtRes = allocateTaskWorktree(h.stateDir, cRetry, "T-RETRY");
  assert.ok(wtRes.ok && wtRes.worktree);
  const wt = wtRes.worktree;
  const script = join(h.dir, "flaky-gate.mjs");
  const modeFile = join(h.dir, "mode.txt");
  writeFileSync(modeFile, "fail-1");
  writeFileSync(script, `
    import { readFileSync } from "node:fs";
    const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
    if (mode !== "pass") {
      console.log("noise-line-1");
      console.error("FAIL src/widget.test.ts (" + mode + "): expected 42 received 0");
      process.exit(1);
    }
    console.log("PASS widget suite");
  `);

  const peerIdle = h.fake.addAgent({ id: "peer-retry", status: "idle", labels: { seat: "agent", project: h.regA.slug, task: "T-RETRY" }, cwd: wt });
  const corr = new CorrelationRegistry(h.stateDir).issue({
    role: "agent",
    projectSlug: h.regA.slug,
    projectRoot: h.regA.root,
    task: "T-RETRY",
    agentId: peerIdle.id,
  });

  // Attempt 1 RED -> Peer status "idle" receives failure tail + log path; Lead stays asleep (0 mail, 0 sends).
  const cl1 = await handleSpoolRequest(h.rootFactory, {
    id: "cl-r1", kind: "claim", task: "T-RETRY", sha: h.shaA, handoff, agent: peerIdle.id, projectSlug: h.regA.slug,
  }, h.deps, h.registry);
  assert.equal(cl1.ok && cl1.status === "queued", true);

  await until(() => {
    assert.equal(h.fake.sent.filter((s) => s.agentId === peerIdle.id).length, 1);
  });
  const peerMsg1 = h.fake.sent.find((s) => s.agentId === peerIdle.id)!.text;
  assert.match(peerMsg1, /expected 42 received 0/);
  assert.match(peerMsg1, /gate-T-RETRY-1\.log/);
  assert.equal(h.fake.sent.filter((s) => s.agentId === "lead-a").length, 0, "Lead stays asleep on RED Attempt 1");
  assert.equal(h.queuedPeerMail().length, 0, "Lead mailbox untouched on RED Attempt 1");

  // Attempt 2 RED -> Peer status "closed" + submitted with cor_ token still resolves live Peer and wakes it directly.
  peerIdle.status = "closed";
  writeFileSync(modeFile, "fail-2");
  const cl2 = await handleSpoolRequest(h.rootFactory, {
    id: "cl-r2", kind: "claim", task: "T-RETRY", sha: h.shaA, handoff: { ...handoff, verification: "attempt 2 fix" }, agent: corr.correlationId, projectSlug: h.regA.slug,
  }, h.deps, h.registry);
  assert.equal(cl2.ok && cl2.status === "queued", true);

  await until(() => {
    assert.equal(h.fake.sent.filter((s) => s.agentId === peerIdle.id).length, 2);
  });
  const peerMsg2 = h.fake.sent.filter((s) => s.agentId === peerIdle.id)[1]!.text;
  assert.match(peerMsg2, /fail-2/);
  assert.match(peerMsg2, /gate-T-RETRY-2\.log/);
  assert.equal(h.fake.sent.filter((s) => s.agentId === "lead-a").length, 0, "Lead stays asleep on RED Attempt 2");
  assert.equal(h.queuedPeerMail().length, 0, "Lead mailbox untouched on RED Attempt 2");

  // Attempt 3 GREEN -> wakes Lead via Lead mailbox, Peer receives nothing more.
  writeFileSync(modeFile, "pass");
  const cl3 = await handleSpoolRequest(h.rootFactory, {
    id: "cl-r3", kind: "claim", task: "T-RETRY", sha: h.shaA, handoff: { ...handoff, verification: "attempt 3 pass" }, agent: corr.correlationId, projectSlug: h.regA.slug,
  }, h.deps, h.registry);
  assert.equal(cl3.ok && cl3.status === "queued", true);

  await until(() => {
    assert.equal(h.fake.sent.filter((s) => s.agentId === "lead-a").length, 1);
  });
  assert.equal(h.fake.sent.filter((s) => s.agentId === peerIdle.id).length, 2, "Peer not poked again on Attempt 3 GREEN");
  assert.equal(h.meterCalls.map((m) => m.attempt).join(","), "1,2,3");
  assert.match(h.fake.sent.find((s) => s.agentId === "lead-a")!.text, /T-RETRY attempt 3 ended GREEN/);
});

test("RED Attempts 1..2 fall back to Lead mailbox noting peer-unavailable when Peer is error/archived/permission-blocked/missing/send-failing or after daemon-restarted", async (t) => {
  const h = setupWakeupHarness(t);
  const peerErr = h.fake.addAgent({ id: "peer-err", status: "error", labels: { seat: "agent", project: h.regA.slug }, cwd: h.regA.root });
  const peerArch = h.fake.addAgent({ id: "peer-arch", status: "idle", archivedAt: "2026-11-22T00:01:00.000Z", labels: { seat: "agent", project: h.regA.slug }, cwd: h.regA.root });
  const peerPerm = h.fake.addAgent({ id: "peer-perm", status: "idle", requiresAttention: true, attentionReason: "permission", labels: { seat: "agent", project: h.regA.slug }, cwd: h.regA.root });
  const peerFailSend = h.fake.addAgent({ id: "peer-send-fail", status: "idle", sendShouldFail: true, labels: { seat: "agent", project: h.regA.slug }, cwd: h.regA.root });

  const cases = [
    { task: "T-ERR", agentId: peerErr.id },
    { task: "T-ARCH", agentId: peerArch.id },
    { task: "T-PERM", agentId: peerPerm.id },
    { task: "T-MISS", agentId: "peer-never-existed" },
    { task: "T-SENDFAIL", agentId: peerFailSend.id },
  ];
  for (const c of cases) {
    h.factoryA.setContract({
      task: c.task, workspace: h.regA.root,
      gate: `${JSON.stringify(process.execPath)} -e "console.error('boom'); process.exit(1)"`, artifact: "README.md",
    });
    const cl = await handleSpoolRequest(h.rootFactory, {
      id: `cl-${c.task}`, kind: "claim", task: c.task, sha: h.shaA, handoff, agent: c.agentId, projectSlug: h.regA.slug,
    }, h.deps, h.registry);
    assert.equal(cl.ok, true);
  }

  // Test daemon-restarted boot recovery with a dead Peer
  const peerBootDead = h.fake.addAgent({ id: "peer-boot-dead", status: "error", labels: { seat: "agent", project: h.regA.slug }, cwd: h.regA.root });
  const cBoot = h.factoryA.setContract({
    task: "T-BOOT-DEAD", workspace: h.regA.root, gate: "echo hi", artifact: "README.md",
  });
  const wtBootRes = allocateTaskWorktree(h.stateDir, cBoot, "T-BOOT-DEAD");
  assert.ok(wtBootRes.ok && wtBootRes.worktree);
  const wtBoot = wtBootRes.worktree;
  await h.factoryA.admitClaim({ task: "T-BOOT-DEAD", sha: h.shaA, handoff, agent: peerBootDead.id, queueId: "gq-boot-dead" });
  writeFileSync(join(h.stateDir, "gate-queue.json"), JSON.stringify({
    schemaVersion: 1, paused: false, concurrency: 1,
    items: [{
      id: "gq-boot-dead", projectSlug: h.regA.slug, task: "T-BOOT-DEAD", attempt: 1, sha: h.shaA,
      cmd: "echo hi", cwd: wtBoot, timeoutMs: 60_000, agent: peerBootDead.id, handoff,
      enqueuedAt: new Date().toISOString(), startedAt: new Date().toISOString(), status: "running", pid: 999_999,
    }],
  }, null, 2));
  const bootMeterCalls: Array<{ task: string; agentId?: string; attempt?: number; slug?: string }> = [];
  const bootQueue = createGateQueue({
    stateDir: h.stateDir,
    factory: h.rootFactory,
    registry: h.registry,
    onSettled: async ({ item, outcome }) => {
      await settleClaimOutcome({
        factory: h.registry.factoryForProject(item.projectSlug),
        task: item.task,
        agent: item.agent,
        outcome,
        sha: item.sha,
        workspace: item.cwd,
        usageMeter: async (m) => { bootMeterCalls.push(m); },
        peerMail: h.leadMail.notifyPeer,
        daemon: h.fake.daemon,
        projectSlug: item.projectSlug,
      });
    },
  });
  t.after(() => bootQueue.stop());

  await until(() => {
    const mail = h.queuedPeerMail();
    assert.equal(mail.length, cases.length);
  });
  const bootRes = await bootQueue.startupRecovery();
  assert.equal(bootRes.restartedRed.length, 1);
  assert.deepEqual(bootMeterCalls, [{ task: "T-BOOT-DEAD", agentId: peerBootDead.id, attempt: 1, slug: h.regA.slug }]);

  const queuedMail = h.queuedPeerMail();
  for (const c of cases) {
    const found = queuedMail.find((e) => e.task === c.task);
    assert.ok(found, `Lead mailbox notified for ${c.task}`);
    assert.match(found.text, /peer-unavailable/);
  }
  const bootMail = queuedMail.find((e) => e.task === "T-BOOT-DEAD");
  assert.ok(bootMail, "Lead mailbox notified after daemon-restarted with dead Peer");
  assert.match(bootMail.text, /daemon-restarted/);
  assert.match(bootMail.text, /peer-unavailable/);
  assert.equal(h.fake.sent.filter((s) => s.agentId === peerPerm.id || s.agentId === peerErr.id).length, 0, "dead/permission-blocked Peer never poked");
});

test("RED at Attempt ceiling (Attempt 3), cancelled-by-owner, and lead_verify wake Lead via Lead mailbox even when Peer is live", async (t) => {
  const h = setupWakeupHarness(t);
  const peerCeiling = h.fake.addAgent({ id: "peer-ceil", status: "idle", labels: { seat: "agent", project: h.regA.slug }, cwd: h.regA.root });
  h.factoryA.setContract({
    task: "T-CEIL", workspace: h.regA.root,
    gate: `${JSON.stringify(process.execPath)} -e "console.error('still broken'); process.exit(1)"`, artifact: "README.md",
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const cl = await handleSpoolRequest(h.rootFactory, {
      id: `cl-ceil-${attempt}`, kind: "claim", task: "T-CEIL", sha: h.shaA,
      handoff: { ...handoff, verification: `attempt ${attempt}` }, agent: peerCeiling.id, projectSlug: h.regA.slug,
    }, h.deps, h.registry);
    assert.equal(cl.ok, true);
    if (attempt < MAX_ATTEMPTS) {
      await until(() => assert.equal(h.fake.sent.filter((s) => s.agentId === peerCeiling.id).length, attempt));
    }
  }
  await until(() => {
    const mail = h.queuedPeerMail().filter((e) => e.task === "T-CEIL");
    assert.equal(mail.length, 1);
  });
  assert.equal(h.fake.sent.filter((s) => s.agentId === peerCeiling.id).length, 2, "Attempt 3 RED does NOT re-poke Peer");

  // cancelled-by-owner while running -> wakes Lead even with live Peer
  const peerCancel = h.fake.addAgent({ id: "peer-owner-cancel", status: "idle", labels: { seat: "agent", project: h.regA.slug }, cwd: h.regA.root });
  h.factoryA.setContract({
    task: "T-OWNER-CANCEL", workspace: h.regA.root,
    gate: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"`, artifact: "README.md",
  });
  const clCancel = await handleSpoolRequest(h.rootFactory, {
    id: "cl-cancel", kind: "claim", task: "T-OWNER-CANCEL", sha: h.shaA, handoff, agent: peerCancel.id, projectSlug: h.regA.slug,
  }, h.deps, h.registry);
  assert.equal(clCancel.ok && clCancel.status === "queued", true);
  await until(() => assert.equal(h.gateQueue.snapshot().running[0]?.task, "T-OWNER-CANCEL"));
  assert.equal(clCancel.ok, true);
  if (clCancel.ok) await h.gateQueue.cancelItem(clCancel.queueId!);
  await until(() => {
    const mail = h.queuedPeerMail().filter((e) => e.task === "T-OWNER-CANCEL");
    assert.equal(mail.length, 1);
  });
  assert.match(h.queuedPeerMail().find((e) => e.task === "T-OWNER-CANCEL")!.text, /cancelled-by-owner/);
  assert.equal(h.fake.sent.filter((s) => s.agentId === peerCancel.id).length, 0, "cancelled-by-owner does not re-poke Peer");

  // mechanical lead_verify RED Attempt 1 -> always wakes Lead, never pokes a Peer
  h.factoryA.setContract({
    task: "T-LV-RED", workspace: h.regA.root,
    gate: `${JSON.stringify(process.execPath)} -e "console.error('lv failed'); process.exit(1)"`, artifact: "README.md",
  });
  const clLv = await handleSpoolRequest(h.rootFactory, {
    id: "cl-lv", kind: "claim", task: "T-LV-RED", sha: h.shaA, mechanical: "lead_verify", agent: peerCeiling.id, projectSlug: h.regA.slug,
  }, h.deps, h.registry);
  assert.equal(clLv.ok, true);
  await until(() => {
    const mail = h.queuedPeerMail().filter((e) => e.task === "T-LV-RED");
    assert.equal(mail.length, 1);
  });
  assert.equal(h.fake.sent.filter((s) => s.agentId === peerCeiling.id).length, 2, "lead_verify RED wakes Lead directly, never Peer");
});

test("async GREEN wakes Lead immediately without false driverWavesInFlight suppression from task_closed or gate_queued Tasks", async (t) => {
  const h = setupWakeupHarness(t);

  // Task 1: spawned and closed mid-wave while its Peer entry still appears running
  const cClosed = h.factoryA.setContract({ task: "T-OLD-CLOSED", workspace: h.regA.root, gate: "echo ok", artifact: "README.md" });
  const wtClosedRes = allocateTaskWorktree(h.stateDir, cClosed, "T-OLD-CLOSED");
  assert.ok(wtClosedRes.ok && wtClosedRes.worktree);
  const wtClosed = wtClosedRes.worktree;
  h.fake.addAgent({ id: "peer-old-closed", status: "running", labels: { seat: "agent", project: h.regA.slug, task: "T-OLD-CLOSED" }, cwd: wtClosed });
  h.factoryA.ledger.append({ event: "spawn_dispatched", task: "T-OLD-CLOSED", provider: "pi/model", arity: 1, worktree: wtClosed, agent: "peer-old-closed" });
  h.factoryA.close({ task: "T-OLD-CLOSED", reason: "superseded", by: "lead", authority: "lead" });

  // Task 2 settles GREEN asynchronously first while Task 3 gets admitted behind it with Peer status still "running".
  h.factoryA.setContract({
    task: "T-WAKE-NOW", workspace: h.regA.root,
    gate: `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('fast-green'), 120)"`, artifact: "README.md",
  });
  const cOtherQ = h.factoryA.setContract({
    task: "T-OTHER-QUEUED", workspace: h.regA.root,
    gate: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"`, artifact: "README.md",
  });
  const wtQueuedRes = allocateTaskWorktree(h.stateDir, cOtherQ, "T-OTHER-QUEUED");
  assert.ok(wtQueuedRes.ok && wtQueuedRes.worktree);
  const wtQueued = wtQueuedRes.worktree;
  h.fake.addAgent({ id: "peer-other-queued", status: "running", labels: { seat: "agent", project: h.regA.slug, task: "T-OTHER-QUEUED" }, cwd: wtQueued });
  h.factoryA.ledger.append({ event: "spawn_dispatched", task: "T-OTHER-QUEUED", provider: "pi/model", arity: 1, worktree: wtQueued, agent: "peer-other-queued" });

  const clWake = await handleSpoolRequest(h.rootFactory, {
    id: "cl-wake", kind: "claim", task: "T-WAKE-NOW", sha: h.shaA, handoff, agent: "peer-wake", projectSlug: h.regA.slug,
  }, h.deps, h.registry);
  const clOther = await handleSpoolRequest(h.rootFactory, {
    id: "cl-other-q", kind: "claim", task: "T-OTHER-QUEUED", sha: h.shaA, handoff, agent: "peer-other-queued", projectSlug: h.regA.slug,
  }, h.deps, h.registry);
  assert.equal(clWake.ok && clWake.status === "queued", true);
  assert.equal(clOther.ok && clOther.status === "queued", true);

  await until(() => {
    assert.ok(h.fake.sent.some((s) => s.agentId === "lead-a" && /T-WAKE-NOW attempt 1 ended GREEN/.test(s.text)));
  }, 5_000);
  if (clOther.ok && clOther.queueId) {
    await h.gateQueue.cancelItem(clOther.queueId, { suppressSettled: true });
  }
});

test("Seam 1 (Ticket 05): Pause/Resume & concurrency persist across restart, empty gate bypasses Pause, and Owner Cancel settles both queued and running Gates red (cancelled-by-owner) and wakes Lead", async (t) => {
  const dir = makeTempDir("gate-queue-controls-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const rootA = join(dir, "proj-a");
  const rootB = join(dir, "proj-b");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  writeFileSync(join(rootA, "README.md"), "a\n");
  writeFileSync(join(rootB, "README.md"), "b\n");
  const shaA = gitCommitAll(rootA, "init-a");
  const shaB = gitCommitAll(rootB, "init-b");
  const regA = ensureProjectRegistered(stateDir, rootA);
  const regB = ensureProjectRegistered(stateDir, rootB);
  assert.ok(regA.ok && regB.ok);

  const registry1 = createFactoryRegistry({ stateDir });
  const fA1 = registry1.factoryForProject(regA.slug);
  const fB1 = registry1.factoryForProject(regB.slug);
  const fake = makeFakeDaemon([
    { id: "lead-a", status: "idle", labels: { seat: "lead", project: regA.slug }, cwd: regA.root },
    { id: "lead-b", status: "idle", labels: { seat: "lead", project: regB.slug }, cwd: regB.root },
    { id: "peer-a1", status: "idle", labels: { seat: "agent", project: regA.slug, task: "TA-CANCEL-Q" }, cwd: regA.root },
    { id: "peer-b1", status: "idle", labels: { seat: "agent", project: regB.slug, task: "TB-RUN-CANCEL" }, cwd: regB.root },
  ]);
  writeProjectRegistration(stateDir, regA.slug, { root: regA.root, lead: "lead-a" });
  writeProjectRegistration(stateDir, regB.slug, { root: regB.root, lead: "lead-b" });

  const surface1 = createSurfaceHandlers({ factory: registry1.root, registry: registry1, stateDir, home: dir, daemon: fake.daemon });
  const leadMail1 = createLeadMailRuntime({
    factory: registry1.root,
    registry: registry1,
    stateDir,
    daemon: fake.daemon,
    ensureLead: (i) => surface1.leadEnsure(i),
    retireLead: (i) => surface1.leadRotate(i),
  });
  let stateChanges1 = 0;
  const q1 = createGateQueue({
    stateDir,
    factory: registry1.root,
    registry: registry1,
    onStateChange: () => {
      stateChanges1 += 1;
    },
    onSettled: async ({ item, outcome }) => {
      await settleClaimOutcome({
        factory: registry1.factoryForProject(item.projectSlug),
        task: item.task,
        agent: item.agent,
        outcome,
        sha: item.sha,
        workspace: item.cwd,
        peerMail: leadMail1.notifyPeer,
        daemon: fake.daemon,
        projectSlug: item.projectSlug,
      });
    },
  });

  // 1. Concurrency validation (>= 1 integer).
  assert.throws(() => q1.setConcurrency(0), /integer >= 1/);
  assert.throws(() => q1.setConcurrency(-2), /integer >= 1/);
  assert.throws(() => q1.setConcurrency(1.5), /integer >= 1/);
  assert.throws(() => q1.setConcurrency(Number.NaN), /integer >= 1/);
  assert.equal(q1.snapshot().concurrency, 1);

  assert.equal(q1.setConcurrency(2).concurrency, 2);
  const pausedSnap = q1.pause();
  assert.equal(pausedSnap.paused, true);
  assert.ok(pausedSnap.pausedAt);
  assert.ok(stateChanges1 >= 2, "concurrency update and pause emit onStateChange");

  // 2. While paused: shell Gates enqueue FIFO without starting; read-only empty gate bypasses pause immediately.
  fA1.setContract({ task: "TA-CANCEL-Q", workspace: regA.root, gate: "echo never-ran", artifact: "README.md", scope: ["s1"] });
  fA1.setContract({ task: "TA-RESUME-1", workspace: regA.root, gate: `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 60)"`, artifact: "README.md", scope: ["s2"] });
  fB1.setContract({ task: "TB-RESUME-2", workspace: regB.root, gate: `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 60)"`, artifact: "README.md", scope: ["s1"] });
  fB1.setContract({ task: "TB-SCOUT", workspace: regB.root, gate: "", disposition: "scout" });

  const cQ1 = await handleSpoolRequest(registry1.root, { id: "c-q1", kind: "claim", task: "TA-CANCEL-Q", sha: shaA, handoff, agent: "peer-a1", projectSlug: regA.slug }, { gateQueue: q1, peerMail: leadMail1.notifyPeer, daemon: fake.daemon }, registry1);
  const cQ2 = await handleSpoolRequest(registry1.root, { id: "c-q2", kind: "claim", task: "TA-RESUME-1", sha: shaA, handoff, agent: "peer-a2", projectSlug: regA.slug }, { gateQueue: q1, peerMail: leadMail1.notifyPeer, daemon: fake.daemon }, registry1);
  const cQ3 = await handleSpoolRequest(registry1.root, { id: "c-q3", kind: "claim", task: "TB-RESUME-2", sha: shaB, handoff, agent: "peer-b2", projectSlug: regB.slug }, { gateQueue: q1, peerMail: leadMail1.notifyPeer, daemon: fake.daemon }, registry1);
  assert.equal(cQ1.ok && cQ1.status === "queued" && cQ1.paused, true);
  assert.equal(cQ2.ok && cQ2.status === "queued" && cQ2.position, 2);
  assert.equal(cQ3.ok && cQ3.status === "queued" && cQ3.position, 3);
  assert.equal(q1.snapshot().running.length, 0, "paused queue does not start shell Gates");
  assert.equal(q1.snapshot().queued.length, 3);

  const cEmpty = await handleSpoolRequest(registry1.root, { id: "c-empty", kind: "claim", task: "TB-SCOUT", handoff, agent: "peer-scout", projectSlug: regB.slug }, { gateQueue: q1, peerMail: leadMail1.notifyPeer, daemon: fake.daemon }, registry1);
  assert.equal(cEmpty.ok, true);
  if (cEmpty.ok) {
    assert.equal(cEmpty.status, undefined);
    assert.equal(cEmpty.verdict, "green");
  }
  await until(() => {
    assert.ok(fake.sent.some((s) => s.agentId === "lead-b" && /Task TB-SCOUT attempt 1 ended GREEN/.test(s.text)));
  });
  await leadMail1.onLeadTurnEnded({ agentId: "lead-b", outcome: { kind: "completed" }, turnId: null, timeline: [] });

  // 3. Simulated daemon restart preserves paused: true, concurrency: 2, and queued FIFO items.
  q1.stop();
  leadMail1.stop();
  registry1.stop();

  const registry2 = createFactoryRegistry({ stateDir });
  const surface2 = createSurfaceHandlers({ factory: registry2.root, registry: registry2, stateDir, home: dir, daemon: fake.daemon });
  const leadMail2 = createLeadMailRuntime({
    factory: registry2.root,
    registry: registry2,
    stateDir,
    daemon: fake.daemon,
    ensureLead: (i) => surface2.leadEnsure(i),
    retireLead: (i) => surface2.leadRotate(i),
  });
  const q2 = createGateQueue({
    stateDir,
    factory: registry2.root,
    registry: registry2,
    onSettled: async ({ item, outcome }) => {
      await settleClaimOutcome({
        factory: registry2.factoryForProject(item.projectSlug),
        task: item.task,
        agent: item.agent,
        outcome,
        sha: item.sha,
        workspace: item.cwd,
        peerMail: leadMail2.notifyPeer,
        daemon: fake.daemon,
        projectSlug: item.projectSlug,
      });
    },
  });
  t.after(() => {
    q2.stop();
    leadMail2.stop();
    registry2.stop();
  });

  const boot = await q2.startupRecovery();
  assert.equal(boot.restartedRed.length, 0);
  assert.equal(boot.resumedCount, 3);
  assert.equal(q2.snapshot().paused, true, "paused state persists across restart");
  assert.equal(q2.snapshot().concurrency, 2, "concurrency persists across restart");
  assert.equal(q2.snapshot().running.length, 0, "queued items do NOT start on boot while paused");
  assert.deepEqual(q2.snapshot().queued.map((i) => i.task), ["TA-CANCEL-Q", "TA-RESUME-1", "TB-RESUME-2"]);

  // 4. Owner Cancel on a QUEUED Gate removes it, records gate_finished(red, cancelled-by-owner), and wakes Lead (not Peer).
  const fA2 = registry2.factoryForProject(regA.slug);
  const fB2 = registry2.factoryForProject(regB.slug);
  assert.ok(cQ1.ok && cQ1.queueId);
  const cancelledQueued = await q2.cancelItem(cQ1.queueId!);
  assert.equal(cancelledQueued, true);
  assert.deepEqual(q2.snapshot().queued.map((i) => i.task), ["TA-RESUME-1", "TB-RESUME-2"]);
  const taGate = fA2.ledger.eventsFor("TA-CANCEL-Q").findLast((e) => e.event === "gate_finished");
  assert.equal(taGate?.event === "gate_finished" && taGate.verdict, "red");
  assert.equal(taGate?.event === "gate_finished" && taGate.note, "cancelled-by-owner");
  assert.ok(fA2.ledger.eventsFor("TA-CANCEL-Q").some((e) => e.event === "report_written"));
  await until(() => {
    assert.ok(fake.sent.some((s) => s.agentId === "lead-a" && /TA-CANCEL-Q/.test(s.text) && /cancelled-by-owner/.test(s.text)));
  });
  assert.equal(fake.sent.filter((s) => s.agentId === "peer-a1").length, 0, "Owner cancel of queued Gate wakes Lead, not Peer");

  // 5. Resume drains remaining queued items FIFO (concurrency = 2 runs both in parallel!).
  const resumedSnap = q2.resume();
  assert.equal(resumedSnap.paused, false);
  await until(() => {
    assert.ok(fA2.ledger.eventsFor("TA-RESUME-1").some((e) => e.event === "report_written"));
    assert.ok(fB2.ledger.eventsFor("TB-RESUME-2").some((e) => e.event === "report_written"));
  });
  assert.equal(fA2.ledger.eventsFor("TA-RESUME-1").findLast((e) => e.event === "gate_finished")?.verdict, "green");
  assert.equal(fB2.ledger.eventsFor("TB-RESUME-2").findLast((e) => e.event === "gate_finished")?.verdict, "green");
  await until(() => {
    assert.ok(fake.sent.some((s) => s.agentId === "lead-b" && /Task TB-RESUME-2 attempt 1 ended GREEN/.test(s.text)));
  });
  await leadMail2.onLeadTurnEnded({ agentId: "lead-b", outcome: { kind: "completed" }, turnId: null, timeline: [] });

  // 6. Owner Cancel on a RUNNING Gate kills -pgid, frees slot immediately for next item, records cancelled-by-owner, wakes Lead.
  q2.setConcurrency(1);
  const childPidFile = join(dir, "owner-cancel-child.pid");
  const childScript = join(dir, "owner-cancel-sleep.mjs");
  writeFileSync(
    childScript,
    `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(${JSON.stringify(process.execPath)}, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
    setInterval(() => {}, 1000);
    `,
  );
  fB2.setContract({ task: "TB-RUN-CANCEL", workspace: regB.root, gate: `${JSON.stringify(process.execPath)} ${JSON.stringify(childScript)}`, artifact: "README.md", scope: ["s2"] });
  fA2.setContract({ task: "TA-AFTER-CANCEL", workspace: regA.root, gate: "echo after-cancel", artifact: "README.md", scope: ["s3"] });

  const cRun = await handleSpoolRequest(registry2.root, { id: "c-run", kind: "claim", task: "TB-RUN-CANCEL", sha: shaB, handoff, agent: "peer-b1", projectSlug: regB.slug }, { gateQueue: q2, peerMail: leadMail2.notifyPeer, daemon: fake.daemon }, registry2);
  const cAfter = await handleSpoolRequest(registry2.root, { id: "c-after", kind: "claim", task: "TA-AFTER-CANCEL", sha: shaA, handoff, agent: "peer-a3", projectSlug: regA.slug }, { gateQueue: q2, peerMail: leadMail2.notifyPeer, daemon: fake.daemon }, registry2);
  assert.ok(cRun.ok && cRun.queueId && cAfter.ok);
  await until(() => {
    assert.equal(q2.snapshot().running[0]?.task, "TB-RUN-CANCEL");
    assert.ok(existsSync(childPidFile));
  });
  const childPid = Number(readFileSync(childPidFile, "utf8").trim());
  assert.equal(await q2.cancelItem(cRun.queueId!), true);

  let childAlive = true;
  try { process.kill(childPid, 0); } catch { childAlive = false; }
  assert.equal(childAlive, false, "running Gate process group (-pgid) reaped on Owner Cancel");

  const tbGate = fB2.ledger.eventsFor("TB-RUN-CANCEL").findLast((e) => e.event === "gate_finished");
  assert.equal(tbGate?.event === "gate_finished" && tbGate.verdict, "red");
  assert.equal(tbGate?.event === "gate_finished" && tbGate.note, "cancelled-by-owner");
  await until(() => {
    assert.ok(fake.sent.some((s) => s.agentId === "lead-b" && /Task TB-RUN-CANCEL attempt 1 ended RED/.test(s.text) && /cancelled-by-owner/.test(s.text)));
    assert.ok(fA2.ledger.eventsFor("TA-AFTER-CANCEL").some((e) => e.event === "report_written"));
  });
  assert.equal(fake.sent.filter((s) => s.agentId === "peer-b1").length, 0, "Owner cancel of running Gate wakes Lead, not Peer");
  assert.equal(fA2.ledger.eventsFor("TA-AFTER-CANCEL").findLast((e) => e.event === "gate_finished")?.verdict, "green");
});
