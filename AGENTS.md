# paseo-factory

Research and build repo for `paseo-factory` — a thin verification core delivered as a Paseo plugin.

## Runtime & release

- **Desktop-first runtime**: Live projects run on Paseo Desktop (`~/.paseo` locally, or `ssh andrews-mac-mini` at `~/.paseo-factory` for remote Mac Mini runs) so the Owner has UI visibility into models, errors, and stuck seats. Do not run or test tasks on the local headless trial daemon (`~/.paseo-factory`) unless explicitly asked (`docs/runbooks/live-run.md`).
- **Web Console (ADR 0051)**: The standalone Factory `Web Console` is served by the plugin's localhost `Console sidecar` against the same prod home `~/.paseo`, alongside Paseo Desktop. Its bundle is a committed generated artifact inside `plugin/` and ships only through the release law below — never hot-patched or hand-copied into a live plugin dir.
- **Release before loading — never hot-patch**: Ship every code change through `npm run version:bump -- <x.y.z>`, `npm run check`, commit + tag + push, and `gh release create` before loading into Paseo. Never copy/rsync files into `~/.paseo/plugins/` or reload a live daemon mid-run, which disrupts active sessions.
- **Shell PATH**: `paseo` sits at `~/.local/bin/paseo`; node comes from nvm (`~/.nvm/versions/node/`, default v24) — non-interactive shells export PATH first.
- **Client UI (`plugin/client/`)**: Built with React Native primitives (`@getpaseo/plugin`), not HTML/CSS DOM — skip `modern-web-guidance` for `plugin/client/` edits.
- **Peer verification slice**: Peers never run bare `npm test`, `npm run check`, or `node --test "test/*.test.ts"` inside the Peer shell (inherited `PASEO_FACTORY_*` self-hosting env and live daemon load cause false failures and 600s spool hangs); iterate with targeted fast slice checks (`npm run sync:plugin-core:check && npm run generate:policies:check && npm run typecheck && npm run test:web && npm run build:web:check && node --test "test/console-*.test.ts"`) and let `agent_claim` run the cumulative Gate.
- **Wave sizing**: Cap UI waves at one screen per wave with read and write split into separate waves and E2E test hooks named up front.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature-slug>/` (not GitHub Issues). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), recorded as `Status:` lines in issue files. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.
