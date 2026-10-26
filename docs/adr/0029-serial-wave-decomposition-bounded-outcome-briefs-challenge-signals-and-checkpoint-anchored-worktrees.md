# ADR 0029 — Serial-Wave Decomposition, Bounded-Outcome Briefs, Challenge Signals, and Checkpoint-Anchored Worktrees

- **Status:** Accepted — 2026-10-26
- **Source:** `.scratch/factory-v0.0.41/spec.md`, grounded in paseo-room and codex-room operational contracts.
- **Amends:** ADR 0010 (Lead acceptance and Task worktrees), ADR 0016 (Seat kickoff packet), and ADR 0028 (outcome-and-gate briefs).

Multi-subsystem directives were being passed through as one oversized Task because simultaneous dispatch from an empty HEAD creates conflicting foundations. Serial Waves are now the default: outline the roadmap, contract and spawn only the current wave against the current Stable Checkpoint, and end the turn. Each Task owns one independently verifiable vertical slice sized under ~120K peak Agent context. Single-task directives remain valid for focused bugfixes or small isolated changes; a single-file deliverable still requires multiple waves when it spans subsystems. Up to three Tasks may share a wave only after a shared foundation exists and their module/file surfaces are genuinely disjoint.

Every Lead-authored Contract description states Bounded Outcome, Contract Boundary & Regression Invariants, Excluded / Deferred to Later Waves, and Verification (the exact Gate command). Supervisor preserves Owner outcomes and architecture boundaries without inventing file-consolidation constraints. These are role instructions rather than a mechanical minimum task count or a new Ledger schema.

On every GREEN, CONCERN-free wave, Lead inspects the attested commit diff against the brief and calls `lead_accept_task` to land it in project HEAD. Enabled Fresh-eyes must have completed with CLEAR; pending, failed, or interrupted review does not qualify. CONCERN and Needs-human remain acceptance barriers. Lead inspects the landed foundation and contracts/spawns the next wave in the same turn. The final wave is also accepted and landed before `lead_report_to_supervisor`; Owner final sign-off remains intact.

Agents honor deferred scope. A third failed fix showing the same symptom stops local patching until the underlying mechanism is diagnosed. Agents commit independent completed work before escalating via `agent_escalate_blocker`, supplying evidence and current SHA with `REOPEN_REQUEST` (foundation | dependency | lifecycle | API | ownership | verification), `DEPENDENCY_REQUEST`, or `BLOCKED`. Lead rules on technical evidence, re-contracts and re-spawns, or escalates Owner-owned decisions.

CLI pre-spawn allocation now follows the existing Spool and MCP checkpoint rule: an `attempt_accepted` event after the Task's Contract advances allocation to current project HEAD only when that Task has no Claims in the current Contract epoch. Current-epoch retries retain the original base. This preserves retry semantics while allowing pre-contracted downstream waves to see landed upstream files. No tools or Ledger event types change.
