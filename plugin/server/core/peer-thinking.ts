/**
 * The per-dispatch reasoning-effort tiers (v0.5.0, ADR 0054 §4) — the five
 * `thinking` levels a Lead may request per dispatch (`lead_dispatch_agent`,
 * the Spool `spawn` request, `factory run --thinking`).
 *
 * Placement: a leaf module with ZERO local imports, on purpose. The tiers sit
 * at the seam of three import layers — `src/lanes.ts` (provider-adaptive
 * resolution), `src/events.ts` (the `SpawnDispatched` record), and
 * `src/ledger-validation.ts` (event validation) — and the ledger validator
 * loads through `src/history-import.ts` inside `src/roles-contract.ts`'s
 * import graph. Importing the tiers from `src/lanes.ts` (which provisions Pi
 * homes through `./pi-home.ts`, whose top-level `ROLE_PROMPTS` renders the
 * role contracts) closed a circular import whose evaluation reached
 * `renderRoleContract` before `roles-contract.ts`'s top-level consts
 * initialized (`SUPERVISOR_OUTCOME_BOUNDARY` TDZ). Keeping the canonical list
 * here leaves every consumer acyclic; `src/lanes.ts` re-exports both so the
 * public seam (spec Implementation Decision 4) stays `lanes.ts`.
 */

/** The five reasoning-effort tiers a Lead may request per dispatch (`low` … `max`). */
export const PEER_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type PeerThinkingLevel = (typeof PEER_THINKING_LEVELS)[number];
