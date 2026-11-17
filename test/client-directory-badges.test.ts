/**
 * T-24c-2: Live sidebar `WorkspaceRowBadge` wiring in `startSeatDirectory`
 * (`plugin/client/factory/directory.tsx`):
 * - Shared store (`useSyncExternalStore`, no `class` syntax) fed by `seatsDirectory`
 *   via `stateUpdates` + `DIRECTORY_POLL_MS` with zero per-row RPC fan-out
 * - Lowercase-hyphen contribution id (`/^[a-z][a-z0-9-]*$/`) via `addWorkspaceRowBadgeItem`
 * - All `workspaceRowBadgePlan` states (`Needs you · N`, `Handing off`, `N active`,
 *   `N background`, idle `null`, non-Factory `null`) and failed-poll retention
 * - `< 0.16.0` host/SDK fallbacks, RN-like window safety, and teardown
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";
import type { ProjectDirectoryEntry } from "../plugin/shared/view.ts";

type Exports = Record<string, any>;

interface LoadOptions {
  hasWorkspaceRowBadge?: boolean;
  legacyPluginPackage?: boolean;
  platformOs?: "ios" | "android" | "web";
}

async function loadDirectoryModule(t: TestContext, opts: LoadOptions = {}): Promise<Exports> {
  const tmpDir = makeTempDir("dir-badges-client-");
  disposeDir(t, tmpDir);

  const virtualEntry = join(tmpDir, "entry.tsx");
  writeFileSync(
    virtualEntry,
    [
      `export { startSeatDirectory, DIRECTORY_POLL_MS, WORKSPACE_ROW_BADGE_ID } from ${JSON.stringify(join(repoRoot, "plugin/client/factory/directory.tsx"))};`,
      `export { stateUpdates } from ${JSON.stringify(join(repoRoot, "plugin/shared/rpc.ts"))};`,
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

  const hasBadgeComponent = opts.hasWorkspaceRowBadge ?? true;
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
        name: "directory-badge-test-adapters",
        setup(b) {
          if (opts.legacyPluginPackage) {
            b.onResolve({ filter: /^@getpaseo\/plugin$/ }, () => ({ path: legacyPluginPath }));
          }
          b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui|@getpaseo\/plugin\/client)$/ }, (args) => ({
            path: args.path,
            namespace: "rn-ui-adapter",
          }));
          b.onLoad({ filter: /.*/, namespace: "rn-ui-adapter" }, () => ({
            loader: "js",
            contents: `
              const React = require("react");
              const tag = (name) => ({ children, onPress, disabled, ...rest }) =>
                React.createElement(name, { disabled, onClick: onPress, "data-testid": rest.testID }, children);
              exports.View = tag("div");
              exports.Text = tag("span");
              exports.Pressable = tag("button");
              exports.Icon = () => null;
              exports.Platform = { OS: ${JSON.stringify(platformOs)}, select: (spec) => spec[${JSON.stringify(platformOs)}] ?? spec.default };
              ${
                hasBadgeComponent
                  ? `exports.WorkspaceRowBadge = ({ icon, label, tone, accessibilityLabel }) => {
                      if (typeof globalThis.__badgeRenderCount === "number") {
                        globalThis.__badgeRenderCount++;
                      }
                      return React.createElement("span", {
                        "data-badge": "workspace-row",
                        "data-icon": icon,
                        "data-tone": tone,
                        "aria-label": accessibilityLabel,
                      }, label);
                    };`
                  : ""
              }
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

function withIntervalSpy(t: TestContext) {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let nextId = 4_000_000;
  const intervals = new Map<number, { delay: number; fn: () => void; cleared: boolean }>();

  (globalThis as any).setInterval = (fn: () => void, delay = 0) => {
    const id = nextId++;
    intervals.set(id, { delay, fn, cleared: false });
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
    activeDelays: () => [...intervals.values()].filter((i) => !i.cleared).map((i) => i.delay),
    fireLatest: () => {
      const last = [...intervals.values()].filter((i) => !i.cleared).at(-1);
      assert.ok(last, "expected active interval");
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

const flush = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function makeProjectsReply(projects: ProjectDirectoryEntry[], overrides: { ok?: boolean; daemonError?: string | null; error?: string } = {}) {
  if (overrides.ok === false) return { ok: false, error: overrides.error ?? "rpc failed" };
  return {
    ok: true,
    daemonError: overrides.daemonError ?? null,
    projects,
    seats: [],
  };
}

function readRowBadge(container: HTMLElement, workspaceId: string) {
  const row = container.querySelector(`[data-row="${workspaceId}"]`);
  assert.ok(row, `expected row container for ${workspaceId}`);
  const badge = row.querySelector('[data-badge="workspace-row"]');
  if (!badge) return null;
  return {
    label: badge.textContent,
    tone: badge.getAttribute("data-tone"),
    icon: badge.getAttribute("data-icon"),
    accessibilityLabel: badge.getAttribute("aria-label"),
  };
}

test("registers addWorkspaceRowBadgeItem once with lowercase-hyphen id, updates all badge states reactively with zero per-row RPCs, and retains on failed poll", async (t) => {
  const { startSeatDirectory, WORKSPACE_ROW_BADGE_ID } = await loadDirectoryModule(t);
  const { createElement } = await import("react");
  withIntervalSpy(t);

  assert.match(WORKSPACE_ROW_BADGE_ID, /^[a-z][a-z0-9-]*$/);

  const g = globalThis as Record<string, unknown>;
  const savedRenderCount = g.__badgeRenderCount;
  g.__badgeRenderCount = 0;
  t.after(() => {
    g.__badgeRenderCount = savedRenderCount;
  });

  const rpcCalls: Array<{ method: string; input: unknown }> = [];
  const badgeRegistrations: Array<{ id: string; title: string; icon: string; Component: any; disposed: boolean }> = [];
  let onEvent!: (e: unknown) => void;
  let subReady!: ReturnType<typeof deferred<void>>;
  let currentReply: any = makeProjectsReply([
    { slug: "p-needs", root: "/r/needs", workspaceId: "ws-needs", needsYouCount: 2, handoffActive: true, activeWorkCount: 3, backgroundWorkCount: 4 },
    { slug: "p-handoff", root: "/r/handoff", workspaceId: "ws-handoff", needsYouCount: 0, handoffActive: true, activeWorkCount: 1, backgroundWorkCount: 2 },
    { slug: "p-active", root: "/r/active", workspaceId: "ws-active", needsYouCount: 0, handoffActive: false, activeWorkCount: 3, backgroundWorkCount: 2 },
    { slug: "p-bg", root: "/r/bg", workspaceId: "ws-bg", needsYouCount: 0, handoffActive: false, activeWorkCount: 0, backgroundWorkCount: 2 },
    { slug: "p-idle", root: "/r/idle", workspaceId: "ws-idle", needsYouCount: 0, handoffActive: false, activeWorkCount: 0, backgroundWorkCount: 0 },
  ]);

  const client: any = {
    rpc: async (contract: { name: string }, input: unknown) => {
      rpcCalls.push({ method: contract.name, input });
      return currentReply;
    },
    subscribe: (_c: unknown, _i: unknown, ev: (e: unknown) => void) => {
      onEvent = ev;
      subReady = deferred<void>();
      return Object.assign(() => {}, { ready: subReady.promise });
    },
    addHeaderButton: () => ({ update() {}, remove() {} }),
    addComposerPill: () => ({ update() {}, remove() {} }),
    addWorkspaceRowBadgeItem: (contrib: { id: string; title: string; icon: string; Component: any }) => {
      const rec = { ...contrib, disposed: false };
      badgeRegistrations.push(rec);
      return () => {
        rec.disposed = true;
      };
    },
    openPanel: () => {},
  };

  await mountInDom(async ({ createRoot, container, act }) => {
    const stop = startSeatDirectory(client);
    assert.equal(badgeRegistrations.length, 1, "registers exactly one workspace row badge item");
    const reg = badgeRegistrations[0]!;
    assert.equal(reg.id, WORKSPACE_ROW_BADGE_ID);
    assert.match(reg.id, /^[a-z][a-z0-9-]*$/);
    assert.equal(reg.title, "Factory");
    assert.equal(reg.icon, "Activity");

    const WorkspaceList = ({ ids }: { ids: string[] }) =>
      createElement(
        "div",
        null,
        ids.map((workspaceId) =>
          createElement(
            "div",
            { key: workspaceId, "data-row": workspaceId },
            createElement(reg.Component, {
              workspaceId,
              theme: { colors: {} },
              host: { id: "local", label: "Local" },
              layout: { compact: false, platform: "web" },
            }),
          ),
        ),
      );

    const rows = ["ws-needs", "ws-handoff", "ws-active", "ws-bg", "ws-idle", "ws-non-factory"];
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(WorkspaceList, { ids: rows }));
      await flush();
    });

    assert.equal(rpcCalls.length, 1, "mounting 6 workspace rows causes zero per-row RPCs");
    assert.deepEqual(rpcCalls[0], { method: "factory.seats.directory", input: {} });

    assert.deepEqual(readRowBadge(container, "ws-needs"), {
      label: "Needs you · 2",
      tone: "warning",
      icon: "AlertTriangle",
      accessibilityLabel: "Factory: Needs you · 2",
    });
    assert.deepEqual(readRowBadge(container, "ws-handoff"), {
      label: "Handing off",
      tone: "info",
      icon: "RefreshCw",
      accessibilityLabel: "Factory: Handing off",
    });
    assert.deepEqual(readRowBadge(container, "ws-active"), {
      label: "3 active",
      tone: "success",
      icon: "Activity",
      accessibilityLabel: "Factory: 3 active seats",
    });
    assert.deepEqual(readRowBadge(container, "ws-bg"), {
      label: "2 background",
      tone: "warning",
      icon: "Activity",
      accessibilityLabel: "Factory: 2 background processes running",
    });
    assert.equal(readRowBadge(container, "ws-idle"), null, "idle Project renders null");
    assert.equal(readRowBadge(container, "ws-non-factory"), null, "non-Factory workspace renders null");

    // Ready triggers freshness tick; identical projects do not re-render badges.
    const rendersBeforeIdenticalTick = g.__badgeRenderCount as number;
    await act(async () => {
      subReady.resolve();
      await flush();
    });
    assert.equal(rpcCalls.length, 2, "ready triggers single directory refresh");
    assert.equal(g.__badgeRenderCount, rendersBeforeIdenticalTick, "identical projects snapshot avoids redundant badge re-renders");

    // Push event transitions all rows reactively with still one RPC total.
    currentReply = makeProjectsReply([
      { slug: "p-needs", root: "/r/needs", workspaceId: "ws-needs", needsYouCount: 0, handoffActive: false, activeWorkCount: 0, backgroundWorkCount: 0 },
      { slug: "p-handoff", root: "/r/handoff", workspaceId: "ws-handoff", needsYouCount: 1, handoffActive: false, activeWorkCount: 0, backgroundWorkCount: 0 },
      { slug: "p-active", root: "/r/active", workspaceId: "ws-active", needsYouCount: 0, handoffActive: false, activeWorkCount: 0, backgroundWorkCount: 1 },
      { slug: "p-bg", root: "/r/bg", workspaceId: "ws-bg", needsYouCount: 0, handoffActive: false, activeWorkCount: 1, backgroundWorkCount: 0 },
      { slug: "p-idle", root: "/r/idle", workspaceId: "ws-idle", needsYouCount: 0, handoffActive: true, activeWorkCount: 0, backgroundWorkCount: 0 },
    ]);
    await act(async () => {
      onEvent({ seq: 1, reasons: ["state.fs"], at: "2026-11-18T00:00:00.000Z" });
      await flush();
    });
    assert.equal(rpcCalls.length, 3, "push triggers exactly one directory RPC regardless of mounted row count");
    assert.equal(badgeRegistrations.length, 1, "still only one contribution registered");
    assert.equal(readRowBadge(container, "ws-needs"), null);
    assert.deepEqual(readRowBadge(container, "ws-handoff"), {
      label: "Needs you · 1",
      tone: "warning",
      icon: "AlertTriangle",
      accessibilityLabel: "Factory: Needs you · 1",
    });
    assert.deepEqual(readRowBadge(container, "ws-active"), {
      label: "1 background",
      tone: "warning",
      icon: "Activity",
      accessibilityLabel: "Factory: 1 background process running",
    });
    assert.deepEqual(readRowBadge(container, "ws-bg"), {
      label: "1 active",
      tone: "success",
      icon: "Activity",
      accessibilityLabel: "Factory: 1 active seat",
    });
    assert.deepEqual(readRowBadge(container, "ws-idle"), {
      label: "Handing off",
      tone: "info",
      icon: "RefreshCw",
      accessibilityLabel: "Factory: Handing off",
    });

    // Failed poll (daemonError or ok: false) retains last badges.
    currentReply = makeProjectsReply([], { daemonError: "daemon down" });
    await act(async () => {
      onEvent({ seq: 2, reasons: ["state.fs"], at: "2026-11-18T00:00:01.000Z" });
      await flush();
    });
    assert.equal(readRowBadge(container, "ws-handoff")?.label, "Needs you · 1");

    currentReply = makeProjectsReply([], { ok: false, error: "transport closed" });
    await act(async () => {
      onEvent({ seq: 3, reasons: ["state.fs"], at: "2026-11-18T00:00:02.000Z" });
      await flush();
    });
    assert.equal(readRowBadge(container, "ws-bg")?.label, "1 active");

    // Teardown disposes registration and clears store so remaining mounted components drop to null.
    await act(async () => {
      stop();
      await flush();
    });
    assert.equal(reg.disposed, true, "stop() disposes addWorkspaceRowBadgeItem registration");
    assert.equal(readRowBadge(container, "ws-handoff"), null);
    assert.equal(readRowBadge(container, "ws-bg"), null);

    // Late push event after stop does not re-populate store or trigger RPC.
    const callsAtStop = rpcCalls.length;
    currentReply = makeProjectsReply([
      { slug: "p-handoff", root: "/r/handoff", workspaceId: "ws-handoff", needsYouCount: 9 },
    ]);
    await act(async () => {
      onEvent({ seq: 4, reasons: ["state.fs"], at: "2026-11-18T00:00:03.000Z" });
      await flush();
    });
    assert.equal(rpcCalls.length, callsAtStop);
    assert.equal(readRowBadge(container, "ws-handoff"), null);

    await act(() => root.unmount());
  });
});

test("DIRECTORY_POLL_MS fallback updates workspace row badges reactively and stop cancels in-flight writes", async (t) => {
  const { startSeatDirectory, DIRECTORY_POLL_MS } = await loadDirectoryModule(t);
  const { createElement } = await import("react");
  const spy = withIntervalSpy(t);

  const first = deferred<any>();
  const second = deferred<any>();
  const third = deferred<any>();
  const queue = [first, second, third];
  let rpcCount = 0;
  let Component!: any;
  let disposed = false;

  const client: any = {
    rpc: () => queue[rpcCount++]!.promise,
    addHeaderButton: () => ({ update() {}, remove() {} }),
    addComposerPill: () => ({ update() {}, remove() {} }),
    addWorkspaceRowBadgeItem: (contrib: { Component: any }) => {
      Component = contrib.Component;
      return () => {
        disposed = true;
      };
    },
    openPanel: () => {},
  };

  await mountInDom(async ({ createRoot, container, act }) => {
    const stop = startSeatDirectory(client);
    assert.deepEqual(spy.activeDelays(), [DIRECTORY_POLL_MS]);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          "div",
          { "data-row": "ws-1" },
          createElement(Component, {
            workspaceId: "ws-1",
            theme: { colors: {} },
            host: { id: "local", label: "Local" },
            layout: { compact: false, platform: "web" },
          }),
        ),
      );
      await flush();
    });
    assert.equal(readRowBadge(container, "ws-1"), null, "initial pending RPC renders null");

    await act(async () => {
      first.resolve(makeProjectsReply([{ slug: "a", root: "/a", workspaceId: "ws-1", needsYouCount: 0, activeWorkCount: 2 }]));
      await flush();
    });
    assert.equal(readRowBadge(container, "ws-1")?.label, "2 active");

    await act(async () => {
      spy.fireLatest();
      second.resolve(makeProjectsReply([{ slug: "a", root: "/a", workspaceId: "ws-1", needsYouCount: 0, backgroundWorkCount: 1 }]));
      await flush();
    });
    assert.equal(rpcCount, 2);
    assert.equal(readRowBadge(container, "ws-1")?.label, "1 background");

    // In-flight RPC resolved after stop() must not repopulate store.
    await act(async () => {
      spy.fireLatest();
      stop();
      third.resolve(makeProjectsReply([{ slug: "a", root: "/a", workspaceId: "ws-1", needsYouCount: 5 }]));
      await flush();
    });
    assert.equal(disposed, true);
    assert.deepEqual(spy.activeDelays(), []);
    assert.equal(readRowBadge(container, "ws-1"), null);

    await act(() => root.unmount());
  });
});

test("<0.16.0 fallbacks: missing addWorkspaceRowBadgeItem or missing WorkspaceRowBadge never throw", async (t) => {
  // 1. Host missing addWorkspaceRowBadgeItem (<0.16.0 host)
  {
    const { startSeatDirectory } = await loadDirectoryModule(t, { hasWorkspaceRowBadge: true, legacyPluginPackage: true });
    withIntervalSpy(t);
    const headers: string[] = [];
    const stop = startSeatDirectory({
      rpc: async () => makeProjectsReply([{ slug: "a", root: "/a", workspaceId: "ws-1", needsYouCount: 1 }]),
      addHeaderButton: ({ id }: any) => {
        headers.push(id);
        return { update() {}, remove() {} };
      },
      addComposerPill: () => ({ update() {}, remove() {} }),
      openPanel: () => {},
    } as any);
    await flush();
    assert.deepEqual(headers, ["factory-header-ws-1"], "header buttons still register on <0.16.0 hosts");
    stop();
  }

  // 2. SDK missing WorkspaceRowBadge (<0.16.0 @getpaseo/plugin/client/ui) even when addWorkspaceRowBadgeItem exists
  {
    const { startSeatDirectory } = await loadDirectoryModule(t, { hasWorkspaceRowBadge: false });
    withIntervalSpy(t);
    let badgeRegCount = 0;
    const stop = startSeatDirectory({
      rpc: async () => makeProjectsReply([{ slug: "a", root: "/a", workspaceId: "ws-1", needsYouCount: 1 }]),
      addHeaderButton: () => ({ update() {}, remove() {} }),
      addComposerPill: () => ({ update() {}, remove() {} }),
      addWorkspaceRowBadgeItem: () => {
        badgeRegCount++;
        return () => {};
      },
      openPanel: () => {},
    } as any);
    await flush();
    assert.equal(badgeRegCount, 0, "skips registration cleanly when WorkspaceRowBadge component is absent");
    stop();
  }
});

test("RN / Hermes window: WorkspaceRowBadgeItem mounts, updates reactively, and unmounts without DOM APIs", async (t) => {
  const { startSeatDirectory } = await loadDirectoryModule(t, { platformOs: "ios" });
  const { createElement } = await import("react");
  withIntervalSpy(t);

  await mountInDom(async ({ createRoot, container, domWindow, act }) => {
    for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
      Object.defineProperty(domWindow, key, { value: undefined, configurable: true, writable: true });
    }
    delete (globalThis as Record<string, unknown>).document;

    let Component!: any;
    let onEvent!: (e: unknown) => void;
    let reply = makeProjectsReply([{ slug: "mob", root: "/mob", workspaceId: "ws-mob", needsYouCount: 1 }]);

    const stop = startSeatDirectory({
      rpc: async () => reply,
      subscribe: (_c: unknown, _i: unknown, ev: (e: unknown) => void) => {
        onEvent = ev;
        return Object.assign(() => {}, { ready: Promise.resolve() });
      },
      addHeaderButton: () => ({ update() {}, remove() {} }),
      addComposerPill: () => ({ update() {}, remove() {} }),
      addWorkspaceRowBadgeItem: (contrib: { Component: any }) => {
        Component = contrib.Component;
        return () => {};
      },
      openPanel: () => {},
    } as any);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          "div",
          { "data-row": "ws-mob" },
          createElement(Component, {
            workspaceId: "ws-mob",
            theme: { colors: {} },
            host: { id: "local", label: "Local" },
            layout: { compact: true, platform: "ios" },
          }),
        ),
      );
      await flush();
    });
    assert.match(container.innerHTML, /data-badge="workspace-row"[^>]*>Needs you · 1</);

    reply = makeProjectsReply([{ slug: "mob", root: "/mob", workspaceId: "ws-mob", needsYouCount: 0, activeWorkCount: 1 }]);
    await act(async () => {
      onEvent({ seq: 1 });
      await flush();
    });
    assert.match(container.innerHTML, /data-badge="workspace-row"[^>]*>1 active</);

    await act(async () => {
      stop();
      await root.unmount();
    });
  });
});
