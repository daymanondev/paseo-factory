# 0057 — Every Seat Replacement Is a Handoff, Supervisor Handoff, Lead Decoupled from the Supervisor, and a Wide, Colourful Factory Tab

- **Date:** 2026-11-12
- **Status:** Accepted. The Owner confirmed Q1–Q27 in a second `/grill-with-docs` ("toàn bộ theo bạn khuyến nghị"). Implementation is tracked in `.scratch/factory-seat-handoff-and-wide-panel/`. **v0.6.1 ships Decisions 4 and 5** (the Lead created unparented, the released-Supervisor rule, lost-Lead recovery; no hidden Supervisor, Supervisor binding/candidates/adoption), **Decision 11's three hygiene fixes**, and **the §11 spike** (`factory.seats.directory`, the Factory header button, and the read-only composer pill starter). Everything else — the Handoff engine (Decisions 1–3, 6–7), the wide colourful tab and pill writes (Decisions 8–10) — ships in v0.7.0 (issues 05–14).
- **Amends:** [ADR 0056](0056-slim-factory-panel-slp-only-and-guided-onboarding.md) §4 (entry points), §5 (layout, colour rule, mobile scope) and §8 (Lead handoff is no longer "unchanged"). [ADR 0018](0018-airtight-lead-handoff-and-smart-default-fresh-eyes.md) and [ADR 0050](0050-pause-aware-quiet-point-handoff-loud-degraded-completion-and-rolehome-skill-deny.md): Lead handoff gains Owner-initiated reasons and a plugin-built substitute handover. [ADR 0035](0035-peer-handoff-rolling-wave-decomposition-and-modular-test-isolation.md): Owner-initiated Peer handoff. [ADR 0015](0015-enforced-slp-boundaries-bidirectional-mailbox-and-workspace-bound-spawns.md)/[ADR 0017](0017-native-paseo-role-providers-and-slp-seat-recognition.md): the Lead is no longer created as a Paseo child of the Supervisor, and the plugin never creates a hidden Supervisor.

## Context

v0.6.0 over-corrected. Changing a seat's model now takes five taps behind the header `⋯`. The panel is a narrow single column in the explorer pane. Colour appears only on exceptions, so the Owner cannot tell at a glance who is doing what.

The Owner replaces seats for two reasons: a provider running out of quota, and a model that is stuck or doing poor work. Replacing a seat today goes wrong in four ways:

- **Cross-provider change and Rotate drop the history.** A cross-provider lane change and the Rotate button both cancel and archive the seat with no handover. The successor is fed whatever stale `lead-handoff.md` is on disk.
- **Replacing the Supervisor kills the Lead.** The Owner replaces the Supervisor by changing its provider, and this cascade-archives the Lead, because the Lead is created with `parent: supervisorId`. The plugin does not notice: it keeps a stale Lead binding and does not requeue held mail. A live repro (2026-11-12, goal-partner) showed the replacement Lead starting from a handover written eight hours earlier.
- **Supervisor recovery is wrong in three ways:**
  - The Supervisor binding in `project.json` is set once and never re-bound.
  - A Supervisor chat opened from Paseo's own picker carries no `factory-*` labels, so the plugin cannot see it.
  - The plugin silently creates a hidden Supervisor from a Lead report, which ADR 0056 forbids.
- **Peer successors ignore model changes.** A Peer handoff successor copies the outgoing Peer's provider even after the Owner changed the `worker` lane.

## Decision

1. **Every seat replacement goes through Handoff. The only exception is the Owner's explicit Replace now.**
   - **Model switch:** a change within the same provider family switches model and thinking in place and keeps the session. This is unchanged for the Supervisor and the Lead.
   - **Handoff:** a change across provider families, or the Owner's **Hand off now**, creates a new agent with a handover.
   - The Rotate button and every "retire seat" path that archives without a handover are removed.
2. **A handoff always finishes, even when the outgoing seat is dead.**
   - The outgoing seat may error, or give no extraction reply within about 90 seconds. For the context-mark reason the extraction fuse may instead be exhausted.
   - In any of these cases the plugin builds a **Substitute handover** from the Ledger digest, the Project notebook, git state, open Tasks and the last timeline messages, and labels it as plugin-built.
   - **Replace now** skips extraction entirely and uses the Substitute handover.
3. **Supervisor handoff exists.**
   - **Triggers:** a cross-provider change of the Supervisor lane, or Hand off now on the Supervisor row.
   - **Handover content:** a short reply-first handover covering Owner goals, decisions taken and open questions.
   - **Successor kickoff:** the handover plus the live Lead id, open Tasks and the count of held reports.
   - **During the handoff:** the Lead keeps working, and Lead reports addressed to the Supervisor are held and delivered to the successor.
   - **Context mark:** the Supervisor never hands off on its own. At its mark it only raises a Needs-you suggestion, because it is the chat the Owner types into.
4. **The Lead is no longer a Paseo child of the Supervisor.** Archiving a Supervisor therefore never cascades to the Lead.
   - **Existing parented Leads:** Paseo cannot re-parent a live agent. When a Supervisor with a parented live Lead is replaced, the old Supervisor is released but not archived, and is archived after that Lead's next handoff.
   - **Lead archived from outside:** the plugin detects it through `agent.archive.after`. It clears the binding, requeues delivered-but-unacked mail and recreates the Lead with a handover at the next pump. The handover is fresh, or a Substitute handover when the one on disk is stale.
5. **The plugin never creates a hidden Supervisor.** Without a live bound Supervisor:
   - Reports are held, and Needs you shows "No Supervisor · N reports waiting".
   - When the bound Supervisor is gone, the next Supervisor chat the Owner opens binds automatically.
   - When the old one is still live, the panel offers "Use this chat as Supervisor".
6. **Owner-initiated Peer handoff.**
   - **Trigger:** "Replace this Peer" on a Peer row, with an optional model choice.
   - **What carries over:** the worktree, the Contract and the Attempt count. It does not consume the once-per-epoch automatic budget, and the Lead is notified by mail.
   - **`worker` lane changes:** they apply to future Peers. Every Peer successor, automatic or Owner-initiated, follows the current `worker` lane unless the Owner chose a model for that Peer.
7. **The handoff mark follows the model.** The Lead mark is the lower of `128k` and 65% of the model's context window. When the window is unknown, the mark stays at `128k`. The context bar shows the real mark, and a provider that reports no usage shows "context unknown" instead of zero.
8. **The Factory tab is wide, and models are edited where they are shown.**
   - **Entry:** every workspace header gets a Factory button carrying a Needs-you badge. It opens Factory as a main-area tab with two columns.
   - **Narrow layout:** the explorer pane keeps a one-column layout.
   - **Model chips:** every seat row and the "Default worker" row carry a model chip that is edited in place. The edit is Project-scoped by default, with a secondary "Set as machine default".
   - **Main screen contents:** Lane profiles and Project skill packs move onto the main screen.
   - **`⋯` menu:** it keeps only Reset, Delete and Open Settings.
   - **Composer pill:** Supervisor, Lead and Peer chats get one. Its popover shows status, up to six quick-switch models, "Other model…" and Hand off now.
9. **Colour carries meaning.** This replaces ADR 0056's "colour only for exceptions". The palette comes from pi agent's theme, with darker variants on the light theme, and every colour is paired with a word or icon.
   - **Role identity:** Supervisor violet, Lead blue, Peer teal.
   - **State:** green working, amber waiting, magenta reserved for a handoff or provider change in motion, red reserved for Owner action, grey idle.
   - **Thinking level:** the model chip uses pi's ramp.
10. **Mobile may write a small set of things.** It may change a seat's model, Hand off now or Replace now, cancel a scheduled handoff, and "Use this chat as Supervisor". Onboarding, Reset/Delete, skill packs, Open Design Sync/Studio and Settings stay desktop-only.
11. **Two releases.**
    - **v0.6.1** ships items 4 and 5 and three hygiene fixes:
      - a Project-scoped lane save no longer rewrites machine-wide role providers;
      - a stale handover file is marked stale;
      - Start Supervisor with a directive still sends the kickoff packet, and the binding is written through the state writer.
    - **v0.6.1 also carries a spike:** a read-only composer pill and the header button opening today's panel, to verify on real Paseo.
    - **v0.7.0** ships everything else.

## Considered Options

- **Keep cross-provider change as a plain retire, but warn first.** Rejected. The Owner replaces seats precisely when they are failing, so a warning does not save the history and a handover does.
- **Block the handoff until the Owner reviews the handover.** Rejected (Q13). The handoff is automatic, and "View handover" is always available.
- **Let the Supervisor auto-hand off at its mark like the Lead.** Rejected (Q25). Replacing the chat the Owner is typing into, mid-conversation, is worse than a suggestion.
- **Keep the Lead parented and re-point it on Supervisor replacement.** Not possible, because Paseo exposes no re-parent operation.
- **Composer pill as a nested menu only.** Kept as the fallback if the v0.6.1 spike shows the popover is too small or absent.

## Consequences

- `CONTEXT.md` gains Model switch, Handoff (reason, progress), Supervisor handoff, Substitute handover and Handoff mark. It also rewrites the Lead, Lead handoff, Peer handoff, Lead mailbox and Factory surface entries. Each entry changes in the release that ships its behaviour, and never ahead of it.
- Handoff is a per-seat progress record visible to the surface. Its states are scheduled, handing over, creating successor, done, substitute handover and failed. The record carries a reason (`context-mark` / `provider-change` / `owner`), the source and target lane, and the waiting-Peer count.
- The plugin registers per-workspace header buttons and per-agent composer pills from an all-Projects seat directory. These are the first app-wide contributions since the v0.6.0 slim-down.
