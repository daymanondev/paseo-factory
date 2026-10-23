/**
 * Pure plugin action progress, Core (`paseo-factory`) self-restart detection
 * and watch resolution, and per-card / toolbar progress pill formatters
 * (v0.0.34, ADR 0012 §4). Zero React Native runtime imports so Node unit
 * tests can exercise the state machine directly.
 */
import type { ManageablePluginId } from "../../shared/companions.ts";
import type { CompanionPluginView, FactoryView } from "../../shared/view.ts";

export interface ActivePluginAct {
  kind: "check" | "install" | "manage" | "restarting-core";
  target: ManageablePluginId | "all";
  action?: "enable" | "disable" | "reload" | "update" | "remove" | "restarting-core";
  startedAt: number;
  fromRevision?: string | null;
  targetRevision?: string | null;
}

export interface PluginsNote {
  text: string;
  tone: "statusSuccess" | "statusWarning" | "statusDanger";
  pluginId?: ManageablePluginId | "all";
}

const CORE_RESTART_ERROR_RE =
  /Plugin stopped:\s*paseo-factory|Plugin is not available:\s*paseo-factory|daemon socket closed before response|WebSocket| disconnected|timed out/i;

/**
 * Returns true when an error from `pluginsManage` on `paseo-factory` (or a
 * batch `Update All` that includes `paseo-factory`) is caused by the daemon
 * stopping the calling `paseo-factory` worker mid-RPC during a hot-swap.
 */
export function isCoreSelfRestartError(input: {
  target: ManageablePluginId | "all";
  action?: string;
  errorMessage: string;
  coreTargeted?: boolean;
}): boolean {
  const targetsCore =
    (input.target === "paseo-factory" || input.target === "all") &&
    (input.coreTargeted ?? input.target === "paseo-factory");
  if (!targetsCore) return false;
  if (input.action !== "update" && input.action !== "reload") return false;
  return CORE_RESTART_ERROR_RE.test(input.errorMessage);
}

export const DEFAULT_CORE_RESTART_TIMEOUT_MS = 45_000;

/**
 * Evaluates a polled `FactoryView` while waiting for `paseo-factory` to finish
 * restarting after a self-update or self-reload.
 */
export function resolveCoreRestartWatch(input: {
  view: Pick<FactoryView, "corePlugin">;
  previousRevision: string | null;
  targetRevision: string | null;
  action: "update" | "reload";
  elapsedMs: number;
  timeoutMs?: number;
}): { status: "waiting" } | { status: "completed"; note: PluginsNote } | { status: "failed"; note: PluginsNote } {
  const { corePlugin } = input.view;
  if (corePlugin.status === "failed" || corePlugin.error !== null) {
    return {
      status: "failed",
      note: {
        text: `${input.action === "reload" ? "Reload" : "Update"} failed on paseo-factory: ${corePlugin.error ?? "Core plugin entered failed state"}`,
        tone: "statusDanger",
        pluginId: "paseo-factory",
      },
    };
  }

  if (input.action === "update") {
    const landed =
      corePlugin.status === "running" &&
      corePlugin.currentRevision !== null &&
      (input.targetRevision !== null
        ? corePlugin.currentRevision.startsWith(input.targetRevision.slice(0, 7)) ||
          input.targetRevision.startsWith(corePlugin.currentRevision.slice(0, 7))
        : corePlugin.currentRevision !== input.previousRevision);
    if (landed && corePlugin.currentRevision !== null) {
      const prevShort = (input.previousRevision ?? "prev").slice(0, 7);
      const currShort = corePlugin.currentRevision.slice(0, 7);
      const versionSuffix = corePlugin.version ? ` · v${corePlugin.version.replace(/^v/, "")} is now running` : "";
      return {
        status: "completed",
        note: {
          text: `Updated paseo-factory (${prevShort} → ${currShort})${versionSuffix}`,
          tone: "statusSuccess",
          pluginId: "paseo-factory",
        },
      };
    }
  } else if (input.action === "reload") {
    if (corePlugin.status === "running" && input.elapsedMs >= 500) {
      const versionSuffix = corePlugin.version ? ` (v${corePlugin.version.replace(/^v/, "")})` : "";
      return {
        status: "completed",
        note: {
          text: `Reloaded paseo-factory on the daemon${versionSuffix}`,
          tone: "statusSuccess",
          pluginId: "paseo-factory",
        },
      };
    }
  }

  if (input.elapsedMs >= (input.timeoutMs ?? DEFAULT_CORE_RESTART_TIMEOUT_MS)) {
    return {
      status: "failed",
      note: {
        text: "Timed out waiting for paseo-factory to finish restarting on the daemon.",
        tone: "statusDanger",
        pluginId: "paseo-factory",
      },
    };
  }

  return { status: "waiting" };
}

/**
 * Formats the per-card `accent` progress pill for `companion` when `activeAct`
 * targets that card directly or via a batch (`"all"`) act.
 */
export function formatPluginCardProgressPill(
  companion: CompanionPluginView,
  activeAct: ActivePluginAct | null,
  elapsedSeconds: number,
): string | null {
  if (activeAct === null || activeAct.kind === "check") return null;

  if (activeAct.kind === "restarting-core" || activeAct.action === "restarting-core") {
    if (companion.id !== "paseo-factory") return null;
    return `Reloading Core${activeAct.targetRevision ? ` → ${activeAct.targetRevision.slice(0, 7)}` : ""}… · ${elapsedSeconds}s`;
  }

  if (activeAct.kind === "install") {
    const targeted =
      activeAct.target === companion.id ||
      (activeAct.target === "all" &&
        companion.id !== "paseo-factory" &&
        companion.access === "public" &&
        companion.status === "not_installed");
    if (!targeted) return null;
    return `Installing from GitHub… · ${elapsedSeconds}s`;
  }

  if (activeAct.kind === "manage") {
    const targeted =
      activeAct.target === companion.id ||
      (activeAct.target === "all" &&
        activeAct.action === "update" &&
        companion.status !== "not_installed" &&
        (companion.installKind === "git" || companion.installKind === "npm") &&
        companion.updateAvailable === true);
    if (!targeted) return null;

    switch (activeAct.action) {
      case "update": {
        const rawCurrent = activeAct.fromRevision ?? companion.currentRevision;
        const rawTarget = activeAct.targetRevision ?? companion.latestRevision;
        const shortCurrent = rawCurrent ? rawCurrent.slice(0, 7) : null;
        const shortTarget = rawTarget ? rawTarget.slice(0, 7) : null;
        return `Updating${shortCurrent && shortTarget && shortCurrent !== shortTarget ? ` ${shortCurrent} → ${shortTarget}` : ""}… · ${elapsedSeconds}s`;
      }
      case "reload":
        return `Reloading plugin… · ${elapsedSeconds}s`;
      case "enable":
        return `Enabling plugin… · ${elapsedSeconds}s`;
      case "disable":
        return `Disabling plugin… · ${elapsedSeconds}s`;
      case "remove":
        return `Removing plugin… · ${elapsedSeconds}s`;
      default:
        return null;
    }
  }

  return null;
}

/**
 * Formats the `Plugins` toolbar's in-flight `accent` progress pill.
 */
export function formatToolbarProgressPill(
  activeAct: ActivePluginAct | null,
  checkingUpdates: boolean,
  elapsedSeconds: number,
): string | null {
  if (activeAct !== null) {
    if (activeAct.kind === "check") {
      return elapsedSeconds > 0 ? `Checking updates… · ${elapsedSeconds}s` : "Checking updates…";
    }
    if (activeAct.kind === "restarting-core" || activeAct.action === "restarting-core") {
      const targetId = activeAct.target === "all" ? "paseo-factory" : activeAct.target;
      return `Reloading Core ${targetId}… · ${elapsedSeconds}s`;
    }
    if (activeAct.kind === "install") {
      const targetLabel = activeAct.target === "all" ? "All" : activeAct.target;
      return `Installing ${targetLabel}… · ${elapsedSeconds}s`;
    }
    if (activeAct.kind === "manage") {
      const targetLabel = activeAct.target === "all" ? "All" : activeAct.target;
      switch (activeAct.action) {
        case "update":
          return `Updating ${targetLabel}… · ${elapsedSeconds}s`;
        case "reload":
          return `Reloading ${targetLabel}… · ${elapsedSeconds}s`;
        case "enable":
          return `Enabling ${targetLabel}… · ${elapsedSeconds}s`;
        case "disable":
          return `Disabling ${targetLabel}… · ${elapsedSeconds}s`;
        case "remove":
          return `Removing ${targetLabel}… · ${elapsedSeconds}s`;
        default:
          break;
      }
    }
  }
  if (checkingUpdates) return "Checking updates…";
  return null;
}


