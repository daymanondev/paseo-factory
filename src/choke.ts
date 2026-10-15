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
import { isAbsolute, join } from "node:path";
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
function judgeS1(tokens: readonly string[]): ChokeDecision {
  const words = tokens.filter((t) => !WRAPPER_WORDS.has(t) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  for (let i = 0; i < words.length; i++) {
    if (!isGitWord(words[i])) continue;
    const refusal = refuseGitArgv(words.slice(i + 1));
    if (refusal) {
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
      if (dest !== undefined) destinations.push(dest);
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
 * The ask-time fence's context: the live Contract's workspace (whose root
 * holds the memory files), its declared scope — the only opt-in — and, since
 * v0.0.14, the task's managed worktree root: a worktree agent's absolute
 * writes name the worktree's copy of the memory file, and that copy lands in
 * `<project-root>` at accept — the fence covers both roots.
 */
export interface MemoryFence {
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
function judgeMemoryDestination(rawPath: string, fence: MemoryFence): ChokeDecision | undefined {
  const name = memoryFileOf(rawPath, fence);
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
  const tokens = shellTokens(command);
  const s1 = judgeS1(tokens);
  if (s1.behavior === "deny") return s1;
  const s2 = judgeS2(tokens, roots);
  if (s2.behavior === "deny") return s2;
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
  const expanded = expandUser(rawPath, roots);
  if (!withinWritable(expanded, roots)) {
    return {
      behavior: "deny",
      rule: "policy:file-write-outside-writable",
      reason: `write to ${expanded} is outside the writable set (workspace, /tmp, factory state dir)`,
    };
  }
  if (memory !== undefined) {
    const fenced = judgeMemoryDestination(rawPath, memory);
    if (fenced !== undefined) return fenced;
  }
  return { behavior: "allow" };
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
