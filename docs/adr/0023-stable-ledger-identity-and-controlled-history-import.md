# ADR 0023 — Stable Ledger identity, immutable local sequences and controlled history import

- **Status:** Accepted — 2026-10-23, `grill-with-docs` Q7–Q9; the Owner chose all recommendations.
- **Preserves:** ADR 0003's recovery law, ADR 0004's single writer, ADR 0020's history/interface compatibility and ADR 0021's deferred import admission.
- **Supersedes:** ADR 0014's chronological re-indexing of an existing local Ledger during reconciliation. Other Vault transport, hydration and collection behavior is retained.

Ledger sequences already escape into evidence, Retro documents, queued requests, cached replies and daemon idempotency keys. Renumbering existing local events invalidates those references even when an import waits for idle. Events and Contract epochs therefore receive stable identities preserved across export/import, while existing local sequence assignments remain unchanged. Attempt numbers are interpreted within a Contract epoch.

Incoming history retains source provenance and resolves references through an explicit source-to-local mapping. Public numeric fields remain usable. Snapshot holder and original writer are different facts; legacy migration records only provenance it can establish. It preserves historical attribution without inferring an authenticated role from an old `accepted_by` string.

An import validates identity, reference targets, lifecycle order, projected Task state and local filesystem bindings before admission. Proven duplicate history is a no-op. The same identity with contradictory content, divergent Task/Attempt histories, unresolved evidence or ambiguous legacy provenance is retained with its original snapshot and staged for Owner resolution. Timestamp and input order do not choose a winning Verdict or acceptance. Imported Acceptance alone does not establish a local landing.

Persistent upgrades use an explicit controlled step, with a read-only preflight/dry run, durable byte-preserving backup, mapping/version manifest, validation and restart-safe progress. They do not run implicitly at daemon boot. Trial verification precedes any rollout elsewhere; production deployment is outside this effort. Migration preserves ambiguous original history and reports it rather than guessing a repair or dropping records.

This accepts schema/migration support and delayed conflict resolution in exchange for durable reference meaning. Keeping the old schema and remapping every external citation on each sync was rejected because many references already exist outside the Ledger, including free text and daemon state.
