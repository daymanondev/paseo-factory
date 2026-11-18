# 0063 — Global Onboarding Screen, Step 3 Lane Profile Selection, and Unified Panel Badges

- **Date:** 2026-11-18
- **Status:** Accepted — ratified by the Owner via `/grill-with-docs` (Rounds 1–4); implementation tracked in `.scratch/factory-global-onboarding-and-badges/spec.md` (`CONTEXT.md` updates alongside the implementation commit).
- **Amends:** [ADR 0056](0056-slim-factory-panel-slp-only-and-guided-onboarding.md) Decisions 4 & 6 (adds a desktop-only global Onboarding entry and screen alongside the workspace panel, and adds `Lane profile` selection to Step 3); [ADR 0057](0057-every-seat-replacement-is-a-handoff-supervisor-handoff-and-wide-colourful-factory-tab.md) §9 (extends `FACTORY_PALETTE` to status badges, Peer disposition badges, Models-tab / Step 3 seat names, and the onboarding wizard).

## Context

[ADR 0056](0056-slim-factory-panel-slp-only-and-guided-onboarding.md) deleted the global Factory screen and left-sidebar header item so every Factory panel maps 1:1 to an open Paseo workspace. That introduced an onboarding dead-end for brand-new projects (such as a newly added Paseo Project with zero workspaces yet): the Owner had to create a dummy workspace/chat session first just to access the Factory panel and run `OnboardingWizard` — and on Step 4, `OnboardingWizard` still spawns its own Supervisor session anyway.

Three additional UI friction points surfaced in the same review:
1. **Step 3 (`Models`) ignored `Lane profile`s:** `OnboardingWizard` prefilled only `machineLanes` (`supervisor`, `lead`, `worker`), forcing manual per-seat edits even when saved `Lane profile`s existed in `view.profiles`.
2. **Inconsistent status colors & missing badges:** `seatStateColour` checked `row.handoff` / `row.pendingLane` before `statusLabel`, coloring two `idle` seats differently when one had an active/scheduled handoff, and rendered statuses as plain text.
3. **Uncolored Models rows and plain disposition text:** The Team tab used `<RoleName />` fixed seat colors (`supervisor`, `lead`, `peer`), whereas the Models tab (`ModelRow` / `Default worker`) and Onboarding Step 3 rendered plain uncolored text; Peer dispositions (`engineer`, `architect`, `scout`, `reviewer`) also appeared only as muted suffix text.

## Decision

1. **Desktop-only global Onboarding entry & screen (no "All projects" dashboard):**
   - Keep ADR 0056's workspace-scoped `ProjectPanel` and do **not** restore the old global "All projects" dashboard, Kanban, or Timeline.
   - Register two desktop-only global triggers: a compact sidebar footer item (`addSidebarFooterItem`, e.g., `Onboard Project`) and a global Command Center action (`addCommandCenterItem` with `context: "global"`, `"Factory: Onboard Project"`).
   - Both open one dedicated Onboarding screen (`addScreen`), mounting:
     - **Target picker:** 1-click list of Paseo Projects from `useProjects()` not yet registered in Factory, plus a visual **Folder Browser** backed by a new read-only `onboardingBrowse` server RPC (starting at `$HOME`, supporting breadcrumbs / parent traversal / quick path jump) because browser/Electron `showDirectoryPicker()` does not return absolute OS paths.
     - **Shared `OnboardingWizard` (4 steps):** runs inline on the screen; nothing mutates disk until the Owner confirms **Start Supervisor** in Step 4.
   - **On `Start Supervisor` commit (Step 4):**
     1. Run `onboardingCommit` (`git init` + initial commit only if confirmed in Step 1, register Factory Project, apply chosen `Lane profile` or per-seat models, start Supervisor).
     2. Reuse an existing active `local` Paseo workspace for that root if one exists; otherwise create a clean `local` workspace via Paseo client (`createWorkspace`, zero dummy chat session).
     3. Exit the global Onboarding screen: open the Supervisor chat (`openAgent`) if a directive was provided, else open the workspace and its Factory panel (`openWorkspace` + `openPanel`).

2. **`Lane profile` selection in `OnboardingWizard` Step 3 (`Models`):**
   - Show available `view.profiles` at the top of Step 3 for 1-click selection (plus a choice to revert to machine defaults).
   - Selecting a profile prefills `supervisor`, `lead`, and `worker` and passes `profileId` so `onboardingCommit` applies the full profile (`watch` lane + `activeProfileId` included) with copy-on-apply semantics (`CONTEXT.md`).
   - Individual seat `Change` actions remain available after picking a profile, marking the selection `modified` if any seat diverges.

3. **Unified `FACTORY_PALETTE` badges and fixed colors (`plugin/client/`):**
   - **Status Badge (Team tab):** Render seat/Peer statuses as pill badges (`tint` background + border + dot) keyed **strictly 1:1 on `statusLabel`**, never overridden by `handoff` or `pendingLane`: `working` → `ok`, `starting` → `wait`, `waiting for permission` → `wait`, `error` → `bad`, `idle` / `vacant` → `idle`. Handoff progress remains on its dedicated `move`-colored line.
   - **Fixed Seat Colors (`<RoleName />`):** Apply the existing `FACTORY_PALETTE` seat colors (`supervisor`, `lead`, `peer`) consistently across the Team tab, the Models tab (`Supervisor`, `Lead`, and `Default worker` using `peer`), and Onboarding Step 3 (`Supervisor`, `Lead`, `Worker` using `peer`).
   - **Peer Disposition Badge (Team tab):** Replace plain `· <disposition>` text on Peer rows with a fixed-color badge using `FACTORY_PALETTE` dark/light tones: `engineer` (`#6185cc` / `#4f6fc0`), `architect` (`#9776e5` / `#7459b4`), `scout` (`#5db3ba` / `#287a81`), `reviewer` (`#de54c1` / `#b23a98`).
   - **Onboarding Styling:** Apply `FACTORY_PALETTE` across the 4-step indicator (active `lead`/accent, completed `ok`), Step 1–2 status badges (`ok` / `wait` / `bad`), Step 3 seat colors, thinking pills, and highlighted selected `Lane profile`, and a compact Step 4 summary.

## Considered Options

- **Restoring the old left-sidebar Factory global dashboard:** Rejected — brings back the unused "All projects" surface deleted in ADR 0056 when the actual gap is strictly zero-workspace project onboarding.
- **Folder-picker popover creating an empty workspace immediately:** Rejected — cancelling mid-wizard would leave orphan empty workspaces behind; keeping all 4 steps on the Onboarding screen defers side effects (`git init`, workspace creation, registration, Supervisor start) to Step 4 Start.
- **Manual path text input only for non-Paseo folders:** Rejected — typing absolute paths is error-prone compared to a server-backed `onboardingBrowse` directory browser that works identically on local and remote hosts.

## Consequences

- Brand-new Paseo Projects (`kind: "non_git"` or `0` workspaces) and arbitrary host directories can be onboarded from Paseo Desktop UI without creating a throwaway chat session first.
- `OnboardingWizard` and `onboardingCommit` gain `profileId` support while preserving existing workspace-panel callers and `watch` lane parity.
- Status badges, Peer disposition badges, and Models/Onboarding seat names share one palette contract (`FACTORY_PALETTE`) across light and dark themes.
