import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureFactorySkill, ensureFactorySkillSafe, factorySkillPath, renderFactorySkill } from "../src/index.ts";
import contribute from "../plugin/index.server.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

/**
 * The global `/factory` skill seam (v0.0.20, ADR 0013 Decision 3, §User Story
 * 7): the boot-time reconcile of `~/.agents/skills/factory/SKILL.md` — the
 * file that lets the Owner type `/factory <directive>` in any session and
 * bootstrap or dispatch into the Project's SLP loop. The laws under test:
 * the skill lands with its frontmatter and both arms (dispatch via
 * `factory lead dispatch`, bootstrap via the always-visible Start Supervisor
 * button), carries this install's exact CLI door, never bakes one daemon's
 * `--home` (the file is global across daemons), reconciles idempotently, and
 * recovers a drifted copy (the file is plugin-managed).
 */

/** One install's exact CLI door — the seats' `factoryCmd` shape, quoted paths and all. */
const FACTORY_CMD = "ELECTRON_RUN_AS_NODE=1 '/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper' '/Users/x/.paseo/plugins/paseo-factory/bin/factory.mjs'";

test("the /factory skill reconciles at boot with both arms, the exact CLI door, and no baked home", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const skills = join(dir, ".agents", "skills");

  // First boot: the skill lands under the skills root's factory/ directory.
  const path = ensureFactorySkill(skills, { factoryCmd: FACTORY_CMD });
  assert.equal(path, factorySkillPath(skills), "the managed path is <skills>/factory/SKILL.md");
  const written = readFileSync(path, "utf8");

  // The frontmatter names the skill so `/factory` resolves.
  assert.ok(written.startsWith("---\nname: factory\n"), "the frontmatter names the skill factory");

  // The dispatch arm: the exact CLI door via supervisor dispatch (v0.0.23, ADR 0015 §5).
  assert.ok(
    written.includes(`${FACTORY_CMD} supervisor dispatch --workspace "$PWD" --message "<directive>"`),
    "the dispatch arm carries the install's exact factory supervisor dispatch invocation",
  );
  assert.ok(
    !written.includes(`${FACTORY_CMD} lead dispatch`),
    "the skill never instructs a normal chat to call factory lead dispatch directly",
  );

  // Seat-aware routing explanation (normal chat -> Supervisor, Supervisor -> Lead).
  assert.ok(
    written.includes("PASEO_FACTORY_SEAT=supervisor") && written.includes("lead_dispatch"),
    "the skill explains the deterministic seat-aware routing for both normal chat and Supervisor",
  );

  // Mutually exclusive Mode A / Mode B structure (v0.0.24, T-03): never sequential Step 1 / Step 2 / Step 3.
  assert.ok(
    written.includes("## Mode A — When invoked with a directive: /factory <directive>"),
    "the skill defines Mode A for /factory <directive>",
  );
  assert.ok(
    written.includes("## Mode B — When invoked with NO arguments: bare /factory"),
    "the skill defines Mode B for bare /factory",
  );
  assert.ok(
    !written.includes("## Step 1") && !written.includes("## Step 2") && !written.includes("## Step 3"),
    "the skill removes sequential Step 1 / Step 2 / Step 3 numbering",
  );

  // Mandatory immediate turn-end rule and explicit prohibition of factory status, Paseo MCP agent tools, and file operations in Mode A.
  assert.ok(
    written.includes("**STOP IMMEDIATELY:**"),
    "Mode A carries the STOP IMMEDIATELY directive",
  );
  assert.ok(
    written.includes(
      `Immediately after running \`${FACTORY_CMD} supervisor dispatch\`, end your turn and relay the command's output to the Owner. Never install packages, create files, edit code, or decompose tasks in this turn.`,
    ),
    "the skill states the mandatory immediate turn-end stop rule",
  );
  for (const forbiddenTool of ["create_agent", "kill_agent", "update_agent", "get_agent_status", "send_message"]) {
    assert.ok(written.includes(forbiddenTool), `Mode A explicitly forbids Paseo MCP tool ${forbiddenTool}`);
  }
  assert.ok(
    written.includes("Do **not** run `factory status`") &&
      written.includes("do **not** read, create, edit, or delete any files in the repository"),
    "Mode A explicitly forbids running factory status or touching repository files after supervisor dispatch",
  );

  // The bootstrap arm: when invoked with no <directive>, run status and point
  // at Start / Open Supervisor or passing /factory <directive>.
  assert.ok(written.includes(`${FACTORY_CMD} status`), "the bootstrap arm reads the loop's state");
  assert.ok(written.includes("Start / Open Supervisor"), "the bootstrap arm points at the Start / Open Supervisor button");
  assert.ok(written.includes("/factory <directive>"), "the bootstrap arm offers passing /factory <directive>");

  // The home law: a global file never pins one daemon's home — no rendered
  // command bakes a --home, the override stays a named option.
  assert.ok(!written.includes(`${FACTORY_CMD} --home`), "no command bakes a --home");
  assert.ok(written.includes("--home <paseoHome>"), "the override is named as an option, never baked");

  // Second boot: byte-identical content — the reconcile is a no-op.
  ensureFactorySkill(skills, { factoryCmd: FACTORY_CMD });
  assert.equal(readFileSync(path, "utf8"), written, "an in-sync skill is untouched");
});

test("a drifted skill copy reconciles back — the file is plugin-managed", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const skills = join(dir, "skills");
  ensureFactorySkill(skills, { factoryCmd: "factory" });

  writeFileSync(factorySkillPath(skills), "an operator's local edit\n");
  ensureFactorySkill(skills, { factoryCmd: "factory" });
  assert.equal(readFileSync(factorySkillPath(skills), "utf8"), renderFactorySkill({ factoryCmd: "factory" }), "the managed content returned");
});

test("the boot door never throws — an unusable skills root warns once and the boot continues (the plugin's other halves live)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  // A deterministic unusable root, no permissions involved: a regular FILE
  // where a directory component must be, so the reconcile's mkdirSync fails
  // (ENOTDIR) exactly as an unwritable or unreadable ~/.agents would.
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "occupied by a file\n");
  const unusable = join(blocker, "skills");

  // The raw verb's contract: it throws — the caller owns the failure policy.
  assert.throws(() => ensureFactorySkill(unusable, { factoryCmd: "factory" }), "the raw reconcile surfaces the error");

  // The boot door's contract: the same failure downgrades to ONE warning and
  // a null — never a throw, so contribute()'s choke/spool/mailbox wiring
  // after it stays reachable for this convenience artifact.
  const warnings: string[] = [];
  const failed = ensureFactorySkillSafe(unusable, { factoryCmd: "factory" }, (message) => warnings.push(message));
  assert.equal(failed, null, "no path on failure");
  assert.equal(warnings.length, 1, "exactly one warning");
  assert.ok(warnings[0]!.includes(factorySkillPath(unusable)), "the warning names the artifact it could not write");
  assert.ok(warnings[0]!.includes("/factory stays unavailable"), "the warning names the consequence, not just the error");
  assert.ok(!existsSync(factorySkillPath(unusable)), "nothing was written");

  // The happy path stays silent: a writable root returns the path, zero warnings.
  const good = join(dir, "skills");
  const quiet: string[] = [];
  const path = ensureFactorySkillSafe(good, { factoryCmd: "factory" }, (message) => quiet.push(message));
  assert.equal(path, factorySkillPath(good));
  assert.equal(quiet.length, 0, "a successful reconcile warns nothing");
  assert.ok(existsSync(path), "the skill landed");
});

test("plugin boot reconciles factory/SKILL.md into both ~/.agents/skills and ~/.claude/skills (v0.0.23, ADR 0015 §5)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const prevHome = process.env.HOME;
  const prevPaseoHome = process.env.PASEO_HOME;
  process.env.HOME = dir;
  process.env.PASEO_HOME = join(dir, ".paseo");
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevPaseoHome;
  });

  const fakeServer = {
    on: () => () => {},
    before: () => () => {},
    handle: () => () => {},
  };
  const stop = contribute(fakeServer as unknown as Parameters<typeof contribute>[0]);
  try {
    const agentsSkill = factorySkillPath(join(dir, ".agents", "skills"));
    const claudeSkill = factorySkillPath(join(dir, ".claude", "skills"));
    assert.ok(existsSync(agentsSkill), "~/.agents/skills/factory/SKILL.md reconciled at boot");
    assert.ok(existsSync(claudeSkill), "~/.claude/skills/factory/SKILL.md reconciled at boot");
    const expected = renderFactorySkill({ factoryCmd: "factory" });
    assert.equal(readFileSync(agentsSkill, "utf8"), expected, "~/.agents/skills copy matches renderFactorySkill");
    assert.equal(readFileSync(claudeSkill, "utf8"), expected, "~/.claude/skills copy matches renderFactorySkill");
  } finally {
    stop();
  }
});
