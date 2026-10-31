# 0039 — Unified Peer Helper MCP catalog, OAuth sync, connectivity verification, and SLP Peer skill parity

- **Date:** 2026-10-31
- **Status:** Accepted — Owner confirmed all interview decisions on 2026-10-31.
- **Amends:** ADR 0016 (`Pi harness home` hardcoding only `zai-vision` + `context7` and restricting SLP `Peer` `settings.skills` to three skills), ADR 0031 (`resolveRoleScopedMcpServers` relying on per-provider `config.mcpServers`), and ADR 0036 (`Private vault` operational config & credential sync). Preserves ADR 0031's strict role isolation (`Supervisor` and `Lead` receive only `paseo_factory`).

## Context

In SLP mode, the Owner uses multiple model harnesses across seats (`antigravity` for `Supervisor`, `pi` for `Lead` and `Peer`, and occasionally `claude`, `codex`, or `opencode`). However, external Helper MCP servers (`supabase`, `context7`, `exa`, `zai-vision`, `chrome-devtools-mcp`, `framelink-figma`, `notion-mcp-server`, `sequential-thinking`, etc.) and their OAuth tokens are fragmented across each harness's private configuration:

1. **Fragmented Helper MCP configs:** Antigravity stores servers in `~/.gemini/config/mcp_config.json`, Pi in `~/.pi/agent/mcp.json`, and Claude in `~/.claude.json`. Moreover, `syncManagedPiHome` in `src/pi-home.ts` only copied `zai-vision` and `context7` into `<stateDir>/pi-agent/agent/mcp.json`, dropping `supabase`, `exa`, `chrome-devtools-mcp`, `framelink-figma`, and `notion-mcp-server` whenever `Peer` ran on `pi`.
2. **Incompatible OAuth token stores:** When the Owner authenticates an HTTP MCP server such as `supabase` in Antigravity IDE, the OAuth token is saved in `~/.gemini/antigravity/mcp_oauth_tokens.json` (keyed by full `serverUrl`). Pi's `pi-mcp-adapter`, however, expects tokens in `<PI_CODING_AGENT_DIR>/mcp-oauth/sha256-<sha256(serverName)>/tokens.json` (with `expiresAt` in Unix epoch seconds), and Claude/Codex/OpenCode expect an `Authorization: Bearer <accessToken>` header on `config.mcpServers`. Neither local runs on another harness nor remote runs on a secondary machine (`andrews-mac-mini`) could reuse the Owner's authenticated session.
3. **Zero visibility into `Peer` MCP connectivity:** Neither the Owner nor `Lead` could tell which Helper MCPs `Peer` actually had configured or whether their OAuth tokens / API keys were valid, leading to blind Contract assumptions or silent 401 failures mid-task.
4. **SLP `Peer` skill restriction on Pi & minor role alignment gaps:** While `Peer` on Claude, Codex, and OpenCode saw all installed skills in `~/.agents/skills/` (except `factory`), `src/pi-home.ts` hardcoded SLP `Peer` `settings.skills` to only `tdd`, `diagnosing-bugs`, and `codebase-design`, hiding `frontend-design`, `web-design-guidelines`, `domain-modeling`, `research`, and `impeccable`. Additionally, OpenCode's `Supervisor` skill allowlist in `plugin/server/roles.ts` omitted `"domain-modeling": "allow"`, and `src/mcp/shared.ts` omitted `supervisor_accept_task`, `lead_repoke_agent`, and `lead_needs_human` from `sharedRoles`.

## Decision

### 1. Unified Discovery, Package-Level Deduplication, and Lazy Pi Provisioning (`Helper MCP catalog`)

- Introduce a single discovery and normalization layer (`src/helper-mcp-sync.ts`) that reads and merges external MCP servers from:
  - `~/.gemini/config/mcp_config.json` (and `~/.gemini/antigravity/mcp_config.json`)
  - `~/.pi/agent/mcp.json`
  - `~/.claude.json`
  - `<stateDir>/helper-mcps.json` (persisted Factory state and Owner enable/disable overrides)
- **Canonical deduplication:** Collapse duplicate aliases that invoke the same underlying MCP package or endpoint into a single canonical server entry:
  - `chrome-devtools` / `chrome-devtools-mcp` (`chrome-devtools-mcp`) → `chrome-devtools-mcp`
  - `zai-mcp-server` / `zai-vision` (`@z_ai/mcp-server`) → `zai-vision`
  - When the same canonical server appears in multiple files (e.g., `exa`), prefer the entry carrying explicit credentials (`EXA_API_KEY` or valid OAuth token) while preserving `"disabled": true` flags from the source config unless explicitly overridden by the Owner in `<stateDir>/helper-mcps.json`.
  - Always exclude `paseo_factory` from the external Helper MCP catalog.
- **Lazy lifecycle on Pi:** When writing `<stateDir>/pi-agent/agent/mcp.json`, set `"lifecycle": "lazy"` on all external Helper MCP entries (while keeping `paseo_factory` as `"exposure": "direct"`, `"timeout": 600`) so `Peer` startup never spawns 8–10 stdio `npx` child processes eagerly; only the MCP server actually called by `Peer` is started on demand.

### 2. Strict `Peer`-Only Attachment with `Lead` Kickoff Roster Visibility

- Preserve ADR 0031's role isolation: `Supervisor` and `Lead` are provisioned **only** with `paseo_factory` (`resolveRoleScopedMcpServers` and `syncManagedPiHome`), never with external Helper MCPs.
- Provision all enabled servers from the `Helper MCP catalog` **exclusively to working `Agent` (`Peer`) sessions** across every harness:
  - On Pi: written into `<stateDir>/pi-agent/agent/mcp.json` (and `~/.pi/agent/mcp.json` so standalone Pi sessions stay in sync).
  - On Claude, Codex, and OpenCode: injected into `config.mcpServers` during `server.before("agent.create")` when `role === "agent"`.
- Inject a deterministic **`Available Peer Helper MCPs`** section into `Lead`'s `Seat kickoff packet` (`src/preflight.ts`) and `buildRoleKickoffPrompt` (`src/roles-contract.ts`) listing each enabled Helper MCP's canonical name, transport (`stdio` vs `http`), and live readiness state (`connected`, `auth_expired`, `missing_env`, `unreachable`), so `Lead` knows which external MCPs `Peer` can use when authoring `Contract`s and warns immediately if a required MCP is `auth_expired`.

### 3. Bidirectional OAuth Token Sync, Auto-Refresh, and `Private vault` Replication

- Before spawning `Peer` and during explicit sync/probe actions, reconcile OAuth tokens for HTTP Helper MCPs (matched by normalized URL origin+pathname or canonical server name, e.g. `supabase` at `https://mcp.supabase.com/mcp`):
  - Read both `~/.gemini/antigravity/mcp_oauth_tokens.json` and `~/.pi/agent/mcp-oauth/sha256-<sha256(name)>/tokens.json` (plus `<stateDir>/pi-agent/agent/mcp-oauth/...`).
  - Select the token bundle with the latest expiry. If the token is expired or within 5 minutes of expiry and carries both `refresh_token` and `token_url` (or standard OAuth token endpoint metadata), automatically attempt an OAuth `grant_type=refresh_token` refresh and persist the refreshed token back to all stores.
  - Materialize the winning token into:
    1. `<stateDir>/pi-agent/agent/mcp-oauth/sha256-<sha256(name)>/tokens.json` (with `0o600` permissions)
    2. `~/.pi/agent/mcp-oauth/sha256-<sha256(name)>/tokens.json`
    3. `~/.gemini/antigravity/mcp_oauth_tokens.json`
    4. `headers: { Authorization: "Bearer <accessToken>" }` on `config.mcpServers[name]` for non-Pi providers (`claude`, `codex`, `opencode`).
- **`Private vault` sync (`src/vault-materialization.ts`):**
  - Collect and hydrate `config/helper-mcps.json` (merged Helper MCP definitions and enabled/disabled overrides, with secret env values stripped into the secret store) and `secrets/shared/mcp-oauth.json` (`0o600` OAuth token bundles + Helper MCP secret env keys) during `Private vault` **Sync**, allowing a secondary machine (`andrews-mac-mini`) to inherit authenticated Helper MCP access without repeating browser OAuth flows.

### 4. Connectivity Probe & `Factory surface` (`Plugins` Tab) Visibility

- Add a deterministic connectivity & credential checker (`probeHelperMcps`) that classifies each Helper MCP as:
  - `connected`: OAuth token valid (and/or HTTP MCP endpoint responds to probe) or stdio command/env credentials present.
  - `auth_expired`: HTTP OAuth MCP has no token or an expired token that could not be refreshed.
  - `missing_env`: Required API key env var (`EXA_API_KEY`, `Z_AI_API_KEY`, `OPENAPI_MCP_HEADERS`, etc.) is empty.
  - `unreachable`: Endpoint probe failed.
  - `disabled`: Explicitly disabled by the Owner or source config.
- Surface a **Helper MCP Servers (Peer)** section in the `Factory surface`'s `Plugins` tab displaying each discovered server, its source harnesses, transport badge, status pill (`Connected`, `Auth Expired`, `Missing Key`, `Disabled`), per-server `Enable` / `Disable` toggle, and a 1-click **`Test & Sync MCPs`** action.
- Run a fast non-blocking sync + token check automatically before spawning `Peer` so fresh OAuth tokens from Antigravity or Vault are always materialized into the `Peer` harness before Turn 1.

### 5. SLP `Peer` Skill Parity on Pi & Role Tool/Skill Alignment

- Update `buildManagedSkillsSettings` in `src/pi-home.ts` so `role === "agent"` (`Peer`) in SLP mode receives `["!*", "+~/.agents/skills/*", "-~/.agents/skills/factory"]` (plus any explicit Contract skill paths), matching Claude, Codex, and OpenCode so `Peer` on Pi can use `frontend-design`, `web-design-guidelines`, `domain-modeling`, `research`, and `impeccable` alongside `tdd`, `diagnosing-bugs`, and `codebase-design`.
- Add `"domain-modeling": "allow"` to OpenCode's `Supervisor` `permission.skill` map in `plugin/server/roles.ts` to match `ROLE_SKILL_INDEX.supervisor`.
- Add `supervisor_accept_task: ["supervisor"]`, `lead_repoke_agent: ["lead"]`, and `lead_needs_human: ["lead"]` to `sharedRoles` in `src/mcp/shared.ts` so prompt tool manuals match `bridge.mjs` and `CONTEXT.md`.

## Consequences

- Installing or authenticating an MCP server once in Antigravity or Pi makes it immediately available to `Peer` across all harnesses (`pi`, `claude`, `codex`, `opencode`) and across machines via `Private vault`.
- `Lead` stays lightweight and fenced (`paseo_factory` only) while gaining explicit knowledge of `Peer`'s live Helper MCP capabilities and auth health in its Kickoff Packet.
- The Owner can inspect, toggle, test, and sync all `Peer` Helper MCPs directly from the `Plugins` tab in Paseo Desktop.
