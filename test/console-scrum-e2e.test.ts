import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { commandRun, readRun } from "../plugin/server/core/scrum/run-journal.ts";
import { scrumCommandViaSidecar } from "../web/src/scrum.ts";
import { inboxViaSidecar } from "../web/src/inbox.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { inboxModel, type InboxGather } from "../web/src/view-model.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-06): at least one test drives the console's
 * REAL transports — `web/src/scrum.ts` `scrumCommandViaSidecar` (plus T-05's
 * `inboxViaSidecar` / `loadSnapshotViaSidecar`), the exact functions the
 * browser bundle calls — against a REAL started sidecar over a REAL Factory
 * fixture with a registered Scrum Project holding a run that waits on the
 * Owner twice: a pending question (Answer) and a tasks-budget blocker
 * (Grant). Proves the bounded outcome end to end: the answer records
 * `owner_resolved` with Owner authority the way Accept carries it (no
 * credential — the actor IS "owner"), the grant records `allowance_granted`
 * and lifts the blocker, both items leave the folded Inbox, and the one
 * operation the console must never reach (`run.cancel`) refuses
 * `forbidden_operation` before any handler runs — the run stays alive.
 */

test("RG-1: the console's real transport resolves the Owner's Scrum waits from the Inbox — answer, grant, and the forbidden cancel refuses", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the Scrum Project whose run waits on the Owner.
  const repo = join(homeRoot, "beta");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# beta\n");
  gitCommitAll(repo);
  const fixture = makeConsoleFixture(homeRoot, { registry: true });
  // The system's own slug law (`resolveProject`): `<basename>-<hash>` — the
  // same slug `factory.scrum.command` resolves from projectRoot, so the
  // registration, the run journal, and the gather all name ONE Project.
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug });
  assert.equal(registered.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // Scrum mode for the Project — `run.create` refuses an SLP selection.
  const switched = await fixture.handlers.executionSetMode({ projectRoot: repo, mode: "scrum" });
  assert.equal(switched.ok, true, switched.ok ? "" : switched.error);

  // The run: maxTasks 1 — the Owner's Inbox will have to grant it breathing room.
  const created = await fixture.handlers.scrumCommand({
    projectRoot: repo,
    operation: "run.create",
    runId: "run-beta-1",
    requestId: "create-run-beta-1",
    payload: { initiativeId: "init-beta", track: "quick", rationale: "scrum owner e2e", budgets: { maxTasks: 1 } },
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error);

  // A pending question on task T9 — the Answer half of the bounded outcome.
  commandRun(fixture.stateDir, slug, "run-beta-1", {
    type: "owner_requested",
    requestId: "ask-beta-1",
    expectedRevision: readRun(fixture.stateDir, slug, "run-beta-1").revision,
    request: {
      id: "q-beta-1",
      kind: "question",
      question: "Choose the retention policy for completed agents",
      affected: [{ kind: "task", id: "T9" }],
      origin: { actor: "lead", role: "lead" },
      status: "pending",
      createdAt: "",
    },
  });

  // The tasks-budget blocker: reserve the one allowed Task, then a second —
  // the journal refuses `scrum-task-capacity-exhausted` AND records the
  // `:exhausted` blocked event with cause `tasks` (run-journal's own law).
  commandRun(fixture.stateDir, slug, "run-beta-1", {
    type: "task_reserved",
    task: "T-PM-1",
    role: "pm",
    required: true,
    requestId: "reserve-pm-1",
    expectedRevision: readRun(fixture.stateDir, slug, "run-beta-1").revision,
  });
  assert.throws(
    () =>
      commandRun(fixture.stateDir, slug, "run-beta-1", {
        type: "task_reserved",
        task: "T-UX-1",
        role: "ux",
        required: true,
        requestId: "reserve-ux-1",
        expectedRevision: readRun(fixture.stateDir, slug, "run-beta-1").revision,
      }),
    /Task capacity exhausted: 1\/1 Tasks used/,
  );
  const blockedRun = readRun(fixture.stateDir, slug, "run-beta-1");
  assert.ok((blockedRun.blockerDetails ?? []).some((blocker) => blocker.causes.includes("tasks")), "the journal recorded the tasks-capacity blocker");

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // The real reads: the gather carries the row's own facts — the pending
  // question, the run's revision, the allowance counts, the blocker causes.
  const gather = await inboxViaSidecar(fetchAt);
  assert.equal(gather.ok, true, gather.ok ? "" : gather.error);
  assert.equal(gather.projects.length, 1);
  const row = gather.projects[0]!;
  assert.equal(row.projectSlug, slug);
  assert.equal(row.runId, "run-beta-1");
  assert.equal(row.requests[0]?.id, "q-beta-1");
  assert.equal(row.revision, blockedRun.revision);
  assert.deepEqual(row.allowance, { tasksUsed: 1, tasksAllowed: 1, qaFixRoundsUsed: 0, qaFixRoundsAllowed: 2 });
  assert.deepEqual(row.blockers, [{ id: "reserve-ux-1:exhausted", reason: "Task capacity exhausted: 1/1 Tasks used. Ask Owner to add Task capacity.", causes: ["tasks"] }]);

  // The console's own fold: the question and the budget blocker both wait on
  // the Owner, ranked ahead of any ready-to-accept work.
  const snapshot = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
  const fold = (gathered: Awaited<ReturnType<typeof inboxViaSidecar>>) =>
    gathered.ok ? inboxModel(snapshot.view, { projects: gathered.projects, refusals: gathered.refusals, error: null } satisfies InboxGather) : null;
  const model = fold(gather);
  assert.deepEqual(
    model!.items.map((item) => [item.kind, item.expectedRevision]),
    [
      ["owner-request", blockedRun.revision],
      ["budget-blocked", blockedRun.revision],
    ],
  );
  assert.equal(model!.items[0]!.pendingId, "q-beta-1");
  assert.deepEqual(model!.items[1]!.grantCauses, ["tasks"]);

  // (a) The Answer: `wait.answer` through the console's real transport, the
  // gather row's own revision as expectedRevision, a fresh owner- requestId.
  const answered = await scrumCommandViaSidecar(
    {
      projectRoot: repo,
      operation: "wait.answer",
      runId: "run-beta-1",
      requestId: `owner-${Date.now()}-answer`,
      expectedRevision: row.revision!,
      payload: { pendingId: "q-beta-1", rationale: "Keep completed agents visible for 30 days" },
    },
    fetchAt,
  );
  assert.equal(answered.ok, true, answered.ok ? "" : answered.error);
  const answeredRun = readRun(fixture.stateDir, slug, "run-beta-1");
  assert.equal(answeredRun.ownerRequests?.[0]?.status, "answered", "the journal recorded the owner_resolved command");
  assert.deepEqual(answeredRun.ownerRequests?.[0]?.resolution?.outcome, "answered");
  assert.equal(answeredRun.ownerRequests?.[0]?.resolution?.actor, "owner", "console calls carry Owner authority the way Accept does — no credential, the actor is the Owner");
  assert.equal(answeredRun.revision, blockedRun.revision + 1, "the answer consumed exactly one journal revision");

  // The re-read: the gather answers every request status verbatim (the fold
  // filters pending), so the question left the FOLD while the budget blocker
  // still waits.
  const gatherAfterAnswer = await inboxViaSidecar(fetchAt);
  assert.equal(gatherAfterAnswer.ok, true);
  assert.equal(gatherAfterAnswer.projects[0]?.requests[0]?.status, "answered");
  const modelAfterAnswer = fold(gatherAfterAnswer)!;
  assert.deepEqual(modelAfterAnswer.items.map((item) => item.kind), ["budget-blocked"]);

  // (b) The Grant: `allowance.tasks` +8 from the re-read row's own revision —
  // the blocker lifts, the allowance counts widen, the item leaves.
  const granted = await scrumCommandViaSidecar(
    {
      projectRoot: repo,
      operation: "allowance.tasks",
      runId: "run-beta-1",
      requestId: `owner-${Date.now()}-grant`,
      expectedRevision: gatherAfterAnswer.projects[0]!.revision!,
      payload: { amount: 8, rationale: "The UX revision is worth the capacity" },
    },
    fetchAt,
  );
  assert.equal(granted.ok, true, granted.ok ? "" : granted.error);
  const grantedRun = readRun(fixture.stateDir, slug, "run-beta-1");
  assert.equal(grantedRun.budgets.maxTasks, 9, "the allowance_granted command widened the cap 1 → 9");
  assert.deepEqual(
    grantedRun.allowanceGrants?.map((grant) => ({ dimension: grant.dimension, amount: grant.amount, actor: grant.actor })),
    [{ dimension: "tasks", amount: 8, actor: "owner" }],
    "the journal recorded the allowance_granted command with Owner authority",
  );
  assert.equal((grantedRun.blockerDetails ?? []).length, 0, "the grant cleared the tasks-capacity blocker");
  assert.notEqual(grantedRun.phase, "blocked");

  const gatherAfterGrant = await inboxViaSidecar(fetchAt);
  assert.equal(gatherAfterGrant.ok, true);
  assert.deepEqual(gatherAfterGrant.projects[0]?.blockers, [], "the unblocked run carries no blocker causes");
  assert.equal(gatherAfterGrant.projects[0]?.allowance?.tasksAllowed, 9);
  assert.deepEqual(fold(gatherAfterGrant)!.items, [], "the Inbox is empty — both waits resolved");

  // (c) The forbidden act: `run.cancel` through the SAME door refuses as data
  // before any handler runs — the run stays alive, uncancelled. The console's
  // own type cannot even spell a sixth operation (`ConsoleScrumOperation`), so
  // the honest threat model is a crafted request body posted against the door
  // — the raw POST the type would refuse to compile.
  const refused = await fetchAt("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "factory.scrum.command",
      params: {
        projectRoot: repo,
        operation: "run.cancel",
        runId: "run-beta-1",
        requestId: `owner-${Date.now()}-cancel`,
        expectedRevision: grantedRun.revision,
        payload: { reason: "the console must never reach this" },
      },
    }),
  });
  assert.equal(refused.status, 400);
  const refusal = (await refused.json()) as { ok: boolean; code?: string; error?: string };
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "forbidden_operation");
  assert.match(refusal.error ?? "", /run\.cancel/);
  const survivingRun = readRun(fixture.stateDir, slug, "run-beta-1");
  assert.notEqual(survivingRun.phase, "cancelled", "the refusal fired before any handler ran");
  assert.equal(survivingRun.cancellation, undefined, "no cancellation_requested event was ever recorded");
  assert.equal(survivingRun.revision, grantedRun.revision, "the refused operation consumed no journal revision");
});
