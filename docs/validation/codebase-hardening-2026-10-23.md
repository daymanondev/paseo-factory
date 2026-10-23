# Codebase hardening validation — 2026-10-23

This report separates the complete local regression corpus from the smaller live trial. Production `~/.paseo`, remote Git/Vault operations, push, release and destructive history reset were outside the validation scope.

## Revision and local checks

The final validated runtime revision is `c2e5f3640e629c60b30c049d0513c8c718e898e4` (`codex/codebase-hardening`), the same product tree as review-fix commit `903e7eda8c629d3fa1c4d659f960cb58e497b3f4`. The enabled trial plugin registration points to the primary repository's `plugin/` directory, which was clean at that revision. The focused final trial and its cleanup are recorded below separately from the initial trial at `9b6a0b99a07594d16848aa8ce57655d4d1cf817f`.

The final exact `npm run check` contract passed at `903e7ed` on both supported runtimes:

| Runtime | Result |
| --- | --- |
| Node 22.22.0, independent clean checkout and dependencies | 885 tests passed, 0 failed; 94.00s test phase |
| Node 24.21.0 | 885 tests passed, 0 failed; 106.40s test phase |

`npm run check` includes copied-core drift, generated policy drift, canonical TypeScript typecheck, isolated tracked-plugin client/server builds and the full behavior suite. The separately exposed installed subset also passed 55/55. Logs are retained at `/tmp/research-slp-hardening/review-final-node22-check.log`, `/tmp/research-slp-hardening/review-final-node24-check.log` and `/tmp/research-slp-hardening/review-final-node24-installed.log`. No remote CI execution is claimed.

Earlier ticket 11 verification ran `npm ci` followed by the exact aggregate check in two fresh local clones with independent dependencies: 862/862 on Node 22 (74.10s) and Node 24 (72.99s). Its implementation `387b6c2` and integration `b613551` have identical tracked trees. Those are initial checks, preceding the CLI correction and final review fixes.

## Final review findings and rechecks

The independent Standards review found one timestamp defect; the independent Spec review found two defects in recovery boot and busy Vault staging. Its remediation recheck then found one cross-process materialization-status race. All four findings were fixed in `8e22cc4` and `903e7ed` and independently rechecked:

| Finding | Corrected public behavior and evidence |
| --- | --- |
| Standards: invalid timestamps entered new identified history | Upgrade preflight refuses invalid legacy timestamps before mutation. Supported v2 readers/import admission reject invalid UTC/calendar values, retain exact source bytes and leave active history unchanged. Valid legacy reading remains compatible. `history-time.test.ts`, `history-upgrade.test.ts`; independent Standards recheck passed. |
| Spec: interrupted upgrade prevented recovery controls from registering | Actual plugin-entry regressions cover root/Project interrupted apply and restore, pending cleanup, captured contexts/hooks and missing Spool reply infrastructure. Read/recovery controls remain available while ordinary boot, mailbox and Git ingestion defer; retained ordinary work resumes after recovery. `plugin-recovery-boot.test.ts`; independently rechecked and exercised in the final trial. |
| Spec: fetched Vault history waited behind associated-file maintenance | Busy direct/pull transport durably stages history with a materialization hold before waiting. External CLI reports refused associated-file materialization without writing configs; matching Owner retry releases the hold and admits the same batch after safe materialization. `vault-cli.test.ts`, `history-admission.test.ts`; independently rechecked and exercised in the final trial. |
| Spec follow-up: stale external refusal overwrote writer admission status | External materialization feedback is separate from writer-owned admission state, with monotonic applied precedence. A deterministic two-process regression pauses an external refusal while the Owner applies the batch; the late refusal and subsequent drain preserve applied/applied status and exactly one imported fact. `history-admission.test.ts`; independent reproduction and installed CLI retry checks passed. |

The independent recheck reports are `/tmp/research-slp-hardening/final-standards-recheck.md` and `/tmp/research-slp-hardening/final-spec-race-recheck.md`; neither reported a remaining concrete finding. The final 885-test checks above include the remediation regressions. The focused live trial below validates the changed recovery/Vault entrances; it does not replace the local concurrency regression.

## Corrected review scenarios

These are assertions of corrected outcomes, not executions of old reproduction scripts that expect defects. Each named test file is part of the final 885-test passing corpus.

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

## Initial trial preflight and preservation

Read-only preflight used explicit `--home ~/.paseo-factory`. Paseo was 0.11.4; the daemon was stopped (`pid/listen: null`). The existing root Ledger was legacy/schema 1 with 1536 acknowledged events / 104 Tasks, no open Claim pipeline, no unanswered Spool requests and no acquisition guard. The first live directory projection showed 7 existing visible Agents, all closed. The original 1536-event prefix is preserved. Six untasked `git_blocked` / `seat-write-fence` audit facts were ingested asynchronously across the trial startups; they remain appended and are not erased for this validation. Their cwd was outside production. No fixture Claim had occurred at that point.

Before each start, the harness privately preserved exact bytes, modes and absence of trial `config.json`, root `eye.json`/`lanes.json` and both reconciled global factory skill files. Mode 0600 backups and a preservation manifest were retained under the unique trial validation directory. Known boot reconciliations and temporary fixture writes were tracked by path; restoration checked hashes/types/modes for every protected file before changing any. The daemon was stopped before exact restoration. No credentials, raw config, auth URLs, correlation tokens or model transcripts are included here.

The initial attempt stopped at genuine Lead creation before any Claim/import/upgrade. Its exact sanitized error was `creating the lead agent failed: OpenCode model must be provider/model`. The existing root lane `opencode/space-bunny-free` supplies an incomplete OpenCode model. A minimized repeat on the same disposable Git Project reproduced that error. The correction was a public Project-only lane override `opencode/opencode/space-bunny-free`; no product code or existing root lane change was required. Failed-attempt cleanup stopped the trial and restored all protected files; no fixture Claim/import/upgrade had started. Normal asynchronous audit appends are retained as described above.

## CLI defect found during the initial live trial

The initial full scenario reached a genuine idle, correlated Lead, then preflight JSON was truncated at 65536 bytes when stdout was a pipe. It stopped before applying an upgrade and completed public fixture cleanup and exact protected-file restoration. A minimized public regression with 600 disposable files reproduced the same parse failure independently of the trial harness.

`da0160f` fixes the cause: asynchronous pipe writes were followed by immediate `process.exit()`. Upgrade and Vault machine-readable outputs now wait for the stdout write callback before returning their existing exit code. The regression verifies complete parseable inventories, success 0 / refusal 2, conflict diagnostics and read-only state preservation. Ordinary large status/cost probes passed and their text behavior was not changed.

After the fix, `npm run check` passed 863/863 on Node 24.21.0 (73.69s) and in the independently installed clean Node 22.22.0 clone at initial-trial integration `9b6a0b9` (72.40s), including typecheck, tracked installed bundles and core/generated drift. The new public regression also passed separately on both versions. The original real-data preflight then parsed successfully through a pipe: 190415 output bytes / 993 inventory entries, exit 0. No dependency, engine, packaging policy or persistent schema changed in this fix.

## Initial live disposable results

The initial successful run was `hardening-1792746680693-0a77cc`, 09:11:20.744–09:11:56.851 UTC, exit 0. `$TRIAL_HOME` below means `~/.paseo-factory`; `$REPO` is the registered primary checkout. The daemon started stopped and finished stopped.

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

The original 1536-event root prefix retained SHA-256 `228004eb181754127f2db06e8e7db550d4ad40ee1c4cc7144308028eb58bcb05`. After the initial trial, the root had 1549 acknowledged events, all legacy/schema 1: six additional untasked audit facts plus the seven intended Contract/Claim/Gate/review/Report/acceptance facts. No existing event was renumbered, no root upgrade ran, and no audit fact was deleted.

Retained evidence includes two upgrade manifests/backups under `$TRIAL_HOME/plugin-state/paseo-factory-upgrades/<transaction-id>/`, the independent source snapshot under the successful run's `sources/`, and applied/conflicted manifests plus exact source bytes under the successful run's `archived-project-state/history-imports/` after the reversible offline archival below. Applied batch `cb08f124df96c94bb434cf23937c5cdcdc7354675751819b56f69e6984a5084b`; conflicted batch `101fb87fb0d64f73ca7919571e86bb15fca09c0f6837c53495268167394f8c54`.

## Initial trial reversible offline fixture archival

After public seat/Workspace cleanup and verified daemon stop, both exact disposable Project state directories were unregistered by same-volume rename into their validation runs. This prevents a retained fixture verdict queue from being discovered by a future boot pump. The actual Git workspaces stayed in place. No existing user Project directory moved, and no Ledger/audit row, mailbox entry or source snapshot was rewritten or deleted.

Every source registration was first matched to its exact known disposable Git root; both targets were checked for live owners/acquisition guards. A private `project-state-archive.json` recorded every relative path, type, mode and file-content/symlink hash before rename. The entire destination inventory was verified equal afterward, with parent directories synced. Original addresses inside Ledger/import/journal bytes remain unchanged.

| Fixture | Retained archive | Verified inventory |
| --- | --- | --- |
| Diagnostic `project-41a384` | Initial run `hardening-1792745948010-edd9d1/archived-project-state/` | 3 entries / 2 files; tree SHA-256 `b2867e59a3f3db22d4664115c998760eaf0eb317b27363043405a6391ad33d4d` |
| Successful `project-14c388` | Successful run `hardening-1792746680693-0a77cc/archived-project-state/` | 13 entries / 9 files; tree SHA-256 `da6555e918b7f5dbcbb0f5818730009ebcc850f912f16ec14c5b1c031dd7d4a9` |

Root Ledger SHA-256 stayed `5483b28f9e75b1718dcc664f93dbc0d210836e12403209307e04152c004705ff` across archival; schema 1 and all 1549 events remained intact. Exact directory renames are reversible while writers are stopped. The fixture registration/queued work is no longer in the active `projects/` tree; all evidence remains retained privately.

## Final review follow-up: recovery boot, held Vault import, timestamp refusal

On 2026-10-23, the focused follow-up ran against the primary registered plugin at integration `c2e5f3640e629c60b30c049d0513c8c718e898e4` (the same product tree as review-fix commit `903e7eda8c629d3fa1c4d659f960cb58e497b3f4`). Required checks passed on both Node 24 and an independently installed clean Node 22 checkout: **885/885 tests**, core/generated drift, typecheck and isolated installed bundles. The trial used Node `v24.21.0` and the absolute `~/.local/bin/paseo` CLI `0.11.4`, exclusively with `~/.paseo-factory`.

The successful run was `hardening-followup-1792749110168-f7ab24`, **09:51:50.219–09:52:15.557 UTC**, exit **0**, with all 17 recorded phases completed. The command was:

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$HOME/.local/bin:$PATH"
node /tmp/research-slp-hardening/trial-followup.mjs \
  --execute --checks-green --quiescence-verified \
  --initially-stopped-verified --start-daemon \
  --expected-revision c2e5f3640e629c60b30c049d0513c8c718e898e4 \
  > /tmp/research-slp-hardening/review-followup-trial2.log 2>&1
```

The private run directory retains the actual harness and companion fixture utility, preservation manifest/backups, phase evidence, source snapshots, synthetic transport markers, complete fixture runtime and complete archived Project state. No config contents, credentials, provider transcripts or private correlation values are included here.

### Actual recovery boot and Owner resume

Only a new registered disposable Project was upgraded. While the daemon was stopped, a canonical Factory owner queued one ordinary Contract **before** calling `upgradeFactory(..., {action:'apply', projectSlug, transactionId}, {fault})`. The named `backed-up` callback deliberately threw; its durable journal remained at `backed-up`. This was a controlled canonical interruption, **not an operating-system crash or forced process kill**. No root history upgrade or manual Ledger/journal edit occurred.

Transaction `45e86d9a-565f-44f2-b614-99f154a0cca2` backed up **912 regular files / 1,240,020 bytes**. Every retained backup blob's bytes, SHA-256 and permission mode were verified both before daemon boot and after resume; the empty target had zero historical mapping entries. The real trial daemon then started successfully with the incomplete Project transaction. Public Owner snapshot remained available, the queued ordinary Contract had no reply, all six protected file fingerprints matched, and the entire root Ledger remained byte-identical. Real `factory.history.upgrade` Owner RPC resumed the transaction to `applied`; the queued Contract then processed automatically. This demonstrates recovery control availability during deferred ordinary work.

### Busy external CLI staging and same-owner materialization

The public API created a genuine no-prompt Lead using the proven disposable Project lane; its idle state and trusted stored Lead correlation were checked. A normal Owner Spool Claim ran its real Gate and held the loopback HTTP Eye response at a latch. Vault used a local executable fake `gh`, installed only on this run's PATH. A daemon-side synthetic auth marker appeared **before either tarball fetch**. It accepted only the exact synthetic repo/ref tarball request and refused every other command; no Git or Vault network transport ran.

While that Claim remained held:

- The real external `factory vault hydrate --repo <synthetic> --ref <unique> --merge-ledgers` CLI fetched and durably retained batch `c3b90f0d00e0db53fdbac8f0c28cb589ab64187a0469688065882add2d243bf7`. It reported history `pending`, materialization `refused` with the owner-required reason, and `hydratedFiles: []`. Active target bytes, the empty fixture runtime and actual Workspace files stayed unchanged. The retained raw snapshot matched SHA-256 `25fd509ee65b2b4b1097b579899a088a8733973562033ebba6cf4767a0297089` exactly.
- Matching real Owner `factory.vault.hydrate` RPC fetched the same fixture, remained unsettled behind maintenance admission, and still changed neither target nor runtime. After the Eye returned `CONCERN`, the Claim completed, RPC materialization became `applied`, and the same held batch automatically became history `applied` without another Sync action.
- The two downloaded files were the minimal Vault manifest and one mock node's Project Ledger. The generated runtime also contained `env.json`; its complete retained tree has 9 entries / 3 files and tree SHA-256 `86ee7bce8fc46af3f10b3b75fec39923bc2c3d1be16a7f627030a9c5fd928a63`. No application config or secrets were supplied or collected.
- The target retained its exact **399-byte prefix**. Contract identity/epoch `event:47c2d799-eabe-4c0b-adc0-f006dfba9730` appeared once, with source sequence **2 → local 2** in the persisted import map. Final target SHA-256 was `116f328fbbae7360dafbb0855434c3345d4bf8b33c45b945cea582c8e3982268`. The actual Git Workspace file inventory remained unchanged.

The real Claim's Gate exited 0 at attested SHA `17b57608a49634afbf37392bd37a23ae2daf57c0`; its output contained the expected marker. Gate/review/Report sequences were **1554/1555/1556**. Report Workspace, attested SHA, GREEN verdict and CONCERN review were checked against actual files. Report SHA-256 was `98465b26d5d7195658c0252be79911991fba5ce8440a48ecae0ade9266bb80d7`; Gate log SHA-256 was `bdb341e9428119467ebcf2dfed80efa3bac0c2d135022bb7b2437ca385f7cd86`. Legitimate Owner acceptance followed at sequence **1557**. This is a real Claim/Gate/Report/Spool/RPC trial with a fake external Eye and Vault transport; it does not establish a completed real-provider Lead conversation, model cost or full live multi-agent SLP.

### Invalid timestamp retention and cleanup

A separate v2 snapshot containing `ts:'not-a-time'` went through real Owner history-import RPC. Batch `593480ed1234b22c22e418b6d95bb3f076554293a533db89364d6cefa4fdb302` became `conflicted` with **“line 3 has an invalid ISO 8601 UTC timestamp”**. Its `source-0.bin` remained byte-exact, SHA-256 `58a2f5a6c851dd9a78ac0af7ca96f16190cfab186b4972ed5228d6c9f4a3cc3e`; active target bytes did not change.

Cleanup used public Lead rotation and Workspace archival, verified no remaining fixture seats, and stopped only the daemon started by this run. Final absolute CLI status confirms **stopped / pid null**. All six protected paths—trial config, root Eye and lanes, both global factory skill files, and Vault config—were restored with exact original bytes/modes/presence (five originally present, one absent). Original Vault runtime absence was restored exactly. The three pre-existing Project files also retain their recorded backup hashes/modes. No pending upgrade or queued Spool request remains, and the two pre-existing Project registrations remain active.

Both follow-up disposable Project state directories were moved by verified same-volume rename out of active `projects/` into their private run evidence directories. Full path/type/mode/content inventories were checked before and after each move; actual Git Workspace roots and root audit history stayed in place. This retains queued mail and import evidence without leaving fixture registrations for a future pump:

| Run | Archived entries / files | Archive tree SHA-256 |
| --- | ---: | --- |
| Initial safety-gate run `hardening-followup-1792749011485-1e89e2` | 4 / 3 | `45e1befdd627db8a3feed2c8edd1b89d7746ddc8d08fce67b5c6c9c703b9b78b` |
| Successful run `hardening-followup-1792749110168-f7ab24` | 15 / 11 | `7db53c8912d71e43ebc5c1daf6ec1f8615bc74604fd3ae0e29d45805540a69aa` |

The initial run passed recovery boot/resume but stopped before any Claim or Vault fetch because the harness expected an auth marker while Vault was already configured; snapshots intentionally probe auth only when unconfigured. Its cleanup completed fully with zero problems. The retry changed only this fixture precondition: temporary preserved Vault config used an empty repo, while explicit CLI/RPC repo/ref still selected the synthetic fixture. A preliminary bare `paseo` command also selected an older nvm CLI `0.9.2` and refused the existing provider schema; the required absolute `~/.local/bin/paseo` `0.11.4` parsed the unchanged original config and confirmed stopped status. Neither environment/harness issue required a product or user-config repair.

The complete pre-follow-up root prefix remains byte-identical, and the original **1,536-event** prefix still hashes to `228004eb181754127f2db06e8e7db550d4ad40ee1c4cc7144308028eb58bcb05`. Root history remains legacy schema 1. The two follow-up runs retained **eight additional audit facts**: two Contracts and the successful Claim, Gate start/finish, review, Report and acceptance. The initial fixture's Contract remains as audit evidence without a queued request or registered fixture Project. Final root history has **1,557 events / 601,411 bytes**, SHA-256 `c85c031111689066d89cb47330ef78e5f95126b81e84a3d265259d6481d82545`. Cleanup verification reports zero problems; no active history was deleted, renumbered, reset or manually acknowledged.

## Limits

Only registered disposable Project targets were upgraded/restored. The real root Ledger remains in its original legacy format; deliberate review lifecycle events appended through its sole live writer. Source snapshots were generated independently outside active target state and remain retained.

The initial live resume checked an already-applied transaction's idempotence. The final follow-up deliberately interrupted canonical apply at its named `backed-up` fault point, then booted the real plugin and resumed through Owner RPC. No operating-system crash or forced live process kill is claimed. Local fault/restart tests cover additional interruption paths; the startup acquisition guard still deliberately requires inspection if startup itself is interrupted.

The initial trial's real verdict notification remained queued: its Lead was idle with one queued verdict item and no mailbox delivery entry. That item remains in the archived disposable Project state. Both trials retained fixture mail rather than purging or falsely acknowledging it. No initial model prompt, completed real-provider Lead conversation, model cost or full live multi-agent SLP is claimed. Genuine provider initialization, authority, live daemon owner/Gate/review/import/upgrade and cleanup are the live facts; full model-role routing remains the separately passing local MCP/fake-daemon corpus. The final trial's external Eye and Vault transport were controlled local fixtures, so it does not establish remote provider or Git/Vault network behavior.
