/**
 * v0.16+ backgroundWorkCount surfacing on the Project panel (T-24b):
 * idle seats (Supervisor/Lead) and idle Peers with leftover background
 * processes (backgroundWorkCount > 0) render a visible warning indicator,
 * while count === 0, absent (<0.16 snapshots), vacant, and active states
 * leave existing layout and semantics untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { repoRoot } from "./helpers.ts";
import type { PanelPeerRow, PanelSeatRow, PanelView } from "../plugin/shared/view.ts";

type Exports = Record<string, any>;

async function loadPanel(): Promise<Exports> {
  const bundle = await build({
    entryPoints: [join(repoRoot, "plugin/client/factory/project-panel.tsx")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    plugins: [
      {
        name: "native-adapter",
        setup(b) {
          b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui|@getpaseo\/plugin\/client)$/ }, (args) => ({ path: args.path, namespace: "native" }));
          b.onLoad({ filter: /.*/, namespace: "native" }, () => ({
            loader: "js",
            contents: `
              const React = require('react');
              const tag = (name) => ({ children, onPress, disabled, testID, style, accessibilityRole, accessibilityState, accessibilityLabel }) =>
                React.createElement(name, {
                  disabled,
                  onClick: onPress,
                  'data-testid': testID,
                  'data-role': accessibilityRole,
                  'aria-label': accessibilityLabel,
                  'data-selected': accessibilityState && accessibilityState.selected !== undefined ? String(accessibilityState.selected) : undefined,
                  'data-checked': accessibilityState && accessibilityState.checked !== undefined ? String(accessibilityState.checked) : undefined,
                  'data-style': typeof style === 'object' && style !== null ? JSON.stringify(style) : undefined,
                }, typeof children === 'function' ? children({ pressed: false }) : children);
              exports.View = tag('div');
              exports.Text = tag('span');
              exports.Pressable = tag('button');
              exports.Icon = () => null;
              const Modal = ({ children, open }) => open ? React.createElement('div', {}, children) : null;
              Modal.Content = tag('div');
              exports.Modal = Modal;
              exports.TextInput = ({ value, placeholder, testID }) => React.createElement('input', { value: value ?? '', placeholder, readOnly: true, 'data-testid': testID });
              exports.Platform = { OS: 'ios', select: (spec) => (spec.ios !== undefined ? spec.ios : spec.default) };
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

const lightTheme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f5f5f5",
    surface2: "#eeeeee",
    foreground: "#111111",
    foregroundMuted: "#555555",
    accent: "#3355aa",
    border: "#cccccc",
    statusSuccess: "#217342",
    statusWarning: "#aa8800",
    statusDanger: "#cc0000",
  },
};

const darkTheme = {
  colors: {
    ...lightTheme.colors,
    surface0: "#14161a",
    surface1: "#1d2026",
    surface2: "#262a33",
    foreground: "#f0f2f5",
    foregroundMuted: "#9aa2ad",
  },
};

const seatDefaults = {
  lane: { provider: "pi", model: "glm-5.3", scope: "machine" as const },
  pendingLane: null,
  markTokens: 128_000,
  allowedActions: ["switch-model", "hand-off-now"] as ("switch-model" | "hand-off-now")[],
};

function makeSeat(role: "supervisor" | "lead", overrides: Partial<PanelSeatRow> = {}): PanelSeatRow {
  return {
    ...seatDefaults,
    role,
    vacant: false,
    agentId: `agent-${role}`,
    statusLabel: "idle",
    tone: "normal",
    model: "glm-5.3",
    hint: null,
    context: null,
    handoff: null,
    ...overrides,
  };
}

function makePeer(task: string, overrides: Partial<PanelPeerRow> = {}): PanelPeerRow {
  return {
    ...seatDefaults,
    role: "peer",
    agentId: `agent-${task}`,
    task,
    title: `Peer · ${task}`,
    disposition: "engineer",
    statusLabel: "idle",
    tone: "normal",
    model: "glm-5.3",
    context: { state: "unknown", usedTokens: null, markTokens: 128_000, label: "context unknown", fraction: null },
    handoff: null,
    ...overrides,
  };
}

function makePanel(seats: NonNullable<PanelView["seats"]>): PanelView {
  return {
    handoffs: [],
    profile: { active: null, list: [], modified: false },
    defaultWorker: null,
    isProject: true,
    name: "bg-app",
    summary: "Seats idle",
    needsYou: [],
    seats,
    openDesign: null,
    onboarding: null,
  };
}

const noopActions = () => ({
  openAgent() {},
  installPrerequisites() {},
  handoffStart() {},
  handoffReplaceNow() {},
  handoffCancel() {},
  handoffRetry() {},
  viewHandover() {},
  startSupervisor() {},
  syncOpenDesign() {},
  adoptSupervisor() {},
  busy: false,
});

async function renderPanel(panel: PanelView, options: { theme?: typeof lightTheme; mobile?: boolean; width?: number } = {}): Promise<string> {
  const { ProjectPanel } = await loadPanel();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(
    createElement(ProjectPanel, {
      theme: options.theme ?? lightTheme,
      panel,
      mobile: options.mobile ?? false,
      now: Date.now(),
      daemonError: null,
      actions: noopActions(),
      width: options.width ?? 900,
    }),
  );
}

const at = (html: string, id: string): number => html.indexOf(`data-testid="${id}"`);
const hasHook = (html: string, id: string): boolean => html.includes(`data-testid="${id}"`);

function elementOf(html: string, id: string): string {
  const index = at(html, id);
  if (index < 0) throw new Error(`missing testID ${id}`);
  const start = html.lastIndexOf("<div", index);
  let depth = 0;
  for (const m of html.slice(start).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, start + m.index! + m[0].length);
  }
  throw new Error(`unbalanced markup for ${id}`);
}

test("idle Supervisor and Lead with backgroundWorkCount > 0 surface warning indicators without altering SeatLine or statusLabel", async () => {
  const panel = makePanel({
    supervisor: makeSeat("supervisor", { statusLabel: "idle", backgroundWorkCount: 1 }),
    lead: makeSeat("lead", { statusLabel: "idle", backgroundWorkCount: 3 }),
    peers: [],
    supervisorCandidates: [],
  });

  const lightHtml = await renderPanel(panel, { theme: lightTheme, width: 900 });
  const supRow = elementOf(lightHtml, "factory-seat-supervisor");
  const supBadge = elementOf(supRow, "factory-seat-background-work-supervisor");
  assert.match(supBadge, /1 background process running/);
  assert.ok(supBadge.includes("#8f6802"), "light theme uses palette.wait warning colour");

  const leadRow = elementOf(lightHtml, "factory-seat-lead");
  const leadBadge = elementOf(leadRow, "factory-seat-background-work-lead");
  assert.match(leadBadge, /3 background processes running/);
  assert.ok(leadBadge.includes("#8f6802"));

  // SeatLine wide layout invariant and statusLabel remain intact.
  const supLine = elementOf(supRow, "factory-seat-line-supervisor");
  assert.match(supLine.slice(0, supLine.indexOf(">")), /&quot;flexDirection&quot;:&quot;row&quot;/);
  assert.match(supLine, />idle</);
  assert.equal(hasHook(supLine, "factory-seat-background-work-supervisor"), false, "indicator sits below SeatLine so fixed columns stay aligned");

  // Dark theme picks dark palette.wait (#cd9a22).
  const darkHtml = await renderPanel(panel, { theme: darkTheme, width: 900 });
  assert.ok(elementOf(darkHtml, "factory-seat-background-work-lead").includes("#cd9a22"), "dark theme uses dark palette.wait");
});

test("idle Peers with backgroundWorkCount > 0 surface warning indicators in wide and narrow/mobile layouts", async () => {
  const panel = makePanel({
    supervisor: makeSeat("supervisor"),
    lead: makeSeat("lead"),
    peers: [
      makePeer("T-10", { statusLabel: "idle", backgroundWorkCount: 2 }),
      makePeer("T-11", { statusLabel: "idle", backgroundWorkCount: 1, disposition: "reviewer" }),
      makePeer("T-closed", { statusLabel: "closed", backgroundWorkCount: 5 }),
    ],
    supervisorCandidates: [],
  });

  for (const layout of [{ width: 900, mobile: false }, { width: 420, mobile: true }]) {
    const html = await renderPanel(panel, layout);
    const peer10 = elementOf(html, "factory-seat-peer-T-10");
    assert.match(elementOf(peer10, "factory-seat-background-work-peer-T-10"), /2 background processes running/);
    assert.match(elementOf(peer10, "factory-seat-status-peer-T-10"), />idle</);
    assert.match(elementOf(peer10, "factory-peer-disposition-T-10"), />engineer</);

    const peer11 = elementOf(html, "factory-seat-peer-T-11");
    assert.match(elementOf(peer11, "factory-seat-background-work-peer-T-11"), /1 background process running/);
    assert.match(elementOf(peer11, "factory-seat-status-peer-T-11"), />idle</);
    assert.match(elementOf(peer11, "factory-peer-disposition-T-11"), />reviewer</);

    // isClosedPeer still hides closed Peers behind the Closed toggle.
    assert.equal(hasHook(html, "factory-panel-seat-peer-T-closed"), false);
    assert.equal(hasHook(html, "factory-seat-background-work-peer-T-closed"), false);
    assert.match(html, /▸ Closed \(1\)/);
  }
});

test("backgroundWorkCount === 0 and absent (<0.16) render nothing extra and produce identical markup", async () => {
  const legacyPanel = makePanel({
    supervisor: makeSeat("supervisor"),
    lead: makeSeat("lead"),
    peers: [makePeer("T-01")],
    supervisorCandidates: [],
  });
  const zeroPanel = makePanel({
    supervisor: makeSeat("supervisor", { backgroundWorkCount: 0 }),
    lead: makeSeat("lead", { backgroundWorkCount: 0 }),
    peers: [makePeer("T-01", { backgroundWorkCount: 0 })],
    supervisorCandidates: [],
  });

  const legacyHtml = await renderPanel(legacyPanel);
  const zeroHtml = await renderPanel(zeroPanel);

  assert.equal(zeroHtml, legacyHtml, "count=0 renders identically to absent (<0.16)");
  assert.doesNotMatch(legacyHtml, /factory-seat-background-work-/);
  assert.doesNotMatch(legacyHtml, /background process/i);
});

test("non-idle (working, waiting, error) and vacant seats/Peers do not render the idle leftover-process indicator", async () => {
  const panel = makePanel({
    supervisor: makeSeat("supervisor", { vacant: true, agentId: null, statusLabel: "vacant", model: null, hint: "No Supervisor is running.", backgroundWorkCount: 2 }),
    lead: makeSeat("lead", { statusLabel: "working", backgroundWorkCount: 4 }),
    peers: [
      makePeer("T-wait", { statusLabel: "waiting for permission", tone: "waiting", backgroundWorkCount: 2 }),
      makePeer("T-err", { statusLabel: "error", tone: "error", backgroundWorkCount: 1 }),
      makePeer("T-run", { statusLabel: "working", backgroundWorkCount: 3 }),
    ],
    supervisorCandidates: [],
  });

  const html = await renderPanel(panel);
  assert.doesNotMatch(html, /factory-seat-background-work-/);
  assert.doesNotMatch(html, /background process/i);
  assert.match(elementOf(html, "factory-seat-line-lead"), />working</);
  assert.match(elementOf(html, "factory-seat-line-peer-T-wait"), /waiting for permission/);
  assert.match(elementOf(html, "factory-seat-line-peer-T-err"), /error/);
});

test("idle background-work indicator mounts under a RN-like window without DOM globals", async () => {
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
      Object.defineProperty(dom.window, key, { value: undefined, configurable: true, writable: true });
    }
    delete g.document;
    const panel = makePanel({
      supervisor: makeSeat("supervisor", { statusLabel: "idle", backgroundWorkCount: 2 }),
      lead: makeSeat("lead", { statusLabel: "idle", backgroundWorkCount: 0 }),
      peers: [makePeer("T-12", { statusLabel: "idle", backgroundWorkCount: 1 })],
      supervisorCandidates: [],
    });
    await act(async () => {
      root.render(createElement(ProjectPanel, { theme: lightTheme, panel, mobile: true, now: Date.now(), daemonError: null, actions: noopActions(), width: 400 }));
    });
    const markup = container.innerHTML;
    assert.match(markup, /data-testid="factory-seat-background-work-supervisor"[\s\S]*2 background processes running/);
    assert.match(markup, /data-testid="factory-seat-background-work-peer-T-12"[\s\S]*1 background process running/);
    assert.equal(hasHook(markup, "factory-seat-background-work-lead"), false);
  } finally {
    await act(async () => {
      root.unmount();
    });
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});
