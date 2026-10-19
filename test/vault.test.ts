import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  loadVaultConfig,
  readVaultStatus,
  saveVaultConfig,
  sealVaultBuffer,
  unsealVaultBuffer,
} from "../src/index.ts";
import type { VaultStatusView } from "../src/index.ts";
import { disposeDir, factoryErrorCode, makeTempDir } from "./helpers.ts";

/**
 * The Private vault engine, stage A (ticket 01): dual-mode secret envelopes,
 * `VaultConfig` persistence, and the status read. Every assertion goes through
 * the top-level barrel (`../src/index.ts`) — the seam the spec names — against
 * real temp homes, never `~/.paseo` or `~/.paseo-factory`.
 */

/** A Google Cloud Service Account JSON stand-in — the file class GitHub Secret Scanning revokes. */
const GCP_SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "patigame-prod",
  private_key_id: "d1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n",
  client_email: "deploy@patigame-prod.iam.gserviceaccount.com",
});

/** The config file's exact spec location under a paseo home. */
function vaultConfigPath(paseoHome: string): string {
  return join(paseoHome, "plugin-state", "paseo-factory", "vault-config.json");
}

/** Runs `run` with FACTORY_VAULT_PASSPHRASE pinned to `value` (deleted when undefined), restoring after. */
function withVaultEnv<T>(value: string | undefined, run: () => T): T {
  const prior = process.env.FACTORY_VAULT_PASSPHRASE;
  if (value === undefined) delete process.env.FACTORY_VAULT_PASSPHRASE;
  else process.env.FACTORY_VAULT_PASSPHRASE = value;
  try {
    return run();
  } finally {
    if (prior === undefined) delete process.env.FACTORY_VAULT_PASSPHRASE;
    else process.env.FACTORY_VAULT_PASSPHRASE = prior;
  }
}

test("Plaintext Direct mode: non-envelope buffers come back unchanged", () => {
  const text = Buffer.from("-----BEGIN PRIVATE KEY-----\nplain p8 bytes\n-----END PRIVATE KEY-----\n", "utf8");
  assert.deepEqual(unsealVaultBuffer(text), text, "raw text is not unwrapped");

  const json = Buffer.from(JSON.stringify({ lanes: { default: "pi" } }), "utf8");
  assert.deepEqual(unsealVaultBuffer(json), json, "a JSON document that is not an envelope passes through");

  const binary = randomBytes(2048);
  assert.deepEqual(unsealVaultBuffer(binary), binary, "raw binary (release.keystore bytes) passes through");

  const future = Buffer.from(JSON.stringify({ v: 2, mode: "age", data: "eHl6" }), "utf8");
  assert.deepEqual(unsealVaultBuffer(future), future, "an unknown future envelope version is opaque bytes, not an error");
});

test("obfuscated envelopes round-trip text and binary payloads with zero passphrase", () => {
  const plain = Buffer.from(GCP_SERVICE_ACCOUNT, "utf8");
  const envelope = sealVaultBuffer(plain);
  assert.equal(envelope.v, 1);
  assert.equal(envelope.mode, "obfuscated");
  assert.ok(!envelope.salt && !envelope.iv && !envelope.tag, "no crypto material on the zero-passphrase mode");
  assert.deepEqual(unsealVaultBuffer(Buffer.from(JSON.stringify(envelope), "utf8")), plain, "text round-trips byte-exact");

  const keystore = randomBytes(4096);
  const binaryEnvelope = sealVaultBuffer(keystore);
  assert.equal(binaryEnvelope.mode, "obfuscated");
  assert.deepEqual(unsealVaultBuffer(Buffer.from(JSON.stringify(binaryEnvelope), "utf8")), keystore, "binary round-trips byte-exact");
});

test("the obfuscated envelope never carries the plaintext private-key marker (secret-scanning shield)", () => {
  const plain = Buffer.from(GCP_SERVICE_ACCOUNT, "utf8");
  const serialized = JSON.stringify(sealVaultBuffer(plain));
  assert.ok(!serialized.includes("PRIVATE KEY"), "no PEM marker in the envelope bytes");
  assert.ok(!serialized.includes(plain.toString("utf8")), "no plaintext in the envelope bytes");
  assert.ok(
    !serialized.includes(plain.toString("base64")),
    "the payload is masked, not merely base64-wrapped — a scanner that decodes base64 still finds nothing",
  );
});

test("aes-256-gcm envelopes round-trip with a passphrase, including binary payloads", () => {
  const plain = Buffer.from(GCP_SERVICE_ACCOUNT, "utf8");
  const envelope = sealVaultBuffer(plain, "correct-horse-battery");
  assert.equal(envelope.v, 1);
  assert.equal(envelope.mode, "aes-256-gcm");
  assert.equal(Buffer.from(envelope.salt ?? "", "base64").length, 16, "16-byte scrypt salt");
  assert.equal(Buffer.from(envelope.iv ?? "", "base64").length, 12, "12-byte GCM iv");
  assert.equal(Buffer.from(envelope.tag ?? "", "base64").length, 16, "16-byte auth tag");
  assert.deepEqual(unsealVaultBuffer(Buffer.from(JSON.stringify(envelope), "utf8"), "correct-horse-battery"), plain);

  const again = sealVaultBuffer(plain, "correct-horse-battery");
  assert.notEqual(envelope.salt, again.salt, "every seal draws fresh salt");
  assert.notEqual(envelope.iv, again.iv, "every seal draws a fresh iv");

  const keystore = randomBytes(8192);
  const binaryEnvelope = sealVaultBuffer(keystore, "correct-horse-battery");
  assert.equal(binaryEnvelope.mode, "aes-256-gcm");
  assert.deepEqual(
    unsealVaultBuffer(Buffer.from(JSON.stringify(binaryEnvelope), "utf8"), "correct-horse-battery"),
    keystore,
    "binary payload round-trips byte-exact",
  );
});

test("aes envelopes refuse a missing or wrong passphrase with stable FactoryError codes", () => {
  const plain = Buffer.from(GCP_SERVICE_ACCOUNT, "utf8");
  const raw = Buffer.from(JSON.stringify(sealVaultBuffer(plain, "correct-horse-battery")), "utf8");

  withVaultEnv(undefined, () => {
    assert.throws(() => unsealVaultBuffer(raw), factoryErrorCode("vault-passphrase-required"), "no passphrase anywhere refuses");
    assert.throws(() => unsealVaultBuffer(raw, ""), factoryErrorCode("vault-passphrase-required"), "an empty passphrase is no passphrase");
    assert.throws(() => unsealVaultBuffer(raw, "wrong-horse"), factoryErrorCode("vault-decrypt-failed"), "a wrong passphrase fails the auth tag");
  });
});

test("FACTORY_VAULT_PASSPHRASE backs the explicit passphrase; the explicit argument wins", () => {
  const plain = Buffer.from(GCP_SERVICE_ACCOUNT, "utf8");
  const raw = Buffer.from(JSON.stringify(sealVaultBuffer(plain, "correct-horse-battery")), "utf8");

  withVaultEnv("correct-horse-battery", () => {
    assert.deepEqual(unsealVaultBuffer(raw), plain, "the env var alone decrypts");
    assert.deepEqual(unsealVaultBuffer(raw, "correct-horse-battery"), plain, "explicit over matching env");
  });

  withVaultEnv("wrong-horse", () => {
    assert.deepEqual(unsealVaultBuffer(raw, "correct-horse-battery"), plain, "the explicit argument beats the environment");
    assert.throws(() => unsealVaultBuffer(raw), factoryErrorCode("vault-decrypt-failed"), "a wrong env passphrase alone still fails");
  });
});

test("saveVaultConfig persists 0o600 with branch/nodeId defaults; loadVaultConfig round-trips", (t) => {
  const home = makeTempDir();
  disposeDir(t, home);
  const configPath = vaultConfigPath(home);

  assert.equal(loadVaultConfig(home), null, "a fresh home has no config");

  const saved = saveVaultConfig(home, {
    repo: "daymanondev/factory-vault",
    passphrase: "correct-horse-battery",
    lastHydratedAt: "2026-10-20T10:00:00.000Z",
    lastHydrateMode: "direct",
    lastPushedAt: "2026-10-20T11:30:00.000Z",
  });
  assert.equal(saved.branch, "main", "branch defaults to main");
  assert.match(saved.nodeId, /^[a-z0-9-]+$/, "nodeId is hostname normalized to [a-z0-9-]");
  assert.ok(saved.nodeId.length > 0, "the normalized nodeId is never empty");

  assert.ok(existsSync(configPath), "the config lands at <paseoHome>/plugin-state/paseo-factory/vault-config.json");
  assert.equal(statSync(configPath).mode & 0o777, 0o600, "the config file is 0o600");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), saved, "the file holds exactly the returned config");
  assert.deepEqual(loadVaultConfig(home), saved, "load returns what save persisted");

  const custom = saveVaultConfig(home, { repo: "alt/vault", branch: "release", nodeId: "Mac_Studio!.local" });
  assert.equal(custom.branch, "release", "an explicit branch passes through");
  assert.equal(custom.nodeId, "mac-studio-local", "an explicit nodeId is normalized through the same [a-z0-9-] lens");

  const loose = makeTempDir();
  disposeDir(t, loose);
  const loosePath = vaultConfigPath(loose);
  mkdirSync(dirname(loosePath), { recursive: true });
  writeFileSync(loosePath, "{}\n", { mode: 0o644 });
  chmodSync(loosePath, 0o644);
  saveVaultConfig(loose, { repo: "x/y" });
  assert.equal(statSync(loosePath).mode & 0o777, 0o600, "a re-save over a loose 0644 file tightens it to 0o600");
});

test("readVaultStatus on a fresh home reports the unconfigured defaults", (t) => {
  const home = makeTempDir();
  disposeDir(t, home);

  withVaultEnv(undefined, () => {
    const status = readVaultStatus(home);
    assert.deepEqual(status, {
      configured: false,
      repo: null,
      branch: "main",
      nodeId: status.nodeId,
      hasPassphrase: false,
      cloneExists: false,
      lastHydratedAt: null,
      lastHydrateMode: null,
      lastPushedAt: null,
      sharedSecrets: { ascKey: false, ascCredentials: false, gplayServiceAccount: false, eyeConfig: false },
      hydratedApps: [],
      error: null,
    } satisfies VaultStatusView);
    assert.match(status.nodeId, /^[a-z0-9-]+$/);
    assert.ok(status.nodeId.length > 0);
    assert.equal(readVaultStatus(home).nodeId, status.nodeId, "the default nodeId is deterministic");
  });
});

test("readVaultStatus reflects a configured home: pills, clone, hydration stamps, passphrase legs", (t) => {
  const home = makeTempDir();
  disposeDir(t, home);

  saveVaultConfig(home, {
    repo: "daymanondev/factory-vault",
    branch: "release",
    nodeId: "mac-studio",
    passphrase: "correct-horse-battery",
    lastHydratedAt: "2026-10-20T10:00:00.000Z",
    lastHydrateMode: "direct",
    lastPushedAt: "2026-10-20T11:30:00.000Z",
  });
  mkdirSync(join(home, "vault", ".git"), { recursive: true });
  const secrets = join(home, "vault-runtime", "secrets");
  mkdirSync(secrets, { recursive: true });
  for (const name of ["asc-api-key.p8", "asc-credentials.json", "gplay-service-account.json", "eye.json"]) {
    writeFileSync(join(secrets, name), "fixture");
  }

  withVaultEnv(undefined, () => {
    const status = readVaultStatus(home);
    assert.deepEqual(status, {
      configured: true,
      repo: "daymanondev/factory-vault",
      branch: "release",
      nodeId: "mac-studio",
      hasPassphrase: true,
      cloneExists: true,
      lastHydratedAt: "2026-10-20T10:00:00.000Z",
      lastHydrateMode: "direct",
      lastPushedAt: "2026-10-20T11:30:00.000Z",
      sharedSecrets: { ascKey: true, ascCredentials: true, gplayServiceAccount: true, eyeConfig: true },
      hydratedApps: [],
      error: null,
    } satisfies VaultStatusView);
  });

  // the pills probe one file each, not a blanket
  const partial = makeTempDir();
  disposeDir(t, partial);
  mkdirSync(join(partial, "vault-runtime", "secrets"), { recursive: true });
  writeFileSync(join(partial, "vault-runtime", "secrets", "eye.json"), "fixture");
  assert.deepEqual(readVaultStatus(partial).sharedSecrets, {
    ascKey: false,
    ascCredentials: false,
    gplayServiceAccount: false,
    eyeConfig: true,
  });

  // hasPassphrase walks explicit argument → FACTORY_VAULT_PASSPHRASE → persisted config
  const noPersisted = makeTempDir();
  disposeDir(t, noPersisted);
  saveVaultConfig(noPersisted, { repo: "daymanondev/factory-vault" });
  withVaultEnv("env-pass", () => assert.equal(readVaultStatus(noPersisted).hasPassphrase, true, "env alone counts"));
  withVaultEnv(undefined, () => {
    assert.equal(readVaultStatus(noPersisted, "explicit-pass").hasPassphrase, true, "an explicit argument counts");
    assert.equal(readVaultStatus(noPersisted).hasPassphrase, false, "nothing to resolve means false");
  });
});

test("readVaultStatus degrades visibly over a corrupted config, never crashes", (t) => {
  const home = makeTempDir();
  disposeDir(t, home);
  const configPath = vaultConfigPath(home);
  mkdirSync(join(home, "plugin-state", "paseo-factory"), { recursive: true });
  writeFileSync(configPath, "{not json at all");

  assert.throws(() => loadVaultConfig(home), factoryErrorCode("corrupted-vault-config"), "load refuses damaged config");

  const status = readVaultStatus(home);
  assert.equal(status.configured, false);
  assert.equal(status.repo, null);
  assert.equal(status.branch, "main");
  assert.match(status.nodeId, /^[a-z0-9-]+$/);
  assert.ok(status.nodeId.length > 0);
  assert.equal(status.cloneExists, false);
  assert.deepEqual(status.sharedSecrets, { ascKey: false, ascCredentials: false, gplayServiceAccount: false, eyeConfig: false });
  assert.deepEqual(status.hydratedApps, []);
  assert.ok(typeof status.error === "string" && status.error.length > 0, "the damage is visible in error, not silent");
});
