# 0060 — Rotate Seats: The One Explicit No-Handover Replacement

- **Date:** 2026-11-14
- **Status:** Accepted. The Owner approved the spec; implemented on `spec/factory-rotate-seats`, ships in the next release.
- **Amends:** [ADR 0057](0057-every-seat-replacement-is-a-handoff-supervisor-handoff-and-wide-colourful-factory-tab.md) Decision 1. The rule "every seat replacement is a handoff" and the removal of "every retire-seat path that archives without a handover" gain one explicit, Owner-only exception.
- **Spec:** `.scratch/factory-rotate-seats/spec.md`.

## Context

ADR 0057 Decision 1 removed the old Rotate button because the Owner then replaced seats only when they were failing mid-work, and a handover is what that case needs. The long-idle Project is a different case. The Owner comes back after a long break and wants the old Supervisor and Lead gone and the next seats to start clean. Every way to replace them today passes the old context forward:

- **Hand off now** extracts a handover from the outgoing seat.
- **Replace now** skips extraction, but the successor still gets a plugin-built Substitute handover.
- **Archiving the Lead from outside** triggers lost-Lead recovery, which recreates the Lead with a Substitute handover.
- **Project reset** drops the seats, but it also wipes the Ledger, the notebook and the worktrees and resets the repository. That is far too destructive for "start the seats over".

## Decision

1. **Rotate seats is a new Owner-only Project act.** One action retires a Project's Supervisor and Lead together, with no extraction and no Substitute handover. It is the single exception to ADR 0057 Decision 1. Rotating one seat alone is not offered.
2. **It refuses while a live Peer exists.** The server refuses with `peers-live` when any live, non-`error` Peer is bound to an unsettled Task of the Project. This is the same predicate that holds the Lead's quiet point (v0.8.5, ADR 0058), now shared in `plugin/server/peer-in-flight.ts` rather than re-implemented. An idle or paused Peer counts. The refusal names the Task ids and agent ids and changes nothing: no seat archived, no file deleted. Open Tasks with no live Peer are fine and stay in the Ledger.
3. **Retire order is mail, Lead, Supervisor, records.**
   1. Clear the Project's queued mail and handoff runtime state first (`resetProjectMailbox`) and drop the on-disk records, so a concurrent mailbox pump finds nothing to deliver and cannot recreate a Lead mid-rotation.
   2. Retire the **Lead first, then the Supervisor**, through the existing marked-archive path (`retireSeat`). Every archive is marked as the plugin's own (ADR 0057 Decision 4), so lost-Lead recovery never fires. Lead first means a pre-v0.6.1 Supervisor with a still-parented Lead is archived, not merely "released". A released Supervisor waiting on the Lead is archived with it.
   3. Drop the records again, because the Lead's retire requeues its un-acked batch into the mailbox file. Then clear the registration's seat and handoff fields.
   4. A Project with no bound seat succeeds and says nothing was archived.
4. **What is dropped and what is kept.**
   - Dropped: `mailbox.jsonl` (held and un-acknowledged mail), `lead-handoff.md`, `lead-handoff-extraction.json`, `supervisor-handoff.md`, `supervisor-handoff-extraction.json`, both handoff progress records, and the registration's `supervisor`, `lead`, `releasedSupervisors`, `rotationState` and `handoffRequestedAt`. An in-flight handoff (scheduled, handing over, creating successor) is cancelled with them, and a half-created successor is archived as a live seat candidate.
   - Kept: the Project notebook, `lanes.json`, the Ledger and its open Tasks, `usage.json` (the retire flushes the seats' final usage first), Task worktrees and workspaces, and the registration itself (`root`, `workspaceId`, `paseoProjectId`, `taskWorkspaces`, `dispatchers`). Rotate never calls the Project cleanup that archives Peers and deletes worktrees.
5. **Nothing restarts by itself.** Afterwards the Project has no Supervisor and no Lead (ADR 0057 Decision 5 is unchanged). The Owner opens a New Chat with the `Supervisor (Factory)` profile at the Project root, which binds fresh. That Supervisor's first dispatch creates a fresh Lead whose Turn-1 packet carries the standard kickoff (repository facts, Ledger task summary, notebook) and no handover and no staleness notice. The reply names this next step.
6. **Contract and lane.** The act is the RPC `factory.project.rotate` (`input: { projectRoot?, project? }`; ok output `{ project, projectRoot, archivedSeats, summary, view? }`; failures `unknown-project`, `ambiguous-project`, `peers-live`, and the seat retire failures). It resolves the Project with the same block as Project reset, now extracted as one helper. It runs under the target Project's exclusive-maintenance lane, so it cannot interleave with reset, delete or register of that Project. The Spool kind, CLI verb and menu item are specified in the spec and follow this decision; they only wrap the handler. Stamped seats are refused (`seat-cannot-rotate`).

## Consequences

- The Owner has a non-destructive "start the seats over" for a returning Project. The only other path that drops seats without a handover is Project reset, which also wipes history.
- ADR 0057's "no retire-seat path without a handover" now reads "none except Rotate seats". Hand off now and Replace now are unchanged and remain the right tools for a failing seat mid-work.
- Open Tasks that had a Peer are refused, not closed. The Owner must let the Peer finish or close the Task first. A future ticket could offer to close them as part of the act.
- The clear-first order narrows but does not remove the race with a pump already running before the act began. A pump that had already ensured a Lead is caught by the retire, which archives every live Lead candidate, not just the bound id.
- The Peer-in-flight predicate now has two callers (the Lead-mailbox quiet point and the Rotate refusal) and one definition.
