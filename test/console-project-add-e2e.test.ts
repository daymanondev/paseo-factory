import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "../plugin/server/core/project.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { projectAddViaSidecar, projectPickFolderViaSidecar } from "../web/src/project.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-12): ONE test drives the Add-Project wizard's
 * writes through the console's REAL transport — `web/src/project.ts`
 * `projectAddViaSidecar` / `projectPickFolderViaSidecar`, the exact functions
 * the browser bundle calls — against a REAL started sidecar over a REAL
 * Factory fixture with the per-Project registry wired. Proves the bounded
 * outcome end to end: a temp git repo added BY PATH registers and appears in
 * the re-read `view.projects` and its own scoped snapshot; the handler's
 * honest refusal arms ride as data (a nonexistent path is `missing-directory`,
 * a folder inside the Factory home is `unsafe-directory` — the one non-Git
 * folder that refuses, while a plain greenfield folder BOOTSTRAPS with
 * `bootstrapped: true`, ADR 0024); the door's empty-add narrowing answers
 * through the same door; and the native picker runs through the fixture's
 * fake seam (a REAL osascript dialog never opens) answering BOTH arms —
 * cancelled (nothing registered) and picked (the folder registers itself,
 * carrying the full add payload). Nothing here touches `~/.paseo` (the
 * fixture's own temp home law).
 */

test("RG-1: the console's real transport drives the Add-Project wizard — add by path registers gamma, honest refusals ride as data, the picker's cancelled and picked arms both answer", async (t) => {
  const homeRoot = makeTempDir();
  // Two committed git repos — gamma arrives by typed path, delta by picker.
  const makeRepo = (name: string): string => {
    const repo = join(homeRoot, name);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), `# ${name}\n`);
    gitCommitAll(repo);
    return repo;
  };
  const gamma = makeRepo("gamma");
  const delta = makeRepo("delta");
  const slugOf = (repo: string): string => {
    const resolved = resolveProject(repo);
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
    return resolved.ok ? resolved.slug : "";
  };
  const gammaSlug = slugOf(gamma);
  const deltaSlug = slugOf(delta);
  // The picker seam (T-12): programmable, so both arms run without any
  // native dialog on the test host — the same law the retro lane seam keeps.
  const pickPrompts: string[] = [];
  let pickAnswer: string | null = null;
  const fixture = makeConsoleFixture(homeRoot, {
    registry: true,
    pickFolder: (prompt) => {
      pickPrompts.push(prompt ?? "(none)");
      return pickAnswer;
    },
  });
  t.after(() => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // (a) The add by path through the real web write client — gamma registers,
  // its reply carrying the handler's own summary/slug/bootstrapped facts,
  // and the re-read unscoped snapshot lists it while the scoped snapshot
  // resolves gamma's own Project.
  const added = await projectAddViaSidecar({ path: gamma }, fetchAt);
  assert.equal(added.ok, true, added.ok ? "" : added.error);
  assert.ok(added.ok);
  assert.equal(added.projectRoot, realpathSync(gamma));
  assert.equal(added.slug, gammaSlug);
  assert.equal(added.bootstrapped, false, "a committed git repo registers as-is");
  assert.match(added.summary, new RegExp(`Added project gamma \\(${gammaSlug}\\)\\.`));
  const listed = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(listed.ok, true, listed.ok ? "" : listed.error);
  assert.equal(listed.view.projects.some((project) => project.slug === gammaSlug), true, "gamma appears in the re-read view.projects");
  const scoped = await loadSnapshotViaSidecar({ projectRoot: gamma }, fetchAt);
  assert.equal(scoped.ok, true, scoped.ok ? "" : scoped.error);
  assert.equal(scoped.view.project?.slug, gammaSlug, "the scoped snapshot resolves gamma's own Project");

  // (b) The handler's honest refusals ride as data with HTTP 200 — a
  // nonexistent path is `missing-directory`, and the one non-Git folder that
  // refuses is the UNSAFE one: a folder inside the Factory's own paseo home
  // (the task's "non-git folder refuses as data" arm, spelled by the core's
  // own law — a plain greenfield folder BOOTSTRAPS instead, asserted below).
  const missing = await projectAddViaSidecar({ path: join(homeRoot, "nope") }, fetchAt);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "missing-directory");
  assert.match(missing.error ?? "", /does not exist/);
  const unsafeDir = join(fixture.home, "inside-factory-home");
  mkdirSync(unsafeDir, { recursive: true });
  const unsafe = await projectAddViaSidecar({ path: unsafeDir }, fetchAt);
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.code, "unsafe-directory");
  assert.match(unsafe.error ?? "", /inside Paseo home directory/);

  // (c) The bootstrap honesty (ADR 0024): a plain greenfield folder OUTSIDE
  // the home does not refuse — Factory initializes Git and registers it.
  const greenfield = join(homeRoot, "greenfield");
  mkdirSync(greenfield, { recursive: true });
  const bootstrapped = await projectAddViaSidecar({ path: greenfield }, fetchAt);
  assert.equal(bootstrapped.ok, true, bootstrapped.ok ? "" : bootstrapped.error);
  assert.ok(bootstrapped.ok);
  assert.equal(bootstrapped.bootstrapped, true, "a greenfield folder bootstraps rather than refusing");
  assert.match(bootstrapped.summary, /Initialized Git repository and added project greenfield/);

  // (d) The door's empty-add narrowing through the SAME real door — a raw
  // /rpc post the dialog never builds: BOTH directory doors empty refuses
  // `forbidden_operation` as data BEFORE any handler runs.
  const emptyAdd = await fetchAt("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "factory.project.add", params: {} }),
  });
  assert.equal(emptyAdd.status, 400, "the empty add refuses at the door");
  const emptyAddPayload = (await emptyAdd.json()) as { ok: boolean; code?: string; error?: string };
  assert.equal(emptyAddPayload.ok, false);
  assert.equal(emptyAddPayload.code, "forbidden_operation");
  assert.match(emptyAddPayload.error ?? "", /refuses the empty add/);

  // (e) The picker through the real web client and the fake seam — the
  // CANCELLED arm first: nothing registers, the reply is the handler's own
  // `{ok, cancelled, path: null}`, and view.projects is unchanged.
  pickAnswer = null;
  const cancelled = await projectPickFolderViaSidecar("Choose the project folder to add to Factory", fetchAt);
  assert.equal(cancelled.ok, true, cancelled.ok ? "" : cancelled.error);
  assert.ok(cancelled.ok);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.path, null);
  const afterCancel = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(afterCancel.ok, true, afterCancel.ok ? "" : afterCancel.error);
  assert.equal(afterCancel.view.projects.some((project) => project.slug === deltaSlug), false, "a cancelled pick registers nothing");
  // The PICKED arm: the picker registers delta itself — the reply carries
  // the full add payload and delta lands in the re-read view.projects.
  pickAnswer = delta;
  const picked = await projectPickFolderViaSidecar("Choose the project folder to add to Factory", fetchAt);
  if (!picked.ok || picked.cancelled) {
    assert.fail(`the picked arm should carry the full add payload — ${picked.ok ? "(cancelled)" : picked.error}`);
  }
  assert.equal(picked.projectRoot, realpathSync(delta));
  assert.equal(picked.slug, deltaSlug);
  assert.match(picked.summary, new RegExp(`Added project delta \\(${deltaSlug}\\)\\.`));
  const afterPick = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(afterPick.ok, true, afterPick.ok ? "" : afterPick.error);
  assert.equal(afterPick.view.projects.some((project) => project.slug === deltaSlug), true, "the picked folder registered itself");
  assert.deepEqual(
    pickPrompts,
    ["Choose the project folder to add to Factory", "Choose the project folder to add to Factory"],
    "both picker dispatches rode the seam with their prompt",
  );
});
