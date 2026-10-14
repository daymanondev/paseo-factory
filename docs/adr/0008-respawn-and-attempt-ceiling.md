# ADR 0008 — Respawn once on substrate death; three attempts cap a task

- **Status:** Accepted — 2026-10-14 (ratified by Andrew over a two-round `/grill-with-docs`, all-recommended; words "toàn bộ theo khuyến nghị của bạn" / "theo bạn khuyến nghị")
- **Grounded in:** ADR 0006 §3–§5 (`respawn + attempt-ceiling` as the ladder row after `death-classification`) · ADR 0007 (the two-door timeline death oracle witnessed live in v0.0.11) · `plugin/bin/driver.mjs` (`continueOnLedger`, `verdictOfThisRun`, `createTaskAgent`, `observeTasks`) · `src/factory.ts` (`claim`, `requestSpawn`, `repoke`, `needsHuman`)
- **Amends:** ADR 0006 §3–§5 (adds the respawn and attempt-ceiling authorities to the Lead/Driver loop and extends `needs_human`) · ADR 0007 §4 (the null-lane verdict continuation finishes immediately only on a `green` verdict; a `red` verdict below the ceiling stays in the watch)

## Decision

1. **Attempt ceiling (`MAX_ATTEMPTS = 3`, fixed in code, never configuration).** A contracted Task may open at most **three** Attempts. Enforcement is structural and plugin-side across all three surfaces:
   - **`Factory.claim`:** After checking `attemptIsOpen`, if `maxAttempt(history) >= 3`, `claim` throws `FactoryError("attempt-ceiling", ...)` before writing `claim_reported` or `gate_started`. No fourth Attempt can ever open.
   - **`Factory.requestSpawn`:** After checking `already-accepted`, if `maxAttempt(history) >= 3` (with no green Attempt), `requestSpawn` appends `spawn_refused` with `code: "attempt-ceiling"`, `rule: "spawn:attempt-ceiling"`.
   - **The Lead rider (`leadDecision`):** When the Task's latest `gate_finished` is `red` at `attempt >= 3`, no further Attempt is legal; the predicate immediately returns `{ act: "needs-human", reason: "attempt-ceiling", evidence: { attempt, gate } }`, writing `needs_human` and ending the watch (`fate: "needs-human"`).

2. **Named enabling fix on the null-fetch lane (`continueOnLedger`).** In v0.0.10–v0.0.11, `continueOnLedger` committed `fate: "finished"` whenever `verdictOfThisRun` returned *any* `gate_finished` after the run's spawn — cutting the watch within 5 s of a `red` Attempt 1 on daemon 0.11 while the live Agent was still in its turn fixing the code for Attempt 2. Under this ADR:
   - `verdictOfThisRun` (and `lastSpawnSeq`) anchors on the task's latest dispatch event (`spawn_dispatched` or `respawn_dispatched`).
   - `continueOnLedger` commits `fate: "finished"` immediately **only when `verdict.verdict === "green"`**. When `verdict.verdict === "red"` and `verdict.attempt < 3`, the watch stays open so the live Agent can read the red note, commit a fix, and call `factory-claim` for the next Attempt (while the timeline death oracle continues to guard against post-gate death). When `verdict.attempt >= 3` and `verdict.verdict === "red"`, `runLead` intercepts first and ends the task in `needs_human (attempt-ceiling)`.

3. **Automatic Respawn on `Substrate death` (at most one per progress marker, fixed in code).** When `observeTasks` classifies a `Substrate death` (the snapshot lane's `error` status, or the null lane's Fast door / Slow door from ADR 0007) and the Task is neither `green` nor at `attempt-ceiling`:
   - **Plugin-side authority (`Factory.respawn`, spool kind `"respawn"`):** Mirrors `requestSpawn` and `repoke`. Validates `task`, `provider`, and `died_agent` (non-empty string naming the dead agent id), refuses unknown or accepted tasks or tasks at `attempt-ceiling`, and enforces the **one-respawn-per-progress-marker law**: if the task's history already carries a `respawn_dispatched` whose `seq` is greater than the latest progress marker (`spawn_dispatched` or `gate_finished`), `Factory.respawn` refuses with `code: "respawn-ceiling"`, `rule: "respawn:already-spent"`, appending `respawn_refused`. Otherwise it appends `respawn_dispatched` (`{ event: "respawn_dispatched", task, provider, died_agent }`).
   - **Metering and worktree hygiene before handoff:** At the dead Agent's death classification, the Driver first submits the dead Agent's `meter` (`submitMeter` with the dead `agentId` and its captured/empty usage, preserving ADR 0007's meter-at-death invariant). Before creating the replacement Agent on branch `<task>`, the Driver cleans uncommitted half-writes in the workspace (`git checkout -- . && git clean -fd`), preserving every committed SHA on `<task>` while ensuring the replacement Agent starts on a clean tree at `<task>`'s `HEAD`.
   - **Per-dispatch `idempotencyKey` on `agent.create.request`:** `createTaskAgent` keys the daemon creation RPC by the dispatch event's ledger `seq` (`${task}-spawn-${seq}` / `${task}-respawn-${seq}`) rather than bare `task`, preventing a Slow-door or error-state dead agent still resident in the daemon DB from colliding with or short-circuiting the replacement Agent's creation while keeping crash-retries of the same dispatch idempotent.
   - **Second death ends in `needs_human ("died-after-respawn")`:** If a Task suffers `Substrate death` when a `respawn_dispatched` has already been spent since the latest `spawn_dispatched` / `gate_finished`, the Driver does not request another respawn; it submits `needs_human` with `reason: "died-after-respawn"` and `evidence: { spawn: spawnSeq, respawn: respawnSeq }`, then commits `fate: "needs-human"`.

4. **Expanded `NeedsHuman` vocabulary with per-reason ledger corroboration.** `NEEDS_HUMAN_REASONS` expands from two reasons to four, each corroborated against the Task's ledger slice by `Factory.needsHuman`:
   - `"denied-again" | "silent-after-repoke"` → `evidence: { denial: number, repoke: number }` (unchanged from v0.0.10: corroborates `permit_denied` at `denial` and latest `repoke_dispatched` at `repoke`).
   - `"attempt-ceiling"` → `evidence: { attempt: number, gate: number }` (corroborates `attempt === 3` and a `gate_finished` event at `seq === gate` with `attempt === 3` and `verdict === "red"`).
   - `"died-after-respawn"` → `evidence: { spawn: number, respawn: number }` (corroborates `spawn_dispatched` at `seq === spawn` and the latest `respawn_dispatched` at `seq === respawn` with `respawn > spawn` and no newer `gate_finished` after `respawn`).

## Considered options (rejected, worth remembering)

- **Configurable per-Contract `maxAttempts` / `maxRespawns`:** Rejected in Round 1 (Q4). Matches the precedent of `GRACE_MS`, `RE_STALL_MS`, and `ZERO_GROWTH_DEAD_MS`: fixed constants in code until live corpus evidence demands per-contract variation.
- **Overloading `spawn_dispatched` for mid-watch Respawn:** Rejected in Round 2 (Q6). A dedicated `respawn_dispatched` / `respawn_refused` pair keeps CLI re-runs (`spawn_dispatched`) distinct from mid-watch automatic death recovery, records `died_agent` on the ledger line, and lets the plugin enforce the one-respawn ceiling structurally.
- **Leaving dirty uncommitted worktree edits for the respawned Agent:** Rejected in Round 2 (Q6). An Agent that dies mid-turn may leave half-written syntax errors; resetting uncommitted working-tree state to `HEAD` (`git checkout -- . && git clean -fd`) preserves any completed commits on branch `<task>` while giving the respawned Agent a clean starting tree.

## Consequences

- `CONTEXT.md` gains **Attempt ceiling** and **Respawn** under `### Running`, and updates **Driver**, **Lead**, and **Needs-human**.
- The Driver's header law `"No respawn, ever"` (standing since v0.0.5) retires in favor of bounded one-respawn recovery on `Substrate death`.
- Live multi-attempt self-repair (`Attempt 1 red → fix → Attempt 2 green` or `Attempt 1–3 red → needs_human`) now works on daemon 0.11's null-fetch lane (`pi`, `antigravity`).
