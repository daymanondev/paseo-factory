import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { readHandoffProgress } from "../plugin/server/handoff-progress.ts";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { CorrelationRegistry } from "../plugin/server/core/correlations.ts";
import { projectStateDir, resolveProject, writeProjectRegistration } from "../plugin/server/core/project.ts";
import { prepareTaskWorktree } from "../plugin/server/core/workspace.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { createSurfaceHandlers, type SurfaceAgentSnapshot, type SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { handleSpoolRequest, startSpool } from "../plugin/server/spool.ts";
import { readLeadMailbox } from "../plugin/server/core/mailbox.ts";
import { disposeDir, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

function fixture(t: TestContext, handoffTimeoutMs?: number) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const root = join(dir, "repo");
  mkdirSync(root);
  writeFileSync(join(root, "README.md"), "initial\n");
  gitCommitAll(root);
  const project = resolveProject(root);
  assert.ok(project.ok);
  const slug = project.slug;
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  writeProjectRegistration(stateDir, slug, { root });
  factory.setContract({ task: "T-04", workspace: root, gate: "true", description: "Complete the bounded slice", skills: ["tdd"], scope: ["README.md", "pending.txt"] });
  const worktree = prepareTaskWorktree({ stateDir, workspace: root, task: "T-04" });
  assert.ok(worktree.ok);
  const cwd = worktree.path;
  factory.requestSpawn({ task: "T-04", provider: "pi/model", arity: 1, worktree: cwd });
  writeFileSync(join(cwd, "README.md"), "verified progress\n");
  const sha = gitCommitChanges(cwd, "completed slice");
  writeFileSync(join(cwd, "pending.txt"), "unfinished work\n");
  const peer: SurfaceAgentSnapshot = { id: "initial-peer", provider: "pi/model", title: "Peer", status: "idle", model: null, labels: { seat: "agent", project: slug, task: "T-04" }, archivedAt: null, requiresAttention: false, attentionReason: null, updatedAt: "", cwd, lastUsage: { contextWindowUsedTokens: 165_000 } };
  const agents = [peer, ...["lead", "supervisor"].map(seat => ({ ...peer, id: seat, cwd: root, labels: { seat, project: slug }, lastUsage: null }))];
  writeProjectRegistration(stateDir, slug, { root, lead: "lead", supervisor: "supervisor" });
  const sent: { id: string; text: string }[] = [];
  const created: Parameters<SurfaceDaemonApi["agents"]["create"]>[0][] = [];
  const stopped: string[] = [];
  const archived: string[] = [];
  let sendFails = false;
  let stopFails = false;
  let archiveFails = false;
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async options => ({ entries: agents.filter(a => options?.filter?.includeArchived || a.archivedAt === null).map(agent => ({ agent })) }),
      create: async options => {
        created.push(options);
        const id = `successor-${created.length}`;
        agents.unshift({ ...peer, id, cwd: options.cwd, labels: options.labels, provider: options.config.provider, lastUsage: null, status: "running", archivedAt: null });
        return { id };
      },
      ref: id => ({
        send: async text => { if (sendFails) throw new Error("send failed"); sent.push({ id, text }); },
        archive: async () => { if (archiveFails) throw new Error("archive failed"); const agent = agents.find(a => a.id === id); if (agent) agent.archivedAt = "archived"; archived.push(id); return { archivedAt: "archived" }; },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
    providers: { listAvailable: async () => ({ providers: [] }), listModels: async () => ({ models: [] }) },
  };
  const stopAgent = async (id: string) => { stopped.push(id); if (stopFails) return { ok: false as const, reason: "stop failed" }; const agent = agents.find(a => a.id === id); if (agent) agent.status = "idle"; return { ok: true as const }; };
  let runtime: ReturnType<typeof createLeadMailRuntime>;
  const surface = createSurfaceHandlers({ factory, stateDir, home: join(dir, "home"), daemon, stopAgent, handoff: input => runtime.handoff(input) });
  const logs: string[] = [];
  const makeRuntime = () => createLeadMailRuntime({ factory, stateDir, home: join(dir, "home"), daemon, stopAgent, handoffTimeoutMs, ensureLead: input => surface.leadEnsure(input), retireLead: input => surface.leadRotate(input), onLog: text => logs.push(text) });
  runtime = makeRuntime();
  const spool = startSpool(stateDir, factory, { daemon, stopAgent, peerMail: runtime.notifyPeer });
  t.after(() => { runtime.stop(); spool.stop(); });
  return { dir, root, slug, stateDir, factory, cwd, sha, peer, agents, daemon, sent, created, stopped, archived, runtime, surface, makeRuntime, logs, failSend: () => { sendFails = true; }, failStop: (value = true) => { stopFails = value; }, failArchive: (value = true) => { archiveFails = value; }, handoff: join(projectStateDir(stateDir, slug), "peer-handoff-T-04.md") };
}

const ended = (agentId: string, text = "") => ({ agentId, outcome: { kind: "completed" as const }, timeline: text ? [{ type: "assistant_message", text }] : [] });

test("160k Peer turn completion hands existing committed and uncommitted work to one fresh Peer", async t => {
  const f = fixture(t);
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /160,000/);
  assert.match(f.sent[0]!.text, /Completed & Verified Slice/);
  assert.equal(f.created.length, 0);
  writeFileSync(f.handoff, "# Completed & Verified Slice\nThe slice is implemented; fix the targeted check.");
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.deepEqual(f.archived, [f.peer.id]);
  assert.equal(f.created.length, 1);
  const successor = f.created[0]!;
  assert.equal(successor.cwd, f.cwd);
  assert.match(successor.prompt!, /Complete the bounded slice/);
  assert.match(successor.prompt!, /tdd/);
  assert.match(successor.prompt!, /factory\/T-04/);
  assert.match(successor.prompt!, /pending.txt/);
  assert.match(successor.prompt!, /completed slice/);
  assert.match(successor.prompt!, /fix the targeted check/);
  assert.match(successor.prompt!, /factory-claim/);
  assert.equal(readFileSync(join(f.cwd, "pending.txt"), "utf8"), "unfinished work\n");
  assert.ok(new CorrelationRegistry(f.stateDir).findByAgentId("successor-1"));
});

test("the successor's second crossing survives restart and escalates to the Lead seat only; a new Contract resets the allowance", async t => {
  const f = fixture(t);
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "Partial progress, targeted check remains red."));
  f.runtime.stop();
  const restarted = f.makeRuntime();
  t.after(() => restarted.stop());
  const successor = f.agents.find(agent => agent.id === "successor-1")!;
  successor.status = "idle";
  successor.lastUsage = { contextWindowUsedTokens: 160_000 };
  await restarted.onLeadTurnEnded(ended(successor.id));
  await restarted.onLeadTurnEnded(ended(successor.id, "Final partial work preserved."));
  assert.equal(f.created.length, 1, "only one automatic successor is allowed");
  assert.deepEqual(f.archived, [f.peer.id, successor.id]);
  assert.equal(f.agents.filter(a => a.archivedAt === null && a.labels.seat === "agent").length, 0);
  // ADR 0053 Decision 2 / spec Decision 6: a context-ceiling blocker routes
  // exclusively to the Lead mailbox — the Supervisor never hears it directly.
  const mail = f.sent.find(message => message.id === "lead" && message.text.includes("BLOCKED (context-ceiling)"));
  assert.ok(mail);
  assert.match(mail.text, /pending.txt/);
  assert.match(mail.text, /peer-handoff-T-04.md/);
  assert.match(mail.text, /split/);
  assert.equal(f.sent.filter(message => message.id === "supervisor" && message.text.includes("BLOCKED (context-ceiling)")).length, 0, "no ceiling blocker is ever pitched at the Supervisor");
  const mailbox = readLeadMailbox(join(projectStateDir(f.stateDir, f.slug), "mailbox.jsonl"));
  assert.equal(mailbox.inFlight?.items[0]?.from, "peer");
  assert.equal(mailbox.inFlight?.items[0]?.kind, "needs_human", "a genuine context-ceiling stays a needs_human-grade Peer-terminal blocker");
  assert.equal(mailbox.supervisorQueued.length, 0, "no Supervisor mail item is enqueued by a context-ceiling blocker");
  assert.equal(mailbox.supervisorInFlight, null, "the Supervisor slice stays untouched by a context-ceiling blocker");
  await restarted.pumpAll();
  assert.equal(f.created.length, 1);
  f.factory.setContract({ task: "T-04", workspace: f.root, gate: "true", description: "Narrow remaining slice" });
  f.agents.unshift({ ...f.peer, id: "new-epoch-peer", archivedAt: null, status: "idle" });
  await restarted.onLeadTurnEnded(ended("new-epoch-peer"));
  await restarted.onLeadTurnEnded(ended("new-epoch-peer", "New epoch progress."));
  assert.equal(f.created.length, 2, f.logs.join("\n"));
});

test("a read-only Contract's 160k successor is fenced: the worktree stays clean at HEAD, no commit, claim without --sha with the disposition's evidence (ticket 03, ADR 0054 §3)", async t => {
  const f = fixture(t);
  // The epoch moves onto a read-only disposition before the crossing — the
  // successor continues the same Task under the reviewer's fence.
  f.factory.setContract({ task: "T-04", workspace: f.root, gate: "", disposition: "reviewer", description: "Audit the slice" });
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  writeFileSync(f.handoff, "# Completed & Verified Slice\nPartial findings; the retry policy is unverified.");
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  const successor = f.created[0]!;
  assert.match(successor.prompt!, /Disposition: reviewer|disposition reviewer/, "the successor prompt names the disposition");
  assert.match(successor.prompt!, /Read-Only/, "the successor prompt states the session is Read-Only");
  assert.match(successor.prompt!, /read-only-disposition-fence/, "the fence is named");
  assert.match(successor.prompt!, /clean at HEAD/, "the worktree must stay clean at HEAD");
  assert.ok(!successor.prompt!.includes("--sha"), "no sha flag reaches a read-only successor");
  assert.ok(!successor.prompt!.includes("for the committed HEAD"), "the engineer's committed-HEAD claim instruction never appears");
  assert.match(successor.prompt!, /blocking defects/, "the reviewer disposition's evidence expectation rides the prompt");
  assert.match(successor.prompt!, /agent_claim|factory-claim/, "the claim invocation is still named");
});

for (const sensor of ["live", "native transcript"] as const) {
  test(`the periodic runtime sweep interrupts a single running turn at 160k using ${sensor}`, async t => {
    const f = fixture(t);
    f.peer.status = "running";
    if (sensor === "native transcript") {
      const nativeHandle = join(f.dir, "session.jsonl");
      writeFileSync(nativeHandle, JSON.stringify({ message: { role: "assistant", usage: { input: 20_000, output: 5_000, cacheRead: 140_000 } } }) + "\n");
      f.peer.persistence = { nativeHandle };
      f.peer.lastUsage = { contextWindowUsedTokens: 0 };
    }
    await f.runtime.sweepPeers();
    assert.deepEqual(f.stopped, [f.peer.id]);
    assert.equal(f.sent.filter(message => message.id === f.peer.id).length, 1);
    await f.runtime.sweepPeers();
    assert.equal(f.sent.filter(message => message.id === f.peer.id).length, 1, "a sweep cannot send a second extraction");
    // The cancellation event from interrupting the original turn cannot settle extraction.
    await f.runtime.onLeadTurnEnded({ ...ended(f.peer.id), outcome: { kind: "canceled" } });
    assert.equal(f.created.length, 0);
    await f.runtime.onLeadTurnEnded(ended(f.peer.id, "Read README.md first; the slice check fails."));
    assert.equal(f.created.length, 1, f.logs.join("\n"));
    assert.match(f.created[0]!.prompt!, /Read README.md first/);
  });
}

for (const failure of ["send", "error", "timeout", "restart timeout", "missing"] as const) {
  test(`Peer extraction ${failure} fuse preserves worktree state and still creates only one successor`, async t => {
    const f = fixture(t, failure.includes("timeout") ? 30 : 90_000);
    if (failure === "send") f.failSend();
    if (failure === "error") f.peer.status = "error";
    await f.runtime.onLeadTurnEnded(ended(f.peer.id));
    let runtime = f.runtime;
    if (failure === "restart timeout") {
      runtime.stop();
      runtime = f.makeRuntime();
      t.after(() => runtime.stop());
    }
    if (failure === "missing") {
      f.peer.archivedAt = "externally archived";
      await runtime.pumpAll();
    }
    if (failure.includes("timeout")) {
      const deadline = Date.now() + 3000;
      while (f.created.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
        if (failure === "restart timeout") await runtime.pumpAll();
      }
    }
    assert.equal(f.created.length, 1, f.logs.join("\n"));
    assert.match(f.created[0]!.prompt!, /interrupted during handoff extraction/);
    assert.match(f.created[0]!.prompt!, /completed slice/);
    assert.match(readFileSync(f.handoff, "utf8"), /interrupted/);
    await runtime.pumpAll();
    assert.equal(f.created.length, 1);
  });
}

test("a completed Gate and an in-flight Gate both protect the Peer from rotation", async t => {
  const f = fixture(t);
  f.factory.ledger.append({ event: "gate_started", task: "T-04", attempt: 1, cmd: "true" });
  await f.runtime.pumpAll();
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(f.sent.length, 0);
  f.factory.ledger.append({ event: "gate_finished", task: "T-04", attempt: 1, verdict: "green", exit: 0, note: "done", sha: f.sha });
  await f.runtime.pumpAll();
  assert.equal(f.sent.length, 0);
  assert.equal(f.created.length, 0);
});

test("native transcript usage also triggers handoff on turn completion, with bounded assistant-text fallback", async t => {
  const f = fixture(t);
  const nativeHandle = join(f.dir, "session.jsonl");
  writeFileSync(nativeHandle, JSON.stringify({ message: { role: "assistant", usage: { totalTokens: 160_000 } } }));
  f.peer.lastUsage = null;
  f.peer.persistence = { nativeHandle };
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "summary ".repeat(3000)));
  assert.equal(f.created.length, 1);
  assert.ok(Buffer.byteLength(readFileSync(f.handoff, "utf8")) <= 12 * 1024);
});

for (const failure of ["stop", "archive"] as const) {
  test(`failed ${failure} holds succession until the outgoing Peer can be safely retired`, async t => {
    const f = fixture(t);
    await f.runtime.onLeadTurnEnded(ended(f.peer.id));
    if (failure === "stop") f.failStop(); else f.failArchive();
    await f.runtime.onLeadTurnEnded(ended(f.peer.id, "Preserve partial progress."));
    assert.equal(f.created.length, 0);
    f.failStop(false);
    f.failArchive(false);
    await f.runtime.sweepPeers();
    assert.equal(f.created.length, 1, f.logs.join("\n"));
    assert.deepEqual(f.archived, [f.peer.id]);
  });
}

test("re-contracting during extraction invalidates the pending handoff instead of spawning stale work", async t => {
  const f = fixture(t);
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  f.factory.setContract({ task: "T-04", workspace: f.root, gate: "true", description: "A different bounded slice" });
  f.peer.archivedAt = "retired by re-contract";
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "stale summary"));
  await f.runtime.sweepPeers();
  assert.equal(f.created.length, 0);
});

for (const snapshot of ["split", "combined"] as const) {
test(`successor reuses the Task workspace and current worker lane instead of the outgoing ${snapshot} lane`, async t => {
  const f = fixture(t);
  f.peer.provider = "antigravity";
  f.peer.model = "claude-sonnet-5-5-high";
  f.peer.thinkingOptionId = "max";
  if (snapshot === "combined") { f.peer.provider = "antigravity/claude-sonnet-5-5-high:max"; f.peer.model = null; f.peer.thinkingOptionId = null; }
  const workspaces: string[] = [];
  f.daemon.workspaces = {
    open: async () => ({ id: "main-workspace", projectId: "paseo-project" }),
    create: async () => { throw new Error("must reuse the existing Task workspace"); },
    archive: async () => {},
    ref: id => ({ agents: { create: async options => { workspaces.push(id); return f.daemon.agents.create({ ...options, cwd: f.cwd }); } } }),
  };
  writeProjectRegistration(f.stateDir, f.slug, { root: f.root, taskWorkspaces: { "T-04": "task-workspace" } });
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "Existing Task workspace."));
  assert.deepEqual(workspaces, ["task-workspace"]);
  assert.deepEqual(f.created[0]!.config, { provider: "pi/zcode/glm-5.3" });
});
}

test("handoff uses normal Peer workspace recovery when the registered workspace is stale", async t => {
  const f = fixture(t);
  f.daemon.workspaces = {
    open: async () => ({ id: "main-workspace", projectId: "paseo-project" }),
    create: async () => { throw new Error("workspace recreation unavailable"); },
    archive: async () => {},
    ref: () => ({ agents: { create: async () => { throw new Error("stale workspace"); } } }),
  };
  writeProjectRegistration(f.stateDir, f.slug, { root: f.root, taskWorkspaces: { "T-04": "stale-workspace" } });
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "Preserve the existing files."));
  assert.equal(f.created.length, 1, f.logs.join("\n"));
  assert.equal(f.created[0]!.cwd, f.cwd);
});

test("failed successor creation adopts a replacement supplied by another caller before retrying", async t => {
  const f = fixture(t);
  const create = f.daemon.agents.create;
  f.daemon.agents.create = async () => { throw new Error("temporary create failure"); };
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "Partial work ready to continue."));
  assert.equal(f.created.length, 0);
  f.daemon.agents.create = create;
  const replacement = { ...f.peer, id: "manual-replacement", status: "running", lastUsage: null, archivedAt: null };
  f.agents.unshift(replacement);
  await f.runtime.handoff({ slug: f.slug, seat: "peer:T-04", action: "retry" });
  assert.equal(f.created.length, 0, "recovery must not create a second active Peer");
  assert.deepEqual(f.agents.filter(a => a.archivedAt === null && a.labels.seat === "agent").map(a => a.id), [replacement.id]);
});

test("Gate admission racing an asynchronous daemon census suppresses handoff", async t => {
  const f = fixture(t);
  const list = f.daemon.agents.list;
  let seeded = false;
  f.daemon.agents.list = async options => {
    if (!seeded) { seeded = true; f.factory.ledger.append({ event: "gate_started", task: "T-04", attempt: 1, cmd: "true" }); }
    return list(options);
  };
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(f.sent.length, 0);
  assert.equal(f.created.length, 0);
});

test("a Gate that starts during timeline fallback prevents retirement and succession", async t => {
  const f = fixture(t);
  const ref = f.daemon.agents.ref;
  f.daemon.agents.ref = id => ({ ...ref(id), timeline: { refetch: async () => {
    f.factory.ledger.append({ event: "gate_started", task: "T-04", attempt: 1, cmd: "true" });
    return { entries: [{ item: { type: "assistant_message", text: "A concurrent Claim is being verified." } }] };
  } } });
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(f.archived.length, 0);
  assert.equal(f.created.length, 0);
});

test("Claim admission waits for the handoff lifecycle lane without holding it through verification", async t => {
  const f = fixture(t);
  const ref = f.daemon.agents.ref;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.daemon.agents.ref = id => ({ ...ref(id), timeline: { refetch: async () => {
    entered(); await wait;
    return { entries: [{ item: { type: "assistant_message", text: "Partial work committed." } }] };
  } } });
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  const completion = f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await started;
  const claim = handleSpoolRequest(f.factory, { id: "claim-racing-handoff", kind: "claim", task: "T-04", sha: f.sha, handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.factory.ledger.events.some(event => event.event === "gate_started"), false);
  release();
  await completion;
  const result = await claim;
  assert.equal(result.ok, true);
  assert.equal(f.factory.ledger.events.some(event => event.event === "gate_started"), true);
});

test("a task moved to another Project is never rotated through its historical Project", async t => {
  const f = fixture(t);
  const otherRoot = join(f.dir, "other-repo");
  mkdirSync(otherRoot);
  writeFileSync(join(otherRoot, "README.md"), "other project\n");
  gitCommitAll(otherRoot);
  f.factory.setContract({ task: "T-04", workspace: otherRoot, gate: "true" });
  await f.runtime.sweepPeers();
  assert.equal(f.sent.length, 0);
  assert.equal(f.created.length, 0);
  assert.equal(f.archived.length, 0);
});

test("restart recovery counts an automatic successor even if it was already archived", async t => {
  const f = fixture(t);
  const create = f.daemon.agents.create;
  f.daemon.agents.create = async options => {
    const created = await create(options);
    f.agents.find(a => a.id === created.id)!.archivedAt = "archived before create acknowledged";
    throw new Error("ambiguous create result");
  };
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "Progress ready for successor."));
  f.runtime.stop();
  f.daemon.agents.create = create;
  const restarted = f.makeRuntime();
  t.after(() => restarted.stop());
  await restarted.handoff({ slug: f.slug, seat: "peer:T-04", action: "retry" });
  assert.equal(f.created.length, 1, "archived successor still spends the allowance");
});

test("a lost workspace-create acknowledgement adopts its successor before any fallback can duplicate it", async t => {
  const f = fixture(t);
  f.daemon.workspaces = {
    open: async () => ({ id: "main-workspace" }),
    create: async () => ({ id: "recreated-workspace" }),
    archive: async () => {},
    ref: () => ({ agents: { create: async options => {
      await f.daemon.agents.create({ ...options, cwd: f.cwd });
      throw new Error("workspace create acknowledgement lost");
    } } }),
  };
  writeProjectRegistration(f.stateDir, f.slug, { root: f.root, taskWorkspaces: { "T-04": "task-workspace" } });
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "Continue existing work."));
  await f.runtime.sweepPeers();
  assert.equal(f.created.length, 1, f.logs.join("\n"));
  assert.equal(f.agents.filter(agent => agent.archivedAt === null && agent.labels.seat === "agent").length, 1);
});


test("Peer handoff persists the final reply without file writes and caps Unicode at 12 KB", async t => {
  const f = fixture(t);
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.match(f.sent[0]!.text, /entire Markdown handoff directly in your final assistant message, in one piece/);
  assert.match(f.sent[0]!.text, /without running shell commands or writing files to disk/);
  writeFileSync(f.handoff, "# Disk fallback\nUse only without a reply.");
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "# Peer reply\n" + "Verified 🧪\n".repeat(2000)));
  const saved = readFileSync(f.handoff, "utf8");
  assert.match(saved, /^# Peer reply/);
  assert.ok(Buffer.byteLength(saved) <= 12 * 1024);
  assert.match(saved, /\n\.\.\.\[truncated\]$/);
  assert.doesNotMatch(saved, /�/);
  assert.ok(f.created[0]!.prompt!.includes(saved));
});


for (const mode of ["fresh", "stale", "refusal"] as const) {
  test(`Peer handoff uses only a fresh valid worktree fallback (${mode})`, async t => {
    const f = fixture(t);
    const localPath = join(f.cwd, ".paseo-peer-handoff.md");
    if (mode === "stale") {
      writeFileSync(localPath, "# Stale local handoff\nDo not reuse.");
      utimesSync(localPath, new Date(1000), new Date(1000));
    }
    await f.runtime.onLeadTurnEnded(ended(f.peer.id));
    if (mode === "fresh") writeFileSync(localPath, "# Fresh local handoff\nContinue the journey.");
    if (mode === "refusal") {
      writeFileSync(localPath, "Permission denied: cannot write the handoff.");
      writeFileSync(f.handoff, "The handoff was not written: permission denied.");
    }
    await f.runtime.onLeadTurnEnded(ended(f.peer.id, "Permission denied: cannot write outside the workspace."));
    const saved = readFileSync(f.handoff, "utf8");
    if (mode === "fresh") assert.equal(saved, "# Fresh local handoff\nContinue the journey.");
    else {
      assert.match(saved, /outgoing Peer was interrupted during handoff extraction/);
      assert.doesNotMatch(saved, /Permission denied|not written|Stale local handoff/);
    }
  });
}


test("Peer extraction waits the full 180-second default fuse", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = fixture(t);
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  t.mock.timers.tick(179_999);
  await f.runtime.sweepPeers();
  assert.equal(f.created.length, 0);
  t.mock.timers.tick(1);
  await f.runtime.sweepPeers();
  assert.equal(f.created.length, 1);
  assert.match(readFileSync(f.handoff, "utf8"), /outgoing Peer was interrupted/);
});

test("Peer refetches the final handoff when the turn event contains no assistant message", async t => {
  const f = fixture(t);
  const ref = f.daemon.agents.ref;
  f.daemon.agents.ref = id => ({ ...ref(id), timeline: { refetch: async () => ({ entries: [{ item: { type: "assistant_message", text: "# Refetched handoff\nContinue verified work." } }] }) } });
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded({ ...ended(f.peer.id), timeline: [{ type: "tool_call" }] });
  assert.equal(readFileSync(f.handoff, "utf8"), "# Refetched handoff\nContinue verified work.");
  assert.match(f.created[0]!.prompt!, /Continue verified work/);
});


test("Peer rejects a pre-existing local handoff even if its file timestamp is ahead of the extraction", async t => {
  const f = fixture(t);
  const local = join(f.cwd, ".paseo-peer-handoff.md");
  writeFileSync(local, "# Prior local handoff\nBelongs to a previous extraction.");
  utimesSync(local, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.match(readFileSync(f.handoff, "utf8"), /outgoing Peer was interrupted/);
});


test("Owner Peer handoff uses its chosen lane, preserves Task continuity, and leaves automatic succession available", async t => {
  const f = fixture(t);
  f.peer.lastUsage = null;
  const before = f.factory.ledger.events.filter(event => "task" in event && event.task === "T-04");
  const started = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04", lane: "codex/chosen:high" }, "start");
  assert.equal(started.ok, true);
  if (started.ok) assert.equal(started.progress?.state, "handing-over");
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "# Peer handoff\nContinue verified progress."));
  assert.equal(f.created.length, 1, f.logs.join("\n"));
  assert.deepEqual(f.created[0]!.config, { provider: "codex/chosen", thinkingOptionId: "high" });
  assert.equal(f.created[0]!.cwd, f.cwd);
  assert.deepEqual(f.factory.ledger.events.filter(event => "task" in event && event.task === "T-04"), before);
  assert.equal(readFileSync(join(f.cwd, "pending.txt"), "utf8"), "unfinished work\n");
  assert.ok(f.sent.some(message => message.id === "lead" && /T-04/.test(message.text) && /pi\/model/.test(message.text) && /codex\/chosen/.test(message.text) && /extracted/.test(message.text)), "Lead receives the Owner replacement notice");
  const successor = f.agents.find(agent => agent.id === "successor-1")!;
  successor.lastUsage = { contextWindowUsedTokens: 165_000 };
  await f.runtime.onLeadTurnEnded(ended(successor.id));
  await f.runtime.onLeadTurnEnded(ended(successor.id, "Automatic continuation."));
  assert.equal(f.created.length, 2, "Owner replacement did not consume automatic budget");
  assert.deepEqual(f.created[1]!.config, { provider: "codex/chosen", thinkingOptionId: "high" }, "per-Peer choice survives automatic succession");
});


test("worker changes leave the running Peer alone and successors use the latest Project lane at creation", async t => {
  const f = fixture(t);
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  const saved = await f.surface.lanesSet({ projectRoot: f.root, lane: "worker", value: "codex/current:medium" });
  assert.equal(saved.ok, true);
  assert.deepEqual(f.archived, []);
  assert.equal(f.peer.provider, "pi/model");
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "Continue using the latest worker lane."));
  assert.deepEqual(f.created[0]!.config, { provider: "codex/current", thinkingOptionId: "medium" });
});

test("Owner Replace now persists a substitute and failed creation retries across restart without another extraction", async t => {
  const f = fixture(t);
  f.peer.lastUsage = null;
  const create = f.daemon.agents.create;
  f.daemon.agents.create = async () => { throw new Error("provider unavailable"); };
  const failed = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04", lane: "codex/retry:high" }, "replaceNow");
  assert.equal(failed.ok, true);
  if (failed.ok) { assert.equal(failed.progress?.state, "failed"); assert.equal(failed.progress?.handover, "substitute"); }
  assert.equal(f.sent.filter(message => message.id === f.peer.id).length, 0);
  const saved = readFileSync(f.handoff, "utf8");
  for (const section of ["Plugin-built handover", "Ledger digest", "Project notebook", "Git state", "Open Tasks", "Recent timeline"]) assert.ok(saved.includes(section));
  f.runtime.stop();
  const restarted = f.makeRuntime(); t.after(() => restarted.stop());
  f.daemon.agents.create = create;
  const retried = await restarted.handoff({ slug: f.slug, seat: "peer:T-04", action: "retry" });
  assert.equal(retried.ok, true);
  if (retried.ok) assert.equal(retried.progress?.state, "done");
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.created[0]!.config, { provider: "codex/retry", thinkingOptionId: "high" });
  assert.ok(f.created[0]!.prompt!.includes(saved));
  await restarted.sweepPeers();
  const mailbox = readLeadMailbox(join(projectStateDir(f.stateDir, f.slug), "mailbox.jsonl"));
  assert.equal([...mailbox.queued, ...(mailbox.inFlight?.items ?? [])].filter(item => item.text.includes("Owner replaced Peer")).length, 1);
});

test("Owner no-reply handoff uses the 90-second fuse and keeps handover source after done expires", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = fixture(t);
  f.peer.lastUsage = null;
  await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "start");
  t.mock.timers.tick(89_999);
  await f.runtime.sweepPeers();
  assert.equal(f.created.length, 0);
  t.mock.timers.tick(1);
  await f.runtime.sweepPeers();
  assert.equal(f.created.length, 1);
  t.mock.timers.tick(20_001);
  const handover = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "handover");
  assert.equal(handover.ok, true);
  if (handover.ok) { assert.equal(handover.progress, null); assert.equal(handover.source, "substitute"); assert.match(handover.text!, /^# Plugin-built handover/); }
});


test("automatic successor creation failure stays visible until Owner retry and preserves the automatic budget", async t => {
  const f = fixture(t);
  const create = f.daemon.agents.create;
  f.daemon.agents.create = async () => { throw new Error("quota exhausted"); };
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "# Verified partial work\nContinue from README."));
  f.daemon.agents.create = create;
  await f.runtime.sweepPeers();
  assert.equal(f.created.length, 0, "sweep must preserve the failed state for Owner action");
  const failed = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "handover");
  assert.equal(failed.ok, true);
  if (failed.ok) assert.equal(failed.progress?.state, "failed");
  const retried = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "retry");
  assert.equal(retried.ok, true);
  assert.equal(f.created.length, 1);
  const successor = f.agents.find(agent => agent.id === "successor-1")!;
  successor.lastUsage = null;
  const owner = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "replaceNow");
  assert.equal(owner.ok, true);
  assert.equal(f.created.length, 2, "Owner replacement still works after the automatic budget is spent");
});

test("Owner cancel during an Owner-requested extraction keeps the Peer on its Task, ignores a late reply and leaves the budget alone", async t => {
  const f = fixture(t);
  f.peer.lastUsage = null;
  const started = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "start");
  assert.equal(started.ok, true);
  const statePath = join(projectStateDir(f.stateDir, f.slug), "peer-handoff-T-04.json");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).phase, "extracting");
  const canceled = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "cancel");
  assert.deepEqual(canceled, { ok: true, progress: null });
  assert.equal(readHandoffProgress(f.stateDir, f.slug, "peer:T-04"), null);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.phase, "idle"); assert.equal(state.peerHandoffCount, 0); assert.equal(state.outgoingId, undefined);
  assert.match(f.sent.filter(message => message.id === f.peer.id).at(-1)?.text ?? "", /Handoff canceled by the Owner — keep working on your Task\./);
  assert.deepEqual(f.archived, []);
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "# Late extraction\nIgnored."));
  assert.equal(f.created.length, 0); assert.equal(readHandoffProgress(f.stateDir, f.slug, "peer:T-04"), null);
  const again = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "start");
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.progress?.state, "handing-over");
});

test("Owner cancel of a failed Peer handoff clears the dead end without spending the automatic budget", async t => {
  const f = fixture(t);
  f.daemon.agents.create = async () => { throw new Error("Provider 'antigravity' is not available"); };
  const failed = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04", lane: "antigravity/x" }, "replaceNow");
  assert.equal(failed.ok, true);
  if (failed.ok) assert.equal(failed.progress?.state, "failed");
  const canceled = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "cancel");
  assert.deepEqual(canceled, { ok: true, progress: null });
  assert.equal(readHandoffProgress(f.stateDir, f.slug, "peer:T-04"), null);
  const state = JSON.parse(readFileSync(join(projectStateDir(f.stateDir, f.slug), "peer-handoff-T-04.json"), "utf8"));
  assert.equal(state.phase, "idle"); assert.equal(state.peerHandoffCount, 0);
  assert.equal(existsSync(f.handoff), false);
  const next = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "retry");
  assert.equal(next.ok, false);
  if (!next.ok) assert.equal(next.code, "handoff-not-failed");
});

test("Owner cancel is refused for a context-mark extraction and when no Peer handoff is active", async t => {
  const f = fixture(t);
  const idle = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "cancel");
  assert.equal(idle.ok, false);
  if (!idle.ok) assert.equal(idle.code, "handoff-not-active");
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(readHandoffProgress(f.stateDir, f.slug, "peer:T-04")?.state, "handing-over");
  const refused = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "cancel");
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "handoff-past-cancel");
  assert.equal(readHandoffProgress(f.stateDir, f.slug, "peer:T-04")?.state, "handing-over");
});

test("Owner Peer handoff refuses protected or missing Tasks before interrupting the Peer", async t => {
  const f = fixture(t);
  const missing = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-99" }, "start");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "unknown-task");
  f.factory.ledger.append({ event: "gate_started", task: "T-04", attempt: 1, cmd: "true" });
  const verifying = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "start");
  assert.equal(verifying.ok, false);
  if (!verifying.ok) assert.equal(verifying.code, "peer-task-ineligible");
  assert.equal(f.sent.length, 0);
  assert.equal(f.stopped.length, 0);
});

test("a smaller Peer window clips the handoff mark to eighty percent", async t => {
  const f = fixture(t);
  f.peer.lastUsage = { contextWindowUsedTokens: 102_399, contextWindowMaxTokens: 128_000 };
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(f.sent.length, 0, "below the clipped mark the Peer continues");
  f.peer.lastUsage.contextWindowUsedTokens = 102_400;
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(f.sent.length, 1, "the clipped mark starts extraction before 160k");
  assert.match(f.sent[0]!.text, /102,400/);
  const snap = await f.surface.snapshot({ projectRoot: f.root });
  assert.ok(snap.ok);
  assert.equal(snap.view.panel.seats!.peers[0]!.context!.markTokens, 102_400);
  assert.equal(f.created.length, 0, "extraction preserves the existing Peer until its reply");
});
