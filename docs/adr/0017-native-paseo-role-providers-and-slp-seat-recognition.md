# ADR 0017 — Native Paseo Role Providers (`factory-supervisor`, `factory-lead`, `factory-peer`), Single `Supervisor (Factory)` Picker Profile, and Removal of `Start Supervisor` / `Start Lead` UI Buttons

- **Status:** Accepted — 2026-10-21; amended 2026-10-22 (ratified by Andrew over `/grill-with-docs` comparing `paseo-factory` against `paseo-room` and `seatworks`, and refining Paseo workspace co-location, role/worktree titles, orphan workspace sweeping, and offline spool deduplication)
- **Grounded in:** `cuongntr/paseo-room` (`src/paseo.ts`, `src/runtime-plugin/server/{recognition,hooks}.ts`) · `daymanondev/seatworks` (`plugin/server/catalog/providers.ts`, `plugin/roles.json`, `plugin/server/runtime/runtime.ts`) · Live Paseo Desktop trace (`~/.paseo/config.json`, `ai-test` run 2026-10-21)
- **Amends:** ADR 0010 §2–§4, ADR 0013 §3, ADR 0015 §1–§4, and ADR 0016 §3 (replaces title-based seat guessing and custom `Start Supervisor` / `Start Lead` UI buttons with native Paseo Role providers `factory-supervisor`, `factory-lead`, `factory-peer` reconciled from `Lane config` into `<paseoHome>/config.json`)

## Context

In `paseo-factory` through `v0.0.26`, seats were not registered as first-class Paseo providers/profiles in `<paseoHome>/config.json`. Instead:
1. Users had to open the custom Factory plugin tab and click `Start Supervisor` (or `Start Lead`), or type `/factory <directive>` in a generic chat session.
2. When a user opened a new Paseo chat and typed a prompt directly, `server.before("agent.create")` only recognized seats by `config.title` (`"Supervisor — ..."`, `"Lead — ..."`) or `labels.seat`. Any chat whose title was the user's natural first message ran as an unfenced generic agent and wrote product files (`package.json`) directly in `<project-root>`.
3. Exposing both `Start Supervisor` and `Start Lead` buttons in the Factory UI violated the core SLP workflow (`Supervisor` → `Lead` → `Peer`), where the Human talks **only** to `Supervisor` and `Supervisor` dispatches `Lead` automatically.
4. Meanwhile, both `paseo-room` (`src/runtime-plugin/server/recognition.ts`) and `seatworks` (`plugin/server/catalog/providers.ts`) register explicit role providers in `<paseoHome>/config.json` (`agents.providers` + `daemon.agentProfiles` with `paseoTools: { enabled: false }`), so `server.before("agent.create")` recognizes a seat deterministically by `config.provider` (`factory-supervisor`, `factory-lead`, `factory-peer`) regardless of chat title.

## Decision

1. **Reconcile Three SLP Role Providers (`factory-supervisor`, `factory-lead`, `factory-peer`) and One `Supervisor (Factory)` Profile into `<paseoHome>/config.json`.**
   - At plugin boot (`plugin/index.server.ts`) and whenever `Lane config` (`lanes.json`) is updated (`lanesSet`), `reconcileFactoryProviders` atomically updates `<paseoHome>/config.json`:
     - **`agents.providers`:**
       - `factory-supervisor`: `{ extends: <supervisorBaseProvider>, label: "Supervisor (Factory)", description: "...", paseoTools: { enabled: false }, env: { PASEO_FACTORY_SEAT: "supervisor" }, additionalModels: [...] }`
       - `factory-lead`: `{ extends: <leadBaseProvider>, label: "Lead (Factory)", description: "...", paseoTools: { enabled: false }, env: { PASEO_FACTORY_SEAT: "lead" }, additionalModels: [...] }`
       - `factory-peer`: `{ extends: <workerBaseProvider>, label: "Peer (Factory)", description: "...", paseoTools: { enabled: false }, env: { PASEO_FACTORY_SEAT: "agent" }, additionalModels: [...] }`
     - **`daemon.agentProfiles`:**
       - Removes any orphaned `agentProfiles` entries whose `provider` starts with `sw2-` or `factory-` and is not in `agents.providers`.
       - Registers **only** `factory-supervisor` (`{ id: "factory-supervisor", name: "Supervisor (Factory)", provider: "factory-supervisor", model: <supervisorModel>, ...(thinkingOptionId ? { thinkingOptionId } : {}) }`) so the Paseo New Chat picker displays a single clean SLP entry (`Supervisor (Factory)`).
     - Triggers `paseo daemon reload` asynchronously when `<paseoHome>/config.json` changes outside an active turn.

2. **Deterministic Seat Recognition by `config.provider` (`factory-supervisor`, `factory-lead`, `factory-peer`).**
   - `injectRoleOnCreate`, `injectSessionEnv`, `normalizeAgentCreateRequest`, and `resolveSeatAtProjectRoot` recognize `factory-supervisor` → `supervisor`, `factory-lead` → `lead`, and `factory-peer` / `factory-agent` → `agent` directly from `config.provider` (as well as `PASEO_FACTORY_SEAT` in `env`), resolving the underlying harness family (`opencode`, `claude`, `codex`, `pi`, `copilot`, `omp`, `antigravity`) from `Lane config` so `applyProviderExecutionFence` applies the exact harness-specific Layer-1 fence and `paseo_factory` MCP server (`ELECTRON_RUN_AS_NODE: "1"`).
   - When a user starts `Supervisor (Factory)` from Paseo's native New Chat picker in a Git repository and `server.before("agent.session_open")` fires, `paseo-factory` automatically records `supervisor: request.agentId` and `workspaceId: request.workspaceId` in `<stateDir>/projects/<slug>/project.json` so subsequent `Lead` creation and `Lead` reports (`to: "supervisor"`) route back into that exact session and Workspace.

3. **Shared Main Workspace Co-location and Scannable Role / Worktree Titles.**
   - **Main Workspace Co-location (`Supervisor` + `Lead`):** When `ensureSeat("lead")` creates or ensures `Lead`, it resolves the active `Supervisor`'s `workspaceId` (from the live `Supervisor` agent snapshot or `<projectStateDir>/project.json` `workspaceId`) before falling back to `daemon.workspaces.open({ cwd: project.root })`. As a result, `Supervisor` and `Lead` live side by side as two tabs inside the Project's single active main Workspace rather than splitting across stale historical `local_checkout` Workspaces.
   - **Agent Tab Titles:** `server.before("agent.create")` (`injectRoleOnCreate`) and `ensureSeat` stamp concise, role-explicit tab titles: **`Supervisor`** for the Supervisor seat, **`Lead`** for the Lead seat, and **`Peer · <Task>`** (e.g. `Peer · T-08`) for working Agents, while preserving Paseo's natural mission title on the outer main Workspace row in the sidebar.
   - **Peer Worktree Workspace Titles:** When `resolveSpawnWorkspaceAndParent` registers a Task worktree Workspace in Paseo, it names the Workspace **`Peer · <Task> — <short summary>`** (derived from the first clause of `contract.description`, omitting the internal `<project-slug>` hash; or **`Peer · <Task>`** when no description is set).

4. **Remove `Start Supervisor` and `Start Lead` Buttons from the `Factory surface`.**
   - Neither the persistent Header ([`plugin/client/factory/header.tsx`](../../plugin/client/factory/header.tsx)) nor the `Seats & Models` view ([`plugin/client/factory/seats.tsx`](../../plugin/client/factory/seats.tsx)) renders `Start Supervisor` or `Start Lead` buttons.
   - Users start `Supervisor (Factory)` directly from Paseo's native agent picker; `Supervisor` spawns `Lead` (`factory-lead`) via `supervisor_dispatch_lead`; and `Lead` spawns `Peer` (`factory-peer`) via `lead_spawn_agent`. When `Supervisor` or `Lead` is already active on a Project, the UI shows its live status and an `Open` link to jump to its conversation, plus `Rotate` / `Revoke`.

5. **Daemon Workspace and Project Record Cleanup on `Project reset`, `Task worktree` Archival, and New `Supervisor` Creation.**
   - The plugin captures the daemon's `PaseoApi` from the first hook or surface RPC that carries one (and immediately pumps all registered `Lead` and `Supervisor` mailboxes via `leadMail.pumpAll()` once captured), so cleanup and startup mail delivery never stall behind hook ordering.
   - `archiveAcceptedTaskWorkspace` (the accept path, surface and spool alike), `projectReset`, and new `Supervisor` seat registration sweep the daemon's own records over the session WebSocket (`archive_workspace_request` / `project.remove.request` via `cleanupDaemonWorkspacesAndProjectsViaWs`) for:
     - any workspace or project rooted under `<projectStateDir>/worktrees/` or missing on disk, and
     - any orphaned `local_checkout` workspace at `<project-root>` (excluding the active `Supervisor`/`Lead` workspace) that has zero active (non-archived) agents.

6. **Offline Spool Deduplication and Non-Retry Turn Guidance (`spool-timeout`).**
   - The MCP bridge (`bridge.mjs`) and CLI (`spool-client.mjs`) **never** auto-reload or restart daemon plugins behind the user's back.
   - When submitting a request to `<stateDir>/spool/requests/` and when draining requests on plugin boot (`startSpool`), duplicate pending requests carrying the same semantic payload (`(kind, task, sha)` for `claim`, `(kind, project/workspace, from, message)` for mailbox dispatches/reports) are deduplicated so at most one request file remains queued.
   - If a request hits `spool-timeout` because the `paseo-factory` plugin process is stopped (e.g., after macOS sleep), the single deduplicated request file remains durably queued in `spool/requests/` (so reloading the plugin resumes the pipeline automatically) and the caller receives an explicit instruction to **stop retrying and end its turn immediately**.

## Consequences

- **Positive:** Starting a `Supervisor` uses Paseo's native New Chat picker (`Supervisor (Factory)`) with zero custom bootstrap buttons; `server.before("agent.create")` recognizes the role 100% deterministically by `config.provider`; `paseoTools: { enabled: false }` blocks native Paseo agent tools at the daemon config layer; and the UI no longer exposes a confusing `Start Lead` or redundant `Start Supervisor` button.
- **Negative:** Updating `Lane config` (`lanes.json`) also reconciles `<paseoHome>/config.json` so `factory-supervisor` / `factory-lead` / `factory-peer` stay in sync with the selected harness and model.
