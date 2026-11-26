import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  Ledger,
  checkCleanAt,
  clearGhAuthCache,
  createDefaultVaultRunner,
  ensureLocalGitExcludeAndWorktreeInclude,
  ensureRemoteVaultRepo,
  hydrateVaultDirect,
  importVaultSecrets,
  loadVaultConfig,
  materializeProjectVaultFiles,
  parseEnvelope,
  parseVaultManifest,
  prepareTaskWorktree,
  probeGhAuth,
  pullVault,
  pushVault,
  readVaultStatus,
  readLedgerImports,
  reconcileVaultLedgers,
  planHistoryImport,
  planLegacyIdentity,
  migrateLegacyRootState,
  parseLedgerJsonl,
  resolveProject,
  resolveVaultApps,
  saveVaultConfig,
  sealVaultBuffer,
  syncVault,
  unsealVaultBuffer,
  writeProjectRegistration,
} from "../src/index.ts";
import type {
  ImportVaultSecretsInput,
  ImportVaultSecretsResult,
  SyncVaultOptions,
  SyncVaultResult,
  VaultGhAuthStatus,
  VaultManifest,
  VaultRunner,
  VaultRunnerCall,
  VaultStatusView,
} from "../src/index.ts";
import { disposeDir, factoryErrorCode, gitCommitAll, makeTempDir } from "./helpers.ts";
import { applyVaultHydration, collectLocalStateIntoRuntime, matchManifestAppKey, readVaultManifestAt, storeAppNotebookPath, writeRuntimeFile, writeVaultRuntimeEnv } from "../src/vault-materialization.ts";
import { defaultLanes, projectLanesPath, saveLaneProfile } from "../src/lanes.ts";
import type { LaneProfilesFile } from "../src/lanes.ts";

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
      ghInstalled: false,
      ghAuthenticated: false,
      ghUser: null,
      suggestedRepo: null,
      error: null,
    } satisfies VaultStatusView);
    assert.match(status.nodeId, /^[a-z0-9-]+$/);
    assert.ok(status.nodeId.length > 0);
    assert.equal(readVaultStatus(home).nodeId, status.nodeId, "the default nodeId is deterministic");

    const withGh = readVaultStatus(home, undefined, {
      ghInstalled: true,
      ghAuthenticated: true,
      ghUser: "daymanondev",
      suggestedRepo: "daymanondev/factory-vault",
    });
    assert.equal(withGh.ghInstalled, true);
    assert.equal(withGh.ghAuthenticated, true);
    assert.equal(withGh.ghUser, "daymanondev");
    assert.equal(withGh.suggestedRepo, "daymanondev/factory-vault");
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
      ghInstalled: false,
      ghAuthenticated: false,
      ghUser: null,
      suggestedRepo: null,
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

test("the default VaultRunner stamps GIT_TERMINAL_PROMPT=0, appends macOS fallback PATH dirs after caller PATH, and wraps failures", async () => {
  const runner = createDefaultVaultRunner();
  const stdout = await runner({
    command: process.execPath,
    args: ["-e", 'process.stdout.write(process.env.GIT_TERMINAL_PROMPT ?? "unset")'],
  });
  assert.equal(stdout.toString("utf8"), "0", "children never prompt for git credentials — they fail instead");

  const pathOut = (
    await runner({
      command: process.execPath,
      args: ["-e", 'process.stdout.write(process.env.PATH ?? "")'],
      env: { PATH: "/tmp/custom-shim:/usr/bin" },
    })
  ).toString("utf8");
  const pathParts = pathOut.split(":");
  assert.equal(pathParts[0], "/tmp/custom-shim", "caller/test prepended PATH entries stay first so shims win");
  for (const fallback of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
    assert.ok(pathParts.includes(fallback), `missing fallback dir ${fallback} is appended to PATH`);
  }

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
    (err: unknown) => {
      assert.ok(factoryErrorCode("vault-not-configured")(err));
      assert.ok(!(err as Error).message.includes("saveVaultConfig"), "error copy must not leak internal saveVaultConfig name");
      assert.match((err as Error).message, /Enable & Sync Vault/);
      return true;
    },
  );
  await assert.rejects(
    () => pullVault(unconfigured, { runner: fakeTarballRunner(emptyTarball).runner }),
    (err: unknown) => {
      assert.ok(factoryErrorCode("vault-not-configured")(err));
      assert.ok(!(err as Error).message.includes("saveVaultConfig"), "error copy must not leak internal saveVaultConfig name");
      assert.match((err as Error).message, /Enable & Sync Vault/);
      return true;
    },
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

test("pushVault after a pull keeps the remote's envelopes sealed — a no-op cycle commits nothing, changed content re-seals", async (t) => {
  const bare = makeBareRemote(t);
  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  const eyePlain = '{\n  "provider": "eye"\n}\n';
  const gplayEnvelope = JSON.stringify(sealVaultBuffer(Buffer.from(GCP_SERVICE_ACCOUNT, "utf8")));
  const eyeEnvelope = JSON.stringify(sealVaultBuffer(Buffer.from(eyePlain, "utf8"), "correct-horse-battery"));
  seedBareRemote(t, bare, {
    "README.md": "vault\n",
    "secrets/shared/asc-api-key.p8": p8,
    "secrets/shared/gplay-service-account.json": gplayEnvelope,
    "secrets/shared/eye.json": eyeEnvelope,
  });
  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: bare, nodeId: "mac-studio", passphrase: "correct-horse-battery" });

  // the leak setup exactly: pull unseals every envelope into vault-runtime
  await withVaultEnv(undefined, () => pullVault(home));
  const runtimeGplay = join(home, "vault-runtime", "secrets", "shared", "gplay-service-account.json");
  assert.equal(readFileSync(runtimeGplay, "utf8"), GCP_SERVICE_ACCOUNT, "pull unsealed the obfuscated GSA envelope into vault-runtime");
  assert.equal(
    readFileSync(join(home, "vault-runtime", "secrets", "shared", "eye.json"), "utf8"),
    eyePlain,
    "pull unsealed the locked envelope with the persisted passphrase",
  );

  // the no-op cycle: pushing the unsealed tree back must NOT overwrite the remote's envelopes with plaintext
  const headBefore = bareHead(bare);
  const noOp = await withVaultEnv(undefined, () => pushVault(home));
  assert.equal(noOp.pushed, false, "a hydrate/pull → push cycle over unchanged content produces no commit");
  assert.deepEqual(noOp.pushedFiles, [
    "README.md",
    "secrets/shared/asc-api-key.p8",
    "secrets/shared/eye.json",
    "secrets/shared/gplay-service-account.json",
  ], "the staged set is still reported");
  assert.equal(bareHead(bare), headBefore, "the remote tip did not move");

  const probe = makeTempDir();
  disposeDir(t, probe);
  runGit(["clone", bare, probe]);
  const remoteGplay = readFileSync(join(probe, "secrets/shared/gplay-service-account.json"), "utf8");
  assert.equal(remoteGplay, gplayEnvelope, "the obfuscated GSA envelope rides byte-exact — never its plaintext");
  assert.ok(!remoteGplay.includes("PRIVATE KEY"), "no PEM marker ever reaches the remote");
  assert.equal(readFileSync(join(probe, "secrets/shared/eye.json"), "utf8"), eyeEnvelope, "the aes-256-gcm envelope rides byte-exact too");

  // genuinely changed content: the runtime plaintext differs → re-sealed with the envelope's own mode, still never plaintext
  const rotated = GCP_SERVICE_ACCOUNT.replace("d1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1", "e2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2");
  writeFileSync(runtimeGplay, rotated);
  const changed = await withVaultEnv(undefined, () => pushVault(home));
  assert.equal(changed.pushed, true, "genuinely changed content does commit");

  const probe2 = makeTempDir();
  disposeDir(t, probe2);
  runGit(["clone", bare, probe2]);
  const resealed = readFileSync(join(probe2, "secrets/shared/gplay-service-account.json"), "utf8");
  assert.equal(
    resealed,
    `${JSON.stringify(sealVaultBuffer(Buffer.from(rotated, "utf8")))}\n`,
    "changed plaintext re-seals with the envelope's own (deterministic obfuscated) mode",
  );
  assert.ok(!resealed.includes("PRIVATE KEY"), "the re-sealed copy still carries no PEM marker");
  assert.deepEqual(unsealVaultBuffer(readFileSync(join(probe2, "secrets/shared/gplay-service-account.json"))), Buffer.from(rotated, "utf8"), "and still unseals to the new content");

  // an envelope this machine cannot verify against refuses honestly instead of guessing plaintext
  saveVaultConfig(home, { repo: bare, nodeId: "mac-studio" }); // passphrase gone
  const runtimeEye = join(home, "vault-runtime", "secrets", "shared", "eye.json");
  writeFileSync(runtimeEye, '{\n  "provider": "rotated-eye"\n}\n');
  const headAfterChanged = bareHead(bare);
  await assert.rejects(
    () => withVaultEnv(undefined, () => pushVault(home)),
    factoryErrorCode("vault-push-passphrase-required"),
    "changed plaintext over an unopenable envelope refuses — it is never traded for a plaintext guess",
  );
  assert.equal(bareHead(bare), headAfterChanged, "the refusal left the remote tip untouched");
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

test("reconcileVaultLedgers preserves existing sequence addresses and deduplicates identified snapshots", () => {
  const legacy = ledgerLine(10, "2026-10-20T09:00:00.000Z", "contract_set", { task: "t01", workspace: "/local/project", gate: "true", artifact: "out" }) + "\n";
  const prepared = planLegacyIdentity(legacy, { writerId: "local-writer" });
  const local = prepared.events.map((event) => JSON.stringify(event) + "\n").join("");
  assert.equal(reconcileVaultLedgers(local, [{ nodeId: "copied-holder", lines: local }]), local);
  const incoming = planLegacyIdentity(ledgerLine(3, "2020-01-01T00:00:00Z", "contract_set", { task: "new-task", workspace: "/local/other", gate: "true", artifact: "out" }) + "\n", { writerId: "other-writer" });
  const source = incoming.events.map((event) => JSON.stringify(event) + "\n").join("");
  const merged = reconcileVaultLedgers(local, [{ nodeId: "holder", lines: source }], { bindings: [{ epochId: incoming.events[0]!.epoch_id!, workspace: "/local/other" }] });
  assert.ok(merged.startsWith(local));
  assert.deepEqual(merged.trimEnd().split("\n").map((line) => JSON.parse(line).seq), [10, 11, 12]);
});

test("reconcileVaultLedgers refuses damaged history and retains original source bytes", () => {
  const damaged = 'not-json\n{"seq":2}\n';
  assert.throws(() => reconcileVaultLedgers("", [{ nodeId: "damaged", lines: damaged }]), (error: unknown) => {
    const value = error as { code: string; plan: { sources: { lines: string }[] } };
    assert.equal(value.code, "history-import-conflict");
    assert.equal(value.plan.sources[0]!.lines, damaged);
    return true;
  });
});

test("root-to-Project migration preserves event identity so Vault history import stays a duplicate-safe no-op", (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const stateDir = join(dir, "state"); mkdirSync(stateDir, { recursive: true });
  const alphaRoot = join(dir, "alpha-root");
  const writer = "root-writer";
  const contractId = "event:019a0000-0000-7000-8000-000000000001";
  const claimId = "event:019a0000-0000-7000-8000-000000000002";
  const gateId = "event:019a0000-0000-7000-8000-000000000003";
  const reportId = "event:019a0000-0000-7000-8000-000000000004";
  const acceptedId = "event:019a0000-0000-7000-8000-000000000005";
  const identified = (seq: number, event: Record<string, unknown>): string =>
    JSON.stringify({ seq, ts: `2026-11-01T00:0${seq}:00.000Z`, schema_version: 2, provenance: { writer_id: writer }, ...event }) + "\n";
  const raw =
    JSON.stringify({ seq: 1, ts: "2026-11-01T00:00:00.000Z", event: "ledger_schema", schema_version: 2, version: 2, ledger_id: "root-namespace", writer_id: writer, event_id: "schema:root-namespace", provenance: { writer_id: writer } }) + "\n" +
    identified(2, { event: "contract_set", event_id: contractId, epoch_id: contractId, task: "T-01", workspace: alphaRoot, gate: "true", artifact: "out.txt", description: "the accepted brief" }) +
    identified(3, { event: "claim_reported", event_id: claimId, epoch_id: contractId, task: "T-01", attempt: 1, sha: "def456", agent: "agent-peer-1" }) +
    identified(4, { event: "gate_started", event_id: `event:019a0000-0000-7000-8000-000000000006`, epoch_id: contractId, task: "T-01", attempt: 1, cmd: "true" }) +
    identified(5, { event: "gate_finished", event_id: gateId, epoch_id: contractId, task: "T-01", attempt: 1, verdict: "green", exit: 0, note: "passed", sha: "def456abc", outputPath: join(stateDir, "gate-T-01-1.log") }) +
    identified(6, { event: "report_written", event_id: reportId, epoch_id: contractId, task: "T-01", attempt: 1, path: join(stateDir, "report-T-01-1.md") }) +
    identified(7, { event: "attempt_accepted", event_id: acceptedId, epoch_id: contractId, task: "T-01", attempt: 1, accepted_by: "owner" });
  writeFileSync(join(stateDir, "ledger.jsonl"), raw);
  writeFileSync(join(stateDir, "gate-T-01-1.log"), "gate evidence\n");
  writeFileSync(join(stateDir, "report-T-01-1.md"), "report evidence\n");

  const result = migrateLegacyRootState(stateDir, { projects: [{ slug: "alpha", gitRoot: alphaRoot }] });
  assert.equal(result.migrated, true);
  assert.deepEqual(result.projects, ["alpha"]);
  assert.match(result.archiveDir!, /legacy-root-/);

  const alphaPath = join(stateDir, "projects", "alpha", "ledger.jsonl");
  const alphaRaw = readFileSync(alphaPath, "utf8");
  const parsed = parseLedgerJsonl(alphaRaw);
  assert.equal(parsed.corrupt, undefined);
  const fence = parsed.events.find((event) => event.event === "ledger_schema");
  assert.equal(fence?.ledger_id, "root-namespace:alpha", "each destination Ledger fences its own namespace");
  const facts = parsed.events.filter((event) => event.event !== "ledger_schema");
  assert.deepEqual(facts.map((event) => event.seq), [1, 2, 3, 4, 5, 6], "facts renumber contiguously; the fence closes the file");
  assert.deepEqual(facts.map((event) => event.event_id), [contractId, claimId, `event:019a0000-0000-7000-8000-000000000006`, gateId, reportId, acceptedId], "every surviving eventId is preserved unchanged");
  assert.ok(facts.every((event) => event.epoch_id === contractId), "every contractEpochId is preserved unchanged");
  assert.equal((facts.find((event) => event.event === "report_written") as unknown as Record<string, unknown>).path, join(stateDir, "projects", "alpha", "report-T-01-1.md"));
  assert.equal(readFileSync(join(stateDir, "projects", "alpha", "report-T-01-1.md"), "utf8"), "report evidence\n");
  assert.equal(readFileSync(join(result.archiveDir!, "ledger.jsonl"), "utf8"), raw, "the archived root keeps the original bytes verbatim");

  // ADR 0023 duplicate safety: a Vault node's copy of the migrated Ledger
  // re-imports as a pure no-op — same stable identities, zero additions.
  const plan = planHistoryImport({ existingLines: alphaRaw, sources: [{ nodeId: "node-b", lines: alphaRaw }] });
  assert.equal(plan.status, "duplicate");
  assert.deepEqual(plan.additions, []);
  assert.ok(plan.duplicates.includes(contractId) && plan.duplicates.includes(acceptedId));
  assert.equal(reconcileVaultLedgers(alphaRaw, [{ nodeId: "holder", lines: alphaRaw }]), alphaRaw);

  // The migrated Ledger is a live v2 Ledger for its Project's Factory: a
  // writer opens it and the next fact continues the sequence.
  const ledger = Ledger.open(alphaPath, { writerId: "post-migration-writer" });
  assert.equal(ledger.append({ event: "retro_written", model: "copilot/gpt", outcome: "failed", durationMs: 1, error: "lane unavailable" }).seq, 8);
});

test("pullVault retains ambiguous legacy snapshots and leaves existing Ledger bytes unchanged", async (t) => {
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
  const beforeProject = readFileSync(localProjectLedger, "utf8");
  const beforeGlobal = readFileSync(localGlobalLedger, "utf8");
  const pulled = await pullVault(home, { mergeLedgers: true });
  assert.ok(pulled.historyImports?.every((status) => status.status === "pending"));
  assert.equal(readLedgerImports(localProjectLedger)[0]?.status, "pending");

  assert.equal(readFileSync(localProjectLedger, "utf8"), beforeProject);
  assert.equal(readFileSync(localGlobalLedger, "utf8"), beforeGlobal);
  assert.equal(readFileSync(join(home, "vault-runtime/state/nodes/mac-studio/projects/patigame/ledger.jsonl"), "utf8"), macStudioSnapshot);

  // Export preserves the unchanged local histories under this snapshot holder.
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

test("hydrateVaultDirect stages ambiguous legacy admission on the zero-clone path", async (t) => {
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

  const hydrated = await hydrateVaultDirect(home, { runner: fakeTarballRunner(tarball).runner, mergeLedgers: true });
  assert.equal(hydrated.historyImports?.[0]?.status, "pending");
  assert.equal(readFileSync(localProjectLedger, "utf8"), `${contract}\n`);
  assert.equal(readFileSync(join(home, "vault-runtime/state/nodes/mac-studio/projects/patigame/ledger.jsonl"), "utf8"), nodeSnapshot);
  assert.ok(!existsSync(join(home, "vault")), "still zero-clone — no checkout, no .git");
});

test("probeGhAuth parses gh auth status --json hosts, falls back to gh api user, caches per runner for 15s, and distinguishes missing vs unauthenticated gh", async () => {
  clearGhAuthCache();

  // 1. Active account on github.com + 15s cache per runner
  const calls1: VaultRunnerCall[] = [];
  const runner1: VaultRunner = async (call) => {
    calls1.push(call);
    assert.equal(call.command, "gh");
    assert.deepEqual(call.args, ["auth", "status", "--json", "hosts"]);
    return Buffer.from(
      JSON.stringify({
        hosts: {
          "github.com": [
            { login: "secondary-user", active: false, state: "success" },
            { login: "daymanondev", active: true, state: "success" },
          ],
        },
      }),
      "utf8",
    );
  };
  const auth1 = await probeGhAuth(runner1);
  assert.deepEqual(auth1, {
    ghInstalled: true,
    ghAuthenticated: true,
    ghUser: "daymanondev",
    suggestedRepo: "daymanondev/factory-vault",
  } satisfies VaultGhAuthStatus);
  const auth1Cached = await probeGhAuth(runner1);
  assert.deepEqual(auth1Cached, auth1);
  assert.equal(calls1.length, 1, "second call within 15s hits the per-runner cache");

  clearGhAuthCache();
  await probeGhAuth(runner1);
  assert.equal(calls1.length, 2, "clearGhAuthCache invalidates the cache");

  // 2. Fallback to gh api user --jq .login when --json is unsupported
  const callsFallback: VaultRunnerCall[] = [];
  const runnerFallback: VaultRunner = async (call) => {
    callsFallback.push(call);
    if (call.args[0] === "auth") {
      throw new Error("gh auth status --json hosts: unknown flag: --json");
    }
    if (call.args[0] === "api") {
      assert.deepEqual(call.args, ["api", "user", "--jq", ".login"]);
      return Buffer.from("daymanondev\n", "utf8");
    }
    throw new Error(`unexpected call: ${call.command} ${call.args.join(" ")}`);
  };
  const fallbackAuth = await probeGhAuth(runnerFallback);
  assert.deepEqual(fallbackAuth, {
    ghInstalled: true,
    ghAuthenticated: true,
    ghUser: "daymanondev",
    suggestedRepo: "daymanondev/factory-vault",
  });
  assert.equal(callsFallback.length, 2);

  // 3. Missing gh binary (ENOENT / not found) -> ghInstalled: false
  const runnerMissing: VaultRunner = async () => {
    throw new Error("gh auth status --json hosts: spawn gh ENOENT");
  };
  assert.deepEqual(await probeGhAuth(runnerMissing), {
    ghInstalled: false,
    ghAuthenticated: false,
    ghUser: null,
    suggestedRepo: null,
  });

  // 4. Installed but unauthenticated gh -> ghInstalled: true, ghAuthenticated: false
  const runnerUnauth: VaultRunner = async () => {
    throw new Error("gh auth status --json hosts: You are not logged into any GitHub hosts. To log in, run: gh auth login");
  };
  assert.deepEqual(await probeGhAuth(runnerUnauth), {
    ghInstalled: true,
    ghAuthenticated: false,
    ghUser: null,
    suggestedRepo: null,
  });
});

test("ensureRemoteVaultRepo skips local paths and auto-provisions missing private GitHub repos via gh repo create", async (t) => {
  const bare = makeBareRemote(t);
  const localCalls: VaultRunnerCall[] = [];
  const neverCalledRunner: VaultRunner = async (call) => {
    localCalls.push(call);
    return Buffer.alloc(0);
  };

  assert.deepEqual(await ensureRemoteVaultRepo(bare, neverCalledRunner), { created: false, repo: bare });
  assert.deepEqual(await ensureRemoteVaultRepo("./local-vault.git", neverCalledRunner), { created: false, repo: "./local-vault.git" });
  assert.deepEqual(await ensureRemoteVaultRepo("file:///tmp/vault.git", neverCalledRunner), { created: false, repo: "file:///tmp/vault.git" });
  assert.equal(localCalls.length, 0, "local paths and URLs never invoke gh");

  // Existing GitHub repo -> setup-git + repo view, created: false
  const existingCalls: VaultRunnerCall[] = [];
  const existingRunner: VaultRunner = async (call) => {
    existingCalls.push(call);
    if (call.args[0] === "auth") return Buffer.alloc(0);
    if (call.args[0] === "repo" && call.args[1] === "view") {
      return Buffer.from(JSON.stringify({ nameWithOwner: "daymanondev/factory-vault" }), "utf8");
    }
    throw new Error(`unexpected call: ${call.command} ${call.args.join(" ")}`);
  };
  assert.deepEqual(await ensureRemoteVaultRepo("daymanondev/factory-vault", existingRunner), {
    created: false,
    repo: "daymanondev/factory-vault",
  });
  assert.deepEqual(
    existingCalls.map((c) => [c.command, ...c.args]),
    [
      ["gh", "auth", "setup-git", "--hostname", "github.com"],
      ["gh", "repo", "view", "daymanondev/factory-vault", "--json", "nameWithOwner"],
    ],
  );

  // Missing GitHub repo -> setup-git + repo view (fails) + repo create --private --add-readme, created: true
  const createCalls: VaultRunnerCall[] = [];
  const createRunner: VaultRunner = async (call) => {
    createCalls.push(call);
    if (call.args[0] === "auth") return Buffer.alloc(0);
    if (call.args[0] === "repo" && call.args[1] === "view") {
      throw new Error("GraphQL: Could not resolve to a Repository with the name 'daymanondev/factory-vault'.");
    }
    if (call.args[0] === "repo" && call.args[1] === "create") {
      return Buffer.from("https://github.com/daymanondev/factory-vault\n", "utf8");
    }
    throw new Error(`unexpected call: ${call.command} ${call.args.join(" ")}`);
  };
  assert.deepEqual(await ensureRemoteVaultRepo("daymanondev/factory-vault", createRunner), {
    created: true,
    repo: "daymanondev/factory-vault",
  });
  assert.deepEqual(
    createCalls.map((c) => [c.command, ...c.args]),
    [
      ["gh", "auth", "setup-git", "--hostname", "github.com"],
      ["gh", "repo", "view", "daymanondev/factory-vault", "--json", "nameWithOwner"],
      ["gh", "repo", "create", "daymanondev/factory-vault", "--private", "--add-readme", "--description", "Private vault for paseo-factory"],
    ],
  );
});

test("empty-remote bootstrap: pullVault on an empty bare remote returns hydratedFiles: [] and pushVault creates the branch with the initial commit", async (t) => {
  // 1. Pull on a brand-new empty bare remote (0 commits, no refs/heads/main)
  const emptyBare = makeBareRemote(t, "main");
  const home1 = makeTempDir();
  disposeDir(t, home1);
  saveVaultConfig(home1, { repo: emptyBare, branch: "main", nodeId: "mac-studio" });

  const pullEmpty = await pullVault(home1);
  assert.deepEqual(pullEmpty.hydratedFiles, [], "empty remote pulls cleanly with zero hydrated files");
  assert.ok(existsSync(join(home1, "vault", ".git")), "checkout exists at <paseoHome>/vault");
  assert.equal(runGit(["symbolic-ref", "--short", "HEAD"], join(home1, "vault")), "main", "checkout is on configured branch");

  // Re-pulling an existing unborn checkout while remote is still empty also succeeds cleanly
  const pullEmptyAgain = await pullVault(home1);
  assert.deepEqual(pullEmptyAgain.hydratedFiles, []);

  // 2. Push from a fresh home into another empty bare remote creates the remote branch
  const emptyBare2 = makeBareRemote(t, "main");
  const homePush = makeTempDir();
  disposeDir(t, homePush);
  saveVaultConfig(homePush, { repo: emptyBare2, branch: "main", nodeId: "mac-studio" });
  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  mkdirSync(join(homePush, "vault-runtime", "secrets", "shared"), { recursive: true });
  writeFileSync(join(homePush, "vault-runtime", "secrets", "shared", "asc-api-key.p8"), p8);

  const pushRes = await pushVault(homePush);
  assert.equal(pushRes.pushed, true, "initial commit pushed to empty remote");
  assert.deepEqual(pushRes.pushedFiles, ["secrets/shared/asc-api-key.p8"]);
  assert.ok(bareHead(emptyBare2, "main").length > 0, "refs/heads/main now exists on the bare remote");

  // 3. A second home can now pullVault what was pushed to the previously empty remote
  const homePull = makeTempDir();
  disposeDir(t, homePull);
  saveVaultConfig(homePull, { repo: emptyBare2, branch: "main", nodeId: "mini-m2" });
  const pulled = await pullVault(homePull);
  assert.deepEqual(pulled.hydratedFiles, ["secrets/shared/asc-api-key.p8"]);
  assert.equal(readFileSync(join(homePull, "vault-runtime", "secrets", "shared", "asc-api-key.p8"), "utf8"), p8);

  // And home1 (which pulled when emptyBare was empty) can push its own initial commit and pull thereafter
  mkdirSync(join(home1, "vault-runtime", "config"), { recursive: true });
  writeFileSync(join(home1, "vault-runtime", "config", "lanes.json"), JSON.stringify({ lanes: { default: "pi" } }));
  const pushFromUnborn = await pushVault(home1);
  assert.equal(pushFromUnborn.pushed, true);
  const pullAfterInit = await pullVault(home1);
  assert.deepEqual(pullAfterInit.hydratedFiles, ["config/lanes.json"]);
});

test("pushVault automatically collects lanes.json, eye.json (sealed on remote), and project .store-release/manifest.json; pullVault and hydrateVaultDirect materialize configs when absent or overwriteConfigs: true", async (t) => {
  const bare = makeBareRemote(t);
  const parent = makeProjectParent(t);
  const patigame = join(parent, "patigame");
  mkdirSync(patigame, { recursive: true });
  writeFileSync(join(patigame, "README.md"), "patigame fixture\n");
  gitCommitAll(patigame);
  runGit(["remote", "add", "origin", "git@github.com:daymanondev/patigame.git"], patigame);
  const storeManifest = JSON.stringify({ bundleId: "com.patigame.app", packageName: "com.patigame" }, null, 2);
  mkdirSync(join(patigame, ".store-release"), { recursive: true });
  writeFileSync(join(patigame, ".store-release", "manifest.json"), storeManifest);
  const resolved = resolveProject(patigame);
  assert.ok(resolved.ok);

  const home1 = makeTempDir();
  disposeDir(t, home1);
  saveVaultConfig(home1, { repo: bare, nodeId: "mac-studio" });
  const stateDir1 = join(home1, "plugin-state", "paseo-factory");
  writeProjectRegistration(stateDir1, resolved.slug, { root: patigame });

  const lanesJson = JSON.stringify({ worker: "pi/zai/glm-5.3", supervisor: "copilot/gpt-5.4" });
  const eyeJson = JSON.stringify({ provider: "openrouter", apiKey: "sk-or-secret-12345" });

  writeFileSync(join(stateDir1, "lanes.json"), lanesJson);
  writeFileSync(join(stateDir1, "eye.json"), eyeJson);

  const pushed = await pushVault(home1);
  assert.equal(pushed.pushed, true);
  assert.deepEqual(pushed.pushedFiles, [
    "config/apps/patigame/store-manifest.json",
    "config/lanes.json",
    "secrets/shared/eye.json",
    "vault.manifest.json",
  ]);
  assert.equal(modeOf(join(home1, "vault-runtime", "secrets", "shared", "eye.json")), 0o600);

  // Verify the remote checkout sealed eye.json and wrote vault.manifest.json + store-manifest.json
  const probe = makeTempDir();
  disposeDir(t, probe);
  runGit(["clone", bare, probe]);
  const remoteEyeRaw = readFileSync(join(probe, "secrets/shared/eye.json"), "utf8");
  assert.ok(!remoteEyeRaw.includes("sk-or-secret-12345"), "eye.json on remote must be sealed, never raw plaintext");
  assert.equal(unsealVaultBuffer(Buffer.from(remoteEyeRaw, "utf8")).toString("utf8"), eyeJson);
  assert.equal(readFileSync(join(probe, "config/apps/patigame/store-manifest.json"), "utf8"), storeManifest);
  assert.deepEqual(parseVaultManifest(readFileSync(join(probe, "vault.manifest.json"), "utf8")), {
    patigame: {
      repoBasename: "patigame",
      gitRemote: "git@github.com:daymanondev/patigame.git",
      bundleId: "com.patigame.app",
      packageName: "com.patigame",
    },
  });

  // Machine 2 pulls: configs materialize into local state dirs when absent
  const home2 = makeTempDir();
  disposeDir(t, home2);
  saveVaultConfig(home2, { repo: bare, nodeId: "mini-m2" });
  await pullVault(home2);

  const stateDir2 = join(home2, "plugin-state", "paseo-factory");
  assert.equal(readFileSync(join(stateDir2, "lanes.json"), "utf8"), lanesJson);

  // Local edits are preserved on pull when overwriteConfigs is false (default), and overwritten when overwriteConfigs: true
  const localCustomLanes = JSON.stringify({ worker: "claude/opus-4-8" });
  writeFileSync(join(stateDir2, "lanes.json"), localCustomLanes);
  await pullVault(home2);
  assert.equal(readFileSync(join(stateDir2, "lanes.json"), "utf8"), localCustomLanes, "existing local config is not overwritten by default");

  await pullVault(home2, { overwriteConfigs: true });
  assert.equal(readFileSync(join(stateDir2, "lanes.json"), "utf8"), lanesJson, "overwriteConfigs: true restores vault config");

  // Direct hydrate also respects overwriteConfigs
  const home3 = makeTempDir();
  disposeDir(t, home3);
  saveVaultConfig(home3, { repo: "daymanondev/factory-vault" });
  const top = "daymanondev-factory-vault-abc1234";
  const tarball = buildTarball([
    { path: `${top}/config/lanes.json`, data: lanesJson },
  ]);
  await hydrateVaultDirect(home3, { runner: fakeTarballRunner(tarball).runner });
  const stateDir3 = join(home3, "plugin-state", "paseo-factory");
  assert.equal(readFileSync(join(stateDir3, "lanes.json"), "utf8"), lanesJson);
  writeFileSync(join(stateDir3, "lanes.json"), localCustomLanes);
  await hydrateVaultDirect(home3, { runner: fakeTarballRunner(tarball).runner, overwriteConfigs: false });
  assert.equal(readFileSync(join(stateDir3, "lanes.json"), "utf8"), localCustomLanes);
  await hydrateVaultDirect(home3, { runner: fakeTarballRunner(tarball).runner, overwriteConfigs: true });
  assert.equal(readFileSync(join(stateDir3, "lanes.json"), "utf8"), lanesJson);
});

test("syncVault auto-detects @daymanondev via probeGhAuth, auto-creates daymanondev/factory-vault, collects local state & ledgers, pushes, and hydrates a second machine in one call", async (t) => {
  clearGhAuthCache();
  const bare = makeBareRemote(t);
  const defaultRunner = createDefaultVaultRunner();

  // Route GitHub URL https://github.com/daymanondev/factory-vault.git to our local bare remote
  const ghCalls: VaultRunnerCall[] = [];
  let repoCreated = false;
  const hybridRunner: VaultRunner = async (call) => {
    if (call.command === "gh") {
      ghCalls.push(call);
      if (call.args[0] === "auth" && call.args[1] === "status") {
        return Buffer.from(
          JSON.stringify({
            hosts: {
              "github.com": [{ login: "daymanondev", active: true, state: "success" }],
            },
          }),
          "utf8",
        );
      }
      if (call.args[0] === "auth" && call.args[1] === "setup-git") {
        return Buffer.alloc(0);
      }
      if (call.args[0] === "repo" && call.args[1] === "view") {
        if (!repoCreated) {
          throw new Error("Could not resolve to a Repository with the name 'daymanondev/factory-vault'.");
        }
        return Buffer.from(JSON.stringify({ nameWithOwner: "daymanondev/factory-vault" }), "utf8");
      }
      if (call.args[0] === "repo" && call.args[1] === "create") {
        repoCreated = true;
        return Buffer.from("https://github.com/daymanondev/factory-vault\n", "utf8");
      }
      throw new Error(`unexpected gh call: ${call.args.join(" ")}`);
    }
    const rewrittenArgs = call.args.map((arg) => (arg === "https://github.com/daymanondev/factory-vault.git" ? bare : arg));
    return defaultRunner({ ...call, args: rewrittenArgs });
  };

  // Machine 1: unconfigured home, gh authenticated as @daymanondev, has local lanes, project store manifest, and ledger
  const parent = makeProjectParent(t);
  const patigame1 = join(parent, "m1", "patigame");
  mkdirSync(patigame1, { recursive: true });
  writeFileSync(join(patigame1, "README.md"), "patigame fixture\n");
  gitCommitAll(patigame1);
  mkdirSync(join(patigame1, ".store-release"), { recursive: true });
  writeFileSync(join(patigame1, ".store-release", "manifest.json"), JSON.stringify({ bundleId: "com.patigame.app" }));
  const resolved1 = resolveProject(patigame1);
  assert.ok(resolved1.ok);

  const home1 = makeTempDir();
  disposeDir(t, home1);
  const stateDir1 = join(home1, "plugin-state", "paseo-factory");
  writeProjectRegistration(stateDir1, resolved1.slug, { root: patigame1 });
  writeFileSync(join(stateDir1, "lanes.json"), JSON.stringify({ worker: "pi/zai/glm-5.3" }));
  writeFileSync(join(stateDir1, "ledger.jsonl"), LEDGER_LINES);

  const sync1: SyncVaultResult = await syncVault(home1, { runner: hybridRunner } satisfies SyncVaultOptions);
  assert.equal(sync1.createdRepo, true, "first sync auto-creates daymanondev/factory-vault");
  assert.equal(sync1.repo, "daymanondev/factory-vault");
  assert.equal(sync1.branch, "main");
  assert.equal(sync1.pushed, true);
  assert.ok(sync1.pushedFiles.includes("config/lanes.json"));
  assert.ok(sync1.pushedFiles.includes("config/apps/patigame/store-manifest.json"));
  assert.ok(sync1.pushedFiles.includes("vault.manifest.json"));
  assert.ok(sync1.pushedFiles.some((f) => f.endsWith("/global-ledger.jsonl")));
  assert.ok(sync1.summary.length > 0);
  assert.equal(loadVaultConfig(home1)?.repo, "daymanondev/factory-vault");

  // Machine 2: transport-only sync hydrates configuration without activating legacy history.
  const home2 = makeTempDir();
  disposeDir(t, home2);
  const sync2 = await syncVault(home2, { runner: hybridRunner, mergeLedgers: false });
  assert.equal(sync2.createdRepo, false, "repo already exists on second sync");
  assert.equal(sync2.repo, "daymanondev/factory-vault");
  assert.ok(sync2.hydratedFiles.includes("config/lanes.json"));
  assert.equal(readFileSync(join(home2, "plugin-state", "paseo-factory", "lanes.json"), "utf8"), JSON.stringify({ worker: "pi/zai/glm-5.3" }));
  assert.ok(!existsSync(join(home2, "plugin-state", "paseo-factory", "ledger.jsonl")), "transport-only sync cannot activate legacy history");

  // Unconfigured home with unauthenticated gh refuses with vault-not-configured
  const homeUnauth = makeTempDir();
  disposeDir(t, homeUnauth);
  const unauthRunner: VaultRunner = async () => {
    throw new Error("You are not logged into any GitHub hosts.");
  };
  await assert.rejects(() => syncVault(homeUnauth, { runner: unauthRunner }), factoryErrorCode("vault-not-configured"));
});

test("importVaultSecrets imports .p8, ASC credentials, Google Play JSON (sealed against Secret Scanning on remote), eye.json, and app keystore/Firebase files, updates env.json, and syncs", async (t) => {
  const bare = makeBareRemote(t);
  const srcDir = makeTempDir();
  disposeDir(t, srcDir);

  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key imported\n-----END PRIVATE KEY-----\n";
  const eyePlain = JSON.stringify({ provider: "openrouter", apiKey: "sk-or-eye" });
  const keystore = randomBytes(1024);
  const googleServices = JSON.stringify({ project_info: { project_id: "patigame-firebase" } });
  const plist = '<?xml version="1.0"?>\n<plist/>\n';

  const ascKeyPath = join(srcDir, "AuthKey_XYZ.p8");
  const gplayKeyPath = join(srcDir, "gplay-sa.json");
  const eyeConfigPath = join(srcDir, "eye.json");
  const keystorePath = join(srcDir, "release.keystore");
  const googleServicesJsonPath = join(srcDir, "google-services.json");
  const googleServiceInfoPlistPath = join(srcDir, "GoogleService-Info.plist");

  writeFileSync(ascKeyPath, p8);
  writeFileSync(gplayKeyPath, GCP_SERVICE_ACCOUNT);
  writeFileSync(eyeConfigPath, eyePlain);
  writeFileSync(keystorePath, keystore);
  writeFileSync(googleServicesJsonPath, googleServices);
  writeFileSync(googleServiceInfoPlistPath, plist);

  const parent = makeProjectParent(t);
  const patigame = join(parent, "patigame");
  mkdirSync(patigame, { recursive: true });
  writeFileSync(join(patigame, "README.md"), "patigame fixture\n");
  gitCommitAll(patigame);
  const resolved = resolveProject(patigame);
  assert.ok(resolved.ok);

  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: bare, nodeId: "mac-studio" });
  writeProjectRegistration(join(home, "plugin-state", "paseo-factory"), resolved.slug, { root: patigame });

  const input: ImportVaultSecretsInput = {
    ascKeyPath,
    ascKeyId: "KEY123456",
    ascIssuer: "ISSUER-999",
    gplayKeyPath,
    eyeConfigPath,
    appKey: "patigame",
    keystorePath,
    storePass: "keystore-secret-pass",
    keyAlias: "upload",
    googleServicesJsonPath,
    googleServiceInfoPlistPath,
  };
  const imported: ImportVaultSecretsResult = await importVaultSecrets(home, input);

  assert.deepEqual(imported.importedFiles, [
    "secrets/apps/patigame/GoogleService-Info.plist",
    "secrets/apps/patigame/google-services.json",
    "secrets/apps/patigame/release.keystore",
    "secrets/apps/patigame/signing.json",
    "secrets/shared/asc-api-key.p8",
    "secrets/shared/asc-credentials.json",
    "secrets/shared/eye.json",
    "secrets/shared/gplay-service-account.json",
  ]);
  assert.ok(imported.synced !== null && imported.synced.pushed === true, "syncAfterImport defaults to true and pushes to configured vault");
  assert.ok(imported.summary.length > 0);

  // Verify env.json is immediately populated
  const envJson = JSON.parse(readFileSync(join(home, "vault-runtime", "env.json"), "utf8"));
  assert.deepEqual(envJson, {
    ASC_KEY_PATH: join(home, "vault-runtime", "secrets", "shared", "asc-api-key.p8"),
    ASC_KEY_ID: "KEY123456",
    ASC_ISSUER: "ISSUER-999",
    GPLAY_KEY_PATH: join(home, "vault-runtime", "secrets", "shared", "gplay-service-account.json"),
    RELEASE_LAB_KEYSTORE_STOREPASS: "keystore-secret-pass",
    FIREBASE_PROJECT_ID: "patigame-firebase",
  });

  // Verify local project checkout received materialized per-app files
  assert.deepEqual(readFileSync(join(patigame, "android/app/release.keystore")), keystore);
  assert.equal(readFileSync(join(patigame, "android/app/google-services.json"), "utf8"), googleServices);
  assert.equal(readFileSync(join(patigame, "ios/GoogleService-Info.plist"), "utf8"), plist);

  // Verify remote bare repository has gplay-service-account.json and eye.json sealed (never raw PRIVATE KEY)
  const probe = makeTempDir();
  disposeDir(t, probe);
  runGit(["clone", bare, probe]);
  const remoteGplay = readFileSync(join(probe, "secrets/shared/gplay-service-account.json"), "utf8");
  assert.ok(!remoteGplay.includes("PRIVATE KEY"), "Google Play SA key on remote must be sealed against GitHub Secret Scanning");
  assert.equal(unsealVaultBuffer(Buffer.from(remoteGplay, "utf8")).toString("utf8"), GCP_SERVICE_ACCOUNT);
  const remoteEye = readFileSync(join(probe, "secrets/shared/eye.json"), "utf8");
  assert.ok(!remoteEye.includes("sk-or-eye"), "eye.json on remote must be sealed");
  assert.equal(unsealVaultBuffer(Buffer.from(remoteEye, "utf8")).toString("utf8"), eyePlain);

  // Verify process.env fallback when no explicit inputs are passed and syncAfterImport: false
  const homeEnv = makeTempDir();
  disposeDir(t, homeEnv);
  const priorAscPath = process.env.ASC_KEY_PATH;
  const priorAscId = process.env.ASC_KEY_ID;
  const priorAscIssuer = process.env.ASC_ISSUER;
  const priorGplayPath = process.env.GPLAY_KEY_PATH;
  process.env.ASC_KEY_PATH = ascKeyPath;
  process.env.ASC_KEY_ID = "ENV_KEY_ID";
  process.env.ASC_ISSUER = "ENV_ISSUER_ID";
  process.env.GPLAY_KEY_PATH = gplayKeyPath;
  try {
    const envImported = await importVaultSecrets(homeEnv, { syncAfterImport: false });
    assert.equal(envImported.synced, null);
    assert.deepEqual(envImported.importedFiles, [
      "secrets/shared/asc-api-key.p8",
      "secrets/shared/asc-credentials.json",
      "secrets/shared/gplay-service-account.json",
    ]);
    const envJson2 = JSON.parse(readFileSync(join(homeEnv, "vault-runtime", "env.json"), "utf8"));
    assert.equal(envJson2.ASC_KEY_ID, "ENV_KEY_ID");
    assert.equal(envJson2.ASC_ISSUER, "ENV_ISSUER_ID");
  } finally {
    if (priorAscPath === undefined) delete process.env.ASC_KEY_PATH;
    else process.env.ASC_KEY_PATH = priorAscPath;
    if (priorAscId === undefined) delete process.env.ASC_KEY_ID;
    else process.env.ASC_KEY_ID = priorAscId;
    if (priorAscIssuer === undefined) delete process.env.ASC_ISSUER;
    else process.env.ASC_ISSUER = priorAscIssuer;
    if (priorGplayPath === undefined) delete process.env.GPLAY_KEY_PATH;
    else process.env.GPLAY_KEY_PATH = priorGplayPath;
  }
});




test("Vault status distinguishes transported bytes from durable pending and conflicted history", async (t) => {
  const home = makeTempDir(); disposeDir(t, home);
  const state = join(home, "plugin-state", "paseo-factory");
  const { stageLedgerImport, loadImportManifest, saveImportManifest } = await import("../src/history-stage.ts");
  saveVaultConfig(home, { repo: "owner/vault", lastHydratedAt: "2026-10-23T01:00:00Z" });
  const staged = stageLedgerImport(join(state, "ledger.jsonl"), [{ nodeId: "remote", lines: "original bytes\n" }]);
  const pending = readVaultStatus(home);
  assert.equal(pending.historyImports?.find((item) => item.id === staged.id)?.status, "pending");
  assert.equal(pending.lastHydratedAt, "2026-10-23T01:00:00Z");
  const manifest = loadImportManifest(join(state, "ledger.jsonl"), staged.id);
  manifest.status = "conflicted"; manifest.conflicts = [{ reason: "unverified root" }]; saveImportManifest(manifest);
  assert.equal(readVaultStatus(home).historyImports?.[0]?.status, "conflicted");
  assert.equal(readVaultStatus(home).lastHydratedAt, pending.lastHydratedAt);
});

test("Vault fetch completes while a pipeline holds the writer but associated materialization waits for maintenance", async (t) => {
  const home = makeTempDir(); disposeDir(t, home);
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const { createFactory } = await import("../src/factory.ts");
  const factory = createFactory({ stateDir }); t.after(() => factory.history.stop());
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((done) => { entered = done; });
  const held = new Promise<void>((done) => { release = done; });
  const operation = factory.history.runOperation(async () => { entered(); await held; });
  await ready;
  let fetched = false;
  const tarball = buildTarball([{ path: "daymanondev-factory-vault-abc1234/config/lanes.json", data: Buffer.from("{}\n") }]);
  const hydration = hydrateVaultDirect(home, { repo: "owner/vault", runner: async () => { fetched = true; return tarball; } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(fetched, true);
  assert.equal(existsSync(join(stateDir, "lanes.json")), false);
  release(); await operation; const result = await hydration;
  assert.equal(result.repo, "owner/vault"); assert.equal(result.ref, "main");
  assert.equal(readFileSync(join(stateDir, "lanes.json"), "utf8"), "{}\n");
});

test("Vault publishes only acknowledged Ledger records and preserves a local unterminated tail", async (t) => {
  const home = makeTempDir(); disposeDir(t, home);
  saveVaultConfig(home, { repo: "owner/vault", nodeId: "local" });
  mkdirSync(join(home, "vault", ".git"), { recursive: true });
  const state = join(home, "plugin-state", "paseo-factory", "ledger.jsonl");
  const acknowledged = `${JSON.stringify({ event: "contract_set", seq: 1, ts: "2026-10-23T00:00:00Z", task: "T" })}\n`;
  writeFileSync(state, acknowledged + '{"unacknowledged":');
  const result = await pushVault(home, { includeLedger: true, runner: async () => Buffer.alloc(0) });
  assert.ok(result.pushedFiles.includes("state/nodes/local/global-ledger.jsonl"));
  assert.equal(readFileSync(join(home, "vault", "state", "nodes", "local", "global-ledger.jsonl"), "utf8"), acknowledged);
  assert.equal(readFileSync(state, "utf8"), acknowledged + '{"unacknowledged":');
});

test("standalone Vault refuses another process's live owner after fetching without materializing state", async (t) => {
  const home = makeTempDir(); disposeDir(t, home);
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const { createFactory } = await import("../src/factory.ts");
  const factory = createFactory({ stateDir }); t.after(() => factory.history.stop());
  const tar = buildTarball([{ path: "daymanondev-factory-vault-abc1234/config/lanes.json", data: "{}\n" }]);
  const moduleUrl = new URL("../plugin/bin/vault.mjs", import.meta.url).href;
  const script = `import {hydrateVaultDirect} from ${JSON.stringify(moduleUrl)}; let fetched=false; try { await hydrateVaultDirect(${JSON.stringify(home)}, {repo:'owner/vault',runner:async()=>{fetched=true;return Buffer.from('${tar.toString("base64")}','base64')}}); } catch(error){console.log(JSON.stringify({code:error.code,message:error.message,fetched}));}`;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
  assert.equal(result.code, "vault-owner-required"); assert.equal(result.fetched, true);
  assert.match(result.message, /RPC/);
  assert.equal(existsSync(join(stateDir, "lanes.json")), false);
});

test("an incomplete explicit upgrade blocks Vault configuration and materialization until resume", async (t) => {
  const home = makeTempDir(); disposeDir(t, home);
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const { createFactory } = await import("../src/factory.ts");
  const { upgradeFactory } = await import("../src/history-upgrade.ts");
  const factory = createFactory({ stateDir }); t.after(() => factory.history.stop());
  await assert.rejects(upgradeFactory(factory, { action: "apply", transactionId: "11111111-2222-4333-8444-555555555555" }, { fault: (at) => { if (at === "backed-up") throw new Error("interrupted"); } }), /interrupted/);
  const { readdirSync } = await import("node:fs");
  const snapshot = (root: string): unknown => readdirSync(root).sort().map((name) => { const path = join(root, name), st = statSync(path); return [name, st.mode & 0o7777, st.isDirectory() ? snapshot(path) : readFileSync(path).toString("base64")]; });
  const before = snapshot(stateDir);
  assert.throws(() => saveVaultConfig(home, { repo: "owner/vault" }), factoryErrorCode("upgrade-recovery-required"));
  const tar = buildTarball([{ path: "daymanondev-factory-vault-abc1234/config/lanes.json", data: "{}\n" }, { path: "daymanondev-factory-vault-abc1234/state/nodes/remote/global-ledger.jsonl", data: "retained original\n" }]);
  await assert.rejects(hydrateVaultDirect(home, { repo: "owner/vault", mergeLedgers: true, runner: async () => tar }), factoryErrorCode("upgrade-recovery-required"));
  assert.equal(existsSync(join(stateDir, "lanes.json")), false);
  assert.deepEqual(readLedgerImports(factory.ledger.path), []);
  assert.deepEqual(snapshot(stateDir), before);
  const resumed = await upgradeFactory(factory, { action: "resume", transactionId: "11111111-2222-4333-8444-555555555555" });
  assert.ok("status" in resumed); assert.equal(resumed.status, "applied");
});

test("Vault canonical app routing refuses a Project Ledger alias before staging into another target", async (t) => {
  const home = makeTempDir(); disposeDir(t, home);
  const workspace = join(home, "workspace"); mkdirSync(workspace); writeFileSync(join(workspace, "README"), "fixture"); gitCommitAll(workspace);
  const project = resolveProject(workspace); assert.ok(project.ok); if (!project.ok) return;
  const stateDir = join(home, "plugin-state", "paseo-factory");
  writeProjectRegistration(stateDir, project.slug, { root: workspace });
  const global = join(stateDir, "ledger.jsonl"); writeFileSync(global, "");
  const { symlinkSync } = await import("node:fs"); symlinkSync(global, join(stateDir, "projects", project.slug, "ledger.jsonl"));
  const tar = buildTarball([
    { path: "daymanondev-factory-vault-abc1234/vault.manifest.json", data: JSON.stringify({ app: { repoBasename: "workspace" } }) },
    { path: "daymanondev-factory-vault-abc1234/state/nodes/remote/projects/app/ledger.jsonl", data: "retained original\n" },
  ]);
  await assert.rejects(hydrateVaultDirect(home, { repo: "owner/vault", mergeLedgers: true, runner: async () => tar }), factoryErrorCode("history-target-alias"));
  assert.deepEqual(readLedgerImports(global), []);
  assert.equal(readFileSync(global, "utf8"), "");
});

test("secret import reports successful transport with pending history in its existing summary", async (t) => {
  const home = makeTempDir(); disposeDir(t, home);
  saveVaultConfig(home, { repo: join(home, "local-remote") });
  const node = join(home, "vault", "state", "nodes", "remote"); mkdirSync(node, { recursive: true });
  mkdirSync(join(home, "vault", ".git"));
  writeFileSync(join(node, "global-ledger.jsonl"), "retained original\n");
  const result = await importVaultSecrets(home, { ascKeyId: "fixture", runner: async () => Buffer.alloc(0) });
  assert.ok(result.importedFiles.includes("secrets/shared/asc-credentials.json"));
  assert.equal(result.synced?.historyImports?.[0]?.status, "pending");
  assert.match(result.summary, /history pending/);
});

for (const transport of ["direct", "pull"] as const) test(`Vault ${transport} durably stages fetched history while verification holds materialization`, async (t) => {
  const home = makeTempDir(); disposeDir(t, home);
  const workspace = join(home, "workspace"); mkdirSync(workspace); writeFileSync(join(workspace, "out"), "artifact"); gitCommitAll(workspace);
  saveVaultConfig(home, { repo: "owner/vault" });
  const stateDir = join(home, "plugin-state/paseo-factory");
  const fence = planLegacyIdentity("", { writerId: "local" }).events.map((event) => JSON.stringify(event) + "\n").join("");
  writeFileSync(join(stateDir, "ledger.jsonl"), fence);
  const { createFactory } = await import("../src/factory.ts");
  const factory = createFactory({ stateDir, writerId: "local" }); t.after(() => factory.history.stop());
  factory.setContract({ task: "LOCAL", workspace, gate: "true", artifact: "out", scope: ["local"] });
  const source = planLegacyIdentity(JSON.stringify({ seq: 1, ts: "2026-10-23T00:00:00Z", event: "contract_set", task: "REMOTE", workspace, gate: "true", artifact: "out", scope: ["remote"] }) + "\n", { writerId: "remote" }).events.map((event) => JSON.stringify(event) + "\n").join("");
  const entries = [{ path: "daymanondev-factory-vault-abc1234/state/nodes/remote/global-ledger.jsonl", data: source }, { path: "daymanondev-factory-vault-abc1234/config/lanes.json", data: "{}\n" }];
  const tar = buildTarball(entries);
  if (transport === "pull") {
    mkdirSync(join(home, "vault/.git"), { recursive: true });
    for (const entry of entries) { const path = join(home, "vault", entry.path.split("/").slice(1).join("/")); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, entry.data); }
  }
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((done) => { entered = done; }), held = new Promise<void>((done) => { release = done; });
  const operation = factory.history.runOperation(async () => { entered(); await held; }); await ready;
  let fetched = false;
  const runner: VaultRunner = async () => { fetched = true; return transport === "direct" ? tar : Buffer.alloc(0); };
  const download = transport === "direct" ? hydrateVaultDirect(home, { mergeLedgers: true, runner }) : pullVault(home, { mergeLedgers: true, runner });
  try {
    await new Promise(setImmediate);
    assert.equal(fetched, true);
    const pending = readLedgerImports(factory.ledger.path);
    assert.equal(pending[0]?.status, "pending");
    assert.equal(pending[0]?.materialization?.status, "pending");
    assert.equal(factory.contractFor("REMOTE"), undefined);
    assert.equal(existsSync(join(stateDir, "lanes.json")), false);
  } finally { release(); await operation; }
  const result = await download;
  assert.equal(result.materialization?.status, "applied");
  assert.equal(result.historyImports?.[0]?.status, "applied");
  assert.equal(factory.contractFor("REMOTE")?.workspace, workspace);
  assert.equal(readFileSync(join(stateDir, "lanes.json"), "utf8"), "{}\n");
});

// ---- the v0.0.38 Lane profile + per-app lanes.json vault sync (ADR 0026 §4) -------------------

test("v0.0.38 (ADR 0026 §4): Lane profiles and per-Project lanes.json round-trip through the vault runtime", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");

  // One registered local Project — a real git checkout, its slug resolved.
  const repo = join(dir, "app-one");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "file.txt"), "x\n");
  gitCommitAll(repo);
  const project = resolveProject(repo);
  assert.ok(project.ok, project.ok ? "" : project.reason);
  writeProjectRegistration(stateDir, project.slug, { root: repo, name: "app-one" });

  // Local Lane profiles: two, distinct ids and edit times.
  const lanesAlpha = { ...defaultLanes(), worker: "claude/claude-sonnet-4-6" };
  const lanesBeta = { ...defaultLanes(), worker: "copilot/gpt-5.4" };
  const lanesGamma = { ...defaultLanes(), worker: "pi/zai/glm-5.3" };
  saveLaneProfile(stateDir, { id: "alpha", name: "Alpha", lanes: lanesAlpha, updatedAt: "2026-10-24T10:00:00.000Z" });
  saveLaneProfile(stateDir, { id: "beta", name: "Beta", lanes: lanesBeta, updatedAt: "2026-10-24T11:00:00.000Z" });
  // A profile another machine authored earlier — already sitting in the
  // runtime cache; the collect must MERGE, not overwrite it away.
  mkdirSync(join(paseoHome, "vault-runtime", "config"), { recursive: true });
  writeFileSync(
    join(paseoHome, "vault-runtime", "config", "profiles.json"),
    `${JSON.stringify({ profiles: { gamma: { name: "Gamma", lanes: lanesGamma, updatedAt: "2026-10-23T09:00:00.000Z" } } }, null, 2)}\n`,
  );
  // The Project's own lanes.json override.
  mkdirSync(join(stateDir, "projects", project.slug), { recursive: true });
  writeFileSync(projectLanesPath(stateDir, project.slug), `${JSON.stringify({ watch: "claude/claude-opus-4-6:high" }, null, 2)}\n`);

  collectLocalStateIntoRuntime(paseoHome);

  // config/profiles.json: merged per profileId — union of both machines.
  const stagedProfiles = JSON.parse(readFileSync(join(paseoHome, "vault-runtime", "config", "profiles.json"), "utf8")) as LaneProfilesFile;
  assert.deepEqual(Object.keys(stagedProfiles.profiles).sort(), ["alpha", "beta", "gamma"], "profiles merge key-level, never overwrite");
  assert.equal(stagedProfiles.profiles.alpha!.lanes.worker, "claude/claude-sonnet-4-6");

  // config/apps/<canonicalAppKey>/lanes.json staged, manifest legs updated.
  const manifest = JSON.parse(readFileSync(join(paseoHome, "vault-runtime", "vault.manifest.json"), "utf8")) as Record<string, { repoBasename?: string }>;
  const key = Object.keys(manifest).find((candidate) => manifest[candidate]!.repoBasename === "app-one");
  assert.ok(key, `the manifest carries a routing entry for app-one, got ${JSON.stringify(manifest)}`);
  const stagedAppLanes = JSON.parse(readFileSync(join(paseoHome, "vault-runtime", "config", "apps", key!, "lanes.json"), "utf8"));
  assert.deepEqual(stagedAppLanes, { watch: "claude/claude-opus-4-6:high" }, "the per-Project override staged under its canonical app key");

  // Hydration restores both on a machine that lost them: profiles merge back
  // (key-level), the Project's override materializes when absent locally.
  rmSync(join(stateDir, "profiles.json"));
  rmSync(projectLanesPath(stateDir, project.slug));
  applyVaultHydration(paseoHome);
  const hydratedProfiles = JSON.parse(readFileSync(join(stateDir, "profiles.json"), "utf8")) as LaneProfilesFile;
  assert.deepEqual(Object.keys(hydratedProfiles.profiles).sort(), ["alpha", "beta", "gamma"], "the merged profile set materialized");
  assert.deepEqual(
    JSON.parse(readFileSync(projectLanesPath(stateDir, project.slug), "utf8")),
    { watch: "claude/claude-opus-4-6:high" },
    "the per-app lanes override materialized into the Project's own state tree",
  );

  // A NEWER local edit survives a non-overwrite hydration — the merge is
  // key-level, so the remote's older copy never clobbers it.
  saveLaneProfile(stateDir, { id: "beta", name: "Beta (local edit)", lanes: lanesBeta, updatedAt: "2026-10-25T10:00:00.000Z" });
  applyVaultHydration(paseoHome);
  const kept = JSON.parse(readFileSync(join(stateDir, "profiles.json"), "utf8")) as LaneProfilesFile;
  assert.equal(kept.profiles.beta!.name, "Beta (local edit)", "the newer local edit wins the merge");
  // An existing per-Project override is NOT clobbered without overwriteConfigs.
  writeFileSync(projectLanesPath(stateDir, project.slug), `${JSON.stringify({ retro: "copilot/gpt-5.4" }, null, 2)}\n`);
  applyVaultHydration(paseoHome);
  assert.deepEqual(
    JSON.parse(readFileSync(projectLanesPath(stateDir, project.slug), "utf8")),
    { retro: "copilot/gpt-5.4" },
    "without overwriteConfigs an existing local override stands",
  );
  // overwriteConfigs === true: the vault copy wins back.
  applyVaultHydration(paseoHome, true);
  assert.deepEqual(
    JSON.parse(readFileSync(projectLanesPath(stateDir, project.slug), "utf8")),
    { watch: "claude/claude-opus-4-6:high" },
    "overwriteConfigs materializes the vault copy over the local override",
  );
});

test("ADR 0036: collectLocalStateIntoRuntime collects ~/.agents/skills (excluding impeccable*) into config/skills/ and applyVaultHydration materializes and symlinks them across machines", (t) => {
  const machineA = makeTempDir("vault-skills-a-");
  const machineB = makeTempDir("vault-skills-b-");
  disposeDir(t, machineA);
  disposeDir(t, machineB);

  const homeA = join(machineA, ".paseo");
  const homeB = join(machineB, ".paseo");
  mkdirSync(homeA, { recursive: true });
  mkdirSync(homeB, { recursive: true });

  // Machine A has pure-Markdown skills + binary impeccable in ~/.agents/skills
  mkdirSync(join(machineA, ".agents/skills/tdd/references"), { recursive: true });
  writeFileSync(join(machineA, ".agents/skills/tdd/SKILL.md"), "# TDD Skill\n");
  writeFileSync(join(machineA, ".agents/skills/tdd/references/guide.md"), "Red-Green-Refactor\n");

  mkdirSync(join(machineA, ".agents/skills/impeccable/scripts"), { recursive: true });
  writeFileSync(join(machineA, ".agents/skills/impeccable/SKILL.md"), "# Impeccable\n");
  writeFileSync(join(machineA, ".agents/skills/impeccable/scripts/VERSION"), "4.8.0\n");
  writeFileSync(join(machineA, ".agents/skills/impeccable/scripts/impeccable"), "binary");

  collectLocalStateIntoRuntime(homeA);

  // Verify tdd was collected into config/skills/tdd/, impeccable was excluded from config/skills/, and companion-tools.json contains only the managed skills
  assert.equal(
    readFileSync(join(homeA, "vault-runtime/config/skills/tdd/SKILL.md"), "utf8"),
    "# TDD Skill\n",
  );
  assert.equal(
    readFileSync(join(homeA, "vault-runtime/config/skills/tdd/references/guide.md"), "utf8"),
    "Red-Green-Refactor\n",
  );
  assert.equal(existsSync(join(homeA, "vault-runtime/config/skills/impeccable")), false, "OS-specific impeccable binary directory is never staged into vault config/skills");
  const companionManifest = JSON.parse(readFileSync(join(homeA, "vault-runtime/config/companion-tools.json"), "utf8"));
  assert.equal(companionManifest.impeccable, undefined);
  assert.deepEqual(companionManifest.skills, ["tdd"]);

  // Simulate copying vault-runtime/config/skills from Machine A to Machine B and hydrating
  mkdirSync(join(homeB, "vault-runtime/config/skills/tdd/references"), { recursive: true });
  writeFileSync(join(homeB, "vault-runtime/config/skills/tdd/SKILL.md"), "# TDD Skill\n");
  writeFileSync(join(homeB, "vault-runtime/config/skills/tdd/references/guide.md"), "Red-Green-Refactor\n");

  applyVaultHydration(homeB);

  // Machine B now has ~/.agents/skills/tdd and symlinks in .pi/agent/skills, .claude/skills, .gemini/config/skills
  assert.equal(readFileSync(join(machineB, ".agents/skills/tdd/SKILL.md"), "utf8"), "# TDD Skill\n");
  assert.equal(readFileSync(join(machineB, ".pi/agent/skills/tdd/SKILL.md"), "utf8"), "# TDD Skill\n");
  assert.equal(readFileSync(join(machineB, ".claude/skills/tdd/SKILL.md"), "utf8"), "# TDD Skill\n");
  assert.equal(readFileSync(join(machineB, ".gemini/config/skills/tdd/SKILL.md"), "utf8"), "# TDD Skill\n");
});

test("Private vault replicates Helper MCP definitions separately from keys and OAuth", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const source = join(dir, "source"), target = join(dir, "target");
  const state = join(source, "plugin-state/paseo-factory"), targetState = join(target, "plugin-state/paseo-factory");
  mkdirSync(state, { recursive: true });
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(join(state, "helper-mcps.json"), JSON.stringify({ servers: [
    { name: "exa", transport: "stdio", command: "npx", args: ["exa-mcp-server"], env: { EXA_API_KEY: "secret-exa" }, enabled: true, sources: ["pi"] },
    { name: "supabase", transport: "http", url: "https://mcp.supabase.com/mcp", enabled: true, sources: ["antigravity"] },
    { name: "private", transport: "stdio", command: "npx", env: { PRIVATE_KEY: "private-only" }, sources: ["pi"] },
    { name: "disabled", transport: "stdio", command: "npx", env: { DISABLED_KEY: "disabled-only" }, sources: ["pi"] },
    { name: "local", transport: "stdio", command: "npx", env: { LOCAL_KEY: "local-only" }, sources: ["claude"] },
  ], overrides: { exa: true, private: true, supabase: true, disabled: false }, targets: { supabase: ["pi", "claude"] }, vaultSync: { exa: true, supabase: true, disabled: true, local: true } }));
  writeFileSync(join(state, "helper-mcp-oauth.json"), JSON.stringify({ supabase: { serverUrl: "https://mcp.supabase.com/mcp", tokens: { accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt } } }));
  collectLocalStateIntoRuntime(source, { userHome: source });
  const definition = readFileSync(join(source, "vault-runtime/config/helper-mcps.json"), "utf8");
  assert.doesNotMatch(definition, /secret-exa|secret-access|secret-refresh|private|disabled|local/);
  assert.deepEqual(JSON.parse(definition).servers.map((s: any) => s.name), ["exa", "supabase"]);
  const secrets = readFileSync(join(source, "vault-runtime/secrets/shared/mcp-oauth.json"), "utf8");
  assert.match(secrets, /secret-exa/); assert.match(secrets, /secret-access/);
  assert.doesNotMatch(secrets, /private-only|disabled-only|local-only/);
  cpSync(join(source, "vault-runtime"), join(target, "vault-runtime"), { recursive: true });
  mkdirSync(join(target, ".pi/agent"), { recursive: true });
  writeFileSync(join(target, ".pi/agent/mcp.json"), JSON.stringify({ mcpServers: { exa: { command: "npx", args: ["exa-mcp-server"], env: { EXA_API_KEY: "" } } } }));
  applyVaultHydration(target, false, { userHome: target });
  const restored = JSON.parse(readFileSync(join(targetState, "helper-mcps.json"), "utf8"));
  assert.equal(restored.servers.find((s: any) => s.name === "exa").env.EXA_API_KEY, "secret-exa");
  assert.equal(restored.overrides.exa, true);
  assert.equal(restored.overrides.supabase, true);
  assert.equal(restored.vaultSync.supabase, true);
  assert.deepEqual(restored.targets.supabase, ["pi", "claude"]);
  assert.ok(restored.servers.find((s: any) => s.name === "supabase").sources.includes("vault"));
  assert.equal(JSON.parse(readFileSync(join(targetState, "helper-mcp-oauth.json"), "utf8")).supabase.tokens.accessToken, "secret-access");
  assert.equal(statSync(join(target, "vault-runtime/secrets/shared/mcp-oauth.json")).mode & 0o777, 0o600);
  const piToken = join(targetState, "pi-agent/agent/mcp-oauth", `sha256-${createHash("sha256").update("supabase").digest("hex")}`, "tokens.json");
  assert.equal(JSON.parse(readFileSync(piToken, "utf8")).tokens.accessToken, "secret-access");
  assert.equal(statSync(piToken).mode & 0o777, 0o600);
  assert.equal(existsSync(join(target, ".pi/agent/mcp-oauth")), false);
  saveVaultConfig(source, { repo: makeBareRemote(t), nodeId: "mcp-source" });
  await pushVault(source);
  const staged = readFileSync(join(source, "vault/secrets/shared/mcp-oauth.json"));
  assert.doesNotMatch(staged.toString(), /secret-exa|secret-access|secret-refresh/);
  assert.match(unsealVaultBuffer(staged, undefined).toString(), /secret-access/);

});

test("Helper vault hydration preserves explicit local choices and recollection removes withdrawn shares", async (t) => {
  const { collectHelperMcpVault, hydrateHelperMcpVault } = await import("../src/helper-mcp-vault.ts");
  const { discoverHelperMcps, setHelperMcpEnabled } = await import("../src/helper-mcp-sync.ts");
  const dir = makeTempDir(); disposeDir(t, dir);
  const runtime = join(dir, "runtime"), stateDir = join(dir, "source"), userHome = join(dir, "user");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "helper-mcps.json"), JSON.stringify({ servers: [
    { name: "docs", command: process.execPath, sources: ["pi"] },
  ], overrides: { docs: true }, vaultSync: { docs: true }, targets: { docs: ["claude"] } }));
  collectHelperMcpVault({ stateDir, userHome }, runtime);
  const target = { stateDir: join(dir, "target"), userHome };
  mkdirSync(target.stateDir, { recursive: true });
  writeFileSync(join(target.stateDir, "helper-mcps.json"), JSON.stringify({ overrides: { docs: false }, vaultSync: { docs: false }, targets: { docs: [] } }));
  hydrateHelperMcpVault(target, runtime, false);
  let server = discoverHelperMcps(target).servers[0];
  assert.equal(server.enabled, false); assert.equal(server.vaultSync, false); assert.deepEqual(server.targetProviders, []);
  hydrateHelperMcpVault(target, runtime, true);
  server = discoverHelperMcps(target).servers[0];
  assert.equal(server.enabled, true); assert.equal(server.vaultSync, true); assert.deepEqual(server.targetProviders, ["claude"]);
  setHelperMcpEnabled({ stateDir, userHome }, "docs", { vaultSync: false });
  collectHelperMcpVault({ stateDir, userHome }, runtime);
  assert.deepEqual(JSON.parse(readFileSync(join(runtime, "config/helper-mcps.json"), "utf8")).servers, []);
  assert.deepEqual(JSON.parse(readFileSync(join(runtime, "secrets/shared/mcp-oauth.json"), "utf8")), { oauth: {}, fields: {} });
});

test('Private vault excludes repository design bundles on push and hydration', async t => {
  const bare = makeBareRemote(t); seedBareRemote(t, bare, { 'README.md': 'vault\n' });
  const home = makeTempDir(); disposeDir(t, home); saveVaultConfig(home, { repo: bare, nodeId: 'design-isolation' });
  const runtime = join(home, 'vault-runtime'); mkdirSync(join(runtime, 'projects/p/design/assets'), { recursive: true });
  writeFileSync(join(runtime, 'projects/p/design/index.html'), 'Owner design');
  writeFileSync(join(runtime, 'projects/p/design/assets/picture.svg'), '<svg/>');
  const pushed = await pushVault(home);
  assert.ok(!pushed.pushedFiles.some(p => p.includes('/design/')));
  assert.equal(existsSync(join(home, 'vault/projects/p/design/index.html')), false);
  const archive = gzipSync(buildTarball([{ path: 'top/projects/p/design/index.html', data: Buffer.from('design') }, { path: 'top/secrets/shared/eye.json', data: Buffer.from('{}') }]));
  const hydrated = await hydrateVaultDirect(home, { repo: 'owner/factory-vault', runner: fakeTarballRunner(archive).runner });
  assert.ok(!hydrated.hydratedFiles.some(p => p.includes('/design/')));
});

test('custom skill packs vault merges newer edits and deletion tombstones across machines', async (t) => {
  const { saveSkillPack, deleteSkillPack, readSkillPackStore } = await import('../src/skill-packs.ts');
  const dir = makeTempDir(); disposeDir(t, dir);
  const home = join(dir, 'paseo'), state = join(home, 'plugin-state/paseo-factory');
  saveSkillPack(state, { name: 'Release', skills: ['asc-iap'], updatedAt: '2026-01-01T00:00:00Z' });
  collectLocalStateIntoRuntime(home, { userHome: dir });
  const staged = join(home, 'vault-runtime/config/skill-packs.json');
  assert.ok(existsSync(staged));
  rmSync(join(state, 'skill-packs.json'));
  applyVaultHydration(home, false, { userHome: dir });
  assert.deepEqual(readSkillPackStore(state).packs.release?.skills, ['asc-iap']);
  saveSkillPack(state, { id: 'release', name: 'Release', skills: ['research'], updatedAt: '2026-02-01T00:00:00Z' });
  applyVaultHydration(home, true, { userHome: dir });
  assert.deepEqual(readSkillPackStore(state).packs.release?.skills, ['research']);
  deleteSkillPack(state, 'release');
  collectLocalStateIntoRuntime(home, { userHome: dir });
  const deleted = JSON.parse(readFileSync(staged, 'utf8'));
  assert.equal(deleted.packs.release.deleted, true);
  saveSkillPack(state, { id: 'release', name: 'Release', skills: ['asc-iap'], updatedAt: '2026-01-01T00:00:00Z' });
  applyVaultHydration(home, false, { userHome: dir });
  assert.equal(readSkillPackStore(state).packs.release?.deleted, true);
});

test("importVaultSecrets accepts optional teamId (and APPLE_TEAM_ID env fallback) and hydrates APPLE_TEAM_ID into 0o600 env.json", async (t) => {
  const home = makeTempDir();
  disposeDir(t, home);

  const imported = await importVaultSecrets(home, {
    ascKeyId: "KEY_SYNTH_01",
    ascIssuer: "00000000-0000-0000-0000-000000000001",
    teamId: "TEAM_SYNTH_01",
    syncAfterImport: false,
  });
  assert.deepEqual(imported.importedFiles, ["secrets/shared/asc-credentials.json"]);
  const creds = JSON.parse(readFileSync(join(home, "vault-runtime/secrets/shared/asc-credentials.json"), "utf8"));
  assert.equal(creds.teamId, "TEAM_SYNTH_01");
  const envPath = join(home, "vault-runtime/env.json");
  assert.equal(modeOf(envPath), 0o600);
  const envJson = JSON.parse(readFileSync(envPath, "utf8"));
  assert.equal(envJson.APPLE_TEAM_ID, "TEAM_SYNTH_01");

  const homeEnv = makeTempDir();
  disposeDir(t, homeEnv);
  const priorTeamId = process.env.APPLE_TEAM_ID;
  process.env.APPLE_TEAM_ID = "ENV_TEAM_SYNTH";
  try {
    const envImported = await importVaultSecrets(homeEnv, { syncAfterImport: false });
    assert.ok(envImported.importedFiles.includes("secrets/shared/asc-credentials.json"));
    const envJson2 = JSON.parse(readFileSync(join(homeEnv, "vault-runtime/env.json"), "utf8"));
    assert.equal(envJson2.APPLE_TEAM_ID, "ENV_TEAM_SYNTH");
  } finally {
    if (priorTeamId === undefined) delete process.env.APPLE_TEAM_ID;
    else process.env.APPLE_TEAM_ID = priorTeamId;
  }
});

test("store-defaults.json validates, hydrates at 0o600 across pull/hydrate/collect/push, and round-trips between machines", async (t) => {
  const bare = makeBareRemote(t);
  seedBareRemote(t, bare, { "README.md": "vault\n" });

  const home1 = makeTempDir();
  disposeDir(t, home1);
  saveVaultConfig(home1, { repo: bare, nodeId: "node-alpha" });

  const { writeStoreDefaults, readStoreDefaults, storeDefaultsPath } = await import("../src/vault.ts");
  assert.equal(readStoreDefaults(home1), null);

  const defaults = {
    organizationName: "Example Synthetic Studio",
    supportEmail: "support@example.invalid",
    privacyUrlTemplate: "https://example.invalid/apps/{slug}/privacy",
    supportUrlTemplate: "https://example.invalid/apps/{slug}/support",
    reviewContact: {
      firstName: "Alex",
      lastName: "Tester",
      email: "review@example.invalid",
      phone: "+1-555-0100",
    },
  };
  const writtenPath = writeStoreDefaults(home1, defaults);
  assert.equal(writtenPath, storeDefaultsPath(home1));
  assert.equal(modeOf(writtenPath), 0o600, "store-defaults.json must be 0o600");
  assert.deepEqual(readStoreDefaults(home1), defaults);

  const pushed = await pushVault(home1);
  assert.equal(pushed.pushed, true);
  assert.ok(pushed.pushedFiles.includes("store-defaults.json"));

  const home2 = makeTempDir();
  disposeDir(t, home2);
  saveVaultConfig(home2, { repo: bare, nodeId: "node-beta" });
  const pulled = await pullVault(home2);
  assert.ok(pulled.hydratedFiles.includes("store-defaults.json"));
  assert.equal(modeOf(storeDefaultsPath(home2)), 0o600, "pulled store-defaults.json must be 0o600");
  assert.deepEqual(readStoreDefaults(home2), defaults);

  const home3 = makeTempDir();
  disposeDir(t, home3);
  const archive = buildTarball([
    { path: "daymanondev-factory-vault-abc1234/store-defaults.json", data: Buffer.from(JSON.stringify(defaults)) },
  ]);
  const direct = await hydrateVaultDirect(home3, { repo: "owner/factory-vault", runner: fakeTarballRunner(archive).runner });
  assert.ok(direct.hydratedFiles.includes("store-defaults.json"));
  assert.equal(modeOf(storeDefaultsPath(home3)), 0o600, "direct-hydrated store-defaults.json must be 0o600");
  assert.deepEqual(readStoreDefaults(home3), defaults);
});

test("writeBackAndroidKeystore seals newly generated Day-0 keystore into Private vault, registers hygiene, and stays git-clean", async (t) => {
  const bare = makeBareRemote(t);
  seedBareRemote(t, bare, { "README.md": "vault\n" });

  const parent = makeProjectParent(t);
  const appRepo = join(parent, "synth-mobile-app");
  mkdirSync(appRepo, { recursive: true });
  writeFileSync(join(appRepo, "README.md"), "synthetic mobile app\n");
  gitCommitAll(appRepo);
  const resolved = resolveProject(appRepo);
  assert.ok(resolved.ok);

  const home1 = makeTempDir();
  disposeDir(t, home1);
  saveVaultConfig(home1, { repo: bare, nodeId: "node-alpha" });
  writeProjectRegistration(join(home1, "plugin-state", "paseo-factory"), resolved.slug, { root: appRepo });

  // Simulate Day-0 keystore generated by release-lab under <paseoHome>/release-lab/keystores/<slug>/
  const generatedDir = join(home1, "release-lab", "keystores", resolved.slug);
  mkdirSync(generatedDir, { recursive: true });
  const keystoreBytes = randomBytes(1024);
  const generatedKeystore = join(generatedDir, "release.keystore");
  const generatedProps = join(generatedDir, "keystore.properties");
  writeFileSync(generatedKeystore, keystoreBytes);
  writeFileSync(
    generatedProps,
    "storeFile=/tmp/synthetic/should-not-leak/release.keystore\nstorePassword=synth-store-pass\nkeyPassword=synth-key-pass\nkeyAlias=upload\n",
  );

  const { writeBackAndroidKeystore, parseEnvelope } = await import("../src/vault.ts");
  const result = await writeBackAndroidKeystore(home1, {
    keystorePath: generatedKeystore,
    projectRoot: appRepo,
  });

  assert.equal(result.canonicalAppKey, "synth-mobile-app");
  assert.equal(result.pushed, true);
  assert.deepEqual(result.writtenVaultFiles, [
    "secrets/apps/synth-mobile-app/release.keystore",
    "secrets/apps/synth-mobile-app/signing.json",
  ]);
  assert.deepEqual(result.sealedFiles, [
    "secrets/apps/synth-mobile-app/release.keystore",
    "secrets/apps/synth-mobile-app/signing.json",
  ]);

  // Runtime & checkout materialized at 0o600, and project git tree stays completely clean
  assert.deepEqual(readFileSync(join(home1, "vault-runtime/secrets/apps/synth-mobile-app/release.keystore")), keystoreBytes);
  assert.equal(modeOf(join(home1, "vault-runtime/secrets/apps/synth-mobile-app/release.keystore")), 0o600);
  assert.deepEqual(readFileSync(join(appRepo, "android/app/release.keystore")), keystoreBytes);
  assert.equal(modeOf(join(appRepo, "android/app/release.keystore")), 0o600);
  assert.equal(runGit(["status", "--porcelain"], appRepo), "");

  const excludeText = readFileSync(join(resolved.gitCommonDir, "info", "exclude"), "utf8");
  assert.match(excludeText, /android\/app\/release\.keystore/);
  assert.match(excludeText, /android\/keystore\.properties/);
  assert.match(excludeText, /\.worktreeinclude/);
  const includeText = readFileSync(join(appRepo, ".worktreeinclude"), "utf8");
  assert.match(includeText, /android\/app\/release\.keystore/);
  assert.match(includeText, /android\/keystore\.properties/);

  // Remote bare repo holds sealed VaultEnvelopes (never raw keystore/signing bytes)
  const probe = makeTempDir();
  disposeDir(t, probe);
  runGit(["clone", bare, probe]);
  const remoteKeystoreRaw = readFileSync(join(probe, "secrets/apps/synth-mobile-app/release.keystore"));
  assert.ok(parseEnvelope(remoteKeystoreRaw) !== null, "remote keystore must be a sealed VaultEnvelope");
  assert.deepEqual(unsealVaultBuffer(remoteKeystoreRaw), keystoreBytes);

  const remoteSigningRaw = readFileSync(join(probe, "secrets/apps/synth-mobile-app/signing.json"));
  assert.ok(parseEnvelope(remoteSigningRaw) !== null, "remote signing.json must be a sealed VaultEnvelope");
  const unsealedSigning = JSON.parse(unsealVaultBuffer(remoteSigningRaw).toString("utf8"));
  assert.deepEqual(unsealedSigning, {
    keyAlias: "upload",
    keyPassword: "synth-key-pass",
    storePassword: "synth-store-pass",
  });
});

test("Store notebook (store-memory/lessons.md <= 120 lines + apps/<canonical-app>.md) enforces line cap, hydrates read-only, and syncs across machines", async (t) => {
  const bare = makeBareRemote(t);
  seedBareRemote(t, bare, { "README.md": "vault\n" });

  const parent = makeProjectParent(t);
  const appRepo = join(parent, "synth-notebook-app");
  mkdirSync(appRepo, { recursive: true });
  writeFileSync(join(appRepo, "README.md"), "synthetic app\n");
  const headBefore = gitCommitAll(appRepo);

  const home1 = makeTempDir();
  disposeDir(t, home1);
  saveVaultConfig(home1, { repo: bare, nodeId: "node-alpha" });

  const {
    STORE_LESSONS_MAX_LINES,
    readStoreLessons,
    writeStoreLessons,
    readStoreAppNotebook,
    writeStoreAppNotebook,
    storeLessonsPath,
    storeAppNotebookPath,
  } = await import("../src/vault.ts");

  assert.equal(STORE_LESSONS_MAX_LINES, 120);
  assert.equal(readStoreLessons(home1), null);
  assert.equal(readStoreAppNotebook(home1, "synth-notebook-app"), null);

  // Exactly 120 lines succeeds and lands read-only
  const ok120 = Array.from({ length: 120 }, (_, i) => `| L-${String(i + 1).padStart(3, "0")} | ios | Cause ${i + 1} | Fix ${i + 1} |`).join("\n") + "\n";
  const lessonsFile = writeStoreLessons(home1, ok120);
  assert.equal(lessonsFile, storeLessonsPath(home1));
  assert.equal(modeOf(lessonsFile) & 0o222, 0, "lessons.md must hydrate read-only");
  assert.equal(modeOf(lessonsFile), 0o400);
  assert.equal(readStoreLessons(home1), ok120);

  // 121 lines is refused with store-notebook-limit-exceeded and preserves prior 120-line file
  const over121 = ok120 + "| L-121 | android | Overflow | Prevent |\n";
  assert.throws(
    () => writeStoreLessons(home1, over121),
    factoryErrorCode("store-notebook-limit-exceeded"),
  );
  assert.equal(readStoreLessons(home1), ok120, "failed over-limit write preserves prior lessons.md");

  // Re-writing <= 120 lines over an existing read-only file succeeds without EACCES
  const compactLessons = [
    "# Store Lessons",
    "",
    "| ID | Platform | Cause -> Rejection | Prevention |",
    "| --- | --- | --- | --- |",
    "| L-001 | ios | Missing privacy manifest -> ITMS-91053 | Declare NSPrivacyAccessedAPITypes |",
    "",
  ].join("\n");
  writeStoreLessons(home1, compactLessons);
  assert.equal(modeOf(lessonsFile), 0o400);
  assert.equal(readStoreLessons(home1), compactLessons);

  const appCard = [
    "# synth-notebook-app",
    "",
    "- Shape: Native Android + Native iOS",
    "- Bundle ID: com.example.synth",
    "- Package: com.example.synth",
    "- Notes: Initial synthetic store card.",
    "",
  ].join("\n");
  const appFile = writeStoreAppNotebook(home1, "synth-notebook-app", appCard);
  assert.equal(appFile, storeAppNotebookPath(home1, "synth-notebook-app"));
  assert.equal(modeOf(appFile) & 0o222, 0, "app store card must hydrate read-only");
  assert.equal(modeOf(appFile), 0o400);

  const pushed = await pushVault(home1);
  assert.equal(pushed.pushed, true);
  assert.ok(pushed.pushedFiles.includes("store-memory/lessons.md"));
  assert.ok(pushed.pushedFiles.includes("store-memory/apps/synth-notebook-app.md"));

  // Second machine pulls via git and hydrates read-only
  const home2 = makeTempDir();
  disposeDir(t, home2);
  saveVaultConfig(home2, { repo: bare, nodeId: "node-beta" });
  const pulled = await pullVault(home2);
  assert.ok(pulled.hydratedFiles.includes("store-memory/lessons.md"));
  assert.ok(pulled.hydratedFiles.includes("store-memory/apps/synth-notebook-app.md"));
  assert.equal(modeOf(storeLessonsPath(home2)) & 0o222, 0);
  assert.equal(modeOf(storeAppNotebookPath(home2, "synth-notebook-app")) & 0o222, 0);
  assert.equal(readStoreLessons(home2), compactLessons);
  assert.equal(readStoreAppNotebook(home2, "synth-notebook-app"), appCard);

  // Direct hydrate (gh api tarball) also hydrates read-only and overwrites existing read-only files cleanly
  const updatedLessons = compactLessons + "| L-002 | android | Missing targetSdk -> Play reject | Bump targetSdk |\n";
  const tarball = buildTarball([
    { path: "daymanondev-factory-vault-abc1234/store-memory/lessons.md", data: updatedLessons },
    { path: "daymanondev-factory-vault-abc1234/store-memory/apps/synth-notebook-app.md", data: appCard },
  ]);
  const direct = await hydrateVaultDirect(home2, { repo: "owner/factory-vault", runner: fakeTarballRunner(tarball).runner });
  assert.ok(direct.hydratedFiles.includes("store-memory/lessons.md"));
  assert.equal(modeOf(storeLessonsPath(home2)) & 0o222, 0);
  assert.equal(readStoreLessons(home2), updatedLessons);

  // Collect/push refuses if a hand-edited lessons.md exceeds 120 lines
  chmodSync(storeLessonsPath(home1), 0o600);
  writeFileSync(storeLessonsPath(home1), over121);
  await assert.rejects(() => pushVault(home1), factoryErrorCode("store-notebook-limit-exceeded"));

  // App repo git tree remained untouched throughout
  assert.equal(runGit(["status", "--porcelain"], appRepo), "");
  assert.equal(runGit(["rev-parse", "HEAD"], appRepo), headBefore);
});

test("importVaultSecrets with envLocalPath seals .env.local on remote (obfuscated & aes-256-gcm), materializes 0o600 with clean git hygiene, and rides prepareTaskWorktree without .env.local.bak", async (t) => {
  const envLocalBody = "EXPO_PUBLIC_API_URL=https://api.example.invalid\nSECRET_API_TOKEN=sk-test-env-local-98765\n";
  const srcDir = makeTempDir();
  disposeDir(t, srcDir);
  const envLocalPath = join(srcDir, ".env.local");
  writeFileSync(envLocalPath, envLocalBody);

  // 1. Zero-passphrase (obfuscated) mode
  const barePlain = makeBareRemote(t);
  seedBareRemote(t, barePlain, { "README.md": "vault\n" });

  const parent = makeProjectParent(t);
  const patigame = join(parent, "machine-a", "patigame");
  mkdirSync(patigame, { recursive: true });
  writeFileSync(join(patigame, "README.md"), "patigame\n");
  const head = gitCommitAll(patigame);
  const resolvedA = resolveProject(patigame);
  assert.ok(resolvedA.ok);

  const home1 = makeTempDir();
  disposeDir(t, home1);
  saveVaultConfig(home1, { repo: barePlain, nodeId: "mac-studio" });
  writeProjectRegistration(join(home1, "plugin-state", "paseo-factory"), resolvedA.slug, { root: patigame });

  const imported = await withVaultEnv(undefined, () =>
    importVaultSecrets(home1, { appKey: "patigame", envLocalPath }),
  );
  assert.deepEqual(imported.importedFiles, ["secrets/apps/patigame/.env.local"]);
  assert.equal(imported.synced?.pushed, true);

  const runtimeEnvLocal = join(home1, "vault-runtime", "secrets", "apps", "patigame", ".env.local");
  assert.equal(readFileSync(runtimeEnvLocal, "utf8"), envLocalBody);
  assert.equal(modeOf(runtimeEnvLocal), 0o600);

  const projectEnvLocal = join(patigame, ".env.local");
  assert.equal(readFileSync(projectEnvLocal, "utf8"), envLocalBody);
  assert.equal(modeOf(projectEnvLocal), 0o600);

  const excludeLines = readFileSync(join(resolvedA.gitCommonDir, "info", "exclude"), "utf8").split("\n");
  const includeLines = readFileSync(join(patigame, ".worktreeinclude"), "utf8").split("\n");
  assert.ok(excludeLines.includes(".env.local"));
  assert.ok(excludeLines.includes(".worktreeinclude"));
  assert.ok(includeLines.includes(".env.local"));
  assert.equal(runGit(["status", "--porcelain"], patigame), "");
  assert.deepEqual(await checkCleanAt(patigame, head), { ok: true });

  // Bare remote holds a sealed obfuscated VaultEnvelope, never raw plaintext
  const probePlain = makeTempDir();
  disposeDir(t, probePlain);
  runGit(["clone", barePlain, probePlain]);
  const remoteObfRaw = readFileSync(join(probePlain, "secrets", "apps", "patigame", ".env.local"));
  assert.equal(parseEnvelope(remoteObfRaw)?.mode, "obfuscated");
  assert.ok(!remoteObfRaw.toString("utf8").includes("sk-test-env-local-98765"), "raw .env.local secret must never hit remote");
  assert.equal(unsealVaultBuffer(remoteObfRaw).toString("utf8"), envLocalBody);

  // Worktree carries .env.local, and does NOT carry an ignored .env.local.bak sibling
  writeFileSync(join(patigame, ".env.local.bak"), "BACKUP_SECRET=should-not-copy\n");
  const excludePath = join(resolvedA.gitCommonDir, "info", "exclude");
  writeFileSync(excludePath, `${readFileSync(excludePath, "utf8")}.env.local.bak\n`);
  assert.equal(runGit(["status", "--porcelain"], patigame), "");
  const worktree = prepareTaskWorktree({
    stateDir: join(home1, "plugin-state", "paseo-factory"),
    workspace: patigame,
    task: "env-local-ride",
  });
  assert.ok(worktree.ok, `worktree failed: ${worktree.ok ? "" : worktree.reason}`);
  assert.equal(readFileSync(join(worktree.path, ".env.local"), "utf8"), envLocalBody);
  assert.equal(existsSync(join(worktree.path, ".env.local.bak")), false, ".env.local.bak must not match exact .env.local rule");
  assert.equal(runGit(["status", "--porcelain"], worktree.path), "");

  // 2. Passphrase-backed (aes-256-gcm) mode + pull onto a second machine
  const bareEnc = makeBareRemote(t);
  seedBareRemote(t, bareEnc, { "README.md": "vault\n" });
  const homeEnc1 = makeTempDir();
  disposeDir(t, homeEnc1);
  saveVaultConfig(homeEnc1, { repo: bareEnc, nodeId: "mac-studio", passphrase: "correct-horse-battery" });
  writeProjectRegistration(join(homeEnc1, "plugin-state", "paseo-factory"), resolvedA.slug, { root: patigame });

  const importedEnc = await withVaultEnv(undefined, () =>
    importVaultSecrets(homeEnc1, { appKey: "patigame", envLocalPath }),
  );
  assert.equal(importedEnc.synced?.pushed, true);

  const probeEnc = makeTempDir();
  disposeDir(t, probeEnc);
  runGit(["clone", bareEnc, probeEnc]);
  const remoteEncRaw = readFileSync(join(probeEnc, "secrets", "apps", "patigame", ".env.local"));
  assert.equal(parseEnvelope(remoteEncRaw)?.mode, "aes-256-gcm");
  assert.ok(!remoteEncRaw.toString("utf8").includes("sk-test-env-local-98765"));
  assert.throws(() => unsealVaultBuffer(remoteEncRaw), factoryErrorCode("vault-passphrase-required"));
  assert.equal(unsealVaultBuffer(remoteEncRaw, "correct-horse-battery").toString("utf8"), envLocalBody);

  const patigameB = join(parent, "machine-b", "patigame");
  mkdirSync(dirname(patigameB), { recursive: true });
  runGit(["clone", "-q", patigame, patigameB]);
  const resolvedB = resolveProject(patigameB);
  assert.ok(resolvedB.ok);

  const homeEnc2 = makeTempDir();
  disposeDir(t, homeEnc2);
  saveVaultConfig(homeEnc2, { repo: bareEnc, nodeId: "runner-mac", passphrase: "correct-horse-battery" });
  writeProjectRegistration(join(homeEnc2, "plugin-state", "paseo-factory"), resolvedB.slug, { root: patigameB });
  await withVaultEnv(undefined, () => pullVault(homeEnc2));
  assert.equal(readFileSync(join(patigameB, ".env.local"), "utf8"), envLocalBody);
  assert.equal(modeOf(join(patigameB, ".env.local")), 0o600);
  assert.equal(runGit(["status", "--porcelain"], patigameB), "");
});

test("pushVault auto-seals runtime secrets/apps/<app>/.env.local idempotently without double-sealing or empty-commit churn", async (t) => {
  for (const passphrase of [undefined, "vault-pass-env-local"]) {
    const bare = makeBareRemote(t);
    seedBareRemote(t, bare, { "README.md": "vault\n" });
    const home = makeTempDir();
    disposeDir(t, home);
    saveVaultConfig(home, { repo: bare, nodeId: "mac-studio", ...(passphrase ? { passphrase } : {}) });

    const runtimeEnvLocal = join(home, "vault-runtime", "secrets", "apps", "patigame", ".env.local");
    mkdirSync(dirname(runtimeEnvLocal), { recursive: true });
    const plainV1 = "API_URL=https://v1.example.invalid\nSECRET=s3cr3t-v1\n";
    writeFileSync(runtimeEnvLocal, plainV1, { mode: 0o600 });

    const firstPush = await withVaultEnv(undefined, () => pushVault(home));
    assert.equal(firstPush.pushed, true);
    const headAfterFirst = bareHead(bare);

    const probe = makeTempDir();
    disposeDir(t, probe);
    runGit(["clone", bare, probe]);
    const remoteRaw = readFileSync(join(probe, "secrets", "apps", "patigame", ".env.local"));
    assert.equal(parseEnvelope(remoteRaw)?.mode, passphrase ? "aes-256-gcm" : "obfuscated");
    assert.ok(!remoteRaw.toString("utf8").includes("s3cr3t-v1"));
    assert.equal(unsealVaultBuffer(remoteRaw, passphrase).toString("utf8"), plainV1);

    // No-op pull -> push cycle leaves remote tip unchanged
    await withVaultEnv(undefined, () => pullVault(home));
    const noopPush = await withVaultEnv(undefined, () => pushVault(home));
    assert.equal(noopPush.pushed, false);
    assert.equal(bareHead(bare), headAfterFirst);

    // Pre-sealed envelope in vault-runtime is never double-sealed
    const preSealed = Buffer.from(`${JSON.stringify(sealVaultBuffer(Buffer.from(plainV1, "utf8"), passphrase))}\n`, "utf8");
    writeFileSync(runtimeEnvLocal, preSealed, { mode: 0o600 });
    const preSealedPush = await withVaultEnv(undefined, () => pushVault(home));
    assert.equal(preSealedPush.pushed, false);
    assert.equal(bareHead(bare), headAfterFirst);

    // Updated plaintext re-seals cleanly
    const plainV2 = "API_URL=https://v2.example.invalid\nSECRET=s3cr3t-v2\n";
    writeFileSync(runtimeEnvLocal, plainV2, { mode: 0o600 });
    const secondPush = await withVaultEnv(undefined, () => pushVault(home));
    assert.equal(secondPush.pushed, true);
    const probe2 = makeTempDir();
    disposeDir(t, probe2);
    runGit(["clone", bare, probe2]);
    const remoteRaw2 = readFileSync(join(probe2, "secrets", "apps", "patigame", ".env.local"));
    assert.equal(parseEnvelope(remoteRaw2)?.mode, passphrase ? "aes-256-gcm" : "obfuscated");
    assert.equal(unsealVaultBuffer(remoteRaw2, passphrase).toString("utf8"), plainV2);
  }
});

test("importVaultSecrets and writeBackAndroidKeystore reject multi-segment, traversal, backslash, and blank/whitespace appKeys with vault-invalid-path without writing or pushing", async (t) => {
  const srcDir = makeTempDir();
  disposeDir(t, srcDir);
  const envLocalPath = join(srcDir, ".env.local");
  writeFileSync(envLocalPath, "TOP_SECRET_TOKEN=must-never-hit-remote\n");
  const ksPath = join(srcDir, "release.keystore");
  writeFileSync(ksPath, randomBytes(128));

  const appRepo = join(makeProjectParent(t), "safe-repo");
  mkdirSync(appRepo, { recursive: true });
  writeFileSync(join(appRepo, "README.md"), "safe-repo\n");
  gitCommitAll(appRepo);

  const { writeBackAndroidKeystore } = await import("../src/vault.ts");

  for (const badAppKey of ["org/patigame", "../escape", "foo\\bar", ".", "..", "", "   "]) {
    const bare = makeBareRemote(t);
    seedBareRemote(t, bare, { "README.md": "vault\n" });
    const initialHead = bareHead(bare);

    const home = makeTempDir();
    disposeDir(t, home);
    saveVaultConfig(home, { repo: bare, nodeId: "mac-studio" });

    await assert.rejects(
      () => withVaultEnv(undefined, () => importVaultSecrets(home, { appKey: badAppKey, envLocalPath })),
      factoryErrorCode("vault-invalid-path"),
    );
    assert.equal(existsSync(join(home, "vault-runtime")), false, `importVaultSecrets must not create vault-runtime for ${JSON.stringify(badAppKey)}`);
    assert.equal(bareHead(bare), initialHead, `importVaultSecrets must not push to remote for ${JSON.stringify(badAppKey)}`);

    await assert.rejects(
      () =>
        withVaultEnv(undefined, () =>
          writeBackAndroidKeystore(home, { projectRoot: appRepo, keystorePath: ksPath, appKey: badAppKey }),
        ),
      factoryErrorCode("vault-invalid-path"),
    );
    assert.equal(existsSync(join(home, "vault-runtime")), false, `writeBackAndroidKeystore must not create vault-runtime for ${JSON.stringify(badAppKey)}`);
    assert.equal(bareHead(bare), initialHead, `writeBackAndroidKeystore must not push to remote for ${JSON.stringify(badAppKey)}`);
  }

  // Also reject unsafe appKey sourced from .store-release/manifest.json when input.appKey is omitted
  for (const badManifestKey of ["org/patigame", "../escape", "foo\\bar", ".", "..", "   "]) {
    const badManifestRepo = join(makeProjectParent(t), "manifest-bad-key");
    mkdirSync(join(badManifestRepo, ".store-release"), { recursive: true });
    writeFileSync(join(badManifestRepo, "README.md"), "manifest-bad-key\n");
    writeFileSync(join(badManifestRepo, ".store-release", "manifest.json"), JSON.stringify({ appKey: badManifestKey }));
    gitCommitAll(badManifestRepo);

    const bare2 = makeBareRemote(t);
    seedBareRemote(t, bare2, { "README.md": "vault\n" });
    const initialHead2 = bareHead(bare2);
    const home2 = makeTempDir();
    disposeDir(t, home2);
    saveVaultConfig(home2, { repo: bare2, nodeId: "mac-studio" });

    await assert.rejects(
      () =>
        withVaultEnv(undefined, () =>
          writeBackAndroidKeystore(home2, { projectRoot: badManifestRepo, keystorePath: ksPath }),
        ),
      factoryErrorCode("vault-invalid-path"),
    );
    assert.equal(existsSync(join(home2, "vault-runtime")), false);
    assert.equal(bareHead(bare2), initialHead2);
  }
});

test("collectLocalStateIntoRuntime and importVaultSecrets({ ascKeyPath }) reject unsafe .store-release/manifest.json appKeys with vault-invalid-path without pushing", async (t) => {
  const srcDir = makeTempDir();
  disposeDir(t, srcDir);
  const ascKeyPath = join(srcDir, "AuthKey_TEST.p8");
  writeFileSync(ascKeyPath, "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n");

  for (const badManifestKey of ["org/patigame", "../escape", "foo\\bar", ".", "..", "   "]) {
    const repo = join(makeProjectParent(t), "unsafe-manifest-collect");
    mkdirSync(join(repo, ".store-release"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "unsafe manifest\n");
    writeFileSync(join(repo, ".store-release", "manifest.json"), JSON.stringify({ appKey: badManifestKey }));
    gitCommitAll(repo);
    const resolved = resolveProject(repo);
    assert.ok(resolved.ok);

    // 1. Direct collectLocalStateIntoRuntime must reject before writing config/apps or vault.manifest.json
    const homeDirect = makeTempDir();
    disposeDir(t, homeDirect);
    writeProjectRegistration(join(homeDirect, "plugin-state", "paseo-factory"), resolved.slug, { root: repo });
    assert.throws(
      () => collectLocalStateIntoRuntime(homeDirect),
      factoryErrorCode("vault-invalid-path"),
    );
    assert.equal(existsSync(join(homeDirect, "vault-runtime", "config", "apps")), false, `config/apps must not be written for ${JSON.stringify(badManifestKey)}`);
    assert.equal(existsSync(join(homeDirect, "vault-runtime", "vault.manifest.json")), false, `vault.manifest.json must not be written for ${JSON.stringify(badManifestKey)}`);

    // 2. importVaultSecrets({ ascKeyPath }) (triggers syncVault -> collectLocalStateIntoRuntime) must reject and leave remote untouched
    const bare = makeBareRemote(t);
    seedBareRemote(t, bare, { "README.md": "vault\n" });
    const initialHead = bareHead(bare);

    const homeImport = makeTempDir();
    disposeDir(t, homeImport);
    saveVaultConfig(homeImport, { repo: bare, nodeId: "mac-studio" });
    writeProjectRegistration(join(homeImport, "plugin-state", "paseo-factory"), resolved.slug, { root: repo });

    await assert.rejects(
      () => withVaultEnv(undefined, () => importVaultSecrets(homeImport, { ascKeyPath })),
      factoryErrorCode("vault-invalid-path"),
    );
    assert.equal(bareHead(bare), initialHead, `importVaultSecrets({ ascKeyPath }) must not push unsafe manifest appKey ${JSON.stringify(badManifestKey)}`);
  }
});

function listAllFilesRecursive(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit(root);
  return out;
}

test("writeRuntimeFile and writeVaultRuntimeEnv write atomically with exact modes and zero leftover temp files", (t) => {
  const home = makeTempDir();
  disposeDir(t, home);

  writeRuntimeFile(home, "store-memory/lessons.md", Buffer.from("# v1\n", "utf8"));
  const lessonsPath = join(home, "vault-runtime", "store-memory", "lessons.md");
  assert.equal(modeOf(lessonsPath), 0o400);

  // Overwrite pre-existing 0o400 file without EACCES
  writeRuntimeFile(home, "store-memory/lessons.md", Buffer.from("# v2\n", "utf8"));
  assert.equal(readFileSync(lessonsPath, "utf8"), "# v2\n");
  assert.equal(modeOf(lessonsPath), 0o400);

  writeRuntimeFile(home, "secrets/shared/asc-credentials.json", Buffer.from('{"keyId":"K1","issuerId":"I1"}\n', "utf8"));
  assert.equal(modeOf(join(home, "vault-runtime", "secrets", "shared", "asc-credentials.json")), 0o600);

  writeRuntimeFile(home, "store-defaults.json", Buffer.from('{"organizationName":"Synth"}\n', "utf8"));
  assert.equal(modeOf(join(home, "vault-runtime", "store-defaults.json")), 0o600);

  writeRuntimeFile(home, "config/lanes.json", Buffer.from('{"worker":"pi"}\n', "utf8"));
  assert.equal(modeOf(join(home, "vault-runtime", "config", "lanes.json")), 0o644);

  writeVaultRuntimeEnv(home);
  const envPath = join(home, "vault-runtime", "env.json");
  assert.equal(modeOf(envPath), 0o600);
  assert.equal(JSON.parse(readFileSync(envPath, "utf8")).ASC_KEY_ID, "K1");

  const leftoverTmp = listAllFilesRecursive(join(home, "vault-runtime")).filter((p) => p.endsWith(".tmp"));
  assert.deepEqual(leftoverTmp, []);
});

test("materializeProjectVaultFiles and hydrateVaultDirect({ projectDir, appKey }) isolate target checkout, resolve subdirs/symlinks, and fail closed before runner", async (t) => {
  const parent = makeProjectParent(t);
  const regClone = join(parent, "registered", "patigame");
  mkdirSync(regClone, { recursive: true });
  writeFileSync(join(regClone, "README.md"), "registered patigame\n");
  gitCommitAll(regClone);
  const regResolved = resolveProject(regClone);
  assert.ok(regResolved.ok);

  // Unregistered runner checkout matching via gitRemote
  const unregDir = join(parent, "runner-workspace", "work-checkout");
  mkdirSync(unregDir, { recursive: true });
  writeFileSync(join(unregDir, "README.md"), "runner checkout\n");
  gitCommitAll(unregDir);
  runGit(["remote", "add", "origin", "https://github.com/daymanondev/patigame.git"], unregDir);

  // Unmatched checkout for explicit appKey & unmatched omission test
  const customDir = join(parent, "custom-workspace", "unrelated-name");
  mkdirSync(customDir, { recursive: true });
  writeFileSync(join(customDir, "README.md"), "custom checkout\n");
  gitCommitAll(customDir);

  const subDir = join(unregDir, "packages", "mobile");
  mkdirSync(subDir, { recursive: true });
  const symlinkDir = join(parent, "runner-symlink");
  symlinkSync(unregDir, symlinkDir);

  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: "owner/factory-vault", nodeId: "runner-mac" });
  writeProjectRegistration(join(home, "plugin-state", "paseo-factory"), regResolved.slug, { root: regClone });

  const ksBytes = randomBytes(128);
  const tar = buildTarball([
    {
      path: "owner-factory-vault-abc1234/vault.manifest.json",
      data: JSON.stringify({ patigame: { repoBasename: "patigame", gitRemote: "git@github.com:daymanondev/patigame.git" } }),
    },
    { path: "owner-factory-vault-abc1234/secrets/apps/patigame/.env.local", data: "APP_ENV=runner\n" },
    { path: "owner-factory-vault-abc1234/secrets/apps/patigame/release.keystore", data: ksBytes },
    { path: "owner-factory-vault-abc1234/secrets/apps/patigame/signing.json", data: JSON.stringify({ storePassword: "pw", keyAlias: "upload" }) },
    { path: "owner-factory-vault-abc1234/secrets/apps/patigame/google-services.json", data: '{"project_info":{"project_id":"p1"}}\n' },
    { path: "owner-factory-vault-abc1234/secrets/apps/patigame/GoogleService-Info.plist", data: "<plist/>\n" },
    { path: "owner-factory-vault-abc1234/config/lanes.json", data: "{}\n" },
  ]);

  // Non-git, empty projectDir, and unsafe appKey fail BEFORE runner is invoked
  const nonGitDir = makeTempDir();
  disposeDir(t, nonGitDir);
  let runnerCalls = 0;
  const countingRunner: VaultRunner = async () => {
    runnerCalls += 1;
    return tar;
  };
  for (const badProject of [nonGitDir, "", "   "]) {
    await assert.rejects(
      () => hydrateVaultDirect(home, { projectDir: badProject, runner: countingRunner }),
      factoryErrorCode("vault-project-not-git"),
    );
  }
  for (const badAppKey of ["../escape", "org/app", "foo\\bar", ".", "..", "", "   "]) {
    await assert.rejects(
      () => hydrateVaultDirect(home, { projectDir: customDir, appKey: badAppKey, runner: countingRunner }),
      factoryErrorCode("vault-invalid-path"),
    );
  }
  assert.equal(runnerCalls, 0, "validation failures must occur before calling runner");

  // Unmatched checkout with omitted appKey returns []
  const unmatchedRes = await hydrateVaultDirect(home, { projectDir: customDir, runner: countingRunner });
  assert.deepEqual(unmatchedRes.materializedProjectFiles, []);
  assert.equal(existsSync(join(customDir, ".env.local")), false);

  // Hydrate via subdirectory -> resolves to canonical unregDir root and leaves regClone untouched
  const subRes = await hydrateVaultDirect(home, { projectDir: subDir, runner: countingRunner });
  assert.deepEqual(subRes.materializedProjectFiles, [
    "android/app/release.keystore",
    "android/keystore.properties",
    "android/app/google-services.json",
    "ios/GoogleService-Info.plist",
    ".env.local",
  ]);
  for (const rel of subRes.materializedProjectFiles!) {
    assert.equal(modeOf(join(unregDir, rel)), 0o600);
  }
  assert.equal(runGit(["status", "--porcelain"], unregDir), "");
  assert.equal(existsSync(join(regClone, ".env.local")), false, "unrelated registered clone must remain untouched");
  assert.equal(existsSync(join(regClone, "android")), false, "unrelated registered clone must not receive android secrets");

  // Symlink path also resolves cleanly to unregDir
  const symFiles = materializeProjectVaultFiles(home, symlinkDir);
  assert.deepEqual(symFiles, subRes.materializedProjectFiles);

  // Explicit appKey materializes into unmatched customDir
  const explicitRes = await hydrateVaultDirect(home, { projectDir: customDir, appKey: "  patigame  ", runner: countingRunner });
  assert.deepEqual(explicitRes.materializedProjectFiles, subRes.materializedProjectFiles);
  assert.equal(readFileSync(join(customDir, ".env.local"), "utf8"), "APP_ENV=runner\n");
  assert.equal(modeOf(join(customDir, ".env.local")), 0o600);
  assert.equal(runGit(["status", "--porcelain"], customDir), "");
  assert.equal(existsSync(join(regClone, ".env.local")), false);
});

test("hydrateVaultDirect runtimeOnly bypasses live LedgerAdmission lock and writes zero plugin-state files while standard hydrate still refuses", async (t) => {
  const parent = makeProjectParent(t);
  const runnerCheckout = join(parent, "runner-repo");
  mkdirSync(runnerCheckout, { recursive: true });
  writeFileSync(join(runnerCheckout, "README.md"), "runner\n");
  gitCommitAll(runnerCheckout);

  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: "owner/factory-vault", nodeId: "runner-mac" });
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const configPath = join(stateDir, "vault-config.json");
  const configBefore = readFileSync(configPath);

  // Live holder process owning ledger-owner.json (distinct PID -> assertAvailable detects live owner)
  const holder = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => {
    try {
      holder.kill("SIGKILL");
    } catch {
      // ignore if already exited
    }
  });
  const ownerPath = join(stateDir, "ledger-owner.json");
  const ownerPayload = JSON.stringify({
    version: 1,
    pid: holder.pid,
    token: "live-daemon-token",
    target: join(stateDir, "ledger.jsonl"),
    startedAt: new Date().toISOString(),
  });
  writeFileSync(ownerPath, ownerPayload);

  const tar = buildTarball([
    { path: "owner-factory-vault-abc1234/secrets/shared/asc-credentials.json", data: '{"keyId":"K_RUN","issuerId":"I_RUN","teamId":"T_RUN"}\n' },
    { path: "owner-factory-vault-abc1234/secrets/apps/patigame/.env.local", data: "RUNNER_SECRET=ok\n" },
    { path: "owner-factory-vault-abc1234/store-memory/lessons.md", data: "# Runtime lesson\n" },
    { path: "owner-factory-vault-abc1234/config/lanes.json", data: '{"worker":"pi"}\n' },
  ]);
  let runnerCalls = 0;
  const countingRunner: VaultRunner = async () => {
    runnerCalls += 1;
    return tar;
  };

  // Incompatible combinations fail BEFORE calling runner
  await assert.rejects(
    () => hydrateVaultDirect(home, { runtimeOnly: true, mergeLedgers: true, runner: countingRunner }),
    factoryErrorCode("vault-incompatible-options"),
  );
  await assert.rejects(
    () => hydrateVaultDirect(home, { runtimeOnly: true, overwriteConfigs: true, runner: countingRunner }),
    factoryErrorCode("vault-incompatible-options"),
  );
  await assert.rejects(
    () => hydrateVaultDirect(home, { runtimeOnly: true, appKey: "patigame", runner: countingRunner }),
    factoryErrorCode("vault-incompatible-options"),
  );
  assert.equal(runnerCalls, 0);

  // Standard hydrateVaultDirect still fails closed with vault-owner-required
  await assert.rejects(
    () => hydrateVaultDirect(home, { runner: countingRunner }),
    factoryErrorCode("vault-owner-required"),
  );

  // runtimeOnly succeeds under the active lock, writes runtime + env.json + projectDir, and touches zero plugin-state files
  const res = await hydrateVaultDirect(home, {
    runtimeOnly: true,
    projectDir: runnerCheckout,
    appKey: "patigame",
    runner: countingRunner,
  });
  assert.equal(res.repo, "owner/factory-vault");
  assert.equal(res.ref, "main");
  assert.deepEqual(res.materializedProjectFiles, [".env.local"]);
  assert.equal(readFileSync(join(runnerCheckout, ".env.local"), "utf8"), "RUNNER_SECRET=ok\n");
  assert.equal(modeOf(join(runnerCheckout, ".env.local")), 0o600);
  assert.equal(runGit(["status", "--porcelain"], runnerCheckout), "");
  assert.equal(modeOf(join(home, "vault-runtime", "store-memory", "lessons.md")), 0o400);
  assert.equal(modeOf(join(home, "vault-runtime", "env.json")), 0o600);
  assert.equal(JSON.parse(readFileSync(join(home, "vault-runtime", "env.json"), "utf8")).ASC_KEY_ID, "K_RUN");
  assert.deepEqual(readFileSync(configPath), configBefore, "vault-config.json must stay byte-identical");
  assert.equal(readFileSync(ownerPath, "utf8"), ownerPayload, "ledger-owner.json must stay intact");
  assert.equal(existsSync(join(stateDir, "lanes.json")), false);
  assert.equal(existsSync(join(stateDir, "imports")), false);
  assert.deepEqual(
    readdirSync(stateDir).sort(),
    ["ledger-owner.json", "vault-config.json"],
    "plugin-state must receive zero writes during runtimeOnly",
  );

  // Fresh home with no vault-config.json + explicit repo + active lock: succeeds and does NOT create vault-config.json
  const freshHome = makeTempDir();
  disposeDir(t, freshHome);
  const freshState = join(freshHome, "plugin-state", "paseo-factory");
  mkdirSync(freshState, { recursive: true });
  writeFileSync(join(freshState, "ledger-owner.json"), ownerPayload);
  const freshRes = await hydrateVaultDirect(freshHome, {
    repo: "owner/factory-vault",
    runtimeOnly: true,
    runner: countingRunner,
  });
  assert.deepEqual(freshRes.materializedProjectFiles, []);
  assert.equal(existsSync(join(freshState, "vault-config.json")), false, "runtimeOnly must not create vault-config.json");
});

test("prototype-key collision guard rejects __proto__, constructor, and prototype across appKey entry points and manifest lookups", async (t) => {
  const protoKeys = ["constructor", "__proto__", "prototype", "  constructor  "] as const;
  const srcDir = makeTempDir();
  disposeDir(t, srcDir);
  const envLocalPath = join(srcDir, ".env.local");
  writeFileSync(envLocalPath, "SECRET_TOKEN=proto-guard\n");
  const ksPath = join(srcDir, "release.keystore");
  writeFileSync(ksPath, randomBytes(128));

  const safeRepo = join(makeProjectParent(t), "proto-safe-repo");
  mkdirSync(safeRepo, { recursive: true });
  writeFileSync(join(safeRepo, "README.md"), "safe\n");
  gitCommitAll(safeRepo);

  const { writeBackAndroidKeystore } = await import("../src/vault.ts");

  let runnerCalls = 0;
  const countingRunner: VaultRunner = async () => {
    runnerCalls += 1;
    return buildTarball([{ path: "owner-factory-vault-abc1234/config/lanes.json", data: "{}\n" }]);
  };

  for (const protoKey of protoKeys) {
    const bare = makeBareRemote(t);
    seedBareRemote(t, bare, { "README.md": "vault\n" });
    const initialHead = bareHead(bare);

    const home = makeTempDir();
    disposeDir(t, home);
    saveVaultConfig(home, { repo: bare, nodeId: "mac-studio" });

    // 1. importVaultSecrets rejects with vault-invalid-path and writes nothing
    await assert.rejects(
      () => withVaultEnv(undefined, () => importVaultSecrets(home, { appKey: protoKey, envLocalPath })),
      factoryErrorCode("vault-invalid-path"),
      `importVaultSecrets must reject ${JSON.stringify(protoKey)}`,
    );
    assert.equal(existsSync(join(home, "vault-runtime")), false);
    assert.equal(bareHead(bare), initialHead);

    // 2. writeBackAndroidKeystore rejects with vault-invalid-path and writes nothing
    await assert.rejects(
      () =>
        withVaultEnv(undefined, () =>
          writeBackAndroidKeystore(home, { projectRoot: safeRepo, keystorePath: ksPath, appKey: protoKey }),
        ),
      factoryErrorCode("vault-invalid-path"),
      `writeBackAndroidKeystore must reject ${JSON.stringify(protoKey)}`,
    );
    assert.equal(existsSync(join(home, "vault-runtime")), false);
    assert.equal(bareHead(bare), initialHead);

    // 3. hydrateVaultDirect and materializeProjectVaultFiles reject before calling runner
    await assert.rejects(
      () => hydrateVaultDirect(home, { projectDir: safeRepo, appKey: protoKey, runner: countingRunner }),
      factoryErrorCode("vault-invalid-path"),
      `hydrateVaultDirect must reject ${JSON.stringify(protoKey)}`,
    );
    assert.throws(
      () => materializeProjectVaultFiles(home, safeRepo, protoKey),
      factoryErrorCode("vault-invalid-path"),
      `materializeProjectVaultFiles must reject ${JSON.stringify(protoKey)}`,
    );

    // 4. storeAppNotebookPath rejects reserved prototype keys
    assert.throws(
      () => storeAppNotebookPath(home, protoKey),
      factoryErrorCode("vault-invalid-path"),
      `storeAppNotebookPath must reject ${JSON.stringify(protoKey)}`,
    );
  }
  assert.equal(runnerCalls, 0, "unsafe prototype appKeys must fail before invoking runner");

  // 5. collectLocalStateIntoRuntime & writeBackAndroidKeystore reject prototype keys from .store-release/manifest.json and repo basename
  for (const rawKey of ["constructor", "__proto__", "prototype"] as const) {
    // (a) .store-release/manifest.json appKey
    const manifestRepo = join(makeProjectParent(t), `manifest-${rawKey === "__proto__" ? "proto" : rawKey}`);
    mkdirSync(join(manifestRepo, ".store-release"), { recursive: true });
    writeFileSync(join(manifestRepo, "README.md"), "repo\n");
    writeFileSync(join(manifestRepo, ".store-release", "manifest.json"), JSON.stringify({ appKey: rawKey }));
    gitCommitAll(manifestRepo);
    const resolvedManifest = resolveProject(manifestRepo);
    assert.ok(resolvedManifest.ok);

    const homeCollect = makeTempDir();
    disposeDir(t, homeCollect);
    writeProjectRegistration(join(homeCollect, "plugin-state", "paseo-factory"), resolvedManifest.slug, { root: manifestRepo });
    assert.throws(() => collectLocalStateIntoRuntime(homeCollect), factoryErrorCode("vault-invalid-path"));
    assert.equal(existsSync(join(homeCollect, "vault-runtime", "vault.manifest.json")), false);

    // (b) repo directory literally named constructor / __proto__ / prototype (basename fallback)
    const namedParent = makeProjectParent(t);
    const namedRepo = join(namedParent, rawKey);
    mkdirSync(join(namedRepo, ".store-release"), { recursive: true });
    writeFileSync(join(namedRepo, "README.md"), "named repo\n");
    writeFileSync(join(namedRepo, ".store-release", "manifest.json"), JSON.stringify({ bundleId: "com.example.proto" }));
    gitCommitAll(namedRepo);
    const resolvedNamed = resolveProject(namedRepo);
    assert.ok(resolvedNamed.ok);

    const homeNamed = makeTempDir();
    disposeDir(t, homeNamed);
    writeProjectRegistration(join(homeNamed, "plugin-state", "paseo-factory"), resolvedNamed.slug, { root: namedRepo });
    assert.throws(() => collectLocalStateIntoRuntime(homeNamed), factoryErrorCode("vault-invalid-path"));

    const homeWb = makeTempDir();
    disposeDir(t, homeWb);
    await assert.rejects(
      () => withVaultEnv(undefined, () => writeBackAndroidKeystore(homeWb, { projectRoot: namedRepo, keystorePath: ksPath, syncAfterWriteBack: false })),
      factoryErrorCode("vault-invalid-path"),
    );
    assert.equal(existsSync(join(homeWb, "vault-runtime")), false);

    // 6. parseVaultManifest rejects poisoned vault.manifest.json entries without polluting Object.prototype
    const poisonedJson = `{"${rawKey}": {"repoBasename": "evil"}}`;
    assert.throws(() => parseVaultManifest(poisonedJson), factoryErrorCode("corrupted-vault-manifest"));
    assert.equal(Object.hasOwn(Object.prototype, "repoBasename"), false);
  }

  // 7. Direct manifest lookup helpers never collide with Object.prototype keys on an empty manifest
  const emptyHome = makeTempDir();
  disposeDir(t, emptyHome);
  const emptyManifest = readVaultManifestAt(emptyHome);
  assert.deepEqual(emptyManifest, {});
  assert.deepEqual(resolveVaultApps(emptyHome, emptyManifest), []);
  assert.equal(
    matchManifestAppKey(emptyManifest, {
      root: safeRepo,
      slug: "safe",
      basename: "constructor",
      originUrl: null,
      bundleId: null,
      packageName: null,
    }),
    null,
  );
});
