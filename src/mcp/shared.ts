import { DEFAULT_CONTRACT_TIMEOUT_SECONDS, MAX_CONTRACT_TIMEOUT_SECONDS, MIN_CONTRACT_TIMEOUT_SECONDS } from "../constants.ts";

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
      "Dispatch an implementation directive to the Project's Lead seat via the serialized Lead mailbox. Pass `release` when the Owner wants to record a Release intent (optional pinned `version` X.Y.Z), or `storeRelease` when the Owner wants to record a Store release intent (`staging` | `production`, optional `platforms`, optional `resumeRunId` + `resolution` to resume a paused Hole). After calling this tool, end your turn immediately and wait for Lead's wave report.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The directive text for Lead." },
        workspace: { type: "string", description: "Optional Project root path (defaults to current project root)." },
        release: {
          type: "object",
          description: "Optional Owner release intent for `on-request` / `auto` Release modes.",
          properties: {
            version: { type: "string", description: "Optional exact target semver X.Y.Z; omit when Owner did not pin a version." },
          },
        },
        storeRelease: {
          type: "object",
          description:
            "Optional Owner Store release intent (`staging` or `production`, optional `platforms`, optional `resumeRunId` + `resolution` to resume a paused Hole).",
          properties: {
            target: {
              type: "string",
              enum: ["staging", "production"],
              description: "Intended Store release target (defaults to `staging`).",
            },
            platforms: {
              type: "array",
              items: { type: "string", enum: ["android", "ios"] },
              description: "Optional platform filter (`android` and/or `ios`).",
            },
            resumeRunId: { type: "string", description: "Optional paused release-lab run ID to resume." },
            resolution: { description: "Optional Hole resolution payload for `resumeRunId`." },
          },
        },
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
        acknowledgeWatch: {
          type: "string",
          description:
            "Optional Watch soft-block acknowledgement reason (>= 10 non-whitespace chars) required when Watch flagged `test-weakened >= 0.5` or `secret-leak >= 0.5` (ADR 0074).",
        },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task", "attempt"],
    },
  },
  lead_set_contract: {
    name: "lead_set_contract",
    description:
      "Register a Task's provisional Contract (`gate`, optional `description` or structured 4-Part Brief fields, `reopenConditions`, `artifact`, `skills`, `watch`, `disposition`, `timeoutSeconds`) before spawning its working Agent. Re-contracting an unaccepted Task updates the Brief/Gate in place and preserves the live Peer unless `resetPeer: true`. The Brief must carry all four canonical sections (1. Bounded Outcome, 2. Contract Boundary & Regression Invariants, 3. Excluded / Deferred, 4. Verification) — via `description` or the structured fields.",
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
        reopenConditions: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of concrete premise/scope conditions under which the Peer should challenge or reopen this Contract via `agent_ask` (rendered prominently as `Reopen if:` in the Peer brief; max 8 items, <= 240 chars each).",
        },
        disposition: { type: "string", enum: ["engineer", "architect", "reviewer", "scout"], description: "The Peer's SLP disposition (ADR 0053; defaults to engineer when omitted)." },
        timeoutSeconds: {
          type: "integer",
          minimum: MIN_CONTRACT_TIMEOUT_SECONDS,
          maximum: MAX_CONTRACT_TIMEOUT_SECONDS,
          description: `Optional Gate timeout in seconds (integer ${MIN_CONTRACT_TIMEOUT_SECONDS}..${MAX_CONTRACT_TIMEOUT_SECONDS}, defaults to ${DEFAULT_CONTRACT_TIMEOUT_SECONDS}s). Starts when the Gate begins executing.`,
        },
        resetPeer: { type: "boolean", description: "Cancel and archive the live bound Peer before the fresh Contract epoch (default false — the Peer keeps its accumulated context)." },
        workspace: { type: "string", description: "Optional Project root path (defaults to current project root)." },
      },
      required: ["task"],
    },
  },
  lead_spawn_agent: {
    name: "lead_spawn_agent",
    description:
      "Allocate isolated Task worktrees (`<projectStateDir>/worktrees/<task>` on branch `factory/<task>`) and dispatch working Agent(s) for the contracted Task(s). Enforces at most one active writable `engineer` Peer per Project at a time (read-only `scout` | `architect` | `reviewer` Peers may run concurrently). After calling this tool, end your turn immediately and wait for the completion report.",
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
        acknowledgeWatch: {
          type: "string",
          description:
            "Optional Watch soft-block acknowledgement reason (>= 10 non-whitespace chars) required when Watch flagged `test-weakened >= 0.5` or `secret-leak >= 0.5` (ADR 0074).",
        },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task", "attempt"],
    },
  },
  lead_reply_peer: {
    name: "lead_reply_peer",
    description:
      "Deliver a Lead ruling directly into the live Peer session (answer, reconciled boundary decision, or re-contract follow-up) prefixed with the task/disposition context and the refreshed Active Contract Snapshot. Message-bearing reconciliation turns are never capped by the one-per-task Denial-stall limit.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task ID to reply to." },
        message: {
          type: "string",
          description:
            "Non-empty Lead ruling text (answer, reconciled boundary decision) delivered verbatim into the live Peer session, prefixed with the task/disposition context and the updated Brief.",
        },
        agent: { type: "string", description: "Optional target Agent ID (resolved automatically from task when omitted)." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task", "message"],
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
  lead_release: {
    name: "lead_release",
    description:
      "Publish a Gate-verified Release for the Project at `version` (`vX.Y.Z`): creates an annotated tag on HEAD, fast-forward pushes the configured Release branch to `origin`, pushes the tag, and creates the GitHub Release (within the Owner's Release mode).",
    inputSchema: {
      type: "object",
      properties: {
        version: { type: "string", description: "Semver version to release (e.g. \"0.14.0\")." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["version"],
    },
  },
  lead_store_release: {
    name: "lead_store_release",
    description:
      "Run the deterministic factory-release-lab store runner server-side (`probe`, `stage`, `submit`, or `resume` a paused Hole). `probe` returns synchronous Vault/platform/store readiness JSON; `stage`, `submit`, and `resume` execute asynchronously at zero seat tokens and wake Lead via mailbox on completion, Hole pause, or failure. Never run release-lab inside a seat shell.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["probe", "stage", "submit", "resume"],
          description: "Store release action to execute.",
        },
        platforms: {
          type: "array",
          items: { type: "string", enum: ["android", "ios"] },
          description: "Optional platform filter (`android` and/or `ios`).",
        },
        runId: {
          type: "string",
          description: "Existing release-lab run ID (required for `resume`, optional for `submit`).",
        },
        resolution: {
          description: "Optional Hole resolution payload for `resume`.",
        },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["action"],
    },
  },
  supervisor_record_store_note: {
    name: "supervisor_record_store_note",
    description:
      "Record a cross-project rejection lesson (`target: \"lessons\"`, capped at <= 120 lines) or a per-app Store notebook card (`target: \"app\"`) into `<paseoHome>/vault-runtime/store-memory/` (`0o400`) and sync to Private vault without touching `<project-root>`.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["lessons", "app"],
          description: "Which Store notebook tier to update: `lessons` (`lessons.md`, <= 120 lines) or `app` (`apps/<appKey>.md`).",
        },
        content: {
          type: "string",
          description: "Full Markdown content to write into the target Store notebook file.",
        },
        appKey: {
          type: "string",
          description: "Optional canonical app key for `target: \"app\"` (resolved from Project manifest/slug when omitted).",
        },
        workspace: { type: "string", description: "Optional Project root path." },
        sync: {
          type: "boolean",
          description: "Whether to push to Private vault when configured (defaults to true).",
        },
      },
      required: ["target", "content"],
    },
  },
  supervisor_inspect_factory: {
    name: "supervisor_inspect_factory",
    description:
      "Inspect secret-free, context-bounded Factory readiness for the Project (isMobile, detectedPlatforms, hasOrigin, hasStoreManifest, companions, release, storeRelease, skillPacks, helperMcps, openDesign, boolean vault, ghAuth, and pending Setup Proposal summary). Context-triggered only — never call on clear Turn-1 implementation directives.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional Project root path (defaults to current project root)." },
      },
    },
  },
  supervisor_setup_factory: {
    name: "supervisor_setup_factory",
    description:
      "Validate, canonically order, and execute or propose Factory setup actions (Tier 1 local plumbing applied directly: vault_hydrate, factory-skills-pack, set_skill_pack, sync_open_design; Tier 2 external/daemon/machine-wide changes bundled into one atomic Setup Proposal for Owner approval in Needs you: factory-release-lab, set_release_mode, set_store_release_mode, set_helper_mcp).",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "1..16 Factory setup actions. Each item is a flat object with `kind` and the fields required for that kind.",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: [
                  "install_companion",
                  "set_release_mode",
                  "set_store_release_mode",
                  "set_skill_pack",
                  "set_helper_mcp",
                  "sync_open_design",
                  "vault_hydrate",
                ],
                description: "Setup action kind.",
              },
              id: {
                type: "string",
                enum: ["factory-release-lab", "factory-skills-pack"],
                description: "Companion ID for `install_companion` (`factory-skills-pack` is Tier 1; `factory-release-lab` is Tier 2).",
              },
              mode: {
                type: "string",
                description: "Mode for `set_release_mode` (`off` | `on-request` | `auto`) or `set_store_release_mode` (`off` | `on-request` | `auto-staging`).",
              },
              branch: {
                type: "string",
                description: "Optional safe git branch ref for `set_release_mode`.",
              },
              pack: {
                type: "string",
                description: "Skill pack ID for `set_skill_pack`.",
              },
              enabled: {
                type: "boolean",
                description: "Enable/disable flag for `set_skill_pack` or `set_helper_mcp`.",
              },
              name: {
                type: "string",
                description: "Helper MCP name for `set_helper_mcp` (machine-wide, Tier 2).",
              },
              projectId: {
                type: "string",
                description: "Open Design project ID for `sync_open_design`.",
              },
            },
            required: ["kind"],
          },
        },
        reason: {
          type: "string",
          description: "Single-paragraph reason (<= 500 chars) shown to the Owner on Setup Proposals and recorded in setup-audit.jsonl.",
        },
        workspace: { type: "string", description: "Optional Project root path (defaults to current project root)." },
      },
      required: ["actions", "reason"],
    },
  },
  agent_claim: {
    name: "agent_claim",
    description:
      "Submit a Claim for your bound Task in the Task worktree with the mandatory 6-Field Handoff (`outcome`, `scope`, `verification`, `unknowns`, optional `ownership`). For `outcome: \"complete\"`, validates clean tree, commit SHA, and handoff synchronously, queues automated Gate verification asynchronously (returning `queued` immediately so you end your turn and wait), or returns immediate synthetic `GREEN` for read-only empty gates. For `reopen`, `blocked`, or `partial`, delivers your handback directly without running the Gate or burning an Attempt.",
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
  agent_ask: {
    name: "agent_ask",
    description:
      "Challenge a Brief premise, Gate mismatch, missing dependency, behavior-changing ambiguity, or external blocker. CONTRA selectivity: use ONLY when repository code or spec contradicts the Brief or Gate, an unowned prerequisite is missing, or an ambiguity changes observable code behavior — never for routine implementation details you can decide independently. Keeps your session alive and paused for a ruling without burning an Attempt.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["reopen_premise", "gate_mismatch", "dependency", "clarify", "blocked"],
          description: "Challenge or question category.",
        },
        layer: {
          type: "string",
          enum: ["foundation", "dependency", "lifecycle", "API", "ownership", "verification"],
          description: "Reopened contract layer — required when `kind` is `reopen_premise`.",
        },
        summary: {
          type: "string",
          description: "Concise statement of the contradiction, mismatch, missing dependency, or blocker.",
        },
        evidence: {
          type: "string",
          description: "Concrete repository evidence (`file:line`, failing command/output, or spec quote).",
        },
        proposal: {
          type: "string",
          description: "Optional suggested direction or narrowed Contract option.",
        },
      },
      required: ["kind", "summary", "evidence"],
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
    description: "Return the Project's folded Ledger task digest. By default for seats (`lead_read_ledger` / `supervisor_read_ledger`), settled (`accepted` / `closed`) Tasks collapse into one summary line and only active unaccepted Tasks expand (`LEAN_HISTORY`); pass `full: true` to return every historical row.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional Project root path filter." },
        full: { type: "boolean", description: "When true, return every historical Task row instead of collapsing settled Tasks." },
      },
    },
  },
};


export const sharedRoles = {
  supervisor: ["supervisor_accept_task", "supervisor_dispatch_lead", "supervisor_read_ledger", "supervisor_record_store_note", "supervisor_inspect_factory", "supervisor_setup_factory", "supervisor_end_cycle"],
  lead: ["lead_reply_peer", "lead_needs_human", "lead_set_contract", "lead_dispatch_agent", "lead_verify", "lead_merge", "lead_release", "lead_store_release", "lead_record_store_note", "lead_report_to_supervisor", "lead_close_task", "lead_update_notebook", "lead_read_ledger"],
  agent: ["agent_claim", "agent_ask"],
  unbound: ["factory_dispatch_supervisor", "factory_status"],
};

export const LEGACY_ROLE_TOOL_ALIASES: Record<string, readonly string[]> = {
  supervisor: ["lead_close_task", "lead_retire_task"],
  lead: ["lead_repoke_agent", "lead_retire_task", "lead_create_worktree", "lead_remove_worktree"],
  agent: ["agent_escalate_blocker"],
};
sharedTools.supervisor_read_ledger = { ...sharedTools.factory_status, name: "supervisor_read_ledger" };
sharedTools.lead_read_ledger = { ...sharedTools.factory_status, name: "lead_read_ledger" };
sharedTools.lead_record_store_note = { ...sharedTools.supervisor_record_store_note, name: "lead_record_store_note" };
sharedTools.supervisor_end_cycle = { name: "supervisor_end_cycle", description: "Finish this Supervisor turn and await the next Owner directive or Lead report.", inputSchema: { type: "object", properties: {} } };
for (const [name, source] of Object.entries({ lead_dispatch_agent: "lead_spawn_agent", lead_merge: "lead_accept_task", lead_retire_task: "lead_close_task" })) {
  sharedTools[name] = { ...sharedTools[source], name };
}
for (const [name, description] of Object.entries({ lead_create_worktree: "Create an isolated worktree for a contracted Task. Refuses a retired Task (`already-closed`) — the close removed the worktree and its factory/<task> branch, and the retirement is terminal (ADR 0054 §5).", lead_verify: "Verify a committed Task SHA through its Contract Gate.", lead_remove_worktree: "Remove a clean worktree after its Task has been accepted." })) {
  sharedTools[name] = { name, description, inputSchema: { type: "object", properties: { task: { type: "string" }, commit: { type: "string" } }, required: ["task"] } };
}
for (const tool of Object.values(sharedTools)) {
  tool._meta ??= { timeoutMs: MCP_TOOL_TIMEOUT_MS };
}
export interface Catalog { tools: Record<string, ToolDefinition>; roles: Record<string, string[]> }
