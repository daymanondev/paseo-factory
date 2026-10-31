import { assertOwnerDependencies } from "./owner-work.ts";
import { provisionImpeccable } from "./impeccable.ts";
import { readProjectRegistration } from "../project.ts";
import { assertDevReady } from "./approval.ts";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { FactoryError } from "../errors.ts";
import { provisionPiAgentHome } from "../pi-home.ts";
import { readExecution, readScrumConfig, scopeDir } from "./config.ts";
import { readLedgerEvents } from "../ledger-read.ts";
import { readRun, listRuns, terminalRun } from "./run-journal.ts";
import { SCRUM_ROLE_SKILLS, renderScrumPrompt } from "./prompts.ts";
import type { ScrumTaskBinding } from "./types.ts";
export type ScrumHarnessIdentity =
  | {
      kind: "seat";
      selectionRevision: number;
      config: import("./config.ts").ScrumConfig;
    }
  | { kind: "task"; binding: ScrumTaskBinding; task: string; epoch: number };
export function resolveScrumIdentity(
  state: string,
  slug: string,
  task?: string,
): ScrumHarnessIdentity | undefined {
  if (task !== undefined) {
    const scoped = readLedgerEvents(
      join(scopeDir(state, slug), "ledger.jsonl"),
    );
    const ledger =
      "missing" in scoped
        ? readLedgerEvents(join(state, "ledger.jsonl"))
        : scoped;
    if ("corrupt" in ledger && ledger.corrupt)
      throw new FactoryError("task-ledger-unreadable", ledger.corrupt);
    if ("failed" in ledger)
      throw new FactoryError("task-ledger-unreadable", String(ledger.failed));
    if (!("events" in ledger) || ledger.events === undefined) return undefined;
    const contract = ledger.events.findLast(
      (e) => e.event === "contract_set" && e.task === task,
    );
    if (contract?.event !== "contract_set" || contract.execution === undefined)
      return undefined;
    // Never use Project selection to reinterpret legacy Tasks.
    readRun(state, slug, contract.execution.runId);
    return {
      kind: "task",
      binding: contract.execution,
      task,
      epoch: contract.seq,
    };
  }
  const selected = readExecution(state, slug);
  if (selected.mode === "slp") return undefined;
  const config =
    listRuns(state, slug).find((r) => !terminalRun(r))?.config ??
    readScrumConfig(state, slug);
  if (!config) throw new FactoryError("scrum-config-missing", slug);
  return { kind: "seat", selectionRevision: selected.revision, config };
}
export function scrumIdentityLane(
  state: string,
  slug: string,
  authority: "supervisor" | "lead" | "agent",
  identity: ScrumHarnessIdentity,
): string {
  if (identity.kind === "task") {
    const run = readRun(state, slug, identity.binding.runId);
    const recorded = run.tasks.find(
      (t) => t.task === identity.task && t.epoch === identity.epoch,
    )?.provider;
    return recorded ?? run.config.lanes[identity.binding.role];
  }
  const config = identity.config;
  if (authority === "agent")
    throw new FactoryError(
      "task-execution-mismatch",
      "working Agent needs a bound Contract",
    );
  return config.lanes[authority];
}
export function provisionScrumHarness(input: {
  state: string;
  slug: string;
  authority: "supervisor" | "lead" | "agent";
  identity: ScrumHarnessIdentity;
  generation: string;
  userHome?: string;
  workspace?: string;
  environment?: Record<string, string | undefined>;
}): string {
  const { state, slug, identity, authority } = input;
  const root = scopeDir(state, slug);
  if (identity.kind === "task") {
    const run = readRun(state, slug, identity.binding.runId);
    if (
      run.policyRevision !== identity.binding.policyRevision ||
      run.configRevision !== identity.binding.configRevision
    )
      throw new FactoryError(
        "task-execution-mismatch",
        "frozen run identity differs",
      );
    assertOwnerDependencies(run, { task: identity.task, role: identity.binding.role });
    if (identity.binding.role === "dev") {
      const project = readProjectRegistration(state, slug);
      if (!project) throw new FactoryError("unknown-project", slug);
      assertDevReady(project.root, run, identity.task);
    }
  }
  const role =
    identity.kind === "task"
      ? identity.binding.role
      : (authority as "supervisor" | "lead");
  const roleHome =
    identity.kind === "task"
      ? join(
          root,
          "scrum/harness/runs",
          identity.binding.runId,
          identity.task,
          String(identity.epoch),
        )
      : join(
          root,
          "scrum/harness/seats",
          String(identity.selectionRevision),
          input.generation,
          authority,
        );
  provisionPiAgentHome({
    stateDir: state,
    role: authority,
    roleHome,
    sourceAgentDir: join(input.userHome ?? homedir(), ".pi/agent"),
    appendSystemPrompt: renderScrumPrompt(role, {
      project: slug,
      workspace: input.workspace ?? (identity.kind === "task" ? join(scopeDir(state, slug), "worktrees", identity.task) : readProjectRegistration(state, slug)?.root),
      ...(identity.kind === "task"
        ? {
            run: readRun(state, slug, identity.binding.runId),
            task: identity.task,
            runId: identity.binding.runId,
            epoch: identity.epoch,
          }
        : {}),
    }),
  });
  const settingsPath = join(roleHome, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const skills = identity.kind === 'task' ? SCRUM_ROLE_SKILLS[identity.binding.role] : authority === 'supervisor' ? ['grilling', 'domain-modeling'] : ['codebase-design', 'domain-modeling', 'tdd'];
  const ui = identity.kind === 'task' && ['ux', 'dev', 'qa'].includes(identity.binding.role);
  if (!ui) rmSync(join(roleHome, 'skills'), { recursive: true, force: true });
  const impeccableSkills = ui ? provisionImpeccable(roleHome, input.userHome ?? homedir(), input.environment?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(input.userHome ?? homedir(), '.codex')) : [];
  settings.skills = ['!*', ...skills.filter(s => s !== 'impeccable').map(s => `+${join(input.userHome ?? homedir(), '.agents/skills', s)}`), ...impeccableSkills.map(s => `+${join(roleHome, 'skills', s)}`)];
  if (ui) settings.extensions.push(join(roleHome, 'impeccable-hook.mjs'));
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  if (identity.kind === "task") {
    // Planning roles get research helpers, UX/Dev/QA may additionally use vision.
    if (["pm", "architect"].includes(identity.binding.role)) {
      const path = join(roleHome, "mcp.json"),
        mcp = JSON.parse(readFileSync(path, "utf8"));
      if (mcp.mcpServers) delete mcp.mcpServers["zai-vision"];
      writeFileSync(path, JSON.stringify(mcp, null, 2) + "\n");
    }
  }
  return roleHome;
}

/** The same authority/tool policy is applied to every supported provider's create request. */
export function scopeScrumCapabilities<
  T extends {
    provider?: string;
    mcpServers?: Record<string, unknown>;
    providerOptions?: Record<string, unknown>;
    systemPrompt?: string;
  },
>(
  config: T,
  authority: "supervisor" | "lead" | "agent",
  identity: ScrumHarnessIdentity,
  roleHome?: string,
): T {
  const helpers =
    identity.kind === "task" &&
    ["ux", "dev", "qa"].includes(identity.binding.role)
      ? /context7|exa|search|research|vision|chrome|playwright|browser/i
      : /context7|exa|search|research|notion/i;
  const mcpServers = Object.fromEntries(
    Object.entries(config.mcpServers ?? {}).filter(
      ([name]) =>
        name === "paseo_factory" ||
        name === "paseo-factory" ||
        (authority === "agent" && helpers.test(name)),
    ),
  );
  const skills =
    identity.kind === "task"
      ? SCRUM_ROLE_SKILLS[identity.binding.role]
      : authority === "supervisor"
        ? ["grilling", "domain-modeling"]
        : ["codebase-design", "domain-modeling", "tdd"];
  const options = config.providerOptions ?? {},
    permission =
      typeof options.permission === "object" && options.permission !== null
        ? options.permission
        : {};
  return {
    ...config,
    ...(config.mcpServers === undefined ? {} : { mcpServers }),
    ...(config.provider === "opencode" ||
    config.provider?.startsWith("opencode/")
      ? {
          providerOptions: {
            ...options,
            permission: {
              ...permission,
              bash: { ...(typeof (permission as Record<string, unknown>).bash === 'object' ? (permission as { bash: Record<string, string> }).bash : { '*': typeof (permission as Record<string, unknown>).bash === 'string' ? (permission as { bash: string }).bash : 'ask' }), 'impeccable *': identity.kind === 'task' && ['ux', 'dev', 'qa'].includes(identity.binding.role) ? 'allow' : 'deny' },
              skill: {
                "*": "deny",
                ...Object.fromEntries(skills.map((skill) => [skill, "allow"])),
                ...(identity.kind === 'task' && ['ux', 'dev', 'qa'].includes(identity.binding.role) ? { 'impeccable*': 'allow' } : {}),
              },
            },
          },
        }
      : {}),
    ...(roleHome && identity.kind === 'task' && ['ux', 'dev', 'qa'].includes(identity.binding.role) && (config.provider === 'claude' || config.provider?.startsWith('claude/')) ? { providerOptions: { ...options, extraArgs: { ...(typeof options.extraArgs === 'object' ? options.extraArgs : {}), 'plugin-dir': roleHome } } } : {}),
    systemPrompt: `${config.systemPrompt ?? ""}\nRequired role skills to open first: ${skills.join(", ")}.\n`,
  };
}
