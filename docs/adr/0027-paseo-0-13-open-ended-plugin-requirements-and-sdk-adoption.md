# ADR 0027 — Paseo `0.13.0` Open-Ended Plugin Requirements (`>=0.13.0`), `agent.turn_ended` Tail-Timeline Refetch, and Paseo `0.13.0` UI/SDK Adoption

- **Status:** Accepted — 2026-10-25 (ratified by Andrew over `/grill-with-docs` while upgrading `paseo-factory` and its three companion plugins to Paseo `0.13.0`)
- **Grounded in:** `@getpaseo/{plugin,protocol,client,server,cli}@0.13.0` · Official `paseo-plugin` skill (`requirements.paseo: ">=0.13.0"`) · Live `~/.paseo` `0.13.0` daemon diagnostics (`Plugin "..." requires Paseo >=0.11.0 <0.12.0. Your daemon is 0.13.0.`)
- **Amends:** ADR 0009 (Factory surface contributions), ADR 0012 (Companion plugin catalog & requirements), ADR 0013 / ADR 0018 (Lead handoff extraction fallback), and ADR 0017 (Workspace & seat listing across background workspaces)

## Context

When Paseo Desktop / daemon upgraded from `0.11.x` to `0.13.0`, all four plugins in the factory family (`paseo-factory`, `factory-burn-lab`, `factory-connector`, `factory-release-lab`) entered `status: failed` at daemon boot with:

```text
Plugin "paseo-factory" requires Paseo >=0.11.0 <0.12.0. Your daemon is 0.13.0.
```

Inspecting the diff between `@getpaseo/*@0.11.2` and `@getpaseo/*@0.13.0` surfaced five concrete findings:

1. **Overly Strict Upper Bound in `paseo-plugin.json`:**
   - All four plugins had `"requirements": { "paseo": ">=0.11.0 <0.12.0" }` hardcoded from early `0.11` scaffolding.
   - Paseo's own built-in plugins (`git`, `terminal`, `files`, `Voice Dictation`) and official `paseo-plugin` skill use an open-ended minimum constraint (`">=0.13.0"`) without an upper `<0.14.0` cap so minor daemon updates (`0.13 -> 0.14`) do not brick installed plugins unless a real breaking change occurs.
2. **Breaking Behavioral Change in `agent.turn_ended` (`timeline: []`):**
   - In `@getpaseo/server@0.13.0` (`plugins/lifecycle/index.js`), `publishAgentStream` hardcodes `timeline: []` on every `agent.turn_ended` event (`@deprecated Always empty` in `@getpaseo/plugin@0.13.0`).
   - `completeHandoff` in `plugin/server/lead-mailbox.ts` relied on `lastAssistantText(input.timeline)` as its fallback when the outgoing Lead answered the handoff extraction prompt in assistant text instead of writing `<projectStateDir>/lead-handoff.md`. With `input.timeline` always `[]` on Paseo `0.13.0`, `lastAssistantText` would always return `null`.
3. **Deprecated Client Entrypoints and Bundler Loader Parity:**
   - `@getpaseo/plugin/client/react-native` is deprecated in `0.13.0`; all UI primitives (`View`, `Text`, `Pressable`, `TextInput`, `ScrollView`, `Modal`, `StyleSheet`, `useToast`, `Markdown`, `copyText`) are now consolidated in `@getpaseo/plugin/client/ui`.
   - `context: "workspace"` on `client.addWorkspacePanel` is deprecated (workspace panels are inherently workspace-scoped).
   - `@getpaseo/server@0.13.0`'s esbuild plugin compiler adds `loader: { ".svg": "text" }`.
4. **Background Workspaces & `includeBackground: true`:**
   - Paseo `0.13.0` introduces `background?: boolean` on workspace/agent creation and filters background items out of `agents.list` and `fetch_workspaces_request` by default unless `includeBackground: true` is passed.
   - Internal seat resolution (`lead-mailbox.ts`, `surface-rpc.ts`, `spool.ts`) and worktree workspace cleanup (`daemon-cli.ts`) must pass `includeBackground: true` so background agents/workspaces are never missed.
   - While `paseo-factory`'s `Task worktree` (`Peer · <Task>`) remains visible in the sidebar while active (and is archived upon `Accept`), autonomous non-interactive workspaces in `factory-burn-lab` (`Scout Pool`, `OSS Lab`, `Proto Arena`, `Night Shift`) benefit from `background: true` so they do not clutter the human's main Paseo sidebar.
5. **High-Leverage Paseo `0.13.0` Client SDK Additions:**
   - `@getpaseo/plugin/client/ui` ships native `<Markdown>` rendering and clipboard `copyText(text)`.
   - `@getpaseo/plugin/client` ships `useTabState(tab, schema, fallback)` for persisting workspace panel state across tab switches and reloads, plus `client.addCommandCenterItem(...)` for registering `⌘K` Command Center shortcuts.

## Decision

1. **Open-Ended `>=0.13.0` Requirement Across All Four Repositories.**
   - Upgrade `@getpaseo/plugin` (and `@getpaseo/protocol` in `paseo-factory`) to `0.13.0` across `paseo-factory`, `factory-burn-lab`, `factory-connector`, and `factory-release-lab`.
   - Set `"requirements": { "paseo": ">=0.13.0" }` in `plugin/paseo-plugin.json` across all four plugins (no upper `<0.14.0` bound).
   - Add `loader: { ".svg": "text" }` to `scripts/check-bundle.mjs` across all four repositories to match `@getpaseo/server@0.13.0`'s compiler.

2. **On-Demand Tail Timeline Refetch in `completeHandoff` (`plugin/server/lead-mailbox.ts`).**
   - When `completeHandoff` finds no fresh `<projectStateDir>/lead-handoff.md` and `input.timeline` is empty (as is always true on Paseo `0.13.0`), it calls `daemon.agents.ref(input.agentId).timeline.refetch({ direction: "tail", limit: 20 })` and extracts `lastAssistantText` from the refetched tail entries before falling back to the machine-verified roster and ledger digest note.

3. **`includeBackground: true` on Internal Queries & `background: true` on Autonomous Burn Lab Workspaces.**
   - Pass `includeBackground: true` in `daemon.agents.list({ filter: { includeArchived: false, includeBackground: true, ... } })` and `fetch_workspaces_request` (`includeBackground: true`) across `paseo-factory` (`plugin/server/{lead-mailbox,surface-rpc,spool,daemon-cli}.ts`).
   - Keep `paseo-factory`'s `Task worktree` (`Peer · <Task>`) visible (`background` unset) so the Owner can inspect live Peer progress in the sidebar until `Accept` archives it; set `background: true` on autonomous workspaces opened/created by `factory-burn-lab`.

4. **Migrate to `@getpaseo/plugin/client/ui` and Adopt `<Markdown>`, `copyText`, `useTabState`, and `addCommandCenterItem`.**
   - Replace all imports of `@getpaseo/plugin/client/react-native` with `@getpaseo/plugin/client/ui` and remove deprecated `context: "workspace"` from `client.addWorkspacePanel` across all four plugins.
   - In `paseo-factory`:
     - Render `contract.description` and `attempt.report` in `TaskDetailModal` (`plugin/client/factory/tasks.tsx`) and `proposal.text` in `TimelinePane` (`plugin/client/factory/timeline.tsx`) with `<Markdown>`, and add 1-click `Copy` buttons (`copyText`) on `Report.md`, `Gate log`, and `Retro` proposals.
     - Persist the active `FactoryShell` tab (`tasks` / `seats` / `timeline` / `vault` / `plugins`) and Project Switcher scope (`pickedRoot`, `hasPickedScope`) via `useTabState(panelTab, FactoryTabStateSchema, ...)` (`plugin/client/factory/shell.tsx`, `plugin/client/factory/entries.tsx`).
     - Register four `⌘K` Command Center shortcuts in `plugin/index.client.tsx` (`factory-open-screen`, `factory-open-panel`, `factory-run-retro`, `factory-sync-vault` — matching Paseo's `/^[a-z][a-z0-9-]*$/` client contribution ID law).

## Consequences

- All four plugins load cleanly (`status: running`) on Paseo `0.13.0` and future `0.13.x` / `0.14.x` releases without artificial semver upper-bound failures.
- `Lead handoff` continues to capture assistant-text handoff summaries on Paseo `0.13.0` despite `agent.turn_ended` emitting `timeline: []`.
- Task reports, contract descriptions, and retro proposals render rich Markdown with 1-click clipboard copy, panel tab/project selections survive workspace tab switches, and `⌘K` provides direct keyboard access to core Factory actions.
