import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonPluginItem, DaemonPluginSourceStatus } from "../plugin/server/daemon-cli.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { pluginsCheckUpdatesViaSidecar, pluginsInstallViaSidecar, pluginsManageViaSidecar } from "../web/src/plugins.ts";
import { integrationsScreenModel, type IntegrationsScreenModel } from "../web/src/integrations-view.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-09b): ONE test drives the Integrations
 * screen's three plugin writes through the console's REAL transport —
 * `web/src/plugins.ts` `pluginsCheckUpdatesViaSidecar` /
 * `pluginsInstallViaSidecar` / `pluginsManageViaSidecar`, the exact
 * functions the browser bundle calls — against a REAL started sidecar over a
 * REAL Factory fixture whose daemon plugin seams are injected recording
 * fakes (nothing really installs; the private-companion git probe is skipped
 * by the handler's own injected-install law). Proves the bounded outcome end
 * to end: the check answers its `checkedAt` and the NEXT snapshot folds the
 * stamp, the burn-lab update dot, and the tab's update count from the
 * handler's own `localUpdateSnapshot`; a companion install reaches the fake
 * seam carrying EXACTLY the catalog's canonical source (never a ref); a
 * manage disable reaches the fake with the Owner's pluginId and action; and
 * the door's narrowing refusals — the core install target, remove/reload,
 * disabling the console's own host, and every developer install field — come
 * back `forbidden_operation` as data while the fakes record nothing extra.
 */

/** One fake daemon plugin item — a git-sourced, running install, the only kind whose updates propagate. */
function fakePluginItem(id: string, over: Partial<DaemonPluginItem> = {}): DaemonPluginItem {
  return {
    id,
    path: join("/plugins", id),
    enabled: true,
    status: "running",
    source: "git",
    installation: { identity: { kind: "git", remote: `git:daymanondev/${id}:plugin` }, currentRevision: "a1b2c3d" },
    version: "1.0.0",
    ...over,
  };
}

/** Finds one plugin card by id — the roster's own slots, never array equality. */
function pluginRow(model: IntegrationsScreenModel, id: string) {
  const row = model.plugins.find((candidate) => candidate.id === id);
  assert.ok(row !== undefined, `the roster carries the ${id} card`);
  return row;
}

test("RG-1: the console's real transport writes the plugins — check stamps the roster, a companion install and manage disable reach the daemon seam, the narrowing refuses as data", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose integrations the screen folds.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);

  // The recording fakes at the daemon seams: the core plugin and burn-lab
  // running as git installs (the only identity whose update status the fold
  // propagates), release-lab honestly absent until the install lands.
  const CHECKED_AT = "2026-11-08T10:15:00.000Z";
  const installs: { home: string; input: { id: string; source: string; ref?: string } }[] = [];
  const manages: { home: string; pluginId: string; action: string }[] = [];
  const checks: string[] = [];
  const fixture = makeConsoleFixture(homeRoot, {
    registry: true,
    listPlugins: async () => ({
      ok: true as const,
      plugins: [fakePluginItem("paseo-factory", { version: "0.0.26" }), fakePluginItem("factory-burn-lab", { version: "0.3.1" })],
    }),
    installPlugin: async (home, input) => {
      installs.push({ home, input });
      return { ok: true as const, plugin: fakePluginItem(input.id) };
    },
    managePlugin: async (home, pluginId, action) => {
      manages.push({ home, pluginId, action });
      return { ok: true as const };
    },
    checkPluginUpdates: async (home) => {
      checks.push(home);
      const statuses: DaemonPluginSourceStatus[] = [
        { id: "paseo-factory", currentRevision: "a1b2c3d", latestRevision: "a1b2c3d", commitsBehind: 0, updateAvailable: false },
        { id: "factory-burn-lab", currentRevision: "e4f5a6b", latestRevision: "c9d8e7f", commitsBehind: 2, updateAvailable: true },
      ];
      return { ok: true as const, statuses, checkedAt: CHECKED_AT };
    },
  });
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug: resolved.ok ? resolved.slug : "" });
  assert.equal(registered.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // (a) The check through the real web client: the stamp, the one update, the handler's own sentence.
  const check = await pluginsCheckUpdatesViaSidecar({}, fetchAt);
  assert.equal(check.ok, true, check.ok ? "" : check.error);
  assert.ok(check.ok);
  assert.equal(check.checkedAt, CHECKED_AT);
  assert.deepEqual(check.updatesAvailable, ["factory-burn-lab"]);
  assert.equal(check.summary, "1 plugin update(s) available: factory-burn-lab");

  // (b) The NEXT snapshot folds the check the handler stashed: the stamp, the
  // burn-lab update dot with its commits behind, the tab's update count —
  // and release-lab still honestly not installed (the Install act's own fact).
  const snapshot = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
  const model = integrationsScreenModel(snapshot.view);
  assert.equal(model.pluginsCheckedAt, CHECKED_AT);
  assert.equal(model.pluginsCheckedAtLabel, "Checked 2026-11-08 10:15 UTC");
  assert.equal(model.updateCount, 1);
  const core = pluginRow(model, "paseo-factory");
  assert.equal(core.status, "running");
  assert.equal(core.versionLabel, "v0.0.26");
  assert.equal(core.updateAvailable, false, "the core's checked answer folds — up to date");
  const burnLab = pluginRow(model, "factory-burn-lab");
  assert.equal(burnLab.status, "running");
  assert.equal(burnLab.versionLabel, "v0.3.1");
  assert.equal(burnLab.updateAvailable, true, "the check's update dot folds onto the card");
  assert.equal(burnLab.commitsBehind, 2);
  const releaseLab = pluginRow(model, "factory-release-lab");
  assert.equal(releaseLab.status, "not_installed");

  // (c) A canonical-source companion install: the fake seam receives EXACTLY
  // the catalog's own source for the id — never a ref, never a probe (the
  // handler skips the private-companion git probe whenever the install seam
  // is injected with no vault runner — nothing here touches the network).
  const install = await pluginsInstallViaSidecar({ target: "factory-release-lab" }, fetchAt);
  assert.equal(install.ok, true, install.ok ? "" : install.error);
  assert.ok(install.ok);
  assert.deepEqual(install.installed, ["factory-release-lab"]);
  assert.match(install.summary, /factory-release-lab/);
  assert.deepEqual(
    installs,
    [{ home: fixture.home, input: { id: "factory-release-lab", source: "git:daymanondev/factory-release-lab:plugin" } }],
    "the install seam recorded exactly the one canonical-source dispatch",
  );

  // (d) A manage disable: the fake seam receives the Owner's pluginId and action.
  const disable = await pluginsManageViaSidecar({ pluginId: "factory-burn-lab", action: "disable" }, fetchAt);
  assert.equal(disable.ok, true, disable.ok ? "" : disable.error);
  assert.ok(disable.ok);
  assert.equal(disable.pluginId, "factory-burn-lab");
  assert.equal(disable.action, "disable");
  assert.deepEqual(manages, [{ home: fixture.home, pluginId: "factory-burn-lab", action: "disable" }]);

  // (e) The door's narrowing through the SAME web client: the core install
  // target and the remove act — typed out of the client's own vocabulary on
  // purpose, the door (not the client) is the gate — refuse as data.
  const coreInstall = await pluginsInstallViaSidecar({ target: "paseo-factory" }, fetchAt);
  assert.equal(coreInstall.ok, false);
  assert.ok(!coreInstall.ok);
  assert.equal(coreInstall.code, "forbidden_operation");
  assert.match(coreInstall.error, /refuses target paseo-factory/);
  const remove = await pluginsManageViaSidecar(
    { pluginId: "factory-burn-lab", action: "remove" } as unknown as Parameters<typeof pluginsManageViaSidecar>[0],
    fetchAt,
  );
  assert.equal(remove.ok, false);
  assert.ok(!remove.ok);
  assert.equal(remove.code, "forbidden_operation");
  assert.match(remove.error, /refuses action remove/);

  // (f) The remaining narrowing sweep, raw against the door: reload,
  // disabling the console's own host, and every developer install field.
  for (const [method, params] of [
    ["factory.plugins.manage", { pluginId: "factory-burn-lab", action: "reload" }],
    ["factory.plugins.manage", { pluginId: "paseo-factory", action: "disable" }],
    ["factory.plugins.install", { target: "factory-burn-lab", source: "git:some/fork:plugin" }],
    ["factory.plugins.install", { target: "factory-burn-lab", ref: "main" }],
    ["factory.plugins.install", { target: "all", mergeLedgers: true }],
    ["factory.plugins.install", { target: "all", overwriteConfigs: true }],
  ] as const) {
    const response = await fetchAt("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    assert.equal(response.status, 400, `${method} ${JSON.stringify(params)} is narrowed off the console`);
    const payload = (await response.json()) as { ok: boolean; code?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "forbidden_operation", `${method} ${JSON.stringify(params)} refuses before any handler`);
  }

  // The fakes recorded NOTHING extra — every narrowing refusal refused at the door.
  assert.deepEqual(checks, [fixture.home], "the check seam recorded its one dispatch against the fixture home");
  assert.equal(installs.length, 1, "no refused install reached the seam");
  assert.equal(manages.length, 1, "no refused manage reached the seam");
});
