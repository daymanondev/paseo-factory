/** MCP lifecycle admission; all evidence mutations return through the verified controller. */
import { FactoryError } from "../errors.ts";
import { artifactAt, designDigest, gitBytes } from "./artifacts.ts";
import { listRuns, readRun, terminalRun } from "./run-journal.ts";
import type { ScrumRun } from "./run-journal.ts";
import type { ArtifactRef } from "./types.ts";
import type { ScrumOperation, ScrumOperationContext } from "./controller.ts";
export function resolveActiveRun(state: string, slug: string, runId?: string): ScrumRun {
  if (runId) return readRun(state, slug, runId);
  const active = listRuns(state, slug).filter(run => !terminalRun(run) && !run.cancellation);
  if (active.length !== 1) throw new FactoryError("scrum-run-required", active.length ? "multiple active runs; supply runId" : "no active Scrum run");
  return active[0];
}
export function scrumSeatOperation(input: ScrumOperation, ctx: ScrumOperationContext, execute: (input: ScrumOperation, ctx: ScrumOperationContext) => unknown): unknown {
  const supervisor = input.operation === "supervisor.decision";
  if (ctx.authority !== (supervisor ? "supervisor" : "lead"))
    throw new FactoryError("scrum-seat-unauthorized", "tool belongs to another seat");
  if (!ctx.slug || !ctx.root) throw new FactoryError("project-required", "Project scope required");
  let run = resolveActiveRun(ctx.factory.stateDir, ctx.slug, input.runId), p = input.payload ?? {};
  const call = (operation: string, payload = p) => execute({ ...input, operation, runId: run.runId, expectedRevision: input.expectedRevision ?? run.revision, payload }, ctx);
  if (supervisor) {
    if (!String(p.rationale ?? "").trim()) throw new FactoryError("invalid-design-decision", "non-empty rationale required");
    if (p.decidedBy !== undefined && (typeof p.decidedBy !== "string" || !p.decidedBy.trim())) throw new FactoryError("invalid-design-decision", "decidedBy must be non-empty");
    if (p.findings !== undefined && (!Array.isArray(p.findings) || p.findings.some(f => typeof f !== "string"))) throw new FactoryError("invalid-design-decision", "findings must be strings");
    if (p.actorRole !== undefined && p.actorRole !== "supervisor") throw new FactoryError("scrum-seat-unauthorized", "actorRole must be supervisor");
    return call("design.decide", { ...p, revision: p.revision ?? run.design?.revision, digest: p.digest ?? run.design?.digest, explicitOwnerInstruction: true });
  }
  if (Array.isArray(p.roleResults)) {
    for (const entry of p.roleResults as { task: string; result: unknown }[]) {
      execute({ operation: "run.command", runId: run.runId, requestId: `${input.requestId}:result:${entry.task}`, expectedRevision: run.revision, payload: { type: "role_result", ...entry } }, ctx);
      run = readRun(ctx.factory.stateDir, ctx.slug, run.runId);
    }
  }
  const refs = (p.artifactRefs ?? run.artifacts) as ArtifactRef[];
  const refAt = (path: unknown) => {
    if (typeof path !== "string" || !path) throw new FactoryError("scrum-artifact-required", "supply an exact landed artifact path");
    return refs.find(ref => ref.path === path) ?? artifactAt(ctx.root!, gitBytes(ctx.root!, "rev-parse", "HEAD").toString().trim(), path);
  };
  switch (p.action) {
    case "get": return run;
    case "track.select": return call("track.select");
    case "readiness":
      if (p.artifactRefs === undefined) return { run, readiness: run.readiness ?? null, blockers: run.blockers };
      return call("run.command", { type: "readiness_recorded", readiness: { refs, contradictions: p.contradictions ?? [], unsafeAssumptions: p.unsafeAssumptions ?? [], missingCoverage: p.missingCoverage ?? [], rationale: p.rationale } });
    case "design.submit":
      return call("run.command", { type: "design_review_requested", design: { revision: p.revision ?? (run.design?.revision ?? 0) + 1, digest: p.digest ?? designDigest(refs), refs, browserEvidence: p.browserEvidence ?? [] } });
    case "qa.audit": return call("run.command", { type: "qa_recorded", ref: refAt(p.auditArtifact) });
    case "fix.reserve": return call("run.command", { type: "fix_reserved", task: p.task ?? p.parentTaskId });
    case "bundle.promote": return call("run.command", { type: "bundle_promoted", ref: refAt(p.bundlePath) });
    case "run.complete": return call("run.complete");
    case "preview": return call("preview");
    default: throw new FactoryError("invalid-scrum-operation", String(p.action));
  }
}
