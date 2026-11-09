/** Shared schema fragments; transport and invocation stay in the standalone bridge. */
export const MCP_TOOL_TIMEOUT_MS = 600_000;
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
  _meta?: { timeoutMs?: number };
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
      "Register a Task's immutable Contract (`gate`, optional `description` or structured 4-Part Brief fields, `artifact`, `skills`, `watch`, `disposition`) before spawning its working Agent. Re-contracting an unaccepted Task updates the Brief/Gate in place and preserves the live Peer unless `resetPeer: true`. The Brief must carry all four canonical sections (1. Bounded Outcome, 2. Contract Boundary & Regression Invariants, 3. Excluded / Deferred, 4. Verification) — via `description` or the structured fields.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Unique Task ID (letters, digits, '.', '_', '-')." },
        gate: { type: "string", description: "Gate command to verify the Task's outcome and regression invariants. Mandatory for the engineer disposition; optional (defaults to empty) for scout | architect | reviewer (ADR 0054)." },
        artifact: { type: "string", description: "Optional workspace-relative deliverable file path that must exist and be non-empty when specified. Refused on read-only dispositions." },
        scope: { type: "array", items: { type: "string" }, description: "Workspace-relative allowed paths. Normalized to empty on read-only dispositions." },
        base: { type: "string", description: "Optional base commit SHA." },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of SKILL.md names the working Agent must open first.",
        },
        watch: { type: "boolean", description: "Enable the post-verdict watch pass." },
        description: { type: "string", description: "Task assignment Brief stating desired outcome and regression invariants — must carry all four canonical sections (ADR 0054)." },
        outcome: { type: "string", description: "Structured 4-Part Brief, section 1 (Bounded Outcome) — synthesized into Contract.description when `description` is omitted (ADR 0054)." },
        invariants: { type: "string", description: "Structured 4-Part Brief, section 2 (Contract Boundary & Regression Invariants) — synthesized into Contract.description when `description` is omitted (ADR 0054)." },
        exclusions: { type: "string", description: "Structured 4-Part Brief, section 3 (Excluded / Deferred) — synthesized into Contract.description when `description` is omitted (ADR 0054)." },
        verification: { type: "string", description: "Structured 4-Part Brief, section 4 (Verification) — synthesized into Contract.description when `description` is omitted; defaults on a gate-less read-only disposition to the clean-worktree handoff law (ADR 0054)." },
        disposition: { type: "string", enum: ["engineer", "architect", "reviewer", "scout"], description: "The Peer's SLP disposition (ADR 0053; defaults to engineer when omitted)." },
        resetPeer: { type: "boolean", description: "Cancel and archive the live bound Peer before the fresh Contract epoch (default false — the Peer keeps its accumulated context)." },
        workspace: { type: "string", description: "Optional Project root path (defaults to current project root)." },
      },
      required: ["task"],
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
        thinking: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          description:
            "Optional per-dispatch reasoning effort tier (v0.5.0, ADR 0054 §4) — resolved provider-adaptively against the worker lane's model catalog; fixed-effort models ignore it.",
        },
        thinkingReason: {
          type: "string",
          description: "One sentence explaining why this Task warrants the requested effort tier — required when `thinking` is supplied.",
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
    description:
      "Spend the Task's single automatic re-poke on a stalled working Agent — or, with `message`, deliver a Lead ruling directly into the live Peer session (ADR 0053: message-bearing reconciliation turns are never capped by the one-per-task law).",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task ID to re-poke." },
        agent: { type: "string", description: "Optional target Agent ID (resolved automatically from task when omitted)." },
        message: {
          type: "string",
          description:
            "Optional Lead ruling text (answer, reconciled boundary decision) delivered verbatim into the live Peer session, prefixed with the task/disposition context and the updated Brief; omitted sends the fixed Denial-stall continuation.",
        },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task"],
    },
  },
  lead_update_notebook: {
    name: "lead_update_notebook",
    description:
      "Replace the Project notebook (`<projectStateDir>/notebook.md`) with `content` through the plugin's single writer — never write `.scratch/notebook.md` inside <project-root> (ADR 0052 §1). Requires both headings (`## 1. Verification & Run Recipe`, `## 2. Recurrence Guard`), `<= 80` lines, `<= 4,096` UTF-8 bytes, and `<= 12` active Recurrence Guard rows; over-limit or malformed content is refused with `notebook-limit-exceeded` / `notebook-schema-invalid` naming the exact counts — fold/graduate rows, the writer never truncates.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The full notebook text — both required headings, within the line/byte/row caps.",
        },
        workspace: { type: "string", description: "Optional Project root path (defaults to current project root)." },
      },
      required: ["content"],
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
  lead_close_task: {
    name: "lead_close_task",
    description:
      "Retire a superseded or split Task cleanly (ADR 0054 §5): appends `task_closed`, cancels and archives the bound live Peer, and removes the Task worktree and `factory/<task>` branch. Refuses unknown, already-accepted, already-closed, or mid-gate Tasks. Never for work that should land — accept that instead.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task ID to close." },
        reason: { type: "string", description: "Why the Task is retired — one sentence; the ledger keeps it." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task", "reason"],
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
      "Submit a Claim for your bound Task in the Task worktree with the mandatory 6-Field Handoff (`outcome`, `scope`, `verification`, `unknowns`, optional `ownership`). Runs the Contract's Gate and returns the Verdict (`GREEN` or `RED`) and report.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Optional Task ID (defaults to your bound correlation Task)." },
        commit: { type: "string", description: "Git commit SHA the Claim attests — mandatory for engineer-disposition Tasks; for the read-only dispositions (scout | architect | reviewer) it is optional and defaults to `git rev-parse HEAD` in the Task worktree at admission." },
        outcome: { type: "string", enum: ["complete", "partial", "blocked", "reopen"], description: "6-Field Handoff: where the work stands (ADR 0053)." },
        scope: { type: "string", description: "6-Field Handoff: files changed or read, with paths." },
        verification: { type: "string", description: "6-Field Handoff: commands run, real output summary, and what was deliberately skipped." },
        unknowns: { type: "string", description: "6-Field Handoff: assumptions stood on, open risks, or \"none\"." },
        ownership: { type: "string", description: "6-Field Handoff: optional ownership note (defaults to \"lease returned\")." },
      },
      required: ["outcome", "scope", "verification", "unknowns"],
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
  supervisor: ["supervisor_accept_task", "supervisor_dispatch_lead", "supervisor_read_ledger", "supervisor_end_cycle", "lead_close_task", "lead_retire_task"],
  lead: ["lead_repoke_agent", "lead_needs_human", "lead_create_worktree", "lead_set_contract", "lead_dispatch_agent", "lead_verify", "lead_merge", "lead_remove_worktree", "lead_report_to_supervisor", "lead_close_task", "lead_retire_task", "lead_update_notebook"],
  agent: ["agent_claim", "agent_escalate_blocker"],
  unbound: ["factory_dispatch_supervisor", "factory_status"],
};
sharedTools.supervisor_read_ledger = { ...sharedTools.factory_status, name: "supervisor_read_ledger" };
sharedTools.supervisor_end_cycle = { name: "supervisor_end_cycle", description: "Finish this Supervisor turn and await the next Owner directive or Lead report.", inputSchema: { type: "object", properties: {} } };
for (const [name, source] of Object.entries({ lead_dispatch_agent: "lead_spawn_agent", lead_merge: "lead_accept_task", lead_retire_task: "lead_close_task" })) {
  sharedTools[name] = { ...sharedTools[source], name };
}
for (const [name, description] of Object.entries({ lead_create_worktree: "Create an isolated worktree for a contracted Task.", lead_verify: "Verify a committed Task SHA through its Contract Gate.", lead_remove_worktree: "Remove a clean worktree after its Task has been accepted." })) {
  sharedTools[name] = { name, description, inputSchema: { type: "object", properties: { task: { type: "string" }, commit: { type: "string" } }, required: ["task"] } };
}
for (const tool of Object.values(sharedTools)) {
  tool._meta ??= { timeoutMs: MCP_TOOL_TIMEOUT_MS };
}
export interface Catalog { tools: Record<string, ToolDefinition>; roles: Record<string, string[]> }
