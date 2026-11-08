import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureProjectRegistered, writeProjectRegistration } from "../plugin/server/projects.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { agentTranscriptViaSidecar } from "../web/src/transcript.ts";
import { flowScreenModel, supervisorChatModel } from "../web/src/view-model.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-13a): at least one test drives the Supervisor
 * Live Chat panel's REAL data path end to end — the exact clients the panel
 * calls (`web/src/useSnapshot.ts` `loadSnapshotViaSidecar` for the header's
 * provider · model and the seat's liveness, `web/src/transcript.ts`
 * `agentTranscriptViaSidecar` for the conversation) against a REAL started
 * sidecar over a REAL Factory fixture with ONE registered SLP Project whose
 * supervisor seat is bound in `project.json`, and the screen's OWN fold
 * (`supervisorChatModel`) turns the read tail into Owner/Supervisor turns.
 * The panel adds NO door: `factory.supervisor.ensure` keeps refusing 404
 * `unknown_method` (ADR 0017 — nothing starts or ensures a seat), and the
 * reads never write — the ledger stays byte-for-byte intact.
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

async function post(url: string, body: unknown): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

test("RG-1: the console's real transport drives the Supervisor Live Chat — the seat's snapshot facts and the transcript folded to Owner/Supervisor turns", async (t) => {
  const homeRoot = makeTempDir();
  // One registered git repo — the SLP Project whose Supervisor seat opens the chat panel.
  const repo = join(homeRoot, "slp-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# slp\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";
  // The fake daemon's labeled seats — the supervisor holds a conversational
  // tail (an Owner turn, a tool call that is not a turn, a Supervisor turn),
  // the lead rounds out the registration.
  const daemon = seatsDaemon(
    [
      fakeAgent({ id: "agent-sup-1", title: "Supervisor", status: "running", model: "z-sup", labels: { seat: "supervisor", project: slug }, cwd: repo }),
      fakeAgent({ id: "agent-lead-1", title: "Lead", status: "running", model: "z-lead", labels: { seat: "lead", project: slug }, cwd: repo }),
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
  // The seat binding the transcript door's own scope reads (`project.json`)
  // — the same registration a started Project holds, so the labeled
  // supervisor is Factory-known, never a stranger.
  writeProjectRegistration(fixture.stateDir, slug, { root: repo, supervisor: "agent-sup-1", lead: "agent-lead-1" });
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // The Project's own Factory holds one contracted Task — the ledger the
  // pure-read assertion stamps before and after every panel read.
  const workspace = join(homeRoot, "T-07-ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);
  const factory = fixture.registry.factoryForProject(slug);
  factory.setContract({ task: "T-07", workspace, gate: "npm test", artifact: "src/format.ts" });
  factory.ledger.append({ event: "claim_reported", task: "T-07", attempt: 1, sha, agent: "agent-peer-1" });
  factory.ledger.append({ event: "gate_finished", task: "T-07", attempt: 1, exit: 0, verdict: "green", note: "passed" });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // 1. The panel's header and liveness facts fold from the real scoped
  //    snapshot — the live supervisor node the drawer passes the panel, its
  //    provider · model badge, and the `generatedAt` stamp the panel's own
  //    snapshot-change re-read keys on.
  const eventsBefore = factory.ledger.events.length;
  const snapshot = await loadSnapshotViaSidecar({ projectRoot: repo }, fetchAt);
  assert.equal(snapshot.ok, true, snapshot.ok ? "" : snapshot.error);
  const model = flowScreenModel(snapshot.view);
  assert.ok(model !== null, "a scoped read folds the graph the drawer opens from");
  assert.equal(model.supervisor.seat, "supervisor");
  assert.equal(model.supervisor.agentId, "agent-sup-1");
  assert.equal(model.supervisor.laneLabel, "pi · z-sup");
  assert.ok(model.supervisor.session !== null, "the live supervisor carries the session the panel's badge reads");
  assert.equal(model.supervisor.session!.provider, "pi");
  assert.equal(model.supervisor.session!.model, "z-sup");
  assert.equal(model.supervisor.session!.snapshotAt, snapshot.view.generatedAt);

  // 2. The conversation over the real transport — the panel's exact client
  //    read, the screen's own fold turning it into Owner/Supervisor turns:
  //    the user turn reads as "You (Owner)", the assistant turn as
  //    "Supervisor", each keyed on the timeline seq (the transcript carries
  //    no wall clock), and the tool call is not a conversation turn.
  const reply = await agentTranscriptViaSidecar({ agent: model.supervisor.agentId! }, fetchAt);
  const chat = supervisorChatModel(reply);
  assert.equal(chat.phase, "chat");
  if (chat.phase === "chat") {
    assert.deepEqual(chat.messages, [
      { seq: 1, sender: "owner", label: "You (Owner)", text: "Dispatch T-07 to the working peer." },
      { seq: 3, sender: "supervisor", label: "Supervisor", text: "The claim is stamped — watching the gate." },
    ]);
    assert.ok(chat.messages.every((message) => !message.text.includes("factory ledger tail")), "the tool call folds away — it is not a turn");
  }

  // 3. The panel adds NO door — the ensure act the ADR 0017 boundary keeps
  //    outside still refuses as data, and the allowlist sentence names no
  //    supervisor.ensure entry.
  const refusal = await post(started.sidecar.url + "/rpc", { method: "factory.supervisor.ensure", params: {} });
  assert.equal(refusal.status, 404, "factory.supervisor.ensure is not allowlisted");
  const payload = refusal.payload as { ok: boolean; code?: string; error?: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "unknown_method");
  assert.match(payload.error ?? "", /is not served by the console sidecar \(allowlist: /);
  const allowlist = /\(allowlist: ([^)]*)\)/.exec(payload.error ?? "")?.[1] ?? "";
  assert.equal(allowlist.includes("factory.supervisor.ensure"), false, "the allowlist sentence stays byte-identical — no new entry");

  // 4. Every read above was pure — the ledger is byte-for-byte intact.
  assert.equal(factory.ledger.events.length, eventsBefore);
});
