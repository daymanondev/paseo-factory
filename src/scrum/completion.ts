import type { LedgerEvent } from "../events.ts";
import { projectTask } from "../task-state.ts";
import { assertDevReady } from "./approval.ts";
import { gitBytes, verifyRefs } from "./artifacts.ts";
import {
  bundlePromoted,
  executableRevisionIsCurrent,
  validateQaReport,
} from "./qa-bundle.ts";
import type { QaReport } from "./qa-bundle.ts";
import type { ScrumRun } from "./run-journal.ts";
/** Return every blocker so the Supervisor can report actionable work, never a false completion. */
export function completionBlockers(input: {
  root: string;
  run: ScrumRun;
  events: readonly LedgerEvent[];
  activeAgents: string[];
  pendingDirectives: boolean;
}): string[] {
  const { root, run, events } = input,
    blockers: string[] = [];
  try {
    assertDevReady(root, run);
  } catch (error) {
    blockers.push(String(error));
  }
  for (const task of run.tasks) {
    const state = projectTask(events, task.task);
    if (
      state.contract?.execution?.runId !== run.runId ||
      state.epochSeq !== task.epoch
    )
      blockers.push(`Task ${task.task} binding/epoch does not match run`);
    if (
      (task.required && !state.settled) ||
      state.pendingLanding ||
      state.inFlightAttempt !== undefined
    )
      blockers.push(`Task ${task.task} is not landed/closed`);
    if (
      task.result?.status !== "complete" ||
      task.result.assumptions.some((a) => a.unsafe && !a.resolved) ||
      task.result.conflicts.length ||
      task.result.openQuestions.length
    )
      blockers.push(`Task ${task.task} needs a safe complete role result`);
  }
  if (!run.tasks.length) blockers.push("run has no delivered Tasks");
  if (input.activeAgents.length || input.pendingDirectives)
    blockers.push("Agents/directives still in flight");
  try {
    if (gitBytes(root, "status", "--porcelain").toString().trim())
      blockers.push("Project root is dirty");
  } catch {
    blockers.push("Project Git state unavailable");
  }
  const audit = run.qaAudits.at(-1);
  if (!audit) blockers.push("clean QA audit required");
  else {
    try {
      verifyRefs(root, [audit], run.ownedPaths);
      const report = JSON.parse(
        gitBytes(root, "show", `${audit.commit}:${audit.path}`).toString(),
      ) as QaReport;
      blockers.push(...validateQaReport(report));
      if (report.status !== "clean" || !report.activeSuite)
        blockers.push("current QA must attest the active required suite clean");
      const reportsOnly = run.ownedPaths.filter(
        (p) =>
          /\/(?:qa\/|decisions\/)|\/qa-report\.(?:json|md)$/.test(p) &&
          !p.includes("/bundle/"),
      );
      if (!executableRevisionIsCurrent(root, report.productSha, reportsOnly))
        blockers.push("QA executable product revision is stale");
      for (const ref of run.qaAudits) {
        const prior = JSON.parse(
          gitBytes(root, "show", `${ref.commit}:${ref.path}`).toString(),
        ) as QaReport;
        for (const bundle of prior.bundles)
          if (bundle.required && !bundlePromoted(root, ref.commit, bundle))
            blockers.push(
              `required bundle ${bundle.id} is not promoted byte-for-byte`,
            );
        for (const f of prior.findings)
          if (
            f.required &&
            f.confirmed &&
            !f.resolved &&
            !report.findings.some((now) => now.id === f.id && now.resolved)
          )
            blockers.push(`required defect ${f.id} lacks resolved evidence`);
      }
    } catch (error) {
      blockers.push(`QA evidence unreadable: ${String(error)}`);
    }
  }
  return blockers;
}
