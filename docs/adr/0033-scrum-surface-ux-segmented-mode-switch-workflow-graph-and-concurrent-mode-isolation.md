# 0033 — Scrum Surface UX, Optimistic Segmented Mode Switch, Workflow Graph, and Concurrent Multi-Project Isolation

- **Date:** 2026-10-28
- **Status:** Accepted
- **Amends:** ADR 0025, ADR 0026, ADR 0032
- **Preserves:** ADR 0001–0032

## Context

Following the release of isolated `Agile Scrum` execution mode (`ADR 0032`, `v0.0.52`–`v0.0.53`), live inspection of the `Factory surface` and multi-project daemon runtime exposed two classes of problems:

### A. Surface UX & Interaction Friction (`plugin/client/factory/*`, `plugin/server/surface-rpc.ts`)

1. **Inverted Active-State Affordance (`Chip` disabled dimming):**
   - The mode selector rendered two `<Chip>` buttons (`SLP` and `Agile Scrum`) with `disabled={selectedMode === mode}` and `accent={selectedMode === mode}`. Because `<Chip>` applies `opacity: 0.45` whenever `disabled` is true, the **currently active** execution mode appeared faded and inactive while the **inactive** mode appeared bright and clickable — inverting standard visual hierarchy and confusing the Owner about which mode was actually active.
2. **Duplicate Mode Switchers on `Seats & Models`:**
   - The `Execution` selector appeared once in the global `Header` (`header.tsx`) and a second time inside the `Seats & Models` pane (`seats.tsx` and `scrum.tsx`), creating visual clutter and redundant controls on the same screen.
3. **2–5s Mode-Switch Freeze & Unnecessary Idle Agent Spawns (`executionSetMode`):**
   - Clicking the mode switch waited synchronously for `factory.execution.setMode`, which unconditionally called `ensureSeat(slug, "supervisor")` and `ensureSeat(slug, "lead")` inside the RPC handler before returning, and then waited for a full `factory.snapshot` round-trip. Even on a completely idle Project, toggling between `SLP` and `Agile Scrum` spawned two live Paseo agent sessions per click, freezing the UI for 2–5 seconds and consuming daemon memory/CPU.
4. **Missing Visual Topology in `Agile Scrum` (`ScrumSeatsPane`):**
   - While `SLP` `Seats & Models` provides a live **Seat Graph** (`Owner ⇄ Supervisor ⇄ Lead ⇄ Peer`) and rich lane/profile cards, `ScrumSeatsPane` lacked any visual topology or workflow pipeline diagram and used a bare stripped-down layout (`SettingsSelect` dropdowns without role icons, tier pills, save-profile modal, or two-step confirmation).
5. **Ineffective `All projects` (`project === null`) Mixed-Mode View:**
   - When multiple Projects existed across `SLP` and `Agile Scrum`, `All projects` showed a mode toggle that only changed `newProjectDefaultMode` (`<stateDir>/execution.json`) while making it appear as if all Projects were switching mode, failed to badge which Project used `SLP` vs `Agile Scrum`, and hid the other mode's machine-default roster unless `newProjectDefaultMode` itself was mutated.

### B. Multi-Project Concurrent `SLP` + `Agile Scrum` Runtime Isolation (`choke.ts`, `roles.ts`, `bridge.mjs`, `driver.mjs`, `lead-mailbox.ts`)

When Project A runs `SLP` (`lanes.json`) and Project B runs `Agile Scrum` (`scrum-lanes.json`) concurrently on the same Paseo daemon:

1. **Seat Creation Provider & Thinking Normalization Conflict:**
   - On `server.before("agent.create")`, `normalizeAgentCreateRequest` (`choke.ts`) resolved `factory-supervisor` / `factory-lead` / `factory-peer` exclusively against SLP's `loadLanes(stateDir, project.slug)`. Subsequently, `injectRoleOnCreate` (`roles.ts`) overwrote `config.provider` via `scrumProviderConfig`, which bypassed provider alias normalization (`claude-code` → `claude`, `agy` → `antigravity`), skipped catalog-backed `providerSupportsThinking` validation (risking daemon rejection when a Scrum lane carried an unsupported `thinkingOptionId`), and left `thinkingOptionId: undefined` as an explicit key on `config.provider`.
2. **Permission Choke Provider-Family Misclassification:**
   - `resolveEffectiveProviderFamily` (`roles.ts`), invoked by `onPermissionAsked` (`choke.ts`) to determine whether an `opencode` session delegates Layer-2 bash asks to Layer-3 shims, only inspected SLP's `loadLanes(stateDir, projectSlug)` instead of the Scrum seat/task lane when the Project or Task ran in `scrum` mode.
3. **MCP Bridge & Driver Respawn SLP Worker-Lane Fallback:**
   - In `bridge.mjs`, `lead_spawn_agent` resolved `defaultWorkerLane` from SLP's `lanes.json` and reported `Driver launched in background ... under ${provider}` using the SLP worker lane rather than the Scrum specialist lane recorded on `spawn_dispatched`. In `driver.mjs`, `handleSubstrateDeath` submitted `respawn` with the CLI's default `provider` rather than `entry.provider ?? provider`.
4. **Global 1-Second `scrumRecoveryTimer` Lock Churn:**
   - `scrumRecoveryTimer` (`plugin/index.server.ts`) called `leadMail.pumpAll({ reconcileScrumOnly: true })` every `1000ms`. Inside `pumpProject`, every registered Project — including active `SLP` Projects and idle `Scrum` Projects — entered `projectLane(slug)` → `withExecutionLane` → `factory.history.runOperation(...)` once per second, contending with active mailbox deliveries and incrementing global `LedgerAdmission` counters unnecessarily.

---

## Decision

### 1. Single Segmented Mode Control (`SegmentedControl`) in the Project Header

- Introduce a reusable `<SegmentedControl>` primitive in `plugin/client/kit/pill.tsx` built on React Native's `View`, `Pressable`, and `Icon` (preserving Paseo's zero-external-UI-dependency and Hermes no-class bundle constraints):
  - Renders a recessed container track (`backgroundColor: c.surfaceRecessed`, `borderColor: c.border`, `borderRadius: radius.md`, `padding: 2`).
  - The **active segment** renders at full opacity (`opacity: 1`) with an elevated/accent surface fill (`c.accentSoft` or `c.surfaceElevated`), a `1.5px` `c.accent` border, an active check/mode icon, `fontWeight: "700"`, and `c.accent` text.
  - The **inactive segment** renders with transparent background, `c.textMuted` label, and subtle hover/press feedback (`opacity: 0.85`).
  - Never uses `disabled={selectedMode === mode}` to dim the selected option; clicking the already-selected segment is a no-op without visual dimming. When the entire control is locked (`busyReason` is non-null while a wave or Scrum run is active), a lock badge/tooltip explains the exact blocking work.
- Place the Project execution mode `<SegmentedControl>` **exclusively in the selected Project's row inside `Header` (`header.tsx`)**, and remove the duplicate `ExecutionSelector` from `SeatsPane` (`seats.tsx`) and `ScrumSeatsPane` (`scrum.tsx`).

### 2. Optimistic Mode Switching & Lazy Seat Retirement on `execution.setMode`

- **Dual-Mode View Snapshot Readiness:**
  - `foldView` / `surface-rpc.ts` always populates `view.execution.config`, `view.execution.profiles`, and `view.execution.activeProfileId` when `scrum-lanes.json` (or machine Scrum defaults) exists, alongside `view.lanes` and `view.profiles`, regardless of whether `selectedMode` is currently `"slp"` or `"scrum"`.
  - When the Owner clicks `SLP` or `Agile Scrum` in `Header`, the client updates the displayed mode **optimistically in `0ms`** (`optimisticMode` state), immediately rendering the target mode's `Seats & Models` roster and graph while `factory.execution.setMode` completes in the background (rolling back with a toast only if the server refuses with `execution-mode-busy`).
- **Lazy Standing-Seat Lifecycle on Mode Switch:**
  - `executionSetMode` (`plugin/server/surface-rpc.ts`) validates that the Project is not busy (`execution-mode-busy`), seeds `scrum-lanes.json` on first switch to `"scrum"`, writes the durable switch intent (`beginExecutionModeSwitch` → `completeExecutionModeSwitch`), and **retires/archives any currently live `Supervisor` or `Lead` sessions** (`revokeSeat("supervisor")`, `revokeSeat("lead")`) so no stale-prompt seat survives the switch.
  - `executionSetMode` **never calls `ensureSeat("supervisor")` or `ensureSeat("lead")` synchronously during the mode switch**. Standing seats remain lazy: they are auto-created on demand when a directive is dispatched (`supervisor dispatch`, `lead dispatch`, `/factory`) or when opened from Paseo's New Chat (`Supervisor (Factory)`).
  - If the Project currently has a live `Supervisor` or `Lead` session when the Owner clicks the mode switch in the UI, the surface prompts a lightweight confirmation modal (*"Switching execution mode will archive the live Supervisor/Lead session so the next turn boots with the new mode's instructions"*), matching the existing lane-change confirmation pattern.

### 3. Two-Tier Scrum Seat & Workflow Graph and `ScrumSeatsPane` UX Parity

- **`ScrumSeatAndWorkflowGraph` in `ScrumSeatsPane` (`plugin/client/factory/scrum.tsx`):**
  - **Tier 1 — Standing Authority Hierarchy (`Owner ⇄ Supervisor ⇄ Scrum Lead / PO`):**
    - Displays the live `Supervisor` and `Scrum Lead` seat cards with status badges (`running`, `idle`, `not started`), model badges, `128k` context progress bar on `Scrum Lead`, and direct `Open`, `Revoke Supervisor`, and `Rotate Lead` actions.
  - **Tier 2 — Specialist Execution Pipeline (`BMAD Agile Scrum Flow`):**
    - Renders a 5-stage visual pipeline connected by directional connectors:
      1. **`1. Planning · PM / Analyst`** (`prd.md`, `sprint-backlog.md`)
      2. **`2. Design & Arch · UX Designer ∥ System Architect`** (`DESIGN.md`, `EXPERIENCE.md`, `mockups/index.html`, `architecture.md`)
      3. **`3. Readiness & UI Gate`** (Lead cross-artifact check + Owner UI Mockup Preview & Approval when `requireUiApproval` is active)
      4. **`4. Implementation · Senior Dev`** (Vertical story tasks `S-01…` in isolated `Task worktree`s with TDD Gates)
      5. **`5. QA Audit & Fix Loop · QA / Test Architect ⇄ Senior Dev`** (4-lens candidate regression bundle, `qa-report.json`, bounded fix rounds `used/max`, 2× reproducibility check)
    - When an active Scrum run exists (`execution.activeRun`), the pipeline highlights the current `phase` node with a live accent ring, badges completed/skipped stages, lists bound specialist Tasks with 1-click `Open` jump links to their live agent sessions, and embeds the interactive **UI Mockup Preview & Approval (`Approve` / `Request Changes` / `Waive`)** bar directly when `phase === "awaiting-ui-approval"`.
- **Role Cards & `ScrumProfilesBar` Parity:**
  - Upgrade all 8 Scrum role cards (`Supervisor`, `Scrum Lead / PO`, `PM / Analyst`, `UX Designer`, `System Architect`, `Senior Dev`, `QA / Test Architect`, `Watch & Retro`) to match `SeatsPane`'s card aesthetic: role icon badge, tier pill (`Authority Seat`, `Planning Specialist`, `Implementation Specialist`, `Verification Specialist`, `Headless Pass`), model capability hint, and recessed `Provider` / `Model` / `Thinking` selector box.
  - Upgrade `ScrumProfilesBar` to match `ProfilesBar` in `seats.tsx`: 1-click `<Chip>` profile apply with active indicator, `Save Profile…` modal (save new or update active), two-step 5-second armed `Delete`, and two-step `Reset to Machine Default`.
  - Render `requireUiApproval` as a dedicated policy card with `<SettingsSwitch>` and clear explanation of when the Owner UI approval checkpoint pauses the pipeline.

### 4. Multi-Mode `All projects` (`project === null`) Clarity

- **Per-Project Execution Mode Metadata (`ProjectView` in `plugin/shared/view.ts`):**
  - Extend `ProjectView` with optional `executionMode?: "slp" | "scrum"` and `activeScrumPhase?: ScrumPhase | null`.
  - Project chips in `Header` (`header.tsx`) display a compact mode badge (`SLP` or `Scrum`, plus active phase when a Scrum run is in progress) so the Owner can see every Project's mode at a glance.
- **`Tasks` Board in `All projects` (`tasks.tsx`):**
  - Each task card in `All projects` badges both the Project name and its execution specialization (`SLP · Peer` vs `Scrum · PM / UX / Arch / Dev / QA`).
  - Provide a lightweight mode filter bar (`All` | `SLP` | `Agile Scrum`) when viewing `All projects`.
- **`Seats & Models` in `All projects` (`seats.tsx` / `scrum.tsx`):**
  - Clearly separate **(A) New-Project Default Mode** (`<stateDir>/execution.json`, labeled *"Default mode for newly registered Projects"*) from **(B) Machine Default Roster Editor** (a sub-tab toggle `Machine SLP Lanes (6)` | `Machine Agile Scrum Roster (8)`), so the Owner can inspect and edit either mode's machine-default roster and profiles without mutating existing Projects or changing the new-project default mode unless desired.

### 5. Concurrent `SLP` + `Agile Scrum` Server & MCP Isolation Fixes

1. **Unified Seat Creation Provider & Thinking Normalization (`plugin/server/choke.ts`, `plugin/server/roles.ts`):**
   - Extract a shared mode-aware seat lane resolver used by both `normalizeAgentCreateRequest` (`choke.ts`) and `injectRoleOnCreate` (`roles.ts`).
   - When a Project's selected mode is `"scrum"` (or when a Task has `contract.execution.mode === "scrum"`), resolve the target lane from the Scrum run's frozen roster or `<projectStateDir>/scrum-lanes.json` (for `supervisor`, `lead`, or specialist `agent`), normalize provider aliases (`normalizeProviderId`: `claude-code` → `claude`, `agy` → `antigravity`), validate `thinkingOptionId` against `providerSupportsThinking` in the discovered provider catalog, and omit `thinkingOptionId` cleanly when undefined or unsupported.
2. **Mode-Aware `resolveEffectiveProviderFamily` (`plugin/server/roles.ts`):**
   - Update `resolveEffectiveProviderFamily(stateDir, seat, projectSlug, taskId)` so that when `taskId` has a Scrum contract binding or `projectSlug` is in `"scrum"` mode, it resolves the provider family from the Scrum task/seat lane (`scrum-lanes.json` / frozen run config) before falling back to SLP's `lanes.json`.
3. **Accurate Scrum Spawn & Respawn Lane Plumbing (`plugin/bin/bridge.mjs`, `plugin/bin/driver.mjs`):**
   - In `bridge.mjs` (`lead_spawn_agent`), report the actual dispatched lane from the recorded `spawn_dispatched` ledger event (`dispatchedEvent?.provider ?? provider`) rather than the SLP `defaultWorkerLane` fallback.
   - In `driver.mjs` (`handleSubstrateDeath`), pass `provider: entry.provider ?? provider` on `respawn` spool requests so Scrum specialist tasks preserve their bound role lane across automatic respawns.
4. **Zero-Lock Pre-Check on `scrumRecoveryTimer` (`plugin/server/lead-mailbox.ts`):**
   - In `pumpProject(slug, { reconcileScrumOnly: true })`, perform a fast synchronous check before acquiring `projectLane(slug)` or entering `factory.history.runOperation`: if `loadExecutionMode(stateDir, slug).selectedMode !== "scrum"` or the Project's active Scrum run has neither `cancellation` nor `completionRequest` pending, return immediately (`0ms`). Active `SLP` Projects and steady-state `Scrum` Projects incur zero lock or ledger-admission overhead from the 1-second recovery timer.

## Consequences

- Switching between `SLP` and `Agile Scrum` is visually unambiguous (`SegmentedControl` with high-contrast active state), single-sourced in the Project Header, and responds in `0ms` without spawning idle agent processes.
- `Agile Scrum` gains full visual and functional parity with `SLP` on `Seats & Models`, including a 2-tier **Scrum Seat & Workflow Graph** and rich role/profile cards.
- `All projects` (`project === null`) clearly distinguishes per-Project execution modes, task specializations, and machine-default rosters.
- Projects running `SLP` and `Agile Scrum` concurrently on the same Paseo daemon no longer cross-contaminate provider normalization, `thinkingOptionId` filtering, Layer-2 permission-family checks, MCP spawn messages, or per-second ledger-admission locks.
