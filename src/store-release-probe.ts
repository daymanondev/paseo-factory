/**
 * Pure filesystem probes for Store release surface state (ADR 0066):
 * - Mobile platform detection (`android`, `ios`, `expo`)
 * - Latest matching run and active `Hole` summary from `<paseoHome>/release-lab/runs/`
 * - Shared `factory-release-lab` companion install discovery and failure/hole parsing helpers
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type StoreReleasePlatform = "android" | "ios" | "expo";
export type StoreReleaseFailureClass = "app-repo" | "tool-bug" | "account-policy";
export type ReleaseLabCompanionStatus = "not_installed" | "running" | "disabled" | "failed";

export const RELEASE_LAB_PLUGIN_ID = "factory-release-lab";
const MAX_DIAGNOSTIC_TAIL_CHARS = 2000;
const MAX_DIAGNOSTIC_TAIL_LINES = 40;

export interface StoreReleaseHoleInfo {
  runId: string;
  kind: string;
  phase: string;
  pausedAt: string;
  defaultResolution?: unknown;
  resolutionSpec?: unknown;
}

export interface StoreReleaseFailureInfo {
  failureClass: StoreReleaseFailureClass;
  platform?: "android" | "ios";
  phase?: string;
  code: string;
  message: string;
  upstreamIssuePath?: string;
}

export interface StoreReleaseRunnerFailure extends Omit<StoreReleaseFailureInfo, "platform"> {
  platform?: string;
  logTail?: string;
  hint?: string;
}

export interface StoreReleaseRunInfo {
  id: string;
  playbook: string;
  status: string;
  platforms: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  failure: StoreReleaseFailureInfo | null;
}

export interface ReleaseLabInstallDiscovery {
  installed: boolean;
  enabled: boolean;
  status: ReleaseLabCompanionStatus;
  path: string | null;
  binPath: string | null;
  skillRoot: string | null;
}

export interface DiscoverReleaseLabOptions {
  /** Whether a live daemon plugin query answered (`result.ok === true`). */
  daemonAnswered?: boolean;
  /** The `factory-release-lab` entry returned by `listDaemonPlugins`, when present. */
  daemonEntry?: { path: string; enabled: boolean; status: ReleaseLabCompanionStatus } | null;
}

/** Type guard for non-null plain JSON objects. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a JSON string into a plain object, returning `null` on blank/malformed/non-object input. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads and parses a JSON file as a plain object, returning `null` when missing or invalid. */
export function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    return parseJsonObject(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Derives `<paseoHome>` from a canonical `<paseoHome>/plugin-state/paseo-factory` state directory. */
export function derivePaseoHomeFromStateDir(stateDir?: string): string | undefined {
  if (stateDir !== undefined && basename(stateDir) === "paseo-factory" && basename(dirname(stateDir)) === "plugin-state") {
    return dirname(dirname(stateDir));
  }
  return undefined;
}

/** Trims runner stderr/stdout tails to bounded lines and chars for Ledger/mailbox diagnostics. */
export function trimDiagnosticTail(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const lines = trimmed.split(/\r?\n/);
  const tailLines = lines.length > MAX_DIAGNOSTIC_TAIL_LINES ? lines.slice(-MAX_DIAGNOSTIC_TAIL_LINES) : lines;
  const joined = tailLines.join("\n");
  return joined.length > MAX_DIAGNOSTIC_TAIL_CHARS ? joined.slice(-MAX_DIAGNOSTIC_TAIL_CHARS) : joined;
}

function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function hasAndroidProjectMarkers(projectRoot: string): boolean {
  const candidates = [
    "android/app/build.gradle",
    "android/app/build.gradle.kts",
    "android/build.gradle",
    "android/build.gradle.kts",
    "android/settings.gradle",
    "android/settings.gradle.kts",
    "app/build.gradle",
    "app/build.gradle.kts",
    "AndroidManifest.xml",
    "android/app/src/main/AndroidManifest.xml",
  ];
  return candidates.some((rel) => existsSync(join(projectRoot, rel)));
}

function hasIosProjectMarkers(projectRoot: string): boolean {
  const rootEntries = listDirNames(projectRoot);
  if (rootEntries.some((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace"))) {
    return true;
  }
  const iosDir = join(projectRoot, "ios");
  if (!existsSync(iosDir)) return false;
  if (existsSync(join(iosDir, "Podfile"))) return true;
  const iosEntries = listDirNames(iosDir);
  if (iosEntries.some((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace"))) {
    return true;
  }
  return listSubdirs(iosDir).some((sub) => existsSync(join(iosDir, sub, "Info.plist")));
}

/** Detects mobile platforms (`android`, `ios`, `expo`) present in `projectRoot`. */
export function detectMobilePlatforms(projectRoot: string): StoreReleasePlatform[] {
  if (!projectRoot || !existsSync(projectRoot)) return [];
  const detected = new Set<StoreReleasePlatform>();

  const manifest = readJsonObject(join(projectRoot, ".store-release", "manifest.json"));
  if (manifest !== null) {
    if (Array.isArray(manifest.platforms)) {
      for (const platform of manifest.platforms) {
        if (platform === "android" || platform === "ios") detected.add(platform);
      }
    }
    const toolchain = isPlainRecord(manifest.toolchain) ? manifest.toolchain : null;
    if (manifest.projectKind === "expo" || toolchain?.expoPrebuild === true) {
      detected.add("expo");
    }
  }

  const appJson = readJsonObject(join(projectRoot, "app.json"));
  const expoBlock = appJson !== null && isPlainRecord(appJson.expo) ? appJson.expo : null;
  if (expoBlock !== null) {
    detected.add("expo");
    if (typeof expoBlock.android === "object" && expoBlock.android !== null) detected.add("android");
    if (typeof expoBlock.ios === "object" && expoBlock.ios !== null) detected.add("ios");
  }

  if (
    existsSync(join(projectRoot, "eas.json")) ||
    existsSync(join(projectRoot, "app.config.ts")) ||
    existsSync(join(projectRoot, "app.config.js")) ||
    existsSync(join(projectRoot, "app.config.mjs"))
  ) {
    detected.add("expo");
  }

  const pkg = readJsonObject(join(projectRoot, "package.json"));
  if (pkg !== null) {
    const depSections = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies];
    for (const section of depSections) {
      if (isPlainRecord(section) && ("expo" in section || "expo-router" in section)) {
        detected.add("expo");
      }
    }
  }

  if (hasAndroidProjectMarkers(projectRoot)) detected.add("android");
  if (hasIosProjectMarkers(projectRoot)) detected.add("ios");

  return (["android", "ios", "expo"] as const).filter((platform) => detected.has(platform));
}

function normalizeFsPath(targetPath: string): string {
  const resolved = resolve(targetPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return null;
}

function isStoreReleaseFailureClass(value: unknown): value is StoreReleaseFailureClass {
  return value === "app-repo" || value === "tool-bug" || value === "account-policy";
}

/** Parses a failure object from a persisted run record (`strict=true` requires known failureClass, code, message). */
export function parseStoreReleaseFailure(raw: unknown): StoreReleaseFailureInfo | null {
  if (!isPlainRecord(raw)) return null;
  if (!isStoreReleaseFailureClass(raw.failureClass)) return null;
  if (typeof raw.code !== "string" || typeof raw.message !== "string") return null;
  return {
    failureClass: raw.failureClass,
    ...(raw.platform === "android" || raw.platform === "ios" ? { platform: raw.platform } : {}),
    ...(typeof raw.phase === "string" ? { phase: raw.phase } : {}),
    code: raw.code,
    message: raw.message,
    ...(typeof raw.upstreamIssuePath === "string" && raw.upstreamIssuePath.trim() !== ""
      ? { upstreamIssuePath: raw.upstreamIssuePath }
      : {}),
  };
}

/** Parses a runner failure payload (stdout/stderr), defaulting unknown fields safely to `tool-bug`. */
export function parseRunnerFailure(raw: unknown): StoreReleaseRunnerFailure | null {
  if (!isPlainRecord(raw)) return null;
  const failureClass: StoreReleaseFailureClass = isStoreReleaseFailureClass(raw.failureClass) ? raw.failureClass : "tool-bug";
  const code = typeof raw.code === "string" && raw.code.trim() !== "" ? raw.code.trim() : "runner-failed";
  const message = typeof raw.message === "string" && raw.message.trim() !== "" ? raw.message.trim() : code;
  return {
    failureClass,
    code,
    message,
    ...(typeof raw.phase === "string" ? { phase: raw.phase } : {}),
    ...(typeof raw.platform === "string" ? { platform: raw.platform } : {}),
    ...(typeof raw.logTail === "string" && raw.logTail.trim() !== "" ? { logTail: trimDiagnosticTail(raw.logTail) } : {}),
    ...(typeof raw.hint === "string" && raw.hint.trim() !== "" ? { hint: raw.hint.trim() } : {}),
    ...(typeof raw.upstreamIssuePath === "string" && raw.upstreamIssuePath.trim() !== ""
      ? { upstreamIssuePath: raw.upstreamIssuePath.trim() }
      : {}),
  };
}

/** Extracts the active unresumed `Hole` from a run record, or `null` if none is active. */
export function extractActiveHole(
  runId: string,
  record: Record<string, unknown>,
  fallbackIso = new Date(0).toISOString(),
): StoreReleaseHoleInfo | null {
  if (record.status !== "paused-hole" || !Array.isArray(record.phases)) return null;
  for (const rawPhase of record.phases) {
    if (!isPlainRecord(rawPhase)) continue;
    const hole = isPlainRecord(rawPhase.hole) ? rawPhase.hole : null;
    if (hole === null) continue;
    if (rawPhase.state !== "paused-hole" && hole.resumedAt !== undefined) continue;
    if (typeof rawPhase.id !== "string" || typeof hole.kind !== "string") continue;
    return {
      runId,
      kind: hole.kind,
      phase: rawPhase.id,
      pausedAt: toIsoTimestamp(hole.pausedAt) ?? fallbackIso,
      ...(hole.defaultResolution !== undefined ? { defaultResolution: hole.defaultResolution } : {}),
      ...(hole.resolutionSpec !== undefined ? { resolutionSpec: hole.resolutionSpec } : {}),
    };
  }
  return null;
}

/** Reads `<paseoHome>/release-lab/runs/<runId>.json` for active hole kind, playbook, and platforms. */
export function readStoreReleaseRunHoleInfo(
  paseoHome: string,
  runId: string,
): { holeKind: string | null; playbook: string | null; platforms: ("android" | "ios")[] } {
  const record = readJsonObject(join(paseoHome, "release-lab", "runs", `${runId}.json`));
  if (record === null) return { holeKind: null, playbook: null, platforms: [] };
  const platforms = Array.isArray(record.platforms)
    ? record.platforms.filter((p): p is "android" | "ios" => p === "android" || p === "ios")
    : [];
  const playbook = typeof record.playbook === "string" && record.playbook.trim() !== "" ? record.playbook.trim() : null;
  const activeHole = extractActiveHole(runId, record);
  return {
    holeKind: activeHole?.kind ?? null,
    playbook,
    platforms,
  };
}

function rankManagedSubdirs(managedRoot: string, subpath = ""): Array<{ dir: string; mtime: number }> {
  let entries;
  try {
    entries = readdirSync(managedRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const ranked: Array<{ dir: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const versionDir = join(managedRoot, entry.name);
    const candidate = subpath !== "" ? join(versionDir, subpath) : versionDir;
    if (!existsSync(candidate)) continue;
    try {
      const mtime = Math.max(statSync(versionDir).mtimeMs, statSync(candidate).mtimeMs);
      ranked.push({ dir: candidate, mtime });
    } catch {
      // skip unreadable directory
    }
  }
  ranked.sort((a, b) => (b.mtime !== a.mtime ? b.mtime - a.mtime : b.dir.localeCompare(a.dir)));
  return ranked;
}

function resolveManagedReleaseLabPath(paseoHome: string, recordedPath: string): string {
  const managedRoot = join(paseoHome, "plugins", RELEASE_LAB_PLUGIN_ID);
  const rel = relative(managedRoot, recordedPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return recordedPath;
  const subpath = rel.split(sep).slice(1).join(sep);
  const ranked = rankManagedSubdirs(managedRoot, subpath);
  if (ranked.length === 0) return recordedPath;
  const topMtime = ranked[0]!.mtime;
  return ranked.find((r) => r.mtime === topMtime && r.dir !== recordedPath)?.dir ?? ranked[0]!.dir;
}

function findReleaseLabBin(pluginDir: string): string | null {
  const candidates = [
    join(pluginDir, "bin", "release-lab.mjs"),
    join(pluginDir, "..", "bin", "release-lab.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function dirContainsSkillMd(root: string, depth = 0, seen = new Set<string>()): boolean {
  if (depth > 8 || !existsSync(root)) return false;
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return false;
  }
  if (seen.has(real)) return false;
  seen.add(real);
  if (existsSync(join(root, "SKILL.md"))) return true;
  try {
    return readdirSync(root, { withFileTypes: true }).some(
      (entry) =>
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules" &&
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        dirContainsSkillMd(join(root, entry.name), depth + 1, seen),
    );
  } catch {
    return false;
  }
}

function findReleaseLabSkillRoot(pluginDir: string): string | null {
  const candidates = [join(pluginDir, "skill"), join(pluginDir, "..", "skill"), pluginDir];
  return candidates.find((candidate) => dirContainsSkillMd(candidate)) ?? null;
}

function readReleaseLabConfigEntry(paseoHome: string): { path: string; enabled: boolean } | null {
  const config = readJsonObject(join(paseoHome, "config.json"));
  const plugins = config && isPlainRecord(config.plugins) ? config.plugins : null;
  const entry = plugins && isPlainRecord(plugins[RELEASE_LAB_PLUGIN_ID]) ? plugins[RELEASE_LAB_PLUGIN_ID] : null;
  if (entry === null || typeof entry.path !== "string" || entry.path.trim() === "") return null;
  return {
    path: entry.path.trim(),
    enabled: entry.enabled !== false,
  };
}

/**
 * Shared `factory-release-lab` discovery helper across runner resolution,
 * `storeReleaseRead`, and Skill Hub: checks live daemon status when provided,
 * falling back to `config.json` and `<paseoHome>/plugins/factory-release-lab/`
 * directory scans when the daemon is offline or unqueried.
 */
export function discoverReleaseLabInstall(
  paseoHome: string,
  options?: DiscoverReleaseLabOptions,
): ReleaseLabInstallDiscovery {
  if (options?.daemonAnswered) {
    const listed = options.daemonEntry;
    if (!listed) {
      return { installed: false, enabled: false, status: "not_installed", path: null, binPath: null, skillRoot: null };
    }
    const resolvedDir = resolveManagedReleaseLabPath(paseoHome, listed.path);
    return {
      installed: true,
      enabled: listed.enabled,
      status: listed.status,
      path: resolvedDir,
      binPath: findReleaseLabBin(resolvedDir),
      skillRoot: findReleaseLabSkillRoot(resolvedDir),
    };
  }

  const configEntry = readReleaseLabConfigEntry(paseoHome);
  if (configEntry !== null) {
    const resolvedDir = resolveManagedReleaseLabPath(paseoHome, configEntry.path);
    const binPath = findReleaseLabBin(resolvedDir);
    const skillRoot = findReleaseLabSkillRoot(resolvedDir);
    if (existsSync(resolvedDir) || binPath !== null || skillRoot !== null) {
      return {
        installed: true,
        enabled: configEntry.enabled,
        status: configEntry.enabled ? "running" : "disabled",
        path: resolvedDir,
        binPath,
        skillRoot,
      };
    }
  }

  const managedRoot = join(paseoHome, "plugins", RELEASE_LAB_PLUGIN_ID);
  const directBin = findReleaseLabBin(managedRoot);
  const directSkill = findReleaseLabSkillRoot(managedRoot);
  if (directBin !== null || directSkill !== null) {
    return {
      installed: true,
      enabled: true,
      status: "running",
      path: managedRoot,
      binPath: directBin,
      skillRoot: directSkill,
    };
  }

  for (const { dir: versionDir } of rankManagedSubdirs(managedRoot)) {
    const pluginSubdir = join(versionDir, "plugin");
    const preferredDir = existsSync(pluginSubdir) ? pluginSubdir : versionDir;
    const binPath = findReleaseLabBin(preferredDir) ?? findReleaseLabBin(versionDir);
    const skillRoot = findReleaseLabSkillRoot(preferredDir) ?? findReleaseLabSkillRoot(versionDir);
    if (binPath !== null || skillRoot !== null) {
      return {
        installed: true,
        enabled: true,
        status: "running",
        path: preferredDir,
        binPath,
        skillRoot,
      };
    }
  }

  return { installed: false, enabled: false, status: "not_installed", path: null, binPath: null, skillRoot: null };
}

/**
 * Reads `<paseoHome>/release-lab/runs/*.json` and returns the latest matching
 * run summary and active `Hole` summary for `project`.
 */
export function readLatestStoreReleaseRun(
  paseoHome: string,
  project: { slug: string; root: string },
): { lastRun: StoreReleaseRunInfo | null; activeHole: StoreReleaseHoleInfo | null } {
  const runsDir = join(paseoHome, "release-lab", "runs");
  const files = listDirNames(runsDir).filter((name) => name.endsWith(".json"));
  if (files.length === 0) return { lastRun: null, activeHole: null };

  const normalizedProjectRoot = normalizeFsPath(project.root);
  const candidates: Array<{
    sortUpdated: number;
    sortCreated: number;
    id: string;
    lastRun: StoreReleaseRunInfo;
    activeHole: StoreReleaseHoleInfo | null;
  }> = [];

  for (const file of files) {
    const record = readJsonObject(join(runsDir, file));
    if (record === null) continue;
    const id = typeof record.id === "string" && record.id.trim() !== "" ? record.id.trim() : null;
    const playbook = typeof record.playbook === "string" ? record.playbook : null;
    const status = typeof record.status === "string" ? record.status : null;
    if (id === null || playbook === null || status === null) continue;

    const runRoot = typeof record.projectRoot === "string" && record.projectRoot.trim() !== "" ? record.projectRoot.trim() : null;
    if (runRoot !== null) {
      if (normalizeFsPath(runRoot) !== normalizedProjectRoot) continue;
    } else if (record.projectSlug !== project.slug) {
      continue;
    }

    const createdAtIso = toIsoTimestamp(record.createdAt) ?? new Date(0).toISOString();
    const updatedAtIso = toIsoTimestamp(record.updatedAt) ?? createdAtIso;
    const completedAtIso = toIsoTimestamp(record.completedAt);
    const platforms = Array.isArray(record.platforms)
      ? record.platforms.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : [];

    candidates.push({
      sortUpdated: parseTimestampMs(record.updatedAt) ?? parseTimestampMs(record.createdAt) ?? 0,
      sortCreated: parseTimestampMs(record.createdAt) ?? 0,
      id,
      lastRun: {
        id,
        playbook,
        status,
        platforms,
        createdAt: createdAtIso,
        updatedAt: updatedAtIso,
        completedAt: completedAtIso,
        error: typeof record.error === "string" && record.error.trim() !== "" ? record.error : null,
        failure: parseStoreReleaseFailure(record.failure),
      },
      activeHole: extractActiveHole(id, record, updatedAtIso),
    });
  }

  if (candidates.length === 0) return { lastRun: null, activeHole: null };
  candidates.sort((a, b) => {
    if (b.sortUpdated !== a.sortUpdated) return b.sortUpdated - a.sortUpdated;
    if (b.sortCreated !== a.sortCreated) return b.sortCreated - a.sortCreated;
    return b.id.localeCompare(a.id);
  });

  const latest = candidates[0]!;
  return { lastRun: latest.lastRun, activeHole: latest.activeHole };
}
