/**
 * The seat handoff's limits, in a leaf module (v0.6.0 W5, ADR 0056):
 * `lead-mailbox.ts` owns the rotation runtime and re-exports these names,
 * while `panel.ts` (reached from `view.ts`, which the mailbox itself imports)
 * reads them here so the Project panel never imports the runtime — that
 * import would close a cycle.
 */

/**
 * The unknown-window caps (ADR 0057 §7). Raised in v0.8.2 at the Owner's
 * request: Supervisor and Lead 128k → 160k, Peer 160k → 200k. A model whose
 * window is known still hands off at 65% (Supervisor/Lead) / 80% (Peer) of it
 * when that is lower, so the extraction turn always has room.
 */
export const LEAD_ROTATE_TOKENS = 160_000;
export const PEER_CONTEXT_MARK_TOKENS = 200_000;

/** One mark for both the runtime trigger and the Owner's context bar. */
export function handoffMarkTokens(role: "supervisor" | "lead" | "peer", maxTokens?: number | null): number {
  const cap = role === "peer" ? PEER_CONTEXT_MARK_TOKENS : LEAD_ROTATE_TOKENS;
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) return cap;
  return Math.min(cap, Math.floor(maxTokens * (role === "peer" ? 0.8 : 0.65)));
}

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
