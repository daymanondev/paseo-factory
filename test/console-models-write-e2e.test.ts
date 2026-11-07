import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLanes, projectLanesPath, saveLaneProfile } from "../plugin/server/core/lanes.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { lanesResetViaSidecar, lanesSetViaSidecar, profilesApplyViaSidecar } from "../web/src/lanes.ts";
import { modelsScreenModel, type ModelsLaneRow } from "../web/src/models-view.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-08b): ONE test drives the Agents & Models
 * screen's three lane writes through the console's REAL transport —
 * `web/src/lanes.ts` `lanesSetViaSidecar` / `lanesResetViaSidecar` /
 * `profilesApplyViaSidecar`, the exact functions the browser bundle calls —
 * against a REAL started sidecar over a REAL Factory fixture whose ONE
 * registered SLP Project has no live seats (the write replies carry the
 * handler's own `modelSync` sentence; no seat CLI ever runs). Proves the
 * bounded outcome end to end: a lane set lands in the Project's own
 * `lanes.json` on disk AND in the re-read roster (the T-08a fold), a
 * profile apply Copy-on-Apply replaces the whole table and marks the
 * profile active, the reset removes the override, and a forbidden sibling
 * write (`factory.lanes.set.batch`) still refuses `unknown_method` as data
 * at the door.
 */

test("RG-1: the console's real transport writes the lanes — set lands on disk and in the roster, apply copies the profile, reset removes the override, the batch door refuses", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose roster the screen writes.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";
  const fixture = makeConsoleFixture(homeRoot, { registry: true });
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug });
  assert.equal(registered.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // One saved profile — the machine table with Lead and Watch swapped — NOT
  // applied: the apply rides the door under test, Copy-on-Apply.
  const machine = loadLanes(fixture.stateDir);
  assert.equal(machine.ok, true);
  const profile = saveLaneProfile(fixture.stateDir, {
    name: "Night Shift",
    lanes: { ...machine.lanes, lead: "codex/gpt-5.4:high", watch: "pi/zai/glm-5.3-air" },
  });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // The roster read the writes fold back through — the T-08a fold over the
  // REAL snapshot transport.
  const roster = async () => {
    const snapshot = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
    assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
    const model = modelsScreenModel(snapshot.view);
    assert.ok(model !== null, "a scoped read folds the roster — never the unscoped null");
    return model;
  };
  const rowOf = (model: NonNullable<ReturnType<typeof modelsScreenModel>>, lane: string): ModelsLaneRow => model.rows.find((candidate) => candidate.lane === lane)!;

  // (a) Set a lane — the write lands in the Project's own lanes.json on disk…
  const set = await lanesSetViaSidecar({ lane: "lead", value: "codex/gpt-5.4:high", projectRoot: repo }, fetchAt);
  assert.equal(set.ok, true, set.ok ? "" : set.error);
  assert.equal(set.lanes.lead, "codex/gpt-5.4:high");
  const overridePath = projectLanesPath(fixture.stateDir, slug);
  assert.ok(existsSync(overridePath), "the Project's own lanes.json exists after the set");
  const onDisk = JSON.parse(readFileSync(overridePath, "utf8")) as Record<string, string>;
  assert.equal(onDisk.lead, "codex/gpt-5.4:high", "the disk override carries the saved lane");
  // …and in the re-read roster: the override source, the split, the flag.
  const afterSet = await roster();
  assert.equal(afterSet.writable, true, "the SLP roster's table is the one the writes target");
  const leadRow = rowOf(afterSet, "lead");
  assert.equal(leadRow.raw, "codex/gpt-5.4:high");
  assert.equal(leadRow.provider, "codex");
  assert.equal(leadRow.thinking, "high");
  assert.equal(leadRow.source, "override");

  // (c) Apply a profile — Copy-on-Apply replaces the whole table in ONE
  // write and records the active profile for this scope.
  const applied = await profilesApplyViaSidecar({ profileId: profile.id, projectRoot: repo }, fetchAt);
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
  assert.equal(applied.lanes.watch, "pi/zai/glm-5.3-air");
  const afterApply = await roster();
  assert.equal(rowOf(afterApply, "watch").raw, "pi/zai/glm-5.3-air");
  assert.equal(rowOf(afterApply, "watch").source, "override");
  assert.deepEqual(
    afterApply.profiles.map((entry) => [entry.name, entry.active]),
    [["Night Shift", true]],
    "the applied profile is the roster's active one",
  );

  // (b) Reset lanes — the override file is removed and every lane inherits
  // the machine table again.
  const reset = await lanesResetViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(reset.ok, true, reset.ok ? "" : reset.error);
  assert.equal(reset.removed, true, "the Project override existed and was removed");
  assert.equal(existsSync(overridePath), false, "the Project's lanes.json is gone");
  const afterReset = await roster();
  assert.equal(rowOf(afterReset, "lead").raw, machine.lanes.lead);
  assert.equal(rowOf(afterReset, "lead").source, "default");
  assert.equal(rowOf(afterReset, "watch").source, "default");

  // The door stays a list: the batch sibling and the ensure act refuse
  // `unknown_method` as data, never a dispatch (the profile CRUD and the
  // rotate/revoke retire acts joined the door in T-08c — their own e2e
  // drives them; `supervisor.ensure` never does, ADR 0017).
  for (const method of ["factory.lanes.set.batch", "factory.lead.ensure", "factory.supervisor.ensure", "factory.project.reset"]) {
    const response = await fetchAt("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params: {} }),
    });
    assert.equal(response.status, 404, `${method} is not allowlisted`);
    const payload = (await response.json()) as { ok: boolean; code?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "unknown_method", `${method} refuses at the door`);
  }
});
