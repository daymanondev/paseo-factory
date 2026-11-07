/**
 * The Workspace's Agent Drawer (T-07b) — the read-only, role-aware inspector
 * a live seat/Peer node opens on `/flow`. The prototype's CSS and interaction
 * design are reused (`design/agent-drawer.css`: the fixed aside, its own
 * scroll region, the scrim on narrow viewports); its JS is mock-only and
 * never ported — the header folds from `flowScreenModel` (T-07a), the Work
 * tab renders the fold's own ledger-bound chips, and the Transcript tab
 * rides the EXISTING `factory.agent.transcript` client (`web/src/transcript.ts`)
 * through the sidecar's envelope law: entries, `unavailable` with its reason,
 * and a refusal are all data, never a throw. Read-only throughout — no
 * Start/Rotate/Revoke/Respawn control anywhere (ADR 0017); the drawer closes
 * on Escape and via its close button and returns focus to the node.
 */
import { useEffect, useId, useRef, useState } from "react";
import "../../../design/agent-drawer.css";
import { navigate } from "../router.ts";
import { agentTranscriptViaSidecar } from "../transcript.ts";
import { drawerTranscriptModel, type DrawerTranscriptModel, type FlowSeatNode } from "../view-model.ts";
import { TranscriptRow, type LoadAgentTranscript } from "./task-detail.tsx";

export interface AgentDrawerProps {
  /** The live seat the fold attributes the drawer to — a vacant seat never opens one. */
  node: FlowSeatNode;
  onClose: () => void;
  /** The transcript transport — the sidecar's door by default, a fixture in tests. */
  load?: LoadAgentTranscript;
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

/** The Agent Drawer — header (role, agent id, lane/model, presence) over the Work and Transcript tabs. */
export function AgentDrawer({ node, onClose, load = agentTranscriptViaSidecar }: AgentDrawerProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [tab, setTab] = useState<"work" | "transcript">("work");
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
          <div className="console-flow-drawer-tabs" role="tablist" aria-label="Agent drawer views">
            {(["work", "transcript"] as const).map((id) => (
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
                {id === "work" ? "Work" : "Transcript"}
              </button>
            ))}
          </div>
          {tab === "work" ? (
            <div role="tabpanel" id="console-flow-drawer-panel-work" aria-labelledby="console-flow-drawer-tab-work">
              <WorkTab node={node} />
            </div>
          ) : (
            <div role="tabpanel" id="console-flow-drawer-panel-transcript" aria-labelledby="console-flow-drawer-tab-transcript">
              <TranscriptTab node={node} load={load} />
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
