import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { createFactory } from "../plugin/server/core/factory.ts";
import { writeProjectRegistration } from "../plugin/server/core/project.ts";
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
import { isSeatMemoryPathAllowed, judgeFilePath, judgeShellCommand, refuseGitArgv, shellTokens, writableRootsFor } from "../src/choke.ts";
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

  const deniedEvents = factory.ledger.events
    .filter((e) => e.event === "permit_denied")
    .filter((e) => e.agent === "chat-session-7c5ac02");
  assert.equal(deniedEvents.length, 2);
  assert.equal(deniedEvents[0]?.rule, "seat-write-fence");
  assert.equal(deniedEvents[1]?.rule, "seat-write-fence");
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

  // 3. pkill plugin-process.js and writes to <stateDir>/ledger.jsonl or mailbox.jsonl denied with seat-write-fence
  for (const badCmd of [
    "pkill -f plugin-process.js",
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

  const toolFenceEvents = factory.ledger.events.filter(
    (e) => e.event === "permit_denied" && e.rule === "seat-paseo-tool-fence",
  );
  assert.equal(toolFenceEvents.length, 5);
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

test("normalizeAgentCreateRequest keeps factory role provider ids canonical and labels provider-recognized seats at a registered <project-root> (v0.0.27, ADR 0017 §2)", (t) => {
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

  const sup = normalizeAgentCreateRequest(
    { config: { provider: "factory-supervisor", cwd: workspace, title: "Hãy xây dựng một tựa game 3D" } },
    stateDir,
  );
  assert.equal(sup.config.provider, "factory-supervisor", "the role provider id is never prefixed as a bare model");
  assert.deepEqual(sup.config.labels, { seat: "supervisor", project: "ai-test-043c7e" });
  assert.deepEqual(sup.labels, { seat: "supervisor", project: "ai-test-043c7e" });

  const lead = normalizeAgentCreateRequest({ config: { provider: "factory-lead", cwd: workspace, title: "any message" } }, stateDir);
  assert.equal(lead.config.provider, "factory-lead");
  assert.deepEqual(lead.config.labels, { seat: "lead", project: "ai-test-043c7e" });

  // factory-peer is a working-agent provider, not a seat-fence seat — no labels
  // attached, and the id stays canonical.
  const peer = normalizeAgentCreateRequest({ config: { provider: "factory-peer", cwd: workspace } }, stateDir);
  assert.equal(peer.config.provider, "factory-peer");
  assert.equal(peer.config.labels, undefined);
  assert.equal(peer.labels, undefined);
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
    reason: "create", purpose: "interactive",
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
