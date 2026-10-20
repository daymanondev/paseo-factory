/**
 * The role-contract layer (v0.0.14, ADR 0010 §1–§2/§6): additive injection of
 * the `Supervisor`, `Lead`, and working-`Agent` role contracts — never a
 * write to `<project-root>/AGENTS.md` or `CLAUDE.md` (the `<home>-supervisor`
 * folder write is retired). Three channels carry a role, in order of
 * authority:
 *
 *   1. `server.before("agent.create")` — the request's `config.systemPrompt`
 *      is APPENDED to (the daemon maps the field to each provider's native
 *      instruction slot, so a provider without one simply ignores it — the
 *      "where supported" half of the law);
 *   2. the create's initial prompt — the seat's bootstrap orientation (the
 *      surface's ensure passes it; the driver's brief is the Agent's);
 *   3. `PASEO_FACTORY_*` env vars on `agent.session_open` — re-applied on
 *      every provider launch (the daemon's own law), so a seat's shell can
 *      always ask which seat it is. Since v0.0.16 the same channel carries
 *      `PI_CODING_AGENT_DIR` — every pi-lane role runs inside its
 *      provisioned clean-room Pi harness home (ADR 0011).
 *
 * Every rendered contract ends with the 1-line role skill trigger index
 * (ADR 0010 §6): Supervisor `grilling, domain-modeling`; Lead
 * `codebase-design, domain-modeling, tdd`; Agent `tdd, diagnosing-bugs,
 * codebase-design`. Injection is idempotent — the footer's marker line is
 * the sentinel; a request that already carries it passes through untouched.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "./core/project.ts";
import { provisionPiAgentHome } from "./core/pi-home.ts";
import {
  FOOTER_MARK,
  ROLE_SKILL_INDEX,
  SEAT_TITLES,
  renderRoleContract,
  renderSeatBootstrapPrompt,
} from "./core/roles-contract.ts";
import type { ProjectIdentity, RoleName, SeatBootstrapInput, SeatName } from "./core/roles-contract.ts";
import { listProjectRegistrations } from "./projects.ts";
import { parseTaskWorktreePath } from "../shared/worktree-shape.mjs";

export { ROLE_SKILL_INDEX, SEAT_TITLES } from "./core/roles-contract.ts";
export type { ProjectIdentity, RoleName, SeatBootstrapInput, SeatName } from "./core/roles-contract.ts";

// ---- the role contracts (the system-prompt channel) ----------------------------------------

/** The role law each seat runs under — appended to `config.systemPrompt`, never written to disk. */
export function renderSeatContract(seat: SeatName, project: ProjectIdentity): string {
  return renderRoleContract(seat, { factoryCmd: "factory", project });
}

/** The working Agent's law — appended to its task-worktree agent's system prompt. */
export function renderAgentContract(task: string, slug: string): string {
  return renderRoleContract("agent", { factoryCmd: "factory", project: { root: "", slug }, task });
}

// ---- the bootstrap orientation (the initial-prompt channel) --------------------------------

/** The seat's bootstrap message — resolved paths, day-one commands, the skill footer. */
export function renderSeatBootstrap(input: SeatBootstrapInput): string {
  return renderSeatBootstrapPrompt(input);
}

// ---- the PASEO_FACTORY_* env channel -------------------------------------------------------

/**
 * The env vars one role's shells carry (the session_open channel — re-applied
 * on every launch). Since v0.0.16 (ADR 0011) this is also the provisioning
 * seam for the role's isolated Pi harness home: the call materializes
 * `<stateDir>/pi-agent/<role>` on demand (idempotently — the provisioner's
 * law) and returns it as `PI_CODING_AGENT_DIR`, so every pi-lane seat and
 * working agent runs inside the clean room instead of the operator's global
 * `~/.pi/agent`. `userHome` overrides the operator home the shared-state
 * symlinks point back at (default `<homedir()>`; hermetic tests pass a fake).
 */
export function factoryEnvFor(role: RoleName, input: { stateDir: string; project: ProjectIdentity; task?: string; userHome?: string }): Record<string, string> {
  const roleHome = provisionPiAgentHome({
    stateDir: input.stateDir,
    role,
    sourceAgentDir: join(input.userHome ?? homedir(), ".pi", "agent"),
  });
  const env: Record<string, string> = {
    PASEO_FACTORY_SEAT: role,
    PASEO_FACTORY_PROJECT: input.project.slug,
    PASEO_FACTORY_STATE_DIR: input.stateDir,
    PI_CODING_AGENT_DIR: roleHome,
  };
  if (input.project.root !== "") env.PASEO_FACTORY_PROJECT_ROOT = input.project.root;
  if (input.task !== undefined) env.PASEO_FACTORY_TASK = input.task;
  return env;
}

// The before("agent.create") request slice — the SDK's shape restated locally
// so the pure function stays testable without a server.
export interface AgentCreateRequest {
  config: { provider?: string; cwd: string; title?: string | null; systemPrompt?: string };
  env?: Record<string, string>;
}

/**
 * The additive `agent.create` injection (channel 1 + the first-launch env): a
 * seat-titled create or a managed-worktree create gets its role contract
 * APPENDED to `config.systemPrompt` (idempotent — the footer is the sentinel)
 * and its `PASEO_FACTORY_*` env seeded — since v0.0.16 including the
 * provisioned role's `PI_CODING_AGENT_DIR` (the clean-room Pi harness home).
 * Strangers pass through untouched (`undefined` — the daemon sees the original
 * request). Seats resolve their project from the create's cwd (git answers);
 * working agents from the worktree shape. Generic over the request so the
 * SDK's full create shape (mcpServers, settings, …) rides through unchanged.
 * `userHome` (default `<homedir()>`) overrides the operator home the harness
 * home's shared-state symlinks point back at — hermetic tests pass a fake.
 */
export function injectRoleOnCreate<R extends AgentCreateRequest>(request: R, stateDir: string, userHome?: string): R | undefined {
  if ((request.config.systemPrompt ?? "").includes(FOOTER_MARK)) return undefined; // already injected — idempotent
  const title = request.config.title ?? "";
  if (title === SEAT_TITLES.supervisor || title === SEAT_TITLES.lead) {
    const seat: SeatName = title === SEAT_TITLES.supervisor ? "supervisor" : "lead";
    const project = resolveProject(request.config.cwd);
    if (!project.ok) return undefined; // a seat title on a non-repo cwd is not ours to guess about
    return {
      ...request,
      config: { ...request.config, systemPrompt: appendContract(request.config.systemPrompt, renderSeatContract(seat, project)) },
      env: { ...(request.env ?? {}), ...factoryEnvFor(seat, { stateDir, project, userHome }) },
    };
  }
  const worktree = parseTaskWorktreePath(stateDir, request.config.cwd);
  if (worktree === null) return undefined;
  return {
    ...request,
    config: { ...request.config, systemPrompt: appendContract(request.config.systemPrompt, renderAgentContract(worktree.task, worktree.slug)) },
    env: { ...(request.env ?? {}), ...factoryEnvFor("agent", { stateDir, project: { root: "", slug: worktree.slug }, task: worktree.task, userHome }) },
  };
}

function appendContract(existing: string | undefined, contract: string): string {
  return existing === undefined || existing === "" ? contract : `${existing}\n\n${contract}`;
}

/**
 * The `agent.session_open` injection (channel 3): every launch of a seat or
 * working-agent shell re-carries its `PASEO_FACTORY_*` identity — since
 * v0.0.16 including its provisioned `PI_CODING_AGENT_DIR`, so every provider
 * launch (not just the create) runs inside the clean-room Pi harness home.
 * Working agents match by their managed-worktree cwd; seats by agent id
 * against the project registry the ensure path keeps. Anything else passes
 * through. `userHome` (default `<homedir()>`) overrides the operator home the
 * harness home's shared-state symlinks point back at — hermetic tests pass a
 * fake.
 */
export function injectSessionEnv<R extends { agentId: string; cwd: string; env: Record<string, string> }>(
  request: R,
  stateDir: string,
  userHome?: string,
): R | undefined {
  const worktree = parseTaskWorktreePath(stateDir, request.cwd);
  if (worktree !== null) {
    return { ...request, env: { ...request.env, ...factoryEnvFor("agent", { stateDir, project: { root: "", slug: worktree.slug }, task: worktree.task, userHome }) } };
  }
  for (const registration of listProjectRegistrations(stateDir)) {
    const seat = request.agentId === registration.supervisor ? "supervisor" : request.agentId === registration.lead ? "lead" : undefined;
    if (seat === undefined) continue;
    return { ...request, env: { ...request.env, ...factoryEnvFor(seat, { stateDir, project: registration, userHome }) } };
  }
  return undefined;
}
