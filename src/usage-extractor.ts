/**
 * The multi-provider native session usage extractor (v0.0.87, ADR 0043 §2) —
 * the one module that turns a provider harness's on-disk session store into
 * the four disjoint additive token buckets every Meter consumer reads:
 *
 *   inputUncachedTokens + cacheReadTokens + cacheWriteTokens + outputTokens
 *     = totalTokens          (reasoningTokens ⊆ outputTokens)
 *
 * Seven harness stores are read, each at its own source of truth:
 *
 *   - `pi`          `<stateDir>/pi-agent/<role>/sessions/<cwd-dir>/<session>.jsonl`
 *                    (or the operator's `~/.pi/agent/sessions/`), pointed at by
 *                    `persistence.nativeHandle` — per-assistant-message
 *                    `usage.{input, output, cacheRead, cacheWrite,
 *                    reasoning, cost.total}` summed across the session.
 *   - `codex`       `~/.codex/state_5.sqlite` (`threads.rollout_path`,
 *                    `model`, `model_provider`) → the last `token_count`
 *                    `event_msg` in `rollout-*.jsonl`, whose
 *                    `total_token_usage` is already session-cumulative (and
 *                    whose `last_token_usage` is the context occupancy).
 *                    `cached_input_tokens` is a SUBSET of `input_tokens` in
 *                    Codex, so the reader subtracts it — the double-count
 *                    the normalization exists to kill.
 *   - `opencode`    `~/.local/share/opencode/opencode.db` `session_v2` row —
 *                    pre-aggregated by the harness itself.
 *   - `antigravity` `~/.gemini/antigravity-cli/conversations/<id>.db`
 *                    `steps` (`step_type = 15`) Protobuf `metadata` field 9
 *                    (`tag 0x4A`), decoded per row; the Brain
 *                    `transcript.jsonl` (`PLANNER_RESPONSE`) is the fallback.
 *   - `claude`      `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl` —
 *                    per-assistant-message `message.usage` deltas.
 *   - `copilot`     `~/.copilot/session-state/<sessionId>/events.jsonl` —
 *                    `session.usage_record` deltas (per-turn `inputTokens`
 *                    already contains the cache sums, so the reader
 *                    subtracts `cacheRead + cacheWrite`), with the
 *                    `session.shutdown` `accountingSnapshot` as the
 *                    authoritative final totals when present.
 *
 * Every reader is stat-gated and O(delta): a `(mtimeMs, size)` cursor short-
 * circuits unchanged files with zero disk reads, and JSONL readers seek to
 * `cursor.byteOffset` so a per-turn update pays only the newly appended
 * bytes (ADR 0043 §2's `< 0.2ms` law). When no native store exists on disk
 * yet, the daemon's volatile `lastUsage` is the last-resort fallback —
 * single-turn numbers are still better than no numbers, and the honest
 * absence (`undefined`) is returned when even that is missing.
 *
 * Placement: this file is pure Node (zero Paseo imports) and lives in `src/`
 * because both sides of the placement law consume it — the plugin server's
 * usage rollup (`plugin/server/usage-rollup.ts`) imports the verbatim copy
 * `scripts/sync-plugin-core.mjs` vendors into `plugin/server/core/`, and the
 * CLI mirror (`src/usage-status.ts`) types against this module before
 * `scripts/generate-policies.mjs` compiles it. SQLite is reached through a
 * `node:sqlite` loaded through a synchronous builtin `require` — a runtime
 * without it (an Electron build predating it) degrades to the fallback,
 * never crashes the plugin. Every reader is synchronous on purpose: the
 * Lead (160k) and Peer (200k) context sensors are sync contracts.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

/**
 * The agent descriptor the extractor reads — deliberately structural so the
 * daemon's live `SurfaceAgentSnapshot`, a persisted
 * `<paseoHome>/agents/<cwd>/<agentId>.json` record, and hermetic test
 * fixtures all feed the same reader without conversion.
 */
export interface UsageAgentSource {
  id: string;
  /** The harness id: `pi`, `codex`, `opencode`, `antigravity`, `claude`, `copilot`. */
  provider: string;
  cwd?: string;
  labels?: Record<string, string>;
  /** The agent's selected model, when a snapshot carries it at the top level. */
  model?: string | null;
  config?: { model?: unknown } | null;
  runtimeInfo?: { provider?: unknown; sessionId?: unknown; model?: unknown } | null;
  persistence?: UsagePersistence | null;
  /**
   * The daemon's volatile usage slice — the last-resort fallback when no
   * native session store exists on disk yet (Paseo never persists it).
   */
  lastUsage?: UsageFallbackSlice | null;
}

/** The `persistence` slice Paseo stamps on every agent record. */
export interface UsagePersistence {
  provider?: unknown;
  sessionId?: unknown;
  nativeHandle?: unknown;
  metadata?: unknown;
}

/** The `lastUsage` subset the fallback reads — every field optional, verbatim. */
export interface UsageFallbackSlice {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

/** Configurable store roots — hermetic tests pass temp dirs, never real homes. */
export interface UsagePaths {
  /** Root for `~/.codex`, `~/.claude`, `~/.copilot`, `~/.gemini`, `~/.pi` — default the real home. */
  userHome?: string;
  /** The factory state dir — the isolated `<stateDir>/pi-agent/<role>/sessions` trees are Pi session roots. */
  stateDir?: string;
}

/** The normalized per-session usage — the additive invariant is load-bearing. */
export interface NormalizedUsage {
  harness: string;
  provider: string;
  model: string;
  turns: number;
  inputUncachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  totalCostUsd?: number;
  latestContextWindowTokens?: number;
  /** The exact `.jsonl` path or SQLite session id the numbers came from. */
  nativeSessionRef?: string;
}

/** What one extractor instance counts — the O(1) tests' observable seam. */
export interface UsageExtractorMetrics {
  /** Byte-range reads against JSONL session files (stat gates excluded). */
  fileReads: number;
  /** SQLite databases opened for at least one query. */
  sqliteOpens: number;
}

/** One session's read cursor — the stat gate plus the harness's own offset. */
interface UsageCursor {
  walMtimeMs?: number;
  walSize?: number;
  mtimeMs: number;
  size: number;
  byteOffset: number;
  /** antigravity/zcode: the last folded row id (`steps.idx` / `message.sequence`) — the SQLite row cursor. */
  lastStepIdx: number;
  snapshot: NormalizedUsage;
}

/** The zeroed accumulator every reader starts from. */
function emptyUsage(harness: string, provider: string, model: string): NormalizedUsage {
  return {
    harness,
    provider,
    model,
    turns: 0,
    inputUncachedTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteOr(value: unknown, fallback: number): number {
  return finite(value) ?? fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** `provider` reduced to the harness family — `pi/zai/glm-5.3` → `pi`. */
function harnessOf(provider: string): string {
  const at = provider.indexOf("/");
  return (at === -1 ? provider : provider.slice(0, at)).toLowerCase();
}

/** The record's model, from wherever a snapshot or session file named it. */
function modelFallback(agent: UsageAgentSource): string {
  return (
    asString(agent.model) ??
    asString((agent.config as { model?: unknown } | null | undefined)?.model) ??
    asString(agent.runtimeInfo?.model) ??
    "unknown"
  );
}

/** The vendor family each harness defaults to when the store names no provider. */
const HARNESS_PROVIDERS: Readonly<Record<string, string>> = {
  pi: "pi",
  codex: "openai",
  opencode: "opencode",
  antigravity: "antigravity",
  claude: "anthropic",
  copilot: "copilot",
};

/**
 * The record's provider-family string — `zai`, `openai`, `antigravity`,
 * `anthropic`, `copilot` (the spec's `byModel` pairs name `<provider>/<model>`).
 * A 3-segment lane (`pi/zai/glm-5.3`) carries its family in segment 2; every
 * other shape falls to the harness's vendor, and a store that names the real
 * provider (codex sqlite, opencode model JSON, copilot usage, pi messages)
 * always overrides this default.
 */
function providerOrHarness(agent: UsageAgentSource): string {
  const parts = agent.provider.split("/");
  if (parts.length >= 3 && parts[0] !== "") return parts[1]!;
  const harness = harnessOf(agent.provider);
  return HARNESS_PROVIDERS[harness] ?? harness;
}

function retotal(usage: NormalizedUsage): void {
  usage.totalTokens = usage.inputUncachedTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}

// ---- the shared stat gate & incremental JSONL reader -----------------------------------------

interface SessionStat {
  mtimeMs: number;
  size: number;
}

function statSession(path: string): SessionStat | undefined {
  try {
    const raw = statSync(path);
    return { mtimeMs: raw.mtimeMs, size: raw.size };
  } catch {
    return undefined;
  }
}

/**
 * The stat gate: the cursor answers when `(mtimeMs, size)` is unchanged —
 * zero disk reads — else the fresh stat rides out for the caller's fold.
 */
function statGate(cursor: UsageCursor | undefined, path: string): { hit: UsageCursor } | { stat: SessionStat } | undefined {
  const stat = statSession(path);
  if (stat === undefined) return undefined;
  if (cursor !== undefined && cursor.mtimeMs === stat.mtimeMs && cursor.size === stat.size) return { hit: cursor };
  return { stat };
}

/**
 * Reads `length` bytes at `position` — the one primitive every incremental
 * JSONL reader pays through, so the metrics counter is the whole truth.
 */
function readRange(fd: number, position: number, length: number, metrics: UsageExtractorMetrics): string {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, position + filled);
    if (read <= 0) break;
    filled += read;
  }
  metrics.fileReads += 1;
  return buffer.subarray(0, filled).toString("utf8");
}

/**
 * Reads only the complete new lines appended since `offset` — the partial
 * trailing line stays unread until its newline lands. Returns the new offset
 * (equal to `offset` when nothing complete arrived) plus the delta text.
 */
function readNewLines(path: string, offset: number, metrics: UsageExtractorMetrics): { offset: number; text: string } {
  const stat = statSession(path);
  if (stat === undefined || stat.size <= offset) return { offset, text: "" };
  const fd = openSync(path, "r");
  try {
    const text = readRange(fd, offset, stat.size - offset, metrics);
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return { offset, text: "" };
    return { offset: offset + lastNewline + 1, text: text.slice(0, lastNewline) };
  } finally {
    closeSync(fd);
  }
}

/** Parses one JSONL text block into objects, skipping damaged lines. */
function parseLines(text: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) parsed.push(value as Record<string, unknown>);
    } catch {
      // a damaged line is skipped, never trusted
    }
  }
  return parsed;
}

/** `(usage, object)` — the running snapshot continued from a prior cursor. */
function continued(cursor: UsageCursor | undefined, agent: UsageAgentSource, harness: string): NormalizedUsage {
  return cursor !== undefined ? { ...cursor.snapshot } : emptyUsage(harness, providerOrHarness(agent), modelFallback(agent));
}

// ---- the pi reader --------------------------------------------------------------------------

/** Recursively lists `.jsonl` files under `root` whose name contains `needle` — absent roots answer empty. */
function findSessionFiles(root: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(needle)) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function newestOf(paths: string[]): string {
  let newest = paths[0]!;
  let newestMs = -1;
  for (const path of paths) {
    const mtimeMs = statSession(path)?.mtimeMs ?? -1;
    if (mtimeMs > newestMs) {
      newest = path;
      newestMs = mtimeMs;
    }
  }
  return newest;
}

/**
 * Resolves the Pi session file: `persistence.nativeHandle` verbatim when it
 * is a readable `.jsonl`, else the newest `*<sessionId>*.jsonl` under the
 * factory's isolated `<stateDir>/pi-agent/<role>/sessions` trees or the
 * operator's `~/.pi/agent/sessions/`.
 */
function resolvePiSession(agent: UsageAgentSource, paths: Required<UsagePaths>): string | undefined {
  const native = asString(agent.persistence?.nativeHandle);
  if (native !== undefined && native.endsWith(".jsonl") && existsSync(native)) return native;
  const sessionId = asString(agent.persistence?.sessionId) ?? asString(agent.runtimeInfo?.sessionId);
  if (sessionId === undefined) return undefined;
  const roots = paths.stateDir !== "" ? [join(paths.stateDir, "pi-agent"), join(paths.userHome, ".pi", "agent", "sessions")] : [join(paths.userHome, ".pi", "agent", "sessions")];
  for (const root of roots) {
    const candidates = findSessionFiles(root, sessionId);
    if (candidates.length > 0) return newestOf(candidates);
  }
  return undefined;
}

/**
 * The Pi fold: every assistant message's `usage` is per-turn, so the session
 * totals are sums, and the context occupancy is the LAST message's
 * `input + cacheRead + cacheWrite + output`. `message.provider`/`model` name
 * the lane when present.
 */
function extractPi(agent: UsageAgentSource, sessionPath: string, cursor: UsageCursor | undefined, metrics: UsageExtractorMetrics): UsageCursor | undefined {
  const gate = statGate(cursor, sessionPath);
  if (gate === undefined) return undefined;
  if ("hit" in gate) return gate.hit;
  if (gate.stat.size < (cursor?.byteOffset ?? 0)) return undefined; // truncated/rotated — the cursor is a lie, decline
  const usage = continued(cursor, agent, "pi");
  usage.nativeSessionRef = sessionPath;
  const delta = readNewLines(sessionPath, cursor?.byteOffset ?? 0, metrics);
  let latestContext = usage.latestContextWindowTokens;
  for (const record of parseLines(delta.text)) {
    if (record.type !== "message") continue;
    const message = record.message;
    if (typeof message !== "object" || message === null) continue;
    const typed = message as { role?: unknown; usage?: unknown; provider?: unknown; model?: unknown };
    if (typed.role !== "assistant") continue;
    const provider = asString(typed.provider);
    if (provider !== undefined) usage.provider = provider;
    const model = asString(typed.model);
    if (model !== undefined) usage.model = model;
    if (typeof typed.usage !== "object" || typed.usage === null) continue;
    const u = typed.usage as Record<string, unknown>;
    const input = finiteOr(u.input, 0);
    const output = finiteOr(u.output, 0);
    const cacheRead = finiteOr(u.cacheRead, 0);
    const cacheWrite = finiteOr(u.cacheWrite, 0);
    usage.turns += 1;
    usage.inputUncachedTokens += input;
    usage.outputTokens += output;
    usage.cacheReadTokens += cacheRead;
    usage.cacheWriteTokens += cacheWrite;
    usage.reasoningTokens += finiteOr(u.reasoning, 0);
    const cost = typeof u.cost === "object" && u.cost !== null ? finite((u.cost as Record<string, unknown>).total) : null;
    if (cost !== null) usage.totalCostUsd = (usage.totalCostUsd ?? 0) + cost;
    latestContext = input + cacheRead + cacheWrite + output;
  }
  if (latestContext !== undefined) usage.latestContextWindowTokens = latestContext;
  retotal(usage);
  if (usage.turns === 0 && cursor === undefined) return undefined; // a session with no usage yet — the honest absence
  return { mtimeMs: gate.stat.mtimeMs, size: gate.stat.size, byteOffset: delta.offset, lastStepIdx: 0, snapshot: usage };
}

// ---- SQLite (node:sqlite, lazily imported) ---------------------------------------------------

type SqliteDatabase = {
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[] };
  close: () => void;
};

let sqliteDatabaseSync: (new (path: string, options?: { readOnly?: boolean }) => unknown) | null | undefined;

/**
 * Resolves `node:sqlite`'s `DatabaseSync` once, synchronously (a builtin
 * `require` — the Lead (160k) and Peer (200k) sensors are sync contracts) — `null` when this
 * runtime lacks it (degrade, never crash).
 *
 * Uses a synthetic CJS path (`join(process.cwd(), "factory-sqlite.cjs")`)
 * rather than `import.meta.url` because Paseo compiles `plugin/index.server.ts`
 * into a CommonJS bundle (`format: "cjs"`) where `import.meta` is `{}` and
 * top-level `createRequire(import.meta.url)` throws `ERR_INVALID_ARG_VALUE`.
 */
function loadSqliteSync(): (new (path: string, options?: { readOnly?: boolean }) => unknown) | null {
  if (sqliteDatabaseSync === undefined) {
    try {
      const requireNodeBuiltin = createRequire(join(process.cwd(), "factory-sqlite.cjs"));
      sqliteDatabaseSync = requireNodeBuiltin("node:sqlite").DatabaseSync;
    } catch {
      sqliteDatabaseSync = null;
    }
  }
  return sqliteDatabaseSync ?? null;
}

/**
 * Opens an EXISTING SQLite database (the existence gate first, so a missing
 * store never creates one), runs one worker, and always closes. Any failure
 * answers `undefined`. `readOnly: true` opens the store for reads only — the
 * zcode reader's contract against the operator's live db; every pre-existing
 * caller passes no options and keeps its read-write open.
 */
function querySqlite<T>(path: string, worker: (db: SqliteDatabase) => T, metrics: UsageExtractorMetrics, options?: { readOnly?: boolean }): T | undefined {
  if (!existsSync(path)) return undefined;
  const DatabaseSync = loadSqliteSync();
  if (DatabaseSync === null) return undefined;
  let db: SqliteDatabase;
  try {
    // `undefined` as an explicit second argument REJECTS in node's DatabaseSync — options ride only when asked for.
    db = (options?.readOnly === true ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path)) as unknown as SqliteDatabase;
  } catch {
    return undefined;
  }
  metrics.sqliteOpens += 1;
  try {
    return worker(db);
  } catch {
    return undefined;
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

// ---- the codex reader -----------------------------------------------------------------------

/** How much of a Codex rollout a cold read scans — the last 64 KB carries the latest totals. */
const CODEX_TAIL_BYTES = 64 * 1024;

interface CodexThreadRow {
  rollout_path?: unknown;
  model?: unknown;
  model_provider?: unknown;
}

/**
 * The Codex fold: `state_5.sqlite` resolves the rollout file (cached per
 * thread id), and the file's LAST `token_count` `event_msg` carries
 * session-cumulative `total_token_usage` plus the current occupancy in
 * `last_token_usage`. `cached_input_tokens` ⊂ `input_tokens`, so the
 * subtraction is the normalization. Turns accumulate across incremental
 * deltas; the cumulative totals are absolute, so only a delta that actually
 * carries a `token_count` refreshes them.
 */
function extractCodex(
  agent: UsageAgentSource,
  threadId: string,
  rolloutOf: (threadId: string) => { rolloutPath?: string; provider?: string; model?: string } | undefined,
  cursor: UsageCursor | undefined,
  metrics: UsageExtractorMetrics,
): UsageCursor | undefined {
  const thread = rolloutOf(threadId);
  const rolloutPath = asString(thread?.rolloutPath);
  if (rolloutPath === undefined) return undefined;
  const gate = statGate(cursor, rolloutPath);
  if (gate === undefined) return undefined;
  if ("hit" in gate) return gate.hit;
  if (gate.stat.size < (cursor?.byteOffset ?? 0)) return undefined; // rotated — decline rather than mis-fold
  const usage = continued(cursor, agent, "codex");
  const provider = asString(thread?.provider);
  if (provider !== undefined) usage.provider = provider;
  const threadModel = asString(thread?.model);
  if (threadModel !== undefined && usage.model === "unknown") usage.model = threadModel;
  usage.nativeSessionRef = rolloutPath;
  let newTurns = 0;
  // Cold starts scan the tail (the last 64 KB carries the latest cumulative
  // totals); incremental reads resume from the cursor's own offset.
  const readFrom = cursor?.byteOffset ?? Math.max(0, gate.stat.size - CODEX_TAIL_BYTES);
  const delta = readNewLines(rolloutPath, readFrom, metrics);
  for (const record of parseLines(delta.text)) {
    if (record.type === "turn_context") {
      const payload = record.payload;
      if (typeof payload === "object" && payload !== null) {
        const model = asString((payload as { model?: unknown }).model);
        if (model !== undefined) usage.model = model;
      }
    } else if (record.type === "event_msg") {
      const payload = record.payload;
      if (typeof payload !== "object" || payload === null || (payload as { type?: unknown }).type !== "token_count") continue;
      newTurns += 1;
      const info = (typeof (payload as { info?: unknown }).info === "object" && (payload as { info?: unknown }).info !== null ? (payload as { info?: unknown }).info : undefined) as Record<string, unknown> | undefined;
      if (info === undefined) continue;
      const total = (typeof info.total_token_usage === "object" && info.total_token_usage !== null ? info.total_token_usage : undefined) as Record<string, unknown> | undefined;
      const last = (typeof info.last_token_usage === "object" && info.last_token_usage !== null ? info.last_token_usage : undefined) as Record<string, unknown> | undefined;
      if (total !== undefined) {
        const input = finiteOr(total.input_tokens, 0);
        const cached = finiteOr(total.cached_input_tokens, 0);
        usage.inputUncachedTokens = Math.max(0, input - cached); // cached ⊂ input in Codex
        usage.cacheReadTokens = cached;
        usage.cacheWriteTokens = finiteOr(total.cache_write_input_tokens, 0);
        usage.outputTokens = finiteOr(total.output_tokens, 0);
        usage.reasoningTokens = finiteOr(total.reasoning_output_tokens, 0);
      }
      if (last !== undefined) usage.latestContextWindowTokens = finiteOr(last.input_tokens, 0) + finiteOr(last.output_tokens, 0);
    }
  }
  usage.turns += newTurns;
  retotal(usage);
  if (usage.turns === 0 && cursor === undefined) return undefined;
  return { mtimeMs: gate.stat.mtimeMs, size: gate.stat.size, byteOffset: delta.offset, lastStepIdx: 0, snapshot: usage };
}

// ---- the opencode reader --------------------------------------------------------------------

/**
 * The opencode fold: the harness pre-aggregates the whole session into one
 * `session_v2` row, so the read is a primary-key lookup and the cursor is
 * the database and WAL files' `(mtimeMs, size)`.
 */
function extractOpencode(
  agent: UsageAgentSource,
  sessionId: string,
  dbPath: string,
  cursor: UsageCursor | undefined,
  metrics: UsageExtractorMetrics,
): UsageCursor | undefined {
  const stat = statSession(dbPath);
  if (stat === undefined) return undefined;
  const wal = statSession(`${dbPath}-wal`);
  // Native opencode keeps a WAL open: new messages need not touch the main
  // database until a checkpoint, so both files participate in this cache.
  if (cursor !== undefined && cursor.mtimeMs === stat.mtimeMs && cursor.size === stat.size && cursor.walMtimeMs === wal?.mtimeMs && cursor.walSize === wal?.size) return cursor;
  const row = querySqlite<Record<string, unknown>>(
    dbPath,
    db => db.prepare("SELECT tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost, model FROM session_v2 WHERE id = ?").get(sessionId) as never,
    metrics,
    { readOnly: true },
  );
  if (row === undefined) return undefined;
  const usage = continued(cursor, agent, "opencode");
  usage.nativeSessionRef = sessionId;
  let modelJson: { id?: unknown; providerID?: unknown } | undefined;
  if (typeof row.model === "string") {
    try {
      const parsed: unknown = JSON.parse(row.model);
      if (typeof parsed === "object" && parsed !== null) modelJson = parsed as { id?: unknown; providerID?: unknown };
    } catch {
      // a non-JSON model column is ignored
    }
  }
  const providerId = asString(modelJson?.providerID);
  if (providerId !== undefined) usage.provider = providerId;
  const modelId = asString(modelJson?.id);
  if (modelId !== undefined) usage.model = modelId;
  usage.inputUncachedTokens = finiteOr(row.tokens_input, 0);
  usage.outputTokens = finiteOr(row.tokens_output, 0);
  usage.reasoningTokens = finiteOr(row.tokens_reasoning, 0);
  usage.cacheReadTokens = finiteOr(row.tokens_cache_read, 0);
  usage.cacheWriteTokens = finiteOr(row.tokens_cache_write, 0);
  const cost = finite(row.cost);
  if (cost !== null) usage.totalCostUsd = cost;
  const messages = querySqlite<{ count: unknown; latest?: Record<string, unknown> }>(
    dbPath,
    db => {
      // New opencode stores the role in `type` and its stable order in `seq`.
      // Older stores encode the role in JSON and only have message ids.
      const columns = new Set((db.prepare("PRAGMA table_info(session_message)").all() as { name: string }[]).map(column => column.name));
      const assistant = columns.has("type") ? "type = 'assistant'" : "json_extract(data, '$.role') = 'assistant'";
      const order = columns.has("seq") ? "seq DESC, id DESC" : columns.has("time_created") ? "time_created DESC, id DESC" : "id DESC";
      const count = (db.prepare(`SELECT COUNT(*) AS count FROM session_message WHERE session_id = ? AND json_valid(data) AND ${assistant}`).get(sessionId) as { count: unknown }).count;
      // The last assistant that actually reports tokens is occupancy. A later
      // user message or incomplete assistant without usage does not erase it.
      const tokenPaths = ["$.tokens.input", "$.tokens.output", "$.tokens.cache.read", "$.tokens.cache.write"];
      const hasTokens = tokenPaths.map(path => `json_type(data, '${path}') IN ('integer', 'real')`).join(" OR ");
      const row = db.prepare(`SELECT data FROM session_message WHERE session_id = ? AND json_valid(data) AND ${assistant} AND (${hasTokens}) ORDER BY ${order} LIMIT 1`).get(sessionId) as { data?: unknown } | undefined;
      const latest = typeof row?.data === "string" ? JSON.parse(row.data) as Record<string, unknown> : undefined;
      return { count, latest };
    },
    metrics,
    { readOnly: true },
  );
  usage.turns = finiteOr(messages?.count, usage.turns);
  delete usage.latestContextWindowTokens;
  const tokens = messages?.latest?.tokens;
  if (typeof tokens === "object" && tokens !== null) {
    const value = tokens as Record<string, unknown>;
    const cache = typeof value.cache === "object" && value.cache !== null ? value.cache as Record<string, unknown> : {};
    // Reasoning is a breakdown of output, so it must not be added again.
    usage.latestContextWindowTokens = finiteOr(value.input, 0) + finiteOr(value.output, 0) + finiteOr(cache.read, 0) + finiteOr(cache.write, 0);
  }
  // session_v2 is cumulative accounting only; it NEVER supplies occupancy.
  retotal(usage);
  if (usage.turns === 0 && usage.totalTokens === 0 && cursor === undefined) return undefined;
  return { mtimeMs: stat.mtimeMs, size: stat.size, walMtimeMs: wal?.mtimeMs, walSize: wal?.size, byteOffset: 0, lastStepIdx: 0, snapshot: usage };
}

// ---- the antigravity reader -----------------------------------------------------------------

/** The known planner model enums — extended as empirical runs name more. */
const ANTIGRAVITY_MODELS: ReadonlyMap<number, string> = new Map([[1417, "gemini-4-argon-high"]]);

function readVarint(bytes: Uint8Array, from: number): { value: number; next: number } | undefined {
  let value = 0;
  let shift = 0;
  let index = from;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    value += (byte & 0x7f) * 2 ** shift;
    index += 1;
    if ((byte & 0x80) === 0) return Number.isSafeInteger(value) ? { value, next: index } : undefined;
    shift += 7;
    if (shift > 63) return undefined;
  }
  return undefined;
}

function skipField(bytes: Uint8Array, from: number, wire: number): number | undefined {
  if (wire === 0) return readVarint(bytes, from)?.next;
  if (wire === 1) return from + 8 <= bytes.length ? from + 8 : undefined;
  if (wire === 2) {
    const length = readVarint(bytes, from);
    if (length === undefined || length.next + length.value > bytes.length) return undefined;
    return length.next + length.value;
  }
  if (wire === 5) return from + 4 <= bytes.length ? from + 4 : undefined;
  return undefined; // groups (3/4) are long dead — decline
}

/** One decoded Antigravity usage submessage — the field numbers are the schema. */
export interface AntigravityStepUsage {
  modelEnum?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
  responseTokens: number;
}

/**
 * Decodes one `steps.metadata` Protobuf blob's usage submessage (field 9,
 * tag `0x4A`): field 1 `modelEnum`, field 2 `input_tokens`, field 3
 * `output_tokens` (thinking + response), field 5 `cache_read_tokens`, field
 * 9 `thinking_tokens`, field 10 `response_tokens`. Every other field is
 * skipped by wire type — the schema may grow around us.
 */
export function decodeAntigravityUsage(blob: Uint8Array): AntigravityStepUsage | undefined {
  let usage: AntigravityStepUsage | undefined;
  let index = 0;
  while (index < blob.length) {
    const tag = readVarint(blob, index);
    if (tag === undefined) return usage;
    index = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (field === 9 && wire === 2) {
      const length = readVarint(blob, index);
      if (length === undefined || length.next + length.value > blob.length) return usage;
      const sub = blob.subarray(length.next, length.next + length.value);
      const decoded: AntigravityStepUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, responseTokens: 0 };
      let subIndex = 0;
      while (subIndex < sub.length) {
        const subTag = readVarint(sub, subIndex);
        if (subTag === undefined) break;
        subIndex = subTag.next;
        const subField = subTag.value >>> 3;
        if ((subTag.value & 7) !== 0) {
          const skipped = skipField(sub, subIndex, subTag.value & 7);
          if (skipped === undefined) break;
          subIndex = skipped;
          continue;
        }
        const value = readVarint(sub, subIndex);
        if (value === undefined) break;
        subIndex = value.next;
        if (subField === 1) decoded.modelEnum = value.value;
        else if (subField === 2) decoded.inputTokens = value.value;
        else if (subField === 3) decoded.outputTokens = value.value;
        else if (subField === 5) decoded.cacheReadTokens = value.value;
        else if (subField === 9) decoded.thinkingTokens = value.value;
        else if (subField === 10) decoded.responseTokens = value.value;
      }
      usage = decoded;
      index = length.next + length.value;
    } else {
      const skipped = skipField(blob, index, wire);
      if (skipped === undefined) return usage;
      index = skipped;
    }
  }
  return usage;
}

/**
 * Resolves the Antigravity conversation id: the plugin persistence
 * metadata's `conversationId`, the `plugin:{...}` JSON wrapper Paseo stamps
 * into `persistence.sessionId`, or a bare conversation id.
 */
export function antigravityConversationIdOf(agent: UsageAgentSource): string | undefined {
  const fromObject = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const plugin = (value as { pluginProviderPersistence?: unknown }).pluginProviderPersistence;
    if (typeof plugin !== "object" || plugin === null) return undefined;
    const data = (plugin as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) return undefined;
    return asString((data as { conversationId?: unknown }).conversationId);
  };
  const metadata = agent.persistence?.metadata;
  if (typeof metadata === "string") {
    try {
      const parsed: unknown = JSON.parse(metadata);
      const direct = fromObject(parsed);
      if (direct !== undefined) return direct;
    } catch {
      // fall through to the sessionId arms
    }
  } else {
    const direct = fromObject(metadata);
    if (direct !== undefined) return direct;
  }
  const sessionId = asString(agent.persistence?.sessionId);
  if (sessionId === undefined) return undefined;
  if (sessionId.startsWith("plugin:")) {
    try {
      const parsed: unknown = JSON.parse(sessionId.slice("plugin:".length));
      if (typeof parsed === "object" && parsed !== null) {
        const data = (parsed as { data?: unknown }).data;
        if (typeof data === "object" && data === null) return undefined;
        const id = typeof data === "object" && data !== null ? asString((data as { conversationId?: unknown }).conversationId) : undefined;
        if (id !== undefined) return id;
      }
    } catch {
      // fall through
    }
    return undefined;
  }
  return sessionId;
}

/**
 * The Antigravity fold: every `steps` row of `step_type = 15` is one planner
 * response carrying its own token counts in Protobuf `metadata` field 9, so
 * the session totals are sums over rows beyond `cursor.lastStepIdx` — the
 * row-index cursor is what makes the sweep O(delta). The Brain
 * `transcript.jsonl` is the fallback when the SQLite store is absent.
 */
function extractAntigravity(
  agent: UsageAgentSource,
  conversationId: string,
  userHome: string,
  cursor: UsageCursor | undefined,
  metrics: UsageExtractorMetrics,
): UsageCursor | undefined {
  const dbPath = join(userHome, ".gemini", "antigravity-cli", "conversations", `${conversationId}.db`);
  if (existsSync(dbPath)) {
    const gate = statGate(cursor, dbPath);
    if (gate === undefined) return undefined;
    if ("hit" in gate) return gate.hit;
    const rows = querySqlite<{ idx?: unknown; metadata?: Uint8Array }[]>(
      dbPath,
      db => db.prepare("SELECT idx, metadata FROM steps WHERE step_type = 15 AND idx > ? ORDER BY idx ASC").all(cursor?.lastStepIdx ?? -1) as never,
      metrics,
    );
    if (rows === undefined) return undefined;
    const usage = continued(cursor, agent, "antigravity");
    usage.nativeSessionRef = conversationId;
    let lastStepIdx = cursor?.lastStepIdx ?? -1;
    for (const row of rows) {
      const idx = finite(row.idx);
      if (idx !== null) lastStepIdx = Math.max(lastStepIdx, idx);
      const blob = row.metadata;
      if (!(blob instanceof Uint8Array) || blob.length === 0) continue; // node:sqlite answers BLOB as Uint8Array
      const step = decodeAntigravityUsage(blob);
      if (step === undefined) continue;
      usage.turns += 1;
      usage.inputUncachedTokens += step.inputTokens;
      usage.outputTokens += step.outputTokens;
      usage.cacheReadTokens += step.cacheReadTokens;
      usage.reasoningTokens += step.thinkingTokens;
      if (step.modelEnum !== undefined) usage.model = ANTIGRAVITY_MODELS.get(step.modelEnum) ?? `model-${step.modelEnum}`;
      usage.latestContextWindowTokens = step.inputTokens + step.cacheReadTokens + step.outputTokens;
    }
    retotal(usage);
    if (usage.turns === 0 && cursor === undefined) return undefined;
    return { mtimeMs: gate.stat.mtimeMs, size: gate.stat.size, byteOffset: 0, lastStepIdx, snapshot: usage };
  }
  // The Brain transcript fallback — `PLANNER_RESPONSE` lines carrying usage.
  const transcript = join(userHome, ".gemini", "antigravity", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
  const gate = statGate(cursor, transcript);
  if (gate === undefined) return undefined;
  if ("hit" in gate) return gate.hit;
  if (gate.stat.size < (cursor?.byteOffset ?? 0)) return undefined;
  const usage = continued(cursor, agent, "antigravity");
  usage.nativeSessionRef = transcript;
  const delta = readNewLines(transcript, cursor?.byteOffset ?? 0, metrics);
  for (const record of parseLines(delta.text)) {
    const kind = asString(record.type) ?? asString((record.event as { type?: unknown } | undefined)?.type);
    if (kind === undefined || !kind.includes("PLANNER_RESPONSE")) continue;
    const holder = (typeof record.usage === "object" && record.usage !== null
      ? record.usage
      : typeof record.data === "object" && record.data !== null
        ? (record.data as { usage?: unknown }).usage
        : undefined) as Record<string, unknown> | undefined;
    if (holder === undefined) continue;
    const input = finiteOr(holder.input_tokens, 0);
    const output = finiteOr(holder.output_tokens, 0);
    const cacheRead = finiteOr(holder.cache_read_tokens, 0);
    const thinking = finiteOr(holder.thinking_tokens, 0);
    usage.turns += 1;
    usage.inputUncachedTokens += input;
    usage.outputTokens += output;
    usage.cacheReadTokens += cacheRead;
    usage.reasoningTokens += thinking;
    usage.latestContextWindowTokens = input + cacheRead + output;
  }
  retotal(usage);
  if (usage.turns === 0 && cursor === undefined) return undefined;
  return { mtimeMs: gate.stat.mtimeMs, size: gate.stat.size, byteOffset: delta.offset, lastStepIdx: 0, snapshot: usage };
}

// ---- the claude reader ----------------------------------------------------------------------

/** Claude's project-directory encoding of a cwd — every non-alphanumeric run collapses to `-`. */
export function claudeProjectDirOf(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200);
}

/**
 * The Claude fold: `<userHome>/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`,
 * per-assistant-message `message.usage` deltas summed, `message.model` of
 * the last assistant naming the model.
 */
function extractClaude(agent: UsageAgentSource, sessionId: string, userHome: string, cursor: UsageCursor | undefined, metrics: UsageExtractorMetrics): UsageCursor | undefined {
  const cwd = asString(agent.cwd);
  if (cwd === undefined) return undefined;
  const sessionPath = join(userHome, ".claude", "projects", claudeProjectDirOf(cwd), `${sessionId}.jsonl`);
  const gate = statGate(cursor, sessionPath);
  if (gate === undefined) return undefined;
  if ("hit" in gate) return gate.hit;
  if (gate.stat.size < (cursor?.byteOffset ?? 0)) return undefined;
  const usage = continued(cursor, agent, "claude");
  usage.nativeSessionRef = sessionPath;
  const delta = readNewLines(sessionPath, cursor?.byteOffset ?? 0, metrics);
  let latestContext = usage.latestContextWindowTokens;
  for (const record of parseLines(delta.text)) {
    if (record.type !== "assistant") continue;
    const message = record.message;
    if (typeof message !== "object" || message === null) continue;
    const typed = message as { usage?: unknown; model?: unknown };
    const model = asString(typed.model);
    if (model !== undefined) usage.model = model;
    if (typeof typed.usage !== "object" || typed.usage === null) continue;
    const u = typed.usage as Record<string, unknown>;
    const input = finiteOr(u.input_tokens, 0);
    const cacheRead = finiteOr(u.cache_read_input_tokens, 0);
    const cacheWrite = finiteOr(u.cache_creation_input_tokens, 0);
    const output = finiteOr(u.output_tokens, 0);
    usage.turns += 1;
    usage.inputUncachedTokens += input;
    usage.cacheReadTokens += cacheRead;
    usage.cacheWriteTokens += cacheWrite;
    usage.outputTokens += output;
    latestContext = input + cacheRead + cacheWrite + output;
  }
  if (latestContext !== undefined) usage.latestContextWindowTokens = latestContext;
  retotal(usage);
  if (usage.turns === 0 && cursor === undefined) return undefined;
  return { mtimeMs: gate.stat.mtimeMs, size: gate.stat.size, byteOffset: delta.offset, lastStepIdx: 0, snapshot: usage };
}

// ---- the copilot reader ---------------------------------------------------------------------

/**
 * The Copilot fold: `session.usage_record` events are per-turn; per-turn
 * `inputTokens` already CONTAINS the cache sums (verified against
 * `session.shutdown`'s `accountingSnapshot.tokenDetails`, where `24 +
 * 304,564 + 76,543` matches the per-turn `inputTokens` sum), so the reader
 * subtracts `cacheRead + cacheWrite` from each turn before accumulating. A
 * `session.shutdown` carrying `accountingSnapshot.tokenDetails` replaces
 * the accumulated totals — the harness's own final word.
 */
function extractCopilot(agent: UsageAgentSource, sessionId: string, userHome: string, cursor: UsageCursor | undefined, metrics: UsageExtractorMetrics): UsageCursor | undefined {
  const sessionPath = join(userHome, ".copilot", "session-state", sessionId, "events.jsonl");
  const gate = statGate(cursor, sessionPath);
  if (gate === undefined) return undefined;
  if ("hit" in gate) return gate.hit;
  if (gate.stat.size < (cursor?.byteOffset ?? 0)) return undefined;
  const usage = continued(cursor, agent, "copilot");
  usage.nativeSessionRef = sessionPath;
  const delta = readNewLines(sessionPath, cursor?.byteOffset ?? 0, metrics);
  let latestContext = usage.latestContextWindowTokens;
  for (const record of parseLines(delta.text)) {
    const type = asString(record.type);
    const data = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : undefined;
    if (type === "session.usage_record") {
      const u = (typeof data?.usage === "object" && data.usage !== null ? data.usage : undefined) as Record<string, unknown> | undefined;
      if (u === undefined) continue;
      const model = asString(u.model);
      if (model !== undefined) usage.model = model;
      const provider = typeof u.provider === "object" && u.provider !== null ? asString((u.provider as { id?: unknown }).id) : undefined;
      if (provider !== undefined) usage.provider = provider;
      const input = finiteOr(u.inputTokens, 0);
      const output = finiteOr(u.outputTokens, 0);
      const cacheRead = finiteOr(u.cacheReadTokens, 0);
      const cacheWrite = finiteOr(u.cacheWriteTokens, 0);
      usage.turns += 1;
      usage.inputUncachedTokens += Math.max(0, input - cacheRead - cacheWrite);
      usage.cacheReadTokens += cacheRead;
      usage.cacheWriteTokens += cacheWrite;
      usage.outputTokens += output;
      usage.reasoningTokens += finiteOr(u.reasoningTokens, 0);
      latestContext = input + output;
    } else if (type === "session.shutdown") {
      const snapshot = typeof data?.accountingSnapshot === "object" && data.accountingSnapshot !== null ? (data.accountingSnapshot as Record<string, unknown>) : undefined;
      const details = snapshot !== undefined && typeof snapshot.tokenDetails === "object" && snapshot.tokenDetails !== null ? (snapshot.tokenDetails as Record<string, unknown>) : undefined;
      if (details !== undefined) {
        // The harness's final word replaces the accumulated totals. A
        // `usage_record` after the shutdown cannot occur in copilot's own
        // semantics — the shutdown event terminates the session's file.
        usage.inputUncachedTokens = finiteOr(details.input, 0);
        usage.cacheReadTokens = finiteOr(details.cache_read, 0);
        usage.cacheWriteTokens = finiteOr(details.cache_write, 0);
        usage.outputTokens = finiteOr(details.output, 0);
      }
    }
  }
  if (latestContext !== undefined) usage.latestContextWindowTokens = latestContext;
  retotal(usage);
  if (usage.turns === 0 && cursor === undefined) return undefined;
  return { mtimeMs: gate.stat.mtimeMs, size: gate.stat.size, byteOffset: delta.offset, lastStepIdx: 0, snapshot: usage };
}

// ---- the fallback ---------------------------------------------------------------------------

/** The volatile `lastUsage` fallback — single-turn numbers beat no numbers. */
function extractFromLastUsage(agent: UsageAgentSource): NormalizedUsage | undefined {
  const last = agent.lastUsage;
  if (last === null || last === undefined) return undefined;
  const input = finite(last.inputTokens);
  const cached = finite(last.cachedInputTokens);
  const output = finite(last.outputTokens);
  const cost = finite(last.totalCostUsd);
  if (input === null && cached === null && output === null && cost === null) return undefined;
  const usage = emptyUsage(harnessOf(agent.provider), providerOrHarness(agent), modelFallback(agent));
  usage.inputUncachedTokens = input ?? 0;
  usage.cacheReadTokens = cached ?? 0;
  usage.outputTokens = output ?? 0;
  if (cost !== null) usage.totalCostUsd = cost;
  retotal(usage);
  return usage;
}

// ---- the extractor --------------------------------------------------------------------------

export interface UsageExtractor {
  /** One agent's normalized session usage — `undefined` when no store answered. */
  extract: (agent: UsageAgentSource) => NormalizedUsage | undefined;
  /** The O(1) law's observable counters — tests assert on these. */
  metrics: UsageExtractorMetrics;
}

/** Creates an extractor with its own cursor map — one per long-lived consumer. */
export function createUsageExtractor(pathsInput?: UsagePaths): UsageExtractor {
  const paths: Required<UsagePaths> = { userHome: pathsInput?.userHome ?? homedir(), stateDir: pathsInput?.stateDir ?? "" };
  const metrics: UsageExtractorMetrics = { fileReads: 0, sqliteOpens: 0 };
  const cursors = new Map<string, UsageCursor>();
  const codexThreads = new Map<string, { rolloutPath?: string; provider?: string; model?: string }>();
  const rolloutOf = (threadId: string): { rolloutPath?: string; provider?: string; model?: string } | undefined => {
    const cached = codexThreads.get(threadId);
    if (cached !== undefined) return cached;
    const row = querySqlite<CodexThreadRow>(
      join(paths.userHome, ".codex", "state_5.sqlite"),
      db => db.prepare("SELECT rollout_path, model, model_provider FROM threads WHERE id = ?").get(threadId) as never,
      metrics,
    );
    const resolved = { rolloutPath: asString(row?.rollout_path), provider: asString(row?.model_provider), model: asString(row?.model) };
    if (resolved.rolloutPath === undefined) return undefined;
    codexThreads.set(threadId, resolved);
    return resolved;
  };
  const extract = (agent: UsageAgentSource): NormalizedUsage | undefined => {
    const harness = harnessOf(agent.provider);
    let key: string | undefined;
    let advanced: UsageCursor | undefined;
    if (harness === "pi") {
      const sessionPath = resolvePiSession(agent, paths);
      if (sessionPath !== undefined) {
        key = `pi:${sessionPath}`;
        advanced = extractPi(agent, sessionPath, cursors.get(key), metrics);
      }
    } else if (harness === "codex") {
      const threadId = asString(agent.persistence?.nativeHandle) ?? asString(agent.persistence?.sessionId) ?? asString(agent.runtimeInfo?.sessionId);
      if (threadId !== undefined) {
        key = `codex:${threadId}`;
        advanced = extractCodex(agent, threadId, rolloutOf, cursors.get(key), metrics);
      }
    } else if (harness === "opencode") {
      const sessionId = asString(agent.persistence?.nativeHandle) ?? asString(agent.persistence?.sessionId) ?? asString(agent.runtimeInfo?.sessionId);
      if (sessionId !== undefined) {
        key = `opencode:${sessionId}`;
        advanced = extractOpencode(agent, sessionId, join(paths.userHome, ".local", "share", "opencode", "opencode.db"), cursors.get(key), metrics);
      }
    } else if (harness === "antigravity") {
      const conversationId = antigravityConversationIdOf(agent);
      if (conversationId !== undefined) {
        key = `antigravity:${conversationId}`;
        advanced = extractAntigravity(agent, conversationId, paths.userHome, cursors.get(key), metrics);
      }
    } else if (harness === "claude") {
      const sessionId = asString(agent.persistence?.sessionId) ?? asString(agent.runtimeInfo?.sessionId);
      if (sessionId !== undefined) {
        key = `claude:${sessionId}`;
        advanced = extractClaude(agent, sessionId, paths.userHome, cursors.get(key), metrics);
      }
    } else if (harness === "copilot") {
      const sessionId = asString(agent.persistence?.nativeHandle) ?? asString(agent.persistence?.sessionId) ?? asString(agent.runtimeInfo?.sessionId);
      if (sessionId !== undefined) {
        key = `copilot:${sessionId}`;
        advanced = extractCopilot(agent, sessionId, paths.userHome, cursors.get(key), metrics);
      }
    }
    if (key !== undefined && advanced !== undefined) cursors.set(key, advanced);
    if (advanced !== undefined) return advanced.snapshot;
    return extractFromLastUsage(agent);
  };
  return { extract, metrics };
}

const sharedExtractors = new Map<string, UsageExtractor>();

/**
 * The process-wide extractor for one `(userHome, stateDir)` pair — the
 * sensor callers (the Lead 160k / Peer 200k context rotation) need the SAME cursor map
 * across sweeps or every read would pay the cold-start cost again.
 */
export function sharedUsageExtractor(paths?: UsagePaths): UsageExtractor {
  const key = `${paths?.userHome ?? homedir()}|${paths?.stateDir ?? ""}`;
  let shared = sharedExtractors.get(key);
  if (shared === undefined) {
    shared = createUsageExtractor(paths);
    sharedExtractors.set(key, shared);
  }
  return shared;
}

/**
 * The multi-provider context-window sensor (ADR 0043 §3): the agent's
 * normalized `latestContextWindowTokens`, or null when no store answered —
 * the value both the `160,000` Lead handoff and the `200,000` Peer handoff
 * fall back to whenever the daemon's volatile `lastUsage` is absent.
 */
export function readNativeContextWindowTokens(agent: UsageAgentSource, paths?: UsagePaths): number | null {
  const usage = sharedUsageExtractor(paths).extract(agent);
  const tokens = usage?.latestContextWindowTokens;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}
