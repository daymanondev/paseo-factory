# Codebase hardening validation — 2026-10-23

This report separates the complete local regression corpus from the smaller live trial. Production `~/.paseo`, remote Git/Vault operations, push, release and destructive history reset were outside the validation scope.

## Revision and local checks

The final validated runtime revision is `9b6a0b99a07594d16848aa8ce57655d4d1cf817f` (`codex/codebase-hardening`), including the CLI flush correction found below. Initial trial attempts used `b6135519fce542d504a911d161ff9dfe96f4791e`. The enabled trial plugin registration points to the primary repository's `plugin/` directory, which was clean at that revision. The ticket 12 worktree contains this report; it is not the plugin registration source.

Ticket 11 ran the exact tracked workflow commands, `npm ci` followed by `npm run check`, in two fresh local clones with independent installed dependencies:

| Runtime | Result |
| --- | --- |
| Node 22.22.0 | 862 tests passed, 0 failed; 74.10s test phase |
| Node 24.21.0 | 862 tests passed, 0 failed; 72.99s test phase |

`npm run check` includes copied-core drift, generated policy drift, canonical TypeScript typecheck, isolated tracked-plugin client/server builds and the full behavior suite. The separately exposed installed subset passed 55/55. The tested ticket 11 implementation `387b6c2` and integration `b613551` have identical tracked trees. No remote CI execution is claimed.

## Corrected review scenarios

These are assertions of corrected outcomes, not executions of old reproduction scripts that expect defects. Each named test file is part of the 862-test passing corpus.

| Review concern | Public regression evidence |
| --- | --- |
| SP1: import changes disk while writer cache/counter remains stale | `history-admission.test.ts`: writer-owned import and unique next append; complete Gate/Fresh-eyes/Watch/Report/Retro leases; independent Gates and external Spool continuations. `vault-cli.test.ts` distinguishes staging from active replacement. |
| SP2: Lead attribution bypasses acceptance policy | `spool.test.ts`, `bridge-mcp.test.ts`: genuinely correlated Lead requests with omitted/forged attribution remain subject to Lead authority. |
| SP3: required review pending/failed/incomplete appears eligible | `fresh-eyes.test.ts`: controlled pending review refusal, completed CLEAR, failed/timeout/interrupted/restart-incomplete cases and legitimate Owner/Supervisor override. Generated CLI/MCP status uses the core Task projection. |
| SP4: import renumbers existing evidence | `history-identity.test.ts`, `history-import.test.ts`: stable identities, immutable local seqs, epoch separation, source-to-local mapping, typed/wrong-kind reference refusal and unchanged Attempt/mailbox domains. `history-upgrade.test.ts` covers queued requests, cached replies, own maintenance controls, backups and restore. |
| SP5: Artifact escapes execution Workspace | `artifact-containment.test.ts`: registration escapes; nested/missing/symlink/post-Gate Artifact checks; actual managed Task worktree containment. |
| SP6: Gate descendants survive completion | `gate.test.ts`: redirected and inherited output, cooperative descendants, nonzero and timeout cleanup through actual child processes. |
| SP7: signal becomes success | `subprocess-shims.test.ts` and `gate.test.ts`: direct codes/signals, forwarding, and red Gate on signal termination. |
| SP8: copied runtime/worktree policies disagree | `policy-assets.test.ts`, `bridge-mcp.test.ts`: core/driver selected file corpus and copied-alone bridge include/exclude/private-file/clean-tree behavior. |
| SP9: Antigravity treats scope glob as literal prefix | `scope.test.ts`: shared corpus through core, installed shims and copied-alone hook. |
| ST1: corruption/tail reader gap | `ledger-integrity.test.ts`: CLI/copied MCP/driver/startup agreement, untouched unterminated tails, non-ENOENT failures, strict v2 payloads and contradictory green exit/null/SHA refusal while legacy/red reads remain valid. |
| ST2: missing required CI/packaging checks | `installed-artifacts.test.ts`, `core-sync.test.ts`, `policy-assets.test.ts`: tracked push/PR workflow and same aggregate commands; intentionally stale/missing/orphan generated/core outputs, escaping imports/symlinks, untracked modules and unavailable type/runtime dependencies fail their real checks. |
| ST3–ST5: divergent projection, transport arguments and Vault policy | Shared `task-state`/generated `task-status`, named Spool dependencies/shared command executor and canonical Vault codec/transport/materialization/history gateway. Existing public CLI/MCP/RPC schemas and caller fields remain covered. |

The existing `slp-lifecycle.test.ts` exercises Owner → Supervisor → Lead → Agent → Lead → Supervisor through real MCP transports against a controlled fake daemon. Worktree re-contract/base, landing/pending-conflict retry, metering, death/respawn, Needs-human, Attempt ceilings and concurrency regressions remain in the full suite. This is full local SLP coverage, not proof that every real model provider performed the lifecycle during the live trial.

## Trial preflight and preservation

Read-only preflight used explicit `--home ~/.paseo-factory`. Paseo was 0.11.4; the daemon was stopped (`pid/listen: null`). The existing root Ledger was legacy/schema 1 with 1536 acknowledged events / 104 Tasks, no open Claim pipeline, no unanswered Spool requests and no acquisition guard. The first live directory projection showed 7 existing visible Agents, all closed. The original 1536-event prefix is preserved. Six untasked `git_blocked` / `seat-write-fence` audit facts were ingested asynchronously across the trial startups; they remain appended and are not erased for this validation. Their cwd was outside production. No fixture Claim had occurred at that point.

Before each start, the harness privately preserved exact bytes, modes and absence of trial `config.json`, root `eye.json`/`lanes.json` and both reconciled global factory skill files. Mode 0600 backups and a preservation manifest were retained under the unique trial validation directory. Known boot reconciliations and temporary fixture writes were tracked by path; restoration checked hashes/types/modes for every protected file before changing any. The daemon was stopped before exact restoration. No credentials, raw config, auth URLs, correlation tokens or model transcripts are included here.

The initial attempt stopped at genuine Lead creation before any Claim/import/upgrade. Its exact sanitized error was `creating the lead agent failed: OpenCode model must be provider/model`. The existing root lane `opencode/space-bunny-free` supplies an incomplete OpenCode model. A minimized repeat on the same disposable Git Project reproduced that error. The correction was a public Project-only lane override `opencode/opencode/space-bunny-free`; no product code or existing root lane change was required. Failed-attempt cleanup stopped the trial and restored all protected files; no fixture Claim/import/upgrade had started. Normal asynchronous audit appends are retained as described above.

## CLI defect found during the live trial

The initial full scenario reached a genuine idle, correlated Lead, then preflight JSON was truncated at 65536 bytes when stdout was a pipe. It stopped before applying an upgrade and completed public fixture cleanup and exact protected-file restoration. A minimized public regression with 600 disposable files reproduced the same parse failure independently of the trial harness.

`da0160f` fixes the cause: asynchronous pipe writes were followed by immediate `process.exit()`. Upgrade and Vault machine-readable outputs now wait for the stdout write callback before returning their existing exit code. The regression verifies complete parseable inventories, success 0 / refusal 2, conflict diagnostics and read-only state preservation. Ordinary large status/cost probes passed and their text behavior was not changed.

After the fix, `npm run check` passed 863/863 on Node 24.21.0 (73.69s) and in the independently installed clean Node 22.22.0 clone at final integration (72.40s), including typecheck, tracked installed bundles and core/generated drift. The new public regression also passed separately on both versions. The original real-data preflight then parsed successfully through a pipe: 190415 output bytes / 993 inventory entries, exit 0. No dependency, engine, packaging policy or persistent schema changed in this fix.

## Live disposable results

The successful run was `hardening-1792746680693-0a77cc`, 09:11:20.744–09:11:56.851 UTC, exit 0. `$TRIAL_HOME` below means `~/.paseo-factory`; `$REPO` is the registered primary checkout. The daemon started stopped and finished stopped.

Actual orchestration command (Node 24.21.0 on PATH):

```sh
node /tmp/research-slp-hardening/trial-harness.mjs \
  --execute --quiescence-verified --initially-stopped-verified --start-daemon \
  --repo /Users/andrewpham/Documents/code/self-project/research-slp
```

The retained successful run contains `harness.mjs` and `evidence.jsonl` under `$TRIAL_HOME/hardening-validation/hardening-1792746680693-0a77cc/`. The script invokes explicit-home `paseo start --timeout 60` / `paseo daemon stop --timeout 15`, the real standalone CLI, driver `DaemonRpc` plugin RPCs and the installed Spool protocol. Preflight inventory and final `paseo status --home ~/.paseo-factory` confirmed stopped state; no default-home command was used.

| Live operation | Observed result |
| --- | --- |
| Disposable Git baseline | Clean committed Project, `test`/`typecheck` scripts pass. HEAD `e990f07bb41b7b3dd68f9745d18d86bcd61f1294`. |
| Genuine Lead | `factory.lead.ensure({projectRoot})` with no message created a real OpenCode Lead. Public snapshot proved idle/no attention; read-only correlation matched its Agent ID and Lead role. Project slug `project-14c388`. |
| Pure preflight and dry run | `factory upgrade preflight --project project-14c388` and `upgrade apply --dry-run --project project-14c388` returned complete JSON; target's original absence was unchanged. |
| Apply and backup verification | Owner `factory.history.upgrade` applied only the registered disposable target. Each of two transactions backed up 896 regular files / 1,229,638 bytes. Every retained backup's SHA-256 and exact mode matched its manifest. Source version 1 → target 2; target began empty, so there are no historical legacy mapping entries to claim. |
| Resume and exact restore | Resume of already-applied transaction `a08636b7-2c9d-4a6d-bc7f-61ff23997915` returned the same applied ID. Restore returned `restored`, recovered original target absence and left root history intact. This was idempotence, not crash recovery. A second explicit apply (`9a177fc6-e982-48aa-b877-aa89d499e41e`) provisioned the current disposable v2 target. |
| Normal Claim and held review | Real Owner Spool Contract/Claim used the absolute Node executable and a Gate printing `trial-gate-pass`; a loopback HTTP Eye held the actual pipeline at a named request latch. |
| Authenticated Lead refusals | While held, genuine Lead submitter requests with omitted attribution and forged `by:owner` both returned `lead-accept-refused`. These checks preceded staging to avoid waiting behind the pending admission. |
| Pending → applied import | Public `factory.history.import({project,sources})` returned pending while the Eye was held; active target bytes were unchanged. Releasing CONCERN completed the Report and automatically applied the batch without another import request or Sync click. |
| Claim evidence | Attempt 1 GREEN, exit 0, exact fixture HEAD/Workspace, CONCERN, actual gate marker/log and Report verified. Root Gate/review/Report seqs 1546/1547/1548. Report SHA-256 `c8ef43e1f6b47843cb1e54321d502e80188d76a00c7f33bc7596e83583d8c35e`; log SHA-256 `b675dc719f6c00ea4a46b038eed998630cb0d3ebb5c52208e5729da3e343e297`. |
| Prefix and source mapping | Target's 399-byte acknowledged prefix stayed exact. Imported Contract stable ID/epoch `event:56808a88-49c5-4345-8cf2-4960f62c8ce6` occurred once, with source seq 2 → local seq 2 in the durable source map. Original snapshot bytes matched retained `source-0.bin`. |
| Duplicate | Repeating identical snapshot preserved active target bytes exactly; no duplicate fact. |
| Contradiction | Changing Gate criteria in a source-copy with the same stable ID produced conflicted status, reason `same stable identity has contradictory semantic content`. Original conflicting source bytes remained retained; target did not change. |
| Restore after work | Real Owner Spool restore refused `upgrade-intervening-writes` after the deliberate Claim/config/import work. No new work was discarded. |
| Owner override | The Owner accepted the green CONCERN Attempt through the real Spool, seq 1549. |
| Cleanup | Public Lead rotate retired only the fixture Lead; no fixture Supervisor existed. Public archive acknowledged the unique main Workspace. Scoped snapshot had no remaining fixture seats. Daemon stopped; all 5 protected files exactly restored by presence/bytes/mode. Audit/journals/source snapshots/backups were retained. |

The original 1536-event root prefix retained SHA-256 `228004eb181754127f2db06e8e7db550d4ad40ee1c4cc7144308028eb58bcb05`. The final root has 1549 acknowledged events, all legacy/schema 1: six additional untasked audit facts plus the seven intended Contract/Claim/Gate/review/Report/acceptance facts. No existing event was renumbered, no root upgrade ran, and no audit fact was deleted.

Retained evidence includes two upgrade manifests/backups under `$TRIAL_HOME/plugin-state/paseo-factory-upgrades/<transaction-id>/`, the independent source snapshot under the successful run's `sources/`, and applied/conflicted manifests plus exact source bytes under the successful run's `archived-project-state/history-imports/` after the reversible offline archival below. Applied batch `cb08f124df96c94bb434cf23937c5cdcdc7354675751819b56f69e6984a5084b`; conflicted batch `101fb87fb0d64f73ca7919571e86bb15fca09c0f6837c53495268167394f8c54`.

## Reversible offline fixture archival

After public seat/Workspace cleanup and verified daemon stop, both exact disposable Project state directories were unregistered by same-volume rename into their validation runs. This prevents a retained fixture verdict queue from being discovered by a future boot pump. The actual Git workspaces stayed in place. No existing user Project directory moved, and no Ledger/audit row, mailbox entry or source snapshot was rewritten or deleted.

Every source registration was first matched to its exact known disposable Git root; both targets were checked for live owners/acquisition guards. A private `project-state-archive.json` recorded every relative path, type, mode and file-content/symlink hash before rename. The entire destination inventory was verified equal afterward, with parent directories synced. Original addresses inside Ledger/import/journal bytes remain unchanged.

| Fixture | Retained archive | Verified inventory |
| --- | --- | --- |
| Diagnostic `project-41a384` | Initial run `hardening-1792745948010-edd9d1/archived-project-state/` | 3 entries / 2 files; tree SHA-256 `b2867e59a3f3db22d4664115c998760eaf0eb317b27363043405a6391ad33d4d` |
| Successful `project-14c388` | Successful run `hardening-1792746680693-0a77cc/archived-project-state/` | 13 entries / 9 files; tree SHA-256 `da6555e918b7f5dbcbb0f5818730009ebcc850f912f16ec14c5b1c031dd7d4a9` |

Root Ledger SHA-256 stayed `5483b28f9e75b1718dcc664f93dbc0d210836e12403209307e04152c004705ff` across archival; schema 1 and all 1549 events remained intact. Exact directory renames are reversible while writers are stopped. The fixture registration/queued work is no longer in the active `projects/` tree; all evidence remains retained privately.

## Limits

Only the registered disposable Project is upgraded/restored. The real root Ledger remains in its original legacy format; deliberate review lifecycle events may append through its sole live writer. Source snapshots are generated independently outside active target state and remain retained.

Live `resume` checks an already-applied transaction's idempotence. No forced live process crash is claimed. Named local import/migration interruption and restart tests provide controlled crash coverage; the startup acquisition guard still deliberately requires inspection if startup itself is interrupted.

The real verdict notification remained queued: the fixture Lead was still idle with one queued verdict item, and its mailbox contained no delivery entry. That item is retained in the archived disposable Project state; it was not purged or falsely acknowledged to manufacture clean status. No initial model prompt was supplied, no provider cost was measured, and this run does not claim a real model-driven Agent/SLP turn. Genuine provider initialization, authority, live daemon owner/Gate/review/import/upgrade and cleanup are the live facts; full model-role routing remains the separately passing local MCP/fake-daemon corpus.
