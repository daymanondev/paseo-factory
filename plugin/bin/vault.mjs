/**
 * The CLIs' Private-vault engine mirror (v0.0.21–v0.0.22, ADR 0014 / ADR 0004:
 * plain .mjs, importing no src/ or plugin-server code), kept behaviorally
 * identical to src/vault.ts by test/vault-cli.test.ts: dual-mode envelopes,
 * VaultConfig persistence, readVaultStatus, probeGhAuth, ensureRemoteVaultRepo,
 * empty-remote bootstrap, hydrateVaultDirect, pullVault, pushVault, syncVault,
 * importVaultSecrets, sealVaultFile, canonical-key routing (parseVaultManifest,
 * resolveVaultApps), per-Project secret materialization + worktree hygiene
 * (ensureLocalGitExcludeAndWorktreeInclude), config collection/materialization,
 * and multi-node Ledger reconciliation (reconcileVaultLedgers).
 */
import { execFile, execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { gunzipSync } from "node:zlib";
import { reconcileHistory } from "./history-import.mjs";
import { projectStateDir, resolveProject } from "./project.mjs";

/** The core's FactoryError, mirrored as a plain Error carrying the stable code. */
function vaultError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const STATE_PLUGIN_DIR = "paseo-factory";

// ===== Stage A (ADR 0014 Decision 3): dual-mode envelopes + config + status =====

export function sealVaultBuffer(plain, passphrase) {
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

export function unsealVaultBuffer(rawOrEnvelope, passphrase) {
  const envelope = parseEnvelope(rawOrEnvelope);
  if (envelope === null) return rawOrEnvelope;

  if (envelope.mode === "obfuscated") {
    return xorMask(Buffer.from(envelope.data, "base64"));
  }

  const pass = resolveVaultPassphrase(undefined, passphrase);
  if (pass === undefined) {
    throw vaultError(
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
    throw vaultError("vault-decrypt-failed", "the vault envelope did not decrypt — wrong passphrase or damaged envelope");
  }
}

/** `<paseoHome>/plugin-state/paseo-factory/vault-config.json` — parity with the shell's stateDirFor. */
function vaultConfigPath(paseoHome) {
  return join(paseoHome, "plugin-state", STATE_PLUGIN_DIR, "vault-config.json");
}

export function loadVaultConfig(paseoHome) {
  let raw;
  try {
    raw = readFileSync(vaultConfigPath(paseoHome), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw vaultError("corrupted-vault-config", `${vaultConfigPath(paseoHome)} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof parsed.repo !== "string") {
    throw vaultError("corrupted-vault-config", `${vaultConfigPath(paseoHome)} is not a vault config (repo must be a string)`);
  }
  return withConfigDefaults(parsed);
}

export function saveVaultConfig(paseoHome, config) {
  const full = withConfigDefaults(config);
  const path = vaultConfigPath(paseoHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return full;
}

export function readVaultStatus(paseoHome, passphrase, ghAuth) {
  let config = null;
  let error = null;
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
    ghInstalled: ghAuth?.ghInstalled ?? false,
    ghAuthenticated: ghAuth?.ghAuthenticated ?? false,
    ghUser: ghAuth?.ghUser ?? null,
    suggestedRepo: ghAuth?.suggestedRepo ?? null,
    error,
  };
}

/** The obfuscation mask — base64 alone hides PEM markers; the mask defeats a scanner that decodes and re-scans. */
const OBFUSCATION_MASK = Buffer.from("paseo-factory-vault-obfuscation-v1", "utf8");

/** The shared-secret file names the status view probes under `<paseoHome>/vault-runtime/secrets/`. */
const SHARED_SECRET_FILES = {
  ascKey: "asc-api-key.p8",
  ascCredentials: "asc-credentials.json",
  gplayServiceAccount: "gplay-service-account.json",
  eyeConfig: "eye.json",
};

/** Passphrase resolution, ADR 0014 Decision 3: explicit → FACTORY_VAULT_PASSPHRASE → persisted config. */
function resolveVaultPassphrase(persisted, explicit) {
  if (explicit !== undefined && explicit !== "") return explicit;
  const env = process.env.FACTORY_VAULT_PASSPHRASE;
  if (env !== undefined && env !== "") return env;
  return persisted !== undefined && persisted !== "" ? persisted : undefined;
}

/** XOR is its own inverse — one function seals and unmasks the obfuscated payload. */
function xorMask(payload) {
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    out[i] = payload[i] ^ OBFUSCATION_MASK[i % OBFUSCATION_MASK.length];
  }
  return out;
}

/** Recognizes a serialized VaultEnvelope (v: 1, known mode, string data); anything else is Plaintext Direct mode. */
function parseEnvelope(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if (parsed.v !== 1) return null;
  if (parsed.mode !== "obfuscated" && parsed.mode !== "aes-256-gcm") return null;
  if (typeof parsed.data !== "string") return null;
  const envelope = { v: 1, mode: parsed.mode, data: parsed.data };
  if (typeof parsed.salt === "string") envelope.salt = parsed.salt;
  if (typeof parsed.iv === "string") envelope.iv = parsed.iv;
  if (typeof parsed.tag === "string") envelope.tag = parsed.tag;
  return envelope;
}

/** Decodes one base64 GCM field at its fixed byte length — a malformed envelope is a decrypt failure. */
function decodeEnvelopeField(envelope, field, length) {
  const value = envelope[field];
  if (typeof value !== "string") {
    throw vaultError("vault-decrypt-failed", `the aes-256-gcm envelope is missing its ${field}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== length) {
    throw vaultError("vault-decrypt-failed", `the aes-256-gcm envelope's ${field} must decode to ${length} bytes, got ${decoded.length}`);
  }
  return decoded;
}

/** Any hostname (or caller-supplied nodeId) as a legal `[a-z0-9-]` segment; "node" when nothing survives. */
function normalizeNodeId(raw) {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized !== "" ? normalized : "node";
}

/** Fills branch/nodeId defaults; optional fields stay absent, never undefined-present. */
function withConfigDefaults(config) {
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

/** Probes one shared-secret file — both the flat and the three-tier secrets/shared/ spot. */
function sharedSecretExists(paseoHome, name) {
  const secrets = join(paseoHome, "vault-runtime", "secrets");
  return existsSync(join(secrets, name)) || existsSync(join(secrets, "shared", name));
}

/** Canonical keys with any hydrated app secret — the hydratedApps source, sorted. */
function hydratedAppKeys(paseoHome) {
  try {
    return readdirSync(join(paseoHome, "vault-runtime", "secrets", "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Merges hydration/push stamps into the persisted config, preserving every other field. */
function stampVaultConfig(paseoHome, prior, fallbackRepo, stamps) {
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

// ===== Stage B (ADR 0014 Decision 2): runner seam + gh probe + both transports =====

/** The default runner's stdout ceiling — vault tarballs are binary and can be large. */
const VAULT_RUNNER_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const VAULT_FALLBACK_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/**
 * Appends macOS/POSIX fallback binary directories to `basePath` when absent,
 * preserving any caller/test prepended entries first so `PATH` shims always win.
 */
export function buildVaultPath(basePath = process.env.PATH ?? "") {
  const segments = basePath.split(":").filter((segment) => segment !== "");
  for (const fallback of VAULT_FALLBACK_PATH_DIRS) {
    if (!segments.includes(fallback)) segments.push(fallback);
  }
  return segments.join(":");
}

export function createDefaultVaultRunner() {
  return (call) =>
    new Promise((resolve, reject) => {
      const childEnv = { ...process.env, ...call.env, GIT_TERMINAL_PROMPT: "0" };
      childEnv.PATH = buildVaultPath(childEnv.PATH);
      execFile(
        call.command,
        [...call.args],
        {
          cwd: call.cwd,
          encoding: "buffer",
          maxBuffer: VAULT_RUNNER_MAX_BUFFER_BYTES,
          env: childEnv,
        },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr.length > 0 ? stderr.toString("utf8").trim() : err.message;
            reject(vaultError("vault-runner-failed", `${call.command} ${call.args.join(" ")}: ${detail}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
}

const builtinVaultRunner = createDefaultVaultRunner();

const GH_AUTH_CACHE_TTL_MS = 15_000;
const ghAuthCache = new Map();

/** Clears the 15-second `probeGhAuth` cache (used by tests and explicit login re-checks). */
export function clearGhAuthCache() {
  ghAuthCache.clear();
}

/**
 * Probes GitHub CLI (`gh`) installation and active `github.com` login via
 * `gh auth status --json hosts` (falling back to `gh api user --jq .login`
 * when `--json` is unsupported on older `gh`), cached for 15 seconds per
 * runner so snapshot polls never spam subprocesses.
 */
export async function probeGhAuth(runner) {
  const effectiveRunner = runner ?? builtinVaultRunner;
  const now = Date.now();
  const cached = ghAuthCache.get(effectiveRunner);
  if (cached !== undefined && now < cached.expiresAt) {
    return { ...cached.value };
  }

  const store = (value) => {
    if (value.ghAuthenticated) {
      ghAuthCache.set(effectiveRunner, { expiresAt: Date.now() + GH_AUTH_CACHE_TTL_MS, value });
    }
    return { ...value };
  };

  try {
    const out = await effectiveRunner({ command: "gh", args: ["auth", "status", "--json", "hosts"] });
    const parsed = parseGhHostsStatus(out.toString("utf8"));
    if (parsed.kind === "authenticated") {
      return store({
        ghInstalled: true,
        ghAuthenticated: true,
        ghUser: parsed.login,
        suggestedRepo: `${parsed.login}/factory-vault`,
      });
    }
    if (parsed.kind === "unauthenticated") {
      return store({ ghInstalled: true, ghAuthenticated: false, ghUser: null, suggestedRepo: null });
    }
  } catch (err) {
    if (isGhMissingError(err)) {
      return store({ ghInstalled: false, ghAuthenticated: false, ghUser: null, suggestedRepo: null });
    }
    if (isGhUnauthenticatedError(err)) {
      return store({ ghInstalled: true, ghAuthenticated: false, ghUser: null, suggestedRepo: null });
    }
  }

  try {
    const out = await effectiveRunner({ command: "gh", args: ["api", "user", "--jq", ".login"] });
    const login = out.toString("utf8").trim().split(/\r?\n/)[0]?.trim() ?? "";
    if (login !== "" && !login.includes(" ") && !login.startsWith("{")) {
      return store({
        ghInstalled: true,
        ghAuthenticated: true,
        ghUser: login,
        suggestedRepo: `${login}/factory-vault`,
      });
    }
  } catch (err) {
    if (isGhMissingError(err)) {
      return store({ ghInstalled: false, ghAuthenticated: false, ghUser: null, suggestedRepo: null });
    }
  }

  return store({ ghInstalled: true, ghAuthenticated: false, ghUser: null, suggestedRepo: null });
}

function parseGhHostsStatus(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "unknown" };
  const hosts = parsed.hosts;
  if (typeof hosts !== "object" || hosts === null) return { kind: "unknown" };

  const candidates = [];
  if (Array.isArray(hosts)) {
    for (const item of hosts) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        if (item.host === undefined || item.host === "github.com") candidates.push(item);
      }
    }
  } else {
    const ghCom = hosts["github.com"];
    if (Array.isArray(ghCom)) {
      for (const item of ghCom) {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          candidates.push(item);
        }
      }
    } else if (typeof ghCom === "object" && ghCom !== null) {
      candidates.push(ghCom);
    }
  }

  const valid = candidates.filter((entry) => {
    const login = typeof entry.login === "string" ? entry.login.trim() : typeof entry.user === "string" ? entry.user.trim() : "";
    if (login === "") return false;
    if (typeof entry.state === "string" && entry.state !== "success") return false;
    if (entry.authenticated === false) return false;
    return true;
  });

  if (valid.length === 0) return { kind: "unauthenticated" };
  const chosen = valid.find((entry) => entry.active === true) ?? valid[0];
  const login = (typeof chosen.login === "string" ? chosen.login : chosen.user).trim();
  return { kind: "authenticated", login };
}

function isGhMissingError(err) {
  if (err?.code === "ENOENT") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\bENOENT\b|command not found|spawn gh\b.*not found|\bgh:\s*not found|\bgh not found\b|^not found$/i.test(msg);
}

function isGhUnauthenticatedError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /not logged in|You are not logged into|authentication failed|To log in, run|no oauth token/i.test(msg);
}

/**
 * Ensures the remote GitHub repository `<owner>/<repo>` exists: returns
 * `{ created: false, repo }` immediately for local filesystem paths or URLs,
 * otherwise runs `gh auth setup-git --hostname github.com` (best-effort),
 * probes `gh repo view <slug> --json nameWithOwner`, and creates the private
 * repository via `gh repo create <slug> --private --add-readme --description "Private vault for paseo-factory"`
 * when absent.
 */
export async function ensureRemoteVaultRepo(repo, runner) {
  const trimmed = repo.trim();
  if (
    isAbsolute(trimmed) ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("file://") ||
    trimmed.includes("://") ||
    /^[^/]+@[^:]+:/.test(trimmed)
  ) {
    return { created: false, repo };
  }
  const stripped = trimmed.replace(/^git:/, "").replace(/\.git$/, "");
  if (!/^[^\s/]+\/[^\s/]+$/.test(stripped)) {
    return { created: false, repo };
  }

  const effectiveRunner = runner ?? builtinVaultRunner;
  try {
    await effectiveRunner({ command: "gh", args: ["auth", "setup-git", "--hostname", "github.com"] });
  } catch {
    // best-effort: setup-git is non-fatal when git credentials are already configured
  }

  try {
    await effectiveRunner({ command: "gh", args: ["repo", "view", stripped, "--json", "nameWithOwner"] });
    return { created: false, repo: stripped };
  } catch {
    // repository does not exist yet — create it below
  }

  await effectiveRunner({
    command: "gh",
    args: ["repo", "create", stripped, "--private", "--add-readme", "--description", "Private vault for paseo-factory"],
  });
  return { created: true, repo: stripped };
}

/**
 * Mode A — Direct hydrate: streams GET /repos/{owner}/{repo}/tarball/{ref}
 * through the machine's `gh api` session, gunzips and walks the tar in
 * memory, unseals each entry, writes the three-tier layout into
 * `<paseoHome>/vault-runtime/` (0o600 under secrets/) — no `.git` checkout
 * on disk — then runs stage-C hydration (per-Project materialization, config
 * materialization, env.json) and optional ledger reconciliation.
 */
export async function hydrateVaultDirect(paseoHome, options = {}) {
  const config = loadVaultConfig(paseoHome);
  const repo = options.repo ?? config?.repo;
  if (repo === undefined || repo.trim() === "") {
    throw vaultError(
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

  const passphrase = resolveVaultPassphrase(config?.passphrase);
  const hydratedFiles = [];
  for (const entry of parseTarEntries(archive)) {
    const vaultPath = vaultPathFromArchivePath(entry.path);
    if (vaultPath === null) continue;
    writeRuntimeFile(paseoHome, vaultPath, unsealVaultBuffer(entry.data, passphrase));
    hydratedFiles.push(vaultPath);
  }

  applyVaultHydration(paseoHome, options.overwriteConfigs ?? false);
  if (options.mergeLedgers === true) reconcileVaultLedgerState(paseoHome);
  stampVaultConfig(paseoHome, config, repo, { lastHydratedAt: nowIso(), lastHydrateMode: "direct" });
  return { repo, ref, hydratedFiles: hydratedFiles.sort() };
}

/**
 * Mode B, hydrating leg — Vault sync: `git clone` when `<paseoHome>/vault` is
 * absent (with empty-remote fallback), else `git pull --rebase --autostash`,
 * then hydrate `<paseoHome>/vault-runtime/` from the checkout, materialize
 * per-Project secrets and configs, and optionally reconcile multi-node ledgers.
 */
export async function pullVault(paseoHome, options = {}) {
  const config = requiredVaultConfig(paseoHome);
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

  const hydratedFiles = hydrateRuntimeFromTree(paseoHome, vaultDir, resolveVaultPassphrase(config.passphrase));
  applyVaultHydration(paseoHome, options.overwriteConfigs ?? false);
  if (options.mergeLedgers === true) reconcileVaultLedgerState(paseoHome);
  stampVaultConfig(paseoHome, config, config.repo, { lastHydratedAt: nowIso(), lastHydrateMode: "sync" });
  return { hydratedFiles };
}

/**
 * Mode B, publishing leg: ensures the cached checkout at `<paseoHome>/vault`
 * (cloning when absent, with empty-remote fallback), collects local state into
 * `vault-runtime`, packages `vault-runtime` into the checkout under the
 * push-side re-seal law, snapshots both global and per-Project ledgers under
 * this node's namespace when `includeLedger` is set, commits (when dirty) and
 * pushes. Stamps lastPushedAt.
 */
export async function pushVault(paseoHome, options = {}) {
  const config = requiredVaultConfig(paseoHome);
  const runner = options.runner ?? builtinVaultRunner;
  const vaultDir = join(paseoHome, "vault");

  await ensureVaultCheckout(runner, config, vaultDir);
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
      copyFileSync(globalLedger, target);
      pushedFiles.add(`state/nodes/${config.nodeId}/global-ledger.jsonl`);
    }
    const slugToKey = new Map();
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

/**
 * Unified smart bidirectional sync (spec §Implementation Decisions 3):
 * 1. Auto-selects `<ghUser>/factory-vault` via `probeGhAuth` when unconfigured.
 * 2. Persists `vault-config.json` and ensures the remote repository exists via `ensureRemoteVaultRepo`.
 * 3. Runs `pullVault` (hydrating secrets, materializing configs, and reconciling multi-node ledgers).
 * 4. Runs `pushVault` (collecting local configs/state/store-manifests and node ledgers, then pushing).
 */
export async function syncVault(paseoHome, options = {}) {
  const existing = loadVaultConfig(paseoHome);
  let repo = options.repo !== undefined && options.repo.trim() !== "" ? options.repo.trim() : existing?.repo?.trim() ?? "";
  if (repo === "") {
    const gh = await probeGhAuth(options.runner);
    if (gh.ghAuthenticated && gh.suggestedRepo !== null && gh.suggestedRepo.trim() !== "") {
      repo = gh.suggestedRepo.trim();
    } else {
      throw vaultError(
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

  saveVaultConfig(paseoHome, {
    repo,
    branch,
    ...(existing?.nodeId === undefined ? {} : { nodeId: existing.nodeId }),
    ...(passphrase === undefined ? {} : { passphrase }),
    ...(existing?.lastHydratedAt === undefined ? {} : { lastHydratedAt: existing.lastHydratedAt }),
    ...(existing?.lastHydrateMode === undefined ? {} : { lastHydrateMode: existing.lastHydrateMode }),
    ...(existing?.lastPushedAt === undefined ? {} : { lastPushedAt: existing.lastPushedAt }),
  });

  const pullResult = await pullVault(paseoHome, {
    mergeLedgers: options.mergeLedgers ?? true,
    overwriteConfigs: options.overwriteConfigs ?? false,
    runner: options.runner,
  });

  const pushResult = await pushVault(paseoHome, {
    includeLedger: options.includeLedger ?? true,
    runner: options.runner,
  });

  const createdNote = ensured.created ? `created private repo ${repo}; ` : "";
  const pushNote = pushResult.pushed
    ? `pushed ${pushResult.pushedFiles.length} file(s)`
    : `up to date (${pushResult.pushedFiles.length} file(s) tracked)`;
  const summary = `Vault synced with ${repo} (${branch}): ${createdNote}hydrated ${pullResult.hydratedFiles.length} file(s), ${pushNote}.`;

  return {
    createdRepo: ensured.created,
    repo,
    branch,
    hydratedFiles: pullResult.hydratedFiles,
    pushedFiles: pushResult.pushedFiles,
    pushed: pushResult.pushed,
    summary,
  };
}

function expandImportPath(rawPath) {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function readImportFile(rawPath, label) {
  const path = expandImportPath(rawPath);
  if (!existsSync(path)) {
    throw vaultError("vault-import-file-not-found", `${label} file not found at "${path}"`);
  }
  return readFileSync(path);
}

/**
 * 1-Click Key Import (spec §Implementation Decisions 3):
 * Imports `.p8`, ASC credentials, Google Play service account `.json`, `eye.json`,
 * and per-app Android/Firebase signing files from disk (or `process.env` when no
 * explicit inputs are given) into `<paseoHome>/vault-runtime/secrets/`, updates
 * `env.json` and local project checkouts via `applyVaultHydration`, and optionally
 * runs `syncVault` so imported keys are sealed and pushed to the remote vault.
 */
export async function importVaultSecrets(paseoHome, input = {}) {
  const explicitFields = [
    input.ascKeyPath,
    input.ascKeyId,
    input.ascIssuer,
    input.gplayKeyPath,
    input.eyeConfigPath,
    input.keystorePath,
    input.storePass,
    input.keyAlias,
    input.firebaseProjectId,
    input.googleServicesJsonPath,
    input.googleServiceInfoPlistPath,
  ];
  const hasExplicit = explicitFields.some((val) => val !== undefined && val.trim() !== "");

  const ascKeyPath = hasExplicit
    ? input.ascKeyPath?.trim() || undefined
    : process.env.ASC_KEY_PATH?.trim() && existsSync(expandImportPath(process.env.ASC_KEY_PATH))
      ? process.env.ASC_KEY_PATH.trim()
      : undefined;
  const ascKeyId = hasExplicit ? input.ascKeyId?.trim() || undefined : process.env.ASC_KEY_ID?.trim() || undefined;
  const ascIssuer = hasExplicit ? input.ascIssuer?.trim() || undefined : process.env.ASC_ISSUER?.trim() || undefined;
  const gplayKeyPath = hasExplicit
    ? input.gplayKeyPath?.trim() || undefined
    : process.env.GPLAY_KEY_PATH?.trim() && existsSync(expandImportPath(process.env.GPLAY_KEY_PATH))
      ? process.env.GPLAY_KEY_PATH.trim()
      : undefined;
  const eyeConfigPath = input.eyeConfigPath?.trim() || undefined;

  const config = loadVaultConfig(paseoHome);
  const passphrase = resolveVaultPassphrase(config?.passphrase);
  const importedFiles = new Set();
  const runtimeRoot = join(paseoHome, "vault-runtime");
  const importFile = (rawPath, label, rel) => {
    if (rawPath === undefined) return;
    const bytes = unsealVaultBuffer(readImportFile(rawPath, label), passphrase);
    writeRuntimeFile(paseoHome, rel, bytes);
    importedFiles.add(rel);
  };

  importFile(ascKeyPath, "ASC .p8 key", `secrets/shared/${SHARED_SECRET_FILES.ascKey}`);

  if (ascKeyId !== undefined || ascIssuer !== undefined) {
    const rel = `secrets/shared/${SHARED_SECRET_FILES.ascCredentials}`;
    const prior = readJsonFile(join(runtimeRoot, rel)) ?? {};
    const merged = {
      ...prior,
      ...(ascKeyId !== undefined ? { keyId: ascKeyId } : {}),
      ...(ascIssuer !== undefined ? { issuerId: ascIssuer } : {}),
    };
    writeRuntimeFile(paseoHome, rel, Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8"));
    importedFiles.add(rel);
  }

  importFile(gplayKeyPath, "Google Play service account JSON", `secrets/shared/${SHARED_SECRET_FILES.gplayServiceAccount}`);
  importFile(eyeConfigPath, "Eye config JSON", `secrets/shared/${SHARED_SECRET_FILES.eyeConfig}`);

  const keystorePath = input.keystorePath?.trim() || undefined;
  const storePass = input.storePass?.trim() || undefined;
  const keyAlias = input.keyAlias?.trim() || undefined;
  const firebaseProjectId = input.firebaseProjectId?.trim() || undefined;
  const googleServicesJsonPath = input.googleServicesJsonPath?.trim() || undefined;
  const googleServiceInfoPlistPath = input.googleServiceInfoPlistPath?.trim() || undefined;

  const hasAppInputs =
    keystorePath !== undefined ||
    storePass !== undefined ||
    keyAlias !== undefined ||
    firebaseProjectId !== undefined ||
    googleServicesJsonPath !== undefined ||
    googleServiceInfoPlistPath !== undefined;

  if (hasAppInputs) {
    let appKey = input.appKey?.trim() ?? "";
    if (appKey === "") {
      const roots = collectCandidateProjectRoots(paseoHome);
      const firstFacts = roots.map(inspectProjectRootFacts).find((f) => f !== null) ?? null;
      appKey = firstFacts?.basename ?? "default";
    }
    assertSafeVaultPath(`secrets/apps/${appKey}`);

    importFile(keystorePath, "Android release keystore", `secrets/apps/${appKey}/release.keystore`);

    if (storePass !== undefined || keyAlias !== undefined) {
      const rel = `secrets/apps/${appKey}/signing.json`;
      const prior = readJsonFile(join(runtimeRoot, rel)) ?? {};
      const merged = {
        ...prior,
        ...(storePass !== undefined
          ? {
              storePassword: storePass,
              ...(typeof prior.keyPassword === "string" && prior.keyPassword !== "" ? {} : { keyPassword: storePass }),
            }
          : {}),
        ...(keyAlias !== undefined ? { keyAlias } : {}),
      };
      writeRuntimeFile(paseoHome, rel, Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8"));
      importedFiles.add(rel);
    }

    if (googleServicesJsonPath !== undefined) {
      importFile(googleServicesJsonPath, "google-services.json", `secrets/apps/${appKey}/google-services.json`);
    } else if (firebaseProjectId !== undefined) {
      const rel = `secrets/apps/${appKey}/google-services.json`;
      const prior = readJsonFile(join(runtimeRoot, rel)) ?? {};
      const priorInfo =
        typeof prior.project_info === "object" && prior.project_info !== null && !Array.isArray(prior.project_info)
          ? prior.project_info
          : {};
      const merged = {
        ...prior,
        project_info: { ...priorInfo, project_id: firebaseProjectId },
      };
      writeRuntimeFile(paseoHome, rel, Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8"));
      importedFiles.add(rel);
    }

    importFile(googleServiceInfoPlistPath, "GoogleService-Info.plist", `secrets/apps/${appKey}/GoogleService-Info.plist`);

    const manifest = existsSync(join(runtimeRoot, "vault.manifest.json"))
      ? readVaultManifestAt(runtimeRoot)
      : readVaultManifestAt(join(paseoHome, "vault"));
    if (manifest[appKey] === undefined) {
      manifest[appKey] = { repoBasename: appKey };
      writeRuntimeFile(paseoHome, "vault.manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
    }
  }

  applyVaultHydration(paseoHome);

  const sortedImported = [...importedFiles].sort();
  let synced = null;
  if (input.syncAfterImport !== false) {
    const configured = (loadVaultConfig(paseoHome)?.repo?.trim() ?? "") !== "";
    const canSync = configured || (await probeGhAuth(input.runner)).ghAuthenticated;
    if (canSync) {
      synced = await syncVault(paseoHome, { runner: input.runner });
    }
  }

  const syncSuffix =
    synced !== null
      ? ` and synced with ${synced.repo} (${synced.pushed ? `pushed ${synced.pushedFiles.length} file(s)` : "up to date"})`
      : " into local vault-runtime";
  const summary =
    sortedImported.length > 0
      ? `Imported ${sortedImported.length} secret file(s) (${sortedImported.join(", ")})${syncSuffix}.`
      : `No new secret files imported${synced !== null ? `; synced with ${synced.repo}` : ""}.`;

  return {
    importedFiles: sortedImported,
    synced,
    summary,
  };
}

/**
 * Ensures `<vaultDir>/.git` exists: tries `git clone --branch <branch> <url> <vaultDir>`
 * first, and when `<branch>` does not exist on an empty/branchless remote, cleans
 * `<vaultDir>`, clones without `--branch`, and initializes `<branch>` locally via
 * `git checkout -B <branch>`.
 */
async function ensureVaultCheckout(runner, config, vaultDir) {
  if (existsSync(join(vaultDir, ".git"))) return;
  if (existsSync(vaultDir)) rmSync(vaultDir, { recursive: true, force: true });
  const remoteUrl = vaultRemoteUrl(config.repo);
  try {
    await runner({ command: "git", args: ["clone", "--branch", config.branch, remoteUrl, vaultDir] });
  } catch (err) {
    if (!isMissingRemoteBranchCloneError(err)) throw err;
    if (existsSync(vaultDir)) rmSync(vaultDir, { recursive: true, force: true });
    await runner({ command: "git", args: ["clone", remoteUrl, vaultDir] });
    await runner({ command: "git", args: ["checkout", "-B", config.branch], cwd: vaultDir });
    const gitConfigPath = join(vaultDir, ".git", "config");
    if (existsSync(gitConfigPath)) {
      const gitConfig = readFileSync(gitConfigPath, "utf8");
      if (!gitConfig.includes(`[branch "${config.branch}"]`)) {
        writeFileSync(
          gitConfigPath,
          `${gitConfig.endsWith("\n") ? gitConfig : `${gitConfig}\n`}[branch "${config.branch}"]\n\tremote = origin\n\tmerge = refs/heads/${config.branch}\n`,
        );
      }
    }
  }
}

function isMissingRemoteBranchCloneError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /Remote branch .* not found|Could not find remote branch|cloned an empty repository|unborn/i.test(msg);
}

function isEmptyOrUnbornPullError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /There is no tracking information|Couldn't find remote ref|no such ref was fetched|Remote branch .* not found|does not have any commits yet|unborn/i.test(msg);
}

/**
 * Stages one vault-runtime file into the vault checkout under the push-side
 * re-seal law (src/vault.ts's stageRuntimeFileIntoCheckout, mirrored).
 */
function stageRuntimeFileIntoCheckout(runtimePath, target, passphrase, relPath) {
  let existing = null;
  try {
    existing = readFileSync(target);
  } catch {
    existing = null;
  }
  const runtimeBytes = readFileSync(runtimePath);
  const envelope = existing === null ? null : parseEnvelope(existing);
  if (envelope !== null && existing !== null) {
    if (runtimeBytes.equals(existing)) return;
    if (parseEnvelope(runtimeBytes) !== null) {
      if (tryUnseal(existing, passphrase, (a) => tryUnseal(runtimeBytes, passphrase, (b) => a.equals(b)))) return;
    } else {
      let unsealed;
      try {
        unsealed = unsealVaultBuffer(existing, passphrase);
      } catch {
        throw vaultError(
          "vault-push-passphrase-required",
          `vault push cannot stage ${basename(target)}: the checkout holds a sealed envelope and no passphrase resolves to verify the runtime copy against it — restore the passphrase or stage an envelope (vault seal)`,
        );
      }
      if (unsealed.equals(runtimeBytes)) return;
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

/** Runs `unseal` and maps both refusal codes to false — a verification probe, never a hard failure. */
function tryUnseal(raw, passphrase, then) {
  try {
    return then(unsealVaultBuffer(raw, passphrase));
  } catch (err) {
    if (err !== null && typeof err === "object" && (err.code === "vault-passphrase-required" || err.code === "vault-decrypt-failed")) {
      return false;
    }
    throw err;
  }
}

/**
 * The seal verb's one act: read `<source>`, seal it (no passphrase → the
 * zero-passphrase obfuscated envelope; a passphrase → aes-256-gcm), and
 * stage the envelope JSON at `<paseoHome>/vault-runtime/<vaultPath>` under
 * the runtime tree's permission law — `vault push` publishes it from there.
 */
export function sealVaultFile(paseoHome, sourcePath, vaultPath, passphrase) {
  let plain;
  try {
    plain = readFileSync(sourcePath);
  } catch {
    throw vaultError("vault-seal-source-missing", `vault seal: cannot read ${sourcePath}`);
  }
  const envelope = sealVaultBuffer(plain, passphrase);
  const serialized = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  writeRuntimeFile(paseoHome, vaultPath, serialized);
  return { vaultPath, mode: envelope.mode, source: sourcePath, envelopeBytes: serialized.length };
}

/** The config every sync-transport call needs, or the honest refusal. */
function requiredVaultConfig(paseoHome) {
  const config = loadVaultConfig(paseoHome);
  if (config === null || config.repo.trim() === "") {
    throw vaultError(
      "vault-not-configured",
      "Private vault is not configured yet — click Enable & Sync Vault or save a repository in Vault settings",
    );
  }
  return config;
}

/** `owner/repo` for gh api; a leading git: and trailing .git are tolerated, anything else is not a GitHub slug. */
function githubRepoSlug(repo) {
  const stripped = repo.startsWith("git:") ? repo.slice("git:".length) : repo;
  const slug = stripped.endsWith(".git") ? stripped.slice(0, -".git".length) : stripped;
  if (/^[^\s/]+\/[^\s/]+$/.test(slug)) return slug;
  throw vaultError("vault-repo-not-github", `direct hydrate needs a GitHub owner/repo slug, got "${repo}"`);
}

/** The clone/push URL: GitHub slugs expand to https remotes; local paths and URL/SCP forms pass through. */
function vaultRemoteUrl(repo) {
  const stripped = repo.startsWith("git:") ? repo.slice("git:".length) : repo;
  if (stripped.includes("://") || /^[^/]+:/.test(stripped) || stripped.startsWith("/") || stripped.startsWith("./") || stripped.startsWith("../")) {
    return stripped;
  }
  if (/^[^\s/]+\/[^\s/]+$/.test(stripped)) return `https://github.com/${stripped}.git`;
  return stripped;
}

/** Hydrates `<paseoHome>/vault-runtime/` from a vault tree on disk (the sync-mode checkout). */
function hydrateRuntimeFromTree(paseoHome, treeRoot, passphrase) {
  const written = [];
  for (const rel of walkFiles(treeRoot, () => false)) {
    writeRuntimeFile(paseoHome, rel, unsealVaultBuffer(readFileSync(join(treeRoot, rel)), passphrase));
    written.push(rel);
  }
  return written.sort();
}

/** Writes one unsealed vault file under `<paseoHome>/vault-runtime/` — 0o600 (+ 0o700 dirs) under secrets/. */
function writeRuntimeFile(paseoHome, vaultPath, data) {
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

/** A vault path is /-separated relative segments, none of them ./..// — traversal is refused, not written. */
function assertSafeVaultPath(vaultPath) {
  const segments = vaultPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw vaultError("vault-invalid-path", `refusing unsafe vault path "${vaultPath}"`);
  }
}

/** Every file under `root` as /-separated relative paths (sorted), skipping .git directories and `skip` matches. */
function walkFiles(root, skip) {
  const found = [];
  const visit = (dir, rel) => {
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

// ===== the in-memory tar walker (the core's, verbatim in behavior) =====

/** Strips the GitHub tarball's single top-level `<owner>-<repo>-<sha>/` prefix; root-level entries and dirs yield null. */
function vaultPathFromArchivePath(path) {
  const slash = path.indexOf("/");
  if (slash <= 0) return null;
  const rest = path.slice(slash + 1);
  return rest === "" ? null : rest;
}

/**
 * A minimal in-memory tar walker: 512-byte ustar headers, octal sizes, ustar
 * prefix fields, GNU long-name (L) and pax path= overrides, directories and
 * links skipped, the zero-block end marker honored, a truncated archive
 * refused.
 */
function parseTarEntries(archive) {
  const entries = [];
  let pendingPath = null;
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (isAllZeroes(header)) break;
    const size = parseTarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw vaultError("corrupted-vault-tarball", `the vault tarball is truncated inside an entry (needs ${dataEnd} bytes, has ${archive.length})`);
    }
    const data = archive.subarray(dataStart, dataEnd);
    const typeflag = String.fromCharCode(header[156]);

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

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function isAllZeroes(block) {
  return block.every((byte) => byte === 0);
}

/** Reads one NUL-terminated string field out of a tar header. */
function tarString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** Reads one octal tar header field; a blank field is 0, garbage is a corrupted archive. */
function parseTarOctal(header, offset, length) {
  const raw = tarString(header, offset, length).trim();
  if (raw === "") return 0;
  const value = parseInt(raw, 8);
  if (Number.isNaN(value)) {
    throw vaultError("corrupted-vault-tarball", `the vault tarball header field at ${offset} is not octal ("${raw}")`);
  }
  return value;
}

/** Extracts path= from a pax extended header's `<len> key=value\n` records, if present. */
function paxPath(data) {
  for (const line of data.toString("utf8").split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const record = line.slice(space + 1);
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") return record.slice(eq + 1);
  }
  return null;
}

function stripTrailingNul(text) {
  return text.replace(/\0+$/, "");
}

function nowIso() {
  return new Date().toISOString();
}

// ===== Stage C (ADR 0014 Decisions 4 & 5): canonical-key routing, per-Project materialization, hygiene, configs, multi-node Ledger reconciler =====

/**
 * Parses and validates `vault.manifest.json` text. The manifest is a plain
 * object of `<canonicalAppKey>` → `{ repoBasename?, gitRemote?, bundleId?,
 * packageName? }` (string legs only); anything else is refused with
 * `corrupted-vault-manifest`.
 */
export function parseVaultManifest(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw vaultError("corrupted-vault-manifest", "vault.manifest.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw vaultError("corrupted-vault-manifest", "vault.manifest.json must be an object of canonicalAppKey → matching legs");
  }
  const manifest = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw vaultError("corrupted-vault-manifest", `vault.manifest.json entry "${key}" must be an object`);
    }
    const entry = {};
    for (const leg of ["repoBasename", "gitRemote", "bundleId", "packageName"]) {
      const field = value[leg];
      if (field === undefined) continue;
      if (typeof field !== "string") {
        throw vaultError("corrupted-vault-manifest", `vault.manifest.json entry "${key}" field "${leg}" must be a string`);
      }
      entry[leg] = field;
    }
    manifest[key] = entry;
  }
  return manifest;
}

/** Reads `<root>/vault.manifest.json`; a missing file is an empty mapping. */
function readVaultManifestAt(root) {
  try {
    return parseVaultManifest(readFileSync(join(root, "vault.manifest.json"), "utf8"));
  } catch (err) {
    if (err !== null && typeof err === "object" && err.code === "corrupted-vault-manifest") throw err;
    return {};
  }
}

/** Reads `<stateDir>/projects/<slug>/project.json` — undefined when the project has no registry yet. */
function readProjectRegistration(stateDir, slug) {
  const path = join(projectStateDir(stateDir, slug), "project.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.root !== "string" || parsed.root === "") return undefined;
    return { slug, root: parsed.root };
  } catch {
    return undefined;
  }
}

/** Every registration on disk, slug order — mirrors src/project.ts. */
function listProjectRegistrations(stateDir) {
  const projectsDir = join(stateDir, "projects");
  let slugs;
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const slug of slugs) {
    const registration = readProjectRegistration(stateDir, slug);
    if (registration !== undefined) out.push(registration);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Discovers projects across factory registrations and `<paseoHome>/projects/projects.json` — mirrors src/project.ts. */
function discoverProjects(stateDir, liveSeatAgents, home) {
  const roots = new Map();
  for (const registration of listProjectRegistrations(stateDir)) {
    roots.set(registration.slug, registration.root);
  }
  for (const agent of liveSeatAgents) {
    const slug = agent.labels?.project;
    if (slug === undefined || agent.labels?.seat === undefined) continue;
    if (!roots.has(slug)) roots.set(slug, agent.cwd);
  }
  if (home !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(join(home, "projects", "projects.json"), "utf8"));
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry === null || typeof entry !== "object") continue;
          if (entry.archivedAt !== null || typeof entry.rootPath !== "string" || entry.rootPath === "") continue;
          const resolved = resolveProject(entry.rootPath);
          if (resolved.ok && !roots.has(resolved.slug)) {
            roots.set(resolved.slug, resolved.root);
          }
        }
      }
    } catch {
      // missing or unreadable Paseo projects.json is ignored
    }
  }
  return [...roots.entries()].map(([slug, root]) => ({ slug, root })).sort((a, b) => a.slug.localeCompare(b.slug));
}

function collectCandidateProjectRoots(paseoHome) {
  const stateDir = vaultStateDir(paseoHome);
  const candidateRoots = new Set();
  for (const registration of listProjectRegistrations(stateDir)) candidateRoots.add(registration.root);
  for (const discovered of discoverProjects(stateDir, [], paseoHome)) {
    if (discovered.root !== null) candidateRoots.add(discovered.root);
  }
  for (const root of readReleaseLabProjectRoots(paseoHome)) candidateRoots.add(root);
  return [...candidateRoots].sort();
}

function inspectProjectRootFacts(root) {
  const resolved = resolveProject(root);
  if (!resolved.ok) return null;
  const storeManifest = readJsonFile(join(resolved.root, ".store-release", "manifest.json"));
  return {
    root: resolved.root,
    slug: resolved.slug,
    basename: basename(resolved.root),
    originUrl: gitProbe(resolved.root, ["config", "--get", "remote.origin.url"]),
    bundleId: jsonStringField(storeManifest, "bundleId") ?? nestedJsonStringField(storeManifest, ["ios", "bundleId"]),
    packageName: jsonStringField(storeManifest, "packageName") ?? nestedJsonStringField(storeManifest, ["android", "packageName"]),
  };
}

export function resolveVaultApps(paseoHome, manifest) {
  const candidateRoots = collectCandidateProjectRoots(paseoHome);
  const factsByRoot = new Map();
  const factsOf = (root) => {
    const cached = factsByRoot.get(root);
    if (cached !== undefined) return cached;
    const facts = inspectProjectRootFacts(root);
    factsByRoot.set(root, facts);
    return facts;
  };

  const out = [];
  for (const canonicalAppKey of Object.keys(manifest).sort()) {
    const entry = manifest[canonicalAppKey];
    let matched = null;
    for (const root of candidateRoots) {
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

function entryMatches(entry, facts) {
  if (entry.repoBasename !== undefined && entry.repoBasename === facts.basename) return true;
  if (entry.gitRemote !== undefined && facts.originUrl !== null && gitRemotesMatch(entry.gitRemote, facts.originUrl)) return true;
  if (entry.bundleId !== undefined && entry.bundleId === facts.bundleId) return true;
  if (entry.packageName !== undefined && entry.packageName === facts.packageName) return true;
  return false;
}

function gitRemotesMatch(a, b) {
  const left = normalizeGitRemote(a);
  const right = normalizeGitRemote(b);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function normalizeGitRemote(url) {
  let u = url.trim();
  if (u.endsWith(".git")) u = u.slice(0, -".git".length);
  const scp = u.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scp !== null) u = `${scp[1]}/${scp[2]}`;
  const scheme = u.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/);
  if (scheme !== null) u = scheme[1];
  u = u.replace(/^[^@/]+@/, "");
  return u.toLowerCase();
}

function readReleaseLabProjectRoots(paseoHome) {
  const parsed = readJsonFile(join(paseoHome, "release-lab", "projects.json"));
  const roots = [];
  for (const entry of arrayField(parsed, "projects")) {
    const root = jsonStringField(entry, "root");
    if (root !== null && root.trim() !== "") roots.push(root);
  }
  return roots;
}

function vaultStateDir(paseoHome) {
  return join(paseoHome, "plugin-state", STATE_PLUGIN_DIR);
}

function gitProbe(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: buildVaultPath(process.env.PATH), GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch {
    return null;
  }
}

/** Reads a JSON file as an object, or null when absent/damaged — a pointer/routing input, not an authority. */
function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A string field of a JSON object, or null. */
function jsonStringField(record, field) {
  const value = record?.[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/** An array field of a JSON object as objects, or empty — malformed entries are skipped, never fatal. */
function arrayField(record, field) {
  const value = record?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

/** A nested two-key string field (project_info.project_id), or null. */
function nestedJsonStringField(record, path) {
  if (record === null) return null;
  const inner = record[path[0]];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return null;
  return jsonStringField(inner, path[1]);
}

/**
 * Registers materialized per-app paths in `<gitCommonDir>/info/exclude` AND
 * `<projectRoot>/.worktreeinclude` (spec §Implementation Decisions 3).
 */
export function ensureLocalGitExcludeAndWorktreeInclude(projectRoot, relPaths) {
  if (relPaths.length === 0) return;
  const commonDirRaw = gitProbe(projectRoot, ["rev-parse", "--git-common-dir"]);
  if (commonDirRaw === null || commonDirRaw === "") {
    throw vaultError("vault-project-not-git", `${projectRoot} does not resolve to a git checkout — vault hygiene has nothing to register against`);
  }
  const gitCommonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolvePath(projectRoot, commonDirRaw);
  appendUniqueLines(join(gitCommonDir, "info", "exclude"), [...relPaths, ".worktreeinclude"]);
  appendUniqueLines(join(projectRoot, ".worktreeinclude"), relPaths);
}

function appendUniqueLines(path, lines) {
  let existing;
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

const APP_FILE_TARGETS = [
  { vaultFile: "release.keystore", projectRel: "android/app/release.keystore" },
  { vaultFile: "signing.json", projectRel: "android/keystore.properties" },
  { vaultFile: "google-services.json", projectRel: "android/app/google-services.json" },
  { vaultFile: "GoogleService-Info.plist", projectRel: "ios/GoogleService-Info.plist" },
];

function materializeVaultAppFiles(paseoHome, canonicalAppKey, projectRoot) {
  const appSecrets = join(paseoHome, "vault-runtime", "secrets", "apps", canonicalAppKey);
  const written = [];
  for (const target of APP_FILE_TARGETS) {
    const source = join(appSecrets, target.vaultFile);
    if (!existsSync(source)) continue;
    let data;
    if (target.vaultFile === "signing.json") {
      const rendered = renderKeystoreProperties(readJsonFile(source));
      if (rendered === null) continue;
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

function renderKeystoreProperties(signing) {
  if (signing === null) return null;
  const lines = Object.keys(signing)
    .filter((key) => typeof signing[key] === "string")
    .sort()
    .map((key) => `${key}=${signing[key]}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : null;
}

/**
 * Collects local state and config files under `<paseoHome>` into `<paseoHome>/vault-runtime/`
 * before staging into `<paseoHome>/vault`.
 */
function collectLocalStateIntoRuntime(paseoHome) {
  const stateDir = vaultStateDir(paseoHome);
  const configSources = [
    { src: join(stateDir, "lanes.json"), vaultRel: "config/lanes.json" },
    { src: join(paseoHome, "connector", "fleet.json"), vaultRel: "config/fleet.json" },
    { src: join(paseoHome, "burn-lab", "free-pool.json"), vaultRel: "config/free-pool.json" },
  ];
  for (const { src, vaultRel } of configSources) {
    if (existsSync(src)) {
      writeRuntimeFile(paseoHome, vaultRel, readFileSync(src));
    }
  }

  const localEye = join(stateDir, "eye.json");
  if (existsSync(localEye) && !sharedSecretExists(paseoHome, SHARED_SECRET_FILES.eyeConfig)) {
    writeRuntimeFile(paseoHome, `secrets/shared/${SHARED_SECRET_FILES.eyeConfig}`, readFileSync(localEye));
  }

  const config = loadVaultConfig(paseoHome);
  const passphrase = resolveVaultPassphrase(config?.passphrase);
  const envAscPath = process.env.ASC_KEY_PATH?.trim();
  if (envAscPath && !sharedSecretExists(paseoHome, SHARED_SECRET_FILES.ascKey)) {
    const expanded = expandImportPath(envAscPath);
    if (existsSync(expanded)) {
      writeRuntimeFile(paseoHome, `secrets/shared/${SHARED_SECRET_FILES.ascKey}`, unsealVaultBuffer(readFileSync(expanded), passphrase));
    }
  }
  const envGplayPath = process.env.GPLAY_KEY_PATH?.trim();
  if (envGplayPath && !sharedSecretExists(paseoHome, SHARED_SECRET_FILES.gplayServiceAccount)) {
    const expanded = expandImportPath(envGplayPath);
    if (existsSync(expanded)) {
      writeRuntimeFile(paseoHome, `secrets/shared/${SHARED_SECRET_FILES.gplayServiceAccount}`, unsealVaultBuffer(readFileSync(expanded), passphrase));
    }
  }

  const runtimeRoot = join(paseoHome, "vault-runtime");
  const vaultDir = join(paseoHome, "vault");
  const manifest = existsSync(join(runtimeRoot, "vault.manifest.json"))
    ? readVaultManifestAt(runtimeRoot)
    : readVaultManifestAt(vaultDir);
  let manifestUpdated = false;
  const seenRoots = new Set();

  for (const candidateRoot of collectCandidateProjectRoots(paseoHome)) {
    const facts = inspectProjectRootFacts(candidateRoot);
    if (facts === null || seenRoots.has(facts.root)) continue;
    seenRoots.add(facts.root);
    const storeManifestPath = join(facts.root, ".store-release", "manifest.json");
    if (!existsSync(storeManifestPath)) continue;

    let canonicalAppKey = null;
    for (const key of Object.keys(manifest).sort()) {
      if (entryMatches(manifest[key], facts)) {
        canonicalAppKey = key;
        break;
      }
    }
    if (canonicalAppKey === null) {
      const storeManifestObj = readJsonFile(storeManifestPath);
      canonicalAppKey = jsonStringField(storeManifestObj, "appKey") ?? facts.basename;
    }

    writeRuntimeFile(paseoHome, `config/apps/${canonicalAppKey}/store-manifest.json`, readFileSync(storeManifestPath));
    const priorEntry = manifest[canonicalAppKey] ?? {};
    manifest[canonicalAppKey] = {
      ...priorEntry,
      repoBasename: facts.basename,
      ...(facts.originUrl !== null && facts.originUrl !== "" ? { gitRemote: facts.originUrl } : {}),
      ...(facts.bundleId !== null ? { bundleId: facts.bundleId } : {}),
      ...(facts.packageName !== null ? { packageName: facts.packageName } : {}),
    };
    manifestUpdated = true;
  }

  if (manifestUpdated) {
    writeRuntimeFile(paseoHome, "vault.manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  }
}

/**
 * Materializes `config/{lanes,fleet,free-pool}.json` inside `<paseoHome>/vault-runtime/`
 * into their local `<paseoHome>` destinations when absent locally (or when `overwriteConfigs === true`).
 */
function materializeConfigsFromRuntime(paseoHome, overwriteConfigs = false) {
  const runtimeConfigDir = join(paseoHome, "vault-runtime", "config");
  const targets = [
    { src: join(runtimeConfigDir, "lanes.json"), dest: join(vaultStateDir(paseoHome), "lanes.json") },
    { src: join(runtimeConfigDir, "fleet.json"), dest: join(paseoHome, "connector", "fleet.json") },
    { src: join(runtimeConfigDir, "free-pool.json"), dest: join(paseoHome, "burn-lab", "free-pool.json") },
  ];
  for (const { src, dest } of targets) {
    if (!existsSync(src)) continue;
    if (!overwriteConfigs && existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

function applyVaultHydration(paseoHome, overwriteConfigs = false) {
  const manifest = readVaultManifestAt(join(paseoHome, "vault-runtime"));
  for (const app of resolveVaultApps(paseoHome, manifest)) {
    if (app.projectRoot === null) continue;
    const written = materializeVaultAppFiles(paseoHome, app.canonicalAppKey, app.projectRoot);
    if (written.length > 0) ensureLocalGitExcludeAndWorktreeInclude(app.projectRoot, written);
  }
  materializeConfigsFromRuntime(paseoHome, overwriteConfigs);
  writeVaultRuntimeEnv(paseoHome);
}

/** Writes the VaultRuntimeEnv pointer index at `<paseoHome>/vault-runtime/env.json`, 0o600. */
function writeVaultRuntimeEnv(paseoHome) {
  const runtimeRoot = join(paseoHome, "vault-runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const path = join(runtimeRoot, "env.json");
  writeFileSync(path, `${JSON.stringify(buildVaultRuntimeEnv(paseoHome), null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * The six runtime keys, each present only when its source hydrated: the
 * shared ASC .p8/credentials and Google Play JSON by path, the keystore
 * storepass of the first (canonical-key order) app's signing.json, and the
 * Firebase project id of its google-services.json.
 */
function buildVaultRuntimeEnv(paseoHome) {
  const shared = join(paseoHome, "vault-runtime", "secrets", "shared");
  const env = {};
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

// ===== Multi-node Ledger reconciler (mirrors src/vault.ts & src/ledger.ts) =====

const EVENT_NAMES = [
  "contract_set",
  "claim_reported",
  "gate_started",
  "gate_finished",
  "fresh_eyes_written",
  "watch_written",
  "report_written",
  "attempt_accepted",
  "permit_allowed",
  "permit_denied",
  "git_blocked",
  "spawn_dispatched",
  "spawn_refused",
  "meter_written",
  "repoke_dispatched",
  "repoke_refused",
  "respawn_dispatched",
  "respawn_refused",
  "needs_human",
  "retro_written",
];

const NEEDS_HUMAN_REASONS = ["denied-again", "silent-after-repoke", "attempt-ceiling", "died-after-respawn"];

function posInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function needsHumanEvidenceIsValid(evidence, reason) {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return false;
  if (Object.keys(evidence).length !== 2) return false;
  const isDenialRepoke = posInt(evidence.denial) && posInt(evidence.repoke);
  const isAttemptGate = posInt(evidence.attempt) && posInt(evidence.gate);
  const isSpawnRespawn = posInt(evidence.spawn) && posInt(evidence.respawn);
  if (reason === "denied-again" || reason === "silent-after-repoke") return isDenialRepoke;
  if (reason === "attempt-ceiling") return isAttemptGate;
  if (reason === "died-after-respawn") return isSpawnRespawn;
  if (reason !== undefined) return false;
  return isDenialRepoke || isAttemptGate || isSpawnRespawn;
}

function usageIsValid(usage) {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return false;
  for (const [key, value] of Object.entries(usage)) {
    if (!["inputTokens", "cachedInputTokens", "outputTokens", "totalCostUsd"].includes(key)) return false;
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
  }
  return true;
}

function shapeIsValid(evt) {
  const taskIsString = typeof evt.task === "string";
  if (evt.event === "contract_set") return taskIsString;
  if (evt.event === "retro_written") {
    return (
      typeof evt.model === "string" &&
      (evt.outcome === "written" || evt.outcome === "failed") &&
      typeof evt.durationMs === "number" &&
      Number.isFinite(evt.durationMs) &&
      evt.durationMs >= 0
    );
  }
  if (evt.event === "permit_allowed" || evt.event === "permit_denied") {
    return taskIsString && typeof evt.agent === "string" && (evt.event === "permit_allowed" || typeof evt.rule === "string");
  }
  if (evt.event === "git_blocked") {
    return (
      (evt.task === undefined || taskIsString) &&
      (evt.agent === undefined || typeof evt.agent === "string") &&
      typeof evt.command === "string" &&
      typeof evt.rule === "string" &&
      typeof evt.cwd === "string" &&
      typeof evt.blockId === "string"
    );
  }
  if (evt.event === "spawn_dispatched" || evt.event === "spawn_refused") {
    return (
      taskIsString &&
      typeof evt.provider === "string" &&
      typeof evt.arity === "number" &&
      Number.isInteger(evt.arity) &&
      evt.arity >= 1 &&
      (evt.event === "spawn_dispatched" || (typeof evt.rule === "string" && typeof evt.reason === "string"))
    );
  }
  if (evt.event === "meter_written") {
    return (
      taskIsString &&
      typeof evt.provider === "string" &&
      (evt.agent === undefined || typeof evt.agent === "string") &&
      usageIsValid(evt.usage)
    );
  }
  if (evt.event === "repoke_dispatched" || evt.event === "repoke_refused") {
    return (
      taskIsString &&
      typeof evt.agent === "string" &&
      (evt.event === "repoke_dispatched" || (typeof evt.rule === "string" && typeof evt.reason === "string"))
    );
  }
  if (evt.event === "respawn_dispatched" || evt.event === "respawn_refused") {
    return (
      taskIsString &&
      typeof evt.provider === "string" &&
      typeof evt.died_agent === "string" &&
      (evt.event === "respawn_dispatched" || (typeof evt.rule === "string" && typeof evt.reason === "string"))
    );
  }
  if (evt.event === "needs_human") {
    return (
      taskIsString &&
      typeof evt.reason === "string" &&
      NEEDS_HUMAN_REASONS.includes(evt.reason) &&
      needsHumanEvidenceIsValid(evt.evidence, evt.reason)
    );
  }
  const attempt = evt.attempt;
  return taskIsString && typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1;
}

function isValidVaultLedgerRecord(evt) {
  if (typeof evt !== "object" || evt === null || Array.isArray(evt)) return false;
  if (typeof evt.seq !== "number" || !Number.isInteger(evt.seq) || evt.seq < 1) return false;
  if (typeof evt.ts !== "string" || evt.ts === "") return false;
  if (typeof evt.event !== "string" || !EVENT_NAMES.includes(evt.event)) return false;
  return shapeIsValid(evt);
}

export function reconcileVaultLedgers(existingLines, sources, options = {}) {
  return reconcileHistory(existingLines, sources, options);
}

function reconcileVaultLedgerState(paseoHome) {
  const stateDir = vaultStateDir(paseoHome);
  const runtimeRoot = join(paseoHome, "vault-runtime");
  mergeLedgerFile(join(stateDir, "ledger.jsonl"), nodeLedgerSourcesAt(runtimeRoot, ["global-ledger.jsonl"]));
  for (const app of resolveVaultApps(paseoHome, readVaultManifestAt(runtimeRoot))) {
    if (app.projectSlug === null) continue;
    mergeLedgerFile(
      join(stateDir, "projects", app.projectSlug, "ledger.jsonl"),
      nodeLedgerSourcesAt(runtimeRoot, ["projects", app.canonicalAppKey, "ledger.jsonl"]),
    );
  }
}

function nodeLedgerSourcesAt(vaultTreeRoot, rel) {
  const nodesDir = join(vaultTreeRoot, "state", "nodes");
  const out = [];
  for (const nodeId of listDirNames(nodesDir)) {
    const path = join(nodesDir, nodeId, ...rel);
    if (existsSync(path)) out.push({ nodeId, lines: readFileSync(path, "utf8") });
  }
  return out;
}

function mergeLedgerFile(localPath, sources) {
  if (sources.length === 0) return;
  let existing = "";
  try {
    existing = readFileSync(localPath, "utf8");
  } catch {
    // no local ledger yet
  }
  const reconciled = reconcileVaultLedgers(existing, sources);
  if (reconciled === "") return;
  mkdirSync(dirname(localPath), { recursive: true });
  const tmp = `${localPath}.reconcile-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, reconciled);
  renameSync(tmp, localPath);
}

function listDirNames(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
