import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  Ledger,
  checkCleanAt,
  createDefaultVaultRunner,
  ensureLocalGitExcludeAndWorktreeInclude,
  hydrateVaultDirect,
  loadVaultConfig,
  parseVaultManifest,
  prepareTaskWorktree,
  pullVault,
  pushVault,
  readVaultStatus,
  reconcileVaultLedgers,
  resolveProject,
  resolveVaultApps,
  saveVaultConfig,
  sealVaultBuffer,
  unsealVaultBuffer,
  writeProjectRegistration,
} from "../src/index.ts";
import type { VaultManifest, VaultRunner, VaultRunnerCall, VaultStatusView } from "../src/index.ts";
import { disposeDir, factoryErrorCode, gitCommitAll, makeTempDir } from "./helpers.ts";

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

/**
 * ===== The transport group (ticket 02): the `VaultRunner` seam + both transports =====
 *
 * Direct hydrate runs against an in-memory tarball fixture through an injected
 * fake runner (zero network); Vault sync runs real `git` against local bare
 * repositories seeded over `file://`-style local paths — the repo's first
 * `git init --bare` fixtures. No endpoint, no `~/.paseo`, no prompts.
 */

/** Two plausible ledger lines — stage B copies them verbatim; parsing belongs to stage C. */
const LEDGER_LINES = [
  JSON.stringify({ seq: 1, ts: "2026-10-20T09:00:00.000Z", event: "contract_set", task: "t01", base: "e5b52cc", done: ["gate"] }),
  JSON.stringify({ seq: 2, ts: "2026-10-20T09:05:00.000Z", event: "claim_reported", task: "t01", attempt: 1, agent: "pi", sha: "8fd67b4" }),
].join("\n") + "\n";

/** One git invocation against the fixture — output captured, never inherited. */
function runGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A local bare remote (the repo's first `git init --bare` fixture), HEAD pinned to `branch`. */
function makeBareRemote(t: TestContext, branch = "main"): string {
  const dir = makeTempDir("paseo-factory-vault-remote-");
  disposeDir(t, dir);
  const bare = join(dir, "remote.git");
  runGit(["init", "--bare", bare]);
  runGit(["--git-dir", bare, "symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  return bare;
}

/** Seeds the bare remote's branch from a throwaway clone with its own hermetic identity. */
function seedBareRemote(t: TestContext, bare: string, files: Record<string, string | Buffer>, branch = "main"): void {
  const seed = makeTempDir("paseo-factory-vault-seed-");
  disposeDir(t, seed);
  runGit(["clone", bare, seed]);
  runGit(["config", "user.email", "vault@test.local"], seed);
  runGit(["config", "user.name", "Vault Test"], seed);
  for (const [rel, data] of Object.entries(files)) {
    const target = join(seed, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  runGit(["add", "-A"], seed);
  runGit(["commit", "-q", "-m", "seed vault"], seed);
  runGit(["push", "-q", "origin", branch], seed);
}

/** The bare remote's branch tip — the sha a push (or its absence) moves. */
function bareHead(bare: string, branch = "main"): string {
  return runGit(["--git-dir", bare, "rev-parse", `refs/heads/${branch}`]);
}

/** One ustar header with a real checksum — enough archive for the vault's in-memory parser. */
function tarHeader(name: string, size: number, typeflag: "0" | "5"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "latin1");
  header.write(typeflag, 156, 1, "latin1");
  header.write("ustar", 257, 5, "latin1");
  header.write("00", 263, 2, "latin1");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

function tarFileEntry(name: string, data: Buffer): Buffer {
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, data.length, "0"), data, padding]);
}

function tarDirEntry(name: string): Buffer {
  return tarHeader(`${name}/`, 0, "5");
}

/** A GitHub-shaped tarball: one top-level `<owner>-<repo>-<sha>/` prefix, gzipped in memory. */
function buildTarball(entries: Array<{ path: string; data: Buffer | string }>, topDir = "daymanondev-factory-vault-abc1234"): Buffer {
  const parts: Buffer[] = [tarDirEntry(topDir)];
  for (const entry of entries) {
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const dir = dirname(entry.path);
    if (dir !== "." && dir !== topDir) parts.push(tarDirEntry(dir));
    parts.push(tarFileEntry(entry.path, data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** An in-memory `VaultRunner` answering every `gh` call with the fixture tarball — zero network, calls recorded. */
function fakeTarballRunner(tarball: Buffer): { runner: VaultRunner; calls: VaultRunnerCall[] } {
  const calls: VaultRunnerCall[] = [];
  return {
    calls,
    runner: async (call) => {
      calls.push(call);
      if (call.command === "gh") return tarball;
      throw new Error(`unexpected vault runner call: ${call.command} ${call.args.join(" ")}`);
    },
  };
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

test("the default VaultRunner stamps GIT_TERMINAL_PROMPT=0 into every child env and wraps failures", async () => {
  const runner = createDefaultVaultRunner();
  const stdout = await runner({
    command: process.execPath,
    args: ["-e", 'process.stdout.write(process.env.GIT_TERMINAL_PROMPT ?? "unset")'],
  });
  assert.equal(stdout.toString("utf8"), "0", "children never prompt for git credentials — they fail instead");

  await assert.rejects(
    () => runner({ command: process.execPath, args: ["-e", 'process.stderr.write("boom"); process.exit(3)'] }),
    factoryErrorCode("vault-runner-failed"),
    "a failing child refuses with the stable runner error code",
  );
});

test("hydrateVaultDirect provisions a fresh home from the tarball stream — no vault/.git, 0o600 secrets, unsealed bytes", async (t) => {
  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: "daymanondev/factory-vault", passphrase: "correct-horse-battery" });

  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  const eyePlain = '{\n  "provider": "eye"\n}\n';
  const keystore = randomBytes(2048);
  const tarball = buildTarball([
    { path: "daymanondev-factory-vault-abc1234/secrets/shared/asc-api-key.p8", data: p8 },
    { path: "daymanondev-factory-vault-abc1234/secrets/shared/gplay-service-account.json", data: JSON.stringify(sealVaultBuffer(Buffer.from(GCP_SERVICE_ACCOUNT, "utf8"))) },
    { path: "daymanondev-factory-vault-abc1234/secrets/shared/eye.json", data: JSON.stringify(sealVaultBuffer(Buffer.from(eyePlain, "utf8"), "correct-horse-battery")) },
    { path: "daymanondev-factory-vault-abc1234/secrets/apps/patigame/release.keystore", data: keystore },
    { path: "daymanondev-factory-vault-abc1234/config/lanes.json", data: JSON.stringify({ lanes: { default: "pi" } }) },
    { path: "daymanondev-factory-vault-abc1234/state/nodes/mac-studio/global-ledger.jsonl", data: LEDGER_LINES },
  ]);
  const { runner, calls } = fakeTarballRunner(tarball);

  const result = await withVaultEnv(undefined, () => hydrateVaultDirect(home, { token: "ghp_fixture_token", runner }));

  assert.deepEqual(result.hydratedFiles, [
    "config/lanes.json",
    "secrets/apps/patigame/release.keystore",
    "secrets/shared/asc-api-key.p8",
    "secrets/shared/eye.json",
    "secrets/shared/gplay-service-account.json",
    "state/nodes/mac-studio/global-ledger.jsonl",
  ]);
  assert.equal(calls.length, 1, "exactly one gh api call");
  assert.equal(calls[0]!.command, "gh");
  assert.deepEqual(calls[0]!.args, ["api", "repos/daymanondev/factory-vault/tarball/main"], "streams GET /repos/{owner}/{repo}/tarball/{ref} through gh");
  assert.deepEqual(calls[0]!.env, { GH_TOKEN: "ghp_fixture_token" }, "an explicit token rides the child env");

  const runtime = join(home, "vault-runtime");
  assert.equal(readFileSync(join(runtime, "secrets/shared/asc-api-key.p8"), "utf8"), p8, "plaintext lands verbatim");
  assert.equal(readFileSync(join(runtime, "secrets/shared/gplay-service-account.json"), "utf8"), GCP_SERVICE_ACCOUNT, "the obfuscated envelope unseals zero-passphrase");
  assert.equal(readFileSync(join(runtime, "secrets/shared/eye.json"), "utf8"), eyePlain, "the locked envelope unseals with the persisted passphrase");
  assert.deepEqual(readFileSync(join(runtime, "secrets/apps/patigame/release.keystore")), keystore, "binary keystore bytes round-trip");
  assert.equal(readFileSync(join(runtime, "config/lanes.json"), "utf8"), JSON.stringify({ lanes: { default: "pi" } }));
  assert.equal(readFileSync(join(runtime, "state/nodes/mac-studio/global-ledger.jsonl"), "utf8"), LEDGER_LINES);

  assert.equal(modeOf(join(runtime, "secrets")), 0o700, "secret directories are 0o700");
  assert.equal(modeOf(join(runtime, "secrets/shared")), 0o700);
  assert.equal(modeOf(join(runtime, "secrets/shared/asc-api-key.p8")), 0o600, "secret files are 0o600");
  assert.equal(modeOf(join(runtime, "secrets/shared/eye.json")), 0o600);
  assert.equal(modeOf(join(runtime, "secrets/apps/patigame/release.keystore")), 0o600);
  assert.equal(modeOf(join(runtime, "config/lanes.json")), 0o644, "non-secret tiers keep normal permissions");
  assert.equal(modeOf(join(runtime, "state/nodes/mac-studio/global-ledger.jsonl")), 0o644);

  assert.ok(!existsSync(join(home, "vault")), "zero-clone: the vault checkout (and its .git) is never created");

  const config = loadVaultConfig(home);
  assert.equal(config?.lastHydrateMode, "direct");
  assert.ok(!Number.isNaN(Date.parse(config?.lastHydratedAt ?? "")), "lastHydratedAt is a real ISO stamp");
  assert.equal(config?.repo, "daymanondev/factory-vault");
  assert.equal(config?.passphrase, "correct-horse-battery", "the stamp preserves the rest of the config");
  const status = readVaultStatus(home);
  assert.equal(status.lastHydrateMode, "direct");
  assert.equal(status.cloneExists, false);
  assert.deepEqual(status.sharedSecrets, { ascKey: true, ascCredentials: false, gplayServiceAccount: true, eyeConfig: true });
});

test("hydrateVaultDirect pins the gh api call to the requested ref and refuses unconfigured repos and unsafe archive paths", async (t) => {
  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: "daymanondev/factory-vault", branch: "release" });
  const emptyTarball = gzipSync(Buffer.alloc(1024));

  const explicit = fakeTarballRunner(emptyTarball);
  await hydrateVaultDirect(home, { ref: "v1.2.3", token: "ghp_x", runner: explicit.runner });
  assert.deepEqual(explicit.calls[0]!.args, ["api", "repos/daymanondev/factory-vault/tarball/v1.2.3"], "an explicit ref wins");

  const branchDefault = fakeTarballRunner(emptyTarball);
  await hydrateVaultDirect(home, { runner: branchDefault.runner });
  assert.deepEqual(branchDefault.calls[0]!.args, ["api", "repos/daymanondev/factory-vault/tarball/release"], "no ref falls back to the configured branch");
  assert.equal(branchDefault.calls[0]!.env, undefined, "no token means no token env");

  const unconfigured = makeTempDir();
  disposeDir(t, unconfigured);
  await assert.rejects(
    () => hydrateVaultDirect(unconfigured, { runner: fakeTarballRunner(emptyTarball).runner }),
    factoryErrorCode("vault-not-configured"),
  );

  const evil = buildTarball([{ path: "top/../../.ssh/authorized_keys", data: Buffer.from("nope\n") }]);
  await assert.rejects(
    () => hydrateVaultDirect(home, { runner: fakeTarballRunner(evil).runner }),
    factoryErrorCode("vault-invalid-path"),
    "an archive entry trying to escape the vault layout is refused, never written",
  );
});

test("pushVault commits the full secret/config/state set and pushes it to the configured bare remote", async (t) => {
  const bare = makeBareRemote(t);
  seedBareRemote(t, bare, { "README.md": "private vault\n" });
  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: bare, nodeId: "mac-studio" });

  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  const keystore = randomBytes(1024);
  const gplayEnvelope = JSON.stringify(sealVaultBuffer(Buffer.from(GCP_SERVICE_ACCOUNT, "utf8")));
  const files: Array<[string, string | Buffer]> = [
    ["secrets/shared/asc-api-key.p8", p8],
    ["secrets/shared/gplay-service-account.json", gplayEnvelope],
    ["secrets/shared/eye.json", '{\n  "provider": "eye"\n}\n'],
    ["secrets/apps/patigame/release.keystore", keystore],
    ["secrets/apps/patigame/google-services.json", JSON.stringify({ project_id: "patigame" })],
    ["secrets/apps/patigame/GoogleService-Info.plist", '<?xml version="1.0"?>\n<plist/>\n'],
    ["config/lanes.json", JSON.stringify({ lanes: { default: "pi" } })],
    ["config/fleet.json", JSON.stringify({ peers: [] })],
    ["config/apps/patigame/store-manifest.json", JSON.stringify({ bundleId: "com.patigame.app" })],
  ];
  const runtime = join(home, "vault-runtime");
  for (const [rel, data] of files) {
    const target = join(runtime, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  const stateDir = join(home, "plugin-state", "paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.jsonl"), LEDGER_LINES);

  const result = await pushVault(home, { includeLedger: true });

  assert.equal(result.pushed, true, "a commit landed and was pushed");
  assert.deepEqual(
    result.pushedFiles,
    [...files.map(([rel]) => rel), "state/nodes/mac-studio/global-ledger.jsonl"].sort(),
    "the full shared-secret, per-app signing, config, and node-scoped state set is reported",
  );

  const probe = makeTempDir();
  disposeDir(t, probe);
  runGit(["clone", bare, probe]);
  assert.equal(readFileSync(join(probe, "secrets/shared/asc-api-key.p8"), "utf8"), p8);
  assert.equal(readFileSync(join(probe, "secrets/shared/gplay-service-account.json"), "utf8"), gplayEnvelope, "envelopes ride the vault byte-exact — sealing policy stays with the writer");
  assert.deepEqual(readFileSync(join(probe, "secrets/apps/patigame/release.keystore")), keystore);
  assert.equal(readFileSync(join(probe, "secrets/apps/patigame/google-services.json"), "utf8"), JSON.stringify({ project_id: "patigame" }));
  assert.equal(readFileSync(join(probe, "secrets/apps/patigame/GoogleService-Info.plist"), "utf8"), '<?xml version="1.0"?>\n<plist/>\n');
  assert.equal(readFileSync(join(probe, "config/lanes.json"), "utf8"), JSON.stringify({ lanes: { default: "pi" } }));
  assert.equal(readFileSync(join(probe, "config/fleet.json"), "utf8"), JSON.stringify({ peers: [] }));
  assert.equal(readFileSync(join(probe, "config/apps/patigame/store-manifest.json"), "utf8"), JSON.stringify({ bundleId: "com.patigame.app" }));
  assert.equal(readFileSync(join(probe, "state/nodes/mac-studio/global-ledger.jsonl"), "utf8"), LEDGER_LINES, "includeLedger snapshots the global ledger under this node's namespace");

  assert.ok(existsSync(join(home, "vault", ".git")), "push clones the vault checkout first when absent");
  const config = loadVaultConfig(home);
  assert.ok(!Number.isNaN(Date.parse(config?.lastPushedAt ?? "")), "lastPushedAt is stamped");
});

test("pushVault with nothing new pushes no commit and leaves the remote tip where it was", async (t) => {
  const bare = makeBareRemote(t);
  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  seedBareRemote(t, bare, {
    "secrets/shared/asc-api-key.p8": p8,
    "config/lanes.json": JSON.stringify({ lanes: { default: "pi" } }),
    "README.md": "vault\n",
  });
  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: bare, nodeId: "mac-studio" });
  await pullVault(home); // runtime now mirrors the remote (plaintext fixtures — nothing to unseal)
  const headBefore = bareHead(bare);

  const result = await pushVault(home);

  assert.equal(result.pushed, false, "a clean tree produces no commit and no push");
  assert.deepEqual(result.pushedFiles, ["README.md", "config/lanes.json", "secrets/shared/asc-api-key.p8"], "the staged set is still reported");
  assert.equal(bareHead(bare), headBefore, "the remote tip did not move");
  assert.ok(!Number.isNaN(Date.parse(loadVaultConfig(home)?.lastPushedAt ?? "")), "lastPushedAt is stamped regardless");
});

test("pullVault clones the configured remote into <paseoHome>/vault and hydrates vault-runtime (sync mode)", async (t) => {
  const bare = makeBareRemote(t);
  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  const keystore = randomBytes(512);
  seedBareRemote(t, bare, {
    "secrets/shared/asc-api-key.p8": p8,
    "secrets/shared/gplay-service-account.json": JSON.stringify(sealVaultBuffer(Buffer.from(GCP_SERVICE_ACCOUNT, "utf8"))),
    "secrets/apps/patigame/release.keystore": keystore,
    "config/lanes.json": JSON.stringify({ lanes: { default: "pi" } }),
    "README.md": "vault\n",
  });
  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: bare, nodeId: "mac-studio" });

  const result = await pullVault(home);

  assert.ok(existsSync(join(home, "vault", ".git")), "the clone landed at <paseoHome>/vault");
  assert.deepEqual(result.hydratedFiles, [
    "README.md",
    "config/lanes.json",
    "secrets/apps/patigame/release.keystore",
    "secrets/shared/asc-api-key.p8",
    "secrets/shared/gplay-service-account.json",
  ]);
  const runtime = join(home, "vault-runtime");
  assert.equal(readFileSync(join(runtime, "secrets/shared/asc-api-key.p8"), "utf8"), p8);
  assert.equal(readFileSync(join(runtime, "secrets/shared/gplay-service-account.json"), "utf8"), GCP_SERVICE_ACCOUNT, "hydration unseals envelopes from the checkout");
  assert.deepEqual(readFileSync(join(runtime, "secrets/apps/patigame/release.keystore")), keystore);
  assert.equal(modeOf(join(runtime, "secrets/shared/asc-api-key.p8")), 0o600, "secrets hydrate 0o600 in sync mode too");
  assert.equal(modeOf(join(runtime, "config/lanes.json")), 0o644);

  const config = loadVaultConfig(home);
  assert.equal(config?.lastHydrateMode, "sync");
  assert.ok(!Number.isNaN(Date.parse(config?.lastHydratedAt ?? "")));
  assert.ok(readVaultStatus(home).cloneExists, "the status read sees the clone");
});

test("pullVault pulls (--rebase --autostash) after a second node pushes — the two-way cycle", async (t) => {
  const bare = makeBareRemote(t);
  seedBareRemote(t, bare, { "README.md": "vault\n" });

  const home1 = makeTempDir();
  disposeDir(t, home1);
  saveVaultConfig(home1, { repo: bare, nodeId: "mac-studio" });
  const first = await pullVault(home1);
  assert.deepEqual(first.hydratedFiles, ["README.md"]);
  const headAfterClone = bareHead(bare);
  const pullMarker = join(home1, "vault", ".git", "t02-pull-marker");
  writeFileSync(pullMarker, "vanishes if the vault is ever re-cloned\n");

  // a second node stages Day-0 signing artifacts and pushes
  const home2 = makeTempDir();
  disposeDir(t, home2);
  saveVaultConfig(home2, { repo: bare, nodeId: "mini-m2" });
  const runtime2 = join(home2, "vault-runtime");
  const keystore = randomBytes(768);
  mkdirSync(join(runtime2, "secrets/apps/patigame"), { recursive: true });
  writeFileSync(join(runtime2, "secrets/apps/patigame/release.keystore"), keystore);
  mkdirSync(join(runtime2, "config"), { recursive: true });
  writeFileSync(join(runtime2, "config/lanes.json"), JSON.stringify({ lanes: { default: "pi" } }));
  const push2 = await pushVault(home2);
  assert.equal(push2.pushed, true);
  assert.notEqual(bareHead(bare), headAfterClone, "the second node's push moved the remote tip");

  // node one pulls the second node's push and hydrates it
  const second = await pullVault(home1);
  assert.deepEqual(second.hydratedFiles, ["README.md", "config/lanes.json", "secrets/apps/patigame/release.keystore"]);
  assert.deepEqual(readFileSync(join(home1, "vault-runtime/secrets/apps/patigame/release.keystore")), keystore, "the second node's keystore arrives");
  assert.equal(readFileSync(join(home1, "vault-runtime/config/lanes.json"), "utf8"), JSON.stringify({ lanes: { default: "pi" } }));
  assert.ok(existsSync(pullMarker), "the existing checkout was pulled in place, not re-cloned");
  assert.equal(runGit(["rev-parse", "HEAD"], join(home1, "vault")), runGit(["rev-parse", "HEAD"], join(home2, "vault")), "both nodes converge on the same tip");
});

/**
 * ===== The stage C group (ticket 03): canonical-key routing, the multi-node
 * `Ledger` reconciler, worktree hygiene, and `vault-runtime/env.json` =====
 *
 * Canonical keys route through real local git checkouts (different filesystem
 * paths mint different `<project-slug>` hashes — the ADR 0014 Context
 * invariant), ledgers reconcile from real divergent JSONL snapshots, and the
 * hygiene asserts ride the real `git status` / `checkCleanAt` reads. Still
 * every assertion through the top-level barrel, still no network.
 */

/** A fresh parent temp dir — the only way to control a checkout's basename. */
function makeProjectParent(t: TestContext): string {
  const parent = makeTempDir("paseo-factory-vault-apps-");
  disposeDir(t, parent);
  return parent;
}

test("parseVaultManifest reads the canonical mapping and refuses damage, never guesses", () => {
  const manifest = parseVaultManifest(
    JSON.stringify({
      patigame: { repoBasename: "patigame", gitRemote: "git@github.com:daymanondev/patigame.git", bundleId: "com.patigame.app", packageName: "com.patigame" },
    }),
  );
  assert.deepEqual(manifest, {
    patigame: { repoBasename: "patigame", gitRemote: "git@github.com:daymanondev/patigame.git", bundleId: "com.patigame.app", packageName: "com.patigame" },
  } satisfies VaultManifest);

  assert.deepEqual(parseVaultManifest("{}"), {}, "an empty mapping is a legal vault with no routing");
  assert.throws(() => parseVaultManifest("{not json"), factoryErrorCode("corrupted-vault-manifest"));
  assert.throws(() => parseVaultManifest("[]"), factoryErrorCode("corrupted-vault-manifest"), "the manifest is a map, never a list");
  assert.throws(() => parseVaultManifest('{"patigame": "patigame"}'), factoryErrorCode("corrupted-vault-manifest"), "an entry must be an object");
  assert.throws(() => parseVaultManifest('{"patigame": {"repoBasename": 3}}'), factoryErrorCode("corrupted-vault-manifest"), "entry fields are strings");
});

test("resolveVaultApps routes canonical keys to local roots and host-local slugs across all three sources", (t) => {
  const parent = makeProjectParent(t);
  const home = makeTempDir();
  disposeDir(t, home);
  const stateDir = join(home, "plugin-state", "paseo-factory");

  // the basename leg — a factory-registered checkout
  const patigame = join(parent, "patigame");
  mkdirSync(patigame, { recursive: true });
  writeFileSync(join(patigame, "README.md"), "patigame fixture\n");
  gitCommitAll(patigame);
  const patigameResolved = resolveProject(patigame);
  assert.ok(patigameResolved.ok, "fixture checkout resolves");
  writeProjectRegistration(stateDir, patigameResolved.slug, { root: patigame });

  // the git-remote leg — a release-lab-registered checkout with a GitHub origin
  const foxrun = join(parent, "foxrun");
  mkdirSync(foxrun, { recursive: true });
  writeFileSync(join(foxrun, "README.md"), "foxrun fixture\n");
  gitCommitAll(foxrun);
  runGit(["remote", "add", "origin", "git@github.com:daymanondev/foxrun.git"], foxrun);
  mkdirSync(join(home, "release-lab"), { recursive: true });
  const foxrunResolved = resolveProject(foxrun);
  assert.ok(foxrunResolved.ok);
  writeFileSync(
    join(home, "release-lab", "projects.json"),
    JSON.stringify({ projects: [{ slug: foxrunResolved.slug, name: "foxrun", root: foxrun }] }),
  );

  // the .store-release manifest leg (bundleId + packageName) — discovered through Paseo's projects.json
  const wingame = join(parent, "wingame");
  mkdirSync(wingame, { recursive: true });
  writeFileSync(join(wingame, "README.md"), "wingame fixture\n");
  gitCommitAll(wingame);
  mkdirSync(join(wingame, ".store-release"), { recursive: true });
  writeFileSync(join(wingame, ".store-release", "manifest.json"), JSON.stringify({ bundleId: "com.wingame.app", packageName: "com.wingame" }));
  mkdirSync(join(home, "projects"), { recursive: true });
  writeFileSync(join(home, "projects", "projects.json"), JSON.stringify([{ rootPath: wingame, archivedAt: null }]));
  const wingameResolved = resolveProject(wingame);
  assert.ok(wingameResolved.ok);

  const apps = resolveVaultApps(home, {
    patigame: { repoBasename: "patigame" },
    foxrun: { gitRemote: "https://github.com/daymanondev/foxrun.git" }, // https vs the checkout's scp-style origin
    wingame: { bundleId: "com.wingame.app" },
    "wingame-pkg": { packageName: "com.wingame" },
    nomatch: { repoBasename: "no-such-checkout" },
  });

  assert.deepEqual(apps, [
    { canonicalAppKey: "foxrun", projectRoot: foxrunResolved.root, projectSlug: foxrunResolved.slug },
    { canonicalAppKey: "nomatch", projectRoot: null, projectSlug: null },
    { canonicalAppKey: "patigame", projectRoot: patigameResolved.root, projectSlug: patigameResolved.slug },
    { canonicalAppKey: "wingame", projectRoot: wingameResolved.root, projectSlug: wingameResolved.slug },
    { canonicalAppKey: "wingame-pkg", projectRoot: wingameResolved.root, projectSlug: wingameResolved.slug },
  ]);
});

test("two checkouts of one repo at different paths mint different slugs — the invariant canonical routing exists for", (t) => {
  const parent = makeProjectParent(t);
  const machineA = join(parent, "machine-a", "patigame");
  mkdirSync(machineA, { recursive: true });
  writeFileSync(join(machineA, "README.md"), "patigame fixture\n");
  gitCommitAll(machineA);
  const machineB = join(parent, "machine-b", "patigame");
  mkdirSync(dirname(machineB), { recursive: true });
  runGit(["clone", "-q", machineA, machineB]);

  const a = resolveProject(machineA);
  const b = resolveProject(machineB);
  assert.ok(a.ok && b.ok);
  assert.match(a.slug, /^patigame-[0-9a-f]{6}$/, "the slug is <basename>-<sha1(realpath(gitCommonDir)).slice(0,6)>");
  assert.match(b.slug, /^patigame-[0-9a-f]{6}$/, "the clone keeps the basename half");
  assert.notEqual(a.slug, b.slug, "different filesystem paths hash to different <project-slug>s");
});

test("ensureLocalGitExcludeAndWorktreeInclude registers paths idempotently and refuses non-git roots", (t) => {
  const parent = makeProjectParent(t);
  const repo = join(parent, "hygiene");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "hygiene fixture\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.ok(resolved.ok);

  ensureLocalGitExcludeAndWorktreeInclude(repo, ["android/app/release.keystore", "ios/GoogleService-Info.plist"]);
  ensureLocalGitExcludeAndWorktreeInclude(repo, ["android/app/release.keystore", "android/keystore.properties"]); // partial overlap re-run

  const rels = ["android/app/release.keystore", "android/keystore.properties", "ios/GoogleService-Info.plist"];
  const excludeLines = readFileSync(join(resolved.gitCommonDir, "info", "exclude"), "utf8").split("\n");
  const includeLines = readFileSync(join(repo, ".worktreeinclude"), "utf8").split("\n");
  for (const rel of rels) {
    assert.ok(excludeLines.includes(rel), `${rel} rides <gitCommonDir>/info/exclude`);
    assert.ok(includeLines.includes(rel), `${rel} rides <projectRoot>/.worktreeinclude`);
  }
  assert.equal(excludeLines.filter((line) => line === "android/app/release.keystore").length, 1, "idempotent — one exclude line per path");
  assert.equal(includeLines.filter((line) => line === "android/app/release.keystore").length, 1, "idempotent — one include line per path");

  const plain = makeTempDir();
  disposeDir(t, plain);
  assert.throws(
    () => ensureLocalGitExcludeAndWorktreeInclude(plain, ["android/app/release.keystore"]),
    factoryErrorCode("vault-project-not-git"),
    "hygiene on a directory git cannot answer for is refused, never guessed at",
  );
});

test("hydrateVaultDirect routes per-app secrets into a resolved checkout — hygiene keeps the tree clean, env.json lands 0o600", async (t) => {
  const parent = makeProjectParent(t);
  const machineA = join(parent, "machine-a", "patigame");
  mkdirSync(machineA, { recursive: true });
  writeFileSync(join(machineA, "README.md"), "patigame fixture\n");
  gitCommitAll(machineA);
  const machineB = join(parent, "machine-b", "patigame");
  mkdirSync(dirname(machineB), { recursive: true });
  runGit(["clone", "-q", machineA, machineB]);
  const resolvedA = resolveProject(machineA);
  const resolvedB = resolveProject(machineB);
  assert.ok(resolvedA.ok && resolvedB.ok);
  assert.notEqual(resolvedA.slug, resolvedB.slug);

  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  const keystore = randomBytes(1024);
  const googleServices = JSON.stringify({ project_info: { project_id: "patigame-prod" } });
  const signing = JSON.stringify({ storePassword: "correct-horse-battery", keyAlias: "upload", keyPassword: "correct-horse-battery" });
  const plist = '<?xml version="1.0"?>\n<plist/>\n';
  const top = "daymanondev-factory-vault-abc1234";
  const tarball = buildTarball([
    { path: `${top}/vault.manifest.json`, data: JSON.stringify({ patigame: { repoBasename: "patigame" } }) },
    { path: `${top}/secrets/shared/asc-api-key.p8`, data: p8 },
    { path: `${top}/secrets/shared/asc-credentials.json`, data: JSON.stringify({ keyId: "K2XYZ123456", issuerId: "issuer-uuid-1" }) },
    { path: `${top}/secrets/shared/gplay-service-account.json`, data: JSON.stringify(sealVaultBuffer(Buffer.from(GCP_SERVICE_ACCOUNT, "utf8"))) },
    { path: `${top}/secrets/apps/patigame/release.keystore`, data: keystore },
    { path: `${top}/secrets/apps/patigame/signing.json`, data: signing },
    { path: `${top}/secrets/apps/patigame/google-services.json`, data: googleServices },
    { path: `${top}/secrets/apps/patigame/GoogleService-Info.plist`, data: plist },
  ]);

  // machine two's home — the clone is registered through Release Lab's own registry
  const homeB = makeTempDir();
  disposeDir(t, homeB);
  mkdirSync(join(homeB, "release-lab"), { recursive: true });
  writeFileSync(
    join(homeB, "release-lab", "projects.json"),
    JSON.stringify({ projects: [{ slug: resolvedB.slug, name: "patigame", root: machineB }] }),
  );
  saveVaultConfig(homeB, { repo: "daymanondev/factory-vault" });

  await hydrateVaultDirect(homeB, { runner: fakeTarballRunner(tarball).runner });

  // the per-app files materialize into machine two's checkout, keyed by the canonical key — not machine one's path
  assert.deepEqual(readFileSync(join(resolvedB.root, "android/app/release.keystore")), keystore);
  assert.equal(
    readFileSync(join(resolvedB.root, "android/keystore.properties"), "utf8"),
    "keyAlias=upload\nkeyPassword=correct-horse-battery\nstorePassword=correct-horse-battery\n",
    "signing.json renders to android/keystore.properties, keys sorted",
  );
  assert.equal(readFileSync(join(resolvedB.root, "android/app/google-services.json"), "utf8"), googleServices);
  assert.equal(readFileSync(join(resolvedB.root, "ios/GoogleService-Info.plist"), "utf8"), plist);
  assert.ok(!existsSync(join(resolvedA.root, "android")), "machine one's checkout is untouched");

  // hygiene: the four materialized paths ride info/exclude + .worktreeinclude, and the tree stays clean
  const rels = ["android/app/release.keystore", "android/keystore.properties", "android/app/google-services.json", "ios/GoogleService-Info.plist"];
  const excludeLines = readFileSync(join(resolvedB.gitCommonDir, "info", "exclude"), "utf8").split("\n");
  const includeLines = readFileSync(join(resolvedB.root, ".worktreeinclude"), "utf8").split("\n");
  for (const rel of rels) {
    assert.ok(excludeLines.includes(rel));
    assert.ok(includeLines.includes(rel));
  }
  assert.equal(runGit(["status", "--porcelain"], resolvedB.root), "", "git status --porcelain stays empty over the hydrated checkout");
  const headB = runGit(["rev-parse", "HEAD"], resolvedB.root);
  assert.deepEqual(await checkCleanAt(resolvedB.root, headB), { ok: true }, "checkCleanAt stays green — Claims are not refused");

  // the materialized secrets still ride Task worktrees (the .worktreeinclude consumer)
  const stateDirB = join(homeB, "plugin-state", "paseo-factory");
  const worktree = prepareTaskWorktree({ stateDir: stateDirB, workspace: resolvedB.root, task: "vault-ride" });
  assert.ok(worktree.ok, `worktree allocation succeeded: ${worktree.ok ? "" : worktree.reason}`);
  assert.deepEqual(readFileSync(join(worktree.path, "android/app/release.keystore")), keystore, "the keystore rides the Task worktree");

  // the runtime pointer index — six keys at the materialized paths, 0o600
  const envPath = join(homeB, "vault-runtime", "env.json");
  assert.deepEqual(JSON.parse(readFileSync(envPath, "utf8")), {
    ASC_KEY_PATH: join(homeB, "vault-runtime", "secrets", "shared", "asc-api-key.p8"),
    ASC_KEY_ID: "K2XYZ123456",
    ASC_ISSUER: "issuer-uuid-1",
    GPLAY_KEY_PATH: join(homeB, "vault-runtime", "secrets", "shared", "gplay-service-account.json"),
    RELEASE_LAB_KEYSTORE_STOREPASS: "correct-horse-battery",
    FIREBASE_PROJECT_ID: "patigame-prod",
  });
  assert.equal(modeOf(envPath), 0o600, "env.json is 0o600");

  // idempotent re-hydration: no duplicate hygiene lines, files rewritten byte-exact
  await hydrateVaultDirect(homeB, { runner: fakeTarballRunner(tarball).runner });
  assert.equal(
    readFileSync(join(resolvedB.gitCommonDir, "info", "exclude"), "utf8").split("\n").filter((line) => line === "android/app/release.keystore").length,
    1,
    "a second hydration adds no second exclude line",
  );

  assert.deepEqual(readVaultStatus(homeB).hydratedApps, ["patigame"], "readVaultStatus fills hydratedApps from the canonical keys");
});

/** One valid `LedgerEvent` JSONL line with a controlled clock — reconciler fixtures need ordered, real-vocabulary events. */
function ledgerLine(seq: number, ts: string, event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ seq, ts, event, ...extra });
}

/** Writes JSONL text to a real file — the `Ledger.open` proof needs a path. */
function writeJsonl(t: TestContext, content: string, name = "ledger.jsonl"): string {
  const dir = makeTempDir("paseo-factory-vault-ledger-");
  disposeDir(t, dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test("reconcileVaultLedgers dedupes by the real-vocabulary fingerprint, sorts by (ts, node, seq), and re-indexes 1..N", (t) => {
  // the shared history every node carries (mini-m2's copy sits at different seqs — fingerprints ignore seq)
  const retro = ledgerLine(1, "2026-10-20T08:00:00.000Z", "retro_written", { model: "copilot/gpt-5.4", outcome: "written", durationMs: 1200 });
  const contract = ledgerLine(2, "2026-10-20T09:00:00.000Z", "contract_set", { task: "t01", workspace: "/w", gate: "npm test", artifact: "report.md", base: "e5b52cc" });
  const claim = ledgerLine(3, "2026-10-20T09:05:00.000Z", "claim_reported", { task: "t01", attempt: 1, sha: "8fd67b4", agent: "pi" });

  const local = [
    retro,
    contract,
    claim,
    ledgerLine(4, "2026-10-20T09:20:00.000Z", "gate_finished", { task: "t01", attempt: 1, exit: 0, verdict: "green", note: "all gates green", sha: "8fd67b4" }),
    ledgerLine(5, "2026-10-20T09:25:00.000Z", "report_written", { task: "t01", attempt: 1, path: "reports/t01.md" }),
  ].join("\n") + "\n";

  const mini = [
    ledgerLine(5, "2026-10-20T09:00:00.000Z", "contract_set", { task: "t01", workspace: "/w", gate: "npm test", artifact: "report.md", base: "e5b52cc" }),
    ledgerLine(6, "2026-10-20T09:05:00.000Z", "claim_reported", { task: "t01", attempt: 1, sha: "8fd67b4", agent: "pi" }),
    ledgerLine(7, "2026-10-20T10:40:00.000Z", "gate_finished", { task: "t01", attempt: 2, exit: 1, verdict: "red", note: "flaky wall clock", sha: "b6f93a1" }),
    ledgerLine(8, "2026-10-20T10:45:00.000Z", "attempt_accepted", { task: "t01", attempt: 2, accepted_by: "owner" }),
  ].join("\n") + "\n";

  // this machine's own earlier push still sitting in the vault — a full duplicate of local
  const selfPush = local;

  const reconciled = reconcileVaultLedgers(local, [
    { nodeId: "mini-m2", lines: mini },
    { nodeId: "mac-studio", lines: selfPush },
  ]);

  const events = reconciled.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.length, 7, "the shared base dedupes to one copy each; only genuinely divergent events survive");
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i]!.seq, i + 1, `event ${i} re-indexed to ${i + 1}`);
  }
  assert.deepEqual(
    events.map((evt) => evt.event),
    ["retro_written", "contract_set", "claim_reported", "gate_finished", "report_written", "gate_finished", "attempt_accepted"],
    "chronological by ts, both nodes' divergent gate_finished lines preserved",
  );
  assert.deepEqual(
    events.map((evt) => evt.ts),
    [...events.map((evt) => evt.ts)].sort(),
    "ts ordering is monotonic across the reconciled file",
  );
  assert.equal(events.filter((evt) => evt.event === "contract_set").length, 1, "three copies of the contract (local, mini at other seqs, self-push) collapse to one");
  assert.equal((events[3] as { verdict?: string }).verdict, "green", "payload fields ride the reconcile verbatim");
  assert.equal((events[5] as { verdict?: string }).verdict, "red");

  // the reconciled file loads through the ledger's own reader — the monotonic gate never fires
  const path = writeJsonl(t, reconciled);
  const opened = Ledger.open(path);
  assert.equal(opened.events.length, 7);
  for (let i = 0; i < opened.events.length; i++) assert.equal(opened.events[i]!.seq, i + 1);

  // the union-merge control: `.gitattributes merge=union` of the same two files refuses to open
  const unionPath = writeJsonl(t, `${local}${mini}`);
  assert.throws(() => Ledger.open(unionPath), factoryErrorCode("corrupted-ledger"), "a union merge hits the non-monotonic seq and throws — the reconciler exists for exactly this");
});

test("reconcileVaultLedgers skips damaged and foreign lines instead of failing the merge", () => {
  const good = ledgerLine(1, "2026-10-20T09:00:00.000Z", "contract_set", { task: "t01", workspace: "/w", gate: "npm test", artifact: "report.md" });
  const damaged = [
    good,
    "this line is not json",
    ledgerLine(2, "2026-10-20T09:01:00.000Z", "not_a_real_event", { task: "t01" }),
    ledgerLine(3, "2026-10-20T09:02:00.000Z", "claim_reported", { task: "t02", attempt: 0, sha: "x" }), // attempt must be >= 1
    "",
    ledgerLine(4, "2026-10-20T09:03:00.000Z", "claim_reported", { task: "t03", attempt: 1, sha: "y" }),
  ].join("\n") + "\n";

  const reconciled = reconcileVaultLedgers("", [{ nodeId: "mini-m2", lines: damaged }]);
  const events = reconciled.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.length, 2, "only the records the ledger's own validity law accepts survive");
  assert.equal(events[0]!.event, "contract_set");
  assert.equal(events[1]!.event, "claim_reported");
  assert.equal(events[1]!.seq, 2, "survivors re-index 1..N over the gaps");
});

test("pullVault with mergeLedgers reconciles two nodes' snapshots into the local ledgers — then pushes them back node-scoped", async (t) => {
  const parent = makeProjectParent(t);
  const patigame = join(parent, "patigame");
  mkdirSync(patigame, { recursive: true });
  writeFileSync(join(patigame, "README.md"), "patigame fixture\n");
  gitCommitAll(patigame);
  const resolved = resolveProject(patigame);
  assert.ok(resolved.ok);

  // the shared history both nodes once agreed on, then each node's own appends
  const contract = ledgerLine(1, "2026-10-20T09:00:00.000Z", "contract_set", { task: "t01", workspace: "/w", gate: "npm test", artifact: "report.md", base: "e5b52cc" });
  const claim = ledgerLine(2, "2026-10-20T09:05:00.000Z", "claim_reported", { task: "t01", attempt: 1, sha: "8fd67b4", agent: "pi" });
  const macStudioSnapshot = [
    contract,
    claim,
    ledgerLine(3, "2026-10-20T09:20:00.000Z", "gate_finished", { task: "t01", attempt: 1, exit: 0, verdict: "green", note: "all gates green", sha: "8fd67b4" }),
  ].join("\n") + "\n";
  const miniSnapshot = [
    ledgerLine(2, "2026-10-20T09:00:00.000Z", "contract_set", { task: "t01", workspace: "/w", gate: "npm test", artifact: "report.md", base: "e5b52cc" }),
    ledgerLine(3, "2026-10-20T09:05:00.000Z", "claim_reported", { task: "t01", attempt: 1, sha: "8fd67b4", agent: "pi" }),
    ledgerLine(4, "2026-10-20T09:40:00.000Z", "gate_finished", { task: "t01", attempt: 2, exit: 1, verdict: "red", note: "flaky wall clock", sha: "b6f93a1" }),
    ledgerLine(5, "2026-10-20T09:45:00.000Z", "attempt_accepted", { task: "t01", attempt: 2, accepted_by: "owner" }),
  ].join("\n") + "\n";
  const globalNodeSnapshot = [
    ledgerLine(1, "2026-10-20T08:00:00.000Z", "contract_set", { task: "g01", workspace: "/w", gate: "npm test", artifact: "report.md" }),
    ledgerLine(2, "2026-10-20T08:30:00.000Z", "meter_written", { task: "g01", provider: "pi", usage: {} }),
  ].join("\n") + "\n";

  const bare = makeBareRemote(t);
  seedBareRemote(t, bare, {
    "README.md": "vault\n",
    "vault.manifest.json": JSON.stringify({ patigame: { repoBasename: "patigame" } }),
    "state/nodes/mac-studio/projects/patigame/ledger.jsonl": macStudioSnapshot,
    "state/nodes/mini-m2/projects/patigame/ledger.jsonl": miniSnapshot,
    "state/nodes/mac-studio/global-ledger.jsonl": globalNodeSnapshot,
  });

  // this machine (mini-m2): the checkout registered, a local per-project ledger with its own latest append, a local global ledger
  const home = makeTempDir();
  disposeDir(t, home);
  const stateDir = join(home, "plugin-state", "paseo-factory");
  writeProjectRegistration(stateDir, resolved.slug, { root: patigame });
  const localProjectLedger = join(stateDir, "projects", resolved.slug, "ledger.jsonl");
  mkdirSync(dirname(localProjectLedger), { recursive: true });
  writeFileSync(localProjectLedger, [
    contract,
    claim,
    ledgerLine(4, "2026-10-20T09:40:00.000Z", "gate_finished", { task: "t01", attempt: 2, exit: 1, verdict: "red", note: "flaky wall clock", sha: "b6f93a1" }),
    ledgerLine(5, "2026-10-20T09:45:00.000Z", "attempt_accepted", { task: "t01", attempt: 2, accepted_by: "owner" }),
    ledgerLine(6, "2026-10-20T09:50:00.000Z", "report_written", { task: "t01", attempt: 2, path: "reports/t01.md" }),
  ].join("\n") + "\n");
  const localGlobalLedger = join(stateDir, "ledger.jsonl");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(localGlobalLedger, [
    ledgerLine(1, "2026-10-20T08:00:00.000Z", "contract_set", { task: "g01", workspace: "/w", gate: "npm test", artifact: "report.md" }),
    ledgerLine(2, "2026-10-20T08:30:00.000Z", "meter_written", { task: "g01", provider: "pi", usage: {} }),
    ledgerLine(3, "2026-10-20T09:00:00.000Z", "retro_written", { model: "copilot/gpt-5.4", outcome: "written", durationMs: 900 }),
  ].join("\n") + "\n");

  saveVaultConfig(home, { repo: bare, nodeId: "mini-m2" });
  await pullVault(home, { mergeLedgers: true });

  // the per-project ledger: union of both nodes' + local events, deduped, strictly 1..N, openable
  const opened = Ledger.open(localProjectLedger);
  assert.deepEqual(
    opened.events.map((evt) => `${evt.event}:${(evt as { verdict?: string }).verdict ?? ""}`),
    [
      "contract_set:",
      "claim_reported:",
      "gate_finished:green", // mac-studio's append, missing locally before the pull
      "gate_finished:red",
      "attempt_accepted:",
      "report_written:", // the local append the snapshots lacked
    ],
    "ts order, one contract, both verdicts, the local tail",
  );
  for (let i = 0; i < opened.events.length; i++) assert.equal(opened.events[i]!.seq, i + 1);

  // the global ledger reconciles through the same law
  const openedGlobal = Ledger.open(localGlobalLedger);
  assert.deepEqual(
    openedGlobal.events.map((evt) => evt.event),
    ["contract_set", "meter_written", "retro_written"],
    "the node's global snapshot folds into the local global ledger, deduped",
  );

  // the push side: this node's reconciled ledgers ride the vault under its own namespace
  const push = await pushVault(home, { includeLedger: true });
  assert.equal(push.pushed, true, "the reconciled per-project snapshot is new content in the vault");
  assert.ok(push.pushedFiles.includes(`state/nodes/mini-m2/projects/patigame/ledger.jsonl`), "the per-project ledger lands under the canonical app key");
  assert.ok(push.pushedFiles.includes("state/nodes/mini-m2/global-ledger.jsonl"));

  const probe = makeTempDir();
  disposeDir(t, probe);
  runGit(["clone", bare, probe]);
  assert.equal(
    readFileSync(join(probe, "state/nodes/mini-m2/projects/patigame/ledger.jsonl"), "utf8"),
    readFileSync(localProjectLedger, "utf8"),
    "what was pushed is byte-exact the reconciled local ledger — the next node's pull starts from here",
  );
});

test("hydrateVaultDirect with mergeLedgers reconciles on the zero-clone path too — no vault/.git ever appears", async (t) => {
  const parent = makeProjectParent(t);
  const patigame = join(parent, "patigame");
  mkdirSync(patigame, { recursive: true });
  writeFileSync(join(patigame, "README.md"), "patigame fixture\n");
  gitCommitAll(patigame);
  const resolved = resolveProject(patigame);
  assert.ok(resolved.ok);

  const contract = ledgerLine(1, "2026-10-20T09:00:00.000Z", "contract_set", { task: "t01", workspace: "/w", gate: "npm test", artifact: "report.md" });
  const nodeSnapshot = [
    contract,
    ledgerLine(2, "2026-10-20T09:10:00.000Z", "claim_reported", { task: "t01", attempt: 1, sha: "8fd67b4", agent: "pi" }),
  ].join("\n") + "\n";

  const top = "daymanondev-factory-vault-abc1234";
  const tarball = buildTarball([
    { path: `${top}/vault.manifest.json`, data: JSON.stringify({ patigame: { repoBasename: "patigame" } }) },
    { path: `${top}/state/nodes/mac-studio/projects/patigame/ledger.jsonl`, data: nodeSnapshot },
  ]);

  const home = makeTempDir();
  disposeDir(t, home);
  const stateDir = join(home, "plugin-state", "paseo-factory");
  writeProjectRegistration(stateDir, resolved.slug, { root: patigame });
  const localProjectLedger = join(stateDir, "projects", resolved.slug, "ledger.jsonl");
  mkdirSync(dirname(localProjectLedger), { recursive: true });
  writeFileSync(localProjectLedger, `${contract}\n`); // a fresh machine that only ever saw the contract
  saveVaultConfig(home, { repo: "daymanondev/factory-vault" });

  await hydrateVaultDirect(home, { runner: fakeTarballRunner(tarball).runner, mergeLedgers: true });

  const opened = Ledger.open(localProjectLedger);
  assert.deepEqual(opened.events.map((evt) => evt.event), ["contract_set", "claim_reported"], "the node snapshot's append folds in");
  assert.equal(opened.events[1]!.seq, 2);
  assert.ok(!existsSync(join(home, "vault")), "still zero-clone — no checkout, no .git");
});
