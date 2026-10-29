import { registerOwnedPaths } from "./core/scrum/ownership.ts";
/** Scrum specialist contract defaults and dynamic ownership. */
import { dirname, join } from "node:path";
import { FactoryError } from "./core/errors.ts";
import type { Factory } from "./core/factory.ts";
import { resolveProject } from "./core/project.ts";
import { assertExecutionReady } from "./core/scrum/execution.ts";
import { commandRun, readRun, terminalRun } from "./core/scrum/run-journal.ts";
import { resolveActiveRun } from "./core/scrum/seat-operations.ts";
import { assertDevReady } from "./core/scrum/approval.ts";
import { gitBytes, artifactAt, verifyRefs, sha256 } from "./core/scrum/artifacts.ts";
import { trackKind } from "./core/scrum/tracks.ts";
import { SPECIALIST_ROLES, safePath } from "./core/scrum/types.ts";
import type { ScrumRoleName, ScrumTaskBinding, ArtifactRef } from "./core/scrum/types.ts";
import { ensureFactoryBinScripts } from "./core/agy-home.ts";
import { bindScrumEpoch } from "./scrum.ts";
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
    retirePeerIds?: string[];
  },
): {
  execution?: ScrumTaskBinding;
  scope?: string[];
  artifact?: string;
  gate?: string;
  existing?: boolean;
  operationId?: string;
  retirePeerIds?: string[];
} {
  const raw = request as unknown as Record<string, unknown>;
  const requestFingerprint = sha256(
    JSON.stringify(
      Object.fromEntries(
        [
          "task",
          "workspace",
          "gate",
          "artifact",
          "base",
          "scope",
          "skills",
          "freshEyes",
          "watch",
          "description",
          "runId",
          "role",
          "artifactRefs",
        ].map((key) => [key, raw[key]]),
      ),
    ),
  );
  const project = resolveProject(request.workspace);
  if (!project.ok) return {};
  assertExecutionReady(factory.stateDir, project.slug);
  let run = resolveActiveRun(factory.stateDir, project.slug, request.runId);
  const previousContract = factory.contractFor(request.task);
  let operationId = request.id;
  const intents =
    run.tasks.find((t) => t.task === request.task)?.contractIntents ?? [];
  const exactIntent = intents.find((i) => i.requestId === request.id);
  const pendingIntent = intents.find((i) => !i.rejection && !i.peersRetired);
  const priorIntent =
    exactIntent ??
    (pendingIntent?.fingerprint === requestFingerprint
      ? pendingIntent
      : undefined);

  if (priorIntent) {
    if (priorIntent.fingerprint !== requestFingerprint)
      throw new FactoryError("contract-request-conflict", request.id);
    operationId = priorIntent.requestId;
    if (priorIntent.rejection)
      throw new FactoryError(
        priorIntent.rejection.code,
        priorIntent.rejection.message,
      );
    if (priorIntent.epoch !== undefined)
      return {
        existing: true,
        execution: previousContract?.execution,
        operationId,
        retirePeerIds: priorIntent.peersRetired
          ? []
          : (priorIntent.retirePeerIds ?? []),
      };
    if (
      previousContract &&
      previousContract.seq !== priorIntent.previousEpoch &&
      previousContract.execution?.contractRequestId === operationId
    ) {
      bindScrumEpoch(
        factory,
        request.task,
        previousContract.seq,
        previousContract.execution,
        `${operationId}:bound`,
        operationId,
      );
      return {
        existing: true,
        execution: previousContract.execution,
        operationId,
        retirePeerIds: priorIntent.retirePeerIds ?? [],
      };
    }
  }
  if (terminalRun(run) || run.cancellation)
    throw new FactoryError("scrum-run-terminal", run.phase);
  if (
    factory.ledger.events.some(
      (event) =>
        event.event === "attempt_accepted" && event.task === request.task,
    )
  )
    throw new FactoryError("task-accepted", "accepted Task stays closed");
  if (
    run.tasks
      .find((task) => task.task === request.task)
      ?.contractIntents?.some(
        (intent) =>
          !intent.rejection &&
          !intent.peersRetired &&
          intent.requestId !== operationId,
      )
  )
    throw new FactoryError(
      "contract-intent-pending",
      "reconcile the interrupted Contract request first",
    );
  const role = request.role ?? previousContract?.execution?.role ?? "dev";
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
      : ["ux", "architect"].includes(role) && trackKind(run.track) !== "small"
        ? run.tasks
            .filter((t) => t.role === "pm")
            .flatMap((t) => t.result?.artifactRefs ?? [])
            .filter((ref) => ref.path === `.scratch/${run.initiativeId}/prd.md`)
        : [];
  if (
    ["ux", "architect"].includes(role) &&
    trackKind(run.track) !== "small" &&
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
    contractRequestId: operationId,
    runId: run.runId,
    role,
    policyRevision: run.policyRevision,
    configRevision: run.configRevision,
    artifactRefs: request.artifactRefs ?? [],
  };
  const prefix = `.scratch/${run.initiativeId}/`;
  const artifact = request.artifact ?? ({ pm: `${prefix}prd.md`, ux: `${prefix}ux-spec.md`, architect: `${prefix}architecture.md`, qa: `${prefix}qa/${request.task}.md`, dev: undefined })[role];
  const decision = `${prefix}decisions/${request.task}.jsonl`;
  const inherited = role === "dev" ? [] : run.ownedPaths.filter(path =>
    (role === "pm" && /\/(prd|sprint-backlog)\.md$/.test(path)) ||
    (role === "ux" && /\/(ux-spec|DESIGN|EXPERIENCE)\.md$|\/mockups\//.test(path)) ||
    (role === "architect" && path.endsWith("/architecture.md")) ||
    (role === "qa" && /\/qa\/|\/qa-report\.(json|md)$/.test(path)));
  const roleDefaults = {
    pm: [`${prefix}sprint-backlog.md`],
    ux: [`${prefix}DESIGN.md`, `${prefix}EXPERIENCE.md`, `${prefix}mockups/index.html`],
    architect: [], dev: [], qa: [`${prefix}qa/qa-report.json`],
  }[role];
  const scope = [...new Set([...(request.scope ?? [...inherited, ...roleDefaults]), decision, ...(artifact ? [artifact] : [])])];
  if (scope.some(path => !safePath(path) || path.startsWith("/") || /[*?\[\]{}]/.test(path) ||
      (role !== "dev" && !path.startsWith(prefix)) || (path.startsWith(".scratch/") && !path.startsWith(prefix))))
    throw new FactoryError("artifact-not-owned", "specialists must stay within their initiative; Dev implementation paths must be explicit");
  run = registerOwnedPaths(factory.stateDir, project.slug, run, scope, `${operationId}:paths`);
  request = { ...request, artifact };
  let gate: string | undefined;
  if (role !== "dev" && request.gate) {
    ensureFactoryBinScripts(factory.stateDir);
    const kind =
      role === "pm"
        ? trackKind(run.track) === "small"
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
  run = readRun(factory.stateDir, project.slug, run.runId);
  commandRun(factory.stateDir, project.slug, run.runId, {
    type: "contract_intended",
    requestId: `${operationId}:intent`,
    expectedRevision: run.revision,
    task: request.task,
    operationId,
    fingerprint: requestFingerprint,
    previousEpoch: priorIntent?.previousEpoch ?? existing?.seq,
    retirePeerIds: priorIntent?.retirePeerIds ?? request.retirePeerIds ?? [],
  });
  return {
    execution,
    artifact,
    operationId,
    retirePeerIds: priorIntent?.retirePeerIds ?? request.retirePeerIds ?? [],
    ...(scope === undefined ? {} : { scope }),
    ...(gate === undefined ? {} : { gate }),
  };
}
