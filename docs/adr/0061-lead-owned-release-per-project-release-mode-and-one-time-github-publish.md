# 0061 — Lead-Owned Release, Per-Project Release Mode, and One-Time GitHub Publish

- **Date:** 2026-11-18
- **Status:** Accepted — implemented in `v0.14.0` (ratified by the Owner over `/grill-with-docs` rounds 1–4, with two Owner amendments: per-Project Release branch + `auto` mode; visibility chosen only at first publish).
- **Grounded in:** `hoangnb24/codex-room-setup` (`8025d15`, `overlays/lead.config.toml:104-106`, `overlays/supervisor.config.toml:29`) · `cuongntr/paseo-room` (`v0.19.0`, `src/room/prompts/contract/shared-authority.md:3-8`, `AGENTS.md` "Releasing") · `plugin/bin/exec-shim.mjs:221-243` · `plugin/bin/git-refusals.mjs:85-155` · `src/choke.ts:498-532,842-881` · `plugin/server/spool.ts:1061-1098,1651-1707` · `src/vault-transport.ts:36-74` · `src/workspace.ts:402-450` · `docs/runbooks/live-run.md` (Delegation convention) · GitHub API (`daymanondev/paseo-factory` `main`: `protected: false`, 0 rulesets).
- **Amends:** ADR 0001 (`main` is not branch-protected in practice; release pushes land on it directly) · ADR 0006 §Never (landing/push leaves the "human-delegate path" for a Lead-owned, Owner-moded mechanism; Supervisor still never pushes) · ADR 0016 §3 Layer 3 (the `gh release` PATH-shim refusal becomes the cross-layer `release-fence`).

## Context

No seat could release. Canonical SLP (Codex Room, Paseo Room) makes the Human own the *decision* on external effects ("Human owns … external effects, and irreversible risk decisions"), while the Lead *executes* once authority is granted, and forbids re-asking settled permission ("Do not ask again for settled permission"; "Do not invent approval gates"). `paseo-factory` instead hardened that boundary into fences with no grant channel: `gh release` refused for every seat, Lead unable to commit product files, and "never pushes externally" written into `Accepted` and `Supervisor`. Every release therefore fell back to the Owner hand-running `git tag` / `git push` / `gh release create` — or to an outside operator under the runbook's "bạn làm đi" delegation (how `v0.12.x`–`v0.13.0` shipped). Permission had become labour.

Research also showed the fence was weaker than its prose: Lead, Supervisor and Peers could already `git tag` and non-force `git push`; `gh release` was refused only through the PATH shim (an absolute `gh` path passed); and `<stateDir>/spool/**` was writable by seats, so an Owner- or Lead-stamped Spool request could be forged.

## Decision

1. **Release is one Lead-only typed act run by the plugin server.** `lead_release({ version })` routes through the Spool to the plugin server (never `bridge.mjs`, which inherits the seat's shims and `PASEO_FACTORY_SEAT`), resolving `git`/`gh` with `buildVaultPath` / the `VaultRunner` so Finder-launched daemons still find them. Steps, each idempotent on re-run:
   1. Preconditions: Release mode permits (Decision 3); `origin` exists; `<project-root>` clean; `HEAD` is the last `Accepted` landing or descends from it only through seat-memory paths (`head-not-accepted`); `CHANGELOG.md`, if present, has `## [x.y.z]`; no wave is mid-Gate.
   2. Annotated tag `vX.Y.Z` on `HEAD` (Factory identity fallback as in `landCleanly`). Existing tag on the same commit → skip; on another commit → `tag-conflict`.
   3. Push `HEAD:refs/heads/<Release branch>` fast-forward only (`release-not-fast-forward`, `push-rejected`), then push the tag.
   4. `gh release create vX.Y.Z --title vX.Y.Z --notes <changelog section>` (or `--generate-notes` without a changelog); an existing release → skip.
   Ledger gains two Project-level (task-less) events: `release_published` and `release_failed` (with the failing step). The tool never edits files or re-runs checks: the version bump and changelog land first as an ordinary `engineer` wave whose Gate is the Project's check; a Project with neither manifest nor changelog skips that wave.
2. **Release covers git + GitHub only.** Package registries and stores stay with each Project's CI (triggered by the tag/Release) and `factory-release-lab`; loading a new plugin build into Paseo stays the Owner's.
3. **Release mode and Release branch are Owner-only per-Project settings** in `projects/<slug>/project-settings.json` (seat-unwritable), changed only through the Factory panel's surface RPC (seats refused `seat-cannot-grant`; no CLI verb, no Spool kind).
   - `off` (default): `lead_release` refuses `release-not-granted`.
   - `on-request`: `supervisor_dispatch_lead` takes optional `release: { version? }`; the server records one pending **Release request** per Project. `lead_release` refuses `no-release-intent` without it and `version-mismatch` against a pinned version; success consumes it. Without a pinned version Lead picks semver from `## [Unreleased]` (Added/Changed → minor, Fixed-only → patch) and states why in the prep brief.
   - `auto`: before reporting a directive complete, if accepted waves since the last tag touched non-seat-memory paths, Lead contracts the prep wave, accepts it, and releases — at most once per directive, never a major bump (incl. `0.x → 1.0`), which Lead proposes instead; `nothing-to-release` otherwise.
   - **Release branch** defaults to the GitHub default branch (`defaultBranchRef`), else the checked-out branch; the local branch name is irrelevant.
   - A pending Release request is dropped by Rotate seats, Project reset, and switching the mode away from `on-request`; settings themselves survive Rotate and reset (as `project-settings.json` does).
4. **One-time GitHub publish; visibility is never changed by the Factory.** A Project without `origin` shows **Publish to GitHub** in the Project panel's "GitHub & Release" card: account/org (`gh api user` + `user/orgs`), name (folder basename), description, **Private** (default) or Public → `gh repo create <owner>/<name> --private|--public --source=<root> --remote=origin --push`. Public requires typing the repo name and passing a tracked-file check (`.env*`, `*.pem`, `*.p8`, `*.keystore`, `id_rsa*`, `google-services.json`, `GoogleService-Info.plist`; override allowed; history is stated as unscanned). An unauthenticated `gh` shows the Vault's 2-step login guide. Afterwards the card shows `owner/name` and its visibility read-only; there is no make-public/make-private control. Publish is Owner-only and not a Ledger event (like Rotate seats).
5. **`release-fence`: the typed act is the only path.** For every seat (Supervisor, Lead, Peer), both the ask-time Choke judge and the `<stateDir>/bin` shims refuse any `git push`, tag creation/deletion (`git tag <name>`, `-a`, `-s`, `-d`; listing stays allowed), and any `gh release`, `gh repo create`, `gh repo edit` — on every spelling, absolute paths included. `<stateDir>/spool/**` joins the protected state paths so seats cannot forge Spool requests by shell or file write (the bridge process still writes it). Operators outside the Factory and server-side Vault pushes are unaffected.
6. **Roles.** Supervisor relays release intent and results and points the Owner to the panel for publishing; it never releases or publishes. Peers never touch external effects. Lead owns Release as part of integration, within the Owner's Release mode.

## Considered Options

- **CI-only release** (tag/Release created by a workflow on a version change): still needs a seat or Owner to push `main`, and is per-repo setup; left to Projects as an optional complement.
- **Owner one-click Release button** (Rotate-seats style): keeps the Owner in every release — the labour this ADR removes.
- **Operator delegation** ("bạn làm đi"): works but sits outside SLP and needs the Owner every time.
- **Factory-managed visibility changes**: rejected by the Owner; making a repo public is effectively irreversible, and "the Owner said so" is not mechanically verifiable for seats.

## Consequences

- `CONTEXT.md` gains **Release**, **Release mode**, **Release branch**, **Release request**, and **GitHub publish**; **Seat write fence** gains `release-fence`; `AGENTS.md` "Release before loading" changes from a hand recipe to "Lead releases via `lead_release` when Release mode allows; loading stays the Owner's".
- `paseo-factory`'s own repo can run `on-request` or `auto` and stop needing the Owner or an operator for tag/push/`gh release`.
- "Never pushes externally" becomes mechanically true for seats, which may surprise any Project whose Gate pushed; such a Gate now fails closed.
- Ledger validation, migration, and import special-case two new task-less events; generated `.mjs` mirrors and pinned tool-list tests (`bridge-mcp`, `preflight`, `roles`) change.
- Supervisor's release intent remains as unverifiable as its "accept on the Owner's word"; Release mode bounds the blast radius.
