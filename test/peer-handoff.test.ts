import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function fixture(t: TestContext, handoffTimeoutMs = 90_000) {
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
  const surface = createSurfaceHandlers({ factory, stateDir, home: join(dir, "home"), daemon, stopAgent });
  const logs: string[] = [];
  const makeRuntime = () => createLeadMailRuntime({ factory, stateDir, home: join(dir, "home"), daemon, stopAgent, handoffTimeoutMs, ensureLead: input => surface.leadEnsure(input), ensureSupervisor: input => surface.supervisorEnsure(input), retireLead: input => surface.leadRotate(input), onLog: text => logs.push(text) });
  const runtime = makeRuntime();
  const spool = startSpool(stateDir, factory, { daemon, stopAgent, peerMail: runtime.notifyPeer });
  t.after(() => { runtime.stop(); spool.stop(); });
  return { dir, root, slug, stateDir, factory, cwd, sha, peer, agents, daemon, sent, created, stopped, archived, runtime, makeRuntime, logs, failSend: () => { sendFails = true; }, failStop: (value = true) => { stopFails = value; }, failArchive: (value = true) => { archiveFails = value; }, handoff: join(projectStateDir(stateDir, slug), "peer-handoff-T-04.md") };
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

test("the successor's second crossing survives restart and escalates to both seats; a new Contract resets the allowance", async t => {
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
  for (const id of ["lead", "supervisor"]) {
    const mail = f.sent.find(message => message.id === id && message.text.includes("BLOCKED (context-ceiling)"));
    assert.ok(mail);
    assert.match(mail.text, /pending.txt/);
    assert.match(mail.text, /peer-handoff-T-04.md/);
    assert.match(mail.text, /split/);
  }
  const mailbox = readLeadMailbox(join(projectStateDir(f.stateDir, f.slug), "mailbox.jsonl"));
  for (const batch of [mailbox.inFlight, mailbox.supervisorInFlight]) {
    assert.equal(batch?.items[0]?.from, "peer");
    assert.equal(batch?.items[0]?.kind, "needs_human");
  }
  await restarted.pumpAll();
  assert.equal(f.created.length, 1);
  f.factory.setContract({ task: "T-04", workspace: f.root, gate: "true", description: "Narrow remaining slice" });
  f.agents.unshift({ ...f.peer, id: "new-epoch-peer", archivedAt: null, status: "idle" });
  await restarted.onLeadTurnEnded(ended("new-epoch-peer"));
  await restarted.onLeadTurnEnded(ended("new-epoch-peer", "New epoch progress."));
  assert.equal(f.created.length, 2, f.logs.join("\n"));
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
test(`successor reuses the Task's Paseo workspace and ${snapshot} provider lane`, async t => {
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
  assert.deepEqual(f.created[0]!.config, { provider: "antigravity/claude-sonnet-5-5-high", thinkingOptionId: "max" });
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
  await f.runtime.sweepPeers();
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
  const claim = handleSpoolRequest(f.factory, { id: "claim-racing-handoff", kind: "claim", task: "T-04", sha: f.sha });
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
  await restarted.sweepPeers();
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
