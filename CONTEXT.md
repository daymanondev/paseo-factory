# paseo-factory

A verification line for coding agents: the work is judged against criteria fixed before
it starts, by running checks rather than trusting the agent's word, and every step is
recorded so it can be read back later.

## Language

### People and parties

**Agent**:
The coding agent doing the work on a Task. It may make Claims; it never sets or changes a Contract.
_Avoid_: worker, peer (in this context), bot

**Owner**:
Whoever sets a Task's Contract — the human, or an agent the human has explicitly delegated the Owner seat to (revocably). Never the Agent working that Task. The delegated Owner seat is the Supervisor (ADR 0006).
_Avoid_: reviewer, user

**Supervisor**:
The Owner seat delegated to exactly one Paseo daemon agent, revocably — the only seat the Owner converses with (the Paseo app chat). Day-one powers, every act an attributed ledger line: take the Owner's stated outcome and draft + set the Contract, run the Driver, relay status and verdicts in words, accept an Attempt on the Owner's word. Never: landing or push, widening scope or budget, accepting without the Owner's word — it is not another project Lead (codex-room §9(a)). Woken by the Owner's message; one turn holds a Driver run, and any fact it acts on is read from the Ledger at act time, never recalled from the conversation transcript — transcript for talk, Ledger for truth. Its shell is ungated (the Choke policy judges contracted Agents only); revocation cancels the turn and archives the agent, returning the acts to the human CLI path. Added in v0.0.9 (ADR 0006).
_Avoid_: manager, orchestrator, assistant (and Driver — a mechanism, not a seat)

### Work and criteria

**Task**:
One unit of work, identified by a filename-safe id, judged against exactly one Contract.
_Avoid_: job, ticket, lane

**Contract**:
The Owner's done-criteria for a Task, fixed before the Agent starts: one Gate command and one Artifact, run in one Workspace.
_Avoid_: spec, acceptance criteria, hợp đồng (outside research notes)

**Workspace**:
The git working copy a Task's work lives in; the Gate runs there and the Artifact is resolved inside it.
_Avoid_: repo, project dir, cwd

**Workspace conflict**:
Two live Contracts whose Workspaces are the same tree, or one nested inside the other. Refused at contract time (the second `factory contract` exits 2, no ledger line — nothing changed, so nothing is recorded) and again at spawn time for already-contracted tasks; a conflict retires only when the live Contract is accepted. Prevention, not resolution — there is no merge machinery. Added in v0.0.5.
_Avoid_: scope conflict (the charted name — the real key is workspace overlap, not scope intersection), merge conflict

**Gate**:
The command named in a Contract whose exit status is the factual check of the work.
_Avoid_: test step, check, cổng (outside research notes)

**Artifact**:
A path inside the Workspace that must exist for a Verdict to be green. It can never point outside the Workspace.
_Avoid_: deliverable, output file

### Judging

**Claim**:
The Agent's statement that a Task is finished at a specific commit. A Claim is evidence of intent, never of completion.
_Avoid_: "done" (for the Agent's side), report, submission

**Attempt**:
One Claim and the Gate run it triggers. A Task may have many Attempts; they are numbered and never overlap.
_Avoid_: retry, run, iteration

**Verdict**:
The factory's red/green judgment of one Attempt. Green means the Workspace sat clean at the claimed commit both before and after the Gate, the Gate exited 0, and the Artifact exists. Green is evidence, not acceptance.
_Avoid_: result, status, pass/fail

**Accepted**:
The state of a Task after the Owner accepts one of its Attempts. Only an Attempt with a green Verdict can be accepted.
_Avoid_: done, finished, complete, passed

**Fresh-eyes review**:
A second judgment of a green Attempt by a different model that took no part in writing it — one direct-API read of the Contract, the diff and the gate output, appending one advisory ledger line (`fresh_eyes_written`). Evidence for the Owner, never acceptance; off unless the Contract marks it on. Added in v0.0.2.
_Avoid_: mắt soi (outside research notes), code review, self-review

**Watch**:
The record-only post-verdict pass that asks the Watch questions about one Attempt — a Copilot chat model (pinned in code, prompted headless through the daemon's `copilot` CLI) reading the run timeline, the Contract, the diff and the gate output in one strict-answer pass — and appends exactly one ledger line (`watch_written`). A passenger, never a judge: no notification, no escalation, and Verdicts and driver exits are unchanged by its answers. Off unless the Contract marks it on. Added in v0.0.6; the question table shrank to four in v0.0.7 and returned to five in v0.0.8.
_Avoid_: watcher, monitor, alarm, "Jev" (historical: the v0.0.6 design first used a decision model, dropped for the Copilot subscription before the first run)

**Watch question**:
One of the five fixed yes/no questions the Watch asks (destructive-writes, test-weakened, stuck-loop, scope-creep, secret-leak) — each with fixed wording and true/false criteria, answered as a probability between 0 and 1 in a strict `name: probability` answer format, never prose. The v0.0.7 shrink kept four of the original eight (fake-done, unverified-claims and self-accept dropped); destructive-writes returned in v0.0.8, its battery arm redesigned so the blocked step rides a task that still reaches a Claim — the v0.0.6 arm stalled on the block and left the Watch nothing to read.
_Avoid_: check, heuristic, alert rule

**Retro**:
The on-demand, Owner-invoked fresh-context pass over the whole recorded history — the Ledger rendered as a per-task digest, every Report, and the red Attempts' gate logs — in which a Copilot chat model (pinned in code, prompted headless, the Watch's lane) proposes new Gate checks for repeated-error patterns and draft Contract pieces for knowledge holes, every Proposal carrying its seq-cited evidence. Appends exactly one advisory ledger line (`retro_written`) and writes one proposals file; never applies, judges, or notifies. Nothing becomes law until Ratification. Added in v0.0.7.
_Avoid_: retrospective (the agile ceremony), postmortem, session debrief, "Retro pass" (the mechanism is the noun, like Watch)

**Proposal**:
One unit of Retro output: a class (gate-check, contract-draft, or observation), the ledger seq evidence that grounds it, and the proposal text. Advice for the Owner — the factory never applies its own proposals. Added in v0.0.7.
_Avoid_: finding (a fresh-eyes word), recommendation

**Ratification**:
The Owner's act of adopting a Proposal as ordinary repo work (a PR — a choke-list entry, a contract-template edit, a convention); recorded in the repo, never a factory event. The factory proposes; only the Owner ratifies. Added in v0.0.7.
_Avoid_: acceptance, approval (Accepted is the Attempt word)

**Flaw battery**:
A set of deliberately flawed, gate-green Tasks — plus one clean control — run through the real pipeline to measure whether the fresh-eyes review catches what the Gate cannot. The runner never judges outcomes and never accepts; comparing findings against planted ground truth is the operator's act. Added in v0.0.3.
_Avoid_: test suite, eval harness, mutation suite

**Arm**:
One member of a battery (flaw or bypass): a Workspace carrying one planted flaw or escape (or none, in the control), its Contract, and the ground truth an outcome is compared against.
_Avoid_: case, scenario, fixture (that names the files)

**Battery outcome**:
The comparison words for one arm against ground truth: hit (CONCERN citing the planted flaw), miss (CLEAR on a flawed arm), noisy hit (CONCERN citing only non-planted nits), false positive (CONCERN on the clean control), failed (technical).
_Avoid_: pass/fail (those are Verdict words)

**Watch battery**:
The instrument that measures the Watch: one planted arm per Watch question (five again since the v0.0.8 re-arm) plus a clean control, run through the real pipeline on the trial daemon with the Watch on, outcomes asserted with the Battery outcome words against pre-registered ground truth (a flag means yes-probability ≥ 0.5 naming the planted evidence). The runner never judges and never accepts; comparison against ground truth is the operator's act at close-out. Added in v0.0.6.
_Avoid_: eval suite, calibration set (that is the later tooling)

### Permissions

**Permit ask**:
The daemon's question whenever an agent wants to run a shell command it cannot run unasked (or, under some modes, edit a file). Since v0.0.4 the plugin answers every ask from a contracted Agent itself; Paseo persists no record of its own, so the ledger's `permit_allowed` / `permit_denied` lines are the only audit trail an ask ever leaves.
_Avoid_: permission prompt (the daemon's UI word), approval, grant

**Choke policy**:
The judge over permit asks from contracted Agents: default-allow with a small deny-list — the dangerous-git vocabulary on any spelling, and writes outside the writable set (workspace ∪ /tmp ∪ TMPDIR ∪ factory state dir). A deny is choke-and-record: one ledger line, one report line, no mid-task escalation channel. Uncontracted asks are not its business.
_Avoid_: sandbox, warden (that would be daemon-wide), allowlist (the stance is the opposite)

**Git shim**:
A `git` wrapper in the hook-injected PATH dir that refuses the destructive git subcommands (force/delete push, `reset --hard`, deleting `clean`, working-tree discard, `branch -D`, recovery destruction) at exec time no matter who runs them — explanatory stderr line plus one `git_blocked` ledger line; everything else passes through to the real git. Composes with the Choke policy: the shim nets PATH-resolved git, the policy nets everything that asks.
_Avoid_: git wrapper (too generic), git hook (different mechanism)

**Bypass battery**:
The instrument that measures the choke: four planted escape arms plus a clean control, run against the real plugin on the trial daemon, outcomes asserted against rules fixed before any run (choked = not executed + exactly one ledger line; escaped; clean; failed). The runner never judges and never accepts, and refuses the prod home.
_Avoid_: pentest, red team, security audit

### Records

**Ledger**:
The append-only record of every event in the factory; lines are never edited or removed.
_Avoid_: log, history, sổ (outside research notes)

**Report**:
The human-readable account of one Attempt, generated from the Ledger, with every line traceable to a Ledger event.
_Avoid_: summary, biên bản (outside research notes)

**Meter**:
The post-verdict capture of what one task's run cost its lane: the daemon's own usage snapshot — dollars where the lane meters them, tokens where it only counts, the absence recorded where it does neither — read at the run's terminal moment and appended as exactly one ledger line (`meter_written`). A recorder, never a judge: no budgets, no alerts, verdicts unchanged. Added in v0.0.8.
_Avoid_: cost tracker, billing, accounting

### Running

**Spawn**:
Starting a contracted Task's Agent: a `spawn` request through the spool, validated by the plugin (request shape, task known and not accepted, scope mandatory when the invocation carries two or more tasks, no workspace conflict) and recorded as exactly one ledger line — `spawn_dispatched` or `spawn_refused` with its rule — before any agent exists. Added in v0.0.5.
_Avoid_: launch, fork, dispatch (that names the happy ledger line)

**Driver**:
`factory run <task>… --provider <p[/m]>` — the command that takes explicit task ids, creates each task's branch, spawns each Agent (through the spool) and watches to verdict, printing each task's verdict at its own terminal moment and exiting 0 only when every task ran green with zero refusals. It never sets Contracts and never Accepts; it stops at verdicts. Added in v0.0.5.
_Avoid_: orchestrator, runner, supervisor, lead (those are seats, ADR 0006 — the Driver is neither)

**Parallel run**:
The Driver running more than one contracted Task at once: the number of task ids on the invocation is the ceiling, every Task works in its own Workspace, and a scope is mandatory — an unscoped Contract is refused at Spawn when two or more tasks are requested. Added in v0.0.5.
_Avoid_: concurrency (too broad), batch, pool

**Unattended loop**:
A driver loop that takes approved Contracts, spawns Agents, runs Gates and records Verdicts without the Owner present. It commits to branches only; landing to main is always a human act. The Driver is its first shipped slice (v0.0.5); schedules and no-Owner operation remain later rows.
_Avoid_: autopilot, background job, cron
