# ADR 0007 — Death is read from the daemon timeline; the null fetch carries no meaning

- **Status:** Accepted — 2026-10-13 (ratified by Andrew over a two-round grill, all-recommended; word "chốt")
- **Grounded in:** the read-only RPC probe of 2026-10-13 against the trial daemon (0.11, home `~/.paseo-factory`; script preserved at `.scratch/factory-v0.0.11/timeline-probe.mjs`) · v0.0.10 ticket 04's grade-A witnesses (live10-domaintree: false-terminal meter seq 1422 landed ~2 s before the true claim 1423, work span 8.7 s past the bound; v0.0.9 live09-readme2: claim +343 s past the false death) · `plugin/bin/driver.mjs` (the null lane, `postSpawnLife`, `stallWatch`'s existing timeline fetch)

## Decision

1. **The null `fetch_agent` answer is an empty signal.** The probe: `fetch_agent_request` answered `agent: null` for a closed agent (`de972395…`), an idle agent (`723e08da…`, the live Supervisor), and a never-existed UUID — three different truths, one indistinguishable answer. The driver stops drawing any conclusion from nullity alone; the v0.0.10 reading of null as an "unready window" was too generous — on 0.11's session socket the null regime is total.

2. **`fetch_agent_timeline_request` is the death oracle.** An rpc_error `"Agent not found"` means the agent is gone — the answer came back exact for the bogus UUID and for nothing else in the probe. An answering timeline means the agent exists, and its `seqEnd` growth is the life signal.
   *(Corrected 2026-10-14, ticket 04: the live envelope is a RESOLVED `fetch_agent_timeline_response` carrying an `error` field — not an rpc_error envelope as this section first recorded. The 2026-10-13 probe's ERROR print was its payload-error branch, and the judged run's arm B witnessed the resolved shape live: `paseo agent delete` mid-run, the timeline answering `"Agent not found: <id>"` as a payload, the ticket-02 build folding it into `maxSeqEnd` as no-growth — the fast door unreachable, every true fast-door death landing 120 s late misnamed as the slow door. The law is unchanged — the timeline's own not-found answer is the fast door — the driver now folds the resolved `error` field into the thrown shape at `fetchTimeline` (the snapshot lane's own `payload.error` pattern), and the tests pin the payload seam. Also closed: the open fact below — the timeline answers a mid-running-turn agent, witnessed by arm A's 400 s survival and arm B's pre-delete growth ticks.)*

3. **Death has two doors, both read from the timeline.** The fast door: the timeline errors "Agent not found". The slow door: the timeline answers but `seqEnd` has not grown for the bound. `AGENT_MISSING_DEAD_MS` (120 s, fixed in code, never configuration) changes meaning — from "zero post-spawn ledger life under nulls" to "zero timeline growth" — because healthy ask-less work streams timeline items continuously (both witnesses), the bound now measures true stillness.

4. **The ledger keeps its witnessed roles.** The null lane's finish signal stays the ledger predicate (the v0.0.10 runbook arc: verdict read from the ledger while the snapshot lane stayed null). `postSpawnLife` is demoted from death gate to defense-in-depth: a timeline not-found contradicted by post-spawn ledger life is a state the watch survives on the ledger predicate, not a death.

## Considered options (rejected, worth remembering)

- **Raise the 120 s bound:** kicks the can — readme2 (+343 s of healthy work past the false death) proves no safe ledger-clock bound exists; a bound large enough to spare healthy work is large enough to hang true death.
- **Never classify death from null:** loses the bounded decision — spawn-then-silence (36/57 of the corpus) would hang the unattended loop forever.
- **Ledger-purity (death from ledger facts only):** impossible on ask-less lanes — the ledger is honestly empty between spawn and Claim there; the daemon timeline is the only carrier of mid-work evidence. This is the real trade-off the ADR records: death leaves the ledger's clock and reads the daemon's record.

## Consequences

- ADR 0006 §5's ladder is amended (same day): death-classification enters before the trio and consumes its silence-timeout leg; the trio re-scopes to respawn + attempt-ceiling.
- CONTEXT.md gains **Substrate death** and **Life signal**.
- The fix lives in `plugin/bin/driver.mjs` only — the pure core stays daemon-blind (ADR 0004).
- Meter-at-death stays by design for real deaths; the false-terminal meter class disappears with the false deaths themselves.
- Open fact (grade B, witnessed at the row's live run): the timeline RPC's answer mid-running-turn — today's probe reached closed and idle agents only (both answer); the running-state code path already exists in `stallWatch`.
