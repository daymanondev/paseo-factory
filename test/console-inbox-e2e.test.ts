import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import { ensureScrumConfig } from "../plugin/server/core/scrum/config.ts";
import { commandRun, createScrumRun } from "../plugin/server/core/scrum/run-journal.ts";
import { acceptViaSidecar } from "../web/src/accept.ts";
import { inboxViaSidecar } from "../web/src/inbox.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { inboxModel } from "../web/src/view-model.ts";
import type { TaskView } from "../plugin/shared/view.ts";
import { makeConsoleFixture, makeReadyToAcceptTask } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-05): at least one test drives the console's
 * REAL transports — `web/src/useSnapshot.ts` `loadSnapshotViaSidecar`,
 * `web/src/inbox.ts` `inboxViaSidecar`, and `web/src/accept.ts`
 * `acceptViaSidecar`, the exact functions the browser bundle calls — against
 * a REAL started sidecar over a REAL Factory fixture with TWO registered
 * Projects, each holding work that waits on the Owner: alpha a needs-human
 * Task, beta a ready-to-accept Task plus a pending Scrum Owner request.
 * Proves the bounded outcome end to end: the cross-Project inbox items each
 * name their Project, Accept lands from the Inbox item's own facts (beta's
 * ledger records it), and the re-read fold's count drops.
 */

test("RG-1: the console's real transports fold the cross-Project inbox — both Projects' items, Accept from the Inbox, count drops", async (t) => {
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
  // Registered against the fixture's OWN stateDir — the registry the fixture
  // wires resolves both slugs to per-Project Factories.
  const fixture = makeConsoleFixture(homeRoot, { registry: true });
  const alphaReg = ensureProjectRegistered(fixture.stateDir, { root: alpha.repo, slug: "alpha" });
  const betaReg = ensureProjectRegistered(fixture.stateDir, { root: beta.repo, slug: "beta" });
  assert.equal(alphaReg.ok, true);
  assert.equal(betaReg.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });
  const alphaFactory = fixture.registry.factoryForProject("alpha");
  const betaFactory = fixture.registry.factoryForProject("beta");

  // Alpha: a needs-human Task — the permit_denied → repoke → needs_human law.
  alphaFactory.setContract({ task: "T-05", workspace: alpha.repo, gate: "npm test", artifact: "README.md" });
  alphaFactory.ledger.append({ event: "claim_reported", task: "T-05", attempt: 1, sha: alpha.sha });
  const denial = alphaFactory.ledger.append({ event: "permit_denied", task: "T-05", agent: "peer", name: "Bash", kind: "tool", rule: "scope", reason: "denied" });
  const poke = alphaFactory.ledger.append({ event: "repoke_dispatched", task: "T-05", agent: "peer" });
  alphaFactory.ledger.append({ event: "needs_human", task: "T-05", reason: "denied-again", evidence: { denial: denial.seq, repoke: poke.seq } });

  // Beta: a ready-to-accept Task on its OWN Factory — the Accept act's target.
  makeReadyToAcceptTask(betaFactory, homeRoot, "T9");

  // Beta: a pending Scrum Owner request on its active run — the gather's half.
  const config = ensureScrumConfig(fixture.stateDir, "beta");
  const run = createScrumRun({ state: fixture.stateDir, slug: "beta", runId: "run-beta-1", initiativeId: "init-beta", config, configRevision: 1, track: "quick", rationale: "inbox e2e", requestId: "create-run-beta-1" });
  commandRun(fixture.stateDir, "beta", run.runId, {
    type: "owner_requested",
    requestId: "ask-beta-1",
    expectedRevision: run.revision,
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

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // The real reads: the unscoped snapshot carries BOTH Projects' Tasks, each
  // attributed with its additive projectSlug; the gather carries beta's run.
  const snapshot = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
  const t9 = snapshot.view.tasks.find((task) => task.task === "T9") as (TaskView & { projectSlug?: string }) | undefined;
  const t05 = snapshot.view.tasks.find((task) => task.task === "T-05") as (TaskView & { projectSlug?: string }) | undefined;
  assert.equal(t05?.status, "needs-human");
  assert.equal(t05?.projectSlug, "alpha");
  assert.equal(t9?.status, "ready-to-accept");
  assert.equal(t9?.projectSlug, "beta");

  const gather = await inboxViaSidecar(fetchAt);
  assert.equal(gather.ok, true, gather.ok ? "" : gather.error);
  assert.deepEqual(gather.projects.map((project) => project.projectSlug), ["beta"]);
  assert.equal(gather.projects[0]?.requests[0]?.id, "q-beta-1");

  // The console's own fold: three items across the two Projects, each naming
  // its Project, sorted by urgency — the badge counts the same list.
  const model = inboxModel(snapshot.view, { projects: gather.projects, refusals: gather.refusals, error: null });
  assert.deepEqual(
    model.items.map((item) => [item.kind, item.projectName]),
    [
      ["needs-human", "alpha"],
      ["owner-request", "beta"],
      ["ready-to-accept", "beta"],
    ],
  );
  assert.equal(model.items[0]!.detail, "denied-again");
  assert.equal(model.items[1]!.runId, "run-beta-1");
  assert.equal(model.items[2]!.acceptAttempt, 1);
  assert.equal(model.count, 3);

  // Accept lands from the Inbox item's own facts — the real write through the
  // same allowlisted door, recorded in beta's OWN ledger.
  const accepted = await acceptViaSidecar({ task: "T9", attempt: 1 }, fetchAt);
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error);
  assert.ok(betaFactory.ledger.eventsFor("T9").some((event) => event.event === "attempt_accepted"), "beta's ledger records the acceptance");

  // The re-read: the snapshot refreshed, the gather re-read, and the count
  // drops — the accepted Task leaves the list, the rest stays waiting.
  const snapshot2 = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(snapshot2.ok, true);
  const gather2 = await inboxViaSidecar(fetchAt);
  assert.equal(gather2.ok, true);
  const model2 = inboxModel(snapshot2.view, { projects: gather2.projects, refusals: gather2.refusals, error: null });
  assert.deepEqual(
    model2.items.map((item) => [item.kind, item.projectName]),
    [
      ["needs-human", "alpha"],
      ["owner-request", "beta"],
    ],
  );
  assert.equal(model2.count, 2);
});
