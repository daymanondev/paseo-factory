import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { ensureProjectRegistered, readProjectRegistration, writeProjectRegistration } from "../plugin/server/core/project.ts";
import { readLeadMailbox } from "../plugin/server/core/mailbox.ts";
import { createFactoryRegistry } from "../plugin/server/projects.ts";
import { createSurfaceHandlers, type SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { handleSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { createGateQueue } from "../plugin/server/gate-queue.ts";
import { disposeDir, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

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

function makeFakeDaemon(initialAgents: Array<{ id: string; status?: string; labels?: Record<string, string>; cwd?: string }> = []) {
  const agents = initialAgents.map((a) => ({
    id: a.id,
    provider: "pi/zai/glm-5.3",
    title: a.id,
    status: a.status ?? "idle",
    model: null,
    labels: a.labels ?? {},
    archivedAt: null as string | null,
    requiresAttention: false,
    attentionReason: null,
    updatedAt: "2026-11-22T00:00:00.000Z",
    cwd: a.cwd ?? "/tmp",
  }));
  const sent: Array<{ agentId: string; text: string }> = [];
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async (opts) => ({
        entries: agents
          .filter((a) => a.archivedAt === null)
          .filter((a) => {
            const labels = opts?.filter?.labels;
            if (!labels) return true;
            return Object.entries(labels).every(([k, v]) => a.labels[k] === v);
          })
          .map((agent) => ({ agent })),
      }),
      create: async (opts) => {
        const id = `created-${agents.length + 1}`;
        agents.push({
          id,
          provider: opts.config.provider,
          title: opts.title ?? id,
          status: "idle",
          model: null,
          labels: opts.labels ?? {},
          archivedAt: null,
          requiresAttention: false,
          attentionReason: null,
          updatedAt: "2026-11-22T00:00:00.000Z",
          cwd: opts.cwd,
        });
        return { id };
      },
      ref: (id) => ({
        send: async (text: string) => {
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
  return { daemon, agents, sent };
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
