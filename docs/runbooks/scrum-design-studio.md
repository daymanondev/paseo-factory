# Scrum design review studio

UX delivers `DESIGN.md`, `EXPERIENCE.md`, `mockups/index.html` (interactive prototype), `mockups/screens.html` (story-grouped flow board), `mockups/design-manifest.json`, local assets, PNG captures and `mockups/browser.json`. Each `## Screen: kebab-case-id` in EXPERIENCE declares `Surface: mobile | desktop | responsive`, its primary journey and state behaviors. Decompose journeys into focused steps with one primary action per screen. The board expands these steps with `.frame-connection` arrows and a dedicated `System & Edge States` group.

## Embedded and native Open Design

UX worktrees receive `.od-frames/iphone.html`, `android.html`, `neutral.html` and `layout.css` automatically. Copy the complete selected shell to the prototype entry and put product content inside `.phone-content`; preserve hardware chrome, safe areas and separate phone tokens. Use layout primitives and bind one of the five curated directions (editorial-monocle, modern-minimal, human-approachable, tech-utility, brutalist-experimental) or an installed Brand Design System. Keep the chosen direction/system, CSS tokens, journey groups, screen inventory and component patterns in design-manifest.json for Dev and QA.

`factory open-design stage --dir <mockupsDir>` stages missing shells without overwriting authored files. `factory open-design lint --dir <mockupsDir>` emits deterministic artifact findings. It checks craft, copy budgets, JS/CSS syntax and offline assets; passing static lint alone does not prove browser quality.

When Open Design.app is installed, Factory discovers its native CLI and Brand Design Systems catalog and exposes an isolated `od` wrapper to UX. `OPEN_DESIGN_RESOURCE_ROOT` overrides resource discovery; `OPEN_DESIGN_DAEMON_URL` selects an optional native daemon. `factory open-design inspect` reports discovered resources, and `factory open-design od ...` invokes the native CLI. On explicit native-sync requests, `factory open-design sync --dir <mockupsDir>` imports the folder with `orchestratorWorkspace: { kind: "scratch", writeback: "external" }`. Native desktop authentication still applies. The embedded engine works without the app.

## Browser evidence and gates

The prototype reads `?screen=&state=`, reflects root `data-screen`/`data-state` and handles `scrum:set-state` messages. Keep product navigation persistent while state handlers render contextual feedback. Screen/state selectors belong in Studio.

Capture every Core Screen at its declared surface: Mobile 390×844, Desktop at least 1280×800, responsive at both. Also capture the UX flow board as `screens-board` / `mockups/screens-board.png`. Each viewport records `screen`, dimensions, `scrollWidth`, `clientWidth` and `screenshot: { path, sha256 }`. Networking is disabled, console/page errors are empty, and horizontal overflow is zero. Screenshot paths are Project-relative; PNG bytes and hashes are verified against submitted artifacts.

Record passing populated keyboard checks per Core Screen plus shared empty/loading/error/offline/permission-denied checks through the edge-state screens or state switcher. The six-state matrix per screen remains valid. New runs use `detector: { tool: "open-design", passed: true, nonAdvisoryCount: 0, viewportsChecked, findings }`, derived from actual artifact lint and viewport verification. Historical Impeccable reports remain readable under their frozen run policy.

Run `factory lint-scrum-doc --kind ux --dir .scratch/<initiative>` before Claim. The three tiers cover artifact craft, syntax/offline integrity and browser evidence. Dev reads the approved manifest, DESIGN.md, styles.css and screens.html. UI Dev Contracts append `lint-scrum-doc --kind ui --dir .scratch/<initiative>/qa/<task>` and reserve that evidence directory. QA includes equivalent `browserEvidence` in its authoritative report alongside the four-lens audit and execution evidence.

## Owner workflow

**Open Full Design Studio** opens the token-bound Studio. Flow Board is the default when screens.html exists; Artboard Canvas, Interactive Handset, Inspect & Pin and Design System Kit remain available. Drag to pan, Ctrl/Command+wheel to zoom, and Fit all to restore the overview. Static captures show submitted evidence; live frames show the selected state.

In Inspect, select a screen/viewport/state, enable Pin Comment, click an element and add a note. Mark screens Approved or Revise, provide a rationale, then choose Approve Design, Request Changes or Waive Gate. Decisions bind the design revision/digest and run revision; reopen stale tabs. Sessions have a 24-hour idle lifetime refreshed on every HTTP request. Artifact routes require the session token; decisions additionally require same-origin proof. Opaque mockup sandboxes have no network access. Only pinned Git artifacts are served.

Studio decisions use the same writer and Lead notification path as Paseo decisions. Revision briefs carry structured findings and screen statuses. Accepted UX Tasks stay closed; revisions use new Task IDs.
