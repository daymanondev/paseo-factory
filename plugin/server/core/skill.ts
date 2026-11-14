/**
 * The global `/factory` skill (v0.0.20, ADR 0013 Decision 3; v0.0.23, ADR 0015
 * Decision 5): the managed `SKILL.md` reconciled across all three roots:
 * `~/.agents/skills/factory/SKILL.md` (`pi` / `opencode`) and
 * `~/.claude/skills/factory/SKILL.md` (`claude`) and
 * `~/.pi/agent/skills/factory/SKILL.md` (pi agent dir, ADR 0036) that lets the Owner type
 * `/factory <directive>` in any session and have that session bootstrap or
 * dispatch deterministically into the Project's SLP loop —
 * `factory supervisor dispatch` for the directive arm (seat-aware routing into
 * `Supervisor` from a normal chat or into `Lead` from inside `Supervisor`),
 * and the native `Supervisor (Factory)` New Chat picker for the bootstrap
 * arm (v0.0.27, ADR 0017 — the Factory surface's Start buttons are gone).
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

/**
 * The harness skill roots the managed skill lives under for one home — the
 * three places a session discovers `/factory`: `~/.agents/skills` (`pi` /
 * `opencode`), `~/.claude/skills` (`claude`), and `~/.pi/agent/skills` (the pi
 * agent dir, ADR 0036 §2 — the precedent that already mirrors skills there).
 * Every root is plugin-managed: a drifted or hand-edited copy in any of them
 * reconciles back to the canonical render.
 */
export function factorySkillRoots(userHome: string): string[] {
  return [join(userHome, ".agents", "skills"), join(userHome, ".claude", "skills"), join(userHome, ".pi", "agent", "skills")];
}

/** Where the skill lives under a skills root — `<agentsSkillsDir>/factory/SKILL.md`. */
export function factorySkillPath(agentsSkillsDir: string): string {
  return join(agentsSkillsDir, "factory", "SKILL.md");
}

/** Renders the skill verbatim — one pure function, so tests pin the law, not the file. */
export function renderFactorySkill(input: FactorySkillInput): string {
  const cmd = input.factoryCmd;
  return [
    "---",
    "name: factory",
    "description: Bootstrap or dispatch into the current Project's paseo-factory SLP loop (Owner → Supervisor → Lead → Agent) — /factory [directive].",
    "---",
    "",
    "You are serving the Owner of paseo-factory. `/factory` has two mutually exclusive modes depending on whether the Owner passed a `<directive>`. Choose **either** Mode A **or** Mode B — never run both.",
    "",
    "## Mode A — When invoked with a directive: /factory <directive>",
    "",
    `1. **Pre-flight** — gate every dispatch from a normal chat on a registered Project. A seat (\`PASEO_FACTORY_SEAT\` set) skips to step 3: no gate, no echo. Run \`${cmd} doctor --workspace "$PWD" --json\`. Exit 2 means a stale recorded plugin install: relay its output and end the turn. If the command itself cannot run (the CLI door is missing, \`not found\` / \`Cannot find module\`), the plugin install this skill names is gone: tell the Owner to update or reinstall the paseo-factory plugin, then re-run \`/factory\`, and end the turn. Otherwise read \`.workspace\`, \`.registered\` and \`.home\`. \`.workspace.root\` is the git root \`$PWD\` resolves to; from a subdirectory, say it resolved up to the git root.`,
    "",
    "   - `.registered` true: go to step 2.",
    "   - Otherwise (unregistered, or `.workspace.resolved` false for a folder with no git repository) put one choice to the Owner and wait. Never register or dispatch without the Owner's explicit choice.",
    "     1. **Register here** — `<slug>` at `<root>` · home `<home>` (a folder with no git repository: label it \"initialises Git, then registers\" and use `.workspace.dir`).",
    `     2. **Pick an existing Project** — run \`${cmd} project list --json\` and offer each entry as \`<slug> — <root> · home <home>\`; no entries means no option 2.`,
    "     3. **Abort** — end the turn: nothing is written, no dispatch.",
    "",
    `   **Register here:** run \`${cmd} project register --workspace "<root>" --json\`. Exit 0 returns \`.slug\`, \`.root\`, \`.home\`, \`.alreadyRegistered\`; then go to step 2. Exit 2 with \`plugin is not running\` in stderr: tell the Owner to start Paseo Desktop and re-run \`/factory\`; any other exit 2: relay stderr. Either way end the turn with nothing dispatched.`,
    "",
    "2. Echo to the Owner the resolved workspace and daemon home in one line — `<slug> at <root> · home <home>` — before any dispatch. Routing is explicit per invocation: the registered workspace or the Owner's pick this turn names the Project.",
    `3. Run a single command:`,
    "",
    `  ${cmd} supervisor dispatch --workspace "$PWD" --message "<directive>"`,
    "",
    `A picked existing Project dispatches by its slug instead: \`${cmd} supervisor dispatch --project <slug> --message "<directive>"\` — the slug is the explicit routing, and that entry's \`<root>\` and \`<home>\` feed the echo.`,
    "",
    `If it exits 2 with \`unregistered-project\`, relay it and re-offer the choice. Pass \`--allow-unregistered\` (legacy held dispatch) only when the Owner explicitly asks for it.`,
    "",
    "Deterministic seat-aware routing:",
    "- In a normal chat session, `supervisor dispatch` ensures the `Project`'s `Supervisor` seat is open, delivers `<directive>` to `Supervisor`, and prints the `Supervisor` `agentId`.",
    "- Inside `Supervisor` (`PASEO_FACTORY_SEAT=supervisor`), `supervisor dispatch` routes `<directive>` straight into `Lead` (`lead_dispatch`).",
    "",
    `4. **STOP IMMEDIATELY:** Immediately after running \`${cmd} supervisor dispatch\`, end your turn and relay the command's output to the Owner. Never install packages, create files, edit code, or decompose tasks in this turn. Do **not** run \`factory status\`, do **not** call any Paseo MCP agent tools (\`create_agent\`, \`kill_agent\`, \`update_agent\`, \`get_agent_status\`, \`send_message\`), and do **not** read, create, edit, or delete any files in the repository. The sole exception is step 5's optional lane-profile offer, which follows the relay.`,
    `5. **Lane profile (optional, after the dispatch)** — only when this turn's \`project register\` returned \`.alreadyRegistered\` false and the dispatch succeeded. The directive has already gone out; this step never holds it back. Run \`${cmd} profile list --json\`. No profiles: no question, default lanes apply silently. Otherwise ask one question — apply or skip: one option per profile as \`<id> — <name>\`, plus **Skip** — and apply the pick with \`${cmd} profile apply <id> --project "<root>"\`. A skip or a failed apply is one line to the Owner; then end your turn.`,
    "",
    "## Mode B — When invoked with NO arguments: bare /factory",
    "",
    `1. **ONLY** when the user invoked bare \`/factory\` with no \`<directive>\` arguments (do NOT run this if you executed Mode A), run \`${cmd} status\` (a local ledger read — one line per task; needs-human rows want the Owner's eye first).`,
    "2. Tell the `Owner` to open a New Chat and select **`Supervisor (Factory)`** in Paseo's native agent picker on Paseo Desktop, or pass `/factory <directive>`.",
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

/**
 * Reconciles the skill into EVERY harness root of `userHome` through the safe
 * door — one failing root warns once on its own and never blocks the others.
 * Both boot paths (initial boot and the re-sync after an install refresh) call
 * this, so a plugin update's next sync re-renders every root with the current
 * install's door and no baked checkout UUID survives. Returns the paths written
 * (or already in sync); unusable roots are omitted.
 */
export function ensureFactorySkillRootsSafe(userHome: string, input: FactorySkillInput, onWarn: (message: string) => void): string[] {
  const reconciled: string[] = [];
  for (const root of factorySkillRoots(userHome)) {
    const path = ensureFactorySkillSafe(root, input, onWarn);
    if (path !== null) reconciled.push(path);
  }
  return reconciled;
}
