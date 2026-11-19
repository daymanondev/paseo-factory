# 0064 — Self-Healing Antigravity MCP Schema Cache in `PreToolUse` Hook

- **Date:** 2026-11-19
- **Status:** Accepted — ratified by the Owner via `/grill-with-docs` (Rounds 1–2).
- **Grounded in:** Live Paseo Desktop transcripts (`pos-tax-android-1f0d84` Leads `8eaa2b9e`, `7a42fa22`, `dc1311b3`, `6836dcc1`, `0fa11e83`, and cross-Project overwrite by `goal-partner`'s `Supervisor`), `~/.gemini/antigravity-cli/mcp/paseo-factory_paseo_factory/`, `src/agy-home.ts`, `src/mcp/catalog.ts`, `scripts/generate-policies.mjs`, and `plugin/bin/agy-pre-tool-hook.mjs`.
- **Amends:** [ADR 0016 §1/§3](0016-role-scoped-mcp-bridge-kickoff-packet-and-three-layer-execution-fence.md) (adds additive, role-scoped MCP schema self-healing to `agy-pre-tool-hook.mjs` on `read_file` / `view_file` without relaxing role-scoped `tools/list` or adding extra MCP servers).

## Context

Under [ADR 0016](0016-role-scoped-mcp-bridge-kickoff-packet-and-three-layer-execution-fence.md), Paseo's `antigravity` provider sets `supportsMcpServers: false`, so `paseo-factory` provisions one global Antigravity plugin (`~/.gemini/config/plugins/paseo-factory/{plugin.json,mcp_config.json,hooks.json}`) exposing a single role-scoped stdio server (`paseo_factory` backed by `bridge.mjs`).

Antigravity (`agy`) lazy-loads MCP tool schemas by dumping each connected server's `tools/list` response to `<appDataDir>/mcp/<pluginName>_<serverKey>/<toolName>.json` and instructing the model to `read_file` a tool's schema before calling `call_mcp_tool`. Because every `agy` CLI process on the host shares one `appDataDir` (`~/.gemini/antigravity-cli/`) and one server name (`paseo_factory`), every newly spawned seat overwrites and prunes `~/.gemini/antigravity-cli/mcp/paseo-factory_paseo_factory/` to contain only its own role's tools:

- A newly started `Peer` (`agent`) prunes the directory to `agent_claim.json` and `agent_escalate_blocker.json`, deleting all 14 `Lead` and 6 `Supervisor` schemas.
- A newly started `Supervisor` (even in another Project on the same host) prunes the directory to its 6 schemas, deleting both `Lead` and `Peer` schemas.

Each seat's own `bridge.mjs` stdio process remains live so `call_mcp_tool` still works, but whenever an already-running `Supervisor`, `Lead`, or `Peer` tries to `read_file` a schema it has not yet inspected in that session, `read_file` fails with `file does not exist` (observed in 4 of 5 consecutive `pos-tax-android` `Lead` sessions), wasting turns on directory inspection or fallback recovery.

## Decision

1. **Additive single-file self-healing in `plugin/bin/agy-pre-tool-hook.mjs`:**
   - Bundle a small TypeScript helper (generated from `src/mcp/catalog.ts` via `scripts/generate-policies.mjs`, keeping `agy-pre-tool-hook.mjs` zero-relative-import and strictly in sync with `bridge.mjs`) into `plugin/bin/agy-pre-tool-hook.mjs`.
   - When an Antigravity factory seat (`ctx.seat` ∈ `{supervisor, lead, agent}`) calls a read tool (`read_file`, `view_file`) targeting `<userHome>/.gemini/{antigravity,antigravity-cli}/mcp/paseo-factory_paseo_factory/<toolName>.json` (strictly single-segment `<toolName>.json`, no path traversal):
     - Verify `<toolName>` is permitted for `ctx.seat` (`catalog.roles[ctx.seat]`). Never materialize another role's schema.
     - If `!existsSync(targetPath)`, create the parent directory if needed and atomically write `<toolName>.json` (write sibling temp file + `renameSync`) in Antigravity's on-disk schema format (`{ name, description, parameters: tool.inputSchema }`, omitting `_meta`).
     - Never overwrite an existing file and never delete sibling files in the directory, so concurrent `read_file` calls and active seats of other roles cannot clobber each other.
   - **Absolute fail-open:** Any filesystem error during self-healing is swallowed and the hook still returns `{"decision":"allow"}` so `read_file` is never blocked by cache-heal failures.

2. **Preserve `<5ms` non-Factory fast-path & zero impact on other providers:**
   - Unbound Antigravity sessions (`PASEO_FACTORY_SEAT` and `PASEO_FACTORY_CORRELATION` both unset) continue to exit immediately at the top of `agy-pre-tool-hook.mjs` without reading stdin or touching disk (Antigravity IDE also uses `~/.gemini/antigravity/mcp/`, already isolated from `agy` CLI's `~/.gemini/antigravity-cli/mcp/`).
   - No changes to `bridge.mjs`, `mcp_config.json`, `pi-home.ts`, `roles.ts`, `choke.ts`, or `Seat kickoff packet` — non-Antigravity providers (`pi`, `claude`, `codex`, `opencode`, `copilot`, `omp`) never invoke `agy-pre-tool-hook.mjs` and are completely unaffected.

## Considered Options

- **Role-split MCP server entries in `mcp_config.json` (`paseo_factory_supervisor`, `paseo_factory_lead`, `paseo_factory_agent`, `paseo_factory`) with non-matching roles failing fast on startup:** Rejected because every Antigravity launch (including normal IDE sessions) would spawn 4 Electron/Node `bridge.mjs` processes and deliberately fail 3 of them (causing noisy failed-MCP UI state and startup overhead), and would fragment `ServerName` across role contracts and tests.
- **Omnibus `tools/list` on Antigravity (expose all ~18 tools to every `agy` seat while fencing `tools/call`):** Rejected because it violates ADR 0016 §1 and `CONTEXT.md` (`Avoid: cross-role omnibus MCP`), exposing `lead_*`/`supervisor_*` tools to `Peer`s and all 18 Factory tools to unbound `agy` CLI sessions.
- **Embed full parameter schemas in `roles-contract.ts` and instruct seats to skip `read_file`:** Rejected as non-mechanical, bloating every `Seat kickoff packet` (~1.5–2K tokens, contradicting ADR 0047) while fighting Antigravity's built-in lazy-MCP system prompt.

## Consequences

- `Supervisor`, `Lead`, and `Peer` seats running on `antigravity` stop hitting `file does not exist` on `paseo-factory_paseo_factory/*.json` even when other roles or Projects spawn concurrently on the same host.
- Antigravity's normal one-time lazy `read_file` on Turn 1 remains intact, and `Role-scoped MCP bridge` semantics (ADR 0016) remain unchanged.
- `CONTEXT.md` requires no new domain term; `npm run generate:policies:check` guarantees the hook's embedded MCP catalog never drifts from `src/mcp/catalog.ts`.
