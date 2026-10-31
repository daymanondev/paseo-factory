/** Shared schema fragments; transport and invocation stay in the standalone bridge. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
}
export function extendTool(tool: ToolDefinition, properties: Record<string, unknown>): ToolDefinition {
  return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, ...properties } } };
}
export const sharedTools: Record<string, ToolDefinition> = {
  supervisor_dispatch_lead: {
    name: "supervisor_dispatch_lead",
    description:
      "Dispatch an implementation directive to the Project's Lead seat via the serialized Lead mailbox. After calling this tool, end your turn immediately and wait for Lead's wave report.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The directive text for Lead." },
        workspace: { type: "string", description: "Optional Project root path (defaults to current project root)." },
      },
      required: ["message"],
    },
  },
  supervisor_accept_task: {
    name: "supervisor_accept_task",
    description: "Accept a green Attempt of a Task on the Owner's behalf (`by: supervisor`).",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task ID to accept." },
        attempt: { type: "number", description: "1-indexed Attempt number to accept." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task", "attempt"],
    },
  },
  lead_set_contract: {
    name: "lead_set_contract",
    description:
      "Register a Task's immutable Contract (`gate`, optional `description`, `artifact`, `skills`, `watch`) before spawning its working Agent.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Unique Task ID (letters, digits, '.', '_', '-')." },
        gate: { type: "string", description: "Gate command to verify the Task's outcome and regression invariants." },
        artifact: { type: "string", description: "Optional workspace-relative deliverable file path that must exist and be non-empty when specified." },
        scope: { type: "array", items: { type: "string" }, description: "Workspace-relative allowed paths." },
        base: { type: "string", description: "Optional base commit SHA." },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of SKILL.md names the working Agent must open first.",
        },
        watch: { type: "boolean", description: "Enable the post-verdict watch pass." },
        description: { type: "string", description: "Task assignment description stating desired outcome and regression invariants." },
        workspace: { type: "string", description: "Optional Project root path (defaults to current project root)." },
      },
      required: ["task", "gate"],
    },
  },
  lead_spawn_agent: {
    name: "lead_spawn_agent",
    description:
      "Allocate isolated Task worktrees (`<projectStateDir>/worktrees/<task>` on branch `factory/<task>`) and dispatch working Agent(s) for the contracted Task(s). After calling this tool, end your turn immediately and wait for the completion report.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Task IDs to spawn working Agents for.",
        },
        provider: {
          type: "string",
          description: "Optional `<provider>/<model>[:<thinking>]` override (defaults to `lanes.worker`).",
        },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["tasks"],
    },
  },
  lead_accept_task: {
    name: "lead_accept_task",
    description:
      "Accept a green Attempt after Lead diff inspection (`by: lead`) and land its Task worktree commit into `<project-root>`.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task ID to accept." },
        attempt: { type: "number", description: "1-indexed Attempt number to accept." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task", "attempt"],
    },
  },
  lead_repoke_agent: {
    name: "lead_repoke_agent",
    description: "Spend the Task's single automatic re-poke on a stalled working Agent.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task ID to re-poke." },
        agent: { type: "string", description: "Optional target Agent ID (resolved automatically from task when omitted)." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task"],
    },
  },
  lead_needs_human: {
    name: "lead_needs_human",
    description:
      "Record a terminal `needs_human` escalation for a Task with its corroborating ledger sequence pair.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task ID." },
        reason: {
          type: "string",
          enum: ["denied-again", "silent-after-repoke", "attempt-ceiling", "died-after-respawn"],
          description: "Escalation reason.",
        },
        evidenceSeqs: {
          type: "array",
          items: { type: "number" },
          description: "Optional two ledger event sequence numbers corroborating `reason` (auto-resolved from ledger when omitted).",
        },
        summary: { type: "string", description: "Human-readable escalation summary." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task", "reason", "summary"],
    },
  },
  lead_report_to_supervisor: {
    name: "lead_report_to_supervisor",
    description:
      "Send a wave completion or escalation report to the Project's Supervisor mailbox (`to: supervisor`, `from: lead`, `kind: report`). After calling this tool, end your turn immediately.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Report message for Supervisor." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["message"],
    },
  },
  agent_claim: {
    name: "agent_claim",
    description:
      "Submit a Claim for your bound Task in the Task worktree. Runs the Contract's Gate and returns the Verdict (`GREEN` or `RED`) and report.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Optional Task ID (defaults to your bound correlation Task)." },
        commit: { type: "string", description: "Optional git commit SHA (defaults to `git rev-parse HEAD` in the Task worktree)." },
      },
    },
  },
  agent_escalate_blocker: {
    name: "agent_escalate_blocker",
    description:
      "Escalate an unresolvable blocker (e.g., an edit required outside `--scope` or contradictory Contract criteria) to the Project's Lead mailbox.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Detailed blocker explanation for Lead." },
      },
      required: ["message"],
    },
  },
  factory_dispatch_supervisor: {
    name: "factory_dispatch_supervisor",
    description: "Route an Owner directive into a Project's Supervisor mailbox (`to: supervisor`).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Project repository root path." },
        message: { type: "string", description: "Directive message for Supervisor." },
      },
      required: ["workspace", "message"],
    },
  },
  factory_status: {
    name: "factory_status",
    description: "Return the Project's folded Ledger task digest (`attempts`, `verdict`, `sha`, `accepted`, `eye`, `choke`).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional Project root path filter." },
      },
    },
  },
};


export const sharedRoles = {
  supervisor: ["supervisor_accept_task", "supervisor_dispatch_lead", "supervisor_read_ledger", "supervisor_end_cycle"],
  lead: ["lead_repoke_agent", "lead_needs_human", "lead_create_worktree", "lead_set_contract", "lead_dispatch_agent", "lead_verify", "lead_merge", "lead_remove_worktree", "lead_report_to_supervisor"],
  agent: ["agent_claim", "agent_escalate_blocker"],
  unbound: ["factory_dispatch_supervisor", "factory_status"],
};
sharedTools.supervisor_read_ledger = { ...sharedTools.factory_status, name: "supervisor_read_ledger" };
sharedTools.supervisor_end_cycle = { name: "supervisor_end_cycle", description: "Finish this Supervisor turn and await the next Owner directive or Lead report.", inputSchema: { type: "object", properties: {} } };
for (const [name, source] of Object.entries({ lead_dispatch_agent: "lead_spawn_agent", lead_merge: "lead_accept_task" })) {
  sharedTools[name] = { ...sharedTools[source], name };
}
for (const [name, description] of Object.entries({ lead_create_worktree: "Create an isolated worktree for a contracted Task.", lead_verify: "Verify a committed Task SHA through its Contract Gate.", lead_remove_worktree: "Remove a clean worktree after its Task has been accepted." })) {
  sharedTools[name] = { name, description, inputSchema: { type: "object", properties: { task: { type: "string" }, commit: { type: "string" } }, required: ["task"] } };
}
export interface Catalog { tools: Record<string, ToolDefinition>; roles: Record<string, string[]> }
