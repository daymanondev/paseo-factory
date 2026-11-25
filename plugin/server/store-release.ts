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
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
  discoverReleaseLabInstall,
  isPlainRecord,
  parseJsonObject,
  parseRunnerFailure,
  readJsonObject,
  readStoreReleaseRunHoleInfo,
  RELEASE_LAB_PLUGIN_ID,
  trimDiagnosticTail,
  type ReleaseLabCompanionStatus,
  type StoreReleasePlatform,
  type StoreReleaseRunnerFailure,
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
import { checkRepoReleaseIntegrity } from "./release.ts";

export type StoreReleasePlatformTarget = "android" | "ios";

export interface StoreReleaseRunnerCall {
  binPath: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  graceMs?: number;
}

export interface StoreReleaseRunnerOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
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
  timeoutMs?: number;
  graceMs?: number;
  runner?: StoreReleaseRunner;
  vaultRunner?: VaultRunner;
  listPlugins?: typeof listDaemonPlugins;
  notifyLead?: (input: { slug: string; text: string }) => Promise<void> | void;
}

export interface StoreReleaseSettledPause {
  status: "paused-hole";
  runId: string;
  holeKind: string;
  phase: string;
  hasConsoleGuide: boolean;
  guidePath?: string;
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
      settled: Promise<StoreReleaseSettledPause | undefined>;
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

export const DEFAULT_RUNNER_TIMEOUT_MS = 75 * 60 * 1000;
export const DEFAULT_RUNNER_GRACE_MS = 5_000;
const DEFAULT_RUNNER_MAX_BUFFER = 8 * 1024 * 1024;
const RUN_START_WINDOW_TOLERANCE_MS = 5_000;
const POST_SIGKILL_SETTLE_TIMEOUT_MS = 2_000;

let activeStoreReleaseCount = 0;
const activeStoreReleaseListeners = new Set<() => void>();

/** Returns whether any asynchronous Store release execution (`stage`, `submit`, `resume`) is active. */
export function hasActiveStoreReleases(): boolean {
  return activeStoreReleaseCount > 0;
}

/** Subscribes to changes in the active asynchronous Store release count. */
export function onStoreReleaseActivityChange(listener: () => void): () => void {
  activeStoreReleaseListeners.add(listener);
  return () => {
    activeStoreReleaseListeners.delete(listener);
  };
}

function notifyStoreReleaseActivity(): void {
  for (const listener of [...activeStoreReleaseListeners]) {
    try {
      listener();
    } catch {
      // ignore listener errors so settlement never aborts
    }
  }
}

interface BoundedBufferState {
  chunks: Buffer[];
  bytes: number;
}

function appendBoundedChunk(state: BoundedBufferState, chunk: Buffer, maxBytes: number): void {
  if (chunk.length === 0 || maxBytes <= 0) return;
  if (chunk.length >= maxBytes) {
    state.chunks = [chunk.subarray(chunk.length - maxBytes)];
    state.bytes = maxBytes;
    return;
  }
  state.chunks.push(chunk);
  state.bytes += chunk.length;
  while (state.bytes > maxBytes && state.chunks.length > 0) {
    const excess = state.bytes - maxBytes;
    const head = state.chunks[0]!;
    if (head.length <= excess) {
      state.chunks.shift();
      state.bytes -= head.length;
    } else {
      state.chunks[0] = head.subarray(excess);
      state.bytes -= excess;
    }
  }
}

function decodeBoundedChunks(state: BoundedBufferState): string {
  return state.chunks.length === 0 ? "" : Buffer.concat(state.chunks, state.bytes).toString("utf8");
}

function killRunnerProcessGroup(child: ChildProcess, pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // ESRCH/EPERM fallback to direct child kill below
    }
  }
  try {
    child.kill(signal);
  } catch {
    // child already exited
  }
}

export const builtinStoreReleaseRunner: StoreReleaseRunner = (call) =>
  new Promise<StoreReleaseRunnerOutput>((resolvePromise, reject) => {
    const timeoutMs =
      typeof call.timeoutMs === "number" && Number.isFinite(call.timeoutMs) && call.timeoutMs >= 0
        ? call.timeoutMs
        : DEFAULT_RUNNER_TIMEOUT_MS;
    const graceMs =
      typeof call.graceMs === "number" && Number.isFinite(call.graceMs) && call.graceMs >= 0
        ? call.graceMs
        : DEFAULT_RUNNER_GRACE_MS;

    const stdoutState: BoundedBufferState = { chunks: [], bytes: 0 };
    const stderrState: BoundedBufferState = { chunks: [], bytes: 0 };

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [call.binPath, ...call.args], {
        cwd: call.cwd,
        env: { ...process.env, ...call.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const childPid = child.pid;
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let postKillTimer: ReturnType<typeof setTimeout> | undefined;

    const clearAllTimers = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      if (postKillTimer !== undefined) {
        clearTimeout(postKillTimer);
        postKillTimer = undefined;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      appendBoundedChunk(stdoutState, chunk, DEFAULT_RUNNER_MAX_BUFFER);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendBoundedChunk(stderrState, chunk, DEFAULT_RUNNER_MAX_BUFFER);
    });
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    timeoutTimer = setTimeout(() => {
      timeoutTimer = undefined;
      if (settled) return;
      timedOut = true;
      killRunnerProcessGroup(child, childPid, "SIGTERM");
      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        if (settled) return;
        killRunnerProcessGroup(child, childPid, "SIGKILL");
        postKillTimer = setTimeout(() => {
          postKillTimer = undefined;
          if (settled) return;
          settled = true;
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolvePromise({
            exitCode: 1,
            stdout: decodeBoundedChunks(stdoutState),
            stderr: decodeBoundedChunks(stderrState),
            timedOut: true,
          });
        }, POST_SIGKILL_SETTLE_TIMEOUT_MS);
        postKillTimer.unref?.();
      }, graceMs);
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      resolvePromise({
        exitCode: typeof code === "number" ? code : 1,
        stdout: decodeBoundedChunks(stdoutState),
        stderr: decodeBoundedChunks(stderrState),
        timedOut,
      });
    });
  });

/** Queries daemon plugin state and delegates to shared `discoverReleaseLabInstall` discovery. */
export async function resolveReleaseLabWithDaemon(
  paseoHome: string,
  listPlugins: typeof listDaemonPlugins = listDaemonPlugins,
) {
  let listed: DaemonPluginItem | undefined;
  let daemonAnswered = false;
  try {
    const result = await listPlugins(paseoHome);
    if (result.ok) {
      daemonAnswered = true;
      listed = result.plugins.find((plugin) => plugin.id === RELEASE_LAB_PLUGIN_ID);
    }
  } catch {
    // fall back to filesystem discovery when daemon is offline
  }

  return discoverReleaseLabInstall(paseoHome, {
    daemonAnswered,
    daemonEntry: listed
      ? {
          path: listed.path,
          enabled: listed.enabled,
          status: listed.status as ReleaseLabCompanionStatus,
        }
      : null,
  });
}

/**
 * Resolves `<binPath>` for `factory-release-lab` under `<paseoHome>/plugins/factory-release-lab/`,
 * checking `listDaemonPlugins`, `config.json`, and managed versioned subdirectories.
 */
export async function resolveStoreReleaseRunnerBin(
  paseoHome: string,
  listPlugins: typeof listDaemonPlugins = listDaemonPlugins,
): Promise<{ binPath: string } | null> {
  const install = await resolveReleaseLabWithDaemon(paseoHome, listPlugins);
  if (!install.installed || !install.enabled || install.binPath === null) return null;
  return { binPath: install.binPath };
}

function isApprovingResolution(resolution: unknown): boolean {
  if (resolution === undefined) return true;
  if (isPlainRecord(resolution)) {
    if (resolution.approved === true) return true;
    if (resolution.approved === false) return false;
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

interface ParsedRunnerSummary {
  id?: string;
  playbook?: string;
  status?: string;
  platforms?: string[];
  error?: string | null;
  failure?: StoreReleaseRunnerFailure | null;
  phases?: Array<{
    id?: string;
    state?: string;
    output?: unknown;
    hole?: string;
    error?: string;
    failure?: StoreReleaseRunnerFailure;
  }>;
  pausedAtHole?: {
    phase?: string;
    kind?: string;
    payload?: unknown;
    resolutionSpec?: unknown;
    defaultResolution?: unknown;
  } | null;
}

function extractCreatedKeystoreFromContainer(container: unknown): { path: string; alias?: string } | null {
  if (!isPlainRecord(container)) return null;
  const keystore = isPlainRecord(container.keystore) ? container.keystore : null;
  if (keystore === null) return null;
  const created = keystore.created === true || container.keystoreCreated === true;
  if (!created || typeof keystore.path !== "string" || keystore.path.trim() === "") return null;
  return {
    path: keystore.path.trim(),
    ...(typeof keystore.alias === "string" && keystore.alias.trim() !== "" ? { alias: keystore.alias.trim() } : {}),
  };
}

function extractCreatedAndroidKeystore(
  summary: ParsedRunnerSummary | null,
): { path: string; alias?: string } | null {
  if (!summary) return null;
  // Day-0 `day0-store-init` pauses before phase-2 sets `phase.output`, emitting `keystore` in `pausedAtHole.payload`.
  const fromHole = extractCreatedKeystoreFromContainer(summary.pausedAtHole?.payload);
  if (fromHole !== null) return fromHole;
  if (!Array.isArray(summary.phases)) return null;
  const day0 = summary.phases.find((p) => p.id === "phase-2-day0-and-signing");
  return extractCreatedKeystoreFromContainer(day0?.output);
}

function buildCliArgs(input: {
  action: StoreReleaseAction;
  projectRoot: string;
  projectSlug: string;
  platforms?: StoreReleasePlatformTarget[];
  runId?: string;
  resolution?: unknown;
}): string[] {
  const explicitPlatforms =
    input.platforms !== undefined && input.platforms.length > 0 ? [...new Set(input.platforms)] : [];
  const platformsArgs = explicitPlatforms.length > 0 ? ["--platforms", explicitPlatforms.join(",")] : [];
  switch (input.action) {
    case "probe":
      return ["probe", "--project", input.projectRoot, ...platformsArgs];
    case "stage":
      return ["run", "--playbook", "stage-release", "--project", input.projectRoot, "--slug", input.projectSlug, ...platformsArgs];
    case "submit":
      return [
        "submit-production",
        "--project",
        input.projectRoot,
        "--slug",
        input.projectSlug,
        ...(input.runId !== undefined ? ["--run", input.runId] : []),
        ...platformsArgs,
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

interface ValidatedStoreReleaseContext {
  mode: StoreReleaseMode;
  pendingRequest: StoreReleaseRequest | undefined;
  runnerBin: { binPath: string };
  detectedPlatforms: StoreReleasePlatform[];
  effectivePlatforms: StoreReleasePlatformTarget[];
  effectiveRunId: string | undefined;
  effectiveResolution: unknown;
  isFinalApprovalResume: boolean;
  runHolePlaybook: string | null;
}

const failStoreRelease = (code: string, message: string): StoreReleaseResult => ({ ok: false, code, message });

async function validateStoreReleasePreconditions(
  input: StoreReleaseInput,
  vaultRunner: VaultRunner,
): Promise<{ ok: true; ctx: ValidatedStoreReleaseContext } | { ok: false; result: StoreReleaseResult }> {
  // 1. Mode & authorization gates
  const settings = readStoreReleaseSettings(input.stateDir, input.projectSlug);
  if (settings.mode === "off") {
    return {
      ok: false,
      result: failStoreRelease(
        "store-release-not-granted",
        "Store release mode is off for this Project; the Owner must enable on-request or auto-staging in the Store Release card.",
      ),
    };
  }

  const pendingRequest = readStoreReleaseRequest(input.stateDir, input.projectSlug);
  if (settings.mode === "on-request" && (pendingRequest === undefined || !pendingRequestMatches(pendingRequest, input))) {
    return {
      ok: false,
      result: failStoreRelease(
        "no-store-release-intent",
        "Store release mode is on-request and there is no matching pending Store release request from the Owner.",
      ),
    };
  }

  const effectiveRunId = input.runId?.trim() || pendingRequest?.resumeRunId?.trim() || undefined;
  if (input.action === "resume" && effectiveRunId === undefined) {
    return {
      ok: false,
      result: failStoreRelease(
        "missing-run-id",
        "resume requires `runId` (or a pending Store release request with `resumeRunId`).",
      ),
    };
  }
  const effectiveResolution = input.resolution !== undefined ? input.resolution : pendingRequest?.resolution;

  const runHoleInfo =
    effectiveRunId !== undefined
      ? readStoreReleaseRunHoleInfo(input.paseoHome, effectiveRunId)
      : { holeKind: null, playbook: null, platforms: [] };
  const isFinalApprovalResume =
    input.action === "resume" &&
    (runHoleInfo.holeKind === "final-release-approval" ||
      (runHoleInfo.holeKind === null && isPlainRecord(effectiveResolution) && effectiveResolution.approved === true)) &&
    isApprovingResolution(effectiveResolution);

  if ((input.action === "submit" || isFinalApprovalResume) && pendingRequest?.target !== "production") {
    return {
      ok: false,
      result: failStoreRelease(
        "production-approval-required",
        "Production rollout / App Store submission requires explicit Owner production approval (Store release request target=production or final-release-approval Hole resolution).",
      ),
    };
  }

  // 2. Runner & Vault gate
  const runnerBin = await resolveStoreReleaseRunnerBin(input.paseoHome, input.listPlugins);
  if (runnerBin === null) {
    return {
      ok: false,
      result: failStoreRelease(
        "runner-not-installed",
        "factory-release-lab companion plugin is not installed or enabled under <paseoHome>/plugins/factory-release-lab/.",
      ),
    };
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
    return {
      ok: false,
      result: failStoreRelease(
        "vault-credentials-missing",
        `Missing Private vault store credentials: ${missingCreds.join(", ")}. Import them in Private vault before running Store release.`,
      ),
    };
  }

  // 3. Repo integrity gate (for stage and submit; relaxed for read-only probe and resume)
  if (input.action === "stage" || input.action === "submit") {
    const integrity = await checkRepoReleaseIntegrity({
      factory: input.factory,
      projectRoot: input.projectRoot,
      runner: vaultRunner,
    });
    if (!integrity.ok) {
      return { ok: false, result: failStoreRelease(integrity.code, integrity.message) };
    }
  }

  return {
    ok: true,
    ctx: {
      mode: settings.mode,
      pendingRequest,
      runnerBin,
      detectedPlatforms,
      effectivePlatforms,
      effectiveRunId,
      effectiveResolution,
      isFinalApprovalResume,
      runHolePlaybook: runHoleInfo.playbook,
    },
  };
}

async function runStoreReleaseProbe(
  input: StoreReleaseInput,
  ctx: ValidatedStoreReleaseContext,
  runner: StoreReleaseRunner,
  cliArgs: string[],
  runnerEnv: Record<string, string>,
): Promise<StoreReleaseResult> {
  let out: StoreReleaseRunnerOutput;
  try {
    out = await runner({
      binPath: ctx.runnerBin.binPath,
      args: cliArgs,
      cwd: input.projectRoot,
      env: runnerEnv,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.graceMs !== undefined ? { graceMs: input.graceMs } : {}),
    });
  } catch (error) {
    return failStoreRelease(
      "runner-spawn-failed",
      `failed to execute release-lab probe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (out.timedOut === true) {
    const effectiveTimeoutMs = input.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
    return failStoreRelease("runner-timed-out", `release-lab probe timed out after ${effectiveTimeoutMs}ms`);
  }
  if (out.exitCode !== 0) {
    const errJson = parseJsonObject(out.stderr);
    const parsedErr = parseRunnerFailure(errJson?.failure);
    const detail = parsedErr?.message ?? (trimDiagnosticTail(out.stderr) || `release-lab probe exited with code ${out.exitCode}`);
    return failStoreRelease(parsedErr?.code ?? "probe-failed", detail);
  }
  const probeJson = parseJsonObject(out.stdout) ?? { raw: out.stdout.trim() };
  return {
    ok: true,
    action: "probe",
    mode: ctx.mode,
    vault: readVaultStoreReadiness(input.paseoHome),
    detectedPlatforms: ctx.detectedPlatforms,
    platforms: ctx.effectivePlatforms,
    runner: { binPath: ctx.runnerBin.binPath },
    probe: probeJson,
  };
}

async function maybeWriteBackAndroidKeystore(
  input: StoreReleaseInput,
  stdoutObj: ParsedRunnerSummary | null,
  vaultRunner: VaultRunner,
): Promise<string | undefined> {
  const createdKeystore = extractCreatedAndroidKeystore(stdoutObj);
  if (createdKeystore === null || !existsSync(createdKeystore.path)) return undefined;
  try {
    const wb = await writeBackAndroidKeystore(input.paseoHome, {
      keystorePath: createdKeystore.path,
      projectRoot: input.projectRoot,
      ...(createdKeystore.alias !== undefined ? { keyAlias: createdKeystore.alias } : {}),
      runner: vaultRunner,
    });
    return wb.summary;
  } catch (err) {
    return `keystore write-back warning: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function shouldClearOnRequestCompletion(
  ctx: ValidatedStoreReleaseContext,
  action: Exclude<StoreReleaseAction, "probe">,
  stdoutObj: ParsedRunnerSummary | null,
): boolean {
  if (ctx.mode !== "on-request") return false;
  if (action === "submit") return true;
  if (action === "stage") return ctx.pendingRequest?.target !== "production";
  // For `resume`, consume immediately if not production-targeted, or if it completes final approval / production playbook.
  if (ctx.pendingRequest?.target !== "production") return true;
  if (ctx.isFinalApprovalResume) return true;
  const playbook = stdoutObj?.playbook ?? ctx.runHolePlaybook;
  return playbook === "submit-production" || playbook === "full-release";
}

interface ParsedConsoleGuideWarning {
  platform: string;
  title: string;
  lesson: string;
  matchedTraits: string[];
}

interface ParsedConsoleCompletedByApiItem {
  platform: string;
  label: string;
  detail?: string;
}

interface ParsedConsoleGuideCopyField {
  label: string;
  value: string;
}

interface ParsedConsoleGuideAnswer {
  question: string;
  answer: string;
  reason?: string;
}

interface ParsedConsoleGuideStep {
  order: number;
  title: string;
  menuPath?: string;
  url?: string;
  instructions: string[];
  copyFields: ParsedConsoleGuideCopyField[];
  answers: ParsedConsoleGuideAnswer[];
}

interface ParsedConsoleGuideSection {
  platform: string;
  title: string;
  steps: ParsedConsoleGuideStep[];
}

interface ParsedConsoleGuide {
  version: string;
  appName?: string;
  slug?: string;
  platforms: string[];
  completedByApi: ParsedConsoleCompletedByApiItem[];
  antiRejectionWarnings: ParsedConsoleGuideWarning[];
  sections: ParsedConsoleGuideSection[];
}

interface ExtractedConsoleGuide {
  guide: ParsedConsoleGuide;
  guidePath?: string;
  day0KitPath?: string;
  bundleId?: string;
  packageName?: string;
  siblingPayload?: Record<string, unknown>;
}

const OMITTED_GUIDE_PAYLOAD_KEYS = new Set(["consoleGuide", "consoleChecklist"]);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(nonEmptyString).filter((item): item is string => item !== undefined);
}

function stringifyGuideValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseConsoleGuideStep(raw: Record<string, unknown>, fallbackOrder: number): ParsedConsoleGuideStep {
  const order = finiteNumber(raw.order) ?? fallbackOrder;
  const menuPath = nonEmptyString(raw.menuPath);
  const url = nonEmptyString(raw.url);
  const copyFields = Array.isArray(raw.copyFields)
    ? raw.copyFields.filter(isPlainRecord).map((field) => ({
        label: nonEmptyString(field.label) ?? nonEmptyString(field.id) ?? "Value",
        value: stringifyGuideValue(field.value),
      }))
    : [];
  const answers = Array.isArray(raw.answers)
    ? raw.answers.filter(isPlainRecord).map((ans) => {
        const reason = nonEmptyString(ans.reason);
        return {
          question: nonEmptyString(ans.question) ?? "Question",
          answer: stringifyGuideValue(ans.answer),
          ...(reason !== undefined ? { reason } : {}),
        };
      })
    : [];
  return {
    order,
    title: nonEmptyString(raw.title) ?? `Step ${order}`,
    ...(menuPath !== undefined ? { menuPath } : {}),
    ...(url !== undefined ? { url } : {}),
    instructions: nonEmptyStrings(raw.instructions),
    copyFields,
    answers,
  };
}

function parseConsoleGuide(raw: Record<string, unknown>): ParsedConsoleGuide {
  const appName = nonEmptyString(raw.appName);
  const slug = nonEmptyString(raw.slug);
  const completedByApi = Array.isArray(raw.completedByApi)
    ? raw.completedByApi.filter(isPlainRecord).map((item) => {
        const detail = nonEmptyString(item.detail);
        return {
          platform: nonEmptyString(item.platform) ?? "shared",
          label: nonEmptyString(item.label) ?? "Completed",
          ...(detail !== undefined ? { detail } : {}),
        };
      })
    : [];
  const antiRejectionWarnings = Array.isArray(raw.antiRejectionWarnings)
    ? raw.antiRejectionWarnings.filter(isPlainRecord).map((w) => ({
        platform: nonEmptyString(w.platform) ?? "shared",
        title: nonEmptyString(w.title) ?? "Warning",
        lesson: nonEmptyString(w.lesson) ?? "",
        matchedTraits: nonEmptyStrings(w.matchedTraits),
      }))
    : [];
  const sections = Array.isArray(raw.sections)
    ? raw.sections.filter(isPlainRecord).map((section) => {
        const platform = nonEmptyString(section.platform) ?? "shared";
        const rawSteps = Array.isArray(section.steps) ? section.steps.filter(isPlainRecord) : [];
        const sortedSteps = [...rawSteps].sort(
          (a, b) => (finiteNumber(a.order) ?? Number.MAX_SAFE_INTEGER) - (finiteNumber(b.order) ?? Number.MAX_SAFE_INTEGER),
        );
        return {
          platform,
          title: nonEmptyString(section.title) ?? platform,
          steps: sortedSteps.map((step, idx) => parseConsoleGuideStep(step, idx + 1)),
        };
      })
    : [];
  return {
    version: nonEmptyString(raw.consoleGuideVersion) ?? nonEmptyString(raw.version) ?? "unknown",
    ...(appName !== undefined ? { appName } : {}),
    ...(slug !== undefined ? { slug } : {}),
    platforms: nonEmptyStrings(raw.platforms),
    completedByApi,
    antiRejectionWarnings,
    sections,
  };
}

function extractSiblingPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(payload).filter(([key, val]) => !OMITTED_GUIDE_PAYLOAD_KEYS.has(key) && val !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function extractConsoleGuidePayload(payload: unknown): ExtractedConsoleGuide | null {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.consoleGuide)) return null;
  const rawGuide = payload.consoleGuide;
  const hasKnownShape =
    nonEmptyString(rawGuide.consoleGuideVersion) !== undefined ||
    nonEmptyString(rawGuide.version) !== undefined ||
    Array.isArray(rawGuide.sections) ||
    Array.isArray(rawGuide.completedByApi) ||
    Array.isArray(rawGuide.antiRejectionWarnings);
  if (!hasKnownShape) return null;
  const guidePath = nonEmptyString(payload.consoleGuidePath) ?? nonEmptyString(payload.guidePath);
  const day0KitPath = nonEmptyString(payload.day0KitPath);
  const bundleId = nonEmptyString(payload.bundleId);
  const packageName = nonEmptyString(payload.packageName);
  const siblingPayload = extractSiblingPayload(payload);
  return {
    guide: parseConsoleGuide(rawGuide),
    ...(guidePath !== undefined ? { guidePath } : {}),
    ...(day0KitPath !== undefined ? { day0KitPath } : {}),
    ...(bundleId !== undefined ? { bundleId } : {}),
    ...(packageName !== undefined ? { packageName } : {}),
    ...(siblingPayload !== undefined ? { siblingPayload } : {}),
  };
}

const MAX_CONSOLE_GUIDE_DIGEST_CHARS = 16000;

function boundConsoleGuideDigest(full: string, guidePath: string | undefined, maxChars = MAX_CONSOLE_GUIDE_DIGEST_CHARS): string {
  if (full.length <= maxChars) return full;
  const notice = `\n... [Console handoff guide truncated at ${maxChars} chars; see full guide at ${guidePath ?? "CONSOLE_GUIDE.md"}]`;
  const budget = Math.max(0, maxChars - notice.length);
  const slice = full.slice(0, budget);
  const lastNewline = full[budget] === "\n" ? budget : slice.lastIndexOf("\n");
  const head = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
  return `${head}${notice}`;
}

function formatConsoleHandoffGuideDigest(extracted: ExtractedConsoleGuide): string {
  const { guide, guidePath, day0KitPath, bundleId, packageName } = extracted;
  const lines: string[] = [`## Console handoff guide (version ${guide.version})`];
  const meta: string[] = [];
  if (guide.appName !== undefined) meta.push(`App: ${guide.appName}${guide.slug !== undefined ? ` (${guide.slug})` : ""}`);
  if (guide.platforms.length > 0) meta.push(`Platforms: ${guide.platforms.join(", ")}`);
  if (bundleId !== undefined) meta.push(`Bundle ID: ${bundleId}`);
  if (packageName !== undefined) meta.push(`Package name: ${packageName}`);
  if (meta.length > 0) lines.push(meta.join(" | "));
  if (guidePath !== undefined) lines.push(`- CONSOLE_GUIDE.md: ${guidePath}`);
  if (day0KitPath !== undefined) lines.push(`- Day-0 kit: ${day0KitPath}`);

  if (guide.antiRejectionWarnings.length > 0) {
    lines.push("", "### Anti-rejection warnings");
    for (const w of guide.antiRejectionWarnings) {
      const traitSuffix = w.matchedTraits.length > 0 ? ` (matchedTraits: ${w.matchedTraits.join(", ")})` : "";
      lines.push(`- [${w.platform}] ${w.title}: ${w.lesson}${traitSuffix}`);
    }
  }

  if (guide.completedByApi.length > 0) {
    lines.push("", "### Done by API");
    for (const item of guide.completedByApi) {
      lines.push(`- [x] [${item.platform}] ${item.label}${item.detail !== undefined ? ` — ${item.detail}` : ""}`);
    }
  }

  for (const section of guide.sections) {
    lines.push("", `### ${section.title} (${section.platform})`);
    for (const step of section.steps) {
      lines.push(`${step.order}. ${step.title}`);
      if (step.menuPath !== undefined) lines.push(`   - Menu path: ${step.menuPath}`);
      if (step.url !== undefined) lines.push(`   - URL: ${step.url}`);
      for (const instr of step.instructions) {
        lines.push(`   - ${instr}`);
      }
      if (step.copyFields.length > 0) {
        lines.push(`   - Copy values:`);
        for (const field of step.copyFields) {
          lines.push(`     - ${field.label}: ${field.value}`);
        }
      }
      if (step.answers.length > 0) {
        lines.push(`   - Questionnaire answers:`);
        for (const ans of step.answers) {
          lines.push(`     - ${ans.question} -> ${ans.answer}${ans.reason !== undefined ? ` (Reason: ${ans.reason})` : ""}`);
        }
      }
    }
  }

  return boundConsoleGuideDigest(lines.join("\n"), guidePath);
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

interface TimedOutRunContext {
  id: string;
  runningPhase?: string;
}

function extractTimedOutPhaseId(record: Record<string, unknown>): string | undefined {
  const phases = Array.isArray(record.phases) ? record.phases.filter(isPlainRecord) : [];
  const runningIds = phases
    .filter((phase) => phase.state === "running")
    .map((phase) => nonEmptyString(phase.id))
    .filter((phaseId): phaseId is string => phaseId !== undefined);
  if (runningIds.length > 0) return runningIds.join(", ");

  // Fallback when `release-lab` caught SIGTERM during grace and marked the stalled phase `failed`.
  if (record.status === "failed") {
    const failurePhase = isPlainRecord(record.failure) ? nonEmptyString(record.failure.phase) : undefined;
    if (failurePhase !== undefined) return failurePhase;
    const sigtermPhase = phases.find(
      (phase) =>
        phase.state === "failed" &&
        typeof phase.error === "string" &&
        phase.error.startsWith("signal-terminated"),
    );
    const sigtermId = sigtermPhase ? nonEmptyString(sigtermPhase.id) : undefined;
    if (sigtermId !== undefined) return sigtermId;
  }
  return undefined;
}

/**
 * Inspects `<paseoHome>/release-lab/runs/*.json` strictly read-only to find the
 * newest matching `Release run` overlapping the run start window and extract
 * its `id` and any `running` `Phase`.
 */
function findTimedOutRunContext(params: {
  paseoHome: string;
  projectSlug: string;
  projectRoot: string;
  runStartedAt: number;
  preferredRunIds: readonly string[];
}): TimedOutRunContext | null {
  const runsDir = join(params.paseoHome, "release-lab", "runs");
  let entries: string[];
  try {
    entries = readdirSync(runsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const normalizedProjectRoot = normalizeFsPath(params.projectRoot);
  const preferredSet = new Set(params.preferredRunIds);
  const windowFloorMs = params.runStartedAt - RUN_START_WINDOW_TOLERANCE_MS;
  const candidates: Array<{
    preferred: boolean;
    isRunning: boolean;
    sortUpdated: number;
    sortCreated: number;
    id: string;
    runningPhase?: string;
  }> = [];

  for (const file of entries) {
    const filePath = join(runsDir, file);
    const record = readJsonObject(filePath);
    if (record === null) continue;
    const id = nonEmptyString(record.id);
    if (id === undefined) continue;

    const runRoot = nonEmptyString(record.projectRoot);
    if (runRoot !== undefined) {
      if (normalizeFsPath(runRoot) !== normalizedProjectRoot) continue;
    } else if (nonEmptyString(record.projectSlug) !== params.projectSlug) {
      continue;
    }

    const preferred = preferredSet.has(id);
    const status = nonEmptyString(record.status);
    if (!preferred && (status === "completed" || status === "paused-hole")) continue;

    const createdMs = parseTimestampMs(record.createdAt);
    const updatedMs = parseTimestampMs(record.updatedAt);
    let mtimeMs: number | null = null;
    if (createdMs === null && updatedMs === null) {
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        mtimeMs = null;
      }
    }
    const activityMs = updatedMs ?? createdMs ?? mtimeMs;
    if (!preferred && (activityMs === null || activityMs < windowFloorMs)) continue;

    const runningPhase = extractTimedOutPhaseId(record);
    candidates.push({
      preferred,
      isRunning: status === "running",
      sortUpdated: activityMs ?? 0,
      sortCreated: createdMs ?? 0,
      id,
      ...(runningPhase !== undefined ? { runningPhase } : {}),
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    if (b.sortUpdated !== a.sortUpdated) return b.sortUpdated - a.sortUpdated;
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    if (b.sortCreated !== a.sortCreated) return b.sortCreated - a.sortCreated;
    return b.id.localeCompare(a.id);
  });

  const winner = candidates[0]!;
  return {
    id: winner.id,
    ...(winner.runningPhase !== undefined ? { runningPhase: winner.runningPhase } : {}),
  };
}

async function recordAndNotifyStoreReleaseFailure(params: {
  input: StoreReleaseInput;
  action: Exclude<StoreReleaseAction, "probe">;
  runId: string;
  failureClass: StoreReleaseFailureClass;
  code: string;
  detail: string;
  hint?: string;
  upstreamIssuePath?: string;
  diagnosticTail?: string;
  keystoreWriteBackNote?: string;
}): Promise<void> {
  const { input, action, runId, failureClass, code, detail, hint, upstreamIssuePath, diagnosticTail, keystoreWriteBackNote } = params;
  await input.factory.history.runOperation(() => {
    input.factory.ledger.append({
      event: "store_release_failed",
      runId,
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
  const normalizedHint = typeof hint === "string" ? hint.trim() : "";

  await input.notifyLead?.({
    slug: input.projectSlug,
    text: [
      `[Store release failed] action=${action} runId=${runId} failureClass=${failureClass} code=${code}`,
      `Detail: ${detail}`,
      ...(normalizedHint !== "" ? [`Hint: ${normalizedHint}`] : []),
      ...(upstreamIssuePath !== undefined ? [`Upstream issue: ${upstreamIssuePath}`] : []),
      ...(diagnosticTail !== undefined && diagnosticTail !== "" ? [`Diagnostic tail:\n${diagnosticTail}`] : []),
      ...(keystoreWriteBackNote ? [`Vault write-back: ${keystoreWriteBackNote}`] : []),
      routePolicy,
    ].join("\n"),
  });
}

async function settleStoreReleaseRun(params: {
  input: StoreReleaseInput;
  ctx: ValidatedStoreReleaseContext;
  action: Exclude<StoreReleaseAction, "probe">;
  trackingRunId: string;
  runner: StoreReleaseRunner;
  vaultRunner: VaultRunner;
  cliArgs: string[];
  runnerEnv: Record<string, string>;
  runStartedAt: number;
}): Promise<StoreReleaseSettledPause | undefined> {
  const { input, ctx, action, trackingRunId, runner, vaultRunner, cliArgs, runnerEnv, runStartedAt } = params;
  let out: StoreReleaseRunnerOutput;
  try {
    out = await runner({
      binPath: ctx.runnerBin.binPath,
      args: cliArgs,
      cwd: input.projectRoot,
      env: runnerEnv,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.graceMs !== undefined ? { graceMs: input.graceMs } : {}),
    });
  } catch (error) {
    await recordAndNotifyStoreReleaseFailure({
      input,
      action,
      runId: trackingRunId,
      failureClass: "tool-bug",
      code: "runner-spawn-failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const stdoutObj = parseJsonObject(out.stdout) as ParsedRunnerSummary | null;
  const stderrObj = parseJsonObject(out.stderr);
  const settledRunId =
    typeof stdoutObj?.id === "string" && stdoutObj.id.trim() !== "" ? stdoutObj.id.trim() : trackingRunId;

  if (out.timedOut === true) {
    const effectiveTimeoutMs = input.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
    const preferredRunIds = [
      ...(typeof stdoutObj?.id === "string" && stdoutObj.id.trim() !== "" ? [stdoutObj.id.trim()] : []),
      ...(ctx.effectiveRunId !== undefined ? [ctx.effectiveRunId] : []),
    ];
    const timedOutRun = findTimedOutRunContext({
      paseoHome: input.paseoHome,
      projectSlug: input.projectSlug,
      projectRoot: input.projectRoot,
      runStartedAt,
      preferredRunIds,
    });
    const detailContext: string[] = [];
    if (timedOutRun !== null) {
      detailContext.push(`run ${timedOutRun.id}`);
      if (timedOutRun.runningPhase !== undefined) {
        detailContext.push(`phase ${timedOutRun.runningPhase}`);
      }
    }
    const detailSuffix = detailContext.length > 0 ? ` (${detailContext.join(", ")})` : "";
    await recordAndNotifyStoreReleaseFailure({
      input,
      action,
      runId: settledRunId,
      failureClass: "tool-bug",
      code: "runner-timed-out",
      detail: `release-lab ${action} timed out after ${effectiveTimeoutMs}ms${detailSuffix}`,
      diagnosticTail: trimDiagnosticTail(out.stderr || out.stdout),
    });
    return undefined;
  }

  const settledPlatforms = Array.isArray(stdoutObj?.platforms)
    ? stdoutObj.platforms.filter((p): p is string => typeof p === "string" && p.trim() !== "")
    : ctx.effectivePlatforms;

  // Day-0 Android keystore write-back on both `paused-hole` (day0-store-init) and `completed`
  const keystoreWriteBackNote = await maybeWriteBackAndroidKeystore(input, stdoutObj, vaultRunner);

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
    const extractedGuide = extractConsoleGuidePayload(pausedHole?.payload);

    await input.factory.history.runOperation(() => {
      input.factory.ledger.append({
        event: "store_release_paused",
        runId: settledRunId,
        holeKind,
        phase: holePhase,
        ...(extractedGuide !== null ? { hasConsoleGuide: true } : {}),
        ...(extractedGuide?.guidePath !== undefined ? { guidePath: extractedGuide.guidePath } : {}),
      });
    });

    const holeSummaryLines = [
      `[Store release paused at Hole] action=${action} runId=${settledRunId} phase=${holePhase} holeKind=${holeKind}`,
      ...(extractedGuide !== null
        ? [
            formatConsoleHandoffGuideDigest(extractedGuide),
            ...(extractedGuide.siblingPayload !== undefined
              ? [`Payload context: ${JSON.stringify(extractedGuide.siblingPayload)}`]
              : []),
          ]
        : pausedHole?.payload !== undefined
          ? [`Payload: ${JSON.stringify(pausedHole.payload)}`]
          : []),
      ...(pausedHole?.resolutionSpec !== undefined ? [`Resolution spec: ${JSON.stringify(pausedHole.resolutionSpec)}`] : []),
      ...(keystoreWriteBackNote ? [`Vault write-back: ${keystoreWriteBackNote}`] : []),
      extractedGuide !== null
        ? `Next: Relay this Console handoff guide verbatim to Supervisor (preserving exact URLs, values, answers, anti-rejection warnings, and CONSOLE_GUIDE.md path) so the Owner can complete the Console steps and confirm in chat to dispatch resume (runId=${settledRunId}).`
        : `Next: Report this Hole summary to Supervisor so the Owner can approve/resolve it (in Supervisor chat or Release Lab UI) and dispatch resume.`,
    ];
    await input.notifyLead?.({
      slug: input.projectSlug,
      text: holeSummaryLines.join("\n"),
    });
    return {
      status: "paused-hole",
      runId: settledRunId,
      holeKind,
      phase: holePhase,
      hasConsoleGuide: extractedGuide !== null,
      ...(extractedGuide?.guidePath !== undefined ? { guidePath: extractedGuide.guidePath } : {}),
    };
  }

  if (out.exitCode === 0 && (stdoutObj?.status === "completed" || stdoutObj === null)) {
    const summary = `Store release ${action} completed (${settledPlatforms.join(", ") || "default"})`;
    await input.factory.history.runOperation(() => {
      if (shouldClearOnRequestCompletion(ctx, action, stdoutObj)) {
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
    return undefined;
  }

  // Failed outcome (either stdout run status="failed" or non-zero exit with stderr JSON / text)
  const failure =
    parseRunnerFailure(stdoutObj?.failure) ??
    parseRunnerFailure(stdoutObj?.phases?.find((p) => p.failure)?.failure) ??
    parseRunnerFailure(stderrObj?.failure);

  const failureClass: StoreReleaseFailureClass = failure?.failureClass ?? "tool-bug";
  const code = failure?.code ?? (out.exitCode !== 0 ? "runner-exited-nonzero" : "store-release-failed");
  const detail =
    failure?.message ??
    (typeof stdoutObj?.error === "string" && stdoutObj.error.trim() !== "" ? stdoutObj.error.trim() : undefined) ??
    (typeof stderrObj?.error === "string" && stderrObj.error.trim() !== "" ? stderrObj.error.trim() : undefined) ??
    (trimDiagnosticTail(out.stderr) || `release-lab ${action} exited with code ${out.exitCode}`);
  const hint = failure?.hint;
  const upstreamIssuePath = failure?.upstreamIssuePath;
  const diagnosticTail = failure?.logTail ?? trimDiagnosticTail(out.stderr || out.stdout);

  await recordAndNotifyStoreReleaseFailure({
    input,
    action,
    runId: settledRunId,
    failureClass,
    code,
    detail,
    ...(hint !== undefined ? { hint } : {}),
    ...(upstreamIssuePath !== undefined ? { upstreamIssuePath } : {}),
    diagnosticTail,
    ...(keystoreWriteBackNote !== undefined ? { keystoreWriteBackNote } : {}),
  });
  return undefined;
}

export async function storeReleaseProject(input: StoreReleaseInput): Promise<StoreReleaseResult> {
  const runner = input.runner ?? builtinStoreReleaseRunner;
  const vaultRunner = input.vaultRunner ?? builtinVaultRunner;

  const validated = await validateStoreReleasePreconditions(input, vaultRunner);
  if (!validated.ok) return validated.result;
  const ctx = validated.ctx;

  const runnerEnv: Record<string, string> = {
    PASEO_HOME: input.paseoHome,
    PATH: buildVaultPath(process.env.PATH ?? ""),
  };
  const cliArgs = buildCliArgs({
    action: input.action,
    projectRoot: input.projectRoot,
    projectSlug: input.projectSlug,
    platforms: input.platforms,
    runId: ctx.effectiveRunId,
    resolution: ctx.effectiveResolution,
  });

  if (input.action === "probe") {
    return runStoreReleaseProbe(input, ctx, runner, cliArgs, runnerEnv);
  }

  const action = input.action;
  const trackingRunId = ctx.effectiveRunId ?? `store-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  input.factory.ledger.append({
    event: "store_release_started",
    runId: trackingRunId,
    action,
    platforms: ctx.effectivePlatforms,
    mode: ctx.mode,
  });

  const runStartedAt = Date.now();
  activeStoreReleaseCount += 1;
  notifyStoreReleaseActivity();
  const settled: Promise<StoreReleaseSettledPause | undefined> = settleStoreReleaseRun({
    input,
    ctx,
    action,
    trackingRunId,
    runner,
    vaultRunner,
    cliArgs,
    runnerEnv,
    runStartedAt,
  })
    .catch((err) => {
      void input.notifyLead?.({
        slug: input.projectSlug,
        text: `[Store release internal error] action=${action} runId=${trackingRunId}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return undefined;
    })
    .finally(() => {
      activeStoreReleaseCount = Math.max(0, activeStoreReleaseCount - 1);
      notifyStoreReleaseActivity();
    });

  return {
    ok: true,
    started: true,
    action,
    runId: trackingRunId,
    mode: ctx.mode,
    platforms: ctx.effectivePlatforms,
    runner: { binPath: ctx.runnerBin.binPath },
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
