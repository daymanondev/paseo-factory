# 0030 — Retire Synchronous `Fresh-eyes review` in Favor of `Lead`-Owned Diff Review and Hardened Claim/Diff Seams

- **Date:** 2026-10-26
- **Status:** Accepted
- **Amends:** ADR 0005 (`Fresh-eyes review`), ADR 0010 §3 (Lead acceptance rules), ADR 0018 §4 (Smart-default `freshEyes` on `Lead` contracts), ADR 0029 (Closure & Integration Loop)

## Context

In the live `profile-max` multi-wave run (`2026-10-26`), `Lead` (`pi/openai-codex/gpt-6.1-sol:high`) decomposed a greenfield browser game directive into seven sequential waves (`T-01-foundation` through `T-07-verification`). `Peer` (`T-01-foundation`, `pi/zai/glm-5.3:max`) implemented the foundation wave, passed the mechanical `Gate` (`npm test && npm run build`) in `5.2s` at commit `be85aba`, and called `agent_claim`. However, the entire 7-wave roadmap deadlocked at `T-01-foundation` due to four compounding faults around the synchronous `Fresh-eyes review` pass:

1. **Architectural Redundancy with the Standing `Lead` Seat (`paseo-room` & `codex-room` Alignment):**
   - `Fresh-eyes review` was introduced in `v0.0.2` (ADR 0005) when `paseo-factory` had no model-backed `Lead` seat (`Owner → Worker + mechanical Gate`). Once `Lead` became a standing model-backed seat in `v0.0.14` (ADR 0010) and was mandated to inspect `git show --stat "<sha>"` and `git diff "<sha>^" "<sha>"` on every wave before calling `lead_accept_task` in `v0.0.41` (ADR 0029), `Peer` (writes + runs mechanical `Gate`) and `Lead` (reads the full commit diff in the repository with high reasoning and accepts or re-contracts) already establish the canonical two-party separation of judgment used by `paseo-room` and `codex-room` / `seatworks` (`LEAD.md`: *"Reviewer độc lập — mặc định là KHÔNG: Bạn + Peer đã là separation of judgment"*).
   - Smart-defaulting `freshEyes: true` on every `Lead` contract (ADR 0018 §4) and blocking `lead_accept_task` on `reviewState === "clear"` (ADR 0010 §3) forced a weaker, cold-started headless model (`glm-5.3-flash`) reading a truncated static diff to gatekeep a stronger, context-rich `Lead` (`gpt-6.1-sol:high`) that had already verified the real diff on disk.
   - Running a headless scan with `thinking: off` degrades review depth to superficial token generation, while running it out-of-band with `thinking: high` races against `Lead`'s immediate wave acceptance and next-wave dispatch.

2. **Headless `pi/<model>` Inherited `"defaultThinkingLevel": "high"`:**
   - `writeSettingsJson` in `src/pi-home.ts` copies `"defaultThinkingLevel": "high"` from `~/.pi/agent/settings.json` into `<stateDir>/pi-agent/headless/settings.json`. When a headless lane (`pi/zai/glm-5.3-flash`) omits an explicit `:thinking` suffix, `laneCliInvocation` did not pass `--thinking off`, causing the headless pass to spend >60s generating internal reasoning tokens and hit its `60,000ms` timeout.

3. **Lockfile Bloat & Head-Truncated Diffs in `diffBetween`:**
   - `diffBetween(workspace, base, claimed)` ran raw `git diff <base> <claimed>` without excluding `PACKAGE_LOCKFILES` (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `bun.lock`, `npm-shrinkwrap.json`) or prepending `git diff --stat`, so lockfile churn inflated the diff to `161,627` chars and `tailWithMarker` cut the first `61,627` chars.

4. **MCP Bridge `agent_claim` Spool Timeout Mismatch (`60s` vs `600s`):**
   - `plugin/bin/bridge.mjs` hardcoded `DEFAULT_WAIT_MS = 60_000` (`60s`) for `roundTripSpool`, whereas `plugin/bin/factory-claim.mjs` waited `DEFAULT_WAIT_SECS = 600` (`600s`). Any `Claim` whose `Gate` (or post-verdict pass) exceeded `60s` timed out in the MCP bridge before the Spool finished.

## Decision

1. **Retire Synchronous `Fresh-eyes review` from the Active `Contract` / `Claim` / `Acceptance` Pipeline (Amends ADR 0005, ADR 0010 §3, ADR 0018 §4, ADR 0029):**
   - `setContract` no longer smart-defaults `freshEyes: true` for `Lead` callers, and `lead_set_contract` in the Role-scoped MCP bridge (`plugin/bin/bridge.mjs`) removes the `fresh_eyes` input property.
   - `claim` (`finish` in `src/factory.ts`) executes only the deterministic mechanical `Gate` (and optional record-only `Watch`), never blocking `Claim` completion on a `Fresh-eyes review` LLM pass when `freshEyes` is omitted.
   - `projectTask` (`src/task-state.ts`) determines `leadEligible` solely from `!settled && gate?.verdict === "green" && !needsHuman`. `Lead` acceptance (`lead_accept_task` / `factory accept --by lead`) is never refused due to `reviewState` (`pending`, `incomplete`, `failed`, or `concern`), immediately unblocking any historical Task whose mechanical `Gate` is `GREEN` (such as `profile-max` `T-01-foundation`).
   - Update the `Lead` role contract and `Seat kickoff packet` (`src/roles-contract.ts`, `src/preflight.ts`) so **Closure & Integration Loop** diff inspection (`git show --stat "<sha>"` and `git diff "<sha>^" "<sha>"`) by `Lead` is the single semantic review gate before `lead_accept_task`.
   - Preserve backward-compatible `Ledger` parsing (`fresh_eyes_written`, `contract_set.freshEyes`) and `lanes.json` / `profiles.json` schema tolerance so existing ledgers and machine configs load without migration errors.

2. **Default Headless `pi/<model>` Invocations Without `:thinking` Suffix to `--thinking off` (`src/lanes.ts`, `src/pi-home.ts`):**
   - In `laneCliInvocation(lane)` (`src/lanes.ts`), when `parsed.provider === "pi"` and no explicit `:thinking` suffix is present on the lane string, pass `--thinking off` (while honoring any explicit `:<thinking>` suffix verbatim).
   - In `writeSettingsJson` (`src/pi-home.ts`), set `defaultThinkingLevel: "off"` for the `"headless"` role home so tool-less headless passes (`Watch`, `Retro`) never inherit `"defaultThinkingLevel": "high"` from `~/.pi/agent/settings.json`.

3. **Exclude `PACKAGE_LOCKFILES` and Prepend `--stat` in `diffBetween` (`src/workspace.ts`):**
   - Update `diffBetween(workspace, base, claimed)` in `src/workspace.ts` to prepend `git diff --stat <base> <claimed>` followed by `git diff <base> <claimed> -- . ":!package-lock.json" ":!pnpm-lock.yaml" ":!yarn.lock" ":!bun.lockb" ":!bun.lock" ":!npm-shrinkwrap.json"` (using `PACKAGE_LOCKFILES`), ensuring `Watch` and diff readers always see the full file summary and never waste diff budget on lockfiles.

4. **Unify MCP Bridge Spool Wait Timeout with `factory-claim` (`600_000ms` in `plugin/bin/bridge.mjs`):**
   - Raise `DEFAULT_WAIT_MS` in `plugin/bin/bridge.mjs` from `60_000` (`60s`) to `600_000` (`600s`, matching `DEFAULT_WAIT_SECS = 600` in `plugin/bin/factory-claim.mjs`) so `agent_claim` never times out prematurely on long-running `Gate` suites.

## Consequences

- **Positive:**
  - `agent_claim` is fast and 100% deterministic by default (running only the mechanical `Gate`), eliminating LLM cold-start latency and timeout deadlocks from every wave transition.
  - `Lead` (`thinking: high`, full project context, real shell access) is the sole semantic code reviewer in the Closure & Integration Loop, matching `paseo-room` and `codex-room` (`LEAD.md`).
  - Existing projects with historical `fresh_eyes_written` `failed` events on green `Gate` attempts (including `profile-max` `T-01-foundation` at `be85aba`) become immediately `lead-eligible` without manual ledger surgery.
  - Headless passes (`Watch`, `Retro`) and `diffBetween` are protected against inherited `high` thinking timeouts and lockfile diff truncation.
- **Negative / Trade-offs:**
  - When the Owner uses the raw `factory` CLI without a `Lead` seat, there is no automatic headless review pass unless the Owner inspects the diff or uses `Supervisor`/`Lead`; in the canonical SLP loop (`Owner → Supervisor → Lead → Peer`), `Lead` always performs the diff inspection before `lead_accept_task`.
