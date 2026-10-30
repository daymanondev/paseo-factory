# 0035 — `Peer handoff` at `160k` Context Ceiling, Rolling-Wave Decomposition, and Modular Isolated Test Suites

- **Date:** 2026-10-30
- **Status:** Accepted
- **Amends:** ADR 0013 (`Lead handoff`), ADR 0029 (`Serial Wave` decomposition and `LEAD_WAVE_LAWS`), ADR 0031 (`Single-Active-Peer` lifecycle)

## Context

Forensic analysis of the `profile-max` multi-wave run (`2026-10-29` – `2026-10-30`, where `T-03` reached `376,579` tokens and `T-04` reached `345,666` tokens before manual abort) identified four compounding causes of extreme `Peer` (`Agent`) context bloat:

1. **Coarse Upfront Roadmaps Treated as Fixed Commitments:**
   - When `Lead` sent a Turn-1 `DEPENDENCY_REQUEST` proposing a 6-wave roadmap (`T-01`..`T-06`) that bundled multiple distinct interactive subsystems into single waves (`T-03` combining Artillery + Barracks melee/rally/respawn + 4-tower Lv1–Lv3 upgrades + 70% selling; `T-04` combining playable Hero + Rain of Fire + Reinforcements), `Supervisor` ratified the 6-wave list verbatim.
   - Even after `T-03` required `376.6k` tokens and a second correction epoch, `Lead` treated the ratified `T-01`..`T-06` list as locked rather than splitting `T-04` into smaller rolling waves (`T-04a`, `T-04b`).

2. **Monolithic Test Files ("God-Test-Files") Prescribed in Directive Architecture:**
   - Because `Supervisor`'s directive named two specific test file paths (`tests/unit_tests.gd` and `tests/e2e_playbot.gd`), every wave appended all unit and E2E tests into those two files (`unit_tests.gd` grew to `2,440` lines and `e2e_playbot.gd` grew to `4,578` lines).
   - Reading the existing codebase and those two monolithic test files consumed `~95,000` tokens before the `T-04` `Peer` made its first edit, and `edit` calls against multi-thousand-line files repeatedly failed on whitespace matching, forcing the `Peer` to re-emit `35,000+` character blocks (`~97,000` tokens spent in `toolCall` arguments across the session).

3. **Cross-Wave State Coupling in Monolithic E2E Journeys:**
   - Because all E2E stages ran inside a single monolithic script sharing default global state, adding a new default-active entity in `T-04` invalidated timing, gold, and positioning assumptions in `T-02` and `T-03` E2E stages — trapping the `Peer` in a 160-turn debugging loop (`~125,000` tokens of accumulated `thinking` blocks + `~28,000` tokens of `bash` output) and prompting it to raise the E2E watchdog timeout to `1,080s` (`18m`).

4. **No Runtime Context Ceiling on Working `Peer`s (`Agent`):**
   - While `Lead` rotates deterministically via `Lead handoff` at `128,000` tokens (ADR 0013), working `Peer`s had no runtime context ceiling, allowing a single `Peer` session to accumulate `345k–376k` tokens of stale reasoning blocks (`125k` tokens at `thinking: max`), failed edit payloads (`97k` tokens), and file reads (`95k` tokens).

## Decision

1. **Domain-Agnostic Modular & Isolated Test Law (`src/roles-contract.ts`, `src/preflight.ts`):**
   - Extend `SUPERVISOR_OUTCOME_BOUNDARY`: just as `Supervisor` never invents single-file source consolidation constraints (`index.html`), `Supervisor` must never prescribe single-file test consolidation (such as forcing all unit or E2E tests into one monolithic test file); directives and architecture boundaries must preserve per-feature / per-wave modular test files.
   - Extend `LEAD_WAVE_LAWS` and the `Agent` (`Peer`) role contract with universal software engineering test hygiene:
     - **Modular Test Files per Slice:** Organize unit and integration/E2E tests into separate modular files per feature or wave (invoked by the `Gate` runner) so a `Peer` working on wave $N$ reads, edits, and fast-runs only wave $N$'s test file during iteration before running the full cumulative `Gate` at `Claim` time.
     - **Fixture & State Isolation Across Slices:** Each slice's regression test suite must establish its own explicit initial state/fixtures so capabilities added in wave $N$ do not silently mutate the baseline assumptions of wave $1..N-1$ regression checks.
     - **Bounded Gate Execution:** Working `Peer`s must never inflate test/watchdog timeouts to masks hangs (e.g. `>300s`); a hanging test or third repeated failure on the same symptom requires root-cause diagnosis or immediate `agent_escalate_blocker` escalation.

2. **Rolling-Wave Decomposition & Single-Workflow Wave Sizing (`src/roles-contract.ts`):**
   - Clarify in `SUPERVISOR_OUTCOME_BOUNDARY` and `LEAD_WAVE_LAWS` that an initial wave roadmap (`T-01..T-0N`) is a **rolling-wave outline**, never a locked task count: when `Lead` proposes a roadmap or when a wave lands at a `Stable Checkpoint`, any wave that bundles multiple distinct interactive workflows/subsystems (or whose predecessor wave required re-contracting / high context) must be split into finer serial waves (`T-04a`, `T-04b`, etc.) before contracting.

3. **Runtime `Peer handoff` at `160,000` Tokens with a 1-Handoff-Per-Epoch Cap (`plugin/server/`):**
   - Introduce deterministic **`Peer handoff`** for working `Agent`s (`role === "agent"`) mirroring `Lead handoff`:
     - Monitor each active `Peer`'s context window usage (`lastUsage.contextWindowUsedTokens` with Pi `.jsonl` session fallback) at turn/step boundaries.
     - When an active `Peer` crosses **`160,000` tokens (`160k`)** without a settled `Claim`:
       1. **If `peerHandoffCount < 1` in the current `Contract epoch` (`maxPeerHandoffs = 1`):** steer a bounded handoff-extraction turn instructing the outgoing `Peer` to commit any working progress in the `Task worktree` and write a concise handoff summary (`<projectStateDir>/peer-handoff-<task>.md`: completed modules, passing vs. failing checks, and remaining blockers, guarded by a timeout fuse), archive the outgoing `Peer`, and automatically spawn one fresh successor `Peer` (`0%` context) inside the existing `Task worktree` carrying the `Contract` brief plus the handoff summary.
       2. **If the successor `Peer` (`peerHandoffCount >= 1`) also crosses `160,000` tokens without a green `Claim`:** steer a final commit/summary, archive the `Peer`, and automatically deliver a `BLOCKED (context-ceiling)` escalation to `Lead` via the `Lead mailbox` so `Lead` inspects the partial worktree progress and splits the remaining scope into a new wave rather than spinning infinite `Peer`s.

## Consequences

- **Positive:**
  - Completely domain-agnostic: applies equally to web apps, backend APIs, CLIs, mobile apps, and games without any domain-specific prompt rules.
  - Working `Peer`s never degrade into `300k+` token loops; crossing `160k` cleanly sheds accumulated `thinking` and `toolCall` history into a fresh `0%`-context successor `Peer`, and a task that still overflows after one handoff (`~320k` total across 2 `Peer`s) is automatically returned to `Lead` for wave splitting.
  - Per-slice modular test files eliminate `50k+` token upfront test-file reads, prevent multi-thousand-line `edit` whitespace failures (`97k` token waste), allow sub-10-second targeted test runs during development, and isolate prior-wave regression fixtures from new-wave features.
- **Negative / Trade-offs:**
  - `Lead` and `Peer` runtime monitoring adds per-task `peerHandoffCount` tracking per `Contract epoch`, bounded to at most 1 automatic handoff (`2` `Peer`s max per epoch) so runaway tasks cannot loop indefinitely.
