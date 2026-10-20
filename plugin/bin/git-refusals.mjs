/**
 * The git refusal list (ticket 01 §a) in plain JS — the shim's own copy.
 *
 * `src/choke.ts` holds the TypeScript original; this mirror exists because
 * the shim runs under the daemon's node binary, which may lack TypeScript
 * stripping, so `plugin/bin/` stays plain .mjs (the CLIs' law, ADR 0004).
 * `test/git-shim.test.ts` runs both implementations over ONE shared case
 * table, so the mirror cannot drift from the original — the same guard that
 * keeps `factory.mjs`'s event vocabulary honest.
 *
 * Judging is exact-token, never substring: `--force-with-lease`, `fetch -f`,
 * `checkout -b`, `clean -n` must all stay clear. `-C`-proof: global flags and
 * their values are skipped before the subcommand.
 */

/** Global flags that consume the following token as their value. */
const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

function shortCluster(token) {
  return token.length >= 2 && token[0] === "-" && token[1] !== "-";
}

function clusterHas(token, letter) {
  return shortCluster(token) && token.slice(1).includes(letter);
}

function pushRefusal(what) {
  return { rule: "git:force-push", reason: `push that rewinds or deletes remote refs (${what}) — bare remotes keep no reflog` };
}

function cleanRefusal(what) {
  return { rule: "git:clean-force", reason: `clean deletes untracked files (${what}) — untracked files are never objects, unrecoverable` };
}

function refuseCheckout(args) {
  const dd = args.indexOf("--");
  if (dd !== -1) {
    const before = args.slice(0, dd);
    if (before.length === 0 || (before.length === 1 && before[0] === "HEAD")) {
      return { rule: "git:checkout-discard", reason: "checkout -- <path> discards working-tree changes at HEAD" };
    }
  }
  const dot = args.indexOf(".");
  if (dot !== -1 && args.slice(0, dot).every((t) => t.startsWith("-"))) {
    return { rule: "git:checkout-discard", reason: "checkout with the `.` pathspec discards working-tree changes" };
  }
  for (const token of args) {
    if (token === "-f" || clusterHas(token, "f")) {
      return { rule: "git:checkout-discard", reason: "checkout -f discards working-tree changes" };
    }
  }
  return undefined;
}

function refuseRestore(args) {
  let hasSource = false;
  let staged = false;
  let worktree = false;
  let pathspec = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "-s" || token.startsWith("--source")) {
      hasSource = true;
      if (token === "-s" || token === "--source") i += 1; // its value is a ref, not a pathspec
      continue;
    }
    if (clusterHas(token, "s")) {
      hasSource = true;
      continue;
    }
    if (token === "--staged" || token === "-S" || clusterHas(token, "S")) staged = true;
    if (token === "--worktree" || token === "-W" || clusterHas(token, "W")) worktree = true;
    if (!token.startsWith("-")) pathspec = true;
  }
  if (pathspec && !hasSource && (!staged || worktree)) {
    return { rule: "git:restore-discard", reason: "restore of a pathspec with no source discards working-tree changes" };
  }
  return undefined;
}

/**
 * Refuses ticket 01's six destruction classes over the argv tokens FOLLOWING
 * the `git` word; everything else is undefined (pass through to real git).
 */
export function refuseGitArgv(argv) {
  let i = 0;
  while (i < argv.length && argv[i] !== undefined && argv[i].startsWith("-")) {
    i += GIT_GLOBAL_VALUE_FLAGS.has(argv[i]) ? 2 : 1;
  }
  const sub = argv[i];
  if (sub === undefined) return undefined;
  const args = argv.slice(i + 1);

  switch (sub) {
    case "push":
      for (const token of args) {
        if (token === "--force" || token === "--force-only" || token === "--delete" || token === "-d" || token === "-f") {
          return pushRefusal("a force or delete push flag");
        }
        if (shortCluster(token) && (token.slice(1).includes("f") || token.slice(1).includes("d"))) {
          return pushRefusal(`the short cluster \`${token}\` carries force/delete`);
        }
        if (token.startsWith("+")) return pushRefusal(`the refspec \`${token}\` forces (leading +)`);
        if (token.startsWith(":")) return pushRefusal(`the refspec \`${token}\` deletes (empty source)`);
      }
      return undefined;
    case "reset":
      if (args.includes("--hard")) {
        return { rule: "git:reset-hard", reason: "reset --hard discards the uncommitted tree and index — never in the reflog" };
      }
      return undefined;
    case "clean":
      for (const token of args) {
        if (token === "--force") return cleanRefusal("`--force`");
        if (clusterHas(token, "f") && !clusterHas(token, "n")) {
          return cleanRefusal(`the short cluster \`${token}\` deletes (has f, no n)`);
        }
      }
      return undefined;
    case "checkout":
      return refuseCheckout(args);
    case "restore":
      return refuseRestore(args);
    case "switch":
      for (const token of args) {
        if (token === "-f" || clusterHas(token, "f")) {
          return { rule: "git:switch-force", reason: "switch -f discards working-tree changes" };
        }
      }
      return undefined;
    case "branch":
      if (args.includes("-D")) {
        return { rule: "git:branch-D", reason: "branch -D deletes an unmerged branch ref and its reflog" };
      }
      return undefined;
    case "reflog":
      if (args[0] === "expire" && (args.includes("--expire=now") || args.includes("--expire-unreachable=now"))) {
        return { rule: "git:reflog-expire-now", reason: "reflog expire --expire=now destroys the recovery mechanism itself" };
      }
      return undefined;
    case "gc":
      if (args.includes("--prune=now") || args.includes("--prune=all")) {
        return { rule: "git:gc-prune-now", reason: "gc --prune=now destroys unreachable objects immediately" };
      }
      return undefined;
    case "prune":
      if (args.includes("--expire=now")) {
        return { rule: "git:prune-expire-now", reason: "prune --expire=now destroys unreachable objects immediately" };
      }
      return undefined;
    default:
      return undefined;
  }
}

const SUPERVISOR_BLOCKED_GIT_SUBCOMMANDS = new Set(["commit", "merge", "cherry-pick", "rebase", "am", "apply", "stash", "reset", "clean"]);
const SUPERVISOR_GIT_FENCE_REASON =
  "factory git-shim: blocked (supervisor-git-fence) — Supervisor never commits or branches on <project-root>; dispatch to Lead via factory lead dispatch";

export const SEAT_MEMORY_WHITELIST = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  "GLOSSARY.md",
  ".gitignore",
  ".worktreeinclude",
];

/**
 * Parses leading global flags (`-C <dir>`, `-c <k=v>`, etc.), the git subcommand,
 * and the subcommand's remaining arguments.
 */
export function parseGitSubcommand(argv) {
  let i = 0;
  const globalFlags = [];
  while (i < argv.length && argv[i] !== undefined && argv[i].startsWith("-")) {
    if (GIT_GLOBAL_VALUE_FLAGS.has(argv[i])) {
      globalFlags.push(argv[i]);
      if (argv[i + 1] !== undefined) globalFlags.push(argv[i + 1]);
      i += 2;
    } else {
      globalFlags.push(argv[i]);
      i += 1;
    }
  }
  const sub = argv[i];
  const args = sub === undefined ? [] : argv.slice(i + 1);
  return { globalFlags, sub, args };
}

/**
 * Refuses git subcommands and branch-creation flags forbidden to the Supervisor
 * seat on `<project-root>` (v0.0.23, ADR 0015 §2; v0.0.26, ADR 0016 §3).
 */
export function refuseSupervisorGitArgv(argv) {
  const { sub, args } = parseGitSubcommand(argv);
  if (sub === undefined) return undefined;
  if (SUPERVISOR_BLOCKED_GIT_SUBCOMMANDS.has(sub)) {
    return { rule: "supervisor-git-fence", reason: SUPERVISOR_GIT_FENCE_REASON };
  }
  const dd = args.indexOf("--");
  const flagSlice = dd === -1 ? args : args.slice(0, dd);
  if (sub === "checkout") {
    if (dd !== -1) {
      return { rule: "supervisor-git-fence", reason: SUPERVISOR_GIT_FENCE_REASON };
    }
    for (const token of flagSlice) {
      if (token === "-b" || token === "-B" || clusterHas(token, "b") || clusterHas(token, "B")) {
        return { rule: "supervisor-git-fence", reason: SUPERVISOR_GIT_FENCE_REASON };
      }
    }
  }
  if (sub === "switch") {
    for (const token of flagSlice) {
      if (
        token === "-c" ||
        token === "-C" ||
        token === "--create" ||
        token === "--force-create" ||
        clusterHas(token, "c") ||
        clusterHas(token, "C")
      ) {
        return { rule: "supervisor-git-fence", reason: SUPERVISOR_GIT_FENCE_REASON };
      }
    }
  }
  return undefined;
}

/**
 * Whether a repo-relative path is within `SEAT_MEMORY_WHITELIST` (`AGENTS.md`,
 * `CLAUDE.md`, `CONTEXT.md`, `GLOSSARY.md`, `.gitignore`, `.worktreeinclude`,
 * `docs/**`, `.scratch/**`).
 */
export function isSeatMemoryRelativePathAllowed(relativePath) {
  if (typeof relativePath !== "string") return false;
  let normalized = relativePath.trim();
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized === "" || normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  if (SEAT_MEMORY_WHITELIST.includes(normalized)) return true;
  if (normalized === "docs" || normalized.startsWith("docs/")) return true;
  if (normalized === ".scratch" || normalized.startsWith(".scratch/")) return true;
  return false;
}
