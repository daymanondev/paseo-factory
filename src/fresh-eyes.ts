/**
 * The fresh-eyes station (v0.0.2, tickets 02–04, ADR 0005): after a green
 * Verdict, a different model — reached with no harness and no tools — reads
 * the Contract, the diff and the full gate output, and appends exactly one
 * advisory line to the ledger. It cannot act by construction (a plain
 * `fetch` or a tool-less CLI — the flags are the invariant), it never
 * touches the Verdict or the accept flow, and it is off unless the Contract
 * marks it on.
 *
 * Since v0.0.13 (ADR 0009 §3) the pass's model is the `freshEyes` lane from
 * `<stateDir>/lanes.json`: any headless tool-less CLI lane
 * (`pi/…`, `copilot/…`, `claude/…`, default `pi/zai/glm-5.3`) or the legacy
 * `"eye.json"` direct model API. An eye.json that already exists keeps
 * answering when lanes.json never named a freshEyes lane — the upgrade never
 * silently retires a configured eye — but an explicit lane always wins.
 *
 * The eye.json config lives in `<stateDir>/eye.json` (mode 600, copied —
 * never a reference into another tool's files) and is re-read on every pass,
 * so key or model rotation needs no restart. The key never appears in a
 * Contract, ledger line, or report; the errors below carry status codes and
 * paths only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EYE_DIFF_MAX_CHARS, EYE_GATE_OUTPUT_MAX_CHARS, EYE_MAX_TOKENS, EYE_TOTAL_BUDGET_MS } from "./constants.ts";
import { EYE_JSON_LANE, laneCliAvailable, lanesPath, loadLanes, runLaneCli } from "./lanes.ts";
import type { LaneCliRunner } from "./lanes.ts";
import { diffBetween } from "./workspace.ts";
import type { ContractSet } from "./events.ts";

/** The eye's own config file, `<stateDir>/eye.json` (ticket 04). */
export interface EyeConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export type EyeConfigResult =
  | { ok: true; config: EyeConfig }
  | { ok: false; reason: string };

/** Where the eye's config lives — `<stateDir>/eye.json`. */
export function eyeConfigPath(stateDir: string): string {
  return join(stateDir, "eye.json");
}

/**
 * Loads and validates the eye config. Missing file, bad JSON, or a missing
 * field all return a reason; the caller decides what that means (contract_set
 * refuses loudly, a running pass records a `failed` line).
 */
export function loadEyeConfig(stateDir: string): EyeConfigResult {
  const path = eyeConfigPath(stateDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: `${path} is missing — create it as {"provider","model","apiKey","baseUrl"} (mode 600)` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  const fields = parsed as Partial<Record<keyof EyeConfig, unknown>>;
  for (const field of ["provider", "model", "apiKey", "baseUrl"] as const) {
    const value = fields[field];
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, reason: `${path} has no usable "${field}" string` };
    }
  }
  return {
    ok: true,
    config: {
      provider: (fields.provider as string).trim(),
      model: (fields.model as string).trim(),
      apiKey: (fields.apiKey as string).trim(),
      baseUrl: (fields.baseUrl as string).trim(),
    },
  };
}

/** What one pass measured, in the shape of the `fresh_eyes_written` payload. */
export interface FreshEyesOutcome {
  model: string;
  outcome: "concern" | "clear" | "failed";
  finding: string;
  durationMs: number;
}

export type EyeLaneResolution = { ok: true; lane: string } | { ok: false; reason: string };

/**
 * Which lane the eye runs under (v0.0.13, ADR 0009 §3): an explicit
 * `freshEyes` in lanes.json wins — `"eye.json"` (the legacy direct-API
 * config) or any CLI lane; when lanes.json never named one, an existing
 * eye.json keeps answering (the upgrade never silently retires a configured
 * eye); otherwise the default CLI lane. A broken lanes.json is a named
 * refusal, never a guessed lane.
 */
export function resolveEyeLane(stateDir: string): EyeLaneResolution {
  const lanes = loadLanes(stateDir);
  if (!lanes.ok) return lanes;
  let explicit = false;
  try {
    const parsed = JSON.parse(readFileSync(lanesPath(stateDir), "utf8")) as { freshEyes?: unknown };
    explicit = typeof parsed.freshEyes === "string";
  } catch {
    // absent or unreadable — loadLanes already turned the broken case into a refusal
  }
  if (explicit) return { ok: true, lane: lanes.lanes.freshEyes };
  return { ok: true, lane: existsSync(eyeConfigPath(stateDir)) ? EYE_JSON_LANE : lanes.lanes.freshEyes };
}

export interface FreshEyesPassInput {
  stateDir: string;
  contract: ContractSet;
  /** The commit the green Verdict attests. */
  claimedSha: string;
  /** The persisted full gate output (`gate_finished.outputPath`). */
  gateOutputPath: string | undefined;
  /** Total budget override for both tries together (tests); default EYE_TOTAL_BUDGET_MS. */
  budgetMs?: number;
  /** Lane CLI runner override for a CLI lane (tests) — the lane's tool-less flags stay fixed regardless. */
  cliRunner?: LaneCliRunner;
}

/** One transient retry on a CLI lane — the watch's discipline; the budget covers both tries. */
const MAX_ATTEMPTS = 2;

/**
 * One fresh-eyes pass: resolve the lane, build the input bundle, ask within
 * the budget, parse the answer. Never throws — every death is a returned
 * `failed` outcome so the ledger line stays visible (law 5). The `"eye.json"`
 * lane keeps the v0.0.2 direct-API machinery whole; a CLI lane rides the
 * shared headless tool-less runner with the same prompt and the same
 * CONCERN/CLEAR output contract.
 */
export async function runFreshEyesPass(input: FreshEyesPassInput): Promise<FreshEyesOutcome> {
  const started = Date.now();
  const failed = (finding: string, model = "unconfigured"): FreshEyesOutcome => ({
    model,
    outcome: "failed",
    finding,
    durationMs: Date.now() - started,
  });

  const resolution = resolveEyeLane(input.stateDir);
  if (!resolution.ok) return failed(`eye lane unusable: ${resolution.reason}`);
  const lane = resolution.lane;

  if (lane === EYE_JSON_LANE) {
    // The legacy direct-API path, machinery whole: config first (the v0.0.2
    // order), then the prompt, then one POST within the budget.
    const config = loadEyeConfig(input.stateDir);
    if (!config.ok) return failed(`eye not configured: ${config.reason}`);
    const prompt = await buildEyePrompt(input);
    if (!prompt.ok) return failed(prompt.reason, config.config.model);
    const answer = await callEyeApi(config.config, prompt.prompt, input.budgetMs ?? EYE_TOTAL_BUDGET_MS);
    if (!answer.ok) return failed(answer.error, config.config.model);
    const parsed = parseEyeAnswer(answer.text);
    return {
      model: config.config.model,
      outcome: parsed.outcome,
      finding: parsed.finding,
      durationMs: Date.now() - started,
    };
  }

  // A CLI lane: headless, tool-less, prompt on stdin — the same output
  // contract the HTTP path enforces.
  const prompt = await buildEyePrompt(input);
  if (!prompt.ok) return failed(prompt.reason, lane);
  const budgetMs = input.budgetMs ?? EYE_TOTAL_BUDGET_MS;
  let lastError = "the lane CLI never ran";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) return failed(`eye budget of ${budgetMs}ms exceeded`, lane);
    const result = await runLaneCli({ lane, stdin: prompt.prompt, timeoutMs: remaining, runner: input.cliRunner });
    if (result.ok) {
      const parsed = parseEyeAnswer(result.stdout);
      return {
        model: lane,
        outcome: parsed.outcome,
        finding: parsed.finding,
        durationMs: Date.now() - started,
      };
    }
    if (result.budgetExceeded) return failed(`eye budget of ${budgetMs}ms exceeded`, lane); // the clock is spent — no second try
    lastError = result.error;
  }
  return failed(lastError, lane);
}

/**
 * The eye's input bundle (ticket 03 §4): Contract, then the diff `base..claimed`
 * (tail EYE_DIFF_MAX_CHARS), then the full gate output (tail
 * EYE_GATE_OUTPUT_MAX_CHARS). Every truncation leaves a `[truncated]` marker
 * and the prompt tells the eye its input may be cut.
 */
async function buildEyePrompt(input: FreshEyesPassInput): Promise<{ ok: true; prompt: string } | { ok: false; reason: string }> {
  const { contract } = input;
  if (contract.base === undefined) {
    return { ok: false, reason: "no base commit recorded on the Contract — the diff range is unavailable" };
  }
  const diff = await diffBetween(contract.workspace, contract.base, input.claimedSha);
  if (!diff.ok) {
    return { ok: false, reason: `diff ${contract.base.slice(0, 7)}..${input.claimedSha.slice(0, 7)} unavailable: ${diff.reason}` };
  }
  let gateOutput = "";
  if (input.gateOutputPath !== undefined) {
    try {
      gateOutput = readFileSync(input.gateOutputPath, "utf8");
    } catch {
      // Never show an empty section the eye could read as "the gate was
      // silent" — missing information is stated, not implied (ticket 03 §4).
      gateOutput = "[gate output unavailable]";
    }
  }

  const prompt = [
    "You are the fresh-eyes reviewer for a coding task you took no part in.",
    "A mechanical gate has already judged this attempt green; your job is to read what the gate cannot: the change itself.",
    "",
    "You read, you never act. You cannot run anything, and you must not propose weakening or editing tests to make them pass. If you suggest a patch, it is text only.",
    "",
    "## The contract (the task's done-criteria, fixed before the work started)",
    `- Task: ${contract.task}`,
    `- Gate command: \`${contract.gate}\``,
    `- Required artifact: ${contract.artifact}`,
    `- Scope (the only paths the task may touch): ${contract.scope === undefined || contract.scope.length === 0 ? "unrestricted" : contract.scope.join(", ")}`,
    "",
    "## The diff (base..claimed)",
    tailWithMarker(diff.diff, EYE_DIFF_MAX_CHARS),
    "",
    "## The gate's full output",
    tailWithMarker(gateOutput, EYE_GATE_OUTPUT_MAX_CHARS),
    "",
    "Your input may have been truncated — a line reading [truncated] marks a cut. When a judgment would need information that is missing, say exactly that; never guess.",
    "",
    "Answer with this exact shape:",
    "- First line: CONCERN (something deserves the Owner's attention) or CLEAR (nothing to add).",
    `- Then at most 120 words when raising a concern — cite file and line from the diff (path:line). When CLEAR, at most one sentence or nothing at all. Report only what the gate could not check: logic the tests miss, a change that breaks the contract's intent, work outside the declared scope, tests weakened to pass. Style nits and speculation are noise.`,
  ].join("\n");
  return { ok: true, prompt };
}

/** Keeps the tail, marks the cut — a reader must always know a cut happened. */
export function tailWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[truncated]\n${text.slice(-maxChars)}`;
}

/**
 * Calls the eye's API: one Anthropic-messages POST (`POST {baseUrl}/v1/messages`,
 * `x-api-key`) per ticket 01's live-verified gateway shape. The budget covers
 * the first try and its single retry together (one AbortController); a retry
 * happens only on transient failures — network errors, 429, 5xx — never on
 * 400/401/403, where retrying just burns the same refusal twice.
 */
async function callEyeApi(
  config: EyeConfig,
  prompt: string,
  budgetMs: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), budgetMs);
  const body = JSON.stringify({
    model: config.model,
    max_tokens: EYE_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
  try {
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) return { ok: false, error: `eye budget of ${budgetMs}ms exceeded` };
        if (attempt === 1) continue; // one retry on a network error
        return { ok: false, error: `eye API unreachable: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 1) continue; // transient — exactly one retry
        return { ok: false, error: `eye API answered ${response.status} twice` };
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return { ok: false, error: `eye API answered ${response.status}${detail === "" ? "" : `: ${detail.replace(/\s+/g, " ").trim().slice(0, 140)}`}` };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, error: "eye API returned a non-JSON body" };
      }
      const text = extractMessageText(payload);
      if (text === undefined) return { ok: false, error: "eye API returned no text content" };
      return { ok: true, text };
    }
  } finally {
    clearTimeout(deadline);
  }
}

/** Anthropic-messages response shape: `{content: [{type: "text", text}, …]}`. */
function extractMessageText(payload: unknown): string | undefined {
  const content = (payload as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text);
  if (texts.length === 0) return undefined;
  return texts.join("\n");
}

/** The eye's answer discipline: first line CONCERN or CLEAR, findings ≤ 120 words. */
const FINDING_MAX_WORDS = 120;

export type ParsedEyeAnswer =
  | { outcome: "concern" | "clear"; finding: string }
  | { outcome: "failed"; finding: string };

/**
 * Enforces the eye's hard output contract. The verdict word is matched
 * leniently (markdown and trailing punctuation stripped) but it must be the
 * first line; anything else is a failed pass, never a guessed verdict.
 */
export function parseEyeAnswer(text: string): ParsedEyeAnswer {
  const lines = text.trim().split("\n");
  const first = (lines[0] ?? "").replace(/[*_`#]+/g, "").trim().replace(/[.!]+$/, "").toUpperCase();
  const finding = capWords(lines.slice(1).join(" ").replace(/\s+/g, " ").trim());
  if (first === "CONCERN") return { outcome: "concern", finding };
  if (first === "CLEAR") return { outcome: "clear", finding };
  return {
    outcome: "failed",
    finding: `eye did not follow the output contract (first line was not CONCERN or CLEAR): ${(lines[0] ?? "").slice(0, 120)}`,
  };
}

function capWords(finding: string): string {
  const words = finding.split(" ").filter((w) => w !== "");
  if (words.length <= FINDING_MAX_WORDS) return finding;
  return `${words.slice(0, FINDING_MAX_WORDS).join(" ")} …`;
}
