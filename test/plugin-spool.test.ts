import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import type { ClaimInput } from "../plugin/server/core/factory.ts";
import type { ClaimReported } from "../src/events.ts";
import { resolveProject } from "../plugin/server/core/project.ts";
import { taskWorktreePath } from "../plugin/server/core/workspace.ts";
import { projectStateDir } from "../src/index.ts";
import { saveLanes } from "../src/lanes.ts";
import { readProjectRegistration, writeProjectRegistration } from "../plugin/server/projects.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { handleSpoolRequest, parseSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { createLeadMailRuntime, LEAD_ROTATE_TOKENS, readLeadContextTokens } from "../plugin/server/lead-mailbox.ts";
import { deliverLeadMail as coreDeliver, enqueueLeadMail as coreEnqueue } from "../src/index.ts";
import { disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

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
  const sourceRoot = join(dir, "repo");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "README.md"), "x\n");
  gitCommitAll(sourceRoot);
  const resolved = resolveProject(sourceRoot);
  assert.ok(resolved.ok, "the test project must resolve");
  // Match the production ingress, including macOS /var -> /private/var aliases.
  const projectRoot = resolved.root;
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
  // The two Lead-mailbox doors the surface defers to (index.server.ts's
  // mutual late binding, mirrored): the rotation settle fires on every Lead
  // retire, the dispatch door is the UI's quick-dispatch RPC.
  const surface = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon: fake.daemon,
    stopAgent: async (agentId) => {
      stopped.push(agentId);
      return { ok: true };
    },
    onLeadRetired: (input) => leadMail.settleLeadRotation(input.slug),
    leadDispatch: (request) => leadMail.dispatchLead(request),
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

test("parseSpoolRequest admits the contract's disposition (exactly one of four) and resetPeer (exactly true) — nothing around them", () => {
  const base = { id: "r1", kind: "contract", task: "T-01", workspace: "/w/repo", gate: "true", submitter: "owner" };
  for (const disposition of ["engineer", "architect", "reviewer", "scout"]) {
    assert.deepEqual(parseSpoolRequest({ ...base, disposition }), { ...base, disposition });
  }
  assert.deepEqual(parseSpoolRequest({ ...base, resetPeer: true }), { ...base, resetPeer: true });
  for (const bad of [
    { ...base, disposition: "wizard" }, // not one of the four SLP dispositions
    { ...base, disposition: "" },
    { ...base, disposition: 7 },
    { ...base, resetPeer: false }, // the watch law: exactly true or omitted
    { ...base, resetPeer: "yes" },
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
  const livePeers: FakeAgent[] = [];
  const { stateDir, slug, projectRoot, factory, surface, fake } = makeSpooledSurface(t, livePeers);
  const spoolRoot = spoolRootFor(stateDir);

  // A standing idle Lead (ensured bare — no message, so no delivery of its own).
  const ensured = await surface.leadEnsure({ projectRoot });
  assert.ok(ensured.ok);

  // Two contracted tasks in the Project (disjoint scopes — two tasks share one
  // tree only behind them); a real commit to claim green.
  factory.setContract({ task: "T1", workspace: projectRoot, gate: "true", artifact: "README.md", scope: ["zone-t1"] });
  factory.setContract({ task: "T2", workspace: projectRoot, gate: "true", artifact: "README.md", scope: ["zone-t2"] });
  const sha = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8" }).trim();

  // A Driver round is held only while its dispatched peers are actually live.
  // Missing peers are orphaned rounds and correctly do not block delivery.
  for (const task of ["T1", "T2"]) livePeers.push({ id: `peer-${task}`, status: "running", labels: { seat: "agent", project: slug, task } });

  // The Driver wave opens: both tasks spawn, neither has a verdict yet.
  dropRequest(spoolRoot, { id: "sp-1", kind: "spawn", task: "T1", provider: "pi/zai/glm-5.3", arity: 1 });
  dropRequest(spoolRoot, { id: "sp-2", kind: "spawn", task: "T2", provider: "pi/zai/glm-5.3", arity: 1 });
  await until(() => {
    assert.equal(readReply(spoolRoot, "sp-1").ok, true);
    assert.equal(readReply(spoolRoot, "sp-2").ok, true);
  });

  // T1's verdict lands mid-wave: the peer mail queues, but the wave holds delivery.
  dropRequest(spoolRoot, { id: "cl-1", kind: "claim", handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" }, task: "T1", sha, agent: "agent-worker-1" });
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
  dropRequest(spoolRoot, { id: "cl-2", kind: "claim", handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" }, task: "T2", sha, agent: "agent-worker-2" });
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

  // ADR 0053 Decision 2 / spec Decision 6: a peer needs_human recording routes
  // exclusively to the Lead mailbox — the Supervisor duplicate is never
  // enqueued (only Owner directives and lead_report_to_supervisor wake Supervisor).
  const queuedLines = readMailbox(stateDir, slug).filter((evt) => evt.type === "mail_queued");
  assert.equal(queuedLines.length, 1, "the needs_human recording lands ONE peer mail item");
  assert.equal(queuedLines.filter((evt) => evt.to === "supervisor").length, 0, "no to:supervisor duplicate is enqueued");
});

// ---- direct Lead ruling delivery (ticket 02, ADR 0053 Decision 3) -------------------------

test("parseSpoolRequest admits the repoke's optional message — a non-empty string passes, an empty one drops to the omitted spelling, a wrong type refuses", () => {
  const base = { id: "r1", kind: "repoke", task: "T-02", agent: "ag-worker" };
  assert.deepEqual(parseSpoolRequest({ ...base, message: "Ruling: the facade owns the retry policy." }), {
    ...base,
    message: "Ruling: the facade owns the retry policy.",
  });
  // Empty or whitespace-only is the omitted spelling: the Denial-stall
  // continuation, byte-identical to today (acceptance criterion 3).
  assert.deepEqual(parseSpoolRequest({ ...base, message: "" }), { ...base });
  assert.deepEqual(parseSpoolRequest({ ...base, message: "   " }), { ...base });
  for (const bad of [
    { ...base, message: 7 },
    { ...base, message: { text: "ruling" } },
    { ...base, message: ["ruling"] },
  ]) {
    assert.equal(parseSpoolRequest(bad), undefined, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("a message-bearing repoke delivers the Lead's ruling into the live Peer session across reconciliation turns — never repoke:already-spent — and never persists the message body (ticket 02, ADR 0053 Decision 3)", async (t) => {
  const { projectRoot, factory, fake } = makeSpooledSurface(t, [{ id: "ag-live", status: "idle", labels: { seat: "agent" } }]);
  const deps = { daemon: fake.daemon };
  // The reconciliation premise: the Lead re-briefs in place (ticket 01), then
  // rules into the SAME live Peer session (this ticket).
  factory.setContract({ task: "T-RP", workspace: projectRoot, gate: "npm run gate", description: "Brief v1: land the adapter boundary.", disposition: "architect" });
  factory.setContract({ task: "T-RP", workspace: projectRoot, gate: "npm run gate", artifact: "README.md", description: "Brief v2 (reconciled): the facade owns the retry policy.", disposition: "engineer" });

  const ruling = "Ruling (REOPEN_REQUEST foundation): the facade owns the retry policy — drop the caller-side backoff.";
  const first = await handleSpoolRequest(factory, { id: "mrp-1", kind: "repoke", task: "T-RP", agent: "ag-live", message: ruling, seat: "lead" }, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(fake.sent.length, 1, "the ruling was delivered to the live Peer session");
  assert.equal(fake.sent[0]?.agentId, "ag-live");
  const delivered = fake.sent[0]?.text ?? "";
  assert.ok(delivered.includes(ruling), "the delivered text carries the Lead's message verbatim");
  assert.ok(delivered.includes("T-RP"), "the task context prefixes the ruling");
  assert.ok(delivered.includes("engineer"), "the reconciled disposition rides the prefix");
  assert.ok(delivered.includes("Brief v2 (reconciled): the facade owns the retry policy."), "the updated Brief is named after the lead_set_contract reconciliation");

  // Multiple reconciliation turns: the second and third message-bearing
  // repokes each dispatch — the already-spent cap never fires (criterion 2).
  const second = await handleSpoolRequest(factory, { id: "mrp-2", kind: "repoke", task: "T-RP", agent: "ag-live", message: "Second turn: proceed with the in-place retry loop.", seat: "lead" }, deps);
  assert.equal(second.ok, true, JSON.stringify(second));
  const third = await handleSpoolRequest(factory, { id: "mrp-3", kind: "repoke", task: "T-RP", agent: "ag-live", message: "Third turn: green the gate now.", seat: "lead" }, deps);
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(fake.sent.length, 3, "every reconciliation turn delivered");

  const dispatched = factory.ledger.eventsFor("T-RP").filter((e) => e.event === "repoke_dispatched");
  assert.equal(dispatched.length, 3, "each turn lands its own repoke_dispatched line");
  assert.ok(
    dispatched.every((e) => !("message" in e)),
    "the message body is delivery-only — never persisted on the ledger line",
  );

  // The message-less cap stays verbatim: with the spend marker present, a bare
  // repoke is refused already-spent (criterion 3).
  const bare = await handleSpoolRequest(factory, { id: "mrp-4", kind: "repoke", task: "T-RP", agent: "ag-live", seat: "lead" }, deps);
  assert.equal(bare.ok, false);
  assert.equal(bare.code, "already-spent");
  assert.equal(fake.sent.length, 3, "a refused repoke sends nothing");
});

test("a message-less repoke (omitted or empty) sends today's fixed continuation nudge and keeps the one-per-task spend (ticket 02)", async (t) => {
  const { projectRoot, factory, fake } = makeSpooledSurface(t, [{ id: "ag-stall", status: "idle", labels: { seat: "agent" } }]);
  const deps = { daemon: fake.daemon };
  factory.setContract({ task: "T-STALL", workspace: projectRoot, gate: "npm test", artifact: "README.md" });

  const first = await handleSpoolRequest(factory, { id: "srp-1", kind: "repoke", task: "T-STALL", agent: "ag-stall", seat: "lead" }, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.summary, "re-poke dispatched for T-STALL → agent ag-stall — the task's one spend");
  assert.deepEqual(fake.sent, [
    {
      agentId: "ag-stall",
      text: "Re-poke from Lead on task T-STALL: continue inside your Task worktree on branch factory/T-STALL, run the gate `npm test`, commit your changes, and call `paseo-factory_agent_claim` (or `agent_claim`).",
    },
  ]);

  // The empty-string message is the omitted spelling — and the one-per-task
  // cap refuses it exactly like a bare second repoke.
  const emptyMessage = await handleSpoolRequest(factory, { id: "srp-2", kind: "repoke", task: "T-STALL", agent: "ag-stall", message: "", seat: "lead" }, deps);
  assert.equal(emptyMessage.ok, false);
  assert.equal(emptyMessage.code, "already-spent");
  assert.equal(factory.ledger.eventsFor("T-STALL").filter((e) => e.event === "repoke_dispatched").length, 1, "exactly one dispatch line — the Denial-stall spend");
});

/** Runs the real factory CLI as a subprocess — async on purpose: the in-process spool poll must keep running while the CLI waits for its reply. */
function runFactoryCli(args: string[], extraEnv: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repoRoot, "plugin", "bin", "factory.mjs"), ...args], {
      env: { ...process.env, PASEO_AGENT_ID: "", PASEO_FACTORY_CORRELATION: "", PASEO_FACTORY_SEAT: "", ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("factory repoke --task <id> --message <ruling> round-trips the CLI → spool → daemon send; without --message it preserves the Denial-stall summary (ticket 02)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const resolved = resolveProject(root);
  assert.ok(resolved.ok, "the test project must resolve");
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });
  factory.setContract({ task: "T-CLI", workspace: resolved.root, gate: "npm test", artifact: "README.md", scope: ["zone-1"], description: "Brief: the CLI ruling round-trip." });
  factory.setContract({ task: "T-CLI2", workspace: resolved.root, gate: "npm test", artifact: "README.md", scope: ["zone-2"] });
  const fake = fakeDaemon([{ id: "ag-cli", status: "idle", labels: { seat: "agent" } }]);
  const spool = startSpool(stateDir, factory, { pollMs: POLL_MS, daemon: fake.daemon });
  t.after(() => spool.stop());

  // A Lead-shell invocation: the env-stamped seat rides the spool request,
  // which is what unlocks the daemon send in the handler.
  const withMessage = await runFactoryCli(
    ["--home", home, "repoke", "--task", "T-CLI", "--agent", "ag-cli", "--message", "Ruling: the CLI carries the Lead's word into the live session."],
    { PASEO_FACTORY_SEAT: "lead" },
  );
  assert.equal(withMessage.status, 0, withMessage.stderr);
  assert.match(withMessage.stdout, /re-poke dispatched for T-CLI/);
  assert.match(withMessage.stdout, /ruling delivered/i);
  assert.equal(fake.sent.length, 1, "the ruling was daemon-sent to the bound agent");
  assert.equal(fake.sent[0]?.agentId, "ag-cli");
  assert.ok(fake.sent[0]?.text.includes("Ruling: the CLI carries the Lead's word into the live session."), "the delivered text carries the ruling verbatim");
  assert.ok(factory.ledger.eventsFor("T-CLI").some((e) => e.event === "repoke_dispatched"), "the dispatch line landed");

  // Without --message: today's Denial-stall continuation summary, verbatim.
  const bare = await runFactoryCli(["--home", home, "repoke", "--task", "T-CLI2", "--agent", "ag-cli"], { PASEO_FACTORY_SEAT: "lead" });
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /re-poke dispatched for T-CLI2 → agent ag-cli — the task's one spend/);
  assert.equal(factory.ledger.eventsFor("T-CLI2").filter((e) => e.event === "repoke_dispatched").length, 1, "the bare repoke spent the task's one re-poke");
});

// ---- peer challenge routing (ADR 0053 Decision 2, spec Decision 6) ------------------------

test("a Peer challenge (agent_escalate_blocker) queues kind peer_challenge to the Lead mailbox only — no needs_human Ledger line, no Supervisor item", async (t) => {
  const { stateDir, slug, projectRoot, factory } = makeSpooledSurface(t);
  const spoolRoot = spoolRootFor(stateDir);

  factory.setContract({ task: "T9", workspace: projectRoot, gate: "true", artifact: "README.md" });
  const challenge = "REOPEN_REQUEST (foundation): the Brief assumes src/legacy-adapter.ts exports buildFacade(); no such module exists on HEAD. Alternative: run a scout turn to contract the adapter boundary before re-briefing.";
  dropRequest(spoolRoot, {
    id: "ch-1",
    kind: "lead_dispatch",
    project: slug,
    task: "T9",
    from: "peer",
    seat: "agent",
    message: `[Blocker on task T9] ${challenge}`,
  });
  await until(() => {
    assert.equal(readReply(spoolRoot, "ch-1").ok, true, "the challenge dispatch replied ok");
  });

  const lines = readMailbox(stateDir, slug);
  const queuedMail = lines.filter((evt) => evt.type === "mail_queued");
  assert.equal(queuedMail.length, 1, "exactly one mail item — the challenge itself");
  const challengeMail = queuedMail[0];
  assert.equal(challengeMail.from, "peer");
  assert.equal(challengeMail.kind, "peer_challenge");
  assert.equal(challengeMail.to, "lead");
  assert.equal(challengeMail.task, "T9", "the mail names the challenged Task");
  assert.ok(String(challengeMail.text).includes("REOPEN_REQUEST (foundation)"), "the mail carries the challenge text");
  assert.equal(lines.filter((evt) => evt.to === "supervisor").length, 0, "no Supervisor item is ever enqueued by a Peer challenge");

  // A challenge is a technical reconciliation turn between Peer and Lead, never
  // a Needs-human fact: the Ledger records no needs_human event.
  const ledgerLines = readFileSync(join(stateDir, "ledger.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledgerLines.some((evt) => evt.event === "needs_human"), false, "no needs_human event is appended by a Peer challenge");
});

test("a queued peer_challenge settles its Task for the rotation quiet-point — the work is back in the Lead's court even while the Peer's escalate turn is still returning", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-1", title: "Lead (paseo-factory)", status: "idle", labels: {}, lastUsage: { contextWindowUsedTokens: 135_000, contextWindowMaxTokens: 200_000 } };
  const peer: FakeAgent = { id: "peer-t5", status: "running", labels: {} };
  const { stateDir, slug, projectRoot, factory, surface, leadMail } = makeSpooledSurface(t, [lead, peer]);
  lead.labels = { seat: "lead", project: slug };
  const resolved = resolveProject(projectRoot);
  assert.ok(resolved.ok, "the test project must resolve");
  const seated = await surface.leadEnsure({ projectRoot });
  assert.ok(seated.ok && seated.agentId === "agent-lead-1", "the seeded Lead is the registered one");

  factory.setContract({ task: "T5", workspace: resolved.ok ? resolved.root : projectRoot, gate: "true", artifact: "README.md" });
  // The Peer is bound to the Task through its seat labels (boundTaskPeers' label arm).
  peer.labels = { seat: "agent", project: slug, task: "T5" };
  peer.cwd = taskWorktreePath(stateDir, slug, "T5");

  // The Lead crossed 128k and its turn ended while the Peer is still inside its
  // active turn: rotation_pending holds (v0.2.2, ADR 0050 §1's durable arm).
  await leadMail.onLeadTurnEnded({ agentId: "agent-lead-1", outcome: { kind: "completed" }, timeline: [] });
  assert.equal(readProjectRegistration(stateDir, slug)?.rotationState, "rotation_pending", "a running bound Peer holds the rotation");

  // The Peer challenges a Brief premise from inside that still-returning turn
  // (peer.status === "running"): the challenge queues durably — the mailbox is
  // held under rotation — and the Task settles into the Lead's court.
  dropRequest(spoolRootFor(stateDir), {
    id: "qp-ch",
    kind: "lead_dispatch",
    project: slug,
    task: "T5",
    from: "peer",
    seat: "agent",
    message: "[Blocker on task T5] DEPENDENCY_REQUEST: the upstream contract's artifact path does not exist; alternative: re-contract the dependency wave first.",
  });
  await until(() => {
    assert.equal(readReply(spoolRootFor(stateDir), "qp-ch").ok, true);
  });
  const challenge = readMailbox(stateDir, slug).find((evt) => evt.type === "mail_queued" && evt.kind === "peer_challenge");
  assert.ok(challenge, "the challenge is durably queued in mailbox.jsonl");

  await leadMail.sweepPeers();
  assert.notEqual(
    readProjectRegistration(stateDir, slug)?.rotationState,
    "rotation_pending",
    "a queued kind:peer_challenge item releases the rotation quiet-point — the ruling is the Lead's now (spec Decision 6)",
  );
});

// ---- the offline deduplication drain (v0.0.31, ADR 0017 §6) --------------------------------

test("startSpool deduplicates pre-seeded duplicate claim files into ONE Gate attempt with mirrored replies for the duplicate ids", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const projectRoot = join(dir, "repo");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "README.md"), "x\n");
  gitCommitAll(projectRoot);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  factory.setContract({ task: "DEDUP-B", workspace: projectRoot, gate: "true", artifact: "README.md" });
  const sha = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8" }).trim();

  const spoolRoot = spoolRootFor(stateDir);
  // The offline window's residue, exactly the spec's Problem 5 stack: three
  // identical claim files already sitting in spool/requests/ before boot,
  // each with its own id.
  const ids = ["dup-a", "dup-b", "dup-c"];
  for (const id of ids) {
    dropRequest(spoolRoot, { id, kind: "claim", handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" }, task: "DEDUP-B", sha });
  }

  const spool = startSpool(stateDir, factory, { pollMs: POLL_MS });
  t.after(() => spool.stop());

  await until(() => {
    for (const id of ids) assert.ok(existsSync(join(spoolRoot, "replies", `${id}.json`)), `reply for ${id} landed`);
  });

  // ONE Gate attempt: a single claim round against the contract, attempt 1.
  assert.deepEqual(
    factory.ledger.eventsFor("DEDUP-B").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
    "exactly one claim round — no second Gate, no second Ledger mutation",
  );
  const primary = readReply(spoolRoot, "dup-a"); // filename order makes dup-a the primary
  assert.equal(primary.ok, true);
  assert.equal(primary.attempt, 1);
  assert.equal(primary.verdict, "green");

  // The duplicates' replies are mirrored from the primary under their own ids.
  for (const dup of ["dup-b", "dup-c"]) {
    const mirrored = readReply(spoolRoot, dup);
    assert.equal(mirrored.id, dup, "the mirrored reply carries the duplicate's own id");
    assert.equal(mirrored.ok, primary.ok);
    assert.equal(mirrored.attempt, primary.attempt);
    assert.equal(mirrored.verdict, primary.verdict);
    assert.equal(mirrored.summary, primary.summary);
    assert.ok(existsSync(join(spoolRoot, "processed", `${dup}.json`)), `${dup} moved to processed/`);
  }
  assert.ok(existsSync(join(spoolRoot, "processed", "dup-a.json")), "the primary moved to processed/");
  assert.deepEqual(
    readdirSync(join(spoolRoot, "requests")).filter((name) => name.endsWith(".json")),
    [],
    "the drained queue is empty",
  );
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
  factory.setContract({ task: "T1", workspace: resolvedRoot.ok ? resolvedRoot.root : projectRoot, gate: "true", disposition: "scout" });
  const sha = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8" }).trim();
  dropRequest(spoolRoot, { id: "rot-spawn", kind: "spawn", task: "T1", provider: "pi/zai/glm-5.3", arity: 1, worktree: taskWorktreePath(stateDir, slug, "T1") });
  await until(() => {
    assert.equal(readReply(spoolRoot, "rot-spawn").ok, true);
  });
  dropRequest(spoolRoot, { id: "rot-claim", kind: "claim", handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" }, task: "T1", sha, agent: "agent-worker-1" });
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
  assert.match(steerText(steer), /entire Markdown handoff directly in your final assistant message, in one piece/);
  assert.match(steerText(steer), /without running shell commands or writing files to disk/);
  assert.match(steerText(steer), /plugin server reads your reply and persists it automatically/);
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
  assert.ok(kickoff.text.includes("disposition scout"), "the roster row carries the active disposition (ADR 0053 §3)");
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

// ---- the rotation settle (ADR 0013 Decision 3's last arm — lead-rotated) ------------------

test("a manual lead rotate requeues the un-acked in-flight delivery with reason lead-rotated — delayed to the next Lead, never stranded", async (t) => {
  const lead: FakeAgent = { id: "agent-lead-1", title: "Lead (paseo-factory)", status: "idle", labels: {} };
  const { stateDir, slug, projectRoot, surface, fake, stopped } = makeSpooledSurface(t, [lead]);
  lead.labels = { seat: "lead", project: slug };

  // The delivery goes live to the idle Lead (an un-acked inFlight batch), then
  // the Owner rotates the seat mid-flight — the manual door, off the lane.
  dropRequest(spoolRootFor(stateDir), { id: "man-1", kind: "lead_dispatch", project: slug, message: "Mid-flight directive" });
  await until(() => {
    assert.deepEqual(readMailbox(stateDir, slug).map((evt) => evt.type), ["mail_queued", "mail_delivered"], "the directive delivered to the idle Lead");
  });

  const rotated = await surface.leadRotate({ projectRoot });
  assert.ok(rotated.ok, "the manual rotate retired the seat");
  assert.ok(stopped.includes("agent-lead-1"), "the retire sequence cancelled the outgoing Lead first");

  // The rotation settle: a retired Lead can never ack, so the un-acked batch
  // returned to queued as exactly one mail_requeued (reason lead-rotated).
  let events = readMailbox(stateDir, slug);
  assert.deepEqual(
    events.map((evt) => evt.type),
    ["mail_queued", "mail_delivered", "mail_requeued"],
  );
  assert.equal(events[2]?.reason, "lead-rotated");
  assert.equal(events[2]?.deliveryId, events[1]?.deliveryId, "the requeue settles the live delivery");
  assert.deepEqual(events[2]?.mailIds, events[1]?.mailIds, "the requeue returns the whole batch");

  // Delayed, not lost: the next dispatch auto-ensures a fresh Lead and the
  // held directive rides the same delivery as the new one.
  dropRequest(spoolRootFor(stateDir), { id: "man-2", kind: "lead_dispatch", project: slug, message: "After the rotation" });
  await until(() => {
    assert.equal(readReply(spoolRootFor(stateDir), "man-2").ok, true);
  });
  assert.equal(readReply(spoolRootFor(stateDir), "man-2").leadAgentId, "agent-created-1", "the dispatch ensured the fresh Lead");
  events = readMailbox(stateDir, slug);
  const second = events.findLast((evt) => evt.type === "mail_delivered");
  assert.equal(second?.toAgentId, "agent-created-1", "the fresh Lead received the batch");
  assert.equal(fake.created.length, 1, "the rotation's successor is the one created Lead");
  const requeuedIds = events[2]?.mailIds as string[] | undefined;
  const carried = second?.mailIds as string[] | undefined;
  assert.ok(
    requeuedIds !== undefined && carried !== undefined && requeuedIds.every((id) => carried.includes(id)),
    "the requeued directive rode the new delivery — zero mail lost",
  );
  assert.equal(fake.sent.filter((entry) => entry.agentId === "agent-created-1").length, 1, "one prompt carried the batch");
});

// ---- the single-writer lane around the dispatch's ensure (the module's own claim) ----------

test("two concurrent lead_dispatch requests serialize on the Project lane — one Lead seat, one consolidated delivery", async (t) => {
  const { stateDir, slug, leadMail, fake } = makeSpooledSurface(t);

  const [first, second] = await Promise.all([
    leadMail.dispatchLead({ id: "conc-1", kind: "lead_dispatch", project: slug, message: "first directive" }),
    leadMail.dispatchLead({ id: "conc-2", kind: "lead_dispatch", project: slug, message: "second directive" }),
  ]);

  assert.ok(first.ok && second.ok, "both dispatches replied ok");
  assert.equal(fake.created.length, 1, "the lane serialized the ensures — exactly one Lead seat was created");
  assert.equal(first.leadAgentId, second.leadAgentId, "both dispatches name the same Lead");

  const events = readMailbox(stateDir, slug);
  assert.equal(events.filter((evt) => evt.type === "mail_queued").length, 2, "both directives queued");
  const deliveries = events.filter((evt) => evt.type === "mail_delivered");
  assert.equal(deliveries.length, 1, "one consolidated delivery carried the batch");
  assert.equal((deliveries[0]?.mailIds as string[] | undefined)?.length, 2);
  assert.equal(fake.sent.length, 1, "one prompt pitched the whole batch");
});

// ---- the UI quick-dispatch door (ADR 0013 Decision 4's third internal caller) --------------

test("the surface's leadDispatch RPC rides the same mailbox pipeline as the spool — and refuses by name without the runtime", async (t) => {
  const { stateDir, slug, projectRoot, surface, fake, dir } = makeSpooledSurface(t);

  const reply = await surface.leadDispatch({ projectRoot, message: "From the UI" });
  assert.ok(reply.ok, "the UI dispatch replied ok");
  if (reply.ok) {
    assert.equal(reply.project, slug);
    assert.equal(reply.leadAgentId, "agent-created-1", "the pipeline auto-ensured the Lead");
    assert.equal(reply.rotationState, "normal");
    assert.equal(typeof reply.mailId, "string");
    assert.ok(reply.summary.includes(slug), "the summary names the Project");
  }

  // The same enqueueLeadMail + pumpProjectLead facts the spool's door shows.
  assert.deepEqual(
    readMailbox(stateDir, slug).map((evt) => evt.type),
    ["mail_queued", "mail_delivered"],
  );
  assert.equal(fake.sent.length, 1);
  assert.ok(fake.sent[0]?.text.includes("From the UI"));

  // A surface built without the runtime door refuses by name (the spool's
  // lead-dispatch-unavailable precedent), never a silent pass.
  const bare = createSurfaceHandlers({
    factory: createFactory({ stateDir: join(dir, "bare-state") }),
    stateDir: join(dir, "bare-state"),
    home: dir,
    daemon: fake.daemon,
  });
  const refused = await bare.leadDispatch({ projectRoot, message: "x" });
  assert.ok(!refused.ok);
  assert.equal(refused.code, "lead-dispatch-unavailable");
});

/** The last send's text — a tiny accessor so a missing steer fails with a message, not a TypeError. */
function steerText(sent: { agentId: string; text: string } | undefined): string {
  assert.ok(sent !== undefined, "a prompt was sent");
  return sent.text;
}

// ---- Seam 1 (v0.0.89, ADR 0045 §1): the file-based spool over the Per-Project Factory registry ----

import { createFactoryRegistry } from "../plugin/server/projects.ts";
import { resolveProject as resolveCoreProject, writeProjectRegistration as writeCoreRegistration } from "../plugin/server/core/project.ts";
import { CorrelationRegistry } from "../plugin/server/core/correlations.ts";

/**
 * The production wiring in miniature, twice over: two registered Projects,
 * one Per-Project Factory registry, the surface handlers, and the file-based
 * spool watcher — `startSpool(stateDir, registry.root, { registry, ... })`,
 * exactly the shape `plugin/index.server.ts` wires since v0.0.89. Both
 * Projects contract and claim the SAME Task id (`T-01`) through their own
 * dropped request files, concurrently.
 */
function makeTwinSpool(t: TestContext) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const projects: { root: string; slug: string }[] = [];
  for (const name of ["project-a", "project-b"]) {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "README.md"), "x\n");
    gitCommitAll(root);
    const resolved = resolveCoreProject(root);
    assert.ok(resolved.ok, `${name} must resolve`);
    writeCoreRegistration(stateDir, resolved.slug, { root: resolved.root });
    projects.push({ root: resolved.root, slug: resolved.slug });
  }
  const registry = createFactoryRegistry({ stateDir });
  t.after(() => registry.stop());
  const fake = fakeDaemon([]);
  const surface = createSurfaceHandlers({
    factory: registry.root,
    registry,
    stateDir,
    home,
    daemon: fake.daemon,
    stopAgent: async () => ({ ok: true }),
    cleanupDaemonWorkspaces: async () => ({ ok: true, removedWorkspaceIds: [], removedProjectIds: [] }),
  });
  const spool = startSpool(stateDir, registry.root, {
    pollMs: POLL_MS,
    registry,
    projectReset: async (request) => {
      const reply = await surface.projectReset({
        ...(request.workspace !== undefined ? { projectRoot: request.workspace } : {}),
        ...(request.project !== undefined ? { project: request.project } : {}),
        ...(request.keepSeats !== undefined ? { keepSeats: request.keepSeats } : {}),
      });
      return reply.ok
        ? { id: request.id, ok: true as const, summary: reply.summary, project: reply.project, purgedEvents: reply.purgedEvents, tasks: reply.tasks }
        : { id: request.id, ok: false as const, code: reply.code, message: reply.error };
    },
  });
  t.after(() => spool.stop());
  return { dir, home, stateDir, registry, surface, spool, projects, fake };
}

test("Seam 1: two Projects contract and claim the same Task id through dropped spool files — and the reset of one leaves the other untouched", async (t) => {
  const { stateDir, registry, projects } = makeTwinSpool(t);
  const [a, b] = projects;

  // Both Projects' Contracts drop concurrently — one request file each.
  dropRequest(spoolRootFor(stateDir), { id: "c-a", kind: "contract", task: "T-01", workspace: a.root, gate: "true", artifact: "README.md", submitter: "owner" });
  dropRequest(spoolRootFor(stateDir), { id: "c-b", kind: "contract", task: "T-01", workspace: b.root, gate: "true", artifact: "README.md", submitter: "owner" });
  await until(() => {
    assert.equal(readReply(spoolRootFor(stateDir), "c-a").ok, true, "project-a's contract replies ok");
    assert.equal(readReply(spoolRootFor(stateDir), "c-b").ok, true, "project-b's contract replies ok");
  });

  // The Peers' Correlation bindings route their concurrent claims.
  const correlations = new CorrelationRegistry(stateDir);
  correlations.issue({ role: "agent", projectSlug: a.slug, projectRoot: a.root, task: "T-01", agentId: "peer-a" });
  correlations.issue({ role: "agent", projectSlug: b.slug, projectRoot: b.root, task: "T-01", agentId: "peer-b" });
  writeFileSync(join(a.root, "work.txt"), "a\n");
  writeFileSync(join(b.root, "work.txt"), "b\n");
  const shaA = gitCommitAll(a.root, "work-a");
  const shaB = gitCommitAll(b.root, "work-b");
  dropRequest(spoolRootFor(stateDir), { id: "cl-a", kind: "claim", handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" }, task: "T-01", sha: shaA, agent: "peer-a" });
  dropRequest(spoolRootFor(stateDir), { id: "cl-b", kind: "claim", handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" }, task: "T-01", sha: shaB, agent: "peer-b" });
  await until(() => {
    assert.equal(readReply(spoolRootFor(stateDir), "cl-a").verdict, "green", "project-a's claim ends green");
    assert.equal(readReply(spoolRootFor(stateDir), "cl-b").verdict, "green", "project-b's claim ends green");
  });

  // Every event and artifact lives strictly under the owning Project's directory.
  for (const project of [a, b]) {
    const projectDir = projectStateDir(stateDir, project.slug);
    const ledger = readFileSync(join(projectDir, "ledger.jsonl"), "utf8").trim().split("\n");
    assert.ok(ledger.some((line) => JSON.parse(line).event === "contract_set"), `${project.slug}: contract in its own ledger`);
    assert.ok(ledger.some((line) => JSON.parse(line).event === "gate_finished"), `${project.slug}: verdict in its own ledger`);
    assert.ok(existsSync(join(projectDir, "report-T-01-1.md")), `${project.slug}: report in its own directory`);
    assert.ok(existsSync(join(projectDir, "gate-T-01-1.log")), `${project.slug}: gate log in its own directory`);
  }
  assert.ok(!existsSync(join(stateDir, "ledger.jsonl")), "no root ledger exists");

  // An unscoped request naming the shared Task id refuses by name through the
  // file protocol too — never a guess onto the wrong Project.
  dropRequest(spoolRootFor(stateDir), { id: "sp-amb", kind: "spawn", task: "T-01", provider: "pi/zai/glm-5.3", arity: 1 });
  await until(() => {
    const reply = readReply(spoolRootFor(stateDir), "sp-amb");
    assert.equal(reply.ok, false);
    assert.equal(reply.code, "ambiguous-task-project");
  });

  // The reset of project-a (via the spool's reset kind, keepSeats) leaves
  // project-b's ledger byte-for-byte untouched.
  const ledgerBBefore = readFileSync(join(projectStateDir(stateDir, b.slug), "ledger.jsonl"), "utf8");
  dropRequest(spoolRootFor(stateDir), { id: "rst-a", kind: "reset", project: a.slug, keepSeats: true });
  await until(() => {
    assert.equal(readReply(spoolRootFor(stateDir), "rst-a").ok, true, "project-a resets ok");
  });
  assert.equal(
    readFileSync(join(projectStateDir(stateDir, b.slug), "ledger.jsonl"), "utf8"),
    ledgerBBefore,
    "project-b's ledger bytes are untouched by project-a's reset",
  );
  assert.ok(existsSync(join(projectStateDir(stateDir, b.slug), "report-T-01-1.md")), "project-b's report survives");
  assert.ok(
    !existsSync(join(projectStateDir(stateDir, a.slug), "report-T-01-1.md")),
    "project-a's own report is purged",
  );
});

// ---- Seam 1 (ADR 0053 §1/§3): disposition rides the contract, and a re-contract preserves the live Peer ----

/**
 * The ADR 0053 In-Place Brief Reconciliation seam: one registered Project,
 * the Per-Project Factory registry, and the file-based spool watching with a
 * daemon carrying a live bound Peer — `lead_set_contract` re-contracting an
 * unaccepted Task must update the Brief/Gate in place and PRESERVE the bound
 * Peer (no stop, no archive) unless `resetPeer: true` is explicit or the
 * bound Peer is in `error` state, and the `disposition` field must ride the
 * `contract_set` ledger lines (omitted = engineer everywhere it is read).
 */
test("Seam 1 (ADR 0053): a re-contract preserves the live bound Peer by default, resets it on resetPeer, retires an error-state Peer, and disposition rides the contract_set lines", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const resolved = resolveCoreProject(root);
  assert.ok(resolved.ok, "the test project must resolve");
  writeCoreRegistration(stateDir, resolved.slug, { root: resolved.root });
  const slug = resolved.slug;
  const registry = createFactoryRegistry({ stateDir });
  t.after(() => registry.stop());

  // A live Peer bound to T-01 through its Task worktree cwd (the
  // boundTaskPeers path match) and its task/project labels.
  const peerCwd = taskWorktreePath(stateDir, slug, "T-01");
  const agents: FakeAgent[] = [
    { id: "peer-1", status: "idle", provider: "pi/zai/glm-5.3", cwd: peerCwd, labels: { task: "T-01", project: slug } },
  ];
  const fake = fakeDaemon(agents);
  const stopped: string[] = [];
  const spool = startSpool(stateDir, registry.root, {
    pollMs: POLL_MS,
    registry,
    home,
    daemon: fake.daemon,
    stopAgent: async (agentId) => {
      stopped.push(agentId);
      return { ok: true };
    },
  });
  t.after(() => spool.stop());

  const contractLines = () =>
    readFileSync(join(projectStateDir(stateDir, slug), "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((e) => e.event === "contract_set");
  const listedPeerIds = async () => {
    const page = await fake.daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
    return page.entries.map((entry) => entry.agent.id);
  };

  // 1. The first Contract carries the scout disposition onto its contract_set line.
  dropRequest(spoolRootFor(stateDir), { id: "c-1", kind: "contract", task: "T-01", workspace: resolved.root, gate: "true", disposition: "scout", submitter: "owner" });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "c-1").ok, true, "the scout contract replies ok"));
  assert.equal(contractLines().at(-1)?.disposition, "scout", "the contract_set line carries disposition: scout");
  assert.equal(contractLines().at(-1)?.description, undefined);

  // 2. Re-contract with resetPeer omitted: the Brief/Gate update in place and
  //    the live bound Peer survives — no stop, no archive.
  dropRequest(spoolRootFor(stateDir), { id: "c-2", kind: "contract", task: "T-01", workspace: resolved.root, gate: "true", artifact: "README.md", description: "Reconciled brief after the Peer's challenge", submitter: "owner" });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "c-2").ok, true, "the default re-contract replies ok"));
  const epochTwo = contractLines();
  assert.equal(epochTwo.length, 2, "a fresh contract_set epoch landed");
  assert.equal(epochTwo.at(-1)?.description, "Reconciled brief after the Peer's challenge", "the new epoch carries the reconciled Brief");
  assert.equal(epochTwo.at(-1)?.disposition, undefined, "an omitted disposition is recorded omitted — it reads as engineer");
  assert.ok((await listedPeerIds()).includes("peer-1"), "the bound Peer is still listed (non-archived) after the in-place re-contract");
  assert.deepEqual(stopped, [], "no stop was attempted on the preserved Peer");

  // 3. resetPeer: true cancels and archives the prior Peer exactly as the
  //    pre-0053 law did — observable as the archived agent plus the fresh epoch.
  dropRequest(spoolRootFor(stateDir), { id: "c-3", kind: "contract", task: "T-01", workspace: resolved.root, gate: "true", disposition: "reviewer", resetPeer: true, submitter: "owner" });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "c-3").ok, true, "the reset re-contract replies ok"));
  await until(() => assert.deepEqual(stopped, ["peer-1"], "the prior Peer was stopped"));
  assert.ok(!(await listedPeerIds()).includes("peer-1"), "the prior Peer is archived");
  assert.equal(contractLines().at(-1)?.disposition, "reviewer", "the fresh epoch carries the reviewer disposition");

  // 4. A bound Peer in error state is retired even without resetPeer — the
  //    preservation branch never keeps a dead session.
  agents.push({ id: "peer-2", status: "error", provider: "pi/zai/glm-5.3", cwd: peerCwd, labels: { task: "T-01", project: slug } });
  dropRequest(spoolRootFor(stateDir), { id: "c-4", kind: "contract", task: "T-01", workspace: resolved.root, gate: "true", artifact: "README.md", submitter: "owner" });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "c-4").ok, true, "the error-peer re-contract replies ok"));
  await until(() => assert.deepEqual(stopped, ["peer-1", "peer-2"], "the error-state Peer was stopped"));
  assert.ok(!(await listedPeerIds()).includes("peer-2"), "the error-state Peer is archived");
  assert.equal(contractLines().length, 4, "the fourth contract_set epoch landed");

  // 5. A MIXED roster (one live + one error bound Peer): the preservation is
  //    per-Peer — the dead one is cancelled and archived, the live one keeps
  //    its session; the whole roster is never preserved nor reset together.
  agents.push(
    { id: "peer-3", status: "idle", provider: "pi/zai/glm-5.3", cwd: peerCwd, labels: { task: "T-01", project: slug } },
    { id: "peer-4", status: "error", provider: "pi/zai/glm-5.3", cwd: peerCwd, labels: { task: "T-01", project: slug } },
  );
  dropRequest(spoolRootFor(stateDir), { id: "c-5", kind: "contract", task: "T-01", workspace: resolved.root, gate: "true", artifact: "README.md", submitter: "owner" });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "c-5").ok, true, "the mixed-roster re-contract replies ok"));
  await until(() => assert.deepEqual(stopped, ["peer-1", "peer-2", "peer-4"], "only the error-state Peer of the mixed roster was stopped"));
  assert.ok(!(await listedPeerIds()).includes("peer-4"), "the mixed roster's error-state Peer is archived");
  assert.ok((await listedPeerIds()).includes("peer-3"), "the mixed roster's live Peer is preserved");
  assert.equal(contractLines().length, 5, "the fifth contract_set epoch landed");
});

test("Seam 1 (ADR 0053): setContract admits exactly the four SLP dispositions — anything else is invalid-contract, and a valid one rides the line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const factory = createFactory({ stateDir: join(dir, "state") });
  const base = { task: "DISP-1", workspace: root, gate: "true" };
  for (const invalid of ["wizard", "Scout", "", 7, null]) {
    assert.throws(
      () => factory.setContract({ ...base, disposition: invalid as never }),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code?: string }).code === "invalid-contract",
      `disposition ${JSON.stringify(invalid)} must be rejected with invalid-contract`,
    );
  }
  const contract = factory.setContract({ ...base, disposition: "architect" });
  assert.equal(contract.disposition, "architect");
  assert.equal(factory.contractFor("DISP-1")?.disposition, "architect", "the ledger line carries the disposition");
  const omitted = factory.setContract({ ...base, task: "DISP-2" });
  assert.equal("disposition" in omitted, false, "an omitted disposition is recorded omitted — never a defaulted field");
});

test("Seam 1 (ticket 01, ADR 0054 §1/§2): a spool contract may omit gate and description on a read-only disposition — the structured fields synthesize the Brief and gate records empty — while an engineer gate-less contract is refused invalid-contract", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const factory = createFactory({ stateDir: join(dir, "state") });

  // The request shape admits a gate-less contract body (the factory judges).
  const parsed = parseSpoolRequest({ id: "ro-1", kind: "contract", task: "SP-RO", workspace: root, disposition: "reviewer", outcome: "o", invariants: "i", exclusions: "e", submitter: "owner" });
  assert.ok(parsed !== undefined, "a gate-less read-only contract body parses");

  // The handler forwards it: gate defaults to "", the structured fields
  // synthesize the canonical 4-section Brief onto the contract_set line.
  const reply = await handleSpoolRequest(factory, {
    id: "ro-1",
    kind: "contract",
    task: "SP-RO",
    workspace: root,
    disposition: "reviewer",
    outcome: "Audit the seam against HEAD.",
    invariants: "No code changes.",
    exclusions: "Excluded: fixes.",
    submitter: "owner",
    seat: "lead",
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const contract = factory.contractFor("SP-RO");
  assert.ok(contract);
  assert.equal(contract.gate, "", "the read-only Contract records an empty gate");
  assert.match(contract.description ?? "", /1\. Bounded Outcome/);
  assert.match(contract.description ?? "", /2\. Contract Boundary & Regression Invariants/);
  assert.match(contract.description ?? "", /3\. Excluded \/ Deferred/);
  assert.match(contract.description ?? "", /4\. Verification/);
  assert.match(contract.description ?? "", /Read-only disposition \(reviewer\) — 6-Field Handoff with file:line evidence; worktree must remain clean at HEAD\./);

  // The engineer default keeps the mandatory-gate law at the spool surface.
  const engineer = await handleSpoolRequest(factory, {
    id: "ro-2",
    kind: "contract",
    task: "SP-ENG",
    workspace: root,
    gate: "",
    outcome: "o",
    invariants: "i",
    exclusions: "e",
    verification: "v",
    submitter: "owner",
    seat: "lead",
  });
  assert.equal(engineer.ok, false);
  assert.equal((engineer as { code?: string }).code, "invalid-contract");
  assert.match((engineer as { message?: string }).message ?? "", /gate command must be a non-empty string/);
});

// ---- the mandatory six-field handoff on agent_claim (ADR 0053 §4) --------------------------

test("Seam 1 (ADR 0053 §4): a scout claim with the six-field handoff and no commit resolves HEAD to GREEN — ownership defaults, and the handoff rides claim_reported, the report, and the Verdict mail", async (t) => {
  const { stateDir, slug, projectRoot, factory } = makeSpooledSurface(t);
  const spoolRoot = spoolRootFor(stateDir);

  // A read-only Contract: the Peer owes findings, not a commit (User Story 13).
  factory.setContract({ task: "SCOUT-6F", workspace: projectRoot, gate: "true", disposition: "scout" });
  const head = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8" }).trim();

  // The Peer's handoff: the four required fields, `ownership` omitted — the
  // factory defaults it to "lease returned" (spec Implementation Decision 4).
  dropRequest(spoolRoot, {
    id: "cl-6f",
    kind: "claim",
    task: "SCOUT-6F",
    handoff: {
      outcome: "complete",
      scope: "read README.md and src/layout.ts",
      verification: "gate `true` ran green; nothing skipped",
      unknowns: "none",
    },
  });
  await until(() => assert.equal(readReply(spoolRoot, "cl-6f").ok, true, "the scout claim replies ok"));
  const reply = readReply(spoolRoot, "cl-6f");
  assert.equal(reply.verdict, "green", "the 6-field pipeline runs to a GREEN Attempt");
  assert.equal(reply.attempt, 1);

  // claim_reported carries the admitted handoff with the defaulted ownership,
  // and the omitted commit resolved to the worktree's HEAD.
  const claim = factory.ledger.eventsFor("SCOUT-6F").find((e): e is ClaimReported => e.event === "claim_reported");
  assert.ok(claim, "the claim landed");
  assert.equal(claim.sha, head, "the omitted commit resolved to the worktree's HEAD");
  assert.deepEqual(claim.handoff, {
    outcome: "complete",
    scope: "read README.md and src/layout.ts",
    verification: "gate `true` ran green; nothing skipped",
    unknowns: "none",
    ownership: "lease returned",
  }, "the four required fields ride verbatim and ownership defaults to 'lease returned'");

  // The report renders all six fields in PEER.md's handback order, with the
  // Snapshot synthesized from the attempt's own facts — never Peer free text.
  const report = readFileSync(String(reply.reportPath), "utf8");
  const canonical = [
    "- Outcome: complete",
    "- Snapshot:",
    "- Scope: read README.md and src/layout.ts",
    "- Verification: gate `true` ran green; nothing skipped",
    "- Unknown / risk: none",
    "- Ownership: lease returned",
  ];
  const positions = canonical.map((needle) => report.indexOf(needle));
  assert.ok(positions.every((at) => at !== -1), `all six fields render in the report:\n${report}`);
  assert.ok(positions.every((at, i) => i === 0 || at > positions[i - 1]!), "the six fields render in the canonical order");
  assert.ok(report.includes(head), "the Snapshot names the resolved commit");
  assert.ok(report.includes("factory/SCOUT-6F"), "the Snapshot names the factory branch");

  // The Verdict mail queued to the Lead mailbox carries the formatted handoff
  // verbatim next to the Gate outcome (User Story 17).
  const verdictMail = readMailbox(stateDir, slug).find((evt) => evt.type === "mail_queued" && evt.kind === "verdict");
  assert.ok(verdictMail, "the verdict mail landed");
  const mailText = String(verdictMail.text);
  assert.ok(mailText.includes("GREEN"), "the mail names the Gate outcome");
  for (const field of canonical) {
    assert.ok(mailText.includes(field), `the verdict mail carries ${field.split(":")[0]} verbatim`);
  }
});

test("Seam 1 (ADR 0053 §4): an incomplete six-field handoff never opens an Attempt — malformed handoffs are refused at the spool, and the factory's own admission rejects bad shapes and the engineer no-commit claim", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  // Omitted disposition reads as engineer (ADR 0053 §3) — commit stays mandatory.
  factory.setContract({ task: "ENG-6F", workspace: root, gate: "true", artifact: "README.md" });
  const head = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  const spoolRoot = spoolRootFor(stateDir);
  const spool = startSpool(stateDir, factory, { pollMs: POLL_MS });
  t.after(() => spool.stop());

  const handoff = { outcome: "complete", scope: "src/a.ts", verification: "gate green", unknowns: "none" };

  // The spool refuses the request SHAPE itself — malformed JSON never reaches
  // the factory (the ticket's ClaimRequest arm).
  const malformed: Array<[string, Record<string, unknown>]> = [
    ["no handoff at all", { task: "ENG-6F", sha: head }],
    ["outcome outside the four-value enum", { task: "ENG-6F", sha: head, handoff: { ...handoff, outcome: "done" } }],
    ["whitespace-only scope", { task: "ENG-6F", sha: head, handoff: { ...handoff, scope: "   " } }],
    ["empty verification", { task: "ENG-6F", sha: head, handoff: { ...handoff, verification: "" } }],
    ["missing unknowns", { task: "ENG-6F", sha: head, handoff: { outcome: "complete", scope: "s", verification: "v" } }],
    ["present-but-empty ownership", { task: "ENG-6F", sha: head, handoff: { ...handoff, ownership: "  " } }],
    ["mechanical marker off its one-value vocabulary", { task: "ENG-6F", sha: head, mechanical: "driver" }],
    ["mechanical marker alongside a handoff", { task: "ENG-6F", sha: head, mechanical: "lead_verify", handoff }],
  ];
  for (const [id, body] of malformed) {
    dropRequest(spoolRoot, { id, kind: "claim", ...body });
    await until(() => assert.ok(existsSync(join(spoolRoot, "replies", `${id}.json`)), `${id} replied`));
    const reply = readReply(spoolRoot, id);
    assert.equal(reply.ok, false, `${id} is refused`);
    assert.equal(reply.code, "bad-request", `${id} never reaches the factory`);
  }

  // A complete handoff but no commit on an ENGINEER contract: the shape is
  // admitted, the factory's admission refuses before any append (User Story 14).
  dropRequest(spoolRoot, { id: "no-commit", kind: "claim", task: "ENG-6F", handoff });
  await until(() => assert.ok(existsSync(join(spoolRoot, "replies", "no-commit.json")), "the no-commit claim replied"));
  const refused = readReply(spoolRoot, "no-commit");
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "invalid-claim");
  assert.match(String(refused.message), /commit/, "the refusal names the mandatory commit");

  // Nothing above opened an Attempt: no claim_reported, no gate_started.
  assert.deepEqual(
    factory.ledger.eventsFor("ENG-6F").map((e) => e.event),
    ["contract_set"],
    "the ledger slice carries the contract alone",
  );

  // The factory's own admission law for direct callers: bad handoff shapes and
  // the missing handoff itself are invalid-claim, never a red Attempt. (The
  // code predicate — not instanceof — matches across the mirrored core copy.)
  const invalidClaim = (error: unknown): boolean => error instanceof Error && "code" in error && (error as { code?: string }).code === "invalid-claim";
  for (const bad of [
    { outcome: "finished", scope: "s", verification: "v", unknowns: "n" },
    { ...handoff, scope: "  " },
    { ...handoff, verification: "" },
    { ...handoff, unknowns: " " },
    { ...handoff, ownership: "   " },
  ]) {
    await assert.rejects(
      factory.claim({ task: "ENG-6F", sha: head, handoff: bad } as unknown as ClaimInput),
      invalidClaim,
      `handoff ${JSON.stringify(bad)} is refused at admission`,
    );
  }
  await assert.rejects(
    factory.claim({ task: "ENG-6F", sha: head } as ClaimInput),
    invalidClaim,
    "a claim with no handoff at all is refused at admission",
  );
  assert.deepEqual(
    factory.ledger.eventsFor("ENG-6F").map((e) => e.event),
    ["contract_set"],
    "still no Attempt opened",
  );

  // The law's one scoped exception (ADR 0053 §4): the Lead's `lead_verify`
  // mechanical re-run rides the marker INSTEAD of a handoff through the spool
  // — the claim line forges no Peer outcome and the report names the re-run.
  dropRequest(spoolRoot, { id: "lead-verify", kind: "claim", task: "ENG-6F", sha: head, mechanical: "lead_verify", agent: "lead-1" });
  await until(() => assert.ok(existsSync(join(spoolRoot, "replies", "lead-verify.json")), "the mechanical claim replied"));
  const mechanicalReply = readReply(spoolRoot, "lead-verify");
  assert.equal(mechanicalReply.ok, true, JSON.stringify(mechanicalReply));
  assert.match(String(mechanicalReply.summary), /GREEN/i);
  const mechanicalLine = factory.ledger.eventsFor("ENG-6F").find((e) => e.event === "claim_reported");
  assert.equal(mechanicalLine?.mechanical, "lead_verify", "the claim line carries the mechanical marker");
  assert.equal(mechanicalLine?.handoff, undefined, "the mechanical claim forges no handoff");
  const mechanicalReport = readFileSync(String(mechanicalReply.reportPath), "utf8");
  assert.match(mechanicalReport, /- Lead verification \(`lead_verify`\): mechanical re-run of the Contract Gate by the Lead — no Peer handoff on this claim/);
  assert.doesNotMatch(mechanicalReport, /- Outcome:/, "the mechanical re-run renders no Peer outcome");
});

test("Seam 1 (ADR 0053): the spawn-path re-contract onto a moved HEAD preserves the prior epoch's disposition", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const resolved = resolveCoreProject(root);
  assert.ok(resolved.ok, "the test project must resolve");
  writeCoreRegistration(stateDir, resolved.slug, { root: resolved.root });
  const registry = createFactoryRegistry({ stateDir });
  t.after(() => registry.stop());
  const spool = startSpool(stateDir, registry.root, { pollMs: POLL_MS, registry });
  t.after(() => spool.stop());

  // T-01 is contracted read-only (architect) and never claimed.
  dropRequest(spoolRootFor(stateDir), { id: "c-a", kind: "contract", task: "T-01", workspace: resolved.root, gate: "true", disposition: "architect", submitter: "owner" });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "c-a").ok, true, "the architect contract replies ok"));

  // Upstream lands after T-01's Contract: T-02 is contracted, committed,
  // claimed green, and accepted — moving the Project's HEAD past T-01's base.
  dropRequest(spoolRootFor(stateDir), { id: "c-b", kind: "contract", task: "T-02", workspace: resolved.root, gate: "true", artifact: "README.md", submitter: "owner" });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "c-b").ok, true, "the T-02 contract replies ok"));
  writeFileSync(join(root, "upstream.txt"), "landed upstream\n");
  const upstreamSha = gitCommitAll(root, "upstream work");
  dropRequest(spoolRootFor(stateDir), { id: "cl-b", kind: "claim", handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" }, task: "T-02", sha: upstreamSha });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "cl-b").verdict, "green", "T-02's claim ends green"));
  dropRequest(spoolRootFor(stateDir), { id: "ac-b", kind: "accept", task: "T-02", attempt: 1, submitter: "owner" });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "ac-b").ok, true, "T-02 is accepted"));

  // The spawn's upstream-landed re-contract re-bases T-01 onto the moved HEAD
  // — and the fresh epoch stays read-only: the disposition rides forward.
  dropRequest(spoolRootFor(stateDir), { id: "sp-a", kind: "spawn", task: "T-01", provider: "pi/zai/glm-5.3", arity: 1 });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "sp-a").ok, true, "the T-01 spawn replies ok"));
  const epochs = readFileSync(join(projectStateDir(stateDir, resolved.slug), "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((e) => e.event === "contract_set" && e.task === "T-01");
  assert.equal(epochs.length, 2, "the spawn re-contracted T-01 onto the moved HEAD");
  assert.equal(epochs[1].base, upstreamSha, "the fresh epoch re-based onto the moved HEAD");
  assert.equal(epochs[1].disposition, "architect", "the re-spawned read-only task stays read-only");
});

// ---- Seam 1 (ADR 0053 §3, ticket 05): read-only acceptance is merge-free -----------------------

/**
 * The merge-free acceptance seam: a read-only Task (scout/architect/reviewer)
 * contracted, spawned into its managed Task worktree, and claimed GREEN must
 * close on `accept` WITHOUT `landTaskWorktree` — `<project-root>`'s HEAD is
 * unchanged, no `factory/<task>` merge commit exists, the `attempt_accepted`
 * line carries no `landing`, and the Task worktree is removed — while an
 * engineer Task on the same machine still lands exactly as before.
 */
test("Seam 1 (ADR 0053): lead accept on a GREEN read-only Task records attempt_accepted, removes the Task worktree, and never merges into <project-root> — an engineer Task still lands", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const resolved = resolveProject(root);
  assert.ok(resolved.ok, "the test project must resolve");
  writeProjectRegistration(stateDir, resolved.slug, { root: resolved.root });
  const registry = createFactoryRegistry({ stateDir });
  t.after(() => registry.stop());
  const spool = startSpool(stateDir, registry.root, { pollMs: POLL_MS, registry });
  t.after(() => spool.stop());
  const projectFactory = () => registry.factoryForProject(resolved.slug);
  const headAt = () => execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  const acceptedLine = (task: string) =>
    readFileSync(join(projectStateDir(stateDir, resolved.slug), "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .findLast((e) => e.event === "attempt_accepted" && e.task === task);

  // 1. The scout Task: contract, spawned into its managed worktree, claimed
  //    GREEN at the worktree HEAD (a read-only Peer makes no new commit).
  dropRequest(spoolRootFor(stateDir), { id: "c-scout", kind: "contract", task: "RO-1", workspace: resolved.root, gate: "true", disposition: "scout", submitter: "owner" });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "c-scout").ok, true, "the scout contract replies ok"));
  dropRequest(spoolRootFor(stateDir), { id: "sp-scout", kind: "spawn", task: "RO-1", provider: "pi/zai/glm-5.3", arity: 1, projectSlug: resolved.slug });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "sp-scout").ok, true, "the scout spawn replies ok"));
  const scoutWorktree = projectFactory().worktreeFor("RO-1");
  assert.ok(typeof scoutWorktree === "string", "the scout spawn allocated a managed Task worktree");
  assert.ok(existsSync(scoutWorktree), "the scout Task worktree exists on disk");
  const headBefore = headAt();
  const scoutHead = execSync("git rev-parse HEAD", { cwd: scoutWorktree!, encoding: "utf8" }).trim();
  // The claim carries the mandatory 6-Field Handoff (ADR 0053 §4, ticket 04);
  // the attested commit stays the worktree HEAD — a read-only Peer's exact word.
  dropRequest(spoolRootFor(stateDir), {
    id: "cl-scout",
    kind: "claim",
    task: "RO-1",
    sha: scoutHead,
    handoff: {
      outcome: "complete",
      scope: "read README.md; reconnoitered the worktree at HEAD",
      verification: "gate ran green at the worktree HEAD; no new commit — read-only disposition",
      unknowns: "none",
    },
    projectSlug: resolved.slug,
  });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "cl-scout").verdict, "green", "the scout claim ends green"));

  // 2. Accept: merge-free. No landing fields, root HEAD unchanged, worktree gone.
  dropRequest(spoolRootFor(stateDir), { id: "ac-scout", kind: "accept", task: "RO-1", attempt: 1, submitter: "owner", projectSlug: resolved.slug });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "ac-scout").ok, true, "the scout accept replies ok"));
  const accepted = acceptedLine("RO-1") as Record<string, unknown> | undefined;
  assert.ok(accepted, "attempt_accepted recorded for the read-only Task");
  assert.equal("landing" in (accepted ?? {}), false, "no landing field on a read-only acceptance");
  assert.equal("landingNote" in (accepted ?? {}), false, "no landingNote field on a read-only acceptance");
  assert.equal(headAt(), headBefore, "<project-root>'s HEAD is unchanged — no merge ran");
  const mergeCommits = execSync("git log --oneline --merges -3", { cwd: root, encoding: "utf8" });
  assert.doesNotMatch(mergeCommits, /factory\/RO-1/, "no factory/RO-1 merge commit exists on <project-root>");
  await until(() => assert.equal(existsSync(scoutWorktree), false, "the read-only Task worktree is removed"));

  // 3. The engineer control on the same machine: the ordinary landing stands.
  dropRequest(spoolRootFor(stateDir), { id: "c-eng", kind: "contract", task: "ENG-1", workspace: resolved.root, gate: "true", artifact: "feature.txt", submitter: "owner" });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "c-eng").ok, true, "the engineer contract replies ok"));
  dropRequest(spoolRootFor(stateDir), { id: "sp-eng", kind: "spawn", task: "ENG-1", provider: "pi/zai/glm-5.3", arity: 1, projectSlug: resolved.slug });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "sp-eng").ok, true, "the engineer spawn replies ok"));
  const engWorktree = projectFactory().worktreeFor("ENG-1");
  assert.ok(typeof engWorktree === "string", "the engineer spawn allocated a managed Task worktree");
  writeFileSync(join(engWorktree!, "feature.txt"), "delivered\n");
  const engSha = gitCommitAll(engWorktree!, "feat: engineer delivery");
  dropRequest(spoolRootFor(stateDir), {
    id: "cl-eng",
    kind: "claim",
    task: "ENG-1",
    sha: engSha,
    handoff: {
      outcome: "complete",
      scope: "worktrees/ENG-1/feature.txt — delivered feature",
      verification: "gate ran green on the claimed commit",
      unknowns: "none",
    },
    projectSlug: resolved.slug,
  });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "cl-eng").verdict, "green", "the engineer claim ends green"));
  dropRequest(spoolRootFor(stateDir), { id: "ac-eng", kind: "accept", task: "ENG-1", attempt: 1, submitter: "owner", projectSlug: resolved.slug });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "ac-eng").ok, true, "the engineer accept replies ok"));
  const engineerAccepted = acceptedLine("ENG-1") as Record<string, unknown> | undefined;
  assert.equal(engineerAccepted?.landing, "landed", "an engineer acceptance still lands into <project-root>");
  assert.equal(headAt(), engSha, "the root HEAD advanced to the engineer's claimed commit");
  await until(() => assert.equal(existsSync(engWorktree), false, "the engineer Task worktree is removed after landing"));
});

// ---- per-dispatch provider-adaptive thinking effort on spawn (v0.5.0 ticket 04, ADR 0054 §4) ----

/**
 * The spawn-effort harness: a real Factory over a temp git Project, a
 * configurable `worker` lane, and a fake daemon whose `providers.listModels`
 * answers one provider's catalog — the structural slice the spawn call site
 * consults. `created` captures every agent create's config.
 */
function makeThinkingSpawnSurface(
  t: TestContext,
  options: { workerLane: string; provider: string; thinkingOptions: string[] },
) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const projectRoot = join(dir, "repo");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "README.md"), "x\n");
  gitCommitAll(projectRoot);
  const resolved = resolveProject(projectRoot);
  assert.ok(resolved.ok, "the test project must resolve");
  const stateDir = join(dir, "factory-state");
  saveLanes(stateDir, { worker: options.workerLane });
  const factory = createFactory({ stateDir });
  const created: { config: { provider: string; thinkingOptionId?: string }; labels: Record<string, string> }[] = [];
  const daemon = {
    agents: {
      list: async () => ({ entries: [] as never[] }),
      create: async (req: { config: { provider: string; thinkingOptionId?: string }; labels: Record<string, string> }) => {
        created.push({ config: req.config, labels: req.labels });
        return { id: `agent-${created.length}` };
      },
      ref: (id: string) => ({ send: async () => {}, archive: async () => ({ archivedAt: new Date().toISOString() }), timeline: { refetch: async () => ({ entries: [] }) } }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: options.provider, available: true }] }),
      listModels: async (provider: string) =>
        provider === options.provider
          ? { models: [{ id: options.provider === "zcode" ? "builtin:zai-coding-plan\\GLM-5.3" : "gemini-4-argon-high", thinkingOptions: options.thinkingOptions.map((id) => ({ id })) }] }
          : { models: [] },
    },
  };
  return { dir, stateDir, projectRoot, factory, created, daemon: daemon as never };
}

test("a thinking-bearing spawn resolves provider-adaptively onto the configured worker lane and launches with thinkingOptionId (ticket 04)", async (t) => {
  const surface = makeThinkingSpawnSurface(t, { workerLane: "zcode/GLM-5.3:high", provider: "zcode", thinkingOptions: ["low", "high", "max"] });
  surface.factory.setContract({ task: "TH-1", workspace: surface.projectRoot, gate: "true", artifact: "README.md" });

  const reply = await handleSpoolRequest(
    surface.factory,
    {
      id: "th-1",
      kind: "spawn",
      task: "TH-1",
      provider: "zcode/GLM-5.3:high",
      arity: 1,
      prompt: "Execute task TH-1: pass gate `true`, and call agent_claim.",
      seat: "lead",
      thinking: "xhigh",
      thinkingReason: "Cross-cutting refactor with a heavy verification burden.",
    },
    { daemon: surface.daemon },
  );

  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(surface.created.length, 1, "the plugin created the Peer itself");
  assert.deepEqual(surface.created[0]!.config, { provider: "zcode/GLM-5.3", thinkingOptionId: "max" }, "xhigh lands on the catalog's max — never the bare model");
  const dispatched = surface.factory.ledger.events.find((e) => e.event === "spawn_dispatched");
  assert.ok(dispatched && dispatched.event === "spawn_dispatched");
  assert.equal(dispatched.thinking, "xhigh");
  assert.equal(dispatched.thinkingReason, "Cross-cutting refactor with a heavy verification burden.");
});

test("a spawn without thinking launches under the exact configured worker lane, byte for byte (ticket 04)", async (t) => {
  const surface = makeThinkingSpawnSurface(t, { workerLane: "zcode/GLM-5.3:high", provider: "zcode", thinkingOptions: ["low", "high", "max"] });
  surface.factory.setContract({ task: "TH-2", workspace: surface.projectRoot, gate: "true", artifact: "README.md" });

  const reply = await handleSpoolRequest(
    surface.factory,
    { id: "th-2", kind: "spawn", task: "TH-2", provider: "zcode/GLM-5.3:high", arity: 1, prompt: "Execute task TH-2: pass gate `true`, and call agent_claim.", seat: "lead" },
    { daemon: surface.daemon },
  );

  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(surface.created[0]!.config, { provider: "zcode/GLM-5.3", thinkingOptionId: "high" }, "the Owner's configured suffix stands untouched");
  const dispatched = surface.factory.ledger.events.find((e) => e.event === "spawn_dispatched");
  assert.ok(dispatched && dispatched.event === "spawn_dispatched");
  assert.equal("thinking" in dispatched, false, "no override requested — no thinking field recorded");
});

test("a fixed-effort model silently ignores the thinking override — no error, no suffix mutation (ticket 04)", async (t) => {
  const surface = makeThinkingSpawnSurface(t, { workerLane: "antigravity/gemini-4-argon-high", provider: "antigravity", thinkingOptions: [] });
  surface.factory.setContract({ task: "TH-3", workspace: surface.projectRoot, gate: "true", artifact: "README.md" });

  const reply = await handleSpoolRequest(
    surface.factory,
    {
      id: "th-3",
      kind: "spawn",
      task: "TH-3",
      provider: "antigravity/gemini-4-argon-high",
      arity: 1,
      prompt: "Execute task TH-3: pass gate `true`, and call agent_claim.",
      seat: "lead",
      thinking: "high",
      thinkingReason: "Auditing a concurrency hot path before the release cut.",
    },
    { daemon: surface.daemon },
  );

  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(surface.created[0]!.config, { provider: "antigravity/gemini-4-argon-high" }, "the baked-in effort model keeps its exact configured id");
  const dispatched = surface.factory.ledger.events.find((e) => e.event === "spawn_dispatched");
  assert.ok(dispatched && dispatched.event === "spawn_dispatched");
  assert.equal(dispatched.thinking, "high", "the requested tier is still recorded — ignored is not unrecorded");
});

test("a thinking spawn without a reason refuses invalid-spawn through the spool — one refusal line, no Peer created (ticket 04)", async (t) => {
  const surface = makeThinkingSpawnSurface(t, { workerLane: "zcode/GLM-5.3:high", provider: "zcode", thinkingOptions: ["low", "high", "max"] });
  surface.factory.setContract({ task: "TH-4", workspace: surface.projectRoot, gate: "true", artifact: "README.md" });

  const reply = await handleSpoolRequest(
    surface.factory,
    { id: "th-4", kind: "spawn", task: "TH-4", provider: "zcode/GLM-5.3:high", arity: 1, prompt: "Execute task TH-4.", seat: "lead", thinking: "high", thinkingReason: "" },
    { daemon: surface.daemon },
  );

  assert.equal(reply.ok, false);
  if (!reply.ok) {
    assert.equal(reply.code, "invalid-spawn");
    assert.equal(reply.message, "thinkingReason is required when thinking is specified");
  }
  assert.equal(surface.created.length, 0, "no Peer exists for a refused spawn");
  const refused = surface.factory.ledger.events.find((e) => e.event === "spawn_refused");
  assert.ok(refused && refused.event === "spawn_refused");
});

test("parseSpoolRequest admits the spawn's thinking tier and reason — and refuses wrong shapes", () => {
  const base = { id: "thp", kind: "spawn", task: "TH-P", provider: "zcode/GLM-5.3:high", arity: 1 };
  const reason = "The blast radius spans two subsystems.";
  assert.deepEqual(parseSpoolRequest({ ...base, thinking: "xhigh", thinkingReason: reason }), { ...base, thinking: "xhigh", thinkingReason: reason });
  assert.deepEqual(parseSpoolRequest(base), base, "absent fields stay absent");
  assert.equal(parseSpoolRequest({ ...base, thinking: "ultra", thinkingReason: reason }), undefined, "an unknown tier is malformed");
  assert.equal(parseSpoolRequest({ ...base, thinking: "high", thinkingReason: 7 }), undefined, "a non-string reason is malformed");
});

test("a promptless (driver-path) thinking spawn replies with the resolved lane for the driver's own agent create (ticket 04)", async (t) => {
  const surface = makeThinkingSpawnSurface(t, { workerLane: "zcode/GLM-5.3:high", provider: "zcode", thinkingOptions: ["low", "high", "max"] });
  surface.factory.setContract({ task: "TH-5", workspace: surface.projectRoot, gate: "true", artifact: "README.md" });

  const reply = await handleSpoolRequest(
    surface.factory,
    {
      id: "th-5",
      kind: "spawn",
      task: "TH-5",
      provider: "zcode/GLM-5.3:high",
      arity: 1,
      thinking: "medium",
      thinkingReason: "Routine port with a known template and a narrow diff.",
    },
    { daemon: surface.daemon },
  );

  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.resolvedProvider, "zcode/GLM-5.3:high", "medium lands on the configured suffix the catalog carries");
  assert.equal(surface.created.length, 0, "the driver creates this agent itself — the plugin never does");
});

// ---- clean Task retirement (v0.5.0, ADR 0054 §5, ticket 05) -----------------------------------

test("parseSpoolRequest admits the close shape (task, reason, by seat) and refuses a missing reason or an off-seat by", () => {
  const base = { id: "cl-1", kind: "close", task: "T-01", reason: "superseded by the split", submitter: "owner" };
  const parsed = parseSpoolRequest(base);
  assert.ok(parsed !== undefined && parsed.kind === "close", "the well-formed close request parses");
  assert.equal(parsed.reason, "superseded by the split");
  assert.equal(parsed.by, undefined);
  const byLead = parseSpoolRequest({ ...base, id: "cl-2", by: "lead" });
  assert.ok(byLead !== undefined && byLead.kind === "close" && byLead.by === "lead", "--by lead parses");
  assert.equal(parseSpoolRequest({ ...base, id: "cl-3", reason: "   " }), undefined, "an empty reason is malformed");
  assert.equal(parseSpoolRequest({ ...base, id: "cl-4", by: "agent" }), undefined, "by is exactly owner|supervisor|lead");
  assert.equal(parseSpoolRequest({ id: "cl-5", kind: "close", task: "T-01", submitter: "owner" }), undefined, "reason is required");
});

test("Seam 1 (ticket 05, ADR 0054 §5): close cancels and archives the bound live Peer, archives the temporary Paseo workspace, removes the Task worktree and branch, and appends task_closed — and a working-Agent seat cannot close", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  const base = gitCommitAll(root);
  const resolved = resolveCoreProject(root);
  assert.ok(resolved.ok, "the test project must resolve");
  const slug = resolved.slug;
  // A real Task worktree on branch factory/T-09 plus the temporary Paseo
  // workspace registration — the two removal halves' observables.
  const worktree = taskWorktreePath(stateDir, slug, "T-09");
  execFileSync("git", ["worktree", "add", "-q", "-b", "factory/T-09", worktree, base], { cwd: root });
  writeCoreRegistration(stateDir, slug, { root: resolved.root, taskWorkspaces: { "T-09": "ws-close-1" } });
  const registry = createFactoryRegistry({ stateDir });
  t.after(() => registry.stop());

  const agents: FakeAgent[] = [
    { id: "peer-1", status: "idle", provider: "pi/zai/glm-5.3", cwd: worktree, labels: { task: "T-09", project: slug } },
  ];
  const fake = fakeDaemon(agents);
  const archivedWorkspaces: string[] = [];
  fake.daemon.workspaces = {
    open: async () => { throw new Error("unused in this test"); },
    create: async () => { throw new Error("unused in this test"); },
    archive: async (id: string) => { archivedWorkspaces.push(id); return { archivedAt: new Date().toISOString() }; },
    ref: () => { throw new Error("unused in this test"); },
  };
  const stopped: string[] = [];
  const spool = startSpool(stateDir, registry.root, {
    pollMs: POLL_MS,
    registry,
    home,
    daemon: fake.daemon,
    stopAgent: async (agentId) => {
      stopped.push(agentId);
      return { ok: true };
    },
  });
  t.after(() => spool.stop());

  // The contracted, spawned Task the close retires.
  const factory = registry.factoryForProject(slug);
  factory.setContract({ task: "T-09", workspace: resolved.root, gate: "true", artifact: "README.md" });
  factory.requestSpawn({ task: "T-09", provider: "claude", arity: 1, worktree });

  const ledgerLines = () =>
    readFileSync(join(projectStateDir(stateDir, slug), "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const listedPeerIds = async () => {
    const page = await fake.daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
    return page.entries.map((entry) => entry.agent.id);
  };

  // A working-Agent seat is refused by name before anything changes.
  dropRequest(spoolRootFor(stateDir), { id: "cl-agent", kind: "close", task: "T-09", reason: "agent tries", seat: "agent", submitter: "owner" });
  await until(() => {
    const reply = readReply(spoolRootFor(stateDir), "cl-agent");
    assert.equal(reply.ok, false);
    assert.equal(reply.code, "agent-cannot-close");
  });
  assert.equal(ledgerLines().some((e) => e.event === "task_closed"), false, "the refused close wrote no line");
  assert.ok((await listedPeerIds()).includes("peer-1"), "the refused close touched no Peer");

  // The Lead's close: one ledger line, the Peer cancelled and archived, the
  // Paseo workspace archived and unregistered, the worktree and branch gone.
  dropRequest(spoolRootFor(stateDir), { id: "cl-ok", kind: "close", task: "T-09", reason: "superseded after the context-ceiling split", by: "lead", seat: "lead", submitter: "owner" });
  await until(() => assert.equal(readReply(spoolRootFor(stateDir), "cl-ok").ok, true, "the close replies ok"));
  await until(() => assert.deepEqual(stopped, ["peer-1"], "the bound Peer was cancelled"));
  assert.ok(!(await listedPeerIds()).includes("peer-1"), "the bound Peer is archived");
  assert.deepEqual(archivedWorkspaces, ["ws-close-1"], "the temporary Paseo workspace was archived");
  assert.ok(!readProjectRegistration(stateDir, slug)?.taskWorkspaces?.["T-09"], "the workspace registration is cleared");
  assert.equal(existsSync(worktree), false, "the Task worktree directory is gone");
  assert.equal(execFileSync("git", ["branch", "--list", "factory/T-09"], { cwd: root, encoding: "utf8" }).trim(), "", "branch factory/<task> is deleted");
  const closed = ledgerLines().findLast((e) => e.event === "task_closed");
  assert.ok(closed !== undefined, "task_closed landed on the project ledger");
  assert.equal(closed.task, "T-09");
  assert.equal(closed.reason, "superseded after the context-ceiling split");
  assert.equal(closed.closed_by, "lead");
  assert.equal(factory.contractFor("T-09") !== undefined, true, "the Contract stays on the append-only ledger — closed, not erased");
});

// ---- the plugin-owned notebook writer surface (v0.5.0, ADR 0052 §1, ticket 06) ---------------

/** A canonical-shape notebook for the spool/CLI/bridge surfaces. */
function spoolValidNotebook(guardRows = 2): string {
  const rows = Array.from({ length: guardRows }, (_, i) => `| V-${String(i + 1).padStart(2, "0")} | cause ${i + 1} → effect ${i + 1} | observed (1x) |`);
  return ["## 1. Verification & Run Recipe", "npm run check", "", "## 2. Recurrence Guard", "| ID | Cause → Effect | State |", "| --- | --- | --- |", ...rows, ""].join("\n");
}

test("parseSpoolRequest admits the notebook kind (content string + Project scope) and nothing around it", () => {
  assert.deepEqual(parseSpoolRequest({ id: "nb-1", kind: "notebook", content: "## text" }), {
    id: "nb-1",
    kind: "notebook",
    content: "## text",
  });
  assert.deepEqual(
    parseSpoolRequest({ id: "nb-2", kind: "notebook", content: "## text", projectSlug: "demo-a1b2c3", projectRoot: "/w/repo", submitter: "lead-1", seat: "lead" }),
    { id: "nb-2", kind: "notebook", content: "## text", projectSlug: "demo-a1b2c3", projectRoot: "/w/repo", submitter: "lead-1", seat: "lead" },
  );
  for (const bad of [
    { id: "nb-1", kind: "notebook" }, // no content
    { id: "nb-1", kind: "notebook", content: 7 },
    { id: "nb-1", kind: "notebook", content: "x", projectSlug: " " },
    { id: "nb-1", kind: "notebook", content: "x", projectRoot: "" },
  ]) {
    assert.equal(parseSpoolRequest(bad), undefined, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("the Spool notebook kind writes <projectStateDir>/notebook.md from the Lead seat and refuses every other seat (ticket 06)", async (t) => {
  const { stateDir, slug, projectRoot, factory } = makeSpooledSurface(t);
  const content = spoolValidNotebook(2);

  const lead = await handleSpoolRequest(factory, { id: "nb-lead", kind: "notebook", content, projectRoot, seat: "lead", submitter: "lead-1" });
  assert.equal(lead.ok, true, (lead as { message?: string }).message);
  assert.equal(readFileSync(join(projectStateDir(stateDir, slug), "notebook.md"), "utf8"), content, "the write happens in-process at <projectStateDir>, never inside <project-root>");
  assert.equal(existsSync(join(projectRoot, ".scratch", "notebook.md")), false, "the working tree stays clean");

  const agent = await handleSpoolRequest(factory, { id: "nb-agent", kind: "notebook", content, projectRoot, seat: "agent", submitter: "peer-1" });
  assert.equal(agent.ok, false);
  assert.equal((agent as { code?: string }).code, "agent-cannot-orchestrate");

  const supervisor = await handleSpoolRequest(factory, { id: "nb-sup", kind: "notebook", content, projectRoot, seat: "supervisor", submitter: "sup-1" });
  assert.equal(supervisor.ok, false);
  assert.equal((supervisor as { code?: string }).code, "supervisor-cannot-notebook");

  const unscoped = await handleSpoolRequest(factory, { id: "nb-none", kind: "notebook", content, seat: "lead", submitter: "lead-1" });
  assert.equal(unscoped.ok, false);
  assert.equal((unscoped as { code?: string }).code, "notebook-project-required");
});

test("the Spool notebook kind refuses over-limit and malformed content with the named codes (spec Seam 1)", async (t) => {
  const { projectRoot, factory } = makeSpooledSurface(t);
  const rows = Array.from({ length: 13 }, (_, i) => `| V-${String(i + 1).padStart(2, "0")} | cause ${i + 1} → effect ${i + 1} | verified |`);
  const overRows = ["## 1. Verification & Run Recipe", "npm run check", "", "## 2. Recurrence Guard", "| ID | Cause → Effect | State |", "| --- | --- | --- |", ...rows, ""].join("\n");
  const overLimit = await handleSpoolRequest(factory, { id: "nb-over", kind: "notebook", content: overRows, projectRoot, seat: "lead", submitter: "lead-1" });
  assert.equal(overLimit.ok, false);
  assert.equal((overLimit as { code?: string }).code, "notebook-limit-exceeded");
  assert.match((overLimit as { message?: string }).message ?? "", /13 Recurrence Guard rows \(max 12\)/);

  const malformed = await handleSpoolRequest(factory, { id: "nb-mal", kind: "notebook", content: "just some prose, no headings", projectRoot, seat: "lead", submitter: "lead-1" });
  assert.equal(malformed.ok, false);
  assert.equal((malformed as { code?: string }).code, "notebook-schema-invalid");
});

test("factory notebook round-trips the CLI → Spool single writer from the Lead seat (spec User Story 21)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const resolved = resolveProject(root);
  assert.ok(resolved.ok, "the test project must resolve");
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory, { pollMs: POLL_MS });
  t.after(() => spool.stop());

  const notebookFile = join(dir, "notebook-input.md");
  writeFileSync(notebookFile, spoolValidNotebook(3));
  const viaFile = await runFactoryCli(["--home", home, "notebook", "--file", notebookFile, "--project", root], { PASEO_FACTORY_SEAT: "lead" });
  assert.equal(viaFile.status, 0, viaFile.stderr);
  assert.match(viaFile.stdout, /notebook updated/);
  assert.equal(readFileSync(join(projectStateDir(stateDir, resolved.slug), "notebook.md"), "utf8"), spoolValidNotebook(3));

  const viaContent = await runFactoryCli(["--home", home, "notebook", "--content", spoolValidNotebook(1), "--project", root], { PASEO_FACTORY_SEAT: "lead" });
  assert.equal(viaContent.status, 0, viaContent.stderr);
  assert.equal(readFileSync(join(projectStateDir(stateDir, resolved.slug), "notebook.md"), "utf8"), spoolValidNotebook(1));

  // Over-limit content: exit 2 with the named code — the CLI never truncates either.
  const rows = Array.from({ length: 13 }, (_, i) => `| V-${String(i + 1).padStart(2, "0")} | cause ${i + 1} → effect ${i + 1} | verified |`);
  const overRows = ["## 1. Verification & Run Recipe", "npm run check", "", "## 2. Recurrence Guard", "| ID | Cause → Effect | State |", "| --- | --- | --- |", ...rows, ""].join("\n");
  const refused = await runFactoryCli(["--home", home, "notebook", "--content", overRows, "--project", root], { PASEO_FACTORY_SEAT: "lead" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /notebook-limit-exceeded/);
  assert.equal(readFileSync(join(projectStateDir(stateDir, resolved.slug), "notebook.md"), "utf8"), spoolValidNotebook(1), "the refused write changed nothing");
});
