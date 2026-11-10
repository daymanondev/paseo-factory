# 0055 — Retire `zcode-acp` Execution Harness in Favor of Pi Agent over Local `zcode-api` Proxy (`pi/zcode/*`)

- **Date:** 2026-11-10
- **Status:** Accepted — Owner confirmed Q1–Q3 in `/grill-with-docs` ("theo bạn khuyến nghị").
- **Supersedes:** [ADR 0046](0046-zcode-acp-harness-integration-clean-room-home-and-token-metering.md) (retires `zcode-acp-server`, `Zcode harness home` / `src/zcode-home.ts`, `extractZcode` SQLite token metering, and `zcode` role-provider / CLI / worktree-skill-deny paths).
- **Amends:** [ADR 0009](0009-lane-config-and-surface-mvp.md) & [ADR 0026](0026-per-project-lane-isolation-and-lane-profiles.md) (updates `DEFAULT_LANE` to `"pi/zcode/glm-5.3"` and adds canonical migration of legacy `zcode/*` and `pi/zai/glm-*` lanes) · [ADR 0042](0042-unified-skill-hub-host-ecosystem-discovery-and-project-skill-packs.md) (removes `~/.zcode/skills` from active harness symlink targets while retaining read-only host ecosystem discovery) · [ADR 0043](0043-plugin-owned-multi-provider-token-metering-and-project-usage-rollup.md) (consolidates GLM token metering onto Pi's incremental JSONL `extractPi` reader).

## Context

`ADR 0046` introduced a dedicated `zcode` execution harness (`zcode-acp-server@0.82.1` + `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`) solely because ZCode Desktop's +150% GLM Coding Plan quota, HighSpeed acceleration cards, Endpoint Routing (`ultra-zai`), and Client Request Signing V4 (`X-Client-Sig` Ed25519 + PoW) were locked inside `zcode.cjs`. Running `zcode.cjs` as an agent harness required maintaining an entire parallel execution stack inside `paseo-factory`:
- Clean-room `ZCODE_STORAGE_DIR` and `ZCODE_SESSION_DB_PATH` isolation (`src/zcode-home.ts`) to prevent `SQLITE_BUSY` across concurrent seats and Peers while keeping `HOME` and `ZCODE_HOME` un-isolated for `~/.zcode/v2/credentials.json` decryption;
- Worktree-level `.zcode/config.json` skill-deny mutations (`denyFactorySkillInWorktree`, ADR 0050 Decision 6) because `zcode.cjs` ignored `<roleHome>/config.json` skill rules;
- Custom `builtin:zai-coding-plan\GLM-5.3` backslash model ID normalization (`normalizeZcodeRuntimeModelId`, `stripZcodeProviderPrefix`) and `ROLE_SYSTEM.md` workarounds for Paseo `ACPAgentSession`;
- Incremental SQLite `extractZcode` metering with `~/.zcode/v2/acp-lazy-sessions.json` UUID translation.

Meanwhile, [`TriDefender/zcode-api`](https://github.com/TriDefender/zcode-api) (`v4.8.9`) reverse-engineered ZCode Desktop `v3.17.2`'s complete upstream wire protocol into a standalone local Bun HTTP proxy (`http://127.0.0.1:8318`), including:
1. Full **Coding Plan** (`{apiKey}.{secret}`) and **Start Plan** (`zcodejwttoken`) authentication stored in `~/.zcode-proxy/credentials.json`;
2. **Provider Endpoint Routing** (`/api/v1/agent/configs` → `zcode.z.ai/api/v1/ultra-zai/...` with `X-ZCode-Authorization`);
3. **Client Request Signing V4** (`/api/paas/c1f3a7e2/v2/client` Ed25519 + SHA-256 PoW handshake);
4. **HighSpeed Card Manager** (`/api/v1/highspeed/draw` automatic 1/s draw loop and `/api/v1/highspeed/anthropic/v1/messages` routing for `glm-5.3`);
5. Native **Anthropic Messages passthrough** (`POST /v1/messages`, preserving `thinking` blocks, `signature`, and `cache_read_input_tokens` with zero translation loss).

Connecting `Pi` (`~/.pi/agent/models.json`) to `zcode-api` under provider `"zcode"` (`"api": "anthropic-messages"`, `"baseUrl": "http://127.0.0.1:8318"`) with `glm-5.3` and `glm-5.3-flash`—and removing Pi's old direct `"zai"` login—delivers 100% of ZCode's upstream quota and HighSpeed benefits directly inside `Pi harness home` (`pi/zcode/glm-5.3`, `pi/zcode/glm-5.3-flash`), eliminating the need for `zcode-acp-server` and `zcode.cjs`.

## Decision

1. **Canonical GLM Lanes on Pi (`pi/zcode/glm-5.3` & `pi/zcode/glm-5.3-flash`) and Transparent Legacy Migration (Q1):**
   - `DEFAULT_LANE` in `src/lanes.ts` becomes `"pi/zcode/glm-5.3"`.
   - `migrateLegacyZcodeLane(value)` canonicalizes legacy lane strings on read and save across `lanes.json`, `profiles.json`, and `scrum-lanes.json`:
     - Any `"zcode/<model>[:<thinking>]"` lane (including `"zcode/builtin:zai-coding-plan\\GLM-5.3"` or case variants like `"zcode/GLM-5.3-Flash:high"`) maps to `"pi/zcode/<lowercase-model>[:<thinking>]"`.
     - Any `"pi/zai/glm-<rest>"` lane maps to `"pi/zcode/glm-<rest>"`.
2. **Retire `zcode-acp` Execution Harness & Clean Up `config.json` / `Skill hub` (Q2):**
   - Delete `src/zcode-home.ts` (and its vendored copy `plugin/server/core/zcode-home.ts`) and `test/zcode-home.test.ts`.
   - Remove `ZCODE_CJS_PATH`, `normalizeZcodeRuntimeModelId`, `stripZcodeProviderPrefix`, and the `case "zcode":` CLI runner branch from `src/lanes.ts`.
   - Remove `ZCODE_ACP_COMMAND`, `ensureBaseZcodeProvider`, and `zcodeBaseProvider` from `src/role-providers.ts`, and sweep any stale `"zcode"` entry from `<paseoHome>/config.json` `agents.providers` during `reconcilePaseoConfigObject` and `healFactoryRoleProvidersObject`.
   - Remove `zcode` env/worktree provisioning (`provisionZcodeHome`, `denyFactorySkillInWorktree`) and the `providerFamily === "zcode"` Layer-1 branch from `plugin/server/roles.ts`.
   - Remove `extractZcode` and `resolveZcodeNativeSessionId` from `src/usage-extractor.ts` (GLM sessions on `pi/zcode/*` are metered by `extractPi`).
   - Remove `ZCode` from `providerSkillDirectories` in `src/scrum/companion-tools.ts` so symlink health tracks the 4 active execution harnesses (`Pi`, `Claude`, `Antigravity`, `Codex`), while keeping read-only host discovery of `~/.zcode/skills` in `src/scrum/skill-hub.ts`.
3. **Host `zcode-api` Lifecycle via macOS `LaunchAgent` (Q3):**
   - `TriDefender/zcode-api` is installed at `~/.local/share/zcode-api` and supervised by `~/Library/LaunchAgents/com.zcode.proxy.plist` (`RunAtLoad: true`, `KeepAlive: true`) on `http://127.0.0.1:8318`, completely decoupled from Paseo daemon restarts.

## Consequences

- **Positive:** Drops ~1,100 LOC of ZCode-specific harness, SQLite metering, worktree `.zcode/config.json` exclude hacking, and backslash model-ID normalization while gaining ZCode 3.17.2's HighSpeed cards and Client Signing V4 on Pi's native `Pi harness home` (`APPEND_SYSTEM.md`, `mcp.json`, `settings.json` `skills` fence, and `extractPi` JSONL metering).
- **Negative / Trade-offs:** Host machines running `pi/zcode/*` lanes rely on the local `com.zcode.proxy` LaunchAgent (`127.0.0.1:8318`), managed identically to `cliproxy` (`127.0.0.1:8317`).
