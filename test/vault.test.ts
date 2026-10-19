import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  createDefaultVaultRunner,
  hydrateVaultDirect,
  loadVaultConfig,
  pullVault,
  pushVault,
  readVaultStatus,
  saveVaultConfig,
  sealVaultBuffer,
  unsealVaultBuffer,
} from "../src/index.ts";
import type { VaultRunner, VaultRunnerCall, VaultStatusView } from "../src/index.ts";
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
