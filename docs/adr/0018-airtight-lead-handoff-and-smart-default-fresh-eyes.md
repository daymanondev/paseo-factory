# ADR 0018 — Airtight `Lead handoff` (Attempt-1 Roster Resolution, Unified Single-Turn Kickoff, and Dual-Fuse `90s` Extraction Safeguard) & Smart-Default `Fresh-eyes review`

- **Status:** Accepted — 2026-10-21 (ratified by Andrew over `/grill-with-docs` and `/to-spec` for `v0.0.28`)
- **Grounded in:** Audit of `plugin/server/lead-mailbox.ts`, `plugin/server/surface-rpc.ts`, `plugin/server/core/factory.ts`, `plugin/bin/bridge.mjs` · `cuongntr/paseo-room` (`src/runtime-plugin/server/attention/succession.ts`)
- **Amends:** ADR 0009 §3, ADR 0010 §3, ADR 0013 §4–§5, and ADR 0016 §1–§2

## Context

In `paseo-factory` through `v0.0.27`, auditing the `Lead handoff` runtime state machine and the `Fresh-eyes review` contract flow for large multi-wave projects exposed four reliability and verification gaps:

1. **Attempt-1 Agents Missing from the `Machine-Verified Active Peer Roster`:**
   - During `Lead handoff`, `agentOfTask` resolved a `Task`'s bound working `Agent` only from post-claim `Ledger` events (`claim_reported`, `meter_written`, `repoke_dispatched`).
   - If a working `Agent` was actively coding its first `Attempt` inside its `Task worktree` and had not yet submitted its first `Claim` when `Lead` crossed `128,000` tokens, the roster handed to the successor `Lead` reported `agent (none bound)` — risking duplicate spawns on an already active `Task`.

2. **Triple-Prompt Initialization Storm on Successor `Lead` Creation:**
   - When `completeHandoff` spawned a successor `Lead` via `ensureLead`, `ensureSeat` passed a bootstrap prompt inside `agents.create`, then immediately called `agents.ref(id).send(renderSuccessorKickoff(...))`, and finally `drainLeadMailbox` prepended a third `Seat kickoff packet` (`buildSeatKickoffPacket`) on the first mailbox drain.

3. **Unbounded Wait on Outgoing `Lead` During `handing_over` Extraction:**
   - When `Lead` crossed `128,000` tokens, `beginHandoff` locked `rotationState = "handing_over"` and sent the extraction prompt (`lead-handoff.md`). If sending failed, or if the outgoing `Lead` hung or errored without completing the extraction turn, the `Lead mailbox` stayed locked in `handing_over` indefinitely with no timeout or fallback fuse.

4. **Opt-In-Only `Fresh-eyes review` Left `Lead` Auto-Acceptance Unchecked When Omitted:**
   - Under ADR 0010 §3, `Lead` can auto-accept green intermediate `Task`s provided there is no `Fresh-eyes review` `CONCERN`. However, `Fresh-eyes review` defaulted to off whenever `Lead` omitted `freshEyes` during `lead_set_contract` — allowing an `Agent` that gamed the `Gate` (e.g., hardcoding outputs or weakening assertions) to be auto-accepted by `Lead` without an independent review pass.

## Decision

1. **Three-Source Active Peer Roster Resolution During `Lead handoff`.**
   - When synthesizing the `Machine-Verified Active Peer Roster` during `Lead handoff`, resolve each unaccepted `Task`'s bound working `Agent` in priority order:
     1. **Live Daemon Worktree / Label Match:** Any live non-archived daemon agent whose `cwd` sits inside `<projectStateDir>/worktrees/<task>` or whose labels bind `{ project: slug, task }`.
     2. **`Correlation token` Registry Match:** The latest record in `<stateDir>/correlations.json` (`CorrelationRegistry`) with `role === "agent"`, `projectSlug === slug`, `task === task.task`, and a bound `agentId`.
     3. **`Ledger` Event Match:** The latest `claim_reported`, `meter_written`, or `repoke_dispatched` event in the `Task`'s current `Contract` epoch.

2. **Silent Seat Creation & Unified Single-Turn Successor Kickoff.**
   - `ensureSeat` creates `Supervisor` and `Lead` seats silently (`prompt` omitted from `agents.create` so seat creation never triggers a separate bootstrap turn).
   - On `Lead handoff`, `completeHandoff` spawns the successor `Lead` silently, resets `rotationState = "normal"`, and delivers a **single unified Turn-1 kickoff prompt** combining `buildSeatKickoffPacket`, the `Lead handoff` bundle (`Machine-Verified Active Peer Roster`, `Ledger State Digest`, and `lead-handoff.md`), and any queued `Lead mailbox` items in one turn.

3. **Dual-Fuse Handoff Extraction Safeguard (`90s` Timeout + Immediate Error Bypass).**
   - **Fuse 1 (Immediate Bypass):** In `beginHandoff`, if the outgoing `Lead` is absent or in `status === "error"`, or if `agents.ref(lead.id).send(...)` throws, `beginHandoff` immediately falls through to `completeHandoff` within the same lane turn.
   - **Fuse 2 (`90s` Extraction Timeout):** If `rotationState === "handing_over"` persists longer than `HANDOFF_EXTRACTION_TIMEOUT_MS = 90_000` (`90s`, checked both by an unref'd timer and on subsequent `pumpProjectLead` calls), the runtime automatically trips the fuse, retires the outgoing `Lead`, spawns the successor `Lead` with an explicit fallback note (`"(the outgoing Lead was interrupted during handoff extraction — rely on the Machine-Verified Active Peer Roster and Ledger State Digest above)"`), resets `rotationState = "normal"`, and drains all held mail without paging `Supervisor`.

4. **Smart-Default `Fresh-eyes review` on `Lead` Contracts.**
   - When `Lead` registers a `Contract` (`lead_set_contract` or Spool `contract` with `seat === "lead"`) and does not explicitly pass `freshEyes: false`, the plugin automatically sets `freshEyes: true` whenever the configured `freshEyes` lane is available and usable on the host (gracefully leaving `freshEyes` unset on minimal/test hosts where the lane CLI is absent, while explicit `freshEyes: true` continues to fail fast with `eye-unconfigured` when unconfigured).

## Consequences

- **Positive:** `Lead handoff` accurately tracks Attempt-1 working `Agent`s, initializes the successor `Lead` in a single clean turn, never deadlocks if the outgoing `Lead` hangs or errors during handoff extraction, and automatically runs `Fresh-eyes review` on `Lead`-authored Contracts whenever the review lane is available.
- **Negative:** None; minimal/test environments without the `freshEyes` CLI installed continue to pass contract creation seamlessly when `freshEyes` is not explicitly forced.
