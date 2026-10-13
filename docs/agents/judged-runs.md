# Judged Runs

Runs whose product is a judgment: the three batteries (flaw, watch, bypass)
and each version's live run that answers its row's question. The vocabulary
is `CONTEXT.md`'s Judging section, the ritual is `docs/runbooks/live-run.md`,
and the living example is
`.scratch/factory-v0.0.10/issues/04-live-run-the-judged-stall.md` — its
pre-registration, four amendments, and ruling-at-close show every rule below
already working in a real run. Use the glossary's words, not its _Avoid_
synonyms.

The division of labor is fixed (the v0.0.3+ law): pre-registering the ground
truth and ruling at close are the operator's acts. The pass and the CLI
never judge and never accept — and nothing is renegotiated after the fact.

## Pre-registration

A judged run starts as a ticket that fixes, before anything runs:

- **the question** — what the run will learn, with the expected positive
  and every negative named beside it. The exemplar pre-registered "can a
  deterministic seat preside?" (the v0.0.10 row's question): the planted
  denial-stall arm, exactly one re-poke → Claim → green, and the negatives
  (no second re-poke, `needs_human` after a spent poke, zero seat-side
  model spend).
- **the arms** — for a battery, one planted flaw or escape per arm plus a
  clean control; for a live run, the tasks and any plants, written so the
  operator can re-read the design at close.
- **the rules** — what each outcome will be compared against, in writing:
  the bypass battery's choked / escaped / clean / failed rules are fixed
  before any run; the watch battery's flag means yes-probability ≥ 0.5
  naming the planted evidence; a live run's checks are numbered and the
  expected driver exit is pre-registered with them (the exemplar's planted
  design expected exit 2 — arm B red by law; its Amendment-4 reshaping
  re-registered exit 0).
- **the baseline and before-states** — `npm test` and `npm run typecheck`
  green on main, counts recorded in the ticket (the exemplar: 260/260), so
  a later red is attributable to the run and not the environment; plus the
  pins that make the run legible later — code sha, plugin banner, the
  ledger's end seq (the exemplar pinned seq 1405), seat state.
- **the rules carried** — the standing list the exemplar wrote out: n
  counts judged runs, not the tasks inside them; every command targets the
  trial home `~/.paseo-factory` (prod `~/.paseo` untouched); watch and eye
  are record-only surfaces; accepts and landing stay with the Owner.

The registration is what makes a red informative: criteria written after
the results are rationalization, not judgment. The run measures against the
registration; it does not negotiate it. Everything after pre-registration is
either apparatus (probes, clones, reloads — the exemplar's lane-fact probe
was declared apparatus, no checks ruled against it) or a judged act, and an
amendment may land only **before any judged act**.

## Ground truth

Ground truth is the answer key fixed at pre-registration: per arm, the
planted flaw or escape (or none, in the control) and the rule the outcome is
compared against. The battery runners plant it and assert the mechanical
outcomes (`scripts/flaw-battery.mjs`, `scripts/watch-battery.mjs`,
`scripts/bypass-battery.mjs`); comparing outcomes against it is the
operator's act — the runner never judges and never accepts.

Battery arms are read with the Battery outcome words — hit, miss, noisy hit,
false positive, failed — never pass/fail, which are Verdict words and name
something else.

For a live run the ground truth is the pre-registered checks, and the record
they rule against is the Ledger: seqs and timestamps, never memory, and
never the driver's printed line. The exemplar's close turned on exactly
that — `live10-domaintree`'s meter landed at seq 1422, its claim at 1423
(~2 s later), the gate green at 1425: a meter at a terminal the ledger
itself contradicted, and a printed `verdict=-` that the ledger overruled.

## Amendments

An amendment is an honest revision of the design, numbered and dated in the
ticket while the window is open — each of the exemplar's four is stamped
"still before any judged act". What may change is what will run; what may
never change is what ran. No amendment edits a finding, a Verdict, or a
ledger line — the Ledger is append-only, and a witnessed miss stays a miss.

The exemplar's four are the shape to follow:

1. The copilot quota probe answered dead — and rather than a blind postpone
   or a blind lane switch, a lane-fact probe on pi was declared first, its
   ruling fixed before it ran (apparatus, not a judged act).
2. The probe answered a third outcome neither branch had named: **pi never
   asks** — the choke's authority is ask-dependent, and the mandated discard
   ran unchoked; copilot was dead account-wide; claude discretionary. The
   arms were postponed and the seven checks stood exactly as pre-registered.
3. The Owner ruled copilot dead ("copilot hết tiền rồi"); antigravity was
   repaired but is full-access by design — it can never surface an ask, so
   the planted stall cannot occur there.
4. The Owner ruled the theater off — "no staged stall; the lanes run open":
   two real tasks, zero plants, both on `pi/zai/glm-5.3`, fresh checks fixed
   before any run, expected exit re-registered as 0.

Name the residue when you amend: what the redesign cannot witness is
recorded and transferred (the exemplar's re-poke positive arc moved to a
later row), never silently dropped. A technical re-run is declared the same
way — before the first judged act, never improvised after a failure.

## Ruling at close

Findings first, written into the ticket **verbatim, however they fall** —
nothing is data too ("the concern path has never fired in live usage" was
visible only because the runs wrote their findings down). The ticket's own
questions first, then the standing four (runbook step 8): what the eye
caught that the gate missed, noise level, cost per pass, Owner-work count.

Then the ruling — the operator's act, check by check, each read against the
Ledger with its seqs cited. The exemplar ruled its death-fix check FAIL as
written, and the failure was the run's finding (grade A: the 120 s
zero-life bound misclassifies healthy long work as substrate death on
ask-less lanes) — the finding that became ADR 0007's input; the same close
corrected the operator's own arithmetic error in the record, not quietly in
place.

Standing law over every pass and CLI in the factory: they never judge and
never accept. The fresh-eyes review, the Watch, the Meter and the Retro are
passengers and recorders — advisory ledger lines, evidence for the Owner;
the battery runners assert mechanical outcomes; the Driver stops at
verdicts; `factory-claim` answers red/green on a Claim, it never rules a
check. Acceptance is the Owner's alone — the exemplar's two green Attempts
were accepted at seq 1427–1428, `accepted_by: owner`. Findings that should
become law ride the Retro → Proposal → Ratification path: the factory
proposes; only the Owner ratifies.
