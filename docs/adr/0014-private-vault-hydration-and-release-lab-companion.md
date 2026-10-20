# ADR 0014 — `Private vault` hydration & two-way GitHub sync (`Direct hydrate` + `Vault sync`), dual-mode secret envelopes, multi-node `Ledger` reconciliation, and `factory-release-lab` in `COMPANION_CATALOG`

- **Status:** Accepted — 2026-10-19 (ratified by Andrew over a two-round `/grill-with-docs`; words "toàn bộ theo bạn khuyến nghị")
- **Grounded in:** `research/private-vault-and-state-sync.md` · `src/ledger.ts` (`Ledger.open`, lines 66–76) · `src/project.ts` (`projectSlug`, lines 65–66) · `plugin/shared/companions.ts` (`COMPANION_CATALOG`) · `daymanondev/factory-release-lab` (`src/asc-adapter.ts`, `src/gplay-adapter.ts`, `src/signing-hygiene.ts`, `src/workflow-engine.ts`) · `.scratch/release-lab-upstream/issues/01-register-release-lab-in-companion-catalog.md` · `@getpaseo/server` (`plugins/managed-source.js`, `plugins/settings/index.js`)
- **Amends:** ADR 0012 §2 (expands `COMPANION_CATALOG` from two to three first-party `Companion plugin`s by registering `factory-release-lab` alongside `factory-burn-lab` and `factory-connector`, and adds the `Private vault` control card to the `Factory surface`'s `Plugins` and `Settings` views)

## Context

All plugins in the Paseo Factory ecosystem (`paseo-factory`, `factory-burn-lab`, `factory-connector`, `factory-release-lab`) are open-source repositories. However, operating the factory and running mobile store releases across multiple machines (primary Mac, secondary Macs, Windows/WSL2 nodes, or fresh hosts) requires two classes of private, Owner-owned state that can never live in open-source plugin repositories:

1. **Store & Signing Credentials:**
   - Apple App Store Connect API `.p8` ECDSA private key (`ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER`) and Google Play Developer API Service Account JSON (`GPLAY_KEY_PATH`).
   - Per-app Android upload keystores (`<projectRoot>/android/app/release.keystore`, `RELEASE_LAB_KEYSTORE_STOREPASS`), Firebase SDK configs (`google-services.json`, `GoogleService-Info.plist`, `FIREBASE_PROJECT_ID`), and direct-API `eye.json`.
   - When Paseo Desktop is launched from macOS Finder/Spotlight, its daemon process does not inherit interactive `~/.zshrc` shell exports, and `wireSigningConfig()` in `factory-release-lab/src/signing-hygiene.ts:336-343` previously wrote plaintext `storePassword`/`keyPassword` directly into `android/app/build.gradle`.
2. **Operational Configs & Multi-Machine `Ledger` History:**
   - Machine and per-project `Lane config` (`lanes.json`), Tailscale peer registry (`fleet.json`), `free-pool.json`, `.store-release/manifest.json`, and `Ledger` history (`ledger.jsonl`).
   - Two codebase invariants prevent naive Git syncing of project state across machines:
     - `Ledger.open` (`src/ledger.ts:69-75`) enforces strict monotonicity (`evt.seq > prevSeq`) and throws `FactoryError("corrupted-ledger")` if two machines append events from the same base `seq` and merge via `.gitattributes` `merge=union`.
     - `projectSlug(gitCommonDir)` (`src/project.ts:65-66`) hashes the host-local absolute path (`<basename>-<sha1(realpath).slice(0,6)>`), producing different slugs when two machines check out the same repository at different paths.

Additionally, upstream ticket `01-register-release-lab-in-companion-catalog.md` from `factory-release-lab` requested registering `Release Lab` (`Rocket` icon) as the third official `Companion plugin` in `COMPANION_CATALOG`.

## Decision

1. **`paseo-factory` owns the core `Private vault` engine (`src/vault.ts` + `factory vault` CLI + `Factory surface` UI) shared across all `Companion plugin`s.**
   - `paseo-factory` provides `src/vault.ts` (exported from the core barrel `src/index.ts` and synced to `plugin/server/core/vault.ts`), CLI subcommands (`factory vault status | hydrate | pull | push | seal`), and a **`Private Vault (GitHub)`** panel at the top of the `Factory surface`'s `Plugins` view and `Settings` screen.
   - `COMPANION_CATALOG` (`plugin/shared/companions.ts`) expands to three official `Companion plugin`s, adding `factory-release-lab` (`title: "Release Lab"`, `sidebarLabel: "Release Lab"`, `sidebarIcon: "Rocket"`, `canonicalSource: "git:daymanondev/factory-release-lab:plugin"`), resolving `.scratch/release-lab-upstream/issues/01-register-release-lab-in-companion-catalog.md`.

2. **Two first-class transport & hydration modes against a single Private GitHub Repository (`git:<owner>/<vault-repo>`):**
   - **Mode A — `Direct hydrate` (Zero-Clone Stream via `gh api` / GitHub REST API):**
     - Streams `GET /repos/{owner}/{repo}/tarball/{ref}` (or individual files via `Accept: application/vnd.github.raw+json`) using the host's existing `gh auth login` session (or an explicit token), extracts and unseals in memory, and writes directly to `<paseoHome>/vault-runtime/` (`0o600`) and target project paths **without leaving a `.git` repository clone on disk**.
   - **Mode B — `Vault sync` (Two-way Cached Git Checkout at `<paseoHome>/vault`):**
     - Clones or updates `<paseoHome>/vault` (`git pull --rebase --autostash`) to hydrate local state, and supports **`Vault push`** to package newly generated artifacts (such as a Day-0 `release.keystore`, updated `lanes.json`, `.store-release/manifest.json`, and this machine's `Ledger` snapshot) and push them back to the private GitHub repository.

3. **Dual-mode secret storage (`Plaintext / Auto-Envelope` default + optional user-passphrase `.enc` `AES-256-GCM`):**
   - **Zero-passphrase default on GitHub-authenticated machines:** Plain files stored in the `Private vault` (`secrets/shared/asc-api-key.p8`, `gplay-service-account.json`, `release.keystore`, `google-services.json`, `GoogleService-Info.plist`, `lanes.json`, `fleet.json`) or auto-obfuscated `.vault.json` envelopes (preventing GitHub Secret Scanning from false-positiving and auto-revoking Google Cloud Service Account keys) hydrate immediately on any machine logged into the Owner's GitHub (`gh auth login`) with **zero extra passphrase prompts**.
   - **Optional `.enc` (`node:crypto` `scryptSync` + `aes-256-gcm`):** Any file sealed with an explicit passphrase (`*.enc`, `v: 1`, `alg: "aes-256-gcm"`, `kdf: "scrypt"`, 16-byte `salt`, 12-byte `iv`, 16-byte `tag`) is automatically decrypted on hydration using `FACTORY_VAULT_PASSPHRASE` or the `0o600` persisted vault config (`<paseoHome>/plugin-state/paseo-factory/vault-config.json` — the spec's Implementation Decision 1 location; an earlier draft of this ADR named `<paseoHome>/plugin-settings/paseo-factory/vault.json`, which is not what shipped), with zero external binary dependencies (`git-crypt` or `sops` not required).

4. **Three-tier Vault layout, `Canonical project key` routing, and Node-partitioned `Ledger reconciler`:**
   - **`secrets/`:** `secrets/shared/` (`asc-api-key.p8`, `asc-credentials.json`, `gplay-service-account.json`, `eye.json`) and `secrets/apps/<canonicalAppKey>/` (`release.keystore`, `signing.json`, `google-services.json`, `GoogleService-Info.plist`).
   - **`config/`:** Global `lanes.json`, `fleet.json`, `free-pool.json`, and per-app `config/apps/<canonicalAppKey>/{store-manifest.json,lanes.json}`.
   - **`state/nodes/<nodeId>/`:** Each machine pushes its `ledger.jsonl` and `release-runs/<runId>.json` under its own `<nodeId>` namespace (`state/nodes/<nodeId>/projects/<canonicalAppKey>/ledger.jsonl`), eliminating Git merge conflicts across machines.
   - **Local `<project-slug>` mapping & `Ledger reconciler`:** On hydration, `<canonicalAppKey>` is matched against registered local `Project`s (by repository basename, `git` remote URL, or `bundleId`/`packageName`) and mapped to the host's local `<project-slug>`. When merging multi-node ledgers, `reconcileLedgers()` deduplicates events by natural key, sorts chronologically by `(ts, nodeId, seq)`, and re-indexes `seq: 1..N` strictly monotonically so `Ledger.open` (`src/ledger.ts:69-75`) never encounters a non-monotonic sequence.

5. **Zero-shell-config runtime consumption & clean-worktree hygiene in `factory-release-lab`:**
   - Hydrating the vault writes shared credentials to `<paseoHome>/vault-runtime/secrets/` (`0o600`) and a pointer index at `<paseoHome>/vault-runtime/env.json` (`ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER`, `GPLAY_KEY_PATH`, `RELEASE_LAB_KEYSTORE_STOREPASS`, `FIREBASE_PROJECT_ID`).
   - `factory-release-lab` automatically reads `<paseoHome>/vault-runtime/env.json` whenever those environment variables are not set in `process.env`.
   - When materializing `android/app/release.keystore`, `android/app/google-services.json`, and `ios/GoogleService-Info.plist` into a mobile `<projectRoot>`, the hydrator registers those relative paths in `<gitCommonDir>/info/exclude` and `<projectRoot>/.worktreeinclude` so `checkCleanAt()` remains 100% clean and secrets are never committed to open-source app repositories.
   - `wireSigningConfig()` in `factory-release-lab/src/signing-hygiene.ts` reads keystore passwords from environment variables / `keystore.properties` (excluded from Git) rather than embedding plaintext passwords in `android/app/build.gradle`.

## Consequences

- `CONTEXT.md` gains **Private vault** and updates **Companion plugin** and **Factory surface**.
- On any new Mac or Windows machine where the Owner is logged into GitHub (`gh auth login`), clicking **`Hydrate Direct (gh api)`** or **`Pull & Sync Vault`** on the `Factory surface` (or running `factory vault hydrate`) immediately provisions all App Store Connect `.p8` keys, Google Play Service Account JSONs, Android `release.keystore` files, `Lane config`s, and `Ledger` history without manual file copying or shell profile edits.
- `.scratch/release-lab-upstream/issues/01-register-release-lab-in-companion-catalog.md` is ratified for implementation alongside `Private vault`.
