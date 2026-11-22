/**
 * v0.6.0 W8 (ADR 0056 §7): the Settings screen — one scrolling screen of
 * collapsible machine-wide sections (Default models & Lane profiles · Skills &
 * Tools · Plugins · Vault · Diagnostics), sections with a warning open by
 * default, and view-only on Paseo mobile. The warning rule is a pure function
 * of the snapshot view; the screen is mounted from source (native primitives
 * adapted to markup) and asserted on what an Owner would see. Source-text pins
 * are limited to what Node cannot mount: the surface registration and the
 * panel shell no longer carrying machine-wide panes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { repoRoot } from "./helpers.ts";
import { loadClientModule, testTheme } from "./client-markup.ts";
import type { FactoryView } from "../plugin/shared/view.ts";

const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

const tool = (over: Record<string, unknown> = {}) => ({
  id: "factory-skills-pack", title: "Factory skills", canonicalSource: "git:mattpocock/skills", access: "public", status: "running", enabled: true,
  installKind: "git", installedSource: "git:mattpocock/skills", currentRevision: "abc1234", version: "1.0.0", latestRevision: null, commitsBehind: null, updateAvailable: null, error: null, ...over,
});

/** A healthy machine view — every section quiet. Only the fields the screen reads. */
function healthyView(over: Record<string, unknown> = {}): FactoryView {
  return {
    lanes: { supervisor: "claude/opus:high", lead: "claude/sonnet", worker: "pi/glm", watch: "pi/glm", freshEyes: "eye.json" },
    providers: [{ provider: "claude", available: true, models: [] }, { provider: "pi", available: true, models: [] }],
    corePlugin: tool({ id: "paseo-factory", title: "Factory Core", version: "0.6.0", updateAvailable: false }),
    companions: [tool({ id: "paseo-room", title: "Room", version: "1.2.0", updateAvailable: false })],
    companionTools: [tool()],
    helperMcps: [{ name: "figma", transport: "http", enabled: true, targetProviders: ["pi"], vaultSync: false, sources: ["pi"], status: "connected" }],
    skillHub: { totalInstalled: 12, upToDateCount: 12, updateAvailableCount: 0, localCustomCount: 0, symlinkDriftCount: 0, installedSkills: [], projectPacks: [], hostCatalog: [], roleMatrix: [] },
    pluginsCheckedAt: "2026-11-12T00:00:00.000Z",
    vault: { configured: true, repo: "me/vault", branch: "main", ghInstalled: true, ghAuthenticated: true, ghUser: "me", error: null, lastPushedAt: "2026-11-11T00:00:00.000Z", hydratedApps: [] },
    daemonError: null,
    stateDir: "/home/me/.paseo/plugins/paseo-factory",
    project: null,
    ...over,
  } as unknown as FactoryView;
}

const SECTION_IDS = ["models", "skills-tools", "plugins", "vault", "diagnostics"];

test("a healthy machine raises no Settings warnings", async () => {
  const { settingsWarnings } = await loadClientModule("plugin/client/factory/settings-state.ts");
  assert.deepEqual(settingsWarnings(healthyView()), { models: null, "skills-tools": null, plugins: null, vault: null, diagnostics: null });
});

test("each section's warning comes from its own machine-wide signal", async () => {
  const { settingsWarnings } = await loadClientModule("plugin/client/factory/settings-state.ts");
  const warned = (over: Record<string, unknown>) => settingsWarnings(healthyView(over));

  assert.match(warned({ companionTools: [tool({ status: "not_installed" })] })["skills-tools"], /1 required (skill|tool|component)/i, "a missing prerequisite warns Skills & Tools");
  assert.match(warned({ helperMcps: [{ name: "figma", enabled: true, status: "auth_expired" }] })["skills-tools"], /Helper MCP/i, "a synced Helper MCP in trouble warns Skills & Tools");
  assert.equal(warned({ helperMcps: [{ name: "local", enabled: false, status: "disabled" }] })["skills-tools"], null, "a Helper MCP left local on the host is not a warning");
  assert.match(warned({ corePlugin: tool({ id: "paseo-factory", updateAvailable: true }) }).plugins, /update/i, "a pending plugin update warns Plugins");
  assert.match(warned({ companions: [tool({ id: "paseo-room", status: "failed", error: "boom" })] }).plugins, /failed|error/i, "a failed plugin warns Plugins");
  assert.match(warned({ vault: { ...healthyView().vault, error: "clone failed" } }).vault, /clone failed/, "a Vault error warns Vault");
  assert.match(warned({ daemonError: "daemon unreachable" }).diagnostics, /daemon unreachable/, "a daemon error warns Diagnostics");
  assert.match(warned({ providers: [{ provider: "claude", available: false, models: null }, { provider: "pi", available: true, models: [] }] }).models, /claude/, "a lane on an unavailable provider warns Default models");
  assert.equal(warned({ providers: [{ provider: "codex", available: false, models: null }] }).models, null, "an unavailable provider no lane uses is not a warning");
});

const theme = testTheme as never;
const body = (id: string) => createElement("div", { "data-testid": `body-${id}` }, id);
const slots = Object.fromEntries(SECTION_IDS.map((id) => [id, body(id)]));
const noWarnings = { models: null, "skills-tools": null, plugins: null, vault: null, diagnostics: null };

test("the Settings screen lists the five sections in order and opens only the ones with a warning", async () => {
  const { SettingsScreen } = await loadClientModule("plugin/client/factory/settings.tsx");
  const html = renderToStaticMarkup(createElement(SettingsScreen, { theme, warnings: { ...noWarnings, plugins: "1 update available", diagnostics: "daemon unreachable" }, slots }));

  const order = SECTION_IDS.map((id) => html.indexOf(`data-testid="settings-section-${id}"`));
  assert.ok(order.every((at) => at >= 0), "every section renders");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sections render in the spec's order");
  assert.match(html, /Default models &amp; Lane profiles/);
  assert.match(html, /Skills &amp; Tools/);

  for (const id of ["plugins", "diagnostics"]) assert.match(html, new RegExp(`data-testid="body-${id}"`), `${id} has a warning and opens by default`);
  for (const id of ["models", "skills-tools", "vault"]) assert.doesNotMatch(html, new RegExp(`data-testid="body-${id}"`), `${id} has no warning and starts collapsed`);
  assert.match(html, /1 update available/, "the warning text is on the section header");
  assert.match(html, /data-testid="settings-section-vault-toggle"/, "a collapsed section still has its toggle");
});

test("a quiet machine opens every section collapsed", async () => {
  const { SettingsScreen } = await loadClientModule("plugin/client/factory/settings.tsx");
  const html = renderToStaticMarkup(createElement(SettingsScreen, { theme, warnings: noWarnings, slots }));
  assert.doesNotMatch(html, /data-testid="body-/, "no section body renders while all are collapsed");
});

test("the mobile Settings body is a read-only summary — values, no write controls", async () => {
  const { SettingsReadOnly } = await loadClientModule("plugin/client/factory/settings.tsx");
  const view = healthyView({ pluginsCheckedAt: null });
  const lines = (section: string) => renderToStaticMarkup(createElement(SettingsReadOnly, { theme, view, section }));

  assert.match(lines("models"), /claude\/opus:high/, "the machine lane table is shown");
  assert.match(lines("skills-tools"), /Factory skills/, "Companion tools are listed");
  assert.match(lines("skills-tools"), /figma/, "Helper MCPs are listed");
  assert.match(lines("plugins"), /Factory Core/, "plugins are listed");
  assert.match(lines("plugins"), /0\.6\.0/, "with their versions");
  assert.match(lines("vault"), /me\/vault/, "the Vault repo is shown");
  for (const section of SECTION_IDS) assert.doesNotMatch(lines(section), /<button|<input/, `${section} mounts no write control on mobile`);
});

test("the surface registers the Workspace panel, the Settings screen, the desktop sidebar header item, Overview + Onboarding screens, and Command Center actions", () => {
  const index = read("plugin/index.client.tsx");
  const registrations = [...index.matchAll(/client\.(add[A-Za-z]+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...registrations].sort(), [
    "addCommandCenterItem",
    "addCommandCenterItem",
    "addScreen",
    "addScreen",
    "addSettingsScreen",
    "addSidebarHeaderItem",
    "addWorkspacePanel",
  ]);
  assert.match(index, /title: "Open Factory Panel"/);
  assert.match(index, /title: "Factory: Onboard Project"/);
});

test("the Project panel shell carries no machine-wide panes — they live on the Settings screen only", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  const panelBranch = shell.slice(shell.indexOf("{panelHost ? ("), shell.indexOf(") : (\n          settingsScreen"));
  assert.ok(panelBranch.includes("<ProjectPanel"), "the panel host renders the Project panel");
  for (const pane of ["<VaultPane", "<PluginsPane", "<SeatsPane", "<SkillsToolsPane", "TabBar"]) {
    assert.ok(!panelBranch.includes(pane), `the panel branch does not mount ${pane}`);
  }
  assert.match(shell, /<SettingsScreen/, "the settings host renders the Settings screen");
  assert.doesNotMatch(shell, /TabBar|FactoryTabStateSchema|useTabState/, "the interim tab bar and its persisted state are gone");
});

const packHub = () => ({
  ...healthyView().skillHub!, totalInstalled: 2,
  installedSkills: [
    { name: "tdd", pack: "core", packs: ["core"], source: "mattpocock/skills", revision: null, freshness: "local", harnesses: [], roles: ["peer"] },
    { name: "deploy", pack: "workflow", packs: ["source-acme", "custom-release"], source: "acme/tools", revision: null, freshness: "local", harnesses: [], roles: ["peer"] },
  ],
  projectPacks: [
    { id: "source-acme", label: "Acme tools", kind: "source", installedCount: 1, skills: ["deploy"], enabled: false, autoDetected: false },
    { id: "custom-release", label: "Release kit", description: "Ship releases reliably", kind: "custom", installedCount: 1, skills: ["deploy", "missing-skill"], enabled: true, autoDetected: false },
  ],
});

test("Settings Skill Hub shows source and custom pack details and every installed skill membership", async () => {
  const { SkillHubCard } = await loadClientModule("plugin/client/factory/skill-hub.tsx");
  const html = renderToStaticMarkup(createElement(SkillHubCard, { theme, hub: packHub(), busy: false, defaultOpen: true }));
  assert.match(html, /data-testid="skill-hub-custom-packs"/);
  assert.match(html, /Ship releases reliably/);
  assert.match(html, /missing-skill/, "pack membership includes skills not installed on this machine");
  assert.match(html, /1 installed/);
  assert.match(html, /Source/);
  assert.match(html, /Custom/);
  assert.match(html, /Core.*always on/i);
  const skill = html.slice(html.indexOf('data-testid="skill-hub-skill-deploy"'));
  assert.match(skill, /Acme tools/);
  assert.match(skill, /Release kit/, "one installed skill can show multiple pack badges");
  assert.doesNotMatch(html, /data-testid="skill-hub-pack-(create|edit|delete)/);
});

test("mobile Settings can inspect pack membership while mounting no settings writes", async () => {
  const { SettingsReadOnly } = await loadClientModule("plugin/client/factory/settings.tsx");
  const html = renderToStaticMarkup(createElement(SettingsReadOnly, { theme, view: healthyView({ skillHub: packHub() }), section: "skills-tools" }));
  assert.match(html, /data-testid="skill-hub-custom-packs"/);
  for (const value of ["Acme tools", "Release kit", "Ship releases reliably", "deploy", "missing-skill", "1 installed"]) assert.ok(html.includes(value), value);
  assert.match(html, /Core.*always on/i);
  assert.doesNotMatch(html, /<button|<input/, "inspection mounts no write controls");
});

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


test("Settings creates a custom pack from installed skill selection", async () => {
  const { SkillHubCard } = await loadClientModule("plugin/client/factory/skill-hub.tsx");
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const saved: unknown[] = [];
    const root = createRoot(container);
    await act(() => root.render(createElement(SkillHubCard, { theme, hub: packHub(), busy: false, savePack: (input: unknown) => { saved.push(input); return Promise.resolve(true); }, deletePack: async () => true })));
    const click = async (id: string) => { const button = container.querySelector(`[data-testid="${id}"]`) as HTMLElement; assert.ok(button, id); await act(() => button.click()); };
    const fill = async (id: string, value: string) => { const input = container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement; assert.ok(input, id); await act(() => { input.value = value; input.dispatchEvent(new (input.ownerDocument.defaultView!.Event)("input", { bubbles: true })); }); };
    try {
      await click("skill-hub-pack-create");
      assert.equal((container.querySelector('[data-testid="skill-hub-pack-save"]') as HTMLButtonElement).disabled, true);
      await fill("skill-hub-pack-name", "Release tools");
      await fill("skill-hub-pack-description", "Ship safely");
      await click("skill-hub-pack-skill-deploy");
      await click("skill-hub-pack-save");
      assert.deepEqual(saved, [{ name: "Release tools", description: "Ship safely", skills: ["deploy"] }]);
    } finally { await act(() => root.unmount()); }
  });
});

test("Settings edits a custom pack's name, description and membership, then confirms deletion", async () => {
  const { SkillHubCard } = await loadClientModule("plugin/client/factory/skill-hub.tsx");
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const saved: unknown[] = [];
    const deleted: string[] = [];
    const root = createRoot(container);
    await act(() => root.render(createElement(SkillHubCard, { theme, hub: packHub(), busy: false,
      savePack: async (input: unknown) => { saved.push(input); return true; },
      deletePack: async (id: string) => { deleted.push(id); return true; },
    })));
    const click = async (id: string) => { const button = container.querySelector(`[data-testid="${id}"]`) as HTMLElement; assert.ok(button, id); await act(() => button.click()); };
    const fill = async (id: string, value: string) => { const input = container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement; await act(() => { input.value = value; input.dispatchEvent(new (input.ownerDocument.defaultView!.Event)("input", { bubbles: true })); }); };
    try {
      assert.equal(container.querySelector('[data-testid="skill-hub-pack-edit-source-acme"]'), null, "source packs cannot be edited");
      await click("skill-hub-pack-edit-custom-release");
      assert.equal((container.querySelector('[data-testid="skill-hub-pack-name"]') as HTMLInputElement).value, "Release kit");
      await fill("skill-hub-pack-name", "Release and verify");
      await fill("skill-hub-pack-description", "");
      await click("skill-hub-pack-skill-deploy");
      await click("skill-hub-pack-skill-tdd");
      await click("skill-hub-pack-save");
      assert.deepEqual(saved, [{ id: "custom-release", name: "Release and verify", skills: ["missing-skill", "tdd"] }], "editing retains unavailable members until explicitly removed");
      assert.equal(container.querySelector('[data-testid="skill-hub-pack-editor"]'), null);
      await click("skill-hub-pack-delete-custom-release");
      assert.deepEqual(deleted, [], "first press asks for confirmation");
      await click("skill-hub-pack-delete-custom-release");
      assert.deepEqual(deleted, ["custom-release"]);
    } finally { await act(() => root.unmount()); }
  });
});

test("Settings keeps an unsaved pack open after failure and fences writes while busy", async () => {
  const { SkillHubCard } = await loadClientModule("plugin/client/factory/skill-hub.tsx");
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    const props = { theme, hub: packHub(), busy: false, savePack: async () => false, deletePack: async () => false };
    const click = async (id: string) => { await act(() => (container.querySelector(`[data-testid="${id}"]`) as HTMLElement).click()); };
    try {
      await act(() => root.render(createElement(SkillHubCard, props)));
      await click("skill-hub-pack-edit-custom-release");
      await click("skill-hub-pack-save");
      assert.ok(container.querySelector('[data-testid="skill-hub-pack-editor"]'), "failure preserves the draft for retry");
      await act(() => root.render(createElement(SkillHubCard, { ...props, busy: true })));
      for (const id of ["skill-hub-pack-create", "skill-hub-pack-save", "skill-hub-pack-edit-custom-release", "skill-hub-pack-delete-custom-release"]) {
        assert.equal((container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).disabled, true, id);
      }
    } finally { await act(() => root.unmount()); }
  });
});

test("Settings Diagnostics hosts validated Gate queue concurrency knob (no live queue monitor) and mobile stays read-only", async () => {
  const { DiagnosticsBody, SettingsReadOnly } = await loadClientModule("plugin/client/factory/settings.tsx");
  const roHtml = renderToStaticMarkup(createElement(SettingsReadOnly, { theme, view: healthyView({ gateQueueConcurrency: 3 }), section: "diagnostics" }));
  assert.match(roHtml, /Gate queue concurrency/);
  assert.match(roHtml, />3</);
  assert.doesNotMatch(roHtml, /<button|<input/, "mobile Diagnostics stays read-only");

  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const saved: number[] = [];
    const root = createRoot(container);
    const fill = async (id: string, value: string) => {
      const input = container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
      assert.ok(input, id);
      await act(() => {
        input.value = value;
        input.dispatchEvent(new (input.ownerDocument.defaultView!.Event)("input", { bubbles: true }));
      });
    };
    const click = async (id: string) => {
      const btn = container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;
      assert.ok(btn, id);
      await act(() => btn.click());
    };
    try {
      await act(() =>
        root.render(
          createElement(DiagnosticsBody, {
            theme,
            view: healthyView({ gateQueueConcurrency: 2 }),
            busy: false,
            onSetGateQueueConcurrency: async (n: number) => {
              saved.push(n);
              return true;
            },
          }),
        ),
      );
      const html = container.innerHTML;
      assert.doesNotMatch(html, /Pause|Resume|Cancel item|running Gates/i, "Settings must NEVER mount live queue monitor controls");

      const input = container.querySelector('[data-testid="gate-queue-concurrency-input"]') as HTMLInputElement;
      assert.equal(input.value, "2");
      assert.equal((container.querySelector('[data-testid="gate-queue-concurrency-save"]') as HTMLButtonElement).disabled, true, "unchanged value disables Save");

      for (const bad of ["0", "-1", "abc", "1.5"]) {
        await fill("gate-queue-concurrency-input", bad);
        assert.match(container.textContent ?? "", /whole number ≥ 1/i, `invalid ${bad} shows inline validation message`);
        assert.equal((container.querySelector('[data-testid="gate-queue-concurrency-save"]') as HTMLButtonElement).disabled, true, `invalid ${bad} disables Save`);
      }
      assert.deepEqual(saved, []);

      await fill("gate-queue-concurrency-input", "4");
      assert.equal((container.querySelector('[data-testid="gate-queue-concurrency-save"]') as HTMLButtonElement).disabled, false);
      await click("gate-queue-concurrency-save");
      assert.deepEqual(saved, [4]);
    } finally {
      await act(() => root.unmount());
    }
  });
});
