import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory, type ContractInput } from "../plugin/server/core/factory.ts";
import { projectStateDir, readProjectRegistration, resolveProject, writeProjectRegistration } from "../plugin/server/core/project.ts";
import { prepareTaskWorktree } from "../plugin/server/core/workspace.ts";
import { readLeadMailbox } from "../plugin/server/core/mailbox.ts";
import { createLeadMailRuntime, LEAD_ROTATE_TOKENS, agentOfTask } from "../plugin/server/lead-mailbox.ts";
import { hasRealWorktreeProgress, PEER_HANDOFF_TOKENS } from "../plugin/server/peer-handoff.ts";
import { handleSpoolRequest, lastTaskAgentForTask } from "../plugin/server/spool.ts";
import { createSurfaceHandlers, type SurfaceAgentSnapshot, type SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { disposeDir, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

function setupFixture(t: TestContext, opts?: { withProgress?: boolean; disposition?: "engineer" | "scout" | "architect" | "reviewer" }) {
  const dir = makeTempDir("adr0069-andon-");
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
  factory.setContract({
    task: "T-04",
    workspace: root,
    gate: opts?.disposition && opts.disposition !== "engineer" ? "" : "true",
    description: "Verify bounded slice",
    disposition: opts?.disposition ?? "engineer",
    skills: ["tdd"],
  });
  const worktree = prepareTaskWorktree({ stateDir, workspace: root, task: "T-04" });
  assert.ok(worktree.ok);
  const cwd = worktree.path;
  factory.requestSpawn({ task: "T-04", provider: "pi/model", arity: 1, worktree: cwd });
  if (opts?.withProgress) {
    writeFileSync(join(cwd, "README.md"), "verified progress\n");
    gitCommitChanges(cwd, "completed slice");
  }
  const peer: SurfaceAgentSnapshot = {
    id: "peer-1",
    provider: "pi/model",
    title: "Peer",
    status: "idle",
    model: null,
    labels: { seat: "agent", project: slug, task: "T-04" },
    archivedAt: null,
    requiresAttention: false,
    attentionReason: null,
    updatedAt: "",
    cwd,
    lastUsage: { contextWindowUsedTokens: 0 },
  };
  const lead: SurfaceAgentSnapshot = {
    ...peer,
    id: "lead-1",
    cwd: root,
    labels: { seat: "lead", project: slug },
    lastUsage: { contextWindowUsedTokens: 10_000 },
  };
  const supervisor: SurfaceAgentSnapshot = {
    ...peer,
    id: "sup-1",
    cwd: root,
    labels: { seat: "supervisor", project: slug },
    lastUsage: null,
  };
  const agents: SurfaceAgentSnapshot[] = [peer, lead, supervisor];
  writeProjectRegistration(stateDir, slug, { root, lead: lead.id, supervisor: supervisor.id });
  const sent: { id: string; text: string }[] = [];
  const created: Parameters<SurfaceDaemonApi["agents"]["create"]>[0][] = [];
  const archived: string[] = [];
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async options => ({
        entries: agents
          .filter(a => options?.filter?.includeArchived || a.archivedAt === null)
          .map(agent => ({ agent })),
      }),
      create: async options => {
        created.push(options);
        const isLead = options.labels.seat === "lead";
        const id = isLead ? `lead-succ-${created.length}` : `peer-succ-${created.length}`;
        agents.unshift({
          ...peer,
          id,
          cwd: options.cwd,
          labels: options.labels,
          provider: options.config.provider,
          lastUsage: null,
          status: "idle",
          archivedAt: null,
        });
        return { id };
      },
      ref: id => ({
        send: async text => { sent.push({ id, text }); },
        archive: async () => {
          const agent = agents.find(a => a.id === id);
          if (agent) agent.archivedAt = "archived";
          archived.push(id);
          return { archivedAt: "archived" };
        },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
    providers: { listAvailable: async () => ({ providers: [] }), listModels: async () => ({ models: [] }) },
  };
  const stopAgent = async (id: string) => {
    const agent = agents.find(a => a.id === id);
    if (agent) agent.status = "idle";
    return { ok: true as const };
  };
  let runtime: ReturnType<typeof createLeadMailRuntime>;
  const surface = createSurfaceHandlers({
    factory,
    stateDir,
    home: join(dir, "home"),
    daemon,
    stopAgent,
    handoff: input => runtime.handoff(input),
  });
  const logs: string[] = [];
  runtime = createLeadMailRuntime({
    factory,
    stateDir,
    home: join(dir, "home"),
    daemon,
    stopAgent,
    ensureLead: input => surface.leadEnsure(input),
    retireLead: input => surface.leadRotate(input),
    onLog: text => logs.push(text),
  });
  t.after(() => runtime.stop());
  return { dir, root, slug, stateDir, factory, cwd, peer, lead, agents, sent, created, archived, runtime, surface, logs };
}

const ended = (agentId: string, kind: "completed" | "canceled" | "failed" = "completed", text = "") => ({
  agentId,
  outcome: { kind },
  timeline: text ? [{ type: "assistant_message", text }] : [],
});

function appendPeerAsked(factory: ReturnType<typeof createFactory>, task: string, agent: string) {
  factory.ledger.append({
    event: "peer_asked",
    task,
    kind: "reopen_premise",
    layer: "API",
    summary: "Brief endpoint premise conflicts with codebase",
    source: "agent_ask",
    agent,
  } as unknown as Parameters<typeof factory.ledger.append>[0]);
}

test("GP-R24c4 fix: unanswered peer_asked chokes Peer Auto-Handoff and Owner Peer handoff until Lead rules", async t => {
  const f = setupFixture(t, { withProgress: true });
  f.peer.lastUsage = { contextWindowUsedTokens: PEER_HANDOFF_TOKENS + 5_000 };
  appendPeerAsked(f.factory, "T-04", f.peer.id);

  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.sweepPeers();
  assert.equal(f.sent.filter(m => m.id === f.peer.id).length, 0, "unanswered peer_asked blocks extraction & nudge");
  assert.equal(f.created.length, 0, "no Peer-2 successor spawned while peer_asked awaits Lead");
  assert.equal(f.archived.length, 0, "Peer stays alive while waiting for Lead ruling");

  const ownerHandoff = await f.surface.handoff({ projectRoot: f.root, seat: "peer:T-04" }, "start");
  assert.equal(ownerHandoff.ok, false);
  if (!ownerHandoff.ok) assert.equal(ownerHandoff.code, "peer-task-ineligible");

  // Once Lead answers via repoke_dispatched, auto-handoff eligibility resumes cleanly.
  f.factory.ledger.append({ event: "repoke_dispatched", task: "T-04", agent: f.peer.id, kind: "ruling" });
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "completed", "# Completed & Verified Slice\nContinuing after Lead ruling."));
  assert.equal(f.created.length, 1, "Peer-2 spawns once Lead answered peer_asked");
});

test("Lead Handoff anti-deadlock law preserved: rotation_pending holds while Lead runs, rotates on quiet point when peer_challenge arrives, delivers [handover + peer_asked] on Turn 1, and holds again after lead_reply_peer", async t => {
  const f = setupFixture(t, { withProgress: true });
  f.lead.status = "running";
  f.lead.lastUsage = { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 5_000 };
  // Lead crosses 160k while running and Peer is live -> rotation_pending holds.
  await f.runtime.pumpAll();
  assert.equal(readProjectRegistration(f.stateDir, f.slug)?.rotationState, "rotation_pending");

  // Peer records peer_asked + queues peer_challenge mail while Lead is still running.
  appendPeerAsked(f.factory, "T-04", f.peer.id);
  await f.runtime.enqueueLeadMail(f.slug, {
    from: "peer",
    kind: "peer_challenge",
    task: "T-04",
    text: "[Peer REOPEN_PREMISE (API) on T-04]\nSummary: Endpoint signature mismatch",
  });
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(readProjectRegistration(f.stateDir, f.slug)?.rotationState, "rotation_pending", "Lead rotation holds while Lead is still running");
  assert.equal(f.sent.filter(m => m.id === f.peer.id).length, 0, "Peer receives no idle nudge or extraction");

  // Lead finishes its running turn -> quiet point reached (queued peer_challenge) -> rotates cleanly!
  f.lead.status = "idle";
  await f.runtime.onLeadTurnEnded(ended(f.lead.id));
  assert.equal(readProjectRegistration(f.stateDir, f.slug)?.rotationState, "handing_over", "rotation_pending transitions to handing_over on queued peer_challenge");

  // Outgoing Lead completes extraction -> Successor Lead gets [handover + peer_asked] on Turn 1!
  await f.runtime.onLeadTurnEnded(ended(f.lead.id, "completed", "# Lead Handoff\nTask T-04 waiting on ruling."));
  const successorLead = f.agents.find(a => a.labels.seat === "lead" && a.archivedAt === null);
  assert.ok(successorLead && successorLead.id !== f.lead.id, "successor Lead spawned");
  const turn1Mail = f.sent.find(m => m.id === successorLead.id);
  assert.ok(turn1Mail, "successor Lead received Turn 1 prompt");
  assert.match(turn1Mail.text, /Task T-04 waiting on ruling/, "Turn 1 carries handover");
  assert.match(turn1Mail.text, /Endpoint signature mismatch/, "Turn 1 carries queued peer_challenge");
  await f.runtime.onLeadTurnEnded(ended(successorLead.id));

  // After lead_reply_peer (repoke_dispatched), Successor Lead crossing >160k holds rotation_pending while Peer is live!
  f.factory.ledger.append({ event: "repoke_dispatched", task: "T-04", agent: f.peer.id, kind: "ruling" });
  successorLead.status = "running";
  successorLead.lastUsage = { contextWindowUsedTokens: LEAD_ROTATE_TOKENS + 10_000 };
  await f.runtime.pumpAll();
  assert.equal(readProjectRegistration(f.stateDir, f.slug)?.rotationState, "rotation_pending");
  successorLead.status = "idle";
  await f.runtime.onLeadTurnEnded(ended(successorLead.id));
  assert.equal(readProjectRegistration(f.stateDir, f.slug)?.rotationState, "rotation_pending", "Lead rotation holds after lead_reply_peer while Peer is live");
});

test("Mid-Context Andon Checkpoint (~50%): strictly at completed turn_ended, fires once per epoch, suppresses double unclaimed-nudge, and resets on new Contract epoch", async t => {
  const f = setupFixture(t, { withProgress: true });
  const peerMsgs = () => f.sent.filter(m => m.id === f.peer.id);
  const checkpoints = () => peerMsgs().filter(m => m.text.includes("Andon Checkpoint"));

  // Below 50% (99,999): no checkpoint.
  f.peer.lastUsage = { contextWindowUsedTokens: 99_999 };
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(checkpoints().length, 0);

  // At 50% (100,000) while running on sweepPeers(): Sterile Cockpit forbids mid-turn injection.
  f.peer.lastUsage = { contextWindowUsedTokens: 100_000 };
  f.peer.status = "running";
  await f.runtime.sweepPeers();
  assert.equal(checkpoints().length, 0, "sweepPeers must never inject Andon Checkpoint mid-turn");

  // At turn_ended with canceled/failed: no checkpoint.
  f.peer.status = "idle";
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "canceled"));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "failed"));
  assert.equal(checkpoints().length, 0, "canceled/failed turns never fire Andon Checkpoint");

  // First completed turn_ended >= 100k with 0 claims and 0 asks: fires once, topology-blind, no duplicate unclaimed nudge.
  const msgsBeforeCheckpoint = peerMsgs().length;
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "completed"));
  assert.equal(checkpoints().length, 1);
  assert.equal(peerMsgs().length, msgsBeforeCheckpoint + 1, "does not double-send unclaimed-turn nudge on the same turn");
  const text = checkpoints()[0]!.text;
  assert.match(text, /agent_ask/);
  assert.doesNotMatch(text, /\b(Owner|Supervisor|Driver|Factory CLI|GateQueue|Lead|paseo-factory)\b/);
  const statePath = join(projectStateDir(f.stateDir, f.slug), "peer-handoff-T-04.json");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).andonCheckpointEpochSeq, f.factory.contractFor("T-04")!.seq);

  // Repeat completed turn_ended in same epoch (even across runtime restart): never fires again.
  f.runtime.stop();
  const restarted = createLeadMailRuntime({
    factory: f.factory,
    stateDir: f.stateDir,
    home: join(f.dir, "home"),
    daemon: {
      agents: {
        list: async opts2 => ({ entries: f.agents.filter(a => opts2?.filter?.includeArchived || a.archivedAt === null).map(agent => ({ agent })) }),
        create: async () => { throw new Error("unexpected create"); },
        ref: id => ({ send: async msg => { f.sent.push({ id, text: msg }); }, archive: async () => ({ archivedAt: "archived" }), timeline: { refetch: async () => ({ entries: [] }) } }),
      },
      providers: { listAvailable: async () => ({ providers: [] }), listModels: async () => ({ models: [] }) },
    },
    ensureLead: input => f.surface.leadEnsure(input),
    retireLead: input => f.surface.leadRotate(input),
  });
  t.after(() => restarted.stop());
  await restarted.onLeadTurnEnded(ended(f.peer.id, "completed"));
  assert.equal(checkpoints().length, 1, "never repeats Andon Checkpoint in same epoch after restart");

  // New Contract epoch resets andonCheckpointEpochSeq -> fires once in new epoch!
  f.factory.setContract({ task: "T-04", workspace: f.root, gate: "true", description: "Narrowed epoch 2" });
  await restarted.onLeadTurnEnded(ended(f.peer.id, "completed"));
  assert.equal(checkpoints().length, 2, "new Contract epoch resets single-shot Andon Checkpoint");
});

test("Andon Checkpoint is skipped when current epoch already has a claim_reported or peer_asked", async t => {
  const f = setupFixture(t, { withProgress: true });
  f.peer.lastUsage = { contextWindowUsedTokens: 120_000 };
  f.factory.ledger.append({ event: "claim_reported", task: "T-04", attempt: 1, sha: "0".repeat(40), agent: f.peer.id });
  f.factory.ledger.append({ event: "gate_finished", task: "T-04", attempt: 1, exit: 1, verdict: "red", note: "fail", sha: "0".repeat(40) });
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(f.sent.filter(m => m.id === f.peer.id && m.text.includes("Andon Checkpoint")).length, 0);
});

test("hasRealWorktreeProgress gates Peer-2 on commits or non-.scratch product changes, never read-only dispositions", async t => {
  const f = setupFixture(t, { withProgress: false });
  const base = f.factory.contractFor("T-04")!.base;
  assert.equal(hasRealWorktreeProgress(f.cwd, base, "engineer"), false, "clean worktree at base has no progress");
  mkdirSync(join(f.cwd, ".scratch"), { recursive: true });
  writeFileSync(join(f.cwd, ".scratch", "notes.md"), "scratchpad only\n");
  assert.equal(hasRealWorktreeProgress(f.cwd, base, "engineer"), false, ".scratch/ changes alone do not count as product progress");
  writeFileSync(join(f.cwd, "product.ts"), "export const ok = true;\n");
  assert.equal(hasRealWorktreeProgress(f.cwd, base, "engineer"), true, "uncommitted product file counts as real progress");
  gitCommitChanges(f.cwd, "product commit");
  assert.equal(hasRealWorktreeProgress(f.cwd, base, "engineer"), true, "commit ahead of base counts as real progress");
  for (const ro of ["scout", "architect", "reviewer"] as const) {
    assert.equal(hasRealWorktreeProgress(f.cwd, base, ro), false, `${ro} always returns false`);
  }
});

test("200k ceiling halts immediately without Peer-2 for zero-progress engineer (including .scratch-only) and read-only dispositions", async t => {
  for (const scenario of ["zero-progress-engineer", "scout", "architect", "reviewer"] as const) {
    const disposition = scenario === "zero-progress-engineer" ? "engineer" : scenario;
    const f = setupFixture(t, { withProgress: scenario !== "zero-progress-engineer", disposition });
    if (scenario === "zero-progress-engineer") {
      mkdirSync(join(f.cwd, ".scratch"), { recursive: true });
      writeFileSync(join(f.cwd, ".scratch", "audit.md"), "notes\n");
    }
    f.peer.lastUsage = { contextWindowUsedTokens: PEER_HANDOFF_TOKENS };
    await f.runtime.onLeadTurnEnded(ended(f.peer.id));
    assert.equal(f.created.length, 0, `${scenario}: must not spawn Peer-2`);
    assert.deepEqual(f.archived, [f.peer.id], `${scenario}: outgoing Peer retired`);
    assert.equal(f.sent.filter(m => m.id === f.peer.id).length, 0, `${scenario}: skips extraction prompt`);
    const leadBlocked = f.sent.find(m => m.id === f.lead.id && m.text.includes("BLOCKED (context-ceiling)"));
    assert.ok(leadBlocked, `${scenario}: Lead receives BLOCKED (context-ceiling)`);
  }
});

test("Peer-2 continuation prompt renders Reopen if and uses topology-blind footer without GateQueue/Owner/Supervisor leaks", async t => {
  const f = setupFixture(t, { withProgress: true });
  f.factory.setContract({
    task: "T-04",
    workspace: f.root,
    gate: "npm test",
    description: "Implement endpoint",
    reopenConditions: ["Upstream schema differs from spec", "Missing fixture"],
  } as ContractInput);
  f.peer.lastUsage = { contextWindowUsedTokens: PEER_HANDOFF_TOKENS + 1_000 };
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  await f.runtime.onLeadTurnEnded(ended(f.peer.id, "completed", "# Completed & Verified Slice\nPartial progress."));
  assert.equal(f.created.length, 1);
  const prompt = f.created[0]!.prompt!;
  assert.match(prompt, /Reopen if:/);
  assert.match(prompt, /Upstream schema differs from spec/);
  assert.match(prompt, /agent_ask/);
  assert.doesNotMatch(prompt, /daemon Gate queue|GateQueue|\bOwner\b|\bSupervisor\b|\bDriver\b/);
});

test("Idle-nudge suppression: answerUnclaimedPeerTurn stays silent whenever hasUnansweredPeerAsk is true (even after Lead acks peer_challenge mail)", async t => {
  const f = setupFixture(t, { withProgress: true });
  appendPeerAsked(f.factory, "T-04", f.peer.id);
  // Queue and deliver/ack the peer_challenge mail so mailbox.queued is empty,
  // proving Ledger-backed hasUnansweredPeerAsk keeps the quiet hold intact.
  await f.runtime.enqueueLeadMail(f.slug, {
    from: "peer",
    kind: "peer_challenge",
    task: "T-04",
    text: "[Peer REOPEN_PREMISE (API) on T-04]",
  });
  await f.runtime.pumpAll();
  const mailboxBefore = readLeadMailbox(join(projectStateDir(f.stateDir, f.slug), "mailbox.jsonl"));
  assert.ok(mailboxBefore.inFlight !== null, "mail delivered to Lead");
  await f.runtime.onLeadTurnEnded(ended(f.lead.id));
  const mailboxAfter = readLeadMailbox(join(projectStateDir(f.stateDir, f.slug), "mailbox.jsonl"));
  assert.equal(mailboxAfter.queued.length, 0);
  assert.equal(mailboxAfter.inFlight, null);

  const peerSentBefore = f.sent.filter(m => m.id === f.peer.id).length;
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(f.sent.filter(m => m.id === f.peer.id).length, peerSentBefore, "no idle-Peer nudge when hasUnansweredPeerAsk is true");

  // Once Lead issues repoke_dispatched, normal unclaimed-turn nudge behavior resumes (with topology-blind agent_ask wording).
  f.factory.ledger.append({ event: "repoke_dispatched", task: "T-04", agent: f.peer.id, kind: "ruling" });
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  const nudges = f.sent.filter(m => m.id === f.peer.id).slice(peerSentBefore);
  assert.equal(nudges.length, 1);
  assert.match(nudges[0]!.text, /ended without a Claim/);
  assert.match(nudges[0]!.text, /agent_ask/);
  assert.doesNotMatch(nudges[0]!.text, /agent_escalate_blocker|Factory:|\bLead\b/);
});

test("spawn_dispatched after peer_asked restores unclaimed-turn nudge for the newly dispatched Peer until a newer peer_asked arrives", async t => {
  const f = setupFixture(t, { withProgress: true });
  appendPeerAsked(f.factory, "T-04", f.peer.id);
  await f.runtime.onLeadTurnEnded(ended(f.peer.id));
  assert.equal(f.sent.filter(m => m.id === f.peer.id).length, 0, "unanswered peer_asked suppresses nudge for the asking Peer");

  // Lead dispatches a fresh replacement Peer via spawn_dispatched without repoking or re-contracting.
  f.peer.archivedAt = "archived";
  const peer2: SurfaceAgentSnapshot = { ...f.peer, id: "peer-2", archivedAt: null };
  f.agents.unshift(peer2);
  f.factory.ledger.append({ event: "spawn_dispatched", task: "T-04", provider: "pi/model", arity: 1, worktree: f.cwd });

  await f.runtime.onLeadTurnEnded(ended(peer2.id));
  const peer2Nudges = f.sent.filter(m => m.id === peer2.id);
  assert.equal(peer2Nudges.length, 1, "spawn_dispatched newer than peer_asked restores unclaimed-turn nudge");
  assert.match(peer2Nudges[0]!.text, /ended without a Claim/);

  // If the replacement Peer then files its own newer peer_asked, the nudge suppresses again.
  appendPeerAsked(f.factory, "T-04", peer2.id);
  await f.runtime.onLeadTurnEnded(ended(peer2.id));
  assert.equal(f.sent.filter(m => m.id === peer2.id).length, 1, "newer peer_asked suppresses nudge again");
});

test("agentOfTask and lastTaskAgentForTask honor peer_asked.agent and reset on new contract_set epoch", async t => {
  const f = setupFixture(t, { withProgress: false });
  f.factory.setContract({ task: "T-05", workspace: f.root, gate: "true", description: "Track peer_asked agent" });
  assert.equal(agentOfTask(f.factory.ledger.events).get("T-05"), undefined);
  assert.equal(lastTaskAgentForTask(f.factory, "T-05"), undefined);

  appendPeerAsked(f.factory, "T-05", "peer-ask-agent");
  assert.equal(agentOfTask(f.factory.ledger.events).get("T-05"), "peer-ask-agent");
  assert.equal(lastTaskAgentForTask(f.factory, "T-05"), "peer-ask-agent");

  // Also verify spool needs_human archives the agent resolved via peer_asked.agent.
  const spawnEvt = f.factory.ledger.append({ event: "spawn_dispatched", task: "T-05", provider: "pi/model", arity: 1, worktree: f.cwd });
  const respawnEvt = f.factory.ledger.append({ event: "respawn_dispatched", task: "T-05", provider: "pi/model", died_agent: "peer-dead" });
  const nhReply = await handleSpoolRequest(
    f.factory,
    { id: "nh-ask-agent", kind: "needs_human", task: "T-05", reason: "died-after-respawn", evidence: { spawn: spawnEvt.seq, respawn: respawnEvt.seq } },
    {
      daemon: {
        agents: {
          list: async () => ({ entries: [] }),
          ref: (id: string) => ({
            archive: async () => {
              f.archived.push(id);
              return { archivedAt: "archived" };
            },
          }),
        },
      } as unknown as SurfaceDaemonApi,
    },
  );
  assert.equal(nhReply.ok, true);
  assert.ok(f.archived.includes("peer-ask-agent"), "needs_human archives the agent identified by peer_asked.agent");

  // A new contract_set clears the prior epoch's agent binding.
  f.factory.setContract({ task: "T-05", workspace: f.root, gate: "true", description: "New epoch" });
  assert.equal(agentOfTask(f.factory.ledger.events).get("T-05"), undefined);
  assert.equal(lastTaskAgentForTask(f.factory, "T-05"), undefined);
});
