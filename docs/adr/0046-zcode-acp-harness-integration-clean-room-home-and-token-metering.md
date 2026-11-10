# 0046 — First-Class `zcode` Harness Integration via `zcode-acp-server`, Clean-Room `ZCODE_STORAGE_DIR` Isolation, Compaction-Proof `ROLE_SYSTEM.md`, and SQLite `extractZcode` Token Metering

- **Date:** 2026-11-05
- **Status:** Superseded by [ADR 0055](0055-retire-zcode-acp-harness-for-pi-zcode-api-proxy.md) — `zcode-acp-server` and the `zcode` execution harness are retired in favor of running GLM Coding Plan models through Pi (`pi/zcode/glm-5.3`, `pi/zcode/glm-5.3-flash`) backed by the local `TriDefender/zcode-api` proxy (`com.zcode.proxy` LaunchAgent on `127.0.0.1:8318`).
- **Amends:** [ADR 0013](0013-lead-mailbox-context-rotation-and-role-contracts.md) (extends compaction-proof role contracts to `zcode` via `<roleHome>/ROLE_SYSTEM.md` and `instructions.userFile`) · [ADR 0016](0016-role-scoped-mcp-bridge-kickoff-packet-and-execution-fence.md) (extends the 3-layer `Seat write fence` and `Role-scoped MCP bridge` to `zcode`) · [ADR 0026](0026-per-project-lane-isolation-and-lane-profiles.md) (adds `zcode` as a first-class base harness alongside `pi`, `claude`, `codex`, `opencode`, `copilot`, and `antigravity`) · [ADR 0043](0043-plugin-owned-multi-provider-token-metering-and-project-usage-rollup.md) (adds `extractZcode` incremental SQLite token metering with `~/.zcode/v2/acp-lazy-sessions.json` UUID resolution).

## Context

Using GLM Coding Plan models (`GLM-5.3`, `GLM-5.3-Flash`, etc.) through ZCode Desktop's runtime (`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`) grants a **+150% Coding Plan quota bonus** compared to calling the Z.AI API through generic third-party harnesses such as Pi Agent (`pi/zai/glm-5.3`).

An empirical investigation of ZCode Desktop (`v3.17.2`, CLI `v0.17.1`), Paseo Desktop's ACP runtime (`ACPAgentClient` / `ACPAgentSession`), and the Paseo team's official ACP bridge repository (`william0wang/zcode-acp`, published on npm as `zcode-acp-server@0.82.1`) established the following facts:

1. **Why ZCode's +150% Quota Requires Running `zcode.cjs app-server --stdio`:**
   - `zcode.cjs` executes a 3-way authentication handshake for `account:zai-individual-coding-plan`:
     1. Decrypts `~/.zcode/v2/credentials.json` (`enc:v1:...` using `aes-256-gcm` with key `crypto.scryptSync("zcode-credential-fallback:${process.platform}:${os.homedir()}:${username}", "zcode-credential-salt-v1", 32)`).
     2. Requires `provider/updateAccountConfig` with a matching `basedOnZCodeBuiltinRevision` hash computed from `/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json` (which only remains stable when both `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` are injected into the child environment).
     3. Exchanges the OAuth token for a short-lived Coding Plan project token (`clientType: "zcode"`, `accountScope: "individual"`) and answers `interaction/requestProviderRuntimeHeaders` on every turn with `{ headersApplied: true, requestAuth: { apiKey, apiKeyId, accountScope: "individual" } }`.
2. **`zcode-acp-server@0.82.1` (`william0wang/zcode-acp`) Already Solves the ZCode Protocol v1 Bridge:**
   - Maintained directly by the Paseo core team (`william@10ln.com`, 356+ PRs, ~25k LOC TypeScript), `zcode-acp-server@0.82.1` implements the complete ZCode Protocol v1 NDJSON ↔ ACP JSON-RPC 2.0 translation for ZCode `v0.17.1` / App `v3.17.2`, including Node `--no-network-family-autoselection --dns-result-order=ipv4first` IPv4 prioritization, dynamic per-session `mcpServers` injection, `newSession` / `loadSession` / `unstable_resumeSession` (with `session/lifecycle/getState` eviction recovery), `session/set_mode` & `session/set_config_option` (`model`, `thought`, `mode`), `interaction/requestPermission` forwarding, `ZCODE_DISALLOWED_TOOLS`, `ZCODE_DYNAMIC_WORKFLOW_MODE=disabled`, occupancy-only `usage_update` (`used = projection.contextUsed`), and rate-limit `1308` (`model_rate_limited`) JSON-RPC error propagation.
3. **Five Concrete Integration Gaps Between `zcode-acp-server@0.82.1`, Paseo `ACPAgentSession`, and `paseo-factory`:**
   - **Gap 1 (Lazy Session UUID Mapping in SQLite):** `zcode-acp-server` returns a synthetic UUID (`acpSid`) on `session/new` and defers `session/create` until the first prompt, persisting `acpSid -> { cwd, zcodeSid: "sess_..." }` in `~/.zcode/v2/acp-lazy-sessions.json`. Paseo records `acpSid` as `agent.persistence.sessionId`, whereas ZCode's SQLite `message` table keys rows by `session_id = zcodeSid`.
   - **Gap 2 (`providerId\modelId` Backslash Format vs. Paseo Client Validation):** `zcode-acp-server` exposes model option values as `"builtin:zai-coding-plan\\GLM-5.3"`. Paseo's `ACPAgentSession.setModelWithSelection(modelId)` checks `option.options.some(c => c.value === modelId)` client-side before sending the RPC, rejecting short model IDs like `"GLM-5.3"` unless normalized.
   - **Gap 3 (Missing `config.systemPrompt` Forwarding in Paseo ACP):** Paseo's `ACPAgentSession` does not forward `config.systemPrompt` over ACP `session/new`. Without a harness-native instruction file, `zcode` seats would only see their SLP/Scrum role contract in Turn 1's user prompt, risking role amnesia after context compaction (`context_compaction`).
   - **Gap 4 (`HOME` / `ZCODE_HOME` Credential Key Coupling vs. Clean-Room Seat Isolation):** Replacing `HOME` breaks `scryptSync("${os.homedir()}")` decryption of `~/.zcode/v2/credentials.json`, and replacing `ZCODE_HOME` hides `$ZCODE_HOME/v2/credentials.json` from `zcode-acp-server`. Conversely, sharing a single `~/.zcode/cli/db/db.sqlite` across concurrent `Supervisor`, `Lead`, and parallel `Peer` (`Worker`, `Auditor`, `QA`) sessions risks `SQLITE_BUSY` lock contention and cross-seat plugin/history leakage.
   - **Gap 5 (`queryQuota()` Multi-Provider Ordering Noise):** When a user's `~/.zcode/v2/config.json` lists a custom provider (e.g. `custom:cliproxyapi`) before `builtin:zai-coding-plan`, `zcode-acp-server`'s internal quota poller sends the custom key to BigModel's quota endpoint unless `ZCODE_ACP_QUOTA_BOOT_NOTICE=0` and `ZCODE_ACP_QUOTA_AUTO_RESUME=0` are set.

## Decision

### 1. Use `zcode-acp-server@0.82.1` Directly as the `zcode` Base Provider (Q1 — Option 1A)

- Rather than authoring and maintaining a separate custom ACP bridge repository from scratch, `paseo-factory` adopts the official `zcode-acp-server` package (`npx -y zcode-acp-server@0.82.1`) as the runtime command for the `"zcode"` base provider in `<paseoHome>/config.json`.
- `src/role-providers.ts` automatically registers and heals the `"zcode"` provider entry in `<paseoHome>/config.json` (`extends: "acp"`, `command: ["npx", "-y", "zcode-acp-server@0.82.1"]`) whenever any SLP or Scrum lane uses `zcode/...` or when ZCode Desktop (`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`) is present on the host, injecting default factory-safe environment variables:
  - `ZCODE_DYNAMIC_WORKFLOW_MODE: "disabled"` (disables ZCode's internal subagent/workflow tools so `Supervisor`, `Lead`, and `Peer` strictly obey `paseo-factory` orchestration)
  - `ZCODE_ACP_QUOTA_AUTO_RESUME: "0"` (defers 5h quota parking and auto-resume exclusively to `paseo-factory`'s `QuotaParkRuntime`)
  - `ZCODE_ACP_QUOTA_BOOT_NOTICE: "0"` (prevents boot quota notice noise on multi-provider `~/.zcode/v2/config.json` setups)

### 2. Clean User-Facing `zcode/<model>:<effort>` Lanes with Automatic Runtime Model Normalization (Q2)

- Users and `Lane profile`s configure ZCode lanes using standard `paseo-factory` syntax:
  - `zcode/GLM-5.3:high`, `zcode/GLM-5.3:max`, `zcode/GLM-5.3-Flash:medium`, etc.
- `src/lanes.ts` and `plugin/server/roles.ts` provide bidirectional normalization (`normalizeZcodeRuntimeModelId` / `formatZcodeDisplayModelId`):
  - Bare model names (`GLM-5.3`, `glm-5.3`, `GLM-5.3-Flash`) are normalized to `"builtin:zai-coding-plan\\GLM-5.3"` (or preserved if an explicit `"<providerId>\\<modelId>"` prefix is already supplied) when writing `models` catalogs in `role-providers.ts` and when rewriting `config.model` in `server.addHook("agent.create.before")`, satisfying Paseo's client-side `option.options.some(choice => choice.value === modelId)` check and overriding any `custom:*` provider ordering in `~/.zcode/v2/config.json`.
  - Effort suffixes (`:low`, `:medium`, `:high`, `:max`) map to `thinkingOptionId` (`thought` config option on `zcode-acp-server`).
- For headless, tool-less single-shot passes (`Watch`, `Retro`, and legacy `Fresh-eyes review`), `laneCliInvocation` and `runLaneCli` in `src/lanes.ts` support `case "zcode":` by invoking `zcode.cjs -p --output-format json --thinking <effort>` with clean-room isolation.

### 3. Compaction-Proof Role Contracts via `<roleHome>/ROLE_SYSTEM.md` & `instructions.userFile` (Q3)

- Because Paseo's `ACPAgentSession` does not pass `config.systemPrompt` over ACP, `src/zcode-home.ts` writes the authoritative role contract (`ROLE_PROMPTS[role]` from `src/roles-contract.ts` for `supervisor`, `lead`, and `agent`, or the Scrum specialist contract in `scrum` mode) to `<roleHome>/ROLE_SYSTEM.md`.
- `src/zcode-home.ts` configures `instructions: { userFile: "<roleHome>/ROLE_SYSTEM.md", projectFile: "AGENTS.md" }` inside the isolated seat configuration so `zcode.cjs` reloads the role contract natively on every turn, across automatic context compactions (`context_compaction`), and across `session/resume`.

### 4. Clean-Room `Zcode harness home` (`src/zcode-home.ts`) & Per-Task SQLite Isolation (Q4)

- `src/zcode-home.ts` (`provisionZcodeHome`) provisions isolated storage directories under `<stateDir>/zcode-home/`:
  - Standing seats: `<stateDir>/zcode-home/supervisor`, `<stateDir>/zcode-home/lead`, `<stateDir>/zcode-home/headless`
  - Working `Agent` (`Peer`) sessions: per-Task isolated directories `<stateDir>/zcode-home/tasks/<project-slug>/<task>` (or `<stateDir>/zcode-home/agent` fallback) so parallel `Peer`s (`Worker`, `Auditor`, `QA`) never contend on a shared SQLite file (`SQLITE_BUSY`) or leak session history across Tasks.
- **Preserving `HOME` and `ZCODE_HOME` for Credential Decryption:**
  - `provisionZcodeHome` **never** overrides `HOME` or `ZCODE_HOME` (keeping them pointed at the real user home so `zcode-acp-server` and `zcode.cjs` derive the exact `scryptSync` key and locate `~/.zcode/v2/credentials.json` + `~/.zcode/v2/provider_config.json`).
  - Instead, isolation is enforced via `zcode.cjs`'s native storage environment variables:
    - `ZCODE_STORAGE_DIR: "<roleHome>"`
    - `ZCODE_SESSION_DB_PATH: "<roleHome>/db/db.sqlite"`
- **Skill Scoping:**
  - `Supervisor` symlinks `<userHome>/.zcode/skills` (preserving 100% of Owner skills).
  - `Lead` and `Peer` provision scoped skill directories excluding the Owner-only `factory` skill (merging active `Project skill pack`s and `Contract.skills` on `Peer` / Scrum roles, ADR 0039, ADR 0042 — **deferred past v0.0.94, see Errata 2**).

### 5. Three-Layer `Seat write fence` & `extractZcode` Incremental SQLite Token Metering (Q5)

1. **Three-Layer `Seat write fence` on `zcode`:**
   - **Layer 1 (Harness Tool Lock & Guarded Mode):** For `Supervisor` and `Lead` (and read-only Scrum roles `pm`, `ux` outside `mockups/`, `architect`, `qa` on product files), `provisionZcodeHome` and `applyProviderExecutionFence` (`plugin/server/roles.ts`) set:
     - `ZCODE_DISALLOWED_TOOLS: "Write,Edit,MultiEdit,NotebookEdit,DeleteFile"` (passed by `zcode-acp-server` into `session/create` `toolDenylist` and enforced at its permission gate)
     - `ZCODE_ACP_MODE: "guarded"` and `featureValues: { auto_accept: false }`, `modeId: "guarded"` so every `Bash` execution triggers `interaction/requestPermission` → Paseo `agent.permission_asked`.
     - For contracted `Peer` (`agent`) sessions in a `Task worktree`, `ZCODE_ACP_MODE: "guarded"` with `featureValues: { auto_accept: false }` routes asks through `Choke policy` (`plugin/server/choke.ts`), which auto-allows safe worktree edits and commands while blocking dangerous git operations and out-of-workspace writes.
   - **Layer 2 (`Choke policy` in `plugin/server/choke.ts`):** Recognizes ZCode's tool vocabulary (`Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `DeleteFile`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`) and enforces `seat-write-fence` and `seat-paseo-tool-fence` identically to `claude` and `pi`.
   - **Layer 3 (OS `PATH` Shims in `<stateDir>/bin`):** Prepends `<stateDir>/bin` to `PATH` so `git`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, `pkill`, `kill`, `killall`, `paseo`, and `gh` shims enforce `supervisor-git-fence`, `lead-git-fence`, and `memory-write-fenced`.
2. **Incremental SQLite Token Metering (`extractZcode` in `src/usage-extractor.ts`):**
   - Extends `UsageHarness` with `"zcode"`.
   - Resolves `acpSid -> zcodeSid` (`sess_...`) by reading `~/.zcode/v2/acp-lazy-sessions.json` whenever `sessionId` does not start with `"sess_"`.
   - Queries `<roleHome>/db/db.sqlite` (falling back to `~/.zcode/cli/db/db.sqlite`) via `node:sqlite` (`DatabaseSync`, `readOnly: true`):
     ```sql
     SELECT sequence, metadata FROM message
     WHERE session_id = ? AND role = 'assistant' AND sequence > ?
     ORDER BY sequence ASC
     ```
   - Extracts `metadata.usage` (`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `reasoningTokens`) into `paseo-factory`'s four disjoint additive buckets (`inputUncachedTokens = Math.max(0, inputTokens - cacheReadInputTokens - cacheCreationInputTokens)`, `cacheReadTokens = cacheReadInputTokens`, `cacheWriteTokens = cacheCreationInputTokens`, `outputTokens`, `totalTokens`), advancing `cursor.lastStepIdx = row.sequence` for `O(delta)` reads and feeding `contextWindowUsedTokens` into `Lead handoff` (`128k`) and `Peer handoff` (`160k`).

## Errata (recorded 2026-11-05, post-implementation review)

1. **`ZCODE_PROJECT_INSTRUCTION_FILES` does not exist in the runtime.** Decision 4 originally listed `ZCODE_PROJECT_INSTRUCTION_FILES: "AGENTS.md,CLAUDE.md,CONTEXT.md"` among `zcode.cjs`'s native storage env vars. Verified against the installed `zcode.cjs` (CLI 0.17.1, the same binary this ADR's other claims were verified against): the bundle reads 73 distinct `ZCODE_*` env vars and none is instruction-file related; instruction discovery uses a config-supplied `priorityFiles` list defaulting to exactly `["AGENTS.md"]` (workspace walk-up plus the user-scope `~/.zcode/AGENTS.md`), with no env override. Setting the key would be a dead env var on every seat, so `provisionZcodeHome` correctly never sets it; the line is struck from Decision 4. The `<roleHome>/config.json` `instructions.projectFile: "AGENTS.md"` wiring (Decision 3) matches the runtime's own project-file default; `CLAUDE.md`/`CONTEXT.md` discovery is not a runtime behavior and is not provided.
2. **Project skill pack / `Contract.skills` merging on `zcode` `Peer` / Scrum roles is deferred.** Decision 4's skill-scoping parenthetical promised Pi-parity pack merging (the `scopeScrumCapabilities` channel, ADR 0039 / ADR 0042). The v0.0.94 implementation contract (`.scratch/factory-v0.0.94/spec.md` §1, last bullet) deliberately scoped zcode seats to the operator `~/.zcode/skills` tree — `supervisor` whole, `lead` / `agent` scoped minus the Owner-only `factory` — and that is what shipped; no zcode-side pack channel exists yet. ADR 0047 ("Lead Context-Budget Hygiene … Peer-Owned Domain Skills", accepted 2026-11-05) independently re-grounds skill delivery harness-agnostically (`Peer` discovers `<available_skills>` natively; the pack hint rides the spawn prompt; `Lead` reads no `SKILL.md` at all), which lowers the value of a provisioner-side merge. Tracked as `.scratch/factory-v0.0.94/issues/06-zcode-scrum-skill-pack-channel.md`.

## Consequences

- `CONTEXT.md` adds **Zcode harness home** and updates **Supervisor**, **Lead**, **Seat write fence**, **Meter**, **Role provider**, **Helper MCP catalog**, **Role-scoped MCP bridge**, **Lead handoff**, and **Peer handoff** to include `zcode`.
- `paseo-factory` can run any or all SLP and Agile Scrum seats (`Supervisor`, `Lead`, `Peer`, `PM`, `UX`, `Architect`, `Dev`, `QA`, `Watch`, `Retro`) on `zcode/GLM-5.3:<effort>` with full +150% ZCode Coding Plan quota, zero third-party repo maintenance burden, 3-layer write fencing, compaction-proof role contracts, and exact SQLite token metering.
