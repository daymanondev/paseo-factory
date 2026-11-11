import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "../plugin/server/core/project.ts";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import {
  integrationsScreenModel,
  utcStamp,
  type IntegrationsMcpRow,
  type IntegrationsPluginRow,
  type IntegrationsScreenModel,
} from "../web/src/integrations-view.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-09a): at least one test drives the console's
 * REAL snapshot read — `web/src/useSnapshot.ts` `loadSnapshotViaSidecar`,
 * the exact function the browser bundle calls — against a REAL started
 * sidecar over a REAL Factory fixture whose ONE registered SLP Project
 * carries a seeded Open Design link in its own `projects/<slug>/execution.json`
 * plus one factory-source Helper MCP persisted under the `overrides` law
 * (`helper-mcps.json` — without the override a factory-source entry folds
 * disabled, with it the stdio entry classifies "connected" on this host's
 * own `node`). Proves the bounded outcome end to end: the Integrations fold
 * renders the read-only roster from the snapshot alone — the Core plugin's
 * degrade default (running at the burn-in version when no daemon plugin
 * list answers), the companion catalog's honest `not_installed`, the
 * "Never checked" on-demand update stamp, the seeded MCP card by name
 * (never list equality — the host may add its own Open Design entry), the
 * scoped Project's Open Design link with UTC-preformatted fields, and the
 * host skill ecosystem's honest state (the built-in Expo catalog pack
 * offered "available", nothing fabricated as linked) — and an unscoped
 * read folds the card's honest null link, never a fabricated one.
 */

/** Finds one plugin card by id — the roster's own slots, never array equality. */
function pluginRow(model: IntegrationsScreenModel, id: string): IntegrationsPluginRow {
  const row = model.plugins.find((candidate) => candidate.id === id);
  assert.ok(row !== undefined, `the roster carries the ${id} card`);
  return row;
}

/** Finds one MCP card by name — host noise (an "open-design" entry on hosts with the app) must never break the read. */
function mcpRow(model: IntegrationsScreenModel, name: string): IntegrationsMcpRow {
  const row = model.mcps.find((candidate) => candidate.name === name);
  assert.ok(row !== undefined, `the roster carries the ${name} MCP card`);
  return row;
}

test("RG-1: the console's real transport folds the Integrations roster — core plugin, seeded MCP, the Open Design link, Never checked", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose integrations the screen folds.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";
  // The default empty daemon suffices: no plugin list answers, so the fold's
  // own degrade defaults must carry the Plugins tab (core running at the
  // burn-in version, companions honestly not installed, updates never checked).
  const fixture = makeConsoleFixture(homeRoot, { registry: true });
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug });
  assert.equal(registered.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // The Project's own Open Design link, seeded straight into the selection
  // the RPC passes through verbatim (`readExecution` validates only
  // schemaVersion/mode/revision/skillPacks; `executionView` spreads
  // `openDesignLink` untouched — the sync path's own recorded shape).
  const syncedAt = "2026-11-08T09:05:00.000Z";
  const digest = "f01dab1eceed0123456789abcdef0123456789abcdef0123456789abcdef";
  writeFileSync(
    join(fixture.stateDir, "projects", slug, "project-settings.json"),
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      openDesignLink: {
        projectId: "checkout-redesign",
        projectName: "Checkout Redesign",
        sourceUpdatedAt: Date.parse("2026-11-07T18:00:00Z"),
        syncedAt,
        digest,
        screenCount: 7,
        files: [],
      },
    }) + "\n",
  );
  // The seeded Helper MCP under the `overrides` law: without the override a
  // factory-source entry folds `enabled:false` → "disabled"; with it the
  // stdio entry (no env keys, `node` on this host) classifies "connected".
  writeFileSync(
    join(fixture.stateDir, "helper-mcps.json"),
    JSON.stringify({
      mcpServers: { "seed-helper": { command: "node", args: ["x.js"] } },
      overrides: { "seed-helper": true },
    }) + "\n",
  );

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // The scoped read through the real transport: the fold renders the Project's
  // read-only integrations from the snapshot alone.
  const snapshot = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
  assert.equal(snapshot.view.project?.slug, slug);
  const model = integrationsScreenModel(snapshot.view);
  assert.equal(model.scope, snapshot.view.project.name ?? snapshot.view.project.slug);
  // The plugin roster: the Core plugin first (coral, CORE) at the fold's own
  // degrade default — running at the burn-in version because the core plugin
  // is serving this very snapshot; companions and the skill pack honestly
  // not installed on the isolated fixture home; updates never checked.
  const core = pluginRow(model, "paseo-factory");
  assert.equal(core.core, true);
  assert.equal(core.tone, "coral");
  assert.equal(core.status, "running");
  assert.equal(core.statusLabel, "Running");
  assert.equal(core.versionLabel, "v0.0.26");
  assert.equal(core.updateAvailable, null);
  assert.equal(core.commitsBehind, null);
  assert.equal(model.plugins[0]?.id, "paseo-factory", "the Core plugin card is the roster's first row");
  const burnLab = pluginRow(model, "factory-burn-lab");
  assert.equal(burnLab.tone, "cyan");
  assert.equal(burnLab.status, "not_installed");
  assert.equal(burnLab.statusLabel, "Not Installed");
  assert.equal(burnLab.versionLabel, null);
  const releaseLab = pluginRow(model, "factory-release-lab");
  assert.equal(releaseLab.status, "not_installed");
  assert.equal(releaseLab.versionLabel, null);
  const skillPack = pluginRow(model, "factory-skills-pack");
  assert.equal(skillPack.tone, "lime");
  assert.equal(skillPack.status, "not_installed");
  assert.equal(skillPack.versionLabel, null);
  assert.equal(model.pluginsCheckedAt, null);
  assert.equal(model.pluginsCheckedAtLabel, "Never checked");
  assert.equal(model.updateCount, 0);
  // The host skill ecosystem: the isolated fixture home has NOTHING
  // installed, so the hub's own built-in catalog pack (`expo:official-pack`,
  // always offered) is honestly "available" — never "linked" — and no
  // host-noise ecosystem rows (codex/claude/pi mirrors) appear beside it.
  const pack = model.skills.find((row) => row.id === "expo:official-pack");
  assert.ok(pack !== undefined, "the hub's built-in Expo catalog pack is always offered");
  assert.equal(pack.name, "Official Expo & EAS");
  assert.equal(pack.ecosystem, "GitHub Catalog (expo/skills)");
  assert.equal(pack.kind, "pack");
  assert.equal(pack.status, "available");
  assert.deepEqual(pack.mcpServers, ["expo-mcp"]);
  assert.equal(
    model.skills.every((row) => row.status !== "linked"),
    true,
    "nothing is linked on the isolated fixture home — never a fabricated link",
  );
  // The seeded Helper MCP, by name — the host may add its own entries
  // (an "open-design" card where the desktop app is installed), so the
  // roster is never asserted by list equality.
  const helper = mcpRow(model, "seed-helper");
  assert.equal(helper.transport, "stdio");
  assert.equal(helper.enabled, true);
  assert.equal(helper.status, "connected");
  assert.equal(helper.statusLabel, "Connected");
  assert.equal(helper.statusTone, "green");
  assert.equal(helper.statusDetail, "Command and credentials present; server starts on first use");
  // The scoped Project's Open Design link — every field the card renders,
  // dates preformatted deterministically by the fold's own `utcStamp`.
  assert.ok(model.openDesign !== null, "the scoped read folds the seeded link — never the unscoped null");
  assert.equal(model.openDesign.projectId, "checkout-redesign");
  assert.equal(model.openDesign.projectName, "Checkout Redesign");
  assert.equal(model.openDesign.screenCount, 7);
  assert.equal(model.openDesign.syncedAt, syncedAt);
  assert.equal(model.openDesign.syncedAtLabel, utcStamp(syncedAt));
  assert.equal(model.openDesign.syncedAtLabel, "2026-11-08 09:05 UTC");
  assert.equal(model.openDesign.digest, digest);
  assert.equal(model.openDesign.digestShort, digest.slice(0, 12));

  // The unscoped read through the same transport: no Project selected — the
  // root selection carries no link, so the card folds its honest "Not linked"
  // null, never a borrowed or fabricated one.
  const global = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(global.ok, true, global.ok ? "" : global.error);
  assert.equal(integrationsScreenModel(global.view).openDesign, null);
});
