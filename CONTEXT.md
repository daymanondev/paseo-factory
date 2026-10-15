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
Whoever sets or ratifies the work's outcome and final acceptance — the human, or a seat the human has delegated authority to (the Supervisor as conversational delegate; the Lead for intermediate Task contracts and clean green-task acceptance under ADR 0010, with Human override always retained). Never the Agent working that Task.
_Avoid_: reviewer, user

**Supervisor**:
The Owner's conversational delegate seat for a Project (`labels: { seat: "supervisor", project: <slug> }`), rooted at the Project's directory (`cwd = <project-root>`, ADR 0010) rather than an external `<home>-supervisor` folder, with role instructions injected additively so `<project-root>/AGENTS.md` is never overwritten. It clarifies intent (`grilling`), dispatches outcomes to the Project's Lead, relays status, verdicts and needs-human items to the Owner, accepts on the Owner's word (`accepted_by: "supervisor"`), and curates project-level rules in `AGENTS.md` / `CONTEXT.md`. Never: external `git push`, widening scope or budget, or accepting without the Owner's word. Added in v0.0.9 (ADR 0006); scoped per Project at `cwd` in ADR 0010.
_Avoid_: manager, orchestrator, assistant (and Driver — a mechanism, not a seat)

**Lead**:
The presiding technical seat over Agents for a Project (`labels: { seat: "lead", project: <slug> }`, `cwd = <project-root>`, ADR 0010): a standing model-backed Paseo agent on the `lead` lane (`lanes.json`, rotatable via `Rotate / Revoke Lead`) paired with the Driver's deterministic watch/respawn/ceiling rider underneath. The Lead reads the repository, splits a Supervisor directive into one or more Tasks, sets each Task's Contract (including optional `skills`), runs the Driver, judges hand-backs against Gate / Fresh-eyes / Watch evidence, accepts clean green intermediate Tasks (`accepted_by: "lead"`, when Verdict is green and Fresh-eyes has no `CONCERN`), re-briefs or escalates stuck work (`needs_human`), and reports completion to the Supervisor. Added as a mechanical rider in v0.0.10 (ADR 0006); graduated to a model-backed project seat in ADR 0010.
_Avoid_: manager, foreman, orchestrator, "the loop" (that names the mechanism), Driver (a mechanism, not a seat)

### Work and criteria

**Project**:
One Git repository supervised by the factory, identified canonically via `git rev-parse --show-toplevel --git-common-dir` as `<project-slug> = <basename>-<sha1(gitRoot).slice(0,6)>` (ADR 0010). Owns its isolated state directory (`<stateDir>/projects/<project-slug>/`) containing its Ledger, Reports, Retro proposals, and Task worktrees, plus its standing Supervisor and Lead seats.
_Avoid_: workspace (that is the working copy a Task runs in), folder, team

**Task**:
One unit of work within a Project, identified by a filename-safe id, judged against exactly one Contract.
_Avoid_: job, ticket, lane

**Contract**:
The done-criteria for a Task, fixed before the Agent starts: one Gate command, one Artifact, optional file `scope` and required `skills`, rooted at a Project workspace.
_Avoid_: spec, acceptance criteria, hợp đồng (outside research notes)

**Workspace**:
The git working copy a Task's work lives in; the Gate runs there and the Artifact is resolved inside it. Under ADR 0010, each spawned Task runs inside its own isolated Task worktree so the Project's root checkout stays clean.
_Avoid_: repo, project dir, cwd

**Task worktree**:
The linked `git worktree` automatically allocated for a Task at Spawn under `<projectStateDir>/worktrees/<task>` on branch `factory/<task>` (rooted at the Contract's `base` commit, copying `.worktreeinclude` entries when present, ADR 0010). Isolates the working Agent and Gate execution from `<project-root>`, and lands its `claimedCommit` back into `<project-root>`'s local branch upon Acceptance before being removed.
_Avoid_: clone, sandbox, shadow copy

**Workspace conflict**:
Two live Contracts whose execution Workspaces are the same working tree, or one nested inside the other. Refused at contract and spawn time when two Tasks target the same checkout; eliminated by construction when each Task runs in its own Task worktree (ADR 0010). Added in v0.0.5; updated in ADR 0010.
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
One Claim and the Gate run it triggers. A Task may have up to three Attempts (the Attempt ceiling, ADR 0008); they are numbered and never overlap.
_Avoid_: retry, run, iteration

**Verdict**:
The factory's red/green judgment of one Attempt. Green means the Workspace sat clean at the claimed commit both before and after the Gate, the Gate exited 0, and the Artifact exists. Green is evidence, not acceptance.
_Avoid_: result, status, pass/fail

**Accepted**:
The state of a Task after one of its green Attempts is accepted (`attempt_accepted`, recording `accepted_by: "owner" | "supervisor" | "lead"`, ADR 0010) and its claimed commit is landed into the Project's local checkout from the Task worktree (preserving `factory/<task>` if a local merge conflict requires resolution; never pushing to remote). The Lead may accept intermediate green Attempts with no Fresh-eyes `CONCERN`; the Owner retains override and final sign-off.
_Avoid_: done, finished, complete, passed

**Fresh-eyes review**:
A second judgment of a green Attempt by a model that took no part in writing it — one tool-less read of the Contract, the diff and the gate output (via the station's configured lane in the Lane config, or direct-API `eye.json`), appending one advisory ledger line (`fresh_eyes_written`). Evidence for the Owner, never acceptance; off unless the Contract marks it on. Added in v0.0.2; unlocked onto the Lane config in v0.0.13 (ADR 0009).
_Avoid_: mắt soi (outside research notes), code review, self-review

**Watch**:
The record-only post-verdict pass that asks the Watch questions about one Attempt — a model prompted headless and tool-less on the Watch's configured lane (Lane config, defaulting to `pi/zai/glm-5.3` or `copilot/gpt-5.4`, ADR 0009) reading the run timeline, the Contract, the diff and the gate output in one strict-answer pass — and appends exactly one ledger line (`watch_written`). A passenger, never a judge: no notification, no escalation, and Verdicts and driver exits are unchanged by its answers. Off unless the Contract marks it on. Added in v0.0.6; the question table shrank to four in v0.0.7, returned to five in v0.0.8, and moved from a hardcoded Copilot pin to the Lane config in v0.0.13.
_Avoid_: watcher, monitor, alarm, "Jev" (historical: the v0.0.6 design first used a decision model, dropped for the Copilot subscription before the first run)

**Watch question**:
One of the five fixed yes/no questions the Watch asks (destructive-writes, test-weakened, stuck-loop, scope-creep, secret-leak) — each with fixed wording and true/false criteria, answered as a probability between 0 and 1 in a strict `name: probability` answer format, never prose. The v0.0.7 shrink kept four of the original eight (fake-done, unverified-claims and self-accept dropped); destructive-writes returned in v0.0.8, its battery arm redesigned so the blocked step rides a task that still reaches a Claim — the v0.0.6 arm stalled on the block and left the Watch nothing to read.
_Avoid_: check, heuristic, alert rule

**Retro**:
The on-demand, Owner-invoked fresh-context pass over the whole recorded history — the Ledger rendered as a per-task digest, every Report, and the red Attempts' gate logs — in which a model prompted headless and tool-less on the Retro's configured lane (Lane config, ADR 0009) proposes new Gate checks for repeated-error patterns and draft Contract pieces for knowledge holes, every Proposal carrying its seq-cited evidence. Appends exactly one advisory ledger line (`retro_written`) and writes one proposals file; never applies, judges, or notifies. Nothing becomes law until Ratification. Added in v0.0.7; unlocked onto the Lane config in v0.0.13.
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
`factory run <task>… [--provider <p[/m]>]` — the command that takes explicit task ids, creates each task's branch, spawns each Agent (through the spool, falling back to the `worker` lane in the Lane config when `--provider` is omitted, ADR 0009) and watches to verdict, printing each task's verdict at its own terminal moment and exiting 0 only when every task ran green with zero refusals. It never sets Contracts and never Accepts; it stops at verdicts. Since v0.0.10 its watch loop carries the Lead's stall predicate as a rider (the announced path to a standing plugin loop); since v0.0.12 (ADR 0008) it stays watching across red Attempts below the Attempt ceiling and executes at most one automatic Respawn on Substrate death. Carrying a seat's act does not make it one. Added in v0.0.5.
_Avoid_: orchestrator, runner, supervisor, lead (those are seats, ADR 0006 — the Driver is neither)

**Attempt ceiling**:
The hard cap of three Attempts per Task (`MAX_ATTEMPTS = 3`, fixed in code, never configuration). Enforced plugin-side at `Claim` (a fourth Claim is refused before any Gate starts) and at `Spawn` / `Respawn` (`spawn:attempt-ceiling` / `respawn:attempt-ceiling`), and observed by the Lead rider: when Attempt 3 finishes red, the Task ends immediately in `needs_human` (`reason: "attempt-ceiling"`). Added in v0.0.12 (ADR 0008).
_Avoid_: retry limit, max retries, attempt budget

**Respawn**:
Replacing a contracted Task's Agent after `Substrate death`: a `respawn` request through the spool naming the dead Agent (`died_agent`), validated by the plugin (at most one automatic Respawn per progress marker — the latest `spawn_dispatched` or `gate_finished`) and recorded as `respawn_dispatched` or `respawn_refused` before the replacement Agent is created on the Task's branch with uncommitted working-tree fragments cleaned to `HEAD`. A second `Substrate death` with no new Attempt between them ends in `needs_human` (`reason: "died-after-respawn"`). Added in v0.0.12 (ADR 0008).
_Avoid_: restart (implies reviving the same daemon session), retry (an Attempt word), re-spawn

**Denial-stall**:
A Task whose Agent's turn ended at a denied permit ask: the last thing the Ledger shows for the Task is a denial, no Claim after it, and a fixed grace has elapsed. The Lead's only trigger. Distinct from spawn-then-silence, where nothing at all follows the spawn — substrate death, not a chokee's stall.
_Avoid_: stuck (too broad), blocked, hung

**Substrate death**:
The death of a spawned Agent's machinery — the agent no longer exists on the daemon (its timeline answers "not found"), or exists but shows no Life signal for the no-growth bound. What a Denial-stall is not: a stall is a live chokee; a substrate death has no chokee to poke. Classified by the driver's two doors, both read from the daemon timeline (ADR 0007).
_Avoid_: crash, hang (a live stall's words), zombie, false death (the retired incident class — a history word, not a state)

**Life signal**:
The observable evidence that a spawned Agent is alive and working: its daemon timeline entries growing. What the watch reads to tell working silence from Substrate death on lanes whose silence is honest — ask-less lanes write nothing to the Ledger between Spawn and Claim. Added in v0.0.11 (ADR 0007).
_Avoid_: heartbeat (implies the agent transmits it; the daemon is read, not pinged), liveness probe, ping

**Re-poke**:
The Lead's one act: a fixed-text message to a stalled Agent — continue by a route that needs no denied permission and make your Claim, or end the turn stating what you need from the Owner. Exactly one per Task, enforced where requests land, not hoped for; never sent into a running turn or over a pending ask.
_Avoid_: nudge, retry, wake (richer machinery's word), reminder

**Needs-human**:
The Ledger event (`needs_human`) the Lead writes when bounded automation is exhausted — when a Re-poke is spent and the Denial-stall persists (`denied-again`, `silent-after-repoke`), when a Task hits the Attempt ceiling (`attempt-ceiling`), or when a Task suffers Substrate death again after its one automatic Respawn (`died-after-respawn`) — each corroborated by its own Ledger evidence seqs. The Supervisor relays it to the Owner in words at its next turn, at leisure (only Acceptance closes a Task).
_Avoid_: alert, escalation ticket, incident (a different kind, its own later writer)

**Parallel run**:
The Driver running more than one contracted Task at once: the number of task ids on the invocation is the ceiling, every Task works in its own Workspace, and a scope is mandatory — an unscoped Contract is refused at Spawn when two or more tasks are requested. Added in v0.0.5.
_Avoid_: concurrency (too broad), batch, pool

**Unattended loop**:
A driver loop that takes approved Contracts, spawns Agents, runs Gates and records Verdicts without the Owner present. It commits to branches only; landing to main is always a human act. The Driver is its first shipped slice (v0.0.5); schedules and no-Owner operation remain later rows.
_Avoid_: autopilot, background job, cron

### Surface and configuration

**Factory surface**:
The plugin's client UI inside Paseo (sidebar global screen with Project selector, workspace-scoped panel bound to the active Project, and settings screen, ADR 0009, ADR 0010): it renders a versioned view snapshot derived from the Project's Ledger, the Lane config, and live daemon state across three views (`Tasks` verification line, `Seats & Models` topology and 5-lane switcher, `Timeline & Retro`), bridges to the Project's Supervisor seat via one-click ensure-or-open (and optional quick dispatch), and executes direct Owner acts (`Accept`, `Retro`, `Lane config` updates, `Supervisor` revoke, `Lead` rotate/revoke) through the plugin server's single writer. It never replaces the Paseo chat pane and never bypasses the single-writer law. Added in v0.0.13 (ADR 0009); updated in ADR 0010.
_Avoid_: dashboard, portal, control center, room panel

**Lane config**:
The plugin-owned configuration (`<stateDir>/lanes.json` machine defaults, plus optional `<projectStateDir>/lanes.json` overrides, ADR 0009, ADR 0010) mapping each model-bearing seat and station (`supervisor`, `lead`, `worker`, `watch`, `retro`, `freshEyes`) to its selected `provider/model` string (or `"eye.json"` for direct-API fresh-eyes). Read by the Factory surface, the Supervisor and Lead bridges, the Driver (when `--provider` is omitted), and the post-verdict/retro passes. Added in v0.0.13 (ADR 0009); expanded with `lead` and per-project overrides in ADR 0010.
_Avoid_: model settings, profile, preset, fleet manifest
