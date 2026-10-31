import { assertOwnerDependencies } from "./core/scrum/owner-work.ts";
import { readCorrelations } from "./core/correlations.ts";
/** Mode-local adapter at dispatch/Contract/spawn ingress. Common Gate/accept stays unchanged. */
import { join } from "node:path";
import { FactoryError } from "./core/errors.ts";
import type { Factory } from "./core/factory.ts";
import { resolveProject } from "./core/project.ts";
import { parseLane } from "./core/lanes.ts";
import { assertExecutionReady } from "./core/scrum/execution.ts";
import { commandRun, readRun, terminalRun } from "./core/scrum/run-journal.ts";
import { assertDevReady } from "./core/scrum/approval.ts";
import {
  verifyRefs,
} from "./core/scrum/artifacts.ts";
import type {
  ScrumRoleName,
  ScrumTaskBinding,
} from "./core/scrum/types.ts";

export { prepareScrumContract } from "./scrum-contract.ts";
export function bindScrumEpoch(
  factory: Factory,
  task: string,
  epoch: number,
  execution: ScrumTaskBinding,
  requestId: string,
  intentId?: string,
): void {
  const contract = factory.contractFor(task)!,
    project = resolveProject(contract.workspace);
  if (!project.ok)
    throw new FactoryError("unknown-project", contract.workspace);
  const run = readRun(factory.stateDir, project.slug, execution.runId);
  const own = run.tasks.find((t) => t.task === task);
  if (
    own?.epoch === epoch &&
    (intentId === undefined ||
      own.contractIntents?.find((intent) => intent.requestId === intentId)
        ?.epoch === epoch)
  )
    return;
  commandRun(factory.stateDir, project.slug, run.runId, {
    type: "task_bound",
    task,
    epoch,
    ...(intentId === undefined ? {} : { intentId }),
    requestId,
    expectedRevision: run.revision,
  });
}
export async function scrumSpawnLane(
  factory: Factory,
  task: string,
  assertions: { runId?: string; role?: ScrumRoleName },
  override?: string,
  requestId = "spawn",
  sanitize?: (lane: string) => string | Promise<string>,
): Promise<string | undefined> {
  const contract = factory.contractFor(task),
    execution = contract?.execution;
  if (!execution) {
    if (assertions.runId !== undefined || assertions.role !== undefined)
      throw new FactoryError(
        "task-execution-mismatch",
        "legacy Task is SLP/Peer",
      );
    return undefined;
  }
  if (
    (assertions.runId !== undefined && assertions.runId !== execution.runId) ||
    (assertions.role !== undefined && assertions.role !== execution.role)
  )
    throw new FactoryError("task-execution-mismatch", task);
  const project = resolveProject(contract!.workspace);
  if (!project.ok)
    throw new FactoryError("unknown-project", contract!.workspace);
  assertExecutionReady(factory.stateDir, project.slug);
  const run = readRun(factory.stateDir, project.slug, execution.runId);
  if (
    terminalRun(run) ||
    run.cancellation ||
    run.tasks
      .find((t) => t.task === task)
      ?.contractIntents?.some((i) => !i.rejection && !i.peersRetired) ||
    run.phase === "blocked" ||
    run.blockers.length > 0 ||
    run.configRevision !== execution.configRevision ||
    run.policyRevision !== execution.policyRevision
  )
    throw new FactoryError(
      "scrum-run-blocked",
      "run/binding unavailable or mismatched",
    );
  assertOwnerDependencies(run, { task, role: execution.role });
  verifyRefs(project.root, execution.artifactRefs, run.ownedPaths);
  if (execution.role === "dev") assertDevReady(project.root, run, task);
  const own = run.tasks.find(
    (t) => t.task === task && t.epoch === contract!.seq,
  );
  if (!own)
    throw new FactoryError(
      "task-execution-mismatch",
      "missing run Task/epoch association",
    );
  let provider = own.provider ?? override ?? run.config.lanes[execution.role];
  if (own.provider === undefined && sanitize)
    provider = await sanitize(provider);
  if (!parseLane(provider))
    throw new FactoryError("invalid-provider", provider);
  if (own.provider === undefined)
    commandRun(factory.stateDir, project.slug, run.runId, {
      type: "provider_selected",
      requestId: `${requestId}:provider`,
      expectedRevision: run.revision,
      task,
      epoch: contract!.seq,
      provider,
    });
  else if (override !== undefined && override !== own.provider)
    throw new FactoryError("task-provider-frozen", own.provider);
  return provider;
}

export { bindScrumDirective } from "./scrum-directive.ts";
export type { ScrumDirective } from "./scrum-directive.ts";
export function bindScrumBlocker(
  factory: Factory,
  slug: string,
  request: { id: string; task?: string; submitter?: string; message: string },
): {
  execution?: { mode: "scrum"; runId: string; configRevision: number };
  packet?: string;
} {
  const caller = readCorrelations(factory.stateDir).find(
    (r) =>
      r.correlationId === request.submitter || r.agentId === request.submitter,
  );
  const task = caller?.task ?? request.task;
  const contract = task ? factory.contractFor(task) : undefined;
  if (!contract?.execution) return {};
  const project = resolveProject(contract.workspace);
  if (
    !project.ok ||
    project.slug !== slug ||
    (caller && caller.projectSlug !== slug)
  )
    throw new FactoryError(
      "cross-project-refused",
      "blocker belongs to another Project",
    );
  const run = readRun(factory.stateDir, slug, contract.execution.runId);
  const updated = commandRun(factory.stateDir, slug, run.runId, {
    type: "blocked",
    reason: `Task ${task}: ${request.message}`,
    requestId: `${request.id}:blocker`,
    expectedRevision: run.revision,
  });
  return {
    execution: {
      mode: "scrum",
      runId: run.runId,
      configRevision: run.configRevision,
    },
    packet: `# Persisted Scrum blocker\n${JSON.stringify(updated)}\n`,
  };
}
