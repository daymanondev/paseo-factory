# 0048 — In-Flight Wave Hardening, Recurrence Guard, and Per-Project Lead Notebook (`<projectStateDir>/notebook.md`)

- **Date:** 2026-11-05
- **Status:** Accepted — Owner confirmed Q1–Q7 in `/grill-with-docs` ("toàn bộ theo khuyến nghị của bạn, nhưng không implement luôn trong session này nha").
- **Amends:** [ADR 0009](0009-paseo-ui-surface-and-lane-config.md) & [ADR 0045](0045-per-project-ledger-isolation-compact-migration-and-scoped-retro.md) (keeps `factory retro` as a secondary on-demand historical audit instrument while moving primary workflow self-correction to in-flight `Wave Hardening` at `Stable Checkpoint` boundaries) · [ADR 0016](0016-role-scoped-mcp-bridge-kickoff-packet-and-execution-fence.md) (injects `<projectStateDir>/notebook.md` into `Lead` and `Supervisor` kickoff packets and permits `Lead`/`Supervisor` writes to `<projectStateDir>/notebook.md` without exposing it to `Peer`) · [ADR 0029](0029-delegation-boundary-rolling-waves-and-challenge-reconciliation.md) & [ADR 0044](0044-vertical-wave-slicing-contract-bounded-review-reply-first-handoff-heredoc-choke-and-worktree-process-reaping.md) (adds `Wave Hardening` and `Recurrence Guard` at each `Stable Checkpoint` to `LEAD_WAVE_LAWS`).

## Context

In human engineering teams, recurring workflow friction (flaky test invocations, missing `.env.test` worktree copies, unmounted routes passing unit tests, or ambiguous repository conventions) is deferred to a **backlog** or a periodic **sprint retrospective** because humans suffer high context-switching costs mid-sprint and retain biological memory across tasks to work around known potholes in the meantime.

In `paseo-factory`, AI coding agents have the exact opposite operating profile:
1. **Zero biological memory across waves:** Every spawned `Peer` (`Agent`) starts cold inside a fresh `Task worktree` (`<projectStateDir>/worktrees/<task>`). If a workflow pothole discovered in `T-01` and repeated in `T-02` is deferred to a backlog or waits for a manual `Run Retro` button click (`src/retro.ts`), `100%` of downstream `Peer`s (`T-03`, `T-04`, `T-05`...) fall into the exact same pothole and burn Attempt 1 tokens repeating the failure.
2. **Zero context-switching cost for `Lead` at `Stable Checkpoint` boundaries:** When `Lead` lands a wave at a `Stable Checkpoint` (`lead_merge` / `factory accept --by lead`) before contracting the next wave, tightening the next wave's `Gate` command, updating `.worktreeinclude`, or recording a verified run recipe in `Lead`'s project notebook takes seconds and never interrupts an active `Peer`.
3. **Why the existing batch `Retro` (`src/retro.ts`) goes unused and risks rule bloat:**
   - `src/retro.ts` runs only when manually invoked by the Owner, prompts a tool-less model with `"no count cap"`, and emits raw `seq`-indexed proposals without distinguishing one-off accidents from true recurring mechanisms or separating `Lead` orchestration knowledge from `Peer` `AGENTS.md` context.
   - Primary-source analysis of `paseo-room` (`WORKSPACE_PROTOCOL.md` vs `AGENTS.md`), `seatworks` (`retrospective/SKILL.md` & `notebook.md`), Matt Pocock's `retro` skill (*Context Pressure* & *No-op pruning*), and Poteto's `pstack` (`/correct`, `/encode-lessons-in-structure`, `/create-verification-skill`) establishes four principles for agentic self-improvement:
     1. **Recurrence Guard (`observed → recurred → hardened → verified`):** Never add project rules from a single surprise. Only when a costly failure mechanism (RED `Gate`, `re-contract`, or `Choke` denial) recurs a second time (`recurred`) does it trigger structural hardening.
     2. **3-Tier Hardening Hierarchy (`/correct` & `encode-lessons-in-structure`):** Fix recurring failures at the highest mechanical level first: (Tier 1) mechanical `Gate` check, script, type/linter rule, or `.worktreeinclude` entry; (Tier 2) a concise 1-line navigation pointer in `AGENTS.md`; (Tier 3) **Rule Deprecation** — if a prose rule already exists in `AGENTS.md` and a `Peer` still violates it, the prose rule is a confirmed `no-op` that must be replaced by a mechanical `Gate` check and deleted from `AGENTS.md`.
     3. **Audience Separation (`Lead` Notebook vs `Peer` `AGENTS.md`):** `Peer` has the highest context pressure (exploration, coding, debugging), so `<project-root>/AGENTS.md` must remain minimal (navigation pointers and essential commands). `Lead`-specific orchestration knowledge (the project's canonical **Verification & Run Recipe**, `Gate` templates, and the `Recurrence Guard` table) belongs in `<projectStateDir>/notebook.md` outside the Git repository, invisible to `Peer` and automatically carried across `128k` `Lead handoff` rotations.
     4. **Two-Speed Execution (Unblocked In-Flight Hardening vs End-of-Directive Owner Ratification):** Technical orchestration fixes within `Lead`'s authority (updating `Gate` commands, `.worktreeinclude`, or `<projectStateDir>/notebook.md`) take effect **immediately before the next wave spawns** with zero human blocking. Proposed edits to tracked repository memory (`AGENTS.md`, `CONTEXT.md`, `docs/adr/`) are temporarily quoted into downstream `Contract`s for immediate protection and presented to the Owner at the end of the directive in a scannable **4-Line Ratification Format**.

## Decision

### 1. In-Flight `Wave Hardening` and `Recurrence Guard` (Replaces Backlog / Deferred Retro)

1. **No Backlog Deferral for Agentic Friction:**
   - Costly workflow failures (a RED `Gate` attempt, a `Lead` diff-review rejection requiring `re-contract`, or a repeated `permit_denied` / `git_blocked` choke) are never parked in a passive backlog.
2. **The `Recurrence Guard` State Machine (`observed → recurred → hardened → verified`):**
   - **1st Occurrence (`observed`):** When a costly failure mechanism occurs once (e.g., in `T-01`), `Lead` fixes the immediate task and logs 1 row in `<projectStateDir>/notebook.md` with status `observed` and its causal mechanism (`Cause → Effect`) plus evidence (`Task` + `seq`). No repo-wide rule is added for a one-off event.
   - **2nd Occurrence (`recurred` → `hardened`):** When the same causal mechanism occurs a second time across attempts or waves (e.g., in `T-02`), `Recurrence Guard` triggers **In-Flight `Wave Hardening`** at the `Stable Checkpoint` boundary before the next wave (`T-03`) is contracted, applying **at most one highest-leverage hardening change** per checkpoint.
   - **Subsequent Waves (`verified`):** Once the hardening holds across subsequent waves without recurrence, the row is marked `verified` (and folded or pruned when `<projectStateDir>/notebook.md` approaches its `80`-line ceiling).

### 2. Three-Tier Hardening Hierarchy & Two-Speed Authority

When `Recurrence Guard` triggers at a `Stable Checkpoint`, `Lead` applies the fix according to a strict 3-tier hierarchy and 2-speed authority boundary:

1. **Tier 1 — Mechanical Structure (`Gate` / `.worktreeinclude` / Script Check — Preferred):**
   - Encode the lesson in structure so bad state fails mechanically: tighten the `Gate` command template, add missing runtime/test env files to `.worktreeinclude`, or include a fast check script in the next wave's `Contract`.
   - **Authority (Immediate In-Flight):** Because `Contract.gate`, `.worktreeinclude`, and `<projectStateDir>/notebook.md` sit within `Lead`'s technical orchestration authority, `Lead` applies Tier-1 fixes **immediately on the next wave** without pausing the run or waiting for Owner confirmation.
2. **Tier 2 — Concise Navigation Pointer or Repo Convention (`AGENTS.md` / `CONTEXT.md` — Last Resort):**
   - Used **only** when a recurring failure cannot be caught mechanically (e.g., where to find a non-obvious module seam or which existing helper to reuse).
   - **Authority (Quote Now, Ratify at Directive End):** To avoid stalling an autonomous multi-wave directive mid-run, `Lead` quotes the 1-line constraint directly into the `Contract Boundary & Regression Invariants` section of the remaining waves in the current directive (so `T-03..T-0N` are protected immediately) and appends a structured **4-Line Ratification Proposal** to `lead_report_to_supervisor` at directive completion. `Supervisor` presents the proposal to the Owner and writes to `AGENTS.md` or `CONTEXT.md` **only** when the Owner nods (`Ratification`).
3. **Tier 3 — No-Op Rule Deprecation (Anti-Bloat Law):**
   - If a failure recurs on a rule that is **already written** in `AGENTS.md`, that prose line has proven ineffective (`no-op`). Adding more emphatic prose ("CRITICAL: ALWAYS...") is forbidden; the rule must be upgraded to a Tier-1 mechanical `Gate` check and the ignored prose line removed on ratification.

### 3. Per-Project `Lead` Notebook (`<projectStateDir>/notebook.md`) & Audience Separation

1. **Placement & Visibility:**
   - Each Project owns an optional `<projectStateDir>/notebook.md` (`~/.paseo/plugin-state/paseo-factory/projects/<slug>/notebook.md`), stored outside `<project-root>` so it never dirties the Git working tree during `landTaskWorktree` and remains invisible to working `Peer`s (`Agent`s), keeping `Peer` attention 100% focused on the task's `4-Part Brief` and a minimal `AGENTS.md`.
   - `Seat write fence` (Layer 2) permits `Lead` and `Supervisor` to read and write `<projectStateDir>/notebook.md` while keeping `<projectStateDir>/{ledger.jsonl,project.json}` single-writer protected.
   - `buildSeatKickoffPacket` (`src/preflight.ts`) embeds `<projectStateDir>/notebook.md` (when present) into `Lead`'s Turn-1 kickoff packet, preserving institutional project memory across `128,000`-token `Lead handoff` rotations.
   - `Project reset` clears `<projectStateDir>/notebook.md` alongside `ledger.jsonl` and `lead-handoff.md`.
2. **Fixed Two-Section Schema & `<= 80`-Line Cap:**
   - `<projectStateDir>/notebook.md` is strictly bounded to `<= 80` lines (`<= 4 KB`) across two sections:
     - **`## 1. Verification & Run Recipe`** (established during Wave 1 / project onboarding, inspired by `pstack`'s `/create-verification-skill`):
       - `Worktree & Env Setup`: required `.worktreeinclude` entries and hydration notes.
       - `Fast Slice Check`: the exact command + timeout flag a `Peer` runs for inner-loop TDD on a single slice.
       - `Full Cumulative Gate`: the canonical `Gate` command verifying the new slice, entrypoint wiring, and existing regression suite.
       - `Process & Port Cleanup`: any daemon/DB/browser cleanup notes.
     - **`## 2. Recurrence Guard`:
       - Markdown table: `| ID | Cause → Effect Mechanism | Evidence (Task / seq) | State (observed / recurred / hardened / verified) | Enforcement (Gate / .worktreeinclude / AGENTS.md) |`

### 4. Four-Line Owner Ratification Format & Scoped Role of `factory retro`

1. **Four-Line Owner Ratification Format:**
   - Whenever `Supervisor` presents a `Recurrence Guard` proposal (from `Lead`'s end-of-directive report or from an on-demand `Retro` pass) that requires Owner ratification to edit `AGENTS.md` or `CONTEXT.md`, it uses a scannable 4-bullet format:
     1. **Chuyện gì đã lặp lại (What recurred):** Named tasks and attempt counts in plain language, with ledger `seq` citations at the end.
     2. **Nguyên nhân gốc (Causal mechanism):** Why the `Peer` or `Gate` hit the failure twice.
     3. **Nếu duyệt sẽ sửa gì (Exact preview diff):** The exact target file (`AGENTS.md`, `CONTEXT.md`, or `package.json` script) and the verbatim 1–2 line snippet to add/replace.
     4. **Tác dụng (Impact):** What class of failure or wasted attempt this prevents in future waves.
2. **Upgrading On-Demand `factory retro` (`src/retro.ts`):**
   - `factory retro` remains available as an on-demand historical audit pass (not required in day-to-day wave execution), upgraded to:
     - Read `<projectStateDir>/notebook.md` alongside `ledger.jsonl` so already-hardened patterns are not re-proposed.
     - Enforce the `Recurrence Guard` threshold in `parseRetroProposals` (`evidence` must cite at least `2` distinct ledger `seq` numbers across recurring events, capped at the top `1–2` highest-impact proposals).
     - Render `retro-<YYYY-MM-DD>.md` with task-resolved evidence (`T-02 (seq 18), T-04 (seq 34)`) and the 4-line ratification layout.

## Consequences

- `CONTEXT.md` defines **Wave Hardening**, **Recurrence Guard**, and **Project notebook**, and updates **Lead**, **Retro**, **Proposal**, **Ratification**, **Seat kickoff packet**, and **Project reset** to reference ADR 0048.
- Multi-wave runs self-correct recurring `Gate` and worktree friction immediately between waves without waiting for a manual retrospective ceremony or polluting `<project-root>/AGENTS.md` with unverified prose rules.
