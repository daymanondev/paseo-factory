# 0043 — Plugin-Owned Multi-Provider Token Metering, `O(1)` Incremental Native Session Extraction, and Two-Tier Project Usage Rollup

- **Date:** 2026-11-03
- **Status:** Accepted — Owner confirmed Q1–Q8 across a two-round `/grill-with-docs` session ("toàn bộ theo bạn khuyến nghị").
- **Grounded in:** [`research/token-usage-tracking-across-providers-analysis.md`](../../research/token-usage-tracking-across-providers-analysis.md) · `@getpaseo/server@0.14.0` (`agent-manager.js`, `agent-storage.js`, `agent-projections.js`, `providers/{pi,codex,opencode,claude,copilot}`, `builtin-plugins/antigravity-provider`).
- **Amends:** [ADR 0004](0004-single-writer-plugin-cli-submits.md) (graduates `Meter` from a Driver-only CLI submission reading volatile `lastUsage` to a plugin-owned multi-provider recorder across both terminal `meter_written` lines and per-Project `<projectStateDir>/usage.json`) · [ADR 0013](0013-slp-retention-lead-mailbox-and-handoff.md) & [ADR 0035](0035-peer-handoff-rolling-wave-decomposition-and-modular-test-isolation.md) (extends the `128k` `Lead handoff` and `160k` `Peer handoff` context-window fallback from Pi-only `.jsonl` parsing to all 6 provider harnesses).

## Context

An empirical audit of live `paseo-factory` runs (`goal-partner-f17f4d`, 38 active LLM sessions, 1,936 turns, `166.62M` gross tokens) revealed five architectural gaps that caused `ledger.jsonl` to record `0` `meter_written` events while leaving standing seats (`Supervisor`, `Lead`) and rotated sessions completely unmetered:

1. **Dead `driver.mjs` Metering Path on Paseo Desktop:** `submitMeter()` existed only inside `plugin/bin/driver.mjs`. Because Paseo Desktop listens over WebSocket (`127.0.0.1:6767`) and never creates `endpoint.sock`, `lead_spawn_agent` in `plugin/bin/bridge.mjs` always routed through the direct Spool `createTaskPeer` path in `plugin/server/spool.ts`, bypassing `driver.mjs` and `submitMeter()`.
2. **Volatile, Single-Turn `agent.lastUsage` in Paseo Daemon:** Paseo Server strips `lastUsage` when persisting `~/.paseo/agents/<cwd>/<agentId>.json` (`0/188` stored agent files contain `lastUsage`). Furthermore, Paseo's live adapters for `codex` (`tokenUsage.last` instead of `tokenUsage.total`), `antigravity` (`turn.usage` reset each turn), and `pi` overwrite `lastUsage` with single-turn token counts rather than session-cumulative totals.
3. **Unmetered Standing Seats (`Supervisor`, `Lead`) & Rotated Sessions:** `meter_written` required a `task: string`, omitting `Supervisor` (`antigravity/gemini-4-argon-high`) and `Lead` (`codex/gpt-6.1-sol`), which together consumed `27.48M` tokens (`~16.5%` of total project tokens) across 14 rotated sessions in `goal-partner-f17f4d`.
4. **Pi-Only Context Fallback (`readLeadContextTokens`):** When `lastUsage.contextWindowUsedTokens` was absent (e.g. after daemon restart or on `antigravity`), `readLeadContextTokens` attempted `readFileSync(persistence.nativeHandle)` as a Pi `.jsonl` file, failing on `codex`, `opencode`, `antigravity`, `claude`, and `copilot`.
5. **Ledger Bloat & Re-Parse Overhead Risks:** In `src/ledger.ts`, every `ledger.append()` clones `#events`, runs `O(N)` `remapLedgerReferences`, and executes a synchronous `fsyncSync(fd)`. Writing turn-by-turn token events (`1,936` turns/project) into the shared `ledger.jsonl` would bloat the ledger 7–10x, flood the 100-line `Timeline` UI stream (`LEDGER_STREAM_CAP = 100`), and stall the main thread. Likewise, re-reading multi-megabyte native session files (`~65 MB` of Pi `.jsonl` in `goal-partner-f17f4d`) on every 5-second sweep or `factory.view` RPC would saturate CPU and disk I/O.

## Decision

### 1. Two-Tier Persistence: Terminal `meter_written` in `ledger.jsonl` + Per-Project `<projectStateDir>/usage.json` (Q1, Q5)

- **Tier 1 — `ledger.jsonl` (`meter_written` at Task Attempt / Peer Terminal Boundaries Only):**
  - The plugin server (`plugin/server/spool.ts`) automatically appends **at most one `meter_written` line per Task Attempt / Peer terminal boundary** (`gate_finished` verdict or terminal Peer retirement), keeping `ledger.jsonl` compact (~20–30 lines/project), preserving the `LEDGER_STREAM_CAP = 100` `Timeline` signal-to-noise ratio, and maintaining 100% compatibility with `Report` generation and `LedgerAdmission`.
- **Tier 2 — `<stateDir>/projects/<project-slug>/usage.json` (Isolated Per-Project, `agentId`-Keyed Rollup):**
  - Each Project owns an isolated `<projectStateDir>/usage.json` containing an idempotent map `sessions: Record<agentId, SessionUsageRecord>` across **all** Project seats (`supervisor`, `lead`, `agent` / `Scrum role`, plus headless `watch` / `retro` runs).
  - Updating a session overwrites its `agentId` entry in-place rather than appending log lines, bounding a 40-session project to `< 10 KB` on disk with zero duplicate garbage.
  - Every `SessionUsageRecord` retains `agentId`, `seat`, `scrumRole`, `task`, `attempt`, `provider`, `harness`, `model`, `turns`, normalized token buckets, `totalCostUsd`, `startedAt`, `updatedAt`, and `nativeSessionRef` (the exact `.jsonl` path or SQLite `sessionId`/`conversationId`), preserving 100% turn-level traceability into the provider's native store without polluting `ledger.jsonl`.

### 2. Stat-Gated `O(1)` Incremental & Tail Native Session Extractor (Q2)

- Introduce a unified `UsageExtractor` (`src/usage-extractor.ts`) backed by an in-memory cursor cache `Map<sessionKey, UsageCursor>`:
  - **Stat Gate (`0 byte` I/O when unchanged):** Checks `(mtimeMs, size)` of the underlying session file first; if unchanged since the cached cursor, returns the cached snapshot in `0ms`.
  - **Provider-Specific `O(delta)` Readers:**
    1. **`pi` (`persistence.nativeHandle` `.jsonl`):** Seeks to `cursor.byteOffset`, reads only newly appended bytes (`readSync`), sums `type === "message" && role === "assistant"` usage deltas into the running accumulator, and records the latest turn's total context window tokens (`input + cacheRead + cacheWrite + output`).
    2. **`codex` (`~/.codex/state_5.sqlite` `threads.rollout_path` → `rollout-*.jsonl`):** Reads the last `64 KB` tail of `rollout-*.jsonl` to extract `turn_context.payload.model` and the latest `event_msg` (`payload.type === "token_count"`), taking `payload.info.total_token_usage` for cumulative session usage and `payload.info.last_token_usage` for current context window occupancy.
    3. **`opencode` (`~/.local/share/opencode/opencode.db`):** Queries the pre-aggregated primary-key row in `session_v2` (`WHERE id = ?`) for cumulative tokens/cost/model (`< 0.2ms`).
    4. **`antigravity` (`~/.gemini/antigravity-cli/conversations/<conversationId>.db`):** Queries `SELECT idx, metadata FROM steps WHERE step_type = 15 AND idx > ?` (`cursor.lastStepIdx`), decoding Protobuf field 9 (`tag 0x4A`: field 1 `model`, field 2 `input_tokens`, field 3 `output_tokens`, field 5 `cache_read_tokens`, field 9 `thinking_tokens`, field 10 `response_tokens`) only for newly added planner steps.
    5. **`claude` (`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`):** Seeks to `cursor.byteOffset` and accumulates `type === "assistant"` `message.usage` deltas.
    6. **`copilot` (`~/.copilot/session-state/<sessionId>/events.jsonl`):** Seeks to `cursor.byteOffset` and accumulates `type === "session.usage_record"` `data.usage` deltas (or reads `session.shutdown` `accountingSnapshot`).
- **Unified Context-Window Fallback (`128k` Lead / `160k` Peer):** Both `Lead handoff` (`128,000` tokens) and `Peer handoff` (`160,000` tokens) use `UsageExtractor`'s `latestContextWindowTokens` whenever Paseo's `lastUsage.contextWindowUsedTokens` is absent or stale.

### 3. Event-Driven Cadence, Pure-RAM `factory.view`, and One-Time Lazy Backfill (Q3)

- **Zero Provider Disk I/O inside `factory.view`:** `buildFactoryViewSnapshot` / `foldView` never reads provider `.jsonl` or `.db` files; it reads only the in-memory / `<projectStateDir>/usage.json` rollup and `ledger.jsonl`.
- **Event-Driven Extraction:**
  - On `agent.turn_ended`: updates the in-memory cursor for the ending seat (`Supervisor`, `Lead`, `Peer`) and schedules a debounced (`2–3s`) atomic write to `<projectStateDir>/usage.json`.
  - On terminal seat/task transitions (`gate_finished`, `Lead handoff`, `Peer handoff`, `retirePriorTaskPeers`, `leadRotate`, `supervisorRevoke`, `attempt_accepted`): flushes the final session snapshot immediately and writes the Task's `meter_written` event when applicable.
  - On headless CLI passes (`watch`, `retro` in `src/lanes.ts`): captures structured JSON usage output when available and records it into `<projectStateDir>/usage.json`.
- **One-Time Lazy Backfill:** When opening or inspecting a registered Project whose `<projectStateDir>/usage.json` does not yet exist, the plugin scans `~/.paseo/agents/<sanitized-cwd>/*.json` once, extracts historical usage for all sessions matching `labels.project === slug` (or bound tasks of that Project), and writes `<projectStateDir>/usage.json`.

### 4. Disjoint Additive Token Normalization Across Providers (Q4, Q6)

- Because `codex` reports `cached_input_tokens` as a subset of `input_tokens` whereas `pi`, `claude`, `opencode`, `antigravity`, and `copilot` report uncached `input` separately from `cacheRead`, all records in `usage.json` and `meter_written` normalize into four disjoint additive buckets:
  - `inputUncachedTokens`: uncached prompt/input tokens (`codex`: `max(0, input_tokens - cached_input_tokens)`; others: raw `input`).
  - `cacheReadTokens`: cached input tokens read from prompt cache.
  - `cacheWriteTokens`: input tokens written to cache (`0` when the provider does not separate cache writes).
  - `outputTokens`: total output tokens generated (including reasoning/thinking tokens).
  - `reasoningTokens`: subset of `outputTokens` spent on internal reasoning/thinking.
  - `totalTokens = inputUncachedTokens + cacheReadTokens + cacheWriteTokens + outputTokens`.

### 5. Surface UI, CLI `factory status`, and Lifecycle Cleanup on Reset / Delete (Q7, Q8)

- **Factory Surface (`plugin/client/`) & View Fold (`plugin/shared/view.ts`, `plugin/server/view.ts`):**
  - Expose `projectUsage: ProjectUsageView | null` on `FactoryView` with project totals, cache-hit ratio, breakdown by `(provider, model, seat)` (`Supervisor`, `Lead`, `Peer` / `Scrum role`, `Watch/Retro`), and per-Task aggregated token usage across all Attempts and handoffs.
  - Render the **Project Token Usage** breakdown card on `Seats & Models` and display per-Task token badges/details on `Tasks` cards and detail modals.
- **CLI (`factory status`):** Render the Project Token Usage table by `Seat` and `Provider / Model`.
- **`Project reset` & `Project delete`:**
  - `Project delete` removes `<projectStateDir>/usage.json` with `<stateDir>/projects/<project-slug>/`.
  - `Project reset` without `--keep-seats` removes `<projectStateDir>/usage.json`; with `--keep-seats`, it prunes all task/peer and retired-seat entries from `usage.json`, retaining only the surviving active `Supervisor` and `Lead` sessions.

## Consequences

- `CONTEXT.md` updates **Meter**, **Lead handoff**, **Peer handoff**, **Project reset**, and **Project delete**.
- Every Project — including already-executed Projects like `goal-partner-f17f4d` via one-time lazy backfill — gains an exact, zero-bloat breakdown of token consumption by `(provider, model, seat, task)` with `< 0.2ms` per-turn incremental extraction overhead.
