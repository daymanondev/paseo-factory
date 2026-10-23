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
import { appendFileSync, constants as fsConstants, existsSync, mkdirSync, accessSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { inheritChildOutcome } from "./process-policy.mjs";
import {
  isSeatMemoryRelativePathAllowed,
  parseGitSubcommand,
  refuseGitArgv,
  refuseSupervisorGitArgv,
} from "./git-refusals.mjs";

import { readLedgerEvents } from "./ledger-read.mjs";
import { scopeCoversFile, scopeRecoveryCommands } from "./scope.mjs";

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

const COMMIT_LONG_VALUE_FLAGS = new Set([
  "--message",
  "--file",
  "--reedit-message",
  "--reuse-message",
  "--fixup",
  "--squash",
  "--author",
  "--date",
  "--cleanup",
  "--template",
  "--trailer",
  "--pathspec-from-file",
]);

const COMMIT_SHORT_VALUE_LETTERS = new Set(["m", "F", "c", "C", "t"]);

function extractCommitPathspecs(args) {
  const pathspecs = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (afterDoubleDash) {
      pathspecs.push(token);
      continue;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token === "--pathspec-from-file" || token.startsWith("--pathspec-from-file=")) {
      pathspecs.push(token);
      if (token === "--pathspec-from-file") i += 1;
      continue;
    }
    if (COMMIT_LONG_VALUE_FLAGS.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      continue;
    }
    if (token.startsWith("-") && token.length >= 2) {
      const letters = token.slice(1);
      let attachedValue = false;
      for (let j = 0; j < letters.length - 1; j++) {
        if (COMMIT_SHORT_VALUE_LETTERS.has(letters[j])) {
          attachedValue = true;
          break;
        }
      }
      if (!attachedValue && COMMIT_SHORT_VALUE_LETTERS.has(letters[letters.length - 1])) {
        i += 1;
      }
      continue;
    }
    pathspecs.push(token);
  }
  return pathspecs;
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

  // Also check explicit positional pathspecs (e.g. `git commit src/index.ts -m ...` or `git commit -m ... -- src/index.ts`).
  const pathspecs = extractCommitPathspecs(args);
  for (const spec of pathspecs) {
    paths.add(spec);
  }
  if (pathspecs.length > 0) {
    const bySpec = spawnSync(realGit, [...globalFlags, "diff", "HEAD", "--name-only", "--", ...pathspecs], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    for (const line of (bySpec.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) {
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

/** Read the live binding without becoming a Ledger writer. Worktree matches beat root matches. */
function scopedContractAt(cwd) {
  const canonical = (path) => {
    try { return realpathSync(path); } catch { return resolve(path); }
  };
  const actual = canonical(cwd);
  const covers = (path) => typeof path === "string" && (actual === canonical(path) || actual.startsWith(`${canonical(path)}/`));
  const ledgers = [join(stateDir, "ledger.jsonl")];
  const projects = join(stateDir, "projects");
  if (existsSync(projects)) {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (entry.isDirectory()) ledgers.push(join(projects, entry.name, "ledger.jsonl"));
    }
  }
  let rootMatch;
  for (const path of ledgers) {
    const result = readLedgerEvents(path);
    if (!result.events) continue;
    const reset = result.events.findLastIndex((event) => event.event === "project_reset");
    const events = result.events.slice(reset + 1);
    const contracts = new Map();
    const histories = new Map();
    const accepted = new Set();
    for (const event of events) {
      if (!histories.has(event.task)) histories.set(event.task, []);
      histories.get(event.task).push(event);
      if (event.event === "contract_set") contracts.set(event.task, event);
      if (event.event === "attempt_accepted") {
        if (event.landing === "pending-conflict") accepted.delete(event.task);
        else accepted.add(event.task);
      }
    }
    for (const [task, contract] of contracts) {
      if (accepted.has(task)) continue;
      if (process.env.PASEO_FACTORY_TASK && task !== process.env.PASEO_FACTORY_TASK) continue;
      // Mirror Factory.worktreeFor: an epoch with a spawn never inherits an
      // older binding; an epoch without one inherits only a surviving directory.
      const history = histories.get(task);
      const epoch = history.filter((event) => event.seq >= contract.seq);
      let worktree = epoch.findLast((event) => event.event === "spawn_dispatched" && typeof event.worktree === "string" && event.worktree !== "")?.worktree;
      if (worktree === undefined && !epoch.some((event) => event.event === "spawn_dispatched")) {
        const previous = history.findLast((event) => event.event === "spawn_dispatched")?.worktree;
        if (typeof previous === "string" && previous !== "") {
          try { if (statSync(previous).isDirectory()) worktree = previous; } catch { /* removed historical worktree */ }
        }
      }
      if (covers(worktree)) return contract;
      if (covers(contract.workspace)) rootMatch = contract;
    }
  }
  return rootMatch;
}

function checkAgentCommitScope(realGit, argvTokens) {
  const { globalFlags, sub, args } = parseGitSubcommand(argvTokens);
  if (sub !== "commit" || realGit === undefined) return undefined;
  const contract = scopedContractAt(resolveEffectiveCwd(globalFlags));
  if (!contract?.base || !Array.isArray(contract.scope) || contract.scope.length === 0) return undefined;
  const query = (args) => {
    const result = spawnSync(realGit, [...globalFlags, ...args], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
    });
    if (result.status !== 0) throw new Error(result.stderr || "git could not inspect the proposed commit");
    return result.stdout.split("\0").filter(Boolean);
  };
  let paths;
  try {
    const pathspecs = extractCommitPathspecs(args);
    let all = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") break;
      if (arg === "--all") all = true;
      else if (COMMIT_LONG_VALUE_FLAGS.has(arg)) i++;
      else if (arg.startsWith("-") && !arg.startsWith("--")) {
        for (let at = 1; at < arg.length; at++) {
          const letter = arg[at];
          if (letter === "a") all = true;
          if (COMMIT_SHORT_VALUE_LETTERS.has(letter)) {
            if (at === arg.length - 1) i++;
            break;
          }
        }
      }
    }
    if (pathspecs.some((path) => path.startsWith("--pathspec-from-file"))) {
      throw new Error("--pathspec-from-file cannot be scope-checked; stage explicit files and commit without that option");
    }
    if (pathspecs.length > 0 && !args.includes("--include") && !args.includes("-i")) {
      // A path-limited commit takes selected paths from the working tree and
      // leaves every other path at HEAD, even when a repair is staged there.
      const selected = new Set(query(["ls-files", "-z", "--full-name", "--", ...pathspecs]));
      paths = [
        ...query(["diff", "--name-only", "-z", contract.base, "HEAD"]).filter((path) => !selected.has(path)),
        ...query(["diff", "--name-only", "-z", contract.base, "--", ...pathspecs]),
      ];
    } else {
      paths = query(["diff", ...(all ? [] : ["--cached"]), "--name-only", "-z", contract.base]);
      if (pathspecs.length > 0) paths.push(...query(["diff", "--name-only", "-z", contract.base, "--", ...pathspecs]));
    }
  } catch (error) {
    return { rule: "out-of-scope", reason: `could not check the commit against Contract base ${contract.base}: ${error.message}` };
  }
  const outside = [...new Set(paths)].filter((file) => !scopeCoversFile(contract.scope, file));
  if (outside.length === 0) return undefined;
  return {
    rule: "out-of-scope",
    reason: `changes outside declared scope: ${outside.join(", ")}. Restore relative to the Contract base (${contract.base}..HEAD): ${scopeRecoveryCommands(contract.base, outside)}; then stage the restored files and commit.`,
  };
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
if (refusal === undefined && seat === "agent") {
  refusal = checkAgentCommitScope(resolveRealGit(), argv);
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
  console.error(refusal.rule === "out-of-scope"
    ? "git: nothing was executed; restore out-of-scope files from the Contract base, stage them, and retry."
    : "git: nothing was executed; adapt the command (e.g. --force-with-lease) and retry.");
  process.exit(REFUSAL_EXIT);
}

// ---- the pass-through --------------------------------------------------------------------------

const realGit = resolveRealGit();
if (realGit === undefined) {
  console.error("git: paseo-factory shim found no real git on PATH or in the usual locations — nothing was executed");
  process.exit(127);
}

const child = spawn(realGit, argv, { stdio: "inherit" });
inheritChildOutcome(child, (err) => {
  console.error(`git: paseo-factory shim could not run ${realGit}: ${err.message}`);
});
