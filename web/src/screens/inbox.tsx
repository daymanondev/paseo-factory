/**
 * The Inbox screen — "Needs you" (ADR 0051 §2.3, T-05). One item per thing
 * waiting on the Owner across ALL Projects: needs-human Tasks, red Tasks,
 * pending Scrum Owner requests (read-only — answering, design approval, and
 * allowance grants land in T-06), and ready-to-accept Tasks with the SAME
 * Accept journey the Tasks screen owns (the exported `AcceptButton` — one
 * journey, four doors). Every item names its Project and drills into the
 * Tasks screen's detail (`/tasks?task=<id>`, the Project scope set with it).
 * The layout reuses the Open Design bundle's own CSS (`.inbox-grid`,
 * `.panel.inbox-item`, `.nav-count`) — its JS is discarded.
 */
import { useState } from "react";
import type { InboxItemViewModel, InboxViewModel } from "../view-model.ts";
import { navigate } from "../router.ts";
import { AcceptButton } from "./tasks.tsx";

export interface InboxScreenProps {
  /** The pure fold's output — the App owns the model so the nav badge and the list can never disagree. */
  model: InboxViewModel;
  /** The accept transport — the sidecar RPC door by default, a fixture in tests. */
  acceptTask: (input: { task: string; attempt: number }) => Promise<{ ok: true; seq: number; summary: string } | { ok: false; code: string; error: string }>;
  /** Fired after a successful accept — the shell refreshes the snapshot (and so the gather) immediately. */
  onAccepted: () => void;
  /** Sets the Tasks screen's Project scope — the App owns `projectRoot`. */
  onOpenProject: (projectRoot: string | undefined) => void;
}

interface AcceptState {
  /** The task with the request in flight — its button disables and reads `Accepting…`. */
  pending: string | null;
  /** The last refusal as data: the screen shows the code and the sentence. */
  refusal: { task: string; code: string; error: string } | null;
  /** The last acceptance — one honest line until the refreshed snapshot lands. */
  landed: { task: string; seq: number } | null;
}

function InboxItem({
  item,
  pending,
  accept,
  openTask,
}: {
  item: InboxItemViewModel;
  pending: boolean;
  accept: (task: string, attempt: number) => Promise<void>;
  openTask: (item: InboxItemViewModel) => void;
}) {
  return (
    <article className="panel inbox-item" data-kind={item.kind} data-task={item.task ?? undefined}>
      <div className="od-row">
        <span className={`badge ${item.tone}`}>{item.badge}</span>
        <span className="spacer" />
        <span className="small muted">
          {item.origin !== null ? `${item.origin} · ` : ""}in {item.projectName}
        </span>
      </div>
      <h2>{item.title}</h2>
      <p>{item.detail}</p>
      <div className="od-row console-inbox-actions">
        {item.task !== null ? (
          <button type="button" className="btn ghost" aria-label={`Inspect ${item.task}`} onClick={() => openTask(item)}>
            Inspect task
          </button>
        ) : null}
        {item.kind === "owner-request" && item.projectRoot !== null ? (
          <button type="button" className="btn ghost" onClick={() => openTask(item)}>
            Open project tasks
          </button>
        ) : null}
        <span className="spacer" />
        {item.kind === "ready-to-accept" && item.acceptAttempt !== null ? (
          <AcceptButton task={item.task ?? ""} attempt={item.acceptAttempt} pending={pending} accept={accept} />
        ) : null}
      </div>
      {item.kind === "owner-request" ? <p className="small muted">Answering lands with T-06 — this row is read-only.</p> : null}
    </article>
  );
}

export function InboxScreen({ model, acceptTask, onAccepted, onOpenProject }: InboxScreenProps) {
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

  /** The drill-in law: set the Project scope the item names, then open the Task's detail by URL. */
  const openTask = (item: InboxItemViewModel) => {
    onOpenProject(item.projectRoot ?? undefined);
    const task = item.task;
    navigate(task !== null ? `/tasks?task=${encodeURIComponent(task)}` : "/tasks");
  };

  return (
    <section aria-label="Needs you" className="inbox-surface">
      <div className="page-heading">
        <div>
          <h1>Needs you</h1>
          <p className="muted">Across every Project · {model.count} {model.count === 1 ? "item" : "items"} waiting on you</p>
        </div>
      </div>
      {model.gatherError !== null && (
        <div className="console-banner console-banner-error" role="alert">
          The Scrum half of the inbox refused to load ({model.gatherError}) — Task items still render from the snapshot.
        </div>
      )}
      {state.refusal !== null && (
        <div className="console-banner console-banner-error" role="alert">
          Accepting {state.refusal.task} refused ({state.refusal.code}): {state.refusal.error}
        </div>
      )}
      {state.landed !== null && (
        <div className="console-banner console-banner-ok" role="status">
          Accepted {state.landed.task} — ledger seq {state.landed.seq}. Refreshing…
        </div>
      )}
      <div className="inbox-grid">
        <div>
          {model.items.map((item, index) => (
            <InboxItem key={`${item.kind}-${item.task ?? item.runId}-${index}`} item={item} pending={state.pending === item.task} accept={accept} openTask={openTask} />
          ))}
          {model.items.length === 0 ? (
            <div className="task-empty">
              <h3>Nothing needs you</h3>
              <p>Every Project is moving — no blockers, red gates, questions, or green attempts are waiting.</p>
            </div>
          ) : null}
          {model.refusals.map((refusal) => (
            <div key={refusal.projectSlug} className="notice">
              {refusal.projectSlug}'s run journal refused to read — {refusal.error}
            </div>
          ))}
        </div>
        <aside className="panel" aria-label="About Owner review">
          <span className="eyebrow">OWNER REVIEW</span>
          <h2 style={{ marginTop: 8 }}>No expiry</h2>
          <p className="small muted" style={{ margin: "20px 0", lineHeight: 1.8 }}>
            Owner review has no expiry. Elapsed time is informational and does not consume your allowance. Answering questions, approving designs, and granting
            allowances land in their own wave (T-06) — this screen stays read-only for them.
          </p>
        </aside>
      </div>
    </section>
  );
}
