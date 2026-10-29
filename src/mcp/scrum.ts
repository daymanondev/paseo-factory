import { sharedTools, sharedRoles, extendTool } from "./shared.ts";
import type { Catalog, ToolDefinition } from "./shared.ts";
const runId = { type: "string", description: "Omit to resolve the active Project run." };
const specialist = { type: "string", enum: ["pm", "ux", "architect", "dev", "qa"] };
const string = { type: "string" };
const decision: ToolDefinition = {
  name: "supervisor_scrum_decision", description: "Record an explicit Owner design decision. Omitted run/revision/digest resolve from the active run. Never infer Owner approval.",
  inputSchema: { type: "object", properties: { runId, decision: { type: "string", enum: ["approved", "changes_requested", "waived"] }, rationale: { type: "string", minLength: 1 }, revision: { type: "integer" }, digest: string, decidedBy: string, actorRole: { type: "string", enum: ["supervisor"] }, designArtifact: string, findings: { type: "array", items: string } }, required: ["decision", "rationale"] },
};
const operation: ToolDefinition = {
  name: "lead_scrum_operation", description: "Orchestrate the Scrum lifecycle. Evidence operations accept exact landed path/commit/sha256 artifactRefs; readiness also accepts contradictions, unsafeAssumptions and missingCoverage. Design submission requires browserEvidence. All evidence is verified by the existing controller.",
  inputSchema: { type: "object", properties: {
    action: { type: "string", enum: ["get", "track.select", "readiness", "design.submit", "qa.audit", "fix.reserve", "bundle.promote", "run.complete", "preview"] }, runId,
    track: { type: "string", enum: ["quick", "standard", "enterprise"] }, rationale: string,
    designArtifact: string, digest: string, revision: { type: "integer" }, waiverReason: string, auditArtifact: string,
    verdict: string, findings: { type: "array", items: string }, parentTaskId: string, task: string, summary: string,
    ownedPaths: { type: "array", items: string }, bundlePath: string, subpath: string, port: { type: "integer" },
    roleResults: { type: "array", items: { type: "object", properties: { task: string, result: { type: "object", description: "status, artifactRefs, assumptions, openQuestions, conflicts" } }, required: ["task", "result"] }, description: "Landed specialist results to record through the verified controller before this operation." },
    artifactRefs: { type: "array", items: { type: "object" } }, browserEvidence: { type: "array", items: { type: "object" } },
    contradictions: { type: "array", items: string }, unsafeAssumptions: { type: "array", items: string }, missingCoverage: { type: "array", items: string },
  }, required: ["action"] },
};
export const scrumCatalog: Catalog = {
  tools: {
    ...sharedTools,
    supervisor_dispatch_lead: extendTool(sharedTools.supervisor_dispatch_lead, { runId, scrum: { type: "object", properties: { initiativeId: string, track: { type: "string", enum: ["quick", "standard", "enterprise", "small", "backend", "ui"] }, rationale: string, ownedPaths: { type: "array", items: string }, budgets: { type: "object" } }, description: "Optional admission overrides; omitted values derive from the directive." } }),
    lead_set_contract: extendTool(sharedTools.lead_set_contract, { runId, role: specialist, artifactRefs: { type: "array", items: { type: "object" } } }),
    lead_spawn_agent: extendTool(sharedTools.lead_spawn_agent, { runId, role: specialist }),
    lead_dispatch_agent: extendTool(sharedTools.lead_dispatch_agent, { runId, role: specialist }),
    lead_report_to_supervisor: extendTool(sharedTools.lead_report_to_supervisor, { runId, reportType: { type: "string", enum: ["ui-review", "completed"] }, scrum: { type: "object" } }),
    supervisor_scrum_decision: decision, lead_scrum_operation: operation,
  },
  roles: { ...sharedRoles, supervisor: [...sharedRoles.supervisor, decision.name], lead: [...sharedRoles.lead, operation.name] },
};
