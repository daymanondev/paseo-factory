import { execFile, execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { gunzipSync } from "node:zlib";
import { FactoryError } from "./errors.ts";
import { EVENT_NAMES } from "./events.ts";
import { discoverProjects, listProjectRegistrations, resolveProject } from "./project.ts";
import { Ledger } from "./ledger.ts";

/**
 * The Private vault engine, stage A (ADR 0014 Decisions 1 & 3): dual-mode
 * secret envelopes, `VaultConfig` persistence, and the status read. Stage B
 * (ADR 0014 Decision 2): the injectable `VaultRunner` seam, the zero-clone
 * `hydrateVaultDirect` tarball stream, and the `pullVault`/`pushVault` sync
 * transport against a cached git checkout at `<paseoHome>/vault`. Stage C
 * (ADR 0014 Decisions 4 & 5): `vault.manifest.json` canonical-key routing
 * into this host's local `Project` checkouts, the deterministic multi-node
 * `Ledger` reconciler (`reconcileVaultLedgers`), worktree hygiene
 * (`ensureLocalGitExcludeAndWorktreeInclude`), and the
 * `<paseoHome>/vault-runtime/env.json` runtime pointer index.
 *
 * Pure Node built-ins only — `node:crypto`, `node:fs`, `node:path`,
 * `node:os`, `node:child_process`, `node:zlib`; zero npm or binary
 * dependencies. The core's own `project.ts` (slug minting, registries),
 * `ledger.ts` (the reader whose validity law the reconciler borrows) and
 * `events.ts` (the vocabulary) are the only sibling imports.
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
 * leg lives in `readVaultStatus` and in the hydration engine, which owns the
 * paseo home; `unsealVaultBuffer` (no home in its signature) resolves the
 * first two legs, and its callers thread the persisted passphrase in as the
 * explicit argument.
 *
 * Both transports move files by their vault paths verbatim into
 * `<paseoHome>/vault-runtime/` (`0o600` under `secrets/`), then share one
 * stage-C tail: route canonical keys, materialize per-app files into every
 * resolved checkout with hygiene registered, write `env.json`, and — on
 * `mergeLedgers` — fold the vault's `state/nodes/*` snapshots into this
 * machine's ledgers. Push packages the runtime tree plus this node's
 * node-scoped ledger snapshots back into `<paseoHome>/vault` and pushes.
 * Envelopes ride the vault byte-exact — sealing policy stays with whoever
 * wrote the file.
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
 * in `error` instead of crashing the read. `hydratedApps` lists the canonical
 * app keys with secrets hydrated under `vault-runtime/secrets/apps/`.
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
    hydratedApps: hydratedAppKeys(paseoHome),
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
  /** Reconcile the vault's `state/nodes/*` ledger snapshots into this machine's ledgers after hydrating (stage C). */
  mergeLedgers?: boolean;
  runner?: VaultRunner;
}

export interface PullVaultOptions {
  /**
   * Reconcile the vault's `state/nodes/*` ledger snapshots into this
   * machine's global and per-project ledgers through `reconcileVaultLedgers`
   * after hydrating (spec §Implementation Decisions 2).
   */
  mergeLedgers?: boolean;
  runner?: VaultRunner;
}

export interface PushVaultOptions {
  /**
   * Snapshot this machine's ledgers under its node namespace before pushing:
   * the global `<stateDir>/ledger.jsonl` as `state/nodes/<nodeId>/global-ledger.jsonl`
   * and every per-project `<stateDir>/projects/<local-slug>/ledger.jsonl` as
   * `state/nodes/<nodeId>/projects/<canonicalAppKey>/ledger.jsonl` (the slug
   * stands in for the key when `vault.manifest.json` does not route it).
   */
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

  applyVaultHydration(paseoHome);
  if (options.mergeLedgers === true) reconcileVaultLedgerState(paseoHome);
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
  applyVaultHydration(paseoHome);
  if (options.mergeLedgers === true) reconcileVaultLedgerState(paseoHome);
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
    const stateDir = vaultStateDir(paseoHome);
    const globalLedger = join(stateDir, "ledger.jsonl");
    if (existsSync(globalLedger)) {
      const target = join(vaultDir, "state", "nodes", config.nodeId, "global-ledger.jsonl");
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(globalLedger, target);
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
      copyFileSync(projectLedger, target);
      pushedFiles.add(`state/nodes/${config.nodeId}/projects/${key}/ledger.jsonl`);
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

// ===== Stage C (ADR 0014 Decisions 4 & 5): canonical-key routing, the multi-node `Ledger` reconciler, worktree hygiene, `vault-runtime/env.json` =====

/** One `vault.manifest.json` entry — the legs a canonical app key can match a local checkout on. */
export interface VaultManifestEntry {
  /** The checkout directory's basename (e.g. `"patigame"`). */
  repoBasename?: string;
  /** The checkout's `remote.origin.url`, in any URL/SCP form. */
  gitRemote?: string;
  /** Matches the checkout's `.store-release/manifest.json` `bundleId`. */
  bundleId?: string;
  /** Matches the checkout's `.store-release/manifest.json` `packageName`. */
  packageName?: string;
}

/** The vault-root `vault.manifest.json` — `<canonicalAppKey>` → the legs it matches on. */
export type VaultManifest = Record<string, VaultManifestEntry>;

/** One canonical app key resolved against this host's local `Project`s. */
export interface ResolvedVaultApp {
  canonicalAppKey: string;
  /** The local checkout root, or null when no local `Project` matched this key. */
  projectRoot: string | null;
  /** The host-local `<basename>-<sha1(realpath(gitCommonDir)).slice(0,6)>` slug (`resolveProject`, `src/project.ts:65-66`), or null with the root. */
  projectSlug: string | null;
}

/**
 * Parses and validates `vault.manifest.json` text. The manifest is a plain
 * object of `<canonicalAppKey>` → `{ repoBasename?, gitRemote?, bundleId?,
 * packageName? }` (string legs only); anything else is refused with
 * `corrupted-vault-manifest`, never guessed at.
 */
export function parseVaultManifest(raw: string): VaultManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FactoryError("corrupted-vault-manifest", "vault.manifest.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FactoryError("corrupted-vault-manifest", "vault.manifest.json must be an object of canonicalAppKey → matching legs");
  }
  const manifest: VaultManifest = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new FactoryError("corrupted-vault-manifest", `vault.manifest.json entry "${key}" must be an object`);
    }
    const entry: VaultManifestEntry = {};
    for (const leg of ["repoBasename", "gitRemote", "bundleId", "packageName"] as const) {
      const field = (value as Record<string, unknown>)[leg];
      if (field === undefined) continue;
      if (typeof field !== "string") {
        throw new FactoryError("corrupted-vault-manifest", `vault.manifest.json entry "${key}" field "${leg}" must be a string`);
      }
      entry[leg] = field;
    }
    manifest[key] = entry;
  }
  return manifest;
}

/** Reads `<root>/vault.manifest.json`; a missing file is an empty mapping (a vault with no routing). */
function readVaultManifestAt(root: string): VaultManifest {
  try {
    return parseVaultManifest(readFileSync(join(root, "vault.manifest.json"), "utf8"));
  } catch (err) {
    if (err instanceof FactoryError && err.code === "corrupted-vault-manifest") throw err;
    return {}; // ENOENT and read damage degrade to no routing, never a crash
  }
}

/** The match legs of one local checkout, probed once per resolution run, with its resolved identity. */
interface RootFacts {
  /** The toplevel `resolveProject` named. */
  root: string;
  /** The host-local `<project-slug>`. */
  slug: string;
  basename: string;
  originUrl: string | null;
  bundleId: string | null;
  packageName: string | null;
}

/**
 * Resolves every `vault.manifest.json` canonical key against this host's
 * local `Project`s (spec §Implementation Decisions 2): candidate roots come
 * from the factory registry (`listProjectRegistrations`), `discoverProjects`
 * (which folds `<paseoHome>/projects/projects.json`), and Release Lab's own
 * `<paseoHome>/release-lab/projects.json` (read as data — no cross-repo
 * import); each key matches a root by basename, `remote.origin.url`, or
 * `.store-release/manifest.json` bundleId/packageName, and resolves through
 * `resolveProject` to the host-local `<project-slug>` — the exact hash that
 * differs when two machines check the same repo out at different paths.
 * Keys with no local match resolve `null`/`null`; output is canonical-key
 * order, first matching root (sorted) per key — deterministic everywhere.
 */
export function resolveVaultApps(paseoHome: string, manifest: VaultManifest): ResolvedVaultApp[] {
  const stateDir = vaultStateDir(paseoHome);

  const candidateRoots = new Set<string>();
  for (const registration of listProjectRegistrations(stateDir)) candidateRoots.add(registration.root);
  for (const discovered of discoverProjects(stateDir, [], paseoHome)) {
    if (discovered.root !== null) candidateRoots.add(discovered.root);
  }
  for (const root of readReleaseLabProjectRoots(paseoHome)) candidateRoots.add(root);

  // resolveProject per distinct root, once — it is the slug's single source
  const factsByRoot = new Map<string, RootFacts | null>();
  const factsOf = (root: string): RootFacts | null => {
    const cached = factsByRoot.get(root);
    if (cached !== undefined) return cached;
    const resolved = resolveProject(root);
    if (!resolved.ok) {
      factsByRoot.set(root, null);
      return null;
    }
    const storeManifest = readJsonFile(join(resolved.root, ".store-release", "manifest.json"));
    const facts: RootFacts = {
      root: resolved.root,
      slug: resolved.slug,
      basename: basename(resolved.root),
      originUrl: gitProbe(resolved.root, ["config", "--get", "remote.origin.url"]),
      bundleId: jsonStringField(storeManifest, "bundleId"),
      packageName: jsonStringField(storeManifest, "packageName"),
    };
    factsByRoot.set(root, facts);
    return facts;
  };

  const out: ResolvedVaultApp[] = [];
  for (const canonicalAppKey of Object.keys(manifest).sort()) {
    const entry = manifest[canonicalAppKey]!;
    let matched: RootFacts | null = null;
    for (const root of [...candidateRoots].sort()) {
      const facts = factsOf(root);
      if (facts !== null && entryMatches(entry, facts)) {
        matched = facts;
        break;
      }
    }
    out.push(
      matched === null
        ? { canonicalAppKey, projectRoot: null, projectSlug: null }
        : { canonicalAppKey, projectRoot: matched.root, projectSlug: matched.slug },
    );
  }
  return out;
}

/** Whether any of the entry's declared legs matches the checkout's facts. */
function entryMatches(entry: VaultManifestEntry, facts: RootFacts): boolean {
  if (entry.repoBasename !== undefined && entry.repoBasename === facts.basename) return true;
  if (entry.gitRemote !== undefined && facts.originUrl !== null && gitRemotesMatch(entry.gitRemote, facts.originUrl)) return true;
  if (entry.bundleId !== undefined && entry.bundleId === facts.bundleId) return true;
  if (entry.packageName !== undefined && entry.packageName === facts.packageName) return true;
  return false;
}

/**
 * Two remote URLs are the same repository when their normalized forms are
 * equal, or one is a host-qualified form of the other (`https://github.com/
 * daymanondev/patigame.git`, `git@github.com:daymanondev/patigame`, and the
 * bare `daymanondev/patigame` slug all normalize to the same routing fact).
 */
function gitRemotesMatch(a: string, b: string): boolean {
  const left = normalizeGitRemote(a);
  const right = normalizeGitRemote(b);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/** Strips scheme, user, scp colon, and `.git` — the path identity of a remote URL, lowercased. */
function normalizeGitRemote(url: string): string {
  let u = url.trim();
  if (u.endsWith(".git")) u = u.slice(0, -".git".length);
  const scp = u.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scp !== null) u = `${scp[1]}/${scp[2]}`;
  const scheme = u.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/);
  if (scheme !== null) u = scheme[1]!;
  u = u.replace(/^[^@/]+@/, "");
  return u.toLowerCase();
}

/** Release Lab's added-projects registry (`<paseoHome>/release-lab/projects.json`) — read as data, never written. */
function readReleaseLabProjectRoots(paseoHome: string): string[] {
  const parsed = readJsonFile(join(paseoHome, "release-lab", "projects.json"));
  const roots: string[] = [];
  for (const entry of arrayField(parsed, "projects")) {
    const root = jsonStringField(entry, "root");
    if (root !== null && root.trim() !== "") roots.push(root);
  }
  return roots;
}

/** `<paseoHome>/plugin-state/paseo-factory` — the core's own stateDir (parity with the shell's `stateDirFor`). */
function vaultStateDir(paseoHome: string): string {
  return join(paseoHome, "plugin-state", STATE_PLUGIN_DIR);
}

/** One git fact about a checkout, or null — a missing answer is never a guess. */
function gitProbe(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

/** Reads a JSON file as an object, or null when absent/damaged — a routing input, not an authority. */
function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A string field of a JSON object, or null. */
function jsonStringField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/** An array field of a JSON object as objects, or empty — malformed entries are skipped, never fatal. */
function arrayField(record: Record<string, unknown> | null, field: string): Array<Record<string, unknown>> {
  const value = record?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

/** A nested two-key string field (`project_info.project_id`), or null. */
function nestedJsonStringField(record: Record<string, unknown> | null, path: readonly [string, string]): string | null {
  if (record === null) return null;
  const inner = record[path[0]];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return null;
  return jsonStringField(inner as Record<string, unknown>, path[1]);
}

/**
 * Registers materialized per-app paths in `<gitCommonDir>/info/exclude` AND
 * `<projectRoot>/.worktreeinclude` (spec §Implementation Decisions 3): the
 * exclude keeps `git status --porcelain` and `checkCleanAt` clean over the
 * hydrated checkout, the include makes `prepareTaskWorktree` carry the files
 * into every Task worktree — secrets ride attempts without ever being
 * committed to the open-source app repository. Idempotent — one line per
 * path however often hydration re-runs. A root git cannot answer for is
 * refused (`vault-project-not-git`), never guessed at.
 */
export function ensureLocalGitExcludeAndWorktreeInclude(projectRoot: string, relPaths: readonly string[]): void {
  if (relPaths.length === 0) return;
  const commonDirRaw = gitProbe(projectRoot, ["rev-parse", "--git-common-dir"]);
  if (commonDirRaw === null || commonDirRaw === "") {
    throw new FactoryError("vault-project-not-git", `${projectRoot} does not resolve to a git checkout — vault hygiene has nothing to register against`);
  }
  const gitCommonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolvePath(projectRoot, commonDirRaw);
  // `.worktreeinclude` itself is machine-local (it names local secret paths), so
  // it hides in the exclude alongside the files it lists — otherwise the tree
  // dirties on the very file that keeps it clean.
  appendUniqueLines(join(gitCommonDir, "info", "exclude"), [...relPaths, ".worktreeinclude"]);
  appendUniqueLines(join(projectRoot, ".worktreeinclude"), relPaths);
}

/** Appends the lines a file does not already carry — one line per path, trailing newline kept honest. */
function appendUniqueLines(path: string, lines: readonly string[]): void {
  let existing: string;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = "";
  }
  const present = new Set(existing.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
  const missing = lines.filter((line) => !present.has(line.trim()));
  if (missing.length === 0) return;
  const base = existing === "" ? "" : existing.endsWith("\n") ? existing : `${existing}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${base}${missing.join("\n")}\n`);
}

/**
 * The per-app vault files and the checkout-relative spots they materialize
 * into (spec §Implementation Decisions 3; ADR 0014 Decision 5) — every path
 * this list owns is a path `ensureLocalGitExcludeAndWorktreeInclude` must
 * see registered.
 */
const APP_FILE_TARGETS: ReadonlyArray<{ vaultFile: string; projectRel: string }> = [
  { vaultFile: "release.keystore", projectRel: "android/app/release.keystore" },
  { vaultFile: "signing.json", projectRel: "android/keystore.properties" },
  { vaultFile: "google-services.json", projectRel: "android/app/google-services.json" },
  { vaultFile: "GoogleService-Info.plist", projectRel: "ios/GoogleService-Info.plist" },
];

/** Materializes one canonical app's per-app files from `vault-runtime` into its resolved local checkout (`0o600`). */
function materializeVaultAppFiles(paseoHome: string, canonicalAppKey: string, projectRoot: string): string[] {
  const appSecrets = join(paseoHome, "vault-runtime", "secrets", "apps", canonicalAppKey);
  const written: string[] = [];
  for (const target of APP_FILE_TARGETS) {
    const source = join(appSecrets, target.vaultFile);
    if (!existsSync(source)) continue;
    let data: Buffer;
    if (target.vaultFile === "signing.json") {
      const rendered = renderKeystoreProperties(readJsonFile(source));
      if (rendered === null) continue; // a damaged signing.json skips its file, never fails the hydration
      data = Buffer.from(rendered, "utf8");
    } else {
      data = readFileSync(source);
    }
    const dest = join(projectRoot, target.projectRel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data, { mode: 0o600 });
    chmodSync(dest, 0o600);
    written.push(target.projectRel);
  }
  return written;
}

/** `signing.json` (string settings) rendered as `android/keystore.properties` lines, keys sorted; null when nothing renders. */
function renderKeystoreProperties(signing: Record<string, unknown> | null): string | null {
  if (signing === null) return null;
  const lines = Object.keys(signing)
    .filter((key) => typeof signing[key] === "string")
    .sort()
    .map((key) => `${key}=${signing[key] as string}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : null;
}

/**
 * The stage-C hydration tail both transports share: route `vault.manifest.json`
 * canonical keys to local `Project`s, materialize per-app files into every
 * resolved checkout with hygiene registered, and write the
 * `<paseoHome>/vault-runtime/env.json` pointer index (`0o600`) — the
 * zero-shell-config hand-off `factory-release-lab` reads (ADR 0014 Decision 5).
 */
function applyVaultHydration(paseoHome: string): void {
  const manifest = readVaultManifestAt(join(paseoHome, "vault-runtime"));
  for (const app of resolveVaultApps(paseoHome, manifest)) {
    if (app.projectRoot === null) continue; // no local checkout behind this canonical key on this machine
    const written = materializeVaultAppFiles(paseoHome, app.canonicalAppKey, app.projectRoot);
    if (written.length > 0) ensureLocalGitExcludeAndWorktreeInclude(app.projectRoot, written);
  }
  writeVaultRuntimeEnv(paseoHome);
}

/** Writes the `VaultRuntimeEnv` pointer index at `<paseoHome>/vault-runtime/env.json`, `0o600`. */
function writeVaultRuntimeEnv(paseoHome: string): void {
  const runtimeRoot = join(paseoHome, "vault-runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const path = join(runtimeRoot, "env.json");
  writeFileSync(path, `${JSON.stringify(buildVaultRuntimeEnv(paseoHome), null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * The six runtime keys (spec §Implementation Decisions 3), each present only
 * when its source hydrated: the shared ASC `.p8`/credentials and Google Play
 * JSON by path, the keystore storepass from the first (canonical-key order)
 * app's `signing.json`, and the Firebase project id from its
 * `google-services.json` — Release Lab reads these whenever `process.env`
 * stays silent (§User Story 7).
 */
function buildVaultRuntimeEnv(paseoHome: string): VaultRuntimeEnv {
  const shared = join(paseoHome, "vault-runtime", "secrets", "shared");
  const env: VaultRuntimeEnv = {};
  const ascKey = join(shared, SHARED_SECRET_FILES.ascKey);
  if (existsSync(ascKey)) env.ASC_KEY_PATH = ascKey;
  const ascCredentials = readJsonFile(join(shared, SHARED_SECRET_FILES.ascCredentials));
  const keyId = jsonStringField(ascCredentials, "keyId") ?? jsonStringField(ascCredentials, "key_id");
  const issuerId = jsonStringField(ascCredentials, "issuerId") ?? jsonStringField(ascCredentials, "issuer_id");
  if (keyId !== null) env.ASC_KEY_ID = keyId;
  if (issuerId !== null) env.ASC_ISSUER = issuerId;
  const gplay = join(shared, SHARED_SECRET_FILES.gplayServiceAccount);
  if (existsSync(gplay)) env.GPLAY_KEY_PATH = gplay;
  for (const canonicalAppKey of hydratedAppKeys(paseoHome)) {
    const appSecrets = join(paseoHome, "vault-runtime", "secrets", "apps", canonicalAppKey);
    if (env.RELEASE_LAB_KEYSTORE_STOREPASS === undefined) {
      const signing = readJsonFile(join(appSecrets, "signing.json"));
      const storePass = jsonStringField(signing, "storePassword") ?? jsonStringField(signing, "storePass");
      if (storePass !== null) env.RELEASE_LAB_KEYSTORE_STOREPASS = storePass;
    }
    if (env.FIREBASE_PROJECT_ID === undefined) {
      const googleServices = readJsonFile(join(appSecrets, "google-services.json"));
      const projectId = nestedJsonStringField(googleServices, ["project_info", "project_id"]) ?? jsonStringField(googleServices, "project_id");
      if (projectId !== null) env.FIREBASE_PROJECT_ID = projectId;
    }
  }
  return env;
}

/** Canonical keys with any hydrated app secret — the `hydratedApps` source, sorted. */
function hydratedAppKeys(paseoHome: string): string[] {
  try {
    return readdirSync(join(paseoHome, "vault-runtime", "secrets", "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return []; // no apps dir yet — nothing hydrated
  }
}

/** One node's ledger snapshot, as staged under `state/nodes/<nodeId>/`. */
export interface VaultLedgerSource {
  nodeId: string;
  /** The raw JSONL text of the snapshot. */
  lines: string;
}

/**
 * The deterministic multi-node `Ledger` reconciler (spec §Implementation
 * Decisions 2, in the codebase's own vocabulary — `LedgerEvent` discriminates
 * on `event` and carries `sha`/`base`, never `type`/`commit`): parses every
 * valid JSONL record across the local ledger and all node snapshots,
 * deduplicates identical events by a canonical fingerprint (the record minus
 * `seq` — `ts`, `event`, `task`/`attempt`/`agent`/`sha`/`base`, plus every
 * event-specific payload key, stably ordered), sorts chronologically by
 * `Date.parse(evt.ts)` with ties broken by `(sourceNodeId, originalSeq)`, and
 * re-indexes `seq: 1..N` strictly monotonically — so the file this text lands
 * in always opens through `Ledger.open`'s `evt.seq > prevSeq` gate
 * (`src/ledger.ts:69-75`), where a `.gitattributes merge=union` of the same
 * inputs throws `corrupted-ledger`. Invalid lines are skipped, never fatal:
 * a merge is a recovery act, and damaged input degrades to what parses.
 */
export function reconcileVaultLedgers(existingLines: string, nodeLedgerLines: readonly VaultLedgerSource[]): string {
  const seen = new Map<string, { evt: Record<string, unknown>; sourceNodeId: string; originalSeq: number; sortTs: number }>();
  const carry = (lines: string, sourceNodeId: string): void => {
    for (const raw of lines.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a torn or foreign line is skipped, not trusted
      }
      if (!isValidVaultLedgerRecord(parsed)) continue;
      const evt = parsed as Record<string, unknown>;
      const fingerprint = stableStringify(omitSeq(evt));
      if (!seen.has(fingerprint)) {
        const ts = Date.parse(String(evt.ts));
        seen.set(fingerprint, {
          evt,
          sourceNodeId,
          originalSeq: evt.seq as number,
          sortTs: Number.isNaN(ts) ? 0 : ts, // an unparseable clock sorts earliest, deterministically
        });
      }
    }
  };

  carry(existingLines, ""); // the local ledger's source id sorts before every node id on ties
  for (const source of nodeLedgerLines) carry(source.lines, source.nodeId);

  const ordered = [...seen.values()].sort(
    (a, b) => a.sortTs - b.sortTs || (a.sourceNodeId < b.sourceNodeId ? -1 : a.sourceNodeId > b.sourceNodeId ? 1 : 0) || a.originalSeq - b.originalSeq,
  );
  disposeRecordProbe();
  return ordered.map((carried, index) => `${JSON.stringify({ ...carried.evt, seq: index + 1 })}\n`).join("");
}

/** The record minus its `seq` — the identity of an event independent of where it was numbered. */
function omitSeq(evt: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evt)) {
    if (key !== "seq") rest[key] = value;
  }
  return rest;
}

/** JSON with recursively sorted keys — two identical records always stringify identically, whatever wrote them. */
function stableStringify(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * The probe file the per-record validity check opens through `Ledger.open` —
 * the real per-kind shape law lives in the ledger's reader, and this module
 * judges records with that law instead of duplicating it (a copy would drift).
 */
let vaultRecordProbePath: string | null = null;

/**
 * A record is valid when `Ledger.open` would accept it: the cheap structural
 * gate here (object, positive-integer `seq`, non-empty `ts`, `event` in
 * `EVENT_NAMES`), then the ledger's own full per-kind shape check — one
 * single-record ledger at `seq: 1` opens exactly when the record is valid.
 */
function isValidVaultLedgerRecord(evt: unknown): boolean {
  if (typeof evt !== "object" || evt === null || Array.isArray(evt)) return false;
  const rec = evt as Record<string, unknown>;
  if (typeof rec.seq !== "number" || !Number.isInteger(rec.seq) || rec.seq < 1) return false;
  if (typeof rec.ts !== "string" || rec.ts === "") return false;
  if (typeof rec.event !== "string" || !(EVENT_NAMES as readonly string[]).includes(rec.event)) return false;
  vaultRecordProbePath ??= join(tmpdir(), `paseo-factory-vault-reconcile-${process.pid}-${randomUUID()}.jsonl`);
  try {
    writeFileSync(vaultRecordProbePath, `${JSON.stringify({ ...rec, seq: 1 })}\n`);
    Ledger.open(vaultRecordProbePath);
    return true;
  } catch {
    return false;
  }
}

/** Removes the probe file — a reconcile leaves nothing behind. */
function disposeRecordProbe(): void {
  if (vaultRecordProbePath !== null) {
    rmSync(vaultRecordProbePath, { force: true });
    vaultRecordProbePath = null;
  }
}

/**
 * The `mergeLedgers` leg both transports share: folds the hydrated
 * `vault-runtime/state/nodes/*` snapshots into this machine's ledgers — the
 * global `<stateDir>/ledger.jsonl` from every node's `global-ledger.jsonl`,
 * and, for each canonical key `vault.manifest.json` routes to a local
 * `Project`, `<stateDir>/projects/<local-slug>/ledger.jsonl` from every
 * node's `projects/<canonicalAppKey>/ledger.jsonl`. Each file is rewritten
 * atomically (`writeFileSync(tmp)` + `renameSync`) in `Ledger.append`'s exact
 * one-JSON-line-per-event format; a key with no node snapshot is left alone.
 */
function reconcileVaultLedgerState(paseoHome: string): void {
  const stateDir = vaultStateDir(paseoHome);
  const runtimeRoot = join(paseoHome, "vault-runtime");
  mergeLedgerFile(join(stateDir, "ledger.jsonl"), nodeLedgerSourcesAt(runtimeRoot, ["global-ledger.jsonl"]));
  for (const app of resolveVaultApps(paseoHome, readVaultManifestAt(runtimeRoot))) {
    if (app.projectSlug === null) continue; // no local Project behind this key — nothing to reconcile into
    mergeLedgerFile(
      join(stateDir, "projects", app.projectSlug, "ledger.jsonl"),
      nodeLedgerSourcesAt(runtimeRoot, ["projects", app.canonicalAppKey, "ledger.jsonl"]),
    );
  }
}

/** Every node's copy of one ledger file under `<vaultTree>/state/nodes/<nodeId>/<...rel>`, node order. */
function nodeLedgerSourcesAt(vaultTreeRoot: string, rel: readonly string[]): VaultLedgerSource[] {
  const nodesDir = join(vaultTreeRoot, "state", "nodes");
  const out: VaultLedgerSource[] = [];
  for (const nodeId of listDirNames(nodesDir)) {
    const path = join(nodesDir, nodeId, ...rel);
    if (existsSync(path)) out.push({ nodeId, lines: readFileSync(path, "utf8") });
  }
  return out;
}

/** Reconciles one local ledger against the node snapshots and lands the result atomically; no snapshot, no rewrite. */
function mergeLedgerFile(localPath: string, sources: readonly VaultLedgerSource[]): void {
  if (sources.length === 0) return;
  let existing = "";
  try {
    existing = readFileSync(localPath, "utf8");
  } catch {
    // no local ledger yet — a fresh machine bootstraps its history from the vault
  }
  const reconciled = reconcileVaultLedgers(existing, sources);
  if (reconciled === "") return; // nothing valid anywhere — whatever sits on disk is not ours to erase
  mkdirSync(dirname(localPath), { recursive: true });
  const tmp = `${localPath}.reconcile-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, reconciled);
  renameSync(tmp, localPath);
}

/** The entry names of a directory, sorted; a missing directory is empty. */
function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
