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
    .filter((path) => path !== ownedPaths[3])
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
    .filter((path) => path !== ownedPaths[3])
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

test("duplicate run admission keeps the original frozen config after future roster edits", async (t) => {
  const { createFactory } = await import("../src/factory.ts");
  const { saveScrumConfig } = await import("../src/scrum/config.ts");
  const { scrumOperation } = await import("../src/scrum/controller.ts");
  const { gitCommitAll } = await import("./helpers.ts");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const state = makeTempDir();
  disposeDir(t, state);
  const root = makeTempDir();
  disposeDir(t, root);
  writeFileSync(join(root, "README.md"), "fixture");
  gitCommitAll(root);
  const { switchExecution } = await import("../src/scrum/execution.ts");
  const factory = createFactory({ stateDir: state });
  await switchExecution({
    state,
    slug: "p",
    mode: "scrum",
    blockers: [],
    rotate: async () => {},
  });
  const ctx = {
    factory,
    root,
    slug: "p",
    authority: "owner" as const,
    actor: "owner",
    activeAgents: [],
    pendingDirectives: false,
  };
  const request = {
    operation: "run.create",
    runId: "one",
    requestId: "admit",
    payload: {
      initiativeId: "unused",
      track: "small",
      rationale: "small work",
      ownedPaths: [],
    },
  };
  const first = scrumOperation(request, ctx) as ReturnType<typeof readRun>;
  const config = ensureScrumConfig(state, "p");
  saveScrumConfig(
    state,
    {
      ...config,
      requireUiApproval: false,
      lanes: { ...config.lanes, dev: "pi/future" },
    },
    "p",
  );
  const duplicate = scrumOperation(request, ctx) as ReturnType<typeof readRun>;
  assert.equal(
    duplicate.config.requireUiApproval,
    first.config.requireUiApproval,
  );
  assert.equal(duplicate.config.lanes.dev, first.config.lanes.dev);
  assert.equal(duplicate.revision, first.revision);
});

test("controller requires complete design digests and journals a frozen-policy waiver without unlocking unsafe readiness", async (t) => {
  const { createFactory } = await import("../src/factory.ts");
  const { scrumOperation } = await import("../src/scrum/controller.ts");
  const { artifactAt, designDigest, sha256 } = await import(
    "../src/scrum/artifacts.ts"
  );
  const { assertDevReady } = await import("../src/scrum/approval.ts");
  const { gitCommitAll } = await import("./helpers.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const state = makeTempDir();
  disposeDir(t, state);
  const root = makeTempDir();
  disposeDir(t, root);
  const prefix = ".scratch/ui-policy";
  const paths = [
    "DESIGN.md",
    "EXPERIENCE.md",
    "mockups/index.html",
    "mockups/screen.png",
    "mockups/browser.json",
  ].map((p) => `${prefix}/${p}`);
  mkdirSync(join(root, prefix, "mockups"), { recursive: true });
  for (const path of paths.slice(0, 4))
    writeFileSync(
      join(root, path),
      path.endsWith(".html")
        ? "<html><head><title>UI</title></head><body><button>Calculate</button></body></html>"
        : "fixture bytes",
    );
  writeFileSync(
    join(root, paths[4]),
    JSON.stringify({
      network: "disabled",
      consoleErrors: [],
      viewports: [
        {
          width: 800,
          height: 600,
          screenshot: { path: paths[3], sha256: sha256("fixture bytes") },
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
        screen: "calculator",
        state,
        keyboard: true,
        passed: true,
      })),
    }),
  );
  const { switchExecution } = await import("../src/scrum/execution.ts");
  await switchExecution({
    state,
    slug: "p",
    mode: "scrum",
    blockers: [],
    rotate: async () => {},
  });
  const sha = gitCommitAll(root),
    config = { ...ensureScrumConfig(state), requireUiApproval: false };
  let run = createScrumRun({
    state,
    slug: "p",
    runId: "policy",
    initiativeId: "ui-policy",
    config,
    configRevision: 1,
    track: "ui",
    rationale: "fixture",
    requestId: "create",
    ownedPaths: paths,
  });
  const factory = createFactory({ stateDir: state });
  run = commandRun(state, "p", run.runId, {
    requestId: "reserve",
    expectedRevision: run.revision,
    type: "task_reserved",
    task: "ux-policy",
    role: "ux",
    required: true,
  });
  const contract = factory.setContract({
    task: "ux-policy",
    workspace: root,
    gate: "true",
    execution: {
      mode: "scrum",
      runId: run.runId,
      role: "ux",
      policyRevision: run.policyRevision,
      configRevision: run.configRevision,
      artifactRefs: [],
    },
  });
  run = commandRun(state, "p", run.runId, {
    requestId: "bind",
    expectedRevision: run.revision,
    type: "task_bound",
    task: contract.task,
    epoch: contract.seq,
  });
  const claim = await factory.claim({ task: contract.task, sha });
  await factory.accept({ task: contract.task, attempt: claim.attempt });
  const refs = paths.slice(0, 4).map((path) => artifactAt(root, sha, path)),
    browserEvidence = [artifactAt(root, sha, paths[4])];
  const ctx = {
    factory,
    slug: "p",
    root,
    authority: "lead" as const,
    actor: "lead",
    activeAgents: [],
    pendingDirectives: false,
  };
  const subset = [refs[2]];
  assert.throws(
    () =>
      scrumOperation(
        {
          operation: "run.command",
          runId: run.runId,
          requestId: "subset",
          expectedRevision: run.revision,
          payload: {
            type: "design_review_requested",
            design: {
              revision: 1,
              digest: designDigest(subset),
              refs: subset,
              browserEvidence,
            },
          },
        },
        ctx,
      ),
    /complete design|DESIGN/,
  );
  run = scrumOperation(
    {
      operation: "run.command",
      runId: run.runId,
      requestId: "full",
      expectedRevision: run.revision,
      payload: {
        type: "design_review_requested",
        design: {
          revision: 1,
          digest: designDigest(refs),
          refs,
          browserEvidence,
        },
      },
    },
    ctx,
  ) as typeof run;
  assert.equal(run.design?.decision, "waived");
  assert.match(run.design?.actor ?? "", /^policy:/);
  assert.throws(() => assertDevReady(root, run), /resolve contradictions/);
});
