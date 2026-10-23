/** Pure interpretation of a Task's current Contract epoch and its Attempts.
 * Numeric Attempt identities are local to this epoch, never the whole Task.
 */
import type { AttemptAccepted, ContractSet, FreshEyesWritten, GateFinished, LedgerEvent, NeedsHuman } from "./events.ts";

export type AcceptanceRole = "owner" | "supervisor" | "lead" | "agent";
export type TaskStateStatus = "accepted" | "needs-human" | "running" | "waiting" | "ready-to-accept" | "red";
export type ReviewState = "off" | "pending" | "incomplete" | "clear" | "concern" | "failed";

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
    const leadRefusal = needsHuman ? "task is in needs_human" : reviewState === "concern" ? "attempt carries a fresh-eyes CONCERN" : contract?.freshEyes === true && reviewState !== "clear" ? `required fresh-eyes review is ${reviewState}; completed CLEAR is required` : undefined;
    return { attempt, events: own, gate, review, reviewState, gateOpen: started && gate === undefined, reportComplete, open: started && !reportComplete, ownerEligible, leadEligible: ownerEligible && leadRefusal === undefined, leadRefusal };
  });
  const dispatch = epoch.findLast((event) => event.event === "spawn_dispatched" || event.event === "respawn_dispatched");
  const status: TaskStateStatus = acceptance !== undefined ? "accepted" : needsHuman ? "needs-human" : attempts.some((attempt) => attempt.open) || (dispatch !== undefined && dispatch.seq > (latestGate?.seq ?? -1)) ? "running" : numbers.length === 0 ? "waiting" : latestGate?.verdict === "green" ? "ready-to-accept" : "red";
  return { task, history, contract, epochSeq, epochId, epoch, attempts, acceptance, settled, pendingLanding: acceptance?.landing === "pending-conflict", needsHuman, needs: needsHuman ? needs : undefined, status, maxAttempt: numbers.at(-1) ?? 0, inFlightAttempt: attempts.find((attempt) => attempt.open)?.attempt };
}
