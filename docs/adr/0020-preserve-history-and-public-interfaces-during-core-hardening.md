# ADR 0020 — Preserve history and public interfaces during verification-core hardening

- **Status:** Accepted — 2026-10-23, during `grill-with-docs`; the Owner chose all three recommended answers in the first design round.
- **Preserves:** ADR 0003 (Ledger recovery), ADR 0004 (single writer and standalone submission paths), and ADR 0016 (role-scoped CLI/MCP entrypoints).

The whole-codebase review exposed incorrect verification and acceptance behavior across independently implemented policies. This effort fixes the confirmed defects, consolidates the policies responsible for them, and adds behavioral regression checks and repository CI. Module changes must improve correctness, locality or testability; scope is driven by those problems rather than file length.

Existing factory history is retained. A persistent-format change is permitted when the design requires it, with an explicit migration, a recoverable backup, and validation that history and evidence references survive. Resetting trial history is not the migration strategy. The event-identity scheme, import concurrency rules and migration mechanics remain separate design decisions.

Existing public CLI commands, MCP tool names and request fields remain usable. Internal interfaces and additive fields may change, but callers must not need to rewrite their existing scripts to adopt these fixes. Incorrect behavior is repaired rather than preserved as compatibility. Runtime assets must remain usable within the installed plugin's packaging constraints.

These choices favor incremental repair over a broad rewrite, accepting the cost of compatibility and migration support to retain operational history and existing integrations. The detailed implementation plan belongs in `.scratch/codebase-hardening/spec.md`; unresolved policies there are proposals, not accepted decisions.
