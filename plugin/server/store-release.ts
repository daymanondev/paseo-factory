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
import { existsSync } from "node:fs";
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

export type StoreReleaseSettledOutcome =
  | {
      status: "paused-hole";
      runId: string;
      holeKind: string;
      phase: string;
      hasConsoleGuide: boolean;
      guidePath?: string;
    }
  | {
      status: "completed";
      runId: string;
      platforms: string[];
    }
  | {
      status: "failed";
      runId: string;
      failureClass: StoreReleaseFailureClass;
      code: string;
    };

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
      settled: Promise<StoreReleaseSettledOutcome>;
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
    });
  } catch (error) {
    return failStoreRelease(
      "runner-spawn-failed",
      `failed to execute release-lab probe: ${error instanceof Error ? error.message : String(error)}`,
    );
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

interface ExtractedConsoleGuide {
  guide: Record<string, unknown>;
  guidePath?: string;
  day0KitPath?: string;
  bundleId?: string;
  packageName?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function extractConsoleGuidePayload(payload: unknown): ExtractedConsoleGuide | null {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.consoleGuide)) return null;
  const guide = payload.consoleGuide;
  const hasKnownShape =
    nonEmptyString(guide.consoleGuideVersion) !== undefined ||
    nonEmptyString(guide.version) !== undefined ||
    Array.isArray(guide.sections) ||
    Array.isArray(guide.completedByApi) ||
    Array.isArray(guide.antiRejectionWarnings);
  if (!hasKnownShape) return null;
  const guidePath = nonEmptyString(payload.consoleGuidePath) ?? nonEmptyString(payload.guidePath);
  const day0KitPath = nonEmptyString(payload.day0KitPath);
  const bundleId = nonEmptyString(payload.bundleId);
  const packageName = nonEmptyString(payload.packageName);
  return {
    guide,
    ...(guidePath !== undefined ? { guidePath } : {}),
    ...(day0KitPath !== undefined ? { day0KitPath } : {}),
    ...(bundleId !== undefined ? { bundleId } : {}),
    ...(packageName !== undefined ? { packageName } : {}),
  };
}

function formatConsoleHandoffGuideDigest(extracted: ExtractedConsoleGuide): string {
  const { guide, guidePath, day0KitPath, bundleId, packageName } = extracted;
  const guideVersion = nonEmptyString(guide.consoleGuideVersion) ?? nonEmptyString(guide.version) ?? "unknown";
  const appName = nonEmptyString(guide.appName);
  const slug = nonEmptyString(guide.slug);
  const platforms = Array.isArray(guide.platforms)
    ? guide.platforms.filter((p): p is string => typeof p === "string" && p.trim() !== "")
    : [];

  const lines: string[] = [`## Console handoff guide (version ${guideVersion})`];
  const meta: string[] = [];
  if (appName !== undefined) meta.push(`App: ${appName}${slug !== undefined ? ` (${slug})` : ""}`);
  if (platforms.length > 0) meta.push(`Platforms: ${platforms.join(", ")}`);
  if (bundleId !== undefined) meta.push(`Bundle ID: ${bundleId}`);
  if (packageName !== undefined) meta.push(`Package name: ${packageName}`);
  if (meta.length > 0) lines.push(meta.join(" | "));
  if (guidePath !== undefined) lines.push(`- CONSOLE_GUIDE.md: ${guidePath}`);
  if (day0KitPath !== undefined) lines.push(`- Day-0 kit: ${day0KitPath}`);

  const warnings = Array.isArray(guide.antiRejectionWarnings) ? guide.antiRejectionWarnings.filter(isPlainRecord) : [];
  if (warnings.length > 0) {
    lines.push("", "### Anti-rejection warnings");
    for (const w of warnings) {
      const platform = nonEmptyString(w.platform) ?? "shared";
      const title = nonEmptyString(w.title) ?? "Warning";
      const lesson = nonEmptyString(w.lesson) ?? "";
      const traits = Array.isArray(w.matchedTraits)
        ? w.matchedTraits.filter((t): t is string => typeof t === "string" && t.trim() !== "")
        : [];
      const traitSuffix = traits.length > 0 ? ` (matchedTraits: ${traits.join(", ")})` : "";
      lines.push(`- [${platform}] ${title}: ${lesson}${traitSuffix}`);
    }
  }

  const completed = Array.isArray(guide.completedByApi) ? guide.completedByApi.filter(isPlainRecord) : [];
  if (completed.length > 0) {
    lines.push("", "### Done by API");
    for (const item of completed) {
      const platform = nonEmptyString(item.platform) ?? "shared";
      const label = nonEmptyString(item.label) ?? "Completed";
      const detail = nonEmptyString(item.detail);
      lines.push(`- [x] [${platform}] ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
    }
  }

  const sections = Array.isArray(guide.sections) ? guide.sections.filter(isPlainRecord) : [];
  for (const section of sections) {
    const sectionPlatform = nonEmptyString(section.platform) ?? "shared";
    const sectionTitle = nonEmptyString(section.title) ?? sectionPlatform;
    lines.push("", `### ${sectionTitle} (${sectionPlatform})`);
    const rawSteps = Array.isArray(section.steps) ? section.steps.filter(isPlainRecord) : [];
    const steps = [...rawSteps].sort((a, b) => {
      const ao = typeof a.order === "number" && Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
      const bo = typeof b.order === "number" && Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });
    for (const [idx, step] of steps.entries()) {
      const order = typeof step.order === "number" && Number.isFinite(step.order) ? step.order : idx + 1;
      const title = nonEmptyString(step.title) ?? `Step ${order}`;
      lines.push(`${order}. ${title}`);
      const menuPath = nonEmptyString(step.menuPath);
      if (menuPath !== undefined) lines.push(`   - Menu path: ${menuPath}`);
      const url = nonEmptyString(step.url);
      if (url !== undefined) lines.push(`   - URL: ${url}`);
      const instructions = Array.isArray(step.instructions)
        ? step.instructions.filter((i): i is string => typeof i === "string" && i.trim() !== "")
        : [];
      for (const instr of instructions) {
        lines.push(`   - ${instr}`);
      }
      const copyFields = Array.isArray(step.copyFields) ? step.copyFields.filter(isPlainRecord) : [];
      if (copyFields.length > 0) {
        lines.push(`   - Copy values:`);
        for (const field of copyFields) {
          const label = nonEmptyString(field.label) ?? nonEmptyString(field.id) ?? "Value";
          const value = typeof field.value === "string" ? field.value : JSON.stringify(field.value ?? "");
          lines.push(`     - ${label}: ${value}`);
        }
      }
      const answers = Array.isArray(step.answers) ? step.answers.filter(isPlainRecord) : [];
      if (answers.length > 0) {
        lines.push(`   - Questionnaire answers:`);
        for (const ans of answers) {
          const question = nonEmptyString(ans.question) ?? "Question";
          const answer = typeof ans.answer === "string" ? ans.answer : JSON.stringify(ans.answer ?? "");
          const reason = nonEmptyString(ans.reason);
          lines.push(`     - ${question} -> ${answer}${reason !== undefined ? ` (Reason: ${reason})` : ""}`);
        }
      }
    }
  }

  return lines.join("\n");
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
}): Promise<StoreReleaseSettledOutcome> {
  const { input, ctx, action, trackingRunId, runner, vaultRunner, cliArgs, runnerEnv } = params;
  let out: StoreReleaseRunnerOutput;
  try {
    out = await runner({
      binPath: ctx.runnerBin.binPath,
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
    return {
      status: "failed",
      runId: trackingRunId,
      failureClass: "tool-bug",
      code: "runner-spawn-failed",
    };
  }

  const stdoutObj = parseJsonObject(out.stdout) as ParsedRunnerSummary | null;
  const stderrObj = parseJsonObject(out.stderr);
  const settledRunId =
    typeof stdoutObj?.id === "string" && stdoutObj.id.trim() !== "" ? stdoutObj.id.trim() : trackingRunId;
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

    const holeSummaryLines = extractedGuide !== null
      ? [
          `[Store release paused at Hole] action=${action} runId=${settledRunId} phase=${holePhase} holeKind=${holeKind}`,
          formatConsoleHandoffGuideDigest(extractedGuide),
          ...(pausedHole?.resolutionSpec !== undefined ? [`Resolution spec: ${JSON.stringify(pausedHole.resolutionSpec)}`] : []),
          ...(keystoreWriteBackNote ? [`Vault write-back: ${keystoreWriteBackNote}`] : []),
          `Next: Relay this Console handoff guide verbatim to Supervisor (preserving exact URLs, values, answers, anti-rejection warnings, and CONSOLE_GUIDE.md path) so the Owner can complete the Console steps and confirm in chat to dispatch resume (runId=${settledRunId}).`,
        ]
      : [
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
    return {
      status: "completed",
      runId: settledRunId,
      platforms: settledPlatforms,
    };
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
  return {
    status: "failed",
    runId: settledRunId,
    failureClass,
    code,
  };
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

  const settled: Promise<StoreReleaseSettledOutcome> = settleStoreReleaseRun({
    input,
    ctx,
    action,
    trackingRunId,
    runner,
    vaultRunner,
    cliArgs,
    runnerEnv,
  }).catch((err) => {
    void input.notifyLead?.({
      slug: input.projectSlug,
      text: `[Store release internal error] action=${action} runId=${trackingRunId}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      status: "failed" as const,
      runId: trackingRunId,
      failureClass: "tool-bug" as const,
      code: "internal-error",
    };
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
