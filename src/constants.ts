/** Shared tuning knobs for the core. */

/** Inclusive Contract Gate timeout bounds in seconds (ADR 0068). */
export const MIN_CONTRACT_TIMEOUT_SECONDS = 60;
export const MAX_CONTRACT_TIMEOUT_SECONDS = 3600;
export const DEFAULT_CONTRACT_TIMEOUT_SECONDS = 900;

/** Default gate timeout: kill the process group and record red after this long. */
export const DEFAULT_GATE_TIMEOUT_MS = DEFAULT_CONTRACT_TIMEOUT_SECONDS * 1000;

/** Validates an optional per-Contract Gate timeout (`60..3600` safe integer seconds). */
export function isValidContractTimeoutSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_CONTRACT_TIMEOUT_SECONDS && value <= MAX_CONTRACT_TIMEOUT_SECONDS;
}

/** Resolves a Contract's configured `timeoutSeconds` or the 900s default. */
export function contractTimeoutSeconds(contract?: { timeoutSeconds?: number }): number {
  return contract?.timeoutSeconds ?? DEFAULT_CONTRACT_TIMEOUT_SECONDS;
}

/** Resolves a Contract's Gate timeout in milliseconds (defaulting to 900_000ms). */
export function contractTimeoutMs(contract?: { timeoutSeconds?: number }): number {
  return contractTimeoutSeconds(contract) * 1000;
}

/**
 * Keep at most this many bytes of the gate's combined stdout+stderr, measured
 * from the end. Anti-spew, not anti-completeness — this repo's real suite is a
 * few KB. The full kept output is persisted per attempt (ticket 02a).
 */
export const GATE_OUTPUT_CAP_BYTES = 2 * 1024 * 1024;

/** The ledger's single-line `note` field is capped to this many characters. */
export const REPORT_NOTE_MAX_CHARS = 200;

/** The fresh-eyes pass: one total budget covering the first try and its retry (tickets 03/04). */
export const EYE_TOTAL_BUDGET_MS = 60_000;

/** Input-bundle caps (ticket 03 §4): the diff tail and gate-output tail the eye reads. */
export const EYE_DIFF_MAX_CHARS = 100_000;
export const EYE_GATE_OUTPUT_MAX_CHARS = 50_000;

/** Generation cap for the eye's one answer — the finding is ≤ ~120 words plus reasoning tokens. */
export const EYE_MAX_TOKENS = 1024;

/**
 * The watch (v0.0.6, ticket 03 + amendment 2): one total budget covering the
 * first try and its single transient retry — the eye's discipline, one clock
 * for the whole pass.
 */
export const WATCH_TOTAL_BUDGET_MS = 60_000;

/**
 * The watch state's tail caps (ticket 03 §3), `[truncated]`-marked like the
 * eye's: timeline 64k, diff 16k, gate output 8k. Every measured real task's
 * timeline (40–60 KB) fits under the timeline cap untrimmed.
 */
export const WATCH_TIMELINE_MAX_CHARS = 64_000;
export const WATCH_DIFF_MAX_CHARS = 16_000;
export const WATCH_GATE_OUTPUT_MAX_CHARS = 8_000;

/**
 * The Watch callout & soft-block threshold (ticket 03 §7, amended by ADR 0074):
 * `accept` soft-blocks when a completed `watch_written` (`outcome === "written"`)
 * reports `>= 0.5` on `WATCH_SOFT_BLOCK_QUESTIONS` unless `acknowledgeWatch`
 * is provided (`>= WATCH_ACK_MIN_CHARS` non-whitespace chars).
 */
export const WATCH_CALLOUT_THRESHOLD = 0.5;

/** Watch questions whose `>= WATCH_CALLOUT_THRESHOLD` score soft-blocks acceptance (ADR 0074). */
export const WATCH_SOFT_BLOCK_QUESTIONS = ["test-weakened", "secret-leak"] as const;

/** Minimum non-whitespace character count required for `acknowledgeWatch` / `watchAck` (ADR 0074). */
export const WATCH_ACK_MIN_CHARS = 10;

/** Validates a Watch soft-block acknowledgement reason (`>= 10` non-whitespace chars). */
export function isValidWatchAck(value: unknown): value is string {
  return typeof value === "string" && value.replace(/\s+/g, "").length >= WATCH_ACK_MIN_CHARS;
}
