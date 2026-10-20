/**
 * The Private-vault mirror's declaration — see vault.mjs for why it exists
 * (plain .mjs, no build step, no src/ imports per ADR 0004).
 * test/vault-cli.test.ts pins this mirror to src/vault.ts: envelope
 * round-trips byte-for-byte, `vault status` equal to readVaultStatus, and
 * the hydrate/pull runtime trees identical to the core's transports.
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

export declare function sealVaultBuffer(plain: Buffer, passphrase?: string): VaultEnvelope;
export declare function unsealVaultBuffer(rawOrEnvelope: Buffer, passphrase?: string): Buffer;
export declare function loadVaultConfig(paseoHome: string): VaultConfig | null;
export declare function saveVaultConfig(
  paseoHome: string,
  config: Partial<VaultConfig> & Pick<VaultConfig, "repo">,
): VaultConfig;
export declare function readVaultStatus(paseoHome: string, passphrase?: string): VaultStatusView;
export declare function hydrateVaultDirect(
  paseoHome: string,
  options?: { repo?: string; ref?: string; token?: string },
): Promise<{ repo: string; ref: string; hydratedFiles: string[] }>;
export declare function pullVault(paseoHome: string): Promise<{ hydratedFiles: string[] }>;
export declare function pushVault(
  paseoHome: string,
  options?: { includeLedger?: boolean },
): Promise<{ pushedFiles: string[]; pushed: boolean }>;
export declare function sealVaultFile(
  paseoHome: string,
  sourcePath: string,
  vaultPath: string,
  passphrase?: string,
): { vaultPath: string; mode: "obfuscated" | "aes-256-gcm"; source: string; envelopeBytes: number };
