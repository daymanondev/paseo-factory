import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { projectStateDir, resolveProject, writeProjectRegistration } from "../plugin/server/core/project.ts";
import { factoryRegistryFor } from "../plugin/server/projects.ts";
import {
  projectEventsOf,
  projectOwnAndTaskEventsOf,
  projectStreamOf,
  type ProjectLedgerSource,
} from "../plugin/server/peer-in-flight.ts";
import type { LedgerEvent } from "../plugin/server/core/events.ts";
import { buildSubstituteHandover, extractCleanTimelineText } from "../plugin/server/substitute-handover.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

test("projectStreamOf drops root task-less events for registered Projects while projectOwnAndTaskEventsOf keeps Project store_release_* and workspace tasks", (t) => {
  const dir = makeTempDir("peer-in-flight-scope-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const rootA = join(dir, "proj-a");
  const rootB = join(dir, "proj-b");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  writeFileSync(join(rootA, "README.md"), "a\n");
  writeFileSync(join(rootB, "README.md"), "b\n");
  gitCommitAll(rootA);
  gitCommitAll(rootB);

  const projA = resolveProject(rootA);
  const projB = resolveProject(rootB);
  assert.ok(projA.ok && projB.ok);

  const rootFactory = createFactory({ stateDir });
  writeProjectRegistration(stateDir, projA.slug, { root: rootA });
  writeProjectRegistration(stateDir, projB.slug, { root: rootB });
  const registry = factoryRegistryFor(stateDir, { root: rootFactory });
  const factoryA = registry.factoryForProject(projA.slug);

  // Root-factory noise: task-less git_blocked + unrelated Project B legacy task
  rootFactory.ledger.append({
    event: "git_blocked",
    blockId: "root-gb-1",
    command: "git push",
    rule: "release-fence",
    reason: "blocked on root",
    cwd: dir,
  });
  rootFactory.setContract({ task: "T-OTHER", workspace: rootB, gate: "true" });

  // Legacy root-bridge task owned by Project A
  rootFactory.setContract({ task: "T-LEGACY-A", workspace: rootA, gate: "true" });

  // Project A's own task-less store_release_* and task event
  factoryA.ledger.append({
    event: "store_release_started",
    runId: "sr-100",
    action: "stage",
    platforms: ["android"],
    mode: "on-request",
  });
  factoryA.setContract({ task: "T-OWN-A", workspace: rootA, gate: "true" });

  const source = { factory: rootFactory, registry };
  const streamA = projectStreamOf(source, projA.slug);
  assert.equal(streamA.some((e) => e.event === "git_blocked"), false, "root task-less git_blocked must never leak into registered Project stream");
  assert.equal(streamA.some((e) => e.event === "store_release_started" && e.runId === "sr-100"), true);

  const ownAndTasksA = projectOwnAndTaskEventsOf(source, stateDir, projA.slug, rootA);
  assert.equal(ownAndTasksA.some((e) => e.event === "store_release_started" && e.runId === "sr-100"), true, "retains Project-own task-less store_release_*");
  assert.equal(ownAndTasksA.some((e) => "task" in e && e.task === "T-OWN-A"), true, "retains Project A task");
  assert.equal(ownAndTasksA.some((e) => "task" in e && e.task === "T-LEGACY-A"), true, "retains legacy root-bridge task owned by Project A");
  assert.equal(ownAndTasksA.some((e) => "task" in e && e.task === "T-OTHER"), false, "excludes Project B task");
  assert.equal(ownAndTasksA.some((e) => e.event === "git_blocked"), false);

  // projectEventsOf stays strictly task-only
  const tasksOnlyA = projectEventsOf(source, stateDir, projA.slug, rootA);
  assert.equal(tasksOnlyA.some((e) => e.event === "store_release_started"), false);
  assert.equal(tasksOnlyA.some((e) => "task" in e && e.task === "T-OWN-A"), true);
});

test("extractCleanTimelineText keeps only human-readable user/assistant text and strips extraction prompt echoes and tool blobs", () => {
  const entries = [
    { item: { type: "tool_call", name: "Bash", input: { cmd: "ls" } } },
    { item: { type: "tool_result", text: "huge raw tool stdout" } },
    { item: { type: "thinking", text: "internal reasoning" } },
    { item: { type: "user_message", text: "# Peer handoff extraction — Task T-04\n\nStart no new work." } },
    { type: "user_message", text: "# Lead handoff extraction — project demo\n\nUse 5 sections." },
    { item: { type: "user_message", text: "Supervisor handoff: reply first with a short continuity handover." } },
    { item: { type: "user_message", text: "Please keep the release fence intact." } },
    { item: { type: "assistant_message", text: "Verified the regression slice.\n\n\n\nNext: patch handler." } },
    { type: "assistant_message", text: "   " },
  ];

  const clean = extractCleanTimelineText(entries);
  assert.equal(clean, "User: Please keep the release fence intact.\n\nAssistant: Verified the regression slice.\n\nNext: patch handler.");
  assert.equal(clean.includes("tool_call"), false);
  assert.equal(clean.includes("huge raw tool stdout"), false);
  assert.equal(clean.includes("Peer handoff extraction"), false);
  assert.equal(clean.includes("Lead handoff extraction"), false);
  assert.equal(clean.includes("Supervisor handoff:"), false);

  assert.equal(extractCleanTimelineText(entries, { maxEntries: 1 }), "Assistant: Verified the regression slice.\n\nNext: patch handler.");
  assert.equal(extractCleanTimelineText([{ type: "tool_call" }]), "");
});

test("buildSubstituteHandover omits Project notebook when notebook is undefined and preserves it when provided", () => {
  const withoutNotebook = buildSubstituteHandover({
    digest: "seq 1 — contract_set",
    git: "Branch: main",
    tasks: "T-01: running",
    timeline: "Assistant: working",
    maxBytes: 4096,
  });
  assert.equal(withoutNotebook.includes("Project notebook"), false);
  for (const heading of ["Plugin-built handover", "Ledger digest", "Git state", "Open Tasks", "Recent timeline"]) {
    assert.ok(withoutNotebook.includes(heading));
  }

  const withNotebook = buildSubstituteHandover({
    digest: "seq 1 — contract_set",
    notebook: "## 1. Verification & Run Recipe\nnpm test",
    git: "Branch: main",
    tasks: "T-01: running",
    timeline: "Assistant: working",
    maxBytes: 4096,
  });
  assert.ok(withNotebook.includes("## Project notebook\n## 1. Verification & Run Recipe"));
});

test("projectStreamOf, projectEventsOf, and projectOwnAndTaskEventsOf stay O(N) on 6,000-event multi-hundred-task Ledgers without calling contractFor per event", (t) => {
  const dir = makeTempDir("peer-in-flight-perf-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const rootA = join(dir, "proj-a");
  const rootB = join(dir, "proj-b");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });

  const ts = "2026-11-24T00:00:00.000Z";
  const projEvents: LedgerEvent[] = [];
  const rootEvents: LedgerEvent[] = [];
  let seq = 1;
  for (let i = 0; i < 500; i += 1) {
    const task = `T-${i}`;
    projEvents.push(
      { seq: seq++, ts, event: "contract_set", task, workspace: rootA, gate: "true", artifact: "", base: "abc" },
      { seq: seq++, ts, event: "spawn_dispatched", task, provider: "pi/m", arity: 1, worktree: join(dir, "wt", task) },
      { seq: seq++, ts, event: "claim_reported", task, attempt: 1, sha: "1234567" },
      { seq: seq++, ts, event: "gate_finished", task, attempt: 1, exit: 0, verdict: "green", note: "ok" },
      { seq: seq++, ts, event: "attempt_accepted", task, attempt: 1 },
      { seq: seq++, ts, event: "report_written", task, attempt: 1, path: `report-${task}.md` },
    );
  }
  // 3,000 project events + legacy root task + unrelated project task + task-less root noise
  projEvents.push({ seq: seq++, ts, event: "store_release_started", runId: "sr-perf", action: "stage", platforms: ["ios"], mode: "on-request" });
  rootEvents.push(
    { seq: 1, ts, event: "git_blocked", blockId: "gb-1", command: "git push", rule: "release-fence", reason: "root", cwd: dir },
    { seq: 2, ts, event: "contract_set", task: "T-LEGACY-A", workspace: rootA, gate: "true", artifact: "", base: "abc" },
    { seq: 3, ts, event: "contract_set", task: "T-OTHER-B", workspace: rootB, gate: "true", artifact: "", base: "abc" },
  );

  let contractForCalls = 0;
  const makeStubFactory = (events: LedgerEvent[]) => ({
    ledger: { events },
    contractFor: () => {
      contractForCalls += 1;
      throw new Error("linear filter must not call quadratic contractFor()");
    },
  });
  const rootFactory = makeStubFactory(rootEvents);
  const projectFactory = makeStubFactory(projEvents);
  const source: ProjectLedgerSource = {
    factory: rootFactory as never,
    registry: {
      factoryForProject: () => projectFactory as never,
    } as never,
  };

  const t0 = performance.now();
  const stream = projectStreamOf(source, "proj-a");
  const tasksOnly = projectEventsOf(source, stateDir, "proj-a", rootA);
  const ownAndTasks = projectOwnAndTaskEventsOf(source, stateDir, "proj-a", rootA);
  const elapsedMs = performance.now() - t0;

  assert.equal(contractForCalls, 0);
  assert.equal(stream.some((e) => e.event === "git_blocked"), false);
  assert.equal(tasksOnly.length, 3001, "3,000 Project A events + 1 legacy root task");
  assert.equal(ownAndTasks.length, 3002, "retains Project A store_release_started + 3,001 task events");
  assert.ok(elapsedMs < 250, `expected linear filtering in < 250ms, took ${elapsedMs.toFixed(1)}ms`);
});
