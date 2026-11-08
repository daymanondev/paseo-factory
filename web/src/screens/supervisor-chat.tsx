/**
 * The Supervisor Live Chat panel (T-13a, ADR 0051 §3/§5) — the read-only
 * conversation the Agent Drawer's body opens with on the Project's Supervisor
 * seat, above the tabs. It folds the Supervisor's EXISTING
 * `factory.agent.transcript` read (`supervisorChatModel` in `view-model.ts`)
 * into a chat: user turns read as "You (Owner)", assistant turns as
 * "Supervisor", each keyed on the timeline seq — the transcript carries no
 * wall clock, so the seq is the honest turn position, never an invented
 * time. The header badge carries the Supervisor's provider and model from
 * the snapshot. The panel stays live while the drawer is open — it re-reads
 * on its own interval and whenever the snapshot changes (the fold's own
 * `generatedAt` stamp is the effect's key, so a rotated supervisor or a
 * vanished seat shows immediately) and stops on close/unmount. Every arm
 * renders as data: loading, a refusal's code and sentence, the honest
 * unavailable reason, the empty conversation, and "no live Supervisor seat"
 * when the seat went vacant mid-open. NO composer exists — no textbox, no
 * send button, no quick-chips (the send stays in Paseo pending the Owner's
 * ADR 0017 decision); one line of honest copy says so. The prototype's CSS
 * vocabulary is reused (`design/project-add.css`'s `.sup-chat-panel` family);
 * its JS is mock-only and never ported.
 */
import { useEffect, useState } from "react";
import "../../../design/project-add.css";
import { supervisorChatModel, type FlowSeatNode, type SupervisorChatModel } from "../view-model.ts";
import type { LoadAgentTranscript } from "./task-detail.tsx";

/** The panel's live cadence while the drawer stays open — a plain fixed interval, coarser than the snapshot's busy clock. */
export const SUPERVISOR_CHAT_POLL_MS = 10_000;

export interface SupervisorChatProps {
  /**
   * The LIVE Supervisor node from the CURRENT snapshot — the panel tracks the
   * seat, not the node the drawer opened on, so a rotated or vanished
   * supervisor shows the honest state immediately.
   */
  node: FlowSeatNode;
  /** The transcript transport — the sidecar's door by default, a fixture in tests. */
  load: LoadAgentTranscript;
}

/** The read's own state — the first read loads; every later re-read keeps the current chat on screen until its reply lands. */
type SupervisorChatState = { phase: "loading" } | { agent: string } & SupervisorChatModel;

export function SupervisorChat({ node, load }: SupervisorChatProps) {
  const agentId = node.agentId;
  const stamp = node.session?.snapshotAt ?? null;
  const [state, setState] = useState<SupervisorChatState>({ phase: "loading" });
  useEffect(() => {
    if (agentId === null) return; // the seat holds no live agent — nothing to read, no clock to keep
    let live = true;
    const read = () => {
      void load({ agent: agentId }).then((reply) => {
        if (!live) return;
        setState({ agent: agentId, ...supervisorChatModel(reply) });
      });
    };
    read(); // the open read — then the live cadence while the drawer stays open
    const timer = setInterval(read, SUPERVISOR_CHAT_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [agentId, stamp, load]);
  // A rotated supervisor never shows the previous holder's turns — the stale
  // read reads as loading until the new agent's reply lands.
  const current: SupervisorChatState = state.phase === "loading" || agentId === null || state.agent === agentId ? state : { phase: "loading" };
  const session = node.session;
  const lane = session === null ? null : session.model === null ? session.provider : `${session.provider} · ${session.model}`;
  return (
    <section className="sup-chat-panel" aria-label="Supervisor Live Chat">
      <div className="sup-chat-head">
        <strong>
          <span>Supervisor Chat</span>
        </strong>
        {lane !== null ? <span className="badge cyan">{lane}</span> : null}
      </div>
      {agentId === null ? (
        <div className="notice">No live Supervisor seat — the Project holds no Supervisor agent to read.</div>
      ) : current.phase === "loading" ? (
        <div className="notice">Loading the Supervisor chat…</div>
      ) : current.phase === "failure" ? (
        <div className="console-banner console-banner-error" role="alert">
          The Supervisor chat read refused ({current.code}): {current.error}
        </div>
      ) : current.phase === "unavailable" ? (
        <div className="notice">{current.reason}</div>
      ) : current.messages.length === 0 ? (
        <div className="notice">The Supervisor conversation is empty — the transcript carries no turns yet.</div>
      ) : (
        <div className="sup-chat-messages">
          {current.messages.map((message) => (
            <div key={message.seq} className={`sup-msg ${message.sender === "owner" ? "owner" : "agent"}`}>
              <small>
                {message.label} · seq {message.seq}
              </small>
              <div>{message.text}</div>
            </div>
          ))}
        </div>
      )}
      <p className="drawer-muted">Read-only — messaging the Supervisor stays in Paseo for now.</p>
    </section>
  );
}
