# ADR 0028 — Outcome-and-Gate Contracts Without Pre-Solved File-Scope Handcuffs

- **Status:** Accepted — 2026-10-25 (`grill-with-docs` Q1–Q5; ratified by Andrew)
- **Grounded in:** Canonical SLP `LEAD.md` (`research/90-sources/original-files/LEAD.md`), `paseo-room` (`research/notes/paseo-room.md`, where `scope` is recorded as starting hints rather than a containment fence), and `codex-room` (`research/notes/codex-room-setup.md`, where Peers report changed paths at handoff).
- **Amends:** [ADR 0010](0010-project-scoped-slp-worktrees-and-lead-agent.md) §4/§6 (`Contract.scope` Station 4 red Verdict and same-Project `liveWorkspaceConflict`), [ADR 0016](0016-role-scoped-mcp-bridge-kickoff-packet-and-three-layer-execution-fence.md) §3 (`agy-pre-tool-hook.mjs` and `lead_set_contract` MCP schema), and [ADR 0019](0019-provider-isolated-opencode-fences-worktree-continuity-and-root-hydration.md) §3/§6 (`Entrypoint Integration & Lockfile Law`).

## Context

In `v0.0.5` (before per-Task `git worktree` isolation arrived in ADR 0010), `Contract.scope`, `liveWorkspaceConflict`, `spawn-scope-mandatory`, and `git-shim`'s working-tree discard block (`git checkout --` / `git restore`) were introduced to prevent concurrent working Agents from stepping on each other or discarding uncommitted user edits inside a single shared checkout.

Once every spawned Task moved into its own isolated `Task worktree` (`<projectStateDir>/worktrees/<task>` on branch `factory/<task>`) and landed via `landTaskWorktree` (which cherry-picks the attested commit into `<project-root>` and re-runs the Contract's `Gate` on `<project-root>`), those legacy file-scope handcuffs created five compounding failure modes in live SLP waves:

1. **`liveWorkspaceConflict` Forced `Lead` to Invent Narrow File Scopes (`src/workspace-conflict.ts:25-30`):**
   - `scopesOverlap` returned `"one contract is unscoped"` whenever two unaccepted Contracts shared `<project-root>` and either omitted `scope`, and `requestSpawn` refused `arity >= 2` with `spawn-scope-mandatory` unless every Contract declared `scope`.
   - Whenever `Lead` registered a multi-Task wave (`T-01`, `T-02`), it was mechanically forced to pre-declare disjoint file `scope` globs before any Peer had read the code.
2. **Station 4, `git-shim`, and `agy-pre-tool-hook` Punished `Peer` for Legitimate Edits (`src/factory.ts:778-795`, `plugin/bin/git-shim.mjs:284-340`, `plugin/bin/agy-pre-tool-hook.mjs:449-451`):**
   - Whenever `Lead` forgot a helper module, config file, test fixture, or entrypoint in `Contract.scope`, `Peer` was blocked at edit/commit/Claim time with `out-of-scope` or a hard `verdict: "red"`, triggering `Denial-stall`s or forcing `Peer` to contort its implementation to fit `Lead`'s guess.
3. **Mandatory `Contract.artifact` File-Path Pre-Declaration (`src/factory.ts:438`, `plugin/bin/bridge.mjs:1020`):**
   - Requiring `Lead` to name a single mandatory `artifact` file path upfront forced `Lead` to guess target filenames even on bugfix, refactor, or deletion Tasks where `Gate` exit `0` + a non-empty commit diff (`base..claimed`) already prove completion.
4. **`LEAD_CONTRACT` Encouraged File-Level Pre-Solving Over Outcome + Regression Gates (`src/roles-contract.ts:94,146,148`):**
   - Teaching `Lead` to decompose directives into file-scoped implementation steps caused `Lead` (which does not run or edit code) to prescribe implementation details without full historical context, risking regressions when `gate` only checked the new feature.
5. **`git-shim` Blocked Benign Working-Tree Cleanup Inside Isolated `Task worktree`s (`src/choke.ts:247-295`, `plugin/bin/git-shim.mjs:345`):**
   - Inside its own disposable `Task worktree`, a `Peer` that tried an experiment and ran `git restore <file>` or `git checkout -- <file>` to clean its working tree before `agent_claim` (Station 2 `checkCleanAt`) was blocked by `git:restore-discard` / `git:checkout-discard`.

## Decision

1. **Retire Hard `Contract.scope` Enforcement for Code Paths; Keep the Memory Write Fence (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`).**
   - Station 4 (`claimTask` in `src/factory.ts`), `checkAgentCommitScope` (`plugin/bin/git-shim.mjs`), and `agy-pre-tool-hook.mjs` no longer fail or block a working `Agent` (`Peer`) for modifying files outside `Contract.scope`.
   - **Station 4b (Memory Write Fence)** remains strictly enforced across `claimTask`, `Choke policy`, `git-shim`, and `agy-pre-tool-hook`: a working `Agent` may never modify `AGENTS.md`, `CLAUDE.md`, or `CONTEXT.md` unless `Contract.scope` explicitly lists that memory file.
   - `scope` is removed from the advertised `lead_set_contract` MCP tool `inputSchema` in `plugin/bin/bridge.mjs` so `Lead` is never prompted to pre-declare file lists for `Peer` (while remaining accepted in the handler and CLI for backward compatibility and explicit memory-file opt-ins).

2. **Unscoped Same-Project Contracts & Parallel Spawns Never Conflict (`src/workspace-conflict.ts`, `src/factory.ts`).**
   - Because each Task executes in its own isolated `Task worktree` (`<projectStateDir>/worktrees/<task>`) and conflict detection + post-cherry-pick Gate verification happen at `Accept` (`landTaskWorktree`), `scopesOverlap` returns `undefined` whenever either Contract on the same Project root omits `scope`, and `requestSpawn` no longer refuses unscoped Contracts at `arity >= 2` (`spawn-scope-mandatory` retired).
   - Nested directory workspaces (`relation === "inside"` or `"contains"`) and pairs of Contracts that both explicitly declare overlapping `scope` globs continue to refuse with `workspace-conflict`.

3. **Optional `Contract.artifact` (`src/factory.ts`, `src/gate.ts`, `plugin/bin/bridge.mjs`, `plugin/bin/factory.mjs`, `plugin/server/spool.ts`).**
   - `artifact` is optional on `lead_set_contract`, `factory contract`, Spool `contract` requests, and `factory.setContract` (stored as `""` on `contract_set` when omitted so `v2` Ledger schema validation stays byte-compatible; validated with `artifactPathProblem` whenever explicitly provided).
   - When `contract.artifact === ""`, `runGate` (`src/gate.ts`), `claimTask` (`src/factory.ts`), and `history-import` / `history-admission` judge the Attempt by `Gate` exit `0` + clean attested commit (`headCommit !== baseCommit`), without requiring a pre-named file path.

4. **Outcome + Regression-Gate Law in `LEAD_CONTRACT` (`src/roles-contract.ts`).**
   - Replace the file-scope and lockfile mandates in `renderRoleContract("lead")` with the **Outcome & Regression-Gate Law**:
     - `Lead` specifies **Desired Outcome + Regression Invariants** (what behavior must hold and what existing capabilities must not break) and lets `Peer` investigate the codebase and choose the right files/modules inside its `Task worktree`.
     - Every Task's `gate` command must run both the new feature/fix verification **and** the repository's existing test/typecheck/build suite so regressions in legacy code fail the `Gate` immediately.

5. **Allow Working-Tree Discard (`git restore` / `git checkout --`) Inside Isolated `Task worktree`s (`src/choke.ts`, `plugin/bin/git-shim.mjs`).**
   - `judgeShellCommand` (`src/choke.ts`) and `plugin/bin/git-shim.mjs` permit `git:checkout-discard` and `git:restore-discard` when the command executes inside an isolated `Task worktree` (`memory.worktree` or `<projectStateDir>/worktrees/<task>`), while continuing to block working-tree discard on `<project-root>`.
