# ADR 0019 — Provider-Isolated OpenCode Fences, `Task worktree` Continuity Across Re-Contracting, Glob Scope Matching, and `<project-root>` Dependency Hydration

- **Status:** Accepted — 2026-10-23 (ratified by Andrew over `/grill-with-docs` for `v0.0.32`)
- **Grounded in:** Forensic audit of the `ai-test-043c7e` run (`/Users/andrewpham/Documents/code/ai-test`) · binary inspection of Paseo `0.11.2` (`app.asar` `providers/opencode/v2/{session,permissions,turns}.js`) and `@opencode/cli` `v2.0.32` (`opencode.exe`) · `zcode-room` (`paseo-room`) worktree and pre-commit gate patterns
- **Amends:** ADR 0004, ADR 0009 §3, ADR 0010 §3–§4, ADR 0015 §1–§4, ADR 0016 §1–§3, ADR 0017 §2, and ADR 0018 §4

## Context

Forensic inspection of the `ai-test-043c7e` multi-wave run (`T-01`..`T-15`) and binary-level analysis of Paseo's OpenCode v2 adapter (`providers/opencode/v2/permissions.js`, `session.js`) and `@opencode/cli` (`v2.0.32`) exposed six systemic failure modes:

1. **OpenCode v2 `respondToPermission(deny)` Turn-Abort Defect & Silent `Supervisor` Turn Death:**
   - In Paseo's OpenCode v2 adapter (`providers/opencode/v2/permissions.js:55-59`), `client.permission.reply({ sessionID, requestID, decision: "reject" })` drops `response.message` and `session.js:358-361` unconditionally marks `this.turns.requestDenied()` even when `interrupt: false`. Inside `opencode.exe` (`v2.0.32`), a `reject` without `message` throws `Permission.DeclinedError` (`"The user declined this tool call"`), which `SessionStep.attempt` treats as an unrecoverable defect: it fails the assistant message with `"Step interrupted"` and cancels the turn (`turn_canceled`) with zero assistant output.
   - By contrast, when a command is refused at OS exec time by a Layer-3 `PATH` shim in `<stateDir>/bin` (`exit 126` + `stderr`), OpenCode feeds the `stderr` back to the model as an ordinary `bash` tool result without aborting the turn.

2. **OpenCode Zen (`opencode.ai/zen`) Free-Tier Rejection under `TOOLLESS_OPENCODE_CONFIG`:**
   - In `src/lanes.ts`, `TOOLLESS_OPENCODE_CONFIG` set `"read": { "*": "deny" }` alongside `--auto`. Removing `read` from OpenCode's tool schema causes OpenCode Zen's remote gateway to reject `opencode/*-free` models (such as `opencode/nemotron-3-ultra-free`) with `AI.Error.Authentication: OpenCode's free tier can only be used from within OpenCode`, causing `100%` of `Fresh-eyes review`, `Watch`, and `Retro` invocations on `opencode/*-free` lanes to fail after `~128s`.
   - Live probing against `opencode.exe` (`v2.0.32`) proved that omitting `--auto` (`["run", "--standalone", "-m", ...]`) and setting `"read": { "*": "ask" }` (with `"*": "deny"` and all other tools `"deny"`) preserves the `read` tool schema required by `opencode.ai/zen` while causing OpenCode's non-interactive runner to auto-reject any `read` call (`! permission requested: read; auto-rejecting`) with zero execution.

3. **Literal Prefix-Only `scopeCoversFile` & Misleading `git-shim` Recovery Guidance:**
   - `scopeCoversFile` in `src/workspace.ts` matched `Contract.scope` entries strictly as literal file/directory prefixes, rejecting valid glob scopes such as `tests/e2e/**` or `src/**/*.ts`.
   - When an `Agent` dirtied a file outside `Contract.scope` and ran `git checkout -- <file>` or `git restore <file>`, `git-shim.mjs` refused with `git: nothing was executed; adapt the command (e.g. --force-with-lease) and retry`, while Station 4's red note gave no recovery command — leaving `Agent`s unaware that `git restore --source=<base-sha> -- <file>` (restore from explicit commit ref) is permitted by `refuseGitArgv`.

4. **`Task worktree` and `base` Commit Amnesia Across `contract_set` Re-Contracting:**
   - When `Lead` re-called `lead_set_contract` on an unaccepted `Task` (e.g. to widen `scope` after a scope-violation red verdict) without re-spawning, `epochEventsFor(ledger, task)` sliced at the new `contract_set.seq`, causing `worktreeFor(task)` and `liveContractFor(cwd)` to return `undefined` (dropping the live `Task worktree`) and causing `setContract` to overwrite `base` with `<project-root>`'s current `HEAD` instead of preserving the `Task`'s original `base` commit.

5. **Dead-End `pending-conflict` Acceptance, Unhydrated `<project-root>/node_modules`, and Transient Test Runner Artifacts:**
   - When `Factory.accept` recorded `attempt_accepted` with `landing: "pending-conflict"` (because `<project-root>` was dirty or conflicted), any subsequent `accept` call after `Lead` resolved the conflict threw `already-accepted` without retrying `landTaskWorktree` or cleaning up the `Task worktree`.
   - Because dependencies were installed only inside ephemeral `Task worktree`s (`<worktree>/node_modules`), removing the worktree on `finishLanding` left `<project-root>` with no `node_modules/`, so the Owner could not run `npm run dev` at `<project-root>`.
   - Unignored test runner output directories (`playwright-report/`, `test-results/`, `coverage/`, `.nyc_output/`) dirtied Station 3 (`workspace moved during the gate`) even when the `Gate` exited `0`.

6. **Missing `Supervisor` Run-Verification & `Lead` Entrypoint/Lockfile Contracts:**
   - `SUPERVISOR_CONTRACT` did not instruct `Supervisor` how to handle Owner bug/verification requests (`"kiểm tra tại sao không run được"`), and `LEAD_CONTRACT` did not require `Lead` to include `package.json` in `scope` when dependencies change or to verify that new UI components are wired into the application's real entrypoint (`src/App.tsx`, `src/main.tsx`, `index.html`).

## Decision

1. **Provider-Isolated OpenCode Layer-2 → Layer-3 Delegation & Package-Manager `PATH` Shims (`src/choke.ts`, `plugin/server/choke.ts`, `plugin/server/shell.ts`, `plugin/bin/exec-shim.mjs`).**
   - Extend `ensureGitShim` (`plugin/server/shell.ts`) and `plugin/bin/exec-shim.mjs` to generate `<stateDir>/bin/{npm,npx,pnpm,yarn,bun}` wrappers alongside `git`, `pkill`, `kill`, `killall`, `paseo`, and `gh`.
   - When `PASEO_FACTORY_SEAT` is `"supervisor"` or `"lead"` (never `"agent"`), `exec-shim.mjs` refuses package-mutating invocations (`install`, `i`, `add`, `ci`, `remove`, `rm`, `uninstall`, `update`, `up`, `upgrade`, `link`, `unlink`, `init`, `create`, `dlx`, `x`, bare `yarn`, and `npx`) with `exit 126`, appends one audit record to `<stateDir>/git-blocked.log` (`rule: "seat-write-fence"`), and prints a role-specific `stderr` instruction (`Supervisor` → dispatch via `supervisor_dispatch_lead`; `Lead` → contract and spawn a `Task` via `lead_set_contract` + `lead_spawn_agent`). Read-only invocations (`npm test`, `npm run <script>`, `--version`) pass through untouched.
   - **Strict Provider Isolation:** In `plugin/server/choke.ts` (`onPermissionAsked`), when — and **only** when — the asking session's effective provider family is `"opencode"` (`resolveEffectiveProviderFamily(...) === "opencode"`), a `Bash` permission ask whose denial is purely covered by a bare Layer-3-shimmed binary (`git`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, `pkill`, `kill`, `killall`, `paseo`, `gh`) with no shell write redirects/operators, no subshell expansion, and an existing `<stateDir>/bin/<tool>` wrapper on disk is answered `{ behavior: "allow" }` at Layer 2 so Layer 3 refuses it cleanly at exec time (`exit 126` + `stderr` + `git_blocked` ledger event) without triggering OpenCode v2's `Permission.DeclinedError` turn abort. All other providers (`pi`, `claude`, `codex`, `copilot`, `omp`, `antigravity`), all non-shell tools (`Write`, `Edit`), and all unshimmed shell writes (`>`, `rm`, `cp`, absolute `/usr/bin/git`, etc.) continue to be denied at Layer 2.

2. **OpenCode-Isolated Headless Tool-Less Config for `opencode/*-free` Lanes (`src/lanes.ts`).**
   - Strictly within the `provider === "opencode"` branch of `src/lanes.ts`:
     - Update `TOOLLESS_OPENCODE_CONFIG` to set `"read": { "*": "ask" }` while keeping `"*": "deny"`, `external_directory: "deny"`, `doom_loop: "deny"`, `question: "deny"`, `edit: "deny"`, `write: "deny"`, and `bash: "deny"`.
     - Update `laneCliInvocation` for `opencode` to `["run", "--standalone", "-m", ...]` (removing `--auto`).
   - All other headless CLI families (`pi`, `copilot`, `claude`, and `eye.json`) remain byte-identical.

3. **Glob-Aware `scopeCoversFile` / `scopesOverlap` & Actionable Recovery Guidance (`src/workspace.ts`, `src/factory.ts`, `plugin/bin/git-shim.mjs`).**
   - Upgrade `scopeCoversFile` (`src/workspace.ts`) and `scopesOverlap` (`src/factory.ts`) so `Contract.scope` entries support glob patterns (`*`, `**`, `?`, e.g. `tests/e2e/**`, `src/**/*.ts`) in addition to literal file and directory prefixes.
   - Update `plugin/bin/git-shim.mjs` refusal `stderr` and Station 4's scope-violation note (`src/factory.ts`) to name the exact allowed recovery command: `git restore --source=<base-sha> -- <file>` (or `git checkout <base-sha> -- <file>`).

4. **`Task worktree` and `base` Commit Continuity Across `contract_set` Re-Contracting (`src/factory.ts`).**
   - In `Factory.worktreeFor(task)` and `Factory.liveContractFor(cwd)`, if the current `Contract` epoch has no `spawn_dispatched` yet, fall back to the latest `spawn_dispatched.worktree` in the unaccepted `Task`'s full `Ledger` history provided that worktree directory still exists on disk (`existsSync(worktree)`).
   - In `Factory.setContract`, when `input.base` is omitted on a re-contract of an unaccepted `Task` that already has a live `Task worktree`, preserve the prior `Contract`'s `base` commit instead of overwriting `base` with `<project-root>`'s moved `HEAD`.

5. **Idempotent `pending-conflict` Re-Landing, Transient Test Artifact Exclusion, and `<project-root>/node_modules` Hydration (`src/factory.ts`, `src/workspace.ts`, `plugin/bin/task-worktree.mjs`, `plugin/bin/bridge.mjs`).**
   - Extend `isUntrackedInstallArtifact` (`src/workspace.ts`) to ignore transient untracked test runner output directories (`playwright-report`, `test-results`, `coverage`, `.nyc_output`, and `*-snapshots`) during `checkCleanAt`.
   - Enable `symlinkNodeModules: true` by default in `plugin/bin/task-worktree.mjs` (`prepareTaskWorkspace`) and `plugin/bin/bridge.mjs` (`allocateTaskWorktree`) when `<project-root>/node_modules` exists, and in `finishLanding` (`src/workspace.ts`), before removing a landed `Task worktree`, if `<worktree>/node_modules` is a real directory (not a symlink) and `<project-root>/package.json` exists while `<project-root>/node_modules` is absent (or older than `<project-root>/package.json`), move/copy `<worktree>/node_modules` to `<project-root>/node_modules`.
   - In `Factory.accept` (`src/factory.ts`), if the latest `attempt_accepted` for `task` has `landing === "pending-conflict"`, allow re-calling `accept` on that same `attempt` to re-run `landTaskWorktree` and append a settled `attempt_accepted` (`landing: "landed"`) once `<project-root>` is clean/merged.

6. **Diagnostic & Integration Laws in `SUPERVISOR_CONTRACT` and `LEAD_CONTRACT` (`src/roles-contract.ts`).**
   - In `SUPERVISOR_CONTRACT`, add the **Diagnostics & Run-Verification Law**: `Supervisor` may run read-only inspection commands (`ls`, `cat package.json`, `git status`, `git log`) to diagnose issues, and whenever a fix, dependency install, build, or runtime verification is needed, `Supervisor` must immediately call `supervisor_dispatch_lead` (`factory lead dispatch`) and end its turn.
   - In `LEAD_CONTRACT`, add the **Entrypoint Integration & Lockfile Law**: whenever a `Task` installs or updates dependencies, `Lead` must include `package.json` in `Contract.scope`; whenever a feature adds UI components or modules, `Lead` must ensure a `Task` wires them into the real application entrypoint (`src/App.tsx`, `src/main.tsx`, `index.html`) and that the final `Gate` runs `npm run build && npm test`.

## Consequences

- **Positive:** OpenCode seats (`Supervisor`, `Lead`) and working `Agent`s never suffer silent turn aborts when hitting a Layer-3-shimmed command; `opencode/*-free` lanes pass `opencode.ai/zen` authentication in `Fresh-eyes review`, `Watch`, and `Retro`; glob scopes (`tests/e2e/**`), in-place re-contracting, `pending-conflict` re-landing, and `<project-root>/node_modules` hydration work seamlessly; and all non-OpenCode providers (`pi`, `claude`, `codex`, `copilot`, `omp`, `antigravity`) remain completely unaffected.
- **Negative:** None.
