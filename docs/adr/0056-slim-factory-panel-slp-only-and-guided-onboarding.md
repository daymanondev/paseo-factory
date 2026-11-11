# 0056 — Slim Factory Panel: SLP-Only, Paseo Client as the Sole Surface, Attention-First Project Panel, and Guided Onboarding

- **Date:** 2026-11-11
- **Status:** Accepted — Owner confirmed Q1–Q24 in `/grill-with-docs` ("toàn bộ theo bạn khuyến nghị"). Implementation tracked in `.scratch/factory-panel-slim/`.
- **Supersedes:** [ADR 0038](0038-scrum-owner-waits-and-count-based-work-limits.md), [ADR 0049](0049-scrum-slp-parity-zcode-isolation-kickoff-digest-and-role-hardening.md) and every Scrum-mode decision in ADR 0032/0033/0034 (Execution mode, Scrum roles, Owner wait, Task allowance, UI Design Approval Checkpoint) · [ADR 0051](0051-standalone-factory-web-console-plugin-sidecar-and-in-console-supervisor-chat.md) (Web Console + Console sidecar) · the on-demand `Retro` pass of ADR 0045 §Retro and ADR 0048 §4.
- **Amends:** [ADR 0017](0017-native-paseo-role-providers-and-slp-seat-recognition.md) §4 (the plugin may create a `Supervisor` seat from the onboarding wizard and from a vacant Supervisor row; it still never offers `Start Lead`).

## Context

The Owner reported that the plugin crashes on Paseo mobile (`kit/poll.ts` calls `window.addEventListener`, which React Native's `window` lacks; Studio and Scrum previews render DOM `iframe`/`img`), and that the surface is too dense to use: the Task Kanban, Timeline swimlane, Ledger stream, Retro, the Seat graph (beyond Open Supervisor / Open Lead / Rotate), the Scrum workflow, the "All projects" view and the standalone Web Console are surfaces the Owner never uses. Adding a Project is a bare folder picker with no guidance. `paseo-room`'s runtime panel (attention first, one line per thing, colour only for exceptions, guided modals) is the reference for how an SLP surface should read.

## Decision

1. **SLP is the only workflow.** Scrum mode is deleted end to end (core, server, client, CLI, generated bundles, tests, runbooks). Open Design and project skill packs are extracted out of `src/scrum/` first and persist in a per-Project `project-settings.json` (no `mode` field). A one-time boot cleanup migrates `execution.json` → `project-settings.json` and deletes `scrum-lanes.json`, `scrum-profiles.json`, `scrum-active-profile.json`, `execution-switch.json` and `projects/*/scrum/`. The only Scrum tolerance left is that Ledger validation ignores the historical `execution` field on `contract_set` events, because the Ledger is append-only.
2. **The Paseo plugin client is the sole Factory surface.** `web/`, `plugin/web/`, the Console sidecar, `agent-transcript`, the console-only `inbox` RPC, `factory console`, and their scripts/tests are deleted. `plugin/server/timeline.ts` stays (it feeds the Watch).
3. **Retro is deleted; Recurrence Guard and Wave Hardening are not.** The "repeated failure earns a fix" loop the Owner relies on is the in-flight `Recurrence Guard` → `Wave Hardening` path, which never depended on Retro. Removed: `factory.retro`/`retro.ratify`, `factory retro`, the Command Center "Run Daily Retro", and the `retro` lane. Proposals keep arriving through the Supervisor. Historical `retro_written` events and `retro-*.md` files stay readable.
4. **One panel = one Project = the open Paseo workspace.** The global Factory screen, its sidebar row, the Project Switcher and "All projects" are removed. Entry points are the Workspace panel (the Project), the plugin Settings screen (machine-wide), and one Command Center item "Open Factory Panel".
5. **Project panel layout (one column, desktop and mobile):** Header (name, one summary line, `⋯` menu) → **Needs you** (only when non-empty) → **Seats** (Supervisor, Lead with `Nk / 128k` context bar and Lead handoff state, Peers) → **Open Design** card. Colour only for errors/stuck (red), waiting (amber) and Needs-you items.
   - *Needs you* lists only Owner-actionable items: `needs-human` Tasks, Tasks red at `MAX_ATTEMPTS`, errored/stuck seats or a stuck rotation, missing prerequisites, a broken Open Design link. Peer challenge signals routed to the Lead mailbox never appear.
   - No Accept button: acceptance belongs to the Lead (or the Supervisor on the Owner's word in chat).
   - Revoke Supervisor lives in the Supervisor row's `⋯`; per-Project models, skill packs, Open Design link/unlink, Reset and Delete live in the header `⋯`.
   - Vacant Supervisor shows `Start Supervisor` (directive box shared with onboarding); vacant Lead shows "ask your Supervisor" with no button.
   - Mobile is monitor + quick actions: Open, Rotate, Revoke; no Sync/Studio, no onboarding, no settings writes.
6. **Guided onboarding** in the Workspace panel when the workspace is not yet a Project (desktop only): (1) Folder checks — Git repo (offer `git init`), warn on no commits, block when a Lead exists; (2) Prerequisites with one-click install; (3) Supervisor / Lead / Worker models prefilled from machine defaults; (4) optional first directive and Open Design link → **Start** creates the Supervisor seat, sends the directive as its first message, and opens it.
7. **Settings screen** (machine-wide, collapsible, sections with warnings open by default): Default models & Lane profiles · Skills & Tools (Skill Hub, Companion tools, Helper MCPs) · Plugins · Vault · Diagnostics.
8. **Lead handoff is preserved unchanged**; only its presentation moves onto the Lead row.

## Considered Options

- *Hide Scrum / Console / Retro behind the UI but keep the code:* rejected — every hidden path still costs Gate time, context for seats, and migration surface on each release.
- *Keep reading `mode: "scrum"` as SLP forever:* rejected by the Owner in favour of a one-time cleanup; only the append-only Ledger keeps tolerance.
- *Design the new panel in Open Design first:* rejected by the Owner — the panel is simple enough to design directly; the Open Design *integration* for Projects stays.

## Consequences

- Breaking release `v0.6.0`; `CONTEXT.md` (Factory surface, Execution mode, Scrum role, Owner wait, Task allowance, UI Design Approval Checkpoint, Retro, Proposal/Ratification wording, Web Console, Console sidecar, Lane config) is rewritten in the same release so live seats never read a glossary ahead of the code.
- Everything, including the mobile crash fix, ships together as `v0.6.0`; no intermediate release.

### Review-fix notes (v0.6.0 integration review)

- **Linked Studio is view-only.** The Scrum approval/decision path is gone from the linked-design Studio: no gate id on the preview bundle, no decision relay between the Studio frame and the client, no review drawer (pins, screen statuses, Approve / Request Changes / Waive). The preview, Sync and Studio view stay. The `scrum:set-state` / `scrum:pick-mode` wire names in the mockup shim are kept deliberately: already-synced designs listen for them, and renaming a wire protocol is a design-compatibility break the slim-down did not call for.
- **Every Needs-you item carries one action.** `open-agent` (a live seat), `install-prerequisites`, `start-supervisor` (when neither seat is live, so there is no conversation to open) and `sync-open-design` (a broken link). The three mutating kinds are desktop-only; mobile renders a one-line "on Paseo Desktop" hint in their place rather than a dead end. `sync-open-design` re-syncs from the host's Open Design data; a design owned by a granted client folder is synced from the card's own Sync below it.
- **`supervisor-live` on onboarding commit is kept.** Onboarding refuses when a Supervisor is already live (not only a Lead) because the seat model is one Supervisor per Project (ADR 0017): a second Supervisor would split the Owner's directive channel and `supervisor_dispatch_lead` has one caller to address. It is the same rule `factory.supervisor.start` already enforces.
- **New thresholds and prose.** `HANDOFF_STUCK_AFTER_MS` (every extraction send's window times the send cap, plus a minute) and the `needs_human` gloss table in `plugin/server/panel.ts` are new in v0.6.0; the spec left both open. An unknown reason code passes through verbatim.
- **One Open Design readiness law.** A staged design is usable when `design/index.html` or `design/screens.html` exists (`openDesignBundleReady`); the sync refuses anything else and catalog discovery hides it, so the panel's "broken" verdict cannot disagree with what a sync can produce.
- **Known limitation: stuck seats.** A seat counts as stuck when the daemon reports it errored or parked on a permission prompt. There is no hung-or-idle detection: the snapshot carries no per-agent last-activity time, and an idle Lead is legitimately idle between dispatches, so no idle-too-long rule is guessed.
- **The `worker` lane keeps its name.** The Peer's model lane stays `worker` in `lanes.json` and "Worker" in the model picker; the glossary's `Peer` entry says so, and the agent itself is never called a worker.
- **Project settings writes are serialised.** `writeProjectSettings` runs behind the state-directory mutation gate (re-entrant, so existing callers are unaffected), and the legacy `execution.json` migration validates the Open Design link and source it carries across instead of trusting a cast.
