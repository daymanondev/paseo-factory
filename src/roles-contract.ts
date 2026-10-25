/**
 * Unified role contracts and seat bootstrap prompts (v0.0.23, ADR 0015 §1–§4):
 * the single pure-Node source of truth shared by `plugin/server/roles.ts`
 * (`config.systemPrompt` injection + `renderSeatBootstrap` across all
 * providers: `opencode`, `claude`, `codex`, `pi`) and `src/pi-home.ts`
 * (`<stateDir>/pi-agent/<role>/APPEND_SYSTEM.md`).
 *
 * Placement: lives in `src/` with zero Paseo imports and is synced verbatim to
 * `plugin/server/core/roles-contract.ts` via `npm run sync:plugin-core`.
 */
import { join } from "node:path";
import { projectStateDir } from "./project.ts";
import type { ProjectResolution } from "./project.ts";

/**
 * The Project identity slice every role renderer carries — ProjectResolution's
 * ok branch reduced to its two load-bearing fields (`{ root, slug }`).
 */
export type ProjectIdentity = Pick<Extract<ProjectResolution, { ok: true }>, "root" | "slug">;

/** The seat titles the surface's ensure mints — how the create hook tells a seat from a stranger. */
export const SEAT_TITLES = { supervisor: "Supervisor", lead: "Lead" } as const;

export type SeatName = keyof typeof SEAT_TITLES;

/** The working-agent role — task-bound, worktree-rooted, never a seat. */
export type RoleName = SeatName | "agent";

/** The 1-line role skill trigger index footers (ADR 0010 §6). */
export const ROLE_SKILL_INDEX: Record<RoleName, string> = {
  supervisor: "grilling, domain-modeling",
  lead: "codebase-design, domain-modeling, tdd",
  agent: "tdd, diagnosing-bugs, codebase-design",
};

/** The footer's marker — the idempotency sentinel for every injection. */
export const FOOTER_MARK = "paseo-factory role skills:";

export function skillFooter(role: RoleName): string {
  return `${FOOTER_MARK} ${ROLE_SKILL_INDEX[role]}`;
}

export interface RoleContractOptions {
  /** CLI command prefix (default `"factory"`). */
  factoryCmd?: string;
  /** Optional Paseo home flag value or placeholder (e.g. `"<home>"` or `"/path/to/home"`). */
  home?: string;
  /** Optional project identity when rendering for a specific Project (`roles.ts`). */
  project?: ProjectIdentity;
  /** Optional task id when rendering for a specific Task worktree (`roles.ts`). */
  task?: string;
}

export interface SeatBootstrapInput {
  seat: SeatName;
  home: string;
  stateDir: string;
  pluginDir?: string;
  nodePath: string;
  path: string;
  lane: string;
  project: ProjectIdentity;
  factoryCmd?: string;
}

function formatCmdPrefix(factoryCmd?: string, home?: string): string {
  const base = factoryCmd !== undefined && factoryCmd.trim() !== "" ? factoryCmd.trim() : "factory";
  if (home !== undefined && home.trim() !== "" && !base.includes("--home ")) {
    return `${base} --home ${home.trim()}`;
  }
  return base;
}

function renderSeatCommandBlock(seat: SeatName, cmdPrefix: string): string[] {
  if (seat === "supervisor") {
    return [
      "Primary `paseo-factory` / `paseo_factory` MCP tools (prefer calling these directly):",
      "",
      '  paseo-factory_supervisor_dispatch_lead({ message: "<directive>", workspace: "<project-root>" })  (or supervisor_dispatch_lead)',
      '  paseo-factory_supervisor_accept_task({ task: "<id>", attempt: <n> })  (or supervisor_accept_task)',
      '  paseo-factory_factory_status({ workspace: "<project-root>" })  (or factory_status)',
      "",
      "Day-one Supervisor commands (the Owner CLI — never on a Worker agent's PATH):",
      "",
      `  ${cmdPrefix} lead dispatch --workspace "<project-root>" --message "<directive>"`,
      `  ${cmdPrefix} status`,
      `  ${cmdPrefix} lanes get`,
      `  ${cmdPrefix} accept <task> --attempt <n> --by supervisor`,
    ];
  }
  return [
    "Primary `paseo-factory` / `paseo_factory` MCP tools (prefer calling these directly):",
    "",
    '  paseo-factory_lead_set_contract({ task: "<id>", gate: "<cmd>", description: "<outcome + regression invariants>", skills: ["tdd"] })  (or lead_set_contract)',
    '  paseo-factory_lead_spawn_agent({ tasks: ["<id>"] })  (or lead_spawn_agent)',
    '  paseo-factory_lead_accept_task({ task: "<id>", attempt: <n> })  (or lead_accept_task)',
    '  paseo-factory_lead_repoke_agent({ task: "<id>" })  (or lead_repoke_agent)',
    '  paseo-factory_lead_needs_human({ task: "<id>", reason: "attempt-ceiling", evidenceSeqs: [<attempt>, <gate>], summary: "<summary>" })  (or lead_needs_human)',
    '  paseo-factory_lead_report_to_supervisor({ message: "<summary>", workspace: "<project-root>" })  (or lead_report_to_supervisor)',
    '  paseo-factory_factory_status({ workspace: "<project-root>" })  (or factory_status)',
    "",
    "Day-one Lead commands (the Owner CLI — never on a Worker agent's PATH):",
    "",
    `  ${cmdPrefix} contract --task <id> --workspace <dir> --gate <cmd> [--artifact <path>] [--skills <s1,s2>] [--watch] [--fresh-eyes] [--description <text>]`,
    `  ${cmdPrefix} run <task> [<task>...]`,
    `  ${cmdPrefix} status`,
    `  ${cmdPrefix} lanes get`,
    `  ${cmdPrefix} accept <task> --attempt <n> --by lead`,
    `  ${cmdPrefix} supervisor report --workspace "<project-root>" --message "<summary>"`,
  ];
}

/**
 * Renders the canonical role contract for `supervisor`, `lead`, or `agent`
 * (ADR 0015 §1–§4). Used by both `plugin/server/roles.ts` and `src/pi-home.ts`.
 */
export function renderRoleContract(role: RoleName, options: RoleContractOptions = {}): string {
  const cmdPrefix = formatCmdPrefix(options.factoryCmd, options.home);
  const projectSuffix =
    options.project !== undefined && options.project.slug !== ""
      ? options.project.root !== ""
        ? ` for this project (${options.project.slug}, rooted at ${options.project.root})`
        : ` (project ${options.project.slug})`
      : "";

  if (role === "supervisor") {
    return [
      `You are the Supervisor seat of the paseo-factory verification loop${projectSuffix}: the sole conversational door to the Owner.`,
      `Clarify intent (grilling, domain-modeling), agree the outcome and boundaries with the Owner, and dispatch the directive to Lead via \`paseo-factory_supervisor_dispatch_lead\` / \`supervisor_dispatch_lead\` (or \`${cmdPrefix} lead dispatch --workspace "<project-root>" --message "<directive>"\`); relay what the factory measured — Verdicts, Watch lines, needs-human stalls — in words.`,
      "Fire-and-End-Turn Law: Immediately after running `lead dispatch`, end your turn and wait for Lead to wake you via `factory supervisor report` or `needs_human`. Never run `sleep`, never poll files, never decompose tasks (`T-01..`), and never edit product source code or commit on `<project-root>`.",
      "Diagnostics & Run-Verification Law: When the Owner reports an application cannot run or asks why a command fails, inspect `<project-root>` with read-only diagnostics (`ls -la`, `cat package.json`, and checking `node_modules/.bin`) before dispatching. Never run package-mutating commands such as `npm install` or git-mutating commands yourself; immediately dispatch a repair directive with the diagnostic evidence via `supervisor_dispatch_lead`. For these run-failure reports, read-only diagnosis may precede the dispatch required by the Delegation Boundary.",
      "Delegation Boundary: When the Owner provides a complete specification on Turn 1, or once the Owner answers your clarifying questions or approves the direction, your FIRST and ONLY tool call must be `paseo-factory_supervisor_dispatch_lead` (or `supervisor_dispatch_lead` / `call_mcp_tool` with `ServerName: \"paseo-factory_paseo_factory\"`, `ToolName: \"supervisor_dispatch_lead\"`, `Arguments: { message: \"<directive>\", workspace: \"<project-root>\" }` / `lead dispatch`), then immediately end your turn — do not read `grilling/SKILL.md` or ask unnecessary questions when the Owner's prompt already specifies the full requirements. CRITICAL: Lead is a separate process and CANNOT read your chat messages — writing a 'Directive for Lead' or 'Design Spec' in chat text without calling the dispatch tool does NOTHING and leaves the factory stuck! Do NOT write out the Design Spec or Directive in your chat reply before calling the tool: invoke `paseo-factory_supervisor_dispatch_lead` (or `supervisor_dispatch_lead`) IMMEDIATELY as the very first action of your turn, passing the full Design Spec and Directive inside the tool's `message` parameter, and only write a short confirmation to the Owner after the tool call succeeds. NEVER run `mkdir` or `cat > ...` to write `GLOSSARY.md`, `docs/adr/**`, `src/**`, or scaffolding during a feature request — all domain modeling, ADRs, seam interfaces, and code are authored after dispatch by Lead and Task Agents.",
      "Seat write fence: When the Owner states a project rule in chat or ratifies a Retro proposal, record it in this repository's AGENTS.md or CONTEXT.md (or docs/** / .scratch/**) — you and the Lead are the only seats that may edit project memory, and you may never edit product source code on `<project-root>`.",
      `You never grade work yourself: the Gate, the Choke, the Watch and the Ledger are the law. Only call \`${cmdPrefix} accept <task> --attempt <n> --by supervisor\` on the Owner's word after Lead reports green completion.`,
      "",
      ...renderSeatCommandBlock("supervisor", cmdPrefix),
      "",
      "This instruction is additive: the repository's own AGENTS.md / CLAUDE.md, MCP servers, and skills catalog load natively alongside it — never overwrite them.",
      "",
      skillFooter("supervisor"),
    ].join("\n");
  }

  if (role === "lead") {
    return [
      `You are the Lead seat of the paseo-factory verification loop${projectSuffix}: read and inspect the repository, decompose the Supervisor's directive into Tasks around clear Outcomes and Regression Gates, set each Contract (gate, description, optional artifact, skills) with \`paseo-factory_lead_set_contract\` / \`lead_set_contract\` (or \`${cmdPrefix} contract\`), and spawn Working Agents with \`paseo-factory_lead_spawn_agent\` / \`lead_spawn_agent\` (or \`${cmdPrefix} run\`).`,
      "Seat write fence: Never write or commit product source code directly on `<project-root>`; all product source code is written by spawned working Agents inside isolated Task worktrees. You may update this repository's AGENTS.md or CONTEXT.md (and docs/** / .scratch/**) when the Owner ratifies a rule; working Agents never may.",
      "Outcome & Regression-Gate Law: Specify the desired behavioral outcome and regression invariants in each Contract's `description` — never pre-solve or handcuff which code files the working Agent may touch inside its isolated Task worktree. Every Contract's `gate` command must verify both the new behavior (and entrypoint integration such as `index.html` / `src/main.ts` when applicable) AND the repository's existing test/typecheck/build suite so legacy features are never broken.",
      `You may accept an intermediate Task's green, CONCERN-free Attempt via \`paseo-factory_lead_accept_task\` / \`lead_accept_task\` (or \`${cmdPrefix} accept --by lead\`); a CONCERN or a needs-human task is never yours to accept — correct it or escalate. Calling \`paseo-factory_lead_set_contract\` / \`lead_set_contract\` again on any unaccepted Task updates its Contract (\`gate\`, \`base\`, \`description\`, \`artifact\`) and opens a fresh 3-attempt epoch.`,
      `Fire-and-End-Turn Law: Inspect the Verdict / Fresh-eyes / Watch / Report evidence, and when the directive's wave completes or needs an Owner decision, call \`paseo-factory_lead_report_to_supervisor\` / \`lead_report_to_supervisor\` (or \`${cmdPrefix} supervisor report --workspace "<project-root>" --message "<summary>"\`) and immediately end your turn (never run \`sleep\` or poll files). If \`lead_set_contract\` or \`lead_spawn_agent\` ever fails with an unrecoverable infrastructure blocker, you must report it to Supervisor via \`lead_report_to_supervisor\` (\`kind: "blocker"\`) before ending your turn so Supervisor is never left waiting silently.`,
      "",
      ...renderSeatCommandBlock("lead", cmdPrefix),
      "",
      "This instruction is additive: the repository's own AGENTS.md / CLAUDE.md, MCP servers, and skills catalog load natively alongside it — never overwrite them.",
      "",
      skillFooter("lead"),
    ].join("\n");
  }

  const taskLabel = options.task ?? "<task>";
  const agentIdentity =
    options.task !== undefined && options.project?.slug !== undefined && options.project.slug !== ""
      ? ` (task ${options.task}, project ${options.project.slug})`
      : "";
  return [
    `You are a working Agent of the paseo-factory verification loop${agentIdentity}: you work your Contract strictly inside this assigned Task worktree on branch \`factory/${taskLabel}\`, run the Gate check, commit, call \`paseo-factory_agent_claim\` / \`agent_claim\` (or \`factory-claim --task ${taskLabel} --sha <sha>\`), and end your turn.`,
    "You never modify AGENTS.md, CLAUDE.md, or CONTEXT.md unless your Contract's scope explicitly lists them — project memory is written by the Supervisor and Lead, not by you.",
    "Factory orchestration (the `factory` CLI: contract, run, accept) is withheld from you by PATH and by this brief — the only factory commands on your PATH are factory-claim and the git shim. The daemon exposes plugin tools (paseoTools) to every agent today, so an orchestration surface may still be visible to you: never call it — setting contracts, running the Driver, and accepting are the Owner's, Supervisor's, and Lead's acts.",
    `Your \`paseo-factory\` / \`paseo_factory\` MCP tools: \`paseo-factory_agent_claim\` / \`agent_claim\` (submits your Claim, defaulting commit to HEAD) and \`paseo-factory_agent_escalate_blocker\` / \`agent_escalate_blocker\` (escalates an unresolvable blocker to Lead). Your factory CLI vocabulary (complete): \`factory-claim --task ${taskLabel} --sha <sha>\` — claim your Task when the Gate's done-criteria hold, then end your turn.`,
    "This instruction is additive: the repository's own AGENTS.md / CLAUDE.md, MCP servers, and skills catalog load natively alongside it.",
    "",
    skillFooter("agent"),
  ].join("\n");
}

/**
 * Renders the seat's initial bootstrap orientation prompt (`Supervisor` or `Lead`).
 */
export function renderSeatBootstrapPrompt(input: SeatBootstrapInput): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const runner = /Paseo Helper/i.test(input.nodePath) ? `ELECTRON_RUN_AS_NODE=1 ${quote(input.nodePath)}` : quote(input.nodePath);
  const factoryCmd =
    input.factoryCmd ??
    (input.pluginDir !== undefined ? `${runner} ${quote(join(input.pluginDir, "bin", "factory.mjs"))}` : "factory");
  const cmdPrefix = formatCmdPrefix(factoryCmd, input.home);

  const orientationLines =
    input.seat === "supervisor"
      ? [
          "You are this project's delegated Owner seat: the one agent the Owner converses with. Clarify intent, dispatch directives to Lead via `lead dispatch`, and relay what the factory measured in words. You never grade work yourself — the Gate, the Choke, the Watch and the Ledger are the law.",
          "",
          "Fire-and-End-Turn Law: Immediately after running `lead dispatch`, end your turn and wait for Lead to wake you via `factory supervisor report` or `needs_human`. Never run `sleep`, never poll files, never decompose tasks (`T-01..`), and never edit product source code or commit on `<project-root>`.",
        ]
      : [
          "You are this project's standing Lead: read the repository, split the Supervisor's directive into Tasks, set each Contract, invoke the Driver, inspect the evidence, accept green CONCERN-free intermediate work, and report back to the Supervisor via `supervisor report`.",
          "",
          "Seat write fence: Never write or commit product source code directly on `<project-root>`; all product source code is written by spawned working Agents inside isolated Task worktrees.",
        ];

  return [
    `# ${input.seat === "supervisor" ? "Supervisor" : "Lead"} (paseo-factory) — project ${input.project.slug}`,
    "",
    ...orientationLines,
    "",
    "- Project root (your cwd): " + input.project.root,
    "- Paseo home (the daemon this seat serves): " + input.home,
    "- Factory state (this project's ledger, reports, worktrees): " + projectStateDir(input.stateDir, input.project.slug),
    "- node: " + input.nodePath,
    `- Your model lane (lanes.json → ${input.seat}): ${input.lane}`,
    "",
    ...renderSeatCommandBlock(input.seat, cmdPrefix),
    "",
    'Your shells may start without node/git on PATH — export PATH="' + input.path + '" first.',
    "This seat's instructions are additive — the repository's own AGENTS.md / CLAUDE.md load natively; never overwrite them.",
    "",
    skillFooter(input.seat),
  ].join("\n");
}

/**
 * Renders the managed `APPEND_SYSTEM.md` content for an interactive Pi role
 * (`supervisor`, `lead`, or `agent`), delegating to `renderRoleContract`.
 */
export function renderRoleAppendSystem(role: RoleName, options?: RoleContractOptions): string {
  const title = role === "supervisor" ? "Supervisor" : role === "lead" ? "Lead" : "Working Agent";
  const effectiveOptions: RoleContractOptions =
    role === "agent"
      ? { factoryCmd: "factory", ...options }
      : { factoryCmd: "factory", home: "<home>", ...options };
  return [
    `# ${title} (paseo-factory) — immutable SLP role contract`,
    "",
    renderRoleContract(role, effectiveOptions),
    "",
  ].join("\n");
}
