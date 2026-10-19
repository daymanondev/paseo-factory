import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { taskWorktreePath } from "../plugin/server/core/workspace.ts";
import { projectStateDir } from "../src/index.ts";
import { readProjectRegistration, writeProjectRegistration } from "../plugin/server/projects.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { handleSpoolRequest, parseSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { createLeadMailRuntime, LEAD_ROTATE_TOKENS, readLeadContextTokens } from "../plugin/server/lead-mailbox.ts";
import { deliverLeadMail as coreDeliver, enqueueLeadMail as coreEnqueue } from "../src/index.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The v0.0.20 dispatch pipeline seam (spec §Testing Decisions 2, the
 * plugin-spool half): `startSpool` + `createSurfaceHandlers` + the Lead
 * mailbox runtime wired together the way `plugin/index.server.ts` wires them,
 * against a temp state dir, a real git Project, and the fake daemon shape
 * `test/surface-rpc.test.ts` established. A dropped `lead_dispatch` request
 * must auto-ensure the Project's Lead, queue the directive in
 * `<projectStateDir>/mailbox.jsonl`, deliver it when the Lead is idle (and
 * hold it while running), and the peer hooks must land verdict / needs-human
 * mail on the owning Project's lane — held through a Driver wave and flushed
 * as one consolidated delivery when the wave finishes (ADR 0013 §4).
 */

const POLL_MS = 20;

// ---- the fake daemon — the structural slice surface-rpc.ts names ------------------------

interface FakeAgent {
  id: string;
  title?: string;
  status?: string;
  provider?: string;
  labels?: Record<string, string>;
  requiresAttention?: boolean;
  cwd?: string;
  /** The live usage slice the 128k sensor reads (ticket 07) — absent on agents the daemon reports no usage for. */
  lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null;
  /** The persistence slice naming the Pi session `.jsonl` (ticket 07's fallback sensor). */
  persistence?: { nativeHandle?: string } | null;
}

function fakeDaemon(agents: FakeAgent[]) {
  const created: { config: { provider: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }[] = [];
  const sent: { agentId: string; text: string }[] = [];
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async (options) => {
        const filter = options?.filter;
        const kept = agents.filter((agent) => {
          if (filter?.labels !== undefined) {
            for (const [key, value] of Object.entries(filter.labels)) {
              if (agent.labels?.[key] !== value) return false;
            }
          }
          return true;
        });
        return {
          entries: kept.map((agent) => ({
            agent: {
              id: agent.id,
              provider: agent.provider ?? "pi/zai/glm-5.3",
              title: agent.title ?? null,
              status: agent.status ?? "idle",
              model: null,
              labels: agent.labels ?? {},
              archivedAt: null,
              requiresAttention: agent.requiresAttention ?? false,
              attentionReason: null,
              updatedAt: "2026-10-15T00:00:00.000Z",
              cwd: agent.cwd ?? "/tmp",
              ...(agent.lastUsage === undefined ? {} : { lastUsage: agent.lastUsage }),
              ...(agent.persistence === undefined ? {} : { persistence: agent.persistence }),
            },
          })),
        };
      },
      create: async (options) => {
        created.push({ config: options.config, cwd: options.cwd, title: options.title ?? "", labels: options.labels ?? {}, prompt: options.prompt });
        const id = `agent-created-${created.length}`;
        agents.push({ id, title: options.title ?? undefined, provider: options.config.provider, labels: options.labels, cwd: options.cwd });
        return { id };
      },
      ref: (id: string) => ({
        send: async (text: string) => {
          sent.push({ agentId: id, text });
        },
        archive: async () => {
          const at = agents.findIndex((agent) => agent.id === id);
          if (at !== -1) agents.splice(at, 1);
          return { archivedAt: new Date().toISOString() };
        },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "pi", available: true }] }),
      listModels: async () => ({ models: [] }),
    },
  };
  return { daemon, created, sent };
}

/** The production wiring in miniature: factory + surface handlers + Lead-mailbox runtime + spool. */
function makeSpooledSurface(t: TestContext, agents: FakeAgent[] = []) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const projectRoot = join(dir, "repo");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "README.md"), "x\n");
  gitCommitAll(projectRoot);
  const resolved = resolveProject(projectRoot);
  assert.ok(resolved.ok, "the test project must resolve");
  const slug = resolved.ok ? resolved.slug : "";

  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });
  // The registry binding every seated Project carries (a supervisorEnsure
  // writes this in production) — the slug form of dispatch resolves through it.
  writeProjectRegistration(stateDir, resolved.slug, { root: projectRoot });
  const fake = fakeDaemon(agents);
  // The retire path's cancel half rides the CLI in production — recorded and
  // ok here, so the 128k handoff tests never spawn a real paseo process.
  const stopped: string[] = [];
  const surface = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon: fake.daemon,
    stopAgent: async (agentId) => {
      stopped.push(agentId);
      return { ok: true };
    },
  });
  const leadMail = createLeadMailRuntime({
    factory,
    stateDir,
    daemon: fake.daemon,
    ensureLead: (input) => surface.leadEnsure(input),
    retireLead: (input) => surface.leadRotate(input),
  });
  const spool = startSpool(stateDir, factory, {
    pollMs: POLL_MS,
    leadDispatch: (request) => leadMail.dispatchLead(request),
    peerMail: leadMail.notifyPeer,
  });
  t.after(() => spool.stop());
  return { dir, home, stateDir, slug, projectRoot, factory, surface, leadMail, spool, fake, stopped };
}

/** The CLI half's write pattern: tmp file + rename, so the plugin never reads a half-written request. */
function dropRequest(spoolRoot: string, body: Record<string, unknown> & { id: string }): void {
  const requestsDir = join(spoolRoot, "requests");
  mkdirSync(requestsDir, { recursive: true });
  const path = join(requestsDir, `${body.id}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  renameSync(tmp, path);
}

function readReply(spoolRoot: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(spoolRoot, "replies", `${id}.json`), "utf8")) as Record<string, unknown>;
}

/** The mailbox as raw JSONL lines — the file is the observable, never an internal fold. */
function readMailbox(stateDir: string, slug: string): Record<string, unknown>[] {
  const path = join(projectStateDir(stateDir, slug), "mailbox.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Waits (bounded) until the condition holds — spool answers are asynchronous by design. */
async function until(assertion: () => void, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

// ---- the request shape (spec §Implementation Decisions 4's code block) -------------------

test("parseSpoolRequest accepts the lead_dispatch shape and nothing around it", () => {
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "lead_dispatch", message: "Ship the roadmap" }), {
    id: "r1",
    kind: "lead_dispatch",
    message: "Ship the roadmap",
  });
  assert.deepEqual(
    parseSpoolRequest({ id: "r2", kind: "lead_dispatch", project: "demo-a1b2c3", workspace: "/w/repo", from: "supervisor", message: "Go" }),
    { id: "r2", kind: "lead_dispatch", project: "demo-a1b2c3", workspace: "/w/repo", from: "supervisor", message: "Go" },
  );
  for (const bad of [
    { id: "r1", kind: "lead_dispatch" }, // no message
    { id: "r1", kind: "lead_dispatch", message: "  " }, // blank message
    { id: "r1", kind: "lead_dispatch", message: 7 },
    { id: "r1", kind: "lead_dispatch", message: "x", project: " " }, // blank project
    { id: "r1", kind: "lead_dispatch", message: "x", workspace: "" },
    { id: "r1", kind: "lead_dispatch", message: "x", from: "peer" }, // peers never dispatch — verdicts ride the hook
    { id: "r1", kind: "lead_dispatch", message: "x", from: "agent-1" },
  ]) {
    assert.equal(parseSpoolRequest(bad), undefined, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("lead_dispatch rides the injected handler and is refused loudly without one (the lead_rotate precedent)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  const without = await handleSpoolRequest(factory, { id: "r0", kind: "lead_dispatch", project: "demo", message: "x" });
  assert.ok(!without.ok);
  assert.equal(without.code, "lead-dispatch-unavailable", "no handler wired — a named refusal, never a silent pass");
});

// ---- the dispatch pipeline ----------------------------------------------------------------

test("a dropped lead_dispatch auto-creates the Lead, queues the directive, and — Lead idle — delivers it", async (t) => {
  const { stateDir, slug, fake } = makeSpooledSurface(t);

  dropRequest(spoolRootFor(stateDir), { id: "disp-1", kind: "lead_dispatch", project: slug, message: "Ship the roadmap" });
  await until(() => {
    assert.equal(readReply(spoolRootFor(stateDir), "disp-1").ok, true, "the dispatch replied ok");
  });
  const reply = readReply(spoolRootFor(stateDir), "disp-1");

  // The auto-ensure: the Lead seat was created with its seat labels — no raw agentId ever needed.
  assert.equal(fake.created.length, 1, "the dispatch auto-created the Lead agent");
  assert.deepEqual(fake.created[0]?.labels, { seat: "lead", project: slug });
  assert.equal(reply.project, slug);
  assert.equal(reply.leadAgentId, "agent-created-1");
  assert.equal(reply.rotationState, "normal", "absent rotationState reads as normal (ticket 07 owns the field)");
  assert.equal(typeof reply.mailId, "string");

  // The mailbox: one queued directive from the owner, then the batch delivery to the Lead.
  const events = readMailbox(stateDir, slug);
  assert.deepEqual(
    events.map((evt) => evt.type),
    ["mail_queued", "mail_delivered"],
    "idle Lead → the queued directive delivered in the same pump",
  );
  const queued = events[0];
  assert.equal(queued.from, "owner", "the request's from defaults to owner");
  assert.equal(queued.kind, "directive");
  assert.equal(queued.text, "Ship the roadmap");
  assert.equal(queued.mailId, reply.mailId);
  const delivered = events[1];
  assert.deepEqual(delivered.mailIds, [reply.mailId]);
  assert.equal(delivered.toAgentId, "agent-created-1");

  // The delivery itself: one formatted prompt carrying the directive.
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0]?.agentId, "agent-created-1");
  assert.ok(fake.sent[0]?.text.includes("Ship the roadmap"), "the batch prompt carries the directive text");
});

test("a dispatch while the Lead is running leaves the mail queued; the next pump delivers it once idle", async (t) => {
  const running: FakeAgent = { id: "agent-lead-1", title: "Lead (paseo-factory)", status: "running", labels: {} };
  const { stateDir, slug, fake, leadMail } = makeSpooledSurface(t, [running]);
  // The seeded Lead must carry the Project's labels for the seat lookup to find it.
  running.labels = { seat: "lead", project: slug };

  dropRequest(spoolRootFor(stateDir), { id: "disp-2", kind: "lead_dispatch", project: slug, message: "Hold until my turn ends" });
  await until(() => {
    assert.equal(readReply(spoolRootFor(stateDir), "disp-2").ok, true);
  });
  const reply = readReply(spoolRootFor(stateDir), "disp-2");

  assert.equal(fake.created.length, 0, "an existing Lead is reused, never re-created");
  assert.equal(reply.leadAgentId, "agent-lead-1");
  assert.deepEqual(
    readMailbox(stateDir, slug).map((evt) => evt.type),
    ["mail_queued"],
    "a running Lead holds the mail queued — the active turn is never interrupted (§User Story 12)",
  );
  assert.equal(fake.sent.length, 0, "nothing was pitched at the running Lead");

  // The turn ends: the same lane delivers the held batch on the next pump.
  running.status = "idle";
  await leadMail.pumpProjectLead(slug);
  assert.deepEqual(
    readMailbox(stateDir, slug).map((evt) => evt.type),
    ["mail_queued", "mail_delivered"],
  );
  assert.equal(fake.sent.length, 1);
  assert.ok(fake.sent[0]?.text.includes("Hold until my turn ends"));
});

test("a dispatch resolves --workspace through resolveProject as the same Project", async (t) => {
  const { stateDir, slug, projectRoot, fake } = makeSpooledSurface(t);

  dropRequest(spoolRootFor(stateDir), { id: "disp-3", kind: "lead_dispatch", workspace: projectRoot, from: "supervisor", message: "By workspace" });
  await until(() => {
    assert.equal(readReply(spoolRootFor(stateDir), "disp-3").ok, true);
  });
  const reply = readReply(spoolRootFor(stateDir), "disp-3");
  assert.equal(reply.project, slug, "the workspace resolved to the canonical slug");
  assert.equal(readMailbox(stateDir, slug)[0]?.from, "supervisor", "the request's from rides the mail");

  // An unresolvable workspace is a named refusal, never a guess.
  dropRequest(spoolRootFor(stateDir), { id: "disp-4", kind: "lead_dispatch", workspace: "/definitely/missing", message: "x" });
  await until(() => {
    assert.equal(readReply(spoolRootFor(stateDir), "disp-4").ok, false);
  });
  const refused = readReply(spoolRootFor(stateDir), "disp-4");
  assert.equal(refused.code, "unknown-project");
  assert.equal(fake.created.length, 1, "no Lead was ensured for the refused dispatch");
});

// ---- the peer hooks (spec §Implementation Decisions 4, last bullet) -----------------------

test("peer hooks: verdicts and needs_human land peer mail; a Driver wave holds delivery and the wave's last outcome flushes one consolidated batch", async (t) => {
  const { stateDir, slug, projectRoot, factory, surface, fake } = makeSpooledSurface(t);
  const spoolRoot = spoolRootFor(stateDir);

  // A standing idle Lead (ensured bare — no message, so no delivery of its own).
  const ensured = await surface.leadEnsure({ projectRoot });
  assert.ok(ensured.ok);

  // Two contracted tasks in the Project (disjoint scopes — two tasks share one
  // tree only behind them); a real commit to claim green.
  factory.setContract({ task: "T1", workspace: projectRoot, gate: "true", artifact: "README.md", scope: ["zone-t1"] });
  factory.setContract({ task: "T2", workspace: projectRoot, gate: "true", artifact: "README.md", scope: ["zone-t2"] });
  const sha = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8" }).trim();

  // The Driver wave opens: both tasks spawn, neither has a verdict yet.
  dropRequest(spoolRoot, { id: "sp-1", kind: "spawn", task: "T1", provider: "pi/zai/glm-5.3", arity: 1 });
  dropRequest(spoolRoot, { id: "sp-2", kind: "spawn", task: "T2", provider: "pi/zai/glm-5.3", arity: 1 });
  await until(() => {
    assert.equal(readReply(spoolRoot, "sp-2").ok, true);
  });

  // T1's verdict lands mid-wave: the peer mail queues, but the wave holds delivery.
  dropRequest(spoolRoot, { id: "cl-1", kind: "claim", task: "T1", sha, agent: "agent-worker-1" });
  await until(() => {
    assert.equal(readReply(spoolRoot, "cl-1").ok, true);
  });
  const midWave = readMailbox(stateDir, slug);
  assert.equal(midWave.filter((evt) => evt.type === "mail_queued").length, 1, "the verdict mail landed");
  const verdictMail = midWave.find((evt) => evt.type === "mail_queued");
  assert.equal(verdictMail?.from, "peer");
  assert.equal(verdictMail?.kind, "verdict");
  assert.equal(verdictMail?.task, "T1");
  assert.ok(String(verdictMail?.text).includes("T1"), "the mail names the task");
  assert.ok(String(verdictMail?.text).includes("GREEN"), "the mail names the verdict");
  assert.equal(midWave.filter((evt) => evt.type === "mail_delivered").length, 0, "the Driver wave held the delivery");
  assert.equal(fake.sent.length, 0, "nothing was pitched at the Lead mid-wave");

  // The wave's last outcome: T2's verdict closes every spawned round, and the
  // held mail flushes as ONE consolidated delivery.
  dropRequest(spoolRoot, { id: "cl-2", kind: "claim", task: "T2", sha, agent: "agent-worker-2" });
  await until(() => {
    assert.equal(readReply(spoolRoot, "cl-2").ok, true);
  });
  const flushed = readMailbox(stateDir, slug);
  const deliveries = flushed.filter((evt) => evt.type === "mail_delivered");
  assert.equal(deliveries.length, 1, "one consolidated delivery for the whole wave");
  assert.equal((deliveries[0]?.mailIds as string[] | undefined)?.length, 2, "both verdict mails rode the one batch — none lost");
  assert.equal(fake.sent.length, 1, "one prompt carried the batch");
  assert.ok(fake.sent[0]?.text.includes("T1") && fake.sent[0]?.text.includes("T2"), "the consolidated prompt names both tasks");
});

test("peer hooks: a needs_human recording lands its peer mail on the owning Project's lane", async (t) => {
  const { stateDir, slug, projectRoot, factory } = makeSpooledSurface(t);
  const spoolRoot = spoolRootFor(stateDir);

  factory.setContract({ task: "T3", workspace: projectRoot, gate: "true", artifact: "README.md" });
  const denialSeq = factory.ledger.append({
    event: "permit_denied",
    task: "T3",
    agent: "ag-worker",
    name: "Bash",
    kind: "tool",
    command: "git reset --hard",
    rule: "policy:S1-git-vocabulary",
    reason: "caught",
  }).seq;
  dropRequest(spoolRoot, { id: "rp-1", kind: "repoke", task: "T3", agent: "ag-worker" });
  await until(() => {
    assert.equal(readReply(spoolRoot, "rp-1").ok, true);
  });
  const repokeSeq = factory.ledger.events.find((e) => e.event === "repoke_dispatched")?.seq ?? 0;

  dropRequest(spoolRoot, { id: "nh-1", kind: "needs_human", task: "T3", reason: "denied-again", evidence: { denial: denialSeq, repoke: repokeSeq } });
  await until(() => {
    assert.equal(readReply(spoolRoot, "nh-1").ok, true);
  });

  const queued = readMailbox(stateDir, slug).find((evt) => evt.type === "mail_queued");
  assert.equal(queued?.from, "peer");
  assert.equal(queued?.kind, "needs_human");
  assert.equal(queued?.task, "T3");
  assert.ok(String(queued?.text).includes("denied-again"));
});

// ---- the startup recovery (ADR 0013 Decision 3's restart rule) ---------------------------

test("startup recovery requeues an un-acked delivery for every registered Project with reason daemon-restart", async (t) => {
  const { stateDir, slug, projectRoot, leadMail } = makeSpooledSurface(t);
  writeProjectRegistration(stateDir, slug, { root: projectRoot });

  // A crash mid-delivery: one queued mail, delivered, never acked.
  const path = join(projectStateDir(stateDir, slug), "mailbox.jsonl");
  const queued = coreEnqueue(path, { from: "supervisor", kind: "directive", text: "pre-crash directive" });
  coreDeliver(path, { mailIds: [queued.mailId], toAgentId: "agent-lead-old" });

  leadMail.startupRecovery();

  const events = readMailbox(stateDir, slug);
  assert.deepEqual(
    events.map((evt) => evt.type),
    ["mail_queued", "mail_delivered", "mail_requeued"],
    "the un-acked batch came back to queued",
  );
  assert.equal(events[2]?.reason, "daemon-restart");
  assert.deepEqual(events[2]?.mailIds, [queued.mailId]);
});

// ---- the 128k rotation state machine (v0.0.20, ADR 0013 §5 — ticket 07) --------------------

test("LEAD_ROTATE_TOKENS is the fixed 128,000 and the rotation fields ride the registry's merge-by-field law", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");

  // The threshold is a constant, never a per-model formula (spec §Out of Scope).
  assert.equal(LEAD_ROTATE_TOKENS, 128_000);

  // A bare registration carries no rotation state — absent reads as "normal".
  writeProjectRegistration(stateDir, "demo-a1b2c3", { root: "/w/demo" });
  assert.equal(readProjectRegistration(stateDir, "demo-a1b2c3")?.rotationState, undefined);
  assert.equal(readProjectRegistration(stateDir, "demo-a1b2c3")?.handoffRequestedAt, undefined);

  // A value sets; `undefined` preserves (the seats' precedent); null clears.
  writeProjectRegistration(stateDir, "demo-a1b2c3", { root: "/w/demo", rotationState: "rotation_pending" });
  assert.equal(readProjectRegistration(stateDir, "demo-a1b2c3")?.rotationState, "rotation_pending");
  writeProjectRegistration(stateDir, "demo-a1b2c3", { root: "/w/demo" });
  assert.equal(readProjectRegistration(stateDir, "demo-a1b2c3")?.rotationState, "rotation_pending", "undefined preserves the field");
  writeProjectRegistration(stateDir, "demo-a1b2c3", { root: "/w/demo", rotationState: "handing_over", handoffRequestedAt: "2026-10-19T00:00:00.000Z" });
  const locked = readProjectRegistration(stateDir, "demo-a1b2c3");
  assert.equal(locked?.rotationState, "handing_over");
  assert.equal(locked?.handoffRequestedAt, "2026-10-19T00:00:00.000Z");
  writeProjectRegistration(stateDir, "demo-a1b2c3", { root: "/w/demo", rotationState: "normal", handoffRequestedAt: null });
  const reset = readProjectRegistration(stateDir, "demo-a1b2c3");
  assert.equal(reset?.rotationState, "normal");
  assert.equal(reset?.handoffRequestedAt, undefined, "null cleared the timestamp");

  // A value that is not one of the three states is ignored, never trusted.
  writeFileSync(join(stateDir, "projects", "demo-a1b2c3", "project.json"), `${JSON.stringify({ root: "/w/demo", rotationState: "bogus" })}\n`);
  assert.equal(readProjectRegistration(stateDir, "demo-a1b2c3")?.rotationState, undefined);
});

test("readLeadContextTokens prefers the daemon's lastUsage and falls back to the Pi session .jsonl", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const snapshotOf = (overrides: Partial<Pick<SurfaceAgentSnapshot, "lastUsage" | "persistence">>): SurfaceAgentSnapshot => ({
    id: "agent-lead-1",
    provider: "pi/zai/glm-5.3",
    title: null,
    status: "idle",
    model: null,
    labels: {},
    archivedAt: null,
    requiresAttention: false,
    attentionReason: null,
    updatedAt: "2026-10-19T00:00:00.000Z",
    cwd: "/tmp",
    ...overrides,
  });

  // Primary: the live daemon snapshot's lastUsage (0 LLM tokens, no 4th role).
  assert.deepEqual(
    readLeadContextTokens(snapshotOf({ lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 } })),
    { usedTokens: 135_000, maxTokens: 200_000, source: "daemon" },
  );

  // Fallback: after a daemon restart lastUsage is gone — the LAST assistant
  // message carrying usage answers, skipping later lines without one, summed
  // as input + output + cacheRead + cacheWrite.
  const session = join(dir, "session.jsonl");
  writeFileSync(
    session,
    [
      JSON.stringify({ type: "message", message: { role: "user", text: "go" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", text: "wip", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 } } }),
      JSON.stringify({ type: "message", message: { role: "assistant", text: "the last word", usage: { input: 1000, output: 2000, cacheRead: 3000, cacheWrite: 4000 } } }),
      JSON.stringify({ type: "message", message: { role: "assistant", text: "no usage on me" } }),
    ].join("\n") + "\n",
  );
  assert.deepEqual(readLeadContextTokens(snapshotOf({ persistence: { nativeHandle: session } })), {
    usedTokens: 10_000,
    maxTokens: null,
    source: "session-file",
  });

  // totalTokens, when the session records it, wins over the component sum.
  const sessionTotal = join(dir, "session-total.jsonl");
  writeFileSync(sessionTotal, `${JSON.stringify({ message: { role: "assistant", usage: { totalTokens: 42, input: 1, output: 1 } } })}\n`);
  assert.deepEqual(readLeadContextTokens(snapshotOf({ persistence: { nativeHandle: sessionTotal } })), {
    usedTokens: 42,
    maxTokens: null,
    source: "session-file",
  });

  // Nothing to read anywhere is a null, never a guess.
  assert.deepEqual(readLeadContextTokens(snapshotOf({})), { usedTokens: null, maxTokens: null, source: "daemon" });
});

test("crossing 128k mid-turn marks rotation_pending without interrupting the running Lead", async (t) => {
  const lead: FakeAgent = {
    id: "agent-lead-1",
    title: "Lead (paseo-factory)",
    status: "running",
    labels: {},
    lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 },
  };
  const { stateDir, slug, fake } = makeSpooledSurface(t, [lead]);
  lead.labels = { seat: "lead", project: slug };

  dropRequest(spoolRootFor(stateDir), { id: "rot-1", kind: "lead_dispatch", project: slug, message: "While I am running" });
  await until(() => {
    assert.equal(readReply(spoolRootFor(stateDir), "rot-1").ok, true);
  });
  const reply = readReply(spoolRootFor(stateDir), "rot-1");

  // The pump observed the running Lead at 135k → rotation_pending, persisted
  // to project.json (the durable record), and the turn kept running.
  assert.equal(reply.rotationState, "rotation_pending", "the dispatch reply reports the pending rotation");
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending");
  assert.equal(lead.status, "running", "the active turn was never interrupted (§User Story 16)");
  assert.equal(fake.sent.length, 0, "nothing was pitched at the running Lead");
  assert.deepEqual(readMailbox(stateDir, slug).map((evt) => evt.type), ["mail_queued"], "the mail stays queued");
});

test("a turn ending at >= 128k acks its batch, locks handing_over, holds arriving mail, and steers the extraction prompt — then handoff completion rotates the Lead end to end", async (t) => {
  const lead: FakeAgent = {
    id: "agent-lead-1",
    title: "Lead (paseo-factory)",
    status: "idle",
    labels: {},
    lastUsage: { contextWindowUsedTokens: 50_000, contextWindowMaxTokens: 200_000 },
  };
  const worker: FakeAgent = { id: "agent-worker-1", status: "running" };
  const { stateDir, slug, projectRoot, factory, surface, leadMail, fake, stopped } = makeSpooledSurface(t, [lead, worker]);
  lead.labels = { seat: "lead", project: slug };
  const spoolRoot = spoolRootFor(stateDir);

  // The registry binding the turn boundary resolves the Lead by: the ensure
  // path writes it (bare — no message, so no delivery of its own).
  const seated = await surface.leadEnsure({ projectRoot });
  assert.ok(seated.ok && seated.agentId === "agent-lead-1", "the seeded Lead is the registered one");

  // The Project's world the successor's roster must preserve: one contracted,
  // dispatched (worktree), claimed task bound to a live worker. The claim's
  // verdict lands as peer mail and — Lead idle, rotation normal — delivers.
  // (The contract's workspace rides git's resolved toplevel, the form the
  // registration's root binding and the roster's scoping compare against.)
  const resolvedRoot = resolveProject(projectRoot);
  assert.ok(resolvedRoot.ok);
  factory.setContract({ task: "T1", workspace: resolvedRoot.ok ? resolvedRoot.root : projectRoot, gate: "true", artifact: "README.md" });
  const sha = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8" }).trim();
  dropRequest(spoolRoot, { id: "rot-spawn", kind: "spawn", task: "T1", provider: "pi/zai/glm-5.3", arity: 1, worktree: taskWorktreePath(stateDir, slug, "T1") });
  await until(() => {
    assert.equal(readReply(spoolRoot, "rot-spawn").ok, true);
  });
  dropRequest(spoolRoot, { id: "rot-claim", kind: "claim", task: "T1", sha, agent: "agent-worker-1" });
  await until(() => {
    assert.equal(readReply(spoolRoot, "rot-claim").ok, true);
  });
  await until(() => {
    assert.deepEqual(
      readMailbox(stateDir, slug).map((evt) => evt.type),
      ["mail_queued", "mail_delivered"],
      "the verdict mail delivered to the idle Lead",
    );
  });

  // (1)+(3): the work turn ends — the Lead crossed 128k during it (the
  // snapshot now reads 135k). The batch acks, the mailbox locks handing_over,
  // and the one bounded extraction prompt goes out.
  lead.lastUsage = { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 };
  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-1", outcome: { kind: "completed" }, timeline: [] });
  let events = readMailbox(stateDir, slug);
  assert.deepEqual(
    events.map((evt) => evt.type),
    ["mail_queued", "mail_delivered", "mail_acked"],
  );
  assert.equal(events[2]?.byAgentId, "agent-lead-1");
  const locked = readProjectRegistration(stateDir, slug);
  assert.equal(locked?.rotationState, "handing_over");
  assert.ok(typeof locked?.handoffRequestedAt === "string" && locked.handoffRequestedAt !== "", "the lock stamps handoffRequestedAt");
  const steer = fake.sent.at(-1);
  assert.ok(steerText(steer).includes(join(projectStateDir(stateDir, slug), "lead-handoff.md")), "the extraction prompt names lead-handoff.md");
  for (const section of ["Goal & Remaining Roadmap", "Uncontracted Next Tasks", "Key Technical Findings", "Open Questions", "Read-First Files"]) {
    assert.ok(steerText(steer).includes(section), `the extraction prompt names the section "${section}"`);
  }
  assert.ok(steerText(steer).includes("Start no new tasks"), "the extraction prompt bounds the turn");

  // Mail arriving under handing_over is held as mail_queued — never delivered.
  dropRequest(spoolRoot, { id: "rot-3", kind: "lead_dispatch", project: slug, message: "Held through the handoff" });
  await until(() => {
    assert.equal(readReply(spoolRoot, "rot-3").ok, true);
  });
  events = readMailbox(stateDir, slug);
  assert.equal(events.at(-1)?.type, "mail_queued", "arriving mail is held under handing_over (§User Story 18)");
  assert.equal(fake.sent.length, 2, "the held mail was not delivered — only the verdict delivery and the extraction steer went out");

  // (2): the extraction turn completes, its assistant text becoming the
  // handoff file — the full archive → successor → reset → drain sequence.
  await leadMail.onLeadTurnEnded({
    agentId: "agent-lead-1",
    outcome: { kind: "completed" },
    timeline: [
      { type: "user_message", text: "extract your handoff" },
      { type: "assistant_message", text: "# Handoff\nGoal: ship the roadmap." },
    ],
  });

  // The fallback write: the turn's assistant text became lead-handoff.md.
  const handoffPath = join(projectStateDir(stateDir, slug), "lead-handoff.md");
  assert.equal(readFileSync(handoffPath, "utf8"), "# Handoff\nGoal: ship the roadmap.");

  // The outgoing Lead was cancelled (best-effort) and archived; the successor
  // is the one live seat=lead agent, and the registry names it.
  assert.ok(stopped.includes("agent-lead-1"), "the retire sequence cancelled the outgoing Lead first");
  const liveLeads = await fake.daemon.agents.list({ filter: { labels: { seat: "lead", project: slug }, includeArchived: false } });
  assert.equal(fake.created.length, 1, "the successor Lead was created");
  const successorId = "agent-created-1";
  assert.equal(liveLeads.entries.length, 1, "the archived Lead is gone");
  assert.equal(liveLeads.entries[0]?.agent.id, successorId);
  assert.equal(readProjectRegistration(stateDir, slug)?.lead, successorId);

  // The successor's kickoff carries the three layers: roster (task ↔ agentId ↔
  // worktree), the ledger digest, and the handoff text.
  const kickoff = fake.sent.find((entry) => entry.agentId === successorId && entry.text.includes("Lead handoff"));
  assert.ok(kickoff, "the successor received the kickoff");
  assert.ok(kickoff.text.includes("T1"), "the roster names the task");
  assert.ok(kickoff.text.includes("agent-worker-1"), "the roster names the bound agent");
  assert.ok(kickoff.text.includes(taskWorktreePath(stateDir, slug, "T1")), "the roster names the Task worktree");
  assert.ok(kickoff.text.includes("factory/T1"), "the roster names the branch");
  assert.ok(kickoff.text.includes("Ledger State Digest"), "the kickoff carries the ledger digest");
  assert.ok(kickoff.text.includes("# Handoff\nGoal: ship the roadmap."), "the kickoff carries the handoff text");

  // Reset + drain: rotation is normal again and the held batch reached the successor.
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "normal");
  events = readMailbox(stateDir, slug);
  const lastDelivery = events.findLast((evt) => evt.type === "mail_delivered");
  assert.equal(lastDelivery?.toAgentId, successorId, "the held batch drained into the successor (§User Story 20)");
  assert.deepEqual(lastDelivery?.mailIds, [events.find((evt) => evt.type === "mail_queued" && evt.text === "Held through the handoff")?.mailId]);
});

test("a failed Lead turn requeues its in-flight batch with the outcome kind as the reason", async (t) => {
  const lead: FakeAgent = {
    id: "agent-lead-1",
    title: "Lead (paseo-factory)",
    status: "idle",
    labels: {},
    lastUsage: { contextWindowUsedTokens: 50_000, contextWindowMaxTokens: 200_000 },
  };
  const { stateDir, slug, leadMail, fake } = makeSpooledSurface(t, [lead]);
  lead.labels = { seat: "lead", project: slug };

  dropRequest(spoolRootFor(stateDir), { id: "rot-4", kind: "lead_dispatch", project: slug, message: "This turn will fail" });
  await until(() => {
    assert.equal(readReply(spoolRootFor(stateDir), "rot-4").ok, true);
  });

  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-1", outcome: { kind: "failed", error: { message: "boom" } }, timeline: [] });

  // The failed turn requeued its batch; under threshold and normal again, the
  // same turn boundary drained it straight back — zero mail lost.
  const events = readMailbox(stateDir, slug);
  assert.deepEqual(
    events.map((evt) => evt.type),
    ["mail_queued", "mail_delivered", "mail_requeued", "mail_delivered"],
  );
  assert.equal(events[2]?.reason, "failed");
  assert.equal(events.filter((evt) => evt.type === "mail_acked").length, 0, "a failed turn never acks");
  assert.equal(fake.sent.length, 2, "the batch was pitched again after the requeue");
});

/** The last send's text — a tiny accessor so a missing steer fails with a message, not a TypeError. */
function steerText(sent: { agentId: string; text: string } | undefined): string {
  assert.ok(sent !== undefined, "a prompt was sent");
  return sent.text;
}
