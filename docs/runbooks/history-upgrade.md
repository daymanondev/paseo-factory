# Explicit history upgrade and restore

This runbook supports readable legacy/schema-1 Ledgers and identified schema-2 Ledgers. Upgrade adds stable event and Contract-epoch identity, preserves every existing sequence/address and historical attribution, and appends a schema fence that older shipped writers reject. Historical legacy writer provenance remains unknown. Unsupported versions, malformed complete records, ambiguous identity/reference plans and contradictory queued/cached evidence require inspection; the upgrade does not guess repairs.

Boot never migrates state. Apply, resume and restore require the live Factory owner and exclusive maintenance admission. Other Gates/review/Watch/Report/landing/Retro operations settle first. Queued work remains queued. An offline CLI cannot take over a writer or rewrite state: a timeout leaves its request durable and asks the caller to stop retrying.

For trial validation use only `~/.paseo-factory` and a registered disposable Project. Leave the real trial root Ledger in its existing format. Production `~/.paseo` is outside this runbook's validation scope. Follow [the live-run runbook](live-run.md) to verify the trial daemon and create/select the disposable Project.

## Commands

Export the Node/Paseo PATH as described in the live-run runbook. Run from the plugin repository, substituting the disposable Project's registered slug (the registry key, not its workspace directory):

```sh
node plugin/bin/factory.mjs --home ~/.paseo-factory upgrade preflight --project <registered-slug>
node plugin/bin/factory.mjs --home ~/.paseo-factory upgrade apply --dry-run --project <registered-slug>
node plugin/bin/factory.mjs --home ~/.paseo-factory upgrade apply --project <registered-slug>
```

Preflight/dry-run reads bytes, modes, schema versions, mappings, associated state and conflicts without constructing a Factory, creating directories or quarantining a tail. It works while the plugin is offline. Mutating commands submit to the live owner. Supervisor, Lead and Agent seats cannot perform upgrade/restore even if they change attribution.

The apply JSON contains `id`, `status`, `target` and `backupDir`. Save the transaction ID and inspect the durable manifest before later recovery:

```sh
node plugin/bin/factory.mjs --home ~/.paseo-factory upgrade resume --project <registered-slug> --transaction <id>
node plugin/bin/factory.mjs --home ~/.paseo-factory upgrade restore --project <registered-slug> --transaction <id>
```

Omitting `--project` deliberately targets the root Ledger; do this only for an explicitly intended root upgrade, never merely to validate a disposable trial case. The equivalent Owner surface RPC is `factory.history.upgrade` with `{action, projectSlug?, transactionId?}`. Both entrances share the owner service.

## Durable files and provenance

Transactions live beside the factory state root, under `paseo-factory-upgrades/<id>/`: `manifest.json`, `backup/` and `prepared/`. The manifest records source/target versions, original presence/type/modes/SHA-256 hashes, backup mappings, deterministic identity/reference mappings, expected activated hashes and per-file progress. Backups preserve bytes and modes, including original tails and opaque associated files. Reports/logs/Retro, queued/processed requests, cached replies and Project/mailbox/config data retain their original addresses and bytes. Worktree/dependency symlinks are recorded without traversing product or dependency trees.

A separately provisioned local writer identity lives in sibling `paseo-factory-local-writers/`, keyed to the actual root/Project target. It is generated only during explicit apply, reused on resume and loaded read-only at startup. A remote/copy schema fence author never supplies current local writer authority. A disposable Project can load its own writer identity while its real root remains legacy. Ordinary Vault Ledger snapshots do not carry this local provisioning authority.

Activation validates prepared JSONL, lifecycle, epochs and typed references before changes. Each path must have its recorded original or already-activated hash; unexpected bytes/modes/paths refuse. The same live owner's schema, event array, writer identity and next sequence refresh after activation or exact restore. New schema-2 Report/Gate files include epoch identity; already-overwritten legacy evidence cannot be reconstructed by migration.

## Interruption and restore

A partial transaction blocks ordinary mutations with `upgrade-recovery-required`, including after restart. Its reads remain available. Resume the same ID; do not start another transaction or replace the Ledger manually. Recovery uses recorded bytes/hashes/mappings, not timestamps, and recognizes activation that survived before its final journal stamp. No new model review or verification is manufactured during upgrade recovery.

Restore first verifies backup integrity and the complete protected inventory against the predicted applied state. Any intervening Ledger append, queued request/reply, mailbox/config change, evidence file or relevant mode/presence change refuses and names the paths. Precisely identified maintenance command/reply transitions are recorded separately; unrelated files are never hidden by a `spool/` wildcard. A new queued request during maintenance is retained and can prevent blind restore. Keep the backup and inspect the reported changes; do not delete new work merely to force rollback.

With no intervening work, restore recovers original bytes, modes and absence and refreshes the same writer cache. A restored unacknowledged tail stays preserved and blocks append until the existing recovery policy handles it; restore does not silently quarantine it. Backups and transaction evidence remain available after restore.

Writer acquisition uses a short durable `ledger-owner-acquire` guard plus `ledger-owner.json`. Ordinary upgrade/import fault points occur after this startup guard has been released and recover through their journals. If startup itself crashes while acquiring ownership, a retained guard deliberately fails closed with `ledger-owner-acquisition-busy`. Inspect the adjacent owner registration, verify its PID/command and the trial daemon's actual state, and establish that every writer for that target is stopped. Preserve the guard outside mutable state before removing/moving that exact stale guard, then restart the intended owner. Do not infer absence of a writer from a failed RPC/status call, steal a live registration or remove Ledgers/backups. An unreadable/unsupported owner registration also requires inspection.

## Verification

Use disposable fixtures/copies for crash injection and immediate restore. Relevant local checks are `node --test test/history-upgrade.test.ts`, `npm run typecheck`, `npm run sync:plugin-core:check` and `npm run generate:policies:check`. System/trial acceptance is recorded separately in hardening issue 12. This runbook does not authorize production rollout or migration of real trial history for testing.
