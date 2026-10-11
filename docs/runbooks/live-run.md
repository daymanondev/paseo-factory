# Runbook — live run: one task through the factory

The ritual as it has actually run three times — ticket 09 (v0.0.1,
`.scratch/factory-v0.0.1/issues/09-live-run.md`), ticket 06 (v0.0.2,
`.scratch/factory-v0.0.2/issues/06-live-run-2.md`) and ticket 03 (v0.0.4,
`.scratch/factory-v0.0.4/issues/03-live-measurements.md`); those run logs are
the primary sources, this file is the operator's checklist. Follow it top to
bottom. The baseline in step 2 is a step, not a virtue: skipping it makes a
later red unattributable (ticket 09's attempt 1 went red for an environment
reason, and only the green baseline made that legible).

Since v0.0.5 the middle of the ritual is driven: `factory run` (step 4) owns
the branch, the spawn and the watching-to-verdict for contracted tasks — what
the operator still does by hand is preflight, baseline, contract and
close-out. The manual `paseo run --background` ritual of 09 / 06 / 03 stays
in this file as the documented fallback (step 5), and for a non-contract
agent it remains the only path.

## Standing rules

- Every `paseo` / `factory` command targets the trial home `~/.paseo-factory`.
  The default `~/.paseo` is PROD — never touch it from a run.
- Non-interactive shells start without `~/.local/bin` (paseo) and without nvm
  (node) on PATH. Export first (adjust when the nvm default moves — it is
  v24.21.0 as of 2026-10-08):

      export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"

- One ledger writer: the plugin. The CLIs submit through the spool; nobody
  edits `ledger.jsonl` by hand (ADR 0004).
- Accept and landing are Owner acts (ADR 0002; delegation per ADR 0006, which
  supersedes 0005) — accept is delegable to the Supervisor seat, landing never
  is. Step 9 records the delegation convention.

## 1. Preflight

- Daemon alive: `paseo status --home ~/.paseo-factory`.
- Plugin loaded: `paseo plugin ls --home ~/.paseo-factory` lists `paseo-factory`.
- Agent provider available: `paseo provider ls --home ~/.paseo-factory`
  (09 ran `claude` opus-4-8 at ~$4.07 / 26 min; 06 ran `claude` sonnet-5 at
  ~$1.02 / 6 min on a similar-size task — the Agent's model is a real cost
  dial, and the eye does not care who wrote the diff).
- When the run measures the eye:
  `~/.paseo-factory/plugin-state/paseo-factory/eye.json` exists and is mode
  600. Credentials are placed by the human before the run, never from inside
  it.
- When the run measures the watch (v0.0.6, amendment 2): the copilot CLI is
  usable on the daemon's PATH (`copilot --version` answers) — the watch
  prompts it headless with the model pinned in code (`gpt-5.4`); there is no
  key file. The CLI's own auth is the whole credential surface; the wrapper
  at `/opt/homebrew/bin/copilot` execs the nvm node for the daemon
  environment.

## 2. Baseline — mandatory, before the agent exists

On main, in the task's workspace: `npm test` and `npm run typecheck`, both
green; record the counts in the ticket (06 recorded "baseline 100/100
confirmed on main"). A gate verdict is only meaningful against a known-green
baseline — this step is what keeps a red from being misattributed to the
working agent.

## 3. Contract — the Owner CLI, set before the agent starts

    node plugin/bin/factory.mjs --home ~/.paseo-factory contract \
      --task live<NN>-<slug> \
      --workspace /absolute/path/to/workspace \
      --gate "<absolute-node> --test \"test/*.test.ts\"" \
      --artifact <workspace-relative path> \
      [--scope plugin/bin,test] \
      [--fresh-eyes] [--watch] \
      [--description "<the task's assignment, in the Owner's words>"]

- The gate runs under the daemon's env, which has no nvm — resolve node
  absolutely when the contract is set (`$(which node)`), or the suite dies at
  exit 127 inside the gate (ticket 09, attempt 1). The same law applies to
  anything else the gated suite resolves from PATH. Contract authoring law
  since v0.0.8 (ratified R6): the gate command pins its executables
  absolutely, never a bare PATH-resolved invocation — a runner-setup failure
  must never wear a work-quality verdict.
- `--scope` (first live use in ticket 06): workspace-relative prefixes the
  diff may touch; anything outside goes red. Keep it tight — it is the
  mechanical refusal lane. Note: the drift guard between `src/` and
  `plugin/server/core/` means a task not about that sync should scope away
  from the copy it does not touch. At two or more tasks in one `factory run`
  (step 4) the scope is mandatory — the plugin refuses an unscoped spawn with
  one `spawn_refused` ledger line.
- `--fresh-eyes` only when the run means to measure the eye (it needs
  `eye.json`, checked in step 1).
- `--watch` (v0.0.6) only when the run means to measure the watch (it needs
  the copilot CLI, checked in step 1). The pass is record-only: one
  `watch_written` ledger line after EVERY verdict — red included — and a
  Watch line in the report; verdicts, accepts and driver exits never read it.
- `--description` (v0.0.6) carries the task's assignment; the driver's brief
  hands it to the agent verbatim. This retires the v0.0.5 TASK.md seed
  workaround — no seeded assignment commit, nothing to drop at landing; write
  the assignment here instead.
- Contract authoring law (v0.0.8 — the first Ratification: the v0.0.7
  Retro's batch ratified 2026-10-10, R6 in the gate bullet above and R2–R5
  here, each clause grown from ledger evidence in
  `~/.paseo-factory/plugin-state/paseo-factory/retro-2026-10-09.md`): the
  description and the scope must stay coherent — never require an edit
  outside `--scope`; widen the scope or forbid the edit (R4 — a description
  demanding a README line with README.md out of scope manufactures the
  violation it then punishes). A task whose intended work loosens test
  assertions or reduces their precision says so in the description (R2 —
  without that opt-in, an exact-to-loose rewrite reads as suspect weakening
  to the watch). A task that forbids running tests never asks for "all tests
  pass" (R3 — prescribe "implementation complete; tests not run locally";
  the contract must not push the agent into fake-done wording). A bootstrap
  step that reads environment or service configuration may confirm the step
  completed, and nothing more — never echo, commit, or summarize secret
  values (R5).
- `contract_set` records the base sha; note it in the ticket.
- The contract must precede `factory run` (step 4) — the driver reads the
  task's workspace and gate from it.
- Two live contracts may never share a workspace tree: a contract whose
  workspace equals, nests, or contains a live contract's is refused at
  contract time — accept or retire the live task first (the same guard fires
  again at spawn time, step 4).

## 4. Spawn and watch — the driver, `factory run` (v0.0.5)

One command carries a contracted task from branch to verdict:

    node plugin/bin/factory.mjs --home ~/.paseo-factory run <task-id> [<task-id>…] \
      --provider <provider[/model]>

One `--provider` per invocation — every task in it runs on it. The task count
is the parallelism ceiling; there is no `--parallel` knob.

Per task, in order:

- **Branch** — the workspace from the contract must exist and sit clean
  (`git status --porcelain` empty), then the driver cuts the branch named
  after the task id (`live<NN>-<slug>`; task ids are branch-safe by the same
  pattern the core enforces: letters, digits, `.`, `_`, `-`). An existing
  branch is switched to, not recreated (the re-run case). The agent never
  creates branches. These local refusals exit 2 and write no ledger line.
- **Spawn** — one `spawn` request per task through the spool; the plugin
  ledgered `spawn_dispatched` or `spawn_refused` either way, one line each
  (unknown task, already-accepted task, unscoped contract at arity ≥ 2, a
  workspace that equals/nests/contains a live contract's). A request that
  gets no reply stays in the spool and may still be processed.
- **Create** — the agent is created over the daemon's own WebSocket RPC, its
  brief this runbook's fixed template (step 5) with the PATH baked from the
  driver's own environment at spawn time, and the contract's `--description`
  riding ahead of it when one was set (v0.0.6) — the operator types nothing.
  Spawns stagger a few seconds apart — CPU etiquette, not correctness: the
  gates must not serialize (ticket 03 §7).
- **Watch** — one observe loop polls ~5s snapshots per agent to its terminal
  state, reconnecting through a daemon restart (pid + credential re-read);
  each task's verdict line (attempt, verdict, sha, report path, choke
  counts) prints the moment it lands, read from the ledger the plugin wrote
  while the agent worked.

Laws the driver runs under:

- It answers nothing itself: the choke still answers every ask for
  contracted agents (step 6), and the brief's `factory-claim` loop and the
  git shim ride the daemon's before-hook (ADR 0004) exactly as they did for
  a hand-spawned agent.
- Exit 0 iff every task ended green with zero refusals and no dead agents
  (`factory: run green — every task verified`); anything else exits 2 with a
  reason line per task.
- No respawn, ever: a dead agent is reported (exit 2); retry policy belongs
  to a later row. A crashed driver is safe to re-run — the spool dedupes
  replayed requests and the create is idempotency-keyed by task id, so a
  re-run meets the existing agent or a structured conflict, never a second
  agent.
- The daemon is preflighted before any spawn line lands: a dispatched spawn
  with no agent behind it would be a lie the ledger keeps.

## 5. Fallback — the manual spawn ritual (non-contract agents)

The ritual as it ran in 09 / 06 / 03, kept for a non-contract agent — the
driver and the choke are not its business (map decision 5). Branch by hand:

    git switch -c live<NN>/<slug>

from main in the real workspace. Landing to main stays a human act
(ADR 0005).

Spawn through the trial daemon only — its agents get `factory-claim` on PATH
via the before-hook (ADR 0004):

    paseo run --background --title <task-id> \
      --provider <provider[/model]> --home ~/.paseo-factory "<brief>"

Provider-default permission mode maps to "Always Ask" — that is expected. A
contracted agent should not come through this loop at all (the driver, step
4); for a non-contract agent the manual permit loop (step 6) absorbs the
asks.

**The brief — fixed template, edit only the placeholders** (the driver
renders these same words for its own agents — template and code move
together):

> Do the assigned work on branch `<branch>`. When done: commit, run
> `git rev-parse HEAD`, then `factory-claim --task <task-id> --sha <sha>`.
> If the result is RED: read the note line, fix, make a NEW commit, claim
> again with the new sha. Never edit tests just to make them green.
>
> Your shells under the daemon start without git/node/npm on PATH — export
> PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" first.

## 6. Permits

For a **contracted agent there is nothing to run** (v0.0.4): the choke
answers every ask itself — allow by default, deny + one `permit_denied`
ledger line on the deny-list — and the create-time mode pin makes sure the
asks always surface. Measured live in ticket 03 (v0.0.4): 20 asks, all
answered by the plugin, 0 operator permit acts. Paseo itself persists no
permission record, so the ledger's `permit_allowed` / `permit_denied` /
`git_blocked` lines are the run's only audit trail — `factory status` shows
them per task as `choke=<allowed>/<denied>/<blocked>`.

Non-contract agents are not the choke's business (map decision 5) — for
those, the manual fallback remains, one terminal started before the agent's
first shell command:

    node scripts/permit-loop.mjs --home ~/.paseo-factory --agent <agent short id>

One stdout line per grant; the grant count is that run's permit metric
(09: ~10 grants, 06: 19 — the parade that motivated the choke).

## 7. Monitor

    tail -f ~/.paseo-factory/plugin-state/paseo-factory/ledger.jsonl
    paseo plugin logs paseo-factory --home ~/.paseo-factory

The driver prints each task's verdict line the moment it lands (step 4) —
the ledger tail is still the live view of everything between the verdicts.

On a red: read the note, then the full gate output at the event's `outputPath`
before blaming the agent — the note is a capped tail and can hide the root
cause (in 09 the `npm: command not found` line sat above the tail window).

## 8. Findings

The ticket's own questions first, then the standing four (ladder §3): what
the eye caught that the gate missed (nothing is data too), noise level, cost
per pass, and the Owner-work count. Write them into the ticket before
close-out; "the concern path has never fired in live usage" was visible only
because both runs wrote their findings down.

## 9. Close-out

- **Accept** — the Owner's word, then:

      node plugin/bin/factory.mjs --home ~/.paseo-factory accept <task-id> --attempt <n>

  Since v0.0.9 the word may arrive in the Owner's conversation with the
  Supervisor seat (the Paseo app chat): the seat runs this same CLI as the
  delegated Owner, and the ledger line's `accepted_by` names it — the human
  path above stamps `owner` the same way.

- **Delegation convention** (fixed in 09, reused in 06; reshaped by the
  Supervisor seat, v0.0.9 / ADR 0006): when Andrew says "bạn làm đi" /
  "tự làm hết đi" (both mean "you do it"), the accept act and the git flow
  (push / PR / merge, plus a tag when a version is being cut) are delegated
  to the operator for that run — revocable, and recorded in the ticket as
  "0 manual acts, N delegations". The accept act is separately delegable to
  the Supervisor seat — Andrew's acceptance word spoken to the seat in
  conversation, the seat accepting as the delegated Owner. The git flow is
  NEVER the Supervisor's: landing and push stay on the human-driven path
  (ADR 0006 — "it is not another project Lead").
- **Revoking the seat** (ADR 0006 / v0.0.9 design): cancel the turn, archive
  the agent (`paseo agent archive <id> --home ~/.paseo-factory`), stop typing
  — no ledger line, no factory-side state exists to clear. Every recorded
  line stays; a live Contract stays live; the acts fall back to the human
  CLI path above. A new Supervisor is a new agent under the same
  convention.
- **Landing**: PR into main, CI green before merge, branch deleted after
  (ADR 0001).
