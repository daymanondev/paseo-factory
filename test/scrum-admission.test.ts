import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, disposeDir, gitCommitAll, gitCommitChanges } from "./helpers.ts";
import { createFactory } from "../plugin/server/core/factory.ts";
import { ensureProjectRegistered } from "../plugin/server/core/project.ts";
import { switchExecution } from "../plugin/server/core/scrum/execution.ts";
import { listRuns } from "../plugin/server/core/scrum/run-journal.ts";
import { handleSpoolRequest } from "../plugin/server/spool.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";

test("natural Supervisor directives admit one Scrum run and reuse it through the spool", async t => {
  const state = makeTempDir(), repo = makeTempDir();
  for (const dir of [state, repo]) disposeDir(t, dir);
  writeFileSync(join(repo, "README.md"), "fixture"); gitCommitAll(repo);
  const project = ensureProjectRegistered(state, repo); assert.ok(project.ok);
  await switchExecution({ state, slug: project.slug, mode: "scrum", blockers: [], rotate: async () => {} });
  const factory = createFactory({ stateDir: state });
  const prompts: string[] = [];
  const runtime = createLeadMailRuntime({ stateDir: state, factory,
    daemon: { agents: { list: async () => ({ entries: [{ agent: { id: "lead", status: "idle", archivedAt: null, cwd: repo, labels: { seat: "lead", project: project.slug } } }] }), ref: () => ({ send: async (text: string) => { prompts.push(text); return {}; } }) } } as never,
    ensureLead: async () => ({ ok: true, agentId: "lead", created: false, projectRoot: repo, slug: project.slug }),
    retireLead: async () => ({ ok: true, agentId: "lead" }),
  });
  for (const id of ["first", "second"]) {
    const reply = await handleSpoolRequest(factory, { id, kind: "lead_dispatch", workspace: repo, from: "supervisor", message: "Build an offline farm simulator", submitter: "owner", seat: "supervisor" }, { leadDispatch: runtime.dispatchLead });
    assert.ok(reply.ok, JSON.stringify(reply));
  }
  const runs = listRuns(state, project.slug); assert.equal(runs.length, 1);
  assert.equal(runs[0].track, "standard");
  assert.match(runs[0].initiativeId, /^scrum-build-an-offline-farm/);
  assert.ok(runs[0].ownedPaths.includes(`.scratch/${runs[0].initiativeId}/prd.md`));
  assert.match(prompts[0], new RegExp(runs[0].runId));
});

test("Scrum Lead operations resolve the run, refine tracks and keep the admission durable", async t => {
  const state = makeTempDir(), repo = makeTempDir(); for (const dir of [state, repo]) disposeDir(t, dir);
  writeFileSync(join(repo, "README.md"), "fixture"); gitCommitAll(repo);
  const project = ensureProjectRegistered(state, repo); assert.ok(project.ok);
  await switchExecution({ state, slug: project.slug, mode: "scrum", blockers: [], rotate: async () => {} });
  const factory = createFactory({ stateDir: state });
  const { bindScrumDirective } = await import("../plugin/server/scrum.ts");
  bindScrumDirective(factory, repo, project.slug, { id: "admit", message: "Build a farm" });
  const { scrumOperation } = await import("../plugin/server/core/scrum/controller.ts");
  const deps = { scrumCommand: async (request: import("../plugin/server/spool.ts").ScrumSpoolRequest, caller: { authority: "owner" | "supervisor" | "lead" | "agent"; actor: string }) => ({ id: request.id, ok: true as const, summary: "Scrum operation", data: scrumOperation(request, { factory, root: repo, slug: project.slug, ...caller, activeAgents: [], pendingDirectives: false }) }) };
  const { CorrelationRegistry } = await import("../plugin/server/core/correlations.ts");
  const lead = new CorrelationRegistry(state).issue({ role: "lead", projectSlug: project.slug, projectRoot: repo });
  const request = { id: "select", requestId: "select", kind: "scrum_command" as const, operation: "lead.operation", projectRoot: repo, submitter: lead.correlationId, payload: { action: "track.select", track: "quick", rationale: "bounded story" } };
  const reply = await handleSpoolRequest(factory, request, deps); assert.ok(reply.ok, JSON.stringify(reply));
  assert.equal(listRuns(state, project.slug)[0].track, "quick");
  assert.deepEqual(listRuns(state, project.slug)[0].requiredRoles, ["dev", "qa"]);
  const readiness = await handleSpoolRequest(factory, { ...request, id: "ready", requestId: "ready", payload: { action: "readiness", rationale: "inspect readiness" } }, deps);
  assert.ok(readiness.ok, JSON.stringify(readiness));
});

test("specialist Contracts default artifacts and durably own task decisions and Dev scope", async t => {
  const state = makeTempDir(), repo = makeTempDir(); for (const dir of [state, repo]) disposeDir(t, dir);
  writeFileSync(join(repo, "README.md"), "fixture"); gitCommitAll(repo);
  const project = ensureProjectRegistered(state, repo); assert.ok(project.ok);
  await switchExecution({ state, slug: project.slug, mode: "scrum", blockers: [], rotate: async () => {} });
  const factory = createFactory({ stateDir: state });
  const { bindScrumDirective } = await import("../plugin/server/scrum.ts");
  bindScrumDirective(factory, repo, project.slug, { id: "contracts", message: "Build farm", scrum: { initiativeId: "farm", track: "quick" } });
  const { commandRun } = await import("../plugin/server/core/scrum/run-journal.ts");
  let run = listRuns(state, project.slug)[0];
  commandRun(state, project.slug, run.runId, { type: "readiness_recorded", requestId: "ready", expectedRevision: run.revision, readiness: { refs: [], contradictions: [], unsafeAssumptions: [], missingCoverage: [], rationale: "fixture" } });
  for (const role of ["pm", "ux", "architect", "dev", "qa"] as const) {
    if (role === "dev") {
      run = listRuns(state, project.slug)[0];
      commandRun(state, project.slug, run.runId, { type: "readiness_recorded", requestId: "dev-ready", expectedRevision: run.revision, readiness: { refs: [], contradictions: [], unsafeAssumptions: [], missingCoverage: [], rationale: "fixture" } });
    }
    const reply = await handleSpoolRequest(factory, { id: `contract-${role}`, kind: "contract", task: role, workspace: repo, role, gate: "true", scope: role === "dev" ? ["src/farm.ts"] : undefined, submitter: "owner" });
    assert.ok(reply.ok, JSON.stringify(reply));
    const contract = factory.contractFor(role)!;
    const decision = `.scratch/farm/decisions/${role}.jsonl`;
    assert.ok(contract.scope?.includes(decision));
    run = listRuns(state, project.slug)[0]; assert.ok(run.ownedPaths.includes(decision));
    if (role === "dev") { assert.ok(contract.scope?.includes("src/farm.ts")); assert.ok(run.ownedPaths.includes("src/farm.ts")); }
    else {
      const artifact = `.scratch/farm/${({ pm: "prd.md", ux: "ux-spec.md", architect: "architecture.md", qa: "qa/qa.md" })[role]}`;
      assert.equal(contract.artifact, artifact);
      assert.ok(contract.scope?.includes(artifact)); assert.ok(run.ownedPaths.includes(artifact));
    }
  }
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".scratch/farm/decisions"), { recursive: true });
  writeFileSync(join(repo, "src/farm.ts"), "export const farm = true;\n");
  writeFileSync(join(repo, ".scratch/farm/decisions/dev.jsonl"), '{"id":"D1","rationale":"bounded implementation"}\n');
  const sha = gitCommitChanges(repo, "Dev implementation and decision log");
  const claim = await handleSpoolRequest(factory, { id: "dev-claim", kind: "claim", task: "dev", sha });
  assert.ok(claim.ok, JSON.stringify(claim));
  assert.equal(claim.verdict, "green", JSON.stringify(claim));
});

test("Scrum spool lifecycle records accepted QA evidence, promotion and verified completion", async t => {
  const state = makeTempDir(), repo = makeTempDir(); for (const dir of [state, repo]) disposeDir(t, dir);
  writeFileSync(join(repo, "product.mjs"), "export const crop = 'wheat';\n"); const productSha = gitCommitAll(repo);
  const project = ensureProjectRegistered(state, repo); assert.ok(project.ok);
  await switchExecution({ state, slug: project.slug, mode: "scrum", blockers: [], rotate: async () => {} });
  const factory = createFactory({ stateDir: state });
  const { bindScrumDirective } = await import("../plugin/server/scrum.ts");
  bindScrumDirective(factory, repo, project.slug, { id: "audit-run", message: "Audit existing farm", scrum: { initiativeId: "audit", track: "quick" } });
  const { commandRun } = await import("../plugin/server/core/scrum/run-journal.ts");
  const { artifactAt, sha256 } = await import("../plugin/server/core/scrum/artifacts.ts");
  const { scrumOperation } = await import("../plugin/server/core/scrum/controller.ts");
  let run = listRuns(state, project.slug)[0];
  const logPath = ".scratch/audit/qa/log.txt", reportPath = ".scratch/audit/qa/qa-report.json";
  run = commandRun(state, project.slug, run.runId, { type: "paths_registered", paths: [logPath, reportPath], requestId: "paths", expectedRevision: run.revision });
  const contract = factory.setContract({ task: "audit", workspace: repo, gate: "true", scope: [".scratch/audit/qa"], execution: { mode: "scrum", runId: run.runId, role: "qa", policyRevision: run.policyRevision, configRevision: 1, artifactRefs: [] } });
  run = commandRun(state, project.slug, run.runId, { type: "task_reserved", task: "audit", role: "qa", required: true, requestId: "reserve", expectedRevision: run.revision });
  run = commandRun(state, project.slug, run.runId, { type: "task_bound", task: "audit", epoch: contract.seq, requestId: "bind", expectedRevision: run.revision });
  mkdirSync(join(repo, ".scratch/audit/qa"), { recursive: true });
  const log = "fixture: 3 tests pass\n"; writeFileSync(join(repo, logPath), log);
  const evidenceRun = { command: "node --test", exit: 0, firstAttempt: true, fixtureId: "first", environment: "node", seed: "1", tests: 3, passed: 3, skipped: 0, expectedFailures: 0, evidence: [{ path: logPath, sha256: sha256(log) }] };
  writeFileSync(join(repo, reportPath), JSON.stringify({ schemaVersion: 1, auditId: "audit", productSha, status: "clean", baseline: evidenceRun, runs: [evidenceRun, { ...evidenceRun, fixtureId: "second" }], testIds: ["crop"], requirementRefs: ["R1"], designRefs: [], lenses: ["intent-alignment", "blind-hunter", "edge-case-hunter", "verification-gap"], findings: [], bundles: [], activeSuite: true }));
  const sha = gitCommitChanges(repo, "QA fixture evidence");
  const claim = await factory.claim({ task: "audit", sha }); assert.equal(claim.verdict, "green", claim.gate.note);
  await factory.accept({ task: "audit", attempt: claim.attempt, authority: "owner", accepted_by: "owner" });
  run = commandRun(state, project.slug, run.runId, { type: "readiness_recorded", requestId: "ready", expectedRevision: run.revision, readiness: { refs: [], contradictions: [], unsafeAssumptions: [], missingCoverage: [], rationale: "Existing-product audit fixture" } });
  const { CorrelationRegistry } = await import("../plugin/server/core/correlations.ts");
  const lead = new CorrelationRegistry(state).issue({ role: "lead", projectSlug: project.slug, projectRoot: repo });
  const deps = { scrumCommand: async (request: import("../plugin/server/spool.ts").ScrumSpoolRequest, caller: { authority: "owner" | "supervisor" | "lead" | "agent"; actor: string }) => ({ id: request.id, ok: true as const, summary: "Scrum", data: scrumOperation(request, { factory, slug: project.slug, root: repo, ...caller, activeAgents: [], pendingDirectives: false }) }) };
  const ref = artifactAt(repo, sha, reportPath);
  const operate = (id: string, payload: Record<string, unknown>) => handleSpoolRequest(factory, { id, requestId: id, kind: "scrum_command", operation: "lead.operation", submitter: lead.correlationId, projectRoot: repo, payload }, deps);
  const audit = await operate("audit-op", { action: "qa.audit", auditArtifact: reportPath, artifactRefs: [ref], roleResults: [{ task: "audit", result: { status: "complete", artifactRefs: [ref], assumptions: [], openQuestions: [], conflicts: [] } }] }); assert.ok(audit.ok, JSON.stringify(audit));
  const promote = await operate("promotion", { action: "bundle.promote", bundlePath: reportPath, artifactRefs: [ref] }); assert.ok(promote.ok, JSON.stringify(promote));
  const complete = await operate("complete", { action: "run.complete" }); assert.ok(complete.ok, JSON.stringify(complete));
  assert.equal(listRuns(state, project.slug)[0].phase, "completed");
});
