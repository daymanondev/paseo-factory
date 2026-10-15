# ADR 0006 — The seats are kept: a Supervisor converses for the Owner, a Lead presides over the work

- **Status:** Accepted — 2026-10-10 (ratified by Andrew over a four-round grill, incl. his reversal of the no-Supervisor topology)
- **Grounded in:** `research/slp-lead-fidelity.md` (the 14-duty fidelity table, 2026-10-10) · `research/lead-seat-wake-machinery.md` (both canonical repos read from code, live-fetched 2026-10-10) · `research/zcode-slp-feasibility.md` · the canonical repos themselves — `github.com/cuongntr/paseo-room` (v0.19.0) and `github.com/hoangnb24/codex-room-setup` (seatworks is demoted to doctrine-only history: buggy, closed by its author — Andrew, 2026-10-10)
- **Supersedes:** ADR 0005 — wholly.

## Decision

1. **The factory keeps SLP's seat topology whole**: Owner (the Human) ⇄ Supervisor ⇄ Lead ⇄ Agent. The product's differentiation is machinery UNDER the seats — Contract, Gate, Choke, Ledger, Watch, Fresh-eyes, Retro, Meter, the wake loop — which exists to make each seat cheap, never to replace a seat. The reference systems' owner burden was room plumbing (panel forms, install loops, permission parades), not the Supervisor conversation; the factory's machinery kills exactly the plumbing. Standing law: **reduce owner burden by mechanizing under the seats, not by removing seats.**

2. **The Supervisor seat (v0.0.9)** — ADR 0005's own delegation clause made real: the Owner seat delegated to exactly one agent, revocably, the only seat the Owner converses with. Day-one powers, every act a ledger line:
   - take the Owner's stated outcome, draft and set the Contract (delegated Owner act);
   - run the Driver;
   - relay status, verdicts and needs-human items to the Owner;
   - accept an Attempt on the Owner's word in the conversation.
   Never: landing/push (external effects stay on the human-delegate path), widening scope or budget, accepting without the Owner's word. codex-room canon, §9(a): "Supervisor observes, faithfully routes Human intent, and performs bounded room recovery. It is not another project Lead."

3. **The Lead seat (v0.0.10)** — the presiding technical seat over Agents. v1 is mechanical: an event-woken loop riding the Driver's existing ~5 s poll (graduation to a standing plugin loop is the announced path), holding exactly one authority at first — **one re-poke after a denial-stall**, idempotency-keyed, fixed and not configuration — plus the **needs-human** Ledger event, relayed to the Owner by the Supervisor. Ownership persists across runs: a live Contract is an owned Contract, and the Ledger is the seat's state (no new state file). Judgment (REOPEN / DEPENDENCY / BLOCKED rulings) grows into the same seat when the corpus demands it. End-state, paseo-room's own words: "Among agents, Lead alone accepts; Human retains override," and the Lead drafts Contracts the Owner ratifies. Acceptance phasing: day one the Supervisor accepts as delegated Owner on the Owner's word; when the Lead has earned judgment, acceptance-among-agents may pass to it with the Owner override kept; the Ledger always records who accepted.

4. **Escalation becomes real**: NEEDS-HUMAN / INCIDENT as new Ledger event kinds; the Supervisor is the relay to the Human — paseo-room's exact shape (marker line → deterministic triage → letter → Supervisor → Human). The Owner's own extension stands: stuck questions batch into a list answered at leisure; a block pauses only its own task while others continue (codex-room: "continue unrelated ready work"); an owner answer wakes the paused task. A Telegram channel into the same conversation is fog.

5. **Ladder**: v0.0.9 = the Supervisor seat (displaces 0.1.0 npm-public); v0.0.10 = the Lead v1 (loop + one re-poke + needs-human); then silence-timeout + respawn + attempt-ceiling as one row — the three need each other. Each entry still charted via `/wayfinder`.
   *(Amended 2026-10-13, ADR 0007: v0.0.11 = death-classification, inserted before the trio — its precondition, consuming the silence-timeout leg; the trio re-scopes to respawn + attempt-ceiling. Also amended: well-scoped rows run grill-first without `/wayfinder` — the Owner's ruling 2026-10-12; the map returns with genuine fog. Amended 2026-10-14, ADR 0008: v0.0.12 lands `respawn + attempt-ceiling` — `MAX_ATTEMPTS = 3` enforced plugin-side across `claim`/`requestSpawn`/Lead rider, plus one automatic `Respawn` per progress marker on `Substrate death`. Amended 2026-10-15, ADR 0009: v0.0.13 lands the `Factory surface` in Paseo (`index.client.tsx`, 3 tabs + 1-click Supervisor ensure-or-open bridge) and unified `Lane config` (`<stateDir>/lanes.json`) unlocking `Watch`, `Retro`, and `Fresh-eyes` onto tool-less CLI lanes alongside `Supervisor` and `Worker`. Amended 2026-10-15, ADR 0010: `Supervisor` and `Lead` become per-Project seats rooted at `<project-root>` (`cwd`), `Lead` graduates to a standing model-backed agent with its own `lead` lane and intermediate green-task acceptance (`accepted_by: "lead"`), and each `Task` runs in an isolated `Task worktree` landed locally on `Accept`.)*

6. **Substrate is a design-ticket choice, not a topology fact**: the seats may run as Paseo daemon agents (paseo-room's way) or as a ZCode session tree (feasibility measured in `research/zcode-slp-feasibility.md` — the hidden CLI spawns headless main sessions; the star law matches codex-room's own "Paseo owns exactly the supervisor/lead/peer topology").

## Why ADR 0005 falls, and what it keeps

- Its premise — "a Lead is something the Owner must prompt" — is contradicted by all three reference systems: the Human types the task once; ownership persists across turns and idle; the prompter is machinery (notifyOnFinish envelopes, attention letters, mail, heartbeats), and paseo-room built an entire deterministic attention subsystem precisely because events alone under-deliver. The ADR was right that a seat needs a prompter; wrong that the prompter must be the Owner.
- It drifted from its own table: the "Attempt cap per Task, set by the Owner — v0.0.4" row never shipped in code (verified 2026-10-10: the only `MAX_ATTEMPTS` are the watch/retro retry constants).
- Carried forward: mechanize where deterministic (the seats inherit the mechanisms as instruments); landing to main stays a human act; acceptance is judgment, green is evidence; the unattended-loop preconditions.
- Canonical validation for the Lead's mechanical v1: paseo-room removed its own LLM attention sensor in 0.15.0 after a 550-turn shadow trial — "no model ranks a Lead turn."
- Honest deviations from canon, recorded as deviations: respawn and the attempt ceiling have no precedent in either canonical repo (factory-original); propose-accept as a queued recommendation is factory-native.

## Consequences

- CONTEXT.md: the words Supervisor and Lead stop being banned (the Owner and Driver Avoid lines change with this ADR); full term entries land with each seat's design ticket and are verified at close-out — the v0.0.8 pattern.
- The runbook's delegation convention (step 9) points at the Supervisor for factory-side acts.
- The "waking/escalation out of scope" line standing since v0.0.6 resolves: the channel is the Supervisor relay.
- Watch, Fresh-eyes and Meter stay record-only; the seats become their readers — the Lead reads nothing in v1; judgment does, later.
- Cost posture: the Supervisor is a model lane (spend per turn, metered at its first live run); the Lead v1 spends zero model calls.
- Opened for design tickets: substrate, the Supervisor's wake sources, the Supervisor's own succession.
