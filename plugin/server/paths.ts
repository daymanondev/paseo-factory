/**
 * Path resolution for the plugin shell.
 *
 * The daemon forks the plugin process without an env override, so the plugin
 * inherits `PASEO_HOME` from the daemon: a daemon started with `--home
 * <custom>` keeps all factory state under that home, never `~/.paseo`
 * (ticket 01, verified against daemon `paseo-home.js`).
 *
 * The compiled plugin bundle is evaluated as CommonJS without `import.meta`
 * or `__dirname`, so the plugin cannot see its own source directory; the
 * daemon records it in `<paseoHome>/config.json` at install time and that is
 * where we read it back from (the same trick seatworks uses).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const PLUGIN_ID = "paseo-factory";

/** `~`-expansion so a manually set `PASEO_HOME=~/x` still resolves. */
export function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

/** The daemon home this plugin runs under: `PASEO_HOME` or `~/.paseo`. */
export function resolvePaseoHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  const raw = env.PASEO_HOME && env.PASEO_HOME.trim() !== "" ? env.PASEO_HOME : join(homeDir, ".paseo");
  return expandHome(raw, homeDir);
}

/**
 * Writable per-plugin state root. Everything the factory persists lives here:
 * `ledger.jsonl`, the spool (ADR 0004) and the generated `bin/` that puts
 * `factory-claim` on agent PATHs. Uninstalling the plugin leaves it behind —
 * it is the Owner's data, not the plugin's.
 */
export function stateDirFor(paseoHome: string): string {
  return join(paseoHome, "plugin-state", PLUGIN_ID);
}

/**
 * When `recordedPath` sits inside Paseo's managed plugin store
 * (`<paseoHome>/plugins/paseo-factory/<versionId>/<subpath>`), Paseo 0.13.0's
 * `PluginService.updateSource` calls `startExplicit(pluginId, candidate.directory)`
 * before `patchSource(...)` updates `config.json` and before `removeVersion(...)`
 * deletes `<old-uuid>`. Scanning `<paseoHome>/plugins/paseo-factory/` for the
 * newest existing sibling `<versionId>/<subpath>` resolves the active checkout
 * both during `startExplicit` and if `config.json` ever lags behind a managed
 * checkout rotation.
 */
export function resolveManagedPluginDir(paseoHome: string, recordedPath: string): string {
  const managedRoot = join(paseoHome, "plugins", PLUGIN_ID);
  const rel = relative(managedRoot, recordedPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return recordedPath;
  const parts = rel.split(sep);
  const subpath = parts.slice(1).join(sep);
  let entries;
  try {
    entries = readdirSync(managedRoot, { withFileTypes: true });
  } catch {
    return recordedPath;
  }
  let bestPath: string | undefined;
  let bestMtime = -1;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const versionDir = join(managedRoot, entry.name);
    const candidate = subpath !== "" ? join(versionDir, subpath) : versionDir;
    if (!existsSync(candidate)) continue;
    let mtime = 0;
    try {
      mtime = Math.max(statSync(versionDir).mtimeMs, statSync(candidate).mtimeMs);
    } catch {
      continue;
    }
    if (mtime > bestMtime || (mtime === bestMtime && candidate !== recordedPath)) {
      bestMtime = mtime;
      bestPath = candidate;
    }
  }
  return bestPath ?? recordedPath;
}

/**
 * The plugin's own source directory, as recorded by `paseo plugin install`
 * (`config.json → plugins["paseo-factory"] = {source: "directory", path}`).
 * `undefined` when the config is unreadable or the entry is not a local
 * directory install — callers must degrade visibly, never crash.
 */
export function pluginDirFor(paseoHome: string): string | undefined {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8"));
  } catch {
    return undefined;
  }
  const entry = (config as { plugins?: Record<string, unknown> })?.plugins?.[PLUGIN_ID];
  if (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { source?: unknown }).source === "directory" &&
    typeof (entry as { path?: unknown }).path === "string"
  ) {
    return resolveManagedPluginDir(paseoHome, (entry as { path: string }).path);
  }
  return undefined;
}
