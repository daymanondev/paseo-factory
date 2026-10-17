/**
 * The Factory surface's client half (v0.0.17, ADR 0012 §1) — ticket 04's
 * seam. The client bundle renders inside the Paseo host, so node cannot
 * mount it; the observable contract here is the source the Hermes gate
 * (scripts/check-bundle.mjs) bundles: the fourth tab's vocabulary, the
 * shell's badge-counts + RPC wiring, and the PluginsPane's spec-named
 * renders. Structural pins only — runtime behavior stays behind the
 * surface-rpc seam (test/surface-rpc.test.ts) and the bundle gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./helpers.ts";

const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

test("TabId grows its fourth value and the TabBar renders the Plugins tab with the Blocks icon", () => {
  const pill = read("plugin/client/kit/pill.tsx");
  assert.match(pill, /export type TabId = "tasks" \| "seats" \| "timeline" \| "plugins";/);
  assert.match(pill, /\{ id: "plugins", label: "Plugins", icon: "Blocks" \}/);
});

test("the TabBar badge keeps its count > 0 rendering law — zero running companions shows no badge", () => {
  const pill = read("plugin/client/kit/pill.tsx");
  assert.match(
    pill,
    /typeof count === "number" && count > 0/,
    "the pre-existing law a count chip renders only when count > 0 stays untouched (the counts formula alone is this ticket's mandate)",
  );
});

test("FactoryShell passes plugins: running companions count and renders PluginsPane in the tab === \"plugins\" slot", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /plugins: view\.companions\.filter\(\(c\) => c\.status === "running"\)\.length/, "the spec's exact counts formula");
  assert.match(shell, /tab === "plugins" \?/);
  assert.match(shell, /<PluginsPane/);
});

test("FactoryShell owns the plugins RPC pair — one useRpc per contract, dispatched through act()", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /pluginsInstall, pluginsManage/);
  assert.match(shell, /useRpc\(pluginsInstall\)/);
  assert.match(shell, /useRpc\(pluginsManage\)/);
  assert.match(shell, /pluginsInstallCall\(/);
  assert.match(shell, /pluginsManageCall\(/);
});

test("PluginsPane exists as a pure render of the view plus action callbacks — no useRpc inside", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(plugins, /export function PluginsPane\(/);
  assert.match(plugins, /export interface PluginsActions/);
  assert.ok(!plugins.includes("useRpc"), "the Shell owns the RPC calls (the TasksPane/SeatsPane/TimelinePane law)");
});

test("PluginsPane renders the summary header — the ecosystem explainer, X of N active on this daemon, and Install All whenever any companion is not_installed", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(plugins, /status === "running"/);
  assert.match(plugins, /active on this daemon/);
  assert.match(plugins, /\.some\(\(c\) => c\.status === "not_installed"\)/, "Install All appears exactly when a companion is uninstalled");
  assert.match(plugins, /label="Install All"/);
  assert.match(plugins, /actions\.install\("all"\)/);
});

test("each companion card renders the header row — sidebar icon, title, plugin id badge, the four status pills, and the Active in Sidebar pill when running", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(plugins, /companion\.sidebarIcon/, "the catalog's Flame / Network icon drives the card icon");
  assert.match(plugins, /label: "Running"/);
  assert.match(plugins, /label: "Disabled"/);
  assert.match(plugins, /label: "Failed"/);
  assert.match(plugins, /label: "Not Installed"/);
  assert.match(plugins, /Active in Sidebar/);
  assert.match(plugins, /companion\.sidebarLabel/);
  assert.match(plugins, /companion\.capabilities\.map\(/, "capability pills (Scout Pool, OSS Lab, …)");
});

test("each card renders the installation metadata row — canonicalSource when not_installed; installKind, installedSource, short currentRevision when installed", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(plugins, /companion\.canonicalSource/);
  assert.match(plugins, /companion\.installKind/);
  assert.match(plugins, /companion\.installedSource/);
  assert.match(plugins, /companion\.currentRevision/);
  assert.match(plugins, /\.slice\(0, 7\)/, "the short sha display");
});

test("each card renders an error banner whenever the daemon reported one", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(plugins, /companion\.error !== null/);
});

test("not_installed cards show Install plus the Custom source… toggle expanding Source/Ref inputs and Install Custom", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(plugins, /label="Install"/);
  assert.match(plugins, /Custom source/);
  assert.match(plugins, /Install Custom/);
  assert.match(plugins, /git:daymanondev\/\$\{[^}]+}:plugin or \/path\/to\/plugin/, "the Source input's placeholder");
  assert.match(plugins, /Ref \(branch\/tag\/commit\)/);
  assert.match(plugins, /companion\.id as CompanionId/, "the card's id derives from the view's companion id (the fold's catalog join), not a re-listed constant");
  assert.match(plugins, /actions\.install\(id, /, "Install Custom rides the custom source and ref through the install action");
});

test("installed cards show the state-correct action bar — Disable/Enable by enabled, Update only for git/npm installs, Reload, Remove", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(plugins, /label="Disable"/);
  assert.match(plugins, /label="Enable"/);
  assert.match(plugins, /companion\.enabled \?/);
  assert.match(plugins, /companion\.installKind === "git" \|\| companion\.installKind === "npm"/, "Update appears only for remote installs");
  assert.match(plugins, /label="Update"/);
  assert.match(plugins, /label="Reload"/);
  assert.match(plugins, /label="Remove"/);
  assert.match(plugins, /actions\.manage\(id, "(enable|disable|reload|update|remove)"\)/);
});

test("the one FactoryShell still hosts all three entries — the fourth tab needs no entry change", () => {
  const entries = read("plugin/client/factory/entries.tsx");
  assert.equal((entries.match(/<FactoryShell/g) ?? []).length, 3, "global screen, settings screen, and workspace panel all render the one shell");
});
