import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { CorrelationRegistry } from "../plugin/server/core/correlations.ts";
import { spoolRootFor, spoolRequestSemanticKey, startSpool } from "../plugin/server/spool.ts";
import { randomId, spoolRequestSemanticKey as binSemanticKey, submit } from "../plugin/bin/spool-client.mjs";
import { resolveProject } from "../plugin/bin/project.mjs";
import { copyFixture, disposeDir, eyeAnswer, gitCommitAll, gitCommitChanges, makeTempDir, repoRoot, startFakeEye, writeEyeConfig, writeLanes } from "./helpers.ts";

/**
 * The mechanical DoD of ticket 08 without a daemon: the real CLIs
 * (`factory.mjs` for the Owner, `factory-claim.mjs` for the Agent) talk to the
 * real plugin-side spool loop over the same files the daemon would host. This
 * is also the drift guard between the two halves of the spool protocol, which
 * are implemented once in TypeScript and once in plain .mjs.
 */

const claimCli = join(repoRoot, "plugin", "bin", "factory-claim.mjs");
const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async on purpose: a sync spawn would block this process's event loop, and the spool poll lives here. */
function run(script: string, args: string[], extraEnv: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
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
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** Every `*.json` request filename currently queued in `spool/requests/`. */
function queuedRequestIds(spoolRoot: string): string[] {
  const dir = join(spoolRoot, "requests");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).sort();
}

test("the whole loop over the spool: contract → red claim → green claim → accept", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  const brokenSha = gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());

  const ownerEnv = { PASEO_HOME: home };
  const agentEnv = { FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "agent-test-1" };

  // The Owner fixes the Workspace in the Contract — the Agent never picks a cwd.
  const contract = await run(ownerCli, [
    "contract", "--task", "LOOP1", "--workspace", workspace, "--gate", "npm test", "--artifact", "src/format.ts",
  ], ownerEnv);
  assert.equal(contract.status, 0, contract.stderr);
  assert.match(contract.stdout, /contract set for LOOP1/);

  // Attempt 1: the agent claims unfinished work — the factory says red, with the note.
  const red = await run(claimCli, ["--task", "LOOP1", "--sha", brokenSha], agentEnv);
  assert.equal(red.status, 1, `red verdict must exit 1\nstdout: ${red.stdout}\nstderr: ${red.stderr}`);
  assert.match(red.stdout, /LOOP1 attempt 1 — RED/);
  assert.match(red.stdout, /report: .*report-LOOP1-1\.md/);
  assert.match(red.stdout, /note: .+fail 2/, "the agent sees the real gate note");

  // The agent fixes the work for real and claims the new commit.
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const fixedSha = gitCommitChanges(workspace, "fix pad to truncate and pad correctly");
  const green = await run(claimCli, ["--task", "LOOP1", "--sha", fixedSha], agentEnv);
  assert.equal(green.status, 0, `green verdict must exit 0\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);
  assert.match(green.stdout, /LOOP1 attempt 2 — GREEN/);

  // The Owner accepts the green attempt; acceptance is not the agent's act.
  const accept = await run(ownerCli, ["accept", "LOOP1", "--attempt", "2"], ownerEnv);
  assert.equal(accept.status, 0, accept.stderr);
  assert.match(accept.stdout, /LOOP1 accepted at attempt 2/);

  const events = factory.ledger.eventsFor("LOOP1").map((e) => e.event);
  assert.deepEqual(events, [
    "contract_set",
    "claim_reported", "gate_started", "gate_finished", "report_written",
    "claim_reported", "gate_started", "gate_finished", "report_written",
    "attempt_accepted",
  ]);
  assert.ok(existsSync(join(stateDir, "report-LOOP1-1.md")));
  assert.ok(existsSync(join(stateDir, "report-LOOP1-2.md")));
  const contractEvent = factory.ledger.eventsFor("LOOP1")[0];
  assert.equal(contractEvent.event === "contract_set" ? contractEvent.workspace : undefined, workspace);
  // v0.0.9: the human path stamps `owner` on both Owner acts (ADR 0006) —
  // the CLI's env carries no PASEO_AGENT_ID, so that is what rides.
  assert.equal(contractEvent.event === "contract_set" ? contractEvent.by : undefined, "owner");
  const acceptedEvent = factory.ledger.eventsFor("LOOP1").find((e) => e.event === "attempt_accepted");
  assert.equal(acceptedEvent === undefined ? undefined : acceptedEvent.accepted_by, "owner");
});

test("the delegated Owner seat's env stamps its id on both acts (v0.0.9)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace); // init the repo; this broken commit is never claimed
  // Green at HEAD from the first claim — this loop proves the stamp, not the gate.
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const sha = gitCommitChanges(workspace, "already green");
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());

  // The Supervisor's mechanical path: the same Owner CLI, its shell carrying
  // the daemon's PASEO_AGENT_ID — the stamp must be the seat's own id.
  const seatEnv = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-supervisor-1" };
  const contract = await run(ownerCli, [
    "contract", "--task", "SEAT1", "--workspace", workspace, "--gate", "npm test", "--artifact", "src/format.ts",
  ], seatEnv);
  assert.equal(contract.status, 0, contract.stderr);
  assert.match(contract.stdout, /contract set for SEAT1: .* by agent-supervisor-1/);

  const green = await run(claimCli, ["--task", "SEAT1", "--sha", sha], { FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "agent-worker-1" });
  assert.equal(green.status, 0, `expected green\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);

  const accept = await run(ownerCli, ["accept", "SEAT1", "--attempt", "1"], seatEnv);
  assert.equal(accept.status, 0, accept.stderr);
  assert.match(accept.stdout, /SEAT1 accepted at attempt 1 by agent-supervisor-1/);

  const set = factory.ledger.eventsFor("SEAT1")[0];
  assert.equal(set.event === "contract_set" ? set.by : undefined, "agent-supervisor-1");
  const accepted = factory.ledger.eventsFor("SEAT1").find((e) => e.event === "attempt_accepted");
  assert.equal(accepted === undefined ? undefined : accepted.accepted_by, "agent-supervisor-1");

  // A blank PASEO_AGENT_ID counts as absent — the human-path stamp, not an
  // empty one the spool would refuse.
  const blank = await run(ownerCli, [
    "contract", "--task", "SEAT2", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts",
  ], { PASEO_HOME: home, PASEO_AGENT_ID: "  " });
  assert.equal(blank.status, 0, blank.stderr);
  const set2 = factory.ledger.eventsFor("SEAT2")[0];
  assert.equal(set2.event === "contract_set" ? set2.by : undefined, "owner");
});

test("a claim the factory rejects comes back as an error exit with the reason", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());

  const rejected = await run(claimCli, ["--task", "NOPE", "--sha", "a1b2c3d"], { FACTORY_STATE_DIR: stateDir });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /no contract set for task NOPE/);
});

test("the owner CLI refuses bad usage before submitting anything", async () => {
  const noTask = await run(ownerCli, ["contract", "--workspace", "/w", "--gate", "true", "--artifact", "a"], {});
  assert.equal(noTask.status, 2);
  assert.match(noTask.stderr, /--task is required/);

  const badAttempt = await run(ownerCli, ["accept", "T1", "--attempt", "zero"], {});
  assert.equal(badAttempt.status, 2);
  assert.match(badAttempt.stderr, /--attempt must be a positive integer/);

  const unknown = await run(ownerCli, ["teleport"], {});
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command "teleport"/);
});

test("factory lead rotate: usage refusals, then the spool round trip names the retired agent (v0.0.14)", async (t) => {
  // Usage refusals fire before any submission.
  const noSub = await run(ownerCli, ["lead", "rotate"], {});
  assert.equal(noSub.status, 2);
  assert.match(noSub.stderr, /--project <dir> is required/);
  const badSub = await run(ownerCli, ["lead", "teleport", "--project", "/w"], {});
  assert.equal(badSub.status, 2);
  assert.match(badSub.stderr, /unknown subcommand "teleport"/);

  // The round trip: a real git project, a running spool with a rotation
  // handler wired the way index.server.ts wires it (the surface handlers'
  // leadRotate over the daemon).
  const dir = makeTempDir();
  disposeDir(t, dir);
  const projectRoot = join(dir, "repo");
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, "README.md"), "x\n");
  gitCommitAll(projectRoot);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });
  const rotated: string[] = [];
  const spool = startSpool(stateDir, factory, {
    pollMs: 20,
    leadRotate: async (request) => {
      rotated.push(request.projectRoot);
      return { id: request.id, ok: true, summary: "lead rotated — agent agent-lead-7 cancelled + archived", agentId: "agent-lead-7" };
    },
  });
  t.after(() => spool.stop());

  const reply = await run(ownerCli, ["--home", home, "lead", "rotate", "--project", projectRoot, "--wait-secs", "10"], {});
  assert.equal(reply.status, 0, reply.stderr);
  assert.match(reply.stdout, /lead rotated — agent agent-lead-7 cancelled \+ archived/);
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0], projectRoot, "the resolved project root rode the spool request");

  // A handler refusal (say, no live Lead) reaches the terminal as its code.
  spool.stop();
  const refusing = startSpool(stateDir, factory, {
    pollMs: 20,
    leadRotate: async (request) => ({ id: request.id, ok: false, code: "no-lead", message: "no live seat=lead agent on this daemon" }),
  });
  t.after(() => refusing.stop());
  const refused = await run(ownerCli, ["--home", home, "lead", "rotate", "--project", projectRoot, "--wait-secs", "10"], {});
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /no-lead: no live seat=lead agent/);
});

test("factory lead dispatch: usage refusals, then the spool round trip prints the queued mail's facts (v0.0.20)", async (t) => {
  // Usage refusals fire before any submission.
  const noTarget = await run(ownerCli, ["lead", "dispatch", "--message", "x"], {});
  assert.equal(noTarget.status, 2);
  assert.match(noTarget.stderr, /--project <slug> or --workspace <dir> is required/);
  const noMessage = await run(ownerCli, ["lead", "dispatch", "--project", "demo-slug"], {});
  assert.equal(noMessage.status, 2);
  assert.match(noMessage.stderr, /--message/);

  // The round trip: a real home, a spool with a dispatch handler wired the way
  // index.server.ts wires it (the Lead-mailbox runtime's dispatchLead).
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });
  const dispatched: Record<string, unknown>[] = [];
  const spool = startSpool(stateDir, factory, {
    pollMs: 20,
    leadDispatch: async (request) => {
      dispatched.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: "dispatched to the lead of demo-slug — agent=agent-lead-9 mail=mail-1 rotation=normal",
        project: "demo-slug",
        leadAgentId: "agent-lead-9",
        mailId: "mail-1",
        rotationState: "normal",
      };
    },
  });
  t.after(() => spool.stop());

  const reply = await run(ownerCli, ["--home", home, "lead", "dispatch", "--project", "demo-slug", "--message", "Ship the roadmap", "--wait-secs", "10"], {});
  assert.equal(reply.status, 0, reply.stderr);
  assert.match(reply.stdout, /dispatched to the lead of demo-slug/);
  assert.match(reply.stdout, /agent=agent-lead-9/);
  assert.match(reply.stdout, /mail=mail-1/);
  assert.match(reply.stdout, /rotation=normal/);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.kind, "lead_dispatch");
  assert.equal(dispatched[0]?.project, "demo-slug");
  assert.equal(dispatched[0]?.message, "Ship the roadmap");
  assert.equal("workspace" in (dispatched[0] ?? {}), false, "no workspace rode the slug form");
  assert.equal("from" in (dispatched[0] ?? {}), false, "the CLI leaves `from` to the plugin's owner default");

  // The one positional message rides in place of --message (the spec's "or one
  // positional message" form).
  const positional = await run(ownerCli, ["--home", home, "lead", "dispatch", "--project", "demo-slug", "Do the thing", "--wait-secs", "10"], {});
  assert.equal(positional.status, 0, positional.stderr);
  assert.equal(dispatched[1]?.message, "Do the thing");
});

test("factory-claim usage: --help exits 0, a missing --sha exits 2", async () => {
  const help = await run(claimCli, ["--help"], {});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: factory-claim --task <id> --sha <commit-sha>/);

  const bad = await run(claimCli, ["--task", "T1"], {});
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--task and --sha are both required/);
});

test("a claim with no plugin answering times out honestly and exits 2", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");

  const result = await run(claimCli, ["--task", "T1", "--sha", "abc", "--wait-secs", "1"], { FACTORY_STATE_DIR: stateDir });
  assert.equal(result.status, 2);
  // v0.0.31 (ADR 0017 §6): the timeout is the explicit stop-and-end-turn
  // instruction — the single deduplicated request stays durably queued.
  assert.match(result.stderr, /No reply from the factory plugin after 1s/);
  assert.match(result.stderr, /remains queued in spool\/requests\//);
  assert.match(result.stderr, /DO NOT retry or call this tool again/);
  assert.match(result.stderr, /end your turn immediately/);
  assert.deepEqual(queuedRequestIds(spoolRootFor(stateDir)).length, 1, "the request is durably queued, not lost");
});

test("the spool semantic key's two exported definitions cannot drift, and `id` never participates (v0.0.31, ADR 0017 §6)", () => {
  const bodies = [
    { id: "a", kind: "claim", task: "T1", sha: "s1", agent: "ag-1" },
    { id: "b", kind: "claim", task: "T1", sha: "s1", agent: "ag-1" },
    { id: "c", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a", submitter: "owner", scope: ["s2", "s1"], freshEyes: true },
    { id: "d", kind: "lead_dispatch", project: "demo", message: "Go", seat: "lead", submitter: "owner" },
    { id: "e", kind: "needs_human", task: "T9", reason: "denied-again", evidence: { repoke: 4, denial: 3 } },
  ];
  for (const body of bodies) {
    assert.equal(binSemanticKey(body), spoolRequestSemanticKey(body), `bin and server keys agree for ${body.kind}`);
  }
  // `id` is the one field the key ignores; key-order differences cancel too.
  assert.equal(binSemanticKey(bodies[0]), binSemanticKey(bodies[1]));
  assert.equal(spoolRequestSemanticKey(bodies[0]), spoolRequestSemanticKey(bodies[1]));
  assert.equal(
    binSemanticKey({ kind: "claim", task: "T1", sha: "s1" }),
    binSemanticKey({ sha: "s1", task: "T1", kind: "claim" }),
    "object key order never changes the key",
  );
  // Any semantic field changing changes the key.
  assert.notEqual(binSemanticKey(bodies[0]), binSemanticKey({ ...bodies[0], sha: "s2" }));
  assert.notEqual(binSemanticKey(bodies[0]), binSemanticKey({ ...bodies[0], agent: "ag-2" }));
});

test("three identical claims while the watcher is stopped leave ONE request file; the spool then runs ONE Gate attempt (v0.0.31, ADR 0017 §6)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  const sha = gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  factory.setContract({ task: "DEDUP1", workspace, gate: "true", artifact: "src/format.ts" });
  const spoolRoot = spoolRootFor(stateDir);

  // The offline window: a Peer retries agent_claim three times, each retry
  // minting a fresh request id — exactly the spec's Problem 5 stack.
  const awaitedIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const request = { id: randomId(), kind: "claim" as const, task: "DEDUP1", sha, agent: "agent-dedup-1" };
    submit(spoolRoot, request);
    awaitedIds.push(request.id);
  }
  assert.equal(new Set(awaitedIds).size, 1, "every submit reused the one pending request's id");
  assert.deepEqual(queuedRequestIds(spoolRoot), [awaitedIds[0]!], "exactly ONE request file sits in spool/requests/");

  // The plugin comes back: the single queued claim runs exactly one Gate attempt.
  const spool = startSpool(stateDir, factory, { pollMs: 20 });
  t.after(() => spool.stop());
  const replyPath = join(spoolRoot, "replies", `${awaitedIds[0]}.json`);
  await until(() => {
    assert.ok(existsSync(replyPath), "the single reply landed");
  });
  const reply = JSON.parse(readFileSync(replyPath, "utf8")) as Record<string, unknown>;
  assert.equal(reply.ok, true);
  assert.equal(reply.attempt, 1, "one Gate attempt — attempt: 1");
  assert.equal(reply.verdict, "green");
  assert.deepEqual(
    factory.ledger.eventsFor("DEDUP1").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
    "exactly one claim round — no second Gate, no second Ledger mutation",
  );
  assert.deepEqual(queuedRequestIds(spoolRoot), [], "the drained queue is empty");
});

test("the loop with --fresh-eyes: the eye's line lands through the real CLIs and spool", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  const brokenSha = gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const fake = await startFakeEye(t, () => ({
    status: 200,
    payload: eyeAnswer("CLEAR\nthe fix matches the contract; nothing to add."),
  }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());

  const ownerEnv = { PASEO_HOME: home };
  const agentEnv = { FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "agent-eye-1" };

  // A marked contract without eye.json would fail fast; with it, the flag rides.
  const contract = await run(ownerCli, [
    "contract", "--task", "LOOP2", "--workspace", workspace, "--gate", "npm test", "--artifact", "src/format.ts", "--fresh-eyes",
  ], ownerEnv);
  assert.equal(contract.status, 0, contract.stderr);
  assert.match(contract.stdout, /fresh eyes ON/);

  // The red attempt never asks the eye.
  const red = await run(claimCli, ["--task", "LOOP2", "--sha", brokenSha], agentEnv);
  assert.equal(red.status, 1);
  assert.equal(fake.requests.length, 0, "red verdicts never call the eye");

  // The real fix: green, and the eye reads contract + diff + gate output.
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const fixedSha = gitCommitChanges(workspace, "fix pad to truncate and pad correctly");
  const green = await run(claimCli, ["--task", "LOOP2", "--sha", fixedSha], agentEnv);
  assert.equal(green.status, 0, `expected green\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);

  assert.equal(fake.requests.length, 1, "one green attempt, one eye pass");
  const prompt = (fake.requests[0]!.body as { messages: { content: string }[] }).messages[0]!.content;
  assert.ok(prompt.includes("Task: LOOP2"));
  assert.ok(prompt.includes("src/format.ts"), "the diff is in the bundle");

  const events = factory.ledger.eventsFor("LOOP2").map((e) => e.event);
  assert.deepEqual(events, [
    "contract_set",
    "claim_reported", "gate_started", "gate_finished", "report_written",
    "claim_reported", "gate_started", "gate_finished", "fresh_eyes_written", "report_written",
  ]);
  const claim = factory.ledger.eventsFor("LOOP2").filter((e) => e.event === "claim_reported").at(-1);
  assert.equal((claim as { agent?: string }).agent, "agent-eye-1", "the spool stamps the submitter (ticket 02b)");
  const report = readFileSync(join(stateDir, "report-LOOP2-2.md"), "utf8");
  assert.ok(report.includes("- Claimed by agent `agent-eye-1`"));
  assert.ok(report.includes("- Fresh eyes (`fake-eye-1`) — CLEAR: the fix matches the contract; nothing to add."));
  assert.ok(existsSync(join(stateDir, "gate-LOOP2-2.log")), "the full gate output is persisted (ticket 02a)");
});

test("factory run refuses bad usage before touching the spool or the daemon", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");

  const noTasks = await run(ownerCli, ["run", "--provider", "claude"], { PASEO_HOME: home });
  assert.equal(noTasks.status, 2);
  assert.match(noTasks.stderr, /run: at least one task id is required/);

  // v0.0.13 (ADR 0009 §3): --provider is optional — omitted resolves through
  // lanes.worker, and this home has no daemon to reach, so the refusal is the
  // daemon's, after the lane resolved and before any spool request.
  const noDaemon = await run(ownerCli, ["run", "T1"], { PASEO_HOME: home });
  assert.equal(noDaemon.status, 2);
  assert.match(noDaemon.stdout, /cannot reach the daemon/); // the driver's banner path — stdout, not stderr

  // A broken lanes.json is the one remaining usage refusal on the run path.
  const stateDir = join(home, "plugin-state", "paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "lanes.json"), "{ broken");
  const brokenLanes = await run(ownerCli, ["run", "T1"], { PASEO_HOME: home });
  assert.equal(brokenLanes.status, 2);
  assert.match(brokenLanes.stderr, /lanes\.json is not valid JSON/);

  const dup = await run(ownerCli, ["run", "T1", "T1", "--provider", "claude"], { PASEO_HOME: home });
  assert.equal(dup.status, 2);
  assert.match(dup.stderr, /task T1 appears twice/);

  assert.ok(!existsSync(join(stateDir, "spool", "requests")), "no request was submitted for refused usage");
});

test("the v0.0.6 contract flags round-trip: --watch marks the pass, --description rides the line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const factory = createFactory({ stateDir, watchCopilotProbe: () => true }); // --watch fail-fasts without a usable copilot CLI
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());
  const ownerEnv = { PASEO_HOME: home };

  const contract = await run(
    ownerCli,
    [
      "contract", "--task", "RIDER1", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts",
      "--watch", "--description", "Tighten the pad helper's truncation edge case.",
    ],
    ownerEnv,
  );
  assert.equal(contract.status, 0, contract.stderr);
  assert.match(contract.stdout, /contract set for RIDER1/);
  assert.match(contract.stdout, /watch ON/);

  const set = factory.ledger.eventsFor("RIDER1")[0];
  assert.equal(set.event === "contract_set" ? set.watch : undefined, true, "the mark is Contract data");
  assert.equal(set.event === "contract_set" ? set.description : undefined, "Tighten the pad helper's truncation edge case.");

  // --watch without a usable copilot CLI is refused loudly, before any line.
  const home2 = join(dir, "paseo-home2");
  const stateDir2 = join(home2, "plugin-state", "paseo-factory");
  writeLanes(stateDir2, { watch: "copilot/gpt-5.4" }); // the lane under test — its CLI is what the message names
  const factory2 = createFactory({ stateDir: stateDir2, watchCopilotProbe: () => false });
  const spool2 = startSpool(stateDir2, factory2);
  t.after(() => spool2.stop());
  const refused = await run(
    ownerCli,
    ["contract", "--task", "RIDER2", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts", "--watch"],
    { PASEO_HOME: home2 },
  );
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /copilot CLI/);
  assert.deepEqual([...factory2.ledger.events], [], "no line for the refused contract");

  // An empty --description is a usage error, not a silent blank.
  const blank = await run(
    ownerCli,
    ["contract", "--task", "RIDER3", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts", "--description", "  "],
    { PASEO_HOME: home },
  );
  assert.equal(blank.status, 2);
  assert.match(blank.stderr, /--description must be a non-empty text/);
});

test("the v0.0.14 contract flag round-trip: --skills rides the spool onto the contract_set line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);

  // One home per sub-case: one contract per tree, and the workspace-conflict
  // guard fires on the second contract of the same tree (its own law).
  const spawnHome = () => {
    const home = join(dir, `paseo-home-${Math.random().toString(36).slice(2, 8)}`);
    const stateDir = join(home, "plugin-state", "paseo-factory");
    const factory = createFactory({ stateDir });
    const spool = startSpool(stateDir, factory);
    t.after(() => spool.stop());
    return { home, stateDir, factory };
  };

  const first = spawnHome();
  const contract = await run(
    ownerCli,
    [
      "contract", "--task", "SKILL1", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts",
      "--skills", "tdd, diagnosing-bugs ,",
    ],
    { PASEO_HOME: first.home },
  );
  assert.equal(contract.status, 0, contract.stderr);
  assert.match(contract.stdout, /contract set for SKILL1/);

  const set = first.factory.ledger.eventsFor("SKILL1")[0];
  assert.deepEqual(
    set.event === "contract_set" ? set.skills : undefined,
    ["tdd", "diagnosing-bugs"],
    "comma-split, trimmed, blanks dropped — scope's own parsing law",
  );

  // Omitted flag omits the field, never an empty array.
  const second = spawnHome();
  const plain = await run(
    ownerCli,
    ["contract", "--task", "SKILL2", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts"],
    { PASEO_HOME: second.home },
  );
  assert.equal(plain.status, 0, plain.stderr);
  const set2 = second.factory.ledger.eventsFor("SKILL2")[0];
  assert.equal("skills" in set2, false);

  // A skills value with only blanks parses to no skills at all — the field
  // stays omitted, same as an omitted flag.
  const third = spawnHome();
  const blankOnly = await run(
    ownerCli,
    ["contract", "--task", "SKILL3", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts", "--skills", " ,"],
    { PASEO_HOME: third.home },
  );
  assert.equal(blankOnly.status, 0, blankOnly.stderr);
  const set3 = third.factory.ledger.eventsFor("SKILL3")[0];
  assert.equal("skills" in set3, false);
});

test("factory accept --by <seat>: the flag rides the spool; the Lead's rules answer at the CLI (v0.0.14)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const sha = gitCommitChanges(workspace, "already green");
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const fake = await startFakeEye(t, () => ({
    status: 200,
    payload: eyeAnswer("CONCERN\nthe diff touches nothing the contract gated."),
  }));
  writeEyeConfig(stateDir, fake.url);

  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());
  const ownerEnv = { PASEO_HOME: home };
  const agentEnv = { FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "agent-worker-1" };

  const contract = await run(ownerCli, [
    "contract", "--task", "SEAT2", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts", "--fresh-eyes",
  ], ownerEnv);
  assert.equal(contract.status, 0, contract.stderr);
  const green = await run(claimCli, ["--task", "SEAT2", "--sha", sha], agentEnv);
  assert.equal(green.status, 0, `expected green\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);
  assert.equal(fake.requests.length, 1, "the eye ran on the green attempt");

  // Needs-human remains a hard stop even with historical Fresh-eyes evidence.
  const denial = factory.ledger.append({ event: "permit_denied", task: "SEAT2", agent: "peer", name: "Bash", kind: "tool", rule: "scope", reason: "denied" });
  const poke = factory.ledger.append({ event: "repoke_dispatched", task: "SEAT2", agent: "peer" });
  factory.ledger.append({ event: "needs_human", task: "SEAT2", reason: "denied-again", evidence: { denial: denial.seq, repoke: poke.seq } });
  const leadRefused = await run(ownerCli, ["accept", "SEAT2", "--attempt", "1", "--by", "lead"], ownerEnv);
  assert.equal(leadRefused.status, 2);
  assert.match(leadRefused.stderr, /lead-accept-refused/);
  assert.match(leadRefused.stderr, /needs_human/);
  assert.equal(factory.ledger.eventsFor("SEAT2").some((e) => e.event === "attempt_accepted"), false, "no line for the refused act");

  // The daemon binding, rather than the caller's attribution flag, selects
  // Lead policy, including a CLI call that omits --by entirely.
  const boundLead = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: "project", projectRoot: workspace, agentId: "bound-lead" });
  for (const submitter of [boundLead.correlationId, "bound-lead"]) {
    for (const by of [undefined, "owner", "supervisor"]) {
      const reply = await run(ownerCli, ["accept", "SEAT2", "--attempt", "1", ...(by === undefined ? [] : ["--by", by])], { ...ownerEnv, PASEO_AGENT_ID: submitter });
      assert.equal(reply.status, 2, reply.stdout);
      assert.match(reply.stderr, /lead-accept-refused/);
    }
  }

  // The usage guard: --by takes exactly the three seats.
  const badSeat = await run(ownerCli, ["accept", "SEAT2", "--attempt", "1", "--by", "boss"], ownerEnv);
  assert.equal(badSeat.status, 2);
  assert.match(badSeat.stderr, /--by must be one of owner\|supervisor\|lead/);

  // The Supervisor's word lands over the same evidence, stamped by the flag.
  const supervisor = await run(ownerCli, ["accept", "SEAT2", "--attempt", "1", "--by", "supervisor"], ownerEnv);
  assert.equal(supervisor.status, 0, supervisor.stderr);
  assert.match(supervisor.stdout, /SEAT2 accepted at attempt 1 by supervisor/);
  const accepted = factory.ledger.eventsFor("SEAT2").find((e) => e.event === "attempt_accepted");
  assert.equal(accepted === undefined ? undefined : accepted.accepted_by, "supervisor");

  // And the Lead's clean acceptance on a CONCERN-free attempt.
  const home2 = join(dir, "paseo-home2");
  const stateDir2 = join(home2, "plugin-state", "paseo-factory");
  const factory2 = createFactory({ stateDir: stateDir2 });
  const spool2 = startSpool(stateDir2, factory2);
  t.after(() => spool2.stop());
  const contract2 = await run(ownerCli, [
    "contract", "--task", "SEAT3", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts",
  ], { PASEO_HOME: home2 });
  assert.equal(contract2.status, 0, contract2.stderr);
  const green2 = await run(claimCli, ["--task", "SEAT3", "--sha", sha], { FACTORY_STATE_DIR: stateDir2, PASEO_AGENT_ID: "agent-worker-2" });
  assert.equal(green2.status, 0, green2.stderr);
  const lead = await run(ownerCli, ["accept", "SEAT3", "--attempt", "1", "--by", "lead"], { PASEO_HOME: home2 });
  assert.equal(lead.status, 0, lead.stderr);
  assert.match(lead.stdout, /SEAT3 accepted at attempt 1 by lead/);
  const accepted2 = factory2.ledger.eventsFor("SEAT3").find((e) => e.event === "attempt_accepted");
  assert.equal(accepted2 === undefined ? undefined : accepted2.accepted_by, "lead");
});

test("factory CLI stamps PASEO_FACTORY_SEAT onto spool requests and enforces seat command authority (v0.0.23, ADR 0015 §1)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const sha = gitCommitChanges(workspace, "green implementation");
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const dispatched: Record<string, unknown>[] = [];
  const spool = startSpool(stateDir, factory, {
    pollMs: 20,
    leadDispatch: async (request) => {
      dispatched.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: "dispatched to lead",
        project: "workspace",
        leadAgentId: "agent-lead-1",
        mailId: "mail-1",
        rotationState: "normal",
      };
    },
  });
  t.after(() => spool.stop());

  const supEnv = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-sup-1", PASEO_FACTORY_SEAT: "supervisor" };
  const leadEnv = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-lead-1", PASEO_FACTORY_SEAT: "lead" };
  const workerEnv = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-worker-1", PASEO_FACTORY_SEAT: "agent" };

  // Supervisor calling `factory contract` is refused with supervisor-cannot-contract-or-run.
  const supContract = await run(
    ownerCli,
    ["contract", "--task", "T-AUTH", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts"],
    supEnv,
  );
  assert.equal(supContract.status, 2);
  assert.match(supContract.stderr, /supervisor-cannot-contract-or-run/);
  assert.match(supContract.stderr, /factory lead dispatch/);
  assert.equal(factory.ledger.eventsFor("T-AUTH").length, 0, "no contract_set written when Supervisor is refused");

  // Supervisor calling `factory run` is refused with supervisor-cannot-contract-or-run.
  const supRun = await run(ownerCli, ["run", "T-AUTH"], supEnv);
  assert.equal(supRun.status, 2);
  assert.match(supRun.stderr, /supervisor-cannot-contract-or-run/);

  // Supervisor CAN call `factory lead dispatch`, and its seat stamp rides the request.
  const supDispatch = await run(ownerCli, ["lead", "dispatch", "--workspace", workspace, "--message", "Build T-AUTH"], supEnv);
  assert.equal(supDispatch.status, 0, supDispatch.stderr);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.seat, "supervisor");

  // Lead CAN call `factory contract`.
  const leadContract = await run(
    ownerCli,
    ["contract", "--task", "T-AUTH", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts", "--scope", "src/format.ts"],
    leadEnv,
  );
  assert.equal(leadContract.status, 0, leadContract.stderr);

  // Lead CAN pass `--no-fresh-eyes` to explicitly opt out of fresh-eyes.
  const leadNoEye = await run(
    ownerCli,
    ["contract", "--task", "T-NO-EYE", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts", "--scope", "src/other.ts", "--no-fresh-eyes"],
    leadEnv,
  );
  assert.equal(leadNoEye.status, 0, leadNoEye.stderr);
  assert.equal(factory.contractFor("T-NO-EYE")?.freshEyes, undefined);

  // Working Agent (PASEO_FACTORY_SEAT=agent) is refused on contract, run, accept, lead dispatch, lead rotate.
  const agContract = await run(
    ownerCli,
    ["contract", "--task", "T-AG", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts"],
    workerEnv,
  );
  assert.equal(agContract.status, 2);
  assert.match(agContract.stderr, /agent-cannot-orchestrate/);

  const agRun = await run(ownerCli, ["run", "T-AUTH"], workerEnv);
  assert.equal(agRun.status, 2);
  assert.match(agRun.stderr, /agent-cannot-orchestrate/);

  const agDispatch = await run(ownerCli, ["lead", "dispatch", "--workspace", workspace, "--message", "no"], workerEnv);
  assert.equal(agDispatch.status, 2);
  assert.match(agDispatch.stderr, /agent-cannot-orchestrate/);

  const agRotate = await run(ownerCli, ["lead", "rotate", "--project", workspace], workerEnv);
  assert.equal(agRotate.status, 2);
  assert.match(agRotate.stderr, /agent-cannot-orchestrate/);

  // Working Agent CAN claim via factory-claim.
  const claimed = await run(claimCli, ["--task", "T-AUTH", "--sha", sha], {
    FACTORY_STATE_DIR: stateDir,
    PASEO_AGENT_ID: "agent-worker-1",
    PASEO_FACTORY_SEAT: "agent",
  });
  assert.equal(claimed.status, 0, claimed.stderr);

  // Working Agent still cannot accept its own green attempt.
  const agAccept = await run(ownerCli, ["accept", "T-AUTH", "--attempt", "1"], workerEnv);
  assert.equal(agAccept.status, 2);
  assert.match(agAccept.stderr, /agent-cannot-orchestrate/);

  // Supervisor CAN accept --by supervisor on the Owner's word.
  const supAccept = await run(ownerCli, ["accept", "T-AUTH", "--attempt", "1", "--by", "supervisor"], supEnv);
  assert.equal(supAccept.status, 0, supAccept.stderr);
});

test("factory supervisor dispatch and factory supervisor report: usage refusals, seat routing, and spool round trip (v0.0.23, ADR 0015 §3/§5)", async (t) => {
  // Usage refusals before any submission.
  const noTargetDispatch = await run(ownerCli, ["supervisor", "dispatch", "--message", "x"], {});
  assert.equal(noTargetDispatch.status, 2);
  assert.match(noTargetDispatch.stderr, /--project <slug> or --workspace <dir> is required/);

  const noMsgDispatch = await run(ownerCli, ["supervisor", "dispatch", "--project", "demo-slug"], {});
  assert.equal(noMsgDispatch.status, 2);
  assert.match(noMsgDispatch.stderr, /--message/);

  const noTargetReport = await run(ownerCli, ["supervisor", "report", "--message", "wave green"], {});
  assert.equal(noTargetReport.status, 2);
  assert.match(noTargetReport.stderr, /--project <slug> or --workspace <dir> is required/);

  const noMsgReport = await run(ownerCli, ["supervisor", "report", "--project", "demo-slug"], {});
  assert.equal(noMsgReport.status, 2);
  assert.match(noMsgReport.stderr, /--message/);

  const badSub = await run(ownerCli, ["supervisor", "teleport", "--project", "demo-slug"], {});
  assert.equal(badSub.status, 2);
  assert.match(badSub.stderr, /unknown subcommand "teleport"/);

  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "repo");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "x\n");
  gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });

  const supDispatched: Record<string, unknown>[] = [];
  const leadDispatched: Record<string, unknown>[] = [];
  const supReported: Record<string, unknown>[] = [];

  const spool = startSpool(stateDir, factory, {
    pollMs: 20,
    leadDispatch: async (request) => {
      leadDispatched.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: "dispatched to the lead of repo",
        project: "repo",
        leadAgentId: "agent-lead-1",
        mailId: "mail-lead-1",
        rotationState: "normal",
      };
    },
    supervisorDispatch: async (request) => {
      if (request.seat === "supervisor") {
        leadDispatched.push({ ...request, kind: "lead_dispatch", from: "supervisor" });
        return {
          id: request.id,
          ok: true,
          summary: "directive dispatched to Lead (agent-lead-1) — end your turn now and wait for Lead's report",
          project: "repo",
          leadAgentId: "agent-lead-1",
          mailId: "mail-lead-1",
          rotationState: "normal",
        };
      }
      supDispatched.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: "directive routed to Supervisor (agent-sup-1) — stop this turn immediately without editing files and open the Supervisor session",
        project: "repo",
        supervisorAgentId: "agent-sup-1",
        mailId: "mail-sup-1",
      };
    },
    supervisorReport: async (request) => {
      supReported.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: "report queued for Supervisor (agent-sup-1) — end your turn",
        project: "repo",
        supervisorAgentId: "agent-sup-1",
        mailId: "mail-rep-1",
      };
    },
  });
  t.after(() => spool.stop());

  // 1. Normal chat (PASEO_FACTORY_SEAT unset): routes to Supervisor.
  const chatDispatch = await run(
    ownerCli,
    ["--home", home, "supervisor", "dispatch", "--workspace", workspace, "--message", "Build 2048", "--wait-secs", "10"],
    {},
  );
  assert.equal(chatDispatch.status, 0, chatDispatch.stderr);
  assert.match(chatDispatch.stdout, /directive routed to Supervisor \(agent-sup-1\)/);
  assert.match(chatDispatch.stdout, /stop this turn immediately without editing files/);
  assert.equal(supDispatched.length, 1);
  assert.equal(supDispatched[0]?.kind, "supervisor_dispatch");
  assert.equal(supDispatched[0]?.workspace, workspace);
  assert.equal(supDispatched[0]?.message, "Build 2048");
  assert.equal(supDispatched[0]?.submitter, "owner");

  // 2. Inside Supervisor (PASEO_FACTORY_SEAT=supervisor): routes to Lead.
  const fromSupDispatch = await run(
    ownerCli,
    ["--home", home, "supervisor", "dispatch", "--workspace", workspace, "--message", "Ship wave 1", "--wait-secs", "10"],
    { PASEO_FACTORY_SEAT: "supervisor", PASEO_AGENT_ID: "agent-sup-1" },
  );
  assert.equal(fromSupDispatch.status, 0, fromSupDispatch.stderr);
  assert.match(fromSupDispatch.stdout, /directive dispatched to Lead \(agent-lead-1\)/);
  assert.match(fromSupDispatch.stdout, /end your turn now and wait for Lead's report/);
  assert.equal(leadDispatched.length, 1);
  assert.equal(leadDispatched[0]?.seat, "supervisor");
  assert.equal(leadDispatched[0]?.submitter, "agent-sup-1");

  // 3. Lead calling `factory supervisor report`: queues report for Supervisor.
  const leadReport = await run(
    ownerCli,
    ["--home", home, "supervisor", "report", "--workspace", workspace, "--message", "Wave 1 accepted and landed", "--wait-secs", "10"],
    { PASEO_FACTORY_SEAT: "lead", PASEO_AGENT_ID: "agent-lead-1" },
  );
  assert.equal(leadReport.status, 0, leadReport.stderr);
  assert.match(leadReport.stdout, /report queued for Supervisor \(agent-sup-1\) — end your turn/);
  assert.equal(supReported.length, 1);
  assert.equal(supReported[0]?.kind, "supervisor_report");
  assert.equal(supReported[0]?.seat, "lead");
  assert.equal(supReported[0]?.submitter, "agent-lead-1");
  assert.equal(supReported[0]?.message, "Wave 1 accepted and landed");

  // 4. Working Agent calling `factory supervisor dispatch` or `factory supervisor report` is refused.
  const agSupDispatch = await run(
    ownerCli,
    ["--home", home, "supervisor", "dispatch", "--workspace", workspace, "--message", "nope", "--wait-secs", "10"],
    { PASEO_FACTORY_SEAT: "agent", PASEO_AGENT_ID: "agent-worker-1" },
  );
  assert.equal(agSupDispatch.status, 2);
  assert.match(agSupDispatch.stderr, /agent-cannot-orchestrate/);

  const agSupReport = await run(
    ownerCli,
    ["--home", home, "supervisor", "report", "--workspace", workspace, "--message", "nope", "--wait-secs", "10"],
    { PASEO_FACTORY_SEAT: "agent", PASEO_AGENT_ID: "agent-worker-1" },
  );
  assert.equal(agSupReport.status, 2);
  assert.match(agSupReport.stderr, /agent-cannot-orchestrate/);
});

test("factory reset CLI: refuses supervisor/lead/agent with seat-cannot-reset and executes owner reset via spool (v0.0.24, ADR 0015 §6)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "repo");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "x\n");
  gitCommitAll(workspace);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });

  const resets: Record<string, unknown>[] = [];
  const spool = startSpool(stateDir, factory, {
    pollMs: 20,
    projectReset: async (request) => {
      resets.push({ ...request });
      return {
        id: request.id,
        ok: true,
        summary: `project repo reset (2 events across 1 task purged, 2 files removed, 1 seat archived)`,
        project: "repo",
        purgedEvents: 2,
        tasks: ["T1"],
        removedFiles: 2,
        archivedSeats: ["lead:lead-1"],
        archivedAgents: [],
      };

    },
  });
  t.after(() => spool.stop());

  for (const seat of ["supervisor", "lead", "agent"] as const) {
    const refused = await run(
      ownerCli,
      ["--home", home, "reset", "--workspace", workspace, "--wait-secs", "5"],
      { PASEO_FACTORY_SEAT: seat, PASEO_AGENT_ID: `agent-${seat}-1` },
    );
    assert.equal(refused.status, 2, `expected ${seat} to exit 2`);
    assert.match(refused.stderr, /seat-cannot-reset/);
  }
  assert.equal(resets.length, 0);

  const ownerReset = await run(
    ownerCli,
    ["--home", home, "reset", "--workspace", workspace, "--keep-seats", "--wait-secs", "10"],
    {},
  );
  assert.equal(ownerReset.status, 0, ownerReset.stderr);
  assert.match(ownerReset.stdout, /project repo reset/);
  assert.equal(resets.length, 1);
  assert.equal(resets[0]?.kind, "reset");
  assert.equal(resets[0]?.workspace, workspace);
  assert.equal(resets[0]?.keepSeats, true);
  assert.equal(resets[0]?.submitter, "owner");
});

// ---- the Lane profile store & Project lane reset (v0.0.38, ADR 0026 §2; Seam 3) ----------------

/** Parses the whole stdout as one JSON document — every --json verb prints exactly one. */
function jsonOf(result: CliResult): any {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("factory profile + lanes reset: the Owner's whole Lane profile lifecycle over the real CLI (v0.0.38, ADR 0026 §2)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const env = { PASEO_HOME: home };
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "x\n");
  gitCommitAll(repo);
  const resolved = resolveProject(repo);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  const slug = resolved.ok ? resolved.slug : "";

  // The store starts empty — zero built-ins, by Owner decision.
  const empty = jsonOf(await run(ownerCli, ["profile", "list", "--json"], env));
  assert.deepEqual(empty, { profiles: [] });
  const emptyText = await run(ownerCli, ["profile", "list"], env);
  assert.equal(emptyText.status, 0);
  assert.match(emptyText.stdout, /no lane profiles yet/);

  // Configure the machine table, then save it as a named profile (id from the positional).
  const machineSet = await run(ownerCli, ["lanes", "set", "worker", "opencode/glm-5.1"], env);
  assert.equal(machineSet.status, 0, machineSet.stderr);
  const saved = jsonOf(
    await run(ownerCli, ["profile", "save", "fast-stack", "--name", "Fast Stack", "--description", "Cheap and quick", "--json"], env),
  );
  assert.equal(saved.created, true);
  assert.equal(saved.profile.id, "fast-stack");
  assert.equal(saved.profile.name, "Fast Stack");
  assert.equal(saved.profile.description, "Cheap and quick");
  assert.equal(saved.profile.lanes.worker, "opencode/glm-5.1");
  assert.equal(saved.profile.lanes.supervisor, "pi/zai/glm-5.3");
  assert.equal(typeof saved.profile.updatedAt, "string");

  // list carries it (sorted by name then id); show answers by id AND by exact name.
  const listed = jsonOf(await run(ownerCli, ["profile", "list", "--json"], env));
  assert.deepEqual(listed.profiles.map((p: { id: string }) => p.id), ["fast-stack"]);
  const shownById = jsonOf(await run(ownerCli, ["profile", "show", "fast-stack", "--json"], env));
  assert.deepEqual(shownById.profile, saved.profile);
  const shownByName = jsonOf(await run(ownerCli, ["profile", "show", "Fast Stack", "--json"], env));
  assert.deepEqual(shownByName.profile, saved.profile);

  // save by NAME updates the same profile (the id-or-name law) — id stable, label moves.
  const updated = jsonOf(await run(ownerCli, ["profile", "save", "Fast Stack", "--name", "Fast Stack v2", "--json"], env));
  assert.equal(updated.created, false);
  assert.equal(updated.profile.id, "fast-stack");
  assert.equal(updated.profile.name, "Fast Stack v2");

  // An id outside the slug law is a named refusal; nothing is written.
  const badId = await run(ownerCli, ["profile", "save", "Bad Id!"], env);
  assert.equal(badId.status, 2);
  assert.match(badId.stderr, /must match \[a-z0-9\]\[a-z0-9-_\]\{0,63\}/);

  // apply --project copies all six lanes into the Project's override file, one atomic write.
  const applied = jsonOf(await run(ownerCli, ["profile", "apply", "fast-stack", "--project", repo, "--json"], env));
  assert.equal(applied.scope, slug);
  assert.equal(applied.path, join(stateDir, "projects", slug, "lanes.json"));
  assert.equal(applied.lanes.worker, "opencode/glm-5.1");
  const projectLanes = JSON.parse(readFileSync(join(stateDir, "projects", slug, "lanes.json"), "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(projectLanes).sort(), ["freshEyes", "lead", "retro", "supervisor", "watch", "worker"], "Copy-on-Apply writes all six lanes");
  const profilesFile = JSON.parse(readFileSync(join(stateDir, "profiles.json"), "utf8")) as { activeProfileByScope?: Record<string, string> };
  assert.equal(profilesFile.activeProfileByScope?.[slug], "fast-stack", "the scope's active profile pointer is recorded");

  // list --project annotates the scope's active profile.
  const scoped = jsonOf(await run(ownerCli, ["profile", "list", "--project", repo, "--json"], env));
  assert.equal(scoped.activeProfileId, "fast-stack");

  // lanes reset --project removes the override and clears the scope pointer.
  const reset = jsonOf(await run(ownerCli, ["lanes", "reset", "--project", repo, "--json"], env));
  assert.equal(reset.removed, true);
  assert.equal(reset.project, slug);
  assert.equal(reset.lanes.worker, "opencode/glm-5.1", "the machine table stands again");
  assert.ok(!existsSync(join(stateDir, "projects", slug, "lanes.json")), "the override file is gone");
  const afterReset = JSON.parse(readFileSync(join(stateDir, "profiles.json"), "utf8")) as { activeProfileByScope?: Record<string, string> };
  assert.equal(afterReset.activeProfileByScope?.[slug], undefined, "the scope's active profile pointer is cleared");
  const resetAgain = jsonOf(await run(ownerCli, ["lanes", "reset", "--project", repo, "--json"], env));
  assert.equal(resetAgain.removed, false, "a second reset is an idempotent no-op");

  // apply --global writes the machine table and points the "global" scope.
  const globalApply = jsonOf(await run(ownerCli, ["profile", "apply", "fast-stack", "--global", "--json"], env));
  assert.equal(globalApply.scope, "global");
  assert.equal(globalApply.path, join(stateDir, "lanes.json"));
  const afterGlobal = JSON.parse(readFileSync(join(stateDir, "profiles.json"), "utf8")) as { activeProfileByScope?: Record<string, string> };
  assert.equal(afterGlobal.activeProfileByScope?.global, "fast-stack");

  // A corrupted profile lane is a named refusal at apply time — the validator mirror.
  const corrupted = {
    profiles: { "fast-stack": { name: "Fast Stack v2", lanes: { ...saved.profile.lanes, worker: "auto" }, updatedAt: "2026-10-24T00:00:00.000Z" } },
  };
  writeFileSync(join(stateDir, "profiles.json"), `${JSON.stringify(corrupted)}\n`);
  const refusedApply = await run(ownerCli, ["profile", "apply", "fast-stack", "--global"], env);
  assert.equal(refusedApply.status, 2);
  assert.match(refusedApply.stderr, /lane worker="auto"/);

  // delete keeps a tombstone and drops every scope pointer naming the profile.
  writeFileSync(join(stateDir, "profiles.json"), `${JSON.stringify(afterGlobal)}\n`); // restore the valid store
  const deleted = jsonOf(await run(ownerCli, ["profile", "delete", "fast-stack", "--json"], env));
  assert.deepEqual(deleted, { deleted: true, id: "fast-stack" });
  const tombstoned = JSON.parse(readFileSync(join(stateDir, "profiles.json"), "utf8")) as {
    profiles: Record<string, unknown>;
    deleted?: Record<string, { deletedAt: string }>;
    activeProfileByScope?: Record<string, string>;
  };
  assert.deepEqual(tombstoned.profiles, {});
  assert.equal(typeof tombstoned.deleted?.["fast-stack"]?.deletedAt, "string", "the vault merge's deletion record");
  assert.equal(tombstoned.activeProfileByScope?.global, undefined, "the global pointer naming the deleted profile is dropped");
  assert.deepEqual(jsonOf(await run(ownerCli, ["profile", "list", "--json"], env)), { profiles: [] }, "a tombstoned profile never lists");
  const deleteUnknown = await run(ownerCli, ["profile", "delete", "fast-stack"], env);
  assert.equal(deleteUnknown.status, 2);
  assert.match(deleteUnknown.stderr, /no lane profile "fast-stack" is saved/);

  // Usage refusals: a subcommand is required, apply names exactly one target, reset needs --project.
  const noSub = await run(ownerCli, ["profile"], env);
  assert.equal(noSub.status, 2);
  assert.match(noSub.stderr, /unknown subcommand/);
  const bothTargets = await run(ownerCli, ["profile", "apply", "x", "--project", repo, "--global"], env);
  assert.equal(bothTargets.status, 2);
  assert.match(bothTargets.stderr, /exactly one target/);
  const noProject = await run(ownerCli, ["lanes", "reset"], env);
  assert.equal(noProject.status, 2);
  assert.match(noProject.stderr, /--project <dir> is required/);
  const badDir = await run(ownerCli, ["lanes", "reset", "--project", join(dir, "plain")], env);
  assert.equal(badDir.status, 2);
  assert.match(badDir.stderr, /does not resolve to a git repository/);
});

test("the Lane profile store's two implementations cannot drift: plugin/bin/lanes-config.mjs mirrors the core's src/lanes.ts operations (v0.0.38, ADR 0026 §2)", async (t) => {
  // The spool semantic-key precedent: the CLIs import no src/ code (ADR 0004),
  // so every profiles.json operation exists twice — pinned here against drift.
  const core = await import("../plugin/server/core/lanes.ts");
  for (const name of ["listLaneProfiles", "getLaneProfile", "saveLaneProfile", "deleteLaneProfile", "applyLaneProfile", "saveLanesBatch", "resetProjectLanes"] as const) {
    assert.equal(typeof (core as Record<string, unknown>)[name], "function", `the core's src/lanes.ts must export ${name} (vendored into plugin/server/core/ by scripts/sync-plugin-core.mjs)`);
  }
  const bin = await import("../plugin/bin/lanes-config.mjs");

  const dir = makeTempDir();
  disposeDir(t, dir);
  const coreDir = join(dir, "core");
  const binDir = join(dir, "bin");
  mkdirSync(coreDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  /** The parsed profiles.json of one side — order-insensitive comparison. */
  const fileOf = (stateDir: string): unknown => JSON.parse(readFileSync(join(stateDir, "profiles.json"), "utf8"));

  const lanesA = {
    supervisor: "claude/claude-opus-4-6:high",
    lead: "codex/gpt-5.4",
    worker: "opencode/glm-5.1",
    watch: "pi/zai/glm-5.3",
    retro: "pi/zai/glm-5.3",
    freshEyes: "eye.json",
  };
  const lanesB = { ...lanesA, worker: "claude/claude-sonnet-4-6", freshEyes: "claude/claude-haiku-4-5" };

  // Creation: id derives from the name; explicit updatedAt keeps both sides
  // comparable. The core answers its value directly (throwing on refusal —
  // FactoryError); the bin answers the CLIs' own { ok, reason } refusal —
  // the drift compared here is behavior, never error style.
  const coreSaved = core.saveLaneProfile(coreDir, { name: "Team A", lanes: lanesA, updatedAt: "2026-10-24T10:00:00.000Z" });
  const binSaved = bin.saveLaneProfile(binDir, { name: "Team A", lanes: lanesA, updatedAt: "2026-10-24T10:00:00.000Z" });
  assert.ok(binSaved.ok, binSaved.ok ? "" : binSaved.reason);
  assert.deepEqual(binSaved.profile, coreSaved, "saveLaneProfile agrees on the whole profile record");
  assert.deepEqual(fileOf(binDir), fileOf(coreDir), "profiles.json carries the same schema on both sides");

  // A second profile with the SAME name sorts by id (list's ordering law).
  core.saveLaneProfile(coreDir, { id: "team-a-2", name: "Team A", lanes: lanesB, updatedAt: "2026-10-24T11:00:00.000Z" });
  bin.saveLaneProfile(binDir, { id: "team-a-2", name: "Team A", lanes: lanesB, updatedAt: "2026-10-24T11:00:00.000Z" });
  const coreList = core.listLaneProfiles(coreDir);
  const binList = bin.listLaneProfiles(binDir);
  assert.ok(binList.ok, binList.ok ? "" : binList.reason);
  assert.deepEqual(binList.profiles.map((p: { id: string }) => p.id), coreList.map((p: { id: string }) => p.id), "listLaneProfiles sorts by name then id identically");

  // Validation: an invalid lane refuses on both sides, writing nothing.
  assert.throws(() => core.saveLaneProfile(coreDir, { id: "broken", name: "Broken", lanes: { ...lanesA, lead: "auto" } }), /lane lead="auto"/);
  const binRefused = bin.saveLaneProfile(binDir, { id: "broken", name: "Broken", lanes: { ...lanesA, lead: "auto" } });
  assert.ok(!binRefused.ok);
  assert.match(binRefused.reason, /lane lead="auto"/);

  // Copy-on-Apply into a Project scope + the active-profile pointer.
  const slug = "demo-a1b2c3";
  const coreApplied = core.applyLaneProfile(coreDir, "team-a", slug);
  const binApplied = bin.applyLaneProfile(binDir, "team-a", slug);
  assert.ok(binApplied.ok, binApplied.ok ? "" : binApplied.reason);
  assert.deepEqual(binApplied.lanes, coreApplied.lanes);
  assert.equal(binApplied.path, join(binDir, "projects", slug, "lanes.json"));
  assert.equal(coreApplied.path, join(coreDir, "projects", slug, "lanes.json"));
  assert.deepEqual(JSON.parse(readFileSync(join(binDir, "projects", slug, "lanes.json"), "utf8")), JSON.parse(readFileSync(join(coreDir, "projects", slug, "lanes.json"), "utf8")), "the Project override file carries the same six lanes");
  assert.deepEqual(fileOf(binDir), fileOf(coreDir), "the activeProfileByScope pointer matches");

  // Batch save parity: one partial multi-lane update, one file.
  const coreBatch = core.saveLanesBatch(coreDir, { watch: "copilot/gpt-5.4", retro: "copilot/gpt-5.4" }, slug);
  const binBatch = bin.saveLanesBatch(binDir, { watch: "copilot/gpt-5.4", retro: "copilot/gpt-5.4" }, slug);
  assert.ok(binBatch.ok, binBatch.ok ? "" : binBatch.reason);
  assert.deepEqual(binBatch.lanes, coreBatch.lanes);
  assert.deepEqual(JSON.parse(readFileSync(join(binDir, "projects", slug, "lanes.json"), "utf8")), JSON.parse(readFileSync(join(coreDir, "projects", slug, "lanes.json"), "utf8")));

  // Reset removes the override, clears the pointer, and returns the machine table.
  const coreReset = core.resetProjectLanes(coreDir, slug);
  const binReset = bin.resetProjectLanes(binDir, slug);
  assert.ok(binReset.ok, binReset.ok ? "" : binReset.reason);
  assert.equal(binReset.removed, coreReset.removed);
  assert.deepEqual(binReset.lanes, coreReset.lanes);
  assert.ok(!existsSync(join(binDir, "projects", slug, "lanes.json")));
  assert.deepEqual(fileOf(binDir), fileOf(coreDir));

  // Deletion: tombstone + every scope pointer naming the profile goes.
  assert.equal(core.deleteLaneProfile(coreDir, "team-a", "2026-10-24T12:00:00.000Z"), true);
  const binDeleted = bin.deleteLaneProfile(binDir, "team-a", "2026-10-24T12:00:00.000Z");
  assert.ok(binDeleted.ok && binDeleted.deleted === true);
  assert.deepEqual(fileOf(binDir), fileOf(coreDir), "tombstone shapes match");
  const goneBin = bin.getLaneProfile(binDir, "team-a");
  assert.ok(goneBin.ok);
  assert.deepEqual(goneBin.profile, core.getLaneProfile(coreDir, "team-a"), "a deleted profile answers identically on both sides");

  // A damaged profiles.json refuses the reset BEFORE the override file is
  // touched — the core throws (FactoryError), the bin answers { ok: false }
  // naming the file, and neither half-applies the reset
  // (validate-before-mutate, the loadLanes law).
  core.applyLaneProfile(coreDir, "team-a-2", slug);
  bin.applyLaneProfile(binDir, "team-a-2", slug);
  writeFileSync(join(coreDir, "profiles.json"), "{ broken");
  writeFileSync(join(binDir, "profiles.json"), "{ broken");
  assert.throws(() => core.resetProjectLanes(coreDir, slug), /profiles\.json is not valid JSON/);
  const binResetDamaged = bin.resetProjectLanes(binDir, slug);
  assert.ok(!binResetDamaged.ok, "the bin refuses a damaged profiles.json instead of silently succeeding");
  assert.match(binResetDamaged.reason, /profiles\.json is not valid JSON/);
  assert.equal(existsSync(join(coreDir, "projects", slug, "lanes.json")), true, "the core's refusal leaves the override file in place — never a half-applied reset");
  assert.equal(existsSync(join(binDir, "projects", slug, "lanes.json")), true, "the bin's refusal leaves the override file in place identically");
});


