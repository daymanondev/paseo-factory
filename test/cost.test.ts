import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

/**
 * `factory cost` (v0.0.8, ticket 03 items 4–5) — the Cost read's rendering,
 * against hand-written ledgers with exact timestamps so every derived
 * duration is assertable to the character: the three honest cost states plus
 * the duration-only row, the re-run rule (latest meter wins), the ts-pair
 * derivations (wall = first spawn → last verdict, gate summed over paired
 * attempts), the per-lane totals with median/total wall, and the corpus
 * counts. Like status, cost is a local read — no spool, no plugin.
 */

const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async on purpose: a sync spawn would block this process's event loop. */
function run(args: string[], extraEnv: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ownerCli, ...args], { env: { ...process.env, ...extraEnv } });
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

function writeLedger(stateDir: string, events: Record<string, unknown>[]): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

const full = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

function contract(seq: number, task: string, ts: string): Record<string, unknown> {
  return { seq, ts, event: "contract_set", task, workspace: "/tmp/ws", gate: "true", artifact: "src/format.ts" };
}

test("the Cost read: rows with the three cost states + the duration-only row, then lane and corpus totals", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");

  // M-CLAUDE: two attempts (gate 35s + 30s), metered $2.65 after the second.
  // M-COPILOT: one attempt, 0.2s gate, a copilot meter with tokens but no
  // dollars — the subscription lane's stated fact. M-NULL: a claude meter
  // with an empty usage — capture ran, the lane reported nothing. M-OLD:
  // pre-0.0.8 shape — spawn and attempts but no meter line ever.
  writeLedger(stateDir, [
    contract(1, "M-CLAUDE", "2026-10-10T10:00:00.000Z"),
    { seq: 2, ts: "2026-10-10T10:00:10.000Z", event: "spawn_dispatched", task: "M-CLAUDE", provider: "claude/claude-sonnet-5", arity: 1 },
    { seq: 3, ts: "2026-10-10T10:09:00.000Z", event: "claim_reported", task: "M-CLAUDE", attempt: 1, sha: full, agent: "ag-1" },
    { seq: 4, ts: "2026-10-10T10:09:00.100Z", event: "gate_started", task: "M-CLAUDE", attempt: 1, cmd: "true" },
    { seq: 5, ts: "2026-10-10T10:09:35.100Z", event: "gate_finished", task: "M-CLAUDE", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    { seq: 6, ts: "2026-10-10T10:09:36.000Z", event: "report_written", task: "M-CLAUDE", attempt: 1, path: "/s/report-M-CLAUDE-1.md" },
    { seq: 7, ts: "2026-10-10T10:11:00.000Z", event: "claim_reported", task: "M-CLAUDE", attempt: 2, sha: full, agent: "ag-1" },
    { seq: 8, ts: "2026-10-10T10:11:00.100Z", event: "gate_started", task: "M-CLAUDE", attempt: 2, cmd: "true" },
    { seq: 9, ts: "2026-10-10T10:11:30.100Z", event: "gate_finished", task: "M-CLAUDE", attempt: 2, exit: 0, verdict: "green", note: "", sha: full },
    { seq: 10, ts: "2026-10-10T10:11:31.000Z", event: "report_written", task: "M-CLAUDE", attempt: 2, path: "/s/report-M-CLAUDE-2.md" },
    { seq: 11, ts: "2026-10-10T10:11:31.500Z", event: "meter_written", task: "M-CLAUDE", provider: "claude/claude-sonnet-5", usage: { inputTokens: 84_000, outputTokens: 10_000, totalCostUsd: 2.65 }, agent: "ag-1" },

    contract(12, "M-COPILOT", "2026-10-10T10:10:00.000Z"),
    { seq: 13, ts: "2026-10-10T10:10:05.000Z", event: "spawn_dispatched", task: "M-COPILOT", provider: "copilot/gpt-5.4", arity: 1 },
    { seq: 14, ts: "2026-10-10T10:12:00.000Z", event: "claim_reported", task: "M-COPILOT", attempt: 1, sha: full, agent: "ag-2" },
    { seq: 15, ts: "2026-10-10T10:12:00.200Z", event: "gate_started", task: "M-COPILOT", attempt: 1, cmd: "true" },
    { seq: 16, ts: "2026-10-10T10:12:00.400Z", event: "gate_finished", task: "M-COPILOT", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    { seq: 17, ts: "2026-10-10T10:12:01.000Z", event: "report_written", task: "M-COPILOT", attempt: 1, path: "/s/report-M-COPILOT-1.md" },
    { seq: 18, ts: "2026-10-10T10:12:01.500Z", event: "meter_written", task: "M-COPILOT", provider: "copilot/gpt-5.4", usage: { inputTokens: 1_200, outputTokens: 300 }, agent: "ag-2" },

    contract(19, "M-NULL", "2026-10-10T10:20:00.000Z"),
    { seq: 20, ts: "2026-10-10T10:20:00.500Z", event: "spawn_dispatched", task: "M-NULL", provider: "claude/claude-sonnet-5", arity: 1 },
    { seq: 21, ts: "2026-10-10T10:21:00.000Z", event: "claim_reported", task: "M-NULL", attempt: 1, sha: full, agent: "ag-3" },
    { seq: 22, ts: "2026-10-10T10:21:00.100Z", event: "gate_started", task: "M-NULL", attempt: 1, cmd: "true" },
    { seq: 23, ts: "2026-10-10T10:21:02.100Z", event: "gate_finished", task: "M-NULL", attempt: 1, exit: 1, verdict: "red", note: "fail", sha: full },
    { seq: 24, ts: "2026-10-10T10:21:02.500Z", event: "report_written", task: "M-NULL", attempt: 1, path: "/s/report-M-NULL-1.md" },
    { seq: 25, ts: "2026-10-10T10:21:03.000Z", event: "meter_written", task: "M-NULL", provider: "claude/claude-sonnet-5", usage: {}, agent: "ag-3" },

    contract(26, "M-OLD", "2026-10-10T10:30:00.000Z"),
    { seq: 27, ts: "2026-10-10T10:30:10.000Z", event: "spawn_dispatched", task: "M-OLD", provider: "claude/opus-4-8", arity: 1 },
    { seq: 28, ts: "2026-10-10T10:56:10.000Z", event: "claim_reported", task: "M-OLD", attempt: 1, sha: full, agent: "ag-4" },
    { seq: 29, ts: "2026-10-10T10:56:10.100Z", event: "gate_started", task: "M-OLD", attempt: 1, cmd: "true" },
    { seq: 30, ts: "2026-10-10T11:12:10.100Z", event: "gate_finished", task: "M-OLD", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    { seq: 31, ts: "2026-10-10T11:12:11.000Z", event: "report_written", task: "M-OLD", attempt: 1, path: "/s/report-M-OLD-1.md" },

    // Factory-level and unbound events invent no row and crash no read.
    { seq: 32, ts: "2026-10-10T11:20:00.000Z", event: "retro_written", model: "copilot/gpt-5.4", outcome: "written", durationMs: 40_000, proposalsPath: "/s/retro.md", proposalCount: 2 },
    { seq: 33, ts: "2026-10-10T11:21:00.000Z", event: "git_blocked", command: "git clean -fd", rule: "git:clean-force", reason: "r", cwd: "/elsewhere", blockId: "b1" },
    { seq: 34, ts: "2026-10-10T11:22:00.000Z", event: "spawn_refused", task: "M-GHOST", provider: "claude", arity: 1, rule: "spawn:unknown-task", reason: "no contract" },
  ]);

  const result = await run(["cost"], { PASEO_HOME: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "M-CLAUDE lane=claude/claude-sonnet-5 attempts=2 wall=11m20s gate=1m05s cost=$2.65",
      "M-COPILOT lane=copilot/gpt-5.4 attempts=1 wall=1m55s gate=0.2s cost=$0 marginal (subscription lane)",
      "M-NULL lane=claude/claude-sonnet-5 attempts=1 wall=1m02s gate=2.0s cost=—",
      "M-OLD lane=claude/opus-4-8 attempts=1 wall=42m00s gate=16m00s",
      "",
      "lane=claude tasks=3 wall-median=11m20s wall-total=54m22s metered=$2.65 unmetered-rows=2",
      "lane=copilot tasks=1 wall-median=1m55s wall-total=1m55s metered=- unmetered-rows=1",
      "corpus rows=4 metered-rows=1 unmetered-rows=3",
    ].join("\n") + "\n",
  );
});

test("a re-run task re-meters; the read takes the latest line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  writeLedger(stateDir, [
    contract(1, "M-RE", "2026-10-10T09:00:00.000Z"),
    { seq: 2, ts: "2026-10-10T09:00:10.000Z", event: "spawn_dispatched", task: "M-RE", provider: "claude/claude-sonnet-5", arity: 1 },
    { seq: 3, ts: "2026-10-10T09:02:00.000Z", event: "claim_reported", task: "M-RE", attempt: 1, sha: full },
    { seq: 4, ts: "2026-10-10T09:02:00.100Z", event: "gate_started", task: "M-RE", attempt: 1, cmd: "true" },
    { seq: 5, ts: "2026-10-10T09:02:02.100Z", event: "gate_finished", task: "M-RE", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    { seq: 6, ts: "2026-10-10T09:02:03.000Z", event: "report_written", task: "M-RE", attempt: 1, path: "/s/r.md" },
    { seq: 7, ts: "2026-10-10T09:02:03.500Z", event: "meter_written", task: "M-RE", provider: "claude/claude-sonnet-5", usage: { totalCostUsd: 2.65 } },
    // The re-run: a second meter line, the read's source now.
    { seq: 8, ts: "2026-10-10T09:30:00.000Z", event: "meter_written", task: "M-RE", provider: "claude/claude-sonnet-5", usage: { totalCostUsd: 3.4 } },
  ]);

  const result = await run(["cost"], { PASEO_HOME: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^M-RE .* cost=\$3\.40$/m);
  assert.match(result.stdout, /^lane=claude tasks=1 .* metered=\$3\.40 /m, "the lane total sums the latest lines, not every line");
});

test("a task the driver never ran: no lane, nothing derivable, counted in the corpus only", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  writeLedger(stateDir, [
    contract(1, "M-OWNER", "2026-10-10T09:00:00.000Z"),
    { seq: 2, ts: "2026-10-10T09:05:00.000Z", event: "claim_reported", task: "M-OWNER", attempt: 1, sha: full },
    { seq: 3, ts: "2026-10-10T09:05:00.100Z", event: "gate_started", task: "M-OWNER", attempt: 1, cmd: "true" },
    { seq: 4, ts: "2026-10-10T09:05:02.100Z", event: "gate_finished", task: "M-OWNER", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    // A claim with no spawn: wall is not derivable (no first-spawn end), and
    // the gate pair still sums — 2s.
  ]);

  const result = await run(["cost"], { PASEO_HOME: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    ["M-OWNER lane=- attempts=1 wall=- gate=2.0s", "", "corpus rows=1 metered-rows=0 unmetered-rows=1"].join("\n") + "\n",
    "no lane line for a lane-less corpus; the row stays duration-honest",
  );
});

test("a spawned task with no verdict yet: wall censored to -, the row still counts", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  writeLedger(stateDir, [
    contract(1, "M-LIVE", "2026-10-10T09:00:00.000Z"),
    { seq: 2, ts: "2026-10-10T09:00:10.000Z", event: "spawn_dispatched", task: "M-LIVE", provider: "claude/claude-sonnet-5", arity: 1 },
    { seq: 3, ts: "2026-10-10T09:01:00.000Z", event: "meter_written", task: "M-LIVE", provider: "claude/claude-sonnet-5", usage: {} },
  ]);

  const result = await run(["cost"], { PASEO_HOME: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "M-LIVE lane=claude/claude-sonnet-5 attempts=0 wall=- gate=- cost=—",
      "",
      "lane=claude tasks=1 wall-median=- wall-total=- metered=- unmetered-rows=1",
      "corpus rows=1 metered-rows=0 unmetered-rows=1",
    ].join("\n") + "\n",
    "a wall needs both ts ends; a median of no walls is an honest dash",
  );
});

test("cost treats a missing or empty ledger as no tasks, and refuses positionals and unreadable ledgers", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");

  const missing = await run(["cost"], { PASEO_HOME: dir });
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /no tasks yet/);
  assert.match(missing.stdout, /ledger\.jsonl/);

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.jsonl"), "");
  const empty = await run(["cost"], { PASEO_HOME: dir });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /no tasks yet/);

  const positional = await run(["cost", "M-CLAUDE"], { PASEO_HOME: dir });
  assert.equal(positional.status, 2);
  assert.match(positional.stderr, /cost: unexpected positional "M-CLAUDE"/);
  assert.match(positional.stderr, /scope with --project/);

  writeFileSync(join(stateDir, "ledger.jsonl"), "not json\n");
  const unreadable = await run(["cost"], { PASEO_HOME: dir });
  assert.equal(unreadable.status, 2);
  assert.equal(unreadable.stdout, "");
  assert.match(unreadable.stderr, /not a readable ledger/);
});

test("v0.0.92 (ADR 0045 §1): cost reads each registered Project's isolated ledger — --project scopes, unscoped aggregates with the [slug] prefix, and never reads an absent root ledger", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");

  // Two registered Projects, each with its own isolated ledger — and NO root
  // ledger anywhere (the post-0.0.89 machine shape).
  const slugA = "alpha-111111";
  const slugB = "beta-222222";
  const metered = (task: string, dollars: number, ts: string): Record<string, unknown>[] => [
    contract(1, task, ts),
    { seq: 2, ts, event: "spawn_dispatched", task, provider: "claude/claude-sonnet-5", arity: 1 },
    { seq: 3, ts, event: "claim_reported", task, attempt: 1, sha: full },
    { seq: 4, ts, event: "gate_started", task, attempt: 1, cmd: "true" },
    { seq: 5, ts, event: "gate_finished", task, attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    { seq: 6, ts, event: "meter_written", task, provider: "claude/claude-sonnet-5", usage: { totalCostUsd: dollars } },
  ];
  mkdirSync(join(stateDir, "projects", slugA), { recursive: true });
  mkdirSync(join(stateDir, "projects", slugB), { recursive: true });
  writeFileSync(join(stateDir, "projects", slugA, "project.json"), `${JSON.stringify({ root: "/tmp/alpha", slug: slugA }, null, 2)}\n`);
  writeFileSync(join(stateDir, "projects", slugB, "project.json"), `${JSON.stringify({ root: "/tmp/beta", slug: slugB }, null, 2)}\n`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "projects", slugA, "ledger.jsonl"), `${metered("A-01", 1.25, "2026-10-10T10:00:00.000Z").map((e) => JSON.stringify(e)).join("\n")}\n`);
  writeFileSync(join(stateDir, "projects", slugB, "ledger.jsonl"), `${metered("B-01", 2.5, "2026-10-10T11:00:00.000Z").map((e) => JSON.stringify(e)).join("\n")}\n`);

  // Unscoped: every registered Project's rows, each prefixed with its slug —
  // `factory status`'s aggregate law — never an empty root-ledger read.
  const aggregate = await run(["cost"], { PASEO_HOME: dir });
  assert.equal(aggregate.status, 0, aggregate.stderr);
  assert.match(aggregate.stdout, /^\[alpha-111111\] A-01 .* cost=\$1\.25$/m);
  assert.match(aggregate.stdout, /^\[beta-222222\] B-01 .* cost=\$2\.50$/m);
  assert.doesNotMatch(aggregate.stdout, /no tasks yet/);

  // Scoped: one Project's rows, unprefixed.
  const scoped = await run(["cost", "--project", slugA], { PASEO_HOME: dir });
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.match(scoped.stdout, /^A-01 .* cost=\$1\.25$/m);
  assert.doesNotMatch(scoped.stdout, /B-01/);
  assert.doesNotMatch(scoped.stdout, /\[/);

  // An unregistered slug is a named refusal, never a guess.
  const unknown = await run(["cost", "--project", "ghost"], { PASEO_HOME: dir });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /project "ghost" is not registered/);

  // A registered Project with no events yet names ITS ledger, not the root.
  const slugC = "gamma-333333";
  mkdirSync(join(stateDir, "projects", slugC), { recursive: true });
  writeFileSync(join(stateDir, "projects", slugC, "project.json"), `${JSON.stringify({ root: "/tmp/gamma", slug: slugC }, null, 2)}\n`);
  const emptyProject = await run(["cost", "--project", slugC], { PASEO_HOME: dir });
  assert.equal(emptyProject.status, 0, emptyProject.stderr);
  assert.match(emptyProject.stdout, /no tasks yet/);
  assert.match(emptyProject.stdout, new RegExp(`projects/${slugC}/ledger\\.jsonl`));
});
