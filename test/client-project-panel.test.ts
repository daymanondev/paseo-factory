/**
 * v0.6.0 W5 (ADR 0056 §5): the Project panel's client half. The server
 * projects the whole view-model (test/surface-rpc.test.ts — Seam 1); the
 * client only renders it, so these tests mount the real `project-panel.tsx`
 * (bundled from source, native primitives adapted to markup that keeps
 * `testID` and `style`) and assert on what an Owner would see: the test
 * hooks, one column, colour only for exceptions, no Accept, no Start Lead,
 * and the mobile reductions. Source-text pins are limited to the things
 * Node cannot mount — the shell's host wiring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { repoRoot } from "./helpers.ts";
import type { PanelView, ReleaseSettingsView, StoreReleaseView } from "../plugin/shared/view.ts";

type Exports = Record<string, any>;

async function loadModule(entry: string): Promise<Exports> {
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
        name: "native-adapter",
        setup(b) {
          b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui|@getpaseo\/plugin\/client)$/ }, (args) => ({ path: args.path, namespace: "native" }));
          b.onLoad({ filter: /.*/, namespace: "native" }, () => ({
            loader: "js",
            contents: `
              const React = require('react');
              // Pressable children may be a render function (Tabs): call it unpressed; data-selected is the tab state, data-checked the switch state.
              const tag = (name) => ({ children, onPress, disabled, testID, style, accessibilityRole, accessibilityState, accessibilityLabel }) =>
                React.createElement(name, { disabled, onClick: onPress, 'data-testid': testID, 'data-role': accessibilityRole, 'aria-label': accessibilityLabel, 'data-checked': accessibilityState && accessibilityState.checked !== undefined ? String(accessibilityState.checked) : undefined, 'data-selected': accessibilityState && accessibilityState.selected !== undefined ? String(accessibilityState.selected) : undefined, 'data-style': typeof style === 'object' && style !== null ? JSON.stringify(style) : undefined }, typeof children === 'function' ? children({ pressed: false }) : children);
              exports.View = tag('div'); exports.Text = tag('span'); exports.Pressable = tag('button');
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

const loadPanel = (): Promise<Exports> => loadModule("plugin/client/factory/project-panel.tsx");
const loadMenu = (): Promise<Exports> => loadModule("plugin/client/factory/project-menu.tsx");

const theme = {
  colors: {
    surface0: "#ffffff", surface1: "#f5f5f5", surface2: "#eeeeee", foreground: "#111111", foregroundMuted: "#555555",
    accent: "#3355aa", border: "#cccccc", statusSuccess: "#217342", statusWarning: "#aa8800", statusDanger: "#cc0000",
  },
};
const WARNING = "#aa8800";
const DANGER = "#cc0000";

const seatDefaults = { lane: { provider: "pi", model: "glm-5.3", scope: "machine" as const }, pendingLane: null, markTokens: 128_000, allowedActions: ["switch-model", "hand-off-now"] as ("switch-model" | "hand-off-now")[] };
const handoffFixture = { allowedActions: [] as PanelView["handoffs"][number]["allowedActions"], seat: "lead", reason: "context-mark" as const, fromLane: { provider: "pi", model: "glm-5.3" }, toLane: { provider: "pi", model: "glm-5.3" }, startedAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z" };
const healthySeats: NonNullable<PanelView["seats"]> = {
  supervisor: { ...seatDefaults, role: "supervisor", vacant: false, agentId: "agent-sup", statusLabel: "idle", tone: "normal", model: "opus-4-8", hint: null, context: null, handoff: null },
  lead: {
    ...seatDefaults, role: "lead", vacant: false, agentId: "agent-lead", statusLabel: "working", tone: "normal", model: "glm-5.3", hint: null,
    context: { state: "used", usedTokens: 94_400, markTokens: 128_000, label: "94k / 128k", fraction: 0.7375 },
    handoff: null,
  },
  peers: [{ ...seatDefaults, role: "peer", context: { state: "unknown", usedTokens: null, markTokens: 160000, label: "context unknown", fraction: null }, handoff: null, agentId: "agent-peer", task: "T-08", title: "Peer · T-08", disposition: "reviewer", statusLabel: "working", tone: "normal", model: "glm-5.3" }],
  supervisorCandidates: [],
};

function makePanel(overrides: Partial<PanelView> = {}): PanelView {
  return {
    handoffs: [], profile: { active: null, list: [], modified: false },
    defaultWorker: null,
    isProject: true,
    name: "my-app",
    summary: "Lead working · 1 Peer · nothing needs you",
    needsYou: [],
    seats: healthySeats,
    openDesign: { state: "linked", projectName: "Mobile Redesign", syncedAt: new Date(Date.now() - 5 * 60_000).toISOString(), detail: null },
    onboarding: null,
    ...overrides,
  };
}

const noopActions = () => ({
  openAgent() {}, installPrerequisites() {}, handoffStart() {}, handoffReplaceNow() {}, handoffCancel() {}, handoffRetry() {}, viewHandover() {}, startSupervisor() {}, syncOpenDesign() {}, adoptSupervisor() {}, busy: false,
});

async function render(panel: PanelView, props: { theme?: typeof theme; mobile?: boolean; openDesignActions?: unknown; menu?: unknown; initialUi?: Record<string, unknown>; actions?: Record<string, unknown>; width?: number; skillPacks?: unknown[]; selfUpdate?: unknown; release?: ReleaseSettingsView | null; publishPreflight?: Record<string, unknown> | null; releaseFeedback?: { text: string; tone: "info" | "error" } | null; releaseActions?: Record<string, unknown>; storeRelease?: StoreReleaseView | null; storeReleaseBusy?: boolean; storeReleaseFeedback?: { text: string; tone: "info" | "success" | "error" } | null; storeReleaseActions?: Record<string, unknown>; onOpenReleaseLab?: () => void; onOpenSettings?: () => void } = {}): Promise<string> {
  const { ProjectPanel } = await loadPanel();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(
    createElement(ProjectPanel, {
      theme: props.theme ?? theme, panel, mobile: props.mobile ?? false, now: Date.now(), daemonError: null,
      actions: { ...noopActions(), ...(props.actions ?? {}) },
      width: props.width, skillPacks: props.skillPacks,
      ...(props.openDesignActions === undefined ? {} : { openDesignActions: props.openDesignActions }),
      ...(props.menu === undefined ? {} : { menu: props.menu }),
      ...(props.initialUi === undefined ? {} : { initialUi: props.initialUi }),
      ...(props.selfUpdate === undefined ? {} : { selfUpdate: props.selfUpdate }),
      ...(props.release === undefined ? {} : { release: props.release }),
      ...(props.publishPreflight === undefined ? {} : { publishPreflight: props.publishPreflight }),
      ...(props.releaseFeedback === undefined ? {} : { releaseFeedback: props.releaseFeedback }),
      ...(props.releaseActions === undefined ? {} : { releaseActions: props.releaseActions }),
      ...(props.storeRelease === undefined ? {} : { storeRelease: props.storeRelease }),
      ...(props.storeReleaseBusy === undefined ? {} : { storeReleaseBusy: props.storeReleaseBusy }),
      ...(props.storeReleaseFeedback === undefined ? {} : { storeReleaseFeedback: props.storeReleaseFeedback }),
      ...(props.storeReleaseActions === undefined ? {} : { storeReleaseActions: props.storeReleaseActions }),
      ...(props.onOpenReleaseLab === undefined ? {} : { onOpenReleaseLab: props.onOpenReleaseLab }),
      ...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings }),
    }),
  );
}

const hasHook = (html: string, id: string): boolean => html.includes(`data-testid="${id}"`);

test("panel renders the header, summary, seats and Open Design card with the named test hooks — and no Needs-you block when nothing needs the Owner", async () => {
  const html = await render(makePanel());
  assert.match(html, /my-app/);
  assert.match(html, /Lead working · 1 Peer · nothing needs you/);
  for (const hook of ["factory-panel-seat-supervisor", "factory-panel-seat-lead", "factory-panel-seat-peer-T-08"]) {
    assert.ok(hasHook(html, hook), `${hook} renders`);
  }
  assert.equal(hasHook(html, "factory-panel-od"), false, "Open Design lives on the Project tab");
  assert.equal(hasHook(html, "factory-panel-needs-you"), false, "Needs you appears only when something needs the Owner");
  assert.match(html, /Peer · T-08/);
  assert.match(html, /reviewer/);
  assert.match(html, /94k \/ 128k/, "the Lead row reads Nk / 128k");
  assert.doesNotMatch(html, /Handoff:/);
  const project = await render(makePanel(), { initialUi: { tab: "project" } });
  assert.ok(hasHook(project, "factory-panel-od"));
  assert.match(project, /Mobile Redesign/);
  assert.match(project, /Synced 5m ago/);
});

test("Needs you renders each item with its title, detail and exactly one primary action; no Accept button anywhere", async () => {
  const html = await render(
    makePanel({
      summary: "Lead idle · 2 need you",
      needsYou: [
        { key: "needs-human:T-08", kind: "needs-human", title: "T-08 needs your decision", detail: "The Peer stayed silent after a re-poke.", action: { kind: "open-agent", agentId: "agent-sup", label: "Open Supervisor" } },
        { key: "prerequisites", kind: "prerequisites", title: "Required skills & tools are missing", detail: "factory-skills-pack", action: { kind: "install-prerequisites", label: "Install" } },
      ],
    }),
  );
  assert.ok(hasHook(html, "factory-panel-needs-you"));
  assert.match(html, /T-08 needs your decision/);
  assert.match(html, /The Peer stayed silent after a re-poke\./);
  assert.equal((html.match(/Open Supervisor/g) ?? []).length, 1, "one primary action per item");
  assert.match(html, />Install</);
  assert.doesNotMatch(html, /Accept/i, "acceptance stays with the Lead — no Accept button");
  assert.doesNotMatch(html, /Start Lead/i, "the Lead is only ever dispatched by the Supervisor");
});

test("seat states pair working, error and waiting words with the Factory palette", async () => {
  const healthy = await render(makePanel());
  assert.ok(healthy.includes("#337e58"), "a working seat is green");
  assert.match(healthy, /working/);

  const sick = makePanel({
    seats: {
      ...healthySeats,
      supervisor: { ...healthySeats.supervisor, statusLabel: "error", tone: "error", hint: "adapter crashed" },
      lead: { ...healthySeats.lead, statusLabel: "waiting for permission", tone: "waiting" },
    },
  });
  const html = await render(sick);
  const supervisorRow = html.slice(html.indexOf("factory-panel-seat-supervisor"), html.indexOf("factory-panel-seat-lead"));
  assert.ok(supervisorRow.includes("#c8253d"), "the errored seat is red");
  const leadRow = html.slice(html.indexOf("factory-panel-seat-lead"), html.indexOf("factory-panel-peers"));
  assert.ok(leadRow.includes("#8f6802"), "the waiting seat is amber");
});

test("a handoff that is waiting is amber words on the Lead row; a vacant Lead only says to ask the Supervisor — no start button", async () => {
  const pending = await render(
    makePanel({ seats: { ...healthySeats, lead: { ...healthySeats.lead, handoff: { ...handoffFixture, state: "scheduled", waitingPeers: 2 } } } }),
  );
  assert.match(pending, /Scheduled · waiting for 2 Peers/);

  const vacant = await render(
    makePanel({
      seats: {
        ...healthySeats,
        peers: [],
        lead: { ...seatDefaults, role: "lead", vacant: true, agentId: null, statusLabel: "vacant", tone: "normal", model: null, hint: "No Lead is running — ask your Supervisor.", context: null, handoff: null },
      },
    }),
  );
  assert.match(vacant, /No Lead is running — ask your Supervisor\./);
  const vacantLeadRow = vacant.slice(vacant.indexOf("factory-panel-seat-lead"));
  assert.doesNotMatch(vacantLeadRow, /<button/, "a vacant Lead offers no button — not Open, not Rotate, not Start");
  assert.equal(hasHook(vacant, "factory-panel-peers"), false, "the Peers section is hidden when no Peer is running");
});

test("an unlinked Open Design card shows the Not linked badge and status line", async () => {
  const html = await render(makePanel({ openDesign: { state: "unlinked", projectName: null, syncedAt: null, detail: null } }), { initialUi: { tab: "project" } });
  const card = elementOf(html, "factory-panel-od");
  assert.match(card, /Open Design/);
  assert.match(card, /Not linked/);
  assert.match(card, /Not linked to an Open Design project\./);
});

test("desktop mounts the Open Design actions on the card; mobile shows the link status alone", async () => {
  const { createElement } = await import("react");
  const actions = createElement("button", { "data-testid": "od-actions" }, "Sync");
  const desktop = await render(makePanel(), { mobile: false, openDesignActions: actions, initialUi: { tab: "project" } });
  assert.ok(hasHook(desktop, "od-actions"), "desktop offers Sync / Studio");
  const mobile = await render(makePanel(), { mobile: true, openDesignActions: actions, initialUi: { tab: "project" } });
  assert.equal(hasHook(mobile, "od-actions"), false, "mobile never offers Sync or Studio");
  assert.match(mobile, /Mobile Redesign/, "the link status still shows");
});

test("mobile hides the prerequisite install (a settings write) but keeps conversation jumps", async () => {
  const panel = makePanel({
    needsYou: [
      { key: "seat-stuck:lead", kind: "seat-stuck", title: "Lead errored", detail: null, action: { kind: "open-agent", agentId: "agent-lead", label: "Open Lead" } },
      { key: "prerequisites", kind: "prerequisites", title: "Required skills & tools are missing", detail: "factory-skills-pack", action: { kind: "install-prerequisites", label: "Install" } },
    ],
  });
  const mobile = await render(panel, { mobile: true });
  assert.match(mobile, /Open Lead/);
  assert.doesNotMatch(mobile, />Install</);
});

test("every Needs-you action kind renders one button on desktop; on mobile the install, start and sync acts say to use Desktop instead of vanishing", async () => {
  const items = [
    { key: "needs-human:T-08", kind: "needs-human", title: "T-08 needs your decision", detail: null, action: { kind: "start-supervisor", label: "Start Supervisor" } },
    { key: "prerequisites", kind: "prerequisites", title: "Required skills & tools are missing", detail: "factory-skills-pack", action: { kind: "install-prerequisites", label: "Install" } },
    { key: "open-design-broken", kind: "open-design-broken", title: "Open Design link is broken", detail: "The staged design files are missing — sync the design again.", action: { kind: "sync-open-design", label: "Sync again" } },
    { key: "seat-stuck:lead", kind: "seat-stuck", title: "Lead errored", detail: null, action: { kind: "open-agent", agentId: "agent-lead", label: "Open Lead" } },
  ] as PanelView["needsYou"];
  const action = (html: string, key: string): boolean => hasHook(html, `factory-panel-needs-you-action-${key}`);
  const hint = (html: string, key: string): boolean => hasHook(html, `factory-panel-needs-you-hint-${key}`);
  const desktop = await render(makePanel({ needsYou: items }), { mobile: false });
  for (const item of items) { assert.ok(action(desktop, item.key), `${item.key} has its button on desktop`); assert.equal(hint(desktop, item.key), false); }
  const mobile = await render(makePanel({ needsYou: items }), { mobile: true });
  assert.ok(action(mobile, "seat-stuck:lead"), "a conversation jump works on mobile");
  for (const key of ["needs-human:T-08", "prerequisites", "open-design-broken"]) {
    assert.equal(action(mobile, key), false, `${key} offers no button on mobile`);
    assert.ok(hint(mobile, key), `${key} says what to do instead`);
  }
  assert.match(mobile, /on Paseo Desktop/);
});

test("a workspace that is not a Project says to set it up on Desktop on mobile, and mounts the onboarding wizard on desktop", async () => {
  const notProject = makePanel({
    isProject: false, name: null, summary: "Not a Factory Project yet", seats: null, openDesign: null,
    onboarding: { folder: "/work/new-app", gitRepo: true, hasCommits: false, existingLead: false },
  });
  const mobile = await render(notProject, { mobile: true });
  assert.ok(hasHook(mobile, "factory-panel-onboarding"));
  assert.match(mobile, /Set this Project up on Paseo Desktop\./);
  const desktop = await render(notProject, { mobile: false });
  assert.match(desktop, /Set up Factory for this folder/);
  assert.doesNotMatch(desktop, /Set this Project up on Paseo Desktop/);
  assert.equal(hasHook(desktop, "factory-panel-needs-you") || hasHook(desktop, "factory-panel-seat-lead") || hasHook(desktop, "factory-panel-od"), false, "no Project, no panel sections");
});

// ---- v0.6.0 W6 (ADR 0056): the panel's actions ------------------------------------------------

const vacantSupervisorSeats: NonNullable<PanelView["seats"]> = {
  ...healthySeats,
  supervisor: { ...seatDefaults, role: "supervisor", vacant: true, agentId: null, statusLabel: "vacant", tone: "normal", model: null, hint: "No Supervisor is running.", context: null, handoff: null },
};

test("every live seat row has an Open action — Supervisor, Lead and each Peer — on desktop and on mobile", async () => {
  for (const mobile of [false, true]) {
    const html = await render(makePanel(), { mobile });
    for (const hook of ["factory-panel-open-supervisor", "factory-panel-open-lead", "factory-panel-open-peer-T-08"]) {
      assert.ok(hasHook(html, hook), `${hook} renders (mobile=${mobile})`);
    }
  }
});

test("Hand off now sits on the live Lead row on desktop and mobile; a vacant Lead carries none", async () => {
  for (const mobile of [false, true]) {
    const html = await render(makePanel(), { mobile });
    const leadRow = html.slice(html.indexOf("factory-panel-seat-lead"), html.indexOf("factory-panel-peers"));
    assert.ok(hasHook(leadRow, "factory-seat-hand-off-now-lead"), `Hand off on the Lead row (mobile=${mobile})`);
    assert.equal((html.match(/factory-seat-hand-off-now-lead/g) ?? []).length, 1);
  }
  const vacantLead = makePanel({ seats: { ...healthySeats, lead: { ...healthySeats.lead, vacant: true, agentId: null, statusLabel: "vacant", model: null, hint: "No Lead is running — ask your Supervisor.", context: null, handoff: null } } });
  const html = await render(vacantLead);
  assert.equal(hasHook(html, "factory-seat-hand-off-now-lead"), false);
  assert.equal(hasHook(html, "factory-panel-open-lead"), false);
});

test("Supervisor Hand off now is a direct live-row action on Desktop and mobile and honors server permission", async () => {
  for (const mobile of [false, true]) {
    const html = await render(makePanel(), { mobile });
    assert.ok(hasHook(html, "factory-seat-hand-off-now-supervisor"));
    assert.equal(hasHook(html, "factory-panel-supervisor-menu"), false);
    assert.doesNotMatch(html, /revoke/i);
    const blocked = await render(makePanel({ seats: { ...healthySeats, supervisor: { ...healthySeats.supervisor, allowedActions: [] } } }), { mobile });
    assert.equal(hasHook(blocked, "factory-seat-hand-off-now-supervisor"), false);
  }
  const vacant = await render(makePanel({ seats: vacantSupervisorSeats }));
  assert.equal(hasHook(vacant, "factory-seat-hand-off-now-supervisor"), false);
});

test("a vacant Supervisor offers Start Supervisor directly without a directive box on desktop; mobile offers neither; a live Supervisor never does", async () => {
  const desktop = await render(makePanel({ seats: vacantSupervisorSeats }));
  assert.ok(hasHook(desktop, "factory-panel-start-supervisor"));
  assert.equal(hasHook(desktop, "factory-panel-directive"), false, "no First directive box on vacant Supervisor");
  assert.match(desktop, /Start Supervisor/);
  assert.equal(hasHook(desktop, "factory-panel-open-supervisor"), false, "a vacant seat has no conversation to open");

  const mobile = await render(makePanel({ seats: vacantSupervisorSeats }), { mobile: true });
  assert.equal(hasHook(mobile, "factory-panel-start-supervisor"), false, "mobile starts nothing");
  assert.equal(hasHook(mobile, "factory-panel-directive"), false);
  assert.match(mobile, /No Supervisor is running\./, "the vacancy still reads");

  const live = await render(makePanel());
  assert.equal(hasHook(live, "factory-panel-start-supervisor"), false);
  assert.doesNotMatch(live, /Start Lead/);
});

test("clicking Start Supervisor on a vacant desktop Supervisor row immediately invokes startSupervisor with no directive", async () => {
  const calls: unknown[][] = [];
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: makePanel({ seats: vacantSupervisorSeats }),
          mobile: false,
          now: Date.now(),
          daemonError: null,
          actions: {
            ...noopActions(),
            startSupervisor: (...args: unknown[]) => {
              calls.push(args);
            },
          },
        }),
      ),
    );
    assert.equal(container.querySelector('[data-testid="factory-panel-directive"]'), null);
    const startButton = container.querySelector('[data-testid="factory-panel-start-supervisor"]') as HTMLButtonElement | null;
    assert.ok(startButton);
    await act(() => startButton.click());
    assert.deepEqual(calls, [[]]);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }
});

test("the header ⋯ appears only when the shell supplies a menu, and its content only once opened", async () => {
  const { createElement } = await import("react");
  const menu = createElement("div", { "data-testid": "menu-content" }, "Project settings");
  assert.equal(hasHook(await render(makePanel()), "factory-panel-menu-toggle"), false, "no menu supplied, no ⋯");
  const closed = await render(makePanel(), { menu });
  assert.ok(hasHook(closed, "factory-panel-menu-toggle"));
  assert.equal(hasHook(closed, "menu-content"), false);
  const open = await render(makePanel(), { menu, initialUi: { menuOpen: true } });
  assert.ok(hasHook(open, "menu-content"));
  assert.ok(hasHook(open, "factory-panel-menu"));
});

test("Project menu on desktop preserves two-step Reset / Delete", async () => {
  const { ProjectMenu } = await loadMenu();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const props = {
    theme, mobile: false, busy: false, missingRoot: false,
    openSettings() {}, resetProject() {}, rotateSeats() {}, deleteProject() {},
  };
  const html = renderToStaticMarkup(createElement(ProjectMenu, props));
  for (const hook of ["factory-panel-open-settings", "factory-panel-menu-reset", "factory-panel-menu-rotate", "factory-panel-menu-delete"]) {
    assert.ok(hasHook(html, hook), `${hook} renders on desktop`);
  }
  assert.doesNotMatch(html, /Confirm Reset|Confirm Delete|Confirm Rotate/, "a single press never destroys — all start unarmed");

  const resetArmed = renderToStaticMarkup(createElement(ProjectMenu, { ...props, initialConfirming: "reset" }));
  assert.match(resetArmed, /Confirm Reset/);
  assert.ok(hasHook(resetArmed, "factory-panel-menu-confirm-reset"));
  assert.doesNotMatch(resetArmed, /Confirm Delete/);
  assert.match(resetArmed, /Cancel/);
  const deleteArmed = renderToStaticMarkup(createElement(ProjectMenu, { ...props, initialConfirming: "delete" }));
  assert.ok(hasHook(deleteArmed, "factory-panel-menu-confirm-delete"));
  assert.doesNotMatch(deleteArmed, /Confirm Reset/);
  const rotateArmed = renderToStaticMarkup(createElement(ProjectMenu, { ...props, initialConfirming: "rotate" }));
  assert.ok(hasHook(rotateArmed, "factory-panel-menu-confirm-rotate"), "armed Rotate renders its confirm");
  assert.match(rotateArmed, /Confirm Rotate/);
  assert.equal(hasHook(rotateArmed, "factory-panel-menu-rotate"), false, "the idle button is replaced by the confirm");
  assert.doesNotMatch(rotateArmed, /Confirm Reset|Confirm Delete/);
  assert.match(rotateArmed, /Cancel/);
  assert.ok(hasHook(rotateArmed, "factory-panel-menu-reset"), "the other acts stay idle while Rotate is armed");
});

test("Project menu on mobile is view-only — no pack toggles, no Reset, no Delete", async () => {
  const { ProjectMenu } = await loadMenu();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(createElement(ProjectMenu, {
    theme, mobile: true, busy: false, missingRoot: false,
    openSettings() {}, resetProject() {}, rotateSeats() {}, deleteProject() {},
  }));
  assert.doesNotMatch(html, /Models for this Project|Skill packs/);
  assert.doesNotMatch(html, /<button/, "a mobile menu carries no writes at all");
  for (const hook of ["factory-panel-skill-expo", "factory-panel-menu-reset", "factory-panel-menu-rotate", "factory-panel-menu-confirm-rotate", "factory-panel-menu-delete"]) {
    assert.equal(hasHook(html, hook), false, `${hook} stays off mobile`);
  }
});

test("a Project whose folder is gone keeps Delete but drops Reset and the model / Open Design controls", async () => {
  const { ProjectMenu } = await loadMenu();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(createElement(ProjectMenu, {
    theme, mobile: false, busy: false, missingRoot: true,
    openSettings() {}, resetProject() {}, rotateSeats() {}, deleteProject() {},
  }));
  assert.ok(hasHook(html, "factory-panel-menu-delete"));
  assert.equal(hasHook(html, "factory-panel-menu-reset"), false);
  assert.equal(hasHook(html, "factory-panel-menu-rotate"), false, "Rotate needs the folder too");
  assert.equal(hasHook(html, "factory-panel-open-settings"), false);
});

// ---- v0.6.1 W3 (ADR 0057 §5/§10): no-supervisor item + Use this chat as Supervisor -----------

const noSupervisorItem = {
  key: "no-supervisor",
  kind: "no-supervisor",
  title: "No Supervisor · 2 reports waiting",
  detail: null,
  action: { kind: "start-supervisor", label: "Start Supervisor" },
} as PanelView["needsYou"][number];

test("the no-supervisor Needs-you item renders with its hook and one action; mobile keeps the Start-Supervisor hint instead of the button (03, ADR 0057 §5)", async () => {
  const desktop = await render(makePanel({ needsYou: [noSupervisorItem], summary: "No Supervisor · 2 need you" }), { mobile: false });
  assert.ok(hasHook(desktop, "factory-panel-needs-you-no-supervisor"), "the item's test hook renders");
  assert.match(desktop, /No Supervisor · 2 reports waiting/);
  assert.ok(hasHook(desktop, "factory-panel-needs-you-action-no-supervisor"), "Start Supervisor is the one action on desktop");
  const mobile = await render(makePanel({ needsYou: [noSupervisorItem], summary: "No Supervisor · 2 need you" }), { mobile: true });
  assert.ok(hasHook(mobile, "factory-panel-needs-you-no-supervisor"), "the item still shows on mobile");
  assert.equal(hasHook(mobile, "factory-panel-needs-you-action-no-supervisor"), false, "mobile starts nothing — the hint instead");
  assert.ok(hasHook(mobile, "factory-panel-needs-you-hint-no-supervisor"), "the mobile hint names where to start it");
  assert.match(mobile, /Start the Supervisor on Paseo Desktop\./);
});

test("a live Supervisor with a candidate chat renders the candidate row with 'Use this chat as Supervisor' on desktop AND mobile — and no rows when there is none (03, ADR 0057 §5/§10)", async () => {
  const panel = makePanel({
    seats: {
      ...healthySeats,
      supervisorCandidates: [
        { allowedActions: ["adopt"], agentId: "agent-candidate", title: "Chat about release", statusLabel: "idle", tone: "error", model: "glm-5.3" },
      ],
    },
  });
  for (const mobile of [false, true]) {
    const html = await render(panel, { mobile });
    assert.ok(hasHook(html, "factory-panel-supervisor-candidates"), `the candidates block renders (mobile=${mobile})`);
    assert.match(html, /Chat about release/, "the candidate chat is named");
    assert.ok(hasHook(html, "factory-panel-adopt-supervisor"), `the adopt button renders (mobile=${mobile})`);
    assert.match(html, /Use this chat as Supervisor/, "the button carries its label");
    const statusBadge = elementOf(html, "factory-seat-status-supervisor-candidate");
    assert.match(statusBadge, />idle</);
    assert.ok(statusBadge.includes("#67717618") && statusBadge.includes("#67717666"), "candidate status renders as statusLabel-strict ToneBadge pill even when row.tone differs");
    assert.ok(statusBadge.includes("&quot;borderRadius&quot;:999"), "candidate status badge is a pill with dot");
    assert.ok(statusBadge.includes("&quot;backgroundColor&quot;:&quot;#677176&quot;"), "candidate status badge includes dot");
  }
  const workingPanel = makePanel({
    seats: {
      ...healthySeats,
      supervisorCandidates: [
        { allowedActions: ["adopt"], agentId: "agent-candidate-2", title: "Active chat", statusLabel: "working", tone: "normal", model: null },
      ],
    },
  });
  const dark = { colors: { ...theme.colors, surface0: "#000000" } };
  const workingHtml = await render(workingPanel, { theme: dark });
  const workingBadge = elementOf(workingHtml, "factory-seat-status-supervisor-candidate");
  assert.match(workingBadge, />working</);
  assert.ok(workingBadge.includes("#68b78d18") && workingBadge.includes("#68b78d66"), "dark working candidate status uses ok palette");
  const none = await render(makePanel());
  assert.equal(hasHook(none, "factory-panel-supervisor-candidates"), false, "no candidate, no block");
  assert.equal(hasHook(none, "factory-panel-adopt-supervisor"), false);
});

test("the adopt button rides the factory.supervisor.adopt RPC through the shell — no mobile guard, and success opens the adopted chat", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /useRpc\(supervisorAdopt\)/, "the shell binds the adopt RPC");
  assert.match(shell, /supervisorAdoptCall\(\{ projectRoot, agentId \}\)/, "the adopt action passes the Project and the candidate's agent id");
  const adoptGuard = shell.slice(shell.indexOf("const adoptSupervisor"), shell.indexOf(";", shell.indexOf("supervisorAdoptCall")));
  assert.doesNotMatch(adoptGuard, /mobile/, "adopt is the one seat write mobile may perform (ADR 0057 §10)");
  assert.match(shell, /<ProjectPanel/, "the panel still mounts");
});

// ---- the shell's host wiring (not mountable in Node) ----------------------------------------

const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

function clientSources(dir: string): string[] {
  return readdirSync(join(repoRoot, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(repoRoot, rel)).isDirectory() ? clientSources(rel) : /\.tsx?$/.test(name) ? [rel] : [];
  });
}

test("no client source offers Start Lead or an Accept action — acceptance and Lead dispatch stay off the surface (ADR 0017, ADR 0056)", () => {
  for (const file of clientSources("plugin/client")) {
    const source = read(file);
    assert.doesNotMatch(source, /Start Lead/, `${file} has no Start Lead`);
    assert.doesNotMatch(source, /\bfactory\.accept\b|label="Accept"|\bonAccept\b/, `${file} has no Accept action`);
  }
});

test("W10: the shell passes measured width and mounts the single unified Open Design control on the Project tab", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /width=\{containerWidth\}/);
  assert.match(shell, /part="unified"/);
  assert.equal((shell.match(/<OpenDesignControl\b/g) ?? []).length, 1, "only one unified OpenDesignControl mounts");
  assert.doesNotMatch(shell, /part="card"|part="menu"/);
  assert.match(read("plugin/index.client.tsx"), /client\.openSettings\("paseo-factory"\)/);
  assert.match(read("plugin/client/factory/entries.tsx"), /FactoryTabErrorBoundary/);
});

test("the shell reads mobile from the host layout platform, mounts the panel on the workspace panel host only, and mounts no settings write on mobile", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /layout\?\.platform === "ios" \|\| layout\?\.platform === "android"/);
  assert.match(shell, /<ProjectPanel/);
  assert.match(shell, /panel=\{view\.panel\}/, "the panel renders the server's projection, never a client re-derivation");
  assert.match(shell, /mobile\s*\?\s*\{\s*models: <SettingsReadOnly/, "on mobile every Settings section is the read-only summary");
  const entries = read("plugin/client/factory/entries.tsx");
  assert.match(entries, /surface="settings"/, "the settings screen is the other host");
});

test("shell wiring: every action rides its RPC — handoff, Start Supervisor (then opens the new seat), Reset, Delete — and no Lead start or accept RPC is bound", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  for (const rpc of ["handoffStart", "supervisorStart", "projectReset", "projectRotate", "projectDelete"]) {
    assert.match(shell, new RegExp(`useRpc\\(${rpc}\\)`), `${rpc} is bound`);
  }
  assert.doesNotMatch(shell, /useRpc\((leadEnsure|supervisorEnsure|leadDispatch)\)/, "the only seat creation is Start Supervisor");
  assert.match(shell, /navigation\?\.openAgent\(\{ agentId: reply\.agentId/, "Start Supervisor opens the conversation it created");
  assert.match(shell, /<ProjectMenu/);
  assert.match(shell, /act\("Rotate seats", \(\) => projectRotateCall\(\{ projectRoot \}\)\)/, "Rotate seats rides act so the reply summary or the peers-live refusal is the toast");
  assert.match(shell, /rotateSeats=\{rotateSeats\}/);
  assert.match(shell, /const rotateSeats = \(\): void => \{\s*if \(projectRoot === undefined \|\| mobile\) return;/, "Rotate is guarded on desktop");
});

test("W6 mobile pins: the shell hands the menu its read-only mode and the panel and menu gate their writes on the mobile flag", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /skillPacks=\{view\.skillHub\?\.projectPacks \?\? \[\]\}/, "pack state moves to the main panel");
  assert.match(shell, /mobile=\{mobile\}/);
  assert.match(read("plugin/client/factory/project-panel.tsx"), /!mobile/, "the panel gates its desktop-only affordances on the mobile flag");
  assert.match(read("plugin/client/factory/project-menu.tsx"), /mobile/, "the menu gates its writes on the mobile flag");
});

test("W10: Factory palette follows the host background luminance and freezes pi's role/state/thinking colours", async () => {
  const { factoryPalette } = await loadModule("plugin/client/kit/theme.ts");
  const light = factoryPalette(theme);
  assert.equal(light.supervisor, "#7459b4");
  assert.equal(light.lead, "#2f7899");
  assert.equal(light.peer, "#287a81");
  assert.equal(light.ok, "#337e58");
  assert.deepEqual(light.thinking, ["#677176", "#3d8eb3", "#4f6fc0", "#7459b4", "#b23a98", "#c8253d"]);
  const dark = factoryPalette({ colors: { ...theme.colors, surface0: "#000" } });
  assert.equal(dark.supervisor, "#a798d7");
  assert.equal(dark.lead, "#5fa8cc");
  assert.equal(dark.peer, "#5db3ba");
  assert.deepEqual(dark.thinking, ["#6c767b", "#5489a4", "#6185cc", "#9776e5", "#de54c1", "#fe5462"]);
  assert.equal(factoryPalette({ colors: { ...theme.colors, surface0: "rgb(255, 255, 255)" } }).bad, "#c8253d");
});

test("01-badges: statusBadgeColour and dispositionColour map strictly 1:1 from statusLabel and disposition across light/dark", async () => {
  const { statusBadgeTone, statusBadgeColour, dispositionColour } = await loadModule("plugin/client/kit/theme.ts");
  const darkTheme = { colors: { ...theme.colors, surface0: "#000000" } };

  for (const [label, expectedTone, lightHex, darkHex] of [
    ["working", "ok", "#337e58", "#68b78d"],
    ["starting", "wait", "#8f6802", "#cd9a22"],
    ["waiting for permission", "wait", "#8f6802", "#cd9a22"],
    ["error", "bad", "#c8253d", "#fe5462"],
    ["idle", "idle", "#677176", "#6c767b"],
    ["vacant", "idle", "#677176", "#6c767b"],
  ] as const) {
    assert.equal(statusBadgeTone(label), expectedTone, `tone for ${label}`);
    assert.equal(statusBadgeColour(theme, label), lightHex, `light colour for ${label}`);
    assert.equal(statusBadgeColour(darkTheme, label), darkHex, `dark colour for ${label}`);
  }

  for (const [disp, lightHex, darkHex] of [
    ["engineer", "#4f6fc0", "#6185cc"],
    ["architect", "#7459b4", "#9776e5"],
    ["scout", "#287a81", "#5db3ba"],
    ["reviewer", "#b23a98", "#de54c1"],
  ] as const) {
    assert.equal(dispositionColour(theme, disp), lightHex, `light disposition ${disp}`);
    assert.equal(dispositionColour(darkTheme, disp), darkHex, `dark disposition ${disp}`);
  }
});

const at = (html: string, id: string): number => html.indexOf(`data-testid="${id}"`);

/** The balanced `<div>` that carries `data-testid="<id>"` — the harness renders every View as a div. */
function elementOf(html: string, id: string): string {
  const start = html.lastIndexOf("<div", at(html, id));
  let depth = 0;
  for (const m of html.slice(start).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, start + m.index! + m[0].length);
  }
  throw new Error(`unbalanced markup for ${id}`);
}

test("04: the alert stack renders before the tabs, only the active tab's body renders, and no two-column split remains", async () => {
  const panel = makePanel({
    needsYou: [noSupervisorItem],
    handoffs: [{ ...handoffFixture, seat: "peer:T-absent", state: "failed", failure: "successor unavailable" }],
    defaultWorker: { role: "worker", title: "Default worker", lane: { provider: "pi", model: "worker-model", scope: "project" } },
  });
  const props = { skillPacks: [{ id: "expo", label: "Expo", enabled: true, autoDetected: true }] };
  for (const width of [0, 899, 900, 1400]) {
    const team = await render(panel, { ...props, width });
    assert.equal(hasHook(team, "factory-tab-col-left") || hasHook(team, "factory-tab-col-right"), false, `no two-column split at ${width}`);
    const order = ["factory-alert-stack", "factory-panel-needs-you", "factory-handoff-block", "factory-tab", "factory-tab-body-team", "factory-panel-seats"];
    for (let i = 1; i < order.length; i++) assert.ok(at(team, order[i - 1]!) >= 0 && at(team, order[i - 1]!) < at(team, order[i]!), `${order[i - 1]} precedes ${order[i]} at ${width}`);
    for (const absent of ["factory-tab-body-models", "factory-tab-body-project", "factory-default-worker", "factory-skill-packs", "factory-panel-od"]) assert.equal(hasHook(team, absent), false, `${absent} is not on the Team tab`);
    assert.match(team, /peer:T-absent/);
    assert.match(team, /successor unavailable/);
    assert.ok(hasHook(team, "factory-profile-chip"));
  }
  const models = await render(panel, { ...props, initialUi: { tab: "models" } });
  assert.ok(at(models, "factory-tab-body-models") < at(models, "factory-default-worker"), "Models body holds the Default worker");
  assert.match(models, /worker-model/);
  for (const absent of ["factory-panel-seats", "factory-skill-packs", "factory-panel-od"]) assert.equal(hasHook(models, absent), false, `${absent} is not on the Models tab`);
  assert.ok(hasHook(models, "factory-panel-needs-you"), "the alert stack stays above every tab");
  const project = await render(panel, { ...props, initialUi: { tab: "project" } });
  assert.ok(at(project, "factory-tab-body-project") < at(project, "factory-skill-packs") && at(project, "factory-skill-packs") < at(project, "factory-panel-od"), "Project body holds the skill packs, then Open Design");
  assert.match(project, /Expo/);
  assert.match(project, /Auto-detected/);
  assert.equal(hasHook(project, "factory-default-worker") || hasHook(project, "factory-panel-seats"), false);
});

test("04: Team, Models and Project tabs show the seeded tab as selected, and the panel is a centred 1040px column", async () => {
  const html = await render(makePanel(), { initialUi: { tab: "models" } });
  for (const [id, selected] of [["team", "false"], ["models", "true"], ["project", "false"]] as const) {
    assert.match(html, new RegExp(`data-testid="factory-tab-${id}"[^>]*data-selected="${selected}"|data-selected="${selected}"[^>]*data-testid="factory-tab-${id}"`), `${id} selected=${selected}`);
  }
  assert.match(html, /Team[\s\S]*Models[\s\S]*Project/);
  assert.equal(hasHook(await render(makePanel()), "factory-tab-body-team"), true, "Team is the default tab");
  const panelStyle = elementOf(html, "factory-panel").slice(0, 400);
  assert.match(panelStyle, /&quot;width&quot;:&quot;100%&quot;,&quot;maxWidth&quot;:1040,&quot;alignSelf&quot;:&quot;center&quot;/);
});

test("04: wide alerts put their actions on the title line; narrow ones drop them below the detail", async () => {
  const failed = { ...handoffFixture, seat: "supervisor", state: "failed" as const, failure: "boom", allowedActions: ["retry", "replace-now"] as PanelView["handoffs"][number]["allowedActions"] };
  const item = { ...noSupervisorItem } as PanelView["needsYou"][number];
  const panel = makePanel({ needsYou: [item], handoffs: [failed] });
  const wide = await render(panel, { width: 900 });
  const narrow = await render(panel, { width: 500 });
  assert.ok(at(wide, "factory-handoff-retry") < wide.indexOf("Context mark"), "wide: Try again sits on the title line");
  assert.ok(narrow.indexOf("Context mark") < at(narrow, "factory-handoff-retry"), "narrow: Try again sits below the detail");
  assert.ok(at(wide, "factory-panel-needs-you-action-no-supervisor") < at(wide, "factory-handoff-supervisor"), "the Needs-you item stays above the handoff row");
  assert.doesNotMatch(wide, />Needs you<|>Handoff</, "the section titles are gone — the tone bars say enough");
});

test("04: the header carries the profile chip (name ▾) and the ghost ⋯ toggle; a mobile chip is plain text", async () => {
  const { createElement } = await import("react");
  const menu = createElement("div", null, "menu");
  const desktop = await render(makePanel(), { menu, actions: { applyProfile() {} } });
  assert.match(desktop, /data-testid="factory-profile-chip"[^>]*>(<span[^>]*>)?No Lane profile ▾/);
  assert.ok(hasHook(desktop, "factory-panel-menu-toggle"));
  const mobile = await render(makePanel(), { mobile: true, menu, actions: { applyProfile() {} } });
  assert.doesNotMatch(mobile, /▾/);
  assert.match(mobile, /No Lane profile/);
});

const lanes = { supervisor: "pi/a", lead: "pi/a", worker: "pi/a", watch: "pi/a", freshEyes: "pi/a" };
const profileOf = (id: string, name: string): PanelView["profile"]["list"][number] => ({ id, name, description: null, lanes, updatedAt: "2026-11-13T00:00:00Z" });
const modelsPanel = () => makePanel({
  defaultWorker: { role: "worker", title: "Default worker", lane: { provider: "pi", model: "worker-model", scope: "project" } },
  profile: { active: profileOf("balanced", "Balanced"), list: [profileOf("balanced", "Balanced"), profileOf("fast", "Fast")], modified: true },
});

test("06: the Models tab lists Supervisor, Lead and Default worker rows with unique chip hooks, scope words and the Peer note", async () => {
  const html = await render(modelsPanel(), { initialUi: { tab: "models" } });
  for (const hook of ["factory-seat-chip-models-supervisor", "factory-seat-chip-models-lead", "factory-seat-chip-worker", "factory-default-worker"]) assert.equal(html.split(`data-testid="${hook}"`).length, 2, `${hook} renders exactly once`);
  assert.equal(hasHook(html, "factory-seat-chip-supervisor") || hasHook(html, "factory-seat-chip-lead"), false, "the Team tab's chip hooks stay off the Models tab");
  assert.ok(at(html, "factory-models-row-supervisor") < at(html, "factory-models-row-lead") && at(html, "factory-models-row-lead") < at(html, "factory-default-worker"), "Supervisor, Lead, then Default worker");
  assert.match(html, /Seat models/);
  assert.match(html, /Project override/, "the worker's project scope");
  assert.match(html, /Machine default/, "a machine-scoped seat");
  assert.match(html, /Default worker applies to new Peers\. Running Peers keep their model\./);
  assert.equal(hasHook(await render(modelsPanel(), { initialUi: { tab: "team" } }), "factory-seat-chip-models-lead"), false);
});

test("06: the Lane profile section names the active profile as modified and lists Apply rows on desktop only", async () => {
  const desktop = await render(modelsPanel(), { initialUi: { tab: "models" }, actions: { applyProfile() {} } });
  assert.match(desktop, /Lane profile/);
  assert.match(desktop, /Balanced[\s\S]*modified/);
  assert.ok(hasHook(desktop, "factory-profile-apply-fast"), "an inactive profile has Apply");
  assert.equal(hasHook(desktop, "factory-profile-apply-balanced"), false, "the active one shows Active instead");
  assert.match(desktop, />Active</);
  const empty = await render(makePanel(), { initialUi: { tab: "models" }, actions: { applyProfile() {} } });
  assert.match(empty, /Save a Lane profile to reuse this Project’s models\./);
  const mobile = await render(modelsPanel(), { mobile: true, initialUi: { tab: "models" }, actions: { applyProfile() {} } });
  assert.match(mobile, /Balanced/);
  assert.equal(hasHook(mobile, "factory-profile-apply-fast"), false, "mobile writes no profile");
  assert.doesNotMatch(mobile, /Save a Lane profile in Settings/);
});

test("06: a skill pack is a switch whose checked state follows `enabled`; inactive packs collapse behind a drawer and mobile shows On/Off with no switch", async () => {
  const packs = [{ id: "expo", label: "Expo", enabled: true, autoDetected: true }, { id: "web", label: "Web", enabled: false, autoDetected: false }];
  const collapsed = await render(makePanel(), { initialUi: { tab: "project" }, skillPacks: packs, actions: { toggleSkillPack() {} } });
  assert.ok(hasHook(collapsed, "factory-skill-packs-inactive-toggle"));
  assert.equal(hasHook(collapsed, "factory-skill-pack-web"), false, "disabled packs start collapsed behind the inactive drawer");

  const desktop = await render(makePanel(), { initialUi: { tab: "project", expandedSkillPacks: ["web"] }, skillPacks: packs, actions: { toggleSkillPack() {} } });
  const tagOf = (html: string, id: string): string => html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))![0];
  const on = tagOf(desktop, "factory-skill-pack-expo");
  const off = tagOf(desktop, "factory-skill-pack-web");
  assert.match(on, /data-role="switch"/); assert.match(on, /data-checked="true"/); assert.match(on, /aria-label="Disable Expo"/);
  assert.match(off, /data-role="switch"/); assert.match(off, /data-checked="false"/); assert.match(off, /aria-label="Enable Web"/);
  const mobile = await render(makePanel(), { mobile: true, initialUi: { tab: "project", expandedSkillPacks: ["web"] }, skillPacks: packs, actions: { toggleSkillPack() {} } });
  assert.equal(hasHook(mobile, "factory-skill-pack-expo"), false, "no switch on mobile");
  assert.match(mobile, /Expo[\s\S]*Auto-detected[\s\S]*>On</);
  assert.match(mobile, />Off</);
});

test("06: the Project tab's sections are unified bordered Card containers", async () => {
  const html = await render(makePanel({ usage: recordedUsage }), {
    initialUi: { tab: "project" },
    skillPacks: [{ id: "expo", label: "Expo", enabled: true, autoDetected: false }],
    release: makeRelease(),
    storeRelease: makeStoreRelease({ isMobile: true, platforms: ["ios"] }),
  });
  for (const id of ["project-usage-card", "factory-skill-packs", "factory-panel-od", "factory-panel-github-release", "factory-panel-store-release"]) {
    const card = elementOf(html, id);
    const rootTag = card.slice(0, card.indexOf(">"));
    assert.match(rootTag, /&quot;borderWidth&quot;:1,&quot;borderColor&quot;:&quot;#cccccc&quot;,&quot;backgroundColor&quot;:&quot;#f5f5f5&quot;,&quot;borderRadius&quot;:8,&quot;padding&quot;:12/, `${id} uses Card styling`);
  }
  assert.doesNotMatch(elementOf(html, "factory-panel-od").slice(0, elementOf(html, "factory-panel-od").indexOf(">")), /borderTopWidth&quot;:1/);
});

test("W10: seat roles, state words and model chips carry semantic colour and context uses the real mark", async () => {
  const seats = {
    ...healthySeats,
    supervisor: { ...healthySeats.supervisor, context: { state: "unknown" as const, usedTokens: null, markTokens: 64000, label: "context unknown", fraction: null } },
    lead: { ...healthySeats.lead, lane: { provider: "pi", model: "old-model", thinking: "high", scope: "project" as const }, pendingLane: { provider: "codex", model: "new-model", thinking: "max", scope: "project" as const }, context: { state: "used" as const, usedTokens: 60000, markTokens: 64000, label: "60k / 64k", fraction: 0.9375 } },
  };
  const html = await render(makePanel({ seats }));
  assert.ok(hasHook(html, "factory-seat-supervisor"));
  assert.ok(hasHook(html, "factory-seat-chip-lead"));
  assert.ok(hasHook(html, "factory-seat-peer-T-08"));
  assert.match(html, /old-model → new-model/);
  assert.match(html, /max/);
  assert.match(html, /Project/);
  assert.match(html, /context unknown/);
  assert.match(html, /60k \/ 64k/);
  assert.ok(html.includes("#7459b4"), "Supervisor role identity");
  assert.ok(html.includes("#2f7899"), "Lead role identity");
  assert.ok(html.includes("#287a81"), "Peer role identity");
  assert.ok(html.includes("#337e58"), "working word is green");
  assert.ok(html.includes("#c8253d"), "max thinking word uses the ramp");
  assert.ok(html.includes("#b23a98"), "context fill approaching the mark is magenta");
});

test("W10: the reduced Project menu contains Reset, Delete and Open Settings only", async () => {
  const { ProjectMenu } = await loadMenu();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(createElement(ProjectMenu, { theme, mobile: false, busy: false, missingRoot: false, resetProject() {}, deleteProject() {}, openSettings() {} }));
  assert.ok(hasHook(html, "factory-panel-menu-reset"));
  assert.ok(hasHook(html, "factory-panel-menu-delete"));
  assert.ok(hasHook(html, "factory-panel-open-settings"));
  assert.doesNotMatch(html, /Models for this Project|Skill packs|Open Design/);
});

test("W10: the independent Handoff block names substitute handovers and uses failure colour for failed recovery", async () => {
  const html = await render(makePanel({
    handoffs: [{ ...handoffFixture, state: "substitute" }, { ...handoffFixture, seat: "peer:T-absent", state: "failed", failure: "creation refused" }],
  }));
  assert.match(html, /Substitute handover/);
  const block = elementOf(html, "factory-handoff-block");
  assert.equal(/&quot;borderWidth&quot;:1/.test(block), false, "no bordered card around the handoff group");
  const failedRow = elementOf(html, "factory-handoff-peer:T-absent");
  assert.match(failedRow, /&quot;backgroundColor&quot;:&quot;#c8253d10&quot;/, "the row carries a very faint tint of its state colour");
  assert.match(failedRow, /&quot;width&quot;:3,&quot;backgroundColor&quot;:&quot;#c8253d&quot;/, "a 3px bar in the state colour carries the emphasis");
  assert.match(elementOf(html, "factory-handoff-lead"), /&quot;width&quot;:3,&quot;backgroundColor&quot;:&quot;#b23a98&quot;/, "an in-flight handoff is move-coloured");
});

test("02: a failed handoff renders once — the Handoff block owns it, Needs you drops the duplicate, Try again is the first primary button", async () => {
  const failed = { ...handoffFixture, seat: "supervisor", state: "failed" as const, failure: "Provider 'antigravity' is not available", handover: "substitute" as const, allowedActions: ["replace-now", "retry", "view-handover"] as PanelView["handoffs"][number]["allowedActions"], fromLane: { provider: "pi", model: "gpt-6.1-sol" }, toLane: { provider: "antigravity", model: "gemini-4-argon-high" } };
  const item = { key: "handoff-failed:supervisor", kind: "handoff-failed", title: "Supervisor handoff failed", detail: failed.failure, action: { kind: "retry-handoff", seat: "supervisor", label: "Try again" } } as PanelView["needsYou"][number];
  const html = await render(makePanel({ needsYou: [item], handoffs: [failed] }), { mobile: false });
  assert.equal(html.split('data-testid="factory-handoff-error-supervisor"').length - 1, 1, "one failure line");
  assert.equal(html.split("is not available").length - 1, 1, "the error text appears once");
  assert.equal(hasHook(html, "factory-panel-needs-you-handoff-failed:supervisor"), false);
  assert.equal(hasHook(html, "factory-panel-needs-you"), false, "no Needs-you block when that was the only item");
  assert.match(html, /Context mark · pi\/gpt-6.1-sol → antigravity\/gemini-4-argon-high · plugin-built handover/, "one meta line");
  const row = html.slice(html.indexOf('data-testid="factory-handoff-supervisor"'), html.indexOf('data-testid="factory-panel-seats"'));
  const order = ["factory-handoff-retry", "factory-handoff-replace-now", "factory-handoff-view"].map((id) => row.indexOf(`data-testid="${id}"`));
  assert.ok(order[0]! >= 0 && order[0]! < order[1]! && order[1]! < order[2]!, "Try again comes first");
  // Btn styles are functions (not serialised), but a primary button's label takes the surface colour while a secondary one takes the foreground.
  const labelColour = (label: string): string | undefined => new RegExp(`&quot;color&quot;:&quot;(#[0-9a-f]+)&quot;\\}"[^>]*>${label}<`).exec(row)?.[1];
  assert.ok(labelColour("Try again") !== undefined && labelColour("Replace now") !== undefined);
  assert.notEqual(labelColour("Try again"), labelColour("Replace now"), "Try again is the primary, Replace now stays secondary");
  assert.doesNotMatch(html, /Handoff: failed/, "the seat row does not repeat it");
  const mobile = await render(makePanel({ needsYou: [item], handoffs: [failed] }), { mobile: true });
  assert.equal(hasHook(mobile, "factory-handoff-retry"), false, "retry stays desktop-only");
  assert.ok(hasHook(mobile, "factory-handoff-error-supervisor"));
  assert.ok(hasHook(mobile, "factory-handoff-retry-hint-supervisor"), "mobile keeps the Desktop retry hint the deduped card carried");
  assert.equal(hasHook(html, "factory-handoff-retry-hint-supervisor"), false, "desktop shows the button, not the hint");
});

test("02: a handoff-failed Needs-you item with no matching handoff row still renders in Needs you", async () => {
  const item = { key: "handoff-failed:peer:gone", kind: "handoff-failed", title: "Peer handoff failed", detail: "boom", action: { kind: "retry-handoff", seat: "peer:gone", label: "Try again" } } as PanelView["needsYou"][number];
  const unrelated = { ...handoffFixture, seat: "lead", state: "failed" as const, failure: "x", allowedActions: [] as PanelView["handoffs"][number]["allowedActions"] };
  const html = await render(makePanel({ needsYou: [item], handoffs: [unrelated] }), { mobile: false });
  assert.ok(hasHook(html, "factory-panel-needs-you"));
  assert.ok(hasHook(html, "factory-panel-needs-you-handoff-failed:peer:gone"));
  assert.ok(hasHook(html, "factory-panel-needs-you-action-handoff-failed:peer:gone"));
});

test("W10: a vacant seat still displays its configured model chip", async () => {
  const html = await render(makePanel({ seats: { ...healthySeats, lead: { ...healthySeats.lead, vacant: true, agentId: null, model: null, hint: "Ask your Supervisor.", context: null } } }));
  assert.ok(hasHook(html, "factory-seat-chip-lead"));
});

test('W12: all six handoff states render exactly their projected actions, independent of seat rows', async () => {
  const cases = [
    ['scheduled', ['hand-off-now', 'cancel'], ['now', 'cancel'], 'Scheduled'],
    ['handing-over', ['replace-now'], ['replace-now'], 'Handing over'],
    ['substitute', ['replace-now'], ['replace-now'], 'Substitute handover'],
    ['creating-successor', ['replace-now'], ['replace-now'], 'Creating successor'],
    ['failed', ['replace-now', 'retry'], ['replace-now', 'retry'], 'Failed'],
    ['done', ['view-handover'], ['view'], 'Done'],
  ] as const;
  for (const [state, allowedActions, hooks, label] of cases) {
    const html = await render(makePanel({ handoffs: [{ ...handoffFixture, seat: 'peer:T-absent', state, allowedActions: [...allowedActions], ...(state === 'scheduled' ? { waitingPeers: 3 } : {}), ...(state === 'substitute' ? { handover: 'substitute' } : {}) }] }));
    const block = html.slice(html.indexOf('data-testid="factory-handoff-block"'), html.indexOf('data-testid="factory-panel-seats"'));
    assert.match(block, new RegExp(label));
    for (const action of ['now', 'cancel', 'replace-now', 'retry', 'view']) assert.equal(hasHook(block, `factory-handoff-${action}`), (hooks as readonly string[]).includes(action), `${state}: ${action}`);
    if (state === 'scheduled') assert.match(block, /waiting for 3 Peers/i);
    if (state === 'substitute') assert.match(block, /plugin-built handover/);
    if (state === 'failed') assert.ok(block.includes('#c8253d'));
  }
  const html = await render(makePanel({ handoffs: [{ ...handoffFixture, state: 'failed', allowedActions: [] }] }));
  assert.equal(hasHook(html, 'factory-handoff-retry'), false, 'state alone never invents an action');
});

test('W12: handoff reasons are words and the source and lane transition remain visible', async () => {
  for (const [reason, label] of [['context-mark', 'Context mark'], ['provider-change', 'Provider change'], ['owner', 'Owner requested']] as const) {
    const html = await render(makePanel({ handoffs: [{ ...handoffFixture, reason, state: 'done', handover: 'substitute', allowedActions: ['view-handover'], fromLane: { provider: 'pi', model: 'old' }, toLane: { provider: 'codex', model: 'new' } }] }));
    assert.match(html, new RegExp(label));
    assert.match(html, /pi\/old → codex\/new/);
    assert.match(html, /plugin-built handover/);
  }
});

// ---- 04: the Team tab -------------------------------------------------------------------------

const peerOf = (task: string, statusLabel: string, extra: Record<string, unknown> = {}) => ({ ...healthySeats.peers[0]!, agentId: `agent-${task}`, task, title: `Peer · ${task}`, statusLabel, ...extra });

test("04: closed Peers collapse behind a toggle by default; active Peers always show", async () => {
  const seats = { ...healthySeats, peers: [peerOf("T-live", "running"), peerOf("T-old", "closed"), peerOf("T-gone", "Archived")] };
  const html = await render(makePanel({ seats }));
  assert.ok(hasHook(html, "factory-panel-peers-closed-toggle"));
  assert.match(html, /▸ Closed \(2\)/);
  assert.ok(hasHook(html, "factory-panel-seat-peer-T-live"), "an active Peer shows");
  assert.equal(hasHook(html, "factory-panel-seat-peer-T-old") || hasHook(html, "factory-panel-seat-peer-T-gone"), false, "closed rows are absent while collapsed");
  assert.equal(hasHook(html, "factory-panel-peers-closed"), false);
  const none = await render(makePanel({ seats: { ...healthySeats, peers: [peerOf("T-live", "running")] } }));
  assert.equal(hasHook(none, "factory-panel-peers-closed-toggle"), false, "no closed Peers, no toggle");
});

test("04: when every Peer is closed the PEERS heading still shows with the toggle", async () => {
  const html = await render(makePanel({ seats: { ...healthySeats, peers: [peerOf("T-old", "closed")] } }));
  assert.ok(hasHook(html, "factory-panel-peers"));
  assert.match(html, />PEERS</);
  assert.match(html, /▸ Closed \(1\)/);
  assert.equal(hasHook(html, "factory-panel-seat-peer-T-old"), false);
});

test("04: a seat row on a wide panel is one line — role, status, chip, context and actions in one row container", async () => {
  const wide = await render(makePanel(), { width: 900 });
  for (const id of ["supervisor", "lead", "peer-T-08"]) {
    const line = elementOf(wide, `factory-seat-line-${id}`);
    assert.match(line.slice(0, line.indexOf(">")), /&quot;flexDirection&quot;:&quot;row&quot;/, `${id} line is a row`);
    assert.match(line, id === "peer-T-08" ? /Peer · T-08/ : id === "lead" ? /Lead/ : /Supervisor/, `${id} role name`);
    assert.match(line, /idle|working/, `${id} status`);
    assert.ok(hasHook(line, `factory-seat-chip-${id}`), `${id} model chip`);
    assert.match(line, /glm-5\.3/);
    assert.ok(hasHook(line, id === "peer-T-08" ? "factory-panel-open-peer-T-08" : `factory-panel-open-${id}`), `${id} Open`);
  }
  assert.match(elementOf(wide, "factory-seat-line-lead"), /94k \/ 128k/, "context sits on the same line");
  assert.match(elementOf(wide, "factory-seat-line-supervisor"), />—</, "no reading is a muted dash");
  assert.ok(hasHook(elementOf(wide, "factory-seat-line-lead"), "factory-seat-hand-off-now-lead"));
  // Narrow stacks: role/status/actions on line 1, chip/context on line 2 — both still inside the one line container.
  const narrow = elementOf(await render(makePanel(), { width: 500 }), "factory-seat-line-lead");
  assert.doesNotMatch(narrow.slice(0, narrow.indexOf(">")), /&quot;flexDirection&quot;:&quot;row&quot;/, "narrow stacks its lines");
  assert.ok(narrow.indexOf("factory-panel-open-lead") < narrow.indexOf("factory-seat-chip-lead"), "narrow: actions on line 1, chip on line 2");
});

test("04: a Peer's disposition is a fixed-colour badge beside its status pill, and a vacant seat's hint sits on a second line", async () => {
  const html = await render(makePanel({ seats: { ...healthySeats, lead: { ...healthySeats.lead, vacant: true, agentId: null, statusLabel: "vacant", model: null, hint: "No Lead is running — ask your Supervisor.", context: null, handoff: null } } }), { width: 900 });
  const peerLine = elementOf(html, "factory-seat-line-peer-T-08");
  assert.doesNotMatch(peerLine, /· reviewer/, "plain '· disposition' suffix is replaced by a badge");
  const statusPill = elementOf(peerLine, "factory-seat-status-peer-T-08");
  assert.match(statusPill, />working</);
  assert.ok(statusPill.includes("#337e5818") && statusPill.includes("#337e5866"), "working status renders as ok pill badge");
  const dispBadge = elementOf(peerLine, "factory-peer-disposition-T-08");
  assert.match(dispBadge, />reviewer</);
  assert.ok(dispBadge.includes("#b23a9818") && dispBadge.includes("#b23a9866"), "reviewer disposition renders with fixed light badge colour");
  const row = elementOf(html, "factory-seat-lead");
  assert.equal(elementOf(html, "factory-seat-line-lead").includes("No Lead is running"), false, "the hint is not on the grid line");
  assert.ok(row.includes("No Lead is running"), "the hint is on the row's second line");
});

test("01-badges: Team-tab status pills stay strictly 1:1 on statusLabel (never overridden by handoff or pendingLane), Peer disposition badges use fixed colours, and Models tab uses RoleName", async () => {
  const darkTheme = { colors: { ...theme.colors, surface0: "#000000" } };
  const panel = makePanel({
    defaultWorker: { role: "worker", title: "Default worker", lane: { provider: "pi", model: "worker-model", scope: "project" } },
    seats: {
      supervisor: { ...healthySeats.supervisor, statusLabel: "idle", handoff: { ...handoffFixture, seat: "supervisor", state: "scheduled", waitingPeers: 1 }, pendingLane: { provider: "codex", model: "next", scope: "project" } },
      lead: { ...healthySeats.lead, statusLabel: "starting", handoff: { ...handoffFixture, seat: "lead", state: "failed", failure: "boom" }, pendingLane: { provider: "codex", model: "next", scope: "project" } },
      peers: [
        peerOf("T-eng", "working", { disposition: "engineer" }),
        peerOf("T-arch", "waiting for permission", { disposition: "architect" }),
        peerOf("T-scout", "error", { disposition: "scout" }),
        peerOf("T-rev", "idle", { disposition: "reviewer", handoff: { ...handoffFixture, seat: "peer:T-rev", state: "handing-over" }, pendingLane: { provider: "codex", model: "next", scope: "project" } }),
      ],
      supervisorCandidates: [],
    },
  });

  const lightTeam = await render(panel, { width: 900 });
  const supStatus = elementOf(lightTeam, "factory-seat-status-supervisor");
  assert.ok(supStatus.includes("#67717618") && supStatus.includes("#67717666"), "idle status stays idle even with scheduled handoff and pendingLane");
  assert.equal(supStatus.includes("#b23a98"), false, "handoff/pendingLane never override status pill colour");
  assert.match(elementOf(lightTeam, "factory-seat-supervisor"), /Handoff: Scheduled/);
  assert.ok(elementOf(lightTeam, "factory-seat-supervisor").includes("#b23a98"), "dedicated handoff line keeps move colour");

  const leadStatus = elementOf(lightTeam, "factory-seat-status-lead");
  assert.ok(leadStatus.includes("#8f680218") && leadStatus.includes("#8f680266"), "starting status stays wait even with failed handoff");

  assert.ok(elementOf(lightTeam, "factory-seat-status-peer-T-eng").includes("#337e5818"));
  assert.ok(elementOf(lightTeam, "factory-seat-status-peer-T-arch").includes("#8f680218"));
  assert.ok(elementOf(lightTeam, "factory-seat-status-peer-T-scout").includes("#c8253d18"));
  assert.ok(elementOf(lightTeam, "factory-seat-status-peer-T-rev").includes("#67717618"));

  assert.ok(elementOf(lightTeam, "factory-peer-disposition-T-eng").includes("#4f6fc0"));
  assert.ok(elementOf(lightTeam, "factory-peer-disposition-T-arch").includes("#7459b4"));
  assert.ok(elementOf(lightTeam, "factory-peer-disposition-T-scout").includes("#287a81"));
  assert.ok(elementOf(lightTeam, "factory-peer-disposition-T-rev").includes("#b23a98"));

  const darkTeam = await render(panel, { theme: darkTheme, width: 900 });
  assert.ok(elementOf(darkTeam, "factory-seat-status-supervisor").includes("#6c767b18"));
  assert.ok(elementOf(darkTeam, "factory-seat-status-lead").includes("#cd9a2218"));
  assert.ok(elementOf(darkTeam, "factory-seat-status-peer-T-eng").includes("#68b78d18"));
  assert.ok(elementOf(darkTeam, "factory-seat-status-peer-T-scout").includes("#fe546218"));
  assert.ok(elementOf(darkTeam, "factory-peer-disposition-T-eng").includes("#6185cc"));
  assert.ok(elementOf(darkTeam, "factory-peer-disposition-T-arch").includes("#9776e5"));
  assert.ok(elementOf(darkTeam, "factory-peer-disposition-T-scout").includes("#5db3ba"));
  assert.ok(elementOf(darkTeam, "factory-peer-disposition-T-rev").includes("#de54c1"));

  const lightModels = await render(panel, { initialUi: { tab: "models" } });
  assert.ok(elementOf(lightModels, "factory-models-row-supervisor").includes("#7459b4"), "Models tab Supervisor uses RoleName");
  assert.ok(elementOf(lightModels, "factory-models-row-lead").includes("#2f7899"), "Models tab Lead uses RoleName");
  assert.ok(elementOf(lightModels, "factory-default-worker").includes("#287a81"), "Models tab Default worker uses peer RoleName");

  const darkModels = await render(panel, { theme: darkTheme, initialUi: { tab: "models" } });
  assert.ok(elementOf(darkModels, "factory-models-row-supervisor").includes("#a798d7"));
  assert.ok(elementOf(darkModels, "factory-models-row-lead").includes("#5fa8cc"));
  assert.ok(elementOf(darkModels, "factory-default-worker").includes("#5db3ba"));
});

test("04: the model chip is a quiet pill — no border, surface fill, code-style model, muted scope", async () => {
  const html = await render(makePanel());
  const chip = elementOf(html, "factory-seat-chip-lead");
  assert.equal(chip.includes("borderWidth"), false);
  assert.match(chip, /&quot;borderRadius&quot;:4,&quot;paddingHorizontal&quot;:8,&quot;paddingVertical&quot;:3,&quot;backgroundColor&quot;:&quot;#f5f5f5&quot;/);
  assert.match(chip, /&quot;fontFamily&quot;:&quot;Menlo&quot;/, "the model name is in code type");
});

// ---- ticket 11: the header's version + self-update control ---------------------------------------

/** The `<span>` / `<button>` carrying a test hook, through its closing tag (`elementOf` walks divs only). */
function leafOf(html: string, id: string): string {
  const open = new RegExp(`<(span|button)\\b[^>]*data-testid="${id}"[^>]*>`).exec(html);
  if (open === null) throw new Error(`no ${id} in the markup`);
  const tag = open[1]!;
  let depth = 0;
  for (const m of html.slice(open.index).matchAll(new RegExp(`<${tag}\\b|<\\/${tag}>`, "g"))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open.index, open.index + m.index! + m[0].length);
  }
  throw new Error(`unbalanced ${tag} markup for ${id}`);
}

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, "");

const selfUpdateView = (state: Record<string, unknown> = {}) => ({
  state: { phase: "idle", current: "0.8.2", latest: "0.8.2", updateAvailable: false, upToDate: false, note: null, error: null, ...state },
  actions: { check() {}, apply() {} },
});

test("11: the header shows the muted version and a ghost Check for updates when up to date", async () => {
  const html = await render(makePanel(), { selfUpdate: selfUpdateView() });
  assert.match(leafOf(html, "factory-version"), /v0\.8\.2/);
  assert.match(leafOf(html, "factory-update-check"), /Check for updates/);
  assert.equal(hasHook(html, "factory-update-apply"), false);
  assert.equal(hasHook(html, "factory-update-note"), false);
  const upToDate = await render(makePanel(), { selfUpdate: selfUpdateView({ upToDate: true }) });
  assert.match(leafOf(upToDate, "factory-update-uptodate"), /Up to date/);
});

test("11: while the first status is in flight the header says Checking… and offers no button", async () => {
  const html = await render(makePanel(), { selfUpdate: selfUpdateView({ phase: "checking", current: null, latest: null }) });
  assert.match(leafOf(html, "factory-update-checking"), /Checking…/);
  assert.equal(hasHook(html, "factory-version"), false);
  assert.equal(hasHook(html, "factory-update-check"), false);
  assert.equal(hasHook(html, "factory-update-apply"), false);
});

test("11: an available update shows the primary Update to vX button; pressing state disables it and says Updating", async () => {
  const ready = await render(makePanel(), { selfUpdate: selfUpdateView({ latest: "0.9.0", updateAvailable: true }) });
  assert.match(leafOf(ready, "factory-update-apply"), /Update to v0\.9\.0/);
  assert.equal(leafOf(ready, "factory-update-apply").startsWith("<button disabled"), false);
  assert.equal(hasHook(ready, "factory-update-check"), false, "the Update button replaces Check");
  const updating = await render(makePanel(), { selfUpdate: selfUpdateView({ phase: "updating", latest: "0.9.0", updateAvailable: true }) });
  assert.match(leafOf(updating, "factory-update-apply"), /Updating to v0\.9\.0…/);
  assert.match(leafOf(updating, "factory-update-apply"), /^<button disabled/);
});

test("11: a reload after pressing Update is a calm notice, a real failure is a warning-coloured error that re-enables, a note is muted", async () => {
  const reloading = await render(makePanel(), { selfUpdate: selfUpdateView({ phase: "reloading", latest: "0.9.0", updateAvailable: true }) });
  assert.match(leafOf(reloading, "factory-update-note"), /Paseo is reloading the Factory plugin…/);
  assert.equal(hasHook(reloading, "factory-update-error"), false);
  const failed = await render(makePanel(), { selfUpdate: selfUpdateView({ latest: "0.9.0", updateAvailable: true, error: "daemon refused" }) });
  assert.match(leafOf(failed, "factory-update-error"), /daemon refused/);
  assert.ok(leafOf(failed, "factory-update-error").includes(WARNING), "an update failure is warning-coloured");
  assert.equal(leafOf(failed, "factory-update-apply").startsWith("<button disabled"), false, "the button is enabled again");
  const noted = await render(makePanel(), { selfUpdate: selfUpdateView({ latest: "0.9.0", note: "Paseo's update source is not on v0.9.0 yet" }) });
  assert.match(leafOf(noted, "factory-update-note"), /not on v0\.9\.0 yet/);
  assert.equal(leafOf(noted, "factory-update-note").includes(WARNING), false, "a server note is muted");
});

test("11: mobile keeps the version and Check but never mounts Update — it points at Paseo Desktop", async () => {
  const html = await render(makePanel(), { mobile: true, selfUpdate: selfUpdateView({ latest: "0.9.0", updateAvailable: true }) });
  assert.match(leafOf(html, "factory-version"), /v0\.8\.2/);
  assert.equal(hasHook(html, "factory-update-apply"), false);
  assert.match(leafOf(html, "factory-update-desktop-hint"), /Update from Paseo Desktop/);
  const idle = await render(makePanel(), { mobile: true, selfUpdate: selfUpdateView() });
  assert.ok(hasHook(idle, "factory-update-check"), "mobile can still check");
});

test("11: the header renders without a self-update control when the host supplies none", async () => {
  const html = await render(makePanel());
  assert.equal(hasHook(html, "factory-version"), false);
  assert.equal(hasHook(html, "factory-update-check"), false);
});

test("11: the Shell mounts the self-update hook for the panel and hands it to the Project panel", () => {
  const shell = readFileSync(join(repoRoot, "plugin/client/factory/shell.tsx"), "utf8");
  assert.match(shell, /useRpc\(selfUpdateStatus\)/);
  assert.match(shell, /useRpc\(selfUpdateApply\)/);
  assert.match(shell, /useSelfUpdate\(\{[^}]*enabled: surface === "panel"/);
  assert.match(shell, /selfUpdate=\{selfUpdate\}/);
});

test("11: useSelfUpdate polls status while reloading, tolerates transient errors, and transitions to idle once the new version answers", async () => {
  const { useSelfUpdate, SelfUpdateControls, SelfUpdateNote } = await loadModule("plugin/client/factory/self-update.tsx");
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);

  let statusCallCount = 0;
  let phaseStep: "before" | "disconnect" | "old-during-clone" | "restarted" = "before";
  let resolveApply!: (reply: { ok: true; from: string; to: string }) => void;

  const Harness = ({ reloadTimeoutMs = 5_000 }: { reloadTimeoutMs?: number }) => {
    const view = useSelfUpdate({
      enabled: true,
      reloadPollMs: 15,
      reloadTimeoutMs,
      status: async () => {
        statusCallCount++;
        if (phaseStep === "before" || phaseStep === "old-during-clone") {
          return { ok: true, current: "0.12.5", latest: "0.14.0", updateAvailable: true, checkedAt: "2026-11-18T00:00:00Z" };
        }
        if (phaseStep === "disconnect") {
          throw new Error("socket closed");
        }
        return { ok: true, current: "0.14.0", latest: "0.14.0", updateAvailable: false, checkedAt: "2026-11-18T00:02:00Z" };
      },
      apply: () => new Promise<{ ok: true; from: string; to: string }>((r) => { resolveApply = r; }),
    });
    return createElement("div", {}, createElement(SelfUpdateControls, { theme, view, mobile: false }), createElement(SelfUpdateNote, { theme, view }));
  };

  try {
    await act(() => root.render(createElement(Harness)));
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
    assert.match(container.querySelector('[data-testid="factory-version"]')!.textContent!, /v0\.12\.5/);
    assert.match(container.querySelector('[data-testid="factory-update-apply"]')!.textContent!, /Update to v0\.14\.0/);

    // Trigger apply; simulate plugin restart disconnect/reply -> enters reloading
    await act(() => (container.querySelector('[data-testid="factory-update-apply"]') as HTMLButtonElement).click());
    phaseStep = "disconnect";
    await act(async () => { resolveApply({ ok: true, from: "0.12.5", to: "0.14.0" }); });
    assert.match(container.querySelector('[data-testid="factory-update-note"]')!.textContent!, /Paseo is reloading/);

    // Even when status transiently throws during restart, UI stays calmly in reloading (no flash error)
    await act(async () => { await new Promise((r) => setTimeout(r, 35)); });
    assert.equal(container.querySelector('[data-testid="factory-update-error"]'), null);
    assert.match(container.querySelector('[data-testid="factory-update-note"]')!.textContent!, /Paseo is reloading/);
    assert.ok(statusCallCount >= 2, "status polled while reloading");

    // Once new daemon responds with v0.14.0, UI clears reloading state and displays updated version + note
    phaseStep = "restarted";
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    assert.match(container.querySelector('[data-testid="factory-version"]')!.textContent!, /v0\.14\.0/);
    assert.equal(container.querySelector('[data-testid="factory-update-apply"]'), null);
    assert.ok(container.querySelector('[data-testid="factory-update-check"]'));
    assert.match(container.querySelector('[data-testid="factory-update-note"]')!.textContent!, /v0\.14\.0/);

    // Timeout case: if reloading never sees the new version within reloadTimeoutMs, surfaces an error & exits reloading
    await act(() => root.unmount());
    const container2 = dom.window.document.createElement("div");
    const stuckRoot = createRoot(container2);
    phaseStep = "before";
    await act(() => stuckRoot.render(createElement(() => {
      const view = useSelfUpdate({
        enabled: true,
        reloadPollMs: 10,
        reloadTimeoutMs: 35,
        status: async () => phaseStep === "disconnect"
          ? (() => { throw new Error("offline"); })()
          : { ok: true, current: "0.12.5", latest: "0.14.0", updateAvailable: true, checkedAt: "2026-11-18T00:00:00Z" },
        apply: async () => { phaseStep = "disconnect"; return { ok: true as const, from: "0.12.5", to: "0.14.0" }; },
      });
      return createElement("div", {}, createElement(SelfUpdateControls, { theme, view, mobile: false }), createElement(SelfUpdateNote, { theme, view }));
    })));
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
    await act(() => (container2.querySelector('[data-testid="factory-update-apply"]') as HTMLButtonElement).click());
    await act(async () => { await new Promise((r) => setTimeout(r, 70)); });
    assert.match(container2.querySelector('[data-testid="factory-update-error"]')!.textContent!, /timed out/i);
    await act(() => stuckRoot.unmount());
  } finally {
    Object.assign(g, saved);
    dom.window.close();
  }
});


test("Project skill packs show dynamic kinds, installed counts, collapsed Core baseline, and inactive drawer", async () => {
  const packs = [
    { id: "source-acme", label: "Acme tools", kind: "source", installedCount: 2, skills: ["acme-a", "acme-b"], enabled: true, autoDetected: false },
    { id: "my-pack", label: "My workflow", kind: "custom", installedCount: 0, skills: ["missing-skill"], enabled: false, autoDetected: false },
    { id: "expo", label: "Expo", kind: "builtin", installedCount: 1, skills: ["expo-router"], enabled: true, autoDetected: true },
  ];
  const html = await render(makePanel(), {
    initialUi: { tab: "project" },
    skillPacks: packs,
    actions: { toggleSkillPack() {} },
  });
  assert.match(html, /Core \+ 2 active/);
  assert.match(html, /Acme tools[\s\S]*2 installed[\s\S]*Source/);
  assert.match(html, /Expo[\s\S]*1 installed[\s\S]*Built-in[\s\S]*Auto-detected/);
  assert.match(html, /Inactive packs \(1\)/);
  assert.equal(hasHook(html, "factory-panel-skill-my-pack"), false, "inactive pack starts collapsed in drawer");
  assert.ok(hasHook(html, "factory-skill-pack-expand-source-acme"));
  assert.equal(hasHook(html, "factory-skill-pack-skills-source-acme"), false, "membership starts collapsed");
  assert.ok(hasHook(html, "factory-skill-pack-expand-core"));
  assert.equal(hasHook(html, "factory-skill-pack-skills-core"), false, "Core starts collapsed");
  assert.match(html, /Core[\s\S]*Always on/);
  assert.equal(hasHook(html, "factory-skill-pack-core"), false, "Core has no toggle");

  const expanded = await render(makePanel(), {
    initialUi: { tab: "project", expandedSkillPacks: ["core", "my-pack"] },
    skillPacks: packs,
    actions: { toggleSkillPack() {} },
  });
  assert.match(expanded, /My workflow[\s\S]*0 installed[\s\S]*Custom/);
  assert.ok(hasHook(expanded, "factory-skill-pack-skills-core"));
  assert.match(expanded, /tdd[\s\S]*diagnosing-bugs[\s\S]*code-review[\s\S]*codebase-design[\s\S]*domain-modeling[\s\S]*research/);
  assert.equal(hasHook(expanded, "factory-skill-pack-core"), false, "Core still has no toggle when expanded");
});

test("Project pack membership expands for inspection on desktop and mobile without mobile writes", async () => {
  for (const mobile of [false, true]) {
    const html = await render(makePanel(), {
      mobile,
      initialUi: { tab: "project", expandedSkillPacks: ["source-acme", "empty"] },
      skillPacks: [
        { id: "source-acme", label: "Acme tools", kind: "source", installedCount: 1, skills: ["acme-build", "acme-review"], description: "Acme shared workflow", enabled: false, autoDetected: false },
        { id: "empty", label: "Empty", kind: "custom", installedCount: 0, skills: [], enabled: true, autoDetected: false },
      ], actions: { toggleSkillPack() {} },
    });
    assert.ok(hasHook(html, "factory-skill-pack-skills-source-acme"));
    assert.match(html, /Acme shared workflow[\s\S]*acme-build[\s\S]*acme-review/);
    assert.match(html, /No skills in this pack/);
    assert.match(html, /aria-label="Collapse Acme tools skills"/);
    assert.ok(hasHook(html, "factory-skill-pack-expand-source-acme"), "mobile can inspect disabled packs too");
    assert.equal(hasHook(html, "factory-skill-pack-source-acme"), !mobile);
    if (mobile) {
      assert.doesNotMatch(html, /data-role="switch"/);
      assert.equal(hasHook(html, "factory-skill-packs-reset"), false);
      assert.equal(hasHook(html, "factory-skill-packs-manage"), false);
    }
  }
});
const recordedAllWindow = {
  state: "recorded" as const,
  totalTokens: 12_400_000,
  cacheHitPercent: 87,
  newTokens: 1_540_000,
  cachedTokens: 10_860_000,
  cacheReadTokens: 10_800_000,
  inputUncachedTokens: 1_200_000,
  outputTokens: 340_000,
  sessionCount: 64,
  seats: [
    {
      seat: "agent",
      label: "Peer",
      newTokens: 1_000_000,
      inputUncachedTokens: 800_000,
      outputTokens: 200_000,
      cachedTokens: 8_300_000,
      cacheReadTokens: 8_260_000,
      totalTokens: 9_300_000,
      sessionCount: 50,
      sharePercent: 64,
      cacheHitPercent: 92,
      models: [
        { provider: "codex", model: "gpt-5.4-xhigh", newTokens: 700_000, inputUncachedTokens: 560_000, outputTokens: 140_000, cachedTokens: 6_300_000, cacheReadTokens: 6_280_000, totalTokens: 7_000_000, sessionCount: 38, sharePercent: 70, cacheHitPercent: 94 },
        { provider: "zai", model: "glm-5.3-flash", newTokens: 300_000, inputUncachedTokens: 240_000, outputTokens: 60_000, cachedTokens: 2_000_000, cacheReadTokens: 1_980_000, totalTokens: 2_300_000, sessionCount: 12, sharePercent: 30, cacheHitPercent: 85 },
      ],
    },
    {
      seat: "lead",
      label: "Lead",
      newTokens: 540_000,
      inputUncachedTokens: 400_000,
      outputTokens: 140_000,
      cachedTokens: 2_560_000,
      cacheReadTokens: 2_540_000,
      totalTokens: 3_100_000,
      sessionCount: 14,
      sharePercent: 36,
      cacheHitPercent: 65,
      models: [
        { provider: "antigravity", model: "gemini-4-hydrogen-high", newTokens: 540_000, inputUncachedTokens: 400_000, outputTokens: 140_000, cachedTokens: 2_560_000, cacheReadTokens: 2_540_000, totalTokens: 3_100_000, sessionCount: 14, sharePercent: 100, cacheHitPercent: 65 },
      ],
    },
  ],
  models: [
    { provider: "codex", model: "gpt-5.4-xhigh", newTokens: 700_000, inputUncachedTokens: 560_000, outputTokens: 140_000, cachedTokens: 6_300_000, cacheReadTokens: 6_280_000, totalTokens: 7_000_000, sessionCount: 38, sharePercent: 45, cacheHitPercent: 94 },
    { provider: "antigravity", model: "gemini-4-hydrogen-high", newTokens: 540_000, inputUncachedTokens: 400_000, outputTokens: 140_000, cachedTokens: 2_560_000, cacheReadTokens: 2_540_000, totalTokens: 3_100_000, sessionCount: 14, sharePercent: 36, cacheHitPercent: 65 },
    { provider: "zai", model: "glm-5.3-flash", newTokens: 300_000, inputUncachedTokens: 240_000, outputTokens: 60_000, cachedTokens: 2_000_000, cacheReadTokens: 1_980_000, totalTokens: 2_300_000, sessionCount: 12, sharePercent: 19, cacheHitPercent: 85 },
  ],
};

const recorded7dWindow = {
  state: "recorded" as const,
  totalTokens: 4_000_000,
  cacheHitPercent: 92,
  newTokens: 400_000,
  cachedTokens: 3_600_000,
  cacheReadTokens: 3_550_000,
  inputUncachedTokens: 310_000,
  outputTokens: 90_000,
  sessionCount: 12,
  seats: [
    {
      seat: "agent",
      label: "Peer",
      newTokens: 400_000,
      inputUncachedTokens: 310_000,
      outputTokens: 90_000,
      cachedTokens: 3_600_000,
      cacheReadTokens: 3_550_000,
      totalTokens: 4_000_000,
      sessionCount: 12,
      sharePercent: 100,
      cacheHitPercent: 92,
      models: [
        { provider: "codex", model: "gpt-5.4-xhigh", newTokens: 400_000, inputUncachedTokens: 310_000, outputTokens: 90_000, cachedTokens: 3_600_000, cacheReadTokens: 3_550_000, totalTokens: 4_000_000, sessionCount: 12, sharePercent: 100, cacheHitPercent: 92 },
      ],
    },
  ],
  models: [
    { provider: "codex", model: "gpt-5.4-xhigh", newTokens: 400_000, inputUncachedTokens: 310_000, outputTokens: 90_000, cachedTokens: 3_600_000, cacheReadTokens: 3_550_000, totalTokens: 4_000_000, sessionCount: 12, sharePercent: 100, cacheHitPercent: 92 },
  ],
};

const emptyUsageWindow = {
  state: "empty" as const,
  totalTokens: 0,
  cacheHitPercent: null,
  newTokens: 0,
  cachedTokens: 0,
  cacheReadTokens: 0,
  inputUncachedTokens: 0,
  outputTokens: 0,
  sessionCount: 0,
  seats: [],
  models: [],
};

const recordedUsage: NonNullable<PanelView["usage"]> = {
  ...recordedAllWindow,
  windows: {
    all: recordedAllWindow,
    "7d": recorded7dWindow,
    "24h": emptyUsageWindow,
  },
};

test("thinkingColour maps xhigh to max and SegmentedControl attaches optional testID hooks", async () => {
  const { thinkingColour, factoryPalette } = await loadModule("plugin/client/kit/theme.ts");
  const { SegmentedControl } = await loadModule("plugin/client/kit/pill.tsx");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const darkTheme = { colors: { ...theme.colors, surface0: "#000000" } };

  assert.equal(thinkingColour(theme, "xhigh"), thinkingColour(theme, "max"));
  assert.equal(thinkingColour(theme, "xhigh"), factoryPalette(theme).thinking[5]);
  assert.equal(thinkingColour(darkTheme, "xhigh"), factoryPalette(darkTheme).thinking[5]);
  assert.notEqual(thinkingColour(theme, "xhigh"), factoryPalette(theme).idle);

  const withId = renderToStaticMarkup(createElement(SegmentedControl, {
    theme,
    testID: "seg-test",
    value: "a",
    onChange: () => {},
    options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }],
  }));
  assert.ok(hasHook(withId, "seg-test"));
  assert.ok(hasHook(withId, "seg-test-a"));
  assert.ok(hasHook(withId, "seg-test-b"));

  const withoutId = renderToStaticMarkup(createElement(SegmentedControl, {
    theme,
    value: "a",
    onChange: () => {},
    options: [{ value: "a", label: "Alpha" }],
  }));
  assert.equal(withoutId.includes("data-testid="), false);
});

test("Project usage leads with a 4-tile KPI strip, window switcher, and a collapsed desktop breakdown", async () => {
  const html = await render(makePanel({ usage: recordedUsage }), { initialUi: { tab: "project" } });
  assert.ok(hasHook(html, "project-usage-card"));
  const summaryHtml = elementOf(html, "project-usage-summary");
  assert.match(stripTags(summaryHtml), /New tokens.*1\.5M.*1\.2M in · 340k out.*Cache hit.*87%.*10\.9M cached.*Total.*12\.4M.*tokens.*Sessions.*64.*sessions/);
  assert.ok(summaryHtml.includes("#8f6802"), "87% cache hit uses wait palette colour");
  assert.ok(hasHook(html, "project-usage-window"));
  assert.ok(hasHook(html, "project-usage-window-all"));
  assert.ok(hasHook(html, "project-usage-window-7d"));
  assert.ok(hasHook(html, "project-usage-window-24h"));
  assert.equal(hasHook(html, "project-usage-window-note"), false, "All window shows no multi-day note");
  assert.ok(html.indexOf('data-testid="project-usage-card"') < html.indexOf('data-testid="factory-skill-packs"'));
  assert.match(leafOf(html, "project-usage-toggle"), /▸ Breakdown/);
  assert.equal(hasHook(html, "project-usage-breakdown"), false);
  assert.equal(hasHook(html, "project-usage-models"), false);
  assert.equal(hasHook(await render(makePanel({ usage: recordedUsage })), "project-usage-card"), false, "the Team tab has no usage card");
});

test("desktop Project usage supports By Seat nested expansion, By Model thinking pills, wide/narrow layouts, and window switching", async () => {
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(() => root.render(createElement(ProjectPanel, { theme, width: 900, panel: makePanel({ usage: recordedUsage }), mobile: false, now: Date.now(), daemonError: null, actions: noopActions(), initialUi: { tab: "project" } })));
    const toggle = () => container.querySelector('[data-testid="project-usage-toggle"]') as HTMLButtonElement;
    assert.equal(container.querySelector('[data-testid="project-usage-breakdown"]'), null);

    // 1. Expand Breakdown -> By Seat default, Peer (agent) models already expanded, Lead collapsed
    await act(() => toggle().click());
    assert.equal(toggle().textContent, "▾ Breakdown");
    const breakdown = () => container.querySelector('[data-testid="project-usage-breakdown"]')!;
    assert.ok(breakdown());
    assert.ok(container.querySelector('[data-testid="project-usage-mode"]'));
    assert.equal(container.querySelector('[data-testid="project-usage-mode-seat"]')?.getAttribute("data-selected"), "true");
    assert.equal(container.querySelector('[data-testid="project-usage-mode-model"]')?.getAttribute("data-selected"), "false");

    const seats = container.querySelector('[data-testid="project-usage-seats"]')!;
    assert.ok(seats);
    assert.equal(container.querySelector('[data-testid="project-usage-models"]'), null);
    assert.match(seats.textContent!, /New.*Cache.*Hit.*Ses/, "wide layout renders tabular column headers");
    const seatRows = [...seats.querySelectorAll('[data-testid="project-usage-seat-row"]')];
    assert.equal(seatRows.length, 2);
    assert.match(seatRows[0]!.textContent!, /Peer.*1\.0M.*8\.3M.*92%.*50/);
    assert.match(seatRows[1]!.textContent!, /Lead.*540k.*2\.6M.*65%.*14/);
    assert.doesNotMatch(breakdown().textContent!, /\b(64|36|70|30|45|19)%/, "no unlabeled sharePercent% text anywhere");

    // Peer (agent) starts expanded with nested models; Lead starts collapsed
    const agentModels = container.querySelector('[data-testid="project-usage-seat-models-agent"]');
    assert.ok(agentModels, "Peer (agent) models are expanded by default");
    assert.equal(container.querySelector('[data-testid="project-usage-seat-models-lead"]'), null, "Lead models start collapsed");
    const agentModelRows = [...agentModels.querySelectorAll('[data-testid="project-usage-model-row"]')];
    assert.equal(agentModelRows.length, 2);
    assert.match(agentModelRows[0]!.textContent!, /codex\/gpt-5\.4xhigh.*700k.*6\.3M.*94%.*38/);
    assert.match(agentModelRows[1]!.textContent!, /zai\/glm-5\.3-flash.*300k.*2\.0M.*85%.*12/);

    // Expand Lead, collapse Peer
    await act(() => (container.querySelector('[data-testid="project-usage-seat-toggle-lead"]') as HTMLButtonElement).click());
    const leadModels = container.querySelector('[data-testid="project-usage-seat-models-lead"]');
    assert.ok(leadModels, "clicking Lead seat toggle expands Lead models");
    assert.match(leadModels.textContent!, /antigravity\/gemini-4-hydrogenhigh.*540k.*2\.6M.*65%.*14/);
    await act(() => (container.querySelector('[data-testid="project-usage-seat-toggle-agent"]') as HTMLButtonElement).click());
    assert.equal(container.querySelector('[data-testid="project-usage-seat-models-agent"]'), null, "clicking Peer seat toggle collapses Peer models");

    // 2. Switch to By Model mode -> flat list with provider/model/thinking pill
    await act(() => (container.querySelector('[data-testid="project-usage-mode-model"]') as HTMLButtonElement).click());
    assert.equal(container.querySelector('[data-testid="project-usage-seats"]'), null);
    const models = container.querySelector('[data-testid="project-usage-models"]')!;
    assert.ok(models);
    const modelRows = [...models.querySelectorAll('[data-testid="project-usage-model-row"]')];
    assert.equal(modelRows.length, 3);
    assert.match(modelRows[0]!.textContent!, /codex\/gpt-5\.4xhigh.*700k.*6\.3M.*94%.*38/);
    assert.ok(modelRows[0]!.innerHTML.includes("#c8253d"), "xhigh thinking pill uses max palette accent (#c8253d)");
    assert.ok(modelRows[0]!.innerHTML.includes("#337e58"), "94% cache hit uses ok colour (#337e58)");
    assert.match(modelRows[1]!.textContent!, /antigravity\/gemini-4-hydrogenhigh.*540k.*2\.6M.*65%.*14/);
    assert.ok(modelRows[1]!.innerHTML.includes("#b23a98"), "high thinking pill uses high palette accent (#b23a98)");
    assert.ok(modelRows[1]!.innerHTML.includes("#c8253d"), "65% cache hit uses bad colour (#c8253d)");
    assert.match(modelRows[2]!.textContent!, /zai\/glm-5\.3-flash.*300k.*2\.0M.*85%.*12/);
    assert.equal(/>flash<\/span>/.test(modelRows[2]!.innerHTML), false, "glm-5.3-flash stays unsplit without a thinking pill");
    assert.equal(modelRows[2]!.innerHTML.includes('"borderRadius":999'), false, "no thinking pill rendered for glm-5.3-flash");
    assert.ok(modelRows[2]!.innerHTML.includes("#8f6802"), "85% cache hit uses wait colour (#8f6802)");
    assert.doesNotMatch(breakdown().textContent!, /\$|USD|cost/i);

    // 3. Narrow desktop (< 720px) switches to 2 compact lines per row
    await act(() => root.render(createElement(ProjectPanel, { theme, width: 500, panel: makePanel({ usage: recordedUsage }), mobile: false, now: Date.now(), daemonError: null, actions: noopActions(), initialUi: { tab: "project" } })));
    const narrowModels = container.querySelector('[data-testid="project-usage-models"]')!;
    assert.doesNotMatch(narrowModels.textContent!, /New.*Cache.*Hit.*Ses/, "narrow layout drops the wide table header row");
    const narrowModelRows = [...narrowModels.querySelectorAll('[data-testid="project-usage-model-row"]')];
    assert.match(narrowModelRows[0]!.textContent!, /700k new · 6\.3M cache · 94% hit · 38 ses/);

    // 4. Switch window to 7d -> updates summary and shows window note
    await act(() => (container.querySelector('[data-testid="project-usage-window-7d"]') as HTMLButtonElement).click());
    const summary7d = container.querySelector('[data-testid="project-usage-summary"]')!;
    assert.match(summary7d.textContent!, /New tokens400k310k in · 90k outCache hit92%3\.6M cachedTotal4\.0MtokensSessions12sessions/);
    assert.ok(summary7d.innerHTML.includes("#337e58"), "92% cache hit uses ok palette colour");
    assert.match(container.querySelector('[data-testid="project-usage-window-note"]')?.textContent ?? "", /Sessions active in last 7d — multi-day seats show full session totals/);

    // 5. Switch window to 24h (empty) -> shows empty window message and hides summary, note, toggle, and breakdown
    await act(() => (container.querySelector('[data-testid="project-usage-window-24h"]') as HTMLButtonElement).click());
    assert.match(container.querySelector('[data-testid="project-usage-window-empty"]')?.textContent ?? "", /No active sessions in the last 24h/);
    assert.equal(container.querySelector('[data-testid="project-usage-summary"]'), null);
    assert.equal(container.querySelector('[data-testid="project-usage-window-note"]'), null);
    assert.equal(container.querySelector('[data-testid="project-usage-toggle"]'), null);
    assert.equal(container.querySelector('[data-testid="project-usage-breakdown"]'), null);

    // 6. Switch back to All and collapse Breakdown
    await act(() => (container.querySelector('[data-testid="project-usage-window-all"]') as HTMLButtonElement).click());
    assert.equal(toggle().textContent, "▾ Breakdown");
    await act(() => toggle().click());
    assert.equal(toggle().textContent, "▸ Breakdown");
    assert.equal(container.querySelector('[data-testid="project-usage-breakdown"]'), null);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }
});

test("mobile Project usage shows totals and read-only window switcher without breakdown or writes", async () => {
  const html = await render(makePanel({ usage: recordedUsage }), { mobile: true, initialUi: { tab: "project" } });
  assert.match(stripTags(elementOf(html, "project-usage-summary")), /New tokens.*1\.5M.*1\.2M in · 340k out.*Cache hit.*87%.*10\.9M cached.*Total.*12\.4M.*tokens.*Sessions.*64.*sessions/);
  const card = elementOf(html, "project-usage-card");
  assert.ok(hasHook(card, "project-usage-window"));
  assert.ok(hasHook(card, "project-usage-window-all"));
  assert.ok(hasHook(card, "project-usage-window-7d"));
  assert.ok(hasHook(card, "project-usage-window-24h"));
  assert.equal(hasHook(card, "project-usage-toggle"), false);
  assert.equal(hasHook(card, "project-usage-models"), false);
  assert.equal(hasHook(card, "project-usage-breakdown"), false);
  assert.equal(hasHook(card, "project-usage-seats"), false);
  assert.doesNotMatch(card, /\$|USD|cost/i);
  // Only the 3 read-only window switcher buttons exist inside the mobile usage card
  assert.equal((card.match(/<button\b/g) ?? []).length, 3);
  assert.equal((card.match(/data-testid="project-usage-window-(?:all|7d|24h)"/g) ?? []).length, 3);
});

test("Project usage handles watch seat (idle tone), null hit rates, legacy unwindowed data, and empty projects", async () => {
  const watchUsage: NonNullable<PanelView["usage"]> = {
    ...recordedAllWindow,
    seats: [
      {
        seat: "watch",
        label: "Watch",
        newTokens: 10_000,
        inputUncachedTokens: 8_000,
        outputTokens: 2_000,
        cachedTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 10_000,
        sessionCount: 3,
        sharePercent: 100,
        cacheHitPercent: null,
        models: [],
      },
    ],
  };
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(() => root.render(createElement(ProjectPanel, { theme, width: 900, panel: makePanel({ usage: watchUsage }), mobile: false, now: Date.now(), daemonError: null, actions: noopActions(), initialUi: { tab: "project" } })));
    assert.equal(container.querySelector('[data-testid="project-usage-window"]'), null, "unwindowed usage hides the window switcher");
    await act(() => (container.querySelector('[data-testid="project-usage-toggle"]') as HTMLButtonElement).click());
    const watchRow = container.querySelector('[data-testid="project-usage-seat-row"]')!;
    assert.ok(watchRow);
    assert.equal(container.querySelector('[data-testid="project-usage-seat-toggle-watch"]'), null, "seat without models is not interactive");
    assert.ok(watchRow.innerHTML.includes("#677176"), "watch seat uses idle palette dot and null hit colour");
    assert.match(watchRow.textContent!, /Watch.*10k.*0.*–.*3/);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }

  const emptyUsage: NonNullable<PanelView["usage"]> = { ...emptyUsageWindow };
  for (const mobile of [false, true]) {
    const html = await render(makePanel({ usage: emptyUsage }), { mobile, initialUi: { tab: "project" } });
    assert.ok(hasHook(html, "project-usage-card"));
    assert.match(leafOf(html, "project-usage-empty"), /No usage recorded yet/);
    assert.ok(leafOf(html, "project-usage-empty").includes(theme.colors.foregroundMuted));
    assert.equal(hasHook(html, "project-usage-window"), false);
    assert.equal(hasHook(html, "project-usage-summary"), false);
    assert.equal(hasHook(html, "project-usage-toggle"), false);
  }
});

test("unscoped or older panels omit Project usage, and an unknown cache-hit ratio stays a dash", async () => {
  for (const usage of [null, undefined]) {
    assert.equal(hasHook(await render(makePanel({ usage }), { initialUi: { tab: "project" } }), "project-usage-card"), false);
  }
  const html = await render(makePanel({ usage: { ...recordedUsage, newTokens: 0, cachedTokens: 0, cacheReadTokens: 0, totalTokens: 0, inputUncachedTokens: 0, outputTokens: 0, sessionCount: 1, cacheHitPercent: null, seats: [], models: [], windows: undefined } }), { initialUi: { tab: "project" } });
  const summaryHtml = elementOf(html, "project-usage-summary");
  assert.match(stripTags(summaryHtml), /^New tokens00 in · 0 outCache hit–0 cachedTotal0tokensSessions1session$/);
  assert.ok(summaryHtml.includes("#677176"), "null cacheHitPercent uses idle palette colour");
});

function makeRelease(overrides: Partial<ReleaseSettingsView> = {}): ReleaseSettingsView {
  return {
    project: "my-app",
    projectRoot: "/repo/my-app",
    mode: "off",
    branch: null,
    resolvedBranch: "main",
    defaultBranch: "main",
    branchCandidates: ["main", "release"],
    updatedAt: null,
    pendingRequest: null,
    origin: {
      remoteUrl: "git@github.com:acme/my-app.git",
      slug: "acme/my-app",
      visibility: "private",
      defaultBranch: "main",
    },
    gh: { installed: true, authenticated: true, user: "octocat" },
    lastRelease: null,
    ...overrides,
  };
}

test("GitHub & Release card renders read states on the Project tab with exact hooks and zero visibility-edit controls", async () => {
  // Lives on Project tab, never on Team tab
  assert.equal(hasHook(await render(makePanel(), { release: makeRelease() }), "factory-panel-github-release"), false);

  // 1. Not on GitHub (no origin) + no releases yet + gh unauthenticated
  const noOrigin = await render(makePanel(), {
    initialUi: { tab: "project" },
    release: makeRelease({
      origin: null,
      resolvedBranch: null,
      defaultBranch: null,
      branchCandidates: ["main"],
      gh: { installed: true, authenticated: false, user: null },
      lastRelease: null,
    }),
  });
  for (const hook of [
    "factory-panel-github-release",
    "factory-panel-github-origin",
    "factory-panel-release-mode",
    "factory-panel-release-branch",
    "factory-panel-release-last",
    "factory-panel-github-login-guide",
  ]) {
    assert.ok(hasHook(noOrigin, hook), `${hook} renders when gh is unauthenticated and origin is absent`);
  }
  assert.match(elementOf(noOrigin, "factory-panel-github-origin"), /Not on GitHub/);
  assert.match(elementOf(noOrigin, "factory-panel-release-mode"), /off/i);
  assert.match(elementOf(noOrigin, "factory-panel-release-last"), /No releases yet/);
  assert.match(elementOf(noOrigin, "factory-panel-github-login-guide"), /gh auth login --web -p https/);

  // 2. Private repo, on-request mode, pending request, authenticated gh
  const priv = await render(makePanel(), {
    initialUi: { tab: "project" },
    release: makeRelease({
      mode: "on-request",
      pendingRequest: { version: "0.14.0", requestedAt: new Date().toISOString() },
    }),
  });
  assert.equal(hasHook(priv, "factory-panel-github-login-guide"), false, "authenticated gh hides login guide");
  assert.match(elementOf(priv, "factory-panel-github-origin"), /acme\/my-app/);
  assert.match(elementOf(priv, "factory-panel-github-origin"), /Private/);
  assert.match(elementOf(priv, "factory-panel-release-mode"), /on-request/);
  assert.match(elementOf(priv, "factory-panel-release-mode"), /0\.14\.0/);
  assert.match(elementOf(priv, "factory-panel-release-branch"), /main/);

  // 3. Public repo, auto mode, recorded lastRelease
  const pub = await render(makePanel(), {
    initialUi: { tab: "project" },
    release: makeRelease({
      mode: "auto",
      branch: "release",
      resolvedBranch: "release",
      origin: { remoteUrl: "https://github.com/acme/oss.git", slug: "acme/oss", visibility: "public", defaultBranch: "main" },
      lastRelease: {
        version: "0.14.0",
        tag: "v0.14.0",
        commit: "1234567890abcdef",
        branch: "release",
        url: "https://github.com/acme/oss/releases/tag/v0.14.0",
        mode: "auto",
        ts: new Date(Date.now() - 120_000).toISOString(),
      },
    }),
  });
  assert.match(elementOf(pub, "factory-panel-github-origin"), /acme\/oss/);
  assert.match(elementOf(pub, "factory-panel-github-origin"), /Public/);
  assert.match(elementOf(pub, "factory-panel-release-mode"), /auto/);
  assert.match(elementOf(pub, "factory-panel-release-branch"), /release/);
  const lastHtml = elementOf(pub, "factory-panel-release-last");
  assert.match(lastHtml, /v0\.14\.0/);
  assert.match(lastHtml, /1234567/);
  assert.match(lastHtml, /release/);
  assert.match(lastHtml, /2m ago/);
  assert.match(lastHtml, /https:\/\/github\.com\/acme\/oss\/releases\/tag\/v0\.14\.0/);

  // 4. Static guard: zero repo visibility-change controls anywhere in plugin/client/
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
    }
    return out;
  };
  for (const file of walk(join(repoRoot, "plugin", "client"))) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /change\s+visibility|make\s+public|make\s+private|gh\s+repo\s+edit/i, `${file} must not expose repo visibility mutation`);
  }
});

test("GitHub & Release card renders desktop mode/branch selectors, no-origin hint, feedback, and mobile read-only discipline", async () => {
  // Desktop interactive mode & branch controls + dropped-request feedback
  const modeCalls: string[] = [];
  const branchCalls: string[] = [];
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: makePanel(),
          mobile: false,
          now: Date.now(),
          daemonError: null,
          actions: noopActions(),
          initialUi: { tab: "project" },
          release: makeRelease({ mode: "off", branch: null, resolvedBranch: "main", defaultBranch: "main", branchCandidates: ["main", "release"] }),
          releaseFeedback: { text: "Dropped pending Release request.", tone: "info" },
          releaseActions: {
            setMode: (mode: string) => { modeCalls.push(mode); },
            setBranch: (branch: string) => { branchCalls.push(branch); },
          },
        }),
      ),
    );
    assert.ok(container.querySelector('[data-testid="factory-panel-release-mode-off"]'));
    assert.ok(container.querySelector('[data-testid="factory-panel-release-mode-on-request"]'));
    assert.ok(container.querySelector('[data-testid="factory-panel-release-mode-auto"]'));
    await act(() => (container.querySelector('[data-testid="factory-panel-release-mode-on-request"]') as HTMLButtonElement).click());
    await act(() => (container.querySelector('[data-testid="factory-panel-release-branch-option-release"]') as HTMLButtonElement).click());
    assert.deepEqual(modeCalls, ["on-request"]);
    assert.deepEqual(branchCalls, ["release"]);
    assert.match(container.querySelector('[data-testid="factory-panel-release-feedback"]')!.textContent!, /Dropped pending Release request/);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }

  // No-origin: branch selector is disabled with hint, zero candidate buttons
  const noOriginHtml = await render(makePanel(), {
    initialUi: { tab: "project" },
    release: makeRelease({ origin: null, defaultBranch: null, resolvedBranch: null, branchCandidates: ["main"] }),
    releaseActions: { setMode() {}, setBranch() {} },
  });
  const branchEl = elementOf(noOriginHtml, "factory-panel-release-branch");
  assert.doesNotMatch(branchEl, /factory-panel-release-branch-option-/);
  assert.match(branchEl, /origin/i);

  // Mobile: read-only card, zero buttons anywhere inside factory-panel-github-release
  const mobileHtml = await render(makePanel(), {
    mobile: true,
    initialUi: { tab: "project" },
    release: makeRelease({ mode: "auto" }),
    releaseActions: { setMode() { assert.fail("mobile mode write"); }, setBranch() { assert.fail("mobile branch write"); } },
  });
  assert.doesNotMatch(elementOf(mobileHtml, "factory-panel-github-release"), /<button/);
});

test("GitHub Publish modal trigger renders only without origin on authenticated desktop, gates Public & sensitive files, and hides once origin exists", async () => {
  const preflight = {
    project: "my-app",
    projectRoot: "/repo/my-app",
    originPresent: false,
    gh: { installed: true, authenticated: true, user: "octo" },
    owners: ["octo", "acme-org"],
    defaultOwner: "octo",
    defaultName: "my-app",
    sensitiveFiles: [".env"],
    hasUncommittedChanges: false,
    commitHistoryNotScannedNote: "Commit history is not scanned for past secrets — only tracked files at HEAD are checked.",
  };

  // 1. With origin already set -> Publish trigger & modal are absent
  const withOrigin = await render(makePanel(), {
    initialUi: { tab: "project" },
    release: makeRelease(),
    publishPreflight: preflight,
  });
  assert.equal(hasHook(withOrigin, "factory-panel-github-publish-open"), false);
  assert.equal(hasHook(withOrigin, "factory-panel-github-publish"), false);

  // 2. Unauthenticated gh -> Publish trigger is hidden even when origin is null
  const unauthNoOrigin = await render(makePanel(), {
    initialUi: { tab: "project" },
    release: makeRelease({ origin: null, resolvedBranch: null, defaultBranch: null, gh: { installed: true, authenticated: false, user: null } }),
    publishPreflight: preflight,
    releaseActions: { publish: async () => {} },
  });
  assert.equal(hasHook(unauthNoOrigin, "factory-panel-github-publish-open"), false, "Publish trigger stays hidden when !gh.authenticated");

  // 3. Authenticated no-origin desktop renders trigger while keeping modal closed until clicked
  const noOriginHtml = await render(makePanel(), {
    initialUi: { tab: "project" },
    release: makeRelease({ origin: null, resolvedBranch: null, defaultBranch: null, gh: { installed: true, authenticated: true, user: "octo" } }),
    publishPreflight: preflight,
    releaseActions: { publish: async () => {} },
  });
  assert.ok(hasHook(noOriginHtml, "factory-panel-github-publish-open"));
  assert.equal(hasHook(noOriginHtml, "factory-panel-github-publish"), false, "Publish form stays unmounted until modal is opened");

  // 4. Opening modal exposes owner, name, description, Private default, and Public confirms/sensitive gating
  const publishedCalls: Array<Record<string, unknown>> = [];
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: makePanel(),
          mobile: false,
          now: Date.now(),
          daemonError: null,
          actions: noopActions(),
          initialUi: { tab: "project" },
          release: makeRelease({ origin: null, resolvedBranch: null, defaultBranch: null, gh: { installed: true, authenticated: true, user: "octo" } }),
          publishPreflight: preflight,
          releaseActions: { publish: async (payload: Record<string, unknown>) => { publishedCalls.push(payload); } },
        }),
      ),
    );
    assert.equal(container.querySelector('[data-testid="factory-panel-github-publish"]'), null);
    await act(() => (container.querySelector('[data-testid="factory-panel-github-publish-open"]') as HTMLButtonElement).click());
    for (const hook of [
      "factory-panel-github-publish",
      "factory-panel-github-publish-owner",
      "factory-panel-github-publish-name",
      "factory-panel-github-publish-description",
      "factory-panel-github-publish-visibility",
      "factory-panel-github-publish-submit",
    ]) {
      assert.ok(container.querySelector(`[data-testid="${hook}"]`), `${hook} renders inside modal`);
    }
    assert.equal(container.querySelector('[data-testid="factory-panel-github-publish-confirm-name"]'), null, "Private mode hides Public typed-name confirmation");
    assert.equal(container.querySelector('[data-testid="factory-panel-github-publish-sensitive"]'), null, "Private mode hides Public sensitive-file warning");
    const submitBtn = () => container.querySelector('[data-testid="factory-panel-github-publish-submit"]') as HTMLButtonElement;
    assert.equal(submitBtn().disabled, false, "Private publish is ready without sensitive override");

    await act(() => (container.querySelector('[data-testid="factory-panel-github-publish-visibility-public"]') as HTMLButtonElement).click());
    assert.ok(container.querySelector('[data-testid="factory-panel-github-publish-confirm-name"]'), "Public reveals typed-name confirmation");
    assert.ok(container.querySelector('[data-testid="factory-panel-github-publish-sensitive"]'), "Public reveals tracked sensitive files");
    assert.match(container.querySelector('[data-testid="factory-panel-github-publish"]')!.textContent!, /history is not scanned/i);
    assert.equal(submitBtn().disabled, true);

    // Acknowledge sensitive files without typing name -> still disabled
    await act(() => (container.querySelector('[data-testid="factory-panel-github-publish-sensitive-toggle"]') as HTMLButtonElement).click());
    assert.equal(submitBtn().disabled, true, "Public submit disabled until repo name matches");

    // Select org owner acme-org + click submit won't fire until confirm-name typed
    await act(() => (container.querySelector('[data-testid="factory-panel-github-publish-owner-acme-org"]') as HTMLButtonElement).click());
    assert.equal(publishedCalls.length, 0);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }
});

function makeStoreRelease(overrides: Partial<StoreReleaseView> = {}): StoreReleaseView {
  return {
    project: "my-app",
    projectRoot: "/repo/my-app",
    mode: "off",
    updatedAt: null,
    pendingRequest: null,
    vault: { ascKey: true, appleTeamId: true, gplayJson: true },
    platforms: [],
    isMobile: false,
    runner: {
      installed: true,
      enabled: true,
      status: "running",
      path: "/paseo/plugins/factory-release-lab/v1",
      binPath: "/paseo/plugins/factory-release-lab/v1/bin/release-lab.mjs",
    },
    lastRun: null,
    activeHole: null,
    ...overrides,
  };
}

test("Store Release card renders directly below GitHub & Release on the Project tab, collapsed by default on non-mobile Projects with an expand toggle", async () => {
  // Never renders on Team tab
  assert.equal(hasHook(await render(makePanel(), { storeRelease: makeStoreRelease({ isMobile: true, platforms: ["android", "ios"] }) }), "factory-panel-store-release"), false);

  // Non-mobile Project: collapsed by default
  const nonMobileHtml = await render(makePanel(), {
    initialUi: { tab: "project" },
    release: makeRelease(),
    storeRelease: makeStoreRelease({ isMobile: false, platforms: [] }),
  });
  assert.ok(hasHook(nonMobileHtml, "factory-panel-store-release"), "Store Release card renders on Project tab");
  assert.ok(hasHook(nonMobileHtml, "factory-panel-store-release-toggle"), "expand toggle renders on non-mobile Project");
  assert.ok(
    nonMobileHtml.indexOf('data-testid="factory-panel-github-release"') < nonMobileHtml.indexOf('data-testid="factory-panel-store-release"'),
    "Store Release card renders directly beneath GitHub & Release",
  );
  for (const bodyHook of [
    "factory-panel-store-release-mode",
    "factory-panel-store-release-vault",
    "factory-panel-store-release-platforms",
    "factory-panel-store-release-last",
    "factory-panel-store-release-hole",
    "factory-panel-store-release-open-lab",
  ]) {
    assert.equal(hasHook(nonMobileHtml, bodyHook), false, `${bodyHook} stays hidden while non-mobile card is collapsed`);
  }

  // Clicking toggle expands the card on desktop
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: makePanel(),
          mobile: false,
          now: Date.now(),
          daemonError: null,
          actions: noopActions(),
          initialUi: { tab: "project" },
          storeRelease: makeStoreRelease({ isMobile: false, platforms: [] }),
        }),
      ),
    );
    assert.equal(container.querySelector('[data-testid="factory-panel-store-release-mode"]'), null);
    await act(() => (container.querySelector('[data-testid="factory-panel-store-release-toggle"]') as HTMLButtonElement).click());
    assert.ok(container.querySelector('[data-testid="factory-panel-store-release-mode"]'));
    assert.ok(container.querySelector('[data-testid="factory-panel-store-release-vault"]'));
    assert.ok(container.querySelector('[data-testid="factory-panel-store-release-platforms"]'));
    assert.ok(container.querySelector('[data-testid="factory-panel-store-release-last"]'));
    assert.ok(container.querySelector('[data-testid="factory-panel-store-release-open-lab"]'));
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }
});

test("Store Release card renders mobile 2-line summary bar, attention auto-expand, missing-Vault-keys rules, active Hole, and Open Release Lab states with mobile read-only discipline", async () => {
  // 1. Healthy mobile Project in `off` mode: starts collapsed to 2-line summary bar (platforms, Vault ready, Latest run)
  const mobileOffHtml = await render(makePanel(), {
    initialUi: { tab: "project" },
    storeRelease: makeStoreRelease({
      isMobile: true,
      mode: "off",
      platforms: ["android", "ios", "expo"],
      vault: { ascKey: true, appleTeamId: true, gplayJson: true },
      lastRun: null,
      activeHole: null,
    }),
  });
  for (const hook of [
    "factory-panel-store-release",
    "factory-panel-store-release-toggle",
    "factory-panel-store-release-last",
    "factory-panel-store-release-open-lab",
  ]) {
    assert.ok(hasHook(mobileOffHtml, hook), `${hook} renders in the 2-line mobile summary bar`);
  }
  for (const collapsedHook of [
    "factory-panel-store-release-mode",
    "factory-panel-store-release-vault",
    "factory-panel-store-release-platforms",
    "factory-panel-store-release-hole",
    "factory-panel-store-release-vault-warning",
  ]) {
    assert.equal(hasHook(mobileOffHtml, collapsedHook), false, `${collapsedHook} stays collapsed for healthy mobile Project`);
  }
  const summaryCard = elementOf(mobileOffHtml, "factory-panel-store-release");
  assert.match(summaryCard, /off/i);
  assert.match(summaryCard, /Android/);
  assert.match(summaryCard, /iOS/);
  assert.match(summaryCard, /Expo/);
  assert.match(summaryCard, /Vault ready/);
  assert.match(elementOf(mobileOffHtml, "factory-panel-store-release-last"), /No store runs yet/);

  // 2. Mobile Project in `auto-staging` mode with pendingRequest and failed lastRun -> auto-expands
  const mobileAutoHtml = await render(makePanel(), {
    initialUi: { tab: "project" },
    storeRelease: makeStoreRelease({
      isMobile: true,
      mode: "auto-staging",
      platforms: ["ios"],
      pendingRequest: {
        target: "staging",
        platforms: ["ios"],
        requestedAt: new Date().toISOString(),
      },
      lastRun: {
        id: "run-001",
        playbook: "stage-release",
        status: "failed",
        platforms: ["ios"],
        createdAt: new Date(Date.now() - 180_000).toISOString(),
        updatedAt: new Date(Date.now() - 120_000).toISOString(),
        completedAt: new Date(Date.now() - 120_000).toISOString(),
        error: "xcodebuild archive failed",
        failure: {
          failureClass: "app-repo",
          platform: "ios",
          phase: "build",
          code: "xcodebuild-failed",
          message: "Missing provisioning profile",
        },
      },
    }),
  });
  const modeHtml = elementOf(mobileAutoHtml, "factory-panel-store-release-mode");
  assert.match(modeHtml, /auto-staging/);
  assert.match(modeHtml, /Pending request: staging \(ios\)/);
  const lastHtml = elementOf(mobileAutoHtml, "factory-panel-store-release-last");
  assert.match(lastHtml, /failed/);
  assert.match(lastHtml, /stage-release/);
  assert.match(lastHtml, /run-001/);
  assert.match(lastHtml, /2m ago/);
  assert.match(lastHtml, /app-repo/);
  assert.match(lastHtml, /xcodebuild-failed/);
  assert.match(lastHtml, /Missing provisioning profile/);

  // 3. Missing-Vault-keys warning: calm & collapsed in mode="off", warns & auto-expands when mode !== "off"
  const offMissingKeysHtml = await render(makePanel(), {
    initialUi: { tab: "project" },
    storeRelease: makeStoreRelease({
      isMobile: true,
      mode: "off",
      platforms: ["android", "ios"],
      vault: { ascKey: false, appleTeamId: false, gplayJson: false },
    }),
  });
  assert.equal(hasHook(offMissingKeysHtml, "factory-panel-store-release-vault-warning"), false, "mode=off with missing keys stays calm and collapsed");
  assert.equal(hasHook(offMissingKeysHtml, "factory-panel-store-release-mode"), false);
  assert.match(elementOf(offMissingKeysHtml, "factory-panel-store-release"), /Vault · 3 missing/);
  assert.equal(elementOf(offMissingKeysHtml, "factory-panel-store-release").includes("#8f6802"), false, "mode=off missing keys uses idle badge, not warning amber");

  const androidOnlyOkHtml = await render(makePanel(), {
    initialUi: { tab: "project" },
    storeRelease: makeStoreRelease({
      isMobile: true,
      mode: "on-request",
      platforms: ["android"],
      vault: { ascKey: false, appleTeamId: false, gplayJson: true },
    }),
  });
  assert.equal(hasHook(androidOnlyOkHtml, "factory-panel-store-release-vault-warning"), false, "Android-only project with GPlay JSON ready has no warning");
  assert.equal(hasHook(androidOnlyOkHtml, "factory-panel-store-release-mode"), false, "Android-only project with GPlay JSON ready stays collapsed");

  const missingKeysHtml = await render(makePanel(), {
    initialUi: { tab: "project" },
    storeRelease: makeStoreRelease({
      isMobile: true,
      mode: "on-request",
      platforms: ["android", "ios"],
      vault: { ascKey: false, appleTeamId: false, gplayJson: false },
    }),
  });
  assert.ok(hasHook(missingKeysHtml, "factory-panel-store-release-vault-warning"));
  const missingVaultHtml = elementOf(missingKeysHtml, "factory-panel-store-release-vault");
  assert.match(missingVaultHtml, /ASC \.p8/);
  assert.match(missingVaultHtml, /Team ID/);
  assert.match(missingVaultHtml, /GPlay JSON/);
  assert.match(missingVaultHtml, /Missing Vault keys/);

  // 4. Active Hole summary + Open Release Lab & Open Vault Settings button clicks on desktop
  const openedLab: string[] = [];
  const openedSettings: string[] = [];
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: makePanel(),
          mobile: false,
          now: Date.now(),
          daemonError: null,
          actions: noopActions(),
          initialUi: { tab: "project" },
          storeRelease: makeStoreRelease({
            isMobile: true,
            mode: "on-request",
            platforms: ["ios"],
            vault: { ascKey: false, appleTeamId: false, gplayJson: false },
            activeHole: {
              runId: "run-hole-42",
              kind: "final-release-approval",
              phase: "submit",
              pausedAt: new Date(Date.now() - 300_000).toISOString(),
            },
          }),
          onOpenReleaseLab: () => { openedLab.push("opened"); },
          onOpenSettings: () => { openedSettings.push("settings"); },
        }),
      ),
    );
    const holeEl = container.querySelector('[data-testid="factory-panel-store-release-hole"]')!;
    assert.ok(holeEl, "active Hole summary renders");
    assert.match(holeEl.textContent!, /final-release-approval/);
    assert.match(holeEl.textContent!, /submit/);
    assert.match(holeEl.textContent!, /run-hole-42/);
    assert.match(holeEl.textContent!, /5m ago/);

    await act(() => (container.querySelector('[data-testid="factory-panel-store-release-open-vault-settings"]') as HTMLButtonElement).click());
    assert.deepEqual(openedSettings, ["settings"]);

    await act(() => (container.querySelector('[data-testid="factory-panel-store-release-open-lab"]') as HTMLButtonElement).click());
    assert.deepEqual(openedLab, ["opened"]);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }

  // 5. Paseo mobile host discipline: zero buttons inside factory-panel-store-release
  const hostMobileHtml = await render(makePanel(), {
    mobile: true,
    initialUi: { tab: "project" },
    storeRelease: makeStoreRelease({
      isMobile: true,
      mode: "auto-staging",
      platforms: ["android"],
      vault: { ascKey: false, appleTeamId: false, gplayJson: false },
      activeHole: {
        runId: "run-hole-99",
        kind: "day0-store-init",
        phase: "init",
        pausedAt: new Date().toISOString(),
      },
    }),
    onOpenReleaseLab: () => { assert.fail("mobile host must not invoke openReleaseLab button"); },
    onOpenSettings: () => { assert.fail("mobile host must not invoke openSettings button"); },
  });
  assert.doesNotMatch(elementOf(hostMobileHtml, "factory-panel-store-release"), /<button/);
  assert.ok(hasHook(hostMobileHtml, "factory-panel-store-release-hole"));
  assert.ok(hasHook(hostMobileHtml, "factory-panel-store-release-vault-warning"));
});

test("FactoryShell wires storeReleaseRead and storeReleaseWrite RPCs and index.client.tsx threads openReleaseLab targeting factory-release-lab", () => {
  const shell = readFileSync(join(repoRoot, "plugin/client/factory/shell.tsx"), "utf8");
  assert.match(shell, /storeReleaseRead/);
  assert.match(shell, /useRpc\(storeReleaseRead\)/);
  assert.match(shell, /storeReleaseWrite/);
  assert.match(shell, /useRpc\(storeReleaseWrite\)/);
  assert.match(shell, /storeRelease=\{storeReleaseView\}/);
  assert.match(shell, /onOpenReleaseLab/);
  assert.match(shell, /onOpenSettings/);

  const entries = readFileSync(join(repoRoot, "plugin/client/factory/entries.tsx"), "utf8");
  assert.match(entries, /openReleaseLab/);

  const indexClient = readFileSync(join(repoRoot, "plugin/index.client.tsx"), "utf8");
  assert.match(indexClient, /openReleaseLab/);
  assert.match(indexClient, /factory-release-lab/);
});

test("Store Release card renders Owner-only mode selector chips, busy/disabled state, feedback banner, and preserves mobile read-only discipline", async () => {
  const modeCalls: string[] = [];
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    // 1. Desktop interactive mode chips: clicking non-active mode fires setMode, clicking active mode is a no-op
    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: makePanel(),
          mobile: false,
          now: Date.now(),
          daemonError: null,
          actions: noopActions(),
          initialUi: { tab: "project" },
          storeRelease: makeStoreRelease({ isMobile: true, mode: "off", platforms: ["android", "ios"] }),
          storeReleaseBusy: false,
          storeReleaseFeedback: null,
          storeReleaseActions: {
            setMode: (mode: string) => { modeCalls.push(mode); },
          },
        }),
      ),
    );
    const chip = (mode: string) => container.querySelector(`[data-testid="factory-panel-store-release-mode-${mode}"]`) as HTMLButtonElement;
    assert.equal(chip("off"), null, "healthy mobile project starts collapsed");
    await act(() => (container.querySelector('[data-testid="factory-panel-store-release-toggle"]') as HTMLButtonElement).click());
    assert.ok(chip("off"));
    assert.ok(chip("on-request"));
    assert.ok(chip("auto-staging"));
    assert.equal(chip("off").getAttribute("data-selected"), "true");
    assert.equal(chip("on-request").getAttribute("data-selected"), "false");
    assert.equal(chip("auto-staging").getAttribute("data-selected"), "false");
    assert.equal(container.querySelector('[data-testid="factory-panel-store-release-pending"]'), null);
    assert.equal(container.querySelector('[data-testid="factory-panel-store-release-feedback"]'), null);

    await act(() => chip("off").click());
    assert.equal(modeCalls.length, 0, "clicking already-selected mode does not dispatch");
    await act(() => chip("on-request").click());
    await act(() => chip("auto-staging").click());
    assert.deepEqual(modeCalls, ["on-request", "auto-staging"]);

    // 2. Busy / pending state disables all mode chips and shows pending indicator
    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: makePanel(),
          mobile: false,
          now: Date.now(),
          daemonError: null,
          actions: noopActions(),
          initialUi: { tab: "project" },
          storeRelease: makeStoreRelease({ isMobile: true, mode: "on-request", platforms: ["ios"] }),
          storeReleaseBusy: true,
          storeReleaseFeedback: null,
          storeReleaseActions: {
            setMode: (mode: string) => { modeCalls.push(mode); },
          },
        }),
      ),
    );
    assert.equal(chip("off").disabled, true);
    assert.equal(chip("on-request").disabled, true);
    assert.equal(chip("auto-staging").disabled, true);
    assert.match(container.querySelector('[data-testid="factory-panel-store-release-pending"]')?.textContent ?? "", /Saving/i);

    // 3. Feedback banner renders success and error states
    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: makePanel(),
          mobile: false,
          now: Date.now(),
          daemonError: null,
          actions: noopActions(),
          initialUi: { tab: "project" },
          storeRelease: makeStoreRelease({ isMobile: true, mode: "auto-staging", platforms: ["ios"] }),
          storeReleaseBusy: false,
          storeReleaseFeedback: { text: "Store release mode set to auto-staging.", tone: "success" },
          storeReleaseActions: { setMode() {} },
        }),
      ),
    );
    assert.match(container.querySelector('[data-testid="factory-panel-store-release-feedback"]')?.textContent ?? "", /auto-staging/);

    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: makePanel(),
          mobile: false,
          now: Date.now(),
          daemonError: null,
          actions: noopActions(),
          initialUi: { tab: "project" },
          storeRelease: makeStoreRelease({ isMobile: true, mode: "auto-staging", platforms: ["ios"] }),
          storeReleaseBusy: false,
          storeReleaseFeedback: { text: "Seat lead cannot change Store release settings; Store release mode is Owner-only.", tone: "error" },
          storeReleaseActions: { setMode() {} },
        }),
      ),
    );
    assert.match(container.querySelector('[data-testid="factory-panel-store-release-feedback"]')?.textContent ?? "", /Owner-only/);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }

  // 4. Mobile host remains strictly read-only even if storeReleaseActions is supplied
  const mobileHtml = await render(makePanel(), {
    mobile: true,
    initialUi: { tab: "project" },
    storeRelease: makeStoreRelease({ isMobile: true, mode: "auto-staging", platforms: ["android", "ios"] }),
    storeReleaseActions: { setMode() { assert.fail("mobile must not expose mode write"); } },
  });
  assert.doesNotMatch(elementOf(mobileHtml, "factory-panel-store-release"), /<button/);
  assert.equal(hasHook(mobileHtml, "factory-panel-store-release-mode-off"), false);
  assert.equal(hasHook(mobileHtml, "factory-panel-store-release-mode-on-request"), false);
  assert.equal(hasHook(mobileHtml, "factory-panel-store-release-mode-auto-staging"), false);
});

test("ADR 0068 (Ticket 06): Team tab renders contextual Gate · running and Gate · queued pills with factory-team-gate-queue-pill", async () => {
  // 1. Running Gate on active Peer row
  const runningHtml = await render(
    makePanel({
      seats: {
        ...healthySeats,
        peers: [
          {
            ...healthySeats.peers[0]!,
            gateQueue: {
              id: "gq-run-1",
              task: "T-08",
              attempt: 1,
              status: "running",
              position: 1,
              aheadCount: 0,
              aheadLabel: null,
              paused: false,
              queuedAt: "2026-11-22T10:00:00.000Z",
              startedAt: "2026-11-22T10:00:01.000Z",
            },
          },
        ],
      },
      gateQueue: [
        {
          id: "gq-run-1",
          task: "T-08",
          attempt: 1,
          status: "running",
          position: 1,
          aheadCount: 0,
          aheadLabel: null,
          paused: false,
          queuedAt: "2026-11-22T10:00:00.000Z",
          startedAt: "2026-11-22T10:00:01.000Z",
        },
      ],
    }),
  );
  const runningPeer = runningHtml.slice(runningHtml.indexOf("factory-panel-seat-peer-T-08"));
  assert.ok(hasHook(runningPeer, "factory-team-gate-queue-pill"), "Peer row renders factory-team-gate-queue-pill");
  assert.match(runningPeer, /Gate · running/);
  assert.equal((runningHtml.match(/data-testid="factory-team-gate-queue-pill"/g) ?? []).length, 1, "does not duplicate Peer queue pill in fallback list");

  // 2. Queued Gate behind another Project's Task on active Peer row
  const queuedHtml = await render(
    makePanel({
      seats: {
        ...healthySeats,
        peers: [
          {
            ...healthySeats.peers[0]!,
            gateQueue: {
              id: "gq-q-2",
              task: "T-08",
              attempt: 2,
              status: "queued",
              position: 2,
              aheadCount: 1,
              aheadLabel: "Alpha · TA-1",
              paused: false,
              queuedAt: "2026-11-22T10:00:05.000Z",
              startedAt: null,
            },
          },
        ],
      },
    }),
  );
  const queuedPeer = queuedHtml.slice(queuedHtml.indexOf("factory-panel-seat-peer-T-08"));
  assert.ok(hasHook(queuedPeer, "factory-team-gate-queue-pill"));
  assert.match(queuedPeer, /Gate · queued \(#2 behind Alpha · TA-1\)/);

  // 3. Project-level gateQueue entry without a matching live Peer row (e.g. lead_verify) still renders on Team tab
  const verifyHtml = await render(
    makePanel({
      seats: { ...healthySeats, peers: [] },
      gateQueue: [
        {
          id: "gq-verify-3",
          task: "T-09",
          attempt: 1,
          status: "queued",
          position: 3,
          aheadCount: 2,
          aheadLabel: "Beta · TB-2",
          paused: true,
          queuedAt: "2026-11-22T10:00:10.000Z",
          startedAt: null,
          mechanical: "lead_verify",
        },
      ],
    }),
  );
  assert.ok(hasHook(verifyHtml, "factory-team-gate-queue-pill"));
  assert.match(verifyHtml, /Gate · queued \(#3 behind Beta · TB-2\)/);
  assert.match(verifyHtml, /T-09/);
  assert.match(verifyHtml, /Paused/);

  // 4. Presentational law: project-panel.tsx never imports or calls useRpc
  const source = readFileSync(join(repoRoot, "plugin/client/factory/project-panel.tsx"), "utf8");
  assert.equal(source.includes("useRpc"), false, "project-panel.tsx remains strictly presentational");
});

test("ADR 0068 (Ticket 07): Team tab renders interactive Cancel button on Peer and unmatched Gate pills with per-item pending and inline error states", async () => {
  const cancelCalls: string[] = [];
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);

  const panelWithQueue = makePanel({
    seats: {
      ...healthySeats,
      peers: [
        {
          ...healthySeats.peers[0]!,
          gateQueue: {
            id: "gq-run-1",
            task: "T-08",
            attempt: 1,
            status: "running",
            position: 1,
            aheadCount: 0,
            aheadLabel: null,
            paused: false,
            queuedAt: "2026-11-22T10:00:00.000Z",
            startedAt: "2026-11-22T10:00:01.000Z",
          },
        },
      ],
    },
    gateQueue: [
      {
        id: "gq-run-1",
        task: "T-08",
        attempt: 1,
        status: "running",
        position: 1,
        aheadCount: 0,
        aheadLabel: null,
        paused: false,
        queuedAt: "2026-11-22T10:00:00.000Z",
        startedAt: "2026-11-22T10:00:01.000Z",
      },
      {
        id: "gq-verify-3",
        task: "T-09",
        attempt: 1,
        status: "queued",
        position: 3,
        aheadCount: 2,
        aheadLabel: "Beta · TB-2",
        paused: false,
        queuedAt: "2026-11-22T10:00:10.000Z",
        startedAt: null,
        mechanical: "lead_verify",
      },
    ],
  });

  const renderPanel = (extra: Record<string, unknown> = {}) =>
    act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: panelWithQueue,
          mobile: false,
          now: Date.now(),
          daemonError: null,
          actions: {
            ...noopActions(),
            cancelGateQueueItem: (id: string) => {
              cancelCalls.push(id);
            },
          },
          ...extra,
        }),
      ),
    );

  const cancelBtn = (id: string) =>
    container.querySelector(`[data-testid="factory-queue-cancel-${id}"]`) as HTMLButtonElement | null;
  const errorEl = () =>
    container.querySelector('[data-testid="factory-team-gate-queue-error"]') as HTMLElement | null;

  try {
    await renderPanel();
    assert.equal(cancelBtn("gq-run-1")?.textContent, "Cancel");
    assert.equal(cancelBtn("gq-verify-3")?.textContent, "Cancel");
    assert.equal(cancelBtn("gq-run-1")?.disabled, false);
    assert.equal(cancelBtn("gq-verify-3")?.disabled, false);
    assert.equal(errorEl(), null);

    await act(() => cancelBtn("gq-run-1")!.click());
    await act(() => cancelBtn("gq-verify-3")!.click());
    assert.deepEqual(cancelCalls, ["gq-run-1", "gq-verify-3"]);

    // Per-item pending state
    await renderPanel({ cancellingGateQueueIds: ["gq-run-1"] });
    assert.equal(cancelBtn("gq-run-1")?.disabled, true);
    assert.match(cancelBtn("gq-run-1")?.textContent ?? "", /Cancelling\.\.\./);
    assert.equal(cancelBtn("gq-verify-3")?.disabled, false);
    assert.equal(cancelBtn("gq-verify-3")?.textContent, "Cancel");
    await act(() => cancelBtn("gq-run-1")!.click());
    assert.deepEqual(cancelCalls, ["gq-run-1", "gq-verify-3"], "disabled pending cancel button does not re-dispatch");

    // Inline error targeting an entry renders inside Team tab
    await renderPanel({
      cancellingGateQueueIds: [],
      gateQueueCancelError: { queueId: "gq-verify-3", message: "Gate already finished" },
    });
    assert.ok(errorEl());
    assert.match(errorEl()!.textContent ?? "", /Gate already finished/);

    // Fallback error when target id is no longer in list still renders once inside Seats
    await renderPanel({
      cancellingGateQueueIds: [],
      gateQueueCancelError: { queueId: "gq-missing", message: "no queued or running Gate found" },
    });
    assert.equal(container.querySelectorAll('[data-testid="factory-team-gate-queue-error"]').length, 1);
    assert.match(errorEl()!.textContent ?? "", /no queued or running Gate found/);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }
});

async function loadShellForPanelTest(): Promise<Exports> {
  const bundle = await build({
    entryPoints: [join(repoRoot, "plugin/client/factory/shell.tsx")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    plugins: [
      {
        name: "shell-native-adapter",
        setup(b) {
          b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui|@getpaseo\/plugin\/client)$/ }, (args) => ({
            path: args.path,
            namespace: "shell-native",
          }));
          b.onLoad({ filter: /.*/, namespace: "shell-native" }, () => ({
            loader: "js",
            contents: `
              const React = require('react');
              const tag = (name) => ({ children, onPress, disabled, testID, style, accessibilityRole, accessibilityState, accessibilityLabel }) =>
                React.createElement(name, { disabled, onClick: onPress, 'data-testid': testID, 'data-role': accessibilityRole, 'aria-label': accessibilityLabel, 'data-checked': accessibilityState && accessibilityState.checked !== undefined ? String(accessibilityState.checked) : undefined, 'data-selected': accessibilityState && accessibilityState.selected !== undefined ? String(accessibilityState.selected) : undefined }, typeof children === 'function' ? children({ pressed: false }) : children);
              exports.View = tag('div');
              exports.ScrollView = tag('div');
              exports.Text = tag('span');
              exports.Pressable = tag('button');
              exports.Icon = () => null;
              const Modal = ({ children, open }) => open ? React.createElement('div', {}, children) : null;
              Modal.Content = tag('div');
              exports.Modal = Modal;
              exports.TextInput = ({ value, placeholder, testID }) => React.createElement('input', { value: value ?? '', placeholder, readOnly: true, 'data-testid': testID });
              exports.Platform = { OS: 'web', select: (spec) => (spec.web !== undefined ? spec.web : spec.default) };
              exports.useRpc = (contract) => (input) => globalThis.__panelShellRpc(contract.name, input);
              exports.useSubscription = () => ({ status: 'live' });
              exports.useToast = () => ({ show(msg, opts) { globalThis.__panelShellToasts?.push({ msg, opts }); }, error(msg) { globalThis.__panelShellToasts?.push({ msg, error: true }); } });
              exports.openExternalUrl = async () => {};
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

test("ADR 0068 (Ticket 07): FactoryShell wires gateQueueCancel for Team tab Gate pills with pending state, live refresh, and inline errors", async () => {
  const { FactoryShell } = await loadShellForPanelTest();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = {
    window: g.window,
    document: g.document,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    __panelShellRpc: g.__panelShellRpc,
    __panelShellToasts: g.__panelShellToasts,
  };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.__panelShellToasts = [];

  const peerQueueEntry = {
    id: "gq-run-1",
    task: "T-08",
    attempt: 1,
    status: "running" as const,
    position: 1,
    aheadCount: 0,
    aheadLabel: null,
    paused: false,
    queuedAt: "2026-11-22T10:00:00.000Z",
    startedAt: "2026-11-22T10:00:01.000Z",
  };
  const verifyQueueEntry = {
    id: "gq-verify-3",
    task: "T-09",
    attempt: 1,
    status: "queued" as const,
    position: 2,
    aheadCount: 1,
    aheadLabel: "Alpha · TA-1",
    paused: false,
    queuedAt: "2026-11-22T10:00:10.000Z",
    startedAt: null,
    mechanical: "lead_verify" as const,
  };

  let currentPanel = makePanel({
    seats: {
      ...healthySeats,
      peers: [{ ...healthySeats.peers[0]!, gateQueue: peerQueueEntry }],
    },
    gateQueue: [peerQueueEntry, verifyQueueEntry],
  });
  const buildSnapshotView = () => ({
    version: 5,
    stateDir: "/state",
    generatedAt: new Date().toISOString(),
    lanes: { supervisor: "pi/glm-5.3", lead: "pi/glm-5.3", worker: "pi/glm-5.3", watch: "pi/glm-5.3", freshEyes: "eye.json" },
    machineLanes: { supervisor: "pi/glm-5.3", lead: "pi/glm-5.3", worker: "pi/glm-5.3", watch: "pi/glm-5.3", freshEyes: "eye.json" },
    kpis: { running: 1, needsHuman: 0, openTasks: 1, greenClaims: 0, redClaims: 0, sessions: 1 },
    agents: [],
    providers: [],
    supervisor: null,
    lead: null,
    daemonError: null,
    project: { root: "/snapshot-project", slug: "my-app", name: "my-app", missingRoot: false },
    corePlugin: { id: "paseo-factory", title: "Factory Core", status: "running", enabled: true },
    companions: [],
    companionTools: [],
    pluginsCheckedAt: null,
    vault: { configured: false, ghAuthenticated: false, historyImports: [], hydratedApps: [] },
    profiles: [],
    activeProfileId: null,
    activeProfileModified: false,
    hasProjectLaneOverride: false,
    skillHub: { skillPacksExplicit: false, projectPacks: [] },
    panel: structuredClone(currentPanel),
  });

  const rpcCalls: Array<{ name: string; input: unknown }> = [];
  let deferredCancel: ((input: unknown) => Promise<unknown>) | null = null;
  let nextCancelReply: unknown = null;

  g.__panelShellRpc = async (name: string, input: unknown) => {
    rpcCalls.push({ name, input });
    if (name === "factory.snapshot") return { ok: true, view: buildSnapshotView() };
    if (name === "factory.self.update.status") return { ok: true, current: "0.17.0", latest: "0.17.0", updateAvailable: false };
    if (name === "factory.gate.queue.cancel") {
      if (deferredCancel !== null) return await deferredCancel(input);
      if (nextCancelReply !== null) {
        const reply = nextCancelReply;
        nextCancelReply = null;
        if (reply instanceof Error) throw reply;
        return reply;
      }
      const targetId = (input as { queueId?: string }).queueId;
      currentPanel = {
        ...currentPanel,
        seats: {
          ...currentPanel.seats!,
          peers: currentPanel.seats!.peers.map((p) =>
            p.gateQueue?.id === targetId ? { ...p, gateQueue: null } : p,
          ),
        },
        gateQueue: (currentPanel.gateQueue ?? []).filter((e) => e.id !== targetId),
      };
      return {
        ok: true,
        cancelledCount: 1,
        cancelledIds: [targetId],
        gateQueue: { paused: false, pausedAt: null, concurrency: 1, running: [], queued: [] },
      };
    }
    return { ok: true };
  };

  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const cancelBtn = (id: string) =>
    container.querySelector(`[data-testid="factory-queue-cancel-${id}"]`) as HTMLButtonElement | null;
  const errorEl = () =>
    container.querySelector('[data-testid="factory-team-gate-queue-error"]') as HTMLElement | null;

  try {
    await act(async () => {
      root.render(createElement(FactoryShell, { theme, dir: "/snapshot-project", layout: { compact: false, platform: "web" } }));
      await new Promise<void>((r) => setTimeout(r, 15));
    });

    assert.equal(cancelBtn("gq-run-1")?.textContent, "Cancel");
    assert.equal(cancelBtn("gq-verify-3")?.textContent, "Cancel");

    // 1. Deferred cancel on gq-run-1 shows per-item pending and ignores duplicate clicks
    let resolveCancel!: (val: unknown) => void;
    deferredCancel = () => new Promise((resolve) => { resolveCancel = resolve; });

    await act(async () => {
      cancelBtn("gq-run-1")!.click();
    });
    assert.equal(cancelBtn("gq-run-1")?.disabled, true);
    assert.match(cancelBtn("gq-run-1")?.textContent ?? "", /Cancelling\.\.\./);
    assert.equal(cancelBtn("gq-verify-3")?.disabled, false);

    await act(async () => {
      cancelBtn("gq-run-1")!.click();
    });
    const cancelCalls = rpcCalls.filter((c) => c.name === "factory.gate.queue.cancel");
    assert.equal(cancelCalls.length, 1);
    assert.deepEqual(cancelCalls[0]!.input, { queueId: "gq-run-1" });

    deferredCancel = null;
    currentPanel = {
      ...currentPanel,
      seats: {
        ...currentPanel.seats!,
        peers: currentPanel.seats!.peers.map((p) => ({ ...p, gateQueue: null })),
      },
      gateQueue: [verifyQueueEntry],
    };
    const snapshotsBefore = rpcCalls.filter((c) => c.name === "factory.snapshot").length;
    await act(async () => {
      resolveCancel({
        ok: true,
        cancelledCount: 1,
        cancelledIds: ["gq-run-1"],
        gateQueue: { paused: false, pausedAt: null, concurrency: 1, running: [], queued: [] },
      });
      await new Promise<void>((r) => setTimeout(r, 15));
    });

    assert.equal(cancelBtn("gq-run-1"), null, "cancelled Peer gate queue pill disappears");
    assert.ok(rpcCalls.filter((c) => c.name === "factory.snapshot").length > snapshotsBefore, "refreshes snapshot on cancel");

    // 2. Refusal ({ ok: false, error }) surfaces inline error on Team tab
    nextCancelReply = { ok: false, code: "queue-item-not-found", error: "Gate queue item not found" };
    await act(async () => {
      cancelBtn("gq-verify-3")!.click();
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.equal(cancelBtn("gq-verify-3")?.disabled, false);
    assert.match(errorEl()?.textContent ?? "", /Gate queue item not found/);

    // 3. Thrown rejection surfaces error, then retry succeeds and clears error
    nextCancelReply = new Error("Daemon disconnected");
    await act(async () => {
      cancelBtn("gq-verify-3")!.click();
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.match(errorEl()?.textContent ?? "", /Daemon disconnected/);

    await act(async () => {
      cancelBtn("gq-verify-3")!.click();
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.equal(cancelBtn("gq-verify-3"), null);
    assert.equal(errorEl(), null);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }
});

test("Project tab 3-tier layout: wide desktop renders 60/40 Tier 2 split, 100% SkillPacks when openDesign is null, and stacks on narrow or mobile", async () => {
  const skillPacks = [{ id: "expo", label: "Expo", enabled: true, autoDetected: true }];
  const release = makeRelease();
  const storeRelease = makeStoreRelease({ isMobile: true, platforms: ["ios"] });

  // 1. Wide desktop with openDesign !== null -> Tier 1 Usage, Tier 2 60/40 row, Tier 3 stacked GitHub & Store Release
  const wide = await render(makePanel({ usage: recordedUsage }), {
    width: 900,
    mobile: false,
    initialUi: { tab: "project" },
    skillPacks,
    release,
    storeRelease,
  });
  assert.ok(hasHook(wide, "factory-project-tier2"), "wide desktop renders Tier 2 horizontal split container");
  const tier2 = elementOf(wide, "factory-project-tier2");
  const tier2Root = tier2.slice(0, tier2.indexOf(">"));
  assert.match(tier2Root, /&quot;flexDirection&quot;:&quot;row&quot;/);
  assert.match(tier2Root, /&quot;alignItems&quot;:&quot;flex-start&quot;/);
  assert.match(tier2, /&quot;flex&quot;:3,&quot;minWidth&quot;:0/);
  assert.match(tier2, /&quot;flex&quot;:2,&quot;minWidth&quot;:0/);
  assert.ok(tier2.indexOf('data-testid="factory-skill-packs"') < tier2.indexOf('data-testid="factory-panel-od"'));
  const tierOrder = [
    "project-usage-card",
    "factory-project-tier2",
    "factory-panel-github-release",
    "factory-panel-store-release",
  ];
  for (let i = 1; i < tierOrder.length; i++) {
    assert.ok(at(wide, tierOrder[i - 1]!) < at(wide, tierOrder[i]!), `${tierOrder[i - 1]} precedes ${tierOrder[i]}`);
  }

  // 2. Wide desktop with openDesign === null -> SkillPacks takes 100% width without factory-project-tier2
  const noDesign = await render(makePanel({ usage: recordedUsage, openDesign: null }), {
    width: 900,
    mobile: false,
    initialUi: { tab: "project" },
    skillPacks,
    release,
    storeRelease,
  });
  assert.equal(hasHook(noDesign, "factory-project-tier2"), false);
  assert.equal(hasHook(noDesign, "factory-panel-od"), false);
  assert.ok(hasHook(noDesign, "factory-skill-packs"));

  // 3. Narrow desktop (< 720) and mobile (even at width 900) stack vertically without factory-project-tier2
  for (const opts of [{ width: 500, mobile: false }, { width: 900, mobile: true }]) {
    const stacked = await render(makePanel({ usage: recordedUsage }), {
      ...opts,
      initialUi: { tab: "project" },
      skillPacks,
      release,
      storeRelease,
    });
    assert.equal(hasHook(stacked, "factory-project-tier2"), false, `no 60/40 split for width=${opts.width} mobile=${opts.mobile}`);
    assert.ok(at(stacked, "factory-skill-packs") < at(stacked, "factory-panel-od"));
  }
});

test("ProjectUsage 4-tile KPI strip wraps on narrow widths, pairs header controls, and uses palette.lead for By Model share bars", async () => {
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const darkTheme = { colors: { ...theme.colors, surface0: "#0d1117" } };

  // Wide vs narrow KPI strip wrapping
  const wideHtml = await render(makePanel({ usage: recordedUsage }), { width: 900, initialUi: { tab: "project" } });
  const wideStrip = elementOf(wideHtml, "project-usage-summary");
  assert.match(wideStrip.slice(0, wideStrip.indexOf(">")), /&quot;flexWrap&quot;:&quot;nowrap&quot;/);
  const narrowHtml = await render(makePanel({ usage: recordedUsage }), { width: 500, initialUi: { tab: "project" } });
  const narrowStrip = elementOf(narrowHtml, "project-usage-summary");
  assert.match(narrowStrip.slice(0, narrowStrip.indexOf(">")), /&quot;flexWrap&quot;:&quot;wrap&quot;/);

  // Header window switcher + By Model share bar use palette.lead in both light and dark themes
  for (const [label, t, leadHex] of [["light", theme, "#2f7899"], ["dark", darkTheme, "#5fa8cc"]] as const) {
    const dom = new JSDOM("<!doctype html><div id=root></div>");
    const g = globalThis as Record<string, any>;
    const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
    g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
    const { createRoot } = await import("react-dom/client");
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    try {
      await act(() => root.render(createElement(ProjectPanel, { theme: t, width: 900, panel: makePanel({ usage: recordedUsage }), mobile: false, now: Date.now(), daemonError: null, actions: noopActions(), initialUi: { tab: "project" } })));
      await act(() => (container.querySelector('[data-testid="project-usage-toggle"]') as HTMLButtonElement).click());
      await act(() => (container.querySelector('[data-testid="project-usage-mode-model"]') as HTMLButtonElement).click());
      const modelsHtml = container.querySelector('[data-testid="project-usage-models"]')!.innerHTML;
      assert.ok(modelsHtml.includes(`${leadHex}22`), `${label} By Model share bar track uses palette.lead 22`);
      assert.ok(modelsHtml.includes(`${leadHex}aa`), `${label} By Model share bar fill uses palette.lead aa`);
      const modeHtml = container.querySelector('[data-testid="project-usage-mode"]')!.innerHTML;
      assert.ok(modeHtml.includes(leadHex), `${label} project-usage-mode uses palette.lead`);
      const windowHtml = container.querySelector('[data-testid="project-usage-window"]')!.innerHTML;
      assert.ok(windowHtml.includes(leadHex), `${label} project-usage-window uses palette.lead`);
    } finally {
      await act(() => root.unmount());
      Object.assign(g, saved);
      dom.window.close();
    }
  }
});

test("SkillPacks Core expands wrapped monospace chips without Switch, inactive drawer stays open across pack toggles, and mobile allows disclosure without writes", async () => {
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);

  let packs = [
    { id: "pack-active", label: "Active pack", kind: "builtin" as const, installedCount: 1, skills: ["act-1", "act-2"], enabled: true, autoDetected: true },
    { id: "pack-a", label: "Pack A", kind: "custom" as const, installedCount: 2, skills: ["skill-a1", "skill-a2"], enabled: false, autoDetected: false },
    { id: "pack-b", label: "Pack B", kind: "source" as const, installedCount: 1, skills: ["skill-b1"], enabled: false, autoDetected: false },
  ];
  const toggleCalls: Array<[string, boolean]> = [];
  const renderDesktop = () =>
    act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: makePanel(),
          mobile: false,
          now: Date.now(),
          daemonError: null,
          initialUi: { tab: "project" },
          skillPacks: packs.map((p) => ({ ...p })),
          actions: {
            ...noopActions(),
            toggleSkillPack: (id: string, enabled: boolean) => {
              toggleCalls.push([id, enabled]);
              packs = packs.map((p) => (p.id === id ? { ...p, enabled } : p));
            },
          },
        }),
      ),
    );

  const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  try {
    await renderDesktop();
    assert.equal(byId("factory-skill-pack-core"), null, "Core has no Switch");
    assert.equal(byId("factory-skill-pack-skills-core"), null, "Core starts collapsed");

    // Expand Core -> wrapped monospace skill tags
    await act(() => byId("factory-skill-pack-expand-core")!.click());
    const coreSkills = byId("factory-skill-pack-skills-core")!;
    assert.ok(coreSkills);
    assert.match(coreSkills.innerHTML, /&quot;flexDirection&quot;:&quot;row&quot;,&quot;flexWrap&quot;:&quot;wrap&quot;/);
    assert.match(coreSkills.innerHTML, /&quot;fontFamily&quot;:&quot;Menlo&quot;/);
    assert.match(coreSkills.textContent!, /tdd.*research/);

    // Open inactive packs drawer -> toggle pack-a on -> drawer stays open for pack-b -> toggle pack-a back off -> stays in open drawer
    assert.equal(byId("factory-panel-skill-pack-a"), null);
    await act(() => byId("factory-skill-packs-inactive-toggle")!.click());
    assert.ok(byId("factory-panel-skill-pack-a"));
    assert.ok(byId("factory-panel-skill-pack-b"));

    await act(() => byId("factory-skill-pack-pack-a")!.click());
    await renderDesktop();
    assert.deepEqual(toggleCalls, [["pack-a", true]]);
    assert.ok(byId("factory-panel-skill-pack-a"), "enabled pack moves to active list");
    assert.ok(byId("factory-panel-skill-pack-b"), "inactive drawer stays open across pack enable toggle");
    assert.match(byId("factory-skill-packs-inactive-toggle")!.textContent!, /▾ Inactive packs \(1\)/);

    await act(() => byId("factory-skill-pack-pack-a")!.click());
    await renderDesktop();
    assert.deepEqual(toggleCalls, [["pack-a", true], ["pack-a", false]]);
    assert.ok(byId("factory-panel-skill-pack-a"), "disabled pack returns inside still-open inactive drawer");
    assert.match(byId("factory-skill-packs-inactive-toggle")!.textContent!, /▾ Inactive packs \(2\)/);

    // Mobile allows Core expand + inactive drawer toggle + pack skill tag inspection with zero switches/writes
    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          key: "mobile-packs",
          theme,
          panel: makePanel(),
          mobile: true,
          now: Date.now(),
          daemonError: null,
          initialUi: { tab: "project" },
          skillPacks: packs,
          actions: {
            ...noopActions(),
            toggleSkillPack() { assert.fail("mobile must not toggle"); },
            resetSkillPacks() { assert.fail("mobile must not reset"); },
            manageSkillPacks() { assert.fail("mobile must not open settings"); },
          },
        }),
      ),
    );
    await act(() => byId("factory-skill-pack-expand-core")!.click());
    assert.ok(byId("factory-skill-pack-skills-core"));
    await act(() => byId("factory-skill-packs-inactive-toggle")!.click());
    await act(() => byId("factory-skill-pack-expand-pack-b")!.click());
    const mobilePackSkills = byId("factory-skill-pack-skills-pack-b")!;
    assert.match(mobilePackSkills.textContent!, /skill-b1/);
    assert.match(mobilePackSkills.innerHTML, /&quot;flexWrap&quot;:&quot;wrap&quot;/);
    const mobileCard = byId("factory-skill-packs")!;
    assert.equal(mobileCard.querySelector('[data-role="switch"]'), null, "zero switches on mobile");
    assert.equal(byId("factory-skill-packs-reset"), null);
    assert.equal(byId("factory-skill-packs-manage"), null);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }
});

test("OpenDesign Broken renders AlertRow in palette.bad and OpenDesignControl unified renders Unlink ghost in palette.bad across light and dark", async () => {
  const darkTheme = { colors: { ...theme.colors, surface0: "#0d1117" } };
  for (const [label, t, badHex] of [["light", theme, "#c8253d"], ["dark", darkTheme, "#fe5462"]] as const) {
    const html = await render(
      makePanel({
        openDesign: {
          state: "broken",
          projectName: "App Design",
          syncedAt: null,
          detail: "Staged files missing — sync again.",
        },
      }),
      { theme: t, initialUi: { tab: "project" } },
    );
    const card = elementOf(html, "factory-panel-od");
    assert.match(card, />Broken</);
    assert.match(card, /Open Design link is broken · App Design/);
    assert.match(card, /Staged files missing — sync again\./);
    assert.ok(card.includes(`&quot;width&quot;:3,&quot;backgroundColor&quot;:&quot;${badHex}&quot;`), `${label} Broken AlertRow has 3px palette.bad bar`);
    assert.ok(card.includes(`&quot;backgroundColor&quot;:&quot;${badHex}10&quot;`), `${label} Broken AlertRow has palette.bad 10% tint`);
  }

  // Load OpenDesignControl with data-idle-style exposed to verify Unlink ghost palette.bad & Open Studio palette.lead
  const { build } = await import("esbuild");
  const { createRequire } = await import("node:module");
  const bundle = await build({
    entryPoints: [join(repoRoot, "plugin/client/factory/open-design.tsx")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    plugins: [
      {
        name: "od-native-adapter",
        setup(b) {
          b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui|@getpaseo\/plugin\/client)$/ }, (args) => ({ path: args.path, namespace: "od-native" }));
          b.onLoad({ filter: /.*/, namespace: "od-native" }, () => ({
            loader: "js",
            contents: `
              const React = require('react');
              const tag = (name) => ({ children, onPress, disabled, testID, style }) =>
                React.createElement(name, { disabled, onClick: onPress, 'data-testid': testID, 'data-style': typeof style === 'object' && style !== null ? JSON.stringify(style) : undefined, 'data-idle-style': typeof style === 'function' ? JSON.stringify(style({ pressed: false })) : undefined }, typeof children === 'function' ? children({ pressed: false }) : children);
              exports.View = tag('div'); exports.ScrollView = tag('div'); exports.Text = tag('span'); exports.Pressable = tag('button');
              exports.Icon = () => null;
              exports.Platform = { OS: 'ios', select: (spec) => spec.ios ?? spec.default };
              exports.useRpc = (contract) => React.useCallback((input) => globalThis.__odTestRpc(contract.name, input), [contract]);
              exports.openExternalUrl = async () => {};
              exports.DocumentFrame = () => null;
              const Modal = ({ children, open }) => open ? React.createElement('div', {}, children) : null;
              Modal.Content = tag('div');
              exports.Modal = Modal;
            `,
          }));
        },
      },
    ],
  });
  const mod = { exports: {} as Exports };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), mod, mod.exports);
  const { OpenDesignControl } = mod.exports;

  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const g = globalThis as Record<string, any>;
  const savedRpc = g.__odTestRpc;
  g.__odTestRpc = async (method: string) => {
    if (method === "factory.open_design.status") {
      return { ok: true, link: { projectId: "p1", projectName: "Studio App", digest: "d1", sourceUpdatedAt: 10 }, updateAvailable: false };
    }
    return { ok: true };
  };
  try {
    for (const [label, t, badHex, leadHex] of [["light", theme, "#c8253d", "#2f7899"], ["dark", darkTheme, "#fe5462", "#5fa8cc"]] as const) {
      const dom = new JSDOM("<!doctype html><div id=root></div>");
      const savedDom = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
      g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
      const { createRoot } = await import("react-dom/client");
      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(createElement(OpenDesignControl, { theme: t, root: "/repo/app", part: "unified", onChanged() {} }));
          await new Promise<void>((r) => setTimeout(r, 15));
        });
        const studioBtn = container.querySelector('[data-testid="factory-open-design-studio"]')!;
        assert.ok(studioBtn.getAttribute("data-idle-style")?.includes(leadHex), `${label} Open Studio uses palette.lead`);
        const unlinkBtn = container.querySelector('[data-testid="factory-open-design-unlink"]')!;
        assert.ok(unlinkBtn.getAttribute("data-idle-style")?.includes('"borderColor":"transparent"'), `${label} Unlink is ghost`);
        assert.ok(unlinkBtn.innerHTML.includes(badHex), `${label} Unlink ghost foreground uses palette.bad`);
      } finally {
        await act(() => root.unmount());
        Object.assign(g, savedDom);
        dom.window.close();
      }
    }
  } finally {
    g.__odTestRpc = savedRpc;
  }
});

test("GitHub & Release modal stays open on return false / rejected publish, closes on success, and >2 branch drawer toggles & auto-closes on select", async () => {
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);

  const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  try {
    // 1. > 2 branch candidates -> collapsible drawer opens and auto-closes on select; wide uses horizontal KeyValueRow
    const branchChanges: Array<string | null> = [];
    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          width: 900,
          panel: makePanel(),
          mobile: false,
          now: Date.now(),
          daemonError: null,
          actions: noopActions(),
          initialUi: { tab: "project" },
          release: makeRelease({
            branch: "release",
            resolvedBranch: "release",
            defaultBranch: "main",
            branchCandidates: ["main", "release", "staging"],
          }),
          releaseActions: {
            setBranch: (b: string | null) => { branchChanges.push(b); },
          },
        }),
      ),
    );
    const branchRow = byId("factory-panel-release-branch")!;
    assert.match(branchRow.getAttribute("data-style") ?? "", /"flexDirection":"row"/, "wide KeyValueRow lays out horizontally");
    assert.equal(byId("factory-panel-release-branch-option-staging"), null, "> 2 branch options start collapsed");
    assert.equal(byId("factory-panel-release-branch-toggle")?.textContent, "Change ▾");

    await act(() => byId("factory-panel-release-branch-toggle")!.click());
    assert.equal(byId("factory-panel-release-branch-toggle")?.textContent, "Hide ▴");
    assert.ok(byId("factory-panel-release-branch-option-main"));
    assert.ok(byId("factory-panel-release-branch-option-release"));
    assert.ok(byId("factory-panel-release-branch-option-staging"));

    await act(() => byId("factory-panel-release-branch-option-staging")!.click());
    assert.deepEqual(branchChanges, ["staging"]);
    assert.equal(byId("factory-panel-release-branch-option-staging"), null, "drawer auto-closes on branch select");
    assert.equal(byId("factory-panel-release-branch-toggle")?.textContent, "Change ▾");

    // 2. Modal stays open on return false (with releaseFeedback error) and on thrown error, then closes on true
    let publishBehavior: "false" | "throw" | "true" = "false";
    const renderPublishPanel = (feedback: { text: string; tone: "info" | "success" | "error" } | null = null) =>
      act(() =>
        root.render(
          createElement(ProjectPanel, {
            key: "pub",
            theme,
            width: 500,
            panel: makePanel(),
            mobile: false,
            now: Date.now(),
            daemonError: null,
            actions: noopActions(),
            initialUi: { tab: "project" },
            release: makeRelease({ origin: null, resolvedBranch: null, defaultBranch: null, gh: { installed: true, authenticated: true, user: "octo" } }),
            releaseFeedback: feedback,
            releaseActions: {
              publish: async () => {
                if (publishBehavior === "false") return false;
                if (publishBehavior === "throw") throw new Error("Network failure during publish");
                return true;
              },
            },
          }),
        ),
      );

    await renderPublishPanel();
    assert.doesNotMatch(byId("factory-panel-github-origin")!.getAttribute("data-style") ?? "", /"flexDirection":"row"/, "narrow KeyValueRow stacks vertically");
    await act(() => byId("factory-panel-github-publish-open")!.click());
    assert.ok(byId("factory-panel-github-publish"));

    await act(() => byId("factory-panel-github-publish-submit")!.click());
    await renderPublishPanel({ text: "Publish refused by GitHub", tone: "error" });
    assert.ok(byId("factory-panel-github-publish"), "modal stays open on return false");
    assert.match(byId("factory-panel-release-feedback")?.textContent ?? "", /Publish refused by GitHub/);

    publishBehavior = "throw";
    await renderPublishPanel(null);
    await act(() => byId("factory-panel-github-publish-submit")!.click());
    assert.ok(byId("factory-panel-github-publish"), "modal stays open on thrown error");
    assert.match(byId("factory-panel-release-feedback")?.textContent ?? "", /Network failure during publish/);

    publishBehavior = "true";
    await act(() => byId("factory-panel-github-publish-submit")!.click());
    assert.equal(byId("factory-panel-github-publish"), null, "modal closes on publish success");
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }
});

test("Store Release preserves manual collapse across snapshot polls until projectRoot changes or a new attentionKey appears", async () => {
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);

  const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const renderStore = (storeRelease: StoreReleaseView, mobile = false) =>
    act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          panel: makePanel(),
          mobile,
          now: Date.now(),
          daemonError: null,
          actions: noopActions(),
          initialUi: { tab: "project" },
          storeRelease,
        }),
      ),
    );

  try {
    // 1. Starts expanded because mode !== "off" with missing ASC .p8 key (attentionKey = "vault:ASC .p8")
    const baseStore = makeStoreRelease({
      projectRoot: "/repo/app-one",
      isMobile: true,
      mode: "on-request",
      platforms: ["ios"],
      vault: { ascKey: false, appleTeamId: true, gplayJson: true },
    });
    await renderStore(baseStore);
    assert.ok(byId("factory-panel-store-release-mode"), "auto-expanded for missing Vault key while mode !== off");
    assert.equal(byId("factory-panel-store-release-toggle")?.textContent, "▾ Hide");

    // 2. Owner manually collapses -> stays collapsed across subsequent polls with same projectRoot + same attentionKey
    await act(() => byId("factory-panel-store-release-toggle")!.click());
    assert.equal(byId("factory-panel-store-release-mode"), null);
    assert.equal(byId("factory-panel-store-release-toggle")?.textContent, "Configure ▾");

    await renderStore({ ...baseStore, updatedAt: "2026-11-24T01:00:00Z" });
    assert.equal(byId("factory-panel-store-release-mode"), null, "manual collapse persists across snapshot poll");

    // 3. New attentionKey appears on same projectRoot (e.g. Active Hole) -> auto-expands
    await renderStore({
      ...baseStore,
      activeHole: { runId: "run-9", kind: "app-store-review", phase: "submit", pausedAt: "2026-11-24T02:00:00Z" },
    });
    assert.ok(byId("factory-panel-store-release-mode"), "new attentionKey auto-expands despite prior manual collapse");
    assert.ok(byId("factory-panel-store-release-hole"));

    // 4. Collapse again, then switch projectRoot -> healthy project resets to collapsed, attention project resets to expanded
    await act(() => byId("factory-panel-store-release-toggle")!.click());
    assert.equal(byId("factory-panel-store-release-mode"), null);

    await renderStore(makeStoreRelease({ projectRoot: "/repo/app-two", isMobile: true, mode: "off", platforms: ["ios"] }));
    assert.equal(byId("factory-panel-store-release-mode"), null, "switching to healthy projectRoot resets to collapsed");

    await renderStore(
      makeStoreRelease({
        projectRoot: "/repo/app-three",
        isMobile: true,
        mode: "auto-staging",
        platforms: ["android"],
        lastRun: {
          id: "run-fail",
          playbook: "stage",
          status: "failed",
          platforms: ["android"],
          createdAt: "2026-11-24T02:00:00Z",
          updatedAt: "2026-11-24T02:01:00Z",
          completedAt: "2026-11-24T02:01:00Z",
          error: "Play upload failed",
          failure: null,
        },
      }),
    );
    assert.ok(byId("factory-panel-store-release-mode"), "switching to projectRoot with failed run resets to auto-expanded");

    // 5. Paseo mobile with attention auto-expands with zero <button> elements
    await renderStore(
      makeStoreRelease({
        projectRoot: "/repo/app-mobile-hole",
        isMobile: true,
        mode: "on-request",
        platforms: ["ios"],
        vault: { ascKey: false, appleTeamId: false, gplayJson: true },
        activeHole: { runId: "run-mob", kind: "final-release-approval", phase: "submit", pausedAt: "2026-11-24T03:00:00Z" },
      }),
      true,
    );
    const mobileCard = byId("factory-panel-store-release")!;
    assert.ok(byId("factory-panel-store-release-hole"));
    assert.ok(byId("factory-panel-store-release-vault-warning"));
    assert.equal(mobileCard.querySelectorAll("button").length, 0, "mobile Store Release card renders zero <button> elements");
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }
});

test("FACTORY_PALETTE covers every Project-tab card in both light and dark themes with zero host accent or status leaks", async () => {
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));

  const canaryLight = {
    colors: {
      surface0: "#ffffff",
      surface1: "#f5f5f5",
      surface2: "#eeeeee",
      foreground: "#111111",
      foregroundMuted: "#555555",
      border: "#cccccc",
      accent: "#ff00fe",
      statusSuccess: "#01ff02",
      statusWarning: "#fffe01",
      statusDanger: "#ff0101",
    },
  };
  const canaryDark = {
    colors: {
      ...canaryLight.colors,
      surface0: "#0d1117",
      surface1: "#161b22",
      surface2: "#21262d",
      foreground: "#f0f6fc",
      foregroundMuted: "#8b949e",
      border: "#30363d",
    },
  };

  const usageWithSupervisor: NonNullable<PanelView["usage"]> = {
    ...recordedUsage,
    seats: [
      {
        seat: "supervisor",
        label: "Supervisor",
        newTokens: 100_000,
        inputUncachedTokens: 80_000,
        outputTokens: 20_000,
        cachedTokens: 400_000,
        cacheReadTokens: 400_000,
        totalTokens: 500_000,
        sessionCount: 4,
        sharePercent: 20,
        cacheHitPercent: 80,
        models: [],
      },
      ...recordedUsage.seats,
    ],
    windows: {
      ...recordedUsage.windows!,
      all: {
        ...recordedAllWindow,
        seats: [
          {
            seat: "supervisor",
            label: "Supervisor",
            newTokens: 100_000,
            inputUncachedTokens: 80_000,
            outputTokens: 20_000,
            cachedTokens: 400_000,
            cacheReadTokens: 400_000,
            totalTokens: 500_000,
            sessionCount: 4,
            sharePercent: 20,
            cacheHitPercent: 80,
            models: [],
          },
          ...recordedAllWindow.seats,
        ],
      },
    },
  };

  const expectedLight = { ok: "#337e58", wait: "#8f6802", bad: "#c8253d", lead: "#2f7899", peer: "#287a81", supervisor: "#7459b4", idle: "#677176" };
  const expectedDark = { ok: "#68b78d", wait: "#cd9a22", bad: "#fe5462", lead: "#5fa8cc", peer: "#5db3ba", supervisor: "#a798d7", idle: "#6c767b" };

  for (const [label, t, pal] of [["light", canaryLight, expectedLight], ["dark", canaryDark, expectedDark]] as const) {
    const dom = new JSDOM("<!doctype html><div id=root></div>");
    const g = globalThis as Record<string, any>;
    const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
    g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
    const { createRoot } = await import("react-dom/client");
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          createElement(ProjectPanel, {
            theme: t,
            width: 900,
            mobile: false,
            now: Date.now(),
            daemonError: null,
            initialUi: { tab: "project", expandedSkillPacks: ["core", "inactive-pack"] },
            panel: makePanel({
              usage: usageWithSupervisor,
              openDesign: { state: "broken", projectName: "Studio", syncedAt: null, detail: "Sync failed" },
            }),
            skillPacks: [
              { id: "active-pack", label: "Active", kind: "builtin", installedCount: 1, skills: ["s1"], enabled: true, autoDetected: true },
              { id: "inactive-pack", label: "Inactive", kind: "custom", installedCount: 0, skills: [], enabled: false, autoDetected: false },
            ],
            skillPacksExplicit: true,
            actions: { ...noopActions(), toggleSkillPack() {}, resetSkillPacks() {}, manageSkillPacks() {} },
            release: makeRelease({
              mode: "on-request",
              pendingRequest: { version: "0.24.0", requestedAt: new Date().toISOString() },
              gh: { installed: true, authenticated: false, user: null },
              lastRelease: {
                version: "0.23.0",
                tag: "v0.23.0",
                commit: "abcdef1234567",
                branch: "main",
                url: "https://github.com/acme/my-app/releases/tag/v0.23.0",
                mode: "on-request",
                ts: new Date().toISOString(),
              },
            }),
            releaseFeedback: { text: "Release note", tone: "info" },
            releaseActions: { setMode() {}, setBranch() {}, checkLogin() {}, copyLoginCommand() {}, openUrl() {} },
            storeRelease: makeStoreRelease({
              isMobile: true,
              mode: "auto-staging",
              platforms: ["ios", "android"],
              vault: { ascKey: false, appleTeamId: true, gplayJson: false },
              activeHole: { runId: "r1", kind: "final-release-approval", phase: "submit", pausedAt: new Date().toISOString() },
              lastRun: {
                id: "r0",
                playbook: "stage",
                status: "failed",
                platforms: ["ios"],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                error: "Build failed",
                failure: null,
              },
            }),
            storeReleaseFeedback: { text: "Saved", tone: "success" },
            storeReleaseActions: { setMode() {} },
            onOpenReleaseLab() {},
            onOpenSettings() {},
          }),
        ),
      );
      await act(() => (container.querySelector('[data-testid="project-usage-toggle"]') as HTMLButtonElement).click());
      const bySeatHtml = container.querySelector('[data-testid="project-usage-seats"]')!.innerHTML.toLowerCase();
      assert.ok(bySeatHtml.includes(pal.supervisor), `${label} By Seat uses FACTORY_PALETTE.supervisor (${pal.supervisor})`);
      await act(() => (container.querySelector('[data-testid="project-usage-mode-model"]') as HTMLButtonElement).click());

      const bodyHtml = container.querySelector('[data-testid="factory-tab-body-project"]')!.innerHTML.toLowerCase();
      for (const forbidden of ["#ff00fe", "#01ff02", "#fffe01", "#ff0101"]) {
        assert.equal(bodyHtml.includes(forbidden), false, `${label} Project tab must never leak host colour ${forbidden}`);
      }
      for (const [role, hex] of Object.entries(pal)) {
        if (role === "supervisor") continue; // verified in By Seat above before switching to By Model
        assert.ok(bodyHtml.includes(hex), `${label} Project tab uses FACTORY_PALETTE.${role} (${hex})`);
      }
    } finally {
      await act(() => root.unmount());
      Object.assign(g, saved);
      dom.window.close();
    }
  }
});

// ---- Wave 3b: Needs you Setup Proposal Card UI ----------------------------------------------------

function makeSetupProposalItem(
  overrides: Partial<NonNullable<PanelView["needsYou"][number]["setupProposal"]>> = {},
): PanelView["needsYou"][number] {
  const status = overrides.status ?? "pending";
  const reason = overrides.reason ?? "Enable mobile store staging and GitHub helper MCP.";
  const id = overrides.id ?? "prop-1";
  return {
    key: `setup-proposal:${id}`,
    kind: "setup-proposal",
    title:
      status === "failed"
        ? "Setup Proposal failed"
        : status === "applying"
          ? "Applying Setup Proposal…"
          : "Setup Proposal awaiting approval",
    detail: reason,
    action: {
      kind: "setup-proposal",
      label: status === "failed" ? "Retry" : status === "applying" ? "Applying…" : "Approve & Apply",
    },
    setupProposal: {
      id,
      actionsHash: "hash-abc123",
      status,
      reason,
      actions: [
        { label: "Install factory-release-lab", status: "pending" },
        { label: "Enable GitHub Helper MCP", machineWide: true, status: "pending" },
      ],
      warnings: [],
      ...overrides,
    },
  };
}

test("Wave 3b: Setup Proposal renders first in Needs you, keeps needsYouCount/directory badges consistent, deduplicates reason, and shows actions, badges, errors, and warnings", async () => {
  const { headerLabel, workspaceRowBadgePlan, sidebarOverviewBadgePlan } = await import("../plugin/client/kit/directory.ts");
  const proposalItem = makeSetupProposalItem({
    status: "failed",
    reason: "Configure store staging and GitHub MCP.",
    actions: [
      { label: "Install factory-release-lab", status: "done" },
      { label: "Enable GitHub Helper MCP", machineWide: true, status: "failed", error: "gh auth failed (redacted)" },
      { label: "Set store release mode", status: "pending" },
      { label: "Verify mobile targets", status: "skipped" },
    ],
    warnings: [
      "Missing Vault keys: ASC .p8 — add in Settings -> Private Vault.",
      "Play Store JSON key not configured yet.",
    ],
  });
  const html = await render(
    makePanel({
      summary: "Lead working · 1 Peer · 2 need you",
      needsYou: [proposalItem, noSupervisorItem],
    }),
  );

  assert.ok(at(html, "factory-panel-needs-you") < at(html, "factory-setup-proposal"));
  assert.ok(at(html, "factory-setup-proposal") < at(html, "factory-panel-needs-you-no-supervisor"));
  assert.ok(at(html, "factory-setup-proposal") < at(html, "factory-tab"));
  assert.match(html, /Lead working · 1 Peer · 2 need you/);

  // Directory & overview badge helpers reflect the Setup Proposal's contribution to needsYouCount.
  const directoryEntry = {
    slug: "my-app",
    name: "my-app",
    root: "/project",
    workspaceId: "ws-1",
    needsYouCount: 2,
    runningCount: 1,
    activeWorkCount: 1,
    backgroundWorkCount: 0,
    handoffActive: false,
  };
  assert.equal(headerLabel(2), "Factory · 2");
  assert.equal(workspaceRowBadgePlan("ws-1", [directoryEntry])?.label, "Needs you · 2");
  assert.equal(sidebarOverviewBadgePlan([directoryEntry])?.label, "Needs you · 2");

  const card = elementOf(html, "factory-setup-proposal");
  // Reason is rendered exactly once (not duplicated from item.detail + setupProposal.reason).
  assert.equal(card.split("Configure store staging and GitHub MCP.").length - 1, 1);

  const action0 = elementOf(card, "factory-setup-proposal-action-0");
  const action1 = elementOf(card, "factory-setup-proposal-action-1");
  const action2 = elementOf(card, "factory-setup-proposal-action-2");
  const action3 = elementOf(card, "factory-setup-proposal-action-3");
  assert.match(action0, /Install factory-release-lab/);
  assert.match(action0, /done/);
  assert.doesNotMatch(action0, /machine-wide/);
  assert.match(action1, /Enable GitHub Helper MCP/);
  assert.match(action1, /machine-wide/);
  assert.match(action1, /failed/);
  assert.match(action1, /gh auth failed \(redacted\)/);
  assert.ok(action1.includes("#c8253d"), "step error uses light FACTORY_PALETTE.bad");
  assert.match(action2, /Set store release mode/);
  assert.match(action2, /pending/);
  assert.match(action3, /Verify mobile targets/);
  assert.match(action3, /skipped/);

  assert.ok(hasHook(card, "factory-setup-proposal-warning"));
  assert.match(card, /Missing Vault keys: ASC \.p8/);
  assert.match(card, /Play Store JSON key not configured yet\./);

  const noWarningsHtml = await render(makePanel({ needsYou: [makeSetupProposalItem({ warnings: [] })] }));
  assert.equal(hasHook(noWarningsHtml, "factory-setup-proposal-warning"), false);
});

test("Wave 3b: Setup Proposal uses dynamic FACTORY_PALETTE wait/bad tones with zero host accent or status leaks across light and dark canary themes", async () => {
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
        name: "setup-proposal-canary-adapter",
        setup(b) {
          b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui|@getpaseo\/plugin\/client)$/ }, (args) => ({ path: args.path, namespace: "canary-native" }));
          b.onLoad({ filter: /.*/, namespace: "canary-native" }, () => ({
            loader: "js",
            contents: `
              const React = require('react');
              const tag = (name) => ({ children, onPress, disabled, testID, style, accessibilityRole }) =>
                React.createElement(name, {
                  disabled,
                  onClick: onPress,
                  'data-testid': testID,
                  'data-role': accessibilityRole,
                  'data-style': typeof style === 'object' && style !== null ? JSON.stringify(style) : undefined,
                  'data-idle-style': typeof style === 'function' ? JSON.stringify(style({ pressed: false })) : undefined,
                }, typeof children === 'function' ? children({ pressed: false }) : children);
              exports.View = tag('div'); exports.Text = tag('span'); exports.Pressable = tag('button');
              exports.Icon = () => null;
              const Modal = ({ children, open }) => open ? React.createElement('div', {}, children) : null;
              Modal.Content = tag('div');
              exports.Modal = Modal;
              exports.TextInput = () => null;
              exports.Platform = { OS: 'ios', select: (spec) => spec.ios ?? spec.default };
            `,
          }));
        },
      },
    ],
  });
  const mod = { exports: {} as Exports };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), mod, mod.exports);
  const { ProjectPanel } = mod.exports;
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));

  const canaryLight = {
    colors: {
      surface0: "#ffffff", surface1: "#f5f5f5", surface2: "#eeeeee", foreground: "#111111", foregroundMuted: "#555555",
      border: "#cccccc", accent: "#ff00fe", statusSuccess: "#01ff02", statusWarning: "#fffe01", statusDanger: "#ff0101",
    },
  };
  const canaryDark = {
    colors: {
      ...canaryLight.colors,
      surface0: "#0d1117", surface1: "#161b22", surface2: "#21262d", foreground: "#f0f6fc", foregroundMuted: "#8b949e", border: "#30363d",
    },
  };
  const expectedLight = { wait: "#8f6802", bad: "#c8253d", ok: "#337e58", idle: "#677176" };
  const expectedDark = { wait: "#cd9a22", bad: "#fe5462", ok: "#68b78d", idle: "#6c767b" };

  for (const [label, t, pal] of [["light", canaryLight, expectedLight], ["dark", canaryDark, expectedDark]] as const) {
    for (const status of ["pending", "applying", "failed"] as const) {
      const dom = new JSDOM("<!doctype html><div id=root></div>");
      const g = globalThis as Record<string, any>;
      const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
      g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
      const { createRoot } = await import("react-dom/client");
      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      try {
        const item = makeSetupProposalItem({
          status,
          actions: [
            { label: "Install factory-release-lab", status: status === "failed" ? "done" : "pending" },
            { label: "Enable GitHub Helper MCP", machineWide: true, status: status === "failed" ? "failed" : "pending", ...(status === "failed" ? { error: "failed step" } : {}) },
          ],
          warnings: ["Missing Vault keys"],
        });
        await act(() =>
          root.render(
            createElement(ProjectPanel, {
              theme: t,
              width: 900,
              mobile: false,
              now: Date.now(),
              daemonError: null,
              panel: makePanel({ needsYou: [item] }),
              actions: { ...noopActions(), approveSetupProposal() {}, declineSetupProposal() {}, dismissSetupProposal() {} },
            }),
          ),
        );
        const cardHtml = container.querySelector('[data-testid="factory-setup-proposal"]')!.outerHTML.toLowerCase();
        for (const forbidden of ["#ff00fe", "#01ff02", "#fffe01", "#ff0101"]) {
          assert.equal(cardHtml.includes(forbidden), false, `${label} (${status}) must never leak host colour ${forbidden}`);
        }
        const expectedTone = status === "failed" ? pal.bad : pal.wait;
        assert.ok(cardHtml.includes(expectedTone), `${label} (${status}) uses ${expectedTone}`);
        if (status !== "failed") {
          assert.equal(cardHtml.includes(pal.bad), false, `${label} (${status}) does not use bad colour`);
        }
      } finally {
        await act(() => root.unmount());
        Object.assign(g, saved);
        dom.window.close();
      }
    }
  }
});

test("Wave 3b: Desktop HITL controls render Approve/Decline, Applying…, Retry/Dismiss, enforce busy lock, and pass proposalId + actionsHash", async () => {
  const { ProjectPanel } = await loadPanel();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));

  const mount = async (status: "pending" | "applying" | "failed", busy: boolean, width = 900) => {
    const dom = new JSDOM("<!doctype html><div id=root></div>");
    const g = globalThis as Record<string, any>;
    const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
    g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
    const { createRoot } = await import("react-dom/client");
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    const approveCalls: Array<[string, string]> = [];
    const declineCalls: string[] = [];
    const dismissCalls: string[] = [];
    await act(() =>
      root.render(
        createElement(ProjectPanel, {
          theme,
          width,
          mobile: false,
          now: Date.now(),
          daemonError: null,
          panel: makePanel({ needsYou: [makeSetupProposalItem({ status })] }),
          actions: {
            ...noopActions(),
            busy,
            approveSetupProposal: (id: string, hash: string) => { approveCalls.push([id, hash]); },
            declineSetupProposal: (id: string) => { declineCalls.push(id); },
            dismissSetupProposal: (id: string) => { dismissCalls.push(id); },
          },
        }),
      ),
    );
    const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
    const cleanup = async () => {
      await act(() => root.unmount());
      Object.assign(g, saved);
      dom.window.close();
    };
    return { byId, approveCalls, declineCalls, dismissCalls, cleanup };
  };

  // Pending (wide & narrow)
  for (const w of [900, 420]) {
    const m = await mount("pending", false, w);
    try {
      const approve = m.byId("factory-setup-proposal-approve")!;
      const decline = m.byId("factory-setup-proposal-decline")!;
      assert.ok(approve && decline);
      assert.equal(m.byId("factory-setup-proposal-retry"), null);
      assert.equal(m.byId("factory-setup-proposal-dismiss"), null);
      assert.equal(approve.disabled, false);
      assert.equal(decline.disabled, false);
      assert.equal(approve.textContent, "Approve & Apply");
      assert.equal(decline.textContent, "Decline");
      await act(() => approve.click());
      await act(() => decline.click());
      assert.deepEqual(m.approveCalls, [["prop-1", "hash-abc123"]]);
      assert.deepEqual(m.declineCalls, ["prop-1"]);
    } finally {
      await m.cleanup();
    }
  }

  // Applying status
  {
    const m = await mount("applying", false);
    try {
      const approve = m.byId("factory-setup-proposal-approve")!;
      assert.ok(approve);
      assert.equal(approve.disabled, true);
      assert.equal(approve.textContent, "Applying…");
      assert.equal(m.byId("factory-setup-proposal-decline"), null);
      assert.equal(m.byId("factory-setup-proposal-retry"), null);
      assert.equal(m.byId("factory-setup-proposal-dismiss"), null);
      await act(() => approve.click());
      assert.deepEqual(m.approveCalls, []);
    } finally {
      await m.cleanup();
    }
  }

  // Pending while actions.busy === true
  {
    const m = await mount("pending", true);
    try {
      const approve = m.byId("factory-setup-proposal-approve")!;
      const decline = m.byId("factory-setup-proposal-decline")!;
      assert.equal(approve.disabled, true);
      assert.equal(approve.textContent, "Applying…");
      assert.equal(decline.disabled, true);
      await act(() => approve.click());
      await act(() => decline.click());
      assert.deepEqual(m.approveCalls, []);
      assert.deepEqual(m.declineCalls, []);
    } finally {
      await m.cleanup();
    }
  }

  // Failed (idle)
  {
    const m = await mount("failed", false);
    try {
      const retry = m.byId("factory-setup-proposal-retry")!;
      const dismiss = m.byId("factory-setup-proposal-dismiss")!;
      assert.ok(retry && dismiss);
      assert.equal(m.byId("factory-setup-proposal-approve"), null);
      assert.equal(m.byId("factory-setup-proposal-decline"), null);
      assert.equal(retry.disabled, false);
      assert.equal(dismiss.disabled, false);
      assert.equal(retry.textContent, "Retry");
      assert.equal(dismiss.textContent, "Dismiss");
      await act(() => retry.click());
      await act(() => dismiss.click());
      assert.deepEqual(m.approveCalls, [["prop-1", "hash-abc123"]]);
      assert.deepEqual(m.dismissCalls, ["prop-1"]);
    } finally {
      await m.cleanup();
    }
  }

  // Failed while actions.busy === true
  {
    const m = await mount("failed", true);
    try {
      const retry = m.byId("factory-setup-proposal-retry")!;
      const dismiss = m.byId("factory-setup-proposal-dismiss")!;
      assert.equal(retry.disabled, true);
      assert.equal(retry.textContent, "Applying…");
      assert.equal(dismiss.disabled, true);
      await act(() => retry.click());
      await act(() => dismiss.click());
      assert.deepEqual(m.approveCalls, []);
      assert.deepEqual(m.dismissCalls, []);
    } finally {
      await m.cleanup();
    }
  }
});

test("Wave 3b: Mobile renders Setup Proposal strictly read-only with zero buttons and Desktop hint across all statuses", async () => {
  for (const status of ["pending", "applying", "failed"] as const) {
    const html = await render(
      makePanel({
        needsYou: [
          makeSetupProposalItem({
            status,
            warnings: ["Missing Vault keys: ASC .p8"],
          }),
        ],
      }),
      {
        mobile: true,
        actions: {
          approveSetupProposal() { assert.fail("mobile must never invoke approveSetupProposal"); },
          declineSetupProposal() { assert.fail("mobile must never invoke declineSetupProposal"); },
          dismissSetupProposal() { assert.fail("mobile must never invoke dismissSetupProposal"); },
        },
      },
    );
    const card = elementOf(html, "factory-setup-proposal");
    assert.doesNotMatch(card, /<button/, `mobile (${status}) renders zero <button> elements`);
    for (const hook of [
      "factory-setup-proposal-approve",
      "factory-setup-proposal-decline",
      "factory-setup-proposal-retry",
      "factory-setup-proposal-dismiss",
    ]) {
      assert.equal(hasHook(card, hook), false, `mobile (${status}) hides ${hook}`);
    }
    assert.match(card, /Approve on Paseo Desktop\./);
    assert.match(card, /Enable mobile store staging and GitHub helper MCP\./);
    assert.ok(hasHook(card, "factory-setup-proposal-action-0"));
    assert.match(card, /machine-wide/);
    assert.ok(hasHook(card, "factory-setup-proposal-warning"));
  }
});

test("Wave 3b: FactoryShell wires setupProposalApprove/Decline/Dismiss RPCs with busy lock, toast feedback, stale error recovery, and snapshot refresh", async () => {
  const shellSource = read("plugin/client/factory/shell.tsx");
  for (const rpc of ["setupProposalApprove", "setupProposalDecline", "setupProposalDismiss"]) {
    assert.match(shellSource, new RegExp(`useRpc\\(${rpc}\\)`), `${rpc} is bound in shell.tsx`);
  }
  assert.match(shellSource, /busyCountRef/);
  assert.match(shellSource, /setupProposalBusyRef/);
  assert.match(shellSource, /if \(setupProposalBusyRef\.current\) return;\s*setupProposalBusyRef\.current = true;\s*void act\(name, run\)\.finally\(\(\) => \{\s*setupProposalBusyRef\.current = false;\s*\}\);/);
  assert.match(shellSource, /if \(projectRoot === undefined \|\| mobile\) return;\s*runSetupProposalAct\("Apply Setup Proposal", \(\) => setupProposalApproveCall\(\{ projectRoot, proposalId, actionsHash \}\)\)/);
  assert.match(shellSource, /if \(projectRoot === undefined \|\| mobile\) return;\s*runSetupProposalAct\("Decline Setup Proposal", \(\) => setupProposalDeclineCall\(\{ projectRoot, proposalId \}\)\)/);
  assert.match(shellSource, /if \(projectRoot === undefined \|\| mobile\) return;\s*runSetupProposalAct\("Dismiss Setup Proposal", \(\) => setupProposalDismissCall\(\{ projectRoot, proposalId \}\)\)/);

  const { FactoryShell } = await loadShellForPanelTest();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = {
    window: g.window,
    document: g.document,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    __panelShellRpc: g.__panelShellRpc,
    __panelShellToasts: g.__panelShellToasts,
  };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.__panelShellToasts = [];

  let currentPanel = makePanel({ needsYou: [makeSetupProposalItem({ status: "pending" })] });
  const rpcCalls: Array<{ name: string; input: unknown }> = [];
  let resolveApprove: ((reply: unknown) => void) | null = null;
  let nextDeclineReply: unknown = { ok: true, project: "my-app", projectRoot: "/snapshot-project", proposalId: "prop-1", summary: "Proposal declined." };
  let nextDismissReply: unknown = { ok: true, project: "my-app", projectRoot: "/snapshot-project", proposalId: "prop-1", summary: "Proposal dismissed." };
  let nextRetryReply: unknown = { ok: true, project: "my-app", projectRoot: "/snapshot-project", proposalId: "prop-1", actionsHash: "hash-abc123", applied: true, steps: [], summary: "Setup retried and applied." };

  const buildSnapshotView = () => ({
    version: 5,
    stateDir: "/state",
    generatedAt: new Date().toISOString(),
    lanes: { supervisor: "pi/glm-5.3", lead: "pi/glm-5.3", worker: "pi/glm-5.3", watch: "pi/glm-5.3", freshEyes: "eye.json" },
    machineLanes: { supervisor: "pi/glm-5.3", lead: "pi/glm-5.3", worker: "pi/glm-5.3", watch: "pi/glm-5.3", freshEyes: "eye.json" },
    kpis: { running: 1, needsHuman: currentPanel.needsYou.length, openTasks: 1, greenClaims: 0, redClaims: 0, sessions: 1 },
    agents: [], providers: [], supervisor: null, lead: null, daemonError: null,
    project: { root: "/snapshot-project", slug: "my-app", name: "my-app", missingRoot: false },
    corePlugin: { id: "paseo-factory", title: "Factory Core", status: "running", enabled: true },
    companions: [], companionTools: [], pluginsCheckedAt: null,
    vault: { configured: false, ghAuthenticated: false, historyImports: [], hydratedApps: [] },
    profiles: [], activeProfileId: null, activeProfileModified: false, hasProjectLaneOverride: false,
    skillHub: { skillPacksExplicit: false, projectPacks: [] },
    panel: structuredClone(currentPanel),
  });

  g.__panelShellRpc = async (name: string, input: unknown) => {
    rpcCalls.push({ name, input });
    if (name === "factory.snapshot") return { ok: true, view: buildSnapshotView() };
    if (name === "factory.self.update.status") return { ok: true, current: "0.23.0", latest: "0.23.0", updateAvailable: false };
    if (name === "factory.setup_proposal.approve") {
      if (resolveApprove !== null || currentPanel.needsYou[0]?.setupProposal?.status === "pending") {
        return await new Promise((resolve) => { resolveApprove = resolve; });
      }
      currentPanel = makePanel({ needsYou: [] });
      return nextRetryReply;
    }
    if (name === "factory.setup_proposal.decline") {
      currentPanel = makePanel({ needsYou: [] });
      return nextDeclineReply;
    }
    if (name === "factory.setup_proposal.dismiss") {
      currentPanel = makePanel({ needsYou: [] });
      return nextDismissReply;
    }
    return { ok: true };
  };

  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;

  try {
    await act(async () => {
      root.render(createElement(FactoryShell, { theme, dir: "/snapshot-project", layout: { compact: false, platform: "web" } }));
      await new Promise<void>((r) => setTimeout(r, 15));
    });

    // 1. Stale/error approve reply re-enables buttons and shows error toast.
    await act(async () => { byId("factory-setup-proposal-approve")!.click(); });
    assert.equal(byId("factory-setup-proposal-approve")!.disabled, true);
    assert.equal(byId("factory-setup-proposal-approve")!.textContent, "Applying…");
    // Second click while in-flight must not send a duplicate RPC.
    await act(async () => { byId("factory-setup-proposal-approve")!.click(); });
    assert.equal(rpcCalls.filter((c) => c.name === "factory.setup_proposal.approve").length, 1);
    assert.deepEqual(rpcCalls.find((c) => c.name === "factory.setup_proposal.approve")?.input, {
      projectRoot: "/snapshot-project",
      proposalId: "prop-1",
      actionsHash: "hash-abc123",
    });

    await act(async () => {
      resolveApprove!({ ok: false, code: "setup-proposal-stale", error: "Proposal superseded" });
      resolveApprove = null;
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.equal(byId("factory-setup-proposal-approve")!.disabled, false);
    assert.ok(g.__panelShellToasts.some((t: any) => t.error === true && String(t.msg).includes("Proposal superseded")));

    // 2. Successful approve clears card after snapshot refresh.
    await act(async () => { byId("factory-setup-proposal-approve")!.click(); });
    await act(async () => {
      currentPanel = makePanel({ needsYou: [] });
      resolveApprove!({ ok: true, project: "my-app", projectRoot: "/snapshot-project", proposalId: "prop-1", actionsHash: "hash-abc123", applied: true, steps: [], summary: "Setup applied." });
      resolveApprove = null;
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.equal(container.querySelector('[data-testid="factory-setup-proposal"]'), null);
    assert.ok(g.__panelShellToasts.some((t: any) => !t.error && String(t.msg).includes("Setup applied.")));

    // 3. Decline flow.
    currentPanel = makePanel({ needsYou: [makeSetupProposalItem({ status: "pending" })] });
    await act(async () => {
      root.render(createElement(FactoryShell, { key: "decline-pass", theme, dir: "/snapshot-project", layout: { compact: false, platform: "web" } }));
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    await act(async () => {
      byId("factory-setup-proposal-decline")!.click();
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.deepEqual(rpcCalls.find((c) => c.name === "factory.setup_proposal.decline")?.input, {
      projectRoot: "/snapshot-project",
      proposalId: "prop-1",
    });
    assert.equal(container.querySelector('[data-testid="factory-setup-proposal"]'), null);

    // 4. Failed proposal Retry & Dismiss flows.
    currentPanel = makePanel({ needsYou: [makeSetupProposalItem({ status: "failed" })] });
    await act(async () => {
      root.render(createElement(FactoryShell, { key: "retry-pass", theme, dir: "/snapshot-project", layout: { compact: false, platform: "web" } }));
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    await act(async () => {
      byId("factory-setup-proposal-retry")!.click();
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.deepEqual(rpcCalls.filter((c) => c.name === "factory.setup_proposal.approve").at(-1)?.input, {
      projectRoot: "/snapshot-project",
      proposalId: "prop-1",
      actionsHash: "hash-abc123",
    });
    assert.equal(container.querySelector('[data-testid="factory-setup-proposal"]'), null);

    currentPanel = makePanel({ needsYou: [makeSetupProposalItem({ status: "failed" })] });
    await act(async () => {
      root.render(createElement(FactoryShell, { key: "dismiss-pass", theme, dir: "/snapshot-project", layout: { compact: false, platform: "web" } }));
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    await act(async () => {
      byId("factory-setup-proposal-dismiss")!.click();
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.deepEqual(rpcCalls.find((c) => c.name === "factory.setup_proposal.dismiss")?.input, {
      projectRoot: "/snapshot-project",
      proposalId: "prop-1",
    });
    assert.equal(container.querySelector('[data-testid="factory-setup-proposal"]'), null);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }
});

test("Wave 3b (Probe 4a): same-tick double-click and cross-button races dispatch 1 RPC, keep Applying… disabled, emit 0 spurious toasts, and release lock on settle/throw", async () => {
  const { FactoryShell } = await loadShellForPanelTest();
  const { createElement, act } = await import("react");
  const { JSDOM } = await import(["jsdom"].join(""));
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, any>;
  const saved = {
    window: g.window,
    document: g.document,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    __panelShellRpc: g.__panelShellRpc,
    __panelShellToasts: g.__panelShellToasts,
  };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.__panelShellToasts = [];

  let currentPanel = makePanel({ needsYou: [makeSetupProposalItem({ id: "p-race", status: "pending" })] });
  const rpcCalls: Array<{ name: string; input: unknown }> = [];
  let pendingApprove: { resolve: (reply: unknown) => void; reject: (err: unknown) => void } | null = null;

  const buildSnapshotView = () => ({
    version: 5,
    stateDir: "/state",
    generatedAt: new Date().toISOString(),
    lanes: { supervisor: "pi/glm-5.3", lead: "pi/glm-5.3", worker: "pi/glm-5.3", watch: "pi/glm-5.3", freshEyes: "eye.json" },
    machineLanes: { supervisor: "pi/glm-5.3", lead: "pi/glm-5.3", worker: "pi/glm-5.3", watch: "pi/glm-5.3", freshEyes: "eye.json" },
    kpis: { running: 1, needsHuman: currentPanel.needsYou.length, openTasks: 1, greenClaims: 0, redClaims: 0, sessions: 1 },
    agents: [], providers: [], supervisor: null, lead: null, daemonError: null,
    project: { root: "/snapshot-project", slug: "app", name: "app", missingRoot: false },
    corePlugin: { id: "paseo-factory", title: "Factory Core", status: "running", enabled: true },
    companions: [], companionTools: [], pluginsCheckedAt: null,
    vault: { configured: false, ghAuthenticated: false, historyImports: [], hydratedApps: [] },
    profiles: [], activeProfileId: null, activeProfileModified: false, hasProjectLaneOverride: false,
    skillHub: { skillPacksExplicit: false, projectPacks: [] },
    panel: structuredClone(currentPanel),
  });

  g.__panelShellRpc = async (name: string, input: unknown) => {
    rpcCalls.push({ name, input });
    if (name === "factory.snapshot") return { ok: true, view: buildSnapshotView() };
    if (name === "factory.self.update.status") return { ok: true, current: "0.23.0", latest: "0.23.0", updateAvailable: false };
    if (name === "factory.setup_proposal.approve") {
      if (pendingApprove !== null) {
        return { ok: false, code: "setup-proposal-busy", error: 'Setup proposal "p-race" is already being applied for app.' };
      }
      return await new Promise((resolve, reject) => {
        pendingApprove = { resolve, reject };
      });
    }
    if (name === "factory.setup_proposal.decline") {
      if (pendingApprove !== null) {
        return { ok: false, code: "setup-proposal-busy", error: 'Setup proposal "p-race" is currently applying for app.' };
      }
      currentPanel = makePanel({ needsYou: [] });
      return { ok: true, project: "app", projectRoot: "/snapshot-project", proposalId: "p-race", summary: "Proposal declined." };
    }
    if (name === "factory.setup_proposal.dismiss") {
      if (pendingApprove !== null) {
        return { ok: false, code: "setup-proposal-busy", error: 'Setup proposal "p-race" is currently applying for app.' };
      }
      currentPanel = makePanel({ needsYou: [] });
      return { ok: true, project: "app", projectRoot: "/snapshot-project", proposalId: "p-race", summary: "Proposal dismissed." };
    }
    return { ok: true };
  };

  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;

  try {
    await act(async () => {
      root.render(createElement(FactoryShell, { theme, dir: "/snapshot-project", layout: { compact: false, platform: "web" } }));
      await new Promise<void>((r) => setTimeout(r, 15));
    });

    // 1. Same-tick double-click on Approve & Apply
    await act(async () => {
      byId("factory-setup-proposal-approve")!.click();
      byId("factory-setup-proposal-approve")!.click();
    });
    assert.equal(rpcCalls.filter((c) => c.name === "factory.setup_proposal.approve").length, 1);
    assert.equal(byId("factory-setup-proposal-approve")!.disabled, true);
    assert.equal(byId("factory-setup-proposal-approve")!.textContent, "Applying…");
    assert.equal(byId("factory-setup-proposal-decline")!.disabled, true);
    assert.equal(g.__panelShellToasts.filter((t: any) => t.error === true).length, 0);

    // Settling Call #1 with a server error releases the lock and re-enables buttons cleanly.
    await act(async () => {
      pendingApprove!.resolve({ ok: false, code: "setup-proposal-stale", error: "Proposal superseded" });
      pendingApprove = null;
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.equal(byId("factory-setup-proposal-approve")!.disabled, false);
    assert.equal(byId("factory-setup-proposal-approve")!.textContent, "Approve & Apply");
    assert.equal(g.__panelShellToasts.filter((t: any) => t.error === true).length, 1);

    // 2. Same-tick cross-button race: Approve & Apply then Decline
    g.__panelShellToasts = [];
    const approveCountBefore = rpcCalls.filter((c) => c.name === "factory.setup_proposal.approve").length;
    await act(async () => {
      byId("factory-setup-proposal-approve")!.click();
      byId("factory-setup-proposal-decline")!.click();
    });
    assert.equal(rpcCalls.filter((c) => c.name === "factory.setup_proposal.approve").length, approveCountBefore + 1);
    assert.equal(rpcCalls.filter((c) => c.name === "factory.setup_proposal.decline").length, 0);
    assert.equal(byId("factory-setup-proposal-approve")!.disabled, true);
    assert.equal(byId("factory-setup-proposal-approve")!.textContent, "Applying…");
    assert.equal(byId("factory-setup-proposal-decline")!.disabled, true);
    assert.equal(g.__panelShellToasts.filter((t: any) => t.error === true).length, 0);

    await act(async () => {
      currentPanel = makePanel({ needsYou: [] });
      pendingApprove!.resolve({ ok: true, project: "app", projectRoot: "/snapshot-project", proposalId: "p-race", actionsHash: "hash-abc123", applied: true, steps: [], summary: "Setup applied." });
      pendingApprove = null;
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.equal(container.querySelector('[data-testid="factory-setup-proposal"]'), null);

    // 3. Same-tick Retry + Dismiss race on failed proposal, plus rejection/throw lock release
    currentPanel = makePanel({ needsYou: [makeSetupProposalItem({ id: "p-race", status: "failed" })] });
    g.__panelShellToasts = [];
    await act(async () => {
      root.render(createElement(FactoryShell, { key: "probe4a-failed", theme, dir: "/snapshot-project", layout: { compact: false, platform: "web" } }));
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    const approveCountBeforeRetry = rpcCalls.filter((c) => c.name === "factory.setup_proposal.approve").length;
    await act(async () => {
      byId("factory-setup-proposal-retry")!.click();
      byId("factory-setup-proposal-dismiss")!.click();
    });
    assert.equal(rpcCalls.filter((c) => c.name === "factory.setup_proposal.approve").length, approveCountBeforeRetry + 1);
    assert.equal(rpcCalls.filter((c) => c.name === "factory.setup_proposal.dismiss").length, 0);
    assert.equal(byId("factory-setup-proposal-retry")!.disabled, true);
    assert.equal(byId("factory-setup-proposal-retry")!.textContent, "Applying…");
    assert.equal(byId("factory-setup-proposal-dismiss")!.disabled, true);
    assert.equal(g.__panelShellToasts.filter((t: any) => t.error === true).length, 0);

    await act(async () => {
      pendingApprove!.reject(new Error("transport dropped"));
      pendingApprove = null;
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.equal(byId("factory-setup-proposal-retry")!.disabled, false);
    assert.equal(byId("factory-setup-proposal-dismiss")!.disabled, false);
    assert.ok(g.__panelShellToasts.some((t: any) => t.error === true && String(t.msg).includes("transport dropped")));

    // Subsequent Dismiss works cleanly after rejection released the ref lock.
    await act(async () => {
      byId("factory-setup-proposal-dismiss")!.click();
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.equal(rpcCalls.filter((c) => c.name === "factory.setup_proposal.dismiss").length, 1);
    assert.equal(container.querySelector('[data-testid="factory-setup-proposal"]'), null);

    // 4. Overlapping non-proposal act() settling early never clears busy while approve is in flight (busyCountRef).
    currentPanel = makePanel({
      needsYou: [
        makeSetupProposalItem({ id: "p-race", status: "pending" }),
        { key: "open-design-broken", kind: "open-design-broken", title: "Open Design link is broken", detail: "Missing design files.", action: { kind: "sync-open-design", label: "Sync again" } },
      ],
    });
    await act(async () => {
      root.render(createElement(FactoryShell, { key: "probe4a-overlap", theme, dir: "/snapshot-project", layout: { compact: false, platform: "web" } }));
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    await act(async () => {
      byId("factory-setup-proposal-approve")!.click();
      byId("factory-panel-needs-you-action-open-design-broken")!.click();
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.equal(byId("factory-setup-proposal-approve")!.disabled, true);
    assert.equal(byId("factory-setup-proposal-approve")!.textContent, "Applying…");
    assert.equal(byId("factory-setup-proposal-decline")!.disabled, true);

    await act(async () => {
      currentPanel = makePanel({ needsYou: [] });
      pendingApprove!.resolve({ ok: true, project: "app", projectRoot: "/snapshot-project", proposalId: "p-race", actionsHash: "hash-abc123", applied: true, steps: [], summary: "Setup applied." });
      pendingApprove = null;
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    assert.equal(container.querySelector('[data-testid="factory-setup-proposal"]'), null);
  } finally {
    await act(() => root.unmount());
    Object.assign(g, saved);
    dom.window.close();
  }
});
