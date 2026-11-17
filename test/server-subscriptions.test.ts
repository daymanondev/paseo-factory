import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import vm from "node:vm";
import contribute from "../plugin/index.server.ts";
import { writeProjectRegistration } from "../plugin/server/core/project.ts";
import { createStateHub, type StateUpdateEvent } from "../plugin/server/state-hub.ts";
import { stateUpdates, supportsSubscriptionContract } from "../plugin/shared/rpc.ts";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for condition");
    await wait(15);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("rpc contract exposes stateUpdates and supportsSubscriptionContract on >=0.16.0", () => {
  assert.equal(supportsSubscriptionContract, true);
  assert.equal(stateUpdates.name, "factory.state.updates");
  assert.deepEqual(stateUpdates.input.parse({}), {});
  assert.deepEqual(stateUpdates.input.parse({ projectRoot: "/repo/a" }), { projectRoot: "/repo/a" });
  const parsed = stateUpdates.event.parse({
    seq: 1,
    reasons: ["hook.agent.turn.after"],
    projectSlug: "repo-a-123456",
    projectRoot: "/repo/a",
    at: "2026-11-17T00:00:00.000Z",
  });
  assert.equal(parsed.seq, 1);
  assert.deepEqual(parsed.reasons, ["hook.agent.turn.after"]);
});

test("<0.16.0 fallback: missing defineSubscription yields plain contract and skips server subscription registration", async (t) => {
  const hostDir = makeTempDir();
  disposeDir(t, hostDir);
  const stubPluginPath = join(hostDir, "legacy-paseo-plugin.mjs");
  writeFileSync(
    stubPluginPath,
    `export function defineRpc(def) { return { ...def, name: def.name.trim() }; }\n`,
    "utf8",
  );

  const legacyAliasPlugin = {
    name: "legacy-paseo-plugin-alias",
    setup(buildCtx: { onResolve: (opts: { filter: RegExp }, cb: () => { path: string }) => void }) {
      buildCtx.onResolve({ filter: /^@getpaseo\/plugin$/ }, () => ({ path: stubPluginPath }));
    },
  };

  const rpcBundle = await build({
    entryPoints: [join(repoRoot, "plugin/shared/rpc.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["zod"],
    plugins: [legacyAliasPlugin],
    write: false,
    logLevel: "silent",
  });

  const hostRequire = createRequire(import.meta.url);
  const rpcMod = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(rpcBundle.outputFiles[0]!.text, {
    require: hostRequire,
    module: rpcMod,
    exports: rpcMod.exports,
    process,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    console,
  });

  assert.equal(rpcMod.exports.supportsSubscriptionContract, false);
  const fallbackContract = rpcMod.exports.stateUpdates as {
    name: string;
    input: { parse: (v: unknown) => unknown };
    event: { parse: (v: unknown) => unknown };
  };
  assert.equal(fallbackContract.name, "factory.state.updates");
  assert.deepEqual(fallbackContract.input.parse({ projectRoot: "/repo" }), { projectRoot: "/repo" });
  assert.deepEqual(
    fallbackContract.event.parse({ seq: 3, reasons: ["state.fs"], at: "2026-11-17T00:00:00.000Z" }),
    { seq: 3, reasons: ["state.fs"], at: "2026-11-17T00:00:00.000Z" },
  );

  // Also verify plugin/index.server.ts boots on a <0.16.0 host without calling server.handle(stateUpdates, ...).
  const serverBundle = await build({
    entryPoints: [join(repoRoot, "plugin/index.server.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["@getpaseo/plugin/server", "@getpaseo/plugin/server/*", "zod"],
    plugins: [legacyAliasPlugin],
    write: false,
    logLevel: "silent",
  });

  const serverMod = { exports: {} as { default?: (server: unknown) => () => void } };
  vm.runInNewContext(serverBundle.outputFiles[0]!.text, {
    require: hostRequire,
    module: serverMod,
    exports: serverMod.exports,
    process,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  });

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

  const registered: string[] = [];
  const legacyServer = {
    on: () => () => {},
    before: () => () => {},
    handle: (contract: { name: string }) => {
      registered.push(contract.name);
    },
  };
  const stop = serverMod.exports.default!(legacyServer);
  try {
    assert.ok(registered.includes("factory.snapshot"));
    assert.equal(registered.includes("factory.state.updates"), false);
  } finally {
    stop();
  }
});

test("state-hub coalesces bursts, increments seq monotonically, serializes push, and never spawns git on emit", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const repoA = join(dir, "repo-a");
  mkdirSync(join(repoA, "sub"), { recursive: true });
  // Register project without running git init — and strip PATH so any git spawn would fail.
  writeProjectRegistration(stateDir, "repo-a-111111", { root: repoA });

  const prevPath = process.env.PATH;
  process.env.PATH = "";
  t.after(() => {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  });

  const hub = createStateHub({ stateDir, coalesceMs: 25 });
  t.after(() => hub.stop());

  const ac = new AbortController();
  const events: StateUpdateEvent[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const ret = hub.subscribe(
    { projectRoot: repoA },
    {
      signal: ac.signal,
      push: async (event) => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await wait(30);
        events.push(event);
        inFlight -= 1;
      },
    },
  );
  assert.equal(ret, undefined, "subscribe returns void synchronously");

  // Burst 1: duplicate and distinct reasons within one coalesce window.
  hub.emit("hook.agent.turn.after", { projectRoot: join(repoA, "sub") });
  hub.emit("state.fs", { projectSlug: "repo-a-111111" });
  hub.emit("hook.agent.turn.after", { projectRoot: repoA });

  // Burst 2: triggered after burst 1 flushes while push #1 is still in flight (30ms).
  await wait(35);
  hub.emit("hook.agent.permission.before", { projectRoot: repoA });

  await waitUntil(() => events.length === 2);
  assert.equal(maxConcurrent, 1, "push calls are strictly serialized");
  assert.equal(events[0]!.seq, 1);
  assert.deepEqual(events[0]!.reasons, ["hook.agent.turn.after", "state.fs"]);
  assert.equal(events[0]!.projectSlug, "repo-a-111111");
  assert.equal(events[0]!.projectRoot, repoA);
  assert.ok(!Number.isNaN(Date.parse(events[0]!.at)));

  assert.equal(events[1]!.seq, 2);
  assert.deepEqual(events[1]!.reasons, ["hook.agent.permission.before"]);
});

test("state-hub scope filtering isolates projects and delivers global events to all subscribers", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const repoA = join(dir, "repo-a");
  const repoB = join(dir, "repo-b");
  mkdirSync(join(repoA, "nested"), { recursive: true });
  mkdirSync(repoB, { recursive: true });
  writeProjectRegistration(stateDir, "proj-a", { root: repoA });
  writeProjectRegistration(stateDir, "proj-b", { root: repoB });

  const hub = createStateHub({ stateDir, coalesceMs: 10 });
  t.after(() => hub.stop());

  const acGlobal = new AbortController();
  const acA = new AbortController();
  const acB = new AbortController();
  const receivedGlobal: StateUpdateEvent[] = [];
  const receivedA: StateUpdateEvent[] = [];
  const receivedB: StateUpdateEvent[] = [];

  hub.subscribe({}, { signal: acGlobal.signal, push: async (e) => { receivedGlobal.push(e); } });
  hub.subscribe({ projectRoot: repoA }, { signal: acA.signal, push: async (e) => { receivedA.push(e); } });
  hub.subscribe({ projectRoot: repoB }, { signal: acB.signal, push: async (e) => { receivedB.push(e); } });

  hub.emit("worktree.touch", { projectRoot: join(stateDir, "projects", "proj-a", "worktrees", "T-1") });
  hub.emit("state.fs", { projectSlug: "proj-b" });
  hub.emit("daemon.providers");

  await waitUntil(() => receivedGlobal.length === 3);
  await wait(20);

  assert.deepEqual(receivedA.map((e) => e.reasons), [["worktree.touch"], ["daemon.providers"]]);
  assert.deepEqual(receivedB.map((e) => e.reasons), [["state.fs"], ["daemon.providers"]]);
  assert.equal(receivedA[0]!.projectSlug, "proj-a");
  assert.equal(receivedB[0]!.projectSlug, "proj-b");
});

test("state-hub daemon sub lifecycle attaches only when subscribers > 0, omits includeBackground, and releases late promises at 0 or stop", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const hub = createStateHub({ stateDir, coalesceMs: 10 });
  t.after(() => hub.stop());

  const calls: string[] = [];
  const agentListOptions: unknown[] = [];
  let unsubAgentsCount = 0;
  let unsubWorkspacesCount = 0;
  let unsubProjectsCount = 0;
  let unsubProvidersCount = 0;
  let agentReleaseCount = 0;
  let workspaceReleaseCount = 0;

  let emitAgentUpdate: ((u: unknown) => void) | undefined;
  let emitProviderUpdate: ((u: unknown) => void) | undefined;
  let pendingAgentList = deferred<{ subscription: { release: () => Promise<void> } }>();
  let pendingWorkspaceList = deferred<{ subscription: { release: () => Promise<void> } }>();

  const fakeDaemon = {
    agents: {
      list: (opts: unknown) => {
        calls.push("agents.list");
        agentListOptions.push(opts);
        return pendingAgentList.promise;
      },
      subscribe: (handler: (u: unknown) => void) => {
        calls.push("agents.subscribe");
        emitAgentUpdate = handler;
        return () => { unsubAgentsCount += 1; };
      },
    },
    workspaces: {
      list: () => {
        calls.push("workspaces.list");
        return pendingWorkspaceList.promise;
      },
      subscribe: () => {
        calls.push("workspaces.subscribe");
        return () => { unsubWorkspacesCount += 1; };
      },
    },
    projects: {
      subscribe: () => {
        calls.push("projects.subscribe");
        return () => { unsubProjectsCount += 1; };
      },
    },
    providers: {
      subscribe: (handler: (u: unknown) => void) => {
        calls.push("providers.subscribe");
        emitProviderUpdate = handler;
        return () => { unsubProvidersCount += 1; };
      },
    },
  };

  hub.attachDaemon(fakeDaemon);
  assert.deepEqual(calls, [], "daemon subs stay unattached while subscribers === 0");

  // 0 -> 1 attaches once; 1 -> 2 does not re-attach.
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const events1: StateUpdateEvent[] = [];
  const events2: StateUpdateEvent[] = [];
  hub.subscribe({}, { signal: ac1.signal, push: async (e) => { events1.push(e); } });
  hub.subscribe({ projectRoot: "/repo/x" }, { signal: ac2.signal, push: async (e) => { events2.push(e); } });

  assert.deepEqual(calls.sort(), [
    "agents.list",
    "agents.subscribe",
    "projects.subscribe",
    "providers.subscribe",
    "workspaces.list",
    "workspaces.subscribe",
  ]);
  assert.deepEqual(agentListOptions[0], { subscribe: {} });
  assert.equal("includeBackground" in (agentListOptions[0] as Record<string, unknown>), false);

  // Daemon updates flow to subscribers while active.
  emitAgentUpdate?.({ kind: "upsert", agent: { id: "a1", cwd: "/repo/x" } });
  emitProviderUpdate?.({});
  await waitUntil(() => events1.length >= 1 && events2.length >= 1);

  // 2 -> 1 keeps subs attached.
  ac2.abort();
  assert.equal(unsubAgentsCount, 0);

  // 1 -> 0 detaches synchronous unsubs AND releases late-resolving list promises!
  ac1.abort();
  assert.equal(unsubAgentsCount, 1);
  assert.equal(unsubWorkspacesCount, 1);
  assert.equal(unsubProjectsCount, 1);
  assert.equal(unsubProvidersCount, 1);

  pendingAgentList.resolve({ subscription: { release: async () => { agentReleaseCount += 1; } } });
  pendingWorkspaceList.resolve({ subscription: { release: async () => { workspaceReleaseCount += 1; } } });
  await waitUntil(() => agentReleaseCount === 1 && workspaceReleaseCount === 1);

  // Re-subscribing after 0 -> 1 -> 0 re-attaches, and stop() releases late promises too.
  pendingAgentList = deferred();
  pendingWorkspaceList = deferred();
  const ac3 = new AbortController();
  hub.subscribe({}, { signal: ac3.signal, push: async () => {} });
  assert.equal(agentListOptions.length, 2);

  hub.stop();
  assert.equal(unsubAgentsCount, 2);
  pendingAgentList.resolve({ subscription: { release: async () => { agentReleaseCount += 1; } } });
  pendingWorkspaceList.resolve({ subscription: { release: async () => { workspaceReleaseCount += 1; } } });
  await waitUntil(() => agentReleaseCount === 2 && workspaceReleaseCount === 2);
});

test("state-hub guards partial daemons and handles abort cleanup cleanly", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const hub = createStateHub({ stateDir: join(dir, "state"), coalesceMs: 20 });
  t.after(() => hub.stop());

  let legacyListCalled = false;
  // Partial daemon without agents.subscribe must NOT call agents.list({ subscribe: {} }).
  hub.attachDaemon({
    agents: {
      list: async () => {
        legacyListCalled = true;
        return { entries: [] };
      },
    },
  });

  // Already-aborted signal never attaches or receives pushes.
  const preAborted = new AbortController();
  preAborted.abort();
  let preAbortedPushes = 0;
  hub.subscribe({}, { signal: preAborted.signal, push: async () => { preAbortedPushes += 1; } });
  assert.equal(legacyListCalled, false);

  const ac = new AbortController();
  const gate = deferred<void>();
  const delivered: number[] = [];
  hub.subscribe(
    {},
    {
      signal: ac.signal,
      push: async (event) => {
        delivered.push(event.seq);
        if (event.seq === 1) await gate.promise;
      },
    },
  );
  assert.equal(legacyListCalled, false);

  hub.emit("first");
  await waitUntil(() => delivered.length === 1);
  hub.emit("second");
  await wait(35);
  // Abort before releasing push #1 — queued push #2 must be dropped.
  ac.abort();
  gate.resolve();
  await wait(25);

  assert.deepEqual(delivered, [1]);
  assert.equal(preAbortedPushes, 0);
});

test("plugin/index.server.ts registers guarded stateUpdates, emits on 5 hooks and fs.watch, and cleans up on stop", async (t) => {
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

  // Full server double with addHook + handle.
  const hooks = new Map<string, (payload: unknown, context: unknown) => Promise<unknown>>();
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const server = {
    addHook: (name: string, handler: (payload: unknown, context: unknown) => Promise<unknown>) => {
      hooks.set(name, handler);
      return () => { hooks.delete(name); };
    },
    handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => {
      handlers.set(contract.name, handler);
    },
  } as unknown as Parameters<typeof contribute>[0];

  const stop = contribute(server);
  t.after(() => stop());

  assert.equal(handlers.has("factory.state.updates"), true);
  assert.deepEqual([...hooks.keys()].sort(), [
    "agent.archive.after",
    "agent.create.before",
    "agent.open.before",
    "agent.permission.before",
    "agent.turn.after",
  ]);

  let daemonUnsubCount = 0;
  const fakeDaemon = {
    agents: {
      list: async () => ({ entries: [], subscription: { release: async () => { daemonUnsubCount += 1; } } }),
      subscribe: () => () => { daemonUnsubCount += 1; },
    },
    providers: {
      subscribe: () => () => { daemonUnsubCount += 1; },
    },
  };

  const stateDir = join(homeDir, ".paseo", "plugin-state", "paseo-factory");
  const repoA = join(homeDir, "repo-a");
  mkdirSync(repoA, { recursive: true });
  writeProjectRegistration(stateDir, "proj-a", { root: repoA });

  const received: StateUpdateEvent[] = [];
  const ac = new AbortController();
  const subHandler = handlers.get("factory.state.updates")!;
  const subReturn = subHandler(
    { projectRoot: repoA },
    {
      paseo: fakeDaemon,
      signal: ac.signal,
      push: async (event: StateUpdateEvent) => {
        received.push(event);
      },
    },
  );
  assert.equal(subReturn, undefined, "subscription handler returns sync void");

  await hooks.get("agent.permission.before")!({ agent: { id: "p1", cwd: repoA }, request: {} }, { paseo: fakeDaemon });
  await hooks.get("agent.create.before")!({ request: { config: { cwd: repoA, provider: "pi", model: "test" } } }, { paseo: fakeDaemon });
  await hooks.get("agent.open.before")!({ request: { agentId: "p1", cwd: repoA, reason: "create", purpose: "interactive", env: {}, tools: [], mcpServers: {}, labels: {}, metadata: {}, background: false, title: null, workspaceId: null, provider: "pi" } }, { paseo: fakeDaemon });
  await hooks.get("agent.turn.after")!({ agent: { id: "p1", cwd: repoA }, outcome: { kind: "completed" }, turnId: null }, { paseo: fakeDaemon });
  await hooks.get("agent.archive.after")!({ agent: { id: "p1", cwd: repoA }, archivedAt: new Date().toISOString() }, { paseo: fakeDaemon });

  await waitUntil(() => {
    const reasons = new Set(received.flatMap((e) => e.reasons));
    return (
      reasons.has("hook.agent.permission.before") &&
      reasons.has("hook.agent.create.before") &&
      reasons.has("hook.agent.open.before") &&
      reasons.has("hook.agent.turn.after") &&
      reasons.has("hook.agent.archive.after")
    );
  });

  // Write under stateDir/projects/proj-a to verify cross-platform fs.watch emission.
  const watchedFile = join(stateDir, "projects", "proj-a", "watch-probe.txt");
  mkdirSync(dirname(watchedFile), { recursive: true });
  const beforeCount = received.length;
  writeFileSync(watchedFile, "changed\n", "utf8");
  await waitUntil(() => received.slice(beforeCount).some((e) => e.reasons.includes("state.fs") && e.projectSlug === "proj-a"));

  stop();
  await waitUntil(() => daemonUnsubCount >= 3);
});
