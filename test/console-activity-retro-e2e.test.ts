import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "../plugin/server/core/project.ts";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { invokeRpc } from "../web/src/rpc.ts";
import { retroViaSidecar } from "../web/src/retro.ts";
import { activityScreenModel } from "../web/src/activity-view.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-11b): at least one test drives the console's
 * REAL retro write — `web/src/retro.ts` `retroViaSidecar`, the exact
 * transport the browser bundle's Run retro confirm calls — against a REAL
 * started sidecar over a REAL Factory fixture whose ONE registered git
 * Project's ledger is seeded through the registry's own per-Project Factory
 * (`setContract` plus two appends, so seqs 1..3 exist as parseable
 * evidence), with the retro pass made deterministic by the fixture's
 * `retroCopilotStdout` seam — the fake lane CLI answers the strict output
 * contract's HAPPY shape, never a real model. Proves the bounded outcome
 * end to end: the scoped fold starts with the honest "no retros" empty, the
 * Run retro act reaches the handler (a `written` outcome with its proposal
 * count and proposals path), the re-read snapshot's Retro fold shows the
 * new retro newest-first with its R1/R2 proposals verbatim, the ledger
 * stream gains the `retro_written` line under `other` — and the door stays
 * narrowed: an unscoped `factory.retro` refuses `forbidden_operation` from
 * the console before any handler runs, and `factory.retro.ratify` keeps
 * refusing `unknown_method` (outside the door, ADR 0017).
 */

/** The HAPPY lane answer — exactly the strict output contract: two proposals, both citing ≥2 distinct existing seqs, at the cap. */
const HAPPY = JSON.stringify({
  proposals: [
    {
      class: "gate-check",
      evidence: [2, 1],
      pattern: "Attempts gate before the contract's artifact exists in the workspace.",
      text: "Require the artifact check to run before the gate in every attempt.",
    },
    {
      class: "observation",
      evidence: [1, 3],
      pattern: "Claims arrive before the spawn's first gate log, leaving the ledger's story out of order.",
      text: "Note the claim-after-gate ordering rule in the Project's CONTRIBUTING.",
    },
  ],
});

test("RG-1: the console's real transport runs the retro — the written pass folds into the re-read Retro panel, the door stays narrowed", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose retro the screen runs.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";
  // `registry: true` wires the per-Project registry the live server runs
  // with (the handler's own dispatch path); `retroCopilotStdout` pins the
  // lane's answer so the pass never spawns a real model.
  const fixture = makeConsoleFixture(homeRoot, { registry: true, retroCopilotStdout: HAPPY });
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug });
  assert.equal(registered.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // The Task's workspace — a real git repo the contract can point at. The
  // ledger, seeded through the Project's OWN real Factory: setContract (seq
  // 1) plus two appends (seqs 2, 3), so the HAPPY evidence cites seqs that
  // exist — the strict parse's own law.
  const workspace = join(homeRoot, "T11b-ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);
  const factory = fixture.registry.factoryForProject(slug);
  factory.setContract({ task: "T-11", workspace, gate: "npm test", artifact: "src/format.ts" });
  factory.ledger.append({ event: "spawn_dispatched", task: "T-11", provider: "pi/zai/glm-5.3", arity: 1 });
  factory.ledger.append({ event: "claim_reported", task: "T-11", attempt: 1, sha });
  assert.ok(factory.ledger.events.length >= 3, "the seeded ledger carries the evidence seqs 1..3");

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // The scoped read through the real snapshot transport: the Retro fold
  // starts honest — no retros, never a fabricated row.
  const before = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(before.ok, true, before.ok ? "" : before.error);
  assert.equal(before.view.project?.slug, slug);
  const beforeModel = activityScreenModel(before.view);
  assert.equal(beforeModel.retro.rows.length, 0, "no retro has run — the fold is honestly empty");

  // The Run retro act through the real retro transport — the screen's exact
  // call. The handler dispatches through the registry into the Project's
  // own Factory; the faked lane answers HAPPY; the pass writes its file and
  // its ledger line.
  const run = await retroViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(run.ok, true, run.ok ? "" : `${run.code}: ${run.error}`);
  assert.equal(run.outcome, "written", "the faked lane's HAPPY answer writes the proposals file");
  assert.equal(run.proposalCount, 2, "both HAPPY proposals survived the strict parse and the cap");
  assert.match(run.proposalsPath ?? "", new RegExp(`^${fixture.stateDir}/projects/${slug}/retro-\\d{4}-\\d{2}-\\d{2}\\.md$`), "the file lands under the Project's own state dir");
  assert.equal(run.error, null);

  // The re-read snapshot: the Retro fold shows the new retro, its day the
  // file's own, its model the lane the pass ran (the snapshot's own retro
  // lane — the same table the pass read), and the R1/R2 proposals parsed
  // back out of the file — class and text verbatim from HAPPY.
  const after = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(after.ok, true, after.ok ? "" : after.error);
  const afterModel = activityScreenModel(after.view);
  assert.equal(afterModel.retro.rows.length, 1, "the written retro folds into the re-read snapshot");
  const retro = afterModel.retro.rows[0]!;
  assert.equal(retro.outcome, "written");
  assert.equal(retro.day, new RegExp(`retro-(\\d{4}-\\d{2}-\\d{2})\\.md$`).exec(run.proposalsPath ?? "")?.[1] ?? "", "the fold's day is the file's own day");
  assert.equal(retro.model, after.view.lanes.retro, "the retro ran the machine's retro lane — the snapshot's own fold of the same table");
  assert.equal(retro.proposalCountLabel, "2 proposals");
  assert.deepEqual(
    retro.proposals.map((proposal) => [proposal.label, proposal.cls, proposal.text]),
    [
      ["R1", "gate-check", "Require the artifact check to run before the gate in every attempt."],
      ["R2", "observation", "Note the claim-after-gate ordering rule in the Project's CONTRIBUTING."],
    ],
    "the proposals parse back out of the file — R1 gate-check first (ratification order), class and text verbatim",
  );
  // The stream refreshed too: the retro's own ledger line folds under `other`.
  const retroLine = afterModel.ledger.find((row) => row.event === "retro_written");
  assert.ok(retroLine !== undefined, "the retro_written line joins the re-read stream");
  assert.equal(retroLine.kind, "other");

  // The door stays narrowed through the same transport: the unscoped retro
  // refuses `forbidden_operation` BEFORE any handler runs (the door's own
  // sentence naming whose door refused)…
  const unscoped = await invokeRpc("factory.retro", {}, fetchAt);
  assert.ok(unscoped.ok === false, "the unscoped retro is Failure-shaped data, never a throw");
  assert.ok(unscoped.ok === false && unscoped.code === "forbidden_operation");
  assert.match(unscoped.ok === false ? unscoped.error : "", /refuses the unscoped retro/);
  assert.match(unscoped.ok === false ? unscoped.error : "", /from the console/);
  // …and the ratification stays outside the door (ADR 0017 — its handler
  // ensures a Supervisor seat; the Owner's decision is pending).
  const ratify = await invokeRpc("factory.retro.ratify", {}, fetchAt);
  assert.ok(ratify.ok === false);
  assert.ok(ratify.ok === false && ratify.code === "unknown_method", "factory.retro.ratify is not allowlisted");
});
