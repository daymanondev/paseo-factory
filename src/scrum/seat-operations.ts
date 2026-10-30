import { registerOwnedPaths } from "./ownership.ts";
import { designSubmission } from "./seat-evidence.ts";
/** MCP lifecycle admission; all evidence mutations return through the verified controller. */
import { FactoryError } from "../errors.ts";
import { artifactAt, designDigest, gitBytes, sha256 } from "./artifacts.ts";
import { listRuns, readRun, terminalRun, commandRun } from "./run-journal.ts";
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
  const original = input.payload ?? {};
  if (!supervisor && !["get", "track.select", "readiness", "design.submit", "qa.audit", "fix.reserve", "bundle.promote", "run.complete", "preview"].includes(String(original.action))) throw new FactoryError("invalid-scrum-operation", String(original.action));
  if (["get", "preview", "track.select"].includes(String(original.action)) && original.roleResults !== undefined) throw new FactoryError("invalid-role-results", "record results through readiness or QA");
  const fingerprint = sha256(JSON.stringify({ operation: input.operation, payload: original, runId: input.runId, actor: ctx.actor, authority: ctx.authority }));
  const bound = listRuns(ctx.factory.stateDir, ctx.slug).find(run => run.operationIntents?.some(intent => intent.operationId === input.requestId));
  let run = bound ?? resolveActiveRun(ctx.factory.stateDir, ctx.slug, input.runId);
  const prior = run.operationIntents?.find(intent => intent.operationId === input.requestId);
  if (prior && prior.fingerprint !== fingerprint) throw new FactoryError("run-request-conflict", input.requestId);
  let p: Record<string, unknown> = prior?.payload ?? { ...original };
  // Freeze defaults before the first mutation. A crash/retry must neither create
  // a second design revision nor lose the run after completion makes it terminal.
  if (!prior && (supervisor || !["get", "preview"].includes(String(p.action)))) {
    if (supervisor) p = { ...p, revision: p.revision ?? run.design?.revision, digest: p.digest ?? run.design?.digest };
    if (p.action === "design.submit") p = designSubmission(run, p, ctx);
    if (p.action === "fix.reserve" && p.task === undefined && typeof p.parentTaskId === "string") p = { ...p, task: `fix-${p.parentTaskId}-${run.fixRounds + 1}` };
    if (["qa.audit", "bundle.promote"].includes(String(p.action)) && p.artifactRefs === undefined) {
      const path = p.action === "qa.audit" ? p.auditArtifact : p.bundlePath;
      if (typeof path !== "string" || !path) throw new FactoryError("scrum-artifact-required", "supply an exact landed artifact path");
      const ref = run.artifacts.find(ref => ref.path === path) ?? artifactAt(ctx.root, gitBytes(ctx.root, "rev-parse", "HEAD").toString().trim(), path);
      p = { ...p, artifactRefs: [ref] };
    }
    run = commandRun(ctx.factory.stateDir, ctx.slug, run.runId, { type: "operation_intended", operationId: input.requestId, fingerprint, payload: p, requestId: `${input.requestId}:intent`, expectedRevision: input.expectedRevision ?? run.revision });
  }
  const call = (operation: string, payload = p) => execute({ ...input, operation, runId: run.runId, expectedRevision: run.revision, payload }, ctx);
  if (supervisor) {
    if (!String(p.rationale ?? "").trim()) throw new FactoryError("invalid-design-decision", "non-empty rationale required");
    if (p.decidedBy !== undefined && (typeof p.decidedBy !== "string" || !p.decidedBy.trim())) throw new FactoryError("invalid-design-decision", "decidedBy must be non-empty");
    if (p.actorRole !== undefined && p.actorRole !== "supervisor") throw new FactoryError("scrum-seat-unauthorized", "actorRole must be supervisor");
    return call("design.decide", { ...p, explicitOwnerInstruction: true });
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
      return call("run.command", { type: "design_review_requested", design: { revision: p.revision ?? (run.design?.revision ?? 0) + 1, digest: p.digest ?? designDigest(refs), refs, browserEvidence: p.browserEvidence ?? [], ...(p.waiverReason === undefined ? {} : { waiverReason: p.waiverReason }) } });
    case "qa.audit": {
      const ref = refAt(p.auditArtifact);
      const report = JSON.parse(gitBytes(ctx.root, "show", `${ref.commit}:${ref.path}`).toString());
      if (p.verdict !== undefined && p.verdict !== report.status) throw new FactoryError("qa-verdict-conflict", "verdict must match the authoritative audit artifact");
      if (p.findings !== undefined && (!Array.isArray(p.findings) || p.findings.some(id => !report.findings?.some((finding: { id: string }) => finding.id === id)))) throw new FactoryError("qa-findings-conflict", "findings must name IDs from the authoritative audit");
      return call("run.command", { type: "qa_recorded", ref });
    }
    case "fix.reserve":
      if (p.ownedPaths !== undefined) run = registerOwnedPaths(ctx.factory.stateDir, ctx.slug, run, p.ownedPaths as string[], `${input.requestId}:paths`);
      return call("run.command", { type: "fix_reserved", task: p.task, ...(p.parentTaskId === undefined ? {} : { parentTaskId: p.parentTaskId }), ...(p.summary === undefined ? {} : { summary: p.summary }), ...(p.ownedPaths === undefined ? {} : { ownedPaths: p.ownedPaths }) });
    case "bundle.promote": return call("run.command", { type: "bundle_promoted", ref: refAt(p.bundlePath) });
    case "run.complete": return call("run.complete");
    case "preview": return call("preview.url");
    default: throw new FactoryError("invalid-scrum-operation", String(p.action));
  }
}
