# v0.0.49 implementation validation

Date: 2026-10-26
Spec: `.scratch/factory-v0.0.49/spec.md`
Review base: `544c2db8bb8d40b71167b5bea29b53bc70e99b35`

## Behavior delivered

- Lead contracts default to Gate-only Claims. Lead MCP exposes neither
  `freshEyes` nor `fresh_eyes` and ignores legacy opt-in arguments.
- GREEN Attempts outside Needs-human are Lead-eligible regardless of historical
  Fresh-eyes state. Restart, current Contract epoch, settled acceptance and
  authenticated seat restrictions retain their existing behavior.
- Shared Lead laws require direct commit/stat inspection against the four-part
  brief, followed by acceptance or re-contracting. Role prompts and kickoff
  packets use the same laws.
- Bare headless Pi lanes explicitly pass `--thinking off`; explicit lane thinking
  levels win. Only the headless role home overrides operator thinking defaults.
- Workspace diffs begin with the full change summary and exclude six standard
  package lockfiles from patches. Lockfile-only changes retain their summary;
  identical commits return an empty diff; Git errors remain explicit failures.
- MCP Spool waits default to 600 seconds, including invalid environment overrides.
- Seats & Models displays five active lanes across four cards (Watch and Retro
  share a card). Profile previews hide Fresh-eyes while persistence retains its
  legacy field. Task details retain historical review evidence.

## Compatibility decisions

Explicit core/Owner CLI `freshEyes: true` / `--fresh-eyes` remains supported per
Implementation Decision 1; retirement removes automatic Lead opt-in and acceptance
blocking. Ledger event schemas, historical review projection, Lane config and
Lane profile parsing remain compatible.

Git's literal `:!package-lock.json` exclusion left nested lockfiles in a real
fixture. The implementation uses `:(exclude,glob)**/<lockfile>` derived from
`PACKAGE_LOCKFILES` to exclude root and nested lockfiles. The unfiltered stat
still names those files. This is covered for all six package lockfile names.

## Validation

The implementation used red/green tests at the spec's agreed public seams.
Focused checks passed: lifecycle/MCP/CLI/Spool/history (198 tests), role/UI/diff/Pi
(98 tests), and the final CLI/MCP status/Watch compatibility checks (58 tests).
These groups overlap; their counts are not additive.

The first full check passed 949/951 tests and exposed two stale assertions for
retired CLEAR-only eligibility and Pi's old argv. Both assertions were updated
and their complete test files passed. The final `npm run check` passed on Node
24.21.0: **951/951 tests**, no failures, cancellations or skips (73.7 seconds for
the test suite). Core synchronization, generated policy synchronization,
TypeScript checking and both installed plugin bundles also passed.

## Standards

Independent Standards review found no documented-standard breaches or actionable
baseline smells. Its minor finding about profile dialog six-lane wording was
fixed and rechecked; no findings remain.

## Spec

Independent Spec review found no missing functional requirements, incorrect
implementations or scope creep. Its minor finding about the same profile wording
was fixed and rechecked. The two compatibility assertion updates were also
reviewed; no findings remain.

Review total: Standards 0 remaining; Spec 0 remaining.

## Scope and limits

This validates repository implementation and installed asset/bundle checks.
No live daemon was changed, no project Ledger was edited, and no release or
deployment was performed. Pre-existing edits to `CONTEXT.md` and ADR 0030 were
preserved outside the implementation commit.
