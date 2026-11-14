import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ensureFactorySkill, ensureFactorySkillSafe, factorySkillPath, renderFactorySkill } from "../src/index.ts";
import contribute from "../plugin/index.server.ts";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

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
  // at the native Supervisor (Factory) picker or passing /factory <directive>.
  assert.ok(written.includes(`${FACTORY_CMD} status`), "the bootstrap arm reads the loop's state");
  assert.ok(written.includes("Supervisor (Factory)"), "the bootstrap arm points at the native Supervisor (Factory) picker");
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

/** Boots the real plugin entry against a fake HOME; returns its stop door. */
function bootPluginAt(t: TestContext, dir: string): () => void {
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
  const fakeServer = { on: () => () => {}, before: () => () => {}, handle: () => () => {} };
  return contribute(fakeServer as unknown as Parameters<typeof contribute>[0]);
}

/** The three harness skill roots under one home — pi / opencode, claude, and (ADR 0036) the pi agent dir. */
const skillRoots = (home: string): string[] => [
  join(home, ".agents", "skills"),
  join(home, ".claude", "skills"),
  join(home, ".pi", "agent", "skills"),
];

test("plugin boot reconciles factory/SKILL.md into all three roots including ~/.pi/agent/skills (ADR 0036)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stop = bootPluginAt(t, dir);
  try {
    const expected = renderFactorySkill({ factoryCmd: "factory" });
    for (const root of skillRoots(dir)) {
      assert.ok(existsSync(factorySkillPath(root)), `${root}/factory/SKILL.md reconciled at boot`);
      assert.equal(readFileSync(factorySkillPath(root), "utf8"), expected, `${root} copy matches the canonical render`);
    }
  } finally {
    stop();
  }
});

test("a hand-edited copy in any of the three roots reverts to the canonical content on the next boot", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  for (const root of skillRoots(dir)) {
    mkdirSync(join(root, "factory"), { recursive: true });
    writeFileSync(factorySkillPath(root), `a stale hand-copy in ${root}\n`);
  }
  const stop = bootPluginAt(t, dir);
  try {
    const expected = renderFactorySkill({ factoryCmd: "factory" });
    for (const root of skillRoots(dir)) {
      assert.equal(readFileSync(factorySkillPath(root), "utf8"), expected, `${root} drifted copy reverted`);
    }
  } finally {
    stop();
  }
});

test("an unusable third root warns once and boot still reconciles the other roots", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  // A regular FILE where ~/.pi must be a directory: the pi root cannot be written.
  writeFileSync(join(dir, ".pi"), "occupied by a file\n");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  let stop: (() => void) | undefined;
  try {
    stop = bootPluginAt(t, dir);
  } finally {
    console.log = realLog;
  }
  try {
    const expected = renderFactorySkill({ factoryCmd: "factory" });
    assert.equal(readFileSync(factorySkillPath(join(dir, ".agents", "skills")), "utf8"), expected);
    assert.equal(readFileSync(factorySkillPath(join(dir, ".claude", "skills")), "utf8"), expected);
    const piWarnings = logs.filter((line) => line.includes("skill: could not reconcile") && line.includes(join(".pi", "agent", "skills")));
    assert.equal(piWarnings.length, 1, "the unusable pi root warns exactly once");
  } finally {
    stop?.();
  }
});

test("after an install refresh the next sync re-renders every root with the new install's door — no baked checkout UUID survives", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const paseoHome = join(dir, ".paseo");
  const oldUuid = "4a2d08ae-314c-4be6-a586-73a51c6a8577";
  const newUuid = "7615f22f-7223-4bf3-a112-e94361435609";
  const installAt = (uuid: string): string => {
    const pluginDir = join(paseoHome, "plugins", "paseo-factory", uuid, "checkout", "plugin");
    mkdirSync(join(pluginDir, "bin"), { recursive: true });
    writeFileSync(join(pluginDir, "paseo.plugin.json"), JSON.stringify({ id: "paseo-factory" }));
    writeFileSync(
      join(paseoHome, "config.json"),
      JSON.stringify({ plugins: { "paseo-factory": { source: "directory", path: pluginDir, enabled: true } } }),
    );
    return pluginDir;
  };
  const settle = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const everyRoot = (predicate: (content: string) => boolean): boolean =>
    skillRoots(dir).every((root) => existsSync(factorySkillPath(root)) && predicate(readFileSync(factorySkillPath(root), "utf8")));

  mkdirSync(paseoHome, { recursive: true });
  installAt(oldUuid);
  const stop = bootPluginAt(t, dir);
  try {
    assert.ok(everyRoot((c) => c.includes(oldUuid)), "initial boot bakes the active install's door into every root");

    // Paseo updates the plugin: a new checkout + config.json; the post-boot re-sync follows.
    installAt(newUuid);
    await settle(() => everyRoot((c) => c.includes(newUuid)));
    assert.ok(everyRoot((c) => c.includes(newUuid)), "the re-sync re-renders every root with the new install's door");
    assert.ok(everyRoot((c) => !c.includes(oldUuid)), "no root keeps the old install UUID");
  } finally {
    stop();
  }
});

/**
 * Ticket 05 of factory-cli-project-onboarding: the pre-flight gate. The
 * rendered skill is the whole artifact (an agent follows the prose), so the
 * protocol is pinned through rendered-content assertions at this seam.
 */
const preflight = renderFactorySkill({ factoryCmd: "factory" });
/** Mode A's prose, ahead of Mode B — the pre-flight lives in the directive arm. */
const modeA = preflight.slice(preflight.indexOf("## Mode A"), preflight.indexOf("## Mode B"));
const at = (needle: string, from = 0) => {
  const i = modeA.indexOf(needle, from);
  assert.ok(i >= 0, `Mode A names ${JSON.stringify(needle)}`);
  return i;
};

test("pre-flight: Mode A resolves the git root and queries registration before any dispatch", () => {
  const doctor = at('factory doctor --workspace "$PWD" --json');
  const dispatch = at('factory supervisor dispatch --workspace "$PWD" --message "<directive>"');
  assert.ok(doctor < dispatch, "the registration query precedes the dispatch command");
  assert.ok(modeA.includes("`.registered`") && modeA.includes("`.workspace.root`"), "the registration answer is read from doctor's JSON");
  assert.ok(/subdirector/i.test(modeA) && /git root/i.test(modeA), "a subdirectory invocation resolves to the git root and says so");
});

test("pre-flight: an unregistered folder gets a three-way choice — register here / pick existing / abort", () => {
  const choice = at("Register here");
  assert.ok(modeA.includes("Pick an existing Project") && modeA.includes("Abort"), "all three options are offered");
  assert.ok(at("Abort", choice) > choice, "register-here leads the list, abort closes it");
  assert.ok(at("factory project register --workspace", choice) > choice, "register here runs project register on the resolved root");
  assert.ok(modeA.includes("factory project list --json"), "the existing-Project list comes from project list --json");
  assert.ok(/slug.*root.*home/s.test(modeA.slice(modeA.indexOf("Pick an existing Project"))), "pick-existing labels carry slug + root + home");
});

test("pre-flight: pick-existing dispatches with explicit --project <slug> routing", () => {
  assert.ok(modeA.includes('factory supervisor dispatch --project <slug> --message "<directive>"'), "dispatch routes by --project <slug>");
});

test("pre-flight: abort ends the turn with nothing written and nothing dispatched", () => {
  const abort = modeA.slice(modeA.indexOf("**Abort**"), modeA.indexOf("**Abort**") + 300);
  assert.ok(/end (the|your) turn/i.test(abort), "abort ends the turn");
  assert.ok(/nothing (is )?written/i.test(abort) && /no dispatch/i.test(abort), "abort writes nothing and dispatches nothing");
});

test("pre-flight: the resolved workspace and daemon home are echoed before any dispatch", () => {
  const echo = at("Echo");
  assert.ok(echo < at('factory supervisor dispatch --workspace "$PWD"'), "the echo precedes the dispatch");
  const line = modeA.slice(echo, echo + 400);
  assert.ok(/workspace/i.test(line) && /home/i.test(line), "the echo names the workspace and the daemon home");
});

test("pre-flight: the Owner's explicit choice gates registration; no silent auto-register and no last-used fallback", () => {
  assert.ok(/never register or dispatch (on|without)/i.test(modeA), "register/dispatch only on the Owner's explicit choice");
  assert.ok(!/last[- ]used|most recent(ly)?|previous(ly)? used|default to the (only|first)/i.test(preflight), "no last-used / most-recent / default-pick fallback anywhere");
  assert.ok(!preflight.includes("--allow-unregistered") || /only when the Owner (explicitly )?asks/i.test(modeA), "the legacy held-dispatch flag is Owner-opt-in only");
});

test("pre-flight: after a fresh register, one optional lane-profile apply-or-skip — only when profiles exist, never blocking dispatch", () => {
  const reg = at("factory project register --workspace");
  const list = at("factory profile list --json", reg);
  const apply = at('factory profile apply <id> --project "<root>"', list);
  const dispatch = at('factory supervisor dispatch --workspace "$PWD"', apply);
  assert.ok(reg < list && list < apply && apply < dispatch, "register, then profile list, then apply, then dispatch");
  const step = modeA.slice(list, dispatch);
  assert.ok(/no profile[s]?\b.*(no question|silent|skip)/is.test(step), "no profiles: no question, default lanes apply silently");
  assert.ok(/apply or skip/i.test(step) && /one question/i.test(step), "exactly one apply-or-skip question");
  assert.ok(/never (block|delay)/i.test(step), "the profile step never blocks or delays the dispatch");
});

test("pre-flight: register failures are relayed — plugin-down names Paseo Desktop, nothing is dispatched", () => {
  assert.ok(modeA.includes("plugin is not running") && modeA.includes("Paseo Desktop"), "plugin-down guidance");
  assert.ok(modeA.includes("unregistered-project"), "stays consistent with the guard's refusal code");
});

test("pre-flight: every factory verb and flag the rendered skill names is one the CLI documents", () => {
  const help = spawnSync(process.execPath, [join(repoRoot, "plugin", "bin", "factory.mjs"), "help"], { encoding: "utf8" }).stdout;
  const usageLines = help.split("\n").map((l) => l.trim());
  // Every command is a backticked span or an indented line starting at the door.
  const commands = [...preflight.matchAll(/(?:`|^ {2})factory ([^`\n]+)/gm)].map((m) => {
    const tokens = m[1]!.trim().split(/\s+/);
    const verb = tokens.slice(0, tokens.findIndex((t) => !/^[a-z]+$/.test(t)) === -1 ? tokens.length : tokens.findIndex((t) => !/^[a-z]+$/.test(t))).join(" ");
    return { verb, flags: tokens.filter((t) => t.startsWith("--")) };
  });
  assert.ok(commands.length >= 6, "the skill names several CLI commands");
  for (const { verb, flags } of commands) {
    const blocks = usageLines.filter((l) => l === verb || l.startsWith(verb + " "));
    assert.ok(blocks.length > 0, `the CLI documents \`factory ${verb}\``);
    for (const flag of flags) assert.ok(blocks.some((l) => l.includes(flag)), `\`factory ${verb}\` documents ${flag}`);
  }
  const verbs = new Set(commands.map((c) => c.verb));
  for (const verb of ["doctor", "project register", "project list", "profile list", "profile apply", "supervisor dispatch"]) {
    assert.ok(verbs.has(verb), `the skill names \`factory ${verb}\``);
  }
});
