# ADR 0004 — One writer: the plugin owns the Ledger and runs the Gate; CLIs only submit

- **Status:** Accepted — 2026-10-04
- **Deviates from:** roadmap §2 and ticket 08, which delivered two MCP commands to the
  Agent and put Reports inside the Workspace.

## Decision

- **The plugin process is the only writer of the Ledger and the only runner of Gates.**
  The Owner's CLI (`factory contract`, `factory accept`) and the Agent's CLI
  (`factory-claim`) never touch the Ledger: they drop a request file into
  `stateDir/spool/requests/` and wait for the reply. Each request carries an
  id, so a retried call never starts a second Gate. *(Amended 2026-10-07,
  ticket 08, to match what shipped: the id dedupes replayed request files —
  a request whose reply already exists is moved along unprocessed. A fresh CLI
  invocation is a new request by design: it opens the next numbered Attempt,
  so every gate run is recorded in the ledger rather than silently deduped.
  A cache that returns an old verdict for a re-claimed commit was rejected:
  a red caused by a dirty tree must be re-claimable after cleanup, same sha
  and all.)* *(Amended 2026-10-09, v0.0.5 ticket 03: the Driver CLI
  (`factory run`) joins the spool — a `spawn` request per task, validated
  by the plugin (scope-mandatory for parallel runs, workspace overlap
  against live contracts, task state) and ledgered
  `spawn_dispatched`/`spawn_refused`; only on ok does the driver create the
  agent over the daemon's own WebSocket RPC, idempotency-keyed by task id.
  The one-writer law is unchanged — the driver never writes the ledger.)*
  *(Amended 2026-10-10, v0.0.8 ticket 04: the Meter rides the same law — the
  driver captures the daemon's usage snapshot (`lastUsage`, live-only truth
  the daemon persists nowhere) at each task's terminal moment, one re-fetch
  against the usage-merge race, and submits one `meter` request through the
  spool; the plugin validates (shape, task known) and appends one
  task-scoped `meter_written` line per task per driver run. A refused meter
  errors back with no ledger line. Still unchanged: the driver never writes
  the ledger.)* *(Amended 2026-10-15, v0.0.13 / ADR 0009: the Factory surface
  client UI communicates with `plugin/index.server.ts` over Paseo plugin RPC;
  because `server.handle(...)` runs inside the plugin process that owns the
  single `Factory` instance, Owner acts triggered from the surface (`Accept`
  with `accepted_by: "owner"` and `Retro`) call `factory.accept` and
  `factory.retro` directly in-process, preserving the single-writer law
  without round-tripping through the external CLI file spool.)*
- **The Agent gets the Claim as a CLI on its `PATH`**, put there by the plugin's
  `agent.session_open` before-hook — not as an MCP tool. It accepts only `--task` and
  `--sha`. *(Amended 2026-10-07, ticket 06: the original wording said `agent.create`;
  that hook's `env` is not re-applied on resume, while `agent.session_open` fires for
  create, resume, refresh and import — daemon `agent-manager.js` `buildLaunchContext` —
  so it is the single injection point. Amended 2026-10-07, ticket 08:
  `--wait-secs` tunes how long the CLI waits for the plugin's reply; it changes
  nothing the Agent can ask the factory to do.)*
- **All state lives in `stateDir`, outside the Workspace**: Ledger, spool, Reports.
  Reports inside the Workspace would dirty the tree the next Attempt must find clean, and
  the Agent could edit them.

## Why

- If a CLI wrote the Ledger itself, the Gate would run inside the Agent's own process:
  under its tool timeout, killable by it, with its environment. All three reference
  systems funnel writes through one daemon-side writer (seatworks v3 and paseo-room via a
  file spool, seatworks rebuild via a unix socket).
- MCP reaches pi only through pi-mcp-adapter, and Paseo injects without `directTools`, so
  the Agent must go through the adapter's search-then-call proxy — fragile for the GLM
  model chosen for the first run. A shell command works for every provider; seatworks
  rebuild also reaches pi without MCP.

## Considered options

- CLIs write the Ledger directly under an `O_EXCL` lock: rejected for the Gate-placement
  reason above.
- One file per event via hard links (paseo-room) or SQLite (seatworks rebuild): not needed
  with a single writer; JSONL stays until the factory has to write events and to-dos
  atomically together.
