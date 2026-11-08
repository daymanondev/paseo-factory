/**
 * The Workspace's Agent Drawer (T-07b, T-07c) — the read-only, role-aware
 * inspector a live seat/Peer node opens on `/flow`. The prototype's CSS and
 * interaction design are reused (`design/agent-drawer.css`: the fixed aside,
 * its own scroll region, the scrim on narrow viewports); its JS is mock-only
 * and never ported — the header folds from `flowScreenModel` (T-07a), the
 * Work tab renders the fold's own ledger-bound chips, and the Transcript tab
 * rides the EXISTING `factory.agent.transcript` client (`web/src/transcript.ts`)
 * through the sidecar's envelope law: entries, `unavailable` with its reason,
 * and a refusal are all data, never a throw. T-07c adds the remaining
 * role-aware tabs, every value from the EXISTING snapshot: Session (the
 * daemon's own row — lane, presence, attention, cwd, the snapshot's stamp),
 * Attempts (each owned Task's ladder — n, verdict, claimed sha, deep-linked),
 * Handoff (the Lead's rotation state, Lead nodes only), and Resources (the
 * usage rows the rollup attributes, or the honest "No usage recorded").
 * T-13a adds the Supervisor Live Chat panel (`supervisor-chat.tsx`) as the
 * body's first child on the Supervisor seat — read-only, no composer.
 * Read-only throughout — no Start/Rotate/Revoke/Respawn control anywhere
 * (ADR 0017); the drawer closes on Escape and via its close button and
 * returns focus to the node.
 */
import { useEffect, useId, useRef, useState } from "react";
import "../../../design/agent-drawer.css";
import { navigate } from "../router.ts";
import { agentTranscriptViaSidecar } from "../transcript.ts";
import {
  DRAWER_TAB_LABELS,
  drawerTabsFor,
  drawerTranscriptModel,
  flowContextTokens,
  meterLabel,
  type DrawerTabId,
  type DrawerTranscriptModel,
  type FlowAttemptRung,
  type FlowHandoffModel,
  type FlowSeatNode,
  type FlowUsageRowModel,
} from "../view-model.ts";
import { SupervisorChat } from "./supervisor-chat.tsx";
import { TranscriptRow, type LoadAgentTranscript } from "./task-detail.tsx";

export interface AgentDrawerProps {
  /** The live seat the fold attributes the drawer to — a vacant seat never opens one. */
  node: FlowSeatNode;
  onClose: () => void;
  /** The transcript transport — the sidecar's door by default, a fixture in tests. */
  load?: LoadAgentTranscript;
  /**
   * The LIVE Supervisor node from the CURRENT snapshot while a
   * Supervisor-seat drawer is open (T-13a) — the chat panel tracks the seat,
   * not the node the drawer opened on. Omitted for every other seat: their
   * drawers stay exactly as they were.
   */
  liveSupervisor?: FlowSeatNode;
}

// ---- the Work tab ----------------------------------------------------------------------------------

/** The Lead's own telemetry — the context-window label and the queued-mail count, Lead nodes only. */
function LeadTelemetry({ node }: { node: FlowSeatNode }) {
  if (node.contextLabel === null && node.queuedMailCount === null) return null;
  return (
    <div className="drawer-work-counts">
      {node.contextLabel !== null ? (
        <span>
          Context <strong>{node.contextLabel}</strong>
        </span>
      ) : null}
      {node.queuedMailCount !== null ? (
        <span>
          Queued mail <strong>{node.queuedMailCount}</strong>
        </span>
      ) : null}
    </div>
  );
}

/** One owned Task — the fold's own chip, deep-linked into the Task Detail journey. */
function WorkTaskLink({ chip }: { chip: FlowSeatNode["tasks"][number] }) {
  return (
    <button
      type="button"
      className="drawer-task-link"
      aria-label={`${chip.task}: ${chip.statusLabel}, ${chip.attemptCount === 0 ? "no attempts" : `${chip.attemptCount} ${chip.attemptCount === 1 ? "attempt" : "attempts"}`}`}
      onClick={() => navigate(`/tasks?task=${encodeURIComponent(chip.task)}`)}
    >
      <span className="drawer-task-code">
        <span>{chip.task}</span>
        <span className={`drawer-task-state ${chip.tone}`}>{chip.statusLabel}</span>
      </span>
      <span className="drawer-work-meta">
        <span>{chip.attemptCount === 0 ? "No attempts yet" : `${chip.attemptCount} ${chip.attemptCount === 1 ? "attempt" : "attempts"}`}</span>
      </span>
    </button>
  );
}

/** The Work tab — the seat's owned Tasks, and the Lead's telemetry above them. */
function WorkTab({ node }: { node: FlowSeatNode }) {
  return (
    <section className="drawer-work" aria-label="Work">
      <div className="drawer-section-heading">
        <h3>Owned Tasks</h3>
        <span>{node.tasks.length}</span>
      </div>
      {node.seat === "lead" ? <LeadTelemetry node={node} /> : null}
      {node.tasks.length === 0 ? (
        <p className="drawer-muted">No Tasks are bound to this seat — the ledger attributes none to it.</p>
      ) : (
        node.tasks.map((chip) => <WorkTaskLink key={chip.task} chip={chip} />)
      )}
    </section>
  );
}

// ---- the Session tab (T-07c) -----------------------------------------------------------------------

/** One data-list row — the honest value, "Not reported" wherever the snapshot carries none. */
function DataRow({ term, value, mono = false, tone = "" }: { term: string; value: string; mono?: boolean; tone?: string }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd className={`${mono ? "mono " : ""}${tone}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The Session tab — the daemon's own row for the agent: provider/model/lane,
 * presence, `requiresAttention` (the snapshot carries no reason — that
 * absence renders as a sentence, never an invented one), the snapshot's own
 * stamp as the honest last-read time, the cwd, and the context window where
 * the snapshot carries it (the daemon reports the pair on the Lead only).
 */
function SessionTab({ node }: { node: FlowSeatNode }) {
  const session = node.session;
  if (session === null) {
    return (
      <section className="console-flow-drawer-session" aria-label="Session">
        <div className="notice">No session recorded — this seat holds no live agent.</div>
      </section>
    );
  }
  return (
    <section className="console-flow-drawer-session" aria-label="Session">
      <dl className="data-list">
        <DataRow term="Provider" value={session.provider} />
        <DataRow term="Model" value={session.model ?? "Not reported"} />
        <DataRow term="Thinking" value={session.thinking ?? "Not reported"} />
        <DataRow term="Lane" value={session.lane ?? "Not reported"} />
        <DataRow term="Presence" value={node.state.label} />
        <DataRow term="Daemon status" value={session.status} />
        <DataRow term="Attention" value={session.requiresAttention === null ? "Not reported" : session.requiresAttention ? "Required" : "Clear"} tone={session.requiresAttention === true ? "amber" : ""} />
        <DataRow term="Last read" value={session.snapshotAt} mono />
        <DataRow term="Timeline last seq" value={session.seqEnd === null ? "Not reported" : String(session.seqEnd)} />
        <DataRow term="Working directory" value={session.cwd ?? "Not reported"} mono />
        <DataRow
          term="Context window"
          value={
            session.contextUsedTokens !== null
              ? `${flowContextTokens(session.contextUsedTokens)} / ${session.contextMaxTokens !== null ? flowContextTokens(session.contextMaxTokens) : "—"}`
              : "Not carried for this seat"
          }
        />
      </dl>
      {session.requiresAttention === true ? <p className="drawer-muted">The snapshot carries no attention reason.</p> : null}
    </section>
  );
}

// ---- the Attempts tab (T-07c) ----------------------------------------------------------------------

/** One ladder rung — attempt n, its gate verdict, and the sha the claim stamped. */
function AttemptRungRow({ rung }: { rung: FlowAttemptRung }) {
  return (
    <li className={`console-flow-drawer-rung ${rung.verdictTone}`}>
      <span className="console-flow-drawer-rung-n">#{rung.n}</span>
      <span className="console-flow-drawer-rung-verdict">{rung.verdictLabel}</span>
      <span className="mono small console-flow-drawer-rung-sha">{rung.sha === null ? "no sha recorded" : `${rung.sha.slice(0, 10)}…`}</span>
    </li>
  );
}

/** One owned Task's Attempt ladder, its header deep-linked into the Task Detail journey. */
function AttemptLadder({ chip }: { chip: FlowSeatNode["tasks"][number] }) {
  return (
    <div className="console-flow-drawer-ladder">
      <button
        type="button"
        className="drawer-task-link"
        aria-label={`${chip.task}: ${chip.statusLabel}, ${chip.attemptCount === 0 ? "no attempts" : `${chip.attemptCount} ${chip.attemptCount === 1 ? "attempt" : "attempts"}`} — open the Attempt ladder`}
        onClick={() => navigate(`/tasks?task=${encodeURIComponent(chip.task)}`)}
      >
        <span className="drawer-task-code">
          <span>{chip.task}</span>
          <span className={`drawer-task-state ${chip.tone}`}>{chip.statusLabel}</span>
        </span>
      </button>
      {chip.attempts.length === 0 ? (
        <p className="drawer-muted">No Attempt has been claimed on this Task.</p>
      ) : (
        <ol className="console-flow-drawer-rungs">
          {chip.attempts.map((rung) => (
            <AttemptRungRow key={rung.n} rung={rung} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** The Attempts tab — the seat's owned Tasks, each with its full Attempt ladder from the ledger. */
function AttemptsTab({ node }: { node: FlowSeatNode }) {
  return (
    <section className="console-flow-drawer-attempts" aria-label="Attempts">
      <div className="drawer-section-heading">
        <h3>Attempt ladders</h3>
        <span>{node.tasks.length}</span>
      </div>
      {node.tasks.map((chip) => (
        <AttemptLadder key={chip.task} chip={chip} />
      ))}
    </section>
  );
}

// ---- the Handoff tab (T-07c) -----------------------------------------------------------------------

/**
 * The Handoff tab — the Lead's rotation state machine as `project.json`
 * records it: rotation state, queued mail, the locked mailbox, and the
 * context ceiling the rotation watches. Lead nodes only — the fold answers
 * `handoff: null` for every other seat and the tab never renders.
 */
function HandoffTab({ handoff }: { handoff: FlowHandoffModel }) {
  return (
    <section className="console-flow-drawer-handoff" aria-label="Handoff">
      <dl className="data-list">
        <DataRow term="Rotation" value={handoff.rotationLabel} tone={handoff.rotationTone} />
        <DataRow term="Queued mail" value={handoff.queuedMailCount === null ? "Not reported" : String(handoff.queuedMailCount)} />
        <DataRow term="Mailbox" value={handoff.mailboxLocked ? "Locked during handoff" : "Open"} tone={handoff.mailboxLocked ? "amber" : ""} />
        <DataRow term="Context used" value={handoff.contextUsedTokens === null ? "Not reported" : flowContextTokens(handoff.contextUsedTokens)} />
        <DataRow term="Context ceiling" value={handoff.contextMaxTokens === null ? "Not reported" : flowContextTokens(handoff.contextMaxTokens)} />
      </dl>
      {handoff.rotationState === null ? <p className="drawer-muted">The Project records no rotation state — an absent record reads as normal.</p> : null}
    </section>
  );
}

// ---- the Resources tab (T-07c) ---------------------------------------------------------------------

/**
 * The Resources tab — the usage rows the snapshot attributes to this agent
 * (the rollup's own attribution, meter lawful by construction). No row is
 * the honest "No usage recorded" notice — never an invented zero.
 */
function ResourcesTab({ rows }: { rows: readonly FlowUsageRowModel[] }) {
  if (rows.length === 0) {
    return (
      <section className="console-flow-drawer-resources" aria-label="Resources">
        <div className="notice">No usage recorded — the Project's rollup carries no session it attributes to this seat.</div>
      </section>
    );
  }
  return (
    <section className="console-flow-drawer-resources" aria-label="Resources">
      <div className="drawer-section-heading">
        <h3>Recorded usage</h3>
        <span>{rows.length}</span>
      </div>
      {rows.map((row) => (
        <div key={row.label} className="console-flow-drawer-usage-row">
          <strong>{row.label}</strong>
          <span className="console-flow-drawer-usage-meter">{meterLabel(row.meter)}</span>
          <small>
            {row.turns} {row.turns === 1 ? "turn" : "turns"} · {row.sessionCount} {row.sessionCount === 1 ? "session" : "sessions"}
            {row.meter.totalCostUsd !== null ? ` · $${row.meter.totalCostUsd.toFixed(2)}` : ""}
          </small>
        </div>
      ))}
    </section>
  );
}

// ---- the Transcript tab ------------------------------------------------------------------------------

type TranscriptTabState = { phase: "idle" } | { phase: "loading" } | DrawerTranscriptModel;

/**
 * The Transcript tab — the agent's read-only timeline tail through the
 * EXISTING client, loaded lazily on the tab's FIRST open and on every
 * Refresh, never before. Every arm renders as data: loading, the reduced
 * entries (newest last, the daemon's tail order), the honest unavailable
 * reason, or the refusal's code and sentence.
 */
function TranscriptTab({ node, load }: { node: FlowSeatNode; load: LoadAgentTranscript }) {
  const agentId = node.agentId ?? "";
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<TranscriptTabState>({ phase: "idle" });
  useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    void load({ agent: agentId }).then((reply) => {
      if (!live) return;
      setState(drawerTranscriptModel(reply));
    });
    return () => {
      live = false;
    };
  }, [agentId, reloadKey, load]);
  return (
    <section className="console-flow-drawer-transcript" aria-label="Transcript">
      <div className="od-row">
        <span className="mono small muted console-flow-drawer-agent-id">{agentId}</span>
        <span className="spacer" />
        <button type="button" className="btn ghost console-transcript-refresh" onClick={() => setReloadKey((key) => key + 1)}>
          Refresh
        </button>
      </div>
      {state.phase === "idle" || state.phase === "loading" ? <div className="notice">Loading the Agent transcript…</div> : null}
      {state.phase === "failure" ? (
        <div className="console-banner console-banner-error" role="alert">
          The transcript refused ({state.code}): {state.error}
        </div>
      ) : null}
      {state.phase === "unavailable" ? <div className="notice">{state.reason}</div> : null}
      {state.phase === "entries" ? (
        state.entries.length === 0 ? (
          <div className="notice">The Agent transcript is empty.</div>
        ) : (
          <ol className="console-tr-list">
            {state.entries.map((entry) => (
              <TranscriptRow key={`${entry.seq}-${entry.kind}`} entry={entry} />
            ))}
          </ol>
        )
      ) : null}
    </section>
  );
}

// ---- the drawer ---------------------------------------------------------------------------------------

/**
 * The Agent Drawer — header (role, agent id, lane/model, presence) over the
 * role-aware read-only tabs: Work and Transcript for every live seat, plus
 * Session everywhere, Attempts where the ledger binds Tasks to the seat,
 * Handoff on the Lead only, and Resources everywhere (`drawerTabsFor`'s own law).
 */
export function AgentDrawer({ node, onClose, load = agentTranscriptViaSidecar, liveSupervisor }: AgentDrawerProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const tabs = drawerTabsFor(node);
  const [tab, setTab] = useState<DrawerTabId>("work");
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [onClose]);
  // The prototype's open law: the drawer takes focus at its close button —
  // the first control of the dialog, ready for Escape or Tab.
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <button type="button" className="agent-drawer-scrim" aria-label="Close agent details" tabIndex={-1} onClick={onClose} />
      <aside className="agent-drawer" role="dialog" aria-modal="false" aria-labelledby={titleId} aria-label={`Agent details for ${node.title}`}>
        <header className="agent-drawer-header">
          <span className="bot-avatar" aria-hidden="true">
            <span className="role-avatar">{node.initial}</span>
          </span>
          <div className="drawer-header-identity">
            <div className="drawer-name-row">
              <h2 id={titleId}>{node.title}</h2>
              <span className={`drawer-status-inline ${node.state.tone}`}>
                <span className="dot" aria-hidden="true" />
                {node.state.label}
              </span>
            </div>
            <div className="drawer-model-inline">
              <span className="drawer-model-edit">{node.laneLabel === "" ? "Lane unknown" : node.laneLabel}</span>
            </div>
            <small className="drawer-muted console-flow-drawer-agent-id">{node.agentId}</small>
          </div>
          <button type="button" className="icon-btn" ref={closeRef} aria-label="Close agent details" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="agent-drawer-body">
          {liveSupervisor !== undefined ? <SupervisorChat node={liveSupervisor} load={load} /> : null}
          <div className="console-flow-drawer-tabs" role="tablist" aria-label="Agent drawer views">
            {tabs.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`console-flow-drawer-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`console-flow-drawer-panel-${id}`}
                className={`console-flow-drawer-tab${tab === id ? " active" : ""}`}
                onClick={() => setTab(id)}
              >
                {DRAWER_TAB_LABELS[id]}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`console-flow-drawer-panel-${tab}`} aria-labelledby={`console-flow-drawer-tab-${tab}`}>
            {tab === "work" ? (
              <WorkTab node={node} />
            ) : tab === "session" ? (
              <SessionTab node={node} />
            ) : tab === "attempts" ? (
              <AttemptsTab node={node} />
            ) : tab === "handoff" && node.handoff !== null ? (
              <HandoffTab handoff={node.handoff} />
            ) : tab === "resources" ? (
              <ResourcesTab rows={node.usage} />
            ) : (
              <TranscriptTab node={node} load={load} />
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
