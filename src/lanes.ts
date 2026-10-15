/**
 * The unified Lane config and the headless tool-less runner (v0.0.13, ADR
 * 0009 §3). `<stateDir>/lanes.json` names the provider/model lane every
 * model-bearing role runs under — `supervisor`, `worker`, `watch`, `retro`,
 * `freshEyes` — with safe defaults (`pi/zai/glm-5.3`, $0 marginal) when the
 * file is absent or partial. The file is the one place the Owner configures
 * or switches models; an explicit `--provider` on `factory run` overrides
 * `worker`, and the plugin surface edits the same file in place.
 *
 * Every CLI lane dispatches headless AND tool-less by construction — the
 * flags below are the invariant, not a promise the model is asked to keep:
 *   pi/<model>     → `pi --print --no-session --no-tools --no-extensions
 *                     --no-skills --no-context-files --model <model>`
 *   copilot/<model>→ `copilot -s --model <model> --reasoning-effort medium`
 *   claude/<model> → `claude -p --model <model> --tools ""`
 * The prompt rides stdin (the watch's discipline since amendment 2); the
 * runner owns a scratch cwd and a SIGKILL deadline. `eye.json` is not a CLI
 * lane — it is the fresh-eyes pass's legacy direct-HTTP configuration, legal
 * for `freshEyes` alone (src/fresh-eyes.ts reads it).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The five model-bearing roles — the file's exact key set. */
export const LANE_NAMES = ["supervisor", "worker", "watch", "retro", "freshEyes"] as const;

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

/** The fresh defaults — a fresh copy every call, never a shared mutable. */
export function defaultLanes(): Lanes {
  return { supervisor: DEFAULT_LANE, worker: DEFAULT_LANE, watch: DEFAULT_LANE, retro: DEFAULT_LANE, freshEyes: DEFAULT_LANE };
}

export type LanesResult = { ok: true; lanes: Lanes } | { ok: false; reason: string };

/**
 * Validates one lane string: `provider/model` with both halves non-empty and
 * no whitespace, or `eye.json` for `freshEyes` alone. Returns the error text,
 * or undefined when the value is usable.
 */
export function laneError(name: LaneName, value: string): string | undefined {
  if (name === "freshEyes" && value === EYE_JSON_LANE) return undefined;
  const slash = value.indexOf("/");
  if (slash === -1) {
    return `lane ${name}="${value}" is not provider/model — name the model explicitly (never auto), or "eye.json" for freshEyes`;
  }
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (provider.trim() === "" || model.trim() === "" || /\s/.test(value)) {
    return `lane ${name}="${value}" must be provider/model with both halves non-empty and no whitespace`;
  }
  return undefined;
}

/**
 * Loads the lane table: absent file → the five defaults; partial file →
 * defaults fill the missing lanes; unknown keys are ignored (forward
 * compatibility). Unparseable JSON or an invalid lane value is a named error
 * — never a guessed default (the eye.json discipline).
 */
export function loadLanes(stateDir: string): LanesResult {
  const path = lanesPath(stateDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: true, lanes: defaultLanes() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${path} must be a JSON object of the five lanes` };
  }
  const lanes = defaultLanes();
  const record = parsed as Partial<Record<LaneName, unknown>>;
  for (const name of LANE_NAMES) {
    const value = record[name];
    if (value === undefined) continue; // partial file: the default stands
    if (typeof value !== "string") {
      return { ok: false, reason: `${path}: lane ${name} must be a string` };
    }
    const error = laneError(name, value.trim());
    if (error !== undefined) return { ok: false, reason: `${path}: ${error}` };
    lanes[name] = value.trim();
  }
  return { ok: true, lanes };
}

/**
 * Merges a partial lane table over the current one and writes the file whole
 * — exactly the five lanes, pretty-printed with a trailing newline. A refused
 * value writes nothing. Returns the reloaded table on success.
 */
export function saveLanes(stateDir: string, update: Partial<Record<LaneName, string>>): LanesResult {
  const current = loadLanes(stateDir);
  if (!current.ok) return current;
  const next = { ...current.lanes };
  for (const name of LANE_NAMES) {
    const value = update[name];
    if (value === undefined) continue;
    const error = laneError(name, value.trim());
    if (error !== undefined) return { ok: false, reason: error };
    next[name] = value.trim();
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(lanesPath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, lanes: next };
}

// ---- the headless tool-less runner ------------------------------------------------------

/** One provider family's exact invocation — command plus the flags that keep the pass tool-less. */
export interface LaneCliInvocation {
  command: string;
  args: string[];
}

/**
 * Maps a lane string to its headless tool-less CLI invocation. `pi`, `copilot`
 * and `claude` are the three families with a verified tool-less form; anything
 * else (including `eye.json` and bare providers) has none — undefined, never
 * an improvised command with tools on.
 */
export function laneCliInvocation(lane: string): LaneCliInvocation | undefined {
  const slash = lane.indexOf("/");
  if (slash === -1) return undefined;
  const provider = lane.slice(0, slash);
  const model = lane.slice(slash + 1);
  if (provider === "" || model === "") return undefined;
  switch (provider) {
    case "pi":
      return {
        command: "pi",
        args: ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--model", model],
      };
    case "copilot":
      return { command: "copilot", args: ["-s", "--model", model, "--reasoning-effort", "medium"] };
    case "claude":
      return { command: "claude", args: ["-p", "--model", model, "--tools", ""] };
    default:
      return undefined;
  }
}

/**
 * One lane CLI invocation — the seam tests fake (the real one spawns the
 * lane's command with the prompt on stdin). `command` records which family
 * ran; `cwd` is the pass's empty scratch dir; `timeoutMs` kills a hanging CLI
 * mid-flight.
 */
export type LaneCliRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
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
 */
export async function runLaneCli(input: {
  lane: string;
  stdin: string;
  timeoutMs: number;
  runner: LaneCliRunner | undefined;
}): Promise<{ ok: true; stdout: string } | { ok: false; error: string; budgetExceeded: boolean }> {
  const invocation = laneCliInvocation(input.lane);
  if (invocation === undefined) {
    return {
      ok: false,
      error: `lane "${input.lane}" has no headless tool-less CLI form — use pi/<model>, copilot/<model>, claude/<model>, or "eye.json" for freshEyes`,
      budgetExceeded: false,
    };
  }
  const cwd = mkdtempSync(join(tmpdir(), "factory-lane-"));
  try {
    const run = input.runner ?? spawnLaneCli;
    const result = await run({ command: invocation.command, args: invocation.args, cwd, stdin: input.stdin, timeoutMs: input.timeoutMs });
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
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"] });
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
