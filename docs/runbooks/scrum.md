# Agile Scrum execution

SLP remains the default. Its six lanes, profiles, role providers, Gate verdicts
and Lead acceptance rules are unchanged. Scrum is selected explicitly per
Project; changing the machine default affects newly registered Projects only.

Use the Factory header or Seats & Models selector, or the Owner CLI:

```sh
factory execution get --project /absolute/project
factory execution set-mode scrum --project /absolute/project
factory scrum get --project /absolute/project
```

A switch refuses active Tasks, conflicts, Agents, Gates, mail, handoff or a
nonterminal Scrum run. An interrupted seat transition holds dispatch. Repeat
the same set-mode operation (or Resume switch in the surface) to recover.
Switching back retains both rosters and all history.

Configuration lives in separate `execution.json`, `scrum-lanes.json` and
`scrum-profiles.json` stores. Explicit roster creation copies the machine Scrum
roster if present; otherwise it seeds once from that scope's SLP roster.
Subsequent edits never fall back into SLP. Configuration revisions are monotonic.
`factory lanes` and `factory profile` continue to operate on SLP storage.

Scrum operations use the live writer through the same CLI/spool as Task work:

```sh
factory scrum config.set --project /absolute/project --file /tmp/roster.json
factory scrum profile.save --project /absolute/project \
  --payload '{"id":"daily","name":"Daily"}'
factory scrum profile.apply --project /absolute/project \
  --payload '{"id":"scrum:daily"}'
```

The roster payload is `{ "config": { "schemaVersion": 1,
"requireUiApproval": true, "lanes": { ... } } }` with all nine backing lanes:
supervisor, lead, pm, ux, architect, dev, qa, watch, retro. Watch and Retro share
one UI card but remain two values. Profile apply copies one complete config and
does not select a mode. Edits during a run apply to future runs.

## Run admission and Tasks

Supervisor remains the sole conversational contact. A new Scrum Lead directive
includes `scrum: { initiativeId, track, rationale, ownedPaths, budgets? }` in
`supervisor_dispatch_lead`; follow-ups identify `runId`. The writer admits the
run before queueing its directive. Track is small, backend or ui. Small work
needs a backlog and QA; it does not invent a PRD/UX ceremony. UI work requires
planning, semantic readiness, offline browser evidence and a design decision.

The explicit operation is also available to the Owner/Supervisor:

```sh
factory scrum run.create --project /absolute/project --run checkout-01 \
  --request-id checkout-admission --file /tmp/admission.json
```

Admission freezes the policy/config revisions, roster, approval setting, track,
finite budgets and exact owned files. Default limits are 24 Tasks, two hours and
two defect-fix rounds. Only one nonterminal run is permitted per Project.
Existing `.scratch/<initiativeId>` namespaces are refused. Declare individual
artifact files under the initiative: PRD, DESIGN, EXPERIENCE, architecture,
backlog, mockups/assets, per-Task decisions, and QA artifacts. Never force-add an
entire scratch directory or local tracker/spec files.

```sh
factory contract --task pm-checkout --workspace /absolute/project \
  --run checkout-01 --role pm --gate '/absolute/node --test baseline.test.mjs' \
  --artifact .scratch/checkout/prd.md --description '...four-part brief...'
factory run pm-checkout --run checkout-01 --role pm
```

Role defaults to dev once at Contract creation. The complete execution binding
is persisted. Role/run options on run are assertions, not overrides. Legacy
unbound Contracts always remain SLP/Peer even after a mode selection changes.
Planning/QA Contracts receive exact artifact scopes and structural linter Gates;
the working authority remains agent (claim/blocker tools only).

## Durable decisions and evidence

`factory scrum run.command --run <id> --revision <n> --request-id <stable-id>
--payload <JSON>` submits one typed command. Supported records include
role_result, artifacts_recorded, readiness_recorded, design_review_requested,
fix_reserved, qa_recorded, bundle_promoted, blocked, blockers_resolved and
phase_changed. Every mutation checks the expected revision. Duplicate request
IDs are idempotent; reuse with changed content is refused. Bound Task/provider
records and terminal completion/cancellation use dedicated verified operations.

A role_result records complete/partial/blocked, exact artifactRefs, assumptions
(with unsafe/resolved flags and rationale), openQuestions and conflicts.
Readiness pins landed refs plus contradictions, unsafeAssumptions,
missingCoverage and rationale. Structural lint does not resolve semantic
contradictions. New revisions/fixes/re-audits use new Task IDs; accepted Tasks
remain closed.

Design review pins revision, digest, artifact refs and browser evidence. The
browser JSON records network disabled, console errors, viewport screenshots
with hashes, and keyboard state checks for every applicable screen/state (or
justified N/A). `factory scrum preview` returns exact accepted HTML through a
Project/run-scoped RPC. The surface renders it in an opaque iframe sandbox with
network disabled by CSP. UI decisions use `factory scrum design.decide` or the
surface controls, naming revision/digest, decision and rationale. Supervisor
must have explicit Owner instruction; Lead/Agents cannot self-approve. Approval
alone does not establish readiness. A policy waiver is an explicit recorded
revision-specific decision even when the frozen default makes review optional.

QA first proves the baseline GREEN. Candidate tests and their original hashes,
target paths, runner/fixture instructions and discovery evidence live outside
active discovery under `qa/<auditId>/bundle/`. `qa-report.json` is authoritative;
Markdown is its readable rendering. Reports distinguish clean, defects_found,
blocked and inconclusive, pin full product SHA, requirements/design refs,
commands/results/log hashes, four review lenses and confirmed findings.
A GREEN QA artifact may correctly report defects_found.

Reserve `fix_reserved` with the new Dev Task ID before a defect fix. Reservations
survive failed dispatch, restart and handoff; a duplicate cannot replenish the
budget. Clean candidate bundles also need promotion, without consuming a fix
round. Promotion preserves exact test bytes/assertions. Re-audit executes the
active required suite twice using isolated fixtures and first-attempt passes;
skips, expected failures and retry-masked passes cannot satisfy clean QA.
Report-only descendant commits preserve the executable-product attestation.

`factory scrum run.complete` checks closed/landed Tasks, current readiness/design
decision, safe results, coverage, promoted bundles, resolved required defects,
current clean QA, idle work and a clean root before recording completion.
`factory scrum run.cancel` stops owned Agents and retains unresolved evidence;
it does not auto-accept Tasks or clear landing conflicts. Owner Project reset
removes Scrum runtime resources while retaining selection and both rosters.

Run `factory lint-scrum-doc --kind prd|ux|architecture|backlog|qa --dir <path>`
for deterministic JSON diagnostics: exit 0 valid, 1 findings, 2 bad invocation
or unreadable input. Stable/deprecated ID gaps are allowed. Browser checks,
Lead semantic review and product QA are separate obligations.

## MCP orchestration and natural directives

The bridge selects the Project's execution mode once at startup. Seat configuration
passes `--mode`; older provider homes resolve the Project's `execution.json`.
Supervisor exposes `supervisor_dispatch_lead`, `supervisor_read_ledger`,
`supervisor_end_cycle`, and (in Scrum only) `supervisor_scrum_decision`.
Lead uses `lead_set_contract`, `lead_dispatch_agent`, `lead_verify`, `lead_merge`,
worktree create/remove, and reporting; Scrum adds `lead_scrum_operation`.
These names replace the former spawn/accept/status coordination tool names.
Core SLP Contract, Gate, Driver, acceptance, and landing rules are unchanged.

In Scrum, dispatching `{ message }` admits a standard run automatically, or reuses
an active nonterminal run. Explicit `runId` and partial `scrum` admission overrides
remain available. Lead refines the track with `track.select` before any Dev Task
lands. `quick` uses the existing small-track evidence policy; `standard` and
`enterprise` require the complete planning/design evidence policy. Historical
`small`, `backend`, and `ui` journals retain their original interpretation.

`lead_scrum_operation` supports `get`, `track.select`, `readiness`, `design.submit`,
`qa.audit`, `fix.reserve`, `bundle.promote`, `run.complete`, and `preview`. Omit
`runId` to use the single active run. Evidence mutations use exact landed
`artifactRefs` (`path`, full `commit`, `sha256`). Record landed specialist results
with `roleResults: [{ task, result: { status, artifactRefs, assumptions,
openQuestions, conflicts } }]` on the readiness/QA operation. Readiness without
`artifactRefs` inspects current readiness; with refs it records verified readiness.
Design submission additionally requires `browserEvidence`. QA and promotion name
`auditArtifact` and `bundlePath`. Fix reservation names the new fix `task`.
Preview returns the existing self-contained, sandboxed HTML payload.
All evidence and completion checks still run through the verified controller.

After an explicit Owner decision, Supervisor calls `supervisor_scrum_decision`
with `decision` and `rationale`; run/revision/digest default to the current review.
Lead cannot approve a design. Specialist Contracts default the canonical artifact
and their own decision-log path. Planning/QA scope stays in the initiative;
explicit Dev implementation paths are preserved and journaled as run ownership.
Add explicit mockup/browser/QA evidence paths to `scope` when contracting them.
Kickoff and Scrum prompts probe project memory and instruct seats to read only
present `AGENTS.md`, `CLAUDE.md`, and `CONTEXT.md` files.
