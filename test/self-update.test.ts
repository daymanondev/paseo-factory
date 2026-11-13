/**
 * Ticket 11: the Factory tab's self-update door. Every outside call — git
 * ls-remote and the daemon's list / update check / update — is a fake, so
 * nothing here touches the network or the real ~/.paseo install.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import type { DaemonPluginItem, DaemonPluginSourceStatus } from "../plugin/server/daemon-cli.ts";
import {
  DEFAULT_SELF_REMOTE,
  SELF_UPDATE_CACHE_MS,
  createSelfUpdate,
  highestReleaseTag,
  parseLsRemoteTags,
  parseSemver,
  type RemoteTag,
  type RemoteTagsReply,
} from "../plugin/server/self-update.ts";
import { createSurfaceHandlers, registerSurfaceRpc } from "../plugin/server/surface-rpc.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

const TAG_COMMIT = "a".repeat(40);
const OLD_COMMIT = "b".repeat(40);

function coreItem(version: string, remote = "https://example.test/paseo-factory.git"): DaemonPluginItem {
  return { id: "paseo-factory", path: "/nowhere", enabled: true, status: "running", version, installation: { identity: { kind: "git", remote } } };
}

function harness(opts: {
  current?: string;
  tags?: RemoteTag[] | "fail";
  daemonTarget?: string | null | "fail";
  manage?: { ok: true } | { ok: false; reason: string };
}) {
  const calls = { lsRemote: [] as string[], check: 0, manage: [] as string[], before: 0 };
  let clock = 1_000_000;
  const tags = opts.tags ?? [{ name: "v0.8.2", commit: OLD_COMMIT }];
  const selfUpdate = createSelfUpdate({
    home: "/fake-home",
    now: () => clock,
    listPlugins: async () => ({ ok: true, plugins: [coreItem(opts.current ?? "0.8.2")] }),
    listRemoteTags: async (remote): Promise<RemoteTagsReply> => {
      calls.lsRemote.push(remote);
      return tags === "fail" ? { ok: false, reason: "network down" } : { ok: true, tags };
    },
    checkPluginUpdates: async () => {
      calls.check += 1;
      if (opts.daemonTarget === "fail") return { ok: false, reason: "daemon unreachable" };
      const row: DaemonPluginSourceStatus = { id: "paseo-factory", currentRevision: OLD_COMMIT, latestRevision: opts.daemonTarget ?? null, commitsBehind: null, updateAvailable: true };
      return { ok: true, statuses: [row], checkedAt: new Date(clock).toISOString() };
    },
    managePlugin: async (_home, id, action) => {
      calls.manage.push(`${id}:${action}`);
      return opts.manage ?? { ok: true };
    },
    beforeUpdate: () => {
      calls.before += 1;
      return { ok: true };
    },
  });
  return { selfUpdate, calls, advance: (ms: number) => { clock += ms; } };
}

test("semver: only plain vX.Y.Z tags count and v0.10.0 > v0.9.9 > v0.8.2", () => {
  assert.deepEqual(parseSemver("v0.10.0"), [0, 10, 0]);
  assert.equal(parseSemver("v1.0.0-rc1"), null);
  assert.equal(parseSemver("main"), null);
  const tags: RemoteTag[] = [
    { name: "v0.8.2", commit: "1".repeat(40) },
    { name: "v0.10.0", commit: "2".repeat(40) },
    { name: "v0.9.9", commit: "3".repeat(40) },
    { name: "v1.0.0-rc1", commit: "4".repeat(40) },
    { name: "nightly", commit: "5".repeat(40) },
  ];
  assert.deepEqual(highestReleaseTag(tags), { version: "0.10.0", commit: "2".repeat(40) });
  assert.equal(highestReleaseTag([{ name: "nightly", commit: "5".repeat(40) }]), null);
});

test("ls-remote parsing keeps an annotated tag's peeled commit", () => {
  const raw = [
    `${"1".repeat(40)}\trefs/tags/v0.8.1`,
    `${"2".repeat(40)}\trefs/tags/v0.8.2`,
    `${"3".repeat(40)}\trefs/tags/v0.8.2^{}`,
    "not a ref line",
  ].join("\n");
  const tags = parseLsRemoteTags(raw);
  assert.deepEqual(tags.find((t) => t.name === "v0.8.1"), { name: "v0.8.1", commit: "1".repeat(40) });
  assert.deepEqual(tags.find((t) => t.name === "v0.8.2"), { name: "v0.8.2", commit: "3".repeat(40) });
  assert.equal(tags.length, 2);
});

test("a newer tag the daemon would install is an available update", async () => {
  const h = harness({ tags: [{ name: "v0.8.2", commit: OLD_COMMIT }, { name: "v0.9.0", commit: TAG_COMMIT }], daemonTarget: TAG_COMMIT });
  const reply = await h.selfUpdate.status();
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.equal(reply.current, "0.8.2");
  assert.equal(reply.latest, "0.9.0");
  assert.equal(reply.updateAvailable, true);
  assert.equal(reply.note, undefined);
  assert.deepEqual(h.calls.lsRemote, ["https://example.test/paseo-factory.git"], "asks the daemon's installation remote");
});

test("the highest semver tag wins, not the latest-listed one", async () => {
  const h = harness({
    current: "0.8.2",
    tags: [{ name: "v0.10.0", commit: TAG_COMMIT }, { name: "v0.9.9", commit: "c".repeat(40) }, { name: "v0.8.2", commit: OLD_COMMIT }],
    daemonTarget: TAG_COMMIT.slice(0, 12),
  });
  const reply = await h.selfUpdate.status();
  assert.ok(reply.ok && reply.latest === "0.10.0" && reply.updateAvailable, "an abbreviated daemon target still matches the tag commit");
});

test("equal version: no update, and the daemon is never asked", async () => {
  const h = harness({ current: "0.8.2", tags: [{ name: "v0.8.2", commit: OLD_COMMIT }] });
  const reply = await h.selfUpdate.status();
  assert.ok(reply.ok);
  if (!reply.ok) return;
  assert.equal(reply.latest, "0.8.2");
  assert.equal(reply.updateAvailable, false);
  assert.equal(reply.note, undefined);
  assert.equal(h.calls.check, 0);
});

test("downgrade guard: Paseo's target is not the latest tag's commit (the v0.6.1 case) — no update, with a note", async () => {
  const h = harness({ current: "0.8.2", tags: [{ name: "v0.8.2", commit: OLD_COMMIT }, { name: "v0.9.0", commit: TAG_COMMIT }], daemonTarget: "d".repeat(40) });
  const reply = await h.selfUpdate.status();
  assert.ok(reply.ok);
  if (!reply.ok) return;
  assert.equal(reply.latest, "0.9.0");
  assert.equal(reply.updateAvailable, false);
  assert.match(reply.note ?? "", /not on v0\.9\.0 yet/);
  const applied = await h.selfUpdate.apply();
  assert.equal(applied.ok, false);
  assert.deepEqual(h.calls.manage, [], "apply never updates behind the guard");
});

test("a daemon that cannot say what it would install is never trusted", async () => {
  const h = harness({ tags: [{ name: "v0.9.0", commit: TAG_COMMIT }], daemonTarget: "fail" });
  const reply = await h.selfUpdate.status();
  assert.ok(reply.ok);
  if (!reply.ok) return;
  assert.equal(reply.updateAvailable, false);
  assert.match(reply.note ?? "", /daemon unreachable/);
});

test("ls-remote failure: latest is null with a short note, and it is not cached", async () => {
  const h = harness({ tags: "fail" });
  const first = await h.selfUpdate.status();
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(first.latest, null);
  assert.equal(first.updateAvailable, false);
  assert.match(first.note ?? "", /network down/);
  await h.selfUpdate.status();
  assert.equal(h.calls.lsRemote.length, 2, "a failed check retries on the next ask");
});

test("a good status is cached ~10 minutes per home; force bypasses it", async () => {
  const h = harness({ tags: [{ name: "v0.8.2", commit: OLD_COMMIT }] });
  await h.selfUpdate.status();
  await h.selfUpdate.status();
  assert.equal(h.calls.lsRemote.length, 1);
  await h.selfUpdate.status({ force: true });
  assert.equal(h.calls.lsRemote.length, 2);
  h.advance(SELF_UPDATE_CACHE_MS + 1);
  await h.selfUpdate.status();
  assert.equal(h.calls.lsRemote.length, 3);
});

test("falls back to the default remote when the daemon names none", async () => {
  const lsRemote: string[] = [];
  const selfUpdate = createSelfUpdate({
    home: "/fake-home",
    listPlugins: async () => ({ ok: true, plugins: [{ id: "paseo-factory", path: "/nowhere", enabled: true, status: "running", version: "0.8.2" }] }),
    listRemoteTags: async (remote) => {
      lsRemote.push(remote);
      return { ok: true, tags: [{ name: "v0.8.2", commit: OLD_COMMIT }] };
    },
  });
  await selfUpdate.status();
  assert.deepEqual(lsRemote, [DEFAULT_SELF_REMOTE]);
});

test("apply refuses when no update is available and updates the daemon when one is", async () => {
  const none = harness({ tags: [{ name: "v0.8.2", commit: OLD_COMMIT }] });
  const refused = await none.selfUpdate.apply();
  assert.equal(refused.ok, false);
  assert.deepEqual(none.calls.manage, []);
  assert.equal(none.calls.before, 0);

  const ready = harness({ tags: [{ name: "v0.9.0", commit: TAG_COMMIT }], daemonTarget: TAG_COMMIT });
  await ready.selfUpdate.status(); // a cached "available" answer must not be trusted — apply re-checks
  const applied = await ready.selfUpdate.apply();
  assert.deepEqual(applied, { ok: true, from: "0.8.2", to: "0.9.0" });
  assert.deepEqual(ready.calls.manage, ["paseo-factory:update"]);
  assert.equal(ready.calls.before, 1);
  assert.equal(ready.calls.lsRemote.length, 2, "apply re-ran the status, forced");

  const failing = harness({ tags: [{ name: "v0.9.0", commit: TAG_COMMIT }], daemonTarget: TAG_COMMIT, manage: { ok: false, reason: "boom" } });
  const failed = await failing.selfUpdate.apply();
  assert.deepEqual(failed, { ok: false, code: "daemon_failed", error: "boom" });
});

test("the surface registers both doors and routes them through the injected deps", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const managed: string[] = [];
  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    userHome: dir,
    daemon: {} as never,
    listPlugins: async () => ({ ok: true, plugins: [coreItem("0.8.2")] }),
    listRemoteTags: async () => ({ ok: true, tags: [{ name: "v0.9.0", commit: TAG_COMMIT }] }),
    checkPluginUpdates: async () => ({ ok: true, checkedAt: new Date().toISOString(), statuses: [{ id: "paseo-factory", currentRevision: OLD_COMMIT, latestRevision: TAG_COMMIT, commitsBehind: 1, updateAvailable: true }] }),
    managePlugin: async (_home, id, action) => {
      managed.push(`${id}:${action}`);
      return { ok: true };
    },
  });
  const names: string[] = [];
  registerSurfaceRpc({ handle: (rpc: { name: string }) => { names.push(rpc.name); } } as never, handlers);
  assert.ok(names.includes("factory.self.update.status"));
  assert.ok(names.includes("factory.self.update.apply"));

  const status = await handlers.selfUpdateStatus({});
  assert.ok(status.ok && status.updateAvailable && status.latest === "0.9.0");
  const applied = await handlers.selfUpdateApply({});
  assert.deepEqual(applied, { ok: true, from: "0.8.2", to: "0.9.0" });
  assert.deepEqual(managed, ["paseo-factory:update"]);
});
