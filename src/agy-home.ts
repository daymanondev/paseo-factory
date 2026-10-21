/**
 * Antigravity (`agy`) plugin auto-provisioner (v0.0.26, ADR 0016 §3):
 * Because Paseo's `AgentManager.requireExternalMcpSupport` rejects non-empty
 * `config.mcpServers` on `antigravity` sessions, `paseo-factory` omits
 * `config.mcpServers` for `antigravity` / `agy` on `agent.create` and instead
 * provisions `<agyPluginsDir>/paseo-factory/{plugin.json,mcp_config.json,hooks.json}`
 * alongside `<stateDir>/bin/agy-pre-tool-hook.mjs` and `<stateDir>/bin/bridge.mjs`.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isElectronNodeBinary } from "./pi-home.ts";

export interface ProvisionAgyPluginOptions {
  stateDir: string;
  /**
   * Optional override for `~/.gemini/config/plugins`. Defaults to
   * `process.env.PASEO_FACTORY_AGY_PLUGINS_DIR`, `<userHome>/.gemini/config/plugins`,
   * or `<stateDir>/agy-plugins` when `stateDir` sits inside an OS temp dir.
   */
  agyPluginsDir?: string;
  userHome?: string;
  nodePath?: string;
  pluginDir?: string;
}

function isTempDirPath(p: string): boolean {
  const resolved = resolve(p);
  const sysTmp = resolve(tmpdir());
  return (
    resolved.startsWith(`${sysTmp}/`) ||
    resolved.startsWith("/tmp/") ||
    resolved.startsWith("/private/tmp/") ||
    resolved.startsWith("/var/folders/") ||
    resolved.startsWith("/private/var/folders/")
  );
}

function defaultRepoBinDir(): string {
  try {
    const here = dirname(new URL(import.meta.url).pathname);
    const candidate1 = resolve(here, "../plugin/bin");
    if (existsSync(candidate1)) return candidate1;
    const candidate2 = resolve(here, "../../bin");
    if (existsSync(candidate2)) return candidate2;
  } catch {
    // ignore URL resolution errors (e.g. CJS bundle where import.meta is {})
  }
  return "";
}

function resolvePluginBinDir(stateDir: string, pluginDir?: string): string {
  if (pluginDir !== undefined && existsSync(join(pluginDir, "bin"))) {
    return join(pluginDir, "bin");
  }
  const configCandidates = [
    resolve(stateDir, "../..", "config.json"),
    join(homedir(), ".paseo-factory", "config.json"),
    join(homedir(), ".paseo", "config.json"),
  ];
  for (const configPath of configCandidates) {
    try {
      if (!existsSync(configPath)) continue;
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
        plugins?: Record<string, { path?: unknown }>;
      };
      const recordedPath = cfg.plugins?.["paseo-factory"]?.path;
      if (typeof recordedPath === "string" && existsSync(join(recordedPath, "bin"))) {
        return join(recordedPath, "bin");
      }
    } catch {
      // ignore unreadable config.json
    }
  }
  return defaultRepoBinDir();
}

export function ensureFactoryBinScripts(stateDir: string, pluginDir?: string): { bridgeBinPath: string; agyHookBinPath: string } {
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const sourceBinDir = resolvePluginBinDir(stateDir, pluginDir);

  const bridgeBinPath = join(binDir, "bridge.mjs");
  const agyHookBinPath = join(binDir, "agy-pre-tool-hook.mjs");

  if (sourceBinDir !== "") {
    const srcBridge = join(sourceBinDir, "bridge.mjs");
    if (existsSync(srcBridge)) {
      copyFileSync(srcBridge, bridgeBinPath);
      chmodSync(bridgeBinPath, 0o755);
    }
    const srcHook = join(sourceBinDir, "agy-pre-tool-hook.mjs");
    if (existsSync(srcHook)) {
      copyFileSync(srcHook, agyHookBinPath);
      chmodSync(agyHookBinPath, 0o755);
    }
  }
  return { bridgeBinPath, agyHookBinPath };
}

export function resolveAgyPluginsDir(options: ProvisionAgyPluginOptions): string {
  if (typeof options.agyPluginsDir === "string" && options.agyPluginsDir.trim() !== "") {
    return options.agyPluginsDir.trim();
  }
  const envDir = process.env.PASEO_FACTORY_AGY_PLUGINS_DIR;
  if (typeof envDir === "string" && envDir.trim() !== "") {
    return envDir.trim();
  }
  if (typeof options.userHome === "string" && options.userHome.trim() !== "") {
    return join(options.userHome.trim(), ".gemini", "config", "plugins");
  }
  if (isTempDirPath(options.stateDir)) {
    return join(options.stateDir, "agy-plugins");
  }
  return join(homedir(), ".gemini", "config", "plugins");
}

export function provisionAgyPlugin(options: ProvisionAgyPluginOptions): string {
  const nodePath = options.nodePath ?? process.execPath;
  const { bridgeBinPath, agyHookBinPath } = ensureFactoryBinScripts(options.stateDir, options.pluginDir);
  const pluginsRoot = resolveAgyPluginsDir(options);
  const pluginDir = join(pluginsRoot, "paseo-factory");
  mkdirSync(pluginDir, { recursive: true });

  const pluginJson = {
    name: "paseo-factory",
    version: "0.0.26",
    description: "Role-scoped MCP bridge and PreToolUse execution fence for paseo-factory seats on Antigravity (agy)",
  };
  const mcpConfigJson = {
    mcpServers: {
      paseo_factory: {
        command: nodePath,
        args: [bridgeBinPath, "--state-dir", options.stateDir],
        // Paseo Desktop's execPath is an Electron helper — bridge.mjs must run
        // in Node mode (v0.0.27, ADR 0017 §2).
        ...(isElectronNodeBinary(nodePath) ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
      },
    },
  };
  const quoted = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const hooksJson = {
    hooks: {
      PreToolUse: [
        {
          matcher: ".*",
          hooks: [
            {
              type: "command",
              // The hook is a Node script too — under Paseo Desktop it runs the
              // same Electron binary in Node mode.
              command: `${isElectronNodeBinary(nodePath) ? "ELECTRON_RUN_AS_NODE=1 " : ""}${quoted(nodePath)} ${quoted(agyHookBinPath)}`,
            },
          ],
        },
      ],
    },
  };

  writeFileSync(join(pluginDir, "plugin.json"), `${JSON.stringify(pluginJson, null, 2)}\n`);
  writeFileSync(join(pluginDir, "mcp_config.json"), `${JSON.stringify(mcpConfigJson, null, 2)}\n`);
  writeFileSync(join(pluginDir, "hooks.json"), `${JSON.stringify(hooksJson, null, 2)}\n`);
  return pluginDir;
}
