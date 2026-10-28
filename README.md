# paseo-factory

A verification line for coding agents, delivered as a [Paseo](https://paseo.sh) plugin.

Both the GitHub repository and the plugin/package name are `paseo-factory` (see ADR 0001).

Work is judged against criteria fixed before it starts: the **Owner** sets a
Contract (one gate command, one artifact), the **Agent** does the work and
claims the task is finished at a specific commit, and the factory — never the
agent — runs the gate and records every step in an append-only ledger it
cannot edit. A green verdict is evidence, not acceptance.

**Status: v0.0.51.** The verification core and installed plugin are covered by
965 tests on Node 22 and 24. The Paseo 0.13 plugin owns the Ledger as its single
writer and serves CLI, MCP and surface RPC entrances. Acceptance uses trusted
caller authority and shared Task/Attempt state; Vault history is staged before
writer-owned admission, preserving local evidence addresses.

Lead owns semantic review: after a GREEN Gate, inspect `git show --stat "<sha>"`
and `git diff "<sha>^" "<sha>"` against the Contract, then accept or re-contract.
Fresh-eyes is off by default for all callers and never blocks Lead acceptance;
legacy explicit CLI opt-ins, configuration and Ledger evidence remain supported.
Seats & Models exposes the five active lanes: supervisor, lead, worker, watch
and retro. Headless Pi passes default to thinking off unless their lane specifies
an explicit level. MCP Spool requests wait up to ten minutes for a reply.

Persistent history upgrades are explicit: inspect the
[upgrade and recovery runbook](docs/runbooks/history-upgrade.md) before applying
one. The [hardening validation report](docs/validation/codebase-hardening-2026-10-23.md)
records regression checks, disposable trial results and their limits. Release
notes are in [CHANGELOG.md](CHANGELOG.md).

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
Scope, worktree hydration, Ledger reading and subprocess policies also generate
standalone installed assets: run `npm run generate:policies` after editing their
canonical TypeScript sources, and commit the generated files. The bridge and
Antigravity hook embed their policies so each remains usable when copied alone.
`npm run generate:policies:check` reports stale outputs without rewriting them.
Generation uses development dependencies; plugin installation needs no build.

## Required checks

Use Node 22.22.0 or 24.21.0 and the committed lockfile:

```sh
npm ci
npm run check
```

Push and pull-request CI runs these same commands on both versions. The check
command verifies copied-core and generated-output drift, typechecks the actual
canonical TypeScript policy bodies, compiles the isolated installed client/server
bundles, and runs every behavior test. The tests include standalone assets
copied without source or development dependencies, the bridge copied alone, and
negative fixtures for stale outputs and forbidden or unavailable dependencies.
`npm run check:installed` runs that packaging subset when iterating locally.

The installed bundle check reads tracked files (including staged additions), so
stage intended new plugin modules before running it. Untracked files cannot
satisfy the installed view, and imports or symlinks cannot reach outside the
isolated plugin. Development dependencies supply compiler tools only; they
cannot satisfy installed runtime or type imports. Regenerate changed outputs
with `npm run sync:plugin-core` and `npm run generate:policies`, then commit them;
checks never silently repair stale artifacts. Plugin installation remains
build-free.

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

v0.0.10 adds the presiding half: the **Lead seat** (ADR 0006 §3) — a
deterministic rider on the Driver's watch, zero model calls of its own, no
state file (the Ledger is its state). One authority: when a task's last
ledger event is a denied permit ask, no Claim follows, and a fixed grace has
elapsed — a denial-stall — it spends the task's one re-poke, a fixed-text
message through the daemon's own prompt surface, and if the stall persists
it writes the `needs_human` line the Supervisor relays to the Owner in words
at its next turn. Exactly one poke per task, enforced plugin-side, never
sent into a running turn. The live run that closed v0.0.10 also drew the
boundary honestly: on lanes that never ask (pi has no permission mode; the
daemon's antigravity driver is full-access by design) the trigger has no
surface — the positive arc stays unwitnessed until a lane-independent
trigger exists.

v0.0.11 answers the hardest question a watch can ask — *is the agent still
alive?* — from the substrate's own record. A null agent-fetch on daemon 0.11
is an empty signal (it answers null for a closed agent, an idle one, and a
never-existed UUID alike), so the driver's null lane reads the daemon
timeline as the death oracle (ADR 0007), and death has two doors: the
timeline's own **"Agent not found"** answer — the fast door, opened live
5.5 s after a mid-run `paseo agent delete` — and an answering timeline whose
`seqEnd` has not grown for a fixed 120 s — the slow door, the bound's meaning
changed from "zero ledger life" to "no life signal" (healthy ask-less work
streams timeline items continuously). Post-spawn ledger life survives as
defense-in-depth only: a not-found the ledger contradicts is a state the
watch survives, not a death. The version's judged run is the row's witness
both ways: its healthy arm survived a 399.9 s ask-less span on timeline
growth (3.3× the bound) with the meter landing after the claim, and its
planted-delete arm exposed the build's one lie — the fast door could not
open live (the daemon resolves the not-found as a payload error, not an rpc
error; every true fast-door death landed 120 s late wearing the slow door's
words) — the fix rides the version, witnessed live by the door's own words
at the first poll past the delete.

v0.0.12 closes the re-scoped trio row from ADR 0006 §5 — **Respawn and
Attempt ceiling** (ADR 0008). Every Task is capped at `MAX_ATTEMPTS = 3`
plugin-side across `Factory.claim`, `Factory.requestSpawn`, `Factory.respawn`,
and the Lead rider; on the null-fetch lane `continueOnLedger` finishes
immediately only on a `green` verdict so a live Agent can read a `red` note,
commit a fix, and submit Attempts 2 and 3, while a third `red` Attempt ends
immediately in `needs_human` (`reason: "attempt-ceiling"`). On `Substrate
death` (either watch lane) the Driver meters the dead Agent first, requests
at most one automatic `Respawn` per progress marker (`spawn_dispatched` or
`gate_finished`) through the spool (`respawn_dispatched` / `respawn_refused`),
cleans uncommitted worktree fragments to `HEAD` on branch `<task>`, and keys
`agent.create.request` by the dispatch `seq`; a second death with no new
Attempt between them ends in `needs_human` (`reason: "died-after-respawn"`).
Witnessed live (7/7 checks PASS, $0 out-of-pocket on `pi/zai/glm-5.3`): a
planted mid-run delete caught the Fast door in 2.6 s, metered Agent 1,
dispatched `respawn_dispatched`, and watched Agent 2 to a green Attempt 1
(3.16 s delete-to-create); the ceiling arm survived red Attempts 1 and 2 in
one turn, recorded `needs_human ("attempt-ceiling")` at Attempt 3, and
refused both post-run negative probes (`factory-claim` #4 and `factory run`).

v0.0.13 brings the **Factory surface** into Paseo Desktop and unifies every
model-backed seat and pass under `<stateDir>/lanes.json` (ADR 0009). One JSON
file (`supervisor`, `worker`, `watch`, `retro`, `freshEyes`, each defaulting to
`"pi/zai/glm-5.3"`) governs all five lanes, editable from the Paseo UI (**Seats
& Models** tab) or `factory lanes set <lane> <provider/model>` — with `Lead`
kept outside `lanes.json` because it is a zero-model deterministic rider.
`Watch`, `Retro`, and `Fresh-eyes` all route through a shared tool-less CLI
runner (`runLaneCli` across `pi --no-tools -p`, `copilot -p --available-tools=""`,
and `claude -p --tools ""`, while `freshEyes: "eye.json"` retains the direct
HTTP path), eliminating the hardcoded Copilot quota bottleneck. Inside Paseo,
the `Factory` sidebar screen, workspace panel, and settings view render three
tabs — **Tasks** (verification line with Attempt 1/2/3 ladder, Gate/Eye/Watch
badges, inline `Accept #n`, and markdown/diff/gate-log detail modal), **Seats &
Models** (interactive lane cards, model selector modal, and orthogonal Seat
Graph), and **Timeline & Retro** (multi-lane swimlane, one-click `Run Retro`,
and searchable Ledger stream) — plus the **Open Supervisor** / **Quick
Dispatch** header bar that creates or reuses the tagged `seat=supervisor`
agent, writes `<home>-supervisor/AGENTS.md` with exact `factory.mjs` recipes,
and opens the native Paseo chat drawer in one click.

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
verdict — red included — in which the configured `lanes.watch` model (prompted
headless and tool-less via `runLaneCli`) reads the run timeline, the Contract,
the diff and the gate output and answers the five fixed questions
(destructive-writes, test-weakened, stuck-loop, scope-creep, secret-leak) into
one `watch_written` ledger line. A passenger, never a judge: verdicts, accepts
and driver exits never read it.

State lives under `<daemon home>/plugin-state/paseo-factory/` — the ledger,
`lanes.json`, per-attempt reports, the spool (`requests/`, `replies/`,
`processed/`), and the generated `bin/factory-claim` wrapper + `bin/git` shim
that ride agent PATHs.

## License

MIT.

Opt-in [Agile Scrum execution](docs/runbooks/scrum.md) adds isolated specialist rosters, durable design decisions and QA evidence while preserving the default SLP workflow.
