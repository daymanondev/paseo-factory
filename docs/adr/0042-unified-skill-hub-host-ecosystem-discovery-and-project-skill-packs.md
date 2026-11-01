# 0042 — Unified Skill Hub, Cross-Ecosystem Host Discovery, Official Expo Skill Pack, and Per-Project Role Skill Scoping

- **Date:** 2026-11-01
- **Status:** Accepted — Owner confirmed Q1 Option A, Q2 Option A, and Q3 Option A during `/grill-with-docs`.
- **Amends:** ADR 0032 (`SCRUM_ROLE_SKILLS` hardcoding in `provisionScrumHarness` and `scopeScrumCapabilities`), ADR 0036 (`Companion tool` single-card rendering and `checkCompanionToolsUpdates` `repoCommitSha`-only check), and ADR 0039 (`Helper MCP catalog` discovery and role skill parity).

## Context

An audit of the host machine (`research/skills-inventory-role-matrix-and-expo-skills.md`) revealed four operational bottlenecks in how `paseo-factory` manages, discovers, updates, and distributes skills across roles and harnesses:

1. **Opaque Single-Card Skill Surface & False `Up to date` Status:**
   - `buildCompanionToolsView()` in `plugin/server/surface-rpc.ts` collapsed all 32 skills in `~/.agents/skills/` into one `Factory Core Skill Pack` card (`v31.0.0`), leaving the Owner unable to see which individual skills exist on the host, which ecosystem they came from, which skills are outdated, or which Factory roles receive them.
   - `checkCompanionToolsUpdates()` in `src/scrum/companion-tools.ts` checked `entry?.repoCommitSha` in `~/.agents/.skill-lock.json`. Because `npx skills` records `skillFolderHash` (Git tree SHA) and omits `repoCommitSha`, `checkCompanionToolsUpdates()` evaluated `if (recordedCommit && ...)` as `false` and reported `updateAvailable: false` even when 16 of 27 skills (including 6 Core Factory Skills) were outdated against `mattpocock/skills@HEAD`.
2. **Siloed Host Plugin & Skill Ecosystems (`Claude`, `Codex`, `Antigravity`, `ZCode`, `Pi`):**
   - Each coding harness on the host maintains its own rich plugin/skill catalog and cache:
     - **Claude Code:** `~/.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json` (222 official plugins), `anthropic-agent-skills`, `installed_plugins.json`, and `~/.claude/skills/`.
     - **OpenAI Codex:** `~/.codex/plugins/cache/{openai-bundled,openai-curated,openai-curated-remote,openai-primary-runtime}/` (where an older `expo@1.0.2` snapshot sat invisible to other harnesses) and `~/.codex/skills/`.
     - **Antigravity:** `~/.gemini/config/plugins/*` (`firebase`, `science`, `chrome-devtools-plugin`, `modern-web-guidance-plugin`, `interview-prep` — 36 skills + MCP configs) and `~/.gemini/antigravity/builtin/skills/`.
     - **ZCode:** `https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json`, extracted 3D game plugins, and `~/.zcode/skills/` (where the Owner's custom `asc-iap` App Store Connect IAP skill lived in isolation).
     - **Pi:** `~/.pi/agent/skills/` (holding 6 local-only skills and missing 5 `~/.agents/skills` symlinks).
   - Previously, the Owner had to open each tool separately to inspect or import skills, and symlink drift accumulated across `~/.pi/agent/skills`, `~/.claude/skills`, `~/.gemini/config/skills`, `~/.codex/skills`, and `~/.zcode/skills`.
3. **Missing Official Expo Skill Pack (`expo/skills` v1.14.3):**
   - Upstream `https://github.com/expo/skills.git` (`HEAD` `v1.14.3`) provides 23 stable skills in `plugins/expo/skills/` (16 `expo-*` framework skills led by the `expo-overview` router skill, plus 7 `eas-*` service skills), 1 experimental skill (`expo-migrate-module` in `plugins/expo-experiments/skills/`), and the official remote MCP server (`https://mcp.expo.dev/mcp` in `plugins/expo/.mcp.json`). None of the 24 skills were installed in `~/.agents/skills`.
4. **Scrum Specialist Skill Lockout vs. Unscoped Context Bloat:**
   - In `Agile Scrum` mode, `provisionScrumHarness` and `scopeScrumCapabilities` (`src/scrum/harness.ts`) hardcoded `settings.skills` (Pi) and `permission.skill` (OpenCode) to `SCRUM_ROLE_SKILLS[role]`, ignoring both `Contract.skills` and domain packs like `expo/skills`. As a result, `UX`, `Architect`, `Dev`, and `QA` were blocked from reading `expo-*` or `eas-*` skills even when contracted for an Expo project.
   - Conversely, importing every specialized pack (such as 28 `science` bioinformatics skills and 24 `expo` skills) unconditionally into every Project's `<available_skills>` pollutes agent context windows on unrelated Projects.

## Decision

### 1. Declarative Skill Packs (`CORE_SKILL_SOURCES` + `EXPO_SKILL_SOURCES`), Git Tree SHA Tracking, and 5-Harness Symlink Healing

- **Official Skill Packs (`src/scrum/companion-tools.ts`, `plugin/shared/companions.ts`):**
  - Keep `factory-skills-pack` (`CORE_FACTORY_SKILLS`, 11 required core skills) as the mandatory `Companion tool` guarded by the Prerequisite Setup Gate.
  - Add **`EXPO_SKILL_SOURCES`** (`expo-skills-pack`, canonical source `https://github.com/expo/skills.git`) covering all **24 official Expo skills**:
    - 23 stable skills from `plugins/expo/skills/*` (`expo-overview`, `expo-project-setup`, `expo-app-design`, `expo-router-data-fetching`, `expo-networking`, `expo-tailwind-setup`, `expo-local-first`, `expo-api-routes`, `expo-dom-components`, `expo-native-ui`, `expo-ui-swift-ui`, `expo-ui-jetpack-compose`, `expo-dev-client`, `expo-debugging`, `expo-module`, `expo-sdk-upgrade`, `eas-overview`, `eas-project-setup`, `eas-build`, `eas-update`, `eas-deployment`, `eas-hosting`, `eas-workflows`).
    - 1 experimental skill from `plugins/expo-experiments/skills/expo-migrate-module` (`expo-migrate-module`).
- **Git Tree SHA (`skillFolderHash`) & Accurate Update Detection:**
  - During `installOrUpdateFactorySkillPack` and `installOrUpdateSkillPack`, compute each skill directory's Git tree SHA via `git rev-parse HEAD:<skillPath>` (falling back to content SHA-1 only when outside a Git checkout) alongside `git rev-parse HEAD` (`repoCommitSha`), persisting both in `~/.agents/.skill-lock.json` (`version: 3`).
  - Fix `checkCompanionToolsUpdates` so that a skill whose lock entry is absent, omits `repoCommitSha`, or differs from remote `HEAD` (`git ls-remote <sourceUrl> HEAD`) is flagged with `updateAvailable: true` rather than silently skipped.
- **5-Harness Symlink Healing (`ensureProviderSkillSymlinks`):**
  - Reconcile symlinks from `~/.agents/skills/<name>` into `~/.pi/agent/skills`, `~/.claude/skills`, `~/.gemini/config/skills`, and (when the parent harness home exists on disk) `~/.codex/skills` and `~/.zcode/skills`, replacing stale duplicate directories when `~/.agents/skills/<name>` is canonical and pruning retired `impeccable*` entries across all five harnesses.

### 2. Unified `Skill Hub` & Read-Only Cross-Ecosystem Discovery (`SkillHubCard` on `Plugins` Tab)

- Introduce `inspectSkillHub(options)` in `src/scrum/companion-tools.ts` and render `SkillHubCard` (`plugin/client/factory/skill-hub.tsx`) on the `Plugins` tab with three views:
  1. **`Installed in Factory (N)` (`~/.agents/skills/*`):**
     - Displays every installed skill with its pack badge (`Core`, `Expo & EAS`, `Workflow`, `Custom`), source repository, short revision (`skillFolderHash` / `repoCommitSha`), freshness pill (`Up to date`, `Update available`, `Local`), 5-harness symlink count, and **Role Matrix pills** (`Sup`, `Lead`, `Peer`, `PM`, `UX`, `Arch`, `Dev`, `QA`).
     - Provides 1-click **`Install / Update Expo Pack (24)`**, **`Update Core & Tracked Skills`**, and **`Heal Symlinks`**.
  2. **`Available on Host (M)` (Read-Only Scanner across Claude, Codex, Antigravity, ZCode, Pi):**
     - Scans host directories read-only without mutating external tool state:
       - `~/.gemini/config/plugins/*` & `~/.gemini/antigravity/builtin/skills/*` (`Antigravity` plugins & skills, marking native sidecars with `IDE Sidecar` and bundled MCPs with `MCP`).
       - `~/.codex/plugins/cache/*/*/*` & `~/.codex/skills/*` (`Codex` cached plugins and skills).
       - `~/.claude/plugins/installed_plugins.json`, `~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json`, and `~/.claude/skills/*` (`Claude` installed plugins, official marketplace skill packs, and local skills).
       - `~/.zcode/skills/*` & `~/.zcode/plugins/*` (`ZCode` custom skills like `asc-iap` and extracted 3D packs).
       - `~/.pi/agent/skills/*` (`Pi` local-only skills).
     - Exposes 1-click **`+ Import to Factory`** (`factory.skills.import`) to copy any discovered local skill or plugin skill pack into `~/.agents/skills/`, record its provenance in `.skill-lock.json`, link it across all 5 harnesses, and include it in `Private vault` sync.
  3. **`Role ↔ Skill Matrix`:**
     - Shows each `SLP` (`Supervisor`, `Lead`, `Peer`) and `Agile Scrum` (`Supervisor`, `Scrum Lead`, `PM`, `UX`, `Architect`, `Dev`, `QA`) role alongside the exact list of skills provisioned to that role for the active Project.

### 3. Per-Project Skill Packs, Auto-Detection (`expo`), and Scrum `Contract.skills` Unlock

- **Per-Project Skill Packs (`Project skill pack`):**
  - Define domain skill packs (`expo`, `firebase`, `zcode-3d`, `science`, `custom`).
  - Auto-detect the `expo` pack whenever `<project-root>/package.json` declares `"expo"` or `"react-native"` (in `dependencies`, `devDependencies`, or `peerDependencies`) or `<project-root>/app.json` contains an `"expo"` root key, and allow explicit per-Project pack overrides in `<projectStateDir>/execution.json` (`skillPacks?: string[]`) toggled via `factory.skills.togglePack` on `SkillHubCard`.
- **Role ↔ Skill Scoping Law (`src/pi-home.ts`, `src/scrum/prompts.ts`, `src/scrum/harness.ts`, `plugin/server/roles.ts`):**
  - **OpenCode `Supervisor` Parity:** Expand OpenCode `Supervisor` `permission.skill` in `plugin/server/roles.ts` and `src/scrum/harness.ts` to include `"grill-with-docs": "allow"`, `"research": "allow"`, and `"factory": "allow"` alongside `"grilling": "allow"` and `"domain-modeling": "allow"`.
  - **Scrum Specialist Unlock (`provisionScrumHarness` & `scopeScrumCapabilities`):**
    - Merge `SCRUM_ROLE_SKILLS[role]` + role-matched skills from active `Project skill pack`s (e.g. for `expo`: UI skills for `ux`, architecture/EAS skills for `architect`, all `expo-*` / `eas-*` / `asc-iap` skills for `dev`, debugging/build skills for `qa`, and overview routers `expo-overview` / `eas-overview` for `lead`) + any explicit `Contract.skills` recorded on the Task's `contract_set` event!
    - Apply the merged skill list identically to Pi (`settings.skills`), OpenCode (`providerOptions.permission.skill`), and the `Required role skills` prompt trailer.
    - Expand `scopeScrumCapabilities`'s allowed `helpers` regex for `agent` to permit `expo|supabase|firebase` alongside `context7|exa|search|research|vision|chrome|playwright|browser|open-design|open_design`.
- **`expo-mcp` in `Helper MCP catalog` (`src/helper-mcp-sync.ts`):**
  - Register `expo-mcp` (`url: "https://mcp.expo.dev/mcp"`, `transport: "http"`, `oauthRequired: true`, defaulting to `Local on Host` / `enabled: false` until the Owner clicks `+ Sync to Peer`) when Expo skills are installed on the host.

## Consequences

- The Owner can see every skill on the machine, its Git freshness (`skillFolderHash` / `repoCommitSha`), its 5-harness symlink state, and its exact Role assignment in one unified `Skill Hub` card on the `Plugins` tab.
- All 24 official `expo/skills` (`v1.14.3`), `asc-iap`, and updated `mattpocock/skills` live in `~/.agents/skills/`, replicate automatically to `andrews-mac-mini` via `Private vault`, and are automatically provisioned to `Lead`, `SLP Peer`, and `Agile Scrum` specialists (`UX`, `Architect`, `Dev`, `QA`) on Expo projects without bloating unrelated projects.
