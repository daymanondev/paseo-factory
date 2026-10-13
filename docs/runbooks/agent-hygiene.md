# Runbook — post-run hygiene: idle agents and the workspace

The close-out step of the live run (live-run.md, step 9) ends at landing:
the Owner's accept, the PR, the branch deleted. What it deliberately does not
cover is what the run leaves behind — the spawned agents sitting idle on the
trial daemon, and the workspace tree they worked in. This file is that
checklist, the operator's tail to the ritual. Primary sources: live-run.md
(the ritual and its close-out step), CONTEXT.md (Ledger, Acceptance, the
Supervisor seat) and AGENTS.md (the trial-home law). Nothing here is a
factory act; every command is paseo-side against the daemon.

## Idle agents after a run

- Standing law first (AGENTS.md, live-run.md): every `paseo` / `factory`
  command targets the trial home `~/.paseo-factory`. The default `~/.paseo`
  is PROD — never touch it from a run. The hygiene commands are the exact
  place this law earns its keep: they run after the run, by hand, outside
  the driver's environment, and the CLI's `--home` default is `~/.paseo` —
  a bare `paseo agent ls` answers against prod without a word of complaint.
  Type the `--home` every time.
- Close-out before cleanup. A run's agents are retired only after live-run
  step 9 is done: findings written into the ticket, the accept ledgered,
  the PR merged and the branch deleted (ADR 0001). Until then the agents are
  the run's witnesses — the Ledger keeps the verdicts and reports, but
  `paseo agent logs <id> --home ~/.paseo-factory` reads the daemon-side
  timeline, and that timeline dies with the agent. Read what you still need
  from it before it goes.
- Take stock: `paseo agent ls --home ~/.paseo-factory` (archived agents are
  excluded by default, so the list shows the live residue only). A run
  should end with every agent idle; if one is still running, read the
  ledger tail and the driver's verdict lines (live-run steps 4 and 7)
  before doing anything to it. `paseo agent wait <id> --home
  ~/.paseo-factory` blocks until idle; `paseo agent stop <id>` interrupts a
  running agent and is a no-op on an idle one — an interrupt under an open
  gate is a red you authored, not the agent.
- The workspace is not the agent. Deleting an agent cleans nothing in the
  git tree: check the workspace separately — `git status --porcelain` empty,
  back on main, the task branch gone after merge (ADR 0001). A workspace
  left dirty at close-out is a finding for the ticket, not something to
  delete around.
- The Supervisor seat is not residue. It survives runs by design (ADR 0006)
  — it is the one seat the Owner converses with, woken by the Owner's
  message — and it is retired only by revocation (below), never by routine
  post-run cleanup.

## Delete or archive

Two verbs, and the difference is whether you may need to address the agent
again:

- `paseo agent delete <id> --home ~/.paseo-factory` — interrupt if running,
  then hard-delete. For the task agents of an accepted, landed run: the
  factory's record of them already lives in the Ledger (append-only — lines
  are never edited or removed) and in the Reports generated from it, so the
  hard-delete costs nothing the run needs back.
- `paseo agent archive <id> --home ~/.paseo-factory` — soft-delete: the
  agent leaves the default `agent ls` listing but stays on the daemon,
  addressable. For anything still live: a task under an open Contract (a
  needs-human end is not a close — only Acceptance closes a Task, and the
  Owner's answer wakes it through the ordinary spawn path, live-run step 9),
  and the Supervisor revocation, whose verb that same step fixes: cancel
  the turn, archive the agent, stop typing — no ledger line, no
  factory-side state exists to clear (ADR 0006). A new Supervisor is a new
  agent under the same convention.
- Neither verb writes a ledger line or clears factory state — accept is a
  factory act, these are daemon acts. Keep the strata straight: finish the
  Contract's business at close-out (live-run step 9), then retire the
  agents.
- And once more, because it is the one irreversible mistake available here:
  these commands without `--home` aim at `~/.paseo`, which is prod — never
  touch it from a run.
