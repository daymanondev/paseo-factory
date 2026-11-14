/** Shared read-only Task status, generated for installed CLI and single-file MCP. */
import type { LedgerEvent } from "./events.ts";
import { projectTask } from "./task-state.ts";

export interface TaskStatusOptions {
  /** Collapse settled (`accepted` and `closed`) Tasks into one summary line (Paseo Room `LEAN_HISTORY` discipline). */
  lean?: boolean;
}

const LEAN_SETTLED_TAIL = 5;

function classifySettled(state: ReturnType<typeof projectTask>): "accepted" | "closed" | null {
  if (state.closed !== undefined) return "closed";
  if (state.acceptance !== undefined && !state.pendingLanding) return "accepted";
  return null;
}

function formatReviewSummary(state: ReturnType<typeof projectTask>): { sha: string; eye: string; review: string } {
  const current = state.currentAttempt;
  return {
    sha: current?.gate?.sha?.slice(0, 7) ?? "-",
    eye: current?.review?.outcome ?? "-",
    review: current?.reviewState ?? (state.contract?.freshEyes === true ? "pending" : "off"),
  };
}

function renderTaskStatusLine(events: readonly LedgerEvent[], task: string, workspaceFilter?: string): { line: string; settled: "accepted" | "closed" | null } | null {
  const state = projectTask(events, task);
  if (workspaceFilter && state.contract?.workspace && state.contract.workspace !== workspaceFilter) return null;
  const { sha, eye, review } = formatReviewSummary(state);
  const count = (kind: LedgerEvent["event"]) => state.epoch.filter(event => event.event === kind).length;
  const eligible = (role: "ownerEligible" | "leadEligible") => state.attempts.filter(attempt => attempt[role]).map(attempt => attempt.attempt).join(",") || "-";
  const closedPart = state.closed === undefined ? "" : ` closed=yes reason="${state.closed.reason}"`;
  const needsPart = state.needs === undefined ? "" : ` needs-human=${state.needs.reason}`;
  const acceptedFlag = state.acceptance === undefined ? "no" : "yes";
  const line =
    `${task} attempts=${state.maxAttempt} verdict=${state.verdict ?? "-"} sha=${sha} accepted=${acceptedFlag}` +
    `${closedPart} eye=${eye} choke=${count("permit_allowed")}/${count("permit_denied")}/${count("git_blocked")}` +
    `${needsPart} review=${review} owner-eligible=${eligible("ownerEligible")} lead-eligible=${eligible("leadEligible")}`;
  return { line, settled: classifySettled(state) };
}

export function taskStatusLines(events: readonly LedgerEvent[], workspaceFilter?: string, options?: TaskStatusOptions): string[] {
  // Contract identity is the Task's public registration. Global events and
  // unbound dispatch refusals never invent Tasks in an operational status view.
  const tasks = [...new Set(events.flatMap(event => event.event === "contract_set" ? [event.task] : []))];
  const rendered: Array<{ task: string; line: string; settled: "accepted" | "closed" | null }> = [];
  for (const task of tasks) {
    const entry = renderTaskStatusLine(events, task, workspaceFilter);
    if (entry !== null) rendered.push({ task, ...entry });
  }
  if (!options?.lean) return rendered.map(entry => entry.line);

  const accepted = rendered.filter(entry => entry.settled === "accepted").map(entry => entry.task);
  const closed = rendered.filter(entry => entry.settled === "closed").map(entry => entry.task);
  const active = rendered.filter(entry => entry.settled === null).map(entry => entry.line);
  const lines: string[] = [];
  if (accepted.length > 0 || closed.length > 0) {
    const parts: string[] = [];
    if (accepted.length > 0) {
      const tail = accepted.slice(-LEAN_SETTLED_TAIL).join(", ");
      parts.push(`accepted=${accepted.length} (${accepted.length > LEAN_SETTLED_TAIL ? `latest ${LEAN_SETTLED_TAIL}: ` : ""}${tail})`);
    }
    if (closed.length > 0) {
      const tail = closed.slice(-LEAN_SETTLED_TAIL).join(", ");
      parts.push(`closed=${closed.length} (${closed.length > LEAN_SETTLED_TAIL ? `latest ${LEAN_SETTLED_TAIL}: ` : ""}${tail})`);
    }
    lines.push(`settled: ${parts.join(" · ")} — pass full=true for all ${rendered.length} rows`);
  }
  lines.push(...active);
  if (active.length === 0 && lines.length > 0) {
    lines.push("active: none (all contracted tasks are settled)");
  }
  return lines;
}
