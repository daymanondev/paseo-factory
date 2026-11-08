#!/usr/bin/env node
/**
 * Smoke test for ticket 08 — the mechanical DoD, no live agent.
 *
 * Runs both CLIs against a REAL daemon's spool (the plugin must be loaded and
 * running on that daemon) and asserts the whole loop end to end: the Owner
 * sets a contract, the agent claims a broken commit (red verdict + note +
 * report), fixes the work and claims the fix (green, attempt 2), and the Owner
 * accepts the green attempt. Leaves the ledger lines, spool records and
 * reports behind on purpose — they are the audit trail of this run.
 *
 * Usage:
 *   node scripts/smoke-loop.mjs --home ~/.paseo-factory [--keep]
 *
 * --home is required on purpose: never point this at the default ~/.paseo.
 * --keep leaves the scratch workspace behind instead of deleting it.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// ---- args -----------------------------------------------------------------------------

const argv = process.argv.slice(2);
const homeFlag = argv.includes("--home") ? argv[argv.indexOf("--home") + 1] : undefined;
const keep = argv.includes("--keep");
if (homeFlag === undefined || homeFlag === "") {
  console.error("smoke: --home <paseoHome> is required (point it at the trial daemon, never ~/.paseo)");
  process.exit(2);
}
const home = homeFlag.startsWith("~") ? join(homedir(), homeFlag.slice(2)) : homeFlag;
const stateDir = join(home, "plugin-state", "paseo-factory");

const step = (name) => console.log(`\n== ${name}`);
const die = (message) => {
  console.error(`\nSMOKE FAIL: ${message}`);
  process.exit(1);
};

// ---- preflight -------------------------------------------------------------------------

step("preflight");
if (!existsSync(join(stateDir, "bin", "factory-claim"))) {
  die(`no claim CLI wrapper at ${join(stateDir, "bin", "factory-claim")} — is the plugin installed and running on this home?`);
}
console.log(`state dir: ${stateDir}`);

// ---- scratch workspace ------------------------------------------------------------------

const stamp = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
const task = `smoke08-${stamp}`;
const workspace = join(stateDir, `smoke-workspace-${stamp}`);
const agentEnv = { ...process.env, FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "smoke-script" };
const ownerEnv = { ...process.env, PASEO_HOME: home };

const run = (command, args, env, expectStatus, label) => {
  const result = spawnSync(command, args, { encoding: "utf8", env, timeout: 10 * 60_000 });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  console.log(`$ ${label}\n${out.split("\n").map((l) => `  ${l}`).join("\n")}`);
  if (result.status !== expectStatus) {
    die(`${label}: expected exit ${expectStatus}, got ${result.status === null ? "signal/killed" : result.status}`);
  }
  return out;
};

try {
  step(`scratch workspace ${workspace}`);
  cpSync(join(repoRoot, "fixtures", "sample-workspace"), workspace, { recursive: true });
  const git = (args) => spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "smoke@example.com"]);
  git(["config", "user.name", "Factory Smoke"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "broken pad"]);
  const brokenSha = git(["rev-parse", "HEAD"]).stdout.trim();
  console.log(`broken commit: ${brokenSha}`);

  // ---- the loop -------------------------------------------------------------------------

  step("owner sets the contract");
  // The gate runs as a child of the PLUGIN process, under the daemon's PATH —
  // which has no nvm. The gate command is the Owner's contract content, so it
  // names the node binary absolutely (this smoke's own node).
  const gate = `${process.execPath} --test --test-reporter=tap`;
  run(
    process.execPath,
    [join(repoRoot, "plugin", "bin", "factory.mjs"), "--home", home, "contract",
      "--task", task, "--workspace", workspace, "--gate", gate, "--artifact", "src/format.ts"],
    ownerEnv,
    0,
    "factory contract",
  );

  step("agent claims the broken commit — expect RED (exit 1)");
  const red = run(
    process.execPath,
    [join(repoRoot, "plugin", "bin", "factory-claim.mjs"), "--task", task, "--outcome", "complete", "--scope", "battery arm", "--verification", "battery gate", "--unknowns", "none", "--sha", brokenSha],
    agentEnv,
    1,
    "factory-claim (broken)",
  );
  if (!/attempt 1 — RED/.test(red) || !/report: .*report-.*-1\.md/.test(red) || !/note: /.test(red)) {
    die("the red reply must carry attempt 1, the report path and the gate note");
  }

  step("agent fixes the work and claims the fix — expect GREEN attempt 2 (exit 0)");
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
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fix pad to truncate and pad correctly"]);
  const fixedSha = git(["rev-parse", "HEAD"]).stdout.trim();
  const green = run(
    process.execPath,
    [join(repoRoot, "plugin", "bin", "factory-claim.mjs"), "--task", task, "--outcome", "complete", "--scope", "battery arm", "--verification", "battery gate", "--unknowns", "none", "--sha", fixedSha],
    agentEnv,
    0,
    "factory-claim (fixed)",
  );
  if (!/attempt 2 — GREEN/.test(green)) die("the green reply must be attempt 2");

  step("owner accepts the green attempt");
  run(
    process.execPath,
    [join(repoRoot, "plugin", "bin", "factory.mjs"), "--home", home, "accept", task, "--attempt", "2"],
    ownerEnv,
    0,
    "factory accept",
  );

  // ---- assertions over the durable state ------------------------------------------------

  step("ledger and reports");
  const lines = readFileSync(join(stateDir, "ledger.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  const mine = lines.filter((e) => e.task === task);
  const names = mine.map((e) => e.event);
  const expected = [
    "contract_set",
    "claim_reported", "gate_started", "gate_finished", "report_written",
    "claim_reported", "gate_started", "gate_finished", "report_written",
    "attempt_accepted",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    die(`ledger sequence for ${task}:\n  got      ${JSON.stringify(names)}\n  expected ${JSON.stringify(expected)}`);
  }
  for (const n of [1, 2]) {
    if (!existsSync(join(stateDir, `report-${task}-${n}.md`))) die(`missing report-${task}-${n}.md`);
  }
  console.log(`ledger events for ${task}: ${names.join(" → ")}`);
  console.log(`reports: report-${task}-{1,2}.md present`);
  console.log(`\nSMOKE PASS — the loop is mechanically complete on ${home}`);
} finally {
  if (!keep && workspace.startsWith(stateDir)) {
    rmSync(workspace, { recursive: true, force: true });
    console.log(`\n(cleaned scratch workspace; ledger, reports and spool records kept as the audit trail)`);
  }
}
