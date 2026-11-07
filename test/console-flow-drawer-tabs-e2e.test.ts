import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureProjectRegistered, writeProjectRegistration } from "../plugin/server/projects.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { usageFilePath } from "../plugin/server/core/usage-status.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { drawerTabsFor, flowScreenModel } from "../web/src/view-model.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-07c): the Agent Drawer's four new role-aware
 * tabs fold from a REAL snapshot read through the REAL sidecar —
 * `web/src/useSnapshot.ts` `loadSnapshotViaSidecar` against a started
 * `makeConsoleFixture` over a registered SLP Project whose fake daemon holds
 * the labeled seats. The fixture drives every half the tabs read: a Lead
 * whose `project.json` records `rotationState: "handing_over"` (the Handoff
 * tab), a working Peer whose Task closed a red-then-green Attempt ladder
 * with stamped shas (the Attempts tab), a `usage.json` rollup attributing a
 * Lead seat row and the Peer's Task row with a lying wire total (the
 * Resources tab's Meter law), and the daemon's own agent rows (the Session
 * tab). Proves the bounded outcome: every value comes from the existing
 * snapshot — no new door — and the read never writes.
 */

/** One fully-typed fake agent — the `SurfaceAgentSnapshot` slice the surface reads. */
function fakeAgent(over: Partial<SurfaceAgentSnapshot> & Pick<SurfaceAgentSnapshot, "id" | "labels" | "status">): SurfaceAgentSnapshot {
  return {
    provider: "pi",
    title: null,
    model: null,
    archivedAt: null,
    requiresAttention: false,
    attentionReason: null,
    updatedAt: new Date().toISOString(),
    cwd: "/",
    ...over,
  };
}

/** A fake daemon shaped exactly like the SDK's `agents.list` + timeline seams the snapshot walks. */
function seatsDaemon(agents: SurfaceAgentSnapshot[]): SurfaceDaemonApi {
  return {
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })) }),
      create: async () => ({ id: "unused" }),
      ref: (id: string) => ({
        send: async () => {},
        archive: async () => ({ archivedAt: new Date().toISOString() }),
        timeline: {
          refetch: async (_options?: { direction?: "tail"; limit?: number }) => ({ entries: [{ seqEnd: 41 }], error: null }),
        },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
    },
  };
}

test("RG-1: the console's real snapshot drives the Agent Drawer's Session, Attempts, Handoff, and Resources tabs", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose live seats open the drawer.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";
  const daemon = seatsDaemon([
    fakeAgent({ id: "agent-sup-1", title: "Supervisor", status: "running", model: "z-sup", labels: { seat: "supervisor", project: slug }, cwd: repo }),
    fakeAgent({
      id: "agent-lead-1",
      title: "Lead",
      status: "running",
      model: "z-lead",
      labels: { seat: "lead", project: slug },
      cwd: repo,
      lastUsage: { contextWindowUsedTokens: 96_000, contextWindowMaxTokens: 128_000 },
    }),
    fakeAgent({ id: "agent-peer-1", title: "Peer 1", status: "running", model: "z-dev", labels: { seat: "agent", project: slug }, cwd: repo }),
  ]);
  const fixture = makeConsoleFixture(homeRoot, { registry: true, daemon, usage: true });
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug });
  assert.equal(registered.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  // The seat bindings AND the durable rotation state the Handoff tab reads —
  // `project.json` records `handing_over`, so the Lead's mailbox locks.
  writeProjectRegistration(fixture.stateDir, slug, { root: repo, supervisor: "agent-sup-1", lead: "agent-lead-1", rotationState: "handing_over" });
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // The Project's own Factory holds the contracted Task — the working Peer
  // claims two attempts: #1 closes red, #2 claims a fresh sha and closes green.
  const workspace = join(homeRoot, "T-07-ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const sha1 = gitCommitAll(workspace);
  const factory = fixture.registry.factoryForProject(slug);
  factory.setContract({ task: "T-07", workspace, gate: "npm test", artifact: "src/format.ts" });
  factory.ledger.append({ event: "claim_reported", task: "T-07", attempt: 1, sha: sha1, agent: "agent-peer-1" });
  factory.ledger.append({ event: "gate_finished", task: "T-07", attempt: 1, exit: 1, verdict: "red", note: "failed", sha: sha1 });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad(s: string) { return s; }\n");
  const sha2 = gitCommitAll(workspace);
  factory.ledger.append({ event: "claim_reported", task: "T-07", attempt: 2, sha: sha2, agent: "agent-peer-1" });
  factory.ledger.append({ event: "gate_finished", task: "T-07", attempt: 2, exit: 0, verdict: "green", note: "passed", sha: sha2 });
  factory.ledger.append({ event: "report_written", task: "T-07", attempt: 2, path: "report-T-07-2.md" });

  // The Project's usage rollup — a Lead seat session and the Peer's Task
  // session, with a LYING wire total (the Meter law recomputes it) and
  // `backfilledAt` set so the lazy backfill returns the file verbatim.
  const usagePath = usageFilePath(fixture.stateDir, slug);
  mkdirSync(dirname(usagePath), { recursive: true });
  writeFileSync(
    usagePath,
    JSON.stringify({
      version: 1,
      projectSlug: slug,
      backfilledAt: "2026-11-07T08:00:00.000Z",
      updatedAt: "2026-11-07T09:00:00.000Z",
      sessions: {
        "lead-1": {
          agentId: "agent-lead-1",
          projectSlug: slug,
          seat: "lead",
          harness: "pi",
          provider: "pi",
          model: "z-lead",
          turns: 4,
          inputUncachedTokens: 40_000,
          cacheReadTokens: 10_000,
          cacheWriteTokens: 2_000,
          outputTokens: 8_000,
          reasoningTokens: 1_000,
          totalTokens: 999_999,
          totalCostUsd: 0.5,
          updatedAt: "2026-11-07T09:00:00.000Z",
        },
        "peer-1": {
          agentId: "agent-peer-1",
          projectSlug: slug,
          seat: "agent",
          task: "T-07",
          harness: "pi",
          provider: "pi",
          model: "z-dev",
          turns: 3,
          inputUncachedTokens: 1_000,
          cacheReadTokens: 2_000,
          cacheWriteTokens: 500,
          outputTokens: 1_500,
          reasoningTokens: 400,
          totalTokens: 5_000,
          updatedAt: "2026-11-07T09:00:00.000Z",
        },
      },
    }),
  );

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);
  const eventsBefore = factory.ledger.events.length;
  const snapshot = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
  const model = flowScreenModel(snapshot.view);
  assert.ok(model !== null, "a scoped read folds the graph the drawer opens from");
  const peer = model.peers[0]!;

  // 1. The Session tab — the daemon's own rows: provider/model, the configured
  //    lane for the standing seats, the raw status word, the oracle's seqEnd,
  //    the cwd, and the snapshot's own stamp as the honest last-read time.
  assert.equal(model.supervisor.session!.provider, "pi");
  assert.equal(model.supervisor.session!.model, "z-sup");
  assert.equal(model.supervisor.session!.lane, "pi/zai/glm-5.3");
  assert.equal(model.supervisor.session!.status, "running");
  assert.equal(model.supervisor.session!.requiresAttention, false);
  assert.equal(model.supervisor.session!.seqEnd, 41);
  assert.equal(model.supervisor.session!.cwd, repo);
  assert.equal(model.supervisor.session!.snapshotAt, snapshot.view.generatedAt);
  assert.equal(model.supervisor.session!.contextUsedTokens, null, "the daemon reports the context pair on the Lead only");
  // The Peer's lane comes from the Task's own runs — none named one, so the honest null.
  assert.equal(peer.session!.lane, null);
  assert.equal(peer.session!.model, "z-dev");

  // 2. The Attempts tab — the owned Task's ladder verbatim: n, verdict, the
  //    claimed sha, and the ledger's own Peer attribution.
  assert.deepEqual(
    peer.tasks[0]!.attempts.map((rung) => [rung.n, rung.verdict, rung.verdictLabel, rung.sha, rung.agentId]),
    [
      [1, "red", "Gate red", sha1, "agent-peer-1"],
      [2, "green", "Gate green", sha2, "agent-peer-1"],
    ],
  );

  // 3. The Handoff tab — Lead only: the durable rotation state, the locked
  //    mailbox, and the live context ceiling; no other seat offers the tab.
  assert.equal(model.lead.handoff!.rotationState, "handing_over");
  assert.equal(model.lead.handoff!.rotationLabel, "Handing over");
  assert.equal(model.lead.handoff!.mailboxLocked, true);
  assert.equal(model.lead.handoff!.contextUsedTokens, 96_000);
  assert.equal(model.lead.handoff!.contextMaxTokens, 128_000);
  assert.ok(drawerTabsFor(model.lead).includes("handoff"));
  assert.ok(!drawerTabsFor(model.supervisor).includes("handoff"));
  assert.ok(!drawerTabsFor(peer).includes("handoff"));

  // 4. The Resources tab — the rollup's own attribution, the Meter law never
  //    trusting the wire total; the supervisor's empty row set is the honest
  //    absence the tab renders, never an invented zero.
  assert.deepEqual(
    model.lead.usage.map((row) => [row.label, row.meter.totalTokens, row.turns, row.sessionCount, row.meter.totalCostUsd]),
    [["Lead seat", 60_000, 4, 1, 0.5]],
  );
  assert.deepEqual(
    peer.usage.map((row) => [row.label, row.meter.totalTokens]),
    [["Task T-07", 5_000]],
  );
  assert.deepEqual(model.supervisor.usage, []);
  assert.ok(drawerTabsFor(model.supervisor).includes("resources"));

  // 5. Every tab above folded from one pure read — the ledger is byte-for-byte intact.
  assert.equal(factory.ledger.events.length, eventsBefore);
});
