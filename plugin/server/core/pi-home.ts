/**
 * The Pi harness home provisioner (v0.0.16, ADR 0011): every factory role —
 * `supervisor`, `lead`, working `agent`, and the tool-less `headless` pass —
 * runs pi inside an isolated `PI_CODING_AGENT_DIR` materialized on demand at
 * `<stateDir>/pi-agent/<role>`. Each harness home carries a GENERATED
 * clean-room `settings.json` (zero user packages, zero user extensions —
 * only the operator's model/thinking defaults ride along) and a SANITIZED
 * `mcp.json` (legacy `pi-mcp-adapter` `"auth": "oauth"` strings stripped for
 * Pi v1.3.0's native `builtin:mcp`), while authentication, custom models,
 * OAuth credentials, and the `sessions/` tree stay SHARED through symlinks
 * back to the operator's Pi home. The prompt contamination —
 * `APPEND_SYSTEM.md`, `SYSTEM.md`, `extensions/`, `prompts/`, `skills/` — is
 * never linked or copied, so no role or headless pass ever inherits the
 * operator's global TUI rules or pays its package-resolution cost.
 *
 * Provisioning is idempotent and synchronous (the role-env seam that calls it
 * returns a plain env record, never a Promise): a second call finds the same
 * home in the same state, re-synchronizing `mcp.json` so operator edits
 * propagate on the next session open or create, and never duplicates or
 * breaks a symlink it already made.
 *
 * Placement: this file is pure Node (zero Paseo imports) and lives in `src/`
 * because two consumers on opposite sides of the placement law need it —
 * `src/lanes.ts` imports it directly, and `plugin/server/roles.ts` imports
 * the verbatim copy `scripts/sync-plugin-core.mjs` vendors into
 * `plugin/server/core/` (the `./core/project.ts` precedent).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The factory roles that get an isolated Pi harness home (spec §Implementation Decisions 1). */
export type PiAgentRole = "supervisor" | "lead" | "agent" | "headless";

export interface ProvisionPiHomeOptions {
  /** The factory state directory — the harness home is materialized at `<stateDir>/pi-agent/<role>`. */
  stateDir: string;
  role: PiAgentRole;
  /**
   * The operator's Pi agent home the shared-state symlinks point back at.
   * Default `<homedir>/.pi/agent`; hermetic tests pass a temp directory and
   * never read the real one.
   */
  sourceAgentDir?: string;
  /**
   * The shared engineering skills catalog the generated `"agent"` skills
   * filters pin — default Pi's `~` form (`~/.agents/skills`, expanded by pi
   * at session time against the runtime home); hermetic tests pass an
   * explicit directory and the filters derive from it verbatim.
   */
  agentsSkillsDir?: string;
}

/**
 * The shared state that rides along as symlinks when present in the source
 * home: provider auth, custom model definitions, and every OAuth credential
 * store shape pi has used (so `/mcp login` tokens are shared in both
 * directions).
 */
const SHARED_STATE_NAMES = ["auth.json", "models.json", "models-store.json", "mcp-oauth", "mcp-oauth.json", "oauth", "credentials"] as const;

/** The operator's prompt contamination — never linked, never copied, kept absent. */
const FORBIDDEN_NAMES = ["APPEND_SYSTEM.md", "SYSTEM.md", "extensions", "prompts", "skills"] as const;

/** The only source-settings keys the clean room preserves, and only when strings. */
const OPERATOR_DEFAULT_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;

/** The three core working-Agent skills (ADR 0010 §6) — the `agent` role's whole `<available_skills>`. */
const CORE_AGENT_SKILLS = ["tdd", "diagnosing-bugs", "codebase-design"] as const;

/**
 * Materializes (idempotently) the isolated Pi harness home for `role` and
 * returns its path — the value callers inject as `PI_CODING_AGENT_DIR`.
 */
export function provisionPiAgentHome(input: ProvisionPiHomeOptions): string {
  const sourceAgentDir = input.sourceAgentDir ?? join(homedir(), ".pi", "agent");
  const roleHome = join(input.stateDir, "pi-agent", input.role);
  mkdirSync(roleHome, { recursive: true });
  for (const forbidden of FORBIDDEN_NAMES) {
    rmSync(join(roleHome, forbidden), { recursive: true, force: true });
  }
  writeSettingsJson(sourceAgentDir, roleHome, input.role, input.agentsSkillsDir ?? "~/.agents/skills");
  syncMcpJson(sourceAgentDir, roleHome, input.role);
  for (const name of SHARED_STATE_NAMES) {
    const source = join(sourceAgentDir, name);
    if (existsSync(source)) ensureSymlink(source, join(roleHome, name));
  }
  const sessions = join(sourceAgentDir, "sessions");
  try {
    mkdirSync(sessions, { recursive: true });
  } catch {
    // A source home that is neither writable nor creatable cannot carry
    // sessions — skip the link rather than fail the seat (spec: "when the
    // source dir is writable or creatable").
  }
  if (existsSync(sessions)) ensureSymlink(sessions, join(roleHome, "sessions"));
  return roleHome;
}

/**
 * The generated clean-room settings: the operator's model/thinking defaults
 * (when strings) plus the enforced floor — `packages: []`,
 * `extensions: ["-builtin:llama.cpp"]` (keeping `builtin:mcp`,
 * `builtin:codemode`, and `builtin:tool-search` enabled), `quietStartup`,
 * and `defaultProjectTrust: "always"` so `<project-root>/.pi/mcp.json`
 * overrides work. Per role: `agent` filters skills down to the three core
 * skills under `agentsSkillsDir` (Pi's `~` form by default); `supervisor`
 * and `lead` leave `"skills"` out so pi auto-discovers all of
 * `~/.agents/skills`; `headless` denies every skill and every interactive
 * builtin extension on top of the CLI's own `--no-*` flags.
 */
function writeSettingsJson(sourceAgentDir: string, roleHome: string, role: PiAgentRole, agentsSkillsDir: string): void {
  const settings: Record<string, unknown> = {};
  const source = readJsonObject(join(sourceAgentDir, "settings.json"));
  if (source !== undefined) {
    for (const key of OPERATOR_DEFAULT_KEYS) {
      const value: unknown = source[key];
      if (typeof value === "string") settings[key] = value;
    }
  }
  settings.packages = [];
  settings.extensions =
    role === "headless"
      ? ["-builtin:llama.cpp", "-builtin:mcp", "-builtin:codemode", "-builtin:tool-search"]
      : ["-builtin:llama.cpp"];
  settings.quietStartup = true;
  settings.defaultProjectTrust = "always";
  if (role === "agent") {
    settings.skills = ["!*", ...CORE_AGENT_SKILLS.map((skill) => `+${join(agentsSkillsDir, skill)}`)];
  } else if (role === "headless") {
    settings.skills = ["!*"];
  }
  writeFileSync(join(roleHome, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Synchronizes the source `mcp.json` into the harness home sanitized for Pi
 * v1.3.0's native `builtin:mcp`: every server entry whose `auth` is the
 * legacy `pi-mcp-adapter` string `"oauth"` loses `auth`, while valid object
 * shapes (`auth: { provider: "..." }`) and every other field pass through
 * untouched. Only the three session-bearing roles get an `mcp.json` — the
 * tool-less `headless` pass runs `--no-tools` and never sees an MCP server.
 * Re-runs on every provision call, so operator edits propagate immediately;
 * a source that is absent or no longer valid retires any stale copy.
 */
function syncMcpJson(sourceAgentDir: string, roleHome: string, role: PiAgentRole): void {
  const target = join(roleHome, "mcp.json");
  if (role === "headless") return;
  const source = readJsonObject(join(sourceAgentDir, "mcp.json"));
  const servers = source !== undefined && isJsonObject(source.mcpServers) ? source.mcpServers : undefined;
  if (servers === undefined) {
    rmSync(target, { force: true });
    return;
  }
  const mcpServers: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(servers)) {
    mcpServers[name] = isJsonObject(entry) && entry.auth === "oauth" ? withoutAuth(entry) : entry;
  }
  writeFileSync(target, `${JSON.stringify({ ...source, mcpServers }, null, 2)}\n`);
}

/** A copy of `entry` without its `auth` field, key order otherwise preserved. */
function withoutAuth(entry: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key !== "auth") copy[key] = value;
  }
  return copy;
}

/**
 * Points `linkPath` at `target`, replacing whatever else sits there — unless
 * the exact link already exists, in which case it is left untouched: a
 * re-provision never duplicates or breaks a symlink it already made.
 */
function ensureSymlink(target: string, linkPath: string): void {
  try {
    if (lstatSync(linkPath).isSymbolicLink() && realpathSync(linkPath) === realpathSync(target)) return;
  } catch {
    // absent or unreadable — (re)created below
  }
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parsed object at `path`, or undefined when absent, invalid, or not an object. */
function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
