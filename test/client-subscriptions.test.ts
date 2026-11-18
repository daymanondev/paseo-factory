/**
 * T-23b-1: Client subscription primitives (`plugin/client/kit/subscription.ts`),
 * non-resetting `usePoll` refresh & cadence rescheduling (`plugin/client/kit/poll.ts`),
 * and `FactoryShell` `stateUpdates` wiring (`plugin/client/factory/shell.tsx`) across:
 * - `>= 0.16.0` hosts using real `PluginRpcProvider` + `useSubscription`
 * - `< 0.16.0` `@getpaseo/plugin` (missing `defineSubscription`)
 * - `< 0.16.0` `@getpaseo/plugin/client` (missing `useSubscription`)
 * - `< 0.16.0` daemons (subscription rejection / close -> adaptive polling fallback)
 * - Hermes / React Native window without DOM event listeners or `document`
 * - Reusable `subscribeClientUpdates` / `canClientSubscribe` for T-23b-2
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

type Exports = Record<string, any>;

interface LoadHarnessOptions {
  /** Omit `defineSubscription` from `@getpaseo/plugin` to simulate `< 0.16.0` package runtime. */
  legacyPluginPackage?: boolean;
  /** Omit `useSubscription` from `@getpaseo/plugin/client` to simulate `< 0.16.0` client host. */
  legacyClientHost?: boolean;
  /** React Native platform OS for `Platform.OS`. */
  platformOs?: "ios" | "android" | "web";
}

async function loadHarness(t: TestContext, opts: LoadHarnessOptions = {}): Promise<Exports> {
  const tmpDir = makeTempDir();
  disposeDir(t, tmpDir);

  const virtualEntry = join(tmpDir, "harness-entry.tsx");
  writeFileSync(
    virtualEntry,
    [
      `export * from ${JSON.stringify(join(repoRoot, "plugin/client/kit/subscription.ts"))};`,
      `export * from ${JSON.stringify(join(repoRoot, "plugin/client/kit/poll.ts"))};`,
      `export { FactoryShell } from ${JSON.stringify(join(repoRoot, "plugin/client/factory/shell.tsx"))};`,
      `export { startSeatDirectory, DIRECTORY_POLL_MS } from ${JSON.stringify(join(repoRoot, "plugin/client/factory/directory.tsx"))};`,
      `export { stateUpdates, supportsSubscriptionContract } from ${JSON.stringify(join(repoRoot, "plugin/shared/rpc.ts"))};`,
      ...(opts.legacyClientHost ? [] : [`export { PluginRpcProvider } from "@getpaseo/plugin/client";`]),
    ].join("\n"),
    "utf8",
  );

  const legacyPluginPath = join(tmpDir, "legacy-paseo-plugin.mjs");
  if (opts.legacyPluginPackage) {
    writeFileSync(
      legacyPluginPath,
      `export function defineRpc(def) { return { ...def, name: def.name.trim() }; }\n`,
      "utf8",
    );
  }

  const platformOs = opts.platformOs ?? "web";
  const bundle = await build({
    entryPoints: [virtualEntry],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
    plugins: [
      {
        name: "subscription-test-adapters",
        setup(b) {
          if (opts.legacyPluginPackage) {
            b.onResolve({ filter: /^@getpaseo\/plugin$/ }, () => ({ path: legacyPluginPath }));
          }
          b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui)$/ }, (args) => ({
            path: args.path,
            namespace: "rn-ui-adapter",
          }));
          b.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, (args) => ({
            path: args.path,
            namespace: opts.legacyClientHost ? "legacy-client-host" : "modern-client-host",
          }));
          b.onLoad({ filter: /.*/, namespace: "rn-ui-adapter" }, () => ({
            loader: "js",
            contents: `
              const React = require("react");
              const tag = (name) => ({ children, onPress, disabled, ...rest }) =>
                React.createElement(
                  name,
                  {
                    disabled,
                    onClick: onPress,
                    "data-testid": rest.testID,
                    "data-role": rest.accessibilityRole,
                    "aria-label": rest.accessibilityLabel,
                    "data-selected": rest.accessibilityState?.selected !== undefined ? String(rest.accessibilityState.selected) : undefined,
                  },
                  typeof children === "function" ? children({ pressed: false }) : children,
                );
              exports.View = tag("div");
              exports.ScrollView = tag("div");
              exports.Text = tag("span");
              exports.Pressable = tag("button");
              exports.TextInput = ({ value, placeholder, onChangeText, ...rest }) =>
                React.createElement("input", {
                  value: value ?? "",
                  placeholder,
                  "data-testid": rest.testID,
                  onChange: (event) => onChangeText && onChangeText(event.target.value),
                });
              exports.Icon = () => null;
              exports.Loading = () => null;
              exports.Platform = {
                OS: ${JSON.stringify(platformOs)},
                select: (spec) => (spec[${JSON.stringify(platformOs)}] !== undefined ? spec[${JSON.stringify(platformOs)}] : spec.default),
              };
              exports.useToast = () => ({ show() {}, error() {} });
              exports.DocumentFrame = ({ url }) => React.createElement("section", { "data-document-frame": url });
              const Modal = ({ children, open, title }) => (open ? React.createElement("div", { "data-modal-title": title }, children) : null);
              Modal.Content = tag("div");
              exports.Modal = Modal;
            `,
          }));
          b.onLoad({ filter: /.*/, namespace: "modern-client-host" }, () => ({
            loader: "js",
            resolveDir: repoRoot,
            contents: `
              export { PluginRpcProvider, useRpc, useSubscription } from ${JSON.stringify(
                join(repoRoot, "node_modules/@getpaseo/plugin/dist/client/rpc-context.js"),
              )};
              export const useWorkspace = () => "/project";
              export const useWorkspaces = () => [];
              export const useProjects = () => [];
              export const useProject = () => null;
              export const usePaseo = () => ({ workspaces: { list: async () => ({ entries: [] }), create: async () => ({ id: "ws-1" }) }, projects: { ref: () => ({ createWorkspace: async () => ({ id: "ws-1" }) }) } });
              export const useToast = () => ({ show() {}, error() {} });
              export const openExternalUrl = async () => {};
            `,
          }));
          b.onLoad({ filter: /.*/, namespace: "legacy-client-host" }, () => ({
            loader: "js",
            contents: `
              exports.useRpc = (contract) => (input) => globalThis.__factoryClientRpc(contract.name, input);
              exports.useWorkspace = () => "/project";
              exports.useWorkspaces = () => [];
              exports.useProjects = () => [];
              exports.useProject = () => null;
              exports.usePaseo = () => ({ workspaces: { list: async () => ({ entries: [] }), create: async () => ({ id: "ws-1" }) }, projects: { ref: () => ({ createWorkspace: async () => ({ id: "ws-1" }) }) } });
              exports.useToast = () => ({ show() {}, error() {} });
              exports.openExternalUrl = async () => {};
            `,
          }));
        },
      },
    ],
  });

  const compiled = { exports: {} as Exports };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
  );
  return compiled.exports;
}

async function mountInDom<T>(
  run: (opts: {
    createRoot: typeof import("react-dom/client").createRoot;
    container: HTMLElement;
    domWindow: any;
    act: (fn: () => void | Promise<void>) => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
  };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  try {
    return await run({
      createRoot,
      container: dom.window.document.getElementById("root")!,
      domWindow: dom.window,
      act: (fn) => act(async () => { await fn(); }),
    });
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
}

function makeNativeWindow(domWindow: any): void {
  for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
    Object.defineProperty(domWindow, key, { value: undefined, configurable: true, writable: true });
  }
  delete (globalThis as Record<string, unknown>).document;
}

interface CapturedTimer {
  id: number;
  delay: number;
  fn: () => void;
  cleared: boolean;
}

/**
 * Intercepts long `setTimeout` calls (`>= 500ms`, i.e. `usePoll` timers) so tests
 * can assert exact scheduled delays and trigger polls deterministically without
 * waiting 5s–30s, while letting short React/act timers run normally.
 */
function withPollTimerSpy(t: TestContext) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let nextFakeId = 1_000_000;
  const timers = new Map<number, CapturedTimer>();

  (globalThis as any).setTimeout = (fn: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    if (typeof delay === "number" && delay >= 500) {
      const id = nextFakeId++;
      timers.set(id, { id, delay, fn: () => fn(...args), cleared: false });
      return id as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(fn, delay, ...args);
  };
  (globalThis as any).clearTimeout = (id: any) => {
    if (typeof id === "number" && timers.has(id)) {
      timers.get(id)!.cleared = true;
      return;
    }
    return realClearTimeout(id);
  };
  // Prevent `useNow(1000)` interval from firing mid-test unless needed.
  (globalThis as any).setInterval = (() => 2_000_000) as any;
  (globalThis as any).clearInterval = (() => {}) as any;

  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  });

  return {
    activeDelays: () => [...timers.values()].filter((timer) => !timer.cleared).map((timer) => timer.delay),
    fireLatest: () => {
      const active = [...timers.values()].filter((timer) => !timer.cleared);
      const last = active.at(-1);
      assert.ok(last, "expected an active poll timer to fire");
      last.cleared = true;
      last.fn();
    },
  };
}

function withDirectoryIntervalSpy(t: TestContext) {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let nextFakeId = 3_000_000;
  const intervals = new Map<number, CapturedTimer>();

  (globalThis as any).setInterval = (fn: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    const id = nextFakeId++;
    intervals.set(id, { id, delay, fn: () => fn(...args), cleared: false });
    return id as unknown as ReturnType<typeof setInterval>;
  };
  (globalThis as any).clearInterval = (id: any) => {
    if (typeof id === "number" && intervals.has(id)) {
      intervals.get(id)!.cleared = true;
      return;
    }
    return realClearInterval(id);
  };

  t.after(() => {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  });

  return {
    activeDelays: () => [...intervals.values()].filter((timer) => !timer.cleared).map((timer) => timer.delay),
    totalCreated: () => intervals.size,
    fireLatest: () => {
      const active = [...intervals.values()].filter((timer) => !timer.cleared);
      const last = active.at(-1);
      assert.ok(last, "expected an active directory interval to fire");
      last.fn();
    },
  };
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

function makeViewFixture(overrides: Partial<{ running: number; projectRoot: string; slug: string; daemonError: string | null }> = {}) {
  const projectRoot = overrides.projectRoot ?? "/repo/alpha";
  const slug = overrides.slug ?? "alpha-123456";
  const lane = { provider: "codex", model: "gpt-5", thinking: "high", scope: "project" as const };
  const row = {
    lane,
    pendingLane: null,
    markTokens: 128000,
    allowedActions: ["switch-model", "hand-off-now"],
    vacant: false,
    statusLabel: "idle",
    tone: "normal" as const,
    model: "gpt-5",
    hint: null,
    context: null,
    handoff: null,
  };
  return {
    version: 5 as const,
    stateDir: "/tmp/state",
    generatedAt: new Date().toISOString(),
    lanes: { supervisor: "codex/gpt-5", lead: "codex/gpt-5", worker: "codex/gpt-5", watch: "codex/gpt-5", freshEyes: "codex/gpt-5" },
    machineLanes: { supervisor: "codex/gpt-5", lead: "codex/gpt-5", worker: "codex/gpt-5", watch: "codex/gpt-5", freshEyes: "codex/gpt-5" },
    hasProjectLaneOverride: false,
    providersLoading: false,
    providers: [{ provider: "codex", available: true, models: [{ id: "gpt-5", label: "GPT-5", thinkingOptions: [] }] }],
    kpis: {
      running: overrides.running ?? 1,
      needsHuman: 0,
      readyToAccept: 0,
      accepted: 0,
      totalCostUsd: 0,
      totalTokens: 0,
    },
    agents: [],
    supervisor: null,
    lead: null,
    project: { root: projectRoot, slug, missingRoot: false },
    companionTools: [],
    companions: [],
    corePlugin: {
      id: "paseo-factory",
      title: "Paseo Factory",
      tagline: "Verification core",
      description: "Verification core plugin",
      status: "running" as const,
      enabled: true,
      installKind: "git" as const,
      installedSource: "git:daymanondev/paseo-factory:plugin",
      canonicalSource: "git:daymanondev/paseo-factory:plugin",
      currentRevision: "rev-1111111",
      version: "0.12.5",
      latestRevision: "rev-2222222",
      commitsBehind: 0,
      updateAvailable: false,
      error: null,
      capabilities: [],
      access: "public" as const,
      sidebarIcon: "flame",
      sidebarLabel: "Factory",
    },
    pluginsCheckedAt: new Date().toISOString(),
    vault: {
      configured: false,
      repo: null,
      branch: "main",
      nodeId: "node-1",
      hasPassphrase: false,
      cloneExists: false,
      lastHydratedAt: null,
      lastHydrateMode: null,
      lastPushedAt: null,
      sharedSecrets: { ascKey: false, ascCredentials: false, gplayServiceAccount: false, eyeConfig: false },
      hydratedApps: [],
      ghInstalled: true,
      ghAuthenticated: false,
      ghUser: null,
      suggestedRepo: null,
      error: null,
      historyImports: [],
    },
    profiles: [],
    activeProfileId: null,
    activeProfileModified: false,
    skillHub: {
      totalInstalled: 0,
      upToDateCount: 0,
      updateAvailableCount: 0,
      localCustomCount: 0,
      symlinkDriftCount: 0,
      installedSkills: [],
      skillPacksExplicit: false,
      projectPacks: [],
      hostCatalog: [],
      roleMatrix: [],
    },
    daemonError: overrides.daemonError ?? null,
    panel: {
      isProject: true,
      name: slug,
      summary: "Working",
      needsYou: [],
      handoffs: [],
      profile: { active: null, list: [], modified: false },
      defaultWorker: { role: "worker" as const, title: "Default worker" as const, lane },
      seats: {
        supervisor: { ...row, role: "supervisor" as const, agentId: "sup-1" },
        lead: { ...row, role: "lead" as const, agentId: "lead-1" },
        peers: [],
        supervisorCandidates: [],
      },
      openDesign: null,
      onboarding: null,
    },
  };
}

interface MockSubRecord {
  method: string;
  input: unknown;
  observer: { event: (e: unknown) => void; closed: (err?: Error) => void };
  ready: ReturnType<typeof deferred<void>>;
  released: boolean;
}

function createMockSubscribe() {
  const subs: MockSubRecord[] = [];
  const subscribe = (
    method: string,
    input: unknown,
    observer: { event: (e: unknown) => void; closed: (err?: Error) => void },
  ) => {
    const ready = deferred<void>();
    const rec: MockSubRecord = { method, input, observer, ready, released: false };
    subs.push(rec);
    const stop = () => {
      rec.released = true;
    };
    return Object.assign(stop, {
      ready: ready.promise,
      release: async () => {
        rec.released = true;
      },
    });
  };
  return { subscribe, subs };
}

test("usePoll.refresh preserves value and DOM listeners, and cadenceKey reschedules without resetting", async (t) => {
  const { usePoll, BUSY_MS, QUIET_MS } = await loadHarness(t);
  const { createElement } = await import("react");
  const spy = withPollTimerSpy(t);

  await mountInDom(async ({ createRoot, container, domWindow, act }) => {
    let listenerAdds = 0;
    let listenerRemovals = 0;
    const origWinAdd = domWindow.addEventListener.bind(domWindow);
    const origWinRem = domWindow.removeEventListener.bind(domWindow);
    domWindow.addEventListener = (type: string, fn: any, opts?: any) => {
      if (type === "focus") listenerAdds++;
      return origWinAdd(type, fn, opts);
    };
    domWindow.removeEventListener = (type: string, fn: any, opts?: any) => {
      if (type === "focus") listenerRemovals++;
      return origWinRem(type, fn, opts);
    };

    let loadCount = 0;
    let nextResult = deferred<{ ok: true; value: string }>();
    const seenValues: Array<string | null> = [];
    let latestPoll: any;

    const Probe = ({ cadenceKey, quiet }: { cadenceKey: string; quiet: boolean }) => {
      const poll = usePoll(
        () => {
          loadCount++;
          return nextResult.promise;
        },
        "same-key",
        () => (quiet ? QUIET_MS : BUSY_MS),
        { cadenceKey },
      );
      latestPoll = poll;
      seenValues.push(poll.value);
      return null;
    };

    const root = createRoot(container);
    await act(() => root.render(createElement(Probe, { cadenceKey: "live", quiet: true })));
    assert.equal(loadCount, 1);
    assert.equal(listenerAdds, 1);

    await act(async () => {
      nextResult.resolve({ ok: true, value: "v1" });
    });
    assert.equal(latestPoll.value, "v1");
    assert.deepEqual(spy.activeDelays(), [QUIET_MS]);

    // Changing cadenceKey while idle reschedules to BUSY_MS without wiping value or listeners.
    await act(() => root.render(createElement(Probe, { cadenceKey: "fallback", quiet: false })));
    assert.equal(latestPoll.value, "v1");
    assert.equal(listenerAdds, 1);
    assert.equal(listenerRemovals, 0);
    assert.deepEqual(spy.activeDelays(), [BUSY_MS]);

    // Triggering refresh() keeps value as "v1" while load is in-flight, and preserves listeners.
    nextResult = deferred<{ ok: true; value: string }>();
    await act(() => {
      latestPoll.refresh();
    });
    assert.equal(loadCount, 2);
    assert.equal(latestPoll.value, "v1", "refresh must not wipe value to null");
    assert.ok(!seenValues.slice(2).includes(null), "value never flashed back to null on refresh");
    assert.equal(listenerAdds, 1);
    assert.equal(listenerRemovals, 0);

    // Changing cadenceKey while a load is in-flight must not start an extra timer before completion.
    await act(() => root.render(createElement(Probe, { cadenceKey: "live-again", quiet: true })));
    assert.deepEqual(spy.activeDelays(), []);

    await act(async () => {
      nextResult.resolve({ ok: true, value: "v2" });
    });
    assert.equal(latestPoll.value, "v2");
    assert.deepEqual(spy.activeDelays(), [QUIET_MS]);

    await act(() => root.unmount());
    assert.equal(listenerRemovals, 1);
  });
});

test("FactoryShell with >=0.16.0 host subscribes to stateUpdates, refreshes on ready & push without 5s busy polling, handles scopeRoot/focus/visibility, and falls back on close", async (t) => {
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const spy = withPollTimerSpy(t);

  await mountInDom(async ({ createRoot, container, domWindow, act }) => {
    // Load after mountInDom sets `globalThis.document` so `poll.ts`'s module-level `page` captures it.
    const { FactoryShell, PluginRpcProvider, BUSY_MS, QUIET_MS } = await loadHarness(t);
    let focusAdds = 0;
    let focusRemovals = 0;
    let visAdds = 0;
    let visRemovals = 0;
    const origWinAdd = domWindow.addEventListener.bind(domWindow);
    const origWinRem = domWindow.removeEventListener.bind(domWindow);
    domWindow.addEventListener = (type: string, fn: any, opts?: any) => {
      if (type === "focus") focusAdds++;
      return origWinAdd(type, fn, opts);
    };
    domWindow.removeEventListener = (type: string, fn: any, opts?: any) => {
      if (type === "focus") focusRemovals++;
      return origWinRem(type, fn, opts);
    };
    const doc = domWindow.document;
    const origDocAdd = doc.addEventListener.bind(doc);
    const origDocRem = doc.removeEventListener.bind(doc);
    doc.addEventListener = (type: string, fn: any, opts?: any) => {
      if (type === "visibilitychange") visAdds++;
      return origDocAdd(type, fn, opts);
    };
    doc.removeEventListener = (type: string, fn: any, opts?: any) => {
      if (type === "visibilitychange") visRemovals++;
      return origDocRem(type, fn, opts);
    };

    const snapshotCalls: Array<{ projectRoot?: string }> = [];
    let currentView = makeViewFixture({ running: 1, projectRoot: "/repo/alpha", slug: "alpha-1" });
    const invoke = async (method: string, input: any) => {
      if (method === "factory.snapshot") {
        snapshotCalls.push(input ?? {});
        return { ok: true, view: currentView };
      }
      if (method === "factory.self.update.status") {
        return { ok: true, current: "0.12.5", latest: "0.12.5", updateAvailable: false };
      }
      if (method === "factory.open_design.status") {
        return { ok: true, link: null, updateAvailable: false, sourceAvailable: false };
      }
      return { ok: true };
    };

    const { subscribe, subs } = createMockSubscribe();
    const root = createRoot(container);

    // 1. Mount: initial snapshot fetched immediately while subscription is connecting (5s BUSY_MS fallback active).
    await act(() =>
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme: testTheme,
            dir: "/repo/alpha",
            layout: { compact: false, platform: "web" },
          }),
        ),
      ),
    );
    assert.equal(subs.length, 1);
    assert.equal(subs[0]!.method, "factory.state.updates");
    assert.deepEqual(subs[0]!.input, { projectRoot: "/repo/alpha" });
    assert.equal(snapshotCalls.length, 1, "mount fetches initial snapshot before ready resolves");
    assert.deepEqual(snapshotCalls[0], { projectRoot: "/repo/alpha" });
    assert.deepEqual(spy.activeDelays(), [BUSY_MS], "while connecting, adaptive BUSY_MS polling stays armed");
    assert.equal(focusAdds, 1);
    assert.equal(visAdds, 1);
    assert.match(container.textContent ?? "", /alpha-1/);

    // 2. Ready resolves -> transitions to live, fetches freshness snapshot, suppresses 5s BUSY_MS -> QUIET_MS.
    await act(async () => {
      subs[0]!.ready.resolve();
    });
    assert.equal(snapshotCalls.length, 2, "ready resolution triggers freshness snapshot");
    assert.deepEqual(spy.activeDelays(), [QUIET_MS], "live subscription suppresses 5s busy polling to QUIET_MS");
    assert.equal(focusRemovals, 0);
    assert.equal(visRemovals, 0);

    // 3. Push event -> immediate snapshot refresh without wiping rendered view or tearing down DOM listeners.
    currentView = makeViewFixture({ running: 1, projectRoot: "/repo/alpha", slug: "alpha-pushed" });
    await act(async () => {
      subs[0]!.observer.event({
        seq: 1,
        reasons: ["hook.agent.turn.after"],
        projectSlug: "alpha-1",
        projectRoot: "/repo/alpha",
        at: "2026-11-17T00:00:00.000Z",
      });
    });
    assert.equal(snapshotCalls.length, 3, "push event triggers immediate snapshot refresh");
    assert.match(container.textContent ?? "", /alpha-pushed/);
    assert.deepEqual(spy.activeDelays(), [QUIET_MS]);
    assert.equal(focusAdds, 1);
    assert.equal(focusRemovals, 0);
    assert.equal(visAdds, 1);
    assert.equal(visRemovals, 0);

    // 4. Focus & visibilitychange still trigger immediate snapshot refreshes while live.
    await act(async () => {
      domWindow.dispatchEvent(new domWindow.Event("focus"));
    });
    assert.equal(snapshotCalls.length, 4, "window focus refreshes even while subscription is live");
    await act(async () => {
      doc.dispatchEvent(new domWindow.Event("visibilitychange"));
    });
    assert.equal(snapshotCalls.length, 5, "visibilitychange refreshes even while subscription is live");

    // 5. Subscription closes/errors -> no reconnect thrashing, immediately reschedules BUSY_MS fallback.
    await act(async () => {
      subs[0]!.observer.closed(new Error("daemon does not support subscriptions"));
    });
    assert.equal(subs.length, 1, "closed/error subscription must not thrash reconnects");
    assert.deepEqual(spy.activeDelays(), [BUSY_MS], "dropping out of live restores BUSY_MS adaptive polling");
    assert.match(container.textContent ?? "", /alpha-pushed/, "last view remains rendered on fallback");

    // Firing the fallback poll timer works normally.
    await act(async () => {
      spy.fireLatest();
    });
    assert.equal(snapshotCalls.length, 6);

    // 6. scopeRoot change unsubscribes old root, subscribes to new root, fetches immediately and on ready.
    currentView = makeViewFixture({ running: 1, projectRoot: "/repo/beta", slug: "beta-1" });
    await act(() =>
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme: testTheme,
            dir: "/repo/beta",
            layout: { compact: false, platform: "web" },
          }),
        ),
      ),
    );
    assert.equal(subs[0]!.released, true, "old scopeRoot subscription is released");
    assert.equal(subs.length, 2);
    assert.deepEqual(subs[1]!.input, { projectRoot: "/repo/beta" });
    assert.equal(snapshotCalls.length, 7);
    assert.deepEqual(snapshotCalls[6], { projectRoot: "/repo/beta" });
    assert.match(container.textContent ?? "", /beta-1/);

    await act(async () => {
      subs[1]!.ready.resolve();
    });
    assert.equal(snapshotCalls.length, 8, "new scopeRoot ready resolution fetches freshness snapshot");
    assert.deepEqual(spy.activeDelays(), [QUIET_MS]);

    await act(() => root.unmount());
    assert.equal(subs[1]!.released, true);
    assert.equal(focusRemovals, 2, "only mount + scopeRoot change tore down focus listener");
    assert.equal(visRemovals, 2, "only mount + scopeRoot change tore down visibility listener");
  });
});

test("FactoryShell preserves 1s restarting-core refresh even when stateUpdates subscription is live", async (t) => {
  const { FactoryShell, PluginRpcProvider, QUIET_MS } = await loadHarness(t);
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const spy = withPollTimerSpy(t);

  await mountInDom(async ({ createRoot, container, act }) => {
    const view = makeViewFixture({ running: 1 });
    let snapshotCount = 0;
    const invoke = async (method: string) => {
      if (method === "factory.snapshot") {
        snapshotCount++;
        return { ok: true, view };
      }
      if (method === "factory.plugins.manage") {
        return { ok: false, code: "failed", error: "Plugin stopped: paseo-factory" };
      }
      if (method === "factory.plugins.check_updates") {
        return { ok: true, summary: "Up to date", updatesAvailable: [] };
      }
      return { ok: true };
    };
    const { subscribe, subs } = createMockSubscribe();
    const root = createRoot(container);

    await act(() =>
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme: testTheme,
            surface: "settings",
            layout: { compact: false, platform: "web" },
          }),
        ),
      ),
    );
    await act(async () => {
      subs[0]!.ready.resolve();
    });
    assert.deepEqual(spy.activeDelays(), [QUIET_MS]);

    const pluginsToggle = container.querySelector('[data-testid="settings-section-plugins-toggle"]') as HTMLElement | null;
    assert.ok(pluginsToggle, "Settings renders Plugins section toggle");
    await act(async () => {
      pluginsToggle.click();
    });

    const manageButtons = [...container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Manage"));
    assert.ok(manageButtons.length >= 1, "Settings PluginsPane renders Manage drawer toggle");
    await act(async () => {
      manageButtons[0]!.click();
    });

    const reloadButtons = [...container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Reload"));
    assert.ok(reloadButtons.length >= 1, "Settings PluginsPane renders Reload button");
    await act(async () => {
      reloadButtons[0]!.click();
    });
    assert.deepEqual(spy.activeDelays(), [1000], "restarting-core keeps 1s polling cadence even while live");

    const beforePollFire = snapshotCount;
    await act(async () => {
      spy.fireLatest();
    });
    assert.equal(snapshotCount, beforePollFire + 1);

    await act(() => root.unmount());
  });
});

test("<0.16.0 @getpaseo/plugin (missing defineSubscription): supportsClientSubscriptionHook=false, no subscribe calls, adaptive polling fallback", async (t) => {
  const {
    FactoryShell,
    PluginRpcProvider,
    supportsSubscriptionContract,
    supportsClientSubscriptionHook,
    canClientSubscribe,
    subscribeClientUpdates,
    BUSY_MS,
  } = await loadHarness(t, { legacyPluginPackage: true });
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const spy = withPollTimerSpy(t);

  assert.equal(supportsSubscriptionContract, false);
  assert.equal(supportsClientSubscriptionHook, false);
  assert.equal(canClientSubscribe({ subscribe: () => () => {} }), false);

  const states: string[] = [];
  let subscribeCalls = 0;
  const stop = subscribeClientUpdates({
    client: {
      subscribe: () => {
        subscribeCalls++;
        return Object.assign(() => {}, { ready: Promise.resolve(), release: async () => {} });
      },
    },
    contract: { name: "factory.state.updates" },
    input: {},
    onEvent: () => {},
    onStateChange: (s: { status: string }) => states.push(s.status),
  });
  assert.equal(subscribeCalls, 0);
  assert.equal(stop.state().status, "unsupported");
  assert.deepEqual(states, ["unsupported"]);
  stop();

  await mountInDom(async ({ createRoot, container, act }) => {
    const view = makeViewFixture({ running: 1, slug: "legacy-pkg-app" });
    let snapshots = 0;
    const invoke = async (method: string) => {
      if (method === "factory.snapshot") {
        snapshots++;
        return { ok: true, view };
      }
      if (method === "factory.self.update.status") return { ok: true, current: "0.12.5", latest: "0.12.5", updateAvailable: false };
      if (method === "factory.open_design.status") return { ok: true, link: null, updateAvailable: false, sourceAvailable: false };
      return { ok: true };
    };
    const root = createRoot(container);
    await act(() =>
      root.render(
        createElement(
          PluginRpcProvider,
          {
            invoke,
            subscribe: () => {
              subscribeCalls++;
              throw new Error("should not subscribe");
            },
          },
          createElement(FactoryShell, { theme: testTheme, dir: "/repo/alpha", layout: { compact: false, platform: "web" } }),
        ),
      ),
    );
    assert.equal(subscribeCalls, 0);
    assert.equal(snapshots, 1);
    assert.deepEqual(spy.activeDelays(), [BUSY_MS]);
    assert.match(container.textContent ?? "", /legacy-pkg-app/);
    await act(() => root.unmount());
  });
});

test("<0.16.0 @getpaseo/plugin/client (missing useSubscription): FactoryShell degrades cleanly to adaptive polling", async (t) => {
  const { FactoryShell, supportsClientSubscriptionHook, useClientSubscription, stateUpdates, BUSY_MS } = await loadHarness(t, {
    legacyClientHost: true,
  });
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const spy = withPollTimerSpy(t);

  assert.equal(supportsClientSubscriptionHook, false);

  await mountInDom(async ({ createRoot, container, act }) => {
    let hookStates: string[] = [];
    const HookProbe = () => {
      const state = useClientSubscription(stateUpdates, { projectRoot: "/repo" }, () => {});
      hookStates.push(state.status);
      return null;
    };
    const probeRoot = createRoot(container);
    await act(() => probeRoot.render(createElement(HookProbe)));
    await act(() => probeRoot.render(createElement(HookProbe)));
    assert.deepEqual(hookStates, ["unsupported", "unsupported"]);
    await act(() => probeRoot.unmount());

    const g = globalThis as Record<string, any>;
    const prior = g.__factoryClientRpc;
    let snapshots = 0;
    const view = makeViewFixture({ running: 1, slug: "legacy-client-app" });
    g.__factoryClientRpc = async (method: string) => {
      if (method === "factory.snapshot") {
        snapshots++;
        return { ok: true, view };
      }
      if (method === "factory.self.update.status") return { ok: true, current: "0.12.5", latest: "0.12.5", updateAvailable: false };
      if (method === "factory.open_design.status") return { ok: true, link: null, updateAvailable: false, sourceAvailable: false };
      return { ok: true };
    };
    try {
      const root = createRoot(container);
      await act(() =>
        root.render(createElement(FactoryShell, { theme: testTheme, dir: "/repo/alpha", layout: { compact: false, platform: "web" } })),
      );
      assert.equal(snapshots, 1);
      assert.deepEqual(spy.activeDelays(), [BUSY_MS]);
      assert.match(container.textContent ?? "", /legacy-client-app/);
      await act(() => root.unmount());
    } finally {
      g.__factoryClientRpc = prior;
    }
  });
});

test("<0.16.0 daemon ready rejection and synchronous subscribe throw fall back to adaptive polling without thrashing", async (t) => {
  const { FactoryShell, PluginRpcProvider, useClientSubscription, stateUpdates, BUSY_MS } = await loadHarness(t);
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const spy = withPollTimerSpy(t);

  await mountInDom(async ({ createRoot, container, act }) => {
    const view = makeViewFixture({ running: 1, slug: "legacy-daemon-app" });
    let snapshots = 0;
    const invoke = async (method: string) => {
      if (method === "factory.snapshot") {
        snapshots++;
        return { ok: true, view };
      }
      if (method === "factory.self.update.status") return { ok: true, current: "0.12.5", latest: "0.12.5", updateAvailable: false };
      if (method === "factory.open_design.status") return { ok: true, link: null, updateAvailable: false, sourceAvailable: false };
      return { ok: true };
    };

    const { subscribe, subs } = createMockSubscribe();
    const root = createRoot(container);
    await act(() =>
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, { theme: testTheme, dir: "/repo/alpha", layout: { compact: false, platform: "web" } }),
        ),
      ),
    );
    await act(async () => {
      subs[0]!.ready.reject(new Error("Unknown subscription method: factory.state.updates"));
    });
    assert.equal(subs.length, 1, "rejected ready does not retry or thrash");
    assert.equal(snapshots, 1);
    assert.deepEqual(spy.activeDelays(), [BUSY_MS]);
    assert.match(container.textContent ?? "", /legacy-daemon-app/);
    await act(() => root.unmount());

    // Also check synchronous subscribe throw -> error state, no thrash.
    let subCalls = 0;
    let lastState: any;
    const ErrorProbe = () => {
      lastState = useClientSubscription(stateUpdates, {}, () => {});
      return null;
    };
    const errorRoot = createRoot(container);
    await act(() =>
      errorRoot.render(
        createElement(
          PluginRpcProvider,
          {
            invoke,
            subscribe: () => {
              subCalls++;
              throw new Error("subscribe unsupported");
            },
          },
          createElement(ErrorProbe),
        ),
      ),
    );
    assert.equal(subCalls, 1);
    assert.equal(lastState.status, "error");
    assert.match(lastState.error.message, /subscribe unsupported/);
    await act(() => errorRoot.unmount());
  });
});

test("Hermes / React Native window: FactoryShell with live stateUpdates mounts, refreshes on push, and unmounts cleanly without DOM APIs", async (t) => {
  const { FactoryShell, PluginRpcProvider, QUIET_MS } = await loadHarness(t, { platformOs: "ios" });
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const spy = withPollTimerSpy(t);

  await mountInDom(async ({ createRoot, container, domWindow, act }) => {
    makeNativeWindow(domWindow);
    let currentView = makeViewFixture({ running: 1, slug: "mobile-initial" });
    let snapshots = 0;
    const invoke = async (method: string) => {
      if (method === "factory.snapshot") {
        snapshots++;
        return { ok: true, view: currentView };
      }
      if (method === "factory.self.update.status") return { ok: true, current: "0.12.5", latest: "0.12.5", updateAvailable: false };
      return { ok: true };
    };
    const { subscribe, subs } = createMockSubscribe();
    const root = createRoot(container);

    await act(() =>
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, { theme: testTheme, dir: "/repo/alpha", layout: { compact: true, platform: "ios" } }),
        ),
      ),
    );
    await act(async () => {
      subs[0]!.ready.resolve();
    });
    assert.equal(snapshots, 2);
    assert.deepEqual(spy.activeDelays(), [QUIET_MS]);

    currentView = makeViewFixture({ running: 1, slug: "mobile-pushed" });
    await act(async () => {
      subs[0]!.observer.event({ seq: 2, reasons: ["state.fs"], at: "2026-11-17T00:00:00.000Z" });
    });
    assert.equal(snapshots, 3);
    assert.match(container.textContent ?? "", /mobile-pushed/);

    await act(() => root.unmount());
    assert.equal(subs[0]!.released, true);
  });
});

test("subscribeClientUpdates & canClientSubscribe imperative helper lifecycle for T-23b-2", async (t) => {
  const { canClientSubscribe, subscribeClientUpdates, stateUpdates } = await loadHarness(t);

  assert.equal(canClientSubscribe(null), false);
  assert.equal(canClientSubscribe(undefined), false);
  assert.equal(canClientSubscribe({}), false);
  assert.equal(canClientSubscribe({ subscribe: "not-a-fn" }), false);
  assert.equal(canClientSubscribe({ subscribe: () => () => {} }), true);

  // 1. Happy path: connecting -> live -> events -> stop() calls handle and blocks late callbacks.
  const ready1 = deferred<void>();
  let capturedObserver1: any;
  let handle1Calls = 0;
  const states1: string[] = [];
  const events1: unknown[] = [];
  let readyCalls1 = 0;

  const stop1 = subscribeClientUpdates({
    client: {
      subscribe: (_contract: any, _input: any, onEvent: (e: unknown) => void, options: { onClosed?: (c: { error?: Error }) => void }) => {
        capturedObserver1 = { onEvent, onClosed: options?.onClosed };
        return Object.assign(() => {
          handle1Calls++;
        }, { ready: ready1.promise });
      },
    },
    contract: stateUpdates,
    input: {},
    onEvent: (e: unknown) => events1.push(e),
    onReady: () => {
      readyCalls1++;
    },
    onStateChange: (s: { status: string }) => states1.push(s.status),
  });

  assert.equal(stop1.state().status, "connecting");
  await Promise.resolve();
  ready1.resolve();
  await ready1.promise;
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(stop1.state().status, "live");
  assert.equal(readyCalls1, 1);
  assert.deepEqual(states1, ["connecting", "live"]);

  capturedObserver1.onEvent({ seq: 1 });
  assert.deepEqual(events1, [{ seq: 1 }]);

  stop1();
  stop1(); // idempotent
  assert.equal(handle1Calls, 1);
  capturedObserver1.onEvent({ seq: 2 });
  capturedObserver1.onClosed?.({});
  assert.deepEqual(events1, [{ seq: 1 }], "events after stop() are ignored");
  assert.equal(stop1.state().status, "live", "state does not change after stop()");

  // 2. Ready rejection -> error state, onReady not called.
  const ready2 = deferred<void>();
  let readyCalls2 = 0;
  const states2: Array<{ status: string; message?: string }> = [];
  const stop2 = subscribeClientUpdates({
    client: {
      subscribe: () => Object.assign(() => {}, { ready: ready2.promise }),
    },
    contract: stateUpdates,
    input: {},
    onEvent: () => {},
    onReady: () => {
      readyCalls2++;
    },
    onStateChange: (s: { status: string; error: Error | null }) =>
      states2.push({ status: s.status, ...(s.error ? { message: s.error.message } : {}) }),
  });
  ready2.reject(new Error("refused"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(readyCalls2, 0);
  assert.equal(stop2.state().status, "error");
  assert.equal(stop2.state().error?.message, "refused");
  assert.deepEqual(states2, [
    { status: "connecting" },
    { status: "error", message: "refused" },
  ]);

  // 3. onClosed without error -> closed; onClosed with error -> error; release() fallback when handle is object.
  let released3 = 0;
  let onClosed3: ((c: { error?: Error }) => void) | undefined;
  const stop3 = subscribeClientUpdates({
    client: {
      subscribe: (_c: any, _i: any, _e: any, opts: any) => {
        onClosed3 = opts?.onClosed;
        return {
          ready: Promise.resolve(),
          release: async () => {
            released3++;
          },
        };
      },
    },
    contract: stateUpdates,
    input: {},
    onEvent: () => {},
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(stop3.state().status, "live");
  onClosed3?.({});
  assert.equal(stop3.state().status, "closed");
  stop3();
  assert.equal(released3, 1);

  // 4. Synchronous throw from client.subscribe -> error state, safe stop().
  const stop4 = subscribeClientUpdates({
    client: {
      subscribe: () => {
        throw new Error("boom");
      },
    },
    contract: stateUpdates,
    input: {},
    onEvent: () => {},
  });
  assert.equal(stop4.state().status, "error");
  assert.equal(stop4.state().error?.message, "boom");
  stop4();
});

function makeDirectoryHarness(opts: {
  rpc?: (contract: { name: string }, input: unknown) => Promise<unknown>;
  subscribe?: (...args: any[]) => any;
} = {}) {
  const headers = new Map<string, { label: string; updates: string[]; removed: boolean }>();
  const pills = new Map<string, { label: string; updates: string[]; removed: boolean }>();
  const rpcCalls: Array<{ method: string; input: unknown }> = [];
  const defaultReply = () => ({
    ok: true,
    daemonError: null,
    projects: [{ slug: "app", root: "/project", workspaceId: "ws-1", needsYouCount: 0 }],
    seats: [
      {
        slug: "app",
        workspaceId: "ws-1",
        agentId: "lead-1",
        role: "lead",
        provider: "codex",
        model: "gpt-5",
        thinking: "high",
        lane: { provider: "codex", model: "gpt-5", thinking: "high", scope: "project" },
        pendingLane: null,
        handoff: null,
        allowedActions: ["switch-model", "hand-off-now"],
        context: null,
        contextUsedTokens: null,
        markTokens: 128000,
        handoffState: null,
        task: null,
        quickSwitchModels: [],
      },
    ],
  });
  let currentReply: any = defaultReply();
  const client: Record<string, any> = {
    rpc: async (contract: { name: string }, input: unknown) => {
      rpcCalls.push({ method: contract.name, input });
      if (opts.rpc) return opts.rpc(contract, input);
      return currentReply;
    },
    addHeaderButton: ({ id, button }: any) => {
      const rec = { label: button.label, updates: [] as string[], removed: false };
      headers.set(id, rec);
      return {
        update: (patch: any) => {
          if (patch.label !== undefined) {
            rec.label = patch.label;
            rec.updates.push(patch.label);
          }
        },
        remove: () => {
          rec.removed = true;
        },
      };
    },
    addComposerPill: ({ id, button }: any) => {
      const rec = { label: button.label, updates: [] as string[], removed: false };
      pills.set(id, rec);
      return {
        update: (patch: any) => {
          if (patch.label !== undefined) {
            rec.label = patch.label;
            rec.updates.push(patch.label);
          }
        },
        remove: () => {
          rec.removed = true;
        },
      };
    },
    openPanel: () => {},
  };
  if (opts.subscribe !== undefined) {
    client.subscribe = opts.subscribe;
  }
  return {
    client,
    headers,
    pills,
    rpcCalls,
    setReply: (next: any) => {
      currentReply = next;
    },
    makeReply: (needsYouCount: number, handoffState: string | null = null) => ({
      ...defaultReply(),
      projects: [{ slug: "app", root: "/project", workspaceId: "ws-1", needsYouCount }],
      seats: [{ ...defaultReply().seats[0]!, handoffState }],
    }),
  };
}

const flushMicrotasks = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

test("T-23b-2: startSeatDirectory on >=0.16.0 host subscribes globally to stateUpdates ({}), refreshes on ready & push without 20s polling, and cleans up on stop", async (t) => {
  const { startSeatDirectory, DIRECTORY_POLL_MS, stateUpdates } = await loadHarness(t);
  const spy = withDirectoryIntervalSpy(t);

  const subCalls: Array<{
    contract: unknown;
    input: unknown;
    onEvent: (e: unknown) => void;
    onClosed?: (c: { error?: Error }) => void;
    ready: ReturnType<typeof deferred<void>>;
    released: boolean;
  }> = [];

  const harness = makeDirectoryHarness({
    subscribe: (contract: unknown, input: unknown, onEvent: (e: unknown) => void, options?: { onClosed?: (c: { error?: Error }) => void }) => {
      const ready = deferred<void>();
      const rec = { contract, input, onEvent, onClosed: options?.onClosed, ready, released: false };
      subCalls.push(rec);
      return Object.assign(
        () => {
          rec.released = true;
        },
        {
          ready: ready.promise,
          release: async () => {
            rec.released = true;
          },
        },
      );
    },
  });

  const stop = startSeatDirectory(harness.client);
  assert.equal(subCalls.length, 1);
  assert.equal(subCalls[0]!.contract, stateUpdates);
  assert.deepEqual(subCalls[0]!.input, {});
  assert.deepEqual(spy.activeDelays(), [DIRECTORY_POLL_MS], "fallback interval stays armed while connecting");
  await flushMicrotasks();
  assert.equal(harness.rpcCalls.length, 1, "mount fetch runs immediately");
  assert.deepEqual(harness.rpcCalls[0], { method: "factory.seats.directory", input: {} });
  assert.equal(harness.headers.get("factory-header-ws-1")?.label, "Factory");
  assert.equal(harness.pills.get("factory-pill-lead-1")?.label, "lead");

  // Ready resolves -> transitions to live, clears 20s interval, and runs freshness tick.
  harness.setReply(harness.makeReply(2, "handing-over"));
  subCalls[0]!.ready.resolve();
  await flushMicrotasks();
  assert.deepEqual(spy.activeDelays(), [], "live subscription suppresses 20s polling");
  assert.equal(harness.rpcCalls.length, 2, "ready triggers freshness tick");
  assert.equal(harness.headers.get("factory-header-ws-1")?.label, "Factory · 2");
  assert.equal(harness.pills.get("factory-pill-lead-1")?.label, "lead · handing off");

  // Push event -> immediate refresh updates headers/pills while 20s polling stays suppressed.
  harness.setReply(harness.makeReply(0, null));
  subCalls[0]!.onEvent({ seq: 1, reasons: ["state.fs"], at: "2026-11-18T00:00:00.000Z" });
  await flushMicrotasks();
  assert.equal(harness.rpcCalls.length, 3, "push event triggers immediate directory refresh");
  assert.deepEqual(spy.activeDelays(), []);
  assert.equal(harness.headers.get("factory-header-ws-1")?.label, "Factory");
  assert.equal(harness.pills.get("factory-pill-lead-1")?.label, "lead");

  // Stop disposes subscription, removes headers/pills, and ignores late events.
  stop();
  assert.equal(subCalls[0]!.released, true, "stop disposes subscription");
  assert.equal(harness.headers.get("factory-header-ws-1")?.removed, true);
  assert.equal(harness.pills.get("factory-pill-lead-1")?.removed, true);
  assert.deepEqual(spy.activeDelays(), []);
  subCalls[0]!.onEvent({ seq: 2, reasons: ["state.fs"], at: "2026-11-18T00:00:01.000Z" });
  subCalls[0]!.onClosed?.({ error: new Error("late close") });
  await flushMicrotasks();
  assert.equal(harness.rpcCalls.length, 3, "late events after stop do not refresh");
  assert.deepEqual(spy.activeDelays(), [], "late close after stop does not re-arm interval");
});

test("T-23b-2: startSeatDirectory coalesces in-flight refreshes into one trailing tick and cancels queued tick on stop", async (t) => {
  const { startSeatDirectory } = await loadHarness(t);
  withDirectoryIntervalSpy(t);

  let rpcQueue: Array<ReturnType<typeof deferred<any>>> = [];
  let onEvent!: (e: unknown) => void;
  let ready!: ReturnType<typeof deferred<void>>;
  const harness = makeDirectoryHarness({
    rpc: () => {
      const d = deferred<any>();
      rpcQueue.push(d);
      return d.promise;
    },
    subscribe: (_c: unknown, _i: unknown, ev: (e: unknown) => void) => {
      onEvent = ev;
      ready = deferred<void>();
      return Object.assign(() => {}, { ready: ready.promise });
    },
  });

  const stop = startSeatDirectory(harness.client);
  assert.equal(rpcQueue.length, 1, "mount tick is in flight");

  // While mount tick is in flight, ready and multiple push events coalesce into one trailing tick.
  ready.resolve();
  await flushMicrotasks();
  onEvent({ seq: 1 });
  onEvent({ seq: 2 });
  onEvent({ seq: 3 });
  assert.equal(rpcQueue.length, 1, "no overlapping seatsDirectory RPC runs while inFlight");

  // Resolving the first RPC triggers exactly one trailing tick.
  rpcQueue[0]!.resolve(harness.makeReply(0, null));
  await flushMicrotasks();
  assert.equal(rpcQueue.length, 2, "exactly one coalesced trailing tick fires");
  assert.equal(harness.headers.get("factory-header-ws-1")?.label, "Factory");

  // Resolve trailing tick with updated data.
  rpcQueue[1]!.resolve(harness.makeReply(4, "scheduled"));
  await flushMicrotasks();
  assert.equal(rpcQueue.length, 2, "no extra tick after coalesced refresh finishes");
  assert.equal(harness.headers.get("factory-header-ws-1")?.label, "Factory · 4");
  assert.equal(harness.pills.get("factory-pill-lead-1")?.label, "lead · handing off");

  // Start another in-flight tick, queue a trailing refresh, then call stop() before resolution.
  onEvent({ seq: 4 });
  assert.equal(rpcQueue.length, 3);
  onEvent({ seq: 5 });
  stop();
  rpcQueue[2]!.resolve(harness.makeReply(9, null));
  await flushMicrotasks();
  assert.equal(rpcQueue.length, 3, "stop() cancels queued trailing tick");
  assert.equal(harness.headers.get("factory-header-ws-1")?.removed, true);
});

test("T-23b-2: startSeatDirectory falls back to DIRECTORY_POLL_MS on <0.16.0 host and <0.16.0 @getpaseo/plugin", async (t) => {
  // 1. Missing client.subscribe (<0.16.0 host)
  {
    const { startSeatDirectory, DIRECTORY_POLL_MS } = await loadHarness(t, { legacyClientHost: true });
    const spy = withDirectoryIntervalSpy(t);
    const harness = makeDirectoryHarness();

    const stop = startSeatDirectory(harness.client);
    await flushMicrotasks();
    assert.equal(harness.rpcCalls.length, 1);
    assert.deepEqual(spy.activeDelays(), [DIRECTORY_POLL_MS]);

    harness.setReply(harness.makeReply(3, null));
    spy.fireLatest();
    await flushMicrotasks();
    assert.equal(harness.rpcCalls.length, 2);
    assert.equal(harness.headers.get("factory-header-ws-1")?.label, "Factory · 3");

    stop();
    assert.deepEqual(spy.activeDelays(), []);
    assert.equal(harness.headers.get("factory-header-ws-1")?.removed, true);
  }

  // 2. Missing defineSubscription (<0.16.0 @getpaseo/plugin) even if client.subscribe exists
  {
    const { startSeatDirectory, DIRECTORY_POLL_MS, supportsSubscriptionContract } = await loadHarness(t, {
      legacyPluginPackage: true,
    });
    assert.equal(supportsSubscriptionContract, false);
    const spy = withDirectoryIntervalSpy(t);
    let subscribeCalls = 0;
    const harness = makeDirectoryHarness({
      subscribe: () => {
        subscribeCalls++;
        return Object.assign(() => {}, { ready: Promise.resolve() });
      },
    });

    const stop = startSeatDirectory(harness.client);
    await flushMicrotasks();
    assert.equal(subscribeCalls, 0, "never calls client.subscribe when supportsSubscriptionContract is false");
    assert.equal(harness.rpcCalls.length, 1);
    assert.deepEqual(spy.activeDelays(), [DIRECTORY_POLL_MS]);

    harness.setReply(harness.makeReply(1, null));
    spy.fireLatest();
    await flushMicrotasks();
    assert.equal(harness.rpcCalls.length, 2);
    assert.equal(harness.headers.get("factory-header-ws-1")?.label, "Factory · 1");

    stop();
    assert.deepEqual(spy.activeDelays(), []);
  }
});

test("T-23b-2: startSeatDirectory falls back to 20s polling without reconnect thrashing on ready reject, sync throw, close, and error", async (t) => {
  const { startSeatDirectory, DIRECTORY_POLL_MS } = await loadHarness(t);
  const spy = withDirectoryIntervalSpy(t);

  // 1. Ready rejection (<0.16.0 daemon) keeps 20s interval and does not retry subscribe.
  {
    let subscribeCalls = 0;
    const ready = deferred<void>();
    const harness = makeDirectoryHarness({
      subscribe: () => {
        subscribeCalls++;
        return Object.assign(() => {}, { ready: ready.promise });
      },
    });
    const stop = startSeatDirectory(harness.client);
    await flushMicrotasks();
    ready.reject(new Error("Unknown subscription method: factory.state.updates"));
    await flushMicrotasks();
    assert.equal(subscribeCalls, 1, "ready rejection does not thrash reconnects");
    assert.deepEqual(spy.activeDelays(), [DIRECTORY_POLL_MS]);

    harness.setReply(harness.makeReply(5, null));
    spy.fireLatest();
    await flushMicrotasks();
    assert.equal(harness.headers.get("factory-header-ws-1")?.label, "Factory · 5");
    stop();
    assert.deepEqual(spy.activeDelays(), []);
  }

  // 2. Synchronous subscribe throw keeps single 20s interval without thrash.
  {
    let subscribeCalls = 0;
    const beforeIntervals = spy.totalCreated();
    const harness = makeDirectoryHarness({
      subscribe: () => {
        subscribeCalls++;
        throw new Error("subscribe unavailable");
      },
    });
    const stop = startSeatDirectory(harness.client);
    await flushMicrotasks();
    assert.equal(subscribeCalls, 1);
    assert.equal(spy.totalCreated() - beforeIntervals, 1, "only one fallback interval created");
    assert.deepEqual(spy.activeDelays(), [DIRECTORY_POLL_MS]);
    stop();
    assert.deepEqual(spy.activeDelays(), []);
  }

  // 3. Live -> closed (no error) and Live -> error re-arm 20s polling without thrashing, keeping existing registrations.
  for (const closePayload of [{}, { error: new Error("transport dropped") }]) {
    let subscribeCalls = 0;
    let onClosed: ((c: { error?: Error }) => void) | undefined;
    const ready = deferred<void>();
    const harness = makeDirectoryHarness({
      subscribe: (_c: unknown, _i: unknown, _e: unknown, opts: { onClosed?: (c: { error?: Error }) => void }) => {
        subscribeCalls++;
        onClosed = opts?.onClosed;
        return Object.assign(() => {}, { ready: ready.promise });
      },
    });
    const stop = startSeatDirectory(harness.client);
    ready.resolve();
    await flushMicrotasks();
    assert.deepEqual(spy.activeDelays(), [], "live suppresses 20s polling");
    assert.equal(harness.headers.get("factory-header-ws-1")?.removed, false);

    onClosed?.(closePayload);
    await flushMicrotasks();
    assert.equal(subscribeCalls, 1, "close/error does not thrash reconnects");
    assert.deepEqual(spy.activeDelays(), [DIRECTORY_POLL_MS], "close/error restores 20s fallback polling");
    assert.equal(harness.headers.get("factory-header-ws-1")?.removed, false, "existing registrations stay intact");

    harness.setReply(harness.makeReply(7, null));
    spy.fireLatest();
    await flushMicrotasks();
    assert.equal(harness.headers.get("factory-header-ws-1")?.label, "Factory · 7");
    stop();
    assert.deepEqual(spy.activeDelays(), []);
    assert.equal(harness.headers.get("factory-header-ws-1")?.removed, true);
  }
});
