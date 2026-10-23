import { FactoryError } from "./errors.ts";
import { LedgerAdmission } from "./history-admission.ts";
import { updateImportMaterialization } from "./history-stage.ts";
import type { ImportMaterialization, ImportStatus } from "./history-stage.ts";
import type { VaultConfig } from "./vault-config.ts";
import { loadVaultConfig, stampVaultConfig, nowIso, requiredVaultConfig, vaultStateDir, saveVaultConfig, withConfigDefaults } from "./vault-config.ts";
import { resolveVaultPassphrase, unsealVaultBuffer, stageRuntimeFileIntoCheckout } from "./vault-envelope.ts";
import { snapshotVaultLedger, refreshVaultImports, stageFetchedVaultHistory, listDirNames } from "./vault-history.ts";
import { writeRuntimeFile, applyVaultHydration, assertSafeVaultPath, collectLocalStateIntoRuntime, walkFiles, resolveVaultApps, readVaultManifestAt } from "./vault-materialization.ts";
import { githubRepoSlug, builtinVaultRunner, parseTarEntries, vaultPathFromArchivePath, isEmptyOrUnbornPullError, ensureVaultCheckout, probeGhAuth, ensureRemoteVaultRepo } from "./vault-transport.ts";
import type { VaultRunner } from "./vault-transport.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { gunzipSync } from "node:zlib";

export type { VaultEnvelope } from "./vault-envelope.ts";
export type { VaultConfig } from "./vault-config.ts";
export type { VaultRuntimeEnv } from "./vault-config.ts";
export type { VaultGhAuthStatus } from "./vault-transport.ts";
export type { VaultStatusView } from "./vault-config.ts";
export { sealVaultBuffer } from "./vault-envelope.ts";
export { unsealVaultBuffer } from "./vault-envelope.ts";
export { loadVaultConfig } from "./vault-config.ts";
export { saveVaultConfig, withConfigDefaults } from "./vault-config.ts";
export { readVaultStatus } from "./vault-config.ts";
export type { VaultRunnerCall } from "./vault-transport.ts";
export type { VaultRunner } from "./vault-transport.ts";
export { buildVaultPath } from "./vault-transport.ts";
export { createDefaultVaultRunner } from "./vault-transport.ts";
export { clearGhAuthCache } from "./vault-transport.ts";
export { probeGhAuth } from "./vault-transport.ts";
export { ensureRemoteVaultRepo } from "./vault-transport.ts";
export { isLocalCompanionGitSource } from "./vault-transport.ts";
export type { CompanionGitRemote } from "./vault-transport.ts";
export { normalizeCompanionGitRemote } from "./vault-transport.ts";
export { probeCompanionGitAccess } from "./vault-transport.ts";
export { importVaultSecrets, sealVaultFile } from "./vault-secrets.ts";
export type { VaultManifestEntry } from "./vault-materialization.ts";
export type { VaultManifest } from "./vault-materialization.ts";
export type { ResolvedVaultApp } from "./vault-materialization.ts";
export { parseVaultManifest } from "./vault-materialization.ts";
export { resolveVaultApps } from "./vault-materialization.ts";
export { ensureLocalGitExcludeAndWorktreeInclude } from "./vault-materialization.ts";
export type { VaultLedgerSource } from "./vault-history.ts";
export { reconcileVaultLedgers } from "./vault-history.ts";

export interface VaultTransportOptions {
  runner?: VaultRunner;
}

export interface HydrateVaultDirectOptions extends VaultTransportOptions {
  /**
   * Defaults to the persisted config's repo. On a home with no saved config
   * the override is persisted as the vault config of record — the hydrate
   * that named the repo is the hydrate that configured the home.
   */
  repo?: string;
  /** The tarball ref — defaults to the configured branch (`main` on a fresh config). */
  ref?: string;
  /** An explicit GitHub token; absent means the machine's `gh auth login` session. */
  token?: string;
  /** Reconcile the vault's `state/nodes/*` ledger snapshots into this machine's ledgers after hydrating (stage C). */
  mergeLedgers?: boolean;
  /** Overwrite existing local `lanes.json`, `fleet.json`, and `free-pool.json` files with the vault's copies (default false). */
  overwriteConfigs?: boolean;
}

export interface PullVaultOptions extends VaultTransportOptions {
  /**
   * Reconcile the vault's `state/nodes/*` ledger snapshots into this
   * machine's global and per-project ledgers through `reconcileVaultLedgers`
   * after hydrating (spec §Implementation Decisions 2).
   */
  mergeLedgers?: boolean;
  /** Overwrite existing local `lanes.json`, `fleet.json`, and `free-pool.json` files with the vault's copies (default false). */
  overwriteConfigs?: boolean;
}

export interface PushVaultOptions extends VaultTransportOptions {
  /**
   * Snapshot this machine's ledgers under its node namespace before pushing:
   * the global `<stateDir>/ledger.jsonl` as `state/nodes/<nodeId>/global-ledger.jsonl`
   * and every per-project `<stateDir>/projects/<local-slug>/ledger.jsonl` as
   * `state/nodes/<nodeId>/projects/<canonicalAppKey>/ledger.jsonl` (the slug
   * stands in for the key when `vault.manifest.json` does not route it).
   */
  includeLedger?: boolean;
}

export interface SyncVaultOptions extends VaultTransportOptions {
  repo?: string;
  branch?: string;
  passphrase?: string;
  mergeLedgers?: boolean;
  includeLedger?: boolean;
  overwriteConfigs?: boolean;
}

export interface SyncVaultResult {
  materialization?: ImportMaterialization;
  historyImports?: ImportStatus[];
  createdRepo: boolean;
  repo: string;
  branch: string;
  hydratedFiles: string[];
  pushedFiles: string[];
  pushed: boolean;
  summary: string;
}

export interface ImportVaultSecretsInput extends VaultTransportOptions {
  ascKeyPath?: string;
  ascKeyId?: string;
  ascIssuer?: string;
  gplayKeyPath?: string;
  eyeConfigPath?: string;
  appKey?: string;
  keystorePath?: string;
  storePass?: string;
  keyAlias?: string;
  firebaseProjectId?: string;
  googleServicesJsonPath?: string;
  googleServiceInfoPlistPath?: string;
  syncAfterImport?: boolean;
}

export interface ImportVaultSecretsResult {
  importedFiles: string[];
  synced: SyncVaultResult | null;
  summary: string;
}

export interface VaultHydrationResult {
  materialization?: ImportMaterialization;
  historyImports?: ImportStatus[];
  repo?: string;
  ref?: string;
  /** The vault-relative paths written under `<paseoHome>/vault-runtime/`, sorted. */
  hydratedFiles: string[];
}

export interface VaultPushResult {
  /** The vault-relative paths packaged into `<paseoHome>/vault`, sorted. */
  pushedFiles: string[];
  /** Whether a new commit was pushed to the remote (false when the tree was already clean). */
  pushed: boolean;
}

/**
 * Mode A — `Direct hydrate` (ADR 0014 Decision 2): streams
 * `GET /repos/{owner}/{repo}/tarball/{ref}` through `gh api` (the machine's
 * `gh auth login` session, or an explicit token), gunzips and walks the tar
 * entries in memory (`node:zlib`, no external tar library), unseals each
 * entry through `unsealVaultBuffer`, and writes the three-tier layout into
 * `<paseoHome>/vault-runtime/` (`0o600` under `secrets/`). `<paseoHome>/vault`
 * is never touched — no `.git` checkout exists on disk after this call.
 */
export async function hydrateVaultDirect(paseoHome: string, options: HydrateVaultDirectOptions = {}): Promise<VaultHydrationResult & { repo: string; ref: string }> {
  const config = loadVaultConfig(paseoHome);
  const repo = options.repo ?? config?.repo;
  if (repo === undefined || repo.trim() === "") {
    throw new FactoryError(
      "vault-not-configured",
      "Private vault is not configured yet — click Enable & Sync Vault or save a repository in Vault settings",
    );
  }
  const slug = githubRepoSlug(repo);
  const ref = options.ref ?? config?.branch ?? "main";
  const runner = options.runner ?? builtinVaultRunner;
  const env = options.token !== undefined && options.token !== "" ? { GH_TOKEN: options.token } : undefined;

  const tarball = await runner({ command: "gh", args: ["api", `repos/${slug}/tarball/${ref}`], env });
  const archive = tarball.length > 2 && tarball[0] === 0x1f && tarball[1] === 0x8b ? gunzipSync(tarball) : tarball;

  const files = new Map<string, Buffer>();
  for (const entry of parseTarEntries(archive)) {
    const path = vaultPathFromArchivePath(entry.path);
    if (path === null) continue;
    assertSafeVaultPath(path);
    files.set(path, unsealVaultBuffer(entry.data, resolveVaultPassphrase(config?.passphrase)));
  }
  return { repo, ref, ...await materializeFetchedVault(paseoHome, files, options, () => stampVaultConfig(paseoHome, config, repo, { lastHydratedAt: nowIso(), lastHydrateMode: "direct" })) };

}

/**
 * Mode B, hydrating leg — `Vault sync`: `git clone` when `<paseoHome>/vault`
 * is absent, else `git pull --rebase --autostash`, then hydrate
 * `<paseoHome>/vault-runtime/` from the checkout (every file unsealed,
 * `0o600` under `secrets/`, `.git` never walked). Stamps
 * `lastHydrateMode: "sync"`.
 */
export async function pullVault(paseoHome: string, options: PullVaultOptions = {}): Promise<VaultHydrationResult> {
  return pullConfiguredVault(paseoHome, requiredVaultConfig(paseoHome), options);
}

async function pullConfiguredVault(paseoHome: string, config: VaultConfig, options: PullVaultOptions, configure = false): Promise<VaultHydrationResult> {
  const runner = options.runner ?? builtinVaultRunner;
  const vaultDir = join(paseoHome, "vault");

  if (existsSync(join(vaultDir, ".git"))) {
    try {
      await runner({ command: "git", args: ["pull", "--rebase", "--autostash"], cwd: vaultDir });
    } catch (err) {
      if (!isEmptyOrUnbornPullError(err)) throw err;
      try {
        await runner({ command: "git", args: ["pull", "--rebase", "--autostash", "origin", config.branch], cwd: vaultDir });
      } catch (retryErr) {
        if (!isEmptyOrUnbornPullError(retryErr)) throw retryErr;
      }
    }
  } else {
    await ensureVaultCheckout(runner, config, vaultDir);
  }

  const files = new Map<string, Buffer>();
  for (const path of walkFiles(vaultDir, () => false)) {
    assertSafeVaultPath(path);
    files.set(path, unsealVaultBuffer(readFileSync(join(vaultDir, path)), resolveVaultPassphrase(config.passphrase)));
  }
  return materializeFetchedVault(paseoHome, files, options, () => {
    if (configure) saveVaultConfig(paseoHome, config);
    stampVaultConfig(paseoHome, config, config.repo, { lastHydratedAt: nowIso(), lastHydrateMode: "sync" });
  });

}

/**
 * Mode B, publishing leg — `Vault push`: ensures the cached checkout at
 * `<paseoHome>/vault` (cloning when absent), packages the `vault-runtime`
 * tree into it under the push-side re-seal law (`stageRuntimeFileIntoCheckout`
 * — envelopes are never overwritten with their own unsealed plaintext),
 * snapshots the global ledger under this node's namespace when `includeLedger`
 * is set, commits (nothing when the tree is clean — no empty commits) and
 * pushes to the configured remote. Stamps `lastPushedAt`.
 */
export async function pushVault(paseoHome: string, options: PushVaultOptions = {}): Promise<VaultPushResult> {
  const config = requiredVaultConfig(paseoHome);
  const runner = options.runner ?? builtinVaultRunner;
  const vaultDir = join(paseoHome, "vault");

  await ensureVaultCheckout(runner, config, vaultDir);
  const pushedFiles = await LedgerAdmission.withStateMaintenance(vaultStateDir(paseoHome), () => {
    collectLocalStateIntoRuntime(paseoHome);

    const runtimeRoot = join(paseoHome, "vault-runtime");
    const staged = existsSync(runtimeRoot) ? walkFiles(runtimeRoot, (rel) => rel === "env.json") : [];
    const passphrase = resolveVaultPassphrase(config.passphrase);
    for (const rel of staged) {
      stageRuntimeFileIntoCheckout(join(runtimeRoot, rel), join(vaultDir, rel), passphrase, rel);
    }
    const pushedFiles = new Set(staged);
    if (options.includeLedger) {
      const stateDir = vaultStateDir(paseoHome);
      const globalLedger = join(stateDir, "ledger.jsonl");
      if (existsSync(globalLedger)) {
        const target = join(vaultDir, "state", "nodes", config.nodeId, "global-ledger.jsonl");
        mkdirSync(dirname(target), { recursive: true });
        snapshotVaultLedger(globalLedger, target);
        pushedFiles.add(`state/nodes/${config.nodeId}/global-ledger.jsonl`);
      }
      // per-project ledgers ride under the canonical app key the vault's manifest
      // routes this slug to — the slug itself when the manifest does not know it
      const slugToKey = new Map<string, string>();
      for (const app of resolveVaultApps(paseoHome, readVaultManifestAt(vaultDir))) {
        if (app.projectSlug !== null) slugToKey.set(app.projectSlug, app.canonicalAppKey);
      }
      for (const slug of listDirNames(join(stateDir, "projects"))) {
        const projectLedger = join(stateDir, "projects", slug, "ledger.jsonl");
        if (!existsSync(projectLedger)) continue;
        const key = slugToKey.get(slug) ?? slug;
        const target = join(vaultDir, "state", "nodes", config.nodeId, "projects", key, "ledger.jsonl");
        mkdirSync(dirname(target), { recursive: true });
        snapshotVaultLedger(projectLedger, target);
        pushedFiles.add(`state/nodes/${config.nodeId}/projects/${key}/ledger.jsonl`);
      }
    }

      return pushedFiles;
  });

  const status = (await runner({ command: "git", args: ["status", "--porcelain"], cwd: vaultDir })).toString("utf8").trim();
  const pushed = status !== "";
  if (pushed) {
    await runner({ command: "git", args: ["add", "-A"], cwd: vaultDir });
    await runner({
      command: "git",
      args: ["-c", "user.name=paseo-factory", "-c", "user.email=vault@paseo-factory.invalid", "commit", "-m", `vault push from ${config.nodeId}`],
      cwd: vaultDir,
    });
    await runner({ command: "git", args: ["push", "origin", config.branch], cwd: vaultDir });
  }

  stampVaultConfig(paseoHome, config, config.repo, { lastPushedAt: nowIso() });
  return { pushedFiles: [...pushedFiles].sort(), pushed };
}

/**
 * Unified smart bidirectional sync (spec §Implementation Decisions 3):
 * 1. Auto-selects `<ghUser>/factory-vault` via `probeGhAuth` when unconfigured.
 * 2. Persists `vault-config.json` and ensures the remote repository exists via `ensureRemoteVaultRepo`.
 * 3. Runs `pullVault` (hydrating secrets, materializing configs, and reconciling multi-node ledgers).
 * 4. Runs `pushVault` (collecting local configs/state/store-manifests and node ledgers, then pushing).
 */
export async function syncVault(paseoHome: string, options: SyncVaultOptions = {}): Promise<SyncVaultResult> {
  const existing = loadVaultConfig(paseoHome);
  let repo = options.repo !== undefined && options.repo.trim() !== "" ? options.repo.trim() : existing?.repo?.trim() ?? "";
  if (repo === "") {
    const gh = await probeGhAuth(options.runner);
    if (gh.ghAuthenticated && gh.suggestedRepo !== null && gh.suggestedRepo.trim() !== "") {
      repo = gh.suggestedRepo.trim();
    } else {
      throw new FactoryError(
        "vault-not-configured",
        "Private vault is not configured yet — run `gh auth login --web -p https` then click Enable & Sync Vault or save a repository in Vault settings",
      );
    }
  }

  const branch = options.branch !== undefined && options.branch.trim() !== "" ? options.branch.trim() : existing?.branch ?? "main";
  const passphrase =
    options.passphrase === undefined ? existing?.passphrase : options.passphrase === "" ? undefined : options.passphrase;

  const ensured = await ensureRemoteVaultRepo(repo, options.runner);
  repo = ensured.repo;

  const desired = withConfigDefaults({
    repo,
    branch,
    ...(existing?.nodeId === undefined ? {} : { nodeId: existing.nodeId }),
    ...(passphrase === undefined ? {} : { passphrase }),
    ...(existing?.lastHydratedAt === undefined ? {} : { lastHydratedAt: existing.lastHydratedAt }),
    ...(existing?.lastHydrateMode === undefined ? {} : { lastHydrateMode: existing.lastHydrateMode }),
    ...(existing?.lastPushedAt === undefined ? {} : { lastPushedAt: existing.lastPushedAt }),
  });

  const pullResult = await pullConfiguredVault(paseoHome, desired, {
    mergeLedgers: options.mergeLedgers ?? true,
    overwriteConfigs: options.overwriteConfigs ?? false,
    runner: options.runner,
  }, true);

  const pushResult = pullResult.materialization?.status === "refused" ? { pushedFiles: [], pushed: false } : await pushVault(paseoHome, {
    includeLedger: options.includeLedger ?? true,
    runner: options.runner,
  });

  const createdNote = ensured.created ? `created private repo ${repo}; ` : "";
  const pushNote = pullResult.materialization?.status === "refused" ? "push deferred until materialization" : pushResult.pushed
    ? `pushed ${pushResult.pushedFiles.length} file(s)`
    : `up to date (${pushResult.pushedFiles.length} file(s) tracked)`;
  const summary = `Vault ${pullResult.materialization?.status === "refused" ? "fetched from" : "synced with"} ${repo} (${branch}): ${createdNote}hydrated ${pullResult.hydratedFiles.length} file(s), ${pushNote}; history ${(pullResult.historyImports ?? []).map((item) => item.status).join(", ") || "not requested"}; materialization ${pullResult.materialization?.status ?? "applied"}.`;

  return {
    createdRepo: ensured.created,
    historyImports: pullResult.historyImports,
    materialization: pullResult.materialization,
    repo,
    branch,
    hydratedFiles: pullResult.hydratedFiles,
    pushedFiles: pushResult.pushedFiles,
    pushed: pushResult.pushed,
    summary,
  };
}

/** Fetch/staging is independent; this lease covers only associated local mutations. */
async function materializeFetchedVault(paseoHome: string, files: ReadonlyMap<string, Buffer>, options: Pick<HydrateVaultDirectOptions, "mergeLedgers" | "overwriteConfigs">, stamp: () => void): Promise<VaultHydrationResult> {
  const historyImports = options.mergeLedgers === true ? stageFetchedVaultHistory(paseoHome, files) : [];
  try {
    await LedgerAdmission.withStateMaintenance(vaultStateDir(paseoHome), () => {
      for (const [path, bytes] of files) writeRuntimeFile(paseoHome, path, bytes);
      applyVaultHydration(paseoHome, options.overwriteConfigs ?? false);
      stamp();
      updateImportMaterialization(historyImports, { status: "applied", diagnostics: ["associated Vault files materialized by the owner maintenance boundary"] });
    });
    return { hydratedFiles: [...files.keys()].sort(), historyImports: refreshVaultImports(historyImports), materialization: { status: "applied", diagnostics: [] } };
  } catch (error) {
    const materialization: ImportMaterialization = { status: "refused", diagnostics: [error instanceof Error ? error.message : String(error)] };
    updateImportMaterialization(historyImports, materialization);
    if (!(error instanceof FactoryError) || !["vault-owner-required", "upgrade-recovery-required"].includes(error.code) || historyImports.length === 0) throw error;
    return { hydratedFiles: [], historyImports: refreshVaultImports(historyImports), materialization };
  }
}
