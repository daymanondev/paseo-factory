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
import type { PanelView } from "../plugin/shared/view.ts";

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
              const tag = (name) => ({ children, onPress, disabled, testID, style, accessibilityRole }) =>
                React.createElement(name, { disabled, onClick: onPress, 'data-testid': testID, 'data-role': accessibilityRole, 'data-style': typeof style === 'object' && style !== null ? JSON.stringify(style) : undefined }, children);
              exports.View = tag('div'); exports.Text = tag('span'); exports.Pressable = tag('button');
              exports.Icon = () => null;
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

const healthySeats: NonNullable<PanelView["seats"]> = {
  supervisor: { role: "supervisor", vacant: false, agentId: "agent-sup", statusLabel: "idle", tone: "normal", model: "opus-4-8", hint: null, context: null, handoff: null },
  lead: {
    role: "lead", vacant: false, agentId: "agent-lead", statusLabel: "working", tone: "normal", model: "glm-5.3", hint: null,
    context: { usedTokens: 94_400, markTokens: 128_000, label: "94k / 128k", fraction: 0.7375 },
    handoff: { state: "normal", label: "normal", queuedMailCount: 0 },
  },
  peers: [{ agentId: "agent-peer", task: "T-08", title: "Peer · T-08", disposition: "reviewer", statusLabel: "working", tone: "normal", model: "glm-5.3" }],
};

function makePanel(overrides: Partial<PanelView> = {}): PanelView {
  return {
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
  openAgent() {}, installPrerequisites() {}, rotateLead() {}, revokeSupervisor() {}, startSupervisor() {}, busy: false,
});

async function render(panel: PanelView, props: { mobile?: boolean; openDesignActions?: unknown; menu?: unknown; initialUi?: Record<string, unknown>; actions?: Record<string, unknown> } = {}): Promise<string> {
  const { ProjectPanel } = await loadPanel();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(
    createElement(ProjectPanel, {
      theme, panel, mobile: props.mobile ?? false, now: Date.now(), daemonError: null,
      actions: { ...noopActions(), ...(props.actions ?? {}) },
      ...(props.openDesignActions === undefined ? {} : { openDesignActions: props.openDesignActions }),
      ...(props.menu === undefined ? {} : { menu: props.menu }),
      ...(props.initialUi === undefined ? {} : { initialUi: props.initialUi }),
    }),
  );
}

const hasHook = (html: string, id: string): boolean => html.includes(`data-testid="${id}"`);

test("panel renders the header, summary, seats and Open Design card with the named test hooks — and no Needs-you block when nothing needs the Owner", async () => {
  const html = await render(makePanel());
  assert.match(html, /my-app/);
  assert.match(html, /Lead working · 1 Peer · nothing needs you/);
  for (const hook of ["factory-panel-seat-supervisor", "factory-panel-seat-lead", "factory-panel-seat-peer-T-08", "factory-panel-od"]) {
    assert.ok(hasHook(html, hook), `${hook} renders`);
  }
  assert.equal(hasHook(html, "factory-panel-needs-you"), false, "Needs you appears only when something needs the Owner");
  assert.match(html, /Peer · T-08/);
  assert.match(html, /reviewer/);
  assert.match(html, /94k \/ 128k/, "the Lead row reads Nk / 128k");
  assert.match(html, /Handoff: normal/);
  assert.match(html, /Mobile Redesign/);
  assert.match(html, /Synced 5m ago/);
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

test("colour is only for exceptions — healthy seats draw none, an errored seat is red, a waiting one amber", async () => {
  const healthy = await render(makePanel());
  assert.equal(healthy.includes(DANGER) || healthy.includes(WARNING), false, "a healthy panel draws no warning or danger colour");

  const sick = makePanel({
    seats: {
      ...healthySeats,
      supervisor: { ...healthySeats.supervisor, statusLabel: "error", tone: "error", hint: "adapter crashed" },
      lead: { ...healthySeats.lead, statusLabel: "waiting for permission", tone: "waiting" },
    },
  });
  const html = await render(sick);
  const supervisorRow = html.slice(html.indexOf("factory-panel-seat-supervisor"), html.indexOf("factory-panel-seat-lead"));
  assert.ok(supervisorRow.includes(DANGER), "the errored seat is red");
  const leadRow = html.slice(html.indexOf("factory-panel-seat-lead"), html.indexOf("factory-panel-peers"));
  assert.ok(leadRow.includes(WARNING), "the waiting seat is amber");
});

test("a handoff that is waiting is amber words on the Lead row; a vacant Lead only says to ask the Supervisor — no start button", async () => {
  const pending = await render(
    makePanel({ seats: { ...healthySeats, lead: { ...healthySeats.lead, handoff: { state: "rotation_pending", label: "will hand off at the next quiet point · 2 queued mail", queuedMailCount: 2 } } } }),
  );
  assert.match(pending, /will hand off at the next quiet point · 2 queued mail/);

  const vacant = await render(
    makePanel({
      seats: {
        ...healthySeats,
        peers: [],
        lead: { role: "lead", vacant: true, agentId: null, statusLabel: "vacant", tone: "normal", model: null, hint: "No Lead is running — ask your Supervisor.", context: null, handoff: null },
      },
    }),
  );
  assert.match(vacant, /No Lead is running — ask your Supervisor\./);
  const vacantLeadRow = vacant.slice(vacant.indexOf("factory-panel-seat-lead"));
  assert.doesNotMatch(vacantLeadRow, /<button/, "a vacant Lead offers no button — not Open, not Rotate, not Start");
  assert.equal(hasHook(vacant, "factory-panel-peers"), false, "the Peers section is hidden when no Peer is running");
});

test("an unlinked Open Design card collapses to one line", async () => {
  const html = await render(makePanel({ openDesign: { state: "unlinked", projectName: null, syncedAt: null, detail: null } }));
  assert.match(html, /Open Design · not linked/);
});

test("desktop mounts the Open Design actions on the card; mobile shows the link status alone", async () => {
  const { createElement } = await import("react");
  const actions = createElement("button", { "data-testid": "od-actions" }, "Sync");
  const desktop = await render(makePanel(), { mobile: false, openDesignActions: actions });
  assert.ok(hasHook(desktop, "od-actions"), "desktop offers Sync / Studio");
  const mobile = await render(makePanel(), { mobile: true, openDesignActions: actions });
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
  supervisor: { role: "supervisor", vacant: true, agentId: null, statusLabel: "vacant", tone: "normal", model: null, hint: "No Supervisor is running.", context: null, handoff: null },
};

test("every live seat row has an Open action — Supervisor, Lead and each Peer — on desktop and on mobile", async () => {
  for (const mobile of [false, true]) {
    const html = await render(makePanel(), { mobile });
    for (const hook of ["factory-panel-open-supervisor", "factory-panel-open-lead", "factory-panel-open-peer-T-08"]) {
      assert.ok(hasHook(html, hook), `${hook} renders (mobile=${mobile})`);
    }
  }
});

test("Rotate Lead sits on the live Lead row on desktop and mobile; a vacant Lead carries none", async () => {
  for (const mobile of [false, true]) {
    const html = await render(makePanel(), { mobile });
    const leadRow = html.slice(html.indexOf("factory-panel-seat-lead"), html.indexOf("factory-panel-peers"));
    assert.ok(hasHook(leadRow, "factory-panel-rotate-lead"), `Rotate Lead on the Lead row (mobile=${mobile})`);
    assert.equal((html.match(/factory-panel-rotate-lead/g) ?? []).length, 1);
  }
  const vacantLead = makePanel({ seats: { ...healthySeats, lead: { ...healthySeats.lead, vacant: true, agentId: null, statusLabel: "vacant", model: null, hint: "No Lead is running — ask your Supervisor.", context: null, handoff: null } } });
  const html = await render(vacantLead);
  assert.equal(hasHook(html, "factory-panel-rotate-lead"), false);
  assert.equal(hasHook(html, "factory-panel-open-lead"), false);
});

test("Revoke Supervisor lives behind the Supervisor row's ⋯ — closed by default, present once opened, on desktop and mobile; never on the Lead row", async () => {
  for (const mobile of [false, true]) {
    const closed = await render(makePanel(), { mobile });
    assert.ok(hasHook(closed, "factory-panel-supervisor-menu"), "the row ⋯ toggle is there");
    assert.equal(hasHook(closed, "factory-panel-revoke-supervisor"), false, "Revoke is not prominent");
    const open = await render(makePanel(), { mobile, initialUi: { supervisorMenuOpen: true } });
    assert.ok(hasHook(open, "factory-panel-revoke-supervisor"), `Revoke Supervisor once the ⋯ opens (mobile=${mobile})`);
    assert.match(open, /Revoke Supervisor/);
    const leadRow = open.slice(open.indexOf("factory-panel-seat-lead"));
    assert.doesNotMatch(leadRow, /Revoke/);
  }
  const vacant = await render(makePanel({ seats: vacantSupervisorSeats }), { initialUi: { supervisorMenuOpen: true } });
  assert.equal(hasHook(vacant, "factory-panel-revoke-supervisor"), false, "a vacant Supervisor has nothing to revoke");
});

test("a vacant Supervisor offers Start Supervisor with a directive box on desktop; mobile offers neither; a live Supervisor never does", async () => {
  const desktop = await render(makePanel({ seats: vacantSupervisorSeats }));
  assert.ok(hasHook(desktop, "factory-panel-start-supervisor"));
  assert.ok(hasHook(desktop, "factory-panel-directive"));
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

test("Project menu on desktop: model overrides, skill pack toggles, Open Design link controls, and two-step Reset / Delete", async () => {
  const { ProjectMenu } = await loadMenu();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const props = {
    theme, mobile: false, busy: false, missingRoot: false,
    modelsSlot: createElement("div", { "data-testid": "models-slot" }, "lanes"),
    openDesignSlot: createElement("div", { "data-testid": "od-slot" }, "link"),
    skillPacks: [
      { id: "expo", label: "Expo", enabled: true, autoDetected: true },
      { id: "firebase", label: "Firebase", enabled: false, autoDetected: false },
    ],
    togglePack() {}, resetProject() {}, deleteProject() {},
  };
  const html = renderToStaticMarkup(createElement(ProjectMenu, props));
  for (const hook of ["models-slot", "od-slot", "factory-panel-menu-skills", "factory-panel-skill-expo", "factory-panel-skill-firebase", "factory-panel-menu-reset", "factory-panel-menu-delete"]) {
    assert.ok(hasHook(html, hook), `${hook} renders on desktop`);
  }
  assert.doesNotMatch(html, /Confirm Reset|Confirm Delete/, "a single press never destroys — both start unarmed");

  const resetArmed = renderToStaticMarkup(createElement(ProjectMenu, { ...props, initialConfirming: "reset" }));
  assert.match(resetArmed, /Confirm Reset/);
  assert.ok(hasHook(resetArmed, "factory-panel-menu-confirm-reset"));
  assert.doesNotMatch(resetArmed, /Confirm Delete/);
  assert.match(resetArmed, /Cancel/);
  const deleteArmed = renderToStaticMarkup(createElement(ProjectMenu, { ...props, initialConfirming: "delete" }));
  assert.ok(hasHook(deleteArmed, "factory-panel-menu-confirm-delete"));
  assert.doesNotMatch(deleteArmed, /Confirm Reset/);
});

test("Project menu on mobile is view-only — no pack toggles, no Reset, no Delete", async () => {
  const { ProjectMenu } = await loadMenu();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(createElement(ProjectMenu, {
    theme, mobile: true, busy: false, missingRoot: false,
    modelsSlot: createElement("div", { "data-testid": "models-slot" }, "lanes"),
    openDesignSlot: null,
    skillPacks: [{ id: "expo", label: "Expo", enabled: true, autoDetected: true }],
    togglePack() {}, resetProject() {}, deleteProject() {},
  }));
  assert.ok(hasHook(html, "models-slot"), "models are shown (the shell passes them read-only)");
  assert.match(html, /Expo/, "the pack state is readable");
  assert.doesNotMatch(html, /<button/, "a mobile menu carries no writes at all");
  for (const hook of ["factory-panel-skill-expo", "factory-panel-menu-reset", "factory-panel-menu-delete"]) {
    assert.equal(hasHook(html, hook), false, `${hook} stays off mobile`);
  }
});

test("a Project whose folder is gone keeps Delete but drops Reset and the model / Open Design controls", async () => {
  const { ProjectMenu } = await loadMenu();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(createElement(ProjectMenu, {
    theme, mobile: false, busy: false, missingRoot: true,
    modelsSlot: createElement("div", { "data-testid": "models-slot" }),
    openDesignSlot: createElement("div", { "data-testid": "od-slot" }),
    skillPacks: [], togglePack() {}, resetProject() {}, deleteProject() {},
  }));
  assert.ok(hasHook(html, "factory-panel-menu-delete"));
  assert.equal(hasHook(html, "factory-panel-menu-reset"), false);
  assert.equal(hasHook(html, "models-slot") || hasHook(html, "od-slot"), false);
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

test("the panel is one column — the root stacks vertically with no horizontal flex, and every list lives inside it", () => {
  const panel = read("plugin/client/factory/project-panel.tsx");
  const root = panel.slice(panel.indexOf('testID="factory-panel"'), panel.indexOf("<View style={{ gap: SPACING[1] }}>", panel.indexOf('testID="factory-panel"')));
  assert.doesNotMatch(root, /flexDirection: "row"/, "the panel root is a single column");
  assert.doesNotMatch(panel, /horizontal/, "nothing scrolls sideways at narrow widths");
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

test("W6 shell wiring: every action rides its RPC — Rotate, Revoke, Start Supervisor (then opens the new seat), Reset, Delete — and no Lead start or accept RPC is bound", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  for (const rpc of ["leadRotate", "supervisorRevoke", "supervisorStart", "projectReset", "projectDelete"]) {
    assert.match(shell, new RegExp(`useRpc\\(${rpc}\\)`), `${rpc} is bound`);
  }
  assert.doesNotMatch(shell, /useRpc\((leadEnsure|supervisorEnsure|leadDispatch)\)/, "the only seat creation is Start Supervisor");
  assert.match(shell, /navigation\?\.openAgent\(\{ agentId: reply\.agentId/, "Start Supervisor opens the conversation it created");
  assert.match(shell, /<ProjectMenu/);
});

test("W6 mobile pins: the shell hands the menu its read-only mode and the panel and menu gate their writes on the mobile flag", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /readOnly=\{mobile\}/, "models are view-only on mobile");
  assert.match(shell, /mobile=\{mobile\}/);
  assert.match(read("plugin/client/factory/project-panel.tsx"), /!mobile/, "the panel gates its desktop-only affordances on the mobile flag");
  assert.match(read("plugin/client/factory/project-menu.tsx"), /mobile/, "the menu gates its writes on the mobile flag");
});
