/**
 * Pure filesystem probes for Store release surface state (ADR 0066):
 * - Mobile platform detection (`android`, `ios`, `expo`)
 * - Latest matching run and active `Hole` summary from `<paseoHome>/release-lab/runs/`
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export type StoreReleasePlatform = "android" | "ios" | "expo";

export interface StoreReleaseHoleInfo {
  runId: string;
  kind: string;
  phase: string;
  pausedAt: string;
  defaultResolution?: unknown;
  resolutionSpec?: unknown;
}

export interface StoreReleaseFailureInfo {
  failureClass: "app-repo" | "tool-bug" | "account-policy";
  platform?: "android" | "ios";
  phase?: string;
  code: string;
  message: string;
  upstreamIssuePath?: string;
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

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
    const toolchain =
      typeof manifest.toolchain === "object" && manifest.toolchain !== null && !Array.isArray(manifest.toolchain)
        ? (manifest.toolchain as Record<string, unknown>)
        : null;
    if (manifest.projectKind === "expo" || toolchain?.expoPrebuild === true) {
      detected.add("expo");
    }
  }

  const appJson = readJsonObject(join(projectRoot, "app.json"));
  const expoBlock =
    appJson !== null && typeof appJson.expo === "object" && appJson.expo !== null && !Array.isArray(appJson.expo)
      ? (appJson.expo as Record<string, unknown>)
      : null;
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
      if (typeof section === "object" && section !== null && !Array.isArray(section)) {
        const deps = section as Record<string, unknown>;
        if ("expo" in deps || "expo-router" in deps) detected.add("expo");
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

function parseFailureInfo(raw: unknown): StoreReleaseFailureInfo | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const failureClass = rec.failureClass;
  if (failureClass !== "app-repo" && failureClass !== "tool-bug" && failureClass !== "account-policy") return null;
  if (typeof rec.code !== "string" || typeof rec.message !== "string") return null;
  return {
    failureClass,
    ...(rec.platform === "android" || rec.platform === "ios" ? { platform: rec.platform } : {}),
    ...(typeof rec.phase === "string" ? { phase: rec.phase } : {}),
    code: rec.code,
    message: rec.message,
    ...(typeof rec.upstreamIssuePath === "string" && rec.upstreamIssuePath.trim() !== ""
      ? { upstreamIssuePath: rec.upstreamIssuePath }
      : {}),
  };
}

function extractActiveHole(runId: string, record: Record<string, unknown>, fallbackIso: string): StoreReleaseHoleInfo | null {
  if (record.status !== "paused-hole" || !Array.isArray(record.phases)) return null;
  for (const rawPhase of record.phases) {
    if (typeof rawPhase !== "object" || rawPhase === null || Array.isArray(rawPhase)) continue;
    const phase = rawPhase as Record<string, unknown>;
    const hole =
      typeof phase.hole === "object" && phase.hole !== null && !Array.isArray(phase.hole)
        ? (phase.hole as Record<string, unknown>)
        : null;
    if (hole === null) continue;
    if (phase.state !== "paused-hole" && hole.resumedAt !== undefined) continue;
    if (typeof phase.id !== "string" || typeof hole.kind !== "string") continue;
    return {
      runId,
      kind: hole.kind,
      phase: phase.id,
      pausedAt: toIsoTimestamp(hole.pausedAt) ?? fallbackIso,
      ...(hole.defaultResolution !== undefined ? { defaultResolution: hole.defaultResolution } : {}),
      ...(hole.resolutionSpec !== undefined ? { resolutionSpec: hole.resolutionSpec } : {}),
    };
  }
  return null;
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
        failure: parseFailureInfo(record.failure),
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
