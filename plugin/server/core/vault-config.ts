import { FactoryError } from "./errors.ts";
import { LedgerAdmission } from "./history-admission.ts";
import type { ImportStatus } from "./history-stage.ts";
import { resolveVaultPassphrase } from "./vault-envelope.ts";
import { readVaultHistoryStatus } from "./vault-history.ts";
import { hydratedAppKeys } from "./vault-materialization.ts";
import type { VaultGhAuthStatus } from "./vault-transport.ts";
import { readFileSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export interface VaultConfig {
  repo: string; // e.g. "daymanondev/factory-vault" or local git path for tests
  branch: string; // default "main"
  nodeId: string; // defaults to os.hostname() normalized to [a-z0-9-]
  passphrase?: string; // optional; stored with 0o600 permissions
  lastHydratedAt?: string;
  lastHydrateMode?: "direct" | "sync";
  lastPushedAt?: string;
}

export interface VaultRuntimeEnv {
  ASC_KEY_PATH?: string;
  ASC_KEY_ID?: string;
  ASC_ISSUER?: string;
  GPLAY_KEY_PATH?: string;
  RELEASE_LAB_KEYSTORE_STOREPASS?: string;
  FIREBASE_PROJECT_ID?: string;
}

export interface VaultStatusView {
  /** Durable writer admission; transport timestamps do not imply application. */
  historyImports?: ImportStatus[];
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

/** Parity with `stateDirFor` (`plugin/server/paths.ts`) — the core cannot import the plugin shell. */
export const STATE_PLUGIN_DIR = "paseo-factory";

/** The shared-secret file names the status view probes under `<paseoHome>/vault-runtime/secrets/` (ADR 0014 Decision 4). */
export const SHARED_SECRET_FILES = {
  ascKey: "asc-api-key.p8",
  ascCredentials: "asc-credentials.json",
  gplayServiceAccount: "gplay-service-account.json",
  eyeConfig: "eye.json",
} as const;

/**
 * Reads `<paseoHome>/plugin-state/paseo-factory/vault-config.json`.
 * `null` when the file is absent (an unconfigured home); damage is refused
 * with `corrupted-vault-config`, never guessed at. `branch` and `nodeId`
 * defaults are re-applied on read for hand-edited configs.
 */
export function loadVaultConfig(paseoHome: string): VaultConfig | null {
  let raw: string;
  try {
    raw = readFileSync(vaultConfigPath(paseoHome), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FactoryError("corrupted-vault-config", `${vaultConfigPath(paseoHome)} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as { repo?: unknown }).repo !== "string") {
    throw new FactoryError("corrupted-vault-config", `${vaultConfigPath(paseoHome)} is not a vault config (repo must be a string)`);
  }
  return withConfigDefaults(parsed as Partial<VaultConfig> & Pick<VaultConfig, "repo">);
}

/**
 * Persists the config to `<paseoHome>/plugin-state/paseo-factory/vault-config.json`
 * with `0o600` (tightened even over a pre-existing loose file), filling
 * `branch: "main"` and the hostname-derived `nodeId` when absent. Returns the
 * full persisted config.
 */
export function saveVaultConfig(paseoHome: string, config: Partial<VaultConfig> & Pick<VaultConfig, "repo">): VaultConfig {
  return LedgerAdmission.stateMutation(vaultStateDir(paseoHome), () => {
    const full = withConfigDefaults(config);
    const path = vaultConfigPath(paseoHome);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return full;
  });
}

/**
 * Builds the `VaultStatusView` for a paseo home: config fields (defaults on a
 * fresh home), the `<paseoHome>/vault/.git` clone probe, the shared-secret
 * readiness pills under `<paseoHome>/vault-runtime/secrets/`, and
 * `hasPassphrase` walking the full ADR 0014 Decision 3 chain (explicit →
 * `FACTORY_VAULT_PASSPHRASE` → persisted config). A damaged config surfaces
 * in `error` instead of crashing the read. `hydratedApps` lists the canonical
 * app keys with secrets hydrated under `vault-runtime/secrets/apps/`.
 */
export function readVaultStatus(paseoHome: string, passphrase?: string, ghAuth?: VaultGhAuthStatus): VaultStatusView {
  let config: VaultConfig | null = null;
  let error: string | null = null;
  try {
    config = loadVaultConfig(paseoHome);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const configured = config !== null && config.repo.trim() !== "";
  return {
    configured,
    ...(readVaultHistoryStatus(paseoHome).length > 0 ? { historyImports: readVaultHistoryStatus(paseoHome) } : {}),
    repo: configured && config !== null ? config.repo : null,
    branch: config?.branch ?? "main",
    nodeId: config?.nodeId ?? normalizeNodeId(hostname()),
    hasPassphrase: resolveVaultPassphrase(config?.passphrase, passphrase) !== undefined,
    cloneExists: existsSync(join(paseoHome, "vault", ".git")),
    lastHydratedAt: config?.lastHydratedAt ?? null,
    lastHydrateMode: config?.lastHydrateMode ?? null,
    lastPushedAt: config?.lastPushedAt ?? null,
    sharedSecrets: {
      ascKey: sharedSecretExists(paseoHome, SHARED_SECRET_FILES.ascKey),
      ascCredentials: sharedSecretExists(paseoHome, SHARED_SECRET_FILES.ascCredentials),
      gplayServiceAccount: sharedSecretExists(paseoHome, SHARED_SECRET_FILES.gplayServiceAccount),
      eyeConfig: sharedSecretExists(paseoHome, SHARED_SECRET_FILES.eyeConfig),
    },
    hydratedApps: hydratedAppKeys(paseoHome),
    ghInstalled: ghAuth?.ghInstalled ?? false,
    ghAuthenticated: ghAuth?.ghAuthenticated ?? false,
    ghUser: ghAuth?.ghUser ?? null,
    suggestedRepo: ghAuth?.suggestedRepo ?? null,
    error,
  };
}

/** `<paseoHome>/plugin-state/paseo-factory/vault-config.json` — the spec's exact config location. */
export function vaultConfigPath(paseoHome: string): string {
  return join(paseoHome, "plugin-state", STATE_PLUGIN_DIR, "vault-config.json");
}

/** Any hostname (or caller-supplied nodeId) as a legal `[a-z0-9-]` path/label segment; "node" when nothing survives. */
export function normalizeNodeId(raw: string): string {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized !== "" ? normalized : "node";
}

/** Fills `branch`/`nodeId` defaults; optional fields stay absent, never `undefined`-present. */
export function withConfigDefaults(config: Partial<VaultConfig> & Pick<VaultConfig, "repo">): VaultConfig {
  return {
    repo: config.repo,
    branch: config.branch !== undefined && config.branch !== "" ? config.branch : "main",
    nodeId: config.nodeId !== undefined && config.nodeId !== "" ? normalizeNodeId(config.nodeId) : normalizeNodeId(hostname()),
    ...(config.passphrase === undefined ? {} : { passphrase: config.passphrase }),
    ...(config.lastHydratedAt === undefined ? {} : { lastHydratedAt: config.lastHydratedAt }),
    ...(config.lastHydrateMode === undefined ? {} : { lastHydrateMode: config.lastHydrateMode }),
    ...(config.lastPushedAt === undefined ? {} : { lastPushedAt: config.lastPushedAt }),
  };
}

/** Probes one shared-secret file under `<paseoHome>/vault-runtime/secrets/` — both the flat and the three-tier `secrets/shared/` spot (ADR 0014 Decision 4). */
export function sharedSecretExists(paseoHome: string, name: string): boolean {
  const secrets = join(paseoHome, "vault-runtime", "secrets");
  return existsSync(join(secrets, name)) || existsSync(join(secrets, "shared", name));
}

/** The config every sync-transport call needs, or the honest refusal. */
export function requiredVaultConfig(paseoHome: string): VaultConfig {
  const config = loadVaultConfig(paseoHome);
  if (config === null || config.repo.trim() === "") {
    throw new FactoryError(
      "vault-not-configured",
      "Private vault is not configured yet — click Enable & Sync Vault or save a repository in Vault settings",
    );
  }
  return config;
}

/** Merges hydration/push stamps into the persisted config, preserving every other field. */
export function stampVaultConfig(
  paseoHome: string,
  prior: VaultConfig | null,
  fallbackRepo: string,
  stamps: { lastHydratedAt?: string; lastHydrateMode?: "direct" | "sync"; lastPushedAt?: string },
): void {
  const merged = {
    lastHydratedAt: stamps.lastHydratedAt ?? prior?.lastHydratedAt,
    lastHydrateMode: stamps.lastHydrateMode ?? prior?.lastHydrateMode,
    lastPushedAt: stamps.lastPushedAt ?? prior?.lastPushedAt,
  };
  saveVaultConfig(paseoHome, {
    repo: prior?.repo ?? fallbackRepo,
    ...(prior?.branch === undefined ? {} : { branch: prior.branch }),
    ...(prior?.nodeId === undefined ? {} : { nodeId: prior.nodeId }),
    ...(prior?.passphrase === undefined ? {} : { passphrase: prior.passphrase }),
    ...(merged.lastHydratedAt === undefined ? {} : { lastHydratedAt: merged.lastHydratedAt }),
    ...(merged.lastHydrateMode === undefined ? {} : { lastHydrateMode: merged.lastHydrateMode }),
    ...(merged.lastPushedAt === undefined ? {} : { lastPushedAt: merged.lastPushedAt }),
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** `<paseoHome>/plugin-state/paseo-factory` — the core's own stateDir (parity with the shell's `stateDirFor`). */
export function vaultStateDir(paseoHome: string): string {
  return join(paseoHome, "plugin-state", STATE_PLUGIN_DIR);
}
