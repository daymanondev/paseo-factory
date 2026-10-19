import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { FactoryError } from "./errors.ts";

/**
 * The Private vault engine, stage A (ADR 0014 Decisions 1 & 3): dual-mode
 * secret envelopes, `VaultConfig` persistence, and the status read.
 *
 * Pure Node built-ins only — `node:crypto`, `node:fs`, `node:path`,
 * `node:os`; zero npm or binary dependencies. The transports (`gh api`
 * streams, cached git checkouts) and the multi-node `Ledger` reconciler
 * arrive with stage B and build on this interface.
 *
 * Dual-mode law: a vault file is either raw plaintext/binary (returned
 * unchanged — Plaintext Direct mode), a zero-passphrase `obfuscated`
 * envelope (the GitHub Secret Scanning shield for Google Cloud Service
 * Account JSONs), or a passphrase-locked `aes-256-gcm` envelope
 * (`scryptSync` + GCM, refused with `vault-passphrase-required` /
 * `vault-decrypt-failed` when the passphrase is missing or wrong).
 *
 * Passphrase resolution follows ADR 0014 Decision 3: explicit argument →
 * `FACTORY_VAULT_PASSPHRASE` → the `0o600` persisted config. The persisted
 * leg lives in `readVaultStatus` and in the stage-B hydration engine, which
 * owns the paseo home; `unsealVaultBuffer` (no home in its signature)
 * resolves the first two legs, and its callers thread the persisted
 * passphrase in as the explicit argument.
 */

export interface VaultEnvelope {
  v: 1;
  mode: "obfuscated" | "aes-256-gcm";
  /** Present when mode === "aes-256-gcm" (base64 16-byte scrypt salt, 12-byte iv, 16-byte auth tag). */
  salt?: string;
  iv?: string;
  tag?: string;
  /** Base64 payload bytes. */
  data: string;
}

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
  error: string | null;
}

/**
 * The obfuscation mask — a fixed repeating key XORed over the payload before
 * base64. Base64 alone already hides PEM markers from pattern scanners; the
 * mask additionally defeats a scanner that decodes base64 and re-scans, at
 * zero cost to the zero-passphrase promise (obfuscation deters scanning, it
 * never claims secrecy — secrecy is the `aes-256-gcm` mode's job).
 */
const OBFUSCATION_MASK = Buffer.from("paseo-factory-vault-obfuscation-v1", "utf8");

/** Parity with `stateDirFor` (`plugin/server/paths.ts`) — the core cannot import the plugin shell. */
const STATE_PLUGIN_DIR = "paseo-factory";

/** The shared-secret file names the status view probes under `<paseoHome>/vault-runtime/secrets/` (ADR 0014 Decision 4). */
const SHARED_SECRET_FILES = {
  ascKey: "asc-api-key.p8",
  ascCredentials: "asc-credentials.json",
  gplayServiceAccount: "gplay-service-account.json",
  eyeConfig: "eye.json",
} as const;

/** Seals `plain`: no passphrase → the zero-passphrase `obfuscated` envelope; a passphrase → `aes-256-gcm`. */
export function sealVaultBuffer(plain: Buffer, passphrase?: string): VaultEnvelope {
  if (passphrase !== undefined && passphrase !== "") {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return {
      v: 1,
      mode: "aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }
  return { v: 1, mode: "obfuscated", data: xorMask(plain).toString("base64") };
}

/**
 * Unseals a vault file three ways: a buffer that is not a JSON
 * `VaultEnvelope` with `v: 1` comes back unchanged (Plaintext Direct mode);
 * `obfuscated` decodes and unmasks with zero passphrase; `aes-256-gcm`
 * decrypts via `scryptSync(passphrase, salt, 32)` + GCM, refusing with
 * `vault-passphrase-required` / `vault-decrypt-failed` when the passphrase
 * (explicit argument, else `FACTORY_VAULT_PASSPHRASE`) is missing or wrong.
 */
export function unsealVaultBuffer(rawOrEnvelope: Buffer, passphrase?: string): Buffer {
  const envelope = parseEnvelope(rawOrEnvelope);
  if (envelope === null) return rawOrEnvelope;

  if (envelope.mode === "obfuscated") {
    return xorMask(Buffer.from(envelope.data, "base64"));
  }

  const pass = resolveVaultPassphrase(undefined, passphrase);
  if (pass === undefined) {
    throw new FactoryError(
      "vault-passphrase-required",
      "this vault envelope is sealed with a passphrase (aes-256-gcm) — pass one or set FACTORY_VAULT_PASSPHRASE",
    );
  }
  const salt = decodeEnvelopeField(envelope, "salt", 16);
  const iv = decodeEnvelopeField(envelope, "iv", 12);
  const tag = decodeEnvelopeField(envelope, "tag", 16);
  const data = Buffer.from(envelope.data, "base64");
  try {
    const key = scryptSync(pass, salt, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new FactoryError("vault-decrypt-failed", "the vault envelope did not decrypt — wrong passphrase or damaged envelope");
  }
}

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
  const full = withConfigDefaults(config);
  const path = vaultConfigPath(paseoHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return full;
}

/**
 * Builds the `VaultStatusView` for a paseo home: config fields (defaults on a
 * fresh home), the `<paseoHome>/vault/.git` clone probe, the shared-secret
 * readiness pills under `<paseoHome>/vault-runtime/secrets/`, and
 * `hasPassphrase` walking the full ADR 0014 Decision 3 chain (explicit →
 * `FACTORY_VAULT_PASSPHRASE` → persisted config). A damaged config surfaces
 * in `error` instead of crashing the read. `hydratedApps` stays empty until
 * stage C routes canonical app keys.
 */
export function readVaultStatus(paseoHome: string, passphrase?: string): VaultStatusView {
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
    hydratedApps: [],
    error,
  };
}

/** `<paseoHome>/plugin-state/paseo-factory/vault-config.json` — the spec's exact config location. */
function vaultConfigPath(paseoHome: string): string {
  return join(paseoHome, "plugin-state", STATE_PLUGIN_DIR, "vault-config.json");
}

/**
 * Passphrase resolution, ADR 0014 Decision 3: explicit argument →
 * `FACTORY_VAULT_PASSPHRASE` → the persisted config. An empty string is no
 * passphrase at any leg. `undefined` when nothing resolves.
 */
function resolveVaultPassphrase(persisted: string | undefined, explicit?: string): string | undefined {
  if (explicit !== undefined && explicit !== "") return explicit;
  const env = process.env.FACTORY_VAULT_PASSPHRASE;
  if (env !== undefined && env !== "") return env;
  return persisted !== undefined && persisted !== "" ? persisted : undefined;
}

/** XOR is its own inverse — one function seals and unmasks the obfuscated payload. */
function xorMask(payload: Buffer): Buffer {
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    out[i] = payload[i]! ^ OBFUSCATION_MASK[i % OBFUSCATION_MASK.length]!;
  }
  return out;
}

/**
 * Recognizes a serialized `VaultEnvelope` (`v: 1`, known mode, string data).
 * Anything else — including an unknown future `v` — is `null`, which
 * `unsealVaultBuffer` treats as Plaintext Direct mode.
 */
function parseEnvelope(raw: Buffer): VaultEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== 1) return null;
  if (rec.mode !== "obfuscated" && rec.mode !== "aes-256-gcm") return null;
  if (typeof rec.data !== "string") return null;
  const envelope: VaultEnvelope = { v: 1, mode: rec.mode, data: rec.data };
  if (typeof rec.salt === "string") envelope.salt = rec.salt;
  if (typeof rec.iv === "string") envelope.iv = rec.iv;
  if (typeof rec.tag === "string") envelope.tag = rec.tag;
  return envelope;
}

/** Decodes one base64 GCM field at its fixed byte length — a malformed envelope is a decrypt failure. */
function decodeEnvelopeField(envelope: VaultEnvelope, field: "salt" | "iv" | "tag", length: number): Buffer {
  const value = envelope[field];
  if (typeof value !== "string") {
    throw new FactoryError("vault-decrypt-failed", `the aes-256-gcm envelope is missing its ${field}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== length) {
    throw new FactoryError("vault-decrypt-failed", `the aes-256-gcm envelope's ${field} must decode to ${length} bytes, got ${decoded.length}`);
  }
  return decoded;
}

/** Any hostname (or caller-supplied nodeId) as a legal `[a-z0-9-]` path/label segment; "node" when nothing survives. */
function normalizeNodeId(raw: string): string {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized !== "" ? normalized : "node";
}

/** Fills `branch`/`nodeId` defaults; optional fields stay absent, never `undefined`-present. */
function withConfigDefaults(config: Partial<VaultConfig> & Pick<VaultConfig, "repo">): VaultConfig {
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

/** Probes one shared-secret file under `<paseoHome>/vault-runtime/secrets/`. */
function sharedSecretExists(paseoHome: string, name: string): boolean {
  return existsSync(join(paseoHome, "vault-runtime", "secrets", name));
}
