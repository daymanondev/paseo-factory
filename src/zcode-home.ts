/**
 * The zcode harness home provisioner (v0.0.94, ADR 0046): every factory role —
 * `supervisor`, `lead`, working `agent`, and the tool-less `headless` pass —
 * runs zcode inside a clean-room `ZCODE_STORAGE_DIR` materialized on demand at
 * `<stateDir>/zcode-home/<role>`, with working `Agent` (Peer) sessions isolated
 * per Task at `<stateDir>/zcode-home/tasks/<projectSlug>/<task>` (or the
 * `<stateDir>/zcode-home/agent` fallback) so concurrent Peers never contend on
 * one SQLite file (`SQLITE_BUSY`) or leak session history across Tasks.
 *
 * The real `HOME` and `ZCODE_HOME` are NEVER touched (ADR 0046, Gap 4):
 * replacing `HOME` breaks `scryptSync` AES-256-GCM decryption of
 * `~/.zcode/v2/credentials.json`, and replacing `ZCODE_HOME` hides
 * `$ZCODE_HOME/v2/credentials.json` from `zcode-acp-server`. Isolation rides
 * entirely on zcode's native storage variables — `ZCODE_STORAGE_DIR` and
 * `ZCODE_SESSION_DB_PATH` — which is why the provisioner returns an env
 * record, never a bare path. The operator's credential tree (`v2/`) is never
 * linked or copied into a clean room.
 *
 * Since v0.0.94 the three interactive roles each carry a MANAGED
 * `ROLE_SYSTEM.md` — their immutable SLP contract (`ROLE_PROMPTS[role]`) —
 * referenced by `instructions.userFile` in the generated `<roleHome>/config.json`
 * (ADR 0046, Decision 3): Paseo's `ACPAgentSession` does not forward
 * `config.systemPrompt` over ACP, so `zcode.cjs` must reload the contract from
 * the file on every turn, every compaction, and every resume. `supervisor`
 * alone symlinks the operator's `~/.zcode/skills` back in (100% Owner skill
 * parity), while `lead` and `agent` get scoped per-skill links that exclude
 * the Owner-only `factory` skill, and `headless` stays strictly stripped.
 *
 * Since v0.2.0 (ADR 0049 §1) a Scrum identity (`scrum`) reroutes the clean
 * room under the Project state dir —
 * `<projectStateDir>/scrum/zcode-home/seats/<selectionRevision>/<generation>/<authority>/`
 * for standing seats and `<projectStateDir>/scrum/zcode-home/runs/<runId>/<task>/<epoch>/`
 * for specialist tasks, the twin of the Pi `scrum/harness` hierarchy — so
 * concurrent SLP and Scrum projects on `zcode/*` never overwrite each other's
 * `ROLE_SYSTEM.md` or `db.sqlite`; the Scrum caller pairs it with a
 * `systemPrompt` carrying `renderScrumPrompt`'s output and, for `lead` and
 * the specialists, an `allowedSkills` allowlist reconciled exactly.
 *
 * Since v0.2.2 (ADR 0050 Decision 6) every roleHome whose symlink policy
 * excludes the Owner-only `factory` skill also carries the native per-path
 * `skill` override deny — `skill: {"<userHome>/.agents/skills/factory":
 * {"enable": false}}` — in its generated `config.json`: `zcode.cjs`
 * hardcodes its user-scope skill roots at `<homedir()>/.zcode/skills` and
 * `<homedir()>/.agents/skills` (never redirected by `ZCODE_STORAGE_DIR`), so
 * the scoped `<roleHome>/skills` links never reach the roots a session
 * actually reads. The override is matched by realpath — one `.agents` key
 * disables the `.zcode` symlink copy too — and a disabled skill is
 * un-invocable, not merely unlisted. The SLP `supervisor` (whole-dir Owner
 * parity) is the single exemption; the Scrum supervisor seat's scoped policy
 * already excludes `factory`, so it carries the deny like every other
 * non-parity home, and the symlinks stay provisioned as belt-and-suspenders.
 *
 * Provisioning is idempotent and synchronous (the role-env seam that calls it
 * returns a plain env record, never a Promise): a second call finds the same
 * home in the same state and never duplicates or breaks a symlink it already
 * made — an already-correct symlink is never removed and recreated (the
 * v0.0.38 ADR 0026 §1 race law shared with `src/pi-home.ts`).
 *
 * Placement: this file is pure Node (zero Paseo imports) and lives in `src/`
 * because two consumers on opposite sides of the placement law need it —
 * `src/lanes.ts` imports it directly (the headless `zcode` lane), and
 * `plugin/server/roles.ts` imports the verbatim copy
 * `scripts/sync-plugin-core.mjs` vendors into `plugin/server/core/` (the
 * `./core/project.ts` precedent).
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderRoleAppendSystem } from "./roles-contract.ts";
import { projectStateDir } from "./project.ts";

/** The factory roles that get an isolated zcode harness home (spec §Implementation Decisions 1). */
export type ZcodeAgentRole = "supervisor" | "lead" | "agent" | "headless";

/** The interactive roles — every factory role except the tool-less `headless` pass. */
export type InteractiveZcodeAgentRole = Exclude<ZcodeAgentRole, "headless">;

/**
 * The Scrum execution identity that reroutes the clean room under the Project
 * state dir (v0.2.0, ADR 0049 §1): standing seats land at
 * `<projectStateDir>/scrum/zcode-home/seats/<selectionRevision>/<generation>/<authority>/`
 * and specialist tasks at
 * `<projectStateDir>/scrum/zcode-home/runs/<runId>/<task>/<epoch>/` — mirroring
 * the Pi `scrum/harness` hierarchy (`src/scrum/harness.ts`) — so concurrent
 * SLP and Scrum projects on `zcode/*` never share one `ROLE_SYSTEM.md` or
 * `db.sqlite`.
 */
export type ScrumZcodeHomeIdentity =
  | { kind: "seat"; selectionRevision: number; generation: string; authority: "supervisor" | "lead" | "agent" }
  | { kind: "task"; runId: string; task: string; epoch: number };

export interface ProvisionZcodeHomeOptions {
  /** The factory state directory — the harness home is materialized at `<stateDir>/zcode-home/<role>`. */
  stateDir: string;
  role: ZcodeAgentRole;
  /**
   * The working Agent's Project identity — with `task`, lands the home at
   * `<stateDir>/zcode-home/tasks/<projectSlug>/<task>` so parallel Peers never
   * share a SQLite file (ADR 0046, Decision 4). Ignored for the standing roles.
   */
  projectSlug?: string;
  /** The working Agent's Task id — see `projectSlug`. */
  task?: string;
  /**
   * The operator home the skills policy reads from. Default `homedir()`; the
   * real `HOME`/`ZCODE_HOME` env of the child process are never replaced.
   * Hermetic tests pass a temp directory and never read the real one.
   */
  userHome?: string;
  /**
   * Overrides the role's canonical `ROLE_PROMPTS[role]` as the managed
   * `ROLE_SYSTEM.md` content. Interactive roles only — `headless` never gets
   * one; an empty string writes nothing (and no `config.json` wiring).
   */
  systemPrompt?: string;
  /**
   * The Scrum execution identity (v0.2.0, ADR 0049 §1): when present, the
   * clean room reroutes under `<projectStateDir>/scrum/zcode-home/...`
   * instead of the mode-shared `<stateDir>/zcode-home/...` roots — the Scrum
   * caller pairs it with a `systemPrompt` carrying `renderScrumPrompt`'s
   * output so `ROLE_SYSTEM.md` never falls back to the SLP
   * `ROLE_PROMPTS[role]` contract. Absent (SLP), paths stay byte-identical.
   * Requires a non-empty `projectSlug` — the Project state dir anchors the
   * reroute.
   */
  scrum?: ScrumZcodeHomeIdentity;
  /**
   * The explicit per-skill allowlist for `<roleHome>/skills/` (v0.2.0, ADR
   * 0049 §1): when present, `skills/` reconciles against exactly this list
   * (installed entries only — an allowed but uninstalled skill never becomes
   * a broken symlink) instead of the per-role default. Ignored for the
   * tool-less `headless` pass (stays stripped).
   */
  allowedSkills?: readonly string[];
}

/**
 * The canonical per-role SLP contracts — the same single source
 * (`src/roles-contract.ts` via `renderRoleAppendSystem`) the Pi provisioner
 * builds its `ROLE_PROMPTS` from: each interactive role's immutable law plus
 * its exact `factory` CLI vocabulary, written to the role's managed
 * `ROLE_SYSTEM.md` — the file `zcode.cjs` reloads on every turn, every
 * compaction, and every resume (the compaction-proof channel).
 */
export const ROLE_PROMPTS: Record<InteractiveZcodeAgentRole, string> = {
  supervisor: renderRoleAppendSystem("supervisor"),
  lead: renderRoleAppendSystem("lead"),
  agent: renderRoleAppendSystem("agent"),
};

/**
 * The Layer-1 seat write-tool lock (ADR 0046, Decision 5): the write/edit tool
 * names `zcode-acp-server` forwards into `session/create` `toolDenylist`.
 * Set only for `supervisor` and `lead`.
 */
export const ZCODE_SEAT_DISALLOWED_TOOLS = "Write,Edit,MultiEdit,NotebookEdit,DeleteFile";

/** The three core Lead skills (ADR 0010 §6) — the `lead` role's whole scoped skill set. */
const CORE_LEAD_SKILLS = ["codebase-design", "domain-modeling", "tdd"] as const;

/** The Owner-only skill never provisioned for `lead` or `agent` (the pi settings-filter precedent). */
const OWNER_ONLY_SKILL = "factory";

/**
 * Materializes (idempotently) the isolated zcode harness home for `role` and
 * returns the env record for the child process: `ZCODE_STORAGE_DIR`,
 * `ZCODE_SESSION_DB_PATH`, the quota/workflow hardening, `ZCODE_ACP_MODE` —
 * plus `ZCODE_DISALLOWED_TOOLS` for `supervisor`/`lead` only. The record never
 * contains `HOME` or `ZCODE_HOME` (ADR 0046, Gap 4).
 */
export function provisionZcodeHome(input: ProvisionZcodeHomeOptions): Record<string, string> {
  const userHome = input.userHome ?? homedir();
  const roleHome = resolveRoleHome(input);
  mkdirSync(roleHome, { recursive: true });
  // The per-seat SQLite file's parent — zcode creates db.sqlite itself, but the
  // directory existing up front keeps the first session's open race-free.
  mkdirSync(join(roleHome, "db"), { recursive: true });
  writeRoleContract(roleHome, input.role, input.systemPrompt, factorySkillDenyPath(userHome, input));
  provisionSkills(join(userHome, ".zcode", "skills"), roleHome, input.role, input);
  const env: Record<string, string> = {
    ZCODE_STORAGE_DIR: roleHome,
    ZCODE_SESSION_DB_PATH: join(roleHome, "db", "db.sqlite"),
    ZCODE_DYNAMIC_WORKFLOW_MODE: "disabled",
    ZCODE_ACP_QUOTA_AUTO_RESUME: "0",
    ZCODE_ACP_QUOTA_BOOT_NOTICE: "0",
    ZCODE_ACP_MODE: "guarded",
  };
  if (input.role === "supervisor" || input.role === "lead") {
    env.ZCODE_DISALLOWED_TOOLS = ZCODE_SEAT_DISALLOWED_TOOLS;
  }
  return env;
}

/**
 * The home for this provisioning call: a Scrum identity reroutes under the
 * Project state dir (v0.2.0, ADR 0049 §1 — the `scrum/zcode-home` twin of the
 * Pi `scrum/harness` hierarchy, so SLP and Scrum never collide); otherwise an
 * explicit standing-role home at `<stateDir>/zcode-home/<role>`, the per-Task
 * isolation directory for a working Agent with both halves of its Task
 * identity, or the `<stateDir>/zcode-home/agent` fallback.
 */
function resolveRoleHome(input: ProvisionZcodeHomeOptions): string {
  if (input.scrum !== undefined) {
    if (typeof input.projectSlug !== "string" || input.projectSlug === "") {
      throw new Error("scrum zcode-home provisioning requires a projectSlug");
    }
    const root = join(projectStateDir(input.stateDir, input.projectSlug), "scrum", "zcode-home");
    return input.scrum.kind === "seat"
      ? join(root, "seats", String(input.scrum.selectionRevision), input.scrum.generation, input.scrum.authority)
      : join(root, "runs", input.scrum.runId, input.scrum.task, String(input.scrum.epoch));
  }
  if (
    input.role === "agent" &&
    typeof input.projectSlug === "string" && input.projectSlug !== "" &&
    typeof input.task === "string" && input.task !== ""
  ) {
    return join(input.stateDir, "zcode-home", "tasks", input.projectSlug, input.task);
  }
  return join(input.stateDir, "zcode-home", input.role);
}

/**
 * The managed `ROLE_SYSTEM.md` (ADR 0046, Decision 3): the three interactive
 * roles carry their immutable SLP contract — an explicit `systemPrompt`
 * overrides the role default verbatim — while the tool-less `headless` pass
 * never gets one (an explicit override never lands for headless either) and an
 * empty override writes nothing. `config.json` wires
 * `instructions: { userFile: <roleHome>/ROLE_SYSTEM.md, projectFile: "AGENTS.md" }`
 * — the channel `zcode.cjs` reloads on every turn, compaction, and resume —
 * and exists exactly when the contract file does. Since v0.2.2 (ADR 0050
 * Decision 6) a non-empty `factorySkillDenyPath` also writes the native
 * per-path `skill` override `{"<path>": {"enable": false}}` into the same
 * `config.json` — the real-root enforcement layer for the Owner-only
 * `factory` skill.
 */
function writeRoleContract(roleHome: string, role: ZcodeAgentRole, systemPrompt: string | undefined, factorySkillDenyPath: string | undefined): void {
  const contractPath = join(roleHome, "ROLE_SYSTEM.md");
  const configPath = join(roleHome, "config.json");
  const content = role === "headless" ? "" : systemPrompt ?? ROLE_PROMPTS[role];
  if (content === "") {
    rmSync(contractPath, { force: true });
    rmSync(configPath, { force: true });
    return;
  }
  writeFileSync(contractPath, content.endsWith("\n") ? content : `${content}\n`);
  const config: { instructions: { userFile: string; projectFile: string }; skill?: Record<string, { enable: boolean }> } = {
    instructions: { userFile: contractPath, projectFile: "AGENTS.md" },
  };
  if (factorySkillDenyPath !== undefined) {
    config.skill = { [factorySkillDenyPath]: { enable: false } };
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * The native per-path `skill` override key that denies the Owner-only
 * `factory` skill (v0.2.2, ADR 0050 Decision 6): the userHome-expanded
 * absolute path of the `.agents` original — `<userHome>/.agents/skills/factory`
 * — returned for every roleHome whose symlink policy already excludes
 * `factory` (`lead`, `agent`, and every Scrum identity, the Scrum supervisor
 * seat included: its scoped per-skill links never carry the Owner-only skill
 * either). `zcode.cjs` matches the override by realpath, so the single
 * `.agents` key also disables the `~/.zcode/skills/factory` symlink copy, and
 * a disabled skill is un-invocable, not merely unlisted. The single exemption
 * is the SLP supervisor — `role === "supervisor"` with no Scrum identity —
 * whose whole-dir symlink keeps 100% Owner skill parity; `headless` never
 * reaches the question at all (it writes no `config.json`).
 */
function factorySkillDenyPath(userHome: string, input: Pick<ProvisionZcodeHomeOptions, "role" | "scrum">): string | undefined {
  if (input.role === "supervisor" && input.scrum === undefined) return undefined;
  return join(userHome, ".agents", "skills", OWNER_ONLY_SKILL);
}

/**
 * The per-role skills policy (ADR 0046, Decision 4): `supervisor` symlinks the
 * operator's `~/.zcode/skills` whole (100% Owner parity, never churning an
 * already-correct link); `lead` and `agent` carry a scoped directory of
 * per-skill symlinks — Lead its three core skills, the working Agent every
 * installed skill except the Owner-only `factory` — reconciled so stale links
 * retire; `headless` stays strictly stripped.
 *
 * Since v0.2.0 (ADR 0049 §1) the Scrum seats ride the same scoped directory:
 * an explicit `allowedSkills` list (the Scrum role's
 * `resolveRoleSkillsForProject` set) reconciles `skills/` against exactly
 * that list, and a Scrum `supervisor` — `scrum` identity present — takes
 * every installed skill except `factory` as per-skill links instead of the
 * whole-dir symlink the SLP supervisor keeps.
 */
function provisionSkills(userSkillsDir: string, roleHome: string, role: ZcodeAgentRole, policy: Pick<ProvisionZcodeHomeOptions, "scrum" | "allowedSkills">): void {
  const skillsPath = join(roleHome, "skills");
  if (role === "supervisor" && policy.scrum === undefined) {
    if (existsSync(userSkillsDir)) {
      ensureSymlink(userSkillsDir, skillsPath);
    } else {
      rmSync(skillsPath, { recursive: true, force: true });
    }
    return;
  }
  if (role === "headless") {
    rmSync(skillsPath, { recursive: true, force: true });
    return;
  }
  const allowed =
    policy.allowedSkills !== undefined
      ? policy.allowedSkills.filter((name) => isSkillDir(join(userSkillsDir, name)))
      : role === "lead"
        ? CORE_LEAD_SKILLS.filter((name) => isSkillDir(join(userSkillsDir, name)))
        : listInstalledSkills(userSkillsDir).filter((name) => name !== OWNER_ONLY_SKILL);
  mkdirSync(skillsPath, { recursive: true });
  // Reconcile: anything outside the scoped set (a retired skill, a planted
  // link) is swept before the expected links are ensured.
  for (const name of readdirSync(skillsPath)) {
    if (!(allowed as readonly string[]).includes(name)) {
      rmSync(join(skillsPath, name), { recursive: true, force: true });
    }
  }
  for (const name of allowed) {
    ensureSymlink(join(userSkillsDir, name), join(skillsPath, name));
  }
}

/** The skill directories under `dir` — entries carrying a `SKILL.md`, dotfiles skipped. */
function listInstalledSkills(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith(".") && isSkillDir(join(dir, name)));
  } catch {
    return [];
  }
}

function isSkillDir(path: string): boolean {
  return existsSync(join(path, "SKILL.md"));
}

/**
 * Whether `linkPath` is a symlink already pointing at `target` — checked
 * with `lstatSync`/`readlinkSync` BEFORE any removal (the v0.0.38 ADR 0026 §1
 * law shared with `src/pi-home.ts`): the raw link text matches, or both sides
 * resolve to the same real path. Never throws; anything absent or unreadable
 * is simply not the expected link.
 */
function symlinkPointsAt(linkPath: string, target: string): boolean {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false;
    if (readlinkSync(linkPath) === target) return true;
    return realpathSync(linkPath) === realpathSync(target);
  } catch {
    return false; // absent, broken, or unreadable — the caller (re)creates it
  }
}

/**
 * Points `linkPath` at `target`, replacing whatever else sits there — unless
 * the exact link already exists, in which case it is left untouched: a
 * re-provision never duplicates or breaks a symlink it already made.
 */
function ensureSymlink(target: string, linkPath: string): void {
  if (symlinkPointsAt(linkPath, target)) return;
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath);
}
