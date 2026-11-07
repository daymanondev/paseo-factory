/**
 * The Inbox screen — "Needs you" (ADR 0051 §2.3, T-05 + T-06). One item per
 * thing waiting on the Owner across ALL Projects: needs-human Tasks, red
 * Tasks, pending Scrum Owner requests, runs blocked on budget, and
 * ready-to-accept Tasks with the SAME Accept journey the Tasks screen owns
 * (the exported `AcceptButton` — one journey, four doors). T-06 makes the
 * Scrum half resolvable inline: each pending `question` gets Answer
 * (rationale required) and Cancel through `wait.answer` / `wait.cancel`; a
 * pending `design` request gets Approve / Request changes with a rationale
 * through `design.decide` (the RN client's exact payload — decision,
 * rationale, revision, digest); a budget-blocked run gets Grant +N (amount
 * and rationale) through `allowance.tasks` / `allowance.qa` (ADR 0038). All
 * five ride the sidecar's NARROWED `factory.scrum.command` door — Owner
 * authority the way Accept carries it, no credential in the browser. Every
 * item names its Project and drills into the Tasks screen's detail
 * (`/tasks?task=<id>`, the Project scope set with it). Pending state,
 * refusals (revision conflict, owner-action-required, …) and success render
 * as data; after success the Inbox re-reads and the item disappears. The
 * layout reuses the Open Design bundle's own CSS (`.inbox-grid`,
 * `.panel.inbox-item`, `.nav-count`) — its JS is discarded.
 */
import { useState } from "react";
import type { InboxItemViewModel, InboxViewModel } from "../view-model.ts";
import { freshOwnerRequestId, type ScrumCommandInput, type ScrumCommandReply } from "../scrum.ts";
import { navigate } from "../router.ts";
import { AcceptButton } from "./tasks.tsx";

export interface InboxScreenProps {
  /** The pure fold's output — the App owns the model so the nav badge and the list can never disagree. */
  model: InboxViewModel;
  /** The accept transport — the sidecar RPC door by default, a fixture in tests. */
  acceptTask: (input: { task: string; attempt: number }) => Promise<{ ok: true; seq: number; summary: string } | { ok: false; code: string; error: string }>;
  /** The Scrum Owner command transport (T-06) — the sidecar's narrowed `factory.scrum.command` door. */
  scrumCommand: (input: ScrumCommandInput) => Promise<ScrumCommandReply>;
  /** Fired after a successful Owner command — the shell refreshes the snapshot (and so the gather) immediately. */
  onResolved: () => void;
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

// ---- the Owner acts (T-06) ---------------------------------------------------------------------

/** One Owner act's honest state — pending, the refusal as data, the one-line landing. */
interface OwnerActState {
  pending: boolean;
  refusal: { code: string; error: string } | null;
  landed: string | null;
}

/**
 * The per-item Owner act — the RN client's `useOwnerCommand` law, spelled for
 * the console: a fresh `requestId` per submit (the journal's replay key — a
 * repeated request cannot apply twice), the run's own `expectedRevision`
 * (a stale revision refuses as data), and success landing as one honest line
 * while the shell's refresh re-reads the Inbox.
 */
function useOwnerAct(scrumCommand: InboxScreenProps["scrumCommand"], onResolved: () => void) {
  const [state, setState] = useState<OwnerActState>({ pending: false, refusal: null, landed: null });
  const submit = async (input: Omit<ScrumCommandInput, "requestId">) => {
    setState((previous) => ({ ...previous, pending: true, refusal: null, landed: null }));
    const reply = await scrumCommand({ ...input, requestId: freshOwnerRequestId() });
    if (reply.ok) {
      setState({ pending: false, refusal: null, landed: "Recorded — refreshing…" });
      onResolved();
    } else {
      setState({ pending: false, refusal: { code: reply.code, error: reply.error }, landed: null });
    }
  };
  return { ...state, submit };
}

/** The command's scoping facts — the run, its Project root, its journal revision. */
interface OwnerActFacts {
  projectRoot: string | null;
  runId: string | null;
  expectedRevision: number | null;
}

/** One Owner act's hook output — the state plus the submit that drives it. */
type OwnerAct = OwnerActState & { submit: (input: Omit<ScrumCommandInput, "requestId">) => Promise<void> };

/** The honest reason an act cannot submit — null when the facts carry it. */
function unscopedReason(item: OwnerActFacts): string | null {
  if (item.projectRoot === null) return "the snapshot names no root for this Project — re-open the Inbox after the next snapshot";
  if (item.runId === null) return "the inbox read named no run for this item";
  if (item.expectedRevision === null) return "the inbox read carried no run revision — re-read before acting";
  return null;
}

/** The refusal and landing lines — data the item renders inline, never a throw. */
function OwnerActStatus({ state }: { state: OwnerAct }) {
  return (
    <>
      {state.pending ? <p className="small muted" role="status">Recording…</p> : null}
      {state.landed !== null ? <p className="small" role="status">{state.landed}</p> : null}
      {state.refusal !== null ? (
        <p className="small console-owner-refusal" role="alert">
          Refused ({state.refusal.code}): {state.refusal.error}
        </p>
      ) : null}
    </>
  );
}

/** The rationale textarea the three acts share — the label names the act's own field. */
function RationaleField({ id, label, value, onChange, disabled }: { id: string; label: string; value: string; onChange: (value: string) => void; disabled: boolean }) {
  return (
    <div className="console-owner-field">
      <label className="small muted" htmlFor={id}>{label}</label>
      <textarea id={id} value={value} disabled={disabled} rows={2} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

/** A pending `question` — inline Answer (rationale required) and Cancel (`wait.answer` / `wait.cancel`). */
function QuestionForm({ item, scrumCommand, onResolved }: { item: InboxItemViewModel; scrumCommand: InboxScreenProps["scrumCommand"]; onResolved: () => void }) {
  const act = useOwnerAct(scrumCommand, onResolved);
  const [rationale, setRationale] = useState("");
  const unscoped = unscopedReason(item);
  const disabled = act.pending || unscoped !== null;
  const submit = (operation: "wait.answer" | "wait.cancel") =>
    void act.submit({
      projectRoot: item.projectRoot ?? "",
      operation,
      runId: item.runId ?? "",
      expectedRevision: item.expectedRevision ?? 0,
      payload: { pendingId: item.pendingId, rationale: rationale.trim() },
    });
  return (
    <div className="console-owner-form">
      <RationaleField id={`answer-${item.pendingId ?? item.runId}`} label="Answer or cancellation reason" value={rationale} onChange={setRationale} disabled={disabled} />
      <div className="od-row console-inbox-actions">
        <button type="button" className="btn primary" disabled={disabled || rationale.trim() === ""} onClick={() => submit("wait.answer")}>
          {act.pending ? "Recording…" : "Record answer"}
        </button>
        <button type="button" className="btn ghost" disabled={disabled || rationale.trim() === ""} onClick={() => submit("wait.cancel")}>
          Cancel question
        </button>
      </div>
      <p className="small muted">Cancelling supplies no answer; dependent work stays held.</p>
      {unscoped !== null ? <p className="small console-owner-refusal">{unscoped}</p> : null}
      <OwnerActStatus state={act} />
    </div>
  );
}

/** A pending `design` request — Approve / Request changes with a rationale (`design.decide`, the RN client's exact payload). */
function DesignForm({ item, scrumCommand, onResolved }: { item: InboxItemViewModel; scrumCommand: InboxScreenProps["scrumCommand"]; onResolved: () => void }) {
  const act = useOwnerAct(scrumCommand, onResolved);
  const [rationale, setRationale] = useState("");
  const unscoped = unscopedReason(item) ?? (item.design === null ? "the request named no design revision and digest — the decision cannot bind" : null);
  const disabled = act.pending || unscoped !== null;
  const decide = (decision: "approved" | "changes_requested") =>
    void act.submit({
      projectRoot: item.projectRoot ?? "",
      operation: "design.decide",
      runId: item.runId ?? "",
      expectedRevision: item.expectedRevision ?? 0,
      // The RN client's own payload contract (plugin/client/factory/scrum.tsx):
      // decision, rationale, revision, digest — bound to the request's own design.
      payload: { decision, rationale: rationale.trim(), revision: item.design!.revision, digest: item.design!.digest },
    });
  return (
    <div className="console-owner-form">
      <RationaleField id={`design-${item.pendingId ?? item.runId}`} label="Decision rationale (required to Approve / Request changes)" value={rationale} onChange={setRationale} disabled={disabled} />
      <div className="od-row console-inbox-actions">
        <button type="button" className="btn primary" disabled={disabled || rationale.trim() === ""} onClick={() => decide("approved")}>
          {act.pending ? "Recording…" : "Approve"}
        </button>
        <button type="button" className="btn ghost" disabled={disabled || rationale.trim() === ""} onClick={() => decide("changes_requested")}>
          Request changes
        </button>
      </div>
      <p className="small muted">Approval binds to revision {item.design?.revision ?? "—"} (digest {item.design ? `${item.design.digest.slice(0, 12)}…` : "—"}); changes return the run to design.</p>
      {unscoped !== null ? <p className="small console-owner-refusal">{unscoped}</p> : null}
      <OwnerActStatus state={act} />
    </div>
  );
}

/** A budget-blocked run — Grant +N (amount and rationale) for exactly the held causes (`allowance.tasks` / `allowance.qa`). */
function GrantForm({ item, scrumCommand, onResolved }: { item: InboxItemViewModel; scrumCommand: InboxScreenProps["scrumCommand"]; onResolved: () => void }) {
  const act = useOwnerAct(scrumCommand, onResolved);
  const [amount, setAmount] = useState("8"); // ADR 0038: the control defaults to +8 Tasks
  const [rationale, setRationale] = useState("");
  const unscoped = unscopedReason(item);
  const holdsTasks = item.grantCauses.includes("tasks");
  const holdsQa = item.grantCauses.includes("qaFixRounds");
  const validAmount = /^\d+$/.test(amount) && Number.isSafeInteger(Number(amount)) && Number(amount) > 0 && Number.isSafeInteger((item.allowance?.tasksAllowed ?? 0) + Number(amount));
  const disabled = act.pending || unscoped !== null;
  const grantTasks = () =>
    void act.submit({
      projectRoot: item.projectRoot ?? "",
      operation: "allowance.tasks",
      runId: item.runId ?? "",
      expectedRevision: item.expectedRevision ?? 0,
      payload: { amount: Number(amount), rationale: rationale.trim() },
    });
  const grantQa = () =>
    void act.submit({
      projectRoot: item.projectRoot ?? "",
      operation: "allowance.qa",
      runId: item.runId ?? "",
      expectedRevision: item.expectedRevision ?? 0,
      payload: { amount: 1, rationale: rationale.trim() }, // ADR 0038: QA grants add exactly one round
    });
  return (
    <div className="console-owner-form">
      {holdsTasks ? (
        <div className="console-owner-field console-owner-amount">
          <label className="small muted" htmlFor={`amount-${item.runId}`}>Additional Tasks</label>
          <input id={`amount-${item.runId}`} value={amount} inputMode="numeric" disabled={disabled} onChange={(event) => setAmount(event.target.value)} />
          {!validAmount ? <p className="small console-owner-refusal">Enter a positive whole number within the supported allowance.</p> : null}
        </div>
      ) : null}
      <RationaleField id={`grant-${item.runId}`} label="Grant rationale" value={rationale} onChange={setRationale} disabled={disabled} />
      <div className="od-row console-inbox-actions">
        {holdsTasks ? (
          <button type="button" className="btn primary" disabled={disabled || !validAmount || rationale.trim() === ""} onClick={grantTasks}>
            {act.pending ? "Recording…" : `Grant +${validAmount ? amount : ""} Tasks`}
          </button>
        ) : null}
        {holdsQa ? (
          <button type="button" className="btn ghost" disabled={disabled || rationale.trim() === ""} onClick={grantQa}>
            Grant +1 QA round
          </button>
        ) : null}
      </div>
      <p className="small muted">A grant adds capacity without resetting the used count; it is not acceptance or design approval.</p>
      {unscoped !== null ? <p className="small console-owner-refusal">{unscoped}</p> : null}
      <OwnerActStatus state={act} />
    </div>
  );
}

function InboxItem({
  item,
  pending,
  accept,
  scrumCommand,
  onResolved,
  openTask,
}: {
  item: InboxItemViewModel;
  pending: boolean;
  accept: (task: string, attempt: number) => Promise<void>;
  scrumCommand: InboxScreenProps["scrumCommand"];
  onResolved: () => void;
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
      {item.kind === "owner-request" && item.requestKind === "question" ? (
        <QuestionForm item={item} scrumCommand={scrumCommand} onResolved={onResolved} />
      ) : item.kind === "owner-request" && item.requestKind === "design" ? (
        <DesignForm item={item} scrumCommand={scrumCommand} onResolved={onResolved} />
      ) : item.kind === "budget-blocked" ? (
        <GrantForm item={item} scrumCommand={scrumCommand} onResolved={onResolved} />
      ) : null}
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
    </article>
  );
}

export function InboxScreen({ model, acceptTask, scrumCommand, onResolved, onAccepted, onOpenProject }: InboxScreenProps) {
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
            <InboxItem key={`${item.kind}-${item.task ?? item.runId}-${index}`} item={item} pending={state.pending === item.task} accept={accept} scrumCommand={scrumCommand} onResolved={onResolved} openTask={openTask} />
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
            Owner review has no expiry. Elapsed time is informational and does not consume your allowance. Answer questions, approve designs, and grant
            allowances right here — every act records your rationale in the run journal.
          </p>
        </aside>
      </div>
    </section>
  );
}
