import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { createDefaultVaultRunner } from "../plugin/server/core/vault-transport.ts";
import type { VaultRunner } from "../plugin/server/core/vault.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { vaultConfigureViaSidecar, vaultHydrateViaSidecar, vaultSyncViaSidecar } from "../web/src/vault.ts";
import { settingsScreenModel } from "../web/src/settings-view.ts";
import { makeConsoleFixture, makeReadyToAcceptTask } from "./console-fixture.ts";
import { makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-10c): ONE file drives the Settings screen's
 * two round-trip vault writes through the console's REAL transport —
 * `web/src/vault.ts` `vaultSyncViaSidecar` / `vaultHydrateViaSidecar`, the
 * exact functions the browser bundle calls — against a REAL started sidecar
 * over a REAL Factory fixture. The sync leg's remote is a LOCAL bare git
 * repository (the transport group's own `git init --bare` fixture law —
 * nothing touches GitHub) with the injected vaultRunner seam answering `gh`
 * with a deterministic ENOENT while every `git` call runs for real; the
 * hydrate leg's remote is a GitHub slug whose ONE `gh api` tarball call the
 * seam answers with an in-memory tarball (the `vault.test.ts` fixture law).
 * Proves the bounded outcome end to end: configure persists the repo/branch,
 * then sync — carrying ONLY its checkboxes, never repo/branch/passphrase —
 * clones the bare remote, pushes this node's ledger snapshot (the checked
 * includeLedger arm), and the NEXT snapshot folds `Last hydrated · sync`,
 * `Last pushed`, and the clone presence; hydrate — carrying ONLY its
 * checkboxes, never repo/ref — unpacks the tarball into vault-runtime with
 * no clone left behind and the NEXT snapshot folds `Last hydrated · direct`;
 * and the door's narrowings refuse as data (`forbidden_operation`) — sync's
 * repo/branch/passphrase and hydrate's repo/ref — while the landed key
 * import (`factory.vault.import`, T-10d) and the T-10e Danger Zone writes
 * have their own RG-1 e2es; the danger zone's scoped-only narrowing (no
 * projectRoot refuses) answers through the same door.
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

/** The hybrid runner the sync leg needs: `gh` answers the deterministic missing-binary ENOENT, `git` runs for real. */
function ghMissingGitRealRunner(): VaultRunner {
  const gitRunner = createDefaultVaultRunner();
  return async (call) => {
    if (call.command === "gh") {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    }
    return gitRunner(call);
  };
}

// ---- the in-memory GitHub tarball (the `vault.test.ts` fixture law) ----------------------------------

/** One ustar header with a real checksum — enough archive for the vault's in-memory parser. */
function tarHeader(name: string, size: number, typeflag: "0" | "5"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "latin1");
  header.write(typeflag, 156, 1, "latin1");
  header.write("ustar", 257, 5, "latin1");
  header.write("00", 263, 2, "latin1");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

function tarFileEntry(name: string, data: Buffer): Buffer {
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, data.length, "0"), data, padding]);
}

function tarDirEntry(name: string): Buffer {
  return tarHeader(`${name}/`, 0, "5");
}

/** A GitHub-shaped tarball: one top-level `<owner>-<repo>-<sha>/` prefix, gzipped in memory. */
function buildTarball(entries: Array<{ path: string; data: Buffer | string }>, topDir: string): Buffer {
  const parts: Buffer[] = [tarDirEntry(topDir)];
  for (const entry of entries) {
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const dir = dirname(entry.path);
    if (dir !== "." && dir !== topDir) parts.push(tarDirEntry(dir));
    parts.push(tarFileEntry(entry.path, data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

test("RG-1: the console's real transport syncs the vault — the checked includeLedger arm lands; the narrowing refuses as data", async (t) => {
  const homeRoot = makeTempDir();
  const bare = makeBareRemote(homeRoot);
  const fixture = makeConsoleFixture(homeRoot, { vaultRunner: ghMissingGitRealRunner() });
  // One green task's ledger lines — the sync's includeLedger arm has a real
  // global ledger to snapshot under this node's namespace.
  makeReadyToAcceptTask(fixture.factory, homeRoot, "TS");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

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
  assert.ok(configure.ok);
  assert.equal(configure.vault.configured, true);

  // (b) Sync through the real web client — the checked confirm's checkboxes
  // and NOTHING else: no repo, no branch, no passphrase (configure owns all
  // three; the door would refuse any of them as data).
  const sync = await vaultSyncViaSidecar({ mergeLedgers: false, includeLedger: true, overwriteConfigs: false }, fetchAt);
  assert.equal(sync.ok, true, sync.ok ? "" : sync.error);
  assert.ok(sync.ok);
  assert.equal(sync.createdRepo, false, "a local bare remote is never created");
  assert.deepEqual(sync.hydratedFiles, [], "the empty remote hydrates nothing");
  const nodeId = sync.vault.nodeId;
  assert.ok(
    sync.pushedFiles.includes(`state/nodes/${nodeId}/global-ledger.jsonl`),
    `the checked includeLedger arm snapshots the ledger under this node's namespace: ${sync.pushedFiles.join(", ")}`,
  );
  assert.equal(sync.pushed, true, "the sync pushed a commit");
  assert.match(sync.summary, /synced with/, "the handler's own summary rides verbatim");
  const remoteHead = runGit(["--git-dir", bare, "rev-parse", "refs/heads/main"]);
  assert.match(remoteHead, /^[0-9a-f]{40}$/, "the sync moved the bare remote's branch");

  // (c) The NEXT snapshot folds the new stamps — sync-mode hydrate, push, and
  // the clone presence the panel renders.
  const synced = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(synced.ok, true, synced.ok ? "" : synced.error);
  const syncedModel = settingsScreenModel(synced.view);
  assert.notEqual(syncedModel.vault.lastHydratedLabel, "Never");
  assert.match(syncedModel.vault.lastHydratedLabel, / UTC · sync$/, "the sync stamps the hydrate clock in sync mode");
  assert.notEqual(syncedModel.vault.lastPushedLabel, "Never");
  assert.equal(syncedModel.vault.cloneLabel, "Present");

  // (d) The door's narrowing through the SAME transport — the three fields
  // configure owns refuse as data BEFORE any handler runs.
  for (const params of [{ repo: "octocat/other-vault" }, { branch: "release" }, { passphrase: "correct-horse" }]) {
    const response = await fetchAt("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "factory.vault.sync", params }),
    });
    assert.equal(response.status, 400, `factory.vault.sync ${JSON.stringify(params)} is narrowed off the console`);
    const payload = (await response.json()) as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "forbidden_operation");
    assert.match(payload.error ?? "", /from the console/, "the sentence names whose door refused");
  }
});

test("RG-1: the console's real transport hydrates the vault direct — the tarball stream lands; the narrowing and the danger zone's scoped-only law refuse as data", async (t) => {
  const homeRoot = makeTempDir();
  // The one gh api call the direct hydrate makes, answered in memory — zero
  // network, zero clone; every other `gh` call answers the deterministic
  // ENOENT, and a `git` call would fail the test (the direct hydrate never
  // makes one).
  const tarball = buildTarball(
    [{ path: "octocat-factory-vault-abc1234/config/lanes.json", data: JSON.stringify({ lanes: { default: "pi" } }) }],
    "octocat-factory-vault-abc1234",
  );
  const runner: VaultRunner = async (call) => {
    if (call.command === "gh") {
      if (call.args[0] === "api" && call.args[1] === "repos/octocat/factory-vault/tarball/main") return tarball;
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    }
    throw new Error(`the direct hydrate never runs git: ${call.command} ${call.args.join(" ")}`);
  };
  const fixture = makeConsoleFixture(homeRoot, { vaultRunner: runner });
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // (a) Configure through the real web client — a GitHub slug for the direct
  // hydrate, no passphrase field at all.
  const configure = await vaultConfigureViaSidecar({ repo: "octocat/factory-vault", branch: "main" }, fetchAt);
  assert.equal(configure.ok, true, configure.ok ? "" : configure.error);

  // (b) Hydrate through the real web client — the unchecked confirm's
  // checkboxes and NOTHING else: no repo, no ref (the configured vault is
  // the one that hydrates; the door would refuse either as data).
  const hydrate = await vaultHydrateViaSidecar({ mergeLedgers: false, overwriteConfigs: false }, fetchAt);
  assert.equal(hydrate.ok, true, hydrate.ok ? "" : hydrate.error);
  assert.ok(hydrate.ok);
  assert.deepEqual(hydrate.hydratedFiles, ["config/lanes.json"], "the tarball's one file hydrates");
  assert.match(hydrate.summary, /Direct hydrate unpacked 1 file\(s\) from octocat\/factory-vault/);

  // (c) The NEXT snapshot folds the new stamp — direct-mode hydrate, and the
  // clone stays honestly Absent (the zero-clone law: no checkout exists).
  const hydrated = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(hydrated.ok, true, hydrated.ok ? "" : hydrated.error);
  const hydratedModel = settingsScreenModel(hydrated.view);
  assert.notEqual(hydratedModel.vault.lastHydratedLabel, "Never");
  assert.match(hydratedModel.vault.lastHydratedLabel, / UTC · direct$/, "the direct hydrate stamps the hydrate clock in direct mode");
  assert.equal(hydratedModel.vault.cloneLabel, "Absent");

  // (d) The door's narrowing through the SAME transport — the repo and ref
  // overrides refuse as data BEFORE any handler runs, and the T-10e Danger
  // Zone's own narrowing answers too: `factory.project.delete` with no
  // projectRoot refuses `forbidden_operation` (the scoped-only law; the two
  // writes' happy paths have their own RG-1 e2e in
  // console-settings-danger-e2e.test.ts).
  for (const params of [{ repo: "octocat/other-vault" }, { ref: "release" }]) {
    const response = await fetchAt("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "factory.vault.hydrate", params }),
    });
    assert.equal(response.status, 400, `factory.vault.hydrate ${JSON.stringify(params)} is narrowed off the console`);
    const payload = (await response.json()) as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "forbidden_operation");
    assert.match(payload.error ?? "", /from the console/, "the sentence names whose door refused");
  }
  const dangerResponse = await fetchAt("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "factory.project.delete", params: {} }),
  });
  assert.equal(dangerResponse.status, 400, "factory.project.delete refuses the unscoped delete");
  const dangerPayload = (await dangerResponse.json()) as { ok: boolean; code?: string; error?: string };
  assert.equal(dangerPayload.ok, false);
  assert.equal(dangerPayload.code, "forbidden_operation", "the Danger Zone's scoped-only law refuses as data");
  assert.match(dangerPayload.error ?? "", /refuses the unscoped delete/, "the refusal names the narrowed act it refused");
  // The allowlist sentence — which now carries the round-trip writes, the
  // key import, and the two project writes — answers only on the door's
  // OUTSIDE, read here off a still-unlisted sibling (the Add-Project wizard
  // door, T-12).
  const outsideResponse = await fetchAt("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "factory.project.add", params: {} }),
  });
  assert.equal(outsideResponse.status, 404, "the Add-Project wizard door stays outside");
  const outsidePayload = (await outsideResponse.json()) as { ok: boolean; code?: string; error?: string };
  assert.equal(outsidePayload.ok, false);
  assert.equal(outsidePayload.code, "unknown_method");
  assert.match(outsidePayload.error ?? "", /factory\.vault\.sync, factory\.vault\.hydrate, factory\.vault\.import, factory\.project\.reset, factory\.project\.delete/, "the allowlist sentence carries the round-trip writes, the key import, and the two project writes");
});
