import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultVaultRunner } from "../plugin/server/core/vault-transport.ts";
import type { VaultRunner } from "../plugin/server/core/vault.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { vaultConfigureViaSidecar, vaultImportViaSidecar } from "../web/src/vault.ts";
import { settingsScreenModel } from "../web/src/settings-view.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-10d): ONE test drives the Settings screen's
 * key-import write through the console's REAL transport — `web/src/vault.ts`
 * `vaultImportViaSidecar`, the exact function the browser bundle calls —
 * against a REAL started sidecar over a REAL Factory fixture whose vault
 * remote is a LOCAL bare git repository (the transport group's own
 * `git init --bare` fixture law — nothing touches GitHub or the real home)
 * and whose injected vaultRunner seam answers `gh` with a deterministic
 * ENOENT while every `git` call runs for real. Proves the bounded outcome
 * end to end: configure persists the repo/branch, then the dialog's default
 * arm — one filled path, every empty field OMITTED from the wire,
 * `syncAfterImport` spelled `false` because the core's own omitted default
 * is ON — imports the temp fixture key file into
 * `<home>/vault-runtime/secrets/` with NO sync (pushed false) and the NEXT
 * snapshot folds the panel's `ASC key` shared-secret chip; and the checked
 * arm — `syncAfterImport: true` — imports a second key and runs the unified
 * sync against the bare remote (pushed true, the remote's branch moves),
 * the NEXT snapshot folding the `Google Play` chip beside the first.
 */

/** One git invocation against the fixture — output captured, never inherited. */
function runGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A local bare remote (the transport group's own fixture), HEAD pinned to main — the vault's stand-in for GitHub. */
function makeBareRemote(homeRoot: string): string {
  const bare = join(homeRoot, "vault-remote.git");
  runGit(["init", "--bare", bare]);
  runGit(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return bare;
}

/** The hybrid runner the import legs need: `gh` answers the deterministic missing-binary ENOENT, `git` runs for real. */
function ghMissingGitRealRunner(): VaultRunner {
  const gitRunner = createDefaultVaultRunner();
  return async (call) => {
    if (call.command === "gh") {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    }
    return gitRunner(call);
  };
}

test("RG-1: the console's real transport imports vault keys — the omitted-empty/default-off arm and the checked sync arm both land", async (t) => {
  const homeRoot = makeTempDir();
  const bare = makeBareRemote(homeRoot);
  const fixture = makeConsoleFixture(homeRoot, { vaultRunner: ghMissingGitRealRunner() });
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // The temp fixture key files — host file paths the daemon reads itself; the
  // browser never reads or uploads their contents.
  const p8Path = join(homeRoot, "AuthKey_TI.p8");
  writeFileSync(p8Path, "-----BEGIN PRIVATE KEY-----\nasc api key imported\n-----END PRIVATE KEY-----\n");
  const gplayPath = join(homeRoot, "gplay-sa.json");
  writeFileSync(gplayPath, JSON.stringify({ type: "service_account", project_id: "patigame-prod", client_email: "ci@patigame-prod.iam.gserviceaccount.com" }));

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // (a) Configure through the real web client — the local bare path as the
  // repo, no passphrase field at all (the dialog's "Leave unchanged" omits it).
  const configure = await vaultConfigureViaSidecar({ repo: bare, branch: "main" }, fetchAt);
  assert.equal(configure.ok, true, configure.ok ? "" : configure.error);

  // (b) The honest start: both chips absent through the real read.
  const before = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(before.ok, true, before.ok ? "" : before.error);
  const beforeModel = settingsScreenModel(before.view);
  assert.equal(beforeModel.vault.secrets.find((chip) => chip.id === "ascKey")?.present, false);
  assert.equal(beforeModel.vault.secrets.find((chip) => chip.id === "gplayServiceAccount")?.present, false);

  // (c) Import through the real web client — the dialog's default arm: one
  // filled path, every empty field omitted, and `syncAfterImport: false`
  // spelled explicitly (the core's own omitted default is ON; the confirm
  // checkbox's promise is the wire's truth).
  const importOff = await vaultImportViaSidecar({ ascKeyPath: p8Path, syncAfterImport: false }, fetchAt);
  assert.equal(importOff.ok, true, importOff.ok ? "" : importOff.error);
  assert.ok(importOff.ok);
  assert.deepEqual(importOff.importedFiles, ["secrets/shared/asc-api-key.p8"], "the .p8 seals under the shared secrets dir");
  assert.equal(importOff.pushed, false, "the unchecked arm never syncs");
  assert.match(importOff.summary, /Imported 1 secret file\(s\)/, "the handler's own summary rides verbatim");
  assert.match(importOff.summary, /into local vault-runtime/, "the no-sync arm's summary names its local landing");

  // (d) The NEXT snapshot folds the panel's ASC key chip — and only it.
  const afterAsc = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(afterAsc.ok, true, afterAsc.ok ? "" : afterAsc.error);
  const afterAscModel = settingsScreenModel(afterAsc.view);
  assert.equal(afterAscModel.vault.secrets.find((chip) => chip.id === "ascKey")?.present, true, "the ASC key chip lights");
  assert.equal(afterAscModel.vault.secrets.find((chip) => chip.id === "gplayServiceAccount")?.present, false, "the Google Play chip stays honest");

  // (e) The checked arm through the same real transport — a second key with
  // `syncAfterImport: true` — runs the unified sync against the bare remote:
  // the key lands AND a commit moves the remote's branch.
  const importOn = await vaultImportViaSidecar({ gplayKeyPath: gplayPath, syncAfterImport: true }, fetchAt);
  assert.equal(importOn.ok, true, importOn.ok ? "" : importOn.error);
  assert.ok(importOn.ok);
  assert.deepEqual(importOn.importedFiles, ["secrets/shared/gplay-service-account.json"]);
  assert.equal(importOn.pushed, true, "the checked arm syncs and pushes");
  assert.match(importOn.summary, /Imported 1 secret file\(s\)/);
  const remoteHead = runGit(["--git-dir", bare, "rev-parse", "refs/heads/main"]);
  assert.match(remoteHead, /^[0-9a-f]{40}$/, "the checked arm moved the bare remote's branch");

  // (f) The NEXT snapshot folds the Google Play chip beside the first.
  const afterGplay = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(afterGplay.ok, true, afterGplay.ok ? "" : afterGplay.error);
  const afterGplayModel = settingsScreenModel(afterGplay.view);
  assert.equal(afterGplayModel.vault.secrets.find((chip) => chip.id === "ascKey")?.present, true);
  assert.equal(afterGplayModel.vault.secrets.find((chip) => chip.id === "gplayServiceAccount")?.present, true, "the Google Play chip lights");
});
