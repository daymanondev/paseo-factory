# ADR 0022 — Generate standalone assets from checked policy sources

- **Status:** Accepted — 2026-10-23, `grill-with-docs` Q6; the Owner chose the recommendation.
- **Preserves:** ADR 0004 and ADR 0016's standalone installed entrypoints and the daemon compiler boundary.

The review found scope matching, worktree inclusion, Ledger reading and subprocess behavior diverging between independently maintained implementations. Shared policy is maintained in one checked canonical source and bundled into the standalone runtime assets that need it. Generated outputs are committed and checked for drift; source changes regenerate them rather than patching the generated files by hand.

Generation runs during development/release, not installation. Installing the plugin from Git requires neither a build nor new runtime dependencies, and the installed MCP bridge remains self-contained. The existing canonical core and its plugin copy retain their packaging roles; this decision addresses handwritten policy divergence rather than removing intentional distribution copies.

The alternative of installing a graph of shared runtime modules would reduce bundled copies but change the standalone bridge's distribution contract. Checked generated assets preserve that contract at the cost of a reproducible generator and an additional drift check. Behavioral conformance tests remain necessary because matching generated files alone does not establish correct policy.
