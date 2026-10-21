# ADR 0016 — Role-Scoped MCP Bridge (`paseo_factory`), Unforgeable `CorrelationRegistry`, 2-Step Seat Launch with `Seat kickoff packet`, Process-Group Gate Reaping, and 3-Layer Execution Fence Across All 7 Providers

- **Status:** Accepted — 2026-10-21 (ratified by Andrew over a four-round `/grill-with-docs` + deep-research verification across Paseo `0.11.2` `app.asar`, `@earendil-works/pi-coding-agent` `v1.3.0`, `paseo-room`, `seatworks`, and `piggery`)
- **Grounded in:** Live Paseo Desktop forensic trace (`~/.paseo`, project `ai-test-043c7e`, 2026-10-20 23:25–23:32 +07:00) · Paseo Desktop `0.11.2` `app.asar` (`AgentManager.requireExternalMcpSupport`, `McpStdioServerConfigSchema`, `OpenCodeProviderOptionsSchema`, `ClaudeProviderOptionsSchema`, `CodexProviderOptionsSchema`, `resolveACPCreateConfig`, `requiresDedicatedOpenCodeServer`, `toPiBuiltinMcpServers`) · `@earendil-works/pi-coding-agent` `v1.3.0` (`dist/extensions/mcp/{index.js,config.js,runtime.js}`, `dist/transports/stdio.js`) · `cuongntr/paseo-room` (`v0.19.0`, `src/runtime-plugin/server/{correlations,hooks,tools,spool,gate,seats,brief,paseo-port,controller}.ts`) · `daymanondev/seatworks` (`v3`, `plugin/mcp/team.mjs`, `plugin/server/catalog/{kit,launch,providers,seats,servers}.ts`, `plugin/harness/{pi,opencode,claude,codex,agy}/harness.json`) · `sting8k/piggery` (`v0.10.4`, `internal/driver/local/{pi,agentdir,opencode}.go`, `extensions/pi/index.ts`)
- **Amends:** ADR 0004 (adds the role-scoped `paseo_factory` stdio MCP server alongside the `factory` CLI over the same Spool and `CorrelationRegistry`) · ADR 0010 §2–§4 & ADR 0013 §2–§4 (replaces single-shot seat creation + thin mailbox text with a 2-step workspace-bound seat launch and a deterministic `Seat kickoff packet` carrying `Project preflight` context) · ADR 0011 §2–§3 (adds `"exposure": "direct"` for `paseo_factory` in `<stateDir>/pi-agent/<role>/mcp.json` and restricts `defaultTools` for `supervisor` and `lead` in `settings.json`) · ADR 0015 §1–§4 (upgrades the `Seat write fence` and `Choke policy` into a 3-layer execution fence across `opencode`, `claude`, `codex`, `pi`, `copilot`, `omp`, and `antigravity`, strictly strips invalid `labels` from `server.before("agent.create")` return payloads, and adds process-group reaping in `Gate`)

## Context

Live end-to-end testing of `paseo-factory` (`v0.0.25`) on Paseo Desktop (`~/.paseo`, project `/Users/andrewpham/Documents/code/ai-test`) and deep inspection of Paseo `0.11.2`'s `app.asar` alongside `paseo-room`, `seatworks`, and `piggery` exposed why `Supervisor` and `Lead` seats continued to fail, hang, or violate role boundaries despite earlier patches:

1. **`server.before("agent.create")` Returned Invalid `{ labels }` Key, Causing Paseo's Strict Hook Schema to Reject Seat Creation and Freeze the Mailbox:**
   - In `v0.0.24`, `plugin/index.server.ts` returned `{ config, env, labels }` from `server.before("agent.create")` whenever `normalized.labels` was defined.
   - Paseo `0.11.2`'s hook validator (`app.asar` `beforeHookResultSchemas["agent.create"]`) uses a `.strict()` Zod schema that permits **only** `{ config?, env? }`. Returning `labels` threw `Invalid hook result for "agent.create": Unrecognized key: "labels"`, causing `ensureLead` to fail, catching silently inside `lead-mailbox.ts`, and leaving queued directives stuck in `mailbox.jsonl` forever.

2. **`Lead` and `Supervisor` Were Spawned Cold Without Project Context (`Seat kickoff packet`) and Relied on Fragile Bash-Only CLI Calls:**
   - When `ensureSeat("lead")` created a `Lead` seat and `drainLeadMailbox` sent Turn 1, the prompt contained only the raw 4-line `# Lead mailbox — 1 item(s)` text (`"test thử đi bạn"`), with zero information about the repository's directory structure, git branch/commit/dirty state, `package.json` scripts, or current `Ledger` state.
   - Worse, unlike `paseo-room` (`src/runtime-plugin/server/tools.ts`) and `seatworks` (`plugin/mcp/team.mjs`), `paseo-factory` exposed its workflow actions only as bash subcommands (`factory contract ...`, `factory run ...`) instead of first-class, role-scoped MCP tools (`paseo_factory`). Weak or fast models had to guess CLI flags via bash or fell back to calling Paseo's native `paseo_*` agent tools (`create_agent`, `kill_agent`) directly.

3. **`unattended: true` Silently Bypassed `choke.onPermissionAsked` Across `OpenCode`, `Claude`, `Codex`, `Copilot`, and `OMP`, Leaving Seats Unfenced:**
   - When `ensureSeat` created `Supervisor` or `Lead` with `unattended: true`, Paseo's `resolveCreateConfig` (`app.asar` `@ 30169792–30172100`, `30782596`) automatically selected each provider's unattended bypass mode:
     - `opencode` set `featureValues: { auto_accept: true }`, which auto-approved every `edit`, `write`, and `bash` call inside Paseo's OpenCode adapter **without** firing `server.before("agent.permission_asked")`.
     - `claude` set `modeId: "bypassPermissions"`, where Claude's SDK explicitly skips `canUseTool` (`onPermissionAsked`) for all tools not in `disallowedTools` or `settings.permissions.deny`.
     - `codex` set `modeId: "full-access"` (`approvalPolicy: "never"`, `sandbox: "danger-full-access"`), never consulting `onPermissionAsked`.
     - `copilot` set `modeId: "allow-all"` and `featureValues: { auto_accept: true }`.
     - `omp` set `modeId: "full"` (yolo approval mode).
   - Because `Supervisor` ran in OpenCode with `auto_accept: true`, `choke.onPermissionAsked` never fired: during the 23:25 live run, `Supervisor` (`07fbcf58`) wrote `.scratch/factory-e2e-smoke/smoke.mjs`, ran `pkill -9 -f "/Users/andrewpham/.paseo/plugin-process.js"` (killing the live plugin host process!), and modified `<stateDir>/projects/.../mailbox.jsonl` and `project.json` directly.

4. **Provider-Specific MCP & Tool Exposure Landmines Across `Pi`, `Antigravity` (`agy`), and `Codex`:**
   - **`antigravity` (`agy`):** Paseo's `AgentManager.requireExternalMcpSupport` (`app.asar` `@ 30400000`) checks `session.capabilities.supportsMcpServers === true` whenever `Object.keys(storedConfig.mcpServers ?? {}).length > 0`. Because `antigravity-provider` sets `supportsMcpServers: false`, injecting `config.mcpServers.paseo_factory` on an `antigravity` session causes Paseo to immediately close the session and throw `Provider 'antigravity' does not support MCP servers`.
   - **`pi` (`v1.3.0`):** Paseo's `mcpServerSchema` in `@getpaseo/plugin-sdk` (`app.asar` `@ 16620375`) uses `.strict()` and allows only `{ type: "stdio", command, args, env, alwaysLoad }` — rejecting Pi's `"exposure": "direct"` key if passed in `config.mcpServers`. Meanwhile, Pi `v1.3.0`'s `builtin:mcp` defaults registered servers without `"exposure"` to `"codemode"` (hiding MCP tools from direct model tool declarations) **unless** `<PI_CODING_AGENT_DIR>/mcp.json` defines the server with `"exposure": "direct"` (which takes precedence over `pi.registerMcpServer` at `dist/extensions/mcp/index.js:240-243` and inherits the Pi session's `process.env` via `StdioTransport` at `dist/transports/stdio.js:75`).
   - **`codex`:** As documented in `seatworks/plugin/mcp/team.mjs:14-27`, Codex filters the environment variables passed to stdio MCP subprocesses unless context is also passed via CLI `args` (or read from the parent process).

5. **Background Child Processes in `Gate` Could Hang `runGate` Indefinitely:**
   - Unlike `paseo-room` (`src/runtime-plugin/server/gate.ts:83-195`), `src/gate.ts` spawned the Gate shell without process-group reaping (`detached: true` + `process.kill(-pgid)` after exit), so any background child process that inherited `stdout`/`stderr` pipes prevented `runGate` from resolving.

## Decision

1. **Dual-Surface Role-Scoped Action Architecture (`paseo_factory` Stdio MCP Bridge `plugin/bin/bridge.mjs` + `factory` CLI) Backed by `CorrelationRegistry`.**
   - **Unforgeable `CorrelationRegistry` (`plugin/server/correlations.ts` & `<stateDir>/correlations.json`):**
     - Modeled on `paseo-room/src/runtime-plugin/server/correlations.ts`:
       1. In `server.before("agent.create")`, when creating a factory seat (`supervisor`, `lead`) or contracted working `Agent` (`agent`), issue a unique `correlationId` (`cor_<uuid>`) recording `{ correlationId, role, projectSlug, projectRoot, task?, issuedAt }` in memory and in `<stateDir>/correlations.json`.
       2. Inject `PASEO_FACTORY_CORRELATION: correlationId` into `env` (and into `bridge.mjs` CLI `args`).
       3. In `server.before("agent.session_open")`, read `input.config.env?.PASEO_FACTORY_CORRELATION` and associate `agentId` (`associate(correlationId, input.agentId)`) both in memory and in `<stateDir>/correlations.json`.
   - **Zero-Dependency Stdio MCP Bridge (`plugin/bin/bridge.mjs`, server name `paseo_factory`):**
     - Speaks standard MCP JSON-RPC 2.0 over stdio (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`) with both newline-delimited JSON and `Content-Length` framing support (matching `seatworks/plugin/mcp/team.mjs`).
     - Resolves identity from CLI `args` (`--correlation`, `--role`, `--state-dir`, `--project`, `--workspace`, `--task`), `process.env` (`PASEO_FACTORY_CORRELATION`, `PASEO_FACTORY_SEAT`, `PASEO_FACTORY_STATE_DIR`, `PASEO_AGENT_ID`), and `<stateDir>/correlations.json` (with parent-process `ps eww -o command= -p <ppid>` fallback for Codex).
     - **Strict Role-Scoped `tools/list` & `tools/call`:**
       - **`supervisor` role sees ONLY:**
         1. `supervisor_dispatch_lead` (`{ message: string }`) — dispatches an outcome directive to the Project's `Lead` mailbox and instructs `Supervisor` to end its turn immediately.
         2. `supervisor_accept_task` (`{ task: string, attempt: number }`) — accepts a green Attempt on the Owner's explicit word (`accepted_by: "supervisor"`).
         3. `factory_status` (`{}`) — returns the current structured Project `Ledger` & `Tasks` status summary.
       - **`lead` role sees ONLY:**
         1. `lead_set_contract` (`{ task: string, gate: string, artifact: string, base?: string, scope?: string, skills?: string[], freshEyes?: boolean, watch?: boolean }`) — registers or updates a `Task`'s `Contract`.
         2. `lead_spawn_agent` (`{ tasks: string[], provider?: string }`) — spawns contracted working `Agent`(s) in isolated `Task worktree`(s) and starts the deterministic Driver watcher in the background (or runs to verdict), returning the dispatch status so `Lead` never blocks or polls.
         3. `lead_accept_task` (`{ task: string, attempt: number }`) — accepts a green Attempt with no Fresh-eyes `CONCERN` (`accepted_by: "lead"`) and lands its commit into `<project-root>`.
         4. `lead_repoke_agent` (`{ task: string }`) — sends the single bounded `Re-poke` to a `Denial-stall`ed `Agent`.
         5. `lead_needs_human` (`{ task: string, reason: "denied-again" | "silent-after-repoke" | "attempt-ceiling" | "died-after-respawn", evidenceSeqs: number[], summary: string }`) — escalates an exhausted `Task` to `Needs-human`.
         6. `lead_report_to_supervisor` (`{ message: string }`) — delivers a completion or escalation report to the `Supervisor` mailbox (`to: "supervisor"`) and instructs `Lead` to end its turn immediately.
         7. `factory_status` (`{}`) — returns the current structured Project `Ledger` & `Tasks` status summary.
       - **`agent` (working `Agent`) role sees ONLY:**
         1. `agent_claim` (`{ task?: string, commit?: string }`) — resolves `HEAD` in the `Task worktree` when `commit` is omitted, submits the `Claim` (`claim_reported`), runs the `Contract`'s `Gate`, and returns the `Verdict` (`green` / `red`) and gate output.
         2. `agent_escalate_blocker` (`{ message: string }`) — reports an unresolvable environment/spec blocker to `Lead`'s mailbox (`to: "lead"`, `from: "peer"`, `kind: "needs_human"`).
       - **Outside Factory (`role` unset, e.g. a normal `antigravity` session):** `tools/list` exposes only `factory_dispatch_supervisor` (`{ workspace: string, message: string }`) and `factory_status` (`{ workspace?: string }`), keeping normal sessions clean.
   - **Provider-Aware MCP Injection:**
     - For `opencode`, `claude`, `codex`, `pi`, `copilot`, and `omp` (`provider !== "antigravity"`): `server.before("agent.create")` attaches `config.mcpServers.paseo_factory` using strictly Paseo-valid keys (`{ type: "stdio", command: process.execPath, args: [bridgePath, "--correlation", correlationId, "--role", role, "--state-dir", stateDir, "--project", projectSlug, "--workspace", cwd], env: { PASEO_FACTORY_CORRELATION: correlationId, PASEO_FACTORY_SEAT: role, PASEO_FACTORY_STATE_DIR: stateDir } }`).
     - For `pi`: `provisionPiAgentHome` (`src/pi-home.ts`) **always** writes `"paseo_factory"` into `<stateDir>/pi-agent/<role>/mcp.json` with `"exposure": "direct"` so Pi `v1.3.0`'s `builtin:mcp` declares `mcp__paseo_factory__*` tools directly to the model instead of hiding them behind `codemode`.
     - For `antigravity` (`agy`): `server.before("agent.create")` **never** adds `config.mcpServers` (avoiding Paseo's `requireExternalMcpSupport` crash); instead, plugin startup auto-provisions `~/.gemini/config/plugins/paseo-factory/{plugin.json,mcp_config.json,hooks.json}` so `antigravity` loads `paseo_factory` MCP natively and inherits `PASEO_FACTORY_*` from `options.config.env`.
   - **Retained `factory` CLI (`<stateDir>/bin/factory`):**
     - Kept 100% compatible over the same Spool and `CorrelationRegistry` for human CLI usage, `/factory` slash commands, and bash fallback.

2. **Strict Paseo Hook Return Schema & 2-Step Workspace-Bound Seat Launch with Deterministic `Seat kickoff packet` (`Project preflight`).**
   - **`server.before("agent.create")` Hook Return Invariant:**
     - `server.before("agent.create")` in `plugin/index.server.ts` **never** returns `labels` (returning only `{ config, env }`), eliminating Paseo's `Unrecognized key: "labels"` Zod failure permanently.
   - **2-Step Seat Launch (`ensureSeat`):**
     - Step 1: Create the seat inside the `Project`'s Paseo `workspaceId` (`createAgentInWorkspace(workspaceId, ...)` with `parent: supervisorId` for `Lead`) **without** an initial prompt, then verify from the daemon snapshot that `agent.status !== "error"` and `realpathSafe(agent.cwd) === realpathSafe(project.root)`.
     - Step 2: When `drainSupervisorMailbox` or `drainLeadMailbox` delivers the first turn to a seat (or after seat creation/rotation), wrap the mail batch in a deterministic **`Seat kickoff packet`** (`buildSeatKickoffPacket` in `src/preflight.ts`):
       - **Project Identity & Git State:** `project.slug`, `project.root`, current git branch, `HEAD` short SHA, and `git status --porcelain` summary.
       - **Detected Verification Commands (`package.json` / repo scripts):** Exact `scripts` from `<project-root>/package.json` (highlighting `test`, `typecheck`, `lint`, `build`) or top-level Makefile/Cargo/Go/Python markers so `Lead` can write accurate `Gate` commands immediately without guessing.
       - **Repository Layout Snapshot:** Top-level files and directories (up to 40 entries, excluding `node_modules` and `.git`) plus presence of `AGENTS.md`, `CONTEXT.md`, `GLOSSARY.md`, and `.scratch/`.
       - **Active Factory State:** Summary of current `Ledger` tasks (`contracted`, `running`, `green`, `red`, `accepted`, `needs-human`) and active `Lane config`.
       - **Role Action Guide:** Explicit reminder to call the `paseo_factory` MCP tools (`supervisor_dispatch_lead` / `lead_set_contract` / `lead_spawn_agent` / `lead_report_to_supervisor`) and end the turn immediately after dispatching.

3. **3-Layer Execution Fence Across All 7 Providers (`opencode`, `claude`, `codex`, `pi`, `copilot`, `omp`, `antigravity`).**
   - **Layer 1 — Provider-Native Harness & `providerOptions` / `modeId` / `featureValues` Lock (injected in `server.before("agent.create")` & `pi-home.ts`):**
     - **`opencode`:**
       - For `supervisor` and `lead`: force `featureValues: { ...config.featureValues, auto_accept: false }`, set `modeId: "plan"` for `supervisor` (and `"build"` for `lead`), and set `providerOptions: { ...config.providerOptions, permission: { edit: "deny", task: "deny" } }` (using Paseo's `OpenCodeProviderOptionsSchema` to disable file edits and OpenCode subagents inside the OpenCode server itself).
       - For `agent`: set `providerOptions: { ...config.providerOptions, permission: { task: "deny" } }`.
     - **`claude` (`claude-code`):**
       - For `supervisor` and `lead`: set `providerOptions: { ...config.providerOptions, disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Task", "mcp__paseo__create_agent", "mcp__paseo__kill_agent", "mcp__paseo__archive_agent", "mcp__paseo__send_agent_prompt", "mcp__paseo__update_agent"] }`.
       - For `agent`: set `modeId: "default"` and `providerOptions: { ...config.providerOptions, disallowedTools: ["Task", "mcp__paseo__create_agent", "mcp__paseo__kill_agent", "mcp__paseo__archive_agent", "mcp__paseo__send_agent_prompt", "mcp__paseo__update_agent"] }`.
     - **`codex`:**
       - For `supervisor` and `lead`: set `modeId: "auto"` (routing `fileChange` and `commandExecution` approvals through `choke.onPermissionAsked` instead of `"full-access"`) and `providerOptions: { ...config.providerOptions, features: { multi_agent_v2: false } }`.
       - For `agent`: set `providerOptions: { ...config.providerOptions, features: { multi_agent_v2: false } }`.
     - **`pi`:**
       - In `src/pi-home.ts` (`writeSettingsJson`): for `role === "supervisor" || role === "lead"`, set `settings.defaultTools = ["read", "bash", "grep", "find", "ls"]` (removing `edit` and `write` tools from Pi's tool registry).
     - **`copilot`:**
       - For `supervisor` and `lead`: set `featureValues: { ...config.featureValues, auto_accept: false }` and `modeId: "https://agentclientprotocol.com/protocol/session-modes#plan"` (for `supervisor`) or `"https://agentclientprotocol.com/protocol/session-modes#agent"` (for `lead`).
     - **`omp`:**
       - For `supervisor` and `lead`: set `modeId: "write"` (requiring permission approval for any write tool call).
     - **`antigravity` (`agy`):**
       - Auto-provision `~/.gemini/config/plugins/paseo-factory/{plugin.json,mcp_config.json,hooks.json}` pointing `PreToolUse` (`write_file|edit_file|run_command`) to `<stateDir>/bin/agy-pre-tool-hook.mjs`.
       - When `PASEO_FACTORY_SEAT` is unset (normal `agy` use), the hook exits in <5ms with `{"decision": "allow"}`.
       - When `PASEO_FACTORY_SEAT` is `"supervisor"` or `"lead"`, the hook denies `write_file`/`edit_file` outside `SEAT_MEMORY_WHITELIST` and denies destructive/forbidden shell commands (`{"decision": "deny", "reason": "..."}`).
       - When `PASEO_FACTORY_SEAT` is `"agent"`, the hook enforces the `Contract`'s `--scope` glob and blocks writes to `<stateDir>`.
   - **Layer 2 — Paseo `Choke policy` (`server.before("agent.permission_asked")` in `plugin/server/choke.ts`):**
     - Intercepts permission requests for `Supervisor`, `Lead`, dispatcher sessions, and working `Agent`s:
       - Denies any direct call to Paseo's native agent-management tools (`create_agent`, `kill_agent`, `archive_agent`, `send_agent_prompt`, `update_agent`, `paseo_create_agent`, `paseo_kill_agent`, `paseo_send_agent_prompt`, `mcp__paseo__*`) with rule `"seat-paseo-tool-fence"`.
       - Denies any file write or bash mutation by `Supervisor` or `Lead` targeting `<project-root>` outside `SEAT_MEMORY_WHITELIST` or targeting `<stateDir>/{projects,ledger.jsonl,correlations.json}` directly (`"seat-write-fence"`).
       - Auto-allows safe read, bash, and `paseo_factory` MCP tool calls so `modeId: "auto"` / `auto_accept: false` seats run 100% unattended without blocking on human permission cards!
   - **Layer 3 — OS `PATH` Shims in `<stateDir>/bin` (`git`, `pkill`, `kill`, `killall`, `paseo`, `gh`):**
     - `git` shim (`plugin/bin/git` & `src/shim.ts`): blocks destructive git commands globally, blocks `commit`/`merge`/`rebase`/`cherry-pick`/`checkout -b`/`switch -c`/`reset`/`clean`/`stash` for `supervisor` (`supervisor-git-fence`), and blocks `lead` from committing product source files outside `SEAT_MEMORY_WHITELIST` (`lead-git-fence`).
     - Process & daemon protection shims (`pkill`, `kill`, `killall`, `paseo`, `gh` in `<stateDir>/bin`): when `PASEO_FACTORY_SEAT` is set (`supervisor`, `lead`, or `agent`), `pkill`/`kill`/`killall` refuse any argument targeting `paseo`, `plugin-process`, `opencode`, or daemon PIDs; `paseo` shim refuses direct `paseo agent` / `paseo plugin` mutations; and `gh` shim refuses `gh pr merge` / `gh repo delete` / `gh release` from non-Owner seats.

4. **Process-Group Reaping in `Gate` (`src/gate.ts`).**
   - `runGate` spawns `sh -c <gateCommand>` with `detached: process.platform !== "win32"` (its own process group `pgid = child.pid`).
   - Whenever the Gate child exits or times out, `runGate` terminates any remaining descendant processes in `-pgid` (`SIGTERM` followed by a bounded `SIGKILL` grace) before awaiting stream closure (`stdout`/`stderr` `close`), guaranteeing that background child processes spawned during a test never hang `runGate`.

5. **3-Tier Automated Verification Suite.**
   - **Tier 1 (Unit & Schema Contract Tests):** Verify `CorrelationRegistry`, `bridge.mjs` MCP `tools/list` & `tools/call` per role, `Seat kickoff packet` (`buildSeatKickoffPacket`), provider-specific `agent.create` transformations across all 7 providers (`opencode`, `claude`, `codex`, `pi`, `copilot`, `omp`, `antigravity`), strict `{ config, env }` hook return shape, `agy-pre-tool-hook.mjs`, PATH shims (`git`, `pkill`, `paseo`), and `runGate` process-group reaping.
   - **Tier 2 (Full SLP Lifecycle Integration Test):** End-to-end mocked-daemon lifecycle test exercising `Owner -> Supervisor (supervisor_dispatch_lead via MCP) -> Lead (kickoff packet + lead_set_contract + lead_spawn_agent via MCP) -> Agent (agent_claim via MCP -> Gate -> Verdict green) -> Lead (lead_accept_task + lead_report_to_supervisor via MCP) -> Supervisor`, plus negative tests proving `Supervisor` and `Lead` are blocked at all 3 layers from editing product code, calling `paseo_create_agent`, or running `pkill plugin-process.js`.
   - **Tier 3 (Trial-Daemon `~/.paseo-factory` Smoke Verification):** Live plugin load and smoke verification against `~/.paseo-factory`.

## Consequences

- `CONTEXT.md` updates **Supervisor**, **Lead**, **Agent**, **Choke policy**, **Seat write fence**, **Git shim**, and **Pi harness home**, and adds **Role-scoped MCP bridge**, **Correlation token**, and **Seat kickoff packet**.
- `Supervisor`, `Lead`, and `Agent` seats across all 7 Paseo providers receive first-class role-scoped MCP tools (`paseo_factory`) and deterministic `Seat kickoff packet` context while being mechanically fenced at 3 independent layers.
