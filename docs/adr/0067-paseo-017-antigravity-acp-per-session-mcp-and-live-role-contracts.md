# 0067 — Paseo 0.17.1 Adaptation: Antigravity ACP Per-Session MCP, Dual Persistence Decoding, Catalog Lane Normalization, and Live Role Contracts

- **Date:** 2026-11-22
- **Status:** Accepted — ratified by the Owner over `/grill-with-docs` rounds 1–2 (Q1–Q12).
- **Grounded in:** Paseo `v0.17.1` (`plugins/antigravity-provider/server/{provider,tool-calls,usage}.ts`, `packages/plugin/src/server/{contracts,lifecycle,acp-internal/connection}.ts`, `packages/server/src/server/{agent/agent-manager,agent/plugin-provider,plugins/lifecycle/index}.ts`, `packages/protocol/src/provider-config.ts`) · live `agy 1.5.14` ACP `initialize` probe (`_meta.antigravity.systemPrompt.append: true`, `loadSession: true`) · local `codex-cli 0.166.0` · `src/{usage-extractor,agy-transcript,agy-home,agy-mcp-schema-heal,lanes,skill,role-providers}.ts` · `plugin/server/{roles,choke,provider-lanes,surface-rpc}.ts` · `plugin/index.server.ts` · `plugin/client/factory/{shell,onboarding-screen}.tsx`.
- **Amends:**
  - [ADR 0016 §1/§3](0016-role-scoped-mcp-bridge-kickoff-packet-and-three-layer-execution-fence.md) (transitions `antigravity` on Paseo `>=0.17.1` from global `~/.gemini/config/plugins/paseo-factory/mcp_config.json` to per-session `config.mcpServers`, removing global `mcp_config.json` while retaining `hooks.json` `PreToolUse` fencing, and shifts new non-Pi seats on `>=0.17.1` from baked `config.systemPrompt` to live `agent.open.before` `appendSystemPrompt`).
  - [ADR 0043 §2](0043-plugin-owned-multi-provider-token-metering-and-project-usage-rollup.md) (extends Antigravity conversation ID extraction to accept both ACP `data.sessionId` and legacy stream-JSON `data.conversationId`).
  - [ADR 0062](0062-sibling-model-thinking-effort-resolution.md) (adds read-time + save-time catalog-aware normalization of legacy effort-suffixed `<base>-(low|medium|high|xhigh|max)` lanes to `<base>:<tier>` when the live provider catalog advertises `<base>` with `thinkingOptions`, preserving sibling resolution whenever `thinkingOptions` is empty).
  - [ADR 0064](0064-antigravity-mcp-schema-cache-self-heal.md) (expands the `agy-pre-tool-hook.mjs` lazy-schema self-heal target allowlist to cover both `paseo-factory_paseo_factory` and per-session `paseo_factory`).

## Context

Paseo `v0.17.1` migrated the built-in `antigravity-provider` from stream-JSON to the shared ACP runtime (`agy acp`, requiring `agy >= 1.5.0`, `#10193`) and shipped three plugin-facing changes (`#9781` `agent.open.before` `appendSystemPrompt`, `#10278` `server.registerWorktreeManager`, and `#5574` `navigation.openAgent`/`openWorkspace` `focusHost`). Inspecting Paseo `v0.16.0` vs. `v0.17.1` exposed two silent regressions and three high-leverage architectural opportunities:

1. **Breaking Antigravity persistence key change (`data.conversationId` → `data.sessionId`):** ACP `nativePersistence` writes `{ version: 1, data: { sessionId } }` instead of `{ version: 1, data: { conversationId } }`. Both `antigravityConversationIdOf` (`src/usage-extractor.ts`) and `conversationFrom` (`src/agy-transcript.ts`) read only `data.conversationId`, breaking `Meter` token rollup, post-restart `Handoff` context occupancy fallback, and `factory agy-transcript` for every new Antigravity session created on `0.17.1+`.
2. **Strict `agent.open.before` schema & `supportsMcpServers` split across `<0.17.1` vs. `>=0.17.1`:** `paseo-factory` keeps `requirements.paseo: ">=0.13.0"` so mixed-version hosts (local Desktop and remote Mac Mini) never break mid-rollout. On Paseo `0.16.x`, `beforeSchemas["agent.open.before"]` is `.strict()` and rejects `appendSystemPrompt` with a Zod error, while `antigravity` sets `supportsMcpServers: false` and aborts creation if `config.mcpServers` is non-empty. Meanwhile `ProviderOverridesSchema` (`packages/protocol`) still excludes `antigravity` from `BUILTIN_PROVIDER_IDS`, so the `Role provider` `extends` fallback (ADR 0026) remains mandatory.
3. **Global `mcp_config.json` vs. per-session `config.mcpServers` on Antigravity:** On `0.17.1+`, `antigravity-provider` sets `supportsMcpServers: true` and forwards per-session `mcpServers` into `agy acp` `session/new` and `session/load`. Keeping global `~/.gemini/config/plugins/paseo-factory/mcp_config.json` alongside per-session `config.mcpServers.paseo_factory` would register duplicate MCP servers (`paseo-factory_paseo_factory` and `paseo_factory`) inside every Antigravity Factory seat.
4. **Frozen role contracts & legacy effort-suffixed Antigravity lanes:** Previously, `injectRoleOnCreate` baked role contracts into persisted `config.systemPrompt`, so plugin upgrades did not reach live seats until `Handoff` or `Rotate seats`. Separately, existing `lanes.json` entries (e.g. `antigravity/gemini-4-argon-high`) no longer match exact model IDs in `agy acp`'s base-model + `thinkingOptions` catalog.

## Decision

1. **Preserve `requirements.paseo: ">=0.13.0"` and gate all `0.17.1+` hooks via one synchronous runtime capability check:**
   - Bump devDependencies `@getpaseo/plugin` and `@getpaseo/protocol` to `0.17.1` (strictly additive types) while keeping `plugin/paseo-plugin.json` at `">=0.13.0"`.
   - Use `typeof server.registerWorktreeManager === "function"` as the single synchronous, zero-I/O runtime capability gate (`supportsV0171Host`) confirming that the host supports `agent.open.before` `appendSystemPrompt`, ACP `antigravity-provider` (`supportsMcpServers: true`, `deferTurnOnRunningTools`, full history replay), and `0.17.1` lifecycle contracts. On hosts where this gate is `false`, `paseo-factory` fails closed to `0.16.x` behavior verbatim.

2. **Dual Antigravity persistence decoding (`data.conversationId ?? data.sessionId`):**
   - Update `antigravityConversationIdOf` (`src/usage-extractor.ts`) and `conversationFrom` (`src/agy-transcript.ts`) to resolve `data.conversationId ?? data.sessionId` across both `persistence.metadata.pluginProviderPersistence` and `plugin:{...}` encoded `sessionId` strings, keeping 100% backward compatibility with pre-`0.17.1` records.

3. **Antigravity per-session `config.mcpServers` on `>=0.17.1` & clean global plugin hygiene:**
   - When `supportsV0171Host` is `true`, `applyProviderExecutionFence` passes per-session `config.mcpServers` on `antigravity` identically to other providers — attaching role-scoped `paseo_factory` with explicit `--correlation`, `--role`, `--project`, `--workspace`, and `--task` args, plus `Helper MCP catalog` servers for `Peer`s (`resolveRoleScopedMcpServers`).
   - `provisionAgyPlugin` continues writing `plugin.json` and `hooks.json` (`PreToolUse` → `agy-pre-tool-hook.mjs`), and **removes `mcp_config.json`** from `~/.gemini/config/plugins/paseo-factory/` on `>=0.17.1` hosts so Factory seats see exactly one `paseo_factory` server and unbound personal Antigravity chats use the `/factory` skill instead of spawning an idle `bridge.mjs`. On `<0.17.1` hosts, `provisionAgyPlugin` retains `mcp_config.json` as before.
   - Keep Antigravity on default `full-access` + `agy-pre-tool-hook.mjs` (Layer 1) + `<stateDir>/bin` shims (Layer 3) rather than pinning `modeId: "default"` into Layer-2 `Choke policy` (avoiding upstream edit-without-diff gaps in Paseo `#10358`).
   - Expand `agy-mcp-schema-heal.ts` (ADR 0064) to accept both `<appDataDir>/mcp/paseo-factory_paseo_factory/<tool>.json` (legacy/`<0.17.1`) and `<appDataDir>/mcp/paseo_factory/<tool>.json` (per-session `0.17.1+`) under the same single-segment, role-allowlist, fail-open invariants.

4. **Live role contracts via `agent.open.before` `appendSystemPrompt` with duplicate-free legacy coexistence:**
   - On `>=0.17.1` hosts, newly created seats and `Peer`s on all non-Pi harnesses (`antigravity`, `claude`, `codex`, `opencode`, `copilot`, `omp`) stamp `env.PASEO_FACTORY_CONTRACT_MODE = "live"` on `agent.create.before` and omit the role contract + peer skill scope block from persisted `config.systemPrompt`.
   - On every interactive open (`agent.open.before` with `purpose === "interactive"`), when `PASEO_FACTORY_CONTRACT_MODE === "live"`, the plugin renders the current role contract (and `Peer` skill scope) from the running plugin version and appends it to `request.appendSystemPrompt` — delivering fresh rules on plugin updates and resumes without mutating saved agent configs.
   - Pre-existing agents lacking `PASEO_FACTORY_CONTRACT_MODE=live` already carry their baked contract in persisted `config.systemPrompt` and receive no `appendSystemPrompt` addition (preventing 2–4k token duplication); they transition naturally at their next `Handoff` or `Rotate seats`.
   - `Pi` seats (`Pi harness home`) continue receiving live compaction-proof instructions via `APPEND_SYSTEM.md` and emit no duplicate `appendSystemPrompt`. `Codex` participates in live `appendSystemPrompt` (requiring Codex CLI `>=0.121.0`).

5. **Read-time + save-time catalog-aware Antigravity lane normalization:**
   - In `sanitizeLaneWithProviders`, `laneProviderConfig`, and `resolvePeerThinkingLane`, when a lane names `<provider>/<base>-(low|medium|high|xhigh|max)` with no exact model match in the live catalog, and the catalog advertises `<base>` with `thinkingOptions` containing `<tier>`, resolve it to `<provider>/<base>:<tier>` (`{ model: base, thinkingOptionId: tier }`).
   - Do **not** auto-rewrite `lanes.json` or `profiles.json` on disk at boot, preventing cross-host breakage when `Private vault` syncs lanes to a host still running Paseo `0.16.x`; files update to `<base>:<tier>` naturally only on explicit Owner saves or profile applies.
   - Retain ADR 0062 same-base sibling resolution verbatim whenever a provider catalog advertises `thinkingOptions: []`.

6. **Targeted low-risk `0.17.1` UX & skill updates (explicitly bounded scope):**
   - Add `<userHome>/.gemini/config/skills` to `factorySkillRoots` (`src/skill.ts`) so `/factory` appears in Antigravity's inline `/` skill suggestions (`#10383`) even on clean hosts without manual symlinks.
   - Pass `focusHost: true` on `navigation.openAgent` and `navigation.openWorkspace` in `plugin/client/factory/{shell,onboarding-screen}.tsx` whenever `navigation?.supportsFocusHost` is `true` (`#5574`), improving multi-host navigation between local Desktop and remote daemons.
   - **Explicitly deferred (out of scope):** `server.registerWorktreeManager` (`#10278`, because `Task worktree` lifecycle is tightly coupled to `Ledger`/`Contract`/`Gate`), `subscribe_change_request` PR Watch (`#10148`, because seats keep `paseoTools.enabled: false`), and migrating `Onboarding screen` to `useProjects`/`useWorkspaces` (`#10049`, deferred until the minimum Paseo floor rises to `>=0.17.1`).

## Considered Options

- **Raise `requirements.paseo` to `>=0.17.1` immediately:** Rejected because local Desktop and remote Mac Mini hosts upgrade asynchronously; a single synchronous capability gate (`typeof server.registerWorktreeManager === "function"`) preserves mixed-host operation with negligible complexity.
- **Keep global `~/.gemini/config/plugins/paseo-factory/mcp_config.json` and return empty `tools/list: []` when `PASEO_FACTORY_SEAT` is set:** Rejected because it still spawns an idle `bridge.mjs` subprocess on every Antigravity seat and every unbound personal Antigravity session, whereas `/factory` in `~/.gemini/config/skills/factory/SKILL.md` already serves unbound chats cleanly.
- **Pin `modeId: "default"` on Antigravity to route tool calls through Layer-2 `Choke policy`:** Rejected for now because Paseo `#10358` still leaves edit-without-diff cases open, while `agy-pre-tool-hook.mjs` (`PreToolUse`) already enforces strict workspace/scope/memory fencing directly inside `agy`.
- **Rewrite `lanes.json` to `<base>:<tier>` on disk at boot:** Rejected because `Private vault` syncs `lanes.json` across hosts; mutating disk on boot would break a peer host still on Paseo `0.16.2`.

## Consequences

- `Meter`, post-restart `Handoff` context occupancy sensors, and `factory agy-transcript` work seamlessly across both legacy (`data.conversationId`) and Paseo `0.17.1+` ACP (`data.sessionId`) Antigravity sessions.
- Antigravity seats on Paseo `>=0.17.1` gain exact per-session `Correlation token` scoping, `Peer` access to `Helper MCP catalog` servers from `Private vault`, and clean isolation from personal Antigravity sessions.
- Non-Pi seats created on Paseo `>=0.17.1` automatically pick up updated role contracts on plugin upgrade/reload without rotating seats or duplicating prompts on legacy sessions.
- `CONTEXT.md` updates `Role-scoped MCP bridge` (and `Helper MCP catalog` / `Role provider` references) to record live role-contract injection and Antigravity per-session MCP support on Paseo `>=0.17.1`.
