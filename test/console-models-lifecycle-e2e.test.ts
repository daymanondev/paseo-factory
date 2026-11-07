import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { leadRotateViaSidecar, profilesDeleteViaSidecar, profilesSaveViaSidecar, supervisorRevokeViaSidecar } from "../web/src/lanes.ts";
import { modelsScreenModel } from "../web/src/models-view.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-08c): ONE test drives the Agents & Models
 * screen's four lifecycle acts through the console's REAL transport —
 * `web/src/lanes.ts` `profilesSaveViaSidecar` / `profilesDeleteViaSidecar` /
 * `leadRotateViaSidecar` / `supervisorRevokeViaSidecar`, the exact functions
 * the browser bundle calls — against a REAL started sidecar over a REAL
 * Factory fixture whose ONE registered SLP Project carries two fake-daemon
 * seats (a live Lead and a live Supervisor, the labels the seat fold reads).
 * Proves the bounded outcome end to end: a profile save lands in the
 * library AND the re-read roster (the T-08a fold), the delete tombstones it
 * out of both, rotate and revoke answer the handler's own arm against the
 * fake seats (the archive half recorded on the fake daemon, the cancel half
 * on the injected stopAgent seam — never a real paseo process), and the
 * ensure sibling still refuses `unknown_method` at the door (ADR 0017: the
 * console can retire a LIVE seat, never start one).
 */

/** One fake daemon agent row — the seat labels the roster fold and the retire path both read. */
function seatAgent(id: string, seat: "supervisor" | "lead", slug: string, cwd: string): SurfaceAgentSnapshot {
  return {
    id,
    provider: "pi",
    title: seat === "lead" ? "Lead (paseo-factory)" : "Supervisor (paseo-factory)",
    status: "idle",
    model: "glm-5.3",
    labels: { seat, project: slug },
    archivedAt: null,
    requiresAttention: false,
    attentionReason: null,
    updatedAt: "2026-11-08T09:00:00.000Z",
    cwd,
  };
}

test("RG-1: the console's real transport drives the lifecycle — save/delete land in the roster, rotate/revoke answer against fake-daemon seats, supervisor.ensure refuses", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose roster the screen writes.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";

  // The two fake-daemon seats the retire acts target — archived on the fake,
  // cancelled on the injected seam, so no real paseo CLI ever spawns.
  const archived: string[] = [];
  const stopped: string[] = [];
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async () => ({
        entries: [{ agent: seatAgent("agent-lead-1", "lead", slug, repo) }, { agent: seatAgent("agent-sup-1", "supervisor", slug, repo) }],
      }),
      create: async () => ({ id: "unused" }),
      ref: (id: string) => ({
        send: async () => {},
        archive: async () => {
          archived.push(id);
          return { archivedAt: new Date().toISOString() };
        },
        timeline: { refetch: async () => ({ entries: [], error: null }) },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
    },
  };
  const fixture = makeConsoleFixture(homeRoot, { registry: true, daemon, stopAgent: async (agentId) => {
    stopped.push(agentId);
    return { ok: true };
  } });
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug });
  assert.equal(registered.ok, true);
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // The roster read the acts fold back through — the T-08a fold over the
  // REAL snapshot transport.
  const roster = async () => {
    const snapshot = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
    assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
    const model = modelsScreenModel(snapshot.view);
    assert.ok(model !== null, "a scoped read folds the roster — never the unscoped null");
    return model;
  };

  // (a) Save a profile — the save omits `lanes`, so the handler snapshots
  // the Project's CURRENT lane table under the name…
  const saved = await profilesSaveViaSidecar({ name: "Night Ops", description: "the quiet shift", projectRoot: repo }, fetchAt);
  assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
  assert.equal(saved.ok && saved.profile.name, "Night Ops");
  assert.match(saved.ok ? saved.summary : "", /Saved Lane profile "Night Ops"/);
  // …and the re-read roster carries it as a chip.
  const afterSave = await roster();
  assert.deepEqual(
    afterSave.profiles.map((profile) => profile.name),
    ["Night Ops"],
    "the saved profile appears in the re-read roster",
  );

  // (b) Delete it — the tombstone clears the library and the roster follows.
  const deleted = await profilesDeleteViaSidecar({ profileId: saved.ok ? saved.profile.id : "" }, fetchAt);
  assert.equal(deleted.ok, true, deleted.ok ? "" : deleted.error);
  assert.equal(deleted.ok && deleted.deleted, true, "the profile existed and was deleted");
  const afterDelete = await roster();
  assert.deepEqual(afterDelete.profiles, [], "the deleted profile is gone from the re-read roster");
  // A second delete of the same id stays honest data — nothing existed.
  const redeleted = await profilesDeleteViaSidecar({ profileId: saved.ok ? saved.profile.id : "" }, fetchAt);
  assert.equal(redeleted.ok, true);
  assert.equal(redeleted.ok && redeleted.deleted, false, "no such profile exists — nothing deleted");

  // (c) Rotate the Lead — the fake seat is the honest arm: the reply names
  // the archived agent, the cancel ran first, and the registration's Lead
  // binding cleared.
  const rotated = await leadRotateViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(rotated.ok, true, rotated.ok ? "" : `${rotated.ok === false ? rotated.code : ""}: ${rotated.ok === false ? rotated.error : ""}`);
  assert.equal(rotated.ok ? rotated.agentId : "", "agent-lead-1", "the rotate retired the fake Lead seat");
  assert.deepEqual([...stopped], ["agent-lead-1"], "the retire sequence cancelled the outgoing Lead first");
  assert.deepEqual([...archived], ["agent-lead-1"], "the daemon's archive half ran");

  // (d) Revoke the Supervisor — the same honest arm against its fake seat.
  const revoked = await supervisorRevokeViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(revoked.ok, true, revoked.ok ? "" : `${revoked.ok === false ? revoked.code : ""}: ${revoked.ok === false ? revoked.error : ""}`);
  assert.equal(revoked.ok ? revoked.agentId : "", "agent-sup-1", "the revoke retired the fake Supervisor seat");
  assert.deepEqual([...stopped], ["agent-lead-1", "agent-sup-1"]);
  assert.deepEqual([...archived], ["agent-lead-1", "agent-sup-1"]);

  // The ensure sibling — the Start control this console must never grow —
  // still refuses `unknown_method` as data at the door (ADR 0017).
  const ensured = await fetchAt("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "factory.supervisor.ensure", params: { projectRoot: repo } }),
  });
  assert.equal(ensured.status, 404, "factory.supervisor.ensure is not allowlisted");
  const payload = (await ensured.json()) as { ok: boolean; code?: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "unknown_method", "the console can retire a live seat, never start one");
});
