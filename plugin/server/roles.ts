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
 *      always ask which seat it is.
 *
 * Every rendered contract ends with the 1-line role skill trigger index
 * (ADR 0010 §6): Supervisor `grilling, domain-modeling`; Lead
 * `codebase-design, domain-modeling, tdd`; Agent `tdd, diagnosing-bugs,
 * codebase-design`. Injection is idempotent — the footer's marker line is
 * the sentinel; a request that already carries it passes through untouched.
 */
import { join } from "node:path";
import { projectStateDir, resolveProject } from "./core/project.ts";
import type { ProjectResolution } from "./core/project.ts";
import { listProjectRegistrations } from "./projects.ts";

/**
 * The Project identity slice every role renderer carries — ProjectResolution's
 * ok branch reduced to its two load-bearing fields, so `{root, slug}` never
 * travels as an anonymous clump (the working agent's synthetic identity —
 * root unknown from a worktree cwd — is the same shape with `root: ""`).
 */
export type ProjectIdentity = Pick<Extract<ProjectResolution, { ok: true }>, "root" | "slug">;

/** The seat titles the surface's ensure mints — how the create hook tells a seat from a stranger. */
export const SEAT_TITLES = { supervisor: "Supervisor (paseo-factory)", lead: "Lead (paseo-factory)" } as const;

export type SeatName = keyof typeof SEAT_TITLES;

/** The working-agent role — task-bound, worktree-rooted, never a seat. */
export type RoleName = SeatName | "agent";

/** The 1-line role skill trigger index footers (ADR 0010 §6). */
export const ROLE_SKILL_INDEX: Record<RoleName, string> = {
  supervisor: "grilling, domain-modeling",
  lead: "codebase-design, domain-modeling, tdd",
  agent: "tdd, diagnosing-bugs, codebase-design",
};

/** The footer's marker — the idempotency sentinel for every injection below. */
const FOOTER_MARK = "paseo-factory role skills:";

function skillFooter(role: RoleName): string {
  return `${FOOTER_MARK} ${ROLE_SKILL_INDEX[role]}`;
}

// ---- the role contracts (the system-prompt channel) ----------------------------------------

/** The role law each seat runs under — appended to `config.systemPrompt`, never written to disk. */
export function renderSeatContract(seat: SeatName, project: ProjectIdentity): string {
  const lines: string[] = [
    `You are the ${seat === "supervisor" ? "Supervisor" : "Lead"} seat of the paseo-factory verification loop for this project (${project.slug}, rooted at ${project.root}).`,
  ];
  if (seat === "supervisor") {
    lines.push(
      "You are the sole conversational door to the Owner: clarify intent, agree the outcome and boundaries, and relay what the factory measured — Verdicts, Watch lines, needs-human stalls — in words; the Owner's answers ride you back down.",
      "You never grade work yourself: the Gate, the Choke, the Watch and the Ledger are the law, and `factory` (the Owner CLI, run from its explicit path) performs the Owner's acts — contract, run, accept --by supervisor.",
      "When the Owner states a project rule in chat or ratifies a Retro proposal, record it in this repository's AGENTS.md or CONTEXT.md — you (and the Lead) are the only seats that may edit project memory.",
    );
  } else {
    lines.push(
      "You read the repository, split the Supervisor's directive into Tasks, and set each Contract (gate, artifact, scope, skills) with `factory contract`; invoke the Driver (`factory run`) and inspect the Verdict / Fresh-eyes / Watch / Report evidence before reporting back to the Supervisor.",
      "You may accept an intermediate Task's green, CONCERN-free Attempt (`factory accept --by lead`); a CONCERN or a needs-human task is never yours to accept — correct it or escalate.",
      "You may update this repository's AGENTS.md or CONTEXT.md when the Owner ratifies a rule; working Agents never may.",
    );
  }
  lines.push(
    "This instruction is additive: the repository's own AGENTS.md / CLAUDE.md, MCP servers, and skills catalog load natively alongside it — never overwrite them.",
    "",
    skillFooter(seat),
  );
  return lines.join("\n");
}

/** The working Agent's law — appended to its task-worktree agent's system prompt. */
export function renderAgentContract(task: string, slug: string): string {
  return [
    `You are a working Agent of the paseo-factory verification loop (task ${task}, project ${slug}): you work your Contract inside this Task worktree and claim with factory-claim when the Gate's done-criteria hold.`,
    "You never modify AGENTS.md, CLAUDE.md, or CONTEXT.md unless your Contract's scope explicitly lists them — project memory is written by the Supervisor and Lead, not by you.",
    "Factory orchestration (the `factory` CLI: contract, run, accept) is withheld from you by PATH and by this brief — the only factory commands on your PATH are factory-claim and the git shim. The daemon exposes plugin tools (paseoTools) to every agent today, so an orchestration surface may still be visible to you: never call it — setting contracts, running the Driver, and accepting are the Owner's, Supervisor's, and Lead's acts.",
    "This instruction is additive: the repository's own AGENTS.md / CLAUDE.md, MCP servers, and skills catalog load natively alongside it.",
    "",
    skillFooter("agent"),
  ].join("\n");
}

// ---- the bootstrap orientation (the initial-prompt channel) --------------------------------

/** The seat's bootstrap message — resolved paths, day-one commands, the skill footer. */
export function renderSeatBootstrap(input: {
  seat: SeatName;
  home: string;
  stateDir: string;
  pluginDir?: string;
  nodePath: string;
  path: string;
  lane: string;
  project: ProjectIdentity;
}): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const runner = /Paseo Helper/i.test(input.nodePath) ? `ELECTRON_RUN_AS_NODE=1 ${quote(input.nodePath)}` : quote(input.nodePath);
  const factoryCmd = input.pluginDir !== undefined ? `${runner} ${quote(join(input.pluginDir, "bin", "factory.mjs"))}` : "factory";
  return [
    `# ${input.seat === "supervisor" ? "Supervisor" : "Lead"} (paseo-factory) — project ${input.project.slug}`,
    "",
    input.seat === "supervisor"
      ? "You are this project's delegated Owner seat: the one agent the Owner converses with. Relay what the factory measured in words; the Owner's answers ride you back down. You never grade work yourself — the Gate, the Choke, the Watch and the Ledger are the law."
      : "You are this project's standing Lead: read the repository, split the Supervisor's directive into Tasks, set each Contract, invoke the Driver, inspect the evidence, accept green CONCERN-free intermediate work, and report back to the Supervisor.",
    "",
    "- Project root (your cwd): " + input.project.root,
    "- Paseo home (the daemon this seat serves): " + input.home,
    "- Factory state (this project's ledger, reports, worktrees): " + projectStateDir(input.stateDir, input.project.slug),
    "- node: " + input.nodePath,
    `- Your model lane (lanes.json → ${input.seat}): ${input.lane}`,
    "",
    "Day-one seat commands (the Owner CLI — never on a Worker agent's PATH):",
    "",
    "  " + factoryCmd + " --home " + input.home + " contract --task <id> --workspace <dir> --gate <cmd> --artifact <path> [--scope <p1,p2>] [--skills <s1,s2>] [--watch] [--fresh-eyes] [--description <text>]",
    "  " + factoryCmd + " --home " + input.home + " run <task> [<task>...]",
    "  " + factoryCmd + " --home " + input.home + " status",
    "  " + factoryCmd + " --home " + input.home + " lanes get",
    "  " + factoryCmd + " --home " + input.home + " accept <task> --attempt <n> [--by owner|supervisor|lead]",
    "",
    'Your shells may start without node/git on PATH — export PATH="' + input.path + '" first.',
    "This seat's instructions are additive — the repository's own AGENTS.md / CLAUDE.md load natively; never overwrite them.",
    "",
    skillFooter(input.seat),
  ].join("\n");
}

// ---- the PASEO_FACTORY_* env channel -------------------------------------------------------

/** The env vars one role's shells carry (the session_open channel — re-applied on every launch). */
export function factoryEnvFor(role: RoleName, input: { stateDir: string; project: ProjectIdentity; task?: string }): Record<string, string> {
  const env: Record<string, string> = {
    PASEO_FACTORY_SEAT: role,
    PASEO_FACTORY_PROJECT: input.project.slug,
    PASEO_FACTORY_STATE_DIR: input.stateDir,
  };
  if (input.project.root !== "") env.PASEO_FACTORY_PROJECT_ROOT = input.project.root;
  if (input.task !== undefined) env.PASEO_FACTORY_TASK = input.task;
  return env;
}

/**
 * Recognizes a managed Task worktree cwd — `<stateDir>/projects/<slug>/worktrees/<task>`
 * (v0.0.14, ADR 0010 §4). The driver allocates the worktree pre-spawn, so the
 * shape alone names the project and task; anything else is not ours to inject.
 */
export function parseWorktreeCwd(stateDir: string, cwd: string): { slug: string; task: string } | null {
  if (!cwd.startsWith(`${stateDir}/projects/`)) return null;
  const segments = cwd.slice(`${stateDir}/projects/`.length).split("/");
  if (segments.length < 3) return null;
  const [slug, worktrees, task] = segments;
  if (slug === undefined || worktrees !== "worktrees" || task === undefined) return null;
  if (slug === "" || task === "") return null;
  return { slug, task };
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
 * and its `PASEO_FACTORY_*` env seeded. Strangers pass through untouched
 * (`undefined` — the daemon sees the original request). Seats resolve their
 * project from the create's cwd (git answers); working agents from the
 * worktree shape. Generic over the request so the SDK's full create shape
 * (mcpServers, settings, …) rides through unchanged.
 */
export function injectRoleOnCreate<R extends AgentCreateRequest>(request: R, stateDir: string): R | undefined {
  if ((request.config.systemPrompt ?? "").includes(FOOTER_MARK)) return undefined; // already injected — idempotent
  const title = request.config.title ?? "";
  if (title === SEAT_TITLES.supervisor || title === SEAT_TITLES.lead) {
    const seat: SeatName = title === SEAT_TITLES.supervisor ? "supervisor" : "lead";
    const project = resolveProject(request.config.cwd);
    if (!project.ok) return undefined; // a seat title on a non-repo cwd is not ours to guess about
    return {
      ...request,
      config: { ...request.config, systemPrompt: appendContract(request.config.systemPrompt, renderSeatContract(seat, project)) },
      env: { ...(request.env ?? {}), ...factoryEnvFor(seat, { stateDir, project }) },
    };
  }
  const worktree = parseWorktreeCwd(stateDir, request.config.cwd);
  if (worktree === null) return undefined;
  return {
    ...request,
    config: { ...request.config, systemPrompt: appendContract(request.config.systemPrompt, renderAgentContract(worktree.task, worktree.slug)) },
    env: { ...(request.env ?? {}), ...factoryEnvFor("agent", { stateDir, project: { root: "", slug: worktree.slug }, task: worktree.task }) },
  };
}

function appendContract(existing: string | undefined, contract: string): string {
  return existing === undefined || existing === "" ? contract : `${existing}\n\n${contract}`;
}

/**
 * The `agent.session_open` injection (channel 3): every launch of a seat or
 * working-agent shell re-carries its `PASEO_FACTORY_*` identity. Working
 * agents match by their managed-worktree cwd; seats by agent id against the
 * project registry the ensure path keeps. Anything else passes through.
 */
export function injectSessionEnv<R extends { agentId: string; cwd: string; env: Record<string, string> }>(
  request: R,
  stateDir: string,
): R | undefined {
  const worktree = parseWorktreeCwd(stateDir, request.cwd);
  if (worktree !== null) {
    return { ...request, env: { ...request.env, ...factoryEnvFor("agent", { stateDir, project: { root: "", slug: worktree.slug }, task: worktree.task }) } };
  }
  for (const registration of listProjectRegistrations(stateDir)) {
    const seat = request.agentId === registration.supervisor ? "supervisor" : request.agentId === registration.lead ? "lead" : undefined;
    if (seat === undefined) continue;
    return { ...request, env: { ...request.env, ...factoryEnvFor(seat, { stateDir, project: registration }) } };
  }
  return undefined;
}
