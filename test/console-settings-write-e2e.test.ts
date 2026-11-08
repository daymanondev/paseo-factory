import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createDefaultVaultRunner } from "../plugin/server/core/vault-transport.ts";
import type { VaultRunner } from "../plugin/server/core/vault.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { vaultConfigureViaSidecar, vaultPullViaSidecar, vaultPushViaSidecar } from "../web/src/vault.ts";
import { settingsScreenModel } from "../web/src/settings-view.ts";
import { makeConsoleFixture, makeReadyToAcceptTask } from "./console-fixture.ts";
import { makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-10b): ONE test drives the Settings screen's
 * three vault writes through the console's REAL transport —
 * `web/src/vault.ts` `vaultConfigureViaSidecar` / `vaultPullViaSidecar` /
 * `vaultPushViaSidecar`, the exact functions the browser bundle calls —
 * against a REAL started sidecar over a REAL Factory fixture whose vault
 * remote is a LOCAL bare git repository (the transport group's own
 * `git init --bare` fixture law — nothing touches GitHub) and whose injected
 * vaultRunner seam answers `gh` with a deterministic ENOENT (no host `gh`
 * flips the fold) while every `git` call runs for real. Proves the bounded
 * outcome end to end: configure persists the repo/branch and the NEXT
 * snapshot folds the Settings panel's configured face; pull clones the empty
 * bare remote, hydrates nothing, and stamps `Last hydrated · sync`; push (with
 * includeLedgers — the confirm checkbox's checked arm) commits this node's
 * global ledger snapshot into the checkout and MOVES the bare remote's
 * branch, and the NEXT snapshot folds `Last pushed` and the clone presence;
 * and the T-10e Danger Zone's own narrowing answers through the same door —
 * `factory.project.delete` with no projectRoot refuses `forbidden_operation`
 * as data (the door's scoped-only law; the two writes' happy paths have
 * their own RG-1 e2e in console-settings-danger-e2e.test.ts), the allowlist
 * sentence carrying the six vault writes and the two project writes.
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

test("RG-1: the console's real transport writes the vault — configure, pull, and push land; the danger zone's scoped-only law refuses", async (t) => {
  const homeRoot = makeTempDir();
  const bare = makeBareRemote(homeRoot);
  // The hybrid runner the write e2e needs: `gh` answers the deterministic
  // missing-binary ENOENT (the T-10a law — no host gh flips the fold's gh
  // facts), while `git` runs for real against the local bare remote.
  const gitRunner = createDefaultVaultRunner();
  const runner: VaultRunner = async (call) => {
    if (call.command === "gh") {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    }
    return gitRunner(call);
  };
  const fixture = makeConsoleFixture(homeRoot, { vaultRunner: runner });
  // One green task's ledger lines — push's includeLedgers arm has a real
  // global ledger to snapshot under this node's namespace.
  makeReadyToAcceptTask(fixture.factory, homeRoot, "TV");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // (a) The honest start: the unconfigured vault through the real read.
  const before = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(before.ok, true, before.ok ? "" : before.error);
  assert.equal(settingsScreenModel(before.view).vault.configured, false);

  // (b) Configure through the real web client — the local bare path as the
  // repo, no passphrase field at all (the dialog's "Leave unchanged" omits
  // it; the schema's absent-preserves law keeps the home passphrase-free).
  const configure = await vaultConfigureViaSidecar({ repo: bare, branch: "main" }, fetchAt);
  assert.equal(configure.ok, true, configure.ok ? "" : configure.error);
  assert.ok(configure.ok);
  assert.equal(configure.vault.configured, true);
  assert.equal(configure.vault.repo, bare);
  assert.equal(configure.vault.hasPassphrase, false, "an omitted passphrase preserved the home's (absent) passphrase");
  assert.match(configure.summary, /Saved vault config/);

  // (c) The NEXT snapshot folds the panel's configured face — repo and
  // branch land, the clone is still honestly Absent (no pull or push yet).
  const configured = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(configured.ok, true, configured.ok ? "" : configured.error);
  const configuredModel = settingsScreenModel(configured.view);
  assert.equal(configuredModel.vault.configuredLabel, "Configured");
  assert.equal(configuredModel.vault.repo, bare);
  assert.equal(configuredModel.vault.branch, "main");
  assert.equal(configuredModel.vault.cloneLabel, "Absent");
  assert.equal(configuredModel.vault.lastHydratedLabel, "Never");
  assert.equal(configuredModel.vault.lastPushedLabel, "Never");

  // (d) Pull through the real web client — the unchecked confirm's {} —
  // clones the empty bare remote (the unborn-branch path) and stamps sync.
  const pull = await vaultPullViaSidecar({}, fetchAt);
  assert.equal(pull.ok, true, pull.ok ? "" : pull.error);
  assert.ok(pull.ok);
  assert.deepEqual(pull.hydratedFiles, [], "the empty remote hydrates nothing");
  assert.match(pull.summary, /Pulled and hydrated 0 file\(s\)/);
  const pulled = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(pulled.ok, true, pulled.ok ? "" : pulled.error);
  const pulledModel = settingsScreenModel(pulled.view);
  assert.notEqual(pulledModel.vault.lastHydratedLabel, "Never");
  assert.match(pulledModel.vault.lastHydratedLabel, / UTC · sync$/, "the pull stamps the hydrate clock in sync mode");
  assert.equal(pulledModel.vault.lastPushedLabel, "Never");

  // (e) Push through the real web client — the checked confirm's
  // includeLedgers — snapshots this node's global ledger into the checkout
  // and MOVES the bare remote's branch (unborn before, a real sha after).
  const nodeId = pulled.view.vault.nodeId;
  const push = await vaultPushViaSidecar({ includeLedgers: true }, fetchAt);
  assert.equal(push.ok, true, push.ok ? "" : push.error);
  assert.ok(push.ok);
  assert.ok(
    push.pushedFiles.includes(`state/nodes/${nodeId}/global-ledger.jsonl`),
    `the ledger snapshot rides under this node's namespace: ${push.pushedFiles.join(", ")}`,
  );
  const remoteHead = runGit(["--git-dir", bare, "rev-parse", "refs/heads/main"]);
  assert.match(remoteHead, /^[0-9a-f]{40}$/, "the push moved the bare remote's branch");

  // (f) The NEXT snapshot folds the push: the Last pushed stamp and the
  // clone presence the panel renders.
  const pushed = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(pushed.ok, true, pushed.ok ? "" : pushed.error);
  const pushedModel = settingsScreenModel(pushed.view);
  assert.notEqual(pushedModel.vault.lastPushedLabel, "Never");
  assert.equal(pushedModel.vault.cloneLabel, "Present");
  assert.notEqual(pushedModel.vault.lastHydratedLabel, "Never");

  // (g) The T-10e Danger Zone's narrowing through the SAME door — the two
  // project writes are allowlisted but scoped-only: an input with no
  // projectRoot refuses `forbidden_operation` as data BEFORE any handler
  // runs (their happy paths have their own RG-1 e2e). The allowlist
  // sentence itself — which now carries the six landed vault writes plus
  // the two project writes — answers only on the door's OUTSIDE, so it is
  // read here off a still-unlisted sibling (the Add-Project wizard door,
  // T-12).
  const response = await fetchAt("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "factory.project.delete", params: {} }),
  });
  assert.equal(response.status, 400, "factory.project.delete refuses the unscoped delete");
  const payload = (await response.json()) as { ok: boolean; code?: string; error?: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "forbidden_operation", "the Danger Zone's scoped-only law refuses as data");
  assert.match(payload.error ?? "", /refuses the unscoped delete/, "the refusal names the narrowed act it refused");
  const outside = await fetchAt("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "factory.project.add", params: {} }),
  });
  assert.equal(outside.status, 404, "the Add-Project wizard door stays outside");
  const outsidePayload = (await outside.json()) as { ok: boolean; code?: string; error?: string };
  assert.equal(outsidePayload.ok, false);
  assert.equal(outsidePayload.code, "unknown_method");
  assert.match(outsidePayload.error ?? "", /factory\.vault\.configure, factory\.vault\.pull, factory\.vault\.push, factory\.vault\.sync, factory\.vault\.hydrate, factory\.vault\.import, factory\.project\.reset, factory\.project\.delete/, "the allowlist sentence carries the six vault writes and the two project writes");
});
