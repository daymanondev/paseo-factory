# 0034 — Scrum Design Overview Canvas, Multi-Screen Routing Protocol, and Full Impeccable Detector Gate

- **Date:** 2026-10-30
- **Status:** Accepted
- **Amends:** ADR 0032, ADR 0033
- **Preserves:** ADR 0001–0033

## Context

In `ADR 0032` and `ADR 0033`, the Scrum UI/UX review checkpoint (`awaiting-ui-approval`) rendered `mockups/index.html` inside Paseo's host `<Modal>` as `<iframe style={{ width: "100%", height: 520 }}>` and required only a single browser screenshot (`report.viewports.length >= 1`) plus boolean flags in `browserEvidence`. Because Paseo's `<Modal>` is a narrow ~480–540px dialog without fullscreen or width props, responsive desktop mockups collapsed into cramped mobile breakpoints inside the popup, and the Owner had no Figma-like multi-screen overview to compare all screens, viewports, states, and `DESIGN.md` tokens side-by-side. Meanwhile, specialist agents (especially fast `Flash`-tier models) lacked a deterministic anti-slop and visual-quality gate to catch `DESIGN.md` token drift, low contrast, text overflow, and generic AI layout tells before requesting Owner review.

## Decision

### 1. Full Upstream `pbakaus/impeccable` Integration (`UX`, `Dev`, `QA`)

- Install the upstream `pbakaus/impeccable` package in full (`npx impeccable install --scope=global`, updated via `npx impeccable update`) rather than maintaining a partial fork, so upstream skill playbooks (`SKILL.md`, `reference/*.md`) and the self-contained Rust/Wasm engine binary (`impeccable`) stay upgradeable in one command.
- Provision `impeccable` strictly for the UI-touching Scrum specialist roles (`ux`, `dev`, `qa` in `SCRUM_ROLE_SKILLS` and `provisionScrumHarness`), leaving `supervisor`, `lead`, `pm`, and `architect` untouched. Even when the `impeccable` design hook is active, it filters strictly by UI file extensions (`.html`, `.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro`, `.css`, `.scss`) and adds zero overhead to non-UI roles.
- Enforce `impeccable detect --json --no-advisory` as a mechanical gate in `verifyBrowserEvidence` (Stage 2/3) and in `Dev`/`QA` UI verification (Stages 4/5) across both Desktop (`1280×800`) and Mobile (`390×844`) viewports: zero non-advisory findings (anti-slop rules, `DESIGN.md` token drift, pixel contrast, text overflow, clipped containers, broken assets) are required before Owner review or QA sign-off. Do not enforce static-comp `comp-diff` SSIM thresholds on dynamic product data in Stages 4/5.

### 2. Multi-Screen & Six-State Routing Protocol (`?screen=<id>&state=<state>`)

- Every screen row in `EXPERIENCE.md` defines a stable `screenId` (`kebab-case`).
- `mockups/index.html` (and any declared screen entries in `mockups/manifest.json`) must honor URL query parameters `?screen=<id>&state=<state>` (reflecting onto `document.documentElement.dataset.screen` and `dataset.state`, and listening for `postMessage({ type: "scrum:set-state", screen, state })`) for all six states (`empty`, `loading`, `populated`, `error`, `offline`, `permission-denied`).
- `verifyBrowserEvidence` requires hash-verified PNG screenshots for **every declared screen** across at least **two standard viewports (`Desktop >= 1280×800` and `Mobile <= 430×844`)** in addition to clean `impeccable detect` results.

### 3. Logical Viewport Scaling in Paseo Modal & Loopback Design Overview Canvas

- **In-Modal Logical Viewport Scaling (`plugin/client/factory/scrum.tsx`):**
  - Replace the raw `width: "100%"` iframe in `MockupApproval` with logical viewport scaling (`designWidth = 1280` for Desktop, `820` for Tablet, `390` for Mobile, scaled via CSS `transform: scale(stageWidth / designWidth)` as in `nexu-io/open-design`'s `PreviewModal.tsx`), paired with a screenshot filmstrip and a 1-click button to launch the full browser studio.
- **Figma-style Design Overview Canvas (`src/scrum/preview-server.ts`):**
  - Rather than bundling the standalone `nexu-io/open-design` Electron/daemon stack, upgrade `servePreview` (`preview.url`) into a self-contained loopback **Design Overview Canvas** (`http://127.0.0.1:<port>/?token=<session-token>`) with three views:
    1. **Artboard Canvas (`Figma Overview`):** Pan/zoom surface rendering all declared screens (`Screen 1..N`) side-by-side as live Desktop (`1280×800`) and Mobile (`390×844`) artboards, with a global state switcher that updates all artboards simultaneously.
    2. **Design System Kit (`DesignKitView`):** Visual rendering of `DESIGN.md` color swatches, typography scale, spacing/radius tokens, and the `EXPERIENCE.md` screen × 6-state matrix.
    3. **Interactive Inspect & Pin Feedback:** Focused screen inspection with `Desktop / Tablet / Mobile` switching, click-to-pin DOM element selector annotations (`findings[]`), and per-screen `Approved` vs. `Revise` status so follow-up `ux-<initiative>-r02` tasks preserve approved screens and modify only flagged screens/elements.
  - Authenticate `POST /api/decision` on the loopback server using the per-run unguessable session token plus `Origin` / `Sec-Fetch-Site: same-origin` validation, writing `design_decided` (with `decision`, `rationale`, and structured `findings[]`) directly through the single writer to unblock `Senior Dev` or trigger a scoped UX revision.

## Consequences

- Owners get both a non-reflowing scaled preview inside Paseo and a full-screen Figma-like multi-artboard overview in the browser without running a second heavy design daemon.
- `Flash`-tier and frontier models alike are held to a deterministic 62-rule visual and design-system floor via `impeccable detect` before Owner review and during QA.
- Per-screen approval and DOM-pinned `findings[]` prevent UX revision tasks (`r02+`) from regressing screens the Owner already approved.
