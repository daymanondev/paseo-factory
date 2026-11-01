# 0037 — Screen Surface Contracts, Mobile App Shell Anatomy, Pure Product Chrome, and Device-Framed Design Studio

- **Date:** 2026-10-31
- **Status:** Accepted
- **Amends:** ADR 0032, ADR 0034
- **Preserves:** ADR 0001–0036

## Context

In `ADR 0032` and `ADR 0034`, the Scrum UX contract required every screen in `EXPERIENCE.md` to provide both Desktop (`1280×800`) and Mobile (`390×844`) screenshots from a single responsive `mockups/index.html` document containing in-page keyboard state controls. During live runs on multi-client initiatives (`apps/mobile` + `apps/web`), this produced four structural failures:

1. **In-Mockup Debug Chrome Consumed the Mobile Viewport:** Requiring in-page screen and state switcher controls inside `mockups/index.html` caused `UX` specialists to render a persistent diagnostic workbench header (listing screen IDs, state pills, and surface metadata) that consumed ~73% (`620px`) of the `390×844` mobile frame, pushing actual product content off-screen.
2. **Shrunk-Desktop Web Forms Instead of a `Mobile app shell`:** Treating every screen as a dual-viewport responsive web page caused mobile-first screens to be authored as `1200px` desktop containers wrapped in a single bordered `.panel` (to avoid `impeccable detect`'s nested-card rule) with multi-column HTML `<table>` elements, native `<select>` survey dumps, and a textual `<footer>` instead of a true `Mobile app shell` (status bar, compact app bar, scrollable mobile viewport, fixed bottom tab bar with icons, and standalone mobile cards). Conversely, desktop-only operator workbenches (`/expert-studio`) were forced into `390×844` mobile captures.
3. **Spec-Dump UI Copy and Full-Screen State Replacement:** To prove traceability for Stage 3 Readiness, specialists leaked internal specification identifiers (`ADR-0003`, `FR-14`, `NFR-5`), package names (`@goal-planner/shared`), function/field names (`evaluateIntakeAssessment`, `tasksPerWeek`, `candidateOptedIn = true`), and raw HTTP routes (`PUT /api/...`) into visible end-user UI copy, and implemented the five non-`populated` states by hiding the entire screen (`populatedWrap.hidden = true`) behind a generic text banner.
4. **Canvas Viewer Ergonomics & Token Parsing:** The 58-line `designStudioHtml()` (`src/scrum/design-studio.ts`) mounted `2 × N` live `<iframe>` elements with `pointer-events` enabled at `29%` zoom (swallowing mouse wheel/drag events and rendering text illegible), left toolbar `Screen` and `Viewport` selectors non-functional on the `Artboard Canvas` tab, and used line-level substring regexes (`designTokens()`) that matched prose paragraphs containing words like `"gap"` or `"workspace"` as design tokens.

## Decision

### 1. Explicit `Screen surface` Declarations (`mobile` | `desktop` | `responsive`)

- Each `## Screen: <screen-id>` section in `EXPERIENCE.md` (and optional `mockups/manifest.json` screen entries) declares its target `Screen surface`: `Surface: mobile | desktop | responsive` (defaulting to `responsive` only when reading legacy artifacts without a surface declaration).
- Viewport evidence (`verifyBrowserEvidence` and `lintScrumDoc("ui")`) and `impeccable detect` checks follow the screen's declared `Screen surface`:
  - `mobile`: requires verified `Mobile (390×844)` screenshot and detector coverage.
  - `desktop`: requires verified `Desktop (1280×800)` screenshot and detector coverage.
  - `responsive`: requires both `Desktop (1280×800)` and `Mobile (390×844)` screenshots and detector coverage.

### 2. `Mobile app shell` Anatomy & Card Unblocking

- Screens with `surface: mobile` (and `responsive` screens at mobile breakpoints) must implement a `Mobile app shell`: a `390×844` mobile container with a compact top app bar, an internal scrollable content region, a fixed bottom navigation bar (`<nav>`) or contextual action bar, and mobile-native cards, list rows, segmented controls, and sheets.
- Multi-column HTML `<table>` elements are prohibited inside `mobile` screen views and rejected by `lintScrumDoc("ux")`.
- The outer screen viewport/background must act as an unbordered canvas rather than a single full-page bordered `.panel` card, allowing individual domain items (match profiles, assessment prompts, weekly tasks) to be styled as first-level cards without triggering `impeccable`'s nested-card rule.

### 3. `Pure product chrome` & `In-shell contextual state` Verification

- **No In-Mockup Debug Switchers:** `mockups/index.html` must render only product UI (`Pure product chrome`). All screen, state, and viewport switching belongs exclusively to the outer `Design overview canvas` and Paseo modal chrome via `?screen=<id>&state=<state>` and `postMessage({ type: "scrum:set-state" })`. `lintScrumDoc("ux")` rejects mockups that render visible state-switcher controls (`empty`, `populated`, `permission-denied`) or diagnostic route headers.
- **No Spec-Dump UI Copy:** `lintScrumDoc("ux")` scans visible text and control labels in `mockups/index.html` and rejects leaked internal identifiers (`ADR-\d+`, `FR-\d+`, `NFR-\d+`, `UJ-\d+`, `AD-\d+`), raw HTTP endpoint strings (`GET|POST|PUT|PATCH|DELETE /...`), scoped package names (`@scope/pkg`), and raw `camelCase(...)` / `camelCase = true|false` / `(camelCaseField)` code annotations, unless `DESIGN.md` explicitly declares `ui-copy-allow: technical-identifiers` for a developer-tool product. Requirement traceability belongs in `ux-spec.md`, `EXPERIENCE.md`, or `data-*` attributes.
- **`In-shell contextual state` Rule:** Switching across `empty`, `loading`, `populated`, `error`, `offline`, and `permission-denied` must preserve the screen's app shell (header and navigation) and render state-specific content in context; replacing the entire screen with a shared generic state banner is prohibited.

### 4. Device-Framed `Design overview canvas` & Structured Token Parser

- **Device-Framed Artboard Canvas (`src/scrum/design-studio.ts`):**
  - Default the toolbar viewport mode to `Auto (By Surface)` so `mobile` screens render inside a realistic mobile device bezel (`390×844` with status bar, rounded device frame, and home indicator) and `desktop` screens render inside a browser window frame (`1280×800`), avoiding redundant 1280px frames for mobile-only screens and keeping default multi-screen zoom legible (`~75%–100%`).
  - Connect toolbar `Screen` and `Viewport` selectors directly to both the `Artboard Canvas` (filtering and auto-fitting the selected screen or viewport) and the `Interactive Inspect` view.
  - Lock `pointer-events: none` on artboard iframes by default on the overview canvas so direct mouse drag and wheel/trackpad gestures pan and zoom the board without iframe scroll capture; provide a per-artboard `Interact` toggle and `Inspect & Pin` shortcut, plus a persistent right-hand Review & Decision drawer accessible from any workspace tab.
- **Deterministic Post-Load State Sync (`src/scrum/preview-bridge.ts`):**
  - Dispatch `{ type: "scrum:set-state", screen, state, viewport }` after DOM readiness in addition to setting `document.documentElement.dataset` so every artboard deterministically renders its assigned screen and state.
- **Structured `DESIGN.md` Token Extraction (`src/scrum/design-contract.ts`):**
  - Parse YAML frontmatter (`colors`, `typography`, `rounded`, `spacing`, `components`) and structured Markdown token definitions in `designTokens()` instead of matching arbitrary prose lines by substring regex.
