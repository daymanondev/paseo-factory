# ADR 0011 — Clean-room Pi harness isolation (`PI_CODING_AGENT_DIR`) across roles and headless passes

- **Status:** Accepted — 2026-10-16 (ratified by Andrew over a three-round `/grill-with-docs`, all-recommended; words "toàn bộ theo khuyến nghị của bạn")
- **Grounded in:** `research/pi-seat-isolation-extensions-and-skills.md` · `sting9k/seatworks` (`v3`, `plugin/harness/pi/{harness,settings}.json`, `plugin/server/catalog/seats.ts`) · `cuongntr/paseo-room` (`src/agents/{pi,resources}.ts`) · `sting8k/piggery` (`internal/driver/local/agentdir.go`) · `@earendil-works/pi-coding-agent@1.3.0` (`config.js`, `core/{resource-loader,package-manager,settings-manager,mcp-servers}.js`, `extensions/mcp/{index,config}.js`) · `@getpaseo/server@0.11.4` (`providers/pi/agent.js`)
- **Amends:** ADR 0010 §6 (replaces direct inheritance of the raw `~/.pi/agent` home for `pi` lanes with clean-room per-role `PI_CODING_AGENT_DIR` homes under `<stateDir>/pi-agent/<role>` that strip user TUI packages/extensions and `APPEND_SYSTEM.md` while preserving auth, models, sessions, native `builtin:mcp`, and curated skills)

## Context

Pointing `pi` sessions directly at the operator's global `~/.pi/agent` directory introduces three compounding failures inside `paseo-factory`:

1. **Unintended prompt & subagent contamination (`APPEND_SYSTEM.md`):** `DefaultResourceLoader.discoverAppendSystemPromptFile()` (`resource-loader.js:950-959`) unconditionally appends `<PI_CODING_AGENT_DIR>/APPEND_SYSTEM.md` to every session (even when `--no-context-files` is set on headless `Watch` / `Retro` / `Fresh-eyes` CLI runs), injecting operator TUI rules such as `# Auto-Delegation Rules` (`subagent` tool delegation) that conflict with `paseo-factory`'s SLP role contracts.
2. **Double-spawn latency from TUI npm packages (`settings.json`):** `@getpaseo/server`'s `PiAgentClient.prepareMcpInjection()` spawns a throwaway `pi --mode rpc` probe to run `get_commands` before spawning the real session. When `~/.pi/agent/settings.json` loads ~21 interactive TUI/workflow npm packages (`context-mode`, `pi-subagents`, `rpiv-*`, `pi-powerline-footer`, etc.) and `~/.pi/agent/extensions/*.ts`, each spawn takes ~2.16s (`127` commands), penalizing every seat startup by ~4.5–5.3s.
3. **Skill catalog noise:** `~/.pi/agent/skills` mixes non-engineering personal folders and 22 npm-package skills with `~/.agents/skills`, bloating `<available_skills>` on working `Agent`s.

Both `seatworks` (v3) and `paseo-room` solve this by provisioning a clean-room `PI_CODING_AGENT_DIR` with zero user packages and zero user extensions (`packages: []`). Furthermore, `@earendil-works/pi-coding-agent@1.3.0` now ships native `builtin:mcp` (which Paseo `0.11.4` detects directly via `sourceInfo.path === "builtin:mcp"`), eliminating the need for `npm:pi-mcp-adapter` and reducing `pi` startup from **2,159 ms to 137–160 ms** (**13.5x–15.7x faster**).

## Decision

1. **Per-role clean-room `PI_CODING_AGENT_DIR` (`<stateDir>/pi-agent/<role>`) for all Factory `pi` invocations.**
   - `paseo-factory` provisions isolated Pi harness homes under `<stateDir>/pi-agent/{supervisor,lead,agent,headless}` and injects `PI_CODING_AGENT_DIR` across:
     - **All three daemon roles (`supervisor`, `lead`, `agent`)** via `factoryEnvFor()` in `plugin/server/roles.ts` (`server.before("agent.create")` and `server.before("agent.session_open")`).
     - **All headless tool-less `pi/<model>` passes (`Watch`, `Retro`, `Fresh-eyes review`)** in `src/lanes.ts` (`runLaneCli()`), eliminating `packageManager.resolve()` overhead and `APPEND_SYSTEM.md` leakage.

2. **Zero user packages, zero user extensions, no `APPEND_SYSTEM.md`.**
   - Each isolated `<stateDir>/pi-agent/<role>/settings.json` carries only model/thinking defaults (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`) from `~/.pi/agent/settings.json` and enforces:
     ```json
     {
       "packages": [],
       "extensions": ["-builtin:llama.cpp"],
       "quietStartup": true,
       "defaultProjectTrust": "always"
     }
     ```
   - `extensions/`, `prompts/`, `SYSTEM.md`, and `APPEND_SYSTEM.md` from `~/.pi/agent` are **never** linked or copied.
   - Pi v1.3.0's native built-in extensions (`builtin:mcp`, `builtin:codemode`, `builtin:tool-search`) remain enabled by default (for interactive roles; headless passes continue to pass `--no-extensions`).

3. **Shared auth, models, OAuth credentials, and `sessions/` symlinks.**
   - Each isolated `<stateDir>/pi-agent/<role>` symlinks read-through state from `~/.pi/agent`:
     - `auth.json`, `models.json`, `models-store.json` (plus `mcp-oauth` / OAuth credential stores when present).
     - `sessions` → `~/.pi/agent/sessions` (created if absent), ensuring Paseo daemon session persistence (`sessionId` resume) works seamlessly across existing and new sessions.

4. **Role-scoped Skills visibility (`~/.agents/skills` vs curated working `Agent`).**
   - Personal/package skills in `~/.pi/agent/skills` are excluded by never symlinking `<PI_CODING_AGENT_DIR>/skills`.
   - **`Supervisor` and `Lead`:** Allow Pi v1.3.0 to auto-discover the shared engineering catalog in `~/.agents/skills` (so `Lead` sees the full catalog when selecting `--skills` for a `Contract`), anchored by `ROLE_SKILL_INDEX` (`supervisor`: `grilling, domain-modeling`; `lead`: `codebase-design, domain-modeling, tdd`).
   - **Working `Agent`:** Filter `"skills"` in `<stateDir>/pi-agent/agent/settings.json` to only the 3 core agent skills (`tdd`, `diagnosing-bugs`, `codebase-design`). When a `Contract` specifies additional `skills: string[]`, the `Driver`'s brief instructs the `Agent` to read `~/.agents/skills/<name>/SKILL.md` (or `<workspace>/.agents/skills/<name>/SKILL.md`) directly via `Read`, keeping `<available_skills>` minimal on every turn.

5. **Native `builtin:mcp` with sanitized `mcp.json` and zero custom Factory MCP UI.**
   - Each isolated `<stateDir>/pi-agent/<role>/mcp.json` is synchronized from `~/.pi/agent/mcp.json` while stripping legacy `pi-mcp-adapter` fields rejected by Pi v1.3.0's `builtin:mcp` validator (specifically string `"auth": "oauth"` on HTTP/stdio entries, since `builtin:mcp` handles HTTP 401 OAuth natively).
   - With `"defaultProjectTrust": "always"`, per-repository `<project-root>/.pi/mcp.json` overrides work natively.
   - `paseo-factory` adds **no custom MCP management/OAuth UI** to the `Factory surface`: Pi v1.3.0's `builtin:mcp` connects servers in background `"codemode"` exposure (zero upfront tool-schema token bloat) and exposes `/mcp`, `/mcp login <server>`, `/mcp logout <server>`, and `/mcp reconnect <server>` directly in the Paseo chat input (automatically opening the browser for OAuth).

## Consequences

- `CONTEXT.md` adds the **Pi harness home** entry (naming `Supervisor`, `Lead`, working `Agent`, and the headless `Watch` / `Retro` / `Fresh-eyes review` passes; the six term entries themselves are untouched).
- `plugin/server/roles.ts` (`factoryEnvFor`) and `src/lanes.ts` (`runLaneCli`) provision and bind `PI_CODING_AGENT_DIR`.
- Obsolete Yara-specific entries (`code-graph-mp`, `yara-db`, `atlassian-mcp-server`, `sentry`) and legacy `"auth": "oauth"` fields come out of the operator's `~/.pi/agent/mcp.json` as an owner-side migration (the repo diff cannot edit the operator home); the per-provision re-synchronization then carries the edit into every role home on the next session open or headless pass.
