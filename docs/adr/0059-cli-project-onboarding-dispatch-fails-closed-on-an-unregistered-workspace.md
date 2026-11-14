# 0059 — CLI Project Onboarding: Dispatch Fails Closed on an Unregistered Workspace

- **Date:** 2026-11-14
- **Status:** Accepted. The Owner approved the spec; implemented on `spec/factory-cli-project-onboarding`, ships in the next release.
- **Amends:** [ADR 0057](0057-every-seat-replacement-is-a-handoff-supervisor-handoff-and-wide-colourful-factory-tab.md) Decision 5, for one case. `factory supervisor dispatch --workspace <dir>` aimed at a folder that is not a registered Project is no longer held as mail by default.
- **Spec:** `.scratch/factory-cli-project-onboarding/spec.md`.

## Context

`/factory` from an arbitrary chat worked only when the current folder was already a registered Project. Otherwise:

1. A non-Git folder was refused with a bare `unknown-project` and no next step.
2. A Git repository that was never registered got exit 0 and "directive held for Supervisor". No Supervisor exists for that slug and nothing creates one (ADR 0057 Decision 5), so the directive sat unread in a per-slug mailbox. This is a fake success.
3. The hand-copied `/factory` skill baked in one install's checkout UUID. After a plugin update, or on another machine, the path was gone.

The CLI also had no way to list registered Projects or to register one. Registration happened only implicitly on the seat and surface path.

## Decision

1. **Dispatch fails closed.** A `supervisor dispatch --workspace <dir>` from a non-seat shell exits 2 before anything is queued when `<dir>`:
   - resolves to no Git repository (`unknown-project`), or
   - resolves to a Project that holds no registration in the home (`unregistered-project`).

   Both refusals name the exact next commands: `factory project register --workspace "<root>"` and `factory project list`. They are local and prompt-free, so they work while the plugin is down. Seat-stamped shells (a Supervisor dispatching to its Lead) and `--project <slug>` dispatches are never guarded.
2. **`--allow-unregistered` is the escape hatch.** It restores the held dispatch (ADR 0057 Decision 5): the directive waits for the next Supervisor. The held reply now carries the exact seat-opening step: New Chat → `Supervisor (Factory)` at the Project root. The skill passes the flag only when the Owner explicitly asks.
3. **Three Project verbs.**
   - `factory project list [--json]` and `factory doctor [--workspace <dir>] [--door <path>] [--json]` are local reads. They never write and never need the plugin. A registration is well-formed when `project.json` parses to an object with a non-empty string `root`; one rule, in `plugin/bin/project-read.mjs`, serves every CLI read.
   - `factory project register [--workspace <dir>] [--json]` is Spool-mediated, so the plugin stays the single writer (ADR 0004). The new `project_register` kind reuses the surface path's registration writer: a non-Git folder gets `git init` and an empty commit first (ADR 0024; `$HOME` and `/` refused), and an existing registration is reported, never rewritten.
   - Registering is an Owner-only act: a stamped seat is refused `seat-cannot-register` by the CLI, the Spool and the surface handler alike.
4. **Register is serialized with Project delete and reset.** A register runs under exclusive maintenance. An already-registered folder takes the lane of its own Project, the lane a delete or reset of it holds. A first-time register has nothing to race, so it takes the root Factory's lane; it may `git init` and it writes the registry, which is why it is exclusive there too. The register never falls back to a guessed Project.
5. **The skill gates on a registered Project, then dispatches first.** From a normal chat it runs `doctor --json`, and when the folder is unregistered puts one structured choice to the Owner: register here, pick an existing Project, or abort. It never registers silently and keeps no "last used" Project; routing is explicit per invocation. The optional lane-profile apply-or-skip comes after the dispatch, never before it.
6. **The skill is plugin-managed in three harness roots.** The boot reconcile now covers `~/.pi/agent/skills` (ADR 0036) next to `~/.agents/skills` and `~/.claude/skills`. Each root is rendered from the one source with the active install's CLI door; drift and stale copies revert on the next boot.
7. **Small CLI conventions.**
   - `--home` is the existing precedence: `--home` > `$PASEO_HOME` > `~/.paseo`. Every recovery command the CLI prints repeats it, quoted.
   - `project register` reports a silent plugin after 30 s rather than 60 s. It withdraws its queued request, and it says the registration may still have landed and to confirm with `project list`.
   - `doctor` exits 2 only for a stale recorded plugin install, or a stale `--door` the caller supplied.

## Consequences

- A directive aimed at an unregistered folder now fails loudly at the CLI instead of vanishing into a mailbox no Supervisor reads. Any live workflow that relied on the held dispatch needs `--allow-unregistered`; the release notes carry one line on this.
- The Project registry gains one more writer entry point (`project_register`), but the writer is the existing one, so CLI and seat-path onboarding cannot diverge.
- The skill's pre-flight is prose an agent follows, not a hard gate. A deterministic input-gate extension remains a possible follow-up.
- `--workspace` stays the flag name even though the Owner thinks in Projects, and the doctor JSON still says `workspace` and `cli`. Renaming would break the existing CLI convention, and CONTEXT.md notes the distinction.
