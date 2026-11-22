/**
 * Seam 2 (Ticket 06, ADR 0068): Single-tab `Factory overview` UI (read-only),
 * live `overview` + `stateUpdates` wiring, and desktop sidebar consolidation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { repoRoot } from "./helpers.ts";
import { testTheme } from "./client-markup.ts";
import type { FactoryOverviewView, GateQueueEntryView, OverviewProjectEntry } from "../plugin/shared/view.ts";

type Exports = Record<string, any>;

async function loadOverviewModule(
  entry: string,
  options: { platformOs?: "web" | "ios" | "android"; withSubscription?: boolean } = {},
): Promise<Exports> {
  const platformOs = options.platformOs ?? "web";
  const withSubscription = options.withSubscription ?? true;
  const bundle = await build({
    entryPoints: [join(repoRoot, entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    plugins: [
      {
        name: "overview-native-adapter",
        setup(b) {
          b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui|@getpaseo\/plugin\/client)$/ }, (args) => ({
            path: args.path,
            namespace: "native",
          }));
          b.onLoad({ filter: /.*/, namespace: "native" }, () => ({
            loader: "js",
            contents: `
              const React = require('react');
              const tag = (name) => ({ children, onPress, disabled, style, ...rest }) =>
                React.createElement(
                  name,
                  {
                    disabled,
                    onClick: onPress,
                    'data-testid': rest.testID,
                    'data-role': rest.accessibilityRole,
                    'aria-label': rest.accessibilityLabel,
                    'data-style': typeof style === 'object' && style !== null ? JSON.stringify(style) : undefined,
                  },
                  typeof children === 'function' ? children({ pressed: false }) : children,
                );
              exports.View = tag('div');
              exports.ScrollView = tag('div');
              exports.Text = tag('span');
              exports.Pressable = tag('button');
              exports.TextInput = ({ value, placeholder, ...rest }) =>
                React.createElement('input', { value: value ?? '', placeholder, 'data-testid': rest.testID, readOnly: true });
              exports.Icon = ({ name }) => React.createElement('span', { 'data-icon': name });
              exports.Loading = () => React.createElement('div', { 'data-testid': 'host-loading' }, 'Loading...');
              exports.SidebarRow = ({ id, icon, label, onPress, active, trailing }) =>
                React.createElement(
                  'div',
                  { 'data-sidebar-row': id ?? 'default', 'data-active': String(Boolean(active)), 'data-icon': icon },
                  React.createElement('button', { onClick: onPress }, label),
                  trailing ? React.createElement('span', { 'data-testid': 'sidebar-row-trailing' }, trailing) : null,
                );
              exports.WorkspaceRowBadge = ({ label, tone, icon, accessibilityLabel }) =>
                React.createElement('span', { 'data-badge': 'workspace-row', 'data-tone': tone, 'data-icon': icon, 'aria-label': accessibilityLabel }, label);
              const Modal = ({ children, open, title }) =>
                open ? React.createElement('div', { 'data-testid': 'host-modal', 'data-modal-title': title }, children) : null;
              Modal.Content = tag('div');
              exports.Modal = Modal;
              exports.copyText = async (text) => {
                globalThis.__overviewTestCopied?.push(text);
              };
              exports.useToast = () => ({
                show(msg, opts) { globalThis.__overviewTestToasts?.push({ msg, opts }); },
                error(msg) { globalThis.__overviewTestToasts?.push({ msg, error: true }); },
              });
              exports.useRpc = (contract) => (input) => globalThis.__overviewTestRpc(contract.name, input);
              ${
                withSubscription
                  ? `
              exports.useSubscription = (contract, input, onEvent) => {
                const subFn = globalThis.__overviewTestUseSubscription;
                return subFn ? subFn(contract, input, onEvent) : { status: 'connecting' };
              };
              `
                  : ""
              }
              exports.useWorkspace = () => {
                throw new Error('Plugin state hooks must run inside a plugin host');
              };
              exports.useWorkspaces = () => {
                throw new Error('Plugin state hooks must run inside a plugin host');
              };
              exports.useProjects = () => {
                throw new Error('Plugin state hooks must run inside a plugin host');
              };
              exports.useProject = () => {
                throw new Error('Plugin state hooks must run inside a plugin host');
              };
              exports.usePaseo = () => ({ projects: { list: async () => ({ projects: [] }), subscribe: () => () => {} }, workspaces: { list: async () => ({ entries: [] }) } });
              exports.openExternalUrl = async () => {};
              exports.Platform = {
                OS: ${JSON.stringify(platformOs)},
                select: (spec) => (spec[${JSON.stringify(platformOs)}] !== undefined ? spec[${JSON.stringify(platformOs)}] : spec.default),
              };
            `,
          }));
        },
      },
    ],
  });
  const compiled = { exports: {} as Exports };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), compiled, compiled.exports);
  return compiled.exports;
}

async function mountDom<T>(
  run: (
    createRoot: typeof import("react-dom/client").createRoot,
    container: HTMLElement,
    act: (fn: () => void | Promise<void>) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  try {
    return await run(createRoot, dom.window.document.getElementById("root")!, (fn) =>
      act(async () => {
        await fn();
      }),
    );
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
}

function makeQueueEntry(overrides: Partial<GateQueueEntryView> = {}): GateQueueEntryView {
  return {
    id: "gq-run-1",
    projectSlug: "alpha-111111",
    projectName: "Alpha",
    projectRoot: "/work/alpha",
    workspaceId: "ws-alpha",
    task: "TA-1",
    attempt: 1,
    status: "running",
    queuedAt: "2026-11-22T10:00:00.000Z",
    startedAt: "2026-11-22T10:00:01.000Z",
    waitMs: 1_000,
    elapsedMs: 42_000,
    timeoutMs: 900_000,
    position: 1,
    aheadCount: 0,
    ahead: [],
    logPath: "/state/projects/alpha-111111/gate-TA-1-1.log",
    logExists: true,
    agentId: "agent-peer-alpha",
    ...overrides,
  };
}

function makeProjectEntry(overrides: Partial<OverviewProjectEntry> = {}): OverviewProjectEntry {
  return {
    slug: "alpha-111111",
    name: "Alpha",
    root: "/work/alpha",
    workspaceId: "ws-alpha",
    needsYouCount: 0,
    handoffActive: false,
    supervisor: { statusLabel: "idle", tone: "normal", vacant: false, agentId: "sup-alpha" },
    lead: { statusLabel: "working", tone: "normal", vacant: false, agentId: "lead-alpha" },
    peers: [{ agentId: "peer-alpha", task: "TA-1", disposition: "engineer", statusLabel: "working", tone: "normal" }],
    latestGate: { state: "running", verdict: null, task: "TA-1", attempt: 1, ts: "2026-11-22T10:00:01.000Z", note: null },
    gateQueueStatus: "running",
    gateQueuePosition: 1,
    ...overrides,
  };
}

function makeOverviewFixture(overrides: Partial<FactoryOverviewView> = {}): FactoryOverviewView {
  return {
    generatedAt: "2026-11-22T10:00:43.000Z",
    daemonError: null,
    gateQueue: {
      paused: false,
      pausedAt: null,
      concurrency: 1,
      running: [makeQueueEntry()],
      queued: [
        makeQueueEntry({
          id: "gq-q-2",
          projectSlug: "beta-222222",
          projectName: "Beta",
          projectRoot: "/work/beta",
          workspaceId: "ws-beta",
          task: "TB-2",
          attempt: 2,
          status: "queued",
          queuedAt: "2026-11-22T09:58:38.000Z",
          startedAt: null,
          waitMs: 125_000,
          elapsedMs: null,
          position: 2,
          aheadCount: 1,
          ahead: [{ id: "gq-run-1", projectSlug: "alpha-111111", projectName: "Alpha", task: "TA-1", attempt: 1, status: "running" }],
          logPath: null,
          logExists: false,
        }),
        makeQueueEntry({
          id: "gq-q-3",
          projectSlug: "gamma-333333",
          projectName: "Gamma",
          projectRoot: "/work/gamma",
          workspaceId: null,
          task: "TG-3",
          attempt: 1,
          status: "queued",
          queuedAt: "2026-11-22T10:00:38.000Z",
          startedAt: null,
          waitMs: 5_000,
          elapsedMs: null,
          position: 3,
          aheadCount: 2,
          ahead: [{ id: "gq-run-1", projectSlug: "alpha-111111", projectName: "Alpha", task: "TA-1", attempt: 1, status: "running" }],
          logPath: null,
          logExists: false,
        }),
      ],
    },
    projects: [
      makeProjectEntry(),
      makeProjectEntry({
        slug: "beta-222222",
        name: "Beta",
        root: "/work/beta",
        workspaceId: "ws-beta",
        needsYouCount: 2,
        handoffActive: false,
        supervisor: { statusLabel: "waiting for permission", tone: "waiting", vacant: false, agentId: "sup-beta" },
        lead: { statusLabel: "idle", tone: "normal", vacant: false, agentId: "lead-beta" },
        peers: [{ agentId: "peer-beta", task: "TB-2", disposition: "reviewer", statusLabel: "idle", tone: "normal" }],
        latestGate: { state: "queued", verdict: null, task: "TB-2", attempt: 2, ts: "2026-11-22T09:58:38.000Z", note: null },
        gateQueueStatus: "queued",
        gateQueuePosition: 2,
      }),
    ],
    ...overrides,
  };
}

test("FactoryOverviewView renders single-view Gate queue + Projects roster with FACTORY_PALETTE colors, test hooks, and zero sub-tabs", async () => {
  const { FactoryOverviewView } = await loadOverviewModule("plugin/client/factory/overview-screen.tsx");
  const { FACTORY_PALETTE } = await loadOverviewModule("plugin/client/kit/theme.ts");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");

  const view = makeOverviewFixture({
    gateQueue: {
      ...makeOverviewFixture().gateQueue,
      paused: true,
      pausedAt: "2026-11-22T10:00:30.000Z",
      concurrency: 2,
    },
  });

  const html = renderToStaticMarkup(
    createElement(FactoryOverviewView, {
      theme: testTheme,
      view,
      now: Date.parse("2026-11-22T10:00:43.000Z"),
    }),
  );

  // Required E2E read hooks
  for (const id of [
    "factory-overview-screen",
    "factory-overview-gate-queue",
    "factory-overview-projects-list",
    "factory-overview-onboard-button",
  ]) {
    assert.ok(html.includes(`data-testid="${id}"`), `renders ${id}`);
  }

  // Strictly single-view: no sub-tabs, no retired Kanban/Timeline/Ledger/Seat-graph widgets
  assert.doesNotMatch(html, /data-role="tab"/, "single-view overview has no sub-tabs");
  assert.doesNotMatch(html, /Kanban|Swimlane|Seat Graph/i);

  // Top section: Gate queue running, paused, concurrency, FIFO queued #2/#3, elapsed & wait times, open-log
  const queueHtml = html.slice(html.indexOf("factory-overview-gate-queue"), html.indexOf("factory-overview-projects-list"));
  assert.match(queueHtml, /Gate queue/);
  assert.match(queueHtml, /Paused/);
  assert.match(queueHtml, /Concurrency · 2/);
  assert.match(queueHtml, /Alpha/);
  assert.match(queueHtml, /TA-1/);
  assert.match(queueHtml, /Attempt 1/);
  assert.match(queueHtml, /42s/);
  assert.ok(queueHtml.includes('data-testid="factory-overview-gate-log-gq-run-1"'));
  assert.match(queueHtml, /#2/);
  assert.match(queueHtml, /Beta/);
  assert.match(queueHtml, /TB-2/);
  assert.match(queueHtml, /2m 5s/);
  assert.match(queueHtml, /#3/);
  assert.match(queueHtml, /Gamma/);
  assert.match(queueHtml, /TG-3/);
  assert.match(queueHtml, /5s/);

  // Bottom section: Projects roster with FACTORY_PALETTE colors, Needs you, latestGate, and + Onboard Project
  const projectsHtml = html.slice(html.indexOf("factory-overview-projects-list"));
  assert.match(projectsHtml, /\+ Onboard Project/);
  assert.match(projectsHtml, /Alpha/);
  assert.match(projectsHtml, /Beta/);
  assert.match(projectsHtml, /Needs you · 2/);
  assert.match(projectsHtml, /Gate running · TA-1 #1/);
  assert.match(projectsHtml, /Gate #2 · TB-2/);
  assert.ok(projectsHtml.includes(FACTORY_PALETTE.light.supervisor), "uses FACTORY_PALETTE supervisor token");
  assert.ok(projectsHtml.includes(FACTORY_PALETTE.light.lead), "uses FACTORY_PALETTE lead token");
  assert.ok(projectsHtml.includes(FACTORY_PALETTE.light.peer), "uses FACTORY_PALETTE peer token");
  assert.ok(projectsHtml.includes(FACTORY_PALETTE.light.disposition.engineer), "uses FACTORY_PALETTE disposition token");
});

test("FactoryOverviewView renders empty Gate queue and green/red latestGate states cleanly", async () => {
  const { FactoryOverviewView } = await loadOverviewModule("plugin/client/factory/overview-screen.tsx");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");

  const idleView = makeOverviewFixture({
    gateQueue: { paused: false, pausedAt: null, concurrency: 1, running: [], queued: [] },
    projects: [
      makeProjectEntry({
        slug: "green-proj",
        name: "GreenProj",
        peers: [],
        latestGate: { state: "green", verdict: "green", task: "T-1", attempt: 1, ts: "2026-11-22T09:55:43.000Z", note: null },
        gateQueueStatus: null,
        gateQueuePosition: null,
      }),
      makeProjectEntry({
        slug: "red-proj",
        name: "RedProj",
        peers: [],
        latestGate: { state: "red", verdict: "red", task: "T-2", attempt: 3, ts: "2026-11-22T09:50:43.000Z", note: "attempt-ceiling" },
        gateQueueStatus: null,
        gateQueuePosition: null,
      }),
    ],
  });

  const html = renderToStaticMarkup(
    createElement(FactoryOverviewView, {
      theme: testTheme,
      view: idleView,
      now: Date.parse("2026-11-22T10:00:43.000Z"),
      onTogglePause: () => {},
    }),
  );

  assert.match(html, /No Gates running or queued\./);
  assert.ok(html.includes('data-testid="factory-queue-pause-toggle"'), "empty queue still exposes Pause queue toggle");
  assert.match(html, /Pause queue/);
  assert.match(html, /Gate green · T-1 #1 · 5m ago/);
  assert.match(html, /Gate red · T-2 #3 · 10m ago/);
});

test("OverviewScreen loads via factory.overview, refreshes on stateUpdates, opens log modal with copyText, jumps to workspace+panel with focusHost gate, and opens Onboard Screen", async () => {
  const { OverviewScreen } = await loadOverviewModule("plugin/client/factory/overview-screen.tsx", { platformOs: "web" });
  const { createElement } = await import("react");

  const rpcCalls: Array<{ name: string; input: unknown }> = [];
  const copied: string[] = [];
  const toasts: any[] = [];
  let subCallback: ((ev: unknown) => void) | undefined;
  let currentOverview = makeOverviewFixture();

  const g = globalThis as Record<string, any>;
  g.__overviewTestCopied = copied;
  g.__overviewTestToasts = toasts;
  g.__overviewTestUseSubscription = (_contract: unknown, _input: unknown, onEvent: (ev: unknown) => void) => {
    subCallback = onEvent;
    return { status: "live" };
  };
  g.__overviewTestRpc = async (name: string, input: unknown) => {
    rpcCalls.push({ name, input });
    if (name === "factory.overview") return { ok: true, ...currentOverview };
    return { ok: false, code: "unexpected", error: `unexpected ${name}` };
  };

  for (const supportsFocusHost of [true, false] as const) {
    rpcCalls.length = 0;
    copied.length = 0;
    const openedWorkspaces: any[] = [];
    const openedPanels: any[] = [];
    const openedScreens: any[] = [];

    await mountDom(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            createElement(OverviewScreen, {
              theme: testTheme,
              host: { id: "host-1", label: "Local" },
              layout: { compact: false, platform: "web" },
              params: {},
              navigation: {
                supportsFocusHost,
                openWorkspace: (input: any) => openedWorkspaces.push(input),
                openAgent: () => {},
              },
              openPanel: (id: string, opts: any) => openedPanels.push({ id, opts }),
              openScreen: (input: any) => openedScreens.push(input),
            }),
          );
          await new Promise<void>((r) => setTimeout(r, 15));
        });

        assert.ok(rpcCalls.some((c) => c.name === "factory.overview"), "loads via factory.overview");
        assert.ok(container.querySelector('[data-testid="factory-overview-screen"]'));
        assert.match(container.textContent ?? "", /Alpha/);
        assert.match(container.textContent ?? "", /Beta/);

        // Live subscription event updates view
        currentOverview = makeOverviewFixture({
          gateQueue: { paused: true, pausedAt: "2026-11-22T10:01:00.000Z", concurrency: 1, running: [], queued: [] },
        });
        await act(async () => {
          subCallback?.({ seq: 9, reasons: ["gate.queue"], at: "2026-11-22T10:01:00.000Z" });
          await new Promise<void>((r) => setTimeout(r, 15));
        });
        assert.ok(container.querySelector('[data-testid="factory-overview-gate-queue-paused"]'), "paused badge appears on live update");

        // + Onboard Project CTA opens OnboardingScreen
        const onboardBtn = container.querySelector('[data-testid="factory-overview-onboard-button"]') as HTMLButtonElement;
        assert.ok(onboardBtn);
        await act(() => onboardBtn.click());
        assert.deepEqual(openedScreens, [{ screenId: "paseo-factory-onboard" }]);

        // Clicking a Project row navigates to its workspace and opens the Factory panel
        const alphaRow = container.querySelector('[data-testid="factory-overview-project-alpha-111111"]') as HTMLButtonElement;
        assert.ok(alphaRow);
        await act(() => alphaRow.click());
        assert.deepEqual(openedWorkspaces, [
          supportsFocusHost
            ? { workspaceId: "ws-alpha", serverId: "host-1", focusHost: true }
            : { workspaceId: "ws-alpha", serverId: "host-1" },
        ]);
        assert.deepEqual(openedPanels, [{ id: "paseo-factory", opts: { workspaceId: "ws-alpha", location: "workspace" } }]);
      } finally {
        await act(() => root.unmount());
      }
    });
  }

  // Inspect-log modal + copyText
  currentOverview = makeOverviewFixture();
  await mountDom(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(OverviewScreen, {
            theme: testTheme,
            host: { id: "host-1", label: "Local" },
            layout: { compact: false, platform: "web" },
            params: {},
          }),
        );
        await new Promise<void>((r) => setTimeout(r, 15));
      });
      const logBtn = container.querySelector('[data-testid="factory-overview-gate-log-gq-run-1"]') as HTMLButtonElement;
      assert.ok(logBtn, "running Gate row offers Open log");
      await act(() => logBtn.click());
      const modal = container.querySelector('[data-testid="factory-overview-log-modal"]');
      assert.ok(modal, "inspect log modal opens");
      assert.match(
        container.querySelector('[data-testid="factory-overview-log-path"]')?.textContent ?? "",
        /\/state\/projects\/alpha-111111\/gate-TA-1-1\.log/,
      );
      const copyBtn = container.querySelector('[data-testid="factory-overview-log-copy"]') as HTMLButtonElement;
      await act(() => copyBtn.click());
      assert.deepEqual(copied, ["/state/projects/alpha-111111/gate-TA-1-1.log"]);
    } finally {
      await act(() => root.unmount());
      delete g.__overviewTestCopied;
      delete g.__overviewTestToasts;
      delete g.__overviewTestUseSubscription;
      delete g.__overviewTestRpc;
    }
  });
});

test("desktop contribute registers single Factory sidebar header item with live trailing badge, overview + onboard screens, and zero footer items; mobile skips global UI", async () => {
  const { createElement } = await import("react");

  const makeMockClient = (initialDirReply: any) => {
    const sidebarHeaderItems: any[] = [];
    const sidebarFooterItems: any[] = [];
    const screens: any[] = [];
    const commandItems: any[] = [];
    const openedScreens: any[] = [];
    let dirReply = initialDirReply;
    let onSubEvent: ((ev: unknown) => void) | undefined;

    return {
      sidebarHeaderItems,
      sidebarFooterItems,
      screens,
      commandItems,
      openedScreens,
      setReply(next: any) {
        dirReply = next;
      },
      emitUpdate() {
        onSubEvent?.({ seq: 1, reasons: ["gate.queue"], at: new Date().toISOString() });
      },
      client: {
        addWorkspacePanel: () => () => {},
        addSettingsScreen: () => () => {},
        addSidebarHeaderItem: (c: any) => {
          sidebarHeaderItems.push(c);
          return () => {};
        },
        addSidebarFooterItem: (c: any) => {
          sidebarFooterItems.push(c);
          return () => {};
        },
        addScreen: (c: any) => {
          screens.push(c);
          return () => {};
        },
        addCommandCenterItem: (c: any) => {
          commandItems.push(c);
          return () => {};
        },
        addHeaderButton: () => ({ update() {}, remove() {} }),
        addComposerPill: () => ({ update() {}, remove() {} }),
        addWorkspaceRowBadgeItem: () => () => {},
        subscribe: (_c: unknown, _i: unknown, ev: (e: unknown) => void) => {
          onSubEvent = ev;
          return Object.assign(() => {}, { ready: Promise.resolve() });
        },
        rpc: async () => dirReply,
        openPanel: () => {},
        openSettings: () => {},
        openScreen: (input: any) => openedScreens.push(input),
      },
    };
  };

  // Desktop ("web")
  const desktop = await loadOverviewModule("plugin/index.client.tsx", { platformOs: "web" });
  const webMock = makeMockClient({
    ok: true,
    daemonError: null,
    seats: [],
    projects: [{ slug: "alpha", root: "/work/alpha", workspaceId: "ws-alpha", needsYouCount: 0 }],
    gateQueue: { paused: false, concurrency: 1, runningCount: 0, queuedCount: 0 },
  });

  await mountDom(async (createRoot, container, act) => {
    let off = () => {};
    const root = createRoot(container);
    try {
      await act(async () => {
        off = desktop.default(webMock.client);
        await new Promise<void>((r) => setTimeout(r, 15));
      });
      assert.equal(webMock.sidebarFooterItems.length, 0, "standalone Onboard Project footer item is removed");
      assert.equal(webMock.sidebarHeaderItems.length, 1, "exactly one Factory sidebar header item registered");
      assert.equal(webMock.sidebarHeaderItems[0].id, "paseo-factory-overview");
      assert.equal(webMock.sidebarHeaderItems[0].title, "Factory");
      assert.deepEqual(
        webMock.screens.map((s) => s.id).sort(),
        ["paseo-factory-onboard", "paseo-factory-overview"],
      );
      const globalCmd = webMock.commandItems.find((c) => c.context === "global");
      assert.equal(globalCmd?.id, "factory-onboard-project");

      const HeaderItem = webMock.sidebarHeaderItems[0].Component;
      await act(async () => {
        root.render(
          createElement(HeaderItem, {
            theme: testTheme,
            host: { id: "h1", label: "Local" },
            layout: { compact: false, platform: "web" },
            currentScreen: { screenId: "paseo-factory-overview", params: {} },
            openScreen: webMock.client.openScreen,
            openPopover: () => {},
          }),
        );
        await new Promise<void>((r) => setTimeout(r, 15));
      });

      const entry = container.querySelector('[data-testid="factory-sidebar-overview-entry"]');
      assert.ok(entry, "renders factory-sidebar-overview-entry");
      assert.equal(entry.querySelector('[data-sidebar-row]')?.getAttribute("data-active"), "true");
      assert.equal(container.querySelector('[data-testid="sidebar-row-trailing"]'), null, "idle machine shows no sidebar badge");

      // Active Gate + Needs you update via stateUpdates populates trailing badge
      webMock.setReply({
        ok: true,
        daemonError: null,
        seats: [],
        projects: [{ slug: "alpha", root: "/work/alpha", workspaceId: "ws-alpha", needsYouCount: 2, gateQueueStatus: "running", gateQueuePosition: 1 }],
        gateQueue: { paused: false, concurrency: 1, runningCount: 1, queuedCount: 1 },
      });
      await act(async () => {
        webMock.emitUpdate();
        await new Promise<void>((r) => setTimeout(r, 15));
      });

      const trailing = container.querySelector('[data-testid="sidebar-row-trailing"]');
      assert.ok(trailing, "trailing badge renders when Needs you or Gate queue is active");
      assert.match(trailing.textContent ?? "", /Needs you · 2 · Gate running · \+1/);

      // Clicking opens Factory overview screen
      const button = entry.querySelector("button")!;
      await act(() => button.click());
      assert.deepEqual(webMock.openedScreens, [{ screenId: "paseo-factory-overview" }]);
    } finally {
      await act(async () => {
        off();
        await root.unmount();
      });
    }
  });

  // Mobile ("ios" and "android"): omits global sidebar items, screens, and global command; wrappers return null with zero RPCs
  const entries = await loadOverviewModule("plugin/client/factory/entries.tsx", { platformOs: "ios" });
  const rpcCalls: string[] = [];
  (globalThis as Record<string, any>).__overviewTestRpc = async (name: string) => {
    rpcCalls.push(name);
    return { ok: true };
  };
  for (const os of ["ios", "android"] as const) {
    const mobile = await loadOverviewModule("plugin/index.client.tsx", { platformOs: os });
    const mobMock = makeMockClient({ ok: true, daemonError: null, seats: [], projects: [] });
    const offMob = mobile.default(mobMock.client);
    try {
      assert.equal(mobMock.sidebarHeaderItems.length, 0, `${os} does not register sidebar header item`);
      assert.equal(mobMock.sidebarFooterItems.length, 0, `${os} does not register sidebar footer item`);
      assert.equal(mobMock.screens.length, 0, `${os} does not register global screens`);
      assert.equal(mobMock.commandItems.filter((c) => c.context === "global").length, 0, `${os} does not register global command`);
    } finally {
      offMob();
    }

    await mountDom(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
        await act(() =>
          root.render(
            createElement(entries.FactoryOverviewScreen, {
              theme: testTheme,
              host: { id: "h1", label: "Local" },
              layout: { compact: true, platform: os },
              params: {},
            }),
          ),
        );
        assert.equal(container.innerHTML, "", `${os} FactoryOverviewScreen renders null`);
        await act(() =>
          root.render(
            createElement(entries.FactoryOverviewSidebarItem, {
              theme: testTheme,
              host: { id: "h1", label: "Local" },
              layout: { compact: true, platform: os },
              currentScreen: null,
              openScreen: () => {},
              openPopover: () => {},
            }),
          ),
        );
        assert.equal(container.innerHTML, "", `${os} FactoryOverviewSidebarItem renders null`);
      } finally {
        await act(() => root.unmount());
      }
    });
  }
  assert.deepEqual(rpcCalls, [], "mobile triggers zero overview RPCs");
  delete (globalThis as Record<string, any>).__overviewTestRpc;
});

test("OverviewScreen mounts under a RN-like window lacking addEventListener and document", async () => {
  const { OverviewScreen } = await loadOverviewModule("plugin/client/factory/overview-screen.tsx", { platformOs: "web" });
  const { createElement } = await import("react");

  const g = globalThis as Record<string, any>;
  g.__overviewTestRpc = async () => ({ ok: true, ...makeOverviewFixture() });
  g.__overviewTestUseSubscription = () => ({ status: "unsupported" });

  await mountDom(async (createRoot, container, act) => {
    for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
      Object.defineProperty(g.window, key, { value: undefined, configurable: true, writable: true });
    }
    delete g.document;
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(OverviewScreen, {
            theme: testTheme,
            host: { id: "h1", label: "Local" },
            layout: { compact: false, platform: "web" },
            params: {},
          }),
        );
        await new Promise<void>((r) => setTimeout(r, 15));
      });
      assert.match(container.innerHTML, /data-testid="factory-overview-screen"/);
      assert.match(container.textContent ?? "", /Alpha/);
    } finally {
      await act(() => root.unmount());
      delete g.__overviewTestRpc;
      delete g.__overviewTestUseSubscription;
    }
  });
});

test("OverviewScreen Pause / Resume queue toggle tracks in-flight pending state, prevents duplicate clicks, updates live queue state, and surfaces/clears inline errors", async () => {
  const { OverviewScreen } = await loadOverviewModule("plugin/client/factory/overview-screen.tsx", { platformOs: "web" });
  const { createElement } = await import("react");

  let currentOverview = makeOverviewFixture();
  const rpcCalls: Array<{ name: string; input: unknown }> = [];
  let deferredPause: { resolve: (val: unknown) => void; reject: (err: unknown) => void } | null = null;
  let deferredResume: { resolve: (val: unknown) => void; reject: (err: unknown) => void } | null = null;
  let nextPauseReply: unknown = null;

  const g = globalThis as Record<string, any>;
  g.__overviewTestToasts = [];
  g.__overviewTestUseSubscription = () => ({ status: "live" });
  g.__overviewTestRpc = async (name: string, input: unknown) => {
    rpcCalls.push({ name, input });
    if (name === "factory.overview") return { ok: true, ...structuredClone(currentOverview) };
    if (name === "factory.gate.queue.pause") {
      if (deferredPause !== null) {
        return await new Promise((resolve, reject) => {
          deferredPause = { resolve, reject };
        });
      }
      if (nextPauseReply !== null) {
        const reply = nextPauseReply;
        nextPauseReply = null;
        if (reply instanceof Error) throw reply;
        return reply;
      }
      currentOverview = {
        ...currentOverview,
        gateQueue: { ...currentOverview.gateQueue, paused: true, pausedAt: "2026-11-22T10:02:00.000Z" },
      };
      return { ok: true, gateQueue: structuredClone(currentOverview.gateQueue) };
    }
    if (name === "factory.gate.queue.resume") {
      if (deferredResume !== null) {
        return await new Promise((resolve, reject) => {
          deferredResume = { resolve, reject };
        });
      }
      currentOverview = {
        ...currentOverview,
        gateQueue: { ...currentOverview.gateQueue, paused: false, pausedAt: null },
      };
      return { ok: true, gateQueue: structuredClone(currentOverview.gateQueue) };
    }
    return { ok: false, code: "unexpected", error: `unexpected ${name}` };
  };

  await mountDom(async (createRoot, container, act) => {
    const root = createRoot(container);
    const pauseBtn = () => container.querySelector('[data-testid="factory-queue-pause-toggle"]') as HTMLButtonElement | null;
    const queueSection = () => container.querySelector('[data-testid="factory-overview-gate-queue"]') as HTMLElement | null;
    const queueError = () => container.querySelector('[data-testid="factory-overview-gate-queue-error"]') as HTMLElement | null;

    try {
      await act(async () => {
        root.render(
          createElement(OverviewScreen, {
            theme: testTheme,
            host: { id: "host-1", label: "Local" },
            layout: { compact: false, platform: "web" },
            params: {},
          }),
        );
        await new Promise<void>((r) => setTimeout(r, 15));
      });

      assert.ok(pauseBtn(), "renders factory-queue-pause-toggle");
      assert.equal(pauseBtn()!.textContent, "Pause queue");
      assert.equal(pauseBtn()!.disabled, false);

      // 1. Pause with deferred RPC: shows Pausing..., disables button, ignores duplicate click
      let resolvePause!: (val: unknown) => void;
      deferredPause = { resolve: () => {}, reject: () => {} };
      const origRpc = g.__overviewTestRpc;
      g.__overviewTestRpc = async (name: string, input: unknown) => {
        if (name === "factory.gate.queue.pause" && deferredPause !== null) {
          rpcCalls.push({ name, input });
          return await new Promise((resolve) => {
            resolvePause = resolve;
          });
        }
        return origRpc(name, input);
      };

      await act(async () => {
        pauseBtn()!.click();
      });
      assert.equal(pauseBtn()!.disabled, true, "disables pause toggle while Pausing is in flight");
      assert.match(pauseBtn()!.textContent ?? "", /Pausing\.\.\./);
      await act(async () => {
        pauseBtn()!.click();
      });
      assert.equal(rpcCalls.filter((c) => c.name === "factory.gate.queue.pause").length, 1, "ignores duplicate click while in flight");

      // Confirm pause: updates immediately to paused + triggers overview refresh
      deferredPause = null;
      const pausedQueue = { ...currentOverview.gateQueue, paused: true, pausedAt: "2026-11-22T10:02:00.000Z" };
      currentOverview = { ...currentOverview, gateQueue: pausedQueue };
      const overviewsBeforeConfirm = rpcCalls.filter((c) => c.name === "factory.overview").length;
      await act(async () => {
        resolvePause({ ok: true, gateQueue: pausedQueue });
        await new Promise<void>((r) => setTimeout(r, 15));
      });

      assert.equal(pauseBtn()!.disabled, false);
      assert.equal(pauseBtn()!.textContent, "Resume queue");
      assert.ok(container.querySelector('[data-testid="factory-overview-gate-queue-paused"]'), "paused badge renders");
      assert.ok(rpcCalls.filter((c) => c.name === "factory.overview").length > overviewsBeforeConfirm, "triggers overview refresh after pause");

      // 2. Resume with deferred RPC: shows Resuming..., disables button, returns to Pause queue
      let resolveResume!: (val: unknown) => void;
      deferredResume = { resolve: () => {}, reject: () => {} };
      g.__overviewTestRpc = async (name: string, input: unknown) => {
        if (name === "factory.gate.queue.resume" && deferredResume !== null) {
          rpcCalls.push({ name, input });
          return await new Promise((resolve) => {
            resolveResume = resolve;
          });
        }
        return origRpc(name, input);
      };

      await act(async () => {
        pauseBtn()!.click();
      });
      assert.equal(pauseBtn()!.disabled, true);
      assert.match(pauseBtn()!.textContent ?? "", /Resuming\.\.\./);

      deferredResume = null;
      const resumedQueue = { ...currentOverview.gateQueue, paused: false, pausedAt: null };
      currentOverview = { ...currentOverview, gateQueue: resumedQueue };
      await act(async () => {
        resolveResume({ ok: true, gateQueue: resumedQueue });
        await new Promise<void>((r) => setTimeout(r, 15));
      });

      assert.equal(pauseBtn()!.disabled, false);
      assert.equal(pauseBtn()!.textContent, "Pause queue");
      assert.equal(container.querySelector('[data-testid="factory-overview-gate-queue-paused"]'), null);

      // 3. Failure ({ ok: false, error }) surfaces inline error in Gate queue section; retry clears it
      g.__overviewTestRpc = origRpc;
      nextPauseReply = { ok: false, code: "gate-queue-unavailable", error: "Gate queue is not active on this server" };
      await act(async () => {
        pauseBtn()!.click();
        await new Promise<void>((r) => setTimeout(r, 15));
      });
      assert.equal(pauseBtn()!.textContent, "Pause queue");
      assert.equal(pauseBtn()!.disabled, false);
      assert.ok(queueError(), "renders inline Gate queue error");
      assert.match(queueSection()?.textContent ?? "", /Gate queue is not active on this server/);

      // Retry succeeds and clears inline error
      await act(async () => {
        pauseBtn()!.click();
        await new Promise<void>((r) => setTimeout(r, 15));
      });
      assert.equal(queueError(), null, "successful retry clears inline error");
      assert.equal(pauseBtn()!.textContent, "Resume queue");

      // 4. Thrown rejection surfaces error inline cleanly
      // Reset back to unpaused first via resume
      await act(async () => {
        pauseBtn()!.click();
        await new Promise<void>((r) => setTimeout(r, 15));
      });
      assert.equal(pauseBtn()!.textContent, "Pause queue");
      nextPauseReply = new Error("Daemon unreachable");
      await act(async () => {
        pauseBtn()!.click();
        await new Promise<void>((r) => setTimeout(r, 15));
      });
      assert.equal(pauseBtn()!.disabled, false);
      assert.match(queueError()?.textContent ?? "", /Daemon unreachable/);
    } finally {
      await act(() => root.unmount());
      delete g.__overviewTestToasts;
      delete g.__overviewTestUseSubscription;
      delete g.__overviewTestRpc;
    }
  });
});

test("OverviewScreen Cancel buttons on running and queued Gate rows track per-item pending state, update live queue state, and surface/clear inline errors", async () => {
  const { OverviewScreen } = await loadOverviewModule("plugin/client/factory/overview-screen.tsx", { platformOs: "web" });
  const { createElement } = await import("react");

  let currentOverview = makeOverviewFixture();
  const rpcCalls: Array<{ name: string; input: unknown }> = [];
  let deferredCancel: ((input: unknown) => Promise<unknown>) | null = null;
  let nextCancelReply: unknown = null;

  const g = globalThis as Record<string, any>;
  g.__overviewTestToasts = [];
  g.__overviewTestUseSubscription = () => ({ status: "live" });
  g.__overviewTestRpc = async (name: string, input: unknown) => {
    rpcCalls.push({ name, input });
    if (name === "factory.overview") return { ok: true, ...structuredClone(currentOverview) };
    if (name === "factory.gate.queue.cancel") {
      if (deferredCancel !== null) return await deferredCancel(input);
      if (nextCancelReply !== null) {
        const reply = nextCancelReply;
        nextCancelReply = null;
        if (reply instanceof Error) throw reply;
        return reply;
      }
      const targetId = (input as { queueId?: string; id?: string }).queueId ?? (input as { id?: string }).id;
      currentOverview = {
        ...currentOverview,
        gateQueue: {
          ...currentOverview.gateQueue,
          running: currentOverview.gateQueue.running.filter((item) => item.id !== targetId),
          queued: currentOverview.gateQueue.queued
            .filter((item) => item.id !== targetId)
            .map((item, idx) => ({ ...item, position: currentOverview.gateQueue.running.filter((r) => r.id !== targetId).length + idx + 1 })),
        },
      };
      return {
        ok: true,
        cancelledCount: 1,
        cancelledIds: [targetId],
        gateQueue: structuredClone(currentOverview.gateQueue),
      };
    }
    return { ok: false, code: "unexpected", error: `unexpected ${name}` };
  };

  await mountDom(async (createRoot, container, act) => {
    const root = createRoot(container);
    const cancelBtn = (id: string) =>
      container.querySelector(`[data-testid="factory-queue-cancel-${id}"]`) as HTMLButtonElement | null;
    const queueError = () => container.querySelector('[data-testid="factory-overview-gate-queue-error"]') as HTMLElement | null;

    try {
      await act(async () => {
        root.render(
          createElement(OverviewScreen, {
            theme: testTheme,
            host: { id: "host-1", label: "Local" },
            layout: { compact: false, platform: "web" },
            params: {},
          }),
        );
        await new Promise<void>((r) => setTimeout(r, 15));
      });

      assert.equal(cancelBtn("gq-run-1")?.textContent, "Cancel");
      assert.equal(cancelBtn("gq-q-2")?.textContent, "Cancel");
      assert.equal(cancelBtn("gq-q-3")?.textContent, "Cancel");

      // 1. Cancel running row with deferred RPC: per-item Cancelling... + disabled; queued rows stay enabled
      let resolveCancel!: (val: unknown) => void;
      deferredCancel = () => new Promise((resolve) => { resolveCancel = resolve; });

      await act(async () => {
        cancelBtn("gq-run-1")!.click();
      });
      assert.equal(cancelBtn("gq-run-1")!.disabled, true);
      assert.match(cancelBtn("gq-run-1")!.textContent ?? "", /Cancelling\.\.\./);
      assert.equal(cancelBtn("gq-q-2")!.disabled, false, "other rows remain interactive");
      assert.equal(cancelBtn("gq-q-2")!.textContent, "Cancel");

      // Duplicate click while in flight is ignored
      await act(async () => {
        cancelBtn("gq-run-1")!.click();
      });
      const cancelCalls = rpcCalls.filter((c) => c.name === "factory.gate.queue.cancel");
      assert.equal(cancelCalls.length, 1);
      assert.deepEqual(cancelCalls[0]!.input, { queueId: "gq-run-1" });

      deferredCancel = null;
      const afterRunCancelled = {
        ...currentOverview.gateQueue,
        running: [],
        queued: currentOverview.gateQueue.queued.map((item, idx) => ({ ...item, position: idx + 1 })),
      };
      currentOverview = { ...currentOverview, gateQueue: afterRunCancelled };
      const overviewsBefore = rpcCalls.filter((c) => c.name === "factory.overview").length;
      await act(async () => {
        resolveCancel({ ok: true, cancelledCount: 1, cancelledIds: ["gq-run-1"], gateQueue: afterRunCancelled });
        await new Promise<void>((r) => setTimeout(r, 15));
      });

      assert.equal(cancelBtn("gq-run-1"), null, "cancelled running row disappears");
      assert.ok(rpcCalls.filter((c) => c.name === "factory.overview").length > overviewsBefore, "refreshes overview after cancel");

      // 2. Cancel queued row fails ({ ok: false, error }) -> inline error + button re-enabled
      nextCancelReply = { ok: false, code: "queue-item-not-found", error: "Could not cancel gq-q-2: daemon busy" };
      await act(async () => {
        cancelBtn("gq-q-2")!.click();
        await new Promise<void>((r) => setTimeout(r, 15));
      });
      assert.equal(cancelBtn("gq-q-2")!.disabled, false);
      assert.equal(cancelBtn("gq-q-2")!.textContent, "Cancel");
      assert.match(queueError()?.textContent ?? "", /Could not cancel gq-q-2: daemon busy/);

      // 3. Retry cancel on queued row succeeds -> removes item and clears error
      await act(async () => {
        cancelBtn("gq-q-2")!.click();
        await new Promise<void>((r) => setTimeout(r, 15));
      });
      assert.equal(cancelBtn("gq-q-2"), null);
      assert.equal(queueError(), null);

      // 4. Thrown rejection on gq-q-3 surfaces inline error
      nextCancelReply = new Error("Socket closed during cancel");
      await act(async () => {
        cancelBtn("gq-q-3")!.click();
        await new Promise<void>((r) => setTimeout(r, 15));
      });
      assert.equal(cancelBtn("gq-q-3")!.disabled, false);
      assert.match(queueError()?.textContent ?? "", /Socket closed during cancel/);
    } finally {
      await act(() => root.unmount());
      delete g.__overviewTestToasts;
      delete g.__overviewTestUseSubscription;
      delete g.__overviewTestRpc;
    }
  });
});

