# v0.0.52 validation

Date: 2026-10-28
Implementation revision: `f64e52594fa03ababb4aa66133e229732435c6c3`
Baseline: v0.0.51 (`2e4eda574df60436cecc8930e01d6a9e89f6d068`)

- Unchanged SLP compatibility baseline: 215/215 tests before and after initial implementation.
- `npm run check`: 993/993 on Node 22.22.0 and 24.21.0, including TypeScript, recursive core parity, generated-policy parity, packaging and Hermes client syntax checks.
- `npm run check:installed`: 58/58.
- Independent Standards and Spec reviews: zero outstanding findings after corrections.

Integration tests exercise mixed SLP/Scrum identity, all seven provider families,
frozen rosters, managed-worktree parallel UX/Architect delivery, semantic
contradictions, exact design digests and approval replay, QA bundle promotion,
finite fix rounds, cancellation/Contract recovery, Vault isolation and scoped
reset/delete. An actual plugin-entry fixture verifies a completion created after
boot reaches Supervisor exactly once while held Scrum and SLP mail stays queued.

All live runtime work targeted the trial home `~/.paseo-factory`.

- Native SLP Task `live52-slp`: GREEN attempt 1, accepted and landed `373b50f`.
- Scrum `live52-ui`: readiness contradiction refused, Owner requested changes,
  new UX revision landed, stale approval refused, current design approved.
- Chrome offline checks: all six states activated by keyboard; 1280×800 and
  375×812 screenshots; no console errors or horizontal overflow.
- Native Scrum Dev: frozen `opencode/opencode/beam-free` model and isolated
  run/Task/epoch harness, GREEN attempt 1, landed `842676e`.
- QA a1: baseline GREEN, candidate RED reproducing an incorrect sum; artifact
  Task GREEN, landed `f4008c1` with a confirmed product defect.
- New Dev fix Task promoted the exact original test bytes into the active suite
  and fixed the sum, landed `8dfda75`.
- New QA a2: two isolated first-attempt runs, 2/2 each with no skipped or expected
  failures; landed `055f06e`. The run completed with one fix round and a durable
  Supervisor report receipt.

Planning, QA and the final fix used operator-driven fixture Tasks through the
real spool, Gate, managed worktree, acceptance and landing protocol. SLP and
Scrum Dev used native model Agents. The trial does not claim a wholly autonomous
specialist initiative. Parallel design is verified by the managed-worktree
integration test; live browser planning Tasks ran sequentially.
