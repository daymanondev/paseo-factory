# 0032 — Isolated Scrum execution alongside SLP

- **Date:** 2026-10-27
- **Status:** Accepted; amended by specification Revision 2
- **Preserves:** ADR 0001–0031

## Context

SLP remains the default supported delivery workflow. Larger initiatives may opt into a BMAD-inspired specialist workflow, with Supervisor as the sole conversational contact. Factory owns the autonomous protocol; upstream BMAD commit `61e01f82644c4bb533750cfa0d6d61ab61d2cc9b` is a research reference, not a runtime dependency. Revision 2 supersedes the original shared-lane/shared-prompt design.

## Decision


### 1. Module Placement and Dispatch Seam

Add focused modules under `src/scrum/` for configuration/profiles, run projection/commands, role prompts, artifact validation, and QA evidence. Add a small execution-mode dispatcher at the existing plugin/CLI entry seams. The conceptual call flow is:

```text
new directive → resolve Project execution selection
  slp   → existing SLP kickoff / contract / spawn flow
  scrum → Scrum run controller → existing Task / Gate / Lead acceptance primitives

existing Task operation → persisted contract binding
  no binding → existing SLP path
  scrum binding → Scrum adapter checks + the same verification primitives
```

- Shared core changes are limited to additive contract metadata and the necessary validated ingress/dispatch plumbing. No Scrum branch belongs in the `leadEligible` predicate or mechanical Gate verdict calculation.
- Common Task status remains Task status. Scrum readiness, approval and product-verification status are separate projections; a GREEN QA artifact Task is not a completed product run.
- `src/` remains canonical. Sync new/changed core modules into `plugin/server/core/` through the existing sync mechanism; include new module directories in packaging checks where needed. Keep generated policy assets reproducible.
- SLP role rendering and kickoff packets remain the existing renderers. A separate Scrum renderer produces Scrum prompts; do not append Scrum instructions to every SLP prompt and tell the model to ignore them.
- Select the renderer before agent creation using persisted execution identity. Preserve that identity through `agent.create`, `agent.session_open`, respawn, and Lead handoff; never infer specialist role from a title or mutable Project mode.

### 2. Separate Configuration and Profile Stores

Use the following ownership table at machine and Project scope:

| Concern | Existing SLP storage | New execution/Scrum storage |
|---|---|---|
| Execution selection | No change to `lanes.json` | `<stateDir>/execution.json` for new-Project defaults; `<projectStateDir>/execution.json` for Project selection |
| Models | Existing scoped `lanes.json` and six lanes | Scoped `scrum-lanes.json` |
| UI approval default | Not applicable | `requireUiApproval` in scoped `scrum-lanes.json` |
| Saved profiles | `<stateDir>/profiles.json`, unchanged | `<stateDir>/scrum-profiles.json` |
| Runtime workflow | Existing ledger/mailbox | `<projectStateDir>/scrum/runs/<runId>/events.jsonl` plus derived snapshot |

The interfaces distinguish these types rather than widening `Lanes`:

```ts
export type FactoryExecutionMode = "slp" | "scrum";
export type ScrumRoleName = "pm" | "ux" | "architect" | "dev" | "qa";
export type AgentSpecialization = "peer" | ScrumRoleName;
export type ScrumLaneName = "supervisor" | "lead" | ScrumRoleName | "watch" | "retro";

export interface ScrumConfig {
  schemaVersion: 1;
  requireUiApproval: boolean;
  lanes: Record<ScrumLaneName, string>;
}
```

- Project execution selection records a schema version, selected mode and monotonic config revision. The machine execution default ships as `slp` when absent.
- The first explicit creation of a Scrum roster seeds a complete independent copy: Supervisor/Lead/Watch/Retro from the scope's existing SLP values; PM/Architect from Lead; UX/Dev/QA from Worker; `requireUiApproval: true`. Existing machine Scrum defaults, if configured, supply the new Project's Scrum roster before any SLP seeding. After creation there is no live fallback into SLP configuration.
- A Project Scrum roster is self-contained, matching the repository's copy-on-apply model. Resetting it explicitly copies the current machine Scrum roster; editing either roster never mutates the other. Reads do not create files. Missing machine Scrum defaults are seeded only during an explicit Scrum config/reset action, from machine SLP values, never from another Project.
- Scrum lane parsing/model capability validation reuses pure helpers such as `parseLane`; its lane-name set and persistence are independent. Model hints derive from the advertised provider catalog; no hardcoded promise that one family has no shared blind spots.
- Scrum profiles hold the complete ScrumConfig, name, ID, update timestamp and deletion tombstones. Use the existing merge rules as a reference, but a distinct store and active-profile metadata. There are zero built-in profiles. IDs are namespaced by mode for UI actions; identical textual IDs in the two stores do not collide.
- Applying a profile only updates that mode's configuration. It does not switch execution mode. No new required fields are added to SLP profiles; the surface may label them `slp` in its view model without writing tags into the legacy file.
- All new config/profile mutations go through serialized writer-owned operations and atomic replace. A profile apply is a single config update, not concurrent per-lane saves.
- Vault adds separate entries for execution defaults, Scrum rosters, and `config/scrum-profiles.json`. Existing SLP `config/profiles.json`/lane paths and merge semantics remain unchanged. Omitted Scrum files in an older vault are not deletion instructions. Syncing a new machine default never changes an existing Project's selected mode.

### 3. Safe Mode Switching and Frozen Run Configuration

- Mode switching is an Owner configuration action. The Project Header and Seats & Models selector call an execution-specific operation (`factory.execution.setMode`), not an extension of `factory.lanes.set`.
- Refuse with `execution-mode-busy` when that Project has unaccepted or pending-conflict Tasks, an in-flight Gate/Agent, pending or in-flight directive delivery, an unfinished Lead handoff, or a nonterminal Scrum run (including waiting for approval). Show the actual blocking work; do not cancel/reset it as a side effect.
- When idle, prepare/validate the target config and retire/recreate standing seats with the target renderer and lane selection using the established seat lifecycle. Use a durable switch intent and recovery so dispatch cannot observe a new mode with old seat prompts. A failed transition is visible and blocks new dispatch for that Project until completed or rolled back to the prior selection; it never silently runs the wrong mode.
- Switching back to SLP retains Scrum config/history but restores the original SLP renderer, six-lane configuration, seats and profile view. SLP mode does not load a Scrum roster to operate.
- Each Scrum run freezes `{mode: "scrum", runId, initiativeId, policyRevision, configRevision, lanes, requireUiApproval, track, budgets}`. Config/profile edits during an active run affect future runs only and are labeled accordingly. Changing the active run's approval policy requires a recorded run-specific waiver, not a hidden default toggle.
- Keep at most one nonterminal Scrum run per Project in this release. Different Projects can run SLP and Scrum concurrently. Do not let the machine default reroute a queued directive; bind its execution identity before queueing it.

### 4. Contract Binding, Spawn, and Capabilities

Use an optional namespaced field on new Scrum `contract_set` events and ContractInput; SLP events remain unchanged:

```ts
export interface ScrumTaskBinding {
  mode: "scrum";
  runId: string;
  role: ScrumRoleName;
  policyRevision: string;
  configRevision: number;
  artifactRefs: Array<{ path: string; commit: string; sha256: string }>;
}
// ContractInput / ContractSet: execution?: ScrumTaskBinding
```

- `lead_set_contract` and `factory contract` accept a specialist role with a Scrum run reference on the Scrum path. The adapter resolves omitted role to `dev` once at creation and persists a complete binding. Absence of `execution` always means SLP/Peer; never infer it from current config. SLP requests with specialist fields fail `execution-mode-mismatch` instead of enabling Scrum implicitly.
- `lead_spawn_agent` / `factory run` read the active contract binding. Optional repeated role/run parameters are assertions, not overrides: disagreement fails `task-execution-mismatch` before spawn. A missing/corrupt referenced Scrum run fails that Task locally; it is never treated as SLP.
- Preserve existing event IDs, epoch identity, schema validation, single-writer sequencing, and accepted Task immutability. Validate the optional binding when present; legacy payload validation and emitted SLP event fields do not change. Run recovery reconciles contracts via their binding/epoch IDs, not Task title or timing guesses.
- Resolve the Scrum model from the run's frozen role lane. Explicit provider overrides use existing authority rules, are validated, and are recorded in the run journal before launch; a retry uses the recorded Task/epoch selection, not a newly edited profile. SLP provider resolution is unchanged.
- Working Agent authority stays `agent` in labels/correlations/bridge arguments. Add specialization/run labels separately. Titles are `PM · <Task>`, `UX · <Task>`, `Arch · <Task>`, `Dev · <Task>`, `QA · <Task>`; SLP keeps `Peer · <Task>`. Scrum Lead is titled `Scrum Lead`; SLP Lead remains `Lead`.
- Scrum Supervisor/Lead keep coordination-only MCP capability via a **mode-isolated MCP tool catalog** (`SLP` vs `Scrum` selected once at the `bridge.mjs` seam from the Project's execution mode, sharing transport helpers without mixing `if/else` schemas): SLP seats never see Scrum fields (`runId`, `scrum`, `role`, `artifactRefs`) or Scrum tools, and Scrum seats see only Scrum-scoped tools (`supervisor_dispatch_lead`, `supervisor_scrum_decision`, `supervisor_accept_task`, `factory_status` on Scrum `Supervisor`; `lead_set_contract`, `lead_spawn_agent`, `lead_accept_task`, `lead_scrum_operation`, `lead_repoke_agent`, `lead_needs_human`, `lead_report_to_supervisor`, `factory_status` on Scrum `Lead`). Specialists retain only Agent claim/blocker tools plus role-appropriate external research/vision helpers and skills. UX gets frontend design/visual verification skills; Dev gets TDD/debugging; QA gets testing/review; PM/Architect get research/domain/design as appropriate. Product source remains read-only for planning/QA roles under their explicit artifact/test Contracts. Keep project-memory fences for AGENTS/CLAUDE/CONTEXT.
- SLP Pi home paths/content stay unchanged. New Scrum standing-seat homes live under `<projectStateDir>/scrum/harness/seats/<selectionRevision>/<seatGeneration>/<authority>/`, including before any run exists. Specialist homes live under `<projectStateDir>/scrum/harness/runs/<runId>/<task>/<epoch>/`. Scope managed prompts, skills, settings and MCP configuration to that immutable identity; pass active-run state in the kickoff packet. At new-run admission reconcile idle standing seats with the selected Scrum roster before delivering the run directive; defer config-driven seat rotation during an active run. Share authentication/model definitions only through existing permitted links. No Scrum provisioner writes into SLP `pi-agent/{supervisor,lead,agent,headless}` or another Project's home. Keep provider family parity and existing MCP timeouts; test all supported hooks, not Pi alone.

### 5. Scrum Run State and Recovery

The Scrum module owns a small append-only journal through the same live single writer. Agents never write it directly. A derived manifest/surface snapshot may cache state, but the journal plus bound core Task events is authoritative.

- Record run creation/config snapshot, track selection/rationale, phase changes, artifact revisions, readiness decisions, design review decisions, Task associations, QA rounds, fix reservations, blockers and terminal result.
- Event commands have request IDs and expected run revision. Duplicate delivery is idempotent; stale revision decisions fail with an actionable conflict. Replay cannot spend the same fix reservation twice or restore a consumed budget. Supervisor's existing directive operation creates/binds a run before queueing a new Scrum directive; follow-up directives identify that run explicitly. Approval/waiver is a separate structured decision operation, not a side effect of an arbitrary follow-up message.
- Run phases are `planning`, `design`, `readiness`, `awaiting-ui-approval`, `implementation`, `qa`, `fixing`, `blocked`, `completed`, `cancelled`. Skipped phases are recorded with reasons; these are not new common Task statuses. `blocked` is nonterminal; it needs resolution or explicit cancellation before mode switching.
- `RoleResult` is `complete | partial | blocked` with artifact refs, assumptions, open questions and conflicts. A linter-clean artifact can still be partial. Low-risk, reversible assumptions may proceed with rationale; unresolved product semantics, auth/data ownership, destructive/migration choices or incompatible architecture require resolution through Lead/Supervisor before dependent work. Do not invent requirements to fill templates.
- Each run records finite `maxTasks` (default 24), `maxElapsedMs` (default 7,200,000), and `maxQaFixRounds` (default 2). Owner can set different finite values before start. Budget exhaustion blocks new work and reports the reason; it never reports completion. Reserve each QA fix round before dispatch; restart/handoff/new epochs do not replenish it. Existing per-Task attempt/repoke/respawn ceilings remain unchanged.
- Journal transitions reference common ledger epoch/event IDs and accepted artifact commits. Because this is not a cross-file transaction, persist command intent before dependent side effects and reconcile its recorded identity after restart. Core accept/landing remains the authority for whether a Task actually landed. Never mark a phase complete solely because a chat turn ended or a mailbox message arrived.
- A terminal cancellation stops active run Agents using existing lifecycle operations, records unresolved work, and retains evidence. It does not auto-accept Tasks, clear pending conflicts, or reset Project history. Those still need existing explicit resolution before switching mode.

### 6. Routing, Planning, and Artifact Ownership

The Lead chooses a track using scope, uncertainty and risk, records why roles were skipped, and can add a needed planning role without imposing the full pipeline:

| Track | Default flow | Requirement oracle |
|---|---|---|
| Small story/hotfix | Backlog Task → Dev → QA | Owner directive + backlog R IDs + existing contracts/design |
| Backend/CLI feature | PM → Architect → backlog Task → Dev → QA | PRD + architecture + backlog |
| UI/greenfield feature | PM → UX and Architect → readiness → UI decision when required → backlog Task → Dev → QA | PRD + design/experience + architecture + backlog |

A small auth, payments or migration change may need Architect. A cosmetic UI correction can use the small track with existing approved design; record why it introduces no new design decision. A new/changed user flow needs a new design revision/approval or explicit waiver. No mandatory PRD/EXPERIENCE is invented for the small track.

**Artifact location:** keep the requested `.scratch/<initiativeId>/` layout, but explicitly track the run's declared artifact files in Git. Local issue/spec/review files remain separate from runtime artifacts by manifest ownership. Do not change the repository's entire `.scratch` ignore rule or force-add the whole directory.

- During run admission detect ignored paths and collisions with existing local/tracked initiative files. Use a new initiative ID if the intended runtime namespace is already occupied by unrelated work. When `Supervisor` dispatches a directive via `supervisor_dispatch_lead` in Scrum mode without explicit `runId`/`scrum` metadata, the Scrum admission module automatically reuses the Project's active nonterminal Scrum run or admits a new run with a derived collision-free `initiativeId`, default `track`, and standard `.scratch/<initiativeId>/` artifact manifest (`prd.md`, `DESIGN.md`, `EXPERIENCE.md`, `mockups/index.html`, `architecture.md`, `sprint-backlog.md`, `qa-report.json`, `qa-report.md`).
- PM writes `prd.md` with Outcome, Out of Scope and stable FR/NFR/UJ IDs. UX writes `DESIGN.md`, `EXPERIENCE.md`, `mockups/index.html` and any explicitly owned assets. Architect writes `architecture.md` with Stack evidence and stable AD IDs containing Binds/Prevents/Rule. When `Scrum Lead` omits `artifact` on `lead_set_contract` for a non-`dev` specialist, the Scrum contract adapter supplies that role's canonical artifact path automatically.
- Each role/Task writes its own `decisions/<task>.jsonl` with decision/assumption IDs, severity, rationale and related requirements. Whenever `Scrum Lead` sets a Contract for `<task>`, the Scrum contract adapter automatically registers `.scratch/<initiativeId>/decisions/<task>.jsonl` (and any valid task-scoped `.scratch/<initiativeId>/mockups/...` or `.scratch/<initiativeId>/qa/...` paths) into `run.ownedPaths` and `contract.scope` across all specialist roles (including `dev`), so `Supervisor` never has to pre-guess future Task IDs at run admission. No two parallel Tasks append to the same `.memlog.md`. The run projection aggregates these records; the old shared log convention is replaced for Scrum runtime artifacts.
- Lead distills/slices through a short `role: pm` backlog Task that owns `sprint-backlog.md` and traceability metadata. This keeps commits in Task worktrees and root clean. Lead supplies the four-part brief and accepts the result; it does not leave uncommitted tracked backlog edits at root.
- Artifact Gates verify expected files exist in the claimed Git tree, match the manifest, and can be consumed from a freshly prepared downstream worktree. File existence only in an ignored working directory is insufficient. Preview/evidence ownership and sensitive-data exclusions are explicit.
- Continue existing bounded four-part Contracts. Dev briefs embed relevant R/AD/design rules and pin original source refs; distilled text is not a new authority that can silently diverge from accepted artifacts. Stable IDs are never renumbered/reused across revisions; references can be out of numeric order, and deprecated definitions keep identity.

### 7. Parallel Design, Readiness, and UI Approval

UX and Architect may run concurrently, at most within the existing parallel-wave limit, only when they share a landed PRD/foundation and have disjoint declared artifact ownership. If either needs the other's undecided contract, use serial work or an explicit dependency request.

- After both artifact Tasks land, Lead records a readiness decision against their exact refs: flows/states versus API/data/auth/offline decisions, unresolved assumptions, requirement coverage and inherited repository constraints. Contradictions block Dev even if both linters pass. A necessary reconciliation edit uses a new revision Task; the readiness decision alone never edits artifacts.
- UX provides 2–4 key screens for a substantial UI initiative; a bounded single-screen change may provide one justified screen. EXPERIENCE contains a screen×state matrix for `empty`, `loading`, `populated`, `error`, `offline`, `permission-denied`; each cell is required or explicitly N/A with a reason. Real domain copy, design tokens and keyboard-usable state switches are required for applicable screens.
- `mockups/index.html` uses self-contained offline assets. Browser verification runs with network disabled and records console errors, viewport/screenshots and functional state-switch checks. Static HTML lint is a structural smoke check, not proof of visual quality or offline behavior.
- A `design_review_requested` record pins Project, run ID, design revision, artifact commit and a digest over DESIGN, EXPERIENCE, mockup and owned assets. Lead sends Supervisor a report subtype `ui-review` with this identity and a preview reference. Preserve transport `kind: supervisor_report` and mailbox `kind: report`; add a validated optional `reportType`/structured Scrum payload rather than confusing the envelope discriminator with the business report type. Legacy message-only reports remain valid.
- Supervisor presents the preview and relays the Owner's `approved | changes_requested | waived` decision through a Scrum-only, correlation-authenticated decision operation. Owner and Supervisor acting on the Owner's explicit instruction can submit it; Lead and working Agents cannot approve their own design. Record actor/decision/request ID and rationale. A waiver is run/revision-specific and never silently changes the Project default.
- The writer rejects stale/replayed decisions for superseded revisions and enforces the decision at every Scrum Dev spawn/respawn path. Before readiness is complete, approval may be recorded but cannot unlock Dev. Any change to approved design artifacts invalidates its digest; unrelated architecture changes still require updated readiness.
- After an accepted UX Task, changes requested produce a new Task such as `ux-<initiative>-r02`, based on current HEAD and referencing its predecessor. The old Task/worktree is never reopened or assumed retained.
- When frozen `requireUiApproval` is false, journal a policy waiver tied to the design digest; readiness/browser checks still apply. Asking Supervisor to skip review during a run uses an explicit waiver event, not text parsing in the spawn guard.
- Serve the exact accepted mockup via a Project/run-scoped preview facility usable from the Factory surface, including a remote daemon. Do not assume the Owner can open the daemon's local filesystem path. Restrict resolution to declared artifacts/revisions, isolate executable mockup content from privileged surface context, and test offline/missing-resource presentation.

### 8. Dev Slices and Early QA

- Use one bounded vertical story per Dev Task, with exact Covers IDs, relevant AD Rules, design tokens/state obligations, regression invariants, exclusions and Gate command.
- For a new integration/foundation, `S-01` is a running end-to-end tracer bullet with the test harness. Do not force scaffolding into a hotfix on an existing foundation.
- QA can prepare acceptance scenarios, inspect the harness, and validate S-01 before the whole initiative is implemented. This remains a Task, not a standing seat or new SLP gate. Serial implementation is the default; parallel Dev still follows the existing disjoint-work laws.
- Dev uses TDD where executable behavior changes, preserves repository architecture and runs unit/integration plus required regression/build verification. Lead reviews the attested change and calls the unchanged core acceptance operation on GREEN eligible Tasks.
- Re-check artifact refs before dependent dispatch. Changed upstream rules/design invalidate readiness and dependent pending Contracts; completed work affected by a changed requirement gets explicit follow-up Tasks. Do not retroactively rewrite accepted evidence or reinterpret a completed Task under a new spec.

### 9. QA Evidence Delivery and Bounded Fix Loop

**Separate artifact delivery from product verification.** All Task acceptances still require GREEN, while a QA artifact Task may successfully prove the product defective. This release uses an explicit regression bundle, not expected-failure tests hidden in the active suite.

1. QA records a clean run of the pre-existing baseline first. It writes candidate integration/E2E tests in an owned artifact bundle at `.scratch/<initiativeId>/qa/<auditId>/bundle/`, outside active test discovery. The bundle includes original test bytes/hashes, target paths, runner configuration/command, fixture setup and manifest; no skip/xfail/softened assertion is allowed to hide a required defect.
2. QA executes the candidate suite explicitly in an isolated disposable harness against the attested product revision, retaining each command/exit/log/trace. Verify test discovery excludes the stored bundle from the baseline for the actual runner; do not assume `.scratch` is ignored by every test framework. If safe separation cannot be established, return `blocked` with evidence.
3. The QA Task's mechanical Gate validates the report/bundle schema and hashes, artifact tracking, reproducible evidence, unmodified product source, unchanged existing assertions, and the still-GREEN pre-existing baseline. Candidate-suite nonzero exits are recorded as product findings, not swallowed or described as passing. This lets the report/bundle land through normal GREEN artifact acceptance without installing red tests into the active baseline. If the baseline itself cannot pass, use Agent blocker escalation to persist the run blocker and evidence references; do not claim/accept a red artifact Task merely to land a blocked report. Retain referenced evidence across handoff/restart until explicit Project cleanup.
4. `qa-report.json` is the authoritative result; `qa-report.md` is a readable rendering. Record `auditId`, full product SHA, requirement/design refs, baseline result, candidate-suite run results, test IDs, evidence refs, lens findings and status `clean | defects_found | blocked | inconclusive`. Distinguish harness/environment failures from product defects; attach severity, requirement mapping, reproduction and evidence to each confirmed finding. Permit zero confirmed findings.
5. Use the four lenses `intent-alignment`, `blind-hunter`, `edge-case-hunter` (including claims/deletion checks), and `verification-gap` as a structured QA checklist in v0.0.52. One QA Task is not advertised as four independent reviewers. Independent parallel lens agents and finding-count quotas are out of scope; role/model independence from Dev is configurable, not a guarantee of disjoint blind spots.
6. Lead reviews and accepts the GREEN artifact Task. Before coding, reserve a persisted fix round when status is `defects_found`; create a new Dev fix Task whose brief pins the accepted bundle and report. It promotes the tests into the normal suite, preserves assertions, repairs product behavior, and runs those tests plus the existing regression/build Gate. Harness-only changes require explicit justification; QA cannot patch product code to make its audit green.
7. A clean candidate bundle also must be promoted into the active test suite through a bounded Dev verification Task; this does not consume a defect fix round. No run completes with unpromoted required tests.
8. After promotion/fix lands, create a fresh QA audit Task against that landed product SHA and current artifact refs. QA executes the active required suite twice with isolated fixtures; each run must pass on its first attempt, without retry-masked flakiness, skipped required cases or expected failures. This is a reproducibility check, not proof that all flakiness is eliminated. Record environment/seed, commands, counts and traces. Re-audit can reference unchanged bundle/tests rather than duplicating them.
9. Accepting the report itself advances HEAD. Define the verified product SHA as the last landed commit changing product, active tests or relevant configuration; report-only commits may follow it. Completion verifies that current HEAD descends from the attested SHA and the intervening diff contains only the run's declared report/evidence artifacts. Any later executable/test/config change invalidates the clean audit and requires re-audit.
10. At most two defect-fix rounds by default, counted per run across all audit IDs/Tasks/epochs/handoffs. Count consumed reservations even if dispatch fails, then reconcile that reservation idempotently; do not charge a duplicate request twice. After exhaustion, unresolved required findings, a baseline/harness blocker or inconclusive verification, block and report Supervisor. Never change `leadEligible` or auto-accept a red Task to escape the loop.

### 10. Document Linter and Completion Predicate

Add `factory lint-scrum-doc --kind <prd|ux|architecture|backlog|qa> --dir .scratch/<initiativeId>`. It is a standalone deterministic command, not a default step inserted into SLP Gates. Implement its pure validator under the Scrum module, with JSON output and line/category diagnostics; exit 0 when valid, 1 for validation findings, 2 for invalid invocation/unreadable input.

- PRD: required sections, stable unique FR/NFR/UJ definitions, no literal placeholders outside fenced code; explicit justification if a category is not applicable.
- UX: required design/experience/mockup artifacts, screen/state matrix with justified N/A, declared assets and structural HTML checks. Browser evidence is validated separately.
- Architecture: each unique stable AD definition has Binds/Prevents/Rule; preserve deprecated IDs and allow gaps across updates. Stack references actual manifests/lockfiles/runtime evidence; do not force upgrades or invent exact versions to satisfy a table. External compatibility ranges need a rationale.
- Backlog/traceability: definitions and references are parsed separately; FR/NFR/UJ → R → story → test/evidence mappings must resolve. Every in-scope requirement is assigned, blocked or explicitly deferred with a reason; unresolved mandatory coverage blocks completion. Reference order is not definition order.
- QA: validate the structured report, evidence paths/hashes, run counts/results, lens coverage, finding status and bundle promotion references. Heading presence does not prove a test ran. A structurally valid `defects_found` report is an acceptable artifact but cannot satisfy product completion.
- Do not port upstream `lint_spine.py`'s always-zero exit status blindly. Structural lint and Lead semantic review have different responsibilities.

The **Scrum-only completion predicate**, enforced by the run controller before a structured completed report is sent, requires: landed/closed required Tasks; current readiness; valid design approval/waiver when applicable; no unsafe unresolved assumptions; requirement coverage; all required regression bundles promoted; no unresolved required defects; current clean QA evidence for the executable product revision; no in-flight work or pending-conflict landing; and a clean Project root. Unit/Gate success alone is insufficient for a Scrum run. SLP completion reporting retains its existing rules.

### 11. Factory Surface, CLI, and Operational Isolation

- Project Header/Seats & Models expose selected mode, active run mode/revision, busy switch reason and current phase/approval/QA outcome. Do not infer execution identity from tab title.
- SLP keeps its existing topology, cards, profile actions and RPC shapes. Wrap it in a mode selection shell; add a separate Scrum roster view and Scrum RPCs (`factory.scrum.*`). Existing `factory.lanes.*` and legacy `factory profile` commands retain their explicit SLP storage semantics. Add explicit `factory scrum ...` config/profile/run/decision operations; `factory execution ...` manages selection. The UI routes edits to the appropriate mode store.
- Scrum renders eight cards: Supervisor, Scrum Lead / PO, PM / Analyst, UX Designer, System Architect, Senior Dev, QA / Test Architect, Watch & Retro. Watch/Retro remain two backing model values; editing the combined card writes both in one batch, mirroring existing behavior in its separate store.
- Common task snapshots may add optional Scrum execution metadata; old clients can ignore it. Scrum-specific snapshot building/validation is mode-local and failure-contained. SLP snapshots do not parse corrupt Scrum files. A shared Project index may report a failed Scrum Project without failing the entire index.
- Project-scoped calls, correlations and operation IDs prevent cross-Project mutation. Pending config changes are shown as future-run settings, separate from a running snapshot.
- Project reset/delete extend their existing Owner-only cleanup to owned Scrum run/harness/preview records without widening seat authority. Reset preserves selected mode and both model rosters, archives/resets runtime consistently and releases owned resources; delete removes Project-owned state. Machine-wide SLP/other Project files remain untouched.
- Telemetry records mode, policy revision, effective models, Task count, elapsed time, QA rounds, confirmed defects and Owner revision count; token usage is recorded when the provider supplies it. This supports later evaluation rather than promising unmeasured speed or quality gains.


## Consequences

Scrum adds specialist planning and independent product verification without changing SLP configuration, authority, prompts or acceptance. Separate stores, immutable execution bindings and durable decisions cost additional recovery and lifecycle code. Structural lint does not substitute for semantic readiness, browser verification or product QA. Accepted Tasks remain closed; all revisions and re-audits use new Task IDs.
