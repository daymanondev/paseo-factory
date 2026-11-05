import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionZcodeHome, ROLE_PROMPTS } from "../src/zcode-home.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

/**
 * The zcode harness home provisioner (v0.0.94, ADR 0046): every factory role —
 * `supervisor`, `lead`, working `agent`, and the tool-less `headless` pass —
 * runs zcode inside a clean-room `ZCODE_STORAGE_DIR` materialized on demand at
 * `<stateDir>/zcode-home/<role>` (per-Task at `zcode-home/tasks/<slug>/<task>`
 * for working Agent sessions). The real `HOME` and `ZCODE_HOME` stay untouched
 * so `zcode.cjs` keeps decrypting `~/.zcode/v2/credentials.json`; isolation
 * rides entirely on `ZCODE_STORAGE_DIR` + `ZCODE_SESSION_DB_PATH`. Each
 * interactive role carries a MANAGED `ROLE_SYSTEM.md` (its immutable SLP
 * contract, `ROLE_PROMPTS[role]`) referenced by `instructions.userFile` in the
 * generated `config.json` — the compaction-proof channel `config.systemPrompt`
 * over ACP is not. Tests drive the public entry point only, against a fake
 * `~/.zcode` home in a temp directory — the real one is never read.
 */

/** The skills seeded into the fake operator home — `factory` is the Owner-only exclusion case. */
const SEEDED_SKILLS = ["codebase-design", "domain-modeling", "factory", "grilling", "tdd"] as const;

/** Seeds a fake operator zcode home at `<userHome>/.zcode` — the messy real one isolation protects roles from. */
function seedZcodeHome(userHome: string): string {
  const zcode = join(userHome, ".zcode");
  for (const name of SEEDED_SKILLS) {
    mkdirSync(join(zcode, "skills", name), { recursive: true });
    writeFileSync(join(zcode, "skills", name, "SKILL.md"), `# ${name}\n`);
  }
  mkdirSync(join(zcode, "v2"), { recursive: true });
  writeFileSync(join(zcode, "v2", "credentials.json"), "enc:v1:opaque");
  return zcode;
}

test("provisionZcodeHome materializes the standing role homes and returns the clean-room env record (spec §1)", (t) => {
  const dir = makeTempDir("zcode-home-test-");
  disposeDir(t, dir);
  const userHome = join(dir, "user");
  seedZcodeHome(userHome);
  const stateDir = join(dir, "factory-state");

  // The locked seats: full clean-room record plus the Layer-1 write-tool lock.
  for (const role of ["supervisor", "lead"] as const) {
    const roleHome = join(stateDir, "zcode-home", role);
    const env = provisionZcodeHome({ stateDir, role, userHome });
    assert.deepEqual(env, {
      ZCODE_STORAGE_DIR: roleHome,
      ZCODE_SESSION_DB_PATH: join(roleHome, "db", "db.sqlite"),
      ZCODE_DYNAMIC_WORKFLOW_MODE: "disabled",
      ZCODE_ACP_QUOTA_AUTO_RESUME: "0",
      ZCODE_ACP_QUOTA_BOOT_NOTICE: "0",
      ZCODE_ACP_MODE: "guarded",
      ZCODE_DISALLOWED_TOOLS: "Write,Edit,MultiEdit,NotebookEdit,DeleteFile",
    });
    assert.ok(existsSync(roleHome), `${role} home is materialized`);
  }

  // The tool-less headless pass gets the same isolation env but never the
  // seat write-tool lock.
  const headlessHome = join(stateDir, "zcode-home", "headless");
  assert.deepEqual(provisionZcodeHome({ stateDir, role: "headless", userHome }), {
    ZCODE_STORAGE_DIR: headlessHome,
    ZCODE_SESSION_DB_PATH: join(headlessHome, "db", "db.sqlite"),
    ZCODE_DYNAMIC_WORKFLOW_MODE: "disabled",
    ZCODE_ACP_QUOTA_AUTO_RESUME: "0",
    ZCODE_ACP_QUOTA_BOOT_NOTICE: "0",
    ZCODE_ACP_MODE: "guarded",
  });
  assert.ok(existsSync(headlessHome), "the headless home is materialized");
});

test("working Agent sessions land per-Task at zcode-home/tasks/<slug>/<task>; the agent home is the fallback (spec §1 bullet 1)", (t) => {
  const dir = makeTempDir("zcode-home-test-");
  disposeDir(t, dir);
  const userHome = join(dir, "user");
  seedZcodeHome(userHome);
  const stateDir = join(dir, "factory-state");

  // Per-Task isolation: parallel Peers never contend on one db.sqlite.
  const taskHome = provisionZcodeHome({ stateDir, role: "agent", projectSlug: "demo-app", task: "T-01", userHome });
  const expectedTaskHome = join(stateDir, "zcode-home", "tasks", "demo-app", "T-01");
  assert.equal(taskHome.ZCODE_STORAGE_DIR, expectedTaskHome);
  assert.equal(taskHome.ZCODE_SESSION_DB_PATH, join(expectedTaskHome, "db", "db.sqlite"));
  assert.ok(!("ZCODE_DISALLOWED_TOOLS" in taskHome), "the working Agent is not write-tool-locked at Layer 1");
  assert.equal(readFileSync(join(expectedTaskHome, "ROLE_SYSTEM.md"), "utf8"), ROLE_PROMPTS.agent, "the per-Task home carries the agent contract");

  // Fallback: an agent without a Task identity lands at zcode-home/agent.
  const fallback = provisionZcodeHome({ stateDir, role: "agent", userHome });
  assert.equal(fallback.ZCODE_STORAGE_DIR, join(stateDir, "zcode-home", "agent"));
  assert.notEqual(fallback.ZCODE_SESSION_DB_PATH, taskHome.ZCODE_SESSION_DB_PATH, "each agent home owns its own sqlite path");
});

test("ROLE_SYSTEM.md carries the managed role contract and config.json points instructions.userFile at it; headless gets neither (spec §1 bullets 2–3)", (t) => {
  const dir = makeTempDir("zcode-home-test-");
  disposeDir(t, dir);
  const userHome = join(dir, "user");
  seedZcodeHome(userHome);
  const stateDir = join(dir, "factory-state");

  // Every interactive role gets its own managed role contract — the file
  // zcode.cjs reloads on every turn, every compaction, and every resume —
  // plus the config.json that wires instructions.userFile at it.
  const seen = new Set<string>();
  for (const role of ["supervisor", "lead", "agent"] as const) {
    const roleHome = join(stateDir, "zcode-home", role);
    provisionZcodeHome({ stateDir, role, userHome });
    const content = readFileSync(join(roleHome, "ROLE_SYSTEM.md"), "utf8");
    assert.equal(content, ROLE_PROMPTS[role], `${role} carries its canonical ROLE_PROMPTS entry`);
    assert.ok(!seen.has(content), "each role's contract is distinct");
    seen.add(content);
    const config = JSON.parse(readFileSync(join(roleHome, "config.json"), "utf8"));
    assert.deepEqual(config, { instructions: { userFile: join(roleHome, "ROLE_SYSTEM.md"), projectFile: "AGENTS.md" } });
  }

  // The tool-less headless pass never carries a role contract or its wiring.
  const headlessHome = join(stateDir, "zcode-home", "headless");
  provisionZcodeHome({ stateDir, role: "headless", userHome });
  assert.ok(!existsSync(join(headlessHome, "ROLE_SYSTEM.md")), "headless never carries ROLE_SYSTEM.md");
  assert.ok(!existsSync(join(headlessHome, "config.json")), "headless never carries config.json");
});

test("the returned record never overrides HOME or ZCODE_HOME, and operator credentials never leak into the clean room (ADR 0046 Gap 4)", (t) => {
  const dir = makeTempDir("zcode-home-test-");
  disposeDir(t, dir);
  const userHome = join(dir, "user");
  seedZcodeHome(userHome);
  const stateDir = join(dir, "factory-state");

  for (const input of [
    { stateDir, role: "supervisor" as const, userHome },
    { stateDir, role: "lead" as const, userHome },
    { stateDir, role: "headless" as const, userHome },
    { stateDir, role: "agent" as const, userHome },
    { stateDir, role: "agent" as const, projectSlug: "demo-app", task: "T-01", userHome },
  ]) {
    const env = provisionZcodeHome(input);
    assert.ok(!("HOME" in env), "HOME is never replaced — scryptSync credential decryption depends on it");
    assert.ok(!("ZCODE_HOME" in env), "ZCODE_HOME is never replaced — zcode-acp-server locates credentials through it");
  }

  // The clean room holds exactly the generated files and the skills policy —
  // the operator's `v2/credentials.json` stays in the real home, never linked
  // or copied into an isolated storage dir.
  const roleHome = join(stateDir, "zcode-home", "supervisor");
  assert.deepEqual(readdirSync(roleHome).sort(), ["ROLE_SYSTEM.md", "config.json", "db", "skills"]);
  assert.ok(!existsSync(join(roleHome, "v2")), "the operator's v2/ tree never lands in the clean room");
});

test("skill scoping: supervisor symlinks ~/.zcode/skills; lead and agent get scoped links excluding the Owner-only factory skill; headless stays stripped (spec §1 bullet 8)", (t) => {
  const dir = makeTempDir("zcode-home-test-");
  disposeDir(t, dir);
  const userHome = join(dir, "user");
  const source = join(seedZcodeHome(userHome), "skills");
  const stateDir = join(dir, "factory-state");

  // Supervisor keeps 100% of the Owner's skills through one directory symlink.
  const supervisorHome = join(stateDir, "zcode-home", "supervisor");
  provisionZcodeHome({ stateDir, role: "supervisor", userHome });
  const supervisorSkills = join(supervisorHome, "skills");
  assert.ok(lstatSync(supervisorSkills).isSymbolicLink(), "supervisor's skills is a symlink back to the operator home");
  assert.equal(realpathSync(supervisorSkills), realpathSync(source));

  // Lead sees only its three core role skills — never the Owner-only factory skill.
  const leadHome = join(stateDir, "zcode-home", "lead");
  provisionZcodeHome({ stateDir, role: "lead", userHome });
  const leadSkills = join(leadHome, "skills");
  assert.ok(!lstatSync(leadSkills).isSymbolicLink(), "lead's skills is a scoped directory, not the operator's whole tree");
  assert.deepEqual(readdirSync(leadSkills).sort(), ["codebase-design", "domain-modeling", "tdd"]);
  for (const name of ["codebase-design", "domain-modeling", "tdd"]) {
    assert.equal(realpathSync(join(leadSkills, name)), realpathSync(join(source, name)), `${name} links at the operator skill`);
  }

  // The working agent sees every installed skill except factory.
  const agentHome = join(stateDir, "zcode-home", "agent");
  provisionZcodeHome({ stateDir, role: "agent", userHome });
  assert.deepEqual(readdirSync(join(agentHome, "skills")).sort(), ["codebase-design", "domain-modeling", "grilling", "tdd"]);
  assert.ok(!existsSync(join(agentHome, "skills", "factory")), "the Owner-only factory skill never reaches the working agent");
  assert.equal(realpathSync(join(agentHome, "skills", "grilling")), realpathSync(join(source, "grilling")));

  // The tool-less headless pass stays strictly stripped.
  const headlessHome = join(stateDir, "zcode-home", "headless");
  provisionZcodeHome({ stateDir, role: "headless", userHome });
  assert.ok(!existsSync(join(headlessHome, "skills")), "headless never sees a skills tree");
});

test("provisioning is idempotent: a second call leaves the same state without churning a correct symlink (spec §1)", (t) => {
  const dir = makeTempDir("zcode-home-test-");
  disposeDir(t, dir);
  const userHome = join(dir, "user");
  const source = join(seedZcodeHome(userHome), "skills");
  const stateDir = join(dir, "factory-state");

  // Supervisor: the operator skills link is never removed and re-made.
  const supervisorHome = join(stateDir, "zcode-home", "supervisor");
  const first = provisionZcodeHome({ stateDir, role: "supervisor", userHome });
  const skillsLink = join(supervisorHome, "skills");
  const linkStat = lstatSync(skillsLink);
  const contractBefore = readFileSync(join(supervisorHome, "ROLE_SYSTEM.md"), "utf8");
  const configBefore = readFileSync(join(supervisorHome, "config.json"), "utf8");

  const second = provisionZcodeHome({ stateDir, role: "supervisor", userHome });

  assert.deepEqual(second, first, "a second call returns the same env record");
  const linkStatAfter = lstatSync(skillsLink);
  assert.equal(linkStatAfter.ino, linkStat.ino, "an already-correct symlink is left untouched, never re-made");
  assert.equal(linkStatAfter.mtimeMs, linkStat.mtimeMs, "the symlink's mtime is stable across a re-provision");
  assert.equal(readFileSync(join(supervisorHome, "ROLE_SYSTEM.md"), "utf8"), contractBefore, "ROLE_SYSTEM.md is rewritten to the same bytes");
  assert.equal(readFileSync(join(supervisorHome, "config.json"), "utf8"), configBefore, "config.json is rewritten to the same bytes");

  // Per-Task agent: scoped skill links stay stable, never duplicated.
  const taskInput = { stateDir, role: "agent" as const, projectSlug: "demo-app", task: "T-01", userHome };
  provisionZcodeHome(taskInput);
  const taskSkills = join(stateDir, "zcode-home", "tasks", "demo-app", "T-01", "skills");
  const inosBefore = readdirSync(taskSkills).map((name) => lstatSync(join(taskSkills, name)).ino);
  provisionZcodeHome(taskInput);
  assert.deepEqual(readdirSync(taskSkills).sort(), ["codebase-design", "domain-modeling", "grilling", "tdd"], "no duplicate or missing skill links");
  assert.deepEqual(readdirSync(taskSkills).map((name) => lstatSync(join(taskSkills, name)).ino), inosBefore, "scoped skill links are not churned");

  // Contamination still retires: a non-link skills directory on supervisor is
  // replaced by the expected symlink, and a stale scoped link on the agent
  // home is swept.
  rmSync(skillsLink);
  mkdirSync(skillsLink);
  writeFileSync(join(skillsLink, "evil.txt"), "contamination\n");
  provisionZcodeHome({ stateDir, role: "supervisor", userHome });
  assert.ok(lstatSync(skillsLink).isSymbolicLink(), "a non-link skills directory is replaced by the expected symlink");
  assert.equal(realpathSync(skillsLink), realpathSync(source));
  assert.equal(existsSync(join(skillsLink, "evil.txt")), false, "the swept directory's contents are gone");

  const fallbackSkills = join(stateDir, "zcode-home", "agent", "skills");
  provisionZcodeHome({ stateDir, role: "agent", userHome });
  symlinkSync(join(source, "factory"), join(fallbackSkills, "stale-owner-link"));
  provisionZcodeHome({ stateDir, role: "agent", userHome });
  assert.ok(!existsSync(join(fallbackSkills, "stale-owner-link")), "a link outside the scoped set is retired");

  // Headless contamination — a planted contract, config, and skills tree —
  // is swept on the next pass.
  const headlessHome = join(stateDir, "zcode-home", "headless");
  mkdirSync(join(headlessHome, "skills", "factory"), { recursive: true });
  writeFileSync(join(headlessHome, "ROLE_SYSTEM.md"), "# planted\n");
  writeFileSync(join(headlessHome, "config.json"), "{}");
  provisionZcodeHome({ stateDir, role: "headless", userHome });
  assert.ok(!existsSync(join(headlessHome, "skills")), "headless contamination is retired");
  assert.ok(!existsSync(join(headlessHome, "ROLE_SYSTEM.md")), "a planted headless contract is retired");
  assert.ok(!existsSync(join(headlessHome, "config.json")), "a planted headless config is retired");
});

test("systemPrompt overrides the role default; an empty override writes nothing; headless never gets one even when asked", (t) => {
  const dir = makeTempDir("zcode-home-test-");
  disposeDir(t, dir);
  const userHome = join(dir, "user");
  seedZcodeHome(userHome);
  const stateDir = join(dir, "factory-state");

  const leadHome = join(stateDir, "zcode-home", "lead");
  provisionZcodeHome({ stateDir, role: "lead", userHome, systemPrompt: "# Custom lead brief\n" });
  assert.equal(readFileSync(join(leadHome, "ROLE_SYSTEM.md"), "utf8"), "# Custom lead brief\n", "the override lands verbatim");
  const config = JSON.parse(readFileSync(join(leadHome, "config.json"), "utf8"));
  assert.equal(config.instructions.userFile, join(leadHome, "ROLE_SYSTEM.md"), "instructions.userFile still points at the written contract");

  const agentHome = join(stateDir, "other-state", "zcode-home", "agent");
  provisionZcodeHome({ stateDir: join(dir, "other-state"), role: "agent", userHome, systemPrompt: "" });
  assert.ok(!existsSync(join(agentHome, "ROLE_SYSTEM.md")), "an empty systemPrompt writes no contract");
  assert.ok(!existsSync(join(agentHome, "config.json")), "no contract means no instructions wiring");

  const headlessHome = join(dir, "headless-state", "zcode-home", "headless");
  provisionZcodeHome({ stateDir: join(dir, "headless-state"), role: "headless", userHome, systemPrompt: "# should not land\n" });
  assert.ok(!existsSync(join(headlessHome, "ROLE_SYSTEM.md")), "an explicit systemPrompt never lands for headless either");
  assert.ok(!existsSync(join(headlessHome, "config.json")), "headless never carries the instructions wiring");
});

test("a Scrum identity reroutes the clean room under <projectStateDir>/scrum/zcode-home — seats and task epochs mirror the Pi harness hierarchy (v0.2.0, ADR 0049 §1)", (t) => {
  const dir = makeTempDir("zcode-home-test-");
  disposeDir(t, dir);
  const userHome = join(dir, "user");
  seedZcodeHome(userHome);
  const stateDir = join(dir, "factory-state");

  // Standing seat: <projectStateDir>/scrum/zcode-home/seats/<selectionRevision>/<generation>/<authority>/
  const seatHome = join(stateDir, "projects", "demo-app", "scrum", "zcode-home", "seats", "3", "cor-seat-1", "supervisor");
  const seatEnv = provisionZcodeHome({
    stateDir,
    role: "supervisor",
    projectSlug: "demo-app",
    userHome,
    scrum: { kind: "seat", selectionRevision: 3, generation: "cor-seat-1", authority: "supervisor" },
    systemPrompt: "<!-- scrum supervisor contract -->\n",
  });
  assert.equal(seatEnv.ZCODE_STORAGE_DIR, seatHome, "the Scrum seat's storage dir sits under the Project state dir");
  assert.equal(seatEnv.ZCODE_SESSION_DB_PATH, join(seatHome, "db", "db.sqlite"), "the Scrum seat owns its own sqlite path");
  assert.equal(seatEnv.ZCODE_DISALLOWED_TOOLS, "Write,Edit,MultiEdit,NotebookEdit,DeleteFile", "the Scrum seat keeps the Layer-1 write-tool lock");
  assert.equal(readFileSync(join(seatHome, "ROLE_SYSTEM.md"), "utf8"), "<!-- scrum supervisor contract -->\n", "the Scrum seat's contract is the passed Scrum prompt, never the SLP fallback");

  // Specialist task: <projectStateDir>/scrum/zcode-home/runs/<runId>/<task>/<epoch>/
  const runHome = join(stateDir, "projects", "demo-app", "scrum", "zcode-home", "runs", "run-a", "T-01", "7");
  const runEnv = provisionZcodeHome({
    stateDir,
    role: "agent",
    projectSlug: "demo-app",
    task: "T-01",
    userHome,
    scrum: { kind: "task", runId: "run-a", task: "T-01", epoch: 7 },
    systemPrompt: "<!-- scrum dev contract -->\n",
  });
  assert.equal(runEnv.ZCODE_STORAGE_DIR, runHome, "the Scrum specialist's storage dir sits under the run epoch");
  assert.equal(runEnv.ZCODE_SESSION_DB_PATH, join(runHome, "db", "db.sqlite"));
  assert.ok(!("ZCODE_DISALLOWED_TOOLS" in runEnv), "the Scrum specialist is not write-tool-locked at Layer 1");
  assert.equal(readFileSync(join(runHome, "ROLE_SYSTEM.md"), "utf8"), "<!-- scrum dev contract -->\n", "the specialist's contract is the passed Scrum prompt");
  const runConfig = JSON.parse(readFileSync(join(runHome, "config.json"), "utf8"));
  assert.deepEqual(runConfig, { instructions: { userFile: join(runHome, "ROLE_SYSTEM.md"), projectFile: "AGENTS.md" } }, "config.json wires instructions.userFile at the Scrum contract");

  // The Scrum homes never touch the shared SLP roots — the collision source the reroute exists to fix.
  assert.ok(!existsSync(join(stateDir, "zcode-home", "supervisor")), "the Scrum seat never writes the SLP supervisor home");
  assert.ok(!existsSync(join(stateDir, "zcode-home", "tasks", "demo-app", "T-01")), "the Scrum task never writes the SLP per-Task home");
});

test("allowedSkills reconciles skills/ against exactly the caller's list; a Scrum supervisor gets every installed skill except factory as per-skill links (v0.2.0, ADR 0049 §1)", (t) => {
  const dir = makeTempDir("zcode-home-test-");
  disposeDir(t, dir);
  const userHome = join(dir, "user");
  const source = join(seedZcodeHome(userHome), "skills");
  const stateDir = join(dir, "factory-state");

  // The Scrum supervisor: full host skills except the Owner-only factory —
  // expressed as an allowed-list of per-skill links, NOT the whole-dir
  // symlink the SLP supervisor keeps.
  const seatHome = join(stateDir, "projects", "demo-app", "scrum", "zcode-home", "seats", "1", "initial", "supervisor");
  provisionZcodeHome({
    stateDir,
    role: "supervisor",
    projectSlug: "demo-app",
    userHome,
    scrum: { kind: "seat", selectionRevision: 1, generation: "initial", authority: "supervisor" },
  });
  const seatSkills = join(seatHome, "skills");
  assert.ok(!lstatSync(seatSkills).isSymbolicLink(), "the Scrum supervisor's skills is a scoped directory, never the operator's whole tree");
  assert.deepEqual(readdirSync(seatSkills).sort(), ["codebase-design", "domain-modeling", "grilling", "tdd"], "every installed skill except factory");
  assert.ok(!existsSync(join(seatSkills, "factory")), "the Owner-only factory skill never reaches the Scrum supervisor");
  assert.equal(realpathSync(join(seatSkills, "grilling")), realpathSync(join(source, "grilling")), "each entry links at the operator skill");

  // The Scrum lead / specialist: exactly the caller's allowedSkills list —
  // no more, no less, never a broken link for an uninstalled name.
  const runHome = join(stateDir, "projects", "demo-app", "scrum", "zcode-home", "seats", "1", "initial", "lead");
  provisionZcodeHome({
    stateDir,
    role: "lead",
    projectSlug: "demo-app",
    userHome,
    scrum: { kind: "seat", selectionRevision: 1, generation: "initial", authority: "lead" },
    allowedSkills: ["grilling", "tdd", "not-installed"],
  });
  const leadSkills = join(runHome, "skills");
  assert.deepEqual(readdirSync(leadSkills).sort(), ["grilling", "tdd"], "the scoped set is exactly the installed slice of allowedSkills");
  assert.ok(!existsSync(join(leadSkills, "not-installed")), "an allowed but uninstalled skill never becomes a broken symlink");

  // Reconcile: a link outside the allowed list retires on re-provision, and
  // an already-correct link is never churned.
  symlinkSync(join(source, "factory"), join(leadSkills, "stale-owner-link"));
  const survivors = ["grilling", "tdd"] as const;
  const inosBefore = survivors.map((name) => lstatSync(join(leadSkills, name)).ino);
  provisionZcodeHome({
    stateDir,
    role: "lead",
    projectSlug: "demo-app",
    userHome,
    scrum: { kind: "seat", selectionRevision: 1, generation: "initial", authority: "lead" },
    allowedSkills: ["grilling", "tdd"],
  });
  assert.ok(!existsSync(join(leadSkills, "stale-owner-link")), "a link outside the allowed set is retired");
  assert.deepEqual(readdirSync(leadSkills).sort(), ["grilling", "tdd"]);
  assert.deepEqual(survivors.map((name) => lstatSync(join(leadSkills, name)).ino), inosBefore, "scoped skill links are not churned");
});

test("concurrent SLP and Scrum zcode homes never overwrite each other's ROLE_SYSTEM.md or skills/ (v0.2.0, ADR 0049 §1)", (t) => {
  const dir = makeTempDir("zcode-home-test-");
  disposeDir(t, dir);
  const userHome = join(dir, "user");
  const source = join(seedZcodeHome(userHome), "skills");
  const stateDir = join(dir, "factory-state");

  // One machine, two modes, one shared supervisor role name: the SLP seat
  // keeps `<stateDir>/zcode-home/supervisor`, the Scrum seat lives under the
  // Project state dir — the collision the reroute exists to fix.
  const slpSupervisor = join(stateDir, "zcode-home", "supervisor");
  const scrumSupervisor = join(stateDir, "projects", "scrum-app", "scrum", "zcode-home", "seats", "1", "cor-scrum", "supervisor");
  provisionZcodeHome({ stateDir, role: "supervisor", userHome });
  provisionZcodeHome({
    stateDir,
    role: "supervisor",
    projectSlug: "scrum-app",
    userHome,
    scrum: { kind: "seat", selectionRevision: 1, generation: "cor-scrum", authority: "supervisor" },
    systemPrompt: "<!-- scrum supervisor contract -->\n",
  });
  assert.equal(readFileSync(join(slpSupervisor, "ROLE_SYSTEM.md"), "utf8"), ROLE_PROMPTS.supervisor, "the SLP supervisor keeps its SLP contract");
  assert.equal(readFileSync(join(scrumSupervisor, "ROLE_SYSTEM.md"), "utf8"), "<!-- scrum supervisor contract -->\n", "the Scrum supervisor keeps its Scrum contract");
  assert.ok(lstatSync(join(slpSupervisor, "skills")).isSymbolicLink(), "the SLP supervisor keeps its whole-tree skills symlink");
  assert.deepEqual(readdirSync(join(scrumSupervisor, "skills")).sort(), ["codebase-design", "domain-modeling", "grilling", "tdd"], "the Scrum supervisor keeps its per-skill allowlist");

  // The per-Task channel collides the same way: the SLP Peer's
  // `zcode-home/tasks/<slug>/<task>` home and the Scrum specialist's
  // run-epoch home stay disjoint, each with its own contract and sqlite path.
  const slpTask = join(stateDir, "zcode-home", "tasks", "scrum-app", "T-01");
  const scrumTask = join(stateDir, "projects", "scrum-app", "scrum", "zcode-home", "runs", "run-a", "T-01", "3");
  provisionZcodeHome({ stateDir, role: "agent", projectSlug: "scrum-app", task: "T-01", userHome });
  provisionZcodeHome({
    stateDir,
    role: "agent",
    projectSlug: "scrum-app",
    task: "T-01",
    userHome,
    scrum: { kind: "task", runId: "run-a", task: "T-01", epoch: 3 },
    systemPrompt: "<!-- scrum dev contract -->\n",
  });
  assert.equal(readFileSync(join(slpTask, "ROLE_SYSTEM.md"), "utf8"), ROLE_PROMPTS.agent, "the SLP per-Task home keeps the agent contract");
  assert.equal(readFileSync(join(scrumTask, "ROLE_SYSTEM.md"), "utf8"), "<!-- scrum dev contract -->\n", "the Scrum run-epoch home keeps the Scrum contract");

  // Re-provisioning both modes back-to-back leaves both intact — neither
  // path ever observes the other's bytes.
  provisionZcodeHome({ stateDir, role: "supervisor", userHome });
  provisionZcodeHome({ stateDir, role: "agent", projectSlug: "scrum-app", task: "T-01", userHome });
  assert.equal(readFileSync(join(slpSupervisor, "ROLE_SYSTEM.md"), "utf8"), ROLE_PROMPTS.supervisor);
  assert.equal(readFileSync(join(scrumSupervisor, "ROLE_SYSTEM.md"), "utf8"), "<!-- scrum supervisor contract -->\n");
  assert.equal(readFileSync(join(slpTask, "ROLE_SYSTEM.md"), "utf8"), ROLE_PROMPTS.agent);
  assert.equal(readFileSync(join(scrumTask, "ROLE_SYSTEM.md"), "utf8"), "<!-- scrum dev contract -->\n");
  assert.ok(lstatSync(join(slpSupervisor, "skills")).isSymbolicLink(), "the SLP supervisor's whole-tree symlink survives the Scrum re-provision");
  assert.equal(realpathSync(join(scrumSupervisor, "skills", "tdd")), realpathSync(join(source, "tdd")), "the Scrum supervisor's per-skill links survive the SLP re-provision");
});

test("the default userHome resolves against the runtime home (hermetic via process.env.HOME)", (t) => {
  const dir = makeTempDir("zcode-home-test-");
  disposeDir(t, dir);
  const fakeHome = join(dir, "fake-home");
  const source = join(seedZcodeHome(fakeHome), "skills");
  const stateDir = join(dir, "factory-state");

  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const env = provisionZcodeHome({ stateDir, role: "supervisor" });
    assert.equal(env.ZCODE_STORAGE_DIR, join(stateDir, "zcode-home", "supervisor"));
    const skillsLink = join(stateDir, "zcode-home", "supervisor", "skills");
    assert.ok(lstatSync(skillsLink).isSymbolicLink(), "skills links from <runtime home>/.zcode/skills");
    assert.equal(realpathSync(skillsLink), realpathSync(source));
  } finally {
    process.env.HOME = previousHome;
  }
});
