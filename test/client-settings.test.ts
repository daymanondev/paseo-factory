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

test("the surface registers exactly the Workspace panel, the Settings screen and one Command Center action", () => {
  const index = read("plugin/index.client.tsx");
  const registrations = [...index.matchAll(/client\.(add[A-Za-z]+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...registrations].sort(), ["addCommandCenterItem", "addSettingsScreen", "addWorkspacePanel"]);
  assert.match(index, /title: "Open Factory Panel"/);
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
