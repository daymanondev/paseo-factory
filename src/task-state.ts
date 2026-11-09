/** Pure interpretation of a Task's current Contract epoch and its Attempts.
 * Numeric Attempt identities are local to this epoch, never the whole Task.
 */
import type { AttemptAccepted, ContractSet, FreshEyesWritten, GateFinished, LedgerEvent, NeedsHuman, TaskClosed } from "./events.ts";

export type AcceptanceRole = "owner" | "supervisor" | "lead" | "agent";
export type TaskStateStatus = "accepted" | "closed" | "needs-human" | "running" | "waiting" | "ready-to-accept" | "red";
export type ReviewState = "off" | "pending" | "incomplete" | "clear" | "concern" | "failed";

/** The terminal retirement's own four facts (v0.5.0, ADR 0054 §5, ticket 05) — `by` reads the line's `closed_by` (the `accepted_by` seat law, defaulting to the delegated-Owner reading on legacy lines). */
export interface TaskClosure {
  seq: number;
  at: string;
  reason: string;
  by: string;
}

export interface AttemptState {
  attempt: number;
  events: readonly LedgerEvent[];
  gate: GateFinished | undefined;
  review: FreshEyesWritten | undefined;
  reviewState: ReviewState;
  gateOpen: boolean;
  reportComplete: boolean;
  open: boolean;
  ownerEligible: boolean;
  leadEligible: boolean;
  leadRefusal: string | undefined;
}

function last<K extends LedgerEvent["event"]>(events: readonly LedgerEvent[], kind: K): Extract<LedgerEvent, { event: K }> | undefined {
  return events.findLast((event): event is Extract<LedgerEvent, { event: K }> => event.event === kind);
}

export function projectTask(events: readonly LedgerEvent[], task: string) {
  const history = events.filter((event) => "task" in event && event.task === task);
  const contract: ContractSet | undefined = last(history, "contract_set");
  const epochSeq = contract?.seq ?? 0;
  const epochId = contract?.epoch_id;
  const epoch = history.filter((event) => epochId === undefined ? event.seq >= epochSeq : event.epoch_id === epochId);
  const acceptance: AttemptAccepted | undefined = last(history, "attempt_accepted");
  const closure: TaskClosed | undefined = last(history, "task_closed");
  const settled = acceptance !== undefined && acceptance.landing !== "pending-conflict";
  const latestGate = last(epoch, "gate_finished");
  const needs: NeedsHuman | undefined = last(epoch, "needs_human");
  const needsHuman = needs !== undefined && needs.seq > (latestGate?.seq ?? -1);
  const numbers = [...new Set(epoch.flatMap((event) => "attempt" in event ? [event.attempt] : []))].sort((a, b) => a - b);
  const attempts: AttemptState[] = numbers.map((attempt) => {
    const own = epoch.filter((event) => "attempt" in event && event.attempt === attempt);
    const gate = last(own, "gate_finished");
    const review = last(own, "fresh_eyes_written");
    const started = own.some((event) => event.event === "claim_reported" || event.event === "gate_started");
    const reportComplete = last(own, "report_written") !== undefined;
    const reviewState: ReviewState = review?.outcome ?? (contract?.freshEyes === true ? reportComplete ? "incomplete" : "pending" : "off");
    const ownerEligible = !settled && gate?.verdict === "green";
    const leadRefusal = needsHuman ? "task is in needs_human" : undefined;
    return { attempt, events: own, gate, review, reviewState, gateOpen: started && gate === undefined, reportComplete, open: started && !reportComplete, ownerEligible, leadEligible: ownerEligible && leadRefusal === undefined, leadRefusal };
  });
  const dispatch = epoch.findLast((event) => event.event === "spawn_dispatched" || event.event === "respawn_dispatched");
  // v0.5.0 (ADR 0054 §5): the clean retirement is terminal beside acceptance —
  // it wins the status word wherever the slice carries one (close refuses
  // already-accepted Tasks, so the pair never legitimately coexists; a closed
  // read of a re-contracted slice is still the last word on that Task).
  const status: TaskStateStatus = closure !== undefined ? "closed" : acceptance !== undefined ? "accepted" : needsHuman ? "needs-human" : attempts.some((attempt) => attempt.open) || (dispatch !== undefined && dispatch.seq > (latestGate?.seq ?? -1)) ? "running" : numbers.length === 0 ? "waiting" : latestGate?.verdict === "green" ? "ready-to-accept" : "red";
  const currentAttempt = acceptance === undefined ? attempts.at(-1) : attempts.find((entry) => entry.attempt === acceptance.attempt);
  const verdict = acceptance === undefined ? currentAttempt?.gate?.verdict : "green";
  return { currentAttempt, verdict, task, history, contract, epochSeq, epochId, epoch, attempts, acceptance, settled, closed: closure === undefined ? undefined : { seq: closure.seq, at: closure.ts, reason: closure.reason, by: closure.closed_by ?? "owner" }, pendingLanding: acceptance?.landing === "pending-conflict", needsHuman, needs: needsHuman ? needs : undefined, status, maxAttempt: numbers.at(-1) ?? 0, inFlightAttempt: attempts.find((attempt) => attempt.open)?.attempt };
}
