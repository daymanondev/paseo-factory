/**
 * The global `/factory` skill (v0.0.20, ADR 0013 Decision 3; v0.0.23, ADR 0015
 * Decision 5): the managed `SKILL.md` reconciled across both
 * `~/.agents/skills/factory/SKILL.md` (`pi` / `opencode`) and
 * `~/.claude/skills/factory/SKILL.md` (`claude`) that lets the Owner type
 * `/factory <directive>` in any session and have that session bootstrap or
 * dispatch deterministically into the Project's SLP loop —
 * `factory supervisor dispatch` for the directive arm (seat-aware routing into
 * `Supervisor` from a normal chat or into `Lead` from inside `Supervisor`),
 * and the Factory surface's `Start / Open Supervisor` for the bootstrap arm.
 *
 * Pure Node like every `src/` module: the plugin shell vendors the verbatim
 * copy into `plugin/server/core/` (the `./core/project.ts` precedent) and
 * reconciles the files at boot through `ensureFactorySkillSafe` — idempotent,
 * rewritten only when the rendered content changes (the `ensureClaimCli`
 * wrapper law), so a plugin update refreshes the skill and an Operator edit
 * is deliberately reconciled back (the file is plugin-managed, the
 * `APPEND_SYSTEM.md` precedent). One failure law above all: unlike the
 * stateDir writes, `~/.agents` and `~/.claude` are not preconditions the
 * plugin depends on, so a skill that cannot be written is a WARNING, never a
 * boot failure — the raw `ensureFactorySkill` keeps the throwing contract for
 * callers that want errors; only the safe door ever runs at boot.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What the rendered skill needs from its installer — the exact CLI door, nothing else. */
export interface FactorySkillInput {
  /**
   * The exact, runnable `factory` CLI invocation this install owns — the
   * bootstrap's `factoryCmd` precedent (`ELECTRON_RUN_AS_NODE=1 '<node>'
   * '<pluginDir>/bin/factory.mjs'`, or bare `factory` when the plugin
   * directory is unknown). The skill never bakes a `--home`: the file is
   * global across daemons, so the body names the default-home law and the
   * `--home` override instead of pinning one daemon's home.
   */
  factoryCmd: string;
}

/** Where the skill lives under a skills root — `<agentsSkillsDir>/factory/SKILL.md`. */
export function factorySkillPath(agentsSkillsDir: string): string {
  return join(agentsSkillsDir, "factory", "SKILL.md");
}

/** Renders the skill verbatim — one pure function, so tests pin the law, not the file. */
export function renderFactorySkill(input: FactorySkillInput): string {
  return [
    "---",
    "name: factory",
    "description: Bootstrap or dispatch into the current Project's paseo-factory SLP loop (Owner → Supervisor → Lead → Agent) — /factory [directive].",
    "---",
    "",
    "You are serving the Owner of paseo-factory. `/factory` (with or without a directive) acts on the Project that owns the current working directory — no raw agent ids, no manual seat lookups.",
    "",
    "## Step 1 — resolve the Project",
    "",
    "Run `git rev-parse --show-toplevel` from the cwd. That repository root IS the Project root. Outside a git repository, ask the Owner which repository to target and `cd` there first — never guess a Project.",
    "",
    "## Step 2 — `/factory <directive>`: dispatch the directive into the Project's SLP loop",
    "",
    "Run a single command:",
    "",
    `  ${input.factoryCmd} supervisor dispatch --workspace "$PWD" --message "<directive>"`,
    "",
    "Deterministic seat-aware routing:",
    "- In a normal chat session, `supervisor dispatch` ensures the `Project`'s `Supervisor` seat is open, delivers `<directive>` to `Supervisor`, and prints the `Supervisor` `agentId`.",
    "- Inside `Supervisor` (`PASEO_FACTORY_SEAT=supervisor`), `supervisor dispatch` routes `<directive>` straight into `Lead` (`lead_dispatch`).",
    "",
    `**Mandatory stop rule:** Immediately after running \`${input.factoryCmd} supervisor dispatch\`, end your turn and relay the command's output to the Owner. Never install packages, create files, edit code, or decompose tasks in this turn.`,
    "",
    "## Step 3 — bare `/factory`: bootstrap the Project's loop",
    "",
    `1. When \`/factory\` is invoked with no \`<directive>\`, run \`${input.factoryCmd} status\` (a local ledger read — one line per task; needs-human rows want the Owner's eye first).`,
    "2. Tell the `Owner` to click **`Start / Open Supervisor`** in the Factory surface's Seats & Models header on Paseo Desktop, or pass `/factory <directive>`.",
    "",
    "## Notes",
    "",
    "- The commands above target the default daemon home (`~/.paseo`, or `$PASEO_HOME` when set); against another daemon — e.g. the trial home — add `--home <paseoHome>`.",
    "- Never write the ledger, the mailbox, or Project state yourself: the plugin is the single writer, and every act goes through the commands above.",
    "",
  ].join("\n");
}

/**
 * Materializes (idempotently) the skill at `factorySkillPath(agentsSkillsDir)`
 * and returns that path — the raw reconcile: written when absent or when the
 * rendered content changed, untouched otherwise. THROWS on an unusable skills
 * root (unwritable, unreadable, a non-directory in the way) — the caller owns
 * the failure policy; the plugin's boot uses `ensureFactorySkillSafe`.
 */
export function ensureFactorySkill(agentsSkillsDir: string, input: FactorySkillInput): string {
  const path = factorySkillPath(agentsSkillsDir);
  mkdirSync(dirname(path), { recursive: true });
  const content = renderFactorySkill(input);
  if (existsSync(path) && readFileSync(path, "utf8") === content) return path;
  writeFileSync(path, content);
  return path;
}

/**
 * The boot door (the plugin server's one call): the same reconcile, but a
 * skill is a convenience artifact — an unwritable or unreadable
 * operator-global skills root (ownership, a read-only home, a denied file)
 * downgrades to ONE warning and a null, NEVER a thrown error, because the
 * raw verb's throw would otherwise kill the whole plugin boot (choke, spool,
 * Lead-mailbox runtime, rotation machine) for an artifact nobody depends on
 * to boot. Contrast the stateDir writes (`ensureClaimCli`, `createFactory`):
 * those target the daemon home the plugin already depends on, so their
 * fail-closed is doctrine; `~/.agents` is not a precondition.
 */
export function ensureFactorySkillSafe(agentsSkillsDir: string, input: FactorySkillInput, onWarn: (message: string) => void): string | null {
  try {
    return ensureFactorySkill(agentsSkillsDir, input);
  } catch (err) {
    onWarn(
      `skill: could not reconcile ${factorySkillPath(agentsSkillsDir)} — /factory stays unavailable this lifetime ` +
        `(the plugin boots regardless) — ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
