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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./helpers.ts";
import { planLiveSeatTransitions, providerFamilyOf } from "../plugin/client/kit/live-seats.ts";
import { headerPlans, pillPlans, reconcileDirectory } from "../plugin/client/kit/directory.ts";
import {
  formatPluginCardProgressPill,
  formatToolbarProgressPill,
  isCoreSelfRestartError,
  isPluginTargetedByAct,
  resolveCoreRestartWatch,
} from "../plugin/client/factory/plugin-feedback.ts";
import type { AgentView, CompanionPluginView, FactoryView, SeatDirectoryEntry } from "../plugin/shared/view.ts";

const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

test("v0.6.0 W8 (ADR 0056 §7): the interim tab bar is gone — the Settings screen's sections replace the Seats / Vault / Plugins tabs", () => {
  const pill = read("plugin/client/kit/pill.tsx");
  assert.doesNotMatch(pill, /TabBar|TabId/, "the tab bar and its ids are deleted");
  const settings = read("plugin/client/factory/settings.tsx");
  for (const title of ["Default models & Lane profiles", "Skills & Tools", "Plugins", "Vault", "Diagnostics"]) {
    assert.ok(settings.includes(title), `the Settings screen has a ${title} section`);
  }
});

test("FactoryShell renders PluginsPane (Plugins) and SkillsToolsPane (Skills & Tools) as Settings section bodies", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /plugins: \(\s*<PluginsPane/);
  assert.match(shell, /<SkillsToolsPane/);
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

test("the one FactoryShell hosts the two remaining entries — the workspace panel and the settings screen; no global screen, no sidebar row", () => {
  const entries = read("plugin/client/factory/entries.tsx");
  assert.equal((entries.match(/<FactoryShell/g) ?? []).length, 2, "settings screen and workspace panel render the one shell");
  assert.doesNotMatch(entries, /FactoryScreen|FactorySidebarItem|SidebarRow|SCREEN_ID/, "the global screen and the sidebar row are deleted");
});

test("v0.6.0 W4 (ADR 0056): the surface registers only the Workspace panel, the Settings screen, and one Command Center action", () => {
  const index = read("plugin/index.client.tsx");
  assert.equal((index.match(/client\.addWorkspacePanel\(/g) ?? []).length, 1);
  assert.equal((index.match(/client\.addSettingsScreen\(/g) ?? []).length, 1);
  assert.equal((index.match(/client\.addCommandCenterItem\(/g) ?? []).length, 1, "one Command Center action");
  assert.match(index, /title: "Open Factory Panel"/);
  assert.doesNotMatch(index, /client\.addScreen\(|addSidebarHeaderItem|retro|Retro|vaultSync/, "no global screen, sidebar row, Retro or Vault palette entry");
});

// ---- native seat starts & live seat states (v0.0.27, ADR 0017 §3) ---------------------------

test("v0.0.27 (ADR 0017 §3): FactoryShell drops the ensure/dispatch seat wiring — Open jumps navigate straight to the live seat's conversation", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.ok(!shell.includes("supervisorEnsure"), "the supervisorEnsure RPC import and binding are gone");
  assert.ok(!shell.includes("leadEnsure"), "the leadEnsure RPC import and binding are gone");
  assert.ok(!shell.includes("leadDispatch"), "the leadDispatch RPC import and binding are gone");
  assert.match(shell, /navigation\?\.openAgent\(\{ agentId, serverId \}\)/, "the Needs-you jump rides navigation.openAgent — no act() and no RPC behind it");
  assert.ok(!shell.includes("supervisorLive") && !shell.includes("leadLive"), "the dead live-boolean props are deleted, not left dangling");
});

// ---- the Lead telemetry trio (v0.0.20, ADR 0013 §6) ----------------

// ---- Dedicated Vault Tab & De-cluttered Header (v0.0.35 Seam 2.1, ADR 0025, amending ADR 0009/0014) ----

test("v0.0.35 Seam 2.1: VaultPane / VaultSyncBar moves out of Header into the dedicated Vault tab (tab === \"vault\") and Settings screen with 3-state gh onboarding, Sync Vault, + Import Key drawer, and ⚙ drawer, while Header drops <VaultSyncBar and KPI StatTile cards", () => {
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
  assert.match(shell, /vault: vaultPane/, "FactoryShell renders VaultPane as the Settings screen's Vault section");
  assert.match(shell, /<VaultPane/, "FactoryShell mounts VaultPane");
  assert.equal((shell.match(/<VaultPane/g) ?? []).length, 1, "FactoryShell defines a single shared <VaultPane element rather than duplicating JSX");
  assert.match(vault, /export function readAgo\(/, "vault.tsx exports shared readAgo helper");
});

test("v0.6.0 W5 (ADR 0056): the Header and the seat-card salvage are replaced by the Project panel — entries still forward the host layout so the shell can read the platform", () => {
  assert.throws(() => read("plugin/client/factory/header.tsx"), "header.tsx is deleted");
  assert.throws(() => read("plugin/client/factory/seat-card.tsx"), "seat-card.tsx is deleted");
  const entries = read("plugin/client/factory/entries.tsx");
  assert.match(entries, /layout=\{layout\}/, "entries.tsx forwards Paseo's layout prop to FactoryShell");
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
  const seats = read("plugin/client/factory/lane-editor.tsx");
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

test("v0.0.38 Seam 4 (ADR 0026 §3): planLiveSeatTransitions returns [] with no live seats, [] when only worker/watch/freshEyes change, \"in-place\" within one provider family, and \"retire\" across families", () => {
  const baseLanes = {
    supervisor: "claude/claude-sonnet-4-6",
    lead: "opencode/glm-5.1",
    worker: "pi/zai/glm-5.3",
    watch: "pi/zai/glm-5.3",
    freshEyes: "eye.json",
  };
  const supervisorAgent = { id: "agent-supervisor-1", title: null, status: "running", provider: "claude", model: null, thinking: null, seat: "supervisor", task: null, requiresAttention: null, cwd: null } as unknown as AgentView;
  const leadAgent = { id: "agent-lead-1", title: null, status: "running", provider: "opencode", model: null, thinking: null, seat: "lead", task: null, requiresAttention: null, cwd: null } as unknown as AgentView;

  // (a) No live seats: nothing to warn about, whatever the lanes do.
  assert.deepEqual(
    planLiveSeatTransitions(baseLanes, { ...baseLanes, supervisor: "codex/gpt-5.4" }, { supervisor: null, lead: null }),
    [],
  );

  // (b) Only worker/watch/freshEyes change — the standing seats are untouched.
  assert.deepEqual(
    planLiveSeatTransitions(baseLanes, { ...baseLanes, worker: "claude/claude-opus-4-6", watch: "copilot/gpt-5.4", freshEyes: "claude/claude-haiku-4-5" }, { supervisor: supervisorAgent, lead: leadAgent }),
    [],
    "a live seat whose lane value never changes is unaffected (User Story 17)",
  );

  // (c) Live Supervisor changes within the same provider family → in-place.
  const inPlace = planLiveSeatTransitions(baseLanes, { ...baseLanes, supervisor: "claude/claude-opus-4-6:high" }, { supervisor: supervisorAgent, lead: leadAgent });
  assert.deepEqual(inPlace, [
    {
      seat: "supervisor",
      agentId: "agent-supervisor-1",
      fromLane: "claude/claude-sonnet-4-6",
      toLane: "claude/claude-opus-4-6:high",
      fromProviderFamily: "claude",
      toProviderFamily: "claude",
      mode: "in-place",
    },
  ]);

  // (d) Live Supervisor AND Lead both cross provider families → retire (the Lead keeps its lane here, only the Supervisor moves).
  const retired = planLiveSeatTransitions(baseLanes, { ...baseLanes, supervisor: "codex/gpt-5.4:high", lead: "claude/claude-sonnet-4-6" }, { supervisor: supervisorAgent, lead: leadAgent });
  assert.deepEqual(retired, [
    {
      seat: "supervisor",
      agentId: "agent-supervisor-1",
      fromLane: "claude/claude-sonnet-4-6",
      toLane: "codex/gpt-5.4:high",
      fromProviderFamily: "claude",
      toProviderFamily: "codex",
      mode: "retire",
    },
    {
      seat: "lead",
      agentId: "agent-lead-1",
      fromLane: "opencode/glm-5.1",
      toLane: "claude/claude-sonnet-4-6",
      fromProviderFamily: "opencode",
      toProviderFamily: "claude",
      mode: "retire",
    },
  ]);

  // The provider family is the segment before the first "/" — a model id with its own slash (pi/zai/glm-5.3) still names the family "pi".
  assert.equal(providerFamilyOf("pi/zai/glm-5.3"), "pi");
  assert.equal(providerFamilyOf("claude/claude-opus-4-6:high"), "claude");
});

test("v0.0.38 Seam 4 (ADR 0026 §2): SeatsPane renders the Lane Profiles bar above the four active Lane Cards — chips, + Save as Profile…, Update \"<Profile>\", + Save as New Profile…, two-step Delete, and Reset to Machine Default", () => {
  const seats = read("plugin/client/factory/seats.tsx");
  assert.match(seats, /function LaneProfilesBar\(/, "the bar is its own component");
  assert.match(seats, /<LaneProfilesBar/, "SeatsPane mounts the LaneProfilesBar above the Lane Cards grid");
  assert.match(seats, /view\.profiles\.map\(\(profile\) =>/, "one chip per saved profile");
  assert.match(seats, /profile\.id === view\.activeProfileId/, "the active scope's profile chip is lit");
  assert.match(seats, /label="\+ Save as Profile…"/, "the base save action");
  assert.match(seats, /Update "\$\{activeProfile\.name\}"/, "the modified-scope Update action names the active profile");
  assert.match(seats, /view\.activeProfileModified && activeProfile !== null/, "Update and Save-as-New appear only when the scope drifted from its active profile");
  assert.match(seats, /label="\+ Save as New Profile…"/, "the modified-scope save-as-new action");
  assert.match(seats, /label="Confirm Delete"/, "the chip delete's second step");
  assert.match(seats, /label="Delete"/, "the chip delete's first step");
  assert.match(seats, /label="Cancel"/, "the chip delete's Cancel");
  assert.match(seats, /view\.hasProjectLaneOverride \?/, "Reset to Machine Default renders only for an overridden Project");
  assert.match(seats, /label="Reset to Machine Default"/, "the reset action's verbatim label");
  assert.match(seats, /actions\.deleteProfile\(profile\.id\)/, "Confirm Delete dispatches deleteProfile");
  assert.match(seats, /setTimeout\(\(\) => setDeletingProfileId\(null\), 5000\)/, "the two-step confirm auto-rearms after 5s — the header Reset/Delete pattern");
  assert.ok(!seats.includes("for (const lane of card.lanes) actions.setLane(lane, value)"), "the old per-lane save loop is gone, not left beside the batch path");
});

test("v0.0.38 Seam 4 (ADR 0026 §5): a multi-lane card saves through exactly ONE setLanesBatch RPC — single-lane cards keep setLane", () => {
  const seats = read("plugin/client/factory/seats.tsx");
  assert.match(
    seats,
    /if \(card\.lanes\.length === 1\) actions\.setLane\(card\.lanes\[0\]!, value\);\s*else actions\.setLanesBatch\(card\.lanes, value\);/,
    "one commit path: a single-lane card rides setLane, a multi-lane card rides ONE actions.setLanesBatch(card.lanes, value)",
  );
  assert.match(seats, /setLanesBatch\(lanes: LaneName\[\], value: string\): void;/, "SeatsActions declares the batch action");

  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /const update: Partial<Record<LaneName, string>> = {};/, "the shell folds the card's lanes into one batch update object");
  assert.match(shell, /lanesSetBatchCall\(\{ lanes: update/, "one factory.lanes.setBatch RPC per card save");
});

test("v0.7.0: model changes use the labelled inline action without a live-seat confirmation modal", () => {
  const seats = read("plugin/client/factory/seats.tsx");
  assert.doesNotMatch(seats, /LiveSeatConfirmModal|Confirm & Apply|setPending/, "the old confirmation step is removed from Settings and Project overrides");
});

test("v0.0.38 Seam 4 (ADR 0026 §2/§5): FactoryShell owns the machine lane/profile RPCs — one useRpc per contract, dispatched through act()", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /lanesSetBatch,/, "the setBatch contract import");
  assert.match(shell, /profilesSave,/, "the profiles.save contract import");
  assert.match(shell, /profilesApply,/, "the profiles.apply contract import");
  assert.match(shell, /profilesDelete,/, "the profiles.delete contract import");
  assert.match(shell, /useRpc\(lanesSetBatch\)/);
  assert.match(shell, /useRpc\(profilesSave\)/);
  assert.match(shell, /useRpc\(profilesApply\)/);
  assert.match(shell, /useRpc\(profilesDelete\)/);
  assert.match(shell, /profilesApplyCall\(\{ profileId/, "apply rides the profileId input field");
  assert.match(shell, /profilesDeleteCall\(\{ profileId \}\)/, "delete rides the profileId input field");
  assert.doesNotMatch(shell, /ProjectModelOverrides/, "Project overrides moved to inline chips in the main panel");
  assert.match(shell, /setLanesBatch: \(lanes: LaneName\[\], value\) =>/, "the batch action is wired into SeatsPane");
  assert.match(shell, /saveProfile: \(name, description\) =>/, "the save action is wired into SeatsPane");
  assert.match(shell, /updateProfile: \(profileId, name\) =>/, "the update action is wired into SeatsPane");
  assert.match(shell, /applyProfile: \(profileId\) =>/, "the apply action is wired into SeatsPane");
  assert.match(shell, /deleteProfile: \(profileId\) =>/, "the delete action is wired into SeatsPane");
  assert.match(shell, /resetLanes: \(\) =>/, "the reset action is wired into SeatsPane");
  assert.ok(!seats_includes_useRpc(), "SeatsPane stays a pure render — no useRpc inside (the panes' law)");
});

function seats_includes_useRpc(): boolean {
  return read("plugin/client/factory/seats.tsx").includes("useRpc");
}

test("v0.0.39 (ADR 0027): index.client.tsx Command Center items and client contributions strictly match Paseo's /^[a-z][a-z0-9-]*$/ id law", () => {
  const indexClient = read("plugin/index.client.tsx");
  const idPattern = /^[a-z][a-z0-9-]*$/;
  const ids = [...indexClient.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(ids, [
    "paseo-factory",
    "factory-open-panel",
  ]);
  for (const id of ids) {
    assert.match(id, idPattern, `client contribution id "${id}" must match /^[a-z][a-z0-9-]*$/ (no dots)`);
  }
});

test("PluginsPane and FactoryShell support 1-click Switch to GitHub and Switch source… for installed Core and Companion plugins", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  const shell = read("plugin/client/factory/shell.tsx");

  assert.match(plugins, /Switch to GitHub/, "installed local directory cards render 1-click Switch to GitHub button");
  assert.match(plugins, /Switch source…/, "installed cards render Switch source… toggle inside Manage drawer");
  assert.match(plugins, /Switch Source/, "installed cards render Switch Source action button");
  assert.match(plugins, /install\(target: ManageablePluginId \| "all"/, "PluginsActions.install accepts ManageablePluginId including paseo-factory");

  assert.equal(
    isCoreSelfRestartError({
      target: "paseo-factory",
      action: "install",
      errorMessage: "Plugin stopped: paseo-factory",
    }),
    true,
    "isCoreSelfRestartError recognizes Core source switch (action: install) disconnect",
  );

  const switchedToGit = resolveCoreRestartWatch({
    view: {
      corePlugin: {
        id: "paseo-factory",
        name: "Factory Core",
        tagline: "",
        description: "",
        canonicalSource: "git:daymanondev/paseo-factory:plugin",
        sidebarIcon: "GitMerge",
        access: "public",
        status: "running",
        enabled: true,
        installKind: "git",
        installedSource: "https://github.com/daymanondev/paseo-factory (plugin)",
        currentRevision: "0ea21a81",
        error: null,
      },
    } as unknown as FactoryView,
    previousRevision: null,
    targetRevision: null,
    action: "install",
    elapsedMs: 2000,
  });
  assert.equal(switchedToGit.status, "completed");
  if (switchedToGit.status === "completed") {
    assert.match(switchedToGit.note.text, /Switched paseo-factory to GitHub/);
  }
  assert.match(shell, /action: "install"/, "FactoryShell transitions to restarting-core with action: install when switching paseo-factory source");
});

test("v0.6.0 W4 (ADR 0056): no Kanban, Timeline, Retro or Seat graph source survives in the client", () => {
  for (const gone of ["tasks.tsx", "kanban.ts", "timeline.tsx", "seat-graph.tsx"]) {
    assert.throws(() => read(`plugin/client/factory/${gone}`), `${gone} is deleted`);
  }
  const seats = read("plugin/client/factory/seats.tsx");
  assert.doesNotMatch(seats, /Seat Graph|All projects|Retro/, "SeatsPane carries no Seat graph, All projects view or Retro wording");
  assert.doesNotMatch(seats, /No Project · View-only/, "SeatsPane is the machine-wide pane now — never view-only for want of a Project");
});

test("ADR 0036: FactoryShell renders the Prerequisite Setup Gate banner when companionTools are missing/incomplete and PluginsPane protects mandatory companionTools against Disable/Remove", () => {
  const settings = read("plugin/client/factory/settings.tsx");
  const shell = read("plugin/client/factory/shell.tsx");
  const plugins = read("plugin/client/factory/plugins.tsx");
  const companions = read("plugin/shared/companions.ts");

  assert.match(settings, /PREREQUISITE SETUP GATE/, "the Skills & Tools section renders PREREQUISITE SETUP GATE badge when tools are missing/incomplete");
  assert.match(settings, /Required Factory Skills & Tools Setup/, "the Prerequisite Setup Gate title");
  assert.match(settings, /Install Required Skills & Tools/, "1-click Install Required Skills & Tools CTA");
  assert.match(shell, /<PrerequisiteSetupCard/, "FactoryShell mounts the card inside the Skills & Tools section, not on the Project panel");
  assert.match(plugins, /REQUIRED TOOL/, "CompanionCard renders REQUIRED TOOL badge for companion tools");
  assert.match(plugins, /Required by Factory \(Disable\/Remove locked\)/, "CompanionCard locks Disable/Remove on mandatory companion tools");
  assert.match(companions, /git:mattpocock\/skills \+ anthropics\/skills \+ vercel-labs\/agent-skills/, "COMPANION_TOOLS_CATALOG declares canonical GitHub skill sources");
});

test("ADR 0039: HelperMcpsCard renders a compact 2-row summary card with a collapsible ⋯ Manage drawer and sits below Companion Tools in PluginsPane", () => {
  const plugins = read("plugin/client/factory/plugins.tsx");
  const helperMcps = read("plugin/client/factory/helper-mcps.tsx");

  const coreIdx = plugins.indexOf("key={view.corePlugin.id}");
  const toolsIdx = plugins.indexOf("Companion Tools & Skill Packs");
  const helperIdx = plugins.indexOf("<HelperMcpsCard");
  assert.ok(coreIdx !== -1 && toolsIdx !== -1 && helperIdx !== -1, "PluginsPane renders Core, Companion Tools, and HelperMcpsCard");
  assert.ok(coreIdx < toolsIdx && toolsIdx < helperIdx, "HelperMcpsCard is placed below Core and Companion Tools so it never pushes Core off-screen");

  assert.match(helperMcps, /const \[drawerOpen, setDrawerOpen\] = useState\(false\)/, "HelperMcpsCard is collapsed by default");
  assert.match(helperMcps, /⋯ Manage \(\$\{servers\.length\}\)/, "HelperMcpsCard uses the collapsible ⋯ Manage (N) drawer toggle");
  assert.match(helperMcps, /label="PEER ONLY"/, "HelperMcpsCard displays PEER ONLY badge");
  assert.match(helperMcps, /flexBasis: 280/, "HelperMcpsCard drawer uses a compact 2-column responsive grid");
  assert.match(helperMcps, /label="Check Connectivity"/);
  assert.doesNotMatch(helperMcps, /Test &amp; Sync|label="(?:Enable|Disable)"/);
  assert.match(helperMcps, /syncedServers\.map/);
  assert.match(helperMcps, /No MCPs synced to Peer yet/);
  for (const label of ["Synced to Peer", "Available on Host", "Attention", "Unsync", "+ Sync to Peer", "OpenCode", "Vault: Off"]) {
    assert.ok(helperMcps.includes(label), `Helper drawer exposes ${label}`);
  }
  assert.match(helperMcps, /server\.targetProviders\.includes/);
  assert.match(helperMcps, /vaultSync: !server\.vaultSync/);
  assert.match(read("plugin/client/factory/shell.tsx"), /setHelperConfig:.*helperMcpsEnableCall\(\{ name, \.\.\.config \}\)/);
});







test('SkillsToolsPane SSR renders Skill Hub inventory and Project pack controls', async () => {
  const { build } = await import('esbuild');
  const { createRequire } = await import('node:module');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { inspectSkillHub } = await import('../src/companion-tools.ts');
  const { makeTempDir } = await import('./helpers.ts');
  const { rmSync } = await import('node:fs');
  const home = makeTempDir();
  try {
    const bundle = await build({ entryPoints: [join(repoRoot, 'plugin/client/factory/plugins.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], plugins: [{ name: 'native-ssr-adapter', setup(b) {
      b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui)$/ }, args => ({ path: args.path, namespace: 'native-ssr' }));
      b.onLoad({ filter: /.*/, namespace: 'native-ssr' }, () => ({ contents: `const React = require('react'); const component = tag => ({children, disabled, onPress}) => React.createElement(tag, {disabled, onClick:onPress}, children); exports.View=component('div'); exports.Text=component('span'); exports.Pressable=component('button'); exports.Icon=()=>null; exports.TextInput=component('input'); exports.Platform={OS:'web',select:spec=>spec.default};`, loader: 'js' }));
    } }] });
    const compiled = { exports: {} as Record<string, any> };
    new Function('require', 'module', 'exports', bundle.outputFiles[0]!.text)(createRequire(import.meta.url), compiled, compiled.exports);
    const theme = { colors: { surface0: '#ffffff', surface1: '#f5f5f5', surface2: '#eeeeee', foreground: '#111111', foregroundMuted: '#555555', accent: '#3355aa', border: '#cccccc', statusSuccess: '#217342', statusWarning: '#8a6010', statusDanger: '#ae3131' } };
    const view = { ...makeViewWithCore(), corePlugin: makeCorePluginFixture(), companions: [], companionTools: [], pluginsCheckedAt: null, skillHub: inspectSkillHub({ userHome: home }), project: { root: '/project' } };
    const html = renderToStaticMarkup(createElement(compiled.exports.SkillsToolsPane, { theme, view, actions: { busy: false, install() {}, manage() {}, checkUpdates() {}, togglePack() {}, importSkill() {} } }));
    assert.match(html, /Skill Hub — Inventory, Host Ecosystems &amp; Role Matrix/);
    assert.match(html, /Installed in Factory \(0\)/);
    assert.match(html, /Host Ecosystems \(1\)/);
    assert.match(html, /Expo &amp; React Native/);
    assert.match(html, /Enable for Project/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("v0.0.87 (ADR 0043 §4): SeatsPane renders the Project Token & Model Usage card", () => {
  const seats = readFileSync(join(repoRoot, "plugin/client/factory/seats.tsx"), "utf8");
  assert.match(seats, /export function ProjectUsageCard/, "the card is its own component");
  assert.match(seats, /Project Token Usage/, "the card's section title");
  assert.match(seats, /BY SEAT \/ ROLE/, "the seat breakdown rows render");
  assert.match(seats, /BY MODEL \/ PROVIDER/, "the model breakdown rows render");
  assert.match(seats, /cache-hit/, "the cache-hit ratio renders");
  assert.match(seats, /<ProjectUsageCard theme=\{theme\} usage=\{view\.projectUsage \?\? null\} \/>/, "the pane mounts the card from the view's usage half");

  const status = readFileSync(join(repoRoot, "plugin/bin/factory.mjs"), "utf8");
  assert.match(status, /usage-status\.mjs/, "factory status reads the generated usage-status mirror");
  assert.match(status, /Token Usage/, "the CLI section header prints");
});

// ---- the seat directory starter (v0.6.1 W4 spike, ADR 0057 §8/§11) ----------------------------------
//
// One starter polls `factory.seats.directory` every 20 seconds and keeps two
// registration maps in step with it — paseo-room's role-pill pattern: a map
// of registrations, `update` on change, `remove` on disappearance. The pure
// halves live in kit/directory.ts (zero React Native runtime imports, the
// live-seats.ts precedent); the starter and popover in factory/directory.tsx.

test("kit/directory: headerPlans yields one factory-header-<workspaceId> button per Project root workspace, labelled Factory plus the Needs-you count only when it is non-zero (W4)", () => {
  const plans = headerPlans([
    { slug: "goal-partner", root: "/project", workspaceId: "ws-1", needsYouCount: 0 },
    { slug: "paseo-factory", root: "/project", workspaceId: "ws-2", needsYouCount: 3 },
    { slug: "no-workspace", root: "/project", workspaceId: null, needsYouCount: 2 },
  ]);
  assert.deepEqual(plans, [
    { id: "factory-header-ws-1", workspaceId: "ws-1", label: "Factory", fingerprint: "Factory" },
    { id: "factory-header-ws-2", workspaceId: "ws-2", label: "Factory · 3", fingerprint: "Factory · 3" },
  ], "a Project with no workspace id gets no header button — there is nothing to anchor it to");
});

test("kit/directory: pillPlans yields one factory-pill-<agentId> per live seat agent with a workspace, labelled by role (W4)", () => {
  const seat = (over: Partial<SeatDirectoryEntry>): SeatDirectoryEntry => ({
    lane: { provider: "pi", model: "zai/glm-5.3", scope: "machine" }, pendingLane: null, handoff: null, allowedActions: ["switch-model", "hand-off-now"],
    context: { state: "used", usedTokens: 40000, markTokens: 128000, label: "40k / 128k", fraction: 0.3125 }, task: null, quickSwitchModels: [],
    slug: "goal-partner",
    workspaceId: "ws-1",
    agentId: "agent-1",
    role: "lead",
    provider: "pi/zai/glm-5.3",
    model: "glm-5.3",
    thinking: "high",
    contextUsedTokens: 40_000,
    markTokens: 128_000,
    handoffState: null,
    ...over,
  });
  const plans = pillPlans([
    seat({ agentId: "agent-sup", role: "supervisor" }),
    seat({ agentId: "agent-lead", role: "lead" }),
    seat({ agentId: "agent-peer", role: "peer", workspaceId: "wt-ws" }),
    seat({ agentId: "agent-nows", workspaceId: null }),
  ]);
  assert.deepEqual(
    plans.map((plan) => ({ id: plan.id, label: plan.label, agentId: plan.agentId, workspaceId: plan.workspaceId })),
    [
      { id: "factory-pill-agent-sup", label: "supervisor", agentId: "agent-sup", workspaceId: "ws-1" },
      { id: "factory-pill-agent-lead", label: "lead", agentId: "agent-lead", workspaceId: "ws-1" },
      { id: "factory-pill-agent-peer", label: "peer", agentId: "agent-peer", workspaceId: "wt-ws" },
    ],
    "the label is the role; a seat the daemon cannot place in a workspace gets no pill",
  );
});

test("kit/directory: reconcileDirectory registers what appeared, updates on change and removes what disappeared — the role-pill pattern (W4)", () => {
  const registrations: { id: string; updates: string[]; removed: boolean }[] = [];
  const registrationOf = (plan: { id: string }) => {
    const registration = { id: plan.id, updates: [] as string[], removed: false };
    registrations.push(registration);
    return {
      update: (patch: { label?: string }) => { registration.updates.push(patch.label ?? ""); },
      remove: () => { registration.removed = true; },
    };
  };
  const current = new Map<string, { fingerprint: string; registration: ReturnType<typeof registrationOf> }>();
  const headerPlan = (workspaceId: string, count: number) => ({
    id: `factory-header-${workspaceId}`,
    workspaceId,
    label: count > 0 ? `Factory · ${count}` : "Factory",
    fingerprint: count > 0 ? `Factory · ${count}` : "Factory",
  });

  // First poll: two Projects — both register.
  reconcileDirectory(current, [headerPlan("ws-1", 0), headerPlan("ws-2", 3)], registrationOf, (registration, plan) => registration.update({ label: plan.label }));
  assert.deepEqual(registrations.map((r) => r.id), ["factory-header-ws-1", "factory-header-ws-2"]);
  assert.deepEqual(registrations.map((r) => r.updates), [[], []], "a fresh registration needs no update");

  // Second poll: same shape — nothing updates, nothing registers again.
  reconcileDirectory(current, [headerPlan("ws-1", 0), headerPlan("ws-2", 3)], registrationOf, (registration, plan) => registration.update({ label: plan.label }));
  assert.equal(registrations.length, 2, "an unchanged directory registers nothing new");

  // Third poll: ws-2's count dropped to zero (an update), ws-1 vanished (a remove).
  reconcileDirectory(current, [headerPlan("ws-2", 0)], registrationOf, (registration, plan) => registration.update({ label: plan.label }));
  assert.equal(registrations.length, 2);
  assert.deepEqual(registrations[1]!.updates, ["Factory"], "the label change is an in-place update");
  assert.equal(registrations[0]!.removed, true, "the disappeared Project's button is removed");
  assert.equal(current.size, 1);

  // Fourth poll: ws-1 returns — a fresh registration after the removal.
  reconcileDirectory(current, [headerPlan("ws-1", 0), headerPlan("ws-2", 0)], registrationOf, (registration, plan) => registration.update({ label: plan.label }));
  assert.equal(registrations.filter((r) => r.id === "factory-header-ws-1" && !r.removed && r.updates.length === 0).length, 1, "a returning Project registers anew");
});

test("W4: the client starts the seat directory starter in contribute() and its cleanup rides the disposer", () => {
  const index = read("plugin/index.client.tsx");
  assert.match(index, /startSeatDirectory\(client, editorRequests\)/, "contribute() starts the 20-second directory poll");
  assert.match(index, /import \{ startSeatDirectory \} from "\.\/client\/factory\/directory\.tsx";/);
});

test("W4: header buttons and composer pills register ONLY through the seat directory starter — no other client source calls addHeaderButton or addComposerPill", () => {
  const clientSources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) clientSources.push(path);
    }
  };
  walk(join(repoRoot, "plugin/client"));
  clientSources.push(join(repoRoot, "plugin/index.client.tsx"));
  assert.ok(clientSources.length > 10, "the walk actually found the client tree");
  const offenders = clientSources.filter((path) => /addHeaderButton|addComposerPill/.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, [join(repoRoot, "plugin/client/factory/directory.tsx")], "the directory starter is the one registration door (the bundle-gate acceptance)");
});

test("W4: the starter polls factory.seats.directory every 20 seconds, keeps the last registrations on error, and the header button opens the panel at the workspace location", () => {
  const directory = read("plugin/client/factory/directory.tsx");
  assert.match(directory, /DIRECTORY_POLL_MS = 20_000/, "the spec's 20-second cadence");
  assert.match(directory, /setInterval\(\(\) => \{ void tick\(\); \}, DIRECTORY_POLL_MS\)/);
  assert.match(directory, /client\.rpc\(seatsDirectory, \{\}\)/, "the poll rides the read RPC");
  assert.match(directory, /client\.openPanel\(PANEL_ID, \{ workspaceId: plan\.workspaceId, location: "workspace" \}\)/, "the header button opens the existing panel as a workspace-location tab");
  assert.match(directory, /warn\("directory poll",/, "failed polls warn and keep registrations; mounted recovery test covers retention");
});

test("W13: the composer pill exposes status and named quick actions through starter-owned RPC callbacks", () => {
  const directory = read("plugin/client/factory/directory.tsx");
  assert.match(directory, /testID="factory-pill-popover"/, "the spike's named E2E hook");
  for (const hook of ["factory-pill-close", "factory-pill-model-", "RECENT MODELS"]) {
    assert.ok(directory.includes(hook), `the popover renders ${hook}`);
  }
  for (const word of ["Role", "Context", "Project", "Close"]) {
    assert.ok(!new RegExp(`label="${word}"|\\["${word}",`).test(directory), `the popover no longer renders a ${word} row or button`);
  }
  assert.match(directory, /factory-pill-other-model/);
  assert.match(directory, /factory-pill-hand-off-now/);
  assert.ok(!directory.includes("useRpc"), "the starter owns RPC dispatch");
});

test("W10: every planned contribution id obeys Paseo's renderer contract", () => {
  const headers = headerPlans([{ slug: "factory", root: "/project", workspaceId: "wks_2438d240dc71fd76", needsYouCount: 1 }, { slug: "other", root: "/project", workspaceId: "WKS_Mixed.Space/Root", needsYouCount: 0 }]);
  const pills = pillPlans([{ workspaceId: "wks_root", agentId: "AE879777-27D9-4355-B2C3-A8F99AC7F902" } as SeatDirectoryEntry]);
  assert.equal(headers[0]!.id, "factory-header-wks-2438d240dc71fd76");
  for (const plan of [...headers, ...pills]) assert.match(plan.id, /^[a-z][a-z0-9-]*$/);
});

test("W10: failed contribution updates and removals retry on the next successful poll", () => {
  let failUpdate = true, failRemove = true;
  let label = "old", removed = false;
  const registration = {
    update(patch: { label?: string }) { if (failUpdate) throw new Error("update failed"); label = patch.label!; },
    remove() { if (failRemove) throw new Error("remove failed"); removed = true; },
  };
  const current = new Map([["factory-header-root", { fingerprint: "old", registration }]]);
  const next = [{ id: "factory-header-root", label: "new", fingerprint: "new" }];
  const reconcile = (plans: typeof next) => reconcileDirectory(current, plans, () => registration, (r, p) => r.update({ label: p.label }));
  assert.throws(() => reconcile(next), /update failed/);
  failUpdate = false;
  reconcile(next);
  assert.equal(label, "new", "a failed update did not consume the new fingerprint");
  assert.throws(() => reconcile([]), /remove failed/);
  failRemove = false;
  reconcile([]);
  assert.equal(removed, true, "a failed remove retained the handle for retry");
  assert.equal(current.size, 0);
});

test("W13: pill labels track every active handoff phase, including substitute handover, then return to role", () => {
  const states = ["scheduled", "handing-over", "substitute", "creating-successor", "done", "failed", null];
  const plans = pillPlans(states.map((state, i) => ({ role: "lead", workspaceId: "root", agentId: `agent-${i}`, handoffState: state } as SeatDirectoryEntry)));
  assert.deepEqual(plans.map(plan => plan.label), ["lead · handing off", "lead · handing off", "lead · handing off", "lead · handing off", "lead", "lead", "lead"]);
});
