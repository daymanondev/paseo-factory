import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { ensureProjectRegistered, resolveProject, writeProjectRegistration } from "../plugin/server/core/project.ts";
import { usageFilePath, type ProjectUsageFile, type SessionUsageRecord } from "../plugin/server/core/usage-status.ts";
import { createUsageRuntime } from "../plugin/server/usage-rollup.ts";
import { LEAD_ROTATE_TOKENS, createLeadMailRuntime, readLeadContextTokens } from "../plugin/server/lead-mailbox.ts";
import { createPeerHandoffRuntime, PEER_HANDOFF_TOKENS } from "../plugin/server/peer-handoff.ts";
import { handleSpoolRequest } from "../plugin/server/spool.ts";
import { createSurfaceHandlers, type SurfaceAgentSnapshot, type SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import type { Factory } from "../plugin/server/core/factory.ts";
import type { MeterWritten } from "../plugin/server/core/events.ts";
import { disposeDir, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

/**
 * The usage rollup's lifecycle seams (v0.0.87, ADR 0043 §3–§5) — hermetic
 * throughout: every provider store lives inside one temp `userHome`, every
 * daemon is a fake, no LLM call anywhere. These tests pin the plugin-owned
 * Tier-1 meter at Claim/Gate boundaries (the `driver.mjs` bypass closed),
 * the flush-before-archive law at every seat rotation, the multi-provider
 * 128k/160k sensor fallback, the reset/delete hygiene, the one-time lazy
 * backfill, and the snapshot's `projectUsage` gather.
 */

interface FakeAgentSpec extends Partial<SurfaceAgentSnapshot> {
  id: string;
}

function fakeDaemon(agents: FakeAgentSpec[]) {
  const created: { config: { provider: string }; cwd: string; title: string; labels: Record<string, string>; prompt?: string }[] = [];
  const sent: { id: string; text: string }[] = [];
  const archived: string[] = [];
  let retireObservedUsage = false;
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async options => ({
        entries: agents
          .filter(agent => (options?.filter?.includeArchived ? true : agent.archivedAt === null))
          .map(agent => ({ agent: agent as SurfaceAgentSnapshot })),
      }),
      create: async options => {
        created.push(options);
        const id = `agent-created-${created.length}`;
        agents.push({ ...agents[0]!, id, provider: options.config.provider, labels: options.labels, cwd: options.cwd, status: "running", archivedAt: null, lastUsage: null });
        return { id };
      },
      ref: (id: string) => ({
        send: async text => { sent.push({ id, text }); },
        archive: async () => {
          // The flush-before-archive law's own probe: at archive time the
          // rollup file must already carry the outgoing session.
          const agent = agents.find(a => a.id === id);
          retireObservedUsage = agent !== undefined && existsSync(usageFileOf(agent));
          const agent0 = agents.find(a => a.id === id);
          if (agent0) agent0.archivedAt = "archived";
          archived.push(id);
          return { archivedAt: "archived" };
        },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
    providers: { listAvailable: async () => ({ providers: [] }), listModels: async () => ({ models: [] }) },
  };
  const usageFileOf = (agent: FakeAgentSpec): string => {
    const slug = agent.labels?.project;
    return slug === undefined ? "/nonexistent" : usageFileOfSlug(slug);
  };
  let stateDirOf = "";
  const usageFileOfSlug = (slug: string): string => (stateDirOf === "" ? "/nonexistent" : usageFilePath(stateDirOf, slug));
  return {
    daemon,
    created,
    sent,
    archived,
    bindStateDir: (stateDir: string) => { stateDirOf = stateDir; },
    retireSawUsage: () => retireObservedUsage,
  };
}

function writeLines(path: string, lines: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.map(line => `${JSON.stringify(line)}\n`).join(""));
}

/** The harness's own append law — a turn lands as new bytes, never a rewrite. */
function appendLine(path: string, line: unknown): void {
  writeFileSync(path, `${JSON.stringify(line)}\n`, { flag: "a" });
}

function piAssistant(input: number, cacheRead: number, output: number, cost = 0): unknown {
  return { type: "message", message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: { input, output, cacheRead, cacheWrite: 0, reasoning: 0, ...(cost > 0 ? { cost: { total: cost } } : {}) } } };
}

function readUsage(stateDir: string, slug: string): ProjectUsageFile | undefined {
  const path = usageFilePath(stateDir, slug);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as ProjectUsageFile;
}

function meterLines(factory: Factory, task: string): MeterWritten[] {
  return factory.ledger.eventsFor(task).filter((e): e is MeterWritten => e.event === "meter_written");
}

/** A git workspace under `dir`, contracted for `task`, ready to claim. */
function setupClaimable(dir: string, factory: Factory, task: string, slug: string): { root: string; sha: string } {
  const root = join(dir, `ws-${task}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "x.ts"), "export const x = 1;\n");
  gitCommitAll(root);
  factory.setContract({ task, workspace: root, gate: "true", artifact: "x.ts" });
  writeProjectRegistration(factory.stateDir, slug, { root });
  writeFileSync(join(root, "x.ts"), "export const x = 2;\n");
  const sha = gitCommitChanges(root, `${task} work`);
  return { root, sha };
}

// ---- Seam 2: the Claim/Gate boundary meters without driver.mjs --------------------------------

test("a Claim through the Spool lands ONE meter_written line and the usage.json record — no driver.mjs in the loop", async t => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const stateDir = join(dir, "state");
  mkdirSync(userHome, { recursive: true });
  const factory = createFactory({ stateDir });
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "r.md"), "x\n");
  gitCommitAll(root);
  const project = resolveProject(root);
  assert.ok(project.ok);
  const slug = project.slug;
  const session = join(dir, "peer-session.jsonl");
  writeLines(session, [piAssistant(1_000, 40_000, 300, 0.4), piAssistant(900, 45_000, 250, 0.35)]);
  const fake = fakeDaemon([
    { id: "peer-7", provider: "pi/zai/glm-5.3", title: "Peer", status: "idle", model: null, labels: { seat: "agent", project: slug, task: "U1" }, archivedAt: null, requiresAttention: false, attentionReason: null, updatedAt: "", cwd: root, persistence: { nativeHandle: session }, lastUsage: null },
  ]);
  fake.bindStateDir(stateDir);
  const usage = createUsageRuntime({ factory, stateDir, userHome, daemon: () => fake.daemon });
  factory.setContract({ task: "U1", workspace: root, gate: "true", artifact: "r.md" });
  writeProjectRegistration(stateDir, slug, { root });
  writeFileSync(join(root, "r.md"), "y\n");
  const sha = gitCommitChanges(root, "U1 work");

  const reply = await handleSpoolRequest(factory, { id: "c1", kind: "claim", handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" }, task: "U1", sha, agent: "peer-7" }, {
    daemon: fake.daemon,
    usageMeter: input => usage.meterTaskBoundary(input),
  });
  assert.equal(reply.ok, true);

  const meters = meterLines(factory, "U1");
  assert.equal(meters.length, 1, "exactly one meter_written at the Gate boundary");
  const meter = meters[0]!;
  assert.equal(meter.provider, "pi/glm-5.3", "the lane string is harness/model");
  assert.deepEqual(meter.usage, { inputTokens: 1_900, cachedInputTokens: 85_000, outputTokens: 550, totalCostUsd: 0.75 }, "the 4-field MeterUsage projection — uncached input, cache read + write folded");
  assert.equal(meter.agent, "peer-7");

  const file = readUsage(stateDir, slug);
  assert.ok(file, "usage.json landed");
  const record = file!.sessions["peer-7"] as SessionUsageRecord;
  assert.ok(record);
  assert.equal(record.seat, "agent");
  assert.equal(record.task, "U1");
  assert.equal(record.attempt, 1, "the attempt the boundary metered");
  assert.equal(record.totalTokens, 87_450);
  assert.equal(record.nativeSessionRef, session, "per-turn traceability back to the provider store");

  // A retried boundary with NO new tokens lands no second line — the
  // at-most-one-per-boundary law is idempotent against replay.
  writeProjectRegistration(stateDir, slug, { root });
  writeFileSync(join(root, "r.md"), "z\n");
  const sha2 = gitCommitChanges(root, "U1 more work");
  await handleSpoolRequest(factory, { id: "c2", kind: "claim", handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" }, task: "U1", sha: sha2, agent: "peer-7" }, {
    daemon: fake.daemon,
    usageMeter: input => usage.meterTaskBoundary(input),
  });
  assert.equal(meterLines(factory, "U1").length, 1, "unchanged tokens → no second line");

  // Grown tokens DO land the attempt-2 line.
  appendLine(session, piAssistant(5_000, 10_000, 100));
  writeProjectRegistration(stateDir, slug, { root });
  writeFileSync(join(root, "r.md"), "w\n");
  const sha3 = gitCommitChanges(root, "U1 grown work");
  await handleSpoolRequest(factory, { id: "c3", kind: "claim", handoff: { outcome: "complete", scope: "s", verification: "v", unknowns: "n" }, task: "U1", sha: sha3, agent: "peer-7" }, {
    daemon: fake.daemon,
    usageMeter: input => usage.meterTaskBoundary(input),
  });
  assert.equal(meterLines(factory, "U1").length, 2, "grown tokens → the new boundary's line");

  // The acceptance boundary: one more grown turn closes the book with the
  // attempt's final line (spec §3 — `attempt_accepted` is a terminal Peer
  // boundary like the Gate verdict).
  appendLine(session, piAssistant(2_000, 1_000, 50));
  const accepted = await handleSpoolRequest(factory, { id: "a1", kind: "accept", task: "U1", attempt: 3, submitter: "owner" }, {
    daemon: fake.daemon,
    usageMeter: input => usage.meterTaskBoundary(input),
  });
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.message);
  assert.equal(meterLines(factory, "U1").length, 3, "the acceptance boundary lands the closing line");
  const closing = meterLines(factory, "U1").at(-1)!;
  assert.equal(closing.usage.inputTokens, 1_900 + 5_000 + 2_000, "cumulative uncached input across every boundary");
});

// ---- Seam 2: the multi-provider 128k/160k sensor + flush-before-archive ------------------------

test("the 128k Lead sensor falls back to the codex native store when lastUsage is absent", async t => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const stateDir = join(dir, "state");
  const rollout = join(dir, "rollout-lead.jsonl");
  writeLines(rollout, [
    { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
    { type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: 400_000, cached_input_tokens: 370_000, cache_write_input_tokens: 0, output_tokens: 9_000, reasoning_output_tokens: 2_100 },
      last_token_usage: { input_tokens: 130_500, output_tokens: 9_000 },
    } } },
  ]);
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(join(userHome, ".codex"), { recursive: true });
  const db = new DatabaseSync(join(userHome, ".codex", "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model TEXT, model_provider TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run("thread-lead", rollout, "gpt-6.1-sol", "openai");
  db.close();
  const paths = { userHome, stateDir };
  const lead: SurfaceAgentSnapshot = {
    id: "lead-9", provider: "codex/gpt-6.1-sol", title: "Lead", status: "idle", model: null,
    labels: { seat: "lead" }, archivedAt: null, requiresAttention: false, attentionReason: null, updatedAt: "", cwd: dir,
    persistence: { nativeHandle: "thread-lead" }, lastUsage: null,
  };
  const reading = readLeadContextTokens(lead, paths);
  assert.deepEqual(reading, { usedTokens: 139_500, maxTokens: null, source: "native-store" }, "last_token_usage input + output crosses 128k from the rollout tail");
  assert.ok(reading.usedTokens! >= LEAD_ROTATE_TOKENS);
});

test("the 160k Peer sensor falls back to the antigravity steps store when lastUsage is absent", async t => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const stateDir = join(dir, "state");
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = join(userHome, ".gemini", "antigravity-cli", "conversations", "conv-p.db");
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
  const varint = (value: number): number[] => {
    const bytes: number[] = [];
    let rest = value;
    while (rest >= 0x80) { bytes.push((rest & 0x7f) | 0x80); rest = Math.floor(rest / 128); }
    bytes.push(rest);
    return bytes;
  };
  const step = (input: number, output: number, cacheRead: number) => {
    const fields = [0x08, ...varint(1417), 0x10, ...varint(input), 0x18, ...varint(output), 0x28, ...varint(cacheRead), 0x48, ...varint(0), 0x50, ...varint(0)];
    return new Uint8Array([0x4a, ...varint(fields.length), ...fields]);
  };
  db.prepare("INSERT INTO steps VALUES (?, 15, ?)").run(1, step(120_000, 20_000, 30_000));
  db.prepare("INSERT INTO steps VALUES (?, 15, ?)").run(2, step(60_000, 10_000, 40_000));
  db.close();
  const peer: SurfaceAgentSnapshot = {
    id: "peer-agy", provider: "antigravity/gemini-4-argon-high", title: "Peer", status: "idle", model: null,
    labels: { seat: "agent" }, archivedAt: null, requiresAttention: false, attentionReason: null, updatedAt: "", cwd: dir,
    persistence: { sessionId: `plugin:${JSON.stringify({ version: 1, data: { conversationId: "conv-p" } })}` }, lastUsage: null,
  };
  const reading = readLeadContextTokens(peer, { userHome, stateDir });
  assert.deepEqual(reading, { usedTokens: 110_000, maxTokens: null, source: "native-store" }, "the last planner response's input + cacheRead + output answers");
  assert.ok(reading.usedTokens! < PEER_HANDOFF_TOKENS, "sanity: this fixture sits under 160k");
  // A third planner response pushes the latest context window over 160k —
  // the same store, read again through the SAME shared cursor map.
  const grow = new DatabaseSync(dbPath);
  grow.prepare("INSERT INTO steps VALUES (?, 15, ?)").run(3, step(30_000, 5_000, 140_000));
  grow.close();
  const grown = readLeadContextTokens({ ...peer, id: "peer-agy-2", persistence: { sessionId: "conv-p" } }, { userHome, stateDir });
  assert.ok(grown.usedTokens! >= 160_000, `a grown store crosses 160k (${grown.usedTokens})`);
});

test("Peer handoff at 160k from the antigravity store flushes the outgoing session into usage.json BEFORE archival", async t => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const stateDir = join(dir, "state");
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "initial\n");
  gitCommitAll(root);
  const project = resolveProject(root);
  assert.ok(project.ok);
  const slug = project.slug;
  const factory = createFactory({ stateDir });
  writeProjectRegistration(stateDir, slug, { root, lead: "lead-1", supervisor: "sup-1" });
  factory.setContract({ task: "H1", workspace: root, gate: "true", description: "bounded slice" });
  const { prepareTaskWorktree } = await import("../plugin/server/core/workspace.ts");
  const worktree = prepareTaskWorktree({ stateDir, workspace: root, task: "H1" });
  assert.ok(worktree.ok);
  factory.requestSpawn({ task: "H1", provider: "antigravity/gemini-4-argon-high", arity: 1, worktree: worktree.path });
  writeFileSync(join(worktree.path, "README.md"), "progress\n");
  gitCommitChanges(worktree.path, "slice");

  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = join(userHome, ".gemini", "antigravity-cli", "conversations", "conv-h.db");
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
  const varint = (value: number): number[] => {
    const bytes: number[] = [];
    let rest = value;
    while (rest >= 0x80) { bytes.push((rest & 0x7f) | 0x80); rest = Math.floor(rest / 128); }
    bytes.push(rest);
    return bytes;
  };
  const step = (input: number, output: number, cacheRead: number) => {
    const fields = [0x08, ...varint(1417), 0x10, ...varint(input), 0x18, ...varint(output), 0x28, ...varint(cacheRead), 0x48, ...varint(0), 0x50, ...varint(0)];
    return new Uint8Array([0x4a, ...varint(fields.length), ...fields]);
  };
  db.prepare("INSERT INTO steps VALUES (?, 15, ?)").run(1, step(100_000, 20_000, 45_000));
  db.close();

  const peer: SurfaceAgentSnapshot = {
    id: "peer-h", provider: "antigravity/gemini-4-argon-high", title: "Peer", status: "idle", model: null,
    labels: { seat: "agent", project: slug, task: "H1" }, archivedAt: null, requiresAttention: false, attentionReason: null, updatedAt: "", cwd: worktree.path,
    persistence: { sessionId: "conv-h" }, lastUsage: null,
  };
  const fake = fakeDaemon([peer, { ...peer, id: "lead-1", title: "Lead", labels: { seat: "lead", project: slug }, cwd: root }, { ...peer, id: "sup-1", title: "Supervisor", labels: { seat: "supervisor", project: slug }, cwd: root }]);
  fake.bindStateDir(stateDir);
  const usagePaths = { userHome, stateDir };
  const usage = createUsageRuntime({ factory, stateDir, userHome, daemon: () => fake.daemon });
  const peerHandoff = createPeerHandoffRuntime({
    factory, stateDir, daemon: () => fake.daemon, timeoutMs: 90_000, stopAgent: async () => ({ ok: true }),
    readTokens: agent => readLeadContextTokens(agent, usagePaths),
    recordUsage: async input => { await usage.meterAgentBoundary({ task: input.task, agent: input.agent, slug: input.slug }); },
    queueBlocked: () => {}, wake: async () => {}, log: () => {},
  });
  t.after(() => peerHandoff.stop());

  const ended = (agentId: string, text = "") => ({ agentId, outcome: { kind: "completed" as const }, timeline: text ? [{ type: "assistant_message", text }] : [] });
  await peerHandoff.observeProject(slug, root, ended(peer.id));
  assert.equal(fake.sent.filter(m => m.id === peer.id).length, 1, "the 165k store reading triggered extraction");
  writeFileSync(join(projectStateDirOf(stateDir, slug), "peer-handoff-H1.md"), "# Completed & Verified Slice\nDone.");
  await peerHandoff.observeProject(slug, root, ended(peer.id, "slice done"));

  assert.ok(fake.archived.includes(peer.id), "the outgoing Peer was archived");
  assert.ok(fake.retireSawUsage(), "usage.json carried the outgoing Peer's session BEFORE the archive call");
  const file = readUsage(stateDir, slug);
  const record = file?.sessions["peer-h"] as SessionUsageRecord | undefined;
  assert.ok(record, "the outgoing Peer's session landed in usage.json");
  assert.equal(record.harness, "antigravity");
  assert.equal(record.model, "gemini-4-argon-high");
  assert.equal(record.totalTokens, 165_000);
  assert.equal(record.task, "H1");
  const handoffMeters = meterLines(factory, "H1");
  assert.equal(handoffMeters.length, 1, "the retirement boundary also lands its Tier-1 meter line");
  assert.equal(handoffMeters[0]!.provider, "antigravity/gemini-4-argon-high");
  assert.deepEqual(handoffMeters[0]!.usage, { inputTokens: 100_000, cachedInputTokens: 45_000, outputTokens: 20_000 }, "no totalCostUsd key — the antigravity store meters tokens only");
});

function projectStateDirOf(stateDir: string, slug: string): string {
  return join(stateDir, "projects", slug);
}

test("the 128k Lead handoff flushes the outgoing Lead's codex session into usage.json before archival", async t => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const stateDir = join(dir, "state");
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const project = resolveProject(root);
  assert.ok(project.ok);
  const slug = project.slug;
  const factory = createFactory({ stateDir });
  writeProjectRegistration(stateDir, slug, { root, lead: "lead-cx" });

  const rollout = join(dir, "rollout-cx.jsonl");
  writeLines(rollout, [
    { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
    { type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: 500_000, cached_input_tokens: 460_000, cache_write_input_tokens: 0, output_tokens: 12_000, reasoning_output_tokens: 3_000 },
      last_token_usage: { input_tokens: 130_500, output_tokens: 9_000 },
    } } },
  ]);
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(join(userHome, ".codex"), { recursive: true });
  const db = new DatabaseSync(join(userHome, ".codex", "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model TEXT, model_provider TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run("thread-cx", rollout, "gpt-6.1-sol", "openai");
  db.close();

  const lead: SurfaceAgentSnapshot = {
    id: "lead-cx", provider: "codex/gpt-6.1-sol", title: "Lead", status: "idle", model: null,
    labels: { seat: "lead", project: slug }, archivedAt: null, requiresAttention: false, attentionReason: null, updatedAt: "", cwd: root,
    persistence: { nativeHandle: "thread-cx" }, lastUsage: null,
  };
  const fake = fakeDaemon([lead]);
  fake.bindStateDir(stateDir);
  const usage = createUsageRuntime({ factory, stateDir, userHome, daemon: () => fake.daemon });
  const successor: { id: string } = { id: "lead-next" };
  const runtime = createLeadMailRuntime({
    factory, stateDir, daemon: () => fake.daemon,
    usage,
    usagePaths: { userHome, stateDir },
    ensureLead: async () => {
      fake.daemon.agents.create({ config: { provider: "codex/gpt-6.1-sol" }, cwd: root, title: "Lead", labels: { seat: "lead", project: slug } });
      return { ok: true, agentId: successor.id, created: true, projectRoot: root, slug };
    },
    retireLead: async () => {
      await fake.daemon.agents.ref("lead-cx").archive();
      writeProjectRegistration(stateDir, slug, { root, lead: null });
      return { ok: true, agentId: "lead-cx" };
    },
    onLog: () => {},
  });
  t.after(() => runtime.stop());

  const ended = { agentId: "lead-cx", outcome: { kind: "completed" as const }, timeline: [] };
  // Boundary 1: the 139.5k native-store reading locks `handing_over` and steers extraction.
  await runtime.onLeadTurnEnded(ended);
  assert.equal(fake.sent.filter(m => m.id === "lead-cx").length, 1, "the extraction prompt went to the outgoing Lead");
  // Boundary 2: the extraction turn completes the handoff — flush, archive, successor.
  await runtime.onLeadTurnEnded({ ...ended, timeline: [{ type: "assistant_message", text: "# Handoff\nAll context preserved." }] });

  assert.ok(fake.archived.includes("lead-cx"));
  assert.ok(fake.retireSawUsage(), "usage.json carried the outgoing Lead's session BEFORE the archive call");
  const record = readUsage(stateDir, slug)?.sessions["lead-cx"] as SessionUsageRecord | undefined;
  assert.ok(record, "the rotated Lead's session landed in usage.json");
  assert.equal(record.seat, "lead");
  assert.equal(record.harness, "codex");
  assert.equal(record.inputUncachedTokens, 40_000, "500,000 input minus 460,000 cached");
  assert.equal(record.cacheReadTokens, 460_000);
  assert.equal(record.totalTokens, 512_000);
});

// ---- Seam 2: reset / delete hygiene ------------------------------------------------------------

test("projectReset without --keep-seats deletes usage.json; with --keep-seats only the standing seats survive; projectDelete removes it all", async t => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const stateDir = join(dir, "state");
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const project = resolveProject(root);
  assert.ok(project.ok);
  const slug = project.slug;
  const factory = createFactory({ stateDir });
  ensureProjectRegistered(stateDir, { slug, root });
  writeProjectRegistration(stateDir, slug, { root, supervisor: "sup-keep", lead: "lead-keep" });
  const now = new Date().toISOString();
  const sessionOf = (agentId: string, seat: SessionUsageRecord["seat"], task?: string): SessionUsageRecord => ({
    agentId, projectSlug: slug, seat, ...(task !== undefined ? { task } : {}), harness: "pi", provider: "zai", model: "glm-5.3",
    turns: 1, inputUncachedTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 0, totalTokens: 350, updatedAt: now,
  });
  const writeUsage = (sessions: Record<string, SessionUsageRecord>): void => {
    mkdirSync(projectStateDirOf(stateDir, slug), { recursive: true });
    writeFileSync(usageFilePath(stateDir, slug), `${JSON.stringify({ version: 1, projectSlug: slug, backfilledAt: now, updatedAt: now, sessions }, null, 2)}\n`);
  };

  const sup = { id: "sup-keep", provider: "pi/zai/glm-5.3", title: "Supervisor", status: "idle", model: null, labels: { seat: "supervisor", project: slug }, archivedAt: null, requiresAttention: false, attentionReason: null, updatedAt: "", cwd: root, lastUsage: null };
  const lead = { ...sup, id: "lead-keep", title: "Lead", labels: { seat: "lead", project: slug } };
  const fake = fakeDaemon([sup, lead]);
  fake.bindStateDir(stateDir);
  const usage = createUsageRuntime({ factory, stateDir, userHome, daemon: () => fake.daemon });
  const handlers = createSurfaceHandlers({ factory, stateDir, home: join(dir, "paseo-home"), daemon: fake.daemon, stopAgent: async () => ({ ok: true }), usage, onLog: () => {} });

  // keepSeats: true — only the surviving Supervisor + Lead entries remain.
  writeUsage({ "sup-keep": sessionOf("sup-keep", "supervisor"), "lead-keep": sessionOf("lead-keep", "lead"), "peer-gone": sessionOf("peer-gone", "agent", "T9"), "lead-old": sessionOf("lead-old", "lead") });
  const kept = await handlers.projectReset({ projectRoot: root, keepSeats: true });
  assert.equal(kept.ok, true, kept.ok ? "" : kept.error);
  const pruned = readUsage(stateDir, slug);
  assert.ok(pruned);
  assert.deepEqual(Object.keys(pruned!.sessions).sort(), ["lead-keep", "sup-keep"], "task/peer and retired-seat entries are pruned; the active standing seats survive");

  // A full reset drops usage.json with the rest of the Project's history.
  const wiped = await handlers.projectReset({ projectRoot: root });
  assert.equal(wiped.ok, true);
  assert.equal(existsSync(usageFilePath(stateDir, slug)), false, "full reset removed usage.json");

  // projectDelete removes the whole project dir — usage.json with it.
  writeUsage({ "sup-keep": sessionOf("sup-keep", "supervisor") });
  const deleted = await handlers.projectDelete({ projectRoot: root });
  assert.equal(deleted.ok, true);
  assert.equal(existsSync(usageFilePath(stateDir, slug)), false, "delete removed usage.json with the project dir");
});

// ---- Seam 2: the one-time lazy backfill ---------------------------------------------------------

test("loadOrBackfillProjectUsage reconstructs a multi-seat Project from <paseoHome>/agents once, then never re-scans", async t => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(dir, "state");
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const project = resolveProject(root);
  assert.ok(project.ok);
  const slug = project.slug;
  const factory = createFactory({ stateDir });
  writeProjectRegistration(stateDir, slug, { root, supervisor: "sup-b", lead: "lead-b" });

  const supSession = join(dir, "sup.jsonl");
  writeLines(supSession, [piAssistant(5_000, 100, 400)]);
  const peerSession = join(dir, "peer.jsonl");
  writeLines(peerSession, [piAssistant(1_000, 500, 100)]);
  const agentsDir = join(paseoHome, "agents", "-encoded-cwd-");
  mkdirSync(agentsDir, { recursive: true });
  const persist = (name: string, agent: Record<string, unknown>): void => {
    writeFileSync(join(agentsDir, name), `${JSON.stringify(agent, null, 2)}\n`);
  };
  persist("sup-b.json", { id: "sup-b", provider: "pi/zai/glm-5.3", labels: { seat: "supervisor", project: slug }, cwd: root, persistence: { nativeHandle: supSession } });
  persist("lead-b.json", { id: "lead-b", provider: "pi/zai/glm-5.3", labels: { seat: "lead", project: slug }, cwd: root, persistence: { nativeHandle: join(dir, "absent.jsonl") } });
  persist("peer-b.json", { id: "peer-b", provider: "pi/zai/glm-5.3", labels: { seat: "agent", project: slug, task: "B1" }, cwd: root, persistence: { nativeHandle: peerSession } });
  persist("stranger.json", { id: "stranger", provider: "pi/zai/glm-5.3", labels: { project: "another-project" }, cwd: root, persistence: {} });

  const usage = createUsageRuntime({ factory, stateDir, userHome, paseoHome, daemon: () => undefined });
  const backfilled = await usage.loadOrBackfillProjectUsage(slug);
  assert.ok(backfilled);
  assert.ok(backfilled!.backfilledAt, "the stamp lands");
  assert.deepEqual(Object.keys(backfilled!.sessions).sort(), ["peer-b", "sup-b"], "project-labelled sessions extract; strangers and store-less sessions stay out");
  assert.equal((backfilled!.sessions["sup-b"] as SessionUsageRecord).seat, "supervisor");

  // The one-time law: a mutated agent file is never re-scanned after the stamp.
  persist("late.json", { id: "late", provider: "pi/zai/glm-5.3", labels: { seat: "agent", project: slug, task: "B2" }, cwd: root, persistence: { nativeHandle: peerSession } });
  const again = await usage.loadOrBackfillProjectUsage(slug);
  assert.deepEqual(Object.keys(again!.sessions).sort(), ["peer-b", "sup-b"], "backfilledAt short-circuits the scan");
});

// ---- Seam 3: the snapshot's projectUsage gather + task enrichment -------------------------------

test("surface.snapshot populates projectUsage (totals, byModel, bySeat, byTask) and enriches TaskView tokens without a meter line", async t => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const stateDir = join(dir, "state");
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const project = resolveProject(root);
  assert.ok(project.ok);
  const slug = project.slug;
  const factory = createFactory({ stateDir });
  writeProjectRegistration(stateDir, slug, { root, supervisor: "sup-s", lead: "lead-s" });
  // A task with a full ledger slice but NO meter_written line — the rollup
  // alone must still light its token pill and model badge.
  factory.ledger.append({ event: "contract_set", task: "S1", workspace: root, gate: "true", artifact: "README.md" });
  factory.ledger.append({ event: "spawn_dispatched", task: "S1", provider: "pi/zai/glm-5.3", arity: 1 });
  factory.ledger.append({ event: "claim_reported", task: "S1", attempt: 1, sha: "full0001", agent: "peer-s" });
  factory.ledger.append({ event: "gate_finished", task: "S1", attempt: 1, exit: 0, verdict: "green", note: "ok", sha: "full0001" });
  const now = new Date().toISOString();
  const record = (agentId: string, seat: SessionUsageRecord["seat"], harness: string, provider: string, model: string, task: string | undefined, input: number, cacheRead: number, output: number): SessionUsageRecord => ({
    agentId, projectSlug: slug, seat, ...(task !== undefined ? { task } : {}), harness, provider, model,
    turns: 1, inputUncachedTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: output, reasoningTokens: 0,
    totalTokens: input + cacheRead + output, updatedAt: now,
  });
  mkdirSync(projectStateDirOf(stateDir, slug), { recursive: true });
  writeFileSync(usageFilePath(stateDir, slug), `${JSON.stringify({
    version: 1, projectSlug: slug, backfilledAt: now, updatedAt: now,
    sessions: {
      "sup-s": record("sup-s", "supervisor", "antigravity", "antigravity", "gemini-4-argon-high", undefined, 220_762, 362_626, 23_981),
      "lead-s": record("lead-s", "lead", "codex", "openai", "gpt-6.1-sol", undefined, 1_647_431, 24_718_592, 123_619),
      "peer-s": record("peer-s", "agent", "pi", "zai", "glm-5.3", "S1", 2_077_529, 136_075_392, 983_447),
    },
  }, null, 2)}\n`);

  const sup = { id: "sup-s", provider: "antigravity/gemini-4-argon-high", title: "Supervisor (Factory)", status: "idle", model: "gemini-4-argon-high", labels: { seat: "supervisor", project: slug }, archivedAt: null, requiresAttention: false, attentionReason: null, updatedAt: "", cwd: root, lastUsage: null };
  const lead = { ...sup, id: "lead-s", provider: "codex/gpt-6.1-sol", title: "Lead", labels: { seat: "lead", project: slug } };
  const peer = { ...sup, id: "peer-s", provider: "pi/zai/glm-5.3", title: "Peer · S1", labels: { seat: "agent", project: slug, task: "S1" } };
  const fake = fakeDaemon([sup, lead, peer]);
  const usage = createUsageRuntime({ factory, stateDir, userHome, daemon: () => fake.daemon });
  const handlers = createSurfaceHandlers({ factory, stateDir, home: join(dir, "paseo-home"), daemon: fake.daemon, stopAgent: async () => ({ ok: true }), usage, onLog: () => {} });

  const snap = await handlers.snapshot({ projectRoot: root });
  assert.equal(snap.ok, true);
  if (!snap.ok) return;
  const usageView = snap.view.projectUsage;
  assert.ok(usageView, "the scoped snapshot carries projectUsage");
  assert.equal(usageView!.totals.totalTokens, (220_762 + 362_626 + 23_981) + (1_647_431 + 24_718_592 + 123_619) + (2_077_529 + 136_075_392 + 983_447));
  assert.equal(usageView!.totals.sessionCount, 3);
  assert.equal(usageView!.byModel.length, 3, "three (provider, model) rows");
  assert.ok(usageView!.byModel.some(row => row.provider === "zai" && row.model === "glm-5.3" && row.harness === "pi"));
  assert.deepEqual(usageView!.bySeat.map(row => row.label).sort(), ["Lead", "Peer", "Supervisor"]);
  assert.equal(usageView!.byTask.length, 1);
  assert.equal(usageView!.byTask[0]!.task, "S1");
  assert.equal(usageView!.byTask[0]!.totalTokens, 2_077_529 + 136_075_392 + 983_447);

  const task = snap.view.tasks.find(entry => entry.task === "S1");
  assert.ok(task);
  assert.equal(task!.totalTokens, 2_077_529 + 136_075_392 + 983_447, "the rollup's aggregate lights the token pill without any meter line");
  assert.equal(task!.usageModel, "glm-5.3", "the model badge names the rollup's model");

  // The unscoped global view carries no usage half.
  const globalSnap = await handlers.snapshot({});
  assert.equal(globalSnap.ok, true);
  if (globalSnap.ok) assert.equal(globalSnap.view.projectUsage ?? null, null, "unscoped view: null usage half");
});
