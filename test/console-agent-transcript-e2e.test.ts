import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { agentTranscriptViaSidecar } from "../web/src/transcript.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-04): at least one test drives the console's
 * REAL transcript read — `web/src/transcript.ts` `agentTranscriptViaSidecar`,
 * the exact function the Task Detail disclosure calls — against a REAL
 * started sidecar over a REAL Factory fixture, with a fake daemon shaped
 * like the SDK's `agents.ref(id).timeline.refetch` seam. It proves the
 * bounded outcome end to end: a Factory-known Attempt agent's tail reduces
 * to readable plain data, a stranger id refuses as `unknown-agent` data, a
 * wiped daemon store and a daemon error answer as honest unavailable data,
 * and an uncaptured PaseoApi never throws.
 */

/** One page of the daemon's projected timeline, keyed by agent id. */
interface TimelinePage {
  entries?: { seqEnd?: number; item?: unknown }[];
  error?: string | null;
}

/** A fake daemon shaped exactly like the SDK call path the handler walks — the `emptyDaemon` slice plus real timeline pages. */
function timelineDaemon(timelines: Record<string, TimelinePage>): SurfaceDaemonApi {
  return {
    agents: {
      list: async () => ({ entries: [] }),
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

test("RG-1: the console's real transport reads an Attempt agent's transcript — reduced tail, stranger refusal, honest unavailable arms", async (t) => {
  const homeRoot = makeTempDir();
  // The fake daemon's timeline store: agent-peer-7's measured tail (the
  // message/tool/message cadence of a real Attempt), a wiped store for
  // agent-peer-wiped, and a daemon error for agent-peer-errored.
  const daemon = timelineDaemon({
    "agent-peer-7": {
      entries: [
        { seqEnd: 1, item: { type: "user_message", text: "Claim T-04 and run the gate." } },
        {
          seqEnd: 2,
          item: { type: "tool_call", detail: { type: "shell", command: "npm test", exitCode: 0, output: "ok 2 tests" } },
        },
        { seqEnd: 3, item: { type: "assistant_message", text: "The gate is green — committing." } },
      ],
      error: null,
    },
    "agent-peer-wiped": { entries: [], error: null },
    "agent-peer-errored": { entries: [], error: "not found" },
  });
  const fixture = makeConsoleFixture(homeRoot, { daemon });

  // The Task's real git workspace and ledger — the `claim_reported.agent`
  // stamps are the Factory's own attribution of each Attempt's Peer, and a
  // second task stamps the wiped/errored strangers' known peers.
  const workspace = join(homeRoot, "T-04-ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);
  const factory = fixture.factory;
  factory.setContract({ task: "T-04", workspace, gate: "npm test", artifact: "src/format.ts" });
  factory.ledger.append({ event: "claim_reported", task: "T-04", attempt: 1, sha, agent: "agent-peer-7" });
  factory.setContract({ task: "T-05", workspace, gate: "npm test", artifact: "src/format.ts" });
  factory.ledger.append({ event: "claim_reported", task: "T-05", attempt: 1, sha, agent: "agent-peer-wiped" });
  factory.setContract({ task: "T-06", workspace, gate: "npm test", artifact: "src/format.ts" });
  factory.ledger.append({ event: "claim_reported", task: "T-06", attempt: 1, sha, agent: "agent-peer-errored" });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });
  const atSidecar = fixture.atSidecar(started.sidecar);

  // 1. The known Attempt agent's tail reduces to plain data over the real
  //    transport — roles, texts, the tool call's name and compact line.
  const eventsBefore = factory.ledger.events.length;
  const reply = await agentTranscriptViaSidecar({ agent: "agent-peer-7" }, atSidecar);
  assert.ok(reply.ok, reply.ok ? "" : `${reply.code}: ${reply.error}`);
  assert.ok(!("unavailable" in reply));
  assert.equal(reply.agent, "agent-peer-7");
  assert.equal(reply.entries.length, 3);
  assert.deepEqual(reply.entries[0], { seq: 1, role: "user", kind: "user_message", text: "Claim T-04 and run the gate.", tool: null, summary: null });
  assert.deepEqual(reply.entries[1], {
    seq: 2,
    role: "tool",
    kind: "tool_call",
    text: null,
    tool: "shell",
    summary: "tool_call/shell: npm test [exit 0] out: ok 2 tests",
  });
  assert.deepEqual(reply.entries[2], { seq: 3, role: "assistant", kind: "assistant_message", text: "The gate is green — committing.", tool: null, summary: null });

  // 2. A stranger id refuses as data before any daemon call — the scope
  //    door's own vocabulary, riding HTTP 200 with the Failure union.
  const stranger = await agentTranscriptViaSidecar({ agent: "agent-stranger" }, atSidecar);
  assert.ok(stranger.ok === false);
  assert.equal(stranger.ok === false && stranger.code, "unknown-agent");
  assert.match(stranger.ok === false ? stranger.error : "", /not attributed to any Task Attempt or Project seat/);

  // 3. A wiped daemon store (an agent the Factory knows, the timeline empty)
  //    answers as unavailable data — the honest reason, never a throw.
  const wiped = await agentTranscriptViaSidecar({ agent: "agent-peer-wiped" }, atSidecar);
  assert.ok(wiped.ok);
  assert.ok("unavailable" in wiped && wiped.unavailable === true);
  assert.match("unavailable" in wiped ? wiped.reason : "", /a restart wiped the in-memory store/);

  // 4. A daemon error string rides the same honest arm.
  const errored = await agentTranscriptViaSidecar({ agent: "agent-peer-errored" }, atSidecar);
  assert.ok(errored.ok);
  assert.ok("unavailable" in errored && errored.unavailable === true);
  assert.match("unavailable" in errored ? errored.reason : "", /the daemon answered: not found/);

  // 5. The read never writes: the ledger is byte-for-byte what the fixture
  //    left — every transcript arm above was a pure read.
  assert.equal(factory.ledger.events.length, eventsBefore);
});

test("RG-1: no PaseoApi captured — the handler answers unavailable data, never a throw", async () => {
  const homeRoot = makeTempDir();
  // The production wiring's exact shape (`plugin/index.server.ts`): the
  // daemon capture is a function returning undefined until a lifecycle hook
  // fires. The transcript must say so honestly.
  const fixture = makeConsoleFixture(homeRoot, { daemon: () => undefined as never });
  const factory = fixture.factory;
  const workspace = join(homeRoot, "T-04b-ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);
  factory.setContract({ task: "T-04b", workspace, gate: "npm test", artifact: "src/format.ts" });
  factory.ledger.append({ event: "claim_reported", task: "T-04b", attempt: 1, sha, agent: "agent-peer-7" });
  try {
    const reply = await fixture.handlers.agentTranscript({ agent: "agent-peer-7" });
    assert.ok(reply.ok);
    assert.ok("unavailable" in reply && reply.unavailable === true);
    assert.match("unavailable" in reply ? reply.reason : "", /captured no PaseoApi/);
  } finally {
    rmSync(homeRoot, { recursive: true, force: true });
  }
});
