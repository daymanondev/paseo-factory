# ADR 0013 — Compaction-proof SLP role retention (`APPEND_SYSTEM.md`), single-writer `Lead mailbox` (`mailbox.jsonl`), automatic `128k` `Lead handoff`, and daemon RPC single-flight caching

- **Status:** Accepted — 2026-10-19 (ratified by Andrew over a four-round `/grill-with-docs`; words "chốt nhưng đừng implement luôn ở session này, session này context đã quá lớn, to spec đã")
- **Grounded in:** `research/slp-activation-and-context-retention.md` · `research/runtime-coordination-seat-context.md` · `research/piggery-deep-dive.md` · `cuongntr/paseo-room` (`src/runtime-plugin/server/{notices,spool}.ts`, `src/runtime-plugin/server/attention/{succession,succession-store}.ts`, `src/agents/resources.ts`) · `sting9k/seatworks` (`plugin/server/runtime/{outbox,patrol}.ts`) · `sting8k/piggery` (`internal/core/mail.go`) · `@earendil-works/pi-coding-agent@1.3.0` (`core/{resource-loader,agent-session}.js`, `core/compaction/compaction.js`) · `@getpaseo/server@0.1.54` (`providers/pi/agent.js`, `providers/claude/agent.js`, `providers/codex/agent.js`)
- **Amends:** ADR 0010 §1–§2 (equips each project's `Supervisor` and `Lead` with compaction-proof role `APPEND_SYSTEM.md`, CLI `factory lead dispatch` auto-ensure/wake, `Lead mailbox`, and automatic `128,000` token `Lead handoff`) · ADR 0011 §2–§4 (writes role-specific `<stateDir>/pi-agent/<role>/APPEND_SYSTEM.md` for `supervisor`, `lead`, and `agent`, and symlinks `~/.pi/agent/{prompts,skills}` into `supervisor` so the `Owner` retains 100% of slash commands on `Supervisor`)

## Context

Four concrete production and architectural gaps surfaced when running `paseo-factory` alongside `factory-burn-lab` and `factory-connector` on Paseo Desktop:

1. **Daemon RPC & WebSocket storm across the three-plugin family:**
   - Every UI poll (`3.5s`–`5s` across screens/panels) triggered uncaught WebSocket opens (`listDaemonPlugins`, `discoverDaemonFreeModels` firing `agent.session_open.request`) and CLI child processes (`tailscale status --json`, `git status`), while `factory-burn-lab`'s `resolvePaseoHome()` defaulted to `~/.paseo-factory` instead of `~/.paseo` when `PASEO_HOME` was unset in the plugin host. Under sustained polling, the Paseo daemon saturated and stopped responding to normal chat commands.
2. **Owner slash-command stripping on `Supervisor` & context-compaction amnesia on `Supervisor` / `Lead`:**
   - ADR 0011 stripped `~/.pi/agent/prompts` and `~/.pi/agent/skills` from `<stateDir>/pi-agent/supervisor`, depriving the `Owner` of personal slash commands when chatting with `Supervisor`.
   - Relying on a one-off chat slash command (`/factory`) or `config.systemPrompt` alone fails after long sessions: in `@earendil-works/pi-coding-agent`, a slash command is just a user message in the conversation history that gets summarized away on `/compact` (`agent-session.js:1265-1340`), whereas `<PI_CODING_AGENT_DIR>/APPEND_SYSTEM.md` is loaded by `DefaultResourceLoader.discoverAppendSystemPromptFile()` (`resource-loader.js:950-959`) into `_baseSystemPrompt` on **every** turn, across **every** `/compact`, and across **every** `agent.session_open` resume.
3. **Friction in activating the SLP loop (`Owner -> Supervisor -> Lead -> Agent`):**
   - On `Seats & Models`, the `Start / Open Supervisor` header button was hidden inside `{view.supervisor && (...)}`, making it invisible on a brand-new `Project` where `view.supervisor === null`.
   - Furthermore, dispatching from `Supervisor` to `Lead` required the `Owner` or `Supervisor` to know raw Paseo `agentId`s rather than calling a deterministic `factory lead dispatch` command that auto-spawns `Lead` if absent.
4. **`Lead` context window saturation & the failure modes of mutable JSON mail queues:**
   - Unlike short-lived working `Agent`s (1 task attempt in an isolated `Task worktree`), `Lead` is a standing session that decomposes tasks, sets `Contract`s, runs `Driver` waves, and inspects `Report`s. Over a multi-wave roadmap, `Lead`'s context window fills up.
   - Mid-turn interruption breaks in-flight `Lead` orchestration, and naive rotation forgets which `Agent`s (`Peer`s) are actively bound to which `Task`s and `Task worktree`s.
   - Auditing `seatworks` (`outbox.ts:43-131`, `patrol.ts:43-50`), `piggery` (`internal/core/mail.go`), and `paseo-room` (`spool.ts`, `notices.ts`) proved that a single mutable JSON file (`outbox.json` / `lead-mailbox.json`) suffers from Read-Modify-Write clobbering across concurrent callers, premature deletion on `send()` before the `Lead` turn completes, and loss of audit history.

## Decision

1. **Daemon RPC single-flight + TTL caching across `paseo-factory`, `factory-burn-lab`, and `factory-connector`.**
   - `paseo-factory`'s `listDaemonPlugins(home)` caches results in-memory for `15s` with single-flight deduplication and invalidates immediately on `installDaemonPlugin` / `manageDaemonPlugin`.
   - `factory-burn-lab` fixes `resolvePaseoHome()` to default to `~/.paseo` when `PASEO_HOME` is unset, stops calling `discoverDaemonFreeModels()` on every `burnlab.status` poll (caching for `5 min` or explicit `burnlab.pool.refresh`), and replaces `agent.session_open.request` in `discoverDaemonFreeModels` with the zero-side-effect `provider.models.list.request` RPC.
   - `factory-connector` caches `collectSnapshot()` for `5s` with single-flight deduplication and increases client poll cadence from `3.5s` to `10s`.

2. **Compaction-proof role `APPEND_SYSTEM.md` + 100% `Owner` slash-command parity on `Supervisor`.**
   - `provisionPiAgentHome(stateDir, role)` writes a managed, role-specific `<stateDir>/pi-agent/<role>/APPEND_SYSTEM.md` for `supervisor`, `lead`, and `agent` containing each seat's immutable SLP role contract (`ROLE_PROMPTS[role]`) and exact `factory` CLI paths (leaving `headless` without `APPEND_SYSTEM.md`). Because Pi's `DefaultResourceLoader` reloads `<PI_CODING_AGENT_DIR>/APPEND_SYSTEM.md` into `_baseSystemPrompt` on every turn and rebuilds it on every compaction and session resume, `Supervisor` and `Lead` never forget their SLP duties regardless of conversation length.
   - For `role === "supervisor"` only, `provisionPiAgentHome` symlinks `~/.pi/agent/prompts` → `<stateDir>/pi-agent/supervisor/prompts` and `~/.pi/agent/skills` → `<stateDir>/pi-agent/supervisor/skills` alongside `~/.agents/skills`, preserving 100% of the `Owner`'s slash commands and skills on `Supervisor` while keeping `lead`, `agent`, and `headless` strictly isolated.

3. **Zero-friction SLP activation (`Start / Open Supervisor` UI + `/factory` skill + `factory lead dispatch`).**
   - The `Factory surface` (`Seats & Models` header) always renders `Start / Open Supervisor` (and `Start / Open Lead`) even when `view.supervisor === null` / `view.lead === null`.
   - A global `/factory` skill (`~/.agents/skills/factory/SKILL.md`) allows the `Owner` to type `/factory <directive>` in any normal Paseo chat session to bootstrap or dispatch directly into the `Project`'s SLP loop.
   - `factory lead dispatch --project <slug> --message "<directive>"` submits a `lead_dispatch` intent through the file spool (`<stateDir>/spool/requests/<id>.json`). The single-writer plugin automatically ensures the `Project`'s `Lead` seat exists (`ensureProjectSeat("lead")`) and enqueues the directive in the `Lead mailbox`.

4. **Single-writer `Lead mailbox` (`<projectStateDir>/mailbox.jsonl`) with 3-state turn-end acknowledgment.**
   - In accordance with ADR 0004 (*"Single-writer plugin; CLI submits via file spool"*), `paseo-factory` never uses a mutable JSON array (`outbox.json` / `lead-mailbox.json`) or native SQLite for `Lead` mail.
   - External callers (`factory lead dispatch`) submit atomic one-file-per-request intents in `<stateDir>/spool/requests/<id>.json` (`writeFileSync(tmp)` + `renameSync`). Internal callers (UI quick dispatch, `Verdict` completion, `Needs-human` transitions) invoke the plugin's in-process `enqueueLeadMail()` serialized on a per-Project async lane (`projectLane(slug)`).
   - The plugin is the sole writer of `<projectStateDir>/mailbox.jsonl` via `fs.appendFileSync`, recording four immutable event types:
     - `mail_queued`: `{ seq, ts, mailId, from: "supervisor" | "owner" | "peer" | "system", kind: "directive" | "verdict" | "needs_human", task?: string, text: string }`
     - `mail_delivered`: `{ seq, ts, deliveryId, mailIds: string[], toAgentId: string }`
     - `mail_acked`: `{ seq, ts, deliveryId, mailIds: string[], byAgentId: string }` — appended **only** when the `Lead` turn that received `deliveryId` finishes normally (`agent.turn_ended` with `outcome === "completed"`).
     - `mail_requeued`: `{ seq, ts, deliveryId, mailIds: string[], reason: string }` — appended if the `Lead` turn ends with `outcome !== "completed"` (`failed` / `cancelled`) or on plugin startup recovery when a `mail_delivered` batch has no matching `mail_acked`.

5. **Automatic `Lead handoff` at the fixed `128,000` token mark (`128k`) with `Active Peer Roster` continuity.**
   - **Deterministic Context Sensor (0 LLM tokens, no 4th agent role):** On every `agent.turn_ended` (and status poll) for a `Project`'s `Lead`, the plugin reads `contextWindowUsedTokens` from Paseo's live `agent.lastUsage` (falling back across daemon restarts to the last assistant message's `usage.totalTokens || input + output + cacheRead + cacheWrite` in the Pi session `.jsonl` at `persistence.nativeHandle`).
   - **Deferred `rotation_pending` (never mid-turn interrupt):** The threshold is fixed at **`LEAD_ROTATE_TOKENS = 128_000` (`128k`)**. If `Lead` crosses `128,000` tokens while actively working, the plugin marks `rotationState = "rotation_pending"` and never interrupts the active turn.
   - **Turn-boundary lock (`handing_over`) & Handoff Extraction:** When `Lead`'s active turn ends (`agent.turn_ended`) and `usedTokens >= 128_000` (or `rotationState === "rotation_pending"`):
     1. First, if the completed turn carried an active `deliveryId`, the plugin appends `mail_acked` to `mailbox.jsonl`.
     2. Before draining any new `mail_queued` items, the plugin locks the `Lead mailbox` (`rotationState = "handing_over"`) so any new messages arriving from `Supervisor` or `Agent`s (`Peer`s) during handoff are appended as `mail_queued` and held safely in `mailbox.jsonl`.
     3. The plugin steers a single bounded Handoff Extraction turn to the outgoing `Lead` instructing it to write `<projectStateDir>/lead-handoff.md` (`<= 16 KB`: Goal & Remaining Roadmap, Uncontracted Next Tasks, Key Technical Findings, Open Questions, Read-First Files) and start no new tasks.
   - **Two-Layer Context Reload + `Active Peer Roster` + Mailbox Drain:** When the outgoing `Lead`'s handoff turn ends:
     1. The plugin synthesizes the deterministic **Machine-Verified Active Peer Roster** from live daemon state + `ledger.jsonl`, mapping every `Task` in the `Project` to its live working `Agent` (`agentId`, live `status`, `Task worktree` path `<projectStateDir>/worktrees/<task>`, branch `factory/<task>`, latest `Attempt`, `Verdict`, and `Report` path) alongside the **Ledger State Digest**.
     2. The plugin archives the outgoing `Lead` and spawns a fresh successor `Lead` (`0%` context) injected with:
        - Compaction-proof `<stateDir>/pi-agent/lead/APPEND_SYSTEM.md`
        - Kickoff prompt containing the **Machine-Verified Active Peer Roster**, **Ledger State Digest**, and `<projectStateDir>/lead-handoff.md`.
     3. The plugin sets `rotationState = "normal"` and immediately drains all held `mail_queued` items from `mailbox.jsonl` into the successor `Lead`.

## Consequences

- `CONTEXT.md` updates **Supervisor**, **Lead**, and **Pi harness home**, and adds **Lead mailbox** and **Lead handoff**.
- `paseo-factory` gains `<projectStateDir>/mailbox.jsonl`, `factory lead dispatch`, automatic `128k` `Lead handoff` with `Active Peer Roster` preservation, compaction-proof `<stateDir>/pi-agent/<role>/APPEND_SYSTEM.md`, `Supervisor` slash-command symlinks, and always-visible `Start / Open Supervisor` UI controls.
- `factory-burn-lab` and `factory-connector` eliminate daemon RPC/WS polling storms.
