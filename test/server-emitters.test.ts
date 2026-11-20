import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import contribute from "../plugin/index.server.ts";
import { createFactory } from "../plugin/server/core/factory.ts";
import { Ledger } from "../plugin/server/core/ledger.ts";
import { deliverLeadMail, enqueueLeadMail, projectStateDir } from "../src/index.ts";
import {
  createFactoryRegistry,
  ensureProjectRegistered,
  factoryRegistryFor,
  resolveProject,
  writeProjectRegistration,
  type LedgerMutateEvent,
} from "../plugin/server/projects.ts";
import { createSurfaceHandlers, registerSurfaceRpc, type SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { onHandoffProgressChange, readHandoffProgress, writeHandoffProgress } from "../plugin/server/handoff-progress.ts";
import { createLeadMailRuntime, type LeadMailboxStateChange } from "../plugin/server/lead-mailbox.ts";
import type { HandoffProgress } from "../plugin/shared/handoff.ts";
import type { StateUpdateEvent } from "../plugin/server/state-hub.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for condition");
    await wait(15);
  }
}

function makeGitProject(dir: string, name: string): { root: string; slug: string } {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), `${name}\n`, "utf8");
  gitCommitAll(root);
  const resolved = resolveProject(root);
  assert.ok(resolved.ok);
  return { root, slug: resolved.slug };
}

function makeFakeDaemon(initialAgents: Array<{
  id: string;
  title?: string;
  status?: string;
  provider?: string;
  labels?: Record<string, string>;
  cwd?: string;
}> = []) {
  const agents = [...initialAgents];
  const sent: Array<{ agentId: string; text: string }> = [];
  const created: Array<{ id: string; cwd: string; labels: Record<string, string> }> = [];

  const daemon: SurfaceDaemonApi & {
    agents: SurfaceDaemonApi["agents"] & {
      subscribe: (handler: (update: unknown) => void) => () => void;
    };
    providers: SurfaceDaemonApi["providers"] & {
      subscribe: (handler: (update: unknown) => void) => () => void;
    };
  } = {
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
              requiresAttention: false,
              attentionReason: null,
              updatedAt: "2026-11-17T00:00:00.000Z",
              cwd: agent.cwd ?? "/tmp",
              lastUsage: null,
            },
          })),
          subscription: { release: async () => {} },
        };
      },
      create: async (options) => {
        const id = `agent-${created.length + 1}`;
        created.push({ id, cwd: options.cwd, labels: options.labels ?? {} });
        agents.push({
          id,
          title: options.title ?? undefined,
          provider: options.config.provider,
          labels: options.labels,
          cwd: options.cwd,
        });
        return { id };
      },
      ref: (id: string) => ({
        send: async (text: string) => {
          sent.push({ agentId: id, text });
        },
        archive: async () => {
          const idx = agents.findIndex((agent) => agent.id === id);
          if (idx !== -1) agents.splice(idx, 1);
          return { archivedAt: new Date().toISOString() };
        },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
      subscribe: () => () => {},
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "pi", available: true }] }),
      listModels: async () => ({ models: [] }),
      subscribe: () => () => {},
    },
  };
  return { daemon, agents, sent, created };
}

test("projects.ts: onLedgerMutate wraps root and per-project ledgers, unwraps on evict/stop, and preserves optional default", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const projA = makeGitProject(dir, "repo-a");
  const projB = makeGitProject(dir, "repo-b");
  ensureProjectRegistered(stateDir, projA.root);
  ensureProjectRegistered(stateDir, projB.root);

  const events: LedgerMutateEvent[] = [];
  const registry = createFactoryRegistry({
    stateDir,
    onLedgerMutate: (event) => events.push(event),
  });
  t.after(() => registry.stop());
  registry.root.history.start();

  // Root ledger mutations carry no projectSlug.
  registry.root.history.runSync(() => {
    registry.root.ledger.append({ event: "attempt_accepted", task: "ROOT-1", attempt: 1 });
    registry.root.ledger.purgeWhere((evt) => "task" in evt && evt.task === "ROOT-1");
  });
  await registry.root.history.withExclusiveMaintenance(() => {
    const raw = readFileSync(registry.root.ledger.path, "utf8");
    registry.root.ledger.activateHistory(raw, { writerId: registry.root.ledger.writerId ?? null });
    registry.root.ledger.refreshHistoryFromDisk({ writerId: registry.root.ledger.writerId ?? null });
  });

  assert.deepEqual(
    events.splice(0, events.length),
    [
      { method: "append" },
      { method: "purgeWhere" },
      { method: "activateHistory" },
      { method: "refreshHistoryFromDisk" },
    ],
  );

  // Per-project ledger mutations carry projectSlug.
  const factoryA = registry.factoryForProject(projA.slug);
  const factoryB = registry.factoryForProject(projB.slug);

  factoryA.history.runSync(() => {
    factoryA.ledger.append({ event: "attempt_accepted", task: "A-1", attempt: 1 });
    factoryA.ledger.purgeWhere((evt) => "task" in evt && evt.task === "A-1");
  });
  await factoryA.history.withExclusiveMaintenance(() => {
    const raw = readFileSync(factoryA.ledger.path, "utf8");
    factoryA.ledger.activateHistory(raw, { writerId: factoryA.ledger.writerId ?? null });
    factoryA.ledger.refreshHistoryFromDisk({ writerId: factoryA.ledger.writerId ?? null });
  });

  assert.deepEqual(
    events.splice(0, events.length),
    [
      { projectSlug: projA.slug, method: "append" },
      { projectSlug: projA.slug, method: "purgeWhere" },
      { projectSlug: projA.slug, method: "activateHistory" },
      { projectSlug: projA.slug, method: "refreshHistoryFromDisk" },
    ],
  );

  // evict(projA) unwraps factoryA's ledger while leaving root and factoryB wrapped.
  const evicted = registry.evict(projA.slug);
  assert.equal(evicted, factoryA);
  for (const method of ["append", "purgeWhere", "activateHistory", "refreshHistoryFromDisk"] as const) {
    assert.equal(Object.getOwnPropertyDescriptor(factoryA.ledger, method), undefined);
    assert.equal(factoryA.ledger[method], Ledger.prototype[method]);
  }
  assert.equal(events.length, 0);

  factoryB.history.runSync(() => {
    factoryB.ledger.append({ event: "attempt_accepted", task: "B-1", attempt: 1 });
  });
  assert.deepEqual(events.splice(0, events.length), [{ projectSlug: projB.slug, method: "append" }]);

  // stop() unwraps root and remaining project factories.
  registry.stop();
  for (const method of ["append", "purgeWhere", "activateHistory", "refreshHistoryFromDisk"] as const) {
    assert.equal(Object.getOwnPropertyDescriptor(registry.root.ledger, method), undefined);
    assert.equal(registry.root.ledger[method], Ledger.prototype[method]);
    assert.equal(Object.getOwnPropertyDescriptor(factoryB.ledger, method), undefined);
    assert.equal(factoryB.ledger[method], Ledger.prototype[method]);
  }
  assert.equal(events.length, 0);

  // Optional default: omitting onLedgerMutate works with no wrapper installed.
  const plainStateDir = join(dir, "state-plain");
  ensureProjectRegistered(plainStateDir, projA.root);
  const plainRegistry = createFactoryRegistry({ stateDir: plainStateDir });
  t.after(() => plainRegistry.stop());
  const plainA = plainRegistry.factoryForProject(projA.slug);
  plainA.history.runSync(() => {
    const appended = plainA.ledger.append({ event: "attempt_accepted", task: "PLAIN-1", attempt: 1 });
    assert.equal(appended.event, "attempt_accepted");
  });
});

test("surface-rpc.ts: onStateChange fires after non-read handler completion, skips reads/failures, and keeps { handle } test doubles intact", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const projA = makeGitProject(dir, "repo-a");
  ensureProjectRegistered(stateDir, projA.root);

  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  factory.history.start();
  t.after(() => factory.history.stop());

  const { daemon } = makeFakeDaemon();
  const changes: Array<{ handler: string; projectSlug?: string; projectRoot?: string }> = [];

  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon,
    onStateChange: (event) => changes.push(event),
  });

  // Read handlers (like snapshot, seatsDirectory, cachedProviders) must not emit.
  const snap = await handlers.snapshot({ projectRoot: projA.root });
  assert.equal(snap.ok, true);
  const seats = await handlers.seatsDirectory({});
  assert.equal(seats.ok, true);
  assert.equal(changes.length, 0);

  // Non-read project-scoped handler emits after completion with projectRoot.
  const laneRes = await handlers.lanesSet({
    lane: "lead",
    value: "pi/zai/glm-5.3",
    projectRoot: projA.root,
  });
  assert.equal(laneRes.ok, true);
  assert.deepEqual(changes.splice(0, changes.length), [
    { handler: "lanesSet", projectRoot: projA.root },
  ]);

  // Non-read handler returning slug/projectRoot extracts both.
  const leadRes = await handlers.leadEnsure({ projectRoot: projA.root });
  assert.equal(leadRes.ok, true);
  assert.deepEqual(changes.splice(0, changes.length), [
    { handler: "leadEnsure", projectSlug: projA.slug, projectRoot: realpathSync(projA.root) },
  ]);

  // Global non-read handler emits without project target.
  const profileRes = await handlers.profilesSave({
    name: "Fast",
    lanes: {
      supervisor: "pi/zai/glm-5.3",
      lead: "pi/zai/glm-5.3",
      worker: "pi/zai/glm-5.3",
      watch: "pi/zai/glm-5.3",
      freshEyes: "pi/zai/glm-5.3",
    },
  });
  assert.equal(profileRes.ok, true);
  assert.deepEqual(changes.splice(0, changes.length), [{ handler: "profilesSave" }]);

  // Rejected handler invocation must not emit onStateChange.
  await assert.rejects(() => handlers.profilesSave(undefined as never));
  assert.equal(changes.length, 0);

  // Optional default + { handle } test double compatibility.
  const plainHandlers = createSurfaceHandlers({ factory, stateDir, home, daemon });
  const registered: string[] = [];
  registerSurfaceRpc(
    {
      handle: (rpc: { name: string }) => {
        registered.push(rpc.name);
      },
    } as never,
    plainHandlers,
  );
  assert.ok(registered.includes("factory.snapshot"));
  assert.ok(registered.includes("factory.lanes.set"));
  const plainLane = await plainHandlers.lanesSet({ lane: "worker", value: "pi/zai/glm-5.3", projectRoot: projA.root });
  assert.equal(plainLane.ok, true);
});

test("handoff-progress.ts: onHandoffProgressChange notifies on write and clear, supports unsubscribe, and ignores listener errors", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const slug = "proj-handoff-111111";
  mkdirSync(projectStateDir(stateDir, slug), { recursive: true });

  const now = new Date().toISOString();
  const progress: HandoffProgress = {
    seat: "lead",
    reason: "owner",
    state: "scheduled",
    fromLane: { provider: "pi", model: "glm-5.3" },
    toLane: { provider: "pi", model: "glm-5.3" },
    startedAt: now,
    updatedAt: now,
  };

  // Zero listeners still writes/clears normally.
  writeHandoffProgress(stateDir, slug, progress);
  assert.equal(readHandoffProgress(stateDir, slug, "lead")?.state, "scheduled");
  writeHandoffProgress(stateDir, slug, null);
  assert.equal(readHandoffProgress(stateDir, slug, "lead"), null);

  const received: Array<{ projectSlug: string; seat: string; state: string | null }> = [];
  const offThrowing = onHandoffProgressChange(() => {
    throw new Error("boom");
  });
  const off = onHandoffProgressChange((event) => {
    received.push({
      projectSlug: event.projectSlug,
      seat: event.seat,
      state: event.progress?.state ?? null,
    });
  });
  t.after(() => {
    offThrowing();
    off();
  });

  writeHandoffProgress(stateDir, slug, progress);
  writeHandoffProgress(stateDir, slug, null, "lead");
  assert.deepEqual(received, [
    { projectSlug: slug, seat: "lead", state: "scheduled" },
    { projectSlug: slug, seat: "lead", state: null },
  ]);

  // Unsubscribe stops future notifications.
  off();
  offThrowing();
  writeHandoffProgress(stateDir, slug, progress);
  assert.equal(received.length, 2);
});

test("lead-mailbox.ts: onStateChange emits all mailbox/registration mutation kinds with projectSlug and preserves optional default", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const projA = makeGitProject(dir, "repo-a");
  ensureProjectRegistered(stateDir, projA.root);

  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  factory.history.start();
  t.after(() => factory.history.stop());

  const leadAgentId = "lead-agent-1";
  const supervisorAgentId = "sup-agent-1";
  const { daemon } = makeFakeDaemon([
    { id: leadAgentId, status: "idle", labels: { seat: "lead", project: projA.slug }, cwd: projA.root },
    { id: supervisorAgentId, status: "idle", labels: { seat: "supervisor", project: projA.slug }, cwd: projA.root },
  ]);
  writeProjectRegistration(stateDir, projA.slug, {
    root: projA.root,
    lead: leadAgentId,
    supervisor: supervisorAgentId,
  });

  const changes: LeadMailboxStateChange[] = [];
  const runtime = createLeadMailRuntime({
    factory,
    stateDir,
    home,
    daemon,
    ensureLead: async () => ({ ok: true, agentId: leadAgentId, created: false, projectRoot: projA.root, slug: projA.slug }),
    retireLead: async () => ({ ok: true, agentId: leadAgentId }),
    onStateChange: (event) => changes.push(event),
  });
  t.after(() => runtime.stop());

  // 1. mail_queued + mail_delivered via dispatchLead
  const dispatchRes = await runtime.dispatchLead({
    id: "req-1",
    kind: "lead_dispatch",
    project: projA.slug,
    from: "owner",
    message: "first directive",
  });
  assert.equal(dispatchRes.ok, true);
  assert.ok(changes.some((e) => e.projectSlug === projA.slug && e.kind === "mail_queued"));
  assert.ok(changes.some((e) => e.projectSlug === projA.slug && e.kind === "mail_delivered"));

  // 2. mail_acked on completed Lead turn
  changes.length = 0;
  await runtime.onLeadTurnEnded({ agentId: leadAgentId, outcome: { kind: "completed" } });
  assert.ok(changes.some((e) => e.projectSlug === projA.slug && e.kind === "mail_acked"));

  // 3. mail_requeued on failed Lead turn (and settle its 1-shot retry)
  const second = await runtime.dispatchLead({
    id: "req-2",
    kind: "lead_dispatch",
    project: projA.slug,
    from: "owner",
    message: "second directive",
  });
  assert.equal(second.ok, true);
  changes.length = 0;
  await runtime.onLeadTurnEnded({ agentId: leadAgentId, outcome: { kind: "failed" } });
  assert.ok(changes.some((e) => e.projectSlug === projA.slug && e.kind === "mail_requeued"));
  await runtime.onLeadTurnEnded({ agentId: leadAgentId, outcome: { kind: "completed" } });

  // 4. registration_written via dispatchSupervisor from a normal chat submitter
  changes.length = 0;
  const supRes = await runtime.dispatchSupervisor({
    id: "req-3",
    kind: "supervisor_dispatch",
    project: projA.slug,
    submitter: "chat-owner-1",
    message: "report to supervisor",
  });
  assert.equal(supRes.ok, true);
  assert.ok(changes.some((e) => e.projectSlug === projA.slug && e.kind === "registration_written"));
  assert.ok(changes.some((e) => e.projectSlug === projA.slug && e.kind === "mail_queued"));
  await runtime.onLeadTurnEnded({ agentId: supervisorAgentId, outcome: { kind: "completed" } });

  // 5. mailbox_recovered via startupRecovery when an item is left in-flight
  const mailboxFile = join(projectStateDir(stateDir, projA.slug), "mailbox.jsonl");
  const queuedItem = enqueueLeadMail(mailboxFile, { from: "owner", kind: "directive", text: "crash-test" });
  deliverLeadMail(mailboxFile, { mailIds: [queuedItem.mailId], toAgentId: leadAgentId });
  changes.length = 0;
  await runtime.startupRecovery();
  assert.ok(changes.some((e) => e.projectSlug === projA.slug && e.kind === "mailbox_recovered"));

  // 6. mailbox_reset via resetProjectMailbox
  changes.length = 0;
  runtime.resetProjectMailbox(projA.slug);
  assert.ok(changes.some((e) => e.projectSlug === projA.slug && e.kind === "mailbox_reset"));

  // 7. mailbox_rotated via rotateProjectMailbox
  changes.length = 0;
  runtime.rotateProjectMailbox(projA.slug);
  assert.ok(changes.some((e) => e.projectSlug === projA.slug && e.kind === "mailbox_rotated"));

  // Optional default: omitting onStateChange runs cleanly.
  const plainRuntime = createLeadMailRuntime({
    factory,
    stateDir,
    home,
    daemon,
    ensureLead: async () => ({ ok: true, agentId: leadAgentId, created: false, projectRoot: projA.root, slug: projA.slug }),
    retireLead: async () => ({ ok: true, agentId: leadAgentId }),
  });
  t.after(() => plainRuntime.stop());
  plainRuntime.resetProjectMailbox(projA.slug);
});

test("plugin/index.server.ts: wires ledger, surface, handoff.progress, and mailbox emitters to stateHub and cleans up on stop", async (t) => {
  const homeDir = makeTempDir();
  disposeDir(t, homeDir);
  const prevHome = process.env.HOME;
  const prevPaseoHome = process.env.PASEO_HOME;
  process.env.HOME = homeDir;
  process.env.PASEO_HOME = join(homeDir, ".paseo");
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevPaseoHome;
  });

  const hooks = new Map<string, (payload: unknown, context: unknown) => Promise<unknown>>();
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const server = {
    addHook: (name: string, handler: (payload: unknown, context: unknown) => Promise<unknown>) => {
      hooks.set(name, handler);
      return () => {
        hooks.delete(name);
      };
    },
    handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => {
      handlers.set(contract.name, handler);
    },
  } as unknown as Parameters<typeof contribute>[0];

  const stop = contribute(server);
  t.after(() => stop());

  const stateDir = join(homeDir, ".paseo", "plugin-state", "paseo-factory");
  const projA = makeGitProject(homeDir, "repo-a");
  ensureProjectRegistered(stateDir, projA.root);

  const { daemon } = makeFakeDaemon([
    { id: "lead-1", status: "idle", labels: { seat: "lead", project: projA.slug }, cwd: projA.root },
  ]);
  writeProjectRegistration(stateDir, projA.slug, { root: projA.root, lead: "lead-1" });

  const received: StateUpdateEvent[] = [];
  const ac = new AbortController();
  t.after(() => ac.abort());

  handlers.get("factory.state.updates")!(
    { projectRoot: projA.root },
    {
      paseo: daemon,
      signal: ac.signal,
      push: async (event: StateUpdateEvent) => {
        received.push(event);
      },
    },
  );

  // 1. handoff.progress (scoped to stateDir) + ignore foreign stateDir
  const now = new Date().toISOString();
  const foreignStateDir = join(homeDir, "other-state");
  mkdirSync(projectStateDir(foreignStateDir, projA.slug), { recursive: true });
  writeHandoffProgress(foreignStateDir, projA.slug, {
    seat: "lead",
    reason: "owner",
    state: "scheduled",
    fromLane: { provider: "pi", model: "glm-5.3" },
    toLane: { provider: "pi", model: "glm-5.3" },
    startedAt: now,
    updatedAt: now,
  });
  await wait(80);
  assert.equal(received.some((e) => e.reasons.includes("handoff.progress")), false);

  writeHandoffProgress(stateDir, projA.slug, {
    seat: "lead",
    reason: "owner",
    state: "scheduled",
    fromLane: { provider: "pi", model: "glm-5.3" },
    toLane: { provider: "pi", model: "glm-5.3" },
    startedAt: now,
    updatedAt: now,
  });
  await waitUntil(() => received.some((e) => e.reasons.includes("handoff.progress") && e.projectSlug === projA.slug));

  // 2. surface.<handler> via RPC
  const lanesResult = await (handlers.get("factory.lanes.set")!(
    { lane: "worker", value: "pi/zai/glm-5.3", projectRoot: projA.root },
    { paseo: daemon },
  ) as Promise<{ ok: boolean }>);
  assert.equal(lanesResult.ok, true);
  await waitUntil(() => received.some((e) => e.reasons.includes("surface.lanesSet") && e.projectSlug === projA.slug));

  // 3. ledger.<method> via registry's per-project factory
  const registry = factoryRegistryFor(stateDir);
  const projectFactory = registry.factoryForProject(projA.slug);
  projectFactory.history.runSync(() => {
    projectFactory.ledger.append({ event: "attempt_accepted", task: "HUB-1", attempt: 1 });
  });
  await waitUntil(() => received.some((e) => e.reasons.includes("ledger.append") && e.projectSlug === projA.slug));

  // 4. mailbox.<kind> via factory.lead.dispatch RPC
  const dispatchResult = await (handlers.get("factory.lead.dispatch")!(
    { projectRoot: projA.root, from: "owner", message: "hello hub" },
    { paseo: daemon },
  ) as Promise<{ ok: boolean }>);
  assert.equal(dispatchResult.ok, true);
  await waitUntil(() =>
    received.some((e) => e.reasons.includes("mailbox.mail_queued") && e.projectSlug === projA.slug) &&
    received.some((e) => e.reasons.includes("mailbox.mail_delivered") && e.projectSlug === projA.slug),
  );

  // 5. stop() removes the handoff-progress listener and stops stateHub.
  const countBeforeStop = received.length;
  stop();
  writeHandoffProgress(stateDir, projA.slug, null);
  await wait(80);
  assert.equal(received.length, countBeforeStop);
});

test("plugin/index.server.ts: emits onboarding.progress directly on stateHub (not surface.onboarding.progress) and skips onboarding.status", async (t) => {
  const homeDir = makeTempDir();
  disposeDir(t, homeDir);
  const prevHome = process.env.HOME;
  const prevPaseoHome = process.env.PASEO_HOME;
  process.env.HOME = homeDir;
  process.env.PASEO_HOME = join(homeDir, ".paseo");
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevPaseoHome;
  });

  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const server = {
    addHook: () => () => {},
    handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => {
      handlers.set(contract.name, handler);
    },
  } as unknown as Parameters<typeof contribute>[0];

  const stop = contribute(server);
  t.after(() => stop());

  const projB = makeGitProject(homeDir, "repo-onboard");
  const { daemon } = makeFakeDaemon([]);
  // Use a real provider/model in create by updating default lanes in stateDir.
  const stateDir = join(homeDir, ".paseo", "plugin-state", "paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "lanes.json"),
    JSON.stringify({
      supervisor: "pi/zai/glm-5.3",
      lead: "pi/zai/glm-5.3",
      worker: "pi/zai/glm-5.3",
      watch: "pi/zai/glm-5.3",
      freshEyes: "pi/zai/glm-5.3",
    }),
  );

  const received: StateUpdateEvent[] = [];
  const ac = new AbortController();
  t.after(() => ac.abort());

  handlers.get("factory.state.updates")!(
    { projectRoot: projB.root },
    {
      paseo: daemon,
      signal: ac.signal,
      push: async (event: StateUpdateEvent) => {
        received.push(event);
      },
    },
  );

  // Read-only onboardingStatus does not emit stateHub updates.
  const preStatus = await (handlers.get("factory.onboarding.status")!(
    { folder: projB.root },
    { paseo: daemon },
  ) as Promise<{ ok: boolean; run: unknown }>);
  assert.deepEqual(preStatus, { ok: true, run: null });
  await wait(80);
  assert.equal(
    received.some((e) => e.reasons.some((r) => r.includes("onboarding"))),
    false,
  );

  const started = await (handlers.get("factory.onboarding.start")!(
    { folder: projB.root },
    { paseo: daemon },
  ) as Promise<{ ok: boolean; run?: { runId: string } }>);
  assert.equal(started.ok, true);
  assert.ok(started.run?.runId);

  await waitUntil(() => received.some((e) => e.reasons.includes("onboarding.progress")));
  assert.equal(
    received.some((e) => e.reasons.includes("surface.onboarding.progress")),
    false,
    "must emit onboarding.progress directly rather than surface.onboarding.progress",
  );
  const deadline = Date.now() + 2_000;
  let runStatus = "running";
  while (runStatus === "running" && Date.now() < deadline) {
    const res = await (handlers.get("factory.onboarding.status")!(
      { runId: started.run!.runId },
      { paseo: daemon },
    ) as Promise<{ ok: boolean; run?: { status: string } }>);
    if (res.ok && res.run) runStatus = res.run.status;
    if (runStatus === "running") await wait(15);
  }
  assert.equal(runStatus, "succeeded");
});
