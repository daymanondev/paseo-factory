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

// ---- the always-visible seat buttons + Lead telemetry (v0.0.20, ADR 0013 §6) ----------------

test("the Header renders the Supervisor seat button whenever a Project is selected — Start when vacant, Open when live", () => {
  const header = read("plugin/client/factory/header.tsx");
  assert.match(header, /supervisorLive \? "Open Supervisor" : "Start Supervisor"/, "the label flips on the live seat (supervisorLive is view.supervisor !== null by shell construction)");
  assert.match(header, /onPress=\{\(\) => actions\.openSupervisor\(""\)\}/, "both labels ride the existing ensure-then-open action");
  assert.ok(
    !header.includes("supervisorLive && view.supervisor !== null"),
    "the old guard is gone — a brand-new Project (view.supervisor === null) still shows the header's seat action",
  );
});

test("the Header renders the symmetric Lead seat button beside it, wiring the once-voided leadLive prop", () => {
  const header = read("plugin/client/factory/header.tsx");
  assert.match(header, /leadLive \? "Open Lead" : "Start Lead"/, "the label flips on the live seat (leadLive is view.lead !== null by shell construction)");
  assert.match(header, /onPress=\{\(\) => actions\.openLead\(\)\}/, "the button rides the existing openLead action");
  assert.ok(!header.includes("void leadLive;"), "the prop is wired, no longer voided");
});

test("the seat buttons live unconditionally inside the Project Scope Bar's action row — no live-seat condition wraps them", () => {
  const header = read("plugin/client/factory/header.tsx");
  assert.match(header, /\{project !== null \? \(\n\s*<View style=\{\{ flexDirection: "row", alignItems: "center", gap: SPACING\[1\.5\]/, "the pair renders as one row gated only on a selected Project");
  assert.ok(!header.includes("? (\n            <Btn"), "no conditional hides a seat button behind a live seat");
});

test("the Lead card renders the 128k telemetry trio — usage pill, rotationState badge, queued mail count", () => {
  const seats = read("plugin/client/factory/seats.tsx");
  assert.match(
    seats,
    /label=\{`\$\{Math\.round\(agent\.contextUsedTokens \/ 1000\)\}k \/ 128k handoff`\}/,
    "the usage pill renders <used>k against the fixed 128k handoff mark (e.g. 94k / 128k handoff)",
  );
  assert.match(seats, /agent\.contextUsedTokens !== undefined && agent\.contextUsedTokens !== null/, "the pill appears only when the daemon answered usage");
  assert.match(seats, /label=\{agent\.rotationState\}/, "the rotationState badge renders the state itself");
  assert.match(
    seats,
    /agent\.rotationState === "handing_over" \? "accent" : agent\.rotationState === "rotation_pending" \? "statusWarning" : "foregroundMuted"/,
    "the badge's tone vocabulary — handing_over accent, rotation_pending warning, normal muted",
  );
  assert.match(
    seats,
    /label=\{`\$\{agent\.queuedMailCount\} queued`\}/,
    "the queued-mail pill renders N queued",
  );
  assert.match(seats, /agent\.queuedMailCount !== undefined && agent\.queuedMailCount > 0/, "the queued pill appears only when mail actually waits");
});

// ---- Built-In Header VaultSyncBar & 3-Layer Feedback (v0.0.22, ADR 0014) --------------------

test("Header exports and renders VaultSyncBar across all tabs with the 3-state gh onboarding, Sync Vault, + Import Key drawer, and ⚙ drawer", () => {
  const header = read("plugin/client/factory/header.tsx");
  assert.match(header, /export function VaultSyncBar\(/, "VaultSyncBar is exported from header.tsx");
  assert.match(header, /<VaultSyncBar/, "Header renders VaultSyncBar inside the persistent header");
  // State 1: !vault.configured && !vault.ghAuthenticated
  assert.match(header, /gh auth login --web -p https/, "State 1 shows the exact gh auth login command");
  assert.match(header, /Copy Command/, "State 1 offers a 1-click Copy Command button");
  assert.match(header, /Check GitHub Login/, "State 1 offers a Check GitHub Login button");
  // State 2: !vault.configured && vault.ghAuthenticated
  assert.match(header, /Enable & Sync Vault/, "State 2 offers the single primary Enable & Sync Vault CTA");
  assert.match(header, /Setting up & Syncing…/, "State 2 shows in-flight Setting up & Syncing… label");
  // State 3: vault.configured
  assert.match(header, /Sync Vault/, "State 3 offers the single primary Sync Vault CTA");
  assert.match(header, /Syncing Vault…/, "State 3 shows in-flight Syncing Vault… label");
  assert.match(header, /ASC \.p8/, "readiness pill for ASC .p8");
  assert.match(header, /GPlay JSON/, "readiness pill for GPlay JSON");
  assert.match(header, /Apps: \$\{vault\.hydratedApps\.length\}/, "readiness pill for hydrated Apps count");
  // + Import Key drawer & ⚙ drawer
  assert.match(header, /\+ Import Key/, "renders + Import Key drawer toggle");
  assert.match(header, /Import & Sync/, "Import Key drawer submits via Import & Sync");
  assert.match(header, /ascKeyPath/, "Import Key drawer collects ascKeyPath");
  assert.match(header, /ascKeyId/, "Import Key drawer collects ascKeyId");
  assert.match(header, /ascIssuer/, "Import Key drawer collects ascIssuer");
  assert.match(header, /gplayKeyPath/, "Import Key drawer collects gplayKeyPath");
  assert.match(header, /Save Config/, "⚙ drawer keeps Save Config for custom repo/branch/passphrase");
  assert.match(header, /Direct Hydrate \(gh api\)/, "⚙ drawer keeps Direct Hydrate (gh api)");
  assert.match(header, /vaultNote/, "VaultSyncBar renders the inline vaultNote banner");
});

test("FactoryShell removes PrivateVaultCard from the Plugins tab, wires vaultSync & vaultImport, and provides 3-layer feedback in act()", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.ok(!shell.includes("<PrivateVaultCard"), "PrivateVaultCard is no longer rendered inside FactoryShell");
  assert.match(shell, /vaultSync/, "FactoryShell imports and wires vaultSync");
  assert.match(shell, /vaultImport/, "FactoryShell imports and wires vaultImport");
  assert.match(shell, /useRpc\(vaultSync\)/);
  assert.match(shell, /useRpc\(vaultImport\)/);
  assert.match(shell, /busyAct/, "FactoryShell tracks busyAct for in-flight button labels");
  assert.match(shell, /vaultNote/, "FactoryShell tracks vaultNote for inline status feedback");
  assert.match(shell, /toast\.show\(summary, \{ variant: "success" \}\)/, "act() fires a green success toast whenever summary is returned");
});

// ---- Thinking Variant Sanitization in Seats & Models UI (v0.0.24, ADR 0015 §1) --------------

test("v0.0.24 (ADR 0015 §1): Seats & Models lane modal distinguishes thinkingOptions === [] from null, renders Default (none), and clears thinking on model/provider selection", () => {
  const seats = read("plugin/client/factory/seats.tsx");
  assert.match(seats, /advertisedThinking === null\s*\?\s*FALLBACK_THINKING_OPTIONS/, "only null metadata falls back to FALLBACK_THINKING_OPTIONS");
  assert.match(seats, /advertisedThinking\.length === 0/, "explicitly empty thinkingOptions [] produces [] choices and forces trimmedThinking = ''");
  assert.match(seats, /Default \(none\)/, "Step 3 renders active 'Default (none)' chip when model supports zero thinking variants");
  assert.match(
    seats,
    /!nextModel\.thinkingOptions \|\| nextModel\.thinkingOptions\.length === 0 \|\| !nextModel\.thinkingOptions\.some\(/,
    "selectModel clears thinking whenever nextModel.thinkingOptions is empty or omits the current thinking variant",
  );
});
