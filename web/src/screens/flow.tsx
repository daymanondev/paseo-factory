/**
 * The Workspace screen (T-07a) — the `/flow` placeholder replaced by the real
 * read-only authority graph: the scoped Project's SLP chain (Owner →
 * Supervisor → Lead → working Peers, each node's live state, lane/model, and
 * owned Tasks from the snapshot alone) or, for a scrum-mode Project, the
 * authority tier plus the run's five-stage pipeline strip with the current
 * phase highlighted and blockers carried as a banner. The prototype's CSS is
 * reused (`design/slp-workflow.css`, `design/scrum-workflow.css`, the shared
 * `team-space.css` node classes); its JS is mock-only and never ported — the
 * wires are plain CSS, the data all folds in `view-model.ts`'s `flowScreenModel`.
 * No Project selected answers an honest empty state; a Project with no seats
 * renders "Not started" nodes. No Start Supervisor/Lead controls anywhere
 * (ADR 0017); a node click selects (aria-pressed + `.selected`) and never
 * opens a drawer — the Agent Drawer is T-07b.
 */
import { useState } from "react";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import "../../../design/slp-workflow.css";
import "../../../design/scrum-workflow.css";
import { navigate } from "../router.ts";
import { flowScreenModel, type FlowMailNode, type FlowSeatNode, type ScrumPipelineModel, type ScrumStageModel, type ScrumStageTask } from "../view-model.ts";

export interface FlowScreenProps {
  view: FactoryView;
}

// ---- the shared pieces ---------------------------------------------------------------------------

/** The plain-CSS connector wire — the prototype's SVG wires are mock JS, never ported. */
function Wire({ active = false }: { active?: boolean }) {
  return <span className={`console-flow-wire${active ? " active" : ""}`} aria-hidden="true" />;
}

/** One seat/agent node — the prototype's `.flow-node`/`.slp-node` card, selected state local. */
function SeatNode({ node, selected, onSelect }: { node: FlowSeatNode; selected: boolean; onSelect: (key: string) => void }) {
  const classes = [
    "flow-node",
    "slp-node",
    node.state.nodeClass,
    node.state.vacant ? "slp-node-vacant" : "",
    selected ? "selected" : "",
  ]
    .filter((name) => name !== "")
    .join(" ");
  const taskWords = node.tasks.map((chip) => `${chip.task} ${chip.statusLabel}`).join(", ");
  return (
    <button
      type="button"
      className={classes}
      aria-pressed={selected}
      aria-label={`${node.title}: ${node.state.label}${node.laneLabel === "" ? "" : `, ${node.laneLabel}`}${taskWords === "" ? "" : ` — owns ${taskWords}`}`}
      onClick={() => onSelect(node.key)}
    >
      <span className="node-top">
        <span className={node.state.vacant ? "slp-empty-avatar" : "role-avatar"} aria-hidden="true">
          {node.initial}
        </span>
        <strong className="node-title">{node.title}</strong>
      </span>
      <span className={`node-bottom ${node.state.tone}`}>
        <span className="dot" aria-hidden="true" />
        <span>{node.state.label}</span>
        {node.laneLabel !== "" ? <span className="node-task">{node.laneLabel}</span> : null}
      </span>
      {node.tasks.length > 0 ? (
        <span className="console-flow-node-tasks">
          {node.tasks.map((chip) => (
            <span key={chip.task} className={`badge ${chip.tone}`} title={`#${chip.task} — ${chip.statusLabel}`}>
              {chip.task} · {chip.statusLabel}
            </span>
          ))}
        </span>
      ) : null}
      {node.contextLabel !== null || node.queuedMailCount !== null ? (
        <span className="node-bottom cyan console-flow-context">
          {node.contextLabel !== null ? <span>{node.contextLabel}</span> : null}
          {node.queuedMailCount !== null ? <span className="node-task">{node.queuedMailCount} queued</span> : null}
        </span>
      ) : null}
    </button>
  );
}

/** One mailbox point — queued counts and the handoff lock, from the fold's own telemetry. */
function MailPoint({ mail, selected, onSelect }: { mail: FlowMailNode; selected: boolean; onSelect: (key: string) => void }) {
  const key = `mail:${mail.seat}`;
  const title = `${mail.seat === "supervisor" ? "Supervisor" : "Lead"} Mailbox`;
  return (
    <button
      type="button"
      className={`slp-point slp-mail-point${mail.locked ? " is-locked" : ""}${selected ? " selected" : ""}`}
      aria-pressed={selected}
      aria-label={`${title}${mail.locked ? ": locked during handoff" : mail.queued !== null ? `: ${mail.queued} queued` : ""}`}
      onClick={() => onSelect(key)}
    >
      <span className="slp-point-label">{title}</span>
      {mail.queued !== null ? <small className="console-flow-mail-count">{mail.locked ? "Locked" : `${mail.queued} queued`}</small> : null}
      {mail.locked || (mail.queued ?? 0) > 0 ? <i className="slp-point-signal" aria-hidden="true" /> : null}
    </button>
  );
}

// ---- the SLP canvas -------------------------------------------------------------------------------

/** The SLP authority graph — the centered chain plus the working Peers grid. */
function SlpCanvas({ model, selected, onSelect }: { model: NonNullable<ReturnType<typeof flowScreenModel>>; selected: string | null; onSelect: (key: string) => void }) {
  return (
    <div className="workflow-viewport console-flow-viewport">
      <div className="slp-canvas" data-flow-mode="slp">
        <div className="console-flow-chain">
          <button type="button" className="flow-node slp-node console-flow-owner" aria-label="Owner: Human">
            <span className="node-top">
              <span className="slp-human-avatar" aria-hidden="true">
                O
              </span>
              <strong className="node-title">Owner</strong>
            </span>
            <span className="node-bottom muted">
              <span className="dot" aria-hidden="true" />
              <span>Human</span>
            </span>
          </button>
          <Wire />
          <MailPoint mail={model.mail.supervisor} selected={selected === "mail:supervisor"} onSelect={onSelect} />
          <Wire />
          <SeatNode node={model.supervisor} selected={selected === model.supervisor.key} onSelect={onSelect} />
          <Wire active />
          <MailPoint mail={model.mail.lead} selected={selected === "mail:lead"} onSelect={onSelect} />
          <Wire active />
          <SeatNode node={model.lead} selected={selected === model.lead.key} onSelect={onSelect} />
          <Wire active />
          <span className="slp-dispatch-point" aria-hidden="true" />
          <div
            className="slp-compact-peers console-flow-peers"
            aria-label="Working Peers"
            style={{ "--slp-peer-count": Math.max(1, model.peers.length) } as React.CSSProperties}
          >
            {model.peers.length > 0 ? (
              model.peers.map((peer) => <SeatNode key={peer.key} node={peer} selected={selected === peer.key} onSelect={onSelect} />)
            ) : (
              <button type="button" className="flow-node slp-node queued slp-node-vacant" aria-label="Peer: Not started">
                <span className="node-top">
                  <span className="slp-empty-avatar" aria-hidden="true">
                    P
                  </span>
                  <strong className="node-title">Peer</strong>
                </span>
                <span className="node-bottom muted">
                  <span className="dot" aria-hidden="true" />
                  <span>Not started</span>
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- the Scrum canvas ------------------------------------------------------------------------------

/** One run Task card — deep-links into the existing Task Detail journey. */
function ScrumTaskCard({ task }: { task: ScrumStageTask }) {
  return (
    <button
      type="button"
      className={`sc-task ${task.tone}`}
      aria-label={`${task.roleLabel} · ${task.task}: ${task.statusLabel}`}
      onClick={() => navigate(`/tasks?task=${encodeURIComponent(task.task)}`)}
    >
      <span className="sc-task-avatar role-avatar" aria-hidden="true">
        {task.roleLabel.slice(0, 1)}
      </span>
      <span className="sc-task-heading">
        <strong>
          {task.roleLabel} · {task.task}
        </strong>
        <span className={`sc-task-status ${task.tone}`}>{task.statusLabel}</span>
      </span>
      {task.modelLabel !== null ? (
        <span className="sc-model">
          {task.modelLabel}
        </span>
      ) : null}
    </button>
  );
}

/** One pipeline stage — the numbered heading (current phase highlighted), its cells, and the gate. */
function ScrumStage({ stage, fixSummary, selected, onSelect }: { stage: ScrumStageModel; fixSummary: string | null; selected: boolean; onSelect: (key: string) => void }) {
  return (
    <section className={`sc-stage${stage.skipped ? " skipped" : ""}`} data-stage={stage.id}>
      <button
        type="button"
        className={`sc-stage-heading${stage.current ? " console-flow-current" : ""}${selected ? " selected" : ""}`}
        aria-pressed={selected}
        aria-label={`${stage.number}. ${stage.title}: ${stage.state}${stage.current ? " (current phase)" : ""}`}
        onClick={() => onSelect(stage.id)}
      >
        <span className={`sc-stage-number ${stage.stateTone}`}>{stage.number}</span>
        <h3>{stage.title}</h3>
        <span className={`sc-stage-state ${stage.stateTone}`}>{stage.state}</span>
      </button>
      {stage.gate !== null ? (
        <div className="sc-gate">
          <span>
            <strong>Readiness</strong>
            <span className={stage.gate.readiness.tone}>{stage.gate.readiness.label}</span>
          </span>
          <span>
            <strong>UI{stage.gate.revision !== null ? ` · r${stage.gate.revision}` : ""}</strong>
            <span className={stage.gate.ui.tone}>{stage.gate.ui.label}</span>
          </span>
        </div>
      ) : (
        <div className={stage.columns.length > 1 ? "sc-parallel" : "sc-stage-task-list"}>
          {stage.columns.map((column) => (
            <div key={column.role}>
              {column.tasks.map((task) => (
                <ScrumTaskCard key={task.task} task={task} />
              ))}
              {column.tasks.length === 0 ? (
                <div className="sc-role-empty">
                  <span className="sc-task-avatar role-avatar" aria-hidden="true">
                    {column.roleLabel.slice(0, 1)}
                  </span>
                  <strong>{column.roleLabel}</strong>
                  <small>{stage.skipped ? "Skipped" : "No Tasks yet"}</small>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {stage.id === "qa" && fixSummary !== null ? (
        <div className="sc-stage-aside">
          <span className="sc-fix-summary">{fixSummary}</span>
        </div>
      ) : null}
    </section>
  );
}

/** The Scrum authority tier plus the run's pipeline strip. */
function ScrumCanvas({ model, selected, onSelect }: { model: NonNullable<ReturnType<typeof flowScreenModel>>; selected: string | null; onSelect: (key: string) => void }) {
  const scrum = model.scrum;
  return (
    <div className="workflow-viewport console-flow-viewport">
      <div className="sc-canvas" data-flow-mode="scrum">
        {scrum === null ? (
          <div className="notice">No Scrum run started for {model.scope} yet — the pipeline appears when the Lead creates one.</div>
        ) : (
          <>
            <button
              type="button"
              className="sc-run-summary"
              aria-label={`Run ${scrum.runId}: phase ${scrum.phase}`}
              onClick={() => onSelect(`run:${scrum.runId}`)}
            >
              <span>
                <strong>{scrum.runId}</strong>
              </span>
              <span className={["blocked", "cancelled"].includes(scrum.phase) ? "amber" : "cyan"}>{scrum.phase}</span>
              {scrum.track !== null ? <span>{scrum.track}</span> : null}
              {scrum.configRevision !== null ? <small>Roster r{scrum.configRevision} · frozen</small> : null}
            </button>
            <div className="sc-authority">
              <button type="button" className="sc-seat" aria-label="Owner: Human">
                <span className="sc-seat-top">
                  <span className="sc-human" aria-hidden="true">
                    O
                  </span>
                  <strong>Owner</strong>
                </span>
                <span className="sc-seat-status">
                  <span className="dot muted" aria-hidden="true" />
                  Human
                </span>
              </button>
              <span className="console-flow-wire" aria-hidden="true" />
              <div className="sc-mail">
                <span>Supervisor Mailbox</span>
              </div>
              <span className="console-flow-wire" aria-hidden="true" />
              <ScrumSeat node={model.supervisor} selected={selected === model.supervisor.key} onSelect={onSelect} />
              <span className="console-flow-wire active" aria-hidden="true" />
              <div className="sc-mail">
                <span>Lead Mailbox</span>
                {model.mail.lead.queued !== null ? <small>{model.mail.lead.locked ? "Locked" : `${model.mail.lead.queued} queued`}</small> : null}
              </div>
              <span className="console-flow-wire active" aria-hidden="true" />
              <ScrumSeat node={model.lead} selected={selected === model.lead.key} onSelect={onSelect} />
            </div>
            {scrum.blockers.length > 0 ? (
              <div className="sc-run-blocker" role="status">
                {scrum.blockers.map((line) => (
                  <span key={line} className="console-flow-blocker-line">
                    {line}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="sc-pipeline">
              {scrum.stages.map((stage) => (
                <ScrumStage key={stage.id} stage={stage} fixSummary={scrum.fixSummary} selected={selected === stage.id} onSelect={onSelect} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One authority-tier seat card in scrum mode — the prototype's `.sc-seat`. */
function ScrumSeat({ node, selected, onSelect }: { node: FlowSeatNode; selected: boolean; onSelect: (key: string) => void }) {
  return (
    <button
      type="button"
      className={`sc-seat${node.state.vacant ? " vacant" : ""} ${node.state.tone}${selected ? " selected" : ""}`}
      aria-pressed={selected}
      aria-label={`${node.title}: ${node.state.label}${node.tasks.length > 0 ? ` — owns ${node.tasks.map((chip) => `${chip.task} ${chip.statusLabel}`).join(", ")}` : ""}`}
      onClick={() => onSelect(node.key)}
    >
      <span className="sc-seat-top">
        <span className={node.state.vacant ? "sc-human" : "role-avatar"} aria-hidden="true">
          {node.initial}
        </span>
        <strong>{node.title}</strong>
      </span>
      <span className="sc-seat-status">
        <span className="dot" aria-hidden="true" />
        {node.state.label}
      </span>
      <span className="sc-model">
        {node.laneLabel}
        {node.contextLabel !== null ? <small>{node.contextLabel}</small> : null}
      </span>
    </button>
  );
}

// ---- the screen ------------------------------------------------------------------------------------

export function FlowScreen({ view }: FlowScreenProps) {
  const model = flowScreenModel(view);
  const [selected, setSelected] = useState<string | null>(null);
  /** A click selects — aria-pressed + `.selected` — and never opens a drawer (T-07b owns that). */
  const onSelect = (key: string) => setSelected((previous) => (previous === key ? null : key));
  if (model === null) {
    return (
      <section aria-label="Workspace">
        <h1>Workspace</h1>
        <div className="notice">
          No Project selected — choose one in the Project switcher above, or open a Project from All projects. The Workspace renders the
          selected Project's authority graph.
        </div>
      </section>
    );
  }
  return (
    <section aria-label="Workspace" className="console-flow">
      <div className="page-heading">
        <div>
          <h1>Workspace</h1>
          <p className="muted">
            {model.scope} · <span>{model.mode === "slp" ? "SLP authority graph" : "Scrum pipeline"}</span>
          </p>
        </div>
      </div>
      {view.daemonError !== null ? (
        <div className="notice" role="status">
          Live agent states are degraded ({view.daemonError}) — the graph renders the last known snapshot.
        </div>
      ) : null}
      {model.mode === "slp" ? <SlpCanvas model={model} selected={selected} onSelect={onSelect} /> : <ScrumCanvas model={model} selected={selected} onSelect={onSelect} />}
    </section>
  );
}
