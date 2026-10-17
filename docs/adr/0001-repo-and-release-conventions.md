# ADR 0001 — Repo and release conventions

- **Status:** Accepted — 2026-10-01
- **Context:** `paseo-slp-factory` is a public repo about to receive its first
  product code (the `paseo-factory` Paseo plugin). Conventions must be in place
  before the first commit of that code. Surveyed ecosystem practice
  (`@getpaseo/plugin`, `paseo-*` packages, seatworks) and standard small-product
  practice in `.scratch/factory-v0.0.1/issues/03`.

## Decision

- **Repo name unified as `paseo-factory` (amended 2026-10-17).** Originally
  kept as `paseo-slp-factory`, renamed on GitHub to `paseo-factory` so the
  repository, npm package, and plugin id share one canonical name.
- **Branch model: trunk-based.** Short-lived feature branches → PR into a
  protected `main`; CI must pass to merge; branches deleted after merge.
- **Versioning: semver 0.0.x while private.** `0.1.0` is the first public cut;
  before that, patch = fix, minor (0.x.0) = user-visible change. Every released
  version gets a `v{version}` git tag and a GitHub Release.
- **CHANGELOG.md** in Keep a Changelog format, maintained per version; GitHub
  Release notes come from the same entries.
- **License: MIT.**
- **CI from day one:** typecheck + test (+ build once it exists) on push and PR.
- Register the npm name `paseo-factory` before the 0.1.0 publish.

## Consequences

- All public artifacts (commits, README, CHANGELOG, ADRs) are in English.
- The GitHub repo, npm package, and Paseo plugin id all share the single name `paseo-factory`.
