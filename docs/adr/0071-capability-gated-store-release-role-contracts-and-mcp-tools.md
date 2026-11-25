# 0071 — Capability-Gated Store Release Role Contracts, Thin Non-Mobile Seats, and Live Mode-Flip Refresh

- **Date:** 2026-11-25
- **Status:** Accepted — ratified by the Owner over `/grill-with-docs` rounds 1–2 (Q1–Q9, revised after runtime & cross-repo review; implementation spec [spec.md](../../.scratch/capability-gated-store-release/spec.md)).
- **Grounded in:** `src/roles-contract.ts` · `src/preflight.ts` · `src/pi-home.ts` · `src/mcp/shared.ts` · `plugin/server/roles.ts` · `plugin/server/surface-rpc.ts` · `plugin/server/lead-mailbox.ts` · `plugin/server/store-release.ts` · `plugin/bin/bridge.mjs` · `factory-release-lab` ADR 0005.
- **Amends:**
  - [ADR 0066](0066-store-release-bridge-vault-store-notebook-and-release-lab-handoff.md) (gates Store Release laws, command blocks, kickoff lines, and MCP tools/schemas behind mobile Project detection and active `Store release mode` instead of injecting them unconditionally into every `Lead` and `Supervisor` seat, and forwards `failure.hint` into `Lead mailbox` notifications).
  - [ADR 0067](0067-paseo-017-antigravity-acp-per-session-mcp-and-live-role-contracts.md) (extends `Live role contract` and per-session `Role-scoped MCP bridge` with capability-gated seat contracts, MCP `listChanged`, and safe seat refresh on `off ↔ on` mode flips).
  - [ADR 0013](0013-isolated-pi-agent-home-for-slp-roles.md) / [ADR 0016](0016-role-scoped-mcp-bridge-kickoff-packet-and-three-layer-execution-fence.md) (keeps shared Pi `APPEND_SYSTEM.md` free of Project-conditional Store Release rules and relies on dynamic kickoff + unconditional compaction-safe mailbox reminders).

## Context

`paseo-factory` supports web, CLI, backend, and mobile Projects, while `factory-release-lab` (`Store release`) currently targets **mobile** apps only (`android` / `ios`) and is explicitly toggled per Project (`off` | `on-request` | `auto-staging`). However, ADR 0066 injected the full `Store Release Discipline` law, `Store Release Boundary` law, and `lead_store_release` / `lead_record_store_note` / `supervisor_record_store_note` MCP tools into **every** `Lead` and `Supervisor` role contract regardless of Project type or `Store release mode`.

This caused four concrete problems:
1. **Prompt and tool bloat on non-mobile & `off` Projects:** Web/backend `Lead`s carried ~2 KB of irrelevant App Store / Google Play instructions (`Hole`, `Console handoff guide`, `Store notebook`), risking distraction and confusion.
2. **Stale session capability on mode toggles:** Because MCP clients cache `tools/list` from session open, toggling `Store release` from `off` to `on-request` or `auto-staging` mid-session left live seats unaware of newly permitted Store Release tools unless seats were refreshed cleanly — while blindly auto-rotating an active `Supervisor` chat would violate `CONTEXT.md`'s non-auto-rotation rule.
3. **Coupling temptation:** Putting screenshot or release workflow mechanics into every `Lead` prompt conflated `Lead`'s project-management role with `factory-release-lab`'s runner responsibilities.
4. **Dropped `failure.hint` across the bridge:** `plugin/server/store-release.ts` dropped `failure.hint` when relaying `factory-release-lab` failures to `Lead mailbox`, hiding actionable manifest remediation (`screenshot-cmd-missing`, `invalid-screenshot-dimensions`) from `Lead`.

## Decision

1. **Pure per-Project Store Release capability resolver (`resolveStoreReleaseCapability`, Q4, Q5):**
   - Live in a pure `src/` module synced to `plugin/server/core/` and bundled into self-contained `plugin/bin/bridge.mjs` via `scripts/generate-policies.mjs`.
   - Derive mobile eligibility purely from Project signals (`isMobile = detectMobilePlatforms(projectRoot).length > 0 || existsSync(join(projectRoot, ".store-release", "manifest.json"))`), combined with `Store release mode` (`off` | `on-request` | `auto-staging`) aligned directly with `validateStoreReleasePreconditions` (`isActive = isMobile && mode !== "off"`):
     - **`Lead` (`leadEnabled`):** `isActive`. When `false`, `Lead` receives **zero** Store Release laws, **zero** Store Release command-block lines, **zero** Store Release kickoff lines (unless an active/paused Ledger run exists), and **zero** Store Release MCP tools (`lead_store_release`, `lead_record_store_note`).
     - **`Supervisor` (`supervisorTier`):** Three explicit tiers:
       1. `"hidden"` (`!isMobile`): **zero** Store Release boundary prose, no `storeRelease` dispatch parameter in command blocks or MCP schema, and no `supervisor_record_store_note` tool.
       2. `"off-hint"` (`isMobile && mode === "off"`): **one** concise sentence instructing `Supervisor` to point the Owner to the Project panel's **Store Release** card if store upload is requested — no `Hole` / `Console handoff guide` prose, no `Store notebook`, no `storeRelease` schema parameter, and no `supervisor_record_store_note` tool.
       3. `"full"` (`isActive`): full Store Release boundary (`storeRelease` dispatch intent, `Hole` / `Console handoff guide` relay, and `supervisor_record_store_note`).

2. **Keep shared `Pi harness home` `APPEND_SYSTEM.md` free of Store Release rules & survive `/compact` (Q7):**
   - `<stateDir>/pi-agent/{supervisor,lead}/APPEND_SYSTEM.md` is shared across Projects and **must** stay Project-agnostic (`storeRelease` omitted).
   - Non-Pi providers receive the Project-gated Store Release contract via ephemeral per-Project `agent.open.before` `appendSystemPrompt` (`>=0.17.1`) or create-time `injectRoleOnCreate` (`<0.17.1`).
   - Pi seats receive the Project-gated Store Release laws and command hints dynamically through `Seat kickoff packet` (`src/preflight.ts`, via an explicit `includeDynamicStoreReleaseContract` flag so `omitSystemPromptDuplicates: true` still keeps dynamic Store Release text on Turn-1 and post-`Handoff` successor kickoffs) **plus** unconditional compaction-safe reminders on `Lead mailbox` (`storeRelease` dispatches, `store_release_*` wakeups, `auto-staging` `lead_release` hints) and `Supervisor mailbox` (`Hole` / `Console handoff guide` reports).

3. **Dynamic MCP bridge gating & safe seat refresh on `off ↔ on` flips (Q4, Q5, Q7):**
   - `plugin/bin/bridge.mjs` advertises `capabilities: { tools: { listChanged: true } }` on `initialize`, and evaluates `resolveStoreReleaseCapability` dynamically on **both** `tools/list` and `tools/call` against live `project-settings.json` / `projectRoot`: hiding disabled Store Release tools, stripping `storeRelease` from `supervisor_dispatch_lead` when `supervisorTier !== "full"`, rejecting disallowed calls/params, updating `lastCapabilitySignature` on `tools/list`, and emitting `notifications/tools/list_changed` when transitions are detected outside `tools/list`.
   - In `storeReleaseWrite` (`plugin/server/surface-rpc.ts`), when a toggle crosses the `off ↔ on` capability boundary: retire unstarted 0-turn idle seats cleanly; trigger immediate or quiet-point `Lead` `Handoff` (waiting for both current `Lead` turn end and `projectPeerInFlight === false`); never auto-rotate a started `Supervisor` chat (instead returning `supervisorNeedsHandoff: true` so the UI offers a non-destructive 1-click handoff button); and keep `on-request ↔ auto-staging` flips completely free of seat churn.

4. **Strict separation of screenshot policy & `failure.hint` relay (Q1, Q3):**
   - Screenshot capture cadence and commands belong solely to `factory-release-lab` ([ADR 0005](../../../factory-release-lab/docs/adr/0005-custom-screenshot-command-and-raw-to-listing-sync.md)); `Lead` receives no screenshot-specific laws and reacts organically when `release-lab` returns an `app-repo` failure (`screenshot-cmd-missing`, `screenshot-capture-failed`, `invalid-screenshot-dimensions`).
   - `plugin/server/store-release.ts` parses and forwards `failure.hint` (`Hint: ...`) into `Lead mailbox` failure notifications so `Release lab`'s remediation guidance reaches `Lead` verbatim.

## Considered Options

- **Gate by `isMobile` alone (ignoring `Store release mode = "off"`):** Rejected — still injects Store Release laws and MCP tools into mobile projects whose Owner explicitly left Store Release turned `off`.
- **Enable `Lead` Store Release tools whenever an orphaned `store-release-request.json` exists under `mode: "off"`:** Rejected — contradicts `validateStoreReleasePreconditions`, which refuses all store operations when `mode === "off"`.
- **Auto-rotate a started `Supervisor` chat immediately on toggle:** Rejected — interrupts or splits active Owner conversations; retiring only 0-turn seats and surfacing `supervisorNeedsHandoff: true` preserves conversation continuity.
- **Create separate per-Project `Pi harness home` directories for `Lead` and `Supervisor`:** Rejected — duplicates standing seat homes and auth symlinks unnecessarily when `Seat kickoff packet` and compaction-safe mailbox reminders carry dynamic per-Project instructions.

## Consequences

- Non-mobile Projects and `mode: "off"` mobile Projects run with lean `Lead` and `Supervisor` system prompts and zero Store Release tool/parameter clutter.
- Enabling `Store release` on a mobile Project dynamically unlocks `lead_store_release`, `lead_record_store_note`, `supervisor_record_store_note`, `supervisor_dispatch_lead.storeRelease`, and their full role instructions cleanly without interrupting started Owner `Supervisor` chats.
- `Lead` receives full `failure.hint` guidance on `Release lab` failures, and `CONTEXT.md` reflects capability-gated `Store release` exposure and Project-agnostic shared Pi `APPEND_SYSTEM.md`.
