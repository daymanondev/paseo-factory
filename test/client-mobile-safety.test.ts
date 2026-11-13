/**
 * v0.6.0 W0 (ADR 0056): the Factory client mounts on Paseo mobile. React
 * Native's `window` is a bare object with no `addEventListener` and there is
 * no DOM, so client modules that run on mount must treat the host as
 * possibly lacking browser methods. These tests mount the real client modules
 * (bundled from source, native primitives adapted to markup) under a
 * RN-like `window` and assert on what renders and whether mounting throws.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { repoRoot } from "./helpers.ts";

type Exports = Record<string, any>;

/** Bundles one client module with react-native / SDK ui replaced by markup adapters, then evaluates it. */
async function load(entry: string, platformOs = "ios"): Promise<Exports> {
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
              const tag = (name) => ({ children, onPress, disabled, ...rest }) => React.createElement(name, { disabled, onClick: onPress, 'data-testid': rest.testID }, children);
              exports.View = tag('div'); exports.ScrollView = tag('div'); exports.Text = tag('span'); exports.Pressable = tag('button'); exports.TextInput = tag('input');
              exports.Icon = () => null;
              exports.useRpc = contract => input => globalThis.__factoryClientRpc(contract.name, input);
              exports.useToast = () => ({ show() {}, error(message) { globalThis.__factoryClientErrors?.push(message); } });
              exports.Platform = { OS: ${JSON.stringify(platformOs)}, select: (spec) => (spec[${JSON.stringify(platformOs)}] !== undefined ? spec[${JSON.stringify(platformOs)}] : spec.default) };
              exports.DocumentFrame = ({ url }) => React.createElement('section', { 'data-document-frame': url });
              const Modal = ({ children, open }) => (open ? React.createElement('div', null, children) : null);
              Modal.Content = tag('div');
              exports.Modal = Modal;
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

/** A DOM for React's renderer, whose `window` is then made RN-like: no event APIs, no document. */
async function mountUnderNativeWindow<T>(run: (render: typeof import("react-dom/client").createRoot, container: HTMLElement, act: (fn: () => void | Promise<void>) => Promise<void>) => Promise<T>): Promise<T> {
  // jsdom ships no types in this repo; it only stands in for the DOM React's renderer needs.
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  try {
    return await run(createRoot, dom.window.document.getElementById("root")!, (fn) => act(async () => { await fn(); }));
  } finally {
    g.window = saved.window; g.document = saved.document; g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
}

/** React Native's window: no addEventListener / removeEventListener / dispatchEvent, and no `document` global. */
function goNative() {
  const w = (globalThis as Record<string, any>).window;
  for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) Object.defineProperty(w, key, { value: undefined, configurable: true, writable: true });
  delete (globalThis as Record<string, unknown>).document;
}

test("usePoll mounts and unmounts under a RN-like window that has no addEventListener", async () => {
  const { usePoll } = await load("plugin/client/kit/poll.ts");
  const { createElement } = await import("react");
  let seen: { value: string | null } = { value: null };
  const Probe = () => { seen = usePoll(async () => ({ ok: true as const, value: "view" }), "key", () => 30000); return null; };
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    goNative();
    await act(() => root.render(createElement(Probe)));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    assert.equal(seen.value, "view", "the poll still loads the first view without the focus listener");
    await act(() => root.unmount());
  });
});

test("StudioRelay mounts under a RN-like window and renders the SDK DocumentFrame, never a DOM iframe", async () => {
  const { StudioRelay } = await load("plugin/client/factory/studio-relay.tsx");
  const { createElement } = await import("react");
  const theme = { colors: { surface0: "#fff", surface1: "#fff", surface2: "#fff", foreground: "#111", foregroundMuted: "#555", accent: "#35a", border: "#ccc", statusSuccess: "#272", statusWarning: "#860", statusDanger: "#a33" } };
  const bundle = { studioHtml: "<p>Studio</p>", model: { revision: 1, runId: "r", design: { revision: 1, digest: "d" } } };
  const html = await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    goNative();
    await act(() => root.render(createElement(StudioRelay, { theme, bundle, close() {} })));
    const markup = container.innerHTML;
    await act(() => root.unmount());
    return markup;
  });
  assert.match(html, /data-document-frame="data:text\/html/, "Studio renders through DocumentFrame on a document URL");
  assert.doesNotMatch(html, /<iframe|<img/, "no DOM iframe or img element is created");
});

test("the Project panel mounts under a RN-like window on mobile and renders the no-supervisor item with the adopt button — the one seat write mobile allows (03, ADR 0057 §5/§10)", async () => {
  const { ProjectPanel } = await load("plugin/client/factory/project-panel.tsx");
  const { createElement } = await import("react");
  const theme = { colors: { surface0: "#fff", surface1: "#fff", surface2: "#fff", foreground: "#111", foregroundMuted: "#555", accent: "#35a", border: "#ccc", statusSuccess: "#272", statusWarning: "#860", statusDanger: "#a33" } };
  const seatDefaults = { lane: { provider: "pi", model: "glm-5.3", scope: "machine" }, pendingLane: null, markTokens: 128000, allowedActions: ["switch-model", "hand-off-now"] };
  const panel = {
    handoffs: [], profile: { active: null, list: [], modified: false }, defaultWorker: null,
    isProject: true,
    name: "my-app",
    summary: "Lead idle · 1 needs you",
    needsYou: [{ key: "no-supervisor", kind: "no-supervisor", title: "No Supervisor · 2 reports waiting", detail: null, action: { kind: "start-supervisor", label: "Start Supervisor" } }],
    seats: {
      supervisor: { ...seatDefaults, role: "supervisor", vacant: true, agentId: null, statusLabel: "vacant", tone: "normal", model: null, hint: null, context: null, handoff: null },
      lead: { ...seatDefaults, role: "lead", vacant: false, agentId: "agent-lead", statusLabel: "idle", tone: "normal", model: "glm-5.3", hint: null, context: null, handoff: null },
      peers: [],
      supervisorCandidates: [{ agentId: "agent-candidate", title: "Chat about release", statusLabel: "idle", tone: "normal", model: "glm-5.3" }],
    },
    openDesign: null,
    onboarding: null,
  };
  const html = await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    goNative();
    await act(() => root.render(createElement(ProjectPanel, {
      theme, panel, mobile: true, now: Date.now(), daemonError: null,
      actions: { openAgent() {}, installPrerequisites() {}, handoffStart() {}, handoffReplaceNow() {}, handoffCancel() {}, handoffRetry() {}, viewHandover() {}, startSupervisor() {}, syncOpenDesign() {}, adoptSupervisor() {}, busy: false },
    })));
    const markup = container.innerHTML;
    await act(() => root.unmount());
    return markup;
  });
  assert.match(html, /No Supervisor · 2 reports waiting/, "the no-supervisor item renders on a RN-like window");
  assert.match(html, /data-testid="factory-panel-adopt-supervisor"/, "the adopt button renders on mobile");
  assert.match(html, /Use this chat as Supervisor/);
  assert.doesNotMatch(html, /data-testid="factory-panel-start-supervisor"/, "Start Supervisor stays desktop-only on mobile");
});

test("the code text role carries a font family iOS ships, not the bare 'monospace' keyword", async () => {
  const ios = await load("plugin/client/kit/theme.ts", "ios");
  const android = await load("plugin/client/kit/theme.ts", "android");
  const theme = { colors: { foreground: "#111", foregroundMuted: "#555" } };
  assert.equal(ios.text(theme, "code").fontFamily, "Menlo");
  assert.equal(android.text(theme, "code").fontFamily, "monospace");
});

test("W10: directory reconciles headers and pills independently, dedupes warnings and retains surfaces on failed polls", async () => {
  const { startSeatDirectory } = await load("plugin/client/factory/directory.tsx");
  const savedInterval = globalThis.setInterval;
  const savedClear = globalThis.clearInterval;
  const savedWarn = console.warn;
  const warnings: string[] = [];
  let poll: (() => void) | undefined;
  let failHeader = true, failPill = false;
  let reply: any = { ok: true, daemonError: null, projects: [{ slug: "app", workspaceId: "wks_root", needsYouCount: 0 }], seats: [{ agentId: "agent_1", workspaceId: "wks_root", role: "lead", model: "one" }] };
  const headers: string[] = [], pills: string[] = [], removed: string[] = [];
  globalThis.setInterval = ((fn: () => void) => { poll = fn; return 1; }) as any;
  globalThis.clearInterval = (() => {}) as any;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
  let stop = () => {};
  try {
    stop = startSeatDirectory({
      rpc: async () => reply,
      addHeaderButton: ({ id }: any) => { if (failHeader) throw new Error("renderer refused"); headers.push(id); return { update() {}, remove() { removed.push(id); } }; },
      addComposerPill: ({ id }: any) => { if (failPill) throw new Error("renderer refused"); pills.push(id); return { update() { if (failPill) throw new Error("renderer refused"); }, remove() { removed.push(id); } }; },
    });
    await flush();
    assert.deepEqual(pills, ["factory-pill-agent-1"], "header failure cannot hide the pill");
    poll!(); await flush();
    assert.equal(warnings.length, 1, "the same header failure warns once");
    failHeader = false; failPill = true;
    reply = { ...reply, seats: [{ ...reply.seats[0], model: "two" }] };
    poll!(); await flush();
    assert.deepEqual(headers, ["factory-header-wks-root"], "pill failure cannot hide the header");
    assert.equal(warnings.length, 2, "the same message on another surface warns independently");
    reply = { ok: true, daemonError: "daemon unavailable", projects: [], seats: [] };
    poll!(); await flush();
    assert.deepEqual(removed, [], "an ok transport with daemonError is a failed directory poll");
    reply = { ok: false, error: "poll unavailable" };
    poll!(); await flush();
    assert.deepEqual(removed, []);
    reply = { ok: true, daemonError: null, projects: [], seats: [] };
    poll!(); await flush();
    assert.equal(removed.length, 2, "only a successful empty directory removes registrations");
  } finally { stop(); globalThis.setInterval = savedInterval; globalThis.clearInterval = savedClear; console.warn = savedWarn; }
});

test("W10: a descendant render throw shows the tab fallback with the section and logs the error", async () => {
  const { FactoryTabErrorBoundary } = await load("plugin/client/factory/tab-error-boundary.tsx");
  const { createElement } = await import("react");
  const theme = { colors: { foreground: "#111", statusDanger: "#c8253d" } };
  const ThrowingChild = () => { throw new Error("seat renderer failed"); };
  const savedError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args) => { errors.push(args); };
  try {
    await mountUnderNativeWindow(async (createRoot, container, act) => {
      const root = createRoot(container);
      goNative();
      await act(() => root.render(createElement(FactoryTabErrorBoundary, { theme, section: "Seats" }, createElement(ThrowingChild))));
      assert.match(container.innerHTML, /factory-tab-error/);
      assert.match(container.textContent!, /Seats/);
      assert.match(container.textContent!, /seat renderer failed/);
      assert.ok(errors.some((args) => args.some((x) => String(x).includes("Factory tab: Seats"))), "the plugin boundary itself logs the failing section");
      await act(() => root.unmount());
    });
  } finally { console.error = savedError; }
});


/** The Owner's fresh-tab model controls; the lane table intentionally differs from live lanes. */
function modelPanelFixture(): any {
  const lane = { provider: "codex", model: "gpt-live", thinking: "high", scope: "machine" };
  const row = { lane, pendingLane: null, markTokens: 128000, allowedActions: ["switch-model", "hand-off-now"], vacant: false, statusLabel: "idle", tone: "normal", model: "gpt-live", hint: null, context: null, handoff: null };
  return {
    handoffs: [], profile: { active: null, list: [{ id: "balanced", name: "Balanced" }], modified: false }, defaultWorker: { role: "worker", title: "Default worker", lane },
    isProject: true, name: "my-app", summary: "Ready", needsYou: [],
    seats: { supervisor: { ...row, role: "supervisor", vacant: true, agentId: null, allowedActions: [] }, lead: { ...row, role: "lead", agentId: "lead" }, peers: [{ ...row, task: "task-1", title: "Build it", agentId: "peer", disposition: "implementation", context: { state: "unknown", usedTokens: null, markTokens: 128000, fraction: null, label: "Context unknown" } }], supervisorCandidates: [] },
    openDesign: null, onboarding: null,
  };
}
const modelPickerFixture = {
  lanes: { supervisor: "claude/configured", lead: "claude/configured", worker: "codex/gpt-live", watch: "codex/gpt-live", freshEyes: "codex/gpt-live" },
  providers: [
    { provider: "codex", available: true, models: [{ id: "gpt-live", label: "GPT live", thinkingOptions: [{ id: "high", label: "High" }], defaultThinkingOptionId: "high" }, { id: "gpt-next", label: "GPT next", thinkingOptions: [] }] },
    { provider: "claude", available: true, models: [{ id: "opus", label: "Opus", thinkingOptions: [] }] },
  ],
};
const modelPanelActions = { openAgent() {}, installPrerequisites() {}, handoffStart() {}, handoffReplaceNow() {}, handoffCancel() {}, handoffRetry() {}, viewHandover() {}, startSupervisor() {}, syncOpenDesign() {}, adoptSupervisor() {}, busy: false };

test("W11: one tap on every fresh-tab model chip opens the inline picker, including vacant standing seats", async () => {
  const { ProjectPanel } = await load("plugin/client/factory/project-panel.tsx");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    const panel = modelPanelFixture();
    for (const vacant of [true, false]) {
      panel.seats.supervisor.vacant = vacant;
      panel.seats.supervisor.agentId = vacant ? null : "supervisor";
      panel.seats.supervisor.allowedActions = vacant ? [] : ["switch-model", "hand-off-now"];
      panel.seats.lead.vacant = vacant;
      panel.seats.lead.agentId = vacant ? null : "lead";
      panel.seats.lead.allowedActions = vacant ? [] : ["switch-model", "hand-off-now"];
      for (const seat of ["supervisor", "lead", "peer-task-1", "worker"]) {
        await act(() => root.render(createElement(ProjectPanel, { key: `${vacant}-${seat}`, theme: testTheme, panel, modelView: modelPickerFixture, mobile: false, now: Date.now(), daemonError: null, actions: { ...modelPanelActions, saveSeatModel() {}, setMachineDefault() {} } })));
        const chip = container.querySelector(`[data-testid="factory-seat-chip-${seat}"]`);
        assert.equal(chip?.tagName, "BUTTON", `${seat} is editable on the fresh tab`);
        await act(() => (chip as HTMLElement).click());
        const editor = container.querySelector('[data-testid="factory-chip-editor"]');
        assert.ok(editor, `${seat} opens inline in one tap`);
        assert.match(editor.textContent!, /gpt-live/, "the picker starts from the displayed seat lane");
        assert.ok(container.querySelector('[data-testid="factory-chip-editor-machine-default"]'));
      }
    }
    await act(() => root.unmount());
  });
});


test("W11: the tab saves standing models in Project scope, Peer choices through handoff, and explicit machine defaults separately", async () => {
  const { FactoryShell } = await load("plugin/client/factory/shell.tsx");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const calls: { method: string; input: any }[] = [];
  const errors: string[] = [];
  let refuse = false;
  const panel = modelPanelFixture();
  panel.seats.supervisor.vacant = false; panel.seats.supervisor.agentId = "supervisor"; panel.seats.supervisor.allowedActions = ["switch-model"];
  const view = { ...modelPickerFixture, panel, project: { root: "/project", slug: "my-app", missingRoot: true }, kpis: { running: 0, needsHuman: 0 }, companionTools: [], corePlugin: {}, vault: {}, skillHub: { projectPacks: [{ id: "expo", label: "Expo", enabled: false, autoDetected: false }] }, daemonError: null };
  const globals = globalThis as Record<string, any>;
  const prior = globals.__factoryClientRpc;
  const priorErrors = globals.__factoryClientErrors;
  globals.__factoryClientErrors = errors;
  globals.__factoryClientRpc = async (method: string, input: any) => {
    calls.push({ method, input });
    if (method === "factory.snapshot") return { ok: true, view };
    if (refuse) return { ok: false, code: "MODEL_UNAVAILABLE", error: "Model unavailable" };
    if (method === "factory.skills.toggle_pack") view.skillHub.projectPacks[0]!.enabled = input.enabled;
    if (method === "factory.profiles.apply") view.panel.profile.active = { id: "balanced", name: "Balanced" };
    return { ok: true };
  };
  const cases = [
    { seat: "supervisor", provider: "codex", modelLabel: "GPT next", button: "Switch model", method: "factory.lanes.set", input: { projectRoot: "/project", lane: "supervisor", value: "codex/gpt-next" } },
    { seat: "lead", provider: "claude", button: "Hand off to claude", method: "factory.lanes.set", input: { projectRoot: "/project", lane: "lead", value: "claude/opus" } },
    { seat: "peer-task-1", provider: "codex", button: "Hand off to codex", method: "factory.handoff.start", input: { projectRoot: "/project", seat: "peer:task-1", lane: "codex/gpt-live:high" } },
    { seat: "peer-task-1", provider: "claude", button: "Hand off to claude", method: "factory.handoff.start", input: { projectRoot: "/project", seat: "peer:task-1", lane: "claude/opus" } },
    { seat: "worker", provider: "claude", button: "Save Default worker", method: "factory.lanes.set", input: { projectRoot: "/project", lane: "worker", value: "claude/opus" } },
  ];
  try {
    await mountUnderNativeWindow(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
      await act(() => root.render(createElement(FactoryShell, { theme: testTheme, dir: "/project", layout: { compact: false, platform: "web" } })));
      const click = async (id: string) => { const button = container.querySelector(`[data-testid="${id}"]`) as HTMLElement; assert.ok(button, id); await act(() => button.click()); };
      for (const sample of cases) {
        await click(`factory-seat-chip-${sample.seat}`);
        const editor = container.querySelector('[data-testid="factory-chip-editor"]')!;
        if (sample.provider === "claude") {
          const provider = [...editor.querySelectorAll("button")].find(b => b.textContent?.startsWith("claude"))!;
          await act(() => provider.click());
        }
        if (sample.modelLabel) {
          const model = [...editor.querySelectorAll("button")].find(b => b.textContent?.startsWith(sample.modelLabel!))!;
          await act(() => model.click());
        }
        assert.equal(container.querySelector('[data-testid="factory-chip-editor-primary"]')?.textContent, sample.button);
        const before = calls.filter(c => c.method === "factory.snapshot").length;
        await click("factory-chip-editor-primary");
        assert.deepEqual(calls.filter(c => c.method !== "factory.snapshot").at(-1), { method: sample.method, input: sample.input });
        assert.ok(calls.filter(c => c.method === "factory.snapshot").length > before, "every save refreshes the snapshot");
        assert.equal(container.querySelector('[data-testid="factory-chip-editor"]'), null, "no confirmation step follows the labelled action");
      }
      refuse = true;
      await click("factory-seat-chip-lead");
      await click("factory-chip-editor-primary");
      assert.ok(container.querySelector('[data-testid="factory-chip-editor"]'), "a refused save keeps the selection open for retry");
      assert.match(errors.at(-1)!, /Model unavailable/);
      refuse = false;
      await click("factory-chip-editor-machine-default");
      assert.deepEqual(calls.filter(c => c.method !== "factory.snapshot").at(-1), { method: "factory.lanes.set", input: { lane: "lead", value: "codex/gpt-live:high" } });
      await click("factory-profile-chip");
      await click("factory-profile-apply-balanced");
      assert.deepEqual(calls.filter(c => c.method !== "factory.snapshot").at(-1), { method: "factory.profiles.apply", input: { projectRoot: "/project", profileId: "balanced" } });
      assert.equal(container.querySelector('[data-testid="factory-profile-chip"]')?.textContent, "Balanced", "the refreshed profile is visible");
      await click("factory-skill-pack-expo");
      assert.deepEqual(calls.filter(c => c.method !== "factory.snapshot").at(-1), { method: "factory.skills.toggle_pack", input: { projectRoot: "/project", pack: "expo", enabled: true } });
      assert.match(container.querySelector('[data-testid="factory-skill-pack-expo"]')?.textContent ?? "", /Disable Expo/, "the refreshed enabled pack is visible");
      await click("factory-skill-pack-expo");
      assert.deepEqual(calls.filter(c => c.method !== "factory.snapshot").at(-1), { method: "factory.skills.toggle_pack", input: { projectRoot: "/project", pack: "expo", enabled: false } });
      } finally { await act(() => root.unmount()); }
    });
  } finally { globals.__factoryClientRpc = prior; globals.__factoryClientErrors = priorErrors; }
});


test("W11: mobile keeps every model chip editable and excludes machine-default, profile and skill-pack writes", async () => {
  const { ProjectPanel } = await load("plugin/client/factory/project-panel.tsx");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const saved: unknown[] = [];
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      for (const seat of ["supervisor", "lead", "peer-task-1", "worker"]) {
        await act(() => root.render(createElement(ProjectPanel, { key: seat, theme: testTheme, panel: modelPanelFixture(), modelView: modelPickerFixture, mobile: true, now: Date.now(), daemonError: null, skillPacks: [{ id: "expo", label: "Expo", enabled: false }], actions: { ...modelPanelActions, saveSeatModel: (target: string, value: string) => { saved.push({ target, value }); }, setMachineDefault() { assert.fail("mobile machine write"); }, applyProfile() { assert.fail("mobile profile write"); }, toggleSkillPack() { assert.fail("mobile pack write"); } } })));
        await act(() => (container.querySelector(`[data-testid="factory-seat-chip-${seat}"]`) as HTMLElement).click());
        assert.ok(container.querySelector('[data-testid="factory-chip-editor"]'));
        assert.equal(container.querySelector('[data-testid="factory-chip-editor-machine-default"]'), null);
        assert.notEqual(container.querySelector('[data-testid="factory-profile-chip"]')?.tagName, "BUTTON");
        assert.equal(container.querySelector('[data-testid="factory-profile-chip-menu"]'), null);
        assert.equal(container.querySelector('[data-testid="factory-skill-pack-expo"]'), null);
        await act(() => (container.querySelector('[data-testid="factory-chip-editor-primary"]') as HTMLElement).click());
      }
      assert.deepEqual(saved, [
        { target: "supervisor", value: "codex/gpt-live:high" }, { target: "lead", value: "codex/gpt-live:high" },
        { target: "peer:task-1", value: "codex/gpt-live:high" }, { target: "worker", value: "codex/gpt-live:high" },
      ]);
    } finally { await act(() => root.unmount()); }
  });
});

test('W12: handoff actions dispatch the typed RPC, refresh progress and open the sourced handover', async () => {
  const { FactoryShell } = await load('plugin/client/factory/shell.tsx');
  const { testTheme } = await import('./client-markup.ts');
  const { createElement } = await import('react');
  const panel = modelPanelFixture();
  const progress = { seat: 'lead', reason: 'provider-change', state: 'scheduled', allowedActions: ['cancel', 'hand-off-now'], waitingPeers: 2, fromLane: { provider: 'pi', model: 'old' }, toLane: { provider: 'codex', model: 'new' }, startedAt: '', updatedAt: '' };
  panel.handoffs = [progress, { ...progress, seat: 'peer:gone', state: 'failed', allowedActions: ['retry', 'replace-now'], failure: 'Provider unavailable' }];
  panel.seats.supervisor.vacant = false; panel.seats.supervisor.agentId = 'supervisor'; panel.seats.supervisor.allowedActions = ['hand-off-now'];
  panel.needsYou = [{ key: 'mark', kind: 'supervisor-near-mark', title: 'Supervisor is near its mark', detail: null, action: { kind: 'handoff-supervisor', label: 'Hand off now' } }, { key: 'failed-peer', kind: 'handoff-failed', title: 'Peer failed', detail: null, action: { kind: 'retry-handoff', seat: 'peer:gone', label: 'Try again' } }];
  const view = { ...modelPickerFixture, panel, project: { root: '/project', slug: 'my-app', missingRoot: true }, kpis: { running: 0, needsHuman: 0 }, companionTools: [], corePlugin: {}, vault: {}, skillHub: { projectPacks: [] }, daemonError: null };
  const calls: { method: string; input: unknown }[] = [];
  const g = globalThis as Record<string, any>, prior = g.__factoryClientRpc;
  g.__factoryClientRpc = async (method: string, input: any) => {
    calls.push({ method, input });
    if (method === 'factory.snapshot') return { ok: true, view: structuredClone(view) };
    if (method === 'factory.handoff.handover') return { ok: true, progress: null, text: 'Keep the Owner goals and the held reports.', source: 'substitute' };
    if (input.seat === 'lead' && method === 'factory.handoff.start') panel.handoffs[0] = { ...progress, state: 'handing-over', allowedActions: ['replace-now'] };
    return { ok: true, progress: null };
  };
  try {
    await mountUnderNativeWindow(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
        await act(() => root.render(createElement(FactoryShell, { theme: testTheme, dir: '/project', layout: { compact: false, platform: 'web' } })));
        const click = async (id: string, method: string, seat: string, parent?: string) => {
          const before = calls.filter(c => c.method === 'factory.snapshot').length;
          const scope = parent ? container.querySelector(`[data-testid="${parent}"]`)! : container;
          const button = scope.querySelector(`[data-testid="${id}"]`) as HTMLElement;
          assert.ok(button, id); await act(() => button.click());
          assert.deepEqual(calls.filter(c => c.method !== 'factory.snapshot').at(-1), { method, input: { projectRoot: '/project', seat } });
          assert.ok(calls.filter(c => c.method === 'factory.snapshot').length > before, 'action triggers the next snapshot');
        };
        await click('factory-handoff-cancel', 'factory.handoff.cancel', 'lead');
        await click('factory-handoff-now', 'factory.handoff.start', 'lead');
        assert.match(container.querySelector('[data-testid="factory-handoff-lead"]')!.textContent!, /Handing over/);
        assert.equal(container.querySelector('[data-testid="factory-handoff-lead"] [data-testid="factory-handoff-cancel"]'), null);
        await click('factory-handoff-replace-now', 'factory.handoff.replace.now', 'lead', 'factory-handoff-lead');
        await click('factory-handoff-retry', 'factory.handoff.retry', 'peer:gone', 'factory-handoff-peer:gone');
        await click('factory-handoff-replace-now', 'factory.handoff.replace.now', 'peer:gone', 'factory-handoff-peer:gone');
        await click('factory-seat-hand-off-now-supervisor', 'factory.handoff.start', 'supervisor');
        await click('factory-seat-hand-off-now-peer-task-1', 'factory.handoff.start', 'peer:task-1');
        await click('factory-panel-needs-you-action-mark', 'factory.handoff.start', 'supervisor');
        await click('factory-panel-needs-you-action-failed-peer', 'factory.handoff.retry', 'peer:gone');
        panel.handoffs = [];
        panel.seats.lead.allowedActions = ['view-handover'];
        await act(() => { globalThis.window.dispatchEvent(new globalThis.window.Event('focus')); });
        assert.equal(container.querySelector('[data-testid="factory-handoff-block"]'), null, 'the recent done block has expired');
        await click('factory-seat-view-handover-lead', 'factory.handoff.handover', 'lead');
        const modal = container.querySelector('[data-testid="factory-handover-modal"]');
        assert.ok(modal); assert.match(modal.textContent!, /plugin-built handover/); assert.match(modal.textContent!, /Keep the Owner goals and the held reports/);
      } finally { await act(() => root.unmount()); }
    });
  } finally { g.__factoryClientRpc = prior; }
});


test('W12: a vacant failed handoff obeys the server model permission while an ordinary vacancy stays editable', async () => {
  const { ProjectPanel } = await load('plugin/client/factory/project-panel.tsx');
  const { testTheme } = await import('./client-markup.ts');
  const { createElement } = await import('react');
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      const panel = modelPanelFixture();
      panel.seats.lead.vacant = true; panel.seats.lead.agentId = null; panel.seats.lead.allowedActions = [];
      panel.seats.lead.handoff = { state: 'failed' };
      await act(() => root.render(createElement(ProjectPanel, { theme: testTheme, panel, modelView: modelPickerFixture, mobile: false, now: Date.now(), daemonError: null, actions: { ...modelPanelActions, saveSeatModel() {} } })));
      assert.notEqual(container.querySelector('[data-testid="factory-seat-chip-lead"]')?.tagName, 'BUTTON', 'an active recovery must honor switch-model permission');
      panel.seats.lead.handoff = null;
      await act(() => root.render(createElement(ProjectPanel, { theme: testTheme, panel, modelView: modelPickerFixture, mobile: false, now: Date.now(), daemonError: null, actions: { ...modelPanelActions, saveSeatModel() {} } })));
      assert.equal(container.querySelector('[data-testid="factory-seat-chip-lead"]')?.tagName, 'BUTTON');
    } finally { await act(() => root.unmount()); }
  });
});

test('W12: mobile handoffs expose start, force, cancel and read while excluding both retry doors', async () => {
  const { FactoryShell } = await load('plugin/client/factory/shell.tsx');
  const { testTheme } = await import('./client-markup.ts');
  const { createElement } = await import('react');
  const panel = modelPanelFixture();
  const base = { seat: 'lead', reason: 'owner', state: 'scheduled', fromLane: { provider: 'pi', model: 'old' }, toLane: { provider: 'codex', model: 'new' }, startedAt: '', updatedAt: '' };
  panel.handoffs = [{ ...base, allowedActions: ['cancel', 'hand-off-now'] }, { ...base, seat: 'peer:gone', state: 'failed', allowedActions: ['retry', 'replace-now', 'view-handover'] }];
  panel.needsYou = [{ key: 'failed-peer', kind: 'handoff-failed', title: 'Peer failed', detail: null, action: { kind: 'retry-handoff', seat: 'peer:gone', label: 'Try again' } }];
  const view = { ...modelPickerFixture, panel, project: { root: '/project', slug: 'my-app', missingRoot: true }, kpis: { running: 0, needsHuman: 0 }, companionTools: [], corePlugin: {}, vault: {}, skillHub: { projectPacks: [] }, daemonError: null };
  const calls: { method: string; input: unknown }[] = [];
  const g = globalThis as Record<string, any>, prior = g.__factoryClientRpc;
  g.__factoryClientRpc = async (method: string, input: any) => {
    calls.push({ method, input });
    return method === 'factory.snapshot' ? { ok: true, view } : { ok: true, progress: null, text: 'Extracted goals', source: 'extracted' };
  };
  try {
    await mountUnderNativeWindow(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
        for (const platform of ['ios', 'android']) {
          await act(() => root.render(createElement(FactoryShell, { key: platform, theme: testTheme, dir: '/project', layout: { compact: true, platform } })));
          assert.equal(container.querySelector('[data-testid="factory-handoff-retry"]'), null);
          assert.equal(container.querySelector('[data-testid="factory-panel-needs-you-action-failed-peer"]'), null);
          for (const [id, method, seat] of [
            ['factory-handoff-cancel', 'factory.handoff.cancel', 'lead'],
            ['factory-handoff-now', 'factory.handoff.start', 'lead'],
            ['factory-handoff-replace-now', 'factory.handoff.replace.now', 'peer:gone'],
            ['factory-handoff-view', 'factory.handoff.handover', 'peer:gone'],
          ]) {
            const button = container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
            assert.ok(button); await act(() => button.click());
            assert.deepEqual(calls.filter(c => c.method !== 'factory.snapshot').at(-1), { method, input: { projectRoot: '/project', seat } });
          }
          assert.match(container.querySelector('[data-testid="factory-handover-modal"]')!.textContent!, /Extracted handover.*Extracted goals/);
        }
        assert.equal(calls.some(c => c.method === 'factory.handoff.retry'), false);
      } finally { await act(() => root.unmount()); }
    });
  } finally { g.__factoryClientRpc = prior; }
});
