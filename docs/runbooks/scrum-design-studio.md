# Scrum design review studio

Scrum UX submits committed `DESIGN.md`, `EXPERIENCE.md`, `impeccable.local.md`, `mockups/index.html`, PNG captures and `mockups/browser.json`. Each `## Screen: kebab-case-id` section documents empty, loading, populated, error, offline and permission-denied behavior. The mockup reads `?screen=&state=`, updates root `data-screen`/`data-state`, and listens for `scrum:set-state` messages. The UX document linter checks this structural contract; browser evidence proves keyboard and visual verification.

For each screen, capture Desktop at least 1280×800 and Mobile at most 430px wide, 640–844px tall (390×844 recommended). Put each screenshot path and SHA-256 in `viewports[]`, with its `screen`. Include six passing keyboard checks per screen, disabled networking, no console/page errors, and an `impeccable` detector summary with zero non-advisory findings and both viewports checked. Screenshot PNGs must be included in the submitted design refs. Single-screen historical reports without screen declarations retain their old viewport/N/A compatibility, but still require real PNGs in the design refs.

## Upstream Impeccable

Install the complete upstream Impeccable >=4.8.0 pack and engine using its installer (`npx impeccable install --scope=global`; use upstream update for upgrades). Factory discovers complete `impeccable*` skill directories under `.agents`, `.claude`, `.gemini`, `.pi`, `.codex` and `.opencode` in the operator home, and links those directories into isolated UX/Dev/QA homes. It does not fork or truncate the upstream references/scripts. Missing installations are reported to the specialist through the role prompt and scanner diagnostics; do not fabricate a clean detector report.

The Pi `tool_result` extension filters UI writes (`html/css/scss/jsx/tsx/vue/svelte/astro`) before invoking the upstream `impeccable hook` scanner. A native `PostToolUse` manifest is also emitted in the isolated home. `impeccable live` remains available for interactive design sessions; it is not the per-edit scanner. This follows upstream's [hook emitter](https://github.com/pbakaus/impeccable/blob/main/scripts/lib/transformers/hooks.js) and [live protocol](https://github.com/pbakaus/impeccable/blob/main/skill/reference/live.md). The default Pi runtime consumes the extension; other providers must consume the emitted native manifest through their supported hook configuration. Factory never modifies the operator's global hook configuration.

Keep initiative `DESIGN.md` and `impeccable.local.md` synchronized before craft/detect. UX owns that context; Dev/QA consume the accepted version. Planning and orchestration homes exclude these UI skills/hooks. The PATH wrapper permits Impeccable for UX/Dev/QA and refuses it for other Scrum roles.

## Owner workflow

Use the scaled Paseo modal for quick Desktop/Tablet/Mobile inspection, screen/state switching and verified capture thumbnails. **Open Full Design Studio ↗** launches the token-bound loopback studio for all artboards, design tokens, and DOM-pinned feedback. Space+drag pans, Ctrl/Command+wheel zooms, and Fit all restores the overview. Static captures show the submitted evidence; live frames show the selected state.

In Inspect, choose screen/viewport/state, enable Pin Comment, click an element, and add a note. Record each screen as Approved or Revise, then provide a rationale and submit Approve Design, Request Changes or Waive Gate. Decisions pin the design revision/digest and the run revision. A stale tab must be reopened. Loopback sessions expire after 15 minutes. Every route requires the session token; POST additionally requires same-origin proof. Mockup frames have opaque sandbox origins and no network access. Only pinned git artifacts can be served.

Studio decisions use the same surface writer and Lead notification path as Paseo decisions. Paseo reloads when focused or through its normal poll. Lead revision briefs include structured findings and screen statuses, preserving approved screens. Accepted UX Tasks remain closed; revision work uses new Task IDs.

## Implementation and QA gates

UI Dev Contracts append `lint-scrum-doc --kind ui --dir .scratch/<initiative>/qa/<task>` to the requested Gate and reserve that evidence directory. Record `browser.json` there using the same multi-screen/state/detector schema; PNG paths are Project-relative. The CLI reads the initiative's `EXPERIENCE.md` and verifies screenshot hashes against the clean claimed tree.

The authoritative QA JSON includes `browserEvidence` with that schema, plus its existing four-lens audit, execution logs and readable `qa/<task>.md`. Controller submission and completion verify the UI matrix/detector against the accepted design. No static pixel-diff thresholds are imposed on dynamic product data.
