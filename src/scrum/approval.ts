import { trackKind } from "./tracks.ts";
import { safePath } from "./types.ts";
import { FactoryError } from "../errors.ts";
import { designDigest, verifyRefs, gitBytes, artifactAt } from "./artifacts.ts";
import { commandRun, readRun, terminalRun } from "./run-journal.ts";
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
  findings?: string[];
}): ScrumRun {
  if (
    input.authority !== "owner" &&
    (input.authority !== "supervisor" || !input.explicitOwnerInstruction)
  )
    throw new FactoryError(
      "ui-decision-unauthorized",
      "Owner or explicitly instructed Supervisor required",
    );
  const run = readRun(input.state, input.slug, input.runId);
  if (!run.design) throw new FactoryError("ui-review-missing", input.runId);
  verifyCompleteDesign(input.root, run, run.design);
  verifyRefs(input.root, run.design.refs, run.ownedPaths);
  return commandRun(input.state, input.slug, input.runId, {
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
  });
}

/** Browser evidence describes real checks; static HTML lint alone never unlocks Dev. */
export function verifyBrowserEvidence(
  root: string,
  design: import("./run-journal.ts").DesignReview,
): void {
  const states = [
    "empty",
    "loading",
    "populated",
    "error",
    "offline",
    "permission-denied",
  ];
  const reports = design.browserEvidence.filter((r) =>
    r.path.endsWith(".json"),
  );
  if (!reports.length)
    throw new FactoryError(
      "browser-evidence-required",
      "structured offline browser evidence required",
    );
  for (const ref of reports) {
    const report = JSON.parse(
      gitBytes(root, "show", `${ref.commit}:${ref.path}`).toString(),
    ) as {
      network: string;
      consoleErrors: unknown[];
      viewports: {
        width: number;
        height: number;
        screenshot: { path: string; sha256: string };
      }[];
      states: {
        screen: string;
        state: string;
        keyboard?: boolean;
        passed?: boolean;
        notApplicable?: string;
      }[];
    };
    if (
      report.network !== "disabled" ||
      !Array.isArray(report.consoleErrors) ||
      report.consoleErrors.length ||
      !Array.isArray(report.viewports) ||
      !report.viewports.length ||
      !Array.isArray(report.states) ||
      !report.states.length
    )
      throw new FactoryError(
        "browser-evidence-invalid",
        "offline network, clean console, viewport/screenshots and state checks required",
      );
    for (const viewport of report.viewports) {
      if (
        !Number.isFinite(viewport.width) ||
        viewport.width < 1 ||
        !Number.isFinite(viewport.height) ||
        viewport.height < 1 ||
        !safePath(viewport.screenshot?.path) ||
        artifactAt(root, ref.commit, viewport.screenshot.path).sha256 !==
          viewport.screenshot.sha256
      )
        throw new FactoryError(
          "browser-evidence-invalid",
          "viewport screenshot missing or changed",
        );
    }
    for (const screen of new Set(report.states.map((s) => s.screen)))
      for (const state of states) {
        const check = report.states.find(
          (s) => s.screen === screen && s.state === state,
        );
        if (
          !screen ||
          !check ||
          !(
            (check.keyboard === true && check.passed === true) ||
            (typeof check.notApplicable === "string" &&
              check.notApplicable.trim().length > 5)
          )
        )
          throw new FactoryError(
            "browser-evidence-invalid",
            `${screen}/${state} needs a passing keyboard check or justified N/A`,
          );
      }
  }
}
