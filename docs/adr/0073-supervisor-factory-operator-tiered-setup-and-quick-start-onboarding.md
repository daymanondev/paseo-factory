# 0073 — Supervisor as Factory Operator: Tiered Capability Provisioning, Live Unlock, and Quick Start Onboarding

- **Date:** 2026-11-26
- **Status:** Accepted — ratified by the Owner over `/grill-me` rounds 1–3 (Q1–Q13; updated after architecture & security review in implementation spec [spec.md](../../.scratch/supervisor-factory-operator/spec.md)).
- **Grounded in:** `CONTEXT.md` · `src/roles-contract.ts` · `src/mcp/shared.ts` · `src/agy-mcp-schema-heal.ts` · `src/project-settings.ts` · `src/store-release-capability.ts` · `src/preflight.ts` · `src/vault.ts` · `plugin/shared/companions.ts` · `plugin/shared/rpc.ts` · `plugin/shared/view.ts` · `plugin/server/surface-rpc.ts` · `plugin/server/panel.ts` · `plugin/server/spool.ts` · `plugin/server/lead-mailbox.ts` · `plugin/bin/bridge.mjs` · `plugin/client/factory/onboarding-wizard.tsx` · `plugin/client/factory/onboarding-state.ts` · `plugin/client/factory/project-panel.tsx`.
- **Amends:**
  - [ADR 0006](0006-supervisor-and-lead-seats.md) (reclaims Owner plumbing burden under the seats by making `Supervisor` the conversational **Factory Operator** for Project capability setup while keeping `Lead` strictly Project-scoped and `Peer` topology-blind).
  - [ADR 0061](0061-lead-owned-release-per-project-release-mode-and-one-time-github-publish.md) & [ADR 0066](0066-store-release-bridge-vault-store-notebook-and-release-lab-handoff.md) (preserves the Owner-authority circuit breaker for `Release mode`, `Store release mode`, and private companion installs via atomic 1-click `Setup Proposal` approval in `Needs you`, rather than forcing manual multi-screen UI navigation).
  - [ADR 0071](0071-capability-gated-store-release-role-contracts-and-mcp-tools.md) (replaces `Supervisor`'s passive `"off-hint"` panel pointer with live Factory inspection + setup provisioning, and eliminates forced manual `Hand off Supervisor` on dynamic-MCP providers by pairing `bridge.mjs` `notifications/tools/list_changed` with capability-contract delivery in the `Supervisor mailbox` wakeup and compaction-safe reminders across providers).
  - [ADR 0072](0072-vault-remote-runner-hydration-and-env-local.md) (reuses `hydrateVaultDirect(..., { runtimeOnly: true, projectDir })` for Tier 1 `Supervisor` Vault hydration so it never mutates machine-wide `helper-mcps.json`, `lanes.json`, `profiles.json`, or sibling Projects).
  - [ADR 0056](0056-slim-factory-panel-slp-only-and-guided-onboarding.md), [ADR 0063](0063-global-onboarding-screen-profile-selection-and-panel-badges.md), & [ADR 0065](0065-async-onboarding-run-and-direct-supervisor-chat.md) (condenses the 4-step `OnboardingWizard` into a single-screen **Quick Start** that lands directly in `Supervisor` chat while preserving the server-tracked async `Onboarding run` checklist and backward-compatible RPC schemas).

## Context

`paseo-factory` separates work across four parties: `Owner` (human intent & external authority), `Supervisor` (conversational door), `Lead` (Project technical orchestration), and `Peer` (isolated `Task worktree` execution). While [ADR 0006](0006-supervisor-and-lead-seats.md) established the principle *"reduce owner burden by mechanizing under the seats"*, Factory setup itself remained entirely manual for the Owner:

1. **Heavy upfront & multi-screen Owner setup:** The Owner currently faces ~25 setup RPC controls (`plugin/shared/rpc.ts`), a 4-step `OnboardingWizard` (`Folder → Prerequisites → Models → Start`), and scattered cards across *Settings → Plugins*, *Private vault*, *Helper MCPs*, *Skill Packs*, *Open Design*, *GitHub & Release*, and *Store Release*. Enabling `factory-release-lab` for a mobile Project requires 5–6 manual clicks across 3 views plus a manual `Hand off Supervisor` click.
2. **Supervisor is blind and hand-tied regarding Factory capabilities:** `Supervisor` currently exposes only 4–5 MCP tools (`supervisor_dispatch_lead`, `supervisor_read_ledger`, `supervisor_accept_task`, `supervisor_end_cycle`, and gated `supervisor_record_store_note`). All setup mutations refuse seats with `seat-cannot-grant`, and [ADR 0071](0071-capability-gated-store-release-role-contracts-and-mcp-tools.md)'s `"off-hint"` tells `Supervisor` only to redirect the Owner back to UI cards.
3. **Concept misalignment:** Naturally, **Supervisor understands the Factory** (capabilities, companions, skill packs, helper MCPs, readiness) and works with the Owner to provision them; **Lead understands the Project** (repository architecture, waves, gates, `.store-release/manifest.json`) and consumes unlocked capabilities; **Peer executes tasks** inside `Task worktree`s.

At the same time, [ADR 0061](0061-lead-owned-release-per-project-release-mode-and-one-time-github-publish.md) and [ADR 0066](0066-store-release-bridge-vault-store-notebook-and-release-lab-handoff.md) warned that `"the Owner said so"` in LLM chat is not mechanically verifiable and could be abused via prompt injection to enable `auto` releases, install daemon plugins, or expand external blast radius. The Factory therefore needs a **tiered authority model** that delegates inspection and safe local plumbing to `Supervisor` while keeping high-impact capability grants behind a cryptographically bound, 1-click Owner gate.

## Decision

1. **Three-Tier Authority Model & v1 Capability Scope (Q1, Q2, Q8, Q12):**
   - **Tier 0 — Read-only Factory Awareness (autonomous):** `supervisor_inspect_factory` exposes normalized, **secret-free**, size-bounded Project and machine Factory state: `isMobile`, `detectedPlatforms`, `hasOrigin`, `hasStoreManifest`, companion status (`factory-release-lab`, `factory-skills-pack`: installed, version, update availability), `release` and `storeRelease` modes, `skillPacks` (enabled and available IDs/labels), `helperMcps` roster (status-only, explicitly marked machine-wide), `openDesign` link state + top-20 catalog options, boolean `vault` readiness (`{ configured, ascKey, appleTeamId, gplayJson }`), and `ghAuth` status.
   - **Tier 1 — Low-risk, local, reversible plumbing (direct execution + 1-line chat summary):**
     - `set_skill_pack` (per-Project `Project skill pack` enable/disable).
     - `sync_open_design` (per-Project Open Design link/sync; `Supervisor` asks the Owner first when multiple host design projects make matching ambiguous, and fails fast if an active writable `Peer` landing or dirty `design/` index conflicts).
     - `vault_hydrate` (strictly project-scoped runtime hydration via [ADR 0072](0072-vault-remote-runner-hydration-and-env-local.md)'s `hydrateVaultDirect(..., { runtimeOnly: true, projectDir })` — never unscoped `vaultHydrate`, so machine-wide `helper-mcps.json` (Tier 2), `lanes.json`/`profiles.json` (Tier 3), and sibling Projects are never mutated).
     - `install_companion` strictly for additive public `factory-skills-pack` (install/update of curated core skills only; never disable/remove or overwrite user custom skills).
     - **Strict catalog whitelist:** Pure constants in `src/factory-setup.ts` (parity-tested against `COMPANION_CATALOG` and `COMPANION_TOOLS_CATALOG` in `plugin/shared/companions.ts`, excluding self-install of `paseo-factory`); arbitrary git or npm URLs are mechanically refused.
   - **Tier 2 — External-effect, daemon plugin install, or machine-wide switches (atomic 1-click `Setup Proposal` in `Needs you`):**
     - `install_companion` for `factory-release-lab` (private daemon plugin).
     - `set_release_mode` (`off | on-request | auto` and optional validated `branch`).
     - `set_store_release_mode` (`off | on-request | auto-staging`, refused upfront on non-mobile Projects with `store-release-not-mobile`).
     - `set_helper_mcp` (moved from Tier 1 to Tier 2 because `<stateDir>/helper-mcps.json` is **machine-wide** across all Projects and grants external service access; validated against discovered helpers and always tagged `(machine-wide)` on the approval card).
   - **Tier 3 — Strictly Owner-only UI/CLI (never exposed to seats):** Raw secret entry into `Private vault` (`.p8`, Google Play JSON, tokens, `gh auth login`), `GitHub publish` (especially Public visibility), `Models / Lanes / Profiles` (deferred out of v1), production store submit confirmation (`final-release-approval` / explicit Owner intent), `Rotate seats`, `Project reset`, and `Project delete`.

2. **Two-Tool `Supervisor` MCP Surface & Atomic Routing (Q6):**
   - Expose exactly **two** new Supervisor-only MCP tools in `src/mcp/shared.ts`, `src/agy-mcp-schema-heal.ts`, and `plugin/bin/bridge.mjs` (`sharedRoles.supervisor` only — never `lead`, `agent`, or `unbound`):
     - `supervisor_inspect_factory({ workspace? })` (Tier 0 read-only).
     - `supervisor_setup_factory({ actions, reason, workspace? })` (Tier 1 / Tier 2 unified entry point using a flat object schema for `actions.items` with strict server-side per-kind validation and canonical dependency ordering).
   - The server evaluates the entire `actions` array **atomically**:
     - If **all** actions are Tier 1 → execute immediately in canonical order and return per-action outcomes synchronously.
     - If **any** action is Tier 2 → execute **nothing** immediately and persist the entire bundle as one pending **Setup Proposal** so the Owner approves or declines the full setup as a single atomic unit.

3. **Context-Triggered Proactivity Preserving `Delegation Boundary` (Q3):**
   - Clear Turn-1 code directives continue to satisfy `Delegation Boundary` (`src/roles-contract.ts`) by dispatching `Lead` immediately without running setup diagnostics.
   - `Supervisor` calls `supervisor_inspect_factory` / `supervisor_setup_factory` only when context warrants it (explicitly carved out from `Delegation Boundary` alongside `Diagnostics & Run-Verification Law`):
     1. The Owner requests a capability-dependent workflow (e.g., store release, GitHub release, Open Design sync, Helper MCPs or framework skill packs).
     2. `Lead` or a `Gate` reports a failure caused by missing capabilities, skills, companions, or Vault hydration.
     3. A newly onboarded Project begins an exploratory or scoping conversation before any concrete code directive is issued.

4. **Setup Proposal Lifecycle, HITL Binding, `Needs you` UX, Crash Recovery & Auto-Wake (Q7, Q10, Q13):**
   - **Single active Proposal per Project & HITL TOCTOU binding:** Each Project holds at most one active `Setup Proposal`; submitting a new Tier 2 bundle overwrites any prior pending/failed proposal (never while `"applying"`). Every Owner RPC (`factory.setup_proposal.{approve,decline,dismiss}`) requires `proposalId` (and checks deterministic SHA-256 `actionsHash` when supplied), failing closed with `setup-proposal-stale` if superseded so an injected or concurrent overwrite cannot hijack an Owner click.
   - **`Needs you` presentation & directory counts:** Active proposals surface at the top of the Project panel's `Needs you` list via pure `PanelInput` (propagating into `seatsDirectory` and `Factory overview`'s `needsYouCount` badge), displaying `Supervisor`'s bounded `reason` (`<= 500` chars), exact action bullets (`(machine-wide)` badge on `set_helper_mcp`), any missing-key warnings, `"applying"` in-progress state, and `Approve & Apply` / `Decline` (or `Retry` / `Dismiss`) controls (read-only desktop hint on Paseo mobile).
   - **Mobile / `factory-release-lab` preflight (Q10):**
     - When Vault store keys (`ascKey`, `appleTeamId`, `gplayJson`) are missing but `Private vault` is configured, `Supervisor` runs Tier 1 project-scoped `vault_hydrate` first before concluding keys are absent.
     - If `ghAuth` is missing and `factory-release-lab` is not installed, `supervisor_setup_factory` refuses creating a doomed Proposal (`gh-auth-required`) so `Supervisor` instructs the Owner to sign in to `gh` first.
     - If `ghAuth` is valid (or `factory-release-lab` is already installed) and Vault store keys remain missing after hydration, `Supervisor` may still submit the Tier 2 Proposal (installing `factory-release-lab` + enabling `on-request`) with explicit warnings naming the missing keys and pointing to *Settings → Private Vault* so `Lead` can prepare `.store-release/manifest.json` and build waves in parallel.
   - **Fail-fast, Boot Recovery & Lock Discipline (Q13):** `Approve & Apply` executes actions sequentially without holding `withProjectIngressLock` across network steps (`pluginsInstall`, `vaultHydrate`, `factory-skills-pack`), enforces per-step timeouts, and halts on the first error (marking remaining actions `skipped`), transitioning the Proposal to `status: "failed"` (`Retry` / `Dismiss`). On daemon restart, any persisted `"applying"` proposal without an active in-memory run transitions automatically to `status: "failed"` so the Project never wedges.
   - **Auto-wake (Q7):** On `Approve & Apply` completion, failure, or `Decline`, the server enqueues a `{ to: "supervisor", from: "system", kind: "report" }` wakeup into `Supervisor mailbox` so `Supervisor` resumes automatically and dispatches `Lead` without requiring the Owner to type a follow-up prompt.

5. **Provider-Aware Live Unlock in Active `Supervisor` Session (Q5):**
   - When an approved `Setup Proposal` flips a gated capability (such as `Store release` `off → on-request | auto-staging`), `Lead` continues to undergo [ADR 0071](0071-capability-gated-store-release-role-contracts-and-mcp-tools.md)'s clean unstarted retirement or quiet-point `Lead` `Handoff`.
   - For `Supervisor`, `plugin/bin/bridge.mjs` detects the capability transition, emits `notifications/tools/list_changed`, and permits newly unlocked tools/parameters on `tools/list` and `tools/call`, while the `Supervisor mailbox` completion wakeup embeds the concise unlocked capability contract summary (e.g., `SUPERVISOR_STORE_RELEASE_BOUNDARY`) and `drainSupervisorMailbox` keeps Hole/Store Release reminders compaction-safe across all providers.
   - On providers verified to dynamically reload MCP tool schemas on `list_changed`, `Approve & Apply` skips `supervisorNeedsHandoff: true` so `Supervisor` acts immediately in the same conversation; on static-schema MCP clients (e.g., Claude Code, Codex, or cached Antigravity schema sessions) that ignore mid-session `tools/list` updates, `storeReleaseWrite` falls back to surfacing non-blocking `supervisorNeedsHandoff: true` so the Owner can optionally rotate the chat with 1 click.

6. **Persistence & Audit Trail Outside `ledger.jsonl` (Q11):**
   - Pending, applying, and failed Tier 2 proposals are stored atomically under `stateMutation` at `<projectStateDir>/setup-proposal.json` and cleared in `plugin/server/surface-rpc.ts` on `Rotate seats` and `Project reset`.
   - Every Tier 1 execution and Tier 2 approval/failure/decline/dismissal appends a structured record (`timestamp`, `tier`, `actor: "supervisor" | "owner-approved" | "owner-declined" | "owner-dismissed"`, `reason`, `actions`, per-step scrubbed results) to `<projectStateDir>/setup-audit.jsonl` (preserved on `Rotate seats`, wiped on `Project reset`).
   - `ledger.jsonl` remains strictly scoped to Task verification, acceptance, and Release/Store release execution events (consistent with [ADR 0061](0061-lead-owned-release-per-project-release-mode-and-one-time-github-publish.md)).

7. **Single-Screen Quick Start Onboarding Wizard (Q4, Q9):**
   - Retain all existing Project panel and Settings cards as the Owner's visual dashboard and manual override surface.
   - Collapse `OnboardingWizard` (`plugin/client/factory/onboarding-wizard.tsx`, `onboarding-state.ts`, `onboarding-screen.tsx`) from 4 steps (`Folder → Prerequisites → Models → Start`) into a single **Quick Start** screen:
     1. Target folder picker / Folder Browser (+ conditional `Initialise Git repository` checkbox).
     2. Compact inline `Lane profile` selector (defaulting to Machine defaults, with an expandable `Customize models…` drawer).
     3. **`Start Supervisor`**, executing [ADR 0065](0065-async-onboarding-run-and-direct-supervisor-chat.md)'s server-tracked async `Onboarding run` checklist and opening `Supervisor` chat directly.
   - Remove Step 2 (`Prerequisites`) and `Open Design` selection from the onboarding wizard (handled on-demand by `Supervisor` and `Needs you`), while keeping `factory.onboarding.start` and `factory.onboarding.commit` RPC schemas backward compatible.

## Considered Options

- **Zero-click chat-only Tier 2 grants (Option B in Q1):** Rejected — allows prompt injection or misinterpreted chat context to install private daemon plugins, flip `auto` release modes, or toggle machine-wide external MCPs without a mechanical Owner circuit breaker.
- **Unscoped `vaultHydrate` in Tier 1 `vault_hydrate`:** Rejected — `hydrateVaultDirect` without `{ runtimeOnly: true, projectDir }` writes machine-wide `helper-mcps.json` (Tier 2), `lanes.json`/`profiles.json` (Tier 3), and sibling Project checkouts across the host.
- **Optional `proposalId` on Owner approval RPCs:** Rejected — leaves a TOCTOU overwrite window between Owner UI inspection and button click; mandatory `proposalId` + `actionsHash` verification eliminates silent bundle swaps.
- **Exposing 10–12 individual setup MCP tools (Q6):** Rejected — bloats `Supervisor`'s tool schema and encourages multi-turn partial configurations instead of one atomic proposal.
- **Keeping `set_helper_mcp` at Tier 1 (Q12):** Rejected — `<stateDir>/helper-mcps.json` is machine-wide across all Projects and grants access to external services, so toggling it without Owner approval violates per-Project blast-radius isolation.
- **Proactive Turn-1 factory audit on every new Project (Q3):** Rejected — breaks `Delegation Boundary` by adding unnecessary latency and conversational friction when the Owner already gave a clear code directive.
- **Deleting Project panel / Settings setup cards (Q4):** Rejected — keeping the visual cards preserves direct inspection and manual overrides when the Owner wants them.
- **Recording setup events inside `ledger.jsonl` (Q11):** Rejected — adds Ledger schema, migration, validation, and import churn for configuration changes that [ADR 0061](0061-lead-owned-release-per-project-release-mode-and-one-time-github-publish.md) already keeps out of the Ledger.
- **Deleting failed Tier 2 proposals immediately instead of `Retry` / `Dismiss` (Q13):** Rejected — forces `Supervisor` and the Owner to re-run the proposal round-trip on transient network or GitHub rate-limit errors.

## Consequences

- **Domain glossary (`CONTEXT.md`):** Implementation adds **Setup Proposal** (explicitly disambiguated from `Recurrence Guard` **Proposal**), updates **Supervisor** to note its Factory Operator role, and updates **Onboarding** for single-screen **Quick Start**.
- **Reduced Owner friction with intact security boundaries:** Multi-screen plugin, skill-pack, Vault-hydration, and mode-toggle setup collapses into conversational `Supervisor` inspection + at most one cryptographically bound `Approve & Apply` click, and new-Project onboarding drops from 4 steps to 1 screen.
- **Preserved SLP separation & cross-provider resilience:** `Lead` and `Peer` remain completely unaware of Factory provisioning tools; Tier 1 `vault_hydrate` stays strictly runtime- and Project-scoped; raw secrets, `GitHub publish`, production store submission, and machine-wide / external grants remain strictly Owner-gated; static-schema MCP clients retain safe `Hand off Supervisor` fallback.
- **Backward compatibility:** Existing `factory.onboarding.start` / `factory.onboarding.commit`, Project panel cards, and manual Settings controls continue functioning unchanged.
