import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { projectDeleteViaSidecar, projectResetViaSidecar } from "../web/src/project.ts";
import { makeConsoleFixture, makeReadyToAcceptTask } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-10e): ONE test drives the Settings screen's
 * Danger Zone writes through the console's REAL transport — `web/src/project.ts`
 * `projectResetViaSidecar` / `projectDeleteViaSidecar`, the exact functions
 * the browser bundle calls — against a REAL started sidecar over a REAL
 * Factory fixture with TWO registered temp git Projects, each holding its
 * own per-Project Factory (the T-05 registry law — never the root's ledger).
 * Proves the bounded outcome end to end: the scoped reset (keepSeats — the
 * dialog checkbox's default arm) purges alpha's Ledger events and task state
 * so the re-read scoped snapshot carries no Task, its reply carrying the
 * handler's own summary and purged counts; the scoped delete removes beta
 * whole so the re-read unscoped snapshot's `view.projects` drops it (alpha
 * survives); and the door's narrowings answer through the SAME transport —
 * the unscoped reset/delete and delete's `seat` field all refuse
 * `forbidden_operation` as data BEFORE any handler runs. Nothing here touches
 * `~/.paseo` (the fixture's own temp home law) and no daemon socket exists,
 * so the delete's daemon sweep no-ops by design.
 */

test("RG-1: the console's real transport drives the Danger Zone — scoped reset purges alpha's tasks, scoped delete drops beta from view.projects, the unscoped/seat shapes refuse", async (t) => {
  const homeRoot = makeTempDir();
  // Two registered git repos — the per-Project Factories read their own ledgers.
  const makeRepo = (name: string): { repo: string; sha: string } => {
    const repo = join(homeRoot, name);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), `# ${name}\n`);
    const sha = gitCommitAll(repo);
    return { repo, sha };
  };
  const alpha = makeRepo("alpha");
  const beta = makeRepo("beta");
  // Registered against the fixture's OWN stateDir under the slugs the
  // snapshot's own `resolveProject` derives from each repo (`basename-hash`,
  // the flow-drawer e2e's law) — the registry the fixture wires resolves
  // both slugs to per-Project Factories.
  const alphaResolved = resolveProject(alpha.repo);
  const betaResolved = resolveProject(beta.repo);
  assert.equal(alphaResolved.ok, true, alphaResolved.ok ? "" : alphaResolved.reason);
  assert.equal(betaResolved.ok, true, betaResolved.ok ? "" : betaResolved.reason);
  const alphaSlug = alphaResolved.ok ? alphaResolved.slug : "";
  const betaSlug = betaResolved.ok ? betaResolved.slug : "";
  const fixture = makeConsoleFixture(homeRoot, { registry: true });
  const alphaReg = ensureProjectRegistered(fixture.stateDir, { root: alpha.repo, slug: alphaSlug });
  const betaReg = ensureProjectRegistered(fixture.stateDir, { root: beta.repo, slug: betaSlug });
  assert.equal(alphaReg.ok, true);
  assert.equal(betaReg.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // Alpha: one ready-to-accept Task on its OWN Factory — the reset's purge
  // target. Its workspace lives INSIDE alpha's repo (the purge's own law:
  // a Task belongs to the Project whose root contains its workspace), a
  // nested git repo the fixture helper commits on its own.
  const alphaFactory = fixture.registry.factoryForProject(alphaSlug);
  makeReadyToAcceptTask(alphaFactory, alpha.repo, "T10E");

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // (a) The honest start through the real read: alpha's scoped snapshot
  // carries the Task, and the unscoped view lists BOTH Projects.
  const before = await loadSnapshotViaSidecar({ projectRoot: alpha.repo }, fetchAt);
  assert.equal(before.ok, true, before.ok ? "" : before.error);
  assert.equal(before.view.tasks.some((task) => task.task === "T10E"), true, "the scoped view folds alpha's Task before the reset");
  const unscopedBefore = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(unscopedBefore.ok, true, unscopedBefore.ok ? "" : unscopedBefore.error);
  assert.deepEqual(
    unscopedBefore.view.projects.map((project) => project.slug).sort(),
    [alphaSlug, betaSlug].sort(),
    "both registered Projects are in view before the Danger Zone acts",
  );

  // (b) The reset through the real web write client — keepSeats spelled true
  // (the dialog checkbox's default, checked arm). The reply IS the handler's
  // own summary and counts: alpha's per-Project ledger purged its events and
  // the Task's state.
  const reset = await projectResetViaSidecar({ projectRoot: alpha.repo, keepSeats: true }, fetchAt);
  assert.equal(reset.ok, true, reset.ok ? "" : reset.error);
  assert.ok(reset.ok);
  assert.equal(reset.project, alphaSlug);
  assert.equal(reset.projectRoot, realpathSync(alpha.repo));
  assert.ok(reset.purgedEvents >= 1, "the reset purged alpha's ledger events");
  assert.ok(reset.tasks.includes("T10E"), "the reset's task set names the purged Task");
  assert.match(reset.summary, new RegExp(`Reset project ${alphaSlug}`));
  // The re-read scoped snapshot shows the purge: alpha's Task is gone, the
  // Project itself still registered (reset keeps the Project; only its
  // Factory state is purged).
  const afterReset = await loadSnapshotViaSidecar({ projectRoot: alpha.repo }, fetchAt);
  assert.equal(afterReset.ok, true, afterReset.ok ? "" : afterReset.error);
  assert.equal(afterReset.view.tasks.some((task) => task.task === "T10E"), false, "the re-read scoped snapshot shows the Task purged");
  assert.equal(afterReset.view.tasks.length, 0, "alpha's scoped view carries no Task at all after the purge");

  // (c) The delete through the real web write client — beta's scoped root
  // alone. The Project leaves the Factory whole: the re-read unscoped
  // snapshot's view.projects drops beta while alpha survives.
  const deleted = await projectDeleteViaSidecar({ projectRoot: beta.repo }, fetchAt);
  assert.equal(deleted.ok, true, deleted.ok ? "" : deleted.error);
  assert.ok(deleted.ok);
  assert.equal(deleted.project, betaSlug);
  // The delete's summary names the Project by its basename ("beta"), the
  // reply's `project` field by its slug — both spell the same Project.
  assert.match(deleted.summary, /Deleted project beta\b/);
  const unscopedAfter = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(unscopedAfter.ok, true, unscopedAfter.ok ? "" : unscopedAfter.error);
  assert.equal(
    unscopedAfter.view.projects.some((project) => project.slug === betaSlug),
    false,
    "the deleted Project left view.projects",
  );
  assert.equal(
    unscopedAfter.view.projects.some((project) => project.slug === alphaSlug),
    true,
    "the reset-then-kept Project survives its sibling's delete",
  );

  // (d) The door's narrowings through the SAME real transport — raw /rpc
  // posts: both writes REQUIRE a non-empty projectRoot (the unscoped shapes
  // refuse) and delete also refuses the `seat` field, every refusal a 400
  // `forbidden_operation` BEFORE any handler runs.
  const refusals: { method: string; params: Record<string, unknown>; sentence: RegExp }[] = [
    { method: "factory.project.reset", params: {}, sentence: /refuses the unscoped reset/ },
    { method: "factory.project.delete", params: {}, sentence: /refuses the unscoped delete/ },
    { method: "factory.project.delete", params: { projectRoot: alpha.repo, seat: "agent" }, sentence: /refuses seat/ },
  ];
  for (const refused of refusals) {
    const response = await fetchAt("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: refused.method, params: refused.params }),
    });
    assert.equal(response.status, 400, `${refused.method} ${JSON.stringify(refused.params)} refuses at the door`);
    const payload = (await response.json()) as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "forbidden_operation");
    assert.match(payload.error ?? "", refused.sentence, "the refusal spells the narrowed act it refused");
  }
});
