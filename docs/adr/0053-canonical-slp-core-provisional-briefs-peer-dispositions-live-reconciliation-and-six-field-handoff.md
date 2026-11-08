# 0053 — Canonical SLP Core: Provisional Briefs, Four Peer Dispositions, Live Two-Way Reconciliation, and Mandatory Six-Field Handoff

- **Date:** 2026-11-08
- **Status:** Accepted
- **Amends:** [ADR 0005](0005-lead-duties-become-mechanisms.md), [ADR 0006](0006-supervisor-and-lead-seats.md), [ADR 0018](0018-lead-handoff-fuses-in-place-recontract-and-verdict-smart-defaults.md), [ADR 0029](0029-slp-serial-waves-challenge-signals-and-lead-hygiene.md), [ADR 0031](0031-single-active-peer-idempotent-claims-and-roster-binding.md), [ADR 0047](0047-lead-context-budget-hygiene-active-only-roster-and-peer-owned-skills.md), and [ADR 0048](0048-in-flight-wave-hardening-recurrence-guard-and-project-notebook.md).

## Context

In `paseo-factory`'s early history (`v0.0.1` / ADR 0005), no `Lead` agent existed, so the system modeled task assignment as an immutable, top-down `Contract` with a mute commit-only `Claim` (`{ task, commit }`). When `Lead` was introduced in ADR 0006 and expanded in subsequent ADRs, that rigid `Contract` machinery remained underneath:
1. Updating a `Contract` (`lead_set_contract`) automatically canceled and archived any live `Peer` session on that Task (`finishRetirement`), and `lead_repoke_agent` accepted no `message` argument—making live two-way `Lead ↔ Peer` dialogue and mid-flight premise reconciliation impossible.
2. `agent_claim` carried only `{ task, commit }`, stripping the canonical SLP **6-Field Handoff** (`Outcome`, `Snapshot`, `Scope`, `Verification`, `Unknown / risk`, `Ownership`) and leaving `Lead` blind to the `Peer`'s assumptions and skipped checks.
3. Every SLP `Peer` was forced into a commit-producing worker role, preventing `Lead` from dispatching read-only `Scout`, `Architect`, or `Reviewer` turns to investigate repository facts or settle boundary conflicts before briefing an `Engineer`.
4. `Peer` challenges (`agent_escalate_blocker`) immediately marked the Task `needs_human` and dual-broadcast to both `Lead` and `Supervisor`, while `src/roles-contract.ts` omitted `PEER.md`'s core laws (independent colleague judgment, provisional brief map, and `Contract Before Test` premise challenge) in favor of top-down obedience and bureaucratic `Recurrence Guard` prose.

## Decision

1. **Provisional Briefs & In-Place Live Peer Reconciliation (`resetPeer?: boolean`, `lead_repoke_agent.message`).**
   - In `slp` mode, `Contract.description` is a provisional, neutral **Brief** that states the bounded outcome, boundary contracts, exclusions, and verification without pre-solving implementation details.
   - Calling `lead_set_contract` on an unaccepted Task with a live `Peer` updates the Brief/Gate in place and **preserves the live `Peer` session** by default (`resetPeer: false`); the plugin cancels and archives the live `Peer` only when `resetPeer: true` is explicitly passed or when the Task is closed.
   - `lead_repoke_agent` accepts an optional `message: string` parameter so `Lead` delivers rulings, answers, and reconciled boundary decisions directly into the live `Peer` session.

2. **Immediate Peer Premise Challenge (`Contract Before Test`) & Lead-Owned Escalation Routing.**
   - `Peer` is an independent technical colleague. Before writing tests or code across a boundary, `Peer` verifies that the Brief's rulings hold against the repository and specification; if a premise conflicts with reality, `Peer` challenges `Lead` immediately via `REOPEN_REQUEST` (`foundation | dependency | lifecycle | API | ownership | verification`) or `DEPENDENCY_REQUEST` with evidence and at least one alternative direction rather than waiting for 3 failed attempts.
   - Calling `agent_escalate_blocker` keeps the `Peer` session alive and paused, and queues the challenge strictly to the `Lead mailbox` (`to: "lead"`) without recording a `needs_human` Ledger event or waking `Supervisor`. Only `Lead` (`lead_needs_human` / `lead_report_to_supervisor`) or exhausted mechanical ceilings (`attempt-ceiling`, `died-after-respawn`, `denied-again`) escalate to `Needs-human` / `Supervisor`.

3. **Four SLP Peer Dispositions (`scout | architect | engineer | reviewer`).**
   - `Contract` carries `disposition?: "engineer" | "architect" | "reviewer" | "scout"` (default `"engineer"`).
   - Read-only dispositions (`"scout" | "architect" | "reviewer"`) are fenced from modifying repository source files in the `Task worktree` (`read-only-disposition-fence`), may complete `agent_claim` with a 6-Field Handoff without a new git commit (`commit` optional), and close cleanly on `lead_accept_task` without merging a git branch.

4. **Mandatory Six-Field Handoff on `agent_claim`.**
   - `agent_claim` (and `factory-claim`) requires the structured Handoff fields (`outcome: "complete" | "partial" | "blocked" | "reopen"`, `scope`, `verification`, `unknowns`, plus `ownership` and `snapshot` synthesized from worktree/commit state) and rejects incomplete handoffs at the boundary.
   - The 6-Field Handoff is persisted in `report-<task>-<attempt>.md` and delivered verbatim in the `Verdict` notification to the `Lead mailbox`.

5. **Canonical Role Contracts (`src/roles-contract.ts`).**
   - Rewrite `src/roles-contract.ts` directly from canonical `Paseo Room` / `Codex Room` laws (`LEAD.md`, `PEER.md`, `02-bon-vai-supervisor-lead-peer.md`): neutral Supervisor framing + active SLP loop coaching, neutral Lead Briefs + Spec-vs-Code conflict ruling + 5 Reviewer triggers, and independent Peer colleague stance + `Contract Before Test`, while condensing `notebook.md` / `Recurrence Guard` instructions to a compact principle.
