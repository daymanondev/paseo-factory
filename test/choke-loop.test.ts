import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createChoke, gitBlockLogPath, startGitBlockIngestion } from "../plugin/server/choke.ts";
import type { PaseoResponderApi, PermissionAskedEvent } from "../plugin/server/choke.ts";
import { disposeDir, factoryErrorCode, gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * The choke loop, hermetic: the real factory on a temp state dir, the real
 * policy underneath, and a FAKE agent handle shaped exactly like the SDK call
 * path (`paseo.agents.ref(id).respondToPermission`) — no live daemon, no live
 * git. What is asserted: the contracted-agent scope rule, the ledger line per
 * judged ask, the answer the agent receives, the create-time mode pin, the
 * spool's synthetic ask, and the git-block ingestion with its exactly-once
 * dedupe across plugin lifetimes.
 */

interface Sent {
  agentId: string;
  requestId: string;
  response: AgentPermissionResponse;
}

/** The fake daemon side: every respondToPermission call is recorded, never errors. */
function fakePaseo(): { api: PaseoResponderApi; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    api: {
      agents: {
        ref(agentId: string) {
          return {
            async respondToPermission(options: { requestId: string; response: AgentPermissionResponse }) {
              sent.push({ agentId, requestId: options.requestId, response: options.response });
            },
          };
        },
      },
    },
  };
}

interface Stage {
  dir: string;
  workspace: string;
  factory: ReturnType<typeof createFactory>;
  choke: ReturnType<typeof createChoke>;
  paseo: { api: PaseoResponderApi; sent: Sent[] };
  ask: (event: { cwd?: string; agent?: { id: string }; request: AgentPermissionRequest }) => Promise<void>;
}

function shellRequest(id: string, command: string): AgentPermissionRequest {
  return { id, provider: "claude", name: "Bash", kind: "tool", detail: { type: "shell", command, cwd: "/ws" } };
}

function stage(t: TestContext): Stage {
  const dir = makeTempDir("choke-loop-test-");
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "probe.txt"), "x\n");
  gitCommitAll(workspace, "base");
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "T1", workspace, gate: "true", artifact: "probe.txt" });
  const paseo = fakePaseo();
  // A fake home OUTSIDE the real $TMPDIR tree: TMPDIR is legitimately writable,
  // and this suite's temp dirs sit inside it — a home there would make every
  // "outside" path accidentally inside.
  const choke = createChoke({ factory, homeDir: "/fake-home", onLog: () => {} });
  return {
    dir,
    workspace,
    factory,
    choke,
    paseo,
    ask: async ({ cwd, request, agent }) =>
      choke.onPermissionAsked(
        { agent: { id: agent?.id ?? "agent-1", cwd: cwd ?? workspace }, request: request as AgentPermissionRequest },
        paseo.api,
      ),
  };
}

test("a contracted agent's dangerous shell ask: one permit_denied line, a deny answer that teaches", async (t) => {
  const s = stage(t);
  await s.ask({ request: shellRequest("r1", "git push --force origin main") });

  const events = s.factory.ledger.eventsFor("T1");
  assert.deepEqual(events.filter((e) => e.event !== "contract_set").map((e) => e.event), ["permit_denied"]);
  const denied = events.find((e) => e.event === "permit_denied")!;
  assert.equal(denied.agent, "agent-1");
  assert.equal(denied.name, "Bash");
  assert.equal(denied.kind, "tool");
  assert.equal(denied.command, "git push --force origin main");
  assert.equal(denied.rule, "policy:S1-git-vocabulary");

  assert.equal(s.paseo.sent.length, 1);
  const sent = s.paseo.sent[0]!;
  assert.equal(sent.agentId, "agent-1");
  assert.equal(sent.requestId, "r1");
  assert.equal(sent.response.behavior, "deny");
  assert.equal(sent.response.interrupt, false, "the agent stays live and can adapt");
  assert.match(sent.response.message ?? "", /choke: /);
  assert.match(sent.response.message ?? "", /force/);
});

test("a benign ask from the same agent: allowed, answered, and counted", async (t) => {
  const s = stage(t);
  await s.ask({ request: shellRequest("r1", "npm test > /tmp/out.txt 2>&1") });
  await s.ask({ request: shellRequest("r2", "git status --short") });

  const events = s.factory.ledger.eventsFor("T1").filter((e) => e.event !== "contract_set");
  assert.deepEqual(events.map((e) => e.event), ["permit_allowed", "permit_allowed"]);
  assert.equal(s.paseo.sent.length, 2);
  assert.ok(s.paseo.sent.every((x) => x.response.behavior === "allow"));
});

test("the write/edit rider: a Write ask aimed at ~/.ssh denies on the file rule", async (t) => {
  const s = stage(t);
  await s.ask({
    request: {
      id: "r1",
      provider: "claude",
      name: "Write",
      kind: "tool",
      detail: { type: "write", filePath: "~/.ssh/authorized_keys", content: "x" },
    },
  });
  const denied = s.factory.ledger.eventsFor("T1").find((e) => e.event === "permit_denied");
  assert.equal(denied?.rule, "policy:file-write-outside-writable");
  assert.equal(denied?.command, "~/.ssh/authorized_keys", "the event names the aimed-at file");
  assert.equal(s.paseo.sent[0]?.response.behavior, "deny");
});

test("asks with no shell line and no file target (plan/question/read) default-allow with a line", async (t) => {
  const s = stage(t);
  await s.ask({ request: { id: "r1", provider: "claude", name: "AskFollowupQuestion", kind: "question" } });
  await s.ask({ request: { id: "r2", provider: "claude", name: "Read", kind: "tool", detail: { type: "read", filePath: "/home/.ssh/config" } } });

  const events = s.factory.ledger.eventsFor("T1").filter((e) => e.event !== "contract_set");
  assert.deepEqual(events.map((e) => e.event), ["permit_allowed", "permit_allowed"], "reads anywhere are legitimate");
  assert.ok(s.paseo.sent.every((x) => x.response.behavior === "allow"));
});

test("an uncontracted cwd is not the factory's ask: no line, no answer", async (t) => {
  const s = stage(t);
  await s.ask({ cwd: join(s.dir, "elsewhere"), request: shellRequest("r1", "git push --force origin main") });

  assert.deepEqual(
    s.factory.ledger.eventsFor("T1").filter((e) => e.event !== "contract_set"),
    [],
  );
  assert.equal(s.paseo.sent.length, 0, "the daemon's own operator flow stays untouched");
});

test("acceptance retires the contract: later asks in that workspace go unanswered", async (t) => {
  const s = stage(t);
  s.factory.ledger.append({ event: "attempt_accepted", task: "T1", attempt: 1 });
  await s.ask({ request: shellRequest("r1", "git push --force origin main") });
  assert.equal(s.paseo.sent.length, 0);
});

test("a responder failure is loud but never fatal — the line landed, the ask stays pending", async (t) => {
  const dir = makeTempDir("choke-loop-test-");
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "probe.txt"), "x\n");
  gitCommitAll(workspace, "base");
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "T1", workspace, gate: "true", artifact: "probe.txt" });
  const logs: string[] = [];
  const choke = createChoke({ factory, homeDir: "/fake-home", onLog: (m) => logs.push(m) });
  const broken: PaseoResponderApi = {
    agents: {
      ref() {
        return {
          async respondToPermission() {
            throw new Error("daemon gone");
          },
        };
      },
    },
  };
  await choke.onPermissionAsked(
    { agent: { id: "agent-1", cwd: workspace }, request: shellRequest("r1", "git clean -fd") },
    broken,
  );
  assert.equal(factory.ledger.eventsFor("T1").filter((e) => e.event === "permit_denied").length, 1, "the audit line is written before the act");
  assert.ok(logs.some((l) => l.includes("could not answer")), "the failure is logged loudly");
});

test("pinCreateMode forces Always Ask for contracted creates and touches nothing else", (t) => {
  const s = stage(t);
  const pinned = s.choke.pinCreateMode({ provider: "claude", cwd: s.workspace, modeId: "bypassPermissions" });
  assert.equal(pinned?.modeId, "default", "the claude catalog's Always-Ask mode");
  assert.equal(pinned?.cwd, s.workspace, "only the mode changes — cwd is frozen by the daemon anyway");

  const alreadyDefault = s.choke.pinCreateMode({ provider: "claude", cwd: s.workspace, modeId: "default" });
  assert.equal(alreadyDefault, undefined, "no rewrite when it changes nothing");

  const outside = s.choke.pinCreateMode({ provider: "claude", cwd: join(s.dir, "elsewhere"), modeId: "auto" });
  assert.equal(outside, undefined, "uncontracted agents are not the choke's business");
});

test("the spool's synthetic ask judges through the same policy and ledger", (t) => {
  const s = stage(t);
  const denied = s.choke.spoolAskHandler({ id: "q1", kind: "ask", task: "T1", command: "bash -c 'git push --force origin main'", cwd: s.workspace, agent: "bypass-battery" });
  assert.equal(denied.ok, true);
  if (denied.ok) {
    assert.equal(denied.decision, "denied");
    assert.equal(denied.rule, "policy:S1-git-vocabulary");
  }
  const recorded = s.factory.ledger.eventsFor("T1").find((e) => e.event === "permit_denied");
  assert.equal(recorded?.agent, "bypass-battery");

  const allowed = s.choke.spoolAskHandler({ id: "q2", kind: "ask", task: "T1", command: "git status", cwd: s.workspace });
  assert.equal(allowed.ok && allowed.decision, "allowed");
  assert.equal(s.factory.ledger.eventsFor("T1").filter((e) => e.event === "permit_allowed").length, 1);

  assert.throws(() => s.choke.spoolAskHandler({ id: "q3", kind: "ask", task: "nope", command: "x" }), withCode("unknown-task"));
  assert.throws(
    () => s.choke.spoolAskHandler({ id: "q4", kind: "ask", task: "T1", command: "x", cwd: join(s.dir, "elsewhere") }),
    withCode("not-contracted"),
  );
});

test("the memory write fence answers contracted asks: AGENTS.md writes deny unless the Contract scopes the file (v0.0.14)", async (t) => {
  const s = stage(t); // T1's contract: no scope — unrestricted code edits, fenced memory files

  // A write/edit tool ask at the workspace root memory file.
  await s.ask({
    request: {
      id: "m1",
      provider: "claude",
      name: "Write",
      kind: "tool",
      detail: { type: "write", filePath: "AGENTS.md", content: "# poisoned rule\n" },
    },
  });
  const denied = s.factory.ledger.eventsFor("T1").find((e) => e.event === "permit_denied")!;
  assert.equal(denied.rule, "policy:memory-write-fenced");
  assert.equal(denied.command, "AGENTS.md", "the line names what was aimed at");
  assert.equal(s.paseo.sent[0]?.response.behavior, "deny");

  // A shell ask through the same fence — the synthetic spool path too.
  const spoolDenied = s.choke.spoolAskHandler({ id: "m2", kind: "ask", task: "T1", command: "echo rule >> CLAUDE.md", cwd: s.workspace, agent: "bypass-battery" });
  assert.equal(spoolDenied.ok && spoolDenied.decision, "denied");
  assert.equal(spoolDenied.ok ? spoolDenied.rule : undefined, "policy:memory-write-fenced");

  // Ordinary code edits in the same workspace stay allowed — the fence is the
  // only thing that changed.
  await s.ask({ request: shellRequest("m3", "echo done > src_out.txt") });
  assert.equal(s.paseo.sent.at(-1)?.response.behavior, "allow");

  // The opt-in: a scoped contract admits the edit. A second task cannot share
  // T1's workspace (the conflict guard), so the opt-in rides its own tree.
  const ws2 = join(s.dir, "ws2");
  mkdirSync(ws2, { recursive: true });
  writeFileSync(join(ws2, "probe.txt"), "x\n");
  gitCommitAll(ws2, "base");
  s.factory.setContract({ task: "T2", workspace: ws2, gate: "true", artifact: "probe.txt", scope: ["AGENTS.md"] });
  await s.ask({
    cwd: ws2,
    request: {
      id: "m4",
      provider: "claude",
      name: "Write",
      kind: "tool",
      detail: { type: "write", filePath: "AGENTS.md", content: "# a contracted rule edit\n" },
    },
  });
  const t2Allowed = s.factory.ledger.eventsFor("T2").filter((e) => e.event === "permit_allowed");
  assert.equal(t2Allowed.length, 1, "an explicitly scoped memory edit is contracted work");
});

/**
 * Like helpers' factoryErrorCode, but by the stable `code` string: the shell
 * throws the SYNCED core's FactoryError class, a different identity from
 * src/errors.ts, so instanceof cannot cross the copy.
 */
function withCode(code: string): (err: unknown) => err is Error {
  return (err): err is Error => err instanceof Error && (err as { code?: unknown }).code === code;
}

test("git-block ingestion: bound lines carry the task, unbound lines still land, and dedupe survives a restart", async (t) => {
  const s = stage(t);
  const log = gitBlockLogPath(join(s.dir, "state"));
  const line = (id: string, cwd: string): void => {
    writeFileSync(
      log,
      `${JSON.stringify({ id, command: `git push --force origin ${id}`, rule: "git:force-push", reason: "test", cwd })}\n`,
      { flag: "a" },
    );
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (predicate: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("condition never landed");
      await sleep(25);
    }
  };
  const blockedCount = () => s.factory.ledger.events.filter((e) => e.event === "git_blocked").length;

  const first = startGitBlockIngestion(s.factory, { pollMs: 20 });
  line("b1", s.workspace);
  line("b2", join(s.dir, "unbound"));
  await until(() => blockedCount() === 2);
  first.stop();

  const blocked = s.factory.ledger.events.filter((e) => e.event === "git_blocked");
  assert.equal(blocked.length, 2);
  const bound = blocked.find((e) => e.blockId === "b1") as { task?: string; command?: string; blockId?: string };
  const unbound = blocked.find((e) => e.blockId === "b2") as { task?: string; command?: string; blockId?: string };
  assert.equal(bound.task, "T1", "a refusal inside a contracted workspace binds to the task");
  assert.equal(unbound.task, undefined, "the shim refuses no matter who runs it — the line records what it can bind");
  assert.equal(unbound.command, "git push --force origin b2");

  // A plugin restart re-seeds its seen-set from the ledger: replaying the same
  // log must not double-record. A NEW line still lands.
  const second = startGitBlockIngestion(s.factory, { pollMs: 20 });
  line("b3", s.workspace);
  await until(() => blockedCount() === 3);
  second.stop();
  const after = s.factory.ledger.events.filter((e) => e.event === "git_blocked");
  assert.equal(after.length, 3, "b1/b2 never re-recorded; b3 landed");
  assert.equal((after.find((e) => e.blockId === "b3") as { task?: string; command?: string; blockId?: string }).task, "T1");
});

test("git-block ingestion skips malformed lines loudly instead of dying or recording garbage", async (t) => {
  const s = stage(t);
  const stateDir = join(s.dir, "state");
  const log = gitBlockLogPath(stateDir);
  const logs: string[] = [];
  writeFileSync(log, "not json at all\n" + `${JSON.stringify({ id: "half", rule: "x" })}\n`);
  const ingestion = startGitBlockIngestion(s.factory, { pollMs: 20, onLog: (m) => logs.push(m) });
  const deadline = Date.now() + 3000;
  while (logs.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  ingestion.stop();
  assert.equal(s.factory.ledger.events.filter((e) => e.event === "git_blocked").length, 0, "nothing half-valid ever reaches the ledger");
  assert.ok(logs.some((l) => l.includes("malformed")), logs.join(" | "));
  assert.ok(logs.some((l) => l.includes("missing fields")), logs.join(" | "));
});

test("the ledger validates the choke shapes on reopen — and rejects the malformed ones", (t) => {
  const dir = makeTempDir("choke-ledger-test-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "ledger.jsonl");

  const valid = [
    { seq: 1, ts: "2026-10-09T00:00:00.000Z", event: "contract_set", task: "T1", workspace: "/ws", gate: "true", artifact: "a" },
    { seq: 2, ts: "2026-10-09T00:00:01.000Z", event: "permit_allowed", task: "T1", agent: "a1", name: "Bash", kind: "tool", command: "git status" },
    { seq: 3, ts: "2026-10-09T00:00:02.000Z", event: "permit_denied", task: "T1", agent: "a1", name: "Bash", kind: "tool", command: "git push --force", rule: "policy:S1-git-vocabulary", reason: "r" },
    { seq: 4, ts: "2026-10-09T00:00:03.000Z", event: "git_blocked", command: "git reset --hard", rule: "git:reset-hard", reason: "r", cwd: "/elsewhere", blockId: "z1" },
  ];
  writeFileSync(path, valid.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const factory = createFactory({ stateDir });
  assert.equal(factory.ledger.events.length, 4, "the whole choke vocabulary reopens clean — the untasked git_blocked included");

  // One malformed line each, asserted individually — reopen must refuse, never guess around.
  const bads = [
    [{ seq: 1, ts: "x", event: "permit_denied", task: "T1", agent: "a1", name: "Bash", kind: "tool", rule: "x", reason: "y", command: "c" }], // no contract, but shape-valid — expect OPEN
    [{ seq: 1, ts: "x", event: "git_blocked", command: "c", rule: "r", reason: "r", cwd: "/c" }], // no blockId
    [{ seq: 1, ts: "x", event: "permit_allowed", task: "T1", name: "Bash", kind: "tool" }], // no agent
    [{ seq: 1, ts: "x", event: "permit_denied", task: "T1", agent: "a1", name: "Bash", kind: "tool" }], // no rule
  ];
  const shouldOpen = [true, false, false, false];
  bads.forEach((bad, i) => {
    writeFileSync(path, bad.map((e) => JSON.stringify(e)).join("\n") + "\n");
    if (shouldOpen[i]) {
      createFactory({ stateDir });
    } else {
      assert.throws(() => createFactory({ stateDir }), withCode("corrupted-ledger"), JSON.stringify(bad));
    }
  });
});

// ---- the Task worktree binding (v0.0.14, ADR 0010 §4): the choke follows the agent into the worktree ----

test("a worktree agent is contracted, fenced, and isolated — the choke binds through the spawn line's worktree", async (t) => {
  const dir = makeTempDir("choke-loop-worktree-");
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "probe.txt"), "x\n");
  gitCommitAll(workspace, "base");
  const stateDir = join(dir, "state");
  const worktree = join(dir, "state", "worktrees", "WT");
  mkdirSync(dirname(worktree), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", "factory/WT", worktree, headSha(workspace)], { cwd: workspace });

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "WT", workspace, gate: "true", artifact: "probe.txt" });
  factory.requestSpawn({ task: "WT", provider: "claude", arity: 1, worktree });
  const choke = createChoke({ factory, homeDir: "/fake-home", onLog: () => {} });
  const paseo = fakePaseo();

  // A worktree-cwd'd agent is a contracted agent — the ask is judged and answered.
  await choke.onPermissionAsked(
    { agent: { id: "agent-wt", cwd: worktree }, request: shellRequest("r1", "bash -c 'git push --force origin main'") },
    paseo.api,
  );
  assert.equal(paseo.sent.length, 1, "the worktree bound the ask to the live contract");
  assert.equal(paseo.sent[0]?.response.behavior, "deny");
  assert.equal(factory.ledger.eventsFor("WT").filter((e) => e.event === "permit_denied").length, 1);

  // The memory fence covers the worktree's copy of AGENTS.md — an absolute
  // write at the worktree root denies exactly like one at the project root.
  await choke.onPermissionAsked(
    {
      agent: { id: "agent-wt", cwd: join(worktree, "src") },
      request: { id: "m-wt", provider: "claude", name: "Write", kind: "tool", detail: { type: "write", filePath: join(worktree, "AGENTS.md"), content: "# poisoned\n" } },
    },
    paseo.api,
  );
  assert.equal(paseo.sent.length, 2);
  assert.equal(paseo.sent[1]?.response.behavior, "deny", "the worktree's memory file is fenced");
  const fenced = factory.ledger.eventsFor("WT").findLast((e) => e.event === "permit_denied");
  assert.equal(fenced === undefined ? undefined : fenced.rule, "policy:memory-write-fenced");

  // A write INSIDE the worktree is ordinary contracted work — the execution
  // tree is the agent's writable root now. (A <project-root> write denies on
  // every real checkout — the root drops out of the writable set — but this
  // suite's temp dirs sit under $TMPDIR, whose /tmp entry already admits
  // them; that admission is S2's own law, not a worktree behavior, so it is
  // not asserted here.)
  await choke.onPermissionAsked(
    {
      agent: { id: "agent-wt", cwd: worktree },
      request: { id: "w-wt", provider: "claude", name: "Write", kind: "tool", detail: { type: "write", filePath: join(worktree, "src", "new.ts"), content: "export const n = 1;\n" } },
    },
    paseo.api,
  );
  assert.equal(paseo.sent[2]?.response.behavior, "allow");

  // The synthetic ask's default cwd is the task's execution tree: an ask
  // with no cwd of its own judges from the worktree root.
  const allowed = choke.spoolAskHandler({ id: "q1", kind: "ask", task: "WT", command: `echo hi > ${join(worktree, "ok.txt")}`, agent: "bypass-battery" });
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.decision, "allowed", "the spool ask judged from the worktree root");

  // Acceptance retires the binding at the worktree like at the root.
  factory.ledger.append({ event: "attempt_accepted", task: "WT", attempt: 1 });
  const after = await countAnswered(choke, worktree);
  assert.equal(after, 0, "an accepted task's worktree binds no live contract");
});

/** Fires one benign ask from `cwd` and returns how many responses the daemon side received. */
async function countAnswered(choke: ReturnType<typeof createChoke>, cwd: string): Promise<number> {
  const sent: unknown[] = [];
  await choke.onPermissionAsked(
    { agent: { id: "agent-x", cwd }, request: shellRequest("rz", "true") },
    {
      agents: {
        ref() {
          return { async respondToPermission(options: { response: unknown }) { sent.push(options.response); } };
        },
      },
    },
  );
  return sent.length;
}

/** HEAD sha of a checkout — the worktree fixture's base. */
function headSha(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}
