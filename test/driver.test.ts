import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentFate,
  contractFromLedger,
  GRACE_MS,
  leadDecision,
  observeTasks,
  postSpawnLife,
  prepareWorkspace,
  readDriverLedger,
  RE_STALL_MS,
  renderBrief,
  renderRunBanner,
  repokeText,
  splitProvider,
  taskOutcome,
  verdictOfThisRun,
} from "../plugin/bin/driver.mjs";
import { copyFixture, disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";
import { awaitReply, submit } from "../plugin/bin/spool-client.mjs";

/**
 * `factory run`'s driver — the pure pieces, plus (v0.0.10) the Lead rider's
 * loop wiring against a fake snapshot lane and the REAL spool+factory: the
 * re-poke's one-spend law and the needs-human line are proven through the
 * plugin's own request handling, never a mock of it. The daemon-RPC half
 * (hello, agent.create, snapshot polling) is exercised end to end on the
 * trial home by ticket 04's live runs, not here: a fake daemon would need a
 * WebSocket server, and the zero-dep law keeps one out of the CLIs' world.
 */

test("renderBrief bakes the task and the driver's PATH into the runbook template, verbatim otherwise", () => {
  const brief = renderBrief("live05-driver", "/custom/bin:/usr/bin");

  assert.ok(brief.includes("Do the assigned work on branch `live05-driver`."));
  assert.ok(brief.includes("`factory-claim --task live05-driver --sha <sha>`"));
  assert.ok(brief.includes("If the result is RED: read the note line, fix, make a NEW commit, claim"));
  assert.ok(brief.includes("Never edit tests just to make them green."));
  assert.ok(brief.includes('export\nPATH="/custom/bin:/usr/bin" first.'), "the PATH-export line carries the baked value, not the runbook's hardcoded nvm path");
  assert.ok(!brief.includes("v24.21.0"), "the hardcoded nvm wart is gone");
  assert.ok(!brief.includes("<branch>") && !brief.includes("<task-id>") && !brief.includes("<path>"), "no placeholder survives");
});

test("renderBrief carries the contract's description ahead of the fixed body (the description-slot rider)", () => {
  const withDescription = renderBrief("live06-a", "/custom/bin", "Extract the duplicated ledger read into a shared sibling, plugin/bin/ledger-read.mjs.");
  assert.ok(
    withDescription.startsWith("Task: Extract the duplicated ledger read into a shared sibling, plugin/bin/ledger-read.mjs.\n\n"),
    "the assignment rides first, the fixed body follows unchanged",
  );
  assert.ok(withDescription.includes("Do the assigned work on branch `live06-a`."), "the fixed body is intact below the header");

  // No description: byte-identical to v0.0.5's brief.
  assert.equal(renderBrief("live06-a", "/custom/bin"), renderBrief("live06-a", "/custom/bin", undefined));
});

test("splitProvider takes provider[/model] on the first slash", () => {
  assert.deepEqual(splitProvider("claude"), { provider: "claude", model: undefined });
  assert.deepEqual(splitProvider("claude/opus-4-8"), { provider: "claude", model: "opus-4-8" });
});

test("renderRunBanner echoes the invocation's provider exactly once", () => {
  assert.equal(renderRunBanner(["T1"], "claude"), "factory: run T1 (n=1) — provider claude");
  assert.equal(renderRunBanner(["T1", "T2"], "copilot/gpt-5.4"), "factory: run T1 T2 (n=2) — provider copilot/gpt-5.4");
});

test("readDriverLedger: missing ledger is empty, an unterminated tail is ignored, junk refuses", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");

  assert.deepEqual(readDriverLedger(stateDir), [], "no ledger yet — the plugin has never run");

  mkdirSync(stateDir, { recursive: true });
  const good = JSON.stringify({ seq: 1, ts: "2026-10-09T09:00:00.000Z", event: "contract_set", task: "T1", workspace: "/w", gate: "true", artifact: "a" });
  writeFileSync(join(stateDir, "ledger.jsonl"), `${good}\n{"seq":2,"ts":"2026-10-09T09`);
  assert.equal(readDriverLedger(stateDir).length, 1, "the unacknowledged tail never happened");

  writeFileSync(join(stateDir, "ledger.jsonl"), `${good}\nnot json\n`);
  assert.throws(() => readDriverLedger(stateDir), /not valid JSON/);
});

test("the driver's ledger views: the contract for pre-spawn, the outcome for the verdict line", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const ts = "2026-10-09T09:00:00.000Z";
  const events = [
    { seq: 1, ts, event: "spawn_dispatched", task: "D1", provider: "claude", arity: 2 },
    { seq: 2, ts, event: "contract_set", task: "D1", workspace: "/ws/one", gate: "npm test", artifact: "src/x.ts", scope: ["src"], description: "Fix the pad helper." },
    { seq: 3, ts, event: "claim_reported", task: "D1", attempt: 1, sha: "a1b2c3d", agent: "ag-1" },
    { seq: 4, ts, event: "gate_finished", task: "D1", attempt: 1, exit: 1, verdict: "red", note: "fail", sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" },
    { seq: 5, ts, event: "report_written", task: "D1", attempt: 1, path: "/s/report-D1-1.md" },
    { seq: 6, ts, event: "permit_allowed", task: "D1", agent: "ag-1", name: "Bash", kind: "tool", command: "npm test" },
    { seq: 7, ts, event: "permit_denied", task: "D1", agent: "ag-1", name: "Bash", kind: "tool", command: "git push --force", rule: "policy:S1", reason: "r" },
    { seq: 8, ts, event: "claim_reported", task: "D1", attempt: 2, sha: "f1e2d3c", agent: "ag-1" },
    { seq: 9, ts, event: "gate_finished", task: "D1", attempt: 2, exit: 0, verdict: "green", note: "", sha: "f1e2d3c4b5a6987654321f0e1d2c3b4a5f6e7d8" },
    { seq: 10, ts, event: "report_written", task: "D1", attempt: 2, path: "/s/report-D1-2.md" },
    { seq: 11, ts, event: "git_blocked", task: "D1", command: "git reset --hard", rule: "git:reset-hard", reason: "r", cwd: "/ws/one", blockId: "b1" },
    { seq: 12, ts, event: "spawn_refused", task: "D2", provider: "claude", arity: 2, rule: "spawn:scope-mandatory", reason: "no scope" },
  ];

  const contract = contractFromLedger(events, "D1");
  assert.equal(contract?.workspace, "/ws/one");
  assert.equal(contract?.description, "Fix the pad helper.", "the driver reads the assignment from the contract line (the rider's source)");
  assert.equal(contractFromLedger(events, "NOPE"), undefined);

  const outcome = taskOutcome(events, "D1");
  assert.equal(outcome.attempt, 2, "the last attempt on record");
  assert.equal(outcome.verdict, "green");
  assert.equal(outcome.sha?.slice(0, 7), "f1e2d3c");
  assert.equal(outcome.reportPath, "/s/report-D1-2.md");
  assert.deepEqual([outcome.allowed, outcome.denied, outcome.blocked], [1, 1, 1], "the choke counts the verdict line prints");
  assert.equal(outcome.accepted, false);
});

test("prepareWorkspace: clean tree gets the task's branch, re-run switches to it, dirty or missing refuses", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);

  const first = prepareWorkspace(workspace, "live05-a");
  assert.deepEqual(first, { ok: true, branchExisted: false });
  const again = prepareWorkspace(workspace, "live05-a");
  assert.deepEqual(again, { ok: true, branchExisted: true }, "a re-run switches to the existing branch instead of failing");

  writeFileSync(join(workspace, "src", "format.ts"), "export const dirty = 1;\n");
  const dirty = prepareWorkspace(workspace, "live05-b");
  assert.equal(dirty.ok, false);
  if (!dirty.ok) assert.match(dirty.reason, /tree not clean/);

  const missing = prepareWorkspace(join(dir, "not-there"), "live05-c");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /does not exist/);
});

test("agentFate reads a snapshot the way ticket 03 §5 settled it", () => {
  assert.deepEqual(agentFate({ status: "running", pendingPermissions: [] }), { terminal: false });
  assert.deepEqual(agentFate({ status: "initializing" }), { terminal: false });
  assert.deepEqual(agentFate({ status: "idle", attentionReason: "finished", pendingPermissions: [] }), { terminal: true, fate: "finished" });
  assert.deepEqual(
    agentFate({ status: "idle", attentionReason: undefined, lastUserMessageAt: "2026-10-09T09:00:00.000Z", pendingPermissions: [] }),
    { terminal: true, fate: "finished" },
    "idle with the prompt consumed and nothing pending counts as finished even when attention was cleared elsewhere",
  );
  assert.deepEqual(agentFate({ status: "idle", attentionReason: "permission", pendingPermissions: [{ id: "p1" }] }), { terminal: false }, "parked on an ask — the choke answers, the driver waits");
  const died = agentFate({ status: "error", lastError: "provider exploded" });
  assert.equal(died.terminal && died.fate, "died");
  if (died.terminal) assert.match(died.reason ?? "", /provider exploded/);
  const closed = agentFate({ status: "closed" });
  assert.equal(closed.terminal && closed.fate, "closed");
});

test("DaemonRpc routes a response to its waiter by requestId AND response type (the E2E regression)", async () => {
  const { DaemonRpc, DaemonConnectionError } = await import("../plugin/bin/driver.mjs");
  const rpc = new DaemonRpc("/no-home-needed");
  const sent: string[] = [];
  // A fake OPEN socket: connect() is bypassed, only the request/deliver seam runs.
  const asInner = rpc as unknown as { ws: unknown; deliver(msg: unknown): void };
  asInner.ws = { readyState: 1, send: (frame: string) => sent.push(frame) };

  const pending = rpc.request({ type: "probe.request" }, { responseType: "probe.response", timeoutMs: 5_000 });

  // An update-style frame with no requestId of ours, then the wrong type, then
  // the right one — only the last may settle the waiter.
  const requestId = (JSON.parse(sent[0]) as { message: { requestId: string } }).message.requestId;
  asInner.deliver({ type: "probe.update", payload: { idempotencyKey: "k" } });
  asInner.deliver({ type: "other.response", payload: { requestId } });
  asInner.deliver({ type: "probe.response", payload: { requestId, value: 42 } });

  assert.deepEqual(await pending, { requestId, value: 42 });

  // rpc_error rejects with its code attached.
  const failing = rpc.request({ type: "probe.request" }, { responseType: "probe.response", timeoutMs: 5_000 });
  const failingId = (JSON.parse(sent[1]) as { message: { requestId: string } }).message.requestId;
  asInner.deliver({ type: "rpc_error", payload: { requestId: failingId, error: "nope", code: "agent_request_key_conflict" } });
  await assert.rejects(failing, (err: unknown) => err instanceof Error && (err as { code?: string }).code === "agent_request_key_conflict");

  // A socket death rejects whatever is still pending.
  const hanging = rpc.request({ type: "probe.request" }, { responseType: "probe.response", timeoutMs: 60_000 });
  rpc.rejectAllPending(new DaemonConnectionError("test close"));
  await assert.rejects(hanging, DaemonConnectionError);
  rpc.close();
});

// ---- the Lead rider (v0.0.10, ticket 03): the predicate table, then the loop wiring ----

test("repokeText is the design's fixed template — only the task and the denial's rule interpolate", () => {
  assert.equal(
    repokeText("lead1-a", "policy:S1-git-vocabulary"),
    "Your permit ask for task lead1-a was denied (rule policy:S1-git-vocabulary). The turn ended without a Claim. " +
      "Continue by a route that needs no denied permission and make your Claim — or end your turn stating what you need from the Owner.",
  );
  assert.equal(GRACE_MS, 30_000, "the denial-stall grace is fixed in code, not configuration (design §1)");
  assert.equal(RE_STALL_MS, 10 * 60_000, "the re-stall window rides the STALL_WARN precedent's size (design §3)");
});

/** One task's slice, seqs in order, ts as offsets from a fixed now. */
function slice(entries: [string, number][], task = "T1", extra: Record<string, unknown> = {}): Record<string, unknown>[] {
  const NOW = Date.parse("2026-10-12T12:00:00.000Z");
  return entries.map(([event, tsOffset], i) => ({
    seq: i + 1,
    ts: new Date(NOW + tsOffset).toISOString(),
    event,
    task,
    ...extra,
  }));
}

test("leadDecision's true/false table — the denial-stall predicate and its two named ends (design §1 + §3)", () => {
  const NOW = Date.parse("2026-10-12T12:00:00.000Z");

  // TRUE: the last task event is a denial, grace spent, no poke yet.
  const stall = slice([
    ["contract_set", -90_000],
    ["spawn_dispatched", -80_000],
    ["permit_denied", -60_000],
  ]);
  const poke = leadDecision(stall, "T1", NOW);
  assert.equal(poke.act, "poke", "a denial in last position past the grace spends the poke");
  if (poke.act === "poke") assert.equal(poke.denial.seq, 3, "the poke answers the denial in last position");

  // FALSE: grace not yet spent.
  assert.equal(leadDecision(slice([["permit_denied", -10_000]]), "T1", NOW).act, "watch", "the grace window is pending");

  // FALSE: an absorbed denial — the agent continued to an allowed ask.
  assert.equal(
    leadDecision(slice([["permit_denied", -60_000], ["permit_allowed", -50_000]]), "T1", NOW).act,
    "clear",
    "an absorbed denial is displaced from last position",
  );

  // FALSE: spawn-then-silence — no denial evidence at all (the later row's lane).
  assert.equal(leadDecision(slice([["spawn_dispatched", -60_000]]), "T1", NOW).act, "clear");

  // FALSE: post-claim denial — a claim after the denial displaces it.
  assert.equal(
    leadDecision(slice([["permit_denied", -60_000], ["claim_reported", -50_000]]), "T1", NOW).act,
    "clear",
    "post-claim denials fail the claim test (design §1's own negative)",
  );

  // The meter line never displaces a denial (design §1's ignore set).
  assert.equal(leadDecision(slice([["permit_denied", -60_000], ["meter_written", -40_000]]), "T1", NOW).act, "poke");

  // Poke spent, denial still last, within the re-stall window → hold.
  const within = slice([["permit_denied", -9 * 60_000], ["repoke_dispatched", -8 * 60_000]]);
  assert.equal(leadDecision(within, "T1", NOW).act, "watch", "the re-stall window is pending");

  // Poke spent, silence since it past RE_STALL_MS → silent-after-repoke.
  const silent = leadDecision(slice([["permit_denied", -12 * 60_000], ["repoke_dispatched", -11 * 60_000]]), "T1", NOW);
  assert.equal(silent.act, "needs-human");
  if (silent.act === "needs-human") {
    assert.equal(silent.reason, "silent-after-repoke");
    assert.deepEqual(silent.evidence, { denial: 1, repoke: 2 }, "the evidence names the stall's denial and the spend");
  }

  // A NEW denial after the spend, grace spent on it → denied-again.
  const again = leadDecision(
    slice([["permit_denied", -12 * 60_000], ["repoke_dispatched", -11 * 60_000], ["permit_denied", -60_000]]),
    "T1",
    NOW,
  );
  assert.equal(again.act, "needs-human");
  if (again.act === "needs-human") {
    assert.equal(again.reason, "denied-again");
    assert.deepEqual(again.evidence, { denial: 3, repoke: 2 }, "the evidence names the NEW denial and the spend");
  }

  // The same shape inside the new denial's grace → hold.
  assert.equal(
    leadDecision(slice([["permit_denied", -12 * 60_000], ["repoke_dispatched", -11 * 60_000], ["permit_denied", -10_000]]), "T1", NOW).act,
    "watch",
  );

  // Activity after the poke (a claim, an ask) closes the Lead's window — the
  // answer arrived, ordinary classification proceeds.
  assert.equal(
    leadDecision(slice([["permit_denied", -60_000], ["repoke_dispatched", -50_000], ["claim_reported", -40_000]]), "T1", NOW).act,
    "clear",
    "the poke worked — a claim after it is the Lead's all-clear",
  );
  assert.equal(
    leadDecision(slice([["permit_denied", -60_000], ["repoke_dispatched", -50_000], ["permit_allowed", -40_000]]), "T1", NOW).act,
    "clear",
    "an ask after the poke is activity too — and activity-then-silence stays the later row's lane in v1",
  );

  // A refusal does not spend: the refusal line is ignored, the ask stands.
  assert.equal(leadDecision(slice([["permit_denied", -60_000], ["repoke_refused", -50_000]]), "T1", NOW).act, "poke");

  // Another task's events never enter the slice.
  const mine = slice([["permit_denied", -60_000]]);
  const withTheirs = [...mine, { seq: 9, ts: new Date(NOW - 30_000).toISOString(), event: "permit_allowed", task: "OTHER" }];
  assert.equal(leadDecision(withTheirs, "T1", NOW).act, "poke", "the predicate is task-scoped");
});

test("postSpawnLife and verdictOfThisRun — the death fix's ledger arithmetic and the null lane's finish signal", () => {
  const spawnOnly = slice([["contract_set", -90_000], ["spawn_dispatched", -80_000]]);
  assert.equal(postSpawnLife(spawnOnly, "T1"), false, "spawn-then-silence: zero post-spawn evidence of life");
  assert.equal(
    postSpawnLife(slice([["spawn_dispatched", -80_000], ["meter_written", -40_000]]), "T1"),
    false,
    "the driver's own meter line is not life",
  );
  assert.equal(
    postSpawnLife(slice([["spawn_dispatched", -80_000], ["repoke_dispatched", -40_000]]), "T1"),
    false,
    "the Lead's own lines are not life",
  );
  assert.equal(
    postSpawnLife(slice([["spawn_dispatched", -80_000], ["spawn_refused", -40_000]]), "T1"),
    false,
    "a refused re-invocation is the operator's act, not agent life",
  );
  assert.equal(postSpawnLife(slice([["spawn_dispatched", -80_000], ["permit_denied", -60_000]]), "T1"), true, "a denial is life");
  assert.equal(postSpawnLife(slice([["permit_allowed", -60_000], ["spawn_dispatched", -40_000]]), "T1"), false, "pre-spawn asks do not count — the window anchors at THIS run's spawn");

  const thisRun = verdictOfThisRun(slice([["spawn_dispatched", -80_000], ["gate_finished", -60_000]]), "T1");
  assert.equal((thisRun as { seq?: number } | undefined)?.seq, 2, "a gate_finished after this run's spawn is this run's verdict");
  assert.equal(verdictOfThisRun(slice([["gate_finished", -90_000], ["spawn_dispatched", -80_000]]), "T1"), undefined, "a previous run's verdict is not this run's");
  assert.equal(verdictOfThisRun(spawnOnly, "T1"), undefined, "no verdict yet");
});

/**
 * The loop-wiring harness (v0.0.10): a fake snapshot lane over the REAL
 * spool and factory, so the Lead's two acts run through the plugin's own
 * request handling — the one-spend law and the needs-human line are proven
 * at the protocol, never mocked. The fake rpc answers fetch/send from
 * `respond`/`timeline` callbacks the test mutates; `timeline` is the death
 * oracle's seam (v0.0.11): the probe's three shapes — answering-parked,
 * answering-growing, or the not-found rpc error. The ledger evolves by
 * direct appends at the seams the live system would fill (the choke's
 * denial, the agent's claim). The window knobs (graceMs, reStallMs,
 * missingDeadMs) are the loop's test seams — the code defaults are the
 * fixed laws.
 */
const stillTimeline = (seqEnd = 45) => (): Record<string, unknown> => ({ requestId: "r", entries: [{ seqEnd }] });
const growingTimeline = (): (() => Record<string, unknown>) => {
  let seqEnd = 44;
  return () => {
    seqEnd += 1;
    return { requestId: "r", entries: [{ seqEnd }] };
  };
};
// The live daemon (0.11) resolves the timeline's failure as an `error` field
// on the response — not an rpc_error envelope. This is the shape the v0.0.11
// judged run witnessed on arm B's delete (ticket 03's central finding): the
// ticket-02 tests pinned the thrown envelope below, and the fast door they
// proved green was unreachable live. The payload seam is the live seam.
const payloadErrorTimeline = (message: string) => (): Record<string, unknown> => ({ requestId: "r", error: message });
const notFoundTimeline = () => payloadErrorTimeline("Agent not found: ag-lead1");
const rpcErrorTimeline = (message: string) => (): Record<string, unknown> => {
  const err = new Error(message) as Error & { rpc: boolean };
  err.rpc = true;
  throw err;
};

async function leadHarness(
  t: TestContext,
  respond: () => Record<string, unknown> | null,
  timeline: () => Record<string, unknown> = stillTimeline(),
) {
  const dir = makeTempDir("paseo-factory-lead-");
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);
  const stateDir = join(dir, "state");
  const { createFactory } = await import("../plugin/server/core/factory.ts");
  const { startSpool, spoolRootFor } = await import("../plugin/server/spool.ts");
  const factory = createFactory({ stateDir });
  factory.setContract({ task: "LEAD1", workspace, gate: "true", artifact: "src/format.ts" });
  factory.requestSpawn({ task: "LEAD1", provider: "claude", arity: 1 });
  const spoolRoot = spoolRootFor(stateDir);
  const spool = startSpool(stateDir, factory, { pollMs: 20 });

  const sent: Record<string, unknown>[] = [];
  let fetches = 0;
  const rpc = {
    connected: true,
    async request(message: Record<string, unknown>) {
      sent.push(message);
      if (message.type === "fetch_agent_request") {
        fetches += 1;
        return { requestId: "r", agent: respond() };
      }
      if (message.type === "fetch_agent_timeline_request") {
        return timeline(); // the oracle's shapes: answers, or the error-named payload the live daemon resolves
      }
      if (message.type === "send_agent_message_request") return { requestId: "r", accepted: true, error: null };
      return { requestId: "r" };
    },
    close() {},
  };
  const denial = (reason: string) =>
    factory.ledger.append({
      event: "permit_denied",
      task: "LEAD1",
      agent: "ag-lead1",
      name: "Bash",
      kind: "tool",
      command: "git reset --hard",
      rule: "policy:S1-git-vocabulary",
      reason,
    });
  const claimGreen = () => {
    factory.ledger.append({ event: "claim_reported", task: "LEAD1", attempt: 1, sha: "a1b2c3d", agent: "ag-lead1" });
    factory.ledger.append({ event: "gate_finished", task: "LEAD1", attempt: 1, exit: 0, verdict: "green", note: "", sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" });
  };
  const processedKinds = (): string[] =>
    readdirSync(join(spoolRoot, "processed"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => (JSON.parse(readFileSync(join(spoolRoot, "processed", name), "utf8")) as { kind: string }).kind)
      .sort();
  return {
    stateDir,
    spoolRoot,
    factory,
    rpc,
    sent,
    denial,
    claimGreen,
    processedKinds,
    get fetches() {
      return fetches;
    },
    stop() {
      spool.stop();
    },
  };
}

test("the amended finished-pin: idle + prompt-consumed + no-pending with a ledger denial-stall pokes instead of finishing silently", async (t) => {
  const harness = await leadHarness(t, () => ({ status: "idle", attentionReason: "finished", pendingPermissions: [] }));
  try {
    // The stall lands on the ledger while the loop classifies idle: the
    // denial's grace is a test window (10ms), so the poke fires on the
    // first or second tick and the finished commit is held from then on.
    harness.denial("caught");
    const terminals: { fate?: string }[] = [];
    const run = observeTasks(harness.rpc, [{ task: "LEAD1", agentId: "ag-lead1" }], {
      pollMs: 10,
      stateDir: harness.stateDir,
      spoolRoot: harness.spoolRoot,
      graceMs: 10,
      log: () => {},
      onTerminal: (entry) => {
        terminals.push({ ...(entry.terminal as { fate?: string }) });
      },
    });

    await until_(() => assert.ok(harness.sent.some((m) => m.type === "send_agent_message_request")), 5000);
    const send = harness.sent.find((m) => m.type === "send_agent_message_request") as { text?: string; messageId?: string };
    assert.equal(send.messageId, "factory-repoke-LEAD1", "the deterministic message id rides the daemon's send receipts");
    assert.equal(send.text, repokeText("LEAD1", "policy:S1-git-vocabulary"), "the fixed text, answering the denial's own rule");
    assert.equal(terminals.length, 0, "a ledger stall is not a silent finish — the commit is held");
    assert.equal(harness.factory.ledger.events.filter((e) => e.event === "repoke_dispatched").length, 1, "exactly one spend through the real spool");

    // The agent takes the allowed route and claims: activity after the poke
    // closes the Lead's window and the ordinary finish proceeds.
    harness.claimGreen();
    await run;
    assert.deepEqual(terminals.map((x) => x.fate), ["finished"]);
    assert.deepEqual(harness.processedKinds(), ["repoke"], "the poke through the real spool — the meter is runDriver's terminal callback, not the loop's");
    assert.equal(harness.factory.ledger.events.filter((e) => e.event === "repoke_refused").length, 0, "no second ask, so no refusal line — idempotency measured across the held ticks, not assumed");
  } finally {
    harness.stop();
  }
});

test("the needs-human terminal (null lane, denied-again): a second denial after the spent poke ends the watch with its evidence on the ledger", async (t) => {
  const harness = await leadHarness(t, () => null, growingTimeline());
  try {
    harness.denial("caught");
    const terminals: { fate?: string; reason?: string }[] = [];
    const run = observeTasks(harness.rpc, [{ task: "LEAD1", agentId: "ag-lead1" }], {
      pollMs: 10,
      stateDir: harness.stateDir,
      spoolRoot: harness.spoolRoot,
      graceMs: 10,
      missingDeadMs: 60, // the timeline grows — the life signal keeps the slow door shut
      log: () => {},
      onTerminal: (entry) => {
        terminals.push({ ...(entry.terminal as { fate?: string; reason?: string }) });
      },
    });

    await until_(() => assert.ok(harness.factory.ledger.events.some((e) => e.event === "repoke_dispatched")), 5000);
    assert.equal(terminals.length, 0, "the watch survives the null lane — growth is the life signal and the denial is the Lead's to answer (missingDeadMs=60 and many ticks in)");
    // The agent re-attempts the denied act only once the old death window is
    // well past — the survival itself is what this stretch proves, so the
    // second denial must not race it.
    setTimeout(() => harness.denial("caught again"), 150);
    await run;

    const line = harness.factory.ledger.events.find((e) => e.event === "needs_human") as { reason: string; evidence: { denial: number; repoke: number } };
    const spend = harness.factory.ledger.events.find((e) => e.event === "repoke_dispatched") as { seq: number };
    const denials = harness.factory.ledger.events.filter((e) => e.event === "permit_denied") as { seq: number }[];
    assert.equal(line.reason, "denied-again");
    assert.deepEqual(line.evidence, { denial: denials[1].seq, repoke: spend.seq }, "the evidence names the NEW denial and the spend");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].fate, "needs-human");
    assert.match(terminals[0].reason ?? "", /denied-again/);
    assert.ok(harness.fetches > 3, "the null lane kept polling past the old death window — life beat the null (design §5)");
    assert.deepEqual(harness.processedKinds(), ["needs_human", "repoke"], "poke and named end through the real spool");
  } finally {
    harness.stop();
  }
});

test("the needs-human terminal (null lane, silent-after-repoke): silence since the spent poke is the named end", async (t) => {
  const harness = await leadHarness(t, () => null);
  try {
    harness.denial("caught");
    const terminals: { fate?: string; reason?: string }[] = [];
    const run = observeTasks(harness.rpc, [{ task: "LEAD1", agentId: "ag-lead1" }], {
      pollMs: 10,
      stateDir: harness.stateDir,
      spoolRoot: harness.spoolRoot,
      graceMs: 10,
      reStallMs: 150,
      log: () => {},
      onTerminal: (entry) => {
        terminals.push({ ...(entry.terminal as { fate?: string; reason?: string }) });
      },
    });
    await run;

    const line = harness.factory.ledger.events.find((e) => e.event === "needs_human") as { reason: string; evidence: { denial: number; repoke: number } };
    const spend = harness.factory.ledger.events.find((e) => e.event === "repoke_dispatched") as { seq: number };
    const denialSeq = (harness.factory.ledger.events.find((e) => e.event === "permit_denied") as { seq: number }).seq;
    assert.equal(line.reason, "silent-after-repoke");
    assert.deepEqual(line.evidence, { denial: denialSeq, repoke: spend.seq }, "the evidence names the stall's own denial and the spend");
    assert.equal(terminals[0].fate, "needs-human");
    assert.match(terminals[0].reason ?? "", /silent-after-repoke/);
  } finally {
    harness.stop();
  }
});

test("the null lane's finish signal: after the poke, a claim on the ledger ends the task green (the readme2 arc)", async (t) => {
  const harness = await leadHarness(t, () => null, growingTimeline());
  try {
    harness.denial("caught");
    const terminals: { fate?: string }[] = [];
    const run = observeTasks(harness.rpc, [{ task: "LEAD1", agentId: "ag-lead1" }], {
      pollMs: 10,
      stateDir: harness.stateDir,
      spoolRoot: harness.spoolRoot,
      graceMs: 10,
      log: () => {},
      onTerminal: (entry) => {
        terminals.push({ ...(entry.terminal as { fate?: string }) });
      },
    });
    await until_(() => assert.ok(harness.factory.ledger.events.some((e) => e.event === "repoke_dispatched")), 5000);
    harness.claimGreen();
    await run;
    assert.deepEqual(terminals.map((x) => x.fate), ["finished"], "the verdict on the ledger is the null lane's finish — the watch survived to witness it");
  } finally {
    harness.stop();
  }
});

test("the slow door: null snapshots, a timeline that answers but never grows past the bound is substrate death, the meter landing at that terminal; the Lead never fires", async (t) => {
  const harness = await leadHarness(t, () => null, stillTimeline(45));
  try {
    const terminals: { fate?: string; reason?: string }[] = [];
    await observeTasks(harness.rpc, [{ task: "LEAD1", agentId: "ag-lead1" }], {
      pollMs: 10,
      stateDir: harness.stateDir,
      spoolRoot: harness.spoolRoot,
      missingDeadMs: 80,
      log: () => {},
      onTerminal: async (entry) => {
        terminals.push({ ...(entry.terminal as { fate?: string; reason?: string }) });
        // runDriver's own terminal callback, verbatim in shape: the captured
        // usage rides one meter request through the real spool.
        const request = { id: `meter-${entry.task}`, kind: "meter", task: entry.task, provider: "claude", usage: entry.usage ?? {}, agent: entry.agentId };
        submit(harness.spoolRoot, request);
        await awaitReply(harness.spoolRoot, request.id, 5000);
      },
    });
    assert.equal(terminals.length, 1, "onTerminal fired exactly once");
    assert.equal(terminals[0].fate, "died");
    assert.match(terminals[0].reason ?? "", /no timeline growth for \d+s — substrate death \(the slow door\)/);
    const meter = harness.factory.ledger.events.findLast((e) => e.event === "meter_written") as { usage?: Record<string, unknown> } | undefined;
    assert.ok(meter, "the meter lands at the real death terminal — through the real spool, the plugin appending the line");
    assert.deepEqual(meter?.usage ?? {}, {}, "the honest empty capture — the null lane reported nothing to a dead agent's poll");
    assert.deepEqual(harness.processedKinds(), ["meter"], "the meter is the death terminal's one spool act — no Lead line ever fires");
    assert.equal(harness.factory.ledger.events.filter((e) => e.event === "repoke_dispatched").length, 0, "no denial evidence, no poke — visible-but-unactionable");
  } finally {
    harness.stop();
  }
});

test("the fast door opens only on the not-found answer: another rpc error never kills, and the ledger finish still runs (the thrown rpc_error envelope)", async (t) => {
  const harness = await leadHarness(t, () => null, rpcErrorTimeline("daemon exploded"));
  try {
    const logs: string[] = [];
    const terminals: { fate?: string; reason?: string }[] = [];
    const run = observeTasks(harness.rpc, [{ task: "LEAD1", agentId: "ag-lead1" }], {
      pollMs: 10,
      stateDir: harness.stateDir,
      spoolRoot: harness.spoolRoot,
      log: (message) => logs.push(message),
      onTerminal: (entry) => {
        terminals.push({ ...(entry.terminal as { fate?: string; reason?: string }) });
      },
    });
    setTimeout(() => harness.claimGreen(), 120);
    await run;
    assert.deepEqual(terminals.map((x) => x.fate), ["finished"], "an un-understood daemon answer defers the death question — it never opens the door, and the verdict still finishes the task");
    assert.ok(logs.some((m) => /timeline read failed \(daemon exploded\) — retrying next poll/.test(m)), "the odd answer is visible in the log, retried every poll");
  } finally {
    harness.stop();
  }
});

test("the fast door opens only on the not-found answer: an error-named PAYLOAD never kills either — the live daemon's failure shape, logged and retried (the judged run's central finding)", async (t) => {
  const harness = await leadHarness(t, () => null, payloadErrorTimeline("daemon exploded"));
  try {
    const logs: string[] = [];
    const terminals: { fate?: string; reason?: string }[] = [];
    const run = observeTasks(harness.rpc, [{ task: "LEAD1", agentId: "ag-lead1" }], {
      pollMs: 10,
      stateDir: harness.stateDir,
      spoolRoot: harness.spoolRoot,
      log: (message) => logs.push(message),
      onTerminal: (entry) => {
        terminals.push({ ...(entry.terminal as { fate?: string; reason?: string }) });
      },
    });
    setTimeout(() => harness.claimGreen(), 120);
    await run;
    assert.deepEqual(terminals.map((x) => x.fate), ["finished"], "a resolved error payload defers the death question exactly like the envelope — never a death, never folded as no-growth");
    assert.ok(logs.some((m) => /timeline read failed \(daemon exploded\) — retrying next poll/.test(m)), "the odd answer is visible in the log, retried every poll");
  } finally {
    harness.stop();
  }
});

test("the fast door: the timeline's own not-found answer at zero ledger life is substrate death, the daemon's words verbatim — through the RESOLVED payload the live daemon sends", async (t) => {
  const harness = await leadHarness(t, () => null, notFoundTimeline());
  try {
    const terminals: { fate?: string; reason?: string }[] = [];
    await observeTasks(harness.rpc, [{ task: "LEAD1", agentId: "ag-lead1" }], {
      pollMs: 10,
      stateDir: harness.stateDir,
      spoolRoot: harness.spoolRoot,
      log: () => {},
      onTerminal: (entry) => {
        terminals.push({ ...(entry.terminal as { fate?: string; reason?: string }) });
      },
    });
    assert.equal(terminals.length, 1, "the door is immediate — no window is waited out");
    assert.equal(terminals[0].fate, "died");
    assert.match(terminals[0].reason ?? "", /Agent not found: ag-lead1 — substrate death \(the fast door: the timeline's own answer\)/);
    assert.deepEqual(harness.processedKinds(), [], "no Lead act fires — the probe's bogus-UUID shape, nothing to answer");
  } finally {
    harness.stop();
  }
});

test("the contradiction (defense-in-depth, ADR 0007 §4): timeline not-found BUT post-spawn ledger life — the watch survives on the ledger predicate, v0.0.10's arc whole", async (t) => {
  const harness = await leadHarness(t, () => null, notFoundTimeline());
  try {
    harness.denial("caught");
    const terminals: { fate?: string; reason?: string }[] = [];
    const run = observeTasks(harness.rpc, [{ task: "LEAD1", agentId: "ag-lead1" }], {
      pollMs: 10,
      stateDir: harness.stateDir,
      spoolRoot: harness.spoolRoot,
      graceMs: 10,
      missingDeadMs: 60, // the fast door never opens while the ledger contradicts it — the bound is moot
      log: () => {},
      onTerminal: (entry) => {
        terminals.push({ ...(entry.terminal as { fate?: string; reason?: string }) });
      },
    });
    await until_(() => assert.ok(harness.factory.ledger.events.some((e) => e.event === "repoke_dispatched")), 5000);
    assert.equal(terminals.length, 0, "not-found + ledger life is not a death — the denial is the Lead's to answer");
    harness.claimGreen();
    await run;
    assert.deepEqual(terminals.map((x) => x.fate), ["finished"], "the watch survived to witness the claim — exactly the v0.0.10 continuation");
  } finally {
    harness.stop();
  }
});

test("growth resets the slow door's clock: death lands a full bound after the LAST growth, not the first stillness", async (t) => {
  const MISSING = 300;
  let fetches = 0;
  let seqEnd = 45;
  let lastGrowthAt = 0;
  const harness = await leadHarness(t, () => null, () => {
    fetches += 1;
    // fetch 1 is the birth growth (-1 -> 45); fetches 2+ sit still, except
    // a mid-window spurt (fetches 5-9) that must restart the clock.
    if (fetches >= 5 && fetches <= 9) {
      seqEnd += 1;
      lastGrowthAt = Date.now();
    }
    return { requestId: "r", entries: [{ seqEnd }] };
  });
  try {
    const terminals: { fate?: string; reason?: string }[] = [];
    let deathAt = 0;
    await observeTasks(harness.rpc, [{ task: "LEAD1", agentId: "ag-lead1" }], {
      pollMs: 10,
      stateDir: harness.stateDir,
      spoolRoot: harness.spoolRoot,
      missingDeadMs: MISSING,
      log: () => {},
      onTerminal: (entry) => {
        deathAt = Date.now();
        terminals.push({ ...(entry.terminal as { fate?: string; reason?: string }) });
      },
    });
    assert.equal(terminals[0].fate, "died", "stillness after the spurt still kills — the door only ever opens on true stillness");
    assert.match(terminals[0].reason ?? "", /the slow door/);
    assert.ok(lastGrowthAt > 0, "the spurt was observed");
    assert.ok(deathAt - lastGrowthAt >= MISSING, `death came a full bound after the last growth (${deathAt - lastGrowthAt}ms >= ${MISSING}ms) — a stuck clock would have died inside the first window`);
  } finally {
    harness.stop();
  }
});

test("healthy ask-less work: null snapshots + a growing timeline, the claim finishes green — zero Lead lines, growth beats the bound", async (t) => {
  const harness = await leadHarness(t, () => null, growingTimeline());
  try {
    const terminals: { fate?: string }[] = [];
    const run = observeTasks(harness.rpc, [{ task: "LEAD1", agentId: "ag-lead1" }], {
      pollMs: 10,
      stateDir: harness.stateDir,
      spoolRoot: harness.spoolRoot,
      missingDeadMs: 80, // the claim lands at ~150ms — past the bound the v0.0.10 null-death would have eaten
      log: () => {},
      onTerminal: (entry) => {
        terminals.push({ ...(entry.terminal as { fate?: string }) });
      },
    });
    setTimeout(() => harness.claimGreen(), 150);
    await run;
    assert.deepEqual(terminals.map((x) => x.fate), ["finished"], "the verdict on the ledger is the null lane's finish — the growing timeline kept the watch alive past the bound");
    assert.deepEqual(harness.processedKinds(), [], "zero Lead acts through the real spool — no denial ever landed");
    assert.equal(
      harness.factory.ledger.events.filter((e) => e.event === "repoke_dispatched" || e.event === "repoke_refused" || e.event === "needs_human").length,
      0,
      "the ledger carries no Lead line — the Arm A discipline",
    );
  } finally {
    harness.stop();
  }
});

/** Waits (bounded) until the assertion holds — the spool answers asynchronously by design. */
async function until_(assertion: () => void, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
