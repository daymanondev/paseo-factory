/**
 * The Live-Seat Transition Law's pure planner (v0.0.38, ADR 0026 §3): given
 * the current and next 6-lane tables plus the scope's live standing seats, it
 * names every seat whose lane changes and whether the change stays inside one
 * provider family (an in-place model sync that keeps the session) or crosses
 * families (the live seat must be retired/rotated — a session cannot switch
 * its provider harness after creation). Zero React Native runtime imports so
 * Node unit tests can exercise the law directly (the kanban.ts precedent).
 */
import type { AgentView, Lanes } from "../../shared/view.ts";

/** One live standing seat's pending lane change — the modal's one row. */
export interface LiveSeatTransition {
  seat: "supervisor" | "lead";
  agentId: string;
  fromLane: string;
  toLane: string;
  fromProviderFamily: string;
  toProviderFamily: string;
  mode: "in-place" | "retire";
}

/** The provider family of a lane — the segment before the first "/". */
export function providerFamilyOf(lane: string): string {
  const slash = lane.indexOf("/");
  return slash === -1 ? lane : lane.slice(0, slash);
}

/**
 * Plans the live-seat impact of a lane-table change (Implementation Decision
 * 4): for each of `supervisor` and `lead`, a live seat whose lane value
 * changes produces one transition — same provider family → "in-place"
 * (the model/thinking sync keeps the current session), a different family →
 * "retire" (the session is archived and recreated on the new harness).
 * Vacant seats and unchanged lanes produce nothing.
 */
export function planLiveSeatTransitions(
  currentLanes: Lanes,
  nextLanes: Lanes,
  liveSeats: { supervisor: AgentView | null; lead: AgentView | null },
): LiveSeatTransition[] {
  const transitions: LiveSeatTransition[] = [];
  for (const seat of ["supervisor", "lead"] as const) {
    const agent = liveSeats[seat];
    if (agent === null) continue;
    const fromLane = currentLanes[seat];
    const toLane = nextLanes[seat];
    if (fromLane === toLane) continue;
    const fromProviderFamily = providerFamilyOf(fromLane);
    const toProviderFamily = providerFamilyOf(toLane);
    transitions.push({
      seat,
      agentId: agent.id,
      fromLane,
      toLane,
      fromProviderFamily,
      toProviderFamily,
      mode: fromProviderFamily === toProviderFamily ? "in-place" : "retire",
    });
  }
  return transitions;
}
