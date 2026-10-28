import { readCorrelations } from "./core/correlations.ts";
import { dirname } from "node:path";
import { ensureFactoryBinScripts } from "./core/agy-home.ts";
import { scrumOperation } from "./core/scrum/controller.ts";
/** Mode-local adapter at dispatch/Contract/spawn ingress. Common Gate/accept stays unchanged. */
import { join } from "node:path";
import { FactoryError } from "./core/errors.ts";
import type { Factory } from "./core/factory.ts";
import { resolveProject } from "./core/project.ts";
import { parseLane } from "./core/lanes.ts";
import { readExecution } from "./core/scrum/config.ts";
import { assertExecutionReady } from "./core/scrum/execution.ts";
import { commandRun, readRun, terminalRun } from "./core/scrum/run-journal.ts";
import { assertDevReady } from "./core/scrum/approval.ts";
import { gitBytes, artifactAt, verifyRefs } from "./core/scrum/artifacts.ts";
import { SPECIALIST_ROLES } from "./core/scrum/types.ts";
import type {
  ScrumRoleName,
  ScrumTaskBinding,
  ArtifactRef,
} from "./core/scrum/types.ts";

export function prepareScrumContract(
  factory: Factory,
  request: {
    id: string;
    task: string;
    workspace: string;
    runId?: string;
    role?: ScrumRoleName;
    artifactRefs?: ArtifactRef[];
    scope?: string[];
    gate?: string;
    artifact?: string;
  },
): {
  execution?: ScrumTaskBinding;
  scope?: string[];
  gate?: string;
  existing?: boolean;
} {
  const project = resolveProject(request.workspace);
  if (!project.ok) return {};
  assertExecutionReady(factory.stateDir, project.slug);
  const mode = readExecution(factory.stateDir, project.slug).mode;
  if (request.runId === undefined && request.role === undefined) {
    if (mode === "scrum")
      throw new FactoryError(
        "scrum-run-required",
        "new Scrum Contracts must name --run",
      );
    return {};
  }
  if (mode !== "scrum")
    throw new FactoryError(
      "execution-mode-mismatch",
      "specialist fields require an explicitly Scrum Project",
    );
  if (!request.runId)
    throw new FactoryError("scrum-run-required", "runId required");
  let run = readRun(factory.stateDir, project.slug, request.runId);
  if (terminalRun(run)) throw new FactoryError("scrum-run-terminal", run.phase);
  const role = request.role ?? "dev";
  if (!SPECIALIST_ROLES.includes(role))
    throw new FactoryError("invalid-specialist-role", String(role));
  verifyRefs(project.root, request.artifactRefs ?? [], run.ownedPaths);
  if (role === "dev") {
    assertDevReady(project.root, run);
    const audit = run.qaAudits.at(-1);
    if (audit) {
      const report = JSON.parse(
        gitBytes(
          project.root,
          "show",
          `${audit.commit}:${audit.path}`,
        ).toString(),
      ) as import("./core/scrum/qa-bundle.ts").QaReport;
      if (
        report.status === "defects_found" &&
        !run.fixReservations.some((r) => r.task === request.task)
      )
        throw new FactoryError(
          "qa-fix-reservation-required",
          "reserve a durable fix round before contracting this Dev Task",
        );
      request = {
        ...request,
        artifactRefs: [
          ...(request.artifactRefs ?? []),
          audit,
          ...report.bundles.flatMap((b) =>
            b.files.map((f) => artifactAt(project.root, audit.commit, f.path)),
          ),
        ],
      };
    }
  }
  const dependencyRefs =
    role === "dev"
      ? [
          ...(run.readiness?.refs ?? []),
          ...(run.design?.refs ?? []),
          ...(run.design?.browserEvidence ?? []),
        ]
      : ["ux", "architect"].includes(role) && run.track !== "small"
        ? run.tasks
            .filter((t) => t.role === "pm")
            .flatMap((t) => t.result?.artifactRefs ?? [])
            .filter((ref) => ref.path === `.scratch/${run.initiativeId}/prd.md`)
        : [];
  if (
    ["ux", "architect"].includes(role) &&
    run.track !== "small" &&
    !dependencyRefs.length
  )
    throw new FactoryError(
      "planning-foundation-required",
      "UX/Architect require the landed common PRD",
    );
  request = {
    ...request,
    artifactRefs: [
      ...new Map(
        [...(request.artifactRefs ?? []), ...dependencyRefs].map((ref) => [
          ref.path,
          ref,
        ]),
      ).values(),
    ],
  };
  verifyRefs(project.root, request.artifactRefs!, run.ownedPaths);
  const existing = factory.contractFor(request.task),
    reserved = run.tasks.find((t) => t.task === request.task);
  if (
    existing &&
    (existing.execution?.runId !== run.runId ||
      existing.execution.role !== role)
  )
    throw new FactoryError(
      "task-execution-mismatch",
      "Task already belongs to another execution identity",
    );
  if (!reserved)
    run = commandRun(factory.stateDir, project.slug, run.runId, {
      type: "task_reserved",
      requestId: `${request.id}:reserve`,
      expectedRevision: run.revision,
      task: request.task,
      role,
      required: true,
    });
  const execution: ScrumTaskBinding = {
    mode: "scrum",
    runId: run.runId,
    role,
    policyRevision: run.policyRevision,
    configRevision: run.configRevision,
    artifactRefs: request.artifactRefs ?? [],
  };
  // Planning and QA may write only explicit owned artifacts, enforced by the existing scope Gate.
  const scope =
    role === "dev"
      ? request.scope
      : run.ownedPaths.filter(
          (path) =>
            path ===
              `.scratch/${run.initiativeId}/decisions/${request.task}.jsonl` ||
            (role === "pm" && /\/(prd|sprint-backlog)\.md$/.test(path)) ||
            (role === "ux" &&
              /\/(DESIGN|EXPERIENCE)\.md$|\/mockups\//.test(path)) ||
            (role === "architect" && path.endsWith("/architecture.md")) ||
            (role === "qa" && /\/qa\/|\/qa-report\.(json|md)$/.test(path)),
        );
  if (role !== "dev" && !scope?.length)
    throw new FactoryError(
      "artifact-ownership-required",
      "declare this role's exact artifact paths at run admission",
    );
  if (existing)
    bindScrumEpoch(
      factory,
      request.task,
      existing.seq,
      execution,
      `${request.id}:reconcile`,
    );
  let gate: string | undefined;
  if (role !== "dev" && request.gate) {
    ensureFactoryBinScripts(factory.stateDir);
    const kind =
      role === "pm"
        ? run.track === "small"
          ? "backlog"
          : "prd"
        : role === "architect"
          ? "architecture"
          : role;
    const dir =
      role === "qa" && request.artifact
        ? dirname(request.artifact)
        : `.scratch/${run.initiativeId}`;
    if (request.artifact && !scope?.includes(request.artifact))
      throw new FactoryError("artifact-not-owned", request.artifact);
    const quote = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
    gate = `(${request.gate}) && ${quote(process.execPath)} ${quote(join(factory.stateDir, "runtime-bin/factory.mjs"))} lint-scrum-doc --kind ${kind} --dir ${quote(dir)}`;
  }
  return {
    execution,
    ...(scope === undefined ? {} : { scope }),
    ...(gate === undefined ? {} : { gate }),
    ...(existing ? { existing: true } : {}),
  };
}
export function bindScrumEpoch(
  factory: Factory,
  task: string,
  epoch: number,
  execution: ScrumTaskBinding,
  requestId: string,
): void {
  const contract = factory.contractFor(task)!,
    project = resolveProject(contract.workspace);
  if (!project.ok)
    throw new FactoryError("unknown-project", contract.workspace);
  const run = readRun(factory.stateDir, project.slug, execution.runId);
  if (run.tasks.find((t) => t.task === task)?.epoch === epoch) return;
  commandRun(factory.stateDir, project.slug, run.runId, {
    type: "task_bound",
    task,
    epoch,
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
    run.phase === "blocked" ||
    run.configRevision !== execution.configRevision ||
    run.policyRevision !== execution.policyRevision
  )
    throw new FactoryError(
      "scrum-run-blocked",
      "run/binding unavailable or mismatched",
    );
  if (Date.now() - Date.parse(run.createdAt) >= run.budgets.maxElapsedMs)
    throw new FactoryError(
      "scrum-budget-exhausted",
      "elapsed budget exhausted",
    );
  verifyRefs(project.root, execution.artifactRefs, run.ownedPaths);
  if (execution.role === "dev") assertDevReady(project.root, run);
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

export interface ScrumDirective {
  runId?: string;
  scrum?: {
    initiativeId: string;
    track: import("./core/scrum/run-journal.ts").RunTrack;
    rationale: string;
    ownedPaths: string[];
    budgets?: Partial<import("./core/scrum/run-journal.ts").RunBudgets>;
  };
}
export function bindScrumDirective(
  factory: Factory,
  root: string,
  slug: string,
  request: ScrumDirective & { id: string },
): {
  execution?: { mode: "scrum"; runId: string; configRevision: number };
  packet?: string;
} {
  assertExecutionReady(factory.stateDir, slug);
  if (readExecution(factory.stateDir, slug).mode === "slp") {
    if (request.runId || request.scrum)
      throw new FactoryError(
        "execution-mode-mismatch",
        "SLP directive cannot carry a Scrum run",
      );
    return {};
  }
  const runId =
    request.runId ?? (request.scrum ? `run-${request.id}` : undefined);
  if (!runId)
    throw new FactoryError(
      "scrum-run-required",
      "name runId for follow-up or supply scrum admission metadata for new work",
    );
  let run: import("./core/scrum/run-journal.ts").ScrumRun;
  if (request.scrum) {
    // create is implemented by the same writer-owned controller as CLI/RPC.
    run = scrumOperation(
      {
        operation: "run.create",
        runId,
        requestId: `${request.id}:admit`,
        payload: request.scrum,
      },
      {
        factory,
        slug,
        root,
        authority: "supervisor",
        actor: "supervisor",
        activeAgents: [],
        pendingDirectives: false,
      },
    ) as typeof run;
  } else run = readRun(factory.stateDir, slug, runId);
  if (terminalRun(run)) throw new FactoryError("scrum-run-terminal", run.phase);
  return {
    execution: { mode: "scrum", runId, configRevision: run.configRevision },
    packet: `# Frozen Scrum run\n${JSON.stringify(run)}\n`,
  };
}

export function bindScrumBlocker(factory: Factory, slug: string, request: { id: string; task?: string; submitter?: string; message: string }): { execution?: { mode: "scrum"; runId: string; configRevision: number }; packet?: string } {
  const caller = readCorrelations(factory.stateDir).find(r => r.correlationId === request.submitter || r.agentId === request.submitter);
  const task = caller?.task ?? request.task;
  const contract = task ? factory.contractFor(task) : undefined;
  if (!contract?.execution) return {};
  const project = resolveProject(contract.workspace);
  if (!project.ok || project.slug !== slug || caller && caller.projectSlug !== slug) throw new FactoryError("cross-project-refused", "blocker belongs to another Project");
  const run = readRun(factory.stateDir, slug, contract.execution.runId);
  const updated = commandRun(factory.stateDir, slug, run.runId, { type: "blocked", reason: `Task ${task}: ${request.message}`, requestId: `${request.id}:blocker`, expectedRevision: run.revision });
  return { execution: { mode: "scrum", runId: run.runId, configRevision: run.configRevision }, packet: `# Persisted Scrum blocker\n${JSON.stringify(updated)}\n` };
}
