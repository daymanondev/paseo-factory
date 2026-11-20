/**
 * Store Release Server Bridge (ADR 0066):
 * runs strictly inside the plugin server (never inside bridge.mjs or a seat
 * shell), locating `factory-release-lab` under `<paseoHome>/plugins/factory-release-lab/`,
 * checking preconditions in strict order, running `probe` synchronously and
 * `stage` / `submit` / `resume` asynchronously in the background with `PASEO_HOME`
 * and Finder-safe `PATH`, recording Project-level Ledger events, writing back
 * Day-0 Android upload keystores, waking Lead via mailbox, and managing the
 * Vault-only `Store notebook`.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  StoreReleaseAction,
  StoreReleaseFailureClass,
  StoreReleaseMode,
} from "./core/events.ts";
import { FactoryError } from "./core/errors.ts";
import type { Factory } from "./core/factory.ts";
import {
  clearStoreReleaseRequest,
  readStoreReleaseRequest,
  readStoreReleaseSettings,
  type StoreReleaseRequest,
} from "./core/project-settings.ts";
import {
  detectMobilePlatforms,
  type StoreReleasePlatform,
} from "./core/store-release-probe.ts";
import {
  buildVaultPath,
  builtinVaultRunner,
  loadVaultConfig,
  pushVault,
  readVaultRuntimeEnv,
  readVaultStoreReadiness,
  writeBackAndroidKeystore,
  writeStoreAppNotebook,
  writeStoreLessons,
  type VaultRunner,
  type VaultStoreReadiness,
} from "./core/vault.ts";
import { readVaultManifestAt } from "./core/vault-materialization.ts";
import { listDaemonPlugins, type DaemonPluginItem } from "./daemon-cli.ts";
import { resolveManagedPluginDir } from "./paths.ts";
import { checkRepoReleaseIntegrity } from "./release.ts";

export type StoreReleasePlatformTarget = "android" | "ios";

export interface StoreReleaseRunnerCall {
  binPath: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

export interface StoreReleaseRunnerOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type StoreReleaseRunner = (call: StoreReleaseRunnerCall) => Promise<StoreReleaseRunnerOutput>;

export interface StoreReleaseInput {
  factory: Factory;
  stateDir: string;
  paseoHome: string;
  projectSlug: string;
  projectRoot: string;
  action: StoreReleaseAction;
  platforms?: StoreReleasePlatformTarget[];
  runId?: string;
  resolution?: unknown;
  runner?: StoreReleaseRunner;
  vaultRunner?: VaultRunner;
  listPlugins?: typeof listDaemonPlugins;
  notifyLead?: (input: { slug: string; text: string }) => Promise<void> | void;
}

export type StoreReleaseResult =
  | {
      ok: true;
      action: "probe";
      mode: StoreReleaseMode;
      vault: VaultStoreReadiness;
      detectedPlatforms: StoreReleasePlatform[];
      platforms: StoreReleasePlatformTarget[];
      runner: { binPath: string };
      probe: unknown;
    }
  | {
      ok: true;
      started: true;
      action: Exclude<StoreReleaseAction, "probe">;
      runId: string;
      mode: StoreReleaseMode;
      platforms: StoreReleasePlatformTarget[];
      runner: { binPath: string };
      /** Background completion handle (awaited by tests; fire-and-forget from Spool). */
      settled: Promise<void>;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export interface RecordStoreNoteInput {
  paseoHome: string;
  target: "lessons" | "app";
  content: string;
  appKey?: string;
  projectRoot?: string;
  projectSlug?: string;
  sync?: boolean;
  vaultRunner?: VaultRunner;
}

export type RecordStoreNoteResult =
  | {
      ok: true;
      target: "lessons" | "app";
      path: string;
      appKey?: string;
      synced: boolean;
      pushed: boolean;
      syncError?: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

const RUNNER_PLUGIN_ID = "factory-release-lab";
const MAX_DIAGNOSTIC_TAIL_CHARS = 2000;
const MAX_DIAGNOSTIC_TAIL_LINES = 40;
const DEFAULT_RUNNER_TIMEOUT_MS = 35 * 60 * 1000;
const DEFAULT_RUNNER_MAX_BUFFER = 8 * 1024 * 1024;

export const builtinStoreReleaseRunner: StoreReleaseRunner = (call) =>
  new Promise<StoreReleaseRunnerOutput>((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [call.binPath, ...call.args],
      {
        cwd: call.cwd,
        env: { ...process.env, ...call.env },
        encoding: "utf8",
        timeout: DEFAULT_RUNNER_TIMEOUT_MS,
        maxBuffer: DEFAULT_RUNNER_MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === "string" && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(err);
          return;
        }
        const errRec = err as unknown as { status?: unknown; code?: unknown } | null;
        const exitCode =
          err === null
            ? 0
            : typeof errRec?.status === "number"
              ? errRec.status
              : typeof errRec?.code === "number"
                ? errRec.code
                : 1;
        resolvePromise({
          exitCode,
          stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
          stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
        });
      },
    );
  });

function resolveRunnerBinFromPluginDir(pluginDir: string): string | null {
  const candidates = [
    join(pluginDir, "bin", "release-lab.mjs"),
    join(pluginDir, "..", "bin", "release-lab.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function scanManagedReleaseLabDirs(paseoHome: string): string | null {
  const managedRoot = join(paseoHome, "plugins", RUNNER_PLUGIN_ID);
  const direct = resolveRunnerBinFromPluginDir(managedRoot);
  if (direct !== null) return direct;

  let entries;
  try {
    entries = readdirSync(managedRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const ranked: Array<{ binPath: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const versionDir = join(managedRoot, entry.name);
    for (const candidateDir of [join(versionDir, "plugin"), versionDir]) {
      const binPath = resolveRunnerBinFromPluginDir(candidateDir);
      if (binPath === null) continue;
      try {
        const mtime = Math.max(statSync(versionDir).mtimeMs, statSync(binPath).mtimeMs);
        ranked.push({ binPath, mtime });
        break;
      } catch {
        // skip unreadable candidate
      }
    }
  }
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => b.mtime - a.mtime);
  return ranked[0]!.binPath;
}

function readConfigJsonPluginPath(paseoHome: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8")) as {
      plugins?: Record<string, { path?: unknown; enabled?: unknown }>;
    };
    const entry = raw?.plugins?.[RUNNER_PLUGIN_ID];
    if (entry && entry.enabled !== false && typeof entry.path === "string" && entry.path.trim() !== "") {
      return entry.path;
    }
  } catch {
    // ignore missing or unreadable config.json
  }
  return null;
}

/**
 * Resolves `<binPath>` for `factory-release-lab` under `<paseoHome>/plugins/factory-release-lab/`,
 * checking `listDaemonPlugins`, `config.json`, and managed versioned subdirectories
 * (both `<pluginDir>/bin/release-lab.mjs` and `<pluginDir>/../bin/release-lab.mjs`).
 */
export async function resolveStoreReleaseRunnerBin(
  paseoHome: string,
  listPlugins: typeof listDaemonPlugins = listDaemonPlugins,
): Promise<{ binPath: string } | null> {
  let listed: DaemonPluginItem | undefined;
  let daemonAnswered = false;
  try {
    const result = await listPlugins(paseoHome);
    if (result.ok) {
      daemonAnswered = true;
      listed = result.plugins.find((plugin) => plugin.id === RUNNER_PLUGIN_ID);
    }
  } catch {
    // fall back to filesystem discovery when daemon is offline
  }

  if (daemonAnswered) {
    if (listed === undefined || listed.enabled === false) return null;
    const resolvedDir = resolveManagedPluginDir(paseoHome, listed.path, RUNNER_PLUGIN_ID);
    const binPath = resolveRunnerBinFromPluginDir(resolvedDir);
    return binPath !== null ? { binPath } : null;
  }

  const configPath = readConfigJsonPluginPath(paseoHome);
  if (configPath !== null) {
    const resolvedDir = resolveManagedPluginDir(paseoHome, configPath, RUNNER_PLUGIN_ID);
    const binPath = resolveRunnerBinFromPluginDir(resolvedDir);
    if (binPath !== null) return { binPath };
  }

  const scanned = scanManagedReleaseLabDirs(paseoHome);
  return scanned !== null ? { binPath: scanned } : null;
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

function readRunHoleInfo(paseoHome: string, runId: string): { holeKind: string | null; platforms: StoreReleasePlatformTarget[] } {
  const record = readJsonObject(join(paseoHome, "release-lab", "runs", `${runId}.json`));
  if (record === null) return { holeKind: null, platforms: [] };
  const platforms = Array.isArray(record.platforms)
    ? record.platforms.filter((p): p is StoreReleasePlatformTarget => p === "android" || p === "ios")
    : [];
  if (record.status !== "paused-hole" || !Array.isArray(record.phases)) {
    return { holeKind: null, platforms };
  }
  for (const rawPhase of record.phases) {
    if (typeof rawPhase !== "object" || rawPhase === null || Array.isArray(rawPhase)) continue;
    const phase = rawPhase as Record<string, unknown>;
    const hole = typeof phase.hole === "object" && phase.hole !== null && !Array.isArray(phase.hole)
      ? (phase.hole as Record<string, unknown>)
      : null;
    if (hole === null) continue;
    if (phase.state !== "paused-hole" && hole.resumedAt !== undefined) continue;
    if (typeof hole.kind === "string") return { holeKind: hole.kind, platforms };
  }
  return { holeKind: null, platforms };
}

function isApprovingResolution(resolution: unknown): boolean {
  if (resolution === undefined) return true;
  if (typeof resolution === "object" && resolution !== null && !Array.isArray(resolution)) {
    const rec = resolution as Record<string, unknown>;
    if (rec.approved === true) return true;
    if (rec.approved === false) return false;
  }
  return false;
}

function missingVaultVariables(paseoHome: string, platforms: readonly StoreReleasePlatformTarget[]): string[] {
  const env = readVaultRuntimeEnv(paseoHome);
  const missing: string[] = [];
  const present = (val: string | undefined): boolean => typeof val === "string" && val.trim() !== "";
  if (platforms.includes("ios")) {
    for (const key of ["ASC_KEY_PATH", "ASC_KEY_ID", "ASC_ISSUER", "APPLE_TEAM_ID"] as const) {
      if (!present(env[key])) missing.push(key);
    }
  }
  if (platforms.includes("android")) {
    if (!present(env.GPLAY_KEY_PATH)) missing.push("GPLAY_KEY_PATH");
  }
  return missing;
}

function pendingRequestMatches(
  pending: StoreReleaseRequest,
  input: Pick<StoreReleaseInput, "action" | "platforms" | "runId">,
): boolean {
  if (input.action === "resume" && pending.resumeRunId !== undefined && input.runId !== undefined) {
    if (pending.resumeRunId !== input.runId.trim()) return false;
  }
  if (input.platforms !== undefined && input.platforms.length > 0 && pending.platforms !== undefined) {
    for (const p of input.platforms) {
      if (!pending.platforms.includes(p)) return false;
    }
  }
  return true;
}

function trimDiagnosticTail(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const lines = trimmed.split(/\r?\n/);
  const tailLines = lines.length > MAX_DIAGNOSTIC_TAIL_LINES ? lines.slice(-MAX_DIAGNOSTIC_TAIL_LINES) : lines;
  const joined = tailLines.join("\n");
  return joined.length > MAX_DIAGNOSTIC_TAIL_CHARS ? joined.slice(-MAX_DIAGNOSTIC_TAIL_CHARS) : joined;
}

interface ParsedRunnerFailure {
  failureClass: StoreReleaseFailureClass;
  code: string;
  message: string;
  phase?: string;
  platform?: string;
  logTail?: string;
  hint?: string;
  upstreamIssuePath?: string;
}

interface ParsedRunnerSummary {
  id?: string;
  status?: string;
  platforms?: string[];
  error?: string | null;
  failure?: ParsedRunnerFailure | null;
  phases?: Array<{
    id?: string;
    state?: string;
    output?: unknown;
    hole?: string;
    error?: string;
    failure?: ParsedRunnerFailure;
  }>;
  pausedAtHole?: {
    phase?: string;
    kind?: string;
    payload?: unknown;
    resolutionSpec?: unknown;
    defaultResolution?: unknown;
  } | null;
}

function parseJsonSafe(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseFailureObject(raw: unknown): ParsedRunnerFailure | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const fc = rec.failureClass;
  const failureClass: StoreReleaseFailureClass =
    fc === "app-repo" || fc === "tool-bug" || fc === "account-policy" ? fc : "tool-bug";
  const code = typeof rec.code === "string" && rec.code.trim() !== "" ? rec.code.trim() : "runner-failed";
  const message = typeof rec.message === "string" && rec.message.trim() !== "" ? rec.message.trim() : code;
  return {
    failureClass,
    code,
    message,
    ...(typeof rec.phase === "string" ? { phase: rec.phase } : {}),
    ...(typeof rec.platform === "string" ? { platform: rec.platform } : {}),
    ...(typeof rec.logTail === "string" && rec.logTail.trim() !== "" ? { logTail: trimDiagnosticTail(rec.logTail) } : {}),
    ...(typeof rec.hint === "string" && rec.hint.trim() !== "" ? { hint: rec.hint.trim() } : {}),
    ...(typeof rec.upstreamIssuePath === "string" && rec.upstreamIssuePath.trim() !== ""
      ? { upstreamIssuePath: rec.upstreamIssuePath.trim() }
      : {}),
  };
}

function extractCreatedAndroidKeystore(
  summary: ParsedRunnerSummary | null,
): { path: string; alias?: string } | null {
  if (!summary || !Array.isArray(summary.phases)) return null;
  const day0 = summary.phases.find((p) => p.id === "phase-2-day0-and-signing");
  if (!day0 || typeof day0.output !== "object" || day0.output === null || Array.isArray(day0.output)) return null;
  const output = day0.output as Record<string, unknown>;
  const keystore =
    typeof output.keystore === "object" && output.keystore !== null && !Array.isArray(output.keystore)
      ? (output.keystore as Record<string, unknown>)
      : null;
  if (keystore === null) return null;
  const created = keystore.created === true || output.keystoreCreated === true;
  if (!created || typeof keystore.path !== "string" || keystore.path.trim() === "") return null;
  return {
    path: keystore.path.trim(),
    ...(typeof keystore.alias === "string" && keystore.alias.trim() !== "" ? { alias: keystore.alias.trim() } : {}),
  };
}

function buildCliArgs(input: {
  action: StoreReleaseAction;
  projectRoot: string;
  projectSlug: string;
  runId?: string;
  resolution?: unknown;
}): string[] {
  switch (input.action) {
    case "probe":
      return ["probe", "--project", input.projectRoot];
    case "stage":
      return ["run", "--playbook", "stage-release", "--project", input.projectRoot, "--slug", input.projectSlug];
    case "submit":
      return [
        "submit-production",
        "--project",
        input.projectRoot,
        "--slug",
        input.projectSlug,
        ...(input.runId !== undefined ? ["--run", input.runId] : []),
        "--approve",
      ];
    case "resume":
      return [
        "resume",
        "--run",
        input.runId!,
        ...(input.resolution !== undefined ? ["--resolution", JSON.stringify(input.resolution)] : ["--approve"]),
      ];
  }
}

export async function storeReleaseProject(input: StoreReleaseInput): Promise<StoreReleaseResult> {
  const runner = input.runner ?? builtinStoreReleaseRunner;
  const vaultRunner = input.vaultRunner ?? builtinVaultRunner;

  const fail = (code: string, message: string): StoreReleaseResult => ({ ok: false, code, message });

  // 1. Mode gate
  const settings = readStoreReleaseSettings(input.stateDir, input.projectSlug);
  if (settings.mode === "off") {
    return fail(
      "store-release-not-granted",
      "Store release mode is off for this Project; the Owner must enable on-request or auto-staging in the Store Release card.",
    );
  }

  const pendingRequest = readStoreReleaseRequest(input.stateDir, input.projectSlug);
  if (settings.mode === "on-request") {
    if (pendingRequest === undefined || !pendingRequestMatches(pendingRequest, input)) {
      return fail(
        "no-store-release-intent",
        "Store release mode is on-request and there is no matching pending Store release request from the Owner.",
      );
    }
  }

  const effectiveRunId = input.runId?.trim() || pendingRequest?.resumeRunId?.trim() || undefined;
  if (input.action === "resume" && effectiveRunId === undefined) {
    return fail("missing-run-id", "resume requires `runId` (or a pending Store release request with `resumeRunId`).");
  }
  const effectiveResolution = input.resolution !== undefined ? input.resolution : pendingRequest?.resolution;

  const runHoleInfo = effectiveRunId !== undefined ? readRunHoleInfo(input.paseoHome, effectiveRunId) : { holeKind: null, platforms: [] };
  const isFinalApprovalResume =
    input.action === "resume" &&
    (runHoleInfo.holeKind === "final-release-approval" ||
      (runHoleInfo.holeKind === null &&
        typeof effectiveResolution === "object" &&
        effectiveResolution !== null &&
        (effectiveResolution as Record<string, unknown>).approved === true)) &&
    isApprovingResolution(effectiveResolution);

  if (input.action === "submit" || isFinalApprovalResume) {
    if (pendingRequest?.target !== "production") {
      return fail(
        "production-approval-required",
        "Production rollout / App Store submission requires explicit Owner production approval (Store release request target=production or final-release-approval Hole resolution).",
      );
    }
  }

  // 2. Runner & Vault gate
  const runnerBin = await resolveStoreReleaseRunnerBin(input.paseoHome, input.listPlugins);
  if (runnerBin === null) {
    return fail(
      "runner-not-installed",
      "factory-release-lab companion plugin is not installed or enabled under <paseoHome>/plugins/factory-release-lab/.",
    );
  }

  const detectedPlatforms = detectMobilePlatforms(input.projectRoot);
  const detectedTargets = detectedPlatforms.filter(
    (p): p is StoreReleasePlatformTarget => p === "android" || p === "ios",
  );
  const effectivePlatforms: StoreReleasePlatformTarget[] =
    input.platforms !== undefined && input.platforms.length > 0
      ? [...new Set(input.platforms)]
      : pendingRequest?.platforms !== undefined && pendingRequest.platforms.length > 0
        ? [...new Set(pendingRequest.platforms)]
        : detectedTargets.length > 0
          ? detectedTargets
          : runHoleInfo.platforms;

  const missingCreds = missingVaultVariables(input.paseoHome, effectivePlatforms);
  if (missingCreds.length > 0) {
    return fail(
      "vault-credentials-missing",
      `Missing Private vault store credentials: ${missingCreds.join(", ")}. Import them in Private vault before running Store release.`,
    );
  }

  // 3. Repo integrity gate (for stage and submit; relaxed for read-only probe and resume)
  if (input.action === "stage" || input.action === "submit") {
    const integrity = await checkRepoReleaseIntegrity({
      factory: input.factory,
      projectRoot: input.projectRoot,
      runner: vaultRunner,
    });
    if (!integrity.ok) {
      return fail(integrity.code, integrity.message);
    }
  }

  const runnerEnv: Record<string, string> = {
    PASEO_HOME: input.paseoHome,
    PATH: buildVaultPath(process.env.PATH ?? ""),
  };
  const cliArgs = buildCliArgs({
    action: input.action,
    projectRoot: input.projectRoot,
    projectSlug: input.projectSlug,
    runId: effectiveRunId,
    resolution: effectiveResolution,
  });

  // Fast synchronous path for `probe`
  if (input.action === "probe") {
    let out: StoreReleaseRunnerOutput;
    try {
      out = await runner({
        binPath: runnerBin.binPath,
        args: cliArgs,
        cwd: input.projectRoot,
        env: runnerEnv,
      });
    } catch (error) {
      return fail(
        "runner-spawn-failed",
        `failed to execute release-lab probe: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (out.exitCode !== 0) {
      const errJson = parseJsonSafe(out.stderr);
      const parsedErr = parseFailureObject(errJson?.failure);
      const detail = parsedErr?.message ?? (trimDiagnosticTail(out.stderr) || `release-lab probe exited with code ${out.exitCode}`);
      return fail(parsedErr?.code ?? "probe-failed", detail);
    }
    const probeJson = parseJsonSafe(out.stdout) ?? { raw: out.stdout.trim() };
    return {
      ok: true,
      action: "probe",
      mode: settings.mode,
      vault: readVaultStoreReadiness(input.paseoHome),
      detectedPlatforms,
      platforms: effectivePlatforms,
      runner: { binPath: runnerBin.binPath },
      probe: probeJson,
    };
  }

  // Background asynchronous path for `stage`, `submit`, `resume`
  const action = input.action;
  const trackingRunId = effectiveRunId ?? `store-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  input.factory.ledger.append({
    event: "store_release_started",
    runId: trackingRunId,
    action,
    platforms: effectivePlatforms,
    mode: settings.mode,
  });

  const settle = async (): Promise<void> => {
    let out: StoreReleaseRunnerOutput;
    try {
      out = await runner({
        binPath: runnerBin.binPath,
        args: cliArgs,
        cwd: input.projectRoot,
        env: runnerEnv,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await input.factory.history.runOperation(() => {
        input.factory.ledger.append({
          event: "store_release_failed",
          runId: trackingRunId,
          action,
          failureClass: "tool-bug",
          code: "runner-spawn-failed",
          detail,
        });
      });
      await input.notifyLead?.({
        slug: input.projectSlug,
        text: [
          `[Store release failed] action=${action} runId=${trackingRunId} failureClass=tool-bug code=runner-spawn-failed`,
          `Detail: ${detail}`,
          `Policy: tool-bug — halt immediately, do NOT dispatch an app Peer to work around the runner, and report to Supervisor.`,
        ].join("\n"),
      });
      return;
    }

    const stdoutObj = parseJsonSafe(out.stdout) as ParsedRunnerSummary | null;
    const stderrObj = parseJsonSafe(out.stderr);
    const settledRunId =
      typeof stdoutObj?.id === "string" && stdoutObj.id.trim() !== "" ? stdoutObj.id.trim() : trackingRunId;
    const settledPlatforms = Array.isArray(stdoutObj?.platforms)
      ? stdoutObj.platforms.filter((p): p is string => typeof p === "string" && p.trim() !== "")
      : effectivePlatforms;

    // Day-0 Android keystore write-back whenever phase-2 reports a newly created keystore
    let keystoreWriteBackNote: string | undefined;
    const createdKeystore = extractCreatedAndroidKeystore(stdoutObj);
    if (createdKeystore !== null && existsSync(createdKeystore.path)) {
      try {
        const wb = await writeBackAndroidKeystore(input.paseoHome, {
          keystorePath: createdKeystore.path,
          projectRoot: input.projectRoot,
          ...(createdKeystore.alias !== undefined ? { keyAlias: createdKeystore.alias } : {}),
          runner: vaultRunner,
        });
        keystoreWriteBackNote = wb.summary;
      } catch (err) {
        keystoreWriteBackNote = `keystore write-back warning: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (stdoutObj?.status === "paused-hole") {
      const pausedHole = stdoutObj.pausedAtHole;
      const holePhase =
        (typeof pausedHole?.phase === "string" && pausedHole.phase.trim() !== "" ? pausedHole.phase.trim() : undefined) ??
        stdoutObj.phases?.find((p) => p.state === "paused-hole")?.id ??
        "unknown-phase";
      const holeKind =
        (typeof pausedHole?.kind === "string" && pausedHole.kind.trim() !== "" ? pausedHole.kind.trim() : undefined) ??
        stdoutObj.phases?.find((p) => p.state === "paused-hole")?.hole ??
        "unknown-hole";

      await input.factory.history.runOperation(() => {
        input.factory.ledger.append({
          event: "store_release_paused",
          runId: settledRunId,
          holeKind,
          phase: holePhase,
        });
      });

      const holeSummaryLines = [
        `[Store release paused at Hole] action=${action} runId=${settledRunId} phase=${holePhase} holeKind=${holeKind}`,
        ...(pausedHole?.payload !== undefined ? [`Payload: ${JSON.stringify(pausedHole.payload)}`] : []),
        ...(pausedHole?.resolutionSpec !== undefined ? [`Resolution spec: ${JSON.stringify(pausedHole.resolutionSpec)}`] : []),
        ...(keystoreWriteBackNote ? [`Vault write-back: ${keystoreWriteBackNote}`] : []),
        `Next: Report this Hole summary to Supervisor so the Owner can approve/resolve it (in Supervisor chat or Release Lab UI) and dispatch resume.`,
      ];
      await input.notifyLead?.({
        slug: input.projectSlug,
        text: holeSummaryLines.join("\n"),
      });
      return;
    }

    if (out.exitCode === 0 && (stdoutObj?.status === "completed" || stdoutObj === null)) {
      const summary = `Store release ${action} completed (${settledPlatforms.join(", ") || "default"})`;
      await input.factory.history.runOperation(() => {
        if (settings.mode === "on-request") {
          clearStoreReleaseRequest(input.stateDir, input.projectSlug);
        }
        input.factory.ledger.append({
          event: "store_release_completed",
          runId: settledRunId,
          action,
          platforms: settledPlatforms,
          summary,
        });
      });
      await input.notifyLead?.({
        slug: input.projectSlug,
        text: [
          `[Store release completed] action=${action} runId=${settledRunId} platforms=${settledPlatforms.join(",") || "default"}`,
          ...(keystoreWriteBackNote ? [`Vault write-back: ${keystoreWriteBackNote}`] : []),
          `Next: Update per-app Store notebook card if appropriate and report completion to Supervisor.`,
        ].join("\n"),
      });
      return;
    }

    // Failed outcome (either stdout run status="failed" or non-zero exit with stderr JSON / text)
    const failure =
      parseFailureObject(stdoutObj?.failure) ??
      parseFailureObject(stdoutObj?.phases?.find((p) => p.failure)?.failure) ??
      parseFailureObject(stderrObj?.failure);

    const failureClass: StoreReleaseFailureClass = failure?.failureClass ?? "tool-bug";
    const code = failure?.code ?? (out.exitCode !== 0 ? "runner-exited-nonzero" : "store-release-failed");
    const detail =
      failure?.message ??
      (typeof stdoutObj?.error === "string" && stdoutObj.error.trim() !== "" ? stdoutObj.error.trim() : undefined) ??
      (typeof stderrObj?.error === "string" && stderrObj.error.trim() !== "" ? stderrObj.error.trim() : undefined) ??
      (trimDiagnosticTail(out.stderr) || `release-lab ${action} exited with code ${out.exitCode}`);
    const upstreamIssuePath = failure?.upstreamIssuePath;
    const diagnosticTail = failure?.logTail ?? trimDiagnosticTail(out.stderr || out.stdout);

    await input.factory.history.runOperation(() => {
      input.factory.ledger.append({
        event: "store_release_failed",
        runId: settledRunId,
        action,
        failureClass,
        code,
        detail,
        ...(upstreamIssuePath !== undefined ? { upstreamIssuePath } : {}),
      });
    });

    const routePolicy =
      failureClass === "app-repo"
        ? "Policy: app-repo — dispatch a bounded Peer repair wave (max 2 repair attempts per store release) through Gate before retrying."
        : `Policy: ${failureClass} — halt immediately, do NOT dispatch an app Peer to work around the runner, and report directly to Supervisor.`;

    await input.notifyLead?.({
      slug: input.projectSlug,
      text: [
        `[Store release failed] action=${action} runId=${settledRunId} failureClass=${failureClass} code=${code}`,
        `Detail: ${detail}`,
        ...(upstreamIssuePath !== undefined ? [`Upstream issue: ${upstreamIssuePath}`] : []),
        ...(diagnosticTail !== "" ? [`Diagnostic tail:\n${diagnosticTail}`] : []),
        ...(keystoreWriteBackNote ? [`Vault write-back: ${keystoreWriteBackNote}`] : []),
        routePolicy,
      ].join("\n"),
    });
  };

  const settled = settle().catch((err) => {
    void input.notifyLead?.({
      slug: input.projectSlug,
      text: `[Store release internal error] action=${action} runId=${trackingRunId}: ${err instanceof Error ? err.message : String(err)}`,
    });
  });

  return {
    ok: true,
    started: true,
    action,
    runId: trackingRunId,
    mode: settings.mode,
    platforms: effectivePlatforms,
    runner: { binPath: runnerBin.binPath },
    settled,
  };
}

function resolveAppKeyForStoreNote(input: RecordStoreNoteInput): string | null {
  if (typeof input.appKey === "string" && input.appKey.trim() !== "") {
    return input.appKey.trim();
  }
  const runtimeRoot = join(input.paseoHome, "vault-runtime");
  const vaultRoot = join(input.paseoHome, "vault");
  const manifest = existsSync(join(runtimeRoot, "vault.manifest.json"))
    ? readVaultManifestAt(runtimeRoot)
    : readVaultManifestAt(vaultRoot);

  if (input.projectRoot !== undefined && input.projectRoot.trim() !== "") {
    const storeManifest = readJsonObject(join(input.projectRoot, ".store-release", "manifest.json"));
    if (typeof storeManifest?.appKey === "string" && storeManifest.appKey.trim() !== "") {
      return storeManifest.appKey.trim();
    }
    const bundleId = typeof storeManifest?.bundleId === "string" ? storeManifest.bundleId.trim() : null;
    const packageName = typeof storeManifest?.packageName === "string" ? storeManifest.packageName.trim() : null;
    for (const [key, entry] of Object.entries(manifest)) {
      if (bundleId && entry.bundleId === bundleId) return key;
      if (packageName && entry.packageName === packageName) return key;
    }
  }
  if (typeof input.projectSlug === "string" && input.projectSlug.trim() !== "") {
    return input.projectSlug.trim();
  }
  if (typeof input.projectRoot === "string" && input.projectRoot.trim() !== "") {
    return basename(input.projectRoot.trim());
  }
  return null;
}

/**
 * Server-side Store notebook write act (ADR 0066 §5):
 * writes exclusively to `<paseoHome>/vault-runtime/store-memory/` (`0o400`),
 * enforces the `<= 120`-line cap on `lessons.md`, and stages/pushes to Private
 * vault when configured — never touching `<project-root>`.
 */
export async function recordStoreNote(input: RecordStoreNoteInput): Promise<RecordStoreNoteResult> {
  try {
    let writtenPath: string;
    let resolvedAppKey: string | undefined;
    if (input.target === "lessons") {
      writtenPath = writeStoreLessons(input.paseoHome, input.content);
    } else if (input.target === "app") {
      const key = resolveAppKeyForStoreNote(input);
      if (key === null || key === "") {
        return {
          ok: false,
          code: "store-notebook-app-key-required",
          message: "target=app requires `appKey` or a resolvable Project workspace/slug.",
        };
      }
      resolvedAppKey = key;
      writtenPath = writeStoreAppNotebook(input.paseoHome, key, input.content);
    } else {
      return {
        ok: false,
        code: "invalid-store-notebook-target",
        message: `Store notebook target must be "lessons" or "app".`,
      };
    }

    const config = loadVaultConfig(input.paseoHome);
    const vaultConfigured = config !== null && config.repo.trim() !== "";
    if (!vaultConfigured || input.sync === false) {
      return {
        ok: true,
        target: input.target,
        path: writtenPath,
        ...(resolvedAppKey !== undefined ? { appKey: resolvedAppKey } : {}),
        synced: false,
        pushed: false,
      };
    }

    try {
      const pushResult = await pushVault(input.paseoHome, { runner: input.vaultRunner ?? builtinVaultRunner });
      return {
        ok: true,
        target: input.target,
        path: writtenPath,
        ...(resolvedAppKey !== undefined ? { appKey: resolvedAppKey } : {}),
        synced: true,
        pushed: pushResult.pushed,
      };
    } catch (err) {
      return {
        ok: true,
        target: input.target,
        path: writtenPath,
        ...(resolvedAppKey !== undefined ? { appKey: resolvedAppKey } : {}),
        synced: false,
        pushed: false,
        syncError: err instanceof Error ? err.message : String(err),
      };
    }
  } catch (err) {
    if (err instanceof FactoryError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return {
      ok: false,
      code: "store-notebook-write-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
