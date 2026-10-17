# paseo-factory

Research and build repo for `paseo-factory` — a thin verification core delivered as a Paseo plugin.

## Trial daemon

All paseo/factory runtime work targets the trial home `~/.paseo-factory` (never
the default `~/.paseo` — that is prod). `paseo` sits at `~/.local/bin/paseo`;
node comes from nvm (`~/.nvm/versions/node/`, default v24) — non-interactive
shells export PATH first. Live runs follow `docs/runbooks/live-run.md`.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature-slug>/` (not GitHub Issues). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), recorded as `Status:` lines in issue files. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.
