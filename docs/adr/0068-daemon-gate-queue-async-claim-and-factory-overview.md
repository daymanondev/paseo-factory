# 0068 — Daemon Gate Queue, Async Claim & Wakeup Routing, Serial Verification Discipline, and Single-Tab Factory Overview

- **Date:** 2026-11-22
- **Status:** Accepted — ratified by the Owner over `/grill-with-docs` rounds 1–3; implementation spec tracked in `.scratch/gate-queue-and-factory-overview/spec.md` (not yet implemented).
- **Grounded in:** Live thermal/CPU forensic audit of `goal-partner` (`GP-P0`..`GP-P1g3` overnight run, `GP-R04` commit `405ebeb`, `GP-R23a` `test/release-env-resolution.test.ts` measuring `38.75s` wall / `170.3 CPU-s` across nested `7` Jest × `9` Metro workers) · cross-project `notebook.md` inspection (`goal-partner`, `pos-tax-android`, `print-connect`, `print-connect-ios`, `research-slp`) · `src/{constants,gate,factory,roles-contract}.ts` · `src/mcp/shared.ts` · `plugin/server/{spool,lead-mailbox,peer-in-flight}.ts` · `plugin/index.client.tsx` · `plugin/client/factory/entries.tsx` · `paseo-room` (`src/runtime-plugin/server/{gate,contracts/assignment}.ts`, `docs/design/runtime-coordination.md` §D6).
- **Amends:**
  - [ADR 0029](0029-serial-wave-decomposition-bounded-outcome-briefs-challenge-signals-and-checkpoint-anchored-worktrees.md) (removes the up-to-3 parallel writable Task exception in a single Project; enforces strictly one active writable `Peer` per Project).
  - [ADR 0056](0056-slim-factory-panel-slp-only-and-guided-onboarding.md) (re-introduces one single desktop global sidebar entry `Factory` opening a compact `Factory overview` screen for machine-wide `Gate queue` visibility and registered Project status, while keeping Kanban, Timeline, Ledger stream, and Seat graph retired).
  - [ADR 0058](0058-a-peer-task-closes-only-on-an-outcome-not-on-idle.md) (extends the no-nudge / quiet-point idle-Peer hold to `gate_queued` alongside `gate_started`, and defines direct Peer wakeup on async `RED` Attempts `1..2`).
  - [ADR 0063](0063-global-onboarding-screen-profile-selection-and-panel-badges.md) (consolidates the standalone `Onboard Project` sidebar footer item into a `+ Onboard Project` action inside the single `Factory overview` screen so the Paseo sidebar carries exactly one global Factory entry).

## Context

Overnight and daytime runs across multiple Projects exposed four compounding structural causes of machine overload (100% all-core saturation and sustained fan noise):

1. **Hardcoded `300s` Gate ceiling coupled to synchronous `agent_claim`:** `DEFAULT_GATE_TIMEOUT_MS = 5 * 60_000` (`src/constants.ts`, a `v0.0.2` placeholder) is not configurable on `lead_set_contract` (`src/mcp/shared.ts`) because `agent_claim` is a blocking MCP tool call bounded by `MCP_TOOL_TIMEOUT_MS = 600_000`. As real mobile/JVM/monorepo suites grew past `200s` under serial execution (`--runInBand`), Leads were forced to flip test runners to aggressive parallel workers (`--maxWorkers=50%`) solely to beat the `300s` kill clock.
2. **Nested parallelism & double verification:** Under `tdd` / falsification pressure, Peers embedded real multi-worker builds (e.g., 3 cold-cache `expo export --platform ios` invocations spawning 9 Metro workers + Hermes) directly inside parallel unit-test pools, while `roles-contract.ts` instructed Peers to run the full cumulative Gate right before `agent_claim` ran the exact same Gate a second time.
3. **Unserialized concurrency across Projects and Tasks:** `runGate` (`src/factory.ts`) has no machine-wide queue, and `LEAD_WAVE_LAWS` still allowed up to 3 parallel writable Tasks in one Project, allowing multiple heavy builds/tests to overlap on one host.
4. **No fast global visibility surface:** After ADR 0056 removed the global Factory screen and ADR 0063 added a separate `Onboard Project` footer item, the Owner had no 1-click view of machine-wide Gate activity or Project status without digging into plugin Settings.

By contrast, `paseo-room` (§D6) runs gates asynchronously with configurable `timeoutSeconds` (`1–3,600s`) and zero blocking RPC wait. The Owner's goal is not OS-level CPU throttling (`taskpolicy`), but **strict sequential execution — one heavy task at a time, just like a developer working normally on their machine — with 1-click global observability**.

## Decision

1. **Daemon-owned `Gate queue` (`concurrency = 1` default, FIFO, persisted):**
   - Introduce a machine-wide, single-writer **`Gate queue`** inside `plugin/server/` that serializes every shell-command `Gate` (both `agent_claim` and `lead_verify`) across all Projects with a configurable max concurrency defaulting to `1`.
   - Read-only **empty gates (`gate: ""`)** perform only a `<50ms` clean-`HEAD` check and bypass both `Gate queue` and `Pause`.
   - Persist queue state (`paused`, `running`, FIFO `queued` items) atomically to `<stateDir>/gate-queue.json` and record `gate_queued` in the owning Project's Ledger.
   - **Daemon restart recovery:** Any item recorded as `running` before a restart is marked `verdict: "red"` (`note: "daemon-restarted"`; old PIDs are never trusted or re-attached) and routed through normal RED wakeup; all `queued` items automatically resume in FIFO order on boot.
   - **Owner controls:** Support per-item **`Cancel`** (removing a `queued` entry or killing `-pgid` on a `running` entry and recording `verdict: "red"`, `note: "cancelled-by-owner"`) and machine-wide **`Pause / Resume queue`** (holding new dequeues while letting the Owner cancel or let the current active Gate finish).
   - **Lifecycle conflict rules:**
     - `lead_close_task`, `Project reset`, or `Project delete` removes any `queued` entry immediately (recording `superseded`/`cancelled` on task close) and kills `-pgid` immediately if `running`.
     - `lead_set_contract` (re-contract) or `lead_merge` on a Task with a `running` Gate is refused (`gate-in-flight`); re-contracting while `queued` dequeues and supersedes the queued Attempt cleanly.

2. **Asynchronous `Claim` (`agent_claim`), dequeue-anchored `timeoutSeconds`, and zero-token waiting:**
   - `agent_claim` validates clean tree, commit `sha`, and 6-Field Handoff synchronously (`<100ms`), records `gate_queued`, enqueues into `Gate queue`, and returns immediately (`{ ok: true, status: "queued", attempt, position, ahead }`).
   - **Waiting choreography (zero LLM polling):** `Peer` ends its turn immediately and sleeps live at 0 tokens (ADR 0058's idle-Peer hold, no-nudge guard, and Lead `quiet point` hold apply identically to `gate_queued` and `gate_started`). `Lead` remains asleep at 0 tokens while the Gate is `queued` or `running`.
   - **Post-verdict routing on `gate_finished`:**
     - **`GREEN`:** Daemon wakes `Lead` via `Lead mailbox` (carrying the 6-Field Handoff and verdict); `Peer` remains idle until `lead_merge` or `lead_repoke_agent`.
     - **`RED` on Attempt `1..2` (below `Attempt ceiling = 3`):** Daemon wakes the live `Peer` directly with the failure tail and `gate-*.log` path so `Peer` fixes and re-claims without burning `Lead` context or causing Lead/Peer races. If the `Peer` session is dead/archived (`Substrate death`) or delivery fails, daemon falls back to `Lead mailbox` (`RED + peer-unavailable`).
     - **`RED` on Attempt `3` (`attempt-ceiling`) or Owner `Cancel` (`cancelled-by-owner`):** Daemon wakes `Lead` via `Lead mailbox`.
   - **Configurable `timeoutSeconds`:** Expose `timeoutSeconds` (`60`–`3,600s`, default `900s`) on `lead_set_contract`. The timeout clock starts **only at `gate_started` (dequeue)**, never penalizing queue wait time.

3. **Strict serial execution & 2-tier verification discipline (`src/roles-contract.ts`):**
   - **One writable `Peer` per Project:** Tighten `Serial Wave` and `LEAD_WAVE_LAWS` to at most one active writable (`engineer`) `Peer` per Project at a time (removing the up-to-3 parallel writable Task exception; read-only dispositions remain unaffected).
   - **Eliminate double-gate:** Remove the instruction requiring Peers to run the full cumulative Gate before `agent_claim`. Peers iterate with fast slice checks and rely on `agent_claim` to execute the full Gate once.
   - **Serial test runners & no nested builds:** Instruct Leads and Peers to configure test runners sequentially by default (`--runInBand`, `--no-file-parallelism`, `--test-concurrency=1`, etc.), keep real build/bundle commands (`expo export`, `next build`, `gradlew`, `xcodebuild`) out of unit-test suites, and split verification into lightweight **Wave Gate**s (`lint + serial tests + typecheck`) vs. **Checkpoint/Build Gate**s (full app builds / E2E at milestone boundaries or build/native/DB waves).

4. **One single global sidebar entry (`Factory`) opening one compact `Factory overview` screen:**
   - Replace the standalone `Onboard Project` sidebar footer item (`ADR 0063`) with **one** desktop sidebar header item (`Factory` via `addSidebarHeaderItem`, displaying a compact badge when `Needs you` > 0 or a Gate is active/queued) opening **one** global screen (`Factory overview`, `paseo-factory-overview`), styled strictly with `plugin/client/kit/` primitives and `FACTORY_PALETTE`.
   - Keep **everything compact inside that single view (no extra sub-tabs)**:
     1. **`Gate queue` section (top):** active running Gate (Project · Task · elapsed time · `Cancel` · open log), FIFO queued list (`#2`, `#3`… · `Cancel`), and machine-wide `Pause / Resume queue` toggle.
     2. **`Projects` section (bottom):** compact list of registered Projects (seat/Peer `FACTORY_PALETTE` status pills, `Needs you` badge, latest Gate pill, 1-click jump to workspace) plus a **`+ Onboard Project`** header button opening the existing `OnboardingScreen` (Command Center `"Factory: Onboard Project"` remains available).
   - Also surface contextual Gate queue state (`Gate · running` / `Gate · queued #N`) on the Project panel `Team` tab, sidebar `WorkspaceRowBadge`, and CLI `factory status`. Kanban, Timeline, Ledger stream, and Seat graph remain retired.

## Considered Options

- **OS-level CPU clamping (`taskpolicy -c background` on Apple Silicon E-cores):** Rejected as the primary solution by the Owner — the real issue is overlapping parallel tasks and nested workers forced by a `300s` timeout, not normal single-task CPU usage.
- **Placing `Gate queue` inside plugin `Settings`:** Rejected — opening plugin Settings takes too many clicks for quick daily monitoring; a 1-click sidebar header entry matches the Owner's workflow.
- **Keeping two global sidebar items (`Factory` + `Onboard Project`) or splitting `Gate queue` and `Projects` into two tabs:** Rejected by the Owner — consolidated into one single sidebar entry and one compact single-view screen.
- **Waking `Lead` on every intermediate `RED` Attempt (`1..2`):** Rejected — wastes `Lead` context on routine lint/typecheck fixes and risks Lead/Peer race conditions; direct `Peer` wakeup with `Lead mailbox` fallback on dead/archived Peers is cleaner and token-lean.

## Consequences

- Heavy test/build workloads serialize cleanly (`1` Gate at a time across the machine, `1` writable Peer per Project, `1` Gate run per Attempt instead of `2`), eliminating nested-parallelism thermal spikes without restricting normal single-task speed.
- Long sequential builds/tests (`5–15+ min`) run comfortably under configurable `timeoutSeconds` (`60–3,600s`) without hitting MCP tool timeouts or forcing `--maxWorkers=50%`.
- `Peer` and `Lead` wait at zero LLM tokens during queued/running Gates, and queued work survives daemon restarts.
- `CONTEXT.md` is updated alongside this ADR to define `Gate queue` and `Factory overview`, tighten `Serial Wave`, and reflect asynchronous `Claim` semantics.
