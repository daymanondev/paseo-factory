#!/usr/bin/env node
/**
 * Fresh-eyes smoke test (ticket 05 DoD, v0.0.2) — the eye, live, through the
 * trial daemon's plugin.
 *
 * Same shape as smoke-loop.mjs, plus the mark: the Owner sets the Contract
 * with --fresh-eyes (after checking <stateDir>/eye.json exists — this script
 * never creates credentials), the agent's red attempt must NOT wake the eye,
 * and the green attempt must produce `fresh_eyes_written` between
 * gate_finished and report_written, rendered in the report. The eye's real
 * model answers (CLIProxyAPI → gemini-3.8-flash-high by default), so the
 * pass takes as long as the model takes, inside the 60s budget.
 *
 * Usage:
 *   node scripts/smoke-fresh-eyes.mjs --home ~/.paseo-factory [--keep]
 *
 * --home is required on purpose: never point this at the default ~/.paseo.
 * --keep leaves the scratch workspace behind instead of deleting it.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const eyePath = join(stateDir, "eye.json");
if (!existsSync(eyePath)) {
  die(
    `no eye config at ${eyePath} — create it as {"provider","model","apiKey","baseUrl"} (mode 600), ` +
      `then re-run. This script never creates credentials.`,
  );
}
let eyeModel = "unknown";
try {
  const eye = JSON.parse(readFileSync(eyePath, "utf8"));
  eyeModel = eye.model;
  for (const field of ["provider", "model", "apiKey", "baseUrl"]) {
    if (typeof eye[field] !== "string" || eye[field].trim() === "") die(`${eyePath} has no usable "${field}"`);
  }
} catch (err) {
  die(`${eyePath} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
}
console.log(`state dir: ${stateDir}`);
console.log(`eye: ${eyeModel} (config OK)`);

// ---- scratch workspace ------------------------------------------------------------------

const stamp = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
const task = `eye05-${stamp}`;
const workspace = join(stateDir, `smoke-workspace-${stamp}`);
const agentEnv = { ...process.env, FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "smoke-fresh-eyes" };
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

  step("owner sets the contract — fresh eyes ON");
  // The gate runs under the daemon's PATH (no nvm), so the contract names the
  // node binary absolutely (this smoke's own node).
  const gate = `${process.execPath} --test --test-reporter=tap`;
  run(
    process.execPath,
    [join(repoRoot, "plugin", "bin", "factory.mjs"), "--home", home, "contract",
      "--task", task, "--workspace", workspace, "--gate", gate, "--artifact", "src/format.ts", "--fresh-eyes"],
    ownerEnv,
    0,
    "factory contract --fresh-eyes",
  );

  step("agent claims the broken commit — RED, and the eye stays asleep");
  run(
    process.execPath,
    [join(repoRoot, "plugin", "bin", "factory-claim.mjs"), "--task", task, "--outcome", "complete", "--scope", "battery arm", "--verification", "battery gate", "--unknowns", "none", "--sha", brokenSha],
    agentEnv,
    1,
    "factory-claim (broken)",
  );

  step("agent fixes the work and claims — GREEN attempt 2, then the eye reads it");
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
  run(
    process.execPath,
    [join(repoRoot, "plugin", "bin", "factory-claim.mjs"), "--task", task, "--outcome", "complete", "--scope", "battery arm", "--verification", "battery gate", "--unknowns", "none", "--sha", fixedSha],
    agentEnv,
    0,
    "factory-claim (fixed)",
  );

  // ---- assertions over the durable state ------------------------------------------------

  step("ledger, eye line, gate log, report");
  const lines = readFileSync(join(stateDir, "ledger.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  const mine = lines.filter((e) => e.task === task);
  const names = mine.map((e) => e.event);
  const expected = [
    "contract_set",
    "claim_reported", "gate_started", "gate_finished", "report_written",
    "claim_reported", "gate_started", "gate_finished", "fresh_eyes_written", "report_written",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    die(`ledger sequence for ${task}:\n  got      ${JSON.stringify(names)}\n  expected ${JSON.stringify(expected)}`);
  }
  if (mine[0].freshEyes !== true || typeof mine[0].base !== "string") {
    die("the contract must carry freshEyes: true and its base commit (ticket 03 R2)");
  }
  const claim2 = mine.findLast((e) => e.event === "claim_reported");
  if (claim2.agent !== "smoke-fresh-eyes") die(`claim_reported.agent is ${claim2.agent ?? "absent"} (ticket 02b)`);
  const gate2 = mine.findLast((e) => e.event === "gate_finished");
  if (typeof gate2.outputPath !== "string" || !existsSync(gate2.outputPath)) {
    die("gate_finished.outputPath must point at the persisted full output (ticket 02a)");
  }

  const eye = mine.findLast((e) => e.event === "fresh_eyes_written");
  console.log(`eye event: model=${eye.model} outcome=${eye.outcome} durationMs=${eye.durationMs}`);
  console.log(`eye finding: ${eye.finding}`);
  if (eye.model !== eyeModel) die(`the event must name the configured model (${eyeModel}), got ${eye.model}`);
  if (eye.outcome === "failed") {
    die(`the eye pass failed: ${eye.finding} — fix the environment (proxy up? key valid?) and re-run`);
  }

  const report2 = readFileSync(join(stateDir, `report-${task}-2.md`), "utf8");
  const verdictAt = report2.indexOf("- Verdict: GREEN");
  const eyeAt = report2.indexOf(`- Fresh eyes (\`${eye.model}\`)`);
  const closingAt = report2.indexOf("- Evidence, not acceptance");
  if (verdictAt === -1 || eyeAt === -1 || closingAt === -1 || !(verdictAt < eyeAt && eyeAt < closingAt)) {
    die(`the report must render the eye's line between the verdict and the closing language:\n${report2}`);
  }
  if (!report2.includes("- Claimed by agent `smoke-fresh-eyes`")) die("the report must name the claiming agent");

  step("owner accepts the green attempt");
  run(
    process.execPath,
    [join(repoRoot, "plugin", "bin", "factory.mjs"), "--home", home, "accept", task, "--attempt", "2"],
    ownerEnv,
    0,
    "factory accept",
  );

  console.log(`\nSMOKE PASS — fresh-eyes ran live on ${home}: outcome=${eye.outcome} in ${eye.durationMs}ms via ${eye.model}`);
} finally {
  if (!keep && workspace.startsWith(stateDir)) {
    rmSync(workspace, { recursive: true, force: true });
    console.log(`\n(cleaned scratch workspace; ledger, reports, gate log and spool records kept as the audit trail)`);
  }
}
