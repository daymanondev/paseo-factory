import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { handleSpoolRequest } from "../plugin/server/spool.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { createFactory } from "../plugin/server/core/factory.ts";
import { writeProjectRegistration, resolveProject } from "../plugin/server/core/project.ts";
import { factoryRegistryFor } from "../plugin/server/projects.ts";
import {
  createChoke,
  startGitBlockIngestion,
  inferSeatFromProviderId,
  isContractedAgentCwd,
  normalizeAgentCreateRequest,
  resolveSeatAtProjectRoot,
} from "../plugin/server/choke.ts";
import { ensureGitShim, injectClaimCliPath } from "../plugin/server/shell.ts";
import type { PaseoResponderApi } from "../plugin/server/choke.ts";
import {
  PROCESS_KILL_FENCE_MESSAGE,
  isProcessKillAgainstFactory,
  isSeatMemoryPathAllowed,
  judgeFilePath,
  judgeSeatFilePath,
  judgeSeatShellCommand,
  judgeShellCommand,
  refuseGitArgv,
  shellTokens,
  writableRootsFor,
} from "../src/choke.ts";
import { saveLanes } from "../src/lanes.ts";
import { GIT_ARGV_CASES, SHELL_CASES, shellRoots } from "./choke-cases.ts";
import { disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

/**
 * The choke policy against ticket 01's exact-token contract: the shared case
 * tables (GIT_ARGV_CASES, SHELL_CASES) plus the tokenizer and the write/edit
 * rider. The git table is ALSO run against the plain-JS shim mirror in
 * test/git-shim.test.ts — one table, two implementations, no drift.
 */

test("refuseGitArgv matches every case in the shared table (refused forms and benign neighbors)", () => {
  for (const { argv, rule, note } of GIT_ARGV_CASES) {
    const refusal = refuseGitArgv(argv);
    if (rule === null) {
      assert.equal(refusal, undefined, `"git ${argv.join(" ")}" must pass through${note === undefined ? "" : ` (${note})`}`);
    } else {
      assert.ok(refusal !== undefined, `"git ${argv.join(" ")}" must be refused${note === undefined ? "" : ` (${note})`}`);
      assert.equal(refusal.rule, rule, `"git ${argv.join(" ")}" refusal rule`);
      assert.ok(refusal.reason.length > 10, "each refusal carries a one-line reason saying what it destroys");
    }
  }
});

test("judgeShellCommand matches every case in the shared table (S1, S2, and the benign corpus)", () => {
  const roots = shellRoots();
  for (const { command, rule, note } of SHELL_CASES) {
    const decision = judgeShellCommand(command, roots);
    if (rule === null) {
      assert.equal(decision.behavior, "allow", `"${command}" must be allowed${note === undefined ? "" : ` (${note})`}`);
    } else {
      assert.ok(decision.behavior === "deny", `"${command}" must be denied${note === undefined ? "" : ` (${note})`}`);
      assert.equal(decision.rule, rule, `"${command}" deny rule`);
    }
  }
});

test("S1 names the underlying git rule inside its reason — the deny line teaches, not just blocks", () => {
  const decision = judgeShellCommand("/usr/bin/git push --force origin main", shellRoots());
  assert.equal(decision.behavior, "deny");
  assert.match(decision.reason, /git:force-push/);
});

test("the tokenizer exposes quoted and glued words as plain tokens", () => {
  assert.deepEqual(shellTokens("bash -c 'git push --force'"), ["bash", "-c", "git", "push", "--force"]);
  assert.deepEqual(shellTokens("echo \"done\" >>out.txt"), ["echo", "done", ">>out.txt"]);
  assert.deepEqual(shellTokens("$(git reset --hard); make"), ["git", "reset", "--hard", "make"]);
  assert.deepEqual(shellTokens("it's fine"), ["it's", "fine"], "an apostrophe inside a word is not quoting");
});

test("relative destinations resolve against the workspace and stay allowed; ~ expands to the injected home", () => {
  const roots = shellRoots();
  assert.equal(judgeShellCommand("echo x > report.txt", roots).behavior, "allow");
  assert.equal(judgeShellCommand("echo x > ~/notes.txt", roots).behavior, "deny");
  assert.equal(judgeShellCommand("echo x > /home/notes.txt", roots).behavior, "deny", "~ and its expansion judge the same");
});

test("the write/edit rider denies file asks outside the writable set and allows everything inside it", () => {
  const roots = shellRoots();
  assert.equal(judgeFilePath("/ws/proj/src/x.ts", roots).behavior, "allow");
  assert.equal(judgeFilePath("src/x.ts", roots).behavior, "allow");
  assert.equal(judgeFilePath("/tmp/dump.txt", roots).behavior, "allow");
  assert.equal(judgeFilePath("/state/anything", roots).behavior, "allow");
  assert.equal(judgeFilePath("~/.ssh/authorized_keys", roots).behavior, "deny");
  assert.equal(judgeFilePath("/home/.bashrc", roots).behavior, "deny");
  assert.equal(judgeFilePath("/etc/hosts", roots).behavior, "deny");
  const deny = judgeFilePath("~/.paseo/config.json", roots);
  assert.equal(deny.behavior, "deny");
  assert.equal(deny.rule, "policy:file-write-outside-writable");
});

test("writableRootsFor carries TMPDIR when the plugin process has one", () => {
  const roots = writableRootsFor("/ws", "/state", "/home", { TMPDIR: "/var/folders/zz/T/" });
  assert.deepEqual(roots.tmp, ["/tmp", "/dev/null", "/var/folders/zz/T"], "trailing slash normalized");
  assert.deepEqual(writableRootsFor("/ws/", "/state", "/home", {}).workspace, "/ws", "workspace trailing slash normalized");
});

// ---- the memory write fence (v0.0.14, ADR 0010 §6) -------------------------------------------

/** The fence context a contracted ask carries: the live Contract's workspace and scope. */
function fence(scope?: string[]): { workspace: string; scope?: readonly string[] } {
  return { workspace: "/ws/proj", ...(scope === undefined ? {} : { scope }) };
}

test("the memory write fence: write/edit asks to AGENTS.md, CLAUDE.md, CONTEXT.md deny unless the Contract scopes the file", () => {
  const roots = shellRoots();
  for (const file of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]) {
    const relative = judgeFilePath(file, roots, fence());
    assert.equal(relative.behavior, "deny", `${file} — a relative ask from the workspace cwd`);
    if (relative.behavior === "deny") assert.equal(relative.rule, "policy:memory-write-fenced");
    assert.equal(judgeFilePath(`./${file}`, roots, fence()).behavior, "deny", "./ prefix is still the root file");
    assert.equal(judgeFilePath(`/ws/proj/${file}`, roots, fence()).behavior, "deny", "the absolute path inside the workspace");
    assert.equal(judgeFilePath(file, roots, fence([file])).behavior, "allow", "an explicit Contract.scope entry is the opt-in");
    assert.equal(judgeFilePath(file, roots, fence(["docs"])).behavior, "deny", "a scope that does not cover the file is no opt-in");
  }
  // Not the workspace-root memory: subdirectory files and neighbors stay clear.
  assert.equal(judgeFilePath("src/AGENTS.md", roots, fence()).behavior, "allow", "a nested AGENTS.md is not the project memory");
  assert.equal(judgeFilePath("docs/CONTEXT.md", roots, fence()).behavior, "allow");
  assert.equal(judgeFilePath("AGENTS.md.bak", roots, fence()).behavior, "allow");
  assert.equal(judgeFilePath("src/x.ts", roots, fence()).behavior, "allow");
  // Without the memory context (an uncontracted caller) the v0.0.4 behavior stands.
  assert.equal(judgeFilePath("AGENTS.md", roots).behavior, "allow");
});

test("the memory write fence catches shell writes to the memory files — redirects, tee, cp/mv, sed -i, rm, dd — and passes reads", () => {
  const roots = shellRoots();
  const writes = [
    "echo new rule > AGENTS.md",
    "echo more >> CLAUDE.md",
    "make 2> CONTEXT.md",
    "tee AGENTS.md < draft.md",
    "cp draft.md CLAUDE.md",
    "mv draft.md CONTEXT.md",
    "sed -i s/old/new/ AGENTS.md",
    "rm CLAUDE.md",
    "dd if=backup.img of=CONTEXT.md",
  ];
  for (const command of writes) {
    const decision = judgeShellCommand(command, roots, fence());
    assert.equal(decision.behavior, "deny", `"${command}" must be denied`);
    if (decision.behavior === "deny") {
      assert.equal(decision.rule, "policy:memory-write-fenced");
      assert.match(decision.reason, /AGENTS|CLAUDE|CONTEXT/, "the deny line names the fenced file");
    }
  }
  const readsAndNeighbors = [
    "cat AGENTS.md",
    "grep -i rule CLAUDE.md",
    "echo x > NOTES.md",
    "echo x > src/AGENTS.md",
    "cp a.md src/b.md",
    "diff AGENTS.md CLAUDE.md > /tmp/d",
  ];
  for (const command of readsAndNeighbors) {
    assert.equal(judgeShellCommand(command, roots, fence()).behavior, "allow", `"${command}" must pass the fence`);
  }
  assert.equal(judgeShellCommand("echo x > AGENTS.md", roots, fence(["AGENTS.md"])).behavior, "allow", "the explicit scope opt-in holds on the shell path too");
  assert.equal(judgeShellCommand("echo x > AGENTS.md", roots).behavior, "allow", "without the memory context the v0.0.4 behavior stands");
});

// ---- the read-only disposition fence (ADR 0053 §3, ticket 05) ----------------------------------

/** The task worktree a read-only Peer executes in (under the state dir). */
const RO_WORKTREE = "/state/factory/projects/proj/worktrees/T-05";

/** A Peer's fence: the live Contract's disposition over its Task worktree. */
function readOnlyFence(disposition: "engineer" | "scout" | "architect" | "reviewer") {
  return { workspace: "/ws/proj", worktree: RO_WORKTREE, disposition };
}

/** The same roots the plugin choke judges a worktree Peer with: the worktree is the writable workspace. */
function worktreeRoots() {
  return writableRootsFor(RO_WORKTREE, "/state/factory", "/home", {});
}

test("the read-only disposition fence: scout/architect/reviewer write/edit asks under the Task worktree deny with read-only-disposition-fence; engineer and omitted dispositions stay allowed", () => {
  const roots = worktreeRoots();
  for (const disposition of ["scout", "architect", "reviewer"] as const) {
    for (const target of ["src/x.ts", "./src/x.ts", `${RO_WORKTREE}/src/x.ts`, "AGENTS.md", "docs/findings.md"]) {
      const decision = judgeFilePath(target, roots, readOnlyFence(disposition));
      assert.equal(decision.behavior, "deny", `${disposition} — write/edit ask "${target}" must deny`);
      if (decision.behavior === "deny") {
        assert.equal(decision.rule, "read-only-disposition-fence", `${disposition} — "${target}" deny rule`);
        assert.match(decision.reason, new RegExp(disposition), "the deny line names the disposition law");
      }
    }
    // A Contract scope never reopens the fence: the read-only three stay read-only.
    const scoped = { ...readOnlyFence(disposition), scope: ["docs/**"] };
    assert.equal(judgeFilePath("docs/findings.md", roots, scoped).behavior, "deny", `${disposition} — a scoped path is still fenced`);
  }
  // The writers are untouched: engineer and an omitted disposition deny nothing here.
  for (const fence of [{ ...readOnlyFence("engineer") }, { workspace: "/ws/proj", worktree: RO_WORKTREE }]) {
    assert.equal(judgeFilePath("src/x.ts", roots, fence).behavior, "allow", "engineer (and omitted) write asks stay allowed");
    assert.equal(judgeFilePath("AGENTS.md", roots, fence).behavior, "deny", "the v0.0.14 memory fence still stands for writers");
  }
});

test("the read-only disposition fence catches file-mutating shell commands targeting the Task worktree — and passes every read", () => {
  const roots = worktreeRoots();
  for (const disposition of ["scout", "architect", "reviewer"] as const) {
    const memory = readOnlyFence(disposition);
    for (const command of [
      "echo findings > src/notes.txt",
      "printf x >> README.md",
      "tee src/notes.txt < /tmp/draft",
      "cp /tmp/draft.md docs/report.md",
      "mv /tmp/draft.md docs/report.md",
      "sed -i s/old/new/ src/x.ts",
      "rm src/x.ts",
      "dd if=/tmp/backup.img of=src/x.ts",
    ]) {
      const decision = judgeShellCommand(command, roots, memory);
      assert.equal(decision.behavior, "deny", `${disposition} — "${command}" must deny`);
      if (decision.behavior === "deny") assert.equal(decision.rule, "read-only-disposition-fence", `${disposition} — "${command}" deny rule`);
    }
    // Reads stay allowed (default-allow, src/choke.ts §doctrine): a Scout's
    // recon vocabulary never denies — and a scratch write outside the roots
    // (e.g. /tmp) is not a repository mutation.
    for (const command of [
      "cat src/x.ts",
      "ls -la",
      "grep -rn pattern src/",
      "git diff",
      "git log --oneline -5",
      "git status --short",
      "diff a.md b.md > /tmp/d",
    ]) {
      assert.equal(judgeShellCommand(command, roots, memory).behavior, "allow", `${disposition} — the read "${command}" must pass`);
    }
  }
  // The writers keep the same shell lines: engineer (and omitted) fence nothing new.
  for (const memory of [{ ...readOnlyFence("engineer") }, { workspace: "/ws/proj", worktree: RO_WORKTREE }]) {
    assert.equal(judgeShellCommand("echo findings > src/notes.txt", roots, memory).behavior, "allow", "engineer shell writes stay allowed");
  }
});

// ---- Seat write fence: isSeatMemoryPathAllowed (v0.0.23, ADR 0015 §2) -------------------------

test("isSeatMemoryPathAllowed admits stateDir, tmpDirs, and SEAT_MEMORY_WHITELIST under projectRoot, rejecting all other paths", () => {
  const projectRoot = "/ws/proj";
  const stateDir = "/state/factory";
  const tmpDirs = ["/tmp", tmpdir()];

  // Whitelisted root files (relative and absolute)
  for (const allowedFile of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", "GLOSSARY.md", ".gitignore", ".worktreeinclude"]) {
    assert.equal(isSeatMemoryPathAllowed(projectRoot, allowedFile, stateDir, tmpDirs), true, `relative ${allowedFile}`);
    assert.equal(isSeatMemoryPathAllowed(projectRoot, `./${allowedFile}`, stateDir, tmpDirs), true, `./${allowedFile}`);
    assert.equal(isSeatMemoryPathAllowed(projectRoot, `${projectRoot}/${allowedFile}`, stateDir, tmpDirs), true, `absolute ${allowedFile}`);
  }

  // Whitelisted docs/** and .scratch/** subtrees
  for (const allowedSubpath of ["docs/adr/0015.md", "docs/README.md", ".scratch/spec.md", ".scratch/factory-v0.0.23/issues/01.md"]) {
    assert.equal(isSeatMemoryPathAllowed(projectRoot, allowedSubpath, stateDir, tmpDirs), true, `relative ${allowedSubpath}`);
    assert.equal(isSeatMemoryPathAllowed(projectRoot, `${projectRoot}/${allowedSubpath}`, stateDir, tmpDirs), true, `absolute ${allowedSubpath}`);
  }

  // Allowed stateDir and tmpDirs
  assert.equal(isSeatMemoryPathAllowed(projectRoot, "/state/factory/mailbox.jsonl", stateDir, tmpDirs), true);
  assert.equal(isSeatMemoryPathAllowed(projectRoot, "/tmp/out.log", stateDir, tmpDirs), true);
  assert.equal(isSeatMemoryPathAllowed(projectRoot, `${tmpdir()}/scratch.txt`, stateDir, tmpDirs), true);
  assert.equal(isSeatMemoryPathAllowed(projectRoot, "/dev/null", stateDir, tmpDirs), true);

  // Rejected paths inside and outside projectRoot
  for (const rejected of [
    "src/GameStore.ts",
    `${projectRoot}/src/GameStore.ts`,
    "package.json",
    `${projectRoot}/package.json`,
    "ai-game/index.ts",
    "DESIGN.md",
    "src/AGENTS.md",
    "docs/../src/index.ts",
    "/etc/hosts",
    "/ws/other/AGENTS.md",
    "~/.ssh/authorized_keys",
  ]) {
    assert.equal(isSeatMemoryPathAllowed(projectRoot, rejected, stateDir, tmpDirs), false, `${rejected} must be rejected`);
  }
});

// ---- Per-Project Lead notebook fence (v0.1.0, ADR 0048 §3) -------------------------------------

test("the notebook fence expands the seat's state-dir env spellings ($FACTORY_STATE_DIR / $PASEO_FACTORY_STATE_DIR) the way the seat's shell does", () => {
  const projectRoot = "/ws/proj";
  const stateDir = "/state/factory";

  // The seat's shell resolves $FACTORY_STATE_DIR / $PASEO_FACTORY_STATE_DIR to the
  // state dir (both are baked into the seat env, plugin/server/roles.ts), so the judge
  // must judge the expanded destination — the spec's named heredoc spelling included.
  // (Every command below judges exactly as its literal-path twin; the attached-quoted
  // redirect `>"$FACTORY_STATE_DIR/…"` keeps the tokenizer's pre-existing quote-
  // blindness and denies like its literal twin `>"/state/…"` does.)
  for (const command of [
    `cat <<'EOF' > "$FACTORY_STATE_DIR/projects/demo-abc123/notebook.md"\n## 1. Verification & Run Recipe\nnpm run check\nEOF`,
    `echo "recipe" > $PASEO_FACTORY_STATE_DIR/projects/demo-abc123/notebook.md`,
    `echo "recipe" >$PASEO_FACTORY_STATE_DIR/projects/demo-abc123/notebook.md`,
    `echo "recipe" > \${FACTORY_STATE_DIR}/projects/demo-abc123/notebook.md`,
    `tee "$FACTORY_STATE_DIR/projects/demo-abc123/notebook.md" < draft.md`,
  ]) {
    assert.deepEqual(judgeSeatShellCommand(command, projectRoot, stateDir), { behavior: "allow" }, command);
  }

  // Expansion maps ONLY onto the seat's own state dir: the registry, ledger, mailbox,
  // and usage stay denied through the env spelling exactly as through the literal one.
  for (const protectedPath of [
    `$FACTORY_STATE_DIR/projects/demo-abc123/project.json`,
    `$PASEO_FACTORY_STATE_DIR/projects/demo-abc123/ledger.jsonl`,
    `"$FACTORY_STATE_DIR/projects/demo-abc123/mailbox.jsonl"`,
  ]) {
    const denied = judgeSeatShellCommand(`echo x > ${protectedPath}`, projectRoot, stateDir);
    assert.equal(denied.behavior, "deny", protectedPath);
    if (denied.behavior === "deny") assert.equal(denied.rule, "seat-write-fence", protectedPath);
  }

  // A longer env name that merely CONTAINS the state-dir name is a different variable —
  // never expanded.
  assert.equal(
    judgeSeatShellCommand(`echo x > $FACTORY_STATE_DIR_BACKUP/projects/demo-abc123/notebook.md`, projectRoot, stateDir).behavior,
    "deny",
  );
});

test("the Per-Project Lead notebook fence: seats may write only <stateDir>/projects/<slug>/notebook.md; the registry, ledger, mailbox, and usage stay protected", () => {
  const projectRoot = "/ws/proj";
  const stateDir = "/state/factory";
  const notebook = `${stateDir}/projects/demo-abc123/notebook.md`;

  // The seat judges allow the notebook — the path itself, direct Write/Edit asks, and
  // shell writes (the `$FACTORY_STATE_DIR` env spellings the seat's shell expands are
  // pinned by the env-spelling test below).
  assert.equal(isSeatMemoryPathAllowed(projectRoot, notebook, stateDir), true, "the memory-path predicate");
  assert.deepEqual(judgeSeatFilePath(notebook, projectRoot, stateDir), { behavior: "allow" }, "a direct file edit");
  for (const command of [
    `cat <<'EOF' > ${notebook}\n## 1. Verification & Run Recipe\nnpm run check\nEOF`,
    `echo "recipe" > ${notebook}`,
    `echo "more" >> ${notebook}`,
    `tee ${notebook} < draft.md`,
  ]) {
    assert.deepEqual(judgeSeatShellCommand(command, projectRoot, stateDir), { behavior: "allow" }, command);
  }

  // The notebook allowance is exactly `<slug>/notebook.md` — a nested notebook stays protected.
  assert.equal(isSeatMemoryPathAllowed(projectRoot, `${stateDir}/projects/demo-abc123/sub/notebook.md`, stateDir), false);

  // Every other per-project state file the registry owns stays denied for seats.
  for (const protectedPath of [
    `${stateDir}/projects/demo-abc123/project.json`,
    `${stateDir}/projects/demo-abc123/ledger.jsonl`,
    `${stateDir}/projects/demo-abc123/mailbox.jsonl`,
    `${stateDir}/projects/demo-abc123/usage.json`,
    `${stateDir}/projects/demo-abc123/lanes.json`,
  ]) {
    assert.equal(isSeatMemoryPathAllowed(projectRoot, protectedPath, stateDir), false, `${protectedPath} — predicate`);
    assert.equal(judgeSeatFilePath(protectedPath, projectRoot, stateDir).behavior, "deny", `${protectedPath} — file ask`);
    const shell = judgeSeatShellCommand(`echo x > ${protectedPath}`, projectRoot, stateDir);
    assert.equal(shell.behavior, "deny", `${protectedPath} — shell ask`);
    if (shell.behavior === "deny") assert.equal(shell.rule, "seat-write-fence");
  }
});

test("the Per-Project Lead notebook fence: a contracted working Peer is denied every write to <stateDir>/projects/<slug>/notebook.md", () => {
  const roots = shellRoots(); // workspace /ws/proj, stateDir /state
  const notebook = "/state/projects/demo-abc123/notebook.md";
  const worktreeFence = { workspace: "/ws/proj", worktree: "/state/projects/demo-abc123/worktrees/T-01" };

  // Direct Write/Edit asks deny on both the worktree-scoped and the bare workspace path.
  for (const fence of [worktreeFence, undefined]) {
    const denied = judgeFilePath(notebook, roots, fence);
    assert.equal(denied.behavior, "deny", fence ? "worktree-scoped MemoryFence" : "no memory context");
    if (denied.behavior === "deny") assert.equal(denied.rule, "seat-write-fence");
  }

  // Shell writes deny in every shape — heredoc, overwrite, append, tee — including the
  // `$FACTORY_STATE_DIR` env spelling the seat's shell would expand to the notebook
  // (without the expansion this spelling resolves relative to the workspace and slips
  // past the fence).
  for (const command of [
    `cat <<'EOF' > ${notebook}\nx\nEOF`,
    `echo tamper > ${notebook}`,
    `echo tamper >> ${notebook}`,
    `tee ${notebook} < draft.md`,
    `echo tamper > "$FACTORY_STATE_DIR/projects/demo-abc123/notebook.md"`,
    `echo tamper > $FACTORY_STATE_DIR/projects/demo-abc123/notebook.md`,
  ]) {
    const denied = judgeShellCommand(command, roots, worktreeFence);
    assert.equal(denied.behavior, "deny", command);
    if (denied.behavior === "deny") assert.equal(denied.rule, "seat-write-fence");
  }
  assert.equal(judgeShellCommand(`echo tamper > ${notebook}`, roots).behavior, "deny", "no memory context");

  // The peer's own worktree writes stay allowed — the fence tightens only the notebook.
  assert.equal(judgeFilePath("/state/projects/demo-abc123/worktrees/T-01/src/x.ts", roots, worktreeFence).behavior, "allow");
  assert.equal(judgeShellCommand("echo x > /state/projects/demo-abc123/worktrees/T-01/notes.txt", roots, worktreeFence).behavior, "allow");
});

test("pinCreateMode pins modeId: 'default' only for claude workers, leaves opencode/codex/pi untouched, and never pins Supervisor or Lead seats", (t) => {
  const dir = makeTempDir("choke-pin-test-");
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  const stateDir = join(dir, "state");
  const worktree = join(stateDir, "projects", "ws-123456", "worktrees", "T-01");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(workspace, "probe.txt"), "x\n");
  gitCommitAll(workspace, "base");

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "T-01", workspace, gate: "true", artifact: "probe.txt" });
  factory.requestSpawn({ task: "T-01", provider: "opencode/minimax-m2.5-free", arity: 1, worktree });
  const choke = createChoke({ factory, homeDir: "/fake-home" });

  // Claude worker in a contracted worktree is pinned to "default"
  const claudeWorker = choke.pinCreateMode({ provider: "claude/claude-sonnet-4-6", cwd: worktree, modeId: "bypassPermissions" }, { seat: "agent" });
  assert.equal(claudeWorker?.modeId, "default");

  // Non-Claude workers (opencode, codex, pi) keep their native modeId (returns undefined)
  for (const provider of ["opencode", "opencode/minimax-m2.5-free", "codex", "codex/gpt-5.4", "pi", "pi/zai/glm-5.1"]) {
    assert.equal(
      choke.pinCreateMode({ provider, cwd: worktree, modeId: "build" }, { seat: "agent" }),
      undefined,
      `${provider} worker must not be pinned to 'default'`,
    );
  }

  // Supervisor and Lead at <project-root> are NEVER pinned, even for claude and even when a Contract's workspace is <project-root>
  assert.equal(
    choke.pinCreateMode({ provider: "claude/claude-opus-4-7", cwd: workspace, modeId: "bypassPermissions" }, { seat: "supervisor" }),
    undefined,
    "Supervisor with labels.seat=supervisor is never pinned",
  );
  assert.equal(
    choke.pinCreateMode({ provider: "claude/claude-sonnet-4-6", cwd: workspace, modeId: "bypassPermissions" }, { seat: "lead" }),
    undefined,
    "Lead with labels.seat=lead is never pinned",
  );
  assert.equal(
    choke.pinCreateMode({ provider: "opencode/minimax-m2.5-free", cwd: workspace, modeId: "build", title: "Lead (paseo-factory)" }),
    undefined,
    "rotated Lead at <project-root> keeps its native modeId",
  );
});

test("choke.onPermissionAsked enforces seat-write-fence on Supervisor and Lead at <project-root> even when a Contract's workspace is <project-root>", async (t) => {
  const dir = makeTempDir("choke-seat-fence-test-");
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  const stateDir = join(dir, "state");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "probe.txt"), "x\n");
  gitCommitAll(workspace, "base");

  const factory = createFactory({ stateDir });
  // Active contract whose workspace is <project-root> (does NOT scope AGENTS.md — would deny a worker on memory-write-fenced, but must allow a Seat!)
  factory.setContract({ task: "T-01", workspace, gate: "true", artifact: "probe.txt" });
  const choke = createChoke({ factory, homeDir: "/fake-home" });

  const sent: { agentId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const paseo: PaseoResponderApi = {
    agents: {
      ref(agentId: string) {
        return {
          async respondToPermission({ requestId, response }) {
            sent.push({ agentId, requestId, response });
          },
        };
      },
    },
  };

  const askSeat = async (
    seat: "supervisor" | "lead",
    id: string,
    request: Omit<AgentPermissionRequest, "id" | "provider">,
  ) => {
    await choke.onPermissionAsked(
      {
        agent: { id: `${seat}-1`, cwd: workspace, labels: { seat, project: "ws" } },
        request: { id, provider: "opencode", ...request },
      },
      paseo,
    );
    return sent.at(-1)!;
  };

  // 1. Allowed file writes for Supervisor and Lead within SEAT_MEMORY_WHITELIST
  for (const [idx, filePath] of ["AGENTS.md", "CONTEXT.md", "docs/adr/0015.md", ".scratch/spec.md"].entries()) {
    const sup = await askSeat("supervisor", `allow-sup-${idx}`, {
      name: "Write",
      kind: "tool",
      detail: { type: "write", filePath, content: "# updated\n" },
    });
    assert.equal(sup.response.behavior, "allow", `Supervisor allowed to write ${filePath}`);

    const lead = await askSeat("lead", `allow-lead-${idx}`, {
      name: "Edit",
      kind: "tool",
      detail: { type: "edit", filePath, oldString: "a", newString: "b" },
    });
    assert.equal(lead.response.behavior, "allow", `Lead allowed to edit ${filePath}`);
  }

  // 2. Allowed shell commands: read-only, factory CLI (even when --message mentions src/** or npm install), and whitelisted shell writes
  for (const [idx, command] of [
    "git status --short",
    "ls -la src/",
    'factory lead dispatch --workspace /ws --message "Edit src/GameStore.ts and run npm install"',
    'node "/plugins/paseo-factory/bin/factory.mjs" contract --task T-02 --workspace /ws --gate "npm test" --artifact src/GameStore.ts',
    "echo '# Decision' > docs/adr/0016.md",
    "cat > .scratch/plan.md",
  ].entries()) {
    const res = await askSeat("supervisor", `allow-cmd-${idx}`, {
      name: "Bash",
      kind: "tool",
      detail: { type: "shell", command, cwd: workspace },
    });
    assert.equal(res.response.behavior, "allow", `Seat allowed to run: ${command}`);
  }

  // 3. Denied file writes to product source files (src/GameStore.ts, package.json)
  for (const [idx, filePath] of ["src/GameStore.ts", "package.json", `${workspace}/src/index.ts`].entries()) {
    const sup = await askSeat("supervisor", `deny-file-sup-${idx}`, {
      name: "Write",
      kind: "tool",
      detail: { type: "write", filePath, content: "export const x = 1;\n" },
    });
    assert.equal(sup.response.behavior, "deny", `Supervisor denied writing ${filePath}`);
    if (sup.response.behavior === "deny") {
      assert.equal(
        sup.response.message,
        "Seat write fence: Supervisor and Lead may only write project memory/docs (AGENTS.md, CONTEXT.md, docs/**, .scratch/**); dispatch implementation work to Lead / Task Agents",
      );
    }

    const lead = await askSeat("lead", `deny-file-lead-${idx}`, {
      name: "Write",
      kind: "tool",
      detail: { type: "write", filePath, content: "export const x = 1;\n" },
    });
    assert.equal(lead.response.behavior, "deny", `Lead denied writing ${filePath}`);
  }

  // 4. Denied shell commands: package installs and shell writes outside SEAT_MEMORY_WHITELIST
  for (const [idx, command] of [
    "npm install",
    "npm i zustand",
    "pnpm add react",
    "pnpm install",
    "yarn add lodash",
    "bun install",
    "echo 'export const x = 1' > src/GameStore.ts",
    "cp /tmp/draft.ts src/GameStore.ts",
    "rm package.json",
  ].entries()) {
    const res = await askSeat("supervisor", `deny-cmd-${idx}`, {
      name: "Bash",
      kind: "tool",
      detail: { type: "shell", command, cwd: workspace },
    });
    assert.equal(res.response.behavior, "deny", `Seat denied running: ${command}`);
    if (res.response.behavior === "deny") {
      assert.match(res.response.message ?? "", /Seat write fence/);
    }
  }

  const seatDenials = factory.ledger.events.filter((e) => e.event === "permit_denied" && e.rule === "seat-write-fence");
  assert.ok(seatDenials.length >= 15, "every seat-write-fence denial is recorded in the ledger with rule 'seat-write-fence'");

  // 5. Dangerous git commands from a Seat are denied with rule 'dangerous-git'
  const gitDenied = await askSeat("supervisor", "deny-git-1", {
    name: "Bash",
    kind: "tool",
    detail: { type: "shell", command: "git push --force origin main", cwd: workspace },
  });
  assert.equal(gitDenied.response.behavior, "deny");
  const lastDenied = factory.ledger.events.findLast((e) => e.event === "permit_denied");
  assert.equal(lastDenied?.rule, "dangerous-git");
});

test("isContractedAgentCwd recognizes a single-checkout subdirectory Contract under a registered project while keeping <project-root> as a Seat cwd (v0.0.23, T-03)", async (t) => {
  const dir = makeTempDir("choke-subdir-contract-");
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  const subdir = join(workspace, "packages", "sub");
  const stateDir = join(dir, "state");
  mkdirSync(subdir, { recursive: true });
  writeFileSync(join(subdir, "index.ts"), "export const x = 1;\n");
  gitCommitAll(workspace, "base");

  writeProjectRegistration(stateDir, "ws-123456", {
    root: workspace,
    supervisor: "sup-1",
    lead: "lead-1",
  });

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "T-SUB", workspace: subdir, gate: "true", artifact: "index.ts" });
  const choke = createChoke({ factory, homeDir: "/fake-home" });

  assert.equal(isContractedAgentCwd(factory, workspace), false, "<project-root> itself is not a contracted Agent cwd");
  assert.equal(isContractedAgentCwd(factory, subdir), true, "contracted subdirectory is a contracted Agent cwd");

  // Claude agent in the contracted subdirectory is pinned to modeId: 'default'
  const pinned = choke.pinCreateMode({ provider: "claude/claude-sonnet-4-6", cwd: subdir, modeId: "bypassPermissions" });
  assert.equal(pinned?.modeId, "default");

  // Permission asks from the contracted subdirectory are mediated by the choke
  const sent: { agentId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const paseo: PaseoResponderApi = {
    agents: {
      ref(agentId: string) {
        return {
          async respondToPermission({ requestId, response }) {
            sent.push({ agentId, requestId, response });
          },
        };
      },
    },
  };
  await choke.onPermissionAsked(
    {
      agent: { id: "agent-sub-1", cwd: subdir, labels: { seat: "agent", task: "T-SUB" } },
      request: {
        id: "ask-sub-1",
        provider: "claude",
        name: "Write",
        kind: "tool",
        detail: { type: "write", filePath: join(subdir, "index.ts"), content: "export const x = 2;\n" },
      },
    },
    paseo,
  );
  assert.equal(sent.length, 1, "subdirectory Agent ask was answered by choke");
  assert.equal(sent[0].response.behavior, "allow");
});

test("choke.onPermissionAsked and resolveSeatAtProjectRoot enforce seat-write-fence on normal-chat agents recorded in reg.dispatchers (v0.0.24, T-03)", async (t) => {
  const dir = makeTempDir("choke-dispatcher-fence-");
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  const stateDir = join(dir, "state");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "probe.txt"), "x\n");
  gitCommitAll(workspace, "base");

  writeProjectRegistration(stateDir, "ws-123456", {
    root: workspace,
    supervisor: "sup-1",
    lead: "lead-1",
    dispatchers: ["chat-session-7c5ac02"],
  });

  const factory = createFactory({ stateDir });
  const choke = createChoke({ factory, homeDir: "/fake-home" });

  const sent: { agentId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const paseo: PaseoResponderApi = {
    agents: {
      ref(agentId: string) {
        return {
          async respondToPermission({ requestId, response }) {
            sent.push({ agentId, requestId, response });
          },
        };
      },
    },
  };

  // Dispatcher session (no seat label, normal title) attempting to write product code or rm -rf ai-game is denied by seat-write-fence
  await choke.onPermissionAsked(
    {
      agent: { id: "chat-session-7c5ac02", cwd: workspace, title: "New Chat", labels: {} },
      request: {
        id: "disp-write-1",
        provider: "opencode",
        name: "Write",
        kind: "tool",
        detail: { type: "write", filePath: "src/GameStore.ts", content: "export const x = 1;\n" },
      },
    },
    paseo,
  );
  assert.equal(sent.at(-1)?.response.behavior, "deny", "dispatcher session denied writing product source file");

  await choke.onPermissionAsked(
    {
      agent: { id: "chat-session-7c5ac02", cwd: workspace, title: "New Chat", labels: {} },
      request: {
        id: "disp-rm-1",
        provider: "opencode",
        name: "Bash",
        kind: "tool",
        detail: { type: "shell", command: "rm -rf ai-game", cwd: workspace },
      },
    },
    paseo,
  );
  assert.equal(sent.at(-1)?.response.behavior, "deny", "dispatcher session denied running rm -rf ai-game");

  const deniedEvents = factoryRegistryFor(stateDir, { root: factory })
    .factoryForProject("ws-123456")
    .ledger.events // v0.0.89: the denial lands in the OWNING Project's Factory, not the root one
    .filter((e) => e.event === "permit_denied")
    .filter((e) => e.agent === "chat-session-7c5ac02");
  assert.equal(deniedEvents.length, 2);
  assert.equal(deniedEvents[0]?.rule, "seat-write-fence");
  assert.equal(deniedEvents[1]?.rule, "seat-write-fence");
});

test("the Layer-2 write-tool vocabulary covers ZCode's DeleteFile and NotebookEdit — judged by the seat-write-fence exactly like Edit (v0.0.94, ADR 0046 Decision 5.1 Layer 2)", async (t) => {
  const dir = makeTempDir("choke-zcode-vocab-");
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  const stateDir = join(dir, "state");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "probe.txt"), "x\n");
  gitCommitAll(workspace, "base");

  const factory = createFactory({ stateDir });
  const choke = createChoke({ factory, homeDir: "/fake-home" });
  const sent: { agentId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const paseo: PaseoResponderApi = {
    agents: {
      ref(agentId: string) {
        return {
          async respondToPermission({ requestId, response }) {
            sent.push({ agentId, requestId, response });
          },
        };
      },
    },
  };
  const askSeat = async (id: string, request: Omit<AgentPermissionRequest, "id" | "provider">) => {
    await choke.onPermissionAsked(
      {
        agent: { id: "supervisor-1", cwd: workspace, labels: { seat: "supervisor", project: "ws" } },
        request: { id, provider: "zcode", ...request },
      },
      paseo,
    );
    return sent.at(-1)!;
  };

  // 1. A path-carrying DeleteFile/NotebookEdit ask hits the seat-write-fence
  //    decision path exactly like Edit: product-source writes denied with the
  //    seat-write-fence rule, memory-whitelist writes allowed.
  const delDenied = await askSeat("z-del-1", {
    name: "DeleteFile",
    kind: "tool",
    detail: { type: "write", filePath: "src/GameStore.ts" },
  });
  assert.equal(delDenied.response.behavior, "deny", "DeleteFile on product source is denied");
  if (delDenied.response.behavior === "deny") {
    assert.match(delDenied.response.message ?? "", /Seat write fence/);
  }
  const nbDenied = await askSeat("z-nb-1", {
    name: "NotebookEdit",
    kind: "tool",
    input: { path: "package.json" },
  });
  assert.equal(nbDenied.response.behavior, "deny", "NotebookEdit on package.json is denied");
  if (nbDenied.response.behavior === "deny") {
    assert.match(nbDenied.response.message ?? "", /Seat write fence/);
  }
  const delAllowed = await askSeat("z-del-2", {
    name: "DeleteFile",
    kind: "tool",
    detail: { type: "write", filePath: "CONTEXT.md" },
  });
  assert.equal(delAllowed.response.behavior, "allow", "DeleteFile inside the memory whitelist is allowed like any seat write");

  // 2. The vocabulary itself: an ask whose only "path" is the tool NAME (an
  //    echo of the ask shape with no structured paths) is treated exactly like
  //    the Edit twin — the tool name is a write-tool placeholder, never a file
  //    target, so the judge never records a phantom seat-write-fence denial.
  const behaviors = new Map<string, string>();
  for (const [name, type] of [["Edit", "edit"], ["DeleteFile", "write"], ["NotebookEdit", "edit"]] as const) {
    const res = await askSeat(`z-echo-${name}`, {
      name,
      kind: "tool",
      detail: { type, filePath: name },
    });
    behaviors.set(name, res.response.behavior);
  }
  assert.deepEqual(
    behaviors.get("DeleteFile"),
    behaviors.get("Edit"),
    "DeleteFile's name-echo ask is judged exactly like Edit's — a write-tool name is never a file path",
  );
  assert.deepEqual(
    behaviors.get("NotebookEdit"),
    behaviors.get("Edit"),
    "NotebookEdit's name-echo ask is judged exactly like Edit's — a write-tool name is never a file path",
  );
  assert.equal(behaviors.get("Edit"), "allow", "the Edit twin carries no file target and no shell line — the pre-existing default");
  const phantom = factory.ledger.events.filter(
    (e) => e.event === "permit_denied" && (e.command === "DeleteFile" || e.command === "NotebookEdit"),
  );
  assert.equal(phantom.length, 0, "no phantom seat-write-fence denial records the tool name as a file target");
});

test("Seam 3 (v0.0.89, ADR 0045 §3): allowed Supervisor, Lead, and dispatcher seat asks answer allow() with ZERO permit_allowed lines — seats are deny-only in the Ledger", async (t) => {
  const dir = makeTempDir("choke-seat-deny-only-");
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  const stateDir = join(dir, "state");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "probe.txt"), "x\n");
  gitCommitAll(workspace, "base");

  writeProjectRegistration(stateDir, "ws-123456", {
    root: workspace,
    supervisor: "sup-9",
    lead: "lead-9",
    dispatchers: ["chat-session-9d1"],
  });

  const factory = createFactory({ stateDir });
  const choke = createChoke({ factory, homeDir: "/fake-home" });

  const sent: { agentId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const paseo: PaseoResponderApi = {
    agents: {
      ref(agentId: string) {
        return {
          async respondToPermission({ requestId, response }) {
            sent.push({ agentId, requestId, response });
          },
        };
      },
    },
  };

  const ask = async (
    agent: { id: string; cwd: string; labels?: Record<string, string>; title?: string | null },
    id: string,
    request: Omit<AgentPermissionRequest, "id" | "provider">,
  ): Promise<void> => {
    await choke.onPermissionAsked({ agent, request: { id, provider: "opencode", ...request } }, paseo);
  };

  // Routine orchestration turns: a read/status shell call, a whitelisted
  // memory write, and a paseo_factory MCP tool call — on all three seat kinds.
  const shell = (command: string): Omit<AgentPermissionRequest, "id" | "provider"> => ({
    name: "Bash",
    kind: "tool",
    detail: { type: "shell", command, cwd: workspace },
  });
  await ask({ id: "sup-9", cwd: workspace, labels: { seat: "supervisor", project: "ws-123456" } }, "sup-read-1", shell("git status --short"));
  await ask(
    { id: "sup-9", cwd: workspace, labels: { seat: "supervisor", project: "ws-123456" } },
    "sup-mcp-1",
    { name: "mcp__paseo_factory__factory_status", kind: "tool" },
  );
  await ask({ id: "lead-9", cwd: workspace, labels: { seat: "lead", project: "ws-123456" } }, "lead-read-1", shell("ls -la docs/"));
  await ask(
    { id: "lead-9", cwd: workspace, labels: { seat: "lead", project: "ws-123456" } },
    "lead-write-1",
    { name: "Write", kind: "tool", detail: { type: "write", filePath: "AGENTS.md", content: "# rule\n" } },
  );
  await ask({ id: "chat-session-9d1", cwd: workspace, title: "New Chat", labels: {} }, "disp-read-1", shell("cat package.json"));

  assert.equal(sent.length, 5, "every allowed seat ask is answered");
  assert.ok(sent.every((x) => x.response.behavior === "allow"), "allowed seat asks call allow() immediately");
  const projectFactory = factoryRegistryFor(stateDir, { root: factory }).factoryForProject("ws-123456");
  for (const ledger of [factory.ledger, projectFactory.ledger]) {
    assert.equal(
      ledger.events.filter((e) => e.event === "permit_allowed").length,
      0,
      "an allowed seat ask appends ZERO permit_allowed lines — root and owning Project alike",
    );
  }
  assert.equal(factory.ledger.events.length, 0, "no ledger line of any kind lands in the root Factory for allowed seat asks");

  // The deny side is unchanged: a seat violation records permit_denied in
  // full — task (the seat name), agent, permission, command, and rule — in
  // the OWNING Project's Factory (v0.0.89 routing).
  await ask({ id: "sup-9", cwd: workspace, labels: { seat: "supervisor", project: "ws-123456" } }, "sup-deny-1", shell("npm install"));
  assert.equal(sent.at(-1)?.response.behavior, "deny");
  await ask({ id: "lead-9", cwd: workspace, labels: { seat: "lead", project: "ws-123456" } }, "lead-deny-1", shell("git push --force origin main"));
  assert.equal(sent.at(-1)?.response.behavior, "deny");
  const denied = projectFactory.ledger.events.filter((e) => e.event === "permit_denied");
  assert.equal(denied.length, 2, "only the violations are recorded");
  const supDenied = denied.find((e) => e.agent === "sup-9")!;
  assert.equal(supDenied.task, "supervisor");
  assert.equal(supDenied.name, "Bash");
  assert.equal(supDenied.kind, "tool");
  assert.equal(supDenied.command, "npm install", "seat denials keep the full command");
  assert.equal(supDenied.rule, "seat-write-fence");
  const leadDenied = denied.find((e) => e.agent === "lead-9")!;
  assert.equal(leadDenied.task, "lead");
  assert.equal(leadDenied.command, "git push --force origin main", "Lead denials keep the full command too");
  assert.equal(leadDenied.rule, "dangerous-git");
});

test("Seam 3 (v0.0.89): permit_denied lands in the OWNING Project's Factory — two registered Projects route by their git roots", async (t) => {
  const dir = makeTempDir("choke-permit-routing-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const rootA = join(dir, "project-a");
  const rootB = join(dir, "project-b");
  for (const root of [rootA, rootB]) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "probe.txt"), "x\n");
    gitCommitAll(root, "base");
  }
  // Register under the CANONICAL slugs so the workspace arm of the
  // context-first resolution binds each root to its own Project.
  const resolvedA = resolveProject(rootA);
  const resolvedB = resolveProject(rootB);
  const slugA = resolvedA.ok ? resolvedA.slug : "";
  const slugB = resolvedB.ok ? resolvedB.slug : "";
  assert.ok(slugA !== "" && slugB !== "" && slugA !== slugB, `two distinct canonical slugs: ${slugA} / ${slugB}`);
  writeProjectRegistration(stateDir, slugA, { root: rootA, supervisor: "sup-a", lead: "lead-a" });
  writeProjectRegistration(stateDir, slugB, { root: rootB, supervisor: "sup-b", lead: "lead-b" });

  const factory = createFactory({ stateDir });
  const choke = createChoke({ factory, homeDir: "/fake-home" });
  const sent: { agentId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const paseo: PaseoResponderApi = {
    agents: {
      ref(agentId: string) {
        return {
          async respondToPermission({ requestId, response }) {
            sent.push({ agentId, requestId, response });
          },
        };
      },
    },
  };

  const denyAt = async (agentId: string, cwd: string, id: string): Promise<void> => {
    await choke.onPermissionAsked(
      {
        agent: { id: agentId, cwd, labels: { seat: "supervisor" } },
        request: { id, provider: "opencode", name: "Bash", kind: "tool", detail: { type: "shell", command: "npm install", cwd } },
      },
      paseo,
    );
  };
  await denyAt("sup-a", rootA, "route-a-1");
  await denyAt("sup-b", rootB, "route-b-1");
  assert.ok(sent.every((x) => x.response.behavior === "deny"));

  const registry = factoryRegistryFor(stateDir, { root: factory });
  const denialsOf = (slug: string) => registry.factoryForProject(slug).ledger.events.filter((e) => e.event === "permit_denied");
  assert.equal(denialsOf(slugA).length, 1, "Project A's Factory carries its own denial");
  assert.equal(denialsOf(slugA)[0]?.agent, "sup-a");
  assert.equal(denialsOf(slugA)[0]?.command, "npm install", "the routed line keeps the full command");
  assert.equal(denialsOf(slugB).length, 1, "Project B's Factory carries its own denial");
  assert.equal(denialsOf(slugB)[0]?.agent, "sup-b");
  assert.equal(factory.ledger.events.length, 0, "the shared root Factory records nothing itself");
});

test("Seam 3 (v0.0.89): the WIRED choke — registry.root bound at the shell — judges Peer asks and synthetic asks through the owning Project's Factory", async (t) => {
  const dir = makeTempDir("choke-wired-root-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const root = join(dir, "wired-ws");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "probe.txt"), "x\n");
  gitCommitAll(root, "base");
  const resolved = resolveProject(root);
  assert.ok(resolved.ok, "the workspace resolves to a canonical slug");
  const slug = resolved.slug;

  // The plugin shell's exact wiring (plugin/index.server.ts): one process-wide
  // registry; the choke's Factory is registry.root while every Contract lands
  // in the owning Project's Factory through the routed spool.
  const registry = factoryRegistryFor(stateDir, { root: createFactory({ stateDir }) });
  const wiredRoot = registry.root;
  const choke = createChoke({ factory: wiredRoot, homeDir: "/fake-home" });
  const sent: { agentId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const paseo: PaseoResponderApi = {
    agents: {
      ref(agentId: string) {
        return {
          async respondToPermission({ requestId, response }) {
            sent.push({ agentId, requestId, response });
          },
        };
      },
    },
  };

  const contractReply = await handleSpoolRequest(
    wiredRoot,
    { id: "w-c1", kind: "contract", task: "T-01", workspace: root, gate: "true", artifact: "probe.txt", submitter: "owner" },
    {},
    registry,
  );
  assert.equal(contractReply.ok, true, "the wired spool routes the Contract");
  const worktree = join(stateDir, "projects", slug, "worktrees", "T-01");
  mkdirSync(worktree, { recursive: true });
  const project = registry.factoryForProject(slug);
  project.requestSpawn({ task: "T-01", provider: "opencode/minimax-m2.5-free", arity: 1, worktree });
  assert.notEqual(project.contractFor("T-01"), undefined, "the OWNING Project's Factory carries the Contract");
  assert.equal(wiredRoot.contractFor("T-01"), undefined, "the wired root Factory holds no Contract after isolation");

  // A contracted Peer's live ask is judged, answered, and recorded in the
  // owning Project's Ledger — never silently ignored for want of a root Contract.
  await choke.onPermissionAsked(
    {
      agent: { id: "peer-w1", cwd: worktree, labels: { seat: "agent", project: slug, task: "T-01" } },
      request: { id: "w-ask-1", provider: "opencode", name: "Bash", kind: "tool", detail: { type: "shell", command: "git status", cwd: worktree } },
    },
    paseo,
  );
  assert.equal(sent.length, 1, "the contracted Peer's ask is answered exactly once");
  assert.equal(sent[0]?.response.behavior, "allow");
  const leanAllows = project.ledger.events.filter((e) => e.event === "permit_allowed");
  assert.equal(leanAllows.length, 1, "the allowed ask lands in the OWNING Project's Ledger");
  assert.equal("command" in leanAllows[0]!, false, "the Peer allow stays lean (no command body)");
  assert.equal(wiredRoot.ledger.events.length, 0, "the root Factory records nothing itself");

  // The spool's synthetic ask rides the same routing — no unknown-task refusal.
  const askReply = await handleSpoolRequest(
    wiredRoot,
    { id: "w-ask-s", kind: "ask", task: "T-01", command: "git status", cwd: worktree, agent: "peer-w1" },
    { ask: choke.spoolAskHandler },
    registry,
  );
  assert.equal(askReply.ok, true, `the synthetic ask judges through the owning Project (${JSON.stringify(askReply)})`);
  assert.equal(project.ledger.events.filter((e) => e.event === "permit_allowed").length, 2, "the synthetic allow lands beside the live one");

  // The create-mode pin resolves its judging Factory the same way.
  assert.equal(
    choke.pinCreateMode({ provider: "claude/claude-sonnet-4-6", cwd: worktree, modeId: "bypassPermissions" }, { seat: "agent" })?.modeId,
    "default",
    "a contracted Claude worker in a Project worktree still pins to Always Ask",
  );
});

test("normalizeAgentCreateRequest prefixes bare model IDs without '/' and labels untagged 'Supervisor — ...' / 'Lead — ...' creations at registered <project-root> (v0.0.24, T-03)", (t) => {
  const dir = makeTempDir("choke-normalize-create-");
  disposeDir(t, dir);
  const workspace = join(dir, "ai-test");
  const stateDir = join(dir, "state");
  mkdirSync(workspace, { recursive: true });

  writeProjectRegistration(stateDir, "ai-test-043c7e", {
    root: workspace,
    supervisor: "sup-1",
    lead: "lead-1",
  });

  // 1. Bare OpenCode / free-pool model IDs get prefixed with opencode/opencode/
  for (const bareModel of [
    "nemotron-3.5-super-vl-free",
    "nemotron-3-ultra-free",
    "qwen3-coder-free",
    "glm-5.1",
    "deepseek-r1",
    "minimax-m2.5-free",
    "kimi-k2",
  ]) {
    const req = normalizeAgentCreateRequest(
      { config: { provider: bareModel, cwd: workspace, title: "Worker" } },
      stateDir,
    );
    assert.equal(req.config.provider, `opencode/opencode/${bareModel}`, `bare model ${bareModel} normalized`);
  }

  // 2. Bare Claude and Codex model IDs get their respective provider prefixes
  assert.equal(
    normalizeAgentCreateRequest({ config: { provider: "claude-sonnet-4-6", cwd: workspace } }, stateDir).config.provider,
    "claude-code/claude-sonnet-4-6",
  );
  assert.equal(
    normalizeAgentCreateRequest({ config: { provider: "sonnet", cwd: workspace } }, stateDir).config.provider,
    "claude-code/sonnet",
  );
  assert.equal(
    normalizeAgentCreateRequest({ config: { provider: "gpt-5.4", cwd: workspace } }, stateDir).config.provider,
    "codex/gpt-5.4",
  );
  assert.equal(
    normalizeAgentCreateRequest({ config: { provider: "o3-mini", cwd: workspace } }, stateDir).config.provider,
    "codex/o3-mini",
  );

  // 3. Optional provider catalog resolution wins when unambiguous, and leaves ambiguous bare models untouched
  const catalog = [
    { id: "pi", models: [{ id: "zai/glm-5.3" }, { id: "shared-model" }] },
    {
      provider: "opencode",
      models: [
        { id: "opencode/nemotron-3-ultra-free", thinkingOptions: [] },
        { id: "shared-model" },
      ],
    },
    {
      provider: "claude",
      models: [{ id: "opus-4-8", thinkingOptions: [{ id: "max", label: "Max" }] }],
    },
  ];
  assert.equal(
    normalizeAgentCreateRequest({ config: { provider: "glm-5.3", cwd: workspace } }, stateDir, catalog).config.provider,
    "pi/zai/glm-5.3",
  );
  assert.equal(
    normalizeAgentCreateRequest({ config: { provider: "shared-model", cwd: workspace } }, stateDir, catalog).config.provider,
    "shared-model",
    "ambiguous bare model matching multiple providers is left untouched rather than guessing",
  );
  assert.equal(
    normalizeAgentCreateRequest({ config: { provider: "unknown-custom-model", cwd: workspace } }, stateDir).config.provider,
    "unknown-custom-model",
    "unknown bare strings outside known families are left untouched when providers is absent",
  );
  assert.equal(
    normalizeAgentCreateRequest({ config: { provider: "llama-3.3-70b", cwd: workspace } }, stateDir).config.provider,
    "opencode/opencode/llama-3.3-70b",
    "llama* family bare model is prefixed with opencode/opencode/",
  );

  // 3b. Unsupported thinkingOptionId and :thinking suffixes are stripped against providers catalog
  const strippedThinking = normalizeAgentCreateRequest(
    {
      config: {
        provider: "opencode/opencode/nemotron-3-ultra-free:max",
        thinkingOptionId: "max",
        cwd: workspace,
        title: "Worker",
      },
    },
    { stateDir, providers: catalog },
  );
  assert.equal(strippedThinking.config.provider, "opencode/opencode/nemotron-3-ultra-free", "unsupported :max suffix stripped from provider");
  assert.equal(
    "thinkingOptionId" in strippedThinking.config ? strippedThinking.config.thinkingOptionId : undefined,
    undefined,
    "unsupported thinkingOptionId stripped when thinkingOptions is []",
  );

  const keptThinking = normalizeAgentCreateRequest(
    {
      config: {
        provider: "claude/opus-4-8",
        thinkingOptionId: "max",
        cwd: workspace,
        title: "Worker",
      },
    },
    { stateDir, providers: catalog },
  );
  assert.equal(keptThinking.config.thinkingOptionId, "max", "supported thinkingOptionId is preserved");

  // 4. Already-prefixed providers and valid top-level provider IDs pass through unchanged
  for (const valid of ["opencode/opencode/nemotron-3-ultra-free", "claude/claude-sonnet-4-6", "opencode", "claude", "codex", "pi"]) {
    const original = { config: { provider: valid, cwd: workspace, title: "Regular Chat" } };
    const res = normalizeAgentCreateRequest(original, stateDir);
    assert.equal(res, original, `${valid} should remain untouched`);
  }

  // 5. Untagged "Supervisor — ..." and "Lead — ..." creations at registered <project-root> receive canonical seat & project labels
  const rogueSup = normalizeAgentCreateRequest(
    {
      config: {
        provider: "nemotron-3.5-super-vl-free",
        cwd: workspace,
        title: "Supervisor — ai-test",
      },
    },
    stateDir,
  );
  assert.equal(rogueSup.config.provider, "opencode/opencode/nemotron-3.5-super-vl-free");
  assert.deepEqual(rogueSup.config.labels, { seat: "supervisor", project: "ai-test-043c7e" });
  assert.deepEqual(rogueSup.labels, { seat: "supervisor", project: "ai-test-043c7e" });

  const rogueLead = normalizeAgentCreateRequest(
    {
      config: {
        provider: "nemotron-3-ultra-free",
        cwd: workspace,
        title: "Lead — ai-test",
        labels: { custom: "1" },
      },
    },
    stateDir,
  );
  assert.equal(rogueLead.config.provider, "opencode/opencode/nemotron-3-ultra-free");
  assert.deepEqual(rogueLead.config.labels, { custom: "1", seat: "lead", project: "ai-test-043c7e" });
});

test("choke.onPermissionAsked enforces seat-paseo-tool-fence and denies factory state file writes and plugin-process kills (v0.0.26, ADR 0016)", async (t) => {
  const dir = makeTempDir("choke-v0026-");
  disposeDir(t, dir);
  const workspace = join(dir, "repo");
  const stateDir = join(dir, "state");
  mkdirSync(workspace, { recursive: true });
  const factory = createFactory({ stateDir });
  writeProjectRegistration(stateDir, "repo-123456", {
    root: workspace,
    supervisor: "sup-1",
    lead: "lead-1",
  });
  const choke = createChoke({ factory, homeDir: join(dir, "home") });
  const sent: { agentId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const paseo: PaseoResponderApi = {
    agents: {
      ref(agentId: string) {
        return {
          async respondToPermission({ requestId, response }) {
            sent.push({ agentId, requestId, response });
          },
        };
      },
    },
  };

  // 1. Forbidden raw Paseo/subagent tools denied with seat-paseo-tool-fence
  for (const forbiddenTool of ["create_agent", "send_message", "mcp__paseo__create_agent", "Task", "invoke_subagent"]) {
    await choke.onPermissionAsked(
      {
        agent: { id: "lead-1", cwd: workspace, title: "Lead — repo" },
        request: {
          id: `ask-${forbiddenTool}`,
          provider: "claude",
          name: forbiddenTool,
          kind: "tool",
        },
      },
      paseo,
    );
    assert.equal(sent.at(-1)?.response.behavior, "deny", `${forbiddenTool} must be denied`);
  }

  // 2. paseo_factory MCP tools allowed
  await choke.onPermissionAsked(
    {
      agent: { id: "lead-1", cwd: workspace, title: "Lead — repo" },
      request: {
        id: "ask-paseo-factory-ok",
        provider: "claude",
        name: "mcp__paseo_factory__lead_set_contract",
        kind: "tool",
      },
    },
    paseo,
  );
  assert.equal(sent.at(-1)?.response.behavior, "allow", "paseo_factory MCP tool must be allowed");

  // 3. pkill plugin-process.js denied with process-kill (v0.0.84: its own rule,
  //    not the seat-write-fence message that misdiagnosed the goal-partner Lead)
  await choke.onPermissionAsked(
    {
      agent: { id: "lead-1", cwd: workspace, title: "Lead — repo" },
      request: {
        id: "ask-bad-pkill",
        provider: "claude",
        name: "Bash",
        kind: "tool",
        detail: { type: "shell", command: "pkill -f plugin-process.js", cwd: workspace },
      },
    },
    paseo,
  );
  assert.equal(sent.at(-1)?.response.behavior, "deny", "pkill plugin-process.js must be denied");
  const projectLedger = factoryRegistryFor(stateDir, { root: factory }).factoryForProject("repo-123456").ledger; // v0.0.89: denials land in the owning Project
  const pkillDenied = projectLedger.events.filter((e) => e.event === "permit_denied" && e.rule === "process-kill");
  assert.equal(pkillDenied.length, 1);

  // 4. writes to <stateDir>/ledger.jsonl or mailbox.jsonl denied with seat-write-fence
  for (const badCmd of [
    `echo '{}' >> ${join(stateDir, "ledger.jsonl")}`,
    `rm -f ${join(stateDir, "projects", "repo-123456", "mailbox.jsonl")}`,
  ]) {
    await choke.onPermissionAsked(
      {
        agent: { id: "lead-1", cwd: workspace, title: "Lead — repo" },
        request: {
          id: `ask-bad-${badCmd.slice(0, 8)}`,
          provider: "claude",
          name: "Bash",
          kind: "tool",
          detail: { type: "shell", command: badCmd, cwd: workspace },
        },
      },
      paseo,
    );
    assert.equal(sent.at(-1)?.response.behavior, "deny", `command '${badCmd}' must be denied`);
  }

  const toolFenceEvents = projectLedger.events.filter(
    (e) => e.event === "permit_denied" && e.rule === "seat-paseo-tool-fence",
  );
  assert.equal(toolFenceEvents.length, 5);
});

test("process-kill fires only in command position and carries its own rule (v0.0.84, goal-partner ledger seq 447)", () => {
  // The exact goal-partner seq-447 command: kill words live in --description
  // prose ("Do not use killall/pkill") while the factory.mjs path carries
  // "paseo" — the co-occurrence prefilter hits, the gate must not fire.
  const fixture = readFileSync(join(repoRoot, "test/fixtures/goal-partner-lead-contract-command.txt"), "utf8");

  // Deny vectors: kill word in command position (bare, absolute path, after
  // wrappers/env-assignments, or leading a shell -c payload) — every one
  // carries rule "process-kill" through the seat judge.
  for (const deny of [
    'pkill -9 -f "/Users/andrewpham/.paseo/plugin-process.js"', // the ADR 0016 vector
    "/usr/bin/pkill -f paseo",
    "bash -c 'pkill -f paseo'",
    "bash -lc 'pkill -f paseo'",
    "env bash -c 'pkill -f paseo'",
    "timeout 5 killall Paseo Helper",
    "env A=1 pkill paseo",
    "env FOO=bar nice -n 5 pkill -f plugin-process.js",
    "nohup kill -9 4242 ; tail -n 5 ~/.paseo/daemon.log",
    "pgrep -f paseo | xargs kill",
  ]) {
    assert.equal(isProcessKillAgainstFactory(deny), true, `"${deny}" must fire`);
    const viaJudge = judgeSeatShellCommand(deny, "/tmp/repo", "/tmp/state");
    assert.ok(viaJudge.behavior === "deny" && viaJudge.rule === "process-kill", `"${deny}" must deny with process-kill`);
  }

  // Prose mentions never fire — including the -c triplet quoted inside prose.
  for (const allow of [
    fixture,
    "echo 'Do not use killall/pkill' && ls /Users/andrewpham/.paseo/plugins/paseo-factory",
    "echo 'bash -c pkill' >> /Users/andrewpham/.paseo/notes.txt",
    "git log --oneline | grep kill",
  ]) {
    assert.equal(isProcessKillAgainstFactory(allow), false, "kill words outside command position must not fire");
  }

  // Both judges allow the fixture (the regression that killed the run).
  assert.deepEqual(judgeSeatShellCommand(fixture, "/tmp/repo", "/tmp/state"), { behavior: "allow" });
  const roots = { workspace: "/tmp/repo", stateDir: "/tmp/state", tmp: ["/tmp"], homeDir: "/tmp/home" };
  assert.deepEqual(judgeShellCommand(fixture, roots), { behavior: "allow" });

  // Both judges deny a real kill with the dedicated rule and the Layer-3
  // backstop reason — never SEAT_WRITE_FENCE_MESSAGE.
  const seatDeny = judgeSeatShellCommand('pkill -9 -f "/Users/andrewpham/.paseo/plugin-process.js"', "/tmp/repo", "/tmp/state");
  assert.equal(seatDeny.behavior, "deny");
  assert.ok(seatDeny.behavior === "deny" && seatDeny.rule === "process-kill");
  const agentDeny = judgeShellCommand("pkill -f plugin-process.js", roots);
  assert.ok(agentDeny.behavior === "deny" && agentDeny.rule === "process-kill");
  assert.equal(agentDeny.reason, PROCESS_KILL_FENCE_MESSAGE);
  assert.match(PROCESS_KILL_FENCE_MESSAGE, /Layer-3/);
});

test("choke.onPermissionAsked enforces seat-write-fence and seat-paseo-tool-fence on factory-supervisor / factory-lead provider sessions regardless of title or labels (v0.0.27, ADR 0017 §2)", async (t) => {
  const dir = makeTempDir("choke-provider-seat-");
  disposeDir(t, dir);
  const workspace = join(dir, "repo");
  const stateDir = join(dir, "state");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "probe.txt"), "x\n");
  gitCommitAll(workspace, "base");

  const factory = createFactory({ stateDir });
  const choke = createChoke({ factory, homeDir: "/fake-home" });

  const sent: { agentId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const paseo: PaseoResponderApi = {
    agents: {
      ref(agentId: string) {
        return {
          async respondToPermission({ requestId, response }) {
            sent.push({ agentId, requestId, response });
          },
        };
      },
    },
  };

  // The re-exported recognition map, pinned at the choke seam.
  assert.equal(inferSeatFromProviderId("factory-supervisor"), "supervisor");
  assert.equal(inferSeatFromProviderId("factory-lead"), "lead");
  assert.equal(inferSeatFromProviderId("factory-peer"), "agent");
  assert.equal(inferSeatFromProviderId("opencode/opencode/glm-5.1"), undefined);

  // 1. Provider id alone — an arbitrary natural-language title and empty labels —
  //    denies product-source writes with seat-write-fence.
  for (const [index, provider] of ["factory-supervisor", "factory-lead"].entries()) {
    await choke.onPermissionAsked(
      {
        agent: { id: `picker-${index}`, cwd: workspace, provider, title: "Hãy xây dựng một tựa game 3D", labels: {} },
        request: {
          id: `prov-write-${index}`,
          provider: "opencode",
          name: "Write",
          kind: "tool",
          detail: { type: "write", filePath: "src/GameStore.ts", content: "export const x = 1;\n" },
        },
      },
      paseo,
    );
    const denial = sent.at(-1)?.response;
    assert.equal(denial?.behavior, "deny", `${provider} session denied a product-source write by provider id alone`);
    if (denial?.behavior === "deny") {
      assert.match(denial.message ?? "", /Seat write fence/);
    }
  }
  const seatDenials = factory.ledger.events.filter((e) => e.event === "permit_denied" && e.rule === "seat-write-fence");
  assert.equal(seatDenials.length, 2, "both provider-recognized denials ledger as seat-write-fence");

  // 2. The raw Paseo tool fence holds on a provider-recognized session too.
  await choke.onPermissionAsked(
    {
      agent: { id: "picker-tool", cwd: workspace, provider: "factory-supervisor", title: "anything", labels: {} },
      request: { id: "prov-tool-1", provider: "opencode", name: "mcp__paseo__create_agent", kind: "tool" },
    },
    paseo,
  );
  assert.equal(sent.at(-1)?.response.behavior, "deny", "the raw Paseo agent tool is denied on a factory-supervisor session");
  const toolFence = factory.ledger.events.filter((e) => e.event === "permit_denied" && e.rule === "seat-paseo-tool-fence");
  assert.equal(toolFence.length, 1);

  // 3. resolveSeatAtProjectRoot maps the provider id directly, title and labels aside.
  assert.deepEqual(
    resolveSeatAtProjectRoot(stateDir, { id: "x-lead", cwd: workspace, provider: "factory-lead", title: "nope", labels: {} }),
    { seat: "lead", projectRoot: workspace },
  );
  assert.equal(resolveSeatAtProjectRoot(stateDir, { id: "x-peer", cwd: workspace, provider: "factory-peer", title: "nope", labels: {} }), undefined);

  // 4. OpenCode v2 permission requests omit `detail` and place the shell command or file path in `description`.
  await choke.onPermissionAsked(
    {
      agent: { id: "opencode-v2-sup", cwd: workspace, provider: "factory-supervisor", title: "3D Game", labels: {} },
      request: {
        id: "ocv2-shell-deny",
        provider: "opencode",
        name: "shell",
        kind: "tool",
        description: `cat > ${workspace}/src/seams/IInput.ts << 'EOF'\nexport interface IInput {}\nEOF`,
      },
    },
    paseo,
  );
  assert.equal(sent.at(-1)?.response.behavior, "deny", "OpenCode v2 detail-less shell write to src/** is denied by seat-write-fence");

  // 5. OpenCode v2 interactive `question` forms on the Supervisor seat are left open for the Owner UI (never auto-answered without answers).
  const beforeQuestionCount = sent.length;
  await choke.onPermissionAsked(
    {
      agent: { id: "opencode-v2-sup", cwd: workspace, provider: "factory-supervisor", title: "3D Game", labels: {} },
      request: {
        id: "ocv2-question-1",
        provider: "opencode",
        name: "question",
        kind: "question",
      },
    },
    paseo,
  );
  assert.equal(sent.length, beforeQuestionCount, "Supervisor interactive question form is not auto-answered by choke");
});

test("normalizeAgentCreateRequest rewrites factory seat providers onto the Project's own lane and labels the seat — factory-peer stays canonical (v0.0.27 ADR 0017 §2; v0.0.38 ADR 0026 §1)", (t) => {
  const dir = makeTempDir("choke-normalize-factory-");
  disposeDir(t, dir);
  const workspace = join(dir, "ai-test");
  const stateDir = join(dir, "state");
  mkdirSync(workspace, { recursive: true });

  writeProjectRegistration(stateDir, "ai-test-043c7e", {
    root: workspace,
    supervisor: "sup-1",
    lead: "lead-1",
  });

  // No Lane config named: the Project's effective lane is the safe default —
  // the picker alias resolves onto its runtime provider ID and model, never
  // stays a bare role provider id.
  const sup = normalizeAgentCreateRequest(
    { config: { provider: "factory-supervisor", cwd: workspace, title: "Hãy xây dựng một tựa game 3D" } },
    stateDir,
  );
  assert.equal(sup.config.provider, "pi", "the seat runs the Project's effective supervisor runtime provider");
  assert.equal((sup.config as { model?: string }).model, "zcode/glm-5.3", "the seat runs the Project's effective supervisor model");
  assert.deepEqual(sup.config.labels, { seat: "supervisor", project: "ai-test-043c7e" });
  assert.deepEqual(sup.labels, { seat: "supervisor", project: "ai-test-043c7e" });

  const lead = normalizeAgentCreateRequest({ config: { provider: "factory-lead", cwd: workspace, title: "any message" } }, stateDir);
  assert.equal(lead.config.provider, "pi");
  assert.equal((lead.config as { model?: string }).model, "zcode/glm-5.3");
  assert.deepEqual(lead.config.labels, { seat: "lead", project: "ai-test-043c7e" });

  // factory-peer is a working-agent provider, not a seat-fence seat — no
  // rewrite, no labels; the id stays canonical.
  const peer = normalizeAgentCreateRequest({ config: { provider: "factory-peer", cwd: workspace } }, stateDir);
  assert.equal(peer.config.provider, "factory-peer");
  assert.equal(peer.config.labels, undefined);
  assert.equal(peer.labels, undefined);

  // A cwd that names no Project (nothing registered, nothing on disk) keeps
  // the canonical role provider id — never a guess.
  const nowhere = normalizeAgentCreateRequest(
    { config: { provider: "factory-supervisor", cwd: join(dir, "no-such-directory") } },
    stateDir,
  );
  assert.equal(nowhere.config.provider, "factory-supervisor");
  assert.equal(nowhere.config.labels, undefined);
});

test("Seam 2: a factory-supervisor create rewrites onto Project A's supervisor provider + model in Project A and Project B's in Project B — with thinking set from the lane and stale thinkingOptionId stripped (v0.0.38, ADR 0026 §1)", (t) => {
  const dir = makeTempDir("choke-project-rewrite-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const projectA = join(dir, "project-a");
  const projectB = join(dir, "project-b");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeProjectRegistration(stateDir, "project-a-111111", { root: projectA });
  writeProjectRegistration(stateDir, "project-b-222222", { root: projectB });
  // The spec's Project matrix: A runs claude for its Supervisor, B runs codex.
  saveLanes(stateDir, { supervisor: "claude/claude-opus-4-6:high", lead: "codex/gpt-5.4:high", worker: "opencode/glm-5.1" }, "project-a-111111");
  saveLanes(stateDir, { supervisor: "codex/gpt-5.4", lead: "claude/claude-sonnet-4-6", worker: "claude/claude-sonnet-4-6" }, "project-b-222222");

  const inA = normalizeAgentCreateRequest(
    { config: { provider: "factory-supervisor", cwd: projectA, title: "Ship the game", thinkingOptionId: "medium" } },
    stateDir,
  );
  assert.equal(inA.config.provider, "claude", "Project A's supervisor runtime provider wins inside Project A");
  assert.equal((inA.config as { model?: string }).model, "claude-opus-4-6", "Project A's supervisor model wins inside Project A");
  assert.equal(inA.config.thinkingOptionId, "high", "the lane's thinking level rides the rewrite");
  assert.deepEqual(inA.config.labels, { seat: "supervisor", project: "project-a-111111" });

  const inB = normalizeAgentCreateRequest(
    { config: { provider: "factory-supervisor", cwd: projectB, title: "Ship the game", thinkingOptionId: "high" } },
    stateDir,
  );
  assert.equal(inB.config.provider, "codex", "the SAME picker entry resolves Project B's own supervisor runtime provider inside Project B");
  assert.equal((inB.config as { model?: string }).model, "gpt-5.4", "the SAME picker entry resolves Project B's own supervisor model inside Project B");
  assert.equal("thinkingOptionId" in inB.config, false, "the lane names no thinking level — the stale option naming the role provider's model never survives");
  assert.deepEqual(inB.config.labels, { seat: "supervisor", project: "project-b-222222" });

  const leadInA = normalizeAgentCreateRequest({ config: { provider: "factory-lead", cwd: projectA } }, stateDir);
  assert.equal(leadInA.config.provider, "codex");
  assert.equal((leadInA.config as { model?: string }).model, "gpt-5.4");
  assert.equal(leadInA.config.thinkingOptionId, "high");
  assert.deepEqual(leadInA.config.labels, { seat: "lead", project: "project-a-111111" });

  // The advertised catalog sanitizes the lane's thinking: a model whose
  // thinkingOptions exclude the lane's level lands without it.
  const catalog = [
    {
      provider: "claude",
      models: [{ id: "claude-opus-4-6", label: "Opus", thinkingOptions: [{ id: "medium", label: "Medium" }] }],
    },
  ];
  const sanitized = normalizeAgentCreateRequest(
    { config: { provider: "factory-supervisor", cwd: projectA } },
    { stateDir, providers: catalog },
  );
  assert.equal(sanitized.config.provider, "claude");
  assert.equal((sanitized.config as { model?: string }).model, "claude-opus-4-6");
  assert.equal("thinkingOptionId" in sanitized.config, false, "an unadvertised :high is stripped against thinkingOptions");

  // Antigravity plugin provider lane rewrites to runtime provider "antigravity" and model "gemini-3.1-pro-high".
  saveLanes(stateDir, { supervisor: "antigravity/gemini-3.1-pro-high" }, "project-a-111111");
  const agyInA = normalizeAgentCreateRequest(
    { config: { provider: "factory-supervisor", cwd: projectA, model: "zai/glm-5.3" } },
    stateDir,
  );
  assert.equal(agyInA.config.provider, "antigravity");
  assert.equal((agyInA.config as { model?: string }).model, "gemini-3.1-pro-high");
});

test("a legacy zcode lane's seat rewrite migrates onto pi/zcode/<model> and carries the runtime model id (ADR 0055)", (t) => {
  const dir = makeTempDir("choke-zcode-model-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const project = join(dir, "project-z");
  mkdirSync(project, { recursive: true });
  writeProjectRegistration(stateDir, "project-z-333333", { root: project });
  // Legacy zcode/* lanes migrate transparently to pi/zcode/<lowercase-model>[:<thinking>].
  saveLanes(stateDir, { supervisor: "zcode/GLM-5.3:high", lead: "zcode/GLM-5.3-Flash:medium", worker: "zcode/GLM-5.3:high" }, "project-z-333333");

  const sup = normalizeAgentCreateRequest(
    { config: { provider: "factory-supervisor", cwd: project, title: "Ship the game" } },
    stateDir,
  );
  assert.equal(sup.config.provider, "pi", "the migrated pi base provider id rides the rewrite");
  assert.equal((sup.config as { model?: string }).model, "zcode/glm-5.3", "the legacy zcode lane model is migrated to pi/zcode/glm-5.3");
  assert.equal(sup.config.thinkingOptionId, "high", "the lane's effort suffix maps onto thinkingOptionId");

  const lead = normalizeAgentCreateRequest({ config: { provider: "factory-lead", cwd: project } }, stateDir);
  assert.equal(lead.config.provider, "pi");
  assert.equal((lead.config as { model?: string }).model, "zcode/glm-5.3-flash");
  assert.equal(lead.config.thinkingOptionId, "medium");

  // Legacy explicit "zcode/builtin:zai-coding-plan\GLM-5.3:high" also migrates cleanly to pi/zcode/glm-5.3:high.
  saveLanes(stateDir, { supervisor: "zcode/builtin:zai-coding-plan\\GLM-5.3:high" }, "project-z-333333");
  const explicit = normalizeAgentCreateRequest({ config: { provider: "factory-supervisor", cwd: project } }, stateDir);
  assert.equal(explicit.config.provider, "pi");
  assert.equal((explicit.config as { model?: string }).model, "zcode/glm-5.3", "an explicit legacy runtime id migrates to zcode/glm-5.3");
  assert.equal(explicit.config.thinkingOptionId, "high");
});





test("OpenCode delegates installed bare package shims while other providers and unsafe shell forms retain Layer-2 denials", async (t) => {
  const dir = makeTempDir("choke-opencode-shims-");
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const factory = createFactory({ stateDir: join(dir, "state") });
  ensureGitShim(factory.stateDir, join(repoRoot, "plugin"), process.execPath);
  const choke = createChoke({ factory, homeDir: "/fake-home" });
  const responses: AgentPermissionResponse[] = [];
  const paseo: PaseoResponderApi = { agents: { ref: () => ({ respondToPermission: async ({ response }) => { responses.push(response); } }) } };
  const ask = async (provider: string, command: string) => {
    await choke.onPermissionAsked({
      agent: { id: "seat", cwd: workspace, provider, labels: { seat: "supervisor" } },
      request: { id: "ask", provider, name: "Bash", kind: "tool", detail: { type: "shell", command, cwd: workspace } },
    }, paseo);
    return responses.at(-1)!;
  };
  for (const command of ["npm install", "npx vite", "git status --short && npm install", "npm install | npm test"]) {
    assert.equal((await ask("opencode/mimo-v2-pro-free", command)).behavior, "allow", command);
  }
  assert.equal(factory.ledger.events.filter((event) => event.event === "permit_denied").length, 0);
  const earlierBin = join(dir, "earlier-bin");
  mkdirSync(earlierBin);
  writeFileSync(join(earlierBin, "npm"), "#!/bin/sh\necho UNSHIMMED\nexit 0\n", { mode: 0o755 });
  const factoryBin = join(factory.stateDir, "bin");
  const launch = injectClaimCliPath({
    agentId: "seat", workspaceId: null, provider: "opencode", cwd: workspace,
    reason: "create", purpose: "interactive", title: null, labels: {}, tools: [], mcpServers: {},
    env: { PATH: [earlierBin, factoryBin, "/usr/bin", factoryBin].join(delimiter) },
  }, factoryBin);
  const refused = spawnSync("/bin/sh", ["-c", "npm install"], {
    cwd: workspace, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, ...launch.env, PASEO_FACTORY_SEAT: "supervisor" },
  });
  assert.equal(refused.status, 126);
  startGitBlockIngestion(factory).stop();
  startGitBlockIngestion(factory).stop();
  assert.equal(factory.ledger.events.filter((event) => event.event === "git_blocked").length, 1, "delegated refusal is ingested exactly once, including after restart");
  for (const provider of ["claude", "codex", "pi", "copilot", "omp", "antigravity"]) {
    const response = await ask(provider, "npm install");
    assert.equal(response.behavior, "deny", provider);
    if (response.behavior === "deny") assert.match(response.message ?? "", /Seat write fence/);
  }
  for (const command of [
    "npm install > foo.txt", "npm install; rm -rf src", "/usr/bin/npm install", "/usr/bin/git commit -m x; npm install",
    "npm install $(touch src/a)", "npm install `touch src/a`", "PATH=/usr/bin npm install", "env npm install",
    "npm install; git -c alias.mutate='!touch src/a' mutate", "npm install; git --exec-path=/tmp status",
    "npm install; node -e 'require(\"fs\").writeFileSync(\"src/a\",\"x\")'", "npm install & touch src/a",
  ]) assert.equal((await ask("opencode", command)).behavior, "deny", command);
  rmSync(join(factory.stateDir, "bin", "npm"));
  assert.equal((await ask("opencode", "npm install")).behavior, "deny", "missing shim is never delegated");
});


test("native factory seats use their configured provider family before delegating shell refusals", async (t) => {
  const dir = makeTempDir("choke-native-opencode-");
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  ensureGitShim(factory.stateDir, join(repoRoot, "plugin"), process.execPath);
  const projectDir = join(factory.stateDir, "projects", "example");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(factory.stateDir, "lanes.json"), JSON.stringify({ lead: "pi/zai/glm-5.3" }));
  writeFileSync(join(projectDir, "lanes.json"), JSON.stringify({ lead: "opencode/opencode/mimo-v2-pro-free" }));
  const choke = createChoke({ factory, homeDir: "/fake-home" });
  const responses: AgentPermissionResponse[] = [];
  const paseo: PaseoResponderApi = { agents: { ref: () => ({ respondToPermission: async ({ response }) => { responses.push(response); } }) } };
  const ask = async () => choke.onPermissionAsked({
    agent: { id: "native-lead", cwd: dir, provider: "factory-lead", labels: { project: "example" } },
    request: { id: "ask", provider: "factory-lead", name: "bash", kind: "tool", description: "npm install" },
  }, paseo);
  await ask();
  assert.equal(responses.at(-1)?.behavior, "allow", "project lane resolves native factory role to OpenCode");
  writeFileSync(join(projectDir, "lanes.json"), JSON.stringify({ lead: "codex/gpt-5" }));
  await ask();
  assert.equal(responses.at(-1)?.behavior, "deny", "native role on a non-OpenCode lane keeps Layer-2 refusal");
});

test("OpenCode orchestration seats deny isolated explicit-path git writes while other providers retain their policy", async (t) => {
  const dir = makeTempDir("choke-opencode-explicit-git-");
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const factory = createFactory({ stateDir: join(dir, "state") });
  ensureGitShim(factory.stateDir, join(repoRoot, "plugin"), process.execPath);
  const choke = createChoke({ factory, homeDir: "/fake-home" });
  const responses: AgentPermissionResponse[] = [];
  const paseo: PaseoResponderApi = { agents: { ref: () => ({ respondToPermission: async ({ response }) => { responses.push(response); } }) } };
  const ask = async (seat: "lead" | "supervisor", provider: string, command: string) => {
    await choke.onPermissionAsked({
      agent: { id: "seat", cwd: workspace, provider, labels: { seat } },
      request: { id: "ask", provider, name: "Bash", kind: "tool", detail: { type: "shell", command, cwd: workspace } },
    }, paseo);
    return responses.at(-1)!;
  };
  for (const seat of ["supervisor", "lead"] as const) {
    for (const command of ["/usr/bin/git commit -m x", "./tools/git -C /repo merge feature"]) {
      const response = await ask(seat, "opencode", command);
      assert.equal(response.behavior, "deny", `${seat}: ${command}`);
      if (response.behavior === "deny") {
        assert.match(response.message ?? "", /Seat write fence/);
        assert.match(response.message ?? "", seat === "supervisor" ? /supervisor_dispatch_lead/ : /lead_set_contract.*lead_spawn_agent/);
      }
      for (const provider of ["claude", "codex", "pi", "copilot", "omp", "antigravity"]) {
        assert.equal((await ask(seat, provider, command)).behavior, "allow", `${provider} retains existing explicit-path policy`);
      }
    }
    for (const command of ["git commit -m x", "git status --short", "/usr/bin/git status --short"]) {
      assert.equal((await ask(seat, "opencode", command)).behavior, "allow", `${seat}: ${command} retains existing policy`);
    }
  }
});

test("ADR 0028 §5: judgeShellCommand blocks git checkout/restore working-tree discard on <project-root> but permits it inside isolated Task worktrees", () => {
  const rootWorkspace = { workspace: "/ws/project", stateDir: "/state/factory", homeDir: "/home/u", tmp: ["/tmp"] };
  const worktreeWorkspace = {
    workspace: "/state/factory/projects/proj-123/worktrees/T-01",
    stateDir: "/state/factory",
    homeDir: "/home/u",
    tmp: ["/tmp"],
  };

  for (const cmd of ["git checkout -- src/main.ts", "git restore src/main.ts", "git checkout ."]) {
    assert.equal(judgeShellCommand(cmd, rootWorkspace).behavior, "deny", `${cmd} denied on <project-root>`);
    assert.equal(
      judgeShellCommand(cmd, worktreeWorkspace, { workspace: "/ws/project", worktree: worktreeWorkspace.workspace }).behavior,
      "allow",
      `${cmd} allowed inside isolated Task worktree`,
    );
  }
  // Destructive history/remote commands remain denied even inside an isolated Task worktree
  for (const dangerous of ["git reset --hard HEAD~1", "git push --force", "git clean -fd"]) {
    assert.equal(
      judgeShellCommand(dangerous, worktreeWorkspace, { workspace: "/ws/project", worktree: worktreeWorkspace.workspace }).behavior,
      "deny",
      `${dangerous} remains denied in Task worktree`,
    );
  }
});

test("coordination seats permit MCP stdio npx launches while refusing general package execution", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  mkdirSync(workspace);
  const factory = createFactory({ stateDir: join(dir, "state") });
  const choke = createChoke({ factory, homeDir: dir });
  const commands = ["chrome-devtools-mcp", "@notionhq/notion-mcp-server", "@z_ai/mcp-server", "@upstash/context7-mcp", "@modelcontextprotocol/server-filesystem@latest", "mcp-demo", "demo-mcp-server", "zcode-acp-server@0.82.1", "glm-acp-agent@1.3.0", "paseo-agy-acp@2.4.0"];
  for (const seat of ["supervisor", "lead"] as const) {
    for (const pkg of [...commands, "create-vite@latest", "tsx script.ts"]) {
      let behavior: string | undefined;
      await choke.onPermissionAsked({
        agent: { id: seat, cwd: workspace, provider: "pi", labels: { seat } },
        request: { id: pkg, provider: "pi", name: "Bash", kind: "tool", detail: { type: "shell", command: `npx -y ${pkg}`, cwd: workspace } },
      }, { agents: { ref: () => ({ respondToPermission: async ({ response }) => { behavior = response.behavior; } }) } });
      assert.equal(behavior, commands.includes(pkg) ? "allow" : "deny", `${seat}: ${pkg}`);
    }
  }
});

test("git_blocked ingestion attributes only contracted Peer worktree commands to a Task", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  const worktree = join(dir, "task-worktree");
  mkdirSync(workspace);
  mkdirSync(worktree);
  const factory = createFactory({ stateDir: join(dir, "state") });
  writeFileSync(join(workspace, "README.md"), "test");
  gitCommitAll(workspace);
  factory.setContract({ task: "telemetry", workspace, gate: "true" });
  factory.requestSpawn({ task: "telemetry", provider: "pi/model", arity: 1, worktree });
  const records = [
    { cwd: workspace, rule: "seat-write-fence" },
    { cwd: workspace, rule: "dangerous-git" },
    { cwd: worktree, rule: "seat-write-fence" },
    { cwd: worktree, rule: "supervisor-git-fence" },
    { cwd: worktree, rule: "lead-git-fence" },
    { cwd: worktree, rule: "dangerous-git" },
  ].map((record, index) => ({ ...record, id: String(index), command: "blocked", reason: "test" }));
  writeFileSync(join(factory.stateDir, "git-blocked.log"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  startGitBlockIngestion(factory).stop();
  startGitBlockIngestion(factory).stop();
  const blocks = factory.ledger.events.filter(event => event.event === "git_blocked");
  assert.equal(blocks.length, 6);
  assert.deepEqual(blocks.map(event => event.task), [undefined, undefined, undefined, undefined, undefined, "telemetry"]);
});

test("v0.0.58 reset scrubs refusal sources permanently while preserving other Projects", (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const workspace = join(dir, "target"); mkdirSync(workspace);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  const records = [
    { id: "target", cwd: workspace },
    { id: "not-yet-ingested", cwd: join(stateDir, "projects", "target", "worktrees", "old") },
    { id: "neighbor", cwd: join(dir, "neighbor") },
  ].map(record => ({ ...record, command: "git push", rule: "push", reason: "blocked" }));
  writeFileSync(join(stateDir, "git-blocked.log"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  startGitBlockIngestion(factory).stop();
  factory.resetProject(workspace, "target");
  const restarted = createFactory({ stateDir });
  startGitBlockIngestion(restarted).stop();
  assert.deepEqual(restarted.ledger.events.filter(event => event.event === "git_blocked").map(event => event.blockId), ["neighbor"]);
});

test("Copilot/ACP apply_patch edit asks extract target file paths instead of judging the literal 'apply_patch' tool title", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  const engineerTree = join(dir, "state", "projects", "goal-planner", "worktrees", "eng-spec");
  const architectTree = join(dir, "state", "projects", "goal-planner", "worktrees", "arch-spec");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(engineerTree, { recursive: true });
  mkdirSync(architectTree, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "init\n");
  gitCommitAll(workspace);

  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "eng-spec", workspace, gate: "true", artifact: ".scratch/init/architecture.md", scope: [".scratch/init/architecture.md"] });
  factory.requestSpawn({ task: "eng-spec", provider: "copilot/gpt-6-sol:high", arity: 1, worktree: engineerTree });
  // The read-only architect disposition (ADR 0053 §3): no gate, no scope — every write under its tree is fenced.
  factory.setContract({ task: "arch-spec", workspace, gate: "", disposition: "architect" });
  factory.requestSpawn({ task: "arch-spec", provider: "copilot/gpt-6-sol:high", arity: 1, worktree: architectTree });

  const choke = createChoke({ factory, homeDir: dir });
  const applyPatchAsk = (tree: string, id: string, patch: string): never => ({
    agent: { id: `agent-${id}`, cwd: tree, provider: "copilot" },
    request: {
      id,
      provider: "copilot",
      name: "edit",
      title: "apply_patch",
      kind: "tool",
      // The adapter's `detail.filePath` fell back to the literal tool title.
      detail: { type: "edit", filePath: "apply_patch" },
      metadata: {
        toolCallId: `call-${id}`,
        rawRequest: { toolCall: { toolCallId: `call-${id}`, title: "apply_patch", kind: "edit", rawInput: patch } },
      },
    },
  }) as never;
  const respond = (sink: { behavior?: string }) => ({ agents: { ref: () => ({ respondToPermission: async ({ response }: { response: { behavior: string } }) => { sink.behavior = response.behavior; } }) } });

  // 1) An engineer Peer's in-scope write through apply_patch is allowed.
  const allowed: { behavior?: string } = {};
  await choke.onPermissionAsked(applyPatchAsk(engineerTree, "req-allow", "*** Begin Patch\n*** Add File: .scratch/init/architecture.md\n+# Architecture\n"), respond(allowed));
  assert.equal(allowed.behavior, "allow");

  // 2) The read-only architect's apply_patch is judged on the extracted path, not the literal title — and denied by the disposition fence.
  const denied: { behavior?: string } = {};
  await choke.onPermissionAsked(applyPatchAsk(architectTree, "req-deny", "*** Begin Patch\n*** Add File: src/index.ts\n+export const x = 1;\n"), respond(denied));
  assert.equal(denied.behavior, "deny");
  const lastEvent = factory.ledger.events.at(-1);
  assert.equal(lastEvent?.event, "permit_denied");
  if (lastEvent?.event === "permit_denied") {
    assert.equal(lastEvent.rule, "read-only-disposition-fence");
    assert.equal(lastEvent.command, "src/index.ts");
  }

  // 3) A shell command with 2>&1 fd redirection is not treated as writing to a file named "&1".
  const roots = writableRootsFor(architectTree, factory.stateDir, dir);
  const fdDecision = judgeShellCommand("node script.js 2>&1 | head -20", roots, { workspace, worktree: architectTree, scope: [], disposition: "architect" });
  assert.equal(fdDecision.behavior, "allow");
});

test("worktree test-process signals pass ask-time policy while daemon targets remain denied", () => {
  const worktree = "/Users/owner/.paseo/plugin-state/paseo-factory/projects/demo/worktrees/T-04";
  const roots = { workspace: "/tmp/repo", stateDir: "/Users/owner/.paseo/plugin-state/paseo-factory", tmp: ["/tmp"], homeDir: "/Users/owner" };
  for (const command of [`pkill -f ${worktree}`, `killall ${worktree}/test-server`, `bash -c 'pkill -f ${worktree}'`]) {
    assert.deepEqual(judgeShellCommand(command, roots), { behavior: "allow" }, command);
    assert.deepEqual(judgeSeatShellCommand(command, roots.workspace, roots.stateDir), { behavior: "allow" }, command);
  }
  for (const command of [`pkill -f ${worktree}/bridge.mjs`, `pkill -f ${worktree}; pkill paseo`, `bash -c 'pkill -f ${worktree}; pkill paseo'`, `pkill -f ${worktree} paseo`]) {
    assert.equal(judgeShellCommand(command, roots).behavior, "deny", command);
  }
});
