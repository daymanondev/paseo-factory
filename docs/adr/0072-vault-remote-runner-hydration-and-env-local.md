# ADR 0072 — Pull-Only Private Vault Runner Hydration & Per-App `.env.local`

- **Status:** Accepted — 2026-11-25 (companion to `factory-release-lab` ADR 0006).
- **Grounded in:** `CONTEXT.md` · `src/vault.ts` · `src/vault-materialization.ts` · `src/vault-secrets.ts` · `src/history-admission.ts` · `plugin/bin/factory.mjs`.
- **Amends:** [ADR 0014](./0014-private-vault-hydration-and-release-lab-companion.md) (extends pull-only `Direct hydrate` for unregistered runner checkouts, daemon-coexistent runtime-only hydration, and per-app sealed `.env.local`).
- **Scope boundary:** Touches **only** `Private vault` (`vault*` modules and `factory vault` CLI). `Store release` Server Bridge (ADR 0066), capability-gated role contracts / `Role-scoped MCP bridge` (ADR 0071), Ledger event schemas, and `StoreReleaseFailureClass` stay 100% untouched.

## Context

`factory-release-lab` ADR 0006 delegates heavy mobile release phases (`phase-3` through `phase-6`) to a pull-only self-hosted macOS runner executing inside GitHub Actions (`$GITHUB_WORKSPACE`), using `Private vault` (`factory vault hydrate`) as the single source of truth for store signing credentials and build-time `.env.local` files.

Inspecting `src/vault.ts`, `src/vault-materialization.ts`, `src/vault-secrets.ts`, and `src/history-admission.ts` revealed three gaps that block pull-only CI runner hydration today:

1. **No `.env.local` target in `Private vault`:** `APP_FILE_TARGETS` currently materializes only `release.keystore`, `signing.json`, `google-services.json`, and `GoogleService-Info.plist`. Gitignored build-time `.env.local` files have no import flag or materialization path.
2. **Runner workspaces are invisible to `resolveVaultApps()`:** `applyVaultHydration()` matches canonical app keys only against checkouts listed in `<stateDir>/projects.json`, `<paseoHome>/projects/projects.json`, or `<paseoHome>/release-lab/projects.json`. A temporary GitHub Actions checkout at `$GITHUB_WORKSPACE` is not in those registries — and if the runner Mac previously registered the repo at another path, `factory vault hydrate` writes secrets to the stale local path instead of `$GITHUB_WORKSPACE`.
3. **`LedgerAdmission` blocks CLI hydration while Paseo Relay is running:** `hydrateVaultDirect()` wraps `materializeFetchedVault()` in `LedgerAdmission.withStateMaintenance()`, which throws `vault-owner-required` whenever a Paseo daemon holds `<stateDir>/ledger-owner.json` — breaking `factory vault hydrate` on any runner running Paseo Relay alongside its GitHub Actions runner.

## Decision

1. **Per-app sealed `.env.local` in `Private vault`.**
   - Extend `APP_FILE_TARGETS` in `src/vault-materialization.ts` with `{ vaultFile: ".env.local", projectRel: ".env.local" }`, stored encrypted/sealed under `secrets/apps/<canonicalAppKey>/.env.local`, materialized at `0o600`, and registered in `<gitCommonDir>/info/exclude` plus `<projectRoot>/.worktreeinclude`.
   - Extend `importVaultSecrets()` (`src/vault-secrets.ts`) and `factory vault import` (`plugin/bin/factory.mjs`) with `--env-local <path>` so the Owner or primary host imports and pushes `.env.local` alongside keystores and Firebase configs from one store.

2. **Explicit target checkout hydration (`--project <dir>` + optional `--app <key>`).**
   - Add optional `projectDir?: string` and `appKey?: string` options to `hydrateVaultDirect()` and `--project <dir>` / `--app <key>` flags to `factory vault hydrate`.
   - When `projectDir` is supplied, resolve the checkout strictly as a valid git working tree via `inspectProjectRootFacts(projectDir)` (refusing non-git paths fail-closed with `vault-project-not-git`), resolve the matching `canonicalAppKey` (using `appKey` when provided, else `matchManifestAppKey(manifest, facts)` by `gitRemote` / `bundleId` / `packageName` / `repoBasename`), materialize that app's files solely into `projectDir` with `ensureLocalGitExcludeAndWorktreeInclude`, and skip mutating unrelated registered local checkouts.

3. **Daemon-lock-safe `--runtime-only` hydration mode.**
   - Add `runtimeOnly?: boolean` to `HydrateVaultDirectOptions` (`--runtime-only` flag on `factory vault hydrate`), mutually exclusive with `--merge-ledgers` and `--overwrite-configs` (refused cleanly at CLI/argument validation).
   - When `runtimeOnly: true`:
     - Stream and unseal the tarball into `<paseoHome>/vault-runtime/` using atomic file writes (temp file + `chmod` + `renameSync`) and regenerate `<paseoHome>/vault-runtime/env.json` (`0o600`).
     - If `projectDir` is set, materialize per-app secrets solely into `projectDir`.
     - **Do not** acquire `LedgerAdmission.withStateMaintenance()`, **do not** write `plugin-state/paseo-factory/` configs/ledgers/`vault-config.json`, and **do not** stage history imports — making pull-only runner hydration safe whether the runner's Paseo daemon (e.g., Paseo Relay) is running or stopped.
   - Standard `factory vault hydrate` (without `--runtime-only`) keeps its full `LedgerAdmission.withStateMaintenance()` / `vault-owner-required` protection unchanged.

## Considered Options

- **Duplicate `.env.local` and signing files into GitHub Actions Secrets:** Rejected — creates dual credential stores that drift whenever Day-0 keystores or Firebase configs update.
- **Stop the runner's Paseo daemon before every GitHub Actions job:** Rejected — severs Paseo Relay observability and conflicts with concurrent human monitoring.
- **Re-implement Vault tarball decryption and `VaultEnvelope` parsing inside `factory-release-lab`:** Rejected — duplicates `src/vault-envelope.ts` and `src/vault-materialization.ts` across repositories and drifts whenever Vault formats evolve.

## Consequences

- `factory-release-lab` ADR 0006 `Worker preflight` can run `factory vault hydrate --runtime-only --project "$GITHUB_WORKSPACE" --app "$CANONICAL_APP_KEY"` safely regardless of Paseo daemon state on the runner.
- `Private vault` remains the single source of truth for ASC keys, Google Play JSON, Android keystores, Firebase configs, and `.env.local`.
- Unrelated local checkouts and live daemon Ledger ownership remain completely isolated from CI runner hydration.
