# 0058 — A Peer's Task Closes Only on an Outcome, Never on Idle

- **Date:** 2026-11-14
- **Status:** Accepted. The Owner approved the four-point fix ("làm đi"). Implemented in v0.8.5.
- **Amends:** [ADR 0050](0050-pause-aware-quiet-point-handoff-loud-degraded-completion-and-rolehome-skill-deny.md) Decision 1: the paused-Peer hold now survives the driver, and it also covers a red Attempt. The driver's finish classifier (ticket 03 §5): `idle` is no longer a finish signal on its own.

## Context

A live run on goal-partner, 2026-11-14:

1. The Lead crossed its 160k mark and went to `rotation_pending`, waiting for a quiet point.
2. The Owner pressed Esc on the running Peer so the plugin could be updated.
3. The driver saw the Peer `idle`, with the prompt consumed and nothing pending. It classed the Peer as finished, metered it, and archived it. The spool's meter handler archived it too.
4. With the Peer archived, the quiet-point check no longer saw a live Peer on the open spawn round, so the Lead handoff began.

The Peer had not claimed. Its Task was still running, but no Peer owned it any more, and the Lead and its successor went on as if the wave had ended.

The [paseo-room](https://github.com/cuongntr/paseo-room) model closes an assignment only by an explicit act. It archives a Peer only on close or on a binding refusal. Its succession preflight blocks while `assignments_open`.

## Decision

1. **`idle` is not an outcome.** The driver treats an idle Peer as finished only when the Ledger shows a Peer-terminal fact since the run's latest spawn, respawn or re-contract:
   - a green gate,
   - `needs_human`,
   - `attempt_accepted`, or
   - `task_closed`.

   Otherwise it holds the Peer: no meter, no archive, keep watching. An Esc'd Peer stays live and resumable. The hold ends on any of these:
   - **The Peer is archived.** A re-spawn, a reset re-contract and a close each retire the Peer. The driver reads the archive as `closed`.
   - **A newer spawn or respawn appears for the task.** The watch is superseded. It ends without a respawn.
2. **A dispatched Task holds the Lead's quiet point while its Peer is alive.** A Task is dispatched when it is `running`, or `red` below the attempt ceiling. While its bound Peer is live and not in `error`, the Lead does not hand off, whatever the Peer's status: idle after Esc, between turns, or after a red Attempt.
   - The in-process "interrupted" marker is gone. The rule reads only the Ledger, `mailbox.jsonl` and the live daemon, so it survives restarts.
   - A queued Peer mail or a dead or archived Peer still releases the hold. This keeps ADR 0050's anti-deadlock law.
3. **A turn that ends without a Claim gets one nudge, then goes to the Lead.**
   - A Peer turn that ends `completed` while its dispatched Task is unclaimed gets one nudge per Ledger state: continue and `agent_claim`, or `agent_escalate_blocker`.
   - A second unclaimed turn with no new Ledger fact goes to the Lead as a single `report` mail.
   - A `canceled` turn (the Owner's Esc) is never nudged.
   - No nudge is sent in these cases:
     - while a gate runs;
     - after a permit denial, because the driver's re-poke owns it;
     - during a Peer context handoff;
     - while a Peer escalation newer than the Task's last Ledger fact waits for the Lead.
4. **Automatic Lead handoff at 160k still happens, but only at a true quiet point.** Every dispatched Task must be settled or have no live Peer. The Owner's **Hand off now** / **Replace now** remain the escape hatch.

## Consequences

- Pausing a Peer is safe: nothing is metered, archived or handed off behind it, and the Owner can resume it in place.
- A Peer that idles forever after a nudge holds the Lead's automatic handoff until the Lead acts on the report, or the Owner hands off manually. This is deliberate: an open assignment is the Lead's to resolve, not something to dissolve silently.
- The `factory run` driver process lives as long as the held Peer. It polls every 5 s and does no other work.
