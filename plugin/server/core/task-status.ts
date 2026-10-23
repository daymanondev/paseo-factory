/** Shared read-only Task status, generated for installed CLI and single-file MCP. */
import type { LedgerEvent } from "./events.ts";
import { projectTask } from "./task-state.ts";

export function taskStatusLines(events: readonly LedgerEvent[], workspaceFilter?: string): string[] {
  // Contract identity is the Task's public registration. Global events and
  // unbound dispatch refusals never invent Tasks in an operational status view.
  const tasks = [...new Set(events.flatMap(event => event.event === "contract_set" ? [event.task] : []))];
  const lines: string[] = [];
  for (const task of tasks) {
    const state = projectTask(events, task);
    if (workspaceFilter && state.contract?.workspace && state.contract.workspace !== workspaceFilter) continue;
    const gate = state.epoch.findLast(event => event.event === "gate_finished");
    const current = state.attempts.at(-1);
    const review = current?.review;
    const count = (kind: LedgerEvent["event"]) => state.epoch.filter(event => event.event === kind).length;
    const eligible = (role: "ownerEligible" | "leadEligible") => state.attempts.filter(attempt => attempt[role]).map(attempt => attempt.attempt).join(",") || "-";
    lines.push(`${task} attempts=${state.maxAttempt} verdict=${gate?.verdict ?? "-"} sha=${gate?.sha?.slice(0, 7) ?? "-"} accepted=${state.acceptance === undefined ? "no" : "yes"} eye=${review?.outcome ?? "-"} choke=${count("permit_allowed")}/${count("permit_denied")}/${count("git_blocked")}` +
      (state.needs === undefined ? "" : ` needs-human=${state.needs.reason}`) +
      ` review=${current?.reviewState ?? (state.contract?.freshEyes === true ? "pending" : "off")} owner-eligible=${eligible("ownerEligible")} lead-eligible=${eligible("leadEligible")}`);
  }
  const retro = events.findLast(event => event.event === "retro_written");
  if (retro !== undefined) {
    const count = retro.outcome === "written" && Number.isInteger(retro.proposalCount) ? ` proposals=${retro.proposalCount}` : "";
    lines.push(`retro last=${retro.ts.slice(0, 10)} outcome=${retro.outcome}${count}`);
  }
  return lines;
}
