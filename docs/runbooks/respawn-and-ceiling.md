# Runbook — reading Respawn and Attempt-ceiling events

Since v0.0.12 (ADR 0008) the Driver stays watching across red Attempts below
the ceiling and executes at most one automatic Respawn on Substrate death.
This is how the operator reads those events in the ledger and `factory status`.

## Automatic Respawn

When an agent's machinery dies (ADR 0007's two doors) and the task is neither
green nor at the ceiling, the Driver submits the dead agent's meter, cleans
uncommitted half-writes to `HEAD` (committed SHAs on the task branch are
preserved), and requests one Respawn through the spool. The plugin validates it
— at most one per progress marker (the latest `spawn_dispatched` or
`gate_finished`) — and appends `respawn_dispatched` (naming `died_agent`) or
`respawn_refused` before the replacement agent is created. A second death with
no new progress after the spent Respawn is not re-spawned: the task ends in
`needs_human` with `reason: "died-after-respawn"`.

## Attempt ceiling

`MAX_ATTEMPTS = 3`, fixed in code, never configuration. Enforcement is
structural on every surface: a fourth Claim is refused before any Gate starts;
a Spawn at the ceiling writes `spawn_refused` (`spawn:attempt-ceiling`); a
Respawn likewise. When Attempt 3 finishes red, the Lead rider ends the task
immediately in `needs_human` (`reason: "attempt-ceiling"`). A red below the
ceiling is not an ending — the live agent reads the red note, commits a fix,
and claims again.

## Reading the ledger

    tail -f ~/.paseo-factory/plugin-state/paseo-factory/ledger.jsonl

`respawn_dispatched` lines carry `died_agent`; every `needs_human` carries its
reason and evidence seqs. On a red, read the cited `gate_finished` event's full
`outputPath` before blaming the agent — notes are capped tails. A task at
`needs_human` waits for the Owner's word, which wakes it through the ordinary
spawn path; only Acceptance closes it.
