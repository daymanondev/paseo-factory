/** Shared live Peer binding for lifecycle enforcement and handoff rosters. */
import { readCorrelations } from "./core/correlations.ts";
import type { LedgerEvent } from "./core/events.ts";
import { taskWorktreePath } from "./core/workspace.ts";
import { inferRoleFromProviderId } from "./roles.ts";
import type { SurfaceAgentSnapshot } from "./surface-rpc.ts";

export function peerIsRunning(agent: SurfaceAgentSnapshot): boolean {
  return agent.status === "running" || agent.status === "initializing";
}

export function boundTaskPeers(input: {
  stateDir: string;
  slug: string;
  task: string;
  events: readonly LedgerEvent[];
  live: readonly SurfaceAgentSnapshot[];
}): SurfaceAgentSnapshot[] {
  const { stateDir, slug, task, events, live } = input;
  const correlations = readCorrelations(stateDir).filter(rec => rec.role === "agent" && rec.projectSlug === slug && rec.task === task);
  const ids = new Set(correlations.map(rec => rec.agentId));
  const paths = new Set([taskWorktreePath(stateDir, slug, task)]);
  for (const evt of events) {
    if (evt.event === "spawn_dispatched" && evt.task === task && evt.worktree) paths.add(evt.worktree);
  }
  const epoch = events.findLast(evt => evt.event === "contract_set" && evt.task === task)?.ts;
  const currentIds = new Set(correlations.filter(rec => epoch === undefined || rec.issuedAt >= epoch).map(rec => rec.agentId));
  return live.filter(agent => {
    if (agent.archivedAt !== null) return false;
    const role = agent.labels?.seat ?? inferRoleFromProviderId(agent.provider);
    if (role === "supervisor" || role === "lead") return false;
    if (agent.labels?.project !== undefined && agent.labels.project !== slug) return false;
    return ids.has(agent.id) || [...paths].some(path => agent.cwd === path || agent.cwd?.startsWith(`${path}/`)) ||
      (agent.labels?.task === task && agent.labels?.project === slug);
  }).sort((a, b) => Number(peerIsRunning(b)) - Number(peerIsRunning(a)) || Number(currentIds.has(b.id)) - Number(currentIds.has(a.id)));
  // Stable sort preserves the daemon's newest-first order among equivalent peers.
}
