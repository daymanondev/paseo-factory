import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureFactorySkill, factorySkillPath, renderFactorySkill } from "../src/index.ts";
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

  // The dispatch arm: the exact CLI door (§User Story 7's dispatch half).
  assert.ok(
    written.includes(`${FACTORY_CMD} lead dispatch --workspace <project-root> --message "<directive>"`),
    "the dispatch arm carries the install's exact factory lead dispatch invocation",
  );

  // The bootstrap arm: the loop's state plus the always-visible seat button
  // (§User Story 7's ensure-and-open half).
  assert.ok(written.includes(`${FACTORY_CMD} status`), "the bootstrap arm reads the loop's state");
  assert.ok(written.includes("Start Supervisor"), "the bootstrap arm points at the always-visible Start Supervisor button");

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
