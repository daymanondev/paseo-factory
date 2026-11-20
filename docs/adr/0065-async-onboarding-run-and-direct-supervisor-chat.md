# 0065 — Async Onboarding Run, Live Phase Progress, and Direct Supervisor Chat

- **Date:** 2026-11-20
- **Status:** Accepted — ratified by the Owner via `/grill-with-docs` (Rounds 1–3); implementation deferred to a follow-up session.
- **Grounded in:** Live Paseo Desktop incident onboarding `/Users/andrewpham/Documents/code/self-project/print-connect-ios` (`~/.paseo/daemon.log` 2026-11-20 11:00:00–11:00:31: `agent.create.request` took `30,358 ms` while Paseo's hard `plugin.rpc.invoke.request` timeout fired at `30,002 ms`, `690 ms` before `onboardingCommit` completed), `plugin/server/surface-rpc.ts`, `plugin/shared/rpc.ts`, `plugin/client/factory/onboarding-wizard.tsx`, `plugin/client/factory/onboarding-screen.tsx`, `plugin/client/factory/onboarding-state.ts`, `plugin/client/factory/shell.tsx`, and `plugin/client/factory/project-panel.tsx`.
- **Amends:** [ADR 0056](0056-slim-factory-panel-slp-only-and-guided-onboarding.md) Decision 6 (replaces the blocking Step 4 commit UX with a server-tracked async **Onboarding run** with live phase progress, and removes the Step 4 and Project-panel `First directive` input boxes so `Start Supervisor` always opens the Supervisor chat directly); [ADR 0063](0063-global-onboarding-screen-profile-selection-and-panel-badges.md) Decision 1 (Step 4 commit executes via the async Onboarding run and navigates directly to the new Supervisor conversation when the Owner remains on the screen).

## Context

Under [ADR 0056](0056-slim-factory-panel-slp-only-and-guided-onboarding.md) and [ADR 0063](0063-global-onboarding-screen-profile-selection-and-panel-badges.md), onboarding Step 4 ran every side effect (`git init`, Project registration, `Lane profile` / model persistence, `Open Design project link` sync, and `agent.create` for the `Supervisor`) inside a single blocking `factory.onboarding.commit` RPC. While running, the UI showed only a disabled `"Starting…"` button with no visibility into which phase Factory was executing.

Paseo enforces a hard **30-second** timeout on `plugin.rpc.invoke.request`. Under concurrent daemon load (such as provider snapshot refresh or archiving another Project's agent), `agent.create.request` alone exceeded `30s` (`30.36s` observed in production), causing Paseo to abort the RPC with `Plugin RPC timed out: paseo-factory.invoke` right before the backend finished creating the Supervisor (`+690 ms`). Worse, `describeThrown` mapped every thrown RPC error—including timeouts—to `"Could not reach the Factory server (...) — check that Paseo is running, then try again"`, misleading the Owner into thinking onboarding had failed when the Project was registered and the Supervisor was already live.

Separately, both Onboarding Step 4 (`factory-onboarding-directive`) and the vacant Supervisor row on `ProjectPanel` (`factory-panel-directive`) presented an optional `First directive` text box even though pressing **Start Supervisor** already launches the Supervisor conversation where the Owner can talk directly.

## Decision

1. **Server-tracked async Onboarding run (`factory.onboarding.start` + `factory.onboarding.status`), keeping `factory.onboarding.commit` intact:**
   - Preserve `factory.onboarding.commit` as a synchronous RPC door (sharing the underlying step runner) so existing CLI/script callers and test suites remain unbroken.
   - Add two thin RPC doors for the Factory UI (both `OnboardingScreen` and workspace-panel `OnboardingWizard`):
     - `factory.onboarding.start`: validates all upfront preconditions synchronously (`<1s` — Git readiness / `initGit`, no live `Lead` or `Supervisor`, valid `Lane profile` and lanes), registers an in-memory per-folder **Onboarding run**, kicks off the pipeline asynchronously in the background, and immediately returns the initial run snapshot (`{ ok: true, run }`).
     - `factory.onboarding.status`: returns the active or most recent run snapshot by `runId` or canonical `folder`.
   - Emit `onboarding.progress` on `stateHub` (`factory.state.updates`) on every phase transition so Paseo `>= 0.16.0` clients update immediately; fall back to bounded polling of `factory.onboarding.status` on `< 0.16.0` hosts.

2. **Per-folder single-flight, automatic re-attach, and no mid-commit cancellation:**
   - Allow at most one active **Onboarding run** per canonical folder path. Starting or re-opening onboarding for a folder with an in-flight run automatically re-attaches the wizard to Step 4's live progress checklist instead of spawning a duplicate Supervisor or failing with an error.
   - Do not expose a `Cancel` button once commit starts (a daemon `agent.create` already in flight cannot be safely rolled back without risking orphan seats). Leaving the screen never aborts the server run; it completes cleanly in the background.
   - Apply a **120-second server-side watchdog** on `Starting Supervisor` so a genuinely hung daemon/provider call transitions the run to `failed` with an actionable error instead of spinning indefinitely.

3. **Live phase checklist, partial-failure retention, and honest error classification:**
   - Render a compact, applicable-only phase checklist directly inside Step 4 (`pending → running → done | failed`):
     1. `Checking folder & preconditions`
     2. `Initialising Git repository` *(only when `initGit` is requested)*
     3. `Registering Project & saving model lanes`
     4. `Linking Open Design` *(only when an Open Design project is selected)*
     5. `Starting Supervisor` *(live elapsed-seconds counter; after **10s**, show a calm neutral note that Factory is still waiting on the Paseo daemon/provider — never styled as an error)*
     6. `Opening workspace / Supervisor` *(client-side finalization phase)*
   - On failure of any phase, keep the checklist visible showing completed phases (`done`) and the failed phase (`failed`) with the exact server/client error and recovery actions (**Retry** idempotently from current state, or **Back** to adjust Step 1–3 choices). If only the client-side `Opening workspace / Supervisor` step fails, Retry re-attempts opening without re-creating the Supervisor.
   - Update `describeThrown` across all 4 wizard steps (`browse`, `inspect`, `installAll`, `start`) to distinguish **timeouts** (Paseo busy; check status or retry — action may still have completed), **true connection failures** (Paseo unreachable), and **other handler errors**. Transient polling errors while watching an active Step 4 run retry silently for a few ticks before surfacing a non-fatal connection warning, never aborting or marking the checklist failed.

4. **Remove `First directive` UI inputs and always open the Supervisor chat directly:**
   - Remove the `First directive (optional)` text input from **both** Onboarding Step 4 (`onboarding-wizard.tsx`) and the vacant Supervisor row on `ProjectPanel` (`project-panel.tsx`). Keep the optional `directive?` parameter on the server RPCs (`factory.onboarding.commit`, `factory.onboarding.start`, `factory.supervisor.start`) for backward compatibility with programmatic/test callers.
   - Upon completion of `Start Supervisor`:
     - If the Owner is still on the Onboarding surface: ensure the Paseo workspace exists and open the Factory panel alongside (on `OnboardingScreen`) or refresh the panel (on `Shell`), and **always open the new Supervisor conversation (`openAgent`)**.
     - If the Owner navigated away while the run completed in the background: emit a non-intrusive success toast without abruptly stealing focus.

## Considered Options

- **Keep `factory.onboarding.commit` blocking + client-side `onboardingInspect` timeout recovery:** Rejected — still hits Paseo's 30s RPC timeout whenever `agent.create` slows down, provides zero real-time phase visibility during the wait, and loses the real failure reason if `agent.create` fails after 30s.
- **Split onboarding into sequential client-driven RPCs (register → lanes → Open Design → startSupervisor):** Rejected — `agent.create.request` alone exceeded 30s (`30.36s`), so splitting steps still times out on the final step while sacrificing server-side single-door ownership and background completion if the Owner leaves the screen.
- **Add standalone `factory.supervisor.start` async progress in the same change:** Deferred — keeping the first implementation scoped to Onboarding (both mount sites) plus `ProjectPanel`'s directive-box removal keeps the wave bounded while designing the server runner so `factory.supervisor.start` can share it later.

## Consequences

- Onboarding Step 4 can no longer fail with a spurious 30s `Plugin RPC timed out` error when Paseo or a provider takes 30–120s to initialize a `Supervisor`, and the Owner always sees which phase Factory is currently running.
- Leaving or re-opening the Onboarding screen mid-start never double-creates a `Supervisor`; the UI re-attaches cleanly to the active `Onboarding run`.
- `Factory surface` becomes simpler and more uniform: every `Start Supervisor` action starts the seat and opens its chat directly without a redundant `First directive` input box.
- Existing `factory.onboarding.commit` and `factory.supervisor.start` RPC schemas stay backward compatible for CLI, scripts, and tests.
