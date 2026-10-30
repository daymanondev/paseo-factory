import { trackKind } from "./tracks.ts";
import { designScreens, browserCoverageIssues } from "./design-contract.ts";
import type { BrowserEvidenceReport, ScrumDesignFinding, ScreenStatuses } from "./design-contract.ts";
import { safePath } from "./types.ts";
import { FactoryError } from "../errors.ts";
import { designDigest, verifyRefs, gitBytes, artifactAt } from "./artifacts.ts";
import { commandRun, readRun, terminalRun, replayRunCommand } from "./run-journal.ts";
import type { ScrumRun } from "./run-journal.ts";
export function verifyCompleteDesign(
  root: string,
  run: ScrumRun,
  design: import("./run-journal.ts").DesignReview,
): void {
  const prefix = `.scratch/${run.initiativeId}/`;
  const evidence = new Set(design.browserEvidence.map((ref) => ref.path));
  const tracked = gitBytes(
    root,
    "ls-tree",
    "-r",
    "--name-only",
    "HEAD",
    "--",
    `${prefix}mockups/`,
  )
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  const required = [
    `${prefix}DESIGN.md`,
    `${prefix}EXPERIENCE.md`,
    `${prefix}mockups/index.html`,
    ...tracked.filter(
      (path) => run.ownedPaths.includes(path) && !evidence.has(path),
    ),
  ];
  const supplied = new Set(design.refs.map((ref) => ref.path));
  const missing = required.filter((path) => !supplied.has(path));
  if (missing.length)
    throw new FactoryError(
      "incomplete-design-digest",
      `complete design digest required: ${missing.join(", ")}`,
    );
}
export function assertDevReady(root: string, run: ScrumRun): void {
  if (terminalRun(run) || run.phase === "blocked" || run.blockers.length > 0)
    throw new FactoryError("scrum-run-blocked", run.phase);
  if (Date.now() - Date.parse(run.createdAt) >= run.budgets.maxElapsedMs)
    throw new FactoryError(
      "scrum-budget-exhausted",
      "elapsed budget exhausted",
    );
  const ready = run.readiness;
  if (
    !ready ||
    ready.contradictions.length ||
    ready.unsafeAssumptions.length ||
    ready.missingCoverage.length
  )
    throw new FactoryError(
      "scrum-readiness-required",
      "resolve contradictions, assumptions and coverage before Dev",
    );
  verifyRefs(root, ready.refs, run.ownedPaths);
  if (trackKind(run.track) === "ui" || run.design !== undefined) {
    const design = run.design;
    if (
      !design ||
      !["approved", "waived"].includes(design.decision ?? "") ||
      design.digest !== designDigest(design.refs)
    )
      throw new FactoryError(
        "ui-approval-required",
        "current design approval or explicit waiver required",
      );
    verifyCompleteDesign(root, run, design);
    verifyRefs(root, design.refs, run.ownedPaths);
    verifyRefs(root, design.browserEvidence, run.ownedPaths);
    verifyBrowserEvidence(root, design);
  }
}
export function decideDesign(input: {
  state: string;
  slug: string;
  runId: string;
  root: string;
  authority: "owner" | "supervisor" | "lead" | "agent";
  actor: string;
  explicitOwnerInstruction: boolean;
  requestId: string;
  expectedRevision: number;
  revision: number;
  digest: string;
  decision: "approved" | "changes_requested" | "waived";
  rationale: string;
  decidedBy?: string;
  designArtifact?: string;
  findings?: (ScrumDesignFinding | string)[];
  screenStatuses?: ScreenStatuses;
}): ScrumRun {
  if (
    input.authority !== "owner" &&
    (input.authority !== "supervisor" || !input.explicitOwnerInstruction)
  )
    throw new FactoryError(
      "ui-decision-unauthorized",
      "Owner or explicitly instructed Supervisor required",
    );
  const command: import("./run-journal.ts").RunCommand = {
    type: "design_decided",
    requestId: input.requestId,
    expectedRevision: input.expectedRevision,
    revision: input.revision,
    digest: input.digest,
    decision: input.decision,
    actor: input.actor,
    rationale: input.rationale,
    decidedBy: input.decidedBy ?? "owner",
    actorRole: input.authority,
    ...(input.designArtifact === undefined ? {} : { designArtifact: input.designArtifact }),
    ...(input.findings === undefined ? {} : { findings: input.findings }),
    ...(input.screenStatuses === undefined ? {} : { screenStatuses: input.screenStatuses }),
  };
  const replayed = replayRunCommand(input.state, input.slug, input.runId, command);
  if (replayed) return replayed;
  const run = readRun(input.state, input.slug, input.runId);
  if (!run.design) throw new FactoryError("ui-review-missing", input.runId);
  verifyCompleteDesign(input.root, run, run.design);
  const experience = run.design.refs.find(r => r.path.endsWith('/EXPERIENCE.md'));
  const declared = experience ? designScreens(gitBytes(input.root, 'show', `${experience.commit}:${experience.path}`).toString()).map(s => s.id) : [];
  if (declared.length && [...(input.findings ?? []).flatMap(f => typeof f === 'string' ? [] : [f?.screen]), ...Object.keys(input.screenStatuses ?? {})].some(id => !declared.includes(id)))
    throw new FactoryError('invalid-design-decision', 'findings and statuses must name declared screens');
  verifyRefs(input.root, run.design.refs, run.ownedPaths);
  return commandRun(input.state, input.slug, input.runId, command);
}

/** Browser evidence is pinned to exactly the submitted screenshot blobs. */
export function verifyBrowserEvidence(root: string, design: import("./run-journal.ts").DesignReview): void {
  const read = (suffix: string) => {
    const ref = design.refs.find(r => r.path.endsWith('/' + suffix));
    return ref ? gitBytes(root, 'show', `${ref.commit}:${ref.path}`).toString() : '';
  };
  const declared = designScreens(read('EXPERIENCE.md'), read('mockups/manifest.json')).map(s => s.id);
  const reports = design.browserEvidence.filter(r => r.path.endsWith('.json'));
  if (!reports.length) throw new FactoryError('browser-evidence-required', 'structured offline browser evidence required');
  for (const ref of reports) {
    let report: BrowserEvidenceReport;
    try { report = JSON.parse(gitBytes(root, 'show', `${ref.commit}:${ref.path}`).toString()); }
    catch { throw new FactoryError('browser-evidence-invalid', 'invalid browser JSON'); }
    const strict = declared.length > 0 || report?.screens !== undefined || report?.detector !== undefined || (report?.viewports?.length ?? 0) > 1 || new Set((report?.states ?? []).map(s => s.screen)).size > 1;
    const issues = browserCoverageIssues(report, declared, strict);
    if (issues.length) throw new FactoryError('browser-evidence-invalid', issues.join('; '));
    for (const viewport of report.viewports) {
      const screenshot = viewport.screenshot;
      const pinned = design.refs.find(r => r.path === screenshot?.path && r.sha256 === screenshot.sha256);
      if (!Number.isFinite(viewport.width) || viewport.width < 1 || !Number.isFinite(viewport.height) || viewport.height < 1 || !safePath(screenshot?.path) || !pinned)
        throw new FactoryError('browser-evidence-invalid', 'viewport screenshot missing from design refs or changed');
      const bytes = gitBytes(root, 'show', `${pinned.commit}:${pinned.path}`);
      if (artifactAt(root, pinned.commit, pinned.path).sha256 !== screenshot.sha256 || bytes.length <= 8 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
        throw new FactoryError('browser-evidence-invalid', 'screenshot must be a hash-verified non-empty PNG');
    }
  }
}
