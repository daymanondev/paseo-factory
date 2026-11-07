/**
 * The Tasks screen (T-02) — a real list of the scoped snapshot's Tasks,
 * statuses in the CONTEXT.md vocabulary, layout in the prototype's CSS
 * (`design/styles.css` task cards and badges). The first real write journey:
 * a Ready-to-Accept Task shows `Accept`, which calls `factory.accept`
 * through the sidecar, shows pending and refusal feedback as data, and asks
 * the snapshot clock for an immediate refresh — the next snapshot shows the
 * Task Accepted. No Kanban board, filters, or detail modal (T-03); no
 * seat-start controls (ADR 0017).
 */
import { useState } from "react";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import type { AcceptReply } from "../accept.ts";
import { meterLabel, tasksScreenModel } from "../view-model.ts";

export interface TasksScreenProps {
  view: FactoryView;
  /** The accept transport — the sidecar RPC door by default, a fixture in tests. */
  acceptTask: (input: { task: string; attempt: number }) => Promise<AcceptReply>;
  /** Fired after a successful accept — the shell refreshes the snapshot immediately. */
  onAccepted: () => void;
}

interface AcceptState {
  /** The task with the request in flight — its button disables and reads `Accepting…`. */
  pending: string | null;
  /** The last refusal as data: the screen shows the code and the sentence. */
  refusal: { task: string; code: string; error: string } | null;
  /** The last acceptance — one honest line until the refreshed snapshot lands. */
  landed: { task: string; seq: number } | null;
}

/** The Accept act's button — `Accept #N`, the RN client's own label law. */
function AcceptButton({ task, attempt, accept }: { task: string; attempt: number; accept: (task: string, attempt: number) => Promise<void> }) {
  return (
    <button
      type="button"
      className="btn primary"
      onClick={() => {
        void accept(task, attempt);
      }}
    >
      Accept #{attempt}
    </button>
  );
}

export function TasksScreen({ view, acceptTask, onAccepted }: TasksScreenProps) {
  const model = tasksScreenModel(view);
  const [state, setState] = useState<AcceptState>({ pending: null, refusal: null, landed: null });

  const accept = async (task: string, attempt: number) => {
    setState((previous) => ({ ...previous, pending: task, refusal: null }));
    const reply = await acceptTask({ task, attempt });
    if (reply.ok) {
      setState((previous) => ({ ...previous, pending: null, refusal: null, landed: { task, seq: reply.seq } }));
      onAccepted();
    } else {
      setState((previous) => ({ ...previous, pending: null, refusal: { task, code: reply.code, error: reply.error } }));
    }
  };

  return (
    <section aria-label="Tasks">
      <div className="page-heading">
        <div>
          <h1>Tasks</h1>
          <p className="muted">
            {model.scope} · {model.rows.length} tasks
            {model.meter !== null ? ` · ${meterLabel(model.meter)}` : ""}
          </p>
        </div>
      </div>
      {state.refusal !== null && (
        <div className="console-banner console-banner-error" role="alert">
          Accepting {state.refusal.task} refused ({state.refusal.code}): {state.refusal.error}
        </div>
      )}
      {state.landed !== null && (
        <div className="console-banner console-banner-ok" role="status">
          Accepted {state.landed.task} — ledger seq {state.landed.seq}. Refreshing the snapshot…
        </div>
      )}
      {model.rows.length === 0 ? (
        <div className="notice">
          No Tasks in this scope yet. A Task appears when its Contract is set — the console never invents rows.
        </div>
      ) : (
        <div className="console-task-list">
          {model.rows.map((row) => (
            <article className="task-card" key={row.task} data-task={row.task}>
              <div className="od-row">
                <span className="mono muted">#{row.task}</span>
                <span className="spacer" />
                <span className={`badge ${row.tone}`}>{row.statusLabel}</span>
              </div>
              <h3>{row.description ?? row.task}</h3>
              <div className="task-meta">
                <span className="badge">{row.attemptCount} {row.attemptCount === 1 ? "attempt" : "attempts"}</span>
                {row.model !== null && <span className="badge">{row.model}</span>}
                {row.meter !== null && (
                  <span className="badge" title={meterLabel(row.meter)}>
                    {meterLabel(row.meter)}
                  </span>
                )}
              </div>
              {row.status === "ready-to-accept" && row.acceptAttempt !== null ? (
                <div className="od-row console-task-actions">
                  {state.pending === row.task ? (
                    <button type="button" className="btn primary" disabled>
                      Accepting…
                    </button>
                  ) : (
                    <AcceptButton task={row.task} attempt={row.acceptAttempt} accept={accept} />
                  )}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
