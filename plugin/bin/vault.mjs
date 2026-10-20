/**
 * The CLIs' Private-vault engine mirror (v0.0.21, ADR 0014 / ADR 0004: plain
 * .mjs, importing no src/ or plugin-server code), kept behaviorally identical
 * to src/vault.ts on the surfaces `factory vault` touches by
 * test/vault-cli.test.ts: the dual-mode envelopes round-trip byte-for-byte
 * against sealVaultBuffer/unsealVaultBuffer, `vault status` prints exactly
 * readVaultStatus's view, and hydrate/pull land the same vault-runtime tree
 * the core's transports land (envelopes, permissions, env.json included).
 *
 * What the mirror deliberately does NOT carry — the plugin-side stage-C tail
 * (canonical-key routing into Project checkouts, worktree hygiene, multi-node
 * ledger reconciliation) — stays with the Factory surface's vault RPCs; the
 * CLI moves the vault itself. `vault push --include-ledger` snapshots the
 * global ledger only, for the same reason: per-project snapshots ride the
 * canonical-key routing the plugin owns.
 */
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

/** The core's FactoryError, mirrored as a plain Error carrying the stable code. */
function vaultError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

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
  return join(paseoHome, "plugin-state", "paseo-factory", "vault-config.json");
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

export function readVaultStatus(paseoHome, passphrase) {
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

// ===== Stage B (ADR 0014 Decision 2): both transports =====

/** The default runner's stdout ceiling — vault tarballs are binary and can be large. */
const VAULT_RUNNER_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * One external vault CLI call (`gh api`, `git clone/pull/push`) — never a
 * shell string, always GIT_TERMINAL_PROMPT=0 (children fail instead of
 * prompting), mirroring the core's default VaultRunner.
 */
function runVaultChild(call) {
  return new Promise((resolve, reject) => {
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
          reject(vaultError("vault-runner-failed", `${call.command} ${call.args.join(" ")}: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Mode A — Direct hydrate: streams GET /repos/{owner}/{repo}/tarball/{ref}
 * through the machine's `gh api` session, gunzips and walks the tar in
 * memory, unseals each entry, and writes the three-tier layout into
 * `<paseoHome>/vault-runtime/` (0o600 under secrets/) — no `.git` checkout
 * on disk. Returns the repo/ref used and the hydrated vault-relative paths.
 */
export async function hydrateVaultDirect(paseoHome, options = {}) {
  const config = loadVaultConfig(paseoHome);
  const repo = options.repo ?? config?.repo;
  if (repo === undefined || repo.trim() === "") {
    throw vaultError("vault-not-configured", "hydrate needs a vault repo — pass --repo <owner/repo> or save a VaultConfig first");
  }
  const slug = githubRepoSlug(repo);
  const ref = options.ref ?? config?.branch ?? "main";
  const env = options.token !== undefined && options.token !== "" ? { GH_TOKEN: options.token } : undefined;

  const tarball = await runVaultChild({ command: "gh", args: ["api", `repos/${slug}/tarball/${ref}`], env });
  const archive = tarball.length > 2 && tarball[0] === 0x1f && tarball[1] === 0x8b ? gunzipSync(tarball) : tarball;

  const passphrase = resolveVaultPassphrase(config?.passphrase);
  const hydratedFiles = [];
  for (const entry of parseTarEntries(archive)) {
    const vaultPath = vaultPathFromArchivePath(entry.path);
    if (vaultPath === null) continue;
    writeRuntimeFile(paseoHome, vaultPath, unsealVaultBuffer(entry.data, passphrase));
    hydratedFiles.push(vaultPath);
  }

  writeVaultRuntimeEnv(paseoHome);
  stampVaultConfig(paseoHome, config, repo, { lastHydratedAt: nowIso(), lastHydrateMode: "direct" });
  return { repo, ref, hydratedFiles: hydratedFiles.sort() };
}

/**
 * Mode B, hydrating leg — Vault sync: `git clone` when `<paseoHome>/vault` is
 * absent, else `git pull --rebase --autostash`, then hydrate
 * `<paseoHome>/vault-runtime/` from the checkout (every file unsealed, 0o600
 * under secrets/, `.git` never walked). Stamps lastHydrateMode: "sync".
 */
export async function pullVault(paseoHome) {
  const config = requiredVaultConfig(paseoHome);
  const vaultDir = join(paseoHome, "vault");

  if (existsSync(join(vaultDir, ".git"))) {
    await runVaultChild({ command: "git", args: ["pull", "--rebase", "--autostash"], cwd: vaultDir });
  } else {
    if (existsSync(vaultDir)) rmSync(vaultDir, { recursive: true, force: true });
    await runVaultChild({ command: "git", args: ["clone", "--branch", config.branch, vaultRemoteUrl(config.repo), vaultDir] });
  }

  const hydratedFiles = hydrateRuntimeFromTree(paseoHome, vaultDir, resolveVaultPassphrase(config.passphrase));
  writeVaultRuntimeEnv(paseoHome);
  stampVaultConfig(paseoHome, config, config.repo, { lastHydratedAt: nowIso(), lastHydrateMode: "sync" });
  return { hydratedFiles };
}

/**
 * Mode B, publishing leg: ensures the cached checkout at `<paseoHome>/vault`
 * (cloning when absent), packages the `vault-runtime` tree into it by vault
 * path verbatim (envelopes stay envelopes; env.json — the machine-local
 * pointer index — never rides), optionally snapshots the global ledger under
 * this node's namespace, commits (nothing when the tree is clean — no empty
 * commits) and pushes. Stamps lastPushedAt.
 */
export async function pushVault(paseoHome, options = {}) {
  const config = requiredVaultConfig(paseoHome);
  const vaultDir = join(paseoHome, "vault");

  if (!existsSync(join(vaultDir, ".git"))) {
    if (existsSync(vaultDir)) rmSync(vaultDir, { recursive: true, force: true });
    await runVaultChild({ command: "git", args: ["clone", "--branch", config.branch, vaultRemoteUrl(config.repo), vaultDir] });
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
    // the global ledger only — per-project snapshots ride the canonical-key
    // routing the plugin surface owns (the mirror deliberately skips stage C)
    const globalLedger = join(paseoHome, "plugin-state", "paseo-factory", "ledger.jsonl");
    if (existsSync(globalLedger)) {
      const target = join(vaultDir, "state", "nodes", config.nodeId, "global-ledger.jsonl");
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(globalLedger, target);
      pushedFiles.add(`state/nodes/${config.nodeId}/global-ledger.jsonl`);
    }
  }

  const status = (await runVaultChild({ command: "git", args: ["status", "--porcelain"], cwd: vaultDir })).toString("utf8").trim();
  const pushed = status !== "";
  if (pushed) {
    await runVaultChild({ command: "git", args: ["add", "-A"], cwd: vaultDir });
    await runVaultChild({
      command: "git",
      args: ["-c", "user.name=paseo-factory", "-c", "user.email=vault@paseo-factory.invalid", "commit", "-m", `vault push from ${config.nodeId}`],
      cwd: vaultDir,
    });
    await runVaultChild({ command: "git", args: ["push", "origin", config.branch], cwd: vaultDir });
  }

  stampVaultConfig(paseoHome, config, config.repo, { lastPushedAt: nowIso() });
  return { pushedFiles: [...pushedFiles].sort(), pushed };
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
    throw vaultError("vault-not-configured", "the vault transport needs a configured repo — save a VaultConfig first");
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

// ===== the runtime pointer index (ADR 0014 Decision 5's zero-shell-config hand-off) =====

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
 * storepass from the first (canonical-key order) app's signing.json, and the
 * Firebase project id from its google-services.json.
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

/** Reads a JSON file as an object, or null when absent/damaged — a pointer input, not an authority. */
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

/** A nested two-key string field (project_info.project_id), or null. */
function nestedJsonStringField(record, path) {
  if (record === null) return null;
  const inner = record[path[0]];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return null;
  return jsonStringField(inner, path[1]);
}
