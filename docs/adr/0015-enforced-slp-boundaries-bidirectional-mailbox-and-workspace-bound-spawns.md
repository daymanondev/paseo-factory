# ADR 0015 — Enforced SLP command & write boundaries (`Seat write fence`), bidirectional `Supervisor ⇄ Lead` mailbox (`supervisor dispatch` / `supervisor report`), provider-aware mode pinning, and workspace-bound `Agent` spawning with parentage & auto-archive

- **Status:** Accepted — 2026-10-20 (ratified by Andrew over a three-round `/grill-with-docs`, all-recommended; words "toàn bộ theo khuyến nghị của bạn" / "toàn bộ theo bạn khuyến nghị" / "chốt, nhưng đừng implement ở đây, tạo spec rồi tôi implement chỗ khác")
- **Grounded in:** Live Paseo Desktop forensic trace (`~/.paseo`, project `ai-test-043c7e`, 2026-10-20 09:34–10:01 +07:00) · `cuongntr/paseo-room` (`v0.19.0`, `67d28ff`, `src/room/prompts/contract/{supervisor,lead,peer}.md`, `src/runtime-plugin/server/{controller,paseo-port,gate,hooks}.ts`, `src/runtime-plugin/server/handlers/{actions,peer}.ts`) · `daymanondev/seatworks` (`v3`, `162e99bf`, `plugin/server/desk/{slots,opening,agents,watcher}.ts`, `plugin/server/adapters/paseo/agents.ts`) · `hoangnb24/codex-room-setup` (`91141ea`, `home/.config/codex-room/overlays/{supervisor,lead,peer}.config.toml`) · `sting8k/piggery` (`v0.10.4`, `1485990`, `manifests/slp.yaml`, `manifests/prompts/slp/{supervisor,lead,peer}.md`, `internal/core/agent.go`, `extensions/opencode/index.mjs`)
- **Amends:** ADR 0004 (adds Spool command-authority enforcement by seat plus `supervisor_dispatch` and `supervisor_report` spool intents) · ADR 0010 §1–§4/§6 (enforces hard `Supervisor` vs. `Lead` vs. `Agent` command and write boundaries at `<project-root>`, binds all seats and `Task worktree`s to the `Project`'s Paseo `projectId` / `workspaceId` with `parent` hierarchy and automatic archive on terminal settle) · ADR 0011 §3 & ADR 0013 §2–§4 (unifies `roles.ts` and `pi-home.ts` into a single role-prompt source of truth, makes `pinCreateMode` provider-aware and scoped strictly to working `Agent`s, and extends `<projectStateDir>/mailbox.jsonl` to bidirectional `Supervisor ⇄ Lead` delivery)

## Context

Live end-to-end testing of `paseo-factory` (`v0.0.21`) on Paseo Desktop (`~/.paseo`, project `/Users/andrewpham/Documents/code/ai-test`) with an `opencode` provider lane exposed five severe mechanism failures:

1. **Provider-blind `PINNED_MODE_ID = "default"` and `<project-root>` `liveContractFor` collision crashed every spawned `opencode` `Agent` and rotated `Lead` in ~250ms:**
   - `plugin/server/choke.ts` hardcoded `PINNED_MODE_ID = "default"` (Claude Code's "Always Ask" mode ID) and applied it whenever `factory.liveContractFor(config.cwd) !== undefined`.
   - In OpenCode (`provider: "opencode"`), `modeId` selects the OpenCode agent (`"build"` or `"plan"`); no `"default"` agent exists.
   - Worse, once `Lead` registered contracts `T-01` and `T-02` with `workspace: "/Users/andrewpham/Documents/code/ai-test"`, `liveContractFor(cwd)` matched both the `Task worktree`s (`worktrees/T-01`, `worktrees/T-02`) **and** `<project-root>` (`/Users/andrewpham/Documents/code/ai-test`). Every subsequently spawned `opencode` `Agent` (`f9282a0b`, `1513675c`, `d4732139`, `0bba208e`) and the 128k-rotated successor `Lead` (`d4eda38a`) were pinned to `modeId: "default"` and crashed immediately on turn start with `Agent not found: "default"`.
2. **Role prompt & bootstrap poisoning turned `Supervisor` into a second `Lead` and coder on `main`:**
   - `plugin/server/roles.ts` (`renderSeatContract("supervisor")`, `renderSeatBootstrap("supervisor")`) and `src/pi-home.ts` (`ROLE_PROMPTS.supervisor`) drifted from each other and explicitly handed `Supervisor` the `Lead`'s commands (`factory contract --task <id>...`, `factory run <task>...`), while omitting `factory lead dispatch` from `renderSeatBootstrap("supervisor")`.
   - Neither prompt nor runtime enforced the canonical SLP boundary (`paseo-room` `supervisor.md` / `actions.ts`, `piggery` `slp.yaml`, `codex-room` `supervisor.config.toml`): `Supervisor` wrote `DESIGN.md`, decomposed 14 tasks (`T-01..T-14`), ran `factory lead dispatch`, waited 6 seconds with `sleep 6 && ls`, concluded `Lead` was inactive, and proceeded to code and `git commit` `T-01..T-04` directly on `main` while `Lead` (`c5a54986`) was simultaneously inspecting the same `<project-root>` checkout.
3. **No write fence on `Supervisor` or `Lead` at `<project-root>` and no return channel (`Lead -> Supervisor`):**
   - `Choke policy` only inspected contracted working `Agent`s, leaving `Supervisor` and `Lead` with unrestricted source-code write and `git commit` access on `<project-root>`.
   - `mailbox.jsonl` (ADR 0013) only implemented `Supervisor -> Lead` and `Agent -> Lead` delivery (`to: "lead"`), with no `Lead -> Supervisor` reporting command or wake-up mechanism.
4. **Bare-`cwd` `agent.create` calls spawned orphan top-level Projects (`T-01`, `T-02`) and duplicate Workspaces in Paseo Desktop:**
   - `plugin/bin/driver.mjs` created git worktrees under `<projectStateDir>/worktrees/<task>` and called `agent.create.request` with a bare `cwd` (`.../worktrees/T-01`) — without a Paseo `workspaceId`, without binding to the `Project`'s Paseo `projectId`, and without `parent: leadAgentId`.
   - As documented in `seatworks` (`plugin/server/desk/slots.ts:282`: *"given a bare directory Paseo makes a new project, and the plugin API cannot remove one"*) and `paseo-room` (`src/runtime-plugin/server/paseo-port.ts:201-215`), passing a bare worktree directory to Paseo's `agent.create` caused Paseo Desktop to register brand-new top-level Projects named `"T-01"` (`prj_29068fd76a47cc47`) and `"T-02"` (`prj_3c1f5468b18e0e9d`) plus orphan Workspaces in `~/.paseo/projects/{projects,workspaces}.json`.
   - Similarly, `surface-rpc.ts` called `daemon.agents.create({ cwd: project.root })` for `Supervisor` and `Lead` without opening/reusing the `Project`'s Paseo `workspaceId`, creating duplicate `main` Workspaces on every seat creation or rotation.
5. **`/factory` in a normal chat bypassed `Supervisor` or coded in-place:**
   - `src/skill.ts` only wrote `~/.agents/skills/factory/SKILL.md` (ignoring `~/.claude/skills/factory/SKILL.md`) and instructed the caller to run `factory lead dispatch` directly (bypassing `Supervisor`) rather than routing through a deterministic seat-aware `factory supervisor dispatch` command.

## Decision

1. **Hard Spool Command Authority by Seat (`Supervisor` vs. `Lead` vs. `Agent`).**
   - Every spool-submitting CLI stamps `submitter` (`PASEO_AGENT_ID || "owner"`) and `seat` (`PASEO_FACTORY_SEAT`, when present in the shell environment, corroborated by the plugin against live daemon agent labels).
   - **Enforced Spool matrix:**
     - `Supervisor` (`seat === "supervisor"`): May submit **`lead_dispatch`**, **`supervisor_dispatch`** (auto-routed to `lead_dispatch`), and **`accept` (`by: "supervisor"`)** (only on the `Owner`'s word). Any `contract`, `spawn`, or `respawn` request from `seat === "supervisor"` is **refused at the Spool** with code `supervisor-cannot-contract-or-run` and a message directing `Supervisor` to `factory lead dispatch`.
     - `Lead` (`seat === "lead"`): May submit **`contract`**, **`spawn`**, **`respawn`**, **`repoke`**, **`needs_human`**, **`meter`**, **`accept` (`by: "lead"`)** (clean green intermediate tasks with no Fresh-eyes `CONCERN`), and **`supervisor_report`**.
     - Working `Agent` (`seat === "agent"` or bound task worker): May submit **`claim`** (`factory-claim`) only. All `factory` orchestration requests from a working `Agent` are refused (`agent-cannot-orchestrate`).
     - Human `Owner` (`seat === undefined` / `"owner"`): Retains full authority across all commands (`supervisor dispatch`, `lead dispatch`, `contract`, `run`, `accept --by owner`, `retro`, `vault`).

2. **`Seat write fence` on `<project-root>` (`Choke policy` + `Git shim` enforcement for `Supervisor` and `Lead`).**
   - While `Supervisor` and `Lead` stand in `cwd = <project-root>` (ADR 0010), all product/feature source-code implementation must occur exclusively inside isolated `Task worktree`s owned by contracted working `Agent`s and enter `<project-root>` only via `Landing on Accept`.
   - **Allowed write whitelist on `<project-root>` for `Supervisor` and `Lead` (`SEAT_MEMORY_WHITELIST`):**
     - `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `GLOSSARY.md`, `.gitignore`, `.worktreeinclude`, `docs/**`, `.scratch/**`, plus `<stateDir>/**` and `/tmp` / `TMPDIR`.
   - **`Choke policy` enforcement (`seat-write-fence`):**
     - `Choke` intercepts `agent.permission_requested` for `Supervisor` and `Lead` seats as well as contracted working `Agent`s.
     - Any file-write tool call or shell command from `Supervisor` or `Lead` that writes, edits, removes, or installs packages (`npm install`, `pnpm add`, `yarn`, `rm`, `mv`, `cp`, `>`, `tee`, etc.) targeting paths in `<project-root>` outside `SEAT_MEMORY_WHITELIST` is **denied** (`permit_denied`, rule `"seat-write-fence"`) with a clear message: *"Supervisor and Lead may only edit project memory/docs (AGENTS.md, CONTEXT.md, docs/**, .scratch/**); dispatch implementation work to Lead / Task Agents."*
   - **`Git shim` enforcement (`seat-git-fence`):**
     - When `PASEO_FACTORY_SEAT === "supervisor"`, the `Git shim` blocks `git commit`, `git merge`, `git cherry-pick`, `git rebase`, `git switch -c`, and `git checkout -b` on `<project-root>` (`git_blocked`, rule `"supervisor-git-fence"`).
     - When `PASEO_FACTORY_SEAT === "lead"`, the `Git shim` allows `git merge` / `git cherry-pick` / `git commit` on `<project-root>` **only** when resolving a `pending-conflict` from `Landing on Accept` or committing files strictly within `SEAT_MEMORY_WHITELIST`; staging or committing product source files outside `SEAT_MEMORY_WHITELIST` on `<project-root>` is refused (`git_blocked`, rule `"lead-git-fence"`).

3. **Bidirectional `Supervisor ⇄ Lead` Mailbox (`mailbox.jsonl`), `factory supervisor report`, and Fire-and-End-Turn Law.**
   - `<projectStateDir>/mailbox.jsonl` (ADR 0013 §4) is generalized into a **bidirectional per-Project Seat Mailbox** supporting both `to: "lead"` (default for backward compatibility) and `to: "supervisor"`:
     - `mail_queued`: `{ seq, ts, mailId, to?: "lead" | "supervisor", from: "supervisor" | "lead" | "owner" | "peer" | "system", kind: "directive" | "verdict" | "needs_human" | "report", task?: string, text: string }`
     - `mail_delivered`, `mail_acked`, and `mail_requeued` carry `to?: "lead" | "supervisor"` and track per-recipient (`lead` vs. `supervisor`) in-flight delivery state independently on the serialized per-Project lane (`projectLane(slug)`).
   - **New CLI & Spool command `factory supervisor report [--workspace <dir>] [--project <slug>] --message "<summary>"` (`kind: "supervisor_report"`):**
     - Called by `Lead` when a directive's task wave is fully `Accepted` and landed, or when `Lead` needs an `Owner` product/scope decision or escalates a `needs_human` blocker.
     - Automatically ensures the `Project`'s `Supervisor` seat exists (`ensureSeat("supervisor")`), appends `mail_queued` (`to: "supervisor"`, `from: "lead"`, `kind: "report"`), and delivers into `Supervisor` when `Supervisor` is idle (or queues until `Supervisor`'s active turn ends at `agent.turn_ended`, acknowledging on `outcome === "completed"`).
   - **Automatic plugin escalation to `Supervisor`:**
     - Whenever a `Task` transitions to `needs_human`, the plugin enqueues notifications to both `Lead` (`to: "lead"`) and `Supervisor` (`to: "supervisor"`, `kind: "needs_human"`) so neither seat can miss a stalled or ceiling-exhausted task.
   - **Fire-and-End-Turn Law:**
     - Both `Supervisor` (after running `factory lead dispatch`) and `Lead` (after running `factory supervisor report` or when waiting on background mail) are instructed in their immutable role contracts to **end their turn immediately** and never run `sleep` or filesystem polling loops.

4. **Provider-Aware Mode Pinning (`pinCreateMode`), Strict Worker Recognition, and Unified Role Prompts (`src/roles-contract.ts`).**
   - **Strict working `Agent` recognition (`isContractedWorkerCreate`):**
     - `choke.pinCreateMode(config, labels)` and `choke.onPermissionAsked` never classify an agent with `labels.seat === "supervisor"` or `labels.seat === "lead"` as a contracted Task worker, even when a Contract's `workspace` equals `<project-root>`.
     - A created agent is recognized as a contracted Task worker only when its `cwd` is inside a managed `Task worktree` (`<projectStateDir>/worktrees/<task>`) or when it has no `seat=supervisor|lead` label and matches a live non-worktree Contract.
   - **Provider-aware `pinCreateMode`:**
     - `PINNED_MODE_ID = "default"` is applied **only** when the provider id (the prefix before `/`) is `"claude"` (Claude Code).
     - For `"opencode"`, `"codex"`, `"pi"`, and all other providers, `pinCreateMode` does **not** overwrite `config.modeId` with `"default"`, preserving each provider's native execution mode (e.g. OpenCode's `"build"` mode) while Paseo still routes `agent.permission_requested` events to `choke.onPermissionAsked`.
   - **Single Source of Truth for Role Contracts (`src/roles-contract.ts`):**
     - Extract all role contract prompts (`Supervisor`, `Lead`, `Agent`) and bootstrap builders into a single pure module `src/roles-contract.ts` (synced into `plugin/server/core/roles-contract.ts`) consumed by both `plugin/server/roles.ts` (`config.systemPrompt` injection for all providers: `opencode`, `claude`, `codex`, `pi`) and `src/pi-home.ts` (`<stateDir>/pi-agent/<role>/APPEND_SYSTEM.md`).

5. **Seat-Aware `/factory` Entrypoint (`factory supervisor dispatch`) and Multi-Provider Skill Installation.**
   - **New CLI & Spool command `factory supervisor dispatch [--workspace <dir>] [--project <slug>] --message "<directive>"` (`kind: "supervisor_dispatch"`):**
     - Inspects the caller's `PASEO_FACTORY_SEAT` (corroborated by the plugin):
       - **Called from a normal chat session (`PASEO_FACTORY_SEAT` unset):** Automatically ensures the `Project`'s `Supervisor` seat (`ensureSeat("supervisor")`), enqueues the directive into the `Supervisor` mailbox (`to: "supervisor"`, `from: "owner"`, `kind: "directive"`), wakes `Supervisor`, and returns a structured reply instructing the normal chat agent to **stop immediately without editing any files** and directing the `Owner` to the `Supervisor` session (`agentId`).
       - **Called from inside `Supervisor` (`PASEO_FACTORY_SEAT === "supervisor"`):** Transparently routes the directive straight into `lead_dispatch` (`to: "lead"`, `from: "supervisor"`, `kind: "directive"`), ensures/wakes `Lead`, and instructs `Supervisor` to end its turn and wait for `Lead`'s report.
   - **Multi-provider skill reconciliation:**
     - At plugin boot, `ensureFactorySkillSafe` reconciles the `/factory` `SKILL.md` into both `~/.agents/skills/factory/SKILL.md` (read by `pi` and `opencode`) and `~/.claude/skills/factory/SKILL.md` (read by `claude`), teaching a single deterministic rule: run `factory supervisor dispatch --workspace "$PWD" --message "<directive>"` and immediately end your turn.

6. **Paseo Workspace-Bound Seat & `Agent` Creation, Parentage (`parent`), and Automatic Worktree/Workspace Archive.**
   - **Never call `agents.create` with an unbound bare worktree `cwd`:**
     - In accordance with `seatworks` (`slots.ts:282`, `adapters/paseo/agents.ts:130-154`) and `paseo-room` (`paseo-port.ts:201-215, 471-513`), the plugin resolves the `Project`'s canonical Paseo workspace and `projectId` via `paseo.workspaces.open({ cwd: project.root })` (falling back gracefully when the daemon fake in unit tests does not expose `workspaces`).
     - **`Supervisor` and `Lead` creation (`ensureSeat`):** Placed inside the `Project`'s existing Paseo workspace (`workspaces.ref(projectWorkspaceId).agents.create(...)`), with `Lead` carrying `parent: supervisorAgentId` when a live `Supervisor` exists for the `Project`.
     - **Working `Agent` (Peer) creation (`spawn` / `respawn`):**
       - When creating a `Task worktree` at `<projectStateDir>/worktrees/<task>`, the plugin/driver registers its Paseo workspace explicitly bound to the `Project`'s `projectId` (`workspaces.create({ title: "<project-slug> <task>", source: { kind: "directory", path: worktreePath, projectId } })`) and creates the working `Agent` inside that workspace with **`parent: leadAgentId`** (`paseo.parent-agent-id = leadAgentId`) and labels `{ seat: "agent", project: <slug>, task: <task> }`.
       - Because the worktree workspace carries `projectId` and the `Agent` carries `parent: leadAgentId`, Paseo Desktop groups the worktree under the existing `Project` and nests the working `Agent` under `Lead`, **never** creating bogus top-level Projects (`T-01`, `T-02`) in `~/.paseo/projects/projects.json`.
   - **Automatic Archive on Terminal Settle (`Attempt` finish / `Accept`):**
     - When a working `Agent`'s Attempt finishes (`gate_finished`) or is superseded on `Respawn`, the finished/dead working `Agent` is archived (`agents.ref(agentId).archive()`).
     - When a `Task` is `Accepted` (`attempt_accepted`) and its `Task worktree` is removed, its temporary Paseo worktree workspace (`workspaceId`) is also archived (`workspaces.archive(workspaceId)`), leaving zero orphan workspaces in Paseo Desktop.

## Consequences

- `CONTEXT.md` updates **Supervisor**, **Lead**, **Choke policy**, **Git shim**, **Spawn**, **Task worktree**, and **Lead mailbox**, and adds **Seat write fence** and **Supervisor mailbox**.
- `OpenCode`, `Claude`, `Codex`, and `Pi` lanes all spawn working `Agent`s and rotate `Lead`s cleanly without `Agent not found: "default"` crashes.
- `Supervisor` and `Lead` are mechanically prevented from coding on `<project-root>` or usurping each other's commands, and communicate bidirectionally via `<projectStateDir>/mailbox.jsonl`.
- Spawning `Task` `Agent`s in `Task worktree`s never pollutes Paseo Desktop with rogue top-level Projects or unarchived Workspaces.
