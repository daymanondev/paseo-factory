# ADR 0021 — Stage Ledger imports and apply them through the live writer

- **Status:** Accepted — 2026-10-23, `grill-with-docs` Q4; the Owner chose the recommendation.
- **Preserves:** ADR 0004's single writer.
- **Amends:** ADR 0014's Ledger reconciliation leg; fetching a snapshot and applying its history are distinct outcomes.

Vault may fetch and stage incoming history while factory work continues. Applying that history belongs to the live Ledger owner, after relevant operations have reached a stable point. A busy factory retains a pending import and reports that state explicitly; it does not terminate running Tasks or report a staged snapshot as already applied.

The import admission point is shared by mutating Spool and surface entrypoints. It coordinates the complete Claim pipeline, acceptance/landing, Retro and other operations that retain Ledger-derived state, and prevents new conflicting mutations during import commit. Ordinary Gates for different Tasks retain their concurrency. CLI requests use the same ownership rule rather than replacing an active Ledger file from another process.

This favors delayed history availability over applying a merge underneath active verification. Waiting for idle does not by itself preserve external sequence references; event identity and migration are separate decisions. Crash recovery must preserve staged input and make a committed import distinguishable from an unapplied one.
