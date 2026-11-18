# 0062 — Same-Base Sibling Model Resolution for Per-Dispatch Thinking Effort

- **Date:** 2026-11-18
- **Status:** Accepted — ratified by the Owner via `/grill-with-docs` (Rounds 1–2).
- **Grounded in:** `src/lanes.ts` (`resolvePeerThinkingLane`), `src/peer-thinking.ts`, `plugin/server/spool.ts` (`resolvePeerDispatchLane`, `providerCatalogForLane`), `plugin/server/peer-handoff.ts`, and `agy models` live catalog output (`gemini-4-hydrogen-{low,medium,high,xhigh}`, `gemini-4-argon-{low,medium,high}`, `gemini-4-carbon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}`, `gpt-oss-120b-medium`, `gemini-pro-orchestrator`).
- **Amends:** [ADR 0054 §4](0054-canonical-slp-contract-gate-effort-and-task-retirement.md#L38-L46) (replaces the blanket ignore on `thinkingOptions: []` models with same-base sibling model resolution when sibling effort models exist in the provider catalog).

## Context

Under [ADR 0054 §4](0054-canonical-slp-contract-gate-effort-and-task-retirement.md), `Lead` chooses per-dispatch Peer reasoning effort (`low | medium | high | xhigh | max` with `thinkingReason`) via `lead_dispatch_agent`, and `resolvePeerThinkingLane` adapts it against the daemon's `providers.listModels` catalog. Models that expose `thinkingOptions` (`pi`, `claude`, `codex`, `copilot`) receive a `:<tier>` suffix (`thinkingOptionId`), whereas models with `thinkingOptions: []` were treated as fixed-effort and silently ignored `thinking`.

In practice, both the built-in `antigravity` provider and custom `agy` ACP (`paseo-agy-acp`) do not expose `thinkingOptions` on a single base model; instead, their catalog splits each reasoning tier into distinct sibling model IDs (`gemini-4-hydrogen-low`, `gemini-4-hydrogen-medium`, `gemini-4-hydrogen-high`, `gemini-4-hydrogen-xhigh`, etc.). As a result, when a Project's `worker` lane used `antigravity/gemini-4-hydrogen-high`, every `Lead` dispatch regardless of `thinking` (`low` vs `xhigh`) still launched `gemini-4-hydrogen-high`. Furthermore, automatic `160k`/`context-mark` `Peer handoff` in `plugin/server/peer-handoff.ts` resolved only `state.ownerLane ?? "worker"`, dropping the epoch's `spawn_dispatched.thinking` on successor creation.

## Decision

1. **Same-base sibling model resolution in `resolvePeerThinkingLane` (`src/lanes.ts`):**
   - When `meta.thinkingOptions` is empty (`[]` or absent), check whether the stripped model ID ends in `-(low|medium|high|xhigh|max)$` with a non-empty `<base>` and whether the provider's `models` list from `daemon.providers.listModels` contains **at least two** fixed-effort siblings sharing `<base>-<tier>`.
   - Activation is **catalog-driven** (no hardcoded `antigravity`/`agy` allowlist): single-variant models (`gpt-oss-120b-medium`), non-suffixed models (`gemini-pro-orchestrator`), unknown models, and unreachable catalogs fall back cleanly to the configured `worker` lane verbatim.
   - Switching is strictly **same-base only** — never crossing model families (e.g., `gemini-4-hydrogen-*` never falls back to `gemini-3.8-flash-*` or `gemini-4-argon-*`).
   - Return `<provider>/<resolvedSiblingModel>` without a `:thinking` suffix so `createTaskPeer` sends `{ provider: "<provider>/<resolvedSiblingModel>" }` without `thinkingOptionId`.

2. **Directional nearest-tier sibling ladder:**
   - When `<base>` omits the exact requested tier (for example `max` on `gemini-4-hydrogen-*` which tops out at `xhigh`, or `xhigh`/`max` on `gemini-4-argon-*` which tops out at `high`), resolve in order:
     - `max` → `max → xhigh → high → configuredTier → medium → low`
     - `xhigh` → `xhigh → max → high → configuredTier → medium → low`
     - `high` → `high → xhigh → medium → configuredTier → max → low`
     - `medium` → `medium → configuredTier → high → low → xhigh → max`
     - `low` → `low → medium → configuredTier → high → xhigh → max`

3. **Peer per-dispatch scope & auto-handoff continuity (`plugin/server/spool.ts`, `plugin/server/peer-handoff.ts`):**
   - Resolution applies strictly to per-dispatch `Peer` launches (`lead_dispatch_agent`, `factory spawn`, `factory run --thinking`) and automatic `Peer handoff` succession (`context-mark` or Owner handoff without an explicit `lane` override), leaving `Supervisor` and `Lead` lanes untouched.
   - Extract `resolvePeerDispatchLane` in `plugin/server/spool.ts` and reuse it in `plugin/server/peer-handoff.ts`: when `state.ownerLane` is unset, successor creation inherits the latest `spawn_dispatched.thinking` for that Task from the Project's ledger history. Explicit Owner handoff `lane` overrides remain authoritative.

## Considered Options

- **Virtual `thinkingOptions` in `paseo-agy-acp` / Paseo `antigravity` adapter:** Rejected because it requires modifying both upstream Paseo core (`antigravity` plugin) and `paseo-agy-acp`, and would break existing `lanes.json` / `profiles.json` model IDs that already carry tier suffixes (`antigravity/gemini-4-hydrogen-high`).
- **Cross-family fallback (e.g., `low` switching from `hydrogen` to `flash`):** Rejected because `Lead` tuning reasoning effort must not silently alter the Owner's chosen model class or capability profile.

## Consequences

- `Lead` can tune Peer reasoning effort (`low | medium | high | xhigh | max`) on `antigravity/*` and `agy/*` worker lanes without changing `lanes.json`, `profiles.json`, or upstream ACP adapters.
- Automatic `Peer handoff` successors preserve the Task's dispatched `thinking` tier across both `thinkingOptions`-based providers (`pi`, `claude`, `codex`) and sibling-model providers (`antigravity`, `agy`).
- Existing `resolvePeerThinkingLane` callers with single-model catalogs (`thinkingOptions: []` and `< 2` siblings) retain the ADR 0054 fail-safe behavior verbatim.
