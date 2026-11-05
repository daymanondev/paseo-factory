/**
 * Bounded Scrum run digest (v0.2.0, ADR 0049 §2) — a pure, deterministic
 * compact-Markdown summary of a `ScrumRun` (~300–500 tokens) that replaces
 * the raw `JSON.stringify(activeRun)` dumps injected into Turn-1 kickoffs
 * and `128k` Lead handoffs. Read-only over the run journal's data shape:
 * it never dumps `operationIntents`, `contractIntents`, or settled tasks'
 * artifact refs, and it never mutates run state (the spec's Out of Scope
 * keeps `run-journal.ts` / `controller.ts` state machines untouched).
 */
import type { RunTask, ScrumRun } from "./run-journal.ts";

const CLIP_LIMIT = 120;

function clip(value: string, max = CLIP_LIMIT): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** Settled = the run's own vocabulary for an accepted task: `result.status === "complete"`. */
function isSettled(task: RunTask): boolean {
  return task.result?.status === "complete";
}

function taskRow(task: RunTask): string {
  const status = task.result?.status ?? "no result yet";
  const artifactPaths = (task.result?.artifactRefs ?? []).map((ref) => ref.path).join(", ");
  return `- Task ${task.task} [${task.role} · ${status} · epoch=${task.epoch ?? "none"} · artifacts: ${
    artifactPaths.length > 0 ? artifactPaths : "none"
  }]`;
}

export function formatScrumRunDigest(run: ScrumRun): string {
  const lines: string[] = [];
  lines.push(
    `Scrum run ${run.runId} (initiative ${run.initiativeId}): phase=${run.phase}, track=${run.track} (${clip(
      run.rationale,
    )}), revision=${run.revision}, configRevision=${run.configRevision}, budgets: tasks=${
      run.tasks.length
    }/${run.budgets.maxTasks}, qaFixRounds=${run.fixRounds}/${run.budgets.maxQaFixRounds}`,
  );
  const blockers = [...run.blockers, ...(run.blockerDetails ?? []).map((blocker) => `${blocker.id}: ${blocker.reason}`)];
  if (blockers.length > 0) lines.push(`- Blockers: ${blockers.join("; ")}`);
  lines.push(
    run.readiness === undefined
      ? "- Readiness: not recorded"
      : `- Readiness: recorded — ${clip(run.readiness.rationale)} (contradictions=${
          run.readiness.contradictions.length
        }, unsafeAssumptions=${run.readiness.unsafeAssumptions.length}, missingCoverage=${
          run.readiness.missingCoverage.length
        })`,
  );
  if (run.design === undefined) {
    lines.push("- Design: not reviewed");
  } else {
    const screenStatuses = run.design.screenStatuses ? Object.values(run.design.screenStatuses) : undefined;
    const screenSummary =
      screenStatuses === undefined
        ? ""
        : `, screens=${screenStatuses.filter((status) => status === "approved").length} approved/${
            screenStatuses.filter((status) => status === "revise").length
          } revise`;
    lines.push(
      `- Design: revision=${run.design.revision}, decision=${run.design.decision ?? "pending"}, digest=${clip(
        run.design.digest,
      )}${screenSummary}`,
    );
  }
  // ADR 0049 §2 (mirroring the ADR 0047 §1.3 ledger compaction precedent):
  // settled history past 3 tasks collapses into one count + latest-tail
  // line; active/unaccepted tasks always keep their full row.
  const settled = run.tasks.filter(isSettled);
  const active = run.tasks.filter((task) => !isSettled(task));
  if (settled.length > 3) {
    lines.push(`- Settled tasks: ${settled.length} (latest: ${settled.slice(-3).map((task) => task.task).join(", ")})`);
    lines.push(...active.map(taskRow));
  } else {
    lines.push(...run.tasks.map(taskRow));
  }
  const latestAudit = run.qaAudits.at(-1);
  if (latestAudit !== undefined) {
    lines.push(`- QA latest audit: ${latestAudit.path}@${latestAudit.commit.slice(0, 8)}`);
  }
  if (run.fixReservations.length > 0) {
    lines.push(
      `- Fix reservations: ${run.fixReservations
        .map((reservation) => `${reservation.task} (requestId=${reservation.requestId}${
          reservation.summary ? ` · ${clip(reservation.summary)}` : ""
        })`)
        .join("; ")}`,
    );
  }
  const pendingRequests = (run.ownerRequests ?? []).filter((request) => request.status === "pending");
  if (pendingRequests.length > 0) {
    lines.push(
      `- Pending owner requests: ${pendingRequests
        .map((request) => `${request.id} (${request.kind}): ${clip(request.question)}`)
        .join("; ")}`,
    );
  }
  const undeliveredWakeups = (run.wakeups ?? []).filter((wakeup) => wakeup.delivered !== true);
  if (undeliveredWakeups.length > 0) {
    lines.push(
      `- Undelivered wakeups: ${undeliveredWakeups
        .map((wakeup) => `${wakeup.id}${wakeup.target ? `->${wakeup.target}` : ""}: ${clip(wakeup.message)}`)
        .join("; ")}`,
    );
  }
  return lines.join("\n");
}
