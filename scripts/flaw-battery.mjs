#!/usr/bin/env node
/**
 * The flaw battery (v0.0.3, ticket 02) — the instrument ticket 03 runs live.
 *
 * For every arm under fixtures/flaw-battery/: clone the arm's clean workspace
 * to a stamped scratch home, commit the base, let the Owner set the Contract
 * (--fresh-eyes, scoped for arms that declare a scope, unscoped otherwise),
 * plant the arm's flaw overlay as the work commit, claim it as the agent, and
 * assert the ledger sequence. One green claim per arm; the eye's outcome +
 * finding print per arm. A technically `failed` eye gets exactly one re-run
 * of that arm (the map's pre-registered rule).
 *
 * The runner never judges hit/miss — that is ticket 03's operator act against
 * the map's pre-registered rules and each arm's recorded ground truth. It
 * never accepts anything, and it never creates or reads credentials beyond
 * the daemon's own eye.json (pre-flight validates it, live, read-only).
 *
 * Usage:
 *   node scripts/flaw-battery.mjs --home ~/.paseo-factory [--arm <name>] [--keep]
 *
 * --home is required on purpose and the default ~/.paseo is refused: never
 * point this at prod. --arm runs a single arm by directory name (re-runs).
 * --keep leaves the scratch workspaces behind instead of deleting them.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TASK_ID_PATTERN, createScratchRegistry, die, ledgerLines, parseBatteryArgs, run, stamp, step } from "./battery-lib.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const batteryRoot = join(repoRoot, "fixtures", "flaw-battery");
const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");
const claimCli = join(repoRoot, "plugin", "bin", "factory-claim.mjs");
const { armFlag, keep, home, stateDir } = parseBatteryArgs("flaw-battery");
const workspaces = createScratchRegistry(stateDir);

try {
  // ---- arms ----------------------------------------------------------------------------

  function loadArms() {
    const arms = [];
    for (const name of readdirSync(batteryRoot).sort()) {
      const armDir = join(batteryRoot, name);
      if (!existsSync(join(armDir, "arm.json"))) continue;
      let meta;
      try {
        meta = JSON.parse(readFileSync(join(armDir, "arm.json"), "utf8"));
      } catch (err) {
        die(`${name}/arm.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      for (const field of ["taskPrefix", "artifact", "commitMessage"]) {
        if (typeof meta[field] !== "string" || meta[field].trim() === "") die(`${name}/arm.json has no usable "${field}" string`);
      }
      if (!TASK_ID_PATTERN.test(meta.taskPrefix)) {
        die(`${name}/arm.json taskPrefix "${meta.taskPrefix}" is not a valid task id prefix (letters, digits, ".", "_", "-")`);
      }
      if (!existsSync(join(armDir, "workspace"))) die(`${name} has no workspace/ directory`);
      if (!existsSync(join(armDir, "flaw"))) die(`${name} has no flaw/ overlay directory`);
      if (meta.scope !== undefined && (!Array.isArray(meta.scope) || meta.scope.some((s) => typeof s !== "string" || s.trim() === ""))) {
        die(`${name}/arm.json scope must be an array of workspace-relative prefixes, or absent for an unscoped contract`);
      }
      arms.push({ name, dir: armDir, ...meta });
    }
    if (arms.length === 0) die(`no arms found under ${batteryRoot}`);
    return arms;
  }

  const arms = loadArms();
  const selected = armFlag === undefined ? arms : arms.filter((arm) => arm.name === armFlag);
  if (armFlag !== undefined && selected.length === 0) {
    die(`--arm "${armFlag}" matches nothing — available: ${arms.map((a) => a.name).join(", ")}`);
  }
  console.log(`arms: ${selected.map((a) => a.name).join(", ")}`);

  // ---- preflight -----------------------------------------------------------------------

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
  let eye;
  try {
    eye = JSON.parse(readFileSync(eyePath, "utf8"));
  } catch (err) {
    die(`${eyePath} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  eyeModel = eye.model;
  for (const field of ["provider", "model", "apiKey", "baseUrl"]) {
    if (typeof eye[field] !== "string" || eye[field].trim() === "") die(`${eyePath} has no usable "${field}"`);
  }
  console.log(`state dir: ${stateDir}`);
  console.log(`eye: ${eyeModel} (config OK)`);

  // ---- one arm --------------------------------------------------------------------------

  const agentEnv = { ...process.env, FACTORY_STATE_DIR: stateDir, PASEO_AGENT_ID: "flaw-battery" };
  const ownerEnv = { ...process.env, PASEO_HOME: home };
  // The gate runs under the daemon's PATH (no nvm), so the contract names the
  // node binary absolutely — this script's own node (the live-run lesson).
  const gate = `${process.execPath} --test --test-reporter=tap`;

  /** Copies each flaw/ entry over the workspace — existing files overwrite, dirs merge. */
  function overlay(flawDir, workspace) {
    for (const entry of readdirSync(flawDir)) {
      cpSync(join(flawDir, entry), join(workspace, entry), { recursive: true, force: true });
    }
  }

  /**
   * One arm, one task id: contract at the clean base, planted flaw as the work
   * commit, one claim, asserted ledger. Returns the eye's outcome for the arm.
   */
  function runArm(arm) {
    const task = `${arm.taskPrefix}-${stamp()}`;
    const workspace = workspaces.add(join(stateDir, `battery-ws-${task}`));

    step(`${arm.name} → ${task}`);
    cpSync(join(arm.dir, "workspace"), workspace, { recursive: true });
    const git = (args) => spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "battery@example.com"]);
    git(["config", "user.name", "Flaw Battery"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "clean base"]);

    run(
      process.execPath,
      [ownerCli, "--home", home, "contract",
        "--task", task, "--workspace", workspace, "--gate", gate, "--artifact", arm.artifact,
        ...(arm.scope === undefined ? [] : ["--scope", arm.scope.join(",")]),
        "--fresh-eyes"],
      ownerEnv,
      0,
      `factory contract --fresh-eyes${arm.scope === undefined ? " (unscoped — the eye is the only defense)" : ` --scope ${arm.scope.join(",")}`}`,
    );

    overlay(join(arm.dir, "flaw"), workspace);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", arm.commitMessage]);
    const flawSha = git(["rev-parse", "HEAD"]).stdout.trim();
    console.log(`planted: ${flawSha.slice(0, 7)} "${arm.commitMessage}"`);

    run(
      process.execPath,
      [claimCli, "--task", task, "--sha", flawSha, "--outcome", "complete", "--scope", "battery arm", "--verification", "battery gate", "--unknowns", "none"],
      agentEnv,
      0,
      "factory-claim (the planted flaw must stay gate-green)",
    );

    const mine = ledgerLines(stateDir).filter((e) => e.task === task);
    const names = mine.map((e) => e.event);
    const expected = ["contract_set", "claim_reported", "gate_started", "gate_finished", "fresh_eyes_written", "report_written"];
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      die(`ledger sequence for ${task}:\n  got      ${JSON.stringify(names)}\n  expected ${JSON.stringify(expected)}`);
    }
    const contract = mine[0];
    if (contract.freshEyes !== true || typeof contract.base !== "string") {
      die(`the contract for ${task} must carry freshEyes: true and its base commit`);
    }
    if (arm.scope === undefined && contract.scope !== undefined) {
      die(`the contract for ${arm.name} came back scoped, but its arm.json declares no scope — an unscoped arm must stay unscoped`);
    }
    const gateFinished = mine.find((e) => e.event === "gate_finished");
    if (gateFinished.verdict !== "green") {
      die(`the gate for ${task} came back ${gateFinished.verdict} (${gateFinished.note}) — the flaw must stay gate-green; fix ${arm.name}/flaw`);
    }
    const eyeEvent = mine.findLast((e) => e.event === "fresh_eyes_written");
    if (mine.some((e) => e.event === "attempt_accepted")) {
      die(`the battery never accepts — ${task} carries an attempt_accepted line`);
    }
    return { arm, task, model: eyeEvent.model, outcome: eyeEvent.outcome, finding: eyeEvent.finding };
  }

  // ---- the battery ----------------------------------------------------------------------

  const results = [];
  for (const arm of selected) {
    let result = runArm(arm);
    if (result.outcome === "failed") {
      console.log(`  eye failed technically (${result.finding}) — re-running ${arm.name} once, per the map's rule`);
      result = runArm(arm);
      result.retried = true;
    }
    results.push(result);
  }

  step("battery results");
  for (const r of results) {
    console.log(`${r.arm.name}  task=${r.task}  outcome=${r.outcome}${r.retried === true ? "  (after one technical re-run)" : ""}`);
    console.log(`  finding: ${r.finding}`);
    console.log(`  planted: ${r.arm.groundTruth ?? "(none recorded)"}`);
  }
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  console.log(`\nbattery settled: arms=${results.length} concern=${count("concern")} clear=${count("clear")} failed=${count("failed")}`);
  console.log(`judging hit/miss against the map's pre-registered rules (ground truth above) is ticket 03's operator act; nothing was accepted.`);

  const failedArms = results.filter((r) => r.outcome === "failed").map((r) => r.arm.name);
  if (failedArms.length > 0) {
    console.error(`\nBATTERY FAIL: arms still technically failed after one re-run: ${failedArms.join(", ")}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nBATTERY FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (!keep) {
    workspaces.cleanup();
    console.log(`\n(cleaned scratch workspaces; ledger, reports, gate logs and spool records kept as the audit trail)`);
  }
}
