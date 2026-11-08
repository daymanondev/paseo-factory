import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveProject } from "../plugin/server/core/project.ts";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import { usageFilePath } from "../plugin/server/core/usage-status.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { activityScreenModel, type ActivityLedgerRow } from "../web/src/activity-view.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-11a): at least one test drives the console's
 * REAL snapshot read — `web/src/useSnapshot.ts` `loadSnapshotViaSidecar`,
 * the exact function the browser bundle calls — against a REAL started
 * sidecar over a REAL Factory fixture whose ONE registered git Project's
 * ledger is seeded through the real Factory (the registry's own per-Project
 * Factory — setContract plus six appended events spanning all seven kinds) and
 * whose `usage.json` rollup is seeded under the usage runtime's own law.
 * Proves the bounded outcome end to end: the Activity fold renders the
 * read-only ledger stream from the snapshot alone — each seeded event found
 * by kind and task (never list equality: the ledger carries its own schema
 * line and the snapshot may add more), the stream newest-first with
 * deterministic UTC stamps and the server's own detail lines verbatim, the
 * usage rollup's by-model/by-lane rows and honest costs — while an unscoped
 * read through the same transport folds the aggregate stream's rows
 * attributed with their Project slug and the usage half's honest null (the
 * unscoped view carries no rollup), never a borrowed or fabricated one.
 */

/** Finds one seeded row by its event word and task — the "by kind/task" law, never list equality. */
function rowOf(rows: readonly ActivityLedgerRow[], event: string, task: string): ActivityLedgerRow {
  const row = rows.find((candidate) => candidate.event === event && candidate.task === task);
  assert.ok(row !== undefined, `the stream carries the seeded ${event} for ${task}`);
  return row;
}

test("RG-1: the console's real transport folds the Activity screen — the seeded ledger by kind/task, the usage rollup, both scopes honest", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose activity the screen folds.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";
  // The default empty daemon suffices: the ledger and the rollup are
  // filesystem folds; `usage: true` wires the same rollup runtime the live
  // plugin server runs with.
  const fixture = makeConsoleFixture(homeRoot, { registry: true, usage: true });
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug });
  assert.equal(registered.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // The Task's workspace — a real git repo the contract can point at.
  const workspace = join(homeRoot, "T11-ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);

  // The ledger, seeded through the Project's OWN real Factory: the contract
  // through `setContract` (the same door the Owner's writes ride), then six
  // appended events spanning the other six kinds — spawn, claim, gate,
  // meter, accepted, and the factory-level `needs_human` stall under
  // `other`. The Factory stamps every ts itself, and the stream may carry
  // lines beyond the seeds (why the asserts never do list equality).
  const factory = fixture.registry.factoryForProject(slug);
  factory.setContract({ task: "T-11", workspace, gate: "npm test", artifact: "src/format.ts" });
  factory.ledger.append({ event: "spawn_dispatched", task: "T-11", provider: "pi/zai/glm-5.3", arity: 1 });
  factory.ledger.append({ event: "claim_reported", task: "T-11", attempt: 1, sha });
  factory.ledger.append({ event: "gate_finished", task: "T-11", attempt: 1, exit: 0, verdict: "green", note: "passed" });
  factory.ledger.append({
    event: "meter_written",
    task: "T-11",
    provider: "pi/zai/glm-5.3",
    usage: { inputTokens: 1_000, outputTokens: 500, totalCostUsd: 0.25 },
  });
  factory.ledger.append({ event: "attempt_accepted", task: "T-11", attempt: 1, accepted_by: "owner" });
  factory.ledger.append({ event: "needs_human", task: "T-11", reason: "attempt-ceiling", evidence: { attempt: 1, gate: 1 } });

  // The Project's usage rollup — a Lead seat session and the Peer's Task
  // session with honest disjoint buckets, `backfilledAt` set so the lazy
  // backfill returns the file verbatim (the same law the drawer-tabs e2e
  // seeds under).
  const usagePath = usageFilePath(fixture.stateDir, slug);
  mkdirSync(dirname(usagePath), { recursive: true });
  writeFileSync(
    usagePath,
    JSON.stringify({
      version: 1,
      projectSlug: slug,
      backfilledAt: "2026-11-07T08:00:00.000Z",
      updatedAt: "2026-11-08T09:00:00.000Z",
      sessions: {
        "lead-1": {
          agentId: "agent-lead-1",
          projectSlug: slug,
          seat: "lead",
          harness: "pi",
          provider: "pi",
          model: "glm-5.3",
          turns: 4,
          inputUncachedTokens: 40_000,
          cacheReadTokens: 10_000,
          cacheWriteTokens: 2_000,
          outputTokens: 8_000,
          reasoningTokens: 1_000,
          totalTokens: 60_000,
          totalCostUsd: 0.5,
          updatedAt: "2026-11-08T09:00:00.000Z",
        },
        "peer-1": {
          agentId: "agent-peer-1",
          projectSlug: slug,
          seat: "agent",
          task: "T-11",
          harness: "codex",
          provider: "codex",
          model: "gpt-6.1",
          turns: 3,
          inputUncachedTokens: 1_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1_000,
          reasoningTokens: 0,
          totalTokens: 2_000,
          updatedAt: "2026-11-08T09:00:00.000Z",
        },
      },
    }) + "\n",
  );

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // The scoped read through the real transport: the fold renders the
  // Project's read-only activity from the snapshot alone.
  const snapshot = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
  assert.equal(snapshot.view.project?.slug, slug);
  const model = activityScreenModel(snapshot.view);
  assert.equal(model.scope, snapshot.view.project.name ?? snapshot.view.project.slug);
  assert.equal(model.ledgerError, null, "the fixture's ledger opens — no degraded notice");

  // Every seeded event appears, found by kind and task — the taxonomy's own
  // seven kinds, each row carrying its task id and the ledger's own detail.
  const kinds: readonly [string, string][] = [
    ["contract_set", "contract"],
    ["spawn_dispatched", "spawn"],
    ["claim_reported", "claim"],
    ["gate_finished", "gate"],
    ["meter_written", "meter"],
    ["attempt_accepted", "accepted"],
    ["needs_human", "other"],
  ];
  for (const [event, kind] of kinds) {
    const row = rowOf(model.ledger, event, "T-11");
    assert.equal(row.kind, kind, `${event} classifies ${kind}`);
    assert.equal(row.task, "T-11");
    assert.match(row.timeLabel, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/, `${event} carries the deterministic UTC stamp`);
    assert.equal(row.projectSlug, slug, "the registry-wired stream attributes every line with its Project slug");
  }
  // The detail lines render the server's own words verbatim — the fold adds
  // nothing and drops nothing.
  assert.equal(rowOf(model.ledger, "attempt_accepted", "T-11").detail, "ACCEPTED #1 by owner");
  assert.equal(rowOf(model.ledger, "meter_written", "T-11").detail, "meter pi/zai/glm-5.3 $0.25");
  assert.equal(rowOf(model.ledger, "spawn_dispatched", "T-11").detail, "spawn pi/zai/glm-5.3");
  assert.equal(rowOf(model.ledger, "needs_human", "T-11").detail, "needs human — attempt-ceiling");
  // The stream is newest-first: the last-seeded acceptance sits above the
  // contract, and no row's ts is older than the row beneath it.
  const seeded = model.ledger.filter((row) => row.task === "T-11");
  assert.ok(seeded.indexOf(rowOf(model.ledger, "attempt_accepted", "T-11")) < seeded.indexOf(rowOf(model.ledger, "contract_set", "T-11")), "the newest seeded event renders first");
  for (let i = 1; i < model.ledger.length; i += 1) {
    assert.ok(model.ledger[i - 1]!.ts >= model.ledger[i]!.ts, `row ${i - 1} is newer than row ${i}`);
  }
  // The kind chips count every seeded kind — including the factory-level
  // stall under `other`, never dropped and never fabricated.
  assert.equal(model.kindCounts.contract, 1);
  assert.equal(model.kindCounts.spawn, 1);
  assert.equal(model.kindCounts.claim, 1);
  assert.equal(model.kindCounts.gate, 1);
  assert.equal(model.kindCounts.meter, 1);
  assert.equal(model.kindCounts.accepted, 1);
  assert.equal(model.kindCounts.other, 1, "the seeded factory-level stall folds under other");
  assert.equal(model.kindCounts.all, model.ledger.length);

  // The usage rollup folds honestly: both sessions in the totals, the two
  // by-model rows with their providers, the Lead lane row with its dollars,
  // and the costless Peer row carrying its honest null.
  assert.ok(model.usage !== null, "the scoped read folds the seeded rollup");
  assert.equal(model.usage.totals.sessionCount, 2);
  assert.equal(model.usage.totals.costLabel, "$0.50");
  const glm = model.usage.byModel.find((row) => row.id === "pi/glm-5.3");
  assert.ok(glm !== undefined, "the Lead's model row folds");
  assert.equal(glm.costLabel, "$0.50");
  assert.equal(glm.share, 100, "the largest model row fills its bar");
  const gpt = model.usage.byModel.find((row) => row.id === "codex/gpt-6.1");
  assert.ok(gpt !== undefined, "the Peer's model row folds");
  assert.equal(gpt.costLabel, null, "no session reported dollars — never a fabricated zero");
  const lead = model.usage.bySeat.find((row) => row.label === "Lead");
  assert.ok(lead !== undefined, "the Lead lane row folds");
  assert.equal(lead.totalTokens, 60_000);
  const peer = model.usage.bySeat.find((row) => row.label === "Peer");
  assert.ok(peer !== undefined, "the Peer lane row folds");
  assert.equal(peer.costLabel, null);

  // The unscoped read through the same transport: the aggregate stream
  // attributes the seeded rows with their Project slug (two Projects may
  // share a task id — the attribution is the row's own fact), and the usage
  // half folds its honest null — the unscoped view carries no rollup, so
  // the screen answers "No usage recorded", never a borrowed Project's.
  const global = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(global.ok, true, global.ok ? "" : global.error);
  const unscoped = activityScreenModel(global.view);
  assert.equal(unscoped.scope, "All projects");
  assert.equal(unscoped.usage, null);
  const accepted = rowOf(unscoped.ledger, "attempt_accepted", "T-11");
  assert.equal(accepted.projectSlug, slug, "the aggregate stream attributes the row with its Project slug");
  assert.equal(rowOf(unscoped.ledger, "contract_set", "T-11").projectSlug, slug);
});
