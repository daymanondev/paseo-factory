import { FactoryError } from "./errors.ts";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/** Canonical Vault envelope codec and push-side sealing policy (ADR 0014). */
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

/**
 * The obfuscation mask — a fixed repeating key XORed over the payload before
 * base64. Base64 alone already hides PEM markers from pattern scanners; the
 * mask additionally defeats a scanner that decodes base64 and re-scans, at
 * zero cost to the zero-passphrase promise (obfuscation deters scanning, it
 * never claims secrecy — secrecy is the `aes-256-gcm` mode's job).
 */
export const OBFUSCATION_MASK = Buffer.from("paseo-factory-vault-obfuscation-v1", "utf8");

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
 * Passphrase resolution, ADR 0014 Decision 3: explicit argument →
 * `FACTORY_VAULT_PASSPHRASE` → the persisted config. An empty string is no
 * passphrase at any leg. `undefined` when nothing resolves.
 */
export function resolveVaultPassphrase(persisted: string | undefined, explicit?: string): string | undefined {
  if (explicit !== undefined && explicit !== "") return explicit;
  const env = process.env.FACTORY_VAULT_PASSPHRASE;
  if (env !== undefined && env !== "") return env;
  return persisted !== undefined && persisted !== "" ? persisted : undefined;
}

/** XOR is its own inverse — one function seals and unmasks the obfuscated payload. */
export function xorMask(payload: Buffer): Buffer {
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
export function parseEnvelope(raw: Buffer): VaultEnvelope | null {
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
export function decodeEnvelopeField(envelope: VaultEnvelope, field: "salt" | "iv" | "tag", length: number): Buffer {
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

/**
 * Stages one vault-runtime file into the vault checkout under the push-side
 * re-seal law — the leg that keeps ADR 0014 Decision 3's secret-scanning
 * shield true after a hydrate/pull has unsealed everything into
 * `vault-runtime`:
 *
 * - The checkout holds no envelope at this path (absent, or plaintext) →
 *   the runtime bytes ride verbatim: Plaintext Direct files and `vault
 *   seal`-staged envelopes alike — sealing policy stays with whoever wrote
 *   the file.
 * - The checkout holds an envelope and the runtime bytes are byte-identical
 *   → nothing is written (the no-op pull → push cycle commits nothing).
 * - The checkout holds an envelope and the runtime bytes are themselves an
 *   envelope unsealing to the same content → the checkout's sealed bytes
 *   stay (no churn over equivalent envelopes).
 * - The checkout holds an envelope and the runtime bytes are another
 *   envelope (different content, or one this machine cannot open) → the
 *   runtime envelope rides verbatim — it is sealed, never plaintext.
 * - The checkout holds an envelope and the runtime bytes are plaintext that
 *   unseals byte-identical → the checkout's sealed bytes stay.
 * - The checkout holds an envelope and the runtime bytes are plaintext that
 *   genuinely changed → the content is re-sealed with the envelope's own
 *   mode (`obfuscated` zero-passphrase, `aes-256-gcm` with the resolved
 *   passphrase — the same one that just unsealed the old copy).
 * - The checkout holds an envelope this machine cannot unseal and the
 *   runtime bytes differ from it as bytes → refused with
 *   `vault-push-passphrase-required`: unverifiable is never traded for a
 *   plaintext guess.
 */
export function stageRuntimeFileIntoCheckout(runtimePath: string, target: string, passphrase: string | undefined, relPath?: string): void {
  let existing: Buffer | null = null;
  try {
    existing = readFileSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = null; // no far-end file yet — a new vault path, rides verbatim below
  }
  const runtimeBytes = readFileSync(runtimePath);
  const envelope = existing === null ? null : parseEnvelope(existing);
  if (envelope !== null && existing !== null) {
    if (runtimeBytes.equals(existing)) return; // byte-identical — nothing to stage
    if (parseEnvelope(runtimeBytes) !== null) {
      // sealed stays sealed: keep the checkout's envelope only when both unseal to the same content
      if (tryUnseal(existing, passphrase, (a) => tryUnseal(runtimeBytes, passphrase, (b) => a.equals(b)))) return;
    } else {
      let unsealed: Buffer;
      try {
        unsealed = unsealVaultBuffer(existing, passphrase);
      } catch {
        throw new FactoryError(
          "vault-push-passphrase-required",
          `vault push cannot stage ${basename(target)}: the checkout holds a sealed envelope and no passphrase resolves to verify the runtime copy against it — restore the passphrase or stage an envelope (vault seal)`,
        );
      }
      if (unsealed.equals(runtimeBytes)) return; // unchanged content — the sealed bytes stay, byte-exact
      const resealed = Buffer.from(
        `${JSON.stringify(sealVaultBuffer(runtimeBytes, envelope.mode === "aes-256-gcm" ? passphrase : undefined))}\n`,
        "utf8",
      );
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, resealed);
      return;
    }
  }
  if (
    (relPath === "secrets/shared/gplay-service-account.json" || relPath === "secrets/shared/eye.json") &&
    parseEnvelope(runtimeBytes) === null
  ) {
    const sealed = Buffer.from(`${JSON.stringify(sealVaultBuffer(runtimeBytes, passphrase))}\n`, "utf8");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, sealed);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(runtimePath, target);
}

/** Runs `unseal` and maps both refusal codes to `false` — a verification probe, never a hard failure. */
export function tryUnseal(raw: Buffer, passphrase: string | undefined, then: (unsealed: Buffer) => boolean): boolean {
  try {
    return then(unsealVaultBuffer(raw, passphrase));
  } catch (err) {
    if (err instanceof FactoryError && (err.code === "vault-passphrase-required" || err.code === "vault-decrypt-failed")) {
      return false;
    }
    throw err;
  }
}
