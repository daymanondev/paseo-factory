# 0040 — Open Design UX Engine, Dual-Surface Flow Board (`screens.html` + `.od-frames/`), and Complete Retirement of `impeccable`

- **Date:** 2026-11-01
- **Status:** Accepted
- **Supersedes:** ADR 0034 §1 (`pbakaus/impeccable` detector gate & hooks), ADR 0036 (`impeccable` companion tool & auto-provisioning)
- **Amends:** ADR 0034 §2–3, ADR 0037
- **Preserves:** ADR 0001–0033, ADR 0035, ADR 0038, ADR 0039

## Context

Live Scrum runs (`goal-planner` `ux-r02` vs. the Owner's side-by-side Open Design run on project `5e1f5cb8-adc8-4cc9-b457-c1fafcd001a5`) demonstrated a severe quality gap between Paseo Factory's UX specialist output and Open Design (`v0.26.1`):

1. **Perverse incentives of `impeccable detect` and the `4-screen × 6-state` static clone matrix:** Forcing the UX specialist to cram an entire application into 2–4 screens, duplicate 6 static state trees (`24` hidden DOM blocks) in one HTML file, and achieve `nonAdvisoryCount: 0` under `impeccable detect` caused the agent to play defensive minimum-risk HTML — rendering native browser `<select>` dropdowns for psychological assessments, flattening all internal hierarchy into white boxes separated by `1px` `<hr>` lines (to avoid `nested-cards` findings), and stuffing 40-word specification explanations into cards.
2. **Primary-source inspection of Open Design (`v0.26.1`):** Open Design uses the exact same local coding CLI (`codex`), but achieves studio-grade UI by pre-staging `.od-frames/` (`iphone.html`, `android.html`, `neutral.html`, and `@layer od-layout` primitives in `layout.css`), enforcing the `od-next-strategy` (`v3.3.8`) `prototype.md` and `craft/*.md` rules (*"One primary action per screen in thumb zone"*, drenched/inverse hero surfaces, soft tonal borderless surfaces, strict copy budgets, 5 curated `directions`), producing a dual-surface deliverable (`index.html` interactive prototype + `screens.html` story-grouped multi-screen flow board with `.frame-connection` arrows), and running a fast deterministic `lintArtifact` P0/P1 anti-slop linter.

## Decision

1. **Retire `impeccable` Completely from `paseo-factory`:**
   - Remove `impeccable` from `COMPANION_TOOLS_CATALOG` (leaving `factory-skills-pack` as the managed host skill pack), remove `provisionImpeccable`'s `impeccable-hook.mjs` / `impeccable-opencode.mjs` / `hooks.json` PostToolUse scanners, remove `impeccable` from `src/choke.ts` and `plugin/bin/exec-shim.mjs`, remove `impeccable.local.md`, and automatically prune stale `impeccable*` directories and symlinks from `<userHome>/.agents/skills/` and provider skill directories during skill reconciliation (preserving passive read-only compatibility for historical closed runs that recorded `detector.tool: "impeccable"`).

2. **Hybrid Open Design Engine in `src/scrum/open-design.ts`:**
   - **Embedded Core (Zero External GUI Dependency):** Bundle Open Design's `.od-frames/` shells (`iphone.html`, `android.html`, `neutral.html`) and `@layer od-layout` primitives (`layout.css`), the 5 curated Design Directions (`editorial-monocle`, `modern-minimal`, `human-approachable`, `tech-utility`, `brutalist-experimental`), the `od-next-strategy` `prototype` & `craft` rules, and the deterministic `lintArtifact` + Mobile Craft linter directly in `paseo-factory`. Automatically stage `.od-frames/` into `.scratch/<initiativeId>/mockups/.od-frames/` before UX tasks run so remote headless hosts (`andrews-mac-mini`) produce Open Design-grade deliverables out of the box.
   - **Auto-Bind Native `Open Design.app` When Present:** When `/Applications/Open Design.app` (or `OPEN_DESIGN_DAEMON_URL`) is available on the host, expose the `od` CLI / `od mcp` and the 151 Brand Design Systems catalog (`tokens.css`, `DESIGN.md`, `components.manifest.json`) to UI specialists and support workspace synchronization via `orchestratorWorkspace`.

3. **Dual-Surface UX Deliverable (`mockups/index.html` + `mockups/screens.html` + `mockups/design-manifest.json`):**
   - Replace the `2–4 mega-screens × 6 static states` requirement with Open Design's dual-surface architecture:
     - `mockups/index.html` (+ `styles.css`, `app.js`, `app-data.js`, `.od-frames/*`): Interactive prototype honoring `?screen=<id>` and `scrum:set-state` postMessages, decomposing flows into single-purpose screens (one primary thumb-zone action per screen).
     - `mockups/screens.html` (+ `screens.css`, `screens-data.js`): Story-grouped Figma-style flow board organizing all step screens (`12–40+` frames) across User Journey groups (plus a dedicated `System & Edge States` group for `empty`, `loading`, `error`, `offline`, `permission-denied`) with `.frame-connection` flow arrows.
     - `mockups/design-manifest.json`: Structured handoff manifest (bound `:root` tokens, journey groups, screen inventory, and component patterns) consumed by Senior Dev (`dev`) and QA (`qa`).
   - `EXPERIENCE.md` declares the Core Screens / User Journeys (`## Screen: <id>` with `Surface: mobile | desktop | responsive`), while `screens.html` expands every sub-step in those journeys.

4. **Three-Tier Open Design Mechanical Gate (`detector.tool: "open-design"`):**
   - `lint-scrum-doc --kind ux` and `--kind ui` enforce:
     1. **Open Design `lintArtifact` P0/P1 + Mobile Craft Rules:** Rejects `purple-gradient`, `trust-gradient`, `ai-default-indigo`, `emoji-icon`, `left-accent-card`, `invented-metric`, `filler-copy`, `external-image`, excessive `raw-hex` outside `:root`, native `<select>` survey/choice dumps on mobile, multi-column mobile `<table>` layouts, leaked spec identifiers (`FR-*`, `NFR-*`, `UJ-*`, `AD-*`, `ADR-*`), and card prose violating the copy length budget (`> 280` chars).
     2. **Deliverable Syntax & Offline Asset Integrity:** Validates balanced CSS braces, JS syntax (`new Function`), and offline resolution of all referenced local files (`styles.css`, `app.js`, `screens.html`, `.od-frames/*`).
     3. **Headless Browser & Screenshot Evidence (`browser.json`):** Requires `network: "disabled"`, `consoleErrors: []`, `pageErrors: []`, zero horizontal overflow (`scrollWidth <= clientWidth`), SHA-256 verified PNG captures for `screens-board` (`screens.html`) and each Core Screen declared in `EXPERIENCE.md`, and `detector: { tool: "open-design", passed: true, nonAdvisoryCount: 0 }`.

5. **Upgraded Loopback Design Studio & 24-Hour / `Owner wait` Session Lifetime:**
   - Upgrade `src/scrum/design-studio.ts` and `src/scrum/preview-server.ts` to present three views: **Flow Board (`screens.html`)**, **Interactive Prototype (`index.html` in `.od-frames/`)**, and **Inspect & Design System Kit (`DESIGN.md` + `design-manifest.json`)**.
   - Extend the loopback preview server TTL from 15 minutes to **24 hours** (refreshed on any request while `Owner wait` is active) so Tailscale preview links on `andrews-mac-mini` never expire before the Owner reviews them.
