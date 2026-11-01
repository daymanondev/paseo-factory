# 0039 — Unified Peer Helper MCP catalog, selective provider/vault sync, OAuth materialization, connectivity verification, and SLP Peer skill parity

- **Date:** 2026-11-01
- **Status:** Accepted — Owner confirmed all interview decisions on 2026-10-31 and refined selective sync & UI scoping on 2026-11-01.
- **Amends:** ADR 0016 (`Pi harness home` hardcoding only `zai-vision` + `context7` and restricting SLP `Peer` `settings.skills` to three skills), ADR 0031 (`resolveRoleScopedMcpServers` relying on per-provider `config.mcpServers`), and ADR 0036 (`Private vault` operational config & credential sync). Preserves ADR 0031's strict role isolation (`Supervisor` and `Lead` receive only `paseo_factory`).

## Context

In SLP mode, the Owner uses multiple model harnesses across seats (`antigravity` for `Supervisor`, `pi` for `Lead` and `Peer`, and occasionally `claude`, `codex`, or `opencode`). External Helper MCP servers (`supabase`, `context7`, `exa`, `zai-vision`, `chrome-devtools-mcp`, `framelink-figma`, `notion-mcp-server`, `sequential-thinking`, etc.) and their OAuth tokens live across each harness's private configuration:

1. **Fragmented Helper MCP configs vs. unwanted blanket sync:** Antigravity stores servers in `~/.gemini/config/mcp_config.json`, Pi in `~/.pi/agent/mcp.json`, and Claude in `~/.claude.json`. However, many MCPs installed in Antigravity or Claude are for the Owner's personal interactive use (e.g. personal `notion-mcp-server`, `magic`, `framelink-figma`) or only make sense on specific provider families (`zai-vision` on Pi/Claude). Automatically enabling and cross-writing all discovered MCPs across every provider and into `Private vault` pollutes `Peer` tool namespaces, risks exposing personal integrations, and mutates host files unexpectedly.
2. **Incompatible OAuth token stores:** When the Owner authenticates an HTTP MCP server such as `supabase` in Antigravity IDE, the OAuth token is saved in `~/.gemini/antigravity/mcp_oauth_tokens.json` (keyed by full `serverUrl`). Pi's `pi-mcp-adapter` expects tokens in `<PI_CODING_AGENT_DIR>/mcp-oauth/sha256-<sha256(serverName)>/tokens.json` (with `expiresAt` in Unix epoch seconds), and Claude/Codex/OpenCode expect an `Authorization: Bearer <accessToken>` header on `config.mcpServers`.
3. **Zero visibility into `Peer` MCP connectivity:** Neither the Owner nor `Lead` could tell which Helper MCPs `Peer` actually had synced or whether their OAuth tokens / API keys were valid, leading to blind Contract assumptions or silent 401 failures mid-task.
4. **SLP `Peer` skill restriction on Pi & minor role alignment gaps:** While `Peer` on Claude, Codex, and OpenCode saw all installed skills in `~/.agents/skills/` (except `factory`), `src/pi-home.ts` hardcoded SLP `Peer` `settings.skills` to only `tdd`, `diagnosing-bugs`, and `codebase-design`. Additionally, OpenCode's `Supervisor` skill allowlist in `plugin/server/roles.ts` omitted `"domain-modeling": "allow"`, and `src/mcp/shared.ts` omitted `supervisor_accept_task`, `lead_repoke_agent`, and `lead_needs_human` from `sharedRoles`.

## Decision

### 1. Read-Only Host Discovery, Package-Level Deduplication, and Selective Opt-In (`Synced to Peer` vs `Available on Host`)

- **Read-only host discovery (`src/helper-mcp-sync.ts`):**
  - Discover external MCP servers from `~/.gemini/config/mcp_config.json` (and `~/.gemini/antigravity/mcp_config.json`), `~/.pi/agent/mcp.json`, `~/.claude.json`, and `<stateDir>/helper-mcps.json`.
  - **Strict Read-Only Host Law:** Never write back to or mutate the Owner's host files (`~/.gemini/*`, `~/.claude.json`, `~/.pi/agent/mcp.json`, or `~/.pi/agent/mcp-oauth/*`). All Factory-managed MCP definitions, overrides, and materialized OAuth tokens live exclusively inside `<stateDir>/helper-mcps.json`, `<stateDir>/helper-mcp-oauth.json`, and `<stateDir>/pi-agent/agent/`.
- **Canonical deduplication & binary normalization:**
  - Collapse duplicate aliases that invoke the same underlying MCP package or endpoint (`chrome-devtools` ↔ `chrome-devtools-mcp` → `chrome-devtools-mcp`; `zai-mcp-server` ↔ `zai-vision` → `zai-vision`), normalize stale absolute nvm paths (`/Users/.../.nvm/versions/node/v*/bin/npx`) to the active host binary, and always exclude `paseo_factory`.
- **Selective Opt-In Default (`Synced to Peer` vs `Local on Host`):**
  - Servers discovered only from external non-Pi host files (`~/.gemini/config/mcp_config.json`, `~/.claude.json`) default to **`Local on Host (Not Synced)`** (`enabled: false`) unless the Owner explicitly clicks **`+ Sync to Peer`** (`overrides[name] = true`), whereas Pi's own configured starter servers (`~/.pi/agent/mcp.json`, `zai-vision`, `exa`, unless marked `"disabled": true`) remain enabled by default until unsynced.
- **Lazy lifecycle on Pi:** When writing `<stateDir>/pi-agent/agent/mcp.json`, set `"lifecycle": "lazy"` on all synced Helper MCP entries so `Peer` startup never spawns stdio `npx` child processes eagerly.

### 2. Per-Provider Target Scoping (`targetProviders`) and Per-Server `Private vault` Opt-In (`vaultSync`)

- Each server in `<stateDir>/helper-mcps.json` supports granular target scoping:
  - **`targetProviders: Array<"pi" | "claude" | "codex" | "opencode">`** (defaulting to `["pi", "claude", "codex", "opencode"]` when synced): Controls which `Peer` provider harnesses receive this MCP.
    - `<stateDir>/pi-agent/agent/mcp.json` includes only servers with `enabled === true` and `targetProviders.includes("pi")`.
    - `resolveRoleScopedMcpServers` on `agent.create` for `claude`, `codex`, or `opencode` injects only servers with `enabled === true` and `targetProviders.includes(providerFamily)`.
  - **`vaultSync: boolean`** (defaulting to `false` unless toggled on by the Owner): Controls whether `Private vault` (`src/helper-mcp-vault.ts`) packages and replicates this server's definition (`config/helper-mcps.json`) and credentials/OAuth bundle (`secrets/shared/mcp-oauth.json`, `0o600`) to remote machines (`andrews-mac-mini`).
- Preserve ADR 0031's role isolation: `Supervisor` and `Lead` are provisioned **only** with `paseo_factory`.
- Inject the **`Available Peer Helper MCPs`** section into `Lead`'s `Seat kickoff packet` (`src/preflight.ts`) and `buildRoleKickoffPrompt` (`src/roles-contract.ts`) listing only the servers actually synced to `Peer` (`enabled === true`).

### 3. Isolated OAuth Token Materialization & Auto-Refresh

- For HTTP Helper MCPs that are **`Synced to Peer` (`enabled === true`)**:
  - Read OAuth token candidates read-only from `~/.gemini/antigravity/mcp_oauth_tokens.json`, `~/.pi/agent/mcp-oauth/sha256-<sha256(name)>/tokens.json`, and `<stateDir>/helper-mcp-oauth.json`.
  - Select the token bundle with the latest expiry. If expired or within 5 minutes of expiry and carrying `refresh_token` + `token_url`, automatically refresh via `POST grant_type=refresh_token`.
  - Materialize the winning token **only** into Factory's isolated state (`<stateDir>/helper-mcp-oauth.json` and `<stateDir>/pi-agent/agent/mcp-oauth/sha256-<sha256(name)>/tokens.json` with `0o600` permissions) and `headers: { Authorization: "Bearer <accessToken>" }` on `config.mcpServers[name]` for enabled non-Pi `targetProviders`.

### 4. Separation of `Check Connectivity` vs `+ Sync to Peer` in `HelperMcpsCard` (`Plugins` Tab)

- Position `HelperMcpsCard` below `Companion Tools & Skill Packs` in `PluginsPane`.
- **Header & Collapsed View:**
  - Header action is **`Check Connectivity`** (probes health and refreshes OAuth tokens in `<stateDir>` for synced servers without auto-enabling local-only host servers), paired with **`⋯ Manage (N)`**.
  - When collapsed, display **only** the `Synced to Peer` servers as compact mono status chips (or a muted *"No MCPs synced to Peer — open Manage to select"* note) plus a subtle `M available on host` badge.
- **Collapsible `⋯ Manage` Drawer (`Synced to Peer` vs `Available on Host`):**
  - **`Synced to Peer (N)` view:** Shows each active `Peer` MCP with interactive target pills (**`[Pi]`**, **`[Claude]`**, **`[Codex]`**, **`[OpenCode]`**), a **`[Vault]`** opt-in toggle pill, health status badge, and an **`Unsync`** button.
  - **`Available on Host (M)` view:** Shows MCPs discovered in Antigravity/Claude/Pi that remain `Local Only (Not Synced)`, with their source harness badge and a **`+ Sync to Peer`** button.

### 5. SLP `Peer` Skill Parity on Pi & Role Tool/Skill Alignment

- Update `buildManagedSkillsSettings` in `src/pi-home.ts` so `role === "agent"` (`Peer`) in SLP mode receives `["!*", "+~/.agents/skills/*", "-~/.agents/skills/factory"]`.
- Add `"domain-modeling": "allow"` to OpenCode's `Supervisor` `permission.skill` map in `plugin/server/roles.ts`.
- Add `supervisor_accept_task: ["supervisor"]`, `lead_repoke_agent: ["lead"]`, and `lead_needs_human: ["lead"]` to `sharedRoles` in `src/mcp/shared.ts`.

## Consequences

- Host MCP configurations (`~/.gemini/*`, `~/.claude.json`, `~/.pi/agent/*`) are never modified by Factory.
- Only MCPs explicitly synced by the Owner (plus Pi's core starter set unless unsynced) are attached to `Peer`, scoped to the exact `targetProviders` (`Pi`, `Claude`, `Codex`, `OpenCode`) and `Vault` opt-in chosen by the Owner.
- The `Plugins` tab remains clean and uncluttered, showing only active `Peer` MCPs when collapsed and providing one-click `+ Sync to Peer` / `Unsync`, provider target chips, and `Vault` toggles inside `⋯ Manage`.
