# 0047 — Lead Context-Budget Hygiene: Deduplicated Kickoff, Active-Only Peer Roster, Peer-Owned Domain Skills, Bounded Diff Review, and 8 KB `lead-handoff.md` Cap

- **Date:** 2026-11-05
- **Status:** Accepted — Owner confirmed Q1–Q4 in `/grill-with-docs` ("toàn bộ theo bạn khuyến nghị").
- **Amends:** [ADR 0010](0010-multi-project-isolation-task-worktrees-and-tiered-acceptance.md) (scopes domain implementation skills strictly to `Peer` and forbids `Lead` from reading framework/domain `SKILL.md` files) · [ADR 0013](0013-lead-mailbox-context-rotation-and-role-contracts.md) (compacts `renderPeerRoster` to active/unaccepted tasks plus a 1-line accepted-task summary and lowers the `lead-handoff.md` cap from `24 KB` to `8 KB`) · [ADR 0016](0016-role-scoped-mcp-bridge-kickoff-packet-and-execution-fence.md) (deduplicates `buildSeatKickoffPacket` when prepended to a system-prompted seat on Turn 1 and compacts `summarizeLedgerTasks`) · [ADR 0029](0029-delegation-boundary-rolling-waves-and-challenge-reconciliation.md) (caps `Contract.description` at `<= 2,500 chars` and adds bounded anti-truncation diff inspection to `LEAD_WAVE_LAWS`) · [ADR 0042](0042-unified-skill-hub-host-ecosystem-discovery-and-project-skill-packs.md) (adds automatic lightweight `Project skill pack` hint on `Peer` spawn when `Contract.skills` is omitted) · [ADR 0044](0044-autonomous-lead-resilience-vertical-slice-waves-and-worktree-hygiene.md) (lowers `LEAD_HANDOFF_MAX_BYTES` from `24 KB` to `8 KB` while keeping `LEAD_ROTATE_TOKENS = 128_000`).

## Context

In a 49-task live run on `goal-partner` (`goal-partner-f17f4d` on Paseo Desktop), the Project rotated through **49 `Lead` sessions** (`~1 task per Lead`, `121.7M` cumulative tokens). The active `Lead` (`0124d3d4-de64-4729-a8da-96ab4a856918`) consumed **`108,540` context window tokens (`84.8%` of the `128,000` rotation threshold)** after completing only a single wave transition (`GP-T09c1-account-notification-list` → `GP-T09c2-account-notifications-read-all`).

Forensic inspection of the Codex rollout transcript (`rollout-2026-11-05T10-12-23-01a1a9b1-7a22-7770-9f2d-a451de03eef9.jsonl`) identified two compounding root causes:

1. **Turn-0 Static & Historical Context Inflation (`43,318` input tokens before the first tool call):**
   - Alongside the Codex harness's fixed tool/skill/memory baseline (`~26.8k` tokens), `paseo-factory` injected `~16.5k` tokens (`~69.4 KB`) on Turn 1:
     - `buildRoleKickoffPrompt("lead")` (`src/roles-contract.ts`) prepended `linkedDesignSpecification` and also called `renderRoleContract("lead")`, which embedded `linkedDesignSpecification` a second time in the same developer message.
     - `prependKickoffPacketIfFirstTurn` (`plugin/server/lead-mailbox.ts`) prepended `buildSeatKickoffPacket`, repeating `linkedDesignSpecification`, `renderHelperMcpRoster`, and all 8 `LEAD_WAVE_LAWS` (`~5.1 KB`) that were already present in `config.systemPrompt`, plus an `O(N)` `summarizeLedgerTasks` line (`3.5 KB` across 49 tasks).
     - `renderPeerRoster` (`plugin/server/lead-mailbox.ts`) rendered a full 380-character status/agent/worktree/attempt/report line for all **45 already-accepted tasks** (`18.6 KB` / `~4.8k` tokens of closed history).
     - `lead-handoff.md` stood at the `24 KB` ceiling (`24,564` chars / `~6.2k` tokens) because outgoing Leads pasted active `Contract.description` texts and multi-paragraph post-mortems of already-accepted waves.
2. **Turn-1 Operational Context Burn (`+65,222` tokens in a single wave transition):**
   - **Lead reading Peer-owned `SKILL.md` files (`+15,000` tokens):** Because `renderSeatCommandBlock("lead")` showed `skills: ["tdd"]` in the `lead_set_contract` example, each newly rotated Lead ran `cat` on 7 `SKILL.md` files (`codebase-design`, `tdd`, `expo-overview`, `expo-router`, `expo-native-ui`, `expo-ui`, `expo-data-fetching` = `59.9 KB`) to curate `skills` for the next `Contract`, even though `Lead` never writes product code and `Peer` already discovers `<available_skills>` natively.
   - **Codex REPL middle-truncation loops during diff review (`+44,000` tokens):** When reviewing a landed `Peer` commit, `Lead` batched multiple `git diff` and `cat` commands inside a single `mcp__cua_repl` (`exec`) call using `Promise.allSettled([...])` and `results.forEach((r,i)=>text({i,...r}))`. JSON-stringifying multi-file stdout exceeded the REPL's `~40 KB` output ceiling 4 times (`13.5k`, `23.0k`, `13.1k`, `12.2k` tokens), triggering middle-truncation warnings and forcing 4–5 re-read tool calls.
   - **Pre-solving implementation details in `Contract.description` (`+8,700` tokens):** `Lead` read multiple `src/` implementation files before setting a `6.5 KB` `Contract.description` that prescribed internal function/prop names rather than stating a concise `<= 2,500`-char 4-Part Brief.

## Decision

### 1. Deduplicate Turn-0 Prompts and Compact `O(N)` Accepted-Task History (Q1)

1. **Eliminate Duplicate `linkedDesignSpecification` in `buildRoleKickoffPrompt` (`src/roles-contract.ts`):**
   - Because `renderRoleContract("lead")` already includes `linkedDesignSpecification(options.project?.root)`, `buildRoleKickoffPrompt` omits the outer `linkedDesignSpecification` prefix when `role === "lead"`, ensuring the Open Design specification appears once per message.
2. **Deduplicate System-Prompted Turn-1 Kickoff (`src/preflight.ts` & `plugin/server/lead-mailbox.ts`):**
   - `SeatKickoffPacketInput` adds `omitSystemPromptDuplicates?: boolean`. When `prependKickoffPacketIfFirstTurn` (`plugin/server/lead-mailbox.ts`) builds the Turn-1 kickoff packet for a seat whose `config.systemPrompt` already carries `buildRoleKickoffPrompt(role)`, it passes `omitSystemPromptDuplicates: true`, omitting the redundant `linkedDesignSpecification`, `renderHelperMcpRoster`, and `LEAD_WAVE_LAWS` / `SUPERVISOR_OUTCOME_BOUNDARY` blocks from the Turn-1 user message while preserving repository preflight facts (`Workspace`, `Git`, `Top-level files`, `Project memory`, `Build/Test commands`, `Active lanes`, `Ledger tasks`, `Role MCP tools`, and `Fire-and-End-Turn`). Direct callers of `buildSeatKickoffPacket` default `omitSystemPromptDuplicates` to `false`.
3. **Active-Only Detail in `renderPeerRoster` (`plugin/server/lead-mailbox.ts`) and `summarizeLedgerTasks` (`src/preflight.ts`):**
   - `renderPeerRoster` partitions `input.tasks` into `acceptedTasks` (`task.accepted || task.status === "accepted"`) and `activeTasks` (all unaccepted tasks):
     - Renders a single compact summary line for `acceptedTasks` (listing the total accepted count and at most the latest 5 accepted task IDs).
     - Renders full per-task lines (`status`, bound `agent` + live daemon status, `worktree` path + branch, `latest attempt`, and `report`) **strictly for `activeTasks`** (unaccepted tasks).
   - `summarizeLedgerTasks` similarly summarizes accepted tasks into a compact count + latest tail when more than 3 tasks are accepted, keeping detailed `[status, attempts, verdict]` entries for all unaccepted tasks.

### 2. Peer-Owned Domain Skills & Lightweight `Project skill pack` Hint on `Peer` Spawn (Q2 — Option A)

1. **Remove Manual `skills` Curation & Reading Burden from `Lead` (`src/roles-contract.ts`):**
   - Remove `skills: ["tdd"]` from the `paseo-factory_lead_set_contract` primary command example in `renderSeatCommandBlock("lead")` (retaining `skills?: string[]` in the MCP/Spool/Ledger schema for backward compatibility).
   - Add an explicit rule in `renderRoleContract("lead")` and `LEAD_WAVE_LAWS`: `Lead` must **never** read (`cat`) implementation or framework `SKILL.md` files (`expo-*`, `eas-*`, `firebase-*`, etc.) into its own context window; domain and implementation skills belong strictly to the working `Agent` (`Peer`), which discovers them natively via `<available_skills>`.
2. **Automatic Lightweight Pack Hint on `Peer` Spawn (`plugin/server/spool.ts`):**
   - When `contract.skills` is omitted or empty on `spawn`, `plugin/server/spool.ts` checks `detectProjectSkillPacks(contract.workspace)` (`src/scrum/skill-hub.ts`) and prepends a concise 1-line reminder to the `Peer` prompt (`Skill discipline: apply tdd and open only the specific skill(s) in <available_skills> relevant to this task's slice — never bulk-read unrelated SKILL.md files`, naming any detected `Project skill pack` such as `expo`). When `contract.skills` is explicitly provided, existing behavior is preserved.

### 3. Concise 4-Part Briefs, Bounded Anti-Truncation Diff Review, and `8 KB` `lead-handoff.md` Cap (Q3)

1. **Concise `<= 2,500`-Character `4-Part Brief` (`LEAD_WAVE_LAWS` in `src/roles-contract.ts`):**
   - `Contract.description` is capped by law at `<= 2,500 chars` (~600 tokens) covering only (1) Bounded Outcome, (2) Contract Boundary & Regression Invariants, (3) Excluded / Deferred to Later Waves, and (4) Verification (`gate` command). `Lead` must not read deep implementation files to pre-solve internal function/prop names before setting a Contract.
2. **Bounded Diff Inspection Without REPL Middle-Truncation Loops (`LEAD_WAVE_LAWS` in `src/roles-contract.ts`):**
   - In the `Closure & Integration Loop`, when `Gate` is `GREEN` and `Watch < 0.5`, `Lead` inspects `<projectStateDir>/report-<task>-<n>.md` and `git show --stat "<sha>"` first, then inspects targeted file diffs (`git diff "<sha>^" "<sha>" -- <file>`) in bounded chunks (`<= 6,000 tokens` per call), never wrapping multi-file `git diff` or `cat` outputs inside `JSON.stringify` (`text({i,...r})`) in a single REPL `exec` call.
3. **`8 KB` `lead-handoff.md` Cap & Concise Extraction Prompt (`plugin/server/lead-mailbox.ts`):**
   - Lower `LEAD_HANDOFF_MAX_BYTES` from `24 * 1024` (`24 KB`) to `8 * 1024` (`8 KB`).
   - Update `renderHandoffExtractionPrompt` to state the `8 KB` cap and explicitly instruct the outgoing `Lead` not to copy-paste active `Contract.description` blocks verbatim (already recorded in `ledger.jsonl`) or write detailed code/test inventories of already-accepted waves.

### 4. Retain `LEAD_ROTATE_TOKENS = 128_000` (Q4 — Option A)

- Keep `LEAD_ROTATE_TOKENS = 128_000` in `plugin/server/lead-mailbox.ts`. With Turn-0 prompt deduplication, active-only Peer roster, `8 KB` handoff cap, zero `SKILL.md` reading on `Lead`, and bounded diff inspection, each wave consumes `~10k–15k` tokens instead of `~65k` tokens, enabling a single `Lead` session to orchestrate `5–8` waves cleanly before rotating.

## Consequences

- `CONTEXT.md` updates **Lead**, **Contract**, **Lead handoff**, **Seat kickoff packet**, and **Project skill pack** to reflect the `8 KB` handoff cap, active-only Peer roster, deduplicated Turn-1 kickoff, Peer-owned domain skills, and bounded diff inspection.
- `Lead` sessions no longer burn `43k` tokens at Turn 0 or `65k` tokens per wave on duplicate instructions, closed-task rosters, `SKILL.md` reads, and REPL middle-truncation re-read loops.
