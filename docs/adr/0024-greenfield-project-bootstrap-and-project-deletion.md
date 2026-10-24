# ADR 0024 — Greenfield Git bootstrap on Project onboarding, missing-root selection, and Project deletion

- **Status:** Accepted — 2026-10-23, `grill-with-docs` Q1–Q2; the Owner chose all recommendations.
- **Amends:** [ADR 0010](0010-project-scoped-slp-worktrees-and-lead-agent.md) (Project identity and discovery), [ADR 0015](0015-enforced-slp-boundaries-bidirectional-mailbox-and-workspace-bound-spawns.md) (Project lifecycle actions), and [ADR 0017](0017-native-paseo-role-providers-and-slp-seat-recognition.md) (Role provider seat recognition).

Starting a Supervisor or Lead seat, or adding a Project through the Factory surface, on an existing non-Git directory (excluding the user home or filesystem root) automatically initializes a Git repository with an initial empty commit before resolving and registering the Project. This lets greenfield workspaces created in Paseo enter the factory immediately with working per-Task worktree isolation. Project discovery also recognizes live Role-provider seats even when legacy seat labels are absent.

When a registered Project's directory is removed on disk, the Project remains selectable in the Factory surface using its persisted registration identity rather than falling back to the all-projects view, and surfaces a missing-folder state.

**Project delete** is introduced alongside **Project reset**. Reset clears verification history while keeping the Project registered and preserving its lane overrides. Delete permanently purges the Project: it terminates and archives bound seats and working Agents, removes temporary worktrees and branches if the repository still exists, purges the Project's Ledger history, reports, gate logs, retro files, correlations, and isolated project state directory in full, and removes the Project's records from Paseo.
