# 0045 — Per-Project Ledger & Artifact Isolation, One-Time Auto-Split & Compact Migration, Lean Permit Recording, and Project-Scoped Deduped Retro

- **Date:** 2026-11-03
- **Status:** Accepted — Owner confirmed Q1–Q6 across a two-round `/grill-with-docs` session ("toàn bộ theo bạn khuyến nghị").
- **Amends:** [ADR 0004](0004-single-writer-plugin-cli-submits.md) (scales the single-writer plugin process from one root `Factory` instance to a plugin-owned `Per-Project Factory Registry` mapping each `<project-slug>` to its isolated `<stateDir>/projects/<project-slug>/ledger.jsonl` writer) · [ADR 0010 §5](0010-project-scoped-slp-worktrees-and-lead-agent.md) (completes the server-side wiring of per-Project `ledger.jsonl`, `report-<task>-<n>.md`, `gate-<task>-<n>.log`, and `retro-<YYYY-MM-DD>.md` under `<stateDir>/projects/<project-slug>/`).

## Context

An empirical audit of live `paseo-factory` state (`~/.paseo/plugin-state/paseo-factory/`) revealed why `Retro` had never run on Paseo Desktop and why `<stateDir>/ledger.jsonl` had grown to `875 KB` (`549` events) with `732,775` characters (`~183,200` tokens) of `Retro` digest payload:

1. **Unfinished Server-Side Wiring of ADR 0010 §5 (`plugin/index.server.ts:90`):**
   - Although `createFactory({ stateDir, projectSlug })` (`src/factory.ts:415`), `Private vault` (`src/vault.ts:269`), `History admission` (`src/history-admission.ts:195`), `Git shim` (`plugin/bin/git-shim.mjs:242`), and `Scrum harness` (`src/scrum/harness.ts:32`) already supported `<stateDir>/projects/<project-slug>/ledger.jsonl`, `plugin/index.server.ts` instantiated only a single unscoped `createFactory({ stateDir, fetchTimeline })` at the root directory.
   - As a result, all Projects wrote their events, `report-<task>-<n>.md` files, and `gate-<task>-<n>.log` files into the root `<stateDir>/`, causing:
     - **Zero human traceability on disk:** Hundreds of `report-*` and `gate-*` files and interleaved JSONL lines from unrelated Projects were mixed in one directory.
     - **Cross-Project Task ID collisions:** Because `#contracts` and `#attempts` were keyed globally by `task`, two Projects could not both use standard task IDs like `T-01` without colliding.
     - **Orphaned seat logs on `Project reset` / `Project delete`:** `permit_allowed` and `permit_denied` events recorded for `task: "supervisor"` and `task: "lead"` carried no project task ID and were never purged when a Project was reset or deleted.
2. **Seat `permit_allowed` Bloat (`~31%` of `ledger.jsonl` bytes):**
   - `191` lines (`264 KB`) of `ledger.jsonl` were `permit_allowed` events from `Supervisor` and `Lead` routine read/shell tool calls (including 15–18 KB inline Python scripts from pre-v0.0.88 handoffs) plus verbose `command` strings on allowed `Peer` tool calls.
   - While `permit_denied` and `git_blocked` are essential security and compliance evidence, recording every allowed read/shell call of `Supervisor` and `Lead` (and full multi-kilobyte `command` bodies on allowed `Peer` asks) polluted the `Ledger` without serving any verification or audit purpose.
3. **Unscoped, Un-Deduplicated `Retro` Corpus (`src/retro.ts`, `src/factory.ts`, `plugin/client/factory/shell.tsx`):**
   - `shell.tsx` (`runRetro`), `index.client.tsx` (`⌘K`), and `factory.mjs` (`factory retro`) invoked `retro({})` without `projectRoot`.
   - `Factory.retro(projectSlug)` only used `projectSlug` to resolve `lanes.retro`, while feeding the entire machine-wide `ledger.events` into `buildRetroDigest` and enforcing the `retro-same-day` limit globally across the whole machine.
   - When a `Task` underwent multiple `contract_set` revisions (`52` `contract_set` events across `24` Tasks in `goal-partner-f17f4d`), `buildRetroDigest` emitted all superseded `contract_set` descriptions verbatim (`262 KB` of duplicate text) and attached the same overwritten `report-<task>-1.md` file up to `5` times, inflating the prompt to `~183,200` tokens.
   - `parseRetroProposals` called `JSON.parse(output.trim())` directly without stripping optional ` ```json ... ``` ` markdown code fences emitted by LLM lanes.

## Decision

### 1. Per-Project Factory Registry & Complete `<stateDir>/projects/<project-slug>/` Isolation (Q1, Q5)

1. **Per-Project `Factory` Instances (`factoryForProject(slug)`):**
   - The plugin server (`plugin/index.server.ts`) replaces the single unscoped `Factory` instance with a **Per-Project Factory Registry** (`Map<projectSlug, Factory>`) backed by `createFactory({ stateDir, projectSlug, fetchTimeline })`, while retaining a lightweight root fallback `Factory` strictly for unbound machine-level operations.
   - Every Project stores its complete verification record inside `<stateDir>/projects/<project-slug>/`:
     - `<stateDir>/projects/<project-slug>/ledger.jsonl`
     - `<stateDir>/projects/<project-slug>/report-<task>-<n>.md`
     - `<stateDir>/projects/<project-slug>/gate-<task>-<n>.log`
     - `<stateDir>/projects/<project-slug>/retro-<YYYY-MM-DD>.md`
2. **Context-First Project Routing Across Spool, Choke, Git Shim, and CLI/MCP (Q5):**
   - Every Spool request, MCP tool call, `Choke policy` ask, and `Git shim` block resolves its target Project deterministically in priority order:
     1. Explicit `projectSlug` or `projectRoot` / `workspace` on the request.
     2. Authenticated `Correlation token` (`PASEO_FACTORY_CORRELATION` → `entry.project`) or `PASEO_FACTORY_PROJECT` / `PASEO_FACTORY_PROJECT_ROOT` environment binding.
     3. Canonical resolution of `cwd` (either `<project-root>` or `<stateDir>/projects/<slug>/worktrees/<task>`).
     4. For manual Owner CLI commands that name only `--task <task>` from an external directory, scan registered Project `Factory` instances for `<task>`: route automatically if exactly one Project owns `<task>`, or fail fast with an explicit ambiguity error (`ambiguous-task-project`) instructing the caller to pass `--project <slug>` or `--workspace <dir>` when multiple Projects share the same Task ID.
   - Because each Project owns its own `Factory` and `ledger.jsonl`, Task IDs (`T-01`, `T-02`, etc.) are scoped strictly per Project and never collide across Projects.
3. **Global `"All projects"` Aggregation & Zero Cross-Project Blast Radius:**
   - When the `Factory surface` is viewed under `"All projects"` (`projectRoot === undefined`), `snapshot` folds Tasks and KPIs across all registered Projects' `Factory` instances in memory.
   - `Project reset` and `Project delete` operate exclusively on the target Project's `<stateDir>/projects/<project-slug>/` directory and `Factory` instance, never rewriting or touching any other running Project's `ledger.jsonl`.

### 2. One-Time Auto-Split & Compact Migration on Startup (Q2, Q6)

- At plugin startup (before ordinary runtime loops start), if `<stateDir>/ledger.jsonl` exists and contains Project task events for registered Projects that do not yet have `<stateDir>/projects/<slug>/ledger.jsonl`:
  1. Partition historical events by Project (`resolveProject(contract.workspace)` / `taskInProject` / `cwd`), discarding orphaned events from previously deleted Projects.
  2. Apply the **Lean Permit Recording** compaction rule (§3) during migration: omit `permit_allowed` events where `task === "supervisor"` or `task === "lead"`, strip verbose `command` strings from `Peer` `permit_allowed` events (preserving `command` on `permit_denied` and `git_blocked`), andpreserve each kept event's original `seq` and `event_id` so existing references and citations remain valid.
  3. Move matching `<stateDir>/report-<task>-*.md`, `<stateDir>/gate-<task>-*.log`, and `<stateDir>/retro-*.md` files into `<stateDir>/projects/<slug>/` and rewrite `report_written.path`, `gate_finished.outputPath`, and `retro_written.proposalsPath` in the migrated Project ledger to their new `<stateDir>/projects/<slug>/...` paths.
  4. Atomically write `<stateDir>/projects/<slug>/ledger.jsonl` and archive the legacy root file to `<stateDir>/ledger.jsonl.legacy-bak` so active Projects (such as `goal-partner-f17f4d`) continue seamlessly without requiring a Project reset.

### 3. Lean Permit Recording in `ledger.jsonl` (Q3)

1. **`Supervisor` and `Lead` Seats (`deny-only` in `ledger.jsonl`):**
   - When `Choke policy` judges a permit ask from a `Supervisor`, `Lead`, or dispatcher session:
     - **Denied asks (`permit_denied`)** and Layer-3 **`git_blocked`** events are recorded in the Project's `<stateDir>/projects/<slug>/ledger.jsonl` with full `rule`, `reason`, and `command` evidence.
     - **Allowed asks (`permit_allowed`)** on `Supervisor` and `Lead` are answered immediately via `respondToPermission()` **without** appending a `permit_allowed` line to `ledger.jsonl`.
2. **Working `Agent` (`Peer`) Sessions (compact `permit_allowed`):**
   - For contracted working `Agent`s (`Peer`s), `permit_allowed` records `{ event: "permit_allowed", task, agent, name, kind }` (omitting the multi-kilobyte `command` payload) so `Report` and `Retro` continue to compute the per-Task `permit parade` (`Bashx120 Editx30 …`) with minimal byte overhead, while `permit_denied` and `git_blocked` retain the full `command` string for forensic inspection.

### 4. Project-Scoped, Deduplicated, Fence-Tolerant `Retro` (Q4, Q5)

1. **Strict Per-Project Execution & UI Binding:**
   - `shell.tsx` (`runRetro`) forwards `{ projectRoot }` for the selected Project, and disables the **Run Retro** button when `"All projects"` is selected (`projectRoot === undefined`), matching `Ratify via Supervisor` and `Reset Project`.
   - `factory retro` CLI accepts `--project <slug>` / `--workspace <dir>` (defaulting to `resolveProject(process.cwd())`).
   - `Factory.retro()` executes strictly against the target Project's `<stateDir>/projects/<slug>/ledger.jsonl`, writes `<stateDir>/projects/<slug>/retro-<YYYY-MM-DD>.md`, and enforces the `retro-same-day` rule per Project rather than machine-wide.
2. **Corpus Deduplication in `buildRetroDigest` (`src/retro.ts`):**
   - When a Task has multiple `contract_set` events (e.g. across re-contracts), `buildRetroDigest` renders the full `description` **only for the latest `contract_set` of that Task** (rendering prior `contract_set` events as compact 1-line epoch headers with their `seq` and `base`), eliminating hundreds of kilobytes of duplicated brief text.
   - `buildRetroDigest` deduplicates `report_written` attachments by resolved file path (keeping the latest `report_written` per path) so overwritten `report-<task>-<n>.md` files are never attached multiple times.
3. **Markdown Code-Fence Stripping in `parseRetroProposals` (`src/retro.ts`):**
   - Before calling `JSON.parse`, `parseRetroProposals` strips surrounding markdown code fences (` ```json ... ``` ` or ` ``` ... ``` `) if present, preventing false parse failures when LLM lanes wrap their JSON response in a fence.

## Consequences

- `CONTEXT.md` updates **Project**, **Ledger**, **Permit ask**, **Choke policy**, **Retro**, **Project reset**, and **Project delete**.
- Every Project's `ledger.jsonl`, `report-*.md`, `gate-*.log`, and `retro-*.md` live cleanly inside `<stateDir>/projects/<project-slug>/`, cutting `goal-partner-f17f4d`'s ledger size by `>60%` and its `Retro` prompt size from `~183,200` tokens to `<45,000` tokens while eliminating cross-Project Task ID collisions and `Reset Project` blast radius.
