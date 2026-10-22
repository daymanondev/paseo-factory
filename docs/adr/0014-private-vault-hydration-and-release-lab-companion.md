# ADR 0014 — Built-in `Private vault` header sync (`gh` guided onboarding, auto-repo creation, 1-click bidirectional `Sync`), dual-mode secret envelopes, multi-node `Ledger` reconciliation, and `factory-release-lab` in `COMPANION_CATALOG`

- **Status:** Accepted — 2026-10-19; amended 2026-10-20 after live UX review; amended 2026-10-22 for `v0.0.30` to mark `factory-release-lab` as `access: "private"` (invite-only) in `COMPANION_CATALOG` (ratified by Andrew over `/grill-with-docs`; words "toàn bộ theo bạn khuyến nghị")
- **Grounded in:** `research/private-vault-and-state-sync.md` · `research/vault-zero-config-sync-ux.md` · `src/ledger.ts` (`Ledger.open`, lines 66–76) · `src/project.ts` (`projectSlug`, lines 65–66) · `plugin/shared/companions.ts` (`COMPANION_CATALOG`) · `daymanondev/factory-release-lab` (`src/asc-adapter.ts`, `src/gplay-adapter.ts`, `src/signing-hygiene.ts`, `src/workflow-engine.ts`) · `.scratch/release-lab-upstream/issues/01-register-release-lab-in-companion-catalog.md` · `.scratch/factory-v0.0.22/issues/01..04`
- **Amends:** ADR 0012 §2 (expands `COMPANION_CATALOG` from two to three first-party `Companion plugin`s by registering `factory-release-lab` as `access: "private"` alongside public `factory-burn-lab` and `factory-connector`) · ADR 0009 §2 (adds the built-in `Private vault` sync bar directly into the persistent `Factory surface` `Header`, keeping the `Plugins` tab strictly for installable `Companion plugin`s)

## Context

While `paseo-factory`, `factory-burn-lab`, and `factory-connector` are public open-source repositories (and `factory-release-lab` is a private, invite-only companion repository for the Owner and invited collaborators), operating the factory and running mobile store releases across multiple machines (primary Mac, secondary Macs, Windows/WSL2 nodes, or fresh hosts) requires two classes of private, Owner-owned state that can never live in plugin source repositories:

1. **Store & Signing Credentials:**
   - Apple App Store Connect API `.p8` ECDSA private key (`ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER`) and Google Play Developer API Service Account JSON (`GPLAY_KEY_PATH`).
   - Per-app Android upload keystores (`<projectRoot>/android/app/release.keystore`, `RELEASE_LAB_KEYSTORE_STOREPASS`), Firebase SDK configs (`google-services.json`, `GoogleService-Info.plist`, `FIREBASE_PROJECT_ID`), and direct-API `eye.json`.
   - When Paseo Desktop is launched from macOS Finder/Spotlight, its daemon process does not inherit interactive `~/.zshrc` shell exports (`PATH` or credential env vars), and `wireSigningConfig()` in `factory-release-lab/src/signing-hygiene.ts:336-343` previously wrote plaintext `storePassword`/`keyPassword` directly into `android/app/build.gradle`.
2. **Operational Configs & Multi-Machine `Ledger` History:**
   - Machine and per-project `Lane config` (`lanes.json`), Tailscale peer registry (`fleet.json`), `free-pool.json`, `.store-release/manifest.json`, and `Ledger` history (`ledger.jsonl`).
   - Two codebase invariants prevent naive Git syncing of project state across machines:
     - `Ledger.open` (`src/ledger.ts:69-75`) enforces strict monotonicity (`evt.seq > prevSeq`) and throws `FactoryError("corrupted-ledger")` if two machines append events from the same base `seq` and merge via `.gitattributes` `merge=union`.
     - `projectSlug(gitCommonDir)` (`src/project.ts:65-66`) hashes the host-local absolute path (`<basename>-<sha1(realpath).slice(0,6)>`), producing different slugs when two machines check out the same repository at different paths.

### Live UX Findings from v0.0.21 Trial (2026-10-20 Amendment)

Testing the initial v0.0.21 shipment on Paseo Desktop exposed five concrete UX and Day-0 flaws (`research/vault-zero-config-sync-ux.md`):
1. **Wrong Information Architecture:** Placing `PrivateVaultCard` inside the `Plugins` tab (`tab === "plugins"`) treated a core built-in capability as if it were an external plugin and hid sync status when working in `Tasks` or `Seats & Models`.
2. **Manual Setup Friction & Empty-Remote Crash:** Even when the host was already logged into GitHub CLI (`gh auth status` active for `daymanondev`), the UI showed `Not Configured` and forced the Owner to manually create a GitHub repository, type `owner/repo`, and click `Save Config`. Worse, creating an empty private repository without a `main` branch crashed `git clone --branch main` (`Remote branch main not found in upstream origin`).
3. **4 Confusing Plumbing Buttons:** Exposing `Save Config`, `Hydrate Direct (gh api)`, `Pull & Sync Vault`, and `Push to Vault` side-by-side forced the Owner to reason about Git plumbing instead of clicking a single **`Sync`** button.
4. **Incomplete State Collection on Push:** `pushVault` only walked `<paseoHome>/vault-runtime/` without first collecting `<stateDir>/lanes.json`, `<paseoHome>/connector/fleet.json`, `<paseoHome>/burn-lab/free-pool.json`, `<stateDir>/eye.json`, or registered project `.store-release/manifest.json` files.
5. **Silent Clicks:** `FactoryShell.act()` only called `toast.error` on failure and never called `toast.show(..., { variant: "success" })` or updated an inline status note on success, leaving the Owner with zero feedback after clicking any button.

## Decision

1. **Built-in `Private vault` Sync Bar in the persistent `Factory surface` `Header` (never inside the `Plugins` tab) + 3-Plugin `COMPANION_CATALOG`.**
   - `Private vault` is a built-in core capability rendered as a compact, always-visible **Cloud Vault Sync Bar** inside `<Header />` (`plugin/client/factory/header.tsx`) across all tabs and on the `Settings` screen.
   - The `Plugins` tab (`plugin/client/factory/plugins.tsx`) exclusively renders the Core plugin (`paseo-factory`) plus the three installable `Companion plugin`s in `COMPANION_CATALOG`: public `factory-burn-lab` (`Burn Lab` · `Flame`), public `factory-connector` (`Fleet Connector` · `Network`), and private/invite-only `factory-release-lab` (`Release Lab` · `Rocket`, skipped by `Install All` and gated on pull-access verification when explicitly installed).

2. **Guided 3-State `gh` Onboarding & Automatic Private Repository Provisioning.**
   - `VaultRunner` augments `PATH` with `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` so Paseo Desktop launched from macOS Finder/Spotlight always locates `gh` and `git`.
   - `readVaultStatus(paseoHome)` probes `gh auth status --json hosts` (with a lightweight in-memory TTL cache to avoid subprocess spam on UI polls) and reports `ghInstalled`, `ghAuthenticated`, `ghUser` (e.g. `"daymanondev"`), and `suggestedRepo` (`"<ghUser>/factory-vault"`).
   - The Header Vault Bar adapts automatically across three states:
     - **State 1 — `gh` Not Logged In (`!ghAuthenticated`):** Renders a guided 2-step onboarding banner: *Step 1: Run `gh auth login --web -p https`* (with a 1-click **`Copy Command`** button) and *Step 2: Click **`Check GitHub Login`***.
     - **State 2 — `gh` Logged In, Vault Unconfigured (`ghAuthenticated && !configured`):** Greets `@<ghUser>` with the default private repo `<ghUser>/factory-vault` pre-filled and a single primary CTA: **`Enable & Sync Vault`**. Clicking it runs `gh auth setup-git --hostname github.com`, probes `gh repo view <ghUser>/factory-vault`, auto-creates the private repository via `gh repo create <ghUser>/factory-vault --private --add-readme --description "Private vault for paseo-factory"` if absent, saves `vault-config.json`, and runs a full bidirectional sync.
     - **State 3 — Configured & Active (`configured`):** Renders the compact 1-line status bar (`Vault: <repo>`, readiness pills for `ASC .p8`, `GPlay JSON`, `Lanes`, `Apps`, relative sync timestamp, inline result note, and the single **`Sync Vault`** button plus collapsible **`⚙`** settings / **`+ Import Key`** drawer).

3. **Single Smart Bidirectional `Sync` Action (`factory.vault.sync` RPC & `factory vault sync` CLI) + Empty-Remote Bootstrap.**
   - Everyday operation uses **one unified action (`Sync Vault`)** backed by `syncVault(paseoHome, options)` (`factory.vault.sync` RPC and `factory vault sync` CLI), which executes:
     1. **Auto-Configure & Empty-Remote-Safe Checkout:** Ensures `vault-config.json` exists (auto-provisioning `<ghUser>/factory-vault` if needed). When cloning or pulling `<paseoHome>/vault`, if remote branch `<branch>` does not exist yet on an empty remote, initializes an orphan `<branch>` locally instead of throwing `Remote branch main not found`.
     2. **Pull & Hydrate (Remote → Local):** Pulls remote commits (when remote has `<branch>`), unseals `secrets/` into `<paseoHome>/vault-runtime/secrets/` (`0o600`), materializes `config/{lanes,fleet,free-pool}.json` into local state directories when missing locally (or when `overwriteConfigs: true`), routes `apps/<canonicalAppKey>/` into registered local `Project`s with `.git/info/exclude` + `.worktreeinclude` hygiene, writes `<paseoHome>/vault-runtime/env.json`, and reconciles `state/nodes/*` ledgers via `reconcileVaultLedgers`.
     3. **Auto-Collect & Push (Local → Remote):** Collects local `<stateDir>/lanes.json`, `<paseoHome>/connector/fleet.json`, `<paseoHome>/burn-lab/free-pool.json`, `<stateDir>/eye.json`, existing env-pointed `.p8` / Google Play `.json` keys, registered projects' `.store-release/manifest.json` + signing files, and this machine's global + per-project `ledger.jsonl` into the vault checkout under the re-seal law. If `git status --porcelain` has changes, commits and pushes (`git push -u origin <branch>`).
     4. **CLI Parity:** `plugin/bin/vault.mjs` shares the exact same `sync`, `import`, `pull --merge-ledgers`, and `push --include-ledger` behavior as the server RPCs.

4. **1-Click Key Import (`factory.vault.import` / `factory vault import`) & Dual-Mode Envelopes.**
   - An expandable **`+ Import Key`** drawer in the Vault Bar (and `factory vault import` CLI) lets the Owner import `.p8` (`ascKeyPath`, `ascKeyId`, `ascIssuer`), Google Play `.json` (`gplayKeyPath`), or per-app `release.keystore` files from any path on disk (e.g. `~/Downloads/AuthKey.p8`), automatically sealing them into `<paseoHome>/vault-runtime/secrets/` and syncing them to GitHub in one step.
   - Dual-mode envelope law remains unchanged: zero-passphrase `obfuscated` envelopes by default (defeating GitHub Secret Scanning false-positive revocations with zero passphrase prompts), plain files passed through directly, and optional `.enc` `aes-256-gcm` envelopes unlocked when a passphrase is set in `vault-config.json` (`0o600`) or `FACTORY_VAULT_PASSPHRASE`.

5. **Three-Layer Visual Feedback on Every Action (`In-Flight Label` + `Toast Success` + `Inline Summary Banner`).**
   - `FactoryShell` tracks `busyAct: string | null` so the clicked button displays dynamic in-flight copy (`"Syncing Vault…"`, `"Importing & Syncing…"`).
   - When an RPC returns `ok: true` with a human-readable `summary`, `FactoryShell.act()` invokes `toast.show(summary, { variant: "success" })` and updates an inline `vaultNote` banner on the Header Vault Bar (e.g. `"✓ Synced daymanondev/factory-vault · 4 secrets ready · pushed lanes.json & ledger"`). User-facing error messages always name UI actions rather than internal function names.

## Consequences

- `CONTEXT.md` and `ADR 0014` standardize `Private vault` as a built-in Header capability with guided `gh` onboarding and 1-click bidirectional `Sync`.
- All four v0.0.21 post-release issues in `.scratch/factory-v0.0.22/issues/01..04` are resolved as part of the v0.0.22 UX & engine upgrade.
