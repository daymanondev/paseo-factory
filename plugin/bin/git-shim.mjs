#!/usr/bin/env node
/**
 * git — the v0.0.4 git shim (the exec-time net of the permission choke).
 *
 * Lives in the hook-injected PATH dir (`<stateDir>/bin`, beside
 * `factory-claim`), so it wins over everything the agent exports on PATH and
 * a PATH-resolved dangerous git dies here, at exec time, no matter who runs
 * it. Absolute-path invocations (`/usr/bin/git …`) bypass this dir entirely —
 * that is what the ask-time policy layer is for; the two nets compose.
 *
 * Behavior:
 * - Dangerous argv (ticket 01 §a): refuse BEFORE exec — exit 126, one
 *   explanatory stderr line (the agent sees why and can adapt), and one JSON
 *   line appended to `<stateDir>/git-blocked.log`, which the plugin ingests
 *   into the ledger as `git_blocked` (exactly-once, by the line's id).
 * - Everything else: find the real git (PATH entries after this shim's own
 *   dir, then the usual absolute fallbacks — agent shells under the daemon
 *   start with a nearly empty PATH), exec it with the exact argv, inherit
 *   stdio, forward SIGINT/SIGTERM, and exit with its code. The pass-through
 *   must be invisible: `git status` is `git status`.
 *
 * The generated wrapper at `<stateDir>/bin/git` execs this script with the
 * daemon's node binary and FACTORY_STATE_DIR baked in. Direct dev runs must
 * set FACTORY_STATE_DIR themselves.
 */
import { appendFileSync, constants as fsConstants, existsSync, mkdirSync, accessSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  isSeatMemoryRelativePathAllowed,
  parseGitSubcommand,
  refuseGitArgv,
  refuseSupervisorGitArgv,
} from "./git-refusals.mjs";

const argv = process.argv.slice(2);
const stateDir = process.env.FACTORY_STATE_DIR;
const REFUSAL_EXIT = 126; // "found but not usable" — distinct from git's own 128 fatal errors

const die = (message) => {
  console.error(message);
  process.exit(2);
};

if (stateDir === undefined || stateDir === "") {
  die("git shim: FACTORY_STATE_DIR is not set — the generated wrapper bakes it in; direct runs must export it");
}

/** The absolute fallbacks for agent shells whose PATH holds nothing but this dir. */
const GIT_FALLBACKS = ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"];

function isExecutable(path) {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveRealGit() {
  // Two dirs must never supply the "real" git: the wrapper's own dir (the
  // generated `<stateDir>/bin/git` IS this shim — exec'ing it again recurses
  // forever) and the script's own dir (dev-layout belt and braces). $0 is
  // lost after the wrapper's exec, so the wrapper dir comes from the baked
  // FACTORY_STATE_DIR.
  const skip = new Set([join(stateDir, "bin"), dirname(process.argv[1] ?? "")]);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "" || dir === "." || skip.has(dir)) continue;
    const candidate = join(dir, "git");
    if (existsSync(candidate) && isExecutable(candidate)) return candidate;
  }
  return GIT_FALLBACKS.find(isExecutable);
}

function resolveEffectiveCwd(globalFlags) {
  let cwd = process.cwd();
  for (let i = 0; i < globalFlags.length; i++) {
    if (globalFlags[i] === "-C" && typeof globalFlags[i + 1] === "string") {
      cwd = isAbsolute(globalFlags[i + 1]) ? globalFlags[i + 1] : resolve(cwd, globalFlags[i + 1]);
      i += 1;
    }
  }
  return cwd;
}

function hasMergeOrCherryPickHead(realGit, globalFlags) {
  const effectiveCwd = resolveEffectiveCwd(globalFlags);
  if (
    existsSync(join(effectiveCwd, ".git", "MERGE_HEAD")) ||
    existsSync(join(effectiveCwd, ".git", "CHERRY_PICK_HEAD"))
  ) {
    return true;
  }
  if (realGit === undefined) return false;
  const rev = spawnSync(realGit, [...globalFlags, "rev-parse", "--git-dir"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (rev.status !== 0 || typeof rev.stdout !== "string") return false;
  const rawGitDir = rev.stdout.trim();
  if (rawGitDir === "") return false;
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(effectiveCwd, rawGitDir);
  return existsSync(join(gitDir, "MERGE_HEAD")) || existsSync(join(gitDir, "CHERRY_PICK_HEAD"));
}

function checkLeadGitCommit(realGit, argvTokens) {
  const { globalFlags, sub, args } = parseGitSubcommand(argvTokens);
  if (sub !== "commit") return undefined;
  if (hasMergeOrCherryPickHead(realGit, globalFlags)) return undefined;
  if (realGit === undefined) return undefined;

  const staged = spawnSync(realGit, [...globalFlags, "diff", "--cached", "--name-only"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const paths = new Set(
    (staged.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );

  // Also check unstaged tracked files when -a / --all is passed (e.g. `git commit -am ...`).
  const hasAllFlag = args.some(
    (t) => t === "-a" || t === "--all" || (t.length >= 2 && t[0] === "-" && t[1] !== "-" && t.slice(1).includes("a")),
  );
  if (hasAllFlag) {
    const unstaged = spawnSync(realGit, [...globalFlags, "diff", "--name-only"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    for (const line of (unstaged.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) {
      paths.add(line);
    }
  }

  const disallowed = [...paths].filter((file) => !isSeatMemoryRelativePathAllowed(file));
  if (disallowed.length > 0) {
    return {
      rule: "lead-git-fence",
      reason:
        `factory git-shim: blocked (lead-git-fence) — Lead may only commit project memory/docs ` +
        `(AGENTS.md, CLAUDE.md, CONTEXT.md, GLOSSARY.md, .gitignore, .worktreeinclude, docs/**, .scratch/**) on <project-root>; ` +
        `staged outside whitelist: ${disallowed.join(", ")}`,
    };
  }
  return undefined;
}

// ---- the refusal -------------------------------------------------------------------------------

const seat = (process.env.PASEO_FACTORY_SEAT ?? "").trim();
let refusal = refuseGitArgv(argv);
if (refusal === undefined && seat === "supervisor") {
  refusal = refuseSupervisorGitArgv(argv);
}
if (refusal === undefined && seat === "lead") {
  refusal = checkLeadGitCommit(resolveRealGit(), argv);
}
if (refusal !== undefined) {
  const command = ["git", ...argv].join(" ");
  const block = {
    id: `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    ts: new Date().toISOString(),
    command,
    rule: refusal.rule,
    reason: refusal.reason,
    cwd: process.cwd(),
    ...(process.env.PASEO_AGENT_ID === undefined || process.env.PASEO_AGENT_ID === ""
      ? {}
      : { agent: process.env.PASEO_AGENT_ID }),
  };
  try {
    mkdirSync(stateDir, { recursive: true });
    // O_APPEND single write: concurrent shim processes never interleave lines.
    appendFileSync(join(stateDir, "git-blocked.log"), `${JSON.stringify(block)}\n`);
  } catch (err) {
    // The refusal itself must never depend on logging succeeding.
    console.error(`git shim: WARNING could not append the block line: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.error(`git: paseo-factory refused to run: ${refusal.reason} [${refusal.rule}]`);
  console.error(`git: nothing was executed; adapt the command (e.g. --force-with-lease) and retry.`);
  process.exit(REFUSAL_EXIT);
}

// ---- the pass-through --------------------------------------------------------------------------

const realGit = resolveRealGit();
if (realGit === undefined) {
  console.error("git: paseo-factory shim found no real git on PATH or in the usual locations — nothing was executed");
  process.exit(127);
}

const child = spawn(realGit, argv, { stdio: "inherit" });
const forward = new Set(["SIGINT", "SIGTERM", "SIGHUP"]);
for (const signal of forward) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (err) => {
  console.error(`git: paseo-factory shim could not run ${realGit}: ${err.message}`);
  process.exit(127);
});
child.on("close", (code, signal) => {
  if (signal !== null) {
    // Die by the same signal (default disposition restored first, so this
    // actually terminates rather than re-entering the forwarder above).
    for (const s of forward) process.removeAllListeners(s);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
