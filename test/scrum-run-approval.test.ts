import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, disposeDir } from "./helpers.ts";
import { ensureScrumConfig } from "../src/scrum/config.ts";
import {
  createScrumRun,
  commandRun,
  readRun,
} from "../src/scrum/run-journal.ts";

test("durable requests preserve frozen roster and consumed fix rounds across replay", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  const run = createScrumRun({
    state,
    slug: "p",
    runId: "r1",
    initiativeId: "feature",
    config: ensureScrumConfig(state),
    configRevision: 1,
    track: "small",
    rationale: "bounded existing behavior",
    requestId: "create",
  });
  const first = commandRun(state, "p", "r1", {
    requestId: "round1",
    expectedRevision: run.revision,
    type: "fix_reserved",
    task: "fix-1",
  });
  const duplicate = commandRun(state, "p", "r1", {
    requestId: "round1",
    expectedRevision: run.revision,
    type: "fix_reserved",
    task: "fix-1",
  });
  assert.equal(duplicate.fixRounds, 1);
  assert.equal(first.revision, duplicate.revision);
  commandRun(state, "p", "r1", {
    requestId: "round2",
    expectedRevision: first.revision,
    type: "fix_reserved",
    task: "fix-2",
  });
  const replayed = readRun(state, "p", "r1");
  assert.equal(replayed.fixRounds, 2);
  assert.throws(
    () =>
      commandRun(state, "p", "r1", {
        requestId: "round3",
        expectedRevision: replayed.revision,
        type: "fix_reserved",
        task: "fix-3",
      }),
    /qa-fix-budget-exhausted/,
  );
  assert.throws(
    () =>
      commandRun(state, "p", "r1", {
        requestId: "stale",
        expectedRevision: 1,
        type: "phase_changed",
        phase: "qa",
        reason: "audit",
      }),
    /run-revision-conflict/,
  );
});

test("UI decisions pin exact revisions, reject self-approval, survive restart, and require semantic readiness", async (t) => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { gitCommitAll, gitCommitChanges } = await import("./helpers.ts");
  const { artifactAt, designDigest } = await import(
    "../src/scrum/artifacts.ts"
  );
  const { assertDevReady, decideDesign } = await import(
    "../src/scrum/approval.ts"
  );
  const { renderPreview } = await import("../src/scrum/preview.ts");
  const repo = makeTempDir();
  disposeDir(t, repo);
  const state = makeTempDir();
  disposeDir(t, state);
  const prefix = ".scratch/ui";
  const ownedPaths = [
    `${prefix}/DESIGN.md`,
    `${prefix}/EXPERIENCE.md`,
    `${prefix}/mockups/index.html`,
    `${prefix}/mockups/browser.json`,
    `${prefix}/mockups/screen.png`,
  ];
  mkdirSync(join(repo, prefix, "mockups"), { recursive: true });
  writeFileSync(
    join(repo, ownedPaths[0]),
    "color blue; typography system; spacing 8; component button\n",
  );
  writeFileSync(join(repo, ownedPaths[1]), "all six states\n");
  writeFileSync(
    join(repo, ownedPaths[2]),
    "<html><head><title>Checkout</title></head><body><button>Pay</button></body></html>",
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
    "base64",
  );
  writeFileSync(join(repo, ownedPaths[4]), png);
  const { sha256 } = await import("../src/scrum/artifacts.ts");
  writeFileSync(
    join(repo, ownedPaths[3]),
    JSON.stringify({
      network: "disabled",
      consoleErrors: [],
      viewports: [
        {
          width: 800,
          height: 600,
          screenshot: { path: ownedPaths[4], sha256: sha256(png) },
        },
      ],
      states: [
        "empty",
        "loading",
        "populated",
        "error",
        "offline",
        "permission-denied",
      ].map((state) => ({
        screen: "checkout",
        state,
        keyboard: true,
        passed: true,
      })),
    }),
  );
  const sha = gitCommitAll(repo);
  let run = createScrumRun({
    state,
    slug: "p",
    runId: "ui-run",
    initiativeId: "ui",
    config: ensureScrumConfig(state),
    configRevision: 1,
    track: "ui",
    rationale: "changed checkout flow",
    requestId: "create",
    ownedPaths,
  });
  const refs = ownedPaths
    .slice(0, 3)
    .map((path) => artifactAt(repo, sha, path));
  run = commandRun(state, "p", run.runId, {
    requestId: "design1",
    expectedRevision: run.revision,
    type: "design_review_requested",
    design: {
      revision: 1,
      digest: designDigest(refs),
      refs,
      browserEvidence: [artifactAt(repo, sha, ownedPaths[3])],
    },
  });
  const decision = {
    state,
    slug: "p",
    runId: run.runId,
    root: repo,
    actor: "owner",
    explicitOwnerInstruction: true,
    requestId: "approval1",
    expectedRevision: run.revision,
    revision: 1,
    digest: designDigest(refs),
    decision: "approved" as const,
    rationale: "checked checkout preview",
  };
  assert.throws(
    () => decideDesign({ ...decision, authority: "lead" }),
    /Owner/,
  );
  run = decideDesign({ ...decision, authority: "owner" });
  assert.throws(
    () => assertDevReady(repo, readRun(state, "p", run.runId)),
    /resolve contradictions/,
  );
  run = commandRun(state, "p", run.runId, {
    requestId: "contradiction",
    expectedRevision: run.revision,
    type: "readiness_recorded",
    readiness: {
      refs,
      contradictions: ["UX permits offline writes; API forbids them"],
      unsafeAssumptions: [],
      missingCoverage: [],
      rationale: "reconcile UX and Architect in a new Task",
    },
  });
  assert.throws(() => assertDevReady(repo, run), /blocked/);
  run = commandRun(state, "p", run.runId, {
    requestId: "ready",
    expectedRevision: run.revision,
    type: "readiness_recorded",
    readiness: {
      refs,
      contradictions: [],
      unsafeAssumptions: [],
      missingCoverage: [],
      rationale: "read-only offline UX reconciled",
    },
  });
  assert.doesNotThrow(() => assertDevReady(repo, run));
  assert.match(renderPreview(repo, run).html, /connect-src 'none'/);
  run = decideDesign({
    ...decision,
    authority: "supervisor",
    requestId: "changes",
    expectedRevision: run.revision,
    decision: "changes_requested",
    rationale: "Owner asks for clearer payment copy",
  });
  assert.throws(() => assertDevReady(repo, run));
  writeFileSync(
    join(repo, ownedPaths[2]),
    "<html><head><title>Checkout r2</title></head><body><button>Pay invoice</button></body></html>",
  );
  const second = gitCommitChanges(repo, "new UX revision Task");
  const refs2 = ownedPaths
    .slice(0, 3)
    .map((path) => artifactAt(repo, second, path));
  run = commandRun(state, "p", run.runId, {
    requestId: "design2",
    expectedRevision: run.revision,
    type: "design_review_requested",
    design: {
      revision: 2,
      digest: designDigest(refs2),
      refs: refs2,
      browserEvidence: [artifactAt(repo, second, ownedPaths[3])],
    },
  });
  assert.throws(
    () =>
      decideDesign({
        ...decision,
        authority: "owner",
        requestId: "stale-approve",
        expectedRevision: run.revision,
      }),
    /superseded/,
  );
  assert.equal(readRun(state, "p", run.runId).design?.revision, 2);
  assert.equal(readRun(state, "p", run.runId).design?.decision, undefined);
});
