import { scrumSeatOperation } from "./seat-operations.ts";
import { trackKind } from "./tracks.ts";
import { lintScrumDoc } from "./linter.ts";
import { scrumTelemetry } from "./telemetry.ts";
import { projectTask } from "../task-state.ts";
import type { Factory } from "../factory.ts";
import { FactoryError } from "../errors.ts";
import {
  ensureScrumConfig,
  readExecution,
  readScrumConfig,
  saveScrumConfig,
  scrumConfigIsValid,
} from "./config.ts";
import {
  applyScrumProfile,
  deleteScrumProfile,
  readScrumProfiles,
  saveScrumProfile,
} from "./profiles.ts";
import { assertExecutionReady } from "./execution.ts";
import {
  createScrumRun,
  commandRun,
  replayRunCommand,
  readRun,
  listRuns,
  terminalRun,
} from "./run-journal.ts";
import type {
  RunCommand,
  RunTrack,
  RunBudgets,
  DesignReview,
} from "./run-journal.ts";
import {
  assertInitiativeAvailable,
  designDigest,
  verifyRefs,
} from "./artifacts.ts";
import {
  decideDesign,
  verifyBrowserEvidence,
  verifyCompleteDesign,
} from "./approval.ts";
import { completionBlockers } from "./completion.ts";
import { verifyQaFiles } from "./qa-bundle.ts";
import { gitBytes } from "./artifacts.ts";
import { renderPreview } from "./preview.ts";
import { servePreview } from "./preview-server.ts";
export interface ScrumOperation {
  operation: string;
  runId?: string;
  payload?: Record<string, unknown>;
  requestId: string;
  expectedRevision?: number;
}
function acceptedRefs(
  factory: Factory,
  run: import("./run-journal.ts").ScrumRun,
  refs: import("./types.ts").ArtifactRef[],
): void {
  const accepted = new Set(
    run.tasks.flatMap((t) => {
      const task = projectTask(factory.ledger.events, t.task);
      return task.settled &&
        task.contract?.execution?.runId === run.runId &&
        task.epochSeq === t.epoch &&
        task.currentAttempt?.gate?.sha
        ? [task.currentAttempt.gate.sha]
        : [];
    }),
  );
  for (const ref of refs)
    if (!accepted.has(ref.commit))
      throw new FactoryError(
        "artifact-not-accepted",
        `${ref.path}: commit must name a landed run Task`,
      );
}
export interface ScrumOperationContext {
  factory: Factory; slug?: string; root?: string;
  authority: "owner" | "supervisor" | "lead" | "agent";
  actor: string; activeAgents: string[]; pendingDirectives: boolean;
}
export function scrumOperation(input: ScrumOperation, ctx: ScrumOperationContext): unknown {
  const state = ctx.factory.stateDir,
    p = input.payload ?? {},
    owner = ctx.authority === "owner";
  const fail = (code: string, message: string): never => {
    throw new FactoryError(code, message);
  };
  if (ctx.authority === "agent")
    fail("agent-cannot-orchestrate", "specialists may only claim/escalate");
  if (
    input.operation.startsWith("config.") ||
    input.operation.startsWith("profile.")
  ) {
    if (!owner)
      fail(
        "owner-config-required",
        "Scrum configuration/profile actions require Owner",
      );
    if (input.operation === "config.set") {
      if (!scrumConfigIsValid(p.config))
        fail("scrum-config-invalid", "complete config required");
      return saveScrumConfig(
        state,
        p.config as import("./config.ts").ScrumConfig,
        ctx.slug,
      );
    }
    if (input.operation === "config.reset")
      return ensureScrumConfig(state, ctx.slug, true);
    if (input.operation === "profile.save") {
      if (typeof p.id !== "string" || typeof p.name !== "string")
        fail("invalid-profile", "ID/name required");
      return saveScrumProfile(state, {
        id: p.id as string,
        name: p.name as string,
        config:
          p.config === undefined
            ? ensureScrumConfig(state, ctx.slug)
            : scrumConfigIsValid(p.config)
              ? p.config
              : fail("invalid-profile", "complete roster required"),
      });
    }
    if (input.operation === "profile.apply") {
      if (typeof p.id !== "string") fail("invalid-profile", "ID required");
      return applyScrumProfile(state, p.id as string, ctx.slug);
    }
    if (input.operation === "profile.delete") {
      if (typeof p.id !== "string") fail("invalid-profile", "ID required");
      deleteScrumProfile(state, p.id as string);
      return { deleted: p.id };
    }
  }
  if (input.operation === "get")
    return {
      selection: readExecution(state, ctx.slug),
      config: readScrumConfig(state, ctx.slug),
      profiles: readScrumProfiles(state),
      runs: ctx.slug ? listRuns(state, ctx.slug) : [],
    };
  if (!ctx.slug || !ctx.root)
    fail("project-required", "Project scope required");
  const slug = ctx.slug!,
    root = ctx.root!;
  assertExecutionReady(state, slug);
  if (readExecution(state, slug).mode !== "scrum")
    fail("execution-mode-mismatch", "Project selection is SLP");
  if (["lead.operation", "supervisor.decision"].includes(input.operation)) return scrumSeatOperation(input, ctx, scrumOperation);
  if (input.operation === "run.create") {
    if (ctx.authority === "lead")
      fail(
        "supervisor-run-admission-required",
        "Supervisor binds new directives before queueing",
      );
    if (!input.runId || typeof p.initiativeId !== "string")
      fail("invalid-run", "runId/initiativeId required");
    if (!listRuns(state, slug).some((r) => r.runId === input.runId))
      assertInitiativeAvailable(root, p.initiativeId as string);
    return createScrumRun({
      state,
      slug,
      runId: input.runId!,
      initiativeId: p.initiativeId as string,
      config: ensureScrumConfig(state, slug),
      configRevision: readScrumConfig(state, slug)?.configRevision ?? 1,
      track: p.track as RunTrack,
      rationale: p.rationale as string,
      requestId: input.requestId,
      budgets: p.budgets as Partial<RunBudgets> | undefined,
      ownedPaths: p.ownedPaths as string[] | undefined,
    });
  }
  if (!input.runId) fail("scrum-run-required", "explicit runId required");
  const run = readRun(state, slug, input.runId!);
  if (input.operation === "track.select") {
    if (ctx.authority !== "lead") fail("scrum-track-authority", "Scrum Lead selects the track");
    const command: RunCommand = { type: "track_selected", track: p.track as RunTrack, rationale: p.rationale as string, requestId: input.requestId, expectedRevision: input.expectedRevision! };
    const replayed = replayRunCommand(state, slug, run.runId, command);
    if (replayed) return replayed;
    if (run.tasks.some(t => t.role === "dev" && projectTask(ctx.factory.ledger.events, t.task).settled)) fail("scrum-track-frozen", "Dev work already landed");
    return commandRun(state, slug, run.runId, command);
  }
  if (input.operation === "preview") return renderPreview(root, run);
  if (input.operation === "preview.url") return servePreview(root, run, { subpath: p.subpath as string | undefined, port: p.port as number | undefined });
  if (input.operation === "design.decide")
    return decideDesign({
      state,
      slug,
      root,
      runId: run.runId,
      authority: ctx.authority,
      actor: ctx.actor,
      explicitOwnerInstruction: p.explicitOwnerInstruction === true,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision!,
      revision: p.revision as number,
      digest: p.digest as string,
      decision: p.decision as "approved" | "changes_requested" | "waived",
      rationale: p.rationale as string,
      decidedBy: p.decidedBy as string | undefined,
      designArtifact: p.designArtifact as string | undefined,
      findings: p.findings as string[] | undefined,
    });
  if (input.operation === "run.complete") {
    if (run.phase === "completed") return run;
    const blockers = completionBlockers({
      root,
      run,
      events: ctx.factory.ledger.events,
      activeAgents: ctx.activeAgents,
      pendingDirectives: ctx.pendingDirectives,
    });
    const critical = blockers.filter(
      (reason) => reason !== "Agents/directives still in flight",
    );
    if (critical.length) fail("scrum-completion-blocked", blockers.join("; "));
    const requested = commandRun(state, slug, run.runId, {
      type: "completion_requested",
      requestId: input.requestId,
      expectedRevision: input.expectedRevision!,
      actor: ctx.actor,
    });
    if (blockers.length) return requested;
    return commandRun(state, slug, run.runId, {
      requestId: `${input.requestId}:completed`,
      expectedRevision: requested.revision,
      type: "phase_changed",
      phase: "completed",
      reason: "controller verified completion after all work settled",
      telemetry: scrumTelemetry(requested, ctx.factory.ledger.events),
    });
  }
  if (input.operation === "run.command") {
    const cmd = {
      ...p,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
    } as RunCommand;
    if (
      cmd.type === "operation_intended" ||
      cmd.type === "track_selected" ||
      cmd.type === "paths_registered" ||
      cmd.type === "design_decided" ||
      cmd.type === "contract_intended" ||
      cmd.type === "contract_retired" ||
      cmd.type === "contract_rejected" ||
      cmd.type === "cancellation_requested" ||
      cmd.type === "completion_requested" ||
      cmd.type === "completion_reported" ||
      cmd.type === "provider_selected" ||
      cmd.type === "task_bound" ||
      cmd.type === "task_reserved" ||
      (cmd.type === "phase_changed" &&
        ["completed", "cancelled"].includes(cmd.phase))
    )
      fail("scrum-command-authority", "use the dedicated verified operation");
    const replayed = replayRunCommand(state, slug, run.runId, cmd);
    if (
      replayed &&
      !(
        cmd.type === "design_review_requested" &&
        !run.config.requireUiApproval &&
        replayed.design?.digest === cmd.design.digest &&
        replayed.design.decision === undefined
      )
    )
      return replayed;
    if (cmd.type === "artifacts_recorded") {
      verifyRefs(root, cmd.refs, run.ownedPaths);
      acceptedRefs(ctx.factory, run, cmd.refs);
    }
    if (cmd.type === "role_result") {
      verifyRefs(root, cmd.result.artifactRefs, run.ownedPaths);
      acceptedRefs(ctx.factory, run, cmd.result.artifactRefs);
    }
    if (cmd.type === "readiness_recorded") {
      verifyRefs(root, cmd.readiness.refs, run.ownedPaths);
      acceptedRefs(ctx.factory, run, cmd.readiness.refs);
      if (
        run.tasks.some(
          (t) =>
            ["pm", "ux", "architect"].includes(t.role) &&
            (t.result?.status !== "complete" ||
              t.result.assumptions.some((a) => a.unsafe && !a.resolved) ||
              t.result.openQuestions.length > 0 ||
              t.result.conflicts.length > 0),
        )
      )
        fail(
          "scrum-readiness-required",
          "planning results incomplete or unsafe",
        );
      const required =
        trackKind(run.track) === "small"
          ? ["sprint-backlog.md"]
          : trackKind(run.track) === "backend"
            ? ["prd.md", "architecture.md", "sprint-backlog.md"]
            : [
                "prd.md",
                "architecture.md",
                "sprint-backlog.md",
                "DESIGN.md",
                "EXPERIENCE.md",
                "mockups/index.html",
              ];
      if (
        required.some(
          (file) =>
            !cmd.readiness.refs.some(
              (r) => r.path === `.scratch/${run.initiativeId}/${file}`,
            ),
        )
      )
        fail("scrum-readiness-required", "missing track artifacts");
    }
    if (cmd.type === "readiness_recorded") {
      const prefix = `.scratch/${run.initiativeId}/`;
      const files = Object.fromEntries(
        cmd.readiness.refs.map((ref) => [
          ref.path.slice(prefix.length),
          gitBytes(root, "show", `${ref.commit}:${ref.path}`).toString(),
        ]),
      );
      const kinds: import("./linter.ts").ScrumDocKind[] =
        trackKind(run.track) === "small"
          ? ["backlog"]
          : trackKind(run.track) === "backend"
            ? ["prd", "architecture", "backlog"]
            : ["prd", "ux", "architecture", "backlog"];
      const diagnostics = kinds.flatMap((kind) => lintScrumDoc(kind, files));
      if (diagnostics.length)
        fail(
          "scrum-readiness-lint",
          diagnostics.map((d) => `${d.path}:${d.line} ${d.message}`).join("; "),
        );
    }
    if (cmd.type === "design_review_requested") {
      verifyCompleteDesign(root, run, cmd.design);
      verifyRefs(root, cmd.design.refs, run.ownedPaths);
      verifyRefs(root, cmd.design.browserEvidence, run.ownedPaths);
      acceptedRefs(ctx.factory, run, [
        ...cmd.design.refs,
        ...cmd.design.browserEvidence,
      ]);
      verifyBrowserEvidence(root, cmd.design);
      if (designDigest(cmd.design.refs) !== cmd.design.digest)
        fail("invalid-design-digest", "digest differs from accepted artifacts");
    }
    if (cmd.type === "bundle_promoted") {
      verifyRefs(root, [cmd.ref], run.ownedPaths);
      acceptedRefs(ctx.factory, run, [cmd.ref]);
    }
    if (cmd.type === "qa_recorded") {
      verifyRefs(root, [cmd.ref], run.ownedPaths);
      acceptedRefs(ctx.factory, run, [cmd.ref]);
      const report = JSON.parse(
        gitBytes(root, "show", `${cmd.ref.commit}:${cmd.ref.path}`).toString(),
      );
      const issues = verifyQaFiles(root, report);
      if (issues.length) fail("invalid-qa-evidence", issues.join("; "));
      cmd.result = {
        status: report.status,
        productSha: report.productSha,
        confirmedDefects: report.findings.filter(
          (f: { confirmed: boolean; kind: string }) =>
            f.confirmed && f.kind === "product",
        ).length,
      };
    }
    let updated = commandRun(state, slug, run.runId, cmd);
    if (
      cmd.type === "design_review_requested" &&
      !run.config.requireUiApproval &&
      updated.design?.digest === cmd.design.digest &&
      updated.design.decision === undefined
    ) {
      updated = commandRun(state, slug, run.runId, {
        type: "design_decided",
        requestId: `${input.requestId}:policy-waiver`,
        expectedRevision: updated.revision,
        revision: cmd.design.revision,
        digest: cmd.design.digest,
        decision: "waived",
        actor: `policy:${run.policyRevision}`,
        rationale:
          "Frozen run policy requireUiApproval=false; browser verification and readiness still required",
      });
    }
    return updated;
  }
  fail("invalid-scrum-operation", input.operation);
}
