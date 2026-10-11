import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { handleSpoolRequest, parseSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const POLL_MS = 20;

/** The CLI half's write pattern: tmp file + rename, so the plugin never reads a half-written request. */
function dropRequest(spoolRoot: string, body: Record<string, unknown> & { id: string }): void {
  const requestsDir = join(spoolRoot, "requests");
  mkdirSync(requestsDir, { recursive: true });
  const path = join(requestsDir, `${body.id}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  renameSync(tmp, path);
}

function readReply(spoolRoot: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(spoolRoot, "replies", `${id}.json`), "utf8")) as Record<string, unknown>;
}

/** Waits (bounded) until the condition holds — spool answers are asynchronous by design. */
async function until(assertion: () => void, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

test("parseSpoolRequest accepts exactly the three request shapes and nothing else", () => {
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "claim", task: "T1", sha: "abc" }), {
    id: "r1",
    kind: "claim",
    task: "T1",
    sha: "abc",
  });
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "accept", task: "T1", attempt: 2, submitter: "owner" }), {
    id: "r1",
    kind: "accept",
    task: "T1",
    attempt: 2,
    submitter: "owner",
  });
  assert.deepEqual(
    parseSpoolRequest({ id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a", submitter: "agent-sup-1" }),
    {
      id: "r1",
      kind: "contract",
      task: "T1",
      workspace: "/w",
      gate: "true",
      artifact: "a",
      submitter: "agent-sup-1",
    },
  );
  assert.deepEqual(
    parseSpoolRequest({ id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a", freshEyes: true, submitter: "owner" }),
    { id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a", freshEyes: true, submitter: "owner" },
    "freshEyes passes only as literal true",
  );

  for (const bad of [
    null,
    "claim",
    {},
    { id: "r1" },
    { id: "r1", kind: "teleport" },
    { id: "r1", kind: "claim" },
    { id: "r1", kind: "claim", task: "T1", sha: 7 },
    { id: "r1", kind: "accept", task: "T1", attempt: "2" },
    // v0.0.9: an Owner act without a submitter is malformed — the spool
    // never defaults an unstamped contract or accept to anyone.
    { id: "r1", kind: "accept", task: "T1", attempt: 2 },
    { id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a" },
    { id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a", submitter: "  " },
    { id: "r1", kind: "accept", task: "T1", attempt: 2, submitter: 7 },
    { kind: "claim", task: "T1", sha: "abc" },
    { id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a", submitter: "owner", freshEyes: "yes" },
    { id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a", submitter: "owner", freshEyes: false },
  ]) {
    assert.equal(parseSpoolRequest(bad), undefined, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("the v0.0.9 stamps ride both Owner acts onto their ledger lines (ADR 0006)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "x.ts"), "x\n");
  const head = gitCommitAll(workspace);
  const factory = createFactory({ stateDir: join(dir, "state") });

  // The delegated path: the seat's agent id rides the contract line as `by`.
  const contract = await handleSpoolRequest(factory, {
    id: "r1",
    kind: "contract",
    task: "STAMP1",
    workspace,
    gate: "true",
    artifact: "src/x.ts",
    submitter: "agent-supervisor-1",
  });
  assert.equal(contract.ok, true);
  if (contract.ok) assert.match(contract.summary, /by agent-supervisor-1/);
  const set = factory.ledger.eventsFor("STAMP1")[0];
  assert.equal(set.event === "contract_set" ? set.by : undefined, "agent-supervisor-1");

  // One green attempt, then the delegated accept names itself as `accepted_by`
  // — "the Ledger always records who accepted".
  await factory.claim({ task: "STAMP1", sha: head });
  const accepted = await handleSpoolRequest(factory, { id: "r2", kind: "accept", task: "STAMP1", attempt: 1, submitter: "agent-supervisor-1" });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.match(accepted.summary, /by agent-supervisor-1/);
  const line = factory.ledger.eventsFor("STAMP1").find((e) => e.event === "attempt_accepted");
  assert.equal(line === undefined ? undefined : line.accepted_by, "agent-supervisor-1");

  // The human path is the same mechanism with the other stamp value.
  const contract2 = await handleSpoolRequest(factory, {
    id: "r3",
    kind: "contract",
    task: "STAMP2",
    workspace,
    gate: "true",
    artifact: "src/x.ts",
    submitter: "owner",
  });
  assert.equal(contract2.ok, true);
  const set2 = factory.ledger.eventsFor("STAMP2")[0];
  assert.equal(set2.event === "contract_set" ? set2.by : undefined, "owner");
});

test("handleSpoolRequest turns factory errors into rejected replies, never throws", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  const rejected = await handleSpoolRequest(factory, { id: "r1", kind: "claim", task: "T404", sha: "abc" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, "unknown-task");
});

test("the spool loop answers requests, moves them to processed, and keeps the reply", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory, { pollMs: POLL_MS });
  t.after(() => spool.stop());

  const spoolRoot = spoolRootFor(stateDir);
  dropRequest(spoolRoot, { id: "req-1", kind: "contract", task: "T1", workspace: "/definitely/missing", gate: "true", artifact: "a", submitter: "owner" });

  await until(() => {
    assert.ok(existsSync(join(spoolRoot, "replies", "req-1.json")), "the reply landed");
  });
  const reply = readReply(spoolRoot, "req-1");
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "invalid-contract");
  assert.ok(!existsSync(join(spoolRoot, "requests", "req-1.json")), "the request left the queue");
  assert.ok(existsSync(join(spoolRoot, "processed", "req-1.json")), "the request is kept in processed/");
});

test("a malformed request file gets a bad-request reply instead of being dropped silently", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory, { pollMs: POLL_MS });
  t.after(() => spool.stop());

  const spoolRoot = spoolRootFor(stateDir);
  dropRequest(spoolRoot, { id: "req-2", kind: "nonsense" });

  await until(() => {
    assert.equal(readReply(spoolRoot, "req-2").code, "bad-request");
  });
});

test("a replayed request with an existing reply runs nothing a second time (ADR 0004)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export const x = 1;\n");
  gitCommitAll(workspace);

  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory, { pollMs: POLL_MS });
  t.after(() => spool.stop());

  const spoolRoot = spoolRootFor(stateDir);
  const body = { id: "req-3", kind: "contract", task: "T1", workspace, gate: "true", artifact: "src/format.ts", submitter: "owner" };
  dropRequest(spoolRoot, body);
  await until(() => {
    assert.equal(readReply(spoolRoot, "req-3").ok, true);
  });
  assert.equal(factory.ledger.events.length, 1);

  // The CLI retried with the same id after already getting its reply.
  dropRequest(spoolRoot, body);
  await until(() => {
    assert.ok(!existsSync(join(spoolRoot, "requests", "req-3.json")), "the replay moved through");
  });
  assert.equal(factory.ledger.events.length, 1, "no second contract event — no second anything");
});

test("parseSpoolRequest accepts the synthetic-ask shape and nothing around it", () => {
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "ask", task: "T1", command: "git push --force" }), {
    id: "r1",
    kind: "ask",
    task: "T1",
    command: "git push --force",
  });
  assert.deepEqual(
    parseSpoolRequest({ id: "r1", kind: "ask", task: "T1", command: "x", cwd: "/w", agent: "battery", name: "Bash" }),
    { id: "r1", kind: "ask", task: "T1", command: "x", cwd: "/w", agent: "battery", name: "Bash" },
  );
  for (const bad of [
    { id: "r1", kind: "ask", task: "T1" },
    { id: "r1", kind: "ask", task: "T1", command: "  " },
    { id: "r1", kind: "ask", task: "T1", command: "x", cwd: 7 },
    { id: "r1", kind: "ask", task: "T1", command: "x", agent: true },
  ]) {
    assert.equal(parseSpoolRequest(bad), undefined, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("handleSpoolRequest routes asks to the choke handler and refuses loudly without one", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  const refused = await handleSpoolRequest(factory, { id: "r1", kind: "ask", task: "T1", command: "x" });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "ask-unavailable");
    assert.match(refused.message, /synthetic asks/);
  }

  const answered = await handleSpoolRequest(factory, { id: "r2", kind: "ask", task: "T1", command: "x" }, (req) => ({
    id: req.id,
    ok: true,
    summary: "ask denied (test)",
    decision: "denied",
    rule: "policy:S1-git-vocabulary",
  }));
  assert.deepEqual(answered, {
    id: "r2",
    ok: true,
    summary: "ask denied (test)",
    decision: "denied",
    rule: "policy:S1-git-vocabulary",
  });
});

test("parseSpoolRequest accepts the spawn shape and nothing around it", () => {
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "spawn", task: "T1", provider: "claude/opus-4-8", arity: 2 }), {
    id: "r1",
    kind: "spawn",
    task: "T1",
    provider: "claude/opus-4-8",
    arity: 2,
  });
  for (const bad of [
    { id: "r1", kind: "spawn", task: "T1", provider: "claude" },
    { id: "r1", kind: "spawn", task: "T1", provider: "claude", arity: "2" },
    { id: "r1", kind: "spawn", task: "T1", provider: "claude", arity: 0 },
    { id: "r1", kind: "spawn", task: "T1", provider: "claude", arity: 1.5 },
    { id: "r1", kind: "spawn", task: "T1", arity: 1 },
    { kind: "spawn", task: "T1", provider: "claude", arity: 1 },
  ]) {
    assert.equal(parseSpoolRequest(bad), undefined, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("handleSpoolRequest answers a spawn either way — dispatched rides ok, refusals ride the code and both leave one line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const ws = join(dir, "ws");
  const other = join(dir, "other");
  for (const w of [ws, other]) {
    mkdirSync(join(w, "src"), { recursive: true });
    writeFileSync(join(w, "src", "x.ts"), "x\n");
    gitCommitAll(w);
  }
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "RUN-1", workspace: ws, gate: "true", artifact: "src/x.ts", scope: ["src"] });
  factory.setContract({ task: "RUN-2", workspace: other, gate: "true", artifact: "src/x.ts" });

  const dispatched = await handleSpoolRequest(factory, { id: "r1", kind: "spawn", task: "RUN-1", provider: "claude", arity: 2 });
  assert.equal(dispatched.ok, true);
  if (dispatched.ok) assert.match(dispatched.summary, /spawn dispatched for RUN-1 under claude/);

  // Scope-mandatory: RUN-2 has no scope and the invocation carries two tasks.
  const refused = await handleSpoolRequest(factory, { id: "r2", kind: "spawn", task: "RUN-2", provider: "claude", arity: 2 });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "spawn-scope-mandatory");
    assert.match(refused.message, /no scope/);
  }

  // Unknown task: refused with its line too — the plugin never dispatches blind.
  const ghost = await handleSpoolRequest(factory, { id: "r3", kind: "spawn", task: "GHOST", provider: "claude", arity: 1 });
  assert.equal(ghost.ok, false);
  if (!ghost.ok) assert.equal(ghost.code, "unknown-task");

  const spawnLines = factory.ledger.events.filter((e) => e.event === "spawn_dispatched" || e.event === "spawn_refused");
  assert.deepEqual(
    spawnLines.map((e) => `${e.event}:${e.task}`),
    ["spawn_dispatched:RUN-1", "spawn_refused:RUN-2", "spawn_refused:GHOST"],
    "one ledger line per spawn request, either way",
  );
});
