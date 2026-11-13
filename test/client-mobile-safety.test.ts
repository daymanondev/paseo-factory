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
              // Pressable children may be a render function (Tabs): call it unpressed. Role / label / selected / checked are exposed for tab and switch assertions.
              const tag = (name) => ({ children, onPress, disabled, ...rest }) => React.createElement(name, { disabled, onClick: onPress, 'data-testid': rest.testID, 'data-role': rest.accessibilityRole, 'aria-label': rest.accessibilityLabel, 'data-selected': rest.accessibilityState && rest.accessibilityState.selected !== undefined ? String(rest.accessibilityState.selected) : undefined, 'data-checked': rest.accessibilityState && rest.accessibilityState.checked !== undefined ? String(rest.accessibilityState.checked) : undefined }, typeof children === 'function' ? children({ pressed: false }) : children);
              exports.View = tag('div'); exports.ScrollView = tag('div'); exports.Text = tag('span'); exports.Pressable = tag('button'); exports.TextInput = ({ value, placeholder, onChangeText, ...rest }) => React.createElement('input', { value: value ?? '', placeholder, 'data-testid': rest.testID, onChange: (event) => onChangeText && onChangeText(event.target.value) });
              exports.Icon = () => null;
              exports.useRpc = contract => input => globalThis.__factoryClientRpc(contract.name, input);
              exports.useWorkspace = () => "/project";
              exports.useToast = () => ({ show() {}, error(message) { globalThis.__factoryClientErrors?.push(message); } });
              exports.Platform = { OS: ${JSON.stringify(platformOs)}, select: (spec) => (spec[${JSON.stringify(platformOs)}] !== undefined ? spec[${JSON.stringify(platformOs)}] : spec.default) };
              exports.DocumentFrame = ({ url }) => React.createElement('section', { 'data-document-frame': url });
              const Modal = ({ children, open, title }) => (open ? React.createElement('div', { 'data-modal-title': title }, children) : null);
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

test("the Project panel mounts under a RN-like window on mobile and renders the no-supervisor item with the adopt button (ADR 0057 §5/§10)", async () => {
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
        // The Default worker's chip lives on the Models tab; every seat's on Team.
        await act(() => root.render(createElement(ProjectPanel, { key: `${vacant}-${seat}`, theme: testTheme, panel, modelView: modelPickerFixture, mobile: false, now: Date.now(), daemonError: null, initialUi: { tab: seat === "worker" ? "models" : "team" }, actions: { ...modelPanelActions, saveSeatModel() {}, setMachineDefault() {} } })));
        const chip = container.querySelector(`[data-testid="factory-seat-chip-${seat}"]`);
        assert.equal(chip?.tagName, "BUTTON", `${seat} is editable on the fresh tab`);
        await act(() => (chip as HTMLElement).click());
        const editor = container.querySelector('[data-testid="factory-chip-editor"]');
        assert.ok(editor, `${seat} opens inline in one tap`);
        assert.match(editor.textContent!, /gpt-live/, "the picker starts from the displayed seat lane");
        assert.equal(container.querySelector('[data-testid="factory-chip-editor-machine-default"]'), null, "secondary acts stay behind ⋯ until it is opened");
        await act(() => (container.querySelector('[data-testid="lane-picker-more-toggle"]') as HTMLElement).click());
        assert.ok(container.querySelector('[data-testid="factory-chip-editor-machine-default"]'));
      }
    }
    await act(() => root.unmount());
  });
});

test("model picker hides Factory's role providers, warns on a provider whose models could not be listed, and tucks the custom ID behind a link", async () => {
  const { ProjectPanel } = await load("plugin/client/factory/project-panel.tsx");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const modelView = {
    ...modelPickerFixture,
    providers: [
      ...modelPickerFixture.providers,
      { provider: "antigravity", available: true, models: null },
      { provider: "factory-supervisor", available: true, models: [{ id: "seat", label: null }] },
    ],
  };
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      await act(() => root.render(createElement(ProjectPanel, { theme: testTheme, panel: modelPanelFixture(), modelView, mobile: false, now: Date.now(), daemonError: null, actions: { ...modelPanelActions, saveSeatModel() {} } })));
      await act(() => (container.querySelector('[data-testid="factory-seat-chip-lead"]') as HTMLElement).click());
      const editor = container.querySelector('[data-testid="factory-chip-editor"]')!;
      const buttons = () => [...editor.querySelectorAll("button")].map((b) => b.textContent ?? "");
      await act(() => (editor.querySelector('[data-testid="lane-picker-provider-select"]') as HTMLElement).click());
      assert.ok(!buttons().some((label) => label.startsWith("factory-supervisor")), "role providers are not lane targets");
      assert.equal(editor.querySelector('[data-testid="lane-picker-provider-factory-supervisor"]'), null);
      await act(() => (editor.querySelector('[data-testid="lane-picker-provider-select"]') as HTMLElement).click());
      assert.equal(editor.querySelector('[data-testid="lane-picker-unverified-provider"]'), null);
      assert.equal(editor.querySelector('[data-testid="lane-picker-custom-toggle"]'), null, "a listed model keeps the custom ID behind ⋯");
      await act(() => (editor.querySelector('[data-testid="lane-picker-more-toggle"]') as HTMLElement).click());
      assert.ok(editor.querySelector('[data-testid="lane-picker-custom-toggle"]'), "⋯ holds the custom model ID toggle");
      assert.doesNotMatch(editor.textContent!, /Custom model ID(?!…)/, "the field itself is closed while a list covers it");
      assert.doesNotMatch(editor.textContent!, /thinking: /, "model rows carry no repeated thinking pill");
      await act(() => (editor.querySelector('[data-testid="lane-picker-provider-select"]') as HTMLElement).click());
      await act(() => (editor.querySelector('[data-testid="lane-picker-provider-antigravity"]') as HTMLElement).click());
      assert.ok(editor.querySelector('[data-testid="lane-picker-unverified-provider"]'), "an unlisted provider is flagged before the handoff");
      assert.equal(editor.querySelector('[data-testid="lane-picker-custom-toggle"]'), null, "no list means the custom ID field shows directly");
    } finally { await act(() => root.unmount()); }
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
    { seat: "peer-task-1", provider: "codex", button: "Hand off Peer", method: "factory.handoff.start", input: { projectRoot: "/project", seat: "peer:task-1", lane: "codex/gpt-live:high" } },
    { seat: "peer-task-1", provider: "claude", button: "Hand off Peer", method: "factory.handoff.start", input: { projectRoot: "/project", seat: "peer:task-1", lane: "claude/opus" } },
    { seat: "worker", provider: "claude", button: "Save Default worker", method: "factory.lanes.set", input: { projectRoot: "/project", lane: "worker", value: "claude/opus" } },
    // Value unchanged on a live Lead = rotate: no lane write, a bare handoff start for the seat.
    { seat: "lead", provider: "codex", button: "Hand off to a fresh session", method: "factory.handoff.start", input: { projectRoot: "/project", seat: "lead" } },
  ];
  try {
    await mountUnderNativeWindow(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
      await act(() => root.render(createElement(FactoryShell, { theme: testTheme, dir: "/project", layout: { compact: false, platform: "web" } })));
      const click = async (id: string) => { const button = container.querySelector(`[data-testid="${id}"]`) as HTMLElement; assert.ok(button, id); await act(() => button.click()); };
      for (const sample of cases) {
        await click(`factory-tab-${sample.seat === "worker" ? "models" : "team"}`);
        await click(`factory-seat-chip-${sample.seat}`);
        const editor = container.querySelector('[data-testid="factory-chip-editor"]')!;
        if (sample.provider === "claude") {
          await act(() => (editor.querySelector('[data-testid="lane-picker-provider-select"]') as HTMLElement).click());
          await act(() => (editor.querySelector('[data-testid="lane-picker-provider-claude"]') as HTMLElement).click());
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
      await click("factory-tab-team");
      await click("factory-seat-chip-lead");
      await click("factory-chip-editor-primary");
      assert.ok(container.querySelector('[data-testid="factory-chip-editor"]'), "a refused rotate keeps the modal open for retry");
      // A refused write (a model change) stays open too.
      await click("lane-picker-provider-select");
      await click("lane-picker-provider-claude");
      await click("factory-chip-editor-primary");
      assert.ok(container.querySelector('[data-testid="factory-chip-editor"]'), "a refused save keeps the selection open for retry");
      assert.match(errors.at(-1)!, /Model unavailable/);
      refuse = false;
      await click("lane-picker-more-toggle");
      await click("factory-chip-editor-machine-default");
      assert.deepEqual(calls.filter(c => c.method !== "factory.snapshot").at(-1), { method: "factory.lanes.set", input: { lane: "lead", value: "claude/opus" } });
      // The header chip no longer opens an inline list: it switches to the Models tab, where each profile has an Apply row.
      await click("factory-tab-team");
      await click("factory-profile-chip");
      assert.equal(container.querySelector('[data-testid="factory-tab-models"]')?.getAttribute("data-selected"), "true", "the profile chip switches to the Models tab");
      assert.equal(container.querySelector('[data-testid="factory-profile-chip-menu"]'), null, "the old inline profile list is gone");
      await click("factory-profile-apply-balanced");
      assert.deepEqual(calls.filter(c => c.method !== "factory.snapshot").at(-1), { method: "factory.profiles.apply", input: { projectRoot: "/project", profileId: "balanced" } });
      assert.equal(container.querySelector('[data-testid="factory-profile-chip"]')?.textContent, "Balanced ▾", "the refreshed profile is visible");
      await click("factory-tab-project");
      await click("factory-skill-pack-expo");
      assert.deepEqual(calls.filter(c => c.method !== "factory.snapshot").at(-1), { method: "factory.skills.toggle_pack", input: { projectRoot: "/project", pack: "expo", enabled: true } });
      const pack = container.querySelector('[data-testid="factory-skill-pack-expo"]')!;
      assert.equal(pack.getAttribute("data-role"), "switch");
      assert.equal(pack.getAttribute("data-checked"), "true", "the refreshed enabled pack is a checked switch");
      assert.equal(pack.getAttribute("aria-label"), "Disable Expo");
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
  const rotated: string[] = [];
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      for (const seat of ["supervisor", "lead", "peer-task-1", "worker"]) {
        await act(() => root.render(createElement(ProjectPanel, { key: seat, theme: testTheme, panel: modelPanelFixture(), modelView: modelPickerFixture, mobile: true, now: Date.now(), daemonError: null, initialUi: { tab: seat === "worker" ? "models" : "team" }, skillPacks: [{ id: "expo", label: "Expo", enabled: false }], actions: { ...modelPanelActions, handoffStart: (target: string) => { rotated.push(target); }, saveSeatModel: (target: string, value: string) => { saved.push({ target, value }); }, setMachineDefault() { assert.fail("mobile machine write"); }, applyProfile() { assert.fail("mobile profile write"); }, toggleSkillPack() { assert.fail("mobile pack write"); } } })));
        await act(() => (container.querySelector(`[data-testid="factory-seat-chip-${seat}"]`) as HTMLElement).click());
        assert.ok(container.querySelector('[data-testid="factory-chip-editor"]'));
        assert.equal(container.querySelector('[data-testid="factory-chip-editor-machine-default"]'), null);
        assert.notEqual(container.querySelector('[data-testid="factory-profile-chip"]')?.tagName, "BUTTON");
        assert.equal(container.querySelector('[data-testid="factory-profile-chip-menu"]'), null);
        assert.equal(container.querySelector('[data-testid="factory-skill-pack-expo"]'), null);
        await act(() => (container.querySelector('[data-testid="factory-chip-editor-primary"]') as HTMLElement).click());
      }
      assert.deepEqual(saved, [
        { target: "supervisor", value: "codex/gpt-live:high" },
        { target: "peer:task-1", value: "codex/gpt-live:high" }, { target: "worker", value: "codex/gpt-live:high" },
      ]);
      assert.deepEqual(rotated, ["lead"], "an unchanged live Lead rotates instead of writing a lane");
      // The pack list is read-only on mobile: shown on the Project tab, with no toggle.
      await act(() => root.render(createElement(ProjectPanel, { key: "project", theme: testTheme, panel: modelPanelFixture(), modelView: modelPickerFixture, mobile: true, now: Date.now(), daemonError: null, initialUi: { tab: "project" }, skillPacks: [{ id: "expo", label: "Expo", enabled: false }], actions: { ...modelPanelActions, toggleSkillPack() { assert.fail("mobile pack write"); } } })));
      assert.match(container.querySelector('[data-testid="factory-skill-packs"]')!.textContent!, /Expo/);
      assert.equal(container.querySelector('[data-testid="factory-skill-pack-expo"]'), null);
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
        // The row's Hand off… opens the modal (no RPC yet); its primary then rotates the seat / hands the Peer to a successor.
        const rpcCount = () => calls.filter(c => c.method !== 'factory.snapshot').length;
        const beforeOpen = rpcCount();
        await act(() => (container.querySelector('[data-testid="factory-seat-hand-off-now-supervisor"]') as HTMLElement).click());
        assert.ok(container.querySelector('[data-testid="factory-chip-editor"]'), 'Hand off… opens the seat modal');
        assert.equal(rpcCount(), beforeOpen, 'opening the modal fires nothing');
        await act(() => (container.querySelector('[data-testid="factory-chip-editor-primary"]') as HTMLElement).click());
        assert.deepEqual(calls.filter(c => c.method !== 'factory.snapshot').at(-1), { method: 'factory.handoff.start', input: { projectRoot: '/project', seat: 'supervisor' } });
        assert.equal(container.querySelector('[data-testid="factory-chip-editor"]'), null, 'the modal closes once the handoff starts');
        await act(() => (container.querySelector('[data-testid="factory-seat-hand-off-now-peer-task-1"]') as HTMLElement).click());
        assert.equal(container.querySelector('[data-testid="factory-chip-editor-primary"]')?.textContent, 'Hand off Peer');
        await act(() => (container.querySelector('[data-testid="factory-chip-editor-primary"]') as HTMLElement).click());
        assert.deepEqual(calls.filter(c => c.method !== 'factory.snapshot').at(-1), { method: 'factory.handoff.start', input: { projectRoot: '/project', seat: 'peer:task-1', lane: 'codex/gpt-live:high' } });
        await click('factory-panel-needs-you-action-mark', 'factory.handoff.start', 'supervisor');
        // The Handoff block owns the failed Peer's retry; the matching Needs-you card is deduped away.
        assert.equal(container.querySelector('[data-testid="factory-panel-needs-you-action-failed-peer"]'), null);
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


test("04: the Closed toggle expands and collapses the closed Peers; an editor request switches to the tab holding its chip", async () => {
  const { ProjectPanel } = await load("plugin/client/factory/project-panel.tsx");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const panel = modelPanelFixture();
  panel.seats.peers.push({ ...panel.seats.peers[0], task: "task-old", title: "Old one", agentId: "peer-old", statusLabel: "closed" });
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      const props = { theme: testTheme, panel, modelView: modelPickerFixture, mobile: true, now: Date.now(), daemonError: null, actions: { ...modelPanelActions, saveSeatModel() {} } };
      await act(() => root.render(createElement(ProjectPanel, props)));
      const toggle = () => container.querySelector('[data-testid="factory-panel-peers-closed-toggle"]') as HTMLElement;
      assert.match(toggle().textContent!, /▸ Closed \(1\)/);
      assert.equal(container.querySelector('[data-testid="factory-panel-seat-peer-task-old"]'), null);
      await act(() => toggle().click());
      assert.match(toggle().textContent!, /▾ Closed \(1\)/);
      assert.ok(container.querySelector('[data-testid="factory-panel-peers-closed"] [data-testid="factory-panel-seat-peer-task-old"]'));
      await act(() => toggle().click());
      assert.equal(container.querySelector('[data-testid="factory-panel-peers-closed"]'), null);
      // A request for the Default worker's editor opens on Models; one for a seat returns to Team.
      await act(() => root.render(createElement(ProjectPanel, { ...props, editorRequest: { sequence: 1, target: "worker" } })));
      assert.ok(container.querySelector('[data-testid="factory-tab-body-models"]'));
      assert.ok(container.querySelector('[data-testid="factory-chip-editor"]'), "the worker editor opens");
    } finally { await act(() => root.unmount()); }
  });
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
        for (const [platform, failedSeat] of [['ios', 'lead'], ['android', 'lead'], ['ios', 'peer:gone'], ['android', 'peer:gone']]) {
          const scheduledSeat = failedSeat === 'lead' ? 'supervisor' : 'lead';
          panel.handoffs = [{ ...base, seat: scheduledSeat, allowedActions: ['cancel', 'hand-off-now'] }, { ...base, seat: failedSeat, state: 'failed', allowedActions: ['retry', 'replace-now', 'view-handover'] }];
          await act(() => root.render(createElement(FactoryShell, { key: `${platform}-${failedSeat}`, theme: testTheme, dir: '/project', layout: { compact: true, platform } })));
          assert.equal(container.querySelector('[data-testid="factory-handoff-retry"]'), null);
          assert.equal(container.querySelector('[data-testid="factory-panel-needs-you-action-failed-peer"]'), null);
          for (const [id, method, seat] of [
            ['factory-handoff-cancel', 'factory.handoff.cancel', scheduledSeat],
            ['factory-handoff-now', 'factory.handoff.start', scheduledSeat],
            ['factory-handoff-replace-now', 'factory.handoff.replace.now', failedSeat],
            ['factory-handoff-view', 'factory.handoff.handover', failedSeat],
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

test("W13: pills quick-switch in Project scope, hand off Peers, and respect allowed actions", async () => {
  const { startSeatDirectory } = await load("plugin/client/factory/directory.tsx", "web");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const calls: any[] = [], buttons = new Map<string, any>();
  const base = { slug: "app", workspaceId: "root-ws", role: "lead", provider: "codex", model: "gpt-live", thinking: "high", lane: { provider: "codex", model: "gpt-live", scope: "project" }, context: { label: "Context unknown" }, contextUsedTokens: null, markTokens: 128000, handoffState: null, handoff: null, task: null, allowedActions: ["switch-model", "hand-off-now"], quickSwitchModels: [{ provider: "codex", model: "gpt-next", thinking: "high" }, { provider: "claude", model: "opus" }] };
  const reply = { ok: true, daemonError: null, projects: [{ slug: "app", root: "/project-root", workspaceId: "root-ws", needsYouCount: 0 }], seats: [{ ...base, agentId: "lead" }, { ...base, role: "peer", task: "task-1", agentId: "peer", workspaceId: "worktree-ws" }, { ...base, agentId: "locked", allowedActions: [] }] };
  const stop = startSeatDirectory({ rpc: async (contract: any, input: any) => { if (contract.name === "factory.seats.directory") return reply; calls.push({ method: contract.name, input }); return { ok: true }; }, addHeaderButton: () => ({ update() {}, remove() {} }), addComposerPill: ({ agentId, button }: any) => { buttons.set(agentId, button); return { update() {}, remove() {} }; } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    await mountUnderNativeWindow(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
        for (const role of ["lead", "peer", "locked"]) {
          await act(() => root.render(createElement(buttons.get(role).behavior.Content, { theme: testTheme, host: { id: "server" }, layout: { platform: "web" }, close() {} })));
          if (role === "locked") {
            assert.equal(container.querySelector('[data-testid="factory-pill-model-0"]'), null);
            assert.equal(container.querySelector('[data-testid="factory-pill-hand-off-now"]'), null);
            continue;
          }
          const first = container.querySelector('[data-testid="factory-pill-model-0"]') as HTMLElement;
          assert.ok(first, "quick choice renders");
          assert.match(first.textContent!, role === "peer" ? /Hand off/ : /Switch/);
          await act(() => first.click());
          assert.deepEqual(calls.at(-1), role === "peer" ? { method: "factory.handoff.start", input: { projectRoot: "/project-root", seat: "peer:task-1", lane: "codex/gpt-next:high" } } : { method: "factory.lanes.set", input: { projectRoot: "/project-root", lane: "lead", value: "codex/gpt-next:high" } });
          const cross = container.querySelector('[data-testid="factory-pill-model-1"]') as HTMLElement;
          assert.match(cross.textContent!, /Hand off/);
          await act(() => cross.click());
          assert.deepEqual(calls.at(-1), role === "peer" ? { method: "factory.handoff.start", input: { projectRoot: "/project-root", seat: "peer:task-1", lane: "claude/opus" } } : { method: "factory.lanes.set", input: { projectRoot: "/project-root", lane: "lead", value: "claude/opus" } });
          await act(() => (container.querySelector('[data-testid="factory-pill-hand-off-now"]') as HTMLElement).click());
          assert.deepEqual(calls.at(-1), { method: "factory.handoff.start", input: { projectRoot: "/project-root", seat: role === "peer" ? "peer:task-1" : "lead" } });
        }
      } finally { await act(() => root.unmount()); }
    });
  } finally { stop(); }
});

test("W13: Other model opens the Project root tab and focuses fresh and already-open Peer editors once", async () => {
  const { default: contribute } = await load("plugin/index.client.tsx", "web");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const panel = modelPanelFixture();
  const view = { ...modelPickerFixture, panel, project: { root: "/project", slug: "app", missingRoot: true }, kpis: { running: 0, needsHuman: 0 }, companionTools: [], corePlugin: {}, vault: {}, daemonError: null };
  const prior = (globalThis as any).__factoryClientRpc;
  (globalThis as any).__factoryClientRpc = async () => ({ ok: true, view });
  let Panel: any, pill: any;
  const opens: any[] = [];
  const off = contribute({
    addWorkspacePanel: ({ Component }: any) => { Panel = Component; return () => {}; }, addSettingsScreen: () => () => {}, addCommandCenterItem: () => () => {},
    rpc: async () => ({ ok: true, daemonError: null, projects: [{ slug: "app", root: "/project", workspaceId: "project-root-workspace", needsYouCount: 0 }], seats: [{ slug: "app", workspaceId: "peer-worktree-workspace", agentId: "peer", role: "peer", task: "task-1", provider: "codex", model: "gpt-live", thinking: "high", lane: { provider: "codex", model: "gpt-live" }, quickSwitchModels: [], allowedActions: ["switch-model"], contextUsedTokens: null, markTokens: 128000, handoffState: null }] }),
    addHeaderButton: () => ({ update() {}, remove() {} }), addComposerPill: ({ button }: any) => { pill = button; return { update() {}, remove() {} }; },
    openPanel: (id: string, options: any) => opens.push({ id, options }),
  });
  const props = { theme: testTheme, host: { id: "server-1" }, workspaceId: "project-root-workspace", layout: { compact: false, platform: "web" } };
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    await mountUnderNativeWindow(async (createRoot, container, act) => {
      let root = createRoot(container);
      const popoverContainer = container.ownerDocument.createElement("div");
      const popover = createRoot(popoverContainer);
      try {
        const request = async () => {
          await act(() => popover.render(createElement(pill.behavior.Content, { ...props, close() {} })));
          await act(() => (popoverContainer.querySelector('[data-testid="factory-pill-other-model"]') as HTMLElement).click());
        };
        await request();
        assert.deepEqual(opens.at(-1), { id: "paseo-factory", options: { workspaceId: "project-root-workspace", location: "workspace" } });
        await act(() => root.render(createElement(Panel, props)));
        assert.ok(container.querySelector('[data-testid="factory-chip-editor"]'), "fresh tab opens the requested editor");
        assert.match(container.querySelector('[data-testid="factory-chip-editor"]')!.textContent!, /Peer/);
        await act(() => (container.querySelector('[data-testid="factory-seat-chip-peer-task-1"]') as HTMLElement).click());
        assert.equal(container.querySelector('[data-testid="factory-chip-editor"]'), null);
        await request();
        assert.ok(container.querySelector('[data-testid="factory-chip-editor"]'), "already-open tab sees the next request for the same seat");
        await act(() => (container.querySelector('[data-testid="factory-seat-chip-peer-task-1"]') as HTMLElement).click());
        await act(() => root.render(createElement(Panel, { ...props, revision: 2 })));
        assert.equal(container.querySelector('[data-testid="factory-chip-editor"]'), null, "consumed focus does not reopen on refresh");
        await act(() => root.unmount());
        root = createRoot(container);
        await act(() => root.render(createElement(Panel, props)));
        assert.equal(container.querySelector('[data-testid="factory-chip-editor"]'), null, "consumed request does not reopen a fresh tab later");
      } finally { await act(() => root.unmount()); await act(() => popover.unmount()); }
    });
  } finally { off(); (globalThis as any).__factoryClientRpc = prior; }
});

test("W13: native mobile pills open the owning Project Factory tab directly", async () => {
  for (const platform of ["ios", "android"]) {
    const { startSeatDirectory } = await load("plugin/client/factory/directory.tsx", platform);
    let pill: any;
    const opens: any[] = [];
    const stop = startSeatDirectory({ rpc: async () => ({ ok: true, daemonError: null, projects: [{ slug: "app", root: "/project", workspaceId: "root", needsYouCount: 0 }], seats: [{ slug: "app", workspaceId: "worktree", agentId: "peer", role: "peer", task: "task-1", handoffState: "handing-over" }] }), addHeaderButton: () => ({ update() {}, remove() {} }), addComposerPill: ({ button }: any) => { pill = button; return { update() {}, remove() {} }; }, openPanel: (id: string, options: any) => opens.push({ id, options }) });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(pill.label, "peer · handing off");
      assert.equal(pill.behavior.kind, "action");
      pill.behavior.onPress();
      assert.deepEqual(opens, [{ id: "paseo-factory", options: { workspaceId: "root", location: "workspace" } }]);
    } finally { stop(); }
  }
});

test("W13: the pill bounds quick choices, reports a refused write and never writes without Project scope", async () => {
  const { startSeatDirectory } = await load("plugin/client/factory/directory.tsx", "web");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const buttons = new Map<string, any>();
  const calls: any[] = [];
  const base = { workspaceId: "root", role: "lead", provider: "codex", model: "gpt-live", thinking: "high", lane: { provider: "codex", model: "gpt-live" }, allowedActions: ["switch-model", "hand-off-now"], contextUsedTokens: null, markTokens: 128000, handoffState: "scheduled", quickSwitchModels: Array.from({ length: 8 }, (_, i) => ({ provider: "codex", model: `gpt-${i}` })) };
  const stop = startSeatDirectory({ rpc: async (contract: any, input: any) => { if (contract.name === "factory.seats.directory") return { ok: true, daemonError: null, projects: [{ slug: "app", root: "/project", workspaceId: "root", needsYouCount: 0 }], seats: [{ ...base, slug: "app", agentId: "lead" }, { ...base, slug: "missing-project", agentId: "unknown" }] }; calls.push({ method: contract.name, input }); return { ok: false, error: "Provider unavailable" }; }, addHeaderButton: () => ({ update() {}, remove() {} }), addComposerPill: ({ agentId, button }: any) => { buttons.set(agentId, button); return { update() {}, remove() {} }; } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    await mountUnderNativeWindow(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
        await act(() => root.render(createElement(buttons.get("lead").behavior.Content, { theme: testTheme, layout: { platform: "web" }, close() { assert.fail("a refused write stays open"); } })));
        assert.equal(container.querySelectorAll('[data-testid^="factory-pill-model-"]').length, 6);
        assert.doesNotMatch(container.textContent!, /Context|Project|Role|Thinking/, "the popover carries no status table");
        assert.match(container.textContent!, /Handing over…/, "an in-flight handoff gets one line");
        await act(() => (container.querySelector('[data-testid="factory-pill-model-0"]') as HTMLElement).click());
        assert.match(container.textContent!, /Provider unavailable/);
        assert.equal((container.querySelector('[data-testid="factory-pill-model-0"]') as HTMLButtonElement).disabled, false, "a refused write can be retried");
        await act(() => root.render(createElement(buttons.get("unknown").behavior.Content, { theme: testTheme, layout: { platform: "web" }, close() {} })));
        assert.equal(container.querySelector('[data-testid="factory-pill-model-0"]'), null);
        assert.equal(container.querySelector('[data-testid="factory-pill-hand-off-now"]'), null);
        assert.equal(calls.length, 1, "no unscoped RPC is ever sent");
      } finally { await act(() => root.unmount()); }
    });
  } finally { stop(); }
});

test('W14: iOS and Android expose exactly the Project model, handoff and adoption writes', async () => {
  const { FactoryShell } = await load('plugin/client/factory/shell.tsx');
  const { testTheme } = await import('./client-markup.ts');
  const { createElement } = await import('react');
  const panel = modelPanelFixture();
  const progress = { reason: 'owner', fromLane: { provider: 'codex', model: 'old' }, toLane: { provider: 'claude', model: 'new' }, startedAt: '', updatedAt: '' };
  panel.handoffs = [
    { ...progress, seat: 'lead', state: 'scheduled', allowedActions: ['cancel', 'hand-off-now'], waitingPeers: 1 },
    { ...progress, seat: 'peer:gone', state: 'failed', allowedActions: ['retry', 'replace-now', 'view-handover'] },
  ];
  panel.seats.supervisorCandidates = [{ agentId: 'candidate', title: 'Owner chat', statusLabel: 'idle', tone: 'normal', model: 'opus' }];
  panel.needsYou = [
    { key: 'prerequisites', kind: 'prerequisites', title: 'Missing tools', detail: null, action: { kind: 'install-prerequisites', label: 'Install' } },
    { key: 'supervisor', kind: 'no-supervisor', title: 'No Supervisor', detail: null, action: { kind: 'start-supervisor', label: 'Start Supervisor' } },
    { key: 'design', kind: 'open-design-broken', title: 'Broken design', detail: null, action: { kind: 'sync-open-design', label: 'Sync' } },
    { key: 'retry', kind: 'handoff-failed', title: 'Failed Peer', detail: null, action: { kind: 'retry-handoff', seat: 'peer:gone', label: 'Try again' } },
  ];
  panel.openDesign = { state: 'linked', projectName: 'Design', syncedAt: null, detail: null };
  const view = { ...modelPickerFixture, panel, project: { root: '/project', slug: 'my-app', missingRoot: false }, kpis: { running: 0, needsHuman: 0 }, companionTools: [], corePlugin: {}, vault: {}, skillHub: { projectPacks: [{ id: 'expo', label: 'Expo', enabled: false }] }, daemonError: null };
  const calls: { method: string; input: any }[] = [];
  const opened: string[] = [];
  const g = globalThis as Record<string, any>, prior = g.__factoryClientRpc;
  g.__factoryClientRpc = async (method: string, input: any) => {
    calls.push({ method, input });
    return method === 'factory.snapshot' ? { ok: true, view } : { ok: true, agentId: 'candidate', text: 'Owner goals', source: 'substitute' };
  };
  try {
    await mountUnderNativeWindow(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
        for (const platform of ['ios', 'android']) {
          calls.length = 0;
          await act(() => root.render(createElement(FactoryShell, { key: platform, theme: testTheme, dir: '/project', layout: { compact: true, platform }, navigation: { openAgent: ({ agentId }: any) => opened.push(agentId) } })));
          const click = async (id: string) => {
            const button = container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
            assert.equal(button?.tagName, 'BUTTON', `${platform}: ${id}`);
            await act(() => button.click());
          };
          await click('factory-panel-menu-toggle');
          assert.match(container.querySelector('[data-testid="factory-panel-menu"]')!.textContent!, /on Paseo Desktop/, 'desktop-only Project actions explain where to continue');
          await click('factory-tab-project');
          for (const id of ['factory-handoff-retry', 'factory-panel-needs-you-action-retry', 'factory-profile-chip-menu', 'factory-skill-pack-expo', 'factory-panel-open-settings', 'factory-panel-menu-reset', 'factory-panel-menu-delete', 'factory-panel-menu-confirm-reset', 'factory-panel-menu-confirm-delete', 'factory-panel-start-supervisor', 'factory-panel-needs-you-action-prerequisites', 'factory-panel-needs-you-action-supervisor', 'factory-panel-needs-you-action-design', 'factory-open-design-sync', 'factory-open-design-studio']) {
            assert.equal(container.querySelector(`[data-testid="${id}"]`), null, `${platform} hides ${id}`);
          }
          assert.ok(container.querySelector('[data-testid="factory-panel-od"]'), 'the design status shows on the Project tab');
          assert.equal(container.querySelector('[data-testid="factory-panel-od"] button'), null, 'design Sync and Studio never mount on mobile');
          await click('factory-tab-team');
          assert.equal(container.querySelector('[data-testid="factory-panel-menu"] button'), null, 'the mobile Project menu has no actions');
          assert.deepEqual([...container.querySelectorAll('button')].map(button => button.getAttribute('data-testid')).sort(), [
            'factory-panel-menu-toggle', 'factory-handoff-cancel', 'factory-handoff-now', 'factory-handoff-replace-now', 'factory-handoff-view',
            'factory-tab-team', 'factory-tab-models', 'factory-tab-project',
            'factory-seat-chip-supervisor', 'factory-seat-chip-lead', 'factory-seat-chip-peer-task-1',
            'factory-panel-open-lead', 'factory-panel-open-peer-task-1', 'factory-seat-hand-off-now-lead', 'factory-seat-hand-off-now-peer-task-1',
            'factory-panel-adopt-supervisor',
          ].sort(), 'every mobile action belongs to the allowed write set or read navigation');
          assert.notEqual(container.querySelector('[data-testid="factory-profile-chip"]')?.tagName, 'BUTTON');
          for (const seat of ['supervisor', 'lead', 'peer-task-1', 'worker']) {
            await click(`factory-tab-${seat === 'worker' ? 'models' : 'team'}`);
            await click(`factory-seat-chip-${seat}`);
            assert.equal(container.querySelector('[data-testid="factory-chip-editor-machine-default"]'), null);
            await click('factory-chip-editor-primary');
          }
          await click('factory-tab-team');
          await click('factory-handoff-cancel');
          await click('factory-handoff-now');
          await click('factory-handoff-replace-now');
          await click('factory-panel-adopt-supervisor');
          await click('factory-handoff-view');
          await click('factory-panel-open-lead');
          assert.deepEqual(calls.filter(c => c.method !== 'factory.snapshot' && c.method !== 'factory.handoff.handover'), [
            { method: 'factory.lanes.set', input: { projectRoot: '/project', lane: 'supervisor', value: 'codex/gpt-live:high' } },
            { method: 'factory.handoff.start', input: { projectRoot: '/project', seat: 'lead' } },
            { method: 'factory.handoff.start', input: { projectRoot: '/project', seat: 'peer:task-1', lane: 'codex/gpt-live:high' } },
            { method: 'factory.lanes.set', input: { projectRoot: '/project', lane: 'worker', value: 'codex/gpt-live:high' } },
            { method: 'factory.handoff.cancel', input: { projectRoot: '/project', seat: 'lead' } },
            { method: 'factory.handoff.start', input: { projectRoot: '/project', seat: 'lead' } },
            { method: 'factory.handoff.replace.now', input: { projectRoot: '/project', seat: 'peer:gone' } },
            { method: 'factory.supervisor.adopt', input: { projectRoot: '/project', agentId: 'candidate' } },
          ]);
          assert.deepEqual(opened.slice(-2), ['candidate', 'lead'], 'adoption and read navigation still open chats');
          assert.ok(calls.some(c => c.method === 'factory.handoff.handover'));
        }
      } finally { await act(() => root.unmount()); }
    });
  } finally { g.__factoryClientRpc = prior; }
});

test("05: Hand off… and the model chip open the same modal; its title and primary label say which act confirming fires", async () => {
  const { ProjectPanel } = await load("plugin/client/factory/project-panel.tsx");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const rotated: string[] = [];
  const viewed: string[] = [];
  const saved: unknown[] = [];
  const panel = modelPanelFixture();
  panel.seats.peers[0].allowedActions = ["switch-model", "hand-off-now", "view-handover"];
  panel.seats.lead.allowedActions = ["switch-model", "hand-off-now", "view-handover"];
  const actions = { ...modelPanelActions, handoffStart: (seat: string) => { rotated.push(seat); }, viewHandover: (seat: string) => { viewed.push(seat); }, saveSeatModel: (seat: string, value: string) => { saved.push({ seat, value }); } };
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      await act(() => root.render(createElement(ProjectPanel, { theme: testTheme, panel, modelView: modelPickerFixture, mobile: false, now: Date.now(), daemonError: null, actions })));
      const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      const click = (id: string) => act(() => byId(id)!.click());
      const title = () => container.querySelector("[data-modal-title]")?.getAttribute("data-modal-title");
      const buttons = (label: string) => [...container.querySelectorAll('[data-testid="factory-chip-editor"] button')].find((b) => b.textContent?.startsWith(label)) as HTMLElement;
      assert.equal(byId("factory-seat-hand-off-now-lead")?.textContent, "Hand off…");
      assert.equal(byId("factory-seat-hand-off-now-peer-task-1")?.textContent, "Hand off…");
      // The row button and the chip open one modal for the seat.
      await click("factory-seat-hand-off-now-lead");
      assert.equal(title(), "Hand off Lead");
      assert.deepEqual(rotated, [], "opening fires nothing");
      assert.equal(byId("factory-chip-editor-primary")?.textContent, "Hand off to a fresh session");
      assert.equal(byId("factory-chip-editor")!.textContent!.includes("Starts a fresh Lead session"), false, "the explanation lives behind ⋯, not in the footer");
      await click("lane-picker-more-toggle");
      assert.match(byId("lane-picker-more")!.textContent!, /Starts a fresh Lead session on the same model\. The current session writes a handover first\./);
      assert.match(byId("lane-picker-now")!.textContent!, /^Now: codex · gpt-live · high$/);
      assert.equal(byId("lane-picker-summary")!.textContent, "unchanged · fresh session");
      assert.equal(byId("factory-chip-editor")!.textContent!.includes("EFFECTIVE LANE VALUE"), false);
      // Another model on the same provider switches in place; the footer summary says so.
      await act(() => buttons("GPT next").click());
      assert.equal(byId("factory-chip-editor-primary")?.textContent, "Switch model");
      assert.equal(byId("lane-picker-summary")!.textContent, "same provider · switch in place");
      // View last handover closes the modal and asks for the handover.
      await click("factory-chip-editor-view-handover");
      assert.deepEqual(viewed, ["lead"]);
      assert.equal(byId("factory-chip-editor"), null);
      await click("factory-seat-chip-lead");
      await click("factory-chip-editor-primary");
      assert.deepEqual(rotated, ["lead"], "the chip opens the same modal; unchanged confirms a rotate");
      assert.deepEqual(saved, []);
      await click("factory-seat-hand-off-now-peer-task-1");
      assert.equal(title(), "Hand off Peer · task-1");
      assert.equal(byId("factory-chip-editor-primary")?.textContent, "Hand off Peer");
      await click("lane-picker-more-toggle");
      await click("factory-chip-editor-view-handover");
      assert.deepEqual(viewed, ["lead", "peer:task-1"]);
      // A vacant standing seat only sets its model; so does the Default worker.
      await click("factory-seat-chip-supervisor");
      assert.equal(title(), "Supervisor model");
      assert.equal(byId("factory-chip-editor-primary")?.textContent, "Save Supervisor model");
      assert.equal(byId("factory-chip-editor-view-handover"), null);
      assert.equal(byId("factory-seat-hand-off-now-supervisor"), null, "a vacant seat has no Hand off…");
      await click("factory-chip-editor-primary");
      assert.deepEqual(saved, [{ seat: "supervisor", value: "codex/gpt-live:high" }]);
      await act(() => root.render(createElement(ProjectPanel, { key: "worker", theme: testTheme, panel, modelView: modelPickerFixture, mobile: false, now: Date.now(), daemonError: null, initialUi: { tab: "models" }, actions })));
      await click("factory-seat-chip-worker");
      assert.equal(title(), "Default worker model");
      assert.equal(byId("factory-chip-editor-primary")?.textContent, "Save Default worker");
    } finally { await act(() => root.unmount()); }
  });
});

test("05: a provider whose model list is empty shows the empty state, the warning and the custom ID field directly", async () => {
  const { ProjectPanel } = await load("plugin/client/factory/project-panel.tsx");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const modelView = { ...modelPickerFixture, providers: [...modelPickerFixture.providers, { provider: "antigravity", available: true, models: [] }, { provider: "gemini", available: true, models: null }] };
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      await act(() => root.render(createElement(ProjectPanel, { theme: testTheme, panel: modelPanelFixture(), modelView, mobile: false, now: Date.now(), daemonError: null, actions: { ...modelPanelActions, saveSeatModel() {} } })));
      await act(() => (container.querySelector('[data-testid="factory-seat-chip-lead"]') as HTMLElement).click());
      const editor = container.querySelector('[data-testid="factory-chip-editor"]')!;
      for (const provider of ["antigravity", "gemini"]) {
        await act(() => (editor.querySelector('[data-testid="lane-picker-provider-select"]') as HTMLElement).click());
        await act(() => (editor.querySelector(`[data-testid="lane-picker-provider-${provider}"]`) as HTMLElement).click());
        assert.match(editor.textContent!, new RegExp(`Paseo returned no models for ${provider}\\.`));
        assert.ok(editor.querySelector('[data-testid="lane-picker-unverified-provider"]'), "the unreachable-provider warning shows");
        assert.equal(editor.querySelector('[data-testid="lane-picker-custom-toggle"]'), null);
        assert.match(editor.textContent!, /Custom model ID/, "the custom field is shown directly");
      }
      await act(() => (editor.querySelector('[data-testid="lane-picker-provider-select"]') as HTMLElement).click());
      await act(() => (editor.querySelector('[data-testid="lane-picker-provider-codex"]') as HTMLElement).click());
      assert.equal(editor.textContent!.includes("Paseo returned no models"), false, "a provider with models has no empty state");
    } finally { await act(() => root.unmount()); }
  });
});

test("08: All searches every provider; picking a row from another provider switches provider and the primary label", async () => {
  const { ProjectPanel } = await load("plugin/client/factory/project-panel.tsx");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const rotated: string[] = [];
  const saved: unknown[] = [];
  const actions = { ...modelPanelActions, handoffStart: (seat: string) => { rotated.push(seat); }, saveSeatModel: (seat: string, value: string) => { saved.push({ seat, value }); } };
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      await act(() => root.render(createElement(ProjectPanel, { theme: testTheme, panel: modelPanelFixture(), modelView: modelPickerFixture, mobile: false, now: Date.now(), daemonError: null, actions })));
      await act(() => (container.querySelector('[data-testid="factory-seat-chip-lead"]') as HTMLElement).click());
      const editor = container.querySelector('[data-testid="factory-chip-editor"]')!;
      const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      const button = (label: string) => [...editor.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label)) as HTMLElement | undefined;
      const search = editor.querySelector("input") as HTMLInputElement;
      assert.equal(search.placeholder, "Search models across all providers…");
      const type = async (text: string) => {
        const setter = Object.getOwnPropertyDescriptor(search.ownerDocument.defaultView!.HTMLInputElement.prototype, "value")!.set!;
        await act(() => { setter.call(search, text); search.dispatchEvent(new search.ownerDocument.defaultView!.Event("input", { bubbles: true })); });
      };
      // Opens filtered to the current provider: the other provider's model is not listed yet, and typing stays inside it.
      assert.equal(button("Opus"), undefined, "the list starts on the current provider");
      await type("opus");
      assert.equal(button("Opus"), undefined, "a search inside one provider filters inside it");
      assert.match(editor.textContent!, /No models match "opus"/);
      await act(() => byId("lane-picker-provider-select")!.click());
      await act(() => byId("lane-picker-provider-all")!.click());
      assert.ok(button("Opus"), "searching under All finds a model from another provider");
      assert.equal(button("GPT live"), undefined, "the search still filters the rest out");
      await type("");
      assert.ok(button("GPT live") && button("Opus"), "clearing the search lists every provider's models under All");
      assert.match(button("Opus")!.textContent!, /claude$/, "All shows the provider name on the right of each row");
      await act(() => button("Opus")!.click());
      assert.equal(byId("factory-chip-editor-primary")?.textContent, "Hand off to claude", "a row from another provider switches the provider too");
      assert.equal(byId("lane-picker-summary")!.textContent, "codex → claude · new session");
      await act(() => byId("factory-chip-editor-primary")!.click());
      assert.deepEqual(saved, [{ seat: "lead", value: "claude/opus" }]);
      assert.deepEqual(rotated, []);
    } finally { await act(() => root.unmount()); }
  });
});

test("08: while providers load the picker shows a loading block, keeps the current value and never opens the custom field", async () => {
  const { ProjectPanel } = await load("plugin/client/factory/project-panel.tsx");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const rotated: string[] = [];
  const modelView = { ...modelPickerFixture, providers: [], providersLoading: true };
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      await act(() => root.render(createElement(ProjectPanel, { theme: testTheme, panel: modelPanelFixture(), modelView, mobile: false, now: Date.now(), daemonError: null, actions: { ...modelPanelActions, handoffStart: (seat: string) => { rotated.push(seat); }, saveSeatModel() {} } })));
      await act(() => (container.querySelector('[data-testid="factory-seat-chip-lead"]') as HTMLElement).click());
      const editor = container.querySelector('[data-testid="factory-chip-editor"]')!;
      assert.match(editor.querySelector('[data-testid="lane-picker-loading"]')!.textContent!, /Loading providers…/);
      assert.equal(editor.textContent!.includes("Custom model ID"), false, "no custom field while the lists have not loaded");
      assert.equal(editor.querySelector('[data-testid="lane-picker-unverified-provider"]'), null);
      assert.equal(editor.textContent!.includes("Paseo returned no models"), false);
      assert.equal(editor.querySelector('[data-testid="lane-picker-custom-toggle"]'), null);
      // The current value stays selected: confirming still rotates the live Lead.
      assert.equal((container.querySelector('[data-testid="factory-chip-editor-primary"]') as HTMLElement).textContent, "Hand off to a fresh session");
      await act(() => (container.querySelector('[data-testid="factory-chip-editor-primary"]') as HTMLElement).click());
      assert.deepEqual(rotated, ["lead"]);
      // Loaded lists replace the block.
      await act(() => root.render(createElement(ProjectPanel, { theme: testTheme, panel: modelPanelFixture(), modelView: modelPickerFixture, mobile: false, now: Date.now(), daemonError: null, actions: { ...modelPanelActions, saveSeatModel() {} } })));
      await act(() => (container.querySelector('[data-testid="factory-seat-chip-lead"]') as HTMLElement).click());
      assert.equal(container.querySelector('[data-testid="lane-picker-loading"]'), null);
    } finally { await act(() => root.unmount()); }
  });
});

test("09: the provider dropdown lists every provider with its count (8 of them), picking one filters and closes, All shows the total", async () => {
  const { ProjectPanel } = await load("plugin/client/factory/project-panel.tsx");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const extra = ["gemini", "pi", "antigravity", "copilot", "opencode", "amp"].map((provider, i) => ({ provider, available: true, models: Array.from({ length: i }, (_, n) => ({ id: `${provider}-m${n}`, label: `${provider} model ${n}`, thinkingOptions: [] })) }));
  const modelView = { ...modelPickerFixture, providers: [...modelPickerFixture.providers, ...extra] };
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      await act(() => root.render(createElement(ProjectPanel, { theme: testTheme, panel: modelPanelFixture(), modelView, mobile: false, now: Date.now(), daemonError: null, actions: { ...modelPanelActions, saveSeatModel() {} } })));
      await act(() => (container.querySelector('[data-testid="factory-seat-chip-lead"]') as HTMLElement).click());
      const editor = container.querySelector('[data-testid="factory-chip-editor"]')!;
      const byId = (id: string) => editor.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      const click = async (id: string) => { const el = byId(id); assert.ok(el, id); await act(() => el!.click()); };
      assert.equal(editor.querySelector('[data-testid="lane-picker-provider-list"]'), null, "closed by default");
      assert.match(byId("lane-picker-provider-select")!.textContent!, /^codex · 2/, "the trigger names the current provider and its count");
      await click("lane-picker-provider-select");
      assert.ok(byId("lane-picker-provider-list"), "the list opens in place");
      const total = modelView.providers.reduce((sum, p) => sum + (p.models?.length ?? 0), 0);
      assert.equal(total, 2 + 1 + 0 + 1 + 2 + 3 + 4 + 5);
      assert.match(byId("lane-picker-provider-all")!.textContent!, new RegExp(`^All providers${total} models$`));
      for (const entry of modelView.providers) {
        const row = byId(`lane-picker-provider-${entry.provider}`);
        assert.ok(row, `${entry.provider} is listed`);
        assert.ok(row!.textContent!.startsWith(entry.provider), "row text starts with the provider name");
        const n = entry.models!.length;
        assert.ok(row!.textContent!.includes(`${n} ${n === 1 ? "model" : "models"}`), `${entry.provider} shows ${n}`);
      }
      assert.match(byId("lane-picker-provider-pi")!.textContent!, /1 model$/, "a single model reads singular");
      assert.match(byId("lane-picker-provider-gemini")!.textContent!, /0 models$/);
      assert.equal(editor.textContent!.includes("GPT live"), false, "the model list is replaced while the dropdown is open");
      await click("lane-picker-provider-claude");
      assert.equal(byId("lane-picker-provider-list"), null, "picking a provider closes the dropdown");
      assert.match(byId("lane-picker-provider-select")!.textContent!, /^claude · 1/);
      assert.ok([...editor.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Opus")), "the list is filtered to the provider");
      assert.equal([...editor.querySelectorAll("button")].some((b) => b.textContent?.startsWith("GPT live")), false);
      assert.equal(byId("factory-chip-editor-primary")?.textContent, "Hand off to claude", "picking a provider moves the selection onto it");
      await click("lane-picker-provider-select");
      await click("lane-picker-provider-select");
      assert.equal(byId("lane-picker-provider-list"), null, "tapping the trigger again closes it");
      await click("lane-picker-provider-select");
      await click("lane-picker-provider-all");
      assert.equal(byId("lane-picker-provider-list"), null);
      assert.match(byId("lane-picker-provider-select")!.textContent!, new RegExp(`^All providers · ${total}`));
      assert.ok([...editor.querySelectorAll("button")].some((b) => b.textContent?.startsWith("GPT live")), "All lists every provider's models");
      // Typing in search closes an open dropdown.
      await click("lane-picker-provider-select");
      const search = editor.querySelector("input") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(search.ownerDocument.defaultView!.HTMLInputElement.prototype, "value")!.set!;
      await act(() => { setter.call(search, "gpt"); search.dispatchEvent(new search.ownerDocument.defaultView!.Event("input", { bubbles: true })); });
      assert.equal(byId("lane-picker-provider-list"), null, "typing closes the dropdown");
    } finally { await act(() => root.unmount()); }
  });
});

test("10: the pill popover drops the status table, hides the current model, labels provider and verb, and closes from the X", async () => {
  const { startSeatDirectory } = await load("plugin/client/factory/directory.tsx", "web");
  const { testTheme } = await import("./client-markup.ts");
  const { createElement } = await import("react");
  const buttons = new Map<string, any>();
  const calls: any[] = [];
  const base = { slug: "app", workspaceId: "root", provider: "github-copilot", model: "gpt-6.1-sol", thinking: "high", lane: { provider: "github-copilot", model: "gpt-6.1-sol", thinking: "high", scope: "project" }, allowedActions: ["switch-model", "hand-off-now"], contextUsedTokens: 121000, markTokens: 128000, handoffState: null, task: null,
    quickSwitchModels: [{ provider: "github-copilot", model: "gpt-6.1-sol", thinking: "high" }, { provider: "antigravity", model: "gemini-4-argon-high", thinking: "high" }, { provider: "github-copilot", model: "gpt-6.1-sol", thinking: "medium" }] };
  const seats = [{ ...base, role: "supervisor", agentId: "sup" }, { ...base, role: "peer", task: "task-9", agentId: "peer", workspaceId: "wt" }, { ...base, role: "lead", agentId: "lead", handoffState: "failed", allowedActions: [], quickSwitchModels: [] }];
  const stop = startSeatDirectory({ rpc: async (contract: any, input: any) => { if (contract.name === "factory.seats.directory") return { ok: true, daemonError: null, projects: [{ slug: "app", root: "/project", workspaceId: "root", needsYouCount: 0 }], seats }; calls.push({ method: contract.name, input }); return { ok: true }; }, addHeaderButton: () => ({ update() {}, remove() {} }), addComposerPill: ({ agentId, button }: any) => { buttons.set(agentId, button); return { update() {}, remove() {} }; } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    await mountUnderNativeWindow(async (createRoot, container, act) => {
      const root = createRoot(container);
      let closed = 0;
      const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      const render = (agent: string) => act(() => root.render(createElement(buttons.get(agent).behavior.Content, { theme: testTheme, layout: { platform: "web" }, close() { closed++; } })));
      try {
        await render("sup");
        const popover = byId("factory-pill-popover")!;
        assert.match(popover.textContent!, /^Supervisor/, "the title is the capitalised role");
        assert.ok(popover.textContent!.includes("gpt-6.1-sol · high · github-copilot"), "one muted meta line: model · thinking · provider");
        assert.doesNotMatch(popover.textContent!, /Context|121k|Project|app\b|Handoff|Role|Close/, "no Role/Model/Thinking/Context/Project/Handoff rows and no Close button");
        assert.ok(popover.textContent!.includes("RECENT MODELS"));
        // The current model (index 0) is never offered; the original indexes survive for the rest.
        assert.equal(byId("factory-pill-model-0"), null, "the current model is not offered");
        const cross = byId("factory-pill-model-1")!;
        assert.match(cross.textContent!, /gemini-4-argon-high · high/);
        assert.match(cross.textContent!, /antigravity/, "the provider of a quick-switch model is visible");
        assert.match(cross.textContent!, /Hand off$/, "a cross-provider row says Hand off");
        const same = byId("factory-pill-model-2")!;
        assert.match(same.textContent!, /gpt-6\.1-sol · medium/);
        assert.match(same.textContent!, /github-copilot/);
        assert.match(same.textContent!, /Switch$/, "the same provider switches in place");
        assert.equal(byId("factory-pill-hand-off-now")!.textContent, "Hand off to a fresh session");
        assert.equal(byId("factory-pill-other-model")!.textContent, "Other model…");
        await act(() => same.click());
        assert.deepEqual(calls.at(-1), { method: "factory.lanes.set", input: { projectRoot: "/project", lane: "supervisor", value: "github-copilot/gpt-6.1-sol:medium" } });
        assert.equal(closed, 1, "close on success");
        await act(() => byId("factory-pill-close")!.click());
        assert.equal(closed, 2, "the X calls close");

        await render("peer");
        assert.match(byId("factory-pill-popover")!.textContent!, /^Peer · task-9/);
        assert.match(byId("factory-pill-model-2")!.textContent!, /Hand off$/, "a Peer always hands off");

        await render("lead");
        assert.match(byId("factory-pill-popover")!.textContent!, /Handoff failed/);
        assert.equal(container.querySelector('[data-testid^="factory-pill-model-"]'), null);
        assert.doesNotMatch(byId("factory-pill-popover")!.textContent!, /RECENT MODELS/, "no section label without rows");
      } finally { await act(() => root.unmount()); }
    });
  } finally { stop(); }
});
