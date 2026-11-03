# 44. Vertical-Slice Wave Decomposition, Contract-Bounded Diff Review, Reply-First Handoff Extraction, Heredoc Choke Stripping, and Worktree Process Reaping

Date: 2026-11-03
Status: Accepted

## Context

An empirical audit of a 24-hour live run on `goal-partner-f17f4d` (`850+` Ledger events, `21` `Lead` context rotations, `37` `GREEN` Gate runs, and `7` archived Codex `Lead` sessions in `~/.codex/archived_sessions/rollout-2026-11-03*.jsonl`), cross-referenced against the canonical primary sources of `codex-room` (`research/90-sources/original-files/LEAD.md`, `PEER.md`) and `paseo-room` (`src/room/prompts/contract/lead.md`, `src/runtime-plugin/server/attention/succession.ts`, `src/room/prompts/runtime/handoff-request.md`), exposed four compounding systemic bottlenecks:

1. **Horizontal Backend-Only Micro-Wave Chains, Pre-Solved Briefs, and Unbounded Post-Gate Adversarial Scripting (`src/roles-contract.ts`):**
   - In ADR 0035 (`Rolling-Wave Re-Decomposition`), the guidance to *"split upcoming waves... into narrower sequential sub-waves (`T-04a`, `T-04b`)"* caused `Lead` to slice `goal-partner` horizontally into **12 consecutive backend/data micro-waves** (`GP-T03a..d`, `GP-T04a..d2`) while leaving all 5 main user-facing mobile screens (`app/(tabs)/*.tsx`) as 108-line static placeholders after 24 hours of compute.
   - `Lead` wrote 5,000–8,000 word `Contract` briefs that pre-solved internal helper function signatures and mandated `4–6` separate unit-test files per micro-wave, inflating `Peer` context and build times.
   - Worse, in the `Closure & Integration Loop`, after the mechanical `Gate` exited `0` (`GREEN`), `Lead` wrote and executed out-of-band `node <<'JS'` / `npx tsx -e` adversarial scripts inventing uncontracted micro-edge-cases (e.g., passing malformed array prototypes, raw SQL strings, or synthetic boundary combos never mentioned in the 4-Part Brief), rejecting **21 out of 37 `GREEN` Gates (`57%`)** and burning `80,000–130,000` tokens per review turn — causing **21 `Lead` rotations in a single day**.
   - By contrast, both `codex-room` (`LEAD.md`) and `paseo-room` (`lead.md`) enforce **vertical journey slicing**, **anti-pre-solve briefs** (*"Do not pre-solve the implementation in the brief"*), and **contract-bounded diff review** (*"Inspect the actual diff, not just the Peer's prose... Falsify the proof: ask 'if the claimed behavior disappeared, would the test fail?'"*) without running ad-hoc out-of-band shell probes after a `GREEN` Gate.

2. **5/7 Failed `Lead handoff` Extractions Due to Outside-Workspace Shell File Writes (`plugin/server/lead-mailbox.ts`, `plugin/server/peer-handoff.ts`):**
   - Inspection of all 7 archived Codex `Lead` sessions in `~/.codex/archived_sessions/rollout-2026-11-03*.jsonl` (`01a19e16`, `01a19e42`, `01a19e74`, `01a19e8f`, `01a19eaf`, `01a19ed8`, `01a19ef9`) revealed why 5 out of 7 rotations failed to produce `lead-handoff.md`:
     - `paseo-factory` instructed the outgoing `Lead` (whose `cwd` is `<project-root>`) to execute a shell command writing `<projectStateDir>/lead-handoff.md` (`~/.paseo/plugin-state/paseo-factory/projects/<slug>/lead-handoff.md` — **outside `<project-root>`**) and to reply with only a 1-line confirmation.
     - In `01a19eaf`, Codex's `modeId: "auto"` (`workspace-write`) macOS Seatbelt sandbox blocked `cat > ~/.paseo/.../lead-handoff.md` with `zsh:1: operation not permitted` because `<projectStateDir>` sits outside `cwd`.
     - In `01a19e16` and `01a19e42`, when `Lead` requested sandbox escalation to run `python3` or `cat > .../lead-handoff.md`, Layer-2 `choke.ts` denied the ask (`Rejected("rejected by user")`) because `isInterpreterWriteBypass` blocks `python3` scripts containing `.write_text` and `extractWriteTargets` misparsed prose inside heredocs. Because the prompt ordered a 1-line reply, the outgoing `Lead`'s final assistant message contained only `"The handoff was not written: permission to write to the factory state directory outside the workspace was denied."`
     - In `01a19ed8` and `01a19ef9`, `Lead` spent 85 seconds streaming a huge Python script with `assert len(b) <= 16384`, which crashed with `AssertionError: 18116` / `17773` right as the 90-second fuse aborted the turn (`turn_aborted: interrupted`).
     - Finally, when the fuse tripped, `completeHandoff` overwrote `lead-handoff.md` on disk with `INTERRUPTED_HANDOFF_EXTRACTION_NOTE`, clobbering any valid `lead-handoff.md` from an earlier rotation.
   - By contrast, `paseo-room` (`handoff-request.md` + `succession.ts`) never asks the outgoing `Lead` to run shell commands or write files to disk: the outgoing `Lead` outputs the entire Markdown handoff directly in its final assistant message, and the plugin server reads the turn timeline and persists it in Node.js (`0%` sandbox/permission failure rate).

3. **False-Positive `seat-write-fence` Denials on Non-Interpreter Heredoc Bodies (`src/choke.ts`, `plugin/bin/agy-pre-tool-hook.mjs`):**
   - `splitShellSegments` and `extractWriteTargets` in `src/choke.ts` (and `plugin/bin/agy-pre-tool-hook.mjs`) did not strip heredoc payloads (`<<EOF ... EOF`, `<<'EOF' ... EOF`, `<<-EOF ... EOF`) when the command is a non-interpreter (`cat`, `tee`, etc.).
   - Whenever `Lead` or `Supervisor` wrote documentation (`AGENTS.md`, `CONTEXT.md`, `docs/**`, `.scratch/**`) via `cat <<'EOF' > docs/notes.md`, every line of English prose inside the heredoc was tokenized as a shell command: English words such as `touch`, `install`, `rm`, `mv`, `cp`, `git`, or `dd` triggered false-positive `seat-write-fence` denials (`51` denials recorded in `goal-partner-f17f4d`), and Markdown blockquotes or comparisons (`> Note`, `>= 0.5`) inside the heredoc were parsed by `extractWriteTargets` as shell redirect file paths (`=`, `0.5`) in `<project-root>` and denied.

4. **Blocked Worktree Test-Process Signals (`plugin/bin/exec-shim.mjs`) & Leaked Orphaned Worktree Processes (`src/workspace.ts`):**
   - In `plugin/bin/exec-shim.mjs`, `guardProcessKill` checked `cmdline.includes(stateDir)`. Because `Task worktree`s reside at `<stateDir>/projects/<slug>/worktrees/<task>`, any test child process launched inside a `Task worktree` (such as `@embedded-postgres/darwin-arm64/native/bin/postgres -D .../worktrees/<task>/...` or Playwright/Chromium) has a command line containing `stateDir`. When a `Peer` ran `kill <pid>` to clean up its own leaked test process, `exec-shim.mjs` misclassified it as the Paseo daemon and blocked it (`git_blocked`, rule `process-kill`, `9` blocks in `goal-partner-f17f4d`).
   - Furthermore, when a `Task worktree` was removed on Acceptance (`finishLanding` in `src/workspace.ts`) or reset/re-allocated (`prepareTaskWorktree` in `src/workspace.ts`), detached background processes whose command line referenced that `<worktree>` path survived on the host OS (`PPID=1`), leaking 3 orphaned `postgres` instances (`~300 MB` RAM + open TCP ports) across waves.

## Decision

We adopt four coordinated architectural and runtime invariants across `src/roles-contract.ts`, `plugin/server/lead-mailbox.ts`, `plugin/server/peer-handoff.ts`, `src/choke.ts` (and `plugin/bin/agy-pre-tool-hook.mjs`), `plugin/bin/exec-shim.mjs`, and `src/workspace.ts`:

### 1. Vertical-Slice Rolling-Wave Decomposition, Anti-Pre-Solve Briefs, and Contract-Bounded Diff Review (`src/roles-contract.ts`)

1. **Vertical User-Facing Journey Waves After Initial Setup (`T-01..T-02`):**
   - After at most `1–2` foundational setup waves (`T-01` app shell / harness / design tokens, `T-02` core schema / repository seam), every subsequent `Serial Wave` in a user-facing application **MUST** deliver a **vertical user-facing journey slice** (real interactive screen/UI + state/data wiring + journey test), never a horizontal chain of backend-only micro-waves (`T-04a..d2` while UI screens remain placeholders).
   - When re-evaluating upcoming waves at a `Stable Checkpoint`, `Lead` splits oversized waves along **distinct user journeys or screens**, not into horizontal data-plumbing layers.
2. **Concise Anti-Pre-Solve 4-Part Briefs:**
   - The `4-Part Brief` states the bounded user/system outcome, boundary contracts & regression invariants, explicit exclusions, and the exact `Gate` command **without pre-solving internal helper signatures or mandating `N` separate unit-test files per task** (`1–2` focused slice/journey test files suffice unless the repo's existing structure requires otherwise).
3. **Contract-Bounded Diff Review & Proof Falsification (No Post-Gate Adversarial Scripting):**
   - When the mechanical `Gate` exits `0` (`GREEN`) and `Watch` flags no concern (`< 0.5`), `Lead` reviews `git show --stat "<sha>"` and `git diff "<sha>^" "<sha>"` strictly against the 4-Part Brief and applies the **proof falsification check** (*"If the claimed behavior disappeared, would the Peer's test fail?"*).
   - If the contracted outcome is delivered, no out-of-scope regressions or fake tests are introduced, and the proof is genuine, `Lead` **MUST accept and land immediately** (`lead_accept_task` / `factory accept --by lead`).
   - `Lead` must **NEVER** write or execute ad-hoc out-of-band shell/node/python scripts (`node -e`, `node <<'JS'`, `npx tsx -e`, `python3 -c`) to invent uncontracted edge cases after a `GREEN` Gate. Any newly discovered polish or follow-up enhancement belongs in a downstream wave after landing the current `Stable Checkpoint`.

### 2. Reply-First `Lead handoff` and `Peer handoff` Extraction Owned by the Plugin Server (`plugin/server/lead-mailbox.ts`, `plugin/server/peer-handoff.ts`)

1. **Reply-First Extraction Prompts (Zero Agent Shell/File Writes Required):**
   - Both `renderHandoffExtractionPrompt` in `plugin/server/lead-mailbox.ts` (`128,000` token ceiling) and `buildPeerHandoffExtractionPrompt` in `plugin/server/peer-handoff.ts` (`160,000` token ceiling) instruct the outgoing `Lead` or `Peer` to **put the entire Markdown handoff directly in its final assistant message, in one piece — without running shell commands or writing files to disk**, because the plugin server reads the final assistant message and persists it automatically.
2. **Plugin-Owned Extraction, Automatic Byte Capping (`capHandoffText`), and `180s` Timeout:**
   - Increase `HANDOFF_EXTRACTION_TIMEOUT_MS` (and `PEER_HANDOFF_TIMEOUT_MS`) from `90_000` (`90s`) to `180_000` (`180s`).
   - When the extraction turn completes (`onLeadTurnEnded` / `peerHandoff.finish`), the plugin server extracts the assistant message from `input.timeline` or by refetching the tail timeline (`daemon.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 20 })`), caps UTF-8 bytes cleanly via `capHandoffText` (`24 KB` max for `lead-handoff.md`, `12 KB` max for `peer-handoff-<task>.md` — truncating cleanly on a line/character boundary with a `...[truncated]` marker rather than failing when a model writes `17–18 KB`), and persists `<projectStateDir>/lead-handoff.md` or `<projectStateDir>/peer-handoff-<task>.md` in Node.js (`writeFileSync`).
   - If an agent still wrote a fresh file on disk (`<projectStateDir>/lead-handoff.md`, `<worktree>/.paseo-peer-handoff.md`, or `<projectStateDir>/peer-handoff-<task>.md`) whose content is non-empty and not an error/refusal message, the plugin accepts it as a secondary fallback.
3. **Never Clobber Last-Known-Good `lead-handoff.md` on Timeout or Interruption:**
   - Filter out refusal/error one-liners (e.g., replies starting with `"The handoff was not written"` or `"Permission denied"`) so they are never treated as valid handoff documents.
   - If extraction times out, is interrupted, or produces no valid handoff text, and a non-empty last-known-good `<projectStateDir>/lead-handoff.md` (not equal to `INTERRUPTED_HANDOFF_EXTRACTION_NOTE`) already exists on disk from a prior rotation, the plugin **preserves that existing `lead-handoff.md` on disk** and prepends a 1-line staleness notice in `renderSuccessorKickoff` informing the successor `Lead` that the latest extraction was interrupted so the prior handoff is shown alongside the authoritative live Machine-Verified Active Peer Roster and Ledger State Digest. Only when no prior valid `lead-handoff.md` exists on disk does the plugin write `INTERRUPTED_HANDOFF_EXTRACTION_NOTE`.

### 3. Non-Interpreter Heredoc Body Stripping in Layer-2 `Choke policy` and Antigravity Pre-Tool Hook (`src/choke.ts`, `plugin/server/core/choke.ts`, `plugin/bin/agy-pre-tool-hook.mjs`)

1. **`stripNonInterpreterHeredocs(command: string): string`:**
   - Before `splitShellSegments` and `extractWriteTargets` inspect a shell command string in `src/choke.ts` (synced to `plugin/server/core/choke.ts` and mirrored in `plugin/bin/agy-pre-tool-hook.mjs`), scan line-by-line for heredoc operators (`<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))`).
   - When the header line containing the heredoc operator does **not** invoke a shell or code interpreter (`sh`, `bash`, `zsh`, `dash`, `ksh`, `node`, `python`, `python3`, `ruby`, `perl`, `php`) in any of its command segments (e.g., `cat <<'EOF' > docs/notes.md` or `tee .scratch/plan.md <<EOF`), strip the literal heredoc body lines up to the closing delimiter line while preserving the header line (and any trailing pipeline on the header) so redirect targets (`> docs/notes.md` vs `> src/app.ts`) are still strictly validated against `judgeSeatFilePath` and `judgeFilePath`.
   - When the header line **does** invoke an interpreter (`python3 - <<'PY'`, `node <<'JS'`, `bash <<'EOF'`), preserve the entire heredoc body intact so `isInterpreterWriteBypass` and shell-segment judges continue to inspect executed code.

### 4. Worktree Test-Process Signal Allowance (`plugin/bin/exec-shim.mjs`) & Automatic Worktree Process Reaping (`src/workspace.ts`)

1. **Allow `kill` / `pkill` / `killall` Targeting Processes Scoped Inside a `Task worktree` (`plugin/bin/exec-shim.mjs`):**
   - Introduce `isTaskWorktreeScopedProcess(text: string): boolean`, which returns `true` when `text` (normalized to forward slashes) matches `/projects/[^/]+/worktrees/[^/]+` and does **not** reference Paseo or factory infrastructure (`Paseo.app`, `Paseo Helper`, `paseo-factory/bin/`, `runtime-bin/`, `bridge.mjs`, `driver.mjs`, `factory.mjs`, `claim.mjs`).
   - In `guardProcessKill(tool, args)`:
     - For `kill <pid>`, if `ps -ax -o pid=,command=` shows `isTaskWorktreeScopedProcess(cmdline)` is `true`, allow the signal (`return null`) even though `cmdline` contains `stateDir`.
     - For `pkill` / `killall`, if an argument matches `isTaskWorktreeScopedProcess(arg)`, do not treat its `stateDir` prefix as a daemon kill attempt.
2. **Automatic `reapWorktreeProcesses(worktreePath: string)` on Worktree Landing and Reset (`src/workspace.ts`):**
   - Export `reapWorktreeProcesses(worktreePath: string): number` in `src/workspace.ts` (synced to `plugin/server/core/workspace.ts`).
   - On POSIX hosts (`process.platform !== "win32"`), before removing a `Task worktree` directory in `finishLanding` (when a Task is accepted and landed) and in `prepareTaskWorktree` (when an existing worktree is reset/recreated), inspect `ps -ax -o pid=,command=` for any running process whose command line contains the normalized `worktreePath` (excluding `process.pid`, `process.ppid`, and any Paseo/factory infrastructure binary), send `SIGTERM`, wait briefly (`150ms`) if any matched PID remains alive, and send `SIGKILL` to any survivor.

## Consequences

- **Positive:**
  - `Lead` delivers visible user-facing screens early via vertical journey slices (`T-03+`) and accepts `GREEN` waves in a single turn via contract-bounded diff review + proof falsification, cutting `Lead` context burn per wave by `5–10×`.
  - `Lead handoff` (`128k`) and `Peer handoff` (`160k`) succeed deterministically across all providers (`codex`, `claude`, `opencode`, `pi`, `antigravity`, `copilot`) regardless of workspace-only OS sandboxes or Layer-2 write fences, and never destroy a prior valid `lead-handoff.md` if an extraction turn is interrupted.
  - `Supervisor` and `Lead` can write arbitrary English prose and Markdown comparisons/blockquotes inside `cat <<'EOF' > docs/...` heredocs without false-positive `seat-write-fence` denials, while `cat <<'EOF' > src/app.ts` and `python3 - <<'PY'` write bypasses remain strictly blocked.
  - `Peer`s can cleanly terminate their own worktree-scoped test processes (`@embedded-postgres`, Playwright/Chromium, local test servers), and the factory automatically reaps any leaked worktree processes when a `Task worktree` lands or resets.
- **Negative / Trade-offs:**
  - `reapWorktreeProcesses` invokes one synchronous `ps -ax -o pid=,command=` call during `finishLanding` and `prepareTaskWorktree` (`~5–10ms` on macOS/Linux), which is negligible compared to `git worktree add/remove`.
