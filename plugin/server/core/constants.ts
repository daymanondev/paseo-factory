/** Shared tuning knobs for the core. v0.0.2 values — revisit after the 0.0.2 live run. */

/** Default gate timeout: kill the process group and record red after this long. */
export const DEFAULT_GATE_TIMEOUT_MS = 5 * 60_000;

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
 * The report's ≥0.5 callout (ticket 03 §7) — display-only, one shared
 * constant; nothing in the factory branches on it (record-only law). The
 * pre-registered battery threshold is this same 0.5, applied to the recorded
 * probabilities at close-out.
 */
export const WATCH_CALLOUT_THRESHOLD = 0.5;
