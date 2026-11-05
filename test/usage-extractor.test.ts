import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, appendFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  antigravityConversationIdOf,
  claudeProjectDirOf,
  createUsageExtractor,
  decodeAntigravityUsage,
  readNativeContextWindowTokens,
  resolveZcodeNativeSessionId,
  type UsageAgentSource,
} from "../src/usage-extractor.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

/**
 * The multi-provider native session extractor (v0.0.87, ADR 0043 §2) —
 * hermetic throughout: every provider's store is materialized inside one
 * temp `userHome`/`stateDir`, never the real `~/.codex`, `~/.gemini`,
 * `~/.claude`, `~/.copilot`, `~/.pi`, or `~/.local/share/opencode`. These
 * tests pin the disjoint normalization (`codex`'s cached subset subtracted,
 * `copilot`'s cache-inclusive inputTokens corrected), the exact buckets per
 * harness, the O(delta) cursor advance, and the zero-read stat gate.
 */

function tempHomes(t: TestContext): { dir: string; userHome: string; stateDir: string } {
  const dir = makeTempDir("paseo-factory-usage-");
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const stateDir = join(dir, "state");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { dir, userHome, stateDir };
}

function writeLines(path: string, lines: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map(line => `${JSON.stringify(line)}\n`).join(""));
}

function appendLines(path: string, lines: unknown[]): void {
  appendFileSync(path, lines.map(line => `${JSON.stringify(line)}\n`).join(""));
}

/** SQLite fixture builder — `node:sqlite` availability gates the DB-backed tests. */
async function openSqlite(t: TestContext, path: string) {
  const mod = await import("node:sqlite");
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const db = new mod.DatabaseSync(path);
  t.after(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
  });
  return db;
}

/** The zcode suites' gate — a runtime without `node:sqlite` skips, never fails (the extractor degrades the same way). */
async function nodeSqliteAvailable(): Promise<boolean> {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

// ---- Protobuf fixture encoding (antigravity) ------------------------------------------------

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
}

/** A `steps.metadata` blob carrying the usage submessage at field 9 (`tag 0x4A`). */
function antigravityMetadata(usage: { modelEnum?: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; thinkingTokens: number; responseTokens: number }): Uint8Array {
  const fields: number[] = [];
  if (usage.modelEnum !== undefined) fields.push(0x08, ...varint(usage.modelEnum));
  fields.push(0x10, ...varint(usage.inputTokens));
  fields.push(0x18, ...varint(usage.outputTokens));
  fields.push(0x28, ...varint(usage.cacheReadTokens));
  fields.push(0x48, ...varint(usage.thinkingTokens));
  fields.push(0x50, ...varint(usage.responseTokens));
  return new Uint8Array([0x4a, ...varint(fields.length), ...fields]);
}

// ---- pi ---------------------------------------------------------------------------------------

test("pi: per-turn usage lines sum into the disjoint buckets, the last message owns the context window, and cost accumulates", async t => {
  const { dir, userHome } = tempHomes(t);
  const session = join(dir, "pi-session.jsonl");
  writeLines(session, [
    { type: "message", message: { role: "user", content: "go" } },
    { type: "message", message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: { input: 1_000, output: 300, cacheRead: 40_000, cacheWrite: 0, reasoning: 120, cost: { total: 0.4 } } } },
    { type: "message", message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: { input: 900, output: 250, cacheRead: 45_000, cacheWrite: 100, reasoning: 80, cost: { total: 0.35 } } } },
  ]);
  const extractor = createUsageExtractor({ userHome, stateDir: dir });
  const usage = await extractor.extract({ id: "peer-1", provider: "pi/zai/glm-5.3", persistence: { nativeHandle: session } });
  assert.ok(usage);
  assert.equal(usage.harness, "pi");
  assert.equal(usage.provider, "zai");
  assert.equal(usage.model, "glm-5.3");
  assert.equal(usage.turns, 2);
  assert.equal(usage.inputUncachedTokens, 1_900);
  assert.equal(usage.cacheReadTokens, 85_000);
  assert.equal(usage.cacheWriteTokens, 100);
  assert.equal(usage.outputTokens, 550);
  assert.equal(usage.reasoningTokens, 200);
  assert.equal(usage.totalTokens, 1_900 + 85_000 + 100 + 550, "the four buckets sum exactly");
  assert.equal(usage.totalCostUsd, 0.75, "per-turn cost.total values accumulate");
  assert.equal(usage.latestContextWindowTokens, 900 + 45_000 + 100 + 250, "the LAST assistant message owns the occupancy");
  assert.equal(usage.nativeSessionRef, session);

  // O(delta): one appended turn grows every bucket from the cursor alone.
  appendLines(session, [
    { type: "message", message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: { input: 50, output: 10, cacheRead: 1_000, cacheWrite: 0, reasoning: 0, cost: { total: 0.01 } } } },
  ]);
  const grown = await extractor.extract({ id: "peer-1", provider: "pi/zai/glm-5.3", persistence: { nativeHandle: session } });
  assert.equal(grown!.turns, 3);
  assert.equal(grown!.inputUncachedTokens, 1_950);
  assert.equal(grown!.latestContextWindowTokens, 50 + 1_000 + 0 + 10);

  // The stat gate: an unchanged file is answered from the cursor, zero reads.
  const readsBefore = extractor.metrics.fileReads;
  const cached = await extractor.extract({ id: "peer-1", provider: "pi/zai/glm-5.3", persistence: { nativeHandle: session } });
  assert.deepEqual(cached, grown);
  assert.equal(extractor.metrics.fileReads, readsBefore, "an unchanged (mtimeMs, size) costs zero file reads");
});

test("pi: a session id resolves inside the factory's isolated pi-agent homes when nativeHandle is absent", async t => {
  const { userHome, stateDir } = tempHomes(t);
  const sessionsRoot = join(stateDir, "pi-agent", "agent", "sessions", "--encoded-cwd--");
  const session = join(sessionsRoot, `20261103T090000_ses-42.jsonl`);
  writeLines(session, [{ type: "message", message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } }]);
  const usage = await createUsageExtractor({ userHome, stateDir }).extract({
    id: "peer-2",
    provider: "pi/zai/glm-5.3",
    persistence: { sessionId: "ses-42" },
  });
  assert.ok(usage);
  assert.equal(usage.turns, 1);
  assert.equal(usage.nativeSessionRef, session);
});

// ---- codex ------------------------------------------------------------------------------------

test("codex: cumulative total_token_usage minus cached_input_tokens never double-counts; occupancy comes from last_token_usage", async t => {
  const { dir, userHome } = tempHomes(t);
  const rollout = join(dir, "rollout-20261103-thread-1.jsonl");
  const tokenCount = (total: Record<string, number>, last: Record<string, number>) => ({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
  });
  writeLines(rollout, [
    { type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "high" } },
    tokenCount({ input_tokens: 200_000, cached_input_tokens: 180_000, cache_write_input_tokens: 0, output_tokens: 4_000, reasoning_output_tokens: 900 }, { input_tokens: 20_000, output_tokens: 4_000 }),
    tokenCount({ input_tokens: 400_000, cached_input_tokens: 370_000, cache_write_input_tokens: 500, output_tokens: 9_000, reasoning_output_tokens: 2_100 }, { input_tokens: 30_500, output_tokens: 9_000 }),
  ]);
  const db = await openSqlite(t, join(userHome, ".codex", "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model TEXT, model_provider TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run("thread-1", rollout, "gpt-6.1-sol", "openai");
  const extractor = createUsageExtractor({ userHome, stateDir: dir });
  const usage = await extractor.extract({ id: "lead-1", provider: "codex/gpt-6.1-sol", persistence: { nativeHandle: "thread-1" } });
  assert.ok(usage);
  assert.equal(usage.harness, "codex");
  assert.equal(usage.provider, "openai");
  assert.equal(usage.model, "gpt-6.1-sol");
  assert.equal(usage.turns, 2, "one counted turn per token_count event");
  assert.equal(usage.inputUncachedTokens, 30_000, "400,000 total input minus 370,000 cached — the subset subtraction");
  assert.equal(usage.cacheReadTokens, 370_000);
  assert.equal(usage.cacheWriteTokens, 500);
  assert.equal(usage.outputTokens, 9_000);
  assert.equal(usage.reasoningTokens, 2_100);
  assert.equal(usage.totalTokens, 30_000 + 370_000 + 500 + 9_000);
  assert.equal(usage.latestContextWindowTokens, 30_500 + 9_000, "last_token_usage is the occupancy");
  assert.equal(usage.nativeSessionRef, rollout);

  appendLines(rollout, [
    tokenCount({ input_tokens: 600_000, cached_input_tokens: 550_000, cache_write_input_tokens: 500, output_tokens: 14_000, reasoning_output_tokens: 3_400 }, { input_tokens: 50_500, output_tokens: 14_000 }),
  ]);
  const grown = await extractor.extract({ id: "lead-1", provider: "codex/gpt-6.1-sol", persistence: { nativeHandle: "thread-1" } });
  assert.equal(grown!.turns, 3);
  assert.equal(grown!.inputUncachedTokens, 50_000);
  assert.equal(grown!.latestContextWindowTokens, 50_500 + 14_000);
  const readsBefore = extractor.metrics.fileReads;
  await extractor.extract({ id: "lead-1", provider: "codex/gpt-6.1-sol", persistence: { nativeHandle: "thread-1" } });
  assert.equal(extractor.metrics.fileReads, readsBefore, "unchanged rollout — zero reads");
  assert.equal(extractor.metrics.sqliteOpens, 1, "the thread row is cached per thread id, never re-queried");
});

test("codex: a cold read scans the 64 KB tail — a rollout larger than the tail still answers from its latest totals", async t => {
  const { dir, userHome } = tempHomes(t);
  const rollout = join(dir, "rollout-huge.jsonl");
  const padding = { type: "event_msg", payload: { type: "agent_message", content: "x".repeat(900) } };
  const lines: unknown[] = [{ type: "turn_context", payload: { model: "gpt-6.1-sol" } }, ...Array.from({ length: 80 }, () => padding)];
  lines.push({ type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: 10_000, cached_input_tokens: 2_000, cache_write_input_tokens: 0, output_tokens: 1_000, reasoning_output_tokens: 100 },
    last_token_usage: { input_tokens: 8_000, output_tokens: 1_000 },
  } } });
  writeLines(rollout, lines);
  assert.ok(statSync(rollout).size > 64 * 1024, "fixture is larger than the tail window");
  const db = await openSqlite(t, join(userHome, ".codex", "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model TEXT, model_provider TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run("thread-huge", rollout, "gpt-6.1-sol", "openai");
  const usage = await createUsageExtractor({ userHome, stateDir: dir }).extract({ id: "lead-2", provider: "codex", persistence: { sessionId: "thread-huge" } });
  assert.ok(usage);
  assert.equal(usage.model, "gpt-6.1-sol");
  assert.equal(usage.inputUncachedTokens, 8_000);
  assert.equal(usage.latestContextWindowTokens, 9_000);
  assert.equal(usage.turns, 1, "the padding before the tail window is never counted");
});

// ---- opencode ---------------------------------------------------------------------------------

test("opencode: the pre-aggregated session_v2 row reads back bucket-exact with its model JSON", async t => {
  const { dir, userHome } = tempHomes(t);
  const db = await openSqlite(t, join(userHome, ".local", "share", "opencode", "opencode.db"));
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL, model TEXT)");
  db.exec("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("ses-op-1", 5_000, 2_000, 700, 120_000, 3_000, 0.31, JSON.stringify({ id: "kimi-k3", providerID: "moonshot" }));
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?)").run("m1", "ses-op-1", JSON.stringify({ role: "user" }));
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?)").run("m2", "ses-op-1", JSON.stringify({ role: "assistant" }));
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?)").run("m3", "ses-op-1", JSON.stringify({ role: "assistant" }));
  const extractor = createUsageExtractor({ userHome, stateDir: dir });
  const usage = await extractor.extract({ id: "peer-3", provider: "opencode/moonshot/kimi-k3", persistence: { nativeHandle: "ses-op-1" } });
  assert.ok(usage);
  assert.equal(usage.harness, "opencode");
  assert.equal(usage.provider, "moonshot");
  assert.equal(usage.model, "kimi-k3");
  assert.equal(usage.turns, 2, "assistant messages count as turns");
  assert.equal(usage.inputUncachedTokens, 5_000);
  assert.equal(usage.cacheReadTokens, 120_000);
  assert.equal(usage.cacheWriteTokens, 3_000);
  assert.equal(usage.outputTokens, 2_000);
  assert.equal(usage.reasoningTokens, 700);
  assert.equal(usage.totalCostUsd, 0.31);
  assert.equal(usage.totalTokens, 5_000 + 120_000 + 3_000 + 2_000);
  assert.equal(usage.latestContextWindowTokens, undefined, "session_v2 carries cumulative totals only — occupancy stays absent, never a guess");
  const opensBefore = extractor.metrics.sqliteOpens;
  await extractor.extract({ id: "peer-3", provider: "opencode/moonshot/kimi-k3", persistence: { nativeHandle: "ses-op-1" } });
  assert.equal(extractor.metrics.sqliteOpens, opensBefore, "an unchanged db file answers from the stat gate");
});

// ---- antigravity ------------------------------------------------------------------------------

test("antigravity: Protobuf steps.metadata field 9 decodes and accumulates per planner response", () => {
  const blob = antigravityMetadata({ modelEnum: 1417, inputTokens: 220_762, outputTokens: 23_981, cacheReadTokens: 362_626, thinkingTokens: 13_755, responseTokens: 10_226 });
  const step = decodeAntigravityUsage(blob)!;
  assert.equal(step.modelEnum, 1417);
  assert.equal(step.inputTokens, 220_762);
  assert.equal(step.outputTokens, 23_981);
  assert.equal(step.cacheReadTokens, 362_626);
  assert.equal(step.thinkingTokens, 13_755);
  assert.equal(step.responseTokens, 10_226);
  const large = decodeAntigravityUsage(antigravityMetadata({ inputTokens: 136_075_392, outputTokens: 983_447, cacheReadTokens: 9_007_199_254, thinkingTokens: 454_847, responseTokens: 500_000 }))!;
  assert.equal(large.inputTokens, 136_075_392, "multi-byte varints survive the round trip");
  assert.equal(large.cacheReadTokens, 9_007_199_254);
});

test("antigravity: step_type 15 rows accumulate beyond the row cursor; enum 1417 names gemini-4-argon-high; the plugin: sessionId wrapper resolves", async t => {
  const { dir, userHome } = tempHomes(t);
  const db = await openSqlite(t, join(userHome, ".gemini", "antigravity-cli", "conversations", "conv-7.db"));
  db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
  const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?)");
  insert.run(1, 3, new Uint8Array([0x08, 0x01])); // a non-planner row — never metered
  insert.run(2, 15, antigravityMetadata({ modelEnum: 1417, inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 50_000, thinkingTokens: 900, responseTokens: 1_100 }));
  insert.run(3, 15, antigravityMetadata({ modelEnum: 1417, inputTokens: 6_000, outputTokens: 1_500, cacheReadTokens: 55_000, thinkingTokens: 400, responseTokens: 1_100 }));
  const agent: UsageAgentSource = {
    id: "sup-1",
    provider: "antigravity/gemini-4-argon-high",
    persistence: { sessionId: `plugin:${JSON.stringify({ version: 1, data: { conversationId: "conv-7" } })}` },
  };
  assert.equal(antigravityConversationIdOf(agent), "conv-7", "the plugin: wrapper's conversationId resolves");
  const extractor = createUsageExtractor({ userHome, stateDir: dir });
  const usage = await extractor.extract(agent);
  assert.ok(usage);
  assert.equal(usage.harness, "antigravity");
  assert.equal(usage.model, "gemini-4-argon-high");
  assert.equal(usage.turns, 2);
  assert.equal(usage.inputUncachedTokens, 16_000);
  assert.equal(usage.outputTokens, 3_500, "field 3 carries thinking + response");
  assert.equal(usage.cacheReadTokens, 105_000);
  assert.equal(usage.reasoningTokens, 1_300);
  assert.equal(usage.totalTokens, 16_000 + 105_000 + 0 + 3_500);
  assert.equal(usage.latestContextWindowTokens, 6_000 + 55_000 + 1_500, "the LAST planner response owns the occupancy");

  // The row cursor: only newly appended steps are folded on the next sweep.
  insert.run(4, 15, antigravityMetadata({ modelEnum: 1417, inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 2_000, thinkingTokens: 100, responseTokens: 400 }));
  const grown = await extractor.extract(agent);
  assert.equal(grown!.turns, 3);
  assert.equal(grown!.inputUncachedTokens, 17_000);
  const opensBefore = extractor.metrics.sqliteOpens;
  await extractor.extract(agent);
  assert.equal(extractor.metrics.sqliteOpens, opensBefore, "an unchanged db answers from the stat gate");
});

test("antigravity: the Brain transcript.jsonl is the fallback when the conversations db is absent", async t => {
  const { dir, userHome } = tempHomes(t);
  const transcript = join(userHome, ".gemini", "antigravity", "brain", "conv-9", ".system_generated", "logs", "transcript.jsonl");
  writeLines(transcript, [
    { type: "PLANNER_RESPONSE", usage: { input_tokens: 700, output_tokens: 300, cache_read_tokens: 5_000, thinking_tokens: 150 } },
    { type: "PLANNER_RESPONSE", data: { usage: { input_tokens: 300, output_tokens: 200, cache_read_tokens: 6_000, thinking_tokens: 50 } } },
  ]);
  const usage = await createUsageExtractor({ userHome, stateDir: dir }).extract({ id: "sup-2", provider: "antigravity", persistence: { metadata: { pluginProviderPersistence: { data: { conversationId: "conv-9" } } } } });
  assert.ok(usage);
  assert.equal(usage.turns, 2);
  assert.equal(usage.inputUncachedTokens, 1_000);
  assert.equal(usage.cacheReadTokens, 11_000);
  assert.equal(usage.reasoningTokens, 200);
  assert.equal(usage.latestContextWindowTokens, 300 + 6_000 + 200);
});

// ---- claude -----------------------------------------------------------------------------------

test("claude: message.usage deltas accumulate under the sanitized project directory", async t => {
  const { dir, userHome } = tempHomes(t);
  const cwd = "/Users/andrewpham/work/api-server";
  const session = join(userHome, ".claude", "projects", claudeProjectDirOf(cwd), "ses-cl-1.jsonl");
  writeLines(session, [
    { type: "user", message: { role: "user", content: "go" } },
    { type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 2_000, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 4_000, output_tokens: 1_500 } } },
    { type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 1_000, cache_read_input_tokens: 95_000, cache_creation_input_tokens: 0, output_tokens: 800 } } },
  ]);
  const extractor = createUsageExtractor({ userHome, stateDir: dir });
  const usage = await extractor.extract({ id: "peer-4", provider: "claude/claude-opus-4-8", cwd, persistence: { sessionId: "ses-cl-1" } });
  assert.ok(usage);
  assert.equal(usage.harness, "claude");
  assert.equal(usage.provider, "anthropic");
  assert.equal(usage.model, "claude-opus-4-8");
  assert.equal(usage.turns, 2);
  assert.equal(usage.inputUncachedTokens, 3_000);
  assert.equal(usage.cacheReadTokens, 185_000);
  assert.equal(usage.cacheWriteTokens, 4_000);
  assert.equal(usage.outputTokens, 2_300);
  assert.equal(usage.totalTokens, 3_000 + 185_000 + 4_000 + 2_300);
  assert.equal(usage.latestContextWindowTokens, 1_000 + 95_000 + 0 + 800);
  assert.equal(usage.totalCostUsd, undefined, "claude sessions carry no cost field — absent means absent");
});

// ---- copilot ----------------------------------------------------------------------------------

test("copilot: per-turn inputTokens already contains the cache sums — the subtraction is the normalization — and session.shutdown replaces the totals", async t => {
  const { dir, userHome } = tempHomes(t);
  const events = join(userHome, ".copilot", "session-state", "ses-cp-1", "events.jsonl");
  // The empirical shape: inputTokens 381,131 = 24 uncached + 304,564 cacheRead + 76,543 cacheWrite.
  const record = (usage: Record<string, unknown>) => ({ type: "session.usage_record", data: { usage } });
  writeLines(events, [
    record({ model: "gpt-6.1-sol", provider: { id: "copilot", kind: "github", label: "Copilot" }, inputTokens: 381_131, outputTokens: 6_651, cacheReadTokens: 304_564, cacheWriteTokens: 76_543, reasoningTokens: 2_987 }),
    record({ model: "gpt-6.1-sol", provider: { id: "copilot", kind: "github", label: "Copilot" }, inputTokens: 50_000, outputTokens: 1_000, cacheReadTokens: 10_000, cacheWriteTokens: 5_000, reasoningTokens: 400 }),
  ]);
  const extractor = createUsageExtractor({ userHome, stateDir: dir });
  const agent: UsageAgentSource = { id: "lead-3", provider: "copilot/gpt-6.1-sol", persistence: { nativeHandle: "ses-cp-1" } };
  const usage = await extractor.extract(agent);
  assert.ok(usage);
  assert.equal(usage.harness, "copilot");
  assert.equal(usage.model, "gpt-6.1-sol");
  assert.equal(usage.turns, 2);
  assert.equal(usage.inputUncachedTokens, 24 + 35_000, "max(0, inputTokens - cacheRead - cacheWrite) per turn");
  assert.equal(usage.cacheReadTokens, 314_564);
  assert.equal(usage.cacheWriteTokens, 81_543);
  assert.equal(usage.outputTokens, 7_651);
  assert.equal(usage.reasoningTokens, 3_387);
  assert.equal(usage.latestContextWindowTokens, 50_000 + 1_000, "the last turn's own input + output");

  appendLines(events, [
    { type: "session.shutdown", data: { accountingSnapshot: { tokenDetails: { input: 30_000, cache_read: 320_000, cache_write: 82_000, output: 8_000 } } } },
  ]);
  const final = await extractor.extract(agent);
  assert.equal(final!.inputUncachedTokens, 30_000, "the shutdown snapshot is the harness's final word");
  assert.equal(final!.cacheReadTokens, 320_000);
  assert.equal(final!.outputTokens, 8_000);
  assert.equal(final!.turns, 2, "usage_record turns stand — only the totals were replaced");
});

// ---- zcode -------------------------------------------------------------------------------------

test("zcode: an acpSid resolves through acp-lazy-sessions.json while a bare sess_ id never reads the file", async t => {
  const { userHome } = tempHomes(t);
  const lazy = join(userHome, ".zcode", "v2", "acp-lazy-sessions.json");
  mkdirSync(dirname(lazy), { recursive: true });
  writeFileSync(lazy, JSON.stringify({
    "acp-11111111-2222-3333-4444-555555555555": { cwd: "/Users/x/work", zcodeSid: "sess-native-1" },
    "sess_direct": { cwd: "/Users/x/work", zcodeSid: "sess_other" },
  }));
  assert.equal(resolveZcodeNativeSessionId("acp-11111111-2222-3333-4444-555555555555", userHome), "sess-native-1", "the lazy map's zcodeSid answers");
  assert.equal(resolveZcodeNativeSessionId("sess_direct", userHome), "sess_direct", "a bare sess_ id IS native — the mapping never applies");
  assert.equal(resolveZcodeNativeSessionId("acp-unmapped", userHome), undefined, "an unmapped acpSid is absent, never a guess");
  rmSync(lazy, { force: true });
  assert.equal(resolveZcodeNativeSessionId("acp-gone", userHome), undefined, "a missing file answers undefined, never a throw");
  writeFileSync(lazy, "{not json");
  assert.equal(resolveZcodeNativeSessionId("acp-broken", userHome), undefined, "a damaged file answers undefined, never a throw");
});

test("zcode: assistant message rows fold into the disjoint buckets — inputTokens already contains the cache sums, clamped at zero", async t => {
  if (!(await nodeSqliteAvailable())) return t.skip("node:sqlite unavailable on this runtime");
  const { dir, userHome, stateDir } = tempHomes(t);
  // The per-Task home ticket 01 provisions — the extractor discovers nested db/db.sqlite stores by walking <stateDir>/zcode-home.
  const taskDb = join(stateDir, "zcode-home", "tasks", "proj-slug", "task-a", "db", "db.sqlite");
  const db = await openSqlite(t, taskDb);
  db.exec("CREATE TABLE message (session_id TEXT, sequence INTEGER, role TEXT, metadata TEXT)");
  const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
  insert.run("sess-native-2", 1, "user", JSON.stringify({ text: "go" }));
  insert.run("sess-native-2", 2, "assistant", JSON.stringify({ usage: { inputTokens: 381_131, outputTokens: 6_651, cacheReadInputTokens: 304_564, cacheCreationInputTokens: 76_543, reasoningTokens: 2_987 } }));
  insert.run("sess-native-2", 3, "assistant", JSON.stringify({ usage: { inputTokens: 10_000, outputTokens: 900, cacheReadInputTokens: 9_000, cacheCreationInputTokens: 2_000, reasoningTokens: 0 } }));
  insert.run("sess-native-2", 4, "assistant", JSON.stringify({ usage: { inputTokens: 500, outputTokens: 700, cacheReadInputTokens: 4_000, cacheCreationInputTokens: 1_000, reasoningTokens: 50 } }));
  insert.run("sess-other", 9, "assistant", JSON.stringify({ usage: { inputTokens: 99_999, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }));
  // The lazy-session map carries the acpSid -> zcodeSid resolution (ADR 0046, Gap 1).
  const lazy = join(userHome, ".zcode", "v2", "acp-lazy-sessions.json");
  mkdirSync(dirname(lazy), { recursive: true });
  writeFileSync(lazy, JSON.stringify({ "acp-aaa": { cwd: dir, zcodeSid: "sess-native-2" } }));
  const usage = await createUsageExtractor({ userHome, stateDir }).extract({ id: "peer-8", provider: "zcode/GLM-5.3", persistence: { sessionId: "acp-aaa" } });
  assert.ok(usage);
  assert.equal(usage.harness, "zcode");
  assert.equal(usage.turns, 3, "one turn per assistant row — the user row and the other session's row never meter");
  assert.equal(usage.inputUncachedTokens, 24, "max(0, inputTokens - cacheRead - cacheCreation) per turn, clamped at zero");
  assert.equal(usage.cacheReadTokens, 304_564 + 9_000 + 4_000);
  assert.equal(usage.cacheWriteTokens, 76_543 + 2_000 + 1_000);
  assert.equal(usage.outputTokens, 6_651 + 900 + 700);
  assert.equal(usage.reasoningTokens, 3_037);
  assert.equal(usage.totalTokens, 24 + 317_564 + 79_543 + 8_251, "the four buckets sum exactly");
  assert.equal(usage.latestContextWindowTokens, 500 + 700, "the LAST assistant row owns the occupancy — its input already contains the cache sums");
  assert.equal(usage.nativeSessionRef, taskDb);
});

test("zcode: the sequence cursor folds only rows past lastStepIdx and an unchanged db answers from the stat gate with zero opens", async t => {
  if (!(await nodeSqliteAvailable())) return t.skip("node:sqlite unavailable on this runtime");
  const { userHome, stateDir } = tempHomes(t);
  const db = await openSqlite(t, join(stateDir, "zcode-home", "lead", "db", "db.sqlite"));
  db.exec("CREATE TABLE message (session_id TEXT, sequence INTEGER, role TEXT, metadata TEXT)");
  const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
  insert.run("sess_native_3", 1, "assistant", JSON.stringify({ usage: { inputTokens: 2_000, outputTokens: 300, cacheReadInputTokens: 1_000, cacheCreationInputTokens: 500, reasoningTokens: 10 } }));
  const extractor = createUsageExtractor({ userHome, stateDir });
  const agent: UsageAgentSource = { id: "lead-9", provider: "zcode/GLM-5.3", persistence: { sessionId: "sess_native_3" } };
  const first = await extractor.extract(agent);
  assert.ok(first);
  assert.equal(first.turns, 1);
  assert.equal(first.inputUncachedTokens, 500);
  // The delta sweep: a non-assistant row and one new assistant row land beyond the cursor.
  insert.run("sess_native_3", 2, "user", JSON.stringify({ text: "more" }));
  insert.run("sess_native_3", 3, "assistant", JSON.stringify({ usage: { inputTokens: 3_000, outputTokens: 400, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 0, reasoningTokens: 20 } }));
  const opensAfterFirst = extractor.metrics.sqliteOpens;
  const grown = await extractor.extract(agent);
  assert.equal(grown!.turns, 2, "only assistant rows beyond the cursor fold");
  assert.equal(grown!.inputUncachedTokens, 500 + 1_000);
  assert.equal(grown!.outputTokens, 700);
  assert.equal(grown!.latestContextWindowTokens, 3_000 + 400);
  const opensAfterDelta = extractor.metrics.sqliteOpens;
  assert.equal(opensAfterDelta, opensAfterFirst + 1, "the delta sweep paid exactly its own single open");
  const unchanged = await extractor.extract(agent);
  assert.deepEqual(unchanged, grown);
  assert.equal(extractor.metrics.sqliteOpens, opensAfterDelta, "an unchanged db answers from the stat gate — zero opens");
});

test("zcode: the operator's ~/.zcode/cli/db/db.sqlite is the fallback store, and the context sensor answers from it", async t => {
  if (!(await nodeSqliteAvailable())) return t.skip("node:sqlite unavailable on this runtime");
  const { userHome, stateDir } = tempHomes(t);
  const cliDb = join(userHome, ".zcode", "cli", "db", "db.sqlite");
  const db = await openSqlite(t, cliDb);
  db.exec("CREATE TABLE message (session_id TEXT, sequence INTEGER, role TEXT, metadata TEXT)");
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("sess_native_4", 1, "assistant", JSON.stringify({ usage: { inputTokens: 140_000, outputTokens: 5_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 } }));
  const agent: UsageAgentSource = { id: "sup-3", provider: "zcode/GLM-5.3", persistence: { sessionId: "sess_native_4" } };
  const usage = await createUsageExtractor({ userHome, stateDir }).extract(agent);
  assert.ok(usage);
  assert.equal(usage.harness, "zcode");
  assert.equal(usage.nativeSessionRef, cliDb, "no factory zcode home exists — the operator's own store answers");
  // The 128k/160k handoff sensors read through the exact same shared extractor (ADR 0043 §3).
  assert.equal(readNativeContextWindowTokens(agent, { userHome, stateDir }), 145_000);
  assert.equal(readNativeContextWindowTokens({ id: "sup-4", provider: "zcode/GLM-5.3", persistence: { sessionId: "acp-not-mapped" } }, { userHome, stateDir }), null, "an unresolvable session answers null, never a guess");
});

// ---- the fallback & honest absence -------------------------------------------------------------

test("with no native store on disk, the volatile lastUsage is the fallback; with neither, the honest absence", async t => {
  const { dir, userHome } = tempHomes(t);
  const extractor = createUsageExtractor({ userHome, stateDir: dir });
  const fallback = await extractor.extract({ id: "peer-5", provider: "pi/zai/glm-5.3", lastUsage: { inputTokens: 1_000, cachedInputTokens: 9_000, outputTokens: 500, totalCostUsd: 0.02 } });
  assert.ok(fallback);
  assert.equal(fallback.harness, "pi");
  assert.equal(fallback.inputUncachedTokens, 1_000);
  assert.equal(fallback.cacheReadTokens, 9_000);
  assert.equal(fallback.outputTokens, 500);
  assert.equal(fallback.totalCostUsd, 0.02);
  assert.equal(await extractor.extract({ id: "peer-6", provider: "pi/zai/glm-5.3" }), undefined, "no store, no lastUsage — undefined, never a fabricated zero");
  assert.equal(await extractor.extract({ id: "peer-7", provider: "pi/zai/glm-5.3", lastUsage: {} }), undefined, "an empty lastUsage is absent, not zero");
});
