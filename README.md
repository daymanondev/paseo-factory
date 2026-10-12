# paseo-factory

A verification line for coding agents, delivered as a [Paseo](https://paseo.sh) plugin.

The repo is `paseo-slp-factory`; the plugin/package name is `paseo-factory` (the
divergence is accepted — see ADR 0001).

Work is judged against criteria fixed before it starts: the **Owner** sets a
Contract (one gate command, one artifact), the **Agent** does the work and
claims the task is finished at a specific commit, and the factory — never the
agent — runs the gate and records every step in an append-only ledger it
cannot edit. A green verdict is evidence, not acceptance.

**Status: v0.0.9, pre-release.** The pure verification core is complete and
tested (247 tests); the plugin loads on a Paseo 0.10 daemon, owns the ledger
and the gate as the single writer (ADR 0004), and serves the whole loop over a
file spool: the Owner's `factory` CLI sets Contracts and accepts green
Attempts, the Agent's `factory-claim` CLI submits Claims (it rides every
agent's PATH), and each Claim opens a numbered Attempt that ends in a Verdict
and a per-attempt report — proven end-to-end against a live trial daemon by
`scripts/smoke-loop.mjs`. Since that first wiring the loop has gained the
driver (`factory run`), the record-only watch, the on-demand Retro, the Cost
read backed by the Meter, and v0.0.9 opens the seat layer (ADR 0006): the
Supervisor seat — the delegated Owner conversation, every act stamped by who
submitted it. Nothing is published yet.

## Layout

- `src/` — the pure core: contracts, JSONL ledger, gate runner, report. Zero
  Paseo imports, zero runtime deps, Node ≥ 22.18.
- `plugin/` — the Paseo plugin shell (`paseo-plugin.json`, server entry,
  `server/spool.ts` for the submit protocol, `bin/` for the CLIs). The daemon's
  plugin compiler refuses imports outside the plugin directory, so
  `plugin/server/core/` is a vendored copy of `src/`, kept byte-exact by
  `npm run sync:plugin-core` (a test fails if the copy drifts).
- `test/`, `fixtures/` — tests for core, shell, spool, and CLIs.
- `docs/adr/` — decision records; `CONTEXT.md` — the domain language.

## Develop

```sh
npm install
npm run typecheck
npm test
```

Edit the core in `src/`, then run `npm run sync:plugin-core` and commit both.

## Run the loop on a trial daemon

Use a dedicated daemon home — never the default `~/.paseo`:

```sh
paseo daemon start --home ~/.paseo-factory          # any 0.10.x daemon
paseo plugin install "$(pwd)/plugin" --home ~/.paseo-factory
paseo plugin ls --home ~/.paseo-factory             # expect: running
```

The **Owner** (you, from this repo) fixes the Workspace in a Contract and later
accepts a green Attempt:

```sh
npm run factory -- --home ~/.paseo-factory contract \
  --task T1 --workspace /path/to/repo --gate "npm test" --artifact src/x.ts
npm run factory -- --home ~/.paseo-factory accept T1 --attempt 2
```

The rest of the Owner surface: `run` (the driver, v0.0.5) takes one or more
contracted task ids plus `--provider <p[/m]>` — per task it cuts the branch
named after the task, spawns one agent through the spool, and watches to the
verdict, exiting 0 only when every task ended green with zero refusals. And
the read side: `status` prints one line per task (attempts, last verdict,
attested sha, accepted, choke counts), `cost` prints the Cost read over the
whole ledger — one row per task plus per-lane totals — and both are local
reads that need no running plugin:

```sh
npm run factory -- --home ~/.paseo-factory run T1 --provider claude/sonnet-5
npm run factory -- --home ~/.paseo-factory status
npm run factory -- --home ~/.paseo-factory cost
npm run factory -- --home ~/.paseo-factory retro
```

`retro` (v0.0.7) is the Owner's on-demand pass: it distills the whole ledger
into a per-task digest and hands it to a fresh-context model whose one job is
to *propose* — new Gate checks for repeated-error patterns, draft Contract
pieces for knowledge holes, every proposal citing its ledger seq — writing
one `retro_written` line and a dated proposals file. Nothing becomes law
until the Owner ratifies it as ordinary repo work.

Since v0.0.9 those Owner acts may arrive through a conversation instead of a
terminal. The **Supervisor seat** (ADR 0006) is the Owner seat delegated to
exactly one Paseo daemon agent, revocably — the only seat the Owner
converses with. Day-one powers, every act a ledger line: take the Owner's
stated outcome and draft + set the Contract, run the Driver, relay status
and verdicts in words, accept an Attempt on the Owner's word in the
conversation. Never: landing or push, widening scope or budget, accepting
without the Owner's word — it is not another project Lead. Mechanically it
is the same `factory` CLI above, run from an explicit path (never symlinked
onto agent PATHs), and revocation archives the agent and returns the acts
to the human CLI path — every recorded line stays.

Attribution is not left to prose. Every contract and accept carries who
submitted — the seat's `PASEO_AGENT_ID` where the daemon's env carries one,
`owner` on the human CLI path, no flag to set or override either way — so
`contract_set` lines carry `by:` and `attempt_accepted` lines carry
`accepted_by:`. An unstamped Owner act is refused as malformed; "the Ledger
always records who accepted" (ADR 0006).

The **Agent** gets one command, `factory-claim --task T1 --sha <commit>`, on its
PATH automatically. It prints the Verdict, the gate note, and the report path;
exit 0 on green, 1 on red, 2 when the factory did not process the claim.

Gate commands run as children of the plugin, under the daemon's environment —
a daemon launched from the desktop has no nvm on its PATH, so prefer absolute
command paths (e.g. `$(which node) --test`) in Contracts.

The mechanical loop without an agent is one command:

```sh
node scripts/smoke-loop.mjs --home ~/.paseo-factory   # contract → red → green → accept
```

The flaw battery plants deliberately flawed, gate-green work in fixture
workspaces and runs each arm through the same pipeline with `--fresh-eyes` —
the instrument for measuring whether the eye says CONCERN on purpose (four
flaw classes plus a clean control, pre-registered rules in the effort map):

```sh
node scripts/flaw-battery.mjs --home ~/.paseo-factory   # all arms; --arm <name> re-runs one
```

The watch battery is the watch's own instrument (v0.0.6, five arms since the
v0.0.8 re-arm plus a clean control): each arm plants one Watch question's
evidence on a real task riding the Contract's `--description`, runs it through
the same pipeline with `--watch`, and asserts the ledger shape — comparison
against the pre-registered ground truth stays the operator's act:

```sh
node scripts/watch-battery.mjs --home ~/.paseo-factory   # all arms; --arm <name> re-runs one
```

Since v0.0.6 the contract carries `--watch`: a record-only pass after every
verdict — red included — in which a Copilot chat model, prompted headless
through the daemon's `copilot` CLI, reads the run timeline, the Contract, the
diff and the gate output and answers the five fixed questions
(destructive-writes, test-weakened, stuck-loop, scope-creep, secret-leak) into
one `watch_written` ledger line. A passenger, never a judge: verdicts, accepts
and driver exits never read it.

State lives under `<daemon home>/plugin-state/paseo-factory/` — the ledger,
per-attempt reports, the spool (`requests/`, `replies/`, `processed/`), and the
generated `bin/factory-claim` wrapper that rides agent PATHs.

## License

MIT.
