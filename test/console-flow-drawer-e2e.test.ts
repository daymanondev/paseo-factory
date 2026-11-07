import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureProjectRegistered, writeProjectRegistration } from "../plugin/server/projects.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { agentTranscriptViaSidecar } from "../web/src/transcript.ts";
import { drawerTranscriptModel, flowScreenModel } from "../web/src/view-model.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-07b): at least one test drives the Agent
 * Drawer's REAL data path end to end — `web/src/useSnapshot.ts`
 * `loadSnapshotViaSidecar` (the fold the header and the Work tab render) and
 * `web/src/transcript.ts` `agentTranscriptViaSidecar` (the exact client the
 * Transcript tab calls) against a REAL started sidecar over a REAL Factory
 * fixture with ONE registered SLP Project and a fake daemon shaped like the
 * SDK's `agents.list` + `agents.ref(id).timeline.refetch` seams holding the
 * Project's labeled seats. Proves the bounded outcome: the drawer's
 * transcript model carries all three envelope arms over the real transport —
 * the supervisor's reduced tail, the lead's honest wiped-store reason, a
 * stranger's refusal — and the read never writes.
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

/** One page of the daemon's projected timeline, keyed by agent id. */
interface TimelinePage {
  entries?: { seqEnd?: number; item?: unknown }[];
  error?: string | null;
}

/** A fake daemon shaped exactly like the SDK call paths the snapshot and the transcript walk. */
function seatsDaemon(agents: SurfaceAgentSnapshot[], timelines: Record<string, TimelinePage>): SurfaceDaemonApi {
  return {
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })) }),
      create: async () => ({ id: "unused" }),
      ref: (id: string) => ({
        send: async () => {},
        archive: async () => ({ archivedAt: new Date().toISOString() }),
        timeline: {
          // The SDK's projected items carry richer shapes (`detail` objects)
          // than the API's structural slice types — cast at the seam, the
          // same law `SurfaceDaemonApi` itself states ("SDK types stay out").
          refetch: async (_options?: { direction?: "tail"; limit?: number }) =>
            (timelines[id] ?? { entries: [], error: null }) as {
              entries?: { seqEnd?: number; item?: { type?: string; text?: string } }[];
              error?: string | null;
            },
        },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
    },
  };
}

test("RG-1: the console's real transport drives the Agent Drawer — the Work fold and the transcript's three envelope arms", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose live seats open the drawer.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";
  // The fake daemon's three labeled seats — supervisor (with a measured
  // tail), lead with the 128k sensor's live usage slice but a wiped timeline
  // store, and one working peer — all scoped to the slug.
  const daemon = seatsDaemon(
    [
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
    ],
    {
      "agent-sup-1": {
        entries: [
          { seqEnd: 1, item: { type: "user_message", text: "Dispatch T-07 to the working peer." } },
          { seqEnd: 2, item: { type: "tool_call", detail: { type: "shell", command: "factory ledger tail", exitCode: 0, output: "claim_reported T-07" } } },
          { seqEnd: 3, item: { type: "assistant_message", text: "The claim is stamped — watching the gate." } },
        ],
        error: null,
      },
    },
  );
  const fixture = makeConsoleFixture(homeRoot, { registry: true, daemon });
  const registered = ensureProjectRegistered(fixture.stateDir, { root: repo, slug });
  assert.equal(registered.ok, true);
  assert.ok(fixture.registry !== undefined, "the fixture wires the per-Project registry");
  // The seat bindings the transcript door's own scope reads (`project.json`)
  // — the same registration a started Project holds, so the labeled
  // supervisor and lead are Factory-known, never strangers.
  writeProjectRegistration(fixture.stateDir, slug, { root: repo, supervisor: "agent-sup-1", lead: "agent-lead-1" });
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // The Project's own Factory holds the contracted Task — the `claim_reported`
  // agent stamp is the ledger's own attribution of the working Peer, and the
  // attempt it closed is the Work tab's Attempt count.
  const workspace = join(homeRoot, "T-07-ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);
  const factory = fixture.registry.factoryForProject(slug);
  factory.setContract({ task: "T-07", workspace, gate: "npm test", artifact: "src/format.ts" });
  factory.ledger.append({ event: "claim_reported", task: "T-07", attempt: 1, sha, agent: "agent-peer-1" });
  factory.ledger.append({ event: "gate_finished", task: "T-07", attempt: 1, exit: 0, verdict: "green", note: "passed" });
  factory.ledger.append({ event: "report_written", task: "T-07", attempt: 1, path: "report-T-07-1.md" });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // 1. The drawer's header and Work tab fold from the real scoped snapshot —
  //    live seats, lanes, the Lead's telemetry, the Peer's chip with its
  //    Attempt count, and every seat the drawer may open for.
  const eventsBefore = factory.ledger.events.length;
  const snapshot = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
  const model = flowScreenModel(snapshot.view);
  assert.ok(model !== null, "a scoped read folds the graph the drawer opens from");
  assert.equal(model.mode, "slp");
  for (const seat of [model.supervisor, model.lead, ...model.peers]) {
    assert.ok(seat.agentId !== null, `${seat.title} is a live node — the drawer opens for it`);
  }
  assert.equal(model.supervisor.agentId, "agent-sup-1");
  assert.equal(model.supervisor.laneLabel, "pi · z-sup");
  assert.equal(model.lead.contextLabel, "40k / 128k");
  assert.equal(model.lead.queuedMailCount, 0);
  assert.deepEqual(model.peers[0]!.tasks.map((chip) => [chip.task, chip.statusLabel, chip.attemptCount]), [["T-07", "ready to accept", 1]]);

  // 2. The Transcript tab's entries arm over the real transport — the labeled
  //    supervisor's tail reduced to the drawer's model, roles and texts verbatim.
  const supReply = await agentTranscriptViaSidecar({ agent: model.supervisor.agentId! }, fetchAt);
  const supModel = drawerTranscriptModel(supReply);
  assert.equal(supModel.phase, "entries");
  if (supModel.phase === "entries") {
    assert.equal(supModel.entries.length, 3);
    assert.deepEqual(supModel.entries[0], { seq: 1, role: "user", kind: "user_message", text: "Dispatch T-07 to the working peer.", tool: null, summary: null });
    assert.equal(supModel.entries[1]!.tool, "shell");
    assert.match(supModel.entries[1]!.summary ?? "", /^tool_call\/shell: factory ledger tail \[exit 0\]/);
    assert.deepEqual(supModel.entries[2], { seq: 3, role: "assistant", kind: "assistant_message", text: "The claim is stamped — watching the gate.", tool: null, summary: null });
  }

  // 3. The unavailable arm — the labeled lead is Factory-known but its wiped
  //    timeline store answers the honest reason, as data.
  const leadReply = await agentTranscriptViaSidecar({ agent: model.lead.agentId! }, fetchAt);
  const leadModel = drawerTranscriptModel(leadReply);
  assert.equal(leadModel.phase, "unavailable");
  if (leadModel.phase === "unavailable") assert.match(leadModel.reason, /a restart wiped the in-memory store/);

  // 4. The refusal arm — a stranger id the Factory never attributed refuses
  //    as data, and the drawer's model carries the code and sentence verbatim.
  const stranger = await agentTranscriptViaSidecar({ agent: "agent-stranger" }, fetchAt);
  const strangerModel = drawerTranscriptModel(stranger);
  assert.equal(strangerModel.phase, "failure");
  if (strangerModel.phase === "failure") {
    assert.equal(strangerModel.code, "unknown-agent");
    assert.match(strangerModel.error, /not attributed to any Task Attempt or Project seat/);
  }

  // 5. Every arm above was a pure read — the ledger is byte-for-byte intact.
  assert.equal(factory.ledger.events.length, eventsBefore);
});
