/**
 * Server-side Factory Setup Runner (ADR 0073 — Wave 2):
 * - Tier 0 (`inspectFactoryForProject`): secret-free, context-bounded Project &
 *   Factory readiness snapshot.
 * - Tier 1 (`executeFactorySetup` when bundle tier === 1): sequential execution
 *   with strictly project-scoped `hydrateVaultDirect(..., { runtimeOnly: true, projectDir })`,
 *   additive `factory-skills-pack`, `set_skill_pack`, and lock-safe `sync_open_design`.
 * - Tier 2 (`executeFactorySetup` when bundle tier === 2): upfront preconditions,
 *   `ghAuth` preflight, missing Vault key warnings, and atomic `SetupProposalRecord`
 *   persistence under `<projectStateDir>/setup-proposal.json`.
 * - Shared step execution (`applySetupProposalSteps`) reused by Wave 3a
 *   `factory.setup_proposal.approve`.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  appendSetupAudit,
  classifySetupActionTier,
  scrubSetupDiagnostic,
  validateFactorySetupInput,
  writeSetupProposal,
  recoverInterruptedSetupProposal,
} from "./core/factory-setup.ts";
import type {
  FactorySetupAction,
  FactorySetupCompanionId,
  FactorySetupTier,
  SetupActionStepResult,
  SetupProposalRecord,
} from "./core/factory-setup.ts";
import { FactoryError } from "./core/errors.ts";
import { isReadOnlyPeerDisposition } from "./core/events.ts";
import type { Factory } from "./core/factory.ts";
import { withProjectIngressLock } from "./core/project-ingress-lock.ts";
import {
  readProjectSettings,
  readReleaseSettings,
  readStoreReleaseSettings,
  setProjectReleaseSettings,
  setProjectSkillPacks,
  setProjectStoreReleaseSettings,
} from "./core/project-settings.ts";
import type { ProjectReleaseMode, ProjectStoreReleaseMode } from "./core/project-settings.ts";
import { resolveStoreReleaseCapability } from "./core/store-release-capability.ts";
import type { StoreReleaseSupervisorTier } from "./core/store-release-capability.ts";
import { detectMobilePlatforms } from "./core/store-release-probe.ts";
import {
  detectProjectSkillPacks,
  inspectFactorySkillPack,
  installOrUpdateFactorySkillPack,
} from "./core/companion-tools.ts";
import type { CompanionToolRunner } from "./core/companion-tools.ts";
import { projectSkillPackInventory } from "./core/skill-hub.ts";
import { discoverHelperMcps, setHelperMcpEnabled } from "./core/helper-mcp-sync.ts";
import { provisionPiAgentHome } from "./core/pi-home.ts";
import { discoverOpenDesignProjects, syncOpenDesignLink } from "./core/open-design/open-design-link.ts";
import {
  hydrateVaultDirect,
  isLocalCompanionGitSource,
  loadVaultConfig,
  probeCompanionGitAccess,
  probeGhAuth,
} from "./core/vault.ts";
import type { VaultRunner } from "./core/vault.ts";
import {
  materializeVaultSkillsFromRuntime,
  readVaultStoreReadiness,
  resolveVaultUserHome,
} from "./core/vault-materialization.ts";
import { COMPANION_CATALOG } from "../shared/companions.ts";
import { installDaemonPlugin, listDaemonPlugins } from "./daemon-cli.ts";
import { probeOpenDesign } from "./panel.ts";
import { projectPeersInFlight, taskFactoryOf } from "./peer-in-flight.ts";
import { ensureProjectRegistered } from "./projects.ts";
import type { FactoryRegistry } from "./projects.ts";
import { resolveReleaseLabWithDaemon } from "./store-release.ts";
import type { SurfaceDaemonApi } from "./surface-rpc.ts";

export const VAULT_HYDRATE_TIMEOUT_MS = 60_000;
export const COMPANION_INSTALL_TIMEOUT_MS = 120_000;
export const OPEN_DESIGN_INSPECT_MAX_PROJECTS = 20;

export interface FactorySetupProjectTarget {
  slug: string;
  root: string;
}

export interface FactorySetupRunnerDeps {
  stateDir: string;
  home: string;
  userHome?: string;
  factory?: Factory;
  registry?: FactoryRegistry;
  daemon?: SurfaceDaemonApi | (() => SurfaceDaemonApi | undefined);
  listPlugins?: typeof listDaemonPlugins;
  installPlugin?: typeof installDaemonPlugin;
  vaultRunner?: VaultRunner;
  companionToolRunner?: CompanionToolRunner;
  activeProposalRuns?: Map<string, string> | Set<string>;
  onStateChange?: (event: { handler: string; projectSlug?: string; projectRoot?: string }) => void;
  onLog?: (message: string) => void;
  now?: () => string;
  vaultHydrateTimeoutMs?: number;
  companionInstallTimeoutMs?: number;
}

export interface FactoryInspectSnapshot {
  project: {
    slug: string;
    root: string;
  };
  isMobile: boolean;
  detectedPlatforms: Array<"android" | "ios" | "expo">;
  hasOrigin: boolean;
  hasStoreManifest: boolean;
  companions: {
    "factory-release-lab": {
      installed: boolean;
      enabled: boolean;
      status: string;
    };
    "factory-skills-pack": {
      installed: boolean;
      status: string;
      installedCoreCount: number;
      revision: string | null;
    };
  };
  release: {
    mode: ProjectReleaseMode;
    branch: string | null;
  };
  storeRelease: {
    mode: ProjectStoreReleaseMode;
    supervisorTier: StoreReleaseSupervisorTier;
    leadEnabled: boolean;
  };
  skillPacks: {
    enabled: string[];
    available: Array<{
      id: string;
      label: string;
      autoDetected: boolean;
    }>;
  };
  helperMcps: Array<{
    name: string;
    enabled: boolean;
    status: string;
    machineWide: true;
  }>;
  openDesign: {
    linked: boolean;
    linkedProjectName: string | null;
    syncedAt: string | null;
    bundlePresent: boolean;
    unreadable: string | null;
    availableProjects: Array<{
      projectId: string;
      projectName: string;
      screenCount: number;
    }>;
  };
  vault: {
    configured: boolean;
    ascKey: boolean;
    appleTeamId: boolean;
    gplayJson: boolean;
  };
  ghAuth: {
    installed: boolean;
    authenticated: boolean;
    user: string | null;
  };
  pendingProposal: {
    id: string;
    actionsHash: string;
    status: SetupProposalRecord["status"];
    reason: string;
    actionKinds: FactorySetupAction["kind"][];
    warnings: string[];
    updatedAt: string;
  } | null;
}

export interface ApplySetupProposalOptions {
  applyStoreReleaseMode?: (input: {
    project: FactorySetupProjectTarget;
    mode: ProjectStoreReleaseMode;
  }) => Promise<string | void> | string | void;
  applyReleaseMode?: (input: {
    project: FactorySetupProjectTarget;
    mode: ProjectReleaseMode;
    branch?: string | null;
  }) => Promise<string | void> | string | void;
  installCompanion?: (input: { id: FactorySetupCompanionId }) => Promise<string>;
  applySkillPack?: (input: {
    project: FactorySetupProjectTarget;
    pack: string;
    enabled: boolean;
  }) => Promise<string> | string;
  applyHelperMcp?: (input: { name: string; enabled: boolean }) => Promise<string> | string;
  syncOpenDesign?: (input: {
    project: FactorySetupProjectTarget;
    projectId: string;
  }) => Promise<string> | string;
  hydrateVault?: (input: { project: FactorySetupProjectTarget }) => Promise<string>;
  vaultHydrateTimeoutMs?: number;
  companionInstallTimeoutMs?: number;
}

export type ApplySetupStepsResult =
  | { ok: true; steps: SetupActionStepResult[] }
  | { ok: false; failedIndex: number; code: string; error: string; steps: SetupActionStepResult[] };

export type ExecuteFactorySetupResult =
  | {
      ok: true;
      applied: true;
      tier: 1;
      steps: SetupActionStepResult[];
    }
  | {
      ok: true;
      applied: false;
      proposalPending: true;
      tier: 2;
      proposalId: string;
      actionsHash: string;
      warnings: string[];
    }
  | {
      ok: false;
      code: string;
      error: string;
      tier?: FactorySetupTier;
      steps?: SetupActionStepResult[];
    };

function resolveDaemonApi(daemon?: SurfaceDaemonApi | (() => SurfaceDaemonApi | undefined)): SurfaceDaemonApi | undefined {
  return typeof daemon === "function" ? daemon() : daemon;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, code: string, label: string): Promise<T> {
  const effectiveMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new FactoryError(code, `${label} timed out after ${effectiveMs}ms`));
    }, effectiveMs);
    timer.unref?.();
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function gitHasOrigin(projectRoot: string): boolean {
  try {
    const res = spawnSync("git", ["-C", projectRoot, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 1_500,
    });
    return res.status === 0 && typeof res.stdout === "string" && res.stdout.trim() !== "";
  } catch {
    return false;
  }
}

function assertDesignIndexCleanForSync(projectRoot: string): void {
  const unmerged = spawnSync("git", ["-C", projectRoot, "diff", "--name-only", "--diff-filter=U"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (unmerged.status === 0 && typeof unmerged.stdout === "string" && unmerged.stdout.trim() !== "") {
    throw new FactoryError(
      "open-design-dirty-index",
      "Repository has unmerged git index conflicts; resolve conflicts before syncing Open Design.",
    );
  }
  const designStatus = spawnSync("git", ["-C", projectRoot, "status", "--porcelain", "--", "design/"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (designStatus.status !== 0) {
    throw new FactoryError(
      "open-design-checkpoint-failed",
      "Unable to inspect git status for design/ before Open Design sync.",
    );
  }
  if (typeof designStatus.stdout === "string" && designStatus.stdout.trim() !== "") {
    throw new FactoryError(
      "open-design-dirty-index",
      "design/ has uncommitted or unmerged changes; commit, stash, or resolve conflicts in design/ before syncing Open Design.",
    );
  }
}

async function assertNoWritablePeerInFlight(
  deps: FactorySetupRunnerDeps,
  project: FactorySetupProjectTarget,
): Promise<void> {
  const daemon = resolveDaemonApi(deps.daemon);
  const rootFactory = deps.registry?.root ?? deps.factory;
  if (daemon?.agents?.list === undefined || rootFactory === undefined) return;
  const page = await daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
  const live = page.entries.map((entry) => entry.agent).filter((agent) => agent.archivedAt === null);
  const source = { factory: rootFactory, ...(deps.registry === undefined ? {} : { registry: deps.registry }) };
  const inFlight = projectPeersInFlight({
    stateDir: deps.stateDir,
    slug: project.slug,
    root: project.root,
    source,
    live,
    law: "quiet-point",
  });
  const writable = inFlight.find((round) => {
    const contract = taskFactoryOf(source, project.slug, round.task).contractFor(round.task);
    return !isReadOnlyPeerDisposition(contract?.disposition);
  });
  if (writable !== undefined) {
    throw new FactoryError(
      "writable-peer-in-flight",
      `Cannot sync Open Design while writable Peer task ${writable.task} is in flight; let it settle or close it first.`,
    );
  }
}

function isVaultConfiguredSafely(paseoHome: string): boolean {
  try {
    const cfg = loadVaultConfig(paseoHome);
    return cfg !== null && cfg.repo.trim() !== "";
  } catch {
    return false;
  }
}

function missingStoreVaultKeys(paseoHome: string, projectRoot: string): string[] {
  const readiness = readVaultStoreReadiness(paseoHome);
  const platforms = detectMobilePlatforms(projectRoot);
  const needsIos = platforms.includes("ios") || platforms.includes("expo") || platforms.length === 0;
  const needsAndroid = platforms.includes("android") || platforms.includes("expo") || platforms.length === 0;
  const missing: string[] = [];
  if (needsIos) {
    if (!readiness.ascKey) missing.push("ASC_KEY_PATH (.p8)");
    if (!readiness.appleTeamId) missing.push("APPLE_TEAM_ID");
  }
  if (needsAndroid) {
    if (!readiness.gplayJson) missing.push("GPLAY_KEY_PATH (Google Play JSON)");
  }
  return missing;
}

/**
 * Tier 0: Secret-free, context-bounded Factory readiness inspection for a
 * registered Project.
 */
export async function inspectFactoryForProject(
  deps: FactorySetupRunnerDeps,
  project: FactorySetupProjectTarget,
): Promise<FactoryInspectSnapshot> {
  const userHome = resolveVaultUserHome(deps.home, deps.userHome);
  const capability = resolveStoreReleaseCapability({
    projectRoot: project.root,
    stateDir: deps.stateDir,
    projectSlug: project.slug,
  });
  const detectedPlatforms = detectMobilePlatforms(project.root);
  const hasOrigin = gitHasOrigin(project.root);
  const hasStoreManifest = existsSync(join(project.root, ".store-release", "manifest.json"));

  const releaseSettings = readReleaseSettings(deps.stateDir, project.slug);
  const storeReleaseSettings = readStoreReleaseSettings(deps.stateDir, project.slug);

  const releaseLab = await resolveReleaseLabWithDaemon(deps.home, deps.listPlugins ?? listDaemonPlugins);
  const skillsPack = inspectFactorySkillPack(userHome);

  const rawPacks = projectSkillPackInventory({
    stateDir: deps.stateDir,
    paseoHome: deps.home,
    userHome,
    projectRoot: project.root,
  });
  const skillPacks = {
    enabled: rawPacks.filter((pack) => pack.enabled).map((pack) => pack.id),
    available: rawPacks.map((pack) => ({
      id: pack.id,
      label: pack.label,
      autoDetected: pack.autoDetected,
    })),
  };

  const helperMcps = discoverHelperMcps({ stateDir: deps.stateDir, userHome }).servers.map((server) => ({
    name: server.name,
    enabled: server.enabled,
    status: server.status,
    machineWide: true as const,
  }));

  const odProbe = probeOpenDesign(deps.stateDir, project.slug, project.root);
  const odCatalog = discoverOpenDesignProjects(userHome)
    .slice(0, OPEN_DESIGN_INSPECT_MAX_PROJECTS)
    .map((entry) => ({
      projectId: entry.projectId,
      projectName: entry.projectName,
      screenCount: entry.screenCount,
    }));

  const vaultReadiness = readVaultStoreReadiness(deps.home);
  const vault = {
    configured: isVaultConfiguredSafely(deps.home),
    ascKey: vaultReadiness.ascKey,
    appleTeamId: vaultReadiness.appleTeamId,
    gplayJson: vaultReadiness.gplayJson,
  };

  const gh = await probeGhAuth(deps.vaultRunner);
  const proposal = recoverInterruptedSetupProposal(
    deps.stateDir,
    project.slug,
    deps.activeProposalRuns,
    deps.now,
  );

  return {
    project: {
      slug: project.slug,
      root: project.root,
    },
    isMobile: capability.isMobile,
    detectedPlatforms,
    hasOrigin,
    hasStoreManifest,
    companions: {
      "factory-release-lab": {
        installed: releaseLab.installed,
        enabled: releaseLab.enabled,
        status: releaseLab.status,
      },
      "factory-skills-pack": {
        installed: skillsPack.totalSkills > 0,
        status: skillsPack.status,
        installedCoreCount: skillsPack.installedCoreCount,
        revision: skillsPack.revision,
      },
    },
    release: {
      mode: releaseSettings.mode,
      branch: releaseSettings.branch ?? null,
    },
    storeRelease: {
      mode: storeReleaseSettings.mode,
      supervisorTier: capability.supervisorTier,
      leadEnabled: capability.leadEnabled,
    },
    skillPacks,
    helperMcps,
    openDesign: {
      linked: odProbe.link !== null,
      linkedProjectName: odProbe.link?.projectName ?? null,
      syncedAt: odProbe.link?.syncedAt ?? null,
      bundlePresent: odProbe.bundlePresent,
      unreadable: odProbe.unreadable,
      availableProjects: odCatalog,
    },
    vault,
    ghAuth: {
      installed: gh.ghInstalled,
      authenticated: gh.ghAuthenticated,
      user: gh.ghUser,
    },
    pendingProposal: proposal
      ? {
          id: proposal.id,
          actionsHash: proposal.actionsHash,
          status: proposal.status,
          reason: proposal.reason,
          actionKinds: proposal.actions.map((action) => action.kind),
          warnings: proposal.warnings ? [...proposal.warnings] : [],
          updatedAt: proposal.updatedAt,
        }
      : null,
  };
}

async function executeSingleSetupAction(
  deps: FactorySetupRunnerDeps,
  project: FactorySetupProjectTarget,
  action: FactorySetupAction,
  options: ApplySetupProposalOptions,
): Promise<string> {
  const userHome = resolveVaultUserHome(deps.home, deps.userHome);
  const vaultTimeoutMs = options.vaultHydrateTimeoutMs ?? deps.vaultHydrateTimeoutMs ?? VAULT_HYDRATE_TIMEOUT_MS;
  const companionTimeoutMs =
    options.companionInstallTimeoutMs ?? deps.companionInstallTimeoutMs ?? COMPANION_INSTALL_TIMEOUT_MS;

  switch (action.kind) {
    case "vault_hydrate": {
      if (options.hydrateVault !== undefined) {
        return await withTimeout(
          options.hydrateVault({ project }),
          vaultTimeoutMs,
          "vault-hydrate-timeout",
          "vault_hydrate",
        );
      }
      const res = await withTimeout(
        hydrateVaultDirect(deps.home, {
          runtimeOnly: true,
          projectDir: project.root,
          ...(deps.vaultRunner !== undefined ? { runner: deps.vaultRunner } : {}),
        }),
        vaultTimeoutMs,
        "vault-hydrate-timeout",
        "vault_hydrate",
      );
      const count = res.materializedProjectFiles?.length ?? 0;
      return `Hydrated runtime Vault (${res.hydratedFiles.length} runtime file(s), ${count} project file(s))`;
    }
    case "install_companion": {
      if (options.installCompanion !== undefined) {
        return await withTimeout(
          options.installCompanion({ id: action.id }),
          companionTimeoutMs,
          "companion-install-timeout",
          action.id,
        );
      }
      if (action.id === "factory-skills-pack") {
        return await withTimeout(
          Promise.resolve().then(() => {
            materializeVaultSkillsFromRuntime(deps.home, false, userHome);
            const res = installOrUpdateFactorySkillPack({
              userHome,
              action: "install",
              runner: deps.companionToolRunner,
            });
            if (!res.ok) {
              throw new FactoryError("companion-install-failed", res.reason);
            }
            return res.summary;
          }),
          companionTimeoutMs,
          "companion-install-timeout",
          "factory-skills-pack",
        );
      }
      const entry = COMPANION_CATALOG.find((candidate) => candidate.id === "factory-release-lab");
      if (entry === undefined) {
        throw new FactoryError("unknown-companion", `Unknown companion ${action.id}`);
      }
      if (
        entry.access === "private" &&
        !isLocalCompanionGitSource(entry.canonicalSource) &&
        (deps.installPlugin === undefined || deps.vaultRunner !== undefined)
      ) {
        const accessProbe = await withTimeout(
          probeCompanionGitAccess(
            entry.canonicalSource,
            deps.vaultRunner !== undefined ? { runner: deps.vaultRunner } : undefined,
          ),
          companionTimeoutMs,
          "companion-install-timeout",
          "factory-release-lab git access check",
        );
        if (!accessProbe.ok) {
          throw new FactoryError("private-companion-access-denied", accessProbe.reason);
        }
      }
      const installer = deps.installPlugin ?? installDaemonPlugin;
      const reply = await withTimeout(
        installer(deps.home, { id: entry.id, source: entry.canonicalSource }),
        companionTimeoutMs,
        "companion-install-timeout",
        entry.id,
      );
      if (!reply.ok) {
        throw new FactoryError("daemon_failed", reply.reason);
      }
      return `Installed companion ${entry.id}`;
    }
    case "set_release_mode": {
      if (options.applyReleaseMode !== undefined) {
        const res = await options.applyReleaseMode({
          project,
          mode: action.mode,
          ...(action.branch !== undefined ? { branch: action.branch } : {}),
        });
        return typeof res === "string" && res.trim() !== ""
          ? res
          : `Set Release mode to ${action.mode}${action.branch ? ` (branch ${action.branch})` : ""}`;
      }
      setProjectReleaseSettings(deps.stateDir, project.slug, {
        mode: action.mode,
        ...(action.branch !== undefined ? { branch: action.branch } : {}),
      });
      return `Set Release mode to ${action.mode}${action.branch ? ` (branch ${action.branch})` : ""}`;
    }
    case "set_store_release_mode": {
      if (options.applyStoreReleaseMode !== undefined) {
        const res = await options.applyStoreReleaseMode({ project, mode: action.mode });
        return typeof res === "string" && res.trim() !== ""
          ? res
          : `Set Store release mode to ${action.mode}`;
      }
      setProjectStoreReleaseSettings(deps.stateDir, project.slug, { mode: action.mode });
      return `Set Store release mode to ${action.mode}`;
    }
    case "set_skill_pack": {
      if (options.applySkillPack !== undefined) {
        return await options.applySkillPack({ project, pack: action.pack, enabled: action.enabled });
      }
      const current = readProjectSettings(deps.stateDir, project.slug).skillPacks ?? detectProjectSkillPacks(project.root);
      const next = action.enabled
        ? [...new Set([...current, action.pack])]
        : current.filter((pack) => pack !== action.pack);
      setProjectSkillPacks(deps.stateDir, project.slug, next);
      return `${action.pack} ${action.enabled ? "enabled" : "disabled"} for Project`;
    }
    case "set_helper_mcp": {
      if (options.applyHelperMcp !== undefined) {
        return await options.applyHelperMcp({ name: action.name, enabled: action.enabled });
      }
      setHelperMcpEnabled({ stateDir: deps.stateDir, userHome }, action.name, { enabled: action.enabled });
      provisionPiAgentHome({
        stateDir: deps.stateDir,
        role: "agent",
        sourceAgentDir: join(userHome, ".pi", "agent"),
        helperMcpSources: { userHome },
      });
      return `Helper MCP ${action.name} ${action.enabled ? "enabled" : "disabled"} (machine-wide)`;
    }
    case "sync_open_design": {
      if (options.syncOpenDesign !== undefined) {
        return await options.syncOpenDesign({ project, projectId: action.projectId });
      }
      await assertNoWritablePeerInFlight(deps, project);
      assertDesignIndexCleanForSync(project.root);
      return await withProjectIngressLock(deps.stateDir, project.slug, async () => {
        ensureProjectRegistered(deps.stateDir, { root: project.root, slug: project.slug });
        const link = syncOpenDesignLink({
          state: deps.stateDir,
          slug: project.slug,
          root: project.root,
          projectId: action.projectId,
          userHome,
        });
        return `Synced Open Design project "${link.projectName}" (${link.projectId})`;
      });
    }
  }
}

/**
 * Executes proposal/bundle steps sequentially starting from the first step
 * where `status !== "done"`. Fails fast on the first error, scrubs & caps
 * diagnostics via `scrubSetupDiagnostic`, and marks remaining steps `"skipped"`.
 *
 * Structured cleanly for both Tier 1 immediate execution and Wave 3a
 * `factory.setup_proposal.approve` (including `Retry` resumption).
 */
export async function applySetupProposalSteps(
  deps: FactorySetupRunnerDeps,
  project: FactorySetupProjectTarget,
  record: Pick<SetupProposalRecord, "steps">,
  options: ApplySetupProposalOptions = {},
): Promise<ApplySetupStepsResult> {
  const steps: SetupActionStepResult[] = record.steps.map((step) => ({ ...step }));
  const firstPendingIndex = steps.findIndex((step) => step.status !== "done");
  if (firstPendingIndex === -1) {
    return { ok: true, steps };
  }

  for (let i = firstPendingIndex; i < steps.length; i += 1) {
    const step = steps[i]!;
    try {
      const summary = await executeSingleSetupAction(deps, project, step.action, options);
      steps[i] = {
        index: step.index,
        action: step.action,
        tier: step.tier,
        status: "done",
        summary: scrubSetupDiagnostic(summary),
      };
    } catch (err) {
      const code = err instanceof FactoryError ? err.code : "setup-step-failed";
      const scrubbedError = scrubSetupDiagnostic(err instanceof Error ? err.message : String(err));
      steps[i] = {
        index: step.index,
        action: step.action,
        tier: step.tier,
        status: "failed",
        error: scrubbedError,
      };
      for (let j = i + 1; j < steps.length; j += 1) {
        const remaining = steps[j]!;
        steps[j] = {
          index: remaining.index,
          action: remaining.action,
          tier: remaining.tier,
          status: "skipped",
        };
      }
      return {
        ok: false,
        failedIndex: i,
        code,
        error: scrubbedError,
        steps,
      };
    }
  }

  return { ok: true, steps };
}

/**
 * Validates, checks preconditions, and either executes a Tier 1 setup bundle
 * sequentially or persists an atomic Tier 2 `SetupProposalRecord`.
 */
export async function executeFactorySetup(
  deps: FactorySetupRunnerDeps,
  project: FactorySetupProjectTarget,
  rawInput: { actions?: unknown; reason?: unknown },
  options: ApplySetupProposalOptions = {},
): Promise<ExecuteFactorySetupResult> {
  let validated;
  try {
    validated = validateFactorySetupInput(rawInput?.actions, rawInput?.reason);
  } catch (err) {
    if (err instanceof FactoryError) {
      return { ok: false, code: err.code, error: err.message };
    }
    return { ok: false, code: "invalid-setup-input", error: err instanceof Error ? err.message : String(err) };
  }

  const { canonicalActions, actionsHash, tier, reason } = validated;
  const userHome = resolveVaultUserHome(deps.home, deps.userHome);

  // Upfront action preconditions
  const capability = resolveStoreReleaseCapability({
    projectRoot: project.root,
    stateDir: deps.stateDir,
    projectSlug: project.slug,
  });
  let cachedHelperNames: Set<string> | undefined;
  let cachedOpenDesignIds: Set<string> | undefined;

  for (const action of canonicalActions) {
    if (action.kind === "set_store_release_mode" && action.mode !== "off" && !capability.isMobile) {
      return {
        ok: false,
        code: "store-release-not-mobile",
        error: `Store release mode "${action.mode}" requires a mobile Project (android, ios, or expo); ${project.slug} is not detected as a mobile Project.`,
      };
    }
    if (action.kind === "set_helper_mcp") {
      cachedHelperNames ??= new Set(
        discoverHelperMcps({ stateDir: deps.stateDir, userHome }).servers.map((server) => server.name),
      );
      if (!cachedHelperNames.has(action.name)) {
        return {
          ok: false,
          code: "helper-mcp-unknown",
          error: `Helper MCP "${action.name}" was not found in host discovery; verify its name with supervisor_inspect_factory first.`,
        };
      }
    }
    if (action.kind === "sync_open_design") {
      cachedOpenDesignIds ??= new Set(
        discoverOpenDesignProjects(userHome).map((entry) => entry.projectId),
      );
      if (!cachedOpenDesignIds.has(action.projectId)) {
        return {
          ok: false,
          code: "open-design-project-unavailable",
          error: `Open Design project "${action.projectId}" is not available on this host.`,
        };
      }
    }
  }

  const nowIso = deps.now?.() ?? new Date().toISOString();
  const initialSteps: SetupActionStepResult[] = canonicalActions.map((action, index) => ({
    index,
    action,
    tier: classifySetupActionTier(action),
    status: "pending",
  }));

  if (tier === 1) {
    const applied = await applySetupProposalSteps(
      deps,
      project,
      { steps: initialSteps },
      options,
    );
    appendSetupAudit(deps.stateDir, project.slug, {
      timestamp: deps.now?.() ?? new Date().toISOString(),
      projectSlug: project.slug,
      actionsHash,
      tier: 1,
      actor: "supervisor",
      reason,
      steps: applied.steps,
    });
    deps.onStateChange?.({
      handler: "factory.setup",
      projectSlug: project.slug,
      projectRoot: project.root,
    });
    if (!applied.ok) {
      return {
        ok: false,
        code: applied.code,
        error: applied.error,
        tier: 1,
        steps: applied.steps,
      };
    }
    return {
      ok: true,
      applied: true,
      tier: 1,
      steps: applied.steps,
    };
  }

  // Tier 2 preflight: ghAuth check when installing uninstalled private factory-release-lab
  const wantsReleaseLab = canonicalActions.some(
    (action) => action.kind === "install_companion" && action.id === "factory-release-lab",
  );
  if (wantsReleaseLab) {
    const releaseLabEntry = COMPANION_CATALOG.find((candidate) => candidate.id === "factory-release-lab");
    const releaseLabStatus = await resolveReleaseLabWithDaemon(deps.home, deps.listPlugins ?? listDaemonPlugins);
    if (
      !releaseLabStatus.installed &&
      releaseLabEntry !== undefined &&
      !isLocalCompanionGitSource(releaseLabEntry.canonicalSource)
    ) {
      const gh = await probeGhAuth(deps.vaultRunner);
      if (!gh.ghAuthenticated) {
        return {
          ok: false,
          code: "gh-auth-required",
          error: gh.ghInstalled
            ? 'GitHub CLI is not authenticated. Run "gh auth login --web -p https" before proposing factory-release-lab.'
            : 'GitHub CLI (`gh`) is not installed or authenticated. Install `gh` and run "gh auth login --web -p https" before proposing factory-release-lab.',
        };
      }
    }
  }

  // Non-blocking warnings (e.g., missing Vault store keys for detected mobile platforms)
  const warnings: string[] = [];
  const enablesStoreRelease = canonicalActions.some(
    (action) => action.kind === "set_store_release_mode" && action.mode !== "off",
  );
  if (enablesStoreRelease) {
    const missingKeys = missingStoreVaultKeys(deps.home, project.root);
    if (missingKeys.length > 0) {
      warnings.push(
        `Missing Private Vault store keys (${missingKeys.join(", ")}). Configure them in Settings -> Private Vault before staging or submitting builds.`,
      );
    }
  }

  // Recover any crashed "applying" proposal before checking busy state
  const existing = recoverInterruptedSetupProposal(
    deps.stateDir,
    project.slug,
    deps.activeProposalRuns,
    deps.now,
  );
  if (existing?.status === "applying") {
    return {
      ok: false,
      code: "setup-proposal-busy",
      error: "Another Setup Proposal is currently applying for this Project; wait for it to finish before submitting a new proposal.",
    };
  }

  const record: SetupProposalRecord = {
    schemaVersion: 1,
    id: randomUUID(),
    actionsHash,
    projectSlug: project.slug,
    status: "pending",
    reason,
    ...(warnings.length > 0 ? { warnings } : {}),
    actions: canonicalActions,
    steps: initialSteps,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  writeSetupProposal(deps.stateDir, project.slug, record);
  deps.onStateChange?.({
    handler: "factory.setup_proposal.created",
    projectSlug: project.slug,
    projectRoot: project.root,
  });

  return {
    ok: true,
    applied: false,
    proposalPending: true,
    tier: 2,
    proposalId: record.id,
    actionsHash: record.actionsHash,
    warnings,
  };
}
