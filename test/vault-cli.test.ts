import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  hydrateVaultDirect,
  loadVaultConfig,
  pullVault,
  readVaultStatus,
  saveVaultConfig,
  sealVaultBuffer,
  unsealVaultBuffer,
} from "../src/index.ts";
import type { VaultRunner } from "../src/index.ts";
import {
  sealVaultBuffer as sealVaultBufferMjs,
  unsealVaultBuffer as unsealVaultBufferMjs,
} from "../plugin/bin/vault.mjs";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

/**
 * `factory vault status | hydrate | pull | push | seal` — the Private vault's
 * CLI (v0.0.21, ADR 0014; spec §User Story 11: the CLI is a public seam, all
 * output structured JSON). Two test families live here:
 *
 * 1. The verb tests spawn plugin/bin/factory.mjs against real temp homes —
 *    `gh` shimmed onto a private PATH for Direct hydrate, local bare git
 *    remotes for the sync verbs — zero network, zero `~/.paseo`.
 * 2. The drift guards pin the CLI's engine mirror (plugin/bin/vault.mjs —
 *    ADR 0004: the CLIs import no src/ code) to the core engine: envelopes
 *    round-trip byte-for-byte across the two implementations, `vault status`
 *    prints exactly `readVaultStatus`'s view, and the CLI's hydrate/pull land
 *    the same `vault-runtime` tree the core's transports land — the
 *    test/status.test.ts EVENT_NAMES guard's model.
 */

const factoryCli = join(repoRoot, "plugin", "bin", "factory.mjs");

/** A Google Cloud Service Account JSON stand-in — the file class GitHub Secret Scanning revokes. */
const GCP_SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "patigame-prod",
  private_key_id: "d1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n",
  client_email: "deploy@patigame-prod.iam.gserviceaccount.com",
});

/** Two plausible ledger lines — push's --include-ledger snapshot moves them verbatim. */
const LEDGER_LINES = [
  JSON.stringify({ seq: 1, ts: "2026-10-20T09:00:00.000Z", event: "contract_set", task: "t01", base: "e5b52cc", done: ["gate"] }),
  JSON.stringify({ seq: 2, ts: "2026-10-20T09:05:00.000Z", event: "claim_reported", task: "t01", attempt: 1, agent: "pi", sha: "8fd67b4" }),
].join("\n") + "\n";

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawns the Owner CLI with a hermetic vault env: `FACTORY_VAULT_PASSPHRASE`
 * never leaks from this process unless a test pins it, and `PATH` (the `gh`
 * shim) is overridable per call. Async on purpose — the verbs run real git
 * children.
 */
function runFactory(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name === "FACTORY_VAULT_PASSPHRASE") continue;
    childEnv[name] = value;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [factoryCli, ...args], { env: { ...childEnv, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** An executable `gh` stand-in on a private PATH: records argv, emits the fixture tarball. */
function makeGhShim(t: TestContext, tarball: Buffer): { binDir: string; argvPath: string } {
  const dir = makeTempDir("paseo-factory-vault-gh-");
  disposeDir(t, dir);
  const tarPath = join(dir, "fixture-tarball.tgz");
  writeFileSync(tarPath, tarball);
  const argvPath = join(dir, "argv.txt");
  const shim = join(dir, "gh");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvPath}"\ncat "${tarPath}"\n`);
  chmodSync(shim, 0o755);
  return { binDir: dir, argvPath };
}

// ---- local bare git fixtures (the test/vault.test.ts models) ------------------------------

/** One git invocation against a fixture — output captured, never inherited. */
function runGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A local bare remote, HEAD pinned to `branch`. */
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

// ---- in-memory tarball fixtures ------------------------------------------------------------

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

// ---- tree comparison (the hydrate/pull drift guards) ---------------------------------------

interface TreeEntry {
  data: Buffer;
  mode: number;
}

/** Every file under `root` as rel-path → {bytes, mode} — the whole-runtime drift comparison. */
function readTree(root: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const visit = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) visit(join(dir, entry.name), childRel);
      else if (entry.isFile()) {
        const path = join(dir, entry.name);
        out.set(childRel, { data: readFileSync(path), mode: statSync(path).mode & 0o777 });
      }
    }
  };
  visit(root, "");
  return out;
}

function assertTreesEqual(left: Map<string, TreeEntry>, right: Map<string, TreeEntry>, label: string): void {
  // env.json carries each home's own absolute paths — compared separately
  // under path normalization, never byte-for-byte across two homes
  const keysOf = (tree: Map<string, TreeEntry>): string[] => [...tree.keys()].filter((rel) => rel !== "env.json").sort();
  assert.deepEqual(keysOf(left), keysOf(right), `${label}: same file set`);
  for (const rel of keysOf(left)) {
    assert.deepEqual(left.get(rel)!.data, right.get(rel)!.data, `${label}: ${rel} lands byte-exact`);
    assert.equal(left.get(rel)!.mode, right.get(rel)!.mode, `${label}: ${rel} carries the same permissions`);
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** A mirror-side error predicate matching the core's FactoryError codes. */
function mirrorErrorCode(code: string): (err: unknown) => boolean {
  return (err: unknown): boolean => err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

/** Runs `fn` with FACTORY_VAULT_PASSPHRASE pinned to `value` (deleted when undefined), restoring after. */
function withVaultEnv<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.FACTORY_VAULT_PASSPHRASE;
  if (value === undefined) delete process.env.FACTORY_VAULT_PASSPHRASE;
  else process.env.FACTORY_VAULT_PASSPHRASE = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.FACTORY_VAULT_PASSPHRASE;
    else process.env.FACTORY_VAULT_PASSPHRASE = prior;
  }
}

// ---- the envelope drift guard (the mirror law's first pin) ---------------------------------

test("the mirror's envelopes round-trip byte-for-byte against the core on shared fixtures", () => {
  const payloads = [
    Buffer.from(GCP_SERVICE_ACCOUNT, "utf8"),
    Buffer.from("-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n", "utf8"),
    randomBytes(4096), // release.keystore bytes
    Buffer.from('{"lanes":{"default":"pi"}}', "utf8"),
  ];
  for (const plain of payloads) {
    // obfuscated sealing is deterministic — the two implementations agree byte-for-byte
    assert.equal(JSON.stringify(sealVaultBufferMjs(plain)), JSON.stringify(sealVaultBuffer(plain)), "the obfuscated seal is the same bytes from both implementations");
    // cross-mode round-trips: each implementation unseals what the other sealed
    assert.deepEqual(unsealVaultBuffer(Buffer.from(JSON.stringify(sealVaultBufferMjs(plain)), "utf8")), plain, "the core unseals the mirror's obfuscated envelope");
    assert.deepEqual(unsealVaultBufferMjs(Buffer.from(JSON.stringify(sealVaultBuffer(plain)), "utf8")), plain, "the mirror unseals the core's obfuscated envelope");
    assert.deepEqual(unsealVaultBuffer(Buffer.from(JSON.stringify(sealVaultBufferMjs(plain, "correct-horse-battery")), "utf8"), "correct-horse-battery"), plain, "the core unseals the mirror's aes-256-gcm envelope");
    assert.deepEqual(unsealVaultBufferMjs(Buffer.from(JSON.stringify(sealVaultBuffer(plain, "correct-horse-battery")), "utf8"), "correct-horse-battery"), plain, "the mirror unseals the core's aes-256-gcm envelope");
    // Plaintext Direct mode: non-envelope buffers come back unchanged through the mirror too
    assert.deepEqual(unsealVaultBufferMjs(plain), plain);
  }

  // the locked envelope's refusals carry the core's stable codes
  const locked = Buffer.from(JSON.stringify(sealVaultBuffer(Buffer.from("x", "utf8"), "correct-horse-battery")), "utf8");
  assert.throws(() => unsealVaultBufferMjs(locked), mirrorErrorCode("vault-passphrase-required"), "no passphrase anywhere refuses with the core's code");
  assert.throws(() => unsealVaultBufferMjs(locked, "wrong-horse"), mirrorErrorCode("vault-decrypt-failed"), "a wrong passphrase fails the auth tag with the core's code");
});

// ---- vault status: the pure local read, pinned to readVaultStatus --------------------------

test("factory vault status prints exactly readVaultStatus's view — a pure local read, no plugin running", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  const fresh = await runFactory(["--home", dir, "vault", "status"]);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(JSON.parse(fresh.stdout), readVaultStatus(dir), "a fresh home prints the core's own view");

  const home = join(dir, "home");
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
  mkdirSync(join(home, "vault-runtime", "secrets", "shared"), { recursive: true });
  writeFileSync(join(home, "vault-runtime", "secrets", "shared", "asc-api-key.p8"), "fixture");

  const configured = await runFactory(["--home", home, "vault", "status"]);
  assert.equal(configured.status, 0, configured.stderr);
  const view = JSON.parse(configured.stdout);
  assert.deepEqual(view, readVaultStatus(home), "no drift between the mirror's status JSON and the core's readVaultStatus");
  // the scripting contract: every VaultStatusView field is present and shaped
  assert.deepEqual(view, {
    configured: true,
    repo: "daymanondev/factory-vault",
    branch: "release",
    nodeId: "mac-studio",
    hasPassphrase: true,
    cloneExists: true,
    lastHydratedAt: "2026-10-20T10:00:00.000Z",
    lastHydrateMode: "direct",
    lastPushedAt: "2026-10-20T11:30:00.000Z",
    sharedSecrets: { ascKey: true, ascCredentials: false, gplayServiceAccount: false, eyeConfig: false },
    hydratedApps: [],
    ghInstalled: false,
    ghAuthenticated: false,
    ghUser: null,
    suggestedRepo: null,
    error: null,
  });
});

// ---- usage and validation failures through fail() -------------------------------------------

test("vault refuses bad usage through fail(): exit 2, usage on stderr, nothing on stdout", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const source = join(dir, "gplay.json");
  writeFileSync(source, GCP_SERVICE_ACCOUNT);

  const cases: Array<[string[], RegExp]> = [
    [["--home", dir, "vault"], /vault: a subcommand is required/],
    [["--home", dir, "vault", "bogus"], /vault: unknown subcommand "bogus"/],
    [["--home", dir, "vault", "status", "extra"], /vault status: unexpected positional "extra"/],
    [["--home", dir, "vault", "status", "--repo", "a/b"], /vault status: --repo is not a status option/],
    [["--home", dir, "vault", "hydrate", "extra"], /vault hydrate: unexpected positional "extra"/],
    [["--home", dir, "vault", "seal"], /vault seal: a file is required/],
    [["--home", dir, "vault", "seal", source], /vault seal: --to <vaultPath> is required/],
    [["--home", dir, "vault", "seal", source, "--to", ""], /vault seal: --to <vaultPath> is required/],
    [["--home", dir, "vault", "seal", source, "--to", "../escape"], /refusing unsafe vault path/],
    [["--home", dir, "vault", "seal", source, "--to", "secrets/../../x"], /refusing unsafe vault path/],
    [["--home", dir, "vault", "seal", join(dir, "no-such-file"), "--to", "secrets/shared/x"], /vault seal: .*no-such-file/],
  ];
  for (const [args, expected] of cases) {
    const result = await runFactory(args);
    assert.equal(result.status, 2, `${args.join(" ")}: expected exit 2\nstdout: ${result.stdout}`);
    assert.equal(result.stdout, "", `${args.join(" ")}: a usage failure prints nothing on stdout`);
    assert.match(result.stderr, expected, args.join(" "));
  }

  // the failure prints the usage — the vault stanza documents all five verbs
  const first = await runFactory(["--home", dir, "vault"]);
  assert.match(first.stderr, /vault status/);
  assert.match(first.stderr, /vault hydrate \[--repo <owner\/repo>\] \[--ref <ref>\]/);
  assert.match(first.stderr, /vault pull/);
  assert.match(first.stderr, /vault push \[--include-ledger\]/);
  assert.match(first.stderr, /vault seal <file> --to <vaultPath> \[--passphrase <pass>\]/);

  // and `factory --help` carries the same stanza, exit 0
  const help = await runFactory(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /vault seal <file> --to <vaultPath> \[--passphrase <pass>\]/);
});

test("vault hydrate refuses the honest engine failures: unconfigured repo, non-GitHub slug", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  const unconfigured = await runFactory(["--home", dir, "vault", "hydrate"]);
  assert.equal(unconfigured.status, 2, unconfigured.stderr);
  assert.equal(unconfigured.stdout, "", "an engine refusal prints no JSON");
  assert.match(unconfigured.stderr, /vault-not-configured/);

  const notGithub = await runFactory(["--home", dir, "vault", "hydrate", "--repo", "not-a-slug"]);
  assert.equal(notGithub.status, 2, notGithub.stderr);
  assert.match(notGithub.stderr, /vault-repo-not-github/);
});

// ---- vault hydrate: the zero-clone tarball stream through gh api ----------------------------

test("factory vault hydrate streams through gh api and lands the unsealed runtime tree — zero clone", async (t) => {
  const home = makeTempDir();
  disposeDir(t, home);
  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  const eyePlain = '{\n  "provider": "eye"\n}\n';
  const keystore = randomBytes(2048);
  const top = "daymanondev-factory-vault-abc1234";
  const tarball = buildTarball([
    { path: `${top}/secrets/shared/asc-api-key.p8`, data: p8 },
    { path: `${top}/secrets/shared/gplay-service-account.json`, data: JSON.stringify(sealVaultBuffer(Buffer.from(GCP_SERVICE_ACCOUNT, "utf8"))) },
    { path: `${top}/secrets/shared/eye.json`, data: JSON.stringify(sealVaultBuffer(Buffer.from(eyePlain, "utf8"), "correct-horse-battery")) },
    { path: `${top}/secrets/apps/patigame/release.keystore`, data: keystore },
    { path: `${top}/config/lanes.json`, data: JSON.stringify({ lanes: { default: "pi" } }) },
  ]);
  const { binDir, argvPath } = makeGhShim(t, tarball);

  const result = await runFactory(
    ["--home", home, "vault", "hydrate", "--repo", "daymanondev/factory-vault", "--ref", "v1.2.3"],
    { PATH: `${binDir}:${process.env.PATH ?? ""}`, FACTORY_VAULT_PASSPHRASE: "correct-horse-battery" },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "direct");
  assert.equal(payload.repo, "daymanondev/factory-vault");
  assert.equal(payload.ref, "v1.2.3");
  assert.deepEqual(payload.hydratedFiles, [
    "config/lanes.json",
    "secrets/apps/patigame/release.keystore",
    "secrets/shared/asc-api-key.p8",
    "secrets/shared/eye.json",
    "secrets/shared/gplay-service-account.json",
  ]);
  // the verb's vault view is the core's read of the same home under the same
  // passphrase env the CLI ran with (the hasPassphrase leg resolves it)
  assert.deepEqual(payload.vault, withVaultEnv("correct-horse-battery", () => readVaultStatus(home)), "the verb's vault view is the core's read of the same home");

  // the gh api call the mirror made: the requested ref, the machine's gh session
  assert.equal(readFileSync(argvPath, "utf8"), "api\nrepos/daymanondev/factory-vault/tarball/v1.2.3\n");

  // the runtime tree: unsealed bytes, the permission law, no checkout
  const runtime = join(home, "vault-runtime");
  assert.equal(readFileSync(join(runtime, "secrets/shared/asc-api-key.p8"), "utf8"), p8);
  assert.equal(readFileSync(join(runtime, "secrets/shared/gplay-service-account.json"), "utf8"), GCP_SERVICE_ACCOUNT, "the obfuscated envelope unseals zero-passphrase");
  assert.equal(readFileSync(join(runtime, "secrets/shared/eye.json"), "utf8"), eyePlain, "the locked envelope unseals through FACTORY_VAULT_PASSPHRASE");
  assert.deepEqual(readFileSync(join(runtime, "secrets/apps/patigame/release.keystore")), keystore);
  assert.equal(readFileSync(join(runtime, "config/lanes.json"), "utf8"), JSON.stringify({ lanes: { default: "pi" } }));
  assert.equal(modeOf(join(runtime, "secrets/shared/asc-api-key.p8")), 0o600);
  assert.equal(modeOf(join(runtime, "secrets/shared/eye.json")), 0o600);
  assert.equal(modeOf(join(runtime, "config/lanes.json")), 0o644, "non-secret tiers keep normal permissions");
  assert.ok(!existsSync(join(home, "vault")), "zero-clone: no .git checkout is left behind");

  const config = loadVaultConfig(home);
  assert.equal(config?.repo, "daymanondev/factory-vault");
  assert.equal(config?.lastHydrateMode, "direct");
  assert.ok(!Number.isNaN(Date.parse(config?.lastHydratedAt ?? "")), "lastHydratedAt is a real ISO stamp");
});

test("drift guard: the CLI's hydrate lands the same vault-runtime tree the core's hydrateVaultDirect lands", async (t) => {
  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  const top = "daymanondev-factory-vault-abc1234";
  const tarball = buildTarball([
    { path: `${top}/secrets/shared/asc-api-key.p8`, data: p8 },
    { path: `${top}/secrets/shared/asc-credentials.json`, data: JSON.stringify({ keyId: "K2XYZ123456", issuerId: "issuer-uuid-1" }) },
    { path: `${top}/secrets/shared/gplay-service-account.json`, data: JSON.stringify(sealVaultBuffer(Buffer.from(GCP_SERVICE_ACCOUNT, "utf8"))) },
    { path: `${top}/secrets/shared/eye.json`, data: JSON.stringify(sealVaultBuffer(Buffer.from('{\n  "provider": "eye"\n}\n', "utf8"), "correct-horse-battery")) },
    { path: `${top}/secrets/apps/patigame/release.keystore`, data: randomBytes(1024) },
    { path: `${top}/secrets/apps/patigame/signing.json`, data: JSON.stringify({ storePassword: "correct-horse-battery", keyAlias: "upload" }) },
    { path: `${top}/config/lanes.json`, data: JSON.stringify({ lanes: { default: "pi" } }) },
  ]);

  const homeCore = makeTempDir();
  disposeDir(t, homeCore);
  saveVaultConfig(homeCore, { repo: "daymanondev/factory-vault", passphrase: "correct-horse-battery" });
  const runner: VaultRunner = async (call) => {
    if (call.command === "gh") return tarball;
    throw new Error(`unexpected runner call: ${call.command}`);
  };
  await hydrateVaultDirect(homeCore, { runner });

  const homeCli = makeTempDir();
  disposeDir(t, homeCli);
  saveVaultConfig(homeCli, { repo: "daymanondev/factory-vault", passphrase: "correct-horse-battery" });
  const { binDir } = makeGhShim(t, tarball);
  const result = await runFactory(["--home", homeCli, "vault", "hydrate"], { PATH: `${binDir}:${process.env.PATH ?? ""}` });
  assert.equal(result.status, 0, result.stderr);

  assertTreesEqual(readTree(join(homeCore, "vault-runtime")), readTree(join(homeCli, "vault-runtime")), "hydrate");
  assert.equal(readVaultStatus(homeCli).lastHydrateMode, "direct");
  assert.deepEqual(readVaultStatus(homeCli).hydratedApps, ["patigame"], "the CLI's status probes see what the CLI's hydrate landed");
  // env.json (the zero-shell-config hand-off Release Lab reads) agrees — the
  // only legitimate difference is each home's own absolute path prefix
  const normalizeEnv = (home: string): string =>
    readFileSync(join(home, "vault-runtime", "env.json"), "utf8").split(home).join("<paseoHome>");
  assert.equal(normalizeEnv(homeCli), normalizeEnv(homeCore), "both hydrations derive the same env.json pointer index");
});

// ---- vault pull: the two-way cached git checkout --------------------------------------------

test("factory vault pull clones the configured remote, hydrates, and matches the core's pullVault tree", async (t) => {
  const bare = makeBareRemote(t);
  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  const keystore = randomBytes(512);
  seedBareRemote(t, bare, {
    "README.md": "vault\n",
    "secrets/shared/asc-api-key.p8": p8,
    "secrets/shared/gplay-service-account.json": JSON.stringify(sealVaultBuffer(Buffer.from(GCP_SERVICE_ACCOUNT, "utf8"))),
    "secrets/apps/patigame/release.keystore": keystore,
    "config/lanes.json": JSON.stringify({ lanes: { default: "pi" } }),
  });

  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: bare, nodeId: "mac-studio" });
  const result = await runFactory(["--home", home, "vault", "pull"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "sync");
  assert.deepEqual(payload.hydratedFiles, [
    "README.md",
    "config/lanes.json",
    "secrets/apps/patigame/release.keystore",
    "secrets/shared/asc-api-key.p8",
    "secrets/shared/gplay-service-account.json",
  ]);
  assert.deepEqual(payload.vault, readVaultStatus(home));
  assert.equal(payload.vault.cloneExists, true, "the sync transport leaves the cached checkout behind");
  assert.equal(payload.vault.lastHydrateMode, "sync");

  assert.ok(existsSync(join(home, "vault", ".git")), "the clone landed at <paseoHome>/vault");
  const runtime = join(home, "vault-runtime");
  assert.equal(readFileSync(join(runtime, "secrets/shared/asc-api-key.p8"), "utf8"), p8);
  assert.equal(readFileSync(join(runtime, "secrets/shared/gplay-service-account.json"), "utf8"), GCP_SERVICE_ACCOUNT, "envelopes unseal from the checkout");
  assert.deepEqual(readFileSync(join(runtime, "secrets/apps/patigame/release.keystore")), keystore);
  assert.equal(modeOf(join(runtime, "secrets/shared/asc-api-key.p8")), 0o600);
  assert.equal(modeOf(join(runtime, "config/lanes.json")), 0o644);

  // the drift half: the core's pullVault over a twin home lands the same tree
  const homeCore = makeTempDir();
  disposeDir(t, homeCore);
  saveVaultConfig(homeCore, { repo: bare, nodeId: "mac-studio" });
  await pullVault(homeCore);
  assertTreesEqual(readTree(join(homeCore, "vault-runtime")), readTree(join(home, "vault-runtime")), "pull");
});

// ---- vault push: packaging the runtime tree back to the remote ------------------------------

test("factory vault push packages the runtime tree, pushes, and rides envelopes verbatim; a clean tree pushes nothing", async (t) => {
  const bare = makeBareRemote(t);
  seedBareRemote(t, bare, { "README.md": "vault\n" });

  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: bare, nodeId: "mac-studio" });
  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  const gplayEnvelope = JSON.stringify(sealVaultBuffer(Buffer.from(GCP_SERVICE_ACCOUNT, "utf8")));
  const keystore = randomBytes(1024);
  const staged: Array<[string, string | Buffer]> = [
    ["secrets/shared/asc-api-key.p8", p8],
    ["secrets/shared/gplay-service-account.json", gplayEnvelope],
    ["secrets/apps/patigame/release.keystore", keystore],
    ["config/lanes.json", JSON.stringify({ lanes: { default: "pi" } })],
  ];
  for (const [rel, data] of staged) {
    const target = join(home, "vault-runtime", rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  const stateDir = join(home, "plugin-state", "paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.jsonl"), LEDGER_LINES);

  const result = await runFactory(["--home", home, "vault", "push", "--include-ledger"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.pushed, true);
  assert.deepEqual(payload.pushedFiles, [
    "config/lanes.json",
    "secrets/apps/patigame/release.keystore",
    "secrets/shared/asc-api-key.p8",
    "secrets/shared/gplay-service-account.json",
    "state/nodes/mac-studio/global-ledger.jsonl",
  ]);
  assert.ok(!Number.isNaN(Date.parse(String(payload.vault?.lastPushedAt ?? ""))), "the verb's vault view carries the fresh push stamp");
  assert.ok(existsSync(join(home, "vault", ".git")), "push clones the vault checkout first when absent");

  // what actually reached the remote: bytes verbatim, envelopes still envelopes, ledger node-scoped
  const probe = makeTempDir();
  disposeDir(t, probe);
  runGit(["clone", bare, probe]);
  assert.equal(readFileSync(join(probe, "secrets/shared/asc-api-key.p8"), "utf8"), p8);
  assert.deepEqual(unsealVaultBuffer(readFileSync(join(probe, "secrets/shared/gplay-service-account.json"))), Buffer.from(GCP_SERVICE_ACCOUNT, "utf8"), "the envelope rode verbatim and still core-unseals");
  assert.deepEqual(readFileSync(join(probe, "secrets/apps/patigame/release.keystore")), keystore);
  assert.equal(readFileSync(join(probe, "state/nodes/mac-studio/global-ledger.jsonl"), "utf8"), LEDGER_LINES, "--include-ledger snapshots the global ledger under this node's namespace");

  // nothing changed since: no commit, no push, the remote tip holds
  const headBefore = bareHead(bare);
  const again = await runFactory(["--home", home, "vault", "push", "--include-ledger"]);
  assert.equal(again.status, 0, again.stderr);
  const againPayload = JSON.parse(again.stdout);
  assert.equal(againPayload.pushed, false, "a clean tree produces no commit and no push");
  assert.equal(againPayload.pushedFiles.length, 5, "the staged set is still reported");
  assert.equal(bareHead(bare), headBefore, "the remote tip did not move");
});

test("factory vault pull → push roundtrip: the remote keeps its envelopes, a no-op cycle commits nothing, changed content re-seals", async (t) => {
  const bare = makeBareRemote(t);
  const p8 = "-----BEGIN PRIVATE KEY-----\nasc api key\n-----END PRIVATE KEY-----\n";
  const gplayEnvelope = JSON.stringify(sealVaultBuffer(Buffer.from(GCP_SERVICE_ACCOUNT, "utf8")));
  seedBareRemote(t, bare, {
    "README.md": "vault\n",
    "secrets/shared/asc-api-key.p8": p8,
    "secrets/shared/gplay-service-account.json": gplayEnvelope,
  });

  const home = makeTempDir();
  disposeDir(t, home);
  saveVaultConfig(home, { repo: bare, nodeId: "mac-studio" });

  const pull = await runFactory(["--home", home, "vault", "pull"]);
  assert.equal(pull.status, 0, pull.stderr);
  const runtimeGplay = join(home, "vault-runtime", "secrets", "shared", "gplay-service-account.json");
  assert.equal(readFileSync(runtimeGplay, "utf8"), GCP_SERVICE_ACCOUNT, "the CLI's pull unsealed the envelope into vault-runtime");

  // the no-op cycle through the CLI's mirror: the remote must keep its envelope and its tip
  const headBefore = bareHead(bare);
  const push = await runFactory(["--home", home, "vault", "push"]);
  assert.equal(push.status, 0, push.stderr);
  const payload = JSON.parse(push.stdout);
  assert.equal(payload.pushed, false, "a no-op pull → push cycle over the unsealed runtime produces no commit");
  assert.equal(bareHead(bare), headBefore, "the remote tip did not move");

  const probe = makeTempDir();
  disposeDir(t, probe);
  runGit(["clone", bare, probe]);
  const remoteGplay = readFileSync(join(probe, "secrets", "shared", "gplay-service-account.json"), "utf8");
  assert.equal(remoteGplay, gplayEnvelope, "the remote still holds the sealed envelope, never the plaintext GSA JSON");
  assert.ok(!remoteGplay.includes("PRIVATE KEY"), "no PEM marker ever reaches the remote through the CLI");

  // genuinely changed content through the CLI: re-sealed with the envelope's own mode, still never plaintext
  const rotated = GCP_SERVICE_ACCOUNT.replace("d1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1", "e2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2");
  writeFileSync(runtimeGplay, rotated);
  const changed = await runFactory(["--home", home, "vault", "push"]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).pushed, true, "genuinely changed content does commit");

  const probe2 = makeTempDir();
  disposeDir(t, probe2);
  runGit(["clone", bare, probe2]);
  const resealed = readFileSync(join(probe2, "secrets", "shared", "gplay-service-account.json"), "utf8");
  assert.equal(
    resealed,
    `${JSON.stringify(sealVaultBuffer(Buffer.from(rotated, "utf8")))}\n`,
    "the mirror re-seals changed plaintext with the envelope's own (deterministic obfuscated) mode",
  );
  assert.ok(!resealed.includes("PRIVATE KEY"), "the re-sealed copy still carries no PEM marker");
  assert.deepEqual(unsealVaultBuffer(readFileSync(join(probe2, "secrets", "shared", "gplay-service-account.json"))), Buffer.from(rotated, "utf8"));
});

// ---- vault seal: staging envelopes into the runtime tree ------------------------------------

test("factory vault seal stages the zero-passphrase obfuscated envelope (and the locked mode) into vault-runtime", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "home");
  const source = join(dir, "gplay-service-account.json");
  writeFileSync(source, GCP_SERVICE_ACCOUNT);

  // no --passphrase: the zero-passphrase obfuscated envelope, secret-scanning-safe
  const result = await runFactory(["--home", home, "vault", "seal", source, "--to", "secrets/shared/gplay-service-account.json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "obfuscated");
  assert.equal(payload.vaultPath, "secrets/shared/gplay-service-account.json");
  assert.equal(payload.source, source);
  assert.ok(Number.isInteger(payload.envelopeBytes) && payload.envelopeBytes > 0, "the sealed byte count is reported");

  const stagedPath = join(home, "vault-runtime", "secrets/shared/gplay-service-account.json");
  const staged = readFileSync(stagedPath);
  const envelope = JSON.parse(staged.toString("utf8"));
  assert.equal(envelope.v, 1);
  assert.equal(envelope.mode, "obfuscated");
  assert.ok(!staged.includes("PRIVATE KEY"), "the obfuscated envelope never carries the plaintext PEM marker");
  assert.deepEqual(unsealVaultBuffer(staged), Buffer.from(GCP_SERVICE_ACCOUNT, "utf8"), "the core unseals the CLI-staged envelope to the original bytes");
  assert.equal(modeOf(stagedPath), 0o600, "sealed secrets stage 0o600");

  // with --passphrase: the aes-256-gcm envelope, fresh salt/iv/tag
  const locked = await runFactory([
    "--home", home, "vault", "seal", source, "--to", "secrets/shared/eye.json", "--passphrase", "correct-horse-battery",
  ]);
  assert.equal(locked.status, 0, locked.stderr);
  const lockedPayload = JSON.parse(locked.stdout);
  assert.equal(lockedPayload.ok, true);
  assert.equal(lockedPayload.mode, "aes-256-gcm");
  const lockedEnvelope = JSON.parse(readFileSync(join(home, "vault-runtime", "secrets/shared/eye.json"), "utf8"));
  assert.equal(Buffer.from(lockedEnvelope.salt, "base64").length, 16);
  assert.equal(Buffer.from(lockedEnvelope.iv, "base64").length, 12);
  assert.equal(Buffer.from(lockedEnvelope.tag, "base64").length, 16);
  assert.deepEqual(
    unsealVaultBuffer(readFileSync(join(home, "vault-runtime", "secrets/shared/eye.json")), "correct-horse-battery"),
    Buffer.from(GCP_SERVICE_ACCOUNT, "utf8"),
    "the core unseals the CLI's locked envelope with the passphrase",
  );
});

// ---- the mirror law (ADR 0004) ---------------------------------------------------------------

test("the CLI's vault mirror imports no src/ or plugin-server code, and carries its .d.mts pair (ADR 0004)", () => {
  assert.ok(existsSync(join(repoRoot, "plugin", "bin", "vault.d.mts")), "every bin helper carries a declaration stub");
  for (const rel of ["plugin/bin/vault.mjs", "plugin/bin/factory.mjs"]) {
    const source = readFileSync(join(repoRoot, ...rel.split("/")), "utf8");
    const specifiers = [...source.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((match) => match[1]!);
    assert.ok(specifiers.length > 0, `${rel} has imports to check`);
    for (const specifier of specifiers) {
      assert.match(
        specifier,
        /^(?:node:|\.\/)/,
        `${rel} imports only node: built-ins and bin-local siblings — "${specifier}" breaks the no-src-imports law`,
      );
    }
  }
});
