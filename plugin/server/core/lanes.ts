/**
 * The unified Lane config and the headless tool-less runner (v0.0.13, ADR
 * 0009 §3; the `lead` lane and per-Project overrides arrive in v0.0.14, ADR
 * 0010 §2/§5). `<stateDir>/lanes.json` names the provider/model lane every
 * model-bearing role runs under — `supervisor`, `lead`, `worker`, `watch`,
 * `retro`, `freshEyes` — with safe defaults (`pi/zai/glm-5.3`, $0 marginal)
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
 *   opencode/<model> → `opencode run --standalone --auto -m opencode/<model>`
 *                     (tools denied a second way: the runner injects
 *                     TOOLLESS_OPENCODE_CONFIG, v0.0.18)
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

/** The six model-bearing roles — the file's exact key set (5 UI cards; supervisor and lead pair under Seats). */
export const LANE_NAMES = ["supervisor", "lead", "worker", "watch", "retro", "freshEyes"] as const;

export type LaneName = (typeof LANE_NAMES)[number];

/** One lane table — every role present, every value a validated lane string. */
export type Lanes = Record<LaneName, string>;

/** The safe default everywhere: the $0 marginal lane, no key, no quota. */
export const DEFAULT_LANE = "pi/zai/glm-5.3";

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
  if (colon === -1) return { provider, model: rest };
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
    entries[name] = value.trim();
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
    if (typeof value === "string") explicit[name] = value.trim();
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
    trimmed[name] = value.trim();
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
 * The opencode lane's tool-less permission set (v0.0.18, spec
 * §Implementation Decisions 3), injected as `OPENCODE_CONFIG_CONTENT` so
 * every tool is denied by construction — the second line of defense beside
 * the argv's own `--standalone --auto`. `read` denies even file reads: the
 * prompt on stdin is the whole material, exactly like the other families.
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
    read: { "*": "deny" },
  },
});

/**
 * Maps a lane string to its headless tool-less CLI invocation. `pi`,
 * `copilot`, `claude` and `opencode` are the four families with a verified
 * tool-less form; anything else (including `eye.json` and bare providers)
 * has none — undefined, never an improvised command with tools on.
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
          ...(thinking === undefined ? [] : ["--thinking", thinking]),
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
        args: ["run", "--standalone", "--auto", "-m", `opencode/${model}`, ...(thinking === undefined ? [] : ["--variant", thinking])],
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
 * with every tool denied a second way (v0.0.18): `OPENCODE_CONFIG_CONTENT`
 * carries TOOLLESS_OPENCODE_CONFIG and `CI=1` keeps the CLI non-interactive,
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
  const env =
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
    return { ok: true, stdout: result.stdout };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
