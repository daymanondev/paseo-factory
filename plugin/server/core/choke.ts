/**
 * The choke policy (v0.0.4) — default-allow plus the two deny-lists ticket 01
 * fixed (`research/choke-vocab.md`, grounded in live git experiments and the
 * 51-command real-agent corpus, 0 predicted false positives).
 *
 * Two layers share this module:
 * - the ask-time net: `judgeShellCommand` / `judgeFilePath` judge a permit
 *   ask's `detail.command` / `detail.filePath` (S1: the git vocabulary on any
 *   `git` spelling in the string; S2: writes outside the writable set; plus
 *   the write/edit tool rider).
 * - the exec-time net: `refuseGitArgv` is the git shim's refusal list (a) —
 *   exact argv tokens, `-C`-proof. `plugin/bin/git-refusals.mjs` mirrors this
 *   function in plain JS for the daemon-exec'd shim; `test/git-shim.test.ts`
 *   runs both over one case table so the mirror cannot drift.
 *
 * Judging is mechanical: exact tokens, never substrings, so
 * `--force-with-lease`, `fetch -f`, `checkout -b` and `clean -n` stay clear.
 */
import { isMcpStdioLaunch } from "./mcp-launch-policy.ts";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { scopeCoversFile } from "./workspace.ts";

/** One refusal-list hit: which class fired and one line saying what it destroys. */
export interface GitRefusal {
  rule: string;
  reason: string;
}

/** The ask-time verdict: default-allow, deny names the rule. */
export type ChokeDecision = { behavior: "allow" } | { behavior: "deny"; rule: string; reason: string };

/** Where writes may land: workspace ∪ /tmp ∪ $TMPDIR ∪ state dir (ticket 01 S2). */
export interface WritableRoots {
  workspace: string;
  stateDir: string;
  tmp: string[];
  /** For `~` expansion — injected so tests never touch the real home. */
  homeDir: string;
}

export function writableRootsFor(workspace: string, stateDir: string, homeDir: string, env: NodeJS.ProcessEnv = process.env): WritableRoots {
  // `/dev/null` rides with /tmp: a sink, not a store — without it the idiomatic
  // `2>/dev/null` denies, and an unintended deny on benign work is a failed
  // measurement by the map's own live-run pass rule.
  const tmp = ["/tmp", "/dev/null"];
  const tmpdir = env.TMPDIR;
  if (typeof tmpdir === "string" && tmpdir.trim() !== "" && !tmp.includes(tmpdir)) tmp.push(tmpdir.replace(/\/+$/, ""));
  return { workspace: stripTrailingSlash(workspace), stateDir: stripTrailingSlash(stateDir), tmp: tmp.map(stripTrailingSlash), homeDir };
}

// ---- tokenizer -----------------------------------------------------------------------------

/**
 * Control/ glue trimmed from token ends — deliberately NOT `<` or `>`: those
 * belong to redirection tokens (`>dest`, `2>dest`), which S2 must see whole.
 */
const OPERATOR_CHARS = ";|&()$`";

/**
 * Splits a shell line into judgment tokens: whitespace-split, each token with
 * quote characters removed from both ends and operator glue trimmed. Quotes
 * are stripped INDEPENDENTLY per end: a quoted multiword string (`bash -c
 * 'git push --force'`) yields the pieces `'git` / `--force'`, and both must
 * become their inner words — "the tokens are in the string" (ticket 01, why
 * S1 catches wrapped invocations). Not a shell parser; a deny-list scanner.
 */
export function shellTokens(command: string): string[] {
  return command
    .split(/\s+/)
    .filter((t) => t !== "")
    .map(stripQuotes)
    .map((t) => trimOperators(t))
    .filter((t) => t !== "");
}

function stripQuotes(token: string): string {
  let start = 0;
  let end = token.length;
  if (start < end && (token[start] === "'" || token[start] === '"')) start += 1;
  if (end > start && (token[end - 1] === "'" || token[end - 1] === '"')) end -= 1;
  return token.slice(start, end);
}

function trimOperators(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && OPERATOR_CHARS.includes(token[start])) start += 1;
  while (end > start && OPERATOR_CHARS.includes(token[end - 1])) end -= 1;
  return token.slice(start, end);
}

/** Wrapper words stripped before the S1 scan (ticket 01: env/command/nohup/timeout). */
const WRAPPER_WORDS = new Set(["env", "command", "nohup", "timeout"]);

// ---- the git refusal list (a) ----------------------------------------------------------------

/** Global flags that consume the following token as their value (skip it: `-C`-proof). */
const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** True for a short-flag cluster like `-f`, `-fd`, `-fdx` (never long `--force…`). */
function shortCluster(token: string): boolean {
  return token.length >= 2 && token[0] === "-" && token[1] !== "-";
}

function clusterHas(token: string, letter: string): boolean {
  return shortCluster(token) && token.slice(1).includes(letter);
}

/**
 * The shim's refusal list over the argv tokens FOLLOWING the `git` word.
 * Returns the first refusal hit, or undefined for everything pass-through.
 * Ticket 01 §(a); every rule is exact-token so benign neighbors stay clear.
 */
export function refuseGitArgv(argv: readonly string[]): GitRefusal | undefined {
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

/**
 * Refuses git subcommands and branch-creation flags forbidden to the Supervisor
 * seat on `<project-root>` (v0.0.23, ADR 0015 §2; v0.0.26, ADR 0016 §3).
 */
export function refuseSupervisorGitArgv(argv: readonly string[]): GitRefusal | undefined {
  let i = 0;
  while (i < argv.length && argv[i] !== undefined && argv[i]!.startsWith("-")) {
    i += GIT_GLOBAL_VALUE_FLAGS.has(argv[i]!) ? 2 : 1;
  }
  const sub = argv[i];
  if (sub === undefined) return undefined;
  const args = argv.slice(i + 1);
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

function pushRefusal(what: string): GitRefusal {
  return { rule: "git:force-push", reason: `push that rewinds or deletes remote refs (${what}) — bare remotes keep no reflog` };
}

function cleanRefusal(what: string): GitRefusal {
  return { rule: "git:clean-force", reason: `clean deletes untracked files (${what}) — untracked files are never objects, unrecoverable` };
}

/**
 * Working-tree discard via checkout (ticket 01 rule 4): `--` pathspec with no
 * ref (or ref HEAD), a bare `.` pathspec with no ref before it, or `-f`.
 * `checkout -b`, `checkout <branch>`, `checkout <ref> .` and `checkout <ref>
 * -- <path>` (restore-from-ref, the recovery direction) stay clear.
 */
function refuseCheckout(args: readonly string[]): GitRefusal | undefined {
  const dd = args.indexOf("--");
  if (dd !== -1) {
    const before = args.slice(0, dd);
    if (before.length === 0 || (before.length === 1 && (before[0] === "HEAD"))) {
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

/**
 * Working-tree discard via restore (ticket 01 rule 4): a pathspec with no
 * `-s/--source`, unless staged-only (`--staged` without `--worktree` — that
 * touches only the index). `restore --staged` and `restore -s <ref>` stay clear.
 */
function refuseRestore(args: readonly string[]): GitRefusal | undefined {
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

// ---- S1: the git vocabulary on any spelling ----------------------------------------------------

function isGitWord(token: string): boolean {
  return token === "git" || token.endsWith("/git");
}

/**
 * S1 over a permit ask's shell line: wherever a token spells `git` (bare or
 * absolute), the refusal list applies to the tokens after it. Catches
 * absolute-path invocations and `bash -c`/`+refspec` disguises (map decision
 * 9 arm 4) — the tokens are in the string. The same quote-blindness means
 * quoted PROSE containing a dangerous git line denies as well: that cost is
 * inseparable from arm 4's requirement, and ticket 01's FP boundary is the
 * observed agent corpus (which this module's case table replays).
 */
function judgeS1(tokens: readonly string[], allowWorktreeDiscard = false): ChokeDecision {
  const words = tokens.filter((t) => !WRAPPER_WORDS.has(t) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  for (let i = 0; i < words.length; i++) {
    if (!isGitWord(words[i])) continue;
    const refusal = refuseGitArgv(words.slice(i + 1));
    if (refusal && !(allowWorktreeDiscard && (refusal.rule === "git:checkout-discard" || refusal.rule === "git:restore-discard"))) {
      return { behavior: "deny", rule: "policy:S1-git-vocabulary", reason: `dangerous git invocation (${refusal.rule}: ${refusal.reason})` };
    }
  }
  return { behavior: "allow" };
}

// ---- S2: writes outside the writable set -------------------------------------------------------

/** Write operators whose destination operand is checked (ticket 01 S2). */
const DEST_IS_LAST = new Set(["cp", "mv", "install", "rsync", "ln", "truncate"]);
const OPERAND_ALL = new Set(["rm"]);

function expandUser(rawPath: string, roots: WritableRoots): string {
  if (rawPath === "~") return roots.homeDir;
  if (rawPath.startsWith("~/")) return join(roots.homeDir, rawPath.slice(2));
  return rawPath;
}

function withinWritable(rawPath: string, roots: WritableRoots): boolean {
  const expanded = expandUser(rawPath, roots);
  if (!isAbsolute(expanded)) return true; // relative → resolves against the workspace cwd → allowed
  const bases = [roots.workspace, roots.stateDir, ...roots.tmp];
  return bases.some((base) => expanded === base || expanded.startsWith(`${base}/`));
}

/**
 * S2 over a permit ask's shell line: redirections (`>`, `>>`, `2>`, `&>`, with
 * the destination attached or following) and the write commands `tee cp mv rm
 * dd install rsync ln sed -i truncate`, each with its resolved destination.
 * Reads anywhere stay allowed; `/tmp` and the state dir are writable.
 */
function judgeS2(tokens: readonly string[], roots: WritableRoots): ChokeDecision {
  const deny = (dest: string): ChokeDecision => ({
    behavior: "deny",
    rule: "policy:S2-outside-writable",
    reason: `write to ${dest} is outside the writable set (workspace, /tmp, factory state dir)`,
  });

  for (const dest of shellWriteDestinations(tokens)) {
    if (!withinWritable(dest, roots)) return deny(dest);
  }
  return { behavior: "allow" };
}

/**
 * Every write destination a shell line names, in scan order — S2's own list,
 * extracted so the memory write fence (v0.0.14) scans the same destinations
 * under the same rules: redirections (`>x` `>>x` `2>x` `2>>x` `&>x` `&>>x`,
 * or the bare operator with a following token), `tee`'s first non-flag
 * operand, the DEST_IS_LAST commands' last operand, every `rm` operand,
 * `sed -i`'s last operand, and `dd`'s `of=` values.
 */
function shellWriteDestinations(tokens: readonly string[]): string[] {
  const destinations: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const redirect = token.match(/^(?:\d*|&)>>?(.*)$/);
    if (redirect) {
      const dest = redirect[1] !== "" ? redirect[1] : tokens[i + 1];
      if (dest !== undefined && !/^&(?:\d+|-)$/.test(dest) && dest !== "/dev/null") destinations.push(dest);
      continue;
    }
    if (token === "tee") {
      const dest = tokens.slice(i + 1).find((t) => !t.startsWith("-"));
      if (dest !== undefined) destinations.push(dest);
      continue;
    }
    if (DEST_IS_LAST.has(token)) {
      const operands = tokens.slice(i + 1).filter((t) => !t.startsWith("-"));
      const dest = operands.at(-1);
      if (dest !== undefined) destinations.push(dest);
      continue;
    }
    if (OPERAND_ALL.has(token)) {
      for (const dest of tokens.slice(i + 1).filter((t) => !t.startsWith("-"))) destinations.push(dest);
      continue;
    }
    if (token === "sed") {
      const interactive = tokens.slice(i + 1).some((t) => t === "-i" || t.startsWith("-i"));
      if (!interactive) continue;
      const dest = tokens.slice(i + 1).filter((t) => !t.startsWith("-")).at(-1);
      if (dest !== undefined) destinations.push(dest);
      continue;
    }
    if (token === "dd") {
      for (const t of tokens.slice(i + 1)) {
        if (t.startsWith("of=")) destinations.push(t.slice(3));
      }
    }
  }
  return destinations;
}

// ---- the memory write fence (v0.0.14, ADR 0010 §6) --------------------------------------------

/**
 * The workspace-root files a contracted working Agent never writes unless the
 * Contract explicitly scopes them — project memory is the Supervisor's and
 * Lead's act (or a ratified Retro proposal's), never a worker's side effect.
 */
export const MEMORY_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"] as const;

export type MemoryFileName = (typeof MEMORY_FILES)[number];

/**
 * The root-level files a Supervisor or Lead seat may edit on `<project-root>`
 * (v0.0.23, ADR 0015 §2), alongside `docs/**` and `.scratch/**`.
 */
export const SEAT_MEMORY_WHITELIST = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  "GLOSSARY.md",
  ".gitignore",
  ".worktreeinclude",
] as const;

export const SEAT_WRITE_FENCE_MESSAGE =
  "Seat write fence: Supervisor and Lead may only write project memory/docs (AGENTS.md, CONTEXT.md, docs/**, .scratch/**); dispatch implementation work to Lead / Task Agents";

/**
 * Whether a project-root-relative path (POSIX slashes, no `..`) sits inside
 * `SEAT_MEMORY_WHITELIST` (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`,
 * `GLOSSARY.md`, `.gitignore`, `.worktreeinclude`, `docs/**`, `.scratch/**`).
 */
export function isSeatMemoryRelativePathAllowed(relativePath: string): boolean {
  let normalized = relativePath.trim();
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = stripTrailingSlash(normalized);
  if (normalized === "" || normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  if ((SEAT_MEMORY_WHITELIST as readonly string[]).includes(normalized)) return true;
  if (normalized === "docs" || normalized.startsWith("docs/")) return true;
  if (normalized === ".scratch" || normalized.startsWith(".scratch/")) return true;
  return false;
}

function defaultSeatTmpDirs(): string[] {
  const dirs = ["/tmp", "/dev/null", tmpdir()];
  if (typeof process.env.TMPDIR === "string" && process.env.TMPDIR.trim() !== "") {
    dirs.push(process.env.TMPDIR);
  }
  return dirs.map(stripTrailingSlash);
}

export function isProtectedFactoryStatePath(
  resolvedCandidate: string,
  resolvedState: string,
  allowedWorktree?: string,
): boolean {
  if (resolvedState === "") return false;
  if (
    resolvedCandidate === `${resolvedState}/ledger.jsonl` ||
    resolvedCandidate === `${resolvedState}/correlations.json`
  ) {
    return true;
  }
  const projectsPrefix = `${resolvedState}/projects`;
  if (resolvedCandidate === projectsPrefix || resolvedCandidate.startsWith(`${resolvedState}/projects/`)) {
    if (resolvedCandidate.endsWith("/lead-handoff.md")) return false;
    if (allowedWorktree !== undefined && allowedWorktree.trim() !== "") {
      const resolvedWt = stripTrailingSlash(resolve(allowedWorktree));
      if (resolvedCandidate === resolvedWt || resolvedCandidate.startsWith(`${resolvedWt}/`)) {
        return false;
      }
    } else if (/\/projects\/[^/]+\/worktrees\/[^/]+(\/|$)/.test(resolvedCandidate)) {
      return false;
    }
    return true;
  }
  return false;
}

const FORBIDDEN_PASEO_TOOL_SET = new Set([
  "Task",
  "Agent",
  "send_message",
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "create_agent",
  "kill_agent",
  "archive_agent",
  "send_agent_prompt",
  "update_agent",
  "paseo_create_agent",
  "paseo_kill_agent",
  "paseo_archive_agent",
  "paseo_send_agent_prompt",
  "paseo_update_agent",
  "mcp__paseo__create_agent",
  "mcp__paseo__kill_agent",
  "mcp__paseo__archive_agent",
  "mcp__paseo__send_agent_prompt",
  "mcp__paseo__update_agent",
]);

export function isForbiddenPaseoToolName(toolName: string | undefined): boolean {
  if (typeof toolName !== "string") return false;
  const trimmed = toolName.trim();
  if (FORBIDDEN_PASEO_TOOL_SET.has(trimmed)) return true;
  if (trimmed.startsWith("mcp__paseo__") || trimmed.startsWith("paseo:")) return true;
  return false;
}

export function isPaseoFactoryToolName(toolName: string | undefined): boolean {
  if (typeof toolName !== "string") return false;
  const trimmed = toolName.trim();
  return (
    trimmed.startsWith("mcp__paseo_factory__") ||
    trimmed.startsWith("mcp__paseo-factory__") ||
    trimmed.startsWith("paseo_factory_") ||
    trimmed.startsWith("paseo_factory/") ||
    trimmed.startsWith("paseo-factory_") ||
    trimmed.startsWith("paseo-factory/") ||
    trimmed.startsWith("supervisor_") ||
    trimmed.startsWith("lead_") ||
    trimmed.startsWith("agent_") ||
    trimmed === "factory_status" ||
    trimmed === "factory_dispatch_supervisor"
  );
}

export function isProcessKillAgainstFactory(command: string): boolean {
  if (!/\b(?:pkill|killall|kill)\b/.test(command)) return false;
  return /\b(?:plugin-process|paseo)\b/i.test(command);
}

/**
 * Whether `candidatePath` is an allowed write target for a Supervisor or Lead
 * seat rooted at `projectRoot` (v0.0.23, ADR 0015 §2; v0.0.26, ADR 0016 §3):
 * - Allows `/dev/null`, non-protected `stateDir` paths, and `tmpDirs` (`/tmp`, `os.tmpdir()`, `$TMPDIR`).
 * - Denies protected factory state files (`<stateDir>/ledger.jsonl`, `<stateDir>/correlations.json`,
 *   `<stateDir>/projects/**` outside `<projectStateDir>/worktrees/<task>` and `<projectStateDir>/lead-handoff.md`).
 * - Inside `projectRoot`, allows ONLY `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`,
 *   `GLOSSARY.md`, `.gitignore`, `.worktreeinclude`, `docs/**`, and `.scratch/**`.
 * - Rejects all other paths inside or outside `projectRoot`.
 */
export function isSeatMemoryPathAllowed(
  projectRoot: string,
  candidatePath: string,
  stateDir: string,
  tmpDirs: readonly string[] = defaultSeatTmpDirs(),
): boolean {
  const raw = candidatePath.trim();
  if (raw === "") return false;
  if (raw === "/dev/null") return true;
  if (raw === "~" || raw.startsWith("~/")) return false;

  const resolvedRoot = stripTrailingSlash(resolve(projectRoot));
  const resolvedState = stateDir.trim() === "" ? "" : stripTrailingSlash(resolve(stateDir));
  const resolvedCandidate = stripTrailingSlash(isAbsolute(raw) ? resolve(raw) : resolve(resolvedRoot, raw));

  if (isProtectedFactoryStatePath(resolvedCandidate, resolvedState)) {
    return false;
  }

  if (resolvedState !== "" && (resolvedCandidate === resolvedState || resolvedCandidate.startsWith(`${resolvedState}/`))) {
    return true;
  }

  if (resolvedCandidate === resolvedRoot) return false;
  if (resolvedCandidate.startsWith(`${resolvedRoot}/`)) {
    const rel = resolvedCandidate.slice(resolvedRoot.length + 1);
    return isSeatMemoryRelativePathAllowed(rel);
  }

  for (const tmp of tmpDirs) {
    if (typeof tmp !== "string" || tmp.trim() === "") continue;
    const resolvedTmp = stripTrailingSlash(resolve(tmp));
    if (resolvedCandidate === resolvedTmp || resolvedCandidate.startsWith(`${resolvedTmp}/`)) {
      return true;
    }
  }
  return false;
}

const TOUCH_OR_MKDIR = new Set(["touch", "mkdir"]);

/**
 * Extracts all candidate write target paths from a shell command (redirections,
 * `tee`, `cp`, `mv`, `install`, `rsync`, `ln`, `truncate`, `rm`, `sed -i`,
 * `dd of=`, `touch`, and `mkdir`).
 */
export function extractWriteTargets(command: string): string[] {
  const tokens = shellTokens(command);
  const targets = [...shellWriteDestinations(tokens)];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token !== undefined && TOUCH_OR_MKDIR.has(token)) {
      for (const operand of tokens.slice(i + 1).filter((t) => !t.startsWith("-"))) {
        targets.push(operand);
      }
    }
  }
  return targets;
}

/**
 * Splits a shell command line on unquoted `;`, `|`, `||`, `&&`, and `\n` so
 * chained segments can be inspected independently.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") segments.push(current.trim());
  return segments;
}

/**
 * Tokenizes a single shell segment preserving quoted strings as single tokens
 * so `--message "npm install src/foo.ts"` is not mistaken for a subcommand.
 */
function quoteAwareWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current !== "") words.push(current);
  return words;
}

/**
 * A deliberately conservative delegation boundary: every command segment must
 * resolve a bare installed shim. Unknown commands, shell expansion, redirects,
 * environment overrides and shell wrappers retain ask-time enforcement.
 */
export function isStrictlyLayer3ShimmedCommand(command: string, installedTools: readonly string[]): boolean {
  if (/[\\$`<>(){}#]/.test(command) || /(?<!&)&(?!&)/.test(command)) return false;
  const shimTools = new Set(["git", "gh", "npm", "npx", "pnpm", "yarn", "bun"]);
  const installed = new Set(installedTools);
  const segments = splitShellSegments(command);
  return segments.length > 0 && segments.every((segment) => {
    const words = quoteAwareWords(segment);
    const tool = words[0];
    if (tool === "git" && words.slice(1).some((word) =>
      word === "-c" || word.startsWith("-c") || word.startsWith("--config-env") || word.startsWith("--exec-path"),
    )) return false;
    return tool !== undefined && shimTools.has(tool) && installed.has(tool);
  });
}

function isFactoryCliSegment(
  segment: string,
  projectRoot: string,
  stateDir: string,
  tmpDirs: readonly string[],
): boolean {
  const words = quoteAwareWords(segment);
  let idx = 0;
  while (idx < words.length) {
    const w = words[idx]!;
    if (w === "export" || WRAPPER_WORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      idx += 1;
      continue;
    }
    break;
  }
  if (idx >= words.length) return true; // pure env export segment (e.g. `export PATH="..."`)

  // Check if any top-level redirection targets a disallowed path
  for (let i = idx; i < words.length; i++) {
    const w = words[i]!;
    const redirect = w.match(/^(?:\d*|&)>>?(.*)$/);
    if (redirect) {
      const dest = redirect[1] !== "" ? redirect[1]! : words[i + 1];
      if (dest !== undefined && !/^&(?:\d+|-)$/.test(dest) && !isSeatMemoryPathAllowed(projectRoot, dest, stateDir, tmpDirs)) {
        return false;
      }
    }
  }

  const cmd = words[idx]!;
  if (cmd === "factory" || cmd.endsWith("/factory") || cmd.endsWith("/factory.mjs")) {
    return true;
  }
  const nextWord = words[idx + 1];
  if (
    nextWord !== undefined &&
    (nextWord === "factory.mjs" || nextWord.endsWith("/factory.mjs")) &&
    (cmd === "node" || cmd.endsWith("/node") || /Paseo Helper/i.test(cmd))
  ) {
    return true;
  }
  return false;
}

const NPM_MUTATION_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "uninstall", "remove", "rm", "init", "create"]);
const PNPM_MUTATION_SUBCOMMANDS = new Set(["add", "install", "i", "remove", "rm", "init", "create", "dlx"]);
const YARN_MUTATION_SUBCOMMANDS = new Set(["add", "install", "remove", "init", "create", "dlx"]);
const BUN_MUTATION_SUBCOMMANDS = new Set(["install", "i", "add", "remove", "rm", "init", "create", "x"]);

function isPackageMutationSegment(tokens: readonly string[]): boolean {
  const words = tokens.filter((t) => t !== "export" && !WRAPPER_WORDS.has(t) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  const cmd = words[0];
  if (cmd === undefined) return false;
  const bin = cmd.split("/").at(-1) ?? cmd;
  const sub = words.slice(1).find((t) => !t.startsWith("-"));
  if (bin === "npx") return !isMcpStdioLaunch(words.slice(1));
  if (bin === "npm") return sub !== undefined && NPM_MUTATION_SUBCOMMANDS.has(sub);
  if (bin === "pnpm") return sub !== undefined && PNPM_MUTATION_SUBCOMMANDS.has(sub);
  if (bin === "yarn") return sub === undefined || YARN_MUTATION_SUBCOMMANDS.has(sub);
  if (bin === "bun") return sub !== undefined && BUN_MUTATION_SUBCOMMANDS.has(sub);
  return false;
}

/**
 * Judges a shell ask from a Supervisor or Lead seat on `<project-root>`
 * (v0.0.23, ADR 0015 §2):
 * - Dangerous git commands on any spelling are denied (`rule: "dangerous-git"`).
 * - Package-mutation commands (`npm install`, `pnpm add`, `yarn add`, `bun install`, `npx`)
 *   are denied (`rule: "seat-write-fence"`).
 * - Write targets outside `isSeatMemoryPathAllowed` are denied (`rule: "seat-write-fence"`).
 * - Read-only commands, `factory` CLI invocations, and whitelisted memory/docs writes are allowed.
 */
export function judgeSeatShellCommand(
  command: string,
  projectRoot: string,
  stateDir: string,
  tmpDirs: readonly string[] = defaultSeatTmpDirs(),
): ChokeDecision {
  for (const segment of splitShellSegments(command)) {
    if (isProcessKillAgainstFactory(segment)) {
      return { behavior: "deny", rule: "seat-write-fence", reason: SEAT_WRITE_FENCE_MESSAGE };
    }
    if (isFactoryCliSegment(segment, projectRoot, stateDir, tmpDirs)) continue;
    const segTokens = shellTokens(segment);
    const s1 = judgeS1(segTokens);
    if (s1.behavior === "deny") {
      return { behavior: "deny", rule: "dangerous-git", reason: s1.reason };
    }
    if (isPackageMutationSegment(segTokens)) {
      return { behavior: "deny", rule: "seat-write-fence", reason: SEAT_WRITE_FENCE_MESSAGE };
    }
    for (const target of extractWriteTargets(segment)) {
      if (!isSeatMemoryPathAllowed(projectRoot, target, stateDir, tmpDirs)) {
        return { behavior: "deny", rule: "seat-write-fence", reason: SEAT_WRITE_FENCE_MESSAGE };
      }
    }
  }
  return { behavior: "allow" };
}

/**
 * Judges a Write/Edit file ask from a Supervisor or Lead seat on `<project-root>`
 * (v0.0.23, ADR 0015 §2).
 */
export function judgeSeatFilePath(
  filePath: string,
  projectRoot: string,
  stateDir: string,
  tmpDirs: readonly string[] = defaultSeatTmpDirs(),
): ChokeDecision {
  if (!isSeatMemoryPathAllowed(projectRoot, filePath, stateDir, tmpDirs)) {
    return { behavior: "deny", rule: "seat-write-fence", reason: SEAT_WRITE_FENCE_MESSAGE };
  }
  return { behavior: "allow" };
}

/**
 * The ask-time fence's context: the live Contract's workspace (whose root
 * holds the memory files), its declared scope — the only opt-in — and, since
 * v0.0.14, the task's managed worktree root: a worktree agent's absolute
 * writes name the worktree's copy of the memory file, and that copy lands in
 * `<project-root>` at accept — the fence covers both roots.
 */
export interface MemoryFence {
  /** Scrum planning/QA deliver only owned artifacts. SLP callers omit it. */
  artifactOnly?: boolean;
  scrumRole?: "pm" | "ux" | "architect" | "dev" | "qa";
  workspace: string;
  scope?: readonly string[];
  /** The task's managed Task worktree (v0.0.14), when its spawn recorded one. */
  worktree?: string;
}

/**
 * The memory file `rawPath` targets, when it is a ROOT one (the workspace's
 * or the worktree's): relative paths match the bare name (`./` stripped — a
 * relative ask resolves against the agent's cwd, which holds a copy of the
 * memory file on both paths), absolute paths match `<root>/<name>` for
 * either root. A nested file (`src/AGENTS.md`) is not the project memory;
 * `~`-relative paths are the home's, not the workspace's. Deliberately not a
 * shell parser: `sub/../AGENTS.md` is not chased (S2's quote-blindness
 * doctrine — the corpus, not the grammar, is the boundary).
 */
function memoryFileOf(rawPath: string, fence: MemoryFence): MemoryFileName | undefined {
  const roots = [stripTrailingSlash(fence.workspace)];
  if (fence.worktree !== undefined) roots.push(stripTrailingSlash(fence.worktree));
  for (const name of MEMORY_FILES) {
    if (isAbsolute(rawPath)) {
      if (roots.some((root) => rawPath === join(root, name))) return name;
    } else {
      let relative = rawPath;
      while (relative.startsWith("./")) relative = relative.slice(2);
      if (relative === name) return name;
    }
  }
  return undefined;
}

/**
 * The fence's verdict on one write destination: deny naming the file, unless
 * a declared scope prefix covers it (the Contract's explicit opt-in —
 * documentation maintenance is legal work when contracted for). Undefined
 * when the destination is not a fenced file.
 */
function normalizeMaybeStrippedLeadingSlash(rawPath: string, candidateRoots: readonly (string | undefined)[]): string {
  if (isAbsolute(rawPath) || rawPath.startsWith("~")) return rawPath;
  const withSlash = `/${rawPath}`;
  for (const root of candidateRoots) {
    if (!root) continue;
    const cleanRoot = stripTrailingSlash(root);
    if (withSlash === cleanRoot || withSlash.startsWith(`${cleanRoot}/`)) {
      return withSlash;
    }
  }
  return rawPath;
}

function judgeMemoryDestination(rawPath: string, fence: MemoryFence): ChokeDecision | undefined {
  const normalizedPath = normalizeMaybeStrippedLeadingSlash(rawPath, [fence.worktree, fence.workspace]);
  if (fence.artifactOnly) {
    const root = fence.worktree ?? fence.workspace;
    const destination = resolve(root, normalizedPath);
    const relative = destination.startsWith(root + "/") ? destination.slice(root.length + 1) : undefined;
    if (relative !== undefined && !scopeCoversFile(fence.scope ?? [], relative)) return { behavior: "deny", rule: "policy:scrum-artifact-only", reason: "planning/QA product source is read-only; write only the owned Contract artifacts" };
  }
  const name = memoryFileOf(normalizedPath, fence);
  if (name === undefined) return undefined;
  if (fence.scope !== undefined && fence.scope.length > 0 && scopeCoversFile(fence.scope, name)) return undefined;
  return {
    behavior: "deny",
    rule: "policy:memory-write-fenced",
    reason: `write to ${name} is fenced — project memory (AGENTS.md/CLAUDE.md/CONTEXT.md) is the Supervisor's and Lead's act; list the file in the Contract's scope to contract the edit`,
  };
}

// ---- the ask-time entry points ------------------------------------------------------------------

/**
 * Judges a shell ask's exact command line: S1 first (the git vocabulary), then
 * S2 (the writable set), then — when the ask comes from a contracted agent —
 * the memory write fence over the same write destinations (v0.0.14).
 */
export function judgeShellCommand(command: string, roots: WritableRoots, memory?: MemoryFence): ChokeDecision {
  if (isProcessKillAgainstFactory(command)) {
    return {
      behavior: "deny",
      rule: "seat-write-fence",
      reason: SEAT_WRITE_FENCE_MESSAGE,
    };
  }
  const tokens = shellTokens(command);
  if (memory?.scrumRole && !['ux', 'dev', 'qa'].includes(memory.scrumRole) && quoteAwareWords(command).some(word => /(?:^|\/)impeccable$/.test(word)))
    return { behavior: 'deny', rule: 'policy:scrum-ui-capability', reason: 'impeccable is scoped to UX, Dev and QA' };
  const inIsolatedWorktree =
    (memory?.worktree !== undefined && memory.worktree.trim() !== "") ||
    /\/projects\/[^/]+\/worktrees\/[^/]+(?:\/|$)/.test(roots.workspace);
  const s1 = judgeS1(tokens, inIsolatedWorktree);
  if (s1.behavior === "deny") return s1;
  const s2 = judgeS2(tokens, roots);
  if (s2.behavior === "deny") return s2;
  if (roots.stateDir !== "") {
    for (const dest of extractWriteTargets(command)) {
      const expanded = expandUser(dest, roots);
      const resolvedDest = isAbsolute(expanded) ? resolve(expanded) : resolve(roots.workspace, expanded);
      if (isProtectedFactoryStatePath(resolvedDest, roots.stateDir)) {
        return {
          behavior: "deny",
          rule: "seat-write-fence",
          reason: SEAT_WRITE_FENCE_MESSAGE,
        };
      }
    }
  }
  if (memory !== undefined) {
    for (const dest of shellWriteDestinations(tokens)) {
      const fenced = judgeMemoryDestination(dest, memory);
      if (fenced !== undefined) return fenced;
    }
  }
  return { behavior: "allow" };
}

/**
 * The write/edit tool rider (ticket 01's non-shell twin of S2): a write or
 * edit ask whose destination sits outside the writable set denies, and — for
 * a contracted agent — a destination that is a workspace-root memory file
 * denies unless the Contract scopes it (v0.0.14, ADR 0010 §6). Reads
 * anywhere are legitimate agent behavior and never judge.
 */
export function judgeFilePath(rawPath: string, roots: WritableRoots, memory?: MemoryFence): ChokeDecision {
  const normalizedRaw = normalizeMaybeStrippedLeadingSlash(rawPath, [roots.workspace, roots.stateDir, memory?.worktree, memory?.workspace]);
  const expanded = expandUser(normalizedRaw, roots);
  const resolvedDest = isAbsolute(expanded) ? resolve(expanded) : resolve(roots.workspace, expanded);
  if (roots.stateDir !== "" && isProtectedFactoryStatePath(resolvedDest, roots.stateDir)) {
    return {
      behavior: "deny",
      rule: "seat-write-fence",
      reason: SEAT_WRITE_FENCE_MESSAGE,
    };
  }
  if (!withinWritable(expanded, roots)) {
    return {
      behavior: "deny",
      rule: "policy:file-write-outside-writable",
      reason: `write to ${expanded} is outside the writable set (workspace, /tmp, factory state dir)`,
    };
  }
  if (memory !== undefined) {
    const fenced = judgeMemoryDestination(normalizedRaw, memory);
    if (fenced !== undefined) return fenced;
  }
  return { behavior: "allow" };
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
