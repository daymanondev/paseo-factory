import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureProjectRegistered } from "../plugin/server/projects.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { flowScreenModel } from "../web/src/view-model.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-07a): at least one test drives the console's
 * REAL snapshot read — `web/src/useSnapshot.ts` `loadSnapshotViaSidecar`,
 * the exact function the browser bundle calls — against a REAL started
 * sidecar over a REAL Factory fixture with ONE registered SLP Project and
 * a fake daemon shaped like the SDK's `agents.list` seam holding the
 * Project's labeled seats. Proves the bounded outcome end to end: the
 * Workspace fold renders the live authority graph from the snapshot alone
 * — each seat's live state and lane, the Lead's context telemetry, the
 * Peer's ledger-bound Task chip — and an unscoped read answers the
 * screen's honest null, never a fabricated graph.
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

/** A fake daemon shaped exactly like the SDK call path the snapshot walks — the `emptyDaemon` slice plus the Project's own seats. */
function seatsDaemon(agents: SurfaceAgentSnapshot[]): SurfaceDaemonApi {
  return {
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })) }),
      create: async () => ({ id: "unused" }),
      ref: (id: string) => ({
        send: async () => {},
        archive: async () => ({ archivedAt: new Date().toISOString() }),
        timeline: { refetch: async () => ({ entries: [], error: null }) },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
    },
  };
}

test("RG-1: the console's real transport folds the Workspace's SLP authority graph — live seats, the Peer's Task chip, honest null unscoped", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose authority graph the screen folds.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  // The fake daemon's three labeled seats — supervisor, lead (with the 128k
  // sensor's live usage slice), and one working peer, all scoped to the slug.
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
      lastUsage: { contextWindowUsedTokens: 40_000, contextWindowMaxTokens: 128_000 },
    }),
    fakeAgent({ id: "agent-peer-1", title: "Peer 1", status: "running", model: "z-dev", labels: { seat: "agent", project: slug }, cwd: repo }),
  ]);
  const fixture = makeConsoleFixture(homeRoot, { registry: true, daemon });
  // The system's own slug law (`resolveProject`): `<basename>-<hash>` — the
  // same slug the scoped snapshot resolves from projectRoot, so the
  // registration, the labeled seats, and the ledger all name ONE Project.
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug });
  assert.equal(registered.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // The Project's own Factory holds the contracted Task — the `claim_reported`
  // agent stamp is the ledger's own attribution of the working Peer.
  const workspace = join(homeRoot, "T-07-ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);
  const factory = fixture.registry.factoryForProject(slug);
  factory.setContract({ task: "T-07", workspace, gate: "npm test", artifact: "src/format.ts" });
  factory.ledger.append({ event: "claim_reported", task: "T-07", attempt: 1, sha, agent: "agent-peer-1" });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // The scoped read through the real transport: the fold renders the Project's
  // authority graph — live seats, lanes, the Lead's telemetry, the Peer's chip.
  const eventsBefore = factory.ledger.events.length;
  const snapshot = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
  assert.equal(snapshot.view.project?.slug, slug);
  const model = flowScreenModel(snapshot.view);
  assert.ok(model !== null, "a scoped read folds the graph — never the unscoped null");
  assert.equal(model.mode, "slp");
  assert.equal(model.supervisor.agentId, "agent-sup-1");
  assert.equal(model.supervisor.state.label, "Live");
  assert.equal(model.supervisor.laneLabel, "pi · z-sup");
  assert.equal(model.lead.agentId, "agent-lead-1");
  assert.equal(model.lead.state.label, "Live");
  assert.equal(model.lead.contextLabel, "40k / 128k");
  assert.deepEqual(
    model.peers.map((peer) => [peer.agentId, peer.title, peer.state.label]),
    [["agent-peer-1", "Peer 1", "Live"]],
  );
  assert.deepEqual(model.peers[0]!.tasks.map((chip) => [chip.task, chip.statusLabel]), [["T-07", "running"]]);
  assert.equal(model.scrum, null, "an SLP Project carries no Scrum strip");
  // The read never writes: the ledger is byte-for-byte what the fixture left.
  assert.equal(factory.ledger.events.length, eventsBefore);

  // The unscoped read through the same transport: no Project selected — the
  // fold answers the screen's own empty state, never a fabricated graph.
  const global = await loadSnapshotViaSidecar({}, fetchAt);
  assert.equal(global.ok, true, global.ok ? "" : global.error);
  assert.equal(flowScreenModel(global.view), null);
});
