# 0036 — Companion Tools, Skill Pack Vault Sync, Provider Symlinks, and Impeccable Pre-Spawn Auto-Provisioning

- **Date:** 2026-10-31
- **Status:** Accepted
- **Amends:** ADR 0012, ADR 0014, ADR 0034
- **Preserves:** ADR 0001–0035

## Context

In `ADR 0034`, `pbakaus/impeccable` (`v4.8.0+`) was adopted as the mechanical anti-slop and visual-quality detector gate for Scrum `UX`, `Dev`, and `QA` specialists (`impeccable detect --json --no-advisory`). However, `provisionImpeccable` (`src/scrum/impeccable.ts`) previously assumed `<userHome>/.agents/skills/impeccable` had already been manually installed on each host machine, and did not reconcile provider skill symlinks (`~/.pi/agent/skills`, `~/.gemini/config/skills`, `~/.claude/skills`).

When a new machine (such as a remote Mac Mini or a fresh developer laptop) ran a Scrum project before `impeccable` was installed — or when `impeccable` was installed after a specialist's `roleHome` was already provisioned — `UX`/`Dev`/`QA` specialists spawned without `<roleHome>/skills/impeccable` linked, and Pi / Claude / Gemini harnesses lacked symlinks to `<userHome>/.agents/skills/*`. Furthermore, the Owner's core Factory skill pack (`~/.agents/skills/`) was not synchronized across machines by `Private vault` (`factory-vault`), and there was no visibility or 1-click install/update surface for host `Companion tool`s in Paseo Desktop's `Plugins` tab.

## Decision

### 1. Declarative `Companion tool` Catalog (`impeccable` + `factory-skills-pack`)

Define a first-class **`Companion tool`** domain concept (`COMPANION_TOOLS_CATALOG` in `plugin/shared/companions.ts`) alongside Paseo daemon `Companion plugin`s (`COMPANION_CATALOG`):
- **`impeccable`** (`Impeccable UI Detector & Skill Pack`, canonical source `npx:impeccable@latest`, minimum version `4.8.0`): Upstream `pbakaus/impeccable` self-contained Rust/Wasm visual anti-slop detector CLI (`scripts/impeccable`), `SKILL.md` playbooks, and UI PostToolUse design hook.
- **`factory-skills-pack`** (`Factory Core Skill Pack`, canonical source `vault:config/skills`, minimum 10 core skills): The shared `<userHome>/.agents/skills` workflow library (`tdd`, `diagnosing-bugs`, `codebase-design`, `frontend-design`, `web-design-guidelines`, `code-review`, `grilling`, `domain-modeling`, `grill-with-docs`, `factory`) synchronized via `Private vault` and symlinked into all provider skill directories.

### 2. Single Source of Truth at `<userHome>/.agents/skills` & Provider Symlink Reconciliation

Standardize `<userHome>/.agents/skills/<skillName>` as the single host directory for all shared skills and `impeccable*` directories. Whenever `ensureProviderSkillSymlinks(userHome)` runs (after `impeccable` install/update, after `Private vault` hydration/sync, or during `provisionImpeccable`):
- Ensure every skill directory in `<userHome>/.agents/skills/*` is symlinked into:
  - `<userHome>/.pi/agent/skills/<skillName>`
  - `<userHome>/.claude/skills/<skillName>`
  - `<userHome>/.gemini/config/skills/<skillName>` (unless `<userHome>/.gemini/config/skills` is already a directory symlink pointing directly to `<userHome>/.agents/skills`).
- Preserve each Scrum specialist's isolated `<roleHome>/skills` allowlist (`!<all>`, plus only the role's permitted skills in `SCRUM_ROLE_SKILLS[role]`).

### 3. Split Distribution Strategy: Pure-Markdown Skills in `Private vault` vs. Upstream Binary Installer for `impeccable`

- **Pure-Markdown Skills via `Private vault` (`config/skills/<skillName>/...`):**
  - `collectLocalStateIntoRuntime(paseoHome)` collects pure-Markdown skill directories under `<userHome>/.agents/skills/<skillName>` (skipping `impeccable*`, `.git`, `node_modules`, and files `> 512 KB`) into `<paseoHome>/vault-runtime/config/skills/<skillName>/...`, and writes `<paseoHome>/vault-runtime/config/companion-tools.json` recording the required `impeccable` minimum version (`"4.8.0"`) and the host's installed version.
  - `materializeConfigsFromRuntime(paseoHome, overwriteConfigs)` materializes `<paseoHome>/vault-runtime/config/skills/<skillName>/...` into `<userHome>/.agents/skills/<skillName>/...` (respecting `overwriteConfigs`) and runs `ensureProviderSkillSymlinks(userHome)`.
- **OS/Arch-Specific `impeccable` Binary via Upstream Installer:**
  - Never commit `impeccable`'s OS/CPU-compiled binary (`scripts/impeccable`) into `factory-vault`. Instead, install and update `impeccable` on each host via its upstream installer (`npx --yes impeccable@latest install --scope=global` / `npx --yes impeccable@latest update`) so macOS arm64, macOS x64, and Linux hosts each receive their native binary.

### 4. Dual Lifecycle: Pre-Spawn Self-Healing + Fail-Fast Guard (`tool-missing`)

In `provisionImpeccable(roleHome, userHome, sourceCodexHome, options)`:
1. Reconcile provider skill symlinks (`ensureProviderSkillSymlinks(userHome)`) when running against the real host home (`userHome === homedir()`).
2. Inspect `<userHome>/.agents/skills/impeccable` (and fallback provider directories) via `inspectImpeccableTool(userHome)` for `SKILL.md`, executable `scripts/impeccable`, and `scripts/VERSION >= 4.8.0`.
3. When `impeccable >= 4.8.0` is missing on the real host home (`userHome === homedir()` or `options?.autoInstall === true`), automatically invoke `installOrUpdateImpeccableTool({ userHome, action: "install" })` (`npx --yes impeccable@latest install --scope=global`) before linking `<roleHome>/skills`.
4. If `options?.requireInstalled === true` (or when `autoInstall` was attempted and failed), throw `FactoryError("tool-missing", ...)` with a clear diagnostic so a live Scrum `UX`/`Dev`/`QA` specialist never launches blind without its required detector binary (while unit tests passing isolated temporary `userHome` fixtures without `autoInstall` remain offline and `0ms`).

### 5. `Plugins` Tab Integration (`Companion Tools & Skill Packs`)

- Extend `FactoryViewSchema` with an optional `companionTools: z.array(CompanionPluginViewSchema).optional()` list populated per snapshot from `inspectCompanionTools(userHome, stateDir)`.
- Extend `factory.plugins.install` and `factory.plugins.manage` to accept `"impeccable"` and `"factory-skills-pack"` targets (and optional `includeTools?: boolean` on batch `"all"` calls from the UI so existing daemon-only `target: "all"` tests remain unchanged).
- Render a **`Companion Tools & Skill Packs`** section directly below the `Companion plugin` cards in `plugin/client/factory/plugins.tsx`, with version pills (`v4.8.0`), live status (`running` / `not_installed` / `failed`), and 1-click `Install`, `Update`, and `Reload` (re-link symlinks) actions.

## Consequences

- Any machine joining the Owner's `Private vault` or spawning a Scrum `UX`/`Dev`/`QA` specialist automatically acquires both the shared `~/.agents/skills` library and `pbakaus/impeccable >= 4.8.0` with all provider symlinks wired.
- The Owner can inspect and update both Paseo daemon plugins and host companion tools from a single `Plugins` view in Paseo Desktop.
