# paseo-factory

Verification line for coding agents: work is judged against criteria fixed before start by running mechanical checks rather than trusting the agent's word, with every step recorded in an append-only Ledger.

_Full historical prose and ADR citations: `docs/history/CONTEXT-2026-full.md` and `docs/adr/`._

## Language

### People and parties

**Agent** (or **Peer**):
Working agent (`factory-peer`, tab `Peer · <Task>`) executing a Task inside an isolated `Task worktree` under one of four **Peer dispositions** (`engineer` writable default; `scout`, `architect`, `reviewer` read-only with no `git commit` or `--sha`). Completes via `agent_claim` / `factory-claim` with a mandatory **6-Field Handoff** (`Outcome`, `Snapshot`, `Scope`, `Verification`, `Unknown / risk`, `Ownership`) or escalates via `agent_escalate_blocker` (`REOPEN_REQUEST`, `DEPENDENCY_REQUEST`, `BLOCKED`) while staying live for in-place reconciliation. Never edits a `Contract`.
_Avoid_: worker as a name for the agent (`worker` names the model lane only), bot, separate lanes per disposition

**Owner**:
Whoever sets or ratifies outcomes and final acceptance — the human, or a delegated seat (`Supervisor` on the Owner's word; `Lead` for intermediate Contracts and clean green-wave acceptance, with human override retained). Never the Agent working that Task.
_Avoid_: reviewer, user

**Supervisor**:
Owner's conversational delegate (`cwd = <project-root>`), fenced read-only on product code (`Seat write fence`). Clarifies intent and challenges packaging traps (`grilling`), inspects repo state read-only, dispatches via `supervisor_dispatch_lead` (ending turn at once), relays `Supervisor mailbox` reports and `Needs-human` items, accepts on Owner's word, and curates ratified rules in `AGENTS.md` / `CONTEXT.md`. Started only from onboarding, panel Supervisor start/adopt, or `Supervisor (Factory)` picker; never creates `Lead`, decomposes Tasks, or pushes externally.
_Avoid_: manager, orchestrator, assistant, Driver

**Lead**:
Presiding technical seat over Peers (`cwd = <project-root>`, co-located in the Project workspace with no Paseo `parent` link to `Supervisor`), dispatched only by `Supervisor`. Uses scout-first orientation (never reading framework `SKILL.md`s or `Design source`), splits directives into vertical `Serial Wave`s, sets `Contract`s, spawns `Peer`s in `Task worktree`s, reviews `report-<task>-<n>.md` + bounded `git show --stat` / per-file `git diff`, accepts green waves (`lead_merge`), maintains `Project notebook`, and reports via `lead_report_to_supervisor`.
_Avoid_: manager, foreman, orchestrator, "the loop", Driver, parenting `Lead` under `Supervisor`, routing mail to an archived `Lead`

### Work and criteria

**Project**:
One Git repository supervised by the factory (`<basename>-<sha1(gitRoot).slice(0,6)>`), owning `<stateDir>/projects/<project-slug>/` (`project.json`, `ledger.jsonl`, `mailbox.jsonl`, `notebook.md`, `usage.json`, `project-settings.json`, `report-*`, `gate-*`, `worktrees/*`) and its `T-01..N` / `seq` stream (`factory project register/list/doctor`, ADR 0059). Retains `missingRoot` identity if the folder is deleted so `Project delete` still purges it.
_Avoid_: workspace, folder, team, shared root `ledger.jsonl`
_Note_: `--workspace <dir>` on `factory supervisor dispatch`, `project register`, and `doctor` resolves to the Project's git root; the Project — not the subfolder — is what gets registered (ADR 0059).

**Task**:
Unit of work in a Project, identified by a filename-safe id and judged against one active `Contract`.
_Avoid_: job, ticket, lane

**Contract**:
Done-criteria fixed before a `Peer` starts: `Gate` command (mandatory for `engineer`, optional `""` for read-only dispositions), `disposition`, optional `Artifact` and root-memory `scope` opt-in (refused on read-only dispositions), and a `<= 2,500`-char 4-section brief (`1. Bounded Outcome`, `2. Contract Boundary & Regression Invariants`, `3. Excluded / Deferred`, `4. Verification`). Re-contracting opens a new **Contract epoch** (resetting Attempts) while keeping a live `Peer` in place (`resetPeer: false` default).
_Avoid_: spec, acceptance criteria, bare `gate`-only Contracts, retry cycle, Task version

**Workspace**:
Git working copy where a Task's work and `Gate` run and `Artifact` resolves — normally an isolated **Task worktree** (`<projectStateDir>/worktrees/<task>` on `factory/<task>`, copying `.worktreeinclude`, symlinking `node_modules`, reaping leaked child processes on cleanup, and landing `claimedCommit` on `Accepted`). **Workspace conflict** occurs only when live Workspaces nest or share overlapping explicit `scope` globs.
_Avoid_: repo, project dir, cwd, clone, sandbox, scope conflict, merge conflict

**Serial Wave**:
Bounded rolling-wave stage — normally one vertical user-journey Task after `<= 1–2` setup waves (and `<= 1` combined journey wave after a `context-ceiling` split), sharing a wave only when file surfaces are disjoint, each reaching a **Stable Checkpoint** (landed Project `HEAD`) before the next wave is contracted. **Project ingress lock** (`withProjectIngressLock`) serializes directive and Contract admission per Project.
_Avoid_: all-at-once roadmaps, horizontal micro-wave chains, test-only negative-matrix spirals, unaccepted green commits, execution mode/lane

**Wave Hardening** & **Recurrence Guard**:
`Recurrence Guard` is the two-strike causal filter (`observed → recurred → hardened → verified`, `<= 12` rows in `Project notebook`; folds same-cause rows, retires `verified` after 3 waves, expires `1x` after 5). At `recurred` (`>= 2` `seq`s), `Lead` applies `<= 1` **Wave Hardening** fix at `Stable Checkpoint`: Tier 1 mechanical `Gate` / extraction / script / `.worktreeinclude` fix; Tier 2 1-line contract pointer (`<= 2–3` waves) + end-of-directive `Proposal`; Tier 3 pruning violated `AGENTS.md` prose rules.
_Avoid_: "seen twice", single-incident rule bloat, backlog deferral, multi-paragraph `AGENTS.md` warnings

**Project notebook**:
`Lead`'s bounded (`<= 80` lines / `<= 4 KB`) memory at `<projectStateDir>/notebook.md` outside `<project-root>`, written via `lead_update_notebook` / `factory notebook` (`## 1. Verification & Run Recipe`, `## 2. Recurrence Guard`), injected into seat kickoff packets and wiped on `Project reset`.
_Avoid_: Lead recipes in `AGENTS.md` or Peer briefs, `<project-root>/.scratch/notebook.md`

**Gate** & **Artifact**:
`Gate` is the Contract's check command run in a detached process group (`-pgid` reaped on exit/timeout; optional `""` clean-`HEAD` synthetic green on read-only dispositions). `Artifact` is an optional workspace-relative path on writable Contracts required for a green `Verdict`.
_Avoid_: test step, check, dummy `echo ok` read-only gates, deliverable, output file

### Judging

**Claim** & **Attempt**:
A `Claim` (`agent_claim` / `factory-claim` with 6-Field Handoff and commit `sha`) opens one **Attempt** (`1..3` per `Contract epoch`, never overlapping) and triggers the `Gate` — evidence of intent, never completion. Re-claiming an already-green `sha` in the same epoch returns that `Attempt` idempotently without re-running `Gate` or re-notifying `Lead`.
_Avoid_: "done", report, submission, mute `{ task, commit }` claims, retry, iteration

**Verdict**:
Mechanical `green` / `red` judgment of an `Attempt`: clean tree before and after `Gate`, exit 0 (or clean read-only empty gate), required `Artifact` present, and no un-scoped edits to root `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md`. Green is evidence, not acceptance.
_Avoid_: result, status, pass/fail

**Accepted** & **Task closed**:
**Accepted** (`attempt_accepted`, refused while a `Gate` runs) lands a green `Attempt` locally into `<project-root>` (or closes commit-less read-only Tasks without merge; never pushes externally) — `Lead` accepts clean green waves after bounded diff review without test-polish re-contracting. **Task closed** (`task_closed` via `lead_close_task` / `lead_retire_task` / `factory close`) retires an unaccepted superseded/split Task, archiving its `Peer` and removing its `Task worktree` without merging.
_Avoid_: done, finished, passed, leaving superseded Tasks open, merging incomplete worktrees

**Watch** & **Watch question**:
Optional off-by-default record-only post-verdict headless pass on the `watch` lane scoring five **Watch question**s (`destructive-writes`, `test-weakened`, `stuck-loop`, `scope-creep`, `secret-leak`) as `name: probability` in `[0, 1]` into one `watch_written` line without affecting `Verdict`.
_Avoid_: watcher, monitor, alarm, "Jev", heuristic

**Proposal** & **Ratification**:
A **Proposal** (`gate-check`, `contract-draft`, `observation`) pairs `>= 2` `Recurrence Guard` `seq`s with a 4-line preview diff; **Ratification** is the Owner's adoption of it into tracked repo files (`AGENTS.md`, `CONTEXT.md`, `docs/adr/`, scripts) — recorded in git, never as a Ledger event.
_Avoid_: finding, recommendation, single-seq complaints, unratified edits to `AGENTS.md` / `CONTEXT.md`

**Flaw battery** / **Watch battery** / **Bypass battery**:
Trial-daemon calibration suites running planted **Arm**s + clean control, compared to ground truth with **Battery outcome** words (`hit`, `miss`, `noisy hit`, `false positive`, `failed`; or `choked`/`escaped`/`clean`/`failed`); runners never accept and refuse prod home.
_Avoid_: test suite, eval harness, pentest, pass/fail

### Permissions

**Permit ask** & **Choke policy**:
Plugin-answered `agent.permission_asked` hook (`deny-only` in `ledger.jsonl` for seats; command-stripped `permit_allowed` for Peers). **Choke policy** (Layer 2) default-allows inside a contracted `Peer`'s writable set (`Task worktree` ∪ `/tmp` ∪ non-protected state dir) minus dangerous git and native Paseo lifecycle tools (`seat-paseo-tool-fence`), and enforces `Seat write fence` on `<project-root>` (stripping non-interpreter heredocs before shell inspection).
_Avoid_: permission prompt, sandbox, warden, allowlist, parsing doc heredoc prose as commands

**Seat write fence** & **Git shim**:
3-layer boundary keeping `Supervisor`, `Lead`, and dispatchers off product code and protected `<stateDir>`: (1) provider tool/mode locks on `agent.create`, (2) `Choke policy` whitelisting only `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `GLOSSARY.md`, `.gitignore`, `.worktreeinclude`, `docs/**`, `.scratch/**`, and (3) `<stateDir>/bin` **Git shim** + package/process shims blocking destructive git globally, `supervisor-git-fence`, `lead-git-fence`, and un-scoped Peer `memory-write-fenced` commits (allowing worktree restores, worktree test-process cleanup, and read-only `npx` MCPs).
_Avoid_: prompt-only rule, advisory boundary, git wrapper, git hook

### Records

**Ledger**, **Report**, & **Meter**:
**Ledger** is the append-only `<projectStateDir>/ledger.jsonl` with stable **Ledger event identity**, local **Ledger sequence**, validated **Ledger import**, and preserved **Ledger import conflict** snapshots (ignoring legacy `execution` / `retro_written` / `fresh_eyes_written`). **Report** (`report-<task>-<n>.md`) renders one `Attempt` from Ledger lines. **Meter** incrementally extracts multi-provider native token/cost usage into four disjoint additive buckets (`meter_written` per terminal Attempt/Peer + debounced `<projectStateDir>/usage.json`) without spending cutoffs.
_Avoid_: log, history, shared root `ledger.jsonl`, summary, billing, per-turn Ledger spam, double-counting cache/reasoning tokens

### Running

**Spawn**, **Driver**, **Attempt ceiling**, & **Respawn**:
**Spawn** (`lead_dispatch_agent` / `factory spawn`) enforces single-active-Peer, model-adaptive `thinking`, and an isolated `Task worktree` before recording `spawn_dispatched` / `spawn_refused`. **Driver** (`factory run <task>…`, supporting **Parallel run** and branch-only **Unattended loop**) watches to `Verdict` without setting Contracts or Accepting; a Peer task closes only on a Ledger outcome since spawn (nudging once on an unclaimed turn end before reporting to `Lead`, ADR 0058). **Attempt ceiling** is `MAX_ATTEMPTS = 3` (`attempt-ceiling` on red Attempt 3). **Respawn** allows `<= 1` auto-replacement per progress marker after `Substrate death` (`died-after-respawn` on a second).
_Avoid_: launch, fork, orchestrator, runner, retry limit, restart, closing an idle/Esc-paused Peer without a Ledger outcome

**Denial-stall**, **Substrate death**, **Life signal**, **Re-poke**, & **Needs-human**:
**Denial-stall** is a live `Peer` stopped at a denied `Permit ask` with no `Claim` past grace, triggering **Re-poke** (`lead_repoke_agent`, embedding the active `Contract` snapshot and disposition claim rules). **Substrate death** is a missing daemon agent or stalled **Life signal** (timeline growth). **Needs-human** (`needs_human` with Ledger `seq` evidence) fires when bounded recovery is exhausted (`denied-again`, `silent-after-repoke`, `attempt-ceiling`, `died-after-respawn`).
_Avoid_: stuck, blocked, crash, hang, zombie, heartbeat, ping, nudge, alert, incident

**Lead mailbox**, **Supervisor mailbox**, & **Supervisor binding**:
Append-only `<projectStateDir>/mailbox.jsonl` (`to: "lead" | "supervisor"`): holds mail while the recipient is busy, asking permission, or in `Handoff`, batch-delivers when ready, and acks on completed turns; `Lead` mail lazily ensures/heals `Lead`, whereas `Supervisor` mail never auto-creates a `Supervisor`. **Supervisor binding** (`project.json` via single writer) auto-binds the first Supervisor candidate opened in the workspace when unbound, or adopts via `Use this chat as Supervisor`.
_Avoid_: mutable `outbox.json`, separate `supervisor-mailbox.jsonl`, hidden auto-created Supervisors, direct `agents.send`

**Pause (user)** & **Model switch**:
**Pause (user)** (mid-turn Esc/stop or sleep) is honored by inference: alive open-task Peers hold `Lead`'s quiet point, Esc turns are never nudged or closed, and paused extractions re-send within bounds. **Model switch** changes a live `Supervisor`/`Lead` model or thinking in place within the same provider family, keeping session context.
_Avoid_: Handoff for a same-provider model change

**Handoff** (**Supervisor handoff** / **Lead handoff** / **Peer handoff**):
Seat succession (`context-mark`, `provider-change`, `owner`) through `scheduled → handing over → creating successor → done | substitute handover | failed`, cancelable before successor creation. **Handoff mark** is `min(160k, 65% window)` for `Supervisor`/`Lead` (Needs-you prompt on `Supervisor`; quiet-point auto-rotation on `Lead`) and `min(200k, 80% window)` for `Peer` (`<= 1` auto-handoff/epoch before `context-ceiling`). Falls back to plugin-built **Substitute handover** on `Replace now` or failed/stale extraction (`docs/adr/0050-*`, `0057-*`). The one explicit replacement with no handover (Substitute included) is **Rotate seats** (ADR 0060), an Owner-only act.
_Avoid_: fixed 128k rule, blank successors, stale notes passed as fresh, auto-rotating `Supervisor`, rotating `Lead` with unsettled Peers, discarding `Peer` worktree progress

### Surface and configuration

**Factory surface**:
React Native Paseo UI scoped to one Project per workspace via the single writer: header Needs-you badge + update check, alert stack, **Team** / **Models** / **Project** tabs, `Hand off…` modal and model picker, composer seat pill, desktop **onboarding wizard**, and **Settings screen** (`docs/adr/0056-*`, `0057-*`).
_Avoid_: dashboard, room panel, Project switcher, Start Lead button, UI Task acceptance, Kanban/Timeline/Seat-graph, mobile settings writes

**Open Design project link**, **Design provenance note**, **Design catalog**, & **Design source**:
Per-Project Open Design sync into `<project-root>/design/` (`project-settings.json` + plugin-owned `design/open-design-link.json`, never overwritten by a Peer **Design provenance note**, `docs/adr/0040-*`, `0041-*`). `Lead` reads only **Design catalog** (`design-manifest.json`, `screens-data.js`, `app-data.js`, `screens.html`), never **Design source** (`index.html`, `app.js`, `*.css`) or batch screenshot/storyboard images (`*.png/*.jpg/*.webp`, delegating multi-screen visual parity checks to a read-only `reviewer`/`scout` Peer).
_Avoid_: zip exports, UI mockups in `Private vault`, `Lead` reading `app.js`/`index.html` or loading batch `evidence-*/` screenshots into its long-lived session

**Design overview canvas** & **Screen contracts**:
Desktop `Open Studio` (Dual-Path HTTP + RPC fallback) over Flow Board, framed Prototype, and Tokens (`docs/adr/0034-*`, `0037-*`, `0041-*`), with **Screen-state routing** (`?screen=<id>&state=<state>`), **Screen surface** (`mobile`/`desktop`/`responsive`), **Mobile app shell** (`390×844` touch shell), **Pure product chrome**, and **In-shell contextual state**.
_Avoid_: popup previews, mobile `<table>` dumps, in-mockup debug bars, full-screen diagnostic boxes

**Role provider**, **Lane config**, & **Lane profile**:
Three machine-reconciled Paseo providers (`factory-supervisor`, `factory-lead`, `factory-peer` with `resumeOnStartup: false`, `paseoTools.enabled: false`), rewritten per Project from five-lane **Lane config** (`lanes.json`: `supervisor`, `lead`, `worker`, `watch`, legacy `freshEyes`) on `agent.create.before`; **Lane profile** (`profiles.json`) applies copy-on-apply with no live pointer (`docs/adr/0017-*`, `0026-*`, `0055-*`, `0057-*`).
_Avoid_: `sw2-*` matrix, retired `zcode` provider, `retro` lane, live profile pointers

**Rotate seats**, **Project reset**, & **Project delete**:
Owner-only spool actions (`seat-cannot-rotate` / `seat-cannot-reset` for seats): **Rotate seats** (`factory project rotate` / Project `⋯` menu, ADR 0060) retires `Lead` then `Supervisor` with no handoff (bumping seat epoch, dropping `mailbox.jsonl` and handovers while keeping `notebook.md`, `lanes.json`, Ledger, and Task worktrees; refused on `peers-live`, `handoff-in-progress`, or `ledger-unreadable`); **Project reset** wipes seats/Peers/worktrees, Ledger/mailbox/notebook/`supervisor-handoff.md`/reports/gates, and `<project-root>` while keeping registration, `lanes.json`, and `project-settings.json`; **Project delete** removes all Factory/Paseo records and `<projectStateDir>` (`docs/adr/0024-*`, `0045-*`).
_Avoid_: manual `rm -rf`, cross-Project blast radius, confusing rotate with reset or delete, rotating with live unsettled Peers

**Pi harness home** & **Helper MCP catalog**:
**Pi harness home** (`<stateDir>/pi-agent/<role>`) provisions compaction-proof `APPEND_SYSTEM.md`, read-only `defaultTools` for `supervisor`/`lead`, `600s` `paseo_factory` MCP, and role-scoped skills. **Helper MCP catalog** (`<stateDir>/helper-mcps.json`) discovers host MCPs read-only and provisions Owner-synced servers + OAuth strictly to `Peer`s, never `Supervisor`/`Lead` (`docs/adr/0013-*`, `0016-*`, `0039-*`, `0042-*`).
_Avoid_: shadow home, auto-syncing host MCPs, mutating host configs, Helper MCPs on `Supervisor`/`Lead`

**Role-scoped MCP bridge**, **Correlation token**, & **Seat kickoff packet**:
Self-contained stdio MCP server (`paseo_factory`, `600s` timeout, zero relative imports) bound by **Correlation token** (`cor_<uuid>`) to expose only the caller's role tools over the Spool (`docs/adr/0016-*`, `0031-*`). **Seat kickoff packet** (`buildSeatKickoffPacket`) delivers deduplicated Turn-1 preflight, memory presence, `Project notebook`, lean Ledger digest (`lead_read_ledger` / `supervisor_read_ledger`), tools, and mail (`docs/adr/0047-*`).
_Avoid_: cross-role omnibus MCP, direct Paseo lifecycle tools, cold/duplicated Turn-1 prompts

**Companion plugin**, **Companion tool**, **Skill hub**, **Project skill pack**, & **Private vault**:
Settings surfaces for Paseo **Companion plugin**s (`factory-burn-lab`, private `factory-release-lab`), GitHub-cloned **Companion tool** packs (`~/.agents/skills` + `.skill-lock.json`), cross-harness **Skill hub** matrix, per-Project **Project skill pack**s (`expo`, `firebase`), and **Private vault** (`git:<owner>/factory-vault` syncing credentials, OAuth, lanes/profiles, Helper MCPs, skills, and Ledger snapshots — never UI mockups; `docs/adr/0012-*`..`0042-*`).
_Avoid_: vendoring third-party skills in repo, dumping all domain skills into every Project, UI bundles in `factory-vault`

### Retired terms (do not treat as live features)

- **Scrum mode** _(ADR 0056)_ — Agile Scrum (`Execution mode`, `Scrum role`, `Owner wait`, `Task allowance`, `UI Design Approval Checkpoint`, Scrum lanes/tools) deleted; SLP is the sole runtime.
- **Retro** _(ADR 0056)_ — Daily Retro CLI/pass and `retro` lane deleted; `Recurrence Guard` → `Wave Hardening` is the live loop.
- **Fresh-eyes review** _(ADR 0030)_ — Pre-Lead headless review (`fresh_eyes_written`) retired for `Lead` diff review.
- **Zcode harness home** _(ADR 0055)_ — `zcode-acp-server` / `<stateDir>/zcode-home` retired; GLM runs on `Pi harness home` (`pi/zcode/*`).
- **Web Console**, **Console sidecar**, **Design detector gate**, **Project switcher**, **All projects**, Task Kanban, Timeline swimlane, Ledger stream, Seat graph, global Factory screen _(ADR 0056)_ — deleted; Paseo plugin client is the sole `Factory surface`.
