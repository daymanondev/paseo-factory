# 0052 — Anti-Fractal Wave Convergence, Structural Context-Ceiling Hardening, and Notebook Graduation (`seatworks` / `paseo-room` / `pstack` Synthesis)

- **Date:** 2026-11-08
- **Status:** Accepted — ratified by the Owner via `/grill-with-docs` after auditing the 7-day, 120-task `goal-partner` (`goal-partner-f17f4d`) production run.
- **Amends:** `Serial Wave`, `Wave Hardening`, `Recurrence Guard`, and `Project notebook` in `CONTEXT.md` · extends [ADR 0044](0044-vertical-wave-slicing-contract-bounded-review-reply-first-handoff-heredoc-choke-and-worktree-process-reaping.md), [ADR 0047](0047-lead-context-budget-hygiene-active-only-roster-and-peer-owned-skills.md), and [ADR 0048](0048-in-flight-wave-hardening-recurrence-guard-and-project-notebook.md).

## Context

During the 159-hour, 120-task production run of `goal-partner` (`goal-partner-f17f4d`, `1,920+` ledger events, `86` Lead rotations, `264` Peer sessions), mechanical SLP compliance held at 100% (`0` `permit_denied` or `git_blocked` violations across the last `1,500+` ledger events, `92.4%` Gate GREEN rate). However, five interrelated strategic and operational failure modes emerged across `86` Lead rotations:

1. **Codex OS Seatbelt Sandbox vs. Canonical `<projectStateDir>/notebook.md`:** On `codex` Lead seats (`modeId: "auto"`), macOS Seatbelt restricts shell file writes to `<project-root>` and `/tmp`. Unable to write `<projectStateDir>/notebook.md` via shell commands (`mailbox.jsonl` `seq 424`), the Lead wrote `<project-root>/.scratch/notebook.md` instead. This dirtied `<project-root>` (`?? .scratch/notebook.md`), causing `lead_merge` (`landTaskWorktree`) to fail at `seq 862` and forcing the Lead to manually `mv .scratch/notebook.md /private/tmp/...` before every `lead_merge` and restore it afterward across 50+ waves — while `readProjectNotebook` (`src/preflight.ts`, `src/retro.ts`) saw `(none yet)`.
2. **Unbounded `Recurrence Guard` Row Accumulation (`V-01` → `V-27`, `4,045 / 4,096` bytes):** The Lead appended 27 rows to `notebook.md` without retiring a single row — keeping 12 `observed (1x)` anomalies from 50–80 waves earlier that never recurred, 11 `verified` entries whose mechanical fixes had held for 80 waves, and 4 separate rows (`V-04`, `V-22`, `V-26`, `V-27`) for the same underlying context-duplication mechanism. Silent bottom-of-file truncation on read risks dropping the newest rules at the bottom of the Markdown table.
3. **Fractal Micro-Wave Spirals & Test-Only Sub-Wave Chains (`GP-T24h4a` → `T24h4f1`):** When a vertical slice hit `peer-context-ceiling` (`42` occurrences), the Lead split features across horizontal seams (`T24h` SQL → `T24h2` UI → `T24h3` journey) and then autonomously spawned **7 consecutive test-only micro-waves** (`T24h4a..f1`, forbidding `src/` edits) to test individual error/refusal branches — including 2 waves testing refusal behavior of a temporary singleton restriction slated to be replaced next — while whole product journey groups (`busy`, `journal`, `goal-review`) remained unbuilt.
4. **Monolith File Accumulation Driving Context-Ceiling Loops (`workspace-provider.tsx` at 8,688 lines, `account-app-fixture.ts` at 6,234 lines):** Recovery directives treated `context-ceiling` by narrowing each wave's allowed file subset rather than modularizing the oversized orchestration/fixture files, multiplying wave counts as those central files grew.
5. **Per-Wave Gate Script Bloat (`46` `scripts/verify-*.mjs` files, `16,896` lines) & Post-GREEN Test-Polish Re-Contracting (`32.4%` GREEN Rejection Rate):** Each micro-wave minted a 400–600 line bespoke verification script with brittle substring arrays, and Lead rejected 55 of 170 GREEN Gate attempts — often re-contracting a passing wave solely to deduplicate test setup or add redundant zero-count assertions.

Cross-referencing `seatworks` (`/Users/andrewpham/tools/seatworks`), `paseo-room` (`/Users/andrewpham/tools/paseo-room`), and `pstack` (`poteto/pstack`) established three governing laws:
- **Anti-FIFO Notebook Graduation (`seatworks`):** *"When it gets long, the answer is to fold rows into the pattern they are all instances of, not to drop the oldest to stay under a number. A `verified` row whose fix has held for weeks has done its work and can go."*
- **Strict Lead-vs-Peer Cognitive Firewall (`paseo-room`):** Operational notebooks and orchestration protocols belong strictly to `Lead` (and `Supervisor`); they are never broadcast into `Peer` prompts where every worker pays context pressure.
- **Encode Lessons in Structure (`pstack`):** A `Tier-2 quote` is a temporary bridge (at most 2–3 waves); any rule still needed after 3 waves must be encoded into Tier-1 mechanical structure (shared helper, module seam, or Gate check) and retired from prose.

## Decision

1. **Plugin-Owned Notebook Persistence (`lead_update_notebook` MCP Tool & `factory notebook` CLI) + Legacy `.scratch/notebook.md` Promotion:**
   - Add `lead_update_notebook` to the `lead` MCP role catalog (`src/mcp/shared.ts`, `plugin/bin/bridge.mjs`) and `kind: "notebook"` to `plugin/server/spool.ts` (plus `factory notebook` CLI). Because the plugin server writes `<projectStateDir>/notebook.md` in-process (ADR 0004 single writer), `Lead` seats on OS-sandboxed providers (`codex` Seatbelt) update the canonical notebook without touching `<project-root>` or `/tmp`.
   - `writeProjectNotebook` validates before writing: it requires both fixed section headings (`## 1. Verification & Run Recipe` and `## 2. Recurrence Guard`) and enforces `<= 80` lines, `<= 4,096` UTF-8 bytes, and `<= 12` active `Recurrence Guard` table rows (`PROJECT_NOTEBOOK_MAX_GUARD_ROWS = 12`). Over-limit writes are refused with `notebook-limit-exceeded` (or `notebook-schema-invalid`) naming the exact counts and instructing the Lead to fold/retire rows rather than silently truncating the bottom of the table.
   - `syncLegacyScratchNotebook` (invoked by `readProjectNotebook` when `projectRoot` is known and before `landTaskWorktree` clean-tree checks) automatically promotes an untracked `<project-root>/.scratch/notebook.md` into `<projectStateDir>/notebook.md` (when canonical is absent or older) and unlinks the untracked working-tree copy so `lead_merge` never fails with `pending-conflict (?? .scratch/notebook.md)`.

2. **Notebook Graduation & Cognitive Firewall (`seatworks` + `paseo-room` + `pstack`):**
   - Preserve the `paseo-room` cognitive firewall: `<projectStateDir>/notebook.md` is never auto-injected into `Peer` dispatch briefs.
   - Enforce the `seatworks` 3-rule graduation discipline in `LEAD_WAVE_LAWS` (`<= 12` active `Recurrence Guard` rows):
     1. **Fold:** Merge rows that share the same underlying `Cause → Effect` mechanism into one row.
     2. **Verified Retirement (`3` waves):** Delete `State: verified` rows once their Tier-1 mechanical check or helper has held across `3` subsequent waves.
     3. **Stale `1x` Expiry (`5` waves):** Delete `State: observed (1x)` rows that have not recurred within `5` waves.
   - Cap `Tier-2 quote` prose in `Contract.description` at **at most 2–3 waves**: if a convention still bears on work after 3 waves, the Lead must convert it into Tier-1 mechanical structure (shared support module or Gate check) and stop quoting prose into briefs.

3. **Bounded Split & Single Verification Tail (Anti-Fractal `Serial Wave` Law):**
   - When a vertical slice hits `BLOCKED (context-ceiling)` and must split across seams (`Wave A` data/SDK seam → `Wave B` provider/UI wiring), its verification tail (`Wave C`) is capped at **at most 1 combined journey wave** covering both happy path and failure/retry recovery in one concise suite.
   - Standalone **test-only negative-matrix sub-wave chains** (`T-04d1..d6` testing individual error/refusal branches with `src/` frozen) and waves testing refusal behavior of temporary stubs slated for replacement are explicitly forbidden.

4. **Structural Decomposition on Recurred `context-ceiling` (`Wave Hardening`):**
   - When `BLOCKED (context-ceiling)` recurs (`>= 2` times) on Tasks touching the same central orchestration, provider, or test-fixture file (`> 1,500` lines), the mandatory `Wave Hardening` action is to schedule a bounded **module/fixture extraction wave** (splitting domain controllers/hooks or composable fixture helpers into focused `~200–400` line files) rather than perpetually micro-splitting downstream features around the monolith.

5. **Parameterized Shared Gate Runner & No Post-GREEN Test-Polish Re-Contracting (`Closure & Integration Loop`):**
   - Contracts must reuse the repository's shared cumulative Gate runner parameterized by the current slice's test file (`<fast-slice-test> && <shared-cumulative-gate>`) rather than minting 400-line per-task `scripts/verify-<task>.mjs` scripts with hardcoded source-marker arrays.
   - Once the mechanical Gate is GREEN, the contracted outcome holds, and proof falsification passes, Lead **must accept and land immediately via `lead_merge`** — re-contracting a GREEN wave solely for test-file DRYness, helper deduplication, or redundant zero-call assertions is forbidden (defer structural test cleanup to `Wave Hardening` on the next wave).

## Consequences

- `codex` Lead seats update `<projectStateDir>/notebook.md` cleanly via `lead_update_notebook` without Seatbelt failures or `/private/tmp` merge workarounds, and existing `.scratch/notebook.md` files migrate and self-clean automatically.
- `notebook.md` stays under `<= 12` high-signal rows across 100+ wave runs without losing recent entries to bottom truncation.
- Multi-feature directives converge via coarse vertical slices and structural module extraction rather than exploding into test-only micro-wave spirals.
