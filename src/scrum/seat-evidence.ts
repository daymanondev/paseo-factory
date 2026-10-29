import { FactoryError } from "../errors.ts";
import { projectTask } from "../task-state.ts";
import { artifactAt, designDigest, gitBytes } from "./artifacts.ts";
import type { ScrumRun } from "./run-journal.ts";
import type { ArtifactRef } from "./types.ts";
import type { ScrumOperationContext } from "./controller.ts";
/** Resolve the complete accepted UX deliverable, including browser evidence, from a named artifact. */
export function designSubmission(run: ScrumRun, payload: Record<string, unknown>, ctx: ScrumOperationContext): Record<string, unknown> {
  let refs = payload.artifactRefs as ArtifactRef[] | undefined;
  if (refs === undefined) {
    const candidates = [...run.artifacts, ...run.tasks.filter(t => t.role === "ux").flatMap(t => t.result?.artifactRefs ?? [])];
    for (const task of run.tasks.filter(task => task.role === "ux")) {
      const state = projectTask(ctx.factory.ledger.events, task.task), contract = state.contract, sha = state.currentAttempt?.gate?.sha;
      if (!state.settled || !sha || contract?.execution?.runId !== run.runId || state.epochSeq !== task.epoch) continue;
      const paths = gitBytes(ctx.root!, "ls-tree", "-r", "--name-only", sha, "--", `.scratch/${run.initiativeId}/`).toString().trim().split("\n").filter(Boolean);
      for (const path of paths.filter(path => contract.scope?.some(scope => path === scope || path.startsWith(scope + "/")))) candidates.push(artifactAt(ctx.root!, sha, path));
    }
    refs = [...new Map(candidates.map(ref => [ref.path, ref])).values()];
  }
  if (!Array.isArray(refs)) throw new FactoryError("invalid-artifact-ref", "artifactRefs must be an array");
  if (payload.designArtifact !== undefined && !refs.some(ref => ref.path === payload.designArtifact)) throw new FactoryError("design-artifact-not-accepted", String(payload.designArtifact));
  const inferredBrowser = refs.filter(ref => {
    if (!ref.path.endsWith(".json")) return false;
    try { const report = JSON.parse(gitBytes(ctx.root!, "show", `${ref.commit}:${ref.path}`).toString()); return report.network === "disabled" && Array.isArray(report.viewports) && Array.isArray(report.states); } catch { return false; }
  });
  const browserEvidence = (payload.browserEvidence ?? inferredBrowser) as ArtifactRef[];
  const evidencePaths = new Set(browserEvidence.map(ref => ref.path));
  const designRefs = refs.filter(ref => !evidencePaths.has(ref.path));
  return { ...payload, artifactRefs: designRefs, browserEvidence, revision: payload.revision ?? (run.design?.revision ?? 0) + 1, digest: payload.digest ?? designDigest(designRefs) };
}
