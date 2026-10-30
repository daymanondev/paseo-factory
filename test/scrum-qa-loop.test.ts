import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gitCommitAll,
  gitCommitChanges,
  makeTempDir,
  disposeDir,
  repoRoot,
} from "./helpers.ts";
import {
  validateQaReport,
  executableRevisionIsCurrent,
} from "../src/scrum/qa-bundle.ts";

test("QA report distinguishes confirmed product defects, harness failure and two clean first-attempt runs", () => {
  const run = {
    command: "node --test",
    exit: 0,
    firstAttempt: true,
    fixtureId: "fresh-a",
    environment: "node22",
    seed: "1",
    tests: 3,
    passed: 3,
    skipped: 0,
    expectedFailures: 0,
    evidence: [{ path: "qa/log.txt", sha256: "a".repeat(64) }],
  };
  const report = {
    schemaVersion: 1,
    auditId: "a1",
    productSha: "b".repeat(40),
    status: "clean",
    baseline: run,
    runs: [run, { ...run, fixtureId: "fresh-b" }],
    testIds: ["R1-test"],
    requirementRefs: ["R1"],
    designRefs: [],
    lenses: [
      "intent-alignment",
      "blind-hunter",
      "edge-case-hunter",
      "verification-gap",
    ],
    findings: [],
    bundles: [],
    activeSuite: true,
  };
  assert.deepEqual(validateQaReport(report), []);
  const browserEvidence = {
    network: 'disabled', consoleErrors: [], screens: [{id:'checkout'}],
    viewports: [{screen:'checkout',width:1280,height:800},{screen:'checkout',width:390,height:844}],
    states: ['empty','loading','populated','error','offline','permission-denied'].map(state=>({screen:'checkout',state,keyboard:true,passed:true})),
    detector: {tool:'impeccable',passed:false,nonAdvisoryCount:1,viewportsChecked:[{width:1280,height:800,nonAdvisoryCount:0},{width:390,height:844,nonAdvisoryCount:1}],findings:[{ruleId:'contrast',severity:'error',message:'Low contrast'}]},
  };
  const defect = { ...report, status:'defects_found', browserEvidence, runs:[{...run,exit:2,passed:2}], findings:[{id:'contrast',confirmed:true,required:true,resolved:false,severity:'high',requirement:'DESIGN.md contrast',reproduction:'Mobile checkout CTA',evidence:run.evidence,kind:'product'}] };
  assert.deepEqual(validateQaReport(defect), [], 'failing detector evidence must survive into a structured fix loop');
  assert.ok(validateQaReport({...defect,status:'clean'}).some(message=>message.includes('detector')), 'clean QA sign-off still requires zero detector findings');
  assert.match(
    validateQaReport({ ...report, runs: [run, { ...run, skipped: 1 }] }).join(),
    /skipped|first-attempt/,
  );
  assert.match(
    validateQaReport({
      ...report,
      status: "defects_found",
      findings: [],
    }).join(),
    /confirmed/,
  );
  assert.match(
    validateQaReport({ ...report, baseline: { ...run, exit: 1 } }).join(),
    /baseline/,
  );
});

test("report-only descendants preserve QA attestation but executable changes invalidate it", (t) => {
  const repo = makeTempDir();
  disposeDir(t, repo);
  writeFileSync(join(repo, "product.js"), "export const answer = 42;\n");
  const product = gitCommitAll(repo);
  writeFileSync(join(repo, "qa-report.json"), "{}\n");
  gitCommitChanges(repo, "audit evidence");
  assert.equal(
    executableRevisionIsCurrent(repo, product, ["qa-report.json"]),
    true,
  );
  writeFileSync(join(repo, "product.js"), "export const answer = 0;\n");
  gitCommitChanges(repo, "regression");
  assert.equal(
    executableRevisionIsCurrent(repo, product, ["qa-report.json"]),
    false,
  );
});

test("a GREEN QA artifact reproduces a real defect, Dev promotes unchanged tests, and re-audit closes the product loop", async (t) => {
  const { mkdirSync, readFileSync } = await import("node:fs");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { createFactory } = await import("../src/factory.ts");
  const { ensureScrumConfig } = await import("../src/scrum/config.ts");
  const { createScrumRun, commandRun } = await import(
    "../src/scrum/run-journal.ts"
  );
  const { artifactAt, sha256, trackOwnedArtifacts } = await import(
    "../src/scrum/artifacts.ts"
  );
  const { completionBlockers } = await import("../src/scrum/completion.ts");
  const { bundlePromoted, verifyQaFiles } = await import(
    "../src/scrum/qa-bundle.ts"
  );
  const state = makeTempDir();
  disposeDir(t, state);
  const repo = makeTempDir();
  disposeDir(t, repo);
  writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
  writeFileSync(
    join(repo, "product.mjs"),
    "export const sum = (a, b) => a - b;\n",
  );
  writeFileSync(
    join(repo, "baseline.test.mjs"),
    "import {sum} from './product.mjs'; if (typeof sum !== 'function') throw Error('missing API');\n",
  );
  const original = gitCommitAll(repo);
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const qaRoot = ".scratch/demo/qa";
  const paths = [
    ".scratch/demo/sprint-backlog.md",
    `${qaRoot}/a1/bundle/candidate.txt`,
    `${qaRoot}/a1/log.txt`,
    `${qaRoot}/a1/qa-report.json`,
    `${qaRoot}/a1/qa-report.md`,
    `${qaRoot}/a2/log-a.txt`,
    `${qaRoot}/a2/log-b.txt`,
    `${qaRoot}/a2/qa-report.json`,
    `${qaRoot}/a2/qa-report.md`,
  ];
  const { switchExecution } = await import("../src/scrum/execution.ts");
  await switchExecution({
    state,
    slug: "fixture",
    mode: "scrum",
    blockers: [],
    rotate: async () => {},
  });
  let run = createScrumRun({
    state,
    slug: "fixture",
    runId: "run",
    initiativeId: "demo",
    config: ensureScrumConfig(state),
    configRevision: 1,
    track: "small",
    rationale: "existing API hotfix",
    requestId: "create",
    ownedPaths: paths,
  });
  const factory = createFactory({ stateDir: state });
  let serial = 0;
  const command = (payload: Record<string, unknown>) =>
    (run = commandRun(state, "fixture", "run", {
      ...payload,
      requestId: `cmd-${++serial}`,
      expectedRevision: run.revision,
    } as Parameters<typeof commandRun>[3]));
  const contract = (
    task: string,
    role: "pm" | "qa" | "dev",
    scope?: string[],
  ) => {
    command({ type: "task_reserved", task, role, required: true });
    const event = factory.setContract({
      task,
      workspace: repo,
      gate:
        `"${process.execPath}" --test baseline.test.mjs` +
        (role === "dev"
          ? ` && "${process.execPath}" --test test/sum.test.mjs`
          : role === "qa"
            ? ` && "${process.execPath}" "${join(repoRoot, "plugin/bin/factory.mjs")}" lint-scrum-doc --kind qa --dir .scratch/demo/qa/${task === "audit-1" ? "a1" : "a2"}`
            : ""),
      scope,
      execution: {
        mode: "scrum",
        runId: "run",
        role,
        policyRevision: run.policyRevision,
        configRevision: 1,
        artifactRefs: [],
      },
    });
    command({ type: "task_bound", task, epoch: event.seq });
  };
  const accept = async (
    task: string,
    sha: string,
    refs: ReturnType<typeof artifactAt>[],
  ) => {
    const result = await factory.claim({ task, sha });
    assert.equal(result.verdict, "green", result.gate.note);
    await factory.accept({
      task,
      attempt: result.attempt,
      authority: "lead",
      accepted_by: "lead",
    });
    command({
      type: "role_result",
      task,
      result: {
        status: "complete",
        artifactRefs: refs,
        assumptions: [],
        openQuestions: [],
        conflicts: [],
      },
    });
  };
  const put = (path: string, bytes: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), bytes);
  };
  contract("backlog", "pm", [paths[0]]);
  put(
    paths[0],
    "# R1: addition\n# S-01: existing API correction\nCovers: R1\nTests: test/sum.test.mjs\n",
  );
  trackOwnedArtifacts(repo, paths, [paths[0]]);
  const backlogSha = gitCommitChanges(repo, "backlog");
  await accept("backlog", backlogSha, [artifactAt(repo, backlogSha, paths[0])]);
  command({
    type: "readiness_recorded",
    readiness: {
      refs: [artifactAt(repo, backlogSha, paths[0])],
      contradictions: [],
      unsafeAssumptions: [],
      missingCoverage: [],
      rationale: "small track; existing API and no UI",
    },
  });
  contract(
    "audit-1",
    "qa",
    paths.filter((p) => p.includes("/a1/")),
  );
  const candidate =
    "import assert from 'node:assert/strict'; import {sum} from '../product.mjs'; assert.equal(sum(2,3),5);\n";
  put(paths[1], candidate);
  const harness = makeTempDir();
  disposeDir(t, harness);
  mkdirSync(join(harness, "test"));
  writeFileSync(
    join(harness, "product.mjs"),
    readFileSync(join(repo, "product.mjs")),
  );
  writeFileSync(join(harness, "test/sum.test.mjs"), candidate);
  const defective = spawnSync(
    process.execPath,
    ["--test", "test/sum.test.mjs"],
    { cwd: harness, encoding: "utf8", env: childEnv },
  );
  assert.equal(defective.status, 1);
  put(paths[2], defective.stdout + defective.stderr);
  const log = {
    path: paths[2],
    sha256: sha256(readFileSync(join(repo, paths[2]))),
  };
  const execution = {
    command: "node --test baseline.test.mjs",
    exit: 0,
    firstAttempt: true,
    fixtureId: "baseline",
    environment: process.version,
    seed: "1",
    tests: 1,
    passed: 1,
    skipped: 0,
    expectedFailures: 0,
    evidence: [log],
  };
  const report = {
    schemaVersion: 1,
    auditId: "a1",
    productSha: original,
    status: "defects_found",
    baseline: execution,
    runs: [
      {
        ...execution,
        command: "node --test test/sum.test.mjs",
        exit: 1,
        passed: 0,
        fixtureId: "candidate",
      },
    ],
    testIds: ["sum-2-3"],
    requirementRefs: ["R1"],
    designRefs: [],
    lenses: [
      "intent-alignment",
      "blind-hunter",
      "edge-case-hunter",
      "verification-gap",
    ],
    findings: [
      {
        id: "F1",
        confirmed: true,
        required: true,
        resolved: false,
        severity: "high",
        requirement: "R1",
        reproduction: "sum(2,3) returns -1",
        evidence: [log],
        kind: "product",
      },
    ],
    bundles: [
      {
        id: "addition",
        required: true,
        command: "node --test test/sum.test.mjs",
        fixtureSetup: "copy product and exact candidate into fresh harness",
        discoveryEvidence: log,
        files: [
          {
            path: paths[1],
            sha256: sha256(candidate),
            target: "test/sum.test.mjs",
          },
        ],
      },
    ],
    activeSuite: false,
  } as import("../src/scrum/qa-bundle.ts").QaReport;
  put(paths[3], JSON.stringify(report));
  put(
    paths[4],
    "# QA\nConfirmed addition defect; active baseline remains GREEN.\n",
  );
  assert.deepEqual(verifyQaFiles(repo, report), []);
  trackOwnedArtifacts(
    repo,
    paths,
    paths.filter((p) => p.includes("/a1/")),
  );
  const qaSha = gitCommitChanges(
    repo,
    "deliver red candidate as GREEN artifact",
  );
  await accept("audit-1", qaSha, [artifactAt(repo, qaSha, paths[3])]);
  command({ type: "qa_recorded", ref: artifactAt(repo, qaSha, paths[3]) });
  assert.equal(bundlePromoted(repo, qaSha, report.bundles[0]), false);
  assert.ok(
    completionBlockers({
      root: repo,
      run,
      events: factory.ledger.events,
      activeAgents: [],
      pendingDirectives: false,
    }).length > 0,
  );
  command({ type: "fix_reserved", task: "fix-1" });
  contract("fix-1", "dev");
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test/sum.test.mjs"), candidate);
  writeFileSync(
    join(repo, "product.mjs"),
    "export const sum = (a, b) => a + b;\n",
  );
  const productSha = gitCommitChanges(
    repo,
    "promote candidate and repair addition",
  );
  await accept("fix-1", productSha, []);
  assert.equal(bundlePromoted(repo, qaSha, report.bundles[0]), true);
  const cleanRuns: import("../src/scrum/qa-bundle.ts").QaExecution[] = [];
  for (const [i, path] of [paths[5], paths[6]].entries()) {
    const isolated = makeTempDir();
    disposeDir(t, isolated);
    mkdirSync(join(isolated, "test"));
    for (const file of [
      "product.mjs",
      "baseline.test.mjs",
      "test/sum.test.mjs",
    ])
      writeFileSync(join(isolated, file), readFileSync(join(repo, file)));
    const clean = spawnSync(
      process.execPath,
      ["--test", "baseline.test.mjs", "test/sum.test.mjs"],
      { cwd: isolated, encoding: "utf8", env: childEnv },
    );
    assert.equal(clean.status, 0);
    put(path, clean.stdout + clean.stderr);
    cleanRuns.push({
      ...execution,
      fixtureId: `isolated-${i}`,
      tests: 2,
      passed: 2,
      evidence: [{ path, sha256: sha256(readFileSync(join(repo, path))) }],
    });
  }
  contract(
    "audit-2",
    "qa",
    paths.filter((p) => p.includes("/a2/")),
  );
  const final = {
    ...report,
    auditId: "a2",
    productSha,
    status: "clean" as const,
    activeSuite: true,
    runs: cleanRuns,
    bundles: [],
    findings: report.findings.map((f) => ({
      ...f,
      resolved: true,
      evidence: cleanRuns[0].evidence,
    })),
  };
  put(paths[7], JSON.stringify(final));
  put(paths[8], "# QA\nTwo isolated first-attempt passes; F1 resolved.\n");
  trackOwnedArtifacts(
    repo,
    paths,
    paths.filter((p) => p.includes("/a2/")),
  );
  const finalSha = gitCommitChanges(repo, "clean re-audit evidence");
  await accept("audit-2", finalSha, [artifactAt(repo, finalSha, paths[7])]);
  command({ type: "qa_recorded", ref: artifactAt(repo, finalSha, paths[7]) });
  assert.deepEqual(
    completionBlockers({
      root: repo,
      run,
      events: factory.ledger.events,
      activeAgents: [],
      pendingDirectives: false,
    }),
    [],
  );
  const { scrumOperation } = await import("../src/scrum/controller.ts");
  const context = {
    factory,
    root: repo,
    slug: "fixture",
    authority: "lead" as const,
    actor: "lead",
    activeAgents: [],
    pendingDirectives: true,
  };
  const qaCommand = {
    operation: "run.command",
    runId: run.runId,
    requestId: "qa-receipt",
    expectedRevision: run.revision,
    payload: { type: "qa_recorded", ref: artifactAt(repo, finalSha, paths[7]) },
  };
  run = scrumOperation(qaCommand, context) as typeof run;
  assert.equal(run.qaResult?.status, "clean");
  const replay = scrumOperation(qaCommand, context) as typeof run;
  assert.equal(replay.revision, run.revision);
  const complete = {
    operation: "run.complete",
    runId: run.runId,
    requestId: "complete",
    expectedRevision: run.revision,
  };
  const pending = scrumOperation(complete, context) as typeof run;
  assert.notEqual(pending.phase, "completed");
  assert.equal(pending.completionRequest?.requestId, "complete");
  const completed = scrumOperation(
    { ...complete, expectedRevision: pending.revision },
    { ...context, pendingDirectives: false },
  ) as typeof run;
  assert.equal(completed.phase, "completed");
});
