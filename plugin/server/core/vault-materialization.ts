import { collectScrumVault, collectProjectScrumVault, materializeScrumVault, materializeProjectScrumVault } from "./scrum/vault.ts";
import { FactoryError } from "./errors.ts";
import { mergeLaneProfilesFiles, projectLanesPath, readLaneProfilesFile } from "./lanes.ts";
import type { LaneProfile, LaneProfilesFile } from "./lanes.ts";
import { listProjectRegistrations, discoverProjects, resolveProject } from "./project.ts";
import { vaultStateDir, sharedSecretExists, SHARED_SECRET_FILES, loadVaultConfig } from "./vault-config.ts";
import type { VaultRuntimeEnv } from "./vault-config.ts";
import { unsealVaultBuffer, resolveVaultPassphrase } from "./vault-envelope.ts";
import { expandImportPath } from "./vault-secrets.ts";
import { buildVaultPath } from "./vault-transport.ts";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, chmodSync, writeFileSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { join, basename, isAbsolute, resolve as resolvePath, dirname } from "node:path";

/** Hydrates `<paseoHome>/vault-runtime/` from a vault tree on disk (the sync-mode checkout). */
export function hydrateRuntimeFromTree(paseoHome: string, treeRoot: string, passphrase: string | undefined): string[] {
  const written: string[] = [];
  for (const rel of walkFiles(treeRoot, () => false)) {
    writeRuntimeFile(paseoHome, rel, unsealVaultBuffer(readFileSync(join(treeRoot, rel)), passphrase));
    written.push(rel);
  }
  return written.sort();
}

/** Writes one unsealed vault file under `<paseoHome>/vault-runtime/` — `0o600` (+ `0o700` dirs) under `secrets/`. */
export function writeRuntimeFile(paseoHome: string, vaultPath: string, data: Buffer): void {
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
export function assertSafeVaultPath(vaultPath: string): void {
  const segments = vaultPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new FactoryError("vault-invalid-path", `refusing unsafe vault path "${vaultPath}"`);
  }
}

/** Every file under `root` as `/`-separated relative paths (sorted), skipping any `.git` directory and `skip` matches. */
export function walkFiles(root: string, skip: (rel: string) => boolean): string[] {
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
export function readVaultManifestAt(root: string): VaultManifest {
  try {
    return parseVaultManifest(readFileSync(join(root, "vault.manifest.json"), "utf8"));
  } catch (err) {
    if (err instanceof FactoryError && err.code === "corrupted-vault-manifest") throw err;
    return {}; // ENOENT and read damage degrade to no routing, never a crash
  }
}

/** The match legs of one local checkout, probed once per resolution run, with its resolved identity. */
export interface RootFacts {
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
export function collectCandidateProjectRoots(paseoHome: string): string[] {
  const stateDir = vaultStateDir(paseoHome);
  const candidateRoots = new Set<string>();
  for (const registration of listProjectRegistrations(stateDir)) candidateRoots.add(registration.root);
  for (const discovered of discoverProjects(stateDir, [], paseoHome)) {
    if (discovered.root !== null) candidateRoots.add(discovered.root);
  }
  for (const root of readReleaseLabProjectRoots(paseoHome)) candidateRoots.add(root);
  return [...candidateRoots].sort();
}

export function inspectProjectRootFacts(root: string): RootFacts | null {
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

export function resolveVaultApps(paseoHome: string, manifest: VaultManifest): ResolvedVaultApp[] {
  const candidateRoots = collectCandidateProjectRoots(paseoHome);

  // resolveProject per distinct root, once — it is the slug's single source
  const factsByRoot = new Map<string, RootFacts | null>();
  const factsOf = (root: string): RootFacts | null => {
    const cached = factsByRoot.get(root);
    if (cached !== undefined) return cached;
    const facts = inspectProjectRootFacts(root);
    factsByRoot.set(root, facts);
    return facts;
  };

  const out: ResolvedVaultApp[] = [];
  for (const canonicalAppKey of Object.keys(manifest).sort()) {
    const entry = manifest[canonicalAppKey]!;
    let matched: RootFacts | null = null;
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

/** Finds the first canonical app key in `manifest` matching `facts`, or null. */
export function matchManifestAppKey(manifest: VaultManifest, facts: RootFacts): string | null {
  for (const key of Object.keys(manifest).sort()) {
    if (entryMatches(manifest[key]!, facts)) return key;
  }
  return null;
}

/** Whether any of the entry's declared legs matches the checkout's facts. */
export function entryMatches(entry: VaultManifestEntry, facts: RootFacts): boolean {
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
export function gitRemotesMatch(a: string, b: string): boolean {
  const left = normalizeGitRemote(a);
  const right = normalizeGitRemote(b);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/** Strips scheme, user, scp colon, and `.git` — the path identity of a remote URL, lowercased. */
export function normalizeGitRemote(url: string): string {
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
export function readReleaseLabProjectRoots(paseoHome: string): string[] {
  const parsed = readJsonFile(join(paseoHome, "release-lab", "projects.json"));
  const roots: string[] = [];
  for (const entry of arrayField(parsed, "projects")) {
    const root = jsonStringField(entry, "root");
    if (root !== null && root.trim() !== "") roots.push(root);
  }
  return roots;
}

/** One git fact about a checkout, or null — a missing answer is never a guess. */
export function gitProbe(cwd: string, args: string[]): string | null {
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

/** Reads a JSON file as an object, or null when absent/damaged — a routing input, not an authority. */
export function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A string field of a JSON object, or null. */
export function jsonStringField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/** An array field of a JSON object as objects, or empty — malformed entries are skipped, never fatal. */
export function arrayField(record: Record<string, unknown> | null, field: string): Array<Record<string, unknown>> {
  const value = record?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

/** A nested two-key string field (`project_info.project_id`), or null. */
export function nestedJsonStringField(record: Record<string, unknown> | null, path: readonly [string, string]): string | null {
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
export function appendUniqueLines(path: string, lines: readonly string[]): void {
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
export const APP_FILE_TARGETS: ReadonlyArray<{ vaultFile: string; projectRel: string }> = [
  { vaultFile: "release.keystore", projectRel: "android/app/release.keystore" },
  { vaultFile: "signing.json", projectRel: "android/keystore.properties" },
  { vaultFile: "google-services.json", projectRel: "android/app/google-services.json" },
  { vaultFile: "GoogleService-Info.plist", projectRel: "ios/GoogleService-Info.plist" },
];

/** Materializes one canonical app's per-app files from `vault-runtime` into its resolved local checkout (`0o600`). */
export function materializeVaultAppFiles(paseoHome: string, canonicalAppKey: string, projectRoot: string): string[] {
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
export function renderKeystoreProperties(signing: Record<string, unknown> | null): string | null {
  if (signing === null) return null;
  const lines = Object.keys(signing)
    .filter((key) => typeof signing[key] === "string")
    .sort()
    .map((key) => `${key}=${signing[key] as string}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : null;
}

/**
 * Collects local state and config files from `<paseoHome>` into `<paseoHome>/vault-runtime/`
 * before staging into `<paseoHome>/vault`:
 * - `<stateDir>/lanes.json` -> `config/lanes.json`
 * - `<stateDir>/profiles.json` -> `config/profiles.json` (key-level MERGE with any existing
 *   runtime copy via `mergeLaneProfilesFiles`, so profiles authored on different machines
 *   combine rather than overwrite — v0.0.38, ADR 0026 §4)
 * - `<paseoHome>/burn-lab/free-pool.json` -> `config/free-pool.json`
 * - `<stateDir>/eye.json` -> `secrets/shared/eye.json` (when not already present in `vault-runtime`)
 * - For every registered local `Project` with `.store-release/manifest.json`, copies it into
 *   `config/apps/<canonicalAppKey>/store-manifest.json` and updates `vault.manifest.json`.
 * - For every registered local `Project` with a per-Project `<projectStateDir>/lanes.json`
 *   override, stages it into `config/apps/<canonicalAppKey>/lanes.json` and updates the
 *   manifest's routing legs (v0.0.38, ADR 0026 §4) — the canonical key routes the override
 *   back to the same repository on another machine, whose local slug differs.
 */
export function collectLocalStateIntoRuntime(paseoHome: string): void {
  const stateDir = vaultStateDir(paseoHome);
  collectScrumVault(stateDir, join(paseoHome, "vault-runtime/config"));
  const configSources: ReadonlyArray<{ src: string; vaultRel: string }> = [
    { src: join(stateDir, "lanes.json"), vaultRel: "config/lanes.json" },
    { src: join(paseoHome, "burn-lab", "free-pool.json"), vaultRel: "config/free-pool.json" },
  ];
  for (const { src, vaultRel } of configSources) {
    if (existsSync(src)) {
      writeRuntimeFile(paseoHome, vaultRel, readFileSync(src));
    }
  }

  // Lane profiles merge key-level by `updatedAt`/`deletedAt` (v0.0.38, ADR
  // 0026 §4): the runtime copy may hold profiles another machine authored,
  // so the fresh local side merges INTO it — the local edit wins ties. A
  // damaged runtime cache rebuilds from the local side; a damaged LOCAL
  // profiles.json is a named refusal (the readLaneProfilesFile law).
  const localProfilesPath = join(stateDir, "profiles.json");
  if (existsSync(localProfilesPath)) {
    const local = readLaneProfilesFile(stateDir);
    const runtimeProfilesPath = join(paseoHome, "vault-runtime", "config", "profiles.json");
    const existing = readLaneProfilesCacheOrNull(runtimeProfilesPath) ?? { profiles: {} };
    const merged = mergeLaneProfilesFiles(existing, local, { preferRemote: true });
    writeRuntimeFile(paseoHome, "config/profiles.json", Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8"));
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
  const seenRoots = new Set<string>();

  for (const candidateRoot of collectCandidateProjectRoots(paseoHome)) {
    const facts = inspectProjectRootFacts(candidateRoot);
    if (facts === null || seenRoots.has(facts.root)) continue;
    seenRoots.add(facts.root);
    const storeManifestPath = join(facts.root, ".store-release", "manifest.json");
    const hasStoreManifest = existsSync(storeManifestPath);
    // The per-Project lanes.json override rides the same per-app routing as
    // store manifests (v0.0.38, ADR 0026 §4): keyed by canonical app key so
    // another machine's DIFFERENT local slug still finds its checkout.
    const projectLanes = projectLanesPath(stateDir, facts.slug);
    const hasProjectLanes = existsSync(projectLanes);
    if (!hasStoreManifest && !hasProjectLanes && !existsSync(join(stateDir, "projects", facts.slug, "scrum-lanes.json"))) continue;

    let canonicalAppKey = matchManifestAppKey(manifest, facts);
    if (canonicalAppKey === null && hasStoreManifest) {
      const storeManifestObj = readJsonFile(storeManifestPath);
      canonicalAppKey = jsonStringField(storeManifestObj, "appKey") ?? facts.basename;
    }
    if (canonicalAppKey === null) canonicalAppKey = facts.basename;

    if (hasStoreManifest) {
      writeRuntimeFile(paseoHome, `config/apps/${canonicalAppKey}/store-manifest.json`, readFileSync(storeManifestPath));
    }
    if (hasProjectLanes) {
      writeRuntimeFile(paseoHome, `config/apps/${canonicalAppKey}/lanes.json`, readFileSync(projectLanes));
    }
    collectProjectScrumVault(stateDir, facts.slug, join(paseoHome, "vault-runtime/config/apps", canonicalAppKey));
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
 * Reads a runtime `config/profiles.json` cache LENIENTLY — absent returns an
 * empty file, damaged returns null (the caller rebuilds it from the local
 * side). Collect's cache-rebuild path only; hydration applies the strict
 * `readLaneProfilesFile` law to whatever it writes.
 */
function readLaneProfilesCacheOrNull(path: string): LaneProfilesFile | null {
  if (!existsSync(path)) return { profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LaneProfilesFile>;
    if (parsed.profiles === undefined || parsed.profiles === null || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
      return null;
    }
    const file: LaneProfilesFile = { profiles: parsed.profiles as Record<string, Omit<LaneProfile, "id">> };
    if (parsed.deleted !== undefined && parsed.deleted !== null && typeof parsed.deleted === "object" && !Array.isArray(parsed.deleted)) {
      file.deleted = parsed.deleted;
    }
    if (
      parsed.activeProfileByScope !== undefined &&
      parsed.activeProfileByScope !== null &&
      typeof parsed.activeProfileByScope === "object" &&
      !Array.isArray(parsed.activeProfileByScope)
    ) {
      file.activeProfileByScope = parsed.activeProfileByScope;
    }
    return file;
  } catch {
    return null;
  }
}

/**
 * Materializes `config/{lanes,free-pool}.json` from `<paseoHome>/vault-runtime/`
 * into their local `<paseoHome>` destinations when absent locally (or when `overwriteConfigs === true`),
 * plus the two v0.0.38 additions (ADR 0026 §4): `config/profiles.json` merges
 * key-level into `<stateDir>/profiles.json` (`preferRemote: overwriteConfigs`
 * — newer `updatedAt`/`deletedAt` wins either way, so profiles authored on
 * different machines combine), and each `config/apps/<canonicalAppKey>/lanes.json`
 * materializes into its resolved Project's `<projectStateDir>/lanes.json`
 * when absent locally (or when `overwriteConfigs === true`).
 */
export function materializeConfigsFromRuntime(paseoHome: string, overwriteConfigs = false): void {
  const runtimeConfigDir = join(paseoHome, "vault-runtime", "config");
  materializeScrumVault(vaultStateDir(paseoHome), runtimeConfigDir, overwriteConfigs);
  const targets: ReadonlyArray<{ src: string; dest: string }> = [
    { src: join(runtimeConfigDir, "lanes.json"), dest: join(vaultStateDir(paseoHome), "lanes.json") },
    { src: join(runtimeConfigDir, "free-pool.json"), dest: join(paseoHome, "burn-lab", "free-pool.json") },
  ];
  for (const { src, dest } of targets) {
    if (!existsSync(src)) continue;
    if (!overwriteConfigs && existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }

  // Lane profiles: a key-level merge, never a blind copy — the local file's
  // own newer edits survive a hydration that carries an older remote copy.
  const stateDir = vaultStateDir(paseoHome);
  const runtimeProfiles = join(runtimeConfigDir, "profiles.json");
  if (existsSync(runtimeProfiles)) {
    const local = readLaneProfilesFile(stateDir); // a damaged local file is a named refusal, never silently replaced
    const remote = readLaneProfilesCacheOrNull(runtimeProfiles);
    if (remote !== null) {
      const merged = mergeLaneProfilesFiles(local, remote, { preferRemote: overwriteConfigs });
      mkdirSync(dirname(join(stateDir, "profiles.json")), { recursive: true });
      writeFileSync(join(stateDir, "profiles.json"), `${JSON.stringify(merged, null, 2)}\n`);
    }
  }

  // Per-app lanes overrides: route each staged canonical key back to its
  // local Project and materialize the override beside its own state tree.
  if (existsSync(join(runtimeConfigDir, "apps"))) {
    const manifest = readVaultManifestAt(join(paseoHome, "vault-runtime"));
    for (const app of resolveVaultApps(paseoHome, manifest)) {
      if (app.projectSlug === null) continue; // no local checkout behind this key on this machine
      materializeProjectScrumVault(stateDir, app.projectSlug, join(runtimeConfigDir, "apps", app.canonicalAppKey), overwriteConfigs);
      const src = join(runtimeConfigDir, "apps", app.canonicalAppKey, "lanes.json");
      if (!existsSync(src)) continue;
      const dest = projectLanesPath(stateDir, app.projectSlug);
      if (!overwriteConfigs && existsSync(dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  }
}

/**
 * The stage-C hydration tail both transports share: route `vault.manifest.json`
 * canonical keys to local `Project`s, materialize per-app files into every
 * resolved checkout with hygiene registered, materialize global config files
 * (Lane profiles merge key-level; per-app lanes overrides land in their
 * Project's own `<projectStateDir>/lanes.json` — v0.0.38, ADR 0026 §4), and
 * write the `<paseoHome>/vault-runtime/env.json` pointer index (`0o600`) —
 * the zero-shell-config hand-off `factory-release-lab` reads (ADR 0014 Decision 5).
 */
export function applyVaultHydration(paseoHome: string, overwriteConfigs = false): void {
  const manifest = readVaultManifestAt(join(paseoHome, "vault-runtime"));
  for (const app of resolveVaultApps(paseoHome, manifest)) {
    if (app.projectRoot === null) continue; // no local checkout behind this canonical key on this machine
    const written = materializeVaultAppFiles(paseoHome, app.canonicalAppKey, app.projectRoot);
    if (written.length > 0) ensureLocalGitExcludeAndWorktreeInclude(app.projectRoot, written);
  }
  materializeConfigsFromRuntime(paseoHome, overwriteConfigs);
  writeVaultRuntimeEnv(paseoHome);
}

/** Writes the `VaultRuntimeEnv` pointer index at `<paseoHome>/vault-runtime/env.json`, `0o600`. */
export function writeVaultRuntimeEnv(paseoHome: string): void {
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
export function buildVaultRuntimeEnv(paseoHome: string): VaultRuntimeEnv {
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
export function hydratedAppKeys(paseoHome: string): string[] {
  try {
    return readdirSync(join(paseoHome, "vault-runtime", "secrets", "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return []; // no apps dir yet — nothing hydrated
  }
}
