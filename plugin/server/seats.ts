import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "./surface-rpc.ts";
import { listProjectRegistrations, readProjectRegistration } from "./core/project.ts";
import { inferRoleFromProviderId } from "./roles.ts";

/** All live holders, canonical registration binding first, then newest activity. */
export function seatCandidates(agents: SurfaceAgentSnapshot[], stateDir: string, seat: "supervisor" | "lead", slug?: string): SurfaceAgentSnapshot[] {
  const registration = slug === undefined ? undefined : readProjectRegistration(stateDir, slug);
  const bound = registration?.[seat];
  return agents.filter(agent => agent.archivedAt === null && (
    agent.id === bound ||
    (agent.labels?.seat === seat && (slug === undefined || agent.labels.project === slug)) ||
    (inferRoleFromProviderId(agent.provider) === seat && (slug === undefined || agent.labels?.project === slug || agent.cwd === registration?.root))
  )).sort((a, b) => Number(b.id === bound) - Number(a.id === bound) || b.updatedAt.localeCompare(a.updatedAt));
}

export async function liveSeatCandidates(daemon: SurfaceDaemonApi, stateDir: string, seat: "supervisor" | "lead", slug?: string): Promise<SurfaceAgentSnapshot[]> {
  const page = await daemon.agents.list({ filter: { includeArchived: false, includeBackground: true } });
  const agents = [...new Map(page.entries.map(entry => [entry.agent.id, entry.agent])).values()];
  const candidates = seatCandidates(agents, stateDir, seat, slug);
  if (slug !== undefined) return candidates;
  for (const registration of listProjectRegistrations(stateDir)) candidates.push(...seatCandidates(agents, stateDir, seat, registration.slug));
  return [...new Map(candidates.map(agent => [agent.id, agent])).values()];
}
