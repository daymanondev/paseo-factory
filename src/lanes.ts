/**
 * The unified Lane config and the headless tool-less runner (v0.0.13, ADR
 * 0009 §3; the `lead` lane and per-Project overrides arrive in v0.0.14, ADR
 * 0010 §2/§5). `<stateDir>/lanes.json` names the provider/model lane every
 * model-bearing role runs under — `supervisor`, `lead`, `worker`, `watch`,
 * `retro`, `freshEyes` — with safe defaults (`pi/zcode/glm-5.3`, $0 marginal)
 * when the file is absent or partial, and an optional per-Project override
 * file under `<stateDir>/projects/<slug>/lanes.json` layered on top. The
 * machine file is the one place the Owner configures or switches models; a
 * Project file tunes one repository without touching the machine table; an
 * explicit `--provider` on `factory run` overrides `worker`, and the plugin
 * surface edits the same files in place.
 *
 * Every CLI lane dispatches headless AND tool-less by construction — the
 * flags below are the invariant, not a promise the model is asked to keep:
 *   pi/<model>     → `pi --print --no-session --no-tools --no-extensions
 *                     --no-skills --no-context-files --model <model>`
 *   copilot/<model>→ `copilot -s --model <model> --reasoning-effort medium`
 *   claude/<model> → `claude -p --model <model> --tools ""`
 *   opencode/<model> → `opencode run --standalone -m opencode/<model>`
 *                     (the runner injects TOOLLESS_OPENCODE_CONFIG; read
 *                     asks are rejected by non-interactive standalone mode)
 * The prompt rides stdin (the watch's discipline since amendment 2); the
 * runner owns a scratch cwd and a SIGKILL deadline. `eye.json` is not a CLI
 * lane — it is the fresh-eyes pass's legacy direct-HTTP configuration, legal
 * for `freshEyes` alone (src/fresh-eyes.ts reads it).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { provisionPiAgentHome } from "./pi-home.ts";
import { projectStateDir } from "./project.ts";
import type { PeerThinkingLevel } from "./peer-thinking.ts";

// ---- Owner-authored Lane profiles (v0.0.38, ADR 0026 §2) -----------------------------------
// The Lane profile store and its pure operations live in ./lane-profiles.ts
// and are re-exported here — the one lane-config surface the plugin server's
// vendored core imports (the `./core/project.ts` precedent).

export {
  applyLaneProfile,
  deleteLaneProfile,
  getLaneProfile,
  laneProfileIdFromName,
  laneProfilesPath,
  listLaneProfiles,
  mergeLaneProfilesFiles,
  readLaneProfilesFile,
  resetProjectLanes,
  saveLaneProfile,
  saveLanesBatch,
} from "./lane-profiles.ts";
export type { LaneProfile, LaneProfileTombstone, LaneProfilesFile } from "./lane-profiles.ts";

/** The six model-bearing roles — the file's exact key set (5 UI cards; supervisor and lead pair under Seats). */
export const LANE_NAMES = ["supervisor", "lead", "worker", "watch", "retro", "freshEyes"] as const;

export type LaneName = (typeof LANE_NAMES)[number];

/** One lane table — every role present, every value a validated lane string. */
export type Lanes = Record<LaneName, string>;

/** The safe default everywhere: the $0 marginal lane, no key, no quota. */
export const DEFAULT_LANE = "pi/zcode/glm-5.3";

/** The fresh-eyes pass's legacy lane: direct HTTP via `<stateDir>/eye.json`. */
export const EYE_JSON_LANE = "eye.json";

/** Where the lane table lives — `<stateDir>/lanes.json`, beside the ledger. */
export function lanesPath(stateDir: string): string {
  return join(stateDir, "lanes.json");
}

/**
 * Where one Project's lane overrides live (v0.0.14, ADR 0010 §5) —
 * `<stateDir>/projects/<slug>/lanes.json`, the Project's own state tree.
 */
export function projectLanesPath(stateDir: string, projectSlug: string): string {
  return join(projectStateDir(stateDir, projectSlug), "lanes.json");
}

/** The fresh defaults — a fresh copy every call, never a shared mutable. */
export function defaultLanes(): Lanes {
  return { supervisor: DEFAULT_LANE, lead: DEFAULT_LANE, worker: DEFAULT_LANE, watch: DEFAULT_LANE, retro: DEFAULT_LANE, freshEyes: DEFAULT_LANE };
}

export type LanesResult = { ok: true; lanes: Lanes } | { ok: false; reason: string };

export interface ParsedLane {
  provider: string;
  model: string;
  thinking?: string;
}

/**
 * Splits a `provider/model[:thinking]` lane string into its provider, model,
 * and optional thinking level. Returns undefined for `eye.json` or any
 * malformed value (missing slash, empty parts, or whitespace).
 */
export function parseLane(value: string): ParsedLane | undefined {
  if (value === EYE_JSON_LANE || /\s/.test(value)) return undefined;
  const slash = value.indexOf("/");
  if (slash === -1) return undefined;
  const provider = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  if (provider.trim() === "" || rest.trim() === "") return undefined;
  const colon = rest.lastIndexOf(":");
  const lastSep = Math.max(rest.lastIndexOf("\\"), rest.lastIndexOf("/"));
  if (colon === -1 || colon < lastSep) return { provider, model: rest };
  const model = rest.slice(0, colon);
  const thinking = rest.slice(colon + 1);
  if (model.trim() === "" || thinking.trim() === "") return undefined;
  return { provider, model, thinking };
}

/**
 * Validates one lane string: `provider/model` (or `provider/model:thinking`)
 * with non-empty parts and no whitespace, or `eye.json` for `freshEyes` alone.
 * Returns the error text, or undefined when the value is usable.
 */
export function laneError(name: LaneName, value: string): string | undefined {
  if (name === "freshEyes" && value === EYE_JSON_LANE) return undefined;
  const slash = value.indexOf("/");
  if (slash === -1) {
    return `lane ${name}="${value}" is not provider/model — name the model explicitly (never auto), or "eye.json" for freshEyes`;
  }
  if (parseLane(value) === undefined) {
    return `lane ${name}="${value}" must be provider/model with both halves non-empty and no whitespace`;
  }
  return undefined;
}

/**
 * Migrates retired `zcode/<model>[:<thinking>]` (ADR 0046) and legacy
 * `pi/zai/glm-<rest>[:<thinking>]` lanes onto the canonical Pi ZCode proxy
 * lane `pi/zcode/<lowercase-model>[:<thinking>]` (ADR 0055 §3). Every other
 * lane string returns unchanged.
 */
export function migrateLegacyZcodeLane(value: string): string {
  const parsed = parseLane(value);
  if (parsed === undefined) return value;
  if (parsed.provider === "zcode") {
    const backslash = parsed.model.indexOf("\\");
    const rawModel = (backslash === -1 ? parsed.model : parsed.model.slice(backslash + 1)).trim();
    if (rawModel === "") return value;
    const lowerModel = rawModel.toLowerCase();
    return parsed.thinking === undefined ? `pi/zcode/${lowerModel}` : `pi/zcode/${lowerModel}:${parsed.thinking}`;
  }
  if (parsed.provider === "pi" && /^zai\/glm-/i.test(parsed.model)) {
    const lowerModel = parsed.model.slice("zai/".length).toLowerCase();
    return parsed.thinking === undefined ? `pi/zcode/${lowerModel}` : `pi/zcode/${lowerModel}:${parsed.thinking}`;
  }
  return value;
}

// ---- per-dispatch provider-adaptive thinking effort (v0.5.0, ADR 0054 §4) ------------------

/**
 * The five reasoning-effort tiers a Lead may request per dispatch (`low` …
 * `max`) — canonical home is the zero-import leaf `./peer-thinking.ts`,
 * re-exported so this module stays the public seam: importing the tiers from
 * here would pull `./ledger-validation.ts` (via `./history-import.ts`, inside
 * this module's own import graph back through `./pi-home.ts`) into a cycle
 * whose evaluation reaches `roles-contract.ts` before its top-level consts
 * initialize. See `./peer-thinking.ts` for the full rationale.
 */
export { PEER_THINKING_LEVELS } from "./peer-thinking.ts";
export type { PeerThinkingLevel } from "./peer-thinking.ts";

/**
 * The provider-catalog slice the effort resolution reads: one provider's
 * models with their advertised `thinkingOptions`. Structural on purpose —
 * the daemon's `providers.listModels` reply, `ProviderCatalogEntry`, and the
 * surface's `ProviderEntry` all satisfy it without conversion.
 */
export interface LaneThinkingCatalogModel {
  id: string;
  thinkingOptions?: readonly { id: string }[] | null;
}

export interface LaneThinkingCatalogEntry {
  id?: string;
  provider?: string;
  models?: readonly LaneThinkingCatalogModel[] | null;
}

/**
 * Resolves one per-dispatch `thinking` override against the configured
 * `worker` lane and the provider model catalog (ADR 0054 §4; the inverse of
 * `sanitizeLaneWithProviders` — this mapping never strips thinking):
 *
 * 1. No override requested → the configured lane verbatim (the Owner's
 *    `lanes.json` word is the whole truth).
 * 2. A model with no `thinkingOptions` (fixed/baked-in effort such as
 *    `antigravity/gemini-4-argon-high`, an unknown model, or an unreachable
 *    catalog) → the configured lane verbatim — the override is silently
 *    ignored, never an error, never a suffix mutation.
 * 3. The catalog carries the requested tier → `<provider>/<model>:<tier>`.
 * 4. A non-empty catalog without the requested tier → the nearest supported
 *    option, never a bare `<provider>/<model>`: `"medium"` lands on the
 *    Owner's configured suffix when the catalog carries it (else `"high"`,
 *    else the last option); `"xhigh"` lands on `"max"` (else `"high"`, else
 *    the last option); any other unsupported tier follows the medium ladder.
 *
 * Pure string work — no fs, no env — so the plugin server consults it at the
 * spawn call sites with the daemon catalog in hand.
 */
export function resolvePeerThinkingLane(
  configuredWorkerLane: string,
  requestedThinking: PeerThinkingLevel | undefined,
  providers?: readonly LaneThinkingCatalogEntry[],
): string {
  if (requestedThinking === undefined) return configuredWorkerLane;
  const lane = parseLane(configuredWorkerLane);
  if (lane === undefined) return configuredWorkerLane;
  const entry = providers?.find((p) => (p.provider ?? p.id) === lane.provider);
  const models = entry?.models;
  if (models === undefined || models === null) return configuredWorkerLane;
  const strippedModel = lane.model.replace(/^[^/]+\//, "");
  const meta = models.find(
    (m) =>
      m.id === lane.model ||
      `${lane.provider}/${m.id}` === lane.model ||
      m.id === `${lane.provider}/${lane.model}` ||
      m.id === strippedModel ||
      m.id.replace(/^[^/]+\//, "") === strippedModel,
  );
  const options = meta?.thinkingOptions;
  if (!Array.isArray(options) || options.length === 0) return configuredWorkerLane;
  const carried = options.some((o) => o.id === requestedThinking);
  if (carried) return `${lane.provider}/${lane.model}:${requestedThinking}`;
  // The nearest supported option — the Owner's configured suffix first for the
  // medium ladder, max first for xhigh; high next; the catalog's last word last.
  const supports = (tier: string | undefined) => tier !== undefined && options.some((o) => o.id === tier);
  const resolved =
    requestedThinking === "xhigh"
      ? (supports("max") ? "max" : supports("high") ? "high" : options[options.length - 1].id)
      : (supports(lane.thinking) ? lane.thinking! : supports("high") ? "high" : options[options.length - 1].id);
  return `${lane.provider}/${lane.model}:${resolved}`;
}

/**
 * One lanes file's validated entries: absent file → no entries (never an
 * error); unparseable JSON, a non-object, a non-string lane, or an invalid
 * lane value is a named error — never a guessed default (the eye.json
 * discipline). Unknown keys are ignored (forward compatibility).
 */
function lanesEntries(path: string): { ok: true; entries: Partial<Record<LaneName, string>> } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: true, entries: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${path} must be a JSON object of the six lanes` };
  }
  const record = parsed as Partial<Record<LaneName, unknown>>;
  const entries: Partial<Record<LaneName, string>> = {};
  for (const name of LANE_NAMES) {
    const value = record[name];
    if (value === undefined) continue; // partial file: the layer below stands
    if (typeof value !== "string") {
      return { ok: false, reason: `${path}: lane ${name} must be a string` };
    }
    const error = laneError(name, value.trim());
    if (error !== undefined) return { ok: false, reason: `${path}: ${error}` };
    entries[name] = migrateLegacyZcodeLane(value.trim());
  }
  return { ok: true, entries };
}

/**
 * Loads the lane table (v0.0.14, ADR 0010 §5): the machine file
 * `<stateDir>/lanes.json` over the six defaults, then — when `projectSlug`
 * names a Project — that Project's override file layered on top. An absent
 * file at either layer contributes nothing; a broken file at either layer is
 * a named error naming the file. Without a slug this is exactly the
 * v0.0.13 machine table.
 */
export function loadLanes(stateDir: string, projectSlug?: string): LanesResult {
  const machine = lanesEntries(lanesPath(stateDir));
  if (!machine.ok) return machine;
  let lanes: Lanes = { ...defaultLanes(), ...machine.entries };
  if (projectSlug === undefined) return { ok: true, lanes };
  const project = lanesEntries(projectLanesPath(stateDir, projectSlug));
  if (!project.ok) return project;
  lanes = { ...lanes, ...project.entries };
  return { ok: true, lanes };
}

/**
 * The lanes one file itself names — the seed persistence keeps. `loadLanes`
 * fills defaults; this drops them again, so a save writes only what was ever
 * explicitly set in THAT file (the eye.json retention invariant, per layer:
 * a lane a file never named — `freshEyes` included — must stay unnamed in it
 * after an unrelated write, and a project save never materializes machine
 * lanes into the project file).
 */
function explicitLanes(path: string): Partial<Record<LaneName, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {}; // absent or unreadable — loadLanes already named the broken case
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Partial<Record<LaneName, unknown>>;
  const explicit: Partial<Record<LaneName, string>> = {};
  for (const name of LANE_NAMES) {
    const value = record[name];
    if (typeof value === "string") explicit[name] = migrateLegacyZcodeLane(value.trim());
  }
  return explicit;
}

/**
 * Merges a partial lane table over the effective table and writes only the
 * lanes the TARGET file itself names plus the update — a single-lane set
 * never materializes the defaults (the eye.json retention invariant above).
 * The target is the machine file, or — with `projectSlug` — the Project's
 * override file (v0.0.14): a project save reads the machine-merged effective
 * table but persists into the project file alone. A refused value writes
 * nothing. Returns the effective (merged over defaults) table on success.
 */
export function saveLanes(stateDir: string, update: Partial<Record<LaneName, string>>, projectSlug?: string): LanesResult {
  const current = loadLanes(stateDir, projectSlug);
  if (!current.ok) return current;
  const next = { ...current.lanes };
  const trimmed: Partial<Record<LaneName, string>> = {};
  for (const name of LANE_NAMES) {
    const value = update[name];
    if (value === undefined) continue;
    const error = laneError(name, value.trim());
    if (error !== undefined) return { ok: false, reason: error };
    trimmed[name] = migrateLegacyZcodeLane(value.trim());
  }
  const target = projectSlug === undefined ? lanesPath(stateDir) : projectLanesPath(stateDir, projectSlug);
  const persisted = explicitLanes(target);
  for (const name of LANE_NAMES) {
    const value = trimmed[name];
    if (value === undefined) continue;
    next[name] = value;
    persisted[name] = value;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(persisted, null, 2)}\n`);
  return { ok: true, lanes: next };
}

// ---- the headless tool-less runner ------------------------------------------------------

/** One provider family's exact invocation — command plus the flags that keep the pass tool-less. */
export interface LaneCliInvocation {
  command: string;
  args: string[];
}

/**
 * The OpenCode lane's tool-less permission set (v0.0.32, ADR 0019 §2),
 * injected as `OPENCODE_CONFIG_CONTENT`. Zen free models require the read
 * schema, so read asks for permission while every other tool is denied.
 * Non-interactive `--standalone` without `--auto` rejects those read asks;
 * the prompt on stdin remains the whole material.
 */
export const TOOLLESS_OPENCODE_CONFIG = JSON.stringify({
  permission: {
    "*": "deny",
    external_directory: "deny",
    doom_loop: "deny",
    question: "deny",
    edit: "deny",
    write: "deny",
    bash: "deny",
    read: { "*": "ask" },
  },
});

/**
 * Maps a lane string to its headless tool-less CLI invocation. `pi`,
 * `copilot`, `claude`, and `opencode` are the families with a verified
 * tool-less form; anything else (including `eye.json` and bare providers) has
 * none — undefined, never an improvised command with tools on.
 */
export function laneCliInvocation(lane: string): LaneCliInvocation | undefined {
  const parsed = parseLane(lane);
  if (parsed === undefined) return undefined;
  const { provider, model, thinking } = parsed;
  switch (provider) {
    case "pi":
      return {
        command: "pi",
        args: [
          "--print",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--model",
          model,
          "--thinking", thinking ?? "off",
        ],
      };
    case "copilot":
      return { command: "copilot", args: ["-s", "--model", model, "--reasoning-effort", thinking ?? "medium"] };
    case "claude":
      return {
        command: "claude",
        args: ["-p", "--model", model, "--tools", "", ...(thinking === undefined ? [] : ["--effort", thinking])],
      };
    case "opencode":
      return {
        command: "opencode",
        args: [
          "run",
          "--standalone",
          "-m",
          model.includes("/") ? model : `opencode/${model}`,
          ...(thinking === undefined ? [] : ["--variant", thinking]),
        ],
      };
    default:
      return undefined;
  }
}

/**
 * One lane CLI invocation — the seam tests fake (the real one spawns the
 * lane's command with the prompt on stdin). `command` records which family
 * ran; `cwd` is the pass's empty scratch dir; `timeoutMs` kills a hanging CLI
 * mid-flight; `env` carries the extra environment a family needs — a `pi`
 * lane's clean `PI_CODING_AGENT_DIR` (v0.0.16, ADR 0011), an `opencode`
 * lane's `TOOLLESS_OPENCODE_CONFIG` plus `CI=1` (v0.0.18) — and is undefined
 * for every other family, which inherit the parent environment unchanged.
 */
export type LaneCliRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  env?: Record<string, string> | undefined;
}) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

/**
 * The lane's whole availability surface: its CLI answers `--version` (the
 * copilot amendment-2 precedent — the CLI carries its own auth, there is no
 * key file). `contract_set`/`retro` fail-fast on a false here. Unknown lanes
 * are unavailable by construction.
 */
export function laneCliAvailable(lane: string): boolean {
  const invocation = laneCliInvocation(lane);
  if (invocation === undefined) return false;
  const probe = spawnSync(invocation.command, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return probe.status === 0;
}

/**
 * One headless tool-less lane invocation, shared by the Watch, the Retro and
 * the Fresh-eyes CLI path (the runCopilot discipline, generalized): scratch
 * cwd, prompt on stdin, SIGKILL at the deadline, stderr squashed into the
 * error. A nonzero exit names the command; a blown deadline flags
 * `budgetExceeded` so the caller spends no second try.
 *
 * A `pi/<model>` lane additionally runs inside the clean headless Pi harness
 * home (v0.0.16, ADR 0011): `PI_CODING_AGENT_DIR` is provisioned —
 * idempotently, before the scratch cwd exists — at `<stateDir>/pi-agent/headless`
 * so `pi --print` never resolves the operator's user packages or reads
 * `~/.pi/agent/APPEND_SYSTEM.md` (on top of the argv's own `--no-extensions
 * --no-skills --no-context-files` flags). An `opencode/<model>` lane runs
 * with tools fenced by permissions and headless rejection (ADR 0019 §2):
 * `OPENCODE_CONFIG_CONTENT` carries TOOLLESS_OPENCODE_CONFIG, `--auto` is
 * omitted, and `CI=1` keeps permission asks non-interactive,
 * independent of any `stateDir`. Every other lane, and a pi caller without a
 * `stateDir`, inherits the parent environment, exactly as before.
 */
export async function runLaneCli(input: {
  lane: string;
  stdin: string;
  timeoutMs: number;
  runner?: LaneCliRunner | undefined;
  /** The factory state directory naming the headless Pi harness home a `pi` lane runs under. */
  stateDir?: string | undefined;
  /** Hermetic override (tests): the operator Pi agent home shared state symlinks back to — default `<homedir>/.pi/agent`. */
  sourceAgentDir?: string | undefined;
  /** Hermetic override (tests): the home `sourceAgentDir` lives under — `<userHome>/.pi/agent`; ignored when `sourceAgentDir` is set. */
  userHome?: string | undefined;
}): Promise<{ ok: true; stdout: string } | { ok: false; error: string; budgetExceeded: boolean }> {
  const invocation = laneCliInvocation(input.lane);
  if (invocation === undefined) {
    return {
      ok: false,
      error: `lane "${input.lane}" has no headless tool-less CLI form — use pi/<model>, copilot/<model>, claude/<model>, opencode/<model>, or "eye.json" for freshEyes`,
      budgetExceeded: false,
    };
  }
  const sourceAgentDir =
    input.sourceAgentDir ?? (input.userHome !== undefined ? join(input.userHome, ".pi", "agent") : undefined);
  const provider = parseLane(input.lane)?.provider;
  const env: Record<string, string> | undefined =
    provider === "pi" && input.stateDir !== undefined
      ? { PI_CODING_AGENT_DIR: provisionPiAgentHome({ stateDir: input.stateDir, role: "headless", sourceAgentDir }) }
      : provider === "opencode"
        ? { OPENCODE_CONFIG_CONTENT: TOOLLESS_OPENCODE_CONFIG, CI: "1" }
        : undefined;
  const cwd = mkdtempSync(join(tmpdir(), "factory-lane-"));
  try {
    const run = input.runner ?? spawnLaneCli;
    const result = await run({ command: invocation.command, args: invocation.args, cwd, stdin: input.stdin, timeoutMs: input.timeoutMs, env });
    if (result.timedOut) {
      return { ok: false, error: `the ${invocation.command} CLI outlasted its deadline`, budgetExceeded: true };
    }
    if (result.code !== 0) {
      const detail = result.stderr.replace(/\s+/g, " ").trim().slice(0, 140);
      return {
        ok: false,
        error: `${invocation.command} CLI exited ${result.code ?? "signal"}${detail === "" ? "" : `: ${detail}`}`,
        budgetExceeded: false,
      };
    }
    return { ok: true, stdout: provider === "opencode" ? stripAnsiEscapes(result.stdout) : result.stdout };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Strips ANSI escape sequences (CSI `\x1b[…m` controls and OSC `\x1b]… BEL
 * title strings) from the opencode CLI's stdout — its pretty-printing must
 * never reach a downstream strict parser (the eye's CONCERN/CLEAR line, the
 * watch's five `name: number` lines). The opencode path alone: the other
 * families' output rides byte-identical.
 */
function stripAnsiEscapes(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

/** The real runner: the lane's command with its argv, prompt on stdin, killed at the deadline. */
function spawnLaneCli(input: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  env?: Record<string, string> | undefined;
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(input.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {}); // a closed stdin pipe must not sink the pass
    child.stdin.end(input.stdin);
  });
}
