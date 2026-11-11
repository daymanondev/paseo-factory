/**
 * The Lead handoff's fixed limits, in a leaf module (v0.6.0 W5, ADR 0056):
 * `lead-mailbox.ts` owns the rotation runtime and re-exports these names,
 * while `panel.ts` (reached from `view.ts`, which the mailbox itself imports)
 * reads them here so the Project panel never imports the runtime — that
 * import would close a cycle.
 */

/**
 * The fixed `Lead handoff` threshold (ADR 0013 §5): 128,000 tokens, a
 * constant — never a per-model percentage formula (spec §Out of Scope). The
 * successor rotates before context degradation sets in across any
 * `200k`–`1M` model lane.
 */
export const LEAD_ROTATE_TOKENS = 128_000;

/**
 * The Dual-Fuse `Lead handoff` extraction window (v0.0.28, ADR 0018 §3;
 * pause-aware since v0.2.2, ADR 0050 Decision 3): 180,000 ms (180 seconds)
 * per extraction send. When the window elapses, the runtime trips Fuse 2 only
 * over a genuinely dead or hung Lead (absent, `error`, or still `running`) —
 * an alive `idle`/`closed` Lead (the paused-mid-extraction shape) is re-sent
 * the fixed prompt within `HANDOFF_EXTRACTION_MAX_SENDS` instead, and the
 * window resets with each send.
 */
export const HANDOFF_EXTRACTION_TIMEOUT_MS = 180_000;

/**
 * The per-`handing_over`-episode extraction send ceiling (v0.2.2, ADR 0050
 * Decision 2): the original prompt plus at most 2 re-sends. A repeatedly
 * stopped extraction can never ping-pong forever — at the ceiling the
 * runtime completes the handoff via the degraded path instead of sending
 * again.
 */
export const HANDOFF_EXTRACTION_MAX_SENDS = 3;
