import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { FactoryError } from "./errors.ts";

/**
 * The Private vault engine, stage A (ADR 0014 Decisions 1 & 3): dual-mode
 * secret envelopes, `VaultConfig` persistence, and the status read. Stage B
 * (ADR 0014 Decision 2): the injectable `VaultRunner` seam, the zero-clone
 * `hydrateVaultDirect` tarball stream, and the `pullVault`/`pushVault` sync
 * transport against a cached git checkout at `<paseoHome>/vault`.
 *
 * Pure Node built-ins only — `node:crypto`, `node:fs`, `node:path`,
 * `node:os`, `node:child_process`, `node:zlib`; zero npm or binary
 * dependencies. The multi-node `Ledger` reconciler and canonical-key routing
 * into local `Project` checkouts arrive with stage C.
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
 *
 * Stage B moves files by their vault paths verbatim: hydration unseals every
 * entry into `<paseoHome>/vault-runtime/` (`0o600` under `secrets/`), push
 * packages the `vault-runtime` tree plus this node's global ledger snapshot
 * back into `<paseoHome>/vault` and pushes. Envelopes ride the vault
 * byte-exact — sealing policy stays with whoever wrote the file.
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

/** Probes one shared-secret file under `<paseoHome>/vault-runtime/secrets/` — both the flat and the three-tier `secrets/shared/` spot (ADR 0014 Decision 4). */
function sharedSecretExists(paseoHome: string, name: string): boolean {
  const secrets = join(paseoHome, "vault-runtime", "secrets");
  return existsSync(join(secrets, name)) || existsSync(join(secrets, "shared", name));
}

// ===== Stage B (ADR 0014 Decision 2): the runner seam + both transports =====

/** One external CLI call routed through the `VaultRunner` seam — `gh api`, `git clone/pull/push`, never a shell string. */
export interface VaultRunnerCall {
  /** The binary to run — `gh` or `git` in practice, anything a test wants to observe. */
  command: string;
  args: readonly string[];
  /** Working directory for the child (git operations inside the vault checkout). */
  cwd?: string;
  /** Extra child environment (an explicit token rides as `GH_TOKEN`). */
  env?: Record<string, string>;
}

/**
 * The injectable seam every external vault CLI call goes through (spec
 * §Implementation Decisions 1). The default runs real children with
 * `GIT_TERMINAL_PROMPT: "0"`; tests inject fakes that answer with in-memory
 * tarball fixtures — zero network, zero prompts. Resolves with the child's
 * stdout as raw bytes (tarball streams are binary).
 */
export type VaultRunner = (call: VaultRunnerCall) => Promise<Buffer>;

export function createDefaultVaultRunner(): VaultRunner {
  return (call) =>
    new Promise<Buffer>((resolve, reject) => {
      execFile(
        call.command,
        [...call.args],
        {
          cwd: call.cwd,
          encoding: "buffer",
          maxBuffer: VAULT_RUNNER_MAX_BUFFER_BYTES,
          env: { ...process.env, ...call.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr.length > 0 ? stderr.toString("utf8").trim() : err.message;
            reject(new FactoryError("vault-runner-failed", `${call.command} ${call.args.join(" ")}: ${detail}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
}

/** The runner every transport uses unless the caller injects one. */
const builtinVaultRunner = createDefaultVaultRunner();

export interface HydrateVaultDirectOptions {
  /** Defaults to the persisted config's repo. */
  repo?: string;
  /** The tarball ref — defaults to the configured branch (`main` on a fresh config). */
  ref?: string;
  /** An explicit GitHub token; absent means the machine's `gh auth login` session. */
  token?: string;
  runner?: VaultRunner;
}

export interface PullVaultOptions {
  /**
   * Ask the hydration to reconcile multi-node ledger snapshots. The flag is
   * part of this stage's contract; the `reconcileVaultLedgers` behavior it
   * gates arrives with stage C.
   */
  mergeLedgers?: boolean;
  runner?: VaultRunner;
}

export interface PushVaultOptions {
  /** Snapshot the global `<stateDir>/ledger.jsonl` under `state/nodes/<nodeId>/global-ledger.jsonl` before pushing. */
  includeLedger?: boolean;
  runner?: VaultRunner;
}

export interface VaultHydrationResult {
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
export async function hydrateVaultDirect(paseoHome: string, options: HydrateVaultDirectOptions = {}): Promise<VaultHydrationResult> {
  const config = loadVaultConfig(paseoHome);
  const repo = options.repo ?? config?.repo;
  if (repo === undefined || repo.trim() === "") {
    throw new FactoryError("vault-not-configured", "hydrateVaultDirect needs a vault repo — pass one or save a VaultConfig first");
  }
  const slug = githubRepoSlug(repo);
  const ref = options.ref ?? config?.branch ?? "main";
  const runner = options.runner ?? builtinVaultRunner;
  const env = options.token !== undefined && options.token !== "" ? { GH_TOKEN: options.token } : undefined;

  const tarball = await runner({ command: "gh", args: ["api", `repos/${slug}/tarball/${ref}`], env });
  const archive = tarball.length > 2 && tarball[0] === 0x1f && tarball[1] === 0x8b ? gunzipSync(tarball) : tarball;

  const passphrase = resolveVaultPassphrase(config?.passphrase);
  const hydratedFiles: string[] = [];
  for (const entry of parseTarEntries(archive)) {
    const vaultPath = vaultPathFromArchivePath(entry.path);
    if (vaultPath === null) continue;
    writeRuntimeFile(paseoHome, vaultPath, unsealVaultBuffer(entry.data, passphrase));
    hydratedFiles.push(vaultPath);
  }

  stampVaultConfig(paseoHome, config, repo, { lastHydratedAt: nowIso(), lastHydrateMode: "direct" });
  return { hydratedFiles: hydratedFiles.sort() };
}

/**
 * Mode B, hydrating leg — `Vault sync`: `git clone` when `<paseoHome>/vault`
 * is absent, else `git pull --rebase --autostash`, then hydrate
 * `<paseoHome>/vault-runtime/` from the checkout (every file unsealed,
 * `0o600` under `secrets/`, `.git` never walked). Stamps
 * `lastHydrateMode: "sync"`.
 */
export async function pullVault(paseoHome: string, options: PullVaultOptions = {}): Promise<VaultHydrationResult> {
  const config = requiredVaultConfig(paseoHome);
  const runner = options.runner ?? builtinVaultRunner;
  const vaultDir = join(paseoHome, "vault");

  if (existsSync(join(vaultDir, ".git"))) {
    await runner({ command: "git", args: ["pull", "--rebase", "--autostash"], cwd: vaultDir });
  } else {
    if (existsSync(vaultDir)) rmSync(vaultDir, { recursive: true, force: true });
    await runner({ command: "git", args: ["clone", "--branch", config.branch, vaultRemoteUrl(config.repo), vaultDir] });
  }

  const hydratedFiles = hydrateRuntimeFromTree(paseoHome, vaultDir, resolveVaultPassphrase(config.passphrase));
  stampVaultConfig(paseoHome, config, config.repo, { lastHydratedAt: nowIso(), lastHydrateMode: "sync" });
  return { hydratedFiles };
}

/**
 * Mode B, publishing leg — `Vault push`: ensures the cached checkout at
 * `<paseoHome>/vault` (cloning when absent), packages the `vault-runtime`
 * tree into it by vault path verbatim (envelopes stay envelopes), snapshots
 * the global ledger under this node's namespace when `includeLedger` is set,
 * commits (nothing when the tree is clean — no empty commits) and pushes to
 * the configured remote. Stamps `lastPushedAt`.
 */
export async function pushVault(paseoHome: string, options: PushVaultOptions = {}): Promise<VaultPushResult> {
  const config = requiredVaultConfig(paseoHome);
  const runner = options.runner ?? builtinVaultRunner;
  const vaultDir = join(paseoHome, "vault");

  if (!existsSync(join(vaultDir, ".git"))) {
    if (existsSync(vaultDir)) rmSync(vaultDir, { recursive: true, force: true });
    await runner({ command: "git", args: ["clone", "--branch", config.branch, vaultRemoteUrl(config.repo), vaultDir] });
  }

  const runtimeRoot = join(paseoHome, "vault-runtime");
  const staged = existsSync(runtimeRoot) ? walkFiles(runtimeRoot, (rel) => rel === "env.json") : [];
  for (const rel of staged) {
    const target = join(vaultDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(runtimeRoot, rel), target);
  }
  const pushedFiles = new Set(staged);
  if (options.includeLedger) {
    const globalLedger = join(paseoHome, "plugin-state", STATE_PLUGIN_DIR, "ledger.jsonl");
    if (existsSync(globalLedger)) {
      const target = join(vaultDir, "state", "nodes", config.nodeId, "global-ledger.jsonl");
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(globalLedger, target);
      pushedFiles.add(`state/nodes/${config.nodeId}/global-ledger.jsonl`);
    }
  }

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

/** The default runner's stdout ceiling — vault tarballs are binary and can be large. */
const VAULT_RUNNER_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/** The config every sync-transport call needs, or the honest refusal. */
function requiredVaultConfig(paseoHome: string): VaultConfig {
  const config = loadVaultConfig(paseoHome);
  if (config === null || config.repo.trim() === "") {
    throw new FactoryError("vault-not-configured", "the vault transport needs a configured repo — saveVaultConfig first");
  }
  return config;
}

/** `owner/repo` for `gh api`; a leading `git:` and trailing `.git` are tolerated, anything else is not a GitHub slug. */
function githubRepoSlug(repo: string): string {
  const stripped = repo.startsWith("git:") ? repo.slice("git:".length) : repo;
  const slug = stripped.endsWith(".git") ? stripped.slice(0, -".git".length) : stripped;
  if (/^[^\s/]+\/[^\s/]+$/.test(slug)) return slug;
  throw new FactoryError("vault-repo-not-github", `direct hydrate needs a GitHub owner/repo slug, got "${repo}"`);
}

/** The clone/push URL: GitHub slugs expand to https remotes; local paths, `file://`, and URL/SCP forms pass through. */
function vaultRemoteUrl(repo: string): string {
  const stripped = repo.startsWith("git:") ? repo.slice("git:".length) : repo;
  if (stripped.includes("://") || /^[^/]+:/.test(stripped) || stripped.startsWith("/") || stripped.startsWith("./") || stripped.startsWith("../")) {
    return stripped;
  }
  if (/^[^\s/]+\/[^\s/]+$/.test(stripped)) return `https://github.com/${stripped}.git`;
  return stripped;
}

/** Merges hydration/push stamps into the persisted config, preserving every other field. */
function stampVaultConfig(
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

/** Hydrates `<paseoHome>/vault-runtime/` from a vault tree on disk (the sync-mode checkout). */
function hydrateRuntimeFromTree(paseoHome: string, treeRoot: string, passphrase: string | undefined): string[] {
  const written: string[] = [];
  for (const rel of walkFiles(treeRoot, () => false)) {
    writeRuntimeFile(paseoHome, rel, unsealVaultBuffer(readFileSync(join(treeRoot, rel)), passphrase));
    written.push(rel);
  }
  return written.sort();
}

/** Writes one unsealed vault file under `<paseoHome>/vault-runtime/` — `0o600` (+ `0o700` dirs) under `secrets/`. */
function writeRuntimeFile(paseoHome: string, vaultPath: string, data: Buffer): void {
  assertSafeVaultPath(vaultPath);
  const runtimeRoot = join(paseoHome, "vault-runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const segments = vaultPath.split("/");
  let acc = runtimeRoot;
  let insideSecrets = false;
  for (const segment of segments.slice(0, -1)) {
    acc = join(acc, segment);
    insideSecrets = insideSecrets || segment === "secrets";
    mkdirSync(acc, { recursive: true });
    if (insideSecrets) chmodSync(acc, 0o700);
  }
  const target = join(runtimeRoot, vaultPath);
  writeFileSync(target, data);
  chmodSync(target, segments[0] === "secrets" ? 0o600 : 0o644);
}

/** A vault path is `/`-separated relative segments, none of them `.`/`..`/empty — archive traversal is refused, not written. */
function assertSafeVaultPath(vaultPath: string): void {
  const segments = vaultPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new FactoryError("vault-invalid-path", `refusing unsafe vault path "${vaultPath}"`);
  }
}

/** Every file under `root` as `/`-separated relative paths (sorted), skipping any `.git` directory and `skip` matches. */
function walkFiles(root: string, skip: (rel: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        visit(join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        if (skip(childRel)) continue;
        found.push(childRel);
      }
    }
  };
  visit(root, "");
  return found.sort();
}

/** Strips the GitHub tarball's single top-level `<owner>-<repo>-<sha>/` prefix; root-level entries and dirs yield `null`. */
function vaultPathFromArchivePath(path: string): string | null {
  const slash = path.indexOf("/");
  if (slash <= 0) return null;
  const rest = path.slice(slash + 1);
  return rest === "" ? null : rest;
}

interface TarEntry {
  path: string;
  data: Buffer;
}

/**
 * A minimal in-memory tar walker (`node:fs`-free, no external tar library):
 * 512-byte ustar headers, octal sizes, ustar prefix fields, GNU long-name
 * (`L`) and pax `path=` overrides, directories and links skipped, the
 * zero-block end marker honored, a truncated archive refused.
 */
function parseTarEntries(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let pendingPath: string | null = null;
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (isAllZeroes(header)) break;
    const size = parseTarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new FactoryError("corrupted-vault-tarball", `the vault tarball is truncated inside an entry (needs ${dataEnd} bytes, has ${archive.length})`);
    }
    const data = archive.subarray(dataStart, dataEnd);
    const typeflag = String.fromCharCode(header[156]!);

    if (typeflag === "L" || typeflag === "x" || typeflag === "g") {
      const override = typeflag === "L" ? stripTrailingNul(data.toString("utf8")) : paxPath(data);
      if (override !== null) pendingPath = override;
    } else if (typeflag === "0" || typeflag === "\0") {
      let path = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      if (prefix !== "") path = `${prefix}/${path}`;
      if (pendingPath !== null) {
        path = pendingPath;
        pendingPath = null;
      }
      entries.push({ path, data });
    }
    // directories (`5`) and link entries are not vault content

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function isAllZeroes(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

/** Reads one NUL-terminated string field out of a tar header. */
function tarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** Reads one octal tar header field; a blank field is 0, garbage is a corrupted archive. */
function parseTarOctal(header: Buffer, offset: number, length: number): number {
  const raw = tarString(header, offset, length).trim();
  if (raw === "") return 0;
  const value = parseInt(raw, 8);
  if (Number.isNaN(value)) {
    throw new FactoryError("corrupted-vault-tarball", `the vault tarball header field at ${offset} is not octal ("${raw}")`);
  }
  return value;
}

/** Extracts `path=` from a pax extended header's `<len> key=value\n` records, if present. */
function paxPath(data: Buffer): string | null {
  for (const line of data.toString("utf8").split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const record = line.slice(space + 1);
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") return record.slice(eq + 1);
  }
  return null;
}

function stripTrailingNul(text: string): string {
  return text.replace(/\0+$/, "");
}

function nowIso(): string {
  return new Date().toISOString();
}
