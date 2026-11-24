# 0066 — Store Release Server Bridge, Private Vault Store Defaults, and Cross-Project Store Notebook

- **Date:** 2026-11-20
- **Status:** Accepted — ratified by the Owner over `/grill-with-docs` rounds 1–3 (Q1–Q12); amended 2026-11-23 for the two-tier `Store release` timeout contract, detached `-pgid` termination with grace, read-only stalled-`Phase` diagnosis, and active `Store release` sleep inhibition; amended 2026-11-24 for the **Store Release** summary-bar default and attention-driven auto-expand.
- **Grounded in:** `CONTEXT.md` · `docs/adr/0014-private-vault-hydration-and-release-lab-companion.md` · `docs/adr/0061-lead-owned-release-per-project-release-mode-and-one-time-github-publish.md` · `src/roles-contract.ts` · `src/vault-materialization.ts` · `plugin/server/store-release.ts` · `plugin/index.server.ts` · `factory-release-lab` `docs/adr/0003-deterministic-agent-free-native-first-store-runner.md`.
- **Amends:** ADR 0061 §2 (adds a sibling typed server-side **Store release** bridge alongside GitHub-only `lead_release`, keeping GitHub `Release` and mobile `Store release` cleanly separated) · ADR 0014 §3–§4 (extends `Private vault` hydration with `APPLE_TEAM_ID`, `store-defaults.json`, Day-0 keystore write-back, and the two-tier `Store notebook`).

## Context

`paseo-factory` already automates git + GitHub releases through Lead-owned `lead_release` (ADR 0061) and hydrates store credentials through `Private vault` (ADR 0014), while `factory-release-lab` exists as a companion plugin for mobile store uploads. In practice, however, four disconnects left `Supervisor` and `Lead` blind whenever the Owner asked to release a mobile app to Google Play or the App Store:

1. **No bridge from `paseo-factory` seats to `factory-release-lab`**: `Supervisor` and `Lead` had no typed tool, prompt contract, or installed skill pointing to `factory-release-lab`. Each new mobile project reinvented ad-hoc upload scripts and re-hit previously solved store API traps.
2. **Incomplete `Private vault` hydration**: `vault-runtime/env.json` omitted `APPLE_TEAM_ID` and Owner-wide defaults (review contact info, default legal/privacy URL hosting conventions), and an unhydrated vault left store runs failing on missing issuer/team identifiers.
3. **Competing agent loops**: Running hidden `Step agent`s inside `factory-release-lab` mutated `<project-root>` outside SLP's `Task worktree` + `Gate` + `Lead` diff review loop, and brittle 7-phase assumptions broke on single-platform native Android/iOS repos.
4. **No cross-project store rejection memory**: Field lessons and App Store / Google Play rejection histories lived scattered in per-project notes instead of a private, Owner-scoped memory loaded before every store submission.

## Decision

1. **Keep `factory-release-lab` as the sole deterministic, agent-free store runner; connect it via a typed Server Bridge (`lead_store_release`).**
   - `paseo-factory` stays thin: it does not embed App Store Connect or Google Play API clients in core. Instead, `paseo-factory` adds a server-side typed act `lead_store_release` (parallel to `lead_release` in ADR 0061) routed through the Spool to the plugin server — never executed in a seat shell.
   - Supported actions: `probe` (inspect Vault readiness + live store Day-0/Update status and next build numbers), `stage` (build + sign + upload to Google Play `internal`/`draft` and/or App Store Connect / TestFlight with 0-token Apple `PROCESSING → VALID` polling), `submit` (promote Play `production` and/or submit Apple review), and `resume` (answer a paused `Hole`).
   - The plugin server resolves the installed `factory-release-lab` runner under `<paseoHome>/plugins/factory-release-lab/` (or configured path), injects `PASEO_HOME` so it consumes `<paseoHome>/vault-runtime/env.json`, records Project-level Ledger events (`store_release_started`, `store_release_paused`, `store_release_completed`, `store_release_failed`), and wakes `Lead` → `Supervisor` asynchronously when long-running builds or Apple ingestion settle.
   - Because the runner writes every phase transition to `<paseoHome>/release-lab/runs/<runId>.json`, the Owner can watch live pipeline progress and approve `Hole`s either in the **`Release Lab`** Paseo UI (`Rocket` panel) or directly in **`Supervisor`** chat — both surfaces read and mutate the exact same run state.

2. **Two-tier autonomy & Owner-only `Store release mode` (`off` | `on-request` | `auto-staging`).**
   - Stored in per-Project `project-settings.json` (seat-unwritable, Owner-only via the Project panel's **Store Release** card placed directly beneath **GitHub & Release**):
     - **Default collapse & attention-driven auto-expand (amended 2026-11-24; `.scratch/project-tab-redesign/spec.md`):** On mobile projects, the **Store Release** card defaults collapsed to a compact 2-line summary bar (and a 1-line summary bar on non-mobile projects), auto-expanding only when Owner attention is needed — an active `Hole`, a failed `lastRun`, or missing `Private vault` store credentials while `Store release mode !== "off"`. Manual collapse is preserved across snapshot polls unless the active Project changes or a new attention key appears, and Paseo mobile remains strictly zero-button read-only.
     - `off` (default): `lead_store_release` refuses with `store-release-not-granted`.
     - `on-request`: `supervisor_dispatch_lead` carries an explicit **Store release request** (`storeRelease: { target: "staging" | "production", platforms?: ("android" | "ios")[], resumeRunId?: string, resolution?: unknown }`).
     - `auto-staging`: after `lead_release` succeeds on a mobile project, `Lead` automatically triggers `lead_store_release({ action: "stage" })` to upload to Google Play `internal`/`draft` and/or TestFlight without prompting the Owner.
   - **Safety boundary**: Staging uploads run unattended once authorized; **Production rollout / Apple App Review submission** always pauses at a `final-release-approval` `Hole` (surfaced to `Supervisor` chat and `Release Lab` UI) unless the Owner's same-turn request explicitly granted `target: "production"`.

3. **Clean SLP ownership & two-route failure taxonomy.**
   - All repo edits (creating/updating `.store-release/manifest.json`, bumping version/CHANGELOG, fixing Gradle/Xcode/Expo build errors, preparing store screenshots/metadata) stay inside normal `Lead` → `Peer` `Serial Wave`s with `Gate` verification and clean `HEAD` merges. Peers never author per-app store upload scripts; they consume the globally installed `mobile-store-release` skill (`~/.agents/skills/` + Skill Hub).
   - When `lead_store_release` fails, the runner returns a typed error category:
     - `app-repo` (compile error, missing capability/manifest entry, asset/format issue, review feedback requiring app edits): `Lead` dispatches a bounded Peer repair wave (**at most 2 repair attempts** per store release) before escalating to `Supervisor` → `Owner`.
     - `tool-bug` (runner/adapter defect, upstream store API schema change) or `account-policy` (expired agreement, invalid token scope, console account gate): `Lead` halts immediately, **never** lets an app Peer hack around the runner, ensures an `Upstream issue` ticket is recorded in `<paseoHome>/release-lab/upstream-issues/`, and reports directly to `Supervisor` → `Owner`.

4. **Extend `Private vault` as the single credential/defaults source of truth & enforce public-repo hygiene.**
   - `paseo-factory` is a public repository and must never contain personal filesystem paths, private app names, Key IDs, Issuer UUIDs, Apple Team IDs, service-account identifiers, or personal hosting domains.
   - Extend `Private vault` (`vault-materialization.ts` + Vault UI/CLI import) with:
     - `APPLE_TEAM_ID` in shared ASC credentials → hydrated to `<paseoHome>/vault-runtime/env.json` (`0o600`) alongside `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER`, `GPLAY_KEY_PATH`.
     - Optional `store-defaults.json` in `Private vault` (Owner review contact details, organization name, default privacy/support URL template or hosting repo) hydrated to `<paseoHome>/vault-runtime/store-defaults.json` (`0o600`).
     - Automatic write-back of newly generated Day-0 Android upload keystores into `Private vault` (`apps/<canonical-app>/`) so no signing key is ever stranded on one machine.

5. **Add a two-tier `Store notebook` inside `Private vault` to prevent repeat store rejections.**
   - Stored exclusively in `Private vault` under `store-memory/` and hydrated read-only to `<paseoHome>/vault-runtime/store-memory/`:
     - `lessons.md` — bounded cross-project rejection guard (`<= 120` lines, table `ID | Platform | Cause → Rejection/Trap | Prevention`). `Lead` reads it during Store release preflight; mechanically checkable lessons graduate into deterministic `probe` checks inside `factory-release-lab`.
     - `apps/<canonical-app>.md` — per-app store card (identifiers, Native Android / Native iOS / Expo shape, live status, submission history, and app-specific rejection/review notes).
   - Updated via a dedicated single-writer command/tool into `Private vault` (never dirtying the app's git working tree) whenever a submission completes or the Owner reports a store rejection in `Supervisor` chat.

6. **Two-tier `Store release` timeout contract, detached `-pgid` termination, read-only stalled-`Phase` diagnosis, and sleep inhibition (amended 2026-11-23).**
   - **Two-tier timeout split across repos:** `factory-release-lab` enforces inner per-phase budgets — **15 minutes** (`E2E_TIMEOUT_MS`) for Phase 3 E2E and screenshots (`phase-3-e2e-and-screenshots`, classified `app-repo`) and **30 minutes** (`BUILD_TIMEOUT_MS` / `BUILD_POLL_TIMEOUT_MS`) for Phase 5/6 builds, exports, and Apple `PROCESSING → VALID` polling — while `paseo-factory`'s Server Bridge (`plugin/server/store-release.ts`) raises its outer runner ceiling from 35 minutes to **75 minutes** (`DEFAULT_RUNNER_TIMEOUT_MS`) so healthy multi-phase runs never suffer premature outer kills.
   - **Detached `-pgid` termination with grace:** `builtinStoreReleaseRunner` spawns `release-lab` in its own detached process group (`detached: true` on POSIX, bounded stdout/stderr buffers). On outer timeout, it sets `timedOut: true`, delivers `SIGTERM` to `-pgid` first, and waits a **5-second** grace window (`DEFAULT_RUNNER_GRACE_MS`) so `release-lab` can reap child process groups and persist failure state before escalating to `-pgid` `SIGKILL`.
   - **Read-only `rel-*.json` stalled-`Phase` diagnosis:** When an asynchronous run (`stage`, `submit`, `resume`) reports `timedOut: true`, `store-release.ts` inspects `<paseoHome>/release-lab/runs/*.json` (`rel-*.json`) strictly read-only for the newest matching run overlapping the run start window (checking `running` phases, with fallback to `failure.phase` or `signal-terminated` phase if `release-lab` caught `SIGTERM` during grace), recording `store_release_failed` and waking `Lead` with `code: "runner-timed-out"`, `failureClass: "tool-bug"`, and the run ID + stalled `Phase`. `factory-release-lab` stays the single writer of `rel-*.json`.
   - **Active `Store release` sleep inhibition (`caffeinate -i`):** `store-release.ts` tracks active asynchronous `Store release` runs (`hasActiveStoreReleases` / `onStoreReleaseActivityChange` across `stage`, `submit`, `resume`), keeping `SleepInhibitor` (`caffeinate -i -w <pid>` on macOS, never `-d`) active in `plugin/index.server.ts` alongside `Lead mailbox` and `Gate queue` work.

## Considered Options

- **Fold store APIs into `paseo-factory` core**: Rejected — bloats the thin verification core with volatile Apple/Google API adapters and duplicates `factory-release-lab`'s UI and state files.
- **Pure prose checklist + Peer shell scripts**: Rejected — forces every project to reinvent store upload scripts, re-introduces known API pitfalls, burns tokens, and hits daemon timeouts during 15–25 minute Apple build ingestion.
- **Keep hidden `Step agent`s inside `factory-release-lab`**: Rejected — creates two competing agent loops that bypass SLP's `Task worktree`, `Gate`, and `Lead` diff review, and breaks on single-platform native repos.

## Consequences

- `CONTEXT.md` adds `Store release`, `Store release mode`, `Store release request`, and `Store notebook`.
- `roles-contract.ts` teaches `Supervisor` to relay store-release intents, `Hole` prompts/resolutions, and rejection logs, and teaches `Lead` the deterministic Store release checklist + 2-route failure policy.
- `factory-release-lab` evolves per its companion ADR 0003 (agent-free deterministic runner, Native Android & Native iOS first-class, cloud-signed iOS upload, Play staging track, structured error taxonomy) while keeping its live Paseo Desktop `Release Lab` UI synced via `<paseoHome>/release-lab/runs/<runId>.json`.
- `Private vault` becomes the sole home for all personal store keys, `APPLE_TEAM_ID`, `store-defaults.json`, per-app upload keystores, and `Store notebook` history — keeping public repos completely free of personal data.
- Healthy 40–60 minute mobile store releases run to completion without premature 35-minute outer kills or mid-upload macOS idle sleep, while true runner hangs reap entire subprocess trees and surface `runner-timed-out` / `tool-bug` with the stalled `Phase`.
