import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyLaneProfile, loadLanes, saveLaneProfile } from "../plugin/server/core/lanes.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { modelsScreenModel, type ModelsLaneRow } from "../web/src/models-view.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-08a): at least one test drives the console's
 * REAL snapshot read — `web/src/useSnapshot.ts` `loadSnapshotViaSidecar`,
 * the exact function the browser bundle calls — against a REAL started
 * sidecar over a REAL Factory fixture whose ONE registered SLP Project
 * carries a Lane profile applied as the Project's own `lanes.json` override
 * (one lane different from the machine table) plus one live labeled
 * supervisor seat on a fake daemon shaped like the SDK's `agents.list` seam.
 * Proves the bounded outcome end to end: the Agents & Models fold renders
 * the read-only roster from the snapshot alone — every lane's
 * provider/model[:thinking] split, the override source derived against the
 * machine table, the live seat bound to the supervisor lane, the passenger
 * lanes' honest vacancy, and the saved profile library with the applied one
 * marked active — and an unscoped read answers the screen's honest null,
 * never a fabricated roster.
 */

/** One fully-typed fake agent — the `SurfaceAgentSnapshot` slice the surface reads. */
function fakeAgent(over: Partial<SurfaceAgentSnapshot> & Pick<SurfaceAgentSnapshot, "id" | "labels" | "status">): SurfaceAgentSnapshot {
  return {
    provider: "pi",
    title: null,
    model: null,
    archivedAt: null,
    requiresAttention: false,
    attentionReason: null,
    updatedAt: new Date().toISOString(),
    cwd: "/",
    ...over,
  };
}

/** A fake daemon shaped exactly like the SDK call path the snapshot walks — the `emptyDaemon` slice plus the Project's own seat. */
function seatsDaemon(agents: SurfaceAgentSnapshot[]): SurfaceDaemonApi {
  return {
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })) }),
      create: async () => ({ id: "unused" }),
      ref: (id: string) => ({
        send: async () => {},
        archive: async () => ({ archivedAt: new Date().toISOString() }),
        timeline: { refetch: async () => ({ entries: [], error: null }) },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
    },
  };
}

test("RG-1: the console's real transport folds the Agents & Models roster — override sources, the live seat, the applied profile", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose roster the screen folds.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";
  // The fake daemon's one labeled seat — the supervisor, scoped to the slug.
  const daemon = seatsDaemon([
    fakeAgent({ id: "agent-sup-1", title: "Supervisor", status: "running", model: "z-sup", labels: { seat: "supervisor", project: slug }, cwd: repo }),
  ]);
  const fixture = makeConsoleFixture(homeRoot, { registry: true, daemon });
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug });
  assert.equal(registered.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // The Project's own roster, through the REAL core the live server imports:
  // one saved profile — the machine table with the Lead lane swapped — applied
  // Copy-on-Apply to the Project's `lanes.json` (ADR 0026 §2), so the scoped
  // snapshot carries ONE honest override (lead) beside five machine defaults
  // and the recorded active profile for this scope.
  const machine = loadLanes(fixture.stateDir);
  assert.equal(machine.ok, true);
  const profile = saveLaneProfile(fixture.stateDir, {
    name: "Night Shift",
    lanes: { ...machine.lanes, lead: "codex/gpt-5.4:high" },
  });
  applyLaneProfile(fixture.stateDir, profile.id, slug);

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // The scoped read through the real transport: the fold renders the Project's
  // roster — every lane's model split, the override source, the live seat.
  const snapshot = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
  assert.equal(snapshot.view.project?.slug, slug);
  assert.equal(snapshot.view.hasProjectLaneOverride, true, "the applied profile wrote the Project's own lanes.json");
  const model = modelsScreenModel(snapshot.view);
  assert.ok(model !== null, "a scoped read folds the roster — never the unscoped null");
  assert.equal(model.mode, "slp");
  assert.equal(model.scope, snapshot.view.project.name ?? snapshot.view.project.slug);
  assert.equal(model.rosterNote, "Project lanes");
  assert.deepEqual(
    model.rows.map((row) => row.lane),
    ["supervisor", "lead", "worker", "watch", "retro", "freshEyes"],
  );
  const supervisor = model.rows[0]!;
  assert.equal(supervisor.raw, snapshot.view.machineLanes.supervisor);
  assert.equal(supervisor.source, "default");
  assert.equal(supervisor.sourceLabel, "Machine default");
  assert.deepEqual(supervisor.seats.map((seat) => [seat.agentId, seat.state.label]), [["agent-sup-1", "Live"]]);
  const lead = model.rows[1]!;
  assert.equal(lead.raw, "codex/gpt-5.4:high");
  assert.equal(lead.provider, "codex");
  assert.equal(lead.model, "gpt-5.4");
  assert.equal(lead.thinking, "high");
  assert.equal(lead.source, "override");
  assert.equal(lead.sourceLabel, "Project override");
  assert.equal(lead.seats.length, 0, "the Lead seat is vacant — rendered honest, never fabricated");
  const worker = model.rows[2]!;
  assert.equal(worker.source, "default");
  assert.equal(worker.seats.length, 0);
  for (const lane of ["watch", "retro", "freshEyes"]) {
    // The annotation breaks TS7022: `find`'s generic inference over this
    // closure cannot resolve `row` on its own (the bare `find … !` idiom
    // elsewhere in the repo infers fine — this row shape's chain does not).
    const row: ModelsLaneRow = model.rows.find((candidate) => candidate.lane === lane)!;
    assert.deepEqual(row.seats, [], lane);
    assert.equal(row.vacantNote, "Spawned per Task", lane);
  }
  // The applied profile is the active one — recorded by the apply, still live.
  assert.deepEqual(
    model.profiles.map((entry) => [entry.name, entry.active]),
    [["Night Shift", true]],
  );
  assert.equal(model.activeProfileName, "Night Shift");
  assert.equal(model.activeProfileModified, false, "the lanes are exactly the applied profile's — not modified");

  // The unscoped read through the same transport: no Project selected — the
  // fold answers the screen's own empty state, never a fabricated roster.
  const global = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(global.ok, true, global.ok ? "" : global.error);
  assert.equal(modelsScreenModel(global.view), null);
});
