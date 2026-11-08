import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "../plugin/server/core/project.ts";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { settingsScreenModel } from "../web/src/settings-view.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-10a): at least one test drives the console's
 * REAL snapshot read — `web/src/useSnapshot.ts` `loadSnapshotViaSidecar`,
 * the exact function the browser bundle calls — against a REAL started
 * sidecar over a REAL Factory fixture whose ONE registered SLP Project has
 * no vault-config.json anywhere under its temp home. Proves the bounded
 * outcome end to end: the Settings fold renders the read-only Private Vault
 * card from the snapshot alone — the unconfigured vault's every honest face
 * (Not configured, repo null, the branch default, passphrase Not set, clone
 * Absent, both stamps Never, all four shared-secret chips absent, no
 * hydrated apps, no gh, no suggested repo, no error) and the scoped
 * Project's name/slug/root — while an unscoped read through the same
 * transport folds the Project panel's honest null, never a borrowed
 * Project. The gh probe is deterministic by the injected vaultRunner seam
 * (the same override `SurfaceDeps` accepts): the default runner would run
 * the HOST's real `gh`, flipping the fold's gh facts per machine.
 */

test("RG-1: the console's real transport folds the Settings screen — the unconfigured vault honest, the scoped Project read", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose settings the screen folds.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";
  // The default empty daemon suffices: the vault half is a filesystem probe
  // over the fixture home. The vaultRunner seam keeps the unconfigured
  // gather's `gh auth` probe deterministic — a missing-binary ENOENT, the
  // same shape the real runner throws on a host with no gh installed.
  const fixture = makeConsoleFixture(homeRoot, {
    registry: true,
    vaultRunner: async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    },
  });
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug });
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

  // The scoped read through the real transport: the fold renders the
  // Project's read-only settings from the snapshot alone.
  const snapshot = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
  assert.equal(snapshot.view.project?.slug, slug);
  const model = settingsScreenModel(snapshot.view);
  assert.equal(model.scope, snapshot.view.project.name ?? snapshot.view.project.slug);
  // The Private Vault card's every honest unconfigured face — no
  // vault-config.json exists under the fixture home, so the gather's
  // defaults carry: never a fabricated repo, stamp, or secret.
  const vault = model.vault;
  assert.equal(vault.configured, false);
  assert.equal(vault.configuredLabel, "Not configured");
  assert.equal(vault.repo, null);
  assert.equal(vault.branch, "main");
  assert.match(vault.nodeId, /^[a-z0-9-]+$/, "the nodeId folds as the hostname-normalized default");
  assert.equal(vault.passphraseLabel, "Not set");
  assert.equal(vault.cloneLabel, "Absent");
  assert.equal(vault.lastHydratedAt, null);
  assert.equal(vault.lastHydratedLabel, "Never");
  assert.equal(vault.lastPushedAt, null);
  assert.equal(vault.lastPushedLabel, "Never");
  assert.deepEqual(
    vault.secrets.map((chip) => [chip.label, chip.present]),
    [
      ["ASC key", false],
      ["ASC credentials", false],
      ["Google Play", false],
      ["Eye config", false],
    ],
    "no shared secret exists on the fixture home — every chip honestly absent",
  );
  assert.deepEqual(vault.hydratedApps, []);
  assert.equal(vault.ghInstalled, false);
  assert.equal(vault.ghAuthenticated, false);
  assert.equal(vault.ghUser, null);
  assert.equal(vault.suggestedRepo, null);
  assert.equal(vault.error, null);
  // The scoped Project panel — the fields the card renders, straight off
  // the registration the snapshot itself read (a fresh Project folds the
  // default SLP mode).
  assert.ok(model.project !== null, "the scoped read folds the Project — never the unscoped null");
  assert.equal(model.project.slug, slug);
  // The registry resolves the repo to its real path (macOS `/private/var`
  // prefix), so the card's root is the snapshot's own resolution, ending at
  // the registered repo directory.
  assert.equal(model.project.root, snapshot.view.project.root);
  assert.ok(model.project.root.endsWith("slp-repo"));
  assert.equal(model.project.name, snapshot.view.project.name ?? snapshot.view.project.slug);
  assert.equal(model.project.modeLabel, "SLP");

  // The unscoped read through the same transport: no Project selected — the
  // panel folds its honest "No project selected" null, never a borrowed or
  // fabricated Project, while the vault half stays the same home truth.
  const global = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(global.ok, true, global.ok ? "" : global.error);
  const unscoped = settingsScreenModel(global.view);
  assert.equal(unscoped.project, null);
  assert.equal(unscoped.scope, "All projects");
  assert.equal(unscoped.vault.configuredLabel, "Not configured");
  assert.equal(unscoped.vault.lastHydratedLabel, "Never");
});
