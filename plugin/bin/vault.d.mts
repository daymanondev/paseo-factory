import type { HistoryImportSource, HistoryImportInput } from "../server/core/history-import.ts";
/**
 * The Private-vault mirror's declaration — see vault.mjs for why it exists
 * (plain .mjs, no build step, no src/ imports per ADR 0004).
 * test/vault-cli.test.ts pins this mirror to src/vault.ts.
 */

export interface VaultEnvelope {
  v: 1;
  mode: "obfuscated" | "aes-256-gcm";
  salt?: string;
  iv?: string;
  tag?: string;
  data: string;
}

export interface VaultConfig {
  repo: string;
  branch: string;
  nodeId: string;
  passphrase?: string;
  lastHydratedAt?: string;
  lastHydrateMode?: "direct" | "sync";
  lastPushedAt?: string;
}

export interface VaultGhAuthStatus {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  ghUser: string | null;
  suggestedRepo: string | null;
}

export interface VaultStatusView {
  configured: boolean;
  repo: string | null;
  branch: string;
  nodeId: string;
  hasPassphrase: boolean;
  cloneExists: boolean;
  lastHydratedAt: string | null;
  lastHydrateMode: "direct" | "sync" | null;
  lastPushedAt: string | null;
  sharedSecrets: {
    ascKey: boolean;
    ascCredentials: boolean;
    gplayServiceAccount: boolean;
    eyeConfig: boolean;
  };
  hydratedApps: string[];
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  ghUser: string | null;
  suggestedRepo: string | null;
  error: string | null;
}

export interface VaultRunnerCall {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
}

export type VaultRunner = (call: VaultRunnerCall) => Promise<Buffer>;

export interface VaultManifestEntry {
  repoBasename?: string;
  gitRemote?: string;
  bundleId?: string;
  packageName?: string;
}

export type VaultManifest = Record<string, VaultManifestEntry>;

export interface ResolvedVaultApp {
  canonicalAppKey: string;
  projectRoot: string | null;
  projectSlug: string | null;
}

export interface VaultLedgerSource extends HistoryImportSource {}

export interface SyncVaultOptions {
  repo?: string;
  branch?: string;
  passphrase?: string;
  mergeLedgers?: boolean;
  includeLedger?: boolean;
  overwriteConfigs?: boolean;
  runner?: VaultRunner;
}

export interface SyncVaultResult {
  createdRepo: boolean;
  repo: string;
  branch: string;
  hydratedFiles: string[];
  pushedFiles: string[];
  pushed: boolean;
  summary: string;
}

export interface ImportVaultSecretsInput {
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
  runner?: VaultRunner;
}

export interface ImportVaultSecretsResult {
  importedFiles: string[];
  synced: SyncVaultResult | null;
  summary: string;
}

export declare function sealVaultBuffer(plain: Buffer, passphrase?: string): VaultEnvelope;
export declare function unsealVaultBuffer(rawOrEnvelope: Buffer, passphrase?: string): Buffer;
export declare function loadVaultConfig(paseoHome: string): VaultConfig | null;
export declare function saveVaultConfig(
  paseoHome: string,
  config: Partial<VaultConfig> & Pick<VaultConfig, "repo">,
): VaultConfig;
export declare function readVaultStatus(
  paseoHome: string,
  passphrase?: string,
  ghAuth?: VaultGhAuthStatus,
): VaultStatusView;
export declare function buildVaultPath(basePath?: string): string;
export declare function createDefaultVaultRunner(): VaultRunner;
export declare function clearGhAuthCache(): void;
export declare function probeGhAuth(runner?: VaultRunner): Promise<VaultGhAuthStatus>;
export declare function ensureRemoteVaultRepo(
  repo: string,
  runner?: VaultRunner,
): Promise<{ created: boolean; repo: string }>;
export declare function hydrateVaultDirect(
  paseoHome: string,
  options?: {
    repo?: string;
    ref?: string;
    token?: string;
    mergeLedgers?: boolean;
    overwriteConfigs?: boolean;
    runner?: VaultRunner;
  },
): Promise<{ repo: string; ref: string; hydratedFiles: string[] }>;
export declare function pullVault(
  paseoHome: string,
  options?: { mergeLedgers?: boolean; overwriteConfigs?: boolean; runner?: VaultRunner },
): Promise<{ hydratedFiles: string[] }>;
export declare function pushVault(
  paseoHome: string,
  options?: { includeLedger?: boolean; runner?: VaultRunner },
): Promise<{ pushedFiles: string[]; pushed: boolean }>;
export declare function syncVault(paseoHome: string, options?: SyncVaultOptions): Promise<SyncVaultResult>;
export declare function importVaultSecrets(
  paseoHome: string,
  input?: ImportVaultSecretsInput,
): Promise<ImportVaultSecretsResult>;
export declare function sealVaultFile(
  paseoHome: string,
  sourcePath: string,
  vaultPath: string,
  passphrase?: string,
): { vaultPath: string; mode: "obfuscated" | "aes-256-gcm"; source: string; envelopeBytes: number };
export declare function parseVaultManifest(raw: string): VaultManifest;
export declare function resolveVaultApps(paseoHome: string, manifest: VaultManifest): ResolvedVaultApp[];
export declare function ensureLocalGitExcludeAndWorktreeInclude(
  projectRoot: string,
  relPaths: readonly string[],
): void;
export declare function reconcileVaultLedgers(
  existingLines: string,
  nodeLedgerLines: readonly VaultLedgerSource[],
  options?: Pick<HistoryImportInput, "bindings" | "files">,
): string;
