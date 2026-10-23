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
import {
  formatPluginCardProgressPill,
  formatToolbarProgressPill,
  isCoreSelfRestartError,
  isPluginTargetedByAct,
  resolveCoreRestartWatch,
} from "../plugin/client/factory/plugin-feedback.ts";
import {
  KANBAN_COLUMNS,
  groupTasksForKanban,
  kanbanColumnForStatus,
  projectNameForTask,
} from "../plugin/client/factory/kanban.ts";
import type { KanbanColumnId } from "../plugin/client/factory/kanban.ts";
import type { CompanionPluginView, FactoryView, TaskView } from "../plugin/shared/view.ts";

const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

test("TabId grows its five values (including vault) and the TabBar renders the Vault and Plugins tabs", () => {
  const pill = read("plugin/client/kit/pill.tsx");
  assert.match(pill, /export type TabId = "tasks" \| "seats" \| "timeline" \| "vault" \| "plugins";/);
  assert.match(pill, /\{ id: "vault", label: "Vault", icon: "Shield" \}/);
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

test("PluginsPane renders the summary header — the ecosystem explainer, X of N active on this daemon, and Install All whenever any public companion is not_installed", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(plugins, /status === "running"/);
  assert.match(plugins, /active on this daemon/);
  assert.match(
    plugins,
    /\.some\(\(c\) => c\.access === "public" && c\.status === "not_installed"\)/,
    "Install All appears exactly when a public companion is uninstalled (v0.0.30: private companions never keep it lit)",
  );
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

// ---- native seat starts & live seat states (v0.0.27, ADR 0017 §3) ---------------------------

test("v0.0.27 (ADR 0017 §3): the Header renders no Start Supervisor / Start Lead buttons — a live seat shows its state plus an Open jump, a vacant seat shows the picker hint", () => {
  const header = read("plugin/client/factory/header.tsx");
  assert.ok(!header.includes("Start Supervisor"), "the Start Supervisor button is gone from the persistent Header");
  assert.ok(!header.includes("Start Lead"), "the Start Lead button is gone from the persistent Header");
  assert.match(header, /view\.supervisor !== null \?/, "the Supervisor controls render only while the seat lives (agentId !== null)");
  assert.match(header, /view\.lead !== null \?/, "the Lead controls render only while the seat lives (agentId !== null)");
  assert.match(header, /label="Open Supervisor"/, "a live Supervisor renders the Open Supervisor jump");
  assert.match(header, /label="Open Lead"/, "a live Lead renders the Open Lead jump");
  assert.match(header, /onPress=\{\(\) => actions\.openSupervisor\(\)\}/, "Open Supervisor rides the bare navigation action");
  assert.match(header, /onPress=\{\(\) => actions\.openLead\(\)\}/, "Open Lead rides the bare navigation action");
  assert.match(header, /name="Supervisor" status=\{view\.supervisor\.status\}/, "the live Supervisor's daemon state (running / idle) renders beside the jump");
  assert.match(header, /name="Lead" status=\{view\.lead\.status\}/, "the live Lead's daemon state renders beside the jump");
  assert.ok(header.includes('Select "Supervisor (Factory)" in New Chat to start'), "the vacant Supervisor hint is verbatim from Implementation Decision 3");
  assert.ok(header.includes("Spawned automatically by Supervisor"), "the vacant Lead hint is verbatim from Implementation Decision 3");
});

test("v0.0.27 (ADR 0017 §3): Seats & Models renders no Start Supervisor / Start Lead buttons — vacant seats carry the picker hints, live seats keep Open / Rotate / Revoke", () => {
  const seats = read("plugin/client/factory/seats.tsx");
  assert.ok(!seats.includes("Start Supervisor"), "the Seats & Models view renders no Start Supervisor button");
  assert.ok(!seats.includes("Start Lead"), "the Seats & Models view renders no Start Lead button");
  assert.match(seats, /title="Supervisor — not started"/, "the vacant Supervisor node names its not-started state");
  assert.match(seats, /title="Lead — not started"/, "the vacant Lead node names its not-started state");
  assert.ok(seats.includes('Select "Supervisor (Factory)" in New Chat to start'), "the vacant Supervisor node carries the verbatim picker hint");
  assert.ok(seats.includes("Spawned automatically by Supervisor"), "the vacant Lead node carries the verbatim spawned-by-Supervisor hint");
  assert.match(seats, /label="Open"/, "a live seat's card keeps its Open jump link");
  assert.match(seats, /actions\.openAgent\(agent\.id\)/, "the Open link rides navigation to the live agent's conversation");
  assert.match(seats, /retireLabel="Revoke Supervisor"/, "a live Supervisor keeps its Revoke action");
  assert.match(seats, /retireLabel="Rotate Lead"/, "a live Lead keeps its Rotate action");
  assert.match(seats, /onRetire=\{actions\.revokeSupervisor\}/, "Revoke rides the revokeSupervisor action");
  assert.match(seats, /onRetire=\{actions\.rotateLead\}/, "Rotate rides the rotateLead action");
});

test("v0.0.27 (ADR 0017 §3): FactoryShell drops the ensure/dispatch seat wiring — Open jumps navigate straight to the live seat's conversation", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.ok(!shell.includes("supervisorEnsure"), "the supervisorEnsure RPC import and binding are gone");
  assert.ok(!shell.includes("leadEnsure"), "the leadEnsure RPC import and binding are gone");
  assert.ok(!shell.includes("leadDispatch"), "the leadDispatch RPC import and binding are gone");
  assert.match(shell, /const agentId = view\.supervisor\?\.id;/, "Open Supervisor resolves the live Supervisor's agentId from the snapshot");
  assert.match(shell, /const agentId = view\.lead\?\.id;/, "Open Lead resolves the live Lead's agentId from the snapshot");
  assert.match(shell, /navigation\?\.openAgent\(\{ agentId, serverId \}\)/, "both jumps ride navigation.openAgent — no act() and no RPC behind them");
  assert.ok(!shell.includes("supervisorLive") && !shell.includes("leadLive"), "the dead live-boolean props are deleted, not left dangling");
});

// ---- the Lead telemetry trio (v0.0.20, ADR 0013 §6) ----------------

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

// ---- Dedicated Vault Tab & De-cluttered Header (v0.0.35 Seam 2.1, ADR 0025, amending ADR 0009/0014) ----

test("v0.0.35 Seam 2.1: VaultPane / VaultSyncBar moves out of Header into the dedicated Vault tab (tab === \"vault\") and Settings screen with 3-state gh onboarding, Sync Vault, + Import Key drawer, and ⚙ drawer, while Header drops <VaultSyncBar and KPI StatTile cards", () => {
  const header = read("plugin/client/factory/header.tsx");
  assert.ok(!header.includes("<VaultSyncBar"), "Header no longer renders VaultSyncBar above the TabBar");
  assert.ok(!header.includes("function StatTile("), "Header no longer defines the 5 KPI StatTile cards");
  assert.ok(!header.includes("<StatTile"), "Header no longer renders KPI StatTile cards above the TabBar");

  const vault = read("plugin/client/factory/vault.tsx");
  assert.match(vault, /export function VaultSyncBar\(/, "VaultSyncBar is exported from vault.tsx");
  assert.match(vault, /export function VaultPane\(/, "VaultPane is exported from vault.tsx");
  // State 1: !vault.configured && !vault.ghAuthenticated
  assert.match(vault, /gh auth login --web -p https/, "State 1 shows the exact gh auth login command");
  assert.match(vault, /Copy Command/, "State 1 offers a 1-click Copy Command button");
  assert.match(vault, /Check GitHub Login/, "State 1 offers a Check GitHub Login button");
  // State 2: !vault.configured && vault.ghAuthenticated
  assert.match(vault, /Enable & Sync Vault/, "State 2 offers the single primary Enable & Sync Vault CTA");
  assert.match(vault, /Setting up & Syncing…/, "State 2 shows in-flight Setting up & Syncing… label");
  // State 3: vault.configured
  assert.match(vault, /Sync Vault/, "State 3 offers the single primary Sync Vault CTA");
  assert.match(vault, /Syncing Vault…/, "State 3 shows in-flight Syncing Vault… label");
  assert.match(vault, /ASC \.p8/, "readiness pill for ASC .p8");
  assert.match(vault, /GPlay JSON/, "readiness pill for GPlay JSON");
  assert.match(vault, /Apps: \$\{vault\.hydratedApps\.length\}/, "readiness pill for hydrated Apps count");
  // + Import Key drawer & ⚙ drawer
  assert.match(vault, /\+ Import Key/, "renders + Import Key drawer toggle");
  assert.match(vault, /Import & Sync/, "Import Key drawer submits via Import & Sync");
  assert.match(vault, /ascKeyPath/, "Import Key drawer collects ascKeyPath");
  assert.match(vault, /ascKeyId/, "Import Key drawer collects ascKeyId");
  assert.match(vault, /ascIssuer/, "Import Key drawer collects ascIssuer");
  assert.match(vault, /gplayKeyPath/, "Import Key drawer collects gplayKeyPath");
  assert.match(vault, /Save Config/, "⚙ drawer keeps Save Config for custom repo/branch/passphrase");
  assert.match(vault, /Direct Hydrate \(gh api\)/, "⚙ drawer keeps Direct Hydrate (gh api)");
  assert.match(vault, /vaultNote/, "VaultSyncBar renders the inline vaultNote banner");

  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /tab === "vault" \?/, "FactoryShell renders VaultPane in the tab === \"vault\" slot");
  assert.match(shell, /<VaultPane/, "FactoryShell mounts VaultPane");
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

// ---- Owner-Only Project Reset & Delete + Project-Centered Header (v0.0.24 ADR 0015 §6; v0.0.35 Seam 2.2, ADR 0024/0025) ----

test("v0.0.24 (ADR 0015 §6): Header renders two-step Reset Project -> Confirm Reset + Cancel with 5s auto-cancel, wired to projectReset RPC in FactoryShell", () => {
  const header = read("plugin/client/factory/header.tsx");
  assert.match(header, /resetProject\?:\s*\(\)\s*=>\s*void|resetProject\(\):\s*void/, "HeaderActions declares resetProject()");
  assert.match(header, /label="Reset Project"/, "Header renders Reset Project button when a project is selected");
  assert.match(header, /label="Confirm Reset"/, "first click flips to Confirm Reset");
  assert.match(header, /tone="statusDanger"/, "Confirm Reset is danger-styled");
  assert.match(header, /5000/, "auto-cancels confirmation state after 5 seconds");
  assert.match(header, /actions\.resetProject/, "Confirm Reset invokes actions.resetProject()");

  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /projectReset/, "FactoryShell imports projectReset RPC");
  assert.match(shell, /useRpc\(projectReset\)/, "FactoryShell binds useRpc(projectReset)");
  assert.match(shell, /resetProject/, "FactoryShell passes resetProject action to Header");
});

test("v0.0.35 Seam 2.2 (ADR 0024/0025): Header renders prominent Project Switcher, Missing folder statusDanger badge, + Add Project native folder picker with Paste path… fallback, Reset Project (hidden when missingRoot), and two-step Delete Project -> Confirm Delete wired to projectDelete in FactoryShell", () => {
  const header = read("plugin/client/factory/header.tsx");
  assert.match(header, /PROJECT SWITCHER|Project Switcher/i, "Header renders the prominent Project Switcher");
  assert.match(header, /label="All projects"/, "Project Switcher includes the All projects pill");
  assert.match(header, /missingRoot/, "Header checks missingRoot on discovered and active projects");
  assert.match(header, /label="Missing folder"/, "Header renders Missing folder badge when missingRoot is true");
  assert.match(header, /Folder deleted on disk/, "Header warns when active project folder was deleted on disk");
  assert.match(header, /label="\+ Add Project"/, "Header renders + Add Project primary action");
  assert.match(header, /actions\.pickProjectFolder/, "+ Add Project invokes actions.pickProjectFolder()");
  assert.match(header, /Paste path…/, "Header offers collapsible Paste path… fallback toggle");
  assert.match(header, /!project\.missingRoot/, "Reset Project is hidden when project.missingRoot === true");
  assert.match(header, /deleteProject\?:\s*\(\)\s*=>\s*void|deleteProject\(\):\s*void/, "HeaderActions declares deleteProject()");
  assert.match(header, /label="Delete Project"/, "Header renders Delete Project button when a project is selected");
  assert.match(header, /label="Confirm Delete"/, "first click on Delete Project flips to Confirm Delete");
  assert.match(header, /actions\.deleteProject/, "Confirm Delete invokes actions.deleteProject()");

  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /projectDelete/, "FactoryShell imports projectDelete RPC");
  assert.match(shell, /projectPickFolder/, "FactoryShell imports projectPickFolder RPC");
  assert.match(shell, /projectAdd/, "FactoryShell imports projectAdd RPC");
  assert.match(shell, /useRpc\(projectDelete\)/, "FactoryShell binds useRpc(projectDelete)");
  assert.match(shell, /useRpc\(projectPickFolder\)/, "FactoryShell binds useRpc(projectPickFolder)");
  assert.match(shell, /useRpc\(projectAdd\)/, "FactoryShell binds useRpc(projectAdd)");
  assert.match(shell, /deleteProject/, "FactoryShell wires deleteProject into Header actions");
  assert.match(shell, /pickProjectFolder/, "FactoryShell wires pickProjectFolder into Header actions");
});

// ---- Compact Plugins Tab, Core Card, Version Pills & On-Demand Update Check (v0.0.25, ADR 0012 §1–§4) ----

test("v0.0.25 (ADR 0012 §1–§4): PluginsPane renders compact 2-row cards, Core plugin card with CORE badge, version/update pills, Check for updates, conditional Update All, and collapsible Manage drawer", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(plugins, /view\.corePlugin/, "PluginsPane renders the Core plugin card at the top");
  assert.match(plugins, /label="CORE"/, "Core plugin card carries the CORE badge");
  assert.match(plugins, /Core plugin protected/, "Core plugin drawer explains that Disable/Remove are locked");
  assert.match(plugins, /formatVersionBadge/, "cards format semantic version + short revision badge");
  assert.match(plugins, /Update available/, "cards surface Update available pill when updateAvailable === true");
  assert.match(plugins, /Up to date/, "cards surface Up to date pill when updateAvailable === false");
  assert.match(plugins, /Check for updates/, "toolbar exposes Check for updates button");
  assert.match(plugins, /Update All \(\$\{updatableCount\}\)/, "toolbar exposes Update All (N) when updates exist");
  assert.match(plugins, /⋯ Manage/, "installed cards tuck secondary lifecycle controls behind ⋯ Manage drawer");
  assert.match(plugins, /remote && companion\.updateAvailable === true/, "primary Update CTA on the card header appears only when updateAvailable === true");

  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /pluginsCheckUpdates/, "FactoryShell imports pluginsCheckUpdates RPC");
  assert.match(shell, /useRpc\(pluginsCheckUpdates\)/, "FactoryShell binds useRpc(pluginsCheckUpdates)");
  assert.match(shell, /pluginsCheckUpdatesCall\(\{\}\)/, "FactoryShell invokes pluginsCheckUpdatesCall");
});

// ---- Private Companion Tier: Private pill & public-only Install All (v0.0.30, ADR 0012/0014) ----

test("v0.0.30 (ADR 0012/0014): CompanionCard renders the Private · Invite-only pill on the header row for private non-core companions", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(
    plugins,
    /!isCore && companion\.access === "private"/,
    "the pill renders only on non-Core cards whose companion is access === \"private\" (Implementation Decision 2)",
  );
  assert.match(plugins, /label="Private · Invite-only"/, "the spec's verbatim pill label");
  assert.match(
    plugins,
    /<Pill theme=\{theme\} label="Private · Invite-only" tone="statusWarning" \/>/,
    "the spec's exact Pill render — warning tone, no lit variant (Implementation Decision 2)",
  );
});

test("v0.0.30 (ADR 0012/0014): PluginsPane scopes Install All to public companions — anyUninstalled filters on access === \"public\"", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(
    plugins,
    /view\.companions\.some\(\(c\) => c\.access === "public" && c\.status === "not_installed"\)/,
    "the spec's exact anyUninstalled formula — a not_installed private factory-release-lab never keeps Install All lit (User Story 2)",
  );
  assert.ok(
    !plugins.includes('.some((c) => c.status === "not_installed")'),
    "the old access-blind formula is replaced, not left duplicated beside the public-only one",
  );
});

// ---- Seam 2: Pure Plugin Progress / Core Self-Restart Helpers & UI Source Pins (v0.0.34, ADR 0012) ----

test("v0.0.34 Seam 2.1a: isCoreSelfRestartError recognizes Plugin stopped: paseo-factory and transient disconnect during Core update/reload or Update All with Core", () => {
  assert.equal(
    isCoreSelfRestartError({
      target: "paseo-factory",
      action: "update",
      errorMessage: "Plugin stopped: paseo-factory",
      coreTargeted: true,
    }),
    true,
  );
  assert.equal(
    isCoreSelfRestartError({
      target: "paseo-factory",
      action: "reload",
      errorMessage: "Error: Plugin stopped: paseo-factory",
      coreTargeted: true,
    }),
    true,
  );
  assert.equal(
    isCoreSelfRestartError({
      target: "all",
      action: "update",
      errorMessage: "daemon socket closed before response",
      coreTargeted: true,
    }),
    true,
  );
  assert.equal(
    isCoreSelfRestartError({
      target: "all",
      action: "update",
      errorMessage: "Plugin stopped: paseo-factory",
      coreTargeted: false,
    }),
    false,
    "Update All when Core is not targeted must not mask errors as Core self-restart",
  );
  assert.equal(
    isCoreSelfRestartError({
      target: "factory-burn-lab",
      action: "update",
      errorMessage: "Plugin stopped: factory-burn-lab",
      coreTargeted: false,
    }),
    false,
    "non-Core plugin errors are never classified as Core self-restart",
  );
  assert.equal(
    isCoreSelfRestartError({
      target: "paseo-factory",
      action: "update",
      errorMessage: "Update the client to review plugin updates before applying them.",
      coreTargeted: true,
    }),
    false,
    "unrelated protocol or git errors on paseo-factory must surface as real errors",
  );
});

function makeCorePluginFixture(overrides: Partial<CompanionPluginView> = {}): CompanionPluginView {
  return {
    id: "paseo-factory",
    title: "Factory Core",
    tagline: "The verification core.",
    description: "Verification core.",
    canonicalSource: "git:daymanondev/paseo-factory:plugin",
    sidebarLabel: "Factory",
    sidebarIcon: "Blocks",
    capabilities: ["Contracts & Gates"],
    access: "public",
    status: "running",
    enabled: true,
    installKind: "git",
    installedSource: "git:daymanondev/paseo-factory:plugin",
    currentRevision: "0285a1c",
    version: "0.0.33",
    latestRevision: "383385c",
    commitsBehind: 1,
    updateAvailable: true,
    error: null,
    ...overrides,
  };
}

function makeViewWithCore(coreOverrides: Partial<CompanionPluginView> = {}): FactoryView {
  return {
    corePlugin: makeCorePluginFixture(coreOverrides),
  } as FactoryView;
}

test("v0.0.34 Seam 2.1b: resolveCoreRestartWatch waits on previousRevision, completes with statusSuccess on targetRevision, and fails with statusDanger on daemon error or timeout", () => {
  const waiting = resolveCoreRestartWatch({
    view: makeViewWithCore({ status: "running", currentRevision: "0285a1c" }),
    previousRevision: "0285a1c",
    targetRevision: "383385c",
    action: "update",
    elapsedMs: 2_000,
  });
  assert.deepEqual(waiting, { status: "waiting" });

  const completed = resolveCoreRestartWatch({
    view: makeViewWithCore({
      status: "running",
      currentRevision: "383385c9999999",
      version: "0.0.34",
      updateAvailable: false,
    }),
    previousRevision: "0285a1c1111111",
    targetRevision: "383385c",
    action: "update",
    elapsedMs: 3_000,
  });
  assert.deepEqual(completed, {
    status: "completed",
    note: {
      text: "Updated paseo-factory (0285a1c → 383385c) · v0.0.34 is now running",
      tone: "statusSuccess",
      pluginId: "paseo-factory",
    },
  });

  const reloadWaiting = resolveCoreRestartWatch({
    view: makeViewWithCore({ status: "running", currentRevision: "383385c", version: "0.0.34" }),
    previousRevision: "383385c",
    targetRevision: "383385c",
    action: "reload",
    elapsedMs: 200,
  });
  assert.deepEqual(reloadWaiting, { status: "waiting" });

  const reloadCompleted = resolveCoreRestartWatch({
    view: makeViewWithCore({ status: "running", currentRevision: "383385c", version: "0.0.34" }),
    previousRevision: "383385c",
    targetRevision: "383385c",
    action: "reload",
    elapsedMs: 1_000,
  });
  assert.deepEqual(reloadCompleted, {
    status: "completed",
    note: {
      text: "Reloaded paseo-factory on the daemon (v0.0.34)",
      tone: "statusSuccess",
      pluginId: "paseo-factory",
    },
  });

  const failedByError = resolveCoreRestartWatch({
    view: makeViewWithCore({ status: "failed", error: "Bundle syntax error in server/index.mjs" }),
    previousRevision: "0285a1c",
    targetRevision: "383385c",
    action: "update",
    elapsedMs: 4_000,
  });
  assert.deepEqual(failedByError, {
    status: "failed",
    note: {
      text: "Update failed on paseo-factory: Bundle syntax error in server/index.mjs",
      tone: "statusDanger",
      pluginId: "paseo-factory",
    },
  });

  const failedByTimeout = resolveCoreRestartWatch({
    view: makeViewWithCore({ status: "running", currentRevision: "0285a1c" }),
    previousRevision: "0285a1c",
    targetRevision: "383385c",
    action: "update",
    elapsedMs: 45_000,
    timeoutMs: 45_000,
  });
  assert.deepEqual(failedByTimeout, {
    status: "failed",
    note: {
      text: "Timed out waiting for paseo-factory to finish restarting on the daemon.",
      tone: "statusDanger",
      pluginId: "paseo-factory",
    },
  });

  // When no fresh post-restart snapshot has arrived yet (view === null), wait until timeoutMs, then fail.
  assert.deepEqual(
    resolveCoreRestartWatch({
      view: null,
      previousRevision: "383385c",
      targetRevision: "383385c",
      action: "reload",
      elapsedMs: 2_000,
    }),
    { status: "waiting" },
  );
  assert.deepEqual(
    resolveCoreRestartWatch({
      view: null,
      previousRevision: "383385c",
      targetRevision: "383385c",
      action: "reload",
      elapsedMs: 45_000,
      timeoutMs: 45_000,
    }),
    {
      status: "failed",
      note: {
        text: "Timed out waiting for paseo-factory to finish restarting on the daemon.",
        tone: "statusDanger",
        pluginId: "paseo-factory",
      },
    },
  );
});

test("v0.0.34 Seam 2.2: formatPluginCardProgressPill and formatToolbarProgressPill format live elapsed strings for update, restarting-core, install, and reload", () => {
  const coreCard = makeCorePluginFixture({
    currentRevision: "0285a1c",
    latestRevision: "383385c",
    updateAvailable: true,
  });
  const burnLabNotInstalled = makeCorePluginFixture({
    id: "factory-burn-lab",
    title: "Burn Lab",
    status: "not_installed",
    enabled: false,
    installKind: null,
    installedSource: null,
    currentRevision: null,
    latestRevision: null,
    updateAvailable: null,
  });

  assert.equal(
    formatPluginCardProgressPill(
      coreCard,
      {
        kind: "manage",
        target: "paseo-factory",
        action: "update",
        startedAt: 1000,
        fromRevision: "0285a1c",
        targetRevision: "383385c",
      },
      4,
    ),
    "Updating 0285a1c → 383385c… · 4s",
  );

  assert.equal(
    formatPluginCardProgressPill(
      coreCard,
      {
        kind: "restarting-core",
        target: "paseo-factory",
        action: "update",
        startedAt: 1000,
        fromRevision: "0285a1c",
        targetRevision: "383385c",
      },
      3,
    ),
    "Reloading Core → 383385c… · 3s",
  );

  assert.equal(
    formatPluginCardProgressPill(
      burnLabNotInstalled,
      {
        kind: "install",
        target: "factory-burn-lab",
        startedAt: 1000,
      },
      5,
    ),
    "Installing from GitHub… · 5s",
  );

  assert.equal(
    formatPluginCardProgressPill(
      coreCard,
      {
        kind: "manage",
        target: "paseo-factory",
        action: "reload",
        startedAt: 1000,
      },
      2,
    ),
    "Reloading plugin… · 2s",
  );

  assert.equal(
    formatPluginCardProgressPill(
      burnLabNotInstalled,
      {
        kind: "manage",
        target: "paseo-factory",
        action: "update",
        startedAt: 1000,
      },
      4,
    ),
    null,
    "non-targeted cards show no progress pill",
  );

  assert.equal(
    isPluginTargetedByAct(
      coreCard,
      { kind: "restarting-core", target: "paseo-factory", action: "reload", startedAt: 1000 },
      { kind: "restarting-core", action: "reload" },
    ),
    true,
  );
  assert.equal(
    isPluginTargetedByAct(
      coreCard,
      { kind: "restarting-core", target: "paseo-factory", action: "reload", startedAt: 1000 },
      { kind: "restarting-core", action: "update" },
    ),
    false,
    "a Core reload restart must not match an update-targeted check",
  );

  assert.equal(formatToolbarProgressPill(null, true, 0), "Checking updates…");
  assert.equal(
    formatToolbarProgressPill({ kind: "manage", target: "paseo-factory", action: "update", startedAt: 1000 }, false, 4),
    "Updating paseo-factory… · 4s",
  );
  assert.equal(
    formatToolbarProgressPill({ kind: "restarting-core", target: "paseo-factory", action: "update", startedAt: 1000 }, false, 3),
    "Reloading Core paseo-factory… · 3s",
  );
  assert.equal(
    formatToolbarProgressPill({ kind: "manage", target: "all", action: "update", startedAt: 1000 }, false, 6),
    "Updating All… · 6s",
  );
  assert.equal(
    formatToolbarProgressPill({ kind: "install", target: "factory-burn-lab", startedAt: 1000 }, false, 2),
    "Installing factory-burn-lab… · 2s",
  );
  assert.equal(formatToolbarProgressPill(null, false, 0), null);
});

test("v0.0.34 Seam 2.3: PluginsPane and FactoryShell wire live elapsed progress pills, in-flight button labels, persistent inline pluginsNote banner, per-card cardError, and Core self-restart tracking", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  assert.match(plugins, /formatPluginCardProgressPill/, "PluginsPane re-exports and invokes formatPluginCardProgressPill");
  assert.match(plugins, /formatToolbarProgressPill/, "PluginsPane re-exports and invokes formatToolbarProgressPill");
  assert.match(plugins, /isCoreSelfRestartError/, "plugins.tsx re-exports isCoreSelfRestartError");
  assert.match(plugins, /resolveCoreRestartWatch/, "plugins.tsx re-exports resolveCoreRestartWatch");
  assert.match(plugins, /ActivePluginAct/, "plugins.tsx re-exports ActivePluginAct");
  assert.match(plugins, /PluginsNote/, "plugins.tsx re-exports PluginsNote");

  assert.match(plugins, /pluginsNote !== null/, "PluginsPane renders the persistent inline pluginsNote banner");
  assert.match(plugins, /label="Dismiss"/, "pluginsNote banner includes a Dismiss button");
  assert.match(
    plugins,
    /\[companion\.error,\s*cardError\]\.filter\(Boolean\)\.join\(" · "\)/,
    "CompanionCard renders both daemon error and action cardError in the red error box",
  );

  assert.match(plugins, /Updating… \(\$\{elapsedSeconds\}s\)/, "card Update button shows elapsed seconds");
  assert.match(plugins, /Reloading Core… \(\$\{elapsedSeconds\}s\)/, "Core Update/Reload button shows Reloading Core with elapsed seconds");
  assert.match(plugins, /Installing… \(\$\{elapsedSeconds\}s\)/, "card Install button shows elapsed seconds");
  assert.match(plugins, /Updating All… \(\$\{elapsedSeconds\}s\)/, "toolbar Update All button shows elapsed seconds");
  assert.match(plugins, /Installing All… \(\$\{elapsedSeconds\}s\)/, "toolbar Install All button shows elapsed seconds");
  assert.match(plugins, /Reloading…/, "drawer Reload button shows Reloading… in flight");
  assert.match(plugins, /Enabling…/, "drawer Enable button shows Enabling… in flight");
  assert.match(plugins, /Disabling…/, "drawer Disable button shows Disabling… in flight");
  assert.match(plugins, /Removing…/, "drawer Remove button shows Removing… in flight");

  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /activePluginAct/, "FactoryShell tracks activePluginAct");
  assert.match(shell, /elapsedSeconds/, "FactoryShell derives elapsedSeconds from now - activePluginAct.startedAt");
  assert.match(shell, /pluginsNote/, "FactoryShell tracks pluginsNote and passes it to PluginsPane");
  assert.match(shell, /pluginCardErrors/, "FactoryShell tracks per-card pluginCardErrors and passes cardErrors to PluginsPane");
  assert.match(shell, /isCoreSelfRestartError/, "FactoryShell classifies Core self-restart errors");
  assert.match(shell, /restarting-core/, "FactoryShell transitions into restarting-core polling state");
  assert.match(shell, /resolveCoreRestartWatch/, "FactoryShell resolves Core restart completion/failure against polled snapshots");
  assert.match(
    shell,
    /poll\.value !== null && poll\.error === null && poll\.at !== null && poll\.at >= activePluginAct\.startedAt/,
    "FactoryShell only evaluates fresh post-restart snapshots in resolveCoreRestartWatch",
  );
  assert.match(
    plugins,
    /isRestartingCoreForReload/,
    "CompanionCard separates Core reload restart from Core update restart so Reload never lights up Update buttons",
  );
});

// ---- 5-Column Kanban Tasks Board (v0.0.35 Seam 2.3, ADR 0025) ----

test("v0.0.35 Seam 2.3a: KANBAN_COLUMNS and groupTasksForKanban map all TaskStatus values into the 5 canonical Kanban columns in order", () => {
  const columnIds: KanbanColumnId[] = KANBAN_COLUMNS.map((c) => c.id);
  assert.deepEqual(columnIds, [
    "queued",
    "in_progress",
    "needs_attention",
    "ready_to_accept",
    "accepted",
  ]);
  assert.deepEqual(
    KANBAN_COLUMNS.map((c) => c.title),
    ["Queued", "In Progress", "Needs Attention", "Ready to Accept", "Accepted"],
  );

  assert.equal(kanbanColumnForStatus("contracted"), "queued");
  assert.equal(kanbanColumnForStatus("waiting"), "queued");
  assert.equal(kanbanColumnForStatus("running"), "in_progress");
  assert.equal(kanbanColumnForStatus("needs-human"), "needs_attention");
  assert.equal(kanbanColumnForStatus("red"), "needs_attention");
  assert.equal(kanbanColumnForStatus("ready-to-accept"), "ready_to_accept");
  assert.equal(kanbanColumnForStatus("accepted"), "accepted");

  const tasks = [
    { task: "t-contracted", status: "contracted" as const, workspace: "/repo/a" },
    { task: "t-waiting", status: "waiting" as const, workspace: "/repo/a" },
    { task: "t-running", status: "running" as const, workspace: "/repo/a" },
    { task: "t-needs-human", status: "needs-human" as const, workspace: "/repo/a" },
    { task: "t-red", status: "red" as const, workspace: "/repo/a" },
    { task: "t-ready", status: "ready-to-accept" as const, workspace: "/repo/a" },
    { task: "t-accepted", status: "accepted" as const, workspace: "/repo/a" },
  ];

  const grouped = groupTasksForKanban(tasks);
  assert.deepEqual(
    grouped.queued.map((t) => t.task),
    ["t-contracted", "t-waiting"],
  );
  assert.deepEqual(
    grouped.in_progress.map((t) => t.task),
    ["t-running"],
  );
  assert.deepEqual(
    grouped.needs_attention.map((t) => t.task),
    ["t-needs-human", "t-red"],
  );
  assert.deepEqual(
    grouped.ready_to_accept.map((t) => t.task),
    ["t-ready"],
  );
  assert.deepEqual(
    grouped.accepted.map((t) => t.task),
    ["t-accepted"],
  );

  // Also verify projectNameForTask resolves project names from discovered projects or workspace paths
  const projects = [
    { slug: "alpha-123456", root: "/Users/dev/alpha", name: "Alpha App" },
    { slug: "beta-654321", root: "/Users/dev/beta" },
  ];
  assert.equal(projectNameForTask({ workspace: "/Users/dev/alpha" }, projects), "Alpha App");
  assert.equal(
    projectNameForTask({ workspace: "/Users/dev/.paseo/projects/beta-654321/worktrees/t-01" }, projects),
    "beta",
  );
  assert.equal(projectNameForTask({ workspace: "/Users/dev/unregistered-repo" }, projects), "unregistered-repo");
});

test("v0.0.35 Seam 2.3b (ADR 0025): TasksPane renders the 5-column horizontal Kanban board with column counts, Total Cost pill, Project pill in All projects mode, Attempt #n/3 rung badges, evidence pills, direct Accept #n CTA on ready-to-accept cards, and TaskDetailModal without redundant workspace-path headers", () => {
  const tasks = read("plugin/client/factory/tasks.tsx");
  assert.match(tasks, /KANBAN_COLUMNS/, "tasks.tsx exports and iterates KANBAN_COLUMNS");
  assert.match(tasks, /groupTasksForKanban/, "tasks.tsx exports and invokes groupTasksForKanban");
  assert.match(tasks, /KanbanColumnId/, "tasks.tsx exports KanbanColumnId");
  assert.match(tasks, /ScrollView horizontal/, "TasksPane renders a horizontal Kanban board container");
  assert.match(tasks, /Total Cost/, "board toolbar renders compact Total Cost summary pill");
  assert.match(tasks, /view\.kpis\.totalCostUsd/, "Total Cost pill reads view.kpis.totalCostUsd");
  assert.ok(!tasks.includes("group.workspace"), "redundant workspace-path group headers are removed from TasksPane");
  assert.match(tasks, /view\.project === null/, "KanbanCard shows a Project pill only when view.project === null (All projects mode)");
  assert.match(tasks, /projectNameForTask/, "KanbanCard resolves the Project pill label via projectNameForTask");
  assert.match(tasks, /\/3/, "KanbanCard renders Attempt rung badge (#n/3)");
  assert.match(tasks, /↻ Respawned/, "KanbanCard renders ↻ Respawned badge when respawned");
  assert.match(tasks, /Gate green/, "KanbanCard renders Gate evidence pill");
  assert.match(tasks, /Eye \$\{lastEye\.outcome\.toUpperCase\(\)\}/, "KanbanCard renders Eye CLEAR/CONCERN evidence pill");
  assert.match(tasks, /Watch /, "KanbanCard renders Watch evidence pill");
  assert.match(tasks, /Cost \$\{costLabel\(task\)\}/, "KanbanCard renders Cost evidence pill");
  assert.match(tasks, /label=\{`Accept #\$\{green\.n\}`\}/, "ready-to-accept cards render direct Accept #n button");
  assert.match(tasks, /actions\.accept\(task\.task,\s*green!?\.n\)/, "Accept #n button invokes actions.accept");
  assert.match(tasks, /actions\.openDetail\(task\.task\)/, "clicking a Kanban card or Details opens TaskDetailModal");
  assert.match(tasks, /export function TaskDetailModal\(/, "tasks.tsx exports TaskDetailModal");

  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /TaskDetailModal/, "FactoryShell renders TaskDetailModal for selected Kanban cards");
});








