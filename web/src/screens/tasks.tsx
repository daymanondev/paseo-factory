/**
 * The Tasks screen (T-02 list → T-03 board journey) — the scoped snapshot's
 * Tasks in the CONTEXT.md vocabulary, laid out in the prototype's CSS
 * (`design/team-space.css` toolbar, filter chips, and `compact-board`; the
 * T-02 card list stays the default view). The board's five equal columns,
 * the filter chips' per-scope counts, the List ⇄ Board choice, the filter,
 * and the open Task Detail all live in the URL (`/tasks?view=board&filter=
 * ready_to_accept&task=T-03`) so a reload keeps exactly what the Owner was
 * looking at. Accept keeps working from list, board, detail, and the Inbox
 * (T-05) through one shared journey: `factory.accept` via the sidecar,
 * pending and refusal feedback as data, an immediate snapshot refresh. No
 * seat-start controls (ADR 0017); no data outside the view-model module.
 */
import { useEffect, useState } from "react";
import type { FactoryView, TaskDetailView } from "../../../plugin/shared/view.ts";
import type { AcceptReply } from "../accept.ts";
import type { TaskDetailReply } from "../detail.ts";
import { taskDetailViaSidecar } from "../detail.ts";
import { agentTranscriptViaSidecar, type AgentTranscriptReply } from "../transcript.ts";
import { navigate, useRoute } from "../router.ts";
import { meterLabel, tasksScreenModel, taskDetailModel, TASK_FILTERS, filterTaskRows, type TaskFilter, type TaskRowViewModel } from "../view-model.ts";
import { TaskDetailPanel, type LoadAgentTranscript } from "./task-detail.tsx";

export interface TasksScreenProps {
  view: FactoryView;
  /** The accept transport — the sidecar RPC door by default, a fixture in tests. */
  acceptTask: (input: { task: string; attempt: number }) => Promise<AcceptReply>;
  /** Fired after a successful accept — the shell refreshes the snapshot immediately. */
  onAccepted: () => void;
  /** The Task Detail transport — the sidecar RPC door by default, a fixture in tests. */
  loadTaskDetail?: (input: { task: string }) => Promise<TaskDetailReply>;
  /** The Agent transcript transport — the sidecar RPC door by default, a fixture in tests. */
  loadTranscript?: (input: { agent: string }) => Promise<AgentTranscriptReply>;
}

interface AcceptState {
  /** The task with the request in flight — its button disables and reads `Accepting…`. */
  pending: string | null;
  /** The last refusal as data: the screen shows the code and the sentence. */
  refusal: { task: string; code: string; error: string } | null;
  /** The last acceptance — one honest line until the refreshed snapshot lands. */
  landed: { task: string; seq: number } | null;
}

// ---- the URL as the board's memory -------------------------------------------------------------

function tasksUrl(input: { view?: "list" | "board"; filter?: TaskFilter; task?: string | null }): string {
  const params = new URLSearchParams();
  if (input.view === "board") params.set("view", "board");
  if (input.filter !== undefined && input.filter !== "all") params.set("filter", input.filter);
  if (input.task !== undefined && input.task !== null && input.task !== "") params.set("task", input.task);
  const query = params.toString();
  return query === "" ? "/tasks" : `/tasks?${query}`;
}

/** Parses the board's URL memory — unknown spellings fall back to the defaults, never a guess. */
export function boardParamsFromQuery(query: URLSearchParams): { view: "list" | "board"; filter: TaskFilter; task: string | null } {
  const filterParam = query.get("filter");
  const filter = TASK_FILTERS.find((candidate) => candidate.id === filterParam)?.id ?? "all";
  const task = query.get("task");
  return {
    view: query.get("view") === "board" ? "board" : "list",
    filter,
    task: task === null || task === "" ? null : task,
  };
}

// ---- the Accept journey (one journey, four doors: list, board, detail, inbox) -------------------

/** The Accept button itself — exported so the Inbox (T-05) reuses the one journey, not a copy. */
export function AcceptButton({ task, attempt, pending, accept }: { task: string; attempt: number; pending: boolean; accept: (task: string, attempt: number) => Promise<void> }) {
  if (pending) {
    return (
      <button type="button" className="btn primary" disabled>
        Accepting…
      </button>
    );
  }
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

/** The Accept controls for one row — null unless the fold names the green Attempt the act submits. */
function AcceptControls({ row, pending, accept }: { row: TaskRowViewModel; pending: boolean; accept: (task: string, attempt: number) => Promise<void> }) {
  if (row.status !== "ready-to-accept" || row.acceptAttempt === null) return null;
  return <AcceptButton task={row.task} attempt={row.acceptAttempt} pending={pending} accept={accept} />;
}

// ---- the cards ----------------------------------------------------------------------------------

/** The mode badge every card carries, plus the Project line in the `All projects` scope. */
function CardBadges({ row }: { row: TaskRowViewModel }) {
  return (
    <>
      <span className="badge">{row.modeLabel}</span>
      {row.project !== null ? <span className="badge" title={row.workspace}>{row.project}</span> : null}
    </>
  );
}

function ListCard({ row, pending, accept, openTask }: { row: TaskRowViewModel; pending: boolean; accept: (task: string, attempt: number) => Promise<void>; openTask: (task: string) => void }) {
  return (
    <article className="task-card" data-task={row.task}>
      <div className="od-row">
        <span className="mono muted">#{row.task}</span>
        <span className="spacer" />
        <span className={`badge ${row.tone}`}>{row.statusLabel}</span>
      </div>
      <h3>
        <button type="button" className="console-task-title" onClick={() => openTask(row.task)}>
          {row.description ?? row.task}
        </button>
      </h3>
      {row.needsHumanReason !== null ? <p className="small amber console-task-blocker">{row.needsHumanReason}</p> : null}
      <div className="task-meta">
        <span className="badge">{row.attemptCount} {row.attemptCount === 1 ? "attempt" : "attempts"}</span>
        <CardBadges row={row} />
        {row.model !== null && <span className="badge">{row.model}</span>}
        {row.meter !== null && (
          <span className="badge" title={meterLabel(row.meter)}>
            {meterLabel(row.meter)}
          </span>
        )}
      </div>
      <div className="od-row console-task-actions">
        <AcceptControls row={row} pending={pending} accept={accept} />
      </div>
    </article>
  );
}

/** The board's compact card — the prototype's `compact-task`: title opens the detail, foot carries gate + Accept. */
function CompactCard({ row, pending, accept, openTask }: { row: TaskRowViewModel; pending: boolean; accept: (task: string, attempt: number) => Promise<void>; openTask: (task: string) => void }) {
  return (
    <article className="compact-task" data-task={row.task}>
      <button type="button" className="compact-task-title" onClick={() => openTask(row.task)}>
        <span className="task-code">#{row.task}</span>
        <strong className="od-clamp-2">{row.description ?? row.task}</strong>
      </button>
      {row.needsHumanReason !== null ? <div className="compact-task-blocker">{row.needsHumanReason}</div> : null}
      <div className="compact-task-foot">
        <span className={`badge ${row.tone}`}>{row.statusLabel}</span>
        <span className="task-mini-attempt">{row.attemptCount > 0 ? `${row.attemptCount}/3` : "—"}</span>
        <span className="spacer" />
        <AcceptControls row={row} pending={pending} accept={accept} />
      </div>
      <div className="compact-task-foot">
        <CardBadges row={row} />
      </div>
    </article>
  );
}

// ---- the Task Detail dialog ----------------------------------------------------------------------

type DetailState =
  | { phase: "loading"; task: string }
  | { phase: "refused"; task: string; code: string; error: string }
  | { phase: "loaded"; task: string; detail: TaskDetailView };

export function TaskDetailDialog({
  task,
  acceptState,
  accept,
  onAcceptLanded,
  loadTaskDetail,
  loadTranscript,
  close,
}: {
  task: string;
  acceptState: AcceptState;
  accept: (task: string, attempt: number) => Promise<void>;
  /** Fired after an Accept lands from inside the dialog — re-reads the ladder it just changed. */
  onAcceptLanded: () => void;
  loadTaskDetail: (input: { task: string }) => Promise<TaskDetailReply>;
  loadTranscript?: LoadAgentTranscript;
  close: () => void;
}) {
  const [detail, setDetail] = useState<DetailState>({ phase: "loading", task });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let live = true;
    setDetail({ phase: "loading", task });
    void loadTaskDetail({ task }).then((reply) => {
      if (!live) return;
      setDetail(reply.ok ? { phase: "loaded", task, detail: reply.detail } : { phase: "refused", task, code: reply.code, error: reply.error });
    });
    return () => {
      live = false;
    };
  }, [task, reloadKey, loadTaskDetail]);

  const model = detail.phase === "loaded" ? taskDetailModel(detail.detail) : null;
  return (
    <div className="console-dialog-overlay" role="presentation" onClick={close}>
      <div className="dialog wide console-dialog" role="dialog" aria-modal="true" aria-label={`${task} detail`} onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <strong>#{task} — detail</strong>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={close}>
            Close
          </button>
        </div>
        <div className="dialog-body">
          {detail.phase === "loading" ? <div className="notice">Loading the Task's detail…</div> : null}
          {detail.phase === "refused" ? (
            <div className="console-banner console-banner-error" role="alert">
              The detail for {detail.task} refused ({detail.code}): {detail.error}
            </div>
          ) : null}
          {model !== null && (
            <>
              {acceptState.refusal !== null && acceptState.refusal.task === task ? (
                <div className="console-banner console-banner-error" role="alert">
                  Accepting {acceptState.refusal.task} refused ({acceptState.refusal.code}): {acceptState.refusal.error}
                </div>
              ) : null}
              {acceptState.landed !== null && acceptState.landed.task === task ? (
                <div className="console-banner console-banner-ok" role="status">
                  Accepted {acceptState.landed.task} — ledger seq {acceptState.landed.seq}. Refreshing the snapshot…
                </div>
              ) : null}
              <TaskDetailPanel detail={model} loadTranscript={loadTranscript} />
              <div className="dialog-actions">
                <button type="button" className="btn ghost" onClick={close}>
                  Back to Tasks
                </button>
                {model.acceptAttempt !== null ? (
                  <AcceptButton
                    task={task}
                    attempt={model.acceptAttempt}
                    pending={acceptState.pending === task}
                    accept={async (acceptedTask, attempt) => {
                      await accept(acceptedTask, attempt);
                      setReloadKey((key) => key + 1);
                      onAcceptLanded();
                    }}
                  />
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- the screen -----------------------------------------------------------------------------------

export function TasksScreen({ view, acceptTask, onAccepted, loadTaskDetail = taskDetailViaSidecar, loadTranscript = agentTranscriptViaSidecar }: TasksScreenProps) {
  const model = tasksScreenModel(view);
  const route = useRoute();
  const { view: viewMode, filter, task: openTask } = boardParamsFromQuery(route.query);
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

  const setBoardParams = (next: { view?: "list" | "board"; filter?: TaskFilter; task?: string | null }) =>
    navigate(tasksUrl({ view: viewMode, filter, task: openTask, ...next }));

  const rows = filterTaskRows(model.rows, filter);

  return (
    <section aria-label="Tasks" className="task-surface">
      <div className="page-heading">
        <div>
          <h1>Tasks</h1>
          <p className="muted">
            {model.scope} · {model.rows.length} tasks
            {model.meter !== null ? ` · ${meterLabel(model.meter)}` : ""}
          </p>
        </div>
        <span className="spacer" />
        <div className="task-view-switch" aria-label="Task view">
          <button type="button" data-task-view="list" className={viewMode === "list" ? "selected" : ""} aria-pressed={viewMode === "list"} onClick={() => setBoardParams({ view: "list" })}>
            <span>List</span>
          </button>
          <button type="button" data-task-view="board" className={viewMode === "board" ? "selected" : ""} aria-pressed={viewMode === "board"} onClick={() => setBoardParams({ view: "board" })}>
            <span>Board</span>
          </button>
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
      <div className="task-filterbar">
        <div className="task-status-tabs">
          {TASK_FILTERS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={`task-status-tab${filter === chip.id ? " active" : ""}`}
              aria-pressed={filter === chip.id}
              onClick={() => setBoardParams({ filter: chip.id })}
            >
              {chip.label}
              <span>{chip.id === "all" ? model.rows.length : model.columnCounts[chip.id]}</span>
            </button>
          ))}
        </div>
      </div>
      {model.rows.length === 0 ? (
        <div className="notice">
          No Tasks in this scope yet. A Task appears when its Contract is set — the console never invents rows.
        </div>
      ) : rows.length === 0 ? (
        <div className="task-empty">
          <h3>No tasks match this view</h3>
          <p>Choose another status — the counts on every chip name the scope's own Tasks.</p>
          <button type="button" className="btn ghost" onClick={() => setBoardParams({ filter: "all" })}>
            Clear filters
          </button>
        </div>
      ) : viewMode === "board" ? (
        <div className="compact-board">
          {model.board.map((column) => (
            <section key={column.id} className={`compact-board-column ${column.id}`} aria-label={column.label}>
              <h2>
                {column.label}
                <small>{model.columnCounts[column.id]}</small>
              </h2>
              {filterTaskRows(column.rows, filter).map((row) => (
                <CompactCard key={row.task} row={row} pending={state.pending === row.task} accept={accept} openTask={(task) => setBoardParams({ task })} />
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="console-task-list">
          {rows.map((row) => (
            <ListCard key={row.task} row={row} pending={state.pending === row.task} accept={accept} openTask={(task) => setBoardParams({ task })} />
          ))}
        </div>
      )}
      {openTask !== null ? (
        <TaskDetailDialog
          task={openTask}
          acceptState={state}
          accept={accept}
          onAcceptLanded={() => {
            // The screen-level `accept` already fired `onAccepted` (the shell's
            // snapshot refresh); the dialog's own `reloadKey` re-reads the
            // ladder it just changed — one refresh per journey, never two.
          }}
          loadTaskDetail={loadTaskDetail}
          loadTranscript={loadTranscript}
          close={() => setBoardParams({ task: null })}
        />
      ) : null}
    </section>
  );
}
