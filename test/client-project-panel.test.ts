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
              const tag = (name) => ({ children, onPress, disabled, testID, style, accessibilityRole }) =>
                React.createElement(name, { disabled, onClick: onPress, 'data-testid': testID, 'data-role': accessibilityRole, 'data-style': typeof style === 'object' && style !== null ? JSON.stringify(style) : undefined }, children);
              exports.View = tag('div'); exports.Text = tag('span'); exports.Pressable = tag('button');
              exports.Icon = () => null;
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

async function render(panel: PanelView, props: { mobile?: boolean; openDesignActions?: unknown } = {}): Promise<string> {
  const { ProjectPanel } = await loadPanel();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(
    createElement(ProjectPanel, {
      theme, panel, mobile: props.mobile ?? false, now: Date.now(), daemonError: null,
      actions: { openAgent() {}, installPrerequisites() {}, busy: false },
      ...(props.openDesignActions === undefined ? {} : { openDesignActions: props.openDesignActions }),
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
  assert.doesNotMatch(vacant, /<button/, "a vacant Lead offers no button");
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

test("a workspace that is not a Project says to set it up on Desktop on mobile, and shows folder readiness on desktop", async () => {
  const notProject = makePanel({
    isProject: false, name: null, summary: "Not a Factory Project yet", seats: null, openDesign: null,
    onboarding: { folder: "/work/new-app", gitRepo: true, hasCommits: false, existingLead: false },
  });
  const mobile = await render(notProject, { mobile: true });
  assert.ok(hasHook(mobile, "factory-panel-onboarding"));
  assert.match(mobile, /Set this Project up on Paseo Desktop\./);
  const desktop = await render(notProject, { mobile: false });
  assert.match(desktop, /\/work\/new-app/);
  assert.match(desktop, /No commits yet/);
  assert.doesNotMatch(desktop, /Set this Project up on Paseo Desktop/);
  assert.equal(hasHook(desktop, "factory-panel-needs-you") || hasHook(desktop, "factory-panel-seat-lead") || hasHook(desktop, "factory-panel-od"), false, "no Project, no panel sections");
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

test("the shell reads mobile from the host layout platform, mounts the panel on the workspace panel host only, and hides the interim settings panes on mobile", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /layout\?\.platform === "ios" \|\| layout\?\.platform === "android"/);
  assert.match(shell, /<ProjectPanel/);
  assert.match(shell, /panel=\{view\.panel\}/, "the panel renders the server's projection, never a client re-derivation");
  assert.match(shell, /const showPanes = !panelHost \|\| !mobile;/);
  const entries = read("plugin/client/factory/entries.tsx");
  assert.match(entries, /surface="settings"/, "the settings screen is the other host");
});
