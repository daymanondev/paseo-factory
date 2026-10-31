# 0038 — Scrum Owner waits and count-based work limits

- **Date:** 2026-10-31
- **Status:** Accepted — Owner confirmed all interview decisions on 2026-10-31. Implemented in v0.0.74.
- **Amends:** ADR 0032's elapsed-time admission limit and pre-start-only allowance changes. Preserves its verification, approval and immutable-history requirements.

## Context

The goal-planner run exhausted its cumulative elapsed-time budget before entering UI review. An overnight Owner review wait was excluded, but the next UX revision Task was refused against the already exhausted budget. Owner feedback is part of the delivery lifecycle, and model speed or the duration of useful work should not prevent a revision from proceeding.

## Decision

- Elapsed time is informational and must not block a Scrum run or admission of new work. This replaces the cumulative `maxElapsedMs` admission policy, rather than granting a fresh time allowance after each review.
- Work that continues to make progress may continue without a mandatory duration cutoff. Preserve count-based Task, Attempt, and automatic fix-round limits; preserve existing evidence-based stall and failure handling. Duration alone is not proof of a stall.
- An explicit wait for an Owner decision has no expiry due to Owner absence. This applies to UI review and other recorded requests for Owner input, not just overnight waits. A provider failure or unexplained Agent silence is not an Owner wait.
- UI approval remains an explicit Owner decision. A request for changes returns the same run to UX revision and subsequent review; accepted artifacts and prior decisions remain part of that run's history.
- The Task allowance remains cumulative across the run, including new UX revision Tasks. Reaching it produces a precise used/allowed explanation and permits an explicit Owner grant of additional Tasks in the same run. Lead cannot increase the allowance. Task, Attempt and automatic QA fix-round limits remain distinct.
- An Owner wait prevents only work dependent on the pending answer. Independent, already authorized work may continue; neither Lead nor Agents may infer the missing answer. UI-dependent Dev admission continues to require the recorded design decision and readiness evidence.
- Existing runs stop enforcing the legacy elapsed-time admission limit. Updating the plugin alone must not wake blocked runs. Recovery of goal-planner is an explicit recorded continuation in the same run: remove only its elapsed-time blocker, retain unrelated blockers and accepted history, restore the design stage when no other blocker prevents it, and wake Lead for a new UX revision Task.

### Explicit allowance grants

- The Owner may grant additional Task capacity in the same run. The control defaults to **+8 Tasks**, with an editable finite positive integer; it increases the existing allowance without resetting the used count.
- Additional automatic QA fix rounds require a separate Owner grant, **+1 round** at a time. A Task grant does not implicitly grant QA rounds or clear QA exhaustion.
- Preserve the existing per-Task Attempt ceiling and accepted Task immutability. An allowance grant cannot reopen a closed Task, delete its Attempts, or replenish repoke/respawn/handoff allowances.
- Record each grant's actor, amount and rationale. Mutations must use the existing serialized controller/journal path with request identity and revision checks; a repeated request cannot apply a grant twice. Lead cannot self-grant or infer a grant from an unrelated chat reply.
- Explain exhausted dimensions separately, with used/allowed counts and the corresponding Owner action on the Factory surface. A grant may resolve only the exhaustion it actually remedies; it must preserve unrelated blockers and dependent approval requirements.

### Durable Owner waits

- Present a **Waiting for you** list on the Factory surface. Each entry identifies the specific question or decision, the work dependent on it, and the available answer or cancellation actions. Supervisor relays and explains the same request in chat.
- Bind an answer to its pending request and record the resolution durably; vague agreement without a unique request context must not approve work. UI review retains the existing revision/digest-bound decision rather than becoming a generic question answer.
- Preserve pending requests through application/plugin restarts and handoffs. Owner absence alone causes neither expiry nor repeated prompting. Independent, already authorized work remains eligible, while work depending on an unresolved question stays held.
- Cancelling a request does not supply an answer or approve dependent work. That work requires a valid decision, an explicit scope change that removes the dependency, or explicit cancellation of the work.

## Compatibility and recovery

- Preserve historical elapsed-budget fields and events as history, but stop using them to admit or refuse Scrum work. This is not a time-budget top-up and does not reset any count-based allowance. New runs retain finite Task and QA limits, initially 24 Tasks and 2 automatic QA fix rounds unless the Owner chooses different supported values.
- Do not reinterpret timeouts for tool calls, transport, handoff, or existing evidence-based recovery as the retired run-age limit. Do not change SLP behavior or weaken readiness, browser evidence, QA or design approval gates.
- Recovery of an old generic `Task/time budget exhausted` blocker must establish the exhausted dimension from authoritative run state. A run still at its Task allowance must remain held for an explicit Task grant; do not blindly clear a combined diagnostic.
- After the implementation is released and installed through the supported plugin updater, explicitly continue goal-planner's `run-mvv6abcu-af3bc7f4` through the controller, preserving its Owner `changes_requested` decision and findings. Return eligible work to design and dispatch `ux-r02`; revised UX still requires Owner review before dependent development.

## Consequences

Run age remains visible information rather than an automatic spending ceiling. Bounded automation is governed by cumulative Task capacity, automatic QA rounds and existing per-Task recovery limits, which constrain repeated work more directly than model-dependent elapsed time. Removing the age limit does not introduce a monetary/token cap or claim that count limits bound financial cost.

Implementation and validation ship with v0.0.74. Installation and the explicit goal-planner continuation are recorded separately in the release validation evidence; this decision alone neither resumes a run nor supplies Owner approval.
