# ADR 0025 — Project-centered Header, Kanban Tasks board, and dedicated Vault tab

- **Status:** Accepted — 2026-10-23, `grill-with-docs` Q3–Q5; the Owner chose all recommendations.
- **Amends:** [ADR 0009](0009-factory-surface-and-lane-config.md) §2 (Factory surface Header and Tasks view) and [ADR 0014](0014-private-vault-hydration-and-release-lab-companion.md) §1 (Private vault placement).

The persistent Factory surface Header is simplified around a prominent **Project Switcher** showing the active Project, seat status and open actions, missing-folder warnings, and Project reset and delete controls. Adding a Project synchronizes with Paseo's workspace registry and uses a native macOS folder picker (with recent workspace suggestions and greenfield Git bootstrap) instead of requiring manual path entry.

The five KPI stat tiles and the full-width Private vault bar are removed from the Header so they no longer crowd the navigation bar:
- **Tasks** becomes a horizontal five-column Kanban board (`Queued`, `In Progress`, `Needs Attention`, `Ready to Accept`, `Accepted`) with per-column counts, compact scannable cards, direct acceptance actions on ready cards, and a detail drawer/modal on selection. Redundant workspace-path grouping is omitted when a Project is selected.
- **Vault** becomes a dedicated fifth tab on the Factory surface (alongside the Settings screen), giving GitHub onboarding, bidirectional sync, and key management a full view without competing with the tab bar.
