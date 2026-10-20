import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createChoke } from "../plugin/server/choke.ts";
import type { PaseoResponderApi } from "../plugin/server/choke.ts";
import { isSeatMemoryPathAllowed, judgeFilePath, judgeShellCommand, refuseGitArgv, shellTokens, writableRootsFor } from "../src/choke.ts";
import { GIT_ARGV_CASES, SHELL_CASES, shellRoots } from "./choke-cases.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

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



