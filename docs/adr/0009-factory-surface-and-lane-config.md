# ADR 0009 — The Factory surface in Paseo and unified Lane config

- **Status:** Accepted — 2026-10-15 (ratified by Andrew over a two-round `/grill-with-docs`, all-recommended; words "toàn bộ theo khuyến nghị của bạn")
- **Grounded in:** `Patruxs/PigMonitor` (`v0.2.1`, `@getpaseo/plugin@0.11.2`, `index.client.tsx`, `client/monitor/{surface,header,overview,graph,dialog}.tsx`, `client/chat/step-in.tsx`, `scripts/check-bundle.mjs`) · `sting8k/piggery` (`v0.10.2`, `ps --view`) · `research/piggery-vs-factory-v0.0.11-argon-review.md` · `research/piggery-pigmonitor-second-opinion.md` · `src/{watch,retro,fresh-eyes,factory}.ts`
- **Amends:** ADR 0004 (client RPC handlers inside `plugin/index.server.ts` invoke the plugin's own `factory` instance directly as the single writer) · ADR 0006 §2 & §5 (v0.0.13 adds the Factory surface and one-click Supervisor bridge; roadmap law #4 "no UI yet" retires after twelve core versions)

## Decision

1. **The Factory surface (`plugin/index.client.tsx`, Paseo `>=0.11.0`).** `paseo-factory` ships a client bundle alongside `plugin/index.server.ts`, registering three Paseo client contributions that share a single `<FactoryShell />`:
   - **Global screen + Sidebar header item** (`client.addScreen` + `client.addSidebarHeaderItem`): full-screen view across all workspaces.
   - **Workspace panel** (`client.addWorkspacePanel`, `locations: ["explorer", "workspace"]`): scoped automatically to the active workspace's directory (`useWorkspace`).
   - **Settings screen** (`client.addSettingsScreen`): quick access to the Lane config, Supervisor seat controls, and daemon/state diagnostics.

2. **Role of the surface: Verification & Seat Control Plane + 1-Click Supervisor Bridge (never a duplicate chat pane or manual 6-field Contract form).**
   - In keeping with ADR 0006 ("the only seat the Owner converses with is the Supervisor; reduce owner burden by mechanizing under the seats"), the surface does **not** re-implement Paseo's native agent chat transcript/composer and does **not** force the Owner back into multi-field Contract forms.
   - Instead, the persistent **Header** provides:
     - Plain-language status headline, live freshness indicator, and five tabular-num **KPI Stat Tiles** (`Needs Human`, `Running`, `Ready to Accept`, `Accepted`, `Total Cost`).
     - **One-click Supervisor bridge (`Open Supervisor` + `Quick Dispatch` input):** Calls a plugin RPC (`factory.supervisor.ensure`) that checks for an active, non-archived agent labeled `seat=supervisor` on the current daemon; if absent, creates `<home>-supervisor/AGENTS.md` (with the daemon's resolved home and node paths) and spawns `"Supervisor (paseo-factory)"` under the configured `supervisor` lane; if a quick-dispatch message was entered, sends it to the Supervisor; then navigates Paseo Desktop directly to that agent conversation (`navigation.openAgent`).
   - Three views organize the verification line:
     - **Tab 1 — `Tasks` (Verification Line):** Workspace-grouped task cards with status filter chips (`All`, `Running`, `Needs Human`, `Ready to Accept`, `Accepted`), each showing the **Attempt Ladder (`#1 → #2 → #3`)** with `↻ Respawned` badges, **Evidence Pills** (`Gate`, `Choke allow/deny/block`, `Eye CLEAR/CONCERN`, `Watch max probability`, `Cost`), a direct **`Accept #n`** button for green Attempts (`submitter: "owner"`), and a **Detail Modal** (full Contract, per-attempt `Report.md`, `Gate Log`, and 5-question Watch / Fresh-eyes breakdown).
     - **Tab 2 — `Seats & Models` (Lane Switcher & Topology Graph):** Top row of four **Lane Cards** (`Supervisor`, `Default Worker`, `Watch & Retro`, `Fresh-eyes`) opening a live provider/model selector dialog; bottom **Seat Graph** (card-and-rail orthogonal tree) showing `Owner ⇄ Supervisor ⇄ Lead (Rider) ⇄ Working Agents` with live Timeline Oracle `seqEnd`, status, and one-click `Open Session` / `Revoke Supervisor`.
     - **Tab 3 — `Timeline & Retro`:** Horizontal **Swimlane Timeline** (`30m | 2h | 6h | 24h`) of Task Attempts and Agents above a **Retro & Ledger** section with a **`Run Retro`** action button, rendered Proposals (`R1..Rn`), and live Ledger event stream.

3. **Unified `Lane config` (`<stateDir>/lanes.json`) and tool-less CLI execution for `Watch`, `Retro`, and `Fresh-eyes`.**
   - The plugin owns `<stateDir>/lanes.json` (with safe defaults when absent: `supervisor: "pi/zai/glm-5.3"`, `worker: "pi/zai/glm-5.3"`, `watch: "pi/zai/glm-5.3"`, `retro: "pi/zai/glm-5.3"`, `freshEyes: "pi/zai/glm-5.3"`).
   - **Precedence:** Explicit CLI `--provider <p/m>` on `factory run` overrides `lanes.json`; when `--provider` is omitted, `factory run` reads `lanes.worker`.
   - **Live Supervisor model sync:** Updating `lanes.supervisor` from the UI updates `<stateDir>/lanes.json` and, if a live Supervisor agent exists on the daemon, updates its model via the daemon API.
   - **Unlocking `Watch`, `Retro`, and `Fresh-eyes` from hardcoded `copilot/gpt-5.4` and `eye.json`:**
     - `Watch` (`src/watch.ts`) and `Retro` (`src/retro.ts`) read their configured `provider/model` from `lanes.json` and dispatch through a unified **headless tool-less prompt runner**:
       - `pi/<model>` → `pi --print --no-session --no-tools --no-extensions --no-skills --no-context-files --model <model>`
       - `copilot/<model>` → `copilot -s --model <model> --reasoning-effort medium`
       - `claude/<model>` → `claude -p --model <model> --tools ""`
     - `Fresh-eyes` (`src/fresh-eyes.ts`) supports both `"eye.json"` (direct HTTP API when `<stateDir>/eye.json` is selected or present as override) and any headless tool-less CLI lane (`pi/...`, `copilot/...`, `claude/...`) configured in `lanes.freshEyes`, preserving the "cannot act by construction (zero tools)" invariant on subscription/$0 lanes.

4. **Single-Writer Law preserved over Plugin RPC (ADR 0004).**
   - Because `server.handle(...)` RPC handlers run inside the `plugin/index.server.ts` process that owns the single `Factory` instance, Owner acts triggered from the UI (`Accept`, `Retro`, `Lane config` save) invoke `factory.accept({ task, attempt, submitter: "owner" })` and `factory.retro()` directly in-process rather than round-tripping through the external CLI file spool.

5. **Hermes bundle boundary verification and dual-home posture.**
   - Client/server/shared module boundaries and Hermes CJS bundling (`esbuild`, no `node:*` in client/shared, no `class` syntax in client bundle) are enforced by `scripts/check-bundle.mjs` in `npm test` / `npm run typecheck`.
   - Automated adversarial batteries and smoke scripts continue to target `~/.paseo-factory` exclusively (refusing `~/.paseo`), while the verified plugin is installed into both `~/.paseo-factory` and `~/.paseo` so Paseo Desktop renders the Factory surface out of the box.

## Consequences

- `CONTEXT.md` gains **Factory surface** and **Lane config**, and updates **Fresh-eyes review**, **Watch**, **Retro**, and **Driver**.
- `Watch`, `Retro`, and `Fresh-eyes` work out-of-the-box on `pi/zai/glm-5.3` ($0 marginal cost) without requiring an active Copilot quota or paid HTTP API key.
- `factory run <task>` no longer requires `--provider` when `<stateDir>/lanes.json` (or its default) is present.
