# paseo-factory

Verification line for coding agents: work is judged against criteria fixed before start by running mechanical checks rather than trusting the agent's word, with every step recorded in an append-only Ledger.

_Full historical prose and ADR citations: `docs/history/CONTEXT-2026-full.md` and `docs/adr/`._

## Language

### People and parties

**Agent** (or **Peer**):
Working agent (`factory-peer`, tab `Peer · <Task>`) executing a provisional brief inside an isolated `Task worktree` under topology-blind framing and one of four **Peer dispositions** (`engineer` writable default; `scout`, `architect`, `reviewer` read-only with no `git commit` or `--sha`, where `reviewer` receives Outcome + Spec/Invariants + Diff/Commit only and argues the strongest `file:line` weakness before agreeing). Completes via `agent_claim` / `factory-claim` with a mandatory **6-Field Handoff** (`Outcome`, `Snapshot`, `Scope`, `Verification`, `Unknown / risk`, `Ownership`) or challenges flawed premises, broken Gates, missing prerequisites, or behavior-changing ambiguities via topology-blind `agent_ask` (`reopen_premise`, `gate_mismatch`, `dependency`, `clarify`, `blocked`; legacy alias `agent_escalate_blocker`), recording `peer_asked` in `Ledger` while staying live for in-place reconciliation. Never edits a `Contract`.
_Avoid_: worker as a name for the agent (`worker` names the model lane only), bot, separate lanes per disposition, leaking `Owner`/`Supervisor`/`Driver`/`GateQueue` internals into Peer prompts

**Owner**:
Whoever sets or ratifies outcomes and final acceptance — the human, or a delegated seat (`Supervisor` on the Owner's word; `Lead` for intermediate Contracts and clean green-wave acceptance, with human override retained). Never the Agent working that Task.
_Avoid_: reviewer, user

**Supervisor**:
Owner's conversational delegate (`cwd = <project-root>`), fenced read-only on product code (`Seat write fence`). Clarifies intent and challenges packaging traps (`grilling`), inspects repo state read-only (including deterministic `Loop Health` metrics in `supervisor_read_ledger` tracking `peer_asked` rate, silent `context-ceiling` stops, and genuine `complete.unknowns` gaps excluding `Gate queue` boilerplate), dispatches via `supervisor_dispatch_lead` (ending turn at once), relays `Supervisor mailbox` reports and `Needs-human` items, accepts on Owner's word, and curates ratified rules in `AGENTS.md` / `CONTEXT.md`. Started only from onboarding, panel Supervisor start/adopt, or `Supervisor (Factory)` picker; never creates `Lead`, decomposes Tasks, or pushes externally.
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
Provisional done-criteria fixed before a `Peer` starts: `Gate` command (mandatory for `engineer`, optional `""` for read-only dispositions), `disposition`, optional `Artifact`, root-memory `scope` opt-in (refused on read-only dispositions), optional `reopenConditions` (`<= 8` items, `<= 240` chars, rendered as `Reopen if:` in Peer briefs), and a `<= 2,500`-char 4-section brief (`1. Bounded Outcome`, `2. Contract Boundary & Regression Invariants`, `3. Excluded / Deferred`, `4. Verification`). Re-contracting opens a new **Contract epoch** (resetting Attempts) while keeping a live `Peer` in place (`resetPeer: false` default).
_Avoid_: spec, acceptance criteria, bare `gate`-only Contracts, retry cycle, Task version, framing Contracts as "immutable" to Peers

**Workspace**:
Git working copy where a Task's work and `Gate` run and `Artifact` resolves — normally an isolated **Task worktree** (`<projectStateDir>/worktrees/<task>` on `factory/<task>`, copying `.worktreeinclude`, symlinking `node_modules`, hydrating updated `node_modules` back to `<project-root>` via `.git/` staging on `Accepted` with backup-guarded stale staging cleanup, reaping leaked child processes on cleanup, and landing `claimedCommit` on `Accepted`). **Workspace conflict** occurs only when live Workspaces nest or share overlapping explicit `scope` globs.
_Avoid_: repo, project dir, cwd, clone, sandbox, scope conflict, merge conflict

**Serial Wave**:
Bounded rolling-wave stage — one vertical user-journey Task with at most **one active writable `Peer` (`engineer`) per Project** at a time after `<= 1–2` setup waves (and `<= 1` combined journey wave after a `context-ceiling` split), each reaching a **Stable Checkpoint** (landed Project `HEAD`) before the next writable wave is contracted (ADR 0068). **Project ingress lock** (`withProjectIngressLock`) is the sole re-entrant per-Project serialization lock across admission, `Lead mailbox`, and `Open Design` sync (bypassed by exclusive maintenance per ADR 0060 §7, with async settlement outside).
_Avoid_: all-at-once roadmaps, parallel writable Tasks in one Project, horizontal micro-wave chains, test-only negative-matrix spirals, unaccepted green commits, execution mode/lane, secondary per-Project lane queues

**Wave Hardening** & **Recurrence Guard**:
`Recurrence Guard` is the two-strike causal filter (`observed → recurred → hardened → verified`, `<= 12` rows in `Project notebook`; folds same-cause rows, retires `verified` after 3 waves, expires `1x` after 5). At `recurred` (`>= 2` `seq`s), `Lead` applies `<= 1` **Wave Hardening** fix at `Stable Checkpoint`: Tier 1 mechanical `Gate` / extraction / script / `.worktreeinclude` fix; Tier 2 1-line contract pointer (`<= 2–3` waves) + end-of-directive `Proposal`; Tier 3 pruning violated `AGENTS.md` prose rules.
_Avoid_: "seen twice", single-incident rule bloat, backlog deferral, multi-paragraph `AGENTS.md` warnings

**Project notebook**:
`Lead`'s bounded (`<= 80` lines / `<= 4 KB`) project-owned operational memory at `<projectStateDir>/notebook.md` outside `<project-root>`, written via `lead_update_notebook` / `factory notebook` (`## 1. Verification & Run Recipe`, `## 2. Recurrence Guard`); records strictly project verification/run facts and codebase recurrence mechanisms — never Factory MCP tool names, CLI flags, or SLP workflow laws — rides `Lead`/`Supervisor` kickoff packets and `Lead`/`Supervisor` `Substitute handover`s, never enters `Peer` briefs or `Peer` `Substitute handover`s, and is wiped on `Project reset` (`docs/adr/0052-*`, `0070-*`).
_Avoid_: Lead recipes in `AGENTS.md` or Peer briefs, Factory tool names or SLP rules in `notebook.md`, injecting `Project notebook` into Peer `Substitute handover`, `<project-root>/.scratch/notebook.md`

**Gate**, **Gate queue**, & **Artifact**:
`Gate` is the Contract's check command run in a detached process group (`-pgid` reaped on exit/timeout; optional `""` clean-`HEAD` synthetic green on read-only dispositions) with a configurable `timeoutSeconds` (`60–3,600s`, default `900s`) counted strictly from `gate_started` after dequeue (ADR 0068). Contracts run test runners sequentially by default, keep real build/bundle commands out of unit-test suites, and separate lightweight **Wave Gate**s (`lint + serial tests + typecheck`) from heavy **Checkpoint/Build Gate**s. **`Gate queue`** is the daemon-wide single-writer FIFO queue (`concurrency = 1` default, persisted at `<stateDir>/gate-queue.json`) that serializes every shell-command `Gate` (`agent_claim` and `lead_verify`) across all Projects with Owner **`Cancel`** and machine-wide **`Pause / Resume queue`** controls; read-only empty gates (`gate: ""`) bypass the queue and `Pause`, dequeued runs continue admitted work (`newWork: false`), and `Task closed` cancels matching items before taking `Project ingress lock`. `Artifact` is an optional workspace-relative path on writable Contracts required for a green `Verdict`.
_Avoid_: test step, check, dummy `echo ok` read-only gates, hardcoded 300s ceiling, nested bundler parallelism inside unit tests, concurrent Gates across Projects, deliverable, output file

### Judging

**Claim** & **Attempt**:
An asynchronous `complete` `Claim` (`agent_claim` / `factory-claim` with 6-Field Handoff and commit `sha`) validates clean tree + SHA synchronously, opens one **Attempt** (`1..3` per `Contract epoch`, never overlapping), records `gate_queued`, and enqueues into `Gate queue` under `Project ingress lock` — releasing the lock before async settlement (`Meter` / `Lead mailbox` wakeup) or legacy `Gate` execution — and returns immediately so the `Peer` ends its turn and sleeps live at zero tokens (ADR 0058, ADR 0068). Non-`complete` claims (`reopen`, `blocked`, `partial`) bypass `Gate queue` completely (`status: "handback"`, opening no `Attempt` and never eligible for `lead_merge`), persist `report-<task>-ask-<seq>.md`, append `peer_asked` (`source: "agent_claim"`), keep the `Peer` alive and paused without idle-nudges, and wake `Lead` via `Lead mailbox` (ADR 0069). `Peer`s run only fast slice checks during iteration and rely on `agent_claim` to run the full `Gate` once (no double-gate). On `gate_finished`, `GREEN` wakes `Lead` via `Lead mailbox`; `RED` on Attempts `1..2` wakes the live `Peer` directly with two-branch guidance (fix own code/tests and re-claim, OR call `agent_ask` immediately on a broken/stale Gate or Brief without weakening tests; falling back to `Lead mailbox` if the `Peer` is dead/archived); `attempt-ceiling` (RED #3) and Owner `Cancel` wake `Lead`. Re-claiming an already-green `sha` in the same epoch returns that `Attempt` idempotently without re-running `Gate` or re-notifying `Lead`.
_Avoid_: "done", report, submission, mute `{ task, commit }` claims, blocking RPC `agent_claim`, Peer pre-running full cumulative Gate before Claim, retry, iteration

**Verdict**:
Mechanical `green` / `red` judgment of an `Attempt`: clean tree before and after `Gate`, exit 0 (or clean read-only empty gate), required `Artifact` present, and no un-scoped edits to root `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md`. Green is evidence, not acceptance.
_Avoid_: result, status, pass/fail

**Accepted** & **Task closed**:
**Accepted** (`attempt_accepted`, refused while a `Gate` runs) lands a green `Attempt` locally into `<project-root>` (or closes commit-less read-only Tasks without merge; never pushes externally) — `Lead` accepts clean green waves after bounded diff review without test-polish re-contracting. **Task closed** (`task_closed` via `lead_close_task` / `lead_retire_task` / `factory close`) retires an unaccepted superseded/split Task, archiving its `Peer` and removing its `Task worktree` without merging.
_Avoid_: done, finished, passed, leaving superseded Tasks open, merging incomplete worktrees

**Release**, **Release mode**, **Release branch** & **Release request**:
**Release** (`lead_release`, run by the plugin server, never the seat shell) publishes an already-landed, Gate-verified `<project-root>` commit as `vX.Y.Z`: annotated tag, fast-forward push to the **Release branch** on `origin`, and a GitHub Release (notes from `CHANGELOG.md` `## [x.y.z]`, else generated). It edits no file and publishes no package (registries/stores belong to the Project's CI and `factory-release-lab`; loading a plugin build into Paseo stays the Owner's); version bump + changelog land first as an ordinary `engineer` wave. **Release mode** is the Owner-only per-Project setting `off` (default) | `on-request` (needs a **Release request** — release intent carried by `supervisor_dispatch_lead`, optionally pinning the version) | `auto` (`Lead` releases once at the end of a directive that landed product changes, choosing semver but never a major bump). **Release branch** defaults to the GitHub default branch. Only `Lead` releases — never `Supervisor` or `Peer`; seat shells cannot push, tag, or `gh release` (`release-fence`).
_Avoid_: deploy, ship (for the act), Release grant, Lead releasing in `off` / without a request in `on-request`, Owner hand-running tag/push/`gh release` as the normal path

**Store release**, **Store release mode**, **Store release request**, & **Store notebook**:
**Store release** (`lead_store_release`, run server-side via `factory-release-lab`, never in a seat shell) executes deterministic mobile store `probe`, async `stage` (Google Play `internal`/`draft` + App Store Connect / TestFlight with 0-token Apple `VALID` polling), `submit` (Play `production` / Apple App Review), or `resume` (answering a paused `Hole`, relaying any structured **Console handoff guide** verbatim into `Supervisor` chat so the Owner completes residual one-time Console clicks without back-and-forth), recording Project-level Ledger events (`store_release_started` / `paused` / `completed` / `failed`), writing back Day-0 Android keystores to `Private vault`, and waking `Lead` via `Lead mailbox`; async runs hold macOS idle-sleep inhibition (`caffeinate -i`) under a two-tier timeout contract (`15m` Phase 3 E2E / `30m` build & Apple `VALID` poll in `factory-release-lab`; `75m` detached `-pgid` outer ceiling with `5s` `SIGTERM` grace in `paseo-factory`, diagnosing outer timeouts read-only from `rel-*.json` as `runner-timed-out` / `tool-bug`); runner errors route either as `app-repo` (`<= 2` Peer repair waves through `Gate`) or `tool-bug` / `account-policy` (immediate halt + `Upstream issue` escalation). **Store release mode** is the Owner-only per-Project setting `off` (default) | `on-request` (requires a **Store release request** — typed `storeRelease` intent carried by `supervisor_dispatch_lead` for staging/production or `Hole` resume) | `auto-staging` (`Lead` triggers `lead_store_release({ action: "stage" })` right after `lead_release` succeeds on a mobile Project); production rollout / App Review submission always requires explicit Owner `target: "production"` or `final-release-approval` `Hole` approval. Seat exposure is **capability-gated** (`docs/adr/0071-*`): completely hidden on non-mobile Projects (`Supervisor` `hidden`, `Lead` disabled), reduced to a one-line panel pointer on mobile Projects with `mode: "off"` (`Supervisor` `off-hint`, `Lead` disabled), and unlocked (`Lead` + `Supervisor` `full` laws and MCP tools) only when the Project is mobile and `mode !== "off"`, retiring unstarted 0-turn seats, quiet-point handing off `Lead`, and surfacing `supervisorNeedsHandoff` (without auto-rotating a started `Supervisor` chat) across `off ↔ on` flips. **Store notebook** (`<paseoHome>/vault-runtime/store-memory/`, `0o400` read-only, synced via `Private vault` through `supervisor_record_store_note` / `lead_record_store_note` without dirtying `<project-root>`) holds cross-project `lessons.md` (`<= 120` lines) and per-app `apps/<canonical-app>.md` history.
_Avoid_: ad-hoc Peer upload scripts, running `release-lab` in seat shells, unattended production rollout, letting Peers hack around `tool-bug`s, personal keys or rejection logs in public repos, exposing Store Release laws/tools to non-mobile or `off` `Lead`s

**GitHub publish**:
Owner-only, one-time panel act that creates the Project's GitHub repository (account/org, name, description, Private by default or Public) and pushes it as `origin`. Visibility is chosen only here and never changed by the Factory afterwards; Public requires typing the repo name and passing a tracked sensitive-file check. No seat can publish.
_Avoid_: making a repo public/private later from the Factory, seat-driven repo creation

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
3-layer boundary keeping `Supervisor`, `Lead`, and dispatchers off product code and protected `<stateDir>` (`spool/**`, correlation/registration state): (1) provider tool/mode locks on `agent.create`, (2) `Choke policy` whitelisting only `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `GLOSSARY.md`, `.gitignore`, `.worktreeinclude`, `docs/**`, `.scratch/**`, plus `release-fence` blocking shell `git tag`, `git push`, `gh release`, and `gh repo create|edit` across all seats, and (3) `<stateDir>/bin` **Git shim** + package/process shims blocking destructive git globally, `release-fence`, `supervisor-git-fence`, `lead-git-fence`, and un-scoped Peer `memory-write-fenced` commits (allowing worktree restores, worktree test-process cleanup, and read-only `npx` MCPs).
_Avoid_: prompt-only rule, advisory boundary, git wrapper, git hook

### Records

**Ledger**, **Report**, **Meter**, & **Project usage**:
**Ledger** is the append-only `<projectStateDir>/ledger.jsonl` with stable **Ledger event identity**, local **Ledger sequence**, validated **Ledger import**, and preserved **Ledger import conflict** snapshots (ignoring legacy `execution` / `retro_written` / `fresh_eyes_written`). **Report** (`report-<task>-<n>.md`) renders one `Attempt` from Ledger lines. **Meter** incrementally extracts multi-provider native token/cost usage into four disjoint additive buckets (`meter_written` per terminal Attempt/Peer + debounced `<projectStateDir>/usage.json`) without spending cutoffs. **Project usage** is one Project's cumulative Meter total across every seat and session, distinct from a seat's **context occupancy** (`Nk / mark`). The Factory Project tab separates new tokens (uncached input + output) from cached tokens (cache reads + writes) across `All / 7d / 24h` active-session windows with normalized `(provider, model)` identities, plus desktop tabular breakdowns (`By Seat` with nested per-seat models, and `By Model`) ranked by new tokens with per-row cache-hit rate.
_Avoid_: log, history, shared root `ledger.jsonl`, summary, billing, per-turn Ledger spam, double-counting cache/reasoning tokens, "token count" for context occupancy, machine-wide usage in the Project panel

### Running

**Spawn**, **Driver**, **Attempt ceiling**, & **Respawn**:
**Spawn** (`lead_dispatch_agent` / `factory spawn`) enforces single-active-Peer, model-adaptive `thinking` (via `thinkingOptions` or same-base sibling models, preserved across auto `Peer handoff`, ADR 0054, ADR 0062), and an isolated `Task worktree` before recording `spawn_dispatched` / `spawn_refused`. **Driver** (`factory run <task>…`, supporting **Parallel run** and branch-only **Unattended loop**) watches to `Verdict` without setting Contracts or Accepting; a Peer task closes only on a Ledger outcome since spawn (nudging once on an unclaimed turn end before reporting to `Lead`, ADR 0058). **Attempt ceiling** is `MAX_ATTEMPTS = 3` (`attempt-ceiling` on red Attempt 3). **Respawn** allows `<= 1` auto-replacement per progress marker after `Substrate death` (`died-after-respawn` on a second).
_Avoid_: launch, fork, orchestrator, runner, retry limit, restart, closing an idle/Esc-paused Peer without a Ledger outcome

**Denial-stall**, **Substrate death**, **Life signal**, **Re-poke**, & **Needs-human**:
**Denial-stall** is a live `Peer` stopped at a denied `Permit ask` with no `Claim` past grace, triggering **Re-poke** (`lead_reply_peer`, with legacy alias `lead_repoke_agent`, recording `repoke_dispatched` with `kind: "denial-stall" | "ruling"` and truncated `message <= 1,000` chars, and embedding the active `Contract` snapshot including `Reopen if:`, topology-blind claim rules, and `agent_ask` reminder). **Substrate death** is a missing daemon agent or stalled **Life signal** (timeline growth). **Needs-human** (`needs_human` with Ledger `seq` evidence) fires when bounded recovery is exhausted (`denied-again`, `silent-after-repoke`, `attempt-ceiling`, `died-after-respawn`).
_Avoid_: stuck, blocked, crash, hang, zombie, heartbeat, ping, nudge, alert, incident

**Lead mailbox**, **Supervisor mailbox**, & **Supervisor binding**:
Append-only `<projectStateDir>/mailbox.jsonl` (`to: "lead" | "supervisor"`): serializes per Project via `Project ingress lock`, holds mail while the recipient is busy, asking permission, or in `Handoff`, batch-delivers when ready, and acks on completed turns; `Lead` mail lazily ensures/heals `Lead`, whereas `Supervisor` mail never auto-creates a `Supervisor`. **Supervisor binding** (`project.json` via single writer) auto-binds the first Supervisor candidate opened in the workspace when unbound, or adopts via `Use this chat as Supervisor`.
_Avoid_: mutable `outbox.json`, separate `supervisor-mailbox.jsonl`, hidden auto-created Supervisors, direct `agents.send`

**Pause (user)** & **Model switch**:
**Pause (user)** (mid-turn Esc/stop or sleep) is honored by inference: alive open-task Peers hold `Lead`'s quiet point, Esc turns are never nudged or closed, and paused extractions re-send within bounds. **Model switch** changes a live `Supervisor`/`Lead` model or thinking in place within the same provider family, keeping session context.
_Avoid_: Handoff for a same-provider model change

**Handoff** (**Supervisor handoff** / **Lead handoff** / **Peer handoff**):
Seat succession (`context-mark`, `provider-change`, `owner`) through `scheduled → handing over → creating successor → done | substitute handover | failed`, cancelable before successor creation, enforcing **4-Layer Context Isolation**: extracted handoffs (`4 KB` `Supervisor`, `8 KB` `Lead`, `12 KB` `Peer`) carry only project facts, product/technical decisions, verified state, `Dead Ends & Do-Not-Retry`, and repo-relative file pointers ordered **Priority-First** (dropping duplicated `Worktree Git Status` on `Peer`, normalizing `file://<root>/...` links to repo-relative paths, and truncating bottom-up with section-aware floors in `capHandoffText`) — never Factory MCP tool schemas, CLI flags, SLP laws, or runtime wiring bugs, enforced semantically in prompts rather than via server-side tool-name regex scrubbing so self-hosting stays intact (`docs/adr/0070-*`). **Handoff mark** is `min(160k, 65% window)` for `Supervisor`/`Lead` (Needs-you prompt on `Supervisor`; quiet-point auto-rotation on `Lead`, preserving rotation on `rotation_pending` even when `peer_asked` arrives) and `min(200k, 80% window)` for `Peer` (`<= 1` auto-handoff/epoch before `context-ceiling`). At ~50% of the `Peer` handoff mark (`turn_ended` only, once per epoch when `0` Claims and `0` `peer_asked` exist), an automated **Andon Checkpoint** prompts the `Peer` to check premises and call `agent_ask` before burning budget; automatic `Peer handoff` is choked while an unanswered `peer_asked` awaits `Lead`, and `200k` Peer-2 auto-handoff runs only for `engineer` Tasks with verified worktree progress (read-only dispositions and zero-progress `engineer` halt at `200k` with `BLOCKED (context-ceiling)`). Falls back to plugin-built **Substitute handover** (using Project-scoped Ledger events free of legacy root `git_blocked` noise, clean `user_message`/`assistant_message` timeline text with no raw JSON dumps or echoed extraction prompts, and omitting `Project notebook` on `Peer`) on `Replace now` or failed/stale extraction (`docs/adr/0050-*`, `0057-*`, `0069-*`, `0070-*`). The one explicit replacement with no handover (Substitute included) is **Rotate seats** (ADR 0060), an Owner-only act.
_Avoid_: fixed 128k rule, blank successors, stale notes passed as fresh, auto-rotating `Supervisor`, rotating `Lead` with unsettled Peers, discarding `Peer` worktree progress, spawning Peer-2 on unanswered `peer_asked` or zero-progress/read-only sessions, recording Factory tool schemas or old wiring bugs in handoffs, duplicating `worktreeDigest` git status in Peer extraction, server-side tool-name regex scrubbers, raw JSON timeline dumps or echoed extraction prompts in `Substitute handover`

### Surface and configuration

**Factory surface** & **Factory overview**:
React Native Paseo UI scoped to one Project per workspace via the single writer (`Team` / `Models` / `Project` tabs, header Needs-you badge + update check, alert stack, `Hand off…` modal and model picker, composer seat pill, **Settings screen**), plus **one** desktop global sidebar entry (`Factory` via `addSidebarHeaderItem`) opening **one** compact **`Factory overview`** screen (`paseo-factory-overview`, styled with `plugin/client/kit/` and `FACTORY_PALETTE`, ADR 0068). `Factory overview` combines the machine-wide **`Gate queue`** strip (`running` + FIFO `queued`, `Pause / Resume queue`, per-item `Cancel`, log jump), a compact registered **`Projects`** roster (seat/Peer pills, `Needs you` badge, latest Gate state, 1-click workspace jump), and a **`+ Onboard Project`** button launching the existing `OnboardingScreen` (consolidating the former standalone `Onboard Project` sidebar footer item into the single `Factory` entry; `docs/adr/0056-*`, `0057-*`, `0063-*`, `0065-*`, `0068-*`).
_Avoid_: multiple global Factory sidebar items/tabs, burying `Gate queue` inside Settings, Project switcher, Start Lead button, UI Task acceptance, Kanban/Timeline/Seat-graph, mobile onboarding/settings writes, redundant `First directive` input boxes on `Start Supervisor`

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
**Pi harness home** (`<stateDir>/pi-agent/<role>` for standing seats; `<projectStateDir>/pi-agent/agent/tasks/<task>/` for Task-bound Peers, with `<projectStateDir>/pi-agent/agent/` as the base for callers without a Task, selected by `PI_CODING_AGENT_DIR`) isolates each Task's one-off Contract skills within its Project's Peer skill settings and provisions compaction-proof `APPEND_SYSTEM.md` (kept free of Project-conditional `Store release` laws on shared `Supervisor`/`Lead` homes; `docs/adr/0071-*`), read-only `defaultTools` for `supervisor`/`lead`, `600s` `paseo_factory` MCP, and role-scoped skills. **Helper MCP catalog** (`<stateDir>/helper-mcps.json`) discovers host MCPs read-only and provisions Owner-synced servers + OAuth strictly to `Peer`s, never `Supervisor`/`Lead` (`docs/adr/0013-*`, `0016-*`, `0039-*`, `0042-*`).
_Avoid_: shadow home, auto-syncing host MCPs, mutating host configs, Helper MCPs on `Supervisor`/`Lead`

**Role-scoped MCP bridge**, **Correlation token**, **Live role contract**, & **Seat kickoff packet**:
Self-contained stdio MCP server (`paseo_factory`, `600s` timeout, zero relative imports) bound by **Correlation token** (`cor_<uuid>`) to expose only the caller's role and Project-enabled tools dynamically on `tools/list` and `tools/call` (hiding `Store release` tools unless the Project is mobile and enabled; `docs/adr/0071-*`) over the Spool (whose admission fails closed with `spool-internal-error` and expires leftover non-`upgrade` requests past a `600s` boot-replay TTL) — delivered per-session via `config.mcpServers` across all providers including `antigravity` on Paseo `>=0.17.1` (falling back to global `mcp_config.json` on `<0.17.1`; `docs/adr/0016-*`, `0031-*`, `0064-*`, `0067-*`). **Live role contract** delivers fresh, capability-gated non-Pi role instructions ephemerally via `agent.open.before` `appendSystemPrompt` on Paseo `>=0.17.1` (leaving `Pi harness home` on `APPEND_SYSTEM.md` and legacy pre-`0.17.1` sessions free of duplicate baked prompts; `docs/adr/0067-*`, `0071-*`). **Seat kickoff packet** (`buildSeatKickoffPacket`) delivers deduplicated Turn-1 preflight, memory presence, `Project notebook`, lean Ledger digest (`lead_read_ledger` / `supervisor_read_ledger`), capability-gated `Store release` instructions and machine-verified active/paused `Store release` state (`runId`, `action`, `platforms`, `status`, `phase`/`holeKind`, optional `guide`) folded from Project Ledger events for `Lead` and `Supervisor`, tools, and mail (`docs/adr/0047-*`, `0070-*`, `0071-*`).
_Avoid_: cross-role omnibus MCP, direct Paseo lifecycle tools, cold/duplicated Turn-1 prompts, global `paseo_factory` `mcp_config.json` on Paseo `>=0.17.1`, duplicating baked and live role contracts

**Companion plugin**, **Companion tool**, **Skill hub**, **Project skill pack**, & **Private vault**:
Settings surfaces for Paseo **Companion plugin** (`factory-release-lab`, private), GitHub-cloned **Companion tool** packs (`~/.agents/skills` + `.skill-lock.json`), cross-harness **Skill hub** matrix, per-Project **Project skill pack**s (built-in domains, source-derived groups, and Owner-authored custom packs in `skill-packs.json`; Core is always on), and **Private vault** (`git:<owner>/factory-vault` syncing credentials, OAuth, lanes/profiles, custom skill packs, Helper MCPs, skills, per-app `.env.local`, and Ledger snapshots — including pull-only `--runtime-only --project` runner hydration safe alongside a live daemon — never UI mockups; `docs/adr/0012-*`..`0042-*`, `0072-*`).
_Avoid_: vendoring third-party skills in repo, dumping all domain skills into every Project, UI bundles in `factory-vault`

### Retired terms (do not treat as live features)

- **Burn lab** & **Fleet connector** — retired companion plugins (`factory-burn-lab`, `factory-connector`); removed from `COMPANION_CATALOG` and Paseo runtime.

- **Scrum mode** _(ADR 0056)_ — Agile Scrum (`Execution mode`, `Scrum role`, `Owner wait`, `Task allowance`, `UI Design Approval Checkpoint`, Scrum lanes/tools) deleted; SLP is the sole runtime.
- **Retro** _(ADR 0056)_ — Daily Retro CLI/pass and `retro` lane deleted; `Recurrence Guard` → `Wave Hardening` is the live loop.
- **Fresh-eyes review** _(ADR 0030)_ — Pre-Lead headless review (`fresh_eyes_written`) retired for `Lead` diff review.
- **Zcode harness home** _(ADR 0055)_ — `zcode-acp-server` / `<stateDir>/zcode-home` retired; GLM runs on `Pi harness home` (`pi/zcode/*`).
- **Web Console**, **Console sidecar**, **Design detector gate**, **Project switcher**, Task Kanban, Timeline swimlane, Ledger stream, Seat graph, standalone `Onboard Project` sidebar footer item _(ADR 0056, ADR 0068; Paseo plugin client is the sole `Factory surface`, with one single `Factory` sidebar entry opening `Factory overview`)_ — deleted/consolidated.
