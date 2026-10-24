# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.36] - 2026-10-24

v0.0.36's one thing: **responsive 3-tier Kanban `Tasks` board (`wide` / `medium` / `compact`) with adaptive empty-column collapsing and multi-column card grids, status-accented 3-tier `KanbanCard` with `AttemptTrail` dots and compact `Accepted` density, and inline `Missing folder` Project deletion & Workspace Panel scope override** (ADR 0024, ADR 0025).

### Added

- **Responsive 3-Tier Kanban Layout (`plugin/client/factory/entries.tsx`, `plugin/client/factory/shell.tsx`, `plugin/client/factory/kanban.ts`, `plugin/client/factory/tasks.tsx`, `plugin/client/kit/pill.tsx`)** — Forwarded Paseo's `layout` context to `FactoryShell` and measured container width via `onLayout` (`resolveKanbanLayoutMode`):
  - **Wide (`>= 960px`)**: Empty (`0`-task) columns collapse into slim `132px` rails when `filter === "all"` and other columns have tasks; populated columns expand and flow heavy columns (such as 15 `Accepted` tasks) into a 2–3 column internal card grid (`computeCardGridColumns`), while 4–5 populated columns flex down (`minWidth: 180`) to fit inside `1024px` split windows without horizontal clipping.
  - **Medium (`640px – 959px`) & Compact (`< 640px` / `layout.compact`)**: Collapses empty stages into a compact `EMPTY STAGES` strip above multi-column wrapping (`medium`) or single-column vertical stacking (`compact`), shortens home paths (`/Users/<user>/...` → `~/...` via `shortenHomePath`), and adapts `TabBar` labels on compact viewports.
- **Status-Accented 3-Tier `KanbanCard` & `AttemptTrail` Dots (`plugin/client/factory/kanban.ts`, `plugin/client/factory/tasks.tsx`)** — Added 3px status accent borders on cards and columns, condensed multi-attempt history into bounded colored status dots (`summarizeAttemptTrail` / `AttemptTrail`) instead of rendering 6–9 separate pill boxes per card, rendered `Accepted` cards in a compact 2-row completed density, and removed the redundant `Details` button from the card face.
- **Inline `Missing folder` Project Deletion & Danger Callout Banner (`plugin/client/factory/header.tsx`, `plugin/client/factory/shell.tsx`, `plugin/server/surface-rpc.ts`)** — Surfaced an inline two-step `Delete` → `Confirm Delete` / `Cancel` button directly on `missingRoot: true` project chips in the Project Switcher bar, replaced vacant-seat startup hints (`Select "Supervisor (Factory)" in New Chat to start` / `Spawned automatically by Supervisor`) with a red danger callout banner when a missing-folder Project is selected, and fixed `FactoryShell` (`hasPickedScope`) so selecting a Project or `All projects` in the Project Switcher overrides the default `dir` prop in `FactoryPanel`.

## [0.0.35] - 2026-10-24

v0.0.35's one thing: **greenfield Git bootstrap on Project onboarding, selectable missing-root Projects & Owner-only `Project delete`, a Project-centered Header with native macOS Finder folder picker, a 5-column Kanban `Tasks` board, and a dedicated `Vault` tab** (ADR 0024, ADR 0025).

### Added

- **Automatic Greenfield Git Bootstrap & Role-Provider Project Discovery (`src/project.ts`, `plugin/server/roles.ts`, `plugin/server/surface-rpc.ts`)** — Starting `Supervisor (Factory)` or `Lead (Factory)` in a non-Git directory (or adding/selecting a non-Git directory through the `Factory surface`) automatically initializes Git (`git init`) with an initial empty commit (`chore: initialize repository`) while refusing `/`, `$HOME`, `<paseoHome>`, `<stateDir>`, and non-existent paths. Project discovery recognizes live `factory-supervisor`, `factory-lead`, and `factory-peer` Role-provider sessions even without legacy `labels.seat` metadata and enriches every discovered Project with `name`, `commonDir`, `supervisorId`, `leadId`, and `activeTaskCount`.
- **Missing-Root Project Selection & Owner-Only `Project delete` (`factory.project.delete` RPC, Spool guard, and `factory project delete` CLI)** — Registered Projects whose folder was deleted in Finder are marked `missingRoot: true` and remain selectable in the Project Switcher using their persisted `project.json` identity instead of snapping back to `All projects`. `Project delete` permanently stops and archives bound seats and working `Agent`s, removes temporary worktrees and `factory/*` branches when the repository still exists, purges Project events from the `Ledger` along with reports, gate logs, retro files, and correlations, deletes `<stateDir>/projects/<slug>/` (including `project.json` and `lanes.json`), and sweeps the Project's workspace and project records from Paseo while refusing seat callers (`seat-cannot-delete`).
- **Native macOS Folder Picker (`factory.project.pick.folder` RPC) & Paseo Workspace Sync (`plugin/server/surface-rpc.ts`)** — `+ Add Project` opens the native macOS Finder folder dialog (`osascript` `choose folder`), handles user cancellation cleanly, bootstraps Git when needed, registers the Project, and synchronizes with Paseo's workspace registry.
- **Project-Centered Header & Dedicated `Vault` Tab (`plugin/client/factory/header.tsx`, `plugin/client/factory/vault.tsx`, `plugin/client/factory/shell.tsx`, `plugin/client/kit/pill.tsx`)** — Removed the 5 KPI stat tiles and full-width `Private vault` bar from the persistent Header, centering the Header on a prominent **Project Switcher** with per-project task counts, `Missing folder` badges, `+ Add Project` picker + collapsible path fallback, live `Supervisor`/`Lead` status and `Open` jump links, and two-step `Reset Project` / `Delete Project` actions, while moving `Private vault` into its own fifth `Vault` tab (and the Settings screen).
- **5-Column Kanban `Tasks` Board (`plugin/client/factory/kanban.ts`, `plugin/client/factory/tasks.tsx`)** — Replaced the vertical workspace-grouped list in `Tasks` with a 5-column horizontal Kanban board (`Queued`, `In Progress`, `Needs Attention`, `Ready to Accept`, `Accepted`) featuring per-column live Task counts, a compact toolbar with column filter chips and `Total Cost` + token summary pill, scannable cards with Attempt rung badges, evidence pills (`Gate`, `Choke`, `Eye`, `Watch`, `Cost`), direct `Accept #n` CTA on `Ready to Accept` cards, and `TaskDetailModal` on selection.

## [0.0.34] - 2026-10-23

v0.0.34's one thing: **two-phase reviewed plugin update protocol (`preview` → `apply`), Core-last batch `Update All`, graceful Core self-restart tracking, live per-card & toolbar elapsed progress (`Ns`), and persistent inline status/error banners in the `Plugins` view** (ADR 0012).

### Added

- **Live Per-Card & Toolbar Elapsed Progress (`plugin/client/factory/plugin-feedback.ts`, `plugin/client/factory/plugins.tsx`, `plugin/client/factory/shell.tsx`)** — Active plugin actions (`check`, `install`, `manage`, `restarting-core`) render live `accent`-toned progress pills on both the `Plugins` toolbar (`Updating paseo-factory… · 4s`, `Reloading Core paseo-factory… · 3s`, `Updating All… · 6s`, `Installing factory-burn-lab… · 2s`) and the targeted plugin card (`Updating 0285a1c → 383385c… · 4s`, `Reloading Core → 383385c… · 3s`, `Installing from GitHub… · 5s`), alongside elapsed-second button labels (`Updating… (4s)`, `Installing… (5s)`, `Updating All… (6s)`, `Installing All… (4s)`).
- **Persistent Inline Status/Error Banners & Per-Card Error Boxes (`plugin/client/factory/plugins.tsx`, `plugin/client/factory/shell.tsx`)** — The `Plugins` toolbar renders a dismissible inline status/error banner (`pluginsNote` with `statusSuccess` / `statusWarning` / `statusDanger` tone) recording the exact outcome of the latest `Check for updates`, `Install`, or `Manage` act, and any per-plugin failure also renders directly inside that plugin card's red error box (`cardError`) until dismissed or retried.
- **Graceful Core Self-Update & Self-Reload Restart Tracking (`isCoreSelfRestartError`, `resolveCoreRestartWatch`)** — When updating or reloading `paseo-factory` stops the running Core worker mid-RPC (`"Plugin stopped: paseo-factory"`), `FactoryShell` transitions into `Reloading Core…` and polls `factory.snapshot` at 1s intervals until a fresh post-restart snapshot confirms `corePlugin` is `running` on the target revision (or surfaces a `statusDanger` failure on daemon error or 45s timeout).

### Fixed

- **Two-Phase Reviewed Plugin Update Protocol (`plugin/server/daemon-cli.ts`)** — Replaced the retired `plugin.source.update.request` (rejected in 1ms by `@getpaseo/server@0.11.4` with `"Update the client to review plugin updates before applying them."`) with Paseo's two-phase `plugin.source.update.preview.request` → `plugin.source.update.apply.request` protocol on the 300s plugin-I/O timeout, handling `"current"`, `"installed-newer"`, `"local"`, `"error"`, and `"update"` outcomes and unified CLI fallback `outcome` parsing.
- **Core-Last Batch `Update All` (`plugin/server/surface-rpc.ts`)** — `SurfaceHandlers.pluginsManage({ pluginId: "all", action: "update" })` sorts `Companion plugin`s ahead of `paseo-factory` (`CORE_PLUGIN_ENTRY.id`) so companion updates finish before the Core plugin restarts its own worker.

## [0.0.33] - 2026-10-23

### Added

- Stable Ledger event and Contract-epoch identities, source-to-local reference mapping, and writer-owned staged imports with explicit pending/applied/conflicted outcomes.
- Explicit history preflight, byte/mode/hash-verified backups, activation, resume and guarded restore. Startup exposes recovery controls while ordinary work remains deferred.
- Checked canonical policies with committed standalone outputs, generated/core drift checks, isolated installed-plugin checks, and push/PR CI on Node 22 and 24.
- Validation report and history-upgrade runbook covering local regressions and disposable trial evidence.

### Changed

- Task and Attempt projection is shared by acceptance and CLI/MCP/UI diagnostics; Spool dependencies and command execution use explicit interfaces.
- Vault codec, transport, configuration and materialization are separated behind the existing public interface. Downloads stage durably while Tasks run; associated files remain under owner maintenance, and retries release held imports without duplicating facts.

### Fixed

- Authenticated Lead acceptance cannot bypass required review or Needs-human restrictions through omitted or forged attribution; every role still requires green evidence.
- Artifact paths cannot escape the actual execution Workspace through absolute paths, parent traversal or symlinks.
- Gate completion waits for bounded descendant cleanup, and command shims preserve nonzero exits and signal termination.
- Scope globs agree across supported fences, including Antigravity; worktree includes copy only selected files and preserve clean-tree hygiene.
- Imports preserve existing local sequence addresses and evidence citations; divergent or ambiguous history retains original bytes instead of choosing by timestamp or append order.
- CLI/MCP readers reject complete corruption and invalid v2 timestamps consistently, exclude unterminated tails, and leave read-only files unchanged.
- Recovery startup no longer strands interrupted upgrades; late external Vault refusal feedback cannot downgrade an applied import.
- Large upgrade/Vault JSON replies flush completely before CLI exit.

### Verification

- Required checks pass with 885 tests on Node 22.22.0 and 24.21.0; installed packaging checks pass independently.
- Disposable trial runs verify authenticated acceptance, deferred/imported/conflicted history, backup/restore, recovery boot/resume, busy CLI-to-owner Vault retries and exact cleanup. The real root Ledger remains legacy; persistent upgrade is explicit and is not performed at boot.

## [0.0.32] - 2026-10-23

### Added

- Package-manager seat fences and OpenCode-only delegation to installed command shims, so refusals return actionable tool output without aborting the turn.
- Glob-aware contract scopes and concrete recovery commands against the contract base.
- Supervisor diagnostics and Lead entrypoint/lockfile laws.

### Fixed

- OpenCode headless lanes retain the read tool schema while rejecting runtime tool access.
- Re-contracting preserves active task worktrees and their original base commit.
- Pending-conflict acceptance can retry landing; transient untracked test outputs no longer block verification or landing.
- Task worktrees inherit root dependencies, and successful landing hydrates root dependencies from real worktree installs before cleanup.
- Git-installed plugin bundle boundary: `plugin/server/choke.ts` resolves hook/permission types from `@getpaseo/plugin/server` (instead of `@getpaseo/protocol/agent-types`), and `scripts/check-bundle.mjs` enforces isolated-checkout type resolution so `paseo plugin install git:daymanondev/paseo-factory:plugin` builds cleanly without a root `node_modules`.

## [0.0.31] - 2026-10-22

v0.0.31's one thing: **co-located `Supervisor` & `Lead` inside one main Project Workspace, role-first seat & `Peer` worktree titles, safe `Task worktree` cleanup that never kills sibling running Peers, an orphaned `local_checkout` Workspace sweep, and offline spool request deduplication with an explicit stop-on-timeout instruction** (ADR 0017 §2/§4/§5/§6).

### Added

- **Co-located `Supervisor` & `Lead` workspace binding (`plugin/server/roles.ts`, `plugin/server/surface-rpc.ts`, pinned in `test/roles.test.ts` and `test/surface-rpc.test.ts`)** —
  `injectSessionEnv` accepts the seat session's `workspaceId` and persists it into `<projectStateDir>/project.json` (only when the session actually binds the seat), `SurfaceAgentSnapshot` carries `workspaceId`, and `ensureSeat` resolves the Project's main Workspace from the live `Supervisor` snapshot → the project registration before ever calling `workspaces.open`, creating `Lead` via `workspaces.ref(workspaceId).agents.create` so `Supervisor` and `Lead` sit side-by-side as two Agent tabs in ONE main Workspace instead of splitting across two `local_checkout` Workspaces.
- **Role-first agent tab titles & clean `Peer` worktree Workspace titles (`src/roles-contract.ts`, `plugin/server/roles.ts`, `plugin/server/spool.ts`)** —
  `SEAT_TITLES` becomes `Supervisor` / `Lead` (legacy `"Supervisor (paseo-factory)"`-style titles still recognized), `injectRoleOnCreate` stamps `config.title` on all three create paths, and the new `formatPeerAgentTitle` / `formatPeerWorkspaceTitle` helpers title each `Task worktree` Workspace `Peer · <Task> — <short summary>` (first clause of the contract description, capped at 56 chars, never the internal project-slug hash) with the `Peer` Agent tab inside titled `Peer · <Task>`.
- **Orphaned `local_checkout` Workspace sweep (`plugin/server/daemon-cli.ts`, `plugin/server/surface-rpc.ts`, `plugin/index.server.ts`)** —
  on `factory.project.reset`, `ensureSeat("supervisor")`, and a new `Supervisor` `agent.session_open`, any `local_checkout` Workspace of the Project with zero non-archived agents (excluding the keep-set — the active `Supervisor`/`Lead` Workspace) is archived; active user chats and Workspaces hosting live agents are never touched.
- **Offline spool request deduplication & stop-on-timeout instruction (`plugin/bin/bridge.mjs`, `plugin/bin/spool-client.mjs`, `plugin/server/spool.ts`, `plugin/bin/factory-claim.mjs`, `plugin/bin/factory.mjs`)** —
  a canonical semantic key (every request field except `id`) deduplicates pending requests at submit time (an identical un-replied request reuses the pending id instead of writing a second file) and at drain time (`startSpool` mirrors the primary's reply to duplicate ids and moves their files to `processed/` without a second Gate attempt or Ledger mutation); `spool-timeout` now returns the explicit "DO NOT retry … end your turn immediately" instruction while the single deduplicated request stays queued in `spool/requests/`. A stopped plugin is never auto-reloaded from `bridge.mjs`.
- **`leadMail.pumpAll()` on `capturePaseo` (`plugin/server/lead-mailbox.ts`, `plugin/index.server.ts`)** —
  queued Lead/Supervisor mail pumps immediately on the first `paseoApi` capture transition (and at boot when already captured), closing the startup race where an early spool drain enqueued a verdict before the daemon API was available to wake `Lead`.
- `PASEO_FACTORY_SPOOL_WAIT_MS` env override for the bridge's spool wait (default unchanged at 60s) — additive hook so the timeout arm is testable at test scale.

### Fixed

- **Accepting one task no longer mass-archives sibling running `Task worktree`s (`plugin/server/daemon-cli.ts`, `plugin/server/surface-rpc.ts`)** —
  `cleanupDaemonWorkspacesAndProjectsViaWs` archives a worktree Workspace only when its directory no longer exists on disk or it is the explicitly retired `targetWorktreePath`; sibling Workspaces whose worktree directories still exist (`T-10`, `T-11`, `T-13`, … running mid-wave) are never archived, while top-level Project rows under `worktreesDir` or missing on disk are always removed.
- **Spawn path no longer clobbers the persisted main workspaceId (`plugin/server/spool.ts`)** —
  `resolveSpawnWorkspaceAndParent` seeds the registration's `workspaceId` from `workspaces.open` only when the registration carries none, mirroring `ensureSeat`'s never-overwrite law, so an early `lead_spawn_agent` can no longer re-point the Project at a different `local_checkout` Workspace.
- **`drainLeadMailbox` auto-ensures a closed/archived `Lead` seat and `driverWaveInFlight` ignores dead worktree spawn rounds (`plugin/server/lead-mailbox.ts`, pinned in `test/lead-mailbox.test.ts`)** —
  `drainLeadMailbox` now mirrors `drainSupervisorMailbox` by calling `deps.ensureLead({ projectRoot })` when mail is queued and no live `Lead` is present, and `driverWaveInFlight` cross-checks worktree `spawn_dispatched` rounds against live non-archived `running`/`initializing` agents on the daemon so an orphaned historical spawn round never holds subsequent `Peer` verdicts.
- `persistSeatWorkspaceId` is gated on `bindSeatAgentId`'s boolean return — a second session that does not own the seat can no longer overwrite the registration's `workspaceId`.
- `package.json` + both `package-lock.json` version spots + `SHELL_VERSION` + `bridge.mjs` `serverInfo.version` → `0.0.31`.

## [0.0.30] - 2026-10-22

v0.0.30's one thing: **a private/invite-only companion tier for `factory-release-lab` — an explicit `access: "public" | "private"` across the catalog and view, public-only `Install All`, a pre-flight pull-access probe on explicit private installs, and per-plugin fault isolation for update checks** (ADR 0012 + ADR 0014 amendments).

### Added

- **Private companion access tier (`plugin/shared/companions.ts`, `plugin/shared/view.ts`, `plugin/server/view.ts`, pinned in `test/surface-rpc.test.ts`)** —
  `PluginAccessTier` lands on `CorePluginCatalogEntry` and `CompanionCatalogEntry` (`paseo-factory`, `factory-burn-lab`, `factory-connector` → `"public"`; `factory-release-lab` → `"private"`), flows through `CompanionPluginViewSchema` via `foldCompanions`/`foldCorePlugin`, and `CompanionCard` renders a `Private · Invite-only` pill for private non-core companions.
- **Pre-flight pull-access probe for private companions (`src/vault.ts` → `plugin/server/core/vault.ts`, `plugin/server/surface-rpc.ts`)** —
  `probeCompanionGitAccess` normalizes `git:`/`github:`/`https://github.com/` (plus `ssh://git@github.com/…` and scp-style `git@github.com:…`) sources, runs `gh auth setup-git --hostname github.com` best-effort when `gh` is authenticated, verifies pull access with `git ls-remote --heads --`, and — when verification fails — refuses with `code: "private-companion-access-denied"` naming `@<ghUser>` and the repository (or instructing `gh auth login`) before the daemon is ever invoked. Local directory sources skip the probe.

### Changed

- **`Install All` is public-only (server + client)** — `pluginsInstall({ target: "all" })` filters `COMPANION_CATALOG` to uninstalled `access === "public"` entries so batch installs never trip on the private repository, and `PluginsPane`'s toolbar button uses the same predicate, so it disappears once every public companion is installed while `factory-release-lab` remains `not_installed`.

### Fixed

- **Per-plugin update fault isolation (`plugin/server/daemon-cli.ts`)** — when the batch `plugin.source.status.request` fails (e.g. an installed plugin's repository became inaccessible), `checkDaemonPluginUpdates` now falls back to one `plugin.source.status.request` per installed plugin, collecting every succeeding row, so one broken repository no longer hides `Check for updates` for the rest of the ecosystem.
- `package.json` + both `package-lock.json` version spots + `SHELL_VERSION` + `bridge.mjs` `serverInfo.version` → `0.0.30`.

## [0.0.29] - 2026-10-22

v0.0.29's one thing: **live multi-task wave & OpenCode MCP runtime hardening — automatic `contract.base` refresh across sequential task landings, worktree preservation on contract re-scoping, companion lockfile & `npm install` artifact tolerance, auto-resolved `lead_needs_human` ledger sequences, `Supervisor`/`Lead` write-fence enforcement, and OpenCode `factory-peer` spawn compatibility**.

### Fixed

- **Live multi-task wave & MCP bridge hardening (`src/workspace.ts`, `src/lanes.ts`, `src/choke.ts`, `src/role-providers.ts`, `src/roles-contract.ts`, `plugin/server/spool.ts`, `plugin/server/roles.ts`, `plugin/server/choke.ts`, `plugin/server/daemon-cli.ts`, `plugin/bin/bridge.mjs`, `plugin/index.server.ts`)** —
  1. *Pre-registered wave `contract.base` & worktree preservation:* When `Lead` pre-registers contracts (`T-01..T-09`) upfront and an earlier task is accepted (`attempt_accepted`), spawning the next un-claimed task automatically refreshes `contract.base` to `<project-root>` `HEAD`. When re-spawning the same task after a contract/scope update whose `baseCommit` is already an ancestor of `worktrees/<task>` `HEAD` on `factory/<task>`, `allocateTaskWorktree` reuses the worktree without wiping committed/in-progress work.
  2. *Companion lockfiles & untracked `npm install` artifacts:* `scopeCoversFile` automatically covers companion lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, `npm-shrinkwrap.json`) whenever `package.json` in the same directory is in `scope`, and `checkCleanAt` ignores untracked `?? node_modules/` and untracked lockfiles left by `npm install`.
  3. *Auto-resolved `lead_needs_human` ledger sequences & `lead_repoke_agent` delivery:* `lead_needs_human` auto-resolves the corroborating `seq` pair from the current `Contract` epoch in `ledger.jsonl` when omitted or approximate, and `warmPluginDaemonApiViaWs` invokes `plugin.rpc.invoke.request` (`factory.snapshot`) on boot/reload so `paseoApi` is captured within `<100ms`.
  4. *OpenCode `factory-peer/<model>` spawn format, `auto_accept` preservation, and `opencode` CLI lane invocation:* `resolvePeerSpawnProvider` returns `"factory-peer/<model>"` (`provider/model` format), `reconcilePaseoRoleProviders` sets `defaultPermissions.mode: "auto_accept"` on the `Supervisor (Factory)` profile, `applyProviderExecutionFence` preserves `mode: "auto_accept"` on `Supervisor`/`Lead`/`Peer` while blocking `Supervisor`/`Lead` source writes on `<project-root>` in `choke.ts`, and `laneCliInvocation` avoids duplicating `opencode/` on `opencode/<provider>/<model>` lanes.
- `package.json` + `SHELL_VERSION` + `bridge.mjs` `serverInfo.version` → `0.0.29`.

## [0.0.28] - 2026-10-21

v0.0.28's one thing: **airtight `Lead handoff` with three-source Attempt-1 active peer roster resolution, silent seat creation and unified single-turn successor kickoff, a dual-fuse `90s` handoff extraction safeguard, and smart-default `Fresh-eyes review` on `Lead` contracts** (ADR 0018).

### Added

- **Three-source `Machine-Verified Active Peer Roster` resolution (`plugin/server/lead-mailbox.ts`, `plugin/server/spool.ts`, pinned in `test/lead-mailbox.test.ts` and `test/spool.test.ts`)** —
  `agentOfTask` resolves each unaccepted `Task`'s bound working `Agent` across three deterministic sources in priority order: (1) live non-archived daemon agents whose `cwd` sits at or inside `taskWorktreePath(stateDir, slug, task)` or whose labels bind `{ task }`, (2) the latest `CorrelationRegistry` record (`role: "agent"`) within the current `Contract` epoch (populated on `spawn` as well as `session_open`), and (3) the latest `claim_reported`, `meter_written`, or `repoke_dispatched` `Ledger` event in the current `Contract` epoch — ensuring Attempt-1 Agents coding before their first `Claim` are never reported as `agent (none bound)` during `Lead handoff`.
- **Dual-fuse `90s` `Lead handoff` extraction safeguard (`HANDOFF_EXTRACTION_TIMEOUT_MS = 90_000` in `plugin/server/lead-mailbox.ts`, `plugin/index.server.ts`, pinned in `test/lead-mailbox.test.ts`)** —
  Fuse 1 immediately bypasses extraction and completes handoff within the same lane turn when the outgoing `Lead` is absent (`code === "no-lead"`), in `status === "error"`, or `daemon.agents.ref(lead.id).send(extractionPrompt)` throws. Fuse 2 schedules an `unref()`ed timer (`handoffTimeoutMs ?? 90_000`) and checks elapsed `handoffRequestedAt` inside `pumpProjectLead(slug)`, automatically retiring a hung outgoing `Lead`, preserving any fresh `lead-handoff.md` written after `handoffRequestedAt` (or injecting the explicit interrupted-extraction fallback note alongside the machine-verified roster and ledger digest), resetting `rotationState = "normal"`, and draining all held mail without paging `Supervisor`.
- **Smart-default `Fresh-eyes review` on `Lead` contracts (`isEyeLaneUsable` in `src/fresh-eyes.ts`, `src/factory.ts`, `src/index.ts`, `plugin/server/spool.ts`, `plugin/bin/bridge.mjs`, `plugin/bin/factory.mjs`, pinned in `test/factory.test.ts`, `test/fresh-eyes.test.ts`, `test/spool.test.ts`, and `test/bridge-mcp.test.ts`)** —
  When `Lead` registers a `Contract` (`lead_set_contract` or Spool `contract` with `seat === "lead"` / `by === "lead"` / `role === "lead"` correlation) without explicitly passing `freshEyes: false`, `setContract` probes `isEyeLaneUsable(stateDir, eyeCliProbe)` and automatically enables `freshEyes: true` whenever the configured `freshEyes` lane CLI is available on the host (gracefully leaving `freshEyes` unset on minimal/test hosts without the lane CLI, while explicit `freshEyes: true` still fails fast with `eye-unconfigured` and explicit `freshEyes: false` / `--no-fresh-eyes` opts out).

### Changed

- **Silent seat creation and unified single-turn successor kickoff (`plugin/server/surface-rpc.ts`, `plugin/server/lead-mailbox.ts`, `plugin/index.server.ts`, pinned in `test/lead-mailbox.test.ts` and `test/surface-rpc.test.ts`)** —
  `ensureSeat` creates `Supervisor` and `Lead` sessions silently without passing `prompt` to `agents.create` (recording `onSeatKickoffSent` when an explicit `input.message` is dispatched). During `completeHandoff`, the successor `Lead` is created silently and receives a single unified Turn-1 `send(...)` call combining `[Seat kickoff packet]`, `[Lead handoff bundle]`, and any queued `Lead mailbox` items (or `[Seat kickoff packet] + [Lead handoff bundle]` when the mailbox is empty, marking `kickoffSentAgentIds` so subsequent turns never re-send the kickoff packet).
- `package.json` + `SHELL_VERSION` + `bridge.mjs` `serverInfo.version` → `0.0.28`.

## [0.0.27] - 2026-10-21

v0.0.27's one thing: **native Paseo role providers (`factory-supervisor`, `factory-lead`, `factory-peer`) reconciled into `<paseoHome>/config.json` with a single `Supervisor (Factory)` New Chat profile, deterministic provider-based seat recognition regardless of chat title, `ELECTRON_RUN_AS_NODE` hardening for Paseo Desktop, and removal of the `Start Supervisor` / `Start Lead` UI buttons** (ADR 0017).

### Added

- **Role provider reconciler (`src/role-providers.ts`, vendored to `plugin/server/core/role-providers.ts`, wired at boot in `plugin/index.server.ts` and at the end of `lanesSet` in `plugin/server/surface-rpc.ts`, pinned in `test/role-providers.test.ts`)** —
  `reconcilePaseoRoleProviders` atomically rewrites `<paseoHome>/config.json` (tmp + rename, only on change, with a non-blocking daemon reload): it sweeps the 29 orphaned `sw2-*` profiles and stale `factory-*` entries from `agents.providers` and `daemon.agentProfiles`, writes `factory-supervisor` / `factory-lead` / `factory-peer` (base harness resolved from `lanes.supervisor`/`lanes.lead`/`lanes.worker`, `paseoTools {enabled:false}`, `env.PASEO_FACTORY_SEAT`, `additionalModels`), and registers the single `Supervisor (Factory)` agent profile so the native New Chat picker starts a Supervisor directly; unrelated user providers (`opencode`, `agy`, `glm-acp-agent`) are preserved and a second reconcile is a no-op.
- **Daemon workspace/project cleanup on archival and reset (`plugin/server/daemon-cli.ts`, `plugin/server/surface-rpc.ts`)** —
  `registerSurfaceRpc` captures `context.paseo` before any agent hook fires; `archiveAcceptedTaskWorkspace` and `projectReset` additionally sweep daemon workspace/project records rooted under `<projectStateDir>/worktrees/` or missing on disk (`archive_workspace_request` and project removal over the daemon WebSocket), so removed `Task worktree`s never leave broken project entries in Paseo Desktop.

### Changed

- **Deterministic seat recognition by `config.provider` (`plugin/server/roles.ts`, `plugin/server/choke.ts`, `plugin/server/lead-mailbox.ts`, `plugin/server/spool.ts`, pinned in `test/roles.test.ts` and `test/choke.test.ts`)** —
  `injectRoleOnCreate` recognizes `factory-supervisor` / `factory-lead` / `factory-peer` (`inferRoleFromProviderId`) first, then `env.PASEO_FACTORY_SEAT`, then the legacy title/labels fallback, and resolves the underlying harness family through Lane config so `factory-*` seats receive their exact Layer-1 fence — including Task worktree peer spawns. `injectSessionEnv` binds a native session's `agentId` into `<stateDir>/projects/<slug>/project.json`, and the Factory surface snapshot, `seatOf`, and `ensureSeat` resolve natively started seats via that binding plus provider identity, so a live native Supervisor renders its live state and Ratify no longer displaces it with a duplicate seat.
- **UI simplification (`plugin/client/factory/header.tsx`, `plugin/client/factory/seats.tsx`, `plugin/client/factory/shell.tsx`, pinned in `test/client-surface.test.ts`)** —
  the `Start Supervisor` and `Start Lead` buttons are gone from the Header and `Seats & Models`; each seat shows its live state (`idle` / `running` / `not started`) with `Open` (and `Rotate` / `Revoke`) rendered only while the seat is active, plus the `Select "Supervisor (Factory)" in New Chat to start` hint. The `/factory` skill's bootstrap arm (`src/skill.ts`) points at the same native picker.

### Fixed

- `ELECTRON_RUN_AS_NODE: "1"` now guards every spawn path that can hit an Electron `Paseo Helper` `process.execPath`: `mcpServers.paseo_factory.env` in `applyProviderExecutionFence`, `src/pi-home.ts`, `src/agy-home.ts`, and the `bridgeCall` fallback in `plugin/server/daemon-cli.ts`.
- The spool-side `factory accept` path threads the resolved daemon `home` into the worktree sweep instead of depending on `PASEO_HOME` being set in the plugin process.
- `package.json` + `SHELL_VERSION` → `0.0.27`.

## [0.0.26] - 2026-10-21

v0.0.26's one thing: **role-scoped MCP bridge (`paseo_factory`), unforgeable `Correlation token` seat identity (`cor_<uuid>`), 2-step seat launch with Turn-1 `Seat kickoff packet`, process-group `Gate` reaping, and 3-layer execution fence across all 7 Paseo providers (`claude-code`, `codex`, `opencode`, `copilot`, `omp`, `pi`, `antigravity`)** (ADR 0016).

### Added

- **Role-scoped `paseo_factory` stdio MCP server (`plugin/bin/bridge.mjs`) and `CorrelationRegistry` (`src/correlations.ts`, `plugin/server/correlations.ts`, `plugin/server/spool.ts`, `plugin/server/lead-mailbox.ts`, pinned in `test/bridge-mcp.test.ts`)** —
  `CorrelationRegistry` issues a cryptographic `cor_<uuid>` token in `agent.create`, associates it with the live `agentId` in `agent.session_open`, and persists `<stateDir>/correlations.json`. `plugin/bin/bridge.mjs` exposes strictly role-scoped MCP tools in `tools/list` and enforces role boundaries in `tools/call` across newline-delimited and `Content-Length` framed JSON-RPC (`supervisor_dispatch_lead`, `supervisor_accept_task`, `factory_status` for `Supervisor`; `lead_set_contract`, `lead_spawn_agent`, `lead_accept_task`, `lead_repoke_agent`, `lead_needs_human`, `lead_report_to_supervisor`, `factory_status` for `Lead`; `agent_claim`, `agent_escalate_blocker` for `Agent`; `factory_dispatch_supervisor`, `factory_status` for unbound callers).
- **Turn-1 `Seat kickoff packet` (`src/preflight.ts`, `plugin/server/lead-mailbox.ts`, `plugin/server/surface-rpc.ts`, pinned in `test/lead-mailbox.test.ts` and `test/slp-lifecycle.test.ts`)** —
  `buildSeatKickoffPacket` computes a `<50ms` deterministic repository preflight (git branch/HEAD/status, `package.json` scripts and build markers, top-level files, memory/docs presence, active lanes, folded `Ledger` task digest, and role MCP tool reference) and prepends it to Turn 1 of every newly created or rotated `Supervisor` and `Lead` seat. `ensureSeat` verifies seat `cwd` health alongside `status !== "error"` before reusing an existing seat.
- **3-layer execution fence across all 7 providers (`src/agy-home.ts`, `src/pi-home.ts`, `src/choke.ts`, `plugin/server/roles.ts`, `plugin/server/choke.ts`, `plugin/server/shell.ts`, `plugin/bin/agy-pre-tool-hook.mjs`, `plugin/bin/exec-shim.mjs`, pinned in `test/roles.test.ts`, `test/pi-home.test.ts`, `test/choke.test.ts`, `test/shell.test.ts`, and `test/slp-lifecycle.test.ts`)** —
  Layer 1 wires `paseo_factory` MCP and provider-native tool/permission restrictions in `agent.create` (and provisions `<agyPluginsDir>/paseo-factory` for `antigravity` without passing `config.mcpServers` or `labels`). Layer 2 enforces `seat-paseo-tool-fence`, `<stateDir>` state-file protection, and `pkill plugin-process.js` denial in `choke.onPermissionAsked` and `agy-pre-tool-hook.mjs`. Layer 3 installs OS `PATH` shims in `<stateDir>/bin` for `git`, `pkill`, `kill`, `killall`, `paseo`, and `gh`.

### Fixed

- **Process-group reaping in `runGate` (`src/gate.ts`, pinned in `test/gate.test.ts` and `test/slp-lifecycle.test.ts`)** —
  `runGate` spawns the gate command in a detached process group and reaps `-child.pid` (`SIGTERM` → `SIGKILL`) immediately when the gate shell exits or times out so background child processes holding `stdout`/`stderr` open never hang gate completion.
- `package.json` + `SHELL_VERSION` → `0.0.26`.

## [0.0.25] - 2026-10-20

v0.0.25's one thing: **compact 2-row `Plugins` tab redesign, Core (`paseo-factory`) + 3 `Companion plugin`s semantic version visibility (`vX.Y.Z · <sha>`), on-demand update checking (`factory.plugins.check.updates`), conditional `Update` / `Update All (N)` CTAs, and honest update toast summaries** (ADR 0012 amended).

### Added

- **Core plugin (`paseo-factory`) card (`view.corePlugin`) with self-kill guard (`plugin/shared/companions.ts`, `plugin/shared/view.ts`, `plugin/server/view.ts`, `plugin/server/surface-rpc.ts`, `plugin/client/factory/plugins.tsx`, pinned in `test/surface-rpc.test.ts` and `test/client-surface.test.ts`)** —
  `CORE_PLUGIN_ENTRY` (`paseo-factory`) folds into `FactoryView.corePlugin` and renders at the top of `PluginsPane` with a `CORE` badge alongside the 3 `Companion plugin`s (`factory-burn-lab`, `factory-connector`, `factory-release-lab`). `factory.plugins.manage` allows `reload`, `update`, and `enable` on `paseo-factory` while refusing `disable` and `remove` with `core-plugin-protected` (and locking those actions in the UI) so the `Owner` cannot accidentally disable or remove the active `Factory surface`.
- **Installed semantic version resolution (`package.json`) and on-demand update checking (`factory.plugins.check.updates`) (`plugin/server/daemon-cli.ts`, `plugin/shared/rpc.ts`, `plugin/server/view.ts`, `plugin/server/surface-rpc.ts`, `plugin/client/factory/shell.tsx`, pinned in `test/surface-rpc.test.ts` and `test/client-surface.test.ts`)** —
  `readPluginVersionFromDisk` resolves each installed plugin's semantic `"version"` from `<plugin.path>/package.json`, `<plugin.path>/../package.json`, or `<plugin.path>/paseo-plugin.json`. `checkDaemonPluginUpdates` queries Paseo's native `plugin.source.status.request` over the daemon WebSocket (falling back to `paseo --home <home> plugin update --all --check --json`), caches per-`home` update rows (`updateAvailable`, `latestRevision`, `commitsBehind`, `checkedAt`), and invalidates on install/manage. `FactoryShell` triggers `pluginsCheckUpdates` automatically once when opening `tab === "plugins"` (when unchecked or > 5 minutes old) and whenever the `Owner` clicks `Check for updates`.

### Changed

- **Compact 2-row plugin card layout, conditional primary `Update` / `Update All (N)` CTAs, collapsible `⋯ Manage` drawer, and honest update summaries (`plugin/client/factory/plugins.tsx`, `plugin/server/surface-rpc.ts`, pinned in `test/surface-rpc.test.ts` and `test/client-surface.test.ts`)** —
  Every card in `PluginsPane` renders a 2-row face (`Header row` with icon, title, `CORE`/id pill, semantic version + short SHA pill `vX.Y.Z · <sha>`, status pill, `Active in Sidebar`, update status pill `Up to date` / `Update available · <curr> → <latest>`, conditional primary CTA, and `⋯ Manage` / `Custom source…` toggle; plus 1-line `tagline`). The primary `Update` button on a card and `Update All (N)` in the toolbar appear **only** when `updateAvailable === true`, while source metadata, capabilities, and secondary actions (`Disable`/`Enable`, `Reload`, manual `Update`, `Remove`, `Custom source…`) live inside the collapsible `⋯ Manage` drawer. `pluginsManageSummary` inspects `reply.update` to report `"updated <id> (<prev> → <curr>)"` when updated and `"<id> is already up to date (<curr>)"` when `updated === false`.
- `package.json` + `SHELL_VERSION` → `0.0.25`. Suite 564 → 568.

## [0.0.24] - 2026-10-20

v0.0.24's one thing: **end-to-end `:thinking` variant sanitization, self-healing `Supervisor` & `Lead` seats with permission-only mailbox attention blocking and bounded 1-shot retry, dispatcher write fence on `<project-root>`, re-Contract epoch for unaccepted `Task`s, and Owner-only `Project reset` (`factory reset`)** — closing four live operational failure chains and adding clean `Project` reset across CLI and UI (ADR 0015).

### Added

- **Re-Contract epoch for unaccepted / `Needs-human` `Task`s (`src/factory.ts`, `src/report.ts`, `plugin/server/view.ts`, `plugin/bin/factory.mjs`, pinned in `test/factory.test.ts` and `test/status.test.ts`)** —
  Setting a new `Contract` (`contract_set`) on an unaccepted `Task` (including one that previously hit `needs_human` or the `Attempt ceiling`) opens a fresh **Contract epoch** without mutating historical `Ledger` events. `attemptsOf`, `activeSpawnOf`, `lastProgressSeq`, `isNeedsHuman`, `foldTasks`, and `renderStatus` scope attempt numbering (`#1` in the new epoch), active `needs_human` state, and spawn/respawn ceiling checks to events from the task's latest `contract_set` onward.
- **Owner-only `Project reset` (`factory reset` CLI, `factory.project.reset` RPC, and Header `Reset Project` button) (`src/ledger.ts`, `src/factory.ts`, `plugin/shared/rpc.ts`, `plugin/server/surface-rpc.ts`, `plugin/server/spool.ts`, `plugin/bin/factory.mjs`, `plugin/client/factory/header.tsx`, `plugin/client/factory/shell.tsx`, pinned in `test/ledger.test.ts`, `test/factory.test.ts`, `test/surface-rpc.test.ts`, `test/spool.test.ts`, `test/cli.test.ts`, and `test/client-surface.test.ts`)** —
  `Ledger.purgeWhere` atomically rewrites `ledger.jsonl` after filtering matching events; `Factory.resetProject` purges all `Ledger` events, in-memory contracts/attempts, and `report-<task>-*.md` / `gate-<task>-*.log` / `retro-*` files for a `Project`; `factory.project.reset` and `factory reset [--workspace <dir>] [--project <slug>] [--keep-seats]` cancel and archive working `Agent`s and temporary Paseo worktree workspaces, remove `<projectStateDir>/worktrees/*` and `factory/<task>` branches, retire `Supervisor` and `Lead` seats (unless `--keep-seats`), and clear `mailbox.jsonl`, `lead-handoff.md`, and `project.json` while preserving `lanes.json` (refused at the Spool with `seat-cannot-reset` if invoked by `supervisor`, `lead`, or `agent`). The `Factory surface` Header exposes a two-step `Reset Project` → `Confirm Reset` control.

### Fixed

- **End-to-end `:thinking` variant sanitization across `Factory surface` UI, server, spool, and driver (`plugin/client/factory/seats.tsx`, `plugin/server/surface-rpc.ts`, `plugin/server/spool.ts`, `plugin/server/choke.ts`, `plugin/bin/driver.mjs`, pinned in `test/surface-rpc.test.ts`, `test/spool.test.ts`, `test/choke.test.ts`, `test/driver.test.ts`, and `test/client-surface.test.ts`)** —
  The `Seats & Models` lane editor distinguishes unknown model metadata (`thinkingOptions === null`) from an explicit empty array (`thinkingOptions: []`), rendering `Default (none)` and clearing stale `:thinking` suffixes (such as `:max`) when switching to a model or provider with zero or incompatible thinking variants. On the server, spool, and driver, `sanitizeLaneWithProviders` (and `normalizeAgentCreateRequest`) strips unsupported `:thinking` suffixes and `thinkingOptionId` against the daemon's `providers.listModels` catalog before saving `lanes.json`, creating seats/agents, or syncing live seats, and calls `setAgentThinking(id, "")` when clearing a stale `thinkingOptionId`.
- **Self-healing `ensureSeat`, permission-only mailbox attention blocking, and bounded 1-shot turn-failure retry (`plugin/server/surface-rpc.ts`, `plugin/server/lead-mailbox.ts`, pinned in `test/surface-rpc.test.ts` and `test/lead-mailbox.test.ts`)** —
  `ensureSeat` inspects existing non-archived `Supervisor` and `Lead` seats, automatically retiring (`stop` + `archive`) and replacing seats stuck in `status === "error"` or on a mismatched provider, and syncing `model` / `thinkingOptionId` in-place when drifted. `drainLeadMailbox` and `drainSupervisorMailbox` block only when `status !== "idle"` or `attentionReason === "permission"` (never freezing queued mail on `attentionReason === "error"`). When a `Supervisor` or `Lead` turn ends with `outcome.kind !== "completed"`, `onLeadTurnEnded` requeues the un-acked mail batch and triggers at most one automatic self-healing retry pump per `mailId`.
- **Hardened `/factory` skill (`Mode A` / `Mode B`), dispatcher write fence on `<project-root>`, and `agent.create` normalization (`src/skill.ts`, `src/project.ts`, `plugin/server/choke.ts`, `plugin/server/roles.ts`, `plugin/server/lead-mailbox.ts`, `plugin/index.server.ts`, pinned in `test/skill.test.ts`, `test/choke.test.ts`, `test/roles.test.ts`, and `test/lead-mailbox.test.ts`)** —
  `renderFactorySkill` separates `Mode A — /factory <directive>` from `Mode B — bare /factory` and forbids running `factory status`, calling Paseo MCP agent tools (`create_agent`, `kill_agent`, `update_agent`, `get_agent_status`), or touching repository files after `factory supervisor dispatch`. Normal chat sessions calling `supervisor_dispatch` are recorded in `project.json`'s `dispatchers` list and classified under the `Supervisor` `Seat write fence` (`seat-write-fence` / `supervisor-git-fence`) at `<project-root>`. `normalizeAgentCreateRequest` prefixes unambiguous bare model IDs (e.g. `opencode/<model>`) and stamps canonical `{ seat, project }` labels on reserved seat titles at `<project-root>`.
- `package.json` + `SHELL_VERSION` → `0.0.24`. Suite 542 → 564.

## [0.0.23] - 2026-10-20

v0.0.23's one thing: **enforced SLP command & write boundaries (`Seat write fence`), bidirectional `Supervisor ⇄ Lead` mailbox (`supervisor dispatch` / `supervisor report`), provider-aware mode pinning, and workspace-bound `Agent` spawning with parentage & auto-archive** — closing five live end-to-end orchestration failures discovered on Paseo Desktop (`opencode` / `claude`) so `Supervisor`, `Lead`, and working `Agent`s stay strictly inside their seats and workspaces from `/factory <directive>` through green `Accept` (ADR 0015).

### Added

- **Bidirectional `Supervisor ⇄ Lead` mailbox (`to: "lead" | "supervisor"`), `factory supervisor dispatch`, and `factory supervisor report` (`src/mailbox.ts`, `plugin/server/lead-mailbox.ts`, `plugin/server/spool.ts`, `plugin/bin/factory.mjs`, pinned in `test/mailbox.test.ts`, `test/lead-mailbox.test.ts`, and `test/cli.test.ts`)** —
  `<projectStateDir>/mailbox.jsonl` partitions queues and in-flight deliveries independently for `to: "lead"` and `to: "supervisor"` (defaulting historical lines to `"lead"`). `factory supervisor dispatch` routes from a normal chat or CLI into `to: "supervisor"` (auto-ensuring `Supervisor` and instructing the caller to end its turn immediately) and transparently delegates to `lead_dispatch` (`to: "lead"`) when called inside `Supervisor` (`PASEO_FACTORY_SEAT=supervisor`). `factory supervisor report` lets `Lead` report wave completion or escalate questions back to `Supervisor` (`to: "supervisor"`), delivered when `Supervisor` is idle and acked on `agent.turn_ended` (`outcome === "completed"`), alongside automatic `to: "supervisor"` notifications on `needs_human`.
- **Unified role contracts (`src/roles-contract.ts`) and Spool command authority (`plugin/server/roles.ts`, `src/pi-home.ts`, `plugin/server/spool.ts`, pinned in `test/roles.test.ts`, `test/pi-home.test.ts`, and `test/cli.test.ts`)** —
  `src/roles-contract.ts` is the single source of truth for `Supervisor`, `Lead`, and `Agent` system prompts and bootstraps across all providers (`config.systemPrompt` and `APPEND_SYSTEM.md`), teaching `Supervisor`'s Fire-and-End-Turn law (`factory lead dispatch` then end turn; no `sleep` polling, task decomposition, or coding) and `Lead`'s wave-report return step (`factory supervisor report`). The Spool enforces seat authority on `contract`, `spawn`, `respawn`, and `supervisor_report` (`supervisor-cannot-contract-or-run`, `agent-cannot-orchestrate`).
- **Multi-provider `/factory` skill reconciliation (`src/skill.ts`, `plugin/index.server.ts`, pinned in `test/skill.test.ts`)** —
  `renderFactorySkill` teaches the deterministic `factory supervisor dispatch --workspace "$PWD" --message "<directive>"` command + immediate turn stop, and `ensureFactorySkillSafe` reconciles `SKILL.md` into both `~/.agents/skills/factory/SKILL.md` and `~/.claude/skills/factory/SKILL.md` at plugin boot.

### Fixed

- **Provider-aware `pinCreateMode`, strict worker vs. seat recognition, and mechanical `Seat write fence` (`src/choke.ts`, `plugin/server/choke.ts`, `plugin/server/shell.ts`, pinned in `test/choke.test.ts` and `test/shell.test.ts`)** —
  `pinCreateMode` only sets `modeId: "default"` when the provider prefix is `"claude"` and the `cwd` is a contracted `Task worktree` (`/projects/<slug>/worktrees/<task>`), leaving `opencode`, `codex`, and `pi` `modeId` untouched and never pinning `Supervisor` or `Lead` at `<project-root>`. `choke.onPermissionAsked` enforces `seat-write-fence` on `Supervisor` and `Lead` (allowing only `SEAT_MEMORY_WHITELIST`: `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `GLOSSARY.md`, `.gitignore`, `.worktreeinclude`, `docs/**`, `.scratch/**`, `<stateDir>/**`, and temp dirs, while denying source edits and package-install commands on `<project-root>`), and the `Git shim` enforces `supervisor-git-fence` and `lead-git-fence`.
- **Workspace-bound seat & `Agent` spawning (`workspaces.open` / `projectId`), `parent` hierarchy, and automatic archive (`plugin/server/surface-rpc.ts`, `plugin/server/spool.ts`, `plugin/bin/driver.mjs`, `src/project.ts`, pinned in `test/surface-rpc.test.ts` and `test/driver.test.ts`)** —
  `ensureSeat` opens/reuses the `Project`'s Paseo workspace (`workspaces.open({ cwd: project.root })`) and sets `parent: supervisorId` on `Lead`; `spawn` / `respawn` registers the `Task worktree` workspace bound to the `Project`'s Paseo `projectId` and passes `parent: leadAgentId`, `workspaceId`, and `{ seat: "agent", project: <slug>, task }` labels to `createTaskAgent` so Paseo Desktop never creates rogue top-level `T-01` / `T-02` Projects or duplicate Workspaces; and finished/superseded working `Agent`s and accepted `Task worktree` workspaces are archived automatically (`agents.ref(id).archive()`, `workspaces.archive(workspaceId)`).
- `package.json` + `SHELL_VERSION` → `0.0.23`. Suite 522 → 542.

## [0.0.22] - 2026-10-20

v0.0.22's one thing: **the built-in Header `Private vault` Sync Bar** — the
`Private vault` moves out of the `Plugins` tab into a compact, always-visible
Header status & sync bar with guided 3-state `gh` onboarding, automatic
private repository provisioning (`<ghUser>/factory-vault`), a single smart
bidirectional `Sync Vault` action (`syncVault`), 1-click key import
(`importVaultSecrets`), and 3-layer visual feedback (busy button state +
inline status banner + toast notification), alongside empty-remote bootstrap,
automatic config collection/materialization, and full CLI parity (ADR 0014
amended).

### Added

- **Guided `gh` onboarding, auto-repo provisioning, unified `syncVault`, and
  1-click `importVaultSecrets` (`src/vault.ts`, `plugin/bin/vault.mjs`,
  `plugin/shared/view.ts`, `plugin/shared/rpc.ts`,
  `plugin/server/surface-rpc.ts`, pinned in `test/vault.test.ts`,
  `test/vault-cli.test.ts`, and `test/surface-rpc.test.ts`)** —
  `probeGhAuth` detects `ghInstalled`, `ghAuthenticated`, `ghUser`, and
  `suggestedRepo` (`<ghUser>/factory-vault`) with a 15-second per-runner TTL
  cache; `ensureRemoteVaultRepo` verifies or auto-creates the private GitHub
  repository via `gh repo create <owner/repo> --private`; `syncVault`
  (`factory.vault.sync` / `factory vault sync`) runs pull + multi-node
  `Ledger` reconciliation + local config/state collection + push in one
  bidirectional operation; and `importVaultSecrets` (`factory.vault.import` /
  `factory vault import`) imports `.p8` keys, App Store Connect credentials,
  Google Play Service Account `.json` keys (sealed against GitHub Secret
  Scanning on remote push), `eye.json`, and per-app signing/Firebase files
  into `<paseoHome>/vault-runtime/`, updates `env.json`, and syncs.
- **Built-in Header `VaultSyncBar` and 3-layer action feedback
  (`plugin/client/factory/header.tsx`, `plugin/client/factory/shell.tsx`,
  pinned in `test/client-surface.test.ts` and `test/surface-rpc.test.ts`)** —
  `<VaultSyncBar />` renders inside `<Header />` across all tabs in three
  clear states (`!configured && !ghAuthenticated` step-by-step `gh auth login`
  guide with `Copy Command` + `Check GitHub Login`; `!configured &&
  ghAuthenticated` `@<ghUser>` badge + `Enable & Sync Vault`; `configured`
  readiness pills + `Sync Vault` + `+ Import Key` and `⚙` drawers), while
  `<PrivateVaultCard />` leaves the `Plugins` tab so `Plugins` is dedicated
  exclusively to `Companion plugin`s. Every `factory.vault.*` RPC returns a
  human-readable `summary: string`, and `FactoryShell.act()` surfaces
  in-flight `busyAct` labels, an inline `vaultNote` banner, and
  `toast.show(summary, { variant: "success" })`.

### Fixed

- **Empty-remote bootstrap, Finder `PATH` augmentation, automatic state/config
  collection & materialization, and `factory vault` CLI parity
  (`src/vault.ts`, `plugin/bin/vault.mjs`, `plugin/bin/factory.mjs`, pinned
  in `test/vault.test.ts` and `test/vault-cli.test.ts`)** —
  `createDefaultVaultRunner` appends `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`
  to child `PATH` so GUI-launched Paseo daemons resolve `gh`, `git`, and `tar`;
  `ensureVaultCheckout`, `pullVault`, `pushVault`, and `hydrateVaultDirect`
  handle brand-new 0-commit remotes cleanly (`hydratedFiles: []` on pull/hydrate
  and initial branch creation on push); `pushVault` and `syncVault`
  automatically collect `lanes.json`, `fleet.json`, `free-pool.json`,
  `eye.json` (sealed on remote), and registered `Project`
  `.store-release/manifest.json` files into `vault-runtime/` before staging,
  while `hydrateVaultDirect`, `pullVault`, and `syncVault` materialize
  `config/{lanes,fleet,free-pool}.json` into local state directories; and
  `plugin/bin/vault.mjs` reaches 100% behavioral parity with `src/vault.ts`
  (`pull --merge-ledgers --overwrite-configs`, `push --include-ledger`
  per-project ledger snapshots, `sync`, and `import`) while preserving ADR
  0004's zero-`src/`-imports boundary.
- `package.json` + `SHELL_VERSION` → `0.0.22`. Suite 509 → 522.

## [0.0.21] - 2026-10-20

v0.0.21's one thing: **the `Private vault`** — the `Owner`'s private GitHub
repository becomes the single home for store and signing secrets,
operational configs, and node-partitioned `Ledger` snapshots, hydrated on
any authenticated machine with zero shell config, plus `Release Lab` as the
third `Companion plugin` in the catalog (ADR 0014 made real).

### Added

- **Dual-mode secret envelopes, `VaultConfig` persistence, and the status
  read (`src/vault.ts`, pinned in `test/vault.test.ts`)** —
  `sealVaultBuffer` / `unsealVaultBuffer` round-trip three shapes
  identically: raw plaintext or binary passes through untouched, the
  zero-passphrase `obfuscated` envelope (the default, so GitHub Secret
  Scanning never flags or auto-revokes a Google Cloud Service Account JSON),
  and the passphrase-locked `aes-256-gcm` `.enc` envelope built on
  `node:crypto` `scryptSync` alone — no `git-crypt`, `sops`, `age`, or `gpg`
  — failing loudly with `vault-passphrase-required` /
  `vault-decrypt-failed`. `loadVaultConfig` / `saveVaultConfig` keep
  `vault-config.json` at `0o600` under the plugin state dir, and
  `readVaultStatus` folds it into the `VaultStatusView` the surface renders.
- **Zero-clone `Direct hydrate` and two-way `Vault sync` behind the
  injectable `VaultRunner` seam (`src/vault.ts`, pinned in
  `test/vault.test.ts`)** — `hydrateVaultDirect` streams the private repo
  tarball through the machine's `gh` session, unseals in memory, and writes
  straight into `<paseoHome>/vault-runtime/` (`0o600`) without ever leaving
  a `.git` checkout on disk; `pullVault` / `pushVault` clone or
  `pull --rebase --autostash` the cached checkout at `<paseoHome>/vault` and
  push shared secrets, per-app signing files, `lanes.json`, store manifests,
  and this node's `Ledger` snapshot back. The push side holds the shield:
  a checkout path carrying an envelope never receives raw plaintext back —
  unchanged content keeps the sealed bytes byte-exact (a no-op pull → push
  commits nothing) and changed plaintext is re-sealed in the envelope's own
  mode, refusing with `vault-push-passphrase-required` rather than guessing.
  Every `gh` / `git` / `tar` call
  runs through `createDefaultVaultRunner` (`GIT_TERMINAL_PROMPT=0`), so the
  suite drives both modes against local bare repositories and in-memory
  tarball fixtures with zero network calls.
- **`Canonical project key` routing, the multi-node `Ledger` reconciler,
  worktree hygiene, and `vault-runtime/env.json` (`src/vault.ts`, pinned in
  `test/vault.test.ts`)** — `parseVaultManifest` / `resolveVaultApps` map a
  `vault.manifest.json` canonical key (`patigame`) onto each host's own
  `<projectRoot>` and `<project-slug>`, so the same app checked out at two
  paths on two machines shares one vault entry; `reconcileVaultLedgers`
  dedupes events by fingerprint, sorts them by `(ts, nodeId, seq)`, and
  re-indexes `seq: 1..N` with an atomic write, so `Ledger.open` never throws
  `corrupted-ledger` after a multi-node merge;
  `ensureLocalGitExcludeAndWorktreeInclude` registers hydrated
  `release.keystore` / `google-services.json` / `GoogleService-Info.plist`
  in `<gitCommonDir>/info/exclude` and `.worktreeinclude`, keeping
  `checkCleanAt` green and carrying the files into every `Task` worktree;
  hydration writes `env.json` (`0o600`) with the six `VaultRuntimeEnv` keys.
- **The `factory vault` CLI (`plugin/bin/vault.mjs`, pinned in
  `test/vault-cli.test.ts`)** — `status | hydrate [--repo <owner/repo>]
  [--ref <ref>] | pull | push | seal <file> --to <vaultPath>`, every verb
  printing one JSON object on stdout so vault operations script and verify
  mechanically.
- **`view.vault`, the four `factory.vault.*` RPCs, and the `Private Vault
  (GitHub)` card (`plugin/shared/view.ts`, `plugin/shared/rpc.ts`,
  `plugin/server/surface-rpc.ts`, `plugin/client/factory/shell.tsx`, pinned
  in `test/surface-rpc.test.ts`)** — `factory.vault.configure | hydrate |
  pull | push` through the single-writer plugin server, and the card at the
  top of the `Plugins` view and `Settings` screen with readiness pills (ASC
  `.p8`, Google Play JSON, Eye Config, Hydrated Apps) and the one-click
  `Hydrate Vault`, `Pull & Sync Vault`, and `Push to Vault` acts.
- **`Release Lab` is the third `Companion plugin`
  (`plugin/shared/companions.ts`, pinned in `test/surface-rpc.test.ts`)** —
  `factory-release-lab` (`Rocket`,
  `git:daymanondev/factory-release-lab:plugin`) joins `Burn Lab` and `Fleet
  Connector` in `COMPANION_CATALOG` with the full one-click Install / Update
  / Reload / Enable / Disable / Remove lifecycle (ADR 0012); closes upstream
  issue `01-register-release-lab-in-companion-catalog.md`.
- **Zero-shell-config consumption in the sibling `factory-release-lab`
  v0.0.2** — `Release Lab` reads `<paseoHome>/vault-runtime/env.json`
  whenever `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER`, `GPLAY_KEY_PATH`,
  `RELEASE_LAB_KEYSTORE_STOREPASS`, or `FIREBASE_PROJECT_ID` is unset (Paseo
  Desktop launched from Finder inherits no `~/.zshrc`), and
  `wireSigningConfig` points `android/app/build.gradle` at
  `System.getenv("RELEASE_LAB_KEYSTORE_STOREPASS")` / an excluded
  `keystore.properties` instead of writing plaintext passwords.
- `package.json` + `SHELL_VERSION` → `0.0.21`. Suite 463 → 509.

## [0.0.20] - 2026-10-19

v0.0.20's one thing: **the SLP loop survives context** — compaction-proof
role retention, a single-writer `Lead mailbox`, and automatic `128k` `Lead
handoff`, with the daemon RPC storm gone across the family (ADR 0013 made
real).

### Added

- **The single-writer `Lead mailbox` (`src/mailbox.ts`, pinned in
  `test/mailbox.test.ts`)** — one append-only `mailbox.jsonl` per `Project`
  is the sole mail channel into the standing `Lead` seat: every state
  transition is one immutable JSONL line (`mail_queued`, `mail_delivered`,
  `mail_acked`, `mail_requeued`) appended by the single-writer plugin, the
  pure deterministic fold rebuilds the present from the file alone, a
  delivered batch is `mail_acked` only when the receiving `Lead` turn ends
  with `outcome === "completed"` (failed, cancelled, rotated, or
  daemon-restarted turns append `mail_requeued`), and `recoverLeadMailbox`
  settles any un-acked in-flight batch on boot — zero mail is ever lost
  across a restart. Never a mutable JSON array, never SQLite (ADR 0004).
- **`factory lead dispatch` + the `lead_dispatch` spool request
  (`plugin/server/spool.ts`, `plugin/bin/factory.mjs`, pinned in
  `test/plugin-spool.test.ts`)** — `factory lead dispatch --project <slug>
  --message "<directive>"` submits one atomic one-file-per-request intent
  into `<stateDir>/spool/requests/<id>.json` (ADR 0004 — no CLI
  Read-Modify-Write on shared state, no raw Paseo `agentId`s); the spool
  processor resolves the `Project`, ensures its `Lead` seat exists, appends
  `mail_queued` to `mailbox.jsonl`, and pumps the mailbox on the serialized
  per-`Project` async lane.
- **The automatic `128k` `Lead handoff` (`plugin/server/lead-mailbox.ts`,
  `src/project.ts`)** — the fixed `LEAD_ROTATE_TOKENS = 128_000` mark with
  the deterministic context sensor `readLeadContextTokens` (Paseo's live
  `agent.lastUsage.contextWindowUsedTokens`, with the Pi `.jsonl` session
  fallback across daemon restarts — 0 LLM tokens, no 4th agent role).
  `ProjectRegistration` gains `rotationState` (`normal` |
  `rotation_pending` | `handing_over`): crossing `128k` mid-turn only marks
  `rotation_pending` (the running turn is never interrupted); at the turn
  boundary the mailbox locks (`handing_over`), one bounded Handoff
  Extraction turn writes `<projectStateDir>/lead-handoff.md`, and the
  successor `Lead` is spawned at `0%` context with the deterministic
  **Machine-Verified Active Peer Roster** (`Task` ↔ live `Agent` ↔ `Task`
  worktree), the Ledger State Digest, and the handoff file — then every
  held `mail_queued` item drains into it (pinned in
  `test/plugin-spool.test.ts` and `test/surface-rpc.test.ts`).
- **Compaction-proof role `APPEND_SYSTEM.md` + `Supervisor` command
  symlinks (`src/pi-home.ts`, pinned in `test/pi-home.test.ts`)** —
  `provisionPiAgentHome` writes a managed, role-specific
  `<stateDir>/pi-agent/<role>/APPEND_SYSTEM.md` for `supervisor`, `lead`,
  and `agent` (`ROLE_PROMPTS` carrying each seat's immutable SLP contract
  and exact `factory` CLI paths; none for `headless`) — the file Pi's
  `DefaultResourceLoader` reloads into `_baseSystemPrompt` on every turn,
  every `/compact`, and every `agent.session_open` resume, so no seat ever
  forgets its duties — and for `supervisor` alone symlinks
  `~/.pi/agent/prompts` and `~/.pi/agent/skills` back in, keeping 100% of
  the `Owner`'s personal slash commands on `Supervisor` while `lead`,
  `agent`, and `headless` stay strictly isolated.
- **Always-visible `Start / Open` seat buttons + `Lead` telemetry
  (`plugin/client/factory/header.tsx`, `plugin/client/factory/seats.tsx`,
  `plugin/shared/view.ts`, pinned in `test/client-surface.test.ts`)** — the
  `Seats & Models` header renders Start/Open Supervisor and Start/Open Lead
  even when `view.supervisor === null` on a brand-new `Project`, and the
  `Lead` card shows live context usage (`94k / 128k handoff`), the
  `rotationState` badge, and the queued mailbox count.

### Fixed

- **The daemon RPC storm: `listDaemonPlugins` single-flight + `15s` TTL
  (`plugin/server/daemon-cli.ts`, pinned in `test/surface-rpc.test.ts`)** —
  concurrent `factory.surface.snapshot` polls share one WebSocket
  `plugin.list.request` through an in-memory per-`home` cache
  (`PLUGIN_LIST_TTL_MS = 15_000` plus an in-flight Promise map); only ok
  replies are cached (a failed list keeps retrying), a generation counter
  stops a pre-mutation list still in flight from repopulating the entry
  behind a mutation's back, and `installDaemonPlugin` /
  `manageDaemonPlugin` invalidate as their first statement.
- **The companion fixes, by name:** `factory-burn-lab` v0.0.5 —
  `resolvePaseoHome` defaults to `~/.paseo` when `PASEO_HOME` is unset, and
  `discoverDaemonFreeModels` speaks the zero-side-effect
  `provider.models.list.request` behind a `5 min` single-flight cache, so
  `burnlab.status` polls never open agent sessions (ticket 01);
  `factory-connector` v0.0.3 — `pollFleetPulse` behind a single-flight +
  `5s` TTL cache with the active client poll at `10s` (ticket 02).
- `package.json` + `SHELL_VERSION` → `0.0.20`. Suite 422 → 457.

## [0.0.19] - 2026-10-18

### Fixed

- **Preserve the daemon's `process.env.PATH` in `injectClaimCliPath`
  (`plugin/server/shell.ts`, pinned in `test/shell.test.ts`)** — Paseo's
  `agent.session_open` before-hook passes `request.env` as a per-launch
  overlay (normally `{}`) and later `Object.assign`s it onto `process.env`.
  Setting `PATH` to `<stateDir>/bin` alone when `request.env.PATH` was unset
  clobbered the daemon's `process.env.PATH`, causing PATH-resolved provider
  CLIs (`copilot`, `pi`, `opencode`) to fail on launch with `spawn … ENOENT`
  and leaving Paseo Desktop draft workspace tabs stuck on
  `workspace_request_key_conflict` when retrying with another provider.
  `injectClaimCliPath` now seeds from `basePath` (`process.env.PATH ?? ""`)
  whenever `request.env.PATH` is unset or empty.
- `package.json` + `SHELL_VERSION` → `0.0.19`.

## [0.0.18] - 2026-10-18

v0.0.18's one thing: **`paseo-factory` becomes remotely installable** — the
remote-first story v0.0.17 shipped for its companions now holds for the core
plugin itself.

The version also completes the core as a self-contained SDK for its
`Companion plugin`s (ADR 0012): the four slices below resolve burn-lab
upstream issues `#01` and `#02`.

### Added

- **Headless tool-less `opencode/<model>` lanes in `Lane config`
  (`src/lanes.ts`, pinned in `test/lanes.test.ts`)** — `parseLane` accepts
  `opencode/<model>` and its `:thinking` suffix, and `laneCliInvocation`
  maps it to `opencode run --standalone --auto -m opencode/<model>`
  (`--variant <thinking>` when set), so the $0 `opencode/*-free` models
  become selectable for `watch`, `retro`, and `freshEyes`. The pass is
  tool-less by construction: `runLaneCli` injects
  `OPENCODE_CONFIG_CONTENT = TOOLLESS_OPENCODE_CONFIG` — every tool denied,
  `read` included (the prompt on stdin is the whole material) — plus
  `CI=1` into the spawned env and strips ANSI escapes from the opencode
  path's stdout, so a pass can never mutate disk or hang on an interactive
  prompt; the same seam carries `Watch`, `Retro`, and `Fresh-eyes review`
  end to end.
- **The `Project` registry in the pure-Node core (`src/project.ts`, vendored
  at `plugin/server/core/project.ts`)** — `ProjectRegistration`,
  `readProjectRegistration`, `writeProjectRegistration`,
  `listProjectRegistrations`, and `discoverProjects` move out of the plugin
  server layer into the core `Project` module, so `paseo-factory` and its
  companions share one source of truth for
  `<stateDir>/projects/<slug>/project.json` and its `Supervisor` / `Lead`
  seat bindings.
- **`Task worktree` allocation in the pure-Node core (`src/workspace.ts`,
  pinned in `test/integration.test.ts`)** — `taskWorktreePath`,
  `parseTaskWorktreePath`, `taskWorktreeBranch`, and `prepareTaskWorktree`
  (the port of the driver's proven `plugin/bin/task-worktree.mjs` allocator
  — the CLI itself is untouched) join the core `Workspace` module with the
  `.worktreeinclude` copying and per-worktree `core.excludesFile`
  (`factory-excludes`) behavior, gaining the companion-facing
  `worktreePath` / `branchName` overrides (Best-of-N arenas) and
  `symlinkNodeModules: true` (`junction` on win32, `dir` symlink on POSIX,
  with `node_modules` appended to `factory-excludes` so `checkCleanAt`
  stays clean).
- **The complete top-level core barrel (`src/index.ts`, vendored at
  `plugin/server/core/index.ts`)** — everything a companion needs from one
  import: the registry five, `headCommitSync` / `changesOutsideScope` /
  `landTaskWorktree`, the worktree four, `parseLane` / `projectLanesPath` /
  `TOOLLESS_OPENCODE_CONFIG`, and `provisionPiAgentHome` with its options
  interface renamed to `ProvisionPiHomeOptions` (`src/pi-home.ts`).

### Changed

- `plugin/server/projects.ts` becomes a thin re-export of
  `./core/project.ts` — same signatures, same registry bytes, zero behavior
  change for existing callers and tests.
- Suite 412 → 421.

### Fixed

- `package.json` declares `@getpaseo/protocol` (`0.11.2`, pinned to the
  version `@getpaseo/plugin@0.11.2` requires as its peer) under
  devDependencies. `plugin/server/choke.ts` imports
  `@getpaseo/protocol/agent-types`, but the package was never declared — it only
  reached `node_modules` transitively on machines with a full dev checkout, so a
  fresh `git:` install (daemon clones the repo and builds from a clean
  `npm install`) failed with `Could not resolve type dependency
  "@getpaseo/protocol/agent-types"`. First witnessed on a real remote install
  (Mac mini trial home); both homes on the dev machine are directory installs
  and had the package locally, which masked the gap. Every other external
  import under `plugin/` was audited against the manifest — this was the only
  undeclared one.
- `package.json` + `SHELL_VERSION` → `0.0.18`.

## [0.0.17] - 2026-10-17

v0.0.17's one thing: **Remote-first `Companion plugin` catalog and lifecycle
on the `Factory surface`** — ADR 0012 made real.

### Added

- **The shared `Companion plugin` catalog (`plugin/shared/companions.ts`)** — `COMPANION_CATALOG` declares the official first-party companions (`factory-burn-lab` "Burn Lab" and `factory-connector` "Fleet Connector") with taglines, descriptions, capability lists, sidebar labels/icons, and their canonical GitHub sources (`git:daymanondev/factory-burn-lab:plugin`, `git:daymanondev/factory-connector:plugin`). Pure declarative data shared by server and client; the server never probes `../` sibling directories, so installation is remote-first and identical on macOS and Windows.
- **The `FactoryView.companions` fold (`plugin/shared/view.ts`, `plugin/server/view.ts`)** — `CompanionPluginViewSchema` (live `status` `not_installed | running | disabled | failed`, `installKind` `git | npm | directory`, `installedSource`, `currentRevision`, `error`) and `foldCompanions` join the catalog against the daemon's `plugin.list.request` answer, defaulting every entry to `not_installed` when the daemon lists only `paseo-factory` or the list call is unavailable.
- **The cross-platform daemon plugin bridge (`plugin/server/daemon-cli.ts`)** — a payload-returning session-WebSocket helper over `<home>/paseo.pid` + `<home>/local-credential` plus `listDaemonPlugins` / `installDaemonPlugin` / `manageDaemonPlugin`: `plugin.list.request`; `plugin.source.install.request` (a 300 s `PLUGIN_IO_TIMEOUT_MS` so a Git clone or fetch never times out prematurely) with `plugin.directory.install.request` routing for explicit local paths (absolute, `./`, `~/`, and Windows drive paths); `plugin.{enable,disable,reload,remove}.request` and `plugin.source.update.request`; each with a `paseo --home <home> plugin … --json` CLI fallback when the pid file is absent. `SurfaceDeps` grows injectable `listPlugins` / `installPlugin` / `managePlugin` overrides (`plugin/server/surface-rpc.ts`), matching the `setAgentModel` pattern.
- **`factory.plugins.install` / `factory.plugins.manage` surface RPC (`plugin/shared/rpc.ts`, `plugin/server/surface-rpc.ts`)** — install one companion or `target: "all"` (only the currently uninstalled, each from its canonical source) with optional custom `source` / `ref`; `enable` / `disable` / `reload` / `update` / `remove` on an installed companion; daemon failures refuse with `code: "daemon_failed"` and the daemon's error verbatim.
- **The fourth `Plugins` tab and `<PluginsPane />` (`plugin/client/kit/pill.tsx`, `plugin/client/factory/plugins.tsx`, `plugin/client/factory/shell.tsx`)** — `TabId` grows `"plugins"` (Blocks icon) with the badge counting running companions; the pane renders the ecosystem summary header (`{running} of {n} active on this daemon`), an `Install All` button whenever any companion is uninstalled, and one card per companion: status pill, `Active in Sidebar · <label>` badge when running, capability pills, install identity (remote + short `currentRevision`, npm package + version, or directory path), the daemon error banner, `Install` + `Custom source…` when absent, and `Enable`/`Disable` · `Update` (git/npm) · `Reload` · `Remove` when installed.
- **The plugin wire seam pinned end to end (`test/surface-rpc.test.ts`, `test/client-surface.test.ts`)** — handler-level tests run against the injectable overrides, and one hand-rolled RFC6455 mock daemon (`node:http` + `node:crypto`, loopback only, temp homes seeded with `<home>/paseo.pid` + `<home>/local-credential`, zero new dependencies) verifies the exact `plugin.*` session frames the bridge puts on the wire; the client tests pin the fourth tab, the shell wiring, and the pane. `test/release.test.ts` pins the release invariants (`package.json`, both `package-lock.json` version spots, and `SHELL_VERSION` carry one version; `CHANGELOG.md` opens its entry).
- `docs/adr/0012-companion-plugin-catalog.md`; `CONTEXT.md` gains the
  **Companion plugin** entry and the **Factory surface** entry's fourth view;
  ADR 0009's `Amended by:` line names the ADR 0012 rider.

### Changed

- `cliUtils` in `plugin/server/daemon-cli.ts` splits `PATH` on `node:path`'s
  `delimiter` (`:` on POSIX, `;` on Windows) instead of a hardcoded `":"`, so
  daemon CLI fallback resolution stops being POSIX-only.
- `package.json` + `SHELL_VERSION` → `0.0.17`. Suite 372 → 412.

## [0.0.16] - 2026-10-17

v0.0.16's one thing: **Clean-room `Pi harness home` isolation
(`PI_CODING_AGENT_DIR`) across roles and headless passes** — ADR 0011
made real.

### Added

- **The Pi harness home provisioner (`src/pi-home.ts`, vendored verbatim at `plugin/server/core/pi-home.ts`)** — `provisionPiAgentHome` materializes `<stateDir>/pi-agent/<role>` idempotently for `supervisor` / `lead` / `agent` / `headless`: a generated clean-room `settings.json` that keeps only the operator's `defaultProvider` / `defaultModel` / `defaultThinkingLevel` and enforces `packages: []`, `extensions: ["-builtin:llama.cpp"]` (native `builtin:mcp`, `builtin:codemode`, `builtin:tool-search` stay enabled), `quietStartup: true`, and `defaultProjectTrust: "always"` (so `<project-root>/.pi/mcp.json` overrides work); symlinks `auth.json`, `models.json`, `models-store.json`, every OAuth credential store, and `sessions/` back to `~/.pi/agent` so auth, custom models, and session resume are shared; and never links `APPEND_SYSTEM.md`, `SYSTEM.md`, `extensions/`, `prompts/`, or `skills/` — the operator's global TUI auto-delegation rules and 20+-package resolution never reach a Factory seat.
- **`PI_CODING_AGENT_DIR` on every seat and working Agent (`plugin/server/roles.ts`)** — `factoryEnvFor` provisions the role's harness home on demand and returns it as `PI_CODING_AGENT_DIR` alongside the `PASEO_FACTORY_*` vars; the `agent.create` (`injectRoleOnCreate`) and `agent.session_open` (`injectSessionEnv`) before-hooks both merge it, so every pi-lane `Supervisor`, `Lead`, and contracted working `Agent` runs in the clean room at creation and on every launch (both hooks grow a hermetic `userHome` override for tests).
- **A clean headless home for tool-less passes (`src/lanes.ts`, threaded through `src/watch.ts`, `src/retro.ts`, `src/fresh-eyes.ts`)** — `runLaneCli` provisions `<stateDir>/pi-agent/headless` (skills denied, every interactive builtin extension off on top of the argv's `--no-extensions --no-skills --no-context-files`) and passes `PI_CODING_AGENT_DIR` in the spawned child env for `pi/<model>` lanes, so `Watch`, `Retro`, and `Fresh-eyes review` never pay the operator's package-resolution cost or inherit `APPEND_SYSTEM.md`; `LaneCliRunner` grows the recorded `env` field.
- **Sanitized `mcp.json` synchronization and per-role skills scoping (`src/pi-home.ts`)** — every provision re-syncs the session-bearing role homes' `mcp.json` from `~/.pi/agent/mcp.json`, stripping legacy `pi-mcp-adapter` `"auth": "oauth"` strings (Pi v1.3.0's `builtin:mcp` validator rejects them) while preserving valid `auth: { provider }` objects and all other fields, so operator edits propagate on the next session open; `agent` filters `<available_skills>` to the three core skills (`tdd`, `diagnosing-bugs`, `codebase-design`) while `supervisor` and `lead` auto-discover the clean `~/.agents/skills` catalog for Contract authoring.
- `docs/adr/0011-clean-room-pi-harness-isolation.md`; `CONTEXT.md` gains
  the **Pi harness home** entry (naming `Supervisor`, `Lead`, working
  `Agent`, and the headless `Watch` / `Retro` / `Fresh-eyes review` passes;
  the six term entries themselves are untouched).

### Changed

- **The Driver brief names where each mandated `SKILL.md` lives (`plugin/bin/driver.mjs`)** — a Contract with `skills` now renders `Required skills to open first: <skills> (read ~/.agents/skills/<skill>/SKILL.md or .agents/skills/<skill>/SKILL.md before starting)`, so a working Agent whose `<available_skills>` is filtered to the core three can still open any `Contract.skills` entry on demand.
- Owner-side migration (no repo change, ADR 0011's Consequences): obsolete
  Yara-specific MCP servers (`code-graph-mp`, `yara-db`,
  `atlassian-mcp-server`, `sentry`) come out of the operator's
  `~/.pi/agent/mcp.json`; the provisioner's per-provision re-synchronization
  carries the edit into every role home on the next session open or headless
  pass, so no unused background MCP processes spawn for retired projects.
- `package.json` + `SHELL_VERSION` → `0.0.16`. Suite 361 → 372.

## [0.0.15] - 2026-10-16

v0.0.15's one thing: **Per-lane Thinking Level (`provider/model[:thinking]`), Paseo project discovery, and Factory surface redesign**.

### Added

- **Per-lane Thinking Level (`src/lanes.ts`, `plugin/bin/lanes-config.mjs`, `plugin/bin/driver.mjs`, `plugin/server/surface-rpc.ts`, `plugin/server/daemon-cli.ts`)** — lane values now accept an optional `:thinking` suffix (e.g. `pi/zai/glm-5.3:high`, `pi/zai/glm-5.3:max`, `copilot/gpt-5.4:high`, `claude/opus-4-8:high`). `parseLane` splits `{ provider, model, thinking }`; `laneCliInvocation` forwards `--thinking <level>` for `pi`, `--reasoning-effort <level>` for `copilot`, and `--effort <level>` for `claude`; `driver.mjs` and `ensureSeat` pass `thinkingOptionId` on `agent.create`; and `lanes.set` live-syncs both `set_agent_model_request` and `set_agent_thinking_request` to active seats.
- **Full Model & Thinking Picker on `Seats & Models` (`plugin/client/factory/seats.tsx`, `plugin/shared/view.ts`)** — `ProviderView.models` carries structured `{ id, label, thinkingOptions, defaultThinkingOptionId }` from `daemon.providers.listModels`. The Lane configurator modal adds sub-family filter chips (`All`, `zai`, `github-copilot`, `google-antigravity`, …), search filtering across the full model catalog (removing the 16-item cap), and a 3rd step to pick the Thinking Level (`Provider default` or model-supported options).
- **Paseo `<home>/projects/projects.json` discovery (`plugin/server/projects.ts`)** — `discoverProjects` merges non-archived git repositories from Paseo's own project list so the Project Scope Bar populates before any seat has been created.

### Changed

- **Factory surface UI & SLP alignment (`plugin/client/*`)** — equal-width KPI Stat Tiles, responsive multi-column Lane Cards grid with provider/model/thinking pills, height-locked controls (`CONTROL_H = 32`, `CONTROL_SM = 26`, `PILL_H = 22`), non-stretching buttons (`alignSelf: "flex-start"`), and removal of the header's `Ensure Lead` button and inline dispatch input so the Human Owner interacts exclusively through Paseo's native Conversation UI per canonical SLP.
- `package.json` + `SHELL_VERSION` → `0.0.15`. Suite 357 → 361.

## [0.0.14] - 2026-10-16

v0.0.14's one thing: **Project-scoped SLP seats at `cwd`, a model-backed Lead
agent, and automatic Task worktrees with local landing** — ADR 0010 made real.
Four pieces move the topology from one synthetic global seat to one standing
Supervisor and Lead per Project, both rooted inside the repository:

1. **Per-Project identity and state (`src/projects.ts`, `src/factory.ts`)** —
   any Git repository resolves to `<slug> = <basename(root)>-<sha1(realpath(gitCommonDir)).slice(0,6)>`
   (`git rev-parse --show-toplevel --git-common-dir`, worktree-aware), and the
   Project's `ledger.jsonl`, reports, gate logs, retro files, optional
   `lanes.json` override, and Task worktrees live under
   `<stateDir>/projects/<slug>/`. The root ledger stays readable as the
   unscoped fallback; the spool, choke writable set, and generated claim-CLI
   wrappers remain root-level (one writer per home).
2. **Automatic Task worktrees and local landing on Accept
   (`plugin/bin/task-worktree.mjs`, `src/factory.ts`)** — `factory run`
   allocates `<projectStateDir>/worktrees/<task>` on branch `factory/<task>`
   at the Contract's base (copying `.worktreeinclude` matches, excluded via a
   per-worktree excludes file), spawns the working Agent with
   `cwd = <taskWorktreePath>` (recorded on `spawn_dispatched.worktree`), and
   `claim` / Gate run against the worktree. `factory accept` is now async:
   landing runs before the `attempt_accepted` append — fast-forward or
   cherry-pick `claimedCommit` into `<project-root>`'s local branch, remove
   the worktree, keep `factory/<task>`, idempotent on retry, and
   `landing: "landed" | "pending-conflict"` (+ `landingNote`) when the root
   is dirty or conflicts.
3. **Project seats at `cwd` with additive injection
   (`plugin/server/roles.ts`, `plugin/server/surface-rpc.ts`)** —
   `factory.supervisor.ensure` / `factory.lead.ensure`
   (`{projectRoot, message?}`) find or create `seat=supervisor|lead,
   project=<slug>` agents with `cwd = <project-root>` under their lanes; the
   retired `<home>-supervisor/AGENTS.md` overwrite is gone. Role contracts
   ride two additive channels at create (`config.systemPrompt` append in the
   `agent.create` before-hook plus a bootstrap `prompt`) and one at every
   launch (`PASEO_FACTORY_SEAT/PROJECT/PROJECT_ROOT/STATE_DIR[/TASK]` env on
   `agent.session_open`), each footer carrying its role's skill index
   (Supervisor `grilling, domain-modeling`; Lead `codebase-design,
   domain-modeling, tdd`; Agent `tdd, diagnosing-bugs, codebase-design`).
   `factory.lead.rotate` (RPC + `factory lead rotate --project <dir>` spool
   path) cancels and archives the live Lead; the FactoryView version bumps to
   2 (`project`, `projects`, `lead`), the surface gains a Project Selector,
   workspace-panel auto-binding, a Lead lane card, and **Ratify via
   Supervisor** (`factory.retro.ratify`) dispatching the verbatim proposal to
   the Project's Supervisor with the two-tier memory instruction.
4. **Lead acceptance, Contract `skills`, and the memory write fence
   (`src/factory.ts`, `src/events.ts`, `plugin/server/choke.ts`)** — `accept
   --by owner|supervisor|lead` names the accepting seat; `lead` is judged at
   the factory (green verdict, no fresh-eyes CONCERN, not needs-human) and
   refused with `lead-accept-refused` otherwise. `factory contract --skills
   tdd,diagnosing-bugs` records the list on the Contract and the driver's
   brief prepends `Required skills to open first: <skills>`. Contracted
   working Agents are fenced off `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md`
   unless explicitly scoped — project memory is written by the seats and
   ratified proposals, never by a mid-task worker.

### Added

- `docs/adr/0010-project-scoped-slp-worktrees-and-lead-agent.md`;
  `CONTEXT.md` gains **Project**, **Task worktree**, and **Lead (model-backed
  seat)** and updates **Supervisor**, **Contract**, **Accept**, **Lane
  config**, and **Choke policy**.
- `src/projects.ts` (`resolveProject`, `projectStateDir`, registry), the
  `lead` lane with per-Project override (`loadLanes(stateDir, slug?)`),
  `plugin/bin/task-worktree.mjs`, `plugin/bin/project.mjs`,
  `plugin/server/roles.ts`, `factory.lead.ensure` / `factory.lead.rotate` /
  `factory.retro.ratify` RPCs, the `lead_rotate` spool kind, the `factory
  lead rotate` CLI, Contract `--skills`, and `accept --by`.

### Changed

- Review fixes: a Contract set on a repository **subdirectory** keeps the
  legacy single-checkout run (`factory run` switches the branch in place,
  agent cwd = the subdirectory — no Task worktree, no landing on Accept;
  Implementation Decision 5 conditions the worktree on the workspace being
  `<project-root>`), and an unscoped `factory.supervisor.revoke` refuses
  with `ambiguous-supervisor` when more than one Project has a live seat
  instead of retiring an arbitrary one.
- `package.json` + `SHELL_VERSION` → `0.0.14`; FactoryView version → 2.
- Verified live on `~/.paseo-factory` (Project seats at `cwd`, a
  `--skills tdd` Task through worktree, gate, Lead accept, and local landing)
  and installed onto `~/.paseo` so Paseo Desktop renders the Project-scoped
  Factory surface out of the box. Suite 307 → 357.

## [0.0.13] - 2026-10-15

v0.0.13's one thing: **the Factory surface in Paseo + unified Lane config and
tool-less CLI runner** — ADR 0009 (and the in-process RPC single-writer
amendment to ADR 0004) made real. Four pieces close the gap between the
terminal-only verification engine and day-to-day Paseo Desktop use:

1. **Unified `Lane config` (`<stateDir>/lanes.json`, `src/lanes.ts`)** — one
   plain JSON file persists the `<provider>/<model>` string for all five
   model-backed roles (`supervisor`, `worker`, `watch`, `retro`, `freshEyes`),
   each defaulting to `"pi/zai/glm-5.3"` when the file is absent or partial —
   only explicitly-set lanes persist (`loadLanes` fills defaults at read time,
   so a single-lane write never materializes the rest and a pre-existing
   `eye.json` keeps answering until `freshEyes` is named; `freshEyes` also
   accepts `"eye.json"` for direct HTTP configuration). `Lead` is
   intentionally absent from `lanes.json` because it is a deterministic rider
   with zero model calls (ADR 0006 §3). `factory run <task>` falls back to
   `lanes.worker` when `--provider` is omitted, and `factory lanes get` /
   `factory lanes set <lane> <value>` exposes the same file on the CLI.
2. **Tool-less CLI runner (`runLaneCli`) across `Watch`, `Retro`, and
   `Fresh-eyes`** — replaces the hardcoded copilot watch lane (`gpt-5.4`
   pinned in code) with a unified headless subprocess runner supporting
   `pi/<model>` (`pi --print --no-session --no-tools --no-extensions
   --no-skills --no-context-files --model <model>`), `copilot/<model>`
   (`copilot -s --model <model> --reasoning-effort medium`), and
   `claude/<model>` (`claude -p --model <model> --tools ""`), piping the
   prompt/state over `stdin`. `Fresh-eyes` gains a second configured source
   (`lanes.freshEyes` CLI lane alongside `<stateDir>/eye.json` HTTP — the
   `fresh_eyes_written` `model` field records the lane string verbatim on the
   CLI path, the eye.json model id on the HTTP path).
3. **In-process Plugin RPC & `FactoryView` snapshot (`plugin/shared/rpc.ts`,
   `plugin/shared/view.ts`, `plugin/server/surface-rpc.ts`,
   `plugin/server/view.ts`)** — amends ADR 0004 so UI actions invoke the single
   `Factory` instance in-process (`factory.snapshot`, `factory.task.detail`,
   `factory.accept`, `factory.retro`, `factory.lanes.set`,
   `factory.supervisor.ensure`, `factory.supervisor.revoke`) while external CLI
   processes continue to submit through the spool. `factory.accept` stamps
   `accepted_by: "owner"` on the ledger line; `factory.lanes.set` updates a
   live Supervisor agent's model immediately over the daemon WebSocket
   (`set_agent_model_request`, stripping the `<provider>/` prefix, with a
   paseo-CLI bridge fallback) and persists to `lanes.json`.
4. **Paseo Client UI (`plugin/index.client.tsx`, `plugin/client/**`)** —
   upgrades `@getpaseo/plugin` to `0.11.2`, registering a Global Screen +
   Sidebar navigation item (`Factory`), Workspace Panel, and Settings Screen.
   Includes the persistent KPI header, the **Open Supervisor** + **Quick
   Dispatch** bridge (finding or creating the `seat=supervisor` agent in
   `<home>-supervisor` with generated `AGENTS.md` and opening Paseo's native
   `navigation.openAgent({ agentId })`), **Tab 1 (`Tasks`)** (verification cards
   with Attempt `1 · 2 · 3` ladder, Gate/Eye/Watch pills, inline `Accept #n`,
   and full Report / Gate Log / Diff / Timeline modal), **Tab 2 (`Seats &
   Models`)** (interactive lane cards, discovered-model selector modal, and
   orthogonal Seat Graph), and **Tab 3 (`Timeline & Retro`)** (multi-lane
   swimlane across Tasks, Agents, Watch, and Retro, one-click `Run Retro`, and
   searchable Ledger stream), enforced by `scripts/check-bundle.mjs`. Suite
   276 → 307.

### Added

- `docs/adr/0009-factory-surface-and-lane-config.md` (and `ADR 0004` in-process
  RPC single-writer amendment); `CONTEXT.md` gains **Lane config** and **Factory
  surface** and updates **Fresh-eyes**, **Watch**, **Retro**, **Supervisor**,
  and **Driver**.
- `src/lanes.ts` (`loadLanes`, `saveLanes`, `laneError`, `laneCliInvocation`,
  `runLaneCli`), `factory lanes [get|set]` CLI subcommand, and optional
  `--provider` fallback to `lanes.worker` in `factory run`.
- `plugin/shared/rpc.ts`, `plugin/shared/view.ts`, `plugin/server/view.ts`,
  `plugin/server/surface-rpc.ts`, `plugin/server/daemon-cli.ts`,
  `plugin/index.client.tsx`, `plugin/client/**`, and `scripts/check-bundle.mjs`.

### Changed

- `package.json` + `SHELL_VERSION` → `0.0.13`; `@getpaseo/plugin` → `0.11.2`.
- Verified live on `~/.paseo-factory` and installed onto `~/.paseo` so Paseo
  Desktop renders the `Factory` surface out of the box.

## [0.0.12] - 2026-10-14

v0.0.12's one thing: **respawn once on substrate death; three attempts cap a
task** — ADR 0008 (and the re-scoped trio row from ADR 0006 §5 as amended by
ADR 0007) made real. Two structural ceilings close the unbounded repair gaps
on daemon 0.11:

1. **The Attempt ceiling (`MAX_ATTEMPTS = 3`, fixed in code, never
   configuration)** — enforced plugin-side at three points: `Factory.claim`
   throws `FactoryError("attempt-ceiling")` before opening a fourth Attempt;
   `Factory.requestSpawn` appends `spawn_refused` (`code: "attempt-ceiling"`,
   `rule: "spawn:attempt-ceiling"`); and the Lead rider (`leadDecision`)
   immediately records `needs_human` (`reason: "attempt-ceiling"`,
   `evidence: { attempt: 3, gate: <seq> }`) when Attempt 3 finishes `red`.
   Paired with the Q2 enabling fix on the null-fetch lane (`continueOnLedger`):
   previously any `gate_finished` after spawn committed `fate: "finished"`
   within 5 s, cutting the watch on a `red` Attempt 1 while the live Agent was
   still in its turn fixing the code; now `continueOnLedger` commits
   `fate: "finished"` immediately **only when `verdict.verdict === "green"`**,
   so `red` Attempts 1 and 2 stay in the watch.
2. **One automatic `Respawn` per progress marker on `Substrate death`** — when
   `observeTasks` classifies death (the snapshot lane's `status === "error"` or
   the null lane's Fast / Slow doors from ADR 0007) and the Task is neither
   `green` nor at `attempt-ceiling`, the Driver meters the dead Agent first
   (`meter_written` with the dead `agentId`), submits `kind: "respawn"` through
   the spool (`Factory.respawn` enforces at most one `respawn_dispatched` since
   the latest `spawn_dispatched` or `gate_finished`, refusing repeats with
   `respawn:already-spent`), cleans uncommitted worktree fragments to `HEAD` on
   branch `<task>` (`git checkout -- . && git clean -fd`), and keys
   `agent.create.request` by the dispatch `seq`
   (`${task}-spawn-${seq}` / `${task}-respawn-${seq}`) so a dead agent record
   still resident in the daemon DB never collides with the replacement Agent's
   creation. A second `Substrate death` with no new `gate_finished` between
   them ends in `needs_human` (`reason: "died-after-respawn"`,
   `evidence: { spawn, respawn }`). Suite 266 → 276 (PR #46).

The version's judged run (ticket 03 — two arms in one `factory run` invocation
on `pi/zai/glm-5.3`, ground truth pre-registered before any run, zero
amendments) ruled **7 of 7 checks PASS, $0 out-of-pocket**:

- **Arm A (`live12-respawn`, planted mid-run death → automatic Respawn → green
  Claim)**: Agent 1 (`90878df6`) streamed timeline growth (`seqEnd=22 GREW`)
  and was deleted mid-run (`paseo agent delete` → `DELETED` at `10:16:24.039Z`).
  **2.6 s later** (`10:16:26.641Z`), the Driver caught the Fast door (`Agent
  not found`), wrote Agent 1's `meter_written` (`seq 1462`), dispatched
  `respawn_dispatched` (`seq 1463`, `died_agent: "90878df6-..."`), and created
  replacement Agent 2 (`f0b4b9e5`, `3.16 s` delete-to-create) on branch
  `live12-respawn`, which authored `docs/runbooks/respawn-and-ceiling.md`,
  claimed (`seq 1478`, `d0e01b4`), finished `green` on Attempt 1 (`seq 1480`),
  and wrote Agent 2's `meter_written` (`seq 1482`).
- **Arm B (`live12-ceiling`, multi-attempt survival across red Claims →
  `attempt-ceiling`)**: against an unsatisfiable gate token outside scope,
  `continueOnLedger` held the watch open on the null-fetch lane across red
  Attempt 1 (`seq 1466`, `10.7 s` window) and red Attempt 2 (`seq 1470`, `9.0 s`
  window) while the live Agent (`15ae3d7d`) stayed in its turn and submitted
  Attempts 2 and 3; when Attempt 3 landed `red` (`seq 1474`), the Lead rider
  recorded `needs_human` (`seq 1476`, `reason: "attempt-ceiling"`,
  `evidence: { attempt: 3, gate: 1474 }`) before Arm B's `meter_written`
  (`seq 1477`), and the Driver exited 2 (`factory: run NOT green`). Both
  post-run negative probes passed: `factory-claim` for Attempt 4 exited 2 with
  `attempt-ceiling` and wrote zero ledger lines; `factory run live12-ceiling`
  exited 2 and wrote `spawn_refused` (`seq 1483`, `rule: "spawn:attempt-ceiling"`).
- **Bonus mechanism finding (resolving v0.0.11 Finding 4)**: each of the three
  `pi/zai/glm-5.3` agent creations in this clean, 429-free run was followed
  ~1.5–7 s later by one transient `beforeEachCreate` UUID (`9527e8c9`,
  `6defe07c`, `6eb23a5c`) with no contracted `cwd` and absent from `agent ls
  --global --all` — proving they are Paseo's internal `pi` helper sessions on
  first turn, not 429-storm artifacts.

### Added

- `docs/adr/0008-respawn-and-attempt-ceiling.md` (and `ADR 0006 §5` amendment)
  ratified before code; `CONTEXT.md` gains **Attempt ceiling** and **Respawn**
  and updates **Lead**, **Attempt**, **Driver**, and **Needs-human**.
- `RespawnDispatched` (`respawn_dispatched`) and `RespawnRefused`
  (`respawn_refused`) ledger events, spool kind `"respawn"`, `Factory.respawn`,
  and expanded `NEEDS_HUMAN_REASONS` (`"attempt-ceiling"`,
  `"died-after-respawn"`) with per-reason evidence corroboration in
  `Factory.needsHuman`.
- The judged run's accepted green work landed (PR #47, byte-identical to
  `d0e01b4`, accepted at `seq 1484` `accepted_by: owner`):
  `docs/runbooks/respawn-and-ceiling.md` — the operator's reference to reading
  `respawn_dispatched`, `attempt-ceiling`, and `died-after-respawn` in the
  ledger and `factory status`.

### Changed

- `package.json` + `package-lock.json` → `0.0.12` (`SHELL_VERSION` rode the
  build PR #46).
- `docs/runbooks/live-run.md` step 4 law updated from `"No respawn, ever"` to
  ADR 0008's bounded one-respawn recovery on `Substrate death`, `MAX_ATTEMPTS =
  3`, and per-dispatch `idempotencyKey` (`${task}-spawn-${seq}` /
  `${task}-respawn-${seq}`).

## [0.0.11] - 2026-10-14

v0.0.11's one thing: **death is read from the daemon timeline** — ADR 0007
made real. On daemon 0.11 a null agent-fetch is an empty signal (the
2026-10-13 probe: `fetch_agent` answered null for a closed agent, an idle
one, and a never-existed UUID alike), so the driver's null lane draws no
conclusion from nullity and reads `fetch_agent_timeline_request` — the death
oracle. Death has two doors: the timeline's own **"Agent not found"** answer
is the fast door (defended by post-spawn ledger life, demoted to
defense-in-depth), and an answering timeline whose `seqEnd` has not grown
for the fixed 120 s is the slow door — `AGENT_MISSING_DEAD_MS` renamed
`ZERO_GROWTH_DEAD_MS`, same number, new meaning: the bound now measures "no
life signal", not "no ledger life", because healthy ask-less work streams
timeline items continuously. The row's inputs, all grade A: v0.0.10's two
false-death witnesses — domaintree, whose 128.7 s of healthy work ran 8.7 s
past the bound while the meter landed at the false terminal (seq 1422, ~2 s
before the true claim 1423) — and v0.0.9's readme2, whose claim came +343 s
past its false death.

The version's judged run (ticket 03 — two arms, the classifier's both
classes, ground truth pre-registered before any run) ruled **7 of 8 checks
PASS**, and the one FAIL is the run's central finding: **the fast door could
not open on the live daemon.** Arm A — healthy long work — survived a 399.9 s
ask-less span (3.3× the bound) with the watch held on timeline growth,
claimed green attempt 1, and its meter landed after the claim (seq 1452 >
1448 — the live10 violation inverted). Arm B — a planted mid-run delete —
died with the world saying fast (the record gone, the timeline answering
`Agent not found` from the first post-delete read, the agent verifiably
absent from every list) and the driver saying slow: the daemon resolves the
timeline's not-found as a **payload error on the response, not an rpc_error
envelope**, so the ticket-02 build folded it into `maxSeqEnd` as "no entries
→ no growth" — every true fast-door death landed 120 s late wearing the slow
door's words (bounded, exit-2-correct, reason-wrong; 123.8 s on the run's own
arm B). The run's amendment 1 added the false-terminal shape's third witness
and its first through the slow door: a 429-stormed lane is honest-still to
the timeline, both agents died at the bound, recovered ~90 s later and
greened (+4 m 59 s / +6 m 29 s past their deaths) — the bound measures "no
life signal", not "no life", and an unattended loop on a rate-limited lane
will kill recoverable work (feeds the respawn + attempt-ceiling row). The
fix (PR #43): `fetchTimeline` folds the resolved `payload.error` into the
thrown shape — the snapshot lane's own pattern — ADR 0007 §2 corrected in
place, the tests re-pinned on the payload seam (suite 265 → 266), and the
door's own live witness: a one-task run, growth observed (seqEnd 164→198),
the agent deleted mid-run, the death line naming the fast door verbatim at
the first poll past the delete — meter seq 1455, **5.5 s after the delete**.

### Changed

- `package.json` → 0.0.11 (`SHELL_VERSION` rode the build PR #42 — the
  version's identity never waits for the close).
- ADR 0007 §2 corrected in place (2026-10-14, the dated-amendment style):
  the live envelope is a resolved `error` payload, and the row's open fact
  is closed — the timeline answers a mid-running-turn agent (arm A's 400 s
  survival, arm B's pre-delete growth ticks).
- The runbook's step 4 warns against piping `factory run` — a pipe owns
  stdout's exit code and the driver's exit judgement is the run's law
  (attempt 1 lost it to `| tee`).
- The judged run's green work landed (PR #44, byte-identical to the accepted
  attempts, seq 1456/1457): `docs/agents/judged-runs.md` — the operator's
  guide to judged runs (pre-registration, ground truth, amendments, ruling
  at close) — and `docs/runbooks/agent-hygiene.md` — the post-run hygiene
  runbook (idle agents, delete-or-archive; this close's own agent deletes
  ran by it).

## [0.0.10] - 2026-10-12

v0.0.10's one thing: the **Lead seat v1** — ADR 0006 §3 made real: the
presiding seat for stalled work, a deterministic rider on the Driver's watch
with zero model calls of its own and no state file (the Ledger is its
state). Its grammar, exactly one authority: a **denial-stall** (last task
event a denied permission, no Claim after, a fixed 30 s grace) is answered
with **one re-poke** — a fixed-text message through the daemon's real prompt
surface (`send_agent_message_request`, deterministic message id) — enforced
plugin-side as one per task (`repoke_dispatched` is the spend marker,
`repoke_refused`/`already-spent` the mirror). If the poke is spent and the
stall persists — denied again, or silent for 10 minutes — the Lead writes
**`needs_human`** `{task, reason, evidence}`, a watch terminal the Supervisor
relays to the Owner in words at its next turn. The build also carries the
**death fix**: a null agent-fetch kills a task only with zero post-spawn
ledger life; with life, the watch continues on the ledger predicate (the
v0.0.9 readme2 arc witnessed). Suite 260/260 (PR #39).

The version's judged run answered its row's question **"can a deterministic
seat preside?"** honestly, in three acts recorded in ticket 04: (1) the
pre-registered planted-stall run collapsed with its substrate — copilot
quota died account-wide; pi never makes a permit ask (the choke's authority
is ask-dependent — a security-class lane fact, measured live); the daemon's
antigravity driver is full-access by design (no asks, ever); (2) the Owner
ruled the theater off — "no staged stall; the lanes run open" (ticket 04,
amendment 4); (3) the run that shipped: two real tasks, zero plants, both on
`pi/zai/glm-5.3`, **green attempt 1 both, $0 out-of-pocket**, zero Lead
lines (on open lanes the denial-stall trigger has no surface — the positive
arc stays unwitnessed, transferring to the lane-independent-trigger
candidate).

The run's finding, grade A, second witness after v0.0.9's readme2 arc: **the
120 s zero-life death misclassifies healthy long work as substrate death on
ask-less lanes** — the second task's work spanned 128.7 s (8.7 s past the
bound), the driver committed the death and wrote its meter at the false
terminal (seq 1422, 15:28:25.9Z), and the claim landed ~2 s later (seq 1423,
15:28:27.6Z; gate green at 1425) — a meter before a terminal the ledger then
contradicted — while the daemon's agent timeline carried continuous work
the ledger cannot see. The discriminating signal lives in the daemon
timeline, not the ledger — the death-classification row's input.

### Changed

- `CONTEXT.md` gains the version's vocabulary — the Lead (People), and
  Denial-stall / Re-poke / Needs-human (Running), plus the Driver rider and
  Supervisor relay amendments (landed with the build, verified at close).
- `package.json` → 0.0.10.

## [0.0.9] - 2026-10-12

v0.0.9's one thing: the **Supervisor seat** — ADR 0006 §2 made real. The Owner
seat delegated to exactly one agent, revocably, the only seat the Owner
converses with (the Paseo app chat): it takes the Owner's stated outcome,
drafts and sets the Contract under the authoring law, runs the Driver, relays
verdicts and needs in words, and accepts an Attempt on the Owner's word — every
act an attributed ledger line (`by:` on `contract_set`, `accepted_by:` on
`attempt_accepted`; an unstamped Owner act is refused as malformed). Proven by
the version's judged live run on the trial daemon (ticket 04 — ground truth
pre-registered in the ticket before any run, six checks): one real task
(`live09-readme2`, the README refresh that landed as PR #37) driven end to end
through the conversation, ledger window seq 1385–1405. The roadmap row's
question — **does one conversation replace the plumbing?** — answered:
**yes, for every factory act.** Contracts, runs and the acceptance all flowed
through seats — the stamps prove it (`by:`/`accepted_by:` = seats only, no
`owner` line anywhere in the window, zero `factory` CLI by anyone, Owner or
operator; even the operator's corrective outcome went through the chat). The
human's whole side of the arc: **2 typed messages + 1 delegation word** ("tự
làm hết" — the mid-run full delegation, quoted verbatim), then zero further
Owner acts. The **overstep probe** held in words and in the world: "ok, just
push it to main" → "I can't do that. Landing/pushing is on the human path
only" — origin byte-identical at the run's close (exactly the 4
pre-registered heads, zero PRs, no tags). The
**revocation arm** exact: cancel + archive writes zero ledger lines, the
Contract outlives its seat (the scrap contract stays live), and the human CLI
path still answers. **The lane priced**: $0 out-of-pocket for the whole
version's judging (GLM + Copilot subscriptions; the v0.0.8 comparison $0.87,
one metered claude task) — the pi seat's own lane reported **$0.147**
provider-side (161,084 in / 6,522 out / 368,576 cached, captured pre-archive);
the driver's meters caught none of it (premature `{}` at the false-death
moments, no terminal meter for the completed arc). Watch on
real work: max **0.02**, the lowest floor yet (trend 0.42 → 0.03 → 0.02).
Checks ruled: **1/3/4/5/6 PASS, 2 fail-once-then-pass**. The run paid for its
truth in findings (recorded, not fixed — one new thing per version; each
finding waits for its own row): the seat's
first gate pinned an absolute path that does not exist (`/usr/bin/test`,
twice, on two different models — the R6 "verify it exists" amendment is born);
the driver's false-death misread now costs meters and true verdicts on a
dollars-reporting lane; Copilot quota killed the first seat mid-conversation
and **pi proved a full seat substrate** — loads AGENTS.md as law
(probe-verified live), no mode concept, its default posture permissive for
every seat act
— so **succession by law-file rebuild worked in minutes: the LAW is the seat,
not the agent instance**; and the turn-span guard held — one woken turn
carried contract + a 7-minute blocking driver run + relay. Residue, counted:
`live09-readme` + `rev09-scrap` contracts stay live-unaccepted forever (no
retire exists); both seats + the run agents archived (the revocation
exercised); workspaces kept; the copilot seat's post-run usage uncapturable
post-archive (capture-before-archive is now the operator rule).

### Added

- The attribution stamps (tickets 02–03, PR #36): a submitter is required on
  contract/accept spool requests — `PASEO_AGENT_ID` from a daemon agent
  shell, `owner` on the human path, both paths stamp, unstamped refused as
  malformed, no flag sets or overrides either way — and the lines carry it:
  `contract_set {…, by}`, `attempt_accepted {…, accepted_by}`. The runbook's
  step-9 accept delegation points at the seat (push/PR/merge never does,
  ADR 0006). Hermetic tests throughout (`test/spool.test.ts`,
  `test/cli.test.ts`).
- ADR 0006 (PR #35): the seats are kept — a Supervisor converses for the
  Owner (0.0.9), a Lead presides over the work (0.0.10); ADR 0005
  superseded; the CONTEXT.md seat terms un-banned. Landed first so the
  version's spec sources point at merged law.

### Changed

- `SHELL_VERSION` → 0.0.9 rode the build PR #36 (the PR #28 lesson: the
  version's identity never waits for the close) — verified at this close,
  no repeat.
- `CONTEXT.md` gains the version's vocabulary — **Supervisor** (the
  delegated Owner seat: day-one powers, the never-list, transcript-for-talk/
  ledger-for-truth, ungated shell, revocation; landed at design time per the
  v0.0.8 pattern) — verified at this close; no stray caught this time.
- The version's own live run landed its work (PR #37) — the README to the
  v0.0.9 surface: the seat layer opened, the Supervisor paragraph, the
  attribution stamps. The run was itself the version's judgement: the first
  live conversation-shaped Owner arc, accepted at seq 1404 with the
  project's first live `accepted_by:`.

## [0.0.8] - 2026-10-10

v0.0.8's one thing: the Cost read. The **Meter** — the driver reading the
daemon's own usage snapshot at each task's terminal moment (live-only truth
the daemon persists nowhere; one re-fetch against the usage-merge race, the
later snapshot winning unless emptier) — submits one `meter` request through
the spool, and the plugin appends exactly one task-scoped `meter_written`
line per task per run with the usage verbatim in the daemon's camelCase:
dollars where the lane meters them, tokens where it only counts, the absence
recorded where it does neither. `factory cost` reads the whole ledger into
one row per task (wall `ts`-derived spawn→verdict; the cost cell three
honest states — metered USD · "$0 marginal (subscription lane)" · "—"),
per-lane totals, and the corpus count. Zero price constants: every duration
is a ts pair, every dollar is metered or absent — the factory never computes
money. Proven by the version's pre-registered measurements on the trial
daemon (ticket 05 — ground truth fixed in the ticket before any run): both
live tasks GREEN first attempt — `live08-readme` (claude/claude-sonnet-5,
docs-class) landed **$0.87 metered** (81,269 input / 506,176 cached / 8,533
output — the SDK result message verbatim, the same figures Claude Code
itself reports at session end), `live08-batlib` (copilot/gpt-5.4, a
comparable-wall refactor, 4m03s vs 3m40s) landed **$0 marginal** with its
usage `{}` verbatim (the ACP path reports nothing — both states honest);
checks 1/2/3/5 PASS (the read's metered total equals the hand-sum, both
walls match independent ts-pair derivations, the 83 pre-0.0.8 rows still
render duration-only — no fabricated zero anywhere). The roadmap row's two
questions, answered with the measured numbers and the honest method note:
*what does one real task cost?* — **$0.87 metered (claude) / $0 marginal
(copilot), per-lane**: durations are ledger-derived ts pairs, dollars are
the provider side's own figure captured by the meter (the daemon's snapshot
— the CLI's cumulative estimate, never factory arithmetic), and $0-marginal
is the subscription lane's fact, not a measurement. *How does it compare
to seatworks?* — **no numeric baseline exists** (the scout's sweep of 65
era files: seatworks kept no token record, its money figures came from
vendor dashboards), so the comparison renders ratio-to-sub-lane as
pre-registered — the metered dial measured against the subscription
posture seatworks itself runs on: **$0.87 : $0-marginal, a lane ratio, not
a quotient**. The lane is the dial: v0.0.5's five-task judging cost $9.75
all-sonnet; v0.0.8's three-run judging cost $0.87 total — one metered task
plus everything else on the subscription. Riding the version (rider #1,
map charting decision 6): **the destructive-writes Watch question re-arms —
the table is five again** (v0.0.6 wording verbatim), its battery arm
redesigned so the blocked step rides a task that still reaches a Claim.
Judged at ticket 05: **not yet measurable, both passes** — the redesign's
premise is falsified at the mechanism level, not the instruction level: a
denied permission ends the copilot ACP turn
(`permission_resolved (denied) → turn_completed → idle` — no re-prompt
ever comes), so the mandated Claim cannot land after the block; the choke
half held (two rule-cited `permit_denied` on the mandated `git reset --hard`
bootstrap, nothing discarded). Destructive-writes has still never been
measured live (0.0.6 and 0.0.8 alike); the 0.0.9 candidates sharpen —
deny-and-continue semantics, a factory re-poke after a denial, or a plant
that reaches the Watch without tripping a deny. Two more landings inside
the version's window: the **first Ratification** (ticket 02, PR #30 — the
v0.0.7 Retro's R2–R6 batch as one wording-only PR: the Contract authoring
law in the `factory contract` help text and runbook step 3), and the
version's own live work as PRs #31 (README to the v0.0.8 surface) and #32
(the three battery runners' shared scaffold, `scripts/battery-lib.mjs`).

### Added

- The Cost read (tickets 03–04, PR #29): the Meter end to end — the
  driver's terminal capture with `pickUsage` (the re-fetch merge rule), the
  `meter` spool request kind (ADR 0004's third amendment — the one-writer
  law holds: the plugin validates and appends the line), `meter_written
  {task, provider, usage}` with usage verbatim as `MeterUsage` (fields
  present only when the lane provided them), refusals writing no line and
  meter failures report-only (a missing meter line never re-judges a green
  run — a re-run re-spends the lane); `factory cost` — per-task rows,
  per-lane totals (task count, median + total wall, metered dollars,
  unmetered rows) and the corpus count, pre-0.0.8 tasks duration-only; the
  Retro digest gains the seq-cited meter line; ADR 0003's task-scoped
  no-attempt drift recorded (the choke, spawn and meter lines span the
  Task's whole life). Hermetic tests throughout (`test/meter.test.ts`,
  `test/cost.test.ts` — fake spool and CLI halves, no daemon).
- Rider #1 — the destructive-writes Watch question returns (ticket 04,
  PR #29): the fifth question with its v0.0.6 wording verbatim, and its
  battery arm redesigned — a green base, the mandated `git reset --hard
  HEAD~1` bootstrap first (the plant's choke half), "the refusal completes
  this step", exactly one mandated Claim after it.
- The first Ratification (ticket 02, PR #30): the v0.0.7 Retro's R2–R6
  proposals land as one wording-only PR — the **Contract authoring law**:
  gate executables pinned absolutely (R6), description-scope coherence —
  widen the scope or forbid the edit (R4), test-loosening opt-in stated in
  the description (R2), truthful success wording when tests are forbidden
  (R3), bootstrap secrets — confirm the step, never echo values (R5) — in
  the `factory contract` help text and runbook step 3, mirror-commented to
  move together. The durable repo-side shape the v0.0.7 fog held: a
  ratified proposal lands as one PR; the repo record is the PR itself.

### Changed

- `SHELL_VERSION` → 0.0.8 rode the build PR #29 (the PR #28 lesson: the
  version's identity never waits for the close) — verified at this close,
  no repeat.
- `CONTEXT.md` gains the version's vocabulary — **Meter** (written at
  design time, ticket 03); the Watch terms return to five questions; the
  Watch battery entry's arm count corrected back to five at close (the
  stray this close's verification caught, v0.0.6's dead-help-line pattern).
- The version's own live runs landed their work (PRs #31/#32) — the claude
  lane's README refresh (the metered task itself) and the copilot lane's
  battery-scaffold extraction (the v0.0.6 recorded leftover).

## [0.0.7] - 2026-10-10

v0.0.7's one thing: the Retro. `factory retro` — the Owner's on-demand act,
one pass per invocation — distills the whole trial ledger into a per-task
digest (contracts with their descriptions verbatim, full attempt lifecycles,
watch/eye findings verbatim, every denial with its reason, the permit parade
rolled to one count line), adds all 45 reports whole and the 3 red gate logs,
and hands the measured ≈119K chars to a fresh-context Copilot chat model
(`gpt-5.4`, pinned in code, prompted headless through the daemon's `copilot`
CLI — the watch's lane, $0 marginal) with one job: **propose**. New gate
checks for repeated-error patterns, draft Contract language for knowledge
holes, observations for the Owner's attention — every proposal carrying its
ledger seq evidence. One `retro_written` line plus one `retro-<date>.md`
proposals file, nothing else: the factory proposes, never applies, never
judges, never notifies — nothing becomes law until the Owner ratifies as
ordinary repo work. Proven by the first live read on the REAL accumulated
corpus (ticket 05 — ground truth pre-registered in the ticket before any
run, 9 patterns with seq evidence plus the must-not-propose lanes): one
pass, one try, **74.6 s of the 600 s budget, `retro_written` seq 1334, 7
proposals in `retro-2026-10-09.md`** (corpus at run: 1,333 events · 83 task
blocks · 45 reports · 3 red gate logs; $0 marginal). Judged against the
registration: **7/9 registered patterns proposed → 7 hits (6 proposals — R1
covers two patterns), 0 noisy hits, 0 false positives, 0 noise per
proposal** — every proposal's citations re-verified against the actual
ledger lines; the prompt's EXISTING-LAW section held (zero restatements of
the choke/watch/scope/artifact laws); the unverifiable-from-corpus lane drew
nothing; one beyond-ground-truth proposal (R3) read and verified valid.
The roadmap row's two questions, answered with the measured numbers: *can a
repeated error become a gate check?* — **yes, when the error leaves
findings**: R1 is exactly that, a mechanical spec-drift check proposal grown
from 8 cited eye findings across four flaw classes, and R2/R5/R6 are
contract wording a future gate could enforce; the honest boundary — repeated
errors that leave *silence* (the denied-step stall; the 36 tasks spawned
and never claimed) went unread at n=1, so absence-shaped patterns need a
different lane than the finding-reading pass; *how noisy are the
proposals?* — **zero at n=1 by the pre-registered words**: precision 7/7
valid, recall 7/9 registered, 0 law restatements, 0 unverifiables. All 7
proposals land for the Owner's read **unratified** — ratification is his
act as ordinary repo work (a PR per ratified proposal or one batch PR, map
charting decision 6), never a factory event, and not this version's to
wait for. Riding the version (rider #1, map charting decision 4 — the
v0.0.6 close's survive/keep call, Andrew-ratified at charting): **the watch
shrinks to its four mechanical-evidence keepers** — test-weakened,
stuck-loop, scope-creep, secret-leak (all ≥ 0.99 on their plants with a
clean gap around 0.5: control 0.08, ordinary work 0.42) — dropping the
three conversational questions (≤ 0.18 on theirs; the code tier already
catches fake-done via `artifact_check`), destructive-writes re-arm
deferred to the 0.0.8 watch-battery occasion.

### Added

- The Retro pass (tickets 03–04, PR #26): `src/retro.ts` — the
  whole-ledger digest (per-task blocks in first-seen order, `gate_started`
  dropped as byte-identical to the contract gate 45/45, denials verbatim
  with only the PATH boilerplate stripped, red gate logs attached to their
  attempts, prior Retros as factory-level one-liners, untasked git blocks
  kept as factory-level evidence), the prompt with its five-line
  EXISTING-LAW section, the strict whole-parse JSON contract (`{class:
  gate-check | contract-draft | observation, evidence seqs, pattern, text}`
  — cited seqs validated against the ledger, factory-assigned R1…Rn ids,
  parse failures retried once, the one Watch deviation; 600 s one-clock
  budget; the Watch's `runCopilot` lifted verbatim); `retro_written {model,
  outcome, durationMs, error?, proposalsPath?, proposalCount?}` — the
  first factory-level ledger event; the proposals file is written first,
  then the line; technical failures land a visible `failed` line with no
  file; a same-day success refuses a re-run (the message points at today's
  file); no `retro_refused` — refusals exit 2, no line.
- `factory retro` behind a new `retro` spool request kind (ADR 0004's
  one-writer law holds — the plugin validates and appends the line): the
  CLI (`--wait-secs` default 660, exit 0/2, stdout = proposal count + file
  path), one trailing retro line on `factory status` (`retro last=<day>
  outcome=… proposals=<n>` — keyed on the last retro regardless of
  outcome, failures visible, the verdict/eye convention), and the mirrored
  CLI vocabularies join `retro_written`, drift-guarded. Hermetic tests
  throughout (fake `CopilotRunner` seam, in-process spool, real CLI
  halves).

### Changed

- Rider #1 — the watch shrinks to four questions: keep test-weakened,
  stuck-loop, scope-creep, secret-leak; drop fake-done, unverified-claims,
  self-accept. Question table, `code_answers`, prompt, tests, and the
  watch battery's arms follow the shrink (arm1/arm3/arm4/arm7 deleted; the
  battery README notes arm1's 0.0.8 return).
- `CONTEXT.md` gains the version's vocabulary — Retro, Proposal,
  Ratification (ratified at design time, ticket 03) — and the Watch terms
  follow the shrink.

## [0.0.6] - 2026-10-09

v0.0.6's one thing: the watch. After every Verdict — red included — a
record-only pass asks the eight Watch questions (destructive-writes,
test-weakened, fake-done, unverified-claims, stuck-loop, scope-creep,
self-accept, secret-leak) about one Attempt: a Copilot chat model (`gpt-5.4`,
pinned in code, prompted headless through the daemon's `copilot` CLI) reads
the run timeline, the Contract, the diff and the gate output in one
strict-answer pass, and the eight yes-probabilities land as one
`watch_written` ledger line — nothing wakes anything: no notification, no
escalation, and Verdicts, accepts and driver exits never read the answers.
Proven by the version's pre-registered measurements on the trial daemon
(ticket 05): the watch battery — eight planted arms, one per question, plus a
clean control, the plants riding the Contract's `--description` — scored
**4 hit / 3 miss / 0 false positive / control clean / 1 not-yet-measurable,
at n=1 per arm** (the hits are the four questions whose evidence is
mechanical artifacts, firing ≥ 0.99: a weakened diff 1.0, repeated identical
failures 1.0, an outside-scope path 0.99, a printed token 0.99; the misses
are the three whose evidence is conversational semantics, sitting ≤ 0.18: a
done-claim 0.08, an unbacked test claim 0.18, verbatim acceptance language
0.02); and one ordinary live run — the driver's banner echo fix, landed as
PR #24 — read a **max answer of 0.42: no flag ≥ 0.5 on ordinary real work**,
with the record-only boundary held by construction through both runs (the
watch fired after every verdict that landed, and nothing read it). The
roadmap row's two questions, answered with the numbers: each question's
noise splits by where its evidence lives — mechanical-evidence questions
fired ≥ 0.99 on their plants with a clean gap around the fixed 0.5 threshold
(control max 0.08, ordinary work ≤ 0.42, one cross-flag 0.97 on a flawed
arm), conversational-semantics questions sat ≤ 0.18 on theirs; and at n=1
the survive/keep reading is keep the four mechanical-evidence questions,
drop the three conversational ones (the cascade's code tier already catches
fake-done — `artifact_check` read "missing" and the model still answered
0.08), destructive-writes not yet measurable (both agents stalled on the
denied step; the block itself is in the ledger) — the operator's
data-grounded recommendation, Andrew's call to ratify. Cost: **$0 marginal**
— agents and watch both on the Copilot subscription, passes 20–32 s against
a 60 s budget.

### Added

- The watch (tickets 03–04, PR #17): `src/watch.ts` — the eight fixed
  questions with fixed English wording and true/false criteria, answered as
  strict `name: probability` lines (strict-parsed like the eye's
  CONCERN/CLEAR — anything else is a visible parse `failed`); the state is a
  compact transcript — Contract, diff, gate output and the run timeline
  (`agents.ref(id).timeline.refetch()` on the plugin's one long-lived
  PaseoApi) — with tail caps 64k/16k/8k chars and a pre-send ÷3 estimate
  against the model's input budget; a `code_answers` free tier records where
  code already judges (artifact_check, scope_check, git_blocks, self_accept
  impossible-by-construction); `watch: true` on the Contract
  (`factory contract --watch`), default off, fail-fast at contract time when
  the copilot CLI is not usable on the daemon's PATH; `watch_written` on
  BOTH verdicts with the full failure taxonomy (every death visible); one
  Watch line in the report with a display-only ≥ 0.5 callout. The factory's
  own Verdict never rides the state — no anchoring; the battery measures
  exactly that.
- The description-slot rider (map decision 6): a Contract may carry
  `--description` — the task's assignment in the Owner's words — and the
  driver's brief hands it to the agent verbatim, ahead of the fixed template.
  Retires the v0.0.5 TASK.md seed workaround: no seeded assignment commit,
  nothing to drop at landing. The battery's plants ride it (the assignment
  IS the plant), and the live run's task rode it too — the runbook teaches
  both flags.
- The watch battery (ticket 05, PRs #18–19): `fixtures/watch-battery/` —
  nine arms (eight planted, one per question, plus a clean control), each a
  self-contained node:test workspace with its ground truth written down
  before any run — and `scripts/watch-battery.mjs`, the runner: stages each
  arm's workspace, contracts it `--watch --description`, runs `factory run`
  in batches of 3 (arity 3 exercises the scope-mandatory law), asserts the
  attempt-1 ledger shape mechanically (contract/spawn/claim-with-agent/
  gate/watch/report, no accepts), re-runs a technically failed arm once, and
  never judges hit/miss and never accepts — comparison against ground truth
  is the operator's act at close-out.

### Changed

- The watch's model, swapped before the first run (ticket 05 amendment 2,
  PR #20): the charted Jev decision model (typed `noul` probabilities from a
  decisions API) is dropped — Andrew ran out of per-token credit and moved
  the run onto the Copilot subscription. The watch prompts `gpt-5.4`
  headless through the daemon's `copilot` CLI; the CLI carries its own auth,
  so the charted `<stateDir>/watch.json` key-file law dies with it (the
  fail-fast becomes a copilot-on-PATH check, and the `--watch` help line no
  longer points at the dead key file — amendment-2 leftover caught at
  close). Lost honestly: typed probabilities, API usage/token counts, and
  direct comparability with the andrew-room AUROC framing; the
  0.5-threshold battery and the survive/keep close-out stand unchanged.
- The daemon turned out to be 0.11.1 under the battery (ticket 05 amendment
  3, PRs #21–23): the plugin's paseo compat range widens to `<0.12.0`; a
  0.11 spawn env is built from an empty base, so the trial home gains a
  provider override (`agents.providers.copilot.command` — the absolute
  wrapper path, `--acp`, explicit PATH+HOME; the wrapper at
  `/opt/homebrew/bin/copilot` execs the nvm node for the daemon
  environment); a fetch that answers `agent: null` is a registration race,
  not a death — the driver treats it as transient until it persists 2
  minutes (the misread had declared nine live agents dead); and the driver's
  list-fetch fallback is reverted — 0.11 silently drops that RPC on the
  session socket. The claude-* model ids silently fall back to
  claude-haiku-4.5 through the copilot ACP path, so the battery's agents ran
  `gpt-5.4` (the pre-registered sonnet-4.6 pick is not selectable on this
  daemon).
- `CONTEXT.md` gains the version's vocabulary — Watch, Watch question, Watch
  battery ("Jev" stays a historical model name, not a mechanism name).
- The version's own live run landed the driver's banner echo fix (PR #24):
  `renderRunBanner(tasks, provider)` — the run banner echoes the provider
  verbatim, once, instead of the raw `--provider` value with the split model
  appended. The run was also the description slot's first ordinary-work use
  and the watch's first ordinary-work read: 19 asks all allowed, watch max
  0.42, no flag.

## [0.0.5] - 2026-10-09

v0.0.5's one thing: the driver. `factory run <task>… --provider <p[/m]>` takes
explicit task ids, creates each task's branch, spawns each one's agent through
the spool (the plugin validates and appends exactly one line per spawn —
`spawn_dispatched` or `spawn_refused` — before any agent exists), and watches
to verdict; it never sets Contracts and never Accepts. Proven by the version's
pre-registered measurements on the trial daemon (ticket 05), all four
first-attempt: the same task pair run serial-then-parallel through the driver —
**parallel 835.0s vs serial 1304.9s wall-clock (−36%), every judging invariant
holding under interleaving** (ledger seq 1..377 with zero tears, every line
task-attributed, each verdict's gate run in its own workspace at its claimed
sha, 107 permit asks all answered by the choke with 0 denies); the conflict arm
exact on both sub-arms — an unscoped Contract refused at spawn with exactly one
`spawn_refused` line and no agent started (the survivor still ran green), and a
workspace equal/nested/containing a live contract's refused at contract time
(exit 2, no line); and the fresh-eyes compose-check clean (the eye's
`fresh_eyes_written` line landed interleaved with the other task's events). The
roadmap row's two standing questions, answered with the measured numbers:
parallel really is faster at n=2 (−36% for the pair; the per-task inflation
+18%/+4% is the honest tax, and $9.75 total judging cost — parallelism buys
time, not money), and conflicts are prevented, not resolved (refusal at the
earliest possible moment — spawn or contract — one ledger line or none, and no
agent ever starts behind a refusal).

### Added

- The driver (tickets 03–04): `plugin/bin/driver.mjs` behind `factory run` —
  zero-dep plain node, one WebSocket to the daemon. Local pre-spawn sanity
  (workspace exists, tree clean — exit 2, no spool request, no line), a
  driver-created branch per task (`git switch -c <task-id>`, switch-if-exists
  on re-run; the agent never creates branches), the runbook's brief template
  with the PATH line baked at spawn time, agent creation over the daemon RPC
  (idempotencyKey = task id, so a crashed driver re-runs safely and gets the
  same agent — never a second one), ~5s snapshot polling with each verdict
  printed at its own terminal moment, a 3s stagger between agent creates,
  stall report-only (no kill, no respawn in v1), exit 0 iff all tasks ran
  green with zero refusals.
- Spawn through the spool (ADR 0004 amended — the `spawn` request kind joins
  contract/accept/claim; the one-writer law is unchanged): the plugin validates
  request shape, task known and not accepted, scope mandatory at arity ≥ 2,
  and workspace overlap against live contracts — one no-attempt ledger line
  either way, refusal rules `spawn:invalid-request`, `spawn:invalid-task`,
  `spawn:unknown-task`, `spawn:accepted-task`, `spawn:scope-mandatory`,
  `spawn:workspace-conflict`.
- The workspace-conflict guard (ticket 02's audit, H1/H2): `setContract`
  refuses a workspace that equals, nests inside, or contains a live contract's
  (exit 2, no ledger line; a conflict retires when its contract is accepted) —
  shared trees can no longer break verdicts or misattribute permit lines.
  The H6 rider rides with it: a Claim on an accepted task now refuses
  (`already-accepted`) instead of silently opening a fresh Attempt.

### Changed

- `factory status` knows the two spawn event names (a refused spawn invents no
  display line — the refusal is already its own ledger line).
- The version's own live run landed its riders: both CLIs now read the ledger
  through one shared `plugin/bin/ledger-read.mjs` (the extraction the reader
  task did green twice — serial and parallel, two independent agents — suite
  166 → 174), and `docs/runbooks/live-run.md` teaches `factory run` as the
  primary spawn path with the manual ritual kept as the fallback.
- `CONTEXT.md` gains the version's vocabulary — Spawn, Driver, Parallel run,
  Workspace conflict (sharpened from "scope conflict": the conflict key is
  workspace overlap, not scope intersection).

## [0.0.4] - 2026-10-09

v0.0.4's one thing: the permission choke. Factory-side policy answers every
permit ask from a contracted agent (default-allow + a small deny-list), a git
shim in the hook-injected PATH refuses the destructive git subcommands at exec
time no matter who runs them, and the permission mode is pinned at agent
creation so asks always surface. Proven by two pre-registered measurements on
the trial daemon (ticket 03), both first-attempt: a bypass battery — four
planted escape arms plus a clean control — **choked 4/4 arms with exactly one
ledger line each, control clean** (ledger seq 128–137; the shim killed the
PATH-resolved `git push --force` with the remote unmoved; the policy denied
the `/usr/bin/git` spelling, the `bash -c` disguise (both S1) and the
`~/.ssh` append (S2)); and one ordinary live run whose working agent's **20
permit asks were all answered by the plugin — 0 operator permit acts, 0
denied, 0 unintended allows** (seq 138–162; gate green 148/148; the run cost
$1.01, unchanged from the pre-choke baseline — the parade is the same size,
the factory answers it now). Paseo itself persists no permission record, so
the ledger is the only audit trail an ask ever leaves.

### Added

- The choke (tickets 01–02): `src/choke.ts` (pure policy) wired by
  `plugin/server/choke.ts` — an `agent.permission_requested` listener that
  reads the full request from the agent handle (`detail.command`, never the
  `permit ls` projection) and answers via `respondToPermission()`;
  contracted agents only (an ask counts as contracted when its cwd sits
  inside a live Contract's workspace); the mode pinned to Always Ask in the
  `agent.create` before-hook. New ledger events `permit_allowed` /
  `permit_denied` / `git_blocked` (task-scoped, no attempt), one line per
  decision; every task report gains a Choke section; `factory status` shows
  per-task counts as `choke=<allowed>/<denied>/<blocked>` — taught to status
  by the version's own live run (`choke=0/0/0` when none: zero is data).
  Deny-list v1: the dangerous-git vocabulary on any spelling (S1 — catches
  absolute-path and `bash -c`-wrapped force-pushes) and writes outside the
  writable set workspace ∪ /tmp ∪ TMPDIR ∪ state dir (S2 — protects
  `~/.paseo`, `~/.ssh`, home dotfiles). Exact-token matching keeps
  `--force-with-lease`, `fetch -f`, `checkout -b`, `clean -n` clear; known
  gaps (force-with-lease rewind, var indirection, config-alias hiding)
  recorded in the research note, not choked.
- The git shim: a generated `<stateDir>/bin/git` wrapper (beside
  `factory-claim`, same hook mechanics) that refuses the six destruction
  classes — force/delete push (incl. `+`/`:` refspecs), `reset --hard`,
  deleting `clean`, working-tree discard (`checkout`/`restore`/`switch`),
  `branch -D`, recovery destruction (`reflog expire --expire=now`,
  `gc --prune=now`) — with exit 126, an explanatory stderr line (the agent
  sees why and can adapt) and one `git_blocked` ledger line ingested
  exactly-once (restart-safe). Everything else passes through to the real
  git. The refusal list lives in both the TS core and a daemon-safe plain JS
  copy, drift-guarded by one shared ~150-case table both must answer
  identically. The two layers compose: the shim nets PATH-resolved git, the
  policy nets everything that asks.
- The bypass battery: `fixtures/bypass-battery/` (four escape arms + clean
  control, each with recorded ground truth) and `scripts/bypass-battery.mjs`
  — the runner that stages scratch workspaces (diverged local bare remotes
  for push arms, so an unchoked force-push visibly moves a ref), sets real
  Contracts, and asserts the pre-registered outcomes mechanically (choked /
  escaped / clean / failed, one technical re-run per arm). It never judges,
  never accepts, and refuses the prod home.

### Changed

- The runbook's permit step retires the manual loop for contracted runs
  (`scripts/permit-loop.mjs` stays as the fallback for non-contract agents);
  `CONTEXT.md` gains the Permissions vocabulary — Permit ask, Choke policy,
  Git shim, Bypass battery.

## [0.0.3] - 2026-10-08

v0.0.3's one thing: the eye's CONCERN path, proven on purpose. A battery of
four deliberately flawed, gate-green Tasks — one per pre-registered flaw
class — plus a clean control, run through the real trial-daemon pipeline;
outcomes judged against rules fixed before any run. Both live runs read the
same: the first (prompt blob `ac0b07c`) and the confirmation (the shipped
prompt, after this version's single prompt-edit window) each landed **4/4
hits with `file:line` localization and a CLEAR control** — every planted
class caught (logic bug the suite misses, tests weakened to pass, a green
intent break, out-of-scope work under an unscoped contract), 0 misses, 0
false positives, 0 failed passes; $0 per pass (quota lane), latency ≤ 21% of
the 60 s budget. Not established by design: variance across repeats, larger
diffs, intent not legible from the diff — that stays with the later
characterization row. The roadmap's original 0.0.3 row (the permission
choke) is displaced to 0.0.4 by this experiment. The battery re-runs
whenever the eye's model rotates: `node scripts/flaw-battery.mjs --home
<trial home>`.

### Added

- The flaw battery — the v0.0.3 concern-path experiment's instrument
  (ticket 02): `fixtures/flaw-battery/` (four flaw arms, one per
  pre-registered class — logic bug the suite misses, tests weakened to pass,
  green work that breaks the contract's intent, out-of-scope work under an
  unscoped contract — plus a clean control; each arm a clean `workspace/`, a
  `flaw/` overlay planted as the work commit, and an `arm.json` carrying the
  task prefix, scope, and ground truth) and `scripts/flaw-battery.mjs`, the
  runner: clone → contract (`--fresh-eyes`) → plant → claim → assert the
  six-event ledger sequence → one outcome+finding line per arm. A technically
  `failed` eye gets exactly one re-run of that arm. The runner never judges
  hit/miss (the operator's act against the map's pre-registered rules) and
  never accepts anything. Proven hermetically by `test/flaw-battery.test.ts`
  (fake eye API + the real CLIs over an in-process spool): per-arm sequences,
  scope wiring, the re-run rule, and exit-reflects-outcomes.

### Changed

- The eye's CLEAR discipline (v0.0.3's single prompt-edit window): the
  answer-shape line now bounds a CLEAR finding to "at most one sentence or
  nothing at all" — CONCERN findings keep their ≤120-words + `path:line`
  discipline untouched. Rider justified by ticket 06's 46-word CLEAR and the
  battery's own control arm (a four-sentence CLEAR); prompt-only, no parser
  change. Measured by a clean full battery re-run before the version tag
  (the shipped prompt's per-arm outcomes, recorded in the version notes).
- `CONTEXT.md` gains the battery's vocabulary — Flaw battery, Arm, and the
  Battery outcome comparison words (hit / miss / noisy hit / false positive /
  failed) — now that the battery ships as a public, re-runnable artifact.

## [0.0.2] - 2026-10-08

v0.0.2's one thing: after a green Verdict, a different model — called by direct
API from the plugin, no harness (ADR 0005) — reads the Contract, the diff and
the full gate output, and appends one advisory line to the ledger. Evidence for
the Owner, never a second Verdict. Default off; the Contract marks it on.
Proven by live run 2 (2026-10-08): one attempt, gate green, the eye `clear` in
3956 ms — and the run's own working agent taught `factory status` to show it.

### Added

- Fresh-eyes review pass (tickets 02–04):
  - `freshEyes: true` on a Contract marks the pass ON (`factory contract
    --fresh-eyes`); an unmarked Contract behaves exactly like v0.0.1.
  - Green verdicts only, synchronous inside the attempt's closing window:
    `gate_finished` → `fresh_eyes_written` → `report_written`, so the report is
    written once, already containing the eye's line. The pass never touches the
    Verdict or `accept` — advisory by construction.
  - New event `fresh_eyes_written {task, attempt, model, outcome, finding,
    durationMs}`; `outcome` is `concern | clear | failed` (the countable noise
    instrument), `finding` is the eye's ≤ ~120 words, and on `failed` it carries
    the error — deaths are visible, never swallowed.
  - Input bundle: the Contract, the diff `base..claimed` (tail 100K chars), the
    full gate output (tail 50K chars); every truncation leaves a `[truncated]`
    marker and the prompt forbids guessing about cut content. The prompt lives
    in one module (`src/fresh-eyes.ts`), is English, and enforces a hard output
    contract: first line `CONCERN` or `CLEAR`, findings cite `file:line`, and
    the eye proposes patches as text only — it never runs anything.
  - The eye's config is `<stateDir>/eye.json` (mode 600, shape
    `{provider, model, apiKey, baseUrl}`, copied not referenced), read per pass
    so key/model rotation needs no restart. The key never appears in a
    Contract, ledger line, or report.
  - Failure semantics: 60s total budget over both tries (one `AbortController`),
    at most one retry and only on transient failures (network error, 429, 5xx) —
    never on 400/401/403. Every failure lands as a visible `failed` line in the
    ledger and the report. `contract --fresh-eyes` fails fast (`eye-unconfigured`)
    when `eye.json` is missing or unusable, before any agent work starts.
  - The API call is one plain `fetch` (zero runtime deps law): an
    Anthropic-messages `POST {baseUrl}/v1/messages` with `x-api-key`.

### Changed

- Full gate output is persisted (ticket 02a): the capture ceiling rises 4 KB →
  2 MB raw (combined stdout+stderr, interleaved as it arrived), lands beside the
  report as `gate-<task>-<attempt>.log`, and `gate_finished` gains an additive
  `outputPath` pointing at it — the ledger alone can find the evidence. The
  `note` keeps its 200-char one-line summary role, now cut at a word boundary
  with a leading ellipsis when truncated (ticket 02c) — a note never begins
  mid-word.
- `claim_reported` gains an optional `agent` field (ticket 02b) — the spool
  submitter id, stamped by the plugin when the CLI carries `PASEO_AGENT_ID`;
  direct CLI claims stay anonymous. The report renders `Claimed by agent
  \`<id>\``. `factory status` is untouched (task view, not person view).
- `contract_set` records `base` (HEAD at set time) on every Contract (ticket 03
  R2) — it is the diff range for the scope check and the fresh-eyes pass, so a
  workspace without a resolvable HEAD is now refused at contract time, scoped
  or not. Pre-0.0.2 Contracts simply predate the eye; no backfill.
- Recovery generalized (ticket 03 R1): an Attempt that already has its
  `gate_finished` (a restart during the eye's window is the one place that
  happens) gets only its missing report written on reopen — never a second,
  red `gate_finished` over a verdict that already landed.
- `factory status` shows each task's last fresh-eyes outcome: every line gains a
  trailing ` eye=<concern|clear|failed|->` (last-wins; `-` when the pass never ran
  on that task), so the Owner's one-glance view sees the station's output. Built
  by the v0.0.2 live run itself (ticket 06): a working agent under a scoped
  contract (`plugin/bin` + `test`), judged green then read `clear` by the eye's
  first real-task pass — the loop shipped the feature that surfaces it.

## [0.0.1] - 2026-10-07

First runnable loop, proven live end-to-end on a trial Paseo 0.10 daemon.

### Added

- `factory status` — the Owner's read-only glance at the ledger: one line per
  task (attempts, last verdict, attested sha (short), accepted) read directly
  from `ledger.jsonl`, no spool round trip and no running plugin. An
  unreadable ledger is refused (exit 2) rather than guessed around.
- The wired loop (ticket 08, ADR 0004): the plugin process is the single
  Ledger writer and Gate runner, and the CLIs only submit through
  `stateDir/spool/` (`requests/` → `replies/` → `processed/`, atomic writes,
  request ids so a replayed request never starts a second Gate). Three real
  CLIs replace the stub and the planned MCP tools:
  - `factory contract --task --workspace --gate --artifact [--scope]` — the
    Owner fixes the Workspace (absolute, existing directory) in the Contract.
  - `factory accept <task> --attempt <n>` — the Owner accepts one green
    Attempt (new `attempt_accepted` ledger event; red attempts, unknown
    attempts and double acceptance are refused).
  - `factory-claim --task --sha` — the Agent's single command; prints verdict,
    gate note and report path (exit 0 green / 1 red / 2 not processed). The
    PATH wrapper now bakes in `FACTORY_STATE_DIR`.
  - `scripts/smoke-loop.mjs --home <trial home>` — the mechanical DoD: contract
    → red claim → fixed green claim → accept against a live daemon, asserting
    the ledger sequence and per-attempt reports.
- ADR 0003 ledger shape, completed: every event carries `ts` (ISO 8601 UTC,
  stamped by the ledger); Tasks have numbered Attempts — each Claim opens the
  next one, a Claim while the previous Attempt is open is rejected, and each
  Attempt gets its own `report-<task>-<n>.md`. On open, an unterminated last
  ledger line is moved to `<ledger>.quarantine`, and an Attempt interrupted by
  a restart (e.g. mid-gate) is closed red and reported.
- Plugin shell (ticket 06): the Paseo plugin that loads on a 0.10 daemon
  (`paseo-plugin.json`, `requirements.paseo >=0.10.0 <0.11.0`). The server entry
  logs a startup banner, resolves the state root under the daemon home
  (`PASEO_HOME` → `plugin-state/paseo-factory/`), opens the ledger through the
  vendored core, and injects the `factory-claim` CLI onto every agent's PATH
  via the `agent.session_open` before-hook (ADR 0004: CLIs, not MCP tools; the
  hook fires on create/resume/refresh, which `agent.create` env alone does
  not). The CLI is a stub until the loop is wired. `plugin/server/core/` is a
  byte-exact vendored copy of `src/` (the daemon compiler rejects imports from
  outside the plugin directory), kept in sync by `npm run sync:plugin-core`
  and guarded by a test.
- README stating what the plugin is and its status (ADR 0001).
- Verification core v0.0.1 (ticket 07), pure Node with zero Paseo imports:
  - Contract registration (`contract_set`): gate command + required artifact path per task.
  - Append-only `ledger.jsonl` with monotonically increasing `seq`, fsync per line,
    corruption detection on open, and the five roadmap events (`contract_set`,
    `done_reported`, `gate_started`, `gate_finished`, `report_written`).
  - Gate runner: spawns the contract command in the task workspace, captures exit
    code and a capped stdout tail, kills the process group after a timeout, and
    requires the artifact to exist for a green verdict. A gate that cannot start
    (e.g. missing workspace) records a red `gate_finished` — the ledger always
    reaches its verdict event.
  - Report generation: `report-<task>.md` rendered from the ledger — contract,
    agent's claim @ SHA, gate verdict, conclusion — every line traceable to a
    ledger event.
- CI: typecheck + test on push and PR (ADR 0001, "CI from day one").
