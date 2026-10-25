/**
 * The agent-facing surface: ADR 0004 delivers the Claim as a CLI on the
 * agent's PATH, not as an MCP tool.
 *
 * Mechanism, verified against the 0.10.3 daemon source: the
 * `agent.session_open` before-hook's returned `env` is applied as an overlay
 * on the daemon's environment for every provider launch, and this hook fires
 * for create, resume, refresh and import alike — while `env` set only at
 * `agent.create` is not re-applied on resume. One hook, every launch.
 *
 * The PATH entry points at `<stateDir>/bin`, which holds generated wrappers
 * (not the plugin's own `bin/`): each wrapper execs the daemon's node binary
 * explicitly, so the tool works even under desktop-app daemons whose PATH has
 * no `node`. Since v0.0.4 the same dir also holds the `git` shim — the
 * exec-time net for PATH-resolved dangerous git (the ask-time net is the
 * choke in `plugin/server/choke.ts`).
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";

/** Where the generated `factory-claim` wrapper lives. */
export function claimCliBinDir(stateDir: string): string {
  return join(stateDir, "bin");
}

/**
 * Self-contained staging directory for `plugin/bin/*.mjs` runtime scripts under
 * `<stateDir>/runtime-bin` (kept separate from `<stateDir>/bin` so only the 12
 * wrapper executables sit on agent PATHs). Staging scripts here ensures
 * `<stateDir>/bin/*` wrappers survive when Paseo's `PluginService.updateSource`
 * deletes an older `<paseoHome>/plugins/paseo-factory/<uuid>` checkout.
 */
export function runtimeBinDir(stateDir: string): string {
  return join(stateDir, "runtime-bin");
}

function syncFileIfChanged(srcPath: string, destPath: string, mode = 0o755): void {
  const body = readFileSync(srcPath);
  if (existsSync(destPath)) {
    try {
      if (readFileSync(destPath).equals(body)) return;
    } catch {
      // rewrite if unreadable
    }
  }
  writeFileSync(destPath, body);
  chmodSync(destPath, mode);
}

/**
 * Stages `plugin/bin/*.mjs` into `<stateDir>/runtime-bin/` (and
 * `plugin/shared/*.mjs` into `<stateDir>/shared/` for `../shared/*` relative
 * imports) and returns `<stateDir>/runtime-bin`. Falls back to
 * `join(pluginDir, "bin")` only when `pluginDir/bin` is a synthetic test
 * directory with no `.mjs` files and `<stateDir>/runtime-bin` has not been
 * populated.
 */
export function stagePluginBinScripts(stateDir: string, pluginDir: string): string {
  const srcBinDir = join(pluginDir, "bin");
  const stagedBinDir = runtimeBinDir(stateDir);
  let mjsFiles: string[] = [];
  try {
    mjsFiles = readdirSync(srcBinDir).filter((name) => name.endsWith(".mjs"));
  } catch {
    mjsFiles = [];
  }
  if (mjsFiles.length > 0) {
    mkdirSync(stagedBinDir, { recursive: true });
    for (const name of mjsFiles) {
      syncFileIfChanged(join(srcBinDir, name), join(stagedBinDir, name), 0o755);
    }
    const srcSharedDir = join(pluginDir, "shared");
    try {
      const sharedFiles = readdirSync(srcSharedDir).filter((name) => name.endsWith(".mjs"));
      if (sharedFiles.length > 0) {
        const destSharedDir = join(stateDir, "shared");
        mkdirSync(destSharedDir, { recursive: true });
        for (const name of sharedFiles) {
          syncFileIfChanged(join(srcSharedDir, name), join(destSharedDir, name), 0o644);
        }
      }
    } catch {
      // optional shared dir in synthetic test fixtures
    }
    return stagedBinDir;
  }
  if (existsSync(join(stagedBinDir, "git-shim.mjs")) || existsSync(join(stagedBinDir, "factory-claim.mjs"))) {
    return stagedBinDir;
  }
  return srcBinDir;
}

/**
 * Prepend the factory bin dir to the request's PATH, idempotently. Because the
 * daemon passes `request.env` to `agent.session_open` as an overlay (often `{}`)
 * and later `Object.assign`s it onto `process.env`, a missing `request.env.PATH`
 * must seed from the daemon's `process.env.PATH` (`basePath`) — setting `PATH`
 * to `binDir` alone would clobber `process.env.PATH` and break every provider
 * CLI resolved via PATH (`copilot`, `pi`, `opencode`, etc.). An empty base PATH
 * stays empty-tail-free so a trailing delimiter never puts CWD on PATH.
 */
export function injectClaimCliPath<T extends PluginSessionOpenRequest>(
  request: T,
  binDir: string,
  basePath: string = process.env.PATH ?? "",
): T {
  const raw = typeof request.env?.PATH === "string" && request.env.PATH !== "" ? request.env.PATH : basePath;
  const entries = raw.split(delimiter).filter((entry) => entry !== "");
  const path = [binDir, ...entries.filter((entry) => entry !== binDir)].join(delimiter);
  if (request.env?.PATH === path) return request;
  return { ...request, env: { ...request.env, PATH: path } };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * (Re)generate `<stateDir>/bin/factory-claim`. Rewritten when content changes
 * — a daemon update can move the node binary, and the wrapper must follow.
 * The wrapper bakes in `FACTORY_STATE_DIR` so the CLI lands in this daemon's
 * spool no matter which agent process runs it. The caller skips this entirely
 * when the plugin directory is unknown and logs that loudly instead (no
 * component dies silently).
 */
export function ensureClaimCli(stateDir: string, pluginDir: string, nodeBinary: string): void {
  const scriptDir = stagePluginBinScripts(stateDir, pluginDir);
  ensureGeneratedWrapper({
    target: join(claimCliBinDir(stateDir), "factory-claim"),
    script: join(scriptDir, "factory-claim.mjs"),
    stateDir,
    nodeBinary,
  });
}

/**
 * (Re)generate `<stateDir>/bin/git` — the v0.0.4 git shim (same hook-injected
 * dir, same wrapper mechanics as the claim CLI). The shim wins over everything
 * the agent exports on PATH, so a PATH-resolved dangerous git dies at exec
 * time; absolute-path invocations are the policy layer's business (the two
 * nets compose). Everything benign passes through to the real git untouched.
 */
export function ensureGitShim(stateDir: string, pluginDir: string, nodeBinary: string): void {
  const binDir = claimCliBinDir(stateDir);
  const scriptDir = stagePluginBinScripts(stateDir, pluginDir);
  ensureGeneratedWrapper({
    target: join(binDir, "git"),
    script: join(scriptDir, "git-shim.mjs"),
    stateDir,
    nodeBinary,
  });
  const execShimScript = join(scriptDir, "exec-shim.mjs");
  for (const tool of ["pkill", "kill", "killall", "paseo", "gh", "npm", "npx", "pnpm", "yarn", "bun"] as const) {
    ensureGeneratedWrapper({
      target: join(binDir, tool),
      script: execShimScript,
      extraArg: tool,
      stateDir,
      nodeBinary,
    });
  }
}

function ensureGeneratedWrapper(input: {
  target: string;
  script: string;
  extraArg?: string;
  stateDir: string;
  nodeBinary: string;
}): void {
  const binDir = dirname(input.target);
  mkdirSync(binDir, { recursive: true });
  const extra = input.extraArg !== undefined ? ` ${shellQuote(input.extraArg)}` : "";
  const body =
    `#!/bin/sh\n` +
    `ELECTRON_RUN_AS_NODE=1 FACTORY_STATE_DIR=${shellQuote(input.stateDir)} ` +
    `exec ${shellQuote(input.nodeBinary)} ${shellQuote(input.script)}${extra} "$@"\n`;
  if (existsSync(input.target) && readFileSync(input.target, "utf8") === body) return;
  writeFileSync(input.target, body);
  chmodSync(input.target, 0o755);
}
